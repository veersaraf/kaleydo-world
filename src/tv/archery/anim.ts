// The archer: turns an ArcherState into a Pose for the tennis Rig, with the bow
// in the rig's racket slot (see bow.ts). Conventions as in chars/anim.ts and
// duel/anim.ts: root-local space, x right, y up, −z forward, unscaled (the rig
// scales the root); + bodyPitch leans back, + headPitch looks up, + yaws turn
// to the left.
//
// Archery is shot side-on. A right-hander stands with the left shoulder to the
// target, the bow in the left hand, drawing with the right: so hands[0] (the
// rig's racket hand, which holds the bow) is on the *non*-dominant side and
// Pose.handed = −handed; hands[1] is the draw hand. The root turns side-on (a
// little open), the chest turns with the aim so the shoulders stay in line with
// the arrow, and the waist bends for high and low shots.
//
// While drawing, both hands sit on the arrow's line, which leaves the anchor
// (at the draw-side cheek) exactly along the aim: the draw hand holds the
// string (the gear bends the string to it) and the arrow rests over the bow
// hand. As `draw` goes 0 → 1 the draw hand comes back to the anchor and the bow
// arm pushes out until it's straight. The draw arm's elbow — which the rig's IK
// would drop — is lifted into line behind the arrow by ArcheryGear.

import { newPose, type Pose, type EyeState, type MouthState } from '../chars/pose';
import { CHAR_SCALE, HIP, TORSO } from '../chars/rig';
import type { Look } from '../chars/look';
import { clamp, lerp, smooth, damp, dampAngle, angleDiff, Rng, type V3 } from '../core/math';
import { RANGE } from './range';
import type { ArcherState } from './types';

/** Where the bow meets the hands (root units): the bow and the animator share these. */
export const GRIP = {
  /** brace height: the string sits this far behind the grip at rest */
  brace: 0.13,
  /** the arrow rests this far up the bow from the grip's centre (just over the hand) */
  restY: 0.075,
};

/** The shooting line's platform (world metres): the archer stands on it; the range builds it. */
export const LINE = {
  top: 0.08,
  halfW: 2.7,
  /** its front and back edges (z) */
  front: RANGE.lineZ - 0.85,
  back: RANGE.lineZ + 1.45,
};

/** Nocking, seconds into the 'nock' phase: the draw hand is at the quiver, has the arrow out, has it on the string. */
export const NOCK = { quiver: 0.28, take: 0.34, seat: 0.66 };

/** shoulder height above the body origin (as in Rig.apply) */
const SH_Y = 0.47 * TORSO;
/** the hip lines: feet[0] is the left leg, feet[1] the right */
const HIP_X = [-0.11, 0.11];
/** the feet stand a little wider than the hips */
const STANCE = 1.55;
/** an open stance: the root turns this much from square-on side towards the target */
const OPEN = 0.3;
/** the anchor: the draw hand at the jaw, body frame (x towards the bow side, forward of the chest) */
const ANCHOR = { x: 0.155, y: 0.8, z: 0.215 };
/** a straight bow arm, shoulder to grip (a touch past the rig's 0.5: cartoon stretch) */
const ARM = 0.6;
/** at draw = 0 the draw hand holds the string this far in front of the anchor */
const REACH = 0.3;

const V = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const set = (o: V3, x: number, y: number, z: number) => ((o.x = x), (o.y = y), (o.z = z), o);
const cp = (o: V3, a: V3) => set(o, a.x, a.y, a.z);
const lerpV = (o: V3, a: V3, b: V3, t: number) => set(o, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
const dampV = (o: V3, b: V3, lambda: number, dt: number) => lerpV(o, o, b, 1 - Math.exp(-lambda * dt));
const addS = (o: V3, a: V3, k: number) => set(o, o.x + a.x * k, o.y + a.y * k, o.z + a.z * k);
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
function norm(o: V3) {
  const l = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z);
  if (l < 1e-6) return false;
  o.x /= l;
  o.y /= l;
  o.z /= l;
  return true;
}

