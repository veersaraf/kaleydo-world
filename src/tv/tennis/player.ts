// A tennis player on court: position, movement, intercept planning and swing
// state. Both humans and CPUs move automatically (Wii-style); humans only
// decide *when* and *how* to swing.

import { COURT, fwdOf } from './court';
import type { PathBuf, PathSample } from './ball';
import type { Stroke, SwingInput } from './shot';
import type { Look } from '../chars/look';
import type { AIProfile } from './ai';
import { clamp } from '../core/math';
import { hyp2 } from './hypot';

export type Ctrl = { kind: 'cpu'; ai: AIProfile } | { kind: 'human'; slot: number; ai: AIProfile };

export interface HitPlan {
  t: number;
  bx: number;
  by: number;
  bz: number;
  stroke: Stroke;
  volley: boolean;
  /** where the body should stand to meet the ball */
  sx: number;
  sz: number;
  reachable: boolean;
  cost: number;
  /** horizontal ball speed at contact, m/s */
  speed: number;
}

export interface SwingState {
  stroke: Stroke;
  /** time the swing (forward motion) began */
  t0: number;
  /** racket-ball contact time (or the would-be contact for whiffs) */
  tc: number;
  /** swing finished */
  te: number;
  /** contact point in world space */
  cx: number;
  cy: number;
  cz: number;
  hit: boolean;
  resolved: boolean;
  input: SwingInput;
  /** ball position when the swing began (for the magnet warp) */
  serve: boolean;
  /** a person's swing heard after it was made: contact `age` in the past, wind-up already behind it (no racket magnet to stream) */
  instant?: boolean;
  /**
   * A stroke started on a phone's swing ONSET, before the swing itself is heard: it only animates (no magnet, no
   * ball, no event; `hit` stays false, `nextSwingOK` is untouched). The heard swing replaces it; with none by
   * `tc + 0.25` it becomes a feint.
   */
  provisional?: boolean;
  /** a provisional stroke no swing followed: the arm eases from where it is back to the ready stance, from `feintT` until `te` */
  feint?: boolean;
  feintT?: number;
  /** the arm eases in from the pose of the frame before (a stroke that takes over from a provisional one, or starts from the past) */
  ease?: boolean;
}

export type AthleticMove = 'lunge' | 'dive' | 'jump';

/** A lunge, flying dive or jump for a ball the player couldn't quite run down. */
export interface Athletic {
  move: AthleticMove;
  /** launch and contact times */
  t0: number;
  tc: number;
  /** the body's travel from (x0,z0) at launch to (x1,z1) at contact */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** which side the ball is on (+1 = the character's right) */
  side: number;
  /** the landing was announced (dust, thud) */
  landed: boolean;
}

export type Emote = 'none' | 'celebrate' | 'sad' | 'wave' | 'cheer' | 'shrug';

export const REACH = {
  fhSide: 0.8,
  fhFwd: 0.42,
  bhSide: 0.72,
  bhFwd: 0.38,
  ohSide: 0.28,
  ohFwd: 0.3,
  idealH: 0.9,
};

export class TPlayer {
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  yaw = 0;
  tx = 0;
  tz = 0;
  plan: HitPlan | null = null;
  /** contact time of the last ball this player let go by (to judge swings that arrive after it) */
  missedT = -1;
  swing: SwingState | null = null;
  nextSwingOK = 0;
  emote: Emote = 'none';
  emoteT0 = 0;
  /** anticipation: time until the player starts chasing */
  reactUntil = 0;
  /** true while holding the ball before serving */
  holding = false;
  tossT = -1;
  /** 0..1, how "on edge" the character looks (focus face) */
  focus = 0;
  lastStroke: Stroke = 'fh';
  /** doubles formation role */
  role: 'back' | 'net' = 'back';
  maxSpeed = 6.2;
  /** Rush: running speed multiplier that follows the ball's pace (1 in the standard game) */
  runMul = 1;
  accel = 24;
  /** movement frozen during the follow-through */
  lockUntil = 0;
  /** a lunge / dive / jump in progress */
  athletic: Athletic | null = null;
  /** 1 fresh … 0 spent. Sprinting and diving drain it; it comes back between points. */
  stamina = 1;
  /** a "Tired!" callout was shown this point */
  tiredShown = false;
  /** the plan a "Smash!" prompt was shown for */
  smashCalled: HitPlan | null = null;
  /** this player's natural "straight" swing path per stroke (degrees), learned */
  pathNeutral: Record<'fh' | 'bh' | 'oh', number> = { fh: 0, bh: 0, oh: 0 };
  hits = 0;

