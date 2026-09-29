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
  /** estimated real-time age of the swing when it arrived, seconds (0..SWING_AGE_MAX) */
  age: number;
  source: 'pad' | 'mouse' | 'key';
  side?: 'fh' | 'bh' | 'oh';
  /** racket-head direction at contact, degrees (player frame), if calibrated */
  path?: number | null;
  attack?: number;
}

export type Btn = PadButton;

/**
 * The oldest a swing can be taken to be when it arrives, seconds: the same reach as the other
 * timed messages (ageOf's 0.25). Through the cloud a swing is often 0.1–0.2 s old; clamping it
 * lower reads a well-timed swing as late (see tennis/match.ts, whose late window is the narrow one).
 */
export const SWING_AGE_MAX = 0.25;

/**
 * The last few samples of something a phone streams at 20–30 Hz (its orientation: 6 numbers; the
 * bowling arm: 1), by arrival time. What's drawn isn't the newest sample held until the next
 * one comes (a staircase, half a step behind on average) and isn't eased towards it (a trail
 * behind it either): `now()` carries the newest sample on by the time since it arrived, along
 * the velocity of the last two steps, for a moment at most; `at()` reads what was on screen at a
 * past instant (the pose a release was made in).
 */
export class Track {
  private static readonly CAP = 16;
  private t = new Float64Array(Track.CAP);
  private rt = new Float64Array(Track.CAP);
  private ld = new Float64Array(Track.CAP);
  private v: Float64Array;
  private n = 0;
  private head = 0;
  constructor(readonly dim: number) {
    this.v = new Float64Array(Track.CAP * dim);
  }

  /** arrival time (ms) of the newest sample, or −Infinity */
  get last() {
    return this.n ? this.t[this.idx(this.n - 1)] : -Infinity;
  }

  /** `t` is the sample's own time (its arrival, or, for a stamped one, arrival less its trip); `lead`: how far behind arrival that put it, ms (0 for an unstamped one).
   *  `rt`: the relay's clock when it forwarded the message (0 = unknown), or the phone's stamp, which keeps the spacing honest when several arrive together */
  push(t: number, rt: number, vals: ArrayLike<number>, lead = 0) {
    const k = (this.head + this.n) % Track.CAP;
    if (this.n < Track.CAP) this.n++;
    else this.head = (this.head + 1) % Track.CAP;
    this.t[k] = t;
    this.rt[k] = rt;
    this.ld[k] = lead;
    for (let d = 0; d < this.dim; d++) this.v[k * this.dim + d] = vals[d];
  }

  clear() {
    this.n = 0;
    this.head = 0;
  }

  private idx(i: number) {
    return (this.head + i) % Track.CAP;
  }

  /** ms between two samples: the relay's clock when it has one, else arrival */
  private gap(a: number, b: number) {
    const r = this.rt[b] - this.rt[a];
    const d = this.rt[a] > 0 && this.rt[b] > 0 && r > 0 && r < 1000 ? r : this.t[b] - this.t[a];
    return Math.max(1, d);
  }

  /**
   * The newest sample carried on to `now` (ms): by the time since it arrived, at the rate of the last
   * two intervals, but no further than `maxEx` ms (a stream that has stopped stays put). A change
   * smaller than `dead` over those two intervals is a hand at rest (the phone rounds to 0.01):
   * no velocity. False if there's nothing fresher than `stale` ms.
   */
  now(now: number, out: Float64Array | number[], maxEx = 45, dead = 0.015, stale = 400) {
    if (!this.n) return false;
    const b = this.idx(this.n - 1);
    const age = now - this.t[b];
    if (age > stale) return false;
    const D = this.dim;
    for (let d = 0; d < D; d++) out[d] = this.v[b * D + d];
    if (this.n < 2 || maxEx <= 0) return true;
    const a = this.idx(Math.max(0, this.n - 3));
    const steps = Math.max(1, Math.min(2, this.n - 1));
    const span = this.gap(a, b);
    // (more than a step and a half beyond the newest is a guess too far, whatever maxEx says)
    // (a sample that took `lead` ms to get here is carried on by that as well: its own 45 ms / step-and-a-half of guess comes on top,
    // or the pose would stall at the cap and jump at the next sample, a sawtooth 30 ms wide)
    const lead = Math.min(80, this.ld[b]);
    const ex = Math.min(Math.max(0, age), maxEx + lead, (1.5 * span) / steps + lead);
    let mag = 0;
    for (let d = 0; d < D; d++) mag += (this.v[b * D + d] - this.v[a * D + d]) ** 2;
    if (Math.sqrt(mag) < dead) return true;
    const k = ex / span;
    for (let d = 0; d < D; d++) out[d] += (this.v[b * D + d] - this.v[a * D + d]) * k;
    return true;
  }

