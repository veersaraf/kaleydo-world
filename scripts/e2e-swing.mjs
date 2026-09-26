// End-to-end: a simulated phone (synthetic devicemotion/deviceorientation) plays the Swing Lab.
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2];
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
const results = [];
await tv.evaluate(() => {
  window.__log = [];
  const m = window.kaleido.match;
  const orig = m.humanSwing.bind(m);
  m.humanSwing = (slot, inp, tEvent) => {
    const p = m.players.find((q) => q.human);
    window.__log.push(`swing t=${m.t.toFixed(3)} tEvent=${tEvent.toFixed(3)} state=${m.state} live=${m.ball.live} plan=${p.plan ? p.plan.t.toFixed(3) : 'none'} swing=${!!p.swing} nextOK=${p.nextSwingOK.toFixed(3)}`);
    return orig(slot, inp, tEvent);
  };
});
const plan = async () => tv.evaluate(() => { const m = window.kaleido.match; const p = m?.players.find((q) => q.human); return p && p.plan ? { dt: p.plan.t - m.t, stroke: p.plan.stroke, state: m.state, contactWall: Date.now() + (p.plan.t - m.t) * 1000 } : { state: m?.state }; });
for (let n = 0; n < 8; n++) {
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
  const aim = [0, 15, -15, 0, 25, -25, 0, 0][n];
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
  if (n === 4) await tv.screenshot({ path: out + '/lab.png' });
}
await pad.screenshot({ path: out + '/pad-play.png' });
console.log(results.join('\n'));
console.log((await tv.evaluate(() => window.__log)).join('\n'));
console.log(logs.join('\n'));
await browser.close();