interface Targets {
  /** the root's yaw (side-on, or turned to the camera for a cheer) */
  rootYaw: number;
  body: V3;
  pitch: number;
  yaw: number;
  roll: number;
  feet: [V3, V3];
  footPitch: [number, number];
  /** bow hand (grip), the bow's up axis and its back (towards the string) — root space */
  hand: V3;
  dir: V3;
  face: V3;
  /** draw hand */
  off: V3;
  lam: number;
  armLam: number;
  offLam: number;
  feetLam: number;
  hop: number;
  /** where the head looks: a world yaw (0 = down the range, + left) and pitch */
  lookYaw: number;
  lookPitch: number;
  headRoll: number;
  eyes: EyeState;
  mouth: MouthState;
  brow: number;
}

/** The pose of the arms along the arrow's line, in the body frame (see aimLine). */
interface Line {
  /** the arrow's direction, the anchor, the bow's up axis */
  d: V3;
  a: V3;
  up: V3;
  /** anchor → the arrow rest at full draw */
  full: number;
}

export class ArcherAnimator {
  pose: Pose = newPose();
  /** root units → metres */
  readonly scale: number;

  private phase: ArcherState['phase'] | '' = '';
  private rng = new Rng();
  private blinkAt = 0;
  private blinkT = 0;
  private squash = 1;
  private squashV = 0;
  private lastJump = 0;
  private headPitch = 0;
  private headYaw = 0;
  private started = false;
  /** the draw when the arrow went (the release plays out from there), and the last one seen while drawing */
  private relDraw = 1;
  private lastDraw = 0;
  /** walking: where the root was last frame, its smoothed local velocity and the stride's phase */
  private lastX = 0;
  private lastZ = 0;
  private walkVx = 0;
  private walkVz = 0;
  private walkPh = 0;
  private tg: Targets = {
    rootYaw: 0,
    body: V(0, HIP, 0),
    pitch: 0,
    yaw: 0,
    roll: 0,
    feet: [V(), V()],
    footPitch: [0, 0],
    hand: V(),
    dir: V(0, 1, 0),
    face: V(0, 0, 1),
    off: V(),
    lam: 10,
    armLam: 14,
    offLam: 14,
    feetLam: 12,
    hop: 0,
    lookYaw: 0,
    lookPitch: 0,
    headRoll: 0,
    eyes: 'open',
    mouth: 'smile',
    brow: 0,
  };
  private ln: Line = { d: V(-1, 0, 0), a: V(), up: V(0, 1, 0), full: 0.5 };
  /** the set position's line (kept apart: it's blended with the aim's) */
  private lnSet: Line = { d: V(-1, 0, 0), a: V(), up: V(0, 1, 0), full: 0.5 };
  // scratch (update() allocates nothing): s* inside onLine / nock, b* for poses being blended, q for set()
  private s1 = V();
  private s2 = V();
  private s3 = V();
  private s4 = V();
  private b1 = V();
  private b2 = V();
  private b3 = V();
  private b4 = V();
  private q = V();

  constructor(
    public handed: 1 | -1,
    public look: Look,
  ) {
    this.scale = CHAR_SCALE * (look.height || 1);
    this.pose.handed = handed === 1 ? -1 : 1;
    this.pose.body.y = HIP;
    this.blinkAt = this.rng.range(1, 3.5);
  }

  /** The root's yaw for the side-on stance (world: + turns left): a right-hander's chest faces +x. */
  static stanceYaw(handed: 1 | -1) {
    return -handed * (Math.PI / 2 - OPEN);
  }

