// Pad ⇄ server transport.
//
// Tries a WebSocket first. iOS Safari refuses wss:// to a server whose
// certificate the user merely tapped through, so if the socket doesn't open
// quickly we switch to HTTPS POST (up) + Server-Sent Events (down), which iOS
// does allow once the page itself has been accepted.

import type { PadMsg, ServerToPad } from '../shared/protocol';

export type LinkStatus = 'connecting' | 'online' | 'offline';

/** the messages the TV corrects for their age: they get a `ts` */
const TIMED = new Set<string>(['swing', 'slash', 'bowl', 'grip', 'guard', 'draw', 'toss', 'prep']);

export class PadLink {
  status: LinkStatus = 'connecting';
  transport: 'ws' | 'http' | 'none' = 'none';
  /** one-way latency estimate, ms */
  lat = 25;
  onMessage: (m: ServerToPad) => void = () => {};
  onStatus: (s: LinkStatus) => void = () => {};
  /** the link came up again in a different room after a 'move' (the TV needs our hello afresh) */
  onRejoin: () => void = () => {};

  private ws: WebSocket | null = null;
  private es: EventSource | null = null;
  private queue: PadMsg[] = [];
  private inflight = 0;
  private pingTimer = 0;
  private wsFailed = false;
  private closed = false;
  private retryTimer = 0;
  private rtts: number[] = [];
  /** our wall clock at each outstanding ping's send (keyed by its performance.now() `t`) */
  private pingWall = new Map<number, number>();
  /** clock samples from the pongs: round trip and (relay clock − ours) */
  private clock: { rtt: number; off: number }[] = [];
  /** the relay's clock minus ours, ms; null until 3 pongs have been heard */
  clockOffset: number | null = null;
  private burstTimers: number[] = [];
  /** a 'move' was followed and nobody has answered yet; the timer brings us back to `from` if none does */
  private moved: { from: { room: string; via: string }; timer: number } | null = null;
  private rejoining = false;

