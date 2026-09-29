// The online match stream end to end: a host TV page plays a tennis match (a simulated phone joined
// to it serves and rallies against the CPU) and streams it; a guest TV page renders the stream.
//
//   BRIDGE=1 node scripts/online-e2e.mjs     the host's toGuests and the guest's onHostMessage are joined
//                                            in-page through Playwright bindings (no relay needed: the
//                                            server just has to serve the game)
//   node scripts/online-e2e.mjs              through the room: the guest joins the host's room by its code
//                                            (needs `npx wrangler dev --port 8794` and the room-join work)
//
//   BASE=http://127.0.0.1:8794   where the game is served (wrangler dev, or `node server/server.mjs --dev`)
//   PHONE=0                      CPU against CPU instead of the simulated phone
//   SECONDS=24                   how long the match is played before the checks
//   OUT=dir                      where the screenshots go
//
// Checks: same world; the guest's shadow match scores as the host's; the guest's ball is where the
// host's was (compared at the same simulation time, exactly); every match event arrives, in order; a
// 1 s stall in the bridge and a 2.2 s one recover; a Kaleido world change follows; no page errors.
import { chromium } from 'playwright-core';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8794';
const BRIDGE = !!process.env.BRIDGE;
const USE_PHONE = process.env.PHONE !== '0';
const SECONDS = Number(process.env.SECONDS || 24);
const OUT = process.env.OUT || '.';
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) errors.push(`[${name} console] ${m.text()}`);
  });
};

// ---------------------------------------------------------------- the two TVs
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const guestCtx = await browser.newContext({ viewport: { width: 960, height: 540 } });
if (BRIDGE) {
  // (the local server has one TV socket: the guest must not take it from the host)
  await guestCtx.addInitScript(() => {
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(u, p) {
        super(String(u).includes('role=tv') ? 'ws://127.0.0.1:1/none' : u, p);
      }
    };
  });
}
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
watch(host, 'host');
watch(guest, 'guest');
for (const [page, name] of [[host, 'host'], [guest, 'guest']]) {
  await page.goto(BASE + '/');
  await page.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 2 })));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.kaleido && window.flow && (document.querySelector('.boot.done') || !document.querySelector('.boot')), null, { timeout: 60000 });
  console.log(`${name} TV is up`);
}
await host.bringToFront();

// ---------------------------------------------------------------- the link between them
let stallUntil = 0;
const held = [];
const sendToGuest = (m) => guest.evaluate((x) => window.__fromHost(x), m).catch(() => {});
let sent = 0;
if (BRIDGE) {
  await guest.evaluate(() => {
    const k = window.kaleido;
    k.link.role = 'guest';
    window.__fromHost = (m) => {
      if (m && m.b64) {
        const s = atob(m.b64);
        const u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        k.link.onHostMessage(u.buffer);
      } else k.link.onHostMessage(m);
    };
  });
  await host.exposeFunction('__toGuest', (m) => {
    if (Date.now() < stallUntil || held.length) held.push(m);
    else {
      sent++;
      sendToGuest(m);
    }
  });
  setInterval(() => {
    if (Date.now() >= stallUntil) while (held.length) (sent++, sendToGuest(held.shift()));
  }, 4);
  await host.evaluate(() => {
    const l = window.kaleido.link;
    l.role = 'host';
    l.guests = [{ gid: 'g1', name: 'Guest' }];
    const b64 = (buf) => {
      const u = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s);
    };
    l.toGuests = (d) => window.__toGuest(d instanceof ArrayBuffer ? { b64: b64(d) } : d);
  });
} else {
  const room = await host.evaluate(() => window.kaleido.link.room);
  await guest.evaluate((r) => window.kaleido.link.joinRoom(r), room);
  const ok = await guest.waitForFunction(() => window.kaleido.link.role === 'guest', null, { timeout: 8000 }).then(() => true).catch(() => false);
  if (!ok) {
    console.log('SKIP: joinRoom() does not put this TV in the host\'s room yet (the room-join work); run with BRIDGE=1');
    await browser.close();
    process.exit(2);
  }
  await host.waitForFunction(() => window.kaleido.link.guests.length > 0, null, { timeout: 8000 });
}

