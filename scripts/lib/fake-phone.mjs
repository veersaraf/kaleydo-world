// A phone that moves, for end-to-end tests: add it to a browser context with
// `ctx.addInitScript(phone)`, then drive it from the page with window.__phone.
// ---------------------------------------------------------------- a phone that moves
// Runs in the page before its scripts. The pose is device→earth; the screen is
// straight ahead (north). The phone lies flat in the palm, top towards the
// screen, so the remote calibrates "towards the screen" when it joins. It sits
// 0.65 m down the arm from the shoulder, and its accelerometer reads that
// (W3C signs): so a flat phone with the arm hanging — which the remote first
// guesses is held up in front — has to be put right by the swing itself.
//
// The sword (a program that takes over the pose while it runs): hold() turns
// the phone to a pose and keeps it there, sword() winds up slowly and strikes
// through the held pose (the tip travelling at `dir` across the view at the
// peak), thrust() pushes it along the blade, guard() presses the GUARD pad.
// The phone swings about the wrist, 0.2 m behind it along the blade.
export function phone() {
  const D = 180 / Math.PI;
  const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
  const qaxis = (a, ang) => {
    const n = Math.hypot(...a), s = Math.sin(ang / 2) / n;
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)];
  };
  const euler = (q) => {
    const [x, y, z, w] = q;
    const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z);
    const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
    const c = Math.hypot(r20, r22);
    if (c < 1e-6) return [Math.atan2(r10, r00) * D, Math.atan2(r21, 0) * D, 0];
    return [Math.atan2(-r01, r11) * D, Math.atan2(r21, c) * D, Math.atan2(-r20, r22) * D];
  };
  const grip = [0, 0, 0, 1]; // flat in the palm, screen up, top towards the screen
  let sw = null; // the swing being played
  const theta = (t) => {
    if (!sw) return 0;
    const u = t - sw.t0;
    if (sw.kind === 'tennis') return 0;
    if (u < 0) return 0;
    if (u < sw.Tb) return (-sw.back * (1 - Math.cos((Math.PI * u) / sw.Tb))) / 2;
    if (u < sw.Tb + sw.Tf) return -sw.back * Math.cos((Math.PI * (u - sw.Tb)) / sw.Tf);
    return sw.back;
  };
  const phi = (t) => {
    if (!sw || !sw.twist) return 0;
    const s = Math.min(1, Math.max(0, (t - (sw.tBottom - 0.1)) / 0.2));
    return (sw.twist * (1 - Math.cos(Math.PI * s))) / 2;
  };
  // tennis: a forehand turns the phone counter-clockwise (seen from above), peak 950°/s
  const yaw = (t) => {
    if (!sw || sw.kind !== 'tennis') return 0;
    const W = (950 / D), sig = 0.0833, x = (t - sw.tp) / sig;
    const e = (v) => { const k = 1 / (1 + 0.3275911 * Math.abs(v)); const y = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-v * v); return v >= 0 ? y : -y; };
    return W * sig * (Math.sqrt(Math.PI) / 2) * (1 + e(x));
  };
  const armPose = (t) => qmul(qaxis([0, 0, 1], yaw(t)), qmul(qaxis([1, 0, 0], theta(t)), qmul(qaxis([0, 0, 1], phi(t)), grip)));
  const rot = (q, v) => {
    const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
    return [r[0], r[1], r[2]];
  };
  // the phone on the end of the arm (the tennis swing turns it in place)
  const armWhere = (t) => rot(qaxis([1, 0, 0], theta(t)), [0, 0, -0.65]);
  // the sword program, when one is running: { pose(t), where(t) }
  let sd = null;
  const pose = (t) => (sd ? sd.pose(t) : armPose(t));
  const where = (t) => (sd ? sd.where(t) : armWhere(t));
  const now = () => performance.now() / 1000;
  // (the script also runs on about:blank first, where the sensor events don't exist)
  if (typeof DeviceOrientationEvent === 'undefined') return;
  setInterval(() => {
    const t = now();
    const q = pose(t);
    const h = 0.002;
    let d = qmul(qconj(pose(t - h)), pose(t + h));
    if (d[3] < 0) d = d.map((v) => -v);
    const s = Math.hypot(d[0], d[1], d[2]);
    const k = s > 1e-12 ? (2 * Math.atan2(s, d[3])) / (2 * h) / s : 0;
    const w = [d[0] * k, d[1] * k, d[2] * k];
    const [alpha, beta, gamma] = euler(q);
    const upDev = rot(qconj(q), [0, 0, 1]);
    const e = 0.004,
      p0 = where(t - e),
      p1 = where(t),
      p2 = where(t + e);
    const acc = rot(qconj(q), [0, 1, 2].map((k) => (p0[k] - 2 * p1[k] + p2[k]) / (e * e)));
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta, gamma }));
    window.dispatchEvent(
      new DeviceMotionEvent('devicemotion', {
        interval: 16,
        rotationRate: { alpha: w[2] * D, beta: w[0] * D, gamma: w[1] * D },
        acceleration: { x: acc[0], y: acc[1], z: acc[2] },
        accelerationIncludingGravity: { x: acc[0] + upDev[0] * 9.81, y: acc[1] + upDev[1] * 9.81, z: acc[2] + upDev[2] * 9.81 },
      }),
    );
  }, 16);
  const grab = () => {
    const el = document.querySelector('.grip');
    const r = el.getBoundingClientRect();
    return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const ptr = (type, id = 7) => {
    const { el, x, y } = grab();
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  };
  // ---------------------------------------------------------------- the sword
  const unit = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const qnorm = (q) => {
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return q.map((v) => v / l);
  };
  /** the rotation whose columns are the device x, y, z axes */
  const qcols = (x, y, z) => {
    const [m00, m10, m20] = x, [m01, m11, m21] = y, [m02, m12, m22] = z;
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      return qnorm([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]);
    }
    if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      return qnorm([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
    }
    if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      return qnorm([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]);
    }
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return qnorm([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]);
  };
  /** the phone with its top along `top` and its screen facing `screen` (earth = player frame: the TV is north) */
  const frame = (top, screen) => {
    const y = unit(top);
    const k = screen[0] * y[0] + screen[1] * y[1] + screen[2] * y[2];
    const z = unit([screen[0] - k * y[0], screen[1] - k * y[1], screen[2] - k * y[2]]);
    return qcols(cross(y, z), y, z);
  };
  const slerp = (a, b, u) => {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const bb = d < 0 ? b.map((v) => -v) : b;
    d = Math.abs(d);
    if (d > 0.9995) return qnorm(a.map((v, i) => v + (bb[i] - v) * u));
    const th = Math.acos(d), s = Math.sin(th);
    return a.map((v, i) => (v * Math.sin((1 - u) * th) + bb[i] * Math.sin(u * th)) / s);
  };
  const ease = (u) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;
  const erf = (v) => {
    const k = 1 / (1 + 0.3275911 * Math.abs(v));
    const y = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-v * v);
    return v >= 0 ? y : -y;
  };
  // the pose the sword rests at between moves (flat in the palm to begin with)
  let held = grip;
  const onWrist = (q) => {
    const b = rot(q, [0, 1, 0]);
    return [0.2 * b[0], 0.2 * b[1], 0.2 * b[2]];
  };
  const after = (s) => new Promise((done) => setTimeout(done, s * 1000));
  const guardPtr = (type) => {
    const el = document.querySelector('.guard');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  };

  window.__phone = {
    /** grip, swing back and forward (peak rad/s through the bottom), let go `late` ms after the bottom
     *  (and press pause `homeAfter` ms after letting go, as a sliding thumb might) */
    bowl({ back = 1.2, peak = 8, twist = 0, late = 10, homeAfter = 0 } = {}) {
      const t0 = now() + 0.3;
      const Tb = 0.6, Tf = (back * Math.PI) / peak;
      sw = { kind: 'bowl', t0, back, Tb, Tf, twist, tBottom: t0 + Tb + Tf / 2 };
      ptr('pointerdown');
      const releaseAt = (sw.tBottom + late / 1000 - now()) * 1000;
      return new Promise((done) =>
        setTimeout(() => {
          ptr('pointerup');
          if (homeAfter)
            setTimeout(() => {
              const el = document.querySelector('.bowl .bhome');
              for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { pointerId: 12, pointerType: 'touch', bubbles: true, cancelable: true }));
            }, homeAfter);
          setTimeout(() => {
            sw = null;
            done();
          }, 900);
        }, releaseAt),
      );
    },
    /** a forehand (or a bat swing: the same turn) whose fastest moment is `inMs` from now */
    tennis({ inMs = 600 } = {}) {
      sw = { kind: 'tennis', tp: now() + inMs / 1000 };
      return new Promise((done) => setTimeout(() => ((sw = null), done()), inMs + 700));
    },
    /** turn the phone (smoothly, over `ms`) to hold its top along `top`, screen facing `screen` */
    hold({ top = [0, 0.8, 0.6], screen = [0, -1, 0], ms = 900 } = {}) {
      const t0 = now(), T = ms / 1000;
      const from = pose(t0), to = frame(top, screen);
      held = to;
      sd = { pose: (t) => slerp(from, to, ease((t - t0) / T)), where: (t) => onWrist(slerp(from, to, ease((t - t0) / T))) };
      return after(T + 0.05);
    },
    /** a blow through the held pose: wind up slowly (away from it), then strike so the tip
     *  crosses the view at `dir` (radians, 0 right, π/2 up) at `peak` rad/s; it ends in the follow-through */
    sword({ dir = 0, peak = 12, rise = 0.06, fall = 0.05, windup = 0.9 } = {}) {
      const base = held;
      const b = unit(rot(base, [0, 1, 0]));
      // the tip's travel at the peak: square to the blade, seen from the front at `dir`
      const c = Math.cos(dir), s = Math.sin(dir);
      const axis = unit(cross(b, unit([c, -(c * b[0] + s * b[2]) / b[1], s])));
      const pre = peak * rise * Math.sqrt(Math.PI / 2), post = peak * fall * Math.sqrt(Math.PI / 2);
      const t0 = now(), tp = t0 + windup + 0.05 + 3 * rise;
      // the angle turned since the peak (− before it)
      const ang = (t) => {
        if (t < t0 + windup) return -pre * ease((t - t0) / windup);
        if (t <= tp) return -pre + peak * rise * Math.sqrt(Math.PI / 2) * (1 + erf((t - tp) / (rise * Math.SQRT2))) - (peak * rise * Math.sqrt(Math.PI / 2)) * (1 + erf((t0 + windup - tp) / (rise * Math.SQRT2)));
        return post * erf((t - tp) / (fall * Math.SQRT2));
      };
      const at = (t) => qmul(qaxis(axis, ang(t)), base);
      sd = { pose: at, where: (t) => onWrist(at(t)) };
      held = at(tp + 6 * fall);
      return after(tp - t0 + 6 * fall + 0.05).then(() => ({ tp: tp * 1000 }));
    },
    /** push the phone along its blade `dist` m over `dur` s, hold, and bring it back slowly */
    thrust({ dist = 0.35, dur = 0.25, back = 0.9 } = {}) {
      const base = held, b = unit(rot(base, [0, 1, 0]));
      const t0 = now() + 0.05;
      const push = (t) => {
        const u = t - t0;
        if (u <= 0) return 0;
        if (u < dur) return (dist * (1 - Math.cos((Math.PI * u) / dur))) / 2;
        if (u < dur + 0.1) return dist;
        const r = (u - dur - 0.1) / back;
        return r >= 1 ? 0 : (dist * (1 + Math.cos(Math.PI * r))) / 2;
      };
      sd = { pose: () => base, where: (t) => onWrist(base).map((v, k) => v + push(t) * b[k]) };
      return after(dur + back + 0.25);
    },
    /** press (true) or let go of (false) the GUARD pad */
    guard(down) {
      guardPtr(down ? 'pointerdown' : 'pointerup');
    },
    /** back to the arm model (bowling, tennis) */
    rest() {
      sd = null;
      held = grip;
    },
  };
}
