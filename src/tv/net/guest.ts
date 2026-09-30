// The guest side of an online match: a live replay with the live camera.
//
// The host streams snapshots (src/shared/net.ts); this plays them a moment behind the host
// (BUFFER ≈ 1.5 snapshot intervals), between the two snapshots that surround "now":
//   - poses are interpolated; enums and flags take the nearer one;
//   - the ball is not interpolated at all: a snapshot carries the segment it is flying on, and
//     the ball is that segment evaluated at the time being shown, exactly as on the host (with the
//     same racket "magnet" and bounce roll-forward: Match.ballView on a shadow match);
//   - events fire when the time being shown reaches their simulation time;
//   - the score, state and the like come from the newest snapshot not after that time.
// The SHADOW match is a Match nobody steps: every frame this writes into it what the camera rig,
// the HUD, the worlds and the flow already read from a match. If snapshots stop, poses hold, the
// ball stays on its segment and, after 1.5 s, the caller is told we are reconnecting.
//
// The playback clock runs in the host's wall time (each snapshot carries its stamp): the offset
// between the host's clock and ours is the least (arrival − stamp) over the last ~5 s, i.e. what
// the fastest snapshot took, and the clock slews (never jumps) towards "host now − buffer".
// The BUFFER (how far behind the newest snapshot we show) follows the network: a snapshot must have
// arrived by the time the interpolation needs it, so it is one snapshot interval plus the 95th
// percentile of how much later than the fastest a snapshot arrived over the last ~5 s (never under
// 50 ms). It rises at most 60 ms per second and falls at most 20, the clock slowing / quickening by
// that much (6 % / 2 %) meanwhile: a quiet line shows the match ~50 ms behind, a jittery one buys
// smoothness with lag, and neither is ever seen as a jump.

import { Match } from '../tennis/match';
import type { MatchEvent, PointReason } from '../tennis/match';
import { Score } from '../tennis/score';
import { segTimeDown } from '../tennis/ball';
import { COURT } from '../tennis/court';
import { AI_LEVELS } from '../tennis/ai';
import type { HitPlan, SwingState } from '../tennis/player';
import type { Stroke } from '../tennis/shot';
import type { Look } from '../chars/look';
import { newPose, type Pose } from '../chars/pose';
import type { V3 } from '../core/math';
import { STATES, decodeSnap, newSnap, type NetEnd, type NetEvent, type NetHud, type NetMsg, type NetPose, type NetStart, type NetWorld, type Snap } from '../../shared/net';

const RING = 128;
/** how many snapshots are searched for the ball's segment and the racket magnet, starting a few after the one at the time */
const SCAN = 24;
const AHEAD = 8;
/** an event's time is rounded to the ms: a flight that starts at the event (a toss, a hit) is taken from ~2 ms before it */
const SEG_SLACK = 0.002;
/** a racket magnet shorter than this isn't one: a hit heard after the swing was made resolves on the spot (t0 = tc) */
const MIN_MAGNET = 0.005;
const isMagnet = (w: Snap['warp']) => w.p >= 0 && w.tc - w.t0 >= MIN_MAGNET;
/** no snapshot for this long: we say we are reconnecting */
const STALL_MS = 1500;
/** how far past the newest snapshot the shown time may run, ms: none — a hit or a bounce the news of which is behind a late snapshot would
 *  put the ball back on another line when it arrived, and even 20 ms of that is a metre */
const HOLD_MS = 0;
/** the buffer never goes below this, ms (a snapshot interval and a little) */
const BUF_MIN = 50;
/** …nor above this */
const BUF_MAX = 400;
/** the arrival jitter is measured over the snapshots of this many last ms, and re-measured this often */
const JIT_WINDOW_MS = 5000;
const JIT_EVERY_MS = 250;
/** how fast the buffer may grow / shrink, ms per second */
const BUF_UP = 60;
const BUF_DOWN = 20;

/** what the guest needs from the app around it */
export interface GuestHooks {
  /** an event, at its moment (the same thing App.event does for the host's own match) */
  event(e: MatchEvent): void;
  world(id: string, transition: boolean, origin?: { x: number; y: number }, at?: { x: number; y: number; z: number }): void;
  hud(text: string, sub?: string, cls?: string): void;
  end(e: NetEnd): void;
  status(reconnecting: boolean): void;
  /** the host is watching an instant replay (or stopped) */
  replay(on: boolean): void;
  /** the room-clock offset of this TV, ms (link.serverOffset) */
  clockOffset(): number;
}

