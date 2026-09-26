// Two phones join, set up "P1 & P2 vs CPU" doubles, and both auto-swing.
import { chromium } from 'playwright-core';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const logs = [];
const tv = await ctx.newPage();
tv.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('AudioContext')) logs.push('[tv] ' + m.text()); });
tv.on('pageerror', (e) => logs.push('[tv pageerror] ' + e.message));
await tv.goto('http://localhost:3000/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ games: 1, level: 'club', seenTutorial: true, teamPreset: 1 })));
await tv.goto('http://localhost:3000/');
await tv.waitForTimeout(1500);
const pads = [];
for (const name of ['Veer', 'Sam']) {
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => logs.push('[pad pageerror] ' + e.message));
  await pad.setViewportSize({ width: 390, height: 844 });
  await pad.goto('http://localhost:3000/controller.html?auto&transport=http');
  await pad.evaluate((n) => { localStorage.setItem('kaleido.name', n); }, name);
  await pad.goto('http://localhost:3000/controller.html?auto&transport=http&n=' + name);
  await pad.waitForTimeout(1200);
  pads.push(pad);
}
await tv.keyboard.press('Enter'); await tv.waitForTimeout(600);
await tv.keyboard.press('Enter'); await tv.waitForTimeout(800);
await tv.screenshot({ path: out + '/m-setup.png' });
await tv.keyboard.press('Enter'); await tv.waitForTimeout(900);
await tv.keyboard.press('ArrowRight'); await tv.waitForTimeout(250);
await tv.keyboard.press('ArrowRight'); await tv.waitForTimeout(250);
await tv.keyboard.press('ArrowRight'); await tv.waitForTimeout(1200);
await tv.keyboard.press('Enter'); await tv.waitForTimeout(1500);
// auto-play for both human slots
await tv.evaluate(() => {
  const k = window.kaleido;
  const planned = {}; const at = {};
  const loop = () => {
    const m = k.match;
    if (m && !k.attract && !k.paused) {
      for (const p of m.players.filter((q) => q.human)) {
        const s = p.slot;
        if (m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.7) k.input.onToss(s);
        if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: s, power: 0.8, spin: 0.2, age: 0, source: 'key' });
        if (p.plan && p.plan !== planned[p.id]) { planned[p.id] = p.plan; at[p.id] = p.plan.t + (Math.random() - 0.5) * 0.3; }
        if (planned[p.id] && p.plan === planned[p.id] && m.t >= at[p.id]) { k.input.onSwing({ slot: s, power: 0.4 + Math.random() * 0.6, spin: Math.random() - 0.3, age: 0, source: 'key' }); planned[p.id] = null; }
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
});
await tv.waitForTimeout(12000);
await tv.screenshot({ path: out + '/m-play.png' });
const info = await tv.evaluate(() => { const m = window.kaleido.match; return { doubles: m.doubles, players: m.players.map((p) => `${p.name}:${p.ctrl.kind}:${p.slot}:${p.role}`), score: m.score.points, games: m.score.games, state: m.state, hits: m.players.map((p) => p.hits) }; });
const padModes = [];
for (const p of pads) padModes.push(await p.evaluate(() => ({ badge: document.querySelector('.badge')?.textContent, name: document.querySelector('.who')?.textContent, panel: [...document.querySelectorAll('.panel.on')].map((e) => e.className).join(','), title: document.querySelector('.panel.on .ptitle, .panel.on .toss b, .panel.on .wtitle')?.textContent })));
await pads[1].screenshot({ path: out + '/m-pad2.png' });
console.log(JSON.stringify({ info, padModes }, null, 1));
console.log(logs.join('\n'));
await browser.close();
