// Archery: ends and turns, the draw and the release, each arrow's flight and
// what it meets, the scoring (rings, the X, balloon bonuses), and the archer's
// stage directions. As in Wii Sports Resort, each archer shoots all their arrows
// for an end, then the next archer; every end is a new range with a stronger
// wind, and arrows stay where they stick until the end is over. The flight is in
// physics.ts, the ranges in layouts.ts, the CPU's judgement in ai.ts; rendering
// and animation live in their own modules — this is the referee and the stage
// manager.

import { RANGE, ringOf } from './range';
import type { Archer, ArcherState, ArcheryEvent, ArrowView, RangeFx, RangeView, TargetDef } from './types';
import { AIM_LIMIT, EYE, FLIGHT, advance, aimDir, clampAim, launch, newFlight, segSphere, sightTo, targetX, type Aim } from './physics';
import { balloonColor, layoutFor, type Layout } from './layouts';
import { ArcheryCpu } from './ai';
import { Rng, clamp } from '../core/math';

export { aimFor, flyTo, sightTo, targetX, FLIGHT, EYE, AIM_LIMIT } from './physics';

export type ArcheryState = 'intro' | 'aim' | 'flight' | 'result' | 'next' | 'over';

export interface ArcheryOptions {
  /** ends (rounds of arrows), default 3: each a new range and a stronger wind */
  ends?: number;
  /** arrows each archer shoots per end, default 3 */
  arrows?: number;
  /** seeds the ranges and the wind (the same seed, the same ranges), the CPUs and the shake */
  seed?: number;
  /** each end's range and wind (default layouts.ts layoutFor: a practice range or the checks can bring their own) */
  layout?: (end: number, rng: Rng, firstId: number) => Layout;
}

/** One arrow's outcome in full (the 'score' event has the essentials). */
export interface ArcheryShot {
  who: number;
  /** 1-based, as ArcheryGame.end and .arrowNo */
  end: number;
  arrow: number;
  points: number;
  /** the ring it hit on a face (0 = none) */
  ring: number;
  bullseye: boolean;
  /** inside the X: the inner half of the 10 (it breaks ties) */
  x: boolean;
  /** the face it stuck in, else the last balloon it popped, else −1 */
  target: number;
  /** balloons it popped on the way (ids) */
  balloons: number[];
  /** what stopped it: a face, the ground, the backstop (behind or beside the range), or nothing (over it all: gone) */
  where: 'face' | 'ground' | 'backstop' | 'lost';
  /** launch speed, m/s, and time in the air, s */
  speed: number;
  flightT: number;
  /** where it ended up (on a face: the point on the face) */
  px: number;
  py: number;
  pz: number;
  /** on a face: where, from its centre (m, + = right / up) */
  fx: number;
  fy: number;
}

// ---- timing, s
const INTRO_T = 3;
/** 'next' before a new end's first arrow (its number and wind are up) … */
const END_T = 2.4;
/** … and before the next archer's first arrow of the end */
const NEXT_T = 1.4;
/** putting a new arrow on the string: it can be drawn from then */
const NOCK_T = 0.5;
/** the follow-through after letting go (then 'watch') */
const RELEASE_T = 0.3;
/** the look at where it went before the next arrow (longer after a 10 or a pop, shorter after a miss) */
const RESULT_T = 1.8;
const RESULT_BIG_T = 2.6;
const RESULT_MISS_T = 1.5;

/** let go below this much draw and the string is put down (back to aiming) instead of shooting */
export const MIN_DRAW = 0.25;
/** a string that's let go (or put down) relaxes this many times faster than it's drawn */
const RELAX = 4;
/** holding at full draw: steady for HOLD_STEADY s, then the bow arm starts to shake,
 *  growing to ±SHAKE_MAX radians (6 mrad ≈ 9 cm at 15 m, 18 cm at 30 m) by HOLD_TIRED */
const HOLD_STEADY = 2.5;
const HOLD_TIRED = 6;
const SHAKE_MAX = 0.006;
/** the X ring: this share of a face's radius (half the 10) */
const X_R = 0.05;

