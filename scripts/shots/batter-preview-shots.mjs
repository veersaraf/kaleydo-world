// Screenshots of the baseball characters preview (batter-preview.html) in every world.
//
//   node scripts/shots/batter-preview-shots.mjs <outDir> [worlds=park,plaza,…] [shots=name,name…|all] [query]
//   node scripts/shots/batter-preview-shots.mjs <outDir> --strip <name> [worlds] [query]   (frame strips: see STRIPS)
//   node scripts/shots/batter-preview-shots.mjs <outDir> --url '<query>' <name>             (one custom shot)
//
// A shot is a moment of the preview's scripted pitches seen from one camera
// (the plays and their moments: window.bb.timings()):
//   play    the game's batting view, behind the catcher     side   the batter from across the plate
//   front   the batter from the mound's side                back   over the batter's back shoulder
//   top     from overhead                                   close  on the contact point
//   hero    camera.ts's celebration shot                    portrait  camera.ts's stepping-in shot
//   pitcher the pitcher side-on     mound  behind the pitcher     catcher  the catcher close
//   wait    the hitter waiting a turn      flip  the bat flip     wide  the lot
// A strip is a row of moments, for reading motion: the swing, the pitch, the catch…
// The page is frozen at each moment (window.bb.seek), so the images are repeatable.
// BASE defaults to a dev server started with PORT=4400:
//   PORT=4400 HTTPS_PORT=4843 HMR_PORT=26000 node server/server.mjs --dev

import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 720);
const args = process.argv.slice(2);
const out = args[0] || '/tmp/batter-shots';
fs.mkdirSync(out, { recursive: true });

/** name → [camera, play, moment, seconds after it] */
const SHOTS = {
  'play-stance': ['play', 'homer', 'set', 0.8],
  'play-windup': ['play', 'homer', 'windup', 0.55],
  'play-release': ['play', 'homer', 'release', 0],
  'play-load': ['play', 'homer', 'load', 0.3],
  'play-contact': ['play', 'homer', 'cross', 0],
  'play-extend': ['play', 'homer', 'cross', 0.05],
  'play-finish': ['play', 'homer', 'watch', 0],
  'play-whiff': ['play', 'whiff', 'cross', 0.05],
  'play-catch': ['play', 'whiff', 'catch', 0.02],
  'play-take': ['play', 'take', 'catch', 0.1],
  'play-bomb': ['play', 'bomb', 'watch', 0.1],
  'side-stance': ['side', 'homer', 'set', 0.8],
  'side-load': ['side', 'homer', 'swing', -0.02],
  'side-lag': ['side', 'homer', 'swing', 0.075],
  'side-contact': ['side', 'homer', 'cross', 0],
  'side-extend': ['side', 'homer', 'cross', 0.05],
  'side-finish': ['side', 'homer', 'watch', 0.1],
  'side-one': ['side', 'bomb', 'watch', 0.1],
  'side-sad': ['side', 'whiff', 'react', 1.0],
  'front-stance': ['front', 'homer', 'set', 0.8],
  'front-contact': ['front', 'homer', 'cross', 0],
  'front-finish': ['front', 'homer', 'watch', 0.1],
  'back-contact': ['back', 'homer', 'cross', 0],
  'top-contact': ['top', 'homer', 'cross', 0],
  'close-contact': ['close', 'homer', 'cross', 0],
  'close-low': ['close', 'bomb', 'cross', 0],
  'hero-cheer': ['hero', 'homer', 'react', 1.4],
  'hero-flip': ['hero', 'homer', 'react', 0.4],
  'portrait-stance': ['portrait', 'homer', 'set', 0.9],
  'flip-up': ['flip', 'homer', 'react', 0.55],
  'flip-down': ['flip', 'homer', 'react', 2.2],
  'pitcher-set': ['pitcher', 'homer', 'set', 0.8],
  'pitcher-kick': ['pitcher', 'homer', 'windup', 0.56],
  'pitcher-stride': ['pitcher', 'homer', 'windup', 0.9],
  'pitcher-release': ['pitcher', 'homer', 'release', 0],
  'pitcher-follow': ['pitcher', 'homer', 'windup', 1.4],
  'pitcher-watch': ['pitcher', 'homer', 'land', -0.5],
  'mound-release': ['mound', 'homer', 'release', 0],
  'mound-contact': ['mound', 'homer', 'cross', 0.01],
  'catcher-crouch': ['catcher', 'whiff', 'set', 0.8],
  'catchside-crouch': ['catchside', 'whiff', 'set', 0.8],
  'catchside-catch': ['catchside', 'whiff', 'catch', 0.0],
  'catcher-catch': ['catcher', 'whiff', 'catch', 0.0],
  'catcher-pop': ['catcher', 'whiff', 'catch', 0.1],
  'catcher-throw': ['catcher', 'whiff', 'throw', 0.5],
  'catcher-watch': ['catcher', 'homer', 'cross', 1.2],
  'wait-idle': ['wait', 'homer', 'set', 0.8],
  'wait-cheer': ['wait', 'homer', 'react', 0.5],
  wide: ['wide', 'homer', 'cross', 0.8],
};

