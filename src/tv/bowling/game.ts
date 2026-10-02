// Bowling: turns, frames, the approach and release, the pinsetter, and the calls
// (strike, spare, split…). Physics, rendering and animation live in their own
// modules; this is the referee and the stage manager.

import { FOUL_Z, LANE, pinSpots } from './lane';
import type { BallThrow, BowlPhysicsEvent, BowlerState } from './types';
import type { BowlPhysics } from './physics';
import { BowlScore } from './score';
import type { Look } from '../chars/look';
import { Rng, clamp } from '../core/math';

export interface Bowler {
  name: string;
  color: string;
  look: Look;
  handed: 1 | -1;
  /** input seat, or -1 for a CPU bowler */
  slot: number;
  /** CPU skill 0..1 (null = a person) */
  cpu: number | null;
  score: BowlScore;
  /** where they stand on the approach (lateral, m) and where they aim (radians, + right) */
  x: number;
  aim: number;
}

export type BowlState = 'intro' | 'ready' | 'approach' | 'lane' | 'pins' | 'result' | 'sweep' | 'over';

export type BowlMark = 'strike' | 'spare' | 'gutter' | 'split' | 'miss' | 'pins';

export type BowlEvent =
  /** a new ball is up for this bowler */
  | { type: 'turn'; bowler: Bowler; frame: number; ball: number }
  | { type: 'grip'; bowler: Bowler }
  | { type: 'release'; bowler: Bowler; t: BallThrow; kph: number }
  /** physics pass-through (sounds, camera) */
  | { type: 'physics'; e: BowlPhysicsEvent }
  | { type: 'result'; bowler: Bowler; pins: number; standing: boolean[]; mark: BowlMark; frame: number; ball: number }
  /** a grip let go without a swing (or never released): back to the stance */
  | { type: 'cancel'; bowler: Bowler }
  /** the pinsetter clears the deck */
  | { type: 'sweep' }
  | { type: 'over'; ranking: Bowler[] };

/** where the approach starts (the bowler's stance) and where the slide ends */
export const STANCE_Z = FOUL_Z + 3.9;
const SLIDE_Z = FOUL_Z + 0.42;
/** how long the four-step approach takes */
const APPROACH_T = 1.35;
/** the ball sits this far to the bowling-hand side of the body */
const HAND_X = 0.2;
/** a phone's message is at most this old when it's played from then, s */
const MAX_AGE = 0.3;
/** the phone measures the swing's real direction; the lane wants a fraction of it
 *  (0.1 rad over 18 m is 1.8 m — a sure gutter — so a small pull stays a small miss) */
const ANGLE_GAIN = 0.1;
/** how much of the measured wrist twist becomes spin (1 would hook ~0.8 m at 7.5 m/s) */
const SPIN_GAIN = 0.8;
/** where a bowler starts: a straight ball from here meets the pocket (1-3 for a right-hander) */
export const START_X = 0.065 - HAND_X;
/** ◀ ▶ and ↖ ↗: a press steps (a board), holding keeps going after a moment */
const MOVE_STEP = 0.027;
const MOVE_RATE = 0.4;
const TURN_STEP = 0.0015;
const TURN_RATE = 0.02;
const AIM_MAX = 0.06;
const HOLD_DELAY = 0.35;

/** The hook's sideways travel at the head pin for a speed and spin (m, − = left),
 *  measured from the lane model (scripts/check/bowl-hook-table.ts): it's the same whatever
 *  the line, so aiming a hook is aiming a straight ball at a point this far aside.
 *  K(v) = the hook per unit of spin at speed v, which saturates a little. */
const HOOK_K: [number, number][] = [
  [3, 2.6],
  [4, 2.03],
  [5, 1.48],
  [6, 1.165],
  [7, 0.95],
  [8, 0.785],
  [9, 0.645],
  [10, 0.52],
  [11, 0.405],
];
export function hookAt(speed: number, spin: number) {
  const v = clamp(speed, 3, 11);
  let i = 0;
  while (i < HOOK_K.length - 2 && HOOK_K[i + 1][0] < v) i++;
  const [v0, k0] = HOOK_K[i];
  const [v1, k1] = HOOK_K[i + 1];
  const k = k0 + ((v - v0) / (v1 - v0)) * (k1 - k0);
  return -spin * k * (1 - 0.1 * Math.abs(spin));
}

