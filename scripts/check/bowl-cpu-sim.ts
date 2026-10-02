// Headless bowling games (the real referee + physics) for each CPU level:
// average score, strikes, spares, gutters — to tune how good each CPU is.
//   npx tsx scripts/check/bowl-cpu-sim.ts [games per level = 8]
import { BowlPhysics } from '../../src/tv/bowling/physics';
import { BowlingGame, START_X, type Bowler } from '../../src/tv/bowling/game';
import { BowlScore } from '../../src/tv/bowling/score';

const N = Number(process.argv[2] ?? 8);
const phys = await BowlPhysics.load();
const look = {} as Bowler['look'];
for (const [label, skill] of [['Rookie', 0.3], ['Pro', 0.65], ['Ace', 0.9]] as const) {
  const scores: number[] = [];
  let strikes = 0, spares = 0, firsts = 0, spareChances = 0, gutters = 0, balls = 0;
  const t0 = performance.now();
  for (let n = 0; n < N; n++) {
    for (const handed of [1, -1] as const) {
      const b: Bowler = { name: 'CPU', color: '#fff', look, handed, slot: -1, cpu: skill, score: new BowlScore(), x: START_X * handed, aim: 0 };
      const g = new BowlingGame([b], phys);
      let first = true;
      g.onEvent = (e) => {
        if (e.type !== 'result') return;
        balls++;
        if (e.mark === 'gutter') gutters++;
        const fresh = e.ball === 0 || (e.frame === 9 && first);
        if (fresh) {
          firsts++;
          if (e.mark === 'strike') strikes++;
          else spareChances++;
          first = e.mark === 'strike';
        } else {
          if (e.mark === 'spare') spares++;
          first = true;
        }
      };
      let t = 0;
      while (g.state !== 'over' && t < 1200) {
        g.step(1 / 60);
        t += 1 / 60;
      }
      scores.push(b.score.total());
    }
  }
  const avg = scores.reduce((a, c) => a + c, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, c) => a + (c - avg) ** 2, 0) / scores.length);
  console.log(`${label.padEnd(7)} skill ${skill}: avg ${avg.toFixed(0)} ±${sd.toFixed(0)} (min ${Math.min(...scores)}, max ${Math.max(...scores)}) · strikes ${((100 * strikes) / firsts).toFixed(0)}% · spares ${((100 * spares) / Math.max(1, spareChances)).toFixed(0)}% · gutters ${gutters}/${balls} · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
