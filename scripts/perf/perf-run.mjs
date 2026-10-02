// End-to-end smoothness check: boot, then attract play across worlds (with switches).
// Reports frame gaps, JS time, GPU time and quality changes.
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const worlds = (process.argv[2] || 'plaza,ink,neon,clay,paper,water,cosmic,pixel').split(',');
const secs = +(process.argv[3] || 5);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/' + (process.env.QUERY || ''));
await tv.waitForFunction(() => !document.querySelector('.boot') || document.querySelector('.boot.done'), null, { timeout: 30000 });
await tv.waitForTimeout(1500);
await tv.evaluate(() => {
  const k = window.kaleido;
  window.__rows = [];
  window.__ev = [];
  const orig = k.frame.bind(k);
  let last = 0;
  k.frame = (now) => {
    const a = performance.now();
    orig(now);
    window.__rows.push({ gap: last ? now - last : 0, js: performance.now() - a, w: k.stage.current?.def.id });
    last = now;
  };
  const oq = k.applyQuality.bind(k);
  k.applyQuality = () => { window.__ev.push(`${k.stage.current?.def.id}: level ${k.quality.level} (pr ${k.pr})`); oq(); };
});
const stat = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return `p50 ${q(0.5).toFixed(1)} p99 ${q(0.99).toFixed(1)} max ${s[s.length - 1].toFixed(1)}`; };
for (const w of worlds) {
  // switch like the attract loop / Kaleydo does: a shatter transition into the next world
  await tv.evaluate((w) => window.kaleido.stage.setWorld(w, { transition: true }), w);
  await tv.evaluate(() => (window.__rows.length = 0));
  await tv.waitForTimeout(secs * 1000);
  const rows = await tv.evaluate(() => window.__rows.slice());
  const gaps = rows.slice(1).map((r) => r.gap);
  const late = gaps.filter((g) => g > 25).length;
  const gpu = await tv.evaluate(() => { const q = window.kaleido.quality; return q.gpu ? [...q.gpu].sort((a, b) => a - b) : []; });
  const gq = (p) => (gpu.length ? gpu[Math.min(gpu.length - 1, Math.floor(p * gpu.length))].toFixed(1) : '-');
  console.log(`${w.padEnd(7)} frames ${String(rows.length).padStart(3)} | gap ${stat(gaps)} | >25ms: ${late} | js ${stat(rows.map((r) => r.js))} | gpu p50 ${gq(0.5)} p90 ${gq(0.9)}`);
}
console.log('quality changes:', JSON.stringify(await tv.evaluate(() => window.__ev)));
console.log(logs.join('\n'));
await browser.close();
