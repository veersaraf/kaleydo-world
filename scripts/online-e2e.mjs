// The online match stream end to end: a host TV page plays a tennis match (a simulated phone joined
// to it serves and rallies against the CPU) and streams it; a guest TV page renders the stream.
//
//   BRIDGE=1 node scripts/online-e2e.mjs     the host's toGuests and the guest's onHostMessage are joined
//                                            in-page through a Playwright binding (no relay needed: the
//                                            server just has to serve the game)
//   node scripts/online-e2e.mjs              through the room: the guest joins the host's room by its code
//                                            (npx vite build; npx wrangler dev --port 8794)
//
//   BASE=http://127.0.0.1:8794   where the game is served (wrangler dev, or `node server/server.mjs --dev`)
//   PHONE=0                      CPU against CPU instead of the simulated phone
//   SECONDS=24                   how long the match is played before the checks
//   OUT=dir                      where the screenshots go
//   RUSH=1                       the host's match is a Rush one (the Pace row on the setup screen): checks the guest's
//                                shadow match has cfg.rush too
//
// Checks: same world; the guest's shadow match scores as the host's; the guest's ball is where the
// host's was (compared at the same simulation time, exactly); every match event arrives, in order; a
// 1 s stall on the guest's link and a 2.2 s one (it says "reconnecting…") recover; a Kaleido world
// change follows; no page errors.
import { chromium } from 'playwright-core';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8794';
const BRIDGE = !!process.env.BRIDGE;
const USE_PHONE = process.env.PHONE !== '0';
const SECONDS = Number(process.env.SECONDS || 24);
const RUSH = !!process.env.RUSH;
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
const sendToGuest = (m) => guest.evaluate((x) => window.__fromHost(x), m).catch(() => {});
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
    sendToGuest(m);
  });
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
  // (the way a person does it: the code screen's join, which shows the lobby)
  await guest.evaluate((r) => window.flow.joinRoom(r), room);
  const ok = await guest.waitForFunction(() => window.kaleido.link.role === 'guest', null, { timeout: 8000 }).then(() => true).catch(() => false);
  if (!ok) {
    console.log('SKIP: joinRoom() does not put this TV in the host\'s room yet (the room-join work); run with BRIDGE=1');
    await browser.close();
    process.exit(2);
  }
  await host.waitForFunction(() => window.kaleido.link.guests.length > 0, null, { timeout: 8000 });
}

// a stall on the guest's side of the link: what arrives is held back, then handed over in order
await guest.evaluate(() => {
  const k = window.kaleido;
  const orig = k.link.onHostMessage.bind(k.link);
  let until = 0;
  const q = [];
  k.link.onHostMessage = (m) => (performance.now() < until || q.length ? q.push(m) : orig(m));
  setInterval(() => {
    if (performance.now() >= until) while (q.length) orig(q.shift());
  }, 4);
  window.__stall = (ms) => (until = performance.now() + ms);
});

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
      const sc = m.score;
      window.__hostLog.push({ t: m.t, x: tmp.x, y: tmp.y, z: tmp.z, h: m.ball.holder ? 1 : 0, s0: m.ball.seg.t0, s: `${m.state}|${sc.points}|${sc.games}|${sc.server}|${m.server.id}|${m.rally}|${m.second ? 1 : 0}|${sc.winner}` });
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
  const trail = [];
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
    const sc = m.score;
    if (k.guest.ready) (window.__gState ??= []).push([m.t, Date.now(), `${m.state}|${sc.points}|${sc.games}|${sc.server}|${m.server.id}|${m.rally}|${m.second ? 1 : 0}|${sc.winner}`]);
    m.ballView(m.t, tmp);
    const hold = !!m.ball.holder;
    if (prev && !hold && !prevHold && m.state !== 'intro') {
      const s = Math.hypot(tmp.x - prev.x, tmp.y - prev.y, tmp.z - prev.z);
      window.__maxStep = Math.max(window.__maxStep, s);
      // (a jump is a step no ball could make in the time the frame covered — 130 m/s; a slow frame or a stall's catching up is a long step
      // in a long time. A ball moves 0.8 m in a 60 Hz frame at 50 m/s.)
      if (s > 1.4 && s / Math.max(1e-3, k.guest.dt) > 130) (window.__jumps++, window.__jumpAt.push([Date.now(), s, [prev.x, prev.y, prev.z].map((v) => +v.toFixed(2)), [tmp.x, tmp.y, tmp.z].map((v) => +v.toFixed(2)), m.state, hold, prevHold, +m.t.toFixed(3), trail.slice()]));
    }
    prev = { x: tmp.x, y: tmp.y, z: tmp.z };
    prevHold = hold;
    trail.push(`${m.t.toFixed(3)} ${m.state} ${hold ? 'H' : '-'} ${tmp.x.toFixed(1)},${tmp.y.toFixed(1)},${tmp.z.toFixed(1)}`);
    if (trail.length > 6) trail.shift();
  };
});