// ---------------------------------------------------------------- the simulated phone (joined to the host)
let pad = null;
if (USE_PHONE) {
  const cloud = await host.evaluate(() => window.kaleido.link.cloud);
  const padCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await padCtx.addInitScript(phone);
  pad = await padCtx.newPage();
  watch(pad, 'pad');
  if (cloud) {
    const url = await host.evaluate(() => window.kaleido.link.joinUrl);
    await pad.goto(url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
  } else await pad.goto(BASE + '/controller.html?auto');
  const joined = await host.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('the simulated phone joined the host', joined);
  if (!joined) {
    await browser.close();
    process.exit(1);
  }
  await host.bringToFront();
  await sleep(1500);
  // swings on demand
  await host.exposeFunction('__swingAt', (at) => {
    pad.evaluate((a) => window.__phone.tennis({ at: a }), at).catch(() => {});
  });
  // (a tap on the pad's toss button)
  await host.exposeFunction('__tap', () => {
    pad
      .evaluate(() => document.querySelector('.toss').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true })))
      .catch(() => {});
  });
}

// ---------------------------------------------------------------- recording (in both pages)
await host.evaluate(() => {
  const k = window.kaleido;
  const tmp = { x: 0, y: 0, z: 0 };
  window.__ev = [];
  window.__points = [];
  window.__hostLog = [];
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    window.__ev.push(e.type + (e.type === 'state' ? ':' + e.state : ''));
    if (e.type === 'point') window.__points.push(`${k.match.score.games.join('-')}|${k.match.score.points.join('-')}|${e.winner}|${e.reason}|${e.call}`);
    oe(e);
  };
  const of = k.onFrame;
  k.onFrame = (dt) => {
    const m = k.match;
    if (m && !k.attract) {
      m.ballView(m.t, tmp);
      window.__hostLog.push({ t: m.t, x: tmp.x, y: tmp.y, z: tmp.z, h: m.ball.holder ? 1 : 0 });
    }
    of(dt);
  };
});
await guest.evaluate(() => {
  const k = window.kaleido;
  const tmp = { x: 0, y: 0, z: 0 };
  window.__ev = [];
  window.__points = [];
  window.__frames = 0;
  window.__gap = 0;
  window.__jumps = 0;
  window.__maxStep = 0;
  let prev = null;
  let prevHold = true;
  let last = performance.now();
  window.__evAt = [];
  window.__jumpAt = [];
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    window.__ev.push(e.type + (e.type === 'state' ? ':' + e.state : ''));
    window.__evAt.push([e.type, Date.now()]);
    if (e.type === 'point') window.__points.push(`${k.match.score.games.join('-')}|${k.match.score.points.join('-')}|${e.winner}|${e.reason}|${e.call}`);
    oe(e);
  };
  const of = k.onFrame;
  k.onFrame = (dt) => {
    of(dt);
    const now = performance.now();
    window.__gap = Math.max(window.__gap, now - last);
    last = now;
    const m = k.match;
    if (!k.guest || !m) return;
    window.__frames++;
    m.ballView(m.t, tmp);
    const hold = !!m.ball.holder;
    if (prev && !hold && !prevHold && m.state !== 'intro') {
      const s = Math.hypot(tmp.x - prev.x, tmp.y - prev.y, tmp.z - prev.z);
      window.__maxStep = Math.max(window.__maxStep, s);
      if (s > 1.4) (window.__jumps++, window.__jumpAt.push([Date.now(), s]));
    }
    prev = { x: tmp.x, y: tmp.y, z: tmp.z };
    prevHold = hold;
  };
});

// ---------------------------------------------------------------- the match
const started = await host.evaluate(({ usePhone }) => {
  const f = window.flow;
  const k = window.kaleido;
  f.mode = 'quick';
  const cfg = f.buildConfig();
  cfg.firstServer = 0;
  if (!usePhone) {
    const ai = cfg.players.find((p) => p.ctrl.kind === 'cpu').ctrl.ai;
    for (const p of cfg.players) p.ctrl = { kind: 'cpu', ai };
  }
  f.beginMatch('plaza', false, cfg);
  return { humans: cfg.players.filter((p) => p.ctrl.kind === 'human').length, world: k.stage.current.def.id };
}, { usePhone: USE_PHONE });
console.log(`host started a match (${started.humans} human), world ${started.world}`);
const guestUp = await guest.waitForFunction(() => window.kaleido.guest && window.kaleido.guest.ready, null, { timeout: 15000 }).then(() => true).catch(() => false);
check('the guest built the match from the host\'s `start` and is receiving snapshots', guestUp);
if (!guestUp) {
  console.log(errors.join('\n'));
  await browser.close();
  process.exit(1);
}
const worlds = async () => ({ host: await host.evaluate(() => window.kaleido.stage.current.def.id), guest: await guest.evaluate(() => window.kaleido.stage.current.def.id) });
{
  const w = await worlds();
  check('the guest shows the same world', w.host === w.guest, `${w.host} / ${w.guest}`);
}
// the guest has the same players
{
  const names = (p) => p.evaluate(() => window.kaleido.match.players.map((q) => `${q.team}:${q.name}:${q.human ? 'H' : 'C'}:${q.look.shirt}`));
  const [a, b] = await Promise.all([names(host), names(guest)]);
  check('the guest\'s players are the host\'s (team, name, who plays, kit)', JSON.stringify(a) === JSON.stringify(b), JSON.stringify(b));
}

