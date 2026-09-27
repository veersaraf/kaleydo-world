// Arrow flight: gravity, a little air drag, and the wind as a sideways push
// that grows with it — integrated in short sub-steps (midpoint rule) whatever the
// frame rate, so a shot lands in the same place at 30 fps or 144. The arrow is
// tracked by its tip and always points along its velocity. Also the aim helpers:
// the sight line to a point, where a shot crosses a plane, and the aim that hits
// a point (the drop, and optionally the wind, allowed for) — used by the CPU, the
// keyboard/mouse fallback and the target layouts.
//
// Aim angles: yaw about +y (0 = straight down the range towards −z, + = turned to
// the archer's left, i.e. towards −x), pitch + = up. Direction:
//   (−sin yaw · cos pitch,  sin pitch,  −cos yaw · cos pitch)

import { RANGE } from './range';
import type { TargetDef } from './types';

export const FLIGHT = {
  /** quadratic air drag, 1/m (a = −k·|v|·v): a full-draw arrow keeps ~95% of its speed over 30 m */
  drag: 0.0017,
  /** the wind's sideways push, (m/s²) per (m/s) of wind: a 4 m/s wind drifts a 30 m shot ~0.4 m */
  windK: 0.5,
  /** longest integration sub-step, s */
  maxH: 1 / 240,
  /** the arrow, tip to nock (for drawing it) */
  length: 0.75,
  /** the tip at full draw (and so where a flight starts): this far along the aim from the eye — the bow at arm's length */
  bow: 0.7,
  /** a nocked arrow's tip sticks out this much further before the string is drawn */
  slide: 0.45,
  /** a stuck arrow's tip is this far past the point where it went in */
  bury: 0.08,
  /** a flight that hasn't met anything after this long (shot at the sky) is given up: lost */
  maxT: 3,
  /** the backstop: an arrow that flies past everything stops here (the back of the box, plus a margin) … */
  backZ: RANGE.minZ - 1.5,
  /** … or out to the side … */
  sideX: RANGE.halfX + 4,
  /** … if it's below this; one higher sails out of the stadium (lost, after maxT) */
  backTop: 12,
};

/** the aim's limits (a person's phone can point anywhere; the archer can't) */
export const AIM_LIMIT = { yaw: 1.2, pitchMin: -0.6, pitchMax: 1.0 };

/** where every archer stands (on the shooting line at x = 0) and the eye the aim is taken from */
export const EYE = { x: 0, y: RANGE.eyeY, z: RANGE.lineZ };

export interface Aim {
  yaw: number;
  pitch: number;
}

/** A flying arrow: its tip, velocity, and seconds since it left the bow. */
export interface Flight {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  t: number;
}

export const newFlight = (): Flight => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 });

/** unit direction of an aim */
export function aimDir(yaw: number, pitch: number, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
  const c = Math.cos(pitch);
  out.x = -Math.sin(yaw) * c;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * c;
  return out;
}

/** a flight leaving the bow: the tip at the bow (FLIGHT.bow along the aim from the eye), at `speed` along the aim */
export function launch(out: Flight, yaw: number, pitch: number, speed: number) {
  const c = Math.cos(pitch);
  const dx = -Math.sin(yaw) * c;
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * c;
  out.x = EYE.x + dx * FLIGHT.bow;
  out.y = EYE.y + dy * FLIGHT.bow;
  out.z = EYE.z + dz * FLIGHT.bow;
  out.vx = dx * speed;
  out.vy = dy * speed;
  out.vz = dz * speed;
  out.t = 0;
  return out;
}

/** one sub-step of h seconds (the midpoint rule: second-order, and no allocation) */
export function advance(f: Flight, h: number, wind: number) {
  const k = FLIGHT.drag;
  const g = RANGE.gravity;
  const aw = FLIGHT.windK * wind;
  let s = Math.hypot(f.vx, f.vy, f.vz);
  const mx = f.vx + 0.5 * h * (aw - k * s * f.vx);
  const my = f.vy + 0.5 * h * (-g - k * s * f.vy);
  const mz = f.vz + 0.5 * h * (-k * s * f.vz);
  s = Math.hypot(mx, my, mz);
  f.x += mx * h;
  f.y += my * h;
  f.z += mz * h;
  f.vx += h * (aw - k * s * mx);
  f.vy += h * (-g - k * s * my);
  f.vz += h * (-k * s * mz);
  f.t += h;
}

/** the straight line from the eye to a point (a no-gravity aim: what a reticle on it covers) */
export function sightTo(x: number, y: number, z: number, out: Aim = { yaw: 0, pitch: 0 }): Aim {
  const dx = x - EYE.x;
  const dy = y - EYE.y;
  const dz = z - EYE.z;
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return out;
}

