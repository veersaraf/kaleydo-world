// Top-level TV application: renderer, main loop, match lifecycle.

import * as THREE from 'three';
import { Stage } from './render/stage';
import { Quality, LEVELS } from './render/quality';
import { newPose, copyPose } from './chars/pose';
import { WORLDS } from './worlds';
import { CameraRig } from './tennis/camera';
import { Match, type MatchConfig, type MatchEvent, type PlayerSpec } from './tennis/match';
import { segVel } from './tennis/ball';
import { Animator } from './chars/anim';
import { TVLink } from './core/link';
import { Input, type SwingEv } from './core/input';
import { AI_LEVELS } from './tennis/ai';
import { randomLook, playerLook, type Look } from './chars/look';
import { Rng, clamp } from './core/math';
import type { FrameView } from './worlds/base';
import type { Pose } from './chars/pose';
import type { MatchState } from './tennis/match';
import type { V3 } from './core/math';

export class App {
  renderer: THREE.WebGLRenderer;
  stage: Stage;
  rig = new CameraRig();
  /** the second player's camera, behind the far baseline (split screen) */
  rig2 = new CameraRig(1);
  link = new TVLink();
  input: Input;
  match: Match | null = null;
  anims: Animator[] = [];
  attract = true;
  paused = false;
  private last = 0;
  private lastRender = 0;
  private hitstop = 0;
  realT = 0;
  private rng = new Rng();
  pr = 1;
  /** resolution/MSAA governor */
  quality: Quality;
  onMatchEvent: (e: MatchEvent) => void = () => {};
  onFrame: (dt: number) => void = () => {};
  /** provided by the audio layer: 0..1 pulse on the beat */
  beat: () => number = () => 0;
  worldId = 'plaza';
  /** player preference: give each side its own view in local versus */
  splitPref = true;
  /** this match wants a split screen (humans on both teams) */
  split = false;
  /** split screen is on right now (not during replays, menus…) */
  splitOn = false;
  onSplit: (on: boolean) => void = () => {};