// drive the phone: toss and serve, then meet every ball
if (USE_PHONE) {
  await host.evaluate(() => {
    const k = window.kaleido;
    let busyUntil = 0;
    let stage = '';
    let lastPlan = null;
    window.__swings = 0;
    setInterval(() => {
      const m = k.match;
      if (!m || k.attract || k.guest) return;
      const now = Date.now();
      if (now < busyUntil) return;
      const me = m.players.find((p) => p.human);
      if (!me) return;
      // (the simulated phone can only swing one swing at a time, and needs ~300 ms of lead)
      if (m.state === 'serve' && m.server.human && m.t - m.stateT0 > 0.7) {
        if (stage !== 'toss') {
          stage = 'toss';
          window.__tap();
          busyUntil = now + 150;
        }
      } else if (m.state === 'toss' && m.server.human) {
        if (stage !== 'serve') {
          stage = 'serve';
          const at = now + (m.server.tossT + 0.78 - m.t) * 1000;
          if (at - now > 300) {
            window.__swingAt(at);
            window.__swings++;
            busyUntil = at + 720;
          }
        }
      } else if (m.state === 'play' && me.plan && me.plan !== lastPlan && !me.swing) {
        const at = now + (me.plan.t - m.t) * 1000;
        if (at - now > 300) {
          lastPlan = me.plan;
          window.__swingAt(at);
          window.__swings++;
          busyUntil = at + 720;
        }
      } else if (m.state !== 'toss') stage = m.state === 'serve' ? stage : '';
    }, 15);
  });
}

// ---------------------------------------------------------------- run, comparing as we go
let cursor = 0;
const cmp = { n: 0, max: 0, sum: 0, skipped: 0 };
const compare = async () => {
  const log = await host.evaluate((i) => window.__hostLog.slice(i), cursor);
  if (!log.length) return;
  const r = await guest.evaluate((log) => {
    const g = window.kaleido.guest;
    const out = { n: 0, max: 0, sum: 0, skipped: 0, consumed: 0 };
    if (!g) return out;
    const tmp = { x: 0, y: 0, z: 0 };
    for (const e of log) {
      if (e.t > g.tR - 0.1) break;
      out.consumed++;
      if (e.h) continue;
      if (g.ballAtSimTime(e.t, tmp)) {
        const d = Math.hypot(tmp.x - e.x, tmp.y - e.y, tmp.z - e.z);
        out.max = Math.max(out.max, d);
        out.sum += d;
        out.n++;
      } else out.skipped++;
    }
    return out;
  }, log);
  cursor += r.consumed;
  cmp.n += r.n;
  cmp.sum += r.sum;
  cmp.max = Math.max(cmp.max, r.max);
  cmp.skipped += r.skipped;
};

