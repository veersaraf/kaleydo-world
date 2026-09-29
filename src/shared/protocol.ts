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
  /** The relay's clock (ms, Date.now() there) when the pad sent this, as the pad has learned its offset; absent until it has (the TV then uses `lat`). */
  ts?: number;
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
  | { type: 'toss'; lat: number; ts?: number }
  | { type: 'btn'; b: PadButton; down: boolean }
  | { type: 'prefs'; name: string; handed: Handed; look?: LookPrefs }
  | { type: 'wave'; power: number }
  /** a backswing: the player is setting up on this side */
  | { type: 'prep'; side: 'fh' | 'bh'; lat: number; ts?: number }
  /** live racket orientation in the player's frame (x right, y towards screen, z up):
   *  s = shaft (phone top), n = face (screen normal); while bowling with the grip
   *  held, `arm` = the bowling arm's pendulum angle, radians, −2.2 … 2.2: 0 = hanging
   *  straight down, + = forward/up, − = behind (as BowlerState.arm). Guessed at the
   *  grip from how the phone is held (looked at in front ≈ +1.1), then tracked; the
   *  swing itself shows where the arm is within a fraction of a second. In a duel
   *  s is the blade: ~30 a second (10 over the HTTP fallback); without motion sensors
   *  the pose the guard toggle says (upright, or across the body) */
  | { type: 'ori'; s: [number, number, number]; n: [number, number, number]; arm?: number; /** the relay's clock at the send, one integer (the phone's Date.now() + its offset; only once known): the TV draws the pose as old as it really is */ ts?: number }
  /** bowling: the grip (hold the ball) went down / was let go */
  | { type: 'grip'; down: boolean; lat: number; ts?: number }
  /** bowling: the ball was released — measured from the swing.
   *  speed m/s; spin −1..1 (+ hooks left); angle radians (+ right), ±0.2: the swing's line
   *  against the player's own backswing (a straight pendulum = 0, a push right / pull left
   *  across the body = ±), or against the calibrated screen when there was no real backswing */
  | { type: 'bowl'; speed: number; angle: number; spin: number; lat: number; ts?: number; touch?: boolean; /** ms between the release and the message being sent */ age?: number }
  /** sword duel: the guard button went down / was let go. While it's held the
   *  sword guards at whatever angle the phone is held (from the 'ori' stream; one
   *  goes just before each 'guard' with the angle it went up / came down at) */
  | { type: 'guard'; down: boolean; lat: number; ts?: number }
  /** sword duel: an attack, measured from the swing. slash: `dir` = which way the
   *  phone's top (the sword's tip) travelled across the player's view, radians:
   *  0 = right, π/2 = up, −π/2 = down (a chop), ±π = left. thrust: a push towards
   *  the screen (dir 0, unused). power 0..1 = how hard. touch = from an on-screen
   *  swipe (a tap is a thrust). Sent ~35 ms after the swing's peak (a thrust: as the
   *  arm is half-way out), just after an 'ori' with the pose it struck in; never
   *  while the guard is held — let go of it to attack */
  | { type: 'slash'; kind: 'slash' | 'thrust'; dir: number; power: number; lat: number; ts?: number; touch?: boolean; /** ms between the swing's peak and the message being sent */ age?: number }
  /** archery: the DRAW pad went down (start pulling the string) / was let go (shoot).
   *  The aim is the 'ori' stream: the TV turns the phone's movement since the draw
   *  began into the aim, so drift doesn't matter. An 'ori' is sent just before each */
  | { type: 'draw'; down: boolean; lat: number; ts?: number };

/** bowl = your turn to bowl: the grip pad plus move (◀ ▶ = btn left/right) and
 *  aim (↺ ↻ = btn minus/plus) buttons. sword = a duel: swing to attack, hold the
 *  guard pad to block (the sword follows the phone, streamed as 'ori'). bat = at
 *  bat in baseball: swing the phone like a bat (the tennis swing message) */
export type PadMode = 'menu' | 'play' | 'serve' | 'wait' | 'watch' | 'skip' | 'bowl' | 'sword' | 'bow' | 'bat';

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
  | 'ouch'
  /** tennis: a smash chance is floating your way (the phone lights up) */
  | 'smash-chance'
  /** tennis: you smashed it */
  | 'smash';

export type TVMsg =
  | { type: 'welcome'; slot: number; color: string; name: string }
  | { type: 'full' }
  /** lock: show the panel but don't take input (bowling while your ball rolls,
   *  archery while your arrow flies — the last throw and the verdict stay in view) */
  | { type: 'mode'; mode: PadMode; title?: string; hint?: string; lock?: boolean }
  | { type: 'fx'; fx: PadFx; power?: number; label?: string; detail?: string }
  | { type: 'score'; line: string }
  /** online: reconnect to room `room` as a remote opened via guest TV `via` ('' = that room's own TV), keeping your seat name and id.
   *  A TV that joins another's room (as a guest) sends it to its phones so they follow it; `host` = the name to greet with */
  | { type: 'move'; room: string; via: string; host?: string };