/** How long the timed parts last, s (for the camera, HUD and animator), and the draw's rules. */
export const ARCHERY_TIMING = {
  intro: INTRO_T,
  end: END_T,
  next: NEXT_T,
  nock: NOCK_T,
  draw: RANGE.drawT,
  release: RELEASE_T,
  result: RESULT_T,
  resultBig: RESULT_BIG_T,
  resultMiss: RESULT_MISS_T,
  holdSteady: HOLD_STEADY,
  holdTired: HOLD_TIRED,
  shakeMax: SHAKE_MAX,
  minDraw: MIN_DRAW,
} as const;

/** an arrow left in something for the rest of the end */
interface Stuck {
  view: ArrowView;
  /** index into targets of what it's in (−1 = the ground or the backstop) */
  ti: number;
  /** its tip's x from that target's centre (a moving target carries it along) */
  offX: number;
}

export class ArcheryGame {
  state: ArcheryState = 'intro';
  stateT0 = 0;
  t = 0;
  /** the end being shot, 1-based (the intro already shows end 1's range) */
  end = 1;
  /** whose turn it is, an index into archers (in 'next': who's up next) */
  current = 0;
  /** which of their arrows this end, 1-based */
  arrowNo = 1;
  readonly ends: number;
  /** arrows each archer shoots per end */
  readonly arrows: number;
  /** points for each arrow shot so far, per archer, end after end */
  readonly scores: number[][];
  /** every arrow's outcome in full, in order */
  readonly shots: ArcheryShot[] = [];
  /** the last arrow's outcome */
  last: ArcheryShot | null = null;
  /** m/s, + = blowing to +x (the archer's right); fixed for an end */
  wind = 0;
  /** this end's targets, at rest (view() has where the moving ones are now); ids are unique through the game */
  targets: TargetDef[] = [];
  /** index into targets of the main face (the one the CPUs shoot, and a person's aim starts on) */
  main = 0;
  /** when this end's range came up: the sway runs from here (targetX(def, t − endT0)) */
  endT0 = 0;
  /** the current archer's body, for the animator (always on the shooting line at x = 0) */
  readonly archer: ArcherState;
  /** this turn's default aim: straight at the main face's centre (a person's aim until their phone sends one) */
  readonly home: Aim = { yaw: 0, pitch: 0 };
  /** when this turn's arrow is on the string: it can be drawn from then */
  nockAt = 0;
  onEvent: (e: ArcheryEvent) => void = () => {};

  /** the ranges and the wind (their own, so a seed gives the same ranges whoever plays) */
  private rangeRng: Rng;
  private layout: (end: number, rng: Rng, firstId: number) => Layout;
  /** the shake's phases */
  private rng: Rng;
  private cpus: (ArcheryCpu | null)[];
  /** the aim this turn: a person's phone (or home), or the CPU's hands */
  private aimIn: Aim = { yaw: 0, pitch: 0 };
  /** a long full draw's shake, radians, on top of the aim */
  private shakeYaw = 0;
  private shakePitch = 0;
  private shakePh = [0, 0, 0, 0];
  /** the archer who's up is holding DRAW */
  private pulling = false;
  /** input seats whose DRAW is down (held through to their turn, it draws once the arrow's nocked) */
  private held = new Set<number>();
  /** arrows left in things this end */
  private stuck: Stuck[] = [];
  /** every arrow on show this end, in the order shot (the one on the bow or in the air last) */
  private arrowViews: ArrowView[] = [];
  /** this turn's arrow: on the bow, in the air, or where it ended up (null once lost) */
  private shot: ArrowView | null = null;
  private fl = newFlight();
  private shotSpeed = 0;
  private popped: boolean[] = [];
  /** balloons this arrow has popped (indexes into targets) */
  private poppedNow: number[] = [];
  private resultAt = 0;
  /** how the archer takes it, once the follow-through is done */
  private reaction: ArcherState['phase'] = 'watch';
  private nextT = 0;
  private nextId = 0;
  /** 10s and Xs per archer (the tie-breaks) */
  private tens: number[];
  private xs: number[];
  private dir = { x: 0, y: 0, z: -1 };
  private tviews: RangeView['targets'] = [];
  /** effects since the last view(), and the array handed out last time (double-buffered: no garbage) */
  private fxA: RangeFx[] = [];
  private fxB: RangeFx[] = [];
  private out: RangeView = { targets: [], arrows: [], wind: 0, fx: this.fxB };

