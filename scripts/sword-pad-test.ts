// Synthetic sword play → SwordDetector: slash direction and power, thrusts,
// the refractory after a blow (recoil, the return to guard, combos), and all
// the things that must NOT attack — slow aiming, angling the guard, twisting
// the blade, anything while the guard is held — for several ways of holding
// the phone, screen directions, sample rates, gyro noise and both sign
// conventions of the accelerometer. The motion is a set of rotations about
// fixed axes (player frame), each with its own speed profile, integrated
// forward and back from the pose at the blow's peak; the phone swings about a
// pivot (the wrist) 0.2 m behind it, so the accelerometer feels the swing. It
// goes through the same orientation pipeline the remote uses: gyro
// integration + the OS's fused orientation arriving a little late.
//
//   npx tsx scripts/sword-pad-test.ts
import { SwordDetector, swingRead, swipeStrike, slashPower, guardLine, type SwordStrike } from '../src/pad/sword';
import type { SwipePoint } from '../src/pad/bowl';
import { Orientation, quatFromEuler } from '../src/pad/orient';

type Quat = [number, number, number, number]; // x y z w
type V3 = [number, number, number];

const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const qaxis = (a: V3, ang: number): Quat => {
  const n = Math.hypot(...a),
    s = Math.sin(ang / 2) / n;
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)];
};
const qrotV = (q: Quat, v: V3): V3 => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const scale = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** rotation whose columns are the images of the device x, y, z axes */
function qcols(x: V3, y: V3, z: V3): Quat {
  const [m00, m10, m20] = x,
    [m01, m11, m21] = y,
    [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return qnorm(q);
}
/** device→earth quaternion → W3C deviceorientation angles (degrees), gimbal-lock safe */
function euler(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  const r00 = 1 - 2 * (y * y + z * z),
    r01 = 2 * (x * y - z * w),
    r10 = 2 * (x * y + z * w),
    r11 = 1 - 2 * (x * x + z * z),
    r20 = 2 * (x * z - y * w),
    r21 = 2 * (y * z + x * w),
    r22 = 1 - 2 * (x * x + y * y);
  const c = Math.hypot(r20, r22);
  const D = 180 / Math.PI;
  if (c < 1e-6) return [Math.atan2(r10, r00) * D, Math.atan2(r21, 0) * D, 0];
  return [Math.atan2(-r01, r11) * D, Math.atan2(r21, c) * D, Math.atan2(-r20, r22) * D];
}
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
// seeded randomness, so a failure can be reproduced
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, gauss };
}
const R2D = 180 / Math.PI;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ the motion model

/** A rotation about a fixed axis of the player frame (x right, y towards the screen, z up). */
type Rot =
  /** a blow: the speed builds up and dies away (gaussian each side of the peak) */
  | { kind: 'blow'; axis: V3; tp: number; peak: number; rise: number; fall: number }
  /** a controlled turn: `angle` over `dur` from t0, speed a raised cosine (aiming, angling the guard) */
  | { kind: 'turn'; axis: V3; t0: number; dur: number; angle: number }
  /** a wobble: speed amp·sin(2πf(t − t0)) from t0 to t1 */
  | { kind: 'wave'; axis: V3; t0: number; t1: number; amp: number; f: number };

function speedOf(r: Rot, t: number): number {
  if (r.kind === 'blow') {
    const s = t < r.tp ? r.rise : r.fall;
    return r.peak * Math.exp(-((t - r.tp) ** 2) / (2 * s * s));
  }
  if (r.kind === 'turn') {
    const u = (t - r.t0) / r.dur;
    return u < 0 || u > 1 ? 0 : (r.angle / r.dur) * (1 - Math.cos(2 * Math.PI * u));
  }
  return t < r.t0 || t > r.t1 ? 0 : r.amp * Math.sin(2 * Math.PI * r.f * (t - r.t0));
}

interface Push {
  /** direction of the push (player frame) */
  dir: V3;
  t0: number;
  /** out over `dur`, held, back over `back` */
  dur: number;
  dist: number;
  hold: number;
  back: number;
}
function pushAt(p: Push, t: number): number {
  const u = t - p.t0;
  if (u <= 0) return 0;
  if (u < p.dur) return (p.dist * (1 - Math.cos((Math.PI * u) / p.dur))) / 2;
  if (u < p.dur + p.hold) return p.dist;
  const r = (u - p.dur - p.hold) / p.back;
  return r >= 1 ? 0 : (p.dist * (1 + Math.cos(Math.PI * r))) / 2;
}

interface Scene {
  rots: Rot[];
  pushes?: Push[];
  /** the phone's pose (device → player) at time tref */
  pose: Quat;
  tref: number;
  end: number;
  /** guard pad: times it goes down / up (s), alternating, starting with down */
  guard?: number[];
}
interface Setup {
  /** earth heading of the screen, rad */
  screen: number;
  /** calibration error of "towards the screen", rad */
  calErr: number;
  hz: number;
  /** gyro noise σ, rad/s */
  noise: number;
  seed: number;
  /** iOS: acceleration and gravity reported with the opposite sign */
  ios?: boolean;
  /** 'both' (default), only accelerationIncludingGravity, or no accelerometer at all */
  accel?: 'both' | 'ig' | 'none';
  /** the body's own movement, m/s² */
  sway?: number;
  sensitivity?: number;
}
interface Fired extends SwordStrike {
  /** when the detector said so (s) */
  at: number;
}

const STEP = 0.0005;
/** the pose path: integrated from the pose at tref, forward and back, at 0.5 ms */
function path(sc: Scene) {
  const omega = (t: number): V3 => {
    let w: V3 = [0, 0, 0];
    for (const r of sc.rots) w = add(w, scale(unit(r.axis), speedOf(r, t)));
    return w;
  };
  const n = Math.ceil(sc.end / STEP) + 2;
  const P: Quat[] = new Array(n);
  const iref = Math.round(sc.tref / STEP);
  P[iref] = sc.pose;
  const turn = (q: Quat, w: V3, h: number) => {
    const m = Math.hypot(...w);
    return m < 1e-12 ? q : qnorm(qmul(qaxis(w, m * h), q));
  };
  for (let i = iref; i < n - 1; i++) P[i + 1] = turn(P[i], omega((i + 0.5) * STEP), STEP);
  for (let i = iref; i > 0; i--) P[i - 1] = turn(P[i], omega((i - 0.5) * STEP), -STEP);
  const pose = (t: number): Quat => {
    const x = Math.max(0, Math.min(n - 1.001, t / STEP));
    const i = Math.floor(x),
      f = x - i;
    const a = P[i],
      b = P[i + 1];
    const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
    return qnorm([a[0] + (s * b[0] - a[0]) * f, a[1] + (s * b[1] - a[1]) * f, a[2] + (s * b[2] - a[2]) * f, a[3] + (s * b[3] - a[3]) * f]);
  };
  return { pose, omega };
}

