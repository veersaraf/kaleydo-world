// KALEIDO in the cloud (Cloudflare Workers + a Durable Object per room).
//
// The same job server/server.mjs's hub does on a Mac, for anyone with a browser:
// it serves the built game (dist/), and it relays between one TV and its phones.
// A TV makes up a room code; its QR code opens /c?room=CODE on the phone, and
// both open a WebSocket to /ws?room=CODE, which lands in that room's Durable
// Object. Phones' messages go to the TV stamped with the relay time (as the local
// server does, for the swing-latency maths); the TV's go to one phone or all.
// A room belongs to the first TV that claims it (a random key it keeps), so a
// guessed code can't take over someone's game.
//
// Online play adds a third role: a GUEST TV (a friend's laptop, anywhere) joins a
// room by its code. The host TV stays the only simulation; the guest's own phones
// open the same /c?room=CODE and join the host directly as ordinary pads. The relay
// tells the host who joined, forwards the host's messages to every guest (JSON as
// {type:'host', msg}; a BINARY frame — the match snapshot, ~30 Hz — as it is, untouched)
// and a guest's JSON to the host as {type:'guest', gid, msg}.
//
// A phone opened from a GUEST's QR code carries &via=<gid>: it still plays on the host (its
// messages go to the host as any pad's), but the relay remembers which guest it belongs to. The
// host's roster tells its guests (PadInfo.via) so each can find its own players, and the relay
// echoes the phone's swing / slash / bowl / draw to that guest as {type:'pad-echo', pid, msg} the
// moment it arrives — the guest's TV can make the swing's sound at once, before the match stream
// (which has to go to the host, be judged, and come back) shows anything.
//
// The rooms sleep when nothing is said (WebSocket Hibernation: see the Room class), so an idle TV bills nothing.

import { Lobby } from './lobby';
export { Lobby };

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  /** local development only (`wrangler dev --var DEV:1`): the rooms count what they receive, served at /api/room-stats */
  DEV?: string;
  /** with DEV: '1', every handler rebuilds the room from storage and the sockets' attachments, as after a hibernation (see Room.ready) */
  HIBERNATE_DEBUG?: string;
}

const ROOM_RE = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/ws') {
      const room = (url.searchParams.get('room') || '').toUpperCase();
      if (!ROOM_RE.test(room)) return new Response('bad room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
    }
    // Quick match: the lobby (one Durable Object) pairs TVs that are looking for an opponent (cloud/lobby.ts)
    if (p === '/mm' || p === '/mm/stats') {
      if (p === '/mm' && req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      // (where the TV is, as Cloudflare's edge sees it: never the client's word)
      const to = new URL(req.url);
      to.searchParams.delete('cont');
      const cont = (req as Request & { cf?: { continent?: string } }).cf?.continent;
      if (cont) to.searchParams.set('cont', cont);
      return env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(new Request(to, req));
    }
    // (development only: what a room has received, to prove an idle room is silent; see Room.count)
    if (p === '/api/room-stats' && env.DEV === '1') {
      const room = (url.searchParams.get('room') || '').toUpperCase();
      if (!ROOM_RE.test(room)) return new Response('bad room', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
    }
    // the game knows it's in the cloud (no local server: rooms instead)
    if (p === '/api/info') return Response.json({ cloud: true });
    // the remote's short addresses
    if (p === '/c' || p === '/c/' || p === '/pad') {
      // (the assets serve controller.html at its clean address)
      const to = new URL('/controller', url);
      to.search = url.search;
      return env.ASSETS.fetch(new Request(to, req));
    }
    return env.ASSETS.fetch(req);
  },
};


