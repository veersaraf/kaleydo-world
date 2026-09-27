// Baseball's players: the batter, the pitcher and the catcher, each turning its
// state (types.ts) into a Pose for the tennis Rig. Conventions as in
// chars/anim.ts, duel/anim.ts and archery/anim.ts: root-local space, x right,
// y up, −z forward, unscaled (the rig scales the root by CHAR_SCALE × the
// look's height); + bodyPitch leans back, + headPitch looks up, + yaws turn to
// the left. hands[0] is the rig's racket hand: whatever sits in the racket slot
// (the bat, the pitcher's glove, the catcher's mitt: see gear.ts) is held there.
//
// THE BATTER stands side-on in the box, facing the plate, front shoulder to the
// pitcher. hands[0] is the top hand (a right-hander's right), which holds the
// bat at its origin (bat space: +y from the top hand up the barrel, see BAT);
// hands[1] is the bottom hand, just below it on the handle. Poses are written
// in the batter's own frame — A towards the pitcher, Pl towards the plate, U up
// — which is the same for both hands: the root turns side-on to the plate from
// either box, and the rig mirrors x. The swing is keyed on a progress θ (0 the
// load … 2 contact … 6 the finish) which a time warp runs through at the
// swing's pace, so the path and the timing are tuned apart. At θ = 2 — exactly
// t = SWING.contact — the sweet spot is on the aim.
//
// THE PITCHER faces +z on the rubber, glove in hands[0] (so Pose.handed is the
// throwing hand's opposite, as the archer's bow) and the ball in hands[1]. The
// windup is keyed on time; at t = DELIVERY.release the ball — which sits
// BALL_OUT out along the throwing arm from the hand — is exactly at the release
// point (field.ts).
//
// THE CATCHER squats behind the plate facing −z, the mitt in hands[0] (the left
// hand: Pose.handed −1) and the throwing hand hands[1]. At t = arrive the mitt's
// pocket (MITT.pocket, mitt space) is exactly on the ball.

import { newPose, type Pose, type EyeState, type MouthState } from '../chars/pose';
import { CHAR_SCALE, HIP, TORSO, HEAD } from '../chars/rig';
import type { Look } from '../chars/look';
import { clamp, lerp, smooth, damp, dampAngle, angleDiff, Rng, type V3 } from '../core/math';
import { FIELD, DELIVERY, SWING } from './field';
import type { BatterState, PitcherState, CatcherState, LookAt, PitchKind } from './types';

// ---------------------------------------------------------------- shared measurements

/**
 * The bat, in bat space (root units ≈ metres / 1.16): the top hand at the
 * origin, the barrel up +y. The gear builds it to these.
 */
export const BAT = {
  /** the knob's end */
  knob: -0.215,
  /** the bottom hand, just under the top one */
  bottom: -0.118,
  /** where the handle swells into the barrel, and the barrel's end */
  taper: 0.12,
  barrel: 0.35,
  tip: 0.66,
  /** the sweet spot: ~0.15 m from the end */
  sweet: 0.53,
  handleR: 0.017,
  barrelR: 0.038,
};

/** The swing's key moments, seconds from its start (contact is SWING.contact). */
export const SWING_KEYS = { lag: 0.075, contact: SWING.contact, extend: 0.2, roll: 0.25, over: 0.31, finish: 0.4 };

/** The load, seconds from its start: the front foot is up, then planted (the stride). */
export const LOAD = { lift: 0.17, plant: 0.36 };

/** A home run's bat flip: seconds into 'cheer' that the bat leaves the hands (the gear throws it). */
export const FLIP = { release: 0.26 };

/** The ball sits this far out along the pitcher's arm from the centre of the hand (root units). */
export const BALL_OUT = 0.07;

/** The catcher's mitt: the pocket's centre, in mitt space (the racket slot's: the hand at 0, fingers +y, pocket facing +z). */
export const MITT = { pocket: { x: 0, y: 0.075, z: 0.085 } };

/** The pitcher's glove: the pocket's centre, in glove space (as the mitt's). */
export const GLOVE = { pocket: { x: 0, y: 0.09, z: 0.07 } };

/**
 * The catcher's throw back to the pitcher, seconds into 'throw' — as game.ts
 * paces it (BASEBALL_TIMING.throwRelease, .toss, .throwEnd): the throwing hand
 * has the ball out of the mitt at `take`, lets it go at `release` (the game
 * flies it from there, a 'pitch' ball, to the pitcher's glove `flight` later),
 * and the throw's over at `end`.
 */
export const THROW = { take: 0.1, release: 0.3, flight: 0.7, end: 0.8 };

/**
 * Where the ball leaves the catcher's hand, from the catcher's feet (world
 * metres: x across, y up, z along) — game.ts's TOSS_FROM, (0.25, 1.55,
 * catcherZ − 0.15), with the catcher at x = 0.
 */
export const TOSS = { x: 0.25, y: 1.55, z: -0.15 };

/** The catcher's mask, seconds into 'watch': the hand has it, it's off. Back on, seconds into the crouch after a watch. */
export const MASK = { grab: 0.17, off: 0.34, on: 0.3 };

/** shoulder height above the body origin, the head's centre and its radius (as in Rig) */
const SH_Y = 0.47 * TORSO;
const HEAD_Y = 0.62 * TORSO + 0.3 * HEAD * 0.8;
/** the legs hang from the hips this far either side (as in Rig.apply) */
const HIP_X = 0.11;

/** Will this swing finish one-handed? (the top hand lets go: the big ones) */
export function oneHanded(power: number, lift: number) {
  return power >= 0.78 && lift > -0.35;
}

/**
 * How far the batter's top hand is off the bat while the bottom hand holds it
 * (0 = both hands on it): through a one-handed finish and back. The animator
 * and the gear (which then hangs the bat from the bottom hand) both use this.
 * `one` = the last swing was one-handed; `from` = the phase before this one.
 */
export function topHandOff(phase: BatterState['phase'], t: number, one: boolean, from: string) {
  if (!one) return 0;
  if (phase === 'swing') return smooth(clamp((t - 0.21) / 0.08));
  if (phase === 'watch') return from === 'swing' || from === 'watch' ? 1 : 0;
  // anything after: the top hand comes back to the bat
  if (from === 'swing' || from === 'watch') return 1 - smooth(clamp(t / 0.16));
  return 0;
}

/** A 'cheer' at the plate (after a swing) flips the bat; one while waiting (after 'idle') doesn't. */
export function flipsBat(from: string) {
  return from !== 'idle' && from !== '';
}

// ---------------------------------------------------------------- little vector kit

