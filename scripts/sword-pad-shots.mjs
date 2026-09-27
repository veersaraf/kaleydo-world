// End-to-end look at the sword remote, with no TV page: this script plays the
// TV itself (a WebSocket as role=tv, allowed from this machine), puts the pad
// in 'sword' mode and records what the pad sends. A synthetic phone
// (deviceorientation + devicemotion from scripts/lib/fake-phone.mjs) raises
// its sword, slashes, guards at an angle (swinging while guarding), thrusts,
// and takes the TV's verdicts. A second phone without motion sensors duels
// with the swipe pad and the guard toggle.
//
//   PORT=3700 HTTPS_PORT=4143 HMR_PORT=25300 node server/server.mjs --dev   (in another shell)
//   node scripts/sword-pad-shots.mjs [outDir]        (BASE=http://localhost:3700 by default)
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3700';
const out = process.argv[2] || path.join(os.tmpdir(), 'kaleido-sword-shots');
fs.mkdirSync(out, { recursive: true });
console.log('screenshots →', out);

// ---------------------------------------------------------------- the fake TV
const tv = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?role=tv');
await new Promise((ok, fail) => (tv.once('open', ok), tv.once('error', fail)));
const got = []; // { pid, t, msg }
const joins = [];
tv.on('message', (data) => {
  const m = JSON.parse(data.toString());
  // (a page that reloads — Vite does that when it finds a new dependency — joins again: count phones, not joins)
  if (m.type === 'pad-join' && !joins.includes(m.pid)) joins.push(m.pid);
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
const deg = (r) => Math.round((r * 180) / Math.PI);
const brief = (m) =>
  m.type === 'ori'
    ? 'ori'
    : m.type === 'btn'
      ? `btn ${m.b} ${m.down ? 'down' : 'up'}`
      : m.type === 'guard'
        ? `guard ${m.down ? 'down' : 'up'}`
        : m.type === 'slash'
          ? `${m.kind}${m.kind === 'slash' ? ' ' + deg(m.dir) + '°' : ''} p${m.power}${m.touch ? ' touch' : ''}`
          : JSON.stringify(m);
const seqOf = (msgs) => msgs.filter((m) => m.type !== 'ori').map(brief).join(' | ');
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
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
const everything = Date.now();
toPad(pidA, { type: 'mode', mode: 'sword', title: 'Round 1', hint: 'First to 2 · swing to slash, hold GUARD to block' });
// raise the sword: the hilt in a fist, pointed at the opponent, screen to the face
await pa.evaluate(() => window.__phone.hold({ top: [0, 0.8, 0.6], screen: [0, -0.6, 0.8], ms: 1000 }));
await wait(300);
await shot(pa, 'sword-idle');
let t0 = Date.now();
await wait(1000);
const oris = since(t0, pidA).filter((m) => m.type === 'ori');
check("'ori' streams in sword mode (~30 a second)", oris.length >= 24 && oris.length <= 36, `${oris.length} in 1 s, s = [${oris.at(-1)?.s}]`);
check('nothing but ori while just holding the sword up', since(everything, pidA).every((m) => m.type === 'ori'), seqOf(since(everything, pidA)));

// slash to the right
t0 = Date.now();
await pa.evaluate(() => window.__phone.sword({ dir: 0, peak: 13 }));
await wait(250);
await shot(pa, 'sword-slash');
let msgs = since(t0, pidA);
console.log('slash → TV:', seqOf(msgs));
let slashes = msgs.filter((m) => m.type === 'slash');
check('a slash to the right: one slash, dir ≈ 0°, strong, not touch', slashes.length === 1 && slashes[0].kind === 'slash' && Math.abs(wrap(slashes[0].dir)) < 0.35 && slashes[0].power > 0.5 && slashes[0].touch === false, JSON.stringify(slashes[0]));
const iSlash = msgs.findIndex((m) => m.type === 'slash');
check('the pose it struck in comes just before the slash', iSlash > 0 && msgs[iSlash - 1].type === 'ori');

// a chop (back to the ready pose first, slowly)
await pa.evaluate(() => window.__phone.hold({ top: [0, 0.8, 0.6], screen: [0, -0.6, 0.8], ms: 1100 }));
await wait(200);
t0 = Date.now();
await pa.evaluate(() => window.__phone.sword({ dir: -Math.PI / 2, peak: 15, rise: 0.08 }));
await wait(200);
slashes = since(t0, pidA).filter((m) => m.type === 'slash');
check('a chop: one slash, dir ≈ −90°', slashes.length === 1 && Math.abs(wrap(slashes[0].dir + Math.PI / 2)) < 0.35, slashes.map(brief).join(' | '));
check('the chop (15 rad/s) is a strong one', slashes[0]?.power > 0.7, `${slashes[0]?.power}`);

// the TV's verdict: a hit
toPad(pidA, { type: 'fx', fx: 'hit', label: 'HIT!', detail: 'Ana is pushed back' });
await wait(260);
await shot(pa, 'sword-hit');

// a diagonal up-left, gentler
await pa.evaluate(() => window.__phone.hold({ top: [0.2, 0.9, 0.3], screen: [0, -0.3, 0.9], ms: 1100 }));
await wait(200);
t0 = Date.now();
await pa.evaluate(() => window.__phone.sword({ dir: (3 * Math.PI) / 4, peak: 7.5 }));
await wait(200);
slashes = since(t0, pidA).filter((m) => m.type === 'slash');
check('a gentle diagonal up-left: one slash, dir ≈ 135°, gentle', slashes.length === 1 && Math.abs(wrap(slashes[0].dir - (3 * Math.PI) / 4)) < 0.4 && slashes[0].power < 0.45, slashes.map(brief).join(' | '));

// guard: press, turn the blade across (a horizontal guard), swing hard while guarding, let go
await pa.evaluate(() => window.__phone.hold({ top: [0, 0.3, 0.95], screen: [0, -1, 0.3], ms: 1100 }));
await wait(300);
t0 = Date.now();
await pa.evaluate(() => window.__phone.guard(true));
await wait(150);
await pa.evaluate(() => window.__phone.hold({ top: [-0.95, 0.3, 0.05], screen: [0, -1, 0], ms: 250 })); // quick: that's fine while guarding
await wait(350);
await shot(pa, 'sword-guard');
const lineShown = await pa.evaluate(() => [document.querySelector('.guard').dataset.line, document.querySelector('.guard span').textContent, document.querySelector('.guard').classList.contains('held')]);
check("the pad glows and says the blade is horizontal while guarding across", lineShown[0] === 'horizontal' && lineShown[1] === 'horizontal' && lineShown[2], lineShown.join(' · '));
const guardOri = since(t0, pidA).filter((m) => m.type === 'ori').at(-1);
await pa.evaluate(() => window.__phone.sword({ dir: -Math.PI / 2, peak: 14 })); // a blow while guarding: only angles the guard
await wait(100);
toPad(pidA, { type: 'fx', fx: 'block', label: 'BLOCKED!', detail: 'Ana is stunned' });
await wait(120);
await shot(pa, 'sword-block');
await pa.evaluate(() => window.__phone.guard(false));
await wait(200);
msgs = since(t0, pidA);
console.log('guard → TV:', seqOf(msgs));
const gd = msgs.findIndex((m) => m.type === 'guard' && m.down),
  gu = msgs.findIndex((m) => m.type === 'guard' && !m.down);
check('guard down … guard up, and no slash in between', gd >= 0 && gu > gd && !msgs.some((m) => m.type === 'slash'), seqOf(msgs));
check('the ori before guard down and before guard up (the angle it went up and came down at)', msgs[gd - 1]?.type === 'ori' && msgs[gu - 1]?.type === 'ori');
check("'ori' while guarding: the blade across the view (s ≈ ±x)", guardOri && Math.abs(guardOri.s[0]) > 0.85 && Math.abs(guardOri.s[2]) < 0.35, `s = [${guardOri?.s}], n = [${guardOri?.n}]`);

// home: ignored while guarding, works after
t0 = Date.now();
await pa.evaluate(() => window.__phone.hold({ top: [0, 0.8, 0.6], screen: [0, -0.6, 0.8], ms: 1000 }));
await pa.evaluate(() => window.__phone.guard(true));
await wait(100);
const home = async () => {
  const r = await pa.locator('.sword button[aria-label="Pause"]').boundingBox();
  await pa.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await wait(60);
};
await home();
check('pause ignored while guarding', !since(t0, pidA).some((m) => m.type === 'btn'));
await pa.evaluate(() => window.__phone.guard(false));
await wait(500);
t0 = Date.now();
await home();
msgs = since(t0, pidA).filter((m) => m.type === 'btn');
check('pause works otherwise: down, up', msgs.length === 2 && msgs[0].b === 'home' && msgs[0].down && !msgs[1].down, msgs.map(brief).join(' | '));

// a thrust
await wait(300);
t0 = Date.now();
await pa.evaluate(() => window.__phone.thrust({ dist: 0.4, dur: 0.24 }));
msgs = since(t0, pidA);
const thrusts = msgs.filter((m) => m.type === 'slash');
check('a thrust: one attack, kind thrust', thrusts.length === 1 && thrusts[0].kind === 'thrust' && thrusts[0].power > 0.3, seqOf(msgs));
await shot(pa, 'sword-thrust');

// the TV's verdict: you were hit
toPad(pidA, { type: 'fx', fx: 'ouch', label: 'OUCH!', detail: 'one more and you’re off' });
await wait(120);
await shot(pa, 'sword-ouch');

// re-center: the toast says so
await wait(400);
const rc = await pa.locator('.sword button[aria-label^="Re-center"]').boundingBox();
await pa.mouse.click(rc.x + rc.width / 2, rc.y + rc.height / 2);
await wait(150);
check('re-center: pointed at the TV, it takes', /Re-centered/.test(await pa.locator('.toast').textContent()), await pa.locator('.toast').textContent());

check('the whole duel: no tennis swings, preps, tosses or bowling messages', !since(everything, pidA).some((m) => ['swing', 'prep', 'toss', 'grip', 'bowl', 'wave'].includes(m.type)), [...new Set(since(everything, pidA).map((m) => m.type))].join(' '));

// the next round, at the phone's real height minus the iPhone's safe areas
toPad(pidA, { type: 'fx', fx: 'point-won', label: 'ROUND 1 · YOU', detail: '1 – 0' });
toPad(pidA, { type: 'mode', mode: 'sword', title: 'Round 2', hint: 'Swing to slash · hold GUARD to block' });
await wait(400);
await pa.setViewportSize({ width: 390, height: 763 });
await wait(300);
await shot(pa, 'sword-round2-safearea');
await pa.evaluate(() => window.__phone.guard(true));
await wait(250);
await shot(pa, 'sword-guard-safearea');

// the TV takes the pad elsewhere mid-guard: the guard is let go
t0 = Date.now();
toPad(pidA, { type: 'mode', mode: 'watch', title: 'Round over', hint: 'Look at the big screen' });
await wait(300);
msgs = since(t0, pidA).filter((m) => m.type === 'guard');
check('leaving sword mode while guarding: guard up', msgs.length === 1 && !msgs[0].down, seqOf(msgs));
await pa.evaluate(() => window.__phone.guard(false)); // the thumb finally lifts: nothing more
await wait(150);
check('…and the thumb lifting later sends nothing more', since(t0, pidA).filter((m) => m.type === 'guard').length === 1);
toPad(pidA, { type: 'fx', fx: 'win', label: 'YOU WIN!', detail: '2 – 1' });
await wait(300);
await shot(pa, 'watch-win');
await pa.setViewportSize({ width: 390, height: 844 });

// back to tennis: swings are sent again, no slashes
await pa.evaluate(() => window.__phone.rest());
t0 = Date.now();
toPad(pidA, { type: 'mode', mode: 'play', title: 'Rally!', hint: 'Swing like a racket' });
await wait(300);
await pa.evaluate(() => window.__phone.tennis());
msgs = since(t0, pidA);
check('tennis still swings after the duel, and no slash', msgs.filter((m) => m.type === 'swing').length === 1 && !msgs.some((m) => m.type === 'slash' || m.type === 'guard'), seqOf(msgs));

// 2. a phone without motion sensors: swipe to slash, tap to thrust, the guard toggle
const ctxB = await browser.newContext(device);
await fonts(ctxB);
const pb = await ctxB.newPage();
pb.on('pageerror', (e) => logs.push('[pad B] ' + e.message));
await pb.goto(BASE + '/controller.html?auto');
const pidB = await nextJoin(2);
await wait(1600);
toPad(pidB, { type: 'welcome', slot: 1, color: '#3aa8ff', name: 'Ana' });
toPad(pidB, { type: 'mode', mode: 'sword', title: 'Round 1' });
await wait(2200); // the "no motion sensor" toast goes
await shot(pb, 'touch-idle');
t0 = Date.now();
await wait(1000);
const tOri = since(t0, pidB).filter((m) => m.type === 'ori');
check("no motion: 'ori' still streams, the toggle's pose (vertical)", tOri.length >= 24 && Math.abs(tOri.at(-1).s[2]) > 0.9, `${tOri.length} in 1 s, s = [${tOri.at(-1)?.s}]`);
const zone = await pb.locator('.slash-zone').boundingBox();
const swipe = async (x0, y0, dx, dy, steps = 8, ms = 16) => {
  await pb.mouse.move(x0, y0);
  await pb.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    await pb.mouse.move(x0 + dx * u, y0 + dy * u);
    await wait(ms);
  }
  await pb.mouse.up();
  await wait(120);
};
t0 = Date.now();
await swipe(zone.x + zone.width * 0.5, zone.y + 20, 0, zone.height - 40, 6, 12); // down, a quick flick: a chop
await swipe(zone.x + 30, zone.y + zone.height * 0.7, zone.width - 60, -zone.height * 0.4, 12, 50); // up-right, a slow drag
await pb.mouse.click(zone.x + zone.width / 2, zone.y + zone.height / 2); // a tap: thrust
await wait(150);
await shot(pb, 'touch-slash');
msgs = since(t0, pidB).filter((m) => m.type === 'slash');
console.log('swipes → TV:', msgs.map(brief).join(' | '));
check('swipe down = a chop (touch)', msgs[0]?.kind === 'slash' && Math.abs(wrap(msgs[0].dir + Math.PI / 2)) < 0.1 && msgs[0].touch === true);
// (how fast the flick really goes depends on the browser's round trips: compare the two)
check('a slow drag up-right = a gentle slash up and to the right', msgs[1]?.kind === 'slash' && msgs[1].dir > 0.2 && msgs[1].dir < 0.9 && msgs[1].power < 0.45 && msgs[0].power > msgs[1].power + 0.2, `flick ${msgs[0]?.power} vs drag ${msgs[1]?.power}`);
check('tap = a thrust (touch)', msgs[2]?.kind === 'thrust' && msgs[2].touch === true && msgs.length === 3);
// the guard toggle, then guard: the ori follows the toggle, swipes don't attack while guarding
t0 = Date.now();
await pb.locator('.gseg-btn[data-g="horizontal"]').click();
await wait(150);
await pb.evaluate(() => {
  const el = document.querySelector('.guard');
  el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 31, pointerType: 'touch', bubbles: true, cancelable: true }));
});
await wait(100);
await swipe(zone.x + zone.width * 0.5, zone.y + 20, 0, zone.height - 40); // attack while guarding: nothing
await wait(150);
await shot(pb, 'touch-guard');
await pb.evaluate(() => {
  const el = document.querySelector('.guard');
  el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 31, pointerType: 'touch', bubbles: true, cancelable: true }));
});
await wait(150);
msgs = since(t0, pidB);
const hOri = msgs.filter((m) => m.type === 'ori').at(-1);
console.log('touch guard → TV:', seqOf(msgs));
check("the toggle's horizontal guard: ori across the view (a right hand's blade points left)", hOri && hOri.s[0] < -0.9 && Math.abs(hOri.s[2]) < 0.1, `s = [${hOri?.s}]`);
check('touch guard: down, up, no slash while guarding', seqOf(msgs) === 'guard down | guard up', seqOf(msgs));
await pb.setViewportSize({ width: 390, height: 763 });
await wait(300);
await shot(pb, 'touch-safearea');

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} end-to-end checks FAILED` : '\nAll end-to-end checks passed.');
await browser.close();
tv.close();
process.exitCode = fail ? 1 : 0;
