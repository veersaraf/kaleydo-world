// Checks the baseball animators' promises, numerically (no browser):
//   npx tsx scripts/baseball-anim-test.ts [--verbose]
//
// - the batter's sweet spot is on the aim at t = SWING.contact, for pitches all
//   over (and outside) the zone, both hands, every lift and power, short and
//   tall characters — and how far the arms have to stretch through the swing,
//   and how close the bat comes to the head and the body;
// - the pitcher's ball is on the release point at t = DELIVERY.release;
// - the catcher's pocket is on the ball at t = arrive.

import { BatterAnimator, PitcherAnimator, CatcherAnimator, BAT, BALL_OUT, THROW, TOSS, GLOVE } from '../src/tv/baseball/anim';
import { FIELD, SWING, DELIVERY } from '../src/tv/baseball/field';
import type { BatterState, PitcherState, CatcherState } from '../src/tv/baseball/types';
import type { Look } from '../src/tv/chars/look';
import type { Pose } from '../src/tv/chars/pose';
import { CHAR_SCALE, TORSO, HEAD } from '../src/tv/chars/rig';

const verbose = process.argv.includes('--verbose');

const look = (height: number, girth: number): Look => ({
  skin: '#f6c9a4',
  shirt: '#3aa8ff',
  shorts: '#fff',
  shoes: '#fff',
  hair: 'bob',
  hairColor: '#2b1d16',
  hat: '#123',
  eyes: 'dot',
  cheeks: true,
  brows: true,
  racket: '#f00',
  height,
  girth,
});

type P3 = { x: number; y: number; z: number };
const sub = (a: P3, b: P3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: P3) => Math.hypot(a.x, a.y, a.z);

/** Rotate by the body's YXZ Euler angles (as Rig.apply). */
function rot(x: number, y: number, z: number, pitch: number, yaw: number, roll: number): P3 {
  const cr = Math.cos(roll),
    sr = Math.sin(roll);
  let X = x * cr - y * sr,
    Y = x * sr + y * cr,
    Z = z;
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const Y2 = Y * cp - Z * sp;
  Z = Y * sp + Z * cp;
  Y = Y2;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const X2 = X * cy + Z * sy;
  Z = -X * sy + Z * cy;
  X = X2;
  return { x: X, y: Y, z: Z };
}

function shoulder(p: Pose, sx: number, girth: number): P3 {
  const q = rot((sx * 0.2 * girth) / Math.sqrt(p.squash), 0.47 * TORSO * p.squash, 0, p.bodyPitch, p.bodyYaw, p.bodyRoll);
  return { x: q.x + p.body.x, y: q.y + p.body.y, z: q.z + p.body.z };
}

/** root-local (unscaled) → world */
function world(p: Pose, sc: number, v: P3): P3 {
  const c = Math.cos(p.yaw),
    s = Math.sin(p.yaw);
  const x = v.x * sc,
    y = v.y * sc,
    z = v.z * sc;
  return { x: p.x + c * x + s * z, y: p.hop + y, z: p.z - s * x + c * z };
}

/** distance from point q to segment ab */
function segDist(q: P3, a: P3, b: P3) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, ((q.x - a.x) * ab.x + (q.y - a.y) * ab.y + (q.z - a.z) * ab.z) / (ab.x * ab.x + ab.y * ab.y + ab.z * ab.z)));
  return len(sub(q, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t }));
}

let fails = 0;
const fail = (m: string) => {
  fails++;
  console.log('FAIL', m);
};

// ---------------------------------------------------------------- the batter

