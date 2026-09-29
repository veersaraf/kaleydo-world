// Sword duel: slash and thrust detection from raw phone motion.
//
// The phone is the sword's grip: its top is the blade, as the TV draws it
// (duel/types.ts aimFromPhone). Everything is measured in the player frame
// (x right, y towards the screen, z up) via the orientation quaternion, so it
// works however the phone sits in the hand — upright in a fist (the screen to
// the face, grip at the bottom), pointed at the TV like a remote, or anything
// between.
//
// Real swings aren't textbook arcs about the wrist. People swing from the
// elbow and the shoulder, keep an upright phone upright while sweeping it
// sideways (a turn about the blade itself), twist the forearm, and stop
// short. So a swing is judged at the tip of an imaginary sword held out in
// front: the forearm reaching towards the screen (LA) with the blade on its
// end (LB). The tip's speed and the way it travels across the player's view
// come from the phone's rotation (ω × lever), so:
//
//  • an upright phone swept sideways (ω about the vertical) is a sideways cut
//    (the forearm carries the tip across), not a twist that moves nothing;
//  • a chop (ω about the right axis) goes down whether the phone points up,
//    ahead or anywhere between;
//  • a heading that's a little off hardly matters: up and down don't depend
//    on it, and left/right only shrink by its cosine.
//
//  • stroke  — the tip's angular speed S = |ω × lever|: a stroke starts above
//              START and is judged once its peak is past (~40 ms later).
//  • blow    — the peak reaches MIN_PEAK (≈ 220°/s; a relaxed swing is
//              300–900°/s), the tip turned at least MIN_SWEEP by then, and it
//              went one way (not a scribble). A stroke that falls a little
//              short is a near miss: the phone says "swing harder".
//  • dir     — which way the tip travelled across the view (x right, z up)
//              over the last 200 ms up to the peak, weighted by speed² (the
//              fast part decides).
//  • power   — from the peak speed: a gentle flick ≈ 0.25, a full swing 1.
//  • windups — drawing the sword back (raising it for a chop, out to the
//              side for a cut) is a stroke too. A blow that follows a windup —
//              motion the other way just before it — goes at once. One that
//              doesn't, and could itself be a windup (it goes up, or isn't
//              hard), waits (up to HOLD ms, or until the phone comes to rest):
//              if a harder stroke comes back the other way, that was its
//              windup and only the blow counts. Rising cuts have to be a
//              little harder than other blows.
//  • after a blow — the recoil and the return to guard: nothing until the
//              motion settles below SETTLE of the blow's peak, nothing within
//              GAP, and for RETURN_MS a stroke back the other way has to be
//              nearly as hard as the blow (a deliberate back-cut is; the
//              return isn't).
//  • thrust  — a push towards the screen (a leaky integral of the
//              accelerometer: the hand's velocity) with the tip hardly
//              turning.
//  • guard   — while GUARD is held nothing attacks (swinging then only angles
//              the guard — let go to attack, as in Chambara); a swing made
//              with the guard held is reported (onGuarded) so the phone can
//              say why nothing happened.
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
  /** ms: the peak of the stroke (slash: tip speed; thrust: push speed) */
  t: number;
  /** for tuning: peak tip speed, rad/s (thrust: push speed, m/s; swipe: px/ms) */
  peak: number;
  /** for tuning: how far the tip turned from the stroke's start to the decision, rad */
  sweep: number;
}

/** Every stroke the detector judged, and what it made of it (for tuning: scripts/replay-capture.ts). */
export interface SwordJudged {
  /** its peak: when, how fast (rad/s), which way */
  t: number;
  peak: number;
  dir: number;
  /** how far the tip turned (rad); how much of its travel was across the view, and one way (0..1) */
  sweep: number;
  across: number;
  coherent: number;
  /** what a blow needed (base: before the return-after-a-blow rule) */
  need: number;
  base: number;
  /** how fast the sword was drawn back the other way just before (its windup, rad/s: see WOUND) */
  wound: number;
  verdict: 'blow' | 'held' | 'windup' | 'weak' | 'near' | 'shapeless' | 'too soon' | 'guard';
}

