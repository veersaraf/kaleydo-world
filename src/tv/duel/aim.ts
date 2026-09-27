// Sword poses in a fighter's own frame: x = their right, y = up, z = towards the
// opponent (see types.ts). The game falls back on readyAim when no phone streams
// a pose, the CPU holds its sword with these, and a keyboard player's guard can
// be made with guardAim.
//
// A slash sweeps the blade through the plane spanned by the cut's direction across
// the view (u) and forward (z): at swing angle ψ the blade is −cos ψ·u + sin ψ·z,
// so ψ < 0 is cocked back on the side the cut starts from, ψ = π/2 points at the
// opponent (contact) and ψ > π/2 follows through to the other side.

import type { SlashInput, SwordAim } from './types';

/** the cocked sword's swing angle: back past the shoulder, where a person can read it */
const COCK_PSI = -0.55;
/** where the follow-through ends */
const FOLLOW_PSI = 2.3;

/** a new aim, in the ready stance */
export function newAim(): SwordAim {
  return readyAim({ blade: [0, 0, 1], edge: [0, -1, 0] });
}

/**
 * Write a pose into `out`: the blade (bx, by, bz) normalised, and the edge as
 * near to (ex, ey, ez) as it can be while square to the blade. Anything
 * degenerate (zero, NaN) falls back to the ready stance, so a pose is always
 * two perpendicular unit vectors the animator can hold a sword from.
 */
export function setAim(out: SwordAim, bx: number, by: number, bz: number, ex: number, ey: number, ez: number): SwordAim {
  let l = Math.hypot(bx, by, bz);
  if (!(l > 1e-6)) {
    bx = 0;
    by = 0.62;
    bz = 0.78;
    l = Math.hypot(by, bz);
  }
  bx /= l;
  by /= l;
  bz /= l;
  let d = ex * bx + ey * by + ez * bz;
  let x = ex - d * bx;
  let y = ey - d * by;
  let z = ez - d * bz;
  l = Math.hypot(x, y, z);
  if (!(l > 1e-3)) {
    // no usable edge hint: face it forward, or down when the blade itself points forward
    const f = Math.abs(bz) < 0.9;
    d = f ? bz : -by;
    x = -d * bx;
    y = (f ? 0 : -1) - d * by;
    z = (f ? 1 : 0) - d * bz;
    l = Math.hypot(x, y, z);
  }
  out.blade[0] = bx;
  out.blade[1] = by;
  out.blade[2] = bz;
  out.edge[0] = x / l;
  out.edge[1] = y / l;
  out.edge[2] = z / l;
  return out;
}

export function copyAim(out: SwordAim, a: SwordAim): SwordAim {
  return setAim(out, a.blade[0], a.blade[1], a.blade[2], a.edge[0], a.edge[1], a.edge[2]);
}

/** Blend `out` a fraction k of the way to `b` (and renormalise). */
export function blendAim(out: SwordAim, b: SwordAim, k: number): SwordAim {
  const a = out;
  return setAim(
    out,
    a.blade[0] + (b.blade[0] - a.blade[0]) * k,
    a.blade[1] + (b.blade[1] - a.blade[1]) * k,
    a.blade[2] + (b.blade[2] - a.blade[2]) * k,
    a.edge[0] + (b.edge[0] - a.edge[0]) * k,
    a.edge[1] + (b.edge[1] - a.edge[1]) * k,
    a.edge[2] + (b.edge[2] - a.edge[2]) * k,
  );
}

/** Sword up and forward at the opponent's throat, edge down (bladeAngle = π/2: it guards against side cuts). */
export function readyAim(out: SwordAim): SwordAim {
  return setAim(out, 0, 0.62, 0.78, 0, -0.78, 0.62);
}

/**
 * The line a guard at `angle` makes, as the direction a hand holds it in: a
 * right-hander (hilt in the right hand) points the blade up or across to the
 * left; a left-hander up or to the right. `near` (a direction) picks whichever
 * of the two is closest to it instead, so a turning guard doesn't flip over.
 */
