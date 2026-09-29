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

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ROOMS: DurableObjectNamespace;
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

interface Pad {
  pid: string;
  name: string;
  ws: WebSocket;
}

const cleanName = (s: string | null) =>
  String(s || '')
    .replace(/[^\p{L}\p{N} _.'-]/gu, '')
    .trim()
    .slice(0, 12) || 'Player';
const cleanPid = (s: string | null) => {
  const v = String(s || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  return v.length >= 6 ? v : null;
};

export class Room {
  private tv: WebSocket | null = null;
  private tvKey: string | null = null;
  private pads = new Map<string, Pad>();
  private room = '';
  private origin = '';

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    void this.state;
    void this.env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.room = (url.searchParams.get('room') || '').toUpperCase();
    const role = url.searchParams.get('role');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    if (role === 'tv') {
      this.origin = url.origin;
      this.attachTV(server, url.searchParams.get('key') || '');
    } else if (role === 'pad') this.attachPad(server, url);
    else server.close(1008, 'role');
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket | null, obj: unknown) {
    try {
      ws?.send(JSON.stringify(obj));
    } catch {}
  }

  private padList() {
    return [...this.pads.values()].map((p) => ({ pid: p.pid, name: p.name, transport: 'ws' }));
  }

  private attachTV(ws: WebSocket, key: string) {
    if (!key || key.length < 8) {
      ws.close(1008, 'key');
      return;
    }
    // the room is someone else's
    if (this.tvKey && this.tvKey !== key) {
      this.send(ws, { type: 'room-taken' });
      ws.close(1008, 'taken');
      return;
    }
    this.tvKey = key;
    if (this.tv && this.tv !== ws) {
      this.send(this.tv, { type: 'replaced' });
      try {
        this.tv.close();
      } catch {}
    }
    this.tv = ws;
    const padUrl = `${this.origin}/c?room=${this.room}`;
    this.send(ws, { type: 'hello', joinUrl: padUrl, padUrl, caUrl: null, ips: [], dev: false, pads: this.padList(), room: this.room });
    ws.addEventListener('message', (ev) => {
      let m: { type?: string; pid?: string; msg?: unknown; t?: number } | null = null;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      // the TV's clock check: our clock, stamped as the ping is read
      if (m?.type === 'ping') {
        this.send(ws, { type: 'pong', t: m.t, st: Date.now() });
        return;
      }
      if (m?.type !== 'to-pad') return;
      if (m.pid === '*') for (const p of this.pads.values()) this.send(p.ws, m.msg);
      else if (m.pid) this.send(this.pads.get(m.pid)?.ws ?? null, m.msg);
    });
    const gone = () => {
      if (this.tv === ws) this.tv = null;
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  private attachPad(ws: WebSocket, url: URL) {
    const pid = cleanPid(url.searchParams.get('pid'));
    if (!pid) {
      ws.close(1008, 'pid');
      return;
    }
    const prev = this.pads.get(pid);
    if (prev && prev.ws !== ws) {
      this.send(prev.ws, { type: 'bye', reason: 'replaced' });
      try {
        prev.ws.close();
      } catch {}
    }
    const pad: Pad = { pid, name: cleanName(url.searchParams.get('name')), ws };
    this.pads.set(pid, pad);
    this.send(this.tv, { type: 'pad-join', pid, name: pad.name, transport: 'ws' });
    this.send(ws, { type: 'link', transport: 'ws', st: Date.now() });
    ws.addEventListener('message', (ev) => {
      let msg: { type?: string; t?: number; name?: string } | null = null;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ping') {
        this.send(ws, { type: 'pong', t: msg.t, st: Date.now() });
        return;
      }
      if (msg.type === 'hello' && typeof msg.name === 'string') pad.name = cleanName(msg.name);
      this.send(this.tv, { type: 'pad', pid, rt: Date.now(), msg });
    });
    const gone = () => {
      if (this.pads.get(pid) !== pad) return;
      this.pads.delete(pid);
      this.send(this.tv, { type: 'pad-leave', pid });
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }
}