  constructor(
    readonly archers: Archer[],
    opts: ArcheryOptions = {},
  ) {
    if (!archers.length) throw new Error('ArcheryGame: nobody to shoot');
    this.ends = Math.max(1, Math.round(opts.ends ?? 3));
    this.arrows = Math.max(1, Math.round(opts.arrows ?? 3));
    const seed = opts.seed ?? (Math.random() * 2 ** 31) | 0;
    this.rangeRng = new Rng(seed);
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.layout = opts.layout ?? layoutFor;
    this.scores = archers.map(() => []);
    this.tens = archers.map(() => 0);
    this.xs = archers.map(() => 0);
    this.cpus = archers.map((a, i) => (a.cpu !== null ? new ArcheryCpu(a.cpu, seed + 7919 * (i + 1)) : null));
    this.archer = { x: EYE.x, z: RANGE.lineZ, handed: archers[0].handed, phase: 'idle', t: 0, draw: 0, yaw: 0, pitch: 0 };
    // end 1's range is up for the intro
    this.setRange();
    this.idle();
  }

  /** skip ahead: past the intro, a pause before a turn, or the look at where an arrow went */
  skip() {
    if (this.state === 'intro') this.startEnd();
    else if (this.state === 'next') this.beginTurn();
    else if (this.state === 'result') this.after();
  }

  // ------------------------------------------------------------ read-outs

  total(i: number) {
    let s = 0;
    for (const p of this.scores[i]) s += p;
    return s;
  }

  /** archer i's points in end e (1-based) so far */
  endTotal(i: number, e: number) {
    let s = 0;
    const a = this.scores[i];
    for (let k = (e - 1) * this.arrows; k < Math.min(a.length, e * this.arrows); k++) s += a[k];
    return s;
  }

  /** the main face (at rest) */
  mainTarget() {
    return this.targets[this.main];
  }

  /** the latest arrow — on the bow, in the air, or where it stuck (still the last one during a pause) — for the
   *  camera; null once one's lost over everything, and when a new end's range comes up */
  get shotArrow(): ArrowView | null {
    return this.shot;
  }

  /** What the range draws this frame. Effects are handed out once: the array is reused after the next call. */
  view(): RangeView {
    const v = this.out;
    const since = this.t - this.endT0;
    for (let i = 0; i < this.tviews.length; i++) {
      const tv = this.tviews[i];
      tv.x = targetX(this.targets[i], since);
      tv.popped = this.popped[i];
      tv.visible = !tv.popped;
    }
    v.targets = this.tviews;
    v.arrows = this.arrowViews;
    v.wind = this.wind;
    v.fx = this.fxA;
    this.fxA = this.fxB;
    this.fxB = v.fx;
    this.fxA.length = 0;
    return v;
  }

  // ------------------------------------------------------------ input (people, by input seat)

  /** a person's DRAW went down (pull the string back) or up (let go: shoot — or, hardly drawn, put it down) */
  draw(slot: number, down: boolean) {
    if (down) this.held.add(slot);
    else this.held.delete(slot);
    if (down && this.state === 'intro') return this.skip();
    if (this.personUp(slot)) this.press(down);
  }

