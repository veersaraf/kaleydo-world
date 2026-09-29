// Synthetic bowling swings → BowlDetector: ball speed, line (angle), hook spin
// and the live arm angle — for several ways of holding the phone, screen
// directions, sample rates, heading calibration errors and both sign
// conventions of the accelerometer. The motion comes from a model of the arm
// (a pendulum about the shoulder, a wrist twist about the forearm, the swing's
// plane turning at the top for a pull or a push) and goes through the same
// orientation pipeline the remote uses: gyro integration + the OS's fused
// orientation arriving a little late. The accelerometer reads the phone's
// acceleration on the end of the arm.
//
//   npx tsx scripts/bowl-pad-test.ts
import { BowlDetector, swipeThrow, type BowlThrow, type SwipePoint } from '../src/pad/bowl';
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
const qaxis = (a: V3, ang: number): Quat => {
  const n = Math.hypot(...a),
    s = Math.sin(ang / 2) / n;
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)];
};
const qrotV = (q: Quat, v: V3): V3 => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
};
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
  return q;
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

// How the phone sits in the hand with the arm hanging: device axes in the player frame
// (x right, y towards the screen, z up).
const GRIPS: { name: string; q: Quat }[] = [
  { name: 'upright, screen forward', q: qcols([-1, 0, 0], [0, 0, 1], [0, 1, 0]) },
  { name: 'flat in the palm, screen up', q: qcols([1, 0, 0], [0, 1, 0], [0, 0, 1]) },
  { name: 'along the fingers, top down', q: qcols([1, 0, 0], [0, 0, -1], [0, 1, 0]) },
  { name: 'screen to the thigh', q: qcols([0, -1, 0], [0, 0, 1], [-1, 0, 0]) },
  { name: 'oblique', q: qmul(qaxis([0.3, -0.8, 0.5], 2.2), qaxis([1, 0.2, 0], 0.7)) },
];

interface Swing {
  /** backswing height, rad (0 = no swing at all) */
  back: number;
  /** angular speed through the bottom of the forward swing, rad/s */
  peak: number;
  /** the player's own line (the backswing's), rad right of straight at the screen */
  dir: number;
  /** the forward swing's line against the backswing's: + a push to the right, − a pull to the left */
  pull?: number;
  /** wrist twist through the release, rad (+ counter-clockwise seen from above) */
  twist: number;
  /** let go this many ms after the bottom of the swing (− = early) */
  late: number;
  /** the twist is centred this many ms after the release (default −60: mostly before letting go) */
  twistAt?: number;
  /** let go during the backswing instead */
  onBack?: boolean;
  /** >1: a muscled swing, still speeding up past the bottom (fastest ~20 ms after it at 1.3) */
  skew?: number;
  /** the arm swings a little out to the side: the swing plane leans this far off vertical, rad */
  tilt?: number;
  /** where the arm is at the grip: 0 hanging (default), 1.1 the ball up in front, −back already back (no backswing) */
  start?: number;
}
interface Setup {
  grip: Quat;
  /** earth heading of the screen, rad */
  screen: number;
  /** calibration error of "towards the screen", rad (null = never calibrated) */
  calErr: number | null;
  hz: number;
  /** gyro noise σ, rad/s */
  noise: number;
  seed: number;
  /** iOS: acceleration and gravity reported with the opposite sign */
  ios?: boolean;
  /** no acceleration reported (some Android phones) */
  noAccel?: boolean;
  /** the body's own movement, m/s² (a lurch as the player steps) */
  sway?: number;
  /** the accelerometer's range, g (it clips beyond: 8 on older iPhones, 16 on newer; default 16) */
  clip?: number;
}
interface Result {
  thr: BowlThrow;
  /** the arm streamed at the grip and at the backswing's top (the truth: start, −back) */
  armGrip: number;
  armTop: number;
  /** the streamed arm − the true angle at the last sample before the bottom (the truth there ≈ 0) */
  armBottom: number;
  /** the truth for the angle: the swing plane's line as it let go, against the backswing's */
  line: number;
}

const ARM_R = 0.65; // shoulder → phone