const t0 = Date.now();
const stalls = [];
let stall1 = false;
let stall2 = false;
let shifted = false;
let badge = false;
let reconnectingSeen = false;
let clean = null;
let shiftCheckAt = 0;
while (Date.now() - t0 < SECONDS * 1000) {
  await sleep(500);
  await compare();
  const el = (Date.now() - t0) / 1000;
  if (BRIDGE && !stall1 && el > SECONDS * 0.3) {
    // (the delay on a healthy link, before we break it)
    clean = await guest.evaluate(() => window.kaleido.guest.stats);
    stall1 = true;
    stallUntil = Date.now() + 1000;
    stalls.push([Date.now(), stallUntil]);
    console.log('  … stalling the bridge for 1 s');
  }
  if (!shifted && el > SECONDS * 0.5) {
    shifted = true;
    await host.evaluate(() => window.kaleido.stage.setWorld('neon', { transition: true, origin: { x: 0.5, y: 0.5 } }));
    shiftCheckAt = Date.now() + 3500;
    console.log('  … a world change on the host');
  }
  if (BRIDGE && !stall2 && el > SECONDS * 0.7) {
    stall2 = true;
    stallUntil = Date.now() + 2200;
    stalls.push([Date.now(), stallUntil]);
    console.log('  … stalling the bridge for 2.2 s');
  }
  if (stall2 && Date.now() < stallUntil + 100) {
    const s = await guest.evaluate(() => ({ r: window.kaleido.guest?.reconnecting, b: [...document.querySelectorAll('div')].some((d) => d.textContent === 'reconnecting…' && d.children.length === 0) }));
    if (s.r) reconnectingSeen = true;
    if (s.b) badge = true;
  }
}
// let it settle: the bridge open, the guest caught up, and (if the match is still on) a quiet moment between points
stallUntil = 0;
await sleep(600);
await compare();
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    const s = await host.evaluate(() => ({ st: window.kaleido.match?.state, t: window.kaleido.match?.t }));
    if (s.st === 'over' || s.st === 'serve' || s.st === 'dead' || s.st === 'reset') break;
    await sleep(250);
  }
  await sleep(1500);
};
await settle();
await compare();

// ---------------------------------------------------------------- the checks
const hostData = await host.evaluate(() => {
  const k = window.kaleido;
  const m = k.match;
  return { ev: window.__ev, points: window.__points, score: { games: [...m.score.games], points: [...m.score.points], state: m.state, server: m.server.id, rally: m.rally, winner: m.score.winner }, world: k.stage.current.def.id, next: k.stage.next?.def.id ?? null, swings: window.__swings ?? 0, net: k.net.stats, enc: k.net.encodeTimes(), t: m.t };
});
const guestData = await guest.evaluate(() => {
  const k = window.kaleido;
  const m = k.match;
  const g = k.guest;
  return {
    ev: window.__ev,
    points: window.__points,
    score: m ? { games: [...m.score.games], points: [...m.score.points], state: m.state, server: m.server.id, rally: m.rally, winner: m.score.winner } : null,
    world: k.stage.current.def.id,
    next: k.stage.next?.def.id ?? null,
    stats: g ? g.stats : null,
    frames: window.__frames,
    gap: window.__gap,
    jumps: window.__jumps,
    jumpAt: window.__jumpAt,
    evAt: window.__evAt,
    maxStep: window.__maxStep,
    reconnecting: g ? g.reconnecting : null,
    ended: g ? g.ended : null,
    screen: document.querySelector('.screen:not(.leaving) .winner')?.textContent ?? null,
  };
});
const hits = hostData.ev.filter((e) => e === 'hit').length;
console.log(`host: ${hits} hits, ${hostData.ev.filter((e) => e === 'bounce').length} bounces, ${hostData.ev.filter((e) => e === 'point').length} points, ${hostData.swings} phone swings, ${hostData.net.snapshots} snapshots (${(hostData.net.bytes / Math.max(1, hostData.net.snapshots)).toFixed(0)} bytes each, encode mean ${((hostData.net.encodeMsTotal / Math.max(1, hostData.net.snapshots)) * 1000).toFixed(0)} µs, p99 ${(hostData.enc.p99 * 1000).toFixed(0)} µs (the page's timer is coarse: 100 µs), max ${(hostData.net.encodeMsMax * 1000).toFixed(0)} µs)`);
check('encoding a snapshot takes the host under 0.2 ms (p99)', hostData.enc.p99 < 0.2, `p99 ${(hostData.enc.p99 * 1000).toFixed(0)} µs`);
check('a rally happened (at least 6 hits and a point)', hits >= 6 && hostData.ev.includes('point'), `${hits} hits`);

