// Bowling: turns, frames, the approach and release, the pinsetter, and the calls
// (strike, spare, split…). Physics, rendering and animation live in their own
// modules; this is the referee and the stage manager.

import { FOUL_Z, LANE } from './lane';
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
  private cpuAt = 0;
  private cpuReleaseAt = 0;
  private moveDir = 0;
  private turnDir = 0;
  private resultAt = 0;
  private rng = new Rng();
  lastThrow: BallThrow | null = null;

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

  /** the grip went down (hold the ball) or up (let it go — the release follows) */
  grip(slot: number, down: boolean) {
    const b = this.bowler;
    if (b.slot !== slot) return;
    if (this.state === 'intro' && down) return this.startNow();
    if (down && this.state === 'ready') {
      this.gripping = true;
      this.setState('approach');
      this.body.phase = 'approach';
      this.body.t = 0;
      this.onEvent({ type: 'grip', bowler: b });
    } else if (!down) {
      this.gripping = false;
    }
  }

  /** the phone measured a release: speed m/s, angle rad (+ right), spin −1..1 */
  release(slot: number, r: { speed: number; angle: number; spin: number }) {
    const b = this.bowler;
    if (b.slot !== slot) return;
    if (this.state === 'ready') this.setState('approach'); // a release with no grip first (swipe)
    if (this.state !== 'approach') return;
    this.throwBall(r.speed, r.angle, r.spin);
  }

  /** live arm angle from the phone while the grip is held */
  setArm(slot: number, arm: number) {
    if (this.bowler.slot !== slot) return;
    this.armLive = arm;
    this.armLiveT = this.t;
  }

  /** hold ◀ ▶ to step along the approach, ↺ ↻ to turn the aim (dir 0 = stop) */
  move(slot: number, dir: number) {
    if (this.bowler.slot === slot) this.moveDir = dir;
  }
  turn(slot: number, dir: number) {
    if (this.bowler.slot === slot) this.turnDir = dir;
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
        // stepping and turning before the throw
        if (this.moveDir) b.x = clamp(b.x + this.moveDir * 0.9 * dt, -0.5 - HAND_X * b.handed, 0.5 - HAND_X * b.handed);
        if (this.turnDir) b.aim = clamp(b.aim + this.turnDir * 0.09 * dt, -0.09, 0.09);
        this.body.x = b.x;
        this.body.z = STANCE_Z;
        this.body.arm = 0.9; // ball held at the chest
        if (b.cpu !== null && t >= this.cpuAt) {
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
        const u = clamp((t - this.stateT0) / APPROACH_T);
        this.body.step = u;
        this.body.z = STANCE_Z + (SLIDE_Z - STANCE_Z) * (1 - Math.pow(1 - u, 1.4));
        // the arm: the phone's live swing, or our own pendulum (keyboard, swipe, CPU)
        const live = this.armLive !== null && t - this.armLiveT < 0.4;
        this.body.arm = live ? this.armLive! : this.autoArm(u);
        if (b.cpu !== null && t >= this.cpuReleaseAt) this.cpuThrow(b);
        // a phone that let go without a release message (lost packet): throw anyway
        if (!this.gripping && b.cpu === null && t - this.stateT0 > APPROACH_T + 2.5) this.throwBall(5, 0, 0);
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

  private throwBall(speed: number, angle: number, spin: number) {
    const b = this.bowler;
    const x = clamp(b.x + HAND_X * b.handed, -LANE.width / 2 + LANE.ballR, LANE.width / 2 - LANE.ballR);
    const th: BallThrow = { x, speed: clamp(speed, 2.5, 10.5), angle: clamp(b.aim + angle, -0.2, 0.2), spin: clamp(spin, -1, 1) };
    this.lastThrow = th;
    this.phys.throw(th);
    this.gripping = false;
    this.armLive = null;
    this.body.phase = 'release';
    this.body.t = 0;
    this.body.holding = false;
    this.body.spin = th.spin;
    this.setState('lane');
    this.onEvent({ type: 'release', bowler: b, t: th, kph: th.speed * 3.6 });
  }

  /** a CPU bowler's throw: a hook into the pocket, as steady as their skill */
  private cpuThrow(b: Bowler) {
    const s = b.cpu ?? 0.5;
    const err = 1 - s;
    const g = () => this.rng.gauss();
    this.throwBall(7.6 + g() * 0.5 * err, -0.012 * b.handed + g() * 0.02 * err, 0.55 * b.handed + g() * 0.25 * err);
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
    this.setState('result');
    this.resultAt = this.t + (mark === 'strike' || mark === 'spare' ? 2.3 : 1.7);
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
    this.armLive = null;
    this.moveDir = 0;
    this.turnDir = 0;
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
