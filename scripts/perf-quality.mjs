// How the quality controller behaves from a cold start: the level it starts at, every change it
// makes (when, why: its GPU reading and late-frame share) and the late frames while it decides.
//   node scripts/perf-quality.mjs [world] [sport] [seconds]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'plaza';
const sport = process.argv[3] || 'tennis';
const secs = +(process.argv[4] || 30);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
// a fresh player: nothing remembered
await tv.evaluate(() => { localStorage.clear(); localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })); });
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
const res = await tv.evaluate(([w, s, secs]) => new Promise((done) => {
  const k = window.kaleido;
  const t0 = performance.now();
  const ev = [];
  const gaps = [];
  let last = 0;
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    if (last) gaps.push([now - t0, now - last]);
    last = now;
    orig(now);
  };
  const uq = k.quality.update.bind(k.quality);
  k.quality.update = (now, gap, safe) => {
    const q = k.quality;
    const g = q.gpu.length ? [...q.gpu].sort((a, b) => a - b) : [];
    const from = q.level;
    const r = uq(now, gap, safe);
    if (r !== null) ev.push({ t: +((performance.now() - t0) / 1000).toFixed(1), from, to: r, gpuP50: g.length ? +g[g.length >> 1].toFixed(1) : null, gpuP75: g.length ? +g[Math.floor(g.length * 0.75)].toFixed(1) : null });
    return r;
  };
  const start = () => { k.startAttract(w, s); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; };
  start();
  const startLevel = k.quality.level;
  setTimeout(() => {
    k.frame = orig;
    k.quality.update = uq;
    const late = gaps.filter((g) => g[1] > 25);
    done({ startLevel, endLevel: k.quality.level, pr: k.pr, changes: ev, late: late.map((g) => `${(g[0] / 1000).toFixed(1)}s:${g[1].toFixed(0)}ms`), frames: gaps.length });
  }, secs * 1000);
}), [world, sport, secs]);
console.log(`${world}/${sport}: level ${res.startLevel} -> ${res.endLevel} (pr ${res.pr}); ${res.frames} frames, ${res.late.length} late (>25 ms) ${JSON.stringify(res.late)}`);
for (const c of res.changes) console.log(`  t=${c.t}s level ${c.from} -> level ${c.to} (gpu p50 ${c.gpuP50} p75 ${c.gpuP75} ms)`);
await browser.close();
