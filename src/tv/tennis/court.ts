// Real court dimensions (metres). x = across, y = up, z = along the court.
// Team 0 plays on the near half (z > 0) facing -z; team 1 on the far half.

export const COURT = {
  halfL: 11.885,
  singlesHalfW: 4.115,
  doublesHalfW: 5.485,
  service: 6.4,
  netH: 0.914,
  netPostH: 1.07,
  netPostX: 6.4,
  /** Ball radius — exaggerated (real is 3.3 cm) so it reads on screen. */
  ballR: 0.075,
  gravity: 9.81,
  drag: 0.17,
};

export function netHeightAt(x: number) {
  const t = Math.min(1, Math.abs(x) / COURT.netPostX);
  return COURT.netH + (COURT.netPostH - COURT.netH) * t * t;
}

/** Facing direction along z for a team: team 0 plays towards -z. */
export const fwdOf = (team: number) => (team === 0 ? -1 : 1);

/** Which team's half a z position belongs to. */
export const sideOf = (z: number) => (z >= 0 ? 0 : 1);

export function inCourt(x: number, z: number, doubles: boolean, slack = 0) {
  const hw = doubles ? COURT.doublesHalfW : COURT.singlesHalfW;
  return Math.abs(x) <= hw + slack && Math.abs(z) <= COURT.halfL + slack;
}

/**
 * The server's "court side" sign: +1 means the server stands on world +x.
 * Deuce court is the server's right-hand side.
 */
export function serveSideSign(team: number, deuce: boolean) {
  const right = team === 0 ? 1 : -1; // team 0 faces -z, so its right is +x
  return deuce ? right : -right;
}

/** Service box the serve must land in (receiver's half, diagonal). */
export function serviceBox(serverTeam: number, deuce: boolean) {
  const s = serveSideSign(serverTeam, deuce);
  const zSign = serverTeam === 0 ? -1 : 1;
  const x0 = s > 0 ? -COURT.singlesHalfW : 0;
  const x1 = s > 0 ? 0 : COURT.singlesHalfW;
  const z0 = zSign < 0 ? -COURT.service : 0;
  const z1 = zSign < 0 ? 0 : COURT.service;
  return { x0, x1, z0, z1 };
}

export function inBox(b: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number, slack = 0) {
  return x >= b.x0 - slack && x <= b.x1 + slack && z >= b.z0 - slack && z <= b.z1 + slack;
}
