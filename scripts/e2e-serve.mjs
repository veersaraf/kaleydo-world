// Simulated phone: lift to toss, then swing at the top of the toss (rocket serve).
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const logs = [];
const tv = await ctx.newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
const pad = await ctx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.goto(BASE + '/controller.html?auto');
await pad.evaluate(() => {
  const D = Math.PI / 180;
  window.__ori = { alpha: 0, beta: 35, gamma: 0 };
  window.__extraUp = 0;
  const upOf = (b, g) => [-Math.cos(b * D) * Math.sin(g * D), Math.sin(b * D), Math.cos(b * D) * Math.cos(g * D)];
  window.__emit = (rot, acc) => {
    const o = window.__ori;
    const up = upOf(o.beta, o.gamma);
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: o.alpha, beta: o.beta, gamma: o.gamma }));
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { interval: 16, rotationRate: { alpha: rot[2] / D, beta: rot[0] / D, gamma: rot[1] / D }, acceleration: { x: acc[0], y: acc[1], z: acc[2] }, accelerationIncludingGravity: { x: acc[0] + up[0] * 9.81, y: acc[1] + up[1] * 9.81, z: acc[2] + up[2] * 9.81 } }));
  };
  setInterval(() => { if (!window.__busy) { const up = upOf(window.__ori.beta, 0); window.__emit([0, 0, 0], up.map((u) => u * window.__extraUp)); } }, 16);
  // a lift: 12 m/s² upwards for ~110 ms, no rotation
  window.__lift = async () => { window.__extraUp = 12; await new Promise((r) => setTimeout(r, 110)); window.__extraUp = -6; await new Promise((r) => setTimeout(r, 120)); window.__extraUp = 0; };
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  window.__swing = (peakDeg = 950) => new Promise((done) => {
    window.__busy = true;
    const W = peakDeg * D, sig = 0.0833, tp = 0.62, beta = 15;
    const up = upOf(beta, 0);
    const t0 = performance.now();
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      const w = W * Math.exp(-(((t - tp) / sig) ** 2));
      const psi = W * sig * (Math.sqrt(Math.PI) / 2) * erf((t - tp) / sig);
      window.__ori = { alpha: -90 + psi / D, beta, gamma: 0 };
      window.__emit(up.map((u) => u * w), [0, 0, 0]);
      if (t < 1.05) setTimeout(step, 8); else { window.__ori = { alpha: 0, beta: 35, gamma: 0 }; window.__busy = false; done(); }
    };
    step();
  });
});
await pad.waitForTimeout(2000);
// a match where the phone's player serves first
await tv.evaluate(() => {
  const f = window.flow, k = window.kaleido;
  f.mode = 'quick';
  const cfg = f.buildConfig();
  cfg.firstServer = 0;
  f.beginMatch('plaza', false, cfg);
  k.match.startNow();
  window.__ev = [];
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => { if (e.type === 'toss' || e.type === 'hit' || e.type === 'whiff' || e.type === 'fault') window.__ev.push({ type: e.type, reason: e.reason, t: +k.match.t.toFixed(3), human: e.p?.human, rocket: e.rocket, kph: e.kph && Math.round(e.kph), tau: e.tau && +e.tau.toFixed(2) }); oe(e); };
});
await tv.waitForFunction(() => { const m = window.kaleido.match; return m.state === 'serve' && m.server.human && m.t - m.stateT0 > 0.6; }, null, { timeout: 20000 });
await pad.waitForTimeout(700); // the phone rests a moment
const padMode = await pad.evaluate(() => document.querySelector('.panel.serve.on, .panel.serve') && document.querySelector('.toss b')?.textContent);
await pad.evaluate(() => window.__lift());
await tv.waitForFunction(() => window.kaleido.match.state === 'toss', null, { timeout: 3000, polling: 'raf' });
const afterLift = await tv.evaluate(() => window.kaleido.match.state);
// the swing's peak lands 0.62 s after it starts: aim it at the top of the toss
const wait = await tv.evaluate(() => { const m = window.kaleido.match; return (m.server.tossT + 0.78 - 0.62 - m.t) * 1000; });
await pad.waitForTimeout(Math.max(0, wait - 25));
await pad.evaluate(() => { window.__swing(950); });
const shot = await tv.waitForFunction(() => window.__ev.some((e) => e.type === 'hit' && e.human), null, { timeout: 4000, polling: 'raf' }).catch(() => null);
if (shot && process.argv[2]) {
  await tv.waitForTimeout(170);
  await tv.screenshot({ path: process.argv[2] + '/rocket.png' });
}
await tv.waitForTimeout(1600);
console.log('pad serve button:', padMode, '| state after lift:', afterLift);
console.log(JSON.stringify(await tv.evaluate(() => window.__ev)));
console.log(logs.join('\n') || 'no errors');
await browser.close();