/** A stroke that looked meant but was too gentle to be a blow (the phone says "swing harder"). */
export interface SwordNearMiss {
  t: number;
  /** its peak tip speed, and what a blow needed, rad/s */
  peak: number;
  need: number;
  dir: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

const N = 128; // sample history (≥ 1.2 s at 100 Hz)

// the imaginary sword: the forearm reaching towards the screen, the blade (the phone's top) on its end
const LA = 0.45;
const LB = 0.6;
// slashes (rad/s of the tip; divided by the sensitivity setting)
const START = 1.8; // a stroke begins
const MIN_PEAK = 3.3; // a blow peaks at least this fast (≈ 190°/s)
const NEAR = 2.4; // …a snappy stroke between this and MIN_PEAK is a near miss ("swing harder")…
const NEAR_RISE = 0.15; // …one that got up to speed this fast (s, from half its peak)
const FLICK = 4.2; // a gentle flick: power 0.25
const FULL = 13; // a full swing: power 1 (÷ √sensitivity)
const CONFIRM = 0.75; // the peak is past once the speed is down to this much of it…
const CONFIRM_MS = 45; // …or this long without a new high
const MAX_STROKE = 1000; // ms: longer than this without a peak isn't a blow (a twirl)
const MIN_SWEEP = 0.3; // rad the tip turns by the decision (a knock doesn't)…
const NEAR_SWEEP = 0.15; // …a near miss, at least this
const COHERENT = 0.5; // |Σ v| / Σ |v|: the stroke goes one way (not a scribble)
const ACROSS = 0.3; // share of the tip's travel that's across the view (not straight at the screen)
// The tip's way across the view, as the phone reads it, is read in the swing's plane. A hand swing
// isn't in the view's plane: a right-hander's cuts lean (the arm swings about the shoulder), and a
// sideways cut always carries a downward roll of the wrist. On a real player's labelled swings
// (scripts/sword-capture-test.ts) the directions came out turned ~20° clockwise (down read ↙, left
// ↖) and stretched downwards (a right cut read ↘, no different from a down-right one). Turn the
// reading back by DIR_ROLL and shrink its vertical by DIR_DIP; swingRead() is that map, for tests.
const DIR_ROLL = (12 * Math.PI) / 180;
const DIR_DIP = 0.55;
const COS_ROLL = Math.cos(DIR_ROLL),
  SIN_ROLL = Math.sin(DIR_ROLL);
/** where the imaginary sword's tip is (unit vector from the elbow), the blade being held at b (player frame) */
export function tipLever(b: Vec3): Vec3 {
  const lx = LB * b[0],
    ly = LA + LB * Math.max(0, b[1]),
    lz = LB * b[2];
  const ll = Math.hypot(lx, ly, lz) || 1;
  return [lx / ll, ly / ll, lz / ll];
}

/** which way a swing that truly travels at angle a across the view (0 right, π/2 up) reads: see DIR_ROLL */
export function swingRead(a: number): number {
  return Math.atan2(DIR_DIP * Math.sin(a + DIR_ROLL), Math.cos(a + DIR_ROLL));
}
const DIR_WINDOW = 200; // ms before the peak the direction is read over
const RISE = 0.25; // s: a stroke that takes longer than this from half speed to its peak (a twirl, a slow
// turn) needs a faster peak (by the square of how much longer)
// windups: a stroke that may be the windup of a blow — one going up (raising the sword), back
// towards the player, or just not hard — waits to see whether a harder one comes back the other way
const UP_K = 1.3; // a stroke going up has to be this much harder to be a rising cut
const STRONG = 1.8; // a stroke this much harder than it needs to be is a blow, whatever follows: no wait
const HOLD = 500; // ms after its peak is past it waits at most for the next stroke to begin…
const REST = 1.2; // …or until the phone has been below this speed (rad/s)…
const QUIET = 300; // …for this long (ms): nothing's coming
// (a stroke that comes straight after the sword was drawn back the other way — its windup, however
// slow — is the blow: no wait)
const WOUND_MS = 700; // ms before the stroke began that a windup is looked for: motion the other way…
const WOUND = 0.2; // …at least this fast, as a share of the blow's peak (and START)…
const WOUND_K = 2; // …but the blow at least this much faster than it (else they're a pair of moves alike)
const UP_FIRE = 11; // a rising stroke this hard (rad/s, ≈ 630°/s) is a rising cut, sent at once: a windup (the sword raised) peaks well below (a real hand's: ≤ 8.6)
const UP_SURE = 0; // a rising stroke this hard (rad/s, ≈ 570°/s) is a rising cut; a gentler one may be the sword raised to chop…
const RAISE_WAIT = 900; // …and waits this long (ms after its peak) for the chop
const WINDUP_MAX = 700; // ms after its peak it waits at most (while a stroke is under way)
const UNWIND = 1.1; // the blow after a windup is at least this much harder than it (a rising windup: 0.6)
// after an attack
const GAP = 170; // ms: no two blows peak closer than this
const RETURN_COS = 0; // a stroke this far round from the blow's (over 90°) is going back
const REVERSE = 0.5; // …or once the tip goes back the other way (cos < −this)
const SETTLE = 0.45; // the motion has settled once below this much of the last peak (and START)
const RETURN_MS = 1000; // for this long, a stroke back the other way…
const RETURN_K = 0.75; // …has to be this hard, as a share of the blow's peak…
const RETURN_FADE = 600; // …which then fades back to the usual over this long
const NEAR_QUIET = 700; // ms after a blow: no "swing harder" (that's the return)
const NEAR_WAIT = 450; // ms a near miss waits for a blow (then it was the windup) before it's said
const GUARD_GRACE = 60; // ms: a stroke that peaks this soon after letting go of the guard was the guard moving
// thrusts (m/s of the hand, from the accelerometer)
const TAU = 0.5; // s: leak of the integrated velocity (the accelerometer's bias would run away)
const PUSH_START = 0.3; // a push begins
// (the leak reads a push at ~85% of its true speed: these are as read)
const V_MIN = 0.85; // the least a thrust may reach (≈ 1 m/s; ÷ sensitivity)
const V_GENTLE = 1.0; // power 0.25
const V_FULL = 2.4; // power 1 (÷ √sensitivity)
const ROT_MAX = 8; // rad/s: a push that begins with the phone turning faster than this is a swing's follow-through…
const PUSH_ROT = 3.2; // …and one with the phone turning faster than this is a swing moving the hand…
const PUSH_ROT_K = 7; // …though a hard push (over V_ROT, m/s) may turn more (rad/s more, for each m/s)
const V_ROT = 1.4;
// (a real thrust isn't a clean push: the wrist tips 200–400°/s as the arm goes out, and jolts as it stops)
const PUSH_FWD = 0.6; // the push is within ~53° of the screen…
const BLADE_FWD = -0.2; // …with the blade not pointing back at the player
const THRUST_GAP = 800; // ms between thrusts (the arm has to come back first: its stop reads as a push)
const AFTER_SLASH = 300; // ms: no thrust peaks this soon after a slash (the arm is still moving)
/** after a thrust, a slash within RETURN_MS has to be this hard (the pull back isn't one) */
const THRUST_AS = 14;

/** a slash's power from its peak tip speed: a gentle flick ≈ 0.25, a full swing 1 */
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

/** a stroke judged to be a blow */
interface Candidate {
  peak: number;
  tPeak: number;
  dir: number;
  sweep: number;
  up: boolean;
  /** when it was judged, and since when the phone has been at rest (ms, −1: it isn't) */
  at: number;
  quiet: number;
}

export class SwordDetector {
  /** 0.75 = needs big swings … 1.35 = light swings count (the remote's setting) */
  sensitivity = 1;
  /** calibrated heading of "towards the screen" in the earth frame (Orientation.heading) */
  heading: number | null = null;
  /** sign relating accelerationIncludingGravity to true up when acceleration isn't reported (iOS: −1) */
  upSign = 1;
  onStrike: (s: SwordStrike) => void = () => {};
  /** a stroke that looked meant but was too gentle */
  onNear: (n: SwordNearMiss) => void = () => {};
  /** a swing (or push) made while holding the guard: it only angled the guard */
  onGuarded: (s: SwordStrike) => void = () => {};
  /** every stroke judged (tuning) */
  onJudge: ((j: SwordJudged) => void) | null = null;
  /** live tip speed, rad/s (for the meter) */
  live = 0;

