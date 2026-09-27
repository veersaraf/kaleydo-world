// Screenshots of a world where it is actually seen: the live gameplay camera of
// every sport (tennis, bowling, duel, archery), plus fixed wide, far, low and
// side views and the pin deck. A seeded Math.random, so two builds make the
// same scenery and players.
//   node scripts/showcase-shots.mjs <outDir> <suffix> [worlds]
//   PR=<ratio>   render scale (default 1.5)
//   FX=<tier>    effects tier (render/quality.ts)
//   SHOTS=a,b    only these shots (tennis, main, far, side, aerial, low, rev, close,
//                bowling, pins, duel, archery, rally: CPUs mid-rally from the play camera)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3200';
const [out, suffix, list = 'ink,neon,cosmic,pixel'] = process.argv.slice(2);
const worlds = list.split(',');
const PR = +(process.env.PR || 1.5);
const only = process.env.SHOTS ? process.env.SHOTS.split(',') : null;
const want = (s) => !only || only.includes(s);
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
tv.on('pageerror', (e) => logs.push(e.message));
tv.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
await tv.goto(BASE + '/');
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
const showUi = () => tv.evaluate(() => document.querySelectorAll('.screen, .hud, #ui, .ui, .toast').forEach((e) => (e.style.visibility = '')));
const shot = async (w, name) => {
  await hideUi();
  await tv.screenshot({ path: `${out}/${w}-${name}-${suffix}.png` });
  await showUi();
};
// fixed views of the tennis court (a paused CPU match)
const cams = {
  main: { pos: [0, 5.5, 21.7], look: [0, 0.55, -4.2], fov: 38 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  aerial: { pos: [9, 14, 20], look: [0, 0, -2], fov: 42 },
  low: { pos: [0, 1.4, 8], look: [0, 1.3, -12], fov: 44 },
  rev: { pos: [14, 6, -20], look: [0, 0.5, 2], fov: 40 },
  close: { pos: [3.2, 1.5, 16.2], look: [-0.6, 0.9, 11.2], fov: 34 },
};
await setup();
// build each world from its own seed
await tv.evaluate((ws) => {
  const k = window.kaleido;
  ws.forEach((w, i) => {
    window.__reseed(1000 + i * 77);
    k.stage.cache.delete(w);
    k.stage.get(w);
  });
}, worlds);
for (const w of worlds) {
  await tv.evaluate((i) => window.__reseed(5000 + i), worlds.indexOf(w));
  if (want('tennis')) {
    await tv.evaluate((w) => window.flow.beginMatch(w), w);
    await setup();
    await tv.evaluate(() => window.kaleido.match.startNow());
    await tv.waitForTimeout(2600);
    await shot(w, 'tennis');
  }
  if (Object.keys(cams).some(want)) {
    await tv.evaluate((w) => {
      const k = window.kaleido;
      k.startAttract(w, 'tennis');
      k.stage.setWorld(w);
    }, w);
    await setup();
    await tv.waitForTimeout(600);
    await tv.evaluate(() => (window.kaleido.paused = true));
    for (const [name, c] of Object.entries(cams)) {
      if (!want(name)) continue;
      await tv.evaluate((c) => (window.kaleido.rig.debug = c), c);
      await tv.waitForTimeout(250);
      await shot(w, name);
    }
    await tv.evaluate(() => {
      window.kaleido.rig.debug = null;
      window.kaleido.paused = false;
    });
  }
  if (want('rally')) {
    // CPUs playing on, seen from where a player's camera sits: bounces, trails, splats
    await tv.evaluate((w) => {
      const k = window.kaleido;
      k.startAttract(w, 'tennis');
      k.stage.setWorld(w);
      k.rig.debug = { pos: [0, 6.2, 22], look: [0, 0, 3.7], fov: 44 };
    }, w);
    await setup();
    await tv.waitForTimeout(9000);
    await shot(w, 'rally');
    await tv.evaluate(() => (window.kaleido.rig.debug = null));
  }
  if (want('bowling') || want('pins')) {
    await tv.evaluate((w) => window.flow.beginBowling(w, 0.65), w);
    await setup();
    await tv.waitForFunction(() => window.kaleido.bowl && window.kaleido.bowl.state === 'ready', null, { timeout: 30000 }).catch(() => {});
    await tv.waitForTimeout(1500);
    if (want('bowling')) await shot(w, 'bowling');
    if (want('pins')) {
      // the pin deck view (the camera after the ball reaches the pins), held still
      await tv.evaluate(() => {
        const k = window.kaleido;
        const c = k.bowlCam;
        c.__update ??= c.update;
        c.update = function (...a) {
          c.__update.apply(this, a);
          this.cam.position.set(0.55, 0.95, -5.49);
          this.cam.lookAt(0, 0.22, -9.34);
          this.cam.fov = 40;
          this.cam.updateProjectionMatrix();
        };
      });
      await tv.waitForTimeout(400);
      await shot(w, 'pins');
      await tv.evaluate(() => {
        const c = window.kaleido.bowlCam;
        c.update = c.__update;
      });
    }
  }
  if (want('duel')) {
    await tv.evaluate((w) => window.flow.beginDuel(w, 0.9), w);
    await setup();
    await tv.waitForTimeout(4200);
    await shot(w, 'duel');
  }
  if (want('archery')) {
    await tv.evaluate((w) => window.flow.beginArchery(w, 0.65), w);
    await setup();
    await tv.waitForFunction(() => window.kaleido.archery && window.kaleido.archery.state === 'aim', null, { timeout: 30000 }).catch(() => {});
    await tv.waitForTimeout(2200);
    await shot(w, 'archery');
  }
}
console.log(logs.join('\n') || 'ok');
await browser.close();
