// GPU time per world at different render scales / MSAA settings (timer queries).
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const worlds = (process.argv[2] || 'plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
const configs = JSON.parse(process.argv[3] || '[{"pr":1.5,"msaa":4},{"pr":1.25,"msaa":4},{"pr":1.0,"msaa":4},{"pr":1.5,"msaa":0}]');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForTimeout(1500);
// freeze the adaptive resolution and install a GPU timer around each frame
await tv.evaluate(() => {
  const k = window.kaleido;
  k.adapt = () => {};
  const gl = k.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending = [];
  window.__gpu = [];
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    orig(now);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push(q);
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const p = pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) window.__gpu.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(p);
    }
  };
});
const header = 'world   ' + configs.map((c) => `pr${c.pr}/msaa${c.msaa}`.padStart(16)).join('');
console.log(header);
for (const w of worlds) {
  await tv.evaluate((w) => window.kaleido.startAttract(w), w);
  await tv.waitForTimeout(1200);
  let line = w.padEnd(8);
  for (const c of configs) {
    await tv.evaluate((c) => {
      const k = window.kaleido;
      k.stage.forEachWorld((wd) => { if (wd.sceneRT && wd.sceneRT.samples !== c.msaa) { wd.sceneRT.samples = c.msaa; wd.sceneRT.dispose(); } });
      k.pr = c.pr;
      k.resize();
    }, c);
    await tv.waitForTimeout(500);
    await tv.evaluate(() => (window.__gpu.length = 0));
    await tv.waitForTimeout(2500);
    const g = await tv.evaluate(() => window.__gpu.slice().sort((a, b) => a - b));
    const q = (p) => g[Math.min(g.length - 1, Math.floor(p * g.length))];
    line += `${q(0.5).toFixed(1)}/${q(0.9).toFixed(1)}ms`.padStart(16);
  }
  console.log(line);
}
await browser.close();
