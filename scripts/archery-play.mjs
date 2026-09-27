// Plays a round of archery on the TV (you + a CPU) through the real input callbacks:
// a scripted archer aims at the main face (allowing for the drop, with a little
// wobble), draws for a moment and lets go. Screenshots each end's aim, the arrow
// in flight and where it landed; checks the round reaches the results.
//   node scripts/archery-play.mjs <outDir> [world] [cpu skill]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2];
const world = process.argv[3] || 'park';
const skill = +(process.argv[4] || 0.65);
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
await tv.evaluate(([w, s]) => window.flow.beginArchery(w, s), [world, skill]);
// the scripted archer's aim: straight at the main face, raised for the drop
await tv.evaluate(() => {
  const k = window.kaleido;
  const drop = (d) => (d < 18 ? 0.44 : d < 26 ? 0.99 : 1.89);
  k.mouseAim = (g) => {
    const f = g.mainTarget();
    const a = g.archer;
    const d = Math.hypot(f.x - a.x, f.z - a.z);
    const y = f.y + drop(d) - 1.55;
    const n = () => (Math.random() - 0.5) * 0.004;
    return { yaw: Math.atan2(-(f.x - a.x), -(f.z - a.z)) + n(), pitch: Math.atan2(y, d) + n() };
  };
});
const card = () => tv.evaluate(() => window.kaleido.archery.archers.map((a, i) => `${a.name}: ${window.kaleido.archery.scores[i].join(' ')} = ${window.kaleido.archery.total(i)}`).join('   '));
let lastEnd = 0;
for (let shot = 0; shot < 40; shot++) {
  const st = await tv.waitForFunction(() => { const g = window.kaleido.archery; return g && (g.state === 'aim' || g.state === 'over') && g.state; }, null, { timeout: 60000, polling: 100 }).then((h) => h.jsonValue()).catch(() => 'stuck');
  if (st !== 'aim') {
    if (st === 'stuck') logs.push('STUCK in ' + (await tv.evaluate(() => window.kaleido.archery?.state)));
    break;
  }
  const who = await tv.evaluate(() => { const g = window.kaleido.archery; return { cpu: g.archers[g.current].cpu, end: g.end, arrow: g.arrowNo }; });
  if (who.cpu !== null) {
    await tv.waitForFunction(() => window.kaleido.archery.state !== 'aim', null, { timeout: 30000, polling: 100 });
    continue;
  }
  await tv.evaluate(() => window.kaleido.input.onDraw(0, true));
  await tv.waitForTimeout(1300);
  if (who.end !== lastEnd) {
    await tv.screenshot({ path: `${out}/arch-${world}-end${who.end}-aim.png` });
  }
  await tv.evaluate(() => window.kaleido.input.onDraw(0, false));
  if (who.end !== lastEnd) {
    await tv.waitForFunction(() => { const a = window.kaleido.archery.shotArrow; const t = window.kaleido.archery.mainTarget(); return a && a.state === 'flying' && a.z - t.z < 5; }, null, { timeout: 5000, polling: 'raf' }).catch(() => null);
    await tv.screenshot({ path: `${out}/arch-${world}-end${who.end}-flight.png` });
    await tv.waitForFunction(() => window.kaleido.archery.state === 'result', null, { timeout: 8000, polling: 50 }).catch(() => null);
    await tv.waitForTimeout(700);
    await tv.screenshot({ path: `${out}/arch-${world}-end${who.end}-result.png` });
    lastEnd = who.end;
  }
  await tv.waitForFunction(() => window.kaleido.archery.state !== 'flight', null, { timeout: 8000, polling: 100 }).catch(() => null);
  console.log(`end ${who.end} arrow ${who.arrow} → ${await card()}`);
}
await tv.waitForFunction(() => document.querySelector('.results'), null, { timeout: 30000, polling: 250 }).catch(() => logs.push('no results screen'));
await tv.waitForTimeout(700);
await tv.screenshot({ path: `${out}/arch-${world}-results.png` });
console.log(logs.join('\n') || 'no errors');
await browser.close();
