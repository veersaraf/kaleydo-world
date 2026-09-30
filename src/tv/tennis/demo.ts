// The first-time demo: a few seconds that make the game feel simple.
//
//   "Your player runs by itself — you just swing when the ball gets to you; to serve, lift then swing."
//
// The player's OWN character performs it, on court, where they stand: a "coach" copy of the player (a
// TPlayer of its own, with an Animator of its own) is driven by a script — positions, a toss, a swing
// state, a scripted ball — and its pose is what the app draws in place of the real one meanwhile. The
// Match knows nothing of this (it sits in 'serve' with the real ball held, and the app holds its clock);
// nothing here touches it, so the sim is what it always was.
//
// Two scripts (each ≤ 7 s, captions in real time, the motion in a "motion clock" that runs slower through
// the toss and the ball's flight so the beat is easy to see):
//
//   serve   Your player moves by itself. → Lift the phone to toss… → …and swing at the top! → Your turn.
//   rally   Your player runs to the ball by itself. → Just swing when it reaches you. (a ring closes on
//           the ball; the character swings on the beat) → Early or late still counts → Ready? Here it comes.

import { TPlayer, type HitPlan, type SwingState } from './player';
import { Animator } from '../chars/anim';
import { COURT } from './court';
import { segPos, segVel, type Seg } from './ball';
import type { Pose } from '../chars/pose';
import { clamp, lerp, smooth, type V3 } from '../core/math';

export type DemoKind = 'serve' | 'rally';

/** a caption step: what the TV shows and what the phone's glyph acts out (`id` is the PadMsg step) */
export interface DemoStep {
  id: string;
  text: string;
  /** a small line under the caption */
  sub?: string;
  /** the phone's one-line hint under its heading */
  hint: string;
}

export interface DemoHooks {
  step(s: DemoStep): void;
  /** a beat the phones can feel and the TV can hear (`pan` = -1…1 where it happened) */
  beat(kind: 'toss' | 'hit' | 'bounce', pan: number): void;
  end(skipped: boolean, completed: boolean): void;
}

const g = COURT.gravity;
/** toss → the top of the toss (the game's own TOSS_IDEAL) */
const TOSS_TOP = 0.78;
/** how long each script runs (s, real) */
const LENGTH: Record<DemoKind, number> = { serve: 7.0, rally: 7.0 };

/** the steps: [real time they start, id, text, key text, hint] */
const STEPS: Record<DemoKind, [number, string, string, string, string][]> = {
  serve: [
    [0, 's1', 'Your player moves by itself.', 'Your player moves by itself.', 'you don’t steer'],
    [1.9, 's2', 'Lift the phone to toss…', 'Press SPACE to toss…', 'lift it up'],
    [3.3, 's3', '…and swing at the top!', '…and SPACE again at the top!', 'swing!'],
    [5.2, 's4', 'Your turn — lift, then swing.', 'Your turn — SPACE, then SPACE.', 'your turn'],
  ],
  rally: [
    [0, 'r1', 'Your player runs to the ball by itself.', 'Your player runs to the ball by itself.', 'you don’t steer'],
    [1.9, 'r2', 'Just swing when it reaches you.', 'Just press SPACE when it reaches you.', 'swing as the ring closes'],
    [4.1, 'r3', 'Early or late still counts — just swing!', 'Early or late still counts — just press SPACE!', 'any swing counts'],
    [5.8, 'r4', 'Ready? Here it comes.', 'Ready? Here it comes.', 'here it comes'],
  ],
};

const P = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

/** a ballistic leg from `a` to `b` taking `T` s (no drag, no spin) */
function leg(t0: number, a: V3, b: V3, T: number): Seg {
  return { t0, px: a.x, py: a.y, pz: a.z, vx: (b.x - a.x) / T, vy: (b.y - a.y + 0.5 * g * T * T) / T, vz: (b.z - a.z) / T, g, k: 0, spin: 0, g0: g };
}

