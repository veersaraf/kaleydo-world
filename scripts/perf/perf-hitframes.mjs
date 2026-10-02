// JS time of the frames a shot is struck in (the hit-stop, the camera kick, the sound and the
// replanning all land there) against the frames around them, in a CPU-vs-CPU tennis showcase, and
// the garbage those frames make. Reads only: the loop runs as it does.
//   BASE=http://localhost:3370 node scripts/perf/perf-hitframes.mjs [world=plaza] [seconds=30]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 30);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
await tv.evaluate(([w]) => { window.kaleido.startAttract(w, 'tennis'); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [world]);
await tv.waitForTimeout(3500);
const r = await tv.evaluate((secs) => new Promise((done) => {
  const k = window.kaleido;
  const rows = [];
  let hit = false;
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => { if (e.type === 'hit') hit = true; return oe(e); };
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    hit = false;
    const h0 = performance.memory.usedJSHeapSize;
    const a = performance.now();
    orig(now);
    const js = performance.now() - a;
    rows.push({ js, hit, alloc: Math.max(0, performance.memory.usedJSHeapSize - h0) });
  };
  setTimeout(() => { k.frame = orig; k.onMatchEvent = oe; done(rows); }, secs * 1000);
}), secs);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
const H = r.filter((x) => x.hit), O = r.filter((x) => !x.hit);
const f = (a) => `p50 ${q(a, 0.5).toFixed(2)}  p90 ${q(a, 0.9).toFixed(2)}  max ${Math.max(...a).toFixed(1)}`;
console.log(`${r.length} frames, ${H.length} with a hit`);
console.log('js ms, hit frames:  ', f(H.map((x) => x.js)));
console.log('js ms, other frames:', f(O.map((x) => x.js)));
console.log('garbage KB, hit frames:  ', f(H.map((x) => x.alloc / 1024)));
console.log('garbage KB, other frames:', f(O.map((x) => x.alloc / 1024)));
await browser.close();
