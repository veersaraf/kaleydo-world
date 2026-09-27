// In-page A/B of the park's scenery costs. One page, fixed cameras; a state is
// switched on alternate frames (so outside load on the GPU hits both states
// alike) and GPU time (timer queries), JS time, draw calls and triangles are
// compared between them.
//   node scripts/park-ab.mjs [mode] [seconds per view] [pr] [msaa]
//   modes: detail   World.detail 1 vs 0 (grass, clouds, flowers, birds)
//          scenery  everything park-env draws vs nothing of it (ground in plain
//                   materials): an upper bound, since "nothing" also drops what
//                   replaced older scenery
//          parts    each part on its own
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3200';
const [mode = 'scenery', secs = '5', pr = '1.5', msaa = '4'] = process.argv.slice(2);
const views = {
  play: { pos: [0, 6.2, 22], look: [0, 0, 3.7], fov: 44 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  bowl: { pos: [0, 2.75, 13.8], look: [0, 0.2, -4], fov: 42 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  aerial: { pos: [9, 14, 20], look: [0, 0, -2], fov: 42 },
};
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
const names = await p.evaluate(
  ([pr, msaa, mode]) => {
    const k = window.kaleido;
    window.flow.go(null);
    document.getElementById('ui').style.display = 'none';
    k.startAttract('park');
    k.paused = true;
    k.quality.update = () => null;
    k.stage.msaa = msaa;
    k.pr = pr;
    k.resize();
    const w = k.stage.current;
    // ---- the parts, found by their materials
    const all = [];
    w.scene.traverse((o) => o.isMesh && all.push(o));
    const key = (m) => (m.customProgramCacheKey ? m.customProgramCacheKey() : '');
    const by = (f) => all.filter((o) => !Array.isArray(o.material) && f(o.material, o));
    const f = w.foliage;
    const sets = {
      grass: [w.grass.group],
      trees: by((m) => m === f.leaf || m === f.bark),
      plants: by((m) => m === f.shrub || m === f.bloom || (key(m).includes('sway-canopy') && m !== f.leaf && m !== f.bark && !m.isMeshDepthMaterial)),
      cloth: by((m) => key(m).includes('sway-cloth')),
      clouds: [w.clouds.mesh],
      birds: [w.birds.mesh],
      water: by((m) => m.uniforms && (m.uniforms.uLand || m.uniforms.uLandR)),
      town: by((m) => key(m) === 'town-haze'),
      horizon: by((m) => m.isMeshBasicMaterial && m.vertexColors),
    };
    // the ground can't be hidden (it is the ground): swap in plain materials instead
    const swaps = by((m) => key(m) === 'paving-macro' || key(m) === 'lawn-macro').map((o) => {
      const a = o.material;
      const b = new a.constructor({ color: a.color, map: a.map, roughness: a.roughness === 1 ? 0.9 : a.roughness });
      return [o, a, b];
    });
    const set = (name, on) => {
      if (name === 'detail') return void (w.detail = on ? 1 : 0);
      const list = name === 'scenery' ? Object.values(sets).flat() : sets[name];
      for (const o of list) o.visible = on;
      if (name === 'scenery' || name === 'ground') for (const [o, a, b] of swaps) o.material = on ? a : b;
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
    // draw calls and triangles of one whole frame (shadows and post included) in each state
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
    return mode === 'parts' ? [...Object.keys(sets), 'ground'] : [mode];
  },
  [+pr, +msaa, mode],
);
const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
const f = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
console.log(`park, ${mode} at pr${pr}/msaa${msaa}: GPU per frame with it on vs off (alternate frames, ${secs} s per view)`);
for (const [vn, cam] of Object.entries(views)) {
  await p.evaluate((c) => (window.kaleido.rig.debug = c), cam);
  await p.waitForTimeout(300);
  for (const n of names) {
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
      `${vn.padEnd(7)}${names.length > 1 ? n.padEnd(9) : ''} on p25 ${pct(on, 0.25).toFixed(2)} p50 ${pct(on, 0.5).toFixed(2)}  Δp25 ${f(pct(on, 0.25) - pct(off, 0.25))} Δp50 ${f(pct(on, 0.5) - pct(off, 0.5))} ms  Δjs ${f(pct(b.jsOn, 0.5) - pct(b.jsOff, 0.5))} ms  calls ${cnt.off.calls}→${cnt.on.calls}  tris ${(cnt.off.tris / 1000).toFixed(0)}k→${(cnt.on.tris / 1000).toFixed(0)}k  (${on.length}+${off.length} frames)`,
    );
  }
}
await browser.close();
