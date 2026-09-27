// Screenshots of a world set up for each sport (tennis, bowling, duel), a few
// seconds into play — for checking lighting and effects beyond the tennis court.
//   node scripts/sport-shots.mjs <outDir> <suffix> [worlds]
//   FX=<tier> PR=<ratio> DPR=<n> as in fx-shots.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3200';
const [out, suffix, list = 'park'] = process.argv.slice(2);
const worlds = list.split(',');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: +(process.env.DPR || 1) });
await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
  const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
  if (fs.existsSync(file)) route.fulfill({ path: file });
  else route.continue();
});
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 }).catch(() => {});
await tv.waitForTimeout(1000);
const setup = () =>
  tv.evaluate(
    ({ fx, pr }) => {
      const k = window.kaleido;
      k.quality.update = () => null;
      if (fx !== null) k.setEffects?.(fx);
      if (pr) {
        k.pr = pr;
        k.resize();
      }
    },
    { fx: process.env.FX !== undefined ? +process.env.FX : null, pr: process.env.PR ? +process.env.PR : null },
  );
const hideUi = () => tv.evaluate(() => document.querySelectorAll('.screen, .hud, #ui, .ui, .toast').forEach((e) => (e.style.visibility = 'hidden')));
for (const w of worlds) {
  await tv.evaluate((w) => window.flow.beginMatch(w), w);
  await setup();
  await tv.evaluate(() => window.kaleido.match.startNow());
  await tv.waitForTimeout(2500);
  await hideUi();
  await tv.screenshot({ path: `${out}/${w}-tennis-${suffix}.png` });
  await tv.evaluate((w) => window.flow.beginBowling(w, 0.65), w);
  await setup();
  await tv.waitForFunction(() => window.kaleido.bowl && window.kaleido.bowl.state === 'ready', null, { timeout: 30000 }).catch(() => {});
  await tv.waitForTimeout(1500);
  await hideUi();
  await tv.screenshot({ path: `${out}/${w}-bowling-${suffix}.png` });
  await tv.evaluate((w) => window.flow.beginDuel(w, 0.9), w);
  await setup();
  await tv.waitForTimeout(4000);
  await hideUi();
  await tv.screenshot({ path: `${out}/${w}-duel-${suffix}.png` });
}
console.log(logs.join('\n') || 'ok');
await browser.close();
