// End-to-end look at the bowling remote, with no TV page: this script plays
// the TV itself (a WebSocket as role=tv, allowed from this machine), puts the
// pad in 'bowl' mode, and records what the pad sends. A synthetic phone
// (deviceorientation + devicemotion from an arm-pendulum + wrist-twist model)
// grips, swings back, swings forward with a hook twist and lets go at the
// bottom. A second phone without motion sensors bowls with the swipe fallback.
//
//   PORT=3310 HTTPS_PORT=3753 HMR_PORT=24690 node server/server.mjs --dev   (in another shell)
//   node scripts/bowl-pad-shots.mjs [outDir]        (BASE=http://localhost:3310 by default)
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3310';
const out = process.argv[2] || path.join(os.tmpdir(), 'kaleido-bowl-shots');
fs.mkdirSync(out, { recursive: true });
console.log('screenshots →', out);

// ---------------------------------------------------------------- the fake TV
const tv = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?role=tv');
await new Promise((ok, fail) => (tv.once('open', ok), tv.once('error', fail)));
const got = []; // { pid, t, msg }
const joins = [];
tv.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === 'pad-join') joins.push(m.pid);
  if (m.type === 'pad') got.push({ pid: m.pid, t: Date.now(), msg: m.msg });
});
const toPad = (pid, msg) => tv.send(JSON.stringify({ type: 'to-pad', pid, msg }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function nextJoin(n) {
  for (let i = 0; i < 100 && joins.length < n; i++) await wait(100);
  if (joins.length < n) throw new Error('pad never joined');
  return joins[n - 1];
}

// ---------------------------------------------------------------- run
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const logs = [];
const device = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
// In a git worktree node_modules is often a symlink to another checkout, whose
// font files the dev server won't serve (outside its allow list): hand them
// over directly. Only the font files — the CSS comes through Vite as a module.
async function fonts(ctx) {
  await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
    if (fs.existsSync(file)) route.fulfill({ path: file });
    else route.continue();
  });
}
const shot = (page, name) => page.screenshot({ path: path.join(out, name + '.png') });
const since = (t0, pid) => got.filter((g) => g.t >= t0 && g.pid === pid).map((g) => g.msg);
const brief = (m) =>
  m.type === 'ori' ? `ori${m.arm !== undefined ? ` arm=${m.arm}` : ''}` : m.type === 'btn' ? `btn ${m.b} ${m.down ? 'down' : 'up'}` : JSON.stringify(m);
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

// 1. a phone with motion sensors
const ctxA = await browser.newContext(device);
await fonts(ctxA);
const pa = await ctxA.newPage();
pa.on('pageerror', (e) => logs.push('[pad A] ' + e.message));
await ctxA.addInitScript(phone);
await pa.goto(BASE + '/controller.html?auto');
const pidA = await nextJoin(1);
await wait(1600); // the remote decides whether it has motion sensors
toPad(pidA, { type: 'welcome', slot: 0, color: '#ff5a6e', name: 'Veer' });
toPad(pidA, { type: 'mode', mode: 'bowl', title: 'Your turn!', hint: 'Frame 3 · Ball 1' });
await wait(700);
await shot(pa, 'bowl-idle');

let t0 = Date.now();
const thrown = pa.evaluate(() => window.__phone.bowl({ peak: 8, twist: 1.2, homeAfter: 250 }));
await wait(1000); // into the forward swing, ball still in the hand (it's let go at ~1.15 s)
await shot(pa, 'bowl-swinging');
await thrown;
await wait(150);
await shot(pa, 'bowl-thrown');
let msgs = since(t0, pidA).filter((m) => m.type !== 'hello' && m.type !== 'prefs');
const seq = msgs.filter((m) => m.type !== 'ori' || m.arm !== undefined);
console.log('pad → TV:', seq.map(brief).join(' | '));
const iDown = msgs.findIndex((m) => m.type === 'grip' && m.down);
// (the arm starts at the remote's guess for a flat phone — held up in front, 1.1 — and the swing corrects it)
const iUp = msgs.findIndex((m) => m.type === 'grip' && !m.down);
const iBowl = msgs.findIndex((m) => m.type === 'bowl');
check('grip down → grip up → bowl, in order', iDown >= 0 && iDown < iUp && iUp + 1 === iBowl);
const arms = msgs.filter((m) => m.type === 'ori' && m.arm !== undefined).map((m) => m.arm);
check('arm streamed while gripping, absolute (top of the backswing ≈ −1.2, near 0 at the release)', arms.length > 8 && Math.abs(Math.min(...arms) + 1.2) < 0.4 && Math.abs(arms[arms.length - 1]) < 0.3, `${arms.length} values: ${arms.join(' ')}`);
check('no arm outside the grip', msgs.slice(iUp + 1).every((m) => m.type !== 'ori' || m.arm === undefined));
const b = msgs[iBowl];
check('bowl: relaxed speed, straight, hooks left', b && b.speed > 6 && b.speed < 7.6 && Math.abs(b.angle) < 0.03 && b.spin > 0.4 && b.touch === false, JSON.stringify(b));

// pause: not straight after letting go (a thumb sliding off the grip — pressed 250 ms after), then it works
check('home ignored just after letting go', !msgs.some((m) => m.type === 'btn'));
const home = async () => {
  const r = await pa.locator('.bowl .bhome').boundingBox();
  await pa.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await wait(60);
};
check('no tennis swing or prep while bowling', !msgs.some((m) => m.type === 'swing' || m.type === 'prep' || m.type === 'toss'));

