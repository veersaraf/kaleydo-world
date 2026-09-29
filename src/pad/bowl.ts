// Bowling release detection from raw phone motion.
//
// The phone is the ball: hold it with your thumb on the grip pad, swing your
// arm back, then forward like a pendulum, and let go at the bottom. Everything
// is measured in the player frame (x right, y towards the screen, z up) via
// the orientation quaternion, so it works whichever way the phone sits in the
// hand:
//
//  • arm    — the arm's pendulum angle: 0 = hanging straight down, + = forward
//             and up, − = behind. At the grip it's a guess from how the phone
//             is held (looked at in front ≈ +1.1, pointing down ≈ 0); then the
//             angular velocity about the lateral axis (x) is integrated (a
//             hanging arm swinging forward turns about +x), and once the arm
//             swings, its pull on the hand shows where the arm really is.
//  • speed  — how fast the arm swings through the bottom: the peak angular
//             speed about the swing's (horizontal) axis over the last 120 ms
//             before the release × arm length = hand speed → ball speed.
//  • angle  — which way the hand was moving at the release (v = ω × r_arm with
//             r_arm = −up at the bottom → v = (−ωy, ωx, 0), for ω along the
//             swing's axis), measured against the player's own backswing: a
//             straight pendulum reads 0 whichever way the phone thinks the
//             screen is, a pull or a push across the body reads as an angle.
//             Without a real backswing, against the calibrated "towards the
//             screen" instead.
//  • spin   — the wrist twist: angular velocity about the vertical over the
//             last 100 ms. A pendulum swing turns about a horizontal axis, so
//             anything about the vertical is the wrist. Counter-clockwise seen
//             from above (a right-hander's hook) = +, which hooks left.
//
// The twist needs care for the line and the speed: it turns the phone about
// the forearm, which is only vertical at the very bottom of the swing. Before
// and after it the forearm leans, and the twist gains a horizontal part along
// the line of travel — it would read as a swing across the body (and a faster
// swing), enough to send every hook into the gutter. measure() takes it out.
//
// The accelerometer is only used for the arm (the swing's centripetal pull).
// iOS reports acceleration with the opposite sign to the W3C spec (see
// swing.ts); comparing the reported gravity with the orientation's "up" tells
// which convention a sample uses.

import { qrot, type Vec3 } from './orient';

type Quat = [number, number, number, number]; // x y z w

export interface BowlSample {
  /** ms (performance.now()) */
  t: number;
  /** angular velocity in device axes, rad/s */
  rx: number;
  ry: number;
  rz: number;
  /** device→earth orientation quaternion at this sample, if known */
  q?: [number, number, number, number];
  /** acceleration without gravity, device axes, m/s², as the browser reports it */
  ax?: number;
  ay?: number;
  az?: number;
  /** accelerationIncludingGravity − acceleration, as reported (only its sign against "up" is used) */
  gx?: number;
  gy?: number;
  gz?: number;
}

export interface BowlThrow {
  /** ball speed, m/s (2.5 … 10.5) */
  speed: number;
  /** direction, radians (+ right), ±0.2: against the backswing, or the screen without one */
  angle: number;
  /** −1..1, + hooks left (counter-clockwise wrist twist seen from above) */
  spin: number;
  /** for tuning: peak swing rate, rad/s (swipe: upward px/ms) */
  peak: number;
  /** for tuning: mean twist about the vertical, rad/s (swipe: curve, rad) */
  twist: number;
  /** what the angle was measured against */
  ref: 'backswing' | 'screen' | null;
}

