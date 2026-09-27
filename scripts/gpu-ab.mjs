// GPU time A/B between two servers (e.g. a clean checkout of the base commit and
// your branch) from fixed cameras. The two pages take turns in short windows on
// the same machine, so whatever else loads the GPU hits both alike; Math.random
// is seeded the same in both, so layouts and players match. Each window reports
// its 10th percentile (the least disturbed frames) and its median, and the
// median JS time of a frame (scene update and draw submission).
//   node scripts/gpu-ab.mjs <baseA> <baseB> [world] [rounds] [pr] [msaa] [query]
import { chromium } from 'playwright-core';
const [A, B, world = 'park', rounds = '6', pr = '1.5', msaa = '4', query = ''] = process.argv.slice(2);
const views = {
  play: { pos: [0, 6.2, 22], look: [0, 0, 3.7], fov: 44 },
  far: { pos: [0, 5.5, -21.7], look: [0, 0.55, 4.2], fov: 38 },
  side: { pos: [-17, 3.2, 3], look: [0, 1, 0], fov: 36 },
  aerial: { pos: [9, 14, 20], look: [0, 0, -2], fov: 42 },
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const open = async (base) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
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
  p.on('pageerror', (e) => console.log(base, 'pageerror', e.message));
  await p.goto(base + '/' + query);
  await p.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
  await p.goto(base + '/' + query);
  await p.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
  await p.evaluate(
    ([w, pr, msaa]) => {
      const k = window.kaleido;
      window.flow.go(null);
      document.getElementById('ui').style.display = 'none';
      k.startAttract(w);
      k.paused = true;
      // fixed resolution and MSAA, a GPU timer around each frame, and an off switch
      k.quality.update = () => null;
      k.stage.msaa = msaa;
      k.pr = pr;
      k.resize();
      const gl = k.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const pending = [];
      window.__gpu = [];
      window.__on = false;
      const orig = k.frame.bind(k);
      window.__js = [];
      k.frame = (now) => {
        if (!window.__on) return;
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        const t0 = performance.now();
        orig(now);
        window.__js.push(performance.now() - t0);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push(q);
        while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
          const p = pending.shift();
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) window.__gpu.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(p);
        }
      };
      window.__stats = () => {
        const r = k.renderer;
        r.info.autoReset = false;
        r.info.reset();
        orig(performance.now());
        const s = { calls: r.info.render.calls, tris: r.info.render.triangles };
        r.info.autoReset = true;
        return s;
      };
    },
    [world, +pr, +msaa],
  );
  return p;
};
const pages = { A: await open(A), B: await open(B) };
const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const med = (a) => pct(a, 0.5);
console.log(`A = ${A}\nB = ${B}\n${world} at pr${pr}/msaa${msaa}, ${rounds} rounds of 2 s per view and page`);
for (const [name, cam] of Object.entries(views)) {
  const res = { A: [], B: [] };
  const lo = { A: [], B: [] };
  const js = { A: [], B: [] };
  const stats = {};
  for (const [k, p] of Object.entries(pages)) {
    await p.evaluate((c) => (window.kaleido.rig.debug = c), cam);
    stats[k] = await p.evaluate(() => window.__stats());
  }
  for (let r = 0; r < +rounds; r++) {
    for (const k of r % 2 ? ['B', 'A'] : ['A', 'B']) {
      const p = pages[k];
      await p.evaluate(() => (window.__on = true));
      await p.waitForTimeout(400);
      await p.evaluate(() => ((window.__gpu.length = 0), (window.__js.length = 0)));
      await p.waitForTimeout(1600);
      const [g, j] = await p.evaluate(() => ((window.__on = false), [window.__gpu.slice(), window.__js.slice()]));
      res[k].push(med(g));
      lo[k].push(pct(g, 0.1));
      js[k].push(med(j));
    }
  }
  const f = (v) => v.toFixed(2);
  const d = (v) => (v >= 0 ? '+' : '') + f(v);
  const row = (k) => `p10 ${f(med(lo[k]))} p50 ${f(med(res[k]))} ms  [p10s ${lo[k].map(f).join(' ')}]  js ${f(med(js[k]))} ms  ${stats[k].calls} calls ${(stats[k].tris / 1000).toFixed(0)}k tris`;
  console.log(`${name.padEnd(7)} A ${row('A')}`);
  console.log(`${''.padEnd(7)} B ${row('B')}`);
  console.log(`${''.padEnd(7)} Δ p10 ${d(med(lo.B) - med(lo.A))}  p50 ${d(med(res.B) - med(res.A))} ms  js ${d(med(js.B) - med(js.A))} ms`);
}
await browser.close();
