// The bowler: turns a BowlerState into a Pose for the tennis Rig (the same
// characters bowl). Conventions as in chars/anim.ts — root-local space, x right,
// y up, −z forward, unscaled (the rig scales the root); hands[0] is the bowling
// hand and handedness mirrors x. Note the rig's signs: a positive bodyPitch
// leans the body back and a positive headPitch looks up.
//
// During the approach the bowling hand rides a circle around the shoulder at
// exactly s.arm (the player's live phone swing), and the feet are planted in
// world space so they don't skate however the game moves the root.

import { newPose, type Pose, type EyeState, type MouthState } from '../chars/pose';
import { CHAR_SCALE, HIP, TORSO } from '../chars/rig';
import type { Look } from '../chars/look';
import { clamp, lerp, smooth, damp, easeOutCubic, Rng, type V3 } from '../core/math';
import { LANE } from './lane';
import type { BowlerState } from './types';

/** shoulder → hand, root units (a touch longer than the rig's two 0.25 bones: it stretches, cartoon-style) */
const ARM_R = 0.55;
/** hand centre → ball centre, along the arm (the fingers are in the ball) */
const BALL_OFF = 0.075;
/** shoulder height above the body origin (as in Rig.apply) */
const SH_Y = 0.47 * TORSO;
/** how far the swing sits outside the shoulder at the bottom, so the ball clears the hip */
const SWING_OUT = 0.1;
/** the rig's hip lines: feet[0] is the left leg, feet[1] the right */
const HIP_X = [-0.11, 0.11];