export class TennisDemo {
  /** real seconds since it began */
  t = 0;
  /** the motion clock (s): runs slower than t through the toss and the flights */
  tm = 0;
  done = false;
  skipped = false;
  /** ran to its end (not skipped, not cut short) */
  completed = false;
  readonly coach: TPlayer;
  private anim: Animator;
  readonly pose: Pose;
  /** the scripted ball */
  readonly ball: V3 = P();
  ballVisible = false;
  ballSpeed = 0;
  /** seconds (motion clock) to the contact the ring closes on; null = no ring */
  ringTl: number | null = null;
  /** the TV's camera leans in on this spot */
  readonly focus: { x: number; z: number };

  private segs: Seg[] = [];
  private stepIdx = -1;
  private readonly x0: number;
  private readonly z0: number;
  private readonly length: number;
  private readonly sgn: number;
  private swing: SwingState | null = null;
  private plan: HitPlan | null = null;
  private fired = new Set<string>();
  // the rally script's places
  private stand = P();
  private contact = P();
  private tc = 0;
  // the serve script's times
  private tossAt = 3.2;
  private v = P();
  private tmp = P();

  constructor(
    private real: TPlayer,
    /** the real player's index in match.players */
    readonly index: number,
    readonly kind: DemoKind,
    private keys: boolean,
    private hooks: DemoHooks,
  ) {
    const c = (this.coach = new TPlayer(real.id, real.team, real.ctrl, real.name, real.look, real.handed));
    c.x = c.tx = real.x;
    c.z = c.tz = real.z;
    c.yaw = real.yaw;
    c.role = real.role;
    this.x0 = real.x;
    this.z0 = real.z;
    this.sgn = real.z < 0 ? -1 : 1;
    this.length = LENGTH[kind];
    this.focus = { x: real.x, z: real.z };
    this.anim = new Animator(c);
    this.pose = this.anim.pose;
    if (kind === 'serve') {
      c.holding = true;
      c.tossT = -1;
    } else this.planRally();
    this.hooks.step(this.stepAt(0));
    this.stepIdx = 0;
  }

  private stepAt(i: number): DemoStep {
    const s = STEPS[this.kind][i];
    return { id: s[1], text: this.keys ? s[3] : s[2], hint: s[4] };
  }

  skip() {
    if (this.done) return;
    this.done = true;
    this.skipped = true;
    this.hooks.end(true, false);
  }

  // ---------------------------------------------------------------- the clock

  /** motion-clock speed at motion time tm */
  private warp(): number {
    const tm = this.tm;
    if (this.kind === 'serve') {
      // slow through the toss and the swing, a little slower through the ball's flight
      if (tm < this.tossAt - 0.1) return 1;
      if (tm < this.tossAt + TOSS_TOP + 0.15) return 0.5;
      return tm < this.tossAt + TOSS_TOP + 1.0 ? 0.7 : 1;
    }
    return tm < this.tc + 0.6 ? 0.7 : 1;
  }

  update(dt: number) {
    if (this.done) return;
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const w = this.warp();
    const dtm = dt * w;
    this.tm += dtm;
    // captions, in real time
    const steps = STEPS[this.kind];
    while (this.stepIdx + 1 < steps.length && this.t >= steps[this.stepIdx + 1][0]) {
      this.stepIdx++;
      this.hooks.step(this.stepAt(this.stepIdx));
    }
    if (this.kind === 'serve') this.serveFrame(dtm);
    else this.rallyFrame(dtm);
    // the camera leans in on wherever the coach is
    this.focus.x = this.coach.x;
    this.focus.z = this.coach.z;
    // the ghost phone: in over the first moments, out over the last
    this.pose.ghost = clamp(Math.min(this.t / 0.35, (this.length - this.t) / 0.3));
    if (this.t >= this.length) {
      this.done = true;
      this.completed = true;
      this.hooks.end(false, true);
    }
  }

  private once(key: string, fn: () => void) {
    if (this.fired.has(key)) return;
    this.fired.add(key);
    fn();
  }

  private placeBall(tm: number) {
    // the last leg begun by now
    let s: Seg | null = null;
    for (let i = this.segs.length - 1; i >= 0; i--) {
      if (this.segs[i].t0 <= tm) {
        s = this.segs[i];
        break;
      }
    }
    if (!s) return;
    segPos(s, tm, this.ball);
    segVel(s, tm, this.v);
    this.ballSpeed = Math.hypot(this.v.x, this.v.y, this.v.z);
  }

