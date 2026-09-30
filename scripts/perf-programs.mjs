// Shader programs built (or rebuilt) while a sport plays, in its CPU-vs-CPU showcase — each one
// is a driver stall the first time it draws (see lib/perf-probe.mjs). Counted through play, then
// through a shatter into a world that was warmed a few seconds before: the count should be 0 in
// every sport; anything listed is a material that got past the compile watch.
//   node scripts/perf-programs.mjs [worlds] [seconds] [sports]
import { chromium } from 'playwright-core';
import { programProbe, programReport } from './lib/perf-probe.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const worlds = (process.argv[2] || 'plaza,park').split(',');
const secs = +(process.argv[3] || 25);
const sports = (process.argv[4] || 'tennis,bowling,duel,archery,baseball').split(',');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
const errors = [];
tv.on('pageerror', (e) => errors.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
// (installed once: what is built after this is what a game builds mid-play)
await tv.evaluate(programProbe);
for (const world of worlds)
  for (const sport of sports) {
    await tv.evaluate(([w, s]) => { window.kaleido.startAttract(w, s); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [world, sport]);
    await tv.waitForTimeout(3500);
    // (the sport's own start-up is over; what is built from here on is mid-play)
    await tv.evaluate(() => (window.__newProgs.length = 0));
    // a shatter into another world mid-sport, warmed the way the game does it
    const next = worlds.find((w) => w !== world) || 'ink';
    await tv.evaluate((id) => { const k = window.kaleido; k.stage.warm(id, k.rig.cam); }, next);
    await tv.waitForTimeout(secs * 500);
    // (programs built while the next world waits in the wings are built behind the scenes: fine)
    const waited = await tv.evaluate(() => window.__newProgs.length);
    await tv.evaluate(() => (window.__newProgs.length = 0));
    await tv.evaluate((id) => window.kaleido.stage.setWorld(id, { transition: true }), next);
    await tv.waitForTimeout(secs * 500);
    const rep = await tv.evaluate(programReport);
    console.log(`${world}/${sport}: ${rep.length} programs built in the shatter and after (${waited} while the next world waited)${rep.length ? '\n  ' + rep.join('\n  ') : ''}`);
  }
if (errors.length) console.log('page errors:', errors.join(' | '));
await browser.close();
