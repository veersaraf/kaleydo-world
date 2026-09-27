// Sword duel: slash and thrust detection from raw phone motion.
//
// The phone is the sword: its top is the blade, as the TV draws it
// (duel/types.ts aimFromPhone). Everything is measured in the player frame
// (x right, y towards the screen, z up) via the orientation quaternion, so it
// works however the phone sits in the hand — a hilt in a fist (top up or
// forward, screen to the face) or a TV remote (top at the screen, screen up).
//
//  • stroke  — the blade's own angular speed |ω × s| (s = the phone's top):
//              how fast the tip sweeps round the hand. A twist about the blade
//              moves nothing. A stroke fires once, as its speed peaks above
//              the threshold (confirmed a sample or two later: ~30 ms).
//  • dir     — which way the tip travels across the player's view: ω × s
//              projected on the view plane (x right, z up), summed over the
//              stroke up to the peak, weighted by speed² (the fast part
//              decides, however the stroke began) and by how far in front of
//              the player the blade is: the part in front, where the blow
//              lands. A windup behind the head (where the tip travels up and
//              over) or out to the side (where it travels towards the screen)
//              hardly counts.
//  • power   — from the peak speed: a gentle flick ≈ 0.25, a full swing 1.
//  • thrust  — a push towards the screen along the blade, from the
//              accelerometer (a leaky integral: the hand's velocity), with the
//              blade barely turning.
//
// Not attacks: slow aiming and angling the guard (too slow, or too smooth:
// a controlled turn builds up its speed gradually, a blow snaps), the recoil
// and the return to guard after a blow (a refractory period: the motion has
// to settle, the next blow can't peak within 250 ms, and for 1½ s only a blow
// at least two-thirds as hard as the last one counts), and anything while the
// guard is held (swinging then only angles the guard — as in Chambara, let go
// of the guard to attack).
//
// iOS reports acceleration with the opposite sign to the W3C spec (see
// swing.ts); comparing the reported gravity with the orientation's "up" tells
// which convention a sample uses (as bowl.ts does).

import { qrot, type Vec3 } from './orient';
import type { SwipePoint } from './bowl';

type Quat = [number, number, number, number]; // x y z w

export interface SwordSample {
  /** ms (performance.now()) */
  t: number;
  /** angular velocity in device axes, rad/s */
  rx: number;
  ry: number;
  rz: number;
  /** device→earth orientation quaternion at this sample, if known */
  q?: Quat;
  /** acceleration without gravity, device axes, m/s², as the browser reports it */
  ax?: number;
  ay?: number;
  az?: number;
  /** accelerationIncludingGravity, as the browser reports it */
  igx?: number;
  igy?: number;
  igz?: number;
}

