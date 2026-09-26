// Sword duel arena — sizes in metres.
//
// World layout: a long, narrow platform raised above water (or whatever each
// world falls into), running along z and centred on the origin where the tennis
// court was. Fighter 0 starts on the +z side (nearest the default camera) facing
// −z; fighter 1 on the −z side facing +z. Hits push a fighter back along z; off
// either end, they fall.

export const ARENA = {
  /** the platform: along z (the fight axis), across x, and its top above the ground */
  length: 8,
  width: 2.6,
  top: 1.6,
  /** squared up: chest to chest */
  gap: 2.2,
  /** a strike reaches a fighter up to this far away */
  reach: 2.7,
  /** the final round (1–1) is fought on a shorter platform */
  finalLength: 5.2,
};

/** the hazard's surface (water) — where a falling fighter splashes */
export const HAZARD_Y = 0;

const G = 9.8;
/** the little hop as a fighter goes over the edge, m/s */
const FALL_POP = 1.6;

/** Height of a falling fighter's feet, t seconds after leaving the edge (keeps going below the surface). */
export function fallY(t: number) {
  return ARENA.top + FALL_POP * t - 0.5 * G * t * t;
}

/** Seconds from leaving the edge to reaching the hazard's surface (the splash). */
export const FALL_T = (FALL_POP + Math.sqrt(FALL_POP * FALL_POP + 2 * G * (ARENA.top - HAZARD_Y))) / G;

/** Where fighter i stands at the start of a round (z), for a platform of this length. */
export function startZ(i: number) {
  return (i === 0 ? 1 : -1) * (ARENA.gap / 2);
}
