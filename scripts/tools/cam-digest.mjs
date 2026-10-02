// A digest of what a seeded CPU-vs-CPU match puts on screen (camera pose + projection, ball, every pose),
// frame by frame on a virtual clock, with the play camera forced on and the smash / intro cameras
// exercised. Two builds that draw the same give the same digest.
//   node scripts/tools/cam-digest.mjs <BASE> [frames]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.argv[2];
const FRAMES = +(process.argv[3] || 900);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  let a = 12345;
  let u = 999;
  const next = (x) => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return [x, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
  };
  window.__seed = (x) => (a = x);
  Math.random = () => {
    if (new Error().stack.includes('generateUUID')) {
      const [x, v] = next(u);
      u = x;
      return v;
    }
    const [x, v] = next(a);
    a = x;
    return v;
  };
});
const tv = await ctx.newPage();
const logs = [];
tv.on('pageerror', (e) => logs.push(e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(1000);
const res = await tv.evaluate(async (FRAMES) => {
  const k = window.kaleido;
  const orig = k.frame.bind(k);
  k.frame = () => undefined;
  k.quality.update = () => null;
  let vt = 5000;
  // (the world is built again from the seed: how many random numbers boot used up depends on the build's timing)
  const w = 'plaza';
  if (k.stage.current?.def.id === w) k.startAttract(k.stage.defs.find((d) => d.id !== w).id, 'tennis');
  k.stage.cache.delete(w);
  window.__seed(12345);
  k.rng.s = 777;
  k.realT = 0;
  k.last = 0;
  k.rig.debug = null;
  k.rig.shakeSeed = 5; // (made from Math.random when the app was built)
  // (the rig has a memory: start it from a known state, not from whatever the boot's match left)
  Object.assign(k.rig, { shake: 0, fov: 38, winnerBlend: 0, smashW: 0, afterW: 0, introT: 0, shotT: 0, shotIdx: 0, lastSmash: null, followX: 0 });
  k.rig.pos.set(0, 5.6, 21.5);
  k.rig.look.set(0, 0.6, -4);
  k.startAttract(w, 'tennis');
  if (window.flow) window.flow.attractShiftAt = window.flow.attractSportAt = 1e12;
  document.querySelectorAll('.screen, .hud').forEach((e) => (e.style.display = 'none'));
  let h = 0x811c9dc5;
  const hs = { cam: 0x811c9dc5, sim: 0x811c9dc5, poses: 0x811c9dc5 };
  let part = 'cam';
  const mix = (v) => {
    const s = typeof v === 'number' ? v.toFixed(5) : String(v);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
      hs[part] ^= s.charCodeAt(i);
      hs[part] = Math.imul(hs[part], 0x01000193) >>> 0;
    }
  };
  const marks = {};
  for (let f = 0; f < FRAMES; f++) {
    // camera modes: intro fly-in, then the play camera; a staged smash chance and its aftermath
    if (f === 0) k.rig.setMode('intro');
    if (f === 200) k.rig.setMode('play');
    if (f >= 400 && f < 520) k.rig.smash = { team: 0, x: 1.5, z: 9, fh: 1, cx: 0.5, cy: 3.2, cz: 6, after: 0 };
    else if (f >= 520 && f < 600) k.rig.smash = { team: 0, x: 1.5, z: 9, fh: 1, cx: 0.5, cy: 3.2, cz: 6, after: 1, lx: -2, lz: -6 };
    else k.rig.smash = null;
    if (f === 300) k.rig.kick(0.8);
    if (f === 700) k.rig.setMode('attract');
    const s0 = k.slipped;
    orig((vt += 1000 / 60));
    if (k.slipped !== s0 && !marks.slip) marks.slip = f + ':' + (k.slipped - s0).toFixed(4);
    part = 'cam';
    const c = k.rig.cam;
    if (f < 3 || f === 250) marks['f' + f] = c.position.toArray().map((v) => +v.toFixed(4)).join(',') + ' fov ' + c.fov + ' rt ' + k.realT.toFixed(4) + ' mode ' + k.rig.mode;
    for (const e of c.position.toArray()) mix(e);
    for (const e of c.quaternion.toArray()) mix(e);
    mix(c.fov);
    mix(c.aspect);
    for (const e of c.projectionMatrix.elements) mix(e);
    const m = k.match;
    part = 'sim';
    mix(m.t);
    const b = m.ballView(m.t, { x: 0, y: 0, z: 0 });
    mix(b.x); mix(b.y); mix(b.z);
    part = 'poses';
    for (const p of k.livePoses) mix(JSON.stringify(p));
    if (f % 100 === 99) marks[f] = h.toString(16);
  }
  return { digest: h.toString(16), parts: { cam: hs.cam.toString(16), sim: hs.sim.toString(16), poses: hs.poses.toString(16) }, marks, t: k.match.t, slipped: k.slipped };
}, FRAMES);
console.log(JSON.stringify(res));
console.log(logs.join('\n') || 'no page errors');
await browser.close();