function batter(h: 1 | -1, aimX: number, aimY: number, lift: number, power: number, height: number, girth: number) {
  const a = new BatterAnimator(h, look(height, girth));
  const sc = CHAR_SCALE * height;
  const s: BatterState = { x: -h * FIELD.boxX, z: FIELD.homeZ - 0.2, handed: h, phase: 'stance', t: 0, lift, power, aimX, aimY, yaw: 0, look: null };
  const dt = 1 / 60;
  let t = 0;
  for (let i = 0; i < 60; i++) a.update((t += dt), dt, { ...s, t: i * dt });
  s.phase = 'load';
  for (let i = 0; i < 24; i++) a.update((t += dt), dt, { ...s, t: i * dt });
  s.phase = 'swing';
  let err = Infinity;
  let maxTop = 0,
    maxBot = 0,
    minHead = Infinity,
    minBody = Infinity,
    headAt = 0,
    bodyAt = 0;
  const steps: number[] = [];
  for (let u = 0; u < SWING.end; u += dt) steps.push(u);
  steps.push(SWING.contact);
  steps.sort((x, y) => x - y);
  let last = 0;
  for (const u of steps) {
    const p = a.update((t += u - last || dt), Math.max(1e-3, u - last), { ...s, t: u });
    last = u;
    const g = a.look.girth || 1;
    const sT = shoulder(p, h, g),
      sB = shoulder(p, -h, g);
    const top = len(sub(p.hands[0], sT)) / 0.5,
      bot = len(sub(p.hands[1], sB)) / 0.5;
    maxTop = Math.max(maxTop, top);
    maxBot = Math.max(maxBot, bot);
    // the bat: grip → tip (root space)
    const sw = a.sweetSpot({ x: 0, y: 0, z: 0 });
    const d = p.racketDir;
    const grip = { x: sw.x - d.x * BAT.sweet, y: sw.y - d.y * BAT.sweet, z: sw.z - d.z * BAT.sweet };
    const tip = { x: grip.x + d.x * BAT.tip, y: grip.y + d.y * BAT.tip, z: grip.z + d.z * BAT.tip };
    const from = { x: grip.x + d.x * 0.08, y: grip.y + d.y * 0.08, z: grip.z + d.z * 0.08 };
    const headC = rot(0, 0.62 * TORSO + 0.3 * HEAD * 0.8, 0, p.bodyPitch, p.bodyYaw, p.bodyRoll);
    const hc = { x: headC.x + p.body.x, y: headC.y + p.body.y, z: headC.z + p.body.z };
    const hd = segDist(hc, from, tip) - 0.3 * HEAD - BAT.barrelR;
    if (hd < minHead) (minHead = hd), (headAt = u);
    // the torso: a few points up the spine
    for (const k of [0.15, 0.35, 0.55]) {
      const q = rot(0, k, 0, p.bodyPitch, p.bodyYaw, p.bodyRoll);
      const bd = segDist({ x: q.x + p.body.x, y: q.y + p.body.y, z: q.z + p.body.z }, from, tip) - 0.25 * g - BAT.barrelR;
      if (bd < minBody) (minBody = bd), (bodyAt = u);
    }
    if (Math.abs(u - SWING.contact) < 1e-9) {
      // the ball sits against the barrel at the sweet spot: its centre a ball's and a barrel's radius
      // from the bat's axis, square to it there
      const w = world(p, sc, sw);
      const tipW = world(p, sc, { x: sw.x + d.x, y: sw.y + d.y, z: sw.z + d.z });
      const dW = sub(tipW, w);
      const dl = len(dW);
      const off = sub({ x: aimX, y: aimY, z: FIELD.contactZ }, w);
      const along = (off.x * dW.x + off.y * dW.y + off.z * dW.z) / dl;
      err = Math.hypot(along, len(off) - (FIELD.ballR + BAT.barrelR * sc));
    }
  }
  return { err, maxTop, maxBot, minHead, minBody, headAt, bodyAt };
}

let worst = { err: 0, top: 0, bot: 0, head: Infinity, body: Infinity };
const zone = { top: 0, bot: 0, head: Infinity, body: Infinity };
const rows: string[] = [];
for (const h of [1, -1] as const)
  for (const aimX of [-0.45, -0.25, 0, 0.25, 0.45])
    for (const aimY of [0.35, 0.5, 0.8, 1.15, 1.35])
      for (const lift of [-1, 0, 1])
        for (const power of [0.2, 0.9])
          for (const [height, girth] of [
            [0.94, 0.92],
            [1.06, 1.1],
          ]) {
            const r = batter(h, aimX, aimY, lift, power, height, girth);
            worst.err = Math.max(worst.err, r.err);
            worst.top = Math.max(worst.top, r.maxTop);
            worst.bot = Math.max(worst.bot, r.maxBot);
            worst.head = Math.min(worst.head, r.minHead);
            worst.body = Math.min(worst.body, r.minBody);
            if (Math.abs(aimX) <= FIELD.zoneHalfW + 1e-9 && aimY >= FIELD.zoneBottom - 1e-9 && aimY <= FIELD.zoneTop + 1e-9) {
              zone.top = Math.max(zone.top, r.maxTop);
              zone.bot = Math.max(zone.bot, r.maxBot);
              zone.head = Math.min(zone.head, r.minHead);
              zone.body = Math.min(zone.body, r.minBody);
            }
            if (r.err > 1e-6) fail(`batter h${h} aim ${aimX},${aimY} lift ${lift} power ${power}: sweet spot ${(r.err * 100).toFixed(2)} cm off`);
            rows.push(`h${h > 0 ? '+' : '-'} x${aimX.toFixed(2)} y${aimY.toFixed(2)} L${lift} P${power} H${height}: arms ${r.maxTop.toFixed(2)} / ${r.maxBot.toFixed(2)}  head ${r.minHead.toFixed(3)} @${r.headAt.toFixed(3)}  body ${r.minBody.toFixed(3)} @${r.bodyAt.toFixed(3)}`);
          }