  update(t: number, dt: number, s: ArcherState): Pose {
    const P = this.pose;
    const T = this.tg;
    dt = Math.max(1e-4, Math.min(dt, 0.1));
    const hs = s.handed ?? this.handed;
    // the bow is in hands[0]: the non-dominant side
    P.handed = hs === 1 ? -1 : 1;
    P.x = s.x;
    P.z = s.z;
    P.holdingBall = false;
    P.tired = 0;
    P.legLift = 0;
    if (!this.started) this.first(s, hs);
    this.measureWalk(s, dt);
    if (s.phase !== this.phase) this.enter(s);
    if (s.phase === 'draw' || s.phase === 'hold') this.lastDraw = clamp(s.draw);

    // defaults: the side-on stance, looking down the range
    T.rootYaw = ArcherAnimator.stanceYaw(hs);
    T.lam = 9;
    T.armLam = 12;
    T.offLam = 12;
    T.feetLam = 12;
    T.hop = 0;
    T.lookYaw = s.yaw;
    T.lookPitch = s.pitch;
    T.headRoll = 0;
    T.eyes = 'open';
    T.mouth = 'smile';
    T.brow = 0;
    this.stance(T, t);
    let hop: number | null = null;
    let jump = false;

    switch (s.phase) {
      case 'idle': {
        this.relaxed(T, hs, t);
        T.lookYaw = Math.sin(t * 0.37) * 0.25;
        T.lookPitch = -0.05;
        break;
      }
      case 'nock': {
        this.nock(T, hs, s);
        break;
      }
      case 'draw':
      case 'hold': {
        // raise the bow into the aim as the draw starts, then hold it there
        const up = s.phase === 'hold' ? 1 : smooth(clamp(s.t / 0.3));
        const draw = clamp(s.draw);
        this.aimLine(T, hs, s.yaw, s.pitch, 0);
        this.onLine(T, hs, draw, 0, 0);
        if (up < 1) {
          // from the set position (bow low, on the string)
          this.set(T, hs, this.b1, this.b2, this.b3, this.b4);
          lerpV(T.hand, this.b1, T.hand, up);
          lerpV(T.off, this.b2, T.off, up);
          lerpV(T.dir, this.b3, T.dir, up);
          norm(T.dir);
          lerpV(T.face, this.b4, T.face, up);
        }
        if (s.phase === 'hold') this.tremble(T, t, s.t);
        T.armLam = 16;
        T.offLam = 22;
        T.eyes = 'focus';
        T.mouth = 'flat';
        T.brow = s.phase === 'hold' ? 0.9 : 0.6;
        T.headRoll = -(hs === 1 ? -1 : 1) * 0.12 * up;
        break;
      }
      case 'release': {
        this.aimLine(T, hs, s.yaw, s.pitch, 0);
        const u = s.t;
        this.onLine(T, hs, this.relDraw, 1 - Math.exp(-u / 0.045), 1 - Math.exp(-u / 0.11));
        T.armLam = 30;
        T.offLam = 45;
        T.eyes = u < 0.12 ? 'focus' : 'open';
        T.mouth = 'o';
        T.brow = 0.7;
        break;
      }
      case 'watch': {
        // hold the follow-through, then ease the bow down and watch it fly
        this.aimLine(T, hs, s.yaw, s.pitch, 0);
        this.onLine(T, hs, this.relDraw, 1, 1);
        const k = smooth(clamp((s.t - 0.5) / 0.9));
        if (k > 0) {
          // the lowered bow: the same line tipped down, the arm a little bent
          this.aimLine(T, hs, s.yaw, s.pitch - 0.55, 0.17);
          this.onLine(T, hs, 0.35, 1, 1);
          cp(this.b1, T.hand);
          cp(this.b3, T.dir);
          cp(this.b4, T.face);
          this.aimLine(T, hs, s.yaw, s.pitch, 0);
          this.onLine(T, hs, this.relDraw, 1, 1);
          lerpV(T.hand, T.hand, this.b1, k * 0.7);
          lerpV(T.dir, T.dir, this.b3, k * 0.7);
          norm(T.dir);
          lerpV(T.face, T.face, this.b4, k * 0.7);
          // the draw hand comes down to the side
          this.local(this.b2, T, hs * 0.3, 0.42, -0.08);
          lerpV(T.off, T.off, this.b2, k);
        }
        T.lookYaw = s.yaw;
        T.lookPitch = s.pitch - 0.05;
        T.armLam = 7;
        T.offLam = 6;
        T.eyes = 'open';
        T.mouth = 'o';
        T.brow = 0.5;
        break;
      }
      case 'cheer': {
        // turn to the camera and jump for joy, bow held high
        const u = s.t;
        T.rootYaw = -hs * 2.75;
        const j = u < 1.4 ? Math.max(0, Math.sin(u * Math.PI * 1.55)) : Math.abs(Math.sin(u * 5.2)) * 0.05;
        jump = true;
        if (j < 0.02 && this.lastJump > 0.05) this.squashV -= 1.3;
        this.lastJump = j;
        hop = j * 0.3;
        T.yaw = 0;
        T.pitch = 0.1;
        T.roll = 0;
        set(T.feet[0], HIP_X[0] * 1.3, j * 0.08, 0);
        set(T.feet[1], HIP_X[1] * 1.3, j * 0.08, 0);
        T.footPitch[0] = T.footPitch[1] = -0.4 * j;
        const pump = u < 1.4 ? Math.sin(u * 12) * 0.05 : 0;
        // the bow up in the air (bow hand on the bow side), the other fist pumping
        set(T.hand, -hs * 0.4, 1.62 + pump * 0.5, -0.08);
        set(T.dir, -hs * 0.25, 1, 0.1);
        norm(T.dir);
        set(T.face, hs, 0, 0);
        set(T.off, hs * 0.38, 1.5 - pump, -0.12);
        T.lookYaw = this.camYaw(hs);
        T.lookPitch = 0.12;
        T.armLam = 13;
        T.offLam = 16;
        T.lam = 11;
        T.eyes = 'happy';
        T.mouth = 'grin';
        T.brow = 0.3;
        break;
      }
      case 'sad': {
        // deflate: the bow droops to the ground, head down, a slow shake
        const u = s.t;
        const sigh = Math.sin(clamp(u / 1.4) * Math.PI) * 0.03;
        T.body.y = HIP - 0.07 - sigh;
        T.pitch = -0.4;
        T.yaw = -hs * OPEN * 0.6;
        T.roll = 0;
        this.local(T.hand, T, -hs * 0.32, 0.4, -0.2);
        this.localDir(T.dir, T, -hs * 0.35, 0.8, -0.45);
        this.localDir(T.face, T, hs * 0.8, 0, 0.5);
        // the other hand on the back of the head
        this.local(T.off, T, hs * 0.14, 1.07, 0.14);
        T.lookYaw = s.yaw * 0.5;
        T.lookPitch = -0.95;
        T.headRoll = Math.sin(u * 5.5) * 0.18 * Math.max(0, 1 - u / 1.8);
        T.armLam = 5;
        T.offLam = 7;
        T.lam = 5;
        T.eyes = 'sad';
        T.mouth = 'frown';
        T.brow = -1;
        break;
      }
    }
    if (s.phase === 'idle' || s.phase === 'nock') this.walk(T, !jump);

    // ------------------------------------------------ root and body
    const standY = onLine(s.x, s.z) ? LINE.top : 0;
    P.yaw = Number.isFinite(P.yaw) ? dampAngle(P.yaw, T.rootYaw, s.phase === 'cheer' ? 7 : 9, dt) : T.rootYaw;
    dampV(P.body, T.body, T.lam, dt);
    P.bodyPitch = damp(P.bodyPitch, T.pitch, T.lam, dt);
    P.bodyYaw = P.bodyYaw + angleDiff(P.bodyYaw, T.yaw) * (1 - Math.exp(-T.lam * dt));
    P.bodyRoll = damp(P.bodyRoll, T.roll, T.lam, dt);
    P.hop = standY + (hop ?? T.hop);

    // squash spring (landings, the release)
    this.squashV += (1 - this.squash) * 180 * dt;
    this.squashV *= Math.exp(-14 * dt);
    this.squash += this.squashV * dt;
    P.squash = this.squash;

    // ------------------------------------------------ feet
    for (let i = 0; i < 2; i++) {
      dampV(P.feet[i], T.feet[i], T.feetLam, dt);
      P.footPitch[i] = damp(P.footPitch[i], T.footPitch[i], T.feetLam, dt);
    }

    // ------------------------------------------------ hands and bow
    dampV(P.hands[0], T.hand, T.armLam, dt);
    const k = 1 - Math.exp(-T.armLam * dt);
    lerpV(P.racketDir, P.racketDir, T.dir, k);
    if (!norm(P.racketDir)) cp(P.racketDir, T.dir);
    lerpV(P.racketFace, P.racketFace, T.face, k);
    orthoFace(P.racketDir, P.racketFace);
    dampV(P.hands[1], T.off, T.offLam, dt);

    // ------------------------------------------------ head: aim it at a world yaw / pitch from the body it sits on
    const hy = wrap(T.lookYaw - P.yaw - P.bodyYaw);
    const turn = clamp(hy, -1.75, 1.75);
    const hp = T.lookPitch - P.bodyPitch * Math.cos(turn) + P.bodyRoll * Math.sin(turn);
    this.headYaw = damp(this.headYaw, turn, 10, dt);
    this.headPitch = damp(this.headPitch, clamp(hp, -1.1, 0.9), 10, dt);
    P.headYaw = this.headYaw;
    P.headPitch = this.headPitch;
    P.headRoll = T.headRoll + Math.sin(t * 1.3) * 0.02;

    // ------------------------------------------------ face
    this.blinkT -= dt;
    if (t > this.blinkAt) {
      this.blinkT = 0.11;
      this.blinkAt = t + this.rng.range(1.8, 4.6);
    }
    // no blinking while aiming or beaming
    const intense = T.eyes === 'happy' || T.eyes === 'focus';
    P.blink = this.blinkT > 0 && !intense ? 1 : 0;
    P.eyes = T.eyes;
    P.mouth = T.mouth;
    P.brow = damp(P.brow, T.brow, 12, dt);
    return P;
  }

