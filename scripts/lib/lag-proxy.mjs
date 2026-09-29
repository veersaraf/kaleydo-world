// A lag proxy for `wrangler dev`: what the internet does to a WebSocket, on one machine.
//
// HTTP goes through as it is (no delay: the game's files are not the point). A /ws upgrade opens
// a WebSocket upstream and forwards every frame, both ways, one-way DELAY ms later than it arrived, plus
// JITTER (normal-ish: a Gaussian of that σ clamped to ±3σ, never below zero) and now and then a SPIKE
// (a fraction SPIKE of the frames take SPIKE_MS more: a lost TCP segment looks like that). Each direction
// is a queue with send-at times that never go backwards, so a late frame holds up the ones behind it
// (head-of-line blocking, as TCP does) and nothing overtakes anything. Binary frames stay binary.
//
//   DELAY=60 JITTER=10 SPIKE=0.02 UP=http://127.0.0.1:8798 PORT=8799 node scripts/lib/lag-proxy.mjs
//   or  import { start } from './lag-proxy.mjs';  const p = await start({ delay: 40, jitter: 8, up }); … p.close()
//
//   DELAY / delay       one-way, ms (each direction: the round trip is twice it)
//   JITTER / jitter     σ of the Gaussian added to it, ms
//   SPIKE / spike       the share of frames that take an extra SPIKE_MS (0.02 = 2 %; a number over 1 is a percentage)
//   SPIKE_MS / spikeMs  the extra time of a spike (default 150)
//   UP / up             the upstream server (default http://127.0.0.1:8798)
//   PORT / port         where to listen (0 = any free port)
//   SEED / seed         the random generator's seed (runs repeat)
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

/** Start a proxy. Resolves to { port, url, close(), stats() } once it is listening. */
export function start(opts = {}) {
  const env = process.env;
  const delay = num(opts.delay ?? env.DELAY, 0);
  const jitter = num(opts.jitter ?? env.JITTER, 0);
  let spike = num(opts.spike ?? env.SPIKE, 0);
  if (spike > 1) spike /= 100;
  const spikeMs = num(opts.spikeMs ?? env.SPIKE_MS, 150);
  const up = new URL(opts.up ?? env.UP ?? 'http://127.0.0.1:8798');
  const port = num(opts.port ?? env.PORT, 0);
  // (mulberry32)
  let s = num(opts.seed ?? env.SEED, Math.floor(Math.random() * 2 ** 31)) >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.max(-3, Math.min(3, Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())));
  const oneWay = () => Math.max(0, delay + jitter * gauss() + (spike > 0 && rand() < spike ? spikeMs : 0));

  const st = { frames: 0, spikes: 0, sum: 0, min: Infinity, max: 0, conns: 0 };

  /** one direction of one connection: frames in, sent at their times, in order */
  class Pipe {
    constructor(send) {
      this.send = send;
      this.q = [];
      this.last = 0;
      this.timer = null;
      this.dead = false;
    }
    push(item) {
      const now = performance.now();
      // (never before the frame ahead of it)
      const d = oneWay();
      const at = Math.max(now + d, this.last);
      this.last = at;
      st.frames++;
      st.sum += at - now;
      st.min = Math.min(st.min, at - now);
      st.max = Math.max(st.max, at - now);
      if (spike > 0 && d >= delay + spikeMs - 1e-6) st.spikes++;
      this.q.push({ at, ...item });
      this.arm();
    }
    arm() {
      if (this.timer || !this.q.length || this.dead) return;
      const wait = Math.max(0, this.q[0].at - performance.now());
      this.timer = setTimeout(() => {
        this.timer = null;
        const now = performance.now();
        while (this.q.length && this.q[0].at <= now + 0.5) {
          const it = this.q.shift();
          try {
            this.send(it);
          } catch {}
        }
        this.arm();
      }, wait);
    }
    stop() {
      this.dead = true;
      clearTimeout(this.timer);
      this.q.length = 0;
    }
  }

  const server = http.createServer((req, res) => {
    const r = http.request({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers: { ...req.headers } }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    r.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(r);
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const sockets = new Set();
  const closeCode = (c) => (c >= 1000 && c <= 4999 && c !== 1004 && c !== 1005 && c !== 1006 && c !== 1015 ? c : 1000);
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      st.conns++;
      const upstream = new WebSocket(`ws://${up.host}${req.url}`, { perMessageDeflate: false, headers: { host: req.headers.host, 'user-agent': String(req.headers['user-agent'] ?? '') } });
      sockets.add(client);
      sockets.add(upstream);
      // (a frame sent before the upstream socket is open waits for it, its delay counted from when it was sent)
      const toUp = new Pipe((it) => {
        if (it.close) return void upstream.close(it.code, it.reason);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(it.data, { binary: it.binary });
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.once('open', () => upstream.send(it.data, { binary: it.binary }));
      });
      const toClient = new Pipe((it) => {
        if (it.close) return void client.close(it.code, it.reason);
        if (client.readyState === WebSocket.OPEN) client.send(it.data, { binary: it.binary });
      });
      client.on('message', (data, binary) => toUp.push({ data, binary }));
      upstream.on('message', (data, binary) => toClient.push({ data, binary }));
      client.on('close', (code, reason) => {
        toUp.push({ close: true, code: closeCode(code), reason: reason.toString().slice(0, 100) });
        sockets.delete(client);
      });
      upstream.on('close', (code, reason) => {
        toClient.push({ close: true, code: closeCode(code), reason: reason.toString().slice(0, 100) });
        sockets.delete(upstream);
      });
      client.on('error', () => {});
      upstream.on('error', () => {
        try {
          client.close(1011, 'upstream');
        } catch {}
      });
      const done = () => {
        if (client.readyState === WebSocket.CLOSED && upstream.readyState === WebSocket.CLOSED) {
          toUp.stop();
          toClient.stop();
        }
      };
      client.on('close', () => setTimeout(done, 2000));
      upstream.on('close', () => setTimeout(done, 2000));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        port: p,
        url: `http://127.0.0.1:${p}`,
        stats: () => ({ ...st, mean: st.frames ? st.sum / st.frames : 0 }),
        close: () =>
          new Promise((done) => {
            for (const w of sockets) {
              try {
                w.terminate();
              } catch {}
            }
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

// run by hand
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = await start();
  console.log(`lag proxy on ${p.url}  →  ${process.env.UP || 'http://127.0.0.1:8798'}  (DELAY ${process.env.DELAY || 0} ± ${process.env.JITTER || 0} ms, SPIKE ${process.env.SPIKE || 0})`);
}