// ---------------------------------------------------------------- the match
const started = await host.evaluate(({ usePhone, rush }) => {
  const f = window.flow;
  const k = window.kaleido;
  f.mode = 'quick';
  if (rush) f.settings.rush = true;
  const cfg = f.buildConfig();
  cfg.firstServer = 0;
  if (!usePhone) {
    const ai = cfg.players.find((p) => p.ctrl.kind === 'cpu').ctrl.ai;
    for (const p of cfg.players) p.ctrl = { kind: 'cpu', ai };
  }
  f.beginMatch('plaza', false, cfg);
  return { humans: cfg.players.filter((p) => p.ctrl.kind === 'human').length, world: k.stage.current.def.id };
}, { usePhone: USE_PHONE, rush: RUSH });
console.log(`host started a match (${started.humans} human), world ${started.world}`);
const guestUp = await guest.waitForFunction(() => window.kaleido.guest && window.kaleido.guest.ready, null, { timeout: 15000 }).then(() => true).catch(() => false);
check('the guest built the match from the host\'s `start` and is receiving snapshots', guestUp);
if (!guestUp) {
  console.log(errors.join('\n'));
  await browser.close();
  process.exit(1);
}
{
  const rushOf = (p) => p.evaluate(() => window.kaleido.match.cfg.rush);
  const [a, b] = await Promise.all([rushOf(host), rushOf(guest)]);
  if (RUSH) check('Rush: the host\'s and the guest\'s match.cfg.rush are true', a === true && b === true, `host ${a}, guest ${b}`);
  else check('standard: neither TV\'s match is a Rush one', !a && !b, `host ${a}, guest ${b}`);
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
    // (a smash chance runs the last second before contact in slow motion: sim seconds to contact -> real ms)
    const smooth = (t) => t * t * (3 - 2 * t);
    const realMs = (tl) => {
      if (!k.smashCue) return tl * 1000;
      let ms = 0;
      for (let t = tl; t > 0; t -= 0.01) ms += 10 / (0.36 + 0.64 * smooth(Math.max(0, Math.min(1, (t - 0.3) / 0.95))));
      return ms;
    };
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
        // (as late as the phone can manage: a smash chance's slow motion can begin after the plan is made and stretch a swing planned
        // further ahead into an early one)
        const lead = realMs(me.plan.t - m.t);
        const at = now + lead;
        if (lead <= 480 && lead > 300) {
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
  const all = await host.evaluate((i) => window.__hostLog.slice(i).map((e) => ({ t: e.t, x: e.x, y: e.y, z: e.z, h: e.h, s0: e.s0 })), cursor);
  // (a person's swing heard between frames resolves on the spot: a flight begins at exactly the last frame's time, and the ball
  // at that instant is double-valued — drawn before the hit, and at the racket after it. That frame isn't compared; the last frame waits for the next)
  const log = all.slice(0, -1);
  for (let i = 0; i < log.length; i++) if (all[i + 1].s0 === all[i].t && all[i].s0 !== all[i].t) log[i].a = 1;
  if (!log.length) return;
  const r = await guest.evaluate((log) => {
    const g = window.kaleido.guest;
    const out = { n: 0, max: 0, sum: 0, skipped: 0, consumed: 0 };
    if (!g) return out;
    const tmp = { x: 0, y: 0, z: 0 };
    for (const e of log) {
      if (e.t > g.tR - 0.1) break;
      out.consumed++;
      if (e.h || e.a) continue;
      if (g.ballAtSimTime(e.t, tmp)) {
        const d = Math.hypot(tmp.x - e.x, tmp.y - e.y, tmp.z - e.z);
        if (d > out.max) {
          const ring = g.ring.filter((q) => q.serial > 0 && Math.abs(q.t - e.t) < 0.15).sort((a, b) => a.serial - b.serial);
          out.worst = { t: e.t, d, host: [e.x, e.y, e.z], guest: [tmp.x, tmp.y, tmp.z], ring: ring.map((q) => `#${q.serial} t${q.t.toFixed(4)} seg${q.seg.t0.toFixed(4)} v${q.seg.vx.toFixed(2)},${q.seg.vz.toFixed(2)} warp${q.warp.p}:${q.warp.t0.toFixed(4)}-${q.warp.tc.toFixed(4)} st${q.state} ev[${q.events.map((x) => x.type + '@' + x.t.toFixed(4)).join(',')}]`) };
        }
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
  if (r.max > cmp.max && r.worst) cmp.worst = r.worst;
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
  if (!stall1 && el > SECONDS * 0.3) {
    // (the delay on a healthy link, before we break it)
    clean = await guest.evaluate(() => window.kaleido.guest.stats);
    stall1 = true;
    stallUntil = Date.now() + 1000;
    stalls.push([Date.now(), stallUntil]);
    await guest.evaluate(() => window.__stall(1000));
    console.log('  … stalling the guest\'s link for 1 s');
  }
  if (!shifted && el > SECONDS * 0.5) {
    shifted = true;
    await host.evaluate(() => window.kaleido.stage.setWorld('neon', { transition: true, origin: { x: 0.5, y: 0.5 } }));
    shiftCheckAt = Date.now() + 3500;
    console.log('  … a world change on the host');
  }
  if (!stall2 && el > SECONDS * 0.7) {
    stall2 = true;
    stallUntil = Date.now() + 2200;
    stalls.push([Date.now(), stallUntil]);
    await guest.evaluate(() => window.__stall(2200));
    console.log('  … stalling the guest\'s link for 2.2 s');
  }
  if (stall2 && Date.now() < stallUntil + 100) {
    const s = await guest.evaluate(() => ({ r: window.kaleido.guest?.reconnecting, b: [...document.querySelectorAll('div')].some((d) => d.textContent === 'reconnecting…' && d.children.length === 0) }));
    if (s.r) reconnectingSeen = true;
    if (s.b) badge = true;
  }
}
// let it settle: the link open, the guest caught up, and (if the match is still on) a quiet moment between points
await sleep(3000);
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
// (the guest a moment behind the host's reading: it has every event the host had; the match may have moved on since)
await sleep(1500);
const hostLate = await host.evaluate(() => window.__ev);
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
const encMean = hostData.net.encodeMsTotal / Math.max(1, hostData.net.snapshots);
check('encoding a snapshot takes the host under 0.2 ms (mean; p99 under 1 ms: the page\'s timer ticks 0.1 ms and a busy machine adds GC)', encMean < 0.2 && hostData.enc.p99 < 1, `mean ${(encMean * 1000).toFixed(0)} µs, p99 ${(hostData.enc.p99 * 1000).toFixed(0)} µs`);
check('a rally happened (at least 6 hits, and a point or a long rally)', hits >= 6 && (hostData.ev.includes('point') || hits >= 12), `${hits} hits`);

const gEv = guestData.ev.slice(0, hostData.ev.length);
const inOrder = gEv.join() === hostData.ev.join() && hostLate.join().startsWith(guestData.ev.join());
if (!inOrder) {
  let i = 0;
  while (i < gEv.length && gEv[i] === hostData.ev[i]) i++;
  console.log(`  first difference at ${i}: host ...${hostData.ev.slice(Math.max(0, i - 3), i + 4).join(' ')} | guest ...${gEv.slice(Math.max(0, i - 3), i + 4).join(' ')}`);
}
check('every match event reached the guest, in order', inOrder, inOrder ? `${hostData.ev.length} events` : `host ${hostData.ev.length}, guest ${guestData.ev.length}`);
const kinds = (l, k) => l.filter((e) => e === k).length;
check('…hit / bounce / point / net / whiff counts agree', ['hit', 'bounce', 'point', 'net', 'whiff', 'fault'].every((k) => kinds(hostData.ev, k) === kinds(gEv, k)), ['hit', 'bounce', 'point'].map((k) => `${k} ${kinds(hostData.ev, k)}/${kinds(gEv, k)}`).join(' '));
check('each point event saw the same score on both TVs', hostData.points.join('\n') === guestData.points.slice(0, hostData.points.length).join('\n'), hostData.points.length + ' points');
{
  // the guest's state, frame by frame, against the host's a moment before (the host moves on while the guest catches up)
  const hlog = await host.evaluate(() => window.__hostLog.map((e) => [e.t, e.s]));
  const gst = await guest.evaluate(() => window.__gState);
  let ok = 0;
  let n = 0;
  let j = 0;
  const bad = [];
  for (const [gt, at, gs] of gst) {
    // (while the link is stalled the guest holds what it last heard: nothing to compare)
    if (stalls.some(([a, b]) => at >= a - 100 && at <= b + 600)) continue;
    while (j < hlog.length && hlog[j][0] < gt - 0.12) j++;
    let hit = false;
    for (let i = j; i < hlog.length && hlog[i][0] <= gt + 0.05; i++) if (hlog[i][1] === gs) (hit = true);
    n++;
    if (hit) ok++;
    else if (bad.length < 3) bad.push(`t ${gt.toFixed(3)} ${gs}`);
  }
  check('the guest\'s shadow match is in the host\'s state (score, server, state, rally) at the time it shows (outside the stalls)', n > 300 && ok >= n * 0.995, `${ok} of ${n} frames${bad.length ? '; e.g. ' + bad.join(' / ') : ''}`);
}
console.log(`ball: ${cmp.n} host frames compared at the same simulation time, max ${(cmp.max * 100).toFixed(3)} cm, mean ${((cmp.sum / Math.max(1, cmp.n)) * 1000).toFixed(3)} mm (${cmp.skipped} outside the guest's ring)`);
if (cmp.max >= 0.02 && cmp.worst) console.log('  worst:', JSON.stringify(cmp.worst, null, 1));
check('the guest\'s ball is within 2 cm of the host\'s at the same host time', cmp.n > 300 && cmp.max < 0.02, `max ${(cmp.max * 100).toFixed(3)} cm over ${cmp.n} frames`);
// a step over 1.4 m between two frames is only allowed at a hit or a bounce (the ball changes line there, on the host too), or when a long
// stall ended: the guest's picture stood still while the link was down and, past half a second, catches up in one jump
const explained = (j) =>
  stalls.some(([a, b]) => j[0] >= a && j[0] <= b + 700) ||
  guestData.evAt.some(([t, at]) => Math.abs(at - j[0]) < 80 && ['hit', 'toss', 'point', 'state', 'bounce', 'net', 'let', 'fault'].includes(t));
const stray = guestData.jumpAt.filter((j) => !explained(j));
for (const j of stray) console.log('  stray step', j[1].toFixed(2), 'm', JSON.stringify(j.slice(2)), '; events around it:', guestData.evAt.filter(([, at]) => Math.abs(at - j[0]) < 400).map(([t, at]) => `${t}@${at - j[0]}`).join(' '), '; stalls', stalls.map(([x, y]) => `${x - j[0]}..${y - j[0]}`).join(' '));
check('the ball never teleported on the guest (a step over 1.4 m in a frame) except at a hit or a bounce, or where a long stall ended', stray.length === 0, `${guestData.jumps} big steps, ${guestData.jumps - stray.length} at a stall's end${guestData.jumps ? ' (' + guestData.jumpAt.map((j) => j[1].toFixed(1) + ' m').join(', ') + ')' : ''}; otherwise the largest step is a frame's worth of ball (${guestData.maxStep.toFixed(2)} m max)`);
{
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

// ---------------------------------------------------------------- the end of a match, and the way back
if (process.env.END !== '0') {
  console.log('\nplaying a one-game CPU match through to its end (a rematch: a second `start`)…');
  await guest.evaluate(() => ((window.__ev = []), (window.__points = [])));
  await host.evaluate(() => {
    const f = window.flow;
    const k = window.kaleido;
    f.mode = 'quick';
    const cfg = f.buildConfig();
    const ai = k.match.players.find((p) => !p.human).ctrl.ai;
    cfg.players = cfg.players.map((p) => ({ ...p, ctrl: { kind: 'cpu', ai } }));
    cfg.gamesToWin = 1;
    cfg.introTime = 0.8;
    cfg.firstServer = 1;
    window.__ev = [];
    window.__points = [];
    f.beginMatch('park', false, cfg);
  });
  const t1 = Date.now();
  const over = await host.waitForFunction(() => window.kaleido.match?.state === 'over', null, { timeout: 240000, polling: 500 }).then(() => true).catch(() => false);
  check('the second match ran to its end', over, `${((Date.now() - t1) / 1000).toFixed(0)} s`);
  const results = await guest.waitForFunction(() => document.querySelector('.results .winner'), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('the guest\'s results screen came up', results);
  if (!results) {
    const d = await guest.evaluate(() => { const g = window.kaleido.guest; return g && { tR: g.tR, serial: g.serial, newest: g.ring[g.serial % 128].t, wall: g.ring[g.serial % 128].wall, wR: g.wR, ended: g.ended, reconnecting: g.reconnecting, timeline: g.timeline.length, pending: g.pending.length, state: g.match.state, stats: g.stats, screen: window.flow.screen?.name }; });
    const hd = await host.evaluate(() => ({ t: window.kaleido.match.t, state: window.kaleido.match.state, snaps: window.kaleido.net.stats.snapshots }));
    console.log('  guest', JSON.stringify(d), 'host', JSON.stringify(hd));
  }
  const rs = await guest.evaluate(() => ({ winner: document.querySelector('.results .winner')?.textContent, final: document.querySelector('.results .final')?.textContent, stats: [...document.querySelectorAll('.results .stats b')].map((b) => b.textContent).join(' '), world: window.kaleido.stage.current.def.id }));
  const hs = await host.evaluate(() => ({ games: window.kaleido.match.score.games, winner: window.kaleido.match.score.winner, names: window.kaleido.match.score.names, ev: window.__ev, points: window.__points }));
  check('…it names the winner and the games as the host has them', rs.winner === `${hs.names[hs.winner]} wins!` && rs.final === `${hs.games[0]} – ${hs.games[1]}`, `${rs.winner} ${rs.final} (host ${hs.games})`);
  const gev = await guest.evaluate(() => window.__ev);
  check('…every event of the second match arrived, in order', gev.join() === hs.ev.join(), `${hs.ev.length} events`);
  check('…and the second match was in the host\'s new world', rs.world === 'park', rs.world);
  await guest.screenshot({ path: `${OUT}/online-guest-results.png` });
  await guest.evaluate(() => window.flow.button(0, 'a'));
  await sleep(700);
  const back = await guest.evaluate(() => ({ screen: window.flow.screen?.name, hud: !!document.querySelector('.hud .scorebug'), lobby: document.querySelector('.screen.lobby')?.className }));
  check(BRIDGE ? 'Back on the results goes to the main menu' : 'Back on the results goes back to the room\'s lobby', BRIDGE ? back.screen === 'menu' : back.screen === 'guest-lobby' && /lobby in/.test(back.lobby || ''), JSON.stringify(back));
}

check('no page errors on either TV (or the phone)', errors.length === 0, errors.length ? '\n' + errors.join('\n') : '');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll online checks passed.');
await browser.close();
process.exit(fail ? 1 : 0);