export function guardDir(angle: number, handed: 1 | -1, near?: number) {
  let a = angle - Math.PI * Math.floor(angle / Math.PI); // 0..π
  if (near !== undefined) {
    // the representative nearest to where the blade already points, unless that points down
    let d = a - near;
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    let b = a;
    if (Math.abs(d) > Math.PI / 2) b = a - Math.PI;
    if (Math.sin(b) > -0.35) return b;
    return b + Math.PI;
  }
  if (handed === 1) return a === 0 ? Math.PI : a; // (0, π]
  return a === Math.PI ? 0 : a; // [0, π)
}

/**
 * Guarding: the blade across the view at `angle` (radians, as bladeAngle: 0 =
 * pointing right, π/2 = up — a line, so angle and angle + π are the same guard),
 * leaning a little towards the opponent, edge forward. It stops cuts whose path
 * crosses that line at 55° or more (types.ts blocks(); a person's guard, 35°: game.ts guardStops()).
 */
export function guardAim(out: SwordAim, angle: number, handed: 1 | -1 = 1): SwordAim {
  return guardAimDir(out, guardDir(angle, handed));
}

/** as guardAim, with the blade pointing exactly along `dir` (not a line) */
export function guardAimDir(out: SwordAim, dir: number): SwordAim {
  return setAim(out, 0.93 * Math.cos(dir), 0.93 * Math.sin(dir), 0.37, 0, 0, 1);
}

/** The sword on the swing's arc at swing angle ψ (see the top of the file). */
function arcAim(out: SwordAim, dir: number, psi: number): SwordAim {
  const ux = Math.cos(dir);
  const uy = Math.sin(dir);
  const c = Math.cos(psi);
  const s = Math.sin(psi);
  // the leading edge faces the way the blade is moving: d(blade)/dψ
  return setAim(out, -c * ux, -c * uy, s, s * ux, s * uy, c);
}

/**
 * Cocked for an attack (a CPU's windup, or a person about to swing): for a
 * slash the blade is drawn back on the side the cut starts from — overhead for a
 * chop, out to the left for a cut to the right — so bladeAngle = dir + π; for a
 * thrust it's pulled back pointing straight at the opponent.
 */
export function cockAim(out: SwordAim, a: SlashInput): SwordAim {
  if (a.kind === 'thrust') return setAim(out, 0, 0.1, 1, 0, -1, 0.1);
  return arcAim(out, a.dir, COCK_PSI);
}

/**
 * The strike: u = 0 cocked … `hit` (the contact, as a fraction of the strike)
 * with the blade crossing the opponent … 1 followed through. A thrust just
 * points at them (the arm's reach is the animator's).
 */
export function swingAim(out: SwordAim, a: SlashInput, u: number, hit = 0.5): SwordAim {
  if (a.kind === 'thrust') return setAim(out, 0, 0.04, 1, 0, -1, 0.04);
  let psi: number;
  if (u <= hit) psi = COCK_PSI + (Math.PI / 2 - COCK_PSI) * Math.max(0, u / hit);
  else {
    const k = Math.min(1, (u - hit) / (1 - hit));
    psi = Math.PI / 2 + (FOLLOW_PSI - Math.PI / 2) * (1 - (1 - k) * (1 - k));
  }
  return arcAim(out, a.dir, psi);
}

/** Where the blade goes after a cut is blocked: bounced back towards the side it came from, and up. */
export function reboundAim(out: SwordAim, a: SlashInput): SwordAim {
  if (a.kind === 'thrust') return setAim(out, 0, 0.75, 0.66, 0, -0.66, 0.75);
  return arcAim(out, a.dir, 0.35);
}

/** the view-plane size of the blade: ~0.9 held across (a guard, cocked), smaller pointing at the opponent */
export function aimSpread(a: SwordAim) {
  return Math.hypot(a.blade[0], a.blade[1]);
}
