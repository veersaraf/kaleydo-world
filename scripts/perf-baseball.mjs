// Frame times through a CPU home run derby (pitches, flights, home runs, replays):
// the median and 95th-percentile frame and how many frames ran late.
//   node scripts/perf-baseball.mjs [world] [seconds]
import { chromium } from 'playwright-core';
import { programProbe, programReport } from './lib/perf-probe.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'park';
const secs = +(process.argv[3] || 25);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: +(process.env.DPR || 2) })).newPage();
const errs = [];
tv.on('pageerror', (e) => errs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
// the menu's showcase: two CPU sluggers
await tv.evaluate((w) => window.kaleido.startAttract(w, 'baseball'), world);
await tv.waitForTimeout(3000);
await tv.evaluate(programProbe);
const r = await tv.evaluate((secs) => new Promise((done) => {
  const d = [];
  let last = performance.now();
  const t0 = last;
  const f = (now) => {
    d.push(now - last);
    last = now;
    if (now - t0 < secs * 1000) requestAnimationFrame(f);
    else done({ d, q: window.kaleido.quality?.level ?? null });
  };
  requestAnimationFrame(f);
}), secs);
const s = r.d.slice().sort((a, b) => a - b);
const pct = (p) => s[Math.floor((s.length - 1) * p)].toFixed(1);
console.log(`${world}: ${s.length} frames · p50 ${pct(0.5)} ms · p95 ${pct(0.95)} ms · late (>25 ms) ${r.d.filter((x) => x > 25).length} · quality ${JSON.stringify(r.q)}`);
console.log(errs.join('\n') || 'no errors');
console.log('shader programs built during play:', JSON.stringify(await tv.evaluate(programReport)));
await browser.close();