  private lastT = 0;
  // history: time, dt, tip speed, the tip's velocity (x across, y towards the screen, z up)
  private T = new Float64Array(N);
  private DT = new Float64Array(N);
  private S = new Float64Array(N);
  private VX = new Float64Array(N);
  private VY = new Float64Array(N);
  private VZ = new Float64Array(N);
  private head = 0;
  private count = 0;

  // the stroke in progress
  private inStroke = false;
  private t0 = 0;
  private peak = 0;
  private tPeak = 0;
  private sweep = 0;
  /** the stroke's way across the view so far (Σ v·S·dt) */
  private sx = 0;
  private sz = 0;

  // a stroke that may have been a windup, waiting for its blow
  private pending: Candidate | null = null;
  // the last attack
  private settled = true;
  private settleP = 0;
  private lastAt = -1e9;
  private lastP = 0;
  private lastDir = 0;
  private lastThrust = false;
  private lastSlashAt = -1e9;
  private lastThrustAt = -1e9;
  private lastNearAt = -1e9;
  /** a near miss, said only if no blow follows it soon (it may have been a windup) */
  private near: SwordNearMiss | null = null;
  // the guard
  private guarding = false;
  private guardUpAt = -1e9;
  // the push in progress
  private vel: Vec3 = [0, 0, 0];
  private pushing = false;
  private vmax = 0;
  private tvmax = 0;
  private turned = false;
  /** the fastest the phone turned so far in this push (rad/s) */
  private pushW = 0;
  private lastTurnAt = -1e9;
  private pushSettled = true;
  /** how fast the hand was lately moving back, away from the screen (m/s, fading), and as a push began */
  private backV = 0;
  private pushBias = 0;
  private gSign = 0;
  private igUp = 0;

