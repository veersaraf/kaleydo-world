// Deterministic screenshots of every world from fixed cameras (visual A/B).
//   node scripts/world-shots.mjs <outDir> <suffix> [query]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const [out, suffix, query = ''] = process.argv.slice(2);
const worlds = ['plaza', 'ink', 'neon', 'pixel', 'paper', 'clay', 'water', 'cosmic'];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/' + query);
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/' + query);
await tv.waitForTimeout(1500);
const cams = {
  main: { pos: [0, 5.5, 21.7], look: [0, 0.55, -4.2], fov: 38 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
};
for (const w of worlds) {
  await tv.evaluate((w) => { const k = window.kaleido; k.startAttract(w); k.paused = true; document.querySelectorAll('.screen, .hud').forEach((e) => (e.style.display = 'none')); }, w);
  await tv.waitForTimeout(700);
  for (const [name, c] of Object.entries(cams)) {
    await tv.evaluate((c) => { const k = window.kaleido; k.rig.debug = c; }, c);
    await tv.waitForTimeout(250);
    await tv.screenshot({ path: `${out}/ws-${w}-${name}-${suffix}.png` });
  }
  const st = await tv.evaluate(() => window.kaleido.stage.current.batchStats);
  console.log(w, JSON.stringify(st));
}
console.log(logs.join('\n'));
await browser.close();
