// The ranges: what stands down the range each end, and the wind. Every end has
// a main face straight down the range (the one the CPUs shoot at and a person's
// aim starts on): end 1 a big one at 15 m; end 2 a standard one at 22 m with a
// second raised on a tower beside it; end 3 a small expert face at 30 m with a
// standard one swaying slowly on a gantry off to one side. Balloons float about,
// worth BALLOON_BONUS each on top of any face the arrow then hits: one hangs
// just off the ideal line to the main face (pop it on the way and the arrow flies
// on to hit the face off-centre — a gamble), the others are targets of their own.
// Ends after the third are encores: an expert range shuffled. Everything stays
// inside RANGE's box.

import { RANGE } from './range';
import type { TargetDef } from './types';
import { aimFor, flyTo } from './physics';
import type { Rng } from '../core/math';

export const BALLOON_BONUS = 5;
export const BALLOON_R = 0.28;
/** end 1's big face and the expert face (a standard face is RANGE.faceR) */
export const BIG_FACE_R = 0.8;
export const EXPERT_FACE_R = 0.45;
/** a face's centre on its stand, above the ground */
export const FACE_Y = 1.3;
/** the wind's strength each end (then as the last), m/s, blowing either way */
export const WIND: readonly [number, number][] = [
  [0, 1],
  [1, 3],
  [2, 5],
];
/** a balloon's colour, by its id (its pop's confetti matches) */
export const BALLOON_COLORS = ['#ff4d6d', '#ffbe0b', '#3a86ff', '#8ac926', '#c77dff', '#ff7b00'];
export const balloonColor = (id: number) => BALLOON_COLORS[((id % BALLOON_COLORS.length) + BALLOON_COLORS.length) % BALLOON_COLORS.length];

/** the balloon near the main line: this far to the side of the ideal flight (centre to centre), a touch above */
const NEAR_OFF = 0.46;
const NEAR_UP = 0.1;

export interface Layout {
  targets: TargetDef[];
  /** index into targets of the main face */
  main: number;
  /** m/s, + = blowing to +x (the archer's right) */
  wind: number;
}

/** z of something `d` metres down the range from the shooting line */
const at = (d: number) => RANGE.lineZ - d;

/**
 * End `end`'s range (1-based) and wind. Target ids run on from `firstId` (so
 * they're unique through a game).
 */
export function layoutFor(end: number, rng: Rng, firstId = 0): Layout {
  const band = WIND[Math.min(end, WIND.length) - 1];
  const wind = (rng.chance(0.5) ? 1 : -1) * rng.range(band[0], band[1]);
  let side = rng.chance(0.5) ? 1 : -1;
  const t: TargetDef[] = [];
  const add = (kind: TargetDef['kind'], x: number, y: number, z: number, r: number, swayX = 0, swayT = 0) => {
    t.push({ id: firstId + t.length, kind, x, y, z, r, bonus: kind === 'balloon' ? BALLOON_BONUS : 0, swayX, swayT });
    return t[t.length - 1];
  };
  const balloon = (x: number, y: number, z: number, swayX: number, swayT: number) => add('balloon', x, y, z, BALLOON_R, swayX, swayT);
  /** a balloon hanging just to one side of the ideal full-draw flight to `face` (the end's wind allowed for) */
  const nearLine = (face: TargetDef, d: number, s: number) => {
    const aim = aimFor(face.x, face.y, face.z, RANGE.fullSpeed, wind);
    const p = flyTo(aim.yaw, aim.pitch, RANGE.fullSpeed, at(d), wind);
    return balloon(p.x + s * NEAR_OFF, p.y + NEAR_UP, at(d), 0.08 * s, 4.1);
  };

  if (end <= 1) {
    const main = add('face', 0, FACE_Y, at(15), BIG_FACE_R);
    nearLine(main, 10, side);
    balloon(-side * rng.range(2, 2.6), rng.range(2.7, 3.2), at(rng.range(13, 16.5)), 0.15 * side, 5.3);
    return { targets: t, main: 0, wind };
  }
  if (end === 2) {
    const main = add('face', 0, FACE_Y, at(22), RANGE.faceR);
    // the raised one, on a tower to one side (the near-line balloon hangs on the other)
    add('face', side * rng.range(3.1, 3.6), rng.range(4.1, 4.5), at(23), RANGE.faceR);
    nearLine(main, 16, -side);
    balloon(side * rng.range(1.5, 1.9), rng.range(2.9, 3.3), at(rng.range(18.5, 20)), -0.15 * side, 4.6);
    balloon(-side * rng.range(3.5, 4.1), rng.range(4.3, 4.9), at(rng.range(25, 27)), 0.2 * side, 5.7);
    return { targets: t, main: 0, wind };
  }
  // end 3 (and encores: the expert range, shuffled)
  const encore = end > 3;
  const mx = encore ? rng.range(-1.2, 1.2) : 0;
  const md = encore ? rng.range(27, 32) : 30;
  // (the swayer goes on the other side from a main face that's off-centre)
  if (Math.abs(mx) > 0.3) side = mx > 0 ? -1 : 1;
  const main = add('face', mx, FACE_Y, at(md), encore && rng.chance(0.4) ? RANGE.faceR : EXPERT_FACE_R);
  // the swayer, slow, on the side away from the main line (its path never crosses it)
  const sway = encore ? rng.range(1.6, 2.0) : 1.9;
  add('face', side * 3.7, encore ? rng.range(2.9, 3.8) : 3.3, at(encore ? md - rng.range(2.5, 5) : 26), RANGE.faceR, (rng.chance(0.5) ? 1 : -1) * sway, encore ? rng.range(6, 9) : 7.5);
  nearLine(main, encore ? rng.range(17, 21) : 20, -side);
  balloon(-side * rng.range(2.5, 3.1), rng.range(4.8, 5.5), at(encore ? rng.range(22, 29) : 28), 0.18 * side, 5.1);
  return { targets: t, main: 0, wind };
}