/** the tip's travel (ω × blade) across the view at time t, as the physics has it */
function physDir(sc: Scene, t: number) {
  const { pose, omega } = path(sc);
  const s = qrotV(pose(t), [0, 1, 0]);
  const v = cross(omega(t), s);
  return Math.atan2(v[2], v[0]);
}
/**
 * The slash direction the detector should read at time t: the tip's travel, as a person's swing
 * reads (a real hand's cuts lean and dip: sword.ts DIR_ROLL / DIR_DIP, fitted on a real capture,
 * scripts/sword-capture-test.ts).
 */
function trueDir(sc: Scene, t: number) {
  return swingRead(physDir(sc, t));
}

function simulate(sc: Scene, su: Setup): Fired[] {
  const R = rng(su.seed);
  const { pose, omega } = path(sc);
  const toEarth = qaxis([0, 0, 1], -su.screen);
  // the phone swings about the wrist, 0.2 m behind it along the blade
  const pRef: V3 = [0.15, 0.45, 1.25];
  const pivot = add(pRef, scale(qrotV(sc.pose, [0, 1, 0]), -0.2));
  const where = (t: number): V3 => {
    const rel = qmul(pose(t), qconj(sc.pose));
    let p = add(pivot, qrotV(rel, add(pRef, scale(pivot, -1))));
    for (const pu of sc.pushes ?? []) p = add(p, scale(unit(pu.dir), pushAt(pu, t)));
    return p;
  };
  const accel = (t: number): V3 => {
    const h = 0.002;
    const a = where(t - h),
      b = where(t),
      c = where(t + h);
    const w: V3 = [(a[0] - 2 * b[0] + c[0]) / (h * h), (a[1] - 2 * b[1] + c[1]) / (h * h), (a[2] - 2 * b[2] + c[2]) / (h * h)];
    const sway = su.sway ?? 0;
    w[0] += sway * Math.sin(2 * Math.PI * 1.3 * t);
    w[1] += sway * 0.6 * Math.cos(2 * Math.PI * 0.9 * t);
    w[2] += sway * 0.4 * Math.sin(2 * Math.PI * 1.7 * t);
    return w;
  };

  const det = new SwordDetector();
  det.sensitivity = su.sensitivity ?? 1;
  det.upSign = su.ios ? -1 : 1;
  const ori = new Orientation();
  const osLag: Quat[] = [];
  const fired: Fired[] = [];
  let now = 0;
  det.onStrike = (s) => fired.push({ ...s, at: now });
  let prev: V3 = [0, 0, 0];
  let lastT = 0;
  const guard = [...(sc.guard ?? [])];
  let down = false;
  for (let n = 0; ; n++) {
    // devicemotion arrives at a steady rate with a little jitter
    const t = n / su.hz + (n ? (R.u() - 0.5) * 0.002 : 0);
    if (t > sc.end) break;
    now = t;
    while (guard.length && t >= guard[0]) {
      down = !down;
      det.guard(down, guard.shift()! * 1000);
    }
    const qp = pose(t);
    const q = qmul(toEarth, qp);
    // the OS's fused orientation, two samples late (as deviceorientation is)
    osLag.push(q);
    const os = osLag.length > 2 ? osLag.shift()! : osLag[0];
    const [al, be, ga] = euler(os);
    ori.measure(al, be, ga, t * 1000);
    if (ori.heading === null) ori.heading = su.screen + su.calErr;
    const w = qrotV(qconj(qp), omega(t)).map((v) => v + su.noise * R.gauss()) as V3;
    const dt = lastT ? t - lastT : 1 / su.hz;
    ori.integrate((w[0] + prev[0]) / 2, (w[1] + prev[1]) / 2, (w[2] + prev[2]) / 2, dt);
    prev = w;
    lastT = t;
    // the accelerometer (W3C: gravity reads "up"; iOS: everything flipped), clipping at 16 g
    const sg = su.ios ? -1 : 1;
    const lim = 16 * 9.81;
    const up = qrotV(qconj(qp), [0, 0, 1]);
    const aDev = qrotV(qconj(qp), accel(t));
    const raw = aDev.map((v, k) => Math.max(-lim, Math.min(lim, v + 9.81 * up[k] + 0.05 * R.gauss()))) as V3;
    const acc = raw.map((v, k) => sg * (v - 9.81 * up[k])) as V3;
    const ig = raw.map((v) => sg * v) as V3;
    const mode = su.accel ?? 'both';
    det.heading = ori.heading;
    det.push({
      t: t * 1000,
      rx: w[0],
      ry: w[1],
      rz: w[2],
      q: [ori.q[0], ori.q[1], ori.q[2], ori.q[3]],
      ...(mode === 'both' ? { ax: acc[0], ay: acc[1], az: acc[2] } : {}),
      ...(mode !== 'none' ? { igx: ig[0], igy: ig[1], igz: ig[2] } : {}),
    });
  }
  return fired;
}

// ------------------------------------------------------------------ how the phone is held

/** the blade (phone top) where the blow peaks, and which way the screen faces */
interface Grip {
  name: string;
  blade: V3;
  screen: V3;
}
const GRIPS: Grip[] = [
  { name: 'hilt in a fist, screen to the face', blade: [0, 0.82, 0.57], screen: [0, -1, 0] },
  { name: 'hilt held high, screen to the face', blade: [0.1, 0.5, 0.86], screen: [0, -1, 0] },
  { name: 'TV remote, screen up', blade: [0, 1, -0.05], screen: [0, 0, 1] },
  { name: 'remote on its side, screen left', blade: [0.2, 0.97, 0.12], screen: [-1, 0, 0] },
  { name: 'oblique', blade: [-0.3, 0.88, 0.35], screen: [0.6, -0.3, 0.75] },
];
function gripPose(g: Grip): Quat {
  const y = unit(g.blade);
  const z = unit(add(g.screen, scale(y, -dot(g.screen, y))));
  return qcols(cross(y, z), y, z);
}
/** the axis that sends the tip across the view at `dir` when the blade points along `blade` */
function axisFor(blade: V3, dir: number): V3 {
  const b = unit(blade);
  // the tip's travel: square to the blade, seen from the front at angle dir
  const c = Math.cos(dir),
    s = Math.sin(dir);
  const d = unit([c, -(c * b[0] + s * b[2]) / b[1], s]);
  return unit(cross(b, d));
}

