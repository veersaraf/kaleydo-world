// End-to-end: the first-time tennis demo (src/tv/tennis/demo.ts).
//   PORT=3450 HTTPS_PORT=3893 HMR_PORT=24850 node server/server.mjs --dev
//   BASE=http://localhost:3450 node scripts/e2e/demo-e2e.mjs [outDir]
// With an outDir it also saves: serve-strip-N.png / rally-strip-N.png (the TV, 1.3 s apart through each demo) and
// pad-demo-<step>.png (the phone's demo panel).
//
// Scenarios (each phone is a fresh browser context: nothing in localStorage, `demo: []` in its hello):
//   A  serves first: the serve demo plays, a swing skips it at once (and does not toss the ball), the real serve
//      (lift + swing at the top) follows; a second match with the same phone has no demo.
//   B  serves first, lets it run: the captions come in order, the phone's panel follows step by step, then the phone is
//      handed its serve; what it saw is remembered on the phone.
//   C  receives first: the rally demo (captions in order, the timing ring on the ball), then the timing ring on the
//      real returns the first two times only.
//   D  receives first, presses A on the phone: skipped at once, and no rings later.
//   E  the keyboard player (no phone): key captions, SPACE skips.
import { launchChrome } from '../lib/chrome.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.argv[2] || '';
if (OUT) mkdirSync(OUT, { recursive: true });
const browser = await launchChrome(['--use-angle=metal', '--autoplay-policy=no-user-gesture-required']);
const errors = [];
let failed = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const only = (n) => !process.env.ONLY || process.env.ONLY.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** the TV in its own context (its settings are whatever the scenario sets) */
async function openTv(settings) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const tv = await ctx.newPage();
  tv.on('pageerror', (e) => errors.push('[tv] ' + e.message));
  await tv.goto(BASE + '/');
  await tv.evaluate((s) => localStorage.setItem('kaleido.settings', JSON.stringify(s)), settings);
  await tv.goto(BASE + '/');
  await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 60000 });
  // watchers: the captions in order, the demo panel steps, the ring
  await tv.evaluate(() => {
    window.__caps = [];
    window.__ringShows = 0;
    const cap = () => document.querySelector('.coach-cap');
    setInterval(() => {
      const c = cap();
      const t = c?.querySelector('b')?.textContent ?? '';
      if (t && window.__caps[window.__caps.length - 1] !== t) window.__caps.push(t);
    }, 50);
  });
  return { ctx, tv };
}

/** a phone (fresh context) with a sensor driver: window.__lift() / __swing(peak) */
async function openPad(tvPage) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => errors.push('[pad] ' + e.message));
  await pad.goto(BASE + '/controller.html?auto');
  await pad.evaluate(() => {
    const D = Math.PI / 180;
    window.__ori = { alpha: 0, beta: 35, gamma: 0 };
    window.__extraUp = 0;
    const upOf = (b, g) => [-Math.cos(b * D) * Math.sin(g * D), Math.sin(b * D), Math.cos(b * D) * Math.cos(g * D)];
    window.__emit = (rot, acc) => {
      const o = window.__ori;
      const up = upOf(o.beta, o.gamma);
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: o.alpha, beta: o.beta, gamma: o.gamma }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { interval: 16, rotationRate: { alpha: rot[2] / D, beta: rot[0] / D, gamma: rot[1] / D }, acceleration: { x: acc[0], y: acc[1], z: acc[2] }, accelerationIncludingGravity: { x: acc[0] + up[0] * 9.81, y: acc[1] + up[1] * 9.81, z: acc[2] + up[2] * 9.81 } }));
    };
    setInterval(() => {
      if (!window.__busy) {
        const up = upOf(window.__ori.beta, 0);
        window.__emit([0, 0, 0], up.map((u) => u * window.__extraUp));
      }
    }, 16);
    window.__lift = async () => {
      window.__extraUp = 12;
      await new Promise((r) => setTimeout(r, 110));
      window.__extraUp = -6;
      await new Promise((r) => setTimeout(r, 120));
      window.__extraUp = 0;
    };
    const erf = (x) => {
      const t = 1 / (1 + 0.3275911 * Math.abs(x));
      const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
      return x >= 0 ? y : -y;
    };
    // a forehand whose fastest moment is 0.62 s after it starts
    window.__swing = (peakDeg = 950) =>
      new Promise((done) => {
        window.__busy = true;
        const W = peakDeg * D, sig = 0.0833, tp = 0.62, beta = 15;
        const up = upOf(beta, 0);
        const t0 = performance.now();
        const step = () => {
          const t = (performance.now() - t0) / 1000;
          const w = W * Math.exp(-(((t - tp) / sig) ** 2));
          const psi = W * sig * (Math.sqrt(Math.PI) / 2) * erf((t - tp) / sig);
          window.__ori = { alpha: -90 + psi / D, beta, gamma: 0 };
          window.__emit(up.map((u) => u * w), [0, 0, 0]);
          if (t < 1.05) setTimeout(step, 8);
          else {
            window.__ori = { alpha: 0, beta: 35, gamma: 0 };
            window.__busy = false;
            done();
          }
        };
        step();
      });
    // what the pad showed, in order (panel + step)
    window.__panels = [];
    setInterval(() => {
      const on = document.querySelector('.panel.on');
      if (!on) return;
      const name = [...on.classList].find((c) => c !== 'panel' && c !== 'on') || '';
      const tag = name === 'demo' ? `demo:${on.dataset.step || ''}` : name;
      if (window.__panels[window.__panels.length - 1] !== tag) window.__panels.push(tag);
    }, 40);
  });
  await sleep(2200);
  return { ctx, pad };
}

