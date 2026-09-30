// The per-world walk over the scene that looks for materials not yet compiled (World.tidyMaterials):
// how many nodes it visits, what one walk costs, and how many frames of play run one, per sport.
//   node scripts/perf-walk.mjs [world] [seconds] [sports]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 8);
const sports = (process.argv[4] || 'tennis,bowling,duel,archery,baseball').split(',');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
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
  const r = await tv.evaluate(
    (secs) =>
      new Promise((done) => {
        const k = window.kaleido;
        const w = k.stage.current;
        let calls = 0, ms = 0, frames = 0, nodes = 0;
        const orig = w.tidyMaterials.bind(w);
        w.tidyMaterials = () => {
          const t0 = performance.now();
          orig();
          ms += performance.now() - t0;
          calls++;
        };
        const f = k.frame.bind(k);
        k.frame = (now) => { frames++; f(now); };
        w.scene.traverse(() => nodes++);
        setTimeout(() => {
          k.frame = f;
          delete w.tidyMaterials;
          done({ nodes, frames, walks: calls, walkMsTotal: +ms.toFixed(2), walkMsPerCall: +(ms / Math.max(1, calls)).toFixed(3), msPerFrame: +(ms / Math.max(1, frames)).toFixed(3) });
        }, secs * 1000);
      }),
    secs,
  );
  console.log(sport.padEnd(9), JSON.stringify(r));
}
await browser.close();
