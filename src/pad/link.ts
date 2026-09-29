// Pad ⇄ server transport.
//
// Tries a WebSocket first. iOS Safari refuses wss:// to a server whose
// certificate the user merely tapped through, so if the socket doesn't open
// quickly we switch to HTTPS POST (up) + Server-Sent Events (down), which iOS
// does allow once the page itself has been accepted.

import type { PadMsg, ServerToPad } from '../shared/protocol';

export type LinkStatus = 'connecting' | 'online' | 'offline';

export class PadLink {
  status: LinkStatus = 'connecting';
  transport: 'ws' | 'http' | 'none' = 'none';
  /** one-way latency estimate, ms */
  lat = 25;
  onMessage: (m: ServerToPad) => void = () => {};
  onStatus: (s: LinkStatus) => void = () => {};

  private ws: WebSocket | null = null;
  private es: EventSource | null = null;
  private queue: PadMsg[] = [];
  private inflight = 0;
  private pingTimer = 0;
  private wsFailed = false;
  private closed = false;
  private retryTimer = 0;
  private rtts: number[] = [];
  private burstTimers: number[] = [];

  constructor(
    private pid: string,
    private getName: () => string,
  ) {}

  connect() {
    this.closed = false;
    // ?transport=http forces the iOS-style fallback (for testing)
    if (new URLSearchParams(location.search).get('transport') === 'http') this.wsFailed = true;
    if (!this.wsFailed && 'WebSocket' in window) this.tryWS();
    else this.startHTTP();
    clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.ping(), 2000);
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.burstTimers.forEach(clearTimeout);
    this.burstTimers = [];
    this.ws?.close();
    this.es?.close();
    this.ws = null;
    this.es = null;
  }

  send(msg: PadMsg | { type: 'ping'; t: number }) {
    if (this.transport === 'ws' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    if (this.transport === 'http' && this.status === 'online') {
      this.queue.push(msg as PadMsg);
      this.flush();
    }
  }

  private setStatus(s: LinkStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  /** in the cloud: the TV's room (from the QR code's link) */
  readonly room = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  /** in the cloud: the guest TV whose QR code opened this remote (`&via=`): the relay echoes this phone's swings to it at once */
  readonly via = (new URLSearchParams(location.search).get('via') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);

  private qs() {
    const r = this.room ? `&room=${this.room}` : '';
    const v = this.room && this.via ? `&via=${this.via}` : '';
    return `pid=${encodeURIComponent(this.pid)}&name=${encodeURIComponent(this.getName())}${r}${v}`;
  }

  private tryWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let opened = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws?role=pad&${this.qs()}`);
    } catch {
      this.wsFailed = true;
      this.startHTTP();
      return;
    }
    this.ws = ws;
    const giveUp = window.setTimeout(() => {
      // (a room in the cloud has a real certificate: the socket will open, keep trying it)
      if (!opened && !this.room) {
        this.wsFailed = true;
        try {
          ws.close();
        } catch {}
        this.ws = null;
        this.startHTTP();
      }
    }, 1600);
    ws.onopen = () => {
      opened = true;
      clearTimeout(giveUp);
      this.transport = 'ws';
      this.setStatus('online');
      this.pingBurst();
    };
    ws.onmessage = (ev) => {
      try {
        this.handle(JSON.parse(ev.data));
      } catch {}
    };
    ws.onclose = () => {
      clearTimeout(giveUp);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!opened && !this.room) {
        this.wsFailed = true;
        this.startHTTP();
        return;
      }
      this.setStatus('offline');
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      if (this.closed) return;
      this.setStatus('connecting');
      if (this.wsFailed) this.startHTTP();
      else this.tryWS();
    }, 1200);
  }

  private startHTTP() {
    if (this.closed) return;
    this.es?.close();
    this.transport = 'http';
    const es = new EventSource(`/api/pad/events?${this.qs()}`);
    this.es = es;
    es.onopen = () => {
      this.setStatus('online');
      this.flush();
      this.pingBurst();
    };
    es.onmessage = (ev) => {
      try {
        this.handle(JSON.parse(ev.data));
      } catch {}
    };
    es.onerror = () => {
      // EventSource reconnects by itself; reflect the state meanwhile.
      if (es.readyState !== EventSource.OPEN) this.setStatus('connecting');
    };
  }

  private async flush() {
    if (this.transport !== 'http' || this.inflight >= 2 || !this.queue.length) return;
    const msgs = this.queue.splice(0, this.queue.length);
    this.inflight++;
    const t0 = performance.now();
    try {
      const res = await fetch('/api/pad/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: this.pid, msgs }),
        cache: 'no-store',
      });
      if (res.status === 409) {
        // server lost our event stream; reopen it
        this.setStatus('connecting');
        this.startHTTP();
      } else if (res.ok) {
        const j = await res.json();
        if (j.pong) this.recordRtt(performance.now() - t0);
      }
    } catch {
      this.setStatus('connecting');
    } finally {
      this.inflight--;
      if (this.queue.length) this.flush();
    }
  }

  /** a few quick pings when the link comes up, so `lat` means something within a second or two
   *  (the 2 s ticker alone would take ~16 s to fill the median); the median of 8 still throws outliers out */
  private pingBurst() {
    this.burstTimers.forEach(clearTimeout);
    this.burstTimers = [0, 300, 700, 1500].map((ms) => window.setTimeout(() => this.ping(), ms));
  }

  private ping() {
    this.send({ type: 'ping', t: performance.now() });
  }

  private recordRtt(rtt: number) {
    this.rtts.push(rtt);
    if (this.rtts.length > 8) this.rtts.shift();
    const sorted = [...this.rtts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.lat = Math.max(1, Math.min(250, median / 2));
  }

  private handle(m: ServerToPad) {
    if (m.type === 'pong') {
      this.recordRtt(performance.now() - m.t);
      return;
    }
    if (m.type === 'bye' && m.reason === 'replaced') {
      // another tab of ours took over; stop quietly
      this.close();
      this.setStatus('offline');
    }
    this.onMessage(m);
  }
}
