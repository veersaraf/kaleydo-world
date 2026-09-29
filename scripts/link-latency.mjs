// How long a message takes from a phone to the TV, and how well the two ends know it.
// A TV page and a simulated phone (the real remote page) join through a running server
// (the Mac's, or `npx wrangler dev`'s cloud worker); the phone page then
//   - sends 40 pings 100 ms apart and reports the round-trip distribution,
//   - reads the remote's own latency estimate (`lat`: its "NN ms" pill shows 2 x lat) 2 s after joining and at the end,
//   - reads the TV's serverOffset (its clock against the server's),
//   - sends swings 100 ms apart, alternately the OLD way (no `ts`: the TV credits the phone's median `lat` for the uplink) and the
//     NEW one (through the remote's real PadLink, which stamps `ts` = the relay's clock at the send: the TV credits that message's own
//     uplink), and reads them where the TV's Input hands them on: the one-way time from the phone's send to onSwing, and the age the TV
//     worked out for a swing that was sent with age 0 (that is the TV's own idea of the transit: it should match). The error is
//     the age less the one-way time; the run FAILS if the stamped swings aren't within 10 ms for 95 % of them.
// The two pages are in one browser, so performance.timeOrigin + performance.now() is one clock for both.
//
//   PORT=3300 HTTPS_PORT=3743 HMR_PORT=24700 node server/server.mjs --dev &
//   BASE=http://localhost:3300 node scripts/link-latency.mjs
//   BASE=http://127.0.0.1:8790 node scripts/link-latency.mjs          (npx wrangler dev --port 8790: the cloud)
//   SKEW=4000 ...   the TV page's clock runs 4 s fast (the cloud's clocks disagree): serverOffset should come out near -4000
//   TRANSPORTS=ws | http | ws,http   (http is the iPhone fallback: POST up, SSE down; the local server only)
//   LAG=1 node scripts/link-latency.mjs      the internet: starts `npx wrangler dev --port 8802` if nothing answers there and puts the
//                                            phone behind scripts/lib/lag-proxy.mjs (30 ± 6 ms, 15 % of frames +100 ms), 40 + 40 swings.
//                                            LAG=delay,jitter,spike,spikeMs sets the proxy.
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { phone } from './lib/fake-phone.mjs';
import { start as startProxy } from './lib/lag-proxy.mjs';

const LAG = process.env.LAG ? (process.env.LAG === '1' ? [30, 6, 0.15, 100] : process.env.LAG.split(',').map(Number)) : null;
const WPORT = Number(process.env.WRANGLER_PORT || 8802);
const BASE = process.env.BASE || (LAG ? `http://127.0.0.1:${WPORT}` : 'http://localhost:3300');
const SKEW = Number(process.env.SKEW || 0);
const PINGS = 40;
const SWINGS = LAG ? 40 : 30; // (of each kind)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] : NaN;
};
const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');

// ---- LAG: wrangler dev (the cloud), and a lag proxy in front of it for the phone
let wr = null;
let proxy = null;
const alive = async () => {
  try {
    return (await fetch(BASE + '/api/info')).ok;
  } catch {
    return false;
  }
};
const cleanup = () => {
  if (wr) {
    try {
      process.kill(-wr.pid, 'SIGTERM');
    } catch {}
    wr = null;
  }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (cleanup(), process.exit(130)));
