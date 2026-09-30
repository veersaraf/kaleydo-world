// The rules engine and point flow for a tennis match.

import { COURT, netHeightAt, sideOf, inCourt, serviceBox, inBox, serveSideSign, fwdOf } from './court';
import { type Seg, segPos, segVel, segTimeDown, segTimeAtZ, bounceSeg, predictPath, segApexY, PathBuf } from './ball';
import { buildShot, humanShot, serveShot, type Stroke, type SwingInput } from './shot';
import { TPlayer, type Ctrl, type HitPlan, type AthleticMove, type SwingState } from './player';
import { aiShot, recoveryPos, AI_LEVELS } from './ai';
import { Score } from './score';
import type { Look } from '../chars/look';
import { clamp, lerp, Rng, smooth, type V3 } from '../core/math';
import { hyp2, hyp3 } from './hypot';

export type MatchState = 'intro' | 'serve' | 'toss' | 'play' | 'dead' | 'reset' | 'over';

export interface PlayerSpec {
  team: 0 | 1;
  name: string;
  look: Look;
  handed: 1 | -1;
  ctrl: Ctrl;
}

export interface MatchConfig {
  doubles: boolean;
  gamesToWin: number;
  players: PlayerSpec[];
  attract?: boolean;
  /** Swing Lab: team 1 is a ball machine that always serves; nobody wins */
  practice?: boolean;
  firstServer?: 0 | 1;
  seed?: number;
  /** world rule tweaks */
  gravityScale?: number;
  teamNames?: [string, string];
  introTime?: number;
  /** widens the human swing window (assist) */
  timingScale?: number;
}

export interface SwingIn {
  power: number;
  spin: number;
  side?: 'fh' | 'bh' | 'oh';
  path?: number | null;
}

export type PointReason = 'ace' | 'winner' | 'out' | 'net' | 'double' | 'unreturned' | 'wide' | 'long';

export type MatchEvent =
  | {
      type: 'hit';
      p: TPlayer;
      power: number;
      spin: number;
      perfect: boolean;
      kind: string;
      stroke: Stroke;
      pos: V3;
      kph: number;
      rally: number;
      tau: number;
      serve: boolean;
      /** ms early (−) or late (+) versus the ideal contact moment */
      dtMs?: number;
      aim?: number;
      crossed?: boolean;
      /** spin actually put on the ball (−1 slice … +1 topspin) */
      shotSpin: number;
      /** a serve struck right at the top of the toss */
      rocket?: boolean;
    }
  | { type: 'whiff'; p: TPlayer; tau: number; dtMs?: number; why?: 'early' | 'late' | 'reach' | 'noball' }
  | { type: 'toss'; p: TPlayer }
  /** a lunge, flying dive or jump for a ball at the edge of reach */
  | { type: 'athletic'; p: TPlayer; move: AthleticMove }
  /** a diving player hits the court */
  | { type: 'land'; p: TPlayer; pos: V3 }
  /** a player has run out of legs (slower, wobbly returns) */
  | { type: 'tired'; p: TPlayer }
  /** a sitter is floating to a player: smash it! */
  | { type: 'smash-chance'; p: TPlayer }
  | { type: 'catch'; p: TPlayer }
  | { type: 'bounce'; pos: V3; impact: number; live: boolean; out: boolean; first: boolean }
  | { type: 'net'; pos: V3; cord: boolean; over: boolean }
  | { type: 'let' }
  | { type: 'fault'; double: boolean; reason: 'net' | 'out' }
  | {
      type: 'point';
      winner: 0 | 1;
      reason: PointReason;
      rally: number;
      call: string;
      gameWon: boolean;
      matchWon: boolean;
      lastHitter: TPlayer | null;
    }
  | { type: 'serve-ready'; p: TPlayer; second: boolean }
  | { type: 'state'; state: MatchState }
  | { type: 'close-call'; pos: V3 };

export interface BallInfo {
  seg: Seg;
  /** player holding the ball (before serving) */
  holder: TPlayer | null;
  lastHitTeam: 0 | 1;
  lastHitter: TPlayer | null;
  bounces: [number, number];
  serve: boolean;
  letPending: boolean;
  netted: boolean;
  live: boolean;
  nextBounce: number | null;
  netCrossT: number | null;
  visible: boolean;
  /** this flight is a floater: whoever meets it can smash it */
  pop: boolean;
  /** this flight is a smash (2: a perfect one) */
  smash: 0 | 1 | 2;
}

const WIN_EARLY = 0.2;
const WIN_LATE = 0.15;
const SERVE_WIN = 0.26;
const TOSS_IDEAL = 0.78;
/** a smash chance's swing window: forgiving (a floater is slow to come down) */
const SMASH_EARLY = 0.3;
const SMASH_LATE = 0.24;

/** the wind-up a stroke drawn from the past is given: the racket comes back this long before contact */
const SWING_WINDUP = 0.12;
/**
 * A stroke started on a phone's swing ONSET (humanSwingStart), before the swing is heard: its wind-up runs at least
 * MIN_WINDUP and at most MAX_WINDUP from the onset (a ball far off doesn't make a slow-motion stroke), with no swing
 * heard FEINT_AFTER after its contact it turns into a feint that eases back to the ready stance over FEINT_EASE, and
 * a second onset RESTART after the first one's starts a new stroke (the first was a wobble that died).
 */
const MIN_WINDUP = 0.1;
const MAX_WINDUP = 0.3;
const FEINT_AFTER = 0.25;
const FEINT_EASE = 0.2;
const RESTART = 0.15;
/**
 * A human who takes a ball on their swing's onset (poach) holds it for the swing to be heard: none by POACH_WAIT
 * after the onset (a twitch, not a swing) and the ball goes back to the partner it was taken from. A heard swing
 * that takes a ball looks for one within POACH_HEARD_SPREAD s of the swing, that the player could have got to in POACH_HEARD_RUN s.
 */
const POACH_WAIT = 0.22;
const POACH_HEARD_SPREAD = 0.12;
/** an onset's ball may be this far (m) out of the player's running reach: they are on their feet at the net, and the lunge makes it up (maybeAthletic) */
const POACH_STRETCH = 1.2;
/** an onset's ball is taken no sooner than this (s) from now: the drawn ball is held from now, at the ball point this close */
const POACH_SOON = 0.01;
/** an onset's ball is taken within this many s of when its swing is expected to land (onset + 0.1): inside the judgement's window with room to spare */
const POACH_SPREAD = 0.12;
const POACH_HEARD_RUN = 0.15;
/** the furthest back in time a heard swing is put (the input clamps an age at 0.25 s; a hitch's slip may add a little) */
const SWING_BACK_MAX = 0.4;
/**
 * The drawn ball waits for a phone's swing. A swing message arrives `age` after the swing was made
 * (the phone's confirm, the network, a frame: 50–100 ms locally, more online), so the ball that
 * flew on to the racket and past it at full speed has left the picture by the time the stroke can
 * be drawn. The sim (and the judgement) run on the true ball; only what is DRAWN slows down as
 * it comes to a human's contact, stays near the racket for about as long as a swing takes to
 * be heard, and, if no swing comes, catches up smoothly.
 *
 *   lead   the drawn clock starts to slow this long before the plan's contact time (s), and stays slow until `hold` after it
 *   slow   the drawn clock's rate while held (1 = real time)
 *   slowNet  the same for a volley within `netZ` m of the net (the ball there is faster and closer: at 0.25 a 25 m/s volley still travels ~0.8 m in a 130 ms hold)
 *   catchUp  seconds over which a held ball is caught up to the true one if no swing comes
 *   min/max/def  the hold's length (s): the median of the last swing ages, clamped to [min, max]; def before any swing
 *   launch  seconds a hit ball takes from where it was drawn to the true outgoing flight: 1.05 × the swing's age, in [launch, launchMax]
 *           (the gap to close is the age × the ball's speed; over a fixed time a slow phone's ball would cross the screen in a frame or two)
 */
export const HOLD = { lead: 0.03, slow: 0.25, slowNet: 0.12, netZ: 5, catchUp: 0.06, min: 0.04, max: 0.18, def: 0.06, launch: 0.07, launchMax: 0.13 };

