// Garbage and time of holding a pose for a stop-motion frame: the JSON round trip clay used to
// do at each of its 12 ticks a second, against copyPose into pooled poses.
//   node scripts/perf-pose-clone.mjs
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const tv = await (await browser.newContext()).newPage();
await tv.goto(BASE + '/');
const r = await tv.evaluate(async () => {
  const { newPose, copyPose } = await import('/src/tv/chars/pose.ts');
  const src = [newPose(), newPose()];
  const N = 1500; // (small enough that no scavenge runs inside a measurement)
  const heap = () => performance.memory.usedJSHeapSize;
  const measure = (fn) => {
    // (the heap's growth over a run with no collection in it is the garbage; the best of several runs)
    let best = { bytesPerTick: 0, usPerTick: 1e9 };
    for (let rep = 0; rep < 12; rep++) {
      gc();
      const h0 = heap();
      const t0 = performance.now();
      for (let i = 0; i < N; i++) fn();
      const dt = performance.now() - t0;
      const grew = heap() - h0;
      if (grew > 0) best.bytesPerTick = Math.max(best.bytesPerTick, Math.round(grew / N));
      best.usPerTick = Math.min(best.usPerTick, +((dt / N) * 1000).toFixed(2));
    }
    return best;
  };
  let keep;
  const json = measure(() => (keep = src.map((p) => JSON.parse(JSON.stringify(p)))));
  const pool = [newPose(), newPose()];
  const copy = measure(() => { for (let i = 0; i < 2; i++) copyPose(pool[i], src[i]); });
  return { json, copy, note: 'two players, per tick (12 a second)' };
});
console.log(JSON.stringify(r));
await browser.close();
