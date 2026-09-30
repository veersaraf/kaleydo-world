// Where a hit frame's garbage is made: the parts of the sim step that strike a shot (resolveHit
// and, inside it, the new flight's path, the replan, the `hit` event's handlers: sound, camera,
// particles, HUD), the rest of the sim step, and the rest of the frame (animators, camera,
// render). Heap growth in each, medians over the frames with a hit, in a CPU-vs-CPU showcase.
//   BASE=http://localhost:3370 node scripts/perf-hitsplit.mjs [world=plaza] [seconds=30]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 30);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
await tv.evaluate(([w]) => { window.kaleido.startAttract(w, 'tennis'); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [world]);
await tv.waitForTimeout(3500);
const rows = await tv.evaluate((secs) => new Promise((done) => {
  const k = window.kaleido;
  const heap = () => performance.memory.usedJSHeapSize;
  const out = [];
  let cur = null;
  const m = k.match;
  // wrap a method: heap growth inside it (and what it calls) is added to cur[name]
  const wrap = (name) => {
    const f = m[name].bind(m);
    m[name] = (...a) => {
      const h0 = heap();
      const r = f(...a);
      if (cur) cur[name] = (cur[name] || 0) + Math.max(0, heap() - h0);
      return r;
    };
  };
  for (const n of ['step', 'resolveHit', 'newFlight', 'replan', 'stepPlayers', 'stepBall']) wrap(n);
  const oe = m.onEvent;
  m.onEvent = (e) => {
    const h0 = heap();
    const r = oe(e);
    if (cur && e.type === 'hit') { cur.hit = true; cur.handlers = (cur.handlers || 0) + Math.max(0, heap() - h0); }
    return r;
  };
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    cur = { hit: false };
    const h0 = heap();
    orig(now);
    cur.total = Math.max(0, heap() - h0);
    out.push(cur);
    cur = null;
  };
  setTimeout(() => { k.frame = orig; done(out); }, secs * 1000);
}), secs);
const H = rows.filter((r) => r.hit), O = rows.filter((r) => !r.hit);
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b[b.length >> 1] / 1024).toFixed(1) : 'n/a'; };
const line = (set) => ['total', 'step', 'resolveHit', 'newFlight', 'replan', 'handlers', 'stepPlayers', 'stepBall'].map((n) => `${n} ${med(set.map((r) => r[n] || 0))}`).join('  ');
console.log(`${rows.length} frames, ${H.length} with a hit (KB of heap growth, median)`);
console.log('hit frames:   ', line(H));
console.log('other frames: ', line(O));
await browser.close();
