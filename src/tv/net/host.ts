// The host side of an online match: while this TV simulates a tennis match and guest TVs are
// in its room, it streams the match to them (src/shared/net.ts): a `start` message, a binary
// snapshot ~30 times a second and at every match event, a `world` message when a Kaleido shift
// begins and an `end`. The guests never simulate; they render what arrives.
//
// Cost: encoding a snapshot is ~10 µs into a preallocated buffer (the outgoing frame is one small
// ArrayBuffer copy of it: a send may queue it, so the working buffer is not handed out), and nothing
// is encoded at all unless this TV is hosting and has guests.

import * as THREE from 'three';
import type { App } from '../app';
import type { Match, MatchConfig, MatchEvent } from '../tennis/match';
import { NET_VERSION, STATES, NetWriter, encodeSnap, newSnap, type NetEnd, type NetEvent, type NetMsg, type NetPlayerSpec, type NetPose, type NetStart, type NetTeam, type NetWorld } from '../../shared/net';
import type { HostToGuest } from '../../shared/protocol';

/** the least time between regular snapshots, ms: every other frame at 60 fps, every frame below ~38 */
const TICK_MS = 26;
/** a hit that resolved the moment it was heard (a person's swing already made) has no racket magnet: t0 = tc */
const MIN_MAGNET = 0.005;

export class NetHost {
  /** set by the flow: is Kaleido (worlds shifting mid-match) on? */
  kaleido: () => boolean = () => false;
  /** what the stream has cost (for tests and tuning) */
  stats = { snapshots: 0, bytes: 0, starts: 0, lastBytes: 0, encodeMsAvg: 0, encodeMsMax: 0, encodeMsTotal: 0 };
  /** the clocks (a test runs on its own; the encoder's own cost is always timed for real) */
  clock = { perf: () => performance.now(), date: () => Date.now() };
  private encTimes = new Float32Array(512);
  private encN = 0;
  private w = new NetWriter();
  private snap = newSnap();
  private seq = 0;
  /** the match being streamed (null: none, or not a match to stream) */
  private m: Match | null = null;
  private cfg: MatchConfig | null = null;
  private id = 0;
  private hostT0 = 0;
  private needStart = false;
  private over = false;
  private lastSend = 0;
  /** the swing whose racket "magnet" the guests were last told about (it lasts ~30 ms: shorter than a tick) */
  private warpSent: object | null = null;
  private events: NetEvent[] = [];
  private guestKey = '';
  private world = '';
  private startMsg: NetStart | null = null;
  /** the flow's Kaleido shift, as it begins: the spot in the court the world shatters from (the next `world` message carries it) */
  private shiftAt: { at: { x: number; y: number; z: number }; ms: number } | null = null;

  constructor(private app: App) {}

  /** hosting with guests present: the only time anything is encoded */
  private get hosting() {
    const l = this.app.link;
    return l.role === 'host' && l.guests.length > 0;
  }

  /** the host's clock in the room's time, ms */
  private now() {
    return this.clock.date() + this.app.link.serverOffset;
  }

  private wall() {
    return Math.max(0, Math.round(this.now() - this.hostT0));
  }

  private send(data: HostToGuest | ArrayBuffer) {
    this.app.link.toGuests(data);
  }

  private sendMsg(msg: NetMsg) {
    this.send({ type: 'net', msg });
  }

  /** what fill + encode + the frame copy took, ms, over the last 512 snapshots: median and 99th percentile */
  encodeTimes() {
    const n = Math.min(this.encN, 512);
    const v = Array.from(this.encTimes.subarray(0, n)).sort((a, b) => a - b);
    return { n, p50: n ? v[n >> 1] : 0, p99: n ? v[Math.min(n - 1, Math.floor(n * 0.99))] : 0 };
  }

  // ---------------------------------------------------------------- lifecycle