if (verbose) console.log(rows.join('\n'));
console.log(`batter: the ball against the barrel at the sweet spot, error ≤ ${(worst.err * 1000).toFixed(4)} mm`);
console.log(`  in the zone: arms stretch to ${zone.top.toFixed(2)}× (top) / ${zone.bot.toFixed(2)}× (bottom); the bat clears the head by ≥ ${zone.head.toFixed(3)}, the body by ≥ ${zone.body.toFixed(3)} (root units; < 0 = into it)`);
console.log(`  anywhere (balls ${FIELD.zoneHalfW + 0.2} m outside too): arms ${worst.top.toFixed(2)}× / ${worst.bot.toFixed(2)}×; head ≥ ${worst.head.toFixed(3)}, body ≥ ${worst.body.toFixed(3)}`);

// ---------------------------------------------------------------- the pitcher

for (const h of [1, -1] as const)
  for (const kind of ['fastball', 'curve', 'slider', 'changeup'] as const)
    for (const [height, girth] of [
      [0.94, 0.92],
      [1.0, 1.0],
      [1.06, 1.1],
    ]) {
      const a = new PitcherAnimator(h, look(height, girth));
      const sc = CHAR_SCALE * height;
      const s: PitcherState = { x: 0, z: FIELD.moundZ, handed: h, phase: 'set', t: 0, kind, look: null };
      const dt = 1 / 60;
      let t = 0;
      for (let i = 0; i < 60; i++) a.update((t += dt), dt, { ...s, t: i * dt });
      s.phase = 'windup';
      let err = NaN,
        stretch = 0;
      const steps: number[] = [];
      for (let u = 0; u < DELIVERY.end; u += dt) steps.push(u);
      steps.push(DELIVERY.release);
      steps.sort((x, y) => x - y);
      let last = 0;
      for (const u of steps) {
        const p = a.update((t += Math.max(1e-3, u - last)), Math.max(1e-3, u - last), { ...s, t: u });
        last = u;
        const sT = shoulder(p, h, girth);
        stretch = Math.max(stretch, len(sub(p.hands[1], sT)) / 0.5);
        if (Math.abs(u - DELIVERY.release) < 1e-9) {
          const b = PitcherAnimator.ballAt({ x: 0, y: 0, z: 0 }, p.hands[1], sT);
          const w = world(p, sc, b);
          err = len(sub(w, { x: s.x - h * FIELD.releaseSide, y: FIELD.releaseY, z: FIELD.releaseZ }));
          const armLen = len(sub(p.hands[1], sT)) / 0.5;
          if (verbose || armLen > 1.12) console.log(`pitcher h${h} ${kind} H${height}: arm at release ${armLen.toFixed(2)}× (hand ${(len(sub(p.hands[1], sT)) * sc).toFixed(3)} m from the shoulder)`);
        }
      }
      if (!(err < 1e-6)) fail(`pitcher h${h} ${kind} H${height}: ball ${(err * 100).toFixed(2)} cm off the release point`);
      if (verbose) console.log(`pitcher h${h} ${kind} H${height}: max arm stretch ${stretch.toFixed(2)}×`);
    }
console.log(`pitcher: ball on the release point (${fails ? 'see failures' : 'all ok'}); BALL_OUT ${BALL_OUT}`);

// ---------------------------------------------------------------- the catcher