export interface Crossing {
  x: number;
  y: number;
  /** flight time to the plane, s */
  t: number;
  /** false: it never got there (fell short — even below the ground — or went the wrong way) */
  ok: boolean;
  /** speed on arrival */
  speed: number;
}

const tmpF = newFlight();
const tmpP = newFlight();

/**
 * Where a shot crosses the plane z = `z` (nothing in the way: no targets, and
 * the ground ignored, so a point below it can still be solved for).
 */
export function flyTo(yaw: number, pitch: number, speed: number, z: number, wind = 0, out: Crossing = { x: 0, y: 0, t: 0, ok: false, speed: 0 }): Crossing {
  const f = launch(tmpF, yaw, pitch, speed);
  const p = tmpP;
  out.ok = false;
  if (f.z <= z) {
    out.x = f.x;
    out.y = f.y;
    out.t = 0;
    out.speed = speed;
    out.ok = true;
    return out;
  }
  const h = FLIGHT.maxH;
  while (f.t < 2 * FLIGHT.maxT && f.vz < 0 && f.y > -60) {
    p.x = f.x;
    p.y = f.y;
    p.z = f.z;
    p.t = f.t;
    advance(f, h, wind);
    if (f.z <= z) {
      const u = (p.z - z) / (p.z - f.z);
      out.x = p.x + (f.x - p.x) * u;
      out.y = p.y + (f.y - p.y) * u;
      out.t = p.t + h * u;
      out.speed = Math.hypot(f.vx, f.vy, f.vz);
      out.ok = true;
      return out;
    }
  }
  out.x = f.x;
  out.y = f.y;
  out.t = f.t;
  out.speed = Math.hypot(f.vx, f.vy, f.vz);
  return out;
}

const cross: Crossing = { x: 0, y: 0, t: 0, ok: false, speed: 0 };

export const clampAim = (a: Aim) => {
  a.yaw = Math.max(-AIM_LIMIT.yaw, Math.min(AIM_LIMIT.yaw, a.yaw));
  a.pitch = Math.max(AIM_LIMIT.pitchMin, Math.min(AIM_LIMIT.pitchMax, a.pitch));
  return a;
};

/**
 * The aim (yaw, pitch) whose arrow passes through the point (x, y, z): the drop
 * allowed for, and the wind if one is given (m/s, + = blowing to +x). Newton's
 * method on the real flight, a few iterations (tens of µs). A point out of reach
 * at that speed gets the best try (the steepest aim allowed).
 */
export function aimFor(x: number, y: number, z: number, speed: number = RANGE.fullSpeed, wind = 0, out: Aim = { yaw: 0, pitch: 0 }): Aim {
  sightTo(x, y, z, out);
  const dz = Math.max(0.5, EYE.z - z);
  for (let i = 0; i < 12; i++) {
    const r = flyTo(out.yaw, out.pitch, speed, z, wind, cross);
    if (!r.ok) {
      // fell short: lob it (unless it can't go any higher)
      if (out.pitch >= AIM_LIMIT.pitchMax) break;
      out.pitch = Math.min(AIM_LIMIT.pitchMax, out.pitch + 0.15);
      continue;
    }
    const ex = x - r.x;
    const ey = y - r.y;
    if (Math.abs(ex) < 2e-4 && Math.abs(ey) < 2e-4) break;
    const cy = Math.cos(out.yaw);
    const cp = Math.cos(out.pitch);
    const reach = dz / cy;
    out.pitch += Math.max(-0.3, Math.min(0.3, (ey * cp * cp) / reach));
    out.yaw += Math.max(-0.3, Math.min(0.3, (-ex * cy * cy) / dz));
    clampAim(out);
  }
  return out;
}

/** a target's centre x at `since` seconds into its end (the sideways sway; still targets don't move) */
export function targetX(def: TargetDef, since: number) {
  return def.swayX && def.swayT > 0 ? def.x + def.swayX * Math.sin((2 * Math.PI * since) / def.swayT) : def.x;
}

/** where the segment p0→p1 first enters a sphere, as a fraction 0..1 of the way (−1 = it doesn't; 0 = it starts inside) */
export function segSphere(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cx: number, cy: number, cz: number, r: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const fz = z0 - cz;
  const c = fx * fx + fy * fy + fz * fz - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return -1;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  if (b >= 0) return -1; // heading away
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const s = (-b - Math.sqrt(disc)) / (2 * a);
  return s <= 1 ? s : -1;
}
