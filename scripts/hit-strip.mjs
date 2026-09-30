// A frame strip around one late-arriving swing: the Swing Lab with the frame loop stepped by hand (every frame
// 1/60 s), a swing made on the beat (at the plan's contact time) that reaches the match AGE ms later, and
// a screenshot of every frame around its arrival (BEFORE before, AFTER after) cropped around the player. The frames are
// saved as PNGs and as one contact sheet; the drawn ball's distance to the plan's ball point is printed per frame.
// With the swing ONSET on (a build that has it; ONSET=0 leaves it out): the phone's swing-start, made LEAD ms before the swing's peak, is
// delayed by the same AGE, so it reaches the match LEAD ms sooner than the swing: the character's stroke starts on it.
//   BASE=http://localhost:3400 AGE=80 node scripts/hit-strip.mjs <outDir> [tag=after]
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3400';
const AGE = +(process.env.AGE || 80);
const OUT = process.argv[2];
const TAG = process.argv[3] || 'after';
const BEFORE = +(process.env.BEFORE || 6);
const AFTER = +(process.env.AFTER || 6);
// the swing-start is made LEAD ms before the swing's peak (the phone's detector: ~100 ms on a normal swing)
const LEAD = +(process.env.LEAD || 100);
const ONSET = process.env.ONSET !== '0';
// BEAT: ms the swing is made before (-) or after (+) the plan's contact time (a perfect one, |tau| < .16, freezes the frame a moment)
const BEAT = +(process.env.BEAT || 0);
const W = +(process.env.CROPW || 560);
const H = +(process.env.CROPH || 340);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForTimeout(1500);
await tv.evaluate(() => window.flow.beginSwingLab());
await tv.waitForTimeout(2500);
// take over the frame loop: from here on a frame is a call to __step()
await tv.evaluate(() => {
  window.requestAnimationFrame = (cb) => { window.__tick = cb; return 1; };
});
await tv.waitForTimeout(300);
await tv.evaluate(([age, beat, lead, onset]) => {
  const k = window.kaleido;
  const m = k.match;
  const human = m.players.find((q) => q.human);
  const tmp = { x: 0, y: 0, z: 0 };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const S = (window.__S = { phase: 'wait', tS: 0, arrived: -1, plan: null, n: 0 });
  let ts = performance.now();
  // a session's swings have taught the match how old they are (its hold follows the median; none before the hold existed)
  if (m.swingAges) for (let i = 0; i < 8; i++) m.swingAges.push(age / 1000);
  window.__step = () => {
    ts += 1000 / 60;
    window.__tick(ts);
    const p = human.plan;
    if (S.phase === 'wait' && p && m.state === 'play' && p.t - m.t > 0.2 && p.t - m.t < 0.3) {
      S.phase = 'run';
      S.tS = p.t + beat / 1000; // the swing is made on the beat (or BEAT ms off it)
      S.plan = { x: p.bx, y: p.by, z: p.bz, stroke: p.stroke };
      S.x = human.x;
      S.z = human.z;
      const pr = k.rig.project({ x: human.x, y: 1.2, z: human.z });
      S.cx = pr.x;
      S.cy = pr.y;
    }
    if (S.phase !== 'run') return { phase: S.phase };
    const b = m.ballView(m.t, tmp);
    const tr = m.ballAt(m.t, { x: 0, y: 0, z: 0 });
    const row = { n: S.n++, dt: Math.round((m.t - S.tS) * 1000), x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2), tz: +tr.z.toFixed(2), dPlan: +dist(b, S.plan).toFixed(2), arrive: false, cx: S.cx, cy: S.cy };
    // the swing's onset reaches the match (made `lead` before the peak, as old as the swing when it gets here)
    if (onset && k.input.onSwingStart && S.started === undefined && m.t >= S.tS - lead / 1000 + age / 1000) {
      S.started = row.n;
      row.start = true;
      k.input.onSwingStart(human.slot, undefined, m.t - (S.tS - lead / 1000));
    }
    if (S.arrived < 0 && m.t >= S.tS + age / 1000) {
      // (how far into its wind-up the stroke is, as the frame before it is drawn: 0 with none going, 1 at contact)
      const w0 = human.swing;
      row.phase = w0 ? +((m.t - w0.t0) / Math.max(1e-3, w0.tc - w0.t0)).toFixed(2) : 0;
      S.arrived = row.n;
      row.arrive = true;
      // the message reaches the match now: a swing made `age` ago, on the beat
      k.swing({ slot: human.slot, power: 0.8, spin: 0.2, age: m.t - S.tS, source: 'pad', side: S.plan.stroke === 'bh' ? 'bh' : 'fh' });
    }
    const sw = human.swing;
    row.sw = sw ? `${sw.provisional ? (sw.feint ? 'feint' : 'prov') : sw.hit ? 'hit' : 'miss'} t0 ${Math.round((sw.t0 - S.tS) * 1000)} tc ${Math.round((sw.tc - S.tS) * 1000)}` : '';
    return { phase: 'run', row, arrived: S.arrived };
  };
}, [AGE, BEAT, LEAD, ONSET]);
const shots = [];
let arrivedN = -1;
for (let f = 0; f < 3000; f++) {
  const r = await tv.evaluate(() => window.__step());
  if (r.phase !== 'run') continue;
  const row = r.row;
  if (r.arrived >= 0 && arrivedN < 0) arrivedN = r.arrived;
  // (a crop around the player, fixed for the strip)
  const cx = Math.round(row.cx * 1280 - W / 2), cy = Math.round(row.cy * 720 - H * 0.55);
  const clip = { x: Math.max(0, Math.min(1280 - W, cx)), y: Math.max(0, Math.min(720 - H, cy)), width: W, height: H };
  const buf = await tv.screenshot({ clip });
  shots.push({ row, buf });
  if (arrivedN >= 0 && row.n >= arrivedN + AFTER) break;
}
const lo = Math.max(0, arrivedN - BEFORE);
const sel = shots.filter((s) => s.row.n >= lo && s.row.n <= arrivedN + AFTER - 1);
console.log(`${TAG}: swing age ${AGE} ms, arrives at frame ${arrivedN}; frames ${sel[0]?.row.n}..${sel.at(-1)?.row.n}`);
console.log(`(d) stroke phase when the swing arrives (fraction of the wind-up done: 0 none going, 1 at contact): ${shots.find((x) => x.row.arrive)?.row.phase}`);
console.log('frame  ms after the beat   drawn ball (x,y,z)      true z   dist to plan point   swing');
for (const s of sel) {
  const r = s.row;
  console.log(`${String(r.n - arrivedN).padStart(4)}   ${String(r.dt).padStart(5)}   ${r.x.toFixed(2).padStart(6)} ${r.y.toFixed(2).padStart(5)} ${r.z.toFixed(2).padStart(6)}   ${r.tz.toFixed(2).padStart(6)}   ${r.dPlan.toFixed(2).padStart(5)} m   ${r.start ? '<- onset heard   ' : ''}${r.arrive ? '<- swing heard   ' : ''}${r.sw}`);
  fs.writeFileSync(`${OUT}/${TAG}-f${String(r.n - arrivedN).replace('-', 'm')}.png`, s.buf);
}
// the contact sheet: 4 columns, frames in order, each labelled with its offset from the arrival
const cols = 4, rowsN = Math.ceil(sel.length / cols);
const tw = W, th = H;
const comps = [];
for (let i = 0; i < sel.length; i++) {
  const r = sel[i].row;
  const label = `${r.n - arrivedN >= 0 ? '+' : ''}${r.n - arrivedN}  ${r.dt} ms  ball ${r.dPlan.toFixed(2)} m from plan${r.start ? '  ONSET' : ''}${r.arrive ? '  SWING HEARD' : ''}`;
  comps.push({ input: sel[i].buf, left: (i % cols) * tw, top: Math.floor(i / cols) * th });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="24"><rect width="${tw}" height="24" fill="rgba(0,0,0,0.6)"/><text x="6" y="17" font-family="monospace" font-size="14" fill="${r.arrive ? '#ffd25e' : '#fff'}">${label}</text></svg>`;
  comps.push({ input: Buffer.from(svg), left: (i % cols) * tw, top: Math.floor(i / cols) * th });
}
await sharp({ create: { width: cols * tw, height: rowsN * th, channels: 3, background: '#000' } }).composite(comps).png().toFile(`${OUT}/${TAG}-strip.png`);
console.log(`sheet: ${OUT}/${TAG}-strip.png`);
console.log(logs.join('\n') || 'no page errors');
await browser.close();
