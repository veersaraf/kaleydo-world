// Online rooms end to end (cloud/worker.ts under `npx wrangler dev --port 8792`):
//   * the relay's contract, with raw WebSockets: a guest needs a claimed room, the host hears
//     guest-join / guest / guest-leave, JSON goes to guests as {type:'host'}, a binary frame goes
//     to every guest untouched, host-gone when the host's socket closes and guest-join replayed
//     when it comes back, a guest's ping is answered, over-long messages are dropped
//   * the game: a host TV page; a guest TV page that goes title -> Play online -> Join a room, types the
//     code on the keyboard and lands in the lobby; a phone opening the GUEST's QR link is seated on
//     the HOST and listed in the guest's lobby; binary frames host -> guest (one, then 300 at 30 Hz,
//     in order, timed on the one shared clock); a wrong code; the host reloading; the host leaving
//   npx wrangler dev --port 8792 &  then  BASE=http://127.0.0.1:8792 node scripts/room-e2e.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WS = BASE.replace(/^http/, 'ws');
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n, set = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');

// ---------------------------------------------------------------- the relay's contract (raw sockets)
class Sock {
  constructor(url) {
    this.msgs = [];
    this.bins = [];
    this.done = false;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((res) => (this.ws.onopen = () => res(true)));
    this.ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.msgs.push(JSON.parse(ev.data)) : this.bins.push(ev.data));
    this.ws.onclose = () => (this.done = true);
  }
  /** closed: the close event came, or the server's close frame did and this side answered (a hibernating room's socket is not torn down by the runtime, so a Node client stays CLOSING; a browser gets its close event) */
  get closed() {
    return this.done || this.ws.readyState >= 2;
  }
  send(o) {
    this.ws.send(typeof o === 'string' || o instanceof ArrayBuffer ? o : JSON.stringify(o));
  }
  async until(f, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.msgs.find(f);
      if (m) return m;
      await sleep(15);
    }
    return null;
  }
}
{
  const room = rnd(5);
  const key = rnd(24);
  // a guest before any host: no room
  const g0 = new Sock(`${WS}/ws?role=guest&room=${room}&gid=g0g0g0g0&name=Early`);
  check('a guest in a room nobody claimed gets no-room and is closed', !!(await g0.until((m) => m.type === 'no-room')) && (await sleep(200), g0.closed));

  const host = new Sock(`${WS}/ws?role=tv&room=${room}&key=${key}`);
  await host.opened;
  await host.until((m) => m.type === 'hello');
  const g1 = new Sock(`${WS}/ws?role=guest&room=${room}&gid=guest111&name=Ann`);
  await g1.opened;
  const j = await host.until((m) => m.type === 'guest-join' && m.gid === 'guest111');
  check('the host hears guest-join {gid, name}', j?.name === 'Ann', JSON.stringify(j));
  const g2 = new Sock(`${WS}/ws?role=guest&room=${room}&gid=guest222&name=Bo`);
  await g2.opened;
  await host.until((m) => m.type === 'guest-join' && m.gid === 'guest222');

  host.send({ type: 'to-guests', msg: { type: 'room', code: room, pads: [], guests: [] } });
  const r1 = await g1.until((m) => m.type === 'host');
  const r2 = await g2.until((m) => m.type === 'host');
  check('a to-guests message reaches every guest as {type:"host", msg}', r1?.msg?.type === 'room' && r1.msg.code === room && r2?.msg?.type === 'room', JSON.stringify(r1));
  check('a guest never hears a to-pad', g1.msgs.every((m) => m.type === 'host'));

  const bin = new Uint8Array(200).map((_, i) => i);
  host.send(bin.buffer.slice(0));
  await sleep(300);
  const same = (b) => b && b.byteLength === 200 && new Uint8Array(b).every((v, i) => v === i);
  check('a binary frame reaches every guest untouched', g1.bins.length === 1 && g2.bins.length === 1 && same(g1.bins[0]) && same(g2.bins[0]));
  check('the host gets no echo of its frame', host.bins.length === 0 && !host.msgs.some((m) => m.type === 'host'));

  g1.send({ type: 'hello', name: 'Ann' });
  const gm = await host.until((m) => m.type === 'guest');
  check('a guest message reaches the host as {type:"guest", gid, msg}', gm?.gid === 'guest111' && gm.msg?.type === 'hello', JSON.stringify(gm));
  g1.send(JSON.stringify({ type: 'hello', name: 'x'.repeat(5000) }));
  await sleep(300);
  check('a guest message over 4 KB is dropped', host.msgs.filter((m) => m.type === 'guest').length === 1);
  g1.send({ type: 'ping', t: 123 });
  const pong = await g1.until((m) => m.type === 'pong');
  check('a guest’s ping is answered with the relay’s clock', pong?.t === 123 && Number.isFinite(pong.st), JSON.stringify(pong));

  // the pad path is as before: a pad joins the host, not the guests
  const pad = new Sock(`${WS}/ws?role=pad&room=${room}&pid=pad-aaaaaa&name=Cy`);
  await pad.opened;
  const pj = await host.until((m) => m.type === 'pad-join');
  check('a phone still joins the host as a pad (guests aren’t told)', pj?.pid === 'pad-aaaaaa' && !g1.msgs.some((m) => m.type === 'pad-join'));
  host.send({ type: 'to-pad', pid: '*', msg: { type: 'score', line: 'x' } });
  check('to-pad still reaches the phone, not the guests', !!(await pad.until((m) => m.type === 'score')) && !g1.msgs.some((m) => m.type === 'score'));

  // a phone opened from guest111's QR code (&via=): the host is told whose it is, and that guest (only) hears its swing at once
  const vpad = new Sock(`${WS}/ws?role=pad&room=${room}&pid=pad-via001&name=Vi&via=guest111`);
  await vpad.opened;
  const vj = await host.until((m) => m.type === 'pad-join' && m.pid === 'pad-via001');
  check('a phone with &via= is announced to the host with it', vj?.via === 'guest111' && pj?.via === undefined, JSON.stringify(vj));
  vpad.send({ type: 'ori', s: [0, 1, 0], n: [0, 0, 1] });
  vpad.send({ type: 'swing', seq: 1, power: 0.7, spin: 0, peak: 9, age: 30, lat: 20 });
  const echo = await g1.until((m) => m.type === 'pad-echo');
  const hostSwing = await host.until((m) => m.type === 'pad' && m.pid === 'pad-via001' && m.msg.type === 'swing');
  check('the guest it came from gets {type:"pad-echo", pid, msg} for its swing, and the host still gets the swing', echo?.pid === 'pad-via001' && echo.msg.type === 'swing' && echo.msg.power === 0.7 && !!hostSwing, JSON.stringify(echo));
  vpad.send({ type: 'slash', kind: 'slash', dir: 0, power: 0.5, lat: 20 });
  await sleep(300);
  check('…a slash is echoed too, but the orientation stream is not; no other guest hears any of it', g1.msgs.filter((m) => m.type === 'pad-echo').map((m) => m.msg.type).join() === 'swing,slash' && !g2.msgs.some((m) => m.type === 'pad-echo'));
  // (an ordinary phone, and one that names a guest who isn't there, echo nowhere)
  pad.send({ type: 'swing', seq: 1, power: 0.5, spin: 0, peak: 5, age: 10, lat: 10 });
  await sleep(200);
  check('a phone of the host\'s own is echoed to no guest', g1.msgs.filter((m) => m.type === 'pad-echo').length === 2);
  vpad.ws.close();

  // the host drops: guests are told, stay connected; the host comes back and hears of them again
  const before = g1.msgs.length;
  host.ws.close();
  check('the host closing gives every guest host-gone', !!(await g1.until((m) => m.type === 'host-gone')) && !!(await g2.until((m) => m.type === 'host-gone')));
  check('the guests stay connected', !g1.closed && !g2.closed && g1.msgs.length > before);
  const host2 = new Sock(`${WS}/ws?role=tv&room=${room}&key=${key}`);
  await host2.opened;
  await sleep(500);
  const gids = host2.msgs.filter((m) => m.type === 'guest-join').map((m) => m.gid).sort();
  check('the returning host is told of every guest again', gids.join() === 'guest111,guest222', gids.join());
  const g3 = new Sock(`${WS}/ws?role=guest&room=${room}&gid=someone-else&name=Di`);
  await g3.opened;
  await host2.until((m) => m.type === 'guest-join' && m.gid === 'someone-else');
  // a reload: the same gid replaces the old socket, without a guest-leave
  const g1b = new Sock(`${WS}/ws?role=guest&room=${room}&gid=guest111&name=Ann`);
  await g1b.opened;
  await sleep(300);
  check('a guest reloading replaces its old socket quietly', g1.closed && !host2.msgs.some((m) => m.type === 'guest-leave' && m.gid === 'guest111'));
  g2.ws.close();
  const lv = await host2.until((m) => m.type === 'guest-leave' && m.gid === 'guest222');
  check('a guest leaving gives the host guest-leave', !!lv);
  // someone else's key can't take the room, and a stranger can't be a guest without a valid gid
  const thief = new Sock(`${WS}/ws?role=tv&room=${room}&key=${rnd(24)}`);
  check('a guessed code can’t take the room', !!(await thief.until((m) => m.type === 'room-taken')));
  const bad = new Sock(`${WS}/ws?role=guest&room=${room}&gid=a&name=Bad`);
  await sleep(300);
  check('a guest without a proper id is refused', bad.closed);
  for (const s of [host2, g1b, g3, pad, thief]) s.ws.close();
}

