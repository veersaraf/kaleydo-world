// Screenshots of a world from every camera that shows its backdrop: tennis
// behind each baseline (and the far player's split-screen half), the side and
// attract views, then the bowling aim view, the duel and archery (aiming, and
// pushed in at full draw). A seeded Math.random makes the same players each run.
//   node scripts/style-shots.mjs <outDir> <suffix> [worlds] [query]
//   PR=<ratio> render scale (default 1.5)   FX=<tier> effects tier
//   ONLY=tennis,bowl,duel,arch   just these sports
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4000';
const [out, suffix = 'x', list = 'plaza,paper,clay,water', query = ''] = process.argv.slice(2);
const worlds = list.split(',');
const PR = +(process.env.PR || 1.5);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (s) => !ONLY || ONLY.includes(s);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
// a worktree's node_modules may be a symlink the dev server won't serve fonts from
await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
  const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
  if (fs.existsSync(file)) route.fulfill({ path: file });
  else route.continue();
});
await ctx.addInitScript(() => {
  let s = 12345;
  window.__reseed = (n) => (s = n);
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true }));
  localStorage.removeItem('kaleido.quality.v2');
});
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push('pageerror ' + e.message));
tv.on('console', (m) => m.type() === 'error' && logs.push('console ' + m.text()));
await tv.goto(BASE + '/' + query);
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 }).catch(() => {});
await tv.waitForTimeout(1000);
const setup = () =>
  tv.evaluate(
    ({ fx, pr }) => {
      const k = window.kaleido;
      k.quality.update = () => null;
      if (fx !== null) k.setEffects?.(fx);
      k.pr = pr;
      k.resize();
      if (window.flow) window.flow.attractShiftAt = 1e12;
    },
    { fx: process.env.FX !== undefined ? +process.env.FX : null, pr: PR },
  );
const hideUi = () => tv.evaluate(() => document.querySelectorAll('.screen, .hud, #ui, .ui, .toast').forEach((e) => (e.style.visibility = 'hidden')));
const snap = (w, name) => tv.screenshot({ path: `${out}/${w}-${name}-${suffix}.png` });
const cams = {
  main: { pos: [0, 6.2, 22.4], look: [0, 0, -3.7], fov: 38 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  aerial: { pos: [9, 14, 20], look: [0, 0, -2], fov: 42 },
  corner: { pos: [14, 6, -20], look: [0, 0.5, 2], fov: 40 },
  low: { pos: [0, 1.4, 8], look: [0, 1.3, -12], fov: 44 },
  overview: { pos: [0, 75, 95], look: [0, 0, -8], fov: 50 },
};
for (const w of worlds) {
  if (want('tennis')) {
    await tv.evaluate((w) => {
      const k = window.kaleido;
      window.flow.go(null);
      k.startAttract(w, 'tennis');
      k.paused = true;
    }, w);
    await setup();
    await hideUi();
    await tv.waitForTimeout(700);
    for (const [name, c] of Object.entries(cams)) {
      await tv.evaluate((c) => (window.kaleido.rig.debug = c), c);
      await tv.waitForTimeout(300);
      await snap(w, 'tennis-' + name);
    }
    // the far player's half of a split screen: behind the far baseline with the scenery turned
    await tv.evaluate(() => {
      const k = window.kaleido;
      const wd = k.stage.current;
      wd.__setView = wd.setView;
      wd.setView = (i, cam) => wd.__setView.call(wd, 1, cam);
      k.rig.debug = { pos: [0, 6.2, -22.4], look: [0, 0, 3.7], fov: 38 };
    });
    await tv.waitForTimeout(300);
    await snap(w, 'tennis-split2');
    await tv.evaluate(() => {
      const k = window.kaleido;
      const wd = k.stage.current;
      wd.setView = wd.__setView;
      wd.setView(0);
      k.rig.debug = null;
      k.paused = false;
    });
  }
  if (want('bowl')) {
    await tv.evaluate((w) => window.flow.beginBowling(w, 0.65), w);
    await setup();
    await tv.waitForFunction(() => window.kaleido.bowl && window.kaleido.bowl.state === 'ready', null, { timeout: 30000 }).catch(() => logs.push(w + ': bowling never ready'));
    await hideUi();
    await tv.waitForTimeout(1200);
    await snap(w, 'bowl');
  }
  if (want('duel')) {
    await tv.evaluate((w) => window.flow.beginDuel(w, 0.9), w);
    await setup();
    await tv.waitForFunction(() => window.kaleido.duel?.state === 'fight', null, { timeout: 20000 }).catch(() => logs.push(w + ': no fight'));
    await hideUi();
    await tv.waitForTimeout(500);
    await snap(w, 'duel');
  }
  if (want('arch')) {
    await tv.evaluate((w) => window.flow.beginArchery(w, 0.65), w);
    await setup();
    await tv.waitForFunction(() => window.kaleido.archery?.state === 'aim' && window.kaleido.archery.archers[window.kaleido.archery.current].cpu === null, null, { timeout: 30000 }).catch(() => logs.push(w + ': no aim'));
    await hideUi();
    await tv.waitForTimeout(900);
    await snap(w, 'arch');
    // aim at the main face (allowing for the drop), as scripts/archery-play.mjs does
    await tv.evaluate(() => {
      const k = window.kaleido;
      const drop = (d) => (d < 18 ? 0.44 : d < 26 ? 0.99 : 1.89);
      k.mouseAim = (g) => {
        const f = g.mainTarget();
        const a = g.archer;
        const d = Math.hypot(f.x - a.x, f.z - a.z);
        return { yaw: Math.atan2(-(f.x - a.x), -(f.z - a.z)), pitch: Math.atan2(f.y + drop(d) - 1.55, d) };
      };
      k.input.onDraw(0, true);
    });
    await tv.waitForTimeout(1500);
    await snap(w, 'arch-draw');
    await tv.evaluate(() => window.kaleido.input.onDraw(0, false));
    await tv.waitForTimeout(300);
  }
}
console.log(logs.join('\n') || 'ok');
await browser.close();
