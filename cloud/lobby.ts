// KALEIDO's matchmaking lobby (a single Durable Object, `env.LOBBY.idFromName('lobby')`).
//
// A TV that wants "Quick match" opens a WebSocket /mm?room=CODE&key=KEY&gid=GID&name=NAME&players=N
// (the Worker adds &cont=<continent>). It keeps the room it already has; the lobby keeps a queue of
// the TVs waiting and, on each arrival and every 5 s, pairs them with pickPair(). The TV that has
// waited longer HOSTS (its room exists, and lives near it); the other one is told to join that room.
//
//   lobby → TV, while it waits (every 5 s):  { type:'waiting', n: <TVs in the queue>, t: <seconds this TV has waited> }
//   lobby → the host:   { type:'matched', role:'host',  peer:{ gid, name } }
//   lobby → the guest:  { type:'matched', role:'guest', code:<the host's room>, peer:{ gid, name } }
//   both sockets are closed after the match message; a socket closing removes its TV from the queue.
//
// The lobby never sends a host anywhere: only the 'guest' side is given a room code to join.
// GET /mm/stats → { queue: n } (how many TVs are waiting).
//
// On the WebSocket HIBERNATION API: the queue lives in storage (one small row per TV, keyed by gid) and in each socket's
// attachment (the same row), so the object can sleep between events; a waiting TV costs nothing while nothing happens.
// It is woken by an arrival, a departure, and an ALARM — set only while the queue is non-empty, for the next moment
// something can change by itself: the earliest FAR_AFTER_MS a waiting TV reaches (then anyone will do), or, failing that,
// the slow heartbeat below. Every change of the queue's size is told to the waiting TVs at once (the TV's screen only
// shows `n`), so there is no 5 s tick any more (a 5 s beat is shorter than the ~10 s the runtime waits before it evicts
// an idle object: it would never sleep).

export const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_RE = new RegExp(`^[${ROOM_CHARS}]{5}$`);

/** a TV waits this long for someone on its own continent before anyone will do */
export const FAR_AFTER_MS = 20_000;
/** at the longest, waiting TVs are told how the queue stands this often (and nothing else wakes the object while it waits) */
export const HEARTBEAT_MS = 30_000;
/** waiting TVs at most (a queue this long is a flood, not a crowd) */
export const QUEUE_MAX = 500;

export interface Waiter {
  /** when it joined the queue, ms */
  since: number;
  /** 'NA', 'EU'… ; undefined when the edge doesn't say (a local dev server): those all count as the same place */
  continent?: string;
}

/**
 * Who plays whom. The longest-waiting TV (the earliest to arrive) is paired with the earliest-arrived other TV
 * on its continent; when it has none — and after it has waited FAR_AFTER_MS — with the earliest-arrived other TV
 * of all. If the longest-waiting TV can't be paired yet, the next one is tried (two Europeans behind a lonely
 * North American still get to play). The earlier-arrived of the pair hosts. Pure: `queue` is not changed.
 */
export function pickPair<T extends Waiter>(queue: readonly T[], now: number): { host: T; guest: T } | null {
  const order = queue.map((w, i) => ({ w, i })).sort((a, b) => a.w.since - b.w.since || a.i - b.i);
  for (const { w: a } of order) {
    // (the earliest-arrived other TV that matches: the first in order)
    let other = order.find((o) => o.w !== a && o.w.continent === a.continent)?.w;
    if (!other && now - a.since >= FAR_AFTER_MS) other = order.find((o) => o.w !== a)?.w;
    if (!other) continue;
    // (a TV that has waited for FAR_AFTER_MS while the other just arrived: the older still hosts)
    const [host, guest] = a.since <= other.since ? [a, other] : [other, a];
    return { host, guest };
  }
  return null;
}