{
  let worstC = 0,
    worstArm = 0;
  for (const tx of [-0.5, -0.2, 0, 0.25, 0.5])
    for (const ty of [0.25, 0.5, 0.8, 1.15, 1.4])
      for (const height of [0.94, 1.06]) {
        const a = new CatcherAnimator(look(height, 1));
        const sc = CHAR_SCALE * height;
        const s: CatcherState = { x: 0, z: FIELD.catcherZ, phase: 'crouch', t: 0, targetX: 0, targetY: 0, arrive: 0.55, look: null };
        const dt = 1 / 60;
        let t = 0;
        for (let i = 0; i < 60; i++) a.update((t += dt), dt, { ...s, t: i * dt });
        s.phase = 'catch';
        s.targetX = tx;
        s.targetY = ty;
        const steps: number[] = [];
        for (let u = 0; u < 1; u += dt) steps.push(u);
        steps.push(s.arrive);
        steps.sort((x, y) => x - y);
        let last = 0;
        for (const u of steps) {
          const p = a.update((t += Math.max(1e-3, u - last)), Math.max(1e-3, u - last), { ...s, t: u });
          last = u;
          if (Math.abs(u - s.arrive) < 1e-9) {
            const w = world(p, sc, a.pocket({ x: 0, y: 0, z: 0 }));
            const e = len(sub(w, { x: tx, y: ty, z: FIELD.catcherZ - 0.35 }));
            worstC = Math.max(worstC, e);
            const sM = shoulder(p, -1, 1);
            const arm = len(sub(p.hands[0], sM)) / 0.5;
            worstArm = Math.max(worstArm, arm);
            if (verbose) console.log(`catcher ${tx},${ty} H${height}: mitt arm ${arm.toFixed(2)}×`);
            if (arm > 1.06) fail(`catcher ${tx},${ty} H${height}: the mitt arm stretched to ${arm.toFixed(2)}×`);
          }
        }
      }
  if (worstC > 1e-6) fail(`catcher: pocket ${(worstC * 100).toFixed(2)} cm off the ball`);
  console.log(`catcher: pocket error ≤ ${(worstC * 1000).toFixed(4)} mm; the mitt arm ≤ ${worstArm.toFixed(2)}× (targets ±0.5 m, 0.25–1.4 m up)`);
}

// ---------------------------------------------------------------- the throw back: out of the catcher's hand, into the pitcher's glove

{
  let worstT = 0,
    worstG = 0;
  for (const height of [0.94, 1.0, 1.06])
    for (const h of [1, -1] as const) {
      // the catcher lets it go on game.ts's TOSS_FROM at THROW.release
      const a = new CatcherAnimator(look(height, 1));
      const sc = CHAR_SCALE * height;
      const s: CatcherState = { x: 0, z: FIELD.catcherZ, phase: 'catch', t: 0, targetX: 0.1, targetY: 0.7, arrive: 0.55, look: null };
      let t = 0;
      for (let u = 0; u < 0.9; u += 1 / 60) a.update((t += 1 / 60), 1 / 60, { ...s, t: u });
      s.phase = 'throw';
      const steps: number[] = [];
      for (let u = 0; u < THROW.end; u += 1 / 60) steps.push(u);
      steps.push(THROW.release);
      steps.sort((x, y) => x - y);
      let last = 0;
      for (const u of steps) {
        const p = a.update((t += Math.max(1e-3, u - last)), Math.max(1e-3, u - last), { ...s, t: u });
        last = u;
        if (Math.abs(u - THROW.release) < 1e-9) {
          const b = CatcherAnimator.ballAt({ x: 0, y: 0, z: 0 }, p.hands[1], shoulder(p, 1, 1));
          const w = world(p, sc, b);
          worstT = Math.max(worstT, len(sub(w, { x: TOSS.x, y: TOSS.y, z: FIELD.catcherZ + TOSS.z })));
        }
      }
      // the pitcher gloves it: the pocket on the arrival point at eta = 0
      const pa = new PitcherAnimator(h, look(height, 1));
      const ps: PitcherState = { x: 0, z: FIELD.moundZ, handed: h, phase: 'idle', t: 0, kind: null, look: null, toss: null };
      const to = { x: 0.3 * h, y: 1.3, z: FIELD.moundZ + 0.45 };
      for (let u = 0; u < 1; u += 1 / 60) pa.update((t += 1 / 60), 1 / 60, { ...ps, t: u });
      for (const eta of [0.9, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05, 1 / 60, 0]) {
        const p = pa.update((t += 1 / 60), 1 / 60, { ...ps, t: 1 + (0.9 - eta), toss: { ...to, eta } });
        if (eta === 0) {
          const gp = slotPoint(p, GLOVE.pocket);
          worstG = Math.max(worstG, len(sub(world(p, sc, gp), to)));
        }
      }
    }
  if (worstT > 1e-6) fail(`catcher: the throw leaves ${(worstT * 100).toFixed(2)} cm off TOSS`);
  if (worstG > 1e-6) fail(`pitcher: the glove's pocket ${(worstG * 100).toFixed(2)} cm off the throw`);
  console.log(`throw back: out of the catcher's hand on TOSS ≤ ${(worstT * 1000).toFixed(4)} mm; into the pitcher's pocket ≤ ${(worstG * 1000).toFixed(4)} mm`);
}

// ---------------------------------------------------------------- a rewind snaps (no easing back)

