// Stage dives (drag the near player away just before contact) and capture them
// mid-flight and on landing. The page freezes the game at the right moment.
import { launchChrome, outDir } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const out = outDir('dive', { inRepo: true });
const world = process.argv[3] || 'plaza';
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(600);
await tv.evaluate((w) => {
  const k = window.kaleido;
  window.flow.go(null);
  k.startAttract(w);
  k.rig.setMode('intro');
  window.__want = ['air', 'land'];
  window.__frozen = null;
  const loop = () => {
    const m = k.match;
    if (!k.paused) {
      for (const p of m.players.filter((q) => q.team === 0)) {
        const a = p.athletic;
        if (a && a.move === 'dive') {
          const u = (m.t - a.t0) / Math.max(0.05, a.tc - a.t0);
          const phase = m.t < a.tc ? (u > 0.6 ? 'air' : null) : m.t - a.tc > 0.12 && m.t - a.tc < 0.4 ? 'land' : null;
          if (phase && window.__want.includes(phase)) {
            window.__want = window.__want.filter((x) => x !== phase);
            k.paused = true;
            window.__frozen = phase;
          }
        }
        if (!p.plan || a || p.__staged === p.plan) continue;
        const tl = p.plan.t - m.t;
        if (tl > 0.36 && tl < 0.44 && p.plan.by < 1.3) {
          p.__staged = p.plan;
          const dir = Math.sign(p.plan.sx - p.x) || 1;
          p.x = p.plan.sx - dir * 3.2;
          p.z = p.plan.sz;
          p.vx = p.vz = 0;
        }
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
}, world);
for (let i = 0; i < 2; i++) {
  const phase = await tv.waitForFunction(() => window.__frozen, null, { timeout: 40000, polling: 50 }).then((h) => h.jsonValue()).catch(() => null);
  if (!phase) break;
  await tv.screenshot({ path: `${out}/move-${world}-dive-${phase}.png` });
  await tv.evaluate(() => { window.__frozen = null; window.kaleido.paused = false; });
}
console.log(logs.join('\n') || 'ok');
await browser.close();
