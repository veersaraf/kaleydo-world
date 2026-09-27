// The whole chain for the sword duel: a simulated phone (the real remote page with
// synthetic motion that moves like a hand: windups, sloppy directions, tremor,
// gyro noise — scripts/lib/fake-phone.mjs) duels on the real TV page through the
// real server. Checks the sword follows the phone, a swing strikes in its
// direction (a lazy one too, a windup never), a nudge asks for a harder swing,
// a swing with GUARD held says so, GUARD guards at the phone's angle, a push
// thrusts, and home pauses.
//
//   node scripts/duel-phone-e2e.mjs [outDir]      (BASE=http://localhost:3200 by default)
//   AXES=zxy   the phone reports rotationRate the other way round (alpha about z…); IOS=1 its accelerometer as iOS does
//   REC=name   record the phone's raw motion to captures/ (replay: npx tsx scripts/replay-capture.ts)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2] || path.join(os.tmpdir(), 'kaleido-duel-e2e');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const logs = [];
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const deg = (r) => `${Math.round((r * 180) / Math.PI)}°`;

const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });

const padCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
if (process.env.AXES || process.env.IOS) await padCtx.addInitScript(`window.__phoneConfig = ${JSON.stringify({ axes: process.env.AXES || 'xyz', ios: !!process.env.IOS })}`);
await padCtx.addInitScript(phone);
const pad = await padCtx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
// (REC=name records the phone's raw motion to captures/name-….jsonl: replay it with scripts/replay-capture.ts)
await pad.goto(BASE + '/controller.html?auto' + (process.env.REC ? '&rec=' + process.env.REC : ''));
await tv.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 });
await wait(1600);

// a Rookie that barely attacks, so the checks aren't interrupted by being knocked about
await tv.evaluate(() => window.flow.beginDuel('park', 0.3));
await pad.waitForSelector('.panel.sword.on', { timeout: 10000 });
check('the pad shows the sword panel', true);
await tv.evaluate(() => window.kaleido.duel.skip());
await tv.waitForFunction(() => window.kaleido.duel?.state === 'fight', null, { timeout: 20000 });
// record fighter 0's attacks and guard; the CPU stands still (it would knock the
// test player about — this checks the phone, not the fight)
await tv.evaluate(() => {
  const g = window.kaleido.duel;
  for (const c of g.cpus) if (c) c.think = () => {};
  // (and the round doesn't end mid-test: no clock, and strikes don't land — this counts attacks)
  g.timeLeft = 600;
  g.contact = function (i) {
    this.sides[i].contactAt = NaN;
  };
  window.__ev = [];
  const on = g.onEvent;
  g.onEvent = (e) => {
    window.__ev.push(e);
    on(e);
  };
});
const blade = () => tv.evaluate(() => window.kaleido.duel.fighters[0].aim.blade);

// 0. a few seconds of handling the phone (as anyone does between joining and fighting): enough for the
// remote to work out which way round the gyro reports its axes (it can't know before it moves)
for (const top of [[0.5, 0.6, 0.6], [-0.4, 0.3, 0.85], [0, 0.9, -0.3], [0, 0.6, 0.8]])
  await pad.evaluate((t) => window.__phone.hold({ top: t, screen: [0.3, -0.8, 0.5], ms: 400 }), top);

// 1. the sword follows the phone (earth frame: x right, y towards the screen, z up)
await pad.evaluate(() => window.__phone.hold({ top: [0, 0.25, 0.97], screen: [0, -0.97, 0.25], ms: 500 }));
await wait(300);
let b = await blade();
check('phone upright → sword upright', b[1] > 0.85 && Math.abs(b[0]) < 0.3, b.map((v) => v.toFixed(2)).join(', '));
await pad.evaluate(() => window.__phone.hold({ top: [-0.97, 0.25, 0], screen: [-0.25, -0.97, 0], ms: 500 }));
await wait(300);
b = await blade();
check('phone across the body → sword level', b[0] < -0.85 && Math.abs(b[1]) < 0.3, b.map((v) => v.toFixed(2)).join(', '));

// 2. swings strike in their direction
for (const [name, dir] of [
  ['a cut to the right', 0],
  ['a chop', -Math.PI / 2],
  ['a diagonal down-left', (-3 * Math.PI) / 4],
]) {
  await pad.evaluate(() => window.__phone.hold({ top: [0, 0.6, 0.8], screen: [0, -0.8, 0.6], ms: 400 }));
  await tv.evaluate(() => (window.__ev.length = 0));
  await pad.evaluate((d) => window.__phone.sword({ dir: d, peak: 13 }), dir);
  await wait(250);
  const at = await tv.evaluate(() => window.__ev.find((e) => e.type === 'attack' && e.who === 0));
  let err = at ? Math.abs(Math.atan2(Math.sin(at.attack.dir - dir), Math.cos(at.attack.dir - dir))) : 9;
  check(`${name} strikes that way`, !!at && at.attack.kind === 'slash' && err < 0.5, at ? `dir ${deg(at.attack.dir)} (wanted ${deg(dir)}), power ${at.attack.power.toFixed(2)}` : 'no attack');
  await wait(900);
}

