// The serve's lift-to-toss detector on realistic motions: a lift tosses (early in
// the lift), bringing the phone down and stopping it doesn't, a dip before the
// lift still tosses, waiting with the phone in hand doesn't, and a swing doesn't.
//   npx tsx scripts/lift-test.ts
import { LiftDetector } from '../src/pad/lift';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

/** A motion as its vertical speed over time (s → m/s) and turning rate; sampled at ~60 Hz with jitter, sensor noise and bias. Returns when it tossed (s), or null. */
function run(v: (t: number) => number, dur: number, w: (t: number) => number = () => 0.3, noise = 0.18, bias = 0.06) {
  const d = new LiftDetector();
  let t = 0;
  let prevV = v(0);
  // a second of holding still first
  for (let k = 0; k < 60; k++) {
    const dt = 1 / 60 + gauss() * 0.002;
    t += dt;
    if (d.push(t * 1000, gauss() * noise + bias, 0.2 + Math.abs(gauss()) * 0.2, dt)) return -1;
  }
  const t0 = t;
  while (t - t0 < dur) {
    const dt = 1 / 60 + gauss() * 0.003;
    t += dt;
    const u = t - t0;
    const nv = v(u);
    const a = (nv - prevV) / dt;
    prevV = nv;
    if (d.push(t * 1000, a + gauss() * noise + bias, w(u), dt)) return u;
  }
  return null;
}

/** a smooth bump of speed: 0 → peak → 0 over `T` seconds starting at `at` */
const bump = (peak: number, T: number, at = 0) => (u: number) => (u < at || u > at + T ? 0 : peak * Math.sin((Math.PI * (u - at)) / T) ** 2);

const trials = 40;
const rate = (f: () => number | null, pred: (r: number | null) => boolean) => {
  let n = 0;
  for (let i = 0; i < trials; i++) if (pred(f())) n++;
  return n / trials;
};

// 1. a brisk lift (the phone up 30 cm in a third of a second): tossed, and early on the way up
{
  let early = 0;
  const r = rate(
    () => {
      const x = run(bump(1.8, 0.35), 1.2);
      if (x !== null && x >= 0 && x < 0.2) early++;
      return x;
    },
    (x) => x !== null && x >= 0 && x < 0.35,
  );
  check('a brisk lift tosses — on the way up', r === 1, `${Math.round(r * 100)}% (${Math.round((early / trials) * 100)}% in the first 0.2 s)`);
}
// 2. a gentle lift (15 cm over half a second)
{
  const r = rate(() => run(bump(0.6, 0.5), 1.2), (x) => x !== null && x >= 0 && x < 0.5);
  check('a gentle lift tosses too, on the way up', r >= 0.95, `${Math.round(r * 100)}%`);
}
// 3. bringing the phone down and stopping it: never (this used to toss)
{
  const r = rate(() => run((u) => -bump(1.5, 0.45)(u), 1.5), (x) => x !== null);
  check('bringing the phone down and stopping doesn’t toss', r === 0, `${Math.round(r * 100)}% tossed`);
}
// 4. a lift too slow to count, held, then brought down and stopped: no toss on the way down
{
  const r = rate(() => run((u) => bump(0.3, 0.8)(u) - bump(1.4, 0.4, 1.4)(u), 2.4), (x) => x !== null && x > 1.3);
  check('…nor after a slow raise, on the way back down', r === 0, `${Math.round(r * 100)}% tossed on the way down`);
}
// 5. a little dip before the lift (people do): still tosses, on the way up
{
  const r = rate(() => run((u) => -bump(0.35, 0.25)(u) + bump(1.6, 0.35, 0.22)(u), 1.4), (x) => x !== null && x > 0.22 && x < 0.6);
  check('a dip then a lift tosses on the lift', r >= 0.95, `${Math.round(r * 100)}%`);
}
// 6. waiting with the phone in hand: a restless hand, small bobs (±4 cm/s ~ 5 cm bobs)
{
  const r = rate(() => run((u) => 0.12 * Math.sin(u * 5) + 0.06 * Math.sin(u * 11 + 1), 6, () => 0.6 + Math.abs(gauss()) * 0.5, 0.25, 0.08), (x) => x !== null);
  check('a restless hand while waiting doesn’t toss', r === 0, `${Math.round(r * 100)}% tossed`);
}
// 7. a swing (turning hard, with some up-and-down) doesn't toss
{
  const r = rate(() => run(bump(0.9, 0.25), 0.8, (u) => (u > 0.02 && u < 0.3 ? 15 : 0.4)), (x) => x !== null);
  check('a swing isn’t a toss', r === 0, `${Math.round(r * 100)}% tossed`);
}
console.log(fail ? `\n${fail} lift checks FAILED` : '\nAll lift checks passed.');
process.exitCode = fail ? 1 : 0;