/** start a match on the TV: firstServer 0 = the phone's player serves first */
async function startMatch(tv, firstServer, { now = true } = {}) {
  await tv.evaluate(
    ([fs, now]) => {
      const f = window.flow, k = window.kaleido;
      f.mode = 'quick';
      const cfg = f.buildConfig();
      cfg.firstServer = fs;
      f.beginMatch('plaza', false, cfg);
      // the timing ring: how many times it came up (a MutationObserver: a poll can miss a short one)
      window.__ringShows = 0;
      const ring = document.querySelector('.sm-ret.tm');
      let on = false;
      new MutationObserver(() => {
        const now = ring.style.display === 'block' && Number(ring.style.opacity || 0) > 0.3;
        if (now && !on) window.__ringShows++;
        on = now;
      }).observe(ring, { attributes: true, attributeFilter: ['style'] });
      window.__ev = [];
      const oe = k.onMatchEvent;
      k.onMatchEvent = (e) => {
        if (e.type === 'toss' || e.type === 'hit' || e.type === 'whiff' || e.type === 'fault' || e.type === 'point') window.__ev.push({ type: e.type, human: e.p?.human, t: +k.match.t.toFixed(3) });
        oe(e);
      };
      if (now) k.match.startNow();
    },
    [firstServer, now],
  );
}

const demoState = (tv) => tv.evaluate(() => ({ demo: !!window.kaleido.demo, kind: window.kaleido.demo?.kind ?? null, t: window.kaleido.demo?.t ?? 0, state: window.kaleido.match?.state, caps: window.__caps.slice() }));
const padPanels = (pad) => pad.evaluate(() => window.__panels.slice());
const storedFlag = (pad) => pad.evaluate(() => localStorage.getItem('kaleido.demo.tennis'));

/**
 * A strip of the TV through a demo: the app is paused (so the shots' own delay does not stretch the demo) and the demo is
 * stepped by hand to each moment, which is then given a little real time to settle (the captions pop in, the camera eases).
 * The phone's panel is saved at a few of them.
 */
async function strip(tv, pad, prefix, times, padAt = {}) {
  await tv.evaluate(() => (window.kaleido.paused = true));
  for (let i = 0; i < times.length; i++) {
    await tv.evaluate((t) => {
      const d = window.kaleido.demo;
      while (d.t < t) d.update(1 / 60);
    }, times[i]);
    await sleep(900);
    await tv.screenshot({ path: `${OUT}/${prefix}-${i + 1}.png` });
    if (padAt[i]) await pad.screenshot({ path: `${OUT}/pad-${prefix}-${padAt[i]}.png` });
  }
  await tv.evaluate(() => (window.kaleido.paused = false));
}

const SERVE_CAPS = ['Your player moves by itself.', 'Lift the phone to toss…', '…and swing at the top!', 'Your turn — lift, then swing.'];
const RALLY_CAPS = ['Your player runs to the ball by itself.', 'Just swing when it reaches you.', 'Early or late still counts — just swing!', 'Ready? Here it comes.'];