export interface GuestStats {
  oneWay: { p50: number; p90: number; max: number; n: number };
  /** the buffer in use, ms */
  buffer: number;
  /** the host's regular snapshot interval, ms */
  snapshotInterval: number;
  dropped: number;
  lateEvents: number;
  snapshots: number;
  resyncs: number;
  /** times the shown time had to wait for a late snapshot (the picture froze for a moment), and for how long in all, ms */
  holds: number;
  heldMs: number;
  /** one-way delay (p50) + buffer: how far behind the host what we show is, ms */
  renderLag: number;
  reconnecting: boolean;
}

/** Build the match the guest's camera, HUD and worlds read from. It is never stepped. */
export function shadowMatch(start: NetStart): Match {
  const players = start.players.map((p) => ({
    team: p.team,
    name: p.name,
    look: p.look as unknown as Look,
    handed: p.handed,
    ctrl: p.human ? { kind: 'human' as const, slot: p.slot, ai: AI_LEVELS.auto } : { kind: 'cpu' as const, ai: AI_LEVELS.pro },
  }));
  return new Match({ doubles: start.doubles, gamesToWin: start.gamesToWin, players, teamNames: start.teamNames, firstServer: start.firstServer, seed: start.seed, timingScale: start.timingScale, introTime: start.introTime });
}

interface Pending {
  ev: NetEvent;
  carrier: Snap;
}

/** the ball's segment (and the racket magnet) at sim time `t`, written into `m` */
class BallSync {
  segSerial = -1;

  set(m: Match, X: Snap, Z: Snap['warp'] | null) {
    const b = m.ball;
    const g = X.seg;
    if (this.segSerial !== X.serial) {
      this.segSerial = X.serial;
      const c = b.seg;
      if (c.t0 !== g.t0 || c.px !== g.px || c.py !== g.py || c.pz !== g.pz || c.vx !== g.vx || c.vy !== g.vy || c.vz !== g.vz || c.g !== g.g || c.k !== g.k || (c.wob ?? 0) !== g.wob) {
        b.seg = { t0: g.t0, px: g.px, py: g.py, pz: g.pz, vx: g.vx, vy: g.vy, vz: g.vz, g: g.g, k: g.k, spin: g.spin, wob: g.wob || undefined };
        b.nextBounce = segTimeDown(b.seg, COURT.ballR, b.seg.t0 + 1e-3);
      }
    }
    // the racket magnet, while a hit is being lined up
    const prev = m.pendingHit;
    if (Z) {
      const p = m.players[Z.p];
      if (p) {
        if (prev && prev !== p) prev.swing = null;
        const sw = (p.swing ?? ({ stroke: 'fh', hit: true, resolved: false, input: { power: 0.5, spin: 0, tau: 0 }, serve: false } as unknown as SwingState)) as SwingState;
        sw.t0 = Z.t0;
        sw.tc = Z.tc;
        sw.te = Z.tc + 0.36;
        sw.cx = Z.cx;
        sw.cy = Z.cy;
        sw.cz = Z.cz;
        sw.resolved = false;
        p.swing = sw;
        m.pendingHit = p;
        return;
      }
    }
    if (prev) {
      prev.swing = null;
      m.pendingHit = null;
    }
  }
}

export class GuestStream {
  readonly id: number;
  readonly start: NetStart;
  readonly match: Match;
  /** the interpolated poses to draw (one per player) */
  readonly poses: Pose[];
  /** sim seconds the time being shown moved this frame */
  dt = 0;
  /** the time being shown, sim s */
  tR = 0;
  /** the host is watching a replay */
  replay = false;
  reconnecting = false;
  ended = false;

