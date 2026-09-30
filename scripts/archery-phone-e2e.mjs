// The whole chain for archery: a simulated phone (the real remote page with synthetic
// motion) shoots on the real TV page through the real server. Checks the bow panel
// shows on your turn, holding DRAW pulls the string, turning the phone turns the
// aim (by the aim gain, from where the draw began — not from the compass), letting
// go shoots, a quick tap doesn't, and the panel stays locked while the arrow flies.
//
//   node scripts/archery-phone-e2e.mjs [outDir]      (BASE=http://localhost:3200 by default)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2] || path.join(os.tmpdir(), 'kaleydo-archery-e2e');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const logs = [];
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const deg = (r) => `${((r * 180) / Math.PI).toFixed(1)}°`;

const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });

const padCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await padCtx.addInitScript(phone);
const pad = await padCtx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.goto(BASE + '/controller.html?auto');
await tv.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 });
await wait(1600);

// (a TV page starved of frames — say another heavy GPU job on this machine — makes timings meaningless)
const fps = await tv.evaluate(() => new Promise((done) => { let n = 0; const t0 = performance.now(); const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : done(n)); requestAnimationFrame(f); }));
console.log(`  TV page: ${fps} fps`);
await tv.evaluate(() => window.flow.beginArchery('park', -1));
await tv.evaluate(() => window.kaleido.archery.skip());
await tv.waitForFunction(() => window.kaleido.archery?.state === 'aim', null, { timeout: 30000 });
await pad.waitForSelector('.panel.bow.on', { timeout: 10000 });
check('your turn: the pad shows the bow panel', true);

const pressDraw = (type, id = 11) =>
  pad.evaluate(
    ([type, id]) => {
      const el = document.querySelector('.panel.bow .draw');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    },
    [type, id],
  );
const aimNow = () => tv.evaluate(() => ({ yaw: window.kaleido.archery.archer.yaw, pitch: window.kaleido.archery.archer.pitch, home: { ...window.kaleido.archery.home }, phase: window.kaleido.archery.archer.phase, draw: window.kaleido.archery.archer.draw }));

// 1. point roughly at the screen, hold DRAW: the string comes back, the aim starts on the target
await pad.evaluate(() => window.__phone.hold({ top: [0.26, 0.97, 0], screen: [0, 0, 1], ms: 400 }));
await wait(300);
await pressDraw('pointerdown');
await wait(1100);
let a = await aimNow();
check('holding DRAW pulls the string back', (a.phase === 'hold' || a.phase === 'draw') && a.draw > 0.9, `${a.phase} ${a.draw.toFixed(2)}`);
check('the aim starts on the target (whatever way the phone faces)', Math.abs(a.yaw - a.home.yaw) < 0.01 && Math.abs(a.pitch - a.home.pitch) < 0.01, `yaw ${deg(a.yaw)} vs ${deg(a.home.yaw)}`);
await tv.screenshot({ path: path.join(out, 'arch-e2e-draw.png') });

// 2. turn the phone 10° to the left: the aim follows by the gain (0.55 → about 5.5°)
await pad.evaluate(() => {
  const t = (10 * Math.PI) / 180;
  window.__phone.hold({ top: [0.26 * Math.cos(t) - 0.97 * Math.sin(t), 0.26 * Math.sin(t) + 0.97 * Math.cos(t), 0], screen: [0, 0, 1], ms: 350 });
});
await wait(600);
a = await aimNow();
const turned = a.yaw - a.home.yaw;
check('turning the phone turns the aim (by the gain)', turned > 0.07 && turned < 0.12, `aim turned ${deg(turned)} for a 10° turn`);

// 3. let go: the arrow flies; the pad stays on the bow panel, locked
await pad.evaluate(() => window.__phone.hold({ top: [0.26, 0.97, 0], screen: [0, 0, 1], ms: 300 }));
await wait(500);
await pressDraw('pointerup');
await tv.waitForFunction(() => window.kaleido.archery.state === 'flight' || window.kaleido.archery.state === 'result', null, { timeout: 3000 }).catch(() => null);
check('letting go shoots', ['flight', 'result'].includes(await tv.evaluate(() => window.kaleido.archery.state)));
await wait(300);
const locked = await pad.evaluate(() => ({ on: !!document.querySelector('.panel.bow.on'), locked: !!document.querySelector('.panel.bow.locked') }));
check('the bow panel stays up, locked, while it flies', locked.on && locked.locked, JSON.stringify(locked));
const scored = await tv.waitForFunction(() => window.kaleido.archery.scores[0].length === 1, null, { timeout: 8000 }).then(() => true).catch(() => false);
check('the arrow was scored', scored, JSON.stringify(await tv.evaluate(() => window.kaleido.archery.scores[0])));

// 4. a quick tap on DRAW doesn't shoot
await tv.waitForFunction(() => window.kaleido.archery.state === 'aim', null, { timeout: 15000 });
await pad.waitForSelector('.panel.bow.on:not(.locked)', { timeout: 5000 });
await wait(700);
// (down and up inside the phone page: separate calls from here take a few hundred ms)
await pad.evaluate(
  () =>
    new Promise((done) => {
      const el = document.querySelector('.panel.bow .draw');
      const r = el.getBoundingClientRect();
      const ev = (type) => el.dispatchEvent(new PointerEvent(type, { pointerId: 12, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      ev('pointerdown');
      setTimeout(() => (ev('pointerup'), done()), 100);
    }),
);
await wait(700);
const after = await tv.evaluate(() => ({ state: window.kaleido.archery.state, n: window.kaleido.archery.scores[0].length }));
check('a quick tap on DRAW doesn’t shoot', after.state === 'aim' && after.n === 1, JSON.stringify(after));

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll phone-to-TV archery checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