export interface SwipePoint {
  t: number;
  x: number;
  y: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** v with its part along the unit vector u taken out */
const without = (v: Vec3, u: Vec3): Vec3 => {
  const k = dot(v, u);
  return [v[0] - k * u[0], v[1] - k * u[1], v[2] - k * u[2]];
};

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

const N = 256; // ring buffer: the whole swing since the grip (≥ 2.5 s at 100 Hz)
/** shoulder → hand, metres */
export const ARM_LENGTH = 0.65;
const SPEED_WIN = 120; // ms before the release: the swing through the bottom
const AXIS_WIN = 300; // ms before the release: the forward swing, for its axis (the line)
const SPIN_WIN = 100; // ms before the release: the wrist twist
const TWIST_DEAD = 0.8; // rad/s about the vertical that is just a wobbly swing
const TWIST_NOISE = 0.3; // rad/s (rms per sample) of turning off the swing axis worth explaining as a twist
const TWIST_FULL = 6; // rad/s: a full hook
const MAX_ANGLE = 0.2;
const MIN_LINE = 1.5; // rad/s: slower than this the direction is mostly noise
const BACK_RATE = 1.5; // rad/s: a backswing is at least this fast…
const BACK_MS = 150; // …for at least this long
const BACK_TURN = 0.6; // rad: a bigger turn between backswing and release isn't a pull or a push
export const MIN_SPEED = 2.5;
export const MAX_SPEED = 10.5;
/** the arm's pendulum angle with the ball held up in front, looked at (the TV draws it at the chest) */
export const ARM_FRONT = 1.1;
export const ARM_MAX = 2.2;
const PULL_MEMORY = 0.35; // s: how long the arm's direction read from the swing's pull is trusted
const PULL_RATE = 1.8; // rad/s: slower swings pull too little to read

/**
 * Hand speed at the release (m/s) → ball speed (m/s). Linear through the
 * useful range — a relaxed swing (~7.5 rad/s ≈ 4.9 m/s at the hand) rolls at
 * ~6.6, a hard one (~12 rad/s) at ~9 — then eases into the ceiling. Even no
 * swing at all still rolls the ball gently.
 */
export function ballSpeed(hand: number): number {
  const lin = MIN_SPEED + 0.85 * Math.max(0, hand);
  const knee = 9;
  if (lin <= knee) return lin;
  const room = MAX_SPEED - knee;
  return knee + room * (1 - Math.exp(-(lin - knee) / room));
}

function twistToSpin(w: number): number {
  const a = Math.abs(w);
  return a <= TWIST_DEAD ? 0 : Math.sign(w) * Math.min(1, (a - TWIST_DEAD) / (TWIST_FULL - TWIST_DEAD));
}

export class BowlDetector {
  /** 0.75 = needs big swings … 1.35 = light swings roll just as fast (the remote's setting) */
  sensitivity = 1;
  /** calibrated heading of "towards the screen" in the earth frame (Orientation.heading) */
  heading: number | null = null;
  /** live horizontal angular speed (rad/s), for the swing meter */
  live = 0;

  // ring buffer: time, device-axis rates, the fused orientation, and our own
  // gyro-only orientation chain (see measure())
  private T = new Float64Array(N);
  private R = new Float64Array(N * 3);
  private Q = new Float64Array(N * 4);
  private HQ = new Uint8Array(N);
  private G = new Float64Array(N * 4);
  private head = 0;
  private count = 0;
  private lastT = 0;
  private gyro: Quat = [0, 0, 0, 1];
  private prevR: Vec3 = [0, 0, 0];
  private prevWx = 0;
  private prevWh = 0;
  private lastQ: Quat | null = null;

  private held = false;
  private tGrip = 0;
  private armAngle = 0;
  // the arm (hand → shoulder) in device axes as the swing's pull shows it,
  // summed with recent readings counting most, and how much there is of it
  private fore: Vec3 = [0, 0, 0];
  private foreW = 0;
  private pulls: { t: number; w: Vec3; a: Vec3 }[] = [];

  /**
   * Forget the motion so far: for when the detector has been left unfed (the phone was in another
   * sport) and its ring holds old motion. A fresh detector, as it were.
   */
  reset() {
    this.count = 0;
    this.head = 0;
    this.lastT = 0;
    this.gyro = [0, 0, 0, 1];
    this.prevR = [0, 0, 0];
    this.prevWx = this.prevWh = 0;
    this.live = 0;
    this.lastQ = null;
    this.held = false;
    this.tGrip = 0;
    this.armAngle = 0;
    this.fore = [0, 0, 0];
    this.foreW = 0;
    this.pulls = [];
  }

  /** the grip is down (the ball is in the hand) */
  get gripping() {
    return this.held;
  }

  /** the arm's pendulum angle while gripping, radians: 0 hanging, + forward/up, − behind */
  get arm() {
    return this.armAngle;
  }

  private idx(back: number) {
    return (this.head - 1 - back + N * 4) % N;
  }

