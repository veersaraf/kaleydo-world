// Screenshots of the bowling preview (bowl-preview.html) in every world.
//
//   node scripts/shots/bowl-preview-shots.mjs <outDir> [worlds=park,plaza,…] [shots=bowler@1.0,pins@5.6,…]
//   node scripts/shots/bowl-preview-shots.mjs <outDir> --url '<query>' <name>   (one custom shot)
//
// A shot is `<camera>@<seconds into the preview cycle>`. The page is frozen at
// that moment (window.bowl.seek), so the images are repeatable.
// BASE defaults to the dev server started with PORT=3320.

import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 720);
const args = process.argv.slice(2);
const out = args[0] || '/tmp/bowl-shots';
fs.mkdirSync(out, { recursive: true });

const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

async function open(query) {
  await page.goto(`${BASE}/bowl-preview.html?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.bowl?.ready === true, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(400);
}

if (args[1] === '--url') {
  await open(args[2] || '');
  await page.screenshot({ path: path.join(out, `${args[3] || 'custom'}.png`) });
} else {
  const worlds = (args[1] || 'park,plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
  const shots = (args[2] || 'bowler@0.8,bowler@2.2,pins@5.2,side@2.55').split(',');
  for (const w of worlds) {
    await open(`world=${w}&still=1`);
    for (const s of shots) {
      const [cam, t] = s.split('@');
      await page.evaluate(([cam, t]) => window.bowl.seek(Number(t), cam), [cam, t]);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, `${w}-${cam}-${t}.png`) });
    }
    const stats = await page.evaluate(() => window.bowl.stats?.());
    if (stats) console.log(w, JSON.stringify(stats));
  }
}
if (logs.length) console.log(logs.slice(0, 40).join('\n'));
await browser.close();
