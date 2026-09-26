// Unified input: phone remotes, mouse flicks and the keyboard all become the
// same small set of events, tagged with the player slot they belong to.

import type { PadButton, PadMsg, Handed, LookPrefs } from '../../shared/protocol';
import { PLAYER_COLORS } from '../../shared/protocol';
import type { TVLink } from './link';
import type { SlashInput } from '../duel/types';

export interface Seat {
  slot: number;
  pid: string | null;
  name: string;
  handed: Handed;
  color: string;
  connected: boolean;
  motion: boolean;
  transport: string;
  /** the local mouse/keyboard seat */
  local: boolean;
  /** appearance chosen on the phone */
  look?: LookPrefs;
  lastSeen: number;
}

export interface SwingEv {
  slot: number;
  power: number;
  spin: number;
  /** estimated real-time age of the swing when it arrived, seconds */
  age: number;
  source: 'pad' | 'mouse' | 'key';
  side?: 'fh' | 'bh' | 'oh';
  /** racket-head direction at contact, degrees (player frame), if calibrated */
  path?: number | null;
  attack?: number;
}

export type Btn = PadButton;

export class Input {
  seats: (Seat | null)[] = [null, null, null, null];
  onSwing: (e: SwingEv) => void = () => {};
  onToss: (slot: number) => void = () => {};
  onButton: (slot: number, b: Btn, down: boolean) => void = () => {};
  onSeatsChanged: () => void = () => {};
  onWave: (slot: number) => void = () => {};
  onPrep: (slot: number, side: 'fh' | 'bh') => void = () => {};
  /** bowling: the grip went down / up, the ball was released, the arm's live angle */
  onGrip: (slot: number, down: boolean) => void = () => {};
  onBowl: (slot: number, r: { speed: number; angle: number; spin: number }) => void = () => {};
  onArm: (slot: number, arm: number) => void = () => {};
  /** set by the app while bowling: Space/mouse bowl instead of swinging */
  bowlMode = false;
  /** sword duel: guard held / let go, and an attack (slash or thrust) */
  onGuard: (slot: number, down: boolean) => void = () => {};
  onSlash: (slot: number, a: SlashInput) => void = () => {};
  /** set by the app while duelling: Space guards, X thrusts, mouse drags slash */
  duelMode = false;
  /** the local player's guard angle from the mouse (radians across their view, 0 = level,
   *  π/2 = upright), or null to let the game pick one */
  localGuardAngle: number | null = null;
  private duelCool = 0;
  private bowlSpin = 0;
  private bowlDrag: { y: number; t: number; hist: { x: number; y: number; t: number }[] } | null = null;
  /** live racket orientation per slot (player frame: x right, y towards screen, z up) */
  racket: ({ s: [number, number, number]; n: [number, number, number]; t: number } | null)[] = [null, null, null, null];
  /** set by the app: while true the mouse drives swings (in matches) */
  mouseSwings = false;
  private mouse = { x: 0, y: 0, t: 0, hist: [] as { x: number; y: number; t: number }[], cool: 0 };
  lastLocalInput = 0;