  /** A match has begun on this TV (App.startMatch). Attract and practice matches aren't streamed. */
  begin(m: Match, cfg: MatchConfig, worldId: string) {
    this.stop();
    if (cfg.attract || cfg.practice || this.app.link.role !== 'host') return;
    this.m = m;
    this.cfg = cfg;
    this.hostT0 = this.now();
    this.id = this.hostT0;
    this.over = false;
    this.warpSent = null;
    this.needStart = true;
    this.seq = 0;
    this.lastSend = 0;
    this.events.length = 0;
    this.world = worldId;
    this.guestKey = '';
    this.startMsg = null;
    this.shiftAt = null;
  }

  /** The match is over here (a rematch, quitting to the menu, another sport): tell the guests if it was still going. */
  stop() {
    if (this.m && !this.over && !this.needStart && this.hosting) this.sendEnd(-1);
    this.m = null;
    this.cfg = null;
    this.startMsg = null;
    this.events.length = 0;
  }

  private sendEnd(winner: -1 | 0 | 1) {
    const m = this.m!;
    const end: NetEnd = { type: 'end', id: this.id, t: m.t, wall: this.wall(), winner, games: [m.score.games[0], m.score.games[1]], teamNames: [...m.score.names] as [string, string] };
    this.sendMsg(end);
    this.over = true;
  }

  // ---------------------------------------------------------------- the messages

  private buildStart(): NetStart {
    const cfg = this.cfg!;
    const m = this.m!;
    const seats = this.app.input.seats;
    const hasHuman = (t: 0 | 1) => cfg.players.some((p) => p.team === t && p.ctrl.kind === 'human');
    // (the same colours the flow gives the HUD: the first person's on each side, the CPU's grey)
    const teams = [0, 1].map((t): NetTeam => {
      const first = cfg.players.find((p) => p.team === t && p.ctrl.kind === 'human');
      const color = first && first.ctrl.kind === 'human' ? (seats[first.ctrl.slot]?.color ?? '#3aa8ff') : '#6c6a84';
      return { name: m.score.names[t], color };
    }) as [NetTeam, NetTeam];
    const warm = (c: string) => {
      const col = new THREE.Color(c);
      return col.r > col.b;
    };
    const c0 = hasHuman(0) ? teams[0].color : warm(teams[1].color) ? '#3aa8ff' : '#ff5a8c';
    const c1 = hasHuman(1) ? teams[1].color : warm(c0) ? '#3aa8ff' : '#ff5a8c';
    const players: NetPlayerSpec[] = cfg.players.map((p) => ({
      team: p.team,
      name: p.name,
      look: JSON.parse(JSON.stringify(p.look)),
      handed: p.handed,
      human: p.ctrl.kind === 'human',
      slot: p.ctrl.kind === 'human' ? p.ctrl.slot : -1,
    }));
    return {
      type: 'start',
      v: NET_VERSION,
      id: this.id,
      sport: 'tennis',
      world: this.world,
      hostT0: this.hostT0,
      doubles: cfg.doubles,
      gamesToWin: cfg.gamesToWin,
      firstServer: cfg.firstServer ?? 0,
      seed: cfg.seed ?? 0,
      timingScale: cfg.timingScale,
      introTime: cfg.introTime,
      teamNames: [m.score.names[0], m.score.names[1]],
      teams,
      halo: [c0, c1],
      kaleido: this.kaleido(),
      players,
      ...(cfg.rush ? { rush: true } : {}),
    };
  }

  /** A Kaleido shift is about to begin from this spot in the court (Flow.shiftWorld): the guests' shatter starts from it too. */
  shiftFrom(at: { x: number; y: number; z: number }) {
    this.shiftAt = { at: { x: at.x, y: at.y, z: at.z }, ms: this.clock.perf() };
  }

  /** a caption for the guests' HUD that no match event carries */
  hud(text: string, sub?: string, cls?: string) {
    if (!this.m || !this.hosting || this.needStart) return;
    this.sendMsg({ type: 'hud', id: this.id, wall: this.wall(), text, sub, cls });
  }

