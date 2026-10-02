// Timeline of slow frames: rAF gap, JS time, GPU time (timer queries), resizes, program compiles.
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 8);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: +(process.env.DPR || 2) });
const tv = await ctx.newPage();
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.waitForTimeout(1500);
await tv.evaluate((w) => window.kaleido.startAttract(w), world);
await tv.waitForTimeout(2000);
const rows = await tv.evaluate((secs) => new Promise((done) => {
  const k = window.kaleido;
  const gl = k.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending = [];
  const out = [];
  const events = [];
  const origResize = k.resize.bind(k);
  k.resize = () => { events.push(['resize', performance.now(), k.pr]); origResize(); };
  let progs = k.renderer.info.programs.length;
  const origFrame = k.frame.bind(k);
  let last = 0;
  const t0 = performance.now();
  k.frame = (now) => {
    const q = ext ? gl.createQuery() : null;
    if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const a = performance.now();
    origFrame(now);
    const js = performance.now() - a;
    if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ q, row: null }); }
    const row = { t: +(now - t0).toFixed(0), gap: last ? +(now - last).toFixed(1) : 0, js: +js.toFixed(2), gpu: null, state: k.match?.state, cam: k.rig.mode };
    if (q) pending[pending.length - 1].row = row;
    out.push(row);
    last = now;
    const np = k.renderer.info.programs.length;
    if (np !== progs) { events.push(['programs', performance.now(), np - progs]); progs = np; }
    // collect finished queries
    while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const p = pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) p.row.gpu = +(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6).toFixed(2);
      gl.deleteQuery(p.q);
    }
    if (now - t0 > secs * 1000) { k.frame = origFrame; done({ out, events: events.map((e) => [e[0], +(e[1] - t0).toFixed(0), e[2]]) }); }
  };
}), secs);
const { out, events } = rows;
const gpus = out.map((r) => r.gpu).filter((g) => g != null).sort((a, b) => a - b);
console.log(`${world}: frames ${out.length}; gpu p50 ${gpus[gpus.length >> 1]} p90 ${gpus[Math.floor(gpus.length * 0.9)]} max ${gpus[gpus.length - 1]} ms`);
console.log('events', JSON.stringify(events));
const slow = out.filter((r) => r.gap > 20);
console.log(`slow frames (gap > 20 ms): ${slow.length}`);
for (const r of slow.slice(0, 25)) {
  const i = out.indexOf(r);
  const prev = out[i - 1];
  console.log(`  t=${r.t} gap=${r.gap} js=${r.js} gpu=${r.gpu} (prev js=${prev?.js} gpu=${prev?.gpu}) ${r.state} ${r.cam}`);
}
await browser.close();
