// The hook table for game.ts (HOOK_K): where a throw from x=0, angle=0 crosses the
// head-pin line, by speed × spin. Rerun after changing the lane model:
//   npx tsx scripts/check/bowl-hook-table.ts
import { BowlPhysics } from '../../src/tv/bowling/physics';
import { HEAD_Z } from '../../src/tv/bowling/lane';
const P = await BowlPhysics.load();
const empty = new Array(10).fill(false);
function cross(speed: number, spin: number, angle = 0, x = 0) {
  P.rack(empty);
  P.throw({ x, speed, angle, spin });
  let px = P.view.ball.x, pz = P.view.ball.z, t = 0;
  while (t < 30) {
    P.step(1 / 240);
    t += 1 / 240;
    const b = P.view.ball;
    if (b.gutter) return NaN;
    if (b.z <= HEAD_Z) { const u = (HEAD_Z - pz) / (b.z - pz); return px + (b.x - px) * u; }
    px = b.x; pz = b.z;
  }
  return NaN;
}
const speeds = [3, 4, 5, 6, 7, 8, 9, 10, 11];
const spins = [0, 0.2, 0.4, 0.6, 0.8, 1];
console.log('speed ' + spins.map((s) => s.toFixed(1).padStart(7)).join(''));
for (const v of speeds) console.log(String(v).padStart(5) + ' ' + spins.map((s) => cross(v, s).toFixed(3).padStart(7)).join(''));
// linearity in angle and x (does the hook depend on the line?)
console.log('angle 0.02, spin 0.6, v7.5:', (cross(7.5, 0.6, 0.02) - 0.02 * 18.288).toFixed(3), ' vs angle 0:', cross(7.5, 0.6).toFixed(3));
console.log('x 0.3, spin 0.6, v7.5:', (cross(7.5, 0.6, 0, 0.3) - 0.3).toFixed(3));
console.log('spin -0.6 v7.5:', cross(7.5, -0.6).toFixed(3));