const V = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const set = (o: V3, x: number, y: number, z: number) => ((o.x = x), (o.y = y), (o.z = z), o);
const cp = (o: V3, a: V3) => set(o, a.x, a.y, a.z);
const lerpV = (o: V3, a: V3, b: V3, t: number) => set(o, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
const dampV = (o: V3, b: V3, lambda: number, dt: number) => lerpV(o, o, b, 1 - Math.exp(-lambda * dt));

interface Face {
  eyes: EyeState;
  mouth: MouthState;
  brow: number;
}

export class BowlAnimator {
  pose: Pose = newPose();
  /**
   * Extra, optional: how far the bowling hand has turned about the forearm
   * (radians, handshake = the thumb rolls up). The Pose has no hand rotation;
   * apply it as `rig.hands[0].rotation.z = anim.handRoll` after rig.apply (and
   * reset it to 0 when leaving bowling).
   */
  handRoll = 0;
  /** root units → metres */
  readonly scale: number;

  private phase: BowlerState['phase'] | '' = '';
  private ball = V(0, 0.9, -0.3);
  private rng = new Rng();
  private blinkAt = 0;
  private blinkT = 0;
  private squash = 1;
  private squashV = 0;
  private lastJump = 0;
  private headPitch = 0;
  private headYaw = 0;
  /** the arm angle actually drawn (continuity between the live swing and the scripted follow-through) */
  private armNow = 0;
  /** extra outward reach of the swing (the follow-through finishes outside the head) */
  private armOut = 0;
  private armAtPhase = 0;
  /** chest-hold → live swing blend at the start of the approach */
  private swingIn = 0;
  // world-space feet for the approach
  private footW = [V(), V()];
  private liftW = [V(), V()];
  private stepK = -1;
  private lastRoot = V();
  private lastStep = 0;
  /** root travel (world metres) per unit of approach progress, measured */
  private travel = 0;
  private measured = false;
  private started = false;
  // per-frame scratch (update() allocates nothing)
  private tmp = V();
  private tmp2 = V();
  private sh = V();
  private bodyT = V();
  private handT: [V3, V3] = [V(), V()];
  private feetT: [V3, V3] = [V(), V()];
  private footPitchT: [number, number] = [0, 0];
  private face: Face = { eyes: 'open', mouth: 'smile', brow: 0 };
  private s1 = V();
  private s2 = V();
  private s3 = V();

  constructor(
    public handed: 1 | -1,
    public look: Look,
  ) {
    this.scale = CHAR_SCALE * (look.height || 1);
    this.pose.handed = handed;
    this.pose.body.y = HIP;
    this.blinkAt = this.rng.range(1, 3.5);
  }

  /** Where the ball sits relative to the root, in root-local unscaled units (the game converts to world). */
  ballHand(): { x: number; y: number; z: number } {
    return { x: this.ball.x, y: this.ball.y, z: this.ball.z };
  }

  update(t: number, dt: number, s: BowlerState): Pose {
    const P = this.pose;
    const hs = s.handed ?? this.handed;
    dt = Math.max(1e-4, Math.min(dt, 0.1));
    P.handed = hs;
    P.x = s.x;
    P.z = s.z;
    P.yaw = s.yaw;
    P.holdingBall = s.holding;
    P.tired = 0;
    P.legLift = 0;
    // the racket is hidden while bowling; keep its frame sane
    set(P.racketDir, 0, 1, 0);
    set(P.racketFace, 0, 0, -1);

    // teleports (a new frame, the next bowler): re-plant the feet where they are
    const moved = Math.hypot(s.x - this.lastRoot.x, s.z - this.lastRoot.z);
    if (!this.started || moved > 0.6) this.replant(s);
    if (s.phase !== this.phase) this.enter(s);

    const slide = hs > 0 ? 0 : 1; // right-handers slide on the left foot (feet[0] = left)
    const back = 1 - slide;
    const sx = HIP_X;
    const face = this.face;
    face.eyes = 'open';
    face.mouth = 'smile';
    face.brow = 0;
    let hop = 0;
    let gaze = -0.08; // where the eyes look, world pitch (negative = down)
    let headYaw = 0;
    let armLive = false;
    let lam = 9; // body stiffness
    this.handRoll = damp(this.handRoll, 0, 6, dt);
    this.armOut = damp(this.armOut, 0, 6, dt);

    // targets
    const bodyT = set(this.bodyT, 0, HIP, 0);
    let pitchT = 0,
      rollT = 0,
      yawT = 0;
    const [hand0, hand1] = this.handT;
    set(hand0, 0, 0, 0);
    set(hand1, 0, 0, 0);
    let handLam = 12;
    const feetT = this.feetT;
    set(feetT[0], sx[0], 0, 0);
    set(feetT[1], sx[1], 0, 0);
    const footPitchT = this.footPitchT;
    footPitchT[0] = footPitchT[1] = 0;
    let feetLam = 14;
    let feetWorld = false;

    switch (s.phase) {
      case 'idle':
      case 'ready': {
        const holding = s.phase === 'ready' || s.holding;
        const bob = Math.sin(t * 2.3) * 0.008;
        set(bodyT, 0, HIP - 0.025 + bob, 0);
        pitchT = -0.1;
        // the slide foot a little ahead, like bowlers stand
        set(feetT[slide], sx[slide] * 0.9, 0, -0.07);
        set(feetT[back], sx[back] * 0.9, 0, 0.02);
        if (holding) {
          // ball cradled at the chest on the bowling side: bowling hand under it, the other one steadying it
          this.chestBall(hs, bob);
          set(hand0, this.ball.x + hs * 0.02, this.ball.y - 0.075, this.ball.z + 0.035);
          set(hand1, this.ball.x - hs * 0.085, this.ball.y - 0.01, this.ball.z - 0.01);
        } else {
          set(hand0, hs * 0.31, 0.5 + bob, -0.04);
          set(hand1, -hs * 0.31, 0.5 + bob, -0.04);
          set(this.ball, hand0.x, hand0.y - 0.08, hand0.z);
          headYaw = Math.sin(t * 0.37) * 0.35;
        }
        gaze = -0.06;
        face.eyes = s.phase === 'ready' ? 'focus' : 'open';
        face.mouth = s.phase === 'ready' ? 'flat' : 'smile';
        face.brow = s.phase === 'ready' ? 0.35 : 0;
        break;
      }

      case 'approach': {
        const u = clamp(s.step);
        const last = smooth(clamp((u - 0.62) / 0.38));
        // bob with each step, sinking into the slide on the last one
        const phi = u * 4;
        const bob = Math.sin(Math.PI * (phi % 1)) * 0.022 - 0.012;
        set(bodyT, -hs * 0.03 * last, HIP - 0.03 + bob - 0.1 * last, -0.05 * last);
        pitchT = lerp(-0.12, -0.36, smooth(u));
        // shoulders open a little on the backswing
        yawT = -hs * 0.2 * clamp(-this.armNow / 1.7);
        rollT = -hs * 0.05 * last;
        lam = 12;
        feetWorld = true;
        // bowling arm: the live swing, eased in from the chest hold over the first moment
        armLive = true;
        this.swingIn = Math.min(1, this.swingIn + dt / 0.22);
        this.armNow = this.liveArm(s);
        // off arm out for balance once the ball leaves both hands
        const out = smooth(clamp((s.t - 0.12) / 0.3));
        const chest = this.chestBall(hs, 0, this.s1);
        const chest1 = set(this.s2, chest.x - hs * 0.085, chest.y - 0.01, chest.z - 0.01);
        lerpV(hand1, chest1, set(this.s3, -hs * 0.56, 0.74 - 0.08 * last, -0.12), out);
        handLam = 16;
        gaze = -0.3; // eyes on the arrows
        face.eyes = 'focus';
        face.mouth = last > 0.5 ? 'open' : 'flat';
        face.brow = 0.7;
        break;
      }

      case 'release': {
        // the slide: front knee bent deep, back leg swept behind, low and forward
        const k = easeOutCubic(clamp(s.t / 0.22));
        set(bodyT, -hs * 0.05, HIP - 0.15, -0.1);
        pitchT = -0.5;
        rollT = -hs * 0.12;
        yawT = hs * 0.08;
        lam = 14;
        set(feetT[slide], sx[slide] * 0.8, 0, -0.34);
        set(feetT[back], -hs * 0.02, 0.03, 0.58);
        footPitchT[back] = -0.75;
        feetLam = 10 + 8 * k;
        armLive = true;
        const scripted = lerp(this.armAtPhase, 0.75, easeOutCubic(clamp(s.t / 0.3)));
        this.armNow = Math.max(this.clampArm(s.arm), scripted);
        set(hand1, -hs * 0.62, 0.8, -0.16);
        handLam = 14;
        gaze = -0.22;
        face.eyes = 'focus';
        face.mouth = 'open';
        face.brow = 0.9;
        break;
      }

      case 'follow': {
        // arm up and through, the hand turning with the spin; hold the finish
        const k = easeOutCubic(clamp(s.t / 0.42));
        set(bodyT, -hs * 0.05, HIP - 0.13 + 0.03 * smooth(clamp((s.t - 0.5) / 0.6)), -0.09);
        pitchT = -0.44;
        rollT = -hs * 0.08;
        yawT = hs * 0.12;
        lam = 10;
        set(feetT[slide], sx[slide] * 0.8, 0, -0.34);
        set(feetT[back], -hs * 0.02, 0.03, 0.58);
        footPitchT[back] = -0.75;
        armLive = true;
        // finish high and a little outside the head, so it reads from behind too
        this.armNow = Math.max(this.clampArm(s.arm), lerp(this.armAtPhase, 2.4, k));
        this.armOut = 0.13 * k;
        this.handRoll = -hs * clamp(s.spin, -1, 1) * 1.4 * k;
        set(hand1, -hs * 0.6, 0.86, -0.14);
        gaze = -0.14;
        face.eyes = 'wide';
        face.mouth = 'o';
        face.brow = 0.8;
        break;
      }

      case 'watch': {
        // stand up and lean the way the ball should go (body english)
        const spin = clamp(s.spin, -1, 1);
        const sway = Math.sin(s.t * 3.1) * 0.07 * (1 - clamp(s.t / 3));
        const lean = spin * 0.22 + sway;
        set(bodyT, lean * 0.12, HIP - 0.03, -0.04);
        pitchT = -0.16;
        rollT = lean;
        lam = 4.5;
        set(feetT[slide], sx[slide] * 0.9, 0, -0.3);
        set(feetT[back], sx[back] * 1.1, 0, -0.12);
        feetLam = 5;
        // hands out in front, coaxing the ball along
        set(hand0, hs * 0.26 - lean * 0.5, 0.74, -0.34);
        set(hand1, -hs * 0.26 - lean * 0.5, 0.74, -0.34);
        handLam = 5;
        gaze = -0.05;
        headYaw = -lean * 0.4;
        face.eyes = 'focus';
        face.mouth = 'o';
        face.brow = 0.5;
        break;
      }

      case 'cheer': {
        const u = s.t;
        // two jumps with fists up, then a little bounce
        const j = u < 1.25 ? Math.max(0, Math.sin(u * Math.PI * 1.65)) : Math.abs(Math.sin(u * 7)) * 0.12;
        hop = j * 0.3;
        if (j < 0.02 && this.lastJump > 0.05) this.squashV -= 1.4;
        this.lastJump = j;
        set(bodyT, 0, HIP, 0);
        pitchT = 0.12;
        lam = 14;
        set(feetT[0], sx[0] * 1.2, j * 0.08, 0);
        set(feetT[1], sx[1] * 1.2, j * 0.08, 0);
        footPitchT[0] = footPitchT[1] = -0.4 * j;
        const pump = Math.sin(u * 13) * 0.05;
        set(hand0, hs * 0.34, 1.84 + pump, -0.1);
        set(hand1, -hs * 0.34, 1.84 - pump, -0.1);
        handLam = 16;
        gaze = 0.15;
        face.eyes = 'happy';
        face.mouth = 'grin';
        face.brow = 0.3;
        break;
      }

      case 'sad': {
        const u = s.t;
        // deflate: shoulders slump, arms dangle, head hangs, a long sigh
        const sigh = Math.sin(clamp(u / 1.4) * Math.PI) * 0.03;
        set(bodyT, 0, HIP - 0.08 - sigh, 0.02);
        pitchT = -0.52;
        lam = 5;
        set(feetT[0], sx[0] * 0.9, 0, 0);
        set(feetT[1], sx[1] * 0.9, 0, 0);
        set(hand0, hs * 0.27, 0.34, -0.12);
        set(hand1, -hs * 0.27, 0.34, -0.12);
        handLam = 6;
        gaze = -1.0;
        // a slow head shake
        headYaw = Math.sin(u * 6.5) * 0.28 * Math.max(0, 1 - u / 1.6);
        face.eyes = 'sad';
        face.mouth = 'frown';
        face.brow = -1;
        break;
      }
    }

    // ------------------------------------------------ body
    dampV(P.body, bodyT, lam, dt);
    P.bodyPitch = damp(P.bodyPitch, pitchT, lam, dt);
    P.bodyRoll = damp(P.bodyRoll, rollT, lam, dt);
    P.bodyYaw = damp(P.bodyYaw, yawT, lam, dt);
    P.hop = hop;

    // squash spring (landings)
    this.squashV += (1 - this.squash) * 180 * dt;
    this.squashV *= Math.exp(-14 * dt);
    this.squash += this.squashV * dt;
    P.squash = this.squash;

    // ------------------------------------------------ feet
    if (feetWorld) this.stepFeet(s, slide, dt);
    else {
      for (let i = 0; i < 2; i++) {
        dampV(P.feet[i], feetT[i], feetLam, dt);
        P.footPitch[i] = damp(P.footPitch[i], footPitchT[i], feetLam, dt);
      }
      // keep the world copy current so the next approach starts from here
      for (let i = 0; i < 2; i++) this.toWorld(P.feet[i], s, this.footW[i]);
    }

    // ------------------------------------------------ hands
    if (armLive) {
      // the bowling hand on its circle around the shoulder; the ball rides at the fingertips
      this.armHand(this.armNow, hs, this.tmp, this.tmp2);
      if (s.phase === 'approach' && this.swingIn < 1) {
        // ease out of the chest hold into the live swing
        const k = smooth(this.swingIn);
        const chest = this.chestBall(hs, 0, this.s1);
        const chestHand = set(this.s2, chest.x + hs * 0.02, chest.y - 0.075, chest.z + 0.035);
        lerpV(P.hands[0], chestHand, this.tmp, k);
        lerpV(this.ball, chest, this.tmp2, k);
      } else {
        cp(P.hands[0], this.tmp);
        cp(this.ball, this.tmp2);
      }
      dampV(P.hands[1], hand1, handLam, dt);
    } else {
      this.armNow = damp(this.armNow, 0, 6, dt);
      dampV(P.hands[0], hand0, handLam, dt);
      dampV(P.hands[1], hand1, handLam, dt);
      if (s.phase === 'ready' || (s.phase === 'idle' && s.holding)) {
        // the ball stays glued to the hands while they settle
        set(this.ball, P.hands[0].x - hs * 0.02, P.hands[0].y + 0.075, P.hands[0].z - 0.035);
      }
    }

    // ------------------------------------------------ head: gaze is in world pitch, the head sits on the pitched body
    this.headPitch = damp(this.headPitch, gaze - P.bodyPitch * 0.85, 8, dt);
    this.headYaw = damp(this.headYaw, headYaw - P.bodyYaw * 0.6, 8, dt);
    P.headPitch = this.headPitch;
    P.headYaw = this.headYaw;
    P.headRoll = -P.bodyRoll * 0.4 + Math.sin(t * 1.3) * 0.02;

    // ------------------------------------------------ face
    this.blinkT -= dt;
    if (t > this.blinkAt) {
      this.blinkT = 0.11;
      this.blinkAt = t + this.rng.range(1.8, 4.6);
    }
    const intense = face.eyes === 'happy' || face.eyes === 'wide' || s.phase === 'release';
    P.blink = this.blinkT > 0 && !intense ? 1 : 0;
    P.eyes = face.eyes;
    P.mouth = face.mouth;
    P.brow = damp(P.brow, face.brow, 12, dt);

    this.lastRoot.x = s.x;
    this.lastRoot.z = s.z;
    this.lastStep = s.step;
    return P;
  }

  // ---------------------------------------------------------------- helpers

  private enter(s: BowlerState) {
    const prev = this.phase;
    this.phase = s.phase;
    this.armAtPhase = this.armNow;
    if (s.phase === 'approach') {
      this.swingIn = prev === 'approach' ? 1 : 0;
      this.stepK = -1;
      this.travel = 0;
      this.measured = false;
      this.lastStep = s.step;
      for (let i = 0; i < 2; i++) this.toWorld(this.pose.feet[i], s, this.footW[i]);
    }
    if (s.phase !== 'approach' && prev === '') this.armNow = 0;
  }

  private replant(s: BowlerState) {
    this.started = true;
    for (let i = 0; i < 2; i++) this.toWorld(this.pose.feet[i], s, this.footW[i]);
    this.lastRoot.x = s.x;
    this.lastRoot.z = s.z;
    this.stepK = -1;
  }

  private clampArm(a: number) {
    return clamp(Number.isFinite(a) ? a : 0, -2.3, 2.7);
  }

  /** The approach's arm: the live swing, exactly. */
  private liveArm(s: BowlerState) {
    return this.clampArm(s.arm);
  }

  /** The ball held at the chest (both hands), bowling side. */
  private chestBall(hs: number, bob: number, out: V3 = this.ball) {
    // far enough forward to clear the round torso, even leaning in
    return set(out, hs * 0.1, 0.9 + bob, -0.4);
  }

  /** The bowling shoulder in root space, transformed exactly like Rig.apply does. */
  private shoulder(hs: number, o: V3) {
    const P = this.pose;
    let x = hs * 0.2 * (this.look.girth || 1),
      y = SH_Y * P.squash,
      z = 0;
    const cr = Math.cos(P.bodyRoll),
      sr = Math.sin(P.bodyRoll);
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    const cpch = Math.cos(P.bodyPitch),
      spch = Math.sin(P.bodyPitch);
    [y, z] = [y * cpch - z * spch, y * spch + z * cpch];
    const cy = Math.cos(P.bodyYaw),
      sy = Math.sin(P.bodyYaw);
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    return set(o, P.body.x + x, P.body.y + y, P.body.z + z);
  }

  /**
   * Hand on a circle around the shoulder in the root's forward plane: 0 hangs
   * straight down, − swings back (behind), + forward. The ball rides just past
   * the hand along the arm; if it would scrape the floor the elbow gives.
   */
  private armHand(a: number, hs: number, hand: V3, ball: V3) {
    const sh = this.shoulder(hs, this.sh);
    const ca = Math.cos(a),
      sa = Math.sin(a);
    const out = hs * (SWING_OUT * (0.35 + 0.65 * Math.max(0, ca)) + this.armOut);
    set(hand, sh.x + out, sh.y - ca * ARM_R, sh.z - sa * ARM_R);
    const br = LANE.ballR / this.scale;
    const floor = br + 0.02 + ca * BALL_OFF;
    if (hand.y < floor) hand.y = floor;
    set(ball, hand.x, hand.y - ca * BALL_OFF, hand.z - sa * BALL_OFF);
    return hand;
  }

  /** local foot → world (ground plane) */
  private toWorld(l: V3, s: BowlerState, o: V3) {
    const c = Math.cos(s.yaw),
      sn = Math.sin(s.yaw);
    const k = this.scale;
    o.x = s.x + k * (l.x * c + l.z * sn);
    o.z = s.z + k * (-l.x * sn + l.z * c);
    o.y = 0;
    return o;
  }

  /** world (ground plane) → local foot */
  private toLocal(w: V3, s: BowlerState, o: V3) {
    const c = Math.cos(s.yaw),
      sn = Math.sin(s.yaw);
    const dx = w.x - s.x,
      dz = w.z - s.z;
    o.x = (c * dx - sn * dz) / this.scale;
    o.z = (sn * dx + c * dz) / this.scale;
    return o;
  }

  /**
   * Four steps over s.step 0…1 (right-handers: right, left, right, left-slide).
   * The stepping foot flies from where it left the floor to a spot ahead of
   * where the root will be when it lands; the other foot stays planted in world
   * space. Stride follows the measured root travel, so a root that doesn't move
   * just marks time instead of moonwalking.
   */
  private stepFeet(s: BowlerState, slide: number, dt: number) {
    const P = this.pose;
    const back = 1 - slide;
    const u = clamp(s.step);
    // measure how far the root travels per unit of step
    const ds = u - clamp(this.lastStep);
    if (ds > 1e-4) {
      const fx = -Math.sin(s.yaw),
        fz = -Math.cos(s.yaw);
      const d = (s.x - this.lastRoot.x) * fx + (s.z - this.lastRoot.z) * fz;
      this.travel = lerp(this.travel, clamp(d / ds, 0, 6), this.measured ? 0.25 : 1);
      this.measured = true;
    }
    const phi = Math.min(u * 4, 3.9999);
    const k = Math.floor(phi);
    const f = phi - k;
    const swing = k % 2 === 0 ? back : slide;
    if (k !== this.stepK) {
      this.stepK = k;
      cp(this.liftW[swing], this.footW[swing]);
    }
    const perStep = this.travel / 4;
    const lastStep = k === 3;
    // land half a step ahead of where the root will be (a bit further for the slide)
    const ahead = (1 - f) * perStep + Math.min(0.45, perStep * 0.5) + (lastStep ? 0.12 : 0.02);
    const sideX = HIP_X[swing] * (lastStep ? 0.8 : 0.95);
    const tgt = this.toWorld(set(this.s1, sideX, 0, -ahead / this.scale), s, this.tmp);
    const e = smooth(f);
    lerpV(this.footW[swing], this.liftW[swing], tgt, e);
    // local copies for the pose
    for (let i = 0; i < 2; i++) {
      const L = this.toLocal(this.footW[i], s, P.feet[i]);
      L.y = 0;
      P.footPitch[i] = damp(P.footPitch[i], 0, 10, dt);
    }
    const lift = Math.sin(Math.PI * f) * (lastStep ? 0.035 : 0.085);
    P.feet[swing].y = lift;
    P.footPitch[swing] = Math.sin(Math.PI * 2 * f) * 0.35;
  }
}
