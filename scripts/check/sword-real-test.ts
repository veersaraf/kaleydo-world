// The sword on realistic hands: people (scripts/lib/hand.ts) with their own
// grip, speed and sloppiness swing in all directions — windups, off-axis
// turns, forearm twists, the stop and the return — through the whole remote
// pipeline as main.ts runs it (raw rotationRate in either axis convention,
// iOS accelerometer signs, 60 Hz with jitter and bunching, the OS's
// orientation late and against its own compass, "towards the screen"
// calibrated a little off). Scores what counts: every deliberate swing
// strikes once, the way it was meant; nothing else strikes.
//
//   npx tsx scripts/check/sword-real-test.ts [people = 40]
import { HandSim, randomPerson, rng, wrap, type RawEvents, type Meant } from '../lib/hand';
import { MotionFront, swordSample } from '../../src/pad/pipeline';
import { SwordDetector, type SwordStrike, type SwordNearMiss } from '../../src/pad/sword';

const PEOPLE = Number(process.argv[2] ?? 40);
const R2D = 180 / Math.PI;
const DIRS = [0, 45, 90, 135, 180, -135, -90, -45].map((d) => (d * Math.PI) / 180);

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail: string) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(64)} ${detail}`);
}

interface Played {
  strikes: SwordStrike[];
  /** how long after its peak each strike was sent, ms */
  lag: number[];
  near: SwordNearMiss[];
  guarded: SwordStrike[];
  axes: string;
}

/** the remote's pipeline, as main.ts runs it in the duel */
export function play(ev: RawEvents, ios: boolean, sensitivity = 1): Played {
  const front = new MotionFront();
  const sword = new SwordDetector();
  sword.sensitivity = sensitivity;
  sword.upSign = ios ? -1 : 1;
  const out: Played = { strikes: [], lag: [], near: [], guarded: [], axes: '' };
  let now = 0;
  sword.onStrike = (s) => {
    out.strikes.push(s);
    out.lag.push(now - s.t);
  };
  sword.onNear = (n) => out.near.push(n);
  sword.onGuarded = (s) => out.guarded.push(s);
  const guards = [...ev.guard];
  for (const { k, i } of ev.order) {
    if (k === 'o') {
      const o = ev.orient[i];
      front.orientEvent(o);
      if (front.orient.heading === null && o.t >= ev.calibrateAt * 1000) front.orient.calibrate();
      continue;
    }
    const e = ev.motion[i];
    while (guards.length && guards[0].t * 1000 <= e.t) {
      const g = guards.shift()!;
      sword.guard(g.down, g.t * 1000);
    }
    const m = front.motionEvent(e);
    if (!m) continue;
    now = e.t;
    front.orient.autoCenter(m.dt);
    sword.heading = front.orient.heading;
    sword.push(swordSample(m));
  }
  out.axes = front.axes.sure ? front.axes.name : 'unsure';
  return out;
}

interface Score {
  swings: number;
  hit: number;
  missed: number;
  extra: number;
  errs: number[];
  spurious: string[];
  doubled: string[];
  missedAt: string[];
}
const newScore = (): Score => ({ swings: 0, hit: 0, missed: 0, extra: 0, errs: [], spurious: [], doubled: [], missedAt: [] });
const fmtS = (s: SwordStrike) => `${s.kind === 'thrust' ? 'thrust' : Math.round(s.dir * R2D) + '°'} ${(s.t / 1000).toFixed(2)} s (${s.peak.toFixed(1)})`;

/** match strikes to what was meant */
function score(meant: Meant[], p: Played, sc: Score, label: string) {
  const used = new Set<SwordStrike>();
  for (const m of meant) {
    if (m.kind !== 'slash' && m.kind !== 'thrust') continue;
    const inWin = p.strikes.filter((s) => !used.has(s) && s.t >= m.t0 * 1000 && s.t <= m.t1 * 1000 + 150);
    inWin.forEach((s) => used.add(s));
    if (m.kind === 'thrust') continue; // (thrusts are scored on their own)
    sc.swings++;
    const sl = inWin.filter((s) => s.kind === 'slash');
    if (!sl.length) {
      sc.missed++;
      sc.missedAt.push(`${label} ${Math.round(m.dir * R2D)}° at ${m.t.toFixed(2)} s (${m.peak.toFixed(1)})`);
      continue;
    }
    sc.hit++;
    sc.extra += inWin.length - 1;
    if (inWin.length > 1) sc.doubled.push(`${label} meant ${Math.round(m.dir * R2D)}° at ${m.t.toFixed(2)}: ${inWin.map(fmtS).join(', ')}`);
    sc.errs.push(Math.abs(wrap(sl[sl.length - 1].dir - m.dir)));
  }
  for (const s of p.strikes) if (!used.has(s)) sc.spurious.push(`${label} ${s.kind} ${Math.round(s.dir * R2D)}° at ${(s.t / 1000).toFixed(2)} s (${s.peak.toFixed(1)})`);
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const q = (a: number[], f: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))] : NaN;
};

// ------------------------------------------------------------------ 1. a session of play
for (const axes of ['xyz', 'zxy'] as const) {
  console.log(`\n— ${PEOPLE} people × 16 slashes, 3 thrusts, a guard and some aiming (gyro axes reported ${axes}, iOS signs)`);
  const sc = newScore();
  let thrusts = 0,
    thrustHit = 0,
    axesRight = 0;
  const lags: number[] = [];
  const byGrip: Record<string, Score> = { hilt: newScore(), remote: newScore() };
  for (let n = 0; n < PEOPLE; n++) {
    const R = rng(1000 + n + (axes === 'zxy' ? 5000 : 0));
    const person = randomPerson(R);
    const sim = new HandSim(person, R);
    // joining and the menus first: the phone handled about for a few seconds
    sim.aim(1.2, 4, 2.5);
    let t = 7;
    const dirs = [...DIRS, ...DIRS].sort(() => R.u() - 0.5);
    for (const d of dirs) t = sim.slash(t, d) + R.range(0, 0.6);
    for (let k = 0; k < 3; k++) {
      sim.thrust(t);
      t += R.range(1.4, 1.9);
    }
    sim.guard(t, 1.6);
    t += 2.2;
    sim.aim(t, 3);
    t += 4;
    const ev = sim.run(t, { axes, ios: true, calErr: R.gauss() * 0.3, screen: R.range(-3, 3), bunch: 0.03 });
    const p = play(ev, true);
    if (p.axes === axes) axesRight++;
    lags.push(...p.lag);
    score(sim.meant, p, sc, `#${n} ${person.grip}`);
    score(sim.meant, p, byGrip[person.grip], `#${n}`);
    for (const m of sim.meant.filter((m) => m.kind === 'thrust')) {
      thrusts++;
      if (p.strikes.some((s) => s.kind === 'thrust' && s.t >= m.t0 * 1000 && s.t <= m.t1 * 1000 + 100)) thrustHit++;
    }
  }
  const within45 = sc.errs.filter((e) => e < Math.PI / 4).length;
  console.log(
    `  ${sc.swings} slashes: ${pct(sc.hit, sc.swings)} struck, ${sc.missed} missed, ${sc.extra} doubled, ${sc.spurious.length} strikes from nothing; direction median ${(q(sc.errs, 0.5) * R2D).toFixed(0)}°, p90 ${(q(sc.errs, 0.9) * R2D).toFixed(0)}°, ${pct(within45, sc.errs.length)} within 45°`,
  );
  console.log(`    sent after the peak: median ${q(lags, 0.5).toFixed(0)} ms, p75 ${q(lags, 0.75).toFixed(0)} ms, p90 ${q(lags, 0.9).toFixed(0)} ms, max ${q(lags, 1).toFixed(0)} ms; ${pct(lags.filter((l) => l > 150).length, lags.length)} held back (> 150 ms)`);
  for (const [g, s] of Object.entries(byGrip)) if (s.swings) console.log(`    ${g.padEnd(6)} ${pct(s.hit, s.swings)} struck, direction median ${(q(s.errs, 0.5) * R2D).toFixed(0)}°, ${pct(s.errs.filter((e) => e < Math.PI / 4).length, s.errs.length)} within 45°`);
  if (sc.spurious.length) console.log('    from nothing: ' + sc.spurious.slice(0, 6).join(' ;; '));
  if (sc.doubled.length) console.log('    doubled: ' + sc.doubled.slice(0, 6).join(' ;; '));
  if (sc.missedAt.length) console.log('    missed: ' + sc.missedAt.slice(0, 6).join(' ;; '));
  check(`[${axes}] the gyro's axes are found`, axesRight === PEOPLE, `${axesRight}/${PEOPLE}`);
  check(`[${axes}] ≥ 97% of deliberate slashes strike`, sc.hit >= 0.97 * sc.swings, pct(sc.hit, sc.swings));
  check(`[${axes}] ≤ 4% strike twice, or strike from nothing`, sc.extra + sc.spurious.length <= 0.04 * sc.swings, `${sc.extra} + ${sc.spurious.length}`);
  check(`[${axes}] direction: median ≤ 20°, ≥ 88% within 45°`, q(sc.errs, 0.5) <= (20 * Math.PI) / 180 && within45 >= 0.88 * sc.errs.length, `median ${(q(sc.errs, 0.5) * R2D).toFixed(0)}°, ${pct(within45, sc.errs.length)}`);
  check(`[${axes}] ≥ 80% of thrusts thrust`, thrustHit >= 0.8 * thrusts, `${thrustHit}/${thrusts}`);
}