  /** the clocks (a test runs on its own) */
  clock = { perf: () => performance.now(), date: () => Date.now() };
  private ring: Snap[] = Array.from({ length: RING }, newSnap);
  private serial = 0;
  private lastSeq = -1;
  private pending: Pending[] = [];
  private timeline: { wall: number; msg: NetWorld | NetHud | NetEnd }[] = [];
  private lastFired: Snap | null = null;
  /** the racket magnets that hits told of (a snapshot in the ~30 ms one lasts may not have been sent) */
  private hitWarps: Snap['warp'][] = [];
  private main = new BallSync();
  private probe: { m: Match; sync: BallSync } | null = null;
  private plan: HitPlan = { t: 0, bx: 0, by: 0, bz: 0, stroke: 'oh', volley: false, sx: 0, sz: 0, reachable: true, cost: 0, speed: 0 };
  private scratch: Score;
  // the playback clock
  private wR = 0;
  private started = false;
  private offW = 0;
  private slack = 0;
  buffer = BUF_MIN;
  /** what the network says the buffer should be (the buffer follows it, slewing), ms */
  private want = BUF_MIN;
  /** 95th percentile of the snapshots' arrival − the fastest's, over the last few seconds, ms */
  private jit95 = 0;
  private jitAt = -1e9;
  private jitBuf = new Float64Array(RING);
  private gaps: number[] = [];
  private lastRegularWall = -1;
  private oneWay: number[] = [];
  private nOne = 0;
  private dropped = 0;
  private late = 0;
  private resyncs = 0;
  private holds = 0;
  private heldMs = 0;
  private holding = false;

  constructor(
    start: NetStart,
    private hooks: GuestHooks,
    match = shadowMatch(start),
  ) {
    this.id = start.id;
    this.start = start;
    this.match = match;
    this.scratch = new Score(start.gamesToWin, 0, [...start.teamNames] as [string, string]);
    this.poses = match.players.map((p) => {
      const o = newPose();
      o.x = p.x;
      o.z = p.z;
      o.yaw = p.yaw;
      o.handed = p.handed;
      return o;
    });
  }

  private at(serial: number) {
    return this.ring[serial % RING];
  }

  // ---------------------------------------------------------------- input

  /** A binary frame from the host. False if it wasn't a snapshot of ours. */
  push(buf: ArrayBuffer): boolean {
    const s = this.at(this.serial + 1);
    if (!decodeSnap(buf, s)) return false;
    // (a frame delivered twice would fire its events twice)
    if (this.lastSeq >= 0 && s.seq === this.lastSeq) return false;
    s.serial = ++this.serial;
    s.arrived = this.clock.perf();
    if (this.lastSeq >= 0) {
      const gap = (s.seq - this.lastSeq - 1) & 0xffff;
      if (gap > 0 && gap < 1000) this.dropped += gap;
    }
    this.lastSeq = s.seq;
    for (const ev of s.events) {
      this.pending.push({ ev, carrier: s });
      if (ev.type === 'hit' && ev.warp && ev.warp.tc - ev.warp.t0 >= MIN_MAGNET) {
        this.hitWarps.push({ p: ev.p, t0: ev.warp.t0, tc: ev.warp.tc, cx: ev.pos.x, cy: ev.pos.y, cz: ev.pos.z });
        if (this.hitWarps.length > 8) this.hitWarps.shift();
      }
    }
    // the regular tick's interval (event snapshots in between don't count)
    if (!s.ev) {
      if (this.lastRegularWall >= 0) {
        const g = s.wall - this.lastRegularWall;
        if (g > 0 && g < 500) {
          this.gaps.push(g);
          if (this.gaps.length > 15) this.gaps.shift();
        }
      }
      this.lastRegularWall = s.wall;
    }
    // how long it took (both clocks in the room's time)
    const d = this.clock.date() + this.hooks.clockOffset() - (this.start.hostT0 + s.wall);
    this.oneWay[this.nOne++ % 600] = d;
    // host wall → our clock: the fastest recent snapshot says what the offset is (re-measured here until the first
    // few seconds have been seen, so playback starts on something; then every JIT_EVERY_MS in advance())
    if (this.serial <= 3 || s.arrived - s.wall < this.offW) this.offW = s.arrived - s.wall;
    return true;
  }

  /** a control message (world, hud, end) — applied when the time being shown reaches it */
  control(msg: NetMsg) {
    if (msg.type === 'world' || msg.type === 'hud') this.timeline.push({ wall: msg.wall, msg });
    // (the host shows its results a moment after the last point)
    else if (msg.type === 'end') this.timeline.push({ wall: msg.wall + (msg.winner < 0 ? 0 : 900), msg });
  }

  get ready() {
    return this.serial > 0;
  }

  interval() {
    if (!this.gaps.length) return 33;
    const g = this.gaps.slice().sort((a, b) => a - b);
    return g[g.length >> 1];
  }