  /** the ball's bounces after a flight: a few, each a little lower */
  private bounces(t0: number, from: V3, to: V3, T: number, n = 2) {
    let s = leg(t0, from, to, T);
    this.segs.push(s);
    let tb = t0 + T;
    let vy = -(s.vy - g * T) * 0.72;
    let vx = s.vx * 0.85;
    let vz = s.vz * 0.85;
    let p = P(to.x, to.y, to.z);
    for (let i = 0; i < n; i++) {
      s = { t0: tb, px: p.x, py: COURT.ballR, pz: p.z, vx, vy, vz, g, k: 0, spin: 0, g0: g };
      this.segs.push(s);
      const tf = (2 * vy) / g;
      tb += tf;
      p = P(p.x + vx * tf, COURT.ballR, p.z + vz * tf);
      vy *= 0.66;
      vx *= 0.85;
      vz *= 0.85;
    }
  }

  // ---------------------------------------------------------------- the serve demo

  private serveFrame(dtm: number) {
    const c = this.coach;
    const tm = this.tm;
    const f = c.fhSign;
    const fwd = c.fwd;
    // 1. the player moves by itself: two sidesteps along the baseline
    const a = smooth(clamp((tm - 0.15) / 0.55));
    const b = smooth(clamp((tm - 0.85) / 0.6));
    const dx = 1.15 * f * (a - b) * 1;
    const nx = this.x0 + dx;
    const vx = (nx - c.x) / Math.max(dtm, 1e-4);
    c.vx = vx;
    c.vz = 0;
    c.x = nx;
    c.z = this.z0;
    // 2. the toss, and the swing at the top of it
    if (tm >= this.tossAt) {
      this.once('toss', () => {
        c.holding = false;
        c.tossT = this.tossAt;
        // the ball leaves the off hand and goes up (the game's own toss, from wherever the hand is)
        const h = this.offHand();
        const s: Seg = { t0: this.tossAt, px: h.x, py: h.y, pz: h.z, vx: (f * 0.45) / TOSS_TOP, vy: 6.0, vz: (fwd * 0.25) / TOSS_TOP, g, k: 0, spin: 0, g0: g };
        this.segs.push(s);
        const tc = this.tossAt + TOSS_TOP;
        const top = segPos(s, tc, P());
        const sw: SwingState = { stroke: 'serve', t0: tc - 0.34, tc, te: tc + 0.45, cx: top.x, cy: top.y, cz: top.z, hit: true, resolved: true, input: { power: 0.85, spin: 0.3, tau: 0 }, serve: true };
        this.swing = sw;
        // where the serve goes: over the net, into the service box across from the server
        const toX = -Math.sign(c.x || f) * 2.2;
        const target = P(toX, COURT.ballR, -this.sgn * 4.6);
        const T = 0.68;
        this.bounces(tc, top, target, T, 2);
        this.hooks.beat('toss', 0);
      });
    }
    if (this.swing) {
      const sw = this.swing;
      c.swing = tm >= sw.t0 && tm < sw.te + 0.05 ? sw : null;
      if (tm >= sw.tc) this.once('hit', () => this.hooks.beat('hit', clamp(c.x / 8, -1, 1)));
      if (tm >= sw.tc + 0.68) this.once('bounce', () => this.hooks.beat('bounce', clamp(this.ball.x / 8, -1, 1)));
      // the swing is over: back to holding the ball, ready for the real one
      if (tm >= sw.te + 0.05 && c.tossT >= 0) {
        c.tossT = -1;
        c.holding = true;
      }
    }
    // the ball: in the off hand until it is tossed; gone a moment after it has bounced in the box
    const tossed = tm >= this.tossAt;
    if (!tossed) {
      this.offHand();
      this.ball.x = this.tmp.x;
      this.ball.y = this.tmp.y;
      this.ball.z = this.tmp.z;
      this.ballVisible = this.t > 0.25;
      this.ballSpeed = 0;
    } else {
      this.placeBall(tm);
      this.ballVisible = tm < this.tossAt + TOSS_TOP + 1.45;
    }
    this.ringTl = null;
    this.anim.update(tm, dtm, this.ball, tossed && tm < this.tossAt + TOSS_TOP + 0.6 ? 'toss' : 'serve');
  }