// 2b. sloppier, lazier, and not quite swings
const attacks = () => tv.evaluate(() => window.__ev.filter((e) => e.type === 'attack' && e.who === 0).map((e) => e.attack));
const shot = () => pad.evaluate(() => document.querySelector('.panel.sword .shotline')?.textContent ?? '');
const near = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
{
  // a lazy swing (~290°/s), no windup, sloppy: still a strike, that way
  await pad.evaluate(() => window.__phone.hold({ top: [0.1, 0.5, 0.86], screen: [0, -0.86, 0.5], ms: 400 }));
  await tv.evaluate(() => (window.__ev.length = 0));
  await pad.evaluate(() => window.__phone.sword({ dir: Math.PI, peak: 5, windup: false, sloppy: 0.25, rise: 0.09, fall: 0.1 }));
  await wait(300);
  let a = await attacks();
  check('a lazy, sloppy swing to the left (~290°/s) strikes, that way', a.length === 1 && near(a[0].dir, Math.PI) < Math.PI / 4, a.map((x) => `${deg(x.dir)} ${x.power.toFixed(2)}`).join(', ') || 'no attack');
  await wait(700);
  // raise the sword for a chop: one attack — the chop, not the raise
  await pad.evaluate(() => window.__phone.hold({ top: [0, 0.6, 0.8], screen: [0, -0.8, 0.6], ms: 400 }));
  await tv.evaluate(() => (window.__ev.length = 0));
  await pad.evaluate(() => window.__phone.sword({ dir: -Math.PI / 2, peak: 11, windup: true }));
  await wait(300);
  a = await attacks();
  check('a windup and a chop: one attack, down', a.length === 1 && near(a[0].dir, -Math.PI / 2) < Math.PI / 4, a.map((x) => deg(x.dir)).join(', ') || 'no attack');
  await wait(700);
  // a snappy nudge that falls short (~160°/s): no attack, and the phone says swing harder
  await tv.evaluate(() => (window.__ev.length = 0));
  await pad.evaluate(() => window.__phone.sword({ dir: 0, peak: 2.8, windup: false, rise: 0.05, fall: 0.06 }));
  await wait(300);
  a = await attacks();
  const said = await shot();
  check('a nudge that falls short: no attack, "swing harder"', a.length === 0 && /harder/i.test(said), `${a.length} attacks, the phone says "${said}"`);
  await wait(500);
  // a swing with GUARD held: no attack, and the phone says why
  await pad.evaluate(() => window.__phone.guard(true));
  await wait(150);
  await tv.evaluate(() => (window.__ev.length = 0));
  await pad.evaluate(() => window.__phone.sword({ dir: 0, peak: 10 }));
  const gsaid = await shot();
  a = await attacks();
  await pad.evaluate(() => window.__phone.guard(false));
  check('a swing with GUARD held: no attack, "let go of GUARD"', a.length === 0 && /GUARD/.test(gsaid), `${a.length} attacks, the phone says "${gsaid}"`);
  await wait(900);
}

// 3. GUARD guards at the phone's angle
await pad.evaluate(() => window.__phone.hold({ top: [0, 0.25, 0.97], screen: [0, -0.97, 0.25], ms: 400 }));
await wait(700);
await pad.evaluate(() => window.__phone.guard(true));
await wait(250);
const guarding = await tv.evaluate(() => ({ phase: window.kaleido.duel.fighters[0].phase, blade: window.kaleido.duel.fighters[0].aim.blade }));
check('holding GUARD guards, upright', guarding.phase === 'guard' && guarding.blade[1] > 0.85, `${guarding.phase} ${guarding.blade.map((v) => v.toFixed(2)).join(', ')}`);
await tv.screenshot({ path: path.join(out, 'duel-e2e-guard.png') });
await pad.screenshot({ path: path.join(out, 'duel-e2e-pad-guard.png') });
await pad.evaluate(() => window.__phone.guard(false));
await wait(250);
const after = await tv.evaluate(() => window.kaleido.duel.fighters[0].phase);
check('letting go stops guarding', after !== 'guard', after);

// 4. a push towards the screen thrusts
await pad.evaluate(() => window.__phone.hold({ top: [0, 0.97, 0.25], screen: [0, -0.25, 0.97], ms: 400 }));
await wait(500);
await tv.evaluate(() => (window.__ev.length = 0));
await pad.evaluate(() => window.__phone.thrust({ dist: 0.35, dur: 0.22 }));
const th = await tv.evaluate(() => window.__ev.find((e) => e.type === 'attack' && e.who === 0));
check('a push thrusts', !!th && th.attack.kind === 'thrust', th ? JSON.stringify(th.attack) : 'no attack');

// 5. home on the pad pauses
await wait(600);
await pad.evaluate(() => {
  const el = document.querySelector('.panel.sword.on [data-b="home"], .panel.sword.on .bhome, .panel.sword.on .shome');
  for (const type of ['pointerdown', 'pointerup']) el?.dispatchEvent(new PointerEvent(type, { pointerId: 40, pointerType: 'touch', bubbles: true, cancelable: true }));
});
await wait(500);
check('home on the pad pauses the TV', await tv.evaluate(() => window.kaleido.paused));

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll phone-to-TV duel checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
