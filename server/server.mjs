#!/usr/bin/env node
// Kaleydo World server
//
//   http://localhost:3000        the "TV" (your Mac's browser)
//   http://<lan-ip>:3000/join    what the TV's QR code opens: checks whether the
//                                phone trusts our certificate, walks it through
//                                the one-time setup if not, then goes on to…
//   https://<lan-ip>:3443/c      the "remotes" (phones on the same Wi-Fi)
//
// The http port answers the LAN only with the join page, the iOS profile and
// the CA certificate (public data); everything else on it — the TV page, the
// API, the TV's socket — stays loopback-only, as it always was.
//
// Phones talk to the TV through this hub. Two transports are supported:
//   - WebSocket (Android, or iPhones that trust the local CA)
//   - HTTPS POST + Server-Sent Events (iPhones that just tapped through the
//     certificate warning — iOS refuses wss:// to untrusted certs, but plain
//     same-origin requests work fine).

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { ensureCerts, mobileconfig } from './certs.mjs';
import { joinPage } from './join-page.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DEV = process.argv.includes('--dev');
const OPEN = process.argv.includes('--open') || (!DEV && !process.argv.includes('--no-open'));
const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);

// ---------------------------------------------------------------- network

function lanIPs() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      found.push({ name, address: a.address });
    }
  }
  const rank = (n) =>
    n.startsWith('en') ? 0 : n.startsWith('eth') || n.startsWith('wl') ? 1 : n.startsWith('bridge') ? 3 : n.startsWith('utun') ? 5 : 2;
  found.sort((a, b) => rank(a.name) - rank(b.name));
  return found.map((f) => f.address);
}

let ips = lanIPs();
const certs = ensureCerts(path.join(__dirname, '.certs'), ips);
const primaryIP = () => ips[0] || null;
/** what the QR code opens: the plain-http join page (it forwards to padUrl) */
const joinUrl = () => (primaryIP() ? `http://${primaryIP()}:${HTTP_PORT}/join` : null);
/** the remote itself */
const padUrl = () => (primaryIP() ? `https://${primaryIP()}:${HTTPS_PORT}/c` : null);
/** the iOS profile that trusts our CA */
const caUrl = () => (primaryIP() ? `http://${primaryIP()}:${HTTP_PORT}/kaleido.mobileconfig` : null);
const profile = Buffer.from(mobileconfig(certs));
const join = joinPage({ httpsPort: HTTPS_PORT, caName: certs.caName });

// ---------------------------------------------------------------- hub

const hub = {
  tv: null,
  pads: new Map(), // pid -> { pid, name, transport, send(obj), close(reason) }
};

function sendTV(obj) {
  const tv = hub.tv;
  if (tv && tv.readyState === 1) tv.send(JSON.stringify(obj));
}

function padList() {
  return [...hub.pads.values()].map((p) => ({ pid: p.pid, name: p.name, transport: p.transport }));
}

function padJoin(pad) {
  const prev = hub.pads.get(pad.pid);
  if (prev && prev !== pad) {
    prev.replaced = true;
    prev.close('replaced');
  }
  hub.pads.set(pad.pid, pad);
  sendTV({ type: 'pad-join', pid: pad.pid, name: pad.name, transport: pad.transport });
  log(`remote joined  ${pad.name} (${pad.transport})`);
}

function padLeave(pad) {
  if (hub.pads.get(pad.pid) !== pad) return;
  hub.pads.delete(pad.pid);
  sendTV({ type: 'pad-leave', pid: pad.pid });
  log(`remote left    ${pad.name}`);
}

function fromPad(pad, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'ping') {
    pad.send({ type: 'pong', t: msg.t, st: Date.now() });
    return;
  }
  if (msg.type === 'hello' && typeof msg.name === 'string') pad.name = cleanName(msg.name);
  sendTV({ type: 'pad', pid: pad.pid, rt: Date.now(), msg });
}

function fromTV(msg, ws) {
  if (!msg) return;
  // the TV's clock check: our clock, stamped as the ping is read (the TV works out the offset)
  if (msg.type === 'ping') {
    if (ws.readyState === 1) ws.send(`{"type":"pong","t":${Number(msg.t) || 0},"st":${Date.now()}}`);
    return;
  }
  if (msg.type === 'to-pad') {
    if (msg.pid === '*') for (const p of hub.pads.values()) p.send(msg.msg);
    else hub.pads.get(msg.pid)?.send(msg.msg);
  }
}

