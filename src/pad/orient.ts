// Phone orientation, calibrated to face the TV.
//
// We keep our own quaternion: the gyroscope is integrated on every motion
// sample (low latency, smooth during fast swings) and gently pulled towards
// the operating system's fused orientation whenever a deviceorientation event
// arrives (no drift). "Player frame" = x right, y towards the screen, z up.

export type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // x y z w

/** rotate v by q */
export function qrot(q: Quat, v: Vec3): Vec3 {
  return qrotInto([0, 0, 0], q[0], q[1], q[2], q[3], v[0], v[1], v[2]);
}

/** rotate (v0, v1, v2) by the quaternion (x, y, z, w) into out (no allocation) */
function qrotInto(out: Vec3, x: number, y: number, z: number, w: number, v0: number, v1: number, v2: number): Vec3 {
  const ix = w * v0 + y * v2 - z * v1;
  const iy = w * v1 + z * v0 - x * v2;
  const iz = w * v2 + x * v1 - y * v0;
  const iw = -x * v0 - y * v1 - z * v2;
  out[0] = ix * w + iw * -x + iy * -z - iz * -y;
  out[1] = iy * w + iw * -y + iz * -x - ix * -z;
  out[2] = iz * w + iw * -z + ix * -y - iy * -x;
  return out;
}

