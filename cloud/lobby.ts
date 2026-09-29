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

export const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_RE = new RegExp(`^[${ROOM_CHARS}]{5}$`);

/** a TV waits this long for someone on its own continent before anyone will do */
export const FAR_AFTER_MS = 20_000;
/** the queue is looked at (and waiting TVs told how it stands) this often */
export const TICK_MS = 5_000;
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

interface Entry extends Waiter {
  ws: WebSocket;
  room: string;
  key: string;
  gid: string;
  name: string;
  players: number;
}

export class Lobby {
  private queue: Entry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {
    void this.state;
    void this.env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mm/stats') return Response.json({ queue: this.queue.length });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const room = (url.searchParams.get('room') || '').toUpperCase();
    const key = url.searchParams.get('key') || '';
    const gid = cleanGid(url.searchParams.get('gid'));
    if (!ROOM_RE.test(room) || key.length < 8 || key.length > 64 || !gid) return new Response('bad request', { status: 400 });
    if (this.queue.length >= QUEUE_MAX) return new Response('busy', { status: 503 });
    const cont = (url.searchParams.get('cont') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || undefined;
    const players = Math.max(0, Math.min(4, parseInt(url.searchParams.get('players') || '0', 10) || 0));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.add({ ws: server, room, key, gid, name: cleanName(url.searchParams.get('name')), players, continent: cont, since: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, obj: unknown) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  private add(e: Entry) {
    // the same TV again (a reconnect, a second press): the new socket replaces the old
    for (const old of this.queue.filter((q) => q.gid === e.gid || q.room === e.room)) this.drop(old, true);
    this.queue.push(e);
    const gone = () => this.drop(e, false);
    e.ws.addEventListener('close', gone);
    e.ws.addEventListener('error', gone);
    // (nothing a TV says means anything to the lobby)
    this.send(e.ws, { type: 'waiting', n: this.queue.length, t: 0 });
    this.pairUp();
    this.arm();
  }

  private drop(e: Entry, close: boolean) {
    const i = this.queue.indexOf(e);
    if (i >= 0) this.queue.splice(i, 1);
    if (close) {
      try {
        e.ws.close(1000, 'replaced');
      } catch {}
    }
    if (!this.queue.length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private arm() {
    if (this.timer || !this.queue.length) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    this.pairUp();
    const now = Date.now();
    for (const e of this.queue) this.send(e.ws, { type: 'waiting', n: this.queue.length, t: Math.round((now - e.since) / 1000) });
  }

  private pairUp() {
    for (;;) {
      const p = pickPair(this.queue, Date.now());
      if (!p) return;
      const { host, guest } = p;
      this.send(host.ws, { type: 'matched', role: 'host', peer: { gid: guest.gid, name: guest.name } });
      this.send(guest.ws, { type: 'matched', role: 'guest', code: host.room, peer: { gid: host.gid, name: host.name } });
      for (const e of [host, guest]) {
        this.drop(e, false);
        try {
          e.ws.close(1000, 'matched');
        } catch {}
      }
    }
  }
}
