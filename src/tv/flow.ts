// Game flow: screens, menus, match lifecycle, pads, audio cues.

import { h, clear, replay, setVars } from './ui/dom';
import { Nav } from './ui/menu';
import { Hud, type TeamInfo } from './ui/hud';
import { JoinPanel } from './ui/join';
import type { App } from './app';
import type { Btn } from './core/input';
import type { MatchConfig, MatchEvent, PlayerSpec } from './tennis/match';
import { AI_LEVELS } from './tennis/ai';
import { randomLook } from './chars/look';
import { WORLDS, worldDef } from './worlds';
import type { WorldDef } from './worlds/base';
import { GameAudio } from './audio';
import type { Timbre } from './audio/sfx';
import { Rng } from './core/math';
import { Color } from 'three';
import { COURT } from './tennis/court';
import { TOUR, loadTour, saveTour, type Champion } from './tour';
import { BowlHud } from './ui/bowlhud';
import { DuelHud } from './ui/duelhud';
import { ArcheryHud } from './ui/archeryhud';
import type { Archer, ArcheryEvent } from './archery/types';
import { RANGE } from './archery/range';

const RANGE_FULL = RANGE.fullSpeed;
import type { DuelEvent, Duelist } from './duel/types';
import type { BowlEvent } from './bowling/game';
import type { PadMode } from '../shared/protocol';

type Level = 'rookie' | 'club' | 'pro' | 'ace';

export interface Settings {
  level: Level;
  games: number;
  doubles: boolean;
  teamPreset: number;
  voice: boolean;
  music: number;
  sfx: number;
  mouse: boolean;
  relaxed: boolean;
  /** local versus: each side gets its own half of the screen */
  split: boolean;
  world: string;
  seenTutorial: boolean;
}

const DEFAULTS: Settings = {
  level: 'club',
  games: 2,
  doubles: false,
  teamPreset: 0,
  voice: true,
  music: 0.7,
  sfx: 0.9,
  mouse: true,
  relaxed: false,
  split: true,
  world: 'park',
  seenTutorial: false,
};

const LEVELS: { id: Level; label: string; stars: string }[] = [
  { id: 'rookie', label: 'Rookie', stars: '★' },
  { id: 'club', label: 'Club', stars: '★★' },
  { id: 'pro', label: 'Pro', stars: '★★★' },
  { id: 'ace', label: 'Ace', stars: '★★★★' },
];

const TIMBRE: Record<string, Timbre> = { park: 'hard', plaza: 'hard', ink: 'wood', neon: 'synth', pixel: 'chip', paper: 'paper', clay: 'clay', water: 'soft', cosmic: 'glass' };

interface Screen {
  name: string;
  el: HTMLElement;
  input(slot: number, b: Btn): void;
  update?(dt: number): void;
  leave?(): void;
  pad?: { title?: string; hint?: string };
}

interface TeamPreset {
  label: string;
  t0: number[];
  t1: number[];
}

interface Stats {
  points: [number, number];
  aces: [number, number];
  winners: [number, number];
  errors: [number, number];
  fastest: [number, number];
  perfects: [number, number];
  longest: number;
}

export class Flow {
  root: HTMLElement;
  private screenLayer: HTMLElement;
  private hudLayer: HTMLElement;
  private toastEl: HTMLElement;
  private screen: Screen | null = null;
  settings: Settings;
  audio: GameAudio | null = null;
  hud: Hud | null = null;
  join: JoinPanel;
  private mode: 'quick' | 'kaleido' = 'quick';
  private tourIdx = -1;
  private lab = false;
  private lastSwing: { side?: string; power: number; spin: number; attack?: number; path?: number | null; source: string } | null = null;
  private hitTimes: number[] = [];
  private lastHit: { kind: string; kph: number; perfect: boolean } = { kind: '', kph: 0, perfect: false };
  private pointsSinceReplay = 99;
  private versusEnd: (() => void) | null = null;
  private kaleidoOrder: string[] = [];
  private kaleidoIdx = 0;
  private pointsSinceShift = 0;
  private shiftedThisRally = false;
  private stats: Stats = this.freshStats();
  private padModes = new Map<string, string>();
  private attractShiftAt = 14;
  private time = 0;
  private teams: [TeamInfo, TeamInfo] = [
    { name: '', color: '' },
    { name: '', color: '' },
  ];
  private rng = new Rng();
  private lastCfg: { cfg: MatchConfig; world: string } | null = null;
  private tossHintShown = false;
  private resultsShown = false;

  constructor(private app: App) {
    this.root = document.getElementById('ui')!;
    this.settings = { ...DEFAULTS, ...this.load() };
    this.screenLayer = h('div', { class: 'layer' });
    this.hudLayer = h('div', { class: 'layer' });
    this.toastEl = h('div', { class: 'toast' });
    this.root.append(this.hudLayer, this.screenLayer, this.toastEl);
    this.join = new JoinPanel(app.link, app.input);
    this.applyTheme(worldDef('plaza'));

    app.input.onButton = (slot, b, down) => {
      if (this.app.sport === 'bowling' && !this.screen && this.bowlButton(slot, b, down)) return;
      if (this.app.sport === 'duel' && !this.screen && this.duelButton(slot, b, down)) return;
      if (this.app.sport === 'archery' && !this.screen && this.archeryButton(slot, b, down)) return;
      if (down) this.button(slot, b);
    };
    app.input.onGuard = (slot, down) => {
      if (!this.screen || !down) this.app.duel?.guard(slot, down);
    };
    app.input.onSlash = (slot, a) => {
      if (!this.screen) this.app.duel?.slash(slot, a);
    };
    app.onDuelEvent = (e) => this.duelEvent(e);
    app.input.onDraw = (slot, down) => {
      if (!this.screen) this.app.archery?.draw(slot, down);
    };
    app.onArcheryEvent = (e) => this.archeryEvent(e);
    app.input.onGrip = (slot, down) => {
      if (!this.screen) this.app.bowl?.grip(slot, down);
    };
    app.input.onBowl = (slot, r) => {
      if (!this.screen) this.app.bowl?.release(slot, r);
    };
    app.input.onArm = (slot, arm) => this.app.bowl?.setArm(slot, arm);
    app.onBowlEvent = (e) => this.bowlEvent(e);
    const prevSwing = app.input.onSwing;
    app.input.onSwing = (e) => {
      if (this.screen?.name === 'title') {
        this.startFromTitle();
        return;
      }
      if (this.screen) return; // menus: ignore swings
      this.lastSwing = { side: e.side, power: e.power, spin: e.spin, attack: e.attack, path: e.path, source: e.source };
      prevSwing(e);
      this.audio?.sfx.swish(e.power, 0);
    };
    app.input.onSeatsChanged = () => {
      this.join.refresh();
      this.syncPads(true);
    };
    const prevStatus = app.link.onStatus;
    app.link.onStatus = (on) => {
      prevStatus(on);
      this.join.refresh();
    };
    const prevMsg = app.link.onMessage;
    app.link.onMessage = (m) => {
      const before = app.input.padCount;
      prevMsg(m);
      if (m.type === 'hello' || m.type === 'net') this.join.refresh();
      if (m.type === 'pad-join') {
        const seat = app.input.seatOfPid(m.pid);
        if (seat) this.toast(`P${seat.slot + 1} ${seat.name} joined`, seat.color);
        if (app.input.padCount > before) this.audio?.sfx.ui('join');
        this.syncPads(true);
      }
      if (m.type === 'pad-leave') {
        const seat = app.input.seatOfPid(m.pid);
        if (seat) {
          this.toast(`P${seat.slot + 1}'s remote disconnected`, seat.color);
          if (!this.screen && this.app.match && !this.app.attract && this.app.match.players.some((p) => p.slot === seat.slot)) this.pause();
          this.padLost(seat.slot);
        }
      }
    };
    app.onMatchEvent = (e) => this.matchEvent(e);
    app.onReplayEvent = (e) => {
      const a = this.audio;
      const pan = (x: number) => Math.max(-1, Math.min(1, x / 8));
      if (e.type === 'hit') a?.sfx.hit(e.power, e.perfect, pan(e.pos.x), e.kind === 'smash');
      if (e.type === 'bounce' && e.impact > 0.8) a?.sfx.bounce(e.impact, pan(e.pos.x));
      if (e.type === 'net') a?.sfx.net(e.cord, pan(e.pos.x));
      if (e.type === 'hit' || e.type === 'bounce') for (const w of [app.stage.current, app.stage.next]) w?.onEvent(e);
    };
    app.onReplayEnd = () => {
      this.hud?.setReplay(false);
      this.syncPads(true);
    };
    app.onFrame = (dt) => this.frame(dt);
    app.input.mouseSwings = this.settings.mouse;
    app.splitPref = this.settings.split;
    app.onSplit = (on) => this.hud?.setSplit(on ? app.rig2 : null);
    app.stage.onSwap = (w) => {
      COURT.gravity = 9.81 * (w.def.gravity ?? 1);
      this.applyTheme(w.def);
      this.audio?.setTimbre(TIMBRE[w.def.id] ?? 'hard');
      if (this.audio && (this.screen || !this.app.attract)) this.audio.playSong(w.def.song);
      this.syncScoreboard();
    };

    const unlock = () => this.unlockAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.go(this.titleScreen());
    void this.boot();
  }

