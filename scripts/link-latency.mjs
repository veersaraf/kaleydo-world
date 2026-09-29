// How long a message takes from a phone to the TV, and how well the two ends know it.
// A TV page and a simulated phone (the real remote page) join through a running server
// (the Mac's, or `npx wrangler dev`'s cloud worker); the phone page then
//   - sends 40 pings 100 ms apart and reports the round-trip distribution,
//   - reads the remote's own latency estimate (`lat`: its "NN ms" pill shows 2 x lat) 2 s after joining and at the end,
//   - reads the TV's serverOffset (its clock against the server's),
//   - sends 30 swings 100 ms apart, each stamped, and reads them where the TV's Input hands them on:
//     the one-way time from the phone's send to onSwing, and the age the TV worked out for a swing that
//     was sent with age 0, lat 0 (that is the TV's own idea of the transit: it should match).
// The two pages are in one browser, so performance.timeOrigin + performance.now() is one clock for both.
//
//   PORT=3300 HTTPS_PORT=3743 HMR_PORT=24700 node server/server.mjs --dev &
//   BASE=http://localhost:3300 node scripts/link-latency.mjs
//   BASE=http://127.0.0.1:8790 node scripts/link-latency.mjs          (npx wrangler dev --port 8790: the cloud)
//   SKEW=4000 ...   the TV page's clock runs 4 s fast (the cloud's clocks disagree): serverOffset should come out near -4000
//   TRANSPORTS=ws | http | ws,http   (http is the iPhone fallback: POST up, SSE down; the local server only)
import { chromium } from 'playwright-core';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3300';
const SKEW = Number(process.env.SKEW || 0);
const PINGS = 40;
const SWINGS = 30;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] : NaN;
};
const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
if (SKEW) await tvCtx.addInitScript(`{ const n = Date.now.bind(Date); Date.now = () => n() + ${SKEW}; }`);
const tv = await tvCtx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => window.kaleido?.link?.online, null, { timeout: 30000 });
const info = await tv.evaluate(() => ({ cloud: window.kaleido.link.cloud, url: window.kaleido.link.joinUrl }));
await tv.evaluate(() => {
  window.__sw = [];
  window.kaleido.input.onSwing = (e) => window.__sw.push({ power: e.power, at: performance.timeOrigin + performance.now(), age: e.age });
});
console.log(`${BASE}  ${info.cloud ? 'cloud room' : 'local server'}${SKEW ? `  (TV clock ${SKEW} ms fast)` : ''}\n`);

// (the remote's own socket / event stream, kept so the script can send on the same path)
const spy = () => {
  const WS = window.WebSocket;
  window.WebSocket = function (...a) {
    const ws = new WS(...a);
    if (String(a[0]).includes('role=pad')) {
      window.__ws = ws;
      ws.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'pong' && window.__pending?.[m.t]) window.__pending[m.t](performance.now());
        } catch {}
      });
    }
    return ws;
  };
  Object.assign(window.WebSocket, WS);
  window.WebSocket.prototype = WS.prototype;
  const ES = window.EventSource;
  window.EventSource = function (url, ...a) {
    window.__pid = new URL(url, location.href).searchParams.get('pid');
    return new ES(url, ...a);
  };
  window.EventSource.prototype = ES.prototype;
  window.__pending = {};
};

