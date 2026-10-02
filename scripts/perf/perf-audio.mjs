// What each sound effect costs on the main thread when it is triggered (a frame that plays
// one is that much longer). Times the first call and the next ones.
//   node scripts/perf/perf-audio.mjs
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370); // unlocks audio
await tv.waitForTimeout(1500);
const rows = await tv.evaluate(async () => {
  const a = window.flow.audio;
  if (!a) return ['no audio'];
  const out = [];
  const calls = {
    bounce: () => a.sfx.bounce(3, 0),
    hit: () => a.sfx.hit(0.8, false, 0, false),
    hitPerfect: () => a.sfx.hit(1, true, 0, false),
    net: () => a.sfx.net(false, 0),
    swish: () => a.sfx.swish(0.5, 0),
    thud: () => a.sfx.thud(0),
    ooh: () => a.sfx.ooh(),
    roar: () => a.sfx.roar(1),
    smashBoom: () => a.sfx.smashBoom(0, 1),
    smashCrack: () => a.sfx.smashCrack(true, 0, false),
    setCrowd: () => a.sfx.setCrowd(0.5),
  };
  for (const [name, f] of Object.entries(calls)) {
    const t = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      try { f(); } catch (e) { t.push('ERR'); break; }
      t.push(+(performance.now() - t0).toFixed(2));
      await new Promise((r) => setTimeout(r, 120));
    }
    out.push(`${name.padEnd(11)} ${t.join(' ')}`);
  }
  return out;
});
console.log(rows.join('\n'));
await browser.close();