  /** earth → player frame (Orientation.toPlayer) */
  private toPlayer(v: Vec3): Vec3 {
    const h = this.heading ?? 0;
    const fx = Math.sin(h),
      fy = Math.cos(h);
    return [v[0] * fy - v[1] * fx, v[0] * fx + v[1] * fy, v[2]];
  }

  /** the arm (hand → shoulder) in device axes, once the swing has shown it clearly */
  private foreArm(): Vec3 | null {
    // enough of it, and the readings agree
    if (this.foreW < 0.4 || Math.hypot(...this.fore) < 0.7 * this.foreW) return null;
    return unit(this.fore);
  }

  push(s: BowlSample) {
    const dt = this.lastT ? clamp((s.t - this.lastT) / 1000, 0, 0.05) : 0;
    // gyro-only orientation: exact rotation per step at the interval's mean
    // rate (as Orientation.integrate)
    const mx = (s.rx + this.prevR[0]) / 2,
      my = (s.ry + this.prevR[1]) / 2,
      mz = (s.rz + this.prevR[2]) / 2;
    const w = Math.hypot(mx, my, mz);
    if (w * dt > 1e-9) {
      const sn = Math.sin((w * dt) / 2) / w;
      const g = qmul(this.gyro, [mx * sn, my * sn, mz * sn, Math.cos((w * dt) / 2)]);
      const l = Math.hypot(g[0], g[1], g[2], g[3]);
      this.gyro = [g[0] / l, g[1] / l, g[2] / l, g[3] / l];
    }
    this.prevR = [s.rx, s.ry, s.rz];

    let wx: number, wy: number;
    if (s.q) [wx, wy] = this.toPlayer(qrot(s.q, [s.rx, s.ry, s.rz]));
    else {
      // no orientation yet: all we can tell is how fast it turns
      wx = Math.hypot(s.rx, s.ry, s.rz);
      wy = 0;
    }

    if (this.held && s.q) {
      // the arm turns with the phone: integrate the rate about the lateral
      // axis (trapezoid from the grip or the previous sample)…
      const from = Math.max(this.lastT, this.tGrip);
      const span = clamp((s.t - from) / 1000, 0, 0.05);
      const w0 = this.lastT && this.lastT >= this.tGrip - 50 ? this.prevWx : wx;
      this.armAngle = clamp(this.armAngle + ((w0 + wx) / 2) * span, -ARM_MAX, ARM_MAX);
      // …and let the swing's pull say where it really is
      this.armFromPull(s, span);
    }
    if (s.q) this.lastQ = [s.q[0], s.q[1], s.q[2], s.q[3]];

    const i = this.head;
    this.T[i] = s.t;
    this.R.set([s.rx, s.ry, s.rz], i * 3);
    if (s.q) {
      this.Q.set(s.q, i * 4);
      this.HQ[i] = 1;
    } else this.HQ[i] = 0;
    this.G.set(this.gyro, i * 4);
    this.head = (this.head + 1) % N;
    this.count = Math.min(N, this.count + 1);

    const wh = Math.hypot(wx, wy);
    this.live = 0.6 * wh + 0.4 * this.prevWh;
    this.prevWh = wh;
    this.prevWx = wx;
    this.lastT = s.t;
  }

  /**
   * Where the arm is at the grip, from how the phone is held — a guess, which
   * the swing corrects. The screen turned up or towards the face: held out in
   * front to be looked at (the ball at the chest). Otherwise by the phone's
   * top: pointing down, it lies along the fingers and the arm follows it
   * (straight down = hanging, tipped forwards or back = the arm swung that
   * way); pointing up, it points up the arm, the same the other way round;
   * about level: held out in front.
   */
  private armGuess(q: Quat): number {
    const n = this.toPlayer(qrot(q, [0, 0, 1]));
    const top = this.toPlayer(qrot(q, [0, 1, 0]));
    const facing = this.heading === null ? n[2] : Math.max(n[2], (n[2] - n[1]) / Math.SQRT2);
    if (facing > 0.35 || Math.abs(top[2]) < 0.3) return ARM_FRONT;
    return clamp(top[2] < 0 ? Math.atan2(top[1], -top[2]) : Math.atan2(-top[1], top[2]), -ARM_MAX, ARM_MAX);
  }