  // ---- instant replay
  private rec: RecFrame[] = [];
  /** recycled replay frames (recording allocates nothing in steady state) */
  private recPool: RecFrame[] = [];
  private pendingEvents: MatchEvent[] = [];
  replay: { frames: RecFrame[]; i: number; time: number; end: number; side: number } | null = null;
  onReplayEvent: (e: MatchEvent) => void = () => {};
  onReplayEnd: () => void = () => {};

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000, 1);
    // a failed shader is a bug caught in development; in the game, checking every
    // program's log forces a synchronous compile (a hitch)
    this.renderer.debug.checkShaderErrors = !!import.meta.env.DEV;
    this.stage = new Stage(this.renderer, WORLDS);
    this.quality = new Quality(this.renderer, window.devicePixelRatio || 1);
    this.pr = this.quality.current.pr;
    this.stage.msaa = this.quality.current.msaa;
    this.input = new Input(this.link);
    this.input.onSwing = (e) => this.swing(e);
    this.input.onToss = (slot) => this.match && !this.paused && this.match.humanToss(slot);
    this.input.onPrep = (slot, side) => this.match && !this.paused && !this.attract && this.match.humanPrep(slot, side);
    this.link.onMessage = (m) => {
      if (m.type === 'hello') {
        for (const p of m.pads) this.input.padJoin(p.pid, p.name, p.transport);
      } else if (m.type === 'pad-join') this.input.padJoin(m.pid, m.name, m.transport);
      else if (m.type === 'pad-leave') this.input.padLeave(m.pid);
      else if (m.type === 'pad') this.input.padMsg(m.pid, m.rt, m.msg);
    };
    this.link.connect();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.renderer.setSize(Math.floor(w * this.pr), Math.floor(h * this.pr), false);
    this.stage.resize(w, h, this.pr);
    this.applyViews();
  }

  private applyViews() {
    this.stage.setViews(this.splitOn ? 2 : 1);
    const a = this.stage.vw / this.stage.h;
    this.rig.aspect = a;
    this.rig2.aspect = a;
    this.rig.split = this.splitOn;
    this.rig2.split = this.splitOn;
  }

  // ---------------------------------------------------------------- matches

  startAttract(worldId = this.worldId) {
    const doubles = this.rng.chance(0.3);
    const players: PlayerSpec[] = [];
    for (const team of [0, 1] as const) {
      for (let i = 0; i < (doubles ? 2 : 1); i++) {
        const look = randomLook(this.rng);
        players.push({ team, name: 'CPU', look, handed: this.rng.chance(0.15) ? -1 : 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[this.rng.pick(['pro', 'ace', 'club'])] } });
      }
    }
    this.attract = true;
    this.begin({ doubles, gamesToWin: 2, players, attract: true }, worldId);
    this.rig.setMode('attract');
  }

  startMatch(cfg: MatchConfig, worldId: string) {
    this.attract = false;
    this.begin(cfg, worldId);
    this.rig.setMode('intro');
    // restart the second camera's fly-in too
    this.rig2.setMode('menu');
    this.rig2.setMode('intro');
  }

  private begin(cfg: MatchConfig, worldId: string) {
    this.replay = null;
    for (const f of this.rec) this.recPool.push(f);
    this.rec.length = 0;
    this.pendingEvents = [];
    this.match = new Match(cfg);
    this.match.onEvent = (e) => this.event(e);
    const humans = (team: number) => this.match!.players.some((p) => p.human && p.team === team);
    this.split = !cfg.attract && !cfg.practice && this.splitPref && humans(0) && humans(1);
    this.anims = this.match.players.map((p) => new Animator(p));
    this.stage.setPlayers(this.match.players.map((p) => p.look));
    this.worldId = worldId;
    this.stage.setWorld(worldId);
    this.hitstop = 0;
  }

  /** Human player spec helper. */
  humanSpec(slot: number, team: 0 | 1): PlayerSpec {
    const seat = this.input.seats[slot];
    const color = seat?.color ?? '#ff5a6e';
    const look: Look = playerLook(color, hashStr(seat?.pid ?? `local${slot}`));
    if (seat?.look) {
      const L = seat.look;
      if (L.hair) look.hair = L.hair as Look['hair'];
      if (L.hairColor) look.hairColor = L.hairColor;
      if (L.skin) look.skin = L.skin;
      if (L.eyes) look.eyes = L.eyes as Look['eyes'];
    }
    return {
      team,
      name: seat?.name ?? `Player ${slot + 1}`,
      look,
      handed: seat?.handed === 'L' ? -1 : 1,
      ctrl: { kind: 'human', slot, ai: AI_LEVELS.auto },
    };
  }

  private swing(e: SwingEv) {
    const m = this.match;
    if (!m || this.paused || this.attract) return;
    if (e.source === 'mouse' && !this.input.mouseSwings) return;
    m.humanSwing(e.slot, { power: e.power, spin: e.spin, side: e.side, path: e.path }, m.t - clamp(e.age, 0, 0.16));
  }

  private event(e: MatchEvent) {
    const m = this.match!;
    if (!this.attract && (e.type === 'hit' || e.type === 'bounce' || e.type === 'net')) this.pendingEvents.push(e);
    if (e.type === 'hit') {
      if (m.hitstop > 0) {
        this.hitstop = m.hitstop;
        m.hitstop = 0;
      }
      const k = e.kind === 'smash' ? 0.8 : e.rocket ? 0.65 : e.power > 0.85 || e.perfect ? 0.35 : 0.06;
      this.rig.kick(k);
      this.rig2.kick(k);
    }
    if (e.type === 'net' && !e.over) {
      this.rig.kick(0.15);
      this.rig2.kick(0.15);
    }
    for (const w of [this.stage.current, this.stage.next]) w?.onEvent(e);
    this.onMatchEvent(e);
  }

  // ---------------------------------------------------------------- loop

  start() {
    const tick = (now: number) => {
      requestAnimationFrame(tick);
      // 120 Hz+ screens: draw every other refresh — a steady 60 beats a wobbly 90
      if (this.lastRender && now - this.lastRender < 12.5) return;
      this.lastRender = now;
      this.frame(now);
    };
    requestAnimationFrame(tick);
  }

  /** Apply the quality controller's level: render scale + MSAA. */
  private applyQuality() {
    const L = LEVELS[this.quality.level];
    this.pr = L.pr;
    this.stage.msaa = L.msaa;
    this.resize();
  }

  /** Replay the recorded sim-time window [from, to] in slow motion. */
  startReplay(from: number, to: number): boolean {
    const frames = this.rec.filter((f) => f.t >= from && f.t <= to);
    if (frames.length < 40) return false;
    const last = frames[frames.length - 1];
    this.replay = { frames, i: 0, time: frames[0].t, end: last.t, side: last.ball.x >= 0 ? 1 : -1 };
    this.rig.replayStart();
    return true;
  }

  endReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.rig.setMode('play');
    this.onReplayEnd();
  }

  private replayFrame(realDt: number) {
    const r = this.replay!;
    const m = this.match!;
    if (this.splitOn) {
      this.splitOn = false;
      this.applyViews();
      this.onSplit(false);
    }
    // ease in and out of slow motion
    const u = (r.time - r.frames[0].t) / Math.max(0.1, r.end - r.frames[0].t);
    const speed = u < 0.12 || u > 0.92 ? 0.7 : 0.42;
    r.time += realDt * speed;
    while (r.i < r.frames.length - 1 && r.frames[r.i + 1].t <= r.time) {
      r.i++;
      for (const e of r.frames[r.i].events) this.onReplayEvent(e);
    }
    const f = r.frames[r.i];
    this.rig.replayUpdate(f.ball, realDt, r.side);
    const view: FrameView = {
      t: f.t,
      dt: realDt * speed,
      realT: this.realT,
      realDt,
      ball: f.ball,
      ballSpeed: f.speed,
      ballVisible: true,
      holder: f.holder,
      poses: f.poses,
      excitement: m.excitement,
      state: f.state,
      cam: this.rig.cam,
      beat: this.beat(),
    };
    this.stage.update(view);
    this.stage.render(this.rig.cam);
    this.onFrame(realDt);
    if (r.time >= r.end) this.endReplay();
  }

  frame(now: number) {
    const gapMs = this.last ? now - this.last : 0;
    const realDt = Math.min(0.1, Math.max(0, gapMs / 1000));
    this.last = now;
    this.realT += realDt;
    const m = this.match;
    if (!m || !this.stage.current) return;
    const wid = this.stage.current.def.id;
    if (wid !== this.quality.world) this.quality.setWorld(wid, now);
    this.quality.beginFrame();
    if (this.replay) this.replayFrame(realDt);
    else this.playFrame(m, realDt);
    this.quality.endFrame();
    if (!document.hidden) {
      // resizing costs a frame: only between points, in menus and replays (or when badly overloaded)
      const st = this.match?.state;
      const safe = this.attract || this.paused || !!this.replay || this.stage.transitioning === false && (st !== 'play' && st !== 'toss');
      if (this.quality.update(now, gapMs, safe) !== null) this.applyQuality();
    }
  }

  private playFrame(m: Match, realDt: number) {
    let simDt = this.paused ? 0 : realDt;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      simDt = 0;
    }
    // advance the simulation by exactly the time this frame covers (in steps of
    // at most 1/120 s). Fixed steps without interpolation made the ball move one
    // step on some frames and three on others — visible judder even at 60 fps.
    if (simDt > 0) {
      const n = Math.max(1, Math.ceil(simDt * 120 - 1e-6));
      const h = simDt / n;
      for (let i = 0; i < n; i++) m.step(h);
    }

    // split screen during play; replays, results and menus use the whole screen
    const split = this.split && !this.attract && (this.rig.mode === 'play' || this.rig.mode === 'intro');
    if (split !== this.splitOn) {
      this.splitOn = split;
      this.applyViews();
      this.onSplit(split);
    }
    this.rig.update(m, realDt, this.realT);
    if (split) {
      if (this.rig2.mode !== this.rig.mode) this.rig2.setMode(this.rig.mode);
      this.rig2.update(m, realDt, this.realT);
    }
    const ball = m.ballView(m.t, { x: 0, y: 0, z: 0 });
    let speed = 0;
    if (!m.ball.holder && m.state !== 'toss') {
      const v = segVel(m.ball.seg, m.t, { x: 0, y: 0, z: 0 });
      speed = Math.hypot(v.x, v.y, v.z);
    } else if (m.state === 'toss') speed = 0;
    const wall = performance.now();
    const poses = this.anims.map((a) => {
      const r = a.p.human ? this.input.racket[a.p.slot] : null;
      a.phone = r && wall - r.t < 400 ? r : null;
      return a.update(m.t, simDt || 1e-4, ball, m.state);
    });
    const view: FrameView = {
      t: m.t,
      dt: simDt,
      realT: this.realT,
      realDt,
      ball,
      ballSpeed: speed,
      ballVisible: true,
      holder: m.ball.holder ? m.players.indexOf(m.ball.holder) : -1,
      poses,
      excitement: m.excitement,
      state: m.state,
      cam: this.rig.cam,
      beat: this.beat(),
    };
    this.stage.update(view);
    this.stage.render(split ? [this.rig.cam, this.rig2.cam] : this.rig.cam);
    this.onFrame(realDt);
    // record for instant replays
    if (!this.attract) {
      const f = this.recPool.pop() ?? { t: 0, ball: { x: 0, y: 0, z: 0 }, speed: 0, holder: -1, poses: [], state: m.state, events: NO_EVENTS };
      f.t = m.t;
      f.ball.x = ball.x;
      f.ball.y = ball.y;
      f.ball.z = ball.z;
      f.speed = speed;
      f.holder = view.holder;
      f.state = m.state;
      while (f.poses.length < poses.length) f.poses.push(newPose());
      f.poses.length = poses.length;
      for (let i = 0; i < poses.length; i++) copyPose(f.poses[i], poses[i]);
      if (this.pendingEvents.length) {
        f.events = this.pendingEvents;
        this.pendingEvents = [];
      } else f.events = NO_EVENTS;
      this.rec.push(f);
      while (this.rec.length && this.rec[0].t < m.t - 10) this.recPool.push(this.rec.shift()!);
    }
  }
}

const NO_EVENTS: MatchEvent[] = [];

interface RecFrame {
  t: number;
  ball: V3;
  speed: number;
  holder: number;
  poses: Pose[];
  state: MatchState;
  events: MatchEvent[];
}

export function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