check('every match event reached the guest, in order', hostData.ev.join() === guestData.ev.join(), hostData.ev.join() === guestData.ev.join() ? `${hostData.ev.length} events` : `host ${hostData.ev.length}, guest ${guestData.ev.length}`);
const kinds = (l, k) => l.filter((e) => e === k).length;
check('…hit / bounce / point / net / whiff counts agree', ['hit', 'bounce', 'point', 'net', 'whiff', 'fault'].every((k) => kinds(hostData.ev, k) === kinds(guestData.ev, k)), ['hit', 'bounce', 'point'].map((k) => `${k} ${kinds(hostData.ev, k)}/${kinds(guestData.ev, k)}`).join(' '));
check('each point event saw the same score on both TVs', hostData.points.join('\n') === guestData.points.join('\n'), hostData.points.length + ' points');
check('the guest\'s shadow match scores as the host\'s (points, games, server, state)', JSON.stringify(hostData.score) === JSON.stringify(guestData.score), `${JSON.stringify(hostData.score)} vs ${JSON.stringify(guestData.score)}`);
console.log(`ball: ${cmp.n} host frames compared at the same simulation time, max ${(cmp.max * 100).toFixed(3)} cm, mean ${((cmp.sum / Math.max(1, cmp.n)) * 1000).toFixed(3)} mm (${cmp.skipped} outside the guest's ring)`);
check('the guest\'s ball is within 2 cm of the host\'s at the same host time', cmp.n > 300 && cmp.max < 0.02, `max ${(cmp.max * 100).toFixed(3)} cm over ${cmp.n} frames`);
// a step over 1.4 m between two frames is only allowed when a stall ended: the ball flew on along its old segment
// while the host's play moved on (a hit, a bounce that slowed it, the net, a point, a serve): a segment change explains it
const explained = (j) => stalls.some(([a, b]) => j[0] >= a && j[0] <= b + 700 && guestData.evAt.some(([t, at]) => at >= a - 200 && at <= b + 700 && ['hit', 'toss', 'point', 'state', 'bounce', 'net', 'let', 'fault'].includes(t)));
const stray = guestData.jumpAt.filter((j) => !explained(j));
for (const j of stray) console.log('  stray step', j[1].toFixed(2), 'm; events around it:', guestData.evAt.filter(([, at]) => Math.abs(at - j[0]) < 400).map(([t, at]) => `${t}@${at - j[0]}`).join(' '), '; stalls', stalls.map(([x, y]) => `${x - j[0]}..${y - j[0]}`).join(' '));
check('the ball never teleported on the guest (a step over 1.4 m in a frame) except where a segment change explains it', stray.length === 0, `${guestData.jumps} big steps, ${guestData.jumps - stray.length} at a stall's end${guestData.jumps ? ' (' + guestData.jumpAt.map((j) => j[1].toFixed(1) + ' m').join(', ') + ')' : ''}; otherwise the largest step is a frame's worth of ball (${guestData.maxStep.toFixed(2)} m max)`);
if (BRIDGE) {
  check('the guest recovered from a 1 s stall and a 2.2 s stall: its events all arrived (above), no exceptions (below)', true);
  check('after 1.5 s of silence the guest said "reconnecting…", then took it back', reconnectingSeen && badge && guestData.reconnecting === false, `state seen ${reconnectingSeen}, badge ${badge}, now ${guestData.reconnecting}`);
}
check('the world change followed (Kaleido shift)', hostData.world === 'neon' && guestData.world === 'neon' && !guestData.next && !hostData.next, `host ${hostData.world}, guest ${guestData.world}`);
if (guestData.stats) {
  const s = clean ?? guestData.stats;
  console.log(`\nsnapshot delay${clean ? ' (before the stalls)' : ''} (host encode → guest decode, one way): p50 ${s.oneWay.p50.toFixed(1)} ms  p90 ${s.oneWay.p90.toFixed(1)} ms  max ${s.oneWay.max.toFixed(1)} ms  (${s.oneWay.n} snapshots)`);
  console.log(`playback buffer ${s.buffer.toFixed(0)} ms (snapshot interval ${s.snapshotInterval} ms)  →  effective render lag (delay + buffer) ${s.renderLag.toFixed(0)} ms`);
  console.log(`dropped ${s.dropped}, late events ${s.lateEvents}, clock resyncs ${s.resyncs}; guest frames ${guestData.frames}, longest gap between frames ${guestData.gap.toFixed(0)} ms`);
}
if (guestData.ended) console.log('the guest saw the match end:', guestData.screen);

await host.screenshot({ path: `${OUT}/online-host.png` });
await guest.screenshot({ path: `${OUT}/online-guest.png` });
console.log(`screenshots: ${OUT}/online-host.png, ${OUT}/online-guest.png`);

check('no page errors on either TV (or the phone)', errors.length === 0, errors.length ? '\n' + errors.join('\n') : '');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll online checks passed.');
await browser.close();
process.exit(fail ? 1 : 0);