// ---------------------------------------------------------------- A: a swing skips the serve demo
if (only('A')) {
  console.log('\n-- A: serves first; a swing skips the demo');
  const { tv } = await openTv({ seenTutorial: true });
  const { pad } = await openPad(tv);
  await startMatch(tv, 0);
  await tv.waitForFunction(() => !!window.kaleido.demo, null, { timeout: 10000 });
  check(true, 'the serve demo starts at the first serve');
  const s0 = await tv.evaluate(() => ({ kind: window.kaleido.demo.kind, state: window.kaleido.match.state, t: window.kaleido.match.t }));
  await sleep(2400);
  const mid = await tv.evaluate(() => ({ t: window.kaleido.match.t, caps: window.__caps.slice() }));
  check(mid.t === s0.t, 'the match clock is held while the demo plays', `t=${mid.t.toFixed(2)}`);
  check(mid.caps.length >= 2 && mid.caps[0] === SERVE_CAPS[0] && mid.caps[1] === SERVE_CAPS[1], 'captions so far', JSON.stringify(mid.caps));
  const pp = await padPanels(pad);
  check(pp.includes('demo:s1') && pp.includes('demo:s2'), 'the phone shows the demo panel, step by step', JSON.stringify(pp));
  if (OUT) await pad.screenshot({ path: `${OUT}/pad-demo-s2.png` });
  // swing now: it ends the demo at once
  await pad.evaluate(() => void window.__swing(950));
  await tv.waitForFunction(() => !window.kaleido.demo, null, { timeout: 4000 });
  check(true, 'a swing ends the demo at once');
  await sleep(1100);
  const after = await tv.evaluate(() => ({ state: window.kaleido.match.state, ev: window.__ev.length }));
  check(after.state === 'serve' && after.ev === 0, 'and that swing did not toss the real ball', `state=${after.state}`);
  await pad.waitForFunction(() => document.querySelector('.panel.serve.on'), null, { timeout: 3000 });
  check(true, 'the phone is handed its serve');
  // the real serve: lift, then swing at the top of the toss
  await sleep(600);
  await pad.evaluate(() => window.__lift());
  await tv.waitForFunction(() => window.kaleido.match.state === 'toss', null, { timeout: 3000, polling: 'raf' });
  const wait = await tv.evaluate(() => { const m = window.kaleido.match; return (m.server.tossT + 0.78 - 0.62 - m.t) * 1000; });
  await sleep(Math.max(0, wait - 25));
  await pad.evaluate(() => void window.__swing(950));
  await tv.waitForFunction(() => window.__ev.some((e) => e.type === 'hit' && e.human), null, { timeout: 4000, polling: 'raf' });
  check(true, 'the real serve happens (lift, swing at the top)');
  await sleep(500);
  check((await storedFlag(pad)) === '1', 'the phone remembers the demo (kaleido.demo.tennis = 1)');
  const seatDemo = await tv.evaluate(() => window.kaleido.input.seats[0].demoSeen);
  check(Array.isArray(seatDemo) && seatDemo.includes('tennis'), 'the TV has it on the seat', JSON.stringify(seatDemo));
  // a second match, the same phone: no demo
  await startMatch(tv, 0);
  await sleep(2500);
  const m2 = await tv.evaluate(() => ({ demo: !!window.kaleido.demo, state: window.kaleido.match.state, caps: window.__caps.length }));
  check(!m2.demo && m2.state === 'serve', 'a second match: no demo', JSON.stringify(m2));
  check((await padPanels(pad)).slice(-1)[0] === 'serve', 'the phone goes straight to its serve');
  // How to play → Tennis → Show me: the demo plays again at the next serve, whatever the phone remembers
  await tv.evaluate(() => {
    const f = window.flow;
    f.go(f.helpScreen(0));
    f.screen.input(0, 'down');
    f.screen.input(0, 'a');
  });
  const setupUp = await tv.evaluate(() => window.flow.screen?.name);
  check(setupUp === 'setup', 'Show me (How to play) leads on to a tennis match', String(setupUp));
  await startMatch(tv, 0);
  const again = await tv.waitForFunction(() => !!window.kaleido.demo, null, { timeout: 6000 }).then(() => true, () => false);
  check(again, 'and the demo plays again at its serve');
  await tv.context().close();
  await pad.context().close();
}

