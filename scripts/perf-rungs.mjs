// GPU time of a whole frame at each rung of the quality ladder, per world (the ladder's cost
// curve: the bottom rungs must actually be cheap). Each frame is run N times inside one timer
// query. Rungs (and, with several builds, the builds) are visited round-robin, over and over: a
// busy GPU only ever adds time, so the minimum is the number to trust; the median shows how
// noisy the run was.
//   BASE=http://localhost:3200 node scripts/perf-rungs.mjs [worlds] [levels] [sport]
//   BASES=before=http://localhost:3381,after=http://localhost:3380 node scripts/perf-rungs.mjs ...
//   PR=1.5 node scripts/perf-rungs.mjs ... 0,1,2,3   the levels are then effects tiers at that render scale
//   e.g. node scripts/perf-rungs.mjs park,plaza,neon 0,1,2,3,9
import { chromium } from 'playwright-core';
const bases = process.env.BASES
  ? process.env.BASES.split(',').map((b) => b.split('='))
  : [['', process.env.BASE || 'http://localhost:3200']];
const worlds = (process.argv[2] || 'park,plaza,neon').split(',');
const levels = (process.argv[3] || '0,1,2,3,5,9').split(',').map(Number);
const sport = process.argv[4] || 'tennis';
const N = +(process.env.N || 8);
const PR = process.env.PR ? +process.env.PR : 0;
const REPS = +(process.env.REPS || 12);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pages = [];
for (const [label, base] of bases) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
  const tv = await ctx.newPage();
  await tv.goto(base + '/');
  await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
  await tv.goto(base + '/');
  await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 60000 });
  await tv.waitForTimeout(1500);
  await tv.evaluate(() => {
    const k = window.kaleido;
    k.quality.update = () => null;
    k.quality.beginFrame = () => {};
    k.quality.endFrame = () => {};
  });
  pages.push({ label, tv });
}
const sample = (tv) =>
  tv.evaluate(async (N) => {
    const k = window.kaleido;
    const gl = k.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    for (let i = 0; i < 3; i++) k.frame(performance.now() + 16);
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < N; i++) k.frame(performance.now() + 16);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    let tries = 0;
    await new Promise((res) => setTimeout(res, 40));
    while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && tries++ < 100) await new Promise((res) => setTimeout(res, 10));
    const v = gl.getParameter(ext.GPU_DISJOINT_EXT) ? NaN : gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / N;
    gl.deleteQuery(q);
    return v;
  }, N);
for (const w of worlds) {
  for (const { tv } of pages) {
    await tv.evaluate(([w, s]) => { window.kaleido.startAttract(w, s); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [w, sport]);
    await tv.waitForTimeout(2000);
  }
  const got = pages.map(() => Object.fromEntries(levels.map((L) => [L, []])));
  for (let round = 0; round < REPS; round++)
    for (const L of levels)
      for (const [i, { tv }] of pages.entries()) {
        await tv.evaluate(([L, PR]) => {
          const k = window.kaleido;
          if (PR) {
            // (an effects tier at a fixed render scale)
            k.pr = PR;
            k.setEffects(L);
            k.resize();
          } else {
            k.quality.level = L;
            k.applyQuality();
          }
        }, [L, PR]);
        await tv.waitForTimeout(300);
        const ms = await sample(tv);
        if (!Number.isNaN(ms)) got[i][L].push(ms);
      }
  pages.forEach(({ label }, i) => {
    const row = levels.map((L) => {
      const a = got[i][L].sort((x, y) => x - y);
      return `${PR ? 'fx' : 'L'}${L}: ${a[0].toFixed(2)} (med ${a[a.length >> 1].toFixed(2)})`;
    });
    console.log(`${w.padEnd(7)}${label.padEnd(7)}`, row.join(' | '));
  });
}
await browser.close();
