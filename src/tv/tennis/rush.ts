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
   * how much of the ball's extra pace the players get as running speed (0..1): the ball can't
   * gain the full pace (a flat, fast drive still has to clear the net), so running at the full
   * multiplier would make Rush easier than the standard game
   */
  run: 0.7,
  /**
   * a faster drive is also flatter: its required net clearance is divided by pace^flatten (the net
   * clearance is what caps a drive's speed, so without this the pace multiplier barely shows)
   */
  flatten: 3,
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
