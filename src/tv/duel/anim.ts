// The duellist: turns a FighterState into a Pose for the tennis Rig, whose
// racket slot holds the sword (see sword.ts). Conventions as in chars/anim.ts:
// root-local space, x right, y up, −z forward (towards the opponent), unscaled
// (the rig scales the root); hands[0] is the sword hand and handedness mirrors
// x. The rig's signs: + bodyPitch leans back, + headPitch looks up, + bodyYaw
// turns the chest to the left.
//
// The blade is Pose.racketDir (hilt → tip) and its cutting edge Pose.racketFace.
// A fighter's own frame (x right, y up, z towards the opponent) is root space
// as (x, y, −z); the root itself is turned by `facing`. Whenever the fighter
// holds the sword (idle, ready, guard, recover) the blade points exactly where
// `aim` says, and the hand goes where that blade sits naturally: at the side
// when relaxed, centred in front of the body in a guard, so the blade covers
// it. Slashes sweep the blade through the plane of "forward" and the slash's
// direction, from the start side to the follow-through.

import { newPose, type Pose, type EyeState, type MouthState } from '../chars/pose';
import { CHAR_SCALE, HIP, TORSO, HEAD } from '../chars/rig';
import type { Look } from '../chars/look';
import { clamp, lerp, smooth, damp, easeOutBack, Rng, type V3 } from '../core/math';
import { ARENA, FALL_T, fallY } from './arena';
import type { FighterState, FighterPhase, SwordAim } from './types';
import { SWORD } from './sword';

/** shoulder height above the body origin (as in Rig.apply) */
const SH_Y = 0.47 * TORSO;
/** head centre above the body origin, and its radius */
const HEAD_Y = 0.62 * TORSO + 0.3 * HEAD * 0.8;
const HEAD_R = 0.3 * HEAD + 0.04;
/** the torso as a capsule: from the body origin up this far, this thick */
const TORSO_H = 0.6 * TORSO;
const TORSO_R = 0.29;
/** the hip lines: feet[0] is the left leg, feet[1] the right */
const HIP_X = [-0.11, 0.11];
/** grip → tip (the trail and the floor check use it) */
const BLADE = SWORD.tip;
/** the hand never goes below this (root units above the deck) */
const FLOOR = 0.12;

/** how fast the sword hand and blade follow the pose in ready / guard (1/s): the phone's live pose already
 *  arrives carried on to now (Input.oriNow), so this only hides the last bit of stepping — at the old 16–18 the
 *  blade trailed the phone by ~60 ms on top of the network's */
const ARM_FOLLOW = 60;

/** slash arc: where it starts from a windup, from a live swing, and how long it takes */
const TH_WINDUP = -2.15;
const TH_LIVE = -1.55;