/** how long release() took, ms (a bowl has no peak to wait for — the finger lifting is the release; this is all the phone adds) */
const costs: number[] = [];
const timedRelease = (det: BowlDetector, t: number) => {
  const t0 = performance.now();
  const r = det.release(t);
  costs.push(performance.now() - t0);
  return r;
};

function simulate(sw: Swing, su: Setup): Result {
  const R = rng(su.seed);
  const start = sw.start ?? 0;
  const tb0 = 0.5,
    Tb = 0.6;
  const tf0 = tb0 + Tb;
  const Tf = sw.back > 0 ? (sw.back * Math.PI) / Math.max(0.05, sw.peak) : 1;
  const k = sw.skew ?? 1;
  const tBottom = tf0 + Tf * 0.5 ** (1 / k);
  const tRel = sw.onBack ? tb0 + Tb * 0.5 : tBottom + sw.late / 1000;
  const theta = (t: number) => {
    if (t < tb0) return start;
    if (t < tf0) return start + ((-sw.back - start) * (1 - Math.cos((Math.PI * (t - tb0)) / Tb))) / 2;
    if (t < tf0 + Tf) return -sw.back * Math.cos(Math.PI * ((t - tf0) / Tf) ** k);
    return sw.back;
  };
  const tw0 = tRel + (sw.twistAt ?? -60) / 1000 - 0.1;
  const ease = (s: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, s)))) / 2;
  const phi = (t: number) => sw.twist * ease((t - tw0) / 0.2);
  // a pull or a push: the swing's plane turns about the vertical around the top of the backswing
  const delta = (t: number) => -(sw.pull ?? 0) * ease((t - (tf0 - 0.12)) / 0.24);
  const fwd: V3 = [Math.sin(sw.dir), Math.cos(sw.dir), 0];
  const lean = qaxis(fwd, sw.tilt ?? 0); // the whole arm leaning out to the side
  const L = qrotV(lean, [Math.cos(sw.dir), -Math.sin(sw.dir), 0]);
  const toEarth = qaxis([0, 0, 1], -su.screen);
  // the arm: plane turn ∘ swing (about the lateral axis) ∘ lean
  const armPose = (t: number): Quat => qmul(toEarth, qmul(qaxis([0, 0, 1], delta(t)), qmul(qaxis(L, theta(t)), lean)));
  // the phone: the arm ∘ wrist twist (about the hanging forearm) ∘ grip
  const pose = (t: number): Quat => qmul(armPose(t), qmul(qaxis([0, 0, 1], phi(t)), su.grip));
  const rate = (t: number): V3 => {
    const h = 1e-4;
    let d = qmul(qconj(pose(t - h)), pose(t + h));
    if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
    const s = Math.hypot(d[0], d[1], d[2]);
    if (s < 1e-12) return [0, 0, 0];
    const ang = 2 * Math.atan2(s, d[3]);
    return [(d[0] / s) * (ang / (2 * h)), (d[1] / s) * (ang / (2 * h)), (d[2] / s) * (ang / (2 * h))];
  };
  // the phone hangs ARM_R below the shoulder along the arm: its acceleration in device axes
  const where = (t: number): V3 => qrotV(armPose(t), [0, 0, -ARM_R]);
  const accel = (t: number): V3 => {
    const h = 2e-3;
    const a = where(t - h),
      b = where(t),
      c = where(t + h);
    const w: V3 = [(a[0] - 2 * b[0] + c[0]) / (h * h), (a[1] - 2 * b[1] + c[1]) / (h * h), (a[2] - 2 * b[2] + c[2]) / (h * h)];
    const sway = su.sway ?? 0;
    w[0] += sway * Math.sin(2 * Math.PI * 1.3 * t);
    w[1] += sway * 0.6 * Math.cos(2 * Math.PI * 0.9 * t);
    w[2] += sway * 0.4 * Math.sin(2 * Math.PI * 1.7 * t);
    return qrotV(qconj(pose(t)), w);
  };

  const det = new BowlDetector();
  const ori = new Orientation();
  const osLag: Quat[] = [];
  let prev: V3 = [0, 0, 0];
  let lastT = 0;
  let gripped = false;
  let armGrip = NaN,
    armTop = NaN,
    armBottom = NaN;
  const end = Math.max(tRel + 0.3, 1.6);
  let released: BowlThrow | null = null;
  for (let n = 0; ; n++) {
    // devicemotion arrives at a steady rate with a little jitter
    const t = n / su.hz + (n ? (R.u() - 0.5) * 0.002 : 0);
    if (t > end) break;
    if (!gripped && t >= 0.35) {
      det.heading = ori.heading;
      det.grip(t * 1000);
      armGrip = det.arm;
      gripped = true;
    }
    if (!released && t > tRel) released = timedRelease(det, tRel * 1000);
    const q = pose(t);
    // the OS's fused orientation, two samples late (as deviceorientation is)
    osLag.push(q);
    const os = osLag.length > 2 ? osLag.shift()! : osLag[0];
    const [al, be, ga] = euler(os);
    ori.measure(al, be, ga, t * 1000);
    if (ori.heading === null && su.calErr !== null) ori.heading = su.screen + su.calErr;
    const w = rate(t).map((v) => v + su.noise * R.gauss()) as V3;
    const dt = lastT ? t - lastT : 1 / su.hz;
    ori.integrate((w[0] + prev[0]) / 2, (w[1] + prev[1]) / 2, (w[2] + prev[2]) / 2, dt);
    prev = w;
    lastT = t;
    // the accelerometer (W3C: gravity reads "up"; iOS: everything flipped)
    const sg = su.ios ? -1 : 1;
    const lim = (su.clip ?? 16) * 9.81;
    const up0 = qrotV(qconj(q), [0, 0, 1]);
    // the sensor reads acceleration + gravity, and clips that; the browser then splits it again
    const a = accel(t).map((v, k) => {
      const raw = Math.max(-lim, Math.min(lim, v + 9.81 * up0[k] + 0.05 * R.gauss()));
      return sg * (raw - 9.81 * up0[k]);
    }) as V3;
    const up = qrotV(qconj(q), [0, 0, 1]);
    const g = up.map((v) => sg * 9.81 * v) as V3;
    det.heading = ori.heading;
    det.push({
      t: t * 1000,
      rx: w[0],
      ry: w[1],
      rz: w[2],
      q: [ori.q[0], ori.q[1], ori.q[2], ori.q[3]],
      ...(su.noAccel ? {} : { ax: a[0], ay: a[1], az: a[2], gx: g[0], gy: g[1], gz: g[2] }),
    });
    if (Number.isNaN(armTop) && t >= tf0) armTop = det.arm;
    if (det.gripping && t <= tBottom && tBottom - t < 0.025) armBottom = det.arm - theta(t);
  }
  if (!released) released = timedRelease(det, tRel * 1000);
  // the plane's turn by the release: + a push to the right
  const line = -delta(tRel);
  return { thr: released, armGrip, armTop, armBottom, line };
}

