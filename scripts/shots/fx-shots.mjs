// Deterministic screenshots for judging lighting and post effects: a seeded
// Math.random (both builds make the same scenery), the players standing on
// court, fixed cameras from the broadcast view down to a close-up and one
// looking into the sun.
//   node scripts/shots/fx-shots.mjs <outDir> <suffix> [worlds] [query]
//   FX=<tier>     set the effects tier before the shots (see render/quality.ts)
//   PR=<ratio>    render scale (default 1.5, the park budget's reference)
//   MSAA=<n>      MSAA samples (default 4)
//   EVAL=<js>     run with (k = the app, w = the world) before each world's shots
//   DPR=2         shoot at a Retina Mac's device resolution (judging anti-aliasing)
//   CAMS=a,b      only these cameras (main, far, side, close, sun)
import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3000';
const [out, suffix, list = 'park,plaza,water,clay', query = ''] = process.argv.slice(2);
const worlds = list.split(',');
const PR = +(process.env.PR || 1.5);
const MSAA = +(process.env.MSAA ?? 4);
// DPR=2 shoots at a Retina Mac's device resolution (for judging anti-aliasing)
const DPR = +(process.env.DPR || 1);
fs.mkdirSync(out, { recursive: true });
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: DPR });
await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
  const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
  if (fs.existsSync(file)) route.fulfill({ path: file });
  else route.continue();
});
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
  localStorage.removeItem('kaleido.quality');
});
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
tv.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
await tv.goto(BASE + '/' + query);
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 }).catch(() => {});
await tv.waitForTimeout(1200);
const cams = {
  main: { pos: [0, 5.5, 21.7], look: [0, 0.55, -4.2], fov: 38 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  close: { pos: [3.2, 1.5, 16.2], look: [-0.6, 0.9, 11.2], fov: 34 },
  sun: { pos: [6, 1.3, 14], look: [-4, 6.5, -8], fov: 50 },
};
await tv.evaluate(({ ws, fx, pr, msaa }) => {
  const k = window.kaleido;
  k.quality.update = () => null;
  if (fx !== null) k.setEffects?.(fx);
  k.pr = pr;
  k.stage.msaa = msaa;
  k.resize();
  window.flow && (window.flow.attractShiftAt = 1e12);
  // (re)build each world from its own seed, so two builds make the same scenery
  // even if one of them draws more random numbers at startup
  ws.forEach((w, i) => {
    window.__reseed(1000 + i * 77);
    k.stage.cache.delete(w);
    k.stage.get(w);
  });
  document.querySelectorAll('.screen, .hud, #ui, .ui, .toast').forEach((e) => (e.style.visibility = 'hidden'));
}, { ws: worlds, fx: process.env.FX !== undefined ? +process.env.FX : null, pr: PR, msaa: MSAA });
for (const w of worlds) {
  await tv.evaluate((w) => {
    const k = window.kaleido;
    k.startAttract(w);
    k.stage.setWorld(w);
    k.paused = true;
  }, w);
  if (process.env.EVAL) await tv.evaluate((src) => new Function('k', 'w', src)(window.kaleido, window.kaleido.stage.current), process.env.EVAL);
  await tv.waitForTimeout(500);
  const only = process.env.CAMS ? process.env.CAMS.split(',') : null;
  for (const [name, c] of Object.entries(cams)) {
    if (only && !only.includes(name)) continue;
    await tv.evaluate((c) => (window.kaleido.rig.debug = c), c);
    await tv.waitForTimeout(250);
    await tv.screenshot({ path: `${out}/${w}-${name}-${suffix}.png` });
  }
}
console.log(logs.join('\n') || 'ok');
await browser.close();
