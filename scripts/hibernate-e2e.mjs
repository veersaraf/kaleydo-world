// Hibernation end to end (cloud/worker.ts, cloud/lobby.ts under `npx wrangler dev --var DEV:1`): an idle room costs nothing.
//
//   npx vite build && npx wrangler dev --port 8805 --var DEV:1 &     then     BASE=http://127.0.0.1:8805 node scripts/hibernate-e2e.mjs
//   (add `--var HIBERNATE_DEBUG:1` to wrangler and DEBUG=1 here: every handler then rebuilds the room from storage and the sockets'
//    attachments, as after an eviction, so the whole run proves the object needs no memory between two events)
//   IDLE_S=60 (the silent window), SETTLE_S=65 (how long the clients are given to go quiet after the join: the TV pings for 60 s after
//   a phone joined, the phone for 30 s after it loaded)
//
// The room counts every message its handlers receive (DEV only: /api/room-stats?room=CODE). Messages the runtime answers itself (the
// exact text `ka`) never reach a handler, so they aren't counted. Checked:
//   * raw sockets: `ka` is answered with `ka` and isn't counted; a ping is answered with a clock stamp and is
//   * a TV and a phone parked on the home screen: after the settle time, the room receives NOTHING for IDLE_S seconds (0 messages),
//     both clients did send their keepalive and hear it answered, and both are still connected
//   * waking: a match starts and the phone's pings resume (the burst), a swing arrives with its age still right, the TV (which
//     hears the swing) pings again, the clock offsets are finite
//   * a TV waiting in the Quick match lobby costs the lobby no messages, and the queue is still there afterwards
import { chromium } from 'playwright-core';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8805';
const WS = BASE.replace(/^http/, 'ws');
const IDLE_S = +(process.env.IDLE_S || 60);
const SETTLE_S = +(process.env.SETTLE_S || 65);
const DEBUG = !!process.env.DEBUG;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n, set = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
const stats = async (room) => {
  const r = await fetch(`${BASE}/api/room-stats?room=${room}`);
  if (!r.ok) throw new Error(`room-stats ${r.status}: run wrangler with --var DEV:1`);
  return r.json();
};
const delta = (a, b) => {
  const t = {};
  for (const k of new Set([...Object.keys(a.types), ...Object.keys(b.types)])) if ((b.types[k] || 0) - (a.types[k] || 0)) t[k] = (b.types[k] || 0) - (a.types[k] || 0);
  return t;
};

// ---------------------------------------------------------------- raw sockets: the auto-response
{
  const room = rnd(5);
  const key = rnd(24);
  const got = [];
  const tv = new WebSocket(`${WS}/ws?role=tv&room=${room}&key=${key}`);
  tv.onmessage = (e) => got.push(String(e.data));
  await new Promise((r) => (tv.onopen = r));
  await sleep(300);
  const s0 = await stats(room);
  check('the room counts its messages (DEV): a fresh room has seen none', s0.msgs === 0, JSON.stringify(s0));
  for (let i = 0; i < 5; i++) tv.send('ka');
  await sleep(500);
  const s1 = await stats(room);
  check('`ka` is answered `ka`, five times', got.filter((m) => m === 'ka').length === 5, JSON.stringify(got.map((m) => m.slice(0, 12))));
  check('…and none of them reached a handler (the object was not woken for them)', s1.msgs === 0, JSON.stringify(s1.types));
  tv.send(JSON.stringify({ type: 'ping', t: 42 }));
  await sleep(300);
  const pong = got.map((m) => (m[0] === '{' ? JSON.parse(m) : null)).find((m) => m?.type === 'pong');
  check('a timed ping is answered with the relay’s clock', pong?.t === 42 && Math.abs(pong.st - Date.now()) < 5000, JSON.stringify(pong));
  check('…and does count (it needs the object)', (await stats(room)).types.ping === 1);
  tv.send('not json at all');
  await sleep(200);
  check('text that is neither `ka` nor JSON is ignored, the socket lives', tv.readyState === 1);
  tv.close();
}

// ---------------------------------------------------------------- a TV and a phone, parked
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];
// (what each page's sockets send and hear: the keepalive, counted)
const spy = () => {
  window.__ka = { sent: 0, heard: 0, sockets: 0 };
  const Orig = window.WebSocket;
  const send = Orig.prototype.send;
  Orig.prototype.send = function (d) {
    if (d === 'ka') window.__ka.sent++;
    return send.call(this, d);
  };
  const add = Orig.prototype.addEventListener;
  const wrap = function (url, protocols) {
    const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
    window.__ka.sockets++;
    add.call(ws, 'message', (e) => {
      if (e.data === 'ka') window.__ka.heard++;
    });
    return ws;
  };
  wrap.prototype = Orig.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) wrap[k] = Orig[k];
  window.WebSocket = wrap;
};
const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await tvCtx.addInitScript(spy);
const tv = await tvCtx.newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => window.kaleido?.link?.online, null, { timeout: 30000 });
const info = await tv.evaluate(() => ({ room: window.kaleido.link.room, url: window.kaleido.link.joinUrl }));
const room = info.room;

const padCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await padCtx.addInitScript(phone);
await padCtx.addInitScript(spy);
const pad = await padCtx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.goto(info.url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
const joined = await tv.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 }).then(() => true).catch(() => false);
check('the phone joined the TV', joined);
await pad.waitForSelector('.panel.menu.on', { timeout: 15000 }).catch(() => null);
const padMode = await pad.evaluate(() => document.querySelector('.panel.on')?.className || '');
check('the phone sits in a menu', /menu/.test(padMode), padMode);

