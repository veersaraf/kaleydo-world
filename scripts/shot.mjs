// Headless screenshots of the game for visual testing.
//
//   node scripts/shot.mjs <outDir> <steps.json>
//
// steps: [{ "url": "..."} | { "js": "..." } | { "wait": ms } | { "shot": "name" } | { "key": "Enter" } | { "size": [w,h] }]

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const [outDir, stepsFile] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

for (const s of steps) {
  if (s.size) await page.setViewportSize({ width: s.size[0], height: s.size[1] });
  if (s.url) await page.goto(s.url, { waitUntil: 'load' });
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.key) await page.keyboard.press(s.key);
  if (s.click) await page.mouse.click(s.click[0], s.click[1]);
  if (s.js) {
    try {
      const r = await page.evaluate(s.js);
      if (r !== undefined) logs.push(`[js] ${typeof r === 'string' ? r : JSON.stringify(r)}`);
    } catch (e) {
      logs.push(`[js-error] ${e.message}`);
    }
  }
  if (s.shot) await page.screenshot({ path: path.join(outDir, `${s.shot}.png`), type: 'png' });
}
fs.writeFileSync(path.join(outDir, 'console.txt'), logs.join('\n'));
console.log(logs.slice(-30).join('\n'));
await browser.close();