  /**
   * How late snapshots arrive over the last JIT_WINDOW_MS, against the fastest one: the fastest is the offset between the host's
   * clock and ours (the true delay, when the line is quiet), the 95th percentile of the rest is what a buffer has to cover.
   */
  private measureJitter(now: number) {
    this.jitAt = now;
    const lo = Math.max(1, this.serial - RING + 1);
    const v = this.jitBuf;
    let n = 0;
    let off = Infinity;
    for (let i = lo; i <= this.serial; i++) {
      const q = this.at(i);
      if (now - q.arrived > JIT_WINDOW_MS) continue;
      const d = q.arrived - q.wall;
      v[n++] = d;
      if (d < off) off = d;
    }
    if (n < 8) return;
    for (let i = 0; i < n; i++) v[i] -= off;
    const s = v.subarray(0, n).sort();
    this.jit95 = s[Math.min(n - 1, Math.floor(0.95 * n))];
    this.offW = off;
  }

  // ---------------------------------------------------------------- per frame

  /** Move the shown time on by `realDt` s, fire what it passes, and write the moment into the shadow match and `poses`. */
  advance(realDt: number) {
    if (!this.serial) return;
    const now = this.clock.perf();
    const lo = Math.max(1, this.serial - RING + 1);
    const newest = this.at(this.serial);
    // ---- the playback clock (host wall ms)
    if (now - this.jitAt >= JIT_EVERY_MS) this.measureJitter(now);
    // the clock never runs past the newest snapshot: when the data runs out (a late snapshot: a TCP stall), the clock
    // waits for it. Carrying on would take the ball along its old segment past a hit it has not heard of, and put it back on the new
    // one when the news arrived (a teleport), and throw the players (a pop). Waiting freezes the picture for a moment instead, and the
    // buffer grows by what was missing, so the next one is covered.
    // (a control message says the host's clock had got that far: its `end` waits for the results screen's moment, after the last snapshot)
    let limit = this.ended ? Infinity : newest.wall + HOLD_MS;
    for (let i = 0; i < this.timeline.length; i++) if (this.timeline[i].wall > limit) limit = this.timeline[i].wall;
    const wanted = now - this.offW - this.buffer;
    const short = wanted - limit;
    if (this.started && short > 0) {
      this.slack = Math.max(this.slack, Math.min(BUF_MAX, this.buffer + short));
      if (this.wR >= limit - 1) {
        if (!this.holding) this.holds++;
        this.heldMs += realDt * 1000;
        this.holding = true;
      }
    } else this.holding = false;
    this.slack = Math.max(0, this.slack - 20 * realDt);
    this.want = Math.min(BUF_MAX, Math.max(BUF_MIN, this.interval() + this.jit95, this.slack));
    if (!this.started) this.buffer = this.want;
    else this.buffer += Math.max(-BUF_DOWN * realDt, Math.min(BUF_UP * realDt, this.want - this.buffer));
    const target = now - this.offW - this.buffer;
    if (!this.started) {
      this.wR = Math.min(target, limit);
      this.started = true;
    } else {
      const err = target - this.wR;
      if (Math.abs(err) > 500) {
        // (a long stall is over, or the clocks moved: catching up 500 ms takes too long to watch)
        const to = Math.min(target, limit);
        if (Math.abs(to - this.wR) > 100) this.resyncs++;
        this.wR = to;
      } else this.wR = Math.min(limit, this.wR + realDt * 1000 * (1 + Math.max(-0.08, Math.min(0.08, err / 250))));
    }
    // ---- the two snapshots around it
    let a = this.serial;
    let b = 0;
    while (a > lo && this.at(a).wall > this.wR) {
      b = a;
      a--;
    }
    const A = this.at(a);
    const B = b && A.wall <= this.wR ? this.at(b) : null;
    let u = 0;
    let tR: number;
    if (B) {
      u = Math.max(0, Math.min(1, (this.wR - A.wall) / Math.max(1, B.wall - A.wall)));
      tR = A.t + (B.t - A.t) * u;
    } else {
      // the newest (or the oldest, at the start): the ball goes on along its segment, at the rate the sim was running
      // (for as long as it takes to say we are reconnecting; then it stays where it is)
      const P = a > lo ? this.at(a - 1) : null;
      const rate = P && A.wall > P.wall ? Math.max(0, Math.min(1.25, (A.t - P.t) / ((A.wall - P.wall) / 1000))) : 1;
      tR = A.t + Math.max(0, Math.min(STALL_MS / 1000, (this.wR - A.wall) / 1000)) * rate;
    }
    tR = Math.max(this.tR, tR);
    this.dt = this.tR ? tR - this.tR : 0;
    this.tR = tR;
    const m = this.match;
    m.t = tR;
    // ---- what happens in this stretch of time
    this.runTimeline();
    while (this.pending.length && this.pending[0].ev.t <= tR + 1e-4) {
      const { ev, carrier } = this.pending.shift()!;
      if (!this.lastFired || carrier.serial > this.lastFired.serial) {
        this.lastFired = carrier;
        this.apply(carrier);
        this.pickBall(m, this.main, ev.t, carrier);
      }
      if (tR - ev.t > 0.05) this.late++;
      const e = this.toMatchEvent(ev);
      if (e) this.hooks.event(e);
    }
    // ---- the moment itself
    const cur = this.lastFired && this.lastFired.serial > A.serial ? this.lastFired : A;
    this.apply(cur);
    this.pickBall(m, this.main, tR, cur);
    this.smashCue(cur);
    this.mix(A, B, u);
    if (cur.replay !== this.replay) {
      this.replay = cur.replay;
      this.hooks.replay(cur.replay);
    }
    const stalled = !this.ended && now - newest.arrived > STALL_MS;
    if (stalled !== this.reconnecting) {
      this.reconnecting = stalled;
      this.hooks.status(stalled);
    }
  }

