// Bakes the KALEYDO WORLD intro (scripts/tools/intro-bake.html) into the files the game ships:
//   public/brand/intro.mp4        the intro, 1920×1080 at 60 fps (background included)
//   public/brand/intro-poster.jpg its first frame (shown until the video can play)
//   public/brand/lockup.png       the final lockup (globe + words) on a transparent 1920×1080 frame,
//                                 pixel-identical to the video's last frame, for the title screen
//   public/brand/lockup-small.png the same, trimmed to the lockup, 640 px wide (menus, phone, join page)
// Usage: node scripts/tools/bake-intro.mjs [--fps=60] [--frames-only]
// Scratch frames go to /private/tmp/claude-501/kaleydo-intro-frames.
import { createServer } from 'vite';
import { launchChrome } from '../lib/chrome.mjs';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split('=')[1];
const FPS = Number(arg('fps', 60));
const TMP = '/private/tmp/claude-501/kaleydo-intro-frames';
const OUT = path.resolve('public/brand');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ root: process.cwd(), server: { port: 3352, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);

async function open(w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:3352/scripts/tools/intro-bake.html?bake');
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 });
  return page;
}

// ---- the video frames
const page = await open(1920, 1080);
const dur = await page.evaluate(() => window.DUR);
const n = Math.round(dur * FPS) + 1;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.__frame(t), i / FPS);
  await page.screenshot({ path: path.join(TMP, `f${String(i).padStart(4, '0')}.png`) });
  if (i % 30 === 0) console.log(`frame ${i}/${n}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await page.close();

if (!process.argv.includes('--frames-only')) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(TMP, 'f%04d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, 'intro.mp4')]);
  await sharp(path.join(TMP, 'f0000.png')).jpeg({ quality: 82 }).toFile(path.join(OUT, 'intro-poster.jpg'));

  // ---- the final lockup on a transparent frame, framed exactly like the video's last frame
  const still = await open(1920, 1080);
  await still.evaluate((t) => { window.__clear(true); window.__frame(t); }, dur);
  await still.screenshot({ path: path.join(OUT, 'lockup.png'), omitBackground: true });
  await still.close();
  await sharp(path.join(OUT, 'lockup.png')).trim({ threshold: 1 }).resize({ width: 640 }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'lockup-small.png'));
  for (const f of ['intro.mp4', 'intro-poster.jpg', 'lockup.png', 'lockup-small.png']) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB');
}
await browser.close();
await server.close();