const V = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const set = (o: V3, x: number, y: number, z: number) => ((o.x = x), (o.y = y), (o.z = z), o);
const cp = (o: V3, a: V3) => set(o, a.x, a.y, a.z);
const lerpV = (o: V3, a: V3, b: V3, t: number) => set(o, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
const dampV = (o: V3, b: V3, lambda: number, dt: number) => lerpV(o, o, b, 1 - Math.exp(-lambda * dt));
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
function norm(o: V3) {
  const l = len(o);
  if (l < 1e-6) return false;
  o.x /= l;
  o.y /= l;
  o.z /= l;
  return true;
}

interface Targets {
  body: V3;
  pitch: number;
  yaw: number;
  roll: number;
  feet: [V3, V3];
  footPitch: [number, number];
  hand: V3;
  dir: V3;
  edge: V3;
  off: V3;
  /** body stiffness; arms; feet (0 = set exactly this frame) */
  lam: number;
  armLam: number;
  feetLam: number;
  /** root height above the deck (jumps) */
  hop: number;
  /** where the eyes look, as a world pitch */
  gaze: number;
  headYaw: number;
  headRoll: number;
  eyes: EyeState;
  mouth: MouthState;
  brow: number;
}

export class DuelAnimator {
  pose: Pose = newPose();
  /** root units → metres */
  readonly scale: number;

  private phase: FighterPhase | '' = '';
  private prevPhase: FighterPhase | '' = '';
  private rng = new Rng();
  private blinkAt = 0;
  private blinkT = 0;
  private squash = 1;
  private squashV = 0;
  private lastJump = 0;
  private headPitch = 0;
  private headYaw = 0;
  private started = false;
  /** walking: where the root was last frame, its smoothed local velocity and the stride's phase */
  private lastX = 0;
  private lastZ = 0;
  private walkVx = 0;
  private walkVz = 0;
  private walkPh = 0;
  /** the sword pose when the phase began (a live slash blends out of it) */
  private from = { hand: V(), dir: V(0, 1, 0), edge: V(0, 0, -1), off: V() };
  private tg: Targets = {
    body: V(0, HIP, 0),
    pitch: 0,
    yaw: 0,
    roll: 0,
    feet: [V(), V()],
    footPitch: [0, 0],
    hand: V(),
    dir: V(0, 1, 0),
    edge: V(0, 0, -1),
    off: V(),
    lam: 10,
    armLam: 14,
    feetLam: 12,
    hop: 0,
    gaze: 0,
    headYaw: 0,
    headRoll: 0,
    eyes: 'open',
    mouth: 'smile',
    brow: 0,
  };
  // scratch (update() allocates nothing)
  private aD = V();
  private aE = V();
  private s1 = V();
  private s2 = V();
  private s3 = V();
  private s4 = V();
  private sh = V();

  constructor(
    public handed: 1 | -1,
    public look: Look,
  ) {
    this.scale = CHAR_SCALE * (look.height || 1);
    this.pose.handed = handed;
    this.pose.body.y = HIP;
    this.blinkAt = this.rng.range(1, 3.5);
  }

  update(t: number, dt: number, s: FighterState): Pose {
    const P = this.pose;
    const T = this.tg;
    dt = Math.max(1e-4, Math.min(dt, 0.1));
    const hs = s.handed ?? this.handed;
    P.handed = hs;
    P.x = s.x;
    P.z = s.z;
    P.yaw = s.facing === 1 ? 0 : Math.PI;
    P.holdingBall = false;
    P.tired = 0;
    P.legLift = 0;
    if (!this.started) this.first(s, hs);
    this.measureWalk(s, dt);
    if (s.phase !== this.phase) this.enter(s);

    // defaults: the fencing stance, sword from the aim, looking at the opponent
    T.lam = 10;
    T.armLam = 16;
    T.feetLam = 12;
    T.hop = 0;
    T.gaze = -0.02;
    T.headYaw = 0;
    T.headRoll = 0;
    T.eyes = 'focus';
    T.mouth = 'flat';
    T.brow = 0.4;
    T.footPitch[0] = T.footPitch[1] = 0;
    this.aimRoot(s.aim, this.aD, this.aE);
    let crisp = false;
    let hop: number | null = null;

    switch (s.phase) {
      case 'idle': {
        this.stance(T, hs, t, 0.25);
        this.hold(T, hs, this.aD, this.aE, 0);
        this.restOff(T, hs, t);
        T.headYaw = Math.sin(t * 0.45) * 0.25;
        T.eyes = 'open';
        T.mouth = 'smile';
        T.brow = 0;
        break;
      }
      case 'ready':
      case 'recover': {
        this.stance(T, hs, t, 1);
        this.hold(T, hs, this.aD, this.aE, 0);
        this.restOff(T, hs, t);
        T.armLam = ARM_FOLLOW;
        if (s.phase === 'recover') {
          // back from the follow-through, a little heavier than a free sword
          T.armLam = 9;
          T.lam = 8;
          T.mouth = 'open';
        }
        break;
      }
      case 'guard': {
        this.stance(T, hs, t, 1.3);
        T.yaw *= 0.3; // square up behind the blade
        T.pitch = -0.12;
        this.hold(T, hs, this.aD, this.aE, 1);
        this.support(T, hs);
        T.armLam = ARM_FOLLOW;
        T.brow = 0.85;
        break;
      }
      case 'windup': {
        const a = s.attack;
        const dir = a ? a.dir : -Math.PI / 2;
        this.stance(T, hs, t, 1);
        // cock the sword where the attack will start, trembling a little: the tell
        const th = TH_WINDUP + Math.sin(t * 40) * 0.025 * smooth(clamp(s.t / 0.2));
        if (a?.kind === 'thrust') this.thrustPose(T, hs, -0.15);
        else {
          this.arc(T, hs, dir, th, 1);
          this.slashBody(T, hs, dir, th, 1.25);
        }
        T.armLam = 11;
        T.lam = 9;
        T.brow = 1;
        T.mouth = 'flat';
        break;
      }
      case 'slash': {
        const a = s.attack;
        const dir = a ? a.dir : -Math.PI / 2;
        const power = a ? clamp(a.power) : 0.7;
        const dur = lerp(0.2, 0.15, power);
        const uy = Math.sin(dir);
        const th0 = this.prevPhase === 'windup' ? TH_WINDUP : TH_LIVE;
        const th1 = 1.65 + (uy < 0 ? 0.55 * uy : 0.25 * uy);
        const u = clamp(s.t / dur);
        const th = lerp(th0, th1, 1 - Math.pow(1 - u, 2.3));
        this.stance(T, hs, t, 1);
        // out of a windup the blade comes down off the shoulder into the cut
        this.arc(T, hs, dir, th, this.prevPhase === 'windup' ? 1 - smooth(clamp(u / 0.45)) : 0);
        this.slashBody(T, hs, dir, th, 1);
        // step into it
        const front = hs > 0 ? 1 : 0;
        T.feet[front].z = lerp(T.feet[front].z, -0.34, smooth(u));
        T.body.z -= 0.07 * smooth(u);
        T.body.y -= 0.05;
        if (this.prevPhase !== 'windup') this.blendFrom(T, smooth(clamp(s.t / 0.07)));
        crisp = true;
        T.lam = 22;
        T.feetLam = 20;
        T.eyes = u < 1 ? 'closed' : 'focus';
        T.mouth = 'open';
        T.brow = 1;
        break;
      }
      case 'thrust': {
        this.stance(T, hs, t, 1);
        const u = clamp(s.t / 0.16);
        this.thrustPose(T, hs, easeOutBack(u, 1.6));
        if (this.prevPhase !== 'windup') this.blendFrom(T, smooth(clamp(s.t / 0.05)));
        crisp = true;
        T.lam = 20;
        T.feetLam = 22;
        T.eyes = 'closed';
        T.mouth = 'open';
        T.brow = 1;
        break;
      }
      case 'stagger': {
        // knocked back: arms flung, head snapped back, feet skidding
        const u = s.t;
        const rec = smooth(clamp((u - 0.3) / 0.5));
        const k = 1 - rec;
        this.stance(T, hs, t, 1);
        const front = hs > 0 ? 1 : 0;
        T.feet[front].z = -0.06;
        T.feet[1 - front].z = 0.24;
        T.footPitch[front] = -0.35 * k;
        T.pitch = 0.08 + 0.5 * k;
        T.yaw *= 0.4;
        T.roll = Math.sin(u * 23) * 0.06 * Math.exp(-u * 4);
        T.body.z += 0.1 * k;
        T.body.y -= 0.04;
        this.hold(T, hs, this.aD, this.aE, 0);
        this.restOff(T, hs, t);
        this.fromShoulder(this.s3, T, hs, 0.38, 0.28, 0.18, 0);
        lerpV(T.hand, T.hand, this.s3, k);
        set(this.s1, hs * 0.5, 0.72, 0.45);
        norm(this.s1);
        this.blendDir(T, this.s1, k);
        this.fromShoulder(this.s2, T, -hs, 0.36, 0.25, 0.15, 0);
        lerpV(T.off, T.off, this.s2, k);
        T.armLam = u < 0.12 ? 30 : 8;
        T.lam = u < 0.12 ? 26 : 7;
        T.gaze = 0.45 * k;
        T.eyes = u < 0.4 ? 'closed' : 'sad';
        T.mouth = 'open';
        T.brow = -0.5;
        break;
      }
      case 'stunned': {
        // the attack bounced off the guard: knocked back, then dazed and wide open
        const u = s.t;
        this.stance(T, hs, t, 0.6);
        if (u < 0.3) {
          const k = Math.sin(clamp(u / 0.3) * Math.PI * 0.5 + Math.PI * 0.5);
          this.fromShoulder(T.hand, T, hs, 0.3, 0.42, 0.12, 0);
          set(T.dir, hs * 0.2, 0.8, 0.55);
          norm(T.dir);
          set(T.edge, 0, 0, -1);
          T.pitch = 0.3 * k;
          this.restOff(T, hs, t);
          T.armLam = 26;
          T.eyes = 'wide';
          T.mouth = 'o';
        } else {
          const w = (u - 0.3) * 3.3;
          T.roll = Math.sin(w) * 0.13;
          T.pitch = -0.1 + Math.cos(w) * 0.07;
          T.body.x += Math.sin(w) * 0.04;
          T.body.y -= 0.05 + Math.sin(w * 2) * 0.015;
          T.yaw *= 0.3;
          // the sword droops towards the deck
          set(T.hand, hs * 0.34, 0.68, -0.2);
          set(T.dir, hs * 0.5, -0.8, -0.25);
          norm(T.dir);
          set(T.edge, 0, 0, -1);
          set(T.off, -hs * 0.3, 0.5 + Math.sin(w + 1) * 0.03, -0.06);
          T.armLam = 5;
          T.lam = 6;
          T.headRoll = Math.sin(w * 1.3) * 0.28;
          T.headYaw = Math.cos(w) * 0.3;
          T.gaze = -0.15;
          T.eyes = 'sad';
          T.mouth = 'o';
          T.brow = -0.8;
        }
        break;
      }
      case 'clash': {
        // blades met: both bounce back a little
        const u = s.t;
        const k = u < 0.1 ? smooth(u / 0.1) : 1 - smooth(clamp((u - 0.12) / 0.4));
        this.stance(T, hs, t, 1);
        this.hold(T, hs, this.aD, this.aE, 0);
        this.restOff(T, hs, t);
        this.fromShoulder(this.s1, T, hs, 0.25, 0.42, 0.04, 0.12);
        lerpV(T.hand, T.hand, this.s1, k);
        set(this.s2, hs * 0.25, 0.85, 0.45);
        norm(this.s2);
        this.blendDir(T, this.s2, k);
        T.pitch += 0.25 * k;
        T.body.z += 0.06 * k;
        hop = Math.sin(clamp(u / 0.32) * Math.PI) * 0.07;
        T.armLam = u < 0.1 ? 30 : 9;
        T.lam = 14;
        T.eyes = 'wide';
        T.mouth = 'o';
        T.brow = 0.6;
        break;
      }
      case 'fall': {
        // over the edge: tumbling backwards, arms windmilling, legs kicking
        const u = s.t;
        const k = smooth(clamp(u / 0.75));
        set(T.body, 0, HIP - 0.04 - 0.1 * k, 0.1 * k);
        T.pitch = lerp(0.35, 1.3, k);
        T.yaw = 0;
        T.roll = Math.sin(u * 5) * 0.12;
        const w = u * 15;
        for (let i = 0; i < 2; i++) {
          const ph = u * 13 + i * Math.PI;
          set(T.feet[i], HIP_X[i] * 1.35, 0.22 + 0.2 * k + Math.sin(ph) * 0.14, -0.2 - 0.15 * k + Math.cos(ph) * 0.08);
          T.footPitch[i] = -0.7;
        }
        this.fromShoulder(T.hand, T, hs, 0.35 + 0.1 * Math.cos(w), 0.25 + 0.3 * Math.sin(w), 0.25 * Math.cos(w), 0);
        this.fromShoulder(T.off, T, -hs, 0.35 + 0.1 * Math.cos(w + Math.PI), 0.25 + 0.3 * Math.sin(w + Math.PI), 0.25 * Math.cos(w + Math.PI), 0);
        set(T.dir, hs * 0.55 * Math.cos(w * 0.5), 0.75, 0.45 * Math.sin(w * 0.5));
        norm(T.dir);
        // going under: the sword goes with the body, not poking out of the surface
        const under = smooth(clamp((u - FALL_T + 0.3) / 0.3));
        set(this.s1, hs * 0.2, -0.35, 1);
        norm(this.s1);
        this.blendDir(T, this.s1, under);
        this.fromShoulder(this.s2, T, hs, 0.2, 0.1, 0.1, 0);
        lerpV(T.hand, T.hand, this.s2, under);
        set(T.edge, 0, 0, -1);
        T.armLam = 16;
        T.lam = 7;
        T.feetLam = 16;
        hop = fallY(u) - ARENA.top;
        T.gaze = 0.3;
        T.eyes = 'wide';
        T.mouth = 'open';
        T.brow = 1;
        break;
      }
      case 'win': {
        // two jumps with the sword thrust up, then a proud stance
        const u = s.t;
        const j = u < 1.3 ? Math.max(0, Math.sin(u * Math.PI * 1.6)) : Math.abs(Math.sin(u * 5.5)) * 0.06;
        if (j < 0.02 && this.lastJump > 0.05) this.squashV -= 1.3;
        this.lastJump = j;
        hop = j * 0.32;
        set(T.body, 0, HIP, 0);
        T.pitch = 0.12;
        T.yaw = 0;
        T.roll = 0;
        set(T.feet[0], HIP_X[0] * 1.25, j * 0.08, 0);
        set(T.feet[1], HIP_X[1] * 1.25, j * 0.08, 0);
        T.footPitch[0] = T.footPitch[1] = -0.4 * j;
        set(T.hand, hs * 0.42, 1.72 + Math.sin(u * 13) * 0.03 * (u < 1.3 ? 1 : 0), -0.06);
        set(T.dir, hs * 0.18, 1, 0.06);
        norm(T.dir);
        set(T.edge, 0, 0, -1);
        if (u < 1.3) set(T.off, -hs * 0.4, 1.58 - Math.sin(u * 13) * 0.04, -0.1);
        else set(T.off, -hs * 0.33, 0.62, 0.02);
        T.armLam = 14;
        T.lam = 12;
        T.gaze = 0.2;
        T.eyes = 'happy';
        T.mouth = 'grin';
        T.brow = 0.3;
        break;
      }
      case 'lose': {
        // deflate: the sword's tip on the deck, head hanging, a slow shake
        const u = s.t;
        const sigh = Math.sin(clamp(u / 1.4) * Math.PI) * 0.03;
        set(T.body, 0, HIP - 0.08 - sigh, 0.02);
        T.pitch = -0.45;
        T.yaw = 0;
        T.roll = 0;
        set(T.feet[0], HIP_X[0] * 0.95, 0, 0);
        set(T.feet[1], HIP_X[1] * 0.95, 0, 0);
        set(T.hand, hs * 0.3, 0.46, -0.26);
        set(T.dir, hs * 0.18, -0.9, -0.4);
        norm(T.dir);
        set(T.edge, 0, 0, -1);
        set(T.off, -hs * 0.27, 0.36, -0.1);
        T.armLam = 5;
        T.lam = 5;
        T.gaze = -1;
        T.headYaw = Math.sin(u * 6.5) * 0.28 * Math.max(0, 1 - u / 1.6);
        T.eyes = 'sad';
        T.mouth = 'frown';
        T.brow = -1;
        break;
      }
    }
    // on the move (walking on, stepping back to the mark): the legs walk it
    if (s.phase === 'idle' || s.phase === 'ready' || s.phase === 'guard' || s.phase === 'recover') this.walk(T, hop === null);
    this.floorBlade(T.hand, T.dir);

    // ------------------------------------------------ body
    dampV(P.body, T.body, T.lam, dt);
    P.bodyPitch = damp(P.bodyPitch, T.pitch, T.lam, dt);
    P.bodyYaw = damp(P.bodyYaw, T.yaw, T.lam, dt);
    P.bodyRoll = damp(P.bodyRoll, T.roll, T.lam, dt);
    P.hop = ARENA.top + (hop ?? T.hop);

    // squash spring (landings, knocks)
    this.squashV += (1 - this.squash) * 180 * dt;
    this.squashV *= Math.exp(-14 * dt);
    this.squash += this.squashV * dt;
    P.squash = this.squash;

    // ------------------------------------------------ feet
    for (let i = 0; i < 2; i++) {
      dampV(P.feet[i], T.feet[i], T.feetLam, dt);
      P.footPitch[i] = damp(P.footPitch[i], T.footPitch[i], T.feetLam, dt);
    }

    // ------------------------------------------------ hands and blade
    if (crisp) {
      cp(P.hands[0], T.hand);
      cp(P.racketDir, T.dir);
      cp(P.racketFace, T.edge);
    } else {
      dampV(P.hands[0], T.hand, T.armLam, dt);
      const k = 1 - Math.exp(-T.armLam * dt);
      lerpV(P.racketDir, P.racketDir, T.dir, k);
      if (!norm(P.racketDir)) cp(P.racketDir, T.dir);
      lerpV(P.racketFace, P.racketFace, T.edge, k);
    }
    this.orthoEdge(P.racketDir, P.racketFace);
    dampV(P.hands[1], T.off, crisp ? Math.max(T.armLam, 18) : T.armLam, dt);

    // ------------------------------------------------ head: gaze is a world pitch, the head sits on the leaning body
    this.headPitch = damp(this.headPitch, T.gaze - P.bodyPitch * 0.85, 9, dt);
    this.headYaw = damp(this.headYaw, T.headYaw - P.bodyYaw * 0.85, 9, dt);
    P.headPitch = this.headPitch;
    P.headYaw = this.headYaw;
    P.headRoll = T.headRoll - P.bodyRoll * 0.4 + Math.sin(t * 1.3) * 0.02;

    // ------------------------------------------------ face
    this.blinkT -= dt;
    if (t > this.blinkAt) {
      this.blinkT = 0.11;
      this.blinkAt = t + this.rng.range(1.8, 4.6);
    }
    const intense = T.eyes === 'closed' || T.eyes === 'wide' || T.eyes === 'happy';
    P.blink = this.blinkT > 0 && !intense ? 1 : 0;
    P.eyes = T.eyes;
    P.mouth = T.mouth;
    P.brow = damp(P.brow, T.brow, 12, dt);
    return P;
  }

  // ---------------------------------------------------------------- phases

  /** The root's velocity in its own frame (the game moves it; a jump means a teleport, not a sprint). */
  private measureWalk(s: FighterState, dt: number) {
    const dx = s.x - this.lastX,
      dz = s.z - this.lastZ;
    this.lastX = s.x;
    this.lastZ = s.z;
    let vx = dx / dt,
      vz = dz / dt;
    if (Math.hypot(vx, vz) > 12) vx = vz = 0;
    // world → root: the root is turned by `facing` (π when facing +z)
    if (s.facing !== 1) (vx = -vx), (vz = -vz);
    const k = 1 - Math.exp(-10 * dt);
    this.walkVx += (vx - this.walkVx) * k;
    this.walkVz += (vz - this.walkVz) * k;
    const sp = Math.hypot(this.walkVx, this.walkVz);
    // a stride per ~0.9 m, quicker for short shuffles
    this.walkPh += ((sp * dt) / 0.9) * Math.PI * 2;
  }

  /** Stepping feet and a bob, along the way the root is moving (a shuffle in the stance, a walk when faster). */
  private walk(T: Targets, grounded: boolean) {
    const sp = Math.hypot(this.walkVx, this.walkVz);
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
    T.pitch += -0.08 * run * Math.sign(-dz || 1);
    T.feetLam = Math.max(T.feetLam, 22);
  }

  private first(s: FighterState, hs: number) {
    this.started = true;
    this.lastX = s.x;
    this.lastZ = s.z;
    const P = this.pose;
    const T = this.tg;
    this.stance(T, hs, 0, 1);
    this.aimRoot(s.aim, this.aD, this.aE);
    this.hold(T, hs, this.aD, this.aE, 0);
    cp(P.body, T.body);
    for (let i = 0; i < 2; i++) cp(P.feet[i], T.feet[i]);
    cp(P.hands[0], T.hand);
    cp(P.racketDir, T.dir);
    cp(P.racketFace, T.edge);
    this.restOff(T, hs, 0);
    cp(P.hands[1], T.off);
  }

  private enter(s: FighterState) {
    this.prevPhase = this.phase;
    this.phase = s.phase;
    const P = this.pose;
    cp(this.from.hand, P.hands[0]);
    cp(this.from.dir, P.racketDir);
    cp(this.from.edge, P.racketFace);
    cp(this.from.off, P.hands[1]);
    if (s.phase === 'stagger') this.squashV -= 1.6;
    else if (s.phase === 'clash') this.squashV -= 0.9;
    else if (s.phase === 'stunned') this.squashV -= 0.7;
    else if (s.phase === 'slash' || s.phase === 'thrust') this.squashV += 0.5;
    this.lastJump = 0;
  }

  // ---------------------------------------------------------------- building blocks

  /** The fencing stance: sword foot forward, knees bent by `crouch` (0 = standing easy). */
  private stance(T: Targets, hs: number, t: number, crouch: number) {
    const front = hs > 0 ? 1 : 0;
    const back = 1 - front;
    const bob = Math.sin(t * 4.4) * 0.011 * Math.min(1, crouch) + Math.sin(t * 1.7) * 0.004;
    set(T.body, 0, HIP - 0.015 - 0.045 * crouch + bob, 0);
    T.pitch = -0.05 * crouch;
    T.yaw = hs * 0.24 * Math.min(1, crouch);
    T.roll = 0;
    set(T.feet[front], HIP_X[front] * 1.3, 0, -0.13 - 0.04 * crouch);
    set(T.feet[back], HIP_X[back] * 1.25, 0, 0.12 + 0.05 * crouch);
    T.footPitch[0] = T.footPitch[1] = 0;
  }

  /** aim (fighter frame) → root-space blade and edge */
  private aimRoot(a: SwordAim | undefined, d: V3, e: V3) {
    if (a) {
      set(d, a.blade[0], a.blade[1], -a.blade[2]);
      set(e, a.edge[0], a.edge[1], -a.edge[2]);
    } else {
      set(d, 0, 0.7, -0.7);
      set(e, 0, 0.7, 0.7);
    }
    if (!Number.isFinite(d.x + d.y + d.z) || !norm(d)) set(d, 0, 0.6, -0.8);
    if (!Number.isFinite(e.x + e.y + e.z)) set(e, 0, 0, -1);
    this.orthoEdge(d, e);
  }

  /**
   * Hold the sword along `d`: the hand goes where that blade sits naturally.
   * tight 0 = relaxed, at the sword side; 1 = a guard, the blade centred in
   * front of the body so it covers it.
   */
  private hold(T: Targets, hs: number, d: V3, e: V3, tight: number) {
    const h = T.hand;
    const cx = lerp(hs * 0.2, hs * 0.03, tight);
    const cy = lerp(0.84, 0.98, tight);
    const cz = lerp(-0.36, -0.46, tight);
    const k = lerp(0.2, 0.4, tight);
    set(h, cx - d.x * k, cy - d.y * k, T.body.z + cz - d.z * k);
    // a blade pointing back at yourself passes by your side, not through you
    if (d.z > 0) h.x += hs * 0.42 * d.z;
    h.z = Math.min(h.z, T.body.z - 0.28);
    h.y = clamp(h.y + (T.body.y - HIP), 0.42, 1.55);
    this.reach(h, T, hs, 0.62);
    this.keepOut(h, T);
    cp(T.dir, d);
    cp(T.edge, e);
  }

  /** The off hand in a guard: bracing the flat of a crosswise blade, or on the pommel of an upright one. */
  private support(T: Targets, hs: number) {
    const d = T.dir;
    const level = 1 - smooth(clamp((Math.abs(d.y) - 0.35) / 0.45));
    // the side of the blade facing the fighter (from the blade alone: the edge is only the
    // phone's grip, so nothing here depends on it)
    const side = this.s1;
    set(side, -d.x * d.z, -d.y * d.z, 1 - d.z * d.z);
    if (!norm(side)) set(side, 0, 1, 0);
    const on = this.s2;
    set(on, T.hand.x + d.x * 0.42 + side.x * 0.06, T.hand.y + d.y * 0.42 + side.y * 0.06, T.hand.z + d.z * 0.42 + side.z * 0.06);
    const pommel = this.s3;
    set(pommel, T.hand.x - d.x * 0.16, T.hand.y - d.y * 0.16, T.hand.z - d.z * 0.16);
    // too far for the off arm: take the pommel instead
    const S = this.shoulder(-hs, T, this.s4);
    const far = clamp((Math.hypot(on.x - S.x, on.y - S.y, on.z - S.z) - 0.6) / 0.12);
    lerpV(T.off, pommel, on, level * (1 - far));
  }

  /** The free hand, relaxed in front for balance. */
  private restOff(T: Targets, hs: number, t: number) {
    set(T.off, -hs * 0.28, 0.74 + Math.sin(t * 4.4 + 1) * 0.01 + (T.body.y - HIP), T.body.z - 0.14);
  }

  /**
   * A point on the slash arc. th is the blade's angle from pointing at the
   * opponent: − towards the start side, + the follow-through. The blade turns
   * in the plane of "forward" and the tip's direction of travel; the hand loops
   * around the chest, reaching over the head for a chop and low for an uppercut.
   */
  private arc(T: Targets, hs: number, dir: number, th: number, cock = 0) {
    const ux = Math.cos(dir),
      uy = Math.sin(dir);
    const c = Math.cos(th),
      sn = Math.sin(th);
    const d = T.dir;
    set(d, sn * ux, sn * uy, -c);
    // flat swings ride a little high (and never scrape the deck); cocked for one,
    // the blade goes up over the shoulder, where it shows over the other fighter
    const flat = 1 - Math.abs(uy);
    const raise = cock * flat * (uy > 0.2 ? 0 : 1);
    d.y += 0.2 * flat + 0.9 * raise;
    norm(d);
    // the edge leads
    set(T.edge, c * ux, c * uy, sn);
    norm(T.edge);
    const up = sn * uy;
    // vertical cuts come down (or up) the sword side, past the head and the legs
    set(T.hand, hs * (0.06 + 0.16 * Math.abs(uy)) + (0.4 + 0.1 * raise) * sn * ux, 1.0 + up * (up > 0 ? 0.68 : 0.42) + 0.08 * raise + (T.body.y - HIP), T.body.z - 0.2 - 0.34 * c);
    this.keepOut(T.hand, T);
    // the off hand pulls back against the swing, for balance
    set(T.off, -hs * 0.3 - 0.18 * sn * ux, 0.8 - 0.1 * up, T.body.z - 0.05 + 0.12 * c);
  }

  /** The body through a slash: twist with the sweep, rock back as it's cocked and into it as it lands. */
  private slashBody(T: Targets, hs: number, dir: number, th: number, amt: number) {
    const ux = Math.cos(dir),
      uy = Math.sin(dir);
    const sn = Math.sin(th);
    T.yaw = hs * 0.08 - 0.55 * sn * ux * amt;
    T.pitch = 0.26 * sn * uy * amt - 0.04;
    T.roll = -0.08 * sn * ux * uy * amt;
    T.body.y -= 0.03 * amt;
  }

  /** The lunge: u 0 = sword drawn back at the hip, 1 = arm and front leg at full stretch. */
  private thrustPose(T: Targets, hs: number, u: number) {
    const front = hs > 0 ? 1 : 0;
    const back = 1 - front;
    set(T.body, 0, HIP - 0.05 - 0.08 * u, -0.16 * u);
    T.pitch = -0.08 - 0.26 * u;
    T.yaw = hs * lerp(0.45, 0.1, u);
    T.roll = 0;
    set(T.feet[front], HIP_X[front] * 1.3, 0, lerp(-0.17, -0.55, u));
    set(T.feet[back], HIP_X[back] * 1.3, 0, lerp(0.17, 0.32, u));
    T.footPitch[back] = -0.3 * u;
    set(T.hand, hs * lerp(0.24, 0.05, u), lerp(0.8, 0.97, u), lerp(-0.12, -0.86, u));
    set(T.dir, hs * lerp(-0.12, 0, u), 0.06, -1);
    norm(T.dir);
    set(T.edge, 0, 1, 0);
    set(T.off, -hs * lerp(0.3, 0.45, u), lerp(0.8, 0.9, u), lerp(-0.05, 0.3, u));
  }

  /** Mix the sword pose from when the phase began back in (a live slash starts where the sword was). */
  private blendFrom(T: Targets, w: number) {
    if (w >= 1) return;
    const f = this.from;
    lerpV(T.hand, f.hand, T.hand, w);
    lerpV(T.dir, f.dir, T.dir, w);
    if (!norm(T.dir)) cp(T.dir, f.dir);
    lerpV(T.edge, f.edge, T.edge, w);
    lerpV(T.off, f.off, T.off, w);
  }

  private blendDir(T: Targets, d: V3, k: number) {
    lerpV(T.dir, T.dir, d, k);
    if (!norm(T.dir)) cp(T.dir, d);
  }

  /** The shoulder on side sx (+1 right), placed by the target body exactly as Rig.apply does. */
  private shoulder(sx: number, T: Targets, o: V3) {
    let x = sx * 0.2 * (this.look.girth || 1),
      y = SH_Y,
      z = 0;
    const cr = Math.cos(T.roll),
      sr = Math.sin(T.roll);
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    const cpch = Math.cos(T.pitch),
      spch = Math.sin(T.pitch);
    [y, z] = [y * cpch - z * spch, y * spch + z * cpch];
    const cy = Math.cos(T.yaw),
      sy = Math.sin(T.yaw);
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    return set(o, T.body.x + x, T.body.y + y, T.body.z + z);
  }

  /** A hand placed from its shoulder: out (away from the body's side), up, back (+z). */
  private fromShoulder(o: V3, T: Targets, sx: number, out: number, up: number, back: number, fwd: number) {
    const S = this.shoulder(sx, T, this.sh);
    return set(o, S.x + sx * out, S.y + up, S.z + back - fwd);
  }

  /** Arms stretch a little past their length (cartoon-style), not across the stage. */
  private reach(h: V3, T: Targets, hs: number, max: number) {
    const S = this.shoulder(hs, T, this.sh);
    const dx = h.x - S.x,
      dy = h.y - S.y,
      dz = h.z - S.z;
    const l = Math.hypot(dx, dy, dz);
    if (l > max) set(h, S.x + (dx * max) / l, S.y + (dy * max) / l, S.z + (dz * max) / l);
  }

  /** Keep a hand out of the torso and the head. */
  private keepOut(h: V3, T: Targets) {
    const b = T.body;
    const g = this.look.girth || 1;
    // torso: a capsule along the (leaning) spine
    const lx = -Math.sin(T.roll),
      ay = Math.cos(T.pitch) * Math.cos(T.roll),
      lz = Math.sin(T.pitch) * Math.cos(T.roll);
    const cyw = Math.cos(T.yaw),
      syw = Math.sin(T.yaw);
    const ax = lx * cyw + lz * syw,
      az = -lx * syw + lz * cyw;
    const px = h.x - b.x,
      py = h.y - b.y,
      pz = h.z - b.z;
    const along = clamp(px * ax + py * ay + pz * az, 0, TORSO_H);
    let qx = px - ax * along,
      qy = py - ay * along,
      qz = pz - az * along;
    let d = Math.hypot(qx, qy, qz);
    const r = TORSO_R * g;
    if (d < r) {
      if (d < 1e-4) (qx = 0), (qy = 0), (qz = -1), (d = 1);
      // out towards the front rather than straight sideways
      qz -= 0.35 * d;
      d = Math.hypot(qx, qy, qz);
      h.x = b.x + ax * along + (qx / d) * r;
      h.y = b.y + ay * along + (qy / d) * r;
      h.z = b.z + az * along + (qz / d) * r;
    }
    // head
    const hx = b.x + ax * HEAD_Y,
      hy = b.y + ay * HEAD_Y,
      hz = b.z + az * HEAD_Y;
    const ex = h.x - hx,
      ey = h.y - hy,
      ez = h.z - hz;
    const e = Math.hypot(ex, ey, ez);
    if (e < HEAD_R) {
      const k = e < 1e-4 ? 0 : HEAD_R / e;
      if (k === 0) set(h, hx, hy + HEAD_R, hz);
      else set(h, hx + ex * k, hy + ey * k, hz + ez * k);
    }
    if (h.y < FLOOR) h.y = FLOOR;
  }

  /** A blade pointing down stops at the deck instead of going through it. */
  private floorBlade(h: V3, d: V3) {
    const minY = (0.1 - h.y) / BLADE;
    if (d.y >= minY) return;
    const y = clamp(minY, -1, 1);
    const hl = Math.hypot(d.x, d.z);
    const k = Math.sqrt(Math.max(0, 1 - y * y));
    if (hl < 1e-4) set(d, 0, y, -k);
    else set(d, (d.x / hl) * k, y, (d.z / hl) * k);
  }

  /** Keep the edge square to the blade (the rig does too; this keeps the damping sane). */
  private orthoEdge(d: V3, e: V3) {
    const k = e.x * d.x + e.y * d.y + e.z * d.z;
    e.x -= d.x * k;
    e.y -= d.y * k;
    e.z -= d.z * k;
    if (norm(e)) return;
    // parallel: any perpendicular will do, preferably facing forward/up
    set(e, 0, 0, -1);
    const k2 = -d.z;
    e.x -= d.x * k2;
    e.y -= d.y * k2;
    e.z -= d.z * k2;
    if (!norm(e)) set(e, 0, 1, 0);
  }
}
