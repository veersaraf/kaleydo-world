// The remote stays portrait when the page turns landscape (portrait.ts), and
// swipes and drags still read in the phone's own axes. A phone without motion
// sensors (the touch fallbacks), in portrait and turned either way:
//  - the remote is counter-rotated and fills the page;
//  - a swipe right→left across the phone is a forehand (right hand);
//  - a bowling drag up the phone is a straight throw;
//  - an archery drag to the phone's right turns the aim right.
//
//   BASE=http://localhost:4500 node scripts/e2e/pad-rotate-test.mjs

import { launchChrome } from '../lib/chrome.mjs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// a fake TV: seats the pad, sets its mode, and records what it sends
const tv = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?role=tv');
let pid = null;
const got = [];
const toPad = (msg) => tv.send(JSON.stringify({ type: 'to-pad', pid, msg }));
tv.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'pad-join') {
    pid = m.pid;
    toPad({ type: 'welcome', slot: 0, color: '#ff5a6e', name: m.name });
  }
  if (m.type === 'pad') got.push(m.msg);
});
await new Promise((r) => tv.once('open', r));

const browser = await launchChrome();

for (const v of [
  { tag: 'portrait', w: 390, h: 844, angle: 0, rot: '' },
  { tag: 'landscape, top to the left', w: 844, h: 390, angle: 90, rot: '-90' },
  { tag: 'landscape, top to the right', w: 844, h: 390, angle: -90, rot: '90' },
]) {
  console.log(v.tag);
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript((a) => Object.defineProperty(window, 'orientation', { get: () => a, configurable: true }), v.angle);
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => check('no page errors', false, e.message));
  pid = null;
  await pad.goto(BASE + '/controller.html?auto');
  for (let i = 0; i < 50 && !pid; i++) await sleep(100);
  await sleep(1600); // (the motion check gives up after 1.2 s: touch mode)

  const layout = await pad.evaluate(() => {
    const r = document.querySelector('.remote').getBoundingClientRect();
    return { rot: document.documentElement.dataset.rot ?? '', w: Math.round(r.width), h: Math.round(r.height) };
  });
  check('turned the right way', layout.rot === v.rot, `rot ${layout.rot || 0}`);
  check('the remote fills the page', layout.w === v.w && layout.h === v.h, `${layout.w}×${layout.h}`);

  // drag on an element along the phone's own axes (device px), from its centre
  const drag = (sel, dx, dy, ms = 120) =>
    pad.evaluate(
      async ({ sel, dx, dy, ms, rot }) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2,
          cy = r.top + r.height / 2;
        // device offset → page offset for this rotation
        const page = (x, y) => (rot === '-90' ? [cx + y, cy - x] : rot === '90' ? [cx - y, cy + x] : [cx + x, cy + y]);
        const fire = (type, u) => {
          const [x, y] = page(dx * (u - 0.5), dy * (u - 0.5));
          el.dispatchEvent(new PointerEvent(type, { pointerId: 5, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        };
        fire('pointerdown', 0);
        for (let i = 1; i < 8; i++) {
          await new Promise((d) => setTimeout(d, ms / 8));
          fire('pointermove', i / 8);
        }
        await new Promise((d) => setTimeout(d, ms / 8));
        fire('pointerup', 1);
      },
      { sel, dx, dy, ms, rot: v.rot },
    );

  // tennis: a swipe right → left across the phone = a forehand
  toPad({ type: 'mode', mode: 'play', title: 'Rally!' });
  await sleep(300);
  got.length = 0;
  await drag('.swipe-zone.on', -260, 0);
  await sleep(200);
  const sw = got.find((m) => m.type === 'swing');
  check('a swipe across the phone is a forehand', sw?.side === 'fh', JSON.stringify(sw && { side: sw.side, power: sw.power }));

  // bowling: a drag straight up the phone is a straight throw
  toPad({ type: 'mode', mode: 'bowl', title: 'Your turn!' });
  await sleep(300);
  got.length = 0;
  await drag('.grip', 0, -320, 200);
  await sleep(200);
  const bw = got.find((m) => m.type === 'bowl');
  check('a drag up the phone bowls straight', bw && Math.abs(bw.angle) < 0.03 && bw.speed > 3, JSON.stringify(bw && { speed: bw.speed, angle: bw.angle }));

  // archery: a drag to the phone's right, then let go: the aim went right
  toPad({ type: 'mode', mode: 'bow', title: 'Your shot!' });
  await sleep(300);
  got.length = 0;
  await drag('.panel.bow .draw', 160, 0, 400);
  await sleep(250);
  const oris = got.filter((m) => m.type === 'ori');
  const last = oris[oris.length - 1];
  check('a drag to the phone’s right aims right', last && last.s[0] > 0.05 && Math.abs(last.s[2]) < 0.02, JSON.stringify(last?.s));
  await ctx.close();
}

await browser.close();
tv.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
