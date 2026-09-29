// The remote's sensor front end: raw DeviceMotion / DeviceOrientation events in,
// device-axis angular velocity and a fused orientation out, ready for the swing
// detectors. main.ts feeds it the live events; the capture recorder
// (capture.ts) and the offline replay (scripts/replay-capture.ts) feed it the
// same events from a recording, so a capture replays exactly as it played.
//
// A sensor delivers 60–100 motion events a second, and on an iPhone a garbage
// collection pause in the page drops events (and leaves the swing's age stale). So
// nothing here allocates per event: the front end refills one Motion, and the
// sample builders below refill the objects they are given.

import type { BowlSample } from './bowl';
import { GyroAxes, Orientation, quatFromEulerInto, type Vec3 } from './orient';
import type { SwordSample } from './sword';
import type { MotionSample } from './swing';

type Quat = [number, number, number, number];

/** One devicemotion event, as the browser gave it (a recording's line has the same fields). */
export interface RawMotion {
  /** performance.now() when the handler ran, ms */
  t: number;
  /** rotationRate, deg/s */
  ra: number | null;
  rb: number | null;
  rg: number | null;
  /** acceleration (no gravity), m/s², if reported */
  ax?: number | null;
  ay?: number | null;
  az?: number | null;
  /** accelerationIncludingGravity, m/s², if reported */
  gx?: number | null;
  gy?: number | null;
  gz?: number | null;
}

/** One deviceorientation event, degrees. */
export interface RawOrient {
  t: number;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}

/** A motion event, processed. */
export interface Motion {
  t: number;
  dt: number;
  /** angular velocity, device axes, rad/s */
  rx: number;
  ry: number;
  rz: number;
  /** the fused orientation (device → earth), once known */
  q: Quat | undefined;
  /** the accelerations as reported (0 when missing), and whether they were */
  ax: number;
  ay: number;
  az: number;
  hasAcc: boolean;
  igx: number;
  igy: number;
  igz: number;
  hasIg: boolean;
}

export class MotionFront {
  readonly orient = new Orientation();
  readonly axes = new GyroAxes();
  private lastT = 0;
  private prev: [number, number, number] = [0, 0, 0];
  // (scratch, and the one Motion every event refills)
  private readonly rate: Vec3 = [0, 0, 0];
  private readonly eq: Quat = [0, 0, 0, 1];
  private readonly out: Motion = {
    t: 0,
    dt: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    q: undefined,
    ax: 0,
    ay: 0,
    az: 0,
    hasAcc: false,
    igx: 0,
    igy: 0,
    igz: 0,
    hasIg: false,
  };
  private readonly outQ: Quat = [0, 0, 0, 1];

  /** a deviceorientation event */
  orientEvent(o: RawOrient) {
    this.orient.measure(o.alpha, o.beta, o.gamma, o.t);
    if (o.beta != null && o.gamma != null) this.axes.orient(quatFromEulerInto(this.eq, o.alpha ?? 0, o.beta, o.gamma), o.t);
  }

  /**
   * A devicemotion event (null: it carried no rotation rate). The Motion returned is the same
   * object every time, refilled: it (and its q) is good until the next call, so read it, don't
   * keep it.
   */
  motionEvent(m: RawMotion): Motion | null {
    if (m.ra == null && m.rb == null) return null;
    const ra = m.ra ?? 0,
      rb = m.rb ?? 0,
      rg = m.rg ?? 0;
    const dt = this.lastT ? Math.min(0.05, Math.max(0, (m.t - this.lastT) / 1000)) : 1 / 60;
    this.lastT = m.t;
    this.axes.motion(ra, rb, rg, dt);
    const r = this.axes.mapInto(this.rate, ra, rb, rg);
    const rx = r[0],
      ry = r[1],
      rz = r[2];
    // trapezoidal: the rate over the interval is the mean of its two ends (a one-sided
    // sum runs a whole sample ahead — ~15° at the peak of a hard swing)
    const p = this.prev;
    this.orient.integrate((rx + p[0]) / 2, (ry + p[1]) / 2, (rz + p[2]) / 2, dt);
    p[0] = rx;
    p[1] = ry;
    p[2] = rz;
    const o = this.orient;
    const out = this.out;
    out.t = m.t;
    out.dt = dt;
    out.rx = rx;
    out.ry = ry;
    out.rz = rz;
    if (o.have) {
      const q = this.outQ;
      q[0] = o.q[0];
      q[1] = o.q[1];
      q[2] = o.q[2];
      q[3] = o.q[3];
      out.q = q;
    } else out.q = undefined;
    out.hasAcc = m.ax != null;
    out.hasIg = m.gx != null;
    out.ax = m.ax ?? 0;
    out.ay = m.ay ?? 0;
    out.az = m.az ?? 0;
    out.igx = m.gx ?? 0;
    out.igy = m.gy ?? 0;
    out.igz = m.gz ?? 0;
    return out;
  }
}