  constructor(private link: TVLink) {
    this.seats[0] = this.localSeat(0);
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('pointermove', (e) => this.pointer(e));
    // a click on the game (not on a menu) tosses the ball when serving
    window.addEventListener('pointerdown', (e) => {
      if (this.duelMode && e.button === 2 && !(e.target as HTMLElement)?.closest?.('.screen')) {
        // duelling with the mouse: hold the right button to guard, the blade pointing at the cursor
        this.lastLocalInput = performance.now();
        this.localGuardAngle = this.mouseAngle(e);
        this.onGuard(0, true);
        return;
      }
      if (e.button !== 0 || (e.target as HTMLElement)?.closest?.('.screen')) return;
      if (this.bowlMode) {
        // bowling with the mouse: press to grip, flick up and let go to bowl
        this.lastLocalInput = performance.now();
        this.bowlDrag = { y: e.clientY, t: performance.now(), hist: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
        this.onGrip(0, true);
        return;
      }
      if (!this.mouseSwings) return;
      this.lastLocalInput = performance.now();
      this.onToss(0);
    });
    window.addEventListener('contextmenu', (e) => {
      if (this.duelMode) e.preventDefault();
    });
    window.addEventListener('pointerup', (e) => {
      if (this.duelMode && e.button === 2) {
        this.onGuard(0, false);
        return;
      }
      const d = this.bowlDrag;
      if (!this.bowlMode || !d) return;
      this.bowlDrag = null;
      // the flick over the last ~120 ms sets speed, line and spin
      const now = performance.now();
      const h = d.hist.filter((p) => now - p.t < 140);
      const a = h[0] ?? { x: e.clientX, y: e.clientY, t: now - 100 };
      const dt = Math.max(0.03, (now - a.t) / 1000);
      const vy = (a.y - e.clientY) / dt / Math.max(600, window.innerHeight);
      const vx = (e.clientX - a.x) / dt / Math.max(600, window.innerHeight);
      this.onGrip(0, false);
      this.onBowl(0, { speed: 3 + Math.max(0, vy) * 1.6, angle: Math.max(-0.15, Math.min(0.15, vx * 0.05)), spin: this.bowlSpin });
    });
  }

  private localSeat(slot: number): Seat {
    return {
      slot,
      pid: null,
      name: 'Player 1',
      handed: 'R',
      color: PLAYER_COLORS[slot],
      connected: true,
      motion: false,
      transport: 'local',
      local: true,
      lastSeen: performance.now(),
    };
  }

  /** Seats that should play (phones that are connected, plus the local seat when no phone holds P1). */
  get activeSeats(): Seat[] {
    return this.seats.filter((s): s is Seat => !!s && (s.connected || s.local));
  }

  get padCount() {
    return this.seats.filter((s) => s && !s.local && s.connected).length;
  }

  seatOfPid(pid: string) {
    return this.seats.find((s) => s && s.pid === pid) ?? null;
  }

  // ---------------------------------------------------------------- server events

  padJoin(pid: string, name: string, transport: string) {
    let seat = this.seatOfPid(pid);
    if (!seat) {
      // P1's local seat hands over to the first phone
      let slot = this.seats.findIndex((s) => !s || s.local);
      if (slot < 0) slot = this.seats.findIndex((s) => s && !s.connected);
      if (slot < 0) {
        this.link.toPad(pid, { type: 'full' });
        return;
      }
      seat = {
        slot,
        pid,
        name: name || `Player ${slot + 1}`,
        handed: 'R',
        color: PLAYER_COLORS[slot],
        connected: true,
        motion: true,
        transport,
        local: false,
        lastSeen: performance.now(),
      };
      this.seats[slot] = seat;
    }
    seat.connected = true;
    seat.transport = transport;
    seat.name = name || seat.name;
    this.link.toPad(pid, { type: 'welcome', slot: seat.slot, color: seat.color, name: seat.name });
    this.onSeatsChanged();
  }

  padLeave(pid: string) {
    const s = this.seatOfPid(pid);
    if (!s) return;
    s.connected = false;
    this.onSeatsChanged();
  }

  /** Forget disconnected phones (e.g. back at the title screen). */
  prune() {
    for (let i = 0; i < 4; i++) {
      const s = this.seats[i];
      if (s && !s.local && !s.connected) this.seats[i] = null;
    }
    if (!this.seats[0]) this.seats[0] = this.localSeat(0);
    this.onSeatsChanged();
  }

  padMsg(pid: string, rt: number, m: PadMsg) {
    const seat = this.seatOfPid(pid);
    if (!seat) return;
    seat.lastSeen = performance.now();
    switch (m.type) {
      case 'hello':
        seat.name = m.name || seat.name;
        seat.handed = m.handed;
        seat.motion = m.motion;
        if (m.look) seat.look = m.look;
        this.onSeatsChanged();
        break;
      case 'prefs':
        seat.name = m.name || seat.name;
        seat.handed = m.handed;
        if (m.look) seat.look = m.look;
        this.onSeatsChanged();
        break;
      case 'swing': {
        const transit = Math.max(0, Date.now() - rt);
        const ageMs = Math.min(160, Math.max(0, m.age + m.lat + transit));
        this.onSwing({ slot: seat.slot, power: m.power, spin: m.spin, age: ageMs / 1000, source: 'pad', side: m.side, path: m.path, attack: m.attack });
        break;
      }
      case 'toss':
        this.onToss(seat.slot);
        break;
      case 'btn':
        this.onButton(seat.slot, m.b, m.down);
        break;
      case 'wave':
        this.onWave(seat.slot);
        break;
      case 'prep':
        this.onPrep(seat.slot, m.side);
        break;
      case 'ori':
        this.racket[seat.slot] = { s: m.s, n: m.n, t: performance.now() };
        if (m.arm !== undefined) this.onArm(seat.slot, m.arm);
        break;
      case 'grip':
        this.onGrip(seat.slot, m.down);
        break;
      case 'bowl':
        this.onBowl(seat.slot, { speed: m.speed, angle: m.angle, spin: m.spin });
        break;
      case 'guard':
        this.onGuard(seat.slot, m.down);
        break;
      case 'slash':
        this.onSlash(seat.slot, { kind: m.kind, dir: m.dir, power: m.power });
        break;
    }
  }

  // ---------------------------------------------------------------- local input

  private key(e: KeyboardEvent, down: boolean) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    this.lastLocalInput = performance.now();
    const map: Record<string, Btn> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      w: 'up',
      s: 'down',
      a: 'left',
      d: 'right',
      Enter: 'a',
      Escape: 'b',
      Backspace: 'b',
      p: 'home',
      '+': 'plus',
      '=': 'plus',
      '-': 'minus',
    };
    const b = map[e.key];
    if (b) {
      e.preventDefault();
      if (!e.repeat) this.onButton(0, b, down);
      return;
    }
    if (this.bowlMode) {
      const k = e.key.toLowerCase();
      // Space: hold to grip, let go to bowl; J straight, K hook left, L hook right
      if (k === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        this.lastLocalInput = performance.now();
        this.onGrip(0, down);
        if (!down) this.onBowl(0, { speed: 7.3, angle: 0, spin: this.bowlSpin });
        return;
      }
      if (down && (k === 'j' || k === 'k' || k === 'l')) this.bowlSpin = k === 'k' ? 0.7 : k === 'l' ? -0.7 : 0;
      if (down && (k === 'j' || k === 'k' || k === 'l')) return;
    }
    if (this.duelMode) {
      // Space: hold to guard (the game angles it for you); X: thrust. The arrows
      // slash (the flow turns them into strikes)
      const k = e.key.toLowerCase();
      if (k === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        this.localGuardAngle = null;
        this.onGuard(0, down);
        return;
      }
      if (k === 'x') {
        if (down && !e.repeat) this.onSlash(0, { kind: 'thrust', dir: 0, power: e.shiftKey ? 1 : 0.8 });
        return;
      }
    }
    if (!down || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'f') {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.().catch(() => {});
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      this.onToss(0);
      this.onSwing({ slot: 0, power: 0.72, spin: 0.2, age: 0, source: 'key' });
    } else if (k === 'j' || k === 'k' || k === 'l' || k === 'u' || k === 'i') {
      const spin = k === 'k' ? 0.8 : k === 'l' ? -0.8 : k === 'u' ? 0.7 : k === 'i' ? -0.7 : 0.1;
      const power = k === 'u' || k === 'i' ? 0.18 : e.shiftKey ? 1 : 0.75;
      this.onSwing({ slot: 0, power, spin, age: 0, source: 'key' });
    } else if (k === 't') {
      this.onToss(0);
    }
  }

  /** the blade's angle for a guard pointing from the middle of the screen at the cursor */
  private mouseAngle(e: PointerEvent) {
    return Math.atan2(window.innerHeight / 2 - e.clientY, e.clientX - window.innerWidth / 2);
  }

  private pointer(e: PointerEvent) {
    const now = performance.now();
    if (this.bowlDrag) {
      this.bowlDrag.hist.push({ x: e.clientX, y: e.clientY, t: now });
      if (this.bowlDrag.hist.length > 40) this.bowlDrag.hist.shift();
    }
    const m = this.mouse;
    m.hist.push({ x: e.clientX, y: e.clientY, t: now });
    while (m.hist.length && now - m.hist[0].t > 90) m.hist.shift();
    if (this.duelMode) {
      if (e.buttons & 2) this.localGuardAngle = this.mouseAngle(e);
      // a quick drag with the left button held is a slash that way
      if (!(e.buttons & 1) || now < this.duelCool || m.hist.length < 3) return;
      const a = m.hist[0];
      const dt = (now - a.t) / 1000;
      if (dt < 0.02) return;
      const dx = e.clientX - a.x;
      const dy = e.clientY - a.y;
      const sp = Math.hypot(dx, dy) / dt / Math.max(600, window.innerHeight);
      if (sp > 2.2) {
        this.duelCool = now + 320;
        this.lastLocalInput = now;
        this.onSlash(0, { kind: 'slash', dir: Math.atan2(-dy, dx), power: Math.min(1, 0.3 + (sp - 2.2) / 7) });
        m.hist.length = 0;
      }
      return;
    }
    if (!this.mouseSwings || now < m.cool || m.hist.length < 3) return;
    const a = m.hist[0];
    const dt = (now - a.t) / 1000;
    if (dt < 0.02) return;
    const dx = e.clientX - a.x;
    const dy = e.clientY - a.y;
    const sp = Math.hypot(dx, dy) / dt / Math.max(600, window.innerHeight);
    if (sp > 2.6) {
      m.cool = now + 380;
      this.lastLocalInput = now;
      const power = Math.min(1, (sp - 2.6) / 6);
      const dist = Math.hypot(dx, dy) || 1;
      const spin = -dy / dist;
      const side = Math.abs(dx) < dist * 0.35 ? undefined : dx < 0 ? 'fh' : 'bh';
      this.onSwing({ slot: 0, power: 0.25 + power * 0.75, spin: Math.abs(spin) < 0.35 ? 0 : spin, age: 0.02, source: 'mouse', side });
      m.hist.length = 0;
    }
  }
}
