// Procedural animation: turns a TPlayer's gameplay state into a Pose.

import { newPose, type Pose } from './pose';
import { CHAR_SCALE, RACKET_SWEET, HIP } from './rig';
import type { TPlayer, SwingState, Athletic } from '../tennis/player';
import { clamp, lerp, smooth, easeOutCubic, easeInCubic, type V3, Rng, damp } from '../core/math';
import { hyp2, hyp3 } from '../tennis/hypot';

type Vec = [number, number, number];

const READY_HAND: Vec = [0.25, 0.8, -0.34];
const READY_DIR: Vec = [-0.22, 0.62, -0.75];

const V = (x: number, y: number, z: number): V3 => ({ x, y, z });
const set = (o: V3, x: number, y: number, z: number) => ((o.x = x), (o.y = y), (o.z = z), o);
const lerpV = (o: V3, a: V3, b: V3, t: number) => set(o, lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
/** o = a → (x, y, z) by t (the target as numbers: no vector made for it) */
const lerpXYZ = (o: V3, a: V3, x: number, y: number, z: number, t: number) => set(o, lerp(a.x, x, t), lerp(a.y, y, t), lerp(a.z, z, t));
const norm = (o: V3) => {
  const l = hyp3(o.x, o.y, o.z) || 1;
  o.x /= l;
  o.y /= l;
  o.z /= l;
  return o;
};

interface Key {
  hand: V3;
  dir: V3;
  off: V3;
  twist: number;
}

// scratch vectors: each is used within one call and never kept (the animators run one after another)
const T_SHAFT = V(0, 0, 0);
const T_SH = V(0, 0, 0);
const T_ARM = V(0, 0, 0);
const T_HAND = V(0, 0, 0);
const T_HV = V(0, 0, 0);
const T_FACE = V(0, 0, 0);
const T_LOCAL = V(0, 0, 0);
const C_LOCAL = V(0, 0, 0);
const C_SH = V(0, 0, 0);
const C_D = V(0, 0, 0);

/** how fast the racket follows the phone (1/s): while the stream is live, and when it is going stale or coming back */
const MIRROR_LIVE = 60;
const MIRROR_STALE = 10;
/** a stream that came back after a gap is eased in for this long (s) before it counts as live */
const MIRROR_EASE = 0.3;

const key = (): Key => ({ hand: V(0, 0, 0), dir: V(0, 1, 0), off: V(0, 0, 0), twist: 0 });

function keyFrom(k: Key, hs: number, hand: Vec, dir: Vec, off: Vec, twist: number) {
  set(k.hand, hand[0] * hs, hand[1], hand[2]);
  set(k.dir, dir[0] * hs, dir[1], dir[2]);
  norm(k.dir);
  set(k.off, off[0] * hs, off[1], off[2]);
  k.twist = twist * hs;
  return k;
}

function copyKey(o: Key, a: Key) {
  set(o.hand, a.hand.x, a.hand.y, a.hand.z);
  set(o.dir, a.dir.x, a.dir.y, a.dir.z);
  set(o.off, a.off.x, a.off.y, a.off.z);
  o.twist = a.twist;
}

/** a swing drawn from the past is eased in over this long (s), counted in frames' worth: it must also finish through a hit-stop */
const SWING_EASE = 0.05;

function lerpKey(o: Key, a: Key, b: Key, t: number) {
  lerpV(o.hand, a.hand, b.hand, t);
  lerpV(o.dir, a.dir, b.dir, t);
  norm(o.dir);
  lerpV(o.off, a.off, b.off, t);
  o.twist = lerp(a.twist, b.twist, t);
  return o;
}

export class Animator {
  pose: Pose = newPose();
  private phase = 0;
  private readonly prevHand = V(0, 0, 0);
  private face = V(0, 0, -1);
  private blinkAt = 0;
  private blinkT = 0;
  private rng = new Rng();
  private k = { ready: key(), prep: key(), contact: key(), follow: key(), a: key(), b: key(), out: key(), last: key() };
  /** the swing whose arrival is being eased in (one heard after it was made is drawn well into its stroke; the arms get there over a few frames, not one) */
  private easing: object | null = null;
  private easeT = 0;
  private anticip = 0;
  private headYaw = 0;
  private headPitch = 0;
  private lean = 0;
  private roll = 0;
  private squashV = 0;
  private squash = 1;
  private lastEmote = 'none';
  private stepBeat = 0;
  scale: number;
  /** live phone orientation (player frame) — the racket mirrors it between swings */
  phone: { s: [number, number, number]; n: [number, number, number] } | null = null;
  private mirror = 0;
  /** how long the phone's stream has been live without a break (s), and whether it ever has been */
  private liveFor = 0;
  private everLive = false;

  constructor(public p: TPlayer) {
    this.scale = CHAR_SCALE * (p.look.height || 1);
    this.pose.handed = p.handed;
    this.blinkAt = this.rng.range(1, 4);
  }

  /** world → root-local (unscaled) */
  private toLocal(wx: number, wy: number, wz: number, o: V3) {
    const p = this.p;
    const c = Math.cos(p.yaw),
      s = Math.sin(p.yaw);
    const dx = wx - p.x,
      dz = wz - p.z;
    o.x = (c * dx - s * dz) / this.scale;
    o.z = (s * dx + c * dz) / this.scale;
    o.y = wy / this.scale;
    return o;
  }

  update(t: number, dt: number, ball: V3, state: string): Pose {
    const p = this.p;
    const P = this.pose;
    const hs = p.handed;
    const K = this.k;
    P.x = p.x;
    P.z = p.z;
    P.yaw = p.yaw;
    P.holdingBall = p.holding;
    P.tired = p.tired;

    // ------------------------------------------------ locomotion
    const speed = p.speed();
    const c = Math.cos(p.yaw),
      s = Math.sin(p.yaw);
    const lvx = c * p.vx - s * p.vz;
    const lvz = s * p.vx + c * p.vz;
    this.phase += (speed * dt * Math.PI * 2) / 0.95;
    const run = clamp(speed / 3.2);
    const move = clamp(speed / 1.2);

    // ready-stance hop (split step) when focused and not running
    const ready = p.focus * (1 - move);
    const hopF = state === 'play' || state === 'toss' ? 2.3 : 1.2;
    const hop = Math.pow(Math.abs(Math.sin(t * Math.PI * hopF + p.id)), 3) * 0.03 * ready;

    // feet
    const stance = 0.14 + 0.05 * ready;
    const dl = hyp2(lvx, lvz) || 1;
    const dx = lvx / dl,
      dz = lvz / dl;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const ph = this.phase + i * Math.PI;
      const stride = Math.sin(ph) * 0.22 * run;
      const lift = Math.max(0, Math.cos(ph)) * 0.1 * move;
      const f = P.feet[i];
      f.x = side * stance + dx * stride;
      f.z = 0.02 + dz * stride;
      f.y = lift + (1 - move) * Math.max(0, hop * 0.6);
      P.footPitch[i] = -Math.cos(ph) * 0.35 * run;
    }

    // body
    // (the rig: + bodyPitch leans back, + headPitch looks up) — lean into a run
    // forwards (lvz < 0) and crouch forward in the ready stance
    const targetLean = clamp(lvz * 0.05, -0.3, 0.25) - ready * 0.14;
    this.lean = damp(this.lean, targetLean, 8, dt);
    this.roll = damp(this.roll, clamp(-lvx * 0.045, -0.2, 0.2), 8, dt);
    const bob = Math.abs(Math.sin(this.phase)) * 0.045 * run;
    P.body.x = 0;
    P.body.z = 0;
    P.body.y = HIP + bob + Math.sin(t * 2.1 + p.id) * 0.006 - ready * 0.05;
    P.hop = hop;
    P.bodyPitch = this.lean;
    P.bodyRoll = this.roll;

    // step thump squash
    const beat = Math.floor(this.phase / Math.PI);
    if (beat !== this.stepBeat && run > 0.4) {
      this.squashV -= 0.35 * run;
      this.stepBeat = beat;
    }
    this.squashV += (1 - this.squash) * 180 * dt;
    this.squashV *= Math.exp(-14 * dt);
    this.squash += this.squashV * dt;

    // ------------------------------------------------ arms & racket
    keyFrom(K.ready, hs, READY_HAND, READY_DIR, [0, 0, 0], 0);
    // running: racket up and a little bouncy
    K.ready.hand.y += Math.sin(this.phase * 2) * 0.03 * run;
    K.ready.hand.z += 0.06 * run;
    this.readyOff(K.ready);

    const sw = p.swing;
    let out = K.out;
    let handAbs: V3 | null = null;
    let effort = 0;

    if (sw) {
      this.swingPose(t, sw, hs, out);
      if (sw.instant) {
        // the stroke is drawn `age` into its follow-through: from the pose of the frame before it, in a few frames
        if (this.easing !== sw) {
          this.easing = sw;
          this.easeT = 0;
        }
        if (this.easeT < SWING_EASE) {
          this.easeT += 1 / 60;
          lerpKey(out, K.last, out, smooth(clamp(this.easeT / SWING_EASE)));
        }
      }
      if (t >= sw.tc - 0.06 && t < sw.tc + 0.18) effort = 1;
      handAbs = out.hand;
    } else if (p.holding || state === 'toss') {
      this.servePose(t, hs, out);
    } else {
      // anticipation: turn and take the racket back as the ball comes
      let a = 0;
      let stroke = p.lastStroke;
      if (p.plan) {
        const tt = p.plan.t - t;
        a = smooth(clamp((0.85 - tt) / 0.55));
        stroke = p.plan.stroke;
      }
      this.anticip = damp(this.anticip, a, 10, dt);
      this.prepKey(stroke, hs, K.prep);
      lerpKey(out, K.ready, K.prep, this.anticip);
    }

    if (!sw) copyKey(K.last, out);

    // 1:1 racket: between swings the racket follows the phone in your hand
    const wantMirror = this.phone && !sw && !p.holding && state !== 'toss' ? 1 - this.anticip * 0.75 : 0;
    // (the pose we draw from is already carried on to now: while the stream is live it is followed
    // with about a frame of smoothing, so a swing's setup shows as the phone makes it. The slow
    // fade is for the stream coming and going: a stale pose is let go gently, a returning one
    // eased in. The very first sample is copied.)
    if (this.phone && !this.everLive) {
      this.everLive = true;
      this.liveFor = MIRROR_EASE;
      this.mirror = wantMirror;
    } else {
      this.liveFor = this.phone ? this.liveFor + dt : 0;
      this.mirror = damp(this.mirror, wantMirror, this.liveFor >= MIRROR_EASE ? MIRROR_LIVE : MIRROR_STALE, dt);
    }
    if (this.phone && this.mirror > 0.01) {
      // player frame (x right, y towards screen, z up) → character local (x right, y up, −z forward)
      const ps = this.phone.s;
      const shaft = set(T_SHAFT, ps[0], ps[2], -ps[1]);
      norm(shaft);
      // the hand sits out along the racket from the shoulder, like an arm holding it
      const sh = set(T_SH, hs * 0.2, 0.95, 0.02);
      const arm = set(T_ARM, shaft.x, Math.max(-0.6, shaft.y), Math.min(0.2, shaft.z));
      norm(arm);
      const hand = set(T_HAND, sh.x + arm.x * 0.42, sh.y + arm.y * 0.42, sh.z + arm.z * 0.42);
      const k = this.mirror;
      lerpV(out.hand, out.hand, hand, k);
      lerpV(out.dir, out.dir, shaft, k);
      norm(out.dir);
    }

    // lunges, dives and jumps for balls at the edge of reach
    let athleticFace = '';
    if (p.athletic) athleticFace = this.athleticPose(t, p.athletic, P, out, !!sw);

    // emotes override
    const em = p.emote;
    if (em !== 'none' && t >= p.emoteT0 && !sw) {
      const u = t - p.emoteT0;
      if (em === 'celebrate') {
        const j = Math.max(0, Math.sin(Math.min(u, 1.2) * Math.PI * 1.7));
        P.hop = j * 0.32;
        keyFrom(K.a, hs, [0.3, 1.85, -0.12], [0.15, 1, 0.1], [-0.32, 1.4, -0.25], 0);
        lerpKey(out, out, K.a, smooth(clamp(u * 5)));
        P.bodyPitch = 0.1; // chest up
        if (this.lastEmote !== em) this.squashV += 1.2;
      } else if (em === 'sad') {
        keyFrom(K.a, hs, [0.3, 0.45, -0.1], [0.2, -0.7, -0.5], [-0.28, 0.5, -0.1], 0);
        lerpKey(out, out, K.a, smooth(clamp(u * 3)));
        P.bodyPitch = lerp(P.bodyPitch, -0.32, smooth(clamp(u * 3))); // slump forward
      } else if (em === 'wave') {
        keyFrom(K.a, hs, [0.35, 1.6 + Math.sin(u * 12) * 0.05, -0.1], [Math.sin(u * 12) * 0.6, 1, 0], [-0.25, 0.8, -0.2], 0);
        lerpKey(out, out, K.a, smooth(clamp(u * 4)));
        P.hop = Math.abs(Math.sin(u * 6)) * 0.08;
      }
    }
    this.lastEmote = em;

    // out of breath: shoulders heave, the racket droops
    const tired = p.tired;
    if (tired > 0.02 && !sw && !p.athletic) {
      P.body.y += Math.sin(t * 13) * 0.014 * tired;
      out.hand.y -= 0.1 * tired;
      out.off.y -= 0.08 * tired;
      P.bodyPitch -= 0.12 * tired; // hunched over
    }

    // write hands & racket
    set(P.hands[0], out.hand.x, out.hand.y, out.hand.z);
    set(P.hands[1], out.off.x, out.off.y, out.off.z);
    set(P.racketDir, out.dir.x, out.dir.y, out.dir.z);
    P.bodyYaw = out.twist;

    // racket face follows the hand's motion (so it faces the swing direction)
    const hv = set(T_HV, P.hands[0].x - this.prevHand.x, P.hands[0].y - this.prevHand.y, P.hands[0].z - this.prevHand.z);
    const hvl = hyp3(hv.x, hv.y, hv.z) / Math.max(dt, 1e-3);
    set(this.prevHand, P.hands[0].x, P.hands[0].y, P.hands[0].z);
    if (hvl > 1.2 && handAbs) {
      norm(hv);
      lerpV(this.face, this.face, hv, clamp(dt * 25));
    } else if (this.phone && this.mirror > 0.3) {
      // mirror the phone's screen as the racket face
      const pn = this.phone.n;
      const f = set(T_FACE, pn[0], pn[2], -pn[1]);
      norm(f);
      // (the phone's pose arrives already carried on to now: only a light hand on the stepping, not the ~50 ms trail of the old 20/s)
      lerpV(this.face, this.face, f, 1 - Math.exp(-70 * dt * this.mirror));
    } else {
      // at rest the face looks forward / to the side
      const rest = set(T_FACE, hs * 0.55, 0.05, -0.8);
      norm(rest);
      lerpV(this.face, this.face, rest, clamp(dt * 8));
    }
    norm(this.face);
    set(P.racketFace, this.face.x, this.face.y, this.face.z);

    // ------------------------------------------------ head looks at the ball
    const lb = this.toLocal(ball.x, ball.y, ball.z, T_LOCAL);
    const hy = 1.07;
    const wantYaw = clamp(Math.atan2(-lb.x, -lb.z) - out.twist, -1.0, 1.0);
    const dist = hyp2(lb.x, lb.z);
    const wantPitch = clamp(Math.atan2(lb.y - hy, Math.max(0.3, dist)), -0.5, 0.7);
    const looking = state === 'play' || state === 'toss' || state === 'serve';
    this.headYaw = damp(this.headYaw, looking ? wantYaw : 0, 9, dt);
    this.headPitch = damp(this.headPitch, looking ? wantPitch : 0, 9, dt);
    P.headYaw = this.headYaw;
    P.headPitch = this.headPitch * 0.8 - (em === 'sad' && t > p.emoteT0 ? 0.45 : 0);
    P.headRoll = Math.sin(t * 1.3 + p.id) * 0.03;
    P.headPitch -= 0.14 * tired;

    // ------------------------------------------------ face
    this.blinkT -= dt;
    if (t > this.blinkAt) {
      this.blinkT = 0.11;
      this.blinkAt = t + this.rng.range(1.8, 4.8);
    }
    P.blink = this.blinkT > 0 ? 1 : 0;
    if (em === 'celebrate' && t >= p.emoteT0) {
      P.eyes = 'happy';
      P.mouth = 'grin';
      P.brow = 0.3;
    } else if (em === 'sad' && t >= p.emoteT0) {
      P.eyes = 'sad';
      P.mouth = 'frown';
      P.brow = -1;
    } else if (tired > 0.55 && !effort && !athleticFace) {
      P.eyes = 'sad';
      P.mouth = 'open';
      P.brow = -0.4;
    } else if (athleticFace) {
      P.eyes = athleticFace === 'oof' ? 'closed' : 'wide';
      P.mouth = athleticFace === 'oof' ? 'flat' : 'open';
      P.brow = 0.9;
      P.blink = 0;
    } else if (effort) {
      P.eyes = sw && sw.input.power > 0.8 ? 'closed' : 'focus';
      P.mouth = 'open';
      P.brow = 0.8;
      P.blink = 0;
    } else if (p.focus > 0.5) {
      P.eyes = 'focus';
      P.mouth = 'flat';
      P.brow = 0.6;
    } else {
      P.eyes = 'open';
      P.mouth = 'smile';
      P.brow = 0;
    }
    if (effort && sw && t >= sw.tc && t < sw.tc + 0.05) this.squashV += 0.8;
    P.squash = this.squash;
    return P;
  }

  /**
   * Lunge: lead foot out wide, body low and leaning in. Jump: a quick hop with
   * the feet tucked. Dive: crouch, fly with the body tipping horizontal and the
   * racket at full stretch, land on your side, then get back up.
   * Returns a face hint ('fly' in the air, 'oof' on landing).
   */
  private athleticPose(t: number, a: Athletic, P: Pose, out: Key, swinging: boolean): string {
    const side = a.side;
    const span = Math.max(0.05, a.tc - a.t0);
    const u = clamp((t - a.t0) / span);
    if (a.move === 'jump') {
      const f = clamp((t - a.t0) / (span + 0.22));
      const h = Math.sin(f * Math.PI);
      P.hop = Math.max(P.hop, h * 0.42);
      for (const ft of P.feet) ft.y += h * 0.16;
      P.footPitch[0] = P.footPitch[1] = -0.5 * h;
      P.bodyPitch -= 0.12 * h;
      return h > 0.2 ? 'fly' : '';
    }
    if (a.move === 'lunge') {
      const k = t <= a.tc ? smooth(u) : 1 - smooth(clamp((t - a.tc - 0.12) / 0.2));
      const lead = side > 0 ? 1 : 0;
      const back = 1 - lead;
      P.feet[lead].x = lerp(P.feet[lead].x, side * 0.58, k);
      P.feet[lead].z = lerp(P.feet[lead].z, -0.28, k);
      P.feet[lead].y *= 1 - k;
      P.feet[back].x = lerp(P.feet[back].x, -side * 0.12, k);
      P.feet[back].z = lerp(P.feet[back].z, 0.16, k);
      P.body.x = side * 0.14 * k;
      P.body.y -= 0.13 * k;
      P.bodyRoll = lerp(P.bodyRoll, -side * 0.3, k);
      P.bodyPitch -= 0.22 * k;
      if (!swinging) {
        lerpXYZ(out.hand, out.hand, side * 0.78, 0.55, -0.22, k);
        lerpXYZ(out.dir, out.dir, side * 0.8, 0.35, -0.45, k);
        norm(out.dir);
      }
      return '';
    }
    // dive
    const flight = clamp((u - 0.18) / 0.82);
    let lie = 0; // 0 upright … 1 flat on your side
    let crouch = 0;
    let face = '';
    if (t <= a.tc) {
      crouch = 1 - smooth(clamp(u / 0.2));
      lie = easeOutCubic(flight) * 0.92;
      // takeoff arc, coming down near the ground at contact
      P.hop = Math.sin(flight * Math.PI * 0.82) * 0.46 + flight * 0.08;
      face = 'fly';
    } else {
      const since = t - a.tc;
      const rise = smooth(clamp((since - 0.42) / 0.4));
      lie = 1 - rise;
      P.hop = 0;
      if (since < 0.08) this.squashV -= 1.2;
      face = since < 0.4 ? 'oof' : '';
    }
    P.body.y = lerp(P.body.y - 0.12 * crouch, 0.27, lie);
    P.body.x = side * 0.2 * lie;
    P.bodyRoll = -side * 1.42 * lie;
    P.bodyPitch = lerp(P.bodyPitch, 0.1, lie);
    // legs trail behind the dive, low to the court
    for (let i = 0; i < 2; i++) {
      const f = P.feet[i];
      f.x = lerp(f.x, -side * (0.3 + i * 0.1), lie);
      f.y = lerp(f.y, 0.14 + (t <= a.tc ? 0.1 : 0), lie);
      f.z = lerp(f.z, 0.05 + (i === 0 ? -0.1 : 0.1), lie);
      P.footPitch[i] = lerp(P.footPitch[i], 0.9, lie);
    }
    if (!swinging || t > a.tc) {
      // both arms reaching for the ball
      lerpXYZ(out.hand, out.hand, side * 1.08, 0.36, -0.2, lie);
      lerpXYZ(out.dir, out.dir, side, 0.15, -0.3, lie);
      norm(out.dir);
      lerpXYZ(out.off, out.off, side * 0.7, 0.24, -0.34, lie);
    }
    return face;
  }

  private readyOff(k: Key) {
    // off hand cradles the racket throat
    set(k.off, k.hand.x + k.dir.x * 0.26, k.hand.y + k.dir.y * 0.26, k.hand.z + k.dir.z * 0.26);
  }

  private prepKey(stroke: string, hs: number, k: Key) {
    if (stroke === 'bh') {
      keyFrom(k, hs, [-0.46, 0.9, 0.24], [-0.35, 0.62, 0.7], [-0.36, 0.92, 0.16], 0.85);
    } else if (stroke === 'oh') {
      keyFrom(k, hs, [0.34, 1.42, 0.22], [0.1, -0.35, 0.93], [-0.2, 1.72, -0.34], -0.45);
    } else {
      keyFrom(k, hs, [0.56, 0.92, 0.3], [0.32, 0.55, 0.77], [-0.26, 0.95, -0.46], -0.7);
    }
  }

  private followKey(stroke: string, hs: number, k: Key) {
    if (stroke === 'bh') keyFrom(k, hs, [0.44, 1.28, -0.1], [0.3, 0.85, 0.42], [0.26, 1.12, -0.18], -0.6);
    else if (stroke === 'oh' || stroke === 'serve') keyFrom(k, hs, [-0.26, 0.55, -0.34], [-0.3, -0.6, -0.72], [-0.36, 0.72, -0.1], 0.5);
    else keyFrom(k, hs, [-0.38, 1.24, -0.12], [-0.42, 0.8, 0.44], [-0.36, 1.05, -0.22], 0.58);
  }

  /** Contact key: the racket's sweet spot sits exactly on the ball. */
  private contactKey(sw: SwingState, hs: number, k: Key) {
    const c = this.toLocal(sw.cx, sw.cy, sw.cz, C_LOCAL);
    const high = sw.stroke === 'oh' || sw.stroke === 'serve';
    const sh = set(C_SH, hs * 0.2, high ? 1.02 : 0.9, 0.02);
    const d = set(C_D, c.x - sh.x, c.y - sh.y, c.z - sh.z);
    const len = hyp3(d.x, d.y, d.z);
    norm(d);
    if (!high) {
      // keep groundstroke rackets fairly level
      d.y *= 0.6;
      norm(d);
    }
    set(k.dir, d.x, d.y, d.z);
    const reach = Math.max(0.12, len - RACKET_SWEET);
    set(k.hand, sh.x + d.x * reach, sh.y + d.y * reach, sh.z + d.z * reach);
    // off hand: two-handed backhand stays on the grip, otherwise balances
    if (sw.stroke === 'bh') set(k.off, k.hand.x - hs * 0.05, k.hand.y + 0.02, k.hand.z + 0.06);
    else if (high) set(k.off, -hs * 0.3, 1.05, -0.3);
    else set(k.off, -hs * 0.34, 0.95, -0.2);
    k.twist = 0;
    return k;
  }

  private swingPose(t: number, sw: SwingState, hs: number, out: Key) {
    const K = this.k;
    if (sw.stroke === 'serve') keyFrom(K.prep, hs, [0.38, 1.3, 0.24], [0.15, -0.55, 0.82], [-0.08, 1.8, -0.3], -0.3);
    else this.prepKey(sw.stroke, hs, K.prep);
    this.contactKey(sw, hs, K.contact);
    this.followKey(sw.stroke, hs, K.follow);
    const tFollow = sw.tc + (sw.stroke === 'serve' ? 0.22 : 0.2);
    if (t < sw.tc) {
      const u = easeInCubic(clamp((t - sw.t0) / Math.max(0.02, sw.tc - sw.t0)));
      lerpKey(out, K.prep, K.contact, u);
      // loop: dip the racket before rising into the ball (low-to-high)
      out.hand.y -= Math.sin(u * Math.PI) * 0.12 * (sw.stroke === 'serve' || sw.stroke === 'oh' ? -0.6 : 1);
    } else if (t < tFollow) {
      const u = easeOutCubic(clamp((t - sw.tc) / (tFollow - sw.tc)));
      lerpKey(out, K.contact, K.follow, u);
    } else {
      const u = smooth(clamp((t - tFollow) / Math.max(0.05, sw.te - tFollow)));
      lerpKey(out, K.follow, K.ready, u);
    }
    if (sw.stroke !== 'bh' && t > sw.tc) {
      // release the off hand after contact
    }
  }

  private servePose(t: number, hs: number, out: Key) {
    const p = this.p;
    const K = this.k;
    // holding: ball in the off hand in front, racket relaxed at the side
    keyFrom(K.a, hs, [0.32, 0.72, -0.18], [0.3, 0.25, -0.9], [-0.12, 0.82, -0.36], -0.1);
    if (p.holding || p.tossT < 0) {
      // gentle ball bounce rhythm while waiting
      K.a.off.y += Math.sin(t * 4.2) * 0.02;
      lerpKey(out, K.a, K.a, 0);
      return;
    }
    const u = t - p.tossT;
    // trophy pose: toss arm up, racket drops behind the back
    keyFrom(K.b, hs, [0.38, 1.3, 0.24], [0.15, -0.55, 0.82], [-0.08, 1.8, -0.3], -0.3);
    lerpKey(out, K.a, K.b, smooth(clamp(u / 0.42)));
  }
}
