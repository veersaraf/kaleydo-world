// End-to-end look at the bowling remote, with no TV page: this script plays
// the TV itself (a WebSocket as role=tv, allowed from this machine), puts the
// pad in 'bowl' mode, and records what the pad sends. A synthetic phone
// (deviceorientation + devicemotion from an arm-pendulum + wrist-twist model)
// grips, swings back, swings forward with a hook twist and lets go at the
// bottom. A second phone without motion sensors bowls with the swipe fallback.
//
//   PORT=3310 HTTPS_PORT=3753 HMR_PORT=24690 node server/server.mjs --dev   (in another shell)
//   node scripts/bowl-pad-shots.mjs [outDir]        (BASE=http://localhost:3310 by default)
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3310';
const out = process.argv[2] || path.join(os.tmpdir(), 'kaleido-bowl-shots');
fs.mkdirSync(out, { recursive: true });
console.log('screenshots →', out);

// ---------------------------------------------------------------- the fake TV
const tv = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?role=tv');
await new Promise((ok, fail) => (tv.once('open', ok), tv.once('error', fail)));
const got = []; // { pid, t, msg }
const joins = [];
tv.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === 'pad-join') joins.push(m.pid);
  if (m.type === 'pad') got.push({ pid: m.pid, t: Date.now(), msg: m.msg });
});
const toPad = (pid, msg) => tv.send(JSON.stringify({ type: 'to-pad', pid, msg }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function nextJoin(n) {
  for (let i = 0; i < 100 && joins.length < n; i++) await wait(100);
  if (joins.length < n) throw new Error('pad never joined');
  return joins[n - 1];
}

// ---------------------------------------------------------------- a phone that moves
// Runs in the page before its scripts. The pose is device→earth; the screen is
// straight ahead (north). The phone lies flat in the palm, top towards the
// screen, so the remote calibrates "towards the screen" when it joins.
function phone() {
  const D = 180 / Math.PI;
  const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
  const qaxis = (a, ang) => {
    const n = Math.hypot(...a), s = Math.sin(ang / 2) / n;
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)];
  };
  const euler = (q) => {
    const [x, y, z, w] = q;
    const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z);
    const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
    const c = Math.hypot(r20, r22);
    if (c < 1e-6) return [Math.atan2(r10, r00) * D, Math.atan2(r21, 0) * D, 0];
    return [Math.atan2(-r01, r11) * D, Math.atan2(r21, c) * D, Math.atan2(-r20, r22) * D];
  };
  const grip = [0, 0, 0, 1]; // flat in the palm, screen up, top towards the screen
  let sw = null; // the swing being played
  const theta = (t) => {
    if (!sw) return 0;
    const u = t - sw.t0;
    if (sw.kind === 'tennis') return 0;
    if (u < 0) return 0;
    if (u < sw.Tb) return (-sw.back * (1 - Math.cos((Math.PI * u) / sw.Tb))) / 2;
    if (u < sw.Tb + sw.Tf) return -sw.back * Math.cos((Math.PI * (u - sw.Tb)) / sw.Tf);
    return sw.back;
  };
  const phi = (t) => {
    if (!sw || !sw.twist) return 0;
    const s = Math.min(1, Math.max(0, (t - (sw.tBottom - 0.1)) / 0.2));
    return (sw.twist * (1 - Math.cos(Math.PI * s))) / 2;
  };
  // tennis: a forehand turns the phone counter-clockwise (seen from above), peak 950°/s
  const yaw = (t) => {
    if (!sw || sw.kind !== 'tennis') return 0;
    const W = (950 / D), sig = 0.0833, x = (t - sw.tp) / sig;
    const e = (v) => { const k = 1 / (1 + 0.3275911 * Math.abs(v)); const y = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-v * v); return v >= 0 ? y : -y; };
    return W * sig * (Math.sqrt(Math.PI) / 2) * (1 + e(x));
  };
  const pose = (t) => qmul(qaxis([0, 0, 1], yaw(t)), qmul(qaxis([1, 0, 0], theta(t)), qmul(qaxis([0, 0, 1], phi(t)), grip)));
  const now = () => performance.now() / 1000;
  // (the script also runs on about:blank first, where the sensor events don't exist)
  if (typeof DeviceOrientationEvent === 'undefined') return;
  setInterval(() => {
    const t = now();
    const q = pose(t);
    const h = 0.002;
    let d = qmul(qconj(pose(t - h)), pose(t + h));
    if (d[3] < 0) d = d.map((v) => -v);
    const s = Math.hypot(d[0], d[1], d[2]);
    const k = s > 1e-12 ? (2 * Math.atan2(s, d[3])) / (2 * h) / s : 0;
    const w = [d[0] * k, d[1] * k, d[2] * k];
    const [alpha, beta, gamma] = euler(q);
    const upDev = qmul(qmul(qconj(q), [0, 0, 1, 0]), q);
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta, gamma }));
    window.dispatchEvent(
      new DeviceMotionEvent('devicemotion', {
        interval: 16,
        rotationRate: { alpha: w[2] * D, beta: w[0] * D, gamma: w[1] * D },
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: upDev[0] * 9.81, y: upDev[1] * 9.81, z: upDev[2] * 9.81 },
      }),
    );
  }, 16);
  const grab = () => {
    const el = document.querySelector('.grip');
    const r = el.getBoundingClientRect();
    return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const ptr = (type, id = 7) => {
    const { el, x, y } = grab();
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  };
  window.__phone = {
    /** grip, swing back and forward (peak rad/s through the bottom), let go `late` ms after the bottom */
    bowl({ back = 1.2, peak = 8, twist = 0, late = 10 } = {}) {
      const t0 = now() + 0.3;
      const Tb = 0.6, Tf = (back * Math.PI) / peak;
      sw = { kind: 'bowl', t0, back, Tb, Tf, twist, tBottom: t0 + Tb + Tf / 2 };
      ptr('pointerdown');
      const releaseAt = (sw.tBottom + late / 1000 - now()) * 1000;
      return new Promise((done) =>
        setTimeout(() => {
          ptr('pointerup');
          setTimeout(() => {
            sw = null;
            done();
          }, 900);
        }, releaseAt),
      );
    },
    tennis() {
      sw = { kind: 'tennis', tp: now() + 0.6 };
      return new Promise((done) => setTimeout(() => ((sw = null), done()), 1300));
    },
  };
}

