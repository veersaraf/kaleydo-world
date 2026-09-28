// Screenshots of the smash in each world: the build-up (bullet time, low camera,
// reticle), the contact, the flight and the impact — plus the replay's slow
// contact. The CPU is made to float moonballs so chances come quickly; the
// "player" swings a keyboard smash right on time.
//   BASE=http://localhost:4700 node scripts/smash-shots.mjs <outDir> [worlds] [late]
//   (late = 1: swing ~150 ms late, to see a weaker smash)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2] || 'shots';
const worlds = (process.argv[3] || 'park,plaza,paper,clay,water,ink,neon,cosmic,pixel').split(',');
const late = +(process.argv[4] || 0);
// cpu = 1: lob every ball up instead, to see a CPU's (lighter) smash at you
const cpuMode = process.argv[5] === 'cpu';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6 })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 60000 });
await tv.waitForTimeout(600);

await tv.evaluate(([late, cpuMode]) => {
  const k = window.kaleido;
  // freeze the whole loop on a moment so the screenshot is exactly it
  const frame = k.frame.bind(k);
  const S = (window.__smash = { cpuAt: -1, freeze: false, want: null, done: {}, hitAt: -1, frames: 0, bounceAt: -1, stats: [] });
  k.frame = (now) => {
    if (S.freeze) {
      k.last = now;
      return;
    }
    frame(now);
    S.frames++;
    const m = k.match;
    if (!m) return;
    const cue = k.smashCue;
    const shoot = (name) => {
      if (S.done[name]) return;
      S.done[name] = true;
      S.want = name;
      S.freeze = true;
    };
    if (cue && cue.tl < 0.42 && cue.tl > 0.1 && cue.w > 0.6) shoot('1-buildup');
    if (S.hitAt >= 0 && S.frames - S.hitAt === 2) shoot('2-contact');
    if (S.hitAt >= 0 && m.t - S.hitT > 0.12 && S.bounceAt < 0) shoot('3-flight');
    if (S.bounceAt >= 0 && S.frames - S.bounceAt === 8) shoot('4-impact');
    if (S.cpuAt >= 0 && S.frames - S.cpuAt === 2) shoot('cpu-contact');
    if (S.cpuAt >= 0 && S.frames - S.cpuAt === 24) shoot('cpu-flight');
    if (k.replay && k.replay.smash && Math.abs(k.replay.time - k.replay.smash.t) < 0.03) shoot('5-replay');
  };
  const onEv = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    onEv(e);
    if (e.type === 'hit' && e.kind === 'smash' && e.p.human) {
      S.hitAt = S.frames;
      S.hitT = k.match.t;
      S.bounceAt = -1;
      S.stats.push({ kph: Math.round(e.kph), perfect: e.perfect, tau: +e.tau.toFixed(2) });
    }
    if (e.type === 'bounce' && S.hitAt >= 0 && S.bounceAt < 0 && e.live) S.bounceAt = S.frames;
    if (e.type === 'hit' && !(e.kind === 'smash' && e.p.human)) S.hitAt = -1;
    if (e.type === 'hit' && e.kind === 'smash' && !e.p.human) S.cpuAt = S.frames;
  };
  // the "player": swings on time (a keyboard swing); smashes right on the contact
  const planned = {};
  const loop = () => {
    const m = k.match;
    if (m && !k.paused && !S.freeze) {
      for (const cpu of m.players.filter((q) => !q.human)) if (cpu.ctrl.ai.lob < 1) cpu.ctrl.ai = { ...cpu.ctrl.ai, lob: 1.2 };
      for (const p of m.players.filter((q) => q.human)) {
        if (m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.6) k.input.onToss(p.slot);
        if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: p.slot, power: 0.95, spin: 0.2, age: 0, source: 'key' });
        const smash = !!p.plan && p.plan.stroke === 'oh' && p.plan.by > 1.9;
        if (p.plan && p.plan !== planned[p.id]?.plan) planned[p.id] = { plan: p.plan, at: p.plan.t + (smash ? late * 0.15 : (Math.random() - 0.5) * 0.06) };
        const pl = planned[p.id];
        if (pl && p.plan === pl.plan && m.t >= pl.at) {
          if (cpuMode) k.input.onSwing({ slot: p.slot, power: 0.18, spin: 0.7, age: 0, source: 'key' });
          else k.input.onSwing({ slot: p.slot, power: 0.7 + Math.random() * 0.3, spin: 0.2, age: 0, source: 'key', side: p.plan.stroke === 'bh' ? 'bh' : 'fh' });
          planned[p.id] = { plan: p.plan, at: Infinity };
        }
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
}, [late, cpuMode]);

for (const w of worlds) {
  await tv.evaluate((w) => {
    const f = window.flow;
    f.mode = 'quick';
    f.beginMatch(w);
    window.kaleido.match.startNow();
    const S = window.__smash;
    S.done = {};
    S.hitAt = -1;
    S.bounceAt = -1;
  }, w);
  const t0 = Date.now();
  const need = cpuMode ? ['cpu-contact', 'cpu-flight'] : ['1-buildup', '2-contact', '3-flight', '4-impact'];
  while (Date.now() - t0 < 150000) {
    const st = await tv.evaluate(() => ({ want: window.__smash.want, done: Object.keys(window.__smash.done) }));
    if (st.want) {
      await tv.screenshot({ path: `${out}/${w}-${st.want}.png` });
      await tv.evaluate(() => {
        window.__smash.want = null;
        window.__smash.freeze = false;
      });
      continue;
    }
    if (need.every((n) => st.done.includes(n)) && (cpuMode || w !== worlds[0] || st.done.includes('5-replay') || Date.now() - t0 > 120000)) break;
    await tv.waitForTimeout(40);
  }
  const done = await tv.evaluate(() => Object.keys(window.__smash.done));
  console.log(w, done.join(' '));
}
console.log(JSON.stringify(await tv.evaluate(() => window.__smash.stats)));
console.log(logs.join('\n') || 'ok');
await browser.close();