  constructor(
    public id: number,
    public team: 0 | 1,
    public ctrl: Ctrl,
    public name: string,
    public look: Look,
    public handed: 1 | -1,
  ) {
    this.yaw = team === 0 ? 0 : Math.PI;
    const ai = ctrl.ai;
    this.maxSpeed = ai.speed;
  }

  get human() {
    return this.ctrl.kind === 'human';
  }

  /** 0 fine … 1 exhausted (starts below 45% stamina) */
  get tired() {
    return clamp((0.45 - this.stamina) / 0.45, 0, 1);
  }

  /** running speed factor: a tired player loses up to a quarter of their pace */
  get pace() {
    return (1 - 0.24 * this.tired) * this.runMul;
  }
  get slot() {
    return this.ctrl.kind === 'human' ? this.ctrl.slot : -1;
  }
  get fwd() {
    return fwdOf(this.team);
  }
  /** World x sign of this player's forehand side. */
  get fhSign() {
    return this.handed * (this.team === 0 ? 1 : -1);
  }

  place(x: number, z: number) {
    this.x = this.tx = x;
    this.z = this.tz = z;
    this.vx = this.vz = 0;
    this.yaw = this.team === 0 ? 0 : Math.PI;
  }

  /** Time needed to run distance d from standing (trapezoid speed profile). */
  timeToCover(d: number) {
    const v = this.maxSpeed * this.pace;
    const a = this.accel;
    const dAcc = (v * v) / a; // accelerate + brake
    if (d < dAcc) return 2 * Math.sqrt(d / a);
    return d / v + v / a;
  }