/** pins that touch each other in the rack (for splits) */
const ADJ: number[][] = [[1, 2], [0, 2, 3, 4], [0, 1, 4, 5], [1, 4, 6, 7], [1, 2, 3, 5, 7, 8], [2, 4, 8, 9], [3, 7], [3, 4, 6, 8], [4, 5, 7, 9], [5, 8]];

export class BowlingGame {
  state: BowlState = 'intro';
  stateT0 = 0;
  t = 0;
  current = 0;
  onEvent: (e: BowlEvent) => void = () => {};
  /** the active bowler's body, for the animator */
  body: BowlerState = { x: 0, z: STANCE_Z, yaw: 0, handed: 1, phase: 'ready', t: 0, arm: 0.9, step: 0, holding: true, spin: 0 };
  /** the pins standing before this ball */
  private rackStanding: boolean[] = new Array(10).fill(true);
  /** the arm angle streamed from the phone (null = animate it ourselves) */
  private armLive: number | null = null;
  private armLiveT = -1;
  private gripping = false;
  /** when the grip went down, and when it came up with no release after it */
  private gripT = 0;
  private gripUpT = -1;
  private cpuAt = 0;
  private cpuReleaseAt = 0;
  private moveDir = 0;
  private turnDir = 0;
  private moveT = 0;
  private turnT = 0;
  /** a CPU bowler's plan for this ball: where to stand, the line, and the throw */
  private plan: { x: number; aim: number; speed: number; spin: number } | null = null;
  private resultAt = 0;
  private rng = new Rng();
  lastThrow: BallThrow | null = null;
  /** how the last ball went (for the camera's reaction shot) */
  lastMark: BowlMark | null = null;
  /** a release that came before the bowler reached the line: hurry there, then let go
   *  (`age`: how old the phone's message was, the ball's flight is caught up by that much when it goes) */
  private pending: { speed: number; angle: number; spin: number; age: number } | null = null;

  constructor(
    public bowlers: Bowler[],
    public phys: BowlPhysics,
  ) {
    this.phys.onEvent = (e) => this.physEvent(e);
    this.phys.rack();
  }

  get bowler() {
    return this.bowlers[this.current];
  }

  /** skip the intro (a button press) */
  startNow() {
    if (this.state === 'intro') this.beginTurn();
  }

  // ------------------------------------------------------------ input

  /**
   * The grip went down (hold the ball) or up (let it go — the release follows).
   * `age`: the message is that many seconds old (the phone's detector, the network):
   * the walk-up started that long ago.
   */
  grip(slot: number, down: boolean, age = 0) {
    const b = this.bowler;
    if (b.slot !== slot) return;
    if (this.state === 'intro' && down) return this.startNow();
    if (down && this.state === 'ready') {
      age = this.ageOf(age);
      this.gripping = true;
      this.gripT = this.t - age;
      this.gripUpT = -1;
      this.setState('approach');
      // (the four steps started `age` ago: the approach clock and the body's are that far on)
      this.stateT0 -= age;
      this.body.phase = 'approach';
      this.body.t = age;
      this.onEvent({ type: 'grip', bowler: b });
    } else if (!down && this.gripping) {
      // the release follows at once; if it doesn't (the phone left the bowling
      // screen, a lost message), the bowler steps back to the stance
      this.gripping = false;
      this.gripUpT = this.t;
    }
  }

  /**
   * The phone measured a release: speed m/s, angle rad (+ right), spin −1..1.
   * `age`: the ball left the hand that many seconds ago — it's rolled on by that much at once,
   * so it isn't late.
   */
  release(slot: number, r: { speed: number; angle: number; spin: number }, age = 0) {
    const b = this.bowler;
    if (b.slot !== slot) return;
    age = this.ageOf(age);
    if (this.state === 'ready') {
      // a release with no grip first (a swipe): walk up from the stance
      this.setState('approach');
      this.body.phase = 'approach';
      this.body.t = 0;
    }
    if (this.state !== 'approach' || this.pending) return;
    this.gripUpT = -1;
    // a tap with no swing behind it: not a throw (a thumb brushing the grip)
    if (r.speed < 2.8 && this.t - age - this.gripT < 0.6) return this.cancel();
    const angle = r.angle * ANGLE_GAIN;
    // a little wrist turn is a little hook, a real twist a big one: a stray turn
    // doesn't wreck a straight ball; the hardest twist curves about 23 boards
    const spin = Math.sign(r.spin) * Math.pow(Math.min(1, Math.abs(r.spin)), 1.5) * SPIN_GAIN;
    // the ball leaves the hand at the foul line: if the bowler isn't there yet,
    // they hurry through the last steps and let go on arrival
    if (this.body.step >= 0.9) this.throwBall(r.speed, angle, spin, 0, age);
    else this.pending = { speed: r.speed, angle, spin, age };
  }

