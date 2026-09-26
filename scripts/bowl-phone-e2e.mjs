// The whole chain: a simulated phone (the real remote page with synthetic motion)
// bowls on the real TV page through the real server. Checks that the grip starts
// the approach, the streamed arm moves the bowler's arm, the release throws with
// the measured speed and hook, a tap with no swing doesn't throw, and the pad's
// home button pauses the game.
//
//   node scripts/bowl-phone-e2e.mjs [outDir]      (BASE=http://localhost:3200 by default)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2] || path.join(os.tmpdir(), 'kaleido-bowl-e2e');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const logs = [];
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the TV
const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const tv = await tvCtx.newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });

// the phone
const padCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await padCtx.addInitScript(phone);
const pad = await padCtx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.goto(BASE + '/controller.html?auto');
await tv.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 });
await wait(1600); // the remote decides it has motion sensors
const slot = await tv.evaluate(() => window.kaleido.input.activeSeats.find((s) => !s.local).slot);
check('the phone took a seat', slot >= 0, `slot ${slot}`);

await tv.evaluate(() => window.flow.beginBowling('park', -1));
await tv.waitForFunction(() => window.kaleido.bowl?.state === 'ready', null, { timeout: 30000 });
await pad.waitForSelector('.panel.bowl.on', { timeout: 10000 });
check('the pad shows the bowling panel', true);

// watch the TV's game while the phone bowls
const watch = () =>
  tv.evaluate(
    () =>
      new Promise((done) => {
        const g = window.kaleido.bowl;
        const s = { states: [], arms: [], cancel: 0, result: null, t0: performance.now() };
        const on = g.onEvent;
        g.onEvent = (e) => {
          if (e.type === 'cancel') s.cancel++;
          if (e.type === 'result') s.result = { pins: e.pins, mark: e.mark };
          on(e);
        };
        const tick = () => {
          if (s.states[s.states.length - 1] !== g.state) s.states.push(g.state);
          if (g.state === 'approach') s.arms.push(+g.body.arm.toFixed(2));
          if (s.result || s.cancel || performance.now() - s.t0 > 15000) {
            g.onEvent = on;
            done({ ...s, lastThrow: g.lastThrow });
          } else requestAnimationFrame(tick);
        };
        tick();
      }),
  );

// 1. a relaxed straight swing
let seen = watch();
const straight = pad.evaluate(() => window.__phone.bowl({ peak: 8, twist: 0 }));
await wait(300 + 600); // the top of the backswing
await tv.screenshot({ path: path.join(out, 'e2e-backswing.png') });
await straight;
let r = await seen;
console.log('  states:', r.states.join(' → '), '· arm:', `${Math.max(...r.arms)} … ${Math.min(...r.arms)} … ${r.arms[r.arms.length - 1]}`);
check('grip starts the approach, the release rolls the ball', r.states.includes('approach') && (r.states.includes('lane') || r.states.includes('pins')));
check('the bowler’s arm follows the phone (back past −1, then through)', r.arms.length > 10 && Math.min(...r.arms) < -1 && r.arms[r.arms.length - 1] > Math.min(...r.arms) + 0.8, `${r.arms.length} samples`);
const t1 = r.lastThrow;
check('a relaxed swing: 6–8 m/s, straight, no hook', t1 && t1.speed > 6 && t1.speed < 8 && Math.abs(t1.spin) < 0.1 && Math.abs(t1.angle) < 0.01, JSON.stringify(t1));
check('the ball was scored', !!r.result, JSON.stringify(r.result));

// 2. a hook: next ball
await tv.waitForFunction(() => window.kaleido.bowl.state === 'ready', null, { timeout: 30000 });
await pad.waitForFunction(() => document.querySelector('.panel.bowl.on') && !document.querySelector('.grip.held'), null, { timeout: 10000 });
await wait(800);
seen = watch();
await pad.evaluate(() => window.__phone.bowl({ peak: 9, twist: 1.2 }));
r = await seen;
const t2 = r.lastThrow;
check('a wrist twist through the release hooks left', t2 && t2.spin > 0.2 && t2.speed > 6.5, JSON.stringify(t2));
check('…and was scored', !!r.result, JSON.stringify(r.result));

// 3. a tap with no swing: back to the stance, no ball
await tv.waitForFunction(() => window.kaleido.bowl.state === 'ready', null, { timeout: 30000 });
await wait(1000);
const thrownBefore = await tv.evaluate(() => window.kaleido.bowl.lastThrow);
seen = watch();
await pad.evaluate(() => {
  const el = document.querySelector('.grip');
  const b = el.getBoundingClientRect();
  const ev = (type) => el.dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, bubbles: true, cancelable: true }));
  ev('pointerdown');
  setTimeout(() => ev('pointerup'), 120);
});
r = await seen;
const thrownAfter = await tv.evaluate(() => window.kaleido.bowl.lastThrow);
check('a tap without a swing doesn’t throw', r.cancel === 1 && JSON.stringify(thrownBefore) === JSON.stringify(thrownAfter), `states ${r.states.join(' → ')}`);
await wait(400);
const tvLine = await pad.evaluate(() => document.querySelector('.bowl .tvline')?.textContent);
check('…and the pad says to swing', /swing/i.test(tvLine || ''), JSON.stringify(tvLine));

// 4. the pad's home button pauses
await wait(900);
await pad.evaluate(() => {
  const el = document.querySelector('.bowl .bhome');
  for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { pointerId: 30, pointerType: 'touch', bubbles: true, cancelable: true }));
});
await wait(500);
const paused = await tv.evaluate(() => window.kaleido.paused || !!document.querySelector('.screen'));
check('home on the pad pauses the TV', paused);
await tv.screenshot({ path: path.join(out, 'e2e-paused.png') });
await pad.screenshot({ path: path.join(out, 'e2e-pad-paused.png') });

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll phone-to-TV bowling checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
