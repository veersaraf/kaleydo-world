// The online match stream, shared by the host TV (which simulates) and the guest TVs
// (which render what the host streams). No three.js here: types and a codec.
//
// Two kinds of message, both relayed by the room (src/shared/protocol.ts HostToGuest):
//   - JSON control messages, {type:'net', msg: NetMsg}: `start` (everything needed to
//     build the same match), `end`, `world` (a Kaleido shift) and `hud` (a caption).
//   - Binary SNAPSHOT frames (~30 Hz, and on every match event), forwarded as they are.
//
// A snapshot is a whole picture of the match at one instant, so a lost or late one costs
// nothing but a little smoothness: the score, the state, the ball's flight (the segment it
// is on: the guest evaluates its position exactly at any time, as the host does), each
// player's pose, and the events since the last one. Little-endian throughout.
//
//   0  u8   version
//   1  u8   flags   b0 event-driven   b1 ball visible   b2 ball live   b3 segment has a wobble
//                   b4 a racket-magnet warp follows   b5 a smash cue follows   b6 second serve
//                   b7 the point is replayed (a fault or a let: the score is kept)
//   2  u16  seq
//   4  f64  t            simulation time, s (f64: the guest orders things by it, exactly as the host does)
//   12 u32  wall         host wall clock since the match started, ms (server-corrected)
//   16 u8   state        STATES
//   17 u8   b0-3 server (player index, 15 none)   b4-7 holder (the player holding the ball, 15 none)
//   18 u8   excitement   ×255
//   19 u8   rally
//   20 u8   b0 point winner   b1-2 match winner + 1 (0 none)   b3 the host is watching a replay
//   21 u8   b0 serving team   b1 serverIdx[0]   b2 serverIdx[1]   b3-4 faults
//   22 u8   points[0]   23 u8 points[1]   24 u8 games[0]   25 u8 games[1]
//   26 u8   b0-2 players   b3-7 events
//   27 ...  ball segment: t0 px py pz vx vy vz g k (9 × f64: the guest must evaluate exactly what the host does,
//           even where a comparison sits on an edge, like a ball rolling at exactly its own radius), spin f32 [+ wob f32]
//           [warp: u8 player, f64 t0 tc, f32 cx cy cz]  (b4: a hit being lined up: the ball is drawn to the racket)
//           [cue: u8 player, f32 t bx by bz sx sz]     (b5: a smash chance being staged)
//           players × 74 bytes (see wPose), then the events (see wEvent)
//
// Two players: 251 bytes without events; four: 399.

export const NET_VERSION = 1;

export const STATES = ['intro', 'serve', 'toss', 'play', 'dead', 'reset', 'over'] as const;
export const EYE_STATES = ['open', 'happy', 'closed', 'focus', 'sad', 'wide'] as const;
export const MOUTH_STATES = ['smile', 'open', 'flat', 'frown', 'grin', 'o'] as const;
export const HIT_KINDS = ['drive', 'lob', 'drop', 'smash', 'volley', 'soft', 'shank', 'wobbly', 'error'] as const;
export const STROKES = ['fh', 'bh', 'oh', 'serve'] as const;
export const REASONS = ['ace', 'winner', 'out', 'net', 'double', 'unreturned', 'wide', 'long'] as const;
export const WHIFF_WHY = ['', 'early', 'late', 'reach', 'noball'] as const;
export const MOVES = ['lunge', 'dive', 'jump'] as const;
export const FAULT_REASONS = ['net', 'out'] as const;
export const EVENT_TYPES = ['hit', 'whiff', 'toss', 'athletic', 'land', 'tired', 'smash-chance', 'catch', 'bounce', 'net', 'let', 'fault', 'point', 'serve-ready', 'state', 'close-call'] as const;

const idx = (list: readonly string[], v: string | undefined) => {
  const i = v === undefined ? -1 : list.indexOf(v);
  return i < 0 ? 0 : i;
};
const pick = <T extends string>(list: readonly T[], i: number): T => list[i] ?? list[0];

// ---------------------------------------------------------------- control messages (JSON)

export interface NetPlayerSpec {
  team: 0 | 1;
  name: string;
  /** the character's Look (plain JSON) */
  look: Record<string, unknown>;
  handed: 1 | -1;
  /** a person's (their phone is on the host) or the CPU's */
  human: boolean;
  slot: number;
}

export interface NetTeam {
  name: string;
  color: string;
}

