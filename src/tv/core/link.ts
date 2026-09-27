// TV ⇄ server connection (localhost WebSocket). Auto-reconnects.

import type { ServerToTV, TVMsg } from '../../shared/protocol';

export class TVLink {
  ws: WebSocket | null = null;
  online = false;
  /** what the QR code opens (http://<ip>:<port>/join) */
  joinUrl: string | null = null;
  /** the remote itself (https), where the join page sends a phone */
  padUrl: string | null = null;
  caUrl: string | null = null;
  onMessage: (m: ServerToTV) => void = () => {};
  onStatus: (online: boolean) => void = () => {};
  private retry = 0;
  private stopped = false;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?role=tv`);
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
      if (m.type === 'replaced') {
        this.stopped = true;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      this.online = false;
      this.onStatus(false);
      if (this.stopped) return;
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(), 400 * this.retry);
    };
  }

  toPad(pid: string, msg: TVMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'to-pad', pid, msg }));
  }

  toAll(msg: TVMsg) {
    this.toPad('*', msg);
  }
}