  /** Forget the motion so far (e.g. the duel starts). */
  reset() {
    this.inStroke = false;
    this.pending = null;
    this.settled = true;
    this.lastAt = this.lastSlashAt = this.lastThrustAt = this.lastNearAt = -1e9;
    this.pushing = false;
    this.pushSettled = true;
    this.vel = [0, 0, 0];
    // and the history: the detector is not fed outside the duel, so what is in its ring is old
    // motion (and a near miss waiting to be told would be told now, late)
    this.count = 0;
    this.lastT = 0;
    this.live = 0;
    this.near = null;
    this.backV = 0;
    this.lastTurnAt = -1e9;
  }

  /** The guard pad went down / up at time t (ms). While it's held, swings only angle the guard. */
  guard(down: boolean, t = this.lastT) {
    this.guarding = down;
    if (down) this.pending = null;
    else this.guardUpAt = t;
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
    // the imaginary sword's tip, from the elbow (unit length)
    const [r0, r1, r2] = tipLever(b);
    // its velocity per metre (ω × r) and speed
    const vx = w[1] * r2 - w[2] * r1,
      vy = w[2] * r0 - w[0] * r2,
      vz = w[0] * r1 - w[1] * r0;
    const sp = Math.hypot(vx, vy, vz);
    const h = this.head;
    this.T[h] = s.t;
    this.DT[h] = dt;
    this.S[h] = sp;
    this.VX[h] = vx;
    this.VY[h] = vy;
    this.VZ[h] = vz;
    this.head = (h + 1) % N;
    this.count = Math.min(N, this.count + 1);
    this.live = 0.6 * sp + 0.4 * this.live;
    // (a push with the phone turning isn't a thrust: the hand moves because the arm swings)
    if (Math.max(sp, 0.8 * Math.hypot(w[0], w[1], w[2])) > ROT_MAX) this.lastTurnAt = s.t;
    this.slash(s.t, dt, sp);
    this.thrust(s, dt, b);
  }

