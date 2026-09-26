// How stable is the human's planned contact time while a fed ball approaches?
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForTimeout(1500);
await tv.mouse.click(640, 360);
await tv.waitForTimeout(700);
await tv.evaluate(() => [...document.querySelectorAll('.item')].find((e) => e.textContent.includes('Swing Lab'))?.click());
await tv.waitForTimeout(2000);
// sample from inside the page every frame for 12 s
const trace = await tv.evaluate(() => new Promise((res) => {
  const m = window.kaleido.match;
  const out = [];
  const t0 = performance.now();
  let lastWall = t0, lastSim = m.t;
  const tick = () => {
    const p = m.players.find((q) => q.human);
    const now = performance.now();
    out.push({ wall: +(now - t0).toFixed(0), sim: +m.t.toFixed(3), dSim: +(m.t - lastSim).toFixed(4), dWall: +((now - lastWall) / 1000).toFixed(4), state: m.state, plan: p.plan ? +p.plan.t.toFixed(3) : null, stroke: p.plan?.stroke });
    lastWall = now; lastSim = m.t;
    if (now - t0 < 12000) requestAnimationFrame(tick); else res(out);
  };
  tick();
}));
let prev = null;
for (const r of trace) {
  if (r.plan !== prev) console.log(`${r.wall}ms sim ${r.sim} state ${r.state} plan ${r.plan} ${r.stroke ?? ''} (plan-sim ${r.plan ? (r.plan - r.sim).toFixed(3) : '-'})`);
  prev = r.plan;
}
const ratios = trace.slice(1).map((r) => r.dSim / Math.max(1e-4, r.dWall));
console.log('sim/wall ratio: min', Math.min(...ratios).toFixed(2), 'median', ratios.sort((a, b) => a - b)[ratios.length >> 1].toFixed(2), 'frames', trace.length, 'in 12s');
await browser.close();