  // ---------------------------------------------------------------- phases

  private first(s: ArcherState, hs: 1 | -1) {
    this.started = true;
    this.lastX = s.x;
    this.lastZ = s.z;
    const P = this.pose;
    const T = this.tg;
    P.yaw = ArcherAnimator.stanceYaw(hs);
    T.rootYaw = P.yaw;
    this.stance(T, 0);
    this.relaxed(T, hs, 0);
    cp(P.body, T.body);
    P.bodyYaw = T.yaw;
    for (let i = 0; i < 2; i++) cp(P.feet[i], T.feet[i]);
    cp(P.hands[0], T.hand);
    cp(P.hands[1], T.off);
    cp(P.racketDir, T.dir);
    cp(P.racketFace, T.face);
  }

  private enter(s: ArcherState) {
    const prev = this.phase;
    this.phase = s.phase;
    if (s.phase === 'release') {
      // the draw it was let go at (a flinch at a light draw doesn't fly far)
      // (the game may already have let the string go: use the draw it had a frame ago)
      this.relDraw = prev === 'draw' || prev === 'hold' ? Math.max(this.lastDraw, s.draw, 0.35) : 1;
      this.squashV += 0.6;
    }
    if (s.phase === 'sad') this.squashV -= 0.5;
    this.lastJump = 0;
  }