  private slash(t: number, dt: number, sp: number) {
    const start = START / this.sensitivity;
    const nm = this.near;
    if (nm && t - nm.t > NEAR_WAIT && !this.inStroke) {
      this.near = null;
      this.onNear(nm);
    }
    const p = this.pending;
    if (p) {
      // a possible windup: no blow followed (the phone came to rest, or nothing came in time), or the
      // next stroke isn't coming back the other way — it was a blow after all
      // (raising the sword, not so hard: people hold it up there a moment before the chop — it
      // waits longer, however still the phone is)
      const raise = p.up && p.peak < UP_SURE / this.sensitivity;
      let go = t - p.tPeak > (raise ? RAISE_WAIT : WINDUP_MAX);
      if (!this.inStroke) {
        if (sp < REST) {
          if (p.quiet < 0) p.quiet = t;
        } else p.quiet = -1;
        if (!raise && ((p.quiet >= 0 && t - p.quiet >= QUIET) || t - p.at >= HOLD)) go = true;
      } else if (!raise && t - this.t0 >= 30 && (this.sx || this.sz) && Math.cos(Math.atan2(this.sz, this.sx) - p.dir) > -0.2) go = true;
      if (go) {
        this.pending = null;
        this.emit(p);
      }
    }
    if (!this.settled) {
      // still the last blow (its follow-through, or a push's wobble) — or, after a possible windup,
      // still that (the next stroke is the one that comes back the other way)
      // — until it calms down, or turns back the other way (a windup that flows straight into
      // its blow without stopping at the top, a blow into its return)
      const j = this.idx(0);
      const ref = this.pending ? this.pending.dir : this.lastDir;
      const back = this.VX[j] * Math.cos(ref) + this.VZ[j] * Math.sin(ref) < -REVERSE * sp;
      if (sp < (this.pending ? start : Math.max(start, SETTLE * this.settleP)) || back) this.settled = true;
      else return;
    }
    if (!this.inStroke) {
      if (sp <= start) return;
      this.inStroke = true;
      this.t0 = t;
      this.peak = 0;
      this.sweep = 0;
      this.sx = this.sz = 0;
    }
    this.sweep += sp * dt;
    const j = this.idx(0);
    this.sx += this.VX[j] * sp * dt;
    this.sz += this.VZ[j] * sp * dt;
    if (sp > this.peak) {
      this.peak = sp;
      this.tPeak = t;
    } else if (sp < CONFIRM * this.peak || t - this.tPeak >= CONFIRM_MS) {
      this.inStroke = false;
      this.decide(t);
      return;
    }
    if (t - this.t0 > MAX_STROKE) {
      // a steady spin, not a blow: let it calm down first
      this.inStroke = false;
      this.settled = false;
      this.settleP = this.peak;
    }
  }

