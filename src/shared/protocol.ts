// Messages exchanged between the phone remotes ("pads"), the server hub and
// the Mac display ("tv"). The server only routes; the TV is the authority.

export type Handed = 'R' | 'L';
export type PadButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'home' | 'plus' | 'minus';

export interface SwingMsg {
  type: 'swing';
  seq: number;
  /** 0..1 normalised swing speed. */
  power: number;
  /** -1 (slice: racket moving down) .. +1 (topspin: racket brushing up). */
  spin: number;
  /** Peak angular speed in rad/s (for tuning). */
  peak: number;
  /** ms between the swing's peak and the message being sent. */
  age: number;
  /** Pad's current estimate of one-way latency to the server, ms. */
  lat: number;
  /** True when produced by the on-screen swipe fallback rather than motion. */
  touch?: boolean;
  /** forehand / backhand / overhead, from the swing's rotation about the vertical axis */
  side?: 'fh' | 'bh' | 'oh';
  /** angle of attack at contact, degrees (+ brushing up) */
  attack?: number;
  /** horizontal direction the racket head was travelling at contact, degrees
   *  relative to the calibrated "towards the screen" (− left, + right); null if uncalibrated */
  path?: number | null;
}

/** Appearance a player picks on their phone. */
export interface LookPrefs {
  hair: string;
  hairColor: string;
  skin: string;
  eyes: string;
}

export const HAIRS = ['cap', 'spiky', 'bob', 'bun', 'band', 'beanie', 'mohawk', 'pony', 'afro', 'bowl', 'none'];
export const HAIR_NAMES: Record<string, string> = { cap: 'Cap', spiky: 'Spiky', bob: 'Bob', bun: 'Bun', band: 'Headband', beanie: 'Beanie', mohawk: 'Mohawk', pony: 'Ponytail', afro: 'Afro', bowl: 'Bowl', none: 'Bald' };
export const EYES = ['oval', 'dot', 'tall', 'wide', 'sleepy'];
export const SKIN_TONES = ['#ffdcc2', '#f6c9a4', '#e9b48a', '#d49a6a', '#b77a4e', '#8d5a36', '#6b4226'];
export const HAIR_TONES = ['#2b1d16', '#4a2e1f', '#7a4a26', '#c98a3c', '#e8c16a', '#1c1c24', '#b8b8c8', '#d65a3a', '#6d3fa0', '#3aa8ff'];

export type PadMsg =
  | { type: 'hello'; name: string; handed: Handed; ver: number; motion: boolean; look?: LookPrefs }
  | SwingMsg
  | { type: 'toss'; lat: number }
  | { type: 'btn'; b: PadButton; down: boolean }
  | { type: 'prefs'; name: string; handed: Handed; look?: LookPrefs }
  | { type: 'wave'; power: number }
  /** a backswing: the player is setting up on this side */
  | { type: 'prep'; side: 'fh' | 'bh'; lat: number }
  /** live racket orientation in the player's frame (x right, y towards screen, z up):
   *  s = shaft (phone top), n = face (screen normal); while bowling with the grip
   *  held, `arm` = the bowling arm's pendulum angle, radians, −2.2 … 2.2: 0 = hanging
   *  straight down, + = forward/up, − = behind (as BowlerState.arm). Guessed at the
   *  grip from how the phone is held (looked at in front ≈ +1.1), then tracked; the
   *  swing itself shows where the arm is within a fraction of a second. In a duel
   *  s is the blade: ~30 a second (10 over the HTTP fallback); without motion sensors
   *  the pose the guard toggle says (upright, or across the body) */
  | { type: 'ori'; s: [number, number, number]; n: [number, number, number]; arm?: number }
  /** bowling: the grip (hold the ball) went down / was let go */
  | { type: 'grip'; down: boolean; lat: number }
  /** bowling: the ball was released — measured from the swing.
   *  speed m/s; spin −1..1 (+ hooks left); angle radians (+ right), ±0.2: the swing's line
   *  against the player's own backswing (a straight pendulum = 0, a push right / pull left
   *  across the body = ±), or against the calibrated screen when there was no real backswing */
  | { type: 'bowl'; speed: number; angle: number; spin: number; lat: number; touch?: boolean }
  /** sword duel: the guard button went down / was let go. While it's held the
   *  sword guards at whatever angle the phone is held (from the 'ori' stream; one
   *  goes just before each 'guard' with the angle it went up / came down at) */
  | { type: 'guard'; down: boolean; lat: number }
  /** sword duel: an attack, measured from the swing. slash: `dir` = which way the
   *  phone's top (the sword's tip) travelled across the player's view, radians:
   *  0 = right, π/2 = up, −π/2 = down (a chop), ±π = left. thrust: a push towards
   *  the screen (dir 0, unused). power 0..1 = how hard. touch = from an on-screen
   *  swipe (a tap is a thrust). Sent ~35 ms after the swing's peak (a thrust: as the
   *  arm is half-way out), just after an 'ori' with the pose it struck in; never
   *  while the guard is held — let go of it to attack */
  | { type: 'slash'; kind: 'slash' | 'thrust'; dir: number; power: number; lat: number; touch?: boolean }
  /** archery: the DRAW pad went down (start pulling the string) / was let go (shoot).
   *  The aim is the 'ori' stream: the TV turns the phone's movement since the draw
   *  began into the aim, so drift doesn't matter. An 'ori' is sent just before each */
  | { type: 'draw'; down: boolean; lat: number };

/** bowl = your turn to bowl: the grip pad plus move (◀ ▶ = btn left/right) and
 *  aim (↺ ↻ = btn minus/plus) buttons. sword = a duel: swing to attack, hold the
 *  guard pad to block (the sword follows the phone, streamed as 'ori') */
export type PadMode = 'menu' | 'play' | 'serve' | 'wait' | 'watch' | 'skip' | 'bowl' | 'sword' | 'bow';

export type PadFx =
  | 'hit'
  | 'perfect'
  | 'whiff'
  | 'point-won'
  | 'point-lost'
  | 'select'
  | 'move'
  | 'back'
  | 'toss'
  | 'win'
  | 'lose'
  /** duel: your guard stopped an attack (a clank) */
  | 'block'
  /** duel: you took a hit */
  | 'ouch';

export type TVMsg =
  | { type: 'welcome'; slot: number; color: string; name: string }
  | { type: 'full' }
  | { type: 'mode'; mode: PadMode; title?: string; hint?: string }
  | { type: 'fx'; fx: PadFx; power?: number; label?: string; detail?: string }
  | { type: 'score'; line: string };

export interface PadInfo {
  pid: string;
  name: string;
  transport: string;
}

export type ServerToTV =
  | { type: 'hello'; joinUrl: string | null; caUrl: string | null; ips: string[]; dev: boolean; pads: PadInfo[] }
  | { type: 'net'; joinUrl: string | null; caUrl: string | null; ips: string[] }
  | { type: 'pad-join'; pid: string; name: string; transport: string }
  | { type: 'pad-leave'; pid: string }
  | { type: 'pad'; pid: string; rt: number; msg: PadMsg }
  | { type: 'replaced' };

export type ServerToPad =
  | TVMsg
  | { type: 'pong'; t: number; st: number }
  | { type: 'link'; transport: string; st: number }
  | { type: 'bye'; reason: string };

export const PLAYER_COLORS = ['#ff5a6e', '#3aa8ff', '#ffc53d', '#35d49a'];
export const PLAYER_COLOR_NAMES = ['Red', 'Blue', 'Yellow', 'Green'];