  // ---------------------------------------------------------------- per event / per frame

  /** A match event (App.event, as it happens): kept for the next snapshot, which goes out this frame. */
  event(e: MatchEvent) {
    const m = this.m;
    if (!m || !this.hosting) return;
    const t = m.t;
    const p = (q: { id: number } | null | undefined) => (q ? q.id : -1);
    let n: NetEvent;
    switch (e.type) {
      case 'hit': {
        const sw = e.p.swing;
        n = { type: 'hit', t, p: p(e.p), warp: sw && sw.hit && sw.tc - sw.t0 >= MIN_MAGNET ? { t0: sw.t0, tc: sw.tc } : undefined, power: e.power, spin: e.spin, perfect: e.perfect, kind: e.kind, stroke: e.stroke, pos: e.pos, kph: e.kph, rally: e.rally, tau: e.tau, serve: e.serve, dtMs: e.dtMs, aim: e.aim, crossed: e.crossed, shotSpin: e.shotSpin, rocket: e.rocket };
        break;
      }
      case 'whiff':
        n = { type: 'whiff', t, p: p(e.p), tau: e.tau, dtMs: e.dtMs, why: e.why };
        break;
      case 'toss':
      case 'tired':
      case 'smash-chance':
      case 'catch':
        n = { type: e.type, t, p: p(e.p) };
        break;
      case 'athletic':
        n = { type: 'athletic', t, p: p(e.p), move: e.move };
        break;
      case 'land':
        n = { type: 'land', t, p: p(e.p), pos: e.pos };
        break;
      case 'bounce':
        n = { type: 'bounce', t, pos: e.pos, impact: e.impact, live: e.live, out: e.out, first: e.first };
        break;
      case 'net':
        n = { type: 'net', t, pos: e.pos, cord: e.cord, over: e.over };
        break;
      case 'close-call':
        n = { type: 'close-call', t, pos: e.pos };
        break;
      case 'let':
        n = { type: 'let', t };
        break;
      case 'fault':
        n = { type: 'fault', t, double: e.double, reason: e.reason };
        break;
      case 'point':
        n = { type: 'point', t, winner: e.winner, reason: e.reason, rally: e.rally, gameWon: e.gameWon, matchWon: e.matchWon, lastHitter: p(e.lastHitter), points: [m.score.points[0], m.score.points[1]], server: m.score.server };
        break;
      case 'serve-ready':
        n = { type: 'serve-ready', t, p: p(e.p), second: e.second };
        break;
      case 'state':
        n = { type: 'state', t, state: e.state };
        break;
      default:
        return;
    }
    this.events.push(n);
  }

