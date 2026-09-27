// Baseball: a Home Run Derby. One to four hitters take turns; each gets a number
// of pitches (10) from a CPU pitcher throwing batting-practice strikes, and home
// runs count (ties: total home-run distance). This is the referee and the stage
// manager: the pitches (ai.ts chooses them, physics.ts flies them), the swings —
// a person's from the phone, latency and all, and the CPU hitters' — the batted
// ball's flight, the score, and the stage directions for the batter, the pitcher,
// the catcher and the hitters waiting their turn. Pure logic, no three.js: a seed
// makes it deterministic, so the sims and checks run headless.
//
// The flow: intro → 'turn' → ready (pitcher set, batter in his stance) → 'windup'
// → windup → 'pitch' as the ball leaves the hand → the ball crosses the contact
// plane at pitch.tc and carries on into the catcher's mitt. Then either the bat
// meets it → flight (until it comes down, and a beat — a home run's celebration)
// → result; or it doesn't → 'catch' as the mitt takes it, and a strike result
// once no swing can still be on its way. Then the next pitch, the next hitter
// ('switch') or the end ('over'). Takes are strikes: every pitch is in the zone.
//
// A phone's swing message gets here 40–120 ms after the swing's fastest moment
// (its `age`), and the ball the player timed was on screen DISPLAY_LAG after the
// game computed it (an option: TVs differ): the timing error is
// e = (t − age − DISPLAY_LAG) − pitch.tc.
// So a well-timed swing is usually heard about after the ball has gone by on
// screen — often after it's in the mitt: the ball is rewound out of the mitt to
// the contact point, everyone's pose back to that moment, and game time freezes
// for a hitstop (the batter at the contact frame) before it's launched. A swing
// that gets here before the ball reaches the plate is met when it does. CPU
// swings are planned as the ball leaves the hand and shown in sync.

import { DELIVERY, FIELD, SWING } from './field';
import type { BatSwing, BaseballEvent, BattedBall, BatterState, CatcherState, FieldBall, FieldFx, FieldView, Hitter, Pitch, PitchOutcome, PitcherState } from './types';
import {
  AGE_MAX,
  DISPLAY_LAG,
  HITSTOP,
  MITT_Z,
  SWING_OPEN,
  WINDOW,
  batBall,
  pitchAt,
  pitchSpeed,
  planPitch,
  readout,
  releasePoint,
  sample,
  type Batted,
  type FlightSample,
  type RealFlight,
  type PitchPath,
  type V3,
  type WorldFlight,
} from './physics';
import { CpuHitter, choosePitch, usualFlight, type PitchPlan } from './ai';
import { Rng, clamp } from '../core/math';

export { DISPLAY_LAG, WINDOW, AGE_MAX, SWING_OPEN, HITSTOP } from './physics';

export type BaseballState = 'intro' | 'ready' | 'windup' | 'pitch' | 'flight' | 'result' | 'switch' | 'over';

export interface BaseballOptions {
  /** pitches per hitter, default 10 */
  pitches?: number;
  /** 0..1 how tough the pitcher is, default 0.5 */
  pitching?: number;
  /** seeds the pitches (the same seed, the same pitches, whoever's batting), the contact and the CPUs */
  seed?: number;
  /** the pitcher's throwing hand (default right) */
  pitcherHanded?: 1 | -1;
  /** override any of the pacing (BASEBALL_TIMING) */
  timing?: Partial<BaseballTiming>;
  /** how long after the game computes a frame the TV shows it, s (default DISPLAY_LAG; a TV over HDMI can be slower) */
  displayLag?: number;
}

/** How long things take, s (the camera, HUD and animators can read them). */
export const BASEBALL_TIMING = {
  /** the camera flies in */
  intro: 2.5,
  /** before each pitch: the batter settles in, the pitcher gets the sign (at least `set` of it with the ball) */
  ready: 1.2,
  set: 0.3,
  /** the next hitter steps in */
  switch: 2,
  /** a batted ball: the beat after it comes down (a foul's is shorter); a home run's celebration after it comes down */
  beat: 0.7,
  foulBeat: 0.4,
  celebrate: 1.8,
  /** the result on screen: a strike (once it's settled), a batted ball, a home run */
  strikeResult: 0.3,
  hitResult: 0.35,
  hrResult: 0.4,
  /** the pitcher's follow-through after DELIVERY.end */
  follow: 0.6,
  /** the catcher holds a strike this long, then throws it back: it leaves the hand `throwRelease` into
   *  the throw, reaches the pitcher's glove `toss` later; the throw's over at `throwEnd` */
  catchHold: 0.1,
  throwRelease: 0.3,
  toss: 0.7,
  throwEnd: 0.8,
  /** a home run this long (real m), or any struck on the sweet spot, is a no-doubter: the batter celebrates (a bat flip) as soon as the swing's done */
  noDoubt: 132,
  /** a fair ball that comes down short of this (real m) is a dud: the batter hangs his head */
  dud: 100,
};

export type BaseballTiming = typeof BASEBALL_TIMING;

/** Where the hitters waiting their turn stand (by hitter index): off to the sides behind the plate, facing the field. */
export const WAITING_SPOTS = [
  { x: -5.6, z: 13.8 },
  { x: 5.6, z: 13.8 },
  { x: -7.1, z: 15.1 },
  { x: 7.1, z: 15.1 },
];

