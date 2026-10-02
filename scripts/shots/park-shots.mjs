// Sports Park scenery from the cameras that matter: tennis behind each baseline,
// the bowling aim view, the duel view, and a few wide shots (visual A/B).
//   node scripts/shots/park-shots.mjs <outDir> <suffix> [world] [query]
import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3000';
const [out, suffix = 'x', world = 'park', query = ''] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
// in a worktree node_modules may be a symlink the dev server won't serve fonts from
await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
  const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
  if (fs.existsSync(file)) route.fulfill({ path: file });
  else route.continue();
});
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
tv.on('console', (m) => m.type() === 'error' && logs.push('console ' + m.text()));
await tv.goto(BASE + '/' + query);
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/' + query);
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
const hideUI = () => tv.evaluate(() => (document.getElementById('ui').style.display = 'none'));
const snap = (name) => tv.screenshot({ path: `${out}/${world}-${name}-${suffix}.png` });

// ---- tennis: a paused attract match, fixed cameras
const cams = {
  'tennis-main': { pos: [0, 5.6, 21.5], look: [0, 0.6, -4], fov: 38 },
  'tennis-far': { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  'tennis-side': { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  'wide-aerial': { pos: [9, 14, 20], look: [0, 0, -2], fov: 42 },
  'wide-corner': { pos: [14, 6, -20], look: [0, 0.5, 2], fov: 40 },
  'wide-low': { pos: [0, 1.4, 8], look: [0, 1.3, -12], fov: 44 },
  overview: { pos: [0, 75, 95], look: [0, 0, -8], fov: 50 },
};
await tv.evaluate((w) => {
  const k = window.kaleido;
  window.flow.go(null);
  k.startAttract(w);
  k.paused = true;
}, world);
await hideUI();
await tv.waitForTimeout(900);
for (const [name, c] of Object.entries(cams)) {
  await tv.evaluate((c) => (window.kaleido.rig.debug = c), c);
  await tv.waitForTimeout(350);
  await snap(name);
}
const stats = await tv.evaluate(() => {
  const k = window.kaleido;
  const r = k.renderer;
  r.info.autoReset = false;
  r.info.reset();
  k.frame(performance.now());
  const out = { calls: r.info.render.calls, tris: r.info.render.triangles, batch: k.stage.current.batchStats };
  r.info.autoReset = true;
  k.rig.debug = null;
  k.paused = false;
  return out;
});
console.log('tennis-main frame:', JSON.stringify(stats));

// ---- bowling: the aim view, then the chase down the lane
await tv.evaluate((w) => window.flow.beginBowling(w, 0.65), world);
await tv.waitForFunction(() => window.kaleido.bowl && window.kaleido.bowl.state === 'ready', null, { timeout: 30000 });
await hideUI();
await tv.waitForTimeout(1500);
await snap('bowl-aim');
await tv.evaluate(() => {
  const k = window.kaleido;
  k.input.onGrip(0, true);
  k.input.onGrip(0, false);
  k.input.onBowl(0, { speed: 7.8, angle: 0, spin: 0.05 });
});
await tv.waitForFunction(() => { const g = window.kaleido.bowl; return g.state === 'lane' && g.phys.view.ball.z < 4; }, null, { timeout: 20000, polling: 'raf' }).catch(() => logs.push('no lane shot'));
await snap('bowl-lane');

// ---- duel: the fight view
await tv.evaluate((w) => window.flow.beginDuel(w, 0.3), world);
await hideUI();
await tv.waitForTimeout(900);
await snap('duel-intro');
await tv.waitForFunction(() => window.kaleido.duel?.state === 'fight', null, { timeout: 20000 }).catch(() => logs.push('no fight'));
await tv.waitForTimeout(600);
await snap('duel-fight');

console.log(logs.join('\n') || 'no errors');
await browser.close();