  private ageOf(age: number) {
    return Number.isFinite(age) ? clamp(age, 0, MAX_AGE) : 0;
  }

  /** back to the stance, ball in hand, as if the grip never happened */
  private cancel() {
    const b = this.bowler;
    this.setState('ready');
    this.gripping = false;
    this.gripUpT = -1;
    this.armLive = null;
    this.pending = null;
    this.body = { x: b.x, z: STANCE_Z, yaw: 0, handed: b.handed, phase: 'ready', t: 0, arm: 0.9, step: 0, holding: true, spin: 0 };
    this.onEvent({ type: 'cancel', bowler: b });
  }

  /** live arm angle from the phone while the grip is held */
  setArm(slot: number, arm: number) {
    if (this.bowler.slot !== slot) return;
    this.armLive = arm;
    this.armLiveT = this.t;
  }

  /** ◀ ▶ step along the approach, ↖ ↗ turn the aim: a press moves one board,
   *  holding keeps going (dir 0 = let go) */
  move(slot: number, dir: number) {
    const b = this.bowler;
    if (b.slot !== slot) return;
    if (dir && dir !== this.moveDir && this.state === 'ready') {
      b.x = this.clampX(b, b.x + dir * MOVE_STEP);
      this.moveT = this.t;
    }
    this.moveDir = dir;
  }
  turn(slot: number, dir: number) {
    const b = this.bowler;
    if (b.slot !== slot) return;
    if (dir && dir !== this.turnDir && this.state === 'ready') {
      b.aim = clamp(b.aim + dir * TURN_STEP, -AIM_MAX, AIM_MAX);
      this.turnT = this.t;
    }
    this.turnDir = dir;
  }

  /** where the ball leaves the hand, for a bowler standing at x */
  releaseX(b: Bowler, x = b.x) {
    return x + HAND_X * b.handed;
  }

  /** keep the ball over the lane */
  private clampX(b: Bowler, x: number) {
    return clamp(x, -0.5 - HAND_X * b.handed, 0.5 - HAND_X * b.handed);
  }

  // ------------------------------------------------------------ simulation

  step(dt: number) {
    this.t += dt;
    const t = this.t;
    const b = this.bowler;
    this.body.t += dt;
    this.phys.step(dt);

    switch (this.state) {
      case 'intro':
        if (t - this.stateT0 > 2.6) this.beginTurn();
        break;
      case 'ready': {
        // stepping and turning before the throw (held: after a moment, keep going)
        if (this.moveDir && t - this.moveT > HOLD_DELAY) b.x = this.clampX(b, b.x + this.moveDir * MOVE_RATE * dt);
        if (this.turnDir && t - this.turnT > HOLD_DELAY) b.aim = clamp(b.aim + this.turnDir * TURN_RATE * dt, -AIM_MAX, AIM_MAX);
        // a CPU shuffles to its spot and lines up
        if (this.plan) {
          const dx = this.plan.x - b.x;
          b.x += clamp(dx, -0.8 * dt, 0.8 * dt);
          b.aim = this.plan.aim;
        }
        this.body.x = b.x;
        this.body.z = STANCE_Z;
        this.body.arm = 0.9; // ball held at the chest
        if (b.cpu !== null && t >= this.cpuAt && (!this.plan || Math.abs(this.plan.x - b.x) < 0.01)) {
          this.gripping = true;
          this.setState('approach');
          this.body.phase = 'approach';
          this.body.t = 0;
          this.cpuReleaseAt = t + APPROACH_T * this.rng.range(0.92, 1.02);
          this.onEvent({ type: 'grip', bowler: b });
        }
        break;
      }
      case 'approach': {
        // a waiting release fast-forwards the steps (about 0.3 s to the line)
        if (this.pending) this.stateT0 -= dt * 2.4;
        const u = clamp((t - this.stateT0) / APPROACH_T);
        this.body.step = u;
        this.body.z = STANCE_Z + (SLIDE_Z - STANCE_Z) * (1 - Math.pow(1 - u, 1.4));
        // the arm: the phone's live swing, or our own pendulum (keyboard, swipe, CPU)
        const live = this.armLive !== null && t - this.armLiveT < 0.4 && !this.pending;
        this.body.arm = live ? this.armLive! : this.pending ? Math.min(0.2, this.body.arm + dt * 7) : this.autoArm(u);
        if (this.pending && u >= 0.97) {
          const r = this.pending;
          this.pending = null;
          this.throwBall(r.speed, r.angle, r.spin, 0, r.age);
          break;
        }
        if (b.cpu !== null && t >= this.cpuReleaseAt) this.cpuThrow(b);
        // let go with no release after it (the phone left the bowling screen, a lost message)
        else if (b.cpu === null && this.gripUpT >= 0 && t - this.gripUpT > 0.6) this.cancel();
        break;
      }
      case 'lane':
      case 'pins':
        if (this.body.phase === 'release' && this.body.t > 0.35) {
          this.body.phase = 'follow';
          this.body.t = 0;
        } else if (this.body.phase === 'follow' && this.body.t > 0.8) {
          this.body.phase = 'watch';
          this.body.t = 0;
        }
        break;
      case 'result':
        if (t >= this.resultAt) this.sweep();
        break;
      case 'sweep':
        if (t - this.stateT0 > 1.1) this.nextBall();
        break;
    }
  }

