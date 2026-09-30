// Renders hero-globe stills for review (output only into the dir given):
//   node scripts/render-globe.mjs <outDir> [spin,spin,...]   (spin = 0..1 of a turn)
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? '/private/tmp/claude-501/kaleydo-globe3');
const spins = (process.argv[3] ?? '0').split(',').map(Number);
fs.mkdirSync(outDir, { recursive: true });
const server = await createServer({ root: process.cwd(), server: { port: 3351, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('[page]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:3351/scripts/globe.html');
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
for (const s of spins) {
  const t0 = Date.now();
  const url = await page.evaluate(([s]) => window.renderGlobe(2048, { spin: s, bg: true }), [s]);
  const file = path.join(outDir, `globe-${String(Math.round(s * 360)).padStart(3, '0')}.png`);
  await sharp(Buffer.from(url.split(',')[1], 'base64')).resize(1024, 1024, { kernel: 'lanczos3' }).png().toFile(file);
  console.log(file, ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
await browser.close();
await server.close();
