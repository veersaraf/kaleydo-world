// Plays a home run derby on the TV (you + a CPU) through the game's own swing
// input: the scripted batter swings right on time (± a little), with a random
// power. Screenshots the intro, the batting view as the pitch comes in, the
// flight (the chase and the home-run shots) and the results; checks the derby
// reaches the results screen.
//   node scripts/baseball-play.mjs <outDir> [world] [cpu skill] [pitches]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2] || '/tmp/kaleydo-baseball';
const world = process.argv[3] || 'park';
const skill = +(process.argv[4] ?? 0.9);
const pitches = +(process.argv[5] ?? 5);
fs.mkdirSync(out, { recursive: true });
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
await tv.evaluate(([w, s, n]) => window.flow.beginBaseball({ world: w, cpu: s, pitching: 0.55, pitches: n }), [world, skill, pitches]);
// the scripted batter: swings (inside the page, so the timing is exact) a little
// either side of perfect, and logs what happened
await tv.evaluate(() => {
  const k = window.kaleido;
  window.__swings = [];
  let armed = null;
  const loop = () => {
    const g = k.baseball;
    if (g && g.state === 'pitch' && g.pitch && g.hitters[g.current].cpu === null) {
      if (armed !== g.pitch) {
        armed = g.pitch;
        // aim for a timing error in about ±50 ms (0.04 s is the display lag the game allows for)
        armed.__at = g.pitch.tc + 0.04 + (Math.random() - 0.5) * 0.1;
        armed.__done = false;
      }
      if (!armed.__done && g.t >= armed.__at) {
        armed.__done = true;
        const power = 0.55 + Math.random() * 0.45;
        k.baseball.swing(g.hitters[g.current].slot, { power, lift: 0.3, age: 0 });
        window.__swings.push({ t: g.t, tc: g.pitch.tc, power });
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const shot = (name) => tv.screenshot({ path: `${out}/hr-${world}-${name}.png` });
await tv.waitForTimeout(1300);
await shot('intro');
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const st = await tv.evaluate(() => {
    const g = window.kaleido.baseball;
    if (!g) return { state: 'none' };
    const r = window.kaleido.hrReplay;
    return { state: g.state, who: g.current, n: g.pitchNo, hr: g.hit ? { home: g.hit.homeRun, foul: g.hit.foul, hang: g.hit.hang, tau: g.t - g.hitT } : null, results: !!document.querySelector('.results'), replay: r ? r.time - r.contact : null };
  });
  if (st.results || st.state === 'none') break;
  const tag = `${st.who}-${st.n}`;
  if (st.replay !== null && st.replay > -0.12 && !seen.has('replayA' + tag)) {
    seen.add('replayA' + tag);
    await shot(`replay-h${st.who}-p${st.n}-a`);
  }
  if (st.replay !== null && st.replay > 0 && !seen.has('replayB' + tag)) {
    seen.add('replayB' + tag);
    await shot(`replay-h${st.who}-p${st.n}-b`);
  }
  if (st.replay !== null && st.replay > 0.25 && !seen.has('replayC' + tag)) {
    seen.add('replayC' + tag);
    await shot(`replay-h${st.who}-p${st.n}-c`);
  }
  if (st.state === 'pitch' && !seen.has('pitch' + tag) && seen.size < 40) {
    seen.add('pitch' + tag);
    if (st.n === 0) await shot(`pitch-h${st.who}`);
  }
  if (st.state === 'flight' && st.hr && !st.hr.foul) {
    if (st.hr.tau > 0.5 && !seen.has('chase' + tag)) {
      seen.add('chase' + tag);
      await shot(`chase-h${st.who}-p${st.n}`);
    }
    if (st.hr.home && st.hr.tau > st.hr.hang - 0.2 && !seen.has('stands' + tag)) {
      seen.add('stands' + tag);
      await shot(`stands-h${st.who}-p${st.n}`);
    }
    if (st.hr.home && st.hr.tau > st.hr.hang + 1.8 && !seen.has('hero' + tag)) {
      seen.add('hero' + tag);
      await shot(`hero-h${st.who}-p${st.n}`);
    }
  }
  if (st.state === 'switch' && !seen.has('switch' + st.who)) {
    seen.add('switch' + st.who);
    await tv.waitForTimeout(700);
    await shot(`switch-h${st.who}`);
  }
  await tv.waitForTimeout(60);
}
await tv.waitForFunction(() => document.querySelector('.results'), null, { timeout: 30000, polling: 250 }).catch(() => logs.push('no results screen'));
await tv.waitForTimeout(800);
await shot('results');
const summary = await tv.evaluate(() => {
  const g = window.kaleido.baseball;
  return g ? g.hitters.map((h, i) => `${h.name}: ${g.homeRuns(i)} HR · ${g.log[i].map((o) => (o.outcome === 'homerun' ? `HR${Math.round(o.distance)}` : o.outcome === 'hit' ? `h${Math.round(o.distance)}` : o.outcome[0])).join(' ')}`).join('\n') : 'no game';
});
console.log(summary);
console.log(logs.join('\n') || 'no errors');
await browser.close();