// ---------------------------------------------------------------------------------------------
// The room: a Durable Object on the WebSocket HIBERNATION API.
//
// A classic WebSocket keeps its object resident, and a resident object bills 128 MB x wall seconds: a TV parked
// on the home screen would cost most of the free plan's daily budget by itself. Here the sockets belong to the
// runtime (`ctx.acceptWebSocket`), and the object is only woken when a message arrives; after ~10 s of silence
// it is evicted, its sockets stay open, and nothing is billed. What survives a sleep:
//   * per socket, in its ATTACHMENT (serializeAttachment): role, pid/gid, name, via, join order
//   * per room, in storage: the TV's key (who owns the room), the room code, the origin (for the QR link)
// and everything else (`tv`, `pads`, `guests`) is a VIEW rebuilt from those by ready(), which every handler
// calls first (a boolean test once the object is awake).
//
// What wakes it: any message a socket sends — except the exact text `ka`, which the runtime answers itself
// (setWebSocketAutoResponse) without waking anything. The clients send `ka` every 40 s while idle, and the
// timed `{type:'ping', t}` (the one that needs `st`, the relay's clock) only while something is going on
// (src/pad/link.ts, src/tv/core/link.ts). Nothing here sets a timer: a pending setTimeout would pin the object.

const KEEPALIVE = 'ka';
/** an abandoned room's storage is dropped this long after its last socket goes */
const ROOM_TTL_MS = 24 * 3600 * 1000;

interface Pad {
  pid: string;
  name: string;
  ws: WebSocket;
  /** the guest TV whose QR code this phone came from ('' = the host's own) */
  via: string;
  /** join order (the roster keeps it across a sleep) */
  at: number;
}

/** what a phone does that its guest TV plays a sound for at once (not 'ori', which streams at 30 Hz) */
const ECHOED = new Set(['swing', 'slash', 'bowl', 'draw']);

interface Guest {
  gid: string;
  name: string;
  ws: WebSocket;
  at: number;
}

/** a socket's attachment ('gone': replaced or rejected, whatever it does now is nobody's business) */
type Att = { role: 'tv' } | { role: 'pad'; id: string; name: string; via: string; at: number } | { role: 'guest'; id: string; name: string; at: number } | { role: 'gone' };

/** a guest's message to the host stays small (its hello) */
const GUEST_MAX = 4096;
/** guests per room (the snapshot goes to each of them) */
const GUESTS_MAX = 8;

