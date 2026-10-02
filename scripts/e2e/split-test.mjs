// Two phones join, play "P1 vs P2": the TV should split into two views.
import { launchChrome, outDir } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const out = outDir('split');
const world = process.argv[3] || 'plaza';
const browser = await launchChrome(['--use-angle=metal', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const logs = [];
const tv = await ctx.newPage();
tv.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('AudioContext')) logs.push('[tv] ' + m.text()); });
tv.on('pageerror', (e) => logs.push('[tv pageerror] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate((w) => localStorage.setItem('kaleido.settings', JSON.stringify({ games: 1, level: 'club', seenTutorial: true, teamPreset: 0, world: w })), world);
await tv.goto(BASE + '/');
await tv.waitForTimeout(1500);
const pads = [];
for (const name of ['Veer', 'Sam']) {
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => logs.push('[pad pageerror] ' + e.message));
  await pad.setViewportSize({ width: 390, height: 844 });
  await pad.goto(BASE + '/controller.html?auto&n=' + name);
  await pad.evaluate((n) => { localStorage.setItem('kaleido.name', n); }, name);
  await pad.goto(BASE + '/controller.html?auto&n=' + name);
  await pad.waitForTimeout(1200);
  pads.push(pad);
}
await tv.bringToFront();
// start the match directly with the flow's own config builder (P1 vs P2)
await tv.evaluate((w) => { const f = window.flow; f.mode = 'quick'; f.beginMatch(w); }, world);
await tv.waitForTimeout(1300);
await tv.screenshot({ path: out + '/split-intro.png' });
await tv.evaluate(() => {
  const k = window.kaleido;
  const planned = {}; const at = {};
  const loop = () => {
    const m = k.match;
    if (m && !k.attract && !k.paused) {
      for (const p of m.players.filter((q) => q.human)) {
        const s = p.slot;
        if (m.state === 'intro') m.startNow?.();
        if (m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.7) k.input.onToss(s);
        if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: s, power: 0.8, spin: 0.2, age: 0, source: 'key' });
        if (p.plan && p.plan !== planned[p.id]) { planned[p.id] = p.plan; at[p.id] = p.plan.t + (Math.random() - 0.5) * 0.12; }
        if (planned[p.id] && p.plan === planned[p.id] && m.t >= at[p.id]) { k.input.onSwing({ slot: s, power: 0.5 + Math.random() * 0.5, spin: Math.random() - 0.3, age: 0, source: 'key', side: p.plan.stroke === 'bh' ? 'bh' : 'fh' }); planned[p.id] = null; }
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
  // fps meter
  window.__frames = 0;
  const f = () => { window.__frames++; requestAnimationFrame(f); };
  f();
});
await tv.waitForTimeout(3500);
await tv.screenshot({ path: out + '/split-play.png' });
const f0 = await tv.evaluate(() => window.__frames);
await tv.waitForTimeout(4000);
const f1 = await tv.evaluate(() => window.__frames);
await tv.screenshot({ path: out + '/split-play2.png' });
const info = await tv.evaluate(() => { const k = window.kaleido; const m = k.match; return { split: k.split, splitOn: k.splitOn, views: k.stage.views, players: m.players.map((p) => `${p.name}:${p.ctrl.kind}:${p.slot}:t${p.team}`), score: m.score.points, state: m.state, hits: m.players.map((p) => p.hits), mode: k.rig.mode, rig2: k.rig2.mode, replay: !!k.replay }; });
console.log(JSON.stringify(info), 'fps', ((f1 - f0) / 4).toFixed(1));
// wait for a replay to check full screen
for (let i = 0; i < 40; i++) {
  const r = await tv.evaluate(() => !!window.kaleido.replay);
  if (r) { await tv.waitForTimeout(800); await tv.screenshot({ path: out + '/split-replay.png' }); console.log('replay views', await tv.evaluate(() => window.kaleido.stage.views)); break; }
  await tv.waitForTimeout(500);
}
console.log(logs.join('\n'));
await browser.close();