  /** the discrete state (score, state, server…) of one snapshot into the shadow match */
  private apply(s: Snap) {
    const m = this.match;
    const st = STATES[s.state] ?? 'play';
    if (m.state !== st) {
      m.state = st;
      m.stateT0 = s.t;
    }
    m.server = m.players[s.server] ?? m.server;
    m.second = s.second;
    m.rally = s.rally;
    m.excitement = s.excitement;
    m.pointWinner = s.pointWinner as 0 | 1;
    m.resetKeepScore = s.keepScore;
    const c = m.score;
    c.points[0] = s.points[0];
    c.points[1] = s.points[1];
    c.games[0] = s.games[0];
    c.games[1] = s.games[1];
    c.totalGames = s.games[0] + s.games[1];
    c.server = s.scoreServer as 0 | 1;
    c.serverIdx[0] = s.serverIdx[0];
    c.serverIdx[1] = s.serverIdx[1];
    c.faults = s.faults;
    c.winner = s.winner as -1 | 0 | 1;
    m.ball.holder = s.holder >= 0 ? (m.players[s.holder] ?? null) : null;
    m.ball.visible = s.ballVisible;
    m.ball.live = s.ballLive;
  }

  /**
   * The newest snapshot whose segment has started by sim time `t`, and the one whose racket magnet is on at `t`
   * (searching back from a few snapshots after `near`, the one at that time).
   */
  private pickBall(m: Match, sync: BallSync, t: number, near: Snap, slack = SEG_SLACK) {
    let X = near;
    let Z: Snap['warp'] | null = null;
    let foundX = false;
    // (a snapshot taken at exactly this time knows whether the racket magnet was on then)
    let exact: Snap | null = null;
    for (let s = Math.min(this.serial, near.serial + AHEAD), n = 0; s >= 1 && n < SCAN && this.at(s).serial === s; s--, n++) {
      const S = this.at(s);
      if (!foundX && S.seg.t0 <= t + slack) {
        X = S;
        foundX = true;
      }
      if (!Z && isMagnet(S.warp) && S.warp.t0 <= t && t < S.warp.tc) Z = S.warp;
      if (!exact && S.t === t) exact = S;
      if (foundX && (Z || n > 6) && (exact || S.t < t)) break;
    }
    if (exact) Z = isMagnet(exact.warp) && exact.warp.t0 <= t && t < exact.warp.tc ? exact.warp : null;
    else if (!Z) Z = this.hitWarps.find((w) => w.t0 <= t && t < w.tc) ?? null;
    sync.set(m, X, Z);
  }

  /** a smash chance being staged: what Match.smashChance reads */
  private smashCue(s: Snap) {
    const m = this.match;
    const c = s.cue;
    for (const p of m.players) {
      p.plan = null;
      p.smashCalled = null;
    }
    if (c.p < 0 || m.state !== 'play') return;
    const p = m.players[c.p];
    if (!p) return;
    const pl = this.plan;
    pl.t = c.t;
    pl.bx = c.bx;
    pl.by = c.by;
    pl.bz = c.bz;
    pl.sx = c.sx;
    pl.sz = c.sz;
    p.plan = pl;
    p.smashCalled = pl;
    m.ball.live = true;
  }