const cleanName = (s: string | null) =>
  String(s || '')
    .replace(/[^\p{L}\p{N} _.'-]/gu, '')
    .trim()
    .slice(0, 12) || 'Player';
const cleanPid = (s: string | null) => {
  const v = String(s || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  return v.length >= 6 ? v : null;
};

const attOf = (ws: WebSocket): Att | null => {
  try {
    return (ws.deserializeAttachment() as Att | null) ?? null;
  } catch {
    return null;
  }
};
const setAtt = (ws: WebSocket, a: Att) => {
  try {
    ws.serializeAttachment(a);
  } catch {}
};
const padAtt = (p: Pad): Att => ({ role: 'pad', id: p.pid, name: p.name, via: p.via, at: p.at });
const guestAtt = (g: Guest): Att => ({ role: 'guest', id: g.gid, name: g.name, at: g.at });

export class Room {
  private loaded = false;
  private tv: WebSocket | null = null;
  private tvKey: string | null = null;
  private pads = new Map<string, Pad>();
  /** the guest TVs (a plain array: the snapshot broadcast walks it 30 times a second and allocates nothing) */
  private guests: Guest[] = [];
  /** socket -> its pad or guest (a phone's message finds its entry without touching the attachment) */
  private who = new WeakMap<WebSocket, Pad | Guest>();
  private room = '';
  private origin = '';
  private readonly dev: boolean;
  private readonly debug: boolean;

  constructor(
    private ctx: DurableObjectState,
    env: Env,
  ) {
    this.dev = env.DEV === '1';
    this.debug = this.dev && env.HIBERNATE_DEBUG === '1';
    // the keepalive: answered by the runtime, the object stays asleep
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE, KEEPALIVE));
    if (this.dev) this.bump('dbg:wakes');
  }

  /**
   * Bring the in-memory views up to date with what survives a sleep: storage and the sockets' attachments. Called first
   * by every handler; once the object is awake it costs one boolean test. (With HIBERNATE_DEBUG it rebuilds on EVERY call:
   * the object then works with no memory between two events, as it must after an eviction.)
   */
  private ready() {
    if (this.loaded && !this.debug) return;
    const kv = this.ctx.storage.kv;
    this.tvKey = kv.get<string>('tvKey') ?? null;
    this.room = kv.get<string>('room') ?? '';
    this.origin = kv.get<string>('origin') ?? '';
    this.tv = null;
    this.who = new WeakMap();
    const pads: Pad[] = [];
    const guests: Guest[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = attOf(ws);
      if (!a) continue;
      if (a.role === 'tv') this.tv = ws;
      else if (a.role === 'pad') pads.push({ pid: a.id, name: a.name, ws, via: a.via, at: a.at });
      else if (a.role === 'guest') guests.push({ gid: a.id, name: a.name, ws, at: a.at });
    }
    pads.sort((x, y) => x.at - y.at);
    guests.sort((x, y) => x.at - y.at);
    this.pads = new Map(pads.map((p) => [p.pid, p]));
    for (const p of pads) this.who.set(p.ws, p);
    for (const g of guests) this.who.set(g.ws, g);
    this.guests = guests;
    this.loaded = true;
  }

  // ---- development counters (DEV only): what the room has been sent, kept in storage so a sleep doesn't reset them
  private bump(key: string) {
    const kv = this.ctx.storage.kv;
    kv.put(key, (kv.get<number>(key) ?? 0) + 1);
  }

  private count(message: string | ArrayBuffer) {
    this.bump('dbg:msgs');
    if (typeof message !== 'string') return this.bump('dbg:t:binary');
    let t = '?';
    const m = /"type":"([a-z-]+)"/.exec(message.length > 200 ? message.slice(0, 200) : message);
    if (m) t = m[1];
    this.bump('dbg:t:' + t);
  }

  private stats() {
    const kv = this.ctx.storage.kv;
    const types: Record<string, number> = {};
    for (const [k, v] of kv.list<number>({ prefix: 'dbg:t:' })) types[k.slice(6)] = v;
    let tvs = 0,
      pads = 0,
      guests = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = attOf(ws);
      if (a?.role === 'tv') tvs++;
      else if (a?.role === 'pad') pads++;
      else if (a?.role === 'guest') guests++;
    }
    return { msgs: kv.get<number>('dbg:msgs') ?? 0, wakes: kv.get<number>('dbg:wakes') ?? 0, types, sockets: { tv: tvs, pad: pads, guest: guests }, debug: this.debug };
  }

  async fetch(req: Request): Promise<Response> {
    this.ready();
    const url = new URL(req.url);
    if (url.pathname === '/api/room-stats') return this.dev ? Response.json(this.stats()) : new Response('not found', { status: 404 });
    const room = (url.searchParams.get('room') || '').toUpperCase();
    if (room && room !== this.room) {
      this.room = room;
      this.ctx.storage.kv.put('room', room);
    }
    const role = url.searchParams.get('role');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (role === 'tv') this.attachTV(server, url);
    else if (role === 'pad') this.attachPad(server, url);
    else if (role === 'guest') this.attachGuest(server, url);
    else this.reject(server, 1008, 'role');
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket | null, obj: unknown) {
    try {
      ws?.send(JSON.stringify(obj));
    } catch {}
  }

  private trySend(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      ws.send(data);
    } catch {}
  }

  private padList() {
    return [...this.pads.values()].map((p) => (p.via ? { pid: p.pid, name: p.name, transport: 'ws', via: p.via } : { pid: p.pid, name: p.name, transport: 'ws' }));
  }

  /** a socket turned away at the door: an ordinary short-lived socket (a close from inside fetch() doesn't reach the client of a hibernatable one), never part of the room */
  private reject(ws: WebSocket, code: number, reason: string, say?: unknown) {
    ws.accept();
    if (say) this.send(ws, say);
    ws.close(code, reason);
  }

  /** a socket that's no longer part of the room (replaced, rejected): its attachment says so, whatever it does or is closed with */
  private retire(ws: WebSocket, code?: number, reason?: string) {
    setAtt(ws, { role: 'gone' });
    try {
      ws.close(code, reason);
    } catch {}
  }

  private attachTV(ws: WebSocket, url: URL) {
    const key = url.searchParams.get('key') || '';
    if (!key || key.length < 8) return this.reject(ws, 1008, 'key');
    // the room is someone else's
    if (this.tvKey && this.tvKey !== key) return this.reject(ws, 1008, 'taken', { type: 'room-taken' });
    this.ctx.acceptWebSocket(ws, ['tv']);
    const kv = this.ctx.storage.kv;
    if (this.tvKey !== key) {
      this.tvKey = key;
      kv.put('tvKey', key);
    }
    if (this.origin !== url.origin) {
      this.origin = url.origin;
      kv.put('origin', this.origin);
    }
    const old = this.tv;
    if (old && old !== ws) {
      this.send(old, { type: 'replaced' });
      this.retire(old);
    }
    this.tv = ws;
    setAtt(ws, { role: 'tv' });
    const padUrl = `${this.origin}/c?room=${this.room}`;
    this.send(ws, { type: 'hello', joinUrl: padUrl, padUrl, caUrl: null, ips: [], dev: false, pads: this.padList(), room: this.room });
    // guests that were here before the TV (re)connected: tell it who's waiting
    for (const g of this.guests) this.send(ws, { type: 'guest-join', gid: g.gid, name: g.name });
  }

  private attachGuest(ws: WebSocket, url: URL) {
    const gid = cleanPid(url.searchParams.get('gid'));
    if (!gid) return this.reject(ws, 1008, 'gid');
    // "the room exists" = a TV has claimed it (its key stays set while it reconnects)
    if (!this.tvKey) return this.reject(ws, 1000, 'no-room', { type: 'no-room' });
    const prev = this.guests.findIndex((g) => g.gid === gid);
    if (prev < 0 && this.guests.length >= GUESTS_MAX) return this.reject(ws, 1013, 'full');
    this.ctx.acceptWebSocket(ws, ['guest', `guest:${gid}`]);
    const guest: Guest = { gid, name: cleanName(url.searchParams.get('name')), ws, at: Date.now() };
    this.who.set(ws, guest);
    if (prev >= 0) {
      // a reload: this one replaces the old (which leaves quietly), keeping its place in the order
      const old = this.guests[prev];
      guest.at = old.at;
      setAtt(ws, guestAtt(guest));
      this.guests[prev] = guest;
      this.retire(old.ws);
    } else {
      setAtt(ws, guestAtt(guest));
      this.guests.push(guest);
    }
    if (this.tv) this.send(this.tv, { type: 'guest-join', gid, name: guest.name });
    else this.send(ws, { type: 'host-gone' });
  }

  private attachPad(ws: WebSocket, url: URL) {
    const pid = cleanPid(url.searchParams.get('pid'));
    if (!pid) return this.reject(ws, 1008, 'pid');
    this.ctx.acceptWebSocket(ws, ['pad', `pad:${pid}`]);
    const prev = this.pads.get(pid);
    if (prev && prev.ws !== ws) {
      this.send(prev.ws, { type: 'bye', reason: 'replaced' });
      this.retire(prev.ws);
    }
    const pad: Pad = { pid, name: cleanName(url.searchParams.get('name')), ws, via: cleanPid(url.searchParams.get('via')) ?? '', at: Date.now() };
    setAtt(ws, padAtt(pad));
    this.pads.set(pid, pad);
    this.who.set(ws, pad);
    this.send(this.tv, pad.via ? { type: 'pad-join', pid, name: pad.name, transport: 'ws', via: pad.via } : { type: 'pad-join', pid, name: pad.name, transport: 'ws' });
    this.send(ws, { type: 'link', transport: 'ws', st: Date.now() });
  }

  // ---------------------------------------------------------------- what the sockets say

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    this.ready();
    if (this.dev) this.count(data);
    // the match snapshot, the hot path (30 Hz): a binary frame from the TV goes to every guest as it is (no parsing, no copy, no storage)
    if (ws === this.tv) {
      if (typeof data !== 'string') {
        const gs = this.guests;
        for (let i = 0; i < gs.length; i++) {
          try {
            gs[i].ws.send(data);
          } catch {}
        }
      } else this.fromTV(ws, data);
      return;
    }
    const e = this.who.get(ws);
    if (e) {
      if ('pid' in e) this.fromPad(e, data);
      else this.fromGuest(e, data);
      return;
    }
    // (a socket the views don't know by object: by what it carries)
    const a = attOf(ws);
    if (a?.role === 'tv') {
      if (typeof data === 'string') this.fromTV(ws, data);
      else for (const g of this.guests) this.trySend(g.ws, data);
    } else if (a?.role === 'pad') {
      const p = this.pads.get(a.id);
      if (p) this.fromPad(p, data);
    } else if (a?.role === 'guest') {
      const g = this.guests.find((q) => q.gid === a.id);
      if (g) this.fromGuest(g, data);
    }
  }

  private fromTV(ws: WebSocket, data: string) {
    let m: { type?: string; pid?: string; msg?: unknown; t?: number } | null = null;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    // the TV's clock check: our clock, stamped as the ping is read
    if (m?.type === 'ping') {
      this.send(ws, { type: 'pong', t: m.t, st: Date.now() });
      return;
    }
    if (m?.type === 'to-guests') {
      if (this.guests.length) {
        const out = JSON.stringify({ type: 'host', msg: m.msg });
        for (const g of this.guests) this.trySend(g.ws, out);
      }
      return;
    }
    if (m?.type !== 'to-pad') return;
    if (m.pid === '*') for (const p of this.pads.values()) this.send(p.ws, m.msg);
    else if (m.pid) this.send(this.pads.get(m.pid)?.ws ?? null, m.msg);
  }

  private fromGuest(g: Guest, data: string | ArrayBuffer) {
    if (typeof data !== 'string' || data.length > GUEST_MAX) return;
    let msg: { type?: string; t?: number } | null = null;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') {
      this.send(g.ws, { type: 'pong', t: msg.t, st: Date.now() });
      return;
    }
    this.send(this.tv, { type: 'guest', gid: g.gid, msg });
  }

  private fromPad(pad: Pad, data: string | ArrayBuffer) {
    let msg: { type?: string; t?: number; name?: string } | null = null;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') {
      this.send(pad.ws, { type: 'pong', t: msg.t, st: Date.now() });
      return;
    }
    if (msg.type === 'hello' && typeof msg.name === 'string') {
      const name = cleanName(msg.name);
      if (name !== pad.name) {
        pad.name = name;
        setAtt(pad.ws, padAtt(pad));
      }
    }
    this.send(this.tv, { type: 'pad', pid: pad.pid, rt: Date.now(), msg });
    // (a phone that came from a guest's QR code: that guest hears its swing at once)
    if (pad.via && ECHOED.has(msg.type)) {
      const g = this.guests.find((q) => q.gid === pad.via);
      if (g) this.send(g.ws, { type: 'pad-echo', pid: pad.pid, msg });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.ready();
    this.gone(ws);
    // (answers the close handshake; a no-op when the runtime has already)
    try {
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code);
    } catch {}
  }

  async webSocketError(ws: WebSocket) {
    this.ready();
    this.gone(ws);
  }

  /** a socket is gone (closed or failed): whoever it was, its side hears of it. A retired one (replaced, rejected) says nothing. */
  private gone(ws: WebSocket) {
    const a = attOf(ws);
    if (!a || a.role === 'gone') return this.sweep();
    setAtt(ws, { role: 'gone' });
    if (a.role === 'tv') {
      this.tv = null;
      // the guests stay (the TV may be back in seconds and will hear of them again)
      const out = JSON.stringify({ type: 'host-gone' });
      for (const g of this.guests) this.trySend(g.ws, out);
    } else if (a.role === 'guest') {
      const i = this.guests.findIndex((g) => g.gid === a.id);
      if (i >= 0) this.guests.splice(i, 1);
      this.send(this.tv, { type: 'guest-leave', gid: a.id });
    } else {
      this.pads.delete(a.id);
      this.send(this.tv, { type: 'pad-leave', pid: a.id });
    }
    this.sweep();
  }

  /** when the last socket has gone, the room's storage is dropped a day later (if nobody has come back: alarm()) */
  private sweep() {
    if (this.debug) return;
    for (const ws of this.ctx.getWebSockets()) if (attOf(ws)?.role !== 'gone') return;
    void this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) if (attOf(ws)?.role !== 'gone') return;
    await this.ctx.storage.deleteAll();
    this.loaded = false;
  }
}
