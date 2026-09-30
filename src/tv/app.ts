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
import { FOUL_Z, HEAD_Z } from './bowling/lane';
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
import { BaseballGame, type BaseballOptions } from './baseball/game';
import { BaseballCamera } from './baseball/camera';
import { FieldVenue } from './baseball/venue';
import { BatterAnimator, PitcherAnimator, CatcherAnimator } from './baseball/anim';
import { BaseballGear } from './baseball/gear';
import type { BaseballEvent, BatterState, CatcherState, FieldBall, FieldFx, Hitter, PitcherState } from './baseball/types';
import { FIELD, SWING } from './baseball/field';
import type { World } from './worlds/base';
import { hashStr } from '../shared/hash';
import { PLAYER_COLORS } from '../shared/protocol';
import { CHAR_SCALE } from './chars/rig';
import { newPose, copyPose } from './chars/pose';
import { WORLDS } from './worlds';
import { CameraRig } from './tennis/camera';
import { Match, type MatchConfig, type MatchEvent, type PlayerSpec } from './tennis/match';
import { segVel, segPos } from './tennis/ball';
import { Animator } from './chars/anim';
import { TVLink } from './core/link';
import { Input, SWING_AGE_MAX, type SwingEv } from './core/input';
import { AI_LEVELS } from './tennis/ai';
import { randomLook, playerLook, type Look } from './chars/look';
import { Rng, clamp, damp, lerp, smooth } from './core/math';
import type { TPlayer, HitPlan } from './tennis/player';
import type { FrameView } from './worlds/base';
import type { Pose } from './chars/pose';
import type { MatchState } from './tennis/match';
import type { V3 } from './core/math';
import type { HostToGuest } from '../shared/protocol';
import { isNetMsg, type NetEnd, type NetStart } from '../shared/net';
import { NetHost } from './net/host';
import { GuestStream, shadowMatch } from './net/guest';

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
  /** the animators' own poses (what an instant replay leaves standing while the host streams) */
  private livePoses: Pose[] = [];
  // ---- online rooms (see src/tv/net): this TV streams its match to guest TVs, or renders a host's
  /** host: streams the match to the room's guest TVs */
  net = new NetHost(this);
  /** guest: the host's match being shown (this.match is its shadow); stats in guest.stats */
  guest: GuestStream | null = null;
  /** guest: the host started a match — default builds it; the flow builds its screens first, then calls startGuestMatch */
  onGuestStart: (s: NetStart) => void = (s) => void this.startGuestMatch(s);
  /** guest: the host's match is over (or was abandoned: winner −1) */
  onGuestEnd: (e: NetEnd) => void = () => {};
  /** guest: a caption from the host that no match event carries */
  onGuestHud: (text: string, sub?: string, cls?: string) => void = () => {};
  /** guest: snapshots stopped coming (true) / came back (false) */
  onGuestStatus: (reconnecting: boolean) => void = () => {};
  /** guest: the host is watching an instant replay (true) / stopped (false) */
  onGuestReplay: (on: boolean) => void = () => {};
  attract = true;
  paused = false;
  private last = 0;
  /** the tab came back: the first frame counts as one sixtieth, not as the whole time it was away */
  private resumed = false;
  /** wall times (ms) the frame being drawn covers */
  private frameFrom = 0;
  private frameTo = 0;
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
  sport: 'tennis' | 'bowling' | 'duel' | 'archery' | 'baseball' = 'tennis';
  bowl: BowlingGame | null = null;
  bowlCam = new BowlCamera();
  private bowlAnims: BowlAnimator[] = [];
  private phys: BowlPhysics | null = null;
  onBowlEvent: (e: BowlEvent) => void = () => {};
  /** when the ball first met the pins this roll (real time), or −1 */
  private bowlSlow = -1;
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
  // ---- baseball
  baseball: BaseballGame | null = null;
  ballCam = new BaseballCamera();
  private batAnims: BatterAnimator[] = [];
  private pitcherAnim: PitcherAnimator | null = null;
  private catcherAnim: CatcherAnimator | null = null;
  /** per world: the bats, helmets, gloves and the ball in hand */
  private batGear = new Map<World, BaseballGear>();
  /** the fielding side's colours (the pitcher and catcher) */
  private fieldColors: string[] = [];
  onBaseballEvent: (e: BaseballEvent) => void = () => {};
  /** the last few seconds at the plate (for a home-run replay) */
  private hrRec: HrFrame[] = [];
  private hrPool: HrFrame[] = [];
  /** a big home run again, slowly, from the side */
  hrReplay: { frames: HrFrame[]; i: number; time: number; contact: number; at: { x: number; y: number; z: number }; end: number } | null = null;
  private hrMarks: { x: number; y: number; z: number }[] = [];
  onHrReplay: (on: boolean) => void = () => {};
  /** when the derby last stepped (a swing that arrives between frames knows how far in it is) */
  private ballStepAt = 0;
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
  replay: {
    frames: RecFrame[];
    i: number;
    time: number;
    end: number;
    side: number;
    /** a smash in the window: slow right down on the contact, from low beside the smasher */
    smash: { t: number; x: number; y: number; z: number; fwd: number } | null;
  } | null = null;

  // ---- the smash: bullet time, the camera swinging low, the ball glowing
  /** how fast the sim runs relative to real time (bullet time eases it down) */
  timeScale = 1;
  /**
   * The human smash chance being staged right now (the HUD reads it): who, how
   * long (sim s) until contact, how far the build-up has come (0..1). `hit` is
   * set for a moment after the smash lands on the racket.
   */
  smashCue: { p: TPlayer; plan: HitPlan; tl: number; w: number } | null = null;
  private smashW = 0;
  /** real time until the camera lets go after a smash was struck */
  private smashAfter = 0;
  private smashLand = { x: 0, y: 0, z: 0 };
  // ---- tennis frame scratch (a frame makes no vectors, poses or views of its own)
  private ballV: V3 = { x: 0, y: 0, z: 0 };
  private velV: V3 = { x: 0, y: 0, z: 0 };
  private fv: FrameView | null = null;
  /**
   * Sim time a frame did not draw because a hitch would have taken more than MAX_SIM_STEPS steps
   * at once: [wall start, wall end (ms), seconds dropped]. A swing that arrives afterwards is
   * placed on the sim's own clock through these (see swing), so its timing is what it would have
   * been had the sim caught up in one go.
   */
  private slips: { from: number; to: number; sec: number }[] = [];
  /** total sim seconds dropped this match (a counter for the perf scripts) */
  slipped = 0;
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
    // (a guest TV: the host's match stream arrives here; the lobby may wrap this and pass the rest on)
    this.link.onHostMessage = (m) => this.guestMessage(m);
    this.link.connect();
    window.addEventListener('resize', () => this.resize());
    // (a hidden tab gets no frames: when it's back, its first gap is not the whole time away)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.resumed = true;
    });
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // (an effects-only level change keeps the size: assigning canvas.width, even to the same number, reallocates the drawing buffer)
    const bw = Math.floor(w * this.pr),
      bh = Math.floor(h * this.pr);
    if (bw !== this.canvas.width || bh !== this.canvas.height) this.renderer.setSize(bw, bh, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.stage.resize(w, h, this.pr);
    this.applyViews();
  }

  private applyViews() {
    this.stage.setViews(this.splitOn ? 2 : 1);
    const a = this.stage.vw / this.stage.h;
    this.bowlCam.aspect = this.stage.w / this.stage.h;
    this.duelCam.aspect = a;
    this.archCam.aspect = this.stage.w / this.stage.h;
    this.ballCam.aspect = this.stage.w / this.stage.h;
    this.duelCam.split = this.splitOn;
    this.rig.aspect = a;
    this.rig2.aspect = a;
    this.rig.split = this.splitOn;
    this.rig2.split = this.splitOn;
  }

  // ---------------------------------------------------------------- matches

  /** which sport the menu's background is showing */
  attractSport: 'tennis' | 'bowling' | 'duel' | 'archery' | 'baseball' = 'tennis';

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
    if (sport === 'baseball') {
      this.startBaseball(this.attractCpus(2), worldId, true, { pitches: 4 });
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
    // guest TVs in the room get to see it
    this.net.begin(this.match!, cfg, worldId);
  }

  /** another game (or a fresh match) replaces what was streaming to guests / being shown from a host */
  private endStreams() {
    this.net.stop();
    this.guest = null;
  }

  private begin(cfg: MatchConfig, worldId: string) {
    this.endStreams();
    this.stopBowling();
    this.stopDuel();
    this.stopArchery();
    this.stopBaseball();
    // (a match can start while a replay runs — its depth of field goes with it)
    if (this.replay) this.setDof(null);
    this.replay = null;
    this.timeScale = 1;
    this.smashCue = null;
    this.smashAfter = 0;
    this.rig.smash = this.rig2.smash = null;
    for (const f of this.rec) this.recPool.push(f);
    this.rec.length = 0;
    this.pendingEvents = [];
    this.match = new Match(cfg);
    this.match.onEvent = (e) => this.event(e);
    // (a guest TV may have had the main camera at the far end)
    this.rig.side = 0;
    const humans = (team: number) => this.match!.players.some((p) => p.human && p.team === team);
    this.split = !cfg.attract && !cfg.practice && this.splitPref && humans(0) && humans(1);
    this.anims = this.match.players.map((p) => new Animator(p));
    this.livePoses = this.anims.map((a) => a.pose);
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
    if (this.sport === 'baseball') {
      const g = this.baseball;
      if (!g || this.paused || this.attract) return;
      if (e.source === 'mouse' && !this.input.mouseSwings) return;
      // the swing's plane: the phone's attack angle (+ = an uppercut); a flick of the mouse, its direction
      const lift = e.attack !== undefined ? clamp(e.attack / 30, -1, 1) : clamp(e.spin, -1, 1);
      // (the message came in between frames: how long since the game last stepped)
      const since = this.ballStepAt ? (performance.now() - this.ballStepAt) / 1000 : 0;
      g.swing(e.slot, { power: e.power, lift, age: clamp(e.age, 0, 0.2) }, since);
      return;
    }
    const m = this.match;
    if (!m || this.paused || this.attract) return;
    if (e.source === 'mouse' && !this.input.mouseSwings) return;
    // a key has no swing speed: on a smash chance it's a full-blooded one
    const chance = this.smashCue && this.smashCue.p.slot === e.slot;
    const power = e.source === 'key' && chance && e.power > 0.3 ? Math.max(e.power, 0.92) : e.power;
    // (a swing's age is real time; in bullet time the sim has moved on less)
    const age = clamp(e.age, 0, SWING_AGE_MAX);
    m.humanSwing(e.slot, { power, spin: e.spin, side: e.side, path: e.path }, m.t - age * this.timeScale + this.slippedSince(age));
  }

  /**
   * Sim seconds dropped by frame hitches since a swing `age` seconds old happened (0 unless there
   * was a hitch in that time): a hitch frame's dropped time is spread over the wall time it
   * covered, so a swing in the middle of it sits in the middle of what was drawn.
   */
  private slippedSince(age: number): number {
    const sl = this.slips;
    if (!sl.length) return 0;
    const now = performance.now();
    const at = now - age * 1000;
    let sec = 0;
    for (let i = sl.length - 1; i >= 0; i--) {
      const s = sl[i];
      if (s.to < now - 1500) {
        sl.splice(0, i + 1);
        break;
      }
      if (s.to > at) sec += s.sec * clamp((s.to - at) / Math.max(1e-3, s.to - s.from));
    }
    return sec;
  }

  private event(e: MatchEvent) {
    const m = this.match!;
    this.net.event(e);
    if (!this.attract && !this.guest && (e.type === 'hit' || e.type === 'bounce' || e.type === 'net')) this.pendingEvents.push(e);
    if (e.type === 'hit') {
      if (m.hitstop > 0) {
        this.hitstop = m.hitstop;
        m.hitstop = 0;
      }
      const k = e.kind === 'smash' ? (e.p.human ? (e.perfect ? 1.2 : 1) : 0.6) : e.rocket ? 0.65 : e.power > 0.85 || e.perfect ? 0.35 : 0.06;
      if (e.kind === 'smash' && e.p.human) {
        // out of bullet time with a bang (the hit-stop holds the frame first)
        this.timeScale = 1;
        this.smashAfter = 1.1;
        // where it will land (the camera rises to watch)
        const tb = m.ball.nextBounce;
        if (tb !== null) segPos(m.ball.seg, tb, this.smashLand);
        else this.smashLand = { x: e.pos.x, y: 0, z: -e.pos.z * 0.6 };
      }
      this.rig.kick(k);
      this.rig2.kick(k);
    }
    if (e.type === 'smash-chance') m.excitement = Math.max(m.excitement, 0.85);
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
      // each sport in each world has its own remembered quality level (a duel is heavier than a rally)
      const id = this.stage.current?.def.id;
      if (id) this.quality.setWorld(this.sport === 'tennis' ? id : `${id}/${this.sport}`, now);
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
    // a human's smash in the window: the replay dwells on it
    let smash: NonNullable<App['replay']>['smash'] = null;
    for (const f of frames)
      for (const e of f.events)
        if (e.type === 'hit' && e.kind === 'smash' && e.p.human) smash = { t: f.t, x: e.pos.x, y: e.pos.y, z: e.pos.z, fwd: e.p.fwd };
    this.replay = { frames, i: 0, time: frames[0].t, end: last.t, side: smash ? (smash.x >= 0 ? 1 : -1) : last.ball.x >= 0 ? 1 : -1, smash };
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
    let speed = u < 0.12 || u > 0.92 ? 0.7 : 0.42;
    // a smash: slow almost to a stop through the contact, then let it fly
    let focus: { x: number; y: number; z: number; w: number; fwd: number } | undefined;
    if (r.smash) {
      const d = r.time - r.smash.t;
      const near = clamp(1 - Math.abs(d + 0.05) / 0.45);
      speed = lerp(speed, 0.12, smooth(near));
      focus = { ...r.smash, w: d < 0 ? clamp((d + 1.1) / 0.5) : clamp(1 - (d - 0.3) / 0.5) };
    }
    r.time += realDt * speed;
    while (r.i < r.frames.length - 1 && r.frames[r.i + 1].t <= r.time) {
      r.i++;
      for (const e of r.frames[r.i].events) this.onReplayEvent(e);
    }
    const f = r.frames[r.i];
    this.rig.replayUpdate(f.ball, realDt, r.side, focus);
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
    // (the guest TVs see the match as it stands while the replay runs)
    this.net.frame(this.livePoses);
    this.stage.update(view);
    this.stage.render(this.rig.cam);
    this.onFrame(realDt);
    if (r.time >= r.end) this.endReplay();
  }

  frame(now: number) {
    const gapMs = this.resumed ? 1000 / 60 : this.last ? now - this.last : 0;
    this.resumed = false;
    const realDt = Math.min(0.1, Math.max(0, gapMs / 1000));
    const lastFrame = this.last;
    this.last = now;
    this.frameFrom = lastFrame || now - gapMs;
    this.frameTo = now;
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
    if (this.sport === 'baseball') {
      const g = this.baseball;
      if (!g || !this.stage.current) return;
      this.quality.beginFrame();
      this.baseballFrame(realDt);
      this.quality.endFrame();
      // resizing costs a frame: not while a pitch is on its way or a ball in the air
      if (!document.hidden && this.quality.update(now, gapMs, this.paused || (!this.hrReplay && g.state !== 'windup' && g.state !== 'pitch' && g.state !== 'flight')) !== null) this.applyQuality();
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
    if (this.guest) this.guestFrame(m, realDt);
    else if (this.replay) this.replayFrame(realDt);
    else this.playFrame(m, realDt);
    this.quality.endFrame();
    if (!document.hidden) {
      // resizing costs a frame: only between points, in menus and replays (or when badly overloaded)
      const st = this.match?.state;
      const safe = this.attract || this.paused || !!this.replay || this.stage.transitioning === false && (st !== 'play' && st !== 'toss');
      if (this.quality.update(now, gapMs, safe) !== null) this.applyQuality();
    }
  }

  // ---------------------------------------------------------------- baseball

  /** Turn the current world's court into a ballpark and start a home run derby. */
  startBaseball(hitters: Hitter[], worldId: string, attract = false, opts: BaseballOptions = {}) {
    this.stopBowling();
    this.stopDuel();
    this.stopArchery();
    this.stopBaseball();
    this.endStreams();
    this.match = null;
    this.replay = null;
    this.attract = attract;
    this.paused = false;
    this.sport = 'baseball';
    this.worldId = worldId;
    this.stage.setWorld(worldId);
    const g = new BaseballGame(hitters, { seed: this.rng.int(1, 1 << 30), ...opts });
    this.baseball = g;
    g.onEvent = (e) => {
      if (e.type === 'contact') {
        this.ballCam.kick(e.ball.sweet ? 0.75 : 0.22 + Math.min(0.4, e.ball.exitSpeed / 110));
        // the crowd comes up out of their seats for one that's going a long way
        if (!e.ball.foul && e.ball.exitSpeed > 38) this.stage.current?.crowd?.cheerNow(0.35);
      } else if (e.type === 'catch') this.ballCam.kick(0.08);
      else if (e.type === 'land' && e.ball.homeRun && !e.ball.foul) this.stage.current?.crowd?.cheerNow(1);
      this.onBaseballEvent(e);
      // a crushed one: see it again
      if (e.type === 'result' && e.outcome === 'homerun' && g.hit && (g.hit.sweet || g.hit.distance >= 128)) this.startHrReplay();
    };
    for (const f of this.hrRec) this.hrPool.push(f);
    this.hrRec.length = 0;
    this.hrReplay = null;
    this.batAnims = hitters.map((h) => new BatterAnimator(h.handed, h.look));
    // the fielders: the home side in navy, caps on
    const uniform = (look: Look): Look => ({ ...look, shirt: '#2c4a8c', shorts: '#f3f1ea', shoes: '#1d1b2a', hair: 'cap', hat: '#1f3366', racket: '#c8a27a' });
    const pitcherLook = uniform(randomLook(this.rng));
    const catcherLook = uniform(randomLook(this.rng));
    this.fieldColors = ['#2c4a8c', '#2c4a8c'];
    this.pitcherAnim = new PitcherAnimator(g.pitcher.handed, pitcherLook);
    this.catcherAnim = new CatcherAnimator(catcherLook);
    this.stage.setPlayers([...hitters.map((h) => h.look), pitcherLook, catcherLook]);
    this.ballCam.snap();
    this.prepareBaseballWorld();
  }

  /** The world on screen shows the ballpark; its characters carry bats and gloves. */
  private prepareBaseballWorld() {
    const g = this.baseball;
    if (!g) return;
    // (the world on screen, and the one it's shattering into)
    for (const w of this.stage.shown) {
      if (w.sport !== 'baseball') w.setSport('baseball', (kit) => new FieldVenue(kit, { particles: w.particles, world: w.def.id }));
      if (!this.batGear.has(w)) this.batGear.set(w, new BaseballGear(w, [...g.hitters.map((h) => h.color), ...this.fieldColors]));
    }
  }

  stopBaseball() {
    if (this.sport !== 'baseball') return;
    if (this.hrReplay) this.endHrReplay();
    this.setDof(null);
    this.sport = 'tennis';
    this.baseball = null;
    for (const gear of this.batGear.values()) gear.dispose();
    this.batGear.clear();
    this.stage.forEachWorld((w) => {
      if (w.sport === 'baseball') w.setSport('tennis');
    });
  }

  private baseballFrame(realDt: number) {
    const g = this.baseball!;
    const w = this.stage.current!;
    this.prepareBaseballWorld();
    if (this.hrReplay) {
      this.hrReplayFrame(g, w, realDt);
      return;
    }
    const dt = this.paused ? 0 : Math.min(0.05, realDt);
    // the last moments of a home run's flight go by a touch slower
    let gdt = dt;
    const hit = g.hit;
    if (g.state === 'flight' && hit && hit.homeRun && !hit.foul) {
      const left = hit.hang - (g.t - g.hitT);
      if (left > 0 && left < 0.9) gdt = dt * (0.55 + 0.45 * (1 - Math.min(1, (0.9 - left) / 0.5)));
    }
    if (gdt > 0) {
      g.step(gdt);
      this.ballStepAt = performance.now();
    }
    const cam = this.ballCam.cam;
    const view = g.view({ x: cam.position.x, y: cam.position.y, z: cam.position.z });
    this.ballCam.update(g, view, realDt, this.realT);
    this.setDof(this.ballCam.focus, this.ballCam.aperture);
    const hitters = g.hitters.map((_, i) => g.hitterState(i));
    const poses: Pose[] = hitters.map((s, i) => this.batAnims[i].update(g.t, Math.max(1e-4, gdt), s));
    poses.push(this.pitcherAnim!.update(g.t, Math.max(1e-4, gdt), g.pitcher));
    poses.push(this.catcherAnim!.update(g.t, Math.max(1e-4, gdt), g.catcher));
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
      excitement: g.state === 'flight' ? (hit?.homeRun ? 1 : 0.6) : g.state === 'pitch' || g.state === 'windup' ? 0.45 : 0.3,
      state: 'play',
      cam,
      beat: this.beat(),
      field: view,
    };
    this.stage.update(fv);
    for (const sw of this.stage.shown) this.batGear.get(sw)?.update({ hitters, pitcher: g.pitcher, catcher: g.catcher, ball: view.ball }, realDt);
    this.stage.render(cam);
    this.hrMarks = view.marks;
    if (gdt > 0) this.recordHr(g.t, poses, hitters, g.pitcher, g.catcher, view.ball, view.fx);
    this.onFrame(realDt);
  }

  /** Keep the last few seconds of the plate: poses, states, the ball and its effects. */
  private recordHr(t: number, poses: Pose[], hitters: BatterState[], pitcher: PitcherState, catcher: CatcherState, ball: FieldBall, fx: FieldFx[]) {
    const f = this.hrPool.pop() ?? { t: 0, poses: [], hitters: [], pitcher, catcher, ball, fx: [] };
    f.t = t;
    while (f.poses.length < poses.length) f.poses.push(newPose());
    f.poses.length = poses.length;
    for (let i = 0; i < poses.length; i++) copyPose(f.poses[i], poses[i]);
    f.hitters = hitters.map((s) => ({ ...s }));
    f.pitcher = { ...pitcher };
    f.catcher = { ...catcher };
    f.ball = { ...ball };
    f.fx = fx.length ? fx.slice() : NO_FX;
    this.hrRec.push(f);
    while (this.hrRec.length && this.hrRec[0].t < t - 9) this.hrPool.push(this.hrRec.shift()!);
  }

  /** The swing again from a second before the crack to a second after, in slow motion. */
  private startHrReplay() {
    const g = this.baseball;
    if (!g || !g.hit || this.hrReplay) return;
    const c = g.hitT;
    const cur = g.current;
    // A person's swing is usually judged after the ball has gone by on screen: the
    // recording then shows it going on into the mitt before the game rewound. Stitch
    // the ball's approach (up to where it crossed the contact plane) to the flight
    // (from the rewind on), and swing the bat through to meet it.
    const t0 = g.pitch?.t0 ?? c - 1;
    let cross = c;
    for (const f of this.hrRec) {
      if (f.t >= t0 && f.t < c && f.ball.phase === 'pitch' && f.ball.z >= FIELD.contactZ - 0.02) {
        cross = f.t;
        break;
      }
    }
    const gap = c - cross;
    const frames: HrFrame[] = [];
    for (const f of this.hrRec) {
      if ((f.t >= cross - 0.95 && f.t < cross) || (f.t >= c && f.t <= c + 1.05)) frames.push(f);
      else this.hrPool.push(f);
    }
    this.hrRec.length = 0;
    const firstAfter = frames.find((f) => f.t >= c);
    if (frames.length < 20 || !firstAfter) {
      for (const f of frames) this.hrPool.push(f);
      return;
    }
    const at = firstAfter.hitters[cur];
    const start = cross - SWING.contact;
    const h = g.hitters[cur];
    const anim = new BatterAnimator(h.handed, h.look);
    let prev = frames[0].t - 1 / 60;
    for (const f of frames) {
      if (f.t >= c) f.t -= gap;
      else if (f.t >= start) f.hitters[cur] = { ...f.hitters[cur], phase: 'swing', t: f.t - start, lift: at.lift, power: at.power, aimX: at.aimX, aimY: at.aimY };
      copyPose(f.poses[cur], anim.update(f.t, Math.max(1e-4, f.t - prev), f.hitters[cur]));
      prev = f.t;
    }
    this.hrReplay = { frames, i: 0, time: frames[0].t, contact: cross, at: { x: at.aimX, y: at.aimY, z: FIELD.contactZ }, end: frames[frames.length - 1].t };
    this.onHrReplay(true);
  }

  endHrReplay() {
    const r = this.hrReplay;
    if (!r) return;
    for (const f of r.frames) this.hrPool.push(f);
    this.hrReplay = null;
    this.ballCam.snap();
    this.setDof(null);
    this.onHrReplay(false);
  }

  private hrReplayFrame(g: BaseballGame, w: World, realDt: number) {
    const r = this.hrReplay!;
    // slow motion — slowest right at the crack
    const d = Math.abs(r.time - r.contact);
    const speed = this.paused ? 0 : d < 0.08 ? 0.12 : d < 0.4 ? 0.12 + ((d - 0.08) / 0.32) * 0.33 : 0.45;
    r.time += realDt * speed;
    const fx: FieldFx[] = [];
    while (r.i < r.frames.length - 1 && r.frames[r.i + 1].t <= r.time) {
      r.i++;
      // (slowed down, the crack's flash would sit on screen: a gentler burst)
      for (const e of r.frames[r.i].fx) fx.push(e.type === 'contact' ? { ...e, sweet: false, power: e.power * 0.45 } : e);
    }
    const f = r.frames[r.i];
    const cam = this.ballCam.cam;
    const b = f.hitters[g.current];
    this.ballCam.replay(b, f.ball, r.at, (r.time - r.frames[0].t) / Math.max(0.1, r.end - r.frames[0].t), realDt, this.realT);
    this.setDof(this.ballCam.focus, this.ballCam.aperture);
    const view = { ball: f.ball, tracer: false, color: g.hitters[g.current]?.color ?? '#ffffff', marks: this.hrMarks, eye: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, fx };
    const fv: FrameView = {
      t: f.t,
      dt: realDt * speed,
      realT: this.realT,
      realDt,
      ball: { x: 0, y: -10, z: 0 },
      ballSpeed: 0,
      ballVisible: false,
      holder: -1,
      poses: f.poses,
      excitement: 0.8,
      state: 'play',
      cam,
      beat: this.beat(),
      field: view,
    };
    this.stage.update(fv);
    for (const sw of this.stage.shown) this.batGear.get(sw)?.update({ hitters: f.hitters, pitcher: f.pitcher, catcher: f.catcher, ball: f.ball }, realDt * speed);
    this.stage.render(cam);
    this.onFrame(realDt);
    if (r.time >= r.end) this.endHrReplay();
  }

  // ---------------------------------------------------------------- archery

  /** Turn the current world's court into a range and start a round. */
  startArchery(archers: Archer[], worldId: string, attract = false) {
    this.stopBowling();
    this.stopDuel();
    this.stopArchery();
    this.stopBaseball();
    this.endStreams();
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
    if (!this.archery) return;
    for (const w of this.stage.shown) {
      if (w.sport !== 'archery') w.setSport('archery', (kit) => new RangeVenue(kit, { particles: w.particles, world: w.def.id }));
      if (!this.archGear.has(w)) this.archGear.set(w, new ArcheryGear(w, this.archery.archers.map((a) => a.color)));
    }
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
  private phoneAim(g: ArcheryGame, slot: number, s: [number, number, number], n: [number, number, number]) {
    // the phone's orientation in its player frame (x right, y towards the screen, z up)
    const q = this.oriQuat(s, n, this.tmpQ);
    const drawing = g.archer.phase === 'draw' || g.archer.phase === 'hold';
    if (!drawing || !this.aimFrom) {
      // the straight line to the middle of the main target
      const b = g.home;
      if (drawing) {
        // (the draw began a moment ago, by the time the message took: the turn counts from the pose of then)
        const then = this.input.oriAt(slot, performance.now() - Math.max(0, g.t - g.drawT0) * 1000);
        this.aimFrom = { q: then ? this.oriQuat(then.s, then.n, new THREE.Quaternion()) : q.clone(), yaw: b.yaw, pitch: b.pitch };
      }
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

  private oriQuat(s: [number, number, number], n: [number, number, number], out: THREE.Quaternion) {
    const S = this.tmpV3.set(s[0], s[1], s[2]).normalize();
    const N = new THREE.Vector3(n[0], n[1], n[2]);
    N.addScaledVector(S, -N.dot(S)).normalize();
    const X = new THREE.Vector3().crossVectors(S, N);
    return out.setFromRotationMatrix(this.tmpM.makeBasis(S, N, X));
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
      const a = r && performance.now() - r.t < 400 && seat && !seat.local ? this.phoneAim(g, who.slot, r.s, r.n) : this.mouseAim(g);
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
    for (const sw of this.stage.shown) this.archGear.get(sw)?.update(states, realDt);
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
    this.stopBaseball();
    this.endStreams();
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
      else if ((e.type === 'block' && !e.rescued) || e.type === 'clash') this.duelCam.kick(0.2);
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
    if (!this.duel) return;
    for (const w of this.stage.shown) {
      if (w.sport !== 'duel') w.setSport('duel', (kit) => new DuelVenue(kit, { particles: w.particles, world: w.def.id }));
      if (!this.duelGear.has(w)) this.duelGear.set(w, new DuelGear(w, this.duel.duelists.map((d) => d.color)));
    }
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
      const seat = this.input.seats[d.slot];
      // (the newest pose carried on to now: nothing eased behind it)
      const r = seat && !seat.local ? this.input.oriNow(d.slot, wall) : null;
      if (r) g.aim(d.slot, aimFromPhone(r.s, r.n));
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
    for (const sw of this.stage.shown) this.duelGear.get(sw)?.update(g.fighters, realDt, g.halfLength);
    this.stage.render(this.splitOn ? this.duelCam.cams : this.duelCam.cams[0]);
    this.onFrame(realDt);
  }

  // ---------------------------------------------------------------- bowling

  /** Turn the current world's court into lanes and start a game. */
  async startBowling(specs: Omit<Bowler, 'score' | 'x' | 'aim'>[], worldId: string, attract = false) {
    this.phys ??= await BowlPhysics.load();
    this.stopDuel();
    this.stopArchery();
    this.stopBaseball();
    this.endStreams();
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
      if (e.type === 'physics' && e.e.type === 'hit' && e.e.ballOnPin) {
        this.bowlCam.kick(Math.min(0.6, e.e.impact * 0.06));
        // the ball crashing into the pins: a beat of slow motion (once a roll)
        if (this.bowlSlow < 0) this.bowlSlow = this.realT;
      }
      if (e.type === 'result') {
        this.bowlSlow = -1;
        const w = this.stage.current;
        if (w && !this.attract && (e.mark === 'strike' || e.mark === 'spare')) {
          const strike = e.mark === 'strike';
          w.crowd?.cheerNow(strike ? 1 : 0.6);
          // confetti over the deck
          const cols = ['#ff5a8a', '#ffd23a', '#3aa8ff', '#4be3a2', '#b07cff', '#ffffff'].map((c) => new THREE.Color(c));
          for (const x of strike ? [-0.9, 0, 0.9] : [0])
            w.particles.burst({ x, y: 0.6, z: HEAD_Z - 0.4, count: strike ? 70 : 45, speed: [3.5, 8], dir: [0, 1, 0.25], spread: 0.55, life: [1.4, 2.4], size: [0.04, 0.085], shrink: 0.6, colors: cols, gravity: 5.5, drag: 1.4, spin: 8 });
        }
      }
      if (e.type === 'cancel') this.bowlSlow = -1;
      this.onBowlEvent(e);
    };
    this.bowlAnims = bowlers.map((b) => new BowlAnimator(b.handed, b.look));
    this.stage.setPlayers(bowlers.map((b) => b.look));
    this.prepareBowlWorld();
  }

  /** The world on screen shows lanes; its characters put their rackets away. */
  private prepareBowlWorld() {
    for (const w of this.stage.shown) {
      if (w.sport === 'bowling') continue;
      w.setSport('bowling', (kit) => new BowlVenue(kit));
      for (const r of w.rigs) r.racket.visible = false;
    }
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
    this.prepareBowlWorld();
    const dt = this.paused ? 0 : Math.min(0.05, realDt);
    // the impact in slow motion: 0.3× for a third of a second, easing back over the next 0.75
    let gdt = dt;
    if (this.bowlSlow >= 0) {
      const a = this.realT - this.bowlSlow;
      if (a < 1.1) gdt = dt * (a < 0.35 ? 0.3 : 0.3 + 0.7 * ((a - 0.35) / 0.75));
    }
    // the bowling arm follows the phone's swing: the newest angle carried on to now
    const bw = g.bowler;
    if (g.state === 'approach' && bw.cpu === null && !this.input.seats[bw.slot]?.local) {
      const arm = this.input.armNow(bw.slot, performance.now());
      if (arm !== null) g.setArm(bw.slot, arm);
    }
    if (gdt > 0) g.step(gdt);
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

  // ---------------------------------------------------------------- online: a guest TV

  /**
   * The link's host messages (role 'guest'): binary snapshot frames and the match stream's control
   * messages. A `start` for a match already being shown is ignored (a late joiner makes the host repeat it).
   */
  guestMessage(m: HostToGuest | ArrayBuffer) {
    if (m instanceof ArrayBuffer) {
      this.guest?.push(m);
      return;
    }
    if (m.type !== 'net' || !isNetMsg(m.msg)) return;
    const msg = m.msg;
    if (msg.type === 'start') {
      if (this.guest?.id === msg.id) return;
      this.onGuestStart(msg);
    } else if (this.guest && msg.id === this.guest.id) this.guest.control(msg);
  }

  /**
   * Show the host's match: build the same world and characters, and a SHADOW match (a Match that is
   * never stepped) for the camera, HUD and worlds to read; the stream (src/tv/net/guest.ts) writes into it.
   * The guest ignores its own keyboard, mouse and phones' swings.
   * `side`: the end of the court the camera looks from (1 = the far end, the way split screen's second half does):
   * the end of the team this TV's own phones play for.
   */
  startGuestMatch(start: NetStart, side: 0 | 1 = 0): GuestStream {
    this.endStreams();
    this.stopBowling();
    this.stopDuel();
    this.stopArchery();
    this.stopBaseball();
    if (this.replay) this.setDof(null);
    this.replay = null;
    this.timeScale = 1;
    this.smashCue = null;
    this.smashAfter = 0;
    this.rig.smash = this.rig2.smash = null;
    for (const f of this.rec) this.recPool.push(f);
    this.rec.length = 0;
    this.pendingEvents = [];
    this.attract = false;
    this.paused = false;
    this.hitstop = 0;
    const shadow = shadowMatch(start);
    this.match = shadow;
    this.anims = [];
    this.livePoses = [];
    this.split = false;
    if (this.splitOn) {
      this.splitOn = false;
      this.applyViews();
    }
    this.stage.setPlayers(shadow.players.map((p) => p.look));
    this.worldId = start.world;
    this.stage.setWorld(start.world);
    this.stage.setTeamColors(start.halo[0], start.halo[1]);
    this.rig.side = side;
    this.rig.setMode('menu');
    this.rig.setMode('intro');
    this.guest = new GuestStream(start, {
      event: (e) => this.event(e),
      world: (id, transition, origin, at) => {
        // (a shift from a spot in the court: seen from this TV's own end, that spot is somewhere else on the screen than on the host's)
        let o = origin;
        if (at) {
          const p = this.rig.project(at);
          if (!p.behind) o = { x: p.x, y: p.y };
        }
        this.stage.setWorld(id, { transition, origin: o });
      },
      hud: (text, sub, cls) => this.onGuestHud(text, sub, cls),
      end: (e) => this.onGuestEnd(e),
      status: (r) => this.onGuestStatus(r),
      replay: (on) => this.onGuestReplay(on),
      clockOffset: () => this.link.serverOffset,
    }, shadow);
    return this.guest;
  }

  /** Leave the host's match (its results are done, or we are leaving): back to the menu's showcase. */
  stopGuestMatch() {
    if (!this.guest) return;
    this.guest = null;
    this.startAttract(this.stage.current?.def.id ?? this.worldId);
  }

  private guestFrame(m: Match, realDt: number) {
    const g = this.guest!;
    g.advance(realDt);
    this.stageSmash(m, realDt);
    const ball = m.ballView(m.t, this.ballV);
    this.rig.update(m, realDt, this.realT, ball);
    let speed = 0;
    if (!m.ball.holder && m.state !== 'toss') {
      const v = segVel(m.ball.seg, m.t, this.velV);
      speed = Math.hypot(v.x, v.y, v.z);
    }
    const view = this.tennisView();
    view.rush = !!m.cfg.rush;
    view.t = m.t;
    view.dt = g.dt;
    view.realT = this.realT;
    view.realDt = realDt;
    view.ballSpeed = speed;
    // (nothing to show until the first snapshot has said where it is)
    view.ballVisible = g.ready;
    view.holder = m.ball.holder ? m.players.indexOf(m.ball.holder) : -1;
    view.poses = g.poses;
    view.excitement = m.excitement;
    view.state = m.state;
    view.beat = this.beat();
    this.stage.update(view);
    this.stage.render(this.rig.cam);
    this.onFrame(realDt);
  }

  /**
   * Stage a human's smash chance: as the floater comes down to them, time eases
   * into slow motion, the camera swings low behind them and the ball glows.
   */
  private stageSmash(m: Match, realDt: number) {
    let cue: { p: TPlayer; plan: HitPlan } | null = null;
    if (!this.attract && !this.paused)
      for (const p of m.players) {
        const plan = p.human ? m.smashChance(p) : null;
        if (plan) {
          cue = { p, plan };
          break;
        }
      }
    let want = 1;
    if (cue) {
      const tl = cue.plan.t - m.t;
      // the last second or so before contact runs at a bit over a third of real speed
      want = lerp(0.36, 1, smooth(clamp((tl - 0.3) / 0.95)));
    }
    this.timeScale = damp(this.timeScale, want, want < this.timeScale ? 7 : 12, realDt);
    this.smashW = damp(this.smashW, cue ? 1 : 0, cue ? 3 : 5, realDt);
    this.smashCue = cue ? { p: cue.p, plan: cue.plan, tl: cue.plan.t - m.t, w: this.smashW } : null;
    this.smashAfter = Math.max(0, this.smashAfter - realDt);
    const cam = cue
      ? { team: cue.p.team, x: cue.plan.sx, z: cue.plan.sz, fh: cue.p.fhSign, cx: cue.plan.bx, cy: cue.plan.by, cz: cue.plan.bz, after: 0 }
      : this.smashAfter > 0 && this.rig.smash
        ? { ...this.rig.smash, after: 1, lx: this.smashLand.x, lz: this.smashLand.z }
        : null;
    this.rig.smash = cam;
    this.rig2.smash = cam;
    const glow = cue ? this.smashW : 0;
    if (this.stage.current) this.stage.current.smashGlow = glow;
    if (this.stage.next) this.stage.next.smashGlow = glow;
  }

  /** the one FrameView the tennis frames fill in (the worlds read it during the call, none keeps it) */
  private tennisView(): FrameView {
    return (this.fv ??= {
      t: 0,
      dt: 0,
      realT: 0,
      realDt: 0,
      ball: this.ballV,
      ballSpeed: 0,
      ballVisible: true,
      holder: -1,
      poses: this.livePoses,
      excitement: 0,
      state: 'intro',
      cam: this.rig.cam,
      beat: 0,
    });
  }

  private playFrame(m: Match, realDt: number) {
    // (the engine compiles the planner in the first frames, not in the first rally)
    if (m.warmLeft > 0) m.warm(4);
    this.stageSmash(m, realDt);
    let simDt = this.paused ? 0 : realDt * this.timeScale;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      simDt = 0;
    }
    // advance the simulation by exactly the time this frame covers (in steps of
    // at most 1/120 s). Fixed steps without interpolation made the ball move one
    // step on some frames and three on others — visible judder even at 60 fps.
    if (simDt > 0) {
      let n = Math.max(1, Math.ceil(simDt * 120 - 1e-6));
      let h = simDt / n;
      if (n > MAX_SIM_STEPS) {
        // after a hitch: draw what the cap covers and let the rest go (the sim runs a little
        // behind the clock, rather than freezing and then jumping a tenth of a second at once);
        // swings that came in during the hitch are placed through `slips`
        const dropped = simDt - MAX_SIM_STEPS / 120;
        n = MAX_SIM_STEPS;
        h = 1 / 120;
        this.slipped += dropped;
        this.slips.push({ from: this.frameFrom, to: this.frameTo, sec: dropped });
      }
      for (let i = 0; i < n; i++) m.step(h);
    }

    // split screen during play; replays, results and menus use the whole screen
    const split = this.split && !this.attract && (this.rig.mode === 'play' || this.rig.mode === 'intro');
    if (split !== this.splitOn) {
      this.splitOn = split;
      this.applyViews();
      this.onSplit(split);
    }
    const ball = m.ballView(m.t, this.ballV);
    this.rig.update(m, realDt, this.realT, ball);
    if (split) {
      if (this.rig2.mode !== this.rig.mode) this.rig2.setMode(this.rig.mode);
      this.rig2.update(m, realDt, this.realT, ball);
    }
    let speed = 0;
    if (!m.ball.holder && m.state !== 'toss') {
      const v = segVel(m.ball.seg, m.t, this.velV);
      speed = Math.hypot(v.x, v.y, v.z);
    } else if (m.state === 'toss') speed = 0;
    const wall = performance.now();
    // (the animators' own poses, in one list that lives as long as the match)
    const poses = this.livePoses;
    for (let i = 0; i < this.anims.length; i++) {
      const a = this.anims[i];
      a.phone = a.p.human ? this.input.oriNow(a.p.slot, wall) : null;
      a.update(m.t, simDt || 1e-4, ball, m.state);
    }
    const view = this.tennisView();
    view.rush = !!m.cfg.rush;
    view.t = m.t;
    view.dt = simDt;
    view.realT = this.realT;
    view.realDt = realDt;
    view.ballSpeed = speed;
    view.ballVisible = true;
    view.holder = m.ball.holder ? m.players.indexOf(m.ball.holder) : -1;
    view.poses = poses;
    view.excitement = m.excitement;
    view.state = m.state;
    view.beat = this.beat();
    this.net.frame(poses);
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

/** the most sim steps (of 1/120 s) one frame draws, 50 ms as in the other sports: a longer gap after a hitch is cut to this (20 fps and up still plays in real time) */
const MAX_SIM_STEPS = 6;
const NO_EVENTS: MatchEvent[] = [];
const NO_FX: FieldFx[] = [];

interface HrFrame {
  t: number;
  poses: Pose[];
  hitters: BatterState[];
  pitcher: PitcherState;
  catcher: CatcherState;
  ball: FieldBall;
  fx: FieldFx[];
}

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
