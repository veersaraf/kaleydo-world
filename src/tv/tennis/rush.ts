// Rush: a faster tennis mode. Every shot in a rally builds heat; heat speeds the
// ball (and the players, so it stays reachable) and at full heat the ball is on fire.
//
// Heat is worked out from what every TV already sees in the hit events (the rally
// count and whether a hit was perfect), so a guest's TV draws the same fire as the
// host's without anything new in the match stream.

import { clamp } from '../core/math';

export const RUSH = {
  /** pace of the first rally shot (× the standard game's) */
  base: 1.15,
  /** pace at full heat */
  max: 1.45,
  /** heat added by every rally hit (a serve starts the rally at 0) */
  perHit: 0.1,
  /** extra heat for a perfect hit */
  perfect: 0.15,
  /**
   * how much of the ball's extra pace the players get as running speed (0..1). At 1 they run as
   * much faster as the ball is (the sims show that keeps the rally length and reach at the
   * standard game's level with the ball at 0.70x the hit-to-hit time)
   */
  run: 1,
  /**
   * a faster drive or volley is hit flatter: its required net clearance is divided by pace^flatten
   */
  flatten: 1.5,
  /**
   * ...and it drops harder: the flight's gravity is multiplied by pace^drop (topspin dip), so a
   * ball that is faster still clears the net and lands at the same target. (Pace^2 would be the
   * exact time-compressed copy of a standard shot; 1.5 keeps the bounce's kick down.) It only
   * applies to the flight, the bounce and what follows use the standard gravity.
   */
  drop: 1.5,
} as const;

/** The rally's heat after a hit: a serve resets it, every other hit builds it. */
export function heatAfter(heat: number, hit: { serve: boolean; perfect: boolean }): number {
  if (hit.serve) return 0;
  return clamp(heat + RUSH.perHit + (hit.perfect ? RUSH.perfect : 0), 0, 1);
}

/** Ball and running pace multiplier at a given heat (0..1). */
export function paceAt(heat: number): number {
  return RUSH.base + (RUSH.max - RUSH.base) * clamp(heat, 0, 1);
}

/** The ball is on fire at full heat. */
export function onFire(heat: number): boolean {
  return heat >= 1;
}