function qconj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** W3C device orientation (intrinsic Z-X'-Y'') → quaternion (device → earth). */
export function quatFromEuler(alphaDeg: number, betaDeg: number, gammaDeg: number): Quat {
  return quatFromEulerInto([0, 0, 0, 1], alphaDeg, betaDeg, gammaDeg);
}

/** quatFromEuler into out (no allocation) */
export function quatFromEulerInto(out: Quat, alphaDeg: number, betaDeg: number, gammaDeg: number): Quat {
  const d = Math.PI / 360;
  const cZ = Math.cos(alphaDeg * d),
    sZ = Math.sin(alphaDeg * d);
  const cX = Math.cos(betaDeg * d),
    sX = Math.sin(betaDeg * d);
  const cY = Math.cos(gammaDeg * d),
    sY = Math.sin(gammaDeg * d);
  out[0] = sX * cY * cZ - cX * sY * sZ;
  out[1] = cX * sY * cZ + sX * cY * sZ;
  out[2] = cX * cY * sZ + sX * sY * cZ;
  out[3] = cX * cY * cZ - sX * sY * sZ;
  return out;
}

export class Orientation {
  q: Quat = [0, 0, 0, 1];
  have = false;
  /** heading (radians) of "towards the screen" in the earth frame */
  heading: number | null = null;
  lastEvent = 0;
  /** smoothed angular speed, rad/s */
  private spin = 0;

  /** the OS reading, as a quaternion (scratch) */
  private readonly meas: Quat = [0, 0, 0, 1];

  /** OS-fused orientation arrived. */
  measure(alpha: number | null, beta: number | null, gamma: number | null, t: number) {
    if (beta == null || gamma == null) return;
    const m = quatFromEulerInto(this.meas, alpha ?? 0, beta, gamma);
    // The OS reading arrives a frame or two late. At rest that doesn't matter and
    // it cancels gyro drift; mid-swing (15+ rad/s) even 20 ms of lag is 20°+, so
    // during fast motion trust the gyro almost completely.
    const k = this.spin < 2 ? 0.2 : this.spin > 6 ? 0.01 : 0.2 - ((this.spin - 2) / 4) * 0.19;
    const q = this.q;
    if (!this.have) {
      q[0] = m[0];
      q[1] = m[1];
      q[2] = m[2];
      q[3] = m[3];
    } else {
      // q = normalize(slerp(q, m, k)), in place
      const a0 = q[0],
        a1 = q[1],
        a2 = q[2],
        a3 = q[3];
      let d = a0 * m[0] + a1 * m[1] + a2 * m[2] + a3 * m[3];
      const f = d < 0 ? -1 : 1;
      const b0 = f * m[0],
        b1 = f * m[1],
        b2 = f * m[2],
        b3 = f * m[3];
      d = Math.abs(d);
      let x: number, y: number, z: number, w: number;
      if (d > 0.9995) {
        // (nearly the same: a straight blend, normalized — and again below, as it always was)
        x = a0 + (b0 - a0) * k;
        y = a1 + (b1 - a1) * k;
        z = a2 + (b2 - a2) * k;
        w = a3 + (b3 - a3) * k;
        const l0 = Math.hypot(x, y, z, w) || 1;
        x /= l0;
        y /= l0;
        z /= l0;
        w /= l0;
      } else {
        const th = Math.acos(d);
        const sn = Math.sin(th);
        const wa = Math.sin((1 - k) * th) / sn,
          wb = Math.sin(k * th) / sn;
        x = a0 * wa + b0 * wb;
        y = a1 * wa + b1 * wb;
        z = a2 * wa + b2 * wb;
        w = a3 * wa + b3 * wb;
      }
      const l = Math.hypot(x, y, z, w) || 1;
      q[0] = x / l;
      q[1] = y / l;
      q[2] = z / l;
      q[3] = w / l;
    }
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
    // q = normalize(q ⊗ (w·s, cos(a/2))), in place
    const q = this.q;
    const a0 = q[0],
      a1 = q[1],
      a2 = q[2],
      a3 = q[3];
    const b0 = wx * s,
      b1 = wy * s,
      b2 = wz * s,
      b3 = Math.cos(a / 2);
    const x = a3 * b0 + a0 * b3 + a1 * b2 - a2 * b1;
    const y = a3 * b1 - a0 * b2 + a1 * b3 + a2 * b0;
    const z = a3 * b2 + a0 * b1 - a1 * b0 + a2 * b3;
    const ww = a3 * b3 - a0 * b0 - a1 * b1 - a2 * b2;
    const l = Math.hypot(x, y, z, ww) || 1;
    q[0] = x / l;
    q[1] = y / l;
    q[2] = z / l;
    q[3] = ww / l;
  }

  /** true up, expressed in device coordinates */
  upDevice(): Vec3 {
    return qrot(qconj(this.q), [0, 0, 1]);
  }

  /** upDevice into out (no allocation) */
  upDeviceInto(out: Vec3): Vec3 {
    const q = this.q;
    return qrotInto(out, -q[0], -q[1], -q[2], q[3], 0, 0, 1);
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
    // The top, within ~30° of level, points at the screen by itself (a remote, a sword held
    // out); the back counts more the more the phone stands up (a hilt upright in the fist).
    // The two disagree when the phone is held on its side — top at the TV, screen to the
    // left, as a sword gripped in a fist often is — and then it's the top that's right (the
    // two added were 45° off).
    const level = Math.hypot(top[0], top[1]);
    const wb = Math.min(1, Math.max(0, (0.85 - level) / 0.35));
    const x = top[0] + wb * back[0],
      y = top[1] + wb * back[1];
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
  private readonly q0buf: Quat = [0, 0, 0, 1];
  private t0 = 0;
  private acc: Vec3 = [0, 0, 0];
  private acc2: Vec3 = [0, 0, 0];
  private readonly dq: Quat = [0, 0, 0, 1];
  private readonly oq: Vec3 = [0, 0, 0];

  /** called when the evidence settles a mapping (to remember it for next time) */
  onSure: (saved: string) => void = () => {};

  /** a mapping remembered from last time (as onSure gave it): used from the start, still checked */
  load(saved: string) {
    const m = /^([012])([012])([012]):([+-])([+-])([+-])$/.exec(saved);
    if (!m) return;
    const src = [+m[1], +m[2], +m[3]];
    if (new Set(src).size !== 3) return;
    this.src = src as [number, number, number];
    this.sign = [m[4] === '-' ? -1 : 1, m[5] === '-' ? -1 : 1, m[6] === '-' ? -1 : 1];
    this.name = this.describe();
  }

  private describe() {
    const [a, b, c] = this.src;
    const pos = this.sign.every((v) => v > 0);
    if (pos && a === 0 && b === 1 && c === 2) return 'xyz';
    if (pos && a === 1 && b === 2 && c === 0) return 'zxy'; // alpha about z, beta x, gamma y
    const n = ['alpha', 'beta', 'gamma'];
    return [0, 1, 2].map((i) => `${this.sign[i] < 0 ? '-' : ''}${n[this.src[i]]}→${'xyz'[i]}`).join(' ');
  }

  /** raw rates (deg/s, as the event has them) → device-axis rad/s */
  map(alpha: number, beta: number, gamma: number): Vec3 {
    return this.mapInto([0, 0, 0], alpha, beta, gamma);
  }

  /** map into out (no allocation) */
  mapInto(out: Vec3, alpha: number, beta: number, gamma: number): Vec3 {
    const k = Math.PI / 180;
    const src = this.src,
      sign = this.sign;
    out[0] = sign[0] * (src[0] === 0 ? alpha : src[0] === 1 ? beta : gamma) * k;
    out[1] = sign[1] * (src[1] === 0 ? alpha : src[1] === 1 ? beta : gamma) * k;
    out[2] = sign[2] * (src[2] === 0 ? alpha : src[2] === 1 ? beta : gamma) * k;
    return out;
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
    if (t - this.t0 < 60) return;
    // how the OS says the phone turned since the window began, in its own axes: conj(q0) ⊗ q
    const c = this.q0;
    const a0 = -c[0],
      a1 = -c[1],
      a2 = -c[2],
      a3 = c[3];
    const d = this.dq;
    d[0] = a3 * q[0] + a0 * q[3] + a1 * q[2] - a2 * q[1];
    d[1] = a3 * q[1] - a0 * q[2] + a1 * q[3] + a2 * q[0];
    d[2] = a3 * q[2] + a0 * q[1] - a1 * q[0] + a2 * q[3];
    d[3] = a3 * q[3] - a0 * q[0] - a1 * q[1] - a2 * q[2];
    if (d[3] < 0) {
      d[0] = -d[0];
      d[1] = -d[1];
      d[2] = -d[2];
      d[3] = -d[3];
    }
    const s = Math.hypot(d[0], d[1], d[2]);
    const ang = 2 * Math.atan2(s, d[3]);
    const g = this.acc;
    const gl = Math.hypot(g[0], g[1], g[2]);
    this.restart(q, t);
    // too little to tell apart from noise, or so much the OS's lag muddles it
    if (ang < 0.03 || ang > 1.5 || gl < 0.015) return;
    const o = this.oq;
    o[0] = (d[0] / s) * ang;
    o[1] = (d[1] / s) * ang;
    o[2] = (d[2] / s) * ang;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.M[i * 3 + j] += o[i] * g[j];
    this.eo += ang * ang;
    this.eg += gl * gl;
    this.decide();
  }

  private restart(q: Quat, t: number) {
    // (a copy: the caller may reuse its array)
    const b = this.q0buf;
    b[0] = q[0];
    b[1] = q[1];
    b[2] = q[2];
    b[3] = q[3];
    this.q0 = b;
    this.t0 = t;
    // (a fresh sum: orient() is still reading the old one, so swap the two)
    const old = this.acc;
    this.acc = this.acc2;
    this.acc2 = old;
    this.acc[0] = this.acc[1] = this.acc[2] = 0;
  }

  /** the signed permutation that best turns the gyro's rotations into the OS's */
  private decide() {
    const norm = Math.sqrt(this.eo * this.eg);
    if (this.eo < 0.08 || norm < 1e-9) return;
    let best = -Infinity,
      second = -Infinity;
    let bs: [number, number, number] = this.src,
      bg: [number, number, number] = this.sign;
    for (const p of PERMS) {
      // (only the 24 that are rotations: a mirror image can't be how a gyro is mounted)
      const odd = (p[0] === 0 ? p[1] !== 1 : p[0] === 1 ? p[1] !== 2 : p[1] !== 0) ? 1 : 0;
      for (let m = 0; m < 8; m++) {
        const s0 = m & 1 ? -1 : 1,
          s1 = m & 2 ? -1 : 1,
          s2 = m & 4 ? -1 : 1;
        const flips = (m & 1 ? 1 : 0) + (m & 2 ? 1 : 0) + (m & 4 ? 1 : 0);
        if ((flips + odd) % 2) continue;
        const sc = (s0 * this.M[p[0]] + s1 * this.M[3 + p[1]] + s2 * this.M[6 + p[2]]) / norm;
        if (sc > best) {
          second = best;
          best = sc;
          bs = p;
          bg = [s0, s1, s2];
        } else if (sc > second) second = sc;
      }
    }
    if (best > 0.7 && best - second > 0.3) {
      const was = this.sure ? `${this.src.join('')}:${this.sign.map((v) => (v < 0 ? '-' : '+')).join('')}` : '';
      this.src = [bs[0], bs[1], bs[2]];
      this.sign = bg;
      this.sure = true;
      this.name = this.describe();
      const now = `${this.src.join('')}:${this.sign.map((v) => (v < 0 ? '-' : '+')).join('')}`;
      if (now !== was) this.onSure(now);
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