function cleanName(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N} _.'-]/gu, '')
    .trim()
    .slice(0, 12) || 'Player';
}

function cleanPid(s) {
  const v = String(s || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  return v.length >= 6 ? v : null;
}

// ---------------------------------------------------------------- websockets

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** the Host header names this machine by its loopback name (not a rebound DNS name) */
function loopbackHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function onUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return; // let other listeners (none in prod) handle it
  const role = url.searchParams.get('role');
  if (role === 'tv' && (!isLoopback(req.socket.remoteAddress) || !loopbackHost(req))) {
    socket.destroy();
    return;
  }
  if (role !== 'tv' && role !== 'pad') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    socket.setNoDelay?.(true);
    if (role === 'tv') attachTV(ws);
    else attachPadWS(ws, url);
  });
}

function attachTV(ws) {
  if (hub.tv && hub.tv !== ws) {
    try {
      hub.tv.send(JSON.stringify({ type: 'replaced' }));
      hub.tv.close();
    } catch {}
  }
  hub.tv = ws;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.send(
    JSON.stringify({
      type: 'hello',
      joinUrl: joinUrl(),
      padUrl: padUrl(),
      caUrl: caUrl(),
      ips,
      dev: DEV,
      pads: padList(),
    }),
  );
  ws.on('message', (data) => {
    try {
      fromTV(JSON.parse(data.toString()), ws);
    } catch {}
  });
  ws.on('close', () => {
    if (hub.tv === ws) hub.tv = null;
  });
  log('screen connected');
}

function attachPadWS(ws, url) {
  const pid = cleanPid(url.searchParams.get('pid'));
  if (!pid) return ws.close();
  const pad = {
    pid,
    name: cleanName(url.searchParams.get('name')),
    transport: 'ws',
    send: (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj)),
    close: (reason) => {
      try {
        ws.send(JSON.stringify({ type: 'bye', reason }));
        ws.close();
      } catch {}
    },
  };
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  padJoin(pad);
  pad.send({ type: 'link', transport: 'ws', st: Date.now() });
  ws.on('message', (data) => {
    try {
      fromPad(pad, JSON.parse(data.toString()));
    } catch {}
  });
  ws.on('close', () => padLeave(pad));
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 10000).unref();