/** host → guests: a match is starting (or you have just joined one that is running) */
export interface NetStart {
  type: 'start';
  v: number;
  /** this match's id (the host's clock at its start): a repeated `start` for the same id is ignored */
  id: number;
  sport: 'tennis';
  world: string;
  /** the host's server-corrected clock, ms, when the match started: snapshots' `wall` counts from it */
  hostT0: number;
  doubles: boolean;
  gamesToWin: number;
  firstServer: 0 | 1;
  seed: number;
  timingScale?: number;
  introTime?: number;
  teamNames: [string, string];
  teams: [NetTeam, NetTeam];
  /** the ball's halo colours, per team */
  halo: [string, string];
  kaleido: boolean;
  players: NetPlayerSpec[];
}

/** host → guests: the match is over (or was abandoned: winner −1) */
export interface NetEnd {
  type: 'end';
  id: number;
  /** simulation time and host wall clock (ms since the match started) when it ended */
  t: number;
  wall: number;
  winner: -1 | 0 | 1;
  games: [number, number];
  teamNames: [string, string];
}

/** host → guests: the world changed (a Kaleido shift) */
export interface NetWorld {
  type: 'world';
  id: number;
  wall: number;
  world: string;
  transition: boolean;
  /** where the world shatters from, on the HOST's screen (0..1, y down) */
  origin?: { x: number; y: number };
  /** …and the same spot in the court (the shot that shattered it): a guest looking from the other end projects it with its own camera */
  at?: { x: number; y: number; z: number };
}

/** host → guests: a caption for the HUD that isn't derivable from a match event */
export interface NetHud {
  type: 'hud';
  id: number;
  wall: number;
  text: string;
  sub?: string;
  cls?: string;
}

export type NetMsg = NetStart | NetEnd | NetWorld | NetHud;

export function isNetMsg(m: unknown): m is NetMsg {
  const t = (m as { type?: unknown } | null)?.type;
  return t === 'start' || t === 'end' || t === 'world' || t === 'hud';
}

// ---------------------------------------------------------------- snapshot contents

export interface NetVec {
  x: number;
  y: number;
  z: number;
}

/** src/tv/chars/pose.ts's Pose, with its enums as plain strings (a Pose is one) */
export interface NetPose {
  x: number;
  z: number;
  yaw: number;
  hop: number;
  body: NetVec;
  bodyPitch: number;
  bodyYaw: number;
  bodyRoll: number;
  squash: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  hands: [NetVec, NetVec];
  racketDir: NetVec;
  racketFace: NetVec;
  feet: [NetVec, NetVec];
  footPitch: [number, number];
  legLift: number;
  eyes: string;
  mouth: string;
  brow: number;
  blink: number;
  holdingBall: boolean;
  handed: 1 | -1;
  tired: number;
}

/** src/tv/tennis/ball.ts's Seg (wob 0 = none) */
export interface NetSeg {
  t0: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  g: number;
  k: number;
  spin: number;
  wob: number;
}

export type NetEventBody =
  /** warp: the swing that made it — the ball was drawn to the racket from t0 to tc (a snapshot in between may have missed it) */
  | { type: 'hit'; p: number; power: number; spin: number; perfect: boolean; kind: string; stroke: string; pos: NetVec; kph: number; rally: number; tau: number; serve: boolean; dtMs?: number; aim?: number; crossed?: boolean; shotSpin: number; rocket?: boolean; warp?: { t0: number; tc: number } }
  | { type: 'whiff'; p: number; tau: number; dtMs?: number; why?: string }
  | { type: 'athletic'; p: number; move: string }
  | { type: 'land'; p: number; pos: NetVec }
  | { type: 'toss' | 'tired' | 'smash-chance' | 'catch'; p: number }
  | { type: 'bounce'; pos: NetVec; impact: number; live: boolean; out: boolean; first: boolean }
  | { type: 'net'; pos: NetVec; cord: boolean; over: boolean }
  | { type: 'let' }
  | { type: 'fault'; double: boolean; reason: string }
  /** points/server: the score as the point was awarded (the guest words the call from them) */
  | { type: 'point'; winner: 0 | 1; reason: string; rally: number; gameWon: boolean; matchWon: boolean; lastHitter: number; points: [number, number]; server: 0 | 1 }
  | { type: 'serve-ready'; p: number; second: boolean }
  | { type: 'state'; state: string }
  | { type: 'close-call'; pos: NetVec };

