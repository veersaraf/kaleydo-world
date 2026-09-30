// Where a shatter's stall goes: the slow frames of one world-to-world transition mid-sport, with
// the time in the game's own preparation of the new world (venue, gear), in the stage's update
// and render, and every shader program built during it (perf-probe).
//   node scripts/perf-shift-detail.mjs <from> <to> [sport] [--nowarm]
import { chromium } from 'playwright-core';
import { programProbe, programReport } from './lib/perf-probe.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const [from, to, sport = 'bowling'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const warm = !process.argv.includes('--nowarm');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1500);
await tv.evaluate(([w, s]) => { const k = window.kaleido; k.startAttract(w, s); k.quality.update = () => null; if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [from, sport]);
await tv.waitForTimeout(2500);
if (warm) {
  const t = await tv.evaluate((id) => { const k = window.kaleido; const t0 = performance.now(); k.stage.warm(id, k.rig.cam); return performance.now() - t0; }, to);
  console.log(`warm() call: ${t.toFixed(1)} ms`);
  await tv.waitForTimeout(2500);
}
await tv.evaluate(programProbe);
const rows = await tv.evaluate((id) => new Promise((done) => {
  const k = window.kaleido;
  const out = [];
  let last = 0;
  const st = k.stage;
  const timed = (obj, name, key) => {
    const f = obj[name].bind(obj);
    obj[name] = (...a) => { const t0 = performance.now(); const r = f(...a); window.__acc[key] = (window.__acc[key] || 0) + performance.now() - t0; return r; };
  };
  window.__acc = {};
  timed(st, 'update', 'stage.update');
  timed(st, 'render', 'stage.render');
  for (const n of ['prepareBowlWorld', 'prepareDuelWorld', 'prepareArcheryWorld', 'prepareBaseballWorld']) if (k[n]) timed(k, n, 'app.' + n);
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    window.__acc = {};
    const a = performance.now();
    orig(now);
    const js = performance.now() - a;
    out.push({ gap: last ? +(now - last).toFixed(1) : 0, js: +js.toFixed(1), acc: Object.fromEntries(Object.entries(window.__acc).map(([k2, v]) => [k2, +v.toFixed(1)])) });
    last = now;
  };
  st.setWorld(id, { transition: true });
  setTimeout(() => { k.frame = orig; done(out); }, 2200);
}), to);
console.log(`${from} -> ${to} (${sport}${warm ? '' : ', not warmed'})`);
for (const [i, r] of rows.entries()) if (r.js > 12 || r.gap > 25) console.log(`  frame ${i}: gap ${r.gap} js ${r.js}  ${JSON.stringify(r.acc)}`);
const progs = await tv.evaluate(programReport);
console.log(`SUMMARY ${from}->${to} ${sport}: max js ${Math.max(...rows.map((r) => r.js)).toFixed(0)} ms, worst gap ${Math.max(...rows.map((r) => r.gap)).toFixed(0)} ms, late(>25) ${rows.filter((r) => r.gap > 25).length}, programs built ${progs.length}`);
if (process.env.QUIET) {
  await browser.close();
  process.exit(0);
}
console.log('programs built during it:\n  ' + progs.join('\n  '));
await browser.close();