  /** The feet and hips of the side-on stance (in the root, which is turned side-on). */
  private stance(T: Targets, t: number) {
    const breath = Math.sin(t * 1.6) * 0.004;
    set(T.body, 0, HIP - 0.012 + breath, 0);
    T.pitch = -0.02;
    T.yaw = 0;
    T.roll = 0;
    set(T.feet[0], HIP_X[0] * STANCE, 0, 0.01);
    set(T.feet[1], HIP_X[1] * STANCE, 0, 0.01);
    T.footPitch[0] = T.footPitch[1] = 0;
  }

  /** Standing easy, chest half turned to the range, the bow resting on its lower tip by the front foot. */
  private relaxed(T: Targets, hs: number, t: number) {
    T.yaw = wrap(-T.rootYaw - hs * Math.PI * 0.28);
    const sway = Math.sin(t * 0.9) * 0.008;
    this.local(T.hand, T, -hs * 0.3, 0.28 + sway, -0.17);
    this.localDir(T.dir, T, -hs * 0.14, 1, -0.2);
    this.localDir(T.face, T, hs, 0, 0.2);
    this.local(T.off, T, hs * 0.29, 0.42 - sway, -0.04);
    T.armLam = 8;
    T.offLam = 8;
  }

  /** Take an arrow from the quiver at the hip and put it on the string, the bow held low and forward. */
  private nock(T: Targets, hs: number, s: ArcherState) {
    const u = s.t;
    this.aimLine(T, hs, s.yaw, s.pitch, 0);
    this.set(T, hs, T.hand, this.s2, T.dir, T.face);
    // the draw hand: to the quiver, the arrow out, then on the string
    const Q = this.s1;
    this.local(Q, T, hs * 0.3, 0.3, 0.16);
    if (u < NOCK.take) {
      cp(T.off, Q);
      T.offLam = 14;
    } else if (u < NOCK.seat) {
      // lift it clear of the quiver, then bring it over to the bow
      const k = smooth(clamp((u - NOCK.take) / (NOCK.seat - NOCK.take)));
      this.local(this.s3, T, hs * 0.26, 0.72, 0.02);
      if (k < 0.5) lerpV(T.off, Q, this.s3, k * 2);
      else lerpV(T.off, this.s3, this.s2, (k - 0.5) * 2);
      T.offLam = 26;
    } else {
      cp(T.off, this.s2);
      T.offLam = 16;
    }
    T.armLam = 9;
    // watch your hands, then look up at the target
    const look = u > NOCK.seat + 0.15;
    T.lookYaw = look ? s.yaw : s.yaw * 0.3 + hs * 0.25;
    T.lookPitch = look ? s.pitch : -0.55;
    T.eyes = 'open';
    T.mouth = look ? 'flat' : 'smile';
    T.brow = look ? 0.4 : 0.1;
  }

