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
// The sensors report as browsers do: rotationRate's alpha, beta, gamma about
// the device's x, y, z (set window.__phoneConfig = { axes: 'zxy' } before the
// page loads for the other convention, { ios: true } for iOS's accelerometer
// signs).
//
// The sword (a program that takes over the pose while it runs) moves like a
// person, not a textbook: hold() turns the phone to a pose at an unhurried
// pace (≤ ~2.5 rad/s) and keeps it there with a slight tremor; sword() draws
// the sword back (unless windup: false), strikes through the held pose — the
// arm turning from somewhere between the wrist and the elbow, a little off
// the meant direction and axis, a twist of the forearm in it — stops, bounces
// back a touch and returns to the held pose; thrust() jabs at the screen;
// guard() presses the GUARD pad. The phone rides on the forearm, 0.3 m from
// the elbow, so the accelerometer feels every turn.
export function phone() {
  const D = 180 / Math.PI;
  const cfg = () => window.__phoneConfig || {};
  const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
  const qaxis = (a, ang) => {
    const n = Math.hypot(...a) || 1, s = Math.sin(ang / 2) / n;
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
  const erf = (v) => {
    const k = 1 / (1 + 0.3275911 * Math.abs(v));
    const y = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-v * v);
    return v >= 0 ? y : -y;
  };
  // tennis: a forehand turns the phone counter-clockwise (seen from above), peak 950°/s
  const yaw = (t) => {
    if (!sw || sw.kind !== 'tennis') return 0;
    const W = 950 / D, sig = 0.0833, x = (t - sw.tp) / sig;
    return W * sig * (Math.sqrt(Math.PI) / 2) * (1 + erf(x));
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
  // seeded randomness: runs repeat exactly
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const range = (a, b) => a + (b - a) * rand();
  setInterval(() => {
    const t = now();
    const q = pose(t);
    const h = 0.002;
    let d = qmul(qconj(pose(t - h)), pose(t + h));
    if (d[3] < 0) d = d.map((v) => -v);
    const s = Math.hypot(d[0], d[1], d[2]);
    const k = s > 1e-12 ? (2 * Math.atan2(s, d[3])) / (2 * h) / s : 0;
    // (a real gyro's noise, while the sword is out)
    const n = sd ? 0.02 : 0;
    const w = [d[0] * k + n * gauss(), d[1] * k + n * gauss(), d[2] * k + n * gauss()];
    const [alpha, beta, gamma] = euler(q);
    const upDev = rot(qconj(q), [0, 0, 1]);
    const e = 0.004,
      p0 = where(t - e),
      p1 = where(t),
      p2 = where(t + e);
    const acc = rot(qconj(q), [0, 1, 2].map((k) => (p0[k] - 2 * p1[k] + p2[k]) / (e * e)));
    const sg = cfg().ios ? -1 : 1;
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta, gamma }));
    window.dispatchEvent(
      new DeviceMotionEvent('devicemotion', {
        interval: 16,
        rotationRate: cfg().axes === 'zxy' ? { alpha: w[2] * D, beta: w[0] * D, gamma: w[1] * D } : { alpha: w[0] * D, beta: w[1] * D, gamma: w[2] * D },
        acceleration: { x: sg * acc[0], y: sg * acc[1], z: sg * acc[2] },
        accelerationIncludingGravity: { x: sg * (acc[0] + upDev[0] * 9.81), y: sg * (acc[1] + upDev[1] * 9.81), z: sg * (acc[2] + upDev[2] * 9.81) },
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
  const qangle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
  const ease = (u) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;
  /** the angle turned by time t of a blow whose speed peaks at tp (gaussian: σ rise before, fall after) */
  const blowAngle = (t, tp, peak, rise, fall) => {
    const k = Math.sqrt(Math.PI / 2);
    if (t < tp) return peak * rise * k * (1 + erf((t - tp) / (rise * Math.SQRT2)));
    return peak * rise * k + peak * fall * k * erf((t - tp) / (fall * Math.SQRT2));
  };
  // the pose the sword rests at between moves (flat in the palm to begin with), and a slight tremor
  let held = grip;
  const tremor = (t, q) => qmul(qaxis([0.3, 1, 0.5], 0.004 * Math.sin(2 * Math.PI * 5.3 * t) + 0.003 * Math.sin(2 * Math.PI * 7.9 * t + 1)), q);
  // the forearm: the phone 0.3 m ahead of (and a little above) the elbow, turning about it (placed
  // where the arm model left the phone when the sword first came out, so nothing jumps)
  const ELBOW = [0, 0.28, 0.12];
  let anchor = null;
  const onArm = (q) => {
    const r = rot(qmul(q, qconj(grip)), ELBOW);
    return [anchor[0] + r[0], anchor[1] + r[1], anchor[2] + r[2]];
  };
  const drawSword = (t) => {
    if (sd) return;
    const a = armWhere(t),
      r = rot(qmul(armPose(t), qconj(grip)), ELBOW);
    anchor = [a[0] - r[0], a[1] - r[1], a[2] - r[2]];
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
    /** a forehand (or a bat swing: the same turn) whose fastest moment is `inMs` from now — or at `at` (Date.now() ms) */
    tennis({ inMs = 600, at = 0 } = {}) {
      if (at) inMs = Math.max(0, at - Date.now());
      const mine = (sw = { kind: 'tennis', tp: now() + inMs / 1000 });
      // (a later swing isn't cut short by this one's timer)
      return new Promise((done) => setTimeout(() => (sw === mine && (sw = null), done()), inMs + 700));
    },
    /** turn the phone (smoothly, over at least `ms` — never faster than ~2.5 rad/s: aiming, not swinging)
     *  to hold its top along `top`, screen facing `screen` */
    hold({ top = [0, 0.8, 0.6], screen = [0, -1, 0], ms = 900 } = {}) {
      const t0 = now();
      drawSword(t0);
      const from = pose(t0), to = frame(top, screen);
      const T = Math.max(ms / 1000, (qangle(from, to) * Math.PI) / (2 * 2.5));
      held = to;
      const at = (t) => tremor(t, slerp(from, to, ease((t - t0) / T)));
      sd = { pose: at, where: (t) => onArm(at(t)) };
      return after(T + 0.05);
    },
    /**
     * A slash through the held pose, meant to send the tip across the view at `dir` (radians, 0 right,
     * π/2 up) at `peak` rad/s (a relaxed swing is 5–15). Like a person: drawn back first (`windup`, at
     * 25–50% of the speed) unless windup: false, a little off the meant direction (`sloppy`: σ of the
     * direction, radians), turning from somewhere between the wrist and the elbow, with a twist of the
     * forearm in it; then it stops, bounces back and returns to the held pose. Resolves when it's back
     * ({ tp }: when the strike peaked, performance.now() ms).
     */
    sword({ dir = 0, peak = 9, rise = 0.07, fall = 0.08, windup = true, sloppy = 0.12 } = {}) {
      drawSword(now());
      const base = held;
      const b = unit(rot(base, [0, 1, 0]));
      // the lever the arm turns: the phone's top alone (the wrist) … plus the forearm (the elbow)
      const lever = unit([b[0], b[1] + range(0, 1.2), b[2]]);
      const d = dir + sloppy * gauss();
      let axis = unit(cross(lever, [Math.cos(d), 0, Math.sin(d)]));
      const off = unit(cross(axis, [gauss(), gauss(), gauss()]));
      axis = unit([0, 1, 2].map((k) => axis[k] + off[k] * 0.1 * gauss()));
      const twist = 0.15 * gauss();
      const k = Math.sqrt(Math.PI / 2);
      const pre = peak * rise * k;
      const t0 = now() + 0.05;
      // the windup: about as far back as the strike turns before its peak
      const wp = windup ? peak * range(0.25, 0.5) : 0;
      const wa = windup ? pre * range(0.8, 1.1) : 0;
      const ws = windup ? wa / (wp * 2.5) : 0;
      const wtp = t0 + 3 * ws;
      const tp = windup ? wtp + 2.5 * ws + range(0.03, 0.12) + 3 * rise : t0 + 3 * rise;
      // the stop and the bounce back
      const rp = peak * range(0.15, 0.3), rs = 0.05, rtp = tp + range(0.12, 0.18);
      const ra = rp * rs * 2.5;
      const angW = (t) => (windup ? -blowAngle(t, wtp, wp, ws, ws) : 0);
      const angR = (t) => -blowAngle(t, rtp, rp, rs, rs);
      // …and back to the held pose, at a few rad/s
      const netAfter = pre + peak * fall * k - wa - ra;
      const tr = rtp + 4 * rs + range(0, 0.1);
      const Tr = Math.max(0.5, (Math.abs(netAfter) * Math.PI) / (2 * 3.5));
      const angBack = (t) => -netAfter * ease((t - tr) / Tr);
      const ang = (t) => angW(t) + blowAngle(t, tp, peak, rise, fall) + angR(t) + angBack(t);
      const at = (t) => {
        const a = ang(t);
        return tremor(t, qmul(qaxis(axis, a), qmul(qaxis(b, twist * a), base)));
      };
      sd = { pose: at, where: (t) => onArm(at(t)) };
      return after(tr + Tr - now() + 0.1).then(() => ({ tp: tp * 1000 }));
    },
    /** jab the phone at the screen: `dist` m over `dur` s (the wrist tips the blade forward a little), hold, bring it back */
    thrust({ dist = 0.35, dur = 0.25, back = 0.9 } = {}) {
      drawSword(now());
      const base = held;
      const t0 = now() + 0.05;
      const dirv = unit([0.05 * gauss(), 1, -0.05 + 0.05 * gauss()]);
      const push = (t) => {
        const u = t - t0;
        if (u <= 0) return 0;
        if (u < dur) return (dist * (1 - Math.cos((Math.PI * u) / dur))) / 2;
        if (u < dur + 0.1) return dist;
        const r = (u - dur - 0.1) / back;
        return r >= 1 ? 0 : (dist * (1 + Math.cos(Math.PI * r))) / 2;
      };
      const tip = (t) => qaxis([1, 0, 0], (-0.2 * push(t)) / dist);
      const at = (t) => tremor(t, qmul(tip(t), base));
      sd = { pose: at, where: (t) => onArm(at(t)).map((v, k) => v + push(t) * dirv[k]) };
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
