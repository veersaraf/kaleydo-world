// In-page A/B of one world's cost. Two states take turns frame by frame (so a
// shared machine's load lands on both alike) and GPU time (timer queries), JS
// time, draw calls and triangles are compared between them, from the cameras
// that matter: tennis behind each baseline, the side, an aerial, the far
// player's split-screen half, and the bowling, duel and archery views.
//   node scripts/style-ab.mjs <world> [mode] [seconds per view] [pr] [views]
//   modes: base      this build's world vs another build of it, loaded into the
//                    same page from src/tv/worlds/<file>_base.ts (e.g. the file
//                    as it was: git show <commit>:src/tv/worlds/plaza.ts > …_base.ts;
//                    keep it out of commits)
//          detail    World.detail 1 vs 0
//          js:<code> any toggle, run with (w = the world, on) — e.g. js:w.post=on?w.__p:null
//   views: main,far,side,aerial,split2,bowl,duel,arch (default: all)
//   RUNS=n repeats the whole set n times and prints the median of each figure
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4000';
const RUNS = +(process.env.RUNS || 1);
const [world = 'plaza', mode = 'base', secs = '4', pr = '1.5', viewList = 'main,far,side,aerial,split2,bowl,duel,arch'] = process.argv.slice(2);
const FILES = { plaza: 'plaza', paper: 'paper', clay: 'clay', water: 'water', park: 'park', ink: 'ink', neon: 'neon', pixel: 'pixel', cosmic: 'cosmic' };
const tennisCams = {
  main: { pos: [0, 6.2, 22.4], look: [0, 0, -3.7], fov: 38 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  aerial: { pos: [9, 14, 20], look: [0, 0, -2], fov: 42 },
  split2: { pos: [0, 6.2, -22.4], look: [0, 0, 3.7], fov: 38 },
};
const views = viewList.split(',');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
// a worktree's node_modules may be a symlink the dev server won't serve fonts from
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
  localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true }));
});
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.goto(BASE + '/');
await p.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await p.waitForTimeout(800);
const hideUi = () => p.evaluate(() => document.querySelectorAll('.screen, .hud, #ui, .ui, .toast').forEach((e) => (e.style.visibility = 'hidden')));

