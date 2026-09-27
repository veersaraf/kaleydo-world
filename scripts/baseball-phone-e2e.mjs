// The whole chain for baseball: a simulated phone (the real remote page with
// synthetic motion) bats on the real TV page through the real server. Checks the
// bat panel shows on your turn, a swing timed to the ball meets it — and that the
// timing the TV measures for it is right despite the detector's and the network's
// delay — a swing far too early misses or goes foul, a pitch you don't swing at
// is a strike, and the phone hears each verdict.
//
//   node scripts/baseball-phone-e2e.mjs [outDir]      (BASE=http://localhost:3200 by default)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phone } from './lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2] || path.join(os.tmpdir(), 'kaleido-baseball-e2e');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const logs = [];
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

const fps = await tv.evaluate(() => new Promise((done) => { let n = 0; const t0 = performance.now(); const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : done(n)); requestAnimationFrame(f); }));
console.log(`  TV page: ${fps} fps`);
// one hitter (the phone), no CPU; watch the events
await tv.evaluate(() => {
  window.__ev = [];
  const prev = window.kaleido.onBaseballEvent;
  window.kaleido.onBaseballEvent = (e) => {
    const rec = { type: e.type, at: Date.now() };
    if (e.type === 'pitch') rec.plateAt = Date.now() + (e.pitch.tc - window.kaleido.baseball.t) * 1000;
    if (e.type === 'swing') Object.assign(rec, { timing: e.timing, contact: e.contact, power: e.power });
    if (e.type === 'result') Object.assign(rec, { outcome: e.outcome, distance: e.distance });
    if (e.type === 'contact') Object.assign(rec, { foul: e.ball.foul, homeRun: e.ball.homeRun, distance: e.ball.distance });
    window.__ev.push(rec);
    prev(e);
  };
  // every swing that reaches the TV (before the game judges it)
  window.__arrivals = [];
  const prevSwing = window.kaleido.input.onSwing;
  window.kaleido.input.onSwing = (e) => {
    const g = window.kaleido.baseball;
    window.__arrivals.push({ at: Date.now(), age: Math.round(e.age * 1000), power: e.power, state: g?.state, t: g?.t, tc: g?.pitch?.tc, t0: g?.pitch?.t0 });
    prevSwing(e);
  };
  window.flow.beginBaseball({ world: 'park', cpu: -1, pitching: 0.2, pitches: 10 });
  window.kaleido.baseball.skip();
});
await pad.waitForSelector('.panel.play.bat.on', { timeout: 10000 });
check('your turn: the pad shows the bat panel', true);

const nextPitch = async () => {
  const n = await tv.evaluate(() => window.__ev.filter((e) => e.type === 'pitch').length);
  const h = await tv.waitForFunction((n) => { const p = window.__ev.filter((e) => e.type === 'pitch'); return p.length > n && p[p.length - 1]; }, n, { timeout: 15000, polling: 16 }).catch(async (err) => {
    console.log('  events:', JSON.stringify(await tv.evaluate(() => window.__ev.map((e) => e.type + (e.outcome ? ':' + e.outcome : '')))), await tv.evaluate(() => ({ state: window.kaleido.baseball?.state, paused: window.kaleido.paused, screen: document.querySelector('.screen')?.className })));
    throw err;
  });
  return h.jsonValue();
};
const resultAfter = async (t) => (await tv.waitForFunction((t) => window.__ev.find((e) => e.type === 'result' && e.at > t), t, { timeout: 15000, polling: 50 })).jsonValue();
const swingAfter = (t) => tv.evaluate((t) => window.__ev.find((e) => e.type === 'swing' && e.at > t) ?? null, t);

// 1. swings timed to the ball (the phone's fastest moment as the ball reaches the plate, +40 ms for the screen)
//    (a busy machine can hand us the pitch too late to swing at it properly: then let it go and try the next)
const timings = [];
let met = 0;
for (let i = 0, tries = 0; i < 3 && tries < 6; tries++) {
  const p = await nextPitch();
  const inMs = p.plateAt + 40 - Date.now();
  if (inMs < 320) {
    console.log(`  (the pitch reached us with only ${Math.round(inMs)} ms to go: letting it by)`);
    await resultAfter(p.at);
    continue;
  }
  await pad.evaluate((at) => window.__phone.tennis({ at }), p.plateAt + 40);
  const r = await resultAfter(p.at);
  const s = await swingAfter(p.at);
  if (s) timings.push(Math.round(s.timing * 1000));
  if (s?.contact) met++;
  if (i === 0) await tv.screenshot({ path: path.join(out, 'hr-e2e-hit.png') });
  console.log(`  pitch ${i + 1}: swing ${s ? `${Math.round(s.timing * 1000)} ms, power ${s.power.toFixed(2)}` : 'none'} → ${r.outcome}${r.distance ? ` ${Math.round(r.distance)} m` : ''}  (asked the phone for a peak in ${Math.round(inMs)} ms)`);
  if (!s) console.log('    arrivals since the pitch:', JSON.stringify(await tv.evaluate((t) => window.__arrivals.filter((a) => a.at > t), p.at)));
  i++;
}
check('a swing timed to the ball meets it', met === 3, `${met} of 3`);
// (±60 ms: the fake phone's motion runs on timers, which a loaded machine delays)
check('the TV times a phone swing right (despite the detector and the network)', timings.length === 3 && timings.every((t) => Math.abs(t) <= 60), `${timings.join(', ')} ms`);
const tvLine = await pad.evaluate(() => document.querySelector('.panel.play .tvline')?.textContent ?? '');
check('the phone hears the verdict', tvLine.length > 0, `“${tvLine}”`);

// 2. a swing far too early (the ball's barely left the hand)
for (let tries = 0; tries < 4; tries++) {
  const p = await nextPitch();
  // its fastest moment a third of a second before the ball gets there
  const inMs = p.plateAt - 330 - Date.now();
  if (inMs < 200) {
    await resultAfter(p.at);
    continue;
  }
  await pad.evaluate((at) => window.__phone.tennis({ at }), p.plateAt - 330);
  const r = await resultAfter(p.at);
  const s = await swingAfter(p.at);
  check('a swing far too early misses (or goes foul)', r.outcome === 'strike' || r.outcome === 'foul', `${s ? Math.round(s.timing * 1000) + ' ms' : 'no swing'} → ${r.outcome}`);
  break;
}

// 3. no swing: a strike
{
  const p = await nextPitch();
  const r = await resultAfter(p.at);
  check('a pitch you don’t swing at is a strike', r.outcome === 'strike', r.outcome);
  await wait(200);
  const line = await pad.evaluate(() => document.querySelector('.panel.play .tvline')?.textContent ?? '');
  check('…and the phone says so', /STRIKE/.test(line), `“${line}”`);
}
await tv.waitForFunction(() => document.querySelector('.results'), null, { timeout: 60000 }).catch(() => null);
check('the derby ends on the results', await tv.evaluate(() => !!document.querySelector('.results')));

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll phone-to-TV baseball checks passed.');
await browser.close();
process.exitCode = fail ? 1 : 0;