// ---------------------------------------------------------------- the game
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const shot = async (page, name) => SHOTS && (await sleep(800), await page.screenshot({ path: `${SHOTS}/${name}.png` }));
const tvPage = async (tag) => {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  p.on('pageerror', (e) => logs.push(`[${tag}] ` + e.message));
  await p.goto(BASE + '/');
  await p.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
  await p.goto(BASE + '/');
  await p.waitForFunction(() => window.kaleido?.link?.online, null, { timeout: 30000 });
  return p;
};
const screenIs = (p, cls) => p.waitForSelector(`.screen.${cls}:not(.leaving)`, { timeout: 8000 }).then(() => true).catch(() => false);
/** title -> menu -> Play online -> Join a room -> the code entry */
const toCodeEntry = async (p) => {
  await p.keyboard.press('Enter'); // the title: any key
  await screenIs(p, 'home');
  for (let i = 0; i < 12; i++) {
    if (((await p.textContent('.hpill.focus').catch(() => '')) || '').includes('Play online')) break;
    await p.keyboard.press(i === 0 ? 'ArrowDown' : 'ArrowRight');
    await sleep(60);
  }
  await p.keyboard.press('Enter');
  if (!(await screenIs(p, 'online'))) return false;
  await p.keyboard.press('ArrowRight');
  await sleep(100);
  await p.keyboard.press('Enter');
  return screenIs(p, 'joincode');
};

