// Close-up of the near player (for judging characters): front 3/4 view during play.
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2];
const world = process.argv[3] || 'plaza';
const tag = process.argv[4] || 'x';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(500);
await tv.evaluate((w) => {
  const k = window.kaleido;
  window.flow.go(null);
  k.startAttract(w);
  document.querySelectorAll('.screen, .hud').forEach((e) => (e.style.display = 'none'));
  // follow the near player from the front, 3/4 view
  const follow = () => {
    const p = k.match.players.find((q) => q.team === 0);
    if (p) k.rig.debug = { pos: [p.x - 2.2, 1.6, p.z - 3.6], look: [p.x, 0.85, p.z], fov: 34 };
    requestAnimationFrame(follow);
  };
  follow();
}, world);
// ready stance, and a swing
await tv.waitForTimeout(2500);
await tv.screenshot({ path: `${out}/close-${world}-${tag}-a.png` });
await tv.waitForFunction(() => { const p = window.kaleido.match.players.find((q) => q.team === 0); return p && p.swing && window.kaleido.match.t > p.swing.tc - 0.02; }, null, { timeout: 30000, polling: 'raf' }).catch(() => null);
await tv.screenshot({ path: `${out}/close-${world}-${tag}-b.png` });
console.log(logs.join('\n') || 'ok');
await browser.close();