toPad(pidA, { type: 'fx', fx: 'perfect', label: 'STRIKE!', detail: `${b?.speed.toFixed(1)} m/s · hook` });
await wait(250);
await shot(pa, 'bowl-strike');

// move / aim: a tap, then a hold that repeats
t0 = Date.now();
const btn = async (label, ms) => {
  const r = await pa.locator(`button[aria-label="${label}"]`).boundingBox();
  await pa.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await pa.mouse.down();
  await wait(ms);
  await pa.mouse.up();
  await wait(100);
};
await wait(700); // past the lock after letting go
t0 = Date.now();
await home();
msgs = since(t0, pidA).filter((m) => m.type === 'btn');
check('home works once the ball is gone: down, up', msgs.length === 2 && msgs[0].b === 'home' && msgs[0].down && !msgs[1].down, msgs.map(brief).join(' | '));
// and not while the ball is in the hand
t0 = Date.now();
await pa.evaluate(() => document.querySelector('.grip').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 11, pointerType: 'touch', bubbles: true, cancelable: true })));
await home();
check('home ignored while gripping', !since(t0, pidA).some((m) => m.type === 'btn'));
await pa.evaluate(() => document.querySelector('.grip').dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, pointerType: 'touch', bubbles: true, cancelable: true })));
await wait(800);
t0 = Date.now();
await btn('Step left', 80);
await btn('Aim right', 800);
msgs = since(t0, pidA).filter((m) => m.type === 'btn');
console.log('buttons:', msgs.map(brief).join(' | '));
const lefts = msgs.filter((m) => m.b === 'left');
const plus = msgs.filter((m) => m.b === 'plus');
check('◀ tap = one down, one up', lefts.length === 2 && lefts[0].down && !lefts[1].down);
check('↻ held repeats (more downs, then one up)', plus.filter((m) => m.down).length >= 4 && !plus[plus.length - 1].down);

// the next ball: fresh panel (shot at the phone's real height minus the iPhone's safe areas too)
toPad(pidA, { type: 'mode', mode: 'bowl', title: 'Spare?', hint: 'Frame 3 · Ball 2' });
await wait(2800);
await pa.setViewportSize({ width: 390, height: 763 });
await wait(300);
await shot(pa, 'bowl-ball2-safearea');
await pa.setViewportSize({ width: 390, height: 844 });

// the TV takes the pad elsewhere mid-grip: the grip is dropped (grip up, no bowl)
t0 = Date.now();
await pa.evaluate(() => document.querySelector('.grip').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true })));
await wait(200);
toPad(pidA, { type: 'mode', mode: 'watch', title: 'Watching', hint: 'Player 2' });
await wait(300);
msgs = since(t0, pidA).filter((m) => m.type === 'grip' || m.type === 'bowl');
check('leaving bowl mode mid-grip: grip up, no throw', msgs.length === 2 && msgs[0].down && !msgs[1].down, msgs.map(brief).join(' | '));
toPad(pidA, { type: 'fx', fx: 'hit', label: '9 PINS', detail: 'Player 2' });
await wait(250);
await shot(pa, 'watch-fx');

// back to tennis: swings are sent again
t0 = Date.now();
toPad(pidA, { type: 'mode', mode: 'play', title: 'Rally!', hint: 'Swing like a racket' });
await wait(300);
await pa.evaluate(() => window.__phone.tennis());
msgs = since(t0, pidA).filter((m) => m.type === 'swing');
check('tennis still swings after bowling', msgs.length === 1 && msgs[0].side === 'fh', msgs.map((m) => `${m.side} p${m.power}`).join(' '));

// 2. a phone without motion sensors: the swipe fallback
const ctxB = await browser.newContext(device);
await fonts(ctxB);
const pb = await ctxB.newPage();
pb.on('pageerror', (e) => logs.push('[pad B] ' + e.message));
await pb.goto(BASE + '/controller.html?auto');
const pidB = await nextJoin(2);
await wait(1600);
toPad(pidB, { type: 'welcome', slot: 1, color: '#3aa8ff', name: 'Ana' });
toPad(pidB, { type: 'mode', mode: 'bowl', title: 'Your turn!', hint: 'Frame 1 · Ball 1' });
await wait(2000); // the "no motion sensor" toast goes
await shot(pb, 'swipe-idle');
t0 = Date.now();
const g = await pb.locator('.grip').boundingBox();
const cx = g.x + g.width / 2,
  cy = g.y + g.height * 0.75;
await pb.mouse.move(cx, cy);
await pb.mouse.down();
await wait(150);
// a stroke that speeds up, drifting right then curving left into the pocket
for (let i = 1; i <= 14; i++) {
  const u = i / 14;
  await pb.mouse.move(cx + 40 * Math.sin(Math.PI * u) * 0.6, cy - 300 * u * u);
  await wait(20);
}
await pb.mouse.up();
await wait(200);
await shot(pb, 'swipe-thrown');
msgs = since(t0, pidB).filter((m) => m.type === 'grip' || m.type === 'bowl');
console.log('swipe pad → TV:', msgs.map(brief).join(' | '));
const sb = msgs.find((m) => m.type === 'bowl');
check('swipe: grip down, up, bowl with touch:true', msgs.length === 3 && msgs[0].down && !msgs[1].down && sb?.touch === true && sb.speed > 4, JSON.stringify(sb));

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} end-to-end checks FAILED` : '\nAll end-to-end checks passed.');
await browser.close();
tv.close();
process.exitCode = fail ? 1 : 0;