  step(dt: number) {
    const dx = this.tx - this.x;
    const dz = this.tz - this.z;
    const dist = hyp2(dx, dz);
    let dvx = 0,
      dvz = 0;
    if (dist > 0.01) {
      // arrive: speed tapers as we approach the target
      const want = Math.min(this.maxSpeed * this.pace, Math.sqrt(2 * this.accel * 0.8 * dist));
      dvx = (dx / dist) * want;
      dvz = (dz / dist) * want;
    }
    const ax = dvx - this.vx;
    const az = dvz - this.vz;
    const al = hyp2(ax, az);
    const maxDv = this.accel * dt;
    if (al > maxDv) {
      this.vx += (ax / al) * maxDv;
      this.vz += (az / al) * maxDv;
    } else {
      this.vx = dvx;
      this.vz = dvz;
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    // stay on your own side of the net
    if (this.team === 0) this.z = Math.max(0.9, this.z);
    else this.z = Math.min(-0.9, this.z);
    this.x = clamp(this.x, -COURT.doublesHalfW - 3.5, COURT.doublesHalfW + 3.5);
  }

  speed() {
    return hyp2(this.vx, this.vz);
  }

  /**
   * Choose where and when to meet the ball along a predicted path.
   * `mustBounce` for serve returns; `allowVolley` for players near the net.
   * (The candidates are weighed in two scratch plans; only the winner is copied out, so a
   * call makes one object however long the path.)
   */
  planFrom(path: PathBuf, now: number, react: number, opts: { mustBounce: boolean; doubles: boolean; prefer?: Stroke; smash?: boolean }): HitPlan | null {
    const fwd = this.fwd;
    const team0 = this.team === 0;
    const best = SCRATCH_BEST;
    const fallback = SCRATCH_FALLBACK;
    let hasBest = false;
    let hasFallback = false;
    const nearNet = Math.abs(this.z) < 6.5;
    const fs = this.fhSign;
    for (let i = 0; i < path.n; i++) {
      const s = path.s[i];
      if (s.bounces >= 2) break;
      if (!(team0 ? s.z > 0.4 : s.z < -0.4)) continue;
      if (s.t < now + 0.08) continue;
      if (opts.mustBounce && s.bounces === 0) continue;
      if (s.y < 0.22 || s.y > 3.0) continue;
      const volley = s.bounces === 0;
      const overhead = s.y > 1.95;

      // candidate stands for forehand / backhand / overhead
      const nc = overhead ? 1 : 2;
      for (let ci = 0; ci < nc; ci++) {
        let stroke: Stroke;
        let sx: number;
        let sz: number;
        if (overhead) {
          stroke = 'oh';
          sx = s.x - fs * REACH.ohSide;
          sz = s.z - fwd * REACH.ohFwd;
        } else if (ci === 0) {
          stroke = 'fh';
          sx = s.x - fs * REACH.fhSide;
          sz = s.z - fwd * REACH.fhFwd;
        } else {
          stroke = 'bh';
          sx = s.x + fs * REACH.bhSide;
          sz = s.z - fwd * REACH.bhFwd;
        }
        const d = hyp2(sx - this.x, sz - this.z);
        const avail = s.t - now - react;
        const need = this.timeToCover(d);
        const reachable = need <= avail + 0.02;
        const hIdeal = overhead ? 2.35 : REACH.idealH;
        let cost = 1.7 * Math.abs(s.y - hIdeal);
        cost += 0.45 * clamp(need / Math.max(0.05, avail), 0, 2);
        cost += opts.prefer ? (stroke === opts.prefer ? -0.8 : 0.8) : stroke === 'bh' ? 0.14 : 0;
        cost += overhead ? (opts.smash ? -1.4 : -0.15) : 0;
        // don't retreat miles behind the baseline
        cost += 0.5 * Math.max(0, Math.abs(s.z) - (COURT.halfL + 2.2));
        if (volley && !overhead) cost += nearNet ? -0.25 : 0.9;
        if (volley && overhead) cost += nearNet || opts.smash ? -0.4 : 0.3;
        // prefer taking it earlier (on the rise) rather than drifting back
        cost += 0.22 * (s.t - now);
        if (reachable) {
          if (!hasBest || cost < best.cost) {
            fill(best, path, i, s, stroke, volley, sx, sz, true, cost);
            hasBest = true;
          }
        } else if (!hasBest) {
          // (the fallback only matters while nothing reachable has turned up)
          const miss = need - avail;
          const fcost = miss * 3 + cost;
          if (!hasFallback || fcost < fallback.cost) {
            fill(fallback, path, i, s, stroke, volley, sx, sz, false, fcost);
            hasFallback = true;
          }
        }
      }
    }
    const pick = hasBest ? best : hasFallback ? fallback : null;
    return pick ? { ...pick } : null;
  }
}

const mkPlan = (): HitPlan => ({ t: 0, bx: 0, by: 0, bz: 0, stroke: 'fh', volley: false, sx: 0, sz: 0, reachable: false, cost: 0, speed: 0 });
const SCRATCH_BEST = mkPlan();
const SCRATCH_FALLBACK = mkPlan();

function fill(o: HitPlan, path: PathBuf, i: number, s: PathSample, stroke: Stroke, volley: boolean, sx: number, sz: number, reachable: boolean, cost: number) {
  o.t = s.t;
  o.bx = s.x;
  o.by = s.y;
  o.bz = s.z;
  o.stroke = stroke;
  o.volley = volley;
  o.sx = sx;
  o.sz = sz;
  o.reachable = reachable;
  o.cost = cost;
  o.speed = i > 0 ? hyp2(s.x - path.s[i - 1].x, s.z - path.s[i - 1].z) / (s.t - path.s[i - 1].t) : 15;
}
