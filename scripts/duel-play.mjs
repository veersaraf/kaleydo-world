// Plays a sword duel on the TV (you vs a CPU) through the real input callbacks,
// with a simple scripted player: guard across the CPU's windups, strike back
// when it's stunned or open. Screenshots key moments; checks the match finishes.
//   node scripts/duel-play.mjs <outDir> [world] [cpu skill]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2];
const world = process.argv[3] || 'park';
const skill = +(process.argv[4] || 0.3);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push('pageerror ' + e.message));
tv.on('console', (m) => {
  if (m.type() === 'error') logs.push('console ' + m.text());
});
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(500);
await tv.evaluate(([w, s]) => window.flow.beginDuel(w, s), [world, skill]);
await tv.waitForTimeout(1200);
await tv.screenshot({ path: `${out}/duel-${world}-intro.png` });
await tv.waitForFunction(() => window.kaleido.duel?.state === 'fight', null, { timeout: 20000 });
// the scripted player lives in the page: it reads the CPU like a person would
await tv.evaluate(() => {
  const k = window.kaleido;
  const st = (window.__duel = { events: [], guarding: false, nextSwing: 0, shots: {} });
  const on = k.duel.onEvent;
  k.duel.onEvent = (e) => {
    st.events.push(e.type === 'round-end' ? `round-end:${e.winner}` : e.type);
    on(e);
  };
  const tick = () => {
    const g = k.duel;
    if (!g || g.state === 'over') return;
    const me = g.fighters[0],
      cpu = g.fighters[1];
    const now = performance.now();
    // hold the guard through the windup and the strike itself
    const threat = cpu.phase === 'windup' || cpu.phase === 'slash' || cpu.phase === 'thrust';
    if (threat && !st.guarding && me.phase === 'ready') {
      st.guarding = true;
      k.input.localGuardAngle = null;
      k.input.onGuard(0, true);
    } else if (!threat && st.guarding) {
      st.guarding = false;
      k.input.onGuard(0, false);
    }
    // strike when they're dazed, or now and then when they're just standing there
    const open = cpu.phase === 'stunned' || (cpu.phase === 'ready' && Math.random() < 0.02);
    if (!st.guarding && me.phase === 'ready' && open && now > st.nextSwing) {
      st.nextSwing = now + 450;
      const dirs = [0, Math.PI, -Math.PI / 2, -Math.PI / 4, (-3 * Math.PI) / 4];
      k.duelKeySlash(0, { kind: 'slash', dir: dirs[Math.floor(Math.random() * dirs.length)], power: 0.85 });
    }
    requestAnimationFrame(tick);
  };
  tick();
});
// screenshots: a windup, a block, a hit, a fall
const shot = async (name, pred, timeout = 30000) => {
  const ok = await tv.waitForFunction(pred, null, { timeout, polling: 'raf' }).then(() => true).catch(() => false);
  if (ok) await tv.screenshot({ path: `${out}/duel-${world}-${name}.png` });
  return ok;
};
await shot('fight', () => true);
await shot('windup', () => window.kaleido.duel.fighters[1].phase === 'windup' && window.kaleido.duel.fighters[1].t > 0.25);
await shot('block', () => window.__duel.events.includes('block'), 30000);
await shot('hit', () => window.kaleido.duel.fighters.some((f) => f.phase === 'stagger'), 30000);
await shot('fall', () => window.kaleido.duel.state === 'fall' && window.kaleido.duel.fighters.some((f) => f.phase === 'fall' && f.t > 0.35), 90000);
await tv.waitForFunction(() => window.kaleido.duel?.state === 'round-end', null, { timeout: 30000 }).catch(() => null);
await tv.waitForTimeout(600);
await tv.screenshot({ path: `${out}/duel-${world}-roundend.png` });
const over = await tv.waitForFunction(() => window.kaleido.duel?.state === 'over', null, { timeout: 240000, polling: 500 }).then(() => true).catch(() => false);
await tv.waitForTimeout(3400);
await tv.screenshot({ path: `${out}/duel-${world}-results.png` });
const r = await tv.evaluate(() => {
  const g = window.kaleido.duel;
  const ev = window.__duel.events;
  const count = (t) => ev.filter((e) => e === t).length;
  return { state: g?.state, score: g?.score, rounds: ev.filter((e) => e.startsWith('round-end')), hits: count('hit'), blocks: count('block'), clashes: count('clash'), attacks: count('attack'), falls: count('fall'), results: !!document.querySelector('.results') };
});
console.log(JSON.stringify(r));
console.log(over ? 'match finished' : 'MATCH DID NOT FINISH');
console.log(logs.join('\n') || 'no errors');
await browser.close();