/** where the ball leaves the catcher's throwing hand and where the pitcher takes it (glove side) */
const TOSS_FROM = { x: 0.25, y: 1.55, z: FIELD.catcherZ - 0.15 };
const TOSS_TO_Y = 1.3;
const TOSS_TO_Z = FIELD.moundZ + 0.45;

type BallMode = 'hand' | 'pitch' | 'mitt' | 'toss' | 'play' | 'gone';

/** a swing waiting to be shown (its animation starts at `at`) and, if it meets the ball, resolved */
interface PlannedSwing {
  at: number;
  e: number;
  power: number;
  lift: number;
  contact: boolean;
  /** fire the 'swing' event when it starts (the CPU's; a person's fired when it got here) */
  announce: boolean;
}

export class BaseballGame {
  state: BaseballState = 'intro';
  /** game time, s (frozen during a hitstop) */
  t = 0;
  /** who's batting (an index into hitters) */
  current = 0;
  /** this turn's pitch, 0-based */
  pitchNo = 0;
  /** the current / last pitch */
  pitch: Pitch | null = null;
  /** the current / last batted ball, and when it was hit (game time: the flight's clock starts there) */
  hit: BattedBall | null = null;
  hitT = 0;
  /** seconds of hitstop left (game time is frozen while it's > 0) */
  hitstop = 0;
  /** each hitter's pitches so far */
  readonly log: { outcome: PitchOutcome; distance: number }[][];
  readonly pitchesPer: number;
  readonly pitching: number;
  readonly pitcherHanded: 1 | -1;
  readonly timing: BaseballTiming;
  /** the display's lag allowed for in judging a person's swing, s, and so how long after tc a swing can still meet the ball */
  readonly displayLag: number;
  readonly swingOpen: number;
  /** the hitter in the box */
  readonly batter: BatterState;
  readonly pitcher: PitcherState;
  readonly catcher: CatcherState;
  onEvent: (e: BaseballEvent) => void = () => {};

  private stateT0 = 0;
  private rngPitch: Rng;
  private rngHit: Rng;
  private cpus: (CpuHitter | null)[];
  /** the flight time a hitter sitting on the usual pitch expects */
  private usual: number;
  /** the next pitch, chosen as the pitcher gets set (the catcher sets up for it) */
  private plan: PitchPlan | null = null;
  private path: PitchPath | null = null;
  private batted: Batted | null = null;
  private flight: WorldFlight | null = null;
  /** this pitch: a swing's been taken; the one waiting to be shown; when the bat meets the ball */
  private swung = false;
  private planned: PlannedSwing | null = null;
  private contactAt = -1;
  private swingNow: { e: number; power: number; lift: number } | null = null;
  /** how this pitch's swing went, for the batter's reaction: none yet, a miss, or a batted ball */
  private swingResult: 'none' | 'miss' | 'hit' = 'none';
  /** in the mitt, and when a pitch in the mitt becomes a strike (no swing can still be on its way) */
  private caught = false;
  private settleAt = Infinity;
  /** the pitcher's delivery and the catcher's catch clocks (moved on by a rewind), and phase starts */
  private windupT0 = 0;
  private catchT0 = 0;
  private batterT0 = 0;
  private pitcherT0 = 0;
  private catcherT0 = 0;
  private setAt = Infinity;
  /** the flight's milestones */
  private fenceDone = false;
  private landDone = false;
  private goneDone = false;
  private flightEndAt = Infinity;
  private resultEndAt = 0;
  /** the ball: where it is (the pitch, the mitt, the toss back, the batted ball…) */
  private ballMode: BallMode = 'hand';
  private tossT0 = -1;
  /** the catcher's throw: 0 not yet, 1 throwing, 2 done */
  private throwStage = 0;
  private tossV = { x: 0, y: 0, z: 0 };
  private tossTo = { x: 0, y: 0, z: 0 };
  private lastBall: V3 = { x: 0, y: 0, z: 0 };
  /** the hitters waiting their turn, and whether they're cheering */
  private waiting: BatterState[];
  private waitT0: number[];
  /** where each character looks (the pitcher, the catcher, the batter, then the hitters), reused frame to frame */
  private looks: V3[];
  private cheerT0 = -1;
  private winners: number[] = [];
  private tracerOn = false;
  private marksNow: { x: number; y: number; z: number }[] = [];
  private tmp: FlightSample = { x: 0, y: 0, z: 0, speed: 0, s: 0 };
  private tmpV: V3 = { x: 0, y: 0, z: 0 };
  /** effects since the last view(), and the array handed out last time (double-buffered) */
  private fxA: FieldFx[] = [];
  private fxB: FieldFx[] = [];
  private out: FieldView;