// ---------------------------------------------------------------- http routes

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function padEvents(req, res, url) {
  const pid = cleanPid(url.searchParams.get('pid'));
  if (!pid) return sendJSON(res, 400, { error: 'pid' });
  req.socket.setNoDelay(true);
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  const pad = {
    pid,
    name: cleanName(url.searchParams.get('name')),
    transport: 'http',
    send: (obj) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {}
    },
    close: (reason) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'bye', reason })}\n\n`);
        res.end();
      } catch {}
    },
  };
  padJoin(pad);
  pad.send({ type: 'link', transport: 'http', st: Date.now() });
  const beat = setInterval(() => {
    try {
      res.write(': beat\n\n');
    } catch {}
  }, 15000);
  req.on('close', () => {
    clearInterval(beat);
    padLeave(pad);
  });
}

async function padSend(req, res) {
  req.socket.setNoDelay(true);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { error: 'body' });
  }
  const pid = cleanPid(body.pid);
  const pad = pid && hub.pads.get(pid);
  if (!pad || pad.transport !== 'http') return sendJSON(res, 409, { error: 'no-session' });
  const msgs = Array.isArray(body.msgs) ? body.msgs.slice(0, 64) : [];
  let pong = null;
  for (const m of msgs) {
    if (m && m.type === 'ping') pong = { type: 'pong', t: m.t, st: Date.now() };
    else fromPad(pad, m);
  }
  sendJSON(res, 200, { ok: 1, st: Date.now(), pong });
}

// Motion captures (the remote's record mode, /rec): JSON lines appended to
// captures/<file>.jsonl — replay one with scripts/replay-capture.ts.
const CAPTURES = path.join(ROOT, 'captures');

async function captureAppend(req, res, url) {
  const file = String(url.searchParams.get('file') || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
  if (!file) return sendJSON(res, 400, { error: 'file' });
  let body;
  try {
    body = await readBody(req, 4 * 1024 * 1024);
  } catch {
    return sendJSON(res, 413, { error: 'too large' });
  }
  const dest = path.join(CAPTURES, file + '.jsonl');
  await fs.promises.mkdir(CAPTURES, { recursive: true });
  await fs.promises.appendFile(dest, body.endsWith('\n') ? body : body + '\n');
  const st = await fs.promises.stat(dest);
  if (!captureSeen.has(file)) {
    captureSeen.add(file);
    log(`recording      captures/${file}.jsonl`);
  }
  sendJSON(res, 200, { ok: 1, bytes: st.size });
}
const captureSeen = new Set();

let qrCache = { key: '', svg: '' };
async function qrSvg(res, url) {
  const target = url.searchParams.get('u') || joinUrl() || 'http://localhost';
  const dark = /^[0-9a-fA-F]{6}$/.test(url.searchParams.get('dark') || '') ? '#' + url.searchParams.get('dark') : '#1b1b2f';
  const key = target + dark;
  if (qrCache.key !== key) {
    qrCache = {
      key,
      svg: await QRCode.toString(target, {
        type: 'svg',
        margin: 0,
        errorCorrectionLevel: 'M',
        color: { dark, light: '#0000' },
      }),
    };
  }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  res.end(qrCache.svg);
}

// Static files (production). In dev, Vite's middlewares take over.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. (Did you run `npm start` so the game is built?)');
      return;
    }
    const ext = path.extname(file);
    const immutable = rel.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/** The join page's trust check: reachable (over https, so only if the phone trusts our CA). */
function trustCheck(req, res) {
  const body = '{"ok":1}';
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    // (nothing secret here: any page may ask, no cookies go with it)
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJoin(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(join.html),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': join.csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  res.end(join.html);
}

function sendProfile(res) {
  res.writeHead(200, {
    // (Safari offers to install a profile only for this type)
    'Content-Type': 'application/x-apple-aspen-config',
    'Content-Disposition': 'attachment; filename="KALEIDO.mobileconfig"',
    'Content-Length': profile.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(profile);
}

function sendCA(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="KALEIDO-Local-CA.crt"',
    'Content-Length': certs.caDer.length,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(certs.caDer);
}

/**
 * Plain http from another machine (a phone that scanned the QR code). Only
 * public things are served here: the join page, the profile and the CA
 * certificate. The TV page, the API and the sockets stay loopback-only.
 */
function handleLan(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const hdr = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...hdr, Allow: 'GET, HEAD' }).end();
    return;
  }
  if (p === '/join' || p === '/join/') return sendJoin(res);
  if (p === '/kaleido.mobileconfig') return sendProfile(res);
  if (p === '/kaleido-ca.crt') return sendCA(res);
  // the old remote addresses (and the bare address): to the join page
  if (p === '/' || p === '/c' || p === '/c/' || p === '/pad' || p === '/controller' || p === '/controller.html') {
    res.writeHead(302, { ...hdr, Location: '/join' });
    return res.end();
  }
  res.writeHead(404, { ...hdr, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not here. Scan the QR code on the TV, or open /join.');
}

function handleHttp(req, res) {
  if (isLoopback(req.socket.remoteAddress)) return handle(req, res);
  return handleLan(req, res);
}

let vite = null;

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/info') {
      return sendJSON(res, 200, { joinUrl: joinUrl(), padUrl: padUrl(), caUrl: caUrl(), ips, dev: DEV, pads: padList().length });
    }
    if (p === '/api/trust') return trustCheck(req, res);
    if (p === '/join' || p === '/join/') return sendJoin(res);
    if (p === '/kaleido.mobileconfig') return sendProfile(res);
    if (p === '/api/qr.svg') return await qrSvg(res, url);
    if (p === '/api/pad/events') return padEvents(req, res, url);
    if (p === '/api/pad/send' && req.method === 'POST') return await padSend(req, res);
    if (p === '/api/capture' && req.method === 'POST') return await captureAppend(req, res, url);
    if (p === '/rec' || p === '/rec/') {
      res.writeHead(302, { Location: '/capture.html' + url.search });
      return res.end();
    }
    if (p === '/kaleido-ca.crt') return sendCA(res);
    // a phone that lands on the https root wants the remote, not the TV
    if (p === '/' && !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(302, { Location: '/controller.html' + url.search });
      return res.end();
    }
    if (p === '/c' || p === '/c/' || p === '/pad' || p === '/controller') {
      res.writeHead(302, { Location: '/controller.html' + url.search });
      return res.end();
    }
    if (vite) {
      return vite.middlewares(req, res, () => {
        res.writeHead(404).end();
      });
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'server' });
  }
}

// ---------------------------------------------------------------- boot

function log(s) {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  console.log(`  \x1b[2m${t}\x1b[0m  ${s}`);
}

function listen(server, port, host, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`\n  Port ${port} (${label}) is already in use. Is Kaleydo World already running?\n`);
      }
      reject(e);
    });
    server.listen(port, host, resolve);
  });
}

async function main() {
  if (DEV) {
    const { createServer } = await import('vite');
    vite = await createServer({
      root: ROOT,
      server: { middlewareMode: true, hmr: { port: Number(process.env.HMR_PORT || 24678) } },
      appType: 'mpa',
    });
  } else if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('\n  No build found. Run `npm start` (builds, then serves) or `npm run dev`.\n');
    process.exit(1);
  }

  const httpServer = http.createServer(handleHttp);
  // (sockets on the http port: the TV's, from this Mac only)
  httpServer.on('upgrade', (req, socket, head) => {
    if (!isLoopback(req.socket.remoteAddress)) return socket.destroy();
    onUpgrade(req, socket, head);
  });
  const httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, handle);
  httpsServer.on('upgrade', onUpgrade);
  // (the phone's POSTs ride one kept-alive connection; headersTimeout must outlast keepAliveTimeout, or Node
  // can cut an idle connection just as the next POST is sent on it, which costs that swing a retry)
  httpServer.keepAliveTimeout = httpsServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = httpsServer.headersTimeout = 66000;

  // all interfaces: phones reach /join on it (handleLan keeps the rest to this Mac)
  await listen(httpServer, HTTP_PORT, '0.0.0.0', 'screen');
  await listen(httpsServer, HTTPS_PORT, '0.0.0.0', 'remotes');

  const b = '\x1b[1m', r = '\x1b[0m', c = '\x1b[36m', m = '\x1b[35m', y = '\x1b[33m', d = '\x1b[2m';
  console.log(`
  ${m}${b}K A L E Y D O   W O R L D${r}   ${d}${DEV ? 'dev server' : 'ready'}${r}

  ${b}Screen${r}   ${c}http://localhost:${HTTP_PORT}${r}   ${d}open on this Mac${r}
  ${b}Phones${r}   ${c}${joinUrl() || '(no Wi-Fi address found — connect to a network)'}${r}
           ${d}scan the QR code on screen with your iPhone (same Wi-Fi)${r}
  ${b}Remote${r}   ${c}${padUrl() || '—'}${r}   ${d}(where the join page sends it)${r}

  ${y}First time on a phone:${r} the join page offers a one-time setup (download a
  profile, install it, turn on trust) so Safari trusts this Mac's certificate and
  never warns again. Or skip it and tap ${b}Show Details → visit this website${r} in
  Safari's warning. Either way the certificate is made on this Mac, for your games.
  If macOS asks whether node may accept incoming connections, choose ${b}Allow${r}.
`);

  if (OPEN && process.platform === 'darwin') exec(`open http://localhost:${HTTP_PORT}`);

  // Pick up Wi-Fi changes (e.g. the Mac joins a different network).
  setInterval(() => {
    const now = lanIPs();
    if (now.join() !== ips.join()) {
      ips = now;
      log(`network changed → ${joinUrl() || 'offline'} (restart Kaleydo World to refresh the certificate)`);
      sendTV({ type: 'net', joinUrl: joinUrl(), padUrl: padUrl(), caUrl: caUrl(), ips });
    }
  }, 5000).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