/** a match event with players as indexes; `t` is its simulation time */
export type NetEvent = NetEventBody & { t: number };

export interface Snap {
  seq: number;
  t: number;
  wall: number;
  /** sent because of an event (not on the regular tick) */
  ev: boolean;
  state: number;
  server: number;
  holder: number;
  excitement: number;
  rally: number;
  pointWinner: number;
  /** −1 nobody yet */
  winner: number;
  replay: boolean;
  scoreServer: number;
  serverIdx: [number, number];
  faults: number;
  points: [number, number];
  games: [number, number];
  second: boolean;
  keepScore: boolean;
  ballVisible: boolean;
  ballLive: boolean;
  seg: NetSeg;
  /** the racket "magnet" before contact: player −1 = none */
  warp: { p: number; t0: number; tc: number; cx: number; cy: number; cz: number };
  /** a smash chance being staged: player −1 = none */
  cue: { p: number; t: number; bx: number; by: number; bz: number; sx: number; sz: number };
  /** players in use */
  n: number;
  poses: NetPose[];
  events: NetEvent[];
  /** guest side: when it arrived (performance.now, ms) and its order of arrival */
  arrived: number;
  serial: number;
}

const V = (): NetVec => ({ x: 0, y: 0, z: 0 });

export function newNetPose(): NetPose {
  return {
    x: 0,
    z: 0,
    yaw: 0,
    hop: 0,
    body: V(),
    bodyPitch: 0,
    bodyYaw: 0,
    bodyRoll: 0,
    squash: 1,
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    hands: [V(), V()],
    racketDir: { x: 0, y: 1, z: 0 },
    racketFace: { x: 0, y: 0, z: -1 },
    feet: [V(), V()],
    footPitch: [0, 0],
    legLift: 0,
    eyes: 'open',
    mouth: 'smile',
    brow: 0,
    blink: 0,
    holdingBall: false,
    handed: 1,
    tired: 0,
  };
}

export const MAX_PLAYERS = 4;

export function newSnap(): Snap {
  return {
    seq: 0,
    t: 0,
    wall: 0,
    ev: false,
    state: 0,
    server: 0,
    holder: -1,
    excitement: 0,
    rally: 0,
    pointWinner: 0,
    winner: -1,
    replay: false,
    scoreServer: 0,
    serverIdx: [0, 0],
    faults: 0,
    points: [0, 0],
    games: [0, 0],
    second: false,
    keepScore: false,
    ballVisible: true,
    ballLive: false,
    seg: { t0: 0, px: 0, py: 1, pz: 0, vx: 0, vy: 0, vz: 0, g: 0, k: 0, spin: 0, wob: 0 },
    warp: { p: -1, t0: 0, tc: 0, cx: 0, cy: 0, cz: 0 },
    cue: { p: -1, t: 0, bx: 0, by: 0, bz: 0, sx: 0, sz: 0 },
    n: 0,
    poses: Array.from({ length: MAX_PLAYERS }, newNetPose),
    events: [],
    arrived: 0,
    serial: 0,
  };
}

// ---------------------------------------------------------------- quantisation

const clampI16 = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const clampU8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
/** metres → mm (±32.7 m) */
const MM = 1000;
/** radians → 1/4000 (±8.19 rad; a unit vector's component: /32767 instead) */
const ANG = 4000;
const TAU_Q = 2000;

/** the largest error each field can carry, for the tests: mm, angle steps, unit-vector steps… */
export const QUANT = { pos: 0.5 / MM, angle: 0.5 / ANG, unit: 0.5 / 32767, byte: 0.5 / 255, squash: 0.5 / 255, brow: 0.5 / 127 };

// ---------------------------------------------------------------- writer / reader

/** A byte buffer with a cursor. One per encoder, reused for every frame. */
export class NetWriter {
  readonly buf = new ArrayBuffer(4096);
  readonly dv = new DataView(this.buf);
  o = 0;
  u8(v: number) {
    this.dv.setUint8(this.o++, v);
  }
  i8(v: number) {
    this.dv.setInt8(this.o++, v);
  }
  u16(v: number) {
    this.dv.setUint16(this.o, v, true);
    this.o += 2;
  }
  i16(v: number) {
    this.dv.setInt16(this.o, v, true);
    this.o += 2;
  }
  u32(v: number) {
    this.dv.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }
  f32(v: number) {
    this.dv.setFloat32(this.o, v, true);
    this.o += 4;
  }
  f64(v: number) {
    this.dv.setFloat64(this.o, v, true);
    this.o += 8;
  }
  /** the frame just written, as its own ArrayBuffer (a send may queue it, so the working buffer isn't handed out) */
  frame(): ArrayBuffer {
    return this.buf.slice(0, this.o);
  }
}

