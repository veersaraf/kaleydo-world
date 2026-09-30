// The catch-up cap: a frame that follows a hitch draws at most 6 sim steps (1/120 s each, 50 ms) and lets
// the rest go; a swing that arrived meanwhile is still placed where it would have been without the
// cap. Frames are stepped by hand on a virtual clock (performance.now follows it).
//   BASE=http://localhost:3370 node scripts/catchup-check.mjs
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
const out = await tv.evaluate(() => {
  const k = window.kaleido;
  const orig = k.frame.bind(k);
  k.frame = () => undefined;
  k.quality.update = () => null;
  let vt = 50000;
  performance.now = () => vt;
  k.startAttract('plaza', 'tennis');
  if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12;
  k.last = 0;
  const frame = (gap) => {
    vt += gap;
    const t0 = k.match.t;
    const s0 = k.slipped;
    orig(vt);
    return { advanced: k.match.t - t0, dropped: k.slipped - s0 };
  };
  for (let i = 0; i < 30; i++) frame(1000 / 60);
  const rows = [];
  const r = (name, gap) => {
    const f = frame(gap);
    rows.push(`${name.padEnd(26)} gap ${gap.toFixed(1).padStart(6)} ms  sim advanced ${(f.advanced * 1000).toFixed(1).padStart(5)} ms  dropped ${(f.dropped * 1000).toFixed(1).padStart(5)} ms`);
    return f;
  };
  r('normal 60 fps', 1000 / 60);
  r('30 fps', 1000 / 30);
  r('a 60 ms hitch', 60);
  r('a 100 ms hitch', 100);
  r('a 400 ms stall (clamped)', 400);
  r('normal again', 1000 / 60);
  // a swing that happened during a 100 ms frame: where the cap places it
  const m = k.match;
  const before = m.t;
  const slips0 = k.slips.length;
  vt += 100;
  orig(vt); // the hitch frame: [vt-100, vt]
  const frameSlip = k.slips[k.slips.length - 1];
  const at = (msAgo) => (vt + 5) - msAgo; // a swing at this wall time, heard 5 ms after the frame
  vt += 5;
  const place = (ageMs) => +(m.t - ageMs / 1000 + k.slippedSince(ageMs / 1000)).toFixed(4);
  const uncapped = (ageMs) => +(before + 0.1 - ageMs / 1000 + 0).toFixed(4); // the sim had advanced 100 ms
  const cases = [5, 20, 50, 85, 105].map((a) => `age ${a} ms: placed ${place(a) - before >= 0 ? '+' : ''}${((place(a) - before) * 1000).toFixed(1)} ms into the frame, uncapped sim would say ${((uncapped(a) - before) * 1000).toFixed(1)} ms`);
  void at;
  void slips0;
  return { rows, cases, frameSlip };
});
console.log(out.rows.join('\n'));
console.log('a swing that happened during a 100 ms frame, heard 5 ms after it (frame = 100 ms of wall time, 50 ms of sim):');
console.log('  ' + out.cases.join('\n  '));
console.log(logs.join('\n') || 'no page errors');
await browser.close();