const host = await tvPage('host');
const roomInfo = await host.evaluate(() => ({ role: window.kaleido.link.role, room: window.kaleido.link.room }));
check('the cloud TV is a host with a room', roomInfo.role === 'host' && /^[A-Z0-9]{5}$/.test(roomInfo.room), JSON.stringify(roomInfo));
const CODE = roomInfo.room;

const guest = await tvPage('guest');
check('the guest TV reaches the join-a-room screen through Play online', await toCodeEntry(guest));
await shot(guest, '1-code-entry');
await guest.keyboard.type(CODE.slice(0, 3));
await guest.keyboard.press('Backspace');
await guest.keyboard.type(CODE.slice(2));
check('the code fills in from the keyboard', (await guest.$$eval('.rcell b', (bs) => bs.map((b) => b.textContent).join(''))) === CODE);
await guest.keyboard.press('Enter');
check('Enter joins: the guest lobby comes up', await screenIs(guest, 'lobby'));
await guest.waitForSelector('.screen.lobby.in', { timeout: 8000 }).catch(() => null);
const lob = await guest.evaluate(() => ({ head: document.querySelector('.lhead')?.textContent, role: window.kaleido.link.role, room: window.kaleido.link.room, url: window.kaleido.link.joinUrl, cls: document.querySelector('.screen.lobby')?.className }));
check('the lobby says which room', lob.head?.includes(CODE) && lob.role === 'guest' && lob.room === CODE && /lobby in/.test(lob.cls), JSON.stringify(lob));
check('the guest’s QR link opens the HOST’s room', lob.url?.includes('/c?room=' + CODE), lob.url);
check('the host has the guest', await host.waitForFunction(() => window.kaleido.link.guests.length === 1, null, { timeout: 8000 }).then(() => true).catch(() => false), JSON.stringify(await host.evaluate(() => window.kaleido.link.guests)));
check('the host’s join panel says a friend’s TV is watching', await host.waitForFunction(() => /1 friend’s TV watching/.test(document.querySelector('.join .friends')?.textContent || ''), null, { timeout: 5000 }).then(() => true).catch(() => false));

