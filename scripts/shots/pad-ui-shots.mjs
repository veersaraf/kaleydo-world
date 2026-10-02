// Screenshots of every controller panel, in portrait and in landscape (the
// counter-rotation), with motion sensors (a fake phone) and without (the touch
// fallbacks). A fake TV on the hub drives the remote from mode to mode.
//
//   BASE=http://localhost:4500 node scripts/shots/pad-ui-shots.mjs [outDir]
//
// Writes one PNG per panel and a contact sheet per variant (sheet-*.png).

import { launchChrome } from '../lib/chrome.mjs';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { phone } from '../lib/fake-phone.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.resolve(process.argv[2] || 'shots/pad-ui');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- a fake TV
const tv = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?role=tv');
let pid = null;
const toPad = (msg) => tv.send(JSON.stringify({ type: 'to-pad', pid: pid ?? '*', msg }));
tv.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'pad-join') {
    pid = m.pid;
    toPad({ type: 'welcome', slot: 1, color: '#3aa8ff', name: m.name });
    toPad({ type: 'score', line: '15 – 30' });
  }
});
await new Promise((r) => tv.once('open', r));

const STEPS = [
  ['menu', { type: 'mode', mode: 'menu', title: 'Main menu', hint: 'Use the pad · A to choose' }],
  ['pause', { type: 'mode', mode: 'menu', title: 'Paused', hint: 'A to choose · B resume' }],
  ['serve', { type: 'mode', mode: 'serve', title: 'LIFT TO TOSS', hint: 'raise the phone (or tap), then swing' }],
  ['play', { type: 'mode', mode: 'play', title: 'Rally!', hint: 'Swing like a racket' }, [{ type: 'fx', fx: 'hit', power: 0.7, label: 'NICE SHOT', detail: '112 km/h' }]],
  ['skip', { type: 'mode', mode: 'skip', title: 'SKIP', hint: 'replay' }],
  ['bowl', { type: 'mode', mode: 'bowl', title: 'Your turn!', hint: 'Frame 3 · ball 1' }],
  ['bowl-locked', { type: 'mode', mode: 'bowl', title: 'Rolling…', hint: 'watch the pins', lock: true }, [{ type: 'fx', fx: 'hit', label: 'STRIKE!', detail: '7.6 m/s · hook' }]],
  ['sword', { type: 'mode', mode: 'sword', title: 'Fight!', hint: 'Round 2 · 1 – 0' }],
  ['bow', { type: 'mode', mode: 'bow', title: 'Your shot!', hint: 'End 1 · arrow 2 of 3' }],
  ['bow-locked', { type: 'mode', mode: 'bow', title: 'Flying…', hint: 'watch the target', lock: true }],
  ['bat', { type: 'mode', mode: 'bat', title: 'At bat · pitch 3 of 10' }, [{ type: 'fx', fx: 'perfect', label: 'HOME RUN!', detail: '124 m' }]],
  ['wait', { type: 'mode', mode: 'wait', title: 'Rolling…', hint: 'watch the pins' }],
  ['watch', { type: 'mode', mode: 'watch', title: 'Ana is batting', hint: 'you’re up soon' }],
];

const browser = await launchChrome(['--autoplay-policy=no-user-gesture-required']);
const variants = [
  { tag: 'portrait-motion', w: 390, h: 844, motion: true },
  { tag: 'portrait-touch', w: 390, h: 844, motion: false },
  { tag: 'landscape-motion', w: 844, h: 390, motion: true },
  { tag: 'landscape-touch', w: 844, h: 390, motion: false, angle: -90 },
];
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;

for (const v of only ? variants.filter((x) => only.includes(x.tag)) : variants) {
  const dir = path.join(OUT, v.tag);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  if (v.motion) await ctx.addInitScript(phone);
  // (headless Chrome's screen doesn't turn with the viewport: say which way the phone went)
  if (v.angle) await ctx.addInitScript((a) => Object.defineProperty(window, 'orientation', { get: () => a, configurable: true }), v.angle);
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => console.log('  page error:', e.message));
  const shots = [];
  const shot = async (name) => {
    await sleep(450);
    const f = path.join(dir, name + '.png');
    await pad.screenshot({ path: f });
    shots.push([name, f]);
  };
  pid = null;
  await pad.goto(BASE + '/controller.html');
  await pad.evaluate(() => {
    localStorage.setItem('kaleido.name', 'Robin');
  });
  await pad.reload();
  await shot('join');
  await pad.evaluate(() => document.querySelector('.join-btn')?.click());
  await sleep(100);
  await shot('connecting');
  for (let i = 0; i < 50 && !pid; i++) await sleep(100);
  await sleep(1400);
  for (const [name, msg, fx] of STEPS) {
    toPad(msg);
    for (const f of fx ?? []) {
      await sleep(250);
      toPad(f);
    }
    await shot(name);
  }
  toPad({ type: 'mode', mode: 'menu', title: 'Main menu', hint: 'Use the pad · A to choose' });
  await sleep(300);
  await pad.evaluate(() => document.querySelector('.gear')?.click());
  await shot('settings');
  await ctx.close();

  // the contact sheet
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const cols = v.w > v.h ? 4 : 7;
  const imgs = shots.map(([n, f]) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${n}</figcaption></figure>`).join('');
  await sheet.setContent(`<style>body{margin:0;background:#222;font:600 14px system-ui;color:#ddd}main{display:grid;grid-template-columns:repeat(${cols},1fr);gap:14px;padding:14px}img{width:100%;display:block;border-radius:10px}figure{margin:0}figcaption{padding:4px 2px}</style><main>${imgs}</main>`);
  await sheet.screenshot({ path: path.join(OUT, `sheet-${v.tag}.png`), fullPage: true });
  await sheet.close();
  console.log('  ' + v.tag + ': ' + shots.length + ' shots');
}

await browser.close();
tv.close();
