// Bowling lane geometry — regulation sizes, in metres.
//
// World layout: the lanes run along −z. The foul line is near the camera
// (z = FOUL_Z), the pins far down the lane. The player's lane is centred on
// x = 0; neighbouring lanes (for the look of an alley) sit at ±LANE.pitch.

export const LANE = {
  /** width of the playing surface */
  width: 1.0541,
  /** width of each gutter */
  gutter: 0.235,
  /** distance between neighbouring lane centres (lane + gutters + divider) */
  pitch: 1.524,
  /** foul line → head pin */
  length: 18.288,
  /** approach behind the foul line */
  approach: 4.6,
  /** head pin → the end of the pin deck (the pit starts here) */
  deck: 0.87,
  /** the pit: depth below the lane, and its length to the back cushion */
  pitDepth: 0.45,
  pitLength: 0.8,
  /** oiled from the foul line up to here; the rest is dry and the ball hooks */
  oilLength: 12.2,
  /** ball */
  ballR: 0.1085,
  ballMass: 6.8,
  /** pins */
  pinH: 0.381,
  pinMaxR: 0.0605,
  pinMass: 1.55,
  /** pin spacing, centre to centre */
  pinSpacing: 0.3048,
};

/** z of the foul line */
export const FOUL_Z = 9.4;
/** z of the head pin (pin 1) */
export const HEAD_Z = FOUL_Z - LANE.length;
/** z where the pin deck ends and the pit begins */
export const PIT_Z = HEAD_Z - LANE.deck;

/**
 * The ten pin spots on a lane centred at `laneX`, in pin-number order
 * (index 0 = pin 1, the head pin). From the bowler's view pin 2 is front-left,
 * 3 front-right; then 4 5 6, then 7 8 9 10 left to right.
 */
export function pinSpots(laneX = 0): { x: number; z: number }[] {
  const s = LANE.pinSpacing;
  const d = s * Math.sin(Math.PI / 3); // row spacing
  const rows: number[][] = [[0], [-0.5, 0.5], [-1, 0, 1], [-1.5, -0.5, 0.5, 1.5]];
  const out: { x: number; z: number }[] = [];
  rows.forEach((row, r) => row.forEach((c) => out.push({ x: laneX + c * s, z: HEAD_Z - r * d })));
  return out;
}

/** Pin silhouette (radius, height) from base to crown — for rendering (lathe) and the collider (convex hull). */
export const PIN_PROFILE: [number, number][] = [
  [0.0, 0.0],
  [0.0258, 0.0],
  [0.042, 0.03],
  [0.055, 0.07],
  [0.0605, 0.114],
  [0.057, 0.16],
  [0.045, 0.2],
  [0.03, 0.24],
  [0.0228, 0.258],
  [0.026, 0.29],
  [0.0318, 0.32],
  [0.0323, 0.343],
  [0.028, 0.365],
  [0.015, 0.378],
  [0.0, 0.381],
];