if (LAG) {
  if (!(await alive())) {
    if (process.env.BUILD || !existsSync('dist/index.html')) {
      console.log('npx vite build …');
      execSync('npx vite build', { stdio: 'ignore' });
    }
    console.log(`npx wrangler dev --port ${WPORT} …`);
    wr = spawn('npx', ['wrangler', 'dev', '--port', String(WPORT)], { detached: true, stdio: 'ignore' });
    const t0 = Date.now();
    while (!(await alive())) {
      if (Date.now() - t0 > 90000) {
        cleanup();
        throw new Error('wrangler dev did not come up');
      }
      await wait(500);
    }
  }
  proxy = await startProxy({ delay: LAG[0], jitter: LAG[1], spike: LAG[2], spikeMs: LAG[3], up: BASE, seed: Number(process.env.SEED || 7) });
  console.log(`the phone goes through a lag proxy: ${LAG[0]} ± ${LAG[1]} ms one way, ${LAG[2] * 100}% of frames +${LAG[3]} ms\n`);
}
const PHONE_BASE = proxy ? proxy.url : BASE;

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
let failed = false;
const transports = (process.env.TRANSPORTS || (info.cloud ? 'ws' : 'ws,http')).split(',');
for (const transport of transports) {
  const ctx = await browser.newContext(mobile);
  await ctx.addInitScript(phone);
  await ctx.addInitScript(spy);
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => logs.push(`[pad ${transport}] ` + e.message));
  const before = await tv.evaluate(() => window.kaleido.input.activeSeats.filter((s) => !s.local).length);
  const target = info.cloud ? info.url.replace(/^https?:\/\/[^/]+/, PHONE_BASE) + '&auto' : PHONE_BASE + '/controller.html?auto' + (transport === 'http' ? '&transport=http' : '');
  const t0 = Date.now();
  await pad.goto(target);
  await tv.waitForFunction((n) => window.kaleido.input.activeSeats.filter((s) => !s.local).length > n, before, { timeout: 30000 });
  const joinMs = Date.now() - t0;
  await pad.waitForFunction((t) => (t === 'ws' ? window.__ws?.readyState === 1 : !!window.__pid), transport, { timeout: 15000 });
  const pill = () => pad.evaluate(() => document.querySelector('.net b')?.textContent || '');
  const latOf = (s) => (parseInt(s) || NaN) / 2;
  await wait(2000);
  await pad.waitForFunction(() => window.__padLink?.clockOffset != null, null, { timeout: 15000 });
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
      // (even: the old way, raw, with no `ts`; odd: through the remote's real PadLink, which stamps it. Both carry the phone's own lat)
      const swing = (i) => {
        const stamped = i % 2 === 1;
        const power = (i + 1) / 1000;
        const msg = { type: 'swing', seq: i + 1, power, spin: 0, peak: 1, age: 0, lat: Math.round(window.__padLink.lat), touch: false, side: 1, attack: 0, path: null };
        sent.push({ power, stamped, at: performance.timeOrigin + performance.now() });
        if (stamped) window.__padLink.send(msg);
        else if (transport === 'ws') window.__ws.send(JSON.stringify(msg));
        else post([msg]);
      };
      for (let i = 0; i < PINGS; i++) {
        ping();
        await new Promise((r) => setTimeout(r, 100));
      }
      for (let i = 0; i < SWINGS * 2; i++) {
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
  const kinds = { old: { oneWay: [], ages: [], err: [] }, stamped: { oneWay: [], ages: [], err: [] } };
  for (const g of got) {
    const s = res.sent.find((x) => Math.abs(x.power - g.power) < 1e-9);
    if (s) {
      oneWay.push(g.at - s.at);
      ages.push(g.age * 1000);
      const k = kinds[s.stamped ? 'stamped' : 'old'];
      k.oneWay.push(g.at - s.at);
      k.ages.push(g.age * 1000);
      k.err.push(g.age * 1000 - (g.at - s.at));
    }
  }
  const latEnd = latOf(await pill());
  const offEnd = await tv.evaluate(() => window.kaleido.link.serverOffset);
  rows.push({ transport, joinMs, lat2s, latEnd, off2s, offEnd, rtt: res.rtts, oneWay, ages, kinds, got: got.length });
  await ctx.close();
  await wait(500);
}

for (const r of rows) {
  console.log(`--- ${r.transport}  (joined ${r.joinMs} ms after load)`);
  console.log(`  ping RTT ms         p50 ${f(pct(r.rtt, 50))}   p90 ${f(pct(r.rtt, 90))}   max ${f(Math.max(...r.rtt))}   (${r.rtt.length}/${PINGS} answered)`);
  console.log(`  pad lat estimate    ${f(r.lat2s)} ms at 2 s after joining, ${f(r.latEnd)} ms at the end   (RTT/2 median: ${f(pct(r.rtt, 50) / 2)})`);
  console.log(`  TV serverOffset     ${f(r.off2s)} ms at 2 s, ${f(r.offEnd)} ms at the end${SKEW ? `   (expected about ${-SKEW})` : '   (expected about 0)'}`);
  console.log(`  swing one-way ms    p50 ${f(pct(r.oneWay, 50))}   p90 ${f(pct(r.oneWay, 90))}   max ${f(Math.max(...r.oneWay))}   (${r.got}/${SWINGS * 2} arrived)`);
  console.log(`  TV's age for them   (sent with age 0: the TV's idea of phone send -> here, against the true one-way time; clamped at 250)`);
  console.log(`                      ${'swings'.padEnd(20)}${'n'.padStart(4)}${'err p50'.padStart(9)}${'err p90'.padStart(9)}${'|err| p95'.padStart(11)}${'|err| max'.padStart(11)}${'within 10 ms'.padStart(14)}`);
  for (const [name, k] of [['old (median lat)', r.kinds.old], ['stamped (ts)', r.kinds.stamped]]) {
    const abs = k.err.map(Math.abs);
    const good = abs.filter((e) => e <= 10).length;
    console.log(`                      ${name.padEnd(20)}${String(k.err.length).padStart(4)}${f(pct(k.err, 50)).padStart(9)}${f(pct(k.err, 90)).padStart(9)}${f(pct(abs, 95)).padStart(11)}${f(Math.max(...abs)).padStart(11)}${`${good}/${k.err.length}`.padStart(14)}`);
  }
  const st = r.kinds.stamped;
  const okN = st.err.filter((e) => Math.abs(e) <= 10).length;
  const pass = st.err.length >= SWINGS * 0.9 && okN >= Math.ceil(0.95 * st.err.length);
  if (!pass) failed = true;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  the stamped swings' age is within 10 ms of their true time for ${okN}/${st.err.length} (need 95 %)`);
}
console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
await browser.close();
await proxy?.close();
cleanup();
process.exit(failed ? 1 : 0);
