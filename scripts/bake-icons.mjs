// Bakes the favicon and the phone-remote icons from the real hero globe.
//   node scripts/bake-icons.mjs
// Writes public/brand/favicon-{64,32}.png (transparent, globe only) and
// public/icons/remote-{180,192,512}.png + remote-maskable-512.png (globe on a navy-to-black backdrop).
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const server = await createServer({ root, server: { port: 3352, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:3352/scripts/globe.html');
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
const url = await page.evaluate(() => window.renderGlobe(1024, { spin: 0, bg: false }));
await browser.close();
await server.close();

// trim to the globe's bounding box (ignoring the faintest glow)
const raw = await sharp(Buffer.from(url.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = raw.info;
let x0 = W, y0 = H, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (raw.data[(y * W + x) * 4 + 3] > 40) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
const cx = (x0 + x1) / 2;
const cy = (y0 + y1) / 2;
const left = Math.round(cx - side / 2);
const top = Math.round(cy - side / 2);
// square, globe-centred, transparent padding where the crop runs off the render
const padded = await sharp(Buffer.from(url.split(',')[1], 'base64'))
  .extend({ top: side, bottom: side, left: side, right: side, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
const globe = await sharp(padded)
  .extract({ left: left + side, top: top + side, width: side, height: side })
  .png()
  .toBuffer();
console.log('globe box', side, 'px');

const brand = path.join(root, 'public/brand');
const icons = path.join(root, 'public/icons');
for (const s of [64, 32]) {
  await sharp(globe).resize(s, s, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(path.join(brand, `favicon-${s}.png`));
}

const backdrop = (s) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><defs><radialGradient id="g" cx="50%" cy="0%" r="100%"><stop offset="0" stop-color="#3a3380"/><stop offset="0.55" stop-color="#15122e"/><stop offset="1" stop-color="#0a0a10"/></radialGradient></defs><rect width="${s}" height="${s}" fill="url(#g)"/></svg>`,
  );
async function icon(file, s, frac) {
  const g = Math.round(s * frac);
  const inner = await sharp(globe).resize(g, g, { kernel: 'lanczos3' }).png().toBuffer();
  await sharp(backdrop(s))
    .composite([{ input: inner, left: Math.round((s - g) / 2), top: Math.round((s - g) / 2) }])
    .flatten({ background: '#0a0a10' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(icons, file));
}
await icon('remote-180.png', 180, 0.78);
await icon('remote-192.png', 192, 0.78);
await icon('remote-512.png', 512, 0.78);
await icon('remote-maskable-512.png', 512, 0.62);
for (const f of fs.readdirSync(icons)) console.log(f);
