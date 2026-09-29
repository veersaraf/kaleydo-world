// How far behind the phone the on-screen racket / sword / bowling arm trails, headless: a synthetic
// phone rotates and streams 'ori' at 30 Hz (arrival jitter, the phone's 0.01 rounding) into the real
// Input, the tennis Animator / the duel's DuelAnimator draw from it at 60 fps exactly as the app
// does, and each frame the drawn direction is compared with the phone's true pose at that instant
// (no network delay in the truth: this is the TV-side trail only). Prints the mean / 95th / max
// angle, the equivalent lag (the time shift that fits best), and how rough the drawn motion is
// against the true one (jitter). Runs on older commits too (it uses oriNow/armNow when there are any).
//   npx tsx scripts/mirror-lag-check.ts

import { Input } from '../src/tv/core/input';
import { Animator } from '../src/tv/chars/anim';
import { TPlayer } from '../src/tv/tennis/player';
import { DuelAnimator } from '../src/tv/duel/anim';
import { aimFromPhone, type FighterState } from '../src/tv/duel/types';

// ---- a browser-less Input, and a clock we drive
let clock = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true });
(globalThis as any).window = { addEventListener() {}, innerWidth: 1280, innerHeight: 720 };
const link: any = { toPad() {}, serverOffset: 0 };

type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angle = (a: V3, b: V3) => (Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180) / Math.PI;

interface Motion {
  name: string;
  /** the phone's pose at time t (s): the racket/blade s and the screen normal n (player frame) */
  pose: (t: number) => { s: V3; n: V3; arm: number };
}
const swingPose =
  (f: number, amp: number) =>
  (t: number) => {
    const yaw = amp * Math.sin(2 * Math.PI * f * t);
    const pitch = 0.6 + 0.35 * Math.sin(2 * Math.PI * f * 0.6 * t + 1);
    const roll = 0.9 * Math.sin(2 * Math.PI * f * 0.7 * t + 2);
    const s = norm([Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)]);
    let n0 = norm([-Math.sin(yaw) * Math.sin(pitch), -Math.cos(yaw) * Math.sin(pitch), Math.cos(pitch)]);
    const c = cross(s, n0);
    const n = norm([n0[0] * Math.cos(roll) + c[0] * Math.sin(roll), n0[1] * Math.cos(roll) + c[1] * Math.sin(roll), n0[2] * Math.cos(roll) + c[2] * Math.sin(roll)]);
    return { s, n, arm: 0.7 * Math.sin(2 * Math.PI * f * t) * 2.2 };
  };
const motions: Motion[] = [
  { name: 'easy carry (0.5 Hz, ~4 rad/s)', pose: swingPose(0.5, 1.2) },
  { name: 'a real swing (1.5 Hz, ~11 rad/s)', pose: swingPose(1.5, 1.2) },
  { name: 'a whip (3 Hz, ~23 rad/s)', pose: swingPose(3, 1.2) },
  { name: 'a steady hand (0.3° tremor at 3 Hz)', pose: (t) => { const p = swingPose(3, 0.005)(t); return { ...p, arm: 0.01 * Math.sin(t * 19) }; } },
];

// deterministic noise
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const r2 = (v: V3): V3 => v.map((x) => Math.round(x * 100) / 100) as V3;

interface Result {
  err: number[];
  lagMs: number;
  rough: number;
  roughTrue: number;
}

