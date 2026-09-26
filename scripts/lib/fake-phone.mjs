// A phone that moves, for end-to-end tests: add it to a browser context with
// `ctx.addInitScript(phone)`, then drive it from the page with window.__phone.
// ---------------------------------------------------------------- a phone that moves
// Runs in the page before its scripts. The pose is device→earth; the screen is
// straight ahead (north). The phone lies flat in the palm, top towards the
// screen, so the remote calibrates "towards the screen" when it joins. It sits
// 0.65 m down the arm from the shoulder, and its accelerometer reads that
// (W3C signs): so a flat phone with the arm hanging — which the remote first
// guesses is held up in front — has to be put right by the swing itself.
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
  const pose = (t) => qmul(qaxis([0, 0, 1], yaw(t)), qmul(qaxis([1, 0, 0], theta(t)), qmul(qaxis([0, 0, 1], phi(t)), grip)));
  const rot = (q, v) => {
    const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
    return [r[0], r[1], r[2]];
  };
  // the phone on the end of the arm (the tennis swing turns it in place)
  const where = (t) => rot(qaxis([1, 0, 0], theta(t)), [0, 0, -0.65]);
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
    tennis() {
      sw = { kind: 'tennis', tp: now() + 0.6 };
      return new Promise((done) => setTimeout(() => ((sw = null), done()), 1300));
    },
  };
}