  /** The stroke's peak is past (at time t): a blow? */
  private decide(t: number) {
    const k = this.sensitivity;
    const { peak, tPeak, sweep } = this;
    // which way the tip went across the view: the fast part up to the peak (and the moment since)
    const from = Math.max(this.t0, tPeak - DIR_WINDOW) - 1;
    let dx = 0,
      dz = 0,
      across = 0,
      all = 0;
    for (let i = 0; i < this.count; i++) {
      const j = this.idx(i);
      if (this.T[j] < from) break;
      const s = this.S[j];
      const w = s * s * this.DT[j];
      dx += this.VX[j] * w;
      dz += this.VZ[j] * w;
      across += Math.hypot(this.VX[j], this.VZ[j]) * w;
      all += s * w;
    }
    const d = Math.hypot(dx, dz);
    // (read in the swing's own plane: see DIR_ROLL, DIR_DIP)
    const rx = dx * COS_ROLL - dz * SIN_ROLL,
      rz = dx * SIN_ROLL + dz * COS_ROLL;
    const dir = Math.atan2(rz * DIR_DIP, rx);
    // the motion just before the stroke began, the other way: its windup (how fast)
    let wound = 0;
    const cx = Math.cos(dir),
      cz = Math.sin(dir);
    for (let i = 0; i < this.count; i++) {
      const j = this.idx(i);
      if (this.T[j] >= this.t0) continue;
      if (this.T[j] < this.t0 - WOUND_MS) break;
      const s = this.S[j];
      if (s > wound && this.VX[j] * cx + this.VZ[j] * cz < -0.3 * s) wound = s;
    }
    const wasWound = wound >= Math.max(START / k, WOUND * peak) && peak >= WOUND_K * wound;
    const J: SwordJudged | null = this.onJudge
      ? { t: tPeak, peak, dir, sweep, across: all > 0 ? across / all : 0, coherent: across > 0 ? d / across : 0, need: 0, base: 0, wound, verdict: 'shapeless' }
      : null;
    const judged = (v: SwordJudged['verdict'], need = 0, base = 0) => {
      if (!J) return;
      J.verdict = v;
      J.need = need;
      J.base = base;
      this.onJudge!(J);
    };
    // a knock, a push at the screen with a turn in it, or a scribble (a short flick can still be a near miss)
    if (sweep < NEAR_SWEEP || all <= 0 || across < ACROSS * all || d < COHERENT * across) return judged('shapeless');
    const thin = sweep < MIN_SWEEP;
    const up = Math.sin(dir) > 0.35;
    const c: Candidate = { peak, tPeak, dir, sweep, up, at: t, quiet: -1 };

    // a stroke after one that may have been its windup: harder, and back the other way → it was
    // (forget it); else that was a blow, and this is judged after it
    const p = this.pending;
    if (p) {
      this.pending = null;
      if (!(Math.cos(dir - p.dir) < -0.2 && peak >= Math.max(MIN_PEAK / k, (p.up ? 0.6 : UNWIND) * p.peak) && !this.guarding)) this.emit(p);
      else if (this.onJudge) this.onJudge({ t: p.tPeak, peak: p.peak, dir: p.dir, sweep: p.sweep, across: 0, coherent: 0, need: 0, base: 0, wound: 0, verdict: 'windup' });
    }

    const since = tPeak - this.lastAt;
    if (since < GAP) return judged('too soon');
    // a slow build-up (a twirl, a controlled turn) needs more; so does going up (it may be a windup)
    const base = (MIN_PEAK / k) * Math.max(1, (this.rise() / RISE) ** 2) * (up ? UP_K : 1);
    let need = base;
    // soon after a blow, a stroke back the other way is the return, unless it's nearly as hard (after a thrust, any stroke)
    if (since < RETURN_MS + RETURN_FADE && (this.lastThrust || Math.cos(dir - this.lastDir) < RETURN_COS)) {
      const f = since < RETURN_MS ? 1 : 1 - (since - RETURN_MS) / RETURN_FADE;
      need = Math.max(base, base + (RETURN_K * this.lastP - base) * f);
    }
    if (peak < need || thin) {
      // (a return that was held back isn't a near miss)
      const returning = since < RETURN_MS + RETURN_FADE && need > base;
      // (and only a snappy one: a quick move into position isn't a swing that fell short)
      if ((peak < base || thin) && peak >= NEAR / k && !returning && since > NEAR_QUIET && tPeak - this.lastNearAt > 600 && !this.guarding && this.rise() <= NEAR_RISE) {
        this.lastNearAt = tPeak;
        this.near = { t: tPeak, peak, need: base, dir };
        return judged('near', need, base);
      }
      return judged('weak', need, base);
    }
    // no attacks with the guard up, nor a swing that was the guard still moving as it was let go
    // (it began while the guard was held, or peaked just after)
    if (this.guarding || tPeak < this.guardUpAt + GUARD_GRACE || this.t0 < this.guardUpAt - 50) {
      if (this.guarding) this.onGuarded({ kind: 'slash', dir, power: slashPower(peak, k), t: tPeak, peak, sweep });
      // (its return isn't an attack either)
      this.lastAt = tPeak;
      this.lastP = peak;
      this.lastDir = dir;
      this.lastThrust = false;
      this.settled = false;
      this.settleP = peak;
      return judged('guard', need, base);
    }
    // going up (raising the sword), or not so hard: maybe the windup of a blow —
    // unless the sword had just been drawn back the other way (then this is the blow)
    if (!wasWound && (up ? peak < UP_FIRE / k : peak < STRONG * base)) {
      this.pending = c;
      // the motion comes back down through the turnaround before the blow
      this.settled = false;
      this.settleP = peak;
      return judged('held', need, base);
    }
    judged('blow', need, base);
    this.emit(c);
  }

