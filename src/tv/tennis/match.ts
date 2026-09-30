// The rules engine and point flow for a tennis match.

import { COURT, netHeightAt, sideOf, inCourt, serviceBox, inBox, serveSideSign, fwdOf } from './court';
import { type Seg, segPos, segVel, segTimeDown, segTimeAtZ, bounceSeg, predictPath, segApexY, PathBuf } from './ball';
import { buildShot, humanShot, serveShot, type Stroke, type SwingInput } from './shot';
import { TPlayer, type Ctrl, type HitPlan, type AthleticMove } from './player';
import { aiShot, recoveryPos, AI_LEVELS } from './ai';
import { Score } from './score';
import type { Look } from '../chars/look';
import { clamp, lerp, Rng, smooth, type V3 } from '../core/math';
import { hyp2, hyp3 } from './hypot';
import { RUSH, heatAfter, paceAt } from './rush';

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
  /** Rush: rallies start faster and every hit builds heat (ball and players speed up) */
  rush?: boolean;
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
  /** Rush: the rally's heat 0..1 (see rush.ts); stays 0 when rush is off */
  heat = 0;
  /** swing time for CPUs, per plan */
  private aiSwingAt = new Map<TPlayer, number>();
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
    if (this.cfg.rush) this.setHeat(0);
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
    this.aiSwingAt.clear();
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
   * Human swing. `tEvent` is the (latency-corrected) sim time of the swing.
   */
  humanSwing(slot: number, inp: SwingIn, tEvent: number) {
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
    const p = mine.find((q) => q.plan) ?? mine[0];
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
    const dt = tEvent - plan.t;
    const k = this.cfg.timingScale ?? 1;
    const smash = this.isSmashPlan(plan);
    const tau = dt < 0 ? dt / ((smash ? SMASH_EARLY : WIN_EARLY) * k) : dt / ((smash ? SMASH_LATE : WIN_LATE) * k);
    if (tau < -1 || tau > 1) {
      // a big early swing on the other side is usually a backswing: set up for the real stroke
      if (tau < -1 && inp.side && inp.side !== 'oh') this.humanPrep(slot, inp.side === 'fh' ? 'bh' : 'fh');
      this.whiff(p, chosen, tau, Math.round(dt * 1000), tau < 0 ? 'early' : 'late');
      return;
    }
    const aim = this.aimFor(p, chosen, inp.path);
    this.scheduleHit(p, { ...plan, stroke: chosen }, { power: inp.power, spin: inp.spin, tau, aim, crossed: chosen !== plan.stroke, dtMs: Math.round(dt * 1000), smash }, tEvent, true);
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

  /** The player wound up on one side (backswing) — move to play that stroke. */
  humanPrep(slot: number, side: 'fh' | 'bh') {
    if (this.state !== 'play' || !this.ball.live) return;
    const p = this.players.find((q) => q.slot === slot && q.plan);
    if (!p || !p.plan || p.swing || p.plan.stroke === 'oh' || p.plan.stroke === side) return;
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
   * 50–200 ms after the peak): contact is now, resolved on the spot. A swing that is still to
   * happen (a CPU's own, `tEvent` ahead of the clock) needs a moment to be drawn, so contact
   * waits for it, and never sooner than 30 ms out.
   */
  private scheduleHit(p: TPlayer, plan: HitPlan, input: SwingInput, tEvent: number, late = false) {
    const now = late && tEvent <= this.t;
    const tc = now ? this.t : Math.max(this.t + 0.03, tEvent);
    const a = this.ballAt(tc, this.sa);
    const b = this.ballAt(plan.t, this.sb);
    const w = 0.62;
    p.swing = {
      stroke: plan.stroke,
      t0: this.t,
      tc,
      te: tc + 0.36,
      cx: lerp(a.x, b.x, w),
      cy: lerp(a.y, b.y, w),
      cz: lerp(a.z, b.z, w),
      hit: true,
      resolved: false,
      input,
      serve: false,
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
        p.plan = null;
        // hold formation: shade towards the ball side
        const bx = this.path.n ? this.path.s[Math.min(this.path.n - 1, 60)].x : 0;
        const rp = recoveryPos(R, bx, p.role, this.doubles, best?.x ?? 0);
        if (leave && p === best) {
          // watch it go: small step, no chase
          p.tx = p.x;
          p.tz = p.z;
        } else {
          p.tx = rp.x;
          p.tz = rp.z;
        }
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
        if (!p.swing && t > p.tossT + 1.22) {
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
      if (t >= sw.te) p.swing = null;
    }

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
        b.seg = nb;
        b.nextBounce = null;
      } else {
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
      if (!p.athletic && p.plan && !p.swing && this.state === 'play' && this.ball.live && t >= p.lockUntil) this.maybeAthletic(p, t);
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
      if (this.state === 'play') p.stamina -= Math.max(0, sp / p.runMul - 2.2) * 0.05 * dt;
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
    const runnable = p.maxSpeed * p.runMul * tl * 0.85;
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

  /** Rush: set the rally's heat; everyone runs at the pace the ball now has */
  private setHeat(h: number) {
    this.heat = h;
    const run = paceAt(h);
    for (const q of this.players) q.runMul = 1 + (run - 1) * RUSH.run;
  }

  /** Rush: a rally drive or volley goes out at the rally's pace (the heat from before this hit) */
  private rushShot(spec: { speed: number; clear: number }) {
    const pace = paceAt(this.heat);
    spec.speed *= pace;
    if (spec.clear > 0) spec.clear /= Math.pow(pace, RUSH.flatten);
  }

  private resolveHit(p: TPlayer, tc: number) {
    const sw = p.swing!;
    if (this.pendingHit === p) this.pendingHit = null;
    const contact: V3 = { x: sw.cx, y: sw.cy, z: sw.cz };

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
        if (this.cfg.rush && (res.kind === 'drive' || res.kind === 'volley')) this.rushShot(res.spec);
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
        if (this.cfg.rush && (res.kind === 'drive' || res.kind === 'volley')) this.rushShot(res.spec);
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
    if (this.cfg.rush) this.setHeat(heatAfter(this.heat, { serve: sw.serve, perfect }));

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

  /** Where to draw the ball (includes the racket "magnet" before contact). */
  ballView(t: number, out: V3): V3 {
    const b = this.ball;
    if (b.holder) {
      // (the view places it in the hand: nothing to give, and a point reused from the last frame must not linger)
      out.x = out.y = out.z = 0;
      return out;
    }
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
      // follow bounces for display
      const p = this.ballAt(t, this.sa);
      out.x = p.x;
      out.y = Math.max(COURT.ballR, p.y);
      out.z = p.z;
      // a floated mishit visibly wobbles on its way over
      const w = b.seg.wob;
      if (w) {
        const u = t - b.seg.t0;
        out.x += Math.sin(u * 15) * w * Math.min(1, u * 4);
        out.y += Math.sin(u * 11 + 1.3) * w * 0.5 * Math.min(1, u * 4);
      }
    }
    return out;
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
