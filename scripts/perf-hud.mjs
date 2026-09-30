// What the HUD costs the browser during play: layouts and style recalculations (Chrome's
// Performance domain counters) and the time in them, over N seconds of a human-vs-CPU match
// (auto-swings, like perf-match.mjs) with the HUD showing.
//   node scripts/perf-hud.mjs [world] [seconds]
//   HOLD=serve  sits in the serve set-up (name tags and the Server badge showing) instead of rallying
//   HOLD=intro  stays in the intro (the camera moving, name tags on everyone)
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 10);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6, mouse: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370);
await tv.waitForTimeout(300);
await tv.evaluate((hold) => { window.__hold = hold === 'serve'; window.__holdIntro = hold === 'intro'; }, process.env.HOLD || '');
await tv.evaluate((w) => { const f = window.flow; f.mode = 'quick'; f.beginMatch(w); }, world);
// a human rally: swing for the human players whenever the plan says so (as perf-match.mjs does)
await tv.evaluate(() => {
  const k = window.kaleido;
  const planned = {};
  const auto = () => {
    const m = k.match;
    if (m && !k.paused) {
      if (m.state === 'intro' && !window.__holdIntro) m.startNow();
      for (const p of m.players.filter((q) => q.human)) {
        if (!window.__hold && m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.8) k.input.onToss(p.slot);
        if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: p.slot, power: 0.85, spin: 0.2, age: 0, source: 'key' });
        if (p.plan && p.plan !== planned[p.id]) planned[p.id] = { plan: p.plan, at: p.plan.t + (Math.random() - 0.5) * 0.1 };
        const pl = planned[p.id];
        if (pl && p.plan === pl.plan && m.t >= pl.at) { k.input.onSwing({ slot: p.slot, power: 0.5 + Math.random() * 0.5, spin: Math.random() - 0.3, age: 0, source: 'key', side: p.plan.stroke === 'bh' ? 'bh' : 'fh' }); planned[p.id] = null; }
      }
      if (m.state === 'over' && window.flow.screen?.name === 'results') window.flow.beginMatch(k.stage.current.def.id, true);
    }
    requestAnimationFrame(auto);
  };
  auto();
});
if (process.env.HOLD === 'serve') {
  // (wait for a serve to come up, with the players' own tags)
  await tv.waitForFunction(() => window.kaleido.match?.state === 'serve', null, { timeout: 60000 });
}
await tv.waitForTimeout(4000);
const cdp = await ctx.newCDPSession(tv);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const stateCounts = {};
await tv.evaluate(() => {
  const k = window.kaleido;
  window.__n = 0;
  window.__st = {};
  const o = k.frame.bind(k);
  k.frame = (now) => { window.__n++; const s = k.match?.state; window.__st[s] = (window.__st[s] || 0) + 1; o(now); };
});
const a = await metrics();
await tv.waitForTimeout(secs * 1000);
const b = await metrics();
const n = await tv.evaluate(() => window.__n);
const st = await tv.evaluate(() => window.__st);
const d = (k) => b[k] - a[k];
console.log(`${world} ${secs}s | frames ${n} | layouts ${d('LayoutCount')} (${(d('LayoutDuration') * 1000).toFixed(1)} ms) | style recalcs ${d('RecalcStyleCount')} (${(d('RecalcStyleDuration') * 1000).toFixed(1)} ms) | per frame: layout ${(d('LayoutCount') / n).toFixed(2)} recalc ${(d('RecalcStyleCount') / n).toFixed(2)}`);
console.log('match states over the window:', JSON.stringify(st));
await browser.close();