  /** where a person aims: the arrow's yaw and pitch, radians (see physics.ts); held until the next one */
  aim(slot: number, yaw: number, pitch: number) {
    if (this.state !== 'aim' || !this.personUp(slot) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this.aimIn.yaw = yaw;
    this.aimIn.pitch = pitch;
    clampAim(this.aimIn);
    this.pose();
  }

  /** put the string back down without shooting — the same arrow is still to shoot (the game was
   *  paused mid-draw: the phone lets go of DRAW then, which mustn't loose it) */
  cancelDraw(slot: number) {
    this.held.delete(slot);
    if (this.state !== 'aim' || !this.personUp(slot)) return;
    this.pulling = false;
    const p = this.archer.phase;
    if (p === 'draw' || p === 'hold') this.putDown();
  }

  // ------------------------------------------------------------ the CPU's hands (see ai.ts)

  cpuAim(yaw: number, pitch: number) {
    if (this.archers[this.current].cpu === null) return;
    this.aimIn.yaw = yaw;
    this.aimIn.pitch = pitch;
    clampAim(this.aimIn);
    this.pose();
  }

  cpuDraw(down: boolean) {
    if (this.archers[this.current].cpu !== null) this.press(down);
  }

  // ------------------------------------------------------------ simulation

  step(dt: number) {
    if (!(dt > 0)) return;
    this.t += dt;
    const a = this.archer;
    a.t += dt;
    switch (this.state) {
      case 'intro':
        if (this.t - this.stateT0 >= INTRO_T) this.startEnd();
        break;
      case 'next':
        if (this.t - this.stateT0 >= this.nextT) this.beginTurn();
        break;
      case 'aim':
        this.aiming(dt);
        break;
      case 'flight':
        this.fly(dt);
        break;
      case 'result':
        if (this.t >= this.resultAt) this.after();
        break;
      case 'over':
        break;
    }
    // the follow-through, then watching it go (or, if it's already there, the reaction)
    if (a.phase === 'release' && a.t >= RELEASE_T) this.setPhase(this.state === 'result' ? this.reaction : 'watch');
    this.carry();
  }

  private personUp(slot: number) {
    const ar = this.archers[this.current];
    return ar.cpu === null && ar.slot === slot;
  }

  /** DRAW went down or up for the archer who's up */
  private press(down: boolean) {
    this.pulling = down;
    if (this.state !== 'aim') return;
    const p = this.archer.phase;
    if (down) {
      if (p === 'nock' && this.t >= this.nockAt) this.startDraw();
    } else if (p === 'draw' || p === 'hold') {
      if (this.archer.draw < MIN_DRAW) this.putDown();
      else this.shoot();
    }
  }

  private startDraw() {
    this.setPhase('draw');
    this.onEvent({ type: 'draw', who: this.current });
  }

  /** the string goes back down; the arrow stays nocked (it can be drawn again at once) */
  private putDown() {
    this.setPhase('nock');
    this.nockAt = this.t;
    this.shakeYaw = this.shakePitch = 0;
    this.pose();
  }

  /** nock → draw → hold at full draw; the aim follows the phone (or the CPU), shaking after a long hold */
  private aiming(dt: number) {
    const a = this.archer;
    const cpu = this.cpus[this.current];
    cpu?.update(this);
    if (this.state !== 'aim') return; // it let go
    if (a.phase === 'nock') {
      if (a.draw > 0) a.draw = Math.max(0, a.draw - (dt * RELAX) / RANGE.drawT);
      if (this.pulling && this.t >= this.nockAt) this.startDraw();
    } else if (a.phase === 'draw') {
      // (a draw started during this step has been going for a.t, not dt)
      a.draw = Math.min(1, a.draw + Math.min(dt, a.t) / RANGE.drawT);
      if (a.draw >= 1) this.setPhase('hold');
    }
    // a long hold at full draw: the bow arm tires and shakes (people — a CPU lets go well before)
    if (a.phase === 'hold' && !cpu) {
      const amp = SHAKE_MAX * clamp((a.t - HOLD_STEADY) / (HOLD_TIRED - HOLD_STEADY));
      const s = 2 * Math.PI * a.t;
      const ph = this.shakePh;
      this.shakeYaw = amp * (0.6 * Math.sin(1.9 * s + ph[0]) + 0.4 * Math.sin(4.7 * s + ph[1]));
      this.shakePitch = amp * (0.6 * Math.sin(2.3 * s + ph[2]) + 0.4 * Math.sin(5.3 * s + ph[3]));
    } else this.shakeYaw = this.shakePitch = 0;
    this.pose();
  }

  /** the archer's aim (and the arrow on the bow, sliding back as the string's drawn) */
  private pose() {
    const a = this.archer;
    a.yaw = clamp(this.aimIn.yaw + this.shakeYaw, -AIM_LIMIT.yaw, AIM_LIMIT.yaw);
    a.pitch = clamp(this.aimIn.pitch + this.shakePitch, AIM_LIMIT.pitchMin, AIM_LIMIT.pitchMax);
    const v = this.shot;
    if (!v || v.state !== 'nocked') return;
    const d = aimDir(a.yaw, a.pitch, this.dir);
    const reach = FLIGHT.bow + FLIGHT.slide * (1 - a.draw);
    v.x = EYE.x + d.x * reach;
    v.y = EYE.y + d.y * reach;
    v.z = EYE.z + d.z * reach;
    v.dx = d.x;
    v.dy = d.y;
    v.dz = d.z;
  }

  /** let go: the arrow leaves the bow at the draw's share of full speed, along the aim */
  private shoot() {
    const a = this.archer;
    const who = this.current;
    const speed = RANGE.fullSpeed * a.draw;
    launch(this.fl, a.yaw, a.pitch, speed);
    this.shotSpeed = speed;
    this.poppedNow.length = 0;
    if (this.shot) this.shot.state = 'flying';
    this.arrowPose();
    a.draw = 0;
    this.pulling = false;
    this.shakeYaw = this.shakePitch = 0;
    this.setPhase('release');
    this.setState('flight');
    this.onEvent({ type: 'shot', who, speed });
  }

  /** the arrow flies on: sub-steps of at most FLIGHT.maxH, each swept for what it meets */
  private fly(dt: number) {
    const f = this.fl;
    const n = Math.max(1, Math.ceil(dt / FLIGHT.maxH - 1e-9));
    const h = dt / n;
    const t0 = this.t - dt;
    for (let k = 0; k < n; k++) {
      const x0 = f.x;
      const y0 = f.y;
      const z0 = f.z;
      advance(f, h, this.wind);
      if (this.sweep(x0, y0, z0, t0 + k * h, h)) return;
      if (f.t >= FLIGHT.maxT) return this.land('lost', -1, f.x, f.y, f.z, this.t - this.endT0);
    }
    this.arrowPose();
  }

  /**
   * What the arrow met on its way from (x0, y0, z0) to where it is now, over the
   * sub-step from game time ta: the first of a face (through the face's plane,
   * within its radius — faces look along +z), the ground or the backstop ends
   * the flight; balloons before that pop and it flies on. True if it landed.
   */
  private sweep(x0: number, y0: number, z0: number, ta: number, h: number) {
    const f = this.fl;
    const x1 = f.x;
    const y1 = f.y;
    const z1 = f.z;
    const since = ta - this.endT0;
    let best = 2;
    let where: ArcheryShot['where'] = 'lost';
    let ti = -1;
    for (let i = 0; i < this.targets.length; i++) {
      const d = this.targets[i];
      if (d.kind !== 'face' || !(z0 > d.z && z1 <= d.z)) continue;
      const u = (z0 - d.z) / (z0 - z1);
      if (u >= best) continue;
      const cx = targetX(d, since + u * h);
      if (Math.hypot(x0 + (x1 - x0) * u - cx, y0 + (y1 - y0) * u - d.y) <= d.r) {
        best = u;
        where = 'face';
        ti = i;
      }
    }
    if (y0 > 0 && y1 <= 0) {
      // (coming down beyond the backstop, out of the stadium: gone)
      const u = y0 / (y0 - y1);
      const out = z0 + (z1 - z0) * u < FLIGHT.backZ || Math.abs(x0 + (x1 - x0) * u) > FLIGHT.sideX;
      if (u < best) ((best = u), (where = out ? 'lost' : 'ground'), (ti = -1));
    }
    // the backstop behind the range and at its sides (an arrow over the top of it flies on)
    if (z0 > FLIGHT.backZ && z1 <= FLIGHT.backZ) {
      const u = (z0 - FLIGHT.backZ) / (z0 - z1);
      if (u < best && y0 + (y1 - y0) * u <= FLIGHT.backTop) ((best = u), (where = 'backstop'), (ti = -1));
    }
    if (Math.abs(x0) < FLIGHT.sideX && Math.abs(x1) >= FLIGHT.sideX) {
      const u = ((x1 > 0 ? FLIGHT.sideX : -FLIGHT.sideX) - x0) / (x1 - x0);
      if (u < best && y0 + (y1 - y0) * u <= FLIGHT.backTop) ((best = u), (where = 'backstop'), (ti = -1));
    }
    for (let i = 0; i < this.targets.length; i++) {
      const d = this.targets[i];
      if (d.kind !== 'balloon' || this.popped[i]) continue;
      const s = segSphere(x0, y0, z0, x1, y1, z1, targetX(d, since + 0.5 * h), d.y, d.z, d.r);
      if (s >= 0 && s <= best) this.pop(i, since + s * h);
    }
    if (best > 1) return false;
    this.land(where, ti, x0 + (x1 - x0) * best, y0 + (y1 - y0) * best, z0 + (z1 - z0) * best, since + best * h);
    return true;
  }

  private pop(i: number, since: number) {
    const d = this.targets[i];
    this.popped[i] = true;
    this.poppedNow.push(i);
    this.fx({ type: 'pop', x: targetX(d, since), y: d.y, z: d.z, color: balloonColor(d.id) });
  }

  /** the flight's over, at (hx, hy, hz), `since` s into the end: stick it there (or lose it), score it */
  private land(where: ArcheryShot['where'], ti: number, hx: number, hy: number, hz: number, since: number) {
    const f = this.fl;
    const v = this.shot;
    const who = this.current;
    let ring = 0;
    let isX = false;
    let target = -1;
    let fx = 0;
    let fy = 0;
    if (v) {
      const sp = Math.hypot(f.vx, f.vy, f.vz) || 1;
      v.dx = f.vx / sp;
      v.dy = f.vy / sp;
      v.dz = f.vz / sp;
      if (where === 'lost') {
        // flew off over everything: gone
        const k = this.arrowViews.indexOf(v);
        if (k >= 0) this.arrowViews.splice(k, 1);
        this.shot = null;
      } else {
        // the tip goes in a little way
        v.state = 'stuck';
        v.x = hx + v.dx * FLIGHT.bury;
        v.y = hy + v.dy * FLIGHT.bury;
        v.z = hz + v.dz * FLIGHT.bury;
        v.target = -1;
        const rec: Stuck = { view: v, ti, offX: 0 };
        if (where === 'face') {
          const d = this.targets[ti];
          const cx = targetX(d, since);
          fx = hx - cx;
          fy = hy - d.y;
          const r = Math.hypot(fx, fy);
          ring = ringOf(r, d.r);
          isX = r <= d.r * X_R;
          target = d.id;
          v.target = d.id;
          rec.offX = v.x - cx;
          this.fx({ type: 'hit', x: hx, y: hy, z: hz, ring });
        } else this.fx({ type: 'thunk', x: hx, y: hy, z: hz });
        this.stuck.push(rec);
      }
    }
    let bonus = 0;
    const balloons: number[] = [];
    for (const i of this.poppedNow) {
      bonus += this.targets[i].bonus;
      balloons.push(this.targets[i].id);
    }
    if (target < 0 && balloons.length) target = balloons[balloons.length - 1];
    const points = ring + bonus;
    this.scores[who].push(points);
    if (ring === 10) this.tens[who]++;
    if (isX) this.xs[who]++;
    const shot: ArcheryShot = {
      who,
      end: this.end,
      arrow: this.arrowNo,
      points,
      ring,
      bullseye: ring === 10,
      x: isX,
      target,
      balloons,
      where,
      speed: this.shotSpeed,
      flightT: f.t,
      px: hx,
      py: hy,
      pz: hz,
      fx,
      fy,
    };
    this.shots.push(shot);
    this.last = shot;
    // how they take it (once the follow-through's done)
    this.reaction = points >= 8 || balloons.length ? 'cheer' : points <= 3 ? 'sad' : 'watch';
    if (this.archer.phase === 'watch') this.setPhase(this.reaction);
    this.setState('result');
    this.resultAt = this.t + (ring === 10 || balloons.length ? RESULT_BIG_T : points === 0 ? RESULT_MISS_T : RESULT_T);
    this.onEvent({ type: 'score', who, points, ring, target, bullseye: ring === 10, x: hx, y: hy, z: hz });
  }

  private arrowPose() {
    const v = this.shot;
    if (!v) return;
    const f = this.fl;
    v.x = f.x;
    v.y = f.y;
    v.z = f.z;
    const s = Math.hypot(f.vx, f.vy, f.vz) || 1;
    v.dx = f.vx / s;
    v.dy = f.vy / s;
    v.dz = f.vz / s;
  }

  /** arrows stuck in a moving target go with it */
  private carry() {
    const since = this.t - this.endT0;
    for (const s of this.stuck) {
      if (s.ti < 0) continue;
      const d = this.targets[s.ti];
      if (d.swayX) s.view.x = targetX(d, since) + s.offX;
    }
  }

  // ------------------------------------------------------------ turns and ends

  /** after the look at where an arrow went: their next arrow, the next archer, the next end, or the end of it all */
  private after() {
    if (this.arrowNo < this.arrows) {
      this.arrowNo++;
      this.beginTurn();
    } else if (this.current < this.archers.length - 1) {
      this.current++;
      this.arrowNo = 1;
      // the balloons are blown up again for the next archer
      this.popped.fill(false);
      this.pause(NEXT_T);
    } else if (this.end < this.ends) {
      this.end++;
      this.current = 0;
      this.arrowNo = 1;
      this.setRange();
      this.startEnd();
    } else this.finish();
  }

  /** this end's range and wind (arrows from the last are cleared away) */
  private setRange() {
    const L = this.layout(this.end, this.rangeRng, this.nextId);
    this.nextId += L.targets.length;
    this.targets = L.targets;
    this.main = L.main;
    this.wind = L.wind;
    this.endT0 = this.t;
    this.popped = L.targets.map(() => false);
    this.tviews = L.targets.map((d) => ({ ...d, visible: true, popped: false }));
    this.stuck.length = 0;
    this.arrowViews.length = 0;
    this.shot = null;
  }

  private startEnd() {
    this.pause(END_T);
    this.onEvent({ type: 'end', end: this.end, ends: this.ends, wind: this.wind });
  }

  /** a moment before the next turn (whoever's up stands ready) */
  private pause(dur: number) {
    this.setState('next');
    this.nextT = dur;
    this.idle();
  }

  private idle() {
    const a = this.archer;
    a.handed = this.archers[this.current].handed;
    a.draw = 0;
    this.aimHome();
    this.setPhase('idle');
    this.pose();
  }

  /** straight at the main face */
  private aimHome() {
    const d = this.targets[this.main];
    sightTo(targetX(d, this.t - this.endT0), d.y, d.z, this.home);
    this.aimIn.yaw = this.home.yaw;
    this.aimIn.pitch = this.home.pitch;
    this.shakeYaw = this.shakePitch = 0;
  }

  private beginTurn() {
    const who = this.current;
    const ar = this.archers[who];
    this.setState('aim');
    const a = this.archer;
    a.handed = ar.handed;
    a.draw = 0;
    this.aimHome();
    for (let i = 0; i < 4; i++) this.shakePh[i] = this.rng.range(0, 2 * Math.PI);
    this.nockAt = this.t + NOCK_T;
    this.pulling = ar.cpu === null && this.held.has(ar.slot);
    const v: ArrowView = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1, state: 'nocked', target: -1, color: ar.color };
    this.shot = v;
    this.arrowViews.push(v);
    this.setPhase('nock');
    this.cpus[who]?.begin(this);
    this.pose();
    this.onEvent({ type: 'turn', who, arrow: this.arrowNo, arrows: this.arrows });
  }

  private finish() {
    this.setState('over');
    this.setPhase('idle');
    // most points; then most 10s, then most Xs
    const ranking = this.archers.map((_, i) => i).sort((p, q) => this.total(q) - this.total(p) || this.tens[q] - this.tens[p] || this.xs[q] - this.xs[p] || p - q);
    this.onEvent({ type: 'over', ranking });
  }

  private setPhase(p: ArcherState['phase']) {
    this.archer.phase = p;
    this.archer.t = 0;
  }

  private setState(s: ArcheryState) {
    this.state = s;
    this.stateT0 = this.t;
  }

  private fx(e: RangeFx) {
    // (nobody reading them — a headless sim — mustn't grow this forever)
    if (this.fxA.length < 32) this.fxA.push(e);
  }
}