  constructor(
    readonly hitters: Hitter[],
    opts: BaseballOptions = {},
  ) {
    if (!hitters.length) throw new Error('BaseballGame: nobody to bat');
    this.pitchesPer = Math.max(1, Math.round(opts.pitches ?? 10));
    this.pitching = clamp(opts.pitching ?? 0.5);
    this.pitcherHanded = opts.pitcherHanded ?? 1;
    this.timing = { ...BASEBALL_TIMING, ...opts.timing };
    this.displayLag = clamp(opts.displayLag ?? DISPLAY_LAG, 0, 0.3);
    this.swingOpen = SWING_OPEN - DISPLAY_LAG + this.displayLag;
    const seed = opts.seed ?? (Math.random() * 2 ** 31) | 0;
    this.rngPitch = new Rng(seed ^ 0x2545f491);
    this.rngHit = new Rng(seed ^ 0x6c8e9cf5);
    this.cpus = hitters.map((h, i) => (h.cpu !== null ? new CpuHitter(h.cpu, seed + 7919 * (i + 1)) : null));
    this.usual = usualFlight(this.pitching);
    this.log = hitters.map(() => []);
    const h0 = hitters[0];
    this.batter = {
      x: -h0.handed * FIELD.boxX,
      z: FIELD.homeZ - 0.2,
      handed: h0.handed,
      phase: 'stance',
      t: 0,
      lift: 0,
      power: 0,
      aimX: 0,
      aimY: 0.84,
      yaw: 0,
      look: null,
    };
    this.pitcher = { x: 0, z: FIELD.moundZ, handed: this.pitcherHanded, phase: 'idle', t: 0, kind: null, look: null };
    this.catcher = { x: 0, z: FIELD.catcherZ, phase: 'crouch', t: 0, targetX: 0, targetY: 0.8, arrive: 0.6, look: null };
    this.waiting = hitters.map((h, i) => {
      const s = WAITING_SPOTS[i % WAITING_SPOTS.length];
      return {
        x: s.x,
        z: s.z,
        handed: h.handed,
        phase: 'idle',
        t: 0,
        lift: 0,
        power: 0,
        aimX: 0,
        aimY: 0,
        // facing the field (a little towards the middle of it)
        yaw: Math.atan2(-(0 - s.x), -(2 - s.z)),
        look: null,
      };
    });
    this.waitT0 = hitters.map(() => 0);
    this.looks = [0, 0, 0, ...hitters].map(() => ({ x: 0, y: 0, z: 0 }));
    this.tossTo.x = 0.3 * this.pitcherHanded;
    this.tossTo.y = TOSS_TO_Y;
    this.tossTo.z = TOSS_TO_Z;
    this.out = {
      ball: { x: 0, y: 0, z: 0, phase: 'hand', speed: 0 },
      tracer: false,
      color: h0.color,
      marks: this.marksNow,
      eye: { x: 0, y: 0, z: 0 },
      fx: this.fxB,
    };
    this.pose();
  }

  // ------------------------------------------------------------ read-outs

  /** seconds in this state (game time) */
  get since() {
    return this.t - this.stateT0;
  }

  homeRuns(i: number) {
    let n = 0;
    for (const p of this.log[i] ?? []) if (p.outcome === 'homerun') n++;
    return n;
  }

  /** the longest home run, real m (0 if none) */
  longest(i: number) {
    let m = 0;
    for (const p of this.log[i] ?? []) if (p.outcome === 'homerun' && p.distance > m) m = p.distance;
    return m;
  }

  /** summed home-run distance, real m (the tie-break) */
  total(i: number) {
    let s = 0;
    for (const p of this.log[i] ?? []) if (p.outcome === 'homerun') s += p.distance;
    return s;
  }

  /** the longest fair ball, home run or not, real m */
  longestHit(i: number) {
    let m = 0;
    for (const p of this.log[i] ?? []) if ((p.outcome === 'homerun' || p.outcome === 'hit') && p.distance > m) m = p.distance;
    return m;
  }

  /** hitter indices, best first: most home runs, then the most home-run distance, then the longest, then batting order */
  ranking() {
    return this.hitters.map((_, i) => i).sort((p, q) => this.homeRuns(q) - this.homeRuns(p) || this.total(q) - this.total(p) || this.longest(q) - this.longest(p) || p - q);
  }

  /** hitter i: the one in the box is `batter`; the others wait off to the side */
  hitterState(i: number): BatterState {
    return i === this.current ? this.batter : this.waiting[i];
  }

  /** the batted ball's world flight (for a camera that wants to look ahead), or null */
  get battedFlight(): WorldFlight | null {
    return this.flight;
  }

  /** the batted ball's real flight (real metres and seconds: its distance, hang and apex), or null */
  get battedReal(): RealFlight | null {
    return this.batted?.real ?? null;
  }

  /** where the batted ball is `ft` s into its flight (0 = off the bat), world */
  flightAt(ft: number, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
    if (!this.flight) return out;
    const s = sample(this.flight, ft, this.tmp);
    out.x = s.x;
    out.y = s.y;
    out.z = s.z;
    return out;
  }

  /** During 'flight': how far the ball has gone so far, real metres along the ground — it rises
   *  steadily, reads the fence's number as the ball passes the fence and comes to rest on
   *  hit.distance as it comes down. Afterwards (the result) it's the distance; else 0. */
  liveDistance() {
    const h = this.hit;
    const f = this.flight;
    if (!h || !f) return 0;
    if (this.state === 'flight') {
      const ft = this.t - this.hitT;
      if (ft <= 0) return 0;
      if (ft >= f.T) return h.distance;
      return Math.min(h.distance, readout(f, h.distance, sample(f, ft, this.tmp).s));
    }
    return this.state === 'result' && this.swingResult === 'hit' ? h.distance : 0;
  }

  /** What the field draws this frame. Effects are handed out once (the array is reused after the next call). */
  view(eye: { x: number; y: number; z: number }): FieldView {
    const v = this.out;
    this.ballView(v.ball);
    v.tracer = this.tracerOn;
    v.color = this.hitters[this.current].color;
    v.marks = this.marksNow;
    v.eye.x = eye.x;
    v.eye.y = eye.y;
    v.eye.z = eye.z;
    v.fx = this.fxA;
    this.fxA = this.fxB;
    this.fxB = v.fx;
    this.fxA.length = 0;
    return v;
  }

