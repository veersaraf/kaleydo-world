// The match stream's codec and playback, headless (npx tsx scripts/net-codec-test.ts):
//   1. random snapshots (every field, every event type) round-trip through encode/decode within the
//      quantisation the layout promises;
//   2. the byte sizes;
//   3. a whole CPU-vs-CPU match streamed by the real NetHost over a jittery virtual network into a real
//      GuestStream: every event arrives, in order; the score ends the same; the guest's ball is where
//      the host's was at the same simulation time; nothing teleports; a 1 s stall recovers;
//   4. what encoding costs the host.
import { Match, type MatchConfig, type MatchEvent } from '../src/tv/tennis/match';
import { AI_LEVELS } from '../src/tv/tennis/ai';
import { Animator } from '../src/tv/chars/anim';
import { NetHost } from '../src/tv/net/host';
import { GuestStream, lerpPose } from '../src/tv/net/guest';
import { newPose } from '../src/tv/chars/pose';
import { Rng } from '../src/tv/core/math';
import {
  EVENT_TYPES, EYE_STATES, FAULT_REASONS, HIT_KINDS, MOUTH_STATES, MOVES, NetWriter, QUANT, REASONS, STATES, STROKES, WHIFF_WHY,
  decodeSnap, encodeSnap, isNetMsg, newSnap, type NetEvent, type NetPose, type NetStart, type Snap,
} from '../src/shared/net';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