class NetReader {
  o = 0;
  readonly dv: DataView;
  constructor(
    b: ArrayBuffer,
    readonly len: number,
  ) {
    this.dv = new DataView(b);
  }
  u8() {
    return this.dv.getUint8(this.o++);
  }
  i8() {
    return this.dv.getInt8(this.o++);
  }
  u16() {
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  i16() {
    const v = this.dv.getInt16(this.o, true);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  f32() {
    const v = this.dv.getFloat32(this.o, true);
    this.o += 4;
    return v;
  }
  f64() {
    const v = this.dv.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }
}

const wMM = (w: NetWriter, v: number) => w.i16(clampI16(Math.round(v * MM)));
const rMM = (r: NetReader) => r.i16() / MM;
const wAng = (w: NetWriter, v: number) => w.i16(clampI16(Math.round(v * ANG)));
const rAng = (r: NetReader) => r.i16() / ANG;
const wUnit = (w: NetWriter, v: NetVec) => {
  w.i16(clampI16(Math.round(v.x * 32767)));
  w.i16(clampI16(Math.round(v.y * 32767)));
  w.i16(clampI16(Math.round(v.z * 32767)));
};
const rUnit = (r: NetReader, o: NetVec) => {
  o.x = r.i16() / 32767;
  o.y = r.i16() / 32767;
  o.z = r.i16() / 32767;
};
const wVecMM = (w: NetWriter, v: NetVec) => {
  wMM(w, v.x);
  wMM(w, v.y);
  wMM(w, v.z);
};
const rVecMM = (r: NetReader, o: NetVec) => {
  o.x = rMM(r);
  o.y = rMM(r);
  o.z = rMM(r);
};
const wU8 = (w: NetWriter, v: number, scale: number) => w.u8(clampU8(Math.round(v * scale)));

// ---------------------------------------------------------------- a pose: 74 bytes

function wPose(w: NetWriter, p: NetPose) {
  wMM(w, p.x);
  wMM(w, p.z);
  wAng(w, p.yaw);
  wMM(w, p.hop);
  wVecMM(w, p.body);
  wAng(w, p.bodyPitch);
  wAng(w, p.bodyYaw);
  wAng(w, p.bodyRoll);
  w.u8(clampU8(Math.round((p.squash - 0.5) * 255)));
  wAng(w, p.headPitch);
  wAng(w, p.headYaw);
  wAng(w, p.headRoll);
  wVecMM(w, p.hands[0]);
  wVecMM(w, p.hands[1]);
  wUnit(w, p.racketDir);
  wUnit(w, p.racketFace);
  wVecMM(w, p.feet[0]);
  wVecMM(w, p.feet[1]);
  wAng(w, p.footPitch[0]);
  wAng(w, p.footPitch[1]);
  wMM(w, p.legLift);
  w.u8(idx(EYE_STATES, p.eyes) | (idx(MOUTH_STATES, p.mouth) << 4));
  w.i8(Math.max(-127, Math.min(127, Math.round(p.brow * 127))));
  wU8(w, p.blink, 255);
  w.u8((p.holdingBall ? 1 : 0) | (p.handed < 0 ? 2 : 0));
  wU8(w, p.tired, 255);
}

function rPose(r: NetReader, p: NetPose) {
  p.x = rMM(r);
  p.z = rMM(r);
  p.yaw = rAng(r);
  p.hop = rMM(r);
  rVecMM(r, p.body);
  p.bodyPitch = rAng(r);
  p.bodyYaw = rAng(r);
  p.bodyRoll = rAng(r);
  p.squash = r.u8() / 255 + 0.5;
  p.headPitch = rAng(r);
  p.headYaw = rAng(r);
  p.headRoll = rAng(r);
  rVecMM(r, p.hands[0]);
  rVecMM(r, p.hands[1]);
  rUnit(r, p.racketDir);
  rUnit(r, p.racketFace);
  rVecMM(r, p.feet[0]);
  rVecMM(r, p.feet[1]);
  p.footPitch[0] = rAng(r);
  p.footPitch[1] = rAng(r);
  p.legLift = rMM(r);
  const face = r.u8();
  p.eyes = pick(EYE_STATES, face & 15);
  p.mouth = pick(MOUTH_STATES, face >> 4);
  p.brow = r.i8() / 127;
  p.blink = r.u8() / 255;
  const fl = r.u8();
  p.holdingBall = !!(fl & 1);
  p.handed = fl & 2 ? -1 : 1;
  p.tired = r.u8() / 255;
}

// ---------------------------------------------------------------- events

const pl = (i: number) => (i < 0 ? 255 : i);
const rpl = (v: number) => (v === 255 ? -1 : v);

function wEvent(w: NetWriter, e: NetEvent, snapT: number) {
  w.u8(idx(EVENT_TYPES, e.type));
  w.u16(Math.max(0, Math.min(65535, Math.round((snapT - e.t) * 1000))));
  switch (e.type) {
    case 'hit': {
      w.u8(pl(e.p));
      w.u8((e.perfect ? 1 : 0) | (e.serve ? 2 : 0) | (e.rocket ? 4 : 0) | (e.crossed ? 8 : 0) | (e.aim !== undefined ? 16 : 0) | (e.dtMs !== undefined ? 32 : 0) | (e.warp ? 64 : 0));
      w.u8(idx(HIT_KINDS, e.kind));
      w.u8(idx(STROKES, e.stroke));
      wU8(w, e.power, 255);
      w.i8(Math.max(-127, Math.min(127, Math.round(e.spin * 127))));
      w.i8(Math.max(-127, Math.min(127, Math.round(e.shotSpin * 127))));
      wVecMM(w, e.pos);
      w.u16(Math.max(0, Math.min(65535, Math.round(e.kph * 10))));
      w.u8(Math.min(255, e.rally));
      w.i16(clampI16(Math.round(e.tau * TAU_Q)));
      if (e.dtMs !== undefined) w.i16(clampI16(Math.round(e.dtMs)));
      if (e.aim !== undefined) w.i8(Math.max(-127, Math.min(127, Math.round(e.aim * 127))));
      if (e.warp) {
        w.u8(clampU8(Math.round((e.t - e.warp.t0) * 1000)));
        w.u8(clampU8(Math.round((e.t - e.warp.tc) * 1000)));
      }
      break;
    }
    case 'whiff':
      w.u8(pl(e.p));
      w.u8(idx(WHIFF_WHY, e.why) | (e.dtMs !== undefined ? 16 : 0));
      w.i16(clampI16(Math.round(e.tau * TAU_Q)));
      if (e.dtMs !== undefined) w.i16(clampI16(Math.round(e.dtMs)));
      break;
    case 'toss':
    case 'tired':
    case 'smash-chance':
    case 'catch':
      w.u8(pl(e.p));
      break;
    case 'athletic':
      w.u8(pl(e.p));
      w.u8(idx(MOVES, e.move));
      break;
    case 'land':
      w.u8(pl(e.p));
      wVecMM(w, e.pos);
      break;
    case 'bounce':
      wVecMM(w, e.pos);
      w.u16(Math.max(0, Math.min(65535, Math.round(e.impact * 100))));
      w.u8((e.live ? 1 : 0) | (e.out ? 2 : 0) | (e.first ? 4 : 0));
      break;
    case 'net':
      wVecMM(w, e.pos);
      w.u8((e.cord ? 1 : 0) | (e.over ? 2 : 0));
      break;
    case 'close-call':
      wVecMM(w, e.pos);
      break;
    case 'let':
      break;
    case 'fault':
      w.u8((e.double ? 1 : 0) | (idx(FAULT_REASONS, e.reason) << 1));
      break;
    case 'point':
      w.u8(e.winner | (e.gameWon ? 2 : 0) | (e.matchWon ? 4 : 0) | (e.server << 3));
      w.u8(idx(REASONS, e.reason));
      w.u8(Math.min(255, e.rally));
      w.u8(pl(e.lastHitter));
      w.u8(Math.min(255, e.points[0]));
      w.u8(Math.min(255, e.points[1]));
      break;
    case 'serve-ready':
      w.u8(pl(e.p) | (e.second ? 128 : 0));
      break;
    case 'state':
      w.u8(idx(STATES, e.state));
      break;
  }
}

function rEvent(r: NetReader, snapT: number): NetEvent {
  const type = pick(EVENT_TYPES, r.u8());
  const t = snapT - r.u16() / 1000;
  const pos = (): NetVec => ({ x: rMM(r), y: rMM(r), z: rMM(r) });
  switch (type) {
    case 'hit': {
      const p = rpl(r.u8());
      const fl = r.u8();
      const kind = pick(HIT_KINDS, r.u8());
      const stroke = pick(STROKES, r.u8());
      const power = r.u8() / 255;
      const spin = r.i8() / 127;
      const shotSpin = r.i8() / 127;
      const at = pos();
      const kph = r.u16() / 10;
      const rally = r.u8();
      const tau = r.i16() / TAU_Q;
      const e: NetEvent = { type, t, p, power, spin, perfect: !!(fl & 1), kind, stroke, pos: at, kph, rally, tau, serve: !!(fl & 2), shotSpin };
      if (fl & 4) e.rocket = true;
      if (fl & 8) e.crossed = true;
      if (fl & 32) e.dtMs = r.i16();
      if (fl & 16) e.aim = r.i8() / 127;
      if (fl & 64) {
        const a = r.u8() / 1000;
        const c = r.u8() / 1000;
        e.warp = { t0: t - a, tc: t - c };
      }
      return e;
    }
    case 'whiff': {
      const p = rpl(r.u8());
      const b = r.u8();
      const tau = r.i16() / TAU_Q;
      const e: NetEvent = { type, t, p, tau };
      if (b & 15) e.why = pick(WHIFF_WHY, b & 15);
      if (b & 16) e.dtMs = r.i16();
      return e;
    }
    case 'toss':
    case 'tired':
    case 'smash-chance':
    case 'catch':
      return { type, t, p: rpl(r.u8()) };
    case 'athletic':
      return { type, t, p: rpl(r.u8()), move: pick(MOVES, r.u8()) };
    case 'land': {
      const p = rpl(r.u8());
      return { type, t, p, pos: pos() };
    }
    case 'bounce': {
      const at = pos();
      const impact = r.u16() / 100;
      const fl = r.u8();
      return { type, t, pos: at, impact, live: !!(fl & 1), out: !!(fl & 2), first: !!(fl & 4) };
    }
    case 'net': {
      const at = pos();
      const fl = r.u8();
      return { type, t, pos: at, cord: !!(fl & 1), over: !!(fl & 2) };
    }
    case 'close-call':
      return { type, t, pos: pos() };
    case 'let':
      return { type, t };
    case 'fault': {
      const fl = r.u8();
      return { type, t, double: !!(fl & 1), reason: pick(FAULT_REASONS, fl >> 1) };
    }
    case 'point': {
      const fl = r.u8();
      const reason = pick(REASONS, r.u8());
      const rally = r.u8();
      const lastHitter = rpl(r.u8());
      const points: [number, number] = [r.u8(), r.u8()];
      return { type, t, winner: (fl & 1) as 0 | 1, reason, rally, gameWon: !!(fl & 2), matchWon: !!(fl & 4), lastHitter, points, server: ((fl >> 3) & 1) as 0 | 1 };
    }
    case 'serve-ready': {
      const b = r.u8();
      return { type, t, p: rpl(b & 127), second: !!(b & 128) };
    }
    case 'state':
      return { type, t, state: pick(STATES, r.u8()) };
  }
}

// ---------------------------------------------------------------- a snapshot

/** Write `s` into `w` (which is reset first); returns its length. */
export function encodeSnap(w: NetWriter, s: Snap): number {
  w.o = 0;
  const wob = s.seg.wob !== 0;
  const warp = s.warp.p >= 0;
  const cue = s.cue.p >= 0;
  w.u8(NET_VERSION);
  w.u8((s.ev ? 1 : 0) | (s.ballVisible ? 2 : 0) | (s.ballLive ? 4 : 0) | (wob ? 8 : 0) | (warp ? 16 : 0) | (cue ? 32 : 0) | (s.second ? 64 : 0) | (s.keepScore ? 128 : 0));
  w.u16(s.seq & 0xffff);
  w.f64(s.t);
  w.u32(s.wall);
  w.u8(s.state);
  w.u8((s.server < 0 ? 15 : s.server) | ((s.holder < 0 ? 15 : s.holder) << 4));
  wU8(w, s.excitement, 255);
  w.u8(Math.min(255, s.rally));
  w.u8((s.pointWinner & 1) | ((s.winner + 1) << 1) | (s.replay ? 8 : 0));
  w.u8((s.scoreServer & 1) | (s.serverIdx[0] << 1) | (s.serverIdx[1] << 2) | (Math.min(3, s.faults) << 3));
  w.u8(Math.min(255, s.points[0]));
  w.u8(Math.min(255, s.points[1]));
  w.u8(Math.min(255, s.games[0]));
  w.u8(Math.min(255, s.games[1]));
  const ne = Math.min(31, s.events.length);
  w.u8(s.n | (ne << 3));
  const g = s.seg;
  w.f64(g.t0);
  w.f64(g.px);
  w.f64(g.py);
  w.f64(g.pz);
  w.f64(g.vx);
  w.f64(g.vy);
  w.f64(g.vz);
  w.f64(g.g);
  w.f64(g.k);
  w.f32(g.spin);
  if (wob) w.f32(g.wob);
  if (warp) {
    const k = s.warp;
    w.u8(k.p);
    w.f64(k.t0);
    w.f64(k.tc);
    w.f32(k.cx);
    w.f32(k.cy);
    w.f32(k.cz);
  }
  if (cue) {
    const c = s.cue;
    w.u8(c.p);
    w.f32(c.t);
    w.f32(c.bx);
    w.f32(c.by);
    w.f32(c.bz);
    w.f32(c.sx);
    w.f32(c.sz);
  }
  for (let i = 0; i < s.n; i++) wPose(w, s.poses[i]);
  for (let i = 0; i < ne; i++) wEvent(w, s.events[i], s.t);
  return w.o;
}

/** Read a frame into `s`. False if it isn't one of ours (or is cut short). */
export function decodeSnap(b: ArrayBuffer, s: Snap): boolean {
  if (b.byteLength < 27) return false;
  const r = new NetReader(b, b.byteLength);
  try {
    if (r.u8() !== NET_VERSION) return false;
    const fl = r.u8();
    s.ev = !!(fl & 1);
    s.ballVisible = !!(fl & 2);
    s.ballLive = !!(fl & 4);
    s.second = !!(fl & 64);
    s.keepScore = !!(fl & 128);
    s.seq = r.u16();
    s.t = r.f64();
    s.wall = r.u32();
    s.state = r.u8();
    const sh = r.u8();
    s.server = (sh & 15) === 15 ? -1 : sh & 15;
    s.holder = sh >> 4 === 15 ? -1 : sh >> 4;
    s.excitement = r.u8() / 255;
    s.rally = r.u8();
    const pw = r.u8();
    s.pointWinner = pw & 1;
    s.winner = ((pw >> 1) & 3) - 1;
    s.replay = !!(pw & 8);
    const sc = r.u8();
    s.scoreServer = sc & 1;
    s.serverIdx[0] = (sc >> 1) & 1;
    s.serverIdx[1] = (sc >> 2) & 1;
    s.faults = (sc >> 3) & 3;
    s.points[0] = r.u8();
    s.points[1] = r.u8();
    s.games[0] = r.u8();
    s.games[1] = r.u8();
    const nn = r.u8();
    s.n = nn & 7;
    const ne = nn >> 3;
    if (s.n > MAX_PLAYERS) return false;
    const g = s.seg;
    g.t0 = r.f64();
    g.px = r.f64();
    g.py = r.f64();
    g.pz = r.f64();
    g.vx = r.f64();
    g.vy = r.f64();
    g.vz = r.f64();
    g.g = r.f64();
    g.k = r.f64();
    g.spin = r.f32();
    g.wob = fl & 8 ? r.f32() : 0;
    const k = s.warp;
    if (fl & 16) {
      k.p = r.u8();
      k.t0 = r.f64();
      k.tc = r.f64();
      k.cx = r.f32();
      k.cy = r.f32();
      k.cz = r.f32();
    } else k.p = -1;
    const c = s.cue;
    if (fl & 32) {
      c.p = r.u8();
      c.t = r.f32();
      c.bx = r.f32();
      c.by = r.f32();
      c.bz = r.f32();
      c.sx = r.f32();
      c.sz = r.f32();
    } else c.p = -1;
    for (let i = 0; i < s.n; i++) rPose(r, s.poses[i]);
    s.events.length = 0;
    for (let i = 0; i < ne; i++) s.events.push(rEvent(r, s.t));
    return true;
  } catch {
    return false;
  }
}
