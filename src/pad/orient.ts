// Phone orientation, calibrated to face the TV.
//
// We keep our own quaternion: the gyroscope is integrated on every motion
// sample (low latency, smooth during fast swings) and gently pulled towards
// the operating system's fused orientation whenever a deviceorientation event
// arrives (no drift). "Player frame" = x right, y towards the screen, z up.

export type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // x y z w

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** rotate v by q */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

function qconj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s,
    wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/** W3C device orientation (intrinsic Z-X'-Y'') → quaternion (device → earth). */
export function quatFromEuler(alphaDeg: number, betaDeg: number, gammaDeg: number): Quat {
  const d = Math.PI / 360;
  const cZ = Math.cos(alphaDeg * d),
    sZ = Math.sin(alphaDeg * d);
  const cX = Math.cos(betaDeg * d),
    sX = Math.sin(betaDeg * d);
  const cY = Math.cos(gammaDeg * d),
    sY = Math.sin(gammaDeg * d);
  return [sX * cY * cZ - cX * sY * sZ, cX * sY * cZ + sX * cY * sZ, cX * cY * sZ + sX * sY * cZ, cX * cY * cZ - sX * sY * sZ];
}

export class Orientation {
  q: Quat = [0, 0, 0, 1];
  have = false;
  /** heading (radians) of "towards the screen" in the earth frame */
  heading: number | null = null;
  lastEvent = 0;
  /** smoothed angular speed, rad/s */
  private spin = 0;

  /** OS-fused orientation arrived. */
  measure(alpha: number | null, beta: number | null, gamma: number | null, t: number) {
    if (beta == null || gamma == null) return;
    const m = quatFromEuler(alpha ?? 0, beta, gamma);
    // The OS reading arrives a frame or two late. At rest that doesn't matter and
    // it cancels gyro drift; mid-swing (15+ rad/s) even 20 ms of lag is 20°+, so
    // during fast motion trust the gyro almost completely.
    const k = this.spin < 2 ? 0.2 : this.spin > 6 ? 0.01 : 0.2 - ((this.spin - 2) / 4) * 0.19;
    this.q = this.have ? qnorm(slerp(this.q, m, k)) : m;
    this.have = true;
    this.lastEvent = t;
  }

  /** Integrate body-frame angular velocity (rad/s) over dt seconds. */
  integrate(wx: number, wy: number, wz: number, dt: number) {
    const w = Math.hypot(wx, wy, wz);
    // rise instantly, settle over ~150 ms so the filter stays gyro-led through the follow-through
    this.spin = w > this.spin ? w : this.spin + (w - this.spin) * Math.min(1, dt / 0.15);
    if (!this.have) return;
    // exact rotation for this step (the small-angle form skews at 1000°/s)
    const a = w * dt;
    if (a < 1e-9) return;
    const s = Math.sin(a / 2) / w;
    this.q = qnorm(qmul(this.q, [wx * s, wy * s, wz * s, Math.cos(a / 2)]));
  }

  /** true up, expressed in device coordinates */
  upDevice(): Vec3 {
    return qrot(qconj(this.q), [0, 0, 1]);
  }

  toEarth(v: Vec3): Vec3 {
    return qrot(this.q, v);
  }

  /** "The top of the phone is pointing at the screen right now." */
  calibrate() {
    if (!this.have) return false;
    const f = this.toEarth([0, 1, 0]);
    if (Math.hypot(f[0], f[1]) < 0.2) return false; // pointing straight up/down: ambiguous
    this.heading = Math.atan2(f[0], f[1]);
    return true;
  }

  /** earth → player frame (x right, y towards screen, z up) */
  toPlayer(v: Vec3): Vec3 {
    const h = this.heading ?? 0;
    const fx = Math.sin(h),
      fy = Math.cos(h);
    return [v[0] * fy - v[1] * fx, v[0] * fx + v[1] * fy, v[2]];
  }

  /** device vector → player frame */
  devToPlayer(v: Vec3): Vec3 {
    return this.toPlayer(this.toEarth(v));
  }
}
