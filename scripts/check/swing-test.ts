// Synthetic motion → SwingDetector: power, side (forehand/backhand/overhead),
// spin (angle of attack) and backswing "prep" — on both the W3C and the
// inverted iOS sign conventions.
import { SwingDetector, type MotionSample, type Side, type SwingEvent } from '../../src/pad/swing';

type Opts = { peak: number; dur: number; vUp: number; ios: boolean; yaw: number; backswing?: number; handed?: number; hz?: number; noise?: number; seed?: number };
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
  const rate = o.hz ?? 60;
  // (a small deterministic noise generator: sensors are not smooth)
  let seed = (o.seed ?? 1) >>> 0;
  const gauss = () => {
    let a = 0;
    for (let k = 0; k < 6; k++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      a += seed / 4294967296;
    }
    return a - 3;
  };
  for (let i = 0; i < 1.2 * rate; i++) {
    const t = i / rate;
    const ts = 0.62;
    const wMain = o.peak * Math.exp(-(((t - ts) / (o.dur / 2.4)) ** 2));
    const wBack = (o.backswing ?? 0) * Math.exp(-(((t - 0.3) / 0.07) ** 2));
    const rot = main.map((x, k) => x * wMain + back[k] * wBack + (o.noise ? o.noise * gauss() : 0));
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
/** ms from each swing's true peak to the sample that fired it (60 Hz runs only) */
const delays: number[] = [];
function run(name: string, o: Opts, check: (e: SwingEvent[], preps: string[]) => boolean) {
  const d = new SwingDetector();
  d.upSign = o.ios ? -1 : 1;
  d.handed = o.handed ?? 1;
  const evs: SwingEvent[] = [];
  const preps: string[] = [];
  let clock = 0;
  d.onSwing = (e) => {
    evs.push(e);
    if (!o.hz) delays.push(clock - e.t);
  };
  d.onPrep = (s) => preps.push(s);
  for (const s of makeSwing(o)) {
    clock = s.t;
    d.push(s);
  }
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
// other sensors: 30 Hz phones, 100 and 200 Hz ones, with noise on the gyro — the same swing reads the
// same (one event, the same side, about the same power), so a peak isn't called early on a fast sensor's ripple
for (const hz of [30, 100, 200]) {
  for (const [name, o, side] of [
    ['forehand, flat', { peak: R(950), dur: 0.2, vUp: 0, yaw: 0.85 }, 'fh'],
    ['backhand slice', { peak: R(950), dur: 0.2, vUp: -2.2, yaw: -0.85 }, 'bh'],
    ['gentle topspin', { peak: R(520), dur: 0.24, vUp: 1.1, yaw: 0.85 }, 'fh'],
    ['hard flat', { peak: R(1300), dur: 0.18, vUp: 0.2, yaw: 0.85 }, 'fh'],
  ] as [string, Omit<Opts, 'ios'>, Side][]) {
    const ref = new SwingDetector();
    ref.upSign = -1;
    const refEv: SwingEvent[] = [];
    ref.onSwing = (e) => refEv.push(e);
    for (const s of makeSwing({ ...o, ios: true })) ref.push(s);
    for (const noise of [0, 0.15, 0.4]) {
      run(`[${hz} Hz, noise ${noise}] ${name}`, { ...o, ios: true, hz, noise, seed: hz + Math.round(noise * 100) }, (e) => e.length === 1 && e[0].side === side && refEv.length === 1 && Math.abs(e[0].power - refEv[0].power) < 0.1);
    }
  }
}
{
  const a = [...delays].sort((x, y) => x - y);
  const q = (f: number) => a[Math.min(a.length - 1, Math.floor(f * (a.length - 1) + 0.5))];
  console.log(`\ndetection delay after the true peak (${a.length} swings, 60 Hz): p50 ${q(0.5).toFixed(0)} ms, p90 ${q(0.9).toFixed(0)} ms, max ${a[a.length - 1].toFixed(0)} ms`);
}

// the swing ONSET (onStart): fires once per real swing, ahead of its peak, on its side when it says one — and not for a resting phone or a wind-up alone
type Start = { t: number; side?: 'fh' | 'bh'; w: number };
const leads: number[] = [];
function runOnset(name: string, o: Opts, check: (s: Start[], e: SwingEvent[], lead: number) => boolean) {
  const d = new SwingDetector();
  d.upSign = o.ios ? -1 : 1;
  d.handed = o.handed ?? 1;
  const evs: SwingEvent[] = [];
  const starts: Start[] = [];
  d.onSwing = (e) => evs.push(e);
  d.onStart = (e) => starts.push(e);
  for (const s of makeSwing(o)) d.push(s);
  const lead = evs.length && starts.length ? evs[evs.length - 1].t - starts[starts.length - 1].t : NaN;
  if (evs.length && starts.length && !o.hz) leads.push(lead);
  const pass = check(starts, evs, lead);
  if (!pass) ok = false;
  console.log(`${pass ? '✓' : '✗'} onset ${name.padEnd(34)} ${starts.length} start${starts.length === 1 ? '' : 's'}${starts.length ? ` (${starts.map((x) => `${x.side ?? '?'} ${x.w.toFixed(1)} rad/s`).join(', ')})` : ''}${Number.isNaN(lead) ? '' : `, ${lead.toFixed(0)} ms before the peak`}`);
}
console.log('');
for (const ios of [false, true]) {
  const T = ios ? '[iOS]' : '[W3C]';
  const once = (side?: 'fh' | 'bh', minLead = 55) => (s: Start[], e: SwingEvent[], lead: number) => e.length === 1 && s.length === 1 && lead >= minLead && lead < 200 && (!s[0].side || !side || s[0].side === side);
  runOnset(`${T} forehand, flat`, { peak: R(950), dur: 0.2, vUp: 0, ios, yaw: 0.85 }, once('fh'));
  runOnset(`${T} backhand, flat`, { peak: R(950), dur: 0.2, vUp: 0, ios, yaw: -0.85 }, once('bh'));
  runOnset(`${T} left-hander forehand`, { peak: R(950), dur: 0.2, vUp: 0, ios, yaw: -0.85, handed: -1 }, once('fh'));
  runOnset(`${T} overhead / serve`, { peak: R(1100), dur: 0.2, vUp: -0.5, ios, yaw: 0.1 }, once(undefined));
  runOnset(`${T} hard flat`, { peak: R(1300), dur: 0.18, vUp: 0.2, ios, yaw: 0.85 }, once('fh'));
  runOnset(`${T} gentle (520°/s, 0.24 s)`, { peak: R(520), dur: 0.24, vUp: 1.1, ios, yaw: 0.85 }, once('fh', 40));
  runOnset(`${T} slow backswing → forehand`, { peak: R(1000), dur: 0.2, vUp: 0.3, ios, yaw: 0.85, backswing: R(260) }, once('fh'));
  runOnset(`${T} fast backswing → forehand`, { peak: R(1100), dur: 0.2, vUp: 0.3, ios, yaw: 0.85, backswing: R(520) }, (s, e, lead) => e.length >= 1 && s.length >= 1 && lead >= 55 && s[s.length - 1].side !== 'bh');
  runOnset(`${T} resting phone`, { peak: R(40), dur: 0.3, vUp: 0, ios, yaw: 0.5 }, (s, e) => s.length === 0 && e.length === 0);
  runOnset(`${T} wind-up alone (260°/s)`, { peak: R(1), dur: 0.2, vUp: 0, ios, yaw: 0.85, backswing: R(260) }, (s, e) => s.length === 0 && e.length === 0);
  runOnset(`${T} twitch (360°/s, 30 ms): false start`, { peak: R(360), dur: 0.072, vUp: 0, ios, yaw: 0.85 }, (s, e) => s.length === 1 && e.length === 0);
  runOnset(`${T} small wobble (300°/s)`, { peak: R(300), dur: 0.3, vUp: 0, ios, yaw: 0.85 }, (s, e) => s.length === 0 && e.length === 0);
}
for (const hz of [30, 100, 200]) {
  for (const noise of [0, 0.15, 0.4]) {
    runOnset(`[${hz} Hz, noise ${noise}] forehand`, { peak: R(950), dur: 0.2, vUp: 0, ios: true, yaw: 0.85, hz, noise, seed: hz + Math.round(noise * 100) }, (s, e, lead) => e.length === 1 && s.length === 1 && lead >= 40 && lead < 200 && s[0].side !== 'bh');
    runOnset(`[${hz} Hz, noise ${noise}] resting`, { peak: R(40), dur: 0.3, vUp: 0, ios: true, yaw: 0.5, hz, noise, seed: hz + 7 + Math.round(noise * 100) }, (s, e) => s.length === 0 && e.length === 0);
  }
}
{
  const a = [...leads].sort((x, y) => x - y);
  console.log(`\nonset lead before the true peak (${a.length} swings, 60 Hz): min ${a[0].toFixed(0)} ms, p50 ${a[Math.floor(a.length / 2)].toFixed(0)} ms, max ${a[a.length - 1].toFixed(0)} ms`);
}
// a volley is a short punch: ~150 ms in all, a peak of 9-12 rad/s (520-690 deg/s). Its speed is over the detector's START only ~60 ms before the peak, so
// its onset comes later ahead of the peak than a full swing's, but it must come, once, on its side
{
  const punchLeads: number[] = [];
  let missed = 0;
  for (const ios of [false, true]) {
    const T = ios ? '[iOS]' : '[W3C]';
    for (const [pk, dur] of [[7.5, 0.15], [9, 0.15], [10.5, 0.15], [12, 0.15], [10.5, 0.12], [12, 0.18], [9, 0.1]] as [number, number][]) {
      for (const [name, yaw, side] of [['fh', 0.85, 'fh'], ['bh', -0.85, 'bh']] as [string, number, 'fh' | 'bh'][]) {
        const d = new SwingDetector();
        d.upSign = ios ? -1 : 1;
        const evs: SwingEvent[] = [];
        const starts: Start[] = [];
        d.onSwing = (e) => evs.push(e);
        d.onStart = (e) => starts.push(e);
        for (const s of makeSwing({ peak: pk, dur, vUp: 0, ios, yaw })) d.push(s);
        const lead = evs.length && starts.length ? evs[evs.length - 1].t - starts[starts.length - 1].t : NaN;
        const pass = evs.length === 1 && starts.length === 1 && lead >= 30 && lead < 200 && (!starts[0].side || starts[0].side === side);
        if (!pass) ok = false;
        if (Number.isNaN(lead)) missed++;
        else punchLeads.push(lead);
        console.log(`${pass ? '\u2713' : '\u2717'} onset ${T} punch ${name} ${pk} rad/s, ${Math.round(dur * 1000)} ms`.padEnd(52) + ` ${starts.length} start${starts.length === 1 ? '' : 's'}${starts.length ? ` (${starts[0].side ?? '?'} ${starts[0].w.toFixed(1)} rad/s)` : ''}${Number.isNaN(lead) ? '' : `, ${lead.toFixed(0)} ms before the peak`}`);
      }
    }
  }
  const a = [...punchLeads].sort((x, y) => x - y);
  console.log(`\npunch onset lead (${a.length} punches, ${missed} missed): min ${a[0].toFixed(0)} ms, p50 ${a[Math.floor(a.length / 2)].toFixed(0)} ms, max ${a[a.length - 1].toFixed(0)} ms`);
}
console.log(ok ? '\nAll swing checks passed.' : '\nSome swing checks FAILED.');
if (!ok) process.exitCode = 1;
