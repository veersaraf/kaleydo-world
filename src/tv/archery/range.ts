// Archery range — sizes in metres.
//
// World layout: the archer stands on the shooting line near the +z end of where
// the tennis court was, facing −z. Targets stand down the range in front of them,
// inside the stadium (the scenery beyond is the backdrop): distances of 10–32 m,
// up to a few metres to either side and up (poles, platforms, floating balloons).

export const RANGE = {
  /** the shooting line (the archer's feet), and how high the arrow leaves the bow */
  lineZ: 14,
  eyeY: 1.55,
  /** targets stay inside this box */
  minZ: -18,
  maxZ: 4,
  halfX: 7,
  maxY: 7,
  /** a standard target face (a smaller one for expert ends) */
  faceR: 0.61,
  /** arrow launch speed at full draw, m/s (weaker draws are slower and drop more) */
  fullSpeed: 48,
  gravity: 9.8,
  /** seconds to reach full draw while holding */
  drawT: 0.9,
};

/** Rings: a target face has 10 scoring rings (10 in the middle … 1 at the edge). Ring of a hit at `r` metres from the centre, 0 = missed the face. */
export function ringOf(r: number, faceR: number = RANGE.faceR) {
  if (r > faceR) return 0;
  return Math.max(1, 10 - Math.floor((r / faceR) * 10));
}