  constructor(
    private pid: string,
    private getName: () => string,
  ) {
    // (for the end-to-end tests, which send timed messages through the real link)
    (globalThis as { __padLink?: PadLink }).__padLink = this;
  }

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
    if (this.moved) clearTimeout(this.moved.timer);
    this.moved = null;
    this.ws?.close();
    this.es?.close();
    this.ws = null;
    this.es = null;
  }

  send(msg: PadMsg | { type: 'ping'; t: number }) {
    // a timed message carries the relay's clock at its send: the TV works out this message's own uplink time from it
    // (its own median `lat` would credit a message that hit a spike only the usual)
    if (this.clockOffset !== null && TIMED.has(msg.type) && (msg as { ts?: number }).ts === undefined) (msg as { ts?: number }).ts = Date.now() + this.clockOffset;
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
  room = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  /** in the cloud: the guest TV whose QR code opened this remote (`&via=`): the relay echoes this phone's swings to it at once */
  via = (new URLSearchParams(location.search).get('via') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);

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
      if (this.ws !== ws) return;
      opened = true;
      clearTimeout(giveUp);
      this.transport = 'ws';
      this.setStatus('online');
      this.pingBurst();
      this.rejoined();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
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
      if (this.es !== es) return;
      this.setStatus('online');
      this.flush();
      this.pingBurst();
      this.rejoined();
    };
    es.onmessage = (ev) => {
      if (this.es !== es) return;
      try {
        this.handle(JSON.parse(ev.data));
      } catch {}
    };
    es.onerror = () => {
      // EventSource reconnects by itself; reflect the state meanwhile.
      if (this.es !== es) return;
      if (es.readyState !== EventSource.OPEN) this.setStatus('connecting');
    };
  }

  private async flush() {
    if (this.transport !== 'http' || this.inflight >= 2 || !this.queue.length) return;
    const msgs = this.queue.splice(0, this.queue.length);
    this.inflight++;
    const t0 = performance.now();
    const w0 = Date.now();
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
        if (j.pong) {
          const rtt = performance.now() - t0;
          this.recordRtt(rtt);
          if (typeof j.pong.st === 'number') this.clockSample(w0, j.pong.st, rtt);
        }
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
    const t = performance.now();
    this.pingWall.set(t, Date.now());
    if (this.pingWall.size > 16) this.pingWall.delete(this.pingWall.keys().next().value as number);
    this.send({ type: 'ping', t });
  }

  /** one pong: the relay stamped `st` somewhere between our send (`wall`, on our Date.now()) and the answer, taken as the middle.
   *  Of the last 8, the quarter with the shortest round trips (least queueing, so the truest middle) votes: the median offset.
   *  (The TV's link takes the best half; here the pad's own uplink is busy with its orientation stream, whose queue makes the
   *  up leg longer than the down one, so the offset is read only from the quietest samples.) */
  private clockSample(wall: number, st: number, rtt: number) {
    if (!(rtt >= 0) || !Number.isFinite(st)) return;
    this.clock.push({ rtt, off: st - (wall + rtt / 2) });
    if (this.clock.length > 8) this.clock.shift();
    if (this.clock.length < 3) return;
    const best = [...this.clock].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.clock.length / 4)));
    const offs = best.map((c) => c.off).sort((a, b) => a - b);
    this.clockOffset = offs[Math.floor(offs.length / 2)];
  }

  private recordRtt(rtt: number) {
    this.rtts.push(rtt);
    if (this.rtts.length > 8) this.rtts.shift();
    const sorted = [...this.rtts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.lat = Math.max(1, Math.min(250, median / 2));
  }

  private rejoined() {
    if (!this.rejoining) return;
    this.rejoining = false;
    this.onRejoin();
  }

  /** The TV says: come to room `room` (as a phone opened via guest `via`; '' = that room's own TV). Same id, same name; the screen
   *  never shows a disconnect (the status stays 'online' while the new socket opens). If nobody there answers within 8 s (a
   *  mistyped code, a host that left), go back to where we were. */
  private moveTo(room: string, via: string, fallback: boolean) {
    room = room.toUpperCase().replace(/[^A-Z0-9]/g, '');
    via = via.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
    if (this.closed || !room || (room === this.room && via === this.via)) return;
    const from = { room: this.room, via: this.via };
    this.room = room;
    this.via = via;
    // (a reload keeps the new room)
    try {
      const u = new URL(location.href);
      u.searchParams.set('room', room);
      if (via) u.searchParams.set('via', via);
      else u.searchParams.delete('via');
      history.replaceState(history.state, '', u.toString());
    } catch {}
    if (this.moved) clearTimeout(this.moved.timer);
    this.moved = fallback ? { from, timer: window.setTimeout(() => this.moveBack(), 8000) } : null;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    const es = this.es;
    this.ws = null;
    this.es = null;
    try {
      ws?.close();
      es?.close();
    } catch {}
    this.queue = [];
    this.rejoining = true;
    if (this.transport === 'http' || this.wsFailed) this.startHTTP();
    else this.tryWS();
  }

  private moveBack() {
    const m = this.moved;
    this.moved = null;
    if (m) this.moveTo(m.from.room, m.from.via, false);
  }

  private handle(m: ServerToPad) {
    if (m.type === 'pong') {
      const rtt = performance.now() - m.t;
      this.recordRtt(rtt);
      const wall = this.pingWall.get(m.t);
      if (wall !== undefined) {
        this.pingWall.delete(m.t);
        if (typeof m.st === 'number') this.clockSample(wall, m.st, rtt);
      }
      return;
    }
    if (m.type === 'move') {
      // (the move itself doesn't count as an answer from the new room)
      this.moveTo(m.room, m.via, true);
      this.onMessage(m);
      return;
    }
    // any word from the TV we moved to (the relay's own 'link' greeting aside): it has us
    if (this.moved && m.type !== 'link') {
      clearTimeout(this.moved.timer);
      this.moved = null;
    }
    if (m.type === 'bye' && m.reason === 'replaced') {
      // another tab of ours took over; stop quietly
      this.close();
      this.setStatus('offline');
    }
    this.onMessage(m);
  }
}
