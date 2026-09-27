// Frame-by-frame trace of one swing: how far each arm stretches, how close the
// bat comes to the head and the body, where the bat is (batter frame: A towards
// the pitcher, P towards the plate, U up; root units).
//   npx tsx scripts/baseball-swing-trace.ts [aimX] [aimY] [lift] [power] [handed]

import { BatterAnimator, BAT } from '../src/tv/baseball/anim';
import { FIELD, SWING } from '../src/tv/baseball/field';
import type { BatterState } from '../src/tv/baseball/types';
import type { Pose } from '../src/tv/chars/pose';
import type { Look } from '../src/tv/chars/look';
import { TORSO, HEAD } from '../src/tv/chars/rig';

const [aimX = 0, aimY = 0.8, lift = 0, power = 0.6, hd = 1] = process.argv.slice(2).map(Number);
const h = (hd === -1 ? -1 : 1) as 1 | -1;
type P3 = { x: number; y: number; z: number };
const sub = (a: P3, b: P3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: P3) => Math.hypot(a.x, a.y, a.z);
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
const shoulder = (p: Pose, sx: number) => {
  const q = rot((sx * 0.2) / Math.sqrt(p.squash), 0.47 * TORSO * p.squash, 0, p.bodyPitch, p.bodyYaw, p.bodyRoll);
  return { x: q.x + p.body.x, y: q.y + p.body.y, z: q.z + p.body.z };
};
function segDist(q: P3, a: P3, b: P3) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, ((q.x - a.x) * ab.x + (q.y - a.y) * ab.y + (q.z - a.z) * ab.z) / (ab.x * ab.x + ab.y * ab.y + ab.z * ab.z)));
  return len(sub(q, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t }));
}
const look: Look = { skin: '#fff', shirt: '#fff', shorts: '#fff', shoes: '#fff', hair: 'none', hairColor: '#000', hat: '#000', eyes: 'dot', cheeks: false, brows: false, racket: '#fff', height: 1, girth: 1 };
const a = new BatterAnimator(h, look);
const s: BatterState = { x: -h * FIELD.boxX, z: FIELD.homeZ - 0.2, handed: h, phase: 'stance', t: 0, lift, power, aimX, aimY, yaw: 0, look: null };
const dt = 1 / 60;
let t = 0;
for (let i = 0; i < 60; i++) a.update((t += dt), dt, { ...s, t: i * dt });
s.phase = 'load';
for (let i = 0; i < 24; i++) a.update((t += dt), dt, { ...s, t: i * dt });
s.phase = 'swing';
const B = (v: P3) => `A${(-h * v.x).toFixed(2)} P${(-v.z).toFixed(2)} U${v.y.toFixed(2)}`;
const step = Number(process.env.STEP || 1 / 60);
for (let u = 0; u <= SWING.end + 1e-9; u += step) {
  const p = a.update((t += step), step, { ...s, t: u });
  const sT = shoulder(p, h),
    sB = shoulder(p, -h);
  const sw = a.sweetSpot({ x: 0, y: 0, z: 0 });
  const d = p.racketDir;
  const grip = { x: sw.x - d.x * BAT.sweet, y: sw.y - d.y * BAT.sweet, z: sw.z - d.z * BAT.sweet };
  const tip = { x: grip.x + d.x * BAT.tip, y: grip.y + d.y * BAT.tip, z: grip.z + d.z * BAT.tip };
  const from = { x: grip.x + d.x * 0.08, y: grip.y + d.y * 0.08, z: grip.z + d.z * 0.08 };
  const hcR = rot(0, 0.62 * TORSO + 0.3 * HEAD * 0.8, 0, p.bodyPitch, p.bodyYaw, p.bodyRoll);
  const hc = { x: hcR.x + p.body.x, y: hcR.y + p.body.y, z: hcR.z + p.body.z };
  const head = segDist(hc, from, tip) - 0.3 * HEAD - BAT.barrelR;
  let body = Infinity;
  for (const k of [0.15, 0.35, 0.55]) {
    const q = rot(0, k, 0, p.bodyPitch, p.bodyYaw, p.bodyRoll);
    body = Math.min(body, segDist({ x: q.x + p.body.x, y: q.y + p.body.y, z: q.z + p.body.z }, from, tip) - 0.25 - BAT.barrelR);
  }
  const dirB = `(${(-h * d.x).toFixed(2)},${(-d.z).toFixed(2)},${d.y.toFixed(2)})`;
  console.log(
    `${u.toFixed(3)} top ${(len(sub(p.hands[0], sT)) / 0.5).toFixed(2)} bot ${(len(sub(p.hands[1], sB)) / 0.5).toFixed(2)} head ${head.toFixed(2)} body ${body.toFixed(2)}  grip ${B(grip)} dir ${dirB} phi ${(h * p.bodyYaw).toFixed(2)} body ${B(p.body)}`,
  );
}
