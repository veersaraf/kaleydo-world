// Screenshots of the sword-duel preview (duel-preview.html) in every world.
//
//   node scripts/shots/duel-preview-shots.mjs <outDir> [worlds=park,plaza,…] [shots=name,name…|all]
//   node scripts/shots/duel-preview-shots.mjs <outDir> --url '<query>' <name>   (one custom shot)
//
// A shot is a moment of the preview's scripted fight seen from one camera:
//   play  the gameplay view, behind fighter 0 over the sword shoulder
//   brief the brief's exact gameplay camera (fighter 0's head hides fighter 1)
//   side  from the side of the platform
//   far   behind fighter 1 (the far player's half of a split screen)
//   wide  the whole arena        low  down by the hazard's surface
// The page is frozen at each moment (window.duel.seek), so the images are
// repeatable. BASE defaults to a dev server started with PORT=3600:
//   PORT=3600 HTTPS_PORT=4043 HMR_PORT=25200 node server/server.mjs --dev

import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 720);
const args = process.argv.slice(2);
const out = args[0] || '/tmp/duel-shots';
fs.mkdirSync(out, { recursive: true });

/** name → [camera, segment, seconds into it] (segments: window.duel.timings()) */
const SHOTS = {
  'walk-on': ['side', 'walk-on', 0.7],
  idle: ['play', 'idle', 1.0],
  ready: ['play', 'ready', 0.8],
  'guard-upright': ['play', 'guard upright', 0.8],
  'guard-level': ['play', 'guard level', 0.8],
  'guard-diag-left': ['play', 'guard diag-left', 0.8],
  'guard-diag-right': ['play', 'guard diag-right', 0.8],
  'windup-chop': ['play', 'slash chop', 0.42],
  'slash-chop': ['play', 'slash chop', 0.52],
  'windup-right': ['play', 'slash right', 0.42],
  'slash-right': ['play', 'slash right', 0.53],
  'windup-left': ['play', 'slash left', 0.42],
  'windup-up': ['play', 'slash up', 0.42],
  'windup-down-left': ['play', 'slash down-left', 0.42],
  'windup-up-right': ['play', 'slash up-right', 0.42],
  thrust: ['play', 'thrust', 0.52],
  hit: ['play', 'hit', 0.42],
  block: ['play', 'block', 0.56],
  stunned: ['play', 'block', 1.3],
  clash: ['play', 'clash', 0.5],
  fall: ['play', 'fall', 1.0],
  splash: ['play', 'fall', 1.75],
  win: ['play', 'win-lose', 0.6],
  'side-guard': ['side', 'guard level', 0.8],
  'side-windup': ['side', 'slash right', 0.42],
  'side-slash': ['side', 'slash chop', 0.52],
  'side-stagger': ['side', 'hit', 0.5],
  'side-stunned': ['side', 'block', 1.4],
  'side-fall': ['side', 'fall', 0.95],
  'side-lose': ['side', 'win-lose', 1.4],
  'far-guard': ['far', 'guard upright', 0.8],
  'far-slash': ['far', 'hit', 0.3],
  'brief-ready': ['brief', 'ready', 0.8],
  'brief-windup': ['brief', 'slash chop', 0.42],
  sinking: ['wide', 'final', 0.75],
  final: ['wide', 'final', 3.2],
  'low-splash': ['low', 'fall', 1.6],
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
  await page.goto(`${BASE}/duel-preview.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.duel?.ready === true, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(400);
}

if (args[1] === '--url') {
  // e.g. 'world=park&handed=-1&t=10.35&cam=play' (t = seconds into the cycle)
  const q = new URLSearchParams(args[2] || '');
  await open(`${q.toString()}&still=1`);
  const url = await page.evaluate(([t, cam]) => window.duel.capture(t, cam), [Number(q.get('t') ?? 0), q.get('cam') ?? 'play']);
  fs.writeFileSync(path.join(out, `${args[3] || 'custom'}.png`), Buffer.from(url.split(',')[1], 'base64'));
} else {
  const worlds = (args[1] || 'park,plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
  const names = !args[2] || args[2] === 'all' ? Object.keys(SHOTS) : args[2].split(',');
  for (const w of worlds) {
    await open(`world=${w}&still=1`);
    for (const n of names) {
      const s = SHOTS[n];
      if (!s) {
        console.log('no such shot:', n);
        continue;
      }
      const [cam, seg, off] = s;
      // read the canvas in the page right after drawing (a page screenshot of WebGL takes seconds)
      const url = await page.evaluate(([cam, seg, off]) => window.duel.capture(window.duel.at(seg, off), cam), [cam, seg, off]);
      fs.writeFileSync(path.join(out, `${w}-${n}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
    const stats = await page.evaluate(() => window.duel.stats?.());
    if (stats) console.log(w, JSON.stringify(stats));
  }
}
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