  // ------------------------------------------------------------ input

  /**
   * A person's swing (from the phone, the mouse or the keyboard). Ignored unless
   * it's theirs to take and a pitch is on its way (or just by). `since`: seconds
   * since the last step() (the message came in between frames), if known.
   */
  swing(slot: number, s: BatSwing, since = 0) {
    if (this.state === 'intro') {
      if (this.hitters.some((h) => h.cpu === null && h.slot === slot)) this.skip();
      return;
    }
    const who = this.current;
    const h = this.hitters[who];
    const p = this.pitch;
    if (h.cpu !== null || h.slot !== slot || this.state !== 'pitch' || !p || this.swung || this.hitstop > 0) return;
    const now = this.t + clamp(Number.isFinite(since) ? since : 0, 0, 0.1);
    const age = clamp(Number.isFinite(s.age) ? s.age : 0, 0, AGE_MAX);
    // when the swing peaked, and what the player saw then
    const seen = now - age - this.displayLag;
    // (swung before the ball was even out of the hand, as it looked: not at this pitch)
    if (seen < p.t0) return;
    const e = seen - p.tc;
    const power = clamp(Number.isFinite(s.power) ? s.power : 0.5);
    const lift = clamp(Number.isFinite(s.lift) ? s.lift : 0, -1, 1);
    const contact = Math.abs(e) <= WINDOW.contact;
    this.swung = true;
    if (!contact) {
      // a miss: the whole swing, from now; a strike as soon as the ball's in the mitt
      this.planned = null;
      this.startSwing(this.t, power, lift);
      this.swingResult = 'miss';
      this.settleAt = this.t;
      this.emit({ type: 'swing', who, timing: e, contact, power });
      this.tick();
    } else if (this.t < p.tc) {
      // here before the ball reached the plate: the bat meets it when it gets there (the swing's
      // shown from SWING.contact before that — already under way if that's passed)
      this.planned = { at: p.tc - SWING.contact, e, power, lift, contact: true, announce: false };
      this.contactAt = p.tc;
      this.swingNow = { e, power, lift };
      this.settleAt = Infinity;
      if (this.planned.at <= this.t) this.startPlanned();
      this.emit({ type: 'swing', who, timing: e, contact, power });
    } else {
      // the usual case: the ball's gone by on screen — back to the moment the bat met it
      this.emit({ type: 'swing', who, timing: e, contact, power });
      this.contact(e, power, lift, p.tc + e);
    }
    this.pose();
  }

  /** skip ahead: the intro, the next hitter stepping in, the celebration once the ball's down, a result on screen */
  skip() {
    if (this.state === 'intro') {
      this.startTurn(0);
      this.toReady();
    } else if (this.state === 'switch') this.toReady();
    else if (this.state === 'flight' && this.landDone) this.endFlight();
    else if (this.state === 'result') this.next();
    this.pose();
  }

  // ------------------------------------------------------------ simulation

  step(dt: number) {
    if (!(dt > 0)) return;
    let left = dt;
    for (let guard = 0; left > 1e-12 && guard < 256; guard++) {
      if (this.hitstop > 0) {
        // game time stands still; the frame's time goes into the hitstop
        const use = Math.min(left, this.hitstop);
        this.hitstop -= use;
        left -= use;
        if (this.hitstop > 1e-9) break;
        this.hitstop = 0;
        this.launch();
        continue;
      }
      const h = Math.min(left, this.untilNext());
      this.t += h;
      left -= h;
      this.tick();
    }
    this.pose();
  }

  /** seconds to the next thing that has to happen at an exact time */
  private untilNext() {
    let n = Infinity;
    const t = this.t + 1e-9;
    const c = (x: number) => {
      if (x > t && x < n) n = x;
    };
    const TM = this.timing;
    if (this.tossT0 >= 0) {
      c(this.tossT0);
      c(this.tossT0 + TM.throwRelease);
      c(this.tossT0 + TM.throwRelease + TM.toss);
      c(this.tossT0 + TM.throwEnd);
    }
    switch (this.state) {
      case 'intro':
        c(this.stateT0 + TM.intro);
        break;
      case 'switch':
        c(this.stateT0 + TM.switch);
        break;
      case 'ready':
        c(this.stateT0 + TM.ready);
        c(this.setAt + TM.set);
        break;
      case 'windup':
        c(this.windupT0 + DELIVERY.release);
        break;
      case 'pitch': {
        const p = this.pitch!;
        if (this.planned) c(this.planned.at);
        if (this.contactAt >= 0) c(this.contactAt);
        c(p.t0 + this.path!.arrive);
        c(this.settleAt);
        c(this.batterT0 + SWING.end);
        break;
      }
      case 'flight': {
        const f = this.flight!;
        if (f.fenceT >= 0) c(this.hitT + f.fenceT);
        c(this.hitT + f.T);
        c(this.hitT + f.goneT);
        c(this.flightEndAt);
        c(this.batterT0 + SWING.end);
        break;
      }
      case 'result':
        c(this.resultEndAt);
        c(this.batterT0 + SWING.end);
        break;
    }
    c(this.windupT0 + DELIVERY.end);
    return n - this.t;
  }

