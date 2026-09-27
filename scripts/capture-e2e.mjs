// The motion recorder end to end: a simulated phone (scripts/lib/fake-phone.mjs) opens
// /rec (capture.html), starts, and works through the first labelled steps — holding
// still, slashes to the right, chops, GUARD — while the page streams everything to
// the server; then the capture is replayed (scripts/replay-capture.ts) and has to
// say the same.
//
//   node scripts/capture-e2e.mjs      (BASE=http://localhost:3200 by default)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await ctx.addInitScript(phone);
const page = await ctx.newPage();
page.on('pageerror', (e) => logs.push(e.message));
await page.goto(BASE + '/rec?name=e2etest');
check('/rec opens the recorder', (await page.title()).includes('Capture'), await page.title());
const button = (text) => page.locator('button', { hasText: text }).first().click();
const title = () => page.locator('h1').textContent();

await button('Start');
await wait(600);
check('the first step is shown', /still/i.test(await title()), await title());
// 1. hold still
await page.evaluate(() => window.__phone.hold({ top: [0, 0.45, 0.9], screen: [0, -0.9, 0.45], ms: 700 }));
await button('Start');
await wait(2500);
await button('Done');
// 2. slashes to the right
check('then slashes to the right', /right/i.test(await title()), await title());
await button('Start');
for (let k = 0; k < 3; k++) await page.evaluate(() => window.__phone.sword({ dir: 0, peak: 10 }));
const seen = await page.locator('.log').textContent();
check('the page shows what it detected', /→/.test(seen ?? ''), seen ?? '');
await button('Done');
// 3. slashes to the left: skipped; 4. chops
await button('Skip');
check('then chops (after a skip)', /chop/i.test(await title()), await title());
await button('Start');
for (let k = 0; k < 2; k++) await page.evaluate(() => window.__phone.sword({ dir: -Math.PI / 2, peak: 11 }));
await button('Done');
// the guard, held while swinging (outside a step: it's all recorded anyway)
const guard = page.locator('.guard');
const box = await guard.boundingBox();
await page.evaluate(({ x, y }) => {
  const el = document.querySelector('.guard');
  el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 5, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
}, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
await page.evaluate(() => window.__phone.sword({ dir: 0, peak: 10 }));
const live = await page.locator('.live').textContent();
check('a swing with GUARD held is shown as guarding', /guarding/i.test(live ?? ''), live ?? '');
await page.evaluate(() => {
  document.querySelector('.guard').dispatchEvent(new PointerEvent('pointerup', { pointerId: 5, pointerType: 'touch', bubbles: true }));
});
await wait(1500); // (the page sends every 0.7 s)
const status = await page.locator('.status').textContent();
check('the page reports the upload', /captures\/e2etest-.*\.jsonl/.test(status ?? '') && !/failing/.test(status ?? ''), status ?? '');
await browser.close();

// the capture, replayed
const file = /captures\/(e2etest-[^ ]+\.jsonl)/.exec(status ?? '')?.[1];
const full = file && path.join(process.cwd(), 'captures', file);
check('the capture is on disk', !!full && fs.existsSync(full), full ?? '');
if (full && fs.existsSync(full)) {
  const lines = fs.readFileSync(full, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const kinds = (k) => lines.filter((l) => l.k === k).length;
  check('it has the header, motion, orientation and events', lines[0].k === 'meta' && kinds('m') > 300 && kinds('o') > 300 && kinds('e') > 5, `${lines.length} lines: ${kinds('m')} motion, ${kinds('o')} orientation, ${kinds('e')} events`);
  const segs = lines.filter((l) => l.k === 'e' && l.ev === 'seg').map((l) => `${l.label}:${l.phase}`);
  check('the steps are marked (start, end, skip)', segs.join(' ') === 'still:start still:end right:start right:end left:skip down:start down:end', segs.join(' '));
  const out = execFileSync('npx', ['tsx', 'scripts/replay-capture.ts', full], { encoding: 'utf8' });
  const block = (label) => out.split('■').find((b) => b.includes(label)) ?? '';
  check('replayed: the gyro axes are found', /gyro axes: xyz/.test(out), /gyro axes: .*/.exec(out)?.[0]);
  check('replayed: holding still — no strikes', /0 strikes \(want none\)/.test(block('still')), block('still').split('\n')[1]?.trim());
  check('replayed: 3 slashes to the right', /3 slashes, 3 within 45°/.test(block('right')), block('right').split('\n')[1]?.trim());
  check('replayed: 2 chops', /2 slashes, 2 within 45°/.test(block('down')), block('down').split('\n')[1]?.trim());
  check('replayed: what the phone said live is there too', /live: → → →/.test(block('right')), block('right').split('\n')[2]?.trim());
  fs.unlinkSync(full);
}
console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll motion-capture checks passed.');
process.exitCode = fail || logs.length ? 1 : 0;