export interface SwordStrike {
  kind: 'slash' | 'thrust';
  /** slash: which way the tip travelled across the player's view, radians (0 right, π/2 up, −π/2 down, ±π left); thrust: 0 */
  dir: number;
  /** 0..1 */
  power: number;
  /** ms: the peak of the stroke (slash: blade speed; thrust: push speed) */
  t: number;
  /** for tuning: peak blade speed, rad/s (thrust: push speed, m/s; swipe: px/ms) */
  peak: number;
  /** for tuning: how far the blade turned from the stroke's start to the decision, rad */
  sweep: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

const N = 128; // blade-speed history (≥ 1.2 s at 100 Hz): a stroke's rise

// slashes (rad/s of the blade; divided by the sensitivity setting)
const START = 2.5; // a stroke begins
const MIN_PEAK = 5.5; // the least a snappy stroke may peak at…
const RISE = 0.11; // …when it takes at most this long (s) from half speed to its peak; slower rises need proportionally more
const FLICK = 6.5; // a gentle flick: power 0.25
const FULL = 18; // a full swing: power 1 (÷ √sensitivity)
const CONFIRM = 0.9; // the peak is past once the speed is down to this much of it…
const CONFIRM_MS = 40; // …or this long without a new high
const MAX_STROKE = 900; // ms: longer than this without a peak isn't a blow
const MIN_SWEEP = 0.35; // rad the blade turns by the decision (a jolt doesn't)
const MIN_SEEN = 0.2; // rad the tip travels across the front of the view
const COHERENT = 0.55; // |Σ v| / Σ |v|: the stroke goes one way (not a scribble)
// after an attack
const GAP = 250; // ms: no two blows peak closer than this
const FOLLOW = 0.68; // for a while, the next blow has to be two-thirds as hard as the last…
const FOLLOW_HOLD = 800; // …for this long (ms)…
const FOLLOW_FADE = 700; // …then it fades out over this long
const SETTLE = 0.35; // the motion has settled once below this much of the last peak (and START)
const GUARD_GRACE = 40; // ms: a stroke that peaks this soon after letting go of the guard was the guard moving
// thrusts (m/s of the hand, from the accelerometer)
const TAU = 0.5; // s: leak of the integrated velocity (the accelerometer's bias would run away)
const PUSH_START = 0.35; // a push begins
// (the leak reads a push at ~85% of its true speed: these are as read)
const V_MIN = 0.85; // the least a thrust may reach (≈ 1 m/s; ÷ sensitivity)
const V_GENTLE = 1.1; // power 0.25 (a poke, ≈ 1.3 m/s)
const V_FULL = 2.5; // power 1 (≈ 3 m/s; ÷ √sensitivity)
const ROT_MAX = 3.5; // rad/s: a push with the blade turning faster than this is a swing
const PUSH_FWD = 0.55; // the push is within ~57° of the screen…
const PUSH_BLADE = 0.55; // …and of the blade…
const BLADE_FWD = 0.35; // …and the blade points at least this much towards the screen
const THRUST_GAP = 400; // ms between thrusts
const AFTER_SLASH = 300; // ms: no thrust peaks this soon after a slash (the arm is still moving)
/** a thrust counts as a slash this hard for the follow-up rule */
const THRUST_AS = 10;

/** a slash's power from its peak blade speed: a gentle flick ≈ 0.25, a full swing 1 */
export function slashPower(peak: number, sensitivity = 1): number {
  const flick = FLICK / sensitivity,
    full = FULL / Math.sqrt(sensitivity);
  return clamp(0.25 + (0.75 * (peak - flick)) / (full - flick), 0.1, 1);
}

function thrustPower(v: number, sensitivity = 1): number {
  const gentle = V_GENTLE / sensitivity,
    full = V_FULL / Math.sqrt(sensitivity);
  return clamp(0.25 + (0.75 * (v - gentle)) / (full - gentle), 0.1, 1);
}

export class SwordDetector {
  /** 0.75 = needs big swings … 1.35 = light swings count (the remote's setting) */
  sensitivity = 1;
  /** calibrated heading of "towards the screen" in the earth frame (Orientation.heading) */
  heading: number | null = null;
  /** sign relating accelerationIncludingGravity to true up when acceleration isn't reported (iOS: −1) */
  upSign = 1;
  onStrike: (s: SwordStrike) => void = () => {};
  /** live blade speed, rad/s (for the meter) */
  live = 0;

  private lastT = 0;
  private T = new Float64Array(N);
  private B = new Float64Array(N);
  private head = 0;
  private count = 0;

  // the stroke in progress
  private inStroke = false;
  private t0 = 0;
  private peak = 0;
  private tPeak = 0;
  private dx = 0;
  private dz = 0;
  private dabs = 0;
  private seen = 0;
  private sweep = 0;
  // the last attack
  private settled = true;
  private lastAt = -1e9;
  private lastP = 0;
  private lastSlashAt = -1e9;
  private lastThrustAt = -1e9;
  // the guard
  private guarding = false;
  private guardUpAt = -1e9;
  // the push in progress
  private vel: Vec3 = [0, 0, 0];
  private pushing = false;
  private vmax = 0;
  private tvmax = 0;
  private turned = false;
  private lastTurnAt = -1e9;
  private pushSettled = true;
  private gSign = 0;
  private igUp = 0;