  /** everything that's due now */
  private tick() {
    for (let guard = 0; guard < 32; guard++) if (!this.due()) break;
  }

  /** do the next thing that's due now; false if nothing is */
  private due(): boolean {
    const t = this.t + 1e-9;
    const TM = this.timing;
    // the catcher throwing a strike back (across states: it's in the pitcher's glove before the next windup)
    if (this.tossT0 >= 0) {
      const t0 = this.tossT0;
      if (this.throwStage === 0 && t >= t0) {
        this.throwStage = 1;
        this.setCatcher('throw', t0);
        return true;
      }
      if (this.ballMode === 'mitt' && t >= t0 + TM.throwRelease) {
        this.ballMode = 'toss';
        return true;
      }
      if (this.ballMode === 'toss' && t >= t0 + TM.throwRelease + TM.toss) {
        this.ballMode = 'hand';
        return true;
      }
      if (this.throwStage === 1 && t >= t0 + TM.throwEnd) {
        this.throwStage = 2;
        if (this.catcher.phase === 'throw') this.setCatcher('crouch', t0 + TM.throwEnd);
        return true;
      }
      if (this.throwStage === 2 && this.ballMode !== 'mitt' && this.ballMode !== 'toss') {
        this.tossT0 = -1;
        return true;
      }
    }
    // the swing's over: how the batter takes it
    if (this.batter.phase === 'swing' && t >= this.batterT0 + SWING.end) {
      this.setBatter(this.reaction(), this.batterT0 + SWING.end);
      return true;
    }
    switch (this.state) {
      case 'intro':
        if (t < this.stateT0 + TM.intro) return false;
        this.startTurn(0);
        this.toReady();
        return true;
      case 'switch':
        if (t < this.stateT0 + TM.switch) return false;
        this.toReady();
        return true;
      case 'ready':
        if (this.pitcher.phase !== 'set' && this.ballMode === 'hand') {
          this.setAt = this.t;
          this.setPitcher('set', this.t);
          return true;
        }
        if (this.pitcher.phase === 'set' && t >= this.stateT0 + TM.ready && t >= this.setAt + TM.set) {
          this.toWindup();
          return true;
        }
        return false;
      case 'windup':
        if (t < this.windupT0 + DELIVERY.release) return false;
        this.release();
        return true;
      case 'pitch':
        return this.duePitch(t);
      case 'flight':
        return this.dueFlight(t);
      case 'result':
        if (t < this.resultEndAt) return false;
        this.next();
        return true;
    }
    return false;
  }

  private duePitch(t: number) {
    const p = this.pitch!;
    const path = this.path!;
    if (this.planned && t >= this.planned.at) {
      this.startPlanned();
      return true;
    }
    if (this.contactAt >= 0 && t >= this.contactAt) {
      const s = this.swingNow!;
      this.contactAt = -1;
      // (on time: the moment's now, nothing to rewind)
      this.contact(s.e, s.power, s.lift, this.t);
      return true;
    }
    if (!this.caught && this.contactAt < 0 && t >= p.t0 + path.arrive) {
      // into the mitt (a late swing can still take it back out)
      this.caught = true;
      this.ballMode = 'mitt';
      this.fx({ type: 'catch', x: path.mittX, y: path.mittY, z: MITT_Z });
      this.emit({ type: 'catch', strike: p.strike });
      return true;
    }
    if (this.caught && t >= this.settleAt) {
      this.strikeSettled();
      return true;
    }
    return false;
  }