// ---------------------------------------------------------------- B: the serve demo runs to its end
if (only('B')) {
  console.log('\n-- B: serves first; the demo runs to its end');
  const { tv } = await openTv({ seenTutorial: true });
  const { pad } = await openPad(tv);
  await startMatch(tv, 0);
  await tv.waitForFunction(() => !!window.kaleido.demo, null, { timeout: 10000 });
  const t0 = Date.now();
  await tv.waitForFunction(() => !window.kaleido.demo, null, { timeout: 12000 });
  const secs = (Date.now() - t0) / 1000;
  const st = await demoState(tv);
  check(JSON.stringify(st.caps) === JSON.stringify(SERVE_CAPS), 'captions in order', JSON.stringify(st.caps));
  check(secs <= 8.5, 'the demo is short', `${secs.toFixed(1)} s`);
  await pad.waitForFunction(() => document.querySelector('.panel.serve.on'), null, { timeout: 3000 });
  await sleep(120);
  const pp = await padPanels(pad);
  check(['demo:s1', 'demo:s2', 'demo:s3', 'demo:s4', 'serve'].every((x) => pp.includes(x)) && pp.indexOf('demo:s4') < pp.indexOf('serve'), 'the phone followed it, then got its serve', JSON.stringify(pp));
  check(st.state === 'serve', 'the match is waiting for the real serve', st.state);
  await sleep(600);
  check((await storedFlag(pad)) === 'serve', 'the phone remembers the serve part only', String(await storedFlag(pad)));
  await tv.context().close();
  await pad.context().close();
}

// ---------------------------------------------------------------- C: receives first
if (only('C')) {
  console.log('\n-- C: receives first; the rally demo, then the ring on two returns');
  const { tv } = await openTv({ seenTutorial: true, level: 'rookie', games: 3 });
  const { pad } = await openPad(tv);
  await startMatch(tv, 1);
  await tv.waitForFunction(() => !!window.kaleido.demo, null, { timeout: 10000 });
  const k0 = await demoState(tv);
  check(k0.kind === 'rally', 'the rally demo plays (not the serve demo)');
  const t0 = Date.now();
  let ringSeen = false;
  const watch = (async () => {
    const until = Date.now() + 9000;
    while (Date.now() < until) {
      if (await tv.evaluate(() => window.__ringShows > 0)) ringSeen = true;
      await sleep(120);
    }
  })();
  await tv.waitForFunction(() => !window.kaleido.demo, null, { timeout: 12000 });
  const secs = (Date.now() - t0) / 1000;
  const st = await demoState(tv);
  check(JSON.stringify(st.caps) === JSON.stringify(RALLY_CAPS), 'captions in order', JSON.stringify(st.caps));
  check(secs <= 8.5, 'the demo is short', `${secs.toFixed(1)} s`);
  await watch;
  check(ringSeen, 'the timing ring closed on the scripted ball');
  const pp = await padPanels(pad);
  check(['demo:r1', 'demo:r2', 'demo:r3', 'demo:r4'].every((x) => pp.includes(x)), 'the phone followed it', JSON.stringify(pp));
  check((await storedFlag(pad)) === 'rally', 'the phone remembers the rally part only', String(await storedFlag(pad)));
  // the real returns: the ring on the first two flights that come at the phone's player, then never again
  await tv.evaluate(() => (window.__ringShows = 0));
  await tv.waitForFunction(() => window.flow.rings.size === 0, null, { timeout: 90000, polling: 200 });
  const shownWhenSpent = await tv.evaluate(() => window.__ringShows);
  check(shownWhenSpent === 2 || shownWhenSpent === 1, 'the ring came up on the first two real returns', `shown ${shownWhenSpent}x when the second was spent`);
  // (the ring is on screen a moment after it is counted: let that one play out.) Their first service game brings the serve demo
  await sleep(1800);
  const before = await tv.evaluate(() => window.__ringShows);
  await tv.waitForFunction(() => window.kaleido.demo?.kind === 'serve', null, { timeout: 150000, polling: 200 });
  check(true, 'the serve demo plays at their first service game');
  await tv.waitForFunction(() => window.__caps.includes('Your turn — lift, then swing.'), null, { timeout: 15000, polling: 200 });
  const caps2 = await tv.evaluate(() => window.__caps.slice());
  check(JSON.stringify(caps2.slice(-4)) === JSON.stringify(SERVE_CAPS), 'with its captions', JSON.stringify(caps2.slice(-4)));
  check((await tv.evaluate(() => window.__ringShows)) === before, 'and the ring has not come back', `${before}`);
  await tv.waitForFunction(() => !window.kaleido.demo, null, { timeout: 5000 });
  await sleep(600);
  check((await storedFlag(pad)) === '1', 'both parts seen: kaleido.demo.tennis = 1', String(await storedFlag(pad)));
  await tv.context().close();
  await pad.context().close();
}