{
  const a = new BatterAnimator(1, look(1, 1));
  const s: BatterState = { x: -FIELD.boxX, z: FIELD.homeZ - 0.2, handed: 1, phase: 'stance', t: 0, lift: 0.2, power: 0.7, aimX: 0, aimY: 0.8, yaw: 0, look: null };
  let t = 0;
  for (let u = 0; u < 1; u += 1 / 60) a.update((t += 1 / 60), 1 / 60, { ...s, t: u });
  s.phase = 'load';
  for (let u = 0; u < 0.62; u += 1 / 60) a.update((t += 1 / 60), 1 / 60, { ...s, t: u });
  // a late swing: straight to the contact frame (the hitstop's dt is tiny)
  s.phase = 'swing';
  const p = a.update(t, 1e-4, { ...s, t: SWING.contact });
  const sw = a.sweetSpot({ x: 0, y: 0, z: 0 });
  const tip = { x: sw.x + p.racketDir.x, y: sw.y + p.racketDir.y, z: sw.z + p.racketDir.z };
  const sc = CHAR_SCALE;
  const w = world(p, sc, sw),
    wt = world(p, sc, tip);
  const dW = sub(wt, w);
  const off = sub({ x: 0, y: 0.8, z: FIELD.contactZ }, w);
  const along = (off.x * dW.x + off.y * dW.y + off.z * dW.z) / len(dW);
  const err = Math.hypot(along, len(off) - (FIELD.ballR + BAT.barrelR * sc));
  if (err > 1e-6) fail(`batter: rewound to the contact frame, the ball's ${(err * 100).toFixed(2)} cm off the barrel`);
  // and the pitcher, its windup clock put back: straight there
  const pa = new PitcherAnimator(1, look(1, 1));
  const ps: PitcherState = { x: 0, z: FIELD.moundZ, handed: 1, phase: 'set', t: 0, kind: 'fastball', look: null };
  for (let u = 0; u < 0.6; u += 1 / 60) pa.update((t += 1 / 60), 1 / 60, { ...ps, t: u });
  ps.phase = 'windup';
  let q = pa.update(t, 1 / 60, { ...ps, t: 0 });
  for (let u = 1 / 60; u < 1.72; u += 1 / 60) q = pa.update((t += 1 / 60), 1 / 60, { ...ps, t: u });
  const back = pa.update(t, 1e-4, { ...ps, t: 1.6 }).hands[1];
  const fresh = new PitcherAnimator(1, look(1, 1));
  for (let u = 0; u < 0.6; u += 1 / 60) fresh.update(u, 1 / 60, { ...ps, phase: 'set', t: u });
  let f = fresh.update(0.6, 1 / 60, { ...ps, t: 0 });
  for (let u = 1 / 60; u <= 1.6 + 1e-9; u += 1 / 60) f = fresh.update(0.6 + u, 1 / 60, { ...ps, t: Math.min(u, 1.6) });
  f = fresh.update(3, 1e-4, { ...ps, t: 1.6 });
  const pe = len(sub(back, f.hands[1]));
  if (pe > 1e-6) fail(`pitcher: rewound, the throwing hand's ${(pe * 100).toFixed(2)} cm from where the windup puts it`);
  void q;
  console.log(`rewind: batter at the contact frame at once (${(err * 1000).toFixed(4)} mm), the pitcher's windup back exactly (${(pe * 1000).toFixed(4)} mm)`);
}

/** a point in the racket slot's space → root, for a pose (as Rig.apply builds the slot) */
function slotPoint(p: Pose, q: { x: number; y: number; z: number }) {
  const Y = { ...p.racketDir };
  const yl = len(Y);
  Y.x /= yl;
  Y.y /= yl;
  Y.z /= yl;
  const Z = { ...p.racketFace };
  const k = Z.x * Y.x + Z.y * Y.y + Z.z * Y.z;
  Z.x -= Y.x * k;
  Z.y -= Y.y * k;
  Z.z -= Y.z * k;
  const zl = len(Z);
  Z.x /= zl;
  Z.y /= zl;
  Z.z /= zl;
  const X = { x: Y.y * Z.z - Y.z * Z.y, y: Y.z * Z.x - Y.x * Z.z, z: Y.x * Z.y - Y.y * Z.x };
  return { x: p.hands[0].x + X.x * q.x + Y.x * q.y + Z.x * q.z, y: p.hands[0].y + X.y * q.x + Y.y * q.y + Z.y * q.z, z: p.hands[0].z + X.z * q.x + Y.z * q.y + Z.z * q.z };
}

console.log(fails ? `${fails} failures` : 'all good');
process.exit(fails ? 1 : 0);