// ------------------------------------------------------------------ checks

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail: string) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(62)} ${detail}`);
}
const deg = (r: number) => `${Math.round(r * R2D)}°`;
const fmt = (f: Fired[]) =>
  f.length ? f.map((s) => (s.kind === 'thrust' ? `thrust p${s.power.toFixed(2)} (${s.peak.toFixed(2)} m/s)` : `slash ${deg(s.dir)} p${s.power.toFixed(2)} (${s.peak.toFixed(1)} rad/s)`)).join(' | ') : 'nothing';
const DIRS = [0, 45, 90, 135, 180, -135, -90, -45].map((d) => (d * Math.PI) / 180);
const SCREENS = [0, 0.6, -2.1, 3.0];

/** one blow at t = 0.6 s: the blade at `grip` at its peak, the tip travelling at `dir` */
function blow(grip: Grip, dir: number, peak: number, rise = 0.06, fall = 0.05, extra: Rot[] = []): Scene {
  const axis = axisFor(grip.blade, dir);
  return { rots: [{ kind: 'blow', axis, tp: 0.6, peak, rise, fall }, ...extra], pose: gripPose(grip), tref: 0.6, end: 1.4 };
}

// 1. direction accuracy: 8 directions × grips × rates × sign conventions × noise × speeds
console.log('— slash direction: 8 directions × 5 grips × 60/100 Hz × W3C/iOS × gyro noise × 3 speeds');
const errs: number[] = [];
const lags: number[] = [];
let wrongCount = 0,
  n = 0;
for (const grip of GRIPS) {
  const ge: number[] = [];
  let bad = 0;
  for (const dir of DIRS)
    for (const hz of [60, 100])
      for (const ios of [false, true])
        for (const noise of [0.03, 0.1])
          for (const peak of [7, 11, 17]) {
            const R = rng(9000 + n);
            // blows vary: quick or long, a short or a long follow-through
            const rise = 0.045 + R.u() * 0.05,
              fall = 0.035 + R.u() * 0.04;
            const sc = blow(grip, dir, peak, rise, fall);
            const f = simulate(sc, { screen: SCREENS[n % 4], calErr: 0, hz, noise, seed: 100 + n, ios });
            n++;
            const truth = trueDir(sc, 0.6);
            const ok = f.length === 1 && f[0].kind === 'slash';
            if (!ok) {
              bad++;
              wrongCount++;
              console.log(`✗ ${grip.name}, ${deg(dir)} at ${peak} rad/s [${hz} Hz${ios ? ', iOS' : ''}, noise ${noise}]: ${fmt(f)}`);
              continue;
            }
            const e = Math.abs(wrap(f[0].dir - truth));
            errs.push(e);
            ge.push(e);
            lags.push((f[0].at - 0.6) * 1000);
          }
  ge.sort((a, b) => a - b);
  // (the direction is read at an imaginary sword's tip — the forearm reaching at the screen plus the
  // blade — so for a blade held high it differs a little from the phone top's own travel, the "truth" here)
  check(`${grip.name}: one slash each, direction`, bad === 0 && ge[Math.floor(0.95 * (ge.length - 1))] < (22.5 * Math.PI) / 180, `median ${deg(ge[Math.floor(ge.length / 2)])}, p95 ${deg(ge[Math.floor(0.95 * (ge.length - 1))])}, max ${deg(ge[ge.length - 1])}${bad ? `, ${bad} missed/doubled` : ''}`);
}
errs.sort((a, b) => a - b);
lags.sort((a, b) => a - b);
const med = errs[Math.floor(errs.length / 2)],
  p95 = errs[Math.floor(0.95 * (errs.length - 1))];
const within = errs.filter((e) => e < Math.PI / 8).length / errs.length;
console.log(`  direction error over ${errs.length} slashes: median ${(med * R2D).toFixed(1)}°, p95 ${(p95 * R2D).toFixed(1)}°, max ${(errs[errs.length - 1] * R2D).toFixed(1)}°; ${(within * 100).toFixed(1)}% within 22.5° (the right one of 8)`);
console.log(`  detection delay after the true peak: median ${lags[Math.floor(lags.length / 2)].toFixed(0)} ms, p95 ${lags[Math.floor(0.95 * (lags.length - 1))].toFixed(0)} ms, max ${lags[lags.length - 1].toFixed(0)} ms`);
check('every blow fires exactly one slash', wrongCount === 0, `${n} blows`);
// some Androids sample slower or much faster
for (const hz of [30, 200]) {
  const e: number[] = [];
  let bad = 0;
  for (const g of GRIPS)
    for (const dir of DIRS) {
      const sc = blow(g, dir, 12);
      const f = simulate(sc, { screen: 0.6, calErr: 0, hz, noise: 0.05, seed: 60 + e.length + bad });
      if (f.length !== 1 || f[0].kind !== 'slash') bad++;
      else e.push(Math.abs(wrap(f[0].dir - trueDir(sc, 0.6))));
    }
  e.sort((a, b) => a - b);
  check(`${hz} Hz: 40 blows, one slash each`, bad === 0 && e[Math.floor(0.95 * (e.length - 1))] < (20 * Math.PI) / 180, `median ${deg(e[Math.floor(e.length / 2)])}, p95 ${deg(e[Math.floor(0.95 * (e.length - 1))])}`);
}
check('direction: median < 6°, p95 < 18°', med < (6 * Math.PI) / 180 && p95 < (18 * Math.PI) / 180, `median ${(med * R2D).toFixed(1)}°, p95 ${(p95 * R2D).toFixed(1)}°`);

// 2. where the blow starts
console.log('\n— where the blow starts');
{
  const su: Setup = { screen: 0.6, calErr: 0, hz: 60, noise: 0.05, seed: 11 };
  // an overhead chop from behind the head: 200° from the blade pointing back over the shoulder
  const g = GRIPS[0];
  const chop = blow(g, -Math.PI / 2, 15, 0.11, 0.06);
  const f1 = simulate(chop, su);
  const b0 = qrotV(path(chop).pose(0.2), [0, 1, 0]);
  check(`overhead chop from behind the head (blade starts ${b0.map((v) => v.toFixed(2)).join(', ')})`, f1.length === 1 && Math.abs(wrap(f1[0].dir - swingRead(-Math.PI / 2))) < 0.2, fmt(f1));
  // a big horizontal slash from behind the right shoulder, sweeping right to left
  const hs = blow(GRIPS[2], Math.PI, 16, 0.11, 0.06);
  const f2 = simulate(hs, { ...su, seed: 12 });
  const h0 = qrotV(path(hs).pose(0.2), [0, 1, 0]);
  check(`horizontal slash from behind the shoulder (blade starts ${h0.map((v) => v.toFixed(2)).join(', ')})`, f2.length === 1 && Math.abs(wrap(f2[0].dir - swingRead(Math.PI))) < 0.2, fmt(f2));
  // a diagonal from over the right shoulder down to the left hip (kesa-giri)
  const kd = blow(GRIPS[0], (-3 * Math.PI) / 4, 14, 0.1, 0.06);
  const f3 = simulate(kd, { ...su, seed: 13 });
  const kt = trueDir(kd, 0.6);
  check('diagonal from over the shoulder (kesa-giri)', f3.length === 1 && Math.abs(wrap(f3[0].dir - kt)) < 0.25, `${fmt(f3)} (true ${deg(kt)})`);
  // a windup (raising the sword, not too fast) then the chop
  const wu = blow(g, -Math.PI / 2, 14, 0.07, 0.05);
  wu.rots.push({ kind: 'blow', axis: scale(wu.rots[0].axis, -1), tp: 0.25, peak: 4, rise: 0.12, fall: 0.1 });
  const f4 = simulate(wu, { ...su, seed: 14 });
  check('windup (sword raised at 4 rad/s) then a chop: one slash, down', f4.length === 1 && Math.abs(wrap(f4[0].dir - swingRead(-Math.PI / 2))) < 0.2, fmt(f4));
  // a curving stroke: starts across, ends down
  const cv = blow(GRIPS[2], -Math.PI / 4, 13, 0.07, 0.05);
  cv.rots.push({ kind: 'blow', axis: axisFor(GRIPS[2].blade, Math.PI * 0.05), tp: 0.55, peak: 5, rise: 0.05, fall: 0.03 });
  const f5 = simulate(cv, { ...su, seed: 15 });
  const ct = trueDir(cv, 0.6);
  check('a stroke that curves (across, then down)', f5.length === 1 && Math.abs(wrap(f5[0].dir - ct)) < 0.35, `${fmt(f5)} (at the peak ${deg(ct)})`);
  // heading off: the player turned a little since calibrating
  for (const err of [-0.35, 0.35]) {
    let worst = 0;
    let ok = true;
    for (const dir of DIRS) {
      const sc = blow(GRIPS[0], dir, 12);
      const f = simulate(sc, { ...su, calErr: err, seed: 20 + Math.round(dir * 10) });
      if (f.length !== 1) ok = false;
      else worst = Math.max(worst, Math.abs(wrap(f[0].dir - trueDir(sc, 0.6))));
    }
    check(`heading off by ${err > 0 ? '+' : ''}${Math.round(err * R2D)}°: 8 directions, worst error`, ok && worst < (22.5 * Math.PI) / 180, deg(worst));
  }
}

// 3. power
console.log('\n— power rises with speed');
{
  const got: number[] = [];
  for (const peak of [6, 6.5, 8, 10, 12, 14, 16, 18, 21]) {
    const f = simulate(blow(GRIPS[0], 0, peak), { screen: 0.4, calErr: 0, hz: 60, noise: 0.03, seed: 40 });
    got.push(f.length === 1 ? f[0].power : NaN);
  }
  const rising = got.every((p, i) => !Number.isNaN(p) && (i === 0 || p >= got[i - 1]) && (i === 0 || p > got[i - 1] || p === 1));
  check('6 → 21 rad/s: power rises', rising, got.map((p) => p.toFixed(2)).join(' '));
  check('a gentle flick (4.2 rad/s) ≈ 0.25', Math.abs(slashPower(4.2) - 0.25) < 0.02, slashPower(4.2).toFixed(2));
  check('a relaxed swing (6.5 rad/s) ≈ 0.4', Math.abs(got[1] - 0.4) < 0.06, got[1].toFixed(2));
  check('a full swing (18 rad/s) = 1', got[7] > 0.97, got[7].toFixed(2));
  check('"light swings" setting: the same flick hits harder', slashPower(8, 1.35) > slashPower(8, 1) + 0.1, `${slashPower(8, 1).toFixed(2)} → ${slashPower(8, 1.35).toFixed(2)}`);
  const light = simulate(blow(GRIPS[0], 0, 3.3), { screen: 0.4, calErr: 0, hz: 60, noise: 0.03, seed: 41, sensitivity: 1.35 });
  const normal = simulate(blow(GRIPS[0], 0, 3.3), { screen: 0.4, calErr: 0, hz: 60, noise: 0.03, seed: 41 });
  check('a light flick (3.3 rad/s) counts only with "light swings"', light.length === 1 && normal.length === 0, `${fmt(light)} / ${fmt(normal)}`);
  const big = simulate(blow(GRIPS[0], 0, 4.0), { screen: 0.4, calErr: 0, hz: 60, noise: 0.03, seed: 41, sensitivity: 0.75 });
  check('…and a 4 rad/s one counts, except with "big swings"', big.length === 0 && simulate(blow(GRIPS[0], 0, 4.0), { screen: 0.4, calErr: 0, hz: 60, noise: 0.03, seed: 41 }).length === 1, fmt(big));
}

// 4. the refractory: recoil, the return to guard, combos
console.log('\n— after a blow: recoil and return never fire, combos do');
{
  let doubles = 0,
    total = 0;
  const worst: string[] = [];
  for (const grip of GRIPS)
    for (const dir of DIRS) {
      const R = rng(700 + total);
      const peak = 8 + R.u() * 10;
      const base = blow(grip, dir, peak);
      const ax = base.rots[0].axis;
      // the wrist bounces back: 25–50% of the blow, 110–260 ms after its peak
      const rec = 0.25 + R.u() * 0.25;
      base.rots.push({ kind: 'blow', axis: scale(ax, -1), tp: 0.6 + 0.11 + R.u() * 0.15, peak: rec * peak, rise: 0.04, fall: 0.05 });
      // then the sword comes back to guard: 30–42% of the blow, 350–900 ms after
      const ret = 0.3 + R.u() * 0.12;
      base.rots.push({ kind: 'blow', axis: scale(ax, -1), tp: 0.6 + 0.35 + R.u() * 0.55, peak: ret * peak, rise: 0.1, fall: 0.12 });
      base.end = 2;
      const f = simulate(base, { screen: SCREENS[total % 4], calErr: 0, hz: total % 2 ? 100 : 60, noise: 0.06, seed: 800 + total, ios: total % 3 === 0 });
      total++;
      if (f.length !== 1) {
        doubles++;
        worst.push(`${grip.name} ${deg(dir)}: ${fmt(f)}`);
      }
    }
  check(`recoil (25–50%) + return (30–42%) after ${total} blows: one slash each`, doubles === 0, doubles ? worst.slice(0, 4).join(' ;; ') : '');
  // a hard stop: a big, quick recoil right after the peak
  const hard = blow(GRIPS[2], Math.PI, 16, 0.06, 0.03);
  hard.rots.push({ kind: 'blow', axis: scale(hard.rots[0].axis, -1), tp: 0.72, peak: 8, rise: 0.03, fall: 0.04 });
  const fh = simulate(hard, { screen: 0.2, calErr: 0, hz: 100, noise: 0.05, seed: 901 });
  check('hard stop: a 50% recoil 120 ms after the peak', fh.length === 1, fmt(fh));
  // combos: the sword comes straight back the other way, as hard
  let combos = 0,
    ctotal = 0;
  const cbad: string[] = [];
  for (const grip of GRIPS)
    // (not starting upwards: a stroke up with one straight back down is a windup and its chop — below)
    for (const dir of [0, -Math.PI / 2, Math.PI, -Math.PI / 4, (-3 * Math.PI) / 4]) {
      const R = rng(950 + ctotal);
      const peak = 10 + R.u() * 7;
      const sc = blow(grip, dir, peak);
      const back = 0.33 + R.u() * 0.17;
      sc.rots.push({ kind: 'blow', axis: scale(sc.rots[0].axis, -1), tp: 0.6 + back, peak: peak * (0.8 + R.u() * 0.3), rise: 0.06, fall: 0.05 });
      sc.end = 1.8;
      const f = simulate(sc, { screen: 0.6, calErr: 0, hz: ctotal % 2 ? 100 : 60, noise: 0.05, seed: 990 + ctotal });
      ctotal++;
      const t2 = trueDir(sc, 0.6 + back);
      // (the second starts wherever the first left the blade — often pointing well off to the side,
      // where the phone top's own travel and the imaginary sword's tip part ways the most)
      if (f.length === 2 && Math.abs(wrap(f[0].dir - trueDir(sc, 0.6))) < 0.4 && Math.abs(wrap(f[1].dir - t2)) < 0.65) combos++;
      else cbad.push(`${grip.name} ${deg(dir)} +${Math.round(back * 1000)} ms: ${fmt(f)} (true ${deg(trueDir(sc, 0.6))} ${deg(t2)})`);
    }
  check(`combos (back the other way 330–500 ms later, 80–110% as hard): ${ctotal}`, combos === ctotal, cbad.slice(0, 3).join(' ;; '));
  // a rising cut on its own is one; with a chop straight after it, it was the chop's windup
  {
    const rc = blow(GRIPS[0], Math.PI / 2, 12);
    const fr = simulate(rc, { screen: 0.6, calErr: 0, hz: 60, noise: 0.05, seed: 1050 });
    check('a rising cut on its own (12 rad/s): one slash, up', fr.length === 1 && Math.abs(wrap(fr[0].dir - Math.PI / 2)) < 0.4, fmt(fr));
    rc.rots.push({ kind: 'blow', axis: scale(rc.rots[0].axis, -1), tp: 0.6 + 0.9, peak: 12, rise: 0.06, fall: 0.05 });
    rc.end = 2.2;
    const fr2 = simulate(rc, { screen: 0.6, calErr: 0, hz: 60, noise: 0.05, seed: 1051 });
    check('a rising cut, then a chop 900 ms later: both', fr2.length === 2 && Math.sin(fr2[0].dir) > 0.7 && Math.sin(fr2[1].dir) < -0.7, fmt(fr2));
  }
  // three quick slashes in a row: right, left, down
  const three = blow(GRIPS[0], 0, 13);
  three.rots.push({ kind: 'blow', axis: scale(three.rots[0].axis, -1), tp: 1.0, peak: 13, rise: 0.06, fall: 0.05 });
  three.end = 2.2;
  // the third: a chop, the blade wherever the second left it
  const mid = path(three).pose(1.25);
  three.rots.push({ kind: 'blow', axis: axisFor(qrotV(mid, [0, 1, 0]), -Math.PI / 2), tp: 1.45, peak: 14, rise: 0.06, fall: 0.05 });
  const f3 = simulate(three, { screen: 0.6, calErr: 0, hz: 60, noise: 0.05, seed: 1100 });
  const t3 = [0.6, 1.0, 1.45].map((t) => trueDir(three, t));
  check('three in a row (right, left, down-ish), 400–450 ms apart', f3.length === 3 && f3.every((s, i) => Math.abs(wrap(s.dir - t3[i])) < 0.3), `${fmt(f3)} (true ${t3.map(deg).join(' ')})`);
}

// 5. things that aren't blows
console.log('\n— not blows: aiming, angling the guard, twisting, holding the guard');
{
  const su = (seed: number, hz = 60, ios = false): Setup => ({ screen: 0.9, calErr: 0, hz, noise: 0.05, seed, ios });
  // slow aiming: the blade wanders about for 4 s at up to ~3 rad/s
  let aimFires = 0;
  for (let k = 0; k < 20; k++) {
    const R = rng(2000 + k);
    const rots: Rot[] = [];
    let t = 0.2;
    while (t < 3.6) {
      const dur = 0.3 + R.u() * 0.6;
      const angle = 0.2 + R.u() * 0.75; // peak = 2·angle/dur ≤ ~3 rad/s (a quicker turn is a flick)
      const peakRate = (2 * angle) / dur;
      const a = peakRate > 3 ? (3 * dur) / 2 : angle;
      rots.push({ kind: 'turn', axis: [R.gauss(), R.gauss(), R.gauss()], t0: t, dur, angle: a });
      t += dur * (0.6 + R.u() * 0.6);
    }
    const f = simulate({ rots, pose: gripPose(GRIPS[k % 5]), tref: 0, end: 4 }, su(2100 + k, k % 2 ? 100 : 60, k % 3 === 0));
    aimFires += f.length;
    if (f.length) console.log(`  aiming #${k}: ${fmt(f)}`);
  }
  check('slow aiming, 20 × 4 s (≤ 3 rad/s): nothing', aimFires === 0, `${aimFires} fired`);
  // angling the guard (not holding it yet): vertical ↔ horizontal ↔ diagonal at a controlled pace
  let angleFires = 0,
    cases = 0;
  const up = gripPose({ name: '', blade: [0, 0.25, 0.97], screen: [0, -1, 0] });
  // (without holding GUARD, a brisk turn — 90° in 0.6 s peaks at 300°/s — is a swing: forgiving)
  for (const [angle, dur] of [
    [Math.PI / 2, 0.9],
    [Math.PI / 2, 1.1],
    [Math.PI / 4, 0.5],
    [Math.PI / 4, 0.7],
    [(3 * Math.PI) / 4, 1.3],
  ])
    for (const sign of [1, -1])
      for (const hz of [60, 100]) {
        // about the forward axis: the blade tips over sideways, like a wiper
        const f = simulate({ rots: [{ kind: 'turn', axis: [0, sign, 0], t0: 0.3, dur, angle }], pose: up, tref: 0, end: 1.8 }, su(2200 + cases, hz, cases % 2 === 1));
        cases++;
        angleFires += f.length;
        if (f.length) console.log(`  guard turn ${deg(angle)} in ${dur} s: ${fmt(f)}`);
      }
  check(`angling the guard, ${cases} turns (90° in ≥ 0.9 s, 45° in ≥ 0.5 s): nothing`, angleFires === 0, `${angleFires} fired`);
  // angling it while holding the guard: as fast as you like
  let heldFires = 0;
  cases = 0;
  for (const [angle, dur] of [
    [Math.PI / 2, 0.2],
    [Math.PI / 2, 0.3],
    [(3 * Math.PI) / 4, 0.25],
    [Math.PI / 4, 0.12],
  ])
    for (const sign of [1, -1]) {
      const rots: Rot[] = [
        { kind: 'turn', axis: [0, sign, 0], t0: 0.4, dur, angle },
        // and a flinch as the blow lands on the guard
        { kind: 'blow', axis: [1, 0, 0.3], tp: 0.9, peak: 7, rise: 0.03, fall: 0.04 },
      ];
      // the guard goes down 50 ms before the turn and is let go 150 ms after it all
      const f = simulate({ rots, pose: up, tref: 0, end: 1.6, guard: [0.35, 1.1] }, su(2300 + cases, cases % 2 ? 100 : 60));
      cases++;
      heldFires += f.length;
      if (f.length) console.log(`  guarded turn ${deg(angle)} in ${dur} s: ${fmt(f)}`);
    }
  check(`angling the guard while holding it, ${cases} fast turns (up to 16 rad/s) + a flinch: nothing`, heldFires === 0, `${heldFires} fired`);
  // twisting the blade about itself (turning the edge): the tip doesn't move
  let twist = 0;
  for (const [k, g] of GRIPS.entries()) {
    if (g.blade[1] < 0.85) continue;
    const f = simulate({ rots: [{ kind: 'blow', axis: g.blade, tp: 0.6, peak: 10, rise: 0.06, fall: 0.06 }], pose: gripPose(g), tref: 0.6, end: 1.3 }, su(2400 + k));
    twist += f.length;
  }
  check('twisting a phone pointed at the screen about its top at 10 rad/s: nothing', twist === 0, `${twist} fired`);
  // an upright phone turned about the vertical: the forearm sweeping it across — a sideways cut
  const sweep = simulate({ rots: [{ kind: 'blow', axis: [0, 0, 1], tp: 0.6, peak: 8, rise: 0.07, fall: 0.06 }], pose: up, tref: 0.6, end: 1.3 }, su(2450));
  check('an upright phone swept to the left (about the vertical): a cut to the left', sweep.length === 1 && Math.abs(wrap(sweep[0].dir - Math.PI)) < 0.3, fmt(sweep));
  // a jolt: the phone knocked (a big, very short spike)
  const jolt = simulate({ rots: [{ kind: 'blow', axis: [1, 0.2, 0], tp: 0.6, peak: 9, rise: 0.008, fall: 0.01 }], pose: gripPose(GRIPS[0]), tref: 0.6, end: 1.2 }, su(2500));
  check('a knock (9 rad/s for ~20 ms): nothing', jolt.length === 0, fmt(jolt));
  // a steady spin (twirling the sword)
  const spin = simulate({ rots: [{ kind: 'turn', axis: [0, 1, 0], t0: 0.2, dur: 2, angle: 12 }], pose: up, tref: 0, end: 2.4 }, su(2600));
  check('twirling (a 2 s spin, ~12 rad/s): nothing', spin.length === 0, fmt(spin));
}

