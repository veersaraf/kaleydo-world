// Top-level TV application: renderer, main loop, match lifecycle.

import * as THREE from 'three';
import { Stage } from './render/stage';
import { Quality, LEVELS } from './render/quality';
import { BowlingGame, START_X, type Bowler, type BowlEvent } from './bowling/game';
import { BowlCamera } from './bowling/camera';
import { BowlPhysics } from './bowling/physics';
import { BowlVenue } from './bowling/venue';
import { BowlAnimator } from './bowling/anim';
import { BowlScore } from './bowling/score';
import { FOUL_Z } from './bowling/lane';
import type { BowlerState } from './bowling/types';
import { DuelGame } from './duel/game';
import { DuelCamera } from './duel/camera';
import { DuelVenue } from './duel/venue';
import { DuelAnimator } from './duel/anim';
import { DuelGear } from './duel/sword';
import { aimFromPhone, type Duelist, type DuelEvent, type SlashInput, type SwordAim } from './duel/types';
import { readyAim, guardAim, cockAim, newAim } from './duel/aim';
import type { World } from './worlds/base';
import { CHAR_SCALE } from './chars/rig';
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
  // ---- bowling
  sport: 'tennis' | 'bowling' | 'duel' = 'tennis';
  bowl: BowlingGame | null = null;
  bowlCam = new BowlCamera();
  private bowlAnims: BowlAnimator[] = [];
  private phys: BowlPhysics | null = null;
  onBowlEvent: (e: BowlEvent) => void = () => {};
  // ---- sword duel
  duel: DuelGame | null = null;
  duelCam = new DuelCamera();
  private duelAnims: DuelAnimator[] = [];
  /** per world: the fighters' swords, trails, stun stars and deck shadows */
  private duelGear = new Map<World, DuelGear>();
  /** a keyboard strike shows its windup for a moment first (the CPU reads swords) */
  private keySlash: { slot: number; attack: SlashInput; at: number } | null = null;
  private localSword = newAim();
  onDuelEvent: (e: DuelEvent) => void = () => {};

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
    this.stage.fx = this.quality.current.fx;
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
    this.bowlCam.aspect = this.stage.w / this.stage.h;
    this.duelCam.aspect = a;
    this.duelCam.split = this.splitOn;
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
    this.stopBowling();
    this.stopDuel();
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

  /** Apply the quality controller's level: render scale, MSAA and effects tier. */
  private applyQuality() {
    const L = LEVELS[this.quality.level];
    this.pr = L.pr;
    this.stage.msaa = L.msaa;
    this.stage.fx = L.fx;
    this.resize();
  }

  /** Force an effects tier (benchmarks, screenshots); the quality controller sets it otherwise. */
  setEffects(tier: number) {
    this.stage.setFx(tier);
  }

  /**
   * Depth of field for cutscenes and replays: focus on something `focus` metres
   * in front of the camera (along its view axis); null turns it off. Worlds that
   * offer it (effects.dof) blur; it costs nothing while off.
   */
  setDof(focus: number | null, aperture = 1) {
    // one object, updated in place: a replay may refocus every frame
    this.dofState.focus = focus ?? 0;
    this.dofState.aperture = aperture;
    this.stage.dof = focus === null ? null : this.dofState;
  }
  private dofState = { focus: 10, aperture: 1 };

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
    if (this.sport === 'bowling') {
      if (!this.bowl || !this.stage.current) return;
      this.quality.beginFrame();
      this.bowlFrame(realDt);
      this.quality.endFrame();
      if (!document.hidden) {
        const st = this.bowl.state;
        if (this.quality.update(now, gapMs, this.paused || (st !== 'approach' && st !== 'lane' && st !== 'pins')) !== null) this.applyQuality();
      }
      return;
    }
    if (this.sport === 'duel') {
      if (!this.duel || !this.stage.current) return;
      this.quality.beginFrame();
      this.duelFrame(realDt);
      this.quality.endFrame();
      if (!document.hidden && this.quality.update(now, gapMs, this.paused || this.duel.state !== 'fight') !== null) this.applyQuality();
      return;
    }
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

  // ---------------------------------------------------------------- sword duel

  /** Turn the current world's court into a duel arena and start a match. Two
   *  people on the same screen get half each. */
  startDuel(duelists: [Duelist, Duelist], worldId: string) {
    this.stopBowling();
    this.stopDuel();
    this.match = null;
    this.replay = null;
    this.attract = false;
    this.paused = false;
    this.bowl = null;
    this.sport = 'duel';
    this.input.bowlMode = false;
    this.input.duelMode = true;
    this.worldId = worldId;
    this.stage.setWorld(worldId);
    this.duel = new DuelGame(duelists);
    this.duel.onEvent = (e) => {
      // a new round puts everyone back on their marks: cut rather than glide
      if (e.type === 'round') this.duelCam.snap();
      if (e.type === 'hit') this.duelCam.kick(0.25 + e.strength * 0.45);
      else if (e.type === 'block' || e.type === 'clash') this.duelCam.kick(0.2);
      else if (e.type === 'splash') this.duelCam.kick(0.35);
      this.onDuelEvent(e);
    };
    this.duelAnims = duelists.map((d) => new DuelAnimator(d.handed, d.look));
    this.stage.setPlayers(duelists.map((d) => d.look));
    this.split = this.splitPref && duelists[0].cpu === null && duelists[1].cpu === null;
    this.splitOn = this.split;
    this.applyViews();
    this.duelCam.snap();
    this.prepareDuelWorld();
  }

  /** The world on screen shows the arena; its characters hold swords. */
  private prepareDuelWorld() {
    const w = this.stage.current;
    if (!w || !this.duel) return;
    if (w.sport !== 'duel') w.setSport('duel', (kit) => new DuelVenue(kit, { particles: w.particles, world: w.def.id }));
    if (!this.duelGear.has(w)) this.duelGear.set(w, new DuelGear(w, this.duel.duelists.map((d) => d.color)));
  }

  stopDuel() {
    if (this.sport !== 'duel') return;
    this.sport = 'tennis';
    this.input.duelMode = false;
    this.duel = null;
    this.split = false;
    if (this.splitOn) {
      this.splitOn = false;
      this.applyViews();
    }
    // swords back in the rack (rackets and shadows come back)
    for (const gear of this.duelGear.values()) gear.dispose();
    this.duelGear.clear();
    this.stage.forEachWorld((w) => {
      if (w.sport === 'duel') w.setSport('tennis');
    });
  }

  /** A keyboard strike: cocked for a moment (like a phone's backswing), then swung. */
  duelKeySlash(slot: number, attack: SlashInput) {
    if (!this.keySlash) this.keySlash = { slot, attack, at: this.realT + 0.18 };
  }

  /** the sword a keyboard/mouse player holds: at the ready, cocked for a keyboard strike,
   *  or across the body to guard (the mouse's angle, or Space's: across whatever the
   *  opponent is winding up) */
  private localAim(g: DuelGame, slot: number): SwordAim {
    const i = g.duelists.findIndex((d) => d.slot === slot);
    const me = g.fighters[i];
    const out = this.localSword;
    if (this.keySlash && this.keySlash.slot === slot) return cockAim(out, this.keySlash.attack);
    if (me?.phase !== 'guard') return readyAim(out);
    let a = this.input.localGuardAngle;
    if (a === null) {
      const them = g.fighters[1 - i];
      a = them?.attack && them.attack.kind === 'slash' ? Math.PI - them.attack.dir + Math.PI / 2 : Math.PI / 2;
    }
    return guardAim(out, a, me.handed);
  }

  private duelFrame(realDt: number) {
    const g = this.duel!;
    const w = this.stage.current!;
    this.prepareDuelWorld();
    const dt = this.paused ? 0 : Math.min(0.05, realDt);
    // the swords follow the phones (keyboard and mouse players get a held pose)
    const wall = performance.now();
    for (const d of g.duelists) {
      if (d.cpu !== null) continue;
      const r = this.input.racket[d.slot];
      const seat = this.input.seats[d.slot];
      if (r && wall - r.t < 400 && seat && !seat.local) g.aim(d.slot, aimFromPhone(r.s, r.n));
      else g.aim(d.slot, this.localAim(g, d.slot));
    }
    const ks = this.keySlash;
    if (ks && this.realT >= ks.at) {
      this.keySlash = null;
      g.slash(ks.slot, ks.attack);
    }
    if (dt > 0) g.step(dt);
    this.duelCam.update(g, realDt, this.realT);
    const poses = g.fighters.map((f, i) => this.duelAnims[i].update(g.t, Math.max(1e-4, dt), f));
    const view: FrameView = {
      t: g.t,
      dt,
      realT: this.realT,
      realDt,
      ball: { x: 0, y: -10, z: 0 },
      ballSpeed: 0,
      ballVisible: false,
      holder: -1,
      poses,
      excitement: g.state === 'fight' ? 0.55 : g.state === 'fall' || g.state === 'over' ? 1 : 0.3,
      state: 'play',
      cam: this.duelCam.cams[0],
      beat: this.beat(),
      duel: g.view(),
    };
    this.stage.update(view);
    this.duelGear.get(w)?.update(g.fighters, realDt, g.halfLength);
    this.stage.render(this.splitOn ? this.duelCam.cams : this.duelCam.cams[0]);
    this.onFrame(realDt);
  }

  // ---------------------------------------------------------------- bowling

  /** Turn the current world's court into lanes and start a game. */
  async startBowling(specs: Omit<Bowler, 'score' | 'x' | 'aim'>[], worldId: string) {
    this.phys ??= await BowlPhysics.load();
    this.stopDuel();
    this.match = null;
    this.replay = null;
    this.attract = false;
    this.paused = false;
    this.split = false;
    this.sport = 'bowling';
    this.input.bowlMode = true;
    this.worldId = worldId;
    this.stage.setWorld(worldId);
    const bowlers: Bowler[] = specs.map((b) => ({ ...b, score: new BowlScore(), x: START_X * b.handed, aim: 0 }));
    this.bowl = new BowlingGame(bowlers, this.phys);
    this.bowl.onEvent = (e) => {
      if (e.type === 'physics' && e.e.type === 'hit' && e.e.ballOnPin) this.bowlCam.kick(Math.min(0.6, e.e.impact * 0.06));
      this.onBowlEvent(e);
    };
    this.bowlAnims = bowlers.map((b) => new BowlAnimator(b.handed, b.look));
    this.stage.setPlayers(bowlers.map((b) => b.look));
    this.prepareBowlWorld();
  }

  /** The world on screen shows lanes; its characters put their rackets away. */
  private prepareBowlWorld() {
    const w = this.stage.current;
    if (!w) return;
    w.setSport('bowling', (kit) => new BowlVenue(kit));
    for (const r of w.rigs) r.racket.visible = false;
  }

  stopBowling() {
    if (this.sport !== 'bowling') return;
    this.sport = 'tennis';
    this.input.bowlMode = false;
    this.bowl = null;
    this.stage.forEachWorld((w) => {
      if (w.sport === 'bowling') w.setSport('tennis');
      for (const r of w.rigs) {
        r.racket.visible = true;
        r.hands[0].rotation.z = 0;
      }
    });
  }

  private bowlFrame(realDt: number) {
    const g = this.bowl!;
    const w = this.stage.current!;
    if (w.sport !== 'bowling') this.prepareBowlWorld();
    const dt = this.paused ? 0 : Math.min(0.05, realDt);
    if (dt > 0) g.step(dt);
    this.bowlCam.update(g, realDt, this.realT);
    // the bowler up, and the others waiting at the back of the approach, off to
    // the side and turned to watch (out of the aiming view's way)
    const poses = g.bowlers.map((b, i) => {
      const anim = this.bowlAnims[i];
      if (i === g.current) return anim.update(g.t, Math.max(1e-4, dt), g.body);
      const order = (i - g.current + g.bowlers.length) % g.bowlers.length;
      const side = order % 2 ? -1 : 1;
      const s: BowlerState = { x: side * (2.3 + Math.floor((order - 1) / 2) * 0.8), z: FOUL_Z + 7.2, yaw: side * 0.5, handed: b.handed, phase: 'idle', t: g.t, arm: 0, step: 0, holding: false, spin: 0 };
      return anim.update(g.t, Math.max(1e-4, dt), s);
    });
    // the ball rides in the bowler's hand until the release
    const venue = w.bowlVenue;
    if (venue) {
      const body = g.body;
      if (body.holding && (g.state === 'ready' || g.state === 'approach' || g.state === 'intro')) {
        const b = g.bowler;
        const hand = this.bowlAnims[g.current].ballHand();
        const sc = CHAR_SCALE * (b.look.height || 1);
        const c = Math.cos(body.yaw),
          sn = Math.sin(body.yaw);
        const pose = poses[g.current];
        this.tmpBall.set(body.x + (c * hand.x + sn * hand.z) * sc, pose.hop + hand.y * sc, body.z + (-sn * hand.x + c * hand.z) * sc);
        venue.holdBall(this.tmpBall);
      } else venue.holdBall(null);
      venue.setAim(g.state === 'ready' && g.bowler.cpu === null ? { x: g.releaseX(g.bowler), angle: g.bowler.aim } : null);
    }
    const view: FrameView = {
      t: g.t,
      dt,
      realT: this.realT,
      realDt,
      ball: { x: 0, y: -10, z: 0 },
      ballSpeed: 0,
      ballVisible: false,
      holder: -1,
      poses,
      excitement: g.state === 'pins' || g.state === 'result' ? 0.8 : 0.3,
      state: 'play',
      cam: this.bowlCam.cam,
      beat: this.beat(),
      bowl: g.phys.view,
    };
    this.stage.update(view);
    // the wrist turns through a hook release
    const rig = w.rigs[g.current];
    if (rig) rig.hands[0].rotation.z = this.bowlAnims[g.current].handRoll;
    this.stage.render(this.bowlCam.cam);
    this.onFrame(realDt);
  }
  private tmpBall = new THREE.Vector3();

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
