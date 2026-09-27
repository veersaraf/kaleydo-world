// The remote's sensor front end: raw DeviceMotion / DeviceOrientation events in,
// device-axis angular velocity and a fused orientation out, ready for the swing
// detectors. main.ts feeds it the live events; the capture recorder
// (capture.ts) and the offline replay (scripts/replay-capture.ts) feed it the
// same events from a recording, so a capture replays exactly as it played.

import { GyroAxes, Orientation, quatFromEuler } from './orient';
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

  /** a deviceorientation event */
  orientEvent(o: RawOrient) {
    this.orient.measure(o.alpha, o.beta, o.gamma, o.t);
    if (o.beta != null && o.gamma != null) this.axes.orient(quatFromEuler(o.alpha ?? 0, o.beta, o.gamma), o.t);
  }

  /** a devicemotion event (null: it carried no rotation rate) */
  motionEvent(m: RawMotion): Motion | null {
    if (m.ra == null && m.rb == null) return null;
    const ra = m.ra ?? 0,
      rb = m.rb ?? 0,
      rg = m.rg ?? 0;
    const dt = this.lastT ? Math.min(0.05, Math.max(0, (m.t - this.lastT) / 1000)) : 1 / 60;
    this.lastT = m.t;
    this.axes.motion(ra, rb, rg, dt);
    const [rx, ry, rz] = this.axes.map(ra, rb, rg);
    // trapezoidal: the rate over the interval is the mean of its two ends (a one-sided
    // sum runs a whole sample ahead — ~15° at the peak of a hard swing)
    const p = this.prev;
    this.orient.integrate((rx + p[0]) / 2, (ry + p[1]) / 2, (rz + p[2]) / 2, dt);
    p[0] = rx;
    p[1] = ry;
    p[2] = rz;
    const o = this.orient;
    const hasAcc = m.ax != null;
    const hasIg = m.gx != null;
    return {
      t: m.t,
      dt,
      rx,
      ry,
      rz,
      q: o.have ? [o.q[0], o.q[1], o.q[2], o.q[3]] : undefined,
      ax: m.ax ?? 0,
      ay: m.ay ?? 0,
      az: m.az ?? 0,
      hasAcc,
      igx: m.gx ?? 0,
      igy: m.gy ?? 0,
      igz: m.gz ?? 0,
      hasIg,
    };
  }
}

/** what the sword detector gets from a motion event */
export function swordSample(m: Motion): SwordSample {
  return {
    t: m.t,
    rx: m.rx,
    ry: m.ry,
    rz: m.rz,
    q: m.q,
    ...(m.hasAcc ? { ax: m.ax, ay: m.ay, az: m.az } : {}),
    ...(m.hasIg ? { igx: m.igx, igy: m.igy, igz: m.igz } : {}),
  };
}

/** what the tennis swing detector gets from a motion event */
export function swingSample(m: Motion, o: Orientation): MotionSample {
  return {
    t: m.t,
    up: o.have ? o.upDevice() : undefined,
    q: m.q,
    rx: m.rx,
    ry: m.ry,
    rz: m.rz,
    ax: m.ax,
    ay: m.ay,
    az: m.az,
    gx: m.igx - m.ax,
    gy: m.igy - m.ay,
    gz: m.igz - m.az,
  };
}

/** a DeviceMotionEvent → RawMotion */
export function rawMotion(e: DeviceMotionEvent, t: number): RawMotion {
  const r = e.rotationRate,
    a = e.acceleration,
    g = e.accelerationIncludingGravity;
  return {
    t,
    ra: r?.alpha ?? null,
    rb: r?.beta ?? null,
    rg: r?.gamma ?? null,
    ax: a?.x ?? null,
    ay: a?.y ?? null,
    az: a?.z ?? null,
    gx: g?.x ?? null,
    gy: g?.y ?? null,
    gz: g?.z ?? null,
  };
}
