// Screenshots of the archery preview (archery-preview.html) in every world.
//
//   node scripts/shots/archery-preview-shots.mjs <outDir> [worlds=park,plaza,…] [shots=name,name…|all]
//   node scripts/shots/archery-preview-shots.mjs <outDir> --url '<query>' <name>   (one custom shot)
//
// A shot is a moment of the preview's scripted end seen from one camera:
//   play    the gameplay view: behind and off the draw shoulder, low, down the range
//   aim     the same pushed in while drawing (the zoom the game can do as you draw)
//   side    the archer from the side      front  the archer from down the range
//   chase   behind the flying arrow       target a close-up of the face being shot at
//   wide    the whole range
// The page is frozen at each moment (window.range.seek), so the images are
// repeatable. Each world also prints the range's draw calls and CPU cost.
// BASE defaults to a dev server started with PORT=3600:
//   PORT=3600 HTTPS_PORT=4043 HMR_PORT=25200 node server/server.mjs --dev

import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 720);
const args = process.argv.slice(2);
const out = args[0] || '/tmp/archery-shots';
fs.mkdirSync(out, { recursive: true });

/** name → [camera, shot, moment, seconds after it] (shots and moments: window.range.timings()) */
const SHOTS = {
  // the gameplay camera through a shot
  'play-idle': ['play', 'bullseye', 'nock', -0.4],
  'play-nock': ['play', 'bullseye', 'nock', 0.45],
  'play-draw': ['play', 'bullseye', 'draw', 0.45],
  'play-hold': ['play', 'bullseye', 'hold', 0.5],
  'play-flight': ['play', 'far', 'flight', 0],
  'play-hit': ['play', 'bullseye', 'hit', 0.12],
  'play-cheer': ['play', 'bullseye', 'react', 0.5],
  'play-balloon': ['play', 'balloon', 'hold', 0.3],
  'play-pop': ['play', 'balloon', 'flight', 0.12],
  'play-tower': ['play', 'tower', 'hold', 0.4],
  'play-swing': ['play', 'swinging', 'hold', 0.5],
  'play-sad': ['play', 'miss', 'react', 0.6],
  'play-end': ['play', 'backstop', 'react', 1.0],
  'aim-hold': ['aim', 'far', 'hold', 0.6],
  'aim-tower': ['aim', 'tower', 'hold', 0.5],
  // the archer from the side
  'side-idle': ['side', 'bullseye', 'nock', -0.4],
  'side-nock-take': ['side', 'bullseye', 'nock', 0.38],
  'side-nock-seat': ['side', 'bullseye', 'nock', 0.6],
  'side-set': ['side', 'bullseye', 'nock', 0.82],
  'side-draw': ['side', 'bullseye', 'draw', 0.35],
  'side-hold': ['side', 'bullseye', 'hold', 0.5],
  'side-high': ['side', 'tower', 'hold', 0.4],
  'side-release': ['side', 'bullseye', 'release', 0.04],
  'side-follow': ['side', 'bullseye', 'release', 0.2],
  'side-watch': ['side', 'far', 'hit', 0.2],
  'side-cheer': ['side', 'bullseye', 'react', 0.4],
  'side-sad': ['side', 'miss', 'react', 0.7],
  'front-hold': ['front', 'bullseye', 'hold', 0.5],
  'front-cheer': ['front', 'tower', 'react', 0.45],
  // following an arrow
  'chase-early': ['chase', 'far', 'release', 0.12],
  'chase-late': ['chase', 'far', 'hit', -0.1],
  'chase-pop': ['chase', 'balloon', 'flight', 0.05],
  // close-ups
  'target-10': ['target', 'bullseye', 'hit', 0.05],
  'target-10-after': ['target', 'bullseye', 'react', 1.0],
  'target-tower': ['target', 'tower', 'react', 0.3],
  'target-swing': ['target', 'swinging', 'react', 0.4],
  'target-balloon': ['target', 'balloon', 'hold', 0.2],
  'target-popped': ['target', 'balloon', 'hit', -0.05],
  'target-lawn': ['target', 'miss', 'react', 0.4],
  'target-backstop': ['target', 'backstop', 'react', 0.4],
  // the wind: a flag in a breeze each way, and dropping in a lull
  'flags-right': ['flags', 'bullseye', 'nock', 0.3],
  'flags-lull': ['flags', 'balloon', 'hit', 0.4],
  'flags-left': ['flags', 'far', 'nock', 0],
  wide: ['wide', 'backstop', 'react', 0.6],
};

const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
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
  await page.goto(`${BASE}/archery-preview.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.range?.ready === true, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(400);
}

if (args[1] === '--url') {
  // e.g. 'world=park&handed=-1&t=10.35&cam=play' (t = seconds into the cycle)
  const q = new URLSearchParams(args[2] || '');
  await open(`${q.toString()}&still=1`);
  const url = await page.evaluate(([t, cam]) => window.range.capture(t, cam), [Number(q.get('t') ?? 0), q.get('cam') ?? 'play']);
  fs.writeFileSync(path.join(out, `${args[3] || 'custom'}.png`), Buffer.from(url.split(',')[1], 'base64'));
} else {
  const worlds = (args[1] || 'park,plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
  const names = !args[2] || args[2] === 'all' ? Object.keys(SHOTS) : args[2].split(',');
  const extra = process.env.Q ? `&${process.env.Q}` : '';
  for (const w of worlds) {
    await open(`world=${w}&still=1${extra}`);
    for (const n of names) {
      const s = SHOTS[n];
      if (!s) {
        console.log('no such shot:', n);
        continue;
      }
      const [cam, shot, moment, off] = s;
      // read the canvas in the page right after drawing (a page screenshot of WebGL takes seconds)
      const url = await page.evaluate(([cam, shot, moment, off]) => window.range.capture(window.range.at(shot, moment, off), cam), [cam, shot, moment, off]);
      fs.writeFileSync(path.join(out, `${w}-${n}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
    const stats = await page.evaluate(() => {
      window.range.seek(window.range.at('backstop', 'react', 0.6), 'play');
      return { ...window.range.stats(), ...window.range.perf(300) };
    });
    console.log(w, JSON.stringify(stats));
  }
}
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
