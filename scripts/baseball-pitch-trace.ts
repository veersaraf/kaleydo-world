// Frame-by-frame trace of the pitcher's windup: each arm's stretch (× its
// length), the throwing hand in the pitcher's frame (F towards the plate, R the
// throwing side, U up; root units) and the ball's distance to the release point.
//   npx tsx scripts/baseball-pitch-trace.ts [kind] [handed] [height]

import { PitcherAnimator } from '../src/tv/baseball/anim';
import { FIELD, DELIVERY } from '../src/tv/baseball/field';
import type { PitcherState, PitchKind } from '../src/tv/baseball/types';
import type { Pose } from '../src/tv/chars/pose';
import type { Look } from '../src/tv/chars/look';
import { TORSO, CHAR_SCALE } from '../src/tv/chars/rig';

const kind = (process.argv[2] ?? 'fastball') as PitchKind;
const h = (Number(process.argv[3] ?? 1) === -1 ? -1 : 1) as 1 | -1;
const height = Number(process.argv[4] ?? 1);
type P3 = { x: number; y: number; z: number };
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
const len = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const look: Look = { skin: '#fff', shirt: '#fff', shorts: '#fff', shoes: '#fff', hair: 'none', hairColor: '#000', hat: '#000', eyes: 'dot', cheeks: false, brows: false, racket: '#fff', height, girth: 1 };
const a = new PitcherAnimator(h, look);
const sc = CHAR_SCALE * height;
const s: PitcherState = { x: 0, z: FIELD.moundZ, handed: h, phase: 'set', t: 0, kind, look: null };
let t = 0;
for (let i = 0; i < 60; i++) a.update((t += 1 / 60), 1 / 60, { ...s, t: i / 60 });
s.phase = 'windup';
const step = 1 / 60;
for (let u = 0; u <= DELIVERY.end + 1e-9; u += step) {
  const uu = Math.abs(u - DELIVERY.release) < step / 2 ? DELIVERY.release : u;
  const p = a.update((t += step), step, { ...s, t: uu });
  const sT = shoulder(p, h),
    sG = shoulder(p, -h);
  // root → the pitcher's frame, allowing for the root's turn (yaw = π − h·ρ)
  const d = p.yaw - Math.PI;
  const c = Math.cos(d),
    sn = Math.sin(d);
  const hx = p.hands[1].x,
    hz = p.hands[1].z;
  const sqx = c * hx + sn * hz,
    sqz = -sn * hx + c * hz;
  const ball = PitcherAnimator.ballAt({ x: 0, y: 0, z: 0 }, p.hands[1], sT);
  const wx = p.x + Math.cos(p.yaw) * ball.x * sc + Math.sin(p.yaw) * ball.z * sc,
    wy = ball.y * sc,
    wz = p.z - Math.sin(p.yaw) * ball.x * sc + Math.cos(p.yaw) * ball.z * sc;
  const rel = Math.hypot(wx + h * FIELD.releaseSide, wy - FIELD.releaseY, wz - FIELD.releaseZ);
  console.log(
    `${uu.toFixed(3)} throw ${(len(p.hands[1], sT) / 0.5).toFixed(2)} glove ${(len(p.hands[0], sG) / 0.5).toFixed(2)}  hand F${(-sqz).toFixed(2)} R${(h * sqx).toFixed(2)} U${p.hands[1].y.toFixed(2)}  root ${(-(h * d)).toFixed(2)}  ball→release ${rel.toFixed(3)} m`,
  );
}
