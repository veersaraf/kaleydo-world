// Draw calls per world + a JS CPU profile (self time by function) for one world.
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const worlds = (process.argv[2] || 'plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
const profWorld = process.argv[3] || 'ink';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForTimeout(2000);
for (const w of worlds) {
  await tv.evaluate((w) => window.kaleido.startAttract(w), w);
  await tv.waitForTimeout(1200);
  const info = await tv.evaluate(() => {
    const k = window.kaleido;
    const r = k.renderer;
    r.info.autoReset = false;
    r.info.reset();
    k.frame(performance.now() + 16);
    const calls = r.info.render.calls, tris = r.info.render.triangles;
    r.info.autoReset = true;
    let objs = 0, meshes = 0, casters = 0, auto = 0;
    k.stage.current.scene.traverse((o) => { objs++; if (o.isMesh) meshes++; if (o.castShadow) casters++; if (o.matrixAutoUpdate) auto++; });
    return { calls, tris, objs, meshes, casters, auto, programs: r.info.programs.length, geos: r.info.memory.geometries, tex: r.info.memory.textures };
  });
  console.log(w.padEnd(7), JSON.stringify(info));
}
// CPU profile
await tv.evaluate((w) => window.kaleido.startAttract(w), profWorld);
await tv.waitForTimeout(1500);
const cdp = await ctx.newCDPSession(tv);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await tv.waitForTimeout(4000);
const { profile } = await cdp.send('Profiler.stop');
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = {};
for (let i = 0; i < profile.samples.length; i++) dt[profile.samples[i]] = (dt[profile.samples[i]] || 0) + (profile.timeDeltas[i] || 0);
let total = 0;
for (const n of profile.nodes) {
  const t = (dt[n.id] || 0) / 1000;
  total += t;
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + t);
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28);
console.log(`\nCPU profile of ${profWorld} (${(total / 1000).toFixed(2)} s sampled, 4 s wall):`);
for (const [k, v] of top) console.log(`${(v).toFixed(0).padStart(6)} ms  ${k}`);
await browser.close();