console.log(`  parked on the home screen: ${SETTLE_S} s for the pings to stop, then ${IDLE_S} s of silence…`);
await sleep(SETTLE_S * 1000);
const before = await stats(room);
const kaBefore = [await tv.evaluate(() => ({ ...window.__ka })), await pad.evaluate(() => ({ ...window.__ka }))];
await sleep(IDLE_S * 1000);
const after = await stats(room);
const kaAfter = [await tv.evaluate(() => ({ ...window.__ka })), await pad.evaluate(() => ({ ...window.__ka }))];
const d = after.msgs - before.msgs;
check(`the room received 0 messages in ${IDLE_S} s with a TV on the home screen and a phone in a menu`, d === 0, `${d} messages ${JSON.stringify(delta(before, after))}`);
check('the TV sent its keepalive in that time, and heard it answered', kaAfter[0].sent > kaBefore[0].sent && kaAfter[0].heard > kaBefore[0].heard, JSON.stringify([kaBefore[0], kaAfter[0]]));
check('the phone sent its keepalive in that time, and heard it answered', kaAfter[1].sent > kaBefore[1].sent && kaAfter[1].heard > kaBefore[1].heard, JSON.stringify([kaBefore[1], kaAfter[1]]));
check('both are still connected (the same one socket each: no reconnects)', (await tv.evaluate(() => window.kaleido.link.online && window.__ka.sockets)) === 1 && (await pad.evaluate(() => window.__ka.sockets)) === 1);
check('…and the TV still has the phone seated', await tv.evaluate(() => window.kaleido.input.activeSeats.filter((s) => !s.local).length === 1));
if (DEBUG) check('(debug run) every handler rebuilt the room from storage and attachments', after.debug === true, JSON.stringify(after));
console.log(`  (room stats: ${JSON.stringify({ msgs: after.msgs, wakes: after.wakes, types: after.types })})`);

// ---------------------------------------------------------------- waking: a match
const m0 = await stats(room);
await tv.evaluate(() => {
  window.__sw = 0;
  window.__ages = [];
  const prev = window.kaleido.input.onSwing;
  window.kaleido.input.onSwing = (e) => (window.__sw++, window.__ages.push(e.age), prev(e));
  window.flow.beginBaseball({ world: 'park', cpu: -1, pitching: 0.2, pitches: 3 });
});
await pad.waitForSelector('.panel.play.bat.on', { timeout: 15000 }).catch(() => null);
await sleep(2500);
const m1 = await stats(room);
const dm = delta(m0, m1);
check('a match starts: the phone’s pings resume (its burst of four, then every 2 s)', (dm.ping || 0) >= 4, JSON.stringify(dm));
const padOff = await pad.evaluate(() => window.__padLink.clockOffset);
const tvOff = await tv.evaluate(() => window.kaleido.link.serverOffset);
check('the clock offsets are finite (measured again)', Number.isFinite(padOff) && Number.isFinite(tvOff), `pad ${padOff} ms, tv ${tvOff} ms`);
await pad.evaluate(() => window.__phone.tennis({ inMs: 400 }));
const swung = await tv.waitForFunction(() => window.__sw > 0, null, { timeout: 6000 }).then(() => true).catch(() => false);
check('a swing after the long sleep reaches the TV', swung);
const ages = await tv.evaluate(() => window.__ages);
check('…with an age in (0, 0.16] s', ages.length > 0 && ages.every((a) => a > 0 && a <= 0.16), ages.map((a) => a.toFixed(3)).join(' '));
await sleep(2500);
const m2 = await stats(room);
check('the TV heard the swing and is active again: its own burst of four pings on top of the phone’s one', (delta(m1, m2).ping || 0) >= 5, JSON.stringify(delta(m1, m2)));

// ---------------------------------------------------------------- the lobby
{
  const q0 = await (await fetch(`${BASE}/mm/stats`)).json();
  const lobby = new WebSocket(`${WS}/mm?room=${rnd(5)}&key=${rnd(24)}&gid=${rnd(10, 'abcdefghijklmnop')}&name=Idle&players=1`);
  const heard = [];
  lobby.onmessage = (e) => e.data !== 'ka' && heard.push(JSON.parse(e.data));
  await new Promise((r) => (lobby.onopen = r));
  await sleep(500);
  const q1 = await (await fetch(`${BASE}/mm/stats`)).json();
  check('a TV waiting in the lobby is in the queue (storage)', q1.queue === q0.queue + 1, JSON.stringify([q0, q1]));
  check('…and was told it is waiting', heard.some((m) => m.type === 'waiting' && m.n >= 1));
  lobby.send('ka');
  await sleep(200);
  check('…the queue survives a keepalive', (await (await fetch(`${BASE}/mm/stats`)).json()).queue === q1.queue);
  // (the only thing that wakes the lobby while it waits: its alarm — at the 20 s a waiting TV takes anyone, then the 30 s heartbeat)
  const beat = await (async () => {
    for (let i = 0; i < 300 && !heard.some((m) => m.type === 'waiting' && m.t >= 15); i++) await sleep(100);
    return heard.find((m) => m.type === 'waiting' && m.t >= 15);
  })();
  check('…its alarm woke the lobby at ~20 s and it told this TV how the queue stands', !!beat && beat.n >= 1, JSON.stringify(beat));
  lobby.close();
  await sleep(500);
  check('…and its leaving empties it', (await (await fetch(`${BASE}/mm/stats`)).json()).queue === q0.queue);
}

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll hibernation checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
