// TV ⇄ server connection. Auto-reconnects.
//
// Two homes: the Kaleydo World server on this Mac (a localhost WebSocket; phones on the
// Wi-Fi reach the same server), or the cloud (cloud/worker.ts), where the TV makes
// up a room code, shows it with a QR code, and its phones join that room. Which one
// the page was served from says which (/api/info).

import type { GuestInfo, GuestToHost, HostToGuest, LobbyMsg, MatchmakingEvent, PadInfo, ServerToTV, TVMsg } from '../../shared/protocol';

export const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Keepalive without waking the room (cloud/worker.ts is on the WebSocket Hibernation API: an idle room is asleep and bills nothing).
// The timed ping (`{type:'ping', t}`, answered with the relay's clock) wakes it, so in the cloud it is sent only while something is
// going on; otherwise the fixed text KEEPALIVE goes out every KA_MS and is answered by the runtime itself, the room staying asleep.
/** the exact text the room answers without waking (cloud/worker.ts) */
const KEEPALIVE = 'ka';
const KA_MS = 40_000;
/** "active": something other than a keepalive came from the room (a phone or guest joined, left or sent anything; a guest hears its
 *  host) in the last ACTIVE_MS, or `busy()` says a match is running. Then the timed ping runs every 2 s; a burst starts it. */
const ACTIVE_MS = 60_000;

export class TVLink {
  ws: WebSocket | null = null;
  online = false;
  /** served from the cloud: phones join a room */
  cloud = false;
  room: string | null = null;
  /** what the QR code opens (locally the http join page; in the cloud the remote in this room) */
  joinUrl: string | null = null;
  /** the remote itself (https), where the join page sends a phone */
  padUrl: string | null = null;
  caUrl: string | null = null;
  /** the server's clock minus this page's Date.now(), ms (0 = the same clock: the Mac's own server).
   *  Measured from the TV's own pings; input.ts uses it to turn a message's relay stamp into a transit time */
  serverOffset = 0;
  // ---- online rooms (the cloud): this TV hosts its room, or is a guest in another TV's
  /** 'host': this TV's own room (the cloud's default; locally there are no rooms, 'local'); 'guest': joined another TV's room by its code */
  role: 'local' | 'host' | 'guest' = 'local';
  /** this TV's own room code (kept while it is a guest in another's, so the host can send its phones back) */
  homeRoom = '';
  /** host: the guest TVs in the room */
  guests: GuestInfo[] = [];
  /** the host's room roster as this guest last heard it (null until it has, and after the host goes) */
  roster: (HostToGuest & { type: 'room' }) | null = null;
  /** guest: whether the host is there right now (false from 'host-gone' until its next message) */
  hostHere = false;
  /** host: how a phone's seat looks on this TV (its player colour and slot), for the roster the guests are shown; the flow sets it */
  seatOf: (pid: string) => { color: string; slot: number; name: string } | null | undefined = () => null;
  /** host: the name guests are greeted with (defaults to the first phone that joined while no guest was here) */
  hostName = '';
  /** guest: the host's messages, and its binary snapshot frames */
  onHostMessage: (m: HostToGuest | ArrayBuffer) => void = () => {};
  /** quick match: the lobby's word while this TV waits for an opponent, and — for a guest — the host's word that the pairing is over */
  onMatchmaking: (m: MatchmakingEvent) => void = () => {};
  /** a match is running (the app may set it: the timed ping then runs whatever the room says; by default only the room's traffic counts) */
  busy: () => boolean = () => false;
  onMessage: (m: ServerToTV) => void = () => {};
  onStatus: (online: boolean) => void = () => {};
  private retry = 0;
  private stopped = false;
  private key = '';
  private mode: Promise<void> | null = null;
  /** host: the phones in this room */
  private pads: PadInfo[] = [];
  private rosterSig = '';
  private reopenTimer = 0;
  private pingTimers: number[] = [];
  /** cloud: the last `mode` message sent to each phone (pid -> its JSON), so an identical repeat isn't sent */
  private lastMode = new Map<string, string>();
  /** the beat that decides, each second, between the timed ping and the keepalive */
  private tickTimer = 0;
  private wasActive = false;
  private lastPing = 0;
  private txAt = 0;
  /** when the room last had something to say that wasn't a keepalive or a pong (Date.now(), 0 = never) */
  private activeAt = 0;
  private clock: { rtt: number; off: number }[] = [];
  private mm: WebSocket | null = null;
  /** phones sent a 'move' (pid -> when): their leaving the old room is expected, not a lost remote */
  private movedPids = new Map<string, number>();
  /** host: a guest's own room, from its hello (gid -> code) */
  private guestRooms = new Map<string, string>();
  private moveBack = new Map<string, number>();
  /** a socket already replaced, waiting the few ms its last message needs to leave before it is closed */
  private closing: WebSocket | null = null;