// ---- the toggle and the per-frame timer
await p.evaluate(
  async ([world, mode, pr, file]) => {
    const k = window.kaleido;
    k.quality.update = () => null;
    k.quality.beginFrame = () => {};
    k.quality.endFrame = () => {};
    k.pr = pr;
    k.stage.msaa = 0;
    k.resize();
    if (window.flow) window.flow.attractShiftAt = 1e12;
    window.flow.go(null);
    k.startAttract(world, 'tennis');
    const A = k.stage.current;
    let B = null;
    if (mode === 'base') {
      // the other build of this world: its own module, the same id (venues style by it)
      const mod = await import(`/src/tv/worlds/${file}_base.ts`);
      const def = Object.values(mod).find((d) => d && d.id === world && typeof d.make === 'function');
      B = def.make(k.renderer);
      B.init();
      B.teamColors = A.teamColors;
    }
    // (the split-screen far view: both worlds turn their scenery as for view 1)
    window.__view1 = false;
    for (const w of [A, B]) {
      if (!w) continue;
      const sv = w.setView.bind(w);
      w.setView = (i, cam) => sv(window.__view1 ? 1 : i, cam);
    }
    const st = k.stage;
    const set = (on) => {
      if (mode === 'base') {
        const w = on ? A : B;
        if (st.current !== w) {
          w.fitTargets(st.vw, st.h, st.pr, st.msaa, st.fx);
          w.setPlayers(st.looks, st.lookKey);
          if (w.sport !== A.sport) {
            // the app prepares the world on screen for its sport as it draws it
          }
          st.current = w;
        }
      } else if (mode === 'detail') A.detail = on ? 1 : 0;
      else new Function('w', 'on', mode.slice(3))(A, on);
    };
    window.__set = set;
    window.__A = A;
    const gl = k.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pending = [];
    const orig = k.frame.bind(k);
    let flip = false;
    window.__ab = { on: [], off: [], jsOn: [], jsOff: [], run: false };
    k.frame = (now) => {
      const ab = window.__ab;
      if (ab.run) {
        flip = !flip;
        set(flip);
      }
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      const t0 = performance.now();
      orig(now);
      if (ab.run) (flip ? ab.jsOn : ab.jsOff).push(performance.now() - t0);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push([q, flip, ab, ab.run]);
      while (pending.length && gl.getQueryParameter(pending[0][0], gl.QUERY_RESULT_AVAILABLE)) {
        const [pq, s, which, run] = pending.shift();
        if (run && !gl.getParameter(ext.GPU_DISJOINT_EXT)) which[s ? 'on' : 'off'].push(gl.getQueryParameter(pq, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(pq);
      }
    };
    // draw calls and triangles of one whole frame (shadows and post included) in each state
    window.__count = () => {
      const r = k.renderer;
      const out = {};
      for (const on of [false, true, false, true]) {
        set(on);
        r.info.autoReset = false;
        r.info.reset();
        orig(performance.now());
        out[on ? 'on' : 'off'] = { calls: r.info.render.calls, tris: r.info.render.triangles };
        r.info.autoReset = true;
      }
      set(true);
      return out;
    };
  },
  [world, mode, +pr, FILES[world] ?? world],
);

async function enter(view) {
  const k = 'window.kaleido';
  void k;
  if (tennisCams[view]) {
    await p.evaluate(
      ([w, c, v1]) => {
        const k = window.kaleido;
        window.__set(true);
        if (k.sport !== 'tennis' || !k.match) {
          window.flow.go(null);
          k.startAttract(w, 'tennis');
        }
        k.paused = true;
        window.__view1 = v1;
        k.rig.debug = c;
      },
      [world, tennisCams[view], view === 'split2'],
    );
  } else {
    await p.evaluate(() => {
      window.__set(true);
      window.__view1 = false;
      window.kaleido.rig.debug = null;
      window.kaleido.paused = false;
    });
    if (view === 'bowl') {
      await p.evaluate((w) => window.flow.beginBowling(w, 0.65), world);
      await p.waitForFunction(() => window.kaleido.bowl && window.kaleido.bowl.state === 'ready', null, { timeout: 30000 });
    } else if (view === 'duel') {
      await p.evaluate((w) => window.flow.beginDuel(w, 0.9), world);
      await p.waitForFunction(() => window.kaleido.duel?.state === 'fight', null, { timeout: 30000 });
    } else if (view === 'arch') {
      await p.evaluate((w) => window.flow.beginArchery(w, 0.65), world);
      await p.waitForFunction(() => { const g = window.kaleido.archery; return g && g.state === 'aim' && g.archers[g.current].cpu === null; }, null, { timeout: 30000 });
    }
    await p.waitForTimeout(600);
    await p.evaluate(() => (window.kaleido.paused = true));
  }
  await hideUi();
  // both states once, so shaders compile and buffers exist before timing
  await p.evaluate(() => window.__count());
  await p.waitForTimeout(400);
}

const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
const med = (a) => pct(a, 0.5);
const f = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
const results = {};
console.log(`${world}, ${mode} at pr${pr}: GPU per frame, new (on) vs other (off) on alternate frames, ${secs} s per view${RUNS > 1 ? `, median of ${RUNS} runs` : ''}`);
for (let run = 0; run < RUNS; run++) {
  for (const v of views) {
    await enter(v);
    const cnt = await p.evaluate(() => window.__count());
    await p.evaluate(() => (window.__ab = { on: [], off: [], jsOn: [], jsOff: [], run: true }));
    await p.waitForTimeout(+secs * 1000);
    const b = await p.evaluate(() => {
      const ab = window.__ab;
      window.__ab = { on: [], off: [], jsOn: [], jsOff: [], run: false };
      window.__set(true);
      return ab;
    });
    // the first frames after a switch may carry the other state's work: skip them
    const on = b.on.slice(5),
      off = b.off.slice(5);
    const r = (results[v] ??= { p50: [], d10: [], d25: [], d50: [], js: [], cnt, n: 0 });
    r.p50.push(pct(on, 0.5));
    r.d10.push(pct(on, 0.1) - pct(off, 0.1));
    r.d25.push(pct(on, 0.25) - pct(off, 0.25));
    r.d50.push(pct(on, 0.5) - pct(off, 0.5));
    r.js.push(pct(b.jsOn, 0.5) - pct(b.jsOff, 0.5));
    r.n += on.length + off.length;
    if (RUNS > 1) console.log(`  run ${run + 1} ${v.padEnd(7)} Δp10 ${f(pct(on, 0.1) - pct(off, 0.1))} Δp50 ${f(pct(on, 0.5) - pct(off, 0.5))}`);
  }
}
for (const v of views) {
  const r = results[v];
  if (!r) continue;
  console.log(
    `${v.padEnd(7)} on p50 ${med(r.p50).toFixed(2)}  Δp10 ${f(med(r.d10))} Δp25 ${f(med(r.d25))} Δp50 ${f(med(r.d50))} ms  Δjs ${f(med(r.js))} ms  calls ${r.cnt.off.calls}→${r.cnt.on.calls}  tris ${(r.cnt.off.tris / 1000).toFixed(0)}k→${(r.cnt.on.tris / 1000).toFixed(0)}k  (${r.n} frames)`,
  );
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
