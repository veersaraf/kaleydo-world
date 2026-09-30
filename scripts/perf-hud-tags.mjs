// Just the name tags and the Server badge: layouts and style recalculations over N seconds of the
// serve set-up with the players swaying (so every tag's position changes every frame, as it does
// while the camera moves in the intro). Chrome's Performance counters, as perf-hud.mjs.
//   node scripts/perf-hud-tags.mjs [world] [seconds]
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://localhost:3200';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 5);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6, mouse: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370);
await tv.evaluate((w) => { const f = window.flow; f.mode = 'quick'; f.beginMatch(w); }, world);
await tv.waitForFunction(() => window.kaleido.match && window.flow.hud, null, { timeout: 30000 });
await tv.waitForTimeout(2500);
await tv.evaluate(() => {
  const hud = window.flow.hud;
  const m = window.kaleido.match;
  const fake = { state: 'serve', server: null, players: m.players.map((p) => ({ x: p.x, z: p.z, team: p.team, name: p.name, look: p.look, human: p.human })) };
  fake.server = fake.players[0];
  const base = m.players.map((p) => ({ x: p.x, z: p.z }));
  const orig = hud.track.bind(hud);
  let t = 0;
  // (every call the game makes is answered with the swaying set-up)
  hud.track = (_m, dt, hint) => {
    t += dt;
    fake.players.forEach((p, i) => {
      p.x = base[i].x + Math.sin(t * 2 + i) * 0.6;
      p.z = base[i].z + Math.cos(t * 1.3 + i) * 0.4;
    });
    orig(fake, dt, hint);
  };
});
await tv.waitForTimeout(1500);
const cdp = await ctx.newCDPSession(tv);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
await tv.evaluate(() => {
  const k = window.kaleido;
  window.__n = 0;
  const o = k.frame.bind(k);
  k.frame = (now) => { window.__n++; o(now); };
});
const a = await metrics();
await tv.waitForTimeout(secs * 1000);
const b = await metrics();
const n = await tv.evaluate(() => window.__n);
const shown = await tv.evaluate(() => [...document.querySelectorAll('.ptags .ptag, .ptags .sbadge')].filter((e) => getComputedStyle(e).display !== 'none').length);
const d = (k) => b[k] - a[k];
console.log(`${world} ${secs}s | frames ${n} | tags showing ${shown} | layouts ${d('LayoutCount')} (${(d('LayoutDuration') * 1000).toFixed(1)} ms) | style recalcs ${d('RecalcStyleCount')} (${(d('RecalcStyleDuration') * 1000).toFixed(1)} ms) | per frame: layout ${(d('LayoutCount') / n).toFixed(2)} recalc ${(d('RecalcStyleCount') / n).toFixed(2)}`);
await browser.close();