  /**
   * Build every world, compile its shaders and upload its data behind a short
   * loading screen, so no world ever hitches the first time it appears (the
   * attract loop, Kaleido shifts and world picks would otherwise stall 50–200 ms).
   */
  private async boot() {
    const letters = ['K', 'A', 'L', 'E', 'I', 'D', 'O'];
    const cls = ['lk', 'la', 'll', 'le', 'li', 'ld', 'lo'];
    const bar = h('i');
    const el = h(
      'div',
      { class: 'boot' },
      h('div', { class: 'logo' }, ...letters.map((c, i) => h('span', { class: `L ${cls[i]}`, style: `--i:${i}` }, c))),
      h('div', { class: 'boot-bar' }, bar),
      h('div', { class: 'boot-txt' }, 'Polishing the worlds…'),
    );
    this.root.append(el);
    // priming stalls frames on purpose: don't let the quality governor react to it
    this.app.quality.hold(Infinity);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      el.classList.add('done');
      window.setTimeout(() => el.remove(), 700);
      this.app.quality.hold(performance.now() + 1500);
    };
    // never let the loader hold the game hostage (a background tab throttles
    // everything): whatever isn't primed by then carries on behind the title
    window.setTimeout(finish, 7000);
    const ids = WORLDS.map((w) => w.id);
    for (let i = 0; i < ids.length; i++) {
      await this.app.stage.prime(ids[i], this.app.rig.cam);
      bar.style.width = `${((i + 1) / ids.length) * 100}%`;
      // let a frame through so the page stays responsive (hidden tabs get no frames)
      await new Promise((r) => (document.hidden ? window.setTimeout(r, 0) : requestAnimationFrame(() => r(null))));
    }
    finish();
  }

  // ---------------------------------------------------------------- persistence

  private load(): Partial<Settings> {
    try {
      return JSON.parse(localStorage.getItem('kaleido.settings') || '{}');
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem('kaleido.settings', JSON.stringify(this.settings));
    } catch {}
  }

  // ---------------------------------------------------------------- audio

  unlockAudio() {
    if (!this.audio) {
      try {
        this.audio = new GameAudio();
      } catch {
        return;
      }
      this.audio.voiceOn = this.settings.voice;
      this.audio.setTimbre(TIMBRE[this.app.worldId] ?? 'hard');
    }
    this.audio.unlock();
    const au = this.audio;
    this.app.beat = () => au.music.beat();
    this.audio.setVolumes(this.settings.music, this.settings.sfx);
    if (!this.audio.music.song) this.audio.playSong(this.app.stage.current?.def.song ?? 'plaza');
  }

  // ---------------------------------------------------------------- screens

  go(s: Screen | null) {
    const old = this.screen;
    if (old) {
      old.leave?.();
      old.el.classList.add('leaving');
      setTimeout(() => old.el.remove(), 260);
    }
    this.screen = s;
    if (s) this.screenLayer.append(s.el);
    this.syncPads(true);
  }

  private button(slot: number, b: Btn) {
    if (this.screen) {
      this.screen.input(slot, b);
      return;
    }
    // in a match
    if (this.app.replay) {
      this.app.endReplay();
      return;
    }
    if (b === 'home' || b === 'plus' || b === 'b') this.pause();
    if (b === 'a') {
      if (this.versusEnd) this.versusEnd();
      else this.app.match?.startNow();
    }
  }

  private sound(kind: 'move' | 'select' | 'back' | 'error') {
    this.audio?.sfx.ui(kind);
  }

  private navScreen(name: string, el: HTMLElement, nav: Nav, onBack?: () => void, pad?: Screen['pad']): Screen {
    nav.onMove = () => this.sound('move');
    return {
      name,
      el,
      pad,
      input: (_slot, b) => {
        if (b === 'b' && onBack) {
          this.sound('back');
          onBack();
          return;
        }
        if (b === 'a') this.sound('select');
        nav.input(b);
      },
    };
  }

  private titleScreen(): Screen {
    const letters = [
      ['K', 'lk'],
      ['A', 'la'],
      ['L', 'll'],
      ['E', 'le'],
      ['I', 'li'],
      ['D', 'ld'],
      ['O', 'lo'],
    ];
    const logo = h('div', { class: 'logo' }, ...letters.map(([c, cls], i) => h('span', { class: `L ${cls}`, style: `--i:${i}` }, c)));
    const el = h(
      'div',
      { class: 'screen title' },
      logo,
      h('div', { class: 'subtitle' }, 'WORLD TENNIS'),
      h('div', { class: 'press' }, 'Click or press any key — or swing a remote'),
      this.join.el,
    );
    el.addEventListener('click', () => this.startFromTitle());
    return {
      name: 'title',
      el,
      pad: { title: 'Welcome!', hint: 'Press A or swing to start' },
      input: (_s, b) => {
        if (b === 'a' || b === 'plus' || b === 'home') this.startFromTitle();
      },
    };
  }

  private startFromTitle() {
    if (this.screen?.name !== 'title') return;
    this.sound('select');
    this.audio?.music.jingle('start');
    this.go(this.mainMenu());
  }

  private mainMenu(): Screen {
    const item = (ico: string, color: string, label: string, sub: string) =>
      h('div', { class: 'item' }, h('div', { class: 'ico', style: `background:${color}` }, ico), h('div', { class: 'txt' }, h('span', null, label), h('span', { class: 'sub' }, sub)));
    const quick = item('🎾', '#3aa8ff', 'Quick Match', 'Pick a world and play');
    const kal = item('◆', 'linear-gradient(135deg,#ff5a8a,#ffb13d,#4be3a2,#52a7ff)', 'Kaleido Rally', 'The world shatters as you play');
    const tb = loadTour().beaten;
    const tour = item('🏆', '#ffb13d', 'World Tour', tb >= TOUR.length ? 'The Prism is whole — play again' : `${Math.min(tb, 8)} of 8 shards restored`);
    const help = item('?', '#35d49a', 'How to Play', 'Tennis, bowling, duels & archery');
    const set = item('⚙', '#8a7dff', 'Settings', 'Sound, voice, controls');
    const labItem = item('🎯', '#ff5a8a', 'Swing Lab', 'Ball machine + a read-out of every swing');
    const bowlItem = item('🎳', '#ff8a3d', 'Bowling', 'Grip, swing, let go — ten frames');
    const duelItem = item('⚔', '#ff5a6e', 'Sword Duel', 'Swing to strike, hold to guard — knock them off');
    const archItem = item('🏹', '#35c46a', 'Archery', 'Point, draw, let go — mind the wind');
    const nav = new Nav([
      { el: quick, onSelect: () => this.go(this.setupScreen('quick')) },
      { el: bowlItem, onSelect: () => this.go(this.bowlSetup()) },
      { el: duelItem, onSelect: () => this.go(this.duelSetup()) },
      { el: archItem, onSelect: () => this.go(this.archerySetup()) },
      { el: tour, onSelect: () => this.go(this.tourScreen()) },
      { el: kal, onSelect: () => this.go(this.setupScreen('kaleido')) },
      { el: labItem, onSelect: () => this.beginSwingLab() },
      { el: help, onSelect: () => this.go(this.helpScreen()) },
      { el: set, onSelect: () => this.go(this.settingsScreen()) },
    ]);
    const el = h(
      'div',
      { class: 'screen mainmenu' },
      h('div', { class: 'col' }, h('div', { class: 'mini-logo' }, h('span', null, 'KALEIDO')), h('div', { class: 'menu' }, quick, bowlItem, duelItem, archItem, tour, kal, labItem, help, set)),
      this.join.el,
    );
    this.join.refresh();
    return this.navScreen('menu', el, nav, () => this.go(this.titleScreen()), { title: 'Main menu', hint: 'Use the pad · A to choose' });
  }

  // team presets from the humans present
  private presets(): TeamPreset[] {
    const humans = this.app.input.activeSeats.map((s) => s.slot).sort();
    const n = humans.length;
    const P = (i: number) => humans[i];
    const nm = (s: number) => `P${s + 1}`;
    if (n <= 1) return [{ label: `${nm(P(0) ?? 0)} vs CPU`, t0: [P(0) ?? 0], t1: [] }];
    if (n === 2)
      return [
        { label: `${nm(P(0))} vs ${nm(P(1))}`, t0: [P(0)], t1: [P(1)] },
        { label: `${nm(P(0))} & ${nm(P(1))} vs CPU`, t0: [P(0), P(1)], t1: [] },
        { label: `${nm(P(0))} vs CPU`, t0: [P(0)], t1: [] },
      ];
    if (n === 3)
      return [
        { label: `${nm(P(0))} & ${nm(P(1))} vs ${nm(P(2))}`, t0: [P(0), P(1)], t1: [P(2)] },
        { label: `${nm(P(0))} vs ${nm(P(1))} & ${nm(P(2))}`, t0: [P(0)], t1: [P(1), P(2)] },
        { label: `${nm(P(0))} & ${nm(P(2))} vs ${nm(P(1))}`, t0: [P(0), P(2)], t1: [P(1)] },
      ];
    return [
      { label: `${nm(P(0))} & ${nm(P(1))} vs ${nm(P(2))} & ${nm(P(3))}`, t0: [P(0), P(1)], t1: [P(2), P(3)] },
      { label: `${nm(P(0))} & ${nm(P(2))} vs ${nm(P(1))} & ${nm(P(3))}`, t0: [P(0), P(2)], t1: [P(1), P(3)] },
      { label: `${nm(P(0))} & ${nm(P(3))} vs ${nm(P(1))} & ${nm(P(2))}`, t0: [P(0), P(3)], t1: [P(1), P(2)] },
    ];
  }

  private setupScreen(mode: 'quick' | 'kaleido'): Screen {
    this.mode = mode;
    const S = this.settings;
    const sheet = h('div', { class: 'sheet panel' });
    const title = h('h2', null, mode === 'kaleido' ? 'Kaleido Rally' : 'Quick Match');
    const desc = h(
      'div',
      { class: 'hintline' },
      mode === 'kaleido' ? 'Every couple of points — or any PERFECT shot in a long rally — shatters the court into the next world.' : 'Choose your match, then pick a world.',
    );
    const teamsView = h('div', { class: 'teams' });
    const row = (k: string) => {
      const v = h('span');
      const r = h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, h('span', { class: 'arrow' }, '◀'), v, h('span', { class: 'arrow' }, '▶')));
      return { r, v };
    };
    const rTeams = row('Players');
    const rFormat = row('Format');
    const rLevel = row('CPU level');
    const rLen = row('Match');
    const go = h('div', { class: 'row go' }, mode === 'kaleido' ? 'Start the rally ▶' : 'Choose a world ▶');
    const refresh = () => {
      const ps = this.presets();
      S.teamPreset = Math.min(S.teamPreset, ps.length - 1);
      const p = ps[S.teamPreset];
      rTeams.v.textContent = p.label;
      const formatLocked = p.t0.length > 1 || p.t1.length > 1;
      if (formatLocked) S.doubles = true;
      rFormat.v.textContent = S.doubles ? 'Doubles (2 v 2)' : 'Singles (1 v 1)';
      rFormat.r.classList.toggle('disabled', formatLocked);
      const lv = LEVELS.find((l) => l.id === S.level)!;
      rLevel.v.textContent = `${lv.label} ${lv.stars}`;
      const cpu = p.t0.length === 0 || p.t1.length === 0;
      rLevel.r.classList.toggle('disabled', !cpu);
      if (navRef) {
        navRef.items[1].disabled = formatLocked;
        navRef.items[2].disabled = !cpu;
      }
      rLen.v.textContent = S.games === 1 ? '1 game' : S.games === 2 ? 'Best of 3 games' : 'Best of 5 games';
      clear(teamsView);
      teamsView.append(this.teamChips(p.t0, S.doubles), h('span', { class: 'vs' }, 'vs'), this.teamChips(p.t1, S.doubles));
      this.save();
    };
    const cyc = <T>(arr: T[], cur: T, d: number) => arr[(arr.indexOf(cur) + d + arr.length) % arr.length];
    let navRef: Nav | null = null;
    const nav = new Nav([
      {
        el: rTeams.r,
        onLeft: () => {
          S.teamPreset = (S.teamPreset - 1 + this.presets().length) % this.presets().length;
          refresh();
        },
        onRight: () => {
          S.teamPreset = (S.teamPreset + 1) % this.presets().length;
          refresh();
        },
        onSelect: () => {
          S.teamPreset = (S.teamPreset + 1) % this.presets().length;
          refresh();
        },
      },
      { el: rFormat.r, onLeft: () => ((S.doubles = !S.doubles), refresh()), onRight: () => ((S.doubles = !S.doubles), refresh()), onSelect: () => ((S.doubles = !S.doubles), refresh()) },
      {
        el: rLevel.r,
        onLeft: () => ((S.level = cyc(LEVELS.map((l) => l.id), S.level, -1)), refresh()),
        onRight: () => ((S.level = cyc(LEVELS.map((l) => l.id), S.level, 1)), refresh()),
        onSelect: () => ((S.level = cyc(LEVELS.map((l) => l.id), S.level, 1)), refresh()),
      },
      {
        el: rLen.r,
        onLeft: () => ((S.games = cyc([1, 2, 3], S.games, -1)), refresh()),
        onRight: () => ((S.games = cyc([1, 2, 3], S.games, 1)), refresh()),
        onSelect: () => ((S.games = cyc([1, 2, 3], S.games, 1)), refresh()),
      },
      {
        el: go,
        onSelect: () => {
          if (mode === 'kaleido') this.beginMatch(this.shuffledWorlds()[0]);
          else this.go(this.worldScreen());
        },
      },
    ]);
    navRef = nav;
    nav.focus(4);
    sheet.append(title, desc, teamsView, rTeams.r, rFormat.r, rLevel.r, rLen.r, go, h('div', { class: 'hintline' }, '◀ ▶ change · A select · B back'));
    const el = h('div', { class: 'screen center' }, sheet);
    refresh();
    const scr = this.navScreen('setup', el, nav, () => this.go(this.mainMenu()), { title: mode === 'kaleido' ? 'Kaleido Rally' : 'Quick Match', hint: '◀ ▶ to change' });
    const baseInput = scr.input;
    scr.input = (s, b) => {
      baseInput(s, b);
    };
    this.app.input.onSeatsChanged = () => {
      this.join.refresh();
      this.syncPads(true);
      if (this.screen === scr) refresh();
    };
    return scr;
  }

  private teamChips(slots: number[], doubles: boolean) {
    const t = h('div', { class: 'team' });
    if (!slots.length) {
      t.append(h('span', { class: 'chip', style: '--c:#6c6a84' }, doubles ? 'CPU & CPU' : 'CPU'));
      return t;
    }
    for (const s of slots) {
      const seat = this.app.input.seats[s];
      t.append(h('span', { class: 'chip', style: `--c:${seat?.color ?? '#999'}` }, `P${s + 1} ${seat?.local ? '' : seat?.name ?? ''}`.trim()));
    }
    if (doubles && slots.length === 1) t.append(h('span', { class: 'chip', style: `--c:${this.app.input.seats[slots[0]]?.color ?? '#999'};opacity:.75` }, '×2'));
    return t;
  }

  private worldScreen(): Screen {
    const cards = WORLDS.map((w) =>
      h(
        'div',
        { class: 'wcard' },
        h('div', { class: 'sw', style: `background:linear-gradient(90deg, ${w.ui.accent}, ${w.ui.accent2})` }),
        h('div', { class: 'wn', style: `font-family:${w.ui.display}` }, w.name),
        h('div', { class: 'wt' }, w.tagline),
      ),
    );
    const big = h('div', { class: 'wbig' });
    const setBig = (w: WorldDef) => {
      clear(big);
      big.append(h('div', { class: 'wn', style: `font-family:${w.ui.display}` }, w.name), h('div', { class: 'wt' }, w.tagline), h('div', { class: 'wb' }, w.blurb));
      replay(big, 'show');
    };
    const nav = new Nav(
      WORLDS.map((w) => ({ el: cards[WORLDS.indexOf(w)], onSelect: () => this.beginMatch(w.id) })),
      true,
    );
    const start = Math.max(0, WORLDS.findIndex((w) => w.id === this.settings.world));
    nav.onChange = (i) => {
      const w = WORLDS[i];
      setBig(w);
      this.settings.world = w.id;
      this.save();
      this.app.stage.setWorld(w.id, { transition: true, origin: { x: (i + 0.5) / WORLDS.length, y: 0.8 } });
      this.audio?.sfx.ui('shift');
    };
    nav.focus(start);
    setBig(WORLDS[start]);
    if (this.app.stage.current?.def.id !== WORLDS[start].id) this.app.stage.setWorld(WORLDS[start].id, { transition: true });
    const el = h('div', { class: 'screen worlds' }, h('div', { class: 'headline' }, 'CHOOSE A WORLD'), big, h('div', { class: 'wsel' }, ...cards));
    return this.navScreen('worlds', el, nav, () => this.go(this.setupScreen(this.mode)), { title: 'Choose a world', hint: '◀ ▶ browse · A play' });
  }

  private helpScreen(sport = 0): Screen {
    const tip = (art: string, t: string, d: string) => h('div', { class: 'tip' }, h('div', { class: 'art' }, art), h('b', null, t), h('span', null, d));
    const kbd = (...parts: (string | [string])[]) => h('div', { class: 'keys' }, ...parts.map((p) => (typeof p === 'string' ? p : h('kbd', null, p[0]))));
    const pages: { name: string; tips: HTMLElement[]; keys: HTMLElement }[] = [
      {
        name: 'Tennis',
        tips: [
          tip('📱', 'Swing your phone', 'Hold it like a racket handle and swing when the ball arrives. Your player runs to the ball for you.'),
          tip('⏱️', 'Timing aims', 'Swing early to pull the ball cross-court. Swing late to push it down the line. Nail the moment for a PERFECT.'),
          tip('💨', 'Speed = power', 'A fast swing hits hard and deep. A gentle swing floats it softly.'),
          tip('🌀', 'Spin', 'Brush upward for topspin (dips and kicks). Chop downward for slice. A soft upward swing lobs; a soft chop drops it short.'),
          tip('🎾', 'Serving', 'Lift your phone (or tap) to toss, then swing as the ball peaks. Perfect timing = a rocket serve.'),
          tip('◆', 'Kaleido Rally', 'Long rallies build the music. Hit PERFECT shots and the whole world shatters into the next one.'),
        ],
        keys: kbd('No phone? Flick the mouse to swing (up = topspin, down = slice) · ', ['Space'], ' toss & swing · ', ['J'], ' ', ['K'], ' ', ['L'], ' flat / topspin / slice · ', ['Esc'], ' pause'),
      },
      {
        name: 'Bowling',
        tips: [
          tip('🎳', 'Hold the ball', 'Press and hold the big ball on your phone — that’s your grip. The bowler walks up as you swing.'),
          tip('💪', 'Swing and let go', 'Swing your arm back, then forward like bowling, and let go at the bottom. Faster swing, faster ball.'),
          tip('🌀', 'Hook it', 'Twist your wrist as you let go to curve the ball late in the lane. Turn it left to hook left.'),
          tip('🎯', 'Aim', '◀ ▶ step along the line, ↺ ↻ turn the aim line — one board per tap. A straight ball from where you start finds the pocket.'),
          tip('✨', 'Strikes', 'Hit the pocket (just beside the head pin) with a little angle. Hooking? Move out and aim back in.'),
          tip('👥', 'Take turns', 'Up to four bowlers, each on their own phone — add a CPU if you like. Ten frames, real pin physics.'),
        ],
        keys: kbd('No phone? Hold ', ['Space'], ' or the mouse and let go · ', ['J'], ' ', ['K'], ' ', ['L'], ' straight / hook left / hook right · arrows move & aim'),
      },
      {
        name: 'Sword Duel',
        tips: [
          tip('⚔️', 'Your phone is the sword', 'Hold it like a sword’s grip. The sword on screen follows your phone.'),
          tip('💥', 'Swing to strike', 'Swing in any direction — across, down, on a diagonal — or push forward to thrust. Hits knock them back.'),
          tip('🛡️', 'Guard across', 'Hold GUARD and hold your sword across their swing: upright stops side swings, flat stops chops.'),
          tip('😵', 'Stun them', 'A blocked attacker is stunned for a moment. That’s your chance — strike back!'),
          tip('🔋', 'Don’t flail', 'Wild swinging tires your arm and your hits go weak. Watch their sword and pick your moment.'),
          tip('🌊', 'Off the edge', 'Knock them off the end of the platform to take the round. Best of three.'),
        ],
        keys: kbd('No phone? Arrows or a mouse drag slash · hold ', ['Space'], ' or the right button to guard · ', ['X'], ' thrust'),
      },
      {
        name: 'Archery',
        tips: [
          tip('🏹', 'Hold DRAW', 'Press and hold DRAW on your phone: the archer pulls the string back. Full draw takes about a second.'),
          tip('🎯', 'Point to aim', 'While you hold it, the aim follows your phone — turn it to move the sight onto the target.'),
          tip('🪂', 'Arrows drop', 'The further the target, the more the arrow falls. Aim a little above the middle.'),
          tip('🌬️', 'Mind the wind', 'The flags and the gauge show the wind. Aim into it — more for the far targets.'),
          tip('🎈', 'Balloons', 'Pop a balloon for bonus points. The rings score 10 in the gold down to 1 at the edge.'),
          tip('👥', 'Take turns', 'Three ends of three arrows each. Everyone shoots on their own phone; add a CPU if you like.'),
        ],
        keys: kbd('No phone? Hold the mouse (or ', ['Space'], ') to draw, the cursor aims, let go to shoot · arrows fine-tune'),
      },
    ];
    const page = pages[sport];
    const tabs = h('div', { class: 'row help-tabs' }, h('span', { class: 'k' }, 'Sport'), h('span', { class: 'v' }, h('span', { class: 'arrow' }, '◀'), h('span', null, page.name), h('span', { class: 'arrow' }, '▶')));
    const flip = (d: number) => this.go(this.helpScreen((sport + d + pages.length) % pages.length));
    const back = h('div', { class: 'row go' }, 'Got it');
    const nav = new Nav([
      { el: tabs, onLeft: () => flip(-1), onRight: () => flip(1), onSelect: () => flip(1) },
      { el: back, onSelect: () => this.go(this.mainMenu()) },
    ]);
    const sheet = h('div', { class: 'sheet panel' }, h('h2', null, 'How to play'), tabs, h('div', { class: 'help-grid' }, ...page.tips), page.keys, back);
    return this.navScreen('help', h('div', { class: 'screen center' }, sheet), nav, () => this.go(this.mainMenu()), { title: 'How to play', hint: '◀ ▶ sport · A to go back' });
  }

  private settingsScreen(): Screen {
    const S = this.settings;
    const row = (k: string, get: () => string) => {
      const v = h('span');
      const r = h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, h('span', { class: 'arrow' }, '◀'), v, h('span', { class: 'arrow' }, '▶')));
      return { r, v, get };
    };
    const pct = (x: number) => `${Math.round(x * 10) * 10}%`;
    const rows = [
      row('Music volume', () => pct(S.music)),
      row('Effects volume', () => pct(S.sfx)),
      row('Umpire voice', () => (S.voice ? 'On' : 'Off')),
      row('Mouse flick swings', () => (S.mouse ? 'On' : 'Off')),
      row('Swing timing', () => (S.relaxed ? 'Relaxed (easier)' : 'Normal')),
      row('Split screen (2 players)', () => (S.split ? 'On' : 'Off')),
    ];
    const done = h('div', { class: 'row go' }, 'Done');
    const refresh = () => {
      rows.forEach((r) => (r.v.textContent = r.get()));
      this.audio?.setVolumes(S.music, S.sfx);
      if (this.audio) this.audio.voiceOn = S.voice;
      this.app.input.mouseSwings = S.mouse;
      this.app.splitPref = S.split;
      this.save();
    };
    const step = (k: 'music' | 'sfx', d: number) => {
      S[k] = Math.max(0, Math.min(1, Math.round((S[k] + d) * 10) / 10));
      refresh();
    };
    const nav = new Nav([
      { el: rows[0].r, onLeft: () => step('music', -0.1), onRight: () => step('music', 0.1), onSelect: () => step('music', 0.1) },
      { el: rows[1].r, onLeft: () => step('sfx', -0.1), onRight: () => step('sfx', 0.1), onSelect: () => step('sfx', 0.1) },
      { el: rows[2].r, onLeft: () => ((S.voice = !S.voice), refresh()), onRight: () => ((S.voice = !S.voice), refresh()), onSelect: () => ((S.voice = !S.voice), refresh(), this.audio?.say('Fifteen love')) },
      { el: rows[3].r, onLeft: () => ((S.mouse = !S.mouse), refresh()), onRight: () => ((S.mouse = !S.mouse), refresh()), onSelect: () => ((S.mouse = !S.mouse), refresh()) },
      { el: rows[4].r, onLeft: () => ((S.relaxed = !S.relaxed), refresh()), onRight: () => ((S.relaxed = !S.relaxed), refresh()), onSelect: () => ((S.relaxed = !S.relaxed), refresh()) },
      { el: rows[5].r, onLeft: () => ((S.split = !S.split), refresh()), onRight: () => ((S.split = !S.split), refresh()), onSelect: () => ((S.split = !S.split), refresh()) },
      { el: done, onSelect: () => this.go(this.mainMenu()) },
    ]);
    refresh();
    const sheet = h('div', { class: 'sheet panel' }, h('h2', null, 'Settings'), ...rows.map((r) => r.r), done);
    return this.navScreen('settings', h('div', { class: 'screen center' }, sheet), nav, () => this.go(this.mainMenu()), { title: 'Settings', hint: '◀ ▶ to change' });
  }

  private pauseScreen(): Screen {
    const item = (label: string) => h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, label)));
    const resume = item('Resume');
    const restart = item('Restart match');
    const quit = item('Quit to menu');
    const nav = new Nav([
      { el: resume, onSelect: () => this.resume() },
      {
        el: restart,
        onSelect: () =>
          this.app.sport === 'bowling'
            ? this.bowlCfg && void this.beginBowling(this.bowlCfg.world, this.bowlCfg.cpu)
            : this.app.sport === 'duel'
              ? this.duelCfg && this.beginDuel(this.duelCfg.world, this.duelCfg.cpu)
              : this.app.sport === 'archery'
                ? this.archCfg && this.beginArchery(this.archCfg.world, this.archCfg.cpu)
                : this.lastCfg && this.beginMatch(this.lastCfg.world, true),
      },
      { el: quit, onSelect: () => this.quitToMenu() },
    ]);
    const sheet = h('div', { class: 'sheet panel', style: 'width:auto;min-width:calc(var(--u)*56)' }, h('h2', null, 'Paused'), h('div', { class: 'menu' }, resume, restart, quit));
    return this.navScreen('pause', h('div', { class: 'screen center' }, sheet), nav, () => this.resume(), { title: 'Paused', hint: 'A to choose · B resume' });
  }

  private resultsScreen(): Screen {
    if (this.tourIdx >= 0) return this.tourResults();
    const m = this.app.match!;
    const w = m.score.winner as 0 | 1;
    const winTeam = this.teams[w];
    const humansWon = m.team(w).some((p) => p.human);
    const anyHuman = m.players.some((p) => p.human);
    const headline = anyHuman ? (humansWon ? `${winTeam.name} wins!` : 'CPU wins!') : `${winTeam.name} wins!`;
    const st = this.stats;
    const statRow = (k: string, a: number | string, b: number | string) => [h('span', null, k), h('b', null, String(a)), h('b', null, String(b))];
    const again = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Rematch')));
    const other = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, this.mode === 'kaleido' ? 'New Kaleido Rally' : 'Another world')));
    const menu = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Main menu')));
    const nav = new Nav([
      { el: again, onSelect: () => this.lastCfg && this.beginMatch(this.lastCfg.world, true) },
      { el: other, onSelect: () => (this.mode === 'kaleido' ? this.beginMatch(this.shuffledWorlds()[0]) : this.go(this.worldScreen())) },
      { el: menu, onSelect: () => this.quitToMenu() },
    ]);
    const sheet = h(
      'div',
      { class: 'sheet panel', style: `--c:${winTeam.color}` },
      h('div', { class: 'winner' }, headline),
      h('div', { class: 'final' }, `${m.score.games[0]} – ${m.score.games[1]}`),
      h(
        'div',
        { class: 'stats' },
        h('span', { class: 'h' }, ''),
        h('b', { class: 'h' }, this.teams[0].name),
        h('b', { class: 'h' }, this.teams[1].name),
        ...statRow('Points won', st.points[0], st.points[1]),
        ...statRow('Aces', st.aces[0], st.aces[1]),
        ...statRow('Winners', st.winners[0], st.winners[1]),
        ...statRow('Errors', st.errors[0], st.errors[1]),
        ...statRow('Perfect hits', st.perfects[0], st.perfects[1]),
        ...statRow('Fastest shot', `${Math.round(st.fastest[0])} km/h`, `${Math.round(st.fastest[1])} km/h`),
      ),
      h('div', { class: 'hintline' }, `Longest rally: ${st.longest} shots`),
      h('div', { class: 'menu' }, again, other, menu),
    );
    return this.navScreen('results', h('div', { class: 'screen center results' }, sheet), nav, () => this.quitToMenu(), { title: humansWon ? 'You won!' : 'Match over', hint: 'A to choose' });
  }

  // ---------------------------------------------------------------- match lifecycle

  private shuffledWorlds() {
    const ids = WORLDS.map((w) => w.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
  }

  private buildConfig(): MatchConfig {
    const S = this.settings;
    const p = this.presets()[Math.min(S.teamPreset, this.presets().length - 1)];
    const doubles = S.doubles || p.t0.length > 1 || p.t1.length > 1;
    const ai = AI_LEVELS[S.level];
    const players: PlayerSpec[] = [];
    const teamNames: [string, string] = ['', ''];
    const colors: [string, string] = ['', ''];
    for (const team of [0, 1] as const) {
      const slots = team === 0 ? p.t0 : p.t1;
      const count = doubles ? 2 : 1;
      const names: string[] = [];
      for (let i = 0; i < count; i++) {
        if (slots.length) {
          const slot = slots[Math.min(i, slots.length - 1)];
          const spec = this.app.humanSpec(slot, team);
          if (slots.length === 1 && i === 1) {
            // same human controls both players; partner gets a twin look
            spec.look = { ...spec.look, hair: this.rng.pick(['cap', 'band', 'bun', 'spiky'] as const), shorts: '#f7f6fb' };
          }
          players.push(spec);
          if (i < slots.length) names.push(spec.name);
          if (!colors[team]) colors[team] = this.app.input.seats[slot]?.color ?? '#3aa8ff';
        } else {
          const look = randomLook(this.rng, team === 1 ? this.rng.pick(['#6c6a84', '#4b4f73', '#8a5a9a', '#3d6b6b']) : undefined);
          players.push({ team, name: 'CPU', look, handed: this.rng.chance(0.2) ? -1 : 1, ctrl: { kind: 'cpu', ai } });
          if (i === 0) names.push('CPU');
          if (!colors[team]) colors[team] = '#6c6a84';
        }
      }
      teamNames[team] = names.join(' & ');
    }
    this.teams = [
      { name: teamNames[0], color: colors[0] },
      { name: teamNames[1], color: colors[1] },
    ];
    return { doubles, gamesToWin: S.games, players, teamNames, firstServer: this.rng.chance(0.5) ? 0 : 1 };
  }

  private beginMatch(world: string, reuse = false, cfgIn?: MatchConfig, versus?: Champion) {
    if (!cfgIn && !reuse) this.tourIdx = -1;
    if (!cfgIn?.practice && !reuse) this.lab = false;
    const cfg = cfgIn ?? (reuse && this.lastCfg ? { ...this.lastCfg.cfg, firstServer: (this.rng.chance(0.5) ? 0 : 1) as 0 | 1 } : this.buildConfig());
    if (reuse && this.lastCfg) this.teams = [...this.teams] as [TeamInfo, TeamInfo];
    this.lastCfg = { cfg, world };
    this.go(null);
    this.stats = this.freshStats();
    this.pointsSinceShift = 0;
    this.resultsShown = false;
    this.tossHintShown = false;
    if (this.mode === 'kaleido') {
      this.kaleidoOrder = [world, ...this.shuffledWorlds().filter((w) => w !== world)];
      this.kaleidoIdx = 0;
      this.warmSoon(this.kaleidoOrder[1], 1500);
    }
    this.app.paused = false;
    cfg.timingScale = this.settings.relaxed ? 1.45 : 1;
    this.app.startMatch(cfg, world);
    // the ball's halo shows who hit it: players' own colours, and a bright contrast for CPU teams
    const hasHuman = (t: 0 | 1) => cfg.players.some((p) => p.team === t && p.ctrl.kind === 'human');
    const warm = (c: string) => {
      const col = new Color(c);
      return col.r > col.b;
    };
    const c0 = hasHuman(0) ? this.teams[0].color : warm(this.teams[1].color) ? '#3aa8ff' : '#ff5a8c';
    const c1 = hasHuman(1) ? this.teams[1].color : warm(c0) ? '#3aa8ff' : '#ff5a8c';
    this.app.stage.setTeamColors(c0, c1);
    this.hud?.el.remove();
    this.hud = new Hud(this.teams, this.app.rig);
    this.hud.setSplit(this.app.splitOn ? this.app.rig2 : null);
    this.hudLayer.append(this.hud.el);
    const def = worldDef(world);
    this.versusEnd = null;
    if (versus) this.versusIntro(versus, def);
    else this.hud.showBanner(def, `${this.teams[0].name}  vs  ${this.teams[1].name}`);
    this.hud.setScore(this.app.match!);
    if (!this.settings.seenTutorial && !versus) {
      this.hud.setHint('Swing your phone like a racket when the ball comes to you');
    }
    this.syncScoreboard();
    if (this.audio) {
      this.audio.playSong(def.song);
      this.audio.music.setIntensity(2);
      this.audio.sfx.cheer(0.5);
    }
    this.syncPads(true);
  }

  /**
   * A phone dropped out: whatever it was holding lets go (a grip, a guard, a drawn
   * string would otherwise stay held with nobody to release it), and the game waits
   * for them if it's their go. Reconnecting puts their pad back as it was.
   */
  private padLost(slot: number) {
    const bg = this.app.bowl;
    if (bg && bg.bowlers.some((b) => b.slot === slot)) {
      bg.grip(slot, false);
      if (bg.bowler.slot === slot) this.pause();
    }
    const dg = this.app.duel;
    if (dg && dg.duelists.some((d) => d.slot === slot && d.cpu === null)) {
      dg.guard(slot, false);
      if (dg.state !== 'over') this.pause();
    }
    const ag = this.app.archery;
    if (ag && ag.archers.some((a) => a.slot === slot && a.cpu === null)) {
      ag.cancelDraw(slot);
      if (ag.archers[ag.current]?.slot === slot) this.pause();
    }
  }

  private pause() {
    if ((!this.app.match && !this.app.bowl && !this.app.duel && !this.app.archery) || this.app.attract || this.screen) return;
    this.app.paused = true;
    // a string pulled back when the game stops is let down, not loosed
    const ag = this.app.archery;
    if (ag) for (const a of ag.archers) if (a.slot >= 0) ag.cancelDraw(a.slot);
    this.go(this.pauseScreen());
    this.sound('select');
  }

  private resume() {
    this.app.paused = false;
    this.go(null);
  }

  private quitToMenu() {
    this.tourIdx = -1;
    this.lab = false;
    this.versusEnd = null;
    this.app.paused = false;
    this.hud?.el.remove();
    this.hud = null;
    this.bowlHud?.el.remove();
    this.bowlHud = null;
    this.duelHud?.el.remove();
    this.duelHud = null;
    this.archHud?.el.remove();
    this.archHud = null;
    this.audio?.sfx.roll(0);
    this.app.stopBowling();
    this.app.stopDuel();
    this.app.stopArchery();
    this.app.startAttract(this.app.stage.current?.def.id ?? 'plaza');
    this.app.stage.setTeamColors('#3aa8ff', '#ff5a8c');
    this.app.input.prune();
    this.go(this.mainMenu());
    this.audio?.music.setIntensity(3);
  }

  // ---------------------------------------------------------------- archery

  private archHud: ArcheryHud | null = null;
  private archCfg: { world: string; cpu: number } | null = null;

  /** Who's shooting (every phone, plus an optional CPU) and where. */
  private archerySetup(): Screen {
    const S = this.settings;
    const cpuLevels = [
      { label: 'No CPU', skill: -1 },
      { label: 'CPU · Rookie', skill: 0.3 },
      { label: 'CPU · Pro', skill: 0.65 },
      { label: 'CPU · Ace', skill: 0.9 },
    ];
    let cpu = this.archCfg ? Math.max(0, cpuLevels.findIndex((c) => c.skill === this.archCfg!.cpu)) : this.app.input.activeSeats.length > 1 ? 0 : 2;
    let wi = Math.max(0, WORLDS.findIndex((w) => w.id === (this.archCfg?.world ?? S.world)));
    const row = (k: string) => {
      const v = h('span');
      const r = h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, h('span', { class: 'arrow' }, '◀'), v, h('span', { class: 'arrow' }, '▶')));
      return { r, v };
    };
    const who = h('div', { class: 'hintline' });
    const cpuRow = row('Opponent');
    const worldRow = row('World');
    const go = h('div', { class: 'row go' }, 'Shoot!');
    const refresh = () => {
      const names = this.app.input.activeSeats.map((st) => st.name);
      who.textContent = names.length ? `Archers: ${names.join(', ')}` : 'Archer: Player 1';
      cpuRow.v.textContent = cpuLevels[cpu].label;
      worldRow.v.textContent = WORLDS[wi].name;
    };
    const cycle = (d: number) => {
      wi = (wi + d + WORLDS.length) % WORLDS.length;
      this.app.stage.setWorld(WORLDS[wi].id, { transition: true });
      refresh();
    };
    const nav = new Nav([
      { el: cpuRow.r, onLeft: () => ((cpu = (cpu + 3) % 4), refresh()), onRight: () => ((cpu = (cpu + 1) % 4), refresh()), onSelect: () => ((cpu = (cpu + 1) % 4), refresh()) },
      { el: worldRow.r, onLeft: () => cycle(-1), onRight: () => cycle(1), onSelect: () => cycle(1) },
      { el: go, onSelect: () => this.beginArchery(WORLDS[wi].id, cpuLevels[cpu].skill) },
    ]);
    refresh();
    const sheet = h(
      'div',
      { class: 'sheet panel' },
      h('h2', null, 'Archery'),
      h('div', { class: 'hintline' }, 'Point your phone at the target, hold DRAW to pull the string, and let go. The arrow drops with distance and drifts with the wind — aim a little high, and into the wind.'),
      who,
      cpuRow.r,
      worldRow.r,
      go,
    );
    return this.navScreen('archsetup', h('div', { class: 'screen center' }, sheet), nav, () => this.go(this.mainMenu()), { title: 'Archery', hint: '◀ ▶ to change · A to shoot' });
  }

  beginArchery(world: string, cpu: number) {
    this.archCfg = { world, cpu };
    this.go(null);
    this.hud?.el.remove();
    this.hud = null;
    this.bowlHud?.el.remove();
    this.bowlHud = null;
    this.duelHud?.el.remove();
    this.duelHud = null;
    this.archHud?.el.remove();
    this.archHud = null;
    const seats = this.app.input.activeSeats.length ? this.app.input.activeSeats : [this.app.input.seats[0]!];
    const archers: Archer[] = seats.map((st) => {
      const sp = this.app.humanSpec(st.slot, 0);
      return { name: sp.name, color: st.color, look: sp.look, handed: sp.handed, slot: st.slot, cpu: null };
    });
    if (cpu >= 0) archers.push({ name: 'CPU', color: '#6c6a84', look: randomLook(this.rng), handed: this.rng.chance(0.15) ? -1 : 1, slot: -1, cpu });
    this.app.startArchery(archers, world);
    const g = this.app.archery!;
    this.archHud = new ArcheryHud(archers, g.ends);
    this.hudLayer.append(this.archHud.el);
    this.archHud.update(g.scores, g.arrows, g.current);
    this.archHud.setHint(this.archeryHint());
    const def = worldDef(world);
    if (this.audio) {
      this.audio.playSong(def.song);
      this.audio.music.setIntensity(1);
      this.audio.sfx.cheer(0.3);
    }
    this.syncPads(true);
  }

  private archeryHint() {
    const a = this.app.archery?.archers[this.app.archery.current];
    if (!a || a.cpu !== null) return '';
    const seat = this.app.input.seats[a.slot];
    return seat && !seat.local
      ? 'Hold <b>DRAW</b> · <b>point</b> the phone to aim · <b>let go</b> to shoot — aim a little high, and into the wind'
      : '<b>Hold</b> the mouse (or <b>Space</b>) to draw · the cursor aims · <b>let go</b> to shoot · arrows fine-tune';
  }

  /** The arrows fine-tune a keyboard player's aim; A skips the intro. */
  private archeryButton(_slot: number, b: Btn, down: boolean) {
    const g = this.app.archery;
    if (!g) return false;
    const n = this.app.input.aimNudge;
    const step = 0.004;
    if (b === 'left' || b === 'right' || b === 'up' || b === 'down') {
      if (down) {
        if (b === 'left') n.yaw += step;
        else if (b === 'right') n.yaw -= step;
        else if (b === 'up') n.pitch += step;
        else n.pitch -= step;
      }
      return true;
    }
    if (b === 'a' && down) {
      g.skip();
      return true;
    }
    return false;
  }

  private archeryEvent(e: ArcheryEvent) {
    const a = this.audio;
    const hud = this.archHud;
    const g = this.app.archery;
    if (!g) return;
    const padOf = (i: number) => {
      const who = g.archers[i];
      return who && who.slot >= 0 && who.cpu === null ? this.app.input.seats[who.slot]?.pid : undefined;
    };
    switch (e.type) {
      case 'end':
        hud?.setWind(e.wind);
        hud?.say(e.end === e.ends ? 'FINAL END' : `END ${e.end}`, Math.abs(e.wind) < 0.3 ? 'no wind' : `wind ${Math.abs(e.wind).toFixed(1)} m/s ${e.wind > 0 ? '→' : '←'}`);
        this.app.input.aimNudge.yaw = this.app.input.aimNudge.pitch = 0;
        break;
      case 'turn':
        hud?.update(g.scores, g.arrows, e.who);
        hud?.showTurn(g.archers[e.who], g.end, e.arrow, e.arrows);
        hud?.setHint(g.end === 1 && e.arrow === 1 ? this.archeryHint() : '');
        this.syncPads(true);
        break;
      case 'shot':
        a?.sfx.twang(Math.min(1, e.speed / RANGE_FULL), 0);
        a?.sfx.swish(0.5, 0);
        this.syncPads(true);
        break;
      case 'score': {
        hud?.update(g.scores, g.arrows, g.current);
        const face = e.target >= 0;
        if (e.points > 0 || face) a?.sfx.thunk(face, Math.max(-1, Math.min(1, e.x / 6)));
        let text = e.points > 0 ? String(e.points) : 'MISS';
        let cls = '';
        if (e.bullseye) {
          text = 'BULLSEYE!';
          cls = 'good';
          a?.sfx.cheer(0.9);
          a?.music.jingle('point');
        } else if (e.points >= 8) a?.sfx.applause(0.5);
        else if (e.points === 0) {
          cls = 'bad';
          a?.sfx.aww();
        }
        hud?.say(text, e.points > 0 && !e.bullseye && e.ring === 0 ? 'bonus!' : '', cls);
        const pid = padOf(e.who);
        if (pid) this.app.link.toPad(pid, { type: 'fx', fx: e.bullseye ? 'perfect' : e.points > 0 ? 'hit' : 'whiff', label: text, detail: `${g.total(e.who)} total` });
        break;
      }
      case 'over': {
        a?.sfx.cheer(1);
        window.setTimeout(() => {
          if (this.app.sport === 'archery' && this.app.archery === g) this.go(this.archeryResults(e.ranking));
        }, 1800);
        break;
      }
      default:
        break;
    }
  }

  /** Per frame while shooting: the reticle and the wind. */
  private archeryFrame(_dt: number) {
    const g = this.app.archery;
    const hud = this.archHud;
    if (!g || !hud) return;
    const r = this.app.reticle;
    hud.setReticle(r?.x ?? 0, r?.y ?? 0, r?.draw ?? 0, !!r && !this.screen);
    this.audio?.sfx.setCrowd(g.state === 'flight' ? 0.4 : 0.25);
  }

  private archeryResults(ranking: number[]): Screen {
    const g = this.app.archery!;
    const again = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Play again')));
    const other = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Another world')));
    const menu = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Main menu')));
    const nav = new Nav([
      { el: again, onSelect: () => this.archCfg && this.beginArchery(this.archCfg.world, this.archCfg.cpu) },
      { el: other, onSelect: () => this.archCfg && this.beginArchery(this.shuffledWorlds().find((w) => w !== this.archCfg!.world) ?? 'park', this.archCfg.cpu) },
      { el: menu, onSelect: () => this.quitToMenu() },
    ]);
    const top = g.total(ranking[0]);
    const tied = ranking.filter((i) => g.total(i) === top);
    const place = (i: number) => 1 + ranking.filter((q) => g.total(q) > g.total(i)).length;
    const rows = ranking.map((i) =>
      h('div', { class: 'brank', style: `--c:${g.archers[i].color}` }, h('b', null, `${place(i)}`), h('i'), h('span', null, g.archers[i].name), h('em', null, String(g.total(i)))),
    );
    const bulls = (i: number) => g.scores[i].filter((p) => p >= 10).length;
    const title = ranking.length === 1 ? `${top} points!` : tied.length === ranking.length ? "It's a tie!" : tied.length > 1 ? `${tied.map((i) => g.archers[i].name).join(' & ')} tie for first!` : `${g.archers[ranking[0]].name} wins!`;
    const sheet = h(
      'div',
      { class: 'sheet panel results' },
      h('h2', null, title),
      h('div', { class: 'hintline' }, ranking.length > 1 ? 'Final scores' : `${bulls(ranking[0])} bullseye${bulls(ranking[0]) === 1 ? '' : 's'}`),
      ...rows,
      h('div', { class: 'menu' }, again, other, menu),
    );
    return this.navScreen('archresults', h('div', { class: 'screen center results' }, sheet), nav, () => this.quitToMenu(), { title: 'Round over', hint: 'A to choose' });
  }

  // ---------------------------------------------------------------- sword duel

  private duelHud: DuelHud | null = null;
  private duelCfg: { world: string; cpu: number } | null = null;

  /** Who you fight (a CPU, or a friend on a second phone) and where. */
  private duelSetup(): Screen {
    const S = this.settings;
    const seats = this.app.input.activeSeats;
    const opp = [
      { label: 'CPU · Rookie', skill: 0.3 },
      { label: 'CPU · Pro', skill: 0.65 },
      { label: 'CPU · Ace', skill: 0.9 },
    ];
    if (seats.length > 1) opp.unshift({ label: `${seats[1].name} (split screen)`, skill: -1 });
    let oi = this.duelCfg ? Math.max(0, opp.findIndex((o) => o.skill === this.duelCfg!.cpu)) : seats.length > 1 ? 0 : 1;
    let wi = Math.max(0, WORLDS.findIndex((w) => w.id === (this.duelCfg?.world ?? S.world)));
    const row = (k: string) => {
      const v = h('span');
      const r = h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, h('span', { class: 'arrow' }, '◀'), v, h('span', { class: 'arrow' }, '▶')));
      return { r, v };
    };
    const oppRow = row('Opponent');
    const worldRow = row('World');
    const go = h('div', { class: 'row go' }, 'Fight!');
    const refresh = () => {
      oppRow.v.textContent = opp[oi].label;
      worldRow.v.textContent = WORLDS[wi].name;
    };
    const cycle = (d: number) => {
      wi = (wi + d + WORLDS.length) % WORLDS.length;
      this.app.stage.setWorld(WORLDS[wi].id, { transition: true });
      refresh();
    };
    const n = opp.length;
    const nav = new Nav([
      { el: oppRow.r, onLeft: () => ((oi = (oi + n - 1) % n), refresh()), onRight: () => ((oi = (oi + 1) % n), refresh()), onSelect: () => ((oi = (oi + 1) % n), refresh()) },
      { el: worldRow.r, onLeft: () => cycle(-1), onRight: () => cycle(1), onSelect: () => cycle(1) },
      { el: go, onSelect: () => this.beginDuel(WORLDS[wi].id, opp[oi].skill) },
    ]);
    refresh();
    const sheet = h(
      'div',
      { class: 'sheet panel' },
      h('h2', null, 'Sword Duel'),
      h('div', { class: 'hintline' }, 'Your phone is the sword. Swing to strike; hold GUARD and hold the sword across their swing to block — a blocked attacker is stunned. Knock them off the end!'),
      oppRow.r,
      worldRow.r,
      go,
    );
    return this.navScreen('duelsetup', h('div', { class: 'screen center' }, sheet), nav, () => this.go(this.mainMenu()), { title: 'Sword Duel', hint: '◀ ▶ to change · A to fight' });
  }

  beginDuel(world: string, cpu: number) {
    this.duelCfg = { world, cpu };
    this.go(null);
    this.hud?.el.remove();
    this.hud = null;
    this.bowlHud?.el.remove();
    this.bowlHud = null;
    this.duelHud?.el.remove();
    this.duelHud = null;
    this.archHud?.el.remove();
    this.archHud = null;
    const seats = this.app.input.activeSeats.length ? this.app.input.activeSeats : [this.app.input.seats[0]!];
    const person = (st: (typeof seats)[number]): Duelist => {
      const sp = this.app.humanSpec(st.slot, 0);
      return { name: sp.name, color: st.color, look: sp.look, handed: sp.handed, slot: st.slot, cpu: null };
    };
    const rival: Duelist =
      cpu < 0 && seats.length > 1
        ? person(seats[1])
        : { name: 'CPU', color: '#6c6a84', look: randomLook(this.rng), handed: this.rng.chance(0.15) ? -1 : 1, slot: -1, cpu: Math.max(0, cpu) || 0.65 };
    const duelists: [Duelist, Duelist] = [person(seats[0]), rival];
    this.app.startDuel(duelists, world);
    const g = this.app.duel!;
    this.duelHud = new DuelHud(duelists, g.toWin);
    this.hudLayer.append(this.duelHud.el);
    this.duelHud.setHint(this.duelHint());
    this.app.stage.setTeamColors(duelists[0].color, duelists[1].color);
    const def = worldDef(world);
    if (this.audio) {
      this.audio.playSong(def.song);
      this.audio.music.setIntensity(1);
      this.audio.sfx.cheer(0.4);
    }
    this.syncPads(true);
  }

  private duelHint() {
    const d = this.app.duel?.duelists.find((q) => q.cpu === null);
    if (!d) return '';
    const seat = this.app.input.seats[d.slot];
    return seat && !seat.local
      ? '<b>Swing</b> to strike · hold <b>GUARD</b> and hold your sword <b>across</b> their swing to block · <b>push</b> to thrust'
      : '<b>Arrows</b> or drag the mouse to slash · hold <b>Space</b> (or the right button) to guard · <b>X</b> thrust';
  }

  /** The arrows slash that way (the tip travels in the arrow's direction) — or, with
   *  Space held, set the guard: ↑ ↓ flat (stops chops), ← → upright (stops side cuts).
   *  A skips the walk-on. */
  private duelButton(slot: number, b: Btn, down: boolean) {
    const g = this.app.duel;
    if (!g) return false;
    const dirs: Partial<Record<Btn, number>> = { right: 0, up: Math.PI / 2, left: Math.PI, down: -Math.PI / 2 };
    const d = dirs[b];
    if (d !== undefined) {
      if (!down) return true;
      const me = g.fighters[g.duelists.findIndex((q) => q.slot === slot)];
      if (me?.phase === 'guard') this.app.input.localGuardAngle = b === 'up' || b === 'down' ? 0 : Math.PI / 2;
      else this.app.duelKeySlash(slot, { kind: 'slash', dir: d, power: 0.8 });
      return true;
    }
    if (b === 'a' && down) {
      g.skip();
      return true;
    }
    return false;
  }

  private duelEvent(e: DuelEvent) {
    const a = this.audio;
    const hud = this.duelHud;
    const g = this.app.duel;
    if (!g) return;
    const name = (i: number) => g.duelists[i].name;
    // sounds sit left or right as the near fighter sees it
    const pan = (x: number) => Math.max(-1, Math.min(1, x / 3));
    const pad = (i: number, fx: import('../shared/protocol').PadFx, label: string, detail = '') => {
      const d = g.duelists[i];
      const pid = d && d.slot >= 0 && d.cpu === null ? this.app.input.seats[d.slot]?.pid : undefined;
      if (pid) this.app.link.toPad(pid, { type: 'fx', fx, label, detail });
    };
    switch (e.type) {
      case 'round':
        hud?.setScore(g.score);
        hud?.tag(0, '');
        hud?.tag(1, '');
        hud?.say(e.final ? 'FINAL ROUND' : `ROUND ${e.round}`, e.final ? 'on a shorter platform' : '');
        if (e.round > 1) hud?.setHint('');
        this.syncPads(true);
        break;
      case 'fight':
        hud?.say('FIGHT!', '', 'good');
        a?.sfx.cheer(0.5);
        this.syncPads(true);
        break;
      case 'attack':
        a?.sfx.slash(e.attack.power, pan(g.fighters[e.who].x));
        break;
      case 'hit':
        a?.sfx.thwack(e.strength, pan(e.x));
        if (e.strength > 0.65) a?.sfx.ooh();
        pad(e.by, 'hit', 'HIT!', `${name(e.who)} knocked back`);
        pad(e.who, 'ouch', 'OUCH!', 'guard across their swing');
        break;
      case 'block':
        a?.sfx.clank(0.8, pan(e.x));
        hud?.say('BLOCKED!', `${name(e.by)} is stunned`, 'small good');
        pad(e.who, 'block', 'BLOCKED!', 'strike now — they’re stunned');
        pad(e.by, 'whiff', 'BLOCKED', 'you’re stunned — watch out');
        break;
      case 'clash':
        a?.sfx.clank(1, pan(e.x), true);
        hud?.say('CLASH!', '', 'small');
        break;
      case 'edge':
        a?.sfx.ooh();
        break;
      case 'fall':
        a?.sfx.aww();
        break;
      case 'splash':
        a?.sfx.splash(pan(e.x), this.app.stage.current?.def.id === 'cosmic');
        a?.sfx.cheer(0.8);
        break;
      case 'round-end': {
        hud?.setScore(e.score);
        if (e.winner === null) hud?.say(e.timeout ? 'TIME!' : 'DRAW', 'nobody takes the round');
        else hud?.say(`${name(e.winner)}`, e.timeout ? 'time! — takes the round' : 'takes the round', 'good');
        if (e.winner !== null) {
          pad(e.winner, 'point-won', 'ROUND WON', `${e.score[0]} – ${e.score[1]}`);
          pad(1 - e.winner, 'point-lost', 'ROUND LOST', `${e.score[0]} – ${e.score[1]}`);
        }
        break;
      }
      case 'over': {
        hud?.setScore(e.score);
        hud?.say(`${name(e.winner)} WINS!`, `${e.score[e.winner]} – ${e.score[1 - e.winner]}`, 'good');
        a?.sfx.cheer(1);
        a?.music.jingle('point');
        pad(e.winner, 'win', 'YOU WIN!', `${e.score[e.winner]} – ${e.score[1 - e.winner]}`);
        pad(1 - e.winner, 'lose', 'DEFEATED', `${e.score[1 - e.winner]} – ${e.score[e.winner]}`);
        this.syncPads(true);
        window.setTimeout(() => {
          if (this.app.sport === 'duel' && this.app.duel === g) this.go(this.duelResults(e.winner));
        }, 2600);
        break;
      }
    }
  }

  /** Per frame while duelling: the clock, arm strength and the edge/stun tags. */
  private duelFrame(_dt: number) {
    const g = this.app.duel;
    const hud = this.duelHud;
    if (!g || !hud) return;
    hud.update(g.state === 'fight' || g.state === 'ready' ? g.timeLeft : null, g.energy);
    g.fighters.forEach((f, i) => {
      const room = f.facing === 1 ? g.halfLength - f.z : f.z + g.halfLength;
      hud.tag(i, f.phase === 'stunned' ? 'STUNNED' : f.phase === 'fall' ? '' : g.state === 'fight' && room < 0.9 ? 'EDGE!' : '');
    });
    this.audio?.sfx.setCrowd(g.state === 'fight' ? 0.45 : g.state === 'fall' ? 0.9 : 0.3);
  }

  private duelResults(winner: number): Screen {
    const g = this.app.duel!;
    const again = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Rematch')));
    const other = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Another world')));
    const menu = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Main menu')));
    const nav = new Nav([
      { el: again, onSelect: () => this.duelCfg && this.beginDuel(this.duelCfg.world, this.duelCfg.cpu) },
      { el: other, onSelect: () => this.duelCfg && this.beginDuel(this.shuffledWorlds().find((w) => w !== this.duelCfg!.world) ?? 'park', this.duelCfg.cpu) },
      { el: menu, onSelect: () => this.quitToMenu() },
    ]);
    const rows = [winner, 1 - winner].map((i, k) =>
      h('div', { class: 'brank', style: `--c:${g.duelists[i].color}` }, h('b', null, `${k + 1}`), h('i'), h('span', null, g.duelists[i].name), h('em', null, `${g.score[i]} round${g.score[i] === 1 ? '' : 's'}`)),
    );
    const sheet = h('div', { class: 'sheet panel results' }, h('h2', null, `${g.duelists[winner].name} wins!`), h('div', { class: 'hintline' }, 'Final rounds'), ...rows, h('div', { class: 'menu' }, again, other, menu));
    return this.navScreen('duelresults', h('div', { class: 'screen center results' }, sheet), nav, () => this.quitToMenu(), { title: 'Duel over', hint: 'A to choose' });
  }

  // ---------------------------------------------------------------- bowling

  private bowlHud: BowlHud | null = null;
  private bowlCfg: { world: string; cpu: number } | null = null;
  private bowlRoll = { x: 0, z: 0, on: false };

  /** Who's bowling, an optional CPU, and where. */
  private bowlSetup(): Screen {
    const S = this.settings;
    const cpuLevels = [
      { label: 'No CPU', skill: -1 },
      { label: 'CPU · Rookie', skill: 0.3 },
      { label: 'CPU · Pro', skill: 0.65 },
      { label: 'CPU · Ace', skill: 0.9 },
    ];
    let cpu = this.bowlCfg ? Math.max(0, cpuLevels.findIndex((c) => c.skill === this.bowlCfg!.cpu)) : this.app.input.activeSeats.length > 1 ? 0 : 2;
    let wi = Math.max(0, WORLDS.findIndex((w) => w.id === (this.bowlCfg?.world ?? S.world)));
    const row = (k: string) => {
      const v = h('span');
      const r = h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, h('span', { class: 'arrow' }, '◀'), v, h('span', { class: 'arrow' }, '▶')));
      return { r, v };
    };
    const who = h('div', { class: 'hintline' });
    const cpuRow = row('Opponent');
    const worldRow = row('World');
    const go = h('div', { class: 'row go' }, 'Bowl!');
    const refresh = () => {
      const names = this.app.input.activeSeats.map((st) => st.name);
      who.textContent = names.length ? `Bowlers: ${names.join(', ')}` : 'Bowler: Player 1';
      cpuRow.v.textContent = cpuLevels[cpu].label;
      worldRow.v.textContent = WORLDS[wi].name;
    };
    const cycle = (d: number) => {
      wi = (wi + d + WORLDS.length) % WORLDS.length;
      this.app.stage.setWorld(WORLDS[wi].id, { transition: true });
      refresh();
    };
    const nav = new Nav([
      { el: cpuRow.r, onLeft: () => ((cpu = (cpu + 3) % 4), refresh()), onRight: () => ((cpu = (cpu + 1) % 4), refresh()), onSelect: () => ((cpu = (cpu + 1) % 4), refresh()) },
      { el: worldRow.r, onLeft: () => cycle(-1), onRight: () => cycle(1), onSelect: () => cycle(1) },
      { el: go, onSelect: () => void this.beginBowling(WORLDS[wi].id, cpuLevels[cpu].skill) },
    ]);
    refresh();
    const sheet = h(
      'div',
      { class: 'sheet panel' },
      h('h2', null, 'Bowling'),
      h('div', { class: 'hintline' }, 'Hold the grip on your phone, swing your arm back and through, and let go. Twist your wrist to hook it.'),
      who,
      cpuRow.r,
      worldRow.r,
      go,
    );
    return this.navScreen('bowlsetup', h('div', { class: 'screen center' }, sheet), nav, () => this.go(this.mainMenu()), { title: 'Bowling', hint: '◀ ▶ to change · A to bowl' });
  }

  async beginBowling(world: string, cpu: number) {
    this.bowlCfg = { world, cpu };
    this.go(null);
    this.hud?.el.remove();
    this.hud = null;
    this.bowlHud?.el.remove();
    this.bowlHud = null;
    this.duelHud?.el.remove();
    this.duelHud = null;
    this.archHud?.el.remove();
    this.archHud = null;
    const seats = this.app.input.activeSeats.length ? this.app.input.activeSeats : [this.app.input.seats[0]!];
    const specs = seats.map((st) => {
      const sp = this.app.humanSpec(st.slot, 0);
      return { name: sp.name, color: st.color, look: sp.look, handed: sp.handed, slot: st.slot, cpu: null as number | null };
    });
    if (cpu >= 0) specs.push({ name: 'CPU', color: '#6c6a84', look: randomLook(this.rng), handed: this.rng.chance(0.15) ? -1 : 1, slot: -1, cpu });
    await this.app.startBowling(specs, world);
    const g = this.app.bowl!;
    this.bowlHud = new BowlHud(g.bowlers);
    this.hudLayer.append(this.bowlHud.el);
    this.bowlHud.setHint(this.bowlHint());
    const def = worldDef(world);
    if (this.audio) {
      this.audio.playSong(def.song);
      this.audio.music.setIntensity(1);
      this.audio.sfx.cheer(0.4);
    }
    this.syncPads(true);
  }

  private bowlHint() {
    const b = this.app.bowl?.bowler;
    if (!b || b.cpu !== null) return '';
    const seat = this.app.input.seats[b.slot];
    return seat && !seat.local
      ? '<b>Hold</b> the ball · swing back and through · <b>let go</b> · twist to hook · <b>◀ ▶</b> move · <b>↺ ↻</b> aim'
      : '<b>Hold Space</b> (or the mouse) · let go to bowl · <b>J K L</b> straight / hook left / hook right · <b>arrows</b> move and aim';
  }

  /** ◀ ▶ step along the approach, ↺ ↻ (− +, or ▲ ▼) turn the aim; held down, they keep going. */
  private bowlButton(slot: number, b: Btn, down: boolean) {
    const g = this.app.bowl;
    if (!g) return false;
    if (b === 'left' || b === 'right') {
      g.move(slot, down ? (b === 'left' ? -1 : 1) : 0);
      return true;
    }
    if (b === 'minus' || b === 'plus' || b === 'up' || b === 'down') {
      g.turn(slot, down ? (b === 'minus' || b === 'up' ? -1 : 1) : 0);
      return true;
    }
    if (b === 'a' && down) {
      g.startNow();
      return true;
    }
    return false;
  }

  private bowlEvent(e: BowlEvent) {
    const a = this.audio;
    const hud = this.bowlHud;
    const g = this.app.bowl;
    if (!g) return;
    const pan = (x: number) => Math.max(-1, Math.min(1, x / 4));
    const padOf = (slot: number) => (slot >= 0 ? this.app.input.seats[slot]?.pid : undefined);
    switch (e.type) {
      case 'turn':
        hud?.update(g.current);
        hud?.showTurn(e.bowler, e.frame, e.ball);
        hud?.setHint(e.frame === 0 && e.ball === 0 ? this.bowlHint() : '');
        if (e.ball === 0) hud?.setPins(null);
        this.syncPads(true);
        break;
      case 'release': {
        a?.sfx.swish(0.8, 0);
        hud?.showSpeed(e.kph);
        hud?.setHint('');
        const pid = padOf(e.bowler.slot);
        const hook = Math.abs(e.t.spin) < 0.2 ? 'straight' : e.t.spin > 0 ? 'hook left' : 'hook right';
        if (pid) this.app.link.toPad(pid, { type: 'fx', fx: 'hit', power: Math.min(1, e.t.speed / 9), label: `${Math.round(e.kph)} km/h`, detail: hook });
        this.bowlRoll.on = true;
        this.syncPads(true);
        break;
      }
      case 'physics': {
        const p = e.e;
        if (p.type === 'hit') a?.sfx.pinHit(p.impact, pan(p.x), p.ballOnPin);
        else if (p.type === 'gutter') a?.sfx.gutter(pan(p.x));
        else if (p.type === 'pit') a?.sfx.thud(0);
        else if (p.type === 'settled') {
          this.bowlRoll.on = false;
          a?.sfx.roll(0);
        }
        break;
      }
      case 'result': {
        this.bowlRoll.on = false;
        a?.sfx.roll(0);
        const calls: Record<string, [string, string]> = { strike: ['STRIKE!', 'good'], spare: ['SPARE!', 'good'], split: ['SPLIT', 'bad'], gutter: ['GUTTER', 'bad'], miss: ['MISS', 'bad'] };
        const [text, cls] = calls[e.mark] ?? [`${e.pins} ${e.pins === 1 ? 'PIN' : 'PINS'}`, ''];
        hud?.say(text, e.mark === 'split' ? splitName(e.standing) : '', cls);
        hud?.update(g.current);
        hud?.setPins(e.mark === 'strike' || e.mark === 'spare' ? null : e.standing);
        if (e.mark === 'strike') {
          a?.sfx.cheer(1);
          a?.music.jingle('point');
        } else if (e.mark === 'spare') a?.sfx.cheer(0.7);
        else if (e.mark === 'split' || e.mark === 'gutter') a?.sfx.aww();
        else if (e.pins >= 7) a?.sfx.applause(0.4);
        const pid = padOf(e.bowler.slot);
        if (pid) this.app.link.toPad(pid, { type: 'fx', fx: e.mark === 'strike' || e.mark === 'spare' ? 'perfect' : 'hit', label: text, detail: `Frame ${e.frame + 1} · ${e.bowler.score.total()} total` });
        break;
      }
      case 'cancel': {
        hud?.setHint(this.bowlHint());
        const pid = padOf(e.bowler.slot);
        if (pid) this.app.link.toPad(pid, { type: 'fx', fx: 'whiff', label: 'Swing to bowl', detail: 'back, then through — let go at the bottom' });
        this.syncPads(true);
        break;
      }
      case 'sweep':
        a?.sfx.pinsetter();
        break;
      case 'over':
        this.bowlRoll.on = false;
        hud?.setPins(null);
        hud?.hideTurn();
        a?.sfx.roll(0);
        a?.sfx.cheer(1);
        window.setTimeout(() => {
          if (this.app.sport === 'bowling') this.go(this.bowlResults(e.ranking));
        }, 1600);
        break;
      default:
        break;
    }
  }

  /** Per frame while bowling: the rolling rumble follows the ball; pads follow the game. */
  private bowlFrame(dt: number) {
    const g = this.app.bowl;
    if (!g) return;
    const ball = g.phys.view.ball;
    if (this.bowlRoll.on && ball.visible && dt > 0) {
      const v = Math.hypot(ball.x - this.bowlRoll.x, ball.z - this.bowlRoll.z) / dt;
      this.audio?.sfx.roll(Math.min(1, v / 9) * (ball.gutter ? 0.6 : 1), Math.max(-1, Math.min(1, ball.x / 2)));
    }
    this.bowlRoll.x = ball.x;
    this.bowlRoll.z = ball.z;
    this.syncPads();
  }

  private bowlResults(ranking: import('./bowling/game').Bowler[]): Screen {
    const again = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Play again')));
    const other = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Another world')));
    const menu = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Main menu')));
    const nav = new Nav([
      { el: again, onSelect: () => this.bowlCfg && void this.beginBowling(this.bowlCfg.world, this.bowlCfg.cpu) },
      { el: other, onSelect: () => this.bowlCfg && void this.beginBowling(this.shuffledWorlds().find((w) => w !== this.bowlCfg!.world) ?? 'park', this.bowlCfg.cpu) },
      { el: menu, onSelect: () => this.quitToMenu() },
    ]);
    const winner = ranking[0];
    const top = winner.score.total();
    const tied = ranking.filter((b) => b.score.total() === top);
    // equal scores share a place (1, 1, 3)
    const place = (b: import('./bowling/game').Bowler) => 1 + ranking.filter((q) => q.score.total() > b.score.total()).length;
    const rows = ranking.map((b) =>
      h('div', { class: 'brank', style: `--c:${b.color}` }, h('b', null, `${place(b)}`), h('i'), h('span', null, b.name), h('em', null, String(b.score.total()))),
    );
    const title = ranking.length === 1 ? `${top} points!` : tied.length === ranking.length ? "It's a tie!" : tied.length > 1 ? `${tied.map((b) => b.name).join(' & ')} tie for first!` : `${winner.name} wins!`;
    const strikes = (b: import('./bowling/game').Bowler) => b.score.frames().reduce((n, f) => n + f.rolls.filter((r) => r === 'X').length, 0);
    const sheet = h(
      'div',
      { class: 'sheet panel results' },
      h('h2', null, title),
      h('div', { class: 'hintline' }, ranking.length > 1 ? 'Final scores' : `${strikes(winner)} strike${strikes(winner) === 1 ? '' : 's'} this game`),
      ...rows,
      h('div', { class: 'menu' }, again, other, menu),
    );
    return this.navScreen('bowlresults', h('div', { class: 'screen center results' }, sheet), nav, () => this.quitToMenu(), { title: 'Game over', hint: 'A to choose' });
  }

  // ---------------------------------------------------------------- swing lab

  private beginSwingLab() {
    const seat = this.app.input.activeSeats[0];
    const slot = seat ? seat.slot : 0;
    const me = this.app.humanSpec(slot, 0);
    const machine = { ...randomLook(this.rng), hair: 'none' as const, skin: '#b9bccb', shirt: '#4b4f73', eyes: 'wide' as const, cheeks: false, brows: false, racket: '#ffc53d' };
    const cfg: MatchConfig = {
      doubles: false,
      gamesToWin: 99,
      practice: true,
      players: [me, { team: 1, name: 'Ball machine', look: machine, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS.feeder } }],
      teamNames: [me.name, 'Ball machine'],
      firstServer: 1,
      introTime: 1.5,
    };
    this.teams = [
      { name: me.name, color: this.app.input.seats[slot]?.color ?? '#ff5a6e' },
      { name: 'Ball machine', color: '#4b4f73' },
    ];
    this.tourIdx = -1;
    this.mode = 'quick';
    this.lab = true;
    this.beginMatch(this.app.stage.current?.def.id ?? 'plaza', false, cfg);
    this.hud?.setLab('SWING LAB', [['Stroke', '—'], ['Timing', '—'], ['Power', '—'], ['Spin', '—'], ['Aim', '—']], 'Swing at the balls the machine feeds you. Every swing is read out here. Pause (Home) to leave.');
  }

  private labReadout(e: { kind: 'hit' | 'whiff'; stroke?: string; dtMs?: number; kph?: number; crossed?: boolean; perfect?: boolean; why?: string }) {
    const s = this.lastSwing;
    if (!s) return;
    const sideName: Record<string, string> = { fh: 'Forehand', bh: 'Backhand', oh: 'Overhead' };
    const stroke = s.side ? sideName[s.side] : e.stroke ? sideName[e.stroke] ?? e.stroke : '—';
    const dt = e.dtMs;
    const timing = dt === undefined ? '—' : Math.abs(dt) <= 25 ? `Perfect (${dt >= 0 ? '+' : ''}${dt} ms)` : dt < 0 ? `${-dt} ms early` : `${dt} ms late`;
    const att = s.attack ?? Math.round(Math.asin(Math.max(-1, Math.min(1, s.spin * 0.3))) * 57);
    const spin = s.spin > 0.25 ? `Topspin ${att}°` : s.spin < -0.25 ? `Slice ${att}°` : `Flat (${att}°)`;
    const aim = s.path === null || s.path === undefined ? (s.source === 'pad' ? 'recenter aim on the phone' : 'timing only') : `${Math.round(s.path)}° ${Math.abs(s.path) < 6 ? 'straight' : s.path < 0 ? 'left' : 'right'}`;
    const rows: [string, string, number?][] = [
      ['Stroke', e.crossed ? `${stroke} (reached across)` : stroke],
      ['Timing', timing],
      ['Power', `${Math.round(s.power * 100)}%`, s.power],
      ['Spin', spin],
      ['Aim', aim],
    ];
    if (e.kind === 'hit' && e.kph) rows.push(['Ball', `${Math.round(e.kph)} km/h${e.perfect ? ' · PERFECT' : ''}`]);
    else if (e.kind === 'whiff') rows.push(['Result', e.why === 'noball' ? 'No ball in play' : e.why === 'reach' ? 'Missed · out of reach' : e.why === 'early' ? 'Missed · too early' : e.why === 'late' ? 'Missed · too late' : 'Missed']);
    this.hud?.setLab('SWING LAB', rows);
  }

  // ---------------------------------------------------------------- world tour

  private tourScreen(): Screen {
    const T = loadTour();
    const cards = TOUR.map((c, i) => {
      const def = worldDef(c.world);
      const locked = i > T.beaten;
      const done = i < T.beaten;
      const final = i === TOUR.length - 1;
      return h(
        'div',
        { class: `shard ${locked ? 'locked' : ''} ${done ? 'done' : ''} ${final ? 'final' : ''}` },
        h('div', { class: 'st' }, done ? '★' : locked ? '🔒' : '▶'),
        h('div', { class: 'num' }, final ? 'FINAL' : `WORLD ${i + 1}`),
        h('div', { class: 'wn', style: `font-family:${final ? "'Fredoka'" : def.ui.display}` }, final ? 'The Prism' : def.name),
        h('div', { class: 'cn' }, locked ? '???' : c.name),
      );
    });
    const big = h('div', { class: 'tbig' });
    const setBig = (i: number) => {
      const c = TOUR[i];
      const def = worldDef(c.world);
      clear(big);
      if (i > T.beaten) {
        big.append(h('div', { class: 'cn', style: `font-family:${def.ui.display}` }, '???'), h('div', { class: 'ct' }, 'Restore the previous shard to unlock'));
      } else {
        big.append(h('div', { class: 'cn', style: `font-family:${def.ui.display}` }, c.name), h('div', { class: 'ct' }, c.title), h('div', { class: 'cq' }, `“${c.quote}”`));
      }
    };
    const nav = new Nav(
      TOUR.map((c, i) => ({
        el: cards[i],
        onSelect: () => {
          if (i > T.beaten) {
            this.sound('error');
            return;
          }
          this.beginTour(i);
        },
      })),
      true,
    );
    const start = Math.min(T.beaten, TOUR.length - 1);
    nav.onChange = (i) => {
      setBig(i);
      const w = TOUR[i].world;
      if (this.app.stage.current?.def.id !== w) {
        this.app.stage.setWorld(w, { transition: true, origin: { x: (i + 0.5) / TOUR.length, y: 0.8 } });
        this.audio?.sfx.ui('shift');
      }
    };
    nav.focus(start);
    setBig(start);
    if (this.app.stage.current?.def.id !== TOUR[start].world) this.app.stage.setWorld(TOUR[start].world, { transition: true });
    const restored = Math.min(T.beaten, 8);
    const el = h(
      'div',
      { class: 'screen tour' },
      h('div', { class: 'headline' }, h('b', null, 'WORLD TOUR'), h('span', null, `The Great Prism shattered into eight worlds. ${restored} of 8 shards restored.`)),
      big,
      h('div', { class: 'shards' }, ...cards),
    );
    return this.navScreen('tour', el, nav, () => this.go(this.mainMenu()), { title: 'World Tour', hint: '◀ ▶ choose · A play' });
  }

  private beginTour(i: number) {
    const c = TOUR[i];
    const seat = this.app.input.activeSeats[0];
    const slot = seat ? seat.slot : 0;
    const me = this.app.humanSpec(slot, 0);
    const cfg: MatchConfig = {
      doubles: false,
      gamesToWin: c.games,
      players: [me, { team: 1, name: c.name, look: c.look, handed: c.handed, ctrl: { kind: 'cpu', ai: c.ai } }],
      teamNames: [me.name, c.name],
      firstServer: 0,
      introTime: 7.2,
    };
    this.teams = [
      { name: me.name, color: this.app.input.seats[slot]?.color ?? '#ff5a6e' },
      { name: c.name, color: c.look.shirt },
    ];
    this.tourIdx = i;
    this.mode = c.kaleido ? 'kaleido' : 'quick';
    this.beginMatch(c.world, false, cfg, c);
  }

  private versusIntro(c: Champion, def: WorldDef) {
    const m = this.app.match!;
    const champ = m.players.find((p) => p.team === 1)!;
    this.app.rig.versus = champ;
    this.app.rig.setMode('versus');
    champ.emote = 'wave';
    champ.emoteT0 = 0;
    const voice = 260 + ((TOUR.indexOf(c) * 97) % 420);
    this.hud?.setHint('');
    this.hud?.showQuote(c.name, c.title, c.quote, c.look.shirt, (ch) => this.audio?.sfx.blip(ch, voice));
    let done = false;
    const end = () => {
      if (done || this.app.match !== m) return;
      done = true;
      this.versusEnd = null;
      this.hud?.hideQuote();
      champ.emote = 'none';
      this.app.rig.setMode('intro');
      this.hud?.showBanner(def, `${this.teams[0].name}  vs  ${this.teams[1].name}`);
      // shorten the remaining intro so the fly-in lands right on the first serve
      m.cfg.introTime = Math.min(m.cfg.introTime ?? 7, m.t + 3.2);
    };
    this.versusEnd = end;
    window.setTimeout(end, Math.min(6500, 1400 + c.quote.length * 45));
  }

  private tourResults(): Screen {
    const m = this.app.match!;
    const i = this.tourIdx;
    const c = TOUR[i];
    const won = m.score.winner === 0;
    const T = loadTour();
    if (won && T.beaten <= i) {
      T.beaten = i + 1;
      saveTour(T);
    }
    if (won && i === TOUR.length - 1) return this.endingScreen();
    const cont = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, won ? 'Continue the tour' : 'Try again')));
    const map = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Tour map')));
    const menu = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Main menu')));
    const nav = new Nav([
      { el: cont, onSelect: () => (won ? this.go(this.tourScreen()) : this.beginTour(i)) },
      { el: map, onSelect: () => this.go(this.tourScreen()) },
      { el: menu, onSelect: () => this.quitToMenu() },
    ]);
    const def = worldDef(c.world);
    const sheet = h(
      'div',
      { class: 'sheet panel', style: `--c:${won ? this.teams[0].color : c.look.shirt}` },
      h('div', { class: 'winner', style: `font-family:${def.ui.display}` }, won ? 'Shard restored!' : `${c.name} wins`),
      h('div', { class: 'final' }, `${m.score.games[0]} – ${m.score.games[1]}`),
      h('div', { class: 'hintline', style: 'font-size:calc(var(--u)*2.6);opacity:.85' }, won ? `“${c.beatLine}”` : 'So close. Every champion has a weakness — find it.'),
      h('div', { class: 'hintline' }, won ? `${Math.min(8, i + 1)} of 8 shards restored` : `Longest rally: ${this.stats.longest} shots`),
      h('div', { class: 'menu' }, cont, map, menu),
    );
    return this.navScreen('results', h('div', { class: 'screen center results' }, sheet), nav, () => this.go(this.tourScreen()), { title: won ? 'Shard restored!' : 'Try again', hint: 'A to choose' });
  }

  private endingScreen(): Screen {
    const back = h('div', { class: 'item' }, h('div', { class: 'txt' }, h('span', null, 'Back to the menu')));
    const nav = new Nav([{ el: back, onSelect: () => this.quitToMenu() }]);
    this.audio?.music.jingle('match');
    this.audio?.sfx.cheer(1);
    let k = 0;
    const cycle = window.setInterval(() => {
      if (this.screen?.name !== 'ending') {
        clearInterval(cycle);
        return;
      }
      k = (k + 1) % WORLDS.length;
      this.app.stage.setWorld(WORLDS[k].id, { transition: true, origin: { x: Math.random(), y: Math.random() * 0.6 + 0.2 } });
      this.audio?.sfx.ui('shift');
    }, 2600);
    const el = h(
      'div',
      { class: 'screen ending' },
      h('h1', null, 'The Prism is whole'),
      h('p', null, 'Eight worlds, eight champions, one ball. The Kaleidoscope turns again — and every world remembers your rallies.'),
      h('div', { class: 'credits' }, 'KALEIDO · World Tennis', h('br'), 'Designed & built by Claude for Veer', h('br'), 'Every model, shader, song and sound made from code'),
      h('div', { class: 'menu' }, back),
    );
    return this.navScreen('ending', el, nav, () => this.quitToMenu(), { title: 'Champion!', hint: 'A to continue' });
  }

  private freshStats(): Stats {
    return { points: [0, 0], aces: [0, 0], winners: [0, 0], errors: [0, 0], fastest: [0, 0], perfects: [0, 0], longest: 0 };
  }

  // ---------------------------------------------------------------- match events → HUD / audio / pads

  private matchEvent(e: MatchEvent) {
    const m = this.app.match!;
    const a = this.audio;
    const real = !this.app.attract;
    const pan = (x: number) => Math.max(-1, Math.min(1, x / 8));
    switch (e.type) {
      case 'hit': {
        if (this.lab && e.p.human) this.labReadout({ kind: 'hit', stroke: e.stroke, dtMs: e.dtMs, kph: e.kph, crossed: e.crossed, perfect: e.perfect });
        this.hitTimes.push(m.t);
        if (this.hitTimes.length > 8) this.hitTimes.shift();
        this.lastHit = { kind: e.kind, kph: e.kph, perfect: e.perfect };
        a?.sfx.hit(e.power, e.perfect, pan(e.pos.x), e.kind === 'smash' || !!e.rocket);
        if (e.rocket) {
          a?.sfx.swish(1, pan(e.pos.x));
          if (real) a?.sfx.ooh();
        }
        if (real) {
          a?.music.hitNote(e.rally + 1, e.power, pan(e.pos.x));
          this.stats.fastest[e.p.team] = Math.max(this.stats.fastest[e.p.team], e.kph);
          if (e.perfect) this.stats.perfects[e.p.team]++;
          if (e.p.human) {
            const seat = this.app.input.seats[e.p.slot];
            const timing = e.rocket ? 'ROCKET SERVE' : e.perfect ? 'PERFECT' : e.tau < -0.55 ? 'EARLY' : e.tau > 0.55 ? 'LATE' : 'GOOD';
            const strokeName = e.serve ? 'Serve' : e.kind === 'smash' ? 'Smash' : e.stroke === 'bh' ? 'Backhand' : e.stroke === 'oh' ? 'Overhead' : 'Forehand';
            const spinName = e.kind === 'lob' ? ' lob' : e.kind === 'drop' ? ' drop shot' : e.kind === 'wobbly' ? ' floater' : e.spin > 0.3 ? ' topspin' : e.spin < -0.3 ? ' slice' : '';
            const detail = `${strokeName}${spinName} · ${Math.round(e.kph)} km/h`;
            if (seat?.pid) this.app.link.toPad(seat.pid, { type: 'fx', fx: e.perfect ? 'perfect' : 'hit', power: e.power, label: timing, detail });
            const label = e.rocket ? 'ROCKET SERVE!' : e.perfect ? 'PERFECT!' : e.tau < -0.55 ? 'EARLY' : e.tau > 0.55 ? 'LATE' : e.kind === 'lob' ? 'LOB' : e.kind === 'drop' ? 'DROP SHOT' : e.kind === 'smash' ? 'SMASH!' : e.serve ? '' : '';
            const sub = e.serve ? '' : `${strokeName.toUpperCase()}${spinName.toUpperCase()}`;
            if (label || sub) this.hud?.float(label ? `${label}${sub ? ' · ' + sub : ''}` : sub, { x: e.pos.x, y: e.pos.y + 0.9, z: e.pos.z }, e.perfect ? 'perfect' : label ? '' : 'soft', e.p.team);
            if (!this.settings.seenTutorial && this.stats.fastest[e.p.team] > 0) {
              this.settings.seenTutorial = true;
              this.save();
              this.hud?.setHint('');
            }
          }
          if (e.kph > 105 && (e.serve || e.kind === 'smash' || e.perfect)) this.hud?.showSpeed(e.kph);
          this.hud?.setRally(e.rally);
          if (a) a.music.setIntensity(e.rally >= 9 ? 3 : e.rally >= 4 ? 2 : 1);
          // Kaleido: a perfect shot deep in a rally shatters the world
          // (once per rally: the next world gets prepared between points)
          if (this.mode === 'kaleido' && e.perfect && e.rally >= 5 && e.p.human && !this.shiftedThisRally && !this.app.stage.transitioning) {
            this.shiftedThisRally = true;
            this.shiftWorld(e.pos);
          }
        }
        break;
      }
      case 'whiff':
        if (this.lab && e.p.human) this.labReadout({ kind: 'whiff', dtMs: e.dtMs, why: e.why });
        if (real && e.p.human && e.why !== 'noball') {
          const why = e.why === 'reach' ? 'OUT OF REACH' : e.tau < -1 ? 'TOO EARLY' : e.tau > 1 ? 'TOO LATE' : '';
          this.hud?.float(why ? `MISS · ${why}` : 'MISS', { x: e.p.x, y: 2.1, z: e.p.z }, 'miss', e.p.team);
          const seat = this.app.input.seats[e.p.slot];
          if (seat?.pid && m.state === 'play') this.app.link.toPad(seat.pid, { type: 'fx', fx: 'whiff', label: why });
        }
        break;
      case 'bounce':
        if (e.impact > 0.8) a?.sfx.bounce(e.impact, pan(e.pos.x));
        break;
      case 'athletic':
        if (e.move !== 'lunge') a?.sfx.swish(e.move === 'dive' ? 1 : 0.55, pan(e.p.x));
        if (real && e.move === 'dive' && e.p.human) this.hud?.float('DIVE!', { x: e.p.x, y: 2.2, z: e.p.z }, 'soft', e.p.team);
        break;
      case 'land':
        a?.sfx.thud(pan(e.pos.x));
        if (real) a?.sfx.ooh();
        break;
      case 'tired':
        if (real) this.hud?.float('Tired!', { x: e.p.x, y: 2.3, z: e.p.z }, 'soft');
        break;
      case 'smash-chance':
        if (real) this.hud?.float('SMASH!', { x: e.p.x, y: 2.5, z: e.p.z }, 'perfect', e.p.team);
        break;
      case 'net':
        a?.sfx.net(e.cord, pan(e.pos.x));
        if (real && e.cord && e.over) a?.sfx.ooh();
        break;
      case 'close-call':
        if (real) a?.sfx.ooh();
        break;
      case 'toss':
        if (real && e.p.human) {
          const seat = this.app.input.seats[e.p.slot];
          if (seat?.pid) this.app.link.toPad(seat.pid, { type: 'fx', fx: 'toss' });
          this.hud?.setHint('<b>SWING!</b>', seat?.color);
        }
        break;
      case 'catch':
        this.syncPads(true);
        break;
      case 'fault':
        if (real) {
          this.hud?.say(e.double ? 'DOUBLE FAULT' : 'FAULT', undefined, e.double ? 'bad small' : 'small quick');
          a?.say(e.double ? 'Double fault' : 'Fault');
          if (!e.double) a?.sfx.aww();
        }
        break;
      case 'let':
        if (real) {
          this.hud?.say('LET', 'Replay the serve', 'small quick');
          a?.say('Let');
        }
        break;
      case 'point': {
        this.pointsSinceShift++;
        const w = e.winner;
        this.stats.points[w]++;
        this.stats.longest = Math.max(this.stats.longest, e.rally);
        const loser = (1 - w) as 0 | 1;
        if (e.reason === 'ace') this.stats.aces[w]++;
        else if (e.reason === 'winner') this.stats.winners[w]++;
        else this.stats.errors[loser]++;
        if (!real) {
          a?.sfx.applause(0.4 + Math.min(0.5, e.rally * 0.05));
          break;
        }
        if (this.lab) {
          // practice: no score, no umpire — just a little applause for long rallies
          if (e.rally >= 4) a?.sfx.applause(0.3 + Math.min(0.4, e.rally * 0.04));
          this.hud?.setRally(0);
          break;
        }
        const reasonText: Record<string, string> = { ace: 'ACE!', winner: e.rally > 1 ? 'WINNER!' : 'NICE SHOT!', out: 'OUT!', long: 'OUT!', wide: 'WIDE!', net: 'NET!', double: '', unreturned: 'NICE SHOT!' };
        const humanWon = m.team(w).some((p) => p.human);
        const humanLost = m.team(loser).some((p) => p.human);
        const good = humanWon || (!humanLost && true);
        const txt = reasonText[e.reason];
        const call = e.matchWon ? 'Game, set & match' : e.gameWon ? `Game ${this.teams[w].name}` : e.call;
        if (txt) this.hud?.say(txt, call, good ? 'good' : 'bad');
        else this.hud?.say(e.gameWon ? 'GAME' : call, e.gameWon ? call : undefined, 'small');
        if (e.gameWon && !e.matchWon) this.hud?.say('GAME', `${this.teams[0].name} ${m.score.games[0]} – ${m.score.games[1]} ${this.teams[1].name}`, 'good', 0.2);
        if (e.matchWon) this.hud?.say('GAME, SET', 'AND MATCH!', 'good', 0.2);
        a?.sfx.cheer(Math.min(1, 0.45 + e.rally * 0.05 + (e.gameWon ? 0.3 : 0)));
        a?.music.jingle(e.matchWon ? 'match' : e.gameWon ? 'game' : humanWon || !humanLost ? 'point' : 'lose');
        window.setTimeout(() => a?.say(e.matchWon ? 'Game, set and match' : e.gameWon ? `Game, ${this.teams[w].name}` : e.call.replace('–', ' ')), 700);
        a?.music.setIntensity(e.gameWon ? 3 : 1);
        // pads
        for (const p of m.players) {
          if (!p.human) continue;
          const seat = this.app.input.seats[p.slot];
          if (seat?.pid) this.app.link.toPad(seat.pid, { type: 'fx', fx: e.matchWon ? (p.team === w ? 'win' : 'lose') : p.team === w ? 'point-won' : 'point-lost' });
        }
        this.hud?.setScore(m);
        this.hud?.setRally(0);
        this.syncScoreboard();
        this.app.link.toAll({ type: 'score', line: `${m.score.pointText(0)}–${m.score.pointText(1)}  ·  ${m.score.games[0]}–${m.score.games[1]}` });
        // instant replay for highlights
        this.pointsSinceReplay++;
        const lh = this.lastHit;
        const highlight =
          e.rally >= 8 ||
          (e.reason === 'winner' && (lh.kind === 'smash' || lh.perfect || lh.kph > 118)) ||
          (e.reason === 'ace' && lh.kph > 150) ||
          ((e.gameWon || e.matchWon) && e.rally >= 3);
        if (highlight && (this.pointsSinceReplay >= 3 || e.matchWon || e.rally >= 12)) {
          const tPoint = m.t;
          const from = Math.max(tPoint - 6.5, (this.hitTimes[this.hitTimes.length - 3] ?? tPoint - 4) - 0.5);
          window.setTimeout(() => {
            if (this.app.match !== m || this.screen || this.app.replay) return;
            if (m.state !== 'dead' && m.state !== 'over') return;
            if (this.app.startReplay(from, tPoint + 0.6)) {
              this.pointsSinceReplay = 0;
              this.hud?.clearCallouts();
              this.hud?.setReplay(true);
              this.syncPads(true);
            }
          }, 1250);
        }
        this.hitTimes.length = 0;
        this.shiftedThisRally = false;
        if (this.mode === 'kaleido' && this.pointsSinceShift >= 2 && !e.matchWon) {
          window.setTimeout(() => {
            if (this.app.match === m && !this.app.stage.transitioning) this.shiftWorld({ x: 0, y: 1, z: w === 0 ? 5 : -5 });
          }, 1400);
        }
        break;
      }
      case 'state':
        if (e.state === 'over' && real && !this.resultsShown) {
          this.resultsShown = true;
          window.setTimeout(() => {
            if (this.app.match === m && m.state === 'over') this.go(this.resultsScreen());
          }, 900);
        }
        if (e.state === 'serve' || e.state === 'reset') this.hud?.setScore(m);
        this.syncPads();
        break;
      case 'serve-ready':
        this.syncPads(true);
        break;
    }
  }

  /** Prepare a world shortly — at a moment when a hiccup can't interrupt a rally. */
  private warmSoon(id: string | undefined, delay = 2500) {
    if (!id) return;
    const tryWarm = () => {
      const m = this.app.match;
      const busy = m && !this.app.attract && !this.app.paused && (m.state === 'play' || m.state === 'toss');
      if (busy) window.setTimeout(tryWarm, 250);
      else this.app.stage.warm(id, this.app.rig.cam);
    };
    window.setTimeout(tryWarm, delay);
  }

  private shiftWorld(at: { x: number; y: number; z: number }) {
    if (WORLDS.length < 2) return;
    this.pointsSinceShift = 0;
    this.kaleidoIdx = (this.kaleidoIdx + 1) % this.kaleidoOrder.length;
    const next = this.kaleidoOrder[this.kaleidoIdx];
    this.warmSoon(this.kaleidoOrder[(this.kaleidoIdx + 1) % this.kaleidoOrder.length], 3000);
    const p = this.app.rig.project(at);
    this.app.stage.setWorld(next, { transition: true, origin: { x: p.x, y: p.y } });
    this.audio?.sfx.ui('shift');
    this.app.rig.kick(0.4);
    const def = worldDef(next);
    this.hud?.showBanner(def, '');
  }

  private syncScoreboard() {
    const m = this.app.match;
    const w = this.app.stage.current as unknown as { setScoreboard?: (n: [string, string], g: [string, string], p: [string, string]) => void };
    if (!w?.setScoreboard) return;
    if (!m || this.app.attract) {
      w.setScoreboard(['KALEIDO', 'WORLD TENNIS'], ['', ''], ['', '']);
      return;
    }
    w.setScoreboard([this.teams[0].name, this.teams[1].name], [String(m.score.games[0]), String(m.score.games[1])], [m.score.pointText(0), m.score.pointText(1)]);
  }

  // ---------------------------------------------------------------- pads

  syncPads(force = false) {
    const m = this.app.match;
    for (const seat of this.app.input.seats) {
      if (!seat || !seat.pid || !seat.connected) continue;
      let mode: PadMode = 'menu';
      let title = this.screen?.pad?.title;
      let hint = this.screen?.pad?.hint;
      const g = this.app.bowl;
      const dg = this.app.duel;
      const ag = this.app.archery;
      if (!this.screen && this.app.sport === 'archery' && ag) {
        const up = ag.archers[ag.current];
        const mine = up?.slot === seat.slot && up.cpu === null;
        if (mine && (ag.state === 'aim' || ag.state === 'intro' || ag.state === 'next')) {
          mode = 'bow';
          title = 'Your shot!';
          hint = `End ${ag.end} · arrow ${ag.arrowNo} of ${ag.arrows}`;
        } else {
          mode = 'wait';
          title = mine ? 'Flying…' : up ? `${up.name} is shooting` : 'Archery';
          hint = mine ? 'watch the target' : 'you’re next soon';
        }
      } else if (!this.screen && this.app.sport === 'duel' && dg) {
        const mine = dg.duelists.find((d) => d.slot === seat.slot && d.cpu === null);
        if (mine && dg.state !== 'over') {
          mode = 'sword';
          title = dg.state === 'intro' || dg.state === 'ready' ? 'En garde!' : 'Fight!';
          hint = `Round ${dg.round} · ${dg.score[0]} – ${dg.score[1]}`;
        } else {
          mode = 'watch';
          title = mine ? 'Duel over' : 'Watching';
          hint = mine ? 'look at the screen' : `${dg.duelists[0].name} vs ${dg.duelists[1].name}`;
        }
      } else if (!this.screen && this.app.sport === 'bowling' && g) {
        const up = g.bowler;
        const mine = up.slot === seat.slot;
        if (mine && (g.state === 'ready' || g.state === 'approach' || g.state === 'intro')) {
          mode = 'bowl';
          title = 'Your turn!';
          hint = up.score.frame === 9 ? `10th frame · ball ${up.score.ball + 1}` : `Frame ${up.score.frame + 1} · ball ${up.score.ball + 1}`;
        } else {
          mode = 'wait';
          title = mine ? 'Rolling…' : `${up.name} is up`;
          hint = mine ? 'watch the pins' : 'you\'re next soon';
        }
      } else if (!this.screen && this.app.replay) {
        mode = 'skip';
        title = 'SKIP';
        hint = 'replay';
      } else if (!this.screen && m && !this.app.attract) {
        const mine = m.players.filter((p) => p.slot === seat.slot);
        if (!mine.length) {
          mode = 'watch';
          title = 'Watching';
          hint = 'Enjoy the match';
        } else if (m.isServerSlot(seat.slot)) {
          mode = 'serve';
          title = m.second ? 'SECOND SERVE' : 'LIFT TO TOSS';
          hint = 'raise the phone (or tap), then swing';
        } else {
          mode = 'play';
          title = m.state === 'intro' ? 'Get ready!' : 'Rally!';
          hint = 'Swing like a racket';
        }
      }
      const key = `${mode}|${title}|${hint}`;
      if (!force && this.padModes.get(seat.pid) === key) continue;
      this.padModes.set(seat.pid, key);
      this.app.link.toPad(seat.pid, { type: 'mode', mode, title, hint });
    }
  }

  // ---------------------------------------------------------------- per frame

  private frame(dt: number) {
    this.time += dt;
    this.screen?.update?.(dt);
    this.hud?.update(dt);
    if (this.app.sport === 'bowling') this.bowlFrame(dt);
    else if (this.app.sport === 'duel') this.duelFrame(dt);
    else if (this.app.sport === 'archery') this.archeryFrame(dt);
    const m = this.app.match;
    if (m && !this.app.attract && this.hud) {
      // serve hint
      const srv = m.server;
      if (this.versusEnd) {
        // champion is talking: keep the screen clear
      } else if ((m.state === 'serve' || m.state === 'intro') && srv?.human) {
        // the "Server" badge by the player says what to do; keep the bottom of the screen clear
        this.hud.setHint('');
      } else if (m.state === 'toss' && srv?.human) {
        // SWING! set on toss
      } else if (m.state !== 'intro' || this.settings.seenTutorial) {
        if (!(m.state === 'play' && !this.settings.seenTutorial)) this.hud.setHint('');
      }
      if (this.audio) this.audio.sfx.setCrowd(m.excitement);
      if (!this.versusEnd) {
        const seat = srv?.human ? this.app.input.seats[srv.slot] : null;
        this.hud.track(m, dt, !seat ? '' : seat.local ? 'Space to toss' : 'lift your phone to toss');
      }
      if (m.state === 'serve' && !this.tossHintShown) this.tossHintShown = true;
    }
    // attract mode showcases the worlds
    if (this.app.attract && this.screen && (this.screen.name === 'title' || this.screen.name === 'menu') && WORLDS.length > 1) {
      if (this.time > this.attractShiftAt) {
        this.attractShiftAt = this.time + 14;
        const i = WORLDS.findIndex((w) => w.id === this.app.stage.current?.def.id);
        const next = WORLDS[(i + 1) % WORLDS.length];
        this.app.stage.setWorld(next.id, { transition: true, origin: { x: 0.5, y: 0.45 } });
        this.audio?.sfx.ui('shift');
        this.warmSoon(WORLDS[(i + 2) % WORLDS.length].id, 4000);
      }
    }
    if ((this.screen?.name === 'title' || this.screen?.name === 'menu') && this.time >= this.joinRefreshAt) {
      this.joinRefreshAt = this.time + 3;
      this.join.refresh();
    }
  }

  // ---------------------------------------------------------------- misc

  private toastTimer = 0;
  private joinRefreshAt = 0;
  toast(text: string, color = '#3aa8ff') {
    clear(this.toastEl);
    this.toastEl.append(h('i', { style: `--c:${color}` }), text);
    this.toastEl.style.setProperty('--c', color);
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  private applyTheme(def: WorldDef) {
    setVars(this.root, {
      '--accent': def.ui.accent,
      '--accent2': def.ui.accent2,
      '--ink': def.ui.ink,
      '--paper': def.ui.paper,
      '--font': def.ui.font,
      '--display': def.ui.display,
      '--panel': def.ui.panel,
    });
  }
}

/** "7-10", "4-6-7-10"… the standing pins of a split */
function splitName(standing: boolean[]) {
  return standing
    .map((st, i) => (st ? i + 1 : 0))
    .filter(Boolean)
    .join('-');
}
