// A/B screenshots with a seeded Math.random, so both builds make the same scenery.
//   node scripts/world-ab.mjs <outDir>
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2];
const worlds = ['plaza', 'ink', 'neon', 'pixel', 'paper', 'clay', 'water', 'cosmic'];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function run(query, suffix) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    let s = 12345;
    window.__reseed = (n) => (s = n);
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true }));
  });
  const tv = await ctx.newPage();
  await tv.goto(BASE + '/' + query);
  await tv.waitForTimeout(1200);
  // build every world up front (same order in both runs), then look at each from fixed cameras
  await tv.evaluate((ws) => { const k = window.kaleido; ws.forEach((w, i) => { window.__reseed(1000 + i * 77); k.stage.get(w); }); k.paused = true; document.querySelectorAll('.screen, .hud, #ui, .ui').forEach((e) => (e.style.visibility = 'hidden')); }, worlds);
  for (const w of worlds) {
    await tv.evaluate((w) => { const k = window.kaleido; k.stage.setWorld(w); k.match.players.forEach((p) => { p.x = 50; }); }, w);
    for (const [name, c] of Object.entries({ main: { pos: [0, 5.5, 21.7], look: [0, 0.55, -4.2], fov: 38 }, far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 }, side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 } })) {
      await tv.evaluate((c) => { window.kaleido.rig.debug = c; }, c);
      await tv.waitForTimeout(200);
      await tv.screenshot({ path: `${out}/ab-${w}-${name}-${suffix}.png` });
    }
  }
  await ctx.close();
}
await run('?nobatch', 'before');
await run('', 'after');
await browser.close();