  /**
   * A swinging arm pulls the hand towards the shoulder (centripetal, s²·R) and
   * pushes it along as it speeds up (ṡ·R): a = R·(s²·u − ṡ·(L × u)), with L
   * the swing's axis and u the arm (hand → shoulder). So while the arm swings,
   * the accelerometer shows which way the arm runs through the phone — fixed,
   * as the phone sits rigidly in the hand — and with the orientation, where
   * the arm is. The guess from the grip gives way to it within a fraction of
   * a second of swinging.
   */
  private armFromPull(s: BowlSample, dt: number) {
    const keep = Math.exp(-dt / PULL_MEMORY);
    this.fore = [this.fore[0] * keep, this.fore[1] * keep, this.fore[2] * keep];
    this.foreW *= keep;
    const q = s.q!;
    if (s.ax !== undefined && s.gx !== undefined) {
      // which sign convention: the reported gravity points up (W3C) or down (iOS)
      const up = qrot(qconj(q), [0, 0, 1]);
      const gu = s.gx * up[0] + (s.gy ?? 0) * up[1] + (s.gz ?? 0) * up[2];
      if (Math.abs(gu) > 4) {
        const sg = gu > 0 ? 1 : -1;
        this.pulls.push({ t: s.t, w: [s.rx, s.ry, s.rz], a: [sg * s.ax, sg * (s.ay ?? 0), sg * (s.az ?? 0)] });
        if (this.pulls.length > 3) this.pulls.shift();
        if (this.pulls.length === 3) this.readPull();
      }
    }
    // follow the arm the pull shows: quickly, but without a visible jump
    const f = this.foreArm();
    if (f) {
      const u = this.toPlayer(qrot(q, f));
      const target = Math.atan2(-u[1], u[2]);
      const k = (1 - Math.exp(-dt / 0.05)) * Math.min(1, this.foreW / 0.4);
      // at about the pace the arm is already moving: a correction made
      // mid-swing doesn't show as a jump
      const lim = (4 + 2 * Math.hypot(s.rx, s.ry, s.rz)) * dt;
      this.armAngle = clamp(this.armAngle + clamp((target - this.armAngle) * k, -lim, lim), -ARM_MAX, ARM_MAX);
    }
  }

  /** the middle of the last three samples: its swing axis, its pull, and (from its neighbours) how fast the swing sped up */
  private readPull() {
    const [p0, p1, p2] = this.pulls;
    const f = this.foreArm();
    // the swing, less any twist about the arm found so far
    const swing = (w: Vec3) => (f ? without(w, f) : w);
    const w1 = swing(p1.w);
    const sp = Math.hypot(...w1);
    const span = (p2.t - p0.t) / 1000;
    const am1 = Math.hypot(...p1.a);
    // not where an 8 g accelerometer may have run out of range
    if (sp < PULL_RATE || span <= 0 || am1 < 1 || Math.max(Math.abs(p1.a[0]), Math.abs(p1.a[1]), Math.abs(p1.a[2])) > 70) return;
    // A clean swing turns square to its pull (the pull up the arm and the push
    // along the swing both lie in the swing's plane, however fast it speeds
    // up): if it doesn't, there's a twist the arm estimate hasn't caught, or
    // the body lurched — skip it.
    if (Math.abs(dot(w1, p1.a)) > 0.2 * sp * am1) return;
    const L: Vec3 = [w1[0] / sp, w1[1] / sp, w1[2] / sp];
    const sd = (Math.hypot(...swing(p2.w)) - Math.hypot(...swing(p0.w))) / span;
    const ap = without(p1.a, L); // the pull, in the swing's plane
    const am = Math.hypot(...ap);
    // an arm's worth of pull (0.25–1.3 m from the shoulder), not the body lurching
    const r = am / Math.hypot(sp * sp, sd);
    if (am < 2.5 || r < 0.25 || r > 1.3) return;
    // â = cos φ·u + sin φ·(L × u), φ = atan2(−ṡ, s²): turn it back by φ
    const ph = Math.atan2(-sd, sp * sp);
    const ah: Vec3 = [ap[0] / am, ap[1] / am, ap[2] / am];
    const x = cross(L, ah);
    const c = Math.cos(ph),
      sn = Math.sin(ph);
    const wgt = sp * sp * (span / 2);
    for (let k = 0; k < 3; k++) this.fore[k] += (ah[k] * c - x[k] * sn) * wgt;
    this.foreW += wgt;
  }