// ------------------------------------------------------------------ checks

let pass = 0,
  fail = 0;
const fmt = (r: BowlThrow) =>
  `${r.speed.toFixed(2)} m/s  angle ${r.angle >= 0 ? '+' : ''}${r.angle.toFixed(3)} (${r.ref ?? '—'})  spin ${r.spin >= 0 ? '+' : ''}${r.spin.toFixed(2)}  (ω ${r.peak.toFixed(1)}, twist ${r.twist >= 0 ? '+' : ''}${r.twist.toFixed(1)})`;
const fmtArm = (r: Result) => `arm ${r.armGrip.toFixed(2)} → top ${r.armTop.toFixed(2)} → bottom ${Number.isNaN(r.armBottom) ? '—' : (r.armBottom >= 0 ? '+' : '') + r.armBottom.toFixed(2)}`;

function check(name: string, ok: boolean, detail: string) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(56)} ${detail}`);
}

/** the streamed arm is where the arm really is: at the backswing's top and at the bottom —
 *  once the swing is fast enough to show it (a backswing ≥ 2.5 rad/s; a guess before that) */
const armOk = (r: Result, sw: Swing) => {
  const backRate = (Math.abs(-sw.back - (sw.start ?? 0)) * Math.PI) / (2 * 0.6);
  const top = sw.onBack || backRate < 2.5 || Math.abs(r.armTop + sw.back) < 0.4;
  // (a release before the bottom never gets there)
  const bottom = ((sw.onBack || sw.late < 0) && Number.isNaN(r.armBottom)) || sw.peak < 2.5 || Math.abs(r.armBottom) < 0.3;
  return top && bottom;
};
const straight = (r: Result) => Math.abs(r.thr.angle) < 0.02 && r.thr.ref === 'backswing';

const base: Swing = { back: 1.2, peak: 7.5, dir: 0, twist: 0, late: 10 };
type Case = { name: string; sw: Partial<Swing>; want: (r: Result) => boolean; su?: Partial<Setup> };
const CASES: Case[] = [
  { name: 'relaxed, straight', sw: {}, want: (r) => r.thr.speed >= 6 && r.thr.speed <= 7.3 && straight(r) && Math.abs(r.thr.spin) < 0.08 },
  { name: 'hard, straight', sw: { back: 1.45, peak: 13, late: 0 }, want: (r) => r.thr.speed >= 8.8 && straight(r) && Math.abs(r.thr.spin) < 0.08 },
  { name: 'slow roll', sw: { back: 0.7, peak: 3.5 }, want: (r) => r.thr.speed >= 3.5 && r.thr.speed <= 5 && straight(r) },
  { name: 'from the ball held up in front', sw: { start: 1.1 }, want: (r) => r.thr.speed >= 6 && r.thr.speed <= 7.3 && straight(r) },
  { name: 'hook (counter-clockwise twist)', sw: { peak: 8, twist: 1.6 }, want: (r) => r.thr.spin > 0.5 && Math.abs(r.thr.angle) < 0.05 },
  { name: 'reverse hook (clockwise twist)', sw: { peak: 8, twist: -1.6 }, want: (r) => r.thr.spin < -0.5 && Math.abs(r.thr.angle) < 0.05 },
  { name: 'gentle hook', sw: { twist: 0.35 }, want: (r) => r.thr.spin > 0.1 && r.thr.spin < 0.7 && Math.abs(r.thr.angle) < 0.04 },
  { name: 'own line angled 0.12 right, straight pendulum', sw: { dir: 0.12 }, want: (r) => straight(r) && Math.abs(r.thr.spin) < 0.08 },
  { name: 'push to the right', sw: { pull: 0.1 }, want: (r) => r.thr.angle > 0.07 && r.thr.angle < 0.13 && r.thr.ref === 'backswing' },
  { name: 'pull to the left', sw: { pull: -0.1 }, want: (r) => r.thr.angle < -0.07 && r.thr.angle > -0.13 && r.thr.ref === 'backswing' },
  { name: 'push + hook', sw: { pull: 0.1, twist: 1.4 }, want: (r) => r.thr.angle > 0.06 && r.thr.angle < 0.14 && r.thr.spin > 0.4 },
  { name: 'late release (70 ms) + hook', sw: { peak: 8, twist: 1.6, late: 70 }, want: (r) => r.thr.spin > 0.4 && Math.abs(r.thr.angle) < 0.06 && r.thr.speed > 6 },
  { name: 'late release, twisting as it lets go', sw: { peak: 8, twist: 1.6, late: 70, twistAt: -20 }, want: (r) => r.thr.spin > 0.4 && Math.abs(r.thr.angle) < 0.06 && r.thr.speed > 6 && r.thr.speed < 7.4 },
  { name: 'early release (30 ms) + hook', sw: { peak: 8, twist: 1.2, late: -30 }, want: (r) => r.thr.spin > 0.4 && Math.abs(r.thr.angle) < 0.05 },
  { name: 'muscled swing (fastest past the bottom) + hook', sw: { peak: 8, twist: 1.2, skew: 1.3 }, want: (r) => r.thr.spin > 0.4 && Math.abs(r.thr.angle) < 0.05 },
  { name: 'arm swinging out 6° to the side', sw: { tilt: 0.1 }, want: (r) => Math.abs(r.thr.angle) < 0.03 && Math.abs(r.thr.spin) < 0.1 && r.thr.speed > 6 },
  { name: 'arm out 6° + hook', sw: { tilt: 0.1, twist: 1.2 }, want: (r) => Math.abs(r.thr.angle) < 0.05 && r.thr.spin > 0.4 },
  { name: 'no backswing (arm already back): line from the screen', sw: { start: -1.2, dir: 0.12 }, want: (r) => r.thr.ref === 'screen' && r.thr.angle > 0.09 && r.thr.angle < 0.15 },
  { name: 'tiny backswing: line from the screen', sw: { back: 0.25, peak: 2.2, dir: -0.1 }, want: (r) => r.thr.ref === 'screen' && r.thr.angle < -0.07 && r.thr.angle > -0.13 },
  { name: 'tiny swing', sw: { back: 0.12, peak: 0.8 }, want: (r) => r.thr.speed >= 2.5 && r.thr.speed <= 3.2 && Math.abs(r.thr.spin) < 0.05 },
  { name: 'no swing at all', sw: { back: 0, peak: 0 }, want: (r) => r.thr.speed < 2.6 && r.thr.angle === 0 && Math.abs(r.thr.spin) < 0.02 },
  { name: 'let go on the backswing', sw: { onBack: true }, want: (r) => Math.abs(r.thr.angle) < 0.05 },
  { name: 'uncalibrated: the backswing still gives the line', sw: { pull: -0.1 }, su: { calErr: null }, want: (r) => r.thr.ref === 'backswing' && r.thr.angle < -0.07 && r.thr.angle > -0.13 },
  { name: 'uncalibrated, no backswing → no angle', sw: { start: -1.2, dir: 0.12 }, su: { calErr: null }, want: (r) => r.thr.angle === 0 && r.thr.ref === null },
];

const SCREENS = [0, 0.6, -2.1, 3.0];
let n = 0;
for (const grip of GRIPS) {
  console.log(`\n— ${grip.name}`);
  for (const c of CASES) {
    const hz = n % 3 === 2 ? 100 : 60;
    const su: Setup = { grip: grip.q, screen: SCREENS[n % SCREENS.length], calErr: 0, hz, noise: 0.03, seed: 1000 + n, ios: n % 2 === 1, ...c.su };
    n++;
    const sw = { ...base, ...c.sw };
    const r = simulate(sw, su);
    // the arm is only placed against the screen once calibrated
    const ok = c.want(r) && (su.calErr === null || armOk(r, sw));
    check(`${c.name} [${hz} Hz${su.ios ? ', iOS' : ''}]`, ok, `${fmt(r.thr)}  ${fmtArm(r)}`);
  }
}

console.log('\n— heading-proof line');
{
  for (const err of [-0.3, 0.3]) {
    for (const g of [GRIPS[0], GRIPS[2], GRIPS[4]]) {
      const su: Setup = { grip: g.q, screen: 1.1, calErr: err, hz: 60, noise: 0.03, seed: 77 };
      const r = simulate({ ...base, peak: 8 }, su);
      check(`heading off by ${err > 0 ? '+' : ''}${err}, straight (${g.name})`, Math.abs(r.thr.angle) < 0.01 && r.thr.ref === 'backswing', fmt(r.thr));
      const p = simulate({ ...base, peak: 8, pull: -0.08, twist: 1 }, su);
      check(`heading off by ${err > 0 ? '+' : ''}${err}, pull + hook (${g.name})`, p.thr.angle < -0.05 && p.thr.angle > -0.11, fmt(p.thr));
      const q = simulate({ ...base, peak: 8, pull: 0.08 }, su);
      check(`heading off by ${err > 0 ? '+' : ''}${err}, push (${g.name})`, q.thr.angle > 0.05 && q.thr.angle < 0.11, fmt(q.thr));
    }
  }
  // without a backswing the calibrated heading is all there is: it shows
  const nb = simulate({ ...base, start: -1.2 }, { grip: GRIPS[2].q, screen: 1.1, calErr: 0.1, hz: 60, noise: 0.03, seed: 78 });
  check('no backswing, heading 0.1 off: reads the 0.1 (the fallback)', nb.thr.ref === 'screen' && nb.thr.angle < -0.07 && nb.thr.angle > -0.13, fmt(nb.thr));
}

console.log('\n— the arm, from the ball held up in front (five grips)');
{
  let g = 0;
  for (const grip of GRIPS) {
    for (const ios of [false, true]) {
      const sw = { ...base, start: 1.1, peak: 8 };
      const r = simulate(sw, { grip: grip.q, screen: 0.4, calErr: 0.15, hz: g % 2 ? 100 : 60, noise: 0.03, seed: 300 + g, ios, sway: 0.8 });
      g++;
      check(`${grip.name}${ios ? ' [iOS]' : ''}, body swaying`, armOk(r, sw) && straight(r), `${fmtArm(r)}  ${fmt(r.thr)}`);
    }
  }
  // no acceleration reported: the guess from the grip and the gyro, nothing more
  const na = simulate(base, { grip: GRIPS[2].q, screen: 0.4, calErr: 0, hz: 60, noise: 0.03, seed: 350, noAccel: true });
  check('no accelerometer, phone down along a hanging arm (guess right)', armOk(na, base), fmtArm(na));
  const nb = simulate(base, { grip: GRIPS[1].q, screen: 0.4, calErr: 0, hz: 60, noise: 0.03, seed: 351, noAccel: true });
  console.log(`  (no accelerometer, flat in the palm hanging: the guess says "in front" and nothing corrects it — ${fmtArm(nb)})`);
}

console.log('\n— timing');
{
  const su: Setup = { grip: GRIPS[0].q, screen: 0.6, calErr: 0, hz: 60, noise: 0.03, seed: 7 };
  const onTime = simulate({ ...base, late: 0 }, su);
  const early = simulate({ ...base, late: -90 }, su);
  check('early release is slower than at the bottom', early.thr.speed < onTime.thr.speed - 0.3, `${onTime.thr.speed.toFixed(2)} → ${early.thr.speed.toFixed(2)} m/s`);
  const lateLong = simulate({ ...base, late: 200 }, su);
  check('very late release (arm on the way up) is slower', lateLong.thr.speed < onTime.thr.speed - 0.3, `${lateLong.thr.speed.toFixed(2)} m/s`);
  const hard = simulate({ ...base, back: 1.5, peak: 20, late: 0 }, su);
  check('very hard swing stays under the ceiling', hard.thr.speed <= 10.5 && hard.thr.speed > 9.8, `${hard.thr.speed.toFixed(2)} m/s`);
  const noisy = simulate(base, { ...su, noise: 0.12, seed: 99 });
  check('very noisy gyro (0.12 rad/s, ~10× a phone): no spin, ~straight', Math.abs(noisy.thr.spin) < 0.08 && Math.abs(noisy.thr.angle) < 0.05, fmt(noisy.thr));
  // the line's precision over many throws (straight pendulums, all grips, 60/100 Hz)
  for (const [noise, p90max] of [
    [0.03, 0.01],
    [0.12, 0.035],
  ]) {
    const errs: number[] = [];
    for (let k = 0; k < 40; k++) {
      const r = simulate(base, { grip: GRIPS[k % 5].q, screen: 0.6, calErr: 0, hz: k % 2 ? 100 : 60, noise, seed: 500 + k });
      errs.push(Math.abs(r.thr.angle));
    }
    errs.sort((a, b) => a - b);
    const p90 = errs[Math.floor(0.9 * (errs.length - 1))];
    check(`straight line over 40 throws, gyro noise ${noise} rad/s: 90% within ${p90max}`, p90 < p90max, `median ${errs[20].toFixed(4)}, p90 ${p90.toFixed(4)}, max ${errs[errs.length - 1].toFixed(4)} rad`);
  }
  check('"light swings" setting rolls faster for the same swing', lightSpeed(1.35) > lightSpeed(1) + 0.4, `${lightSpeed(1).toFixed(2)} → ${lightSpeed(1.35).toFixed(2)} m/s`);
}

function lightSpeed(sens: number) {
  // same relaxed swing, different sensitivity: replay its samples into a detector
  const d = new BowlDetector();
  d.sensitivity = sens;
  d.heading = 0;
  // a clean pendulum about the lateral axis, phone flat, 60 Hz
  for (let k = 0; k <= 60; k++) {
    const t = k / 60;
    const w = 7.5 * Math.exp(-(((t - 0.5) / 0.15) ** 2));
    const th = 7.5 * 0.15 * Math.sqrt(Math.PI) * 0.5 * (1 + erf((t - 0.5) / 0.15)) - 1.0;
    d.push({ t: t * 1000, rx: w, ry: 0, rz: 0, q: qaxis([1, 0, 0], th) });
  }
  return d.release(505).speed;
}
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

console.log('\n— euler conversion (test harness sanity)');
{
  let worst = 0;
  const R = rng(5);
  for (let i = 0; i < 200; i++) {
    const q = qaxis([R.gauss(), R.gauss(), R.gauss()], R.u() * 6.28);
    const [a, b, g] = euler(q);
    const back = quatFromEuler(a, b, g);
    const dot = Math.abs(q[0] * back[0] + q[1] * back[1] + q[2] * back[2] + q[3] * back[3]);
    worst = Math.max(worst, 1 - dot);
  }
  for (const grip of GRIPS) {
    const [a, b, g] = euler(grip.q);
    const back = quatFromEuler(a, b, g);
    const q = grip.q;
    worst = Math.max(worst, 1 - Math.abs(q[0] * back[0] + q[1] * back[1] + q[2] * back[2] + q[3] * back[3]));
  }
  check('quaternion → alpha/beta/gamma → quaternion round-trips', worst < 1e-9, `worst 1−|dot| = ${worst.toExponential(1)}`);
}

// ------------------------------------------------------------------ swipe fallback

console.log('\n— swipe fallback (no motion sensor)');
/** a stroke that speeds up (like a flick): length px over ms, heading from straight up (+ right), bending by `bend` rad (+ left) */
function stroke(length: number, ms: number, heading = 0, bend = 0, down = false): SwipePoint[] {
  const pts: SwipePoint[] = [];
  let x = 200,
    y = 620;
  let s0 = 0;
  for (let t = 0; t <= ms; t += 8) {
    const u = t / ms;
    const s = length * u * u;
    const ds = s - s0;
    s0 = s;
    const h = heading - bend * u * u; // turning left = heading decreasing
    x += ds * Math.sin(h);
    y += (down ? 1 : -1) * ds * Math.cos(h);
    pts.push({ t: 1000 + t, x, y });
  }
  return pts;
}
const swipes: { name: string; pts: SwipePoint[]; want: (r: BowlThrow) => boolean }[] = [
  { name: 'relaxed flick up', pts: stroke(220, 300), want: (r) => r.speed >= 5.5 && r.speed <= 7.3 && r.angle === 0 && r.spin === 0 },
  { name: 'hard flick up', pts: stroke(420, 280), want: (r) => r.speed >= 9 && r.angle === 0 },
  { name: 'slow drag up', pts: stroke(120, 450), want: (r) => r.speed >= 2.5 && r.speed < 4.5 },
  { name: 'flick up and to the right', pts: stroke(260, 300, 0.4), want: (r) => r.angle > 0.05 && r.angle <= 0.2 },
  { name: 'flick up and to the left', pts: stroke(260, 300, -0.4), want: (r) => r.angle < -0.05 },
  { name: 'stroke curving left into the pocket → hook left', pts: stroke(300, 320, 0.35, 0.8), want: (r) => r.spin > 0.3 && Math.abs(r.angle) < 0.05 },
  { name: 'stroke curving right → hook right', pts: stroke(300, 320, -0.35, -0.8), want: (r) => r.spin < -0.3 && Math.abs(r.angle) < 0.05 },
  { name: 'tap', pts: [{ t: 0, x: 200, y: 500 }, { t: 90, x: 202, y: 499 }], want: (r) => r.speed === 2.5 && r.angle === 0 && r.spin === 0 },
  { name: 'drag down', pts: stroke(250, 300, 0, 0, true), want: (r) => r.speed === 2.5 },
];
for (const s of swipes) {
  const r = swipeThrow(s.pts);
  check(s.name, s.want(r), fmt(r));
}

{
  const a = costs.slice(3).sort((x, y) => x - y); // (the first few calls warm the JIT up)
  const q = (f: number) => a[Math.min(a.length - 1, Math.floor(f * (a.length - 1) + 0.5))];
  console.log(`\nrelease() compute time on this machine (${a.length} throws): p50 ${q(0.5).toFixed(2)} ms, p90 ${q(0.9).toFixed(2)} ms, max ${a[a.length - 1].toFixed(2)} ms`);
}
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? 'Some bowling checks FAILED.' : 'All bowling checks passed.');
if (fail) process.exitCode = 1;
