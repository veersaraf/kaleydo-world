// A person holding a phone as a sword — synthetic, but shaped like real hands
// rather than textbook arcs. What real sword swings with a phone look like:
//
//  • the phone sits upright in the fist (grip at the bottom, screen to the
//    face), tilted forward a little — or, for some, pointed at the TV like a
//    remote — and never quite still: a tremor and a slow wander;
//  • a slash is a windup (the sword drawn back the other way, sometimes
//    briskly), a pause, then the strike: 300–900°/s at its peak, building up
//    over 50–110 ms, about wherever the arm happens to turn from — the wrist
//    (the phone's top sweeps), the elbow or the shoulder (the forearm carries an
//    upright phone across, turning it about itself) — with some of the turn off
//    the intended axis, a twist of the forearm in it, and the direction itself
//    off by a dozen degrees;
//  • then it stops (the arm decelerates), bounces back a little, and returns
//    to the ready pose at a few rad/s;
//  • the phone's own timing: ~60 Hz with jitter, events now and then handed
//    over in a bunch, the OS's fused orientation a sample or two late, the
//    OS's compass reference anywhere, gravity in the accelerometer (iOS
//    signs), the gyro's rates as the browser reports them.
//
// HandSim plays a script of such actions and hands out the raw events a
// browser would (rotationRate α β γ in deg/s, acceleration, gravity-included
// acceleration, deviceorientation α β γ), with the truth (what was meant, and
// when) alongside for scoring.

export type V3 = [number, number, number];
export type Quat = [number, number, number, number]; // x y z w

export const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const qnorm = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
export const qaxis = (a: V3, ang: number): Quat => {
  const n = Math.hypot(...a) || 1,
    s = Math.sin(ang / 2) / n;
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)];
};
export const rot = (q: Quat, v: V3): V3 => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
};
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const unit = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** the phone with its top along `top` and its screen facing `screen` (player frame) */
export function frame(top: V3, screen: V3): Quat {
  const y = unit(top);
  const z = unit(add(screen, scale(y, -dot(screen, y))));
  const x = cross(y, z);
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
export function euler(q: Quat): [number, number, number] {
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
  let a = Math.atan2(-r01, r11) * D;
  if (a < 0) a += 360; // (alpha is 0..360)
  return [a, Math.atan2(r21, c) * D, Math.atan2(-r20, r22) * D];
}

/** seeded randomness */
export function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  const range = (lo: number, hi: number) => lo + (hi - lo) * u();
  return { u, gauss, range };
}
export type Rng = ReturnType<typeof rng>;

// ------------------------------------------------------------------ the person

/** How this person holds and swings (drawn once per person). */
export interface Person {
  /** the ready pose: blade (top) and screen, player frame */
  rest: Quat;
  /** 'hilt' (upright, screen to the face) or 'remote' (pointed at the TV, screen up) */
  grip: 'hilt' | 'remote';
  /** how hard they swing: the strike's peak (rad/s) is drawn from here */
  speed: [number, number];
  /** how sloppy: the direction's σ (rad), the off-axis share, the forearm twist share */
  dirErr: number;
  offAxis: number;
  twist: number;
  /** how much they wind up first: 0 = hardly, 1 = always, briskly */
  windup: number;
  /** tremor amplitude, rad/s */
  tremor: number;
}

export function randomPerson(R: Rng, grip?: 'hilt' | 'remote'): Person {
  const g = grip ?? (R.u() < 0.75 ? 'hilt' : 'remote');
  let rest: Quat;
  if (g === 'hilt') {
    // upright, tilted forward 10–45°, leaning a little to one side, screen roughly to the face
    const tilt = R.range(0.17, 0.8),
      lean = R.gauss() * 0.2,
      yaw = R.gauss() * 0.15;
    const top: V3 = unit([Math.sin(lean) + Math.sin(yaw) * Math.sin(tilt), Math.cos(yaw) * Math.sin(tilt), Math.cos(tilt)]);
    rest = frame(top, [R.gauss() * 0.15, -1, R.gauss() * 0.2]);
  } else {
    const pitch = R.range(-0.1, 0.35),
      yaw = R.gauss() * 0.15;
    rest = frame([Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)], [R.gauss() * 0.2, R.gauss() * 0.2, 1]);
  }
  const lo = R.range(4.5, 7);
  return {
    rest,
    grip: g,
    speed: [lo, lo + R.range(3, 8)],
    dirErr: R.range(0.1, 0.28),
    offAxis: R.range(0.08, 0.3),
    twist: R.range(0, 0.4),
    windup: R.u(),
    tremor: R.range(0.1, 0.35),
  };
}