// ------------------------------------------------------------------ 2. lazy, gentle and no swings
console.log('\n— lazy swings, too-gentle swings, and none');
{
  const lazy = newScore();
  const gentle = { swings: 0, struck: 0, near: 0 };
  let idleStrikes = 0,
    idleSecs = 0;
  for (let n = 0; n < Math.max(10, PEOPLE / 2); n++) {
    const R = rng(7000 + n);
    const person = randomPerson(R);
    // lazy: 240–330°/s at the peak
    const sim = new HandSim(person, R);
    let t = 1.6;
    for (let k = 0; k < 8; k++) t = sim.slash(t, DIRS[k], R.range(4.2, 5.8)) + R.range(0, 0.6);
    const p = play(sim.run(t, { ios: true, calErr: R.gauss() * 0.25 }), true);
    score(sim.meant, p, lazy, `lazy #${n}`);
    // too gentle to be a swing (≤ ~130°/s), but not nothing
    const g = new HandSim(person, R);
    t = 1.6;
    for (let k = 0; k < 6; k++) {
      t = g.slash(t, DIRS[(k * 3) % 8], R.range(1.2, 2.2), false) + R.range(0, 0.6);
    }
    const pg = play(g.run(t, { ios: true }), true);
    gentle.swings += 6;
    gentle.struck += pg.strikes.length;
    // standing ready, aiming about slowly (≤ 2 rad/s), for 20 s
    const idle = new HandSim(person, R);
    idle.aim(1.5, 18, 2);
    const pi = play(idle.run(21, { ios: true }), true);
    idleStrikes += pi.strikes.length;
    idleSecs += 20;
    // a little quicker: a nudge that's nearly a swing (~150–190°/s) → "swing harder", not a strike
    const nh = new HandSim(person, R);
    nh.slash(1.6, DIRS[n % 8], R.range(2.9, 3.3), false);
    const pn = play(nh.run(3.2, { ios: true }), true);
    gentle.near += pn.near.length > 0 && pn.strikes.length === 0 ? 1 : 0;
  }
  const n = Math.max(10, PEOPLE / 2);
  console.log(`  lazy (240–330°/s): ${pct(lazy.hit, lazy.swings)} struck, direction median ${(q(lazy.errs, 0.5) * R2D).toFixed(0)}°`);
  check('lazy swings (240–330°/s): ≥ 90% strike', lazy.hit >= 0.9 * lazy.swings, pct(lazy.hit, lazy.swings));
  check('too gentle (70–130°/s): never a strike', gentle.struck === 0, `${gentle.struck} of ${gentle.swings}`);
  check('nearly a swing (~170°/s): mostly "swing harder", never a strike', gentle.near >= 0.6 * n, `${gentle.near}/${n}`);
  check(`standing ready and aiming about, ${idleSecs} s: no strikes`, idleStrikes === 0, `${idleStrikes}`);
}

// ------------------------------------------------------------------ 3. the guard
console.log('\n— holding GUARD');
{
  let strikes = 0,
    told = 0;
  for (let n = 0; n < Math.max(10, PEOPLE / 2); n++) {
    const R = rng(8000 + n);
    const sim = new HandSim(randomPerson(R), R);
    sim.guard(1.5, 3, 4);
    // and a swing made with the guard still held
    sim.guard(5.5, 1.6, 0);
    sim.slash(5.8, DIRS[n % 8], 9);
    const p = play(sim.run(8, { ios: true }), true);
    strikes += p.strikes.length;
    told += p.guarded.length ? 1 : 0;
  }
  check('angling the guard (brisk turns) and swinging while holding it: no strikes', strikes === 0, `${strikes}`);
  check('a swing with the guard held is reported ("let go of GUARD")', told >= Math.max(10, PEOPLE / 2) * 0.8, `${told}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? 'Some realistic-sword checks FAILED.' : 'All realistic-sword checks passed.');
process.exitCode = fail ? 1 : 0;