// ---------------------------------------------------------------- 1. random round trips
const rng = new Rng(12345);
const R = (a: number, b: number) => rng.range(a, b);
const pick = <T,>(l: readonly T[]) => rng.pick(l);
const vec = (r: number) => ({ x: R(-r, r), y: R(-r, r), z: R(-r, r) });
const unit = () => {
  const v = vec(1);
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
function randPose(): NetPose {
  return {
    x: R(-9, 9), z: R(-16, 16), yaw: R(-0.4, 3.6), hop: R(0, 0.6), body: { x: R(-0.3, 0.3), y: R(0, 0.5), z: 0 },
    bodyPitch: R(-0.4, 0.4), bodyYaw: R(-1, 1), bodyRoll: R(-1.5, 1.5), squash: R(0.8, 1.15), headPitch: R(-0.6, 0.6), headYaw: R(-1, 1), headRoll: R(-0.1, 0.1),
    hands: [vec(1.2), vec(1.2)], racketDir: unit(), racketFace: unit(), feet: [vec(0.6), vec(0.6)], footPitch: [R(-0.4, 0.9), R(-0.4, 0.9)], legLift: R(0, 0.1),
    eyes: pick(EYE_STATES), mouth: pick(MOUTH_STATES), brow: R(-1, 1), blink: rng.chance(0.5) ? 1 : 0, holdingBall: rng.chance(0.3), handed: rng.chance(0.2) ? -1 : 1, tired: R(0, 1),
  };
}
function randEvent(t: number): NetEvent {
  const type = pick(EVENT_TYPES);
  const p = rng.int(0, 3);
  const pos = { x: R(-6, 6), y: R(0, 3), z: R(-14, 14) };
  const mb = <T,>(v: T) => (rng.chance(0.5) ? v : undefined);
  switch (type) {
    case 'hit': return { type, t, p, power: R(0, 1), spin: R(-1, 1), perfect: rng.chance(0.4), kind: pick(HIT_KINDS), stroke: pick(STROKES), pos, kph: R(20, 230), rally: rng.int(0, 40), tau: R(-1.3, 1.3), serve: rng.chance(0.2), dtMs: mb(rng.int(-200, 200)), aim: mb(R(-1, 1)), crossed: mb(true), shotSpin: R(-1, 1), rocket: mb(true), warp: rng.chance(0.5) ? { t0: t - R(0.03, 0.08), tc: t - R(0, 0.03) } : undefined };
    case 'whiff': return { type, t, p, tau: R(-3, 3), dtMs: mb(rng.int(-300, 300)), why: mb(pick(WHIFF_WHY.slice(1))) };
    case 'toss': case 'tired': case 'smash-chance': case 'catch': return { type, t, p };
    case 'athletic': return { type, t, p, move: pick(MOVES) };
    case 'land': return { type, t, p, pos };
    case 'bounce': return { type, t, pos, impact: R(0, 25), live: rng.chance(0.5), out: rng.chance(0.3), first: rng.chance(0.5) };
    case 'net': return { type, t, pos, cord: rng.chance(0.5), over: rng.chance(0.5) };
    case 'let': return { type, t };
    case 'fault': return { type, t, double: rng.chance(0.5), reason: pick(FAULT_REASONS) };
    case 'point': return { type, t, winner: rng.chance(0.5) ? 1 : 0, reason: pick(REASONS), rally: rng.int(0, 60), gameWon: rng.chance(0.3), matchWon: rng.chance(0.1), lastHitter: rng.int(-1, 3), points: [rng.int(0, 5), rng.int(0, 5)], server: rng.chance(0.5) ? 1 : 0 };
    case 'serve-ready': return { type, t, p, second: rng.chance(0.4) };
    case 'state': return { type, t, state: pick(STATES) };
    case 'close-call': return { type, t, pos };
  }
}
function randSnap(n: number, nEvents: number): Snap {
  const s = newSnap();
  s.seq = rng.int(0, 65535);
  s.t = R(0, 900);
  s.wall = rng.int(0, 1e7);
  s.ev = nEvents > 0;
  s.state = rng.int(0, STATES.length - 1);
  s.server = rng.int(0, n - 1);
  s.holder = rng.chance(0.3) ? rng.int(0, n - 1) : -1;
  s.excitement = R(0, 1);
  s.rally = rng.int(0, 60);
  s.pointWinner = rng.int(0, 1);
  s.winner = rng.int(-1, 1);
  s.replay = rng.chance(0.2);
  s.scoreServer = rng.int(0, 1);
  s.serverIdx = [rng.int(0, 1), rng.int(0, 1)];
  s.faults = rng.int(0, 2);
  s.points = [rng.int(0, 9), rng.int(0, 9)];
  s.games = [rng.int(0, 6), rng.int(0, 6)];
  s.second = rng.chance(0.3);
  s.keepScore = rng.chance(0.3);
  s.ballVisible = rng.chance(0.9);
  s.ballLive = rng.chance(0.6);
  s.seg = { t0: R(0, 900), px: R(-6, 6), py: R(0, 4), pz: R(-14, 14), vx: R(-20, 20), vy: R(-15, 15), vz: R(-40, 40), g: R(0, 12), k: R(0, 0.5), spin: R(-1, 1), wob: rng.chance(0.2) ? R(0.05, 0.2) : 0 };
  s.warp = rng.chance(0.3) ? { p: rng.int(0, n - 1), t0: R(0, 900), tc: R(0, 900), cx: R(-5, 5), cy: R(0, 3), cz: R(-12, 12) } : { p: -1, t0: 0, tc: 0, cx: 0, cy: 0, cz: 0 };
  s.cue = rng.chance(0.3) ? { p: rng.int(0, n - 1), t: R(0, 900), bx: R(-5, 5), by: R(2, 4), bz: R(-12, 12), sx: R(-5, 5), sz: R(-12, 12) } : { p: -1, t: 0, bx: 0, by: 0, bz: 0, sx: 0, sz: 0 };
  s.n = n;
  for (let i = 0; i < n; i++) s.poses[i] = randPose();
  s.events = Array.from({ length: nEvents }, () => randEvent(s.t - R(0, 0.05)));
  return s;
}

const bad: string[] = [];
const near = (what: string, a: number, b: number, tol: number) => {
  if (Math.abs(a - b) > tol + 1e-9) bad.push(`${what}: ${a} vs ${b} (tol ${tol})`);
};
const eqv = (what: string, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tol: number) => {
  near(what + '.x', a.x, b.x, tol);
  near(what + '.y', a.y, b.y, tol);
  near(what + '.z', a.z, b.z, tol);
};
function comparePose(w: string, a: NetPose, b: NetPose) {
  near(w + 'x', a.x, b.x, QUANT.pos); near(w + 'z', a.z, b.z, QUANT.pos); near(w + 'yaw', a.yaw, b.yaw, QUANT.angle); near(w + 'hop', a.hop, b.hop, QUANT.pos);
  eqv(w + 'body', a.body, b.body, QUANT.pos);
  for (const k of ['bodyPitch', 'bodyYaw', 'bodyRoll', 'headPitch', 'headYaw', 'headRoll'] as const) near(w + k, a[k], b[k], QUANT.angle);
  near(w + 'squash', a.squash, b.squash, QUANT.squash + 1e-9);
  for (let i = 0; i < 2; i++) { eqv(w + 'hand' + i, a.hands[i], b.hands[i], QUANT.pos); eqv(w + 'foot' + i, a.feet[i], b.feet[i], QUANT.pos); near(w + 'footPitch' + i, a.footPitch[i], b.footPitch[i], QUANT.angle); }
  eqv(w + 'racketDir', a.racketDir, b.racketDir, QUANT.unit); eqv(w + 'racketFace', a.racketFace, b.racketFace, QUANT.unit);
  near(w + 'legLift', a.legLift, b.legLift, QUANT.pos);
  near(w + 'brow', a.brow, b.brow, QUANT.brow); near(w + 'blink', a.blink, b.blink, QUANT.byte); near(w + 'tired', a.tired, b.tired, QUANT.byte);
  if (a.eyes !== b.eyes || a.mouth !== b.mouth || a.holdingBall !== b.holdingBall || a.handed !== b.handed) bad.push(w + ' enums/flags differ');
}
function compareEvent(w: string, a: NetEvent, b: NetEvent) {
  if (a.type !== b.type) return bad.push(w + ' type ' + a.type + ' vs ' + b.type);
  near(w + 't', a.t, b.t, 0.0006);
  const A = a as Record<string, any>, B = b as Record<string, any>;
  for (const k of Object.keys(A)) {
    if (k === 'type' || k === 't') continue;
    const x = A[k], y = B[k];
    if (x === undefined && y === undefined) continue;
    if (typeof x === 'number') {
      const tol = k === 'power' || k === 'spin' || k === 'shotSpin' || k === 'aim' ? 1 / 127 : k === 'kph' ? 0.06 : k === 'impact' ? 0.006 : k === 'tau' ? 0.0006 : k === 'dtMs' ? 0.51 : 0;
      near(w + k, x, y, tol);
    } else if (k === 'pos') eqv(w + 'pos', x, y, QUANT.pos);
    else if (k === 'warp') { if (!y) bad.push(w + 'warp lost'); else { near(w + 'warp.t0', x.t0, y.t0, 0.0016); near(w + 'warp.tc', x.tc, y.tc, 0.0016); } }
    else if (k === 'points') { if (x[0] !== y[0] || x[1] !== y[1]) bad.push(w + 'points'); }
    else if (x !== y && !(x === false && y === undefined) && !(x === undefined && y === false)) bad.push(`${w}${k}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  }
}
{
  const w = new NetWriter();
  const out = newSnap();
  let n = 0;
  for (let i = 0; i < 4000; i++) {
    const s = randSnap(rng.chance(0.5) ? 2 : 4, rng.int(0, 5));
    const len = encodeSnap(w, s);
    const ok = decodeSnap(w.frame(), out);
    if (!ok) { bad.push('decode failed'); continue; }
    n++;
    const hdr: [string, number, number][] = [['seq', s.seq, out.seq], ['wall', s.wall, out.wall], ['state', s.state, out.state], ['server', s.server, out.server], ['holder', s.holder, out.holder], ['rally', s.rally, out.rally], ['pointWinner', s.pointWinner, out.pointWinner], ['winner', s.winner, out.winner], ['scoreServer', s.scoreServer, out.scoreServer], ['faults', s.faults, out.faults], ['points0', s.points[0], out.points[0]], ['points1', s.points[1], out.points[1]], ['games0', s.games[0], out.games[0]], ['games1', s.games[1], out.games[1]], ['n', s.n, out.n], ['sIdx0', s.serverIdx[0], out.serverIdx[0]], ['sIdx1', s.serverIdx[1], out.serverIdx[1]]];
    for (const [k, a, b] of hdr) if (a !== b) bad.push(`header ${k}: ${a} vs ${b}`);
    if (s.t !== out.t) bad.push('t');
    near('excitement', s.excitement, out.excitement, QUANT.byte);
    for (const k of ['ev', 'ballVisible', 'ballLive', 'second', 'keepScore', 'replay'] as const) if (s[k] !== out[k]) bad.push('flag ' + k);
    for (const k of Object.keys(s.seg) as (keyof Snap['seg'])[]) near('seg.' + k, s.seg[k], out.seg[k], k === 'spin' || k === 'wob' ? Math.abs(s.seg[k]) * 1.2e-7 + 1e-9 : 0);
    if (s.warp.p >= 0) for (const k of Object.keys(s.warp) as (keyof Snap['warp'])[]) near('warp.' + k, s.warp[k], out.warp[k], k === 't0' || k === 'tc' || k === 'p' ? 0 : Math.abs(s.warp[k]) * 1.2e-7 + 1e-9);
    else if (out.warp.p !== -1) bad.push('warp p');
    if (s.cue.p >= 0) for (const k of Object.keys(s.cue) as (keyof Snap['cue'])[]) near('cue.' + k, s.cue[k], out.cue[k], Math.abs(s.cue[k]) * 1.2e-7 + 1e-9);
    else if (out.cue.p !== -1) bad.push('cue p');
    for (let p = 0; p < s.n; p++) comparePose(`pose${p}.`, s.poses[p], out.poses[p]);
    if (out.events.length !== s.events.length) bad.push('event count');
    else s.events.forEach((e, j) => compareEvent(`ev${j}(${e.type}).`, e, out.events[j]));
    if (len > 4000) bad.push('too long');
  }
  check(`${n} random snapshots (2 and 4 players, 0-5 events) round-trip within their quantisation`, bad.length === 0, bad.slice(0, 5).join(' | '));
  // garbage is refused, not thrown at
  const junk = new Uint8Array(40).fill(7).buffer;
  check('a foreign or truncated frame is refused', !decodeSnap(junk, out) && !decodeSnap(w.buf.slice(0, 30), out));
  check('isNetMsg tells our JSON from the rest', isNetMsg({ type: 'start' }) && isNetMsg({ type: 'end' }) && !isNetMsg({ type: 'room' }) && !isNetMsg(null));
}

// ---------------------------------------------------------------- 2. sizes
{
  const w = new NetWriter();
  const sizes = [2, 4].map((n) => {
    const s = randSnap(n, 0);
    s.warp.p = -1; s.cue.p = -1; s.seg.wob = 0;
    return encodeSnap(w, s);
  });
  const withHit = randSnap(2, 0);
  withHit.warp.p = -1; withHit.cue.p = -1; withHit.seg.wob = 0;
  withHit.events = [{ type: 'hit', t: withHit.t, p: 0, power: 0.8, spin: 0.2, perfect: true, kind: 'drive', stroke: 'fh', pos: { x: 1, y: 1, z: 2 }, kph: 120, rally: 3, tau: 0.1, serve: false, dtMs: 12, aim: 0.3, shotSpin: 0.2 }, { type: 'state', t: withHit.t, state: 'play' }];
  const hit = encodeSnap(w, withHit);
  console.log(`snapshot bytes: singles ${sizes[0]}, doubles ${sizes[1]}, singles with a hit and a state event ${hit}`);
  check('a singles snapshot is under 400 bytes', sizes[0] < 400 && hit < 400, `${sizes[0]} (${hit} with two events)`);
  check('a doubles snapshot is under 400 bytes', sizes[1] < 400, String(sizes[1]));
}

// ---------------------------------------------------------------- 3. a whole match over a jittery network
interface Net { arrive: number; data: unknown }
function streamMatch(opts: { doubles: boolean; seed: number; stall?: [number, number]; jitter?: number; base?: number; hostMs?: number }) {
  const T0 = 1_700_000_000_000;
  let vnow = 0;
  const clock = { perf: () => vnow, date: () => T0 + vnow };
  const players: MatchConfig['players'] = [];
  const look: any = { height: 1 };
  for (const team of [0, 1] as const) for (let i = 0; i < (opts.doubles ? 2 : 1); i++) players.push({ team, name: `P${team}${i}`, look, handed: i ? -1 : 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[team ? 'ace' : 'pro'] } });
  const cfg: MatchConfig = { doubles: opts.doubles, gamesToWin: 2, players, seed: opts.seed, introTime: 0.6, teamNames: ['Red', 'Blue'], firstServer: 0 };
  const m = new Match(cfg);
  const anims = m.players.map((p) => new Animator(p));
  const queue: Net[] = [];
  let lastArrive = 0;
  const jrng = new Rng(opts.seed * 31 + 7);
  const delay = () => (opts.base ?? 22) + jrng.range(0, opts.jitter ?? 18);
  const toGuests = (data: unknown) => {
    let arrive = Math.max(lastArrive, vnow + delay());
    if (opts.stall && vnow >= opts.stall[0] * 1000 && vnow < opts.stall[1] * 1000) arrive = Math.max(arrive, opts.stall[1] * 1000 + 5);
    lastArrive = arrive;
    queue.push({ arrive, data });
  };
  const app: any = { link: { role: 'host', guests: [{ gid: 'g1', name: 'guest' }], serverOffset: 0, toGuests }, stage: { current: { def: { id: 'plaza' } }, next: null }, input: { seats: [] }, smashCue: null, replay: null };
  const net = new NetHost(app);
  net.clock = clock;
  const hostEvents: string[] = [];
  m.onEvent = (e: MatchEvent) => {
    hostEvents.push(e.type + (e.type === 'state' ? ':' + e.state : ''));
    net.event(e);
  };
  net.begin(m, cfg, 'plaza');

  let guest: GuestStream | null = null;
  const guestEvents: string[] = [];
  let ended: any = null;
  const status: boolean[] = [];
  const hooks = {
    event: (e: MatchEvent) => guestEvents.push(e.type + (e.type === 'state' ? ':' + e.state : '')),
    world: () => {}, hud: () => {}, end: (e: unknown) => (ended = e), status: (r: boolean) => status.push(r), replay: () => {}, clockOffset: () => 0,
  };
  const hostLog: { t: number; x: number; y: number; z: number; holder: boolean }[] = [];
  let cmp = 0;
  let maxErr = 0;
  let sumErr = 0;
  let jumps = 0;
  let maxStep = 0;
  let prevBall: { x: number; y: number; z: number } | null = null;
  let prevHolder = false;
  let frames = 0;
  const renderList: number[] = [];
  const encodeMs: number[] = [];
  const cueAt: number[] = [];
  const ballTmp = { x: 0, y: 0, z: 0 };
  const dtF = 1000 / 60;
  const ball = { x: 0, y: 0, z: 0 };
  let startedAt = -1;
  const hostMs = opts.hostMs ?? dtF;
  let nextHost = 0;
  let missedWarps = 0;
  let engagedWarps = 0;
  const seenWarp = new Set<number>();
  for (let k = 0; k < 60 * 60 * 8; k++) {
    vnow = k * dtF;
    // ---- the host's frame (a slow host has fewer of them)
    if (vnow >= nextHost - 1e-6) {
      nextHost += hostMs;
      const simDt = hostMs / 1000;
      const n = Math.max(1, Math.ceil(simDt * 120 - 1e-6));
      if (m.state !== 'over') for (let i = 0; i < n; i++) m.step(simDt / n);
      m.ballView(m.t, ball);
      // (a smash chance being staged for a moment, as App.stageSmash does from Match.smashChance)
      app.smashCue = m.t > 20 && m.t < 20.4 && m.state === 'play' ? { p: m.players[0], plan: { t: m.t + 0.5, bx: 1, by: 2.2, bz: 3, sx: 1.5, sz: 4 } } : null;
      const poses = anims.map((a) => a.update(m.t, simDt, ball, m.state));
      const t0 = performance.now();
      net.frame(poses);
      encodeMs.push(performance.now() - t0);
      hostLog.push({ t: m.t, x: ball.x, y: ball.y, z: ball.z, holder: !!m.ball.holder });
      if (hostLog.length > 400) hostLog.shift();
    }
    // ---- the network
    const gnow = vnow + 5;
    while (queue.length && queue[0].arrive <= gnow) {
      const d = queue.shift()!.data as any;
      if (d instanceof ArrayBuffer) guest?.push(d);
      else if (d.type === 'net' && isNetMsg(d.msg)) {
        if (d.msg.type === 'start') {
          if (!guest) {
            guest = new GuestStream(d.msg as NetStart, hooks);
            guest.clock = { perf: () => vnow + 5, date: () => T0 + vnow + 5 };
            startedAt = k;
          }
        } else guest?.control(d.msg);
      }
    }
    // ---- the guest's frame
    if (guest && guest.ready) {
      guest.advance(1 / 60);
      frames++;
      if (guest.match.smashChance(guest.match.players[0])) cueAt.push(guest.tR);
      // a hit whose racket magnet no snapshot caught (the host frame was longer than the swing): the hit event's own copy draws the ball to the racket
      for (const w of (guest as any).hitWarps as { p: number; t0: number; tc: number; cx: number; cy: number; cz: number }[]) {
        if (seenWarp.has(w.tc) || w.tc > guest.tR - 0.05) continue;
        seenWarp.add(w.tc);
        const ring = (guest as any).ring as Snap[];
        if (ring.some((q) => q.serial > 0 && q.warp.p >= 0 && Math.abs(q.warp.t0 - w.t0) < 0.002)) continue;
        missedWarps++;
        const saved = (guest as any).hitWarps;
        const tm = (w.t0 + w.tc) / 2 + 0.002;
        const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
        (guest as any).hitWarps = [];
        const ok1 = guest.ballAtSimTime(tm, a);
        (guest as any).hitWarps = saved;
        const ok2 = guest.ballAtSimTime(tm, b);
        if (ok1 && ok2 && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 0.002) engagedWarps++;
      }
      const g = guest;
      const gm = g.match;
      gm.ballView(gm.t, ballTmp);
      const hold = !!gm.ball.holder;
      // the ball doesn't teleport (holding it, then tossing it, is a change of owner, not a jump)
      if (prevBall && !hold && !prevHolder && gm.state !== 'intro') {
        const step = Math.hypot(ballTmp.x - prevBall.x, ballTmp.y - prevBall.y, ballTmp.z - prevBall.z);
        maxStep = Math.max(maxStep, step);
        if (step > 1.4) jumps++;
      }
      prevBall = { x: ballTmp.x, y: ballTmp.y, z: ballTmp.z };
      const drawn = prevBall;
      prevHolder = hold;
      // exact: the guest's ball at the simulation time of each host frame it has passed, against what the host drew then
      for (let i = hostLog.length - 1; i >= 0; i--) {
        const f = hostLog[i] as typeof hostLog[number] & { done?: boolean };
        if (f.done) break;
        if (f.t <= g.tR - 0.1) {
          f.done = true;
          if (f.holder) continue;
          if (g.ballAtSimTime(f.t, ballTmp)) {
            const e = Math.hypot(ballTmp.x - f.x, ballTmp.y - f.y, ballTmp.z - f.z);
            maxErr = Math.max(maxErr, e);
            sumErr += e;
            cmp++;
          }
        }
      }
      // what is drawn: against the host's log, linearly in between (a rough check: kinks at bounces are the host's frames' own)
      for (let i = hostLog.length - 2; i >= 0; i--) {
        const a = hostLog[i], b = hostLog[i + 1];
        if (a.t <= gm.t && gm.t <= b.t && b.t - a.t > 1e-6 && !a.holder && !b.holder && !hold) {
          const u = (gm.t - a.t) / (b.t - a.t);
          const e = Math.hypot(drawn.x - (a.x + (b.x - a.x) * u), drawn.y - (a.y + (b.y - a.y) * u), drawn.z - (a.z + (b.z - a.z) * u));
          renderList.push(e);
          break;
        }
      }
    }
    if (m.state === 'over' && ended && queue.length === 0) break;
  }
  // drain: keep the guest running a couple of seconds after the last snapshot
  for (let k = 0; k < 180 && guest; k++) {
    vnow += dtF;
    while (queue.length && queue[0].arrive <= vnow + 5) {
      const d = queue.shift()!.data as any;
      if (d instanceof ArrayBuffer) guest.push(d);
      else if (d.type === 'net' && isNetMsg(d.msg)) guest.control(d.msg);
    }
    guest.advance(1 / 60);
  }
  void startedAt;
  renderList.sort((a, b) => a - b);
  return { m, guest: guest as GuestStream | null, hostEvents, guestEvents, ended, status, maxErr, meanErr: sumErr / Math.max(1, cmp), cmp, jumps, maxStep, frames, encodeMs, net, renderList, cueAt, missedWarps, engagedWarps };
}

for (const doubles of [false, true]) {
  const r = streamMatch({ doubles, seed: doubles ? 9 : 3 });
  const g = r.guest!;
  const label = doubles ? 'doubles' : 'singles';
  check(`${label}: the guest saw the match through to its end`, !!r.ended && r.ended.winner === r.m.score.winner, r.ended ? `winner ${r.ended.winner}, games ${r.ended.games}` : 'no end');
  check(`${label}: the same events, in the same order (${r.hostEvents.length})`, r.hostEvents.join() === r.guestEvents.join(), r.hostEvents.join() === r.guestEvents.join() ? '' : `host ${r.hostEvents.length} guest ${r.guestEvents.length}`);
  const gs = g.match.score;
  check(`${label}: the shadow's score ends where the host's did`, gs.games[0] === r.m.score.games[0] && gs.games[1] === r.m.score.games[1] && g.match.state === r.m.state, `${gs.games} vs ${r.m.score.games}, ${g.match.state}`);
  check(`${label}: the guest's ball is where the host's was, at the same simulation time (${r.cmp} host frames)`, r.maxErr < 0.02 && r.cmp > 1000, `max ${(r.maxErr * 1000).toFixed(2)} mm... ${(r.maxErr * 100).toFixed(3)} cm, mean ${(r.meanErr * 1000).toFixed(3)} mm`);
  check(`${label}: no teleports on screen`, r.jumps === 0, `largest step ${r.maxStep.toFixed(2)} m per frame`);
  const st = g.stats;
  console.log(`   one-way p50 ${st.oneWay.p50} / p90 ${st.oneWay.p90} / max ${st.oneWay.max} ms, buffer ${st.buffer.toFixed(0)} ms, interval ${st.snapshotInterval} ms, render lag ${st.renderLag.toFixed(0)} ms, dropped ${st.dropped}, late events ${st.lateEvents}, resyncs ${st.resyncs}, snapshots ${st.snapshots}`);
  if (!doubles) check('singles: a staged smash chance reaches the guest\'s shadow match (Match.smashChance) for about as long as it lasted', r.cueAt.length > 10 && r.cueAt[0] >= 19.9 && r.cueAt[r.cueAt.length - 1] <= 20.7, `${r.cueAt.length} frames, ${r.cueAt[0]?.toFixed(2)}–${r.cueAt[r.cueAt.length - 1]?.toFixed(2)}`);
  check(`${label}: nothing dropped, no late events`, st.dropped === 0 && st.lateEvents === 0, `dropped ${st.dropped}, late ${st.lateEvents}`);
  check(`${label}: it never reported "reconnecting"`, !r.status.includes(true));
  const em = r.encodeMs.filter((x) => x > 0).sort((a, b) => a - b);
  const bytesPer = r.net.stats.bytes / Math.max(1, r.net.stats.snapshots);
  console.log(`   host: ${r.net.stats.snapshots} snapshots, ${bytesPer.toFixed(0)} bytes each on average; frame() with a snapshot p50 ${(em[em.length >> 1] * 1000).toFixed(0)} µs, p99 ${(em[Math.floor(em.length * 0.99)] * 1000).toFixed(0)} µs, max ${(em[em.length - 1] * 1000).toFixed(0)} µs (the encoder alone averages ${(r.net.stats.encodeMsAvg * 1000).toFixed(0)} µs)`);
  check(`${label}: encoding under 0.2 ms`, em[Math.floor(em.length * 0.99)] < 0.2, `p99 ${(em[Math.floor(em.length * 0.99)] * 1000).toFixed(0)} µs`);
  const rl = r.renderList;
  console.log(`   drawn ball vs the host's log (linear between its frames: rough at bounces and hits; ${rl.length} frames): p50 ${(rl[rl.length >> 1] * 100).toFixed(2)} cm, p95 ${(rl[Math.floor(rl.length * 0.95)] * 100).toFixed(2)} cm`);
}

// ---- a slow host (22 fps: some racket magnets last less than a frame and no snapshot sees them)
{
  const r = streamMatch({ doubles: false, seed: 11, hostMs: 45 });
  const g = r.guest!;
  check('slow host: the same events, in the same order', r.hostEvents.join() === r.guestEvents.join() && !!r.ended, `${r.hostEvents.length} events`);
  check('slow host: the ball is where the host\'s was at each of its frames', r.maxErr < 0.02 && r.cmp > 500, `${(r.maxErr * 100).toFixed(3)} cm over ${r.cmp} frames`);
  check('slow host: racket magnets no snapshot saw are still drawn, from the hit event', r.missedWarps > 3 && r.engagedWarps >= r.missedWarps * 0.85, `${r.engagedWarps} of ${r.missedWarps}`);
  check('slow host: the ball never jumped', r.jumps === 0, `largest step ${r.maxStep.toFixed(2)} m per frame`);
  void g;
}

// ---- a stall in the middle of a match: 1 s is ridden out quietly; 2.5 s says "reconnecting…" and recovers
for (const [len, says] of [[1, false], [2.5, true]] as const) {
  const r = streamMatch({ doubles: false, seed: 5, stall: [12, 12 + len] });
  const g = r.guest!;
  check(`${len} s stall: ${says ? 'it said "reconnecting" and then that it was back' : 'no "reconnecting" (under 1.5 s)'}`, says ? r.status[0] === true && r.status[r.status.length - 1] === false : !r.status.includes(true), JSON.stringify(r.status));
  check(`${len} s stall: the same events, in the same order`, r.hostEvents.join() === r.guestEvents.join(), `${r.hostEvents.length} vs ${r.guestEvents.length}`);
  check(`${len} s stall: the ball never jumped`, r.jumps === 0, `largest step ${r.maxStep.toFixed(2)} m per frame`);
  check(`${len} s stall: the ball is still where the host had it`, r.maxErr < 0.02, `${(r.maxErr * 100).toFixed(3)} cm`);
  console.log(`   after the ${len} s stall: buffer ${g.stats.buffer.toFixed(0)} ms, resyncs ${g.stats.resyncs}, late events ${g.stats.lateEvents}`);
}

// ---------------------------------------------------------------- 4. pose interpolation
{
  const a = randPose(), b = randPose();
  const o = newPose();
  lerpPose(o, a, b, 0.5);
  const mid = (x: number, y: number) => (x + y) / 2;
  check('a pose halfway is the average; directions stay unit; enums take the nearer', Math.abs(o.x - mid(a.x, b.x)) < 1e-9 && Math.abs(Math.hypot(o.racketDir.x, o.racketDir.y, o.racketDir.z) - 1) < 1e-9 && o.eyes === b.eyes);
  lerpPose(o, a, b, 0.49);
  check('…and the nearer one below the middle', o.eyes === a.eyes && o.handed === a.handed);
}

console.log(fail ? `\n${fail} checks FAILED` : '\nAll net codec checks passed.');
process.exitCode = fail ? 1 : 0;