// ---------------------------------------------------------------- run
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const logs = [];
const device = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
// In a git worktree node_modules is often a symlink to another checkout, whose
// font files the dev server won't serve (outside its allow list): hand them
// over directly. Only the font files — the CSS comes through Vite as a module.
async function fonts(ctx) {
  await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
    if (fs.existsSync(file)) route.fulfill({ path: file });
    else route.continue();
  });
}
const shot = (page, name) => page.screenshot({ path: path.join(out, name + '.png') });
const since = (t0, pid) => got.filter((g) => g.t >= t0 && g.pid === pid).map((g) => g.msg);
const brief = (m) =>
  m.type === 'ori' ? `ori${m.arm !== undefined ? ` arm=${m.arm}` : ''}` : m.type === 'btn' ? `btn ${m.b} ${m.down ? 'down' : 'up'}` : JSON.stringify(m);
let fail = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

// 1. a phone with motion sensors
const ctxA = await browser.newContext(device);
await fonts(ctxA);
const pa = await ctxA.newPage();
pa.on('pageerror', (e) => logs.push('[pad A] ' + e.message));
await ctxA.addInitScript(phone);
await pa.goto(BASE + '/controller.html?auto');
const pidA = await nextJoin(1);
await wait(1600); // the remote decides whether it has motion sensors
toPad(pidA, { type: 'welcome', slot: 0, color: '#ff5a6e', name: 'Veer' });
toPad(pidA, { type: 'mode', mode: 'bowl', title: 'Your turn!', hint: 'Frame 3 · Ball 1' });
await wait(700);
await shot(pa, 'bowl-idle');

let t0 = Date.now();
const thrown = pa.evaluate(() => window.__phone.bowl({ peak: 8, twist: 1.2 }));
await wait(1000); // into the forward swing, ball still in the hand (it's let go at ~1.15 s)
await shot(pa, 'bowl-swinging');
await thrown;
await wait(150);
await shot(pa, 'bowl-thrown');
let msgs = since(t0, pidA).filter((m) => m.type !== 'hello' && m.type !== 'prefs');
const seq = msgs.filter((m) => m.type !== 'ori' || m.arm !== undefined);
console.log('pad → TV:', seq.map(brief).join(' | '));
const iDown = msgs.findIndex((m) => m.type === 'grip' && m.down);
const iUp = msgs.findIndex((m) => m.type === 'grip' && !m.down);
const iBowl = msgs.findIndex((m) => m.type === 'bowl');
check('grip down → grip up → bowl, in order', iDown >= 0 && iDown < iUp && iUp + 1 === iBowl);
const arms = msgs.filter((m) => m.type === 'ori' && m.arm !== undefined).map((m) => m.arm);
check('arm streamed while gripping (backswing −, then forward)', arms.length > 8 && Math.min(...arms) < -1 && arms[arms.length - 1] > -0.3, `${arms.length} values, min ${Math.min(...arms)}, last ${arms[arms.length - 1]}`);
check('no arm outside the grip', msgs.slice(iUp + 1).every((m) => m.type !== 'ori' || m.arm === undefined));
const b = msgs[iBowl];
check('bowl: relaxed speed, straight, hooks left', b && b.speed > 6 && b.speed < 7.6 && Math.abs(b.angle) < 0.04 && b.spin > 0.4 && b.touch === false, JSON.stringify(b));
check('no tennis swing or prep while bowling', !msgs.some((m) => m.type === 'swing' || m.type === 'prep' || m.type === 'toss'));