const V = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const set = (o: V3, x: number, y: number, z: number) => ((o.x = x), (o.y = y), (o.z = z), o);
const cp = (o: V3, a: V3) => set(o, a.x, a.y, a.z);
const lerpV = (o: V3, a: V3, b: V3, t: number) => set(o, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
const dampV = (o: V3, b: V3, lambda: number, dt: number) => lerpV(o, o, b, 1 - Math.exp(-lambda * dt));
const addS = (o: V3, a: V3, k: number) => set(o, o.x + a.x * k, o.y + a.y * k, o.z + a.z * k);
const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const deg = (d: number) => (d * Math.PI) / 180;
function norm(o: V3) {
  const l = Math.hypot(o.x, o.y, o.z);
  if (l < 1e-9) return false;
  o.x /= l;
  o.y /= l;
  o.z /= l;
  return true;
}
const wrap = (a: number) => angleDiff(0, a);

/** Rotate (x, y, z) by the body's YXZ Euler angles, as Rig.apply does (roll, then pitch, then yaw). */
function rot(o: V3, x: number, y: number, z: number, pitch: number, yaw: number, roll: number) {
  const cr = Math.cos(roll),
    sr = Math.sin(roll);
  let X = x * cr - y * sr,
    Y = x * sr + y * cr,
    Z = z;
  const cp2 = Math.cos(pitch),
    sp = Math.sin(pitch);
  const Y2 = Y * cp2 - Z * sp;
  Z = Y * sp + Z * cp2;
  Y = Y2;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const X2 = X * cy + Z * sy;
  Z = -X * sy + Z * cy;
  X = X2;
  return set(o, X, Y, Z);
}

/** The shoulder on side sx (+1 = root +x) of a body, exactly as Rig.apply places it. */
function shoulderAt(o: V3, sx: number, girth: number, body: V3, pitch: number, yaw: number, roll: number, squash = 1) {
  rot(o, (sx * 0.2 * girth) / Math.sqrt(squash), SH_Y * squash, 0, pitch, yaw, roll);
  return set(o, o.x + body.x, o.y + body.y, o.z + body.z);
}

/**
 * The racket slot's axes for a racketDir / racketFace, exactly as Rig.apply
 * builds them (Y = dir, Z = face made square to it, X = Y × Z); writes X, Y, Z.
 */
function slotAxes(dir: V3, face: V3, X: V3, Y: V3, Z: V3) {
  cp(Y, dir);
  norm(Y);
  cp(Z, face);
  addS(Z, Y, -(Z.x * Y.x + Z.y * Y.y + Z.z * Y.z));
  if (Z.x * Z.x + Z.y * Z.y + Z.z * Z.z < 1e-6) {
    set(Z, 0, 0, 1);
    addS(Z, Y, -Y.z);
  }
  norm(Z);
  set(X, Y.y * Z.z - Y.z * Z.y, Y.z * Z.x - Y.x * Z.z, Y.x * Z.y - Y.y * Z.x);
  norm(X);
}

const SX = V(),
  SY = V(),
  SZ = V();
/** A point in the racket slot's space (for a racketDir / racketFace), as an offset in root space. */
function slotAxesTo(dir: V3, face: V3, p: { x: number; y: number; z: number }, o: V3) {
  slotAxes(dir, face, SX, SY, SZ);
  return set(o, SX.x * p.x + SY.x * p.y + SZ.x * p.z, SX.y * p.x + SY.y * p.y + SZ.y * p.z, SX.z * p.x + SY.z * p.y + SZ.z * p.z);
}

/** Keep a face square to a direction (the rig does too; this keeps the damping sane). */
function ortho(d: V3, f: V3) {
  addS(f, d, -(f.x * d.x + f.y * d.y + f.z * d.z));
  if (norm(f)) return;
  set(f, 0, 0, 1);
  addS(f, d, -d.z);
  if (!norm(f)) set(f, 1, 0, 0);
}

// ---------------------------------------------------------------- splines

/** Catmull-Rom through uniformly spaced keys (ends held), at progress th (0 … keys − 1). */
function crAt(k: readonly number[], th: number) {
  const n = k.length;
  const i = Math.max(0, Math.min(n - 2, Math.floor(th)));
  const u = clamp(th - i);
  const p0 = k[Math.max(0, i - 1)],
    p1 = k[i],
    p2 = k[i + 1],
    p3 = k[Math.min(n - 1, i + 2)];
  const u2 = u * u,
    u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

function crAtV(o: V3, k: readonly V3[], th: number) {
  const n = k.length;
  const i = Math.max(0, Math.min(n - 2, Math.floor(th)));
  const u = clamp(th - i);
  const p0 = k[Math.max(0, i - 1)],
    p1 = k[i],
    p2 = k[i + 1],
    p3 = k[Math.min(n - 1, i + 2)];
  const u2 = u * u,
    u3 = u2 * u;
  const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  return set(o, f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

/**
 * A monotone time warp: progress 0, 1, 2 … at the knot times T, smooth between
 * (cubic Hermite, Fritsch–Butland slopes), starting at `m0` × the first
 * segment's pace and coming to rest at the last knot.
 */
function warp(T: readonly number[], t: number, m0 = 0.6) {
  const n = T.length;
  if (t <= T[0]) return 0;
  if (t >= T[n - 1]) return n - 1;
  let i = 0;
  while (i < n - 2 && t > T[i + 1]) i++;
  const sec = (k: number) => 1 / Math.max(1e-4, T[k + 1] - T[k]);
  const slope = (k: number) => {
    if (k === 0) return sec(0) * m0;
    if (k === n - 1) return 0;
    const a = sec(k - 1),
      b = sec(k);
    return (2 * a * b) / (a + b);
  };
  const h = T[i + 1] - T[i];
  const u = (t - T[i]) / h;
  const m1 = slope(i) * h,
    m2 = slope(i + 1) * h;
  const u2 = u * u,
    u3 = u2 * u;
  return i + (2 * u3 - 3 * u2 + 1) * 0 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * 1 + (u3 - u2) * m2;
}

// ---------------------------------------------------------------- the head, the face

/** Where a character's head points: at a world point (or a world yaw when there's none). */
interface Gaze {
  x: number;
  y: number;
  z: number;
  /** false: look along `yaw` (world, 0 = −z) and `pitch` instead */
  at: boolean;
  yaw: number;
  pitch: number;
}

const gaze = (): Gaze => ({ x: 0, y: 0, z: 0, at: false, yaw: 0, pitch: 0 });
function gazeAt(g: Gaze, l: LookAt | { x: number; y: number; z: number }) {
  if (!l) return false;
  g.at = true;
  g.x = l.x;
  g.y = l.y;
  g.z = l.z;
  return true;
}
function gazeDir(g: Gaze, yaw: number, pitch: number) {
  g.at = false;
  g.yaw = yaw;
  g.pitch = pitch;
}

/** Everything the three animators share: blinking, squash, the head's aim. */
class Base {
  pose: Pose = newPose();
  /** root units → metres */
  readonly scale: number;
  protected rng = new Rng();
  protected blinkAt = 0;
  protected blinkT = 0;
  protected squash = 1;
  protected squashV = 0;
  protected headYaw = 0;
  protected headPitch = 0;
  protected started = false;
  protected lastX = 0;
  protected lastZ = 0;
  protected walkVx = 0;
  protected walkVz = 0;
  protected walkPh = 0;
  protected tmp = V();
  /** the phase and its clock last frame: a clock that runs backwards is a rewind (a late swing takes the ball back) */
  private seenPhase = '';
  private seenT = 0;
  /** this frame's pose snaps to its targets instead of easing (after a rewind) */
  protected snapNow = false;

  /** Did the game just rewind this character's phase clock? (Then snap, don't ease back.) */
  protected rewound(phase: string, t: number) {
    const r = phase === this.seenPhase && t < this.seenT - 0.02;
    this.seenPhase = phase;
    this.seenT = t;
    this.snapNow = r;
    return r;
  }

  /** How far to ease towards a target this frame (all the way after a rewind). */
  protected ease(lambda: number, dt: number) {
    return this.snapNow ? 1 : 1 - Math.exp(-lambda * dt);
  }

  constructor(public look: Look) {
    this.scale = CHAR_SCALE * (look.height || 1);
    this.pose.body.y = HIP;
    this.blinkAt = this.rng.range(1, 3.5);
  }

  protected get girth() {
    return this.look.girth || 1;
  }

  /** The root's velocity in its own frame (the game moves it; a jump means a teleport, not a sprint). */
  protected measureWalk(x: number, z: number, dt: number) {
    const dx = x - this.lastX,
      dz = z - this.lastZ;
    this.lastX = x;
    this.lastZ = z;
    let vx = dx / dt,
      vz = dz / dt;
    if (vx * vx + vz * vz > 144) vx = vz = 0;
    const y = this.pose.yaw;
    const c = Math.cos(y),
      s = Math.sin(y);
    const lx = c * vx - s * vz,
      lz = s * vx + c * vz;
    const k = 1 - Math.exp(-10 * dt);
    this.walkVx += (lx - this.walkVx) * k;
    this.walkVz += (lz - this.walkVz) * k;
    const sp = Math.hypot(this.walkVx, this.walkVz);
    this.walkPh += ((sp * dt) / 0.9) * Math.PI * 2;
  }

  /** Stepping feet and a bob, along the way the root is moving. Returns how much it's walking (0..1). */
  protected walk(feet: [V3, V3], footPitch: [number, number], body: V3) {
    const sp = Math.hypot(this.walkVx, this.walkVz);
    const run = clamp((sp - 0.15) / 1.2);
    if (run <= 0) return 0;
    const dx = this.walkVx / sp,
      dz = this.walkVz / sp;
    for (let i = 0; i < 2; i++) {
      const ph = this.walkPh + i * Math.PI;
      const stride = Math.sin(ph) * 0.2 * run;
      feet[i].x += dx * stride;
      feet[i].z += dz * stride;
      feet[i].y = Math.max(feet[i].y, Math.max(0, Math.cos(ph)) * 0.1 * run);
      footPitch[i] = -Math.cos(ph) * 0.3 * run;
    }
    body.y += Math.abs(Math.sin(this.walkPh)) * 0.035 * run;
    return run;
  }

  /** The squash spring (landings, knocks): kick it with squashV. */
  protected spring(dt: number) {
    this.squashV += (1 - this.squash) * 180 * dt;
    this.squashV *= Math.exp(-14 * dt);
    this.squash += this.squashV * dt;
    return this.squash;
  }

  /** Aim the head (after the body's pose is set): at a world point, or along a world yaw/pitch. */
  protected aimHead(g: Gaze, dt: number, lam = 10, maxTurn = 1.75, roll = 0, t = 0) {
    const P = this.pose;
    let yaw = g.yaw,
      pitch = g.pitch;
    if (g.at) {
      // the head's centre, world (near enough: the body's lean moves it a little)
      rot(this.tmp, 0, HEAD_Y, 0, P.bodyPitch, P.bodyYaw, P.bodyRoll);
      const lx = (P.body.x + this.tmp.x) * this.scale,
        ly = (P.body.y + this.tmp.y) * this.scale + P.hop,
        lz = (P.body.z + this.tmp.z) * this.scale;
      const c = Math.cos(P.yaw),
        s = Math.sin(P.yaw);
      const hx = P.x + c * lx + s * lz,
        hz = P.z - s * lx + c * lz;
      const dx = g.x - hx,
        dy = g.y - ly,
        dz = g.z - hz;
      const flat = Math.hypot(dx, dz);
      yaw = Math.atan2(-dx, -dz);
      pitch = Math.atan2(dy, Math.max(0.25, flat));
    }
    const hy = wrap(yaw - P.yaw - P.bodyYaw);
    const turn = clamp(hy, -maxTurn, maxTurn);
    const hp = pitch - P.bodyPitch * Math.cos(turn) + P.bodyRoll * Math.sin(turn);
    const k = this.ease(lam, dt);
    this.headYaw = lerp(this.headYaw, turn, k);
    this.headPitch = lerp(this.headPitch, clamp(hp, -1.1, 0.9), k);
    P.headYaw = this.headYaw;
    P.headPitch = this.headPitch;
    P.headRoll = roll + Math.sin(t * 1.3) * 0.02;
  }

  protected face(t: number, dt: number, eyes: EyeState, mouth: MouthState, brow: number) {
    const P = this.pose;
    this.blinkT -= dt;
    if (t > this.blinkAt) {
      this.blinkT = 0.11;
      this.blinkAt = t + this.rng.range(1.8, 4.6);
    }
    const intense = eyes === 'happy' || eyes === 'focus' || eyes === 'closed' || eyes === 'wide';
    P.blink = this.blinkT > 0 && !intense ? 1 : 0;
    P.eyes = eyes;
    P.mouth = mouth;
    P.brow = damp(P.brow, brow, 12, dt);
  }
}

// ================================================================= the batter

interface BatTargets {
  rootYaw: number;
  body: V3;
  pitch: number;
  yaw: number;
  roll: number;
  feet: [V3, V3];
  footPitch: [number, number];
  /** the bat: the top hand's grip on it (its origin), and knob → tip */
  grip: V3;
  dir: V3;
  /** the top hand when it's off the bat, and how far off it is (0 = on) */
  top: V3;
  topOff: number;
  /** the bottom hand when it's off the bat, and how much it's on (1 = just under the top hand) */
  bottom: V3;
  both: number;
  lam: number;
  armLam: number;
  feetLam: number;
  hop: number;
  gaze: Gaze;
  eyes: EyeState;
  mouth: MouthState;
  brow: number;
  headRoll: number;
}

/** The swing's keys: progress θ = 0 … 6 (see SWING_KEYS). */
interface SwingKeys {
  T: number[];
  grip: V3[];
  psi: number[];
  eps: number[];
  /** the free top hand (a one-handed finish) */
  top: V3[];
  bodyA: number[];
  bodyPl: number[];
  bodyU: number[];
  phi: number[];
  pitch: number[];
  roll: number[];
  backA: number[];
  backPitch: number[];
  backY: number[];
  frontPitch: number[];
  one: boolean;
}

const K7 = () => [0, 0, 0, 0, 0, 0, 0];
const K7V = () => [V(), V(), V(), V(), V(), V(), V()];

/** the batter's feet: the back foot, the front foot in the stance and at the stride (A) */
const FEET = { back: -0.25, front: 0.25, stride: 0.45, pl: 0.03 };

/**
 * The batter's hands (the grip) and bat at rest in the stance and loaded, in
 * the batter's frame (A, Pl, U; ψ, ε as in bat()): by the back shoulder, clear
 * of the head (the rig's head is big: its centre ~1.2 up, 0.26 round).
 */
const STANCE = { A: -0.24, Pl: 0.18, U: 0.96, psi: deg(14), eps: deg(58) };
const LOADED = { A: -0.31, Pl: 0.15, U: 0.99, psi: deg(2), eps: deg(52) };

export class BatterAnimator extends Base {
  private h: 1 | -1;
  private phase: BatterState['phase'] | '' = '';
  private from: string = '';
  /** the last swing finished one-handed */
  private one = false;
  /** the pose when the phase began (the swing blends out of it; 'watch' holds the finish) */
  private snap = { body: V(), pitch: 0, yaw: 0, roll: 0, feet: [V(), V()] as [V3, V3], footPitch: [0, 0] as [number, number], grip: V(), dir: V(0, 1, 0), top: V(), bottom: V(), rootYaw: 0 };
  private lastJump = 0;
  private tg: BatTargets = {
    rootYaw: 0,
    body: V(0, HIP, 0),
    pitch: 0,
    yaw: 0,
    roll: 0,
    feet: [V(), V()],
    footPitch: [0, 0],
    grip: V(),
    dir: V(0, 1, 0),
    top: V(),
    topOff: 0,
    bottom: V(),
    both: 1,
    lam: 10,
    armLam: 14,
    feetLam: 12,
    hop: 0,
    gaze: gaze(),
    eyes: 'open',
    mouth: 'smile',
    brow: 0,
    headRoll: 0,
  };
  private sk: SwingKeys = {
    T: K7(),
    grip: K7V(),
    psi: K7(),
    eps: K7(),
    top: K7V(),
    bodyA: K7(),
    bodyPl: K7(),
    bodyU: K7(),
    phi: K7(),
    pitch: K7(),
    roll: K7(),
    backA: K7(),
    backPitch: K7(),
    backY: K7(),
    frontPitch: K7(),
    one: false,
  };
  /** the pose's bat right now: grip and direction (root space), and the top hand's offness */
  private grip = V();
  private dir = V(0, 1, 0);
  private offTop = 0;
  private both = 1;
  // scratch
  private a = V();
  private b = V();
  private c = V();
  private d = V();
  private contactB = V();

  constructor(
    public handed: 1 | -1,
    look: Look,
  ) {
    super(look);
    this.h = handed;
    this.pose.handed = handed;
  }

  /** The root's yaw in the box: side-on, facing the plate (a right-hander faces +x). */
  static stanceYaw(handed: 1 | -1) {
    return (-handed * Math.PI) / 2;
  }

  /** Where the bat's sweet spot is (root space), for the current pose. */
  sweetSpot(o: V3) {
    return set(o, this.grip.x + this.dir.x * BAT.sweet, this.grip.y + this.dir.y * BAT.sweet, this.grip.z + this.dir.z * BAT.sweet);
  }

  update(t: number, dt: number, s: BatterState): Pose {
    const P = this.pose;
    const T = this.tg;
    dt = Math.max(1e-4, Math.min(dt, 0.1));
    const h = (s.handed ?? this.handed) as 1 | -1;
    this.h = h;
    P.handed = h;
    P.x = s.x;
    P.z = s.z;
    P.holdingBall = false;
    P.tired = 0;
    P.legLift = 0;
    if (!this.started) this.first(s);
    this.measureWalk(s.x, s.z, dt);
    if (s.phase !== this.phase) this.enter(s);
    this.rewound(s.phase, s.t);

    // defaults: the stance in the box
    T.rootYaw = BatterAnimator.stanceYaw(h);
    T.lam = 10;
    T.armLam = 14;
    T.feetLam = 12;
    T.hop = 0;
    T.topOff = 0;
    T.both = 1;
    T.eyes = 'focus';
    T.mouth = 'flat';
    T.brow = 0.5;
    T.headRoll = 0;
    if (!gazeAt(T.gaze, s.look)) gazeAt(T.gaze, { x: 0, y: 1.55, z: FIELD.releaseZ });
    let hop: number | null = null;

    if (s.phase === 'swing') {
      this.swing(t, dt, s);
      return P;
    }

    switch (s.phase) {
      case 'stance':
        this.stance(T, t, s.t);
        break;
      case 'load':
        this.load(T, t, s.t);
        break;
      case 'watch':
        this.watch(T, t, s);
        break;
      case 'cheer':
        hop = this.cheer(T, t, s);
        break;
      case 'sad':
        this.sad(T, t, s);
        break;
      default:
        this.idle(T, t, s);
    }
    // the top hand back on the bat after a one-handed finish
    T.topOff = Math.max(T.topOff, topHandOff(s.phase, s.t, this.one, this.from));
    if (s.phase === 'idle') this.walk(T.feet, T.footPitch, T.body);

    // ------------------------------------------------ root and body
    const kr = this.ease(9, dt),
      kb = this.ease(T.lam, dt),
      kf = this.ease(T.feetLam, dt),
      ka = this.ease(T.armLam, dt);
    P.yaw = Number.isFinite(P.yaw) ? P.yaw + angleDiff(P.yaw, T.rootYaw) * kr : T.rootYaw;
    lerpV(P.body, P.body, T.body, kb);
    P.bodyPitch = lerp(P.bodyPitch, T.pitch, kb);
    P.bodyYaw = P.bodyYaw + angleDiff(P.bodyYaw, T.yaw) * kb;
    P.bodyRoll = lerp(P.bodyRoll, T.roll, kb);
    P.hop = hop ?? T.hop;
    P.squash = this.spring(dt);
    for (let i = 0; i < 2; i++) {
      lerpV(P.feet[i], P.feet[i], T.feet[i], kf);
      P.footPitch[i] = lerp(P.footPitch[i], T.footPitch[i], kf);
    }

    // ------------------------------------------------ the bat and the hands
    lerpV(this.grip, this.grip, T.grip, ka);
    lerpV(this.dir, this.dir, T.dir, ka);
    if (!norm(this.dir)) cp(this.dir, T.dir);
    this.offTop = T.topOff;
    this.both = lerp(this.both, T.both, ka);
    this.writeHands(T.top, T.bottom, this.snapNow ? 0 : T.armLam, dt);

    this.aimHead(T.gaze, dt, 10, 1.8, T.headRoll, t);
    this.face(t, dt, T.eyes, T.mouth, T.brow);
    return P;
  }

  /** hands[0] on the grip (or off it, at `top`), hands[1] just under it on the handle (or free at `bottom`); the bat along dir. */
  private writeHands(top: V3, bottom: V3, lam: number, dt: number) {
    const P = this.pose;
    const g = this.grip,
      d = this.dir;
    // the top hand: on the grip, or off it towards `top`
    if (this.offTop > 0) {
      lerpV(this.a, g, top, this.offTop);
      if (lam > 0) dampV(P.hands[0], this.a, lam * 1.4, dt);
      else cp(P.hands[0], this.a);
    } else cp(P.hands[0], g);
    // the bottom hand: under the top one, or free
    set(this.b, g.x + d.x * BAT.bottom, g.y + d.y * BAT.bottom, g.z + d.z * BAT.bottom);
    if (this.both >= 0.999) cp(P.hands[1], this.b);
    else {
      lerpV(this.c, bottom, this.b, this.both);
      if (lam > 0) dampV(P.hands[1], this.c, lam, dt);
      else cp(P.hands[1], this.c);
    }
    cp(P.racketDir, d);
    // the bat's round: its face only turns the grip tape's seam — keep it steady, towards the pitcher
    this.bDir(this.c, 1, 0, 0);
    ortho(d, this.c);
    cp(P.racketFace, this.c);
  }

  // ---------------------------------------------------------------- frames

  /** batter frame → root: A towards the pitcher, Pl towards the plate, U up */
  private bp(o: V3, A: number, Pl: number, U: number) {
    return set(o, -this.h * A, U, -Pl);
  }

  private bDir(o: V3, A: number, Pl: number, U: number) {
    set(o, -this.h * A, U, -Pl);
    norm(o);
    return o;
  }

  /** the bat's direction (root) from its azimuth ψ (from pointing at the catcher, round through the plate) and elevation ε */
  private bat(o: V3, psi: number, eps: number) {
    const ce = Math.cos(eps);
    return this.bDir(o, -Math.cos(psi) * ce, Math.sin(psi) * ce, Math.sin(eps));
  }

  /** chest turned φ towards the pitcher (0 = square to the plate), tilted ρ back towards the catcher, leaning `lean` over the plate */
  private chest(T: BatTargets, phi: number, rho: number, lean: number) {
    T.yaw = this.h * phi;
    T.roll = -this.h * rho;
    T.pitch = lean;
  }

  private feetAt(T: BatTargets, backA: number, frontA: number, frontY = 0) {
    const f = this.h > 0 ? 0 : 1;
    this.bp(T.feet[f], frontA, FEET.pl, frontY);
    this.bp(T.feet[1 - f], backA, FEET.pl, 0);
    T.footPitch[0] = T.footPitch[1] = 0;
  }

  // ---------------------------------------------------------------- phases

  private first(s: BatterState) {
    this.started = true;
    this.lastX = s.x;
    this.lastZ = s.z;
    const P = this.pose;
    const T = this.tg;
    this.h = s.handed;
    if (s.phase === 'idle') {
      P.yaw = s.yaw;
      this.idle(T, 0, s);
    } else {
      P.yaw = BatterAnimator.stanceYaw(s.handed);
      this.stance(T, 0, 1);
    }
    cp(P.body, T.body);
    P.bodyPitch = T.pitch;
    P.bodyYaw = T.yaw;
    P.bodyRoll = T.roll;
    for (let i = 0; i < 2; i++) cp(P.feet[i], T.feet[i]);
    cp(this.grip, T.grip);
    cp(this.dir, T.dir);
    this.both = T.both;
    cp(P.hands[1], T.bottom);
    this.writeHands(T.top, T.bottom, 0, 1);
  }

  private enter(s: BatterState) {
    const prev = this.phase;
    this.from = prev;
    this.phase = s.phase;
    const P = this.pose;
    const S = this.snap;
    cp(S.body, P.body);
    S.pitch = P.bodyPitch;
    S.yaw = P.bodyYaw;
    S.roll = P.bodyRoll;
    S.rootYaw = P.yaw;
    for (let i = 0; i < 2; i++) {
      cp(S.feet[i], P.feet[i]);
      S.footPitch[i] = P.footPitch[i];
    }
    cp(S.grip, this.grip);
    cp(S.dir, this.dir);
    cp(S.top, P.hands[0]);
    cp(S.bottom, P.hands[1]);
    if (s.phase === 'swing') {
      this.one = oneHanded(s.power, s.lift);
      this.squashV -= 0.25;
    }
    if (s.phase === 'sad') this.squashV -= 0.5;
    if (s.phase === 'cheer') this.squashV += 0.4;
    this.lastJump = 0;
  }

  /** Ready in the box: knees bent, hands up by the back shoulder, the bat cocked up and back, a waggle. */
  private stance(T: BatTargets, t: number, since: number) {
    const wag = Math.sin(t * 8.2);
    const wag2 = Math.sin(t * 8.2 + 1.3);
    const settle = smooth(clamp(since / 0.5));
    const bob = Math.sin(t * 4.1) * 0.006;
    this.feetAt(T, FEET.back, FEET.front);
    this.bp(T.body, -0.02, 0, HIP - 0.07 + bob);
    this.chest(T, -0.14, 0.02, -0.16);
    this.bp(T.grip, STANCE.A + wag * 0.01, STANCE.Pl, STANCE.U + wag2 * 0.012 + bob);
    this.bat(T.dir, STANCE.psi + deg(8) * wag * settle, STANCE.eps + deg(6) * wag2 * settle);
    T.both = 1;
    T.armLam = 12;
    T.eyes = 'focus';
    T.mouth = 'flat';
    T.brow = 0.55;
  }

  /** The pitch is coming: the weight back and the front foot up, then the stride — the hands staying back. */
  private load(T: BatTargets, t: number, u: number) {
    const u1 = smooth(clamp(u / LOAD.lift));
    const u2 = smooth(clamp((u - LOAD.lift) / (LOAD.plant - LOAD.lift)));
    // held at the plant: a little more coil as it waits
    const hold = smooth(clamp((u - LOAD.plant) / 0.5));
    const frontA = lerp(lerp(FEET.front, FEET.front - 0.08, u1), FEET.stride, u2);
    const frontY = 0.075 * Math.max(0, u1 - u2);
    this.feetAt(T, FEET.back, frontA, frontY);
    const f = this.h > 0 ? 0 : 1;
    T.footPitch[f] = -0.35 * Math.max(0, u1 - u2);
    this.bp(T.body, lerp(lerp(-0.02, -0.075, u1), 0.0, u2), 0, HIP - lerp(lerp(0.065, 0.075, u1), 0.085, u2));
    this.chest(T, lerp(lerp(-0.14, -0.5, u1), -0.47, u2) - 0.03 * hold, 0.03, -0.16);
    this.bp(T.grip, lerp(STANCE.A, LOADED.A, u1) - 0.02 * hold, lerp(STANCE.Pl, LOADED.Pl, u1), lerp(STANCE.U, LOADED.U, u1));
    this.bat(T.dir, lerp(STANCE.psi, LOADED.psi, u1), lerp(STANCE.eps, LOADED.eps, u1));
    T.both = 1;
    T.lam = 14;
    T.armLam = 14;
    T.feetLam = 20;
    T.eyes = 'focus';
    T.mouth = 'flat';
    T.brow = 0.8;
  }

  /** The swing's keys for this state (aim, lift, power): see the top of the file. */
  private keys(s: BatterState) {
    const K = this.sk;
    const h = this.h,
      sc = this.scale;
    const power = clamp(s.power);
    const lift = clamp(s.lift, -1, 1);
    // the contact point in the batter's frame
    const cA = -(FIELD.contactZ - s.z) / sc;
    const cPl = (h * (s.aimX - s.x)) / sc;
    const cU = s.aimY / sc;
    set(this.contactB, cA, cPl, cU);
    // inside (+) or outside (−) of the middle of the plate
    const mid = (h * (0 - s.x)) / sc;
    const inside = clamp((mid - cPl) / 0.3, -1.6, 1.6);
    const high = clamp((cU - 0.72) / 0.25, -1.5, 1.5);
    // at contact: the barrel out front on the inside pitch, back on the outside one; a little below
    // the hands (these characters' shoulders are low: a steep bat would put the hands at the chin)
    const psiC = deg(98 + (inside > 0 ? 19 : 13) * inside);
    const uh = clamp(cU + 0.08 - 0.04 * lift, 0.62, 1.04);
    const epsC = Math.asin(clamp((cU - uh) / BAT.sweet, -0.8, 0.8)) - 0.06 * lift;
    const ce = Math.cos(epsC);
    const dA = -Math.cos(psiC) * ce,
      dPl = Math.sin(psiC) * ce,
      dU = Math.sin(epsC);
    // the barrel meets the ball face on: its axis is a ball's and a barrel's radius behind the ball's
    // centre, along the way the barrel's travelling (towards the pitcher, rising with an uppercut)
    const up = Math.tan(deg(5 + 11 * lift));
    let nA = 1 - dA * (dA + up * dU),
      nPl = -dPl * (dA + up * dU),
      nU = up - dU * (dA + up * dU);
    const nl = Math.hypot(nA, nPl, nU) || 1;
    const back = FIELD.ballR / sc + BAT.barrelR;
    nA /= nl;
    nPl /= nl;
    nU /= nl;
    const gA = cA - nA * back - dA * BAT.sweet,
      gPl = cPl - nPl * back - dPl * BAT.sweet,
      gU = cU - nU * back - dU * BAT.sweet;

    K.one = this.one;
    const T = K.T;
    T[0] = 0;
    T[1] = SWING_KEYS.lag + 0.012 * power;
    T[2] = SWING.contact;
    T[3] = SWING_KEYS.extend;
    T[4] = SWING_KEYS.roll;
    T[5] = SWING_KEYS.over;
    T[6] = SWING_KEYS.finish;

    // the hands: loaded, dropped into the slot (clear of that big head), contact, through the ball,
    // rolling over, up by the front shoulder
    set(K.grip[0], LOADED.A, LOADED.Pl, LOADED.U);
    set(K.grip[1], -0.1 + 0.02 * inside, 0.25, Math.min(0.93, gU + 0.1 - 0.06 * lift));
    set(K.grip[2], gA, gPl, gU);
    set(K.grip[3], gA + 0.15 + 0.03 * power, gPl + 0.02, gU + 0.05 + 0.11 * lift);
    // the barrel: laid back behind (ψ ≈ 0: pointing at the catcher), across the plate at contact,
    // at the pitcher through the ball, then round the far side and over the front shoulder
    K.psi[0] = LOADED.psi;
    K.psi[1] = deg(-10 - 12 * power);
    K.psi[2] = psiC;
    K.psi[3] = deg(170 + 8 * power);
    K.eps[0] = LOADED.eps;
    K.eps[1] = deg(15 - 8 * lift);
    K.eps[2] = epsC;
    K.eps[3] = deg(-3 + 14 * lift);
    // then round and up into a high finish: the hands come round well out in front of the chest
    // (the torso's chunky) and up by the front shoulder, the bat over it pointing up and back —
    // beside that big head, not behind it (a bat behind the neck would go through it, and hide)
    if (K.one) {
      // one-handed: the top hand lets go after the ball and the front arm takes the bat up high
      set(K.grip[4], 0.58, -0.04, 0.98);
      set(K.grip[5], 0.5, -0.2, 1.2);
      set(K.grip[6], 0.38, -0.3, 1.38);
      K.psi[4] = deg(238);
      K.psi[5] = deg(290);
      K.psi[6] = deg(322);
      K.eps[4] = deg(22);
      K.eps[5] = deg(46);
      K.eps[6] = deg(56);
    } else {
      set(K.grip[4], 0.58, -0.04, 0.95);
      set(K.grip[5], 0.48, -0.2, 1.08);
      set(K.grip[6], 0.36, -0.3, 1.18);
      K.psi[4] = deg(240);
      K.psi[5] = deg(292);
      K.psi[6] = deg(330);
      K.eps[4] = deg(12);
      K.eps[5] = deg(26);
      K.eps[6] = deg(40);
    }
    // the free top hand (one-handed): on the bat through the ball, then out in front and down
    cp(K.top[0], K.grip[0]);
    cp(K.top[1], K.grip[1]);
    cp(K.top[2], K.grip[2]);
    cp(K.top[3], K.grip[3]);
    set(K.top[4], 0.48, 0.2, 0.98);
    set(K.top[5], 0.42, 0.3, 0.9);
    set(K.top[6], 0.36, 0.32, 0.86);

    // the body: back on the load, the stride's plant, the hips leading, round to face the pitcher
    // the inside pitch: open up harder and clear the hips away from the plate, hands inside the ball
    const pin = clamp(inside, 0, 1.6);
    const phiC = 0.8 + (inside > 0 ? 0.28 : 0.16) * inside;
    const fin = 2.0 + 0.2 * power;
    const k = (a: number[], ...v: number[]) => v.forEach((x, i) => (a[i] = x));
    k(K.phi, -0.5, 0.04 + 0.12 * pin, phiC, 1.42 + 0.1 * pin, 1.72, 1.9, fin);
    k(K.bodyA, 0.0, 0.1, 0.16, 0.2, 0.22, 0.22, 0.21);
    // reaching for the outside pitch: the body shifts over the plate; backing off the inside one
    const reach = clamp(-inside, 0, 1.6) * 0.05;
    k(K.bodyPl, 0, 0.01 - 0.04 * pin, 0.02 + reach - 0.09 * pin, 0.02 + reach * 0.5 - 0.06 * pin, 0.01 - 0.02 * pin, 0, 0);
    // low pitches: sink; the front leg braces through the ball
    const sink = clamp(-high, 0, 1.5) * 0.02;
    k(K.bodyU, HIP - 0.085, HIP - 0.1 - sink, HIP - 0.075 - sink, HIP - 0.06, HIP - 0.05, HIP - 0.045, HIP - 0.04);
    k(K.pitch, -0.16, -0.18, -0.16 - reach - sink, -0.12, -0.07, -0.04, -0.02);
    k(K.roll, 0.03, 0.1, 0.19 + 0.06 * clamp(-high, 0, 1.5), 0.13, 0.06, 0.04, 0.03);
    // the back foot: up on its toe, turning in behind the hips
    k(K.backA, FEET.back, FEET.back + 0.01, FEET.back + 0.04, FEET.back + 0.08, FEET.back + 0.1, FEET.back + 0.11, FEET.back + 0.11);
    k(K.backPitch, 0, -0.08, -0.38, -0.62, -0.72, -0.75, -0.75);
    k(K.backY, 0, 0, 0.015, 0.03, 0.035, 0.036, 0.036);
    k(K.frontPitch, 0, 0, 0, 0.12, 0.12, 0.06, 0.05);
    // the body clears the bat through the zone (a chunky torso and a big head: on an inside pitch
    // the hips get out of the way), then every key but contact (exact: there the arms stretch if
    // they must) keeps the hands in reach
    for (const i of [1, 2, 3]) this.clearKey(K, i);
    for (const i of [1, 3, 4, 5, 6]) this.reachKey(K, i);
    return K;
  }

  /**
   * Move key i's body (A, Pl) so the bat — the handle and the lower barrel —
   * passes outside the torso, and the whole bat outside the head.
   */
  private clearKey(K: SwingKeys, i: number) {
    const g = this.girth;
    const psi = K.psi[i],
      eps = K.eps[i];
    const ce = Math.cos(eps);
    const dA = -Math.cos(psi) * ce,
      dPl = Math.sin(psi) * ce,
      dU = Math.sin(eps);
    const G = K.grip[i];
    // the torso: a round column up the spine (2D, in the batter's frame)
    const r = 0.3 * g;
    const s0 = BAT.knob,
      s1 = 0.36;
    let bA = K.bodyA[i],
      bPl = K.bodyPl[i];
    for (let pass = 0; pass < 2; pass++) {
      // closest point of the bat's lower part to the spine (only where it's below the shoulders)
      let best = Infinity,
        cx = 0,
        cy = 0;
      for (let k = 0; k <= 8; k++) {
        const s = s0 + ((s1 - s0) * k) / 8;
        const u = G.z + dU * s;
        if (u > K.bodyU[i] + SH_Y + 0.05) continue;
        const a = G.x + dA * s,
          p = G.y + dPl * s;
        const d = Math.hypot(a - bA, p - bPl);
        if (d < best) (best = d), (cx = a), (cy = p);
      }
      if (best >= r) break;
      const d = Math.max(1e-4, best);
      bA -= ((cx - bA) / d) * (r - d);
      bPl -= ((cy - bPl) / d) * (r - d);
    }
    // the head: its centre over the leaning body; keep the whole bat outside it
    const hr = 0.3 * HEAD + BAT.barrelR + 0.02;
    const lean = K.pitch[i];
    for (let pass = 0; pass < 2; pass++) {
      const hA = bA,
        hPl = bPl - Math.sin(lean) * HEAD_Y,
        hU = K.bodyU[i] + Math.cos(lean) * HEAD_Y;
      let best = Infinity,
        ca = 0,
        cp2 = 0,
        cu = 0;
      for (let k = 0; k <= 10; k++) {
        const s = 0.05 + ((BAT.tip - 0.05) * k) / 10;
        const a = G.x + dA * s,
          p = G.y + dPl * s,
          u = G.z + dU * s;
        const d = Math.hypot(a - hA, p - hPl, u - hU);
        if (d < best) (best = d), (ca = a), (cp2 = p), (cu = u);
      }
      if (best >= hr) break;
      // move the body (and the head on it) away, sideways only
      const ha = hA - ca,
        hp = hPl - cp2;
      const l = Math.hypot(ha, hp) || 1;
      const need = Math.sqrt(Math.max(0, hr * hr - (hU - cu) * (hU - cu))) - l;
      if (need <= 0) break;
      bA += (ha / l) * need;
      bPl += (hp / l) * need;
    }
    K.bodyA[i] = bA;
    K.bodyPl[i] = bPl;
  }

  /**
   * Pull key i's hands in until they're within an arm's length of their
   * shoulders at that key's body pose: the bottom hand (under the grip) from
   * the front shoulder, the top hand from the back one (or, off the bat, the
   * free top hand).
   */
  private reachKey(K: SwingKeys, i: number) {
    const h = this.h;
    const R = 0.5 * 1.02;
    const body = this.bp(this.a, K.bodyA[i], K.bodyPl[i], K.bodyU[i]);
    const yaw = h * K.phi[i],
      roll = -h * K.roll[i],
      pitch = K.pitch[i];
    const sBack = shoulderAt(this.b, h, this.girth, body, pitch, yaw, roll);
    const sFront = shoulderAt(this.c, -h, this.girth, body, pitch, yaw, roll);
    const D = this.bat(this.d, K.psi[i], K.eps[i]);
    const G = K.grip[i];
    const off = i >= 4 && K.one;
    for (let pass = 0; pass < 3; pass++) {
      // grip (root) and the bottom hand under it
      const gx = -h * G.x,
        gy = G.z,
        gz = -G.y;
      const bx = gx + D.x * BAT.bottom,
        by = gy + D.y * BAT.bottom,
        bz = gz + D.z * BAT.bottom;
      let mx = 0,
        my = 0,
        mz = 0;
      const d1 = Math.hypot(bx - sFront.x, by - sFront.y, bz - sFront.z);
      if (d1 > R) {
        const k = (d1 - R) / d1;
        mx += (sFront.x - bx) * k;
        my += (sFront.y - by) * k;
        mz += (sFront.z - bz) * k;
      }
      if (!off) {
        const d0 = Math.hypot(gx - sBack.x, gy - sBack.y, gz - sBack.z);
        if (d0 > R) {
          const k = (d0 - R) / d0;
          mx += (sBack.x - gx) * k;
          my += (sBack.y - gy) * k;
          mz += (sBack.z - gz) * k;
        }
      }
      if (mx === 0 && my === 0 && mz === 0) break;
      // root → batter frame: A = −h·x, Pl = −z, U = y
      G.x += -h * mx;
      G.y += -mz;
      G.z += my;
    }
    if (off) {
      // the free top hand, from the back shoulder
      const T = K.top[i];
      const tx = -h * T.x,
        ty = T.z,
        tz = -T.y;
      const d0 = Math.hypot(tx - sBack.x, ty - sBack.y, tz - sBack.z);
      if (d0 > R) {
        const k = (d0 - R) / d0;
        T.x += -h * (sBack.x - tx) * k;
        T.y += -(sBack.z - tz) * k;
        T.z += (sBack.y - ty) * k;
      }
    }
  }

  /** The swing: every part set exactly (no smoothing) so the sweet spot meets the ball at SWING.contact. */
  private swing(t: number, dt: number, s: BatterState) {
    const P = this.pose;
    const T = this.tg;
    const h = this.h;
    const K = this.keys(s);
    const u = s.t;
    const th = warp(K.T, u);
    // out of whatever pose the swing began in (normally the load's), over the first moments
    const blend = smooth(clamp(u / 0.06));
    const blendHands = smooth(clamp(u / 0.07));

    P.yaw = BatterAnimator.stanceYaw(h);
    // body
    const A = crAt(K.bodyA, th),
      Pl = crAt(K.bodyPl, th),
      U = crAt(K.bodyU, th);
    this.bp(this.a, A, Pl, U);
    lerpV(P.body, this.snap.body, this.a, blend);
    this.chest(T, crAt(K.phi, th), crAt(K.roll, th), crAt(K.pitch, th));
    P.bodyYaw = lerp(this.snap.yaw, T.yaw, blend);
    P.bodyPitch = lerp(this.snap.pitch, T.pitch, blend);
    P.bodyRoll = lerp(this.snap.roll, T.roll, blend);
    P.hop = 0;
    // feet: the front one planted at the stride, the back one pivoting
    const f = h > 0 ? 0 : 1;
    this.bp(this.b, FEET.stride, FEET.pl, 0);
    lerpV(P.feet[f], this.snap.feet[f], this.b, smooth(clamp(u / 0.045)));
    P.footPitch[f] = lerp(this.snap.footPitch[f], crAt(K.frontPitch, th), smooth(clamp(u / 0.045)));
    this.bp(this.b, crAt(K.backA, th), FEET.pl, crAt(K.backY, th));
    lerpV(P.feet[1 - f], this.snap.feet[1 - f], this.b, blend);
    P.footPitch[1 - f] = lerp(this.snap.footPitch[1 - f], crAt(K.backPitch, th), blend);
    // squash: a thump as the front foot lands, a jolt at contact
    if (u - dt < 0.05 && u >= 0.05) this.squashV -= 0.35;
    if (u - dt < SWING.contact && u >= SWING.contact) this.squashV -= 0.55 * (0.5 + s.power);
    // the squash would move the shoulders off the contact pose: keep it out of the way till then
    const sq = this.spring(dt);
    P.squash = u < SWING.contact + 0.02 ? 1 : sq;

    // the bat
    crAtV(this.c, K.grip, th);
    const gA = this.c.x,
      gPl = this.c.y,
      gU = this.c.z;
    this.bp(this.b, gA, gPl, gU);
    this.bat(this.d, crAt(K.psi, th), crAt(K.eps, th));
    lerpV(this.grip, this.snap.grip, this.b, blendHands);
    lerpV(this.dir, this.snap.dir, this.d, blendHands);
    if (!norm(this.dir)) cp(this.dir, this.d);
    // the top hand (one-handed): off the bat after the ball
    this.offTop = topHandOff('swing', u, K.one, this.from);
    crAtV(this.c, K.top, th);
    this.bp(T.top, this.c.x, this.c.y, this.c.z);
    this.both = 1;
    this.writeHands(T.top, T.bottom, 0, dt);

    // eyes on the ball till it's gone, then after it
    const cb = this.contactB;
    const sc = this.scale;
    const cwx = s.aimX,
      cwy = cb.z * sc,
      cwz = FIELD.contactZ;
    if (th < 2.9 || !s.look) gazeAt(T.gaze, { x: cwx, y: cwy, z: cwz });
    else gazeAt(T.gaze, s.look);
    this.aimHead(T.gaze, dt, th < 2.9 ? 22 : 9, 1.8, 0, t);
    const effort = th > 0.6 && th < 3.2;
    this.face(t, dt, effort ? 'focus' : th >= 3.2 ? 'wide' : 'focus', effort ? 'open' : th >= 3.2 ? 'o' : 'flat', effort ? 1 : 0.7);
  }

  /** After the swing, hold the finish and watch it go; after a take, relax out of the load and watch it in. */
  private watch(T: BatTargets, t: number, s: BatterState) {
    const S = this.snap;
    const u = s.t;
    const swung = this.from === 'swing';
    if (swung) {
      // hold the finish: the snapshot the swing ended in, breathing
      const br = Math.sin(t * 2.2) * 0.006;
      cp(T.body, S.body);
      T.body.y += br - 0.01 * smooth(clamp(u / 0.8));
      T.pitch = S.pitch;
      T.yaw = S.yaw;
      T.roll = S.roll;
      for (let i = 0; i < 2; i++) {
        cp(T.feet[i], S.feet[i]);
        T.footPitch[i] = S.footPitch[i];
      }
      cp(T.grip, S.grip);
      T.grip.y += br;
      cp(T.dir, S.dir);
      cp(T.top, S.top);
      T.both = 1;
      T.lam = 6;
      T.armLam = 6;
      T.feetLam = 6;
      T.eyes = 'wide';
      T.mouth = 'o';
      T.brow = 0.6;
    } else {
      // a take: the stride stays down, the hands come back to rest, eyes on the ball into the mitt
      const k = smooth(clamp(u / 0.5));
      this.feetAt(T, FEET.back, FEET.stride);
      this.bp(T.body, 0.02, 0, HIP - 0.07);
      this.chest(T, lerp(-0.36, -0.2, k), 0.03, -0.14);
      this.bp(T.grip, lerp(-0.27, -0.2, k), lerp(0.12, 0.2, k), lerp(1.04, 0.86, k));
      this.bat(T.dir, deg(lerp(2, 30, k)), deg(lerp(50, 62, k)));
      T.both = 1;
      T.lam = 8;
      T.armLam = 7;
      T.eyes = 'open';
      T.mouth = 'flat';
      T.brow = 0.3;
    }
    cp(T.bottom, S.bottom);
  }

  /**
   * A home run at the plate: flick the bat away (the gear lets go of it at
   * FLIP.release and sends it spinning), both arms up, a hop and a bounce,
   * turned to the field. Waiting your turn: jump with the bat held high.
   */
  private cheer(T: BatTargets, t: number, s: BatterState): number {
    const u = s.t;
    const h = this.h;
    const flip = flipsBat(this.from);
    // two hops, then a bounce
    const j0 = flip ? FLIP.release + 0.06 : 0.05;
    const v = u - j0;
    const air = v <= 0 ? 0 : v < 1.15 ? Math.max(0, Math.sin(v * Math.PI * 2.6)) : Math.abs(Math.sin(v * 5.4)) * 0.07;
    if (air < 0.02 && this.lastJump > 0.05) this.squashV -= 1.2;
    this.lastJump = air;
    const pump = v > 0.1 ? Math.sin(v * 11) * 0.05 : 0;
    if (flip && u < FLIP.release) {
      // the flick, still side-on and facing the pitcher from the finish: the bat swept down in
      // front, then up and away (off the plate's side) — the gear lets go at FLIP.release
      const k0 = smooth(clamp(u / 0.12));
      const k1 = smooth(clamp((u - 0.12) / (FLIP.release - 0.12)));
      this.feetAt(T, FEET.back + 0.1, FEET.stride);
      this.bp(T.body, 0.16, 0, HIP - 0.06 + 0.03 * k1);
      this.chest(T, 1.75, 0.02, 0.02 + 0.1 * k1);
      this.bp(this.a, 0.44, 0.08, 0.66);
      this.bp(this.b, 0.26, -0.2, 1.3);
      lerpV(T.grip, this.a, this.b, k1);
      this.bDir(this.c, 0.55, 0.15, -0.8);
      this.bDir(this.d, 0.2, -0.45, 0.87);
      lerpV(T.dir, this.c, this.d, k1);
      norm(T.dir);
      if (k0 < 1) {
        lerpV(T.grip, this.snap.grip, T.grip, k0);
        lerpV(T.dir, this.snap.dir, T.dir, k0);
        norm(T.dir);
      }
      T.both = 1;
      T.armLam = 30;
      T.lam = 14;
      gazeAt(T.gaze, { x: s.x, y: 1.4, z: s.z - 4 });
    } else {
      // turned to the field (the hero camera's out there) — in the air, on the first hop — or,
      // waiting, to where we're told
      T.rootYaw = flip ? 0 : s.yaw;
      // after the hops: a fist-pumping groove, one arm then the other, dipping and swaying into each
      const groove = v > 1.15 ? smooth(clamp((v - 1.15) / 0.2)) : 0;
      const ph = (v - 1.15) * ((Math.PI * 2) / 0.62);
      const pa = groove * Math.max(0, Math.sin(ph)),
        pb = groove * Math.max(0, -Math.sin(ph));
      set(T.body, 0, HIP + 0.01 - 0.03 * (pa + pb), 0);
      T.pitch = 0.1 - 0.06 * (pa + pb);
      T.yaw = h * 0.16 * (pa - pb);
      T.roll = -h * 0.07 * (pa - pb);
      set(T.feet[0], -HIP_X * 1.35, air * 0.08, 0.01);
      set(T.feet[1], HIP_X * 1.35, air * 0.08, 0.01);
      T.footPitch[0] = T.footPitch[1] = -0.4 * air;
      if (flip) {
        // both arms up, fists pumping (the bat's gone)
        set(T.top, h * 0.36, 1.66 + pump * (1 - groove) - 0.36 * pa, -0.08 - 0.12 * pa);
        set(T.bottom, -h * 0.36, 1.66 - pump * (1 - groove) - 0.36 * pb, -0.08 - 0.12 * pb);
        cp(T.grip, T.top);
        set(T.dir, 0, 1, 0);
        T.topOff = 1;
        T.both = 0;
        T.armLam = 16;
      } else {
        // the bat held up in the top hand, the other fist pumping
        set(T.grip, h * 0.34, 1.5 + pump * 0.6 * (1 - groove) - 0.2 * pa, -0.06);
        set(T.dir, h * 0.2, 1, 0.12);
        norm(T.dir);
        set(T.bottom, -h * 0.36, 1.55 - pump * (1 - groove) - 0.36 * pb, -0.1 - 0.12 * pb);
        T.both = 0;
        T.armLam = 14;
      }
      if (!gazeAt(T.gaze, s.look)) gazeDir(T.gaze, T.rootYaw, 0.15);
      T.lam = 9;
    }
    T.feetLam = 14;
    T.eyes = 'happy';
    T.mouth = 'grin';
    T.brow = 0.3;
    return air * 0.3;
  }

  /** Not this time: the bat's head drops to the dirt, the head drops, a sigh and a shake. */
  private sad(T: BatTargets, t: number, s: BatterState) {
    const u = s.t;
    const sigh = Math.sin(clamp(u / 1.4) * Math.PI) * 0.03;
    this.feetAt(T, FEET.back + 0.04, FEET.front - 0.02);
    this.bp(T.body, 0.0, 0, HIP - 0.05 - sigh);
    this.chest(T, 0.35, 0, -0.36);
    // the top hand low in front, the bat angled down to the ground by the front foot
    this.bp(T.grip, 0.1, 0.3, 0.5);
    this.bDir(T.dir, 0.35, 0.28, -0.9);
    T.both = u < 0.25 ? 1 : 0;
    this.bp(T.bottom, -0.02, 0.18, 0.46);
    T.lam = 5;
    T.armLam = 6;
    T.feetLam = 8;
    gazeDir(T.gaze, this.pose.yaw + this.h * 0.5, -0.9);
    T.headRoll = Math.sin(u * 5.5) * 0.16 * Math.max(0, 1 - u / 1.8);
    T.eyes = 'sad';
    T.mouth = 'frown';
    T.brow = -1;
  }

  /** Waiting a turn: standing easy, the bat on the shoulder, turned to `yaw`, watching `look`. */
  private idle(T: BatTargets, t: number, s: BatterState) {
    const h = this.h;
    T.rootYaw = s.yaw;
    const sway = Math.sin(t * 0.9) * 0.01;
    const shift = Math.sin(t * 0.31) * 0.012;
    set(T.body, shift, HIP - 0.005 + sway * 0.3, 0);
    T.pitch = 0.02;
    T.yaw = h * 0.1 + Math.sin(t * 0.23) * 0.05;
    T.roll = -shift * 0.8;
    set(T.feet[0], -HIP_X * 1.3, 0, 0.02);
    set(T.feet[1], HIP_X * 1.3, 0, 0.02);
    T.footPitch[0] = T.footPitch[1] = 0;
    // the top hand in front of the shoulder, the bat resting on it, pointing up and back
    rot(this.a, h * 0.14, 0.57 + sway, -0.22, T.pitch, T.yaw, T.roll);
    set(T.grip, this.a.x + T.body.x, this.a.y + T.body.y, this.a.z + T.body.z);
    rot(T.dir, h * 0.12, 0.62, 0.78, T.pitch, T.yaw, T.roll);
    norm(T.dir);
    // the other hand easy at the side
    rot(this.b, -h * 0.3, 0.4 - sway, -0.04, T.pitch, T.yaw, T.roll);
    set(T.bottom, this.b.x + T.body.x, this.b.y + T.body.y, this.b.z + T.body.z);
    T.both = 0;
    T.lam = 6;
    T.armLam = 7;
    T.feetLam = 10;
    if (!gazeAt(T.gaze, s.look)) gazeDir(T.gaze, s.yaw + Math.sin(t * 0.37) * 0.25, -0.05);
    T.eyes = 'open';
    T.mouth = 'smile';
    T.brow = 0;
  }
}

// ================================================================= the pitcher

interface PitchTargets {
  rootYaw: number;
  body: V3;
  pitch: number;
  yaw: number;
  roll: number;
  feet: [V3, V3];
  footPitch: [number, number];
  /** the glove hand, the glove's fingers and its pocket's facing; the throwing hand */
  glove: V3;
  gloveDir: V3;
  gloveFace: V3;
  ball: V3;
  lam: number;
  armLam: number;
  feetLam: number;
  gaze: Gaze;
  eyes: EyeState;
  mouth: MouthState;
  brow: number;
}

/**
 * A pitcher's key pose, in the pitcher's frame (F towards the plate, R the
 * throwing arm's side, U up) — square to the plate, whatever the root's turn
 * (the windup turns the whole root side-on for the leg kick, so the hips and the
 * feet turn with the chest: `root`; positions stay in the square frame).
 */
interface PKey {
  t: number;
  /** the root's turn from square (+ = side-on, glove side to the plate) */
  root: number;
  /** body: F, R, U; the chest's turn from square (+ = closed, side-on at π/2), lean forward (+), tilt to the glove side (+) */
  body: Tri;
  turn: number;
  lean: number;
  tilt: number;
  /** the stride (glove-side) foot and the pivot foot: F, R, U; their pitch */
  stride: Tri;
  pivot: Tri;
  sp: number;
  pp: number;
  /** the glove hand, its fingers and its pocket's facing; the throwing hand */
  glove: Tri;
  gd: Tri;
  gf: Tri;
  hand: Tri;
}
type Tri = [number, number, number];

const PK = (t: number, root: number, body: Tri, turn: number, lean: number, tilt: number, stride: Tri, sp: number, pivot: Tri, pp: number, glove: Tri, gd: Tri, gf: Tri, hand: Tri): PKey => ({
  t,
  root,
  body,
  turn,
  lean,
  tilt,
  stride,
  pivot,
  sp,
  pp,
  glove,
  gd,
  gf,
  hand,
});

/** The glove's fingers and pocket (F, R, U): at the chest with the ball hand in it; reaching for the plate; tucked in; up to field. */
const GLOVE_SET: [Tri, Tri] = [
  [0.2, -0.1, 1],
  [-0.2, 1, 0.05],
];
const GLOVE_AIM: [Tri, Tri] = [
  [0.85, 0.05, 0.5],
  [0.1, -1, -0.35],
];
const GLOVE_TUCK: [Tri, Tri] = [
  [0.3, 0.1, 1],
  [-1, 0.25, 0.1],
];
const GLOVE_FIELD: [Tri, Tri] = [
  [0.25, -0.15, 1],
  [1, 0.1, 0.1],
];

/**
 * The windup's keys (t from its start; the ball goes at DELIVERY.release):
 * rock and turn, the leg kick to the balance point, drop and drive as the
 * hands break and the arm swings down, back and up, the front foot lands with
 * the ball cocked behind the head, the hips and chest fire, the arm whips over
 * the top to the release (`rel`, solved for this character so the ball meets
 * field.ts's release point), then the follow-through, the back leg swinging
 * round, falling off to the glove side into a fielder's crouch. Everything down
 * the mound is laid out from where the release pose stands (bf).
 */
function windupKeys(kind: PitchKind | null, rel: PKey): PKey[] {
  const kick = kind === 'changeup' ? 0.36 : kind === 'curve' ? 0.46 : 0.43;
  // the curve comes over the top, the slider from a touch lower
  const slot = kind === 'curve' ? 0.06 : kind === 'slider' ? -0.06 : 0;
  const HB = HIP;
  const bf = rel.body[0];
  const land = rel.stride[0];
  const [sd, sf] = GLOVE_SET,
    [ad, af] = GLOVE_AIM,
    [td, tf] = GLOVE_TUCK,
    [fd, ff] = GLOVE_FIELD;
  return [
    PK(0, 0, [0, 0, HB], 0.12, 0.05, 0, [0.02, -0.14, 0], 0, [0, 0.13, 0], 0, [0.27, -0.02, 0.84], sd, sf, [0.23, 0.03, 0.82]),
    // rock back, the hands swung up over the head, starting to turn
    PK(0.22, 0.3, [-0.07, 0.02, HB + 0.015], 0.4, -0.04, 0, [-0.12, -0.12, 0.04], 0.12, [-0.04, 0.08, 0], 0, [0.13, -0.03, 1.37], sd, sf, [0.11, 0.04, 1.35]),
    // turned side-on on the rubber (the pivot foot along it), the knee coming up in front of the
    // chest, the hands coming down to it
    PK(0.42, 1.3, [-0.04, 0.03, HB + 0.03], 1.45, -0.03, -0.03, [0.1, 0.19, kick * 0.72], -0.45, [-0.08, 0.02, 0], 0, [0.12, 0.0, 1.06], sd, sf, [0.1, 0.05, 1.05]),
    // the balance point: the knee at its highest, coiled a touch past side-on
    PK(0.56, 1.45, [-0.03, 0.04, HB + 0.035], 1.75, -0.06, -0.05, [0.11, 0.3, kick], -0.7, [-0.08, 0.02, 0], 0, [0.1, 0.02, 0.96], sd, sf, [0.08, 0.07, 0.95]),
    // drop and drive: the stride reaches out, the hands break, the arm swings down and back
    PK(0.74, 1.2, [bf * 0.4, 0.03, HB - 0.05], 1.62, -0.06, -0.1, [land * 0.55, -0.02, 0.13], -0.2, [-0.08, 0.02, 0], -0.1, [bf * 0.4 + 0.28, -0.28, 0.9], ad, af, [bf * 0.4 - 0.38, 0.34, 0.5]),
    // foot strike, squaring up: the glove reaching for the plate, the ball cocked up behind the head
    PK(0.9, 0.55, [bf * 0.76, 0.02, HB - 0.07], 1.3, 0.06, -0.12, [land, -0.07, 0], 0.05, [-0.06, 0.05, 0.02], -0.4, [bf * 0.76 + 0.34, -0.24, 0.92], ad, af, [bf * 0.76 - 0.42 - slot * 0.5, 0.4, 1.04 + slot]),
    // the hips and chest fire, the elbow leads, the glove tucks in
    PK(1.02, 0.12, [bf * 0.94, rel.body[1] * 0.6, HB - 0.055], 0.55, 0.2, 0.18 + slot, [land, -0.07, 0], 0.08, [0.06, 0.08, 0.04], -0.62, [bf + 0.1, -0.16, 0.86], td, tf, [bf * 0.94 + 0.02, 0.33, 1.3 + slot * 0.5]),
    rel,
    // the follow-through: the arm down across the body, bent over, the back leg coming round
    PK(1.3, 0, [bf + 0.13, -0.06, HB - 0.1], -0.55, 0.62, 0.04, [land, -0.07, 0], 0.05, [bf - 0.05, 0.05, 0.28], -0.35, [bf + 0.02, -0.03, 0.74], td, tf, [bf + 0.4, -0.24, 0.42]),
    // the back foot lands beside the front, falling off to the glove side
    PK(1.55, 0, [bf + 0.12, -0.12, HB - 0.08], -0.3, 0.32, 0.02, [land, -0.08, 0], 0, [land - 0.1, 0.18, 0], 0, [bf + 0.33, -0.2, 0.86], fd, ff, [bf + 0.22, 0.22, 0.62]),
    // a fielder's crouch: square, knees bent, the glove up
    PK(DELIVERY.end, 0, [bf + 0.16, -0.03, HB - 0.07], 0, 0.22, 0, [land - 0.05, -0.16, 0], 0, [land - 0.1, 0.16, 0], 0, [bf + 0.45, -0.08, 0.86], fd, ff, [bf + 0.33, 0.2, 0.74]),
  ];
}

export class PitcherAnimator extends Base {
  private h: 1 | -1;
  private phase: PitcherState['phase'] | '' = '';
  private from = '';
  private tg: PitchTargets = {
    rootYaw: Math.PI,
    body: V(0, HIP, 0),
    pitch: 0,
    yaw: 0,
    roll: 0,
    feet: [V(), V()],
    footPitch: [0, 0],
    glove: V(),
    gloveDir: V(0, 1, 0),
    gloveFace: V(0, 0, -1),
    ball: V(),
    lam: 10,
    armLam: 12,
    feetLam: 12,
    gaze: gaze(),
    eyes: 'open',
    mouth: 'flat',
    brow: 0,
  };
  private keys: PKey[] = [];
  /** what the keys were built for: the pitch, and where the rubber is */
  private keysFor = '';
  private kind: PitchKind | null = null;
  /** the pose when the phase began: the windup blends out of it, 'follow' out of the windup's end */
  private snap = { body: V(), pitch: 0, yaw: 0, roll: 0, feet: [V(), V()] as [V3, V3], footPitch: [0, 0] as [number, number], glove: V(), ball: V(), gloveDir: V(0, 1, 0), gloveFace: V(0, 0, -1), rootYaw: Math.PI };
  private rel: PKey = PK(DELIVERY.release, 0, [0.4, 0, HIP - 0.04], 0.06, 0.3, 0.2, [0.74, -0.07, 0], 0.08, [0.2, 0.12, 0.05], -0.75, [0.5, -0.12, 0.84], GLOVE_TUCK[0], GLOVE_TUCK[1], [0, 0, 0]);
  private a = V();
  private b = V();
  private c = V();
  private s1 = V();

  constructor(
    public handed: 1 | -1,
    look: Look,
  ) {
    super(look);
    this.h = handed;
    this.pose.handed = handed === 1 ? -1 : 1;
  }

  /** pitcher frame → root: F towards the plate, R the throwing arm's side, U up */
  private qp(o: V3, F: number, R: number, U: number) {
    return set(o, this.h * R, U, -F);
  }

  private qDir(o: V3, F: number, R: number, U: number) {
    set(o, this.h * R, U, -F);
    norm(o);
    return o;
  }

  /** the root's turn from square in the windup (see PKey) */
  private rho = 0;

  /** pitcher frame (square to the plate) → the root as it's turned now (by rho, side-on for the kick) */
  private qr(o: V3, F: number, R: number, U: number) {
    const x = this.h * R,
      z = -F;
    const a = this.h * this.rho;
    const c = Math.cos(a),
      s = Math.sin(a);
    return set(o, x * c + z * s, U, -x * s + z * c);
  }

  /** chest turned `turn` from square (+ closed towards side-on), leaning forward `lean`, tilted to the glove side `tilt` */
  private chest(o: { yaw: number; pitch: number; roll: number }, turn: number, lean: number, tilt: number) {
    // side-on puts the glove shoulder to the plate: a right-hander's chest turns right (−yaw)
    o.yaw = -this.h * turn;
    o.pitch = -lean;
    // tilting to the glove side lifts the throwing shoulder: the top of the torso goes towards the glove (−R)
    o.roll = this.h * tilt;
  }

  update(t: number, dt: number, s: PitcherState): Pose {
    const P = this.pose;
    const T = this.tg;
    dt = Math.max(1e-4, Math.min(dt, 0.1));
    const h = (s.handed ?? this.handed) as 1 | -1;
    this.h = h;
    P.handed = h === 1 ? -1 : 1;
    P.x = s.x;
    P.z = s.z;
    P.holdingBall = false;
    P.tired = 0;
    P.legLift = 0;
    if (s.phase === 'windup' || s.phase === 'set') this.kind = s.kind;
    this.buildKeys(s);
    if (!this.started) this.first(s);
    this.measureWalk(s.x, s.z, dt);
    if (s.phase !== this.phase) this.enter(s);
    this.rewound(s.phase, s.t);

    T.rootYaw = Math.PI;
    T.lam = 9;
    T.armLam = 11;
    T.feetLam = 12;
    T.eyes = 'open';
    T.mouth = 'flat';
    T.brow = 0.2;
    // looking in at the catcher by default
    if (!gazeAt(T.gaze, s.look)) gazeAt(T.gaze, { x: 0, y: 0.9, z: FIELD.catcherZ });

    if (s.phase === 'windup') {
      this.windup(t, dt, s);
      return P;
    }
    switch (s.phase) {
      case 'set':
        this.setPose(T, t, s.t);
        break;
      case 'follow':
        this.follow(T, t, s.t);
        break;
      case 'watch':
        this.watch(T, t, s);
        break;
      default:
        this.idle(T, t, s.t);
    }
    if (s.phase === 'idle') this.walk(T.feet, T.footPitch, T.body);

    const kr = this.ease(7, dt),
      kb = this.ease(T.lam, dt),
      kf = this.ease(T.feetLam, dt);
    P.yaw = Number.isFinite(P.yaw) ? P.yaw + angleDiff(P.yaw, T.rootYaw) * kr : T.rootYaw;
    lerpV(P.body, P.body, T.body, kb);
    P.bodyPitch = lerp(P.bodyPitch, T.pitch, kb);
    P.bodyYaw = P.bodyYaw + angleDiff(P.bodyYaw, T.yaw) * kb;
    P.bodyRoll = lerp(P.bodyRoll, T.roll, kb);
    // (standing on the mound's flat top: the rubber and the whole stride are up on it)
    P.hop = FIELD.moundH;
    P.squash = this.spring(dt);
    for (let i = 0; i < 2; i++) {
      lerpV(P.feet[i], P.feet[i], T.feet[i], kf);
      P.footPitch[i] = lerp(P.footPitch[i], T.footPitch[i], kf);
    }
    // the catcher's throw coming back: the glove up to meet it (right on it as it arrives)
    const exact = s.toss ? this.catchToss(T, s.toss) : false;
    const ka = exact ? 1 : this.ease(T.armLam, dt);
    lerpV(P.hands[0], P.hands[0], T.glove, ka);
    lerpV(P.hands[1], P.hands[1], T.ball, exact ? 1 : this.ease(T.armLam * (s.toss ? 1.6 : 1), dt));
    lerpV(P.racketDir, P.racketDir, T.gloveDir, ka);
    if (!norm(P.racketDir)) cp(P.racketDir, T.gloveDir);
    lerpV(P.racketFace, P.racketFace, T.gloveFace, ka);
    ortho(P.racketDir, P.racketFace);
    this.aimHead(T.gaze, dt, 9, 2.4, 0, t);
    this.face(t, dt, T.eyes, T.mouth, T.brow);
    return P;
  }

  /**
   * Glove the catcher's throw: the glove comes up in front as it's thrown,
   * its pocket exactly on the ball's arrival point at eta = 0 (set, not eased,
   * from just before: it must be right there), gives a touch with it, and the
   * throwing hand comes over to take it out. Returns whether the glove is set
   * exactly this frame.
   */
  private catchToss(T: PitchTargets, toss: { x: number; y: number; z: number; eta: number }) {
    const eta = toss.eta;
    if (eta > 0.95 || eta < -0.45) return false;
    const P = this.pose;
    const sc = this.scale;
    // the arrival point in the root (as it's turned now: square, normally)
    const dx = toss.x - P.x,
      dz = toss.z - P.z;
    const c = Math.cos(P.yaw),
      s = Math.sin(P.yaw);
    const lx = (c * dx - s * dz) / sc,
      ly = (toss.y - P.hop) / sc,
      lz = (s * dx + c * dz) / sc;
    // fingers up, the pocket facing the throw (towards the catcher: forward)
    this.qDir(T.gloveDir, 0.2, -0.12, 1);
    this.qDir(T.gloveFace, 1, 0.05, 0.12);
    ortho(T.gloveDir, T.gloveFace);
    // after it's in: a give back and down, then in towards the chest
    const after = Math.max(0, -eta);
    const give = Math.sin(clamp(after / 0.14) * Math.PI * 0.5) * 0.06;
    const tuck = smooth(clamp((after - 0.12) / 0.3));
    slotAxesTo(T.gloveDir, T.gloveFace, GLOVE.pocket, this.a);
    set(T.glove, lx - this.a.x, ly - this.a.y - give * 0.4, lz - this.a.z + give);
    if (tuck > 0) {
      this.qp(this.b, 0.3, -0.06, 0.86);
      lerpV(T.glove, T.glove, this.b, tuck);
    }
    // the throwing hand comes over beside the pocket, to take it out
    const reach = smooth(clamp((0.35 - eta) / 0.4));
    set(this.c, T.glove.x + this.a.x, T.glove.y + this.a.y - 0.05, T.glove.z + this.a.z + 0.02);
    this.c.x += this.h * 0.1;
    lerpV(T.ball, T.ball, this.c, reach);
    // before it's close, the glove rises into place (eased); from just before it lands it's set exactly
    const up = smooth(clamp((0.95 - eta) / 0.45));
    if (up < 1 && eta > 0.12) {
      this.qp(this.b, 0.28, -0.1, 0.9);
      lerpV(T.glove, this.b, T.glove, up);
    }
    T.armLam = 22;
    T.eyes = eta > -0.1 ? 'focus' : 'open';
    T.mouth = 'flat';
    return eta <= 0.12 && eta >= -0.45;
  }

  private first(s: PitcherState) {
    this.started = true;
    this.lastX = s.x;
    this.lastZ = s.z;
    const P = this.pose;
    const T = this.tg;
    P.yaw = Math.PI;
    this.idle(T, 0, 1);
    cp(P.body, T.body);
    P.bodyPitch = T.pitch;
    P.bodyYaw = T.yaw;
    P.bodyRoll = T.roll;
    for (let i = 0; i < 2; i++) cp(P.feet[i], T.feet[i]);
    cp(P.hands[0], T.glove);
    cp(P.hands[1], T.ball);
    cp(P.racketDir, T.gloveDir);
    cp(P.racketFace, T.gloveFace);
  }

  private enter(s: PitcherState) {
    this.from = this.phase;
    this.phase = s.phase;
    const P = this.pose;
    const S = this.snap;
    cp(S.body, P.body);
    S.pitch = P.bodyPitch;
    S.yaw = P.bodyYaw;
    S.roll = P.bodyRoll;
    S.rootYaw = P.yaw;
    for (let i = 0; i < 2; i++) {
      cp(S.feet[i], P.feet[i]);
      S.footPitch[i] = P.footPitch[i];
    }
    cp(S.glove, P.hands[0]);
    cp(S.ball, P.hands[1]);
    cp(S.gloveDir, P.racketDir);
    cp(S.gloveFace, P.racketFace);
  }

  /** Writes a key's feet into a pose's feet (the stride foot is the glove side's). */
  private keyFeet(k: PKey, feet: [V3, V3], fp: [number, number]) {
    const st = this.h > 0 ? 0 : 1;
    this.qp(feet[st], k.stride[0], k.stride[1], k.stride[2]);
    this.qp(feet[1 - st], k.pivot[0], k.pivot[1], k.pivot[2]);
    fp[st] = k.sp;
    fp[1 - st] = k.pp;
  }

  /** The keys for this pitch kind and this rubber (the release is solved for where the pitcher stands). */
  private buildKeys(s: PitcherState) {
    const key = `${this.kind}|${s.z.toFixed(3)}|${this.h}`;
    if (key === this.keysFor && this.keys.length) return;
    this.keysFor = key;
    this.solveRelease(this.kind, s.z);
    this.keys = windupKeys(this.kind, this.rel);
  }

  /** The windup, set exactly each frame (the ball must be at the release point at DELIVERY.release). */
  private windup(t: number, dt: number, s: PitcherState) {
    const P = this.pose;
    const T = this.tg;
    const u = s.t;
    const keys = this.keys;
    // find the segment
    let i = 0;
    const at = (k: number) => keys[k];
    while (i < keys.length - 2 && u > at(i + 1).t) i++;
    const k0 = at(i),
      k1 = at(i + 1);
    const km = at(Math.max(0, i - 1)),
      kp = at(Math.min(keys.length - 1, i + 2));
    const span = Math.max(1e-4, k1.t - k0.t);
    const v = clamp((u - k0.t) / span);
    // Catmull-Rom over the (non-uniform) key times: tangents from the neighbours
    const cr = (a: number, b: number, c: number, d: number) => {
      const m1 = ((c - a) / Math.max(1e-4, k1.t - km.t)) * span;
      const m2 = ((d - b) / Math.max(1e-4, kp.t - k0.t)) * span;
      const v2 = v * v,
        v3 = v2 * v;
      return (2 * v3 - 3 * v2 + 1) * b + (v3 - 2 * v2 + v) * m1 + (-2 * v3 + 3 * v2) * c + (v3 - v2) * m2;
    };
    const tri = (f: (k: PKey) => [number, number, number], o: V3) => {
      const A = f(km),
        B = f(k0),
        C = f(k1),
        D = f(kp);
      return set(o, cr(A[0], B[0], C[0], D[0]), cr(A[1], B[1], C[1], D[1]), cr(A[2], B[2], C[2], D[2]));
    };
    const one = (f: (k: PKey) => number) => cr(f(km), f(k0), f(k1), f(kp));
    // out of the set (or wherever it was), over the first moments
    const blend = smooth(clamp(u / 0.18));

    // the root turns side-on for the kick and squares up again by the release (exactly square then)
    const rho = one((k) => k.root);
    this.rho = rho;
    P.yaw = Math.PI - this.h * rho;
    tri((k) => k.body, this.a);
    this.qr(this.b, this.a.x, this.a.y, this.a.z);
    lerpV(P.body, this.snap.body, this.b, blend);
    // the chest's turn, less what the root's already turned
    this.chest(T, one((k) => k.turn) - rho, one((k) => k.lean), one((k) => k.tilt));
    P.bodyYaw = lerp(this.snap.yaw, T.yaw, blend);
    P.bodyPitch = lerp(this.snap.pitch, T.pitch, blend);
    P.bodyRoll = lerp(this.snap.roll, T.roll, blend);
    P.hop = FIELD.moundH;
    P.squash = 1;
    const st = this.h > 0 ? 0 : 1;
    tri((k) => k.stride, this.a);
    this.qr(this.b, this.a.x, this.a.y, this.a.z);
    lerpV(P.feet[st], this.snap.feet[st], this.b, blend);
    tri((k) => k.pivot, this.a);
    this.qr(this.b, this.a.x, this.a.y, this.a.z);
    lerpV(P.feet[1 - st], this.snap.feet[1 - st], this.b, blend);
    P.footPitch[st] = lerp(this.snap.footPitch[st], one((k) => k.sp), blend);
    P.footPitch[1 - st] = lerp(this.snap.footPitch[1 - st], one((k) => k.pp), blend);
    // the stride foot never goes under the ground
    for (const f of P.feet) f.y = Math.max(0, f.y);

    // the glove
    tri((k) => k.glove, this.a);
    this.qr(this.b, this.a.x, this.a.y, this.a.z);
    lerpV(P.hands[0], this.snap.glove, this.b, blend);
    // the glove turns as it goes (keyed): at the chest, reaching for the plate, tucked in, up to field
    tri((k) => k.gd, this.a);
    this.qr(this.c, this.a.x, this.a.y, this.a.z);
    norm(this.c);
    tri((k) => k.gf, this.b);
    this.qr(this.a, this.b.x, this.b.y, this.b.z);
    norm(this.a);
    ortho(this.c, this.a);
    lerpV(P.racketDir, this.snap.gloveDir, this.c, blend);
    norm(P.racketDir);
    lerpV(P.racketFace, this.snap.gloveFace, this.a, blend);
    ortho(P.racketDir, P.racketFace);

    // the throwing hand: through its keys, and exactly on the release point at DELIVERY.release
    tri((k) => k.hand, this.a);
    this.qr(this.b, this.a.x, this.a.y, this.a.z);
    lerpV(P.hands[1], this.snap.ball, this.b, blend);

    // eyes on the catcher's mitt all the way, then after the pitch
    if (!gazeAt(this.tg.gaze, s.look)) gazeAt(this.tg.gaze, { x: 0, y: 0.8, z: FIELD.catcherZ });
    this.aimHead(this.tg.gaze, dt, 14, 2.4, 0, t);
    const effort = u > 0.85 && u < 1.3;
    this.face(t, dt, effort ? 'focus' : 'open', effort ? 'open' : 'flat', effort ? 1 : 0.5);
  }

  /**
   * The release pose, solved for this character on this rubber: the body at a
   * set height and lean, the arm nearly straight up and out over the top, and
   * the body as far down the mound as that puts the ball on the release point
   * (FIELD.releaseY, FIELD.releaseZ, FIELD.releaseSide out to the throwing
   * side) — a small pitcher reaches up steeper and strides further. Then the
   * throwing hand exactly where the ball, BALL_OUT out along the arm, sits on
   * the point (should the body's limits leave it short, the arm stretches, as
   * cartoon arms do). Everything else in the windup is keyed around it.
   */
  private solveRelease(kind: PitchKind | null, z: number) {
    const k = this.rel;
    const sc = this.scale;
    // the curve comes more over the top, the slider from a touch lower
    const slot = kind === 'curve' ? 0.07 : kind === 'slider' ? -0.05 : 0;
    k.turn = 0.06;
    k.lean = 0.3;
    k.tilt = 0.06 + slot;
    // the release point in the pitcher's frame (root units)
    const F = (FIELD.releaseZ - z) / sc;
    const R = FIELD.releaseSide / sc;
    const U = (FIELD.releaseY - FIELD.moundH) / sc;
    // the throwing shoulder's offset from the body in this lean
    const o = { yaw: 0, pitch: 0, roll: 0 };
    this.chest(o, k.turn, k.lean, k.tilt);
    shoulderAt(this.s1, this.h, this.girth, set(this.a, 0, 0, 0), o.pitch, o.yaw, o.roll, 1);
    const oF = -this.s1.z,
      oR = this.h * this.s1.x,
      oU = this.s1.y;
    // the arm (hand + the ball beyond it) up at `el`, and out to the throwing side at `az` (a
    // three-quarter slot: the release point's out beyond the shoulder), the body square over the rubber's line
    const L = 0.5 * 0.975 + BALL_OUT;
    const bU = HIP - 0.04;
    const el = Math.asin(clamp((U - (bU + oU)) / L, Math.sin(deg(18)), Math.sin(deg(70))));
    const hz = L * Math.cos(el);
    const az = Math.asin(clamp((R - oR) / Math.max(1e-3, hz), -0.2, 0.75));
    const bF = clamp(F - hz * Math.cos(az) - oF, 0.18, 0.62);
    const bR = clamp(R - hz * Math.sin(az) - oR, -0.08, 0.14);
    k.body = [bF, bR, bU];
    k.stride = [bF + 0.34, -0.07, 0];
    k.pivot = [0.18 + bF * 0.2, 0.12, 0.05];
    k.glove = [bF + 0.12, -0.12, 0.84];
    // the hand for this body: hand = shoulder + (release − shoulder) · (1 − BALL_OUT / |release − shoulder|)
    this.qp(this.a, bF, bR, bU);
    shoulderAt(this.s1, this.h, this.girth, this.a, o.pitch, o.yaw, o.roll, 1);
    this.qp(this.b, F, R, U);
    const d = dist(this.b, this.s1);
    const kk = 1 - BALL_OUT / Math.max(BALL_OUT * 1.5, d);
    set(this.c, this.s1.x + (this.b.x - this.s1.x) * kk, this.s1.y + (this.b.y - this.s1.y) * kk, this.s1.z + (this.b.z - this.s1.z) * kk);
    // back to the pitcher's frame for the key
    k.hand = [-this.c.z, this.h * this.c.x, this.c.y];
    return k;
  }

  /** Where the ball is for a pose (root space): out along the throwing arm from the hand. */
  static ballAt(o: V3, hand: V3, shoulder: V3) {
    const dx = hand.x - shoulder.x,
      dy = hand.y - shoulder.y,
      dz = hand.z - shoulder.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    return set(o, hand.x + (dx / l) * BALL_OUT, hand.y + (dy / l) * BALL_OUT, hand.z + (dz / l) * BALL_OUT);
  }

  /** Ball in the glove at the chest, reading the sign. */
  private setPose(T: PitchTargets, t: number, u: number) {
    const k = this.keys[0] as PKey;
    const br = Math.sin(t * 1.9) * 0.005;
    this.qp(T.body, k.body[0], k.body[1], k.body[2] + br);
    this.chest(T, k.turn, k.lean, k.tilt);
    this.keyFeet(k, T.feet, T.footPitch);
    this.qp(T.glove, k.glove[0], k.glove[1], k.glove[2] + br);
    this.qp(T.ball, k.hand[0], k.hand[1], k.hand[2] + br);
    this.qDir(T.gloveDir, 0.2, -0.1, 1);
    this.qDir(T.gloveFace, -0.2, 1, 0.05);
    ortho(T.gloveDir, T.gloveFace);
    // a little nod at the sign
    const nod = u > 0.5 && u < 0.9 ? Math.sin(((u - 0.5) / 0.4) * Math.PI) * 0.15 : 0;
    gazeAt(T.gaze, { x: 0, y: 0.75 - nod * 3, z: FIELD.catcherZ });
    T.lam = 8;
    T.armLam = 10;
    T.eyes = 'focus';
    T.mouth = 'flat';
    T.brow = 0.6;
  }

  /** Between batters: on the mound, rubbing up the ball, looking in. */
  private idle(T: PitchTargets, t: number, u: number) {
    const br = Math.sin(t * 1.6) * 0.006;
    this.qp(T.body, 0, 0, HIP - 0.005 + br);
    this.chest(T, 0.2, 0.03, 0);
    const st = this.h > 0 ? 0 : 1;
    this.qp(T.feet[st], 0.08, -0.16, 0);
    this.qp(T.feet[1 - st], -0.02, 0.15, 0);
    T.footPitch[0] = T.footPitch[1] = 0;
    // rubbing the ball between the hands at the belt
    const rub = Math.sin(t * 7.5) * 0.035;
    this.qp(T.glove, 0.27, -0.06 + rub * 0.4, 0.66 + rub * 0.3);
    this.qp(T.ball, 0.27, 0.07 - rub, 0.66 - rub * 0.3);
    this.qDir(T.gloveDir, 0.3, 0.6, 0.75);
    this.qDir(T.gloveFace, 0, 1, 0);
    ortho(T.gloveDir, T.gloveFace);
    gazeAt(T.gaze, { x: 0, y: 0.8, z: FIELD.catcherZ });
    T.lam = 6;
    T.armLam = 9;
    T.eyes = 'open';
    T.mouth = u > 0.5 ? 'smile' : 'flat';
    T.brow = 0.1;
  }

  /** After the delivery: out of the fielder's crouch, back up onto the mound. */
  private follow(T: PitchTargets, t: number, u: number) {
    const end = this.keys[this.keys.length - 1] as PKey;
    const k = smooth(clamp((u - 0.25) / 0.9));
    // the fielder's crouch first, then standing easy back on the rubber
    const st = this.h > 0 ? 0 : 1;
    const step1 = smooth(clamp((u - 0.35) / 0.35));
    const step2 = smooth(clamp((u - 0.6) / 0.35));
    this.qp(T.body, lerp(end.body[0], 0.05, k), lerp(end.body[1], 0, k), lerp(end.body[2], HIP - 0.005, k));
    this.chest(T, lerp(end.turn, 0.15, k), lerp(end.lean, 0.03, k), 0);
    this.qp(T.feet[st], lerp(end.stride[0], 0.12, step1), lerp(end.stride[1], -0.16, step1), 0.06 * Math.sin(step1 * Math.PI));
    this.qp(T.feet[1 - st], lerp(end.pivot[0], -0.02, step2), lerp(end.pivot[1], 0.15, step2), 0.06 * Math.sin(step2 * Math.PI));
    T.footPitch[0] = T.footPitch[1] = 0;
    this.qp(T.glove, lerp(end.glove[0], 0.27, k), lerp(end.glove[1], -0.08, k), lerp(end.glove[2], 0.7, k));
    this.qp(T.ball, lerp(end.hand[0], 0.1, k), lerp(end.hand[1], 0.3, k), lerp(end.hand[2], 0.42, k));
    this.qDir(T.gloveDir, 0.3, 0.4, 0.8);
    this.qDir(T.gloveFace, 0.6, 0.8, 0);
    ortho(T.gloveDir, T.gloveFace);
    T.lam = 7;
    T.armLam = 8;
    T.feetLam = 16;
    T.eyes = 'open';
    T.mouth = 'flat';
    T.brow = 0.2;
  }

  /** A ball's been hit: turn to follow it, the glove up to shade the eyes if it's a high one. */
  private watch(T: PitchTargets, t: number, s: PitcherState) {
    const u = s.t;
    const P = this.pose;
    const l = s.look;
    // turn the root towards the ball (the whole body: it may be going over the pitcher's head)
    let yaw = P.yaw;
    if (l) {
      const dx = l.x - s.x,
        dz = l.z - s.z;
      if (dx * dx + dz * dz > 0.25) yaw = Math.atan2(-dx, -dz);
    }
    T.rootYaw = yaw;
    const k = smooth(clamp(u / 0.4));
    const br = Math.sin(t * 2) * 0.005;
    this.qp(T.body, 0, 0, HIP - 0.01 + br);
    this.chest(T, 0.1, -0.06 * k, 0);
    this.qp(T.feet[0], 0.02, -0.15, 0);
    this.qp(T.feet[1], -0.02, 0.15, 0);
    T.footPitch[0] = T.footPitch[1] = 0;
    // the glove up by the brim, the other hand on the hip
    const high = l ? clamp((l.y - 3) / 6) : 0;
    this.qp(T.glove, lerp(0.3, 0.22, high), -0.14, lerp(0.8, 1.32, high));
    this.qp(T.ball, 0.02, 0.3, 0.45);
    this.qDir(T.gloveDir, 0.5, 0, 0.9);
    this.qDir(T.gloveFace, 0, 0, -1);
    ortho(T.gloveDir, T.gloveFace);
    if (!gazeAt(T.gaze, l)) gazeDir(T.gaze, yaw, 0.3);
    T.lam = 6;
    T.armLam = 8;
    T.eyes = 'wide';
    T.mouth = 'o';
    T.brow = 0.8;
  }
}

// ================================================================= the catcher

interface CatchTargets {
  rootYaw: number;
  body: V3;
  pitch: number;
  yaw: number;
  roll: number;
  feet: [V3, V3];
  footPitch: [number, number];
  mitt: V3;
  mittDir: V3;
  mittFace: V3;
  hand: V3;
  lam: number;
  armLam: number;
  feetLam: number;
  gaze: Gaze;
  eyes: EyeState;
  mouth: MouthState;
  brow: number;
}

/** The crouch's mitt target when nothing's coming yet: the middle of the zone. */
const TARGET = { x: 0, y: (FIELD.zoneBottom + FIELD.zoneTop) / 2 };

export class CatcherAnimator extends Base {
  private phase: CatcherState['phase'] | '' = '';
  private from = '';
  private tg: CatchTargets = {
    rootYaw: 0,
    body: V(0, HIP, 0),
    pitch: 0,
    yaw: 0,
    roll: 0,
    feet: [V(), V()],
    footPitch: [0, 0],
    mitt: V(),
    mittDir: V(0, 1, 0),
    mittFace: V(0, 0, -1),
    hand: V(),
    lam: 10,
    armLam: 12,
    feetLam: 12,
    gaze: gaze(),
    eyes: 'open',
    mouth: 'flat',
    brow: 0,
  };
  private snapMitt = V();
  private snapDir = V(0, 1, 0);
  private snapFace = V(0, 0, -1);
  private snapBody = V();
  private snapHand = V();
  private snapPitch = 0;
  private snapYaw = 0;
  private snapRoll = 0;
  private a = V();
  private b = V();
  private X = V();
  private Y = V();
  private Z = V();

  constructor(look: Look) {
    super(look);
    // the mitt on the left hand, in the racket slot
    this.pose.handed = -1;
  }

  update(t: number, dt: number, s: CatcherState): Pose {
    const P = this.pose;
    const T = this.tg;
    dt = Math.max(1e-4, Math.min(dt, 0.1));
    P.handed = -1;
    P.x = s.x;
    P.z = s.z;
    P.holdingBall = false;
    P.tired = 0;
    P.legLift = 0;
    if (!this.started) this.first(s);
    this.measureWalk(s.x, s.z, dt);
    if (s.phase !== this.phase) this.enter(s);
    this.rewound(s.phase, s.t);

    T.rootYaw = 0;
    T.lam = 9;
    T.armLam = 12;
    T.feetLam = 12;
    T.eyes = 'focus';
    T.mouth = 'flat';
    T.brow = 0.4;
    if (!gazeAt(T.gaze, s.look)) gazeAt(T.gaze, { x: 0, y: 1.5, z: FIELD.releaseZ });

    // the catch and the throw are set exactly (the pocket on the ball at `arrive`, the ball on
    // the toss's starting point at THROW.release); the rest eases
    let exact = false;
    switch (s.phase) {
      case 'catch':
        exact = this.catchPose(T, t, s);
        break;
      case 'throw':
        exact = this.throwPose(T, t, s);
        break;
      case 'watch':
        this.watch(T, t, s);
        break;
      default:
        this.crouch(T, t, s);
    }
    if (s.phase === 'watch') this.walk(T.feet, T.footPitch, T.body);

    const kb = exact ? 1 : this.ease(T.lam, dt),
      kf = exact ? 1 : this.ease(T.feetLam, dt),
      ka = exact ? 1 : this.ease(T.armLam, dt);
    P.yaw = exact || !Number.isFinite(P.yaw) ? T.rootYaw : P.yaw + angleDiff(P.yaw, T.rootYaw) * this.ease(7, dt);
    lerpV(P.body, P.body, T.body, kb);
    P.bodyPitch = lerp(P.bodyPitch, T.pitch, kb);
    P.bodyYaw = P.bodyYaw + angleDiff(P.bodyYaw, T.yaw) * kb;
    P.bodyRoll = lerp(P.bodyRoll, T.roll, kb);
    P.hop = 0;
    const sq = this.spring(dt);
    P.squash = exact ? 1 : sq;
    for (let i = 0; i < 2; i++) {
      lerpV(P.feet[i], P.feet[i], T.feet[i], kf);
      P.footPitch[i] = lerp(P.footPitch[i], T.footPitch[i], kf);
    }
    lerpV(P.hands[0], P.hands[0], T.mitt, ka);
    lerpV(P.racketDir, P.racketDir, T.mittDir, ka);
    if (!norm(P.racketDir)) cp(P.racketDir, T.mittDir);
    lerpV(P.racketFace, P.racketFace, T.mittFace, ka);
    ortho(P.racketDir, P.racketFace);
    lerpV(P.hands[1], P.hands[1], T.hand, s.phase === 'throw' ? 1 : this.ease(T.armLam * 1.2, dt));
    this.aimHead(T.gaze, dt, 10, 2.2, 0, t);
    this.face(t, dt, T.eyes, T.mouth, T.brow);
    return P;
  }

  private first(s: CatcherState) {
    this.started = true;
    this.lastX = s.x;
    this.lastZ = s.z;
    const P = this.pose;
    const T = this.tg;
    P.yaw = 0;
    this.crouch(T, 0, s);
    cp(P.body, T.body);
    P.bodyPitch = T.pitch;
    P.bodyYaw = T.yaw;
    P.bodyRoll = T.roll;
    for (let i = 0; i < 2; i++) cp(P.feet[i], T.feet[i]);
    cp(P.hands[0], T.mitt);
    cp(P.hands[1], T.hand);
    cp(P.racketDir, T.mittDir);
    cp(P.racketFace, T.mittFace);
  }

  private enter(s: CatcherState) {
    this.from = this.phase;
    this.phase = s.phase;
    const P = this.pose;
    cp(this.snapMitt, P.hands[0]);
    cp(this.snapDir, P.racketDir);
    cp(this.snapFace, P.racketFace);
    cp(this.snapBody, P.body);
    cp(this.snapHand, P.hands[1]);
    this.snapPitch = P.bodyPitch;
    this.snapYaw = P.bodyYaw;
    this.snapRoll = P.bodyRoll;
    if (s.phase === 'catch') this.squashV -= 0.1;
  }

  /**
   * The squat: feet wide, up on the balls of the feet, the hips sat back behind
   * the heels — the catch point's only 0.35 m out and the torso's chunky: the
   * chest has to stay behind the mitt — leaning in over the knees.
   */
  private squat(T: CatchTargets, t: number, lean = 1) {
    const br = Math.sin(t * 1.8) * 0.005;
    set(T.body, 0, 0.17 + br, 0.25);
    T.pitch = -0.18 * lean;
    T.yaw = 0;
    T.roll = 0;
    set(T.feet[0], -0.3, 0.03, 0.06);
    set(T.feet[1], 0.3, 0.03, 0.06);
    T.footPitch[0] = T.footPitch[1] = -0.45;
  }

  /**
   * The mitt so its pocket sits on a world point (the pocket faces the pitch,
   * fingers up — turned over, fingers down, for a low one). Writes the mitt
   * hand, its fingers and its pocket's facing.
   */
  private mittOn(T: CatchTargets, wx: number, wy: number, wz: number) {
    const P = this.pose;
    const sc = this.scale;
    // world → root (the catcher faces −z: the root turns only for 'watch')
    const lx = (wx - P.x) / sc,
      ly = wy / sc,
      lz = (wz - P.z) / sc;
    // low balls: turn the mitt over, fingers down; to the sides: fingers out a touch
    const low = clamp((0.55 - wy) / 0.3);
    const side = clamp((wx - P.x) / 0.5, -1, 1);
    set(T.mittDir, 0.35 * side - 0.12, lerp(1, -0.6, low), lerp(0.1, -0.2, low));
    norm(T.mittDir);
    set(T.mittFace, 0.08 * side, lerp(0.05, 0.3, low), -1);
    ortho(T.mittDir, T.mittFace);
    // the pocket's offset in the slot's axes
    slotAxes(T.mittDir, T.mittFace, this.X, this.Y, this.Z);
    const p = MITT.pocket;
    const ox = this.X.x * p.x + this.Y.x * p.y + this.Z.x * p.z,
      oy = this.X.y * p.x + this.Y.y * p.y + this.Z.y * p.z,
      oz = this.X.z * p.x + this.Y.z * p.y + this.Z.z * p.z;
    set(T.mitt, lx - ox, ly - oy, lz - oz);
  }

  /**
   * The squat goes with the mitt (after mittOn): over towards a pitch off the
   * plate, the shoulders turned to bring the mitt across for one on the
   * throwing-hand side, leaning in and down for a low one, up out of the crouch
   * for a high one — then, whatever's still out of the arm's reach, the body
   * goes after it (the arm never stretches).
   */
  private reachMitt(T: CatchTargets, s: CatcherState, tx: number, ty: number) {
    const side = clamp((tx - s.x) / 0.5, -1, 1);
    const low = clamp((0.62 - ty) / 0.35);
    const high = clamp((ty - 0.95) / 0.45);
    T.body.x += side * 0.08;
    T.body.y += 0.2 * high - 0.03 * low;
    T.body.z -= 0.05 * low;
    T.pitch += 0.1 * high - 0.2 * low;
    T.yaw = -0.4 * Math.max(0, side);
    T.roll = -side * 0.06;
    const R = 0.5 * 1.02;
    for (let pass = 0; pass < 3; pass++) {
      const sh = shoulderAt(this.b, -1, this.girth, T.body, T.pitch, T.yaw, T.roll);
      const d = Math.hypot(T.mitt.x - sh.x, T.mitt.y - sh.y, T.mitt.z - sh.z);
      if (d <= R) break;
      const k = (d - R) / d;
      T.body.x += (T.mitt.x - sh.x) * k;
      T.body.y += (T.mitt.y - sh.y) * k;
      T.body.z += (T.mitt.z - sh.z) * k;
    }
    T.body.y = Math.max(0.08, T.body.y);
  }

  /** The pocket's centre (root space) for the pose as it stands. */
  pocket(o: V3) {
    const P = this.pose;
    slotAxes(P.racketDir, P.racketFace, this.X, this.Y, this.Z);
    const p = MITT.pocket;
    return set(o, P.hands[0].x + this.X.x * p.x + this.Y.x * p.y + this.Z.x * p.z, P.hands[0].y + this.X.y * p.x + this.Y.y * p.y + this.Z.y * p.z, P.hands[0].z + this.X.z * p.x + this.Y.z * p.y + this.Z.z * p.z);
  }

  /** Where the ball in the throwing hand is (root space): out along the arm from the hand, as the pitcher's. */
  static ballAt(o: V3, hand: V3, shoulder: V3) {
    return PitcherAnimator.ballAt(o, hand, shoulder);
  }

  /** The throwing hand tucked behind the knee, out of the way of foul tips. */
  private tuck(T: CatchTargets) {
    set(T.hand, 0.3, 0.3, 0.12);
  }

  private crouch(T: CatchTargets, t: number, s: CatcherState) {
    this.squat(T, t);
    // the target the game asks for (where the pitch is meant to go), or the middle of the zone;
    // a little rhythm in it
    const tx = s.targetY > 0 ? s.targetX : TARGET.x,
      ty = s.targetY > 0 ? s.targetY : TARGET.y;
    const bob = Math.sin(t * 2.4) * 0.008;
    this.mittOn(T, tx, ty + bob, FIELD.catcherZ - 0.35);
    this.reachMitt(T, s, tx, ty);
    // after a watch, the throwing hand pulls the mask back down first
    const u = s.t;
    if (this.from === 'watch' && u < MASK.on + 0.15) {
      const k = smooth(clamp(u / MASK.on));
      set(this.a, 0.3, 0.95, 0.18);
      set(this.b, 0.02, 1.2, -0.28);
      lerpV(T.hand, this.a, this.b, u < MASK.on ? k : 1 - smooth(clamp((u - MASK.on) / 0.15)));
    } else this.tuck(T);
    T.armLam = 10;
    T.lam = 7;
    T.eyes = 'focus';
    T.mouth = 'flat';
    T.brow = 0.4;
  }

  /** The pitch is coming: the mitt drifts to where it'll be, meets it at `arrive`, and gives with it. */
  private catchPose(T: CatchTargets, t: number, s: CatcherState) {
    const u = s.t;
    const ar = Math.max(0.05, s.arrive);
    this.squat(T, 0);
    const z = FIELD.catcherZ - 0.35;
    // the target held (a touch relaxed while the ball's on its way, then up to meet it, exactly
    // there at `arrive`); after it arrives, the pop
    if (u < ar) {
      const relax = Math.sin(Math.PI * clamp((u - 0.04) / Math.max(0.1, ar - 0.16))) * 0.045;
      this.mittOn(T, s.targetX, s.targetY - relax, z);
    } else {
      // the pop: back with the ball, then a little stick towards the zone (framing it)
      const v = u - ar;
      const give = Math.sin(clamp(v / 0.16) * Math.PI * 0.5) * 0.085 * Math.exp(-Math.max(0, v - 0.16) * 4);
      const frame = smooth(clamp((v - 0.12) / 0.3)) * 0.03;
      this.mittOn(T, s.targetX + (TARGET.x - s.targetX) * frame, s.targetY - give * 0.3 + (TARGET.y - s.targetY) * frame, z + give);
    }
    // the body over to where the mitt has to go
    this.reachMitt(T, s, s.targetX, s.targetY);
    // blend in from the pose it was in (a crouch, normally the same)
    const b = smooth(clamp(u / 0.12));
    if (b < 1) {
      lerpV(T.mitt, this.snapMitt, T.mitt, b);
      lerpV(T.mittDir, this.snapDir, T.mittDir, b);
      norm(T.mittDir);
      lerpV(T.mittFace, this.snapFace, T.mittFace, b);
      lerpV(T.body, this.snapBody, T.body, b);
      T.pitch = lerp(this.snapPitch, T.pitch, b);
      T.yaw = lerp(this.snapYaw, T.yaw, b);
      T.roll = lerp(this.snapRoll, T.roll, b);
    }
    this.tuck(T);
    // eyes on the ball all the way in from the pitcher's hand (near enough: a line from the release
    // point to the mitt), the head coming down only as it reaches the mitt
    if (!gazeAt(T.gaze, s.look)) {
      const k = clamp(u / ar);
      gazeAt(T.gaze, set(this.a, s.targetX * k, FIELD.releaseY + (s.targetY - FIELD.releaseY) * k, FIELD.releaseZ + (z - FIELD.releaseZ) * k));
    }
    T.eyes = 'focus';
    T.mouth = u >= ar && u < ar + 0.3 ? 'o' : 'flat';
    T.brow = 0.7;
    return true;
  }

  /**
   * Up out of the crouch and a quick toss back to the pitcher, set exactly
   * each frame (game.ts flies the ball from the hand at THROW.release): the
   * mitt comes up to the chest and the throwing hand has the ball out of the
   * pocket at THROW.take, back by the ear, and forward — the ball (BALL_OUT out
   * along the arm) exactly on TOSS at THROW.release — then the follow-through
   * and down again by THROW.end, when the game has him crouch.
   */
  private throwPose(T: CatchTargets, t: number, s: CatcherState): boolean {
    const u = s.t;
    const K = this.throwKeys();
    const tk = K.t;
    // the keys, Catmull-Rom over their times
    let i = 0;
    while (i < tk.length - 2 && u > tk[i + 1]) i++;
    const i0 = Math.max(0, i - 1),
      i3 = Math.min(tk.length - 1, i + 2);
    const span = tk[i + 1] - tk[i];
    const v = clamp((u - tk[i]) / span);
    const cr = (a: number[]) => {
      const m1 = ((a[i + 1] - a[i0]) / Math.max(1e-4, tk[i + 1] - tk[i0])) * span;
      const m2 = ((a[i3] - a[i]) / Math.max(1e-4, tk[i3] - tk[i])) * span;
      const v2 = v * v,
        v3 = v2 * v;
      return (2 * v3 - 3 * v2 + 1) * a[i] + (v3 - 2 * v2 + v) * m1 + (-2 * v3 + 3 * v2) * a[i + 1] + (v3 - v2) * m2;
    };
    const crV = (o: V3, a: V3[]) => {
      const xs = a.map((p) => p.x),
        ys = a.map((p) => p.y),
        zs = a.map((p) => p.z);
      return set(o, cr(xs), cr(ys), cr(zs));
    };
    crV(T.body, K.body);
    T.pitch = cr(K.pitch);
    T.yaw = cr(K.yaw);
    T.roll = 0;
    crV(T.feet[0], K.feet0);
    crV(T.feet[1], K.feet1);
    T.footPitch[0] = T.footPitch[1] = cr(K.footPitch);
    crV(T.mitt, K.mitt);
    crV(T.mittDir, K.mittDir);
    norm(T.mittDir);
    crV(T.mittFace, K.mittFace);
    ortho(T.mittDir, T.mittFace);
    crV(T.hand, K.hand);
    // out of the catch it was in, over the first moments
    const b = smooth(clamp(u / 0.08));
    if (b < 1) {
      lerpV(T.mitt, this.snapMitt, T.mitt, b);
      lerpV(T.mittDir, this.snapDir, T.mittDir, b);
      norm(T.mittDir);
      lerpV(T.mittFace, this.snapFace, T.mittFace, b);
      ortho(T.mittDir, T.mittFace);
      lerpV(T.body, this.snapBody, T.body, b);
      lerpV(T.hand, this.snapHand, T.hand, b);
    }
    gazeAt(T.gaze, { x: 0, y: 1.2, z: FIELD.moundZ });
    T.eyes = 'open';
    T.mouth = 'flat';
    T.brow = 0.2;
    return true;
  }

  /** the throw's keys, built once (they depend only on the character) */
  private tk: { t: number[]; body: V3[]; pitch: number[]; yaw: number[]; feet0: V3[]; feet1: V3[]; footPitch: number[]; mitt: V3[]; mittDir: V3[]; mittFace: V3[]; hand: V3[] } | null = null;

  private throwKeys() {
    if (this.tk) return this.tk;
    const sc = this.scale;
    const g = this.girth;
    const t = [0, THROW.take, 0.2, THROW.release, 0.46, THROW.end];
    const body = [V(0, 0.17, 0.25), V(0, 0.24, 0.17), V(0, HIP - 0.035, 0.1), V(0, HIP - 0.03, 0.08), V(0, HIP - 0.04, 0.08), V(0, 0.24, 0.2)];
    const pitch = [-0.18, -0.1, -0.02, -0.16, -0.12, -0.16];
    // the throwing shoulder back (the chest turned right) as the ball's cocked, square as it goes
    const yaw = [0, -0.2, -0.5, 0.1, 0.15, 0];
    const feet0 = [V(-0.3, 0.03, 0.06), V(-0.24, 0.015, 0.05), V(-0.18, 0, 0.02), V(-0.18, 0, -0.02), V(-0.18, 0, -0.02), V(-0.26, 0.02, 0.05)];
    const feet1 = [V(0.3, 0.03, 0.06), V(0.24, 0.015, 0.07), V(0.18, 0, 0.1), V(0.18, 0, 0.1), V(0.18, 0, 0.08), V(0.26, 0.02, 0.06)];
    const footPitch = [-0.45, -0.25, 0, 0, 0, -0.3];
    // the mitt: from the catch up to the chest (the ball's taken out of it at `take`), then out
    // in front pointing the way, then down
    const mitt = [V(-0.05, 0.62, -0.26), V(-0.1, 0.24 + 0.52, -0.14), V(-0.2, HIP + 0.55, -0.24), V(-0.24, HIP + 0.5, -0.2), V(-0.3, HIP + 0.3, -0.1), V(-0.2, 0.55, -0.2)];
    const up = V(0.05, 1, -0.1),
      fwd = V(0.1, 0.1, -1);
    const mittDir = [V(0, 1, 0.1), V(0.2, 0.9, 0.2), up, up, V(-0.2, -0.3, -0.9), V(0, 1, 0.1)];
    const mittFace = [V(0, 0.05, -1), V(0.9, 0.1, -0.3), fwd, fwd, V(1, 0, 0), V(0, 0.05, -1)];
    const hand = [V(0.3, 0.3, 0.12), V(), V(0.26, HIP - 0.035 + 0.83, 0.16), V(), V(0.06, HIP - 0.04 + 0.5, -0.36), V(0.3, 0.3, 0.12)];
    const S = V(),
      Q = V(),
      o = V();
    // at `take`: the ball on the mitt's pocket
    rot(o, 0.2 * g, SH_Y, 0, pitch[1], yaw[1], 0);
    set(S, o.x + body[1].x, o.y + body[1].y, o.z + body[1].z);
    const dir = norm(set(o, mittDir[1].x, mittDir[1].y, mittDir[1].z)) ? o : up;
    const face = V(mittFace[1].x, mittFace[1].y, mittFace[1].z);
    norm(face);
    ortho(dir, face);
    slotAxesTo(dir, face, MITT.pocket, Q);
    set(Q, Q.x + mitt[1].x, Q.y + mitt[1].y, Q.z + mitt[1].z);
    this.handFor(hand[1], S, Q);
    // at `release`: the ball on the toss's starting point
    rot(o, 0.2 * g, SH_Y, 0, pitch[3], yaw[3], 0);
    set(S, o.x + body[3].x, o.y + body[3].y, o.z + body[3].z);
    set(Q, TOSS.x / sc, TOSS.y / sc, TOSS.z / sc);
    this.handFor(hand[3], S, Q);
    this.tk = { t, body, pitch, yaw, feet0, feet1, footPitch, mitt, mittDir, mittFace, hand };
    return this.tk;
  }

  /** The hand that puts the ball (BALL_OUT on along the arm from shoulder S) at Q. */
  private handFor(o: V3, S: V3, Q: V3) {
    const d = dist(Q, S);
    const k = 1 - BALL_OUT / Math.max(BALL_OUT * 1.5, d);
    return set(o, S.x + (Q.x - S.x) * k, S.y + (Q.y - S.y) * k, S.z + (Q.z - S.z) * k);
  }

  /** A ball in play: stand up, the mask off, and follow it. */
  private watch(T: CatchTargets, t: number, s: CatcherState) {
    const u = s.t;
    const P = this.pose;
    const l = s.look;
    const k = smooth(clamp(u / 0.35));
    // turn towards the ball if it went behind (a foul): the root follows it
    let yaw = 0;
    if (l) {
      const dx = l.x - s.x,
        dz = l.z - s.z;
      if (dx * dx + dz * dz > 0.25 && dz > -1) yaw = Math.atan2(-dx, -dz);
    }
    T.rootYaw = yaw;
    const br = Math.sin(t * 2) * 0.005;
    set(T.body, 0, lerp(0.17, HIP - 0.01, k) + br, 0);
    T.pitch = lerp(-0.2, 0.02, k);
    T.yaw = 0;
    T.roll = 0;
    set(T.feet[0], lerp(-0.3, -0.16, k), lerp(0.03, 0, k), 0.02);
    set(T.feet[1], lerp(0.3, 0.16, k), lerp(0.03, 0, k), 0.02);
    T.footPitch[0] = T.footPitch[1] = lerp(-0.45, 0, k);
    // the mitt down at the side, pocket in
    set(T.mitt, -0.3, 0.52 + T.body.y - HIP, -0.1);
    set(T.mittDir, -0.2, -0.3, -0.9);
    norm(T.mittDir);
    set(T.mittFace, 1, 0, 0);
    ortho(T.mittDir, T.mittFace);
    // the throwing hand: to the face, the mask off, held out at the side
    if (u < MASK.grab) {
      const g = smooth(u / MASK.grab);
      set(this.a, 0.3, 0.3, 0.12);
      set(this.b, 0.02, P.body.y + 1.02, -0.3);
      lerpV(T.hand, this.a, this.b, g);
    } else if (u < MASK.off) {
      const g = smooth((u - MASK.grab) / (MASK.off - MASK.grab));
      set(this.a, 0.02, P.body.y + 1.02, -0.3);
      set(this.b, 0.36, P.body.y + 0.75, -0.18);
      lerpV(T.hand, this.a, this.b, g);
    } else set(T.hand, 0.36, P.body.y + 0.55, -0.08);
    if (!gazeAt(T.gaze, l)) gazeDir(T.gaze, P.yaw, 0.35);
    T.lam = 8;
    T.armLam = u < MASK.off ? 18 : 8;
    T.eyes = 'wide';
    T.mouth = 'o';
    T.brow = 0.8;
  }
}
