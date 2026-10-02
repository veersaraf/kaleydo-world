// A realistic session: one player vs CPU for N seconds (auto-swings), with points,
// callouts and instant replays. Reports frame gaps over the whole session.
import { launchChrome } from '../lib/chrome.mjs';
import { programProbe, programReport } from '../lib/perf-probe.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'plaza';
const secs = +(process.argv[3] || 40);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 6, mouse: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370); // unlock audio like a real player
await tv.waitForTimeout(300);
await tv.evaluate(([w, mode]) => { const f = window.flow; f.mode = mode; f.beginMatch(w); }, [world, process.env.MODE || 'quick']);
await tv.evaluate(programProbe);
const res = await tv.evaluate((secs) => new Promise((done) => {
  const k = window.kaleido;
  const rows = [];
  let replays = 0, points = 0, last = 0;
  const orig = k.frame.bind(k);
  const tags = [];
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => { tags.push(e.type); oe(e); };
  const osw = k.stage.onSwap;
  k.stage.onSwap = (w) => { tags.push('swap:' + w.def.id); osw(w); };
  const oq = k.applyQuality.bind(k);
  k.applyQuality = () => { tags.push('quality'); oq(); };
  const osr = k.startReplay.bind(k);
  k.startReplay = (a, b) => { tags.push('replay-start'); return osr(a, b); };
  const osw2 = k.stage.setWorld.bind(k.stage);
  k.stage.setWorld = (id, o) => { tags.push('setWorld:' + id); return osw2(id, o); };
  window.__slow = [];
  const owarm = k.stage.warm.bind(k.stage);
  k.stage.warm = (id, cam) => { window.__slow.push(`warm ${id} at t=${k.match?.t.toFixed(1)} state=${k.match?.state}`); return owarm(id, cam); };
  k.frame = (now) => {
    const a = performance.now();
    tags.length = 0;
    const st0 = k.match?.state;
    orig(now);
    const js = performance.now() - a;
    rows.push([last ? now - last : 0, js, !!k.replay]);
    if (js > 7 || tags.some((t) => t.startsWith('setWorld'))) window.__slow.push(`t=${k.match?.t.toFixed(1)} ${js.toFixed(1)}ms ${st0}->${k.match?.state} ${k.replay ? 'replay ' : ''}${k.stage.transitioning ? 'transition ' : ''}[${tags.join(',')}]`);
    last = now;
  };
  const planned = {};
  const auto = () => {
    const m = k.match;
    if (m && !k.paused) {
      if (m.state === 'intro') m.startNow();
      for (const p of m.players.filter((q) => q.human)) {
        if (m.state === 'serve' && m.server === p && m.t - m.stateT0 > 0.8) k.input.onToss(p.slot);
        if (m.state === 'toss' && m.server === p && !p.swing && m.t >= p.tossT + 0.74) k.input.onSwing({ slot: p.slot, power: 0.85, spin: 0.2, age: 0, source: 'key' });
        if (p.plan && p.plan !== planned[p.id]) planned[p.id] = { plan: p.plan, at: p.plan.t + (Math.random() - 0.5) * 0.1 };
        const pl = planned[p.id];
        if (pl && p.plan === pl.plan && m.t >= pl.at) { k.input.onSwing({ slot: p.slot, power: 0.5 + Math.random() * 0.5, spin: Math.random() - 0.3, age: 0, source: 'key', side: p.plan.stroke === 'bh' ? 'bh' : 'fh' }); planned[p.id] = null; }
      }
      // the results screen / pause: keep playing new matches
      if (m.state === 'over' && window.flow.screen?.name === 'results') window.flow.beginMatch(k.stage.current.def.id, true);
    }
    if (k.replay && !auto.inReplay) { replays++; auto.inReplay = true; }
    if (!k.replay) auto.inReplay = false;
    requestAnimationFrame(auto);
  };
  auto();
  const t0 = performance.now();
  const iv = setInterval(() => {
    if (performance.now() - t0 > secs * 1000) {
      clearInterval(iv);
      k.frame = orig;
      const m = k.match;
      done({ slow: window.__slow, rows, replays, score: m.score.games, pts: m.score.points, level: k.quality.level, pr: k.pr });
    }
  }, 200);
}), secs);
const gaps = res.rows.slice(1).map((r) => r[0]);
const s = [...gaps].sort((a, b) => a - b);
const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
const late = gaps.filter((g) => g > 25);
console.log(`${world}: ${res.rows.length} frames in ${secs}s | gap p50 ${q(0.5)} p99 ${q(0.99)} max ${q(1)} | late(>25ms) ${late.length} [${late.map((g) => g.toFixed(0)).join(',')}] | replays ${res.replays} | games ${res.score} | quality level ${res.level} pr ${res.pr}`);
const js = res.rows.map((r) => r[1]).sort((a, b) => a - b);
console.log(`js p50 ${js[js.length >> 1].toFixed(1)} p99 ${js[Math.floor(js.length * 0.99)].toFixed(1)} max ${js[js.length - 1].toFixed(1)}`);
console.log('slow JS frames:\n  ' + res.slow.join('\n  '));
console.log(logs.join('\n'));
console.log('shader programs built during play:', JSON.stringify(await tv.evaluate(programReport)));
await browser.close();