const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const rows = [];
const transports = (process.env.TRANSPORTS || (info.cloud ? 'ws' : 'ws,http')).split(',');
for (const transport of transports) {
  const ctx = await browser.newContext(mobile);
  await ctx.addInitScript(phone);
  await ctx.addInitScript(spy);
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => logs.push(`[pad ${transport}] ` + e.message));
  const before = await tv.evaluate(() => window.kaleido.input.activeSeats.filter((s) => !s.local).length);
  const target = info.cloud ? info.url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto' : BASE + '/controller.html?auto' + (transport === 'http' ? '&transport=http' : '');
  const t0 = Date.now();
  await pad.goto(target);
  await tv.waitForFunction((n) => window.kaleido.input.activeSeats.filter((s) => !s.local).length > n, before, { timeout: 30000 });
  const joinMs = Date.now() - t0;
  await pad.waitForFunction((t) => (t === 'ws' ? window.__ws?.readyState === 1 : !!window.__pid), transport, { timeout: 15000 });
  const pill = () => pad.evaluate(() => document.querySelector('.net b')?.textContent || '');
  const latOf = (s) => (parseInt(s) || NaN) / 2;
  await wait(2000);
  const lat2s = latOf(await pill());
  const off2s = await tv.evaluate(() => window.kaleido.link.serverOffset);

  // pings, then stamped swings, 100 ms apart, sent the way the remote sends them
  await tv.evaluate(() => (window.__sw.length = 0));
  const res = await pad.evaluate(
    async ({ transport, PINGS, SWINGS }) => {
      const rtts = [];
      const sent = [];
      const post = (msgs) =>
        fetch('/api/pad/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: window.__pid, msgs }), cache: 'no-store' });
      const ping = () => {
        const t = performance.now();
        window.__pending[t] = (now) => {
          delete window.__pending[t];
          rtts.push(now - t);
        };
        if (transport === 'ws') window.__ws.send(JSON.stringify({ type: 'ping', t }));
        else
          post([{ type: 'ping', t }])
            .then((r) => r.json())
            .then(() => window.__pending[t]?.(performance.now()));
      };
      const swing = (i) => {
        const power = (i + 1) / 1000;
        const msg = { type: 'swing', seq: i + 1, power, spin: 0, peak: 1, age: 0, lat: 0, touch: false, side: 1, attack: 0, path: null };
        sent.push({ power, at: performance.timeOrigin + performance.now() });
        if (transport === 'ws') window.__ws.send(JSON.stringify(msg));
        else post([msg]);
      };
      for (let i = 0; i < PINGS; i++) {
        ping();
        await new Promise((r) => setTimeout(r, 100));
      }
      for (let i = 0; i < SWINGS; i++) {
        swing(i);
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 400));
      return { rtts, sent };
    },
    { transport, PINGS, SWINGS },
  );
  const got = await tv.evaluate(() => window.__sw);
  const oneWay = [];
  const ages = [];
  for (const g of got) {
    const s = res.sent.find((x) => Math.abs(x.power - g.power) < 1e-9);
    if (s) {
      oneWay.push(g.at - s.at);
      ages.push(g.age * 1000);
    }
  }
  const latEnd = latOf(await pill());
  const offEnd = await tv.evaluate(() => window.kaleido.link.serverOffset);
  rows.push({ transport, joinMs, lat2s, latEnd, off2s, offEnd, rtt: res.rtts, oneWay, ages, got: got.length });
  await ctx.close();
  await wait(500);
}

for (const r of rows) {
  console.log(`--- ${r.transport}  (joined ${r.joinMs} ms after load)`);
  console.log(`  ping RTT ms         p50 ${f(pct(r.rtt, 50))}   p90 ${f(pct(r.rtt, 90))}   max ${f(Math.max(...r.rtt))}   (${r.rtt.length}/${PINGS} answered)`);
  console.log(`  pad lat estimate    ${f(r.lat2s)} ms at 2 s after joining, ${f(r.latEnd)} ms at the end   (RTT/2 median: ${f(pct(r.rtt, 50) / 2)})`);
  console.log(`  TV serverOffset     ${f(r.off2s)} ms at 2 s, ${f(r.offEnd)} ms at the end${SKEW ? `   (expected about ${-SKEW})` : '   (expected about 0)'}`);
  console.log(`  swing one-way ms    p50 ${f(pct(r.oneWay, 50))}   p90 ${f(pct(r.oneWay, 90))}   max ${f(Math.max(...r.oneWay))}   (${r.got}/${SWINGS} arrived)`);
  console.log(`  TV's age for them   p50 ${f(pct(r.ages, 50))}   p90 ${f(pct(r.ages, 90))}   max ${f(Math.max(...r.ages))}   ms (sent with age 0, lat 0: the TV's own transit; clamped at 160)`);
}
console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
await browser.close();