/** A rotation about a fixed axis (player frame) with its own speed profile. */
interface Turn {
  axis: V3;
  /** 'blow': gaussian each side of tp (σ rise / fall); 'smooth': raised cosine from t0 over dur */
  kind: 'blow' | 'smooth';
  tp: number;
  rise: number;
  fall: number;
  peak: number;
  t0: number;
  dur: number;
  angle: number;
}
function speedOf(r: Turn, t: number) {
  if (r.kind === 'blow') {
    const s = t < r.tp ? r.rise : r.fall;
    const x = (t - r.tp) / s;
    return Math.abs(x) > 4 ? 0 : r.peak * Math.exp(-0.5 * x * x);
  }
  const u = (t - r.t0) / r.dur;
  return u < 0 || u > 1 ? 0 : (r.angle / r.dur) * (1 - Math.cos(2 * Math.PI * u));
}
const turnEnd = (r: Turn) => (r.kind === 'blow' ? r.tp + 4 * r.fall : r.t0 + r.dur);

/** what the person meant to do, for scoring */
export interface Meant {
  kind: 'slash' | 'thrust' | 'guard' | 'gentle' | 'aim';
  /** slash: the direction meant (rad, as SwordStrike.dir) */
  dir: number;
  /** when the blow peaks (slash, thrust) or the action starts/ends */
  t: number;
  t0: number;
  t1: number;
  peak: number;
}

export interface RawEvents {
  motion: { t: number; ra: number; rb: number; rg: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number }[];
  orient: { t: number; alpha: number; beta: number; gamma: number }[];
  /** in the order a browser would fire them: m = motion[i], o = orient[i] */
  order: { k: 'm' | 'o'; i: number }[];
  guard: { t: number; down: boolean }[];
  /** when the remote calibrates "towards the screen" (joining) */
  calibrateAt: number;
}

export interface SimOpts {
  /** gyro axes as the browser reports them: 'xyz' (alpha = x…) or 'zxy' (alpha = z, beta = x, gamma = y) */
  axes?: 'xyz' | 'zxy';
  ios?: boolean;
  hz?: number;
  /** earth heading of the screen (the OS's compass reference is arbitrary) */
  screen?: number;
  /** how far off the player faced when they joined (the calibration), rad */
  calErr?: number;
  gyroNoise?: number;
  /** chance an event is handed over late, in a bunch with the next */
  bunch?: number;
}

/**
 * A person with a phone playing a script. Actions are added with slash() etc.
 * at times (s); run() integrates the motion (0.5 ms steps) and samples the
 * sensors.
 */
export class HandSim {
  meant: Meant[] = [];
  private turns: Turn[] = [];
  private pending: { t: number; make: (q: Quat, t: number) => void }[] = [];
  private pushes: { t0: number; dur: number; dist: number; hold: number; back: number; dir: V3 }[] = [];
  private guards: { t: number; down: boolean }[] = [];
  private end = 0;
  /** after run(): the true pose (device → player frame) at time t, s */
  pose: (t: number) => Quat = () => this.p.rest;

  constructor(
    readonly p: Person,
    readonly R: Rng,
  ) {}

