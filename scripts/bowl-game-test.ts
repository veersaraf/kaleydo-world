// Referee checks: split detection.
import { isSplit } from '../src/tv/bowling/game';
const s = (...up: number[]) => Array.from({ length: 10 }, (_, i) => up.includes(i + 1));
const cases: [boolean[], boolean, string][] = [
  [s(7, 10), true, '7-10'],
  [s(4, 6), true, '4-6'],
  [s(2, 7), true, '2-7 baby split (4 missing between)'],
  [s(2, 4), false, '2-4 touching'],
  [s(1, 7, 10), false, 'head pin up'],
  [s(10), false, 'single pin'],
  [s(4, 7, 9, 10), true, 'big four-ish'],
  [s(5, 8, 9), false, 'bucket-ish connected'],
  [s(3, 10), true, '3-10 baby split'],
];
let fail = 0;
for (const [st, want, name] of cases) {
  const got = isSplit(st);
  if (got !== want) {
    fail++;
    console.log('FAIL', name, 'got', got);
  }
}
console.log(fail ? `${fail} failures` : 'All referee checks passed.');

// A phone's message is `age` s old: the walk-up started that long ago, and the ball has already rolled that far.
{
  const { BowlPhysics } = await import('../src/tv/bowling/physics');
  const { BowlingGame, START_X } = await import('../src/tv/bowling/game');
  const { BowlScore } = await import('../src/tv/bowling/score');
  const { FOUL_Z } = await import('../src/tv/bowling/lane');
  type Bowler = import('../src/tv/bowling/game').Bowler;
  const phys = await BowlPhysics.load();
  const look = {} as Bowler['look'];
  const person = (): Bowler => ({ name: 'P', color: '#fff', look, handed: 1, slot: 0, cpu: null, score: new BowlScore(), x: START_X, aim: 0 });
  const run = (g: InstanceType<typeof BowlingGame>, secs: number) => {
    for (let n = Math.round(secs * 60); n > 0; n--) g.step(1 / 60);
  };
  const ready = () => {
    const g = new BowlingGame([person()], phys);
    g.startNow();
    run(g, 0.1);
    return g;
  };
  let bad = 0;
  const check = (c: boolean, m: string, got?: unknown) => {
    if (!c) {
      bad++;
      console.log('FAIL', m, got ?? '');
    }
  };
  const thr = { speed: 7.5, angle: 0.5, spin: 0.3 };
  // the release: heard 0.12 s late with age 0.12, the ball is where one let go on time is at the same moment
  const onTime = (() => {
    const g = ready();
    g.grip(0, true);
    run(g, 1.5);
    g.release(0, thr);
    run(g, 0.62);
    return { z: phys.view.ball.z, x: phys.view.ball.x };
  })();
  const aged = (() => {
    const g = ready();
    g.grip(0, true);
    run(g, 1.5 + 0.12);
    g.release(0, thr, 0.12);
    const at = { z: phys.view.ball.z };
    run(g, 0.5);
    return { z: phys.view.ball.z, x: phys.view.ball.x, at, body: g.body.t };
  })();
  const plain = (() => {
    const g = ready();
    g.grip(0, true);
    run(g, 1.5 + 0.12);
    g.release(0, thr);
    run(g, 0.5);
    return { z: phys.view.ball.z, body: g.body.t };
  })();
  check(Math.abs(onTime.z - aged.z) < 0.06 &&Math.abs(onTime.x - aged.x) < 0.01, 'released 0.12 s late with age 0.12 = released on time (same place at the same moment)', [onTime, aged]);
  check(plain.z - aged.z > 0.12 * 7.5 * 0.8, 'without the age it would be a step behind', [plain.z, aged.z]);
  check(aged.at.z < FOUL_Z - 0.7, 'right at the release it has already rolled 0.12 s', aged.at);
  check(aged.body > plain.body + 0.1, 'and the follow-through is 0.12 s along', [plain.body, aged.body]);
  // the grip: the walk-up is under way that long ago
  const step = (age: number) => {
    const g = ready();
    if (age > 0) run(g, age);
    g.grip(0, true, age);
    run(g, 1 / 60);
    return g.body.step;
  };
  check(step(0.2) > step(0) + 0.05, 'a grip heard 0.2 s late starts the walk-up 0.2 s in', [step(0), step(0.2)]);
  // a tap with no swing behind it is still not a throw, however old
  const g = ready();
  g.grip(0, true);
  run(g, 0.2);
  g.release(0, { speed: 1, angle: 0, spin: 0 }, 0.15);
  check(g.state === 'ready', 'a tap is not a throw', g.state);
  console.log(bad ? `${bad} bowling latency checks FAILED` : 'All bowling latency checks passed.');
  if (bad) process.exit(1);
}
