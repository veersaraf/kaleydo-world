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

  /**
   * "I'm facing the screen right now." The phone's top points at it when it's
   * held flat or to be looked at; held upright (a sword's hilt, the screen to
   * your face) it's the back of the phone that does — so the two are added:
   * whichever way it's held between those, both lean towards the screen.
   */
  calibrate() {
    if (!this.have) return false;
    const f = this.facing();
    if (!f) return false; // lying face down, or the screen facing away: ambiguous
    this.heading = Math.atan2(f[0], f[1]);
    return true;
  }

  /** the horizontal direction the phone says the player faces (earth frame), or null */
  private facing(): [number, number] | null {
    const top = this.toEarth([0, 1, 0]);
    const back = this.toEarth([0, 0, -1]);
    const x = top[0] + back[0],
      y = top[1] + back[1];
    return Math.hypot(x, y) < 0.3 ? null : [x, y];
  }

  /**
   * Keep "towards the screen" honest while playing (the sword duel): whenever
   * the phone is held still and faces within ~35° of the calibrated heading,
   * drift the heading a little towards it (a time constant of `tau` s). A
   * guard held across the body faces the same way (its back to the screen), so
   * it doesn't pull; a heading that was off, or has drifted, comes right.
   */
  autoCenter(dt: number, tau = 6) {
    if (!this.have || this.heading === null || this.spin > 1.2) return;
    const f = this.facing();
    if (!f) return;
    let d = Math.atan2(f[0], f[1]) - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.6) return;
    this.heading += d * Math.min(1, dt / tau);
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

// ---------------------------------------------------------------- gyro axes

/**
 * Which device axis each of DeviceMotionEvent.rotationRate's alpha, beta and
 * gamma is about. Documentation disagrees: MDN (and the code here, until now)
 * says alpha is about z, beta x, gamma y — 'zxy' — while WebKit and Chromium
 * appear to hand the gyro's x, y, z over as alpha, beta, gamma — 'xyz' (a
 * capture, scripts/replay-capture.ts, prints which one a phone uses). Get it
 * wrong and every swing is read about the wrong axes (a sideways cut becomes a
 * twist, a chop a sideways cut) and the orientation, integrated from the gyro
 * mid-swing, wanders off. Rather than trust either, this watches the OS's own
 * orientation (deviceorientation) turn and picks whichever mapping of the
 * three rates (any order and signs that make a rotation) turns the same way;
 * a few seconds of handling the phone settle it. Until then it assumes 'xyz'.
 */
export class GyroAxes {
  /** device axis i = sign[i] · raw[src[i]] (raw = alpha, beta, gamma) */
  src: [number, number, number] = [0, 1, 2];
  sign: [number, number, number] = [1, 1, 1];
  /** set once the evidence settled it */
  sure = false;
  /** the mapping's name, for logs ('xyz' = alpha x, beta y, gamma z) */
  name = 'xyz';
  private M = new Float64Array(9); // Σ (OS rotation)_i · (gyro rotation)_j
  private eo = 0; // Σ |OS rotation|²
  private eg = 0;
  private q0: Quat | null = null;
  private t0 = 0;
  private acc: Vec3 = [0, 0, 0];

  /** raw rates (deg/s, as the event has them) → device-axis rad/s */
  map(alpha: number, beta: number, gamma: number): Vec3 {
    const r = [alpha, beta, gamma];
    const k = Math.PI / 180;
    return [this.sign[0] * r[this.src[0]] * k, this.sign[1] * r[this.src[1]] * k, this.sign[2] * r[this.src[2]] * k];
  }

  /** a motion event's raw rates over dt s (what the gyro says the phone turned) */
  motion(alpha: number, beta: number, gamma: number, dt: number) {
    const k = (Math.PI / 180) * dt;
    this.acc[0] += alpha * k;
    this.acc[1] += beta * k;
    this.acc[2] += gamma * k;
  }

  /** the OS's orientation (device → earth) arrived at time t (ms) */
  orient(q: Quat, t: number) {
    if (!this.q0 || t - this.t0 > 400) {
      this.restart(q, t);
      return;
    }
    if (t - this.t0 < 90) return;
    // how the OS says the phone turned since the window began, in its own axes
    let d = qmul(qconj(this.q0), q);
    if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
    const s = Math.hypot(d[0], d[1], d[2]);
    const ang = 2 * Math.atan2(s, d[3]);
    const g = this.acc;
    const gl = Math.hypot(g[0], g[1], g[2]);
    this.restart(q, t);
    // too little to tell apart from noise, or so much the OS's lag muddles it
    if (ang < 0.04 || ang > 1.5 || gl < 0.02) return;
    const o: Vec3 = [(d[0] / s) * ang, (d[1] / s) * ang, (d[2] / s) * ang];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.M[i * 3 + j] += o[i] * g[j];
    this.eo += ang * ang;
    this.eg += gl * gl;
    this.decide();
  }

  private restart(q: Quat, t: number) {
    this.q0 = q;
    this.t0 = t;
    this.acc = [0, 0, 0];
  }

  /** the signed permutation that best turns the gyro's rotations into the OS's */
  private decide() {
    const norm = Math.sqrt(this.eo * this.eg);
    if (this.eo < 0.25 || norm < 1e-9) return;
    let best = -Infinity,
      second = -Infinity;
    let bs: [number, number, number] = this.src,
      bg: [number, number, number] = this.sign;
    for (const p of PERMS) {
      // (only the 24 that are rotations: a mirror image can't be how a gyro is mounted)
      const odd = (p[0] === 0 ? p[1] !== 1 : p[0] === 1 ? p[1] !== 2 : p[1] !== 0) ? 1 : 0;
      for (let m = 0; m < 8; m++) {
        const sg: [number, number, number] = [m & 1 ? -1 : 1, m & 2 ? -1 : 1, m & 4 ? -1 : 1];
        const flips = (m & 1 ? 1 : 0) + (m & 2 ? 1 : 0) + (m & 4 ? 1 : 0);
        if ((flips + odd) % 2) continue;
        const sc = (sg[0] * this.M[p[0]] + sg[1] * this.M[3 + p[1]] + sg[2] * this.M[6 + p[2]]) / norm;
        if (sc > best) {
          second = best;
          best = sc;
          bs = p;
          bg = sg;
        } else if (sc > second) second = sc;
      }
    }
    if (best > 0.6 && best - second > 0.25) {
      this.src = [bs[0], bs[1], bs[2]];
      this.sign = bg;
      this.sure = true;
      const ax = 'xyz';
      const n = ['alpha', 'beta', 'gamma'];
      this.name = [0, 1, 2].map((i) => `${bg[i] < 0 ? '-' : ''}${n[bs[i]]}→${ax[i]}`).join(' ');
      if (bs[0] === 0 && bs[1] === 1 && bs[2] === 2 && bg.every((v) => v > 0)) this.name = 'xyz';
      else if (bs[0] === 1 && bs[1] === 2 && bs[2] === 0 && bg.every((v) => v > 0)) this.name = 'zxy'; // alpha about z, beta x, gamma y
    }
    // old evidence fades slowly: a mistake early on can't stick forever
    if (this.eo > 40) {
      for (let i = 0; i < 9; i++) this.M[i] *= 0.5;
      this.eo *= 0.5;
      this.eg *= 0.5;
    }
  }
}

const PERMS: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