  /** the value at time `t` (ms, the arrival clock): between the samples either side of it, else the nearest */
  at(t: number, out: Float64Array | number[]) {
    if (!this.n) return false;
    const D = this.dim;
    let hi = this.n - 1;
    while (hi > 0 && this.t[this.idx(hi - 1)] >= t) hi--;
    const b = this.idx(hi);
    if (hi === 0 || this.t[b] <= t) {
      for (let d = 0; d < D; d++) out[d] = this.v[b * D + d];
      return true;
    }
    const a = this.idx(hi - 1);
    const u = Math.min(1, Math.max(0, (t - this.t[a]) / Math.max(1, this.t[b] - this.t[a])));
    for (let d = 0; d < D; d++) out[d] = this.v[a * D + d] + (this.v[b * D + d] - this.v[a * D + d]) * u;
    return true;
  }
}

/** A phone pose read from a track: the racket/blade (s, the phone's top) and the screen's normal (n), player frame. */
export interface OriPose {
  s: [number, number, number];
  n: [number, number, number];
}

export class Input {
  seats: (Seat | null)[] = [null, null, null, null];
  onSwing: (e: SwingEv) => void = () => {};
  onToss: (slot: number) => void = () => {};
  onButton: (slot: number, b: Btn, down: boolean) => void = () => {};
  onSeatsChanged: () => void = () => {};
  onWave: (slot: number) => void = () => {};
  onPrep: (slot: number, side: 'fh' | 'bh') => void = () => {};
  /** bowling: the grip went down / up, the ball was released, the arm's live angle */
  onGrip: (slot: number, down: boolean, age?: number) => void = () => {};
  onBowl: (slot: number, r: { speed: number; angle: number; spin: number }, age?: number) => void = () => {};
  onArm: (slot: number, arm: number) => void = () => {};
  /** set by the app while bowling: Space/mouse bowl instead of swinging */
  bowlMode = false;
  /** sword duel: guard held / let go, and an attack (slash or thrust) */
  onGuard: (slot: number, down: boolean, age?: number) => void = () => {};
  onSlash: (slot: number, a: SlashInput, age?: number) => void = () => {};
  /** set by the app while duelling: Space guards, X thrusts, mouse drags slash */
  duelMode = false;
  /** the local player's guard angle from the mouse (radians across their view, 0 = level,
   *  π/2 = upright), or null to let the game pick one */
  localGuardAngle: number | null = null;
  /** archery: DRAW went down (pull the string) / up (shoot) */
  onDraw: (slot: number, down: boolean, age?: number) => void = () => {};
  /** set by the app while shooting: the mouse aims, holding the button draws, Space draws too */
  archeryMode = false;
  /** the cursor in normalised device coordinates (−1..1, y up) — the archery aim */
  mouseNdc = { x: 0, y: 0 };
  /** archery: the arrow keys' fine adjustment to the aim, radians */
  aimNudge = { yaw: 0, pitch: 0 };
  private duelCool = 0;
  private bowlSpin = 0;
  private bowlDrag: { y: number; t: number; hist: { x: number; y: number; t: number }[] } | null = null;
  /** live racket orientation per slot (player frame: x right, y towards screen, z up) */
  racket: ({ s: [number, number, number]; n: [number, number, number]; t: number } | null)[] = [null, null, null, null];
  /** the last few poses per slot (see Track), for reading them smoothly and at a past instant */
  private oriTrack = [new Track(6), new Track(6), new Track(6), new Track(6)];
  private armTrack = [new Track(1), new Track(1), new Track(1), new Track(1)];
  private oriBuf = new Float64Array(6);
  private oriOut: OriPose[] = [0, 1, 2, 3].map(() => ({ s: [0, 1, 0], n: [0, 0, 1] }));
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
      if (this.archeryMode) {
        // shooting with the mouse: hold to draw, the cursor aims, let go to shoot
        this.lastLocalInput = performance.now();
        this.onDraw(0, true);
        return;
      }
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
      if (this.archeryMode && e.button === 0) {
        this.onDraw(0, false);
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

  /**
   * How old a phone's message is when it's handled here, seconds: what the phone
   * measured before sending (`age`), its one-way trip to the server (`lat`, the
   * phone's estimate) and the relay's trip to us (`rt`, the server's clock at the
   * relay, against ours corrected by the link's measured offset). Clamped: a stale
   * one is compensated up to `max`, never further back.
   */
  private ageOf(rt: number, lat: number, age = 0, max = 0.25, ts?: number): number {
    const transit = Math.max(0, Date.now() + this.link.serverOffset - rt);
    // the phone's leg: this message's own uplink time when the phone stamped it (the relay's clock at its send), else the phone's median
    const up = typeof ts === 'number' && Number.isFinite(ts) ? Math.min(400, Math.max(0, rt - ts)) : lat;
    return Math.min(max, Math.max(0, (age + up + transit) / 1000));
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
      case 'swing':
        this.onSwing({ slot: seat.slot, power: m.power, spin: m.spin, age: this.ageOf(rt, m.lat, m.age, SWING_AGE_MAX, m.ts), source: 'pad', side: m.side, path: m.path, attack: m.attack });
        break;
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
      case 'ori': {
        const now = performance.now();
        this.racket[seat.slot] = { s: m.s, n: m.n, t: now };
        // the sample's own time in this clock: when the phone stamped it (`ts`), arrival less its trip (Track.now then carries it on
        // by its true age); an unstamped one is taken as just arrived. The phone's send times also give the spacing.
        const stamped = typeof m.ts === 'number' && Number.isFinite(m.ts);
        let t = now;
        let clock = rt;
        if (stamped) {
          const up = Math.min(400, Math.max(0, rt - (m.ts as number)));
          const transit = Math.max(0, Date.now() + this.link.serverOffset - rt);
          t = now - up - transit;
          clock = m.ts as number;
        }
        this.oriBuf.set(m.s, 0);
        this.oriBuf.set(m.n, 3);
        const to = this.inOrder(this.oriTrack[seat.slot], t, now);
        this.oriTrack[seat.slot].push(to, clock, this.oriBuf, now - to);
        if (m.arm !== undefined) {
          this.oriBuf[0] = m.arm;
          const ta = this.inOrder(this.armTrack[seat.slot], t, now);
          this.armTrack[seat.slot].push(ta, clock, this.oriBuf, now - ta);
          this.onArm(seat.slot, m.arm);
        }
        break;
      }
      case 'grip':
        this.onGrip(seat.slot, m.down, this.ageOf(rt, m.lat, 0, 0.25, m.ts));
        break;
      case 'bowl':
        this.onBowl(seat.slot, { speed: m.speed, angle: m.angle, spin: m.spin }, this.ageOf(rt, m.lat, m.age, 0.25, m.ts));
        break;
      case 'guard':
        this.onGuard(seat.slot, m.down, this.ageOf(rt, m.lat, 0, 0.25, m.ts));
        break;
      case 'slash':
        this.onSlash(seat.slot, { kind: m.kind, dir: m.dir, power: m.power }, this.ageOf(rt, m.lat, m.age, 0.25, m.ts));
        break;
      case 'draw':
        this.onDraw(seat.slot, m.down, this.ageOf(rt, m.lat, 0, 0.25, m.ts));
        break;
    }
  }