  connect() {
    this.mode ??= this.detect();
    void this.mode.then(() => this.open());
  }

  private async detect() {
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      this.cloud = !!j?.cloud;
    } catch {
      this.cloud = false;
    }
    if (!this.cloud) return;
    this.role = 'host';
    this.restoreHome();
  }

  /** this TV's own room (a reload keeps it: the phones stay joined) */
  private restoreHome() {
    try {
      this.room = sessionStorage.getItem('kaleido.room');
      this.key = sessionStorage.getItem('kaleido.roomKey') || '';
    } catch {}
    if (!this.room || !this.key) this.newRoom();
    this.homeRoom = this.room ?? '';
    this.joinUrl = this.padUrl = `${location.origin}/c?room=${this.room}`;
  }

  private newRoom() {
    const pick = (n: number, set: string) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (v) => set[v % set.length]).join('');
    this.room = pick(5, ROOM_CHARS);
    this.key = pick(24, ROOM_CHARS);
    try {
      sessionStorage.setItem('kaleido.room', this.room);
      sessionStorage.setItem('kaleido.roomKey', this.key);
    } catch {}
  }

  private open() {
    window.clearTimeout(this.reopenTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let q = 'role=tv';
    if (this.role === 'guest') q = `role=guest&room=${this.room}&gid=${this.guestId()}&name=${encodeURIComponent(this.guestName)}`;
    else if (this.cloud) q = `role=tv&room=${this.room}&key=${this.key}`;
    const ws = new WebSocket(`${proto}//${location.host}/ws?${q}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.online = true;
      this.retry = 0;
      this.startPings(ws);
      // (a guest tells the host where its own phones go back to when it leaves)
      if (this.role === 'guest') this.toHost({ type: 'hello', name: this.guestName, ...(this.homeRoom ? { room: this.homeRoom } : {}) });
      this.onStatus(true);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      // the host's match snapshot (a guest only)
      if (typeof ev.data !== 'string') {
        this.activeAt = Date.now();
        if (this.role === 'guest') this.onHostMessage(ev.data as ArrayBuffer);
        return;
      }
      // the keepalive's answer: nothing to read, nothing to count
      if (ev.data === KEEPALIVE) return;
      let m: ServerToTV;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      // our own ping's answer: the clock offset, not the game's business
      if (m.type === 'pong') {
        this.clockSample(m.t, m.st);
        return;
      }
      // (the room's own housekeeping isn't activity; a phone or a guest doing anything is)
      if (m.type !== 'hello' && m.type !== 'net' && m.type !== 'replaced' && m.type !== 'room-taken' && m.type !== 'no-room') this.activeAt = Date.now();
      if (this.role === 'guest') {
        this.guestMessage(m);
        return;
      }
      if (m.type === 'hello' || m.type === 'net') {
        this.joinUrl = m.joinUrl;
        this.padUrl = m.padUrl ?? null;
        this.caUrl = m.caUrl;
      }
      if (m.type === 'hello') this.pads = m.pads.map((p) => ({ ...p }));
      // (a phone that (re)joined has nothing yet)
      if (m.type === 'hello') this.lastMode.clear();
      else if (m.type === 'pad-join' || m.type === 'pad-leave') this.lastMode.delete(m.pid);
      if (m.type === 'replaced') this.stopped = true;
      // someone else's room: make up another
      if (m.type === 'room-taken') this.newRoom();
      this.onMessage(m);
      // (after the game has seated the phone: the roster carries its seat)
      if (this.role === 'host') this.hostMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopPings();
      this.online = false;
      this.onStatus(false);
      if (this.stopped) return;
      this.retry = Math.min(this.retry + 1, 6);
      this.reopenTimer = window.setTimeout(() => this.open(), 400 * this.retry);
    };
  }

  // ---------------------------------------------------------------- online rooms

  /** this TV's id as a guest (kept for the session, so a reload rejoins as the same guest) */
  guestId() {
    let g = '';
    try {
      g = sessionStorage.getItem('kaleido.gid') || '';
    } catch {}
    if (!g) {
      g = Array.from(crypto.getRandomValues(new Uint8Array(10)), (v) => (v % 36).toString(36)).join('');
      try {
        sessionStorage.setItem('kaleido.gid', g);
      } catch {}
    }
    return g;
  }

  /** what this TV is called to the room it joins */
  get guestName() {
    let n = '';
    try {
      n = localStorage.getItem('kaleido.tvName') || '';
    } catch {}
    return n || `TV ${this.guestId().slice(0, 3).toUpperCase()}`;
  }

  /** host: the messages that change the roster */
  private hostMessage(m: ServerToTV) {
    if (m.type === 'hello') {
      this.pushRoster();
    } else if (m.type === 'pad-join') {
      this.pads = this.pads.filter((p) => p.pid !== m.pid);
      this.pads.push(m.via ? { pid: m.pid, name: m.name, transport: m.transport, via: m.via } : { pid: m.pid, name: m.name, transport: m.transport });
      if (!this.hostName && !this.guests.length) this.hostName = m.name;
      this.pushRoster();
    } else if (m.type === 'pad-leave') {
      this.pads = this.pads.filter((p) => p.pid !== m.pid);
      this.pushRoster();
    } else if (m.type === 'guest-join') {
      if (!this.guests.some((g) => g.gid === m.gid)) this.guests.push({ gid: m.gid, name: m.name });
      else this.guests = this.guests.map((g) => (g.gid === m.gid ? { gid: m.gid, name: m.name } : g));
      // (it came back: its phones stay where they are)
      window.clearTimeout(this.moveBack.get(m.gid));
      this.moveBack.delete(m.gid);
      // (the newcomer needs it even if nothing else changed)
      this.pushRoster(true);
    } else if (m.type === 'guest-leave') {
      this.guests = this.guests.filter((g) => g.gid !== m.gid);
      this.pushRoster();
      this.sendPadsHome(m.gid);
    } else if (m.type === 'guest' && m.msg?.type === 'hello') {
      const room = String(m.msg.room || '').toUpperCase();
      if (new RegExp(`^[${ROOM_CHARS}]{5}$`).test(room) && room !== this.room) this.guestRooms.set(m.gid, room);
      const name = String(m.msg.name || '').slice(0, 12);
      if (name) {
        this.guests = this.guests.map((g) => (g.gid === m.gid ? { ...g, name } : g));
        this.pushRoster();
      }
    } else if (m.type === 'pad' && (m.msg.type === 'hello' || m.msg.type === 'prefs')) {
      // (a phone's name can change)
      this.pushRoster();
    }
  }

  /** host: a guest TV left the room; a second later (unless it is back), the phones that came in through its QR code follow it to its own room */
  private sendPadsHome(gid: string) {
    const room = this.guestRooms.get(gid);
    if (!room) return;
    window.clearTimeout(this.moveBack.get(gid));
    this.moveBack.set(
      gid,
      window.setTimeout(() => {
        this.moveBack.delete(gid);
        if (this.role !== 'host' || this.guests.some((g) => g.gid === gid)) return;
        for (const p of this.pads.filter((q) => q.via === gid)) {
          this.movedPids.set(p.pid, Date.now());
          this.toPad(p.pid, { type: 'move', room, via: '' });
        }
      }, 1000),
    );
  }

  /** whether the phone `pid` was just sent to another room (its leaving is expected) */
  wasMoved(pid: string) {
    const t = this.movedPids.get(pid);
    return t !== undefined && Date.now() - t < 4000;
  }

  /** host: the guest TV a phone was opened from ('' = one of this TV's own phones, or not known) */
  padVia(pid: string) {
    return this.pads.find((p) => p.pid === pid)?.via ?? '';
  }

  // ---------------------------------------------------------------- quick match (cloud/lobby.ts)

  /** Look for an opponent: this TV joins the lobby's queue (keeping its own room meanwhile; role stays 'host'). `players` = its seated phones.
   *  The lobby's answers come to onMatchmaking. As the guest of a pairing this link joins the host's room itself (joinRoom), then reports 'matched'. */
  quickMatch(players: number) {
    this.cancelQuickMatch();
    if (!this.cloud || this.role !== 'host' || !this.room) {
      this.onMatchmaking({ type: 'mm-error', reason: 'Quick match needs the online version' });
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = `room=${this.room}&key=${this.key}&gid=${this.guestId()}&name=${encodeURIComponent(this.guestName)}&players=${Math.max(0, Math.min(4, players | 0))}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/mm?${q}`);
    } catch {
      this.onMatchmaking({ type: 'mm-error', reason: 'Couldn’t reach the lobby' });
      return;
    }
    this.mm = ws;
    let matched = false;
    ws.onmessage = (ev) => {
      if (this.mm !== ws || typeof ev.data !== 'string') return;
      let m: LobbyMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === 'waiting') {
        this.onMatchmaking({ type: 'waiting', n: Number(m.n) || 1, t: Number(m.t) || 0 });
      } else if (m.type === 'matched' && m.peer && typeof m.peer.gid === 'string') {
        matched = true;
        const peer = { gid: String(m.peer.gid).slice(0, 40), name: String(m.peer.name || 'TV').slice(0, 12) };
        this.mm = null;
        try {
          ws.close();
        } catch {}
        if (m.role === 'host') this.onMatchmaking({ type: 'matched', role: 'host', peer });
        else if (m.role === 'guest' && typeof m.code === 'string' && new RegExp(`^[${ROOM_CHARS}]{5}$`).test(m.code)) {
          // (only this side ever goes anywhere: it joins the host's room, and its phones scan the new QR code)
          this.joinRoom(m.code, peer.name);
          this.onMatchmaking({ type: 'matched', role: 'guest', code: m.code, peer });
        }
      }
    };
    ws.onclose = () => {
      if (this.mm !== ws) return;
      this.mm = null;
      if (!matched) this.onMatchmaking({ type: 'mm-error', reason: 'Lost the connection to the lobby' });
    };
  }

  /** stop looking (the lobby drops this TV when the socket closes) */
  cancelQuickMatch() {
    const ws = this.mm;
    this.mm = null;
    try {
      ws?.close();
    } catch {}
  }

  get searching() {
    return !!this.mm;
  }

  /** host: send the guests the room's roster (phones with their seats, guests) if it changed (or `force`) */
  pushRoster(force = false) {
    if (this.role !== 'host') return;
    const pads = this.pads.map((p) => {
      const s = this.seatOf(p.pid);
      return s ? { ...p, name: s.name, color: s.color, slot: s.slot } : p;
    });
    const msg: HostToGuest = { type: 'room', code: this.room ?? '', pads, guests: this.guests, host: this.hostName || undefined };
    const sig = JSON.stringify(msg);
    if (!force && sig === this.rosterSig) return;
    this.rosterSig = sig;
    if (this.guests.length) this.toGuests(msg);
  }

  /** guest: what the relay says */
  private guestMessage(m: ServerToTV) {
    if (m.type === 'host') {
      this.hostHere = true;
      if (m.msg.type === 'mm-leave') {
        this.onMatchmaking({ type: 'peer-left' });
        return;
      }
      if (m.msg.type === 'mm-note') {
        this.onMatchmaking({ type: 'note', text: String(m.msg.text || '').slice(0, 120) });
        return;
      }
      if (m.msg.type === 'room') this.roster = m.msg;
      this.onHostMessage(m.msg);
      return;
    }
    if (m.type === 'host-gone') {
      this.hostHere = false;
      this.roster = null;
    }
    if (m.type === 'no-room') {
      // nobody's there: back to our own room
      this.leaveRoom();
    }
    this.onMessage(m);
  }

  /** guest: leave whatever this TV is doing and join room `code` as a guest (its phones join that room too) */
  joinRoom(code: string, host?: string) {
    if (!this.cloud) return;
    code = code.toUpperCase();
    let delay = 0;
    if (this.role === 'host') {
      // this TV's own phones follow it: each is told to reconnect to `code` as a phone opened from this TV (the message needs a moment
      // to leave before the socket does; this.ws is dropped by reopen at once, so nothing else can be sent or heard meanwhile)
      const ws = this.ws;
      const own = this.pads.filter((p) => !p.via);
      if (ws?.readyState === WebSocket.OPEN && own.length) {
        const msg: TVMsg = { type: 'move', room: code, via: this.guestId(), ...(host ? { host } : {}) };
        for (const p of own) {
          this.movedPids.set(p.pid, Date.now());
          ws.send(JSON.stringify({ type: 'to-pad', pid: p.pid, msg }));
        }
        delay = 50;
      }
      // (whoever is left behind waits for this TV to come back)
      for (const p of this.pads) this.onMessage({ type: 'pad-leave', pid: p.pid });
      this.pads = [];
      this.guests = [];
      this.rosterSig = '';
    }
    this.role = 'guest';
    this.room = code;
    this.roster = null;
    this.hostHere = false;
    // (the phones opened from this screen say which TV they belong to: the relay echoes their swings back to it)
    this.joinUrl = this.padUrl = `${location.origin}/c?room=${code}&via=${this.guestId()}`;
    this.reopen(delay);
  }

  /** guest: back to hosting this TV's own room */
  leaveRoom() {
    if (this.role !== 'guest') return;
    this.role = 'host';
    this.roster = null;
    this.hostHere = false;
    this.restoreHome();
    this.reopen();
  }

  private reopen(delay = 0) {
    window.clearTimeout(this.reopenTimer);
    this.stopPings();
    // (a switch still waiting on its last message: that socket goes now)
    try {
      this.closing?.close();
    } catch {}
    this.closing = null;
    const old = this.ws;
    this.ws = null;
    this.online = false;
    this.retry = 0;
    this.clock = [];
    const go = () => {
      this.closing = null;
      try {
        old?.close();
      } catch {}
      this.open();
    };
    if (delay > 0 && old) {
      this.closing = old;
      this.reopenTimer = window.setTimeout(go, delay);
    } else go();
  }

  /** pings the server to learn its clock: a quick burst at connect (the first messages are timed against a guess until then), then
   *  every 2 s while the room is active. In the cloud an idle TV sends only the keepalive, every KA_MS (see KEEPALIVE); the burst
   *  runs again when it becomes active. Locally (no rooms, nothing to wake) it pings every 2 s as ever. */
  private startPings(ws: WebSocket) {
    this.stopPings();
    this.burst(ws);
    this.tickTimer = window.setInterval(() => this.tick(ws), 1000);
  }

  private ping(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;
    this.lastPing = this.txAt = Date.now();
    ws.send(JSON.stringify({ type: 'ping', t: this.lastPing }));
  }

  private burst(ws: WebSocket) {
    for (const t of this.pingTimers) clearTimeout(t);
    this.pingTimers = [];
    this.wasActive = true;
    this.lastPing = this.txAt = Date.now();
    // (the last samples are from before a quiet spell: the clock is measured afresh)
    this.clock = [];
    for (const ms of [0, 300, 700, 1500]) this.pingTimers.push(window.setTimeout(() => this.ping(ws), ms));
  }

  private tick(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (!this.cloud || this.busy() || now - this.activeAt < ACTIVE_MS) {
      if (!this.wasActive) this.burst(ws);
      else if (now - this.lastPing >= 2000) this.ping(ws);
    } else {
      this.wasActive = false;
      if (now - this.txAt >= KA_MS) {
        this.txAt = now;
        ws.send(KEEPALIVE);
      }
    }
  }

  private stopPings() {
    for (const t of this.pingTimers) clearTimeout(t);
    this.pingTimers = [];
    clearInterval(this.tickTimer);
  }

  /** one pong: the server stamped `st` somewhere between our send (`t`) and now, taken as the middle.
   *  Of the last 8, the half with the shortest round trips (least queueing, so the truest middle) votes: the median offset */
  private clockSample(t: number, st: number) {
    const rtt = Date.now() - t;
    if (!(rtt >= 0) || !Number.isFinite(st)) return;
    this.clock.push({ rtt, off: st - (t + rtt / 2) });
    if (this.clock.length > 8) this.clock.shift();
    const best = [...this.clock].sort((a, b) => a.rtt - b.rtt).slice(0, Math.ceil(this.clock.length / 2));
    const offs = best.map((c) => c.off).sort((a, b) => a - b);
    this.serverOffset = offs[Math.floor(offs.length / 2)];
  }

  toPad(pid: string, msg: TVMsg) {
    if (this.role === 'guest' || this.ws?.readyState !== WebSocket.OPEN) return;
    // In the cloud every message to a phone is a message the room has to wake for. The flow re-sends a phone's `mode` (same words) whenever the
    // seats are touched — every ~10 s on the home screen — and a phone that has it needs nothing: an identical repeat is dropped, until the phone
    // (re)joins or the link reopens (the cache is cleared then: a phone that reconnected must be told again).
    if (this.cloud && msg.type === 'mode') {
      const sig = JSON.stringify(msg);
      if (this.lastMode.get(pid) === sig) return;
      this.lastMode.set(pid, sig);
    }
    this.ws.send(JSON.stringify({ type: 'to-pad', pid, msg }));
  }

  toAll(msg: TVMsg) {
    this.toPad('*', msg);
  }

  /** host: to every guest TV — a JSON message, or a binary snapshot frame sent as it is */
  toGuests(data: HostToGuest | ArrayBuffer) {
    if (this.role !== 'host' || this.ws?.readyState !== WebSocket.OPEN) return;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) this.ws.send(data as ArrayBuffer);
    else this.ws.send(JSON.stringify({ type: 'to-guests', msg: data }));
  }

  /** guest: to the host TV */
  toHost(msg: GuestToHost) {
    if (this.role === 'guest' && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