  private dueFlight(t: number) {
    const f = this.flight!;
    const h = this.hit!;
    const ft = t - this.hitT;
    if (!this.fenceDone && f.fenceT >= 0 && ft >= f.fenceT) {
      this.fenceDone = true;
      this.fx({ type: 'homerun', x: f.fenceX, y: f.fenceY, z: f.fenceZ });
      this.cheer(this.hitT + f.fenceT);
      if (this.batter.phase === 'watch') this.setBatter('cheer', this.hitT + f.fenceT);
      return true;
    }
    if (!this.landDone && ft >= f.T) {
      this.landDone = true;
      const at = this.hitT + f.T;
      const TM = this.timing;
      this.fx(h.wall ? { type: 'wall', x: f.landX, y: f.landY, z: f.landZ } : { type: 'land', x: f.landX, y: f.landY, z: f.landZ, homeRun: h.homeRun });
      if (h.homeRun) {
        this.marksNow.push({ x: f.landX, y: f.landY, z: f.landZ });
        if (!this.fenceDone) {
          this.fenceDone = true;
          this.fx({ type: 'homerun', x: f.landX, y: f.landY, z: f.landZ });
          this.cheer(at);
        }
      }
      if (this.batter.phase === 'watch' || (h.homeRun && this.batter.phase !== 'cheer' && this.batter.phase !== 'swing')) {
        const r = this.verdict();
        if (r !== this.batter.phase) this.setBatter(r, at);
      }
      this.flightEndAt = at + (h.homeRun ? TM.celebrate : h.foul ? TM.foulBeat : TM.beat);
      this.emit({ type: 'land', who: this.current, ball: h });
      return true;
    }
    if (!this.goneDone && ft >= f.goneT) {
      this.goneDone = true;
      this.ballMode = 'gone';
      return true;
    }
    if (this.landDone && t >= this.flightEndAt) {
      this.endFlight();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ the pitch

  private toReady() {
    this.setState('ready');
    const who = this.hitters[this.current];
    // a fresh ball if the last one's in play or gone (a strike comes back from the catcher)
    if (this.ballMode === 'play' || this.ballMode === 'gone') this.ballMode = 'hand';
    this.plan = choosePitch(this.pitching, this.rngPitch, this.pitcherHanded);
    const aim = planPitch(this.plan.kind, this.plan.speed, this.plan.px, this.plan.py, this.pitcherHanded, 0).path;
    const c = this.catcher;
    c.targetX = aim.mittX;
    c.targetY = aim.mittY;
    c.arrive = aim.arrive;
    if (c.phase !== 'throw') this.setCatcher('crouch', this.t);
    this.batter.handed = who.handed;
    this.batter.aimX = this.plan.px;
    this.batter.aimY = this.plan.py;
    this.setBatter('stance', this.t);
    this.pitcher.kind = this.plan.kind;
    this.setAt = Infinity;
    if (this.ballMode === 'hand') {
      this.setAt = this.t;
      this.setPitcher('set', this.t);
    } else this.setPitcher('idle', this.t);
    this.swingResult = 'none';
    this.cheerT0 = -1;
  }

  private toWindup() {
    this.setState('windup');
    this.windupT0 = this.t;
    this.setPitcher('windup', this.t);
    this.emit({ type: 'windup', kind: this.plan!.kind });
  }

  /** the ball leaves the hand */
  private release() {
    const pl = this.plan!;
    const who = this.current;
    const { pitch, path } = planPitch(pl.kind, pl.speed, pl.px, pl.py, this.pitcherHanded, this.windupT0 + DELIVERY.release);
    this.pitch = pitch;
    this.path = path;
    this.setState('pitch');
    this.ballMode = 'pitch';
    this.caught = false;
    this.swung = false;
    this.planned = null;
    this.contactAt = -1;
    this.swingNow = null;
    this.swingResult = 'none';
    // the last batted ball's tracer goes as the next pitch leaves the hand
    this.tracerOn = false;
    const c = this.catcher;
    c.targetX = path.mittX;
    c.targetY = path.mittY;
    c.arrive = path.arrive;
    this.catchT0 = pitch.t0;
    this.setCatcher('catch', pitch.t0);
    this.batter.aimX = pitch.px;
    this.batter.aimY = pitch.py;
    this.setBatter('load', pitch.t0);
    const cpu = this.cpus[who];
    if (cpu) {
      // read out of the hand: the swing's decided now, and started so the bat's there at tc + e
      const s = cpu.plan(pitch.tc - pitch.t0, this.usual);
      const contact = Math.abs(s.e) <= WINDOW.contact;
      this.planned = { at: pitch.tc + s.e - SWING.contact, e: s.e, power: s.power, lift: s.lift, contact, announce: true };
      this.swung = true;
      if (contact) {
        this.contactAt = pitch.tc + s.e;
        this.swingNow = { e: s.e, power: s.power, lift: s.lift };
        this.settleAt = Infinity;
      } else this.settleAt = pitch.t0 + path.arrive;
    } else this.settleAt = pitch.tc + this.swingOpen;
    this.emit({ type: 'pitch', pitch });
  }

  /** a planned swing's animation starts (the CPU's announces itself) */
  private startPlanned() {
    const s = this.planned!;
    this.planned = null;
    this.startSwing(s.at, s.power, s.lift);
    if (s.announce) {
      this.emit({ type: 'swing', who: this.current, timing: s.e, contact: s.contact, power: s.power });
      if (!s.contact) this.swingResult = 'miss';
    }
  }

  private startSwing(at: number, power: number, lift: number) {
    const b = this.batter;
    b.power = power;
    b.lift = lift;
    this.setBatter('swing', at);
  }

  /**
   * The bat meets the ball. `moment` is when it did, as shown (a late message: before
   * now) — the pitcher's and catcher's poses go back to it. The ball's at the contact
   * point, the batter at the contact frame, and game time freezes for the hitstop.
   */
  private contact(e: number, power: number, lift: number, moment: number) {
    const who = this.current;
    const h = this.hitters[who];
    const b = batBall(e, power, lift, this.pitch!, h.handed, this.rngHit);
    this.batted = b;
    this.hit = b.ball;
    this.flight = b.flight;
    this.hitT = this.t;
    this.planned = null;
    this.contactAt = -1;
    this.settleAt = Infinity;
    this.swingResult = 'hit';
    this.ballMode = 'play';
    this.caught = false;
    const bs = this.batter;
    bs.power = power;
    bs.lift = lift;
    this.setBatter('swing', this.t - SWING.contact);
    // everyone back to the moment the bat met it (a late message: the pitcher's delivery and
    // the catcher's reach go back with the ball)
    const shift = Math.max(0, this.t - moment);
    if (shift > 0) {
      this.windupT0 += shift;
      this.catchT0 += shift;
      const P = this.pitcher.phase;
      if (P === 'windup' || P === 'follow' || P === 'idle') {
        if (this.t < this.windupT0 + DELIVERY.end) this.setPitcher('windup', this.windupT0);
        else if (this.t < this.windupT0 + DELIVERY.end + this.timing.follow) this.setPitcher('follow', this.windupT0 + DELIVERY.end);
      }
      if (this.catcher.phase === 'catch') this.catcherT0 = this.catchT0;
    }
    this.setState('flight');
    this.fenceDone = this.landDone = this.goneDone = false;
    this.flightEndAt = Infinity;
    this.tracerOn = true;
    this.hitstop = b.ball.sweet ? HITSTOP.sweet : HITSTOP.hit;
    const f = b.flight;
    this.fx({ type: 'contact', x: f.x0, y: f.y0, z: f.z0, power, sweet: b.ball.sweet });
    this.emit({ type: 'contact', who, ball: b.ball });
  }

  /** the hitstop's over: the ball's away */
  private launch() {
    this.setCatcher('watch', this.t);
    if (this.t >= this.windupT0 + DELIVERY.end) this.setPitcher('watch', this.t);
  }

  /** nothing met the ball and no swing can still be on its way: a strike */
  private strikeSettled() {
    const TM = this.timing;
    this.settleAt = Infinity;
    if (this.batter.phase === 'load') this.setBatter('sad', this.t);
    // the catcher throws it back
    this.tossT0 = this.t + TM.catchHold;
    this.throwStage = 0;
    const tt = TM.toss;
    this.tossV.x = (this.tossTo.x - TOSS_FROM.x) / tt;
    this.tossV.y = (this.tossTo.y - TOSS_FROM.y + 0.5 * FIELD.gravity * tt * tt) / tt;
    this.tossV.z = (this.tossTo.z - TOSS_FROM.z) / tt;
    this.record('strike', 0, TM.strikeResult);
  }

  private endFlight() {
    const h = this.hit!;
    const TM = this.timing;
    if (!this.goneDone && (this.flight!.end !== 'field' && this.flight!.end !== 'wall')) {
      this.goneDone = true;
      this.ballMode = 'gone';
    }
    this.record(h.homeRun ? 'homerun' : h.foul ? 'foul' : 'hit', h.distance, h.homeRun ? TM.hrResult : TM.hitResult);
  }

  /** the pitch's over: log it, say so, and show it for `dur` */
  private record(outcome: PitchOutcome, distance: number, dur: number) {
    const who = this.current;
    this.log[who].push({ outcome, distance });
    this.setState('result');
    this.resultEndAt = this.t + dur;
    this.emit({ type: 'result', who, outcome, distance, homeRuns: this.homeRuns(who), pitchesLeft: this.pitchesPer - this.log[who].length });
  }

  /** after a result: the next pitch, the next hitter, or the end */
  private next() {
    this.pitchNo++;
    this.cheerT0 = -1;
    if (this.pitchNo < this.pitchesPer) this.toReady();
    else if (this.current < this.hitters.length - 1) {
      this.setState('switch');
      this.startTurn(this.current + 1);
    } else this.finish();
  }

  /** hitter i steps in */
  private startTurn(i: number) {
    this.current = i;
    this.pitchNo = 0;
    this.marksNow.length = 0;
    this.tracerOn = false;
    this.swingResult = 'none';
    const h = this.hitters[i];
    const b = this.batter;
    b.handed = h.handed;
    b.x = -h.handed * FIELD.boxX;
    b.z = FIELD.homeZ - 0.2;
    b.power = 0;
    b.lift = 0;
    b.yaw = 0;
    this.setBatter('stance', this.t);
    this.setPitcher('idle', this.t);
    this.pitcher.kind = null;
    if (this.catcher.phase !== 'throw') this.setCatcher('crouch', this.t);
    if (this.ballMode === 'play' || this.ballMode === 'gone') this.ballMode = 'hand';
    this.emit({ type: 'turn', who: i, pitches: this.pitchesPer });
  }

  private finish() {
    this.setState('over');
    const ranking = this.ranking();
    const top = ranking[0];
    this.winners = ranking.filter((i) => this.homeRuns(i) === this.homeRuns(top) && this.total(i) === this.total(top));
    this.setPitcher('idle', this.t);
    this.pitcher.kind = null;
    this.setBatter(this.winners.includes(this.current) ? 'cheer' : 'idle', this.t);
    this.cheerT0 = this.t;
    this.emit({ type: 'over', ranking });
  }

  // ------------------------------------------------------------ the characters

  /** how the batter takes it once the swing's done */
  private reaction(): BatterState['phase'] {
    if (this.swingResult === 'miss') return 'sad';
    if (this.swingResult !== 'hit' || !this.hit) return 'watch';
    const h = this.hit;
    // a no-doubter: the bat flip, right away
    if (h.homeRun && (h.distance >= this.timing.noDoubt || h.sweet)) return 'cheer';
    return this.landDone || this.fenceDone ? this.verdict() : 'watch';
  }

  /** once it's clear where it went */
  private verdict(): BatterState['phase'] {
    const h = this.hit;
    if (!h) return 'watch';
    if (h.homeRun) return 'cheer';
    if (h.foul || h.distance < this.timing.dud) return 'sad';
    return 'watch';
  }

  /** the hitters waiting their turn cheer a home run */
  private cheer(at: number) {
    if (this.cheerT0 < 0) this.cheerT0 = at;
  }

  private setBatter(phase: BatterState['phase'], at: number) {
    this.batter.phase = phase;
    this.batterT0 = at;
  }

  private setPitcher(phase: PitcherState['phase'], at: number) {
    this.pitcher.phase = phase;
    this.pitcherT0 = at;
  }

  private setCatcher(phase: CatcherState['phase'], at: number) {
    this.catcher.phase = phase;
    this.catcherT0 = at;
  }

  /** bring every character's state up to date */
  private pose() {
    const t = this.t;
    const TM = this.timing;
    const ball = this.ballPos(this.tmpV);
    const inPlay = this.ballMode === 'play' || this.ballMode === 'pitch';
    // the pitcher: the delivery (its clock moved by a rewind), the follow-through, then watching or idling
    const P = this.pitcher;
    if (P.phase === 'windup' && t >= this.windupT0 + DELIVERY.end && this.hitstop <= 0) this.setPitcher('follow', this.windupT0 + DELIVERY.end);
    if (P.phase === 'follow' && this.hitstop <= 0) {
      if (this.state === 'flight' && this.ballMode !== 'hand') this.setPitcher('watch', Math.max(this.pitcherT0, this.hitT));
      else if (t >= this.pitcherT0 + TM.follow) this.setPitcher('idle', this.pitcherT0 + TM.follow);
    }
    P.t = P.phase === 'windup' ? Math.max(0, t - this.windupT0) : Math.max(0, t - this.pitcherT0);
    P.look = P.phase === 'watch' ? this.lookAt(this.looks[0], ball) : null;
    // the catcher
    const C = this.catcher;
    C.t = C.phase === 'catch' ? Math.max(0, t - this.catchT0) : Math.max(0, t - this.catcherT0);
    C.look = C.phase === 'watch' ? this.lookAt(this.looks[1], ball) : null;
    // the batter
    const B = this.batter;
    B.t = Math.max(0, t - this.batterT0);
    B.look = B.phase === 'stance' || B.phase === 'load' || B.phase === 'watch' || (B.phase === 'cheer' && this.ballMode === 'play') ? this.lookAt(this.looks[2], ball) : null;
    // the hitters waiting their turn
    for (let i = 0; i < this.waiting.length; i++) {
      if (i === this.current) continue;
      const w = this.waiting[i];
      const cheering = this.state === 'over' ? this.winners.includes(i) : this.cheerT0 >= 0 && t >= this.cheerT0 && (this.state === 'flight' || this.state === 'result');
      const phase = cheering ? 'cheer' : 'idle';
      if (w.phase !== phase) {
        w.phase = phase;
        this.waitT0[i] = cheering && this.state !== 'over' ? this.cheerT0 : t;
      }
      w.t = Math.max(0, t - this.waitT0[i]);
      w.look = inPlay ? this.lookAt(this.looks[3 + i], ball) : null;
    }
  }

  private lookAt(out: V3, p: V3) {
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    return out;
  }

  // ------------------------------------------------------------ the ball

  private ballPos(out: V3): V3 {
    const t = this.t;
    switch (this.ballMode) {
      case 'hand': {
        const r = releasePoint(this.pitcherHanded);
        out.x = r.x;
        out.y = r.y;
        out.z = r.z;
        break;
      }
      case 'pitch':
        pitchAt(this.path!, Math.min(t - this.pitch!.t0, this.path!.arrive), out);
        break;
      case 'mitt':
        out.x = this.path!.mittX;
        out.y = this.path!.mittY;
        out.z = MITT_Z;
        break;
      case 'toss': {
        const tau = clamp(t - this.tossT0 - this.timing.throwRelease, 0, this.timing.toss);
        out.x = TOSS_FROM.x + this.tossV.x * tau;
        out.y = TOSS_FROM.y + this.tossV.y * tau - 0.5 * FIELD.gravity * tau * tau;
        out.z = TOSS_FROM.z + this.tossV.z * tau;
        break;
      }
      case 'play': {
        const s = sample(this.flight!, t - this.hitT, this.tmp);
        out.x = s.x;
        out.y = s.y;
        out.z = s.z;
        break;
      }
      case 'gone':
        out.x = this.lastBall.x;
        out.y = this.lastBall.y;
        out.z = this.lastBall.z;
        return out;
    }
    this.lastBall.x = out.x;
    this.lastBall.y = out.y;
    this.lastBall.z = out.z;
    return out;
  }

  private ballView(b: FieldBall) {
    this.ballPos(b);
    const t = this.t;
    switch (this.ballMode) {
      case 'hand':
        b.phase = 'hand';
        b.speed = 0;
        break;
      case 'pitch':
        b.phase = 'pitch';
        b.speed = pitchSpeed(this.path!, t - this.pitch!.t0);
        break;
      case 'mitt':
        b.phase = 'mitt';
        b.speed = 0;
        break;
      case 'toss': {
        // (a thrown ball, like a pitch)
        const tau = clamp(t - this.tossT0 - this.timing.throwRelease, 0, this.timing.toss);
        b.phase = 'pitch';
        b.speed = Math.hypot(this.tossV.x, this.tossV.y - FIELD.gravity * tau, this.tossV.z);
        break;
      }
      case 'play':
        b.phase = 'play';
        b.speed = this.hitstop > 0 ? 0 : sample(this.flight!, t - this.hitT, this.tmp).speed;
        break;
      case 'gone':
        b.phase = 'gone';
        b.speed = 0;
        break;
    }
  }

  // ------------------------------------------------------------ plumbing

  private setState(s: BaseballState) {
    this.state = s;
    this.stateT0 = this.t;
  }

  private emit(e: BaseballEvent) {
    // (everyone's pose up to date for whoever's listening)
    this.pose();
    this.onEvent(e);
  }

  private fx(e: FieldFx) {
    // (nobody reading them — a headless sim — mustn't grow this forever)
    if (this.fxA.length < 32) this.fxA.push(e);
  }
}
