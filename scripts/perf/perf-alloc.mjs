// Where the garbage comes from: a sampling heap profile of a few seconds of play, allocation
// (bytes that were live at some point while sampling, by allocating function; short-lived
// objects that a scavenge already took are counted too, as `includeObjectsCollectedByMinorGC`).
//   node scripts/perf/perf-alloc.mjs [world] [sport] [seconds]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'plaza';
const sport = process.argv[3] || 'tennis';
const secs = +(process.argv[4] || 10);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
await tv.evaluate(([w, s]) => { window.kaleido.startAttract(w, s); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [world, sport]);
await tv.waitForTimeout(3500);
const cdp = await ctx.newCDPSession(tv);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await tv.waitForTimeout(secs * 1000);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const by = new Map();
const paths = new Map();
let total = 0;
const name = (cf) => `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber + 1}`;
(function walk(n, stack) {
  const key = name(n.callFrame);
  const st = [...stack, key];
  if (n.selfSize) {
    by.set(key, (by.get(key) || 0) + n.selfSize);
    total += n.selfSize;
    const pk = st.slice(-(+process.env.DEPTH || 5)).reverse().join(' <- ');
    paths.set(pk, (paths.get(pk) || 0) + n.selfSize);
  }
  n.children.forEach((c) => walk(c, st));
})(profile.head, []);
if (process.env.PATHS) {
  console.log('callers:');
  for (const [k, v] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, +process.env.PATHS)) console.log(`${(v / 1024).toFixed(0).padStart(7)} KB  ${k}`);
}
console.log(`${sport} in ${world}: ${(total / 1024 / 1024).toFixed(1)} MB sampled over ${secs} s (${(total / 1024 / secs / 60).toFixed(0)} KB per frame)`);
for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`${(v / 1024).toFixed(0).padStart(7)} KB  ${k}`);
await browser.close();
