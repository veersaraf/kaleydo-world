// End-to-end: a simulated phone (synthetic devicemotion/deviceorientation) plays the Swing Lab.
import { launchChrome, outDir } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const out = outDir('swing');
const browser = await launchChrome(['--use-angle=metal', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const logs = [];
// (a phone that has played before: no first-time demo — the pad remembers it, see src/tv/tennis/demo.ts)
await ctx.addInitScript(() => { try { localStorage.setItem('kaleido.demo.tennis', '1'); } catch {} });
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
  // (sig / tp / tEnd: a twitch is the same turn made small and quick, peak 360°/s, σ 30 ms: it starts like a swing and dies under the swing threshold)
  window.__swing = (side, vUp = 0, aim = 0, peakDeg = 950, sigma = 0.0833, tpeak = 0.62, tEnd = 1.05) => new Promise((done) => {
    window.__busy = true;
    window.__peakWall = 0;
    window.__steps = 0;
    const yaw = side === 'fh' ? 1 : -1; // forehand turns counter-clockwise seen from above
    const base = side === 'fh' ? -90 : 90; // phone top points outwards at contact
    const W = peakDeg * D, sig = sigma, tp = tpeak, beta = 15;
    const up = upOf(beta, 0);
    const t0 = performance.now();
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      const w = W * Math.exp(-(((t - tp) / sig) ** 2));
      const psi = yaw * W * sig * (Math.sqrt(Math.PI) / 2) * erf((t - tp) / sig);
      window.__ori = { alpha: base - aim + psi / D, beta, gamma: 0 };
      const aUp = (vUp / 0.12) * Math.exp(-(((t - (tp - 0.06)) / 0.05) ** 2));
      if (t >= tp && !window.__peakWall) window.__peakWall = Date.now();
      window.__steps = (window.__steps || 0) + 1;
      emit(up.map((u) => u * yaw * w), up.map((u) => u * aUp));
      if (t < tEnd) setTimeout(step, 8);
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
  window.__log = [];
  // (the wall time each start / swing message was handled at, for the lead of the one over the other)
  window.__starts = [];
  window.__swings = [];
  const m = window.kaleido.match;
  const orig = m.humanSwing.bind(m);
  const phase = (p) => { const sw = p.swing; return sw ? +((m.t - sw.t0) / Math.max(1e-3, sw.tc - sw.t0)).toFixed(2) : 0; };
  m.humanSwing = (slot, inp, tEvent) => {
    const p = m.players.find((q) => q.human);
    const last = window.__starts[window.__starts.length - 1];
    window.__swings.push({ wall: performance.now(), lead: last ? performance.now() - last.wall : null, prov: !!p.swing?.provisional, phase: phase(p), side: inp.side });
    window.__log.push(`swing t=${m.t.toFixed(3)} tEvent=${tEvent.toFixed(3)} state=${m.state} live=${m.ball.live} plan=${p.plan ? p.plan.t.toFixed(3) : 'none'} swing=${p.swing ? (p.swing.provisional ? 'provisional' : 'real') : 'no'} phase=${phase(p)} nextOK=${p.nextSwingOK.toFixed(3)}`);
    return orig(slot, inp, tEvent);
  };
  const origStart = m.humanSwingStart.bind(m);
  m.humanSwingStart = (slot, side, tOnset) => {
    const p = m.players.find((q) => q.human);
    window.__starts.push({ wall: performance.now(), side, ageMs: Math.round((m.t - tOnset) * 1000) });
    window.__log.push(`start t=${m.t.toFixed(3)} tOnset=${tOnset.toFixed(3)} side=${side ?? '?'} state=${m.state} plan=${p.plan ? p.plan.t.toFixed(3) : 'none'}`);
    const r = origStart(slot, side, tOnset);
    window.__log.push(`      -> ${p.swing ? `${p.swing.provisional ? 'provisional' : 'swing'} ${p.swing.stroke} t0=${p.swing.t0.toFixed(3)} tc=${p.swing.tc.toFixed(3)}` : 'none'}`);
    return r;
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
// each swing message came after its swing-start: by how much (both are sent from the phone, so the arrival gap is the detector's
// lead over the peak plus its ~35 ms confirm)
const sw8 = await tv.evaluate(() => ({ starts: window.__starts, swings: window.__swings }));
const gaps = sw8.swings.map((x) => x.lead).filter((x) => x !== null);
let bad = 0;
results.push(`swing-start before swing: ${sw8.starts.length} starts for ${sw8.swings.length} swings; the swing arrives ${gaps.map((g) => g.toFixed(0)).join(', ')} ms after its start (median ${gaps.length ? [...gaps].sort((a, b) => a - b)[gaps.length >> 1].toFixed(0) : '—'} ms)`);
if (sw8.starts.length < sw8.swings.length || gaps.some((g) => g < 20 || g > 400)) { results.push('   ✗ FAIL: every swing should have been preceded by its start, 20-400 ms before'); bad++; }
results.push(`stroke phase when each swing arrived (0 = no stroke yet, 1 = at contact): ${sw8.swings.map((x) => (x.prov ? x.phase : 0)).join(', ')} (${sw8.swings.filter((x) => x.prov).length} of ${sw8.swings.length} had a provisional stroke going)`);

// a fidget: a twitch that starts like a swing and dies under the threshold. The character makes the stroke, then it is a feint (eases
// back to the ready stance), and the next real swing is unhurt
{
  let info = null;
  for (let k = 0; k < 400; k++) {
    info = await plan();
    if (info.dt !== undefined && info.dt < 0.5 && info.dt > 0.36) break;
    await tv.waitForTimeout(15);
  }
  const before = await tv.evaluate(() => window.__starts.length);
  const beforeSw = await tv.evaluate(() => window.__swings.length);
  // (the twitch peaks 130 ms from now, the ball is ~0.4 s off: the onset is ~90 ms before its peak)
  await pad.evaluate(() => window.__swing('fh', 0, 0, 360, 0.03, 0.13, 0.35));
  const seq = [];
  for (let k = 0; k < 60; k++) {
    seq.push(await tv.evaluate(() => { const p = window.kaleido.match.players.find((q) => q.human); const sw = p.swing; return sw ? (sw.feint ? 'F' : sw.provisional ? 'P' : 'R') : '.'; }));
    await tv.waitForTimeout(25);
  }
  const after = await tv.evaluate(() => ({ n: window.__starts.length, sw: window.__swings.length }));
  const line = seq.join('');
  results.push(`fidget: ${after.n - before} start(s), ${after.sw - beforeSw} swing(s); the human's stroke over time (25 ms steps; . none, P provisional, F feint, R real): ${line}`);
  if (after.n - before < 1) results.push('   (the twitch fired no onset: nothing to feint)');
  else if (after.sw - beforeSw > 0 || !/P+F+\.*$/.test(line.replace(/\.+$/, '') + '.')) { results.push('   ✗ FAIL: a fidget should show a stroke, then a feint, then nothing, and no swing'); bad++; }
  else results.push('   ✓ stroke, feint, back to the ready stance');
}
// …and the next real swing still works
{
  let info = null;
  for (let k = 0; k < 1200; k++) {
    info = await plan();
    if (info.dt !== undefined && info.dt < 0.72 && info.dt > 0.5) break;
    await tv.waitForTimeout(15);
  }
  if (info && info.dt !== undefined) {
    await pad.waitForTimeout(Math.max(0, (info.dt - 0.62) * 1000));
    await pad.evaluate(() => window.__swing('fh', 0, 0));
    await tv.waitForTimeout(250);
    const lab = await tv.evaluate(() => [...document.querySelectorAll('.lab-row')].map((r) => r.textContent).join(' | '));
    results.push(`after the fidget, a real swing: ${lab}`);
    if (!/Perfect|Good|Early|Late|Ball/i.test(lab)) { results.push('   ✗ FAIL: the swing after a fidget did nothing'); bad++; }
  } else results.push('   (no ball for the swing after the fidget)');
}
await pad.screenshot({ path: out + '/pad-play.png' });
results.push(bad ? `\nSOME CHECKS FAILED (${bad})` : '\nswing-start checks passed');
console.log(results.join('\n'));
console.log((await tv.evaluate(() => window.__log)).join('\n'));
console.log(logs.join('\n'));
await browser.close();
if (bad) process.exitCode = 1;
