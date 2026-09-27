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
import { ArcheryGame } from './archery/game';
import { flyTo } from './archery/physics';
import { ArcheryCamera } from './archery/camera';
import { RangeVenue } from './archery/venue';
import { ArcherAnimator } from './archery/anim';
import { ArcheryGear } from './archery/bow';
import { RANGE } from './archery/range';
import type { Archer, ArcheryEvent, ArcherState } from './archery/types';
import type { World } from './worlds/base';
import { hashStr } from '../shared/hash';
import { PLAYER_COLORS } from '../shared/protocol';
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
  sport: 'tennis' | 'bowling' | 'duel' | 'archery' = 'tennis';
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
  // ---- archery
  archery: ArcheryGame | null = null;
  archCam = new ArcheryCamera();
  private archAnims: ArcherAnimator[] = [];
  private archGear = new Map<World, ArcheryGear>();
  onArcheryEvent: (e: ArcheryEvent) => void = () => {};
  /** a phone's pose when the draw began, and the aim it started from (the aim follows the turn since) */
  private aimFrom: { q: THREE.Quaternion; yaw: number; pitch: number } | null = null;
  /** how much of the phone's turn the aim takes: well under 1:1 keeps a steady hand's
   *  tremor within a ring or two at 30 m (a ring there is 0.09°) */
  aimGain = 0.55;
  /** the reticle on screen for the HUD (CSS pixels), or null */
  reticle: { x: number; y: number; draw: number } | null = null;
  private tmpQ = new THREE.Quaternion();
  private tmpM = new THREE.Matrix4();
  private tmpV3 = new THREE.Vector3();
  private cross = { x: 0, y: 0, t: 0, ok: false, speed: 0 };

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
    this.archCam.aspect = this.stage.w / this.stage.h;
    this.duelCam.split = this.splitOn;
    this.rig.aspect = a;
    this.rig2.aspect = a;
    this.rig.split = this.splitOn;
    this.rig2.split = this.splitOn;
  }

  // ---------------------------------------------------------------- matches

  /** which sport the menu's background is showing */
  attractSport: 'tennis' | 'bowling' | 'duel' | 'archery' = 'tennis';

  /** CPUs to fill a showcase game: random looks, the player colours */
  private attractCpus(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      name: 'CPU',
      color: PLAYER_COLORS[(i + this.rng.int(0, 3)) % 4],
      look: randomLook(this.rng),
      handed: (this.rng.chance(0.15) ? -1 : 1) as 1 | -1,
      slot: -1,
      cpu: this.rng.range(0.6, 0.95),
    }));
  }

  /** The menu's background: CPUs playing one of the sports (they take turns showing off). */
  startAttract(worldId = this.worldId, sport = this.attractSport) {
    this.attractSport = sport;
    if (sport === 'bowling') {
      void this.startBowling(this.attractCpus(2), worldId, true);
      return;
    }
    if (sport === 'duel') {
      const [a, b] = this.attractCpus(2);
      this.startDuel([a, b], worldId, true);
      return;
    }
    if (sport === 'archery') {
      this.startArchery(this.attractCpus(2), worldId, true);
      return;
    }
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
    this.stopArchery();
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
    this.setDof(null);
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
    // the replay is a cinematic: the ball in focus, the stands soft behind it
    const c = this.rig.cam.position;
    this.setDof(Math.hypot(c.x - f.ball.x, c.y - f.ball.y, c.z - f.ball.z), 1.1);
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
    // (each sport's frame ends by calling onFrame, which can start another sport —
    // the menu's showcase moving on — so hold on to this frame's game)
    if (this.sport === 'bowling') {
      const g = this.bowl;
      if (!g || !this.stage.current) return;
      this.quality.beginFrame();
      this.bowlFrame(realDt);
      this.quality.endFrame();
      if (!document.hidden) {
        const st = g.state;
        if (this.quality.update(now, gapMs, this.paused || (st !== 'approach' && st !== 'lane' && st !== 'pins')) !== null) this.applyQuality();
      }
      return;
    }
    if (this.sport === 'archery') {
      const g = this.archery;
      if (!g || !this.stage.current) return;
      this.quality.beginFrame();
      this.archeryFrame(realDt);
      this.quality.endFrame();
      if (!document.hidden && this.quality.update(now, gapMs, this.paused || g.state !== 'aim') !== null) this.applyQuality();
      return;
    }
    if (this.sport === 'duel') {
      const g = this.duel;
      if (!g || !this.stage.current) return;
      this.quality.beginFrame();
      this.duelFrame(realDt);
      this.quality.endFrame();
      if (!document.hidden && this.quality.update(now, gapMs, this.paused || g.state !== 'fight') !== null) this.applyQuality();
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

  // ---------------------------------------------------------------- archery

  /** Turn the current world's court into a range and start a round. */
  startArchery(archers: Archer[], worldId: string, attract = false) {
    this.stopBowling();
    this.stopDuel();
    this.stopArchery();
    this.match = null;
    this.replay = null;
    this.attract = attract;
    this.paused = false;
    this.sport = 'archery';
    this.input.archeryMode = true;
    this.worldId = worldId;
    this.stage.setWorld(worldId);
    this.archery = new ArcheryGame(archers);
    this.archery.onEvent = (e) => {
      if (e.type === 'score' && e.points >= 10) this.archCam.kick(0.25);
      this.onArcheryEvent(e);
    };
    this.archAnims = archers.map((a) => new ArcherAnimator(a.handed, a.look));
    this.stage.setPlayers(archers.map((a) => a.look));
    this.aimFrom = null;
    this.prepareArcheryWorld();
  }

  /** The world on screen shows the range; its characters carry bows. */
  private prepareArcheryWorld() {
    const w = this.stage.current;
    if (!w || !this.archery) return;
    if (w.sport !== 'archery') w.setSport('archery', (kit) => new RangeVenue(kit, { particles: w.particles, world: w.def.id }));
    if (!this.archGear.has(w)) this.archGear.set(w, new ArcheryGear(w, this.archery.archers.map((a) => a.color)));
  }

  stopArchery() {
    if (this.sport !== 'archery') return;
    this.setDof(null);
    this.sport = 'tennis';
    this.input.archeryMode = false;
    this.archery = null;
    this.reticle = null;
    for (const gear of this.archGear.values()) gear.dispose();
    this.archGear.clear();
    this.stage.forEachWorld((w) => {
      if (w.sport === 'archery') w.setSport('tennis');
    });
  }


  /**
   * A phone's aim: when the draw begins the aim sits on the target; from then on
   * it turns as the phone turns (so compass drift doesn't matter, only the turn).
   */
  private phoneAim(g: ArcheryGame, s: [number, number, number], n: [number, number, number]) {
    // the phone's orientation in its player frame (x right, y towards the screen, z up)
    const S = this.tmpV3.set(s[0], s[1], s[2]).normalize();
    const N = new THREE.Vector3(n[0], n[1], n[2]);
    N.addScaledVector(S, -N.dot(S)).normalize();
    const X = new THREE.Vector3().crossVectors(S, N);
    const q = this.tmpQ.setFromRotationMatrix(this.tmpM.makeBasis(S, N, X));
    const drawing = g.archer.phase === 'draw' || g.archer.phase === 'hold';
    if (!drawing || !this.aimFrom) {
      // the straight line to the middle of the main target
      const b = g.home;
      if (drawing) this.aimFrom = { q: q.clone(), yaw: b.yaw, pitch: b.pitch };
      return { yaw: b.yaw, pitch: b.pitch };
    }
    // the turn since the draw began, a little damped
    const turn = q.clone().multiply(this.aimFrom.q.clone().invert());
    turn.slerp(new THREE.Quaternion(), 1 - this.aimGain);
    // the starting aim as a player-frame direction, turned
    const { yaw, pitch } = this.aimFrom;
    const w0 = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const d = new THREE.Vector3(w0.x, -w0.z, w0.y).applyQuaternion(turn);
    const w = { x: d.x, y: d.z, z: -d.y };
    return { yaw: Math.atan2(-w.x, -w.z), pitch: Math.asin(Math.max(-1, Math.min(1, w.y))) };
  }

  /** A mouse/keyboard player's aim: through the cursor (on the target's plane), nudged by the arrows. */
  private mouseAim(g: ArcheryGame) {
    const f = g.mainTarget();
    const m = this.input.mouseNdc;
    const cam = this.archCam.cam;
    const ray = new THREE.Vector3(m.x, m.y, 0.5).unproject(cam).sub(cam.position).normalize();
    const zPlane = f ? f.z : RANGE.lineZ - 15;
    const k = Math.abs(ray.z) > 1e-4 ? (zPlane - cam.position.z) / ray.z : 20;
    const p = cam.position.clone().addScaledVector(ray, Math.max(1, k));
    const a = g.archer;
    const nudge = this.input.aimNudge;
    const dx = p.x - a.x,
      dy = p.y - RANGE.eyeY,
      dz = p.z - a.z;
    return { yaw: Math.atan2(-dx, -dz) + nudge.yaw, pitch: Math.atan2(dy, Math.hypot(dx, dz)) + nudge.pitch };
  }

  private archeryFrame(realDt: number) {
    const g = this.archery!;
    const w = this.stage.current!;
    this.prepareArcheryWorld();
    const dt = this.paused ? 0 : Math.min(0.05, realDt);
    // the aim: the phone's turn since the draw began, or the mouse
    const who = g.archers[g.current];
    let aimOn = false;
    if (who && who.cpu === null && g.state === 'aim') {
      const r = this.input.racket[who.slot];
      const seat = this.input.seats[who.slot];
      const a = r && performance.now() - r.t < 400 && seat && !seat.local ? this.phoneAim(g, r.s, r.n) : this.mouseAim(g);
      g.aim(who.slot, a.yaw, a.pitch);
      aimOn = true;
    }
    if (g.state !== 'aim') this.aimFrom = null;
    // the arrow cam: the last few metres before the target go by in slow motion
    let gdt = dt;
    const arrow = g.shotArrow;
    const main = g.mainTarget();
    if (g.state === 'flight' && arrow && arrow.state === 'flying' && main) {
      const left = arrow.z - main.z;
      if (left > 0 && left < 4.5) gdt = dt * (0.3 + 0.7 * Math.max(0, (left - 1.5) / 3));
    }
    if (gdt > 0) g.step(gdt);
    const view = g.view();
    this.archCam.update(g, view, realDt, this.realT);
    this.setDof(this.archCam.focus, this.archCam.aperture);
    // the archer up on the line; the others wait to the side, watching
    const states = g.archers.map((a, i): ArcherState => {
      if (i === g.current) return g.archer;
      const order = (i - g.current + g.archers.length) % g.archers.length;
      return { x: -(2.2 + (order - 1) * 0.9), z: RANGE.lineZ + 1.6, handed: a.handed, phase: 'idle', t: g.t, draw: 0, yaw: -0.6, pitch: 0 };
    });
    const poses = states.map((s, i) => this.archAnims[i].update(g.t, Math.max(1e-4, i === g.current ? gdt : dt), s));
    const fv: FrameView = {
      t: g.t,
      dt,
      realT: this.realT,
      realDt,
      ball: { x: 0, y: -10, z: 0 },
      ballSpeed: 0,
      ballVisible: false,
      holder: -1,
      poses,
      excitement: g.state === 'flight' || g.state === 'result' ? 0.6 : 0.3,
      state: 'play',
      cam: this.archCam.cam,
      beat: this.beat(),
      range: view,
    };
    this.stage.update(fv);
    this.archGear.get(w)?.update(states, realDt);
    this.stage.render(this.archCam.cam);
    // the sight: where a full-draw arrow would land on the target's plane with no
    // wind (so the drop is taken care of and you judge the wind); it shakes as the aim does
    const drawn = g.archer.phase === 'draw' || g.archer.phase === 'hold';
    const f = g.mainTarget();
    if (aimOn && f && (drawn || !this.input.racket[who!.slot])) {
      const a = g.archer;
      const c = flyTo(a.yaw, a.pitch, RANGE.fullSpeed, f.z, 0, this.cross);
      const p = this.tmpV3.set(c.x, c.y, f.z).project(this.archCam.cam);
      this.reticle = c.ok ? { x: ((p.x + 1) / 2) * this.stage.w, y: ((1 - p.y) / 2) * this.stage.h, draw: a.draw } : null;
    } else this.reticle = null;
    this.onFrame(realDt);
  }

  // ---------------------------------------------------------------- sword duel

  /** Turn the current world's court into a duel arena and start a match. Two
   *  people on the same screen get half each. */
  startDuel(duelists: [Duelist, Duelist], worldId: string, attract = false) {
    this.stopBowling();
    this.stopDuel();
    this.stopArchery();
    this.match = null;
    this.replay = null;
    this.attract = attract;
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
    this.setDof(null);
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
    // over the edge: the knock-off plays in slow motion, then eases back to speed
    // for the splash (game time only — the camera and effects keep real time)
    const since = g.t - g.stateT0;
    const slow = g.state === 'fall' ? Math.min(1, 0.35 + Math.max(0, since - 0.45) * 1.6) : 1;
    const gdt = dt * slow;
    if (gdt > 0) g.step(gdt);
    this.duelCam.update(g, realDt, this.realT);
    this.setDof(this.splitOn ? null : this.duelCam.focus, 1);
    const poses = g.fighters.map((f, i) => this.duelAnims[i].update(g.t, Math.max(1e-4, gdt), f));
    const view: FrameView = {
      t: g.t,
      dt: gdt,
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
  async startBowling(specs: Omit<Bowler, 'score' | 'x' | 'aim'>[], worldId: string, attract = false) {
    this.phys ??= await BowlPhysics.load();
    this.stopDuel();
    this.stopArchery();
    this.match = null;
    this.replay = null;
    this.attract = attract;
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
    this.setDof(null);
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
    this.setDof(this.bowlCam.focus, 1);
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

export { hashStr };
