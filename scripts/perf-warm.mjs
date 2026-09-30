// What Match.warm costs: the JS time of the first frames of a match (the planner is being compiled
// in them), and how many of the first shots' frames it leaves with garbage from cold code.
//   BASE=http://localhost:3370 node scripts/perf-warm.mjs [world=plaza]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'plaza';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1500);
const res = await tv.evaluate(([w]) => new Promise((done) => {
  const k = window.kaleido;
  const rows = [];
  const orig = k.frame.bind(k);
  let first = true;
  k.frame = (now) => {
    const a = performance.now();
    const h0 = performance.memory.usedJSHeapSize;
    orig(now);
    rows.push({ js: performance.now() - a, alloc: Math.max(0, performance.memory.usedJSHeapSize - h0), left: k.match?.warmLeft, t: k.match?.t ?? 0 });
  };
  k.startAttract(w, 'tennis');
  if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12;
  setTimeout(() => { k.frame = orig; done(rows); }, 6000);
}), [world]);
// the warm-up's own cost, run by hand on a fresh match: 4 runs at a time, as the frames do
const own = await tv.evaluate(() => {
  const m = window.kaleido.match;
  m.warmLeft = 800;
  const t = [];
  for (let i = 0; i < 200; i++) { const a = performance.now(); m.warm(4); t.push(performance.now() - a); }
  return t;
});
const early = res.slice(0, 50);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
console.log(`first 50 frames: js p50 ${q(early.map((r) => r.js), 0.5).toFixed(1)} ms, p90 ${q(early.map((r) => r.js), 0.9).toFixed(1)}, max ${Math.max(...early.map((r) => r.js)).toFixed(1)}; warm-up left after frame 50: ${early[49]?.left}`);
console.log(`frames 51-150: js p50 ${q(res.slice(50, 150).map((r) => r.js), 0.5).toFixed(1)} ms, p90 ${q(res.slice(50, 150).map((r) => r.js), 0.9).toFixed(1)}, max ${Math.max(...res.slice(50, 150).map((r) => r.js)).toFixed(1)}`);
const qq = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
console.log(`warm(4) alone, 200 calls in a row: first 20 p50 ${qq(own.slice(0, 20), 0.5).toFixed(2)} ms max ${Math.max(...own.slice(0, 20)).toFixed(2)}; later p50 ${qq(own.slice(100), 0.5).toFixed(2)} ms max ${Math.max(...own.slice(100)).toFixed(2)}`);
await browser.close();