export interface PadInfo {
  pid: string;
  name: string;
  transport: string;
  /** (the host's roster for its guests only) the seat this phone holds on the host: its player colour and slot */
  color?: string;
  slot?: number;
  /** online: the guest TV this phone was opened from (its QR code's `&via=`), when it isn't a phone of the host's own */
  via?: string;
}

/** another TV watching (and playing, with its own phones) in this room, online */
export interface GuestInfo {
  gid: string;
  name: string;
}

/** a guest TV → the host TV (relayed as ServerToTV 'guest') */
/** (room = this guest TV's own room, so the host can send this TV's phones back there when the guest leaves) */
export type GuestToHost = { type: 'hello'; name: string; room?: string };

/** the host TV → its guest TVs (relayed as ServerToTV 'host'). The match stream's own messages
 *  (src/shared/net.ts) ride in 'net'; its per-frame snapshots go as binary WebSocket frames, forwarded as they are */
export type HostToGuest =
  /** the room's roster (sent by the host's link whenever a phone or guest comes or goes); host = the name to greet it by */
  | { type: 'room'; code: string; pads: PadInfo[]; guests: GuestInfo[]; host?: string }
  | { type: 'net'; msg: unknown }
  /** quick match: the host is done with this pairing (it left after a match, or gave up on the guest's phone) — the guest leaves the room */
  | { type: 'mm-leave' }
  /** quick match: a line for the guest's lobby (e.g. "your phone never joined") */
  | { type: 'mm-note'; text: string };

export type ServerToTV =
  /** joinUrl: what the QR code opens (the http join page, which forwards to padUrl, the remote); caUrl: the iOS profile */
  | { type: 'hello'; joinUrl: string | null; padUrl?: string | null; caUrl: string | null; ips: string[]; dev: boolean; pads: PadInfo[]; room?: string }
  | { type: 'net'; joinUrl: string | null; padUrl?: string | null; caUrl: string | null; ips: string[] }
  | { type: 'pad-join'; pid: string; name: string; transport: string; via?: string }
  | { type: 'pad-leave'; pid: string }
  | { type: 'pad'; pid: string; rt: number; msg: PadMsg }
  /** the TV's own ping came back: t = the TV's send time, st = the server's clock (for the clock offset) */
  | { type: 'pong'; t: number; st: number }
  | { type: 'replaced' }
  /** the cloud: this room code belongs to another TV (pick another) */
  | { type: 'room-taken' }
  // ---- online rooms: guest TVs (the cloud only)
  /** to the host: a guest TV joined / left; a guest's message */
  | { type: 'guest-join'; gid: string; name: string }
  | { type: 'guest-leave'; gid: string }
  | { type: 'guest'; gid: string; msg: GuestToHost }
  /** to a guest: the host's message (binary snapshot frames arrive as ArrayBuffer, not as this) */
  | { type: 'host'; msg: HostToGuest }
  /** to a guest: a phone that joined the room through THIS guest's QR code (`via`) just swung / slashed / bowled / drew — the relay's
   *  copy, sent at once (the host judges it later), so the guest can make the sound now */
  | { type: 'pad-echo'; pid: string; msg: PadMsg }
  /** to a guest: the host left the room / there's no such room */
  | { type: 'host-gone' }
  | { type: 'no-room' };

/** what a TV sends its room (the cloud's relay): to one phone or all, or to its guest TVs (JSON here; a snapshot goes as a binary frame,
 *  forwarded to every guest as it is); a guest TV sends its host any JSON (≤ 4 KB) and pings the relay for its clock */
export type TVToServer =
  | { type: 'to-pad'; pid: string; msg: TVMsg }
  | { type: 'to-guests'; msg: HostToGuest }
  | { type: 'ping'; t: number };

/** quick match (cloud/lobby.ts): what the lobby tells a TV waiting for an opponent. peer.gid is the other TV's guest id: the guest's phones
 *  join the host's room with &via=<that gid>. Both sockets are closed by the lobby after 'matched'. */
export type LobbyMsg =
  | { type: 'waiting'; n: number; t: number }
  | { type: 'matched'; role: 'host'; peer: { gid: string; name: string } }
  | { type: 'matched'; role: 'guest'; code: string; peer: { gid: string; name: string } };

/** what TVLink.onMatchmaking reports: the lobby's messages, plus its own errors and the host's word to a guest */
export type MatchmakingEvent = LobbyMsg | { type: 'mm-error'; reason: string } | { type: 'peer-left' } | { type: 'note'; text: string };

export type ServerToPad =
  | TVMsg
  | { type: 'pong'; t: number; st: number }
  | { type: 'link'; transport: string; st: number }
  | { type: 'bye'; reason: string };

export const PLAYER_COLORS = ['#ff5a6e', '#3aa8ff', '#ffc53d', '#35d49a'];
export const PLAYER_COLOR_NAMES = ['Red', 'Blue', 'Yellow', 'Green'];
