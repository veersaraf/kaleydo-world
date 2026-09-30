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
for (const [level, sigma, s0] of process.env.SINGLES === '0' ? [] : cases) {
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

// ---- DOUBLES: the simulated human is the NET player ("Human & CPU vs CPU & CPU", the human every point at the net and never serving).
// Besides the balls the match gives them, they swing at every ball that comes within their reach from where they stand (the partner's
// balls too), as a person at the net does: the swing's onset reaches the match LEAD s before the swing (both AGE s old). A build that
// lets a human take such a ball (Match.poach) turns those swings into volleys; one that does not, into 'noball' whiffs.
//   npx tsx scripts/sim-human.ts    (DOUBLES=0 leaves this out, SINGLES=0 the rest; POACH=0 stops humans taking a ball they were not given, for comparison; AGE=0.08 here unless set)
if (process.env.DOUBLES !== '0') {
  const DAGE = +(process.env.AGE ?? 0.08);
  const DLEAD = 0.1;
  interface DOut { hits: number; volleys: number; whiffs: number; noball: number; won: number; lost: number; poachHits: number; tries: number; rallies: number[]; hash: string }
  const runDoubles = (level: string, sigma: number, seed0: number): DOut => {
    const seed = seed0 + seedOff;
    seedMathRandom(seed);
    const r = new Rng(seed);
    const cpu = (team: 0 | 1, name: string) => ({ team, name, look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[level] } });
    const players: any[] = [cpu(0, 'Mate'), { team: 0, name: 'Human', look: {}, handed: 1, ctrl: { kind: 'human', slot: 0, ai: AI_LEVELS.auto } }, cpu(1, 'CPU1'), cpu(1, 'CPU2')];
    const m: any = new Match({ doubles: true, gamesToWin: 3, players, seed, introTime: 0.1 });
    const mate = m.players[0], hp = m.players[1];
    const swap = () => {
      const [hx, hz, mx, mz] = [hp.x, hp.z, mate.x, mate.z];
      hp.place(mx, mz);
      mate.place(hx, hz);
      [hp.role, mate.role] = [mate.role, hp.role];
    };
    const fix = () => {
      if (m.server === hp) {
        swap();
        m.server = mate;
        mate.holding = true;
        hp.holding = false;
        m.ball.holder = mate;
      } else if (hp.role === 'back') swap();
    };
    const sp = m.setupPoint.bind(m);
    m.setupPoint = () => {
      sp();
      fix();
    };
    fix();
    // (POACH=0: today's behaviour for comparison — a human never takes a ball they were not given)
    if (process.env.POACH === '0') m.poach = () => null;
    const o: DOut = { hits: 0, volleys: 0, whiffs: 0, noball: 0, won: 0, lost: 0, poachHits: 0, tries: 0, rallies: [], hash: '' };
    const hash = new EventHash();
    const q: { t: number; f: () => void }[] = [];
    let poachedTry = false;
    const poachable = (T: number) => {
      const arr = T - DLEAD + DAGE;
      const tMin = arr + 0.01;
      const plan = hp.planFrom(m.path, tMin - 0.08, arr - tMin + 0.1, { mustBounce: false, doubles: true, smash: m.ball.pop, at: Math.max(T - DLEAD + 0.1, tMin), spread: 0.12, stretch: 1.2 });
      return plan && plan.reachable && plan.volley && plan.stroke !== 'oh' ? plan : null;
    };
    m.onEvent = (e: MatchEvent) => {
      hash.add(m.t, e);
      if (e.type === 'point') { if (e.winner === 0) o.won++; else o.lost++; o.rallies.push(e.rally); }
      if (e.type === 'hit' && e.p === hp) {
        o.hits++;
        if (e.kind === 'volley') o.volleys++;
        if (poachedTry) { o.poachHits++; poachedTry = false; }
      }
      if (e.type === 'whiff' && e.p === hp) { o.whiffs++; if (e.why === 'noball') o.noball++; }
      // an opponent's ball the partner was given: if the net player can get to it from where they stand, they swing at it
      if (e.type === 'hit' && e.p.team === 1 && !e.serve && !hp.plan && mate.plan && !q.length) {
        for (let T = m.t + 0.2; T < m.t + 1.4; T += 0.02) {
          if (!poachable(T)) continue;
          const at = T + r.gauss() * sigma;
          const st = at - DLEAD;
          o.tries++;
          poachedTry = false;
          q.push({ t: st + DAGE, f: () => m.humanSwingStart(0, undefined, st) });
          q.push({ t: at + DAGE, f: () => { poachedTry = true; m.humanSwing(0, { power: Math.min(1, Math.max(0, r.range(0.35, 1.05))), spin: r.gauss() * 0.4 + 0.15 }, at); if (!hp.swing?.hit) poachedTry = false; } });
          break;
        }
      }
    };
    let planned: any = null, swingAt = 0, started = false;
    for (let i = 0; i < 120 * 60 * 40 && m.state !== 'over'; i++) {
      m.step(1 / 120);
      while (q.length && q[0].t <= m.t) q.shift()!.f();
      if (hp.plan && hp.plan !== planned && !q.length && hp.plan.holdFrom === undefined) {
        planned = hp.plan;
        swingAt = m.swingTimeFor(hp.plan, hp.plan.t + r.gauss() * sigma);
        started = false;
      }
      if (planned && hp.plan === planned && !started && m.t >= swingAt - DLEAD + DAGE && m.t < swingAt + DAGE) {
        started = true;
        m.humanSwingStart(0, undefined, swingAt - DLEAD);
      }
      if (planned && hp.plan === planned && m.t >= swingAt + DAGE) {
        m.humanSwing(0, { power: Math.min(1, Math.max(0, r.range(0.35, 1.05))), spin: r.gauss() * 0.4 + 0.15 }, swingAt);
        planned = null;
      }
    }
    o.hash = String(hash);
    return o;
  };
  console.log(`\ndoubles, the simulated human at the net (age ${DAGE} s, ${SEEDS} seeds each): swings at balls given to them, and at the partner's that they can reach`);
  for (const [level, sigma, s0] of [['club', 0.06, 11], ['pro', 0.06, 12], ['ace', 0.06, 13], ['club', 0.1, 14]] as [string, number, number][]) {
    const A: DOut[] = [];
    for (let s = 0; s < SEEDS; s++) A.push(runDoubles(level, sigma, s0 + s * 101));
    const sum = (f: (x: DOut) => number) => A.reduce((a, x) => a + f(x), 0);
    const won = sum((x) => x.won), lost = sum((x) => x.lost);
    console.log(
      `${level.padEnd(6)} σ=${sigma}  human hits ${String(sum((x) => x.hits)).padStart(4)} (${sum((x) => x.volleys)} volleys)  swings at the partner's balls ${String(sum((x) => x.tries)).padStart(3)} -> hits ${sum((x) => x.poachHits)}  ` +
        `'noball' whiffs ${String(sum((x) => x.noball)).padStart(3)}  all whiffs ${String(sum((x) => x.whiffs)).padStart(3)}  team pts ${((won / (won + lost)) * 100).toFixed(0)}% (${won}-${lost})  rally ${mean(A.flatMap((x) => x.rallies)).toFixed(1)}  ${A[0].hash}`,
    );
  }
}