  /** poses between A and B (u), into `poses` and the players' x / z / yaw */
  private mix(A: Snap, B: Snap | null, u: number) {
    const m = this.match;
    const n = Math.min(this.poses.length, A.n);
    for (let i = 0; i < n; i++) {
      const a = A.poses[i];
      const bb = B && i < B.n ? B.poses[i] : a;
      // a teleport (players are placed between points) isn't a run: no slide
      const k = Math.hypot(bb.x - a.x, bb.z - a.z) > 1.5 ? (u < 0.5 ? 0 : 1) : u;
      const o = this.poses[i];
      lerpPose(o, a, bb, k);
      const p = m.players[i];
      p.x = o.x;
      p.z = o.z;
      p.yaw = o.yaw;
    }
  }

  private runTimeline() {
    const q = this.timeline;
    while (q.length && q[0].wall <= this.wR) {
      const { msg } = q.shift()!;
      if (msg.type === 'world') this.hooks.world(msg.world, msg.transition, msg.origin, msg.at);
      else if (msg.type === 'hud') this.hooks.hud(msg.text, msg.sub, msg.cls);
      else {
        this.ended = true;
        if (this.reconnecting) {
          this.reconnecting = false;
          this.hooks.status(false);
        }
        this.hooks.end(msg);
      }
    }
  }

  private toMatchEvent(ev: NetEvent): MatchEvent | null {
    const pl = this.match.players;
    const P = (i: number) => pl[i];
    switch (ev.type) {
      case 'hit': {
        const p = P(ev.p);
        if (!p) return null;
        const e: MatchEvent = { type: 'hit', p, power: ev.power, spin: ev.spin, perfect: ev.perfect, kind: ev.kind, stroke: ev.stroke as Stroke, pos: ev.pos, kph: ev.kph, rally: ev.rally, tau: ev.tau, serve: ev.serve, dtMs: ev.dtMs, aim: ev.aim, crossed: ev.crossed, shotSpin: ev.shotSpin, rocket: ev.rocket };
        return e;
      }
      case 'whiff': {
        const p = P(ev.p);
        return p ? { type: 'whiff', p, tau: ev.tau, dtMs: ev.dtMs, why: ev.why as 'early' | 'late' | 'reach' | 'noball' | undefined } : null;
      }
      case 'toss':
      case 'tired':
      case 'smash-chance':
      case 'catch': {
        const p = P(ev.p);
        return p ? { type: ev.type, p } : null;
      }
      case 'athletic': {
        const p = P(ev.p);
        return p ? { type: 'athletic', p, move: ev.move as 'lunge' | 'dive' | 'jump' } : null;
      }
      case 'land': {
        const p = P(ev.p);
        return p ? { type: 'land', p, pos: ev.pos } : null;
      }
      case 'bounce':
        return { type: 'bounce', pos: ev.pos, impact: ev.impact, live: ev.live, out: ev.out, first: ev.first };
      case 'net':
        return { type: 'net', pos: ev.pos, cord: ev.cord, over: ev.over };
      case 'close-call':
        return { type: 'close-call', pos: ev.pos };
      case 'let':
        return { type: 'let' };
      case 'fault':
        return { type: 'fault', double: ev.double, reason: ev.reason as 'net' | 'out' };
      case 'point': {
        let call: string;
        if (ev.matchWon) call = 'Game, set and match';
        else if (ev.gameWon) call = 'Game';
        else {
          this.scratch.points = [ev.points[0], ev.points[1]];
          this.scratch.server = ev.server;
          call = this.scratch.call();
        }
        return { type: 'point', winner: ev.winner, reason: ev.reason as PointReason, rally: ev.rally, call, gameWon: ev.gameWon, matchWon: ev.matchWon, lastHitter: ev.lastHitter >= 0 ? (P(ev.lastHitter) ?? null) : null };
      }
      case 'serve-ready': {
        const p = P(ev.p);
        return p ? { type: 'serve-ready', p, second: ev.second } : null;
      }
      case 'state':
        return { type: 'state', state: ev.state as Match['state'] };
    }
  }

  // ---------------------------------------------------------------- measuring