// 6. the guard and attacks
console.log('\n— the guard: let go of it to attack');
{
  const su: Setup = { screen: 0.3, calErr: 0, hz: 60, noise: 0.05, seed: 3000 };
  const sc = blow(GRIPS[0], 0, 13);
  // let go of the guard 150 ms before the peak (as the swing begins)
  const a = simulate({ ...sc, guard: [0.1, 0.45] }, su);
  check('guard let go as the swing starts: the slash counts', a.length === 1 && a[0].kind === 'slash', fmt(a));
  // guard pressed during the swing (before the peak)
  const b = simulate({ ...sc, guard: [0.55] }, su);
  check('guard pressed mid-swing: no slash', b.length === 0, fmt(b));
  // a swing while guarding, the guard let go 200 ms after: no delayed slash
  const c = simulate({ ...sc, guard: [0.2, 0.8] }, su);
  check('a swing while guarding, let go after: nothing', c.length === 0, fmt(c));
  // let go right at the peak (the thumb lifting as the guard swings round): not an attack
  const d = simulate({ ...sc, guard: [0.2, 0.585] }, su);
  check('guard let go right at the peak: nothing', d.length === 0, fmt(d));
  // a thrust while guarding
  const push: Push = { dir: [0, 1, 0], t0: 0.5, dur: 0.24, dist: 0.35, hold: 0.15, back: 0.4 };
  const e = simulate({ rots: [], pushes: [push], pose: gripPose(GRIPS[2]), tref: 0, end: 1.6, guard: [0.3, 1.4] }, su);
  check('a thrust while guarding: nothing', e.length === 0, fmt(e));
}

