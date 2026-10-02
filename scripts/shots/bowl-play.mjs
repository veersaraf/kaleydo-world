// Plays a bowling game on the TV (you + a CPU) through the real input callbacks,
// screenshots key moments and prints the scoring as it goes.
//   node scripts/shots/bowl-play.mjs <outDir> [world] [frames]
//   node scripts/shots/bowl-play.mjs <outDir> [world] end   (frames 1–9 prefilled: the 10th frame and the results)
import { launchChrome, outDir } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const out = outDir('bowl-play', { inRepo: true });
const world = process.argv[3] || 'park';
const toEnd = process.argv[4] === 'end';
const frames = toEnd ? 10 : +(process.argv[4] || 3);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push('pageerror ' + e.message));
tv.on('console', (m) => { if (m.type() === 'error') logs.push('console ' + m.text()); });
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(500);
await tv.evaluate((w) => window.flow.beginBowling(w, 0.65), world);
await tv.waitForFunction(() => window.kaleido.bowl && window.kaleido.bowl.state === 'ready', null, { timeout: 30000 });
await tv.screenshot({ path: `${out}/bowl-${world}-ready.png` });
if (toEnd) {
  // nine frames already bowled (a strike, a spare, an open frame…), as if we'd played them
  await tv.evaluate(() => {
    const g = window.kaleido.bowl;
    const rolls = [[10], [7, 3], [9, 0], [10], [10], [8, 2], [6, 3], [10], [9, 1]];
    for (const b of g.bowlers) for (const f of rolls) for (const r of f) b.score.add(r);
    window.flow.bowlHud?.update(g.current);
  });
}
const shot = { back: false, lane: false, pins: false, result: false };
let lastFrame = -1;
for (let turn = 0; turn < frames * 4; turn++) {
  // wait for a ball to be up
  const st = await tv.waitForFunction(() => { const g = window.kaleido.bowl; return g && (g.state === 'ready' || g.state === 'over') && g.state; }, null, { timeout: 60000, polling: 100 }).then((h) => h.jsonValue());
  if (st === 'over') break;
  const info = await tv.evaluate(() => { const g = window.kaleido.bowl; return { who: g.bowler.name, cpu: g.bowler.cpu, frame: g.bowler.score.frame, ball: g.bowler.score.ball }; });
  if (info.frame >= frames) break;
  if (info.cpu === null) {
    // grip, then stream the arm like a phone does (20 Hz): down and back to the
    // top of the backswing, then through; let go at the bottom with a hook
    await tv.evaluate(() => {
      const k = window.kaleido;
      k.input.onGrip(0, true);
      const t0 = performance.now();
      const arm = (s) => (s < 0.55 ? 0.9 - (s / 0.55) * 2.4 : -1.5 + ((s - 0.55) / 0.45) * 1.6);
      window.__armT = setInterval(() => k.input.onArm(0, arm((performance.now() - t0) / 1000)), 50);
    });
    if (!shot.back) {
      await tv.waitForTimeout(560);
      await tv.screenshot({ path: `${out}/bowl-${world}-backswing.png` });
      await tv.waitForTimeout(440);
      shot.back = true;
    } else await tv.waitForTimeout(1000);
    // from the starting spot a straight ball meets the pocket; a phone's swing is
    // never perfectly straight (the game takes a fifth of the measured angle)
    await tv.evaluate(() => { const k = window.kaleido; const n = () => (Math.random() - 0.5); clearInterval(window.__armT); k.input.onGrip(0, false); k.input.onBowl(0, { speed: 7.8 + n() * 0.6, angle: n() * 0.04, spin: n() * 0.1 }); });
  }
  // screenshots of the first roll
  if (!shot.lane) { await tv.waitForFunction(() => { const g = window.kaleido.bowl; return g.state === 'lane' && g.phys.view.ball.z < 2; }, null, { timeout: 20000, polling: 'raf' }).catch(() => null); await tv.screenshot({ path: `${out}/bowl-${world}-lane.png` }); shot.lane = true; }
  if (!shot.pins) { await tv.waitForFunction(() => { const g = window.kaleido.bowl; return g.state === 'pins' || g.state === 'result'; }, null, { timeout: 20000, polling: 'raf' }).catch(() => null); await tv.waitForTimeout(250); await tv.screenshot({ path: `${out}/bowl-${world}-pins.png` }); shot.pins = true; }
  const res = await tv.waitForFunction(() => { const g = window.kaleido.bowl; return (g.state === 'result' || g.state === 'sweep' || g.state === 'over') && g.state; }, null, { timeout: 30000, polling: 100 }).then((h) => h.jsonValue()).catch(() => 'stuck');
  if (res === 'stuck') { logs.push('STUCK in ' + (await tv.evaluate(() => window.kaleido.bowl.state))); break; }
  if (!shot.result) { await tv.waitForTimeout(500); await tv.screenshot({ path: `${out}/bowl-${world}-result.png` }); shot.result = true; }
  const card = await tv.evaluate(() => window.kaleido.bowl.bowlers.map((b) => `${b.name}: ${b.score.frames().map((f) => f.rolls.join('')).join('|')} = ${b.score.total()}`).join('   '));
  if (info.frame !== lastFrame || true) console.log(`${info.who} f${info.frame + 1} b${info.ball + 1} → ${card}`);
  lastFrame = info.frame;
  await tv.waitForFunction(() => { const g = window.kaleido.bowl; return g.state !== 'result'; }, null, { timeout: 10000, polling: 100 }).catch(() => null);
}
await tv.screenshot({ path: `${out}/bowl-${world}-card.png` });
if (toEnd) {
  await tv.waitForFunction(() => document.querySelector('.results'), null, { timeout: 30000, polling: 200 }).catch(() => logs.push('no results screen'));
  await tv.waitForTimeout(800);
  await tv.screenshot({ path: `${out}/bowl-${world}-results.png` });
}
console.log(logs.join('\n') || 'no errors');
await browser.close();