/** run one motion; `draw(t, dt)` returns what's drawn (a direction) and `truth(t)` the phone's */
function measure(m: Motion, hz: number, jitterMs: number, feed: (input: Input, t: number) => void, setup: (input: Input) => { draw: (t: number, dt: number) => V3; truth: (p: ReturnType<Motion['pose']>) => V3 }): Result {
  seed = 12345;
  clock = 0;
  const input = new Input(link);
  input.padJoin('p0', 'x', 'ws');
  const { draw, truth } = setup(input);
  const dtF = 1 / 60;
  const T = 6;
  // samples: the phone samples at k/hz, they get here a few ms later
  const arrivals: { at: number; t: number }[] = [];
  for (let k = 0; k / hz < T + 1; k++) arrivals.push({ t: k / hz, at: (k / hz) * 1000 + rnd() * jitterMs });
  arrivals.sort((a, b) => a.at - b.at);
  let ai = 0;
  const errs: number[] = [];
  const drawn: V3[] = [];
  const trueDirs: { t: number; d: V3 }[] = [];
  const shifts: number[] = [];
  const TAU = [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 100, 120];
  const sumTau = TAU.map(() => 0);
  let nT = 0;
  const hist: { t: number; d: V3 }[] = [];
  for (let f = 0; f * dtF < T; f++) {
    const t = f * dtF;
    clock = t * 1000;
    while (ai < arrivals.length && arrivals[ai].at <= clock) {
      const p = m.pose(arrivals[ai].t);
      // (the relay's clock: when the message went through it, for the spacing)
      input.padMsg('p0', 1e12 + arrivals[ai].at, { type: 'ori', s: r2(p.s), n: r2(p.n), arm: Math.round(p.arm * 100) / 100 } as any);
      ai++;
    }
    const d = draw(t, dtF);
    if (t < 2) continue; // settle (the mirror blends in)
    const tr = truth(m.pose(t));
    errs.push(angle(d, tr));
    drawn.push(d);
    trueDirs.push({ t, d: tr });
    hist.push({ t, d });
    nT++;
    TAU.forEach((tau, i) => (sumTau[i] += angle(d, truth(m.pose(t - tau / 1000)))));
  }
  void shifts;
  // the equivalent lag: where the drawn motion best matches the true one, parabola-refined
  let bi = 0;
  sumTau.forEach((v, i) => v < sumTau[bi] && (bi = i));
  let lag = TAU[bi];
  if (bi > 0 && bi < TAU.length - 1) {
    const y0 = sumTau[bi - 1],
      y1 = sumTau[bi],
      y2 = sumTau[bi + 1];
    const den = y0 - 2 * y1 + y2;
    if (den > 1e-9) lag += ((TAU[bi + 1] - TAU[bi - 1]) / 2) * (0.5 * (y0 - y2)) / den;
  }
  // roughness: RMS of the second difference of the direction (deg / frame²)
  const rough = (ds: V3[]) => {
    let s = 0;
    let n = 0;
    for (let i = 2; i < ds.length; i++) {
      const a = angle(ds[i], ds[i - 1]);
      const b = angle(ds[i - 1], ds[i - 2]);
      s += (a - b) ** 2;
      n++;
    }
    return Math.sqrt(s / Math.max(1, n));
  };
  void nT;
  void hist;
  return { err: errs, lagMs: lag, rough: rough(drawn), roughTrue: rough(trueDirs.map((x) => x.d)) };
}