/**
 * What the sword detector gets from a motion event. Pass `out` to have it filled in place (the
 * detector copies what it needs and keeps no reference to the sample).
 */
export function swordSample(m: Motion, out: SwordSample = { t: 0, rx: 0, ry: 0, rz: 0 }): SwordSample {
  out.t = m.t;
  out.rx = m.rx;
  out.ry = m.ry;
  out.rz = m.rz;
  out.q = m.q;
  out.ax = m.hasAcc ? m.ax : undefined;
  out.ay = m.hasAcc ? m.ay : undefined;
  out.az = m.hasAcc ? m.az : undefined;
  out.igx = m.hasIg ? m.igx : undefined;
  out.igy = m.hasIg ? m.igy : undefined;
  out.igz = m.hasIg ? m.igz : undefined;
  return out;
}

/** What the bowling detector gets from a motion event (`out`: filled in place, as for swordSample). */
export function bowlSample(m: Motion, out: BowlSample = { t: 0, rx: 0, ry: 0, rz: 0 }): BowlSample {
  out.t = m.t;
  out.rx = m.rx;
  out.ry = m.ry;
  out.rz = m.rz;
  out.q = m.q;
  // (the acceleration only if the phone reports it: some Androids don't)
  const acc = m.hasAcc && m.hasIg;
  out.ax = acc ? m.ax : undefined;
  out.ay = acc ? m.ay : undefined;
  out.az = acc ? m.az : undefined;
  out.gx = acc ? m.igx - m.ax : undefined;
  out.gy = acc ? m.igy - m.ay : undefined;
  out.gz = acc ? m.igz - m.az : undefined;
  return out;
}

/**
 * What the tennis swing detector gets from a motion event. Pass `out` to have it filled in place
 * (the detector copies what it needs and keeps no reference to the sample or its arrays; the `up`
 * vector is the sample's own, refilled).
 */
export function swingSample(m: Motion, o: Orientation, out?: MotionSample): MotionSample {
  const s = out ?? { t: 0, up: undefined, q: undefined, rx: 0, ry: 0, rz: 0, ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
  s.t = m.t;
  if (o.have) s.up = o.upDeviceInto(s.up ?? [0, 0, 0]);
  else s.up = undefined;
  s.q = m.q;
  s.rx = m.rx;
  s.ry = m.ry;
  s.rz = m.rz;
  s.ax = m.ax;
  s.ay = m.ay;
  s.az = m.az;
  s.gx = m.igx - m.ax;
  s.gy = m.igy - m.ay;
  s.gz = m.igz - m.az;
  return s;
}

/** a DeviceMotionEvent → RawMotion (`out`: filled in place, for one object per sample) */
export function rawMotion(e: DeviceMotionEvent, t: number, out: RawMotion = { t: 0, ra: null, rb: null, rg: null }): RawMotion {
  const r = e.rotationRate,
    a = e.acceleration,
    g = e.accelerationIncludingGravity;
  out.t = t;
  out.ra = r?.alpha ?? null;
  out.rb = r?.beta ?? null;
  out.rg = r?.gamma ?? null;
  out.ax = a?.x ?? null;
  out.ay = a?.y ?? null;
  out.az = a?.z ?? null;
  out.gx = g?.x ?? null;
  out.gy = g?.y ?? null;
  out.gz = g?.z ?? null;
  return out;
}
