// Screenshots of the ballpark preview (field-preview.html) in every world.
//
//   node scripts/field-preview-shots.mjs <outDir> [worlds=park,plaza,…] [shots=name,name…|all]
//   node scripts/field-preview-shots.mjs <outDir> --url '<query>' <name>   (one custom shot)
//   GPU=1  also measures each world's GPU cost of the park (in-page A/B, park on/off
//          on alternate frames) at PR (default 1.5) and FX (default 2): quality 8
//
// A shot is a moment of the preview's scripted turn seen from one camera:
//   bat     the batting camera, behind the catcher     flight  behind and above the batted ball
//   wide    the whole park from high behind third      high    straight down the middle from above
//   stands  this turn's home runs, from centre field   side    the mound and the plate from first
//   plate / mound / wall / pole / reverse              close-ups (reverse: from the mound, looking in)
// The page is frozen at each moment (window.field.seek), so the images are
// repeatable. Each world also prints the park's draw calls and CPU cost.
// BASE defaults to a dev server started with PORT=4300:
//   PORT=4300 HTTPS_PORT=4743 HMR_PORT=25900 node server/server.mjs --dev

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:4300';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 720);
const args = process.argv.slice(2);
const out = args[0] || '/tmp/field-shots';
fs.mkdirSync(out, { recursive: true });

/** name → [camera, pitch, moment, seconds after it] (pitches and moments: window.field.timings()) */
const SHOTS = {
  // the batting camera through a turn
  'bat-idle': ['bat', 'take', 'windup', 0.4],
  'bat-pitch': ['bat', 'take', 'release', 0.2],
  'bat-plate': ['bat', 'take', 'release', 0.4],
  'bat-catch': ['bat', 'take', 'land', 0.05],
  'bat-contact': ['bat', 'homer', 'contact', 0.04],
  'bat-homer': ['bat', 'homer', 'contact', 1.3],
  'bat-out': ['bat', 'homer', 'out', 0.9],
  'bat-fly': ['bat', 'fly', 'land', 0.1],
  'bat-foul': ['bat', 'foul', 'land', 0.2],
  'bat-bomb': ['bat', 'bomb', 'out', 1.2],
  'bat-marks': ['bat', 'bomb', 'end', -0.3],
  // following the ball out
  'flight-early': ['flight', 'homer', 'contact', 0.7],
  'flight-out': ['flight', 'homer', 'out', 0.02],
  'flight-fw': ['flight', 'homer', 'out', 1.3],
  'flight-fly': ['flight', 'fly', 'land', 0.06],
  'flight-wall': ['flight', 'wall', 'land', 0.08],
  'flight-bomb': ['flight', 'bomb', 'out', 0.4],
  // the park
  wide: ['wide', 'bomb', 'land', 1.2],
  'wide-fw': ['wide', 'homer', 'out', 1.3],
  high: ['high', 'fly', 'land', 0.4],
  stands: ['stands', 'bomb', 'land', 1.2],
  side: ['side', 'take', 'release', 0.25],
  plate: ['plate', 'take', 'windup', 0.3],
  mound: ['mound', 'take', 'windup', 0.3],
  wall: ['wall', 'take', 'windup', 0.3],
  pole: ['pole', 'take', 'windup', 0.3],
  reverse: ['reverse', 'take', 'windup', 0.3],
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// In a git worktree node_modules is often a symlink to another checkout, whose
// font files the dev server won't serve (outside its allow list): hand them over directly.
await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
  const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
  if (fs.existsSync(file)) route.fulfill({ path: file });
  else route.continue();
});
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

async function open(query) {
  await page.goto(`${BASE}/field-preview.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.field?.ready === true, null, { timeout: 60000 }).catch(() => {});
  // the wall's lettering repaints once the web fonts are in
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

if (args[1] === '--url') {
  // e.g. 'world=park&t=10.35&cam=bat' (t = seconds into the cycle)
  const q = new URLSearchParams(args[2] || '');
  await open(`${q.toString()}&still=1&pr=1`);
  const url = await page.evaluate(([t, cam]) => window.field.capture(t, cam), [Number(q.get('t') ?? 0), q.get('cam') ?? 'bat']);
  fs.writeFileSync(path.join(out, `${args[3] || 'custom'}.png`), Buffer.from(url.split(',')[1], 'base64'));
} else {
  const worlds = (args[1] || 'park,plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
  const names = !args[2] || args[2] === 'all' ? Object.keys(SHOTS) : args[2].split(',');
  const extra = process.env.Q ? `&${process.env.Q}` : '';
  for (const w of worlds) {
    await open(`world=${w}&still=1&pr=1${extra}`);
    for (const n of names) {
      const s = SHOTS[n];
      if (!s) {
        console.log('no such shot:', n);
        continue;
      }
      const [cam, pitch, moment, off] = s;
      // read the canvas in the page right after drawing (a page screenshot of WebGL takes seconds)
      const url = await page.evaluate(([cam, pitch, moment, off]) => window.field.capture(window.field.at(pitch, moment, off), cam), [cam, pitch, moment, off]);
      fs.writeFileSync(path.join(out, `${w}-${n}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
    const stats = await page.evaluate(() => {
      window.field.seek(window.field.at('homer', 'out', 0.9), 'bat');
      return { ...window.field.stats(), ...window.field.perf(300) };
    });
    console.log(w, JSON.stringify(stats));
  }
  if (process.env.GPU) {
    // quality 8: pr 1.5, effects tier 2, on a 2× (Retina-like) page
    const gctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await gctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
      const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
      if (fs.existsSync(file)) route.fulfill({ path: file });
      else route.continue();
    });
    const gp = await gctx.newPage();
    for (const w of worlds) {
      await gp.goto(`${BASE}/field-preview.html?world=${w}&still=1&pr=${process.env.PR || 1.5}&fx=${process.env.FX || 2}`, { waitUntil: 'load' });
      await gp.waitForFunction(() => window.field?.ready === true, null, { timeout: 60000 }).catch(() => {});
      await gp.waitForTimeout(800);
      for (const [cam, pitch, moment, off] of [
        ['bat', 'take', 'release', 0.25],
        ['bat', 'homer', 'out', 0.9],
        ['wide', 'bomb', 'land', 1.2],
      ]) {
        const r = await gp.evaluate(
          async ([cam, pitch, moment, off]) => {
            window.field.seek(window.field.at(pitch, moment, off), cam);
            return window.field.gpu(Number(400), cam);
          },
          [cam, pitch, moment, off],
        );
        console.log(w, `${cam}@${pitch}.${moment}`, JSON.stringify(r));
      }
    }
    await gctx.close();
  }
}
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
