// Frame-time profile of the TV, world by world, on this machine's real GPU.
//   node scripts/perf.mjs [worlds] [seconds]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const worlds = (process.argv[2] || 'plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
const secs = +(process.argv[3] || 6);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
// MacBook Air 13": 1280×832 points at 2× — a browser window leaves ~1280×740
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.waitForTimeout(2000);
const gpuInfo = await tv.evaluate(() => {
  const gl = window.kaleido.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', timer: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), pr: window.kaleido.pr, dpr: devicePixelRatio, size: [innerWidth, innerHeight] };
});
console.log(JSON.stringify(gpuInfo));
// instrument the frame
await tv.evaluate(() => {
  const k = window.kaleido;
  const orig = k.frame.bind(k);
  window.__js = [];
  window.__raf = [];
  let last = 0;
  k.frame = (now) => {
    if (last) window.__raf.push(now - last);
    last = now;
    const t0 = performance.now();
    orig(now);
    window.__js.push(performance.now() - t0);
  };
});
const stats = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(1), over17: +(s.filter((x) => x > 17.5).length / s.length * 100).toFixed(1), over25: s.filter((x) => x > 25).length };
};
for (const w of worlds) {
  // an attract (CPU vs CPU) match in this world — steady gameplay load
  await tv.evaluate((w) => { window.kaleido.startAttract(w); window.flow.go?.(null); }, w);
  await tv.waitForTimeout(1500);
  await tv.evaluate(() => { window.__js.length = 0; window.__raf.length = 0; });
  await tv.waitForTimeout(secs * 1000);
  const r = await tv.evaluate(() => ({ js: window.__js.slice(), raf: window.__raf.slice(), pr: window.kaleido.pr }));
  // GPU-bound cost: render frames back to back and wait for the GPU each time
  const gpu = await tv.evaluate(() => {
    const k = window.kaleido;
    const gl = k.renderer.getContext();
    const px = new Uint8Array(4);
    const times = [];
    let now = performance.now();
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      now += 16.67;
      k.frame(now);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // forces the GPU to finish
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return +times[20].toFixed(2);
  });
  console.log(w.padEnd(7), 'pr', r.pr, '| rAF', JSON.stringify(stats(r.raf)), '| js', JSON.stringify(stats(r.js)), '| full frame (cpu+gpu) median', gpu, 'ms');
}
console.log(logs.join('\n'));
await browser.close();