// 7. thrusts
console.log('\n— thrusts');
{
  let good = 0,
    total = 0;
  const bad: string[] = [];
  const powers: { v: number; p: number }[] = [];
  const blades: { name: string; blade: V3; screen: V3; along: boolean }[] = [
    { name: 'remote, along the blade', blade: [0, 1, -0.05], screen: [0, 0, 1], along: true },
    { name: 'hilt tilted forward, along the blade', blade: [0.05, 0.8, 0.6], screen: [0, -1, 0], along: true },
    { name: 'hilt tilted forward, straight at the screen', blade: [0.05, 0.8, 0.6], screen: [0, -1, 0], along: false },
    { name: 'pointed a little off, along the blade', blade: [0.35, 0.93, 0.1], screen: [0, 0, 1], along: true },
  ];
  for (const bl of blades)
    for (const [dist, dur] of [
      [0.22, 0.2],
      [0.32, 0.25],
      [0.45, 0.3],
      [0.3, 0.35],
    ])
      for (const ios of [false, true])
        for (const accel of ['both', 'ig'] as const) {
          const R = rng(4000 + total);
          const g = { name: bl.name, blade: bl.blade, screen: bl.screen };
          const dirv = bl.along ? unit(bl.blade) : ([0, 1, 0] as V3);
          const sc: Scene = {
            rots: [{ kind: 'wave', axis: [R.gauss(), R.gauss(), R.gauss()], t0: 0.3, t1: 1.6, amp: 0.6 + R.u() * 0.9, f: 1.5 + R.u() * 2 }],
            pushes: [{ dir: dirv, t0: 0.5, dur, dist, hold: 0.12, back: 0.45 }],
            pose: gripPose(g),
            tref: 0,
            end: 1.8,
          };
          const f = simulate(sc, { screen: SCREENS[total % 4], calErr: 0, hz: total % 2 ? 100 : 60, noise: 0.05, seed: 4100 + total, ios, accel, sway: 0.3 });
          total++;
          const ok = f.length === 1 && f[0].kind === 'thrust' && f[0].at > 0.5 && f[0].at < 0.5 + dur + 0.08;
          if (process.env.DEBUG) console.log(`  ${bl.name} ${dist} m in ${dur} s (true ${((Math.PI * dist) / (2 * dur)).toFixed(2)} m/s)${ios ? ' iOS' : ''} ${accel}: ${fmt(f)}${f[0] ? ` at +${Math.round((f[0].at - 0.5) * 1000)} ms` : ''}`);
          if (ok) {
            good++;
            powers.push({ v: (Math.PI * dist) / (2 * dur), p: f[0].power });
          } else bad.push(`${bl.name} ${dist} m in ${dur} s${ios ? ' iOS' : ''} ${accel}: ${fmt(f)}`);
        }
  check(`${total} thrusts (4 ways, 0.22–0.45 m, 60/100 Hz, W3C/iOS, with/without "acceleration"): one thrust each, no slash`, good === total, bad.slice(0, 4).join(' ;; '));
  powers.sort((a, b) => a.v - b.v);
  const lo = powers.filter((p) => p.v < 1.5).map((p) => p.p),
    hi = powers.filter((p) => p.v > 2.2).map((p) => p.p);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  check('a harder thrust has more power', mean(hi) > mean(lo) + 0.25, `gentle (< 1.5 m/s) ${mean(lo).toFixed(2)}, hard (> 2.2 m/s) ${mean(hi).toFixed(2)}`);
  // not thrusts
  const su = (seed: number): Setup => ({ screen: 0.5, calErr: 0, hz: 60, noise: 0.05, seed, sway: 0.3 });
  const remote = gripPose(GRIPS[2]);
  const upright = gripPose({ name: '', blade: [0, 0.2, 0.98], screen: [0, -1, 0] });
  const none: [string, Scene][] = [
    ['push to the side', { rots: [], pushes: [{ dir: [1, 0, 0], t0: 0.4, dur: 0.25, dist: 0.35, hold: 0.1, back: 0.4 }], pose: remote, tref: 0, end: 1.5 }],
    ['lift', { rots: [], pushes: [{ dir: [0, 0, 1], t0: 0.4, dur: 0.25, dist: 0.35, hold: 0.1, back: 0.4 }], pose: remote, tref: 0, end: 1.5 }],
    // (and back again slowly: a quick return forward would be a thrust)
    ['pull back towards you', { rots: [], pushes: [{ dir: [0, -1, 0], t0: 0.4, dur: 0.25, dist: 0.35, hold: 0.1, back: 1.4 }], pose: remote, tref: 0, end: 2.4 }],
    ['a slow step forward (0.3 m in 0.8 s)', { rots: [], pushes: [{ dir: [0, 1, 0], t0: 0.3, dur: 0.8, dist: 0.3, hold: 0.2, back: 1 }], pose: remote, tref: 0, end: 2.5 }],
  ];
  for (const [k, [name, sc]] of none.entries()) {
    const f = simulate(sc, su(4500 + k));
    check(`not a thrust: ${name}`, f.length === 0, fmt(f));
  }
  // slashes move the hand a lot (the swing about the wrist): never a thrust
  let thrusts = 0;
  for (let k = 0; k < 40; k++) {
    const f = simulate(blow(GRIPS[k % 5], DIRS[k % 8], 8 + (k % 4) * 3), { screen: 0.2, calErr: 0, hz: k % 2 ? 100 : 60, noise: 0.05, seed: 4600 + k, ios: k % 3 === 0, accel: k % 4 === 3 ? 'ig' : 'both' });
    thrusts += f.filter((s) => s.kind === 'thrust').length;
  }
  check('40 slashes: never a thrust', thrusts === 0, `${thrusts}`);
  // a jab with the phone upright in the fist is a thrust too (people don't all point it first)
  const jab = simulate({ rots: [], pushes: [{ dir: [0, 1, 0], t0: 0.4, dur: 0.25, dist: 0.35, hold: 0.1, back: 0.4 }], pose: upright, tref: 0, end: 1.5 }, su(4550));
  check('a punch forward with the blade upright: a thrust', jab.length === 1 && jab[0].kind === 'thrust', fmt(jab));
  // a thrust, then a slash 400 ms after: both
  const ts: Scene = {
    rots: [{ kind: 'blow', axis: axisFor([0, 1, -0.05], -Math.PI / 2), tp: 1.15, peak: 12, rise: 0.06, fall: 0.05 }],
    pushes: [{ dir: [0, 1, -0.05], t0: 0.5, dur: 0.24, dist: 0.35, hold: 0.1, back: 0.35 }],
    pose: remote,
    tref: 0,
    end: 1.8,
  };
  const f = simulate(ts, su(4700));
  check('a thrust, then a chop 500 ms later: both', f.length === 2 && f[0].kind === 'thrust' && f[1].kind === 'slash' && Math.abs(wrap(f[1].dir - swingRead(-Math.PI / 2))) < 0.3, fmt(f));
  const na = simulate({ rots: [], pushes: [{ dir: [0, 1, -0.05], t0: 0.5, dur: 0.24, dist: 0.35, hold: 0.1, back: 0.35 }], pose: remote, tref: 0, end: 1.5 }, { ...su(4701), accel: 'none' });
  check('no accelerometer: no thrusts (and nothing else)', na.length === 0, fmt(na));
}

