// A simulated human (swings with a timing error) against the CPU, over several seeds, in two modes:
//   sim    the human swings when the SIM ball reaches the plan's contact time (+ error): the old build's model
//   drawn  the human swings when the DRAWN ball does: the ball drawn at a human's racket is held (Match.holdWarp),
//          so a person swings at a later sim time; the judgement maps it back (Match.judgedTime), so the timing
//          they get (tau) should match the old build's, within noise
// The swing is heard AGE seconds after it was made (default 0.03; AGE=0.08 for a phone through the network).
// ONSET=1 has the phone's swing-start (its onset, LEAD s before the swing, default 0.1) reach the match first, AGE after it was made: the
// character's stroke starts on it. It only animates, so every number and the event hash must equal the run without it.
//   npx tsx scripts/sim-human.ts            (SEEDS=12 for tighter numbers; MODE=sim|drawn for one; ONSET=1)
import { Match, type MatchEvent } from '../src/tv/tennis/match';
import { AI_LEVELS } from '../src/tv/tennis/ai';
import { Rng } from '../src/tv/core/math';
import { EventHash, seedMathRandom } from './sim-hash';

const seedOff = +(process.env.SEED ?? 0);
const SEEDS = +(process.env.SEEDS ?? 8);
const AGE = +(process.env.AGE ?? 0.03);
const ONSET = process.env.ONSET === '1';
const LEAD = +(process.env.LEAD ?? 0.1);
const MODES = process.env.MODE ? [process.env.MODE] : ['sim', 'drawn'];

interface Out { hits: number; perfect: number; whiffs: number; taus: number[]; lat: number[]; won: number; lost: number; rallies: number[]; hash: string }

function run(level: string, timingSigma: number, seed0: number, drawn: boolean): Out {
  const seed = seed0 + seedOff;
  seedMathRandom(seed);
  const r = new Rng(seed);
  const players: any[] = [
    { team: 0, name: 'Human', look: {}, handed: 1, ctrl: { kind: 'human', slot: 0, ai: AI_LEVELS.auto } },
    { team: 1, name: 'CPU', look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[level] } },
  ];
  const m = new Match({ doubles: false, gamesToWin: 3, players, seed, introTime: 0.1 });
  const o: Out = { hits: 0, perfect: 0, whiffs: 0, taus: [], lat: [], won: 0, lost: 0, rallies: [], hash: '' };
  const hash = new EventHash();
  let callT = -1;
  m.onEvent = (e: MatchEvent) => {
    hash.add(m.t, e);
    if (e.type === 'point') { if (e.winner === 0) o.won++; else o.lost++; o.rallies.push(e.rally); }
    if (e.type === 'hit' && e.p.human) { o.hits++; if (callT >= 0) { o.lat.push(m.t - callT); callT = -1; } o.taus.push(e.tau); if (e.perfect) o.perfect++; }
    if (e.type === 'whiff' && e.p.human) o.whiffs++;
  };
  let planned: any = null, swingAt = 0, started = false;
  const hp = m.players[0];
  for (let i = 0; i < 120 * 60 * 30 && m.state !== 'over'; i++) {
    m.step(1 / 120);
    if (m.state === 'serve' && m.server === hp && m.t - m.stateT0 > 0.8) m.humanToss(0);
    if (m.state === 'toss' && m.server === hp && !hp.swing && m.t >= hp.tossT + 0.78 + r.gauss() * 0.1 - 0.02) m.humanSwing(0, { power: r.range(0.4, 1), spin: 0.2 }, m.t - 0.02);
    if (hp.plan && hp.plan !== planned) {
      planned = hp.plan;
      const want = hp.plan.t + r.gauss() * timingSigma; // when the ball, as seen, is at the racket (± the error)
      // (the sim time that is: the drawn clock runs slow near a human's contact)
      swingAt = drawn && (m as any).swingTimeFor ? m.swingTimeFor(hp.plan, want) : want;
      started = false;
    }
    if (ONSET && planned && hp.plan === planned && !started && m.t >= swingAt - LEAD + AGE && m.t < swingAt + AGE) {
      started = true;
      m.humanSwingStart(0, undefined, swingAt - LEAD);
    }
    if (planned && hp.plan === planned && m.t >= swingAt + AGE) {
      callT = m.t;
      m.humanSwing(0, { power: Math.min(1, Math.max(0, r.range(0.35, 1.05))), spin: r.gauss() * 0.4 + 0.15 }, swingAt);
      if (!hp.swing?.hit) callT = -1; // a whiff: nothing to time
      planned = null;
    }
  }
  o.hash = String(hash);
  return o;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const sd = (a: number[]) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
const cases: [string, number, number][] = [['rookie', 0.06, 1], ['club', 0.06, 5], ['club', 0.1, 6], ['pro', 0.06, 2], ['pro', 0.1, 3], ['ace', 0.06, 4]];
console.log(`age ${AGE} s, ${SEEDS} seeds each`);
for (const [level, sigma, s0] of cases) {
  for (const mode of MODES) {
    const A: Out[] = [];
    for (let s = 0; s < SEEDS; s++) A.push(run(level, sigma, s0 + s * 101, mode === 'drawn'));
    const hits = A.reduce((a, x) => a + x.hits, 0);
    const taus = A.flatMap((x) => x.taus);
    const won = A.reduce((a, x) => a + x.won, 0), lost = A.reduce((a, x) => a + x.lost, 0);
    const lat = A.flatMap((x) => x.lat);
    const rallies = A.flatMap((x) => x.rallies);
    const whiffs = A.reduce((a, x) => a + x.whiffs, 0);
    console.log(
      `${level.padEnd(6)} σ=${sigma} ${mode.padEnd(5)} hits ${String(hits).padStart(4)}  tau ${mean(taus).toFixed(3)} ± ${sd(taus).toFixed(3)}  perfect ${((A.reduce((a, x) => a + x.perfect, 0) / hits) * 100).toFixed(1)}%  ` +
        `whiffs/swing ${((whiffs / (hits + whiffs)) * 100).toFixed(1)}%  human pts ${((won / (won + lost)) * 100).toFixed(0)}%  rally ${mean(rallies).toFixed(1)}  call→hit ${(Math.max(0, ...lat) * 1000).toFixed(1)} ms max  ${A[0].hash}`,
    );
  }
}
