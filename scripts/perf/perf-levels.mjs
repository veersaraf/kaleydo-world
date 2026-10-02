// What a quality-level change costs: the time applyQuality() takes and the frames after it
// (JS time and gap), for each pair of levels the controller can move between.
//   node scripts/perf/perf-levels.mjs [world] [sport]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'plaza';
const sport = process.argv[3] || 'tennis';
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
await tv.evaluate(([w, s]) => { const k = window.kaleido; k.startAttract(w, s); k.quality.update = () => null; if (window.flow) window.flow.attractShiftAt = 1e12; }, [world, sport]);
await tv.waitForTimeout(2500);
const rows = await tv.evaluate(async () => {
  const k = window.kaleido;
  const out = [];
  let last = 0, capture = null;
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    const a = performance.now();
    orig(now);
    const js = performance.now() - a;
    if (capture) capture.push([+(now - last).toFixed(1), +js.toFixed(1)]);
    last = now;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = [[9, 8], [8, 9], [9, 7], [7, 9], [9, 11], [11, 9], [9, 4], [4, 9], [9, 0], [0, 9]];
  for (const [from, to] of steps) {
    k.quality.level = from;
    k.applyQuality();
    await wait(900);
    capture = [];
    k.quality.level = to;
    const t0 = performance.now();
    k.applyQuality();
    const apply = performance.now() - t0;
    await wait(500);
    const c = capture;
    capture = null;
    out.push({ change: `${from}->${to}`, apply: +apply.toFixed(1), first3: c.slice(0, 3).map((x) => `gap ${x[0]} js ${x[1]}`).join(' | ') });
  }
  return out;
});
for (const r of rows) console.log(r.change.padEnd(6), 'applyQuality', String(r.apply).padStart(5), 'ms | next frames:', r.first3);
await browser.close();
