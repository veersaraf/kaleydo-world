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
  onMessage: (m: ServerToTV) => void = () => {};
  onStatus: (online: boolean) => void = () => {};
  private retry = 0;
  private stopped = false;
  private key = '';
  private mode: Promise<void> | null = null;

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
      this.onStatus(true);
    };
    ws.onmessage = (ev) => {
      let m: ServerToTV;
      try {
        m = JSON.parse(ev.data);
      } catch {
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
      this.online = false;
      this.onStatus(false);
      if (this.stopped) return;
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.open(), 400 * this.retry);
    };
  }

  toPad(pid: string, msg: TVMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'to-pad', pid, msg }));
  }

  toAll(msg: TVMsg) {
    this.toPad('*', msg);
  }
}
