// Smash opportunities: how often a human gets a smash chance, and how often
// they put it away. Human swings are simulated with a timing sigma and a
// random-ish power; the CPU is a normal level. Also reports CPU smashes.
import { Match, type MatchEvent } from '../src/tv/tennis/match';
import { AI_LEVELS } from '../src/tv/tennis/ai';
import { Rng } from '../src/tv/core/math';

const sources: Record<string, number> = {};
function run(level: string, timingSigma: number, seed: number, doubles = false, games = 3) {
  const r = new Rng(seed);
  const players: any[] = [{ team: 0, name: 'Human', look: {}, handed: 1, ctrl: { kind: 'human', slot: 0, ai: AI_LEVELS.auto } }];
  if (doubles) players.push({ team: 0, name: 'Mate', look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[level] } });
  players.push({ team: 1, name: 'CPU', look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[level] } });
  if (doubles) players.push({ team: 1, name: 'CPU2', look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[level] } });
  const m = new Match({ doubles, gamesToWin: games, players, seed, introTime: 0.1 });
  const rallies: number[] = [];
  let chances = 0,
    smashes = 0,
    smashWon = 0,
    cpuSmash = 0,
    cpuSmashWon = 0,
    humanPts = 0,
    missed = 0;
  let lastSmashBy: 'h' | 'c' | null = null;
  const cpuKinds: Record<string, number> = {};
  let chanceOpen = false;
  let lastKind = '';
  m.onEvent = (e: MatchEvent) => {
    if (e.type === 'smash-chance') {
      chances++;
      const src = (m.ball.pop ? 'pop:' : 'high:') + (m.ball.lastHitter?.human ? 'self' : lastKind) + (e.p.plan?.volley ? '/air' : '/bounce');
      sources[src] = (sources[src] || 0) + 1;
      chanceOpen = true;
    }
    if (e.type === 'hit') {
      if (e.p.human) {
        if (chanceOpen && e.kind !== 'smash') missed++;
        chanceOpen = false;
        if (e.kind === 'smash') {
          smashes++;
          lastSmashBy = 'h';
        } else if (e.kind !== 'error' && e.kind !== 'shank') lastSmashBy = null;
      } else {
        lastKind = e.kind;
        if (e.p.team === 1) cpuKinds[e.kind] = (cpuKinds[e.kind] || 0) + 1;
        // a smash forces an error: still the smash's point
        if (e.p.team === 1 && e.kind !== 'error') lastSmashBy = e.kind === 'smash' ? 'c' : null;
        if (e.kind === 'smash' && e.p.team === 1) cpuSmash++;
      }
    }
    if (e.type === 'whiff' && e.p.human && chanceOpen) {
      missed++;
      chanceOpen = false;
    }
    if (e.type === 'point') {
      rallies.push(e.rally);
      if (e.winner === 0) humanPts++;
      if (lastSmashBy === 'h' && e.winner === 0) smashWon++;
      if (lastSmashBy === 'c' && e.winner === 1) cpuSmashWon++;
      if (chanceOpen) missed++;
      chanceOpen = false;
      lastSmashBy = null;
    }
  };
  let planned: any = null,
    swingAt = 0;
  const hp = m.players[0];
  for (let i = 0; i < 120 * 60 * 40 && m.state !== 'over'; i++) {
    m.step(1 / 120);
    if (m.state === 'serve' && m.server === hp && m.t - m.stateT0 > 0.8) m.humanToss(0);
    if (m.state === 'toss' && m.server === hp && !hp.swing && m.t >= hp.tossT + 0.78 + r.gauss() * 0.1 - 0.02)
      m.humanSwing(0, { power: r.range(0.4, 1), spin: 0.2 }, m.t - 0.02);
    if (hp.plan && hp.plan !== planned) {
      planned = hp.plan;
      swingAt = hp.plan.t + r.gauss() * timingSigma;
    }
    if (planned && hp.plan === planned && m.t >= swingAt + 0.03) {
      m.humanSwing(0, { power: Math.min(1, Math.max(0, r.range(0.35, 1.05))), spin: r.gauss() * 0.4 + 0.15, side: r.chance(0.5) ? 'fh' : 'bh' }, swingAt);
      planned = null;
    }
  }
  const n = rallies.length;
  const avg = rallies.reduce((a, b) => a + b, 0) / n;
  return { n, humanPts, avg, chances, smashes, smashWon, missed, cpuSmash, cpuSmashWon, cpuKinds };
}

const cases: [string, number, boolean][] = [
  ['rookie', 0.06, false],
  ['club', 0.06, false],
  ['club', 0.1, false],
  ['pro', 0.06, false],
  ['pro', 0.1, false],
  ['ace', 0.06, false],
  ['club', 0.08, true],
  ['pro', 0.08, true],
];
const seeds = +(process.env.SEEDS ?? 6);
for (const [lvl, sig, dbl] of cases) {
  const a = { n: 0, humanPts: 0, rallySum: 0, chances: 0, smashes: 0, smashWon: 0, missed: 0, cpuSmash: 0, cpuSmashWon: 0, kinds: {} as Record<string, number> };
  for (let s = 1; s <= seeds; s++) {
    const o = run(lvl, sig, s * 17 + (dbl ? 5 : 0), dbl);
    a.n += o.n;
    a.humanPts += o.humanPts;
    a.rallySum += o.avg * o.n;
    a.chances += o.chances;
    a.smashes += o.smashes;
    a.smashWon += o.smashWon;
    a.missed += o.missed;
    a.cpuSmash += o.cpuSmash;
    a.cpuSmashWon += o.cpuSmashWon;
    for (const k in o.cpuKinds) a.kinds[k] = (a.kinds[k] || 0) + o.cpuKinds[k];
  }
  console.log(
    `${lvl.padEnd(6)} σ=${sig}${dbl ? ' dbl' : '    '}  pts ${String(a.n).padStart(3)}  human won ${((a.humanPts / a.n) * 100).toFixed(0)}%  rally ${(a.rallySum / a.n).toFixed(1)}  ` +
      `chances/pt ${(a.chances / a.n).toFixed(2)}  smashed ${a.smashes}/${a.chances} (missed ${a.missed})  won ${a.smashWon}/${a.smashes} (${((a.smashWon / Math.max(1, a.smashes)) * 100).toFixed(0)}%)  ` +
      `| cpu smash ${a.cpuSmash} (won ${a.cpuSmashWon})`,
  );
  if (process.env.KINDS) console.log('        cpu kinds', a.kinds);
  if (process.env.SOURCES) {
    console.log('        chance sources', { ...sources });
    for (const k in sources) delete sources[k];
  }
}
