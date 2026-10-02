// The kaleidoscope shatter into the next world, the way the game does it (the next world is
// warmed a few seconds ahead): frame gaps and JS time through the transition, per world pair.
//   node scripts/perf/perf-shift.mjs [worlds] [sport]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const worlds = (process.argv[2] || 'plaza,ink,neon,pixel,paper,clay,water,cosmic,park').split(',');
const sport = process.argv[3] || 'tennis';
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1500);
await tv.evaluate(([w, s]) => { const k = window.kaleido; k.startAttract(w, s); k.quality.update = () => null; if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [worlds[0], sport]);
await tv.waitForTimeout(2500);
const stat = (a) => { const s = [...a].sort((x, y) => x - y); return `p50 ${s[s.length >> 1].toFixed(1)} p99 ${s[Math.floor(s.length * 0.99)].toFixed(1)} max ${s[s.length - 1].toFixed(1)}`; };
for (let i = 1; i < worlds.length; i++) {
  const next = worlds[i];
  // warm it as the game does, then let a second go by
  await tv.evaluate((id) => window.kaleido.stage.warm(id, window.kaleido.rig.cam), next);
  await tv.waitForTimeout(1500);
  const r = await tv.evaluate((id) => new Promise((done) => {
    const k = window.kaleido;
    const rows = [];
    let last = 0;
    const orig = k.frame.bind(k);
    k.frame = (now) => {
      const a = performance.now();
      orig(now);
      rows.push([last ? now - last : 0, performance.now() - a]);
      last = now;
    };
    k.stage.setWorld(id, { transition: true });
    setTimeout(() => { k.frame = orig; done(rows); }, 2200);
  }), next);
  const gaps = r.slice(1).map((x) => x[0]);
  const js = r.map((x) => x[1]);
  console.log(`-> ${next.padEnd(7)} gap ${stat(gaps)} | js ${stat(js)} | >25ms: ${gaps.filter((g) => g > 25).length}`);
}
await browser.close();
