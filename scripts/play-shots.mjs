// Screenshots of live rallies (ball in flight) in chosen worlds.
//   node scripts/play-shots.mjs <outDir> [worlds] [shotsPerWorld]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2];
const worlds = (process.argv[3] || 'plaza').split(',');
const per = +(process.argv[4] || 2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6 })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(600);
for (const w of worlds) {
  await tv.evaluate((w) => {
    const k = window.kaleido, f = window.flow;
    f.mode = 'quick';
    f.beginMatch(w);
    k.match.startNow();
    if (window.__loop) return;
    window.__loop = true;
    const planned = {};
    const loop = () => {
      const m = k.match;
      if (m && !k.paused) {
        for (const p of m.players.filter((q) => q.human)) {
          if (m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.6) k.input.onToss(p.slot);
          if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: p.slot, power: 0.95, spin: 0.2, age: 0, source: 'key' });
          if (p.plan && p.plan !== planned[p.id]) planned[p.id] = { plan: p.plan, at: p.plan.t + (Math.random() - 0.5) * 0.06 };
          const pl = planned[p.id];
          if (pl && p.plan === pl.plan && m.t >= pl.at) {
            k.input.onSwing({ slot: p.slot, power: 0.55 + Math.random() * 0.45, spin: [0.9, -0.9, 0.1][Math.floor(Math.random() * 3)], age: 0, source: 'key', side: p.plan.stroke === 'bh' ? 'bh' : 'fh' });
            planned[p.id] = null;
          }
        }
      }
      requestAnimationFrame(loop);
    };
    loop();
  }, w);
  // one frame of the player serving
  await tv.waitForFunction(() => { const m = window.kaleido.match; return m && m.state === 'serve' && m.server.human && m.t - m.stateT0 > 0.3; }, null, { timeout: 30000, polling: 100 }).catch(() => null);
  await tv.screenshot({ path: `${out}/serve-${w}.png` });
  for (let n = 0; n < per; n++) {
    // wait until a ball is flying towards the near player, between the net and mid-court
    await tv.waitForFunction(() => {
      const m = window.kaleido.match;
      if (!m || m.state !== 'play' || !m.ball.live || m.ball.holder || m.ball.lastHitTeam !== 1) return false;
      const b = m.ballView(m.t, { x: 0, y: 0, z: 0 });
      return b.z > 1 && b.z < 6;
    }, null, { timeout: 30000, polling: 'raf' }).catch(() => null);
    await tv.screenshot({ path: `${out}/play-${w}-${n}.png` });
    await tv.waitForTimeout(1500);
  }
}
console.log(logs.join('\n') || 'ok');
await browser.close();