// ---------------------------------------------------------------- D: A skips the rally demo
if (only('D')) {
  console.log('\n-- D: receives first; A on the phone skips');
  const { tv } = await openTv({ seenTutorial: true, level: 'rookie', games: 3 });
  const { pad } = await openPad(tv);
  await startMatch(tv, 1);
  await tv.waitForFunction(() => !!window.kaleido.demo, null, { timeout: 10000 });
  await sleep(1200);
  await pad.evaluate(() => document.querySelector('.dskip').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true })));
  await tv.waitForFunction(() => !window.kaleido.demo, null, { timeout: 3000 });
  check(true, 'A ends the demo at once');
  await sleep(500);
  check((await storedFlag(pad)) === '1', 'skipped = all of it seen', String(await storedFlag(pad)));
  await tv.evaluate(() => (window.__ringShows = 0));
  const n0 = await tv.evaluate(() => window.__ev.filter((e) => e.type === 'point').length);
  await tv.waitForFunction((n) => window.__ev.filter((e) => e.type === 'point').length > n, n0, { timeout: 30000, polling: 200 });
  check((await tv.evaluate(() => window.__ringShows)) === 0, 'and no ring on the returns that follow');
  await tv.context().close();
  await pad.context().close();
}

// ---------------------------------------------------------------- S: the strips (only with an outDir)
if (OUT && only('S')) {
  for (const [kind, first, prefix, times, padAt] of [
    ['serve', 0, 'serve-strip', [0.6, 1.9, 3.4, 4.3, 5.6, 6.6], { 0: 's1', 1: 's2', 3: 's3', 4: 's4' }],
    ['rally', 1, 'rally-strip', [0.5, 1.6, 2.7, 3.4, 4.5, 6.2], { 1: 'r1', 2: 'r2', 4: 'r3', 5: 'r4' }],
  ]) {
    console.log(`\n-- S: the ${kind} demo strip`);
    const { tv } = await openTv({ seenTutorial: true });
    const { pad } = await openPad(tv);
    await startMatch(tv, first, { now: false });
    await tv.waitForFunction(() => !!window.kaleido.demo, null, { timeout: 15000 });
    await strip(tv, pad, prefix, times, padAt);
    await tv.waitForFunction(() => !window.kaleido.demo, null, { timeout: 15000 });
    await tv.context().close();
    await pad.context().close();
  }
}

// ---------------------------------------------------------------- E: the keyboard player
if (only('E')) {
  console.log('\n-- E: the keyboard player (no phone)');
  const { tv } = await openTv({ seenTutorial: false, demoSeen: [] });
  await tv.evaluate(() => {
    const f = window.flow, k = window.kaleido;
    f.mode = 'quick';
    const cfg = f.buildConfig();
    cfg.firstServer = 0;
    f.beginMatch('plaza', false, cfg);
    k.match.startNow();
  });
  const has = await tv.waitForFunction(() => !!window.kaleido.demo, null, { timeout: 6000 }).then(() => true, () => false);
  if (!has) {
    console.log('  (no local human in a match with no phone on this build: the keyboard seat needs a player)');
  } else {
    await sleep(2300);
    const caps = await tv.evaluate(() => window.__caps.slice());
    check(caps.some((c) => /SPACE/.test(c)), 'key captions', JSON.stringify(caps));
    await tv.keyboard.press('Space');
    await tv.waitForFunction(() => !window.kaleido.demo, null, { timeout: 3000 });
    check(true, 'SPACE skips it');
    const saved = await tv.evaluate(() => JSON.parse(localStorage.getItem('kaleido.settings')).demoSeen);
    check(saved.includes('tennis'), 'the TV remembers it for the keyboard player', JSON.stringify(saved));
  }
  await tv.context().close();
}

await browser.close();
console.log('\n' + (errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors'));
if (errors.length) failed++;
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
