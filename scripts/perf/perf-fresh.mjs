// Debug aid: when do materials first show up in the scene (the compile watch's `freshObjs`),
// and when does a shader program get built after? Shows which one got past the watch.
//   node scripts/perf/perf-fresh.mjs [world] [sport] [seconds]
import { launchChrome } from '../lib/chrome.mjs';
import { programProbe } from '../lib/perf-probe.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const world = process.argv[2] || 'park';
const sport = process.argv[3] || 'duel';
const secs = +(process.argv[4] || 40);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
if (sport === 'duel-real') {
  // a real duel against an Ace CPU, guarding and striking back (as perf-duel.mjs); rematches follow
  await tv.mouse.click(640, 370);
  await tv.evaluate((w) => window.flow.beginDuel(w, 0.9), world);
  await tv.waitForFunction(() => window.kaleido.duel && window.kaleido.duel.state !== 'intro', null, { timeout: 30000 });
  await tv.evaluate((w) => {
    const k = window.kaleido;
    let guarding = false;
    setInterval(() => {
      const g = k.duel;
      if (!g) return;
      if (g.state === 'over') {
        if (!k.__again) k.__again = setTimeout(() => ((k.__again = 0), window.flow.beginDuel(w, 0.9)), 3500);
        return;
      }
      const me = g.fighters[0], cpu = g.fighters[1];
      const threat = cpu.phase === 'windup' || cpu.phase === 'slash' || cpu.phase === 'thrust';
      if (threat !== guarding) { guarding = threat; k.input.localGuardAngle = null; k.input.onGuard(0, threat); }
      if (!guarding && me.phase === 'ready' && (cpu.phase === 'stunned' || Math.random() < 0.05)) k.duelKeySlash(0, { kind: 'slash', dir: Math.random() < 0.5 ? 0 : -Math.PI / 2, power: 0.85 });
    }, 50);
  }, world);
} else {
  await tv.evaluate(([w, s]) => { window.kaleido.startAttract(w, s); if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12; }, [world, sport]);
}
await tv.waitForTimeout(3000);
await tv.evaluate(programProbe);
const log = await tv.evaluate(([secs, process_full]) => new Promise((done) => {
  const k = window.kaleido;
  const out = [];
  // (a rematch builds a new world's worth of gear: follow whichever world is current)
  let w = k.stage.current;
  const t0 = performance.now();
  const stamp = () => ((performance.now() - t0) / 1000).toFixed(1);
  const tidy = w.tidyMaterials.bind(w);
  w.tidyMaterials = () => {
    tidy();
    if (w.freshObjs.length) out.push(`t=${stamp()}s fresh: ${w.freshObjs.map((o) => o.name || o.type).join(',')}`);
  };
  const app = k;
  const bd = window.flow.beginDuel.bind(window.flow);
  window.flow.beginDuel = (...a) => { out.push(`t=${stamp()}s beginDuel (rematch)`); return bd(...a); };
  const n0 = () => window.__newProgs.length;
  let seen = 0;
  const f = k.frame.bind(k);
  k.frame = (now) => {
    f(now);
    if (window.__newProgs.length > seen) {
      for (const p of window.__newProgs.slice(seen)) out.push(`t=${stamp()}s PROGRAM ${process_full ? p.who : p.who.slice(0, 60)}`);
      seen = window.__newProgs.length;
    }
  };
  setTimeout(() => { k.frame = f; done(out); }, secs * 1000);
}), [secs, !!process.env.FULL]);
console.log(log.join('\n') || '(nothing fresh, nothing built)');
if (process.env.FULL) console.log('trail-like programs now:\n  ' + (await tv.evaluate(() => window.kaleido.renderer.info.programs.filter((p) => /8390657|8391681/.test(p.cacheKey)).map((p) => p.cacheKey.slice(-100)))).join('\n  '));
await browser.close();