  /** a slash meant to go `dir`; `speed` overrides the person's (peak rad/s) */
  slash(t: number, dir: number, speed?: number, windup?: boolean): number {
    const p = this.p,
      R = this.R;
    const peak = speed ?? R.range(p.speed[0], p.speed[1]);
    const wind = windup ?? R.u() < 0.35 + 0.6 * p.windup;
    // the strike passes through about the ready pose; the arm turns from somewhere
    // between the wrist (k = 0) and the shoulder (the forearm carries the phone)
    const b = rot(p.rest, [0, 1, 0]);
    const k = R.range(0, 1.3);
    const lever = unit(add(scale([0, 1, 0], k), b));
    const d = dir + R.gauss() * p.dirErr;
    const travel: V3 = [Math.cos(d), 0, Math.sin(d)];
    let axis = unit(cross(lever, travel));
    // some of it off the axis, and a twist of the forearm
    const off = unit(cross(axis, [R.gauss(), R.gauss(), R.gauss()]));
    axis = unit(add(add(axis, scale(off, p.offAxis * R.gauss())), scale(b, p.twist * R.gauss())));
    const rise = R.range(0.045, 0.11),
      fall = R.range(0.05, 0.12);
    let tp: number;
    if (wind) {
      // drawn back the other way first — about as far as the strike turns before its peak, so the
      // blow is fastest passing the ready pose, in front
      // (a windup is slower than its blow: 20–55% of its speed, the brisker the person the quicker)
      const wa = peak * rise * 1.25 * R.range(0.6, 1.2);
      const ws = wa / (2.5 * peak * (0.2 + 0.35 * p.windup * R.u()));
      const wtp = t + 3 * ws;
      this.turns.push({ kind: 'blow', axis: scale(axis, -1), tp: wtp, rise: ws, fall: ws, peak: wa / (2.5 * ws), t0: 0, dur: 0, angle: 0 });
      tp = wtp + 2.5 * ws + R.range(0, 0.2) + 3 * rise;
    } else tp = t + 3 * rise;
    this.turns.push({ kind: 'blow', axis, tp, rise, fall, peak, t0: 0, dur: 0, angle: 0 });
    // it stops, bounces back a little…
    const rb = R.range(0.15, 0.45) * peak;
    const rt = tp + R.range(0.1, 0.2),
      rf = R.range(0.04, 0.07);
    this.turns.push({ kind: 'blow', axis: scale(axis, -1), tp: rt, rise: 0.04, fall: rf, peak: rb, t0: 0, dur: 0, angle: 0 });
    // …and, once that's done, comes back to the ready pose (at a few rad/s)
    const back = Math.max(tp + 4 * fall, rt + 4 * rf) + R.range(0, 0.15);
    this.returnAt(back, R.range(0.45, 0.9));
    this.meant.push({ kind: speed !== undefined && speed < 3 ? 'gentle' : 'slash', dir, t: tp, t0: t, t1: tp + 0.25, peak });
    // (when it's all over, about)
    return back + 1.2;
  }

  /** back to the ready pose from wherever the phone is then, over at least `dur` s, peaking at 2.5–5.5 rad/s */
  returnAt(t: number, dur: number, top = this.R.range(2.5, 5.5)) {
    this.pending.push({
      t,
      make: (q) => {
        let d = qmul(this.p.rest, qconj(q));
        if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
        const s = Math.hypot(d[0], d[1], d[2]);
        if (s < 1e-6) return;
        const ang = 2 * Math.atan2(s, d[3]);
        const T = Math.max(dur, (2 * ang) / top);
        this.turns.push({ kind: 'smooth', axis: [d[0] / s, d[1] / s, d[2] / s], t0: t, dur: T, angle: ang, tp: 0, rise: 0, fall: 0, peak: 0 });
      },
    });
  }

  /** a jab at the screen */
  thrust(t: number) {
    const R = this.R;
    const dur = R.range(0.2, 0.35),
      dist = R.range(0.2, 0.4);
    this.pushes.push({ t0: t, dur, dist, hold: R.range(0.05, 0.15), back: R.range(0.4, 0.8), dir: unit([R.gauss() * 0.1, 1, R.gauss() * 0.1 - 0.05]) });
    // the wrist tips the blade forward a little as the arm goes out
    this.turns.push({ kind: 'smooth', axis: [1, 0, 0], t0: t, dur: dur * 1.3, angle: -R.range(0, 0.3), tp: 0, rise: 0, fall: 0, peak: 0 });
    this.returnAt(t + dur * 1.3 + 0.05, 0.6);
    this.meant.push({ kind: 'thrust', dir: 0, t: t + dur / 2, t0: t, t1: t + dur + 0.2, peak: 0 });
  }

