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

import { Lobby } from './lobby';
export { Lobby };

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
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
  /** the guest TV whose QR code this phone came from ('' = the host's own) */
  via: string;
}

/** what a phone does that its guest TV plays a sound for at once (not 'ori', which streams at 30 Hz) */
const ECHOED = new Set(['swing', 'slash', 'bowl', 'draw']);

interface Guest {
  gid: string;
  name: string;
  ws: WebSocket;
}

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

export class Room {
  private tv: WebSocket | null = null;
  private tvKey: string | null = null;
  private pads = new Map<string, Pad>();
  /** the guest TVs (a plain array: the snapshot broadcast walks it 30 times a second and allocates nothing) */
  private guests: Guest[] = [];
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
    // (the default is 'blob', which can't be forwarded: the host's snapshots must arrive as bytes)
    (server as WebSocket & { binaryType: string }).binaryType = 'arraybuffer';
    if (role === 'tv') {
      this.origin = url.origin;
      this.attachTV(server, url.searchParams.get('key') || '');
    } else if (role === 'pad') this.attachPad(server, url);
    else if (role === 'guest') this.attachGuest(server, url);
    else server.close(1008, 'role');
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket | null, obj: unknown) {
    try {
      ws?.send(JSON.stringify(obj));
    } catch {}
  }

  private padList() {
    return [...this.pads.values()].map((p) => (p.via ? { pid: p.pid, name: p.name, transport: 'ws', via: p.via } : { pid: p.pid, name: p.name, transport: 'ws' }));
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
    // guests that were here before the TV (re)connected: tell it who's waiting
    for (const g of this.guests) this.send(ws, { type: 'guest-join', gid: g.gid, name: g.name });
    ws.addEventListener('message', (ev) => {
      // the match snapshot: a binary frame, to every guest as it is (no parsing, no copy)
      if (typeof ev.data !== 'string') {
        const gs = this.guests;
        for (let i = 0; i < gs.length; i++) {
          try {
            gs[i].ws.send(ev.data);
          } catch {}
        }
        return;
      }
      let m: { type?: string; pid?: string; msg?: unknown; t?: number } | null = null;
      try {
        m = JSON.parse(ev.data);
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
          for (const g of this.guests) {
            try {
              g.ws.send(out);
            } catch {}
          }
        }
        return;
      }
      if (m?.type !== 'to-pad') return;
      if (m.pid === '*') for (const p of this.pads.values()) this.send(p.ws, m.msg);
      else if (m.pid) this.send(this.pads.get(m.pid)?.ws ?? null, m.msg);
    });
    const gone = () => {
      if (this.tv !== ws) return;
      this.tv = null;
      // the guests stay (the TV may be back in seconds and will hear of them again)
      const out = JSON.stringify({ type: 'host-gone' });
      for (const g of this.guests) {
        try {
          g.ws.send(out);
        } catch {}
      }
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  private attachGuest(ws: WebSocket, url: URL) {
    const gid = cleanPid(url.searchParams.get('gid'));
    if (!gid) {
      ws.close(1008, 'gid');
      return;
    }
    // "the room exists" = a TV has claimed it (its key stays set while it reconnects)
    if (!this.tvKey) {
      this.send(ws, { type: 'no-room' });
      ws.close(1000, 'no-room');
      return;
    }
    const prev = this.guests.findIndex((g) => g.gid === gid);
    if (prev < 0 && this.guests.length >= GUESTS_MAX) {
      ws.close(1013, 'full');
      return;
    }
    const guest: Guest = { gid, name: cleanName(url.searchParams.get('name')), ws };
    if (prev >= 0) {
      // a reload: this one replaces the old (which leaves quietly)
      const old = this.guests[prev];
      this.guests[prev] = guest;
      try {
        old.ws.close();
      } catch {}
    } else this.guests.push(guest);
    if (this.tv) this.send(this.tv, { type: 'guest-join', gid, name: guest.name });
    else this.send(ws, { type: 'host-gone' });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > GUEST_MAX) return;
      let msg: { type?: string; t?: number } | null = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ping') {
        this.send(ws, { type: 'pong', t: msg.t, st: Date.now() });
        return;
      }
      this.send(this.tv, { type: 'guest', gid, msg });
    });
    const gone = () => {
      const i = this.guests.indexOf(guest);
      if (i < 0) return;
      this.guests.splice(i, 1);
      this.send(this.tv, { type: 'guest-leave', gid });
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
    const pad: Pad = { pid, name: cleanName(url.searchParams.get('name')), ws, via: cleanPid(url.searchParams.get('via')) ?? '' };
    this.pads.set(pid, pad);
    this.send(this.tv, pad.via ? { type: 'pad-join', pid, name: pad.name, transport: 'ws', via: pad.via } : { type: 'pad-join', pid, name: pad.name, transport: 'ws' });
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
      // (a phone that came from a guest's QR code: that guest hears its swing at once)
      if (pad.via && ECHOED.has(msg.type)) {
        const g = this.guests.find((q) => q.gid === pad.via);
        if (g) this.send(g.ws, { type: 'pad-echo', pid, msg });
      }
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
