// Amplified per-pass GPU cost: each piece is run N times inside one timer query.
//   BASE=... node scripts/perf/perf-passes.mjs worlds pr fx
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const worlds = (process.argv[2] || 'plaza,park,clay,paper,cosmic,neon,water,ink,pixel').split(',');
const pr = +(process.argv[3] || 1.5);
const fx = +(process.argv[4] || 3);
const N = +(process.env.N || 12);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 }).catch(() => {});
await tv.waitForTimeout(1500);
await tv.evaluate(([pr, fx]) => {
  const k = window.kaleido;
  k.quality.update = () => null;
  k.quality.beginFrame = () => {};
  k.quality.endFrame = () => {};
  k.setEffects(fx);
  k.pr = pr;
  k.resize();
}, [pr, fx]);
for (const w of worlds) {
  await tv.evaluate(([w, s]) => { window.kaleido.startAttract(w, s); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [w, process.env.SPORT || 'tennis']);
  await tv.waitForTimeout(1500);
  const res = await tv.evaluate(async (N) => {
    const k = window.kaleido;
    const world = k.stage.current;
    const r = k.renderer;
    const gl = r.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const cam = k.rig.cam;
    const out = {};
    const time = async (label, fn) => {
      const samples = [];
      for (let rep = 0; rep < 5; rep++) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        for (let i = 0; i < N; i++) fn();
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        await new Promise((res) => setTimeout(res, 60));
        let tries = 0;
        while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && tries++ < 100) await new Promise((res) => setTimeout(res, 10));
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / N);
        gl.deleteQuery(q);
      }
      samples.sort((a, b) => a - b);
      out[label] = +samples[0].toFixed(2);
    };
    const rt = world.sceneRT;
    world.sceneRT.resolveDepthBuffer = true;
    await time('scene', () => { r.setRenderTarget(rt); r.clear(); r.render(world.scene, cam); });
    if (world.bloom) await time('bloom', () => world.bloom.render(r, rt.texture));
    if (world.post) { world.post.plan(cam); await time('post', () => world.post.render(r, rt, cam)); }
    await time('final', () => { world.final.u.tScene.value = rt.texture; world.final.render(r, null); });
    await time('frame', () => k.frame(performance.now() + 16));
    // the same frame without the sun's shadow map redrawn, and without bloom
    r.shadowMap.autoUpdate = false;
    await time('frame-noshadow', () => k.frame(performance.now() + 16));
    r.shadowMap.autoUpdate = true;
    if (world.bloom) {
      const b = world.bloom;
      world.bloom = null;
      await time('frame-nobloom', () => k.frame(performance.now() + 16));
      world.bloom = b;
    }
    r.setRenderTarget(null);
    return out;
  }, N);
  console.log(w.padEnd(7), JSON.stringify(res));
}
await browser.close();