  /** a bowler's pendulum when there's no phone streaming it: chest → back → through */
  private autoArm(u: number) {
    if (u < 0.35) return 0.9 - (u / 0.35) * 2.5; // down and back
    if (u < 0.75) return -1.6 + Math.sin(((u - 0.35) / 0.4) * Math.PI) * 0.15; // top of the backswing
    return -1.6 + ((u - 0.75) / 0.25) * 2.3; // forward to the release
  }

  /** `age`: it left the hand this long ago — the roll is stepped forward by that much now */
  private throwBall(speed: number, angle: number, spin: number, dx = 0, age = 0) {
    const b = this.bowler;
    const x = clamp(this.releaseX(b) + dx, -LANE.width / 2 + LANE.ballR, LANE.width / 2 - LANE.ballR);
    const th: BallThrow = { x, speed: clamp(speed, 2.5, 10.5), angle: clamp(b.aim + angle, -0.2, 0.2), spin: clamp(spin, -1, 1) };
    this.lastThrow = th;
    this.phys.throw(th);
    this.gripping = false;
    this.armLive = null;
    this.plan = null;
    this.body.phase = 'release';
    this.body.t = age;
    this.body.holding = false;
    this.body.spin = th.spin;
    this.setState('lane');
    this.onEvent({ type: 'release', bowler: b, t: th, kph: th.speed * 3.6 });
    // (the physics takes at most 0.1 s a step: catch up in the same fixed sub-steps as the frames do)
    for (let left = age; left > 1e-6 && this.state !== 'result'; left -= 0.05) this.phys.step(Math.min(0.05, left));
  }

  /**
   * A CPU bowler's plan: on a full rack, a hook into the pocket (better bowlers
   * hook more and throw a touch faster); for a spare, a straighter ball at the
   * front pin of what's left, from the other side of the lane.
   */
  private cpuPlan(b: Bowler) {
    const s = b.cpu ?? 0.5;
    const h = b.handed;
    const standing = this.rackStanding;
    let speed: number;
    let spin: number;
    let target: number;
    let from: number;
    if (standing.every(Boolean)) {
      speed = 7.3 + 0.7 * s;
      spin = (0.1 + 0.45 * s) * h;
      target = 0.065 * h;
      from = 0.2 * h;
    } else {
      speed = 7.8;
      spin = 0.1 * h;
      const up = pinSpots(0).filter((_, i) => standing[i]);
      if (!up.length) return null;
      const key = up.reduce((a, p) => (p.z > a.z + 1e-6 ? p : a));
      const cx = up.reduce((a, p) => a + p.x, 0) / up.length;
      target = key.x + clamp(cx - key.x, -0.05, 0.05);
      from = clamp(-target * 0.7 + 0.1 * h, -0.4, 0.4);
    }
    const aim = Math.atan2(target - from - hookAt(speed, spin), LANE.length);
    return { x: this.clampX(b, from - HAND_X * h), aim, speed, spin };
  }

