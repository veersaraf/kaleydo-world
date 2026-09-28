// End-to-end: a simulated phone plays a real match against a CPU that floats
// moonballs, and must get its smash chances: the pad lights up SMASH!, the
// phone's plain forehand-turn swing (no overhead motion) smashes, and the
// build-up runs in slow motion. Checks and screenshots the pad and the TV.
//   BASE=http://localhost:4700 node scripts/smash-phone-e2e.mjs <outDir>
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { phone } from './lib/fake-phone.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const out = process.argv[2] || 'shots/smash-e2e';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const logs = [];
const tv = await ctx.newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6 })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 60000 });
const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await pctx.addInitScript(phone);
const pad = await pctx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.goto(BASE + '/controller.html?auto');
await pad.waitForTimeout(2500);

await tv.evaluate(() => {
  const k = window.kaleido;
  window.flow.mode = 'quick';
  window.flow.beginMatch('park');
  k.match.startNow();
  const S = (window.__e2e = { chances: 0, smashes: [], hits: 0, minScale: 1, whiffs: [] });
  const onEv = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    onEv(e);
    if (e.type === 'smash-chance') S.chances++;
    if (e.type === 'hit' && e.p.human) {
      S.hits++;
      if (e.kind === 'smash') S.smashes.push({ kph: Math.round(e.kph), perfect: e.perfect, dtMs: e.dtMs });
    }
    if (e.type === 'whiff' && e.p.human && k.smashCue) S.whiffs.push(e.why + ' ' + e.dtMs);
  };
  // the CPU floats moonballs; the serve is keyed (the rally is the phone's)
  const loop = () => {
    const m = k.match;
    if (m) {
      for (const c of m.players) if (!c.human && c.ctrl.ai.lob < 1) c.ctrl.ai = { ...c.ctrl.ai, lob: 1.2 };
      const p = m.players.find((q) => q.human);
      if (m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.6) k.input.onToss(p.slot);
      if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: p.slot, power: 0.9, spin: 0.2, age: 0, source: 'key' });
      S.minScale = Math.min(S.minScale, k.timeScale);
    }
    requestAnimationFrame(loop);
  };
  loop();
});

// the phone swings at every ball (a plain forehand turn), timed to meet it
let padShot = false;
let tvShot = false;
let lastPlan = -1;
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  const info = await tv.evaluate(() => {
    const k = window.kaleido;
    const m = k.match;
    const p = m?.players.find((q) => q.human);
    if (!p || !p.plan || m.state !== 'play') return null;
    // real seconds to contact (bullet time stretches it)
    return { id: p.plan.t, real: (p.plan.t - m.t) / Math.max(0.2, k.timeScale), smash: !!k.smashCue, scale: k.timeScale };
  });
  if (info && info.smash && !padShot && info.real < 0.9) {
    padShot = true;
    await pad.screenshot({ path: `${out}/pad-smash-chance.png` });
    await tv.screenshot({ path: `${out}/tv-smash-chance.png` });
    continue;
  }
  if (info && info.id !== lastPlan && info.real < 0.75) {
    lastPlan = info.id;
    // the swing is read ~at its peak; aim the peak a touch before contact
    void pad.evaluate((ms) => window.__phone.tennis({ inMs: ms }), Math.max(0, info.real * 1000 - 40));
    if (info.smash && !tvShot) {
      tvShot = true;
      setTimeout(() => void pad.screenshot({ path: `${out}/pad-smash-hit.png` }), info.real * 1000 + 250);
    }
  }
  const S = await tv.evaluate(() => window.__e2e);
  if (S.smashes.length >= 3) break;
  await tv.waitForTimeout(20);
}
await tv.waitForTimeout(800);
const S = await tv.evaluate(() => window.__e2e);
console.log(`chances ${S.chances}, human hits ${S.hits}, smashes ${JSON.stringify(S.smashes)}, slowest time scale ${S.minScale.toFixed(2)}, misses on a chance ${JSON.stringify(S.whiffs)}`);
const ok = S.chances > 0 && S.smashes.length > 0 && S.minScale < 0.6;
console.log(ok ? 'OK: the phone got its smash chances and smashed them' : 'FAIL');
console.log(logs.join('\n') || 'no page errors');
await browser.close();
process.exit(ok ? 0 : 1);