  /**
   * Where the ball is at simulation time `t`, from the snapshots held (for tests: compare it with what
   * the host drew then). False if `t` is beyond the newest snapshot or before the oldest still held.
   */
  ballAtSimTime(t: number, out: V3): boolean {
    if (!this.serial) return false;
    const lo = Math.max(1, this.serial - RING + 1);
    if (t < this.at(lo).t || t > this.at(this.serial).t) return false;
    const pr = (this.probe ??= { m: shadowMatch(this.start), sync: new BallSync() });
    let a = this.serial;
    while (a > lo && this.at(a).t > t) a--;
    const A = this.at(a);
    const st = STATES[A.state] ?? 'play';
    pr.m.state = st;
    pr.m.ball.holder = A.holder >= 0 ? (pr.m.players[A.holder] ?? null) : null;
    pr.sync.segSerial = -1;
    this.pickBall(pr.m, pr.sync, t, A, 1e-6);
    if (pr.m.ball.holder) return false;
    pr.m.ballView(t, out);
    return true;
  }

  /** forget the delay samples so far (to measure a stretch of its own) */
  resetDelay() {
    this.nOne = 0;
    this.oneWay.length = 0;
  }

  get stats(): GuestStats {
    const n = Math.min(this.nOne, this.oneWay.length);
    const v = this.oneWay.slice(0, n).sort((x, y) => x - y);
    const q = (p: number) => (n ? v[Math.min(n - 1, Math.floor(p * n))] : 0);
    const p50 = q(0.5);
    return {
      oneWay: { p50, p90: q(0.9), max: n ? v[n - 1] : 0, n },
      buffer: this.buffer,
      snapshotInterval: this.interval(),
      dropped: this.dropped,
      lateEvents: this.late,
      snapshots: this.serial,
      resyncs: this.resyncs,
      holds: this.holds,
      heldMs: this.heldMs,
      renderLag: p50 + this.buffer,
      reconnecting: this.reconnecting,
    };
  }
}

// ---------------------------------------------------------------- interpolation

const lv = (o: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, u: number) => {
  o.x = a.x + (b.x - a.x) * u;
  o.y = a.y + (b.y - a.y) * u;
  o.z = a.z + (b.z - a.z) * u;
};
const lu = (o: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, u: number) => {
  lv(o, a, b, u);
  const l = Math.hypot(o.x, o.y, o.z) || 1;
  o.x /= l;
  o.y /= l;
  o.z /= l;
};

/** Pose `o` = a → b at u: numbers and points blend (directions renormalised); enums and flags take the nearer. */
export function lerpPose(o: Pose, a: NetPose, b: NetPose, u: number) {
  const f = (x: number, y: number) => x + (y - x) * u;
  o.x = f(a.x, b.x);
  o.z = f(a.z, b.z);
  o.yaw = f(a.yaw, b.yaw);
  o.hop = f(a.hop, b.hop);
  lv(o.body, a.body, b.body, u);
  o.bodyPitch = f(a.bodyPitch, b.bodyPitch);
  o.bodyYaw = f(a.bodyYaw, b.bodyYaw);
  o.bodyRoll = f(a.bodyRoll, b.bodyRoll);
  o.squash = f(a.squash, b.squash);
  o.headPitch = f(a.headPitch, b.headPitch);
  o.headYaw = f(a.headYaw, b.headYaw);
  o.headRoll = f(a.headRoll, b.headRoll);
  lv(o.hands[0], a.hands[0], b.hands[0], u);
  lv(o.hands[1], a.hands[1], b.hands[1], u);
  lu(o.racketDir, a.racketDir, b.racketDir, u);
  lu(o.racketFace, a.racketFace, b.racketFace, u);
  lv(o.feet[0], a.feet[0], b.feet[0], u);
  lv(o.feet[1], a.feet[1], b.feet[1], u);
  o.footPitch[0] = f(a.footPitch[0], b.footPitch[0]);
  o.footPitch[1] = f(a.footPitch[1], b.footPitch[1]);
  o.legLift = f(a.legLift, b.legLift);
  o.brow = f(a.brow, b.brow);
  o.blink = f(a.blink, b.blink);
  o.tired = f(a.tired, b.tired);
  const n = u < 0.5 ? a : b;
  o.eyes = n.eyes as Pose['eyes'];
  o.mouth = n.mouth as Pose['mouth'];
  o.holdingBall = n.holdingBall;
  o.handed = n.handed;
}
