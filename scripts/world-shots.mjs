// Deterministic screenshots of every world from fixed cameras (visual A/B).
//   node scripts/world-shots.mjs <outDir> <suffix> [query]
//   WORLDS=plaza,park  only these; SPORT=duel  a sport's showcase instead of tennis
// Frames are stepped by hand on a virtual clock with seeded randomness, so two runs of the same
// build give the same pixels and a difference between two builds is a real one.
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const [out, suffix, query = ''] = process.argv.slice(2);
const worlds = (process.env.WORLDS || 'plaza,ink,neon,pixel,paper,clay,water,cosmic,park').split(',');
const sport = process.env.SPORT || 'tennis';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
// seeded randomness (the scenery, crowds…, is built from it; each world is rebuilt from a fresh seed below)
await ctx.addInitScript(() => {
  let a = 12345;
  let u = 999;
  const next = (x) => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return [x, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
  };
  window.__seed = (x) => (a = x);
  // (three's object ids draw random numbers too: a build that makes one more object must not shift the game's stream)
  Math.random = () => {
    if (new Error().stack.includes('generateUUID')) {
      const [x, v] = next(u);
      u = x;
      return v;
    }
    const [x, v] = next(a);
    a = x;
    return v;
  };
});
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/' + query);
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/' + query);
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
await tv.evaluate(() => {
  const k = window.kaleido;
  window.__orig = k.frame.bind(k);
  k.frame = () => undefined; // the real loop idles; frames are stepped below
  k.quality.update = () => null;
  window.__vt = 5000;
  window.__step = (n) => {
    for (let i = 0; i < n; i++) window.__orig((window.__vt += 1000 / 60));
  };
});
const cams = {
  main: { pos: [0, 5.5, 21.7], look: [0, 0.55, -4.2], fov: 38 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
};
for (const w of worlds) {
  await tv.evaluate(([w, sport]) => {
    const k = window.kaleido;
    // (the world is built again from the seed: how many random numbers boot used up depends on the build's timing)
    if (k.stage.current?.def.id === w) k.startAttract(k.stage.defs.find((d) => d.id !== w).id, sport);
    k.stage.cache.delete(w);
    window.__seed(12345);
    k.rng.s = 777;
    k.realT = 0;
    k.last = 0;
    window.__vt = 5000;
    k.rig.debug = null;
    k.startAttract(w, sport);
    if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12;
    document.querySelectorAll('.screen, .hud').forEach((e) => (e.style.display = 'none'));
    window.__step(150);
  }, [w, sport]);
  for (const [name, c] of Object.entries(cams)) {
    await tv.evaluate((c) => {
      window.kaleido.rig.debug = c;
      window.__step(4);
    }, c);
    await tv.screenshot({ path: `${out}/ws-${w}-${name}-${suffix}.png` });
  }
  const st = await tv.evaluate(() => window.kaleido.stage.current.batchStats);
  console.log(w, JSON.stringify(st));
}
console.log(logs.join('\n'));
await browser.close();