const cleanName = (s: string | null) =>
  String(s || '')
    .replace(/[^\p{L}\p{N} _.'-]/gu, '')
    .trim()
    .slice(0, 12) || 'TV';
const cleanGid = (s: string | null) => {
  const v = String(s || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  return v.length >= 6 ? v : null;
};


/** what a queued TV is, as stored (a row in storage, and the attachment of its socket) */
interface Row extends Waiter {
  room: string;
  key: string;
  gid: string;
  name: string;
  players: number;
}

interface Entry extends Row {
  ws: WebSocket;
}

type Att = Row | { gone: true };

const rowKey = (gid: string) => 'q:' + gid;

const attOf = (ws: WebSocket): Att | null => {
  try {
    return (ws.deserializeAttachment() as Att | null) ?? null;
  } catch {
    return null;
  }
};

export class Lobby {
  private queue: Entry[] = [];
  private loaded = false;
  /** development: every handler rebuilds the queue from storage and the attachments, as after a hibernation (see Room.ready) */
  private readonly debug: boolean;

  constructor(
    private ctx: DurableObjectState,
    env: { DEV?: string; HIBERNATE_DEBUG?: string },
  ) {
    this.debug = env.DEV === '1' && env.HIBERNATE_DEBUG === '1';
    // (as in the room: the exact text `ka` is answered by the runtime, without waking the object)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ka', 'ka'));
  }

  /** the queue, as it stands in the sockets' attachments (earliest arrival first); storage rows nobody holds a socket for are dropped */
  private ready() {
    if (this.loaded && !this.debug) return;
    const q: Entry[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = attOf(ws);
      if (a && !('gone' in a)) q.push({ ...a, ws });
    }
    q.sort((a, b) => a.since - b.since);
    this.queue = q;
    const kv = this.ctx.storage.kv;
    const held = new Set(q.map((e) => rowKey(e.gid)));
    for (const [k] of kv.list({ prefix: 'q:' })) if (!held.has(k)) kv.delete(k);
    for (const e of q) if (kv.get(rowKey(e.gid)) === undefined) kv.put(rowKey(e.gid), rowOf(e));
    this.loaded = true;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mm/stats') {
      let n = 0;
      for (const _ of this.ctx.storage.kv.list({ prefix: 'q:' })) n++;
      return Response.json({ queue: n });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    this.ready();
    const room = (url.searchParams.get('room') || '').toUpperCase();
    const key = url.searchParams.get('key') || '';
    const gid = cleanGid(url.searchParams.get('gid'));
    if (!ROOM_RE.test(room) || key.length < 8 || key.length > 64 || !gid) return new Response('bad request', { status: 400 });
    if (this.queue.length >= QUEUE_MAX) return new Response('busy', { status: 503 });
    const cont = (url.searchParams.get('cont') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || undefined;
    const players = Math.max(0, Math.min(4, parseInt(url.searchParams.get('players') || '0', 10) || 0));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ['mm', `gid:${gid}`]);
    const e: Entry = { ws: server, room, key, gid, name: cleanName(url.searchParams.get('name')), players, continent: cont, since: Date.now() };
    server.serializeAttachment(rowOf(e));
    await this.add(e);
    return new Response(null, { status: 101, webSocket: client });
  }

  // (nothing a TV says means anything to the lobby)
  async webSocketMessage() {}

  async webSocketClose(ws: WebSocket, code: number) {
    this.ready();
    await this.left(ws);
    try {
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code);
    } catch {}
  }

  async webSocketError(ws: WebSocket) {
    this.ready();
    await this.left(ws);
  }

  /** a TV's socket closed or failed: it leaves the queue (unless it already had: matched, replaced) */
  private async left(ws: WebSocket) {
    const a = attOf(ws);
    if (!a || 'gone' in a) return;
    const e = this.queue.find((q) => q.gid === a.gid);
    if (!e) return;
    this.drop(e);
    this.tell();
    await this.rearm();
  }

  private send(ws: WebSocket, obj: unknown) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  private async add(e: Entry) {
    // the same TV again (a reconnect, a second press): the new socket replaces the old
    for (const old of this.queue.filter((q) => q.gid !== e.gid && q.room === e.room)) this.drop(old, true);
    const same = this.queue.find((q) => q.gid === e.gid);
    if (same) this.drop(same, true);
    this.queue.push(e);
    this.ctx.storage.kv.put(rowKey(e.gid), rowOf(e));
    this.send(e.ws, { type: 'waiting', n: this.queue.length, t: 0 });
    this.pairUp();
    // (the others: how the queue stands now)
    this.tell(e);
    await this.rearm();
  }

  /** `e` leaves the queue; its socket is closed if `close` (a replaced one), and marked so its own close event changes nothing */
  private drop(e: Entry, close = false) {
    const i = this.queue.indexOf(e);
    if (i >= 0) this.queue.splice(i, 1);
    const kv = this.ctx.storage.kv;
    // (a replacement has already written its row under the same gid: leave that)
    if (!this.queue.some((q) => q.gid === e.gid)) kv.delete(rowKey(e.gid));
    try {
      e.ws.serializeAttachment({ gone: true } satisfies Att);
    } catch {}
    if (close) {
      try {
        e.ws.close(1000, 'replaced');
      } catch {}
    }
  }

  /** tell the waiting TVs how many are waiting (all but `except`, which has just been told) */
  private tell(except?: Entry) {
    const now = Date.now();
    for (const q of this.queue) if (q !== except) this.send(q.ws, { type: 'waiting', n: this.queue.length, t: Math.round((now - q.since) / 1000) });
  }

  /**
   * The next time the queue can change by itself: the earliest moment a waiting TV has waited FAR_AFTER_MS (it will take anyone
   * from then on), or the heartbeat. No alarm at all when nobody waits: the object sleeps.
   */
  private async rearm() {
    if (!this.queue.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    let at = now + HEARTBEAT_MS;
    for (const w of this.queue) {
      const far = w.since + FAR_AFTER_MS + 25;
      if (far > now && far < at) at = far;
    }
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    this.ready();
    this.pairUp();
    this.tell();
    await this.rearm();
  }

  private pairUp() {
    for (;;) {
      const p = pickPair(this.queue, Date.now());
      if (!p) return;
      const { host, guest } = p;
      this.send(host.ws, { type: 'matched', role: 'host', peer: { gid: guest.gid, name: guest.name } });
      this.send(guest.ws, { type: 'matched', role: 'guest', code: host.room, peer: { gid: host.gid, name: host.name } });
      for (const e of [host, guest]) {
        this.drop(e);
        try {
          e.ws.close(1000, 'matched');
        } catch {}
      }
    }
  }
}

const rowOf = (e: Row): Row => ({ since: e.since, continent: e.continent, room: e.room, key: e.key, gid: e.gid, name: e.name, players: e.players });