  /** how long the stroke just judged took from half its peak speed to the peak, s */
  private rise() {
    const half = 0.5 * this.peak;
    for (let i = 0; i < this.count; i++) {
      const j = this.idx(i);
      if (this.T[j] > this.tPeak) continue;
      if (this.S[j] < half) return (this.tPeak - this.T[j]) / 1000;
    }
    return (this.tPeak - this.t0) / 1000;
  }

  private emit(c: Candidate) {
    this.near = null;
    this.lastAt = this.lastSlashAt = c.tPeak;
    this.lastP = c.peak;
    this.lastDir = c.dir;
    this.lastThrust = false;
    this.settled = false;
    this.settleP = c.peak;
    this.onStrike({ kind: 'slash', dir: c.dir, power: slashPower(c.peak, this.sensitivity), t: c.tPeak, peak: c.peak, sweep: c.sweep });
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

  private thrust(s: SwordSample, dt: number, b: Vec3) {
    const a = this.accel(s, s.q!);
    if (!a) return;
    const ap = this.toPlayer(qrot(s.q!, a));
    const keep = Math.exp(-dt / TAU);
    const vel = this.vel;
    for (let i = 0; i < 3; i++) vel[i] = vel[i] * keep + ap[i] * dt;
    const sp = Math.hypot(vel[0], vel[1], vel[2]);
    const k = this.sensitivity;
    // the arm coming back and stopping reads (leaky as the integral is) as a push forward: a push
    // straight after moving back has to beat that
    this.backV = Math.max(Math.max(0, -vel[1]), this.backV * Math.exp(-dt / 0.3));
    // towards the screen, the blade not pointing back at the player
    const ahead = sp > 1e-6 && vel[1] >= PUSH_FWD * sp && b[1] >= BLADE_FWD;
    if (!this.pushing) {
      if (!this.pushSettled) {
        if (sp < 0.3) this.pushSettled = true;
        else return;
      }
      if (sp > PUSH_START && ahead) {
        this.pushing = true;
        this.pushBias = this.backV;
        this.vmax = sp;
        this.tvmax = s.t;
        // (a blade that was turning just before is a swing's follow-through)
        this.turned = s.t - this.lastTurnAt < 120;
        this.pushW = 0;
      }
      return;
    }
    this.pushW = Math.max(this.pushW, Math.hypot(s.rx, s.ry, s.rz));
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
    if (this.vmax < V_MIN / k + this.pushBias || this.turned || this.pushW > PUSH_ROT + PUSH_ROT_K * Math.max(0, this.vmax - V_ROT)) return;
    if (this.guarding || t < this.guardUpAt + GUARD_GRACE) {
      if (this.guarding) this.onGuarded({ kind: 'thrust', dir: 0, power: thrustPower(this.vmax, k), t, peak: this.vmax, sweep: 0 });
      return;
    }
    if (t - this.lastSlashAt < AFTER_SLASH || t - this.lastThrustAt < THRUST_GAP) return;
    this.pushSettled = false;
    this.pending = null;
    this.near = null;
    this.lastAt = this.lastThrustAt = t;
    this.lastP = THRUST_AS;
    this.lastThrust = true;
    // (the arm stopping jolts the phone: a stroke that isn't a blow, until it calms down)
    this.settled = false;
    this.settleP = THRUST_AS;
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