  /** a sample time for the track: never before the newest sample's (a spike-delayed one can't reorder the stream), never after `now` (no pose from the future) */
  private inOrder(tr: Track, t: number, now: number) {
    return Math.min(now, Math.max(t, tr.last));
  }

  /**
   * The phone's pose to draw now (`now`, ms): the newest carried on by the time since it arrived
   * (see Track.now). Null if the stream has stopped. The object is reused: read it, don't keep it.
   * `maxEx` 0 gives the newest sample exactly (for an aim, where a steady hand shouldn't be
   * amplified).
   */
  oriNow(slot: number, now = performance.now(), maxEx = 45): OriPose | null {
    const b = this.oriBuf;
    if (!this.oriTrack[slot].now(now, b, maxEx, 0.015)) return null;
    return this.oriPose(slot, b);
  }

  /** the pose that arrived nearest to time `t` (ms, performance.now()'s clock): a release's, a draw's */
  oriAt(slot: number, t: number): OriPose | null {
    const b = this.oriBuf;
    if (!this.oriTrack[slot].at(t, b)) return null;
    return this.oriPose(slot, b);
  }

  private oriPose(slot: number, b: Float64Array) {
    const o = this.oriOut[slot];
    // (a carried-on pose is no longer exactly unit length)
    const ls = Math.hypot(b[0], b[1], b[2]) || 1;
    o.s[0] = b[0] / ls;
    o.s[1] = b[1] / ls;
    o.s[2] = b[2] / ls;
    const ln = Math.hypot(b[3], b[4], b[5]) || 1;
    o.n[0] = b[3] / ln;
    o.n[1] = b[4] / ln;
    o.n[2] = b[5] / ln;
    return o;
  }

  /** the bowling arm's angle to draw now (radians), carried on like the pose; null if the phone isn't streaming it */
  armNow(slot: number, now = performance.now(), maxEx = 45): number | null {
    const b = this.oriBuf;
    // (rounded to 0.01 rad: a change under 0.012 over two steps is standing still)
    return this.armTrack[slot].now(now, b, maxEx, 0.012) ? b[0] : null;
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
    if (this.archeryMode) {
      // Space: hold to draw, let go to shoot (the mouse aims; the arrows fine-tune it)
      if (e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) this.onDraw(0, down);
        return;
      }
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
    this.mouseNdc.x = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    this.mouseNdc.y = 1 - (e.clientY / Math.max(1, window.innerHeight)) * 2;
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
