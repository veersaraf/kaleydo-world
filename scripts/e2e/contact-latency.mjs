// How a phone's swing shows as contact on the TV. A simulated phone (as in e2e-swing.mjs) plays the
// Swing Lab; on the TV we stamp, per swing that connects:
//   (a) the wall time the swing reached the match (humanSwing) to the `hit` event, and to the end of the first frame with it,
//   (b) how far the DRAWN ball is from the racket's contact when the swing arrives (from the plan's ball point,
//       and from the swing's own contact point) — the ball that has already gone by, or the ball waiting at the racket,
//   (c) the biggest per-frame jump of the drawn ball around the hit beyond what its true flight explains, and
//       the part of it sideways to its flight (what the player saw as "the ball is past me, then it glitches").
// AGES (ms, default 40,80,120) are the swing's age when it arrives: the message is held in the TV's link until it is
// that old (a message already older arrives as it is, and the row says so). The phone's swing-START (the swing's onset, sent ~100 ms
// before the peak) is held the same way, so it arrives AGE ms after the onset, ~100 ms ahead of its swing:
//   (d) the stroke's phase when the swing arrives: the fraction of the wind-up done (0: no stroke going yet, 1: at contact,
//       above 1: past it), and how far the racket is from its contact point then. Before the onset existed it was always 0.
//   BASE=http://localhost:3370 AGES=40,80,120 node scripts/e2e/contact-latency.mjs [swings per age=10]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const N = +(process.argv[2] || 10);
const AGES = (process.env.AGES || '40,80,120').split(',').map(Number);
// (the first swings at each age only teach the match how old the phone's swings are: the drawn ball's hold follows the median age. They are played, not counted; WARM=0 counts them)
const WARM = +(process.env.WARM ?? 8);
const browser = await launchChrome(['--use-angle=metal', '--autoplay-policy=no-user-gesture-required']);
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
  const L = (window.__lat = { rows: [], cur: null, inFrame: false, frames: [], target: 0, hitNext: false });
  const tmp = { x: 0, y: 0, z: 0 };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  // ---- the link: hold a swing message until it is TARGET ms old (its rt stays: the wait shows up as relay transit)
  const pm = k.input.padMsg.bind(k.input);
  k.input.padMsg = (pid, rt, msg) => {
    if ((msg.type === 'swing' || msg.type === 'swing-start') && L.target > 0) {
      const nat = k.input.ageOf(rt, msg.lat, msg.age, 0.25, msg.ts) * 1000;
      const wait = Math.max(0, L.target - nat);
      setTimeout(() => pm(pid, rt, msg), wait);
      return;
    }
    pm(pid, rt, msg);
  };
  const orig = m.humanSwing.bind(m);
  m.humanSwing = (slot, inp, tEvent) => {
    const a = performance.now();
    const p = m.players.find((q) => q.human);
    const plan = p.plan;
    // where the ball is DRAWN as the swing arrives, against where the racket meets it
    const D = m.ballView(m.t, tmp);
    const drawn = { x: D.x, y: D.y, z: D.z };
    const sw0 = p.swing;
    const phase = sw0 ? (m.t - sw0.t0) / Math.max(1e-3, sw0.tc - sw0.t0) : 0;
    const row = { warm: L.warm, arrive: a, phase, prov: !!(sw0 && sw0.provisional), hit: null, shown: null, age: (m.t - tEvent) * 1000, target: L.target, dPlan: plan ? dist(drawn, { x: plan.bx, y: plan.by, z: plan.bz }) : NaN, dContact: NaN, hitInFrame: false };
    L.cur = row;
    const r = orig(slot, inp, tEvent);
    const sw = p.swing;
    if (sw && sw.hit) row.dContact = dist(drawn, { x: sw.cx, y: sw.cy, z: sw.cz });
    if (!row.hit && !(sw && sw.hit)) L.cur = null; // a whiff: nothing to time

    return r;
  };
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    if (e.type === 'hit' && e.p.human && L.cur && !L.cur.hit) {
      L.cur.hit = performance.now();
      L.cur.hitInFrame = L.inFrame;
      L.cur.kind = e.kind;
      L.cur.kph = e.kph;
      L.hitNext = true;
    }
    return oe(e);
  };
  const of = k.frame.bind(k);
  k.frame = (now) => {
    L.inFrame = true;
    of(now);
    L.inFrame = false;
    const c = L.cur;
    if (c && c.hit && !c.shown) { c.shown = performance.now(); L.rows.push(c); L.cur = null; }
    // the drawn ball and its true velocity, per frame
    const mm = k.match;
    if (mm && !k.attract && !mm.ball.holder) {
      const b = mm.ballView(mm.t, tmp);
      const t = mm.t, e = 0.002;
      const p0 = mm.ballAt(t - e, { x: 0, y: 0, z: 0 }), p1 = mm.ballAt(t + e, { x: 0, y: 0, z: 0 });
      L.frames.push({ t, x: b.x, y: b.y, z: b.z, vx: (p1.x - p0.x) / (2 * e), vy: (p1.y - p0.y) / (2 * e), vz: (p1.z - p0.z) / (2 * e), hit: L.hitNext ? L.rows.length - 1 : -1 });
      L.hitNext = false;
    }
  };
});
const plan = async () => tv.evaluate(() => { const m = window.kaleido.match; const p = m?.players.find((q) => q.human); return p && p.plan ? { dt: p.plan.t - m.t, stroke: p.plan.stroke, state: m.state, contactWall: Date.now() + (p.plan.t - m.t) * 1000 } : { state: m?.state }; });
for (const target of AGES) {
  await tv.evaluate((t) => { window.__lat.target = t; window.__lat.warm = true; }, target);
  for (let n = 0; n < N + WARM; n++) {
    if (n === WARM) await tv.evaluate(() => { window.__lat.warm = false; });
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
    await tv.waitForTimeout(700);
  }
}
const data = await tv.evaluate(() => ({ rows: window.__lat.rows, frames: window.__lat.frames }));
const rows = data.rows;
if (process.env.DUMP) {
  const i = data.frames.findIndex((f) => f.hit >= 0);
  console.log(JSON.stringify(data.frames.slice(Math.max(0, i - 3), i + 6).map((f) => [f.t.toFixed(3), f.x.toFixed(2), f.y.toFixed(2), f.z.toFixed(2), f.vz.toFixed(1), f.hit])));
}
// per hit: the frames around it (2 before … 7 after), the drawn ball's step against the step its true flight makes
for (const r of rows) r.jump = NaN, r.back = NaN, r.maxSpeed = NaN;
let hi = 0;
data.frames.forEach((fr, i) => {
  const r = rows[fr.hit];
  if (fr.hit < 0 || !r) return;
  let jump = 0, back = 0, maxSpeed = 0;
  for (let j = Math.max(1, i - 2); j <= Math.min(data.frames.length - 1, i + 7); j++) {
    const a = data.frames[j - 1], b = data.frames[j];
    const dt = b.t - a.t;
    if (dt < 0) continue;
    const s = [b.x - a.x, b.y - a.y, b.z - a.z];
    // (the true velocity at this frame's time: after the hit it is the outgoing flight's, before it the incoming one's)
    const e = [b.vx * dt, b.vy * dt, b.vz * dt];
    const res = [s[0] - e[0], s[1] - e[1], s[2] - e[2]];
    jump = Math.max(jump, Math.hypot(...res));
    // (the part of it that is not along the ball's own line: a sideways jump)
    const vl = Math.hypot(b.vx, b.vy, b.vz) || 1;
    const along = (res[0] * b.vx + res[1] * b.vy + res[2] * b.vz) / vl;
    back = Math.max(back, Math.sqrt(Math.max(0, res[0] ** 2 + res[1] ** 2 + res[2] ** 2 - along * along)));
    if (dt > 1e-4) maxSpeed = Math.max(maxSpeed, Math.hypot(...s) / dt);
  }
  r.jump = jump; r.back = back; r.maxSpeed = maxSpeed;
});
const q = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
const f = (a, d = 1, u = '') => `p50 ${q(a, 0.5).toFixed(d)}  max ${q(a, 1).toFixed(d)}${u}`;
console.log(`${rows.length} connecting swings`);
for (const target of AGES) {
  const R = rows.filter((r) => r.target === target && !r.warm);
  if (!R.length) { console.log(`age ${target}: no connecting swings`); continue; }
  console.log(`--- swing age ${target} ms (measured at arrival: ${f(R.map((r) => r.age), 0, ' ms')}), ${R.length} swings`);
  console.log('  (d) stroke phase when the swing arrives:', f(R.map((r) => r.phase), 2), `(${R.filter((r) => r.prov).length} of ${R.length} had the onset's stroke going; 1 = at contact)`);
  console.log('  (a) arrival -> hit event (ms):          ', f(R.map((r) => r.hit - r.arrive)));
  console.log('      arrival -> visible frame (ms):      ', f(R.map((r) => r.shown - r.arrive)));
  console.log('  (b) drawn ball to plan point at arrival:', f(R.map((r) => r.dPlan), 2, ' m'));
  console.log('      drawn ball to swing contact point:  ', f(R.map((r) => r.dContact), 2, ' m'));
  console.log('  (c) biggest jump around the hit:        ', f(R.map((r) => r.jump), 2, ' m/frame beyond its flight'));
  console.log('      of which sideways to its flight:    ', f(R.map((r) => r.back), 2, ' m'));
  console.log('      fastest drawn step / hit speed:     ', f(R.map((r) => r.maxSpeed), 1, ' m/s'), `(hits at ${f(R.map((r) => r.kph / 3.6), 1, ' m/s')})`);
}
console.log(logs.join('\n') || 'no page errors');
await browser.close();