  /** a CPU bowler's throw: the plan, as steady as their skill */
  private cpuThrow(b: Bowler) {
    const s = b.cpu ?? 0.5;
    // 1 = a steady league bowler (about ±1.3 boards at the pins)
    const k = 1 + 18 * (1 - s) * (1 - s);
    const g = () => this.rng.gauss() * k;
    const p = this.plan ?? { speed: 7.6, spin: 0.4 * b.handed };
    this.throwBall(p.speed + g() * 0.15, g() * 0.0014, p.spin + g() * 0.025, g() * 0.01);
  }

  private physEvent(e: BowlPhysicsEvent) {
    this.onEvent({ type: 'physics', e });
    if (e.type === 'settled' && (this.state === 'lane' || this.state === 'pins')) this.settled();
    else if (this.state === 'lane' && (e.type === 'hit' || e.type === 'pit')) this.setState('pins');
  }

  private settled() {
    const b = this.bowler;
    const now = this.phys.standing();
    const before = this.rackStanding.filter(Boolean).length;
    const knocked = Math.max(0, before - now.filter(Boolean).length);
    const frame = b.score.frame;
    const ball = b.score.ball;
    const fresh = before === 10;
    b.score.add(knocked);
    let mark: BowlMark = 'pins';
    if (knocked === before && fresh) mark = 'strike';
    else if (knocked === before) mark = 'spare';
    else if (knocked === 0) mark = this.phys.view.ball.gutter ? 'gutter' : 'miss';
    else if (fresh && isSplit(now)) mark = 'split';
    this.rackStanding = now;
    this.lastMark = mark;
    this.setState('result');
    // the big moments get a look at the bowler's reaction too
    this.resultAt = this.t + (mark === 'strike' || mark === 'spare' ? 2.9 : mark === 'gutter' || mark === 'split' ? 2.5 : 1.7);
    this.body.phase = mark === 'strike' || mark === 'spare' ? 'cheer' : knocked <= 2 || mark === 'gutter' ? 'sad' : 'watch';
    this.body.t = 0;
    this.onEvent({ type: 'result', bowler: b, pins: knocked, standing: now, mark, frame, ball });
  }

  /** the sweep bar clears the fallen pins; standing ones are set back on their spots */
  private sweep() {
    this.setState('sweep');
    this.onEvent({ type: 'sweep' });
  }

  private nextBall() {
    const b = this.bowler;
    // same bowler again (second ball, or the 10th frame's bonus balls)?
    const sameFrame = !b.score.done && b.score.ball > 0;
    if (sameFrame) {
      const fresh = b.score.needsFreshRack();
      this.rackStanding = fresh ? new Array(10).fill(true) : this.rackStanding;
      this.phys.rack(fresh ? undefined : this.rackStanding);
      this.beginTurn();
      return;
    }
    // next bowler (or the next frame for everyone)
    const next = this.bowlers.findIndex((_, i) => i > this.current && !this.bowlers[i].score.done);
    this.current = next >= 0 ? next : this.bowlers.findIndex((q) => !q.score.done);
    this.rackStanding = new Array(10).fill(true);
    this.phys.rack();
    if (this.current < 0) {
      this.current = 0;
      this.setState('over');
      const ranking = [...this.bowlers].sort((a, c) => c.score.total() - a.score.total());
      this.onEvent({ type: 'over', ranking });
      return;
    }
    this.beginTurn();
  }

  private beginTurn() {
    const b = this.bowler;
    this.setState('ready');
    this.gripping = false;
    this.gripUpT = -1;
    this.armLive = null;
    this.pending = null;
    this.moveDir = 0;
    this.turnDir = 0;
    this.plan = b.cpu !== null ? this.cpuPlan(b) : null;
    this.body = { x: b.x, z: STANCE_Z, yaw: 0, handed: b.handed, phase: 'ready', t: 0, arm: 0.9, step: 0, holding: true, spin: 0 };
    this.cpuAt = this.t + this.rng.range(1.2, 2.0);
    this.onEvent({ type: 'turn', bowler: b, frame: b.score.frame, ball: b.score.ball });
  }

  private setState(s: BowlState) {
    this.state = s;
    this.stateT0 = this.t;
  }
}

/** the head pin is down and what's left stands in separate groups */
export function isSplit(standing: boolean[]) {
  if (standing[0]) return false;
  const left = standing.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (left.length < 2) return false;
  const seen = new Set<number>([left[0]]);
  const stack = [left[0]];
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of ADJ[i]) if (standing[j] && !seen.has(j)) (seen.add(j), stack.push(j));
  }
  return seen.size < left.length;
}