// the guest's own phone opens the guest's QR link and ends up at the host
const padCtx = await browser.newContext(mobile);
await padCtx.addInitScript(phone);
const pad = await padCtx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.goto(lob.url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
const seated = await host.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 }).then(() => true).catch(() => false);
check('a phone that scanned the GUEST’s QR code is seated on the HOST', seated);
const gseats = await guest.evaluate(() => window.kaleido.input.activeSeats.filter((s) => !s.local).length);
check('…and not on the guest TV', gseats === 0, `${gseats} phones there`);
const inLobby = await guest.waitForFunction(() => document.querySelectorAll('.lroster .lcol:first-child .lp').length === 1, null, { timeout: 8000 }).then(() => true).catch(() => false);
const lp = await guest.evaluate(() => [...document.querySelectorAll('.lroster .lcol:first-child .lp')].map((e) => ({ t: e.textContent, c: e.style.getPropertyValue('--c') })));
check('the guest’s lobby lists that phone, in its colour', inLobby && /^#[0-9a-f]{6}$/i.test(lp[0]?.c) && /P1/.test(lp[0]?.t), JSON.stringify(lp));
const tvs = await guest.$$eval('.lroster .lcol:nth-child(2) .lp', (e) => e.map((x) => x.textContent));
check('the lobby lists the TVs, this one marked', tvs.length === 2 && tvs.some((t) => t.includes('you')), JSON.stringify(tvs));
await sleep(500);
await shot(guest, '3-guest-lobby');

// binary frames, host -> guest
await guest.evaluate(() => {
  window.__rx = [];
  window.kaleido.link.onHostMessage = (m) => {
    if (m instanceof ArrayBuffer) {
      const dv = new DataView(m);
      window.__rx.push({ len: m.byteLength, seq: dv.getUint32(0), sent: dv.getFloat64(4), got: Date.now() });
    }
  };
});
await host.evaluate(() => {
  const b = new ArrayBuffer(200);
  const dv = new DataView(b);
  dv.setUint32(0, 0xffff0000);
  dv.setFloat64(4, Date.now());
  window.kaleido.link.toGuests(b);
});
await guest.waitForFunction(() => window.__rx.length >= 1, null, { timeout: 5000 }).catch(() => null);
const one = await guest.evaluate(() => window.__rx[0]);
check('a 200-byte binary frame from the host arrives as an ArrayBuffer of 200 bytes', one?.len === 200 && one.seq === 0xffff0000, JSON.stringify(one));
await guest.evaluate(() => (window.__rx = []));
await host.evaluate(
  () =>
    new Promise((done) => {
      let seq = 0;
      const iv = setInterval(() => {
        const b = new ArrayBuffer(200);
        const dv = new DataView(b);
        dv.setUint32(0, seq++);
        dv.setFloat64(4, Date.now());
        window.kaleido.link.toGuests(b);
        if (seq >= 300) (clearInterval(iv), done(null));
      }, 1000 / 30);
    }),
);
await guest.waitForFunction(() => window.__rx.length >= 300, null, { timeout: 8000 }).catch(() => null);
const rx = await guest.evaluate(() => window.__rx);
const inOrder = rx.every((r, i) => r.seq === i && r.len === 200);
check('300 frames at 30 Hz all arrive, in order', rx.length === 300 && inOrder, `${rx.length} received`);
const lat = rx.map((r) => r.got - r.sent).sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log(`  frame timing host -> guest (one shared clock): min ${lat[0]} ms · median ${q(0.5)} ms · p95 ${q(0.95)} ms · max ${lat[lat.length - 1]} ms`);
const gaps = rx.slice(1).map((r, i) => r.got - rx[i].got);
console.log(`  arrival gaps: mean ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)} ms · max ${Math.max(...gaps)} ms`);
check('the guest’s clock pings are answered', await guest.evaluate(() => Number.isFinite(window.kaleido.link.serverOffset)));

// a message from the guest to the host
await host.evaluate(() => {
  window.__gm = [];
  const prev = window.kaleido.link.onMessage;
  window.kaleido.link.onMessage = (m) => (m.type === 'guest' && window.__gm.push(m), prev(m));
});
await guest.evaluate(() => window.kaleido.link.toHost({ type: 'hello', name: 'Zed' }));
await host.waitForFunction(() => window.__gm.length > 0, null, { timeout: 4000 }).catch(() => null);
const gmsg = await host.evaluate(() => window.__gm[0]);
check('toHost reaches the host’s onMessage as {type:"guest", gid, msg}', gmsg?.msg?.name === 'Zed' && typeof gmsg.gid === 'string', JSON.stringify(gmsg));
check('…and the host’s roster shows the guest’s new name', await guest.waitForFunction(() => document.querySelector('.lroster')?.textContent.includes('Zed'), null, { timeout: 5000 }).then(() => true).catch(() => false));

// a wrong code
const lost = await tvPage('lost');
await toCodeEntry(lost);
await lost.keyboard.type('ZZZZZ');
await lost.keyboard.press('Enter');
check('a wrong code says "No room with that code"', await lost.waitForFunction(() => /No room with that code/.test(document.querySelector('.lhead')?.textContent || ''), null, { timeout: 8000 }).then(() => true).catch(() => false));
check('…and that TV is back to hosting its own room', await lost.waitForFunction(() => window.kaleido.link.role === 'host' && window.kaleido.link.online, null, { timeout: 8000 }).then(() => true).catch(() => false));
await shot(lost, '4-no-room');
await lost.keyboard.press('Enter'); // A: try another code
check('…and Enter goes back to typing a code', await screenIs(lost, 'joincode'));
await lost.keyboard.press('Escape');
check('Escape goes back to Play online', await screenIs(lost, 'online'));
await shot(lost, '2-play-online');
// the pad's own buttons work the code entry too: change letters with up/down, A moves on
await lost.keyboard.press('Enter'); // host card -> main menu
await screenIs(lost, 'home');
await shot(lost, '6-menu-pill');
await lost.close();

// the host reloads: the guest is told, waits, and the room comes back with the guest in it
await host.reload();
await host.waitForFunction(() => window.kaleido?.link?.online, null, { timeout: 30000 });
check('after a host reload the same room is back', (await host.evaluate(() => window.kaleido.link.room)) === CODE);
check('…the guest is listed again', await host.waitForFunction(() => window.kaleido.link.guests.length === 1, null, { timeout: 8000 }).then(() => true).catch(() => false));
check('…and the guest’s lobby is in the room again', await guest.waitForSelector('.screen.lobby.in', { timeout: 8000 }).then(() => true).catch(() => false));

// the host leaves
await host.context().close();
check('the host closing gives the guest "The host left"', await guest.waitForFunction(() => /host left/.test(document.querySelector('.lsub')?.textContent || '') && document.querySelector('.screen.lobby.hostgone'), null, { timeout: 8000 }).then(() => true).catch(() => false));
await shot(guest, '5-host-left');
await guest.keyboard.press('Enter'); // A: back
check('A goes back to Play online, hosting this TV’s own room again', (await screenIs(guest, 'online')) && (await guest.evaluate(() => window.kaleido.link.role === 'host' && window.kaleido.link.room !== 'x')));
await guest.keyboard.press('ArrowRight');
await guest.keyboard.press('Enter');
await guest.keyboard.type(CODE);
await guest.keyboard.press('Enter');
await guest.waitForSelector('.screen.lobby', { timeout: 5000 }).catch(() => null);
await guest.keyboard.press('Escape');
check('Escape in a lobby leaves the room', (await screenIs(guest, 'online')) && (await guest.evaluate(() => window.kaleido.link.role)) === 'host');

// ---- a phone that is already on TV B follows B into A's room (B joined by code) and back when B leaves
{
  const A = await tvPage('move-A');
  const Bt = await tvPage('move-B');
  const roomA = await A.evaluate(() => window.kaleido.link.room);
  const roomB = await Bt.evaluate(() => window.kaleido.link.room);
  const gidB = await Bt.evaluate(() => window.kaleido.link.guestId());
  const ctx = await browser.newContext(mobile);
  await ctx.addInitScript(phone);
  const mp = await ctx.newPage();
  mp.on('pageerror', (e) => logs.push('[move-pad] ' + e.message));
  await mp.goto((await Bt.evaluate(() => window.kaleido.link.joinUrl)).replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
  check('a phone scans TV B’s own QR code and is seated on B', await Bt.waitForFunction(() => window.kaleido.input.padCount > 0, null, { timeout: 20000 }).then(() => true).catch(() => false));
  await sleep(1000);
  await Bt.evaluate(() => {
    window.__toasts = [];
    const el = document.querySelector('.toast');
    new MutationObserver(() => window.__toasts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await mp.evaluate(() => {
    window.__seen = [];
    window.__hellos = 0;
    const bad = () => {
      const net = document.querySelector('.net')?.className || '';
      if (/connecting|offline/.test(net) || document.querySelector('.remote')?.classList.contains('lost')) window.__seen.push(net);
    };
    new MutationObserver(bad).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    const l = window.__padLink;
    const send = l.send.bind(l);
    l.send = (m) => (m.type === 'hello' && window.__hellos++, send(m));
  });
  // B joins A by code
  check('B reaches the code entry', await toCodeEntry(Bt));
  await Bt.keyboard.type(roomA);
  await Bt.keyboard.press('Enter');
  check('B is a guest in A’s lobby', await screenIs(Bt, 'lobby'));
  const onA = await A.waitForFunction((g) => window.kaleido.input.activeSeats.some((s) => !s.local && window.kaleido.link.padVia(s.pid) === g), gidB, { timeout: 15000 }).then(() => true).catch(() => false);
  check('the phone shows up on A, seated with via = B’s gid — nobody rescanned', onA);
  const st = await mp.evaluate(() => ({ room: window.__padLink.room, via: window.__padLink.via, url: location.search, seen: window.__seen, hellos: window.__hellos, status: window.__padLink.status }));
  check('…its link is in A’s room via B, the address bar says so, and it said hello again', st.room === roomA && st.via === gidB && st.url.includes(`room=${roomA}`) && st.hellos >= 1 && st.status === 'online', JSON.stringify(st));
  check('…and its screen never showed a reconnect', st.seen.length === 0, JSON.stringify(st.seen));
  check('…B has no phones of its own now, and toasted no "disconnected"', (await Bt.evaluate(() => window.kaleido.input.activeSeats.filter((s) => !s.local).length)) === 0 && !(await Bt.evaluate(() => window.__toasts)).some((t) => /disconnected/i.test(t)), JSON.stringify(await Bt.evaluate(() => window.__toasts)));
  await sleep(1500);
  // B leaves: its phone goes home
  await Bt.keyboard.press('Escape');
  check('B leaves the lobby and is back at Play online, hosting its own room', (await screenIs(Bt, 'online')) && (await Bt.evaluate(() => window.kaleido.link.role === 'host')) && (await Bt.evaluate(() => window.kaleido.link.room)) === roomB);
  const back = await Bt.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('the phone is back on B (the host sent it home)', back);
  const st2 = await mp.evaluate(() => ({ room: window.__padLink.room, via: window.__padLink.via, url: location.search }));
  check('…its link is in B’s room again, with no via', st2.room === roomB && st2.via === '' && st2.url.includes(`room=${roomB}`) && !st2.url.includes('via='), JSON.stringify(st2));
  check('…and A has no phones left', await A.waitForFunction(() => window.kaleido.input.activeSeats.every((s) => s.local || !s.pid), null, { timeout: 5000 }).then(() => true).catch(() => false));
  // a wrong code: the phone follows, finds nobody, and comes back
  await Bt.keyboard.press('ArrowRight');
  await Bt.keyboard.press('Enter');
  await Bt.keyboard.type('ZZZZZ');
  await Bt.keyboard.press('Enter');
  check('a wrong code: B is back to hosting…', await Bt.waitForFunction(() => /No room with that code/.test(document.querySelector('.lhead')?.textContent || '') && window.kaleido.link.role === 'host', null, { timeout: 10000 }).then(() => true).catch(() => false));
  const stranded = await mp.waitForFunction((r) => window.__padLink.room === r, roomB, { timeout: 15000 }).then(() => true).catch(() => false);
  check('…and its phone, sent to the dead room, comes back by itself', stranded && (await Bt.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 8000 }).then(() => true).catch(() => false)));
  await ctx.close();
  await A.context().close();
  await Bt.context().close();
}

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
if (logs.length) fail++;
console.log(fail ? `\n${fail} checks FAILED` : '\nAll room checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
