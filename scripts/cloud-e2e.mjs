// The cloud version end to end (cloud/worker.ts under `npx wrangler dev`): a TV
// page makes up a room and shows its QR; a simulated phone opens the room's remote
// link and joins; its swings reach the TV through the room; a phone that opens the
// remote without a room is asked for the code, and one with a wrong code isn't
// seated at this TV.
//   npx wrangler dev --port 8787 &  then  BASE=http://127.0.0.1:8787 node scripts/cloud-e2e.mjs
import { chromium } from 'playwright-core';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];
const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => window.kaleido?.link?.online, null, { timeout: 30000 });
const info = await tv.evaluate(() => ({ cloud: window.kaleido.link.cloud, room: window.kaleido.link.room, url: window.kaleido.link.joinUrl }));
check('the TV is in the cloud with a room', info.cloud && /^[A-Z0-9]{5}$/.test(info.room || ''), JSON.stringify(info));
await tv.waitForFunction(() => document.querySelector('.join .qr img')?.src?.startsWith('data:image'), null, { timeout: 10000 }).catch(() => null);
check('the join panel shows a QR code and the room', await tv.evaluate(() => !!document.querySelector('.join .qr img')?.src?.startsWith('data:image') && document.querySelector('.join .url')?.textContent.includes(window.kaleido.link.room)));

const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
// the QR code's link
const padCtx = await browser.newContext(mobile);
await padCtx.addInitScript(phone);
const pad = await padCtx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.goto(info.url.replace(/^https?:\/\/[^/]+/, BASE) + '&auto');
const joined = await tv.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 }).then(() => true).catch(() => false);
check('a phone opening the QR code link joins the TV', joined);

// a swing reaches the TV
if (joined) {
  await tv.evaluate(() => {
    window.__sw = 0;
    window.__ages = [];
    const prev = window.kaleido.input.onSwing;
    window.kaleido.input.onSwing = (e) => (window.__sw++, window.__ages.push(e.age), prev(e));
    window.flow.beginBaseball({ world: 'park', cpu: -1, pitching: 0.2, pitches: 3 });
  });
  await pad.waitForSelector('.panel.play.bat.on', { timeout: 15000 }).catch(() => null);
  await pad.evaluate(() => window.__phone.tennis({ inMs: 400 }));
  const n = await tv.waitForFunction(() => window.__sw > 0, null, { timeout: 5000 }).then(() => true).catch(() => false);
  check('a phone swing reaches the TV through the room', n);
  // the TV's ping-measured clock offset, and a swing's age (phone's own age + latency + the relay's transit, all clamped at 0.16 s)
  await tv.waitForTimeout(3000);
  const off = await tv.evaluate(() => window.kaleido.link.serverOffset);
  check('the TV measured a finite clock offset to the room', Number.isFinite(off), `${off} ms`);
  const ages = await tv.evaluate(() => window.__ages);
  check('the swing arrived with an age in (0, 0.16] s', ages.length > 0 && ages.every((a) => a > 0 && a <= 0.16), ages.map((a) => a.toFixed(3)).join(' '));
}

// no room: asked for the code
const lost = await (await browser.newContext(mobile)).newPage();
await lost.goto(BASE + '/c');
check('a remote opened without a room asks for the code', await lost.waitForSelector('input[name=room]', { timeout: 8000 }).then(() => true).catch(() => false));

// someone else's room code: not seated here
const other = await (await browser.newContext(mobile)).newPage();
await other.addInitScript(phone);
await other.goto(BASE + '/c?room=ZZZZZ&auto');
await other.waitForTimeout(3000);
const seats = await tv.evaluate(() => window.kaleido.input.activeSeats.filter((s) => !s.local).length);
check('a phone in another room isn’t seated at this TV', seats === 1, `${seats} phones here`);

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll cloud checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
