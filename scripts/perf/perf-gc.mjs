// Garbage per frame: how much JS heap each frame allocates and how often the collector runs
// (a drop in usedJSHeapSize), in each sport's CPU-vs-CPU showcase. A minor GC is a few
// hundred µs, a major one a few ms — the p99 frame time is what it shows up in.
//   node scripts/perf/perf-gc.mjs [world] [seconds] [sports]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 12);
const sports = (process.argv[4] || 'tennis,bowling,duel,archery,baseball').split(',');
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
for (const sport of sports) {
  await tv.evaluate(([w, s]) => { window.kaleido.startAttract(w, s); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [world, sport]);
  await tv.waitForTimeout(3500);
  const r = await tv.evaluate((secs) => new Promise((done) => {
    const k = window.kaleido;
    const heap = [];
    const js = [];
    const orig = k.frame.bind(k);
    k.frame = (now) => {
      const a = performance.now();
      const h0 = performance.memory.usedJSHeapSize;
      orig(now);
      js.push(performance.now() - a);
      heap.push([h0, performance.memory.usedJSHeapSize]);
    };
    setTimeout(() => {
      k.frame = orig;
      let alloc = 0, gcs = 0, frames = 0;
      let prev = heap[0][1];
      const gcFrames = [];
      for (let i = 1; i < heap.length; i++) {
        const [a, b] = heap[i];
        // between frames the heap grows (timers, events…) or drops (a collection ran)
        if (a < prev - 64 * 1024 || b < a - 64 * 1024) { gcs++; gcFrames.push(i); }
        else if (b >= a) alloc += b - a;
        prev = b;
        frames++;
      }
      // JS time of the frames a collection landed in
      const jsGc = gcFrames.map((i) => js[i]).sort((x, y) => x - y);
      const all = js.slice().sort((x, y) => x - y);
      done({ frames, allocKBperFrame: +(alloc / frames / 1024).toFixed(1), gcs, gcPerSec: +(gcs / secs).toFixed(2), jsP50: +all[all.length >> 1].toFixed(2), jsP99: +all[Math.floor(all.length * 0.99)].toFixed(2), jsMax: +all[all.length - 1].toFixed(1) });
    }, secs * 1000);
  }), secs);
  console.log(sport.padEnd(9), JSON.stringify(r));
}
await browser.close();