  /** Forget the motion so far (e.g. the duel starts). */
  reset() {
    this.inStroke = false;
    this.settled = true;
    this.lastAt = this.lastSlashAt = this.lastThrustAt = -1e9;
    this.pushing = false;
    this.pushSettled = true;
    this.vel = [0, 0, 0];
  }

  /** The guard pad went down / up at time t (ms). While it's held, swings only angle the guard. */
  guard(down: boolean, t = this.lastT) {
    this.guarding = down;
    if (!down) this.guardUpAt = t;
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

  push(s: SwordSample) {
    const dt = this.lastT ? clamp((s.t - this.lastT) / 1000, 0.002, 0.05) : 1 / 60;
    this.lastT = s.t;
    if (!s.q) {
      // no orientation yet: no way to tell where the blade points
      this.live = 0;
      return;
    }
    const w = this.toPlayer(qrot(s.q, [s.rx, s.ry, s.rz]));
    const b = this.toPlayer(qrot(s.q, [0, 1, 0]));
    // the tip's velocity (per metre of blade) and the blade's angular speed
    const v = cross(w, b);
    const bw = Math.hypot(v[0], v[1], v[2]);
    this.T[this.head] = s.t;
    this.B[this.head] = bw;
    this.head = (this.head + 1) % N;
    this.count = Math.min(N, this.count + 1);
    this.live = 0.6 * bw + 0.4 * this.live;
    if (bw > ROT_MAX) this.lastTurnAt = s.t;
    this.slash(s.t, dt, v, bw, b);
    this.thrust(s, dt, b, bw);
  }

  private slash(t: number, dt: number, v: Vec3, bw: number, b: Vec3) {
    const k = this.sensitivity;
    const start = START / k;
    if (!this.settled) {
      // still the last blow (its follow-through, or a push's wobble)
      if (bw < Math.max(start, SETTLE * this.lastP)) this.settled = true;
      else return;
    }
    if (!this.inStroke) {
      if (bw <= start) return;
      this.inStroke = true;
      this.t0 = t;
      this.peak = 0;
      this.dx = this.dz = this.dabs = this.seen = this.sweep = 0;
    }
    // In front of the player (the blade pointing at the screen: b·y = 1) the
    // tip's travel across the view is the blow; behind the head or out to
    // the side it's the windup and hardly counts.
    const front = clamp((b[1] + 0.2) / 0.6, 0, 1);
    const vv = Math.hypot(v[0], v[2]);
    const wgt = bw * bw * front * dt;
    this.dx += v[0] * wgt;
    this.dz += v[2] * wgt;
    this.dabs += vv * wgt;
    this.seen += vv * front * dt;
    this.sweep += bw * dt;
    if (bw > this.peak) {
      this.peak = bw;
      this.tPeak = t;
    } else if (bw < CONFIRM * this.peak || t - this.tPeak >= CONFIRM_MS) {
      this.inStroke = false;
      this.decide();
      return;
    }
    if (t - this.t0 > MAX_STROKE) {
      // a steady spin, not a blow: let it calm down first
      this.inStroke = false;
      this.settled = false;
      this.lastP = this.peak;
    }
  }

  /** The stroke's peak is past: a blow? */
  private decide() {
    const k = this.sensitivity;
    const { peak, tPeak } = this;
    // A blow snaps: its speed builds up fast. Aiming and angling the guard
    // build it up gradually — a slower rise needs a proportionally faster peak.
    let tHalf = this.t0;
    for (let i = 0; i < this.count; i++) {
      const j = this.idx(i);
      if (this.T[j] > tPeak) continue;
      if (this.B[j] < 0.5 * peak || tPeak - this.T[j] > 600) {
        tHalf = this.T[j];
        break;
      }
    }
    const rise = (tPeak - tHalf) / 1000;
    let need = (MIN_PEAK / k) * Math.max(1, rise / RISE);
    // soon after a blow, only another hard one counts: the recoil and the
    // return to guard are weaker
    const since = tPeak - this.lastAt;
    if (since < GAP) return;
    if (since < FOLLOW_HOLD + FOLLOW_FADE) need = Math.max(need, FOLLOW * this.lastP * Math.min(1, (FOLLOW_HOLD + FOLLOW_FADE - since) / FOLLOW_FADE));
    if (peak < need || this.sweep < MIN_SWEEP || this.seen < MIN_SEEN) return;
    const d = Math.hypot(this.dx, this.dz);
    if (d < COHERENT * this.dabs) return;
    // no attacks with the guard up, nor a swing that was the guard still moving as it was let go
    if (this.guarding || tPeak < this.guardUpAt + GUARD_GRACE) return;
    this.lastAt = this.lastSlashAt = tPeak;
    this.lastP = peak;
    this.settled = false;
    this.onStrike({ kind: 'slash', dir: Math.atan2(this.dz, this.dx), power: slashPower(peak, k), t: tPeak, peak, sweep: this.sweep });
  }

  /** The hand's acceleration (gravity out, the W3C sense), device axes — whichever way the browser reports it. */
  private accel(s: SwordSample, q: Quat): Vec3 | null {
    const up = qrot(qconj(q), [0, 0, 1]);
    if (s.ax !== undefined && s.igx !== undefined) {
      // the reported gravity points up (W3C) or down (iOS)
      const gu = (s.igx - s.ax) * up[0] + ((s.igy ?? 0) - (s.ay ?? 0)) * up[1] + ((s.igz ?? 0) - (s.az ?? 0)) * up[2];
      if (Math.abs(gu) > 4) this.gSign = gu > 0 ? 1 : -1;
      const sg = this.gSign || this.upSign;
      return [sg * s.ax, sg * (s.ay ?? 0), sg * (s.az ?? 0)];
    }
    if (s.igx !== undefined) {
      // only with gravity (some Androids): take it out along the orientation's up;
      // at rest the reading along up says which convention this is
      const ig: Vec3 = [s.igx, s.igy ?? 0, s.igz ?? 0];
      this.igUp += (dot(ig, up) - this.igUp) * 0.02;
      const sg = Math.abs(this.igUp) > 4 ? Math.sign(this.igUp) : this.upSign;
      return [sg * ig[0] - 9.81 * up[0], sg * ig[1] - 9.81 * up[1], sg * ig[2] - 9.81 * up[2]];
    }
    if (s.ax !== undefined) return [this.upSign * s.ax, this.upSign * (s.ay ?? 0), this.upSign * (s.az ?? 0)];
    return null;
  }

  private thrust(s: SwordSample, dt: number, b: Vec3, bw: number) {
    const a = this.accel(s, s.q!);
    if (!a) return;
    const ap = this.toPlayer(qrot(s.q!, a));
    const keep = Math.exp(-dt / TAU);
    const vel = this.vel;
    for (let i = 0; i < 3; i++) vel[i] = vel[i] * keep + ap[i] * dt;
    const sp = Math.hypot(vel[0], vel[1], vel[2]);
    const k = this.sensitivity;
    // towards the screen, along the blade, the blade pointing that way too
    const ahead = sp > 1e-6 && vel[1] >= PUSH_FWD * sp && dot(vel, b) >= PUSH_BLADE * sp && b[1] >= BLADE_FWD;
    if (!this.pushing) {
      if (!this.pushSettled) {
        if (sp < 0.3) this.pushSettled = true;
        else return;
      }
      if (sp > PUSH_START && ahead) {
        this.pushing = true;
        this.vmax = sp;
        this.tvmax = s.t;
        // (a blade that was turning just before is a swing's follow-through)
        this.turned = s.t - this.lastTurnAt < 120;
      }
      return;
    }
    if (bw > ROT_MAX) this.turned = true;
    if (!ahead) {
      this.pushing = false;
      return;
    }
    if (sp > this.vmax) {
      this.vmax = sp;
      this.tvmax = s.t;
      return;
    }
    if (sp > 0.9 * this.vmax && s.t - this.tvmax < 60) return;
    // past the push's peak: the arm is reaching full stretch
    this.pushing = false;
    const t = this.tvmax;
    if (this.vmax < V_MIN / k || this.turned || this.guarding || t < this.guardUpAt + GUARD_GRACE) return;
    if (t - this.lastSlashAt < AFTER_SLASH || t - this.lastThrustAt < THRUST_GAP) return;
    this.pushSettled = false;
    this.lastAt = this.lastThrustAt = t;
    // a slash straight after has to be a real one (the pull back isn't)
    this.lastP = THRUST_AS;
    this.onStrike({ kind: 'thrust', dir: 0, power: thrustPower(this.vmax, k), t, peak: this.vmax, sweep: 0 });
  }
}

export type GuardLine = 'vertical' | 'horizontal' | 'rising' | 'falling' | 'forward';

/**
 * How the blade (s = the phone's top, player frame) lies across the player's
 * view, as a guard: its angle (radians, as SlashInput.dir: 0 = pointing
 * right, π/2 = up — the TV's bladeAngle()) and the line it makes: rising = ╱,
 * falling = ╲. Pointed at the screen it hardly shows: 'forward'.
 */
export function guardLine(s: Vec3): { angle: number; line: GuardLine } {
  const angle = Math.atan2(s[2], s[0]);
  if (Math.hypot(s[0], s[2]) < 0.35) return { angle, line: 'forward' };
  const deg = ((((angle * 180) / Math.PI) % 180) + 180) % 180; // a line: 0..180
  const line = deg < 22.5 || deg >= 157.5 ? 'horizontal' : deg < 67.5 ? 'rising' : deg < 112.5 ? 'vertical' : 'falling';
  return { angle, line };
}

/**
 * No motion sensor: slash by swiping. The direction is the stroke's (start to
 * end, screen up = up), the power how fast the finger went at its fastest; a
 * tap is a thrust. A short or scribbled stroke is nothing.
 */
export function swipeStrike(pts: SwipePoint[]): SwordStrike | null {
  if (!pts.length) return null;
  const a = pts[0],
    z = pts[pts.length - 1];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const len = cum[cum.length - 1];
  if (len < 14) return z.t - a.t <= 300 ? { kind: 'thrust', dir: 0, power: 0.5, t: z.t, peak: 0, sweep: 0 } : null;
  const dx = z.x - a.x,
    dy = z.y - a.y;
  if (len < 40 || Math.hypot(dx, dy) < 0.6 * len) return null;
  // the fastest ~50 ms of it, px/ms (never over less than 40 ms: the first
  // move often lands just after the press); a flick quicker than that, whole
  let fast = 0;
  for (let i = 1, j = 0; i < pts.length; i++) {
    while (j + 1 < i && pts[i].t - pts[j + 1].t >= 50) j++;
    const span = pts[i].t - pts[j].t;
    if (span >= 40) fast = Math.max(fast, (cum[i] - cum[j]) / span);
  }
  if (!fast) fast = len / Math.max(16, z.t - a.t);
  // ~0.6 px/ms is a gentle swipe, ~2.6 a hard flick
  const power = clamp(0.25 + (0.75 * (fast - 0.6)) / 2, 0.1, 1);
  return { kind: 'slash', dir: Math.atan2(-dy, dx), power, t: z.t, peak: fast, sweep: 0 };
}
