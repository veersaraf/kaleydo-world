// Ball flight in closed form.
//
// dv/dt = g_vec - k v  (linear drag) has an exact solution, so the ball's
// position at any future time is a formula, not a simulation. The AI, the
// auto-movement and the shot solver all use the same equations, which means
// predictions are exact and the ball lands precisely where a shot aimed it.

import { COURT } from './court';
import type { V3 } from '../core/math';

export interface Seg {
  t0: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** effective gravity (spin changes it: topspin dips, slice floats) */
  g: number;
  /** linear drag coefficient, 1/s */
  k: number;
  /** -1 slice … +1 topspin; used for bounce behaviour and visuals */
  spin: number;
  /** base gravity of the world this flight started in (spin-free) */
  g0?: number;
}

export const E = (k: number, tau: number) => (k > 1e-6 ? (1 - Math.exp(-k * tau)) / k : tau);

export function segPos(s: Seg, t: number, out: V3): V3 {
  const tau = Math.max(0, t - s.t0);
  const e = E(s.k, tau);
  out.x = s.px + s.vx * e;
  out.z = s.pz + s.vz * e;
  if (s.k > 1e-6) {
    const gk = s.g / s.k;
    out.y = s.py + (s.vy + gk) * e - gk * tau;
  } else {
    out.y = s.py + s.vy * tau - 0.5 * s.g * tau * tau;
  }
  return out;
}

export function segVel(s: Seg, t: number, out: V3): V3 {
  const tau = Math.max(0, t - s.t0);
  const d = Math.exp(-s.k * tau);
  out.x = s.vx * d;
  out.z = s.vz * d;
  if (s.k > 1e-6) {
    const gk = s.g / s.k;
    out.y = (s.vy + gk) * d - gk;
  } else {
    out.y = s.vy - s.g * tau;
  }
  return out;
}

const tmp: V3 = { x: 0, y: 0, z: 0 };

/** Time of apex (absolute), or t0 if already descending. */
export function segApexT(s: Seg): number {
  if (s.vy <= 0) return s.t0;
  if (s.k > 1e-6) return s.t0 + Math.log(1 + (s.vy * s.k) / s.g) / s.k;
  return s.t0 + s.vy / s.g;
}

export function segApexY(s: Seg): number {
  return segPos(s, segApexT(s), tmp).y;
}

/** Absolute time when the ball centre descends through height y (after tMin). */
export function segTimeDown(s: Seg, y: number, tMin = s.t0): number | null {
  const a = Math.max(tMin, segApexT(s));
  if (segPos(s, a, tmp).y < y) {
    // already below at the apex (or tMin); only valid if we're exactly there
    return segPos(s, tMin, tmp).y >= y ? tMin : null;
  }
  let lo = a;
  let hi = a + 0.5;
  let guard = 0;
  while (segPos(s, hi, tmp).y > y && guard++ < 30) hi = a + (hi - a) * 2;
  if (guard >= 30) return null;
  for (let i = 0; i < 44; i++) {
    const m = (lo + hi) * 0.5;
    if (segPos(s, m, tmp).y > y) lo = m;
    else hi = m;
  }
  return (lo + hi) * 0.5;
}

/** Absolute time when the ball reaches z (or null if it never will). */
export function segTimeAtZ(s: Seg, z: number): number | null {
  if (Math.abs(s.vz) < 1e-6) return null;
  const D = (z - s.pz) / s.vz;
  if (D < 0) return null;
  if (s.k > 1e-6) {
    const q = 1 - s.k * D;
    if (q <= 1e-6) return null;
    return s.t0 - Math.log(q) / s.k;
  }
  return s.t0 + D;
}

export interface BounceModel {
  /** vertical restitution */
  e: number;
  /** horizontal speed kept */
  f: number;
}

export function bounceModel(spin: number, surface = 1): BounceModel {
  // topspin kicks up and forward, slice skids low
  const e = (0.69 + 0.06 * Math.max(0, spin) - 0.1 * Math.max(0, -spin)) * surface;
  const f = 0.79 + 0.08 * Math.max(0, spin) - 0.06 * Math.max(0, -spin);
  return { e, f };
}

/** New segment starting at a bounce. */
export function bounceSeg(s: Seg, tb: number, surface = 1): Seg {
  const p = segPos(s, tb, { x: 0, y: 0, z: 0 });
  const v = segVel(s, tb, { x: 0, y: 0, z: 0 });
  const m = bounceModel(s.spin, surface);
  const spin = s.spin * 0.45;
  return {
    t0: tb,
    px: p.x,
    py: COURT.ballR,
    pz: p.z,
    vx: v.x * m.f,
    vy: Math.abs(v.y) * m.e,
    vz: v.z * m.f,
    g: (s.g0 ?? COURT.gravity) * (1 + 0.25 * spin),
    k: s.k,
    spin,
    g0: s.g0 ?? COURT.gravity,
  };
}

/**
 * Solve for the launch velocity that takes the ball from `from` to land at
 * (tx, tz) after `T` seconds under the given gravity/drag.
 */
export function solveLaunch(from: V3, tx: number, tz: number, T: number, g: number, k: number, ty = COURT.ballR): V3 {
  const e = E(k, T);
  const vx = (tx - from.x) / e;
  const vz = (tz - from.z) / e;
  let vy: number;
  if (k > 1e-6) {
    const gk = g / k;
    vy = (ty - from.y + gk * T) / e - gk;
  } else {
    vy = (ty - from.y + 0.5 * g * T * T) / T;
  }
  return { x: vx, y: vy, z: vz };
}

/** Flight time for a desired initial horizontal speed over distance d. */
export function flightTimeFor(d: number, speed: number, k: number): number {
  if (k < 1e-6) return d / speed;
  const q = 1 - (k * d) / speed;
  if (q <= 0.05) return -Math.log(0.05) / k;
  return -Math.log(q) / k;
}

export interface PathSample {
  t: number;
  x: number;
  y: number;
  z: number;
  bounces: number;
}

/**
 * Predict the ball's future path through up to `maxBounces` bounces.
 * Returns samples every `dt` seconds from `from` to `from + span`.
 */
export function predictPath(seg: Seg, from: number, span: number, dt: number, maxBounces = 2, out: PathSample[] = []): PathSample[] {
  out.length = 0;
  let s = seg;
  let bounces = 0;
  let nextBounce = segTimeDown(s, COURT.ballR, Math.max(from, s.t0));
  const p: V3 = { x: 0, y: 0, z: 0 };
  for (let t = from; t <= from + span; t += dt) {
    while (nextBounce !== null && t >= nextBounce) {
      bounces++;
      if (bounces > maxBounces) return out;
      s = bounceSeg(s, nextBounce);
      nextBounce = segTimeDown(s, COURT.ballR, s.t0 + 1e-3);
    }
    segPos(s, t, p);
    out.push({ t, x: p.x, y: p.y, z: p.z, bounces });
  }
  return out;
}

/** First bounce point of a segment (no net check). */
export function firstBounce(seg: Seg): { t: number; x: number; z: number } | null {
  const t = segTimeDown(seg, COURT.ballR, seg.t0 + 1e-3);
  if (t === null) return null;
  const p = segPos(seg, t, { x: 0, y: 0, z: 0 });
  return { t, x: p.x, z: p.z };
}