  /**
   * The set position (nocked, before the draw): the bow held low and forward,
   * the arrow pointing at the ground a few metres out, the draw hand on the
   * string. Writes the grip, the draw hand and the bow's axes (root space).
   */
  private set(T: Targets, hs: number, hand: V3, off: V3, dir: V3, face: V3) {
    const L = this.lnSet;
    // the line from low in front of the belly, tipped down towards the target
    const a = L.a,
      d = L.d;
    const pr = -0.55;
    set(d, -hs * Math.cos(pr), Math.sin(pr), 0);
    set(a, -hs * 0.17, 0.52, -0.25);
    set(L.up, -d.y * d.x, 1 - d.y * d.y, -d.y * d.z);
    norm(L.up);
    // the string hand, and the grip under the arrow rest
    const q = this.q;
    set(q, a.x + d.x * 0.1, a.y + d.y * 0.1, a.z + d.z * 0.1);
    this.localV(off, T, q);
    const reach = 0.1 + GRIP.brace;
    set(q, a.x + d.x * reach - L.up.x * GRIP.restY, a.y + d.y * reach - L.up.y * GRIP.restY, a.z + d.z * reach - L.up.z * GRIP.restY);
    this.localV(hand, T, q);
    this.localDirV(dir, T, L.up);
    this.localDir(face, T, -d.x, -d.y, -d.z);
  }

  /**
   * The aiming frame: turns the chest so the shoulders line up with the aim
   * (world yaw / pitch), bends the waist for high or low shots, and works out
   * the arrow's line in the body frame — its direction, the anchor at the
   * cheek, and how far along it the bow hand is at full draw with the bow arm
   * straight. `drop` lowers the anchor (a lowered bow).
   */
  private aimLine(T: Targets, hs: number, yaw: number, pitch: number, drop: number) {
    const L = this.ln;
    // shoulders in line with the aim (the root is side-on)
    T.yaw = wrap(yaw - T.rootYaw - hs * (Math.PI / 2));
    const lean = clamp(pitch * 0.45, -0.22, 0.32);
    T.roll = -hs * lean;
    T.pitch = -0.02;
    const pr = pitch - lean;
    set(L.d, -hs * Math.cos(pr), Math.sin(pr), 0);
    set(L.a, -hs * ANCHOR.x, ANCHOR.y - drop, -ANCHOR.z);
    // the bow's up axis: square to the arrow, in the vertical plane
    set(L.up, -L.d.y * L.d.x, 1 - L.d.y * L.d.y, -L.d.y * L.d.z);
    norm(L.up);
    // the bow arm straight: |a + d·D − shoulder| = ARM
    const g = this.look.girth || 1;
    const wx = L.a.x + hs * 0.2 * g,
      wy = L.a.y - SH_Y,
      wz = L.a.z;
    const wd = wx * L.d.x + wy * L.d.y + wz * L.d.z;
    const disc = wd * wd - (wx * wx + wy * wy + wz * wz) + ARM * ARM;
    L.full = disc > 0 ? Math.max(REACH + GRIP.brace + 0.05, -wd + Math.sqrt(disc)) : 0.5;
  }

