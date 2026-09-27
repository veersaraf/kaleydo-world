// In-page A/B of a world's scenery and effects costs (like park-ab.mjs, for any
// world). One page, fixed cameras; a state is switched on alternate frames (so
// outside load on the GPU hits both states alike) and GPU time (timer queries),
// JS time, draw calls and triangles are compared between them.
//   node scripts/worlds-ab.mjs <world> [modes] [seconds per view] [pr]
//   modes (comma-separated):
//     detail      World.detail 1 vs 0
//     fx          effects tier 3 vs 0
//     fx1         effects tier 3 vs 1
//     vis:<a.b+c> shows/hides the objects at these paths in the world (w.a.b, w.c;
//                 a path ending in .mesh or naming an Object3D), e.g. vis:bamboo.mesh
//     set:<a.b>=<on>/<off>   sets a world property to one of two values (numbers)
//     none        on and off are the same state: the noise floor
//   VIEWS=a,b     only these views (play, far, bowl, side, aerial)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3200';
const [world = 'ink', modeList = 'detail', secs = '4', pr = '1.5'] = process.argv.slice(2);
const modes = modeList.split(',');
const allViews = {
  play: { pos: [0, 6.2, 22], look: [0, 0, 3.7], fov: 44 },
  bowl: { pos: [0.3, 2.75, 16.4], look: [0, 0.2, -1], fov: 42 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  aerial: { pos: [9, 14, 20], look: [0, 0, -2], fov: 42 },
};
const views = Object.fromEntries(Object.entries(allViews).filter(([k]) => !process.env.VIEWS || process.env.VIEWS.split(',').includes(k)));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
  const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
  if (fs.existsSync(file)) route.fulfill({ path: file });
  else route.continue();
});
// the same players every run
await ctx.addInitScript(() => {
  let s = 0x2f6b1a3;
  Math.random = () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
});
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(BASE + '/');
await p.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await p.goto(BASE + '/');
await p.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await p.evaluate(
  ([pr, world]) => {
    const k = window.kaleido;
    window.flow.go(null);
    window.flow.attractShiftAt = 1e12;
    document.getElementById('ui').style.display = 'none';
    k.startAttract(world, 'tennis');
    k.paused = true;
    k.quality.update = () => null;
    k.stage.msaa = 0;
    k.pr = pr;
    k.resize();
    const w = k.stage.current;
    const set = (name, on) => {
      if (name === 'none') return;
      if (name === 'detail') return void (w.detail = on ? 1 : 0);
      if (name === 'fx') return void k.stage.setFx(on ? 3 : 0);
      if (name === 'fx1') return void k.stage.setFx(on ? 3 : 1);
      const at = (path) => path.split('.').reduce((o, k) => o?.[k], w);
      if (name.startsWith('vis:')) {
        for (const p of name.slice(4).split('+')) {
          const o = at(p);
          if (o && 'visible' in o) o.visible = on;
        }
        return;
      }
      if (name.startsWith('set:')) {
        const [path, vals] = name.slice(4).split('=');
        const [a, b] = vals.split('/').map(Number);
        const keys = path.split('.');
        const last = keys.pop();
        const o = keys.reduce((o, k) => o?.[k], w);
        if (o) o[last] = on ? a : b;
      }
    };
    // ---- a GPU timer around each frame, bucketed by the state it drew
    const gl = k.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pending = [];
    const orig = k.frame.bind(k);
    let flip = false;
    window.__ab = { name: null, on: [], off: [], jsOn: [], jsOff: [] };
    k.frame = (now) => {
      const ab = window.__ab;
      flip = !flip;
      if (ab.name) set(ab.name, flip);
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      const t0 = performance.now();
      orig(now);
      (flip ? ab.jsOn : ab.jsOff).push(performance.now() - t0);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push([q, flip, ab]);
      while (pending.length && gl.getQueryParameter(pending[0][0], gl.QUERY_RESULT_AVAILABLE)) {
        const [pq, st, which] = pending.shift();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && which === window.__ab && which.name) which[st ? 'on' : 'off'].push(gl.getQueryParameter(pq, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(pq);
      }
    };
    // draw calls and triangles of one whole frame (post included) in each state
    window.__count = (name) => {
      const r = k.renderer;
      const out = {};
      for (const on of [false, true]) {
        set(name, on);
        r.info.autoReset = false;
        r.info.reset();
        orig(performance.now());
        out[on ? 'on' : 'off'] = { calls: r.info.render.calls, tris: r.info.render.triangles };
        r.info.autoReset = true;
      }
      return out;
    };
    window.__set = set;
  },
  [+pr, world],
);
const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
const f = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
console.log(`${world} at pr${pr}: GPU per frame with each state on vs off (alternate frames, ${secs} s per view)`);
for (const [vn, cam] of Object.entries(views)) {
  await p.evaluate((c) => (window.kaleido.rig.debug = c), cam);
  await p.waitForTimeout(400);
  for (const n of modes) {
    const cnt = await p.evaluate((n) => window.__count(n), n);
    await p.evaluate((n) => (window.__ab = { name: n, on: [], off: [], jsOn: [], jsOff: [] }), n);
    await p.waitForTimeout(+secs * 1000);
    const b = await p.evaluate(() => {
      const ab = window.__ab;
      window.__set(ab.name, true);
      window.__ab = { name: null, on: [], off: [], jsOn: [], jsOff: [] };
      return ab;
    });
    // the first frames after a switch may carry the other state's work: skip them
    const on = b.on.slice(5),
      off = b.off.slice(5);
    console.log(
      `${vn.padEnd(7)}${n.padEnd(13)} on p25 ${pct(on, 0.25).toFixed(2)} p50 ${pct(on, 0.5).toFixed(2)}  Δp25 ${f(pct(on, 0.25) - pct(off, 0.25))} Δp50 ${f(pct(on, 0.5) - pct(off, 0.5))} ms  Δjs ${f(pct(b.jsOn, 0.5) - pct(b.jsOff, 0.5))} ms  calls ${cnt.off.calls}→${cnt.on.calls}  tris ${(cnt.off.tris / 1000).toFixed(0)}k→${(cnt.on.tris / 1000).toFixed(0)}k  (${on.length}+${off.length} frames)`,
    );
  }
}
await browser.close();