  /** The grip went down: the ball is picked up. */
  grip(t = this.lastT) {
    this.held = true;
    this.tGrip = t;
    this.armAngle = this.lastQ ? this.armGuess(this.lastQ) : 0;
    this.fore = [0, 0, 0];
    this.foreW = 0;
    this.pulls = [];
  }

  /** Drop the grip without throwing (e.g. the game left the bowling screen). */
  cancel() {
    this.held = false;
  }

  /** The grip was let go at time t (ms): the throw. */
  release(t = this.lastT): BowlThrow {
    this.held = false;
    return this.measure(t);
  }

  /** What letting go at time t would throw, without changing any state. */
  measure(t = this.lastT): BowlThrow {
    const { T, R, Q, HQ, G } = this;
    // the samples since the grip (at least the last 300 ms), newest first; the
    // first n are the forward swing's
    const since = this.tGrip ? this.tGrip - 50 : -Infinity;
    const from = Math.min(t - AXIS_WIN, since);
    const all: number[] = [];
    let n = 0;
    for (let b = 0; b < this.count; b++) {
      const j = this.idx(b);
      if (T[j] > t) continue;
      if (T[j] < from) break;
      all.push(j);
      if (t - T[j] <= AXIS_WIN) n = all.length;
    }
    if (!n) return { speed: MIN_SPEED, angle: 0, spin: 0, peak: 0, twist: 0, ref: null };
    const q4 = (A: Float64Array, j: number): Quat => [A[j * 4], A[j * 4 + 1], A[j * 4 + 2], A[j * 4 + 3]];

    // Device → player orientation of every sample. The fused orientation of
    // the newest sample anchors it and the others follow by the gyro alone:
    // the fused one is pulled towards the OS's reading, which runs a little
    // late — fine for where the phone points, but it bends the turn from one
    // sample to the next, which is what the twist and the backswing's line
    // are measured against.
    const h = this.heading ?? 0;
    const turn: Quat = [0, 0, Math.sin(h / 2), Math.cos(h / 2)]; // earth → player
    const anchor = HQ[all[0]] ? qmul(turn, qmul(q4(Q, all[0]), qconj(q4(G, all[0])))) : null;
    const P: Quat[] = [];
    const W: Vec3[] = [];
    for (const j of all) {
      const r: Vec3 = [R[j * 3], R[j * 3 + 1], R[j * 3 + 2]];
      if (anchor) {
        const p = qmul(anchor, q4(G, j));
        P.push(p);
        W.push(qrot(p, r));
      } else {
        // no orientation: only the rate is known — a straight throw at that speed
        P.push([0, 0, 0, 1]);
        W.push([Math.hypot(...r), 0, 0]);
      }
    }

    // the fastest sample: the swing's rough direction, to fold the backswing onto
    let fast = 0,
      refX = 1,
      refY = 0;
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(W[i][0], W[i][1]);
      if (m > fast) {
        fast = m;
        refX = W[i][0];
        refY = W[i][1];
      }
    }

    // The phone sits rigidly in the hand and the twist turns it about the
    // forearm, so the forearm is one fixed direction in device axes. Given it,
    // the twist comes out of every sample exactly: what's left is the arm's
    // swing about a single axis. So search for the forearm direction that
    // leaves the cleanest single-axis swing (fit().res = what's left over).
    const free = (i: number, arm: Vec3 | null): Vec3 => {
      const w = W[i];
      if (!arm) return w;
      return without(w, qrot(P[i], arm));
    };
    // The fast part of the swing, round the bottom, decides: near the top the
    // arm is slow and other things happen (the plane turning for a pull, the
    // elbow settling) that aren't a swing or a twist.
    const weight = W.slice(0, n).map((w) => Math.min(1, Math.hypot(w[0], w[1]) / (0.5 * fast || 1)) ** 2);
    const fit = (arm: Vec3 | null) => {
      let sx = 0,
        sy = 0,
        sz = 0,
        m00 = 0,
        m01 = 0,
        m02 = 0,
        m11 = 0,
        m12 = 0,
        m22 = 0;
      for (let i = 0; i < n; i++) {
        const [vx, vy, vz] = free(i, arm);
        const k = weight[i];
        const f = (vx * refX + vy * refY >= 0 ? 1 : -1) * k; // backswing and forward swing agree
        sx += f * vx;
        sy += f * vy;
        sz += f * vz;
        m00 += k * vx * vx;
        m01 += k * vx * vy;
        m02 += k * vx * vz;
        m11 += k * vy * vy;
        m12 += k * vy * vz;
        m22 += k * vz * vz;
      }
      const sl = Math.hypot(sx, sy, sz) || 1;
      const ax = sx / sl,
        ay = sy / sl,
        az = sz / sl;
      // what's left once the turning about that one axis is taken out
      const res = m00 + m11 + m22 - (ax * ax * m00 + ay * ay * m11 + az * az * m22 + 2 * (ax * ay * m01 + ax * az * m02 + ay * az * m12));
      const hl = Math.hypot(ax, ay) || 1;
      return { res, lx: ax / hl, ly: ay / hl };
    };

