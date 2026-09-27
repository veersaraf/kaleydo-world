// Baseball field — world metres.
//
// It's a Home Run Derby in a ballpark built into each world's stadium. Home plate
// sits at the +z end of where the tennis court was and the batter faces the
// pitcher down −z; the batting camera is behind the catcher, like Wii Sports.
//
// The stadium was built for tennis, so the park is a small one — a diorama: its
// fence stands 19 m out down the lines and 26.5 m to centre, just inside the
// stands. The distances painted on it, and every distance the game shows, are a
// real park's (100 m down the lines, 122 m to centre): the game works out each
// hit in real metres and flies the ball through the diorama so it comes down
// where those numbers say — a ball that makes the fence's number clears the
// fence, one that doesn't comes down in front of it (see physics.ts).
//
// Fair territory is ±32°, not a real field's ±45°: the stands are only 21 m
// apart. There are no bases (nobody runs them in a derby), so nothing gives the
// narrower wedge away.

export const FIELD = {
  /** home plate's back point; the plate's front edge (facing the pitcher) is 0.43 m nearer the pitcher */
  homeZ: 12,
  plateFront: 12 - 0.43,
  /** the pitcher's rubber; the pitcher faces +z */
  moundZ: -4.5,
  /** where the ball leaves the pitcher's hand: out in front of the rubber, at the pitcher's face — as far as
   *  the characters reach over the top at the end of their stride (shoulders ~1.06 m up, arms 0.58 m long,
   *  legs 0.4 m: a real pitcher's 1.8 m high and 1.9 m out is beyond them)… */
  releaseZ: -3.45,
  releaseY: 1.5,
  /** …and this far to the side of the pitcher's throwing arm (a right-hander's is at −x) */
  releaseSide: 0.42,
  /** a well-timed swing meets the ball here, a little in front of the plate */
  contactZ: 12 - 0.75,
  /** the batter's box centre: right-handed batters stand at −x, left-handed at +x */
  boxX: 0.95,
  /** the strike zone, at the plate */
  zoneHalfW: 0.25,
  zoneBottom: 0.5,
  zoneTop: 1.15,
  /** fair territory: within this angle either side of straight away (−z) */
  foulAngle: (32 * Math.PI) / 180,
  /** the fence: its distance from home plate (world) at the foul poles and to straight-away centre, and its height */
  fencePole: 18.9,
  fenceCenter: 26.5,
  fenceH: 2.2,
  /** the distances painted on it, which every distance the game shows counts in: a real park's */
  realPole: 100,
  realCenter: 122,
  /** where the catcher squats, behind the plate */
  catcherZ: 12 + 0.95,
  /** ball radius (exaggerated so it reads — a real one is 3.7 cm) */
  ballR: 0.06,
  gravity: 9.81,
};

/** The pitcher's delivery, seconds from the start of the windup: the ball leaves the hand at `release`. */
export const DELIVERY = { release: 1.1, end: 1.75 };

/** The batter's swing, seconds from its start: the bat meets a well-timed ball at `contact`; it's all over by `end`. */
export const SWING = { contact: 0.15, end: 0.75 };

/** 0 on the foul lines … 1 straight away (the fence's shape between them) */
function towardCentre(a: number) {
  const u = Math.min(1, Math.abs(a) / FIELD.foulAngle);
  const c = Math.cos((u * Math.PI) / 2);
  return c * c;
}

/** The fence's distance from home plate (world metres) along spray angle `a` (radians from straight away, + = towards +x). */
export function fenceAt(a: number) {
  return FIELD.fencePole + (FIELD.fenceCenter - FIELD.fencePole) * towardCentre(a);
}

/** The distance painted on the fence (real metres) along spray angle `a`. */
export function realFenceAt(a: number) {
  return FIELD.realPole + (FIELD.realCenter - FIELD.realPole) * towardCentre(a);
}

/** Real metres per world metre along spray angle `a` (inside the fence). */
export function realScale(a: number) {
  return realFenceAt(a) / fenceAt(a);
}

/** The point `r` world metres from home plate along spray angle `a`. */
export function fieldPoint(a: number, r: number) {
  return { x: Math.sin(a) * r, z: FIELD.homeZ - Math.cos(a) * r };
}

/** A point's spray angle and distance (world metres) from home plate. */
export function sprayOf(x: number, z: number) {
  const dz = FIELD.homeZ - z;
  return { a: Math.atan2(x, dz), r: Math.hypot(x, dz) };
}

/** Is spray angle `a` fair? */
export const isFair = (a: number) => Math.abs(a) <= FIELD.foulAngle;