export class Match {
  cfg: MatchConfig;
  players: TPlayer[] = [];
  score: Score;
  state: MatchState = 'intro';
  stateT0 = 0;
  t = 0;
  rng: Rng;
  ball: BallInfo;
  /** the current flight's predicted path (written over on every shot, never rebuilt) */
  path = new PathBuf();
  rally = 0;
  second = false;
  onEvent: (e: MatchEvent) => void = () => {};
  /** seconds of hit-stop requested by the last big hit */
  hitstop = 0;
  /** 0..1 crowd energy */
  excitement = 0.2;
  /** server for the current point */
  server!: TPlayer;
  lastShotTx = 0;
  /** the last shot was a human's perfect one (the CPU is under pressure) */
  private lastPerfect = false;
  pointWinner: 0 | 1 = 0;
  lastReason: PointReason = 'winner';
  /** swing time for CPUs, per plan */
  private aiSwingAt = new Map<TPlayer, number>();
  /** humans who took a ball on a swing's onset, awaiting the swing: the plan taken, the partners it was taken from, and when to give up */
  private poached = new Map<TPlayer, { plan: HitPlan; mates: TPlayer[]; until: number }>();
  private cpuTossAt = 0;
  /** the player whose swing the ball is being drawn towards (public: a guest TV's shadow match is set from the stream) */
  pendingHit: TPlayer | null = null;
  private deadUntil = 0;
  private resetAt = 0;
  private flightJudged: { out: boolean; net: boolean } = { out: false, net: false };
  /** scratch points (nothing here outlives a call) */
  private sa: V3 = { x: 0, y: 0, z: 0 };
  private sb: V3 = { x: 0, y: 0, z: 0 };
  private sp: V3 = { x: 0, y: 0, z: 0 };
  private sq: V3 = { x: 0, y: 0, z: 0 };
  /** ballAt's chain of bounces for one flight: computed once per segment, not per call */
  private chainSegs: Seg[] = [];
  private chainNb: (number | null)[] = [];
  private chainOf: Seg | null = null;
  /** the flight before the current one (a swing heard late asks where the ball was before it bounced or was hit) */
  private prevSeg: Seg | null = null;
  /** the ball is drawn held at a human's racket (View only; the app turns it off in bullet time and on a guest's shadow match) */
  holdOn = true;
  /** ages (sim s) of the last human swings when they were heard */
  private swingAges: number[] = [];
  /** the plan the hold length was last fixed for (a plan keeps one length: what was drawn is what is judged) */
  private holdPlan: HitPlan | null = null;
  private holdLatched: number = HOLD.def;
  /** a hit ball's blend from where it was drawn to its true flight */
  private launch: { t0: number; dur: number; dx: number; dy: number; dz: number } | null = null;
  private lv0: V3 = { x: 0, y: 0, z: 0 };
  private lv1: V3 = { x: 0, y: 0, z: 0 };
  /** the last human swing heard (for the TV's latency readout) */
  lastJudge = { n: 0, age: 0, hold: 0, tau: 0, dtMs: 0, hit: false, state: '' };
  gravityScale: number;

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed ?? (Math.random() * 1e9) | 0);
    this.gravityScale = cfg.gravityScale ?? 1;
    cfg.players.forEach((ps, i) => {
      const p = new TPlayer(i, ps.team, ps.ctrl, ps.name, ps.look, ps.handed);
      this.players.push(p);
    });
    // doubles roles: first listed on each team plays back
    for (const team of [0, 1] as const) {
      const tp = this.team(team);
      tp.forEach((p, i) => (p.role = tp.length > 1 && i === 1 ? 'net' : 'back'));
    }
    const names: [string, string] = cfg.teamNames ?? [
      this.team(0).map((p) => p.name).join(' & '),
      this.team(1).map((p) => p.name).join(' & '),
    ];
    this.score = new Score(cfg.gamesToWin, cfg.firstServer ?? 0, names);
    this.ball = {
      seg: { t0: 0, px: 0, py: 1, pz: 0, vx: 0, vy: 0, vz: 0, g: 0, k: 0, spin: 0 },
      holder: null,
      lastHitTeam: 0,
      lastHitter: null,
      bounces: [0, 0],
      serve: false,
      letPending: false,
      netted: false,
      live: false,
      nextBounce: null,
      netCrossT: null,
      visible: false,
      pop: false,
      smash: 0,
    };
    this.setupPoint();
    this.setState(cfg.attract ? 'serve' : 'intro');
    if (cfg.attract) this.beginServe();
  }

  /** (the same array every time: built once, the players don't change) */
  /**
   * Run the path predictor and the planner on a made-up shot, `n` times. Cold, they box every
   * number they touch (~30 KB of garbage in the frame of each of the first shots); a few hundred
   * runs get the engine to compile them, so the app spends a few frames of the intro on it (see
   * `warmLeft`). Nothing in the match changes: they read the players and write scratch.
   */
  warm(n: number) {
    n = Math.min(n, this.warmLeft);
    this.warmLeft -= n;
    for (let i = 0; i < n; i++) {
      const sx = i % 2 ? 1 : -1;
      const seg: Seg = { t0: 0, px: sx, py: 1.1 + (i % 3) * 0.2, pz: -11, vx: -0.5 * sx, vy: 4.2 + (i % 5) * 0.3, vz: 17 + (i % 7), g: COURT.gravity, k: COURT.drag, spin: 0.3, g0: COURT.gravity };
      predictPath(seg, 0, 3.6, 1 / 120, 2, this.warmPath);
      for (const p of this.players) p.planFrom(this.warmPath, 0.02, 0.1, { mustBounce: i % 4 === 0, doubles: this.doubles, prefer: i % 3 === 0 ? 'fh' : undefined, smash: i % 5 === 0 });
    }
  }
  /** warm-up runs still owed */
  warmLeft = 800;
  private warmPath = new PathBuf();

  team(t: 0 | 1): TPlayer[] {
    let c = this.teams[t];
    if (!c || this.teamsN !== this.players.length) {
      this.teams = [this.players.filter((p) => p.team === 0), this.players.filter((p) => p.team === 1)];
      this.teamsN = this.players.length;
      c = this.teams[t];
    }
    return c;
  }
  private teams: TPlayer[][] = [];
  private teamsN = -1;

  get doubles() {
    return this.cfg.doubles;
  }

  private setState(s: MatchState) {
    this.state = s;
    this.stateT0 = this.t;
    this.onEvent({ type: 'state', state: s });
  }

  /** Skip the intro (e.g. when a player presses A). */
  startNow() {
    if (this.state === 'intro') {
      this.setState('serve');
      this.beginServe();
    }
  }

  // ------------------------------------------------------------ setup

  private setupPoint() {
    if (this.cfg.practice) {
      this.score.server = 1;
      this.score.points = [0, 0];
    }
    for (const p of this.players) p.athletic = null;
    const S = this.score.server;
    const R = (1 - S) as 0 | 1;
    const deuce = this.score.deuceCourt;
    const servers = this.team(S);
    const receivers = this.team(R);
    this.server = servers[Math.min(servers.length - 1, this.score.serverIdx[S])];
    const s = serveSideSign(S, deuce);
    const zS = S === 0 ? 1 : -1;
    const zR = -zS;
    this.server.place(s * (this.doubles ? 1.9 : 0.8), zS * (COURT.halfL + 0.3));
    this.server.role = 'back';
    const partner = servers.find((p) => p !== this.server);
    if (partner) {
      partner.place(-s * 2.5, zS * 3.6);
      partner.role = 'net';
    }
    const box = serviceBox(S, deuce);
    const bx = box.x0 === 0 ? 1 : -1;
    // doubles: receivers keep their courts (idx 0 deuce, idx 1 ad)
    const receiver = receivers.length > 1 ? receivers[deuce ? 0 : 1] : receivers[0];
    receiver.place(bx * 2.7, zR * (COURT.halfL + 0.9));
    receiver.role = 'back';
    const rp = receivers.find((p) => p !== receiver);
    if (rp) {
      rp.place(-bx * 2.6, zR * 6.6);
      rp.role = 'net';
    }
    for (const p of this.players) {
      p.plan = null;
      p.swing = null;
      p.holding = false;
      p.tossT = -1;
      p.emote = 'none';
      p.focus = 0;
    }
    this.server.holding = true;
    this.ball.holder = this.server;
    this.ball.live = false;
    this.ball.visible = true;
    this.ball.serve = false;
    this.ball.bounces = [0, 0];
    this.ball.lastHitter = null;
    this.ball.netted = false;
    this.ball.letPending = false;
    this.ball.pop = false;
    this.ball.smash = 0;
    this.pendingHit = null;
    this.launch = null;
    this.prevSeg = null;
    this.aiSwingAt.clear();
    this.poached.clear();
    this.rally = 0;
    this.path.n = 0;
  }

  private beginServe() {
    this.cpuTossAt = this.t + this.rng.range(0.9, 1.6) + (this.cfg.attract ? 0 : 0.3);
    this.server.holding = true;
    this.ball.holder = this.server;
    this.onEvent({ type: 'serve-ready', p: this.server, second: this.second });
  }

  // ------------------------------------------------------------ input

  /** Human toss (tap on the pad). */
  humanToss(slot: number) {
    if (this.state === 'intro') return this.startNow();
    if (this.state === 'serve' && this.server.slot === slot && this.t - this.stateT0 > 0.35) this.toss(this.server);
  }

  /**
   * A human's swing has just begun (a phone's onset, ~100 ms before the swing that confirms it): start the
   * character's stroke NOW, so it is not drawn late by the time the swing takes to be heard. It only animates —
   * no ball, no magnet, no event, no cool-down, and nothing in the judgement — and the heard swing (humanSwing)
   * replaces it, or, if none comes, it turns into a feint. `tOnset` is the (latency-corrected) sim time of the onset.
   */
  humanSwingStart(slot: number, side: 'fh' | 'bh' | undefined, tOnset: number) {
    if (this.state === 'intro' || this.state === 'over') return;
    const mine = this.players.filter((p) => p.slot === slot);
    if (!mine.length) return;
    const serving = (this.state === 'serve' || this.state === 'toss') && this.server.slot === slot;
    // (holding the ball, a swing is the toss)
    if (serving && this.state === 'serve') return;
    let p = serving ? this.server : (mine.find((q) => q.plan) ?? mine[0]);
    const cur = p.swing;
    if (cur && !cur.feint && !(cur.provisional && tOnset > cur.t0 + RESTART)) return;
    if (this.t < p.nextSwingOK) return;
    // a ball they can reach but were not given (their partner's, or a volley's cost lost): a person swinging at it takes it
    if (!serving && !p.plan) {
      const q = this.poach(mine, side, tOnset, false);
      if (q) p = q;
    }
    const t0 = Math.min(tOnset, this.t);
    const f = p.fhSign;
    const soon = this.t + 0.02;
    let stroke: Stroke;
    let tc: number;
    let cx: number, cy: number, cz: number;
    let serve = false;
    const plan = p.plan;
    if (serving) {
      // the trophy pose into the ball at the top of the toss
      stroke = 'serve';
      serve = true;
      const ideal = p.tossT + TOSS_IDEAL;
      tc = Math.max(ideal, t0 + MIN_WINDUP, soon);
      const b = segPos(this.ball.seg, ideal, this.sb);
      cx = b.x;
      cy = b.y;
      cz = b.z;
    } else if (this.state === 'play' && this.ball.live && plan) {
      // the racket meets the ball where the person will (swinging on the DRAWN ball: which is held at the racket a moment)
      stroke = plan.stroke === 'oh' ? 'oh' : (side ?? plan.stroke);
      // (the hold is read, not latched: latching is the judgement's, on the swing itself)
      const hold = this.holdPlan === plan ? this.holdLatched : this.holdSeconds();
      const meet = this.holdOn && this.holdable(plan) ? this.holdUnwarp(plan, hold, plan.t) : plan.t;
      tc = Math.max(Math.min(meet, t0 + MAX_WINDUP), t0 + MIN_WINDUP, soon);
      const b = this.ballAt(plan.t, this.sb);
      cx = b.x;
      cy = b.y;
      cz = b.z;
    } else {
      // nothing to hit: a swing in the air, as a whiff with no ball draws it
      stroke = side ?? (p.lastStroke === 'bh' ? 'bh' : 'fh');
      tc = Math.max(t0 + MIN_WINDUP, soon);
      cx = p.x + (stroke === 'bh' ? -f : f) * 0.8;
      cy = 0.95;
      cz = p.z + p.fwd * 0.4;
    }
    p.swing = {
      stroke,
      t0,
      tc,
      te: tc + (serve ? 0.45 : 0.36),
      cx,
      cy,
      cz,
      hit: false,
      resolved: false,
      input: { power: 0.5, spin: 0, tau: 0 },
      serve,
      provisional: true,
      ease: true,
    };
  }

  /**
   * Human swing. `tEvent` is the (latency-corrected) sim time of the swing. A stroke already started on its
   * onset (humanSwingStart) gives way to it: the same arm carries on (its wind-up is not restarted), and the
   * arm is eased across whatever difference in timing there is.
   */
  humanSwing(slot: number, inp: SwingIn, tEvent: number) {
    let prov: SwingState | null = null;
    let pp: TPlayer | null = null;
    for (const q of this.players) {
      if (q.slot === slot && q.swing?.provisional) {
        prov = q.swing;
        pp = q;
        q.swing = null;
      }
    }
    this.humanSwingHeard(slot, inp, tEvent);
    if (!prov || !pp) return;
    const ns = pp.swing;
    if (!ns) {
      // (nothing came of it — the swing was ignored: the stroke goes on)
      pp.swing = prov;
      return;
    }
    if (ns === prov) return;
    ns.ease = true;
    // the wind-up already drawn stays drawn: t0 is not pushed later (it only matters for a stroke not past its contact)
    if (prov.t0 < ns.t0 && (ns.resolved || !ns.hit)) ns.t0 = prov.t0;
    if (!ns.hit && !ns.resolved && ns.stroke === prov.stroke && ns.te - ns.tc > 0) {
      // a swing that misses (too early, too late, no ball) goes on with the timeline the stroke was on
      ns.tc = prov.tc;
      ns.te = Math.max(prov.te, ns.te);
      ns.cx = prov.cx;
      ns.cy = prov.cy;
      ns.cz = prov.cz;
    }
  }

  private humanSwingHeard(slot: number, inp: SwingIn, tEvent: number) {
    if (this.state === 'intro') return this.startNow();
    const mine = this.players.filter((p) => p.slot === slot);
    if (!mine.length) return;

    if ((this.state === 'serve' || this.state === 'toss') && this.server.slot === slot) {
      if (this.state === 'serve') {
        if (this.t - this.stateT0 > 0.35) this.toss(this.server);
        return;
      }
      this.serveSwing(this.server, { ...inp, aim: this.aimFor(this.server, 'serve', inp.path) }, tEvent, true);
      return;
    }
    if (this.state !== 'play' && this.state !== 'dead') {
      // swinging around between points: just animate the stroke you made
      const p = mine[0];
      if (!p.swing && this.t >= p.nextSwingOK) this.whiff(p, inp.side === 'bh' ? 'bh' : inp.side === 'oh' ? 'oh' : 'fh', 0, undefined, 'noball');
      return;
    }
    let p = mine.find((q) => q.plan) ?? mine[0];
    // (no ball given to them: a swing at a ball they CAN reach takes it — see poach)
    if (!p.plan) {
      const q = this.poach(mine, inp.side === 'fh' || inp.side === 'bh' ? inp.side : undefined, tEvent, true);
      if (q) p = q;
    }
    // (how old swings are when they're heard: the drawn ball waits about that long at the racket)
    const lj = this.lastJudge;
    lj.n++;
    lj.age = Math.max(0, this.t - tEvent);
    lj.hit = false;
    lj.state = this.state;
    if (this.state === 'play' && !p.swing) {
      const a = this.swingAges;
      a.push(lj.age);
      if (a.length > 8) a.shift();
    }
    // a way-too-early swing (often a backswing) can be overridden by the real one
    if (p.swing && !p.swing.hit && p.swing.input.tau < -1 && this.t - p.swing.t0 > 0.08) p.swing = null;
    if (p.swing || this.t < p.nextSwingOK) return;
    const plan = p.plan;
    // the stroke you actually swung (forehand/backhand) wins over the one we guessed
    const chosen: Stroke = plan && plan.stroke === 'oh' ? 'oh' : inp.side === 'fh' || inp.side === 'bh' ? inp.side : (plan?.stroke ?? this.guessStroke(p));
    if (!plan || this.state !== 'play' || !this.ball.live) {
      // the ball has just gone by: that's a late swing, not a random one
      const late = tEvent - p.missedT;
      if (p.missedT > 0 && late > 0 && late < 0.7) this.whiff(p, chosen, 2, Math.round(late * 1000), 'late');
      else this.whiff(p, chosen, 0, undefined, 'noball');
      return;
    }
    // the swing is judged against the time the DRAWN ball was showing when it was made (the ball
    // is held at the racket: see HOLD), so the timing feels as it did before the ball was held
    const tView = this.judgedTime(plan, tEvent);
    const dt = tView - plan.t;
    lj.hold = this.holdFor(plan);
    const k = this.cfg.timingScale ?? 1;
    const smash = this.isSmashPlan(plan);
    const tau = dt < 0 ? dt / ((smash ? SMASH_EARLY : WIN_EARLY) * k) : dt / ((smash ? SMASH_LATE : WIN_LATE) * k);
    lj.tau = tau;
    lj.dtMs = Math.round(dt * 1000);
    if (tau < -1 || tau > 1) {
      // a big early swing on the other side is usually a backswing: set up for the real stroke
      if (tau < -1 && inp.side && inp.side !== 'oh') this.humanPrep(slot, inp.side === 'fh' ? 'bh' : 'fh');
      // (a ball taken on the swing's onset that this swing misses: the partner gets it back)
      this.releasePoach(p);
      this.whiff(p, chosen, tau, Math.round(dt * 1000), tau < 0 ? 'early' : 'late');
      return;
    }
    const aim = this.aimFor(p, chosen, inp.path);
    lj.hit = true;
    this.scheduleHit(p, { ...plan, stroke: chosen }, { power: inp.power, spin: inp.spin, tau, aim, crossed: chosen !== plan.stroke, dtMs: Math.round(dt * 1000), smash }, tEvent, true, tView);
  }

  /** an overhead on a ball high enough to put away: a smash chance */
  isSmashPlan(plan: HitPlan | null): boolean {
    return !!plan && plan.stroke === 'oh' && plan.by > 1.9 && plan.reachable;
  }

  /** The smash chance this player has right now (their plan), or null. */
  smashChance(p: TPlayer): HitPlan | null {
    if (this.state !== 'play' || !this.ball.live || !p.plan || p.smashCalled !== p.plan) return null;
    if (p.swing && p.swing.resolved) return null;
    return p.plan;
  }

  /**
   * Aim from the racket's path at contact, relative to the player's own
   * "straight" (learned from their recent swings, so a skewed calibration or
   * a sideways stance doesn't bias every shot).
   */
  private aimFor(p: TPlayer, stroke: Stroke, path: number | null | undefined): number | undefined {
    if (path === null || path === undefined) return undefined;
    const key = stroke === 'bh' ? 'bh' : stroke === 'fh' ? 'fh' : 'oh';
    const n = p.pathNeutral[key];
    const d = path - n;
    // learn slowly; ignore wild outliers
    if (Math.abs(d) < 70) p.pathNeutral[key] = n + d * 0.12;
    return clamp(d / 32, -1, 1);
  }

  /**
   * A HUMAN TAKES A BALL THEY CAN REACH. `replan` gives each ball to one receiver by plan cost, so the human at the
   * net often has no plan (the back player was given it, or a volley's cost lost): their swing would be a whiff
   * ('noball') while the ball flies past at full speed. When one of `mine` (the slot's players) with NO plan swings
   * at a live ball they can get to (`heard`: a swing that has been heard, made at `tSwing`; else the ONSET of one,
   * made at `tSwing`, whose swing is ~100 ms off), the ball is theirs: the plan moves to them and their partners
   * (CPU or a second phone) step aside to their formation spots, as in `replan`. Then the onset's stroke, the
   * hold and the judgement work as in singles. Never taken: a ball that is dead (netted, going out, already
   * bounced twice, or hit by their own team), one they cannot reach, or one whose partner is already swinging or
   * lunging at it. A player who has a plan keeps it, reachable or not (taking another for an unreachable one cost
   * a simulated net player a fifth of their points: the swing is timed to the ball they were shown). Only balls on
   * the player's own side of the net are found (`planFrom`).
   *   onset  a ball the player can get to from where they stand, with a lunge (POACH_STRETCH), within POACH_SPREAD
   *          of when the swing will land (`tSwing` + 0.1) and no sooner than POACH_SOON from now. The plan is
   *          held from now (`holdFrom`): the drawn ball waits at the racket before the swing is heard, without a jump
   *   heard  a swing already made: a ball within POACH_HEARD_SPREAD of it, that they could have run to in
   *          POACH_HEARD_RUN, and not further than a stroke's reach from where they stand; the hit is credited as
   *          of the swing (there is nothing left to hold: `nohold`)
   * An onset's ball goes back to the partner if no swing follows it or the swing misses its time (releasePoach).
   */
  private poach(mine: TPlayer[], side: Stroke | undefined, tSwing: number, heard: boolean): TPlayer | null {
    const b = this.ball;
    if (this.state !== 'play' || !b.live || b.netted || this.flightJudged.net || this.flightJudged.out || !this.path.n) return null;
    let best: TPlayer | null = null;
    let bestPlan: HitPlan | null = null;
    const tMin = this.t + POACH_SOON;
    for (const q of mine) {
      if (!q.human || q.team === b.lastHitTeam) continue;
      if ((q.swing && !q.swing.provisional) || this.t < q.nextSwingOK) continue;
      // (a partner already on the ball — swinging, or a person's stroke going — is not robbed)
      if (this.team(q.team).some((m) => m !== q && !mine.includes(m) && ((m.swing && !m.swing.feint) || (m.athletic && m.plan)))) continue;
      const opts = { mustBounce: b.serve, doubles: this.doubles, prefer: side, smash: b.pop, at: heard ? tSwing : Math.max(tSwing + 0.1, tMin), spread: heard ? POACH_HEARD_SPREAD : POACH_SPREAD, stretch: heard ? undefined : POACH_STRETCH };
      const plan = heard ? q.planFrom(this.path, tSwing - POACH_HEARD_RUN, 0.02, opts) : q.planFrom(this.path, tMin - 0.08, this.t - tMin + 0.1, opts);
      if (!plan || !plan.reachable) continue;
      if (heard && hyp2(q.x - plan.sx, q.z - plan.sz) > 1.0) continue;
      if (!bestPlan || plan.cost < bestPlan.cost) {
        best = q;
        bestPlan = plan;
      }
    }
    if (!best || !bestPlan) return null;
    if (heard) bestPlan.nohold = true;
    else bestPlan.holdFrom = this.t;
    best.plan = bestPlan;
    best.reactUntil = this.t;
    this.aiSwingAt.delete(best);
    const mates = this.team(best.team).filter((m) => m !== best && !mine.includes(m));
    for (const m of mates) {
      this.aiSwingAt.delete(m);
      this.stepAside(m, best);
    }
    if (!heard) this.poached.set(best, { plan: bestPlan, mates, until: this.t + POACH_WAIT });
    return best;
  }

  /** an onset's ball that no swing followed goes back to the partner (if it can still be reached), and the human back to formation */
  private settlePoaches(t: number) {
    for (const [p, e] of this.poached) {
      if (p.plan !== e.plan || (p.swing && !p.swing.provisional)) {
        this.poached.delete(p);
        continue;
      }
      if (t >= e.until) this.releasePoach(p);
    }
  }

  /** a ball taken on an onset that came to nothing (no swing, or one out of time): back to the partner, if it can still be reached, and the human to formation */
  private releasePoach(p: TPlayer) {
    const e = this.poached.get(p);
    if (!e) return;
    this.poached.delete(p);
    if (p.plan !== e.plan) return;
    const t = this.t;
    let taker: TPlayer | null = null;
    let takerPlan: HitPlan | null = null;
    if (this.state === 'play' && this.ball.live && !this.flightJudged.net && !this.flightJudged.out) {
      for (const m of e.mates) {
        if (m.plan || m.swing) continue;
        const plan = m.planFrom(this.path, t, 0.05, { mustBounce: this.ball.serve, doubles: this.doubles, smash: this.ball.pop });
        if (plan && plan.reachable && (!takerPlan || plan.cost < takerPlan.cost)) {
          taker = m;
          takerPlan = plan;
        }
      }
    }
    this.stepAside(p, taker);
    if (taker && takerPlan) {
      taker.plan = takerPlan;
      taker.reactUntil = t;
      this.aiSwingAt.delete(taker);
    }
  }

  /** a receiver who is not taking the ball holds formation: shaded towards the ball side, level with whoever is */
  private stepAside(p: TPlayer, taker: TPlayer | null) {
    p.plan = null;
    const bx = this.path.n ? this.path.s[Math.min(this.path.n - 1, 60)].x : 0;
    const rp = recoveryPos(p.team, bx, p.role, this.doubles, taker?.x ?? 0);
    p.tx = rp.x;
    p.tz = rp.z;
  }

  /** The player wound up on one side (backswing) — move to play that stroke. */
  humanPrep(slot: number, side: 'fh' | 'bh') {
    if (this.state !== 'play' || !this.ball.live) return;
    const p = this.players.find((q) => q.slot === slot && q.plan);
    if (!p || !p.plan || (p.swing && !p.swing.provisional) || p.plan.stroke === 'oh' || p.plan.stroke === side) return;
    if (p.plan.t - this.t < 0.18) return;
    const plan = p.planFrom(this.path, this.t, 0.02, { mustBounce: this.ball.serve, doubles: this.doubles, prefer: side });
    if (plan && plan.reachable && plan.stroke === side) p.plan = plan;
  }

  private guessStroke(p: TPlayer): Stroke {
    const bp = segPos(this.ball.seg, this.t, this.sa);
    return (bp.x - p.x) * p.fhSign >= 0 ? 'fh' : 'bh';
  }

  private whiff(p: TPlayer, stroke: Stroke, tau: number, dtMs?: number, why?: 'early' | 'late' | 'reach' | 'noball') {
    const f = p.fhSign;
    p.swing = {
      stroke,
      t0: this.t,
      tc: this.t + 0.07,
      te: this.t + 0.42,
      cx: p.x + (stroke === 'bh' ? -f : f) * 0.8,
      cy: stroke === 'oh' ? 2.3 : 0.95,
      cz: p.z + p.fwd * 0.4,
      hit: false,
      resolved: false,
      input: { power: 0.5, spin: 0, tau },
      serve: false,
    };
    p.nextSwingOK = this.t + (tau < -1 ? 0.1 : 0.34);
    p.lastStroke = stroke;
    this.onEvent({ type: 'whiff', p, tau, dtMs, why });
  }

  /**
   * `late`: the swing is a person's, already made by the time we hear of it (a phone's arrives
   * 50–200 ms after the peak). It is resolved AS OF THE SWING: contact at `tEvent` (in the past),
   * the ball's outgoing flight begun there, so that now the ball is already `age` seconds along it
   * and the stroke is drawn `age` into its follow-through, wound up and struck as the person did.
   * (The contact point is where the ball was showing, `tView`, blended towards where the plan
   * meant it.) A swing that is still to happen (a CPU's own, `tEvent` ahead of the clock) needs a
   * moment to be drawn, so contact waits for it, and never sooner than 30 ms out.
   */
  private scheduleHit(p: TPlayer, plan: HitPlan, input: SwingInput, tEvent: number, late = false, tView = tEvent) {
    const now = late && tEvent <= this.t;
    const tc = now ? Math.max(tEvent, this.t - SWING_BACK_MAX) : Math.max(this.t + 0.03, tEvent);
    const a = this.ballAt(now ? Math.min(tView, tc) : tc, this.sa);
    const b = this.ballAt(plan.t, this.sb);
    const w = 0.62;
    p.swing = {
      stroke: plan.stroke,
      t0: now ? tc - SWING_WINDUP : this.t,
      tc,
      te: tc + 0.36,
      cx: lerp(a.x, b.x, w),
      cy: lerp(a.y, b.y, w),
      cz: lerp(a.z, b.z, w),
      hit: true,
      resolved: false,
      input,
      serve: false,
      instant: now || undefined,
    };
    p.lastStroke = plan.stroke;
    p.nextSwingOK = tc + 0.25;
    if (now) {
      p.swing.resolved = true;
      this.resolveHit(p, tc);
    } else this.pendingHit = p;
  }

  private toss(p: TPlayer) {
    const f = p.fhSign;
    const fwd = p.fwd;
    p.holding = false;
    p.tossT = this.t;
    this.ball.holder = null;
    this.prevSeg = null;
    const vy = 5.7;
    this.ball.seg = {
      t0: this.t,
      px: p.x - f * 0.18,
      py: 1.3,
      pz: p.z + fwd * 0.3,
      vx: (f * 0.45) / TOSS_IDEAL,
      vy,
      vz: (fwd * 0.25) / TOSS_IDEAL,
      g: COURT.gravity,
      k: 0,
      spin: 0,
      g0: COURT.gravity,
    };
    this.ball.live = false;
    this.ball.nextBounce = null;
    this.setState('toss');
    this.onEvent({ type: 'toss', p });
  }

  private serveSwing(p: TPlayer, inp: { power: number; spin: number; aim?: number }, tEvent: number, late = false) {
    if (p.swing || this.t < p.nextSwingOK) return;
    const ideal = p.tossT + TOSS_IDEAL;
    const tau = (tEvent - ideal) / (SERVE_WIN * (p.human ? (this.cfg.timingScale ?? 1) : 1));
    if (Math.abs(tau) > 1.15) {
      this.whiff(p, 'serve', tau);
      return;
    }
    const now = late && tEvent <= this.t;
    const tc = now ? this.t : Math.max(this.t + 0.03, tEvent);
    const a = segPos(this.ball.seg, tc, this.sa);
    const b = segPos(this.ball.seg, ideal, this.sb);
    p.swing = {
      stroke: 'serve',
      t0: this.t,
      tc,
      te: tc + 0.45,
      cx: lerp(a.x, b.x, 0.5),
      cy: lerp(a.y, b.y, 0.5),
      cz: lerp(a.z, b.z, 0.5),
      hit: true,
      resolved: false,
      input: { power: inp.power, spin: inp.spin, tau, aim: inp.aim },
      serve: true,
    };
    p.nextSwingOK = tc + 0.3;
    if (now) {
      p.swing.resolved = true;
      this.resolveHit(p, tc);
    } else this.pendingHit = p;
  }

  // ------------------------------------------------------------ ball helpers

  /**
   * Ball position at time t following the current path through bounces (into `out`, or a
   * fresh point). The bounces of a flight are worked out once, not on every call.
   */
  ballAt(t: number, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
    const first = this.ball.seg;
    // (before this flight began: the one it followed)
    if (t < first.t0 && this.prevSeg) return segPos(this.prevSeg, t, out);
    if (this.chainOf !== first) {
      this.chainOf = first;
      this.chainSegs.length = 1;
      this.chainSegs[0] = first;
      this.chainNb.length = 0;
      this.chainNb[0] = segTimeDown(first, COURT.ballR, first.t0 + 1e-3);
    }
    const segs = this.chainSegs;
    const nbs = this.chainNb;
    let i = 0;
    let guard = 0;
    for (;;) {
      const nb = nbs[i];
      if (nb === null || !(t > nb) || guard++ >= 4) break;
      if (i + 1 >= segs.length) {
        const ns = bounceSeg(segs[i], nb);
        segs.push(ns);
        nbs.push(segTimeDown(ns, COURT.ballR, ns.t0 + 1e-3));
      }
      i++;
    }
    return segPos(segs[i], t, out);
  }

  private newFlight(seg: Seg) {
    this.prevSeg = this.ball.seg;
    this.ball.seg = seg;
    this.ball.nextBounce = segTimeDown(seg, COURT.ballR, seg.t0 + 1e-3);
    this.ball.netCrossT = segTimeAtZ(seg, 0);
    if (this.ball.netCrossT !== null && this.ball.netCrossT <= seg.t0 + 1e-4) this.ball.netCrossT = null;
    predictPath(seg, this.t, 3.6, 1 / 120, 2, this.path);
  }

  /** Predict whether the current flight will be out or netted. */
  private judgeFlight(): { out: boolean; net: boolean } {
    const s = this.ball.seg;
    const sp = this.sp;
    const R = (1 - this.ball.lastHitTeam) as 0 | 1;
    let net = false;
    if (this.ball.netCrossT !== null) {
      const p = segPos(s, this.ball.netCrossT, sp);
      net = p.y - COURT.ballR < netHeightAt(p.x) - 0.005;
    }
    let out = false;
    if (this.ball.nextBounce !== null) {
      const p = segPos(s, this.ball.nextBounce, sp);
      if (sideOf(p.z) === R) {
        out = this.ball.serve
          ? !inBox(serviceBox(this.ball.lastHitTeam, this.score.deuceCourt), p.x, p.z, 0.04)
          : !inCourt(p.x, p.z, this.doubles, 0.04);
      }
    }
    const j = this.flightJudged;
    j.out = out;
    j.net = net;
    return j;
  }

  private replan() {
    const R = (1 - this.ball.lastHitTeam) as 0 | 1;
    const H = this.ball.lastHitTeam;
    this.flightJudged = this.judgeFlight();
    const leave = this.flightJudged.net || this.flightJudged.out;
    for (const p of this.team(H)) {
      p.plan = null;
      this.aiSwingAt.delete(p);
      const partner = this.team(H).find((q) => q !== p);
      const rp = recoveryPos(H, this.lastShotTx, p.role, this.doubles, partner?.x ?? 0);
      p.tx = rp.x;
      p.tz = rp.z;
    }
    const recv = this.team(R);
    let best: TPlayer | null = null;
    let bestPlan: HitPlan | null = null;
    for (const p of recv) {
      // a smash coming at you: a moment to take it in (a perfect one, longer)
      const react = p.human ? 0.05 : p.ctrl.ai.react + (this.ball.smash === 2 ? 0.16 : this.ball.smash ? 0.08 : 0);
      p.reactUntil = this.t + react;
      const plan = p.planFrom(this.path, this.t, react, {
        mustBounce: this.ball.serve,
        doubles: this.doubles,
        smash: this.ball.pop,
      });
      if (!plan) continue;
      const score = plan.cost + (plan.reachable ? 0 : 5);
      if (!bestPlan || score < bestPlan.cost + (bestPlan.reachable ? 0 : 5)) {
        best = p;
        bestPlan = plan;
      }
    }
    for (const p of recv) {
      this.aiSwingAt.delete(p);
      if (p === best && bestPlan && !leave) {
        p.plan = bestPlan;
      } else {
        if (leave && p === best) {
          // watch it go: small step, no chase
          p.plan = null;
          p.tx = p.x;
          p.tz = p.z;
        } else this.stepAside(p, best); // hold formation: shade towards the ball side
      }
    }
  }

  // ------------------------------------------------------------ stepping

  step(dt: number) {
    const t0 = this.t;
    this.t += dt;
    const t = this.t;

    switch (this.state) {
      case 'intro':
        if (t - this.stateT0 > (this.cfg.introTime ?? 3.2)) {
          this.setState('serve');
          this.beginServe();
        }
        break;
      case 'serve':
        if (!this.server.human && t >= this.cpuTossAt) this.toss(this.server);
        break;
      case 'toss': {
        const p = this.server;
        if (!p.human && !p.swing && t >= p.tossT + TOSS_IDEAL - 0.12) {
          const ai = p.ctrl.ai;
          const err = this.rng.gauss() * ai.timing * 1.3;
          const pw = clamp(ai.serve + this.rng.gauss() * 0.12, 0.15, 1);
          this.serveSwing(p, { power: pw, spin: 0.3 }, p.tossT + TOSS_IDEAL + err);
        }
        // ball dropped without a swing: catch and re-toss
        if ((!p.swing || p.swing.provisional) && t > p.tossT + 1.22) {
          p.holding = true;
          this.ball.holder = p;
          this.setState('serve');
          this.onEvent({ type: 'catch', p });
          this.beginServe();
        }
        break;
      }
      case 'dead':
        if (t >= this.deadUntil) {
          this.setState('reset');
          this.resetAt = t + 0.55;
        }
        break;
      case 'reset':
        if (t >= this.resetAt) {
          if (this.score.winner >= 0 && !this.cfg.attract) {
            this.setState('over');
          } else {
            if (this.score.winner >= 0 && this.cfg.attract) {
              this.score = new Score(this.cfg.gamesToWin, (1 - this.score.server) as 0 | 1, this.score.names);
            }
            this.setupPoint();
            this.setState('serve');
            this.beginServe();
          }
        }
        break;
    }

    // resolve swings whose contact moment has arrived
    for (const p of this.players) {
      const sw = p.swing;
      if (!sw) continue;
      if (sw.hit && !sw.resolved && t >= sw.tc) {
        sw.resolved = true;
        this.resolveHit(p, sw.tc);
      }
      // a stroke started on an onset that no swing followed: a feint (the arm eases back to the ready stance)
      if (sw.provisional && !sw.feint && t > sw.tc + FEINT_AFTER) {
        sw.feint = true;
        sw.feintT = t;
        sw.te = t + FEINT_EASE;
      }
      if (t >= sw.te) p.swing = null;
    }

    if (this.poached.size) this.settlePoaches(t);
    this.stepBall(t0, t);
    this.stepPlayers(dt);
    this.excitement = Math.max(0.15, this.excitement - dt * 0.05);
  }

  private stepBall(t0: number, t: number) {
    const b = this.ball;
    if (b.holder || this.state === 'toss') return;
    if (this.pendingHit && this.pendingHit.swing && !this.pendingHit.swing.resolved) return;

    // net crossing
    if (b.netCrossT !== null && b.netCrossT > t0 - 1e-6 && b.netCrossT <= t) {
      const tn = b.netCrossT;
      b.netCrossT = null;
      const p = segPos(b.seg, tn, { x: 0, y: 0, z: 0 });
      const v = segVel(b.seg, tn, this.sq);
      const h = netHeightAt(p.x);
      const gap = p.y - COURT.ballR - h;
      if (gap < 0) {
        const cord = gap > -COURT.ballR * 1.4;
        const over = cord && this.rng.chance(0.42);
        const dir = Math.sign(v.z);
        const g0 = b.seg.g0 ?? COURT.gravity;
        if (over) {
          this.newFlight({ t0: tn, px: p.x, py: h + COURT.ballR + 0.02, pz: dir * 0.05, vx: v.x * 0.35, vy: 1.4 + this.rng.next(), vz: v.z * 0.14, g: g0, k: 0.2, spin: 0, g0 });
        } else {
          b.netted = true;
          this.newFlight({ t0: tn, px: p.x, py: p.y, pz: -dir * 0.06, vx: v.x * 0.12, vy: Math.min(0, v.y) * 0.2 - 0.3, vz: -v.z * 0.06, g: g0, k: 0.5, spin: 0, g0 });
        }
        this.onEvent({ type: 'net', pos: p, cord, over });
        if (b.live) this.replan();
      } else if (b.serve && gap < 0.05) {
        b.letPending = true;
        this.onEvent({ type: 'net', pos: p, cord: true, over: true });
      } else if (b.live && gap < 0.12) {
        this.onEvent({ type: 'close-call', pos: p });
      }
    }

    // bounces (can be several per frame for a dying ball)
    let guard = 0;
    while (b.nextBounce !== null && b.nextBounce <= t && guard++ < 4) {
      const tb = b.nextBounce;
      const p = segPos(b.seg, tb, { x: 0, y: 0, z: 0 });
      const v = segVel(b.seg, tb, this.sq);
      const impact = Math.abs(v.y);
      const wasLive = b.live;
      let out = false;
      let first = false;
      if (b.live) {
        const side = sideOf(p.z);
        const H = b.lastHitTeam;
        const R = (1 - H) as 0 | 1;
        if (b.netted || side === H) {
          if (b.serve) this.fault('net');
          else this.pointTo(R, 'net');
        } else {
          b.bounces[R]++;
          if (b.bounces[R] === 1) {
            first = true;
            const slack = 0.035;
            const good = b.serve
              ? inBox(serviceBox(H, this.score.deuceCourt), p.x, p.z, slack)
              : inCourt(p.x, p.z, this.doubles, slack);
            if (!good) {
              out = true;
              if (b.serve) this.fault('out');
              else this.pointTo(R, Math.abs(p.z) > COURT.halfL ? 'long' : 'wide');
            } else if (b.serve && b.letPending) {
              this.letServe();
            } else {
              const edge = b.serve
                ? inBox(serviceBox(H, this.score.deuceCourt), p.x, p.z, -0.12)
                : inCourt(p.x, p.z, this.doubles, -0.15);
              if (!edge) this.onEvent({ type: 'close-call', pos: p });
            }
          } else {
            this.pointTo(H, b.serve ? 'ace' : 'winner');
          }
        }
      }
      this.onEvent({ type: 'bounce', pos: p, impact, live: wasLive, out, first });
      // continue bouncing (live or not)
      const nb = bounceSeg(b.seg, tb);
      if (impact < 0.8) {
        // ball is rolling: stop simulating vertical motion
        nb.vy = 0;
        nb.g = 0;
        nb.k = 1.2;
        this.prevSeg = b.seg;
        b.seg = nb;
        b.nextBounce = null;
      } else {
        this.prevSeg = b.seg;
        b.seg = nb;
        b.nextBounce = segTimeDown(nb, COURT.ballR, nb.t0 + 1e-3);
      }
      b.netCrossT = segTimeAtZ(b.seg, 0);
      if (b.netCrossT !== null && b.netCrossT <= tb + 1e-4) b.netCrossT = null;
    }

    // ball that nobody played and is long gone
    if (b.live && this.state === 'play') {
      const p = segPos(b.seg, t, this.sp);
      if (Math.abs(p.z) > COURT.halfL + 9 || Math.abs(p.x) > 14) {
        const R = (1 - b.lastHitTeam) as 0 | 1;
        if (b.bounces[R] >= 1) this.pointTo(b.lastHitTeam, 'winner');
        else this.pointTo(R, 'long');
      }
    }
  }

  private stepPlayers(dt: number) {
    const t = this.t;
    // (where the ball is, for the players to look at: the flight doesn't change under this loop)
    const bp = segPos(this.ball.seg, t, this.sp);
    for (const p of this.players) {
      // the moment has passed: stop chasing a ball that's gone. A phone's swing
      // reaches us 50–200 ms after it happened, so humans get that much grace.
      const grace = p.human ? 0.24 : 0.06;
      if (p.plan && t > p.plan.t + WIN_LATE + grace && !(p.swing && p.swing.hit && !p.swing.resolved)) {
        p.missedT = p.plan.t;
        p.plan = null;
        this.aiSwingAt.delete(p);
      }
      // CPU swing decisions
      if (!p.human && p.plan && !p.swing && this.state === 'play' && this.ball.live) {
        let at = this.aiSwingAt.get(p);
        if (at === undefined) {
          at = p.plan.t + this.rng.gauss() * p.ctrl.ai.timing;
          this.aiSwingAt.set(p, at);
        }
        if (t >= at - 0.03) {
          const dtH = at - p.plan.t;
          const tau = dtH < 0 ? dtH / WIN_EARLY : dtH / WIN_LATE;
          const d = hyp2(p.x - p.plan.sx, p.z - p.plan.sz);
          if (d > 1.55) {
            this.whiff(p, p.plan.stroke, tau);
            p.plan = null;
          } else this.scheduleHit(p, p.plan, { power: p.ctrl.ai.power, spin: p.ctrl.ai.spin, tau }, at);
          this.aiSwingAt.delete(p);
        }
      }

      // movement targets
      if (p.plan && t >= p.reactUntil) {
        p.tx = p.plan.sx;
        p.tz = p.plan.sz;
      }
      // a ball you can't quite run down gets a lunge or a flying dive; a high
      // groundstroke gets a jump (the swing is still yours to time)
      if (!p.athletic && p.plan && !(p.swing && !p.swing.provisional) && this.state === 'play' && this.ball.live && t >= p.lockUntil) this.maybeAthletic(p, t);
      const ath = p.athletic;
      if (ath) {
        const recover = ath.move === 'dive' ? 0.85 : ath.move === 'lunge' ? 0.32 : 0.22;
        if (t <= ath.tc) {
          const u = clamp((t - ath.t0) / Math.max(0.05, ath.tc - ath.t0));
          const e = ath.move === 'dive' ? 1 - Math.pow(1 - u, 1.7) : smooth(u);
          p.x = lerp(ath.x0, ath.x1, e);
          p.z = lerp(ath.z0, ath.z1, e);
        } else if (t < ath.tc + recover) {
          if (ath.move === 'dive') {
            if (!ath.landed) {
              ath.landed = true;
              this.onEvent({ type: 'land', p, pos: { x: p.x, y: 0, z: p.z } });
            }
            // skid a little along the court
            const dx = ath.x1 - ath.x0,
              dz = ath.z1 - ath.z0;
            const l = hyp2(dx, dz) || 1;
            const slide = Math.max(0, 0.18 - (t - ath.tc)) * 2.4 * dt;
            p.x += (dx / l) * slide;
            p.z += (dz / l) * slide;
          }
        } else p.athletic = null;
        p.vx = 0;
        p.vz = 0;
      } else if (t < p.lockUntil) {
        // follow-through: plant and decelerate before recovering
        const k = Math.exp(-10 * dt);
        p.vx *= k;
        p.vz *= k;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
      } else if (this.state === 'serve' || this.state === 'toss' || this.state === 'intro') {
        // stand still in position (server bounces the ball, receiver sways)
        p.vx *= 0.8;
        p.vz *= 0.8;
      } else {
        p.step(dt);
      }

      // facing: towards the net, turning slightly towards the ball
      const face = p.team === 0 ? 0 : Math.PI;
      const look = Math.atan2(-(bp.x - p.x), -(bp.z - p.z));
      let d = look - face;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const want = face + clamp(d, -0.6, 0.6) * 0.5;
      p.yaw += (want - p.yaw) * (1 - Math.exp(-8 * dt));
      p.focus = p.plan ? Math.min(1, p.focus + dt * 3) : Math.max(0, p.focus - dt * 2);

      // stamina: sprints drain it; standing still (and the gaps between points) bring it back
      const sp = hyp2(p.vx, p.vz);
      if (this.state === 'play') p.stamina -= Math.max(0, sp - 2.2) * 0.05 * dt;
      p.stamina = clamp(p.stamina + (this.state === 'play' ? (sp < 1.2 ? 0.045 : 0) : 0.45) * dt, 0, 1);
      if (p.tired > 0 && !p.tiredShown && this.state === 'play') {
        p.tiredShown = true;
        this.onEvent({ type: 'tired', p });
      }
      if (p.stamina > 0.8) p.tiredShown = false;
      // a floater coming a human's way: tell them to smash it
      if (p.human && p.plan && p.plan !== p.smashCalled && this.isSmashPlan(p.plan) && this.state === 'play' && this.ball.live) {
        p.smashCalled = p.plan;
        this.onEvent({ type: 'smash-chance', p });
      }
    }
  }

  /**
   * Launch a lunge, dive or jump if the ball will beat the player to it by running
   * alone. Decided ~0.3 s before contact, so the body is in the air when the swing
   * (human or CPU) meets the ball; a dive that falls short is a missed dive.
   */
  private maybeAthletic(p: TPlayer, t: number) {
    const plan = p.plan!;
    const tl = plan.t - t;
    if (tl <= 0.06 || tl > 0.34) return;
    const standD = hyp2(plan.sx - p.x, plan.sz - p.z);
    const runnable = p.maxSpeed * tl * 0.85;
    const gap = standD - runnable;
    let move: AthleticMove | null = null;
    if (plan.stroke !== 'oh' && plan.by > 1.7 && gap < 1.2) move = 'jump';
    else if (gap > 1.0 && gap < 2.8 && plan.by < 1.45) move = 'dive';
    else if (gap > 0.3 && gap < 1.4) move = 'lunge';
    if (!move) return;
    const reach = move === 'dive' ? 2.3 : move === 'lunge' ? 0.8 : 0.3;
    const cover = Math.min(standD, runnable + reach);
    const k = standD > 1e-3 ? cover / standD : 0;
    const c = Math.cos(p.yaw),
      sn = Math.sin(p.yaw);
    const side = c * (plan.bx - p.x) - sn * (plan.bz - p.z) >= 0 ? 1 : -1;
    p.athletic = { move, t0: t, tc: plan.t, x0: p.x, z0: p.z, x1: p.x + (plan.sx - p.x) * k, z1: p.z + (plan.sz - p.z) * k, side, landed: false };
    p.stamina = Math.max(0, p.stamina - (move === 'dive' ? 0.16 : move === 'lunge' ? 0.06 : 0.04));
    this.onEvent({ type: 'athletic', p, move });
  }

  /** how stretched a hit is: a dive 1, a lunge ½, a jump a little */
  private stretchOf(p: TPlayer) {
    const m = p.athletic?.move;
    return m === 'dive' ? 1 : m === 'lunge' ? 0.5 : m === 'jump' ? 0.15 : 0;
  }

  // ------------------------------------------------------------ outcomes

  private resolveHit(p: TPlayer, tc: number) {
    const sw = p.swing!;
    if (this.pendingHit === p) this.pendingHit = null;
    const contact: V3 = { x: sw.cx, y: sw.cy, z: sw.cz };
    // a swing heard late: where the ball is being DRAWN now (held at the racket), to leave from
    const fromView = sw.instant && !sw.serve && tc < this.t - 0.004;
    if (fromView) this.ballView(this.t, this.lv0);

    // too far from the body to actually connect (outplayed)
    const reach = hyp2(contact.x - p.x, contact.z - p.z);
    if (!sw.serve && reach > 2.1) {
      sw.hit = false;
      this.onEvent({ type: 'whiff', p, tau: sw.input.tau, dtMs: sw.input.dtMs, why: 'reach' });
      return;
    }

    let seg: Seg;
    let perfect = false;
    let kind = 'drive';
    let power = sw.input.power;
    const spin = sw.input.spin;
    let shotSpin = 0;
    let rocket = false;

    if (sw.serve) {
      const bias = p.human ? 0 : this.cfg.practice ? -1 : this.second ? 0.02 : 0.12 + p.ctrl.ai.serve * 0.18;
      if (!p.human && this.second) sw.input.power *= 0.8;
      const res = serveShot(p.team, this.score.deuceCourt, sw.input, this.rng, bias);
      seg = buildShot(contact, res.spec, tc);
      shotSpin = res.spec.spin;
      perfect = res.perfect;
      rocket = res.rocket;
      kind = 'serve';
      this.ball.serve = true;
      this.ball.letPending = false;
      this.rally = 0;
      this.lastShotTx = res.spec.tx;
      this.setState('play');
    } else {
      const opp = this.team((1 - p.team) as 0 | 1);
      const oppX = opp.reduce((a, q) => a + q.x, 0) / opp.length;
      const oppZ = opp.reduce((a, q) => (Math.abs(q.z) < Math.abs(a) ? q.z : a), opp[0].z);
      const plan = p.plan;
      const volley = plan ? plan.volley : false;
      if (p.human) {
        // at full stretch or out of breath, all you can do is float it back
        sw.input.stretch = Math.max(this.stretchOf(p), p.tired * 0.8);
        sw.input.oppX = oppX;
        const res = humanShot(p.team, p.fhSign, sw.stroke, contact, volley, sw.input, this.rng, this.doubles);
        seg = buildShot(contact, res.spec, tc);
        shotSpin = res.spec.spin;
        perfect = res.perfect;
        kind = res.kind;
        this.lastShotTx = res.spec.tx;
      } else {
        const stretch = Math.max(plan ? clamp((hyp2(p.x - plan.sx, p.z - plan.sz) - 0.2) / 1.0) : 0.5, this.stretchOf(p));
        const pressure = this.score.matchPointFor(0) || this.score.matchPointFor(1) ? 1 : 0.2;
        const res = aiShot(
          p.ctrl.ai,
          {
            team: p.team,
            contact,
            stroke: sw.stroke,
            volley,
            stretch,
            incomingSpeed: plan?.speed ?? 15,
            oppX,
            oppZ,
            doubles: this.doubles,
            pressure,
            rally: this.rally,
            tired: p.tired,
            incomingPerfect: this.lastPerfect,
            incomingSmash: this.ball.smash,
            incomingPop: this.ball.pop,
            fromHuman: !!this.ball.lastHitter?.human,
          },
          this.rng,
        );
        seg = buildShot(contact, res.spec, tc);
        shotSpin = res.spec.spin;
        kind = res.kind;
        power = res.power;
        perfect = Math.abs(sw.input.tau) < 0.12 && res.kind !== 'error' && this.rng.chance(0.25);
        this.lastShotTx = res.spec.tx;
      }
      this.ball.serve = false;
      this.rally++;
    }

    if (kind === 'wobbly') seg.wob = 0.14;
    // a floater: whoever meets it can smash it
    const apexY = seg.vy > 0 ? segApexY(seg) : seg.py;
    this.ball.pop = !sw.serve && kind !== 'smash' && kind !== 'error' && (kind === 'lob' || kind === 'wobbly' || (apexY > 3.6 && hyp2(seg.vx, seg.vz) < 15));
    this.ball.smash = kind === 'smash' ? (perfect ? 2 : 1) : 0;
    this.lastPerfect = perfect && p.human;
    this.ball.live = true;
    this.ball.lastHitTeam = p.team;
    this.ball.lastHitter = p;
    this.ball.bounces = [0, 0];
    this.ball.netted = false;
    this.newFlight(seg);
    this.replan();
    // the drawn ball leaves the racket for its true flight (which is `age` seconds along already)
    this.launch = null;
    if (fromView) {
      const c = this.ballCore(this.t, this.lv1);
      this.launch = { t0: this.t, dur: clamp((this.t - tc) * 1.05, HOLD.launch, HOLD.launchMax), dx: this.lv0.x - c.x, dy: this.lv0.y - c.y, dz: this.lv0.z - c.z };
    }
    p.hits++;
    p.lockUntil = tc + (sw.serve ? 0.34 : 0.3);

    const kph = hyp3(seg.vx, seg.vy, seg.vz) * 3.6;
    const big = power > 0.82 || kind === 'smash' || perfect;
    // a freeze-frame is punctuation: only for smashes and a player's perfect shot
    // (on every strong hit it read as stutter)
    this.hitstop = kind === 'smash' ? (p.human ? (perfect ? 0.2 : 0.13) : 0.08) : rocket ? 0.07 : perfect && p.human ? 0.045 : 0;
    this.excitement = Math.min(1, this.excitement + 0.04 + this.rally * 0.01 + (big ? 0.08 : 0));
    this.onEvent({
      type: 'hit',
      p,
      power,
      spin,
      perfect,
      kind,
      stroke: sw.stroke,
      pos: contact,
      kph,
      rally: this.rally,
      tau: sw.input.tau,
      serve: sw.serve,
      dtMs: sw.input.dtMs,
      aim: sw.input.aim,
      crossed: sw.input.crossed,
      shotSpin,
      rocket,
    });
    // the flight began in the past: what happened on it since (a net cord, a bounce) happens now
    if (fromView && this.ball.live) this.stepBall(tc, this.t);
  }

  private letServe() {
    this.onEvent({ type: 'let' });
    this.endRallyTo(null, 1.4);
  }

  private fault(reason: 'net' | 'out') {
    this.score.faults++;
    const double = this.score.faults >= 2;
    this.onEvent({ type: 'fault', double, reason });
    if (double) {
      this.second = false;
      this.pointTo((1 - this.server.team) as 0 | 1, 'double');
    } else {
      this.second = true;
      this.endRallyTo(null, 1.3);
    }
  }

  /** End the rally without a point (fault or let): replay the serve. */
  private endRallyTo(_winner: null, wait: number) {
    this.ball.live = false;
    for (const p of this.players) p.plan = null;
    this.deadUntil = this.t + wait;
    this.setState('dead');
    this.pointWinner = this.server.team;
    this.resetKeepScore = true;
  }

  resetKeepScore = false;

  private pointTo(team: 0 | 1, reason: PointReason) {
    if (!this.ball.live) return;
    this.ball.live = false;
    this.second = false;
    this.resetKeepScore = false;
    this.pointWinner = team;
    this.lastReason = reason;
    const out = this.score.pointTo(team);
    for (const p of this.players) {
      p.plan = null;
      this.aiSwingAt.delete(p);
      p.emote = p.team === team ? 'celebrate' : 'sad';
      p.emoteT0 = this.t + 0.25;
      // stop chasing
      p.tx = p.x + p.vx * 0.25;
      p.tz = p.z + p.vz * 0.25;
    }
    this.excitement = Math.min(1, this.excitement + 0.25 + Math.min(0.4, this.rally * 0.03));
    this.deadUntil = this.t + (out.matchWon ? 3.4 : out.gameWon ? 2.6 : 2.1);
    this.setState('dead');
    this.onEvent({
      type: 'point',
      winner: team,
      reason,
      rally: this.rally,
      call: out.call,
      gameWon: out.gameWon,
      matchWon: out.matchWon,
      lastHitter: this.ball.lastHitter,
    });
  }

  // ------------------------------------------------------------ view helpers

  /**
   * Where to draw the ball: the flight, with the racket "magnet" before a scheduled contact, the
   * hold at a human's racket (HOLD) and the blend of a hit ball into its true flight. A pure
   * function of `t` and the match's state (it is called several times a frame, and by a guest's
   * probe at times of its own). `plain`: the ball as the sim (and the stream to guests) has it, without the hold and the blend.
   */
  ballView(t: number, out: V3, plain = false): V3 {
    const b = this.ball;
    if (b.holder) {
      // (the view places it in the hand: nothing to give, and a point reused from the last frame must not linger)
      out.x = out.y = out.z = 0;
      return out;
    }
    this.ballCore(t, out, plain);
    const l = plain ? null : this.launch;
    if (l && t >= l.t0) {
      const u = (t - l.t0) / l.dur;
      if (u < 1) {
        const k = (1 - u) * (1 - u);
        out.x += l.dx * k;
        out.y += l.dy * k;
        out.z += l.dz * k;
      }
    }
    return out;
  }

  private ballCore(t: number, out: V3, plain = false): V3 {
    const b = this.ball;
    segPos(b.seg, t, out);
    const ph = this.pendingHit;
    if (ph && ph.swing && !ph.swing.resolved) {
      const sw = ph.swing;
      const k = smooth(clamp((t - sw.t0) / Math.max(0.01, sw.tc - sw.t0)));
      const nat = this.ballAt(t, this.sa);
      out.x = lerp(nat.x, sw.cx, k);
      out.y = lerp(nat.y, sw.cy, k);
      out.z = lerp(nat.z, sw.cz, k);
    } else if (this.state === 'toss' || this.state === 'serve') {
      segPos(b.seg, t, out);
    } else {
      // follow bounces for display (on the drawn clock, which waits at a human's racket)
      const hp = plain ? null : this.holdPlayer();
      const td = hp ? this.holdWarp(hp.plan!, this.holdFor(hp.plan!), t) : t;
      const p = this.ballAt(td, this.sa);
      out.x = p.x;
      out.y = Math.max(COURT.ballR, p.y);
      out.z = p.z;
      // a floated mishit visibly wobbles on its way over
      const w = b.seg.wob;
      if (w) {
        const u = td - b.seg.t0;
        out.x += Math.sin(u * 15) * w * Math.min(1, u * 4);
        out.y += Math.sin(u * 11 + 1.3) * w * 0.5 * Math.min(1, u * 4);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ the drawn ball's hold

  /** the human whose racket the drawn ball is being held at, or null */
  private holdPlayer(): TPlayer | null {
    if (!this.holdOn || this.state !== 'play' || !this.ball.live) return null;
    for (const p of this.players) if (p.human && p.plan && this.holdable(p.plan)) return p;
    return null;
  }

  /** a plan the hold applies to: one a human can reach (a smash chance has bullet time of its own) */
  private holdable(plan: HitPlan): boolean {
    return plan.reachable && !plan.nohold && !this.isSmashPlan(plan);
  }

  /** the drawn clock's rate while a plan's ball is held: slower for a volley at the net (faster, closer ball) */
  private slowOf(plan: HitPlan): number {
    return plan.volley && Math.abs(plan.sz) < HOLD.netZ ? HOLD.slowNet : HOLD.slow;
  }

  /** how long the drawn ball is held (s): the median of the last swing ages, in [HOLD.min, HOLD.max] */
  holdSeconds(): number {
    const a = this.swingAges;
    if (!a.length) return HOLD.def;
    const s = a.slice().sort((x, y) => x - y);
    const n = s.length;
    return clamp(n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2, HOLD.min, HOLD.max);
  }

  /** the median age of the last human swings heard (s), or 0 before any */
  medianAge(): number {
    const a = this.swingAges;
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    const n = s.length;
    return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /** the hold length for a plan: fixed the first time it is used, so what is drawn is what is judged */
  holdFor(plan: HitPlan): number {
    if (this.holdPlan !== plan) {
      this.holdPlan = plan;
      this.holdLatched = this.holdSeconds();
    }
    return this.holdLatched;
  }

  /**
   * The sim time the drawn ball shows at sim time `t` when held at `plan`'s contact: real time until
   * `lead` before it, then a slowed clock until `hold` after it, then caught up to real time over
   * `catchUp` (eased: never a jump).
   */
  holdWarp(plan: HitPlan, hold: number, t: number): number {
    const ts = plan.holdFrom === undefined ? plan.t - HOLD.lead : Math.max(plan.t - HOLD.lead, plan.holdFrom);
    if (t <= ts) return t;
    const u = t - ts;
    // (the clock is slowed until `hold` after the contact time: a swing made on the beat, heard `hold` later, finds the ball at the racket)
    const w = plan.holdFrom === undefined ? hold + HOLD.lead : plan.t + hold - ts;
    const slow = this.slowOf(plan);
    if (u <= w) return ts + u * slow;
    const v = (u - w) / HOLD.catchUp;
    if (v >= 1) return t;
    return t - w * (1 - slow) * (1 - smooth(v));
  }

  /** the sim time at which the drawn ball shows time `d` (the inverse of holdWarp) */
  holdUnwarp(plan: HitPlan, hold: number, d: number): number {
    const ts = plan.holdFrom === undefined ? plan.t - HOLD.lead : Math.max(plan.t - HOLD.lead, plan.holdFrom);
    if (d <= ts) return d;
    const w = plan.holdFrom === undefined ? hold + HOLD.lead : plan.t + hold - ts;
    const slow = this.slowOf(plan);
    if (d <= ts + w * slow) return ts + (d - ts) / slow;
    let lo = ts + w;
    const hi0 = ts + w + HOLD.catchUp;
    let hi = hi0;
    if (d >= hi0) return d;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (this.holdWarp(plan, hold, mid) < d) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** the time a swing made at sim time `t` is judged at: the time the drawn ball was showing */
  judgedTime(plan: HitPlan, t: number): number {
    return this.holdOn && this.holdable(plan) ? this.holdWarp(plan, this.holdFor(plan), t) : t;
  }

  /** the sim time a swing is made at for the drawn ball to show time `d` (what a person swinging on the ball they see does): judgedTime's inverse */
  swingTimeFor(plan: HitPlan, d: number): number {
    return this.holdOn && this.state === 'play' && this.holdable(plan) ? this.holdUnwarp(plan, this.holdFor(plan), d) : d;
  }

  /** the human's plan the drawn ball is being held at right now, or null (for the tests and tools) */
  heldPlan(): HitPlan | null {
    return this.holdPlayer()?.plan ?? null;
  }

  /** The human-controlled player a slot should be told about (for pad UI). */
  slotPlayer(slot: number): TPlayer | undefined {
    return this.players.find((p) => p.slot === slot);
  }

  isServerSlot(slot: number) {
    return this.server?.slot === slot && (this.state === 'serve' || this.state === 'toss');
  }

  fwdOf(team: 0 | 1) {
    return fwdOf(team);
  }

  static defaultAI() {
    return AI_LEVELS.pro;
  }
}
