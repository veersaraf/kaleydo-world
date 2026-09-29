// TV ⇄ server connection. Auto-reconnects.
//
// Two homes: the KALEIDO server on this Mac (a localhost WebSocket; phones on the
// Wi-Fi reach the same server), or the cloud (cloud/worker.ts), where the TV makes
// up a room code, shows it with a QR code, and its phones join that room. Which one
// the page was served from says which (/api/info).

import type { ServerToTV, TVMsg } from '../../shared/protocol';

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
  onMessage: (m: ServerToTV) => void = () => {};
  onStatus: (online: boolean) => void = () => {};
  private retry = 0;
  private stopped = false;
  private key = '';
  private mode: Promise<void> | null = null;
  private pingTimers: number[] = [];
  private clock: { rtt: number; off: number }[] = [];

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
    // a reload keeps its room (the phones stay joined)
    try {
      this.room = sessionStorage.getItem('kaleido.room');
      this.key = sessionStorage.getItem('kaleido.roomKey') || '';
    } catch {}
    if (!this.room || !this.key) this.newRoom();
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
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = this.cloud ? `&room=${this.room}&key=${this.key}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws?role=tv${q}`);
    this.ws = ws;
    ws.onopen = () => {
      this.online = true;
      this.retry = 0;
      this.startPings(ws);
      this.onStatus(true);
    };
    ws.onmessage = (ev) => {
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
      if (m.type === 'hello' || m.type === 'net') {
        this.joinUrl = m.joinUrl;
        this.padUrl = m.padUrl ?? null;
        this.caUrl = m.caUrl;
      }
      if (m.type === 'replaced') this.stopped = true;
      // someone else's room: make up another
      if (m.type === 'room-taken') this.newRoom();
      this.onMessage(m);
    };
    ws.onclose = () => {
      this.stopPings();
      this.online = false;
      this.onStatus(false);
      if (this.stopped) return;
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.open(), 400 * this.retry);
    };
  }

  /** pings the server to learn its clock: a quick burst at connect (the first messages are timed against
   *  a guess until then), then every 2 s */
  private startPings(ws: WebSocket) {
    this.stopPings();
    const ping = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    };
    for (const ms of [0, 300, 700, 1500]) this.pingTimers.push(window.setTimeout(ping, ms));
    this.pingTimers.push(window.setTimeout(() => this.pingTimers.push(window.setInterval(ping, 2000)), 1500));
  }

  private stopPings() {
    for (const t of this.pingTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.pingTimers = [];
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'to-pad', pid, msg }));
  }

  toAll(msg: TVMsg) {
    this.toPad('*', msg);
  }
}
