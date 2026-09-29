// Frame times while duelling (you + an Ace CPU; you guard its windups and strike back) —
// JS time per frame, frame gaps and late frames, and the slowest moments.
//   node scripts/perf-duel.mjs [world] [seconds]
import { chromium } from 'playwright-core';
import { programProbe, programReport } from './lib/perf-probe.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'park';
const secs = +(process.argv[3] || 40);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370);
await tv.evaluate((w) => window.flow.beginDuel(w, 0.9), world);
await tv.waitForFunction(() => window.kaleido.duel && window.kaleido.duel.state !== 'intro', null, { timeout: 30000 });
await tv.evaluate(programProbe);
const res = await tv.evaluate((secs) => new Promise((done) => {
  const k = window.kaleido;
  const rows = [];
  const slow = [];
  let last = 0;
  const orig = k.frame.bind(k);
  k.frame = (now) => {
    const a = performance.now();
    const st = k.duel?.state;
    orig(now);
    const js = performance.now() - a;
    rows.push([last ? now - last : 0, js]);
    if (js > 6) slow.push(`${js.toFixed(1)}ms in ${st}->${k.duel?.state}`);
    last = now;
  };
  // guard across the CPU's windups, strike back when it's stunned
  let guarding = false;
  const auto = setInterval(() => {
    const g = k.duel;
    if (!g) return;
    if (g.state === 'over') {
      if (!k.__again) k.__again = setTimeout(() => ((k.__again = 0), window.flow.beginDuel('park', 0.9)), 3500);
      return;
    }
    const me = g.fighters[0], cpu = g.fighters[1];
    const threat = cpu.phase === 'windup' || cpu.phase === 'slash' || cpu.phase === 'thrust';
    if (threat !== guarding) { guarding = threat; k.input.localGuardAngle = null; k.input.onGuard(0, threat); }
    if (!guarding && me.phase === 'ready' && (cpu.phase === 'stunned' || Math.random() < 0.05)) k.duelKeySlash(0, { kind: 'slash', dir: Math.random() < 0.5 ? 0 : -Math.PI / 2, power: 0.85 });
  }, 50);
  setTimeout(() => {
    clearInterval(auto);
    const gaps = rows.slice(5).map((r) => r[0]).sort((a, b) => a - b);
    const js = rows.slice(5).map((r) => r[1]).sort((a, b) => a - b);
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
    done({ frames: rows.length, gapP50: q(gaps, 0.5), gapP99: q(gaps, 0.99), late: gaps.filter((g) => g > 20).length, jsP50: q(js, 0.5), jsP95: q(js, 0.95), jsP99: q(js, 0.99), jsMax: js[js.length - 1].toFixed(1), slow: slow.slice(0, 12), quality: k.quality?.level ?? null });
  }, secs * 1000);
}), secs);
console.log(JSON.stringify(res, null, 1));
console.log(logs.join('\n') || 'no errors');
console.log('shader programs built during play:', JSON.stringify(await tv.evaluate(programReport)));
await browser.close();
