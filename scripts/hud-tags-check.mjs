// Are the name tags (and the Server badge) where the camera projects the players? Compares each
// showing tag's box on the page with the projection of its player, during the serve set-up.
//   node scripts/hud-tags-check.mjs [world]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'plaza';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6, mouse: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370);
await tv.evaluate((w) => { const f = window.flow; f.mode = 'quick'; f.beginMatch(w); }, world);
await tv.waitForFunction(() => window.kaleido.match?.state === 'serve', null, { timeout: 60000 });
await tv.waitForTimeout(1200);
const rows = await tv.evaluate(() => {
  const k = window.kaleido;
  const m = k.match;
  const hud = document.querySelector('.hud');
  const hr = hud.getBoundingClientRect();
  const out = [];
  const tags = [...document.querySelectorAll('.ptags .ptag')];
  m.players.forEach((p, i) => {
    const pr = k.rig.project({ x: p.x, y: 2.2 * (p.look.height || 1), z: p.z });
    const el = tags[i];
    if (!el) return out.push(`${p.name}: no tag`);
    const shown = getComputedStyle(el).display !== 'none';
    const r = el.getBoundingClientRect();
    // the tag's bottom edge (above its little arrow) sits on the anchor, centred
    const ax = hr.left + pr.x * hr.width, ay = hr.top + pr.y * hr.height;
    out.push(`${p.name}: ${shown ? 'shown' : 'hidden'} anchor (${ax.toFixed(1)}, ${ay.toFixed(1)}) box centre-x ${(r.left + r.width / 2).toFixed(1)} bottom ${r.bottom.toFixed(1)}  dx ${(r.left + r.width / 2 - ax).toFixed(2)} dy ${(r.bottom - ay).toFixed(2)}`);
  });
  const b = document.querySelector('.ptags .sbadge');
  if (b && getComputedStyle(b).display !== 'none' && m.server) {
    const bp = k.rig.project({ x: m.server.x + 0.55, y: 0.25, z: m.server.z });
    const r = b.getBoundingClientRect();
    out.push(`badge: anchor (${(hr.left + bp.x * hr.width).toFixed(1)}, ${(hr.top + bp.y * hr.height).toFixed(1)}) box left ${r.left.toFixed(1)} centre-y ${(r.top + r.height / 2).toFixed(1)}`);
  }
  return out;
});
console.log(rows.join('\n'));
await tv.screenshot({ path: process.env.SHOT || '/private/tmp/claude-501/-Users-veersaraf-dev-wii/6d799801-7d69-4a35-8d64-2e107f4d098b/scratchpad/tags.png' });
await browser.close();
