// How long a phone's swing takes to show as contact on the TV. A simulated phone (as in e2e-swing.mjs)
// plays the Swing Lab; on the TV we stamp, per swing that connects, the wall time the swing reached
// the match (humanSwing), the wall time the `hit` event fired, and the wall time of the end of the
// first frame that includes it (when the ball/racket can first be seen to have made contact).
//   BASE=http://localhost:3370 node scripts/contact-latency.mjs [swings=16]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const N = +(process.argv[2] || 16);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const logs = [];
const tv = await ctx.newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForTimeout(1500);
const pad = await ctx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.setViewportSize({ width: 390, height: 844 });
await pad.goto(BASE + '/controller.html?auto');
// phone generator lives in the pad page. Physically consistent: the orientation
// events follow the integrated gyro, and the profile runs on real elapsed time.
await pad.evaluate(() => {
  const D = Math.PI / 180;
  window.__ori = { alpha: 0, beta: 35, gamma: 0 };
  const upOf = (b, g) => [-Math.cos(b * D) * Math.sin(g * D), Math.sin(b * D), Math.cos(b * D) * Math.cos(g * D)];
  const emit = (rot, acc) => {
    const o = window.__ori;
    const up = upOf(o.beta, o.gamma);
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: o.alpha, beta: o.beta, gamma: o.gamma }));
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      interval: 16,
      rotationRate: { alpha: rot[2] / D, beta: rot[0] / D, gamma: rot[1] / D },
      acceleration: { x: acc[0], y: acc[1], z: acc[2] },
      accelerationIncludingGravity: { x: acc[0] + up[0] * 9.81, y: acc[1] + up[1] * 9.81, z: acc[2] + up[2] * 9.81 },
    }));
  };
  setInterval(() => { if (!window.__busy) emit([0, 0, 0], [0, 0, 0]); }, 16);
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  // side 'fh'|'bh' (right-handed), vUp m/s (+ brushing up), aim degrees (+ right), peak at +620 ms
  window.__swing = (side, vUp = 0, aim = 0, peakDeg = 950) => new Promise((done) => {
    window.__busy = true;
    window.__peakWall = 0;
    window.__steps = 0;
    const yaw = side === 'fh' ? 1 : -1; // forehand turns counter-clockwise seen from above
    const base = side === 'fh' ? -90 : 90; // phone top points outwards at contact
    const W = peakDeg * D, sig = 0.0833, tp = 0.62, beta = 15;
    const up = upOf(beta, 0);
    const t0 = performance.now();
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      const w = W * Math.exp(-(((t - tp) / sig) ** 2));
      const psi = yaw * W * sig * (Math.sqrt(Math.PI) / 2) * erf((t - tp) / sig);
      window.__ori = { alpha: base - aim + psi / D, beta, gamma: 0 };
      const aUp = (vUp / 0.12) * Math.exp(-(((t - 0.56) / 0.05) ** 2));
      if (t >= tp && !window.__peakWall) window.__peakWall = Date.now();
      window.__steps = (window.__steps || 0) + 1;
      emit(up.map((u) => u * yaw * w), up.map((u) => u * aUp));
      if (t < 1.05) setTimeout(step, 8);
      else { window.__ori = { alpha: 0, beta: 35, gamma: 0 }; window.__busy = false; done(); }
    };
    step();
  });
});
await pad.waitForTimeout(2500);
// open the Swing Lab from the TV menu (click → menu, then choose the item)
await tv.mouse.click(700, 450);
await tv.waitForTimeout(700);
await tv.evaluate(() => [...document.querySelectorAll('.item')].find((e) => e.textContent.includes('Swing Lab'))?.click());
await tv.waitForTimeout(2500);
// (the menu now opens on the sport picker: if the lab isn't up, open it directly)
await tv.evaluate(() => {
  const m = window.kaleido.match;
  if (!m || !m.cfg.practice || window.kaleido.attract) window.flow.beginSwingLab();
});
await tv.waitForTimeout(2500);
const results = [];
await tv.evaluate(() => {
  const k = window.kaleido;
  const m = k.match;
  const L = (window.__lat = { rows: [], cur: null, inFrame: false });
  const orig = m.humanSwing.bind(m);
  m.humanSwing = (slot, inp, tEvent) => {
    const a = performance.now();
    const before = m.t;
    L.cur = { arrive: a, hit: null, shown: null, age: before - tEvent, hitInFrame: false };
    const r = orig(slot, inp, tEvent);
    if (!L.cur.hit && !m.players.find((q) => q.human)?.swing?.hit) L.cur = null; // a whiff: nothing to time
    return r;
  };
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    if (e.type === 'hit' && e.p.human && L.cur && !L.cur.hit) { L.cur.hit = performance.now(); L.cur.hitInFrame = L.inFrame; L.cur.kind = e.kind; }
    return oe(e);
  };
  const of = k.frame.bind(k);
  k.frame = (now) => {
    L.inFrame = true;
    of(now);
    L.inFrame = false;
    const c = L.cur;
    if (c && c.hit && !c.shown) { c.shown = performance.now(); L.rows.push(c); L.cur = null; }
  };
});
const plan = async () => tv.evaluate(() => { const m = window.kaleido.match; const p = m?.players.find((q) => q.human); return p && p.plan ? { dt: p.plan.t - m.t, stroke: p.plan.stroke, state: m.state, contactWall: Date.now() + (p.plan.t - m.t) * 1000 } : { state: m?.state }; });
for (let n = 0; n < N; n++) {
  // wait for a ball to come
  let info = null;
  for (let k = 0; k < 300; k++) {
    info = await plan();
    if (info.dt !== undefined && info.dt < 0.72 && info.dt > 0.5) break;
    await tv.waitForTimeout(15);
  }
  if (!info || info.dt === undefined) { results.push('no ball'); continue; }
  const want = n % 4 === 3 ? (info.stroke === 'fh' ? 'bh' : 'fh') : info.stroke; // every 4th swing: the "other" stroke
  const vUp = [0, 2.2, -2.2, 1][n % 4];
  const aim = [0, 15, -15, 0, 25, -25, 0, 0][n % 8];
  const lead = Math.max(0, (info.dt - 0.62) * 1000);
  await pad.waitForTimeout(lead);
  await pad.evaluate(([s, v, a]) => window.__swing(s, v, a), [want, vUp, aim]);
  const peak = await pad.evaluate(() => ({ w: window.__peakWall, n: window.__steps, vis: document.visibilityState }));
  const tvVis = await tv.evaluate(() => document.visibilityState);
  results.push(`   peak - contact = ${peak.w - info.contactWall} ms; steps ${peak.n}; pad ${peak.vis}, tv ${tvVis}`);
  await tv.waitForTimeout(250);
  const lab = await tv.evaluate(() => [...document.querySelectorAll('.lab-row')].map((r) => r.textContent).join(' | '));
  const padLine = await pad.evaluate(() => [...document.querySelectorAll('.gtext b, .gtext span, .shotline')].map((e) => e.textContent).join(' / '));
  results.push(`planned ${info.stroke}, swung ${want} vUp ${vUp} aim ${aim}: ${lab}\n      pad: ${padLine}`);
}
const rows = await tv.evaluate(() => window.__lat.rows);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
const f = (a) => `p50 ${q(a, 0.5).toFixed(1)}  p90 ${q(a, 0.9).toFixed(1)}  max ${Math.max(...a).toFixed(1)}`;
console.log(`${rows.length} connecting swings`);
console.log('arrival -> hit event (ms):    ', f(rows.map((r) => r.hit - r.arrive)));
console.log('arrival -> visible frame (ms):', f(rows.map((r) => r.shown - r.arrive)));
console.log('hit fired inside a frame:', rows.filter((r) => r.hitInFrame).length, 'of', rows.length, '| swing age at arrival (sim ms):', f(rows.map((r) => r.age * 1000)));
console.log(logs.join('\n') || 'no page errors');
await browser.close();