    // Only when there is a twist to explain: with none, the plain fit is right
    // and the forearm's two extra degrees of freedom would just fit noise.
    const plain = fit(null);
    let best = plain;
    let arm: Vec3 | null = null;
    const nw = weight.reduce((a, b) => a + b, 0);
    if (anchor && fast > 1e-3 && plain.res > nw * TWIST_NOISE * TWIST_NOISE) {
      const back = qconj(P[0]);
      // Where to look: the forearm at the newest sample, in device axes, is
      // "up" turned th about the swing axis L (the arm th past the bottom —
      // −1.0 … +1.6 rad, late releases being the common ones) and leaning ps
      // out to the side (arms swing out past the hip; elbows bend):
      // u = cos ps·(cos th·z − sin th·(z × L)) + sin ps·L. A coarse scan of
      // that…
      const { lx, ly } = best;
      const at = (th: number, ps: number): Vec3 => {
        const c = Math.cos(ps),
          sn = Math.sin(ps),
          st = Math.sin(th);
        return qrot(back, [c * st * ly + sn * lx, -c * st * lx + sn * ly, c * Math.cos(th)]);
      };
      const grid: { th: number; ps: number; res: number }[] = [];
      for (let i = 0; i < 27; i++) for (let j = 0; j < 9; j++) grid.push({ th: -1 + i * 0.1, ps: -0.6 + j * 0.15, res: fit(at(-1 + i * 0.1, -0.6 + j * 0.15)).res });
      grid.sort((a, b) => a.res - b.res);
      // …then, from its three best separate spots, fit a quadratic to the
      // leftover on a small patch and jump to its bottom (Newton's method),
      // halving the step until it helps.
      const starts: typeof grid = [];
      for (const g of grid) {
        if (starts.length === 3) break;
        if (starts.every((s) => Math.abs(s.th - g.th) > 0.15 || Math.abs(s.ps - g.ps) > 0.2)) starts.push(g);
      }
      for (const st of starts) {
        let u = at(st.th, st.ps),
          cur = fit(u),
          h = 0.05;
        for (let it = 0; it < 8 && h > 0.003; it++) {
          // two directions across u, and the leftover on a 3×3 patch (a, b ∈ −h, 0, h)
          const e1 = unit(Math.abs(u[0]) < 0.9 ? [0, -u[2], u[1]] : [-u[2], 0, u[0]]);
          const e2 = cross(u, e1);
          const move = (a: number, b: number) => unit([u[0] + a * e1[0] + b * e2[0], u[1] + a * e1[1] + b * e2[1], u[2] + a * e1[2] + b * e2[2]]);
          const v = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === 1 && j === 1 ? cur.res : fit(move((i - 1) * h, (j - 1) * h)).res)));
          const ga = (v[2][1] - v[0][1]) / (2 * h),
            gb = (v[1][2] - v[1][0]) / (2 * h);
          const haa = (v[2][1] - 2 * v[1][1] + v[0][1]) / (h * h),
            hbb = (v[1][2] - 2 * v[1][1] + v[1][0]) / (h * h),
            hab = (v[2][2] - v[2][0] - v[0][2] + v[0][0]) / (4 * h * h);
          const det = haa * hbb - hab * hab;
          let moved = false;
          if (haa > 0 && det > 1e-12) {
            let da = -(hbb * ga - hab * gb) / det,
              db = -(haa * gb - hab * ga) / det;
            const len = Math.hypot(da, db);
            if (len > 3 * h) {
              da *= (3 * h) / len;
              db *= (3 * h) / len;
            }
            for (let k = 1; k >= 0.25 && !moved; k /= 2) {
              const cand = move(da * k, db * k);
              const f = fit(cand);
              if (f.res < cur.res) {
                cur = f;
                u = cand;
                moved = true;
              }
            }
          }
          if (!moved) {
            // no bowl here: the patch's lowest point, or look closer
            let bi = 1,
              bj = 1;
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (v[i][j] < v[bi][bj]) [bi, bj] = [i, j];
            if (bi !== 1 || bj !== 1) {
              u = move((bi - 1) * h, (bj - 1) * h);
              cur = fit(u);
            } else h /= 2;
          }
        }
        if (cur.res < best.res) {
          best = cur;
          arm = u;
        }
      }
      // it has to explain most of what was left, or it's fitting something else
      if (best.res > 0.5 * plain.res) {
        best = plain;
        arm = null;
      }
    }
    // A pull through the bottom turns the whole arm about the vertical, which
    // at the bottom the gyro can't tell from a twist of the wrist — with both,
    // the fit above can land on a wrong forearm. The swing's pull on the hand
    // can tell them apart (a pull moves the hand, a twist doesn't): unless the
    // two agree closely, it wins.
    const pulled = this.foreArm();
    if (arm && pulled && Math.abs(dot(arm, pulled)) < Math.cos(0.045)) {
      arm = pulled;
      best = fit(arm);
    }
    const { lx: Lx, ly: Ly } = best;

    // speed: the fastest swing about that axis in the last 120 ms (2-tap mean
    // against spikes)
    const along = (i: number) => {
      const v = free(i, arm);
      return Math.abs(v[0] * Lx + v[1] * Ly);
    };
    let peak = 0,
      peakT = t;
    for (let i = 0; i < n && t - T[all[i]] <= SPEED_WIN; i++) {
      const s = (along(i) + along(Math.min(i + 1, n - 1))) / 2;
      if (s > peak) {
        peak = s;
        peakT = T[all[i]];
      }
    }
    // The line: the swing plane's, from the bottom of the swing (its fastest
    // moment) to the release — a pull can still be turning it after the
    // bottom; before, the whole window mixes in the start of the forward
    // swing. The plane's line is square to the swing's axis (twist taken out),
    // so it doesn't matter where on the arc the hand was, or how far the arm
    // leans out: a straight pendulum is straight.
    let gx = 0,
      gy = 0;
    for (let i = 0; i < n; i++) {
      if (T[all[i]] < peakT - 25 && i > 1) break;
      const v = free(i, arm);
      const f = v[0] * Lx + v[1] * Ly >= 0 ? 1 : -1; // forwards, as the swing's axis says
      gx -= f * v[1];
      gy += f * v[0];
    }
    if (Math.hypot(gx, gy) < 1e-9) {
      gx = -Ly;
      gy = Lx;
    }

    // …measured against the player's own backswing: the swing before this one
    // that turned the other way, from the grip to its top, its direction of
    // travel folded forwards and speed-weighted. The heading cancels out, so a
    // straight pendulum reads 0 however stale the calibration; a pull or a
    // push across the body reads as an angle.
    let angle = 0;
    let ref: BowlThrow['ref'] = null;
    if (anchor && peak >= MIN_LINE) {
      const backswing = (twist: Vec3 | null) => {
        let bx = 0,
          by = 0,
          top = 0,
          first = -1,
          last = -1,
          quiet = 0;
        const vs: Vec3[] = [];
        for (let i = 0; i < all.length && T[all[i]] >= since; i++) {
          const v = free(i, twist);
          const s = v[0] * Lx + v[1] * Ly; // + forwards (as at the release), − backwards
          if (s < -0.3) {
            quiet = 0;
            if (first < 0) first = i;
            last = i;
            bx -= v[0];
            by -= v[1];
            top = Math.max(top, -s);
            vs.push(v);
          } else if (first >= 0 && ++quiet >= 3) break; // before the backswing began
        }
        // how cleanly it turned about the one (horizontal) axis: what's left off it
        const bl = Math.hypot(bx, by) || 1;
        let res = 0;
        for (const v of vs) res += v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - ((v[0] * bx + v[1] * by) / bl) ** 2;
        return { bx, by, top, res, ms: first >= 0 ? T[all[first]] - T[all[last]] : 0 };
      };
      // a twist that began before the top leaks into the backswing too: take
      // it out — if that leaves a cleaner swing (with none, the arm's small
      // error would only add its own)
      let bk = backswing(null);
      if (arm) {
        const b2 = backswing(arm);
        if (b2.res < 0.7 * bk.res) bk = b2;
      }
      const { bx, by, top } = bk;
      if (top >= BACK_RATE && bk.ms >= BACK_MS) {
        // clockwise from the backswing's direction of travel (−by, bx) to the release's (gx, gy)
        const d = -Math.atan2(-by * gy - bx * gx, -by * gx + bx * gy);
        if (Math.abs(d) <= BACK_TURN) {
          angle = clamp(d, -MAX_ANGLE, MAX_ANGLE);
          ref = 'backswing';
        }
      }
      // no real backswing (or something other than a swing): against the calibrated screen
      if (!ref && this.heading !== null) {
        angle = clamp(gy >= 0 ? Math.atan2(gx, gy) : Math.atan2(-gx, -gy), -MAX_ANGLE, MAX_ANGLE);
        ref = 'screen';
      }
    }

    // spin: the wrist twist about the vertical just before letting go
    let sz = 0,
      m = 0;
    for (let i = 0; i < n && t - T[all[i]] <= SPIN_WIN; i++) {
      sz += W[i][2];
      m++;
    }
    const twist = m ? sz / m : 0;

    const hand = peak * ARM_LENGTH * Math.sqrt(this.sensitivity);
    return { speed: ballSpeed(hand), angle, spin: twistToSpin(twist), peak, twist, ref };
  }
}