  /**
   * Both hands on the arrow's line (after aimLine): the draw hand on the
   * string `draw` of the way back to the anchor, the grip under the arrow
   * rest. `snap` (0..1) throws the draw hand back after the release; `tip`
   * (0..1) lets the bow roll forward in the hand.
   */
  private onLine(T: Targets, hs: number, draw: number, snap: number, tip: number) {
    const L = this.ln;
    const d = L.d,
      a = L.a,
      up = L.up;
    // the draw hand: from REACH in front of the anchor back to it; after the release, on past it
    const back = REACH * (1 - draw);
    set(this.s1, a.x + d.x * back, a.y + d.y * back, a.z + d.z * back);
    if (snap > 0) {
      // back along the jaw towards the shoulder, fingers open
      this.s1.x += hs * 0.2 * snap;
      this.s1.y += 0.02 * snap;
      this.s1.z += 0.08 * snap;
    }
    this.localV(T.off, T, this.s1);
    // the arrow rest, and the grip under it
    const along = lerp(REACH + GRIP.brace, L.full, draw) + 0.02 * snap;
    const rx = a.x + d.x * along,
      ry = a.y + d.y * along,
      rz = a.z + d.z * along;
    const u = this.s2;
    cp(u, up);
    if (tip > 0) {
      // the bow falls forward in the hand after the shot (the top towards the target)
      const th = 0.6 * tip;
      set(u, up.x * Math.cos(th) + d.x * Math.sin(th), up.y * Math.cos(th) + d.y * Math.sin(th), up.z * Math.cos(th) + d.z * Math.sin(th));
    }
    // the grip stays in the hand: the bow turns about it
    set(this.s3, rx - up.x * GRIP.restY, ry - up.y * GRIP.restY, rz - up.z * GRIP.restY);
    this.localV(T.hand, T, this.s3);
    this.localDirV(T.dir, T, u);
    // the bow's back faces the archer: square to its up axis
    set(this.s4, -d.x, -d.y, -d.z);
    if (tip > 0) {
      const th = 0.6 * tip;
      set(this.s4, -d.x * Math.cos(th) + up.x * Math.sin(th), -d.y * Math.cos(th) + up.y * Math.sin(th), -d.z * Math.cos(th) + up.z * Math.sin(th));
    }
    this.localDirV(T.face, T, this.s4);
  }

  /** A tiny tremble at full draw, growing the longer it's held. */
  private tremble(T: Targets, t: number, held: number) {
    const a = 0.0025 + 0.004 * clamp((held - 1) / 3);
    const nx = Math.sin(t * 31) * 0.6 + Math.sin(t * 19.7 + 1.3) * 0.4;
    const ny = Math.sin(t * 27.3 + 2.1) * 0.6 + Math.sin(t * 13.1 + 0.4) * 0.4;
    const nz = Math.sin(t * 23.9 + 4.2) * 0.5 + Math.sin(t * 9.3) * 0.5;
    // both hands together: the arrow's line shakes, it doesn't bend
    set(T.hand, T.hand.x + nx * a, T.hand.y + ny * a, T.hand.z + nz * a);
    set(T.off, T.off.x + nx * a, T.off.y + ny * a, T.off.z + nz * a);
  }

  /** The world yaw from the archer towards the gameplay camera (behind, off the draw shoulder). */
  private camYaw(hs: number) {
    return -hs * 2.8;
  }

  // ---------------------------------------------------------------- walking