const stats = (e: number[]) => {
  const s = [...e].sort((a, b) => a - b);
  return { mean: e.reduce((a, b) => a + b, 0) / e.length, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};
const fmt = (r: Result) => {
  const s = stats(r.err);
  return `mean ${s.mean.toFixed(2)}°  p95 ${s.p95.toFixed(2)}°  max ${s.max.toFixed(2)}°  lag ${r.lagMs.toFixed(0)} ms  roughness ${r.rough.toFixed(2)}° (true ${r.roughTrue.toFixed(2)}°)`;
};

const look: any = {};
const anyInput = (i: Input) => i as any;
/** the pose the app hands the animators: the newest one carried on (oriNow), or on older code the raw newest */
const poseNow = (i: Input, now: number) => (anyInput(i).oriNow ? anyInput(i).oriNow(0, now) : (i.racket[0] && now - i.racket[0].t < 400 ? i.racket[0] : null));

const hz = Number(process.env.ORI_HZ ?? 30);
const jitter = Number(process.env.ORI_JITTER ?? 8);
console.log(`phone streams at ${hz} Hz, arrivals jittered by up to ${jitter} ms, drawn at 60 fps\n`);
for (const m of motions) {
  console.log(m.name);
  // tennis racket
  const tennis = measure(m, hz, jitter, () => {}, (input) => {
    const p = new TPlayer(0, 0, { kind: 'human', slot: 0, ai: { speed: 6 } as any }, 'x', look, 1);
    const a = new Animator(p);
    return {
      draw: (t, dt) => {
        a.phone = poseNow(input, clock) as any;
        const P = a.update(t, dt, { x: 0, y: 1, z: -5 }, 'play');
        return [P.racketDir.x, P.racketDir.y, P.racketDir.z];
      },
      truth: (p) => [p.s[0], p.s[2], -p.s[1]],
    };
  });
  console.log('  tennis racket   ', fmt(tennis));
  // the racket's face (the phone's screen): the drawn face against the screen normal, both square to the shaft
  const face = measure(m, hz, jitter, () => {}, (input) => {
    const p = new TPlayer(0, 0, { kind: 'human', slot: 0, ai: { speed: 6 } as any }, 'x', look, 1);
    const a = new Animator(p);
    const sq = (f: V3, d: V3): V3 => {
      const k = dot(f, norm(d));
      const u = norm(d);
      return norm([f[0] - u[0] * k, f[1] - u[1] * k, f[2] - u[2] * k]);
    };
    return {
      draw: (t, dt) => {
        a.phone = poseNow(input, clock) as any;
        const P = a.update(t, dt, { x: 0, y: 1, z: -5 }, 'play');
        return sq([P.racketFace.x, P.racketFace.y, P.racketFace.z], [P.racketDir.x, P.racketDir.y, P.racketDir.z]);
      },
      truth: (p) => sq([p.n[0], p.n[2], -p.n[1]], [p.s[0], p.s[2], -p.s[1]]),
    };
  });
  console.log('  racket face     ', fmt(face));
  // duel sword
  const duel = measure(m, hz, jitter, () => {}, (input) => {
    const a = new DuelAnimator(1, look);
    const st: FighterState = { x: 0, z: 1.5, facing: 1, handed: 1, phase: 'ready', t: 5, aim: aimFromPhone([0, 1, 0], [0, 0, 1]), attack: null, push: 0 };
    return {
      draw: (t, dt) => {
        const r = poseNow(input, clock);
        if (r) st.aim = aimFromPhone(r.s, r.n);
        const P = a.update(t, dt, st);
        return [P.racketDir.x, P.racketDir.y, P.racketDir.z];
      },
      truth: (p) => [p.s[0], p.s[2], -p.s[1]],
    };
  });
  console.log('  duel sword      ', fmt(duel));
  // the guard (a sword held across the body)
  const guard = measure(m, hz, jitter, () => {}, (input) => {
    const a = new DuelAnimator(1, look);
    const st: FighterState = { x: 0, z: 1.5, facing: 1, handed: 1, phase: 'guard', t: 5, aim: aimFromPhone([0, 1, 0], [0, 0, 1]), attack: null, push: 0 };
    return {
      draw: (t, dt) => {
        const r = poseNow(input, clock);
        if (r) st.aim = aimFromPhone(r.s, r.n);
        const P = a.update(t, dt, st);
        return [P.racketDir.x, P.racketDir.y, P.racketDir.z];
      },
      truth: (p) => [p.s[0], p.s[2], -p.s[1]],
    };
  });
  console.log('  duel guard      ', fmt(guard));
  // bowling arm: an angle, so error in degrees of arm
  const bowl = measure(m, hz, jitter, () => {}, (input) => {
    let latest = 0;
    input.onArm = (_s, arm) => (latest = arm);
    return {
      draw: () => {
        const v = anyInput(input).armNow ? anyInput(input).armNow(0, clock) : latest;
        return [Math.cos(v ?? 0), Math.sin(v ?? 0), 0];
      },
      truth: (p) => [Math.cos(p.arm), Math.sin(p.arm), 0],
    };
  });
  console.log('  bowling arm     ', fmt(bowl));
}
