// Screenshot the split-screen view in every world.
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2];
const only = process.argv[3] ? process.argv[3].split(',') : null;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const logs = [];
const tv = await ctx.newPage();
tv.on('pageerror', (e) => logs.push('[tv pageerror] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ games: 3, level: 'club', seenTutorial: true, teamPreset: 0 })));
await tv.goto(BASE + '/');
await tv.waitForTimeout(1200);
for (const name of ['Veer', 'Sam']) {
  const pad = await ctx.newPage();
  await pad.setViewportSize({ width: 390, height: 844 });
  await pad.goto(BASE + '/controller.html?auto&n=' + name);
  await pad.waitForTimeout(900);
}
await tv.bringToFront();
const worlds = only ?? (await tv.evaluate(() => window.flow.constructor && [...document.querySelectorAll('x')].length === 0 && null)) ?? ['plaza', 'ink', 'neon', 'pixel', 'paper', 'clay', 'water', 'cosmic'];
for (const w of worlds) {
  await tv.evaluate((w) => { const f = window.flow; f.mode = 'quick'; f.beginMatch(w); }, w);
  await tv.waitForTimeout(600);
  await tv.evaluate(() => window.kaleido.match.startNow());
  await tv.waitForTimeout(3600);
  await tv.screenshot({ path: `${out}/sw-${w}.png` });
}
console.log(logs.join('\n') || 'ok');
await browser.close();