/**
 * No motion sensor: bowl by dragging up the grip pad and letting go. The
 * speed comes from how fast the finger was moving when it let go, the line
 * from the stroke's overall direction (softened: a thumb is never quite
 * straight), and the spin from the way it curved — bending left at the end
 * hooks left, like the ball's path seen from above.
 */
export function swipeThrow(pts: SwipePoint[]): BowlThrow {
  const still: BowlThrow = { speed: MIN_SPEED, angle: 0, spin: 0, peak: 0, twist: 0, ref: null };
  if (pts.length < 2) return still;
  let len = 0;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(len);
  }
  if (len < 30) return still; // a tap

  // the flick: finger velocity over the last ~80 ms (screen y grows downwards)
  const end = pts[pts.length - 1];
  let k = pts.length - 2;
  while (k > 0 && end.t - pts[k].t < 80) k--;
  const dt = Math.max(8, end.t - pts[k].t);
  const fvx = (end.x - pts[k].x) / dt,
    fvy = (end.y - pts[k].y) / dt;
  const up = Math.max(0, -fvy); // px/ms
  // ~1.5 px/ms is a relaxed flick (≈ a 6.3 m/s roll), ~3 a hard one
  const speed = ballSpeed(up * 3);

  // the line: start → end, so a stroke curving into the pocket aims at it
  const p0 = pts[0];
  const cx = end.x - p0.x,
    cy = p0.y - end.y;
  let angle = 0;
  if (up > 0.1 && cy > 0) {
    const dir = Math.atan2(cx, cy); // 0 = straight up, + = right
    const dead = 0.07;
    angle = Math.abs(dir) < dead ? 0 : clamp((dir - Math.sign(dir) * dead) * 0.3, -MAX_ANGLE, MAX_ANGLE);
  }

  // the curve: how far the stroke's last third turned from its first third
  const at = (f: number) => {
    const target = f * len;
    let i = 1;
    while (i < pts.length - 1 && cum[i] < target) i++;
    const s = cum[i] - cum[i - 1] > 0 ? (target - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * s, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * s };
  };
  const p1 = at(1 / 3),
    p2 = at(2 / 3);
  const d1x = p1.x - p0.x,
    d1y = p1.y - p0.y,
    d2x = end.x - p2.x,
    d2y = end.y - p2.y;
  // screen y points down, so a turn to the left has a negative cross product
  const turnLeft = -Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y);
  const dead = 0.14,
    full = 0.7;
  const spin = Math.abs(turnLeft) < dead ? 0 : clamp((turnLeft - Math.sign(turnLeft) * dead) / (full - dead), -1, 1);

  return { speed, angle, spin, peak: up, twist: turnLeft, ref: null };
}