  /** the off hand in the world (into tmp): where the ball sits before the toss */
  private offHand(): V3 {
    const P = this.pose;
    const c = this.coach;
    const s = this.anim.scale;
    const cs = Math.cos(c.yaw),
      sn = Math.sin(c.yaw);
    const h = P.hands[1];
    this.tmp.x = c.x + (cs * h.x + sn * h.z) * s;
    this.tmp.y = (h.y + 0.04) * s;
    this.tmp.z = c.z + (-sn * h.x + cs * h.z) * s;
    return this.tmp;
  }

  // ---------------------------------------------------------------- the rally demo

  private planRally() {
    const c = this.coach;
    const f = c.fhSign;
    const s = this.sgn;
    // the ball comes from the far baseline, bounces in front of the player and rises to their forehand side
    const from = P(this.x0 - f * 1.4, 1.3, -s * (COURT.halfL + 0.5));
    const contact = P(this.x0 + f * 2.6, 0.95, this.z0 - s * 1.0);
    this.contact = contact;
    this.stand = P(contact.x - f * 0.62, 0, contact.z + s * 0.12);
    const bounce = P(contact.x - f * 0.55, COURT.ballR, contact.z - s * 2.7);
    const launch = 0.35;
    const T1 = 1.35;
    const T2 = 0.68;
    this.tc = launch + T1 + T2;
    this.segs.push(leg(launch, from, bounce, T1));
    // bounce → contact
    this.segs.push(leg(launch + T1, bounce, contact, T2));
    // the return: over the net, deep into the far court
    const back = P(this.x0 - f * 1.3, COURT.ballR, -s * 8.4);
    this.bounces(this.tc, contact, back, 1.15, 2);
    const hp: HitPlan = { t: this.tc, bx: contact.x, by: contact.y, bz: contact.z, stroke: 'fh', volley: false, sx: this.stand.x, sz: this.stand.z, reachable: true, cost: 0, speed: 12 };
    this.plan = hp;
    this.swing = { stroke: 'fh', t0: this.tc - 0.42, tc: this.tc, te: this.tc + 0.5, cx: contact.x, cy: contact.y, cz: contact.z, hit: true, resolved: true, input: { power: 0.8, spin: 0.3, tau: 0 }, serve: false };
  }

  private rallyFrame(dtm: number) {
    const c = this.coach;
    const tm = this.tm;
    // out to the ball, and back again
    const out = smooth(clamp((tm - 0.45) / 1.3));
    const back = smooth(clamp((tm - (this.tc + 0.55)) / 1.2));
    const k = out * (1 - back);
    const nx = lerp(this.x0, this.stand.x, k);
    const nz = lerp(this.z0, this.stand.z, k);
    c.vx = (nx - c.x) / Math.max(dtm, 1e-4);
    c.vz = (nz - c.z) / Math.max(dtm, 1e-4);
    c.x = nx;
    c.z = nz;
    // (the game's own yaw: turning a little towards the ball)
    c.focus = tm > 0.3 ? Math.min(1, c.focus + dtm * 3) : 0;
    c.plan = tm < this.tc + 0.05 ? this.plan : null;
    const sw = this.swing!;
    c.swing = tm >= sw.t0 && tm < sw.te + 0.05 ? sw : null;
    if (tm >= sw.tc) this.once('hit', () => this.hooks.beat('hit', clamp(c.x / 8, -1, 1)));
    const tb1 = 0.35 + 1.35;
    if (tm >= tb1) this.once('b1', () => this.hooks.beat('bounce', clamp(this.contact.x / 8, -1, 1)));
    if (tm >= sw.tc + 1.15) this.once('b2', () => this.hooks.beat('bounce', clamp(this.ball.x / 8, -1, 1)));
    this.ballVisible = tm >= 0.35 && tm < sw.tc + 2.0;
    if (this.ballVisible) this.placeBall(tm);
    this.ringTl = tm >= 0.35 && tm <= sw.tc + 0.1 ? sw.tc - tm : null;
    this.anim.update(tm, dtm, this.ball, 'play');
  }
}