  /** hold GUARD from t for `dur` s, angling the sword `turns` times (briskly) meanwhile */
  guard(t: number, dur: number, turns = 3) {
    const R = this.R;
    this.guards.push({ t, down: true }, { t: t + dur, down: false });
    for (let i = 0; i < turns; i++) {
      const at = t + 0.15 + ((dur - 0.5) * i) / turns;
      const td = R.range(0.2, 0.45);
      this.turns.push({ kind: 'smooth', axis: unit([R.gauss() * 0.3, 1, R.gauss() * 0.3]), t0: at, dur: td, angle: (R.u() < 0.5 ? -1 : 1) * R.range(0.6, 1.5), tp: 0, rise: 0, fall: 0, peak: 0 });
    }
    this.returnAt(t + dur - 0.3, 0.5);
    this.meant.push({ kind: 'guard', dir: 0, t, t0: t, t1: t + dur + 0.3, peak: 0 });
  }

  /** slow aiming about: `n` controlled turns at up to `max` rad/s */
  aim(t: number, dur: number, max = 2) {
    const R = this.R;
    let at = t;
    while (at < t + dur - 0.3) {
      const td = R.range(0.4, 0.9);
      const angle = Math.min(R.range(0.2, 0.8), (max * td) / 2);
      this.turns.push({ kind: 'smooth', axis: unit([R.gauss(), R.gauss(), R.gauss()]), t0: at, dur: td, angle, tp: 0, rise: 0, fall: 0, peak: 0 });
      at += td * R.range(0.7, 1.3);
    }
    this.returnAt(t + dur, 0.8, max);
    this.meant.push({ kind: 'aim', dir: 0, t, t0: t, t1: t + dur + 0.8, peak: 0 });
  }