// 8. the guard's line, for the pad's display
console.log("\n— the guard's line");
{
  const cases: [V3, string][] = [
    [[0, 0.3, 0.95], 'vertical'],
    [[-0.95, 0.3, 0.05], 'horizontal'],
    [[0.95, 0.2, -0.1], 'horizontal'],
    [[0.6, 0.3, 0.6], 'rising'],
    [[-0.6, 0.3, 0.6], 'falling'],
    [[0.1, 0.98, 0.15], 'forward'],
  ];
  const got = cases.map(([s]) => guardLine(unit(s)).line);
  check('vertical, horizontal (both ways), ╱, ╲, pointed at the screen', got.every((g, i) => g === cases[i][1]), got.join(' '));
}

// 9. the touch fallback
console.log('\n— no motion sensor: swipe to slash, tap to thrust');
{
  /** a straight swipe: length px at heading `dir` (screen up = up), speeding up then easing off */
  const swipe = (dir: number, len: number, ms: number): SwipePoint[] => {
    const pts: SwipePoint[] = [];
    for (let t = 0; t <= ms; t += 8) {
      const u = t / ms;
      const s = len * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));
      pts.push({ t: 1000 + t, x: 200 + s * Math.cos(dir), y: 500 - s * Math.sin(dir) });
    }
    return pts;
  };
  let worst = 0,
    ok = true;
  for (const dir of DIRS) {
    const r = swipeStrike(swipe(dir, 220, 160));
    if (!r || r.kind !== 'slash') ok = false;
    else worst = Math.max(worst, Math.abs(wrap(r.dir - dir)));
  }
  check('8 directions', ok && worst < 0.02, `worst ${(worst * R2D).toFixed(1)}°`);
  const slow = swipeStrike(swipe(0, 150, 400))!,
    mid = swipeStrike(swipe(0, 200, 150))!,
    fast = swipeStrike(swipe(0, 300, 110))!;
  check('power from the speed: gentle ≈ 0.25 … a hard flick 1', slow.power < 0.35 && mid.power > slow.power && fast.power > 0.95, `${slow.power.toFixed(2)} (${slow.peak.toFixed(2)} px/ms) → ${mid.power.toFixed(2)} → ${fast.power.toFixed(2)} (${fast.peak.toFixed(2)} px/ms)`);
  // a slow drag whose first move lands 2 ms after the press (as they often do)
  const drag: SwipePoint[] = [{ t: 0, x: 60, y: 500 }];
  for (let k = 0; k < 12; k++) drag.push({ t: 2 + k * 55, x: 84 + k * 24, y: 500 - k * 8 });
  const dr = swipeStrike(drag);
  check('a slow drag stays gentle, however soon its first move comes', dr !== null && dr.kind === 'slash' && dr.power < 0.3, `${dr?.power.toFixed(2)} (${dr?.peak.toFixed(2)} px/ms)`);
  const tap = swipeStrike([
    { t: 0, x: 200, y: 400 },
    { t: 90, x: 203, y: 402 },
  ]);
  check('a tap is a thrust', tap?.kind === 'thrust', JSON.stringify(tap));
  const hold = swipeStrike([
    { t: 0, x: 200, y: 400 },
    { t: 600, x: 204, y: 401 },
  ]);
  const nudge = swipeStrike(swipe(0.3, 25, 120));
  check('a long press and a 25 px nudge are nothing', hold === null && nudge === null, `${JSON.stringify(hold)} / ${JSON.stringify(nudge)}`);
  const scribble: SwipePoint[] = [];
  for (let t = 0; t <= 300; t += 8) scribble.push({ t, x: 200 + 60 * Math.cos(t / 30), y: 400 + 60 * Math.sin(t / 30) });
  check('a scribble (round in a circle) is nothing', swipeStrike(scribble) === null, JSON.stringify(swipeStrike(scribble)));
}

console.log('\n— test harness sanity');
{
  let worst = 0;
  const R = rng(5);
  for (let i = 0; i < 200; i++) {
    const q = qaxis([R.gauss(), R.gauss(), R.gauss()], R.u() * 6.28);
    const [a, b, g] = euler(q);
    const back = quatFromEuler(a, b, g);
    worst = Math.max(worst, 1 - Math.abs(q[0] * back[0] + q[1] * back[1] + q[2] * back[2] + q[3] * back[3]));
  }
  check('quaternion → alpha/beta/gamma → quaternion round-trips', worst < 1e-9, `worst 1−|dot| = ${worst.toExponential(1)}`);
  // the designed direction is the one at the peak
  let dw = 0;
  for (const g of GRIPS) for (const d of DIRS) dw = Math.max(dw, Math.abs(wrap(physDir(blow(g, d, 10), 0.6) - d)));
  check('axisFor(): the tip travels the way it was asked to at the peak', dw < 1e-3, `worst ${(dw * R2D).toFixed(3)}°`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? 'Some sword checks FAILED.' : 'All sword checks passed.');
if (fail) process.exitCode = 1;
