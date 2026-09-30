// CPU time of BowlingGame.step (60 fps frames) while the bowler aims/walks: the ball is not in the
// Rapier world, every pin is asleep — the solver has nothing to do, and the physics skips it.
// Then a throw after a short and a long wait, to eyeball that the skip leaves the throw as it was.
//   npx tsx scripts/bowl-idle-bench.ts
import { BowlPhysics } from '../src/tv/bowling/physics';
import { BowlingGame, START_X } from '../src/tv/bowling/game';
import { BowlScore } from '../src/tv/bowling/score';

type Bowler = import('../src/tv/bowling/game').Bowler;
const phys = await BowlPhysics.load();
const look = {} as Bowler['look'];
const person = (): Bowler => ({ name: 'P', color: '#fff', look, handed: 1, slot: 0, cpu: null, score: new BowlScore(), x: START_X, aim: 0 });
const run = (g: BowlingGame, secs: number) => {
  for (let n = Math.round(secs * 60); n > 0; n--) g.step(1 / 60);
};

// --- the cost of a step while aiming
const REPS = 40;
const FRAMES = 60 * 3;
const per: number[] = [];
for (let rep = 0; rep < REPS + 3; rep++) {
  const g = new BowlingGame([person()], phys);
  g.startNow();
  g.grip(0, true);
  run(g, 1.0); // the rack seats and falls asleep
  const t0 = performance.now();
  for (let n = 0; n < FRAMES; n++) g.step(1 / 60);
  const ms = performance.now() - t0;
  if (rep >= 3) per.push((ms * 1000) / FRAMES); // (the first few warm the JIT up)
}
per.sort((a, b) => a - b);
const mean = per.reduce((a, b) => a + b, 0) / per.length;
console.log(`game.step while aiming (${REPS} × ${FRAMES} frames): mean ${mean.toFixed(1)} µs, median ${per[per.length >> 1].toFixed(1)} µs, p90 ${per[Math.floor(per.length * 0.9)].toFixed(1)} µs per 60 fps frame`);

// --- a throw after the wait: the result (pins, score) and the ball's path
const play = (wait: number) => {
  const g = new BowlingGame([person()], phys);
  g.startNow();
  g.grip(0, true);
  run(g, wait);
  g.release(0, { speed: 7.5, angle: 0.03, spin: 0.9 });
  const path: string[] = [];
  for (let n = 0; n < 60 * 12 && g.state !== 'result'; n++) {
    g.step(1 / 60);
    if (n % 20 === 0) path.push(`${phys.view.ball.x.toFixed(4)},${phys.view.ball.z.toFixed(4)}`);
  }
  run(g, 0.5);
  return `${phys.standing().map((s) => (s ? 1 : 0)).join('')} ${path.join(' ')}`;
};
for (const wait of [1.0, 2.5]) console.log(`throw after ${wait} s of aiming:`, play(wait).slice(0, 110));
