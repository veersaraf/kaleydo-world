// Quick match end to end (cloud/lobby.ts + the flow), against the cloud build under wrangler dev:
//   npx vite build && npx wrangler dev --port 8801 &     then     BASE=http://127.0.0.1:8801 node scripts/mm-e2e.mjs
//   (MM_PORT=8803 picks another port for the default BASE)
//   SHOTS=dir   keeps a few screenshots
//
//   * the lobby's contract, with raw sockets: bad requests are refused, two waiting sockets are matched with exactly the
//     messages {matched, role:'host', peer} / {matched, role:'guest', code, peer} and both are closed, a third waits alone
//   * the game: TV "host" and TV "guest", each with a simulated phone, choose Play online -> Quick match (the host first):
//     both are matched within a few seconds; the guest's TV joins the host's room and its phone scans the new QR code; the host
//     auto-starts a singles match (its phone vs the guest's phone); the guest's phone was connected to the guest TV BEFORE
//     the pairing and is never rescanned: the guest TV sends it a 'move' and it follows to the host's room (still "joined": no
//     reconnecting bar, no disconnect toast on the guest TV); the guest renders it from its own end (rig.side = 1) in the
//     same world; the two phones rally for ~8 s with every event reaching the guest; the match is ended (a hook: one point
//     from the end of a one-game match); both show results with the same winner; host: Play again (A) -> a second match on
//     both; then Leave (B) -> the host is back at Play online and the guest is sent home
//   * a TV without a phone can't start a quick match; a TV that waits alone sees "Looking for an opponent…", a running clock,
//     and cancels with B: the lobby's queue empties
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.MM_PORT || 8801}`;
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
const queueLen = async () => (await (await fetch(`${BASE}/mm/stats`)).json()).queue;
const until = async (f, ms = 8000, step = 50) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await f()) return true;
    await sleep(step);
  }
  return false;
};

// ---------------------------------------------------------------- the lobby's contract (raw sockets)
class Sock {
  constructor(url) {
    this.msgs = [];
    this.done = false;
    this.status = null;
    this.ws = new WebSocket(url);
    this.opened = new Promise((res) => (this.ws.onopen = () => res(true)));
    this.ws.onmessage = (ev) => this.msgs.push(JSON.parse(ev.data));
    this.ws.onclose = () => (this.done = true);
    this.ws.onerror = () => (this.failed = true);
  }
  /** closed: the close event came, or the server's close frame did and this side answered (a hibernating object's socket is not torn down by the runtime, so a Node client stays CLOSING; a browser gets its close event) */
  get closed() {
    return this.done || this.ws.readyState >= 2;
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
  const q = (o) => new URLSearchParams(o).toString();
  const good = (room, gid, extra = {}) => `${WS}/mm?${q({ room, key: rnd(24), gid, name: 'Raw' + gid.slice(3, 4), players: 1, ...extra })}`;
  // refused: a bad room, a short key, no gid
  const refused = [
    `${WS}/mm?${q({ room: 'ab', key: rnd(24), gid: 'gidgidgid' })}`,
    `${WS}/mm?${q({ room: rnd(5), key: 'short', gid: 'gidgidgid' })}`,
    `${WS}/mm?${q({ room: rnd(5), key: rnd(24), gid: 'x' })}`,
  ].map((u) => new Sock(u));
  await sleep(600);
  check('bad requests (room, key, gid) are refused', refused.every((s) => s.failed && !s.msgs.length));
  const plain = await fetch(`${BASE}/mm`);
  check('/mm without a websocket upgrade is 426', plain.status === 426);
  check('the queue starts empty', (await queueLen()) === 0);

  const roomA = rnd(5);
  const roomB = rnd(5);
  const a = new Sock(good(roomA, 'rawaaaaaa'));
  await a.opened;
  const w0 = await a.until((m) => m.type === 'waiting');
  check('a TV that arrives alone is told it is waiting', w0?.n === 1 && w0.t === 0, JSON.stringify(w0));
  check('…and is in the queue', (await queueLen()) === 1);
  await sleep(150);
  const b = new Sock(good(roomB, 'rawbbbbbb'));
  await b.opened;
  const ma = await a.until((m) => m.type === 'matched');
  const mb = await b.until((m) => m.type === 'matched');
  check('the earlier TV is told to host: {matched, role:"host", peer:{gid,name}}', ma?.role === 'host' && ma.peer?.gid === 'rawbbbbbb' && ma.peer.name === 'Rawb' && ma.code === undefined, JSON.stringify(ma));
  check('the later TV is told to join the host’s room: {matched, role:"guest", code, peer}', mb?.role === 'guest' && mb.code === roomA && mb.peer?.gid === 'rawaaaaaa' && mb.peer.name === 'Rawa', JSON.stringify(mb));
  await sleep(300);
  check('both sockets are closed after the match message, and the queue is empty', a.closed && b.closed && (await queueLen()) === 0);
  const c = new Sock(good(rnd(5), 'rawcccccc'));
  await c.opened;
  await c.until((m) => m.type === 'waiting');
  check('a third TV waits alone', (await queueLen()) === 1 && !c.msgs.some((m) => m.type === 'matched'));
  c.ws.close();
  check('a socket closing takes its TV out of the queue', await until(async () => (await queueLen()) === 0, 2000));
  // the same TV twice (a second press): the newer socket replaces the older
  const d1 = new Sock(good(rnd(5), 'rawdddddd'));
  await d1.opened;
  const d2 = new Sock(good(rnd(5), 'rawdddddd'));
  await d2.opened;
  await sleep(300);
  check('the same TV asking twice is queued once (the old socket is closed)', d1.closed && (await queueLen()) === 1);
  d2.ws.close();
  await until(async () => (await queueLen()) === 0, 2000);
}

// ---------------------------------------------------------------- the game
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) errors.push(`[${name} console] ${m.text()}`);
  });
};
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const shot = async (page, name) => SHOTS && (await sleep(500), await page.screenshot({ path: `${SHOTS}/${name}.png` }));
const tvPage = async (tag, size = { width: 1280, height: 720 }) => {
  const p = await (await browser.newContext({ viewport: size })).newPage();
  watch(p, tag);
  await p.goto(BASE + '/');
  await p.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 1 })));
  await p.goto(BASE + '/');
  await p.waitForFunction(() => window.kaleido?.link?.online && window.flow, null, { timeout: 60000 });
  return p;
};
const screenIs = (p, cls, ms = 8000) => p.waitForSelector(`.screen.${cls}:not(.leaving)`, { timeout: ms }).then(() => true).catch(() => false);
const toOnline = async (p) => {
  await p.keyboard.press('Enter'); // the title: any key
  await screenIs(p, 'home');
  for (let i = 0; i < 12; i++) {
    if (((await p.textContent('.hpill.focus').catch(() => '')) || '').includes('Play online')) break;
    await p.keyboard.press(i === 0 ? 'ArrowDown' : 'ArrowRight');
    await sleep(60);
  }
  await p.keyboard.press('Enter');
  return screenIs(p, 'online');
};
/** on Play online: to the third card, and press it */
const pressQuick = async (p) => {
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  await sleep(120);
  await p.keyboard.press('Enter');
};
const phoneFor = async (tv, tag) => {
  const ctx = await browser.newContext(mobile);
  await ctx.addInitScript(phone);
  const pad = await ctx.newPage();
  watch(pad, tag);
  const url = await tv.evaluate(() => window.kaleido.link.joinUrl);
  await pad.goto(url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
  const ok = await tv.waitForFunction(() => window.kaleido.input.padCount > 0, null, { timeout: 20000 }).then(() => true).catch(() => false);
  return { pad, ok };
};

const A = await tvPage('A-host');
const B = await tvPage('B-guest', { width: 960, height: 540 });
check('both TVs reach Play online', (await toOnline(A)) && (await toOnline(B)));
await shot(A, '1-online-cards');

// no phone, no quick match
await pressQuick(B);
await sleep(600);
check('without a phone, Quick match stays on Play online (and says so)', (await screenIs(B, 'online', 1500)) && !(await B.evaluate(() => window.kaleido.link.searching)) && (await queueLen()) === 0);
check('…the card itself says it needs a phone', /needs a phone/i.test((await B.textContent('.onote')) || ''));
await B.keyboard.press('ArrowLeft');
await B.keyboard.press('ArrowLeft');

const pA = await phoneFor(A, 'padA');
const pB = await phoneFor(B, 'padB');
check('each TV has its phone', pA.ok && pB.ok);
if (!pA.ok || !pB.ok) {
  await browser.close();
  process.exit(1);
}
await sleep(1200);
const hostName = await A.evaluate(() => window.kaleido.link.guestName);
const guestName = await B.evaluate(() => window.kaleido.link.guestName);
const roomA = await A.evaluate(() => window.kaleido.link.room);

// what each TV records: the match events (in order), for the comparison at the end
const record = () => {
  window.__ev = [];
  const k = window.kaleido;
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    if (!k.attract && (k.guest || k.link.role === 'host')) window.__ev.push(e.type + (e.type === 'state' ? ':' + e.state : ''));
    oe(e);
  };
};
await A.evaluate(record);
await B.evaluate(record);
// B's toasts (everything the toast element ever said) and, on B's phone, every moment its screen showed a reconnect
await B.evaluate(() => {
  window.__toasts = [];
  const el = document.querySelector('.toast');
  new MutationObserver(() => window.__toasts.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
});
await pB.pad.evaluate(() => {
  window.__seen = [];
  const bad = () => {
    const net = document.querySelector('.net')?.className || '';
    const lost = document.querySelector('.remote')?.classList.contains('lost');
    if (/connecting|offline/.test(net) || lost) window.__seen.push(`${net} lost=${lost}`);
  };
  new MutationObserver(bad).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  window.__padHello = 0;
  const l = window.__padLink;
  const send = l.send.bind(l);
  l.send = (m) => (m.type === 'hello' && window.__padHello++, send(m));
});

// ---- A presses Quick match first, then B
await A.bringToFront();
await pressQuick(A);
check('A: the waiting screen — "Looking for an opponent…"', (await screenIs(A, 'quick')) && /Looking for an opponent/.test((await A.textContent('.qhead')) || ''));
check('A: the lobby has A in its queue', await until(async () => (await queueLen()) === 1, 3000));
await shot(A, '2-waiting');
await sleep(1100);
check('A: the clock runs', /^0:0[1-9]/.test((await A.textContent('.qtimer')) || ''), await A.textContent('.qtimer'));
const tPress = Date.now();
// (B's phone follows its TV at once now, so these screens are only up for a moment: sample what they say)
for (const p of [A, B])
  await p.evaluate(() => {
    window.__said = new Set();
    setInterval(() => {
      for (const sel of ['.qhead', '.qsub', '.lsub', '.lstatus']) {
        const t = document.querySelector(sel)?.textContent;
        if (t) window.__said.add(t);
      }
    }, 15);
  });
await pressQuick(B);
const gotA = await A.waitForFunction(() => window.flow.mm?.role === 'host', null, { timeout: 8000 }).then(() => true).catch(() => false);
const gotB = await B.waitForFunction(() => window.flow.mm?.role === 'guest' && window.kaleido.link.role === 'guest', null, { timeout: 8000 }).then(() => true).catch(() => false);
const tMatched = Date.now() - tPress;
if (!(gotA && gotB)) console.log('  diag', await A.evaluate(() => [window.flow.screen?.name, window.flow.mm?.role, window.kaleido.link.searching]), await B.evaluate(() => [window.flow.screen?.name, window.flow.mm?.role, window.kaleido.link.searching, window.kaleido.link.role]), await queueLen());
check('both TVs are matched within 3 s of the second press', gotA && gotB && tMatched < 3000, `${tMatched} ms`);
console.log(`  time to match: ${tMatched} ms`);
check('the first to press hosts (A), the other is a guest in A’s room', (await A.evaluate(() => window.flow.mm.role + window.kaleido.link.role)) === 'hosthost' && (await B.evaluate(() => window.kaleido.link.room)) === roomA);
await sleep(400);
{
  const [sa, sb] = [await A.evaluate(() => [...window.__said]), await B.evaluate(() => [...window.__said])];
  check('A: "Found <name>!" (and, until the phone is seated, "Waiting for their phone…")', sa.includes(`Found ${guestName}!`), JSON.stringify(sa.slice(-4)));
  check('B: the guest lobby says "Matched with <A>!" and asks for a phone', sb.some((t) => new RegExp(`Matched with ${hostName}!`).test(t)), JSON.stringify(sb.slice(-4)));
}
check('the lobby’s queue is empty again', (await queueLen()) === 0);
await shot(A, '3-found');
await shot(B, '4-guest-lobby');
check('A’s guest list has B (it is in A’s room)', await A.waitForFunction(() => window.kaleido.link.guests.length === 1, null, { timeout: 5000 }).then(() => true).catch(() => false));

// ---- B’s phone was on B before the pairing: it follows B to A’s room by itself (no rescan)
const viaUrl = await B.evaluate(() => window.kaleido.link.joinUrl);
check('B’s QR link would open A’s room with B’s id', viaUrl.includes(`room=${roomA}`) && /via=[a-z0-9]+/.test(viaUrl), viaUrl);
const gidB = await B.evaluate(() => window.kaleido.link.guestId());
const tPhone = Date.now();

// ---- the host starts by itself
const started = await A.waitForFunction(() => window.kaleido.match && !window.kaleido.attract && window.flow.mm?.phase === 'play', null, { timeout: 20000 }).then(() => true).catch(() => false);
check('the host auto-starts a match once the guest’s phone is seated', started, `${Date.now() - tPhone} ms after the pairing`);
{
  const st = await pB.pad.evaluate(() => ({ room: window.__padLink.room, via: window.__padLink.via, url: location.search, seen: window.__seen, status: window.__padLink.status, hellos: window.__padHello }));
  check('B’s phone moved by itself: its link is now in A’s room, via B’s gid, and its address bar says so', st.room === roomA && st.via === gidB && st.url.includes(`room=${roomA}`) && st.url.includes(`via=${gidB}`) && st.status === 'online', JSON.stringify(st));
  check('…and never showed the reconnecting bar / offline status / lost state (and said hello again to A)', st.seen.length === 0 && st.hellos >= 1, JSON.stringify(st.seen));
  const toasts = await B.evaluate(() => window.__toasts);
  check('B (the guest TV) never toasted a "disconnected" remote', !toasts.some((t) => /disconnected/i.test(t)), JSON.stringify(toasts));
  check('B has no phones of its own left (its phone plays on the host)', (await B.evaluate(() => window.kaleido.input.activeSeats.filter((s) => !s.local).length)) === 0);
}
const guestUp = await B.waitForFunction(() => window.kaleido.guest && window.kaleido.guest.ready, null, { timeout: 15000 }).then(() => true).catch(() => false);
check('the guest is in the match (kaleido.guest set, receiving snapshots)', guestUp);
if (!started || !guestUp) {
  console.log(errors.join('\n'));
  await browser.close();
  process.exit(1);
}
const info = async (p) =>
  p.evaluate(() => {
    const k = window.kaleido;
    const m = k.match;
    return { world: k.stage.current.def.id, players: m.players.map((q) => `${q.team}:${q.name}:${q.human ? 'H' : 'C'}`), names: [...m.score.names], gamesToWin: m.score.gamesToWin, doubles: m.doubles, side: k.rig.side };
  });
const [ia, ib] = [await info(A), await info(B)];
check('a singles match of two people, one game to win (the settings)', ia.players.length === 2 && ia.players.every((p) => p.endsWith(':H')) && ia.players[0].startsWith('0:') && ia.players[1].startsWith('1:') && ia.gamesToWin === 1 && !ia.doubles, JSON.stringify(ia.players));
check('the guest’s players, names and world are the host’s', JSON.stringify(ia.players) === JSON.stringify(ib.players) && ia.world === ib.world && JSON.stringify(ia.names) === JSON.stringify(ib.names), `${ia.world} / ${ib.world} ${ia.names}`);
check('the guest looks from its own player’s end (rig.side = 1), the host from its own (0)', ib.side === 1 && ia.side === 0, `${ia.side} / ${ib.side}`);
// team 0 = A's phone, team 1 = B's phone
const seatsOk = await A.evaluate(() => {
  const k = window.kaleido;
  const l = k.link;
  const slotOf = (t) => k.match.players.find((p) => p.team === t).ctrl.slot;
  const s0 = k.input.seats[slotOf(0)];
  const s1 = k.input.seats[slotOf(1)];
  return { own: !l.padVia(s0.pid), via: l.padVia(s1.pid) === l.guests[0].gid };
});
check('team 0 is the host’s own phone, team 1 the phone opened from the guest’s QR code', seatsOk.own && seatsOk.via, JSON.stringify(seatsOk));
await shot(A, '5-host-match');
await shot(B, '6-guest-match');

// ---- the two phones rally (the swing driver of online-e2e, for two people)
await A.exposeFunction('__swingAt', (i, at) => {
  (i ? pB.pad : pA.pad).evaluate((a) => window.__phone.tennis({ at: a }), at).catch(() => {});
});
await A.exposeFunction('__tap', (i) => {
  (i ? pB.pad : pA.pad)
    .evaluate(() => document.querySelector('.toss').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true })))
    .catch(() => {});
});
await A.evaluate(() => {
  const k = window.kaleido;
  window.__swings = [0, 0];
  const st = [0, 1].map(() => ({ busyUntil: 0, stage: '', lastPlan: null }));
  const smooth = (t) => t * t * (3 - 2 * t);
  const realMs = (tl) => {
    if (!k.smashCue) return tl * 1000;
    let ms = 0;
    for (let t = tl; t > 0; t -= 0.01) ms += 10 / (0.36 + 0.64 * smooth(Math.max(0, Math.min(1, (t - 0.3) / 0.95))));
    return ms;
  };
  window.__drive = setInterval(() => {
    const m = k.match;
    if (!m || k.attract || k.guest) return;
    const now = Date.now();
    for (const me of m.players) {
      if (!me.human) continue;
      const i = me.team;
      const s = st[i];
      if (now < s.busyUntil) continue;
      if (m.state === 'serve' && m.server === me && m.t - m.stateT0 > 0.7) {
        if (s.stage !== 'toss') {
          s.stage = 'toss';
          window.__tap(i);
          s.busyUntil = now + 150;
        }
      } else if (m.state === 'toss' && m.server === me) {
        if (s.stage !== 'serve') {
          s.stage = 'serve';
          const at = now + (m.server.tossT + 0.78 - m.t) * 1000;
          if (at - now > 300) {
            window.__swingAt(i, at);
            window.__swings[i]++;
            s.busyUntil = at + 720;
          }
        }
      } else if (m.state === 'play' && me.plan && me.plan !== s.lastPlan && !me.swing) {
        const lead = realMs(me.plan.t - m.t);
        const at = now + lead;
        if (lead <= 480 && lead > 300) {
          s.lastPlan = me.plan;
          window.__swingAt(i, at);
          window.__swings[i]++;
          s.busyUntil = at + 720;
        }
      } else if (m.state !== 'toss') s.stage = m.state === 'serve' ? s.stage : '';
    }
  }, 15);
});
console.log('  the phones rally for 8 s…');
await sleep(8000);
const rally = await A.evaluate(() => ({ ev: window.__ev.slice(), swings: window.__swings.slice(), state: window.kaleido.match.state }));
const hits = rally.ev.filter((e) => e === 'hit').length;
check('both phones swung and the ball was hit (the guest’s phone plays too)', rally.swings[0] >= 1 && rally.swings[1] >= 1 && hits >= 3, `swings ${rally.swings}, ${hits} hits, ${rally.ev.filter((e) => e === 'bounce').length} bounces`);
await shot(B, '7-guest-rally');

// ---- end the match: one point from the end of a one-game match
await A.evaluate(() => clearInterval(window.__drive));
await sleep(1500);
const force = () =>
  A.evaluate(() => {
    const m = window.kaleido.match;
    m.score.points = [3, 0];
    m.ball.live = true;
    m.pointTo(0, 'winner');
    return m.score.games.join('-');
  });
console.log('  match point (a hook), team 0 wins:', await force());
const overA = await A.waitForFunction(() => window.kaleido.match?.state === 'over', null, { timeout: 40000 }).then(() => true).catch(() => false);
check('the match ends', overA);
check('the host’s results screen: "Play again" and "Leave" (no other choices)', await A.waitForFunction(() => [...document.querySelectorAll('.results .menu .item')].map((e) => e.textContent).join('|') === 'Play again|Leave', null, { timeout: 8000 }).then(() => true).catch(() => false), await A.evaluate(() => [...document.querySelectorAll('.results .menu .item')].map((e) => e.textContent).join('|')));
const resB = await B.waitForFunction(() => document.querySelector('.results .winner'), null, { timeout: 8000 }).then(() => true).catch(() => false);
check('the guest’s results screen comes up', resB);
const res = async (p) => p.evaluate(() => ({ winner: document.querySelector('.results .winner')?.textContent, final: document.querySelector('.results .final')?.textContent }));
const [ra, rb] = [await res(A), await res(B)];
check('both name the same winner and games', ra.winner === rb.winner && ra.final === rb.final && ra.winner === `${ia.names[0]} wins!`, `${ra.winner} ${ra.final} / ${rb.winner} ${rb.final}`);
await shot(A, '8-host-results');
await shot(B, '9-guest-results');
// every event reached the guest, in order
{
  await sleep(600);
  const [ea, eb] = [await A.evaluate(() => window.__ev), await B.evaluate(() => window.__ev)];
  check('every match event of the first match reached the guest, in order', ea.join() === eb.join() && ea.length > 10, `${ea.length} host / ${eb.length} guest events`);
}

// ---- Play again (A)
const firstId = await B.evaluate(() => window.kaleido.guest.id);
await A.evaluate(() => ((window.__ev = []), (window.__oldMatch = window.kaleido.match)));
await B.evaluate(() => (window.__ev = []));
await A.keyboard.press('Enter');
const again = await A.waitForFunction(() => window.kaleido.match && window.kaleido.match !== window.__oldMatch && !window.kaleido.attract && window.kaleido.match.score.games.join() === '0,0', null, { timeout: 10000 }).then(() => true).catch(() => false);
check('A on the results: a second match starts with the same two people', again && (await info(A)).players.join() === ia.players.join());
const again2 = await B.waitForFunction((id) => window.kaleido.guest && window.kaleido.guest.id !== id && window.kaleido.guest.ready && !document.querySelector('.results .winner'), firstId, { timeout: 12000 }).then(() => true).catch(() => false);
check('…and it is on the guest too (its results give way to the new match)', again2);
{
  const [x, y] = [await info(A), await info(B)];
  check('…in the same world, the guest still looking from its end', x.world === y.world && y.side === 1, `${x.world} / ${y.world}`);
}
await sleep(3500);
console.log('  match point in the second match, team 0 wins:', await force());
await A.waitForFunction(() => window.kaleido.match?.state === 'over', null, { timeout: 15000 }).catch(() => null);
check('the second match ends with results on both', (await A.waitForSelector('.results .winner', { timeout: 8000 }).then(() => true).catch(() => false)) && (await B.waitForSelector('.results .winner', { timeout: 8000 }).then(() => true).catch(() => false)));
{
  await sleep(400);
  const [ea, eb] = [await A.evaluate(() => window.__ev), await B.evaluate(() => window.__ev)];
  check('…every event of the second match reached the guest, in order', ea.join() === eb.join() && ea.length > 4, `${ea.length} events`);
}

// ---- Leave (B)
await A.keyboard.press('Escape');
check('B on the host’s results: the host goes back to Play online', await screenIs(A, 'online'));
check('…and the host’s pairing is over', await A.evaluate(() => window.flow.mm === null));
check('the guest is sent home too: back at Play online, hosting its own room', (await screenIs(B, 'online')) && (await B.evaluate(() => window.kaleido.link.role === 'host' && window.kaleido.link.room !== window.flow.mm?.code)), await B.evaluate(() => window.flow.screen?.name));
await shot(B, '10-guest-sent-home');
check('the guest’s link is its own room again (not the host’s)', (await B.evaluate(() => window.kaleido.link.room)) !== roomA && (await B.evaluate(() => window.kaleido.link.online)));
check('the host has no guests left', await A.waitForFunction(() => window.kaleido.link.guests.length === 0, null, { timeout: 5000 }).then(() => true).catch(() => false));

// ---- a TV waiting alone cancels with B
const C = await tvPage('C-alone');
await toOnline(C);
const pC = await phoneFor(C, 'padC');
check('C has a phone', pC.ok);
await sleep(1000);
await pressQuick(C);
check('C: "Looking for an opponent…"', (await screenIs(C, 'quick')) && /Looking for an opponent/.test((await C.textContent('.qhead')) || ''));
check('C is alone in the lobby', await until(async () => (await queueLen()) === 1, 3000));
await sleep(3300);
check('C: the clock has run to at least 0:03', /^0:0[3-9]/.test((await C.textContent('.qtimer')) || ''), await C.textContent('.qtimer'));
check('C: it is still waiting (nobody else in the queue)', /Looking for an opponent/.test((await C.textContent('.qhead')) || '') && (await C.evaluate(() => window.kaleido.link.searching)));
await shot(C, '11-waiting-alone');
await C.keyboard.press('Escape');
check('B cancels: back to Play online, the search socket is closed', (await screenIs(C, 'online')) && !(await C.evaluate(() => window.kaleido.link.searching)));
check('…and the lobby’s queue is empty', await until(async () => (await queueLen()) === 0, 3000));

// two TVs meet again: B's phone is back in B's own room (the phone that played is still at A's), B presses first and hosts
console.log('\n(second round: the other way round; the guest leaves its lobby before any phone comes)');
{
  const url = await B.evaluate(() => window.kaleido.link.joinUrl);
  await pB.pad.goto(url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
  await B.waitForFunction(() => window.kaleido.input.padCount > 0, null, { timeout: 20000 });
  // (A's phone would follow A into B's room at once and the match would start: make it deaf to the 'move' for this round)
  await pA.pad.evaluate(() => {
    window.__padLink.moveTo = () => {};
  });
  await sleep(500);
  await pressQuick(B);
  await screenIs(B, 'quick');
  await sleep(300);
  await pressQuick(A);
  const t0 = Date.now();
  const ok = await Promise.all([
    B.waitForFunction(() => window.flow.mm?.role === 'host', null, { timeout: 8000 }).then(() => true).catch(() => false),
    A.waitForFunction(() => window.flow.mm?.role === 'guest', null, { timeout: 8000 }).then(() => true).catch(() => false),
  ]);
  check('later: the TVs match again, the earlier presser (B) hosting this time', ok[0] && ok[1], `${Date.now() - t0} ms`);
  await B.waitForFunction(() => window.kaleido.link.guests.length === 1, null, { timeout: 5000 }).catch(() => null);
  // the guest (A) leaves its lobby: the host (B) is told its opponent left
  await A.keyboard.press('Escape');
  check('the guest leaving its lobby returns it to Play online', await screenIs(A, 'online'));
  check('…and the host is told "Your opponent left" (with a way to find another)', await B.waitForFunction(() => window.flow.screen?.name === 'opponentleft' && /Your opponent left/.test(document.querySelector('.screen h2')?.textContent || ''), null, { timeout: 5000 }).then(() => true).catch(() => false), await B.evaluate(() => window.flow.screen?.name));
  await shot(B, '12-opponent-left');
  await B.keyboard.press('Escape');
  check('B goes back to Play online, pairing over', (await screenIs(B, 'online')) && (await B.evaluate(() => window.flow.mm === null)));
  check('the lobby is empty', (await queueLen()) === 0);
  await pA.pad.evaluate(() => {
    delete window.__padLink.moveTo;
  });
}

// a third meeting: the guest leaves in the middle of the match
console.log('\n(third round: the guest leaves in the middle of a match)');
{
  await A.waitForFunction(() => window.kaleido.input.padCount > 0, null, { timeout: 20000 }).catch(() => null);
  await sleep(500);
  await pressQuick(A);
  await screenIs(A, 'quick');
  await sleep(300);
  await pressQuick(B);
  await A.waitForFunction(() => window.flow.mm?.role === 'host', null, { timeout: 8000 }).catch(() => null);
  await B.waitForFunction(() => window.flow.mm?.role === 'guest', null, { timeout: 8000 }).catch(() => null);
  const url = await B.evaluate(() => window.kaleido.link.joinUrl);
  await pB.pad.goto(url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
  const on = await A.waitForFunction(() => window.kaleido.match && !window.kaleido.attract && window.flow.mm?.phase === 'play', null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('a third match starts (A hosts again)', on && (await B.waitForFunction(() => window.kaleido.guest?.ready, null, { timeout: 15000 }).then(() => true).catch(() => false)));
  await sleep(2500);
  // the guest opens its menu and leaves the match
  await B.keyboard.press('Escape');
  await B.waitForFunction(() => window.flow.screen?.name === 'guestpause', null, { timeout: 5000 }).catch(() => null);
  await B.keyboard.press('ArrowDown');
  await B.keyboard.press('Enter');
  check('the guest chooses "Leave match": back at Play online, in its own room', (await screenIs(B, 'online')) && (await B.evaluate(() => window.kaleido.link.role)) === 'host');
  check('the host: "Your opponent left", the match is called off', await A.waitForFunction(() => window.flow.screen?.name === 'opponentleft' && (!window.kaleido.match || window.kaleido.attract) && window.flow.mm === null, null, { timeout: 5000 }).then(() => true).catch(() => false), await A.evaluate(() => window.flow.screen?.name));
  await A.keyboard.press('Escape');
  check('…and B on that screen goes back to Play online', await screenIs(A, 'online'));
}

// a fourth: the guest's phone never comes
console.log('\n(fourth round: the guest’s phone never joins — the host gives up after 15 s)');
{
  // (B's phone was sent home by the last round's host when B left: wait for it, then make it deaf to the TV's 'move' — a phone that never joins)
  await B.waitForFunction(() => window.kaleido.input.padCount > 0, null, { timeout: 20000 }).catch(() => null);
  await A.waitForFunction(() => window.kaleido.input.padCount > 0, null, { timeout: 20000 }).catch(() => null);
  await pB.pad.evaluate(() => {
    window.__padLink.moveTo = () => {};
  });
  await sleep(500);
  await pressQuick(A);
  await screenIs(A, 'quick');
  await sleep(300);
  await pressQuick(B);
  await B.waitForFunction(() => window.flow.mm?.role === 'guest', null, { timeout: 8000 }).catch(() => null);
  const t0 = Date.now();
  const gaveUp = await A.waitForFunction(() => window.flow.mm === null && window.flow.screen?.name === 'online', null, { timeout: 25000 }).then(() => true).catch(() => false);
  const took = Date.now() - t0;
  check('no phone for 15 s: the host says so and goes back to Play online', gaveUp && took > 13000 && took < 20000, `${(took / 1000).toFixed(1)} s`);
  check('the guest stays in the host’s room lobby, with a message', await B.waitForFunction(() => window.kaleido.link.role === 'guest' && /didn’t join in time/.test(document.querySelector('.lstatus')?.textContent || ''), null, { timeout: 5000 }).then(() => true).catch(() => false), await B.textContent('.lstatus').catch(() => ''));
  check('…and the host’s room still works for manual joins (the guest is still listed)', (await A.evaluate(() => window.kaleido.link.guests.length)) === 1);
  await shot(B, '13-no-phone-note');
  await B.keyboard.press('Escape');
  check('the guest leaves the lobby normally', await screenIs(B, 'online'));
}

check('no page errors on any TV or phone', errors.length === 0, errors.length ? '\n' + errors.join('\n') : '');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll quick-match checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