  /** The root's velocity in its own frame (the game moves it; a jump means a teleport, not a sprint). */
  private measureWalk(s: ArcherState, dt: number) {
    const dx = s.x - this.lastX,
      dz = s.z - this.lastZ;
    this.lastX = s.x;
    this.lastZ = s.z;
    let vx = dx / dt,
      vz = dz / dt;
    if (vx * vx + vz * vz > 144) vx = vz = 0;
    // world → root
    const y = this.pose.yaw;
    const c = Math.cos(y),
      sn = Math.sin(y);
    const lx = c * vx - sn * vz,
      lz = sn * vx + c * vz;
    const k = 1 - Math.exp(-10 * dt);
    this.walkVx += (lx - this.walkVx) * k;
    this.walkVz += (lz - this.walkVz) * k;
    const sp = Math.sqrt(this.walkVx * this.walkVx + this.walkVz * this.walkVz);
    this.walkPh += ((sp * dt) / 0.9) * Math.PI * 2;
  }

  /** Stepping feet and a bob, along the way the root is moving. */
  private walk(T: Targets, grounded: boolean) {
    const sp = Math.sqrt(this.walkVx * this.walkVx + this.walkVz * this.walkVz);
    const run = clamp((sp - 0.15) / 1.2);
    if (run <= 0 || !grounded) return;
    const dx = this.walkVx / sp,
      dz = this.walkVz / sp;
    for (let i = 0; i < 2; i++) {
      const ph = this.walkPh + i * Math.PI;
      const stride = Math.sin(ph) * 0.2 * run;
      T.feet[i].x += dx * stride;
      T.feet[i].z += dz * stride;
      T.feet[i].y = Math.max(T.feet[i].y, Math.max(0, Math.cos(ph)) * 0.1 * run);
      T.footPitch[i] = -Math.cos(ph) * 0.3 * run;
    }
    T.body.y += Math.abs(Math.sin(this.walkPh)) * 0.035 * run;
    T.feetLam = Math.max(T.feetLam, 22);
  }

  // ---------------------------------------------------------------- body frame → root

  /** A point given in the (target) body's frame, in root space. */
  private local(o: V3, T: Targets, x: number, y: number, z: number) {
    this.rot(o, T, x, y, z);
    return set(o, o.x + T.body.x, o.y + T.body.y, o.z + T.body.z);
  }

  private localV(o: V3, T: Targets, v: V3) {
    return this.local(o, T, v.x, v.y, v.z);
  }

  /** A direction given in the body's frame, in root space. */
  private localDir(o: V3, T: Targets, x: number, y: number, z: number) {
    this.rot(o, T, x, y, z);
    norm(o);
    return o;
  }

  private localDirV(o: V3, T: Targets, v: V3) {
    return this.localDir(o, T, v.x, v.y, v.z);
  }

  /** Rotate by the body's YXZ Euler angles (as Rig.apply does: roll, then pitch, then yaw). */
  private rot(o: V3, T: Targets, x: number, y: number, z: number) {
    const cr = Math.cos(T.roll),
      sr = Math.sin(T.roll);
    let X = x * cr - y * sr,
      Y = x * sr + y * cr,
      Z = z;
    const cpch = Math.cos(T.pitch),
      spch = Math.sin(T.pitch);
    const Y2 = Y * cpch - Z * spch;
    Z = Y * spch + Z * cpch;
    Y = Y2;
    const cy = Math.cos(T.yaw),
      sy = Math.sin(T.yaw);
    const X2 = X * cy + Z * sy;
    Z = -X * sy + Z * cy;
    X = X2;
    return set(o, X, Y, Z);
  }
}

/** Is (x, z) on the shooting line's platform? */
export function onLine(x: number, z: number) {
  return Math.abs(x) <= LINE.halfW && z >= LINE.front && z <= LINE.back;
}

function wrap(a: number) {
  return angleDiff(0, a);
}

/** Keep the bow's back square to its up axis. */
function orthoFace(d: V3, f: V3) {
  const k = dot(f, d);
  addS(f, d, -k);
  if (norm(f)) return;
  set(f, 0, 0, 1);
  addS(f, d, -d.z);
  if (!norm(f)) set(f, 1, 0, 0);
}