  /**
   * Once per frame, after the match has stepped and the poses are made: stream. `poses` are the
   * ones drawn this frame (the animators' own).
   */
  frame(poses: NetPose[]) {
    const m = this.m;
    if (!m || this.over) return;
    if (!this.hosting) {
      // (nobody to tell: keep no backlog of events)
      this.events.length = 0;
      this.guestKey = '';
      return;
    }
    // a guest joined (or left): whoever is new needs the `start` (the others ignore a repeat)
    const key = this.app.link.guests.map((g) => g.gid).join(',');
    if (this.needStart || key !== this.guestKey) {
      if (this.needStart) this.hostT0 = this.id = this.now();
      this.guestKey = key;
      this.startMsg = this.buildStart();
      this.sendMsg(this.startMsg);
      this.stats.starts++;
      this.needStart = false;
    }
    // a Kaleido shift began (or the world changed some other way)
    const st = this.app.stage;
    const target = st.next?.def.id ?? st.current?.def.id ?? this.world;
    if (target !== this.world) {
      this.world = target;
      const msg: NetWorld = { type: 'world', id: this.id, wall: this.wall(), world: target, transition: !!st.next };
      // (a shift the flow just began says where from; a world change of any other kind shatters from the middle)
      const sa = this.shiftAt;
      if (sa && st.next && this.clock.perf() - sa.ms < 1500) {
        const p = this.app.rig.project(sa.at);
        msg.at = sa.at;
        msg.origin = { x: +p.x.toFixed(4), y: +p.y.toFixed(4) };
      }
      this.shiftAt = null;
      this.sendMsg(msg);
    }
    const ended = m.state === 'over';
    const now = this.clock.perf();
    const due = now - this.lastSend >= TICK_MS;
    // a hit being lined up begins: the guests need to hear of it while it lasts, whatever the tick
    const ph = m.pendingHit;
    const sw = ph?.swing && !ph.swing.resolved ? ph.swing : null;
    const warpNew = !!sw && sw !== this.warpSent && sw.tc - sw.t0 >= MIN_MAGNET;
    this.warpSent = sw;
    if (!this.events.length && !due && !ended && !warpNew) return;
    this.lastSend = now;
    const t0 = performance.now();
    const s = this.snap;
    s.seq = this.seq++ & 0xffff;
    s.ev = this.events.length > 0;
    s.t = m.t;
    s.wall = this.wall();
    s.state = Math.max(0, STATES.indexOf(m.state));
    s.server = m.server ? m.server.id : -1;
    s.holder = m.ball.holder ? m.ball.holder.id : -1;
    s.excitement = m.excitement;
    s.rally = m.rally;
    s.pointWinner = m.pointWinner;
    s.winner = m.score.winner;
    s.replay = !!this.app.replay;
    s.scoreServer = m.score.server;
    s.serverIdx[0] = m.score.serverIdx[0];
    s.serverIdx[1] = m.score.serverIdx[1];
    s.faults = m.score.faults;
    s.points[0] = m.score.points[0];
    s.points[1] = m.score.points[1];
    s.games[0] = m.score.games[0];
    s.games[1] = m.score.games[1];
    s.second = m.second;
    s.keepScore = m.resetKeepScore;
    s.ballVisible = m.ball.visible;
    s.ballLive = m.ball.live;
    const g = m.ball.seg;
    const o = s.seg;
    o.t0 = g.t0;
    o.px = g.px;
    o.py = g.py;
    o.pz = g.pz;
    o.vx = g.vx;
    o.vy = g.vy;
    o.vz = g.vz;
    o.g = g.g;
    o.k = g.k;
    o.spin = g.spin;
    o.wob = g.wob ?? 0;
    // the racket "magnet": the ball is being drawn to a swing that hasn't landed yet
    if (ph && sw) {
      const k = s.warp;
      k.p = ph.id;
      k.t0 = sw.t0;
      k.tc = sw.tc;
      k.cx = sw.cx;
      k.cy = sw.cy;
      k.cz = sw.cz;
    } else s.warp.p = -1;
    const cue = this.app.smashCue;
    if (cue) {
      const c = s.cue;
      c.p = cue.p.id;
      c.t = cue.plan.t;
      c.bx = cue.plan.bx;
      c.by = cue.plan.by;
      c.bz = cue.plan.bz;
      c.sx = cue.plan.sx;
      c.sz = cue.plan.sz;
    } else s.cue.p = -1;
    s.n = Math.min(poses.length, m.players.length);
    s.poses = poses;
    s.events = this.events;
    const len = encodeSnap(this.w, s);
    const frame = this.w.frame();
    const ms = performance.now() - t0;
    if (this.events.length) this.events = [];
    this.stats.snapshots++;
    this.stats.bytes += len;
    this.stats.lastBytes = len;
    this.stats.encodeMsAvg += (ms - this.stats.encodeMsAvg) * 0.02;
    this.stats.encodeMsMax = Math.max(this.stats.encodeMsMax, ms);
    this.stats.encodeMsTotal += ms;
    this.encTimes[this.encN++ & 511] = ms;
    this.send(frame);
    if (ended && !this.over) {
      this.sendEnd(m.score.winner as -1 | 0 | 1);
    }
  }
}