  /** Integrate, and sample the phone's sensors as a browser would hand them over. */
  run(end: number, o: SimOpts = {}): RawEvents {
    this.end = end;
    const R = this.R;
    const p = this.p;
    const hz = o.hz ?? 60;
    const noise = o.gyroNoise ?? 0.02;
    const screen = o.screen ?? 1.1;
    const toEarth = qaxis([0, 0, 1], -screen);
    const STEP = 0.0005;
    // joining: the phone held to be looked at (top forward and up, screen to the face), facing off by calErr…
    const cal = o.calErr ?? 0;
    const look = qmul(qaxis([0, 0, 1], -cal), frame([0, 0.75, 0.66], [0, -0.66, 0.75]));
    // …then brought to the ready pose
    let q = look;
    this.returnAt(0.4, 0.6);
    // tremor: a few wobbles (3–9 Hz) and a slow wander
    const trem = Array.from({ length: 5 }, (_, i) => ({ axis: unit([R.gauss(), R.gauss(), R.gauss()]), f: i < 2 ? R.range(0.3, 0.8) : R.range(3, 9), ph: R.u() * 6.28, a: p.tremor * (i < 2 ? 0.8 : 0.5) }));
    // (actions schedule more as they go: a slash its return)
    const due = (t: number) => {
      let next: { t: number; make: (q: Quat, t: number) => void } | null = null;
      for (const a of this.pending) if (a.t <= t && (!next || a.t < next.t)) next = a;
      if (next) this.pending.splice(this.pending.indexOf(next), 1);
      return next;
    };
    const N = Math.ceil(end / STEP) + 1;
    const Q: Quat[] = new Array(N);
    this.pose = (t) => Q[Math.max(0, Math.min(N - 1, Math.round(t / STEP)))];
    const W: V3[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const t = i * STEP;
      for (let a = due(t); a; a = due(t)) a.make(q, t);
      let w: V3 = [0, 0, 0];
      for (const r of this.turns) {
        if (t > turnEnd(r) + 0.01) continue;
        const s = speedOf(r, t);
        if (s) w = add(w, scale(r.axis, s));
      }
      for (const tr of trem) w = add(w, scale(tr.axis, tr.a * Math.sin(2 * Math.PI * tr.f * t + tr.ph)));
      Q[i] = q;
      W[i] = w;
      const m = Math.hypot(...w);
      if (m > 1e-12) q = qnorm(qmul(qaxis(w, m * STEP), q));
    }
    // where the phone is: turning about the elbow (behind and below the hand), plus the jabs
    const H0: V3 = [0.2, 0.45, 1.2];
    const E: V3 = add(H0, [0, -0.3, -0.12]);
    const Q0 = p.rest;
    const where = (t: number): V3 => {
      const i = Math.max(0, Math.min(N - 1, Math.round(t / STEP)));
      const rel = qmul(Q[i], qconj(Q0));
      let h = add(E, rot(rel, add(H0, scale(E, -1))));
      for (const pu of this.pushes) {
        const u = t - pu.t0;
        let x = 0;
        if (u > 0 && u < pu.dur) x = (pu.dist * (1 - Math.cos((Math.PI * u) / pu.dur))) / 2;
        else if (u >= pu.dur && u < pu.dur + pu.hold) x = pu.dist;
        else if (u >= pu.dur + pu.hold && u < pu.dur + pu.hold + pu.back) x = (pu.dist * (1 + Math.cos((Math.PI * (u - pu.dur - pu.hold)) / pu.back))) / 2;
        h = add(h, scale(pu.dir, x));
      }
      // the body sways a little
      return add(h, [0.01 * Math.sin(1.3 * t), 0.01 * Math.sin(0.9 * t + 1), 0.005 * Math.sin(1.7 * t)]);
    };
    const out: RawEvents = { motion: [], orient: [], order: [], guard: [...this.guards].sort((a, b) => a.t - b.t), calibrateAt: 0.05 };
    const D = 180 / Math.PI;
    const sg = o.ios ? -1 : 1;
    const lag: Quat[] = [];
    let handT = 0;
    for (let n = 0; ; n++) {
      const t = n / hz + (R.u() - 0.5) * 0.003;
      if (t > end - 0.02) break;
      const i = Math.max(0, Math.min(N - 1, Math.round(t / STEP)));
      const qd = Q[i];
      // gyro: device-frame rates, as the browser labels them
      const wd = rot(qconj(qd), W[i]).map((v) => v + noise * R.gauss()) as V3;
      const [ra, rb, rg] = o.axes === 'zxy' ? [wd[2] * D, wd[0] * D, wd[1] * D] : [wd[0] * D, wd[1] * D, wd[2] * D];
      // accelerometer: the hand's acceleration + gravity (W3C: reads "up" at rest; iOS: all flipped)
      const h = 0.004;
      const a0 = where(t - h),
        a1 = where(t),
        a2 = where(t + h);
      const acc = rot(qconj(qd), [0, 1, 2].map((k) => (a0[k] - 2 * a1[k] + a2[k]) / (h * h)) as V3).map((v) => v + 0.04 * R.gauss()) as V3;
      const up = rot(qconj(qd), [0, 0, 1]);
      // the event reaches the page a moment later, now and then late and in a bunch
      handT = Math.max(handT + 0.0002, t + 0.002 + (R.u() < (o.bunch ?? 0.03) ? R.range(0.008, 0.02) : 0));
      out.motion.push({
        t: handT * 1000,
        ra,
        rb,
        rg,
        ax: sg * acc[0],
        ay: sg * acc[1],
        az: sg * acc[2],
        gx: sg * (acc[0] + 9.81 * up[0]),
        gy: sg * (acc[1] + 9.81 * up[1]),
        gz: sg * (acc[2] + 9.81 * up[2]),
      });
      // the OS's fused orientation, a sample or two behind, against its own compass reference
      lag.push(qmul(toEarth, qd));
      const os = lag.length > 2 ? lag.shift()! : lag[0];
      const [al, be, ga] = euler(os);
      out.orient.push({ t: handT * 1000 + 0.1, alpha: al, beta: be, gamma: ga });
      if (R.u() < 0.5) out.order.push({ k: 'o', i: n }, { k: 'm', i: n });
      else out.order.push({ k: 'm', i: n }, { k: 'o', i: n });
    }
    return out;
  }
}
