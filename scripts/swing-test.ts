// Synthetic motion → SwingDetector: power, side (forehand/backhand/overhead),
// spin (angle of attack) and backswing "prep" — on both the W3C and the
// inverted iOS sign conventions.
import { SwingDetector, type MotionSample, type SwingEvent } from '../src/pad/swing';

type Opts = { peak: number; dur: number; vUp: number; ios: boolean; yaw: number; backswing?: number; handed?: number };
const R = (d: number) => (d * Math.PI) / 180;

function makeSwing(o: Opts): MotionSample[] {
  const out: MotionSample[] = [];
  const up = [0.15, 0.95, 0.27];
  const n = Math.hypot(...up);
  const u = up.map((x) => x / n);
  // a unit vector perpendicular to up (rotation about a horizontal axis)
  const p = [0.96, -0.15, -0.2];
  const pd = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
  const ph = p.map((x, i) => x - pd * u[i]);
  const pn = Math.hypot(...ph);
  const hz = ph.map((x) => x / pn);
  const axis = (a: number) => u.map((x, i) => a * x + Math.sqrt(1 - a * a) * hz[i]);
  const main = axis(o.yaw);
  const back = axis(-o.yaw);
  for (let i = 0; i < 1.2 * 60; i++) {
    const t = i / 60;
    const ts = 0.62;
    const wMain = o.peak * Math.exp(-(((t - ts) / (o.dur / 2.4)) ** 2));
    const wBack = (o.backswing ?? 0) * Math.exp(-(((t - 0.3) / 0.07) ** 2));
    const rot = main.map((x, k) => x * wMain + back[k] * wBack);
    // vertical acceleration shaped so that vertical speed at contact ≈ vUp
    const aUp = (o.vUp / 0.12) * Math.exp(-(((t - (ts - 0.06)) / 0.05) ** 2));
    const side = 12 * Math.sin((t - ts) * 20) * Math.exp(-(((t - ts) / 0.12) ** 2));
    let ax = u[0] * aUp + side * hz[0], ay = u[1] * aUp + side * hz[1], az = u[2] * aUp + side * hz[2];
    let gx = u[0] * 9.81, gy = u[1] * 9.81, gz = u[2] * 9.81;
    if (o.ios) { ax = -ax; ay = -ay; az = -az; gx = -gx; gy = -gy; gz = -gz; }
    out.push({ t: t * 1000, rx: rot[0], ry: rot[1], rz: rot[2], ax, ay, az, gx, gy, gz });
  }
  return out;
}

let ok = true;
function run(name: string, o: Opts, check: (e: SwingEvent[], preps: string[]) => boolean) {
  const d = new SwingDetector();
  d.upSign = o.ios ? -1 : 1;
  d.handed = o.handed ?? 1;
  const evs: SwingEvent[] = [];
  const preps: string[] = [];
  d.onSwing = (e) => evs.push(e);
  d.onPrep = (s) => preps.push(s);
  for (const s of makeSwing(o)) d.push(s);
  const pass = check(evs, preps);
  if (!pass) ok = false;
  const desc = evs.map((e) => `${e.side} p${e.power.toFixed(2)} spin${e.spin >= 0 ? '+' : ''}${e.spin.toFixed(2)} (${e.attack.toFixed(0)}°) yaw${e.yaw.toFixed(2)}`).join(' | ');
  console.log(`${pass ? '✓' : '✗'} ${name.padEnd(40)} ${desc}${preps.length ? '  prep:' + preps.join(',') : ''}`);
}

for (const ios of [false, true]) {
  const T = ios ? '[iOS]' : '[W3C]';
  run(`${T} forehand, flat`, { peak: R(950), dur: 0.2, vUp: 0, ios, yaw: 0.85 }, (e) => e.length === 1 && e[0].side === 'fh' && Math.abs(e[0].spin) < 0.25);
  run(`${T} backhand, flat`, { peak: R(950), dur: 0.2, vUp: 0, ios, yaw: -0.85 }, (e) => e.length === 1 && e[0].side === 'bh');
  run(`${T} left-hander forehand`, { peak: R(950), dur: 0.2, vUp: 0, ios, yaw: -0.85, handed: -1 }, (e) => e.length === 1 && e[0].side === 'fh');
  run(`${T} overhead / serve`, { peak: R(1100), dur: 0.2, vUp: -0.5, ios, yaw: 0.1 }, (e) => e.length === 1 && e[0].side === 'oh');
  run(`${T} forehand topspin`, { peak: R(950), dur: 0.2, vUp: 2.2, ios, yaw: 0.85 }, (e) => e.length === 1 && e[0].spin > 0.4);
  run(`${T} backhand slice`, { peak: R(950), dur: 0.2, vUp: -2.2, ios, yaw: -0.85 }, (e) => e.length === 1 && e[0].side === 'bh' && e[0].spin < -0.4);
  run(`${T} gentle topspin (same angle)`, { peak: R(520), dur: 0.24, vUp: 1.1, ios, yaw: 0.85 }, (e) => e.length === 1 && e[0].spin > 0.3 && e[0].power < 0.35);
  run(`${T} hard flat`, { peak: R(1300), dur: 0.18, vUp: 0.2, ios, yaw: 0.85 }, (e) => e.length === 1 && e[0].power > 0.8);
  run(`${T} slow backswing → forehand`, { peak: R(1000), dur: 0.2, vUp: 0.3, ios, yaw: 0.85, backswing: R(260) }, (e, p) => e.length === 1 && e[0].side === 'fh' && p.includes('fh'));
  run(`${T} fast backswing → forehand`, { peak: R(1100), dur: 0.2, vUp: 0.3, ios, yaw: 0.85, backswing: R(520) }, (e) => e.length >= 1 && e[e.length - 1].side === 'fh' && e[e.length - 1].power > 0.6);
  run(`${T} resting phone`, { peak: R(40), dur: 0.3, vUp: 0, ios, yaw: 0.5 }, (e) => e.length === 0);
}
console.log(ok ? '\nAll swing checks passed.' : '\nSome swing checks FAILED.');
