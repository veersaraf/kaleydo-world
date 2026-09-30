// Garbage per planFrom / predictPath call in the browser: cold (the first calls), then after warm-up.
//   BASE=http://localhost:3370 node scripts/perf-planner.mjs
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1500);
const out = await tv.evaluate(() => {
  const k = window.kaleido;
  const m = k.match;
  const p = m.players[0];
  const heap = () => performance.memory.usedJSHeapSize;
  const res = [];
  const plan = () => p.planFrom(m.path, m.t, 0.1, { mustBounce: false, doubles: false });
  const measure = (label, n) => {
    window.gc?.();
    const h0 = heap();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) plan();
    const ms = (performance.now() - t0) / n;
    res.push(`${label}: ${((heap() - h0) / n / 1024).toFixed(2)} KB and ${ms.toFixed(3)} ms per planFrom (path ${m.path.n} samples)`);
  };
  measure('first 5', 5);
  measure('next 20', 20);
  measure('next 100', 100);
  measure('next 300', 300);
  measure('next 300', 300);
  return res;
});
console.log(out.join('\n'));
await browser.close();
