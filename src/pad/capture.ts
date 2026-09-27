// Motion capture: raw DeviceMotion / DeviceOrientation samples, button presses
// and labels, streamed to the server as JSON lines (server.mjs appends them to
// captures/<file>.jsonl). scripts/replay-capture.ts plays a capture back
// through the remote's detectors offline, so thresholds can be tuned on real
// hands instead of synthetic ones.
//
// A line is one of:
//   {"k":"meta", …}                                      who/what/when (first line)
//   {"k":"m","t":ms,"r":[α,β,γ],"a":[x,y,z]|null,"g":[x,y,z]|null,"i":interval}
//                                                        devicemotion: rotationRate (deg/s),
//                                                        acceleration, accelerationIncludingGravity
//   {"k":"o","t":ms,"o":[α,β,γ]}                         deviceorientation (degrees)
//   {"k":"e","t":ms,"ev":"…", …}                         anything else: guard down/up, a label
//                                                        segment starting/ending, what the live
//                                                        detector said (strike, near, guarded)
// t is performance.now() when the handler ran — what the remote's own code uses.

export type CaptureLine = Record<string, unknown> & { k: string };

const r4 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v: number) => Math.round(v * 100) / 100;

export class Recorder {
  /** lines sent, and bytes the server has written */
  sent = 0;
  bytes = 0;
  /** the last upload failed (it retries) */
  failing = false;
  onStatus: () => void = () => {};
  private buf: string[] = [];
  private timer = 0;
  private busy = false;

  constructor(
    readonly file: string,
    meta: Record<string, unknown> = {},
  ) {
    this.push({
      k: 'meta',
      file,
      v: 1,
      started: new Date().toISOString(),
      t0: r2(performance.now()),
      ua: navigator.userAgent,
      screen: [screen.width, screen.height],
      dpr: window.devicePixelRatio,
      ...meta,
    });
    this.timer = window.setInterval(() => void this.flush(), 700);
  }

  push(line: CaptureLine) {
    this.buf.push(JSON.stringify(line));
  }

  motion(e: DeviceMotionEvent, t: number) {
    const r = e.rotationRate,
      a = e.acceleration,
      g = e.accelerationIncludingGravity;
    this.push({
      k: 'm',
      t: r2(t),
      r: r ? [r4(r.alpha), r4(r.beta), r4(r.gamma)] : null,
      a: a && a.x != null ? [r4(a.x), r4(a.y), r4(a.z)] : null,
      g: g && g.x != null ? [r4(g.x), r4(g.y), r4(g.z)] : null,
      i: e.interval,
    });
  }

  orient(e: DeviceOrientationEvent, t: number) {
    this.push({ k: 'o', t: r2(t), o: [r4(e.alpha), r4(e.beta), r4(e.gamma)], ...(e.absolute ? { abs: 1 } : {}) });
  }

  event(ev: string, data: Record<string, unknown> = {}, t = performance.now()) {
    this.push({ k: 'e', t: r2(t), ev, ...data });
  }

  /** send what's buffered (also on a timer) */
  async flush() {
    if (this.busy || !this.buf.length) return;
    this.busy = true;
    const lines = this.buf.splice(0, 4000);
    try {
      const res = await fetch(`/api/capture?file=${encodeURIComponent(this.file)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body: lines.join('\n') + '\n',
        keepalive: lines.length < 400,
      });
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { bytes?: number };
      this.sent += lines.length;
      this.bytes = j.bytes ?? this.bytes;
      this.failing = false;
    } catch {
      // put them back (in order) and try again next time
      this.buf.unshift(...lines);
      this.failing = true;
    } finally {
      this.busy = false;
      this.onStatus();
    }
  }

  stop() {
    clearInterval(this.timer);
    void this.flush();
  }
}

/** a file name for a new capture: <what>-<date>-<time> */
export function captureName(what: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const who = what.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20) || 'capture';
  return `${who}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
