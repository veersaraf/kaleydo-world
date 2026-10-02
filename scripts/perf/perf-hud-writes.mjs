// Which DOM nodes get attribute/style writes during play, and how many per second — the
// sources of the HUD's style recalculations. (MutationObserver on the whole document.)
//   node scripts/perf/perf-hud-writes.mjs [world] [seconds]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 8);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6, mouse: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370);
await tv.waitForTimeout(300);
await tv.evaluate((w) => { const f = window.flow; f.mode = 'quick'; f.beginMatch(w); }, world);
await tv.evaluate(() => {
  const k = window.kaleido;
  const planned = {};
  const auto = () => {
    const m = k.match;
    if (m && !k.paused) {
      if (m.state === 'intro') m.startNow();
      for (const p of m.players.filter((q) => q.human)) {
        if (m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.8) k.input.onToss(p.slot);
        if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: p.slot, power: 0.85, spin: 0.2, age: 0, source: 'key' });
        if (p.plan && p.plan !== planned[p.id]) planned[p.id] = { plan: p.plan, at: p.plan.t + (Math.random() - 0.5) * 0.1 };
        const pl = planned[p.id];
        if (pl && p.plan === pl.plan && m.t >= pl.at) { k.input.onSwing({ slot: p.slot, power: 0.5 + Math.random() * 0.5, spin: Math.random() - 0.3, age: 0, source: 'key', side: p.plan.stroke === 'bh' ? 'bh' : 'fh' }); planned[p.id] = null; }
      }
    }
    requestAnimationFrame(auto);
  };
  auto();
});
await tv.waitForTimeout(3000);
const rows = await tv.evaluate(
  (secs) =>
    new Promise((done) => {
      const counts = {};
      const name = (el) => (el.nodeType === 1 ? `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}` : el.nodeName);
      const mo = new MutationObserver((list) => {
        for (const r of list) {
          const key = `${name(r.target)} [${r.type === 'attributes' ? r.attributeName : r.type}]`;
          counts[key] = (counts[key] || 0) + 1;
        }
      });
      mo.observe(document, { attributes: true, childList: true, characterData: true, subtree: true });
      setTimeout(() => {
        mo.disconnect();
        done(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${String(Math.round(v / secs)).padStart(5)}/s  ${k}`));
      }, secs * 1000);
    }),
  secs,
);
console.log(rows.join('\n'));
await browser.close();