/** name → [camera, play, moment, from (s after it), to, frames, crop x, y, w, h (0..1)] */
const STRIPS = {
  // the swing from the batting camera, 1/60 s apart, cropped to the batter
  'swing-play': ['play', 'homer', 'swing', -0.05, 0.4, 28, 0.0, 0.2, 0.62, 0.8],
  'swing-side': ['side', 'homer', 'swing', -0.05, 0.4, 28],
  'swing-front': ['front', 'homer', 'swing', -0.05, 0.4, 28],
  'swing-top': ['top', 'homer', 'swing', -0.05, 0.4, 28],
  'swing-back': ['back', 'homer', 'swing', -0.05, 0.4, 28],
  'bomb-side': ['side', 'bomb', 'swing', -0.05, 0.55, 28],
  'bomb-play': ['play', 'bomb', 'swing', -0.05, 0.55, 28, 0.0, 0.2, 0.62, 0.8],
  'load-side': ['side', 'homer', 'load', -0.1, 0.55, 18],
  'stance-side': ['side', 'homer', 'set', 0.0, 1.2, 12],
  'whiff-side': ['side', 'whiff', 'swing', -0.05, 0.5, 18],
  'take-side': ['side', 'take', 'load', 0, 1.4, 12],
  'windup-pitcher': ['pitcher', 'homer', 'windup', 0, 1.75, 30, 0.15, 0.0, 0.7, 1.0],
  'windup-front': ['pitchfront', 'homer', 'windup', 0, 1.75, 30, 0.2, 0.0, 0.6, 1.0],
  'release-pitcher': ['pitcher', 'homer', 'windup', 0.9, 1.25, 22, 0.15, 0.0, 0.7, 1.0],
  'windup-play': ['play', 'homer', 'windup', 0, 1.4, 24, 0.3, 0.25, 0.4, 0.4],
  'windup-mound': ['mound', 'homer', 'windup', 0, 1.75, 24],
  'catch-catcher': ['catcher', 'whiff', 'catch', -0.3, 0.5, 18],
  'throw-catcher': ['catcher', 'whiff', 'throw', -0.1, 0.9, 18],
  'throw-side': ['catchside', 'whiff', 'throw', -0.1, 0.9, 18],
  // the throw coming back into the pitcher's glove
  'toss-pitcher': ['pitchfront', 'whiff', 'throw', 0.2, 1.5, 18],
  // a late swing: the ball's in the mitt when it's heard, everyone rewinds to the contact, the hitstop, away
  'rewind-side': ['side', 'late', 'catch', -0.12, 0.5, 30],
  'rewind-play': ['play', 'late', 'catch', -0.12, 0.5, 30, 0.0, 0.2, 0.62, 0.8],
  'cheer-hero': ['hero', 'homer', 'react', 0, 3.2, 24],
  'cheer-flip': ['flip', 'homer', 'react', 0, 2.4, 24],
  'sad-side': ['side', 'whiff', 'react', 0, 2.0, 12],
  'watch-catcher': ['catcher', 'homer', 'cross', 0, 1.6, 12],
  'watch-pitcher': ['pitcher', 'homer', 'cross', 0, 2.0, 12],
  'wait-cheer': ['wait', 'homer', 'react', 0, 2.2, 12],
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
  await page.goto(`${BASE}/batter-preview.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.bb?.ready === true, null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(300);
}

const save = (name, url) => fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));

if (args[1] === '--url') {
  // e.g. 'world=park&handed=-1&t=10.35&cam=play' (t = seconds into the cycle)
  const q = new URLSearchParams(args[2] || '');
  await open(`${q.toString()}&still=1`);
  save(args[3] || 'custom', await page.evaluate(([t, cam]) => window.bb.capture(t, cam), [Number(q.get('t') ?? 0), q.get('cam') ?? 'play']));
} else if (args[1] === '--strip') {
  const names = (args[2] || 'swing-side').split(',');
  const worlds = (args[3] || 'park').split(',');
  const extra = args[4] ? `&${args[4]}` : '';
  for (const w of worlds) {
    await open(`world=${w}&still=1${extra}`);
    for (const n of names) {
      const s = STRIPS[n];
      if (!s) {
        console.log('no such strip:', n);
        continue;
      }
      const [cam, play, moment, from, to, frames, cx = 0, cy = 0, cw = 1, ch = 1] = s;
      const url = await page.evaluate(
        ([cam, play, moment, from, to, frames, crop]) => window.bb.strip(window.bb.at(play, moment, from), window.bb.at(play, moment, to), frames, cam, 6, crop[2] < 1 ? 0.52 : 0.34, crop),
        [cam, play, moment, from, to, frames, [cx, cy, cw, ch]],
      );
      save(`${w}-strip-${n}${args[4] ? '-' + args[4].replace(/[^a-z0-9]+/gi, '_') : ''}`, url);
    }
  }
} else {
  const worlds = (args[1] || 'park,plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
  const names = !args[2] || args[2] === 'all' ? Object.keys(SHOTS) : args[2].split(',');
  const extra = args[3] ? `&${args[3]}` : process.env.Q ? `&${process.env.Q}` : '';
  for (const w of worlds) {
    await open(`world=${w}&still=1${extra}`);
    for (const n of names) {
      const s = SHOTS[n];
      if (!s) {
        console.log('no such shot:', n);
        continue;
      }
      const [cam, play, moment, off] = s;
      // read the canvas in the page right after drawing (a page screenshot of WebGL takes seconds)
      const url = await page.evaluate(([cam, play, moment, off]) => window.bb.capture(window.bb.at(play, moment, off), cam), [cam, play, moment, off]);
      save(`${w}-${n}${extra ? '-' + extra.replace(/[^a-z0-9]+/gi, '_').replace(/^_/, '') : ''}`, url);
    }
    const stats = await page.evaluate(() => {
      window.bb.seek(window.bb.at('homer', 'cross', 0.5), 'play');
      return { ...window.bb.stats(), ...window.bb.perf(300) };
    });
    console.log(w, JSON.stringify(stats));
  }
}
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