toPad(pidA, { type: 'fx', fx: 'perfect', label: 'STRIKE!', detail: `${b?.speed.toFixed(1)} m/s · hook` });
await wait(250);
await shot(pa, 'bowl-strike');

// move / aim: a tap, then a hold that repeats
t0 = Date.now();
const btn = async (label, ms) => {
  const r = await pa.locator(`button[aria-label="${label}"]`).boundingBox();
  await pa.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await pa.mouse.down();
  await wait(ms);
  await pa.mouse.up();
  await wait(100);
};
await wait(700); // past the lock after letting go
await btn('Step left', 80);
await btn('Aim right', 800);
msgs = since(t0, pidA).filter((m) => m.type === 'btn');
console.log('buttons:', msgs.map(brief).join(' | '));
const lefts = msgs.filter((m) => m.b === 'left');
const plus = msgs.filter((m) => m.b === 'plus');
check('◀ tap = one down, one up', lefts.length === 2 && lefts[0].down && !lefts[1].down);
check('↻ held repeats (more downs, then one up)', plus.filter((m) => m.down).length >= 4 && !plus[plus.length - 1].down);

// the next ball: fresh panel (shot at the phone's real height minus the iPhone's safe areas too)
toPad(pidA, { type: 'mode', mode: 'bowl', title: 'Spare?', hint: 'Frame 3 · Ball 2' });
await wait(2800);
await pa.setViewportSize({ width: 390, height: 763 });
await wait(300);
await shot(pa, 'bowl-ball2-safearea');
await pa.setViewportSize({ width: 390, height: 844 });

// the TV takes the pad elsewhere mid-grip: the grip is dropped (grip up, no bowl)
t0 = Date.now();
await pa.evaluate(() => document.querySelector('.grip').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true })));
await wait(200);
toPad(pidA, { type: 'mode', mode: 'watch', title: 'Watching', hint: 'Player 2' });
await wait(300);
msgs = since(t0, pidA).filter((m) => m.type === 'grip' || m.type === 'bowl');
check('leaving bowl mode mid-grip: grip up, no throw', msgs.length === 2 && msgs[0].down && !msgs[1].down, msgs.map(brief).join(' | '));
toPad(pidA, { type: 'fx', fx: 'hit', label: '9 PINS', detail: 'Player 2' });
await wait(250);
await shot(pa, 'watch-fx');

// back to tennis: swings are sent again
t0 = Date.now();
toPad(pidA, { type: 'mode', mode: 'play', title: 'Rally!', hint: 'Swing like a racket' });
await wait(300);
await pa.evaluate(() => window.__phone.tennis());
msgs = since(t0, pidA).filter((m) => m.type === 'swing');
check('tennis still swings after bowling', msgs.length === 1 && msgs[0].side === 'fh', msgs.map((m) => `${m.side} p${m.power}`).join(' '));

// 2. a phone without motion sensors: the swipe fallback
const ctxB = await browser.newContext(device);
await fonts(ctxB);
const pb = await ctxB.newPage();
pb.on('pageerror', (e) => logs.push('[pad B] ' + e.message));
await pb.goto(BASE + '/controller.html?auto');
const pidB = await nextJoin(2);
await wait(1600);
toPad(pidB, { type: 'welcome', slot: 1, color: '#3aa8ff', name: 'Ana' });
toPad(pidB, { type: 'mode', mode: 'bowl', title: 'Your turn!', hint: 'Frame 1 · Ball 1' });
await wait(2000); // the "no motion sensor" toast goes
await shot(pb, 'swipe-idle');
t0 = Date.now();
const g = await pb.locator('.grip').boundingBox();
const cx = g.x + g.width / 2,
  cy = g.y + g.height * 0.75;
await pb.mouse.move(cx, cy);
await pb.mouse.down();
await wait(150);
// a stroke that speeds up, drifting right then curving left into the pocket
for (let i = 1; i <= 14; i++) {
  const u = i / 14;
  await pb.mouse.move(cx + 40 * Math.sin(Math.PI * u) * 0.6, cy - 300 * u * u);
  await wait(20);
}
await pb.mouse.up();
await wait(200);
await shot(pb, 'swipe-thrown');
msgs = since(t0, pidB).filter((m) => m.type === 'grip' || m.type === 'bowl');
console.log('swipe pad → TV:', msgs.map(brief).join(' | '));
const sb = msgs.find((m) => m.type === 'bowl');
check('swipe: grip down, up, bowl with touch:true', msgs.length === 3 && msgs[0].down && !msgs[1].down && sb?.touch === true && sb.speed > 4, JSON.stringify(sb));

console.log(logs.length ? '\npage errors:\n' + logs.join('\n') : '\nno page errors');
console.log(fail ? `\n${fail} end-to-end checks FAILED` : '\nAll end-to-end checks passed.');
await browser.close();
tv.close();
process.exitCode = fail ? 1 : 0;
