// Rush vs the standard game: the same seeds played with rush off and on, CPU vs CPU and a simulated
// human (as sim-human.ts) vs each CPU level. Prints per config how the rally shape changes:
// points, mean / max rally, how points end, drive speed by heat, how often a rally reaches full
// heat (fire) and how often the simulated human gets a racket on the ball.
//
//   npx tsx scripts/check/sim-rush.ts            (N=8 matches per config; N=20 SEED=100 for a bigger sample)
//
// "unreturned" here is ace + winner (the ball bounced twice: nobody got to it); "out" is long +
// wide + out. The heat of a hit is worked out with heatAfter from the hit events in BOTH modes, so
// the standard game's rows show what the same rally position would be in Rush.
import { Match, type MatchEvent } from '../../src/tv/tennis/match';
import { AI_LEVELS } from '../../src/tv/tennis/ai';
import { heatAfter, onFire } from '../../src/tv/tennis/rush';
import { Rng } from '../../src/tv/core/math';
import { seedMathRandom } from './sim-hash';

const N = +(process.env.N ?? 8);
const seedOff = +(process.env.SEED ?? 0);

interface Stats {
  points: number;
  rallies: number[];
  reasons: Record<string, number>;
  kphSum: number[];
  kphN: number[];
  /** seconds from a rally drive's contact to the opponent's next contact, by the heat before the drive */
  h2hSum: number[];
  h2hN: number[];
  impactSum: number;
  impactN: number;
  fire: number;
  longRallies: number;
  longFire: number;
  humanReturns: number;
  humanLost: number;
  humanWon: number;
  whiffs: number;
  matches: number;
  minutes: number;
}
const stats = (): Stats => ({ points: 0, rallies: [], reasons: {}, kphSum: [0, 0, 0], kphN: [0, 0, 0], h2hSum: [0, 0, 0], h2hN: [0, 0, 0], impactSum: 0, impactN: 0, fire: 0, longRallies: 0, longFire: 0, humanReturns: 0, humanLost: 0, humanWon: 0, whiffs: 0, matches: 0, minutes: 0 });

function play(levelB: string, humanSigma: number | null, levelA: string, seed: number, rush: boolean, st: Stats) {
  seedMathRandom(seed);
  const r = new Rng(seed);
  const players: any[] = [];
  if (humanSigma !== null) {
    players.push({ team: 0, name: 'Human', look: {}, handed: 1, ctrl: { kind: 'human', slot: 0, ai: AI_LEVELS.auto } });
    players.push({ team: 1, name: 'CPU', look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[levelB] } });
  } else {
    for (const team of [0, 1] as const) players.push({ team, name: `T${team}`, look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[team === 0 ? levelA : levelB] } });
  }
  const m = new Match({ doubles: false, gamesToWin: 3, players, seed, introTime: 0.1, rush });
  let heat = 0; // the heat the hit events imply
  let peak = 0;
  let lastT = -1, lastB = -1, lastP: unknown = null; // the previous rally drive's contact time, heat bucket and player
  m.onEvent = (e: MatchEvent) => {
    if (e.type === 'bounce' && e.live && e.first && m.rally > 1) {
      st.impactSum += e.impact;
      st.impactN++;
    }
    if (e.type === 'hit') {
      const pre = heat;
      if (lastB >= 0 && e.p !== lastP) {
        st.h2hSum[lastB] += m.t - lastT;
        st.h2hN[lastB]++;
      }
      lastB = -1;
      if (e.kind !== 'serve') {
        if (e.kind === 'drive' || e.kind === 'volley') {
          const b = pre < 1 / 3 ? 0 : pre < 2 / 3 ? 1 : 2;
          st.kphSum[b] += e.kph;
          st.kphN[b]++;
          lastB = b;
          lastT = m.t;
          lastP = e.p;
        }
        if (e.p.human) st.humanReturns++;
      }
      heat = heatAfter(pre, { serve: e.kind === 'serve', perfect: e.perfect });
      peak = Math.max(peak, heat);
      if (rush && Math.abs(heat - m.heat) > 1e-9) throw new Error(`heat drift ${heat} vs ${m.heat}`);
    }
    if (e.type === 'whiff' && e.p.human) st.whiffs++;
    if (e.type === 'point') {
      st.points++;
      st.rallies.push(e.rally);
      st.reasons[e.reason] = (st.reasons[e.reason] || 0) + 1;
      if (onFire(peak)) st.fire++;
      if (e.rally >= 8) {
        st.longRallies++;
        if (onFire(peak)) st.longFire++;
      }
      if (humanSigma !== null) {
        if (e.winner === 0) st.humanWon++;
        else if (e.reason === 'winner' || e.reason === 'ace') st.humanLost++;
      }
      heat = 0;
      peak = 0;
      lastB = -1;
    }
  };
  let planned: any = null,
    swingAt = 0;
  const hp = m.players[0];
  for (let i = 0; i < 120 * 60 * 30 && m.state !== 'over'; i++) {
    m.step(1 / 120);
    if (humanSigma === null) continue;
    if (m.state === 'serve' && m.server === hp && m.t - m.stateT0 > 0.8) m.humanToss(0);
    if (m.state === 'toss' && m.server === hp && !hp.swing && m.t >= hp.tossT + 0.78 + r.gauss() * 0.1 - 0.02) m.humanSwing(0, { power: r.range(0.4, 1), spin: 0.2 }, m.t - 0.02);
    if (hp.plan && hp.plan !== planned) {
      planned = hp.plan;
      swingAt = hp.plan.t + r.gauss() * humanSigma;
    }
    if (planned && hp.plan === planned && m.t >= swingAt + 0.03) {
      m.humanSwing(0, { power: Math.min(1, Math.max(0, r.range(0.35, 1.05))), spin: r.gauss() * 0.4 + 0.15 }, swingAt);
      planned = null;
    }
  }
  st.matches++;
  st.minutes += m.t / 60;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(0) : '-').padStart(3) + '%';
const unret = (s: Stats) => ((s.reasons.winner || 0) + (s.reasons.ace || 0)) / Math.max(1, s.points);

function report(label: string, off: Stats, on: Stats, human: boolean) {
  console.log(`\n== ${label}  (${off.matches} matches per mode)`);
  const row = (name: string, f: (s: Stats) => string) => console.log(`  ${name.padEnd(38)} ${f(off).padStart(22)} ${f(on).padStart(22)}`);
  console.log(`  ${''.padEnd(38)} ${'standard'.padStart(22)} ${'rush'.padStart(22)}`);
  row('points (minutes)', (s) => `${s.points} (${s.minutes.toFixed(0)}m)`);
  row('rally mean / max', (s) => `${mean(s.rallies).toFixed(1)} / ${Math.max(0, ...s.rallies)}`);
  row('unreturned (ace+winner)', (s) => pct((s.reasons.winner || 0) + (s.reasons.ace || 0), s.points));
  row('  of which ace', (s) => pct(s.reasons.ace || 0, s.points));
  row('out (long+wide+out)', (s) => pct((s.reasons.long || 0) + (s.reasons.wide || 0) + (s.reasons.out || 0), s.points));
  row('net', (s) => pct(s.reasons.net || 0, s.points));
  row('double fault', (s) => pct(s.reasons.double || 0, s.points));
  row('drive kph, heat 0-.33/.33-.66/.66-1', (s) => [0, 1, 2].map((b) => (s.kphN[b] ? (s.kphSum[b] / s.kphN[b]).toFixed(0) : '-')).join(' / '));
  row('hit-to-hit s, heat 0-.33/.33-.66/.66-1', (s) => [0, 1, 2].map((b) => (s.h2hN[b] ? (s.h2hSum[b] / s.h2hN[b]).toFixed(2) : '-')).join(' / '));
  console.log(`  ${'hit-to-hit, rush / standard'.padEnd(38)} ${[0, 1, 2].map((b) => (off.h2hN[b] && on.h2hN[b] ? (on.h2hSum[b] / on.h2hN[b] / (off.h2hSum[b] / off.h2hN[b])).toFixed(2) + 'x' : '-')).join(' / ').padStart(45)}`);
  row('mean bounce impact m/s (rally)', (s) => (s.impactSum / Math.max(1, s.impactN)).toFixed(1));
  row('points reaching fire', (s) => `${pct(s.fire, s.points)} (${s.fire})`);
  row('rallies >= 8 reaching fire', (s) => `${pct(s.longFire, s.longRallies)} (${s.longFire}/${s.longRallies})`);
  if (human) {
    row('human return rate', (s) => pct(s.humanReturns, s.humanReturns + s.humanLost));
    row('human whiffs', (s) => `${s.whiffs}`);
    row('human points won', (s) => pct(s.humanWon, s.points));
  }
}

const add = (t: Stats, s: Stats) => {
  t.points += s.points;
  t.rallies.push(...s.rallies);
  t.fire += s.fire;
  t.longRallies += s.longRallies;
  t.longFire += s.longFire;
  for (const k in s.reasons) t.reasons[k] = (t.reasons[k] || 0) + s.reasons[k];
  for (let b = 0; b < 3; b++) {
    t.kphSum[b] += s.kphSum[b];
    t.kphN[b] += s.kphN[b];
    t.h2hSum[b] += s.h2hSum[b];
    t.h2hN[b] += s.h2hN[b];
  }
  t.impactSum += s.impactSum;
  t.impactN += s.impactN;
  t.humanReturns += s.humanReturns;
  t.humanLost += s.humanLost;
  t.humanWon += s.humanWon;
  t.whiffs += s.whiffs;
  t.matches += s.matches;
  t.minutes += s.minutes;
};

const totalCpu = { off: stats(), on: stats() };
const totalHuman = { off: stats(), on: stats() };
const summary: string[] = [];
function config(label: string, a: string, b: string, humanSigma: number | null) {
  const off = stats(),
    on = stats();
  for (let i = 0; i < N; i++) {
    const seed = 1000 + i * 7 + seedOff;
    play(b, humanSigma, a, seed, false, off);
    play(b, humanSigma, a, seed, true, on);
  }
  report(label, off, on, humanSigma !== null);
  const tot = humanSigma === null ? totalCpu : totalHuman;
  add(tot.off, off);
  add(tot.on, on);
  summary.push(
    `${label.padEnd(26)} rally ${((mean(on.rallies) / mean(off.rallies)) * 100).toFixed(0)}%  unreturned x${(unret(on) / Math.max(1e-9, unret(off))).toFixed(2)}` +
      (humanSigma !== null ? `  human return ${pct(off.humanReturns, off.humanReturns + off.humanLost)} -> ${pct(on.humanReturns, on.humanReturns + on.humanLost)}` : ''),
  );
}

for (const [a, b] of [['rookie', 'rookie'], ['club', 'club'], ['pro', 'pro'], ['ace', 'ace'], ['ace', 'rookie'], ['pro', 'club']]) config(`cpu ${a} vs ${b}`, a, b, null);
for (const [lv, sg] of [['rookie', 0.06], ['club', 0.06], ['club', 0.1], ['pro', 0.06], ['pro', 0.1], ['ace', 0.06]] as [string, number][]) config(`human σ=${sg} vs ${lv}`, 'human', lv, sg);
report('ALL CPU vs CPU', totalCpu.off, totalCpu.on, false);
report('ALL human vs CPU', totalHuman.off, totalHuman.on, true);
console.log('\nsummary (rush relative to standard):\n  ' + summary.join('\n  '));
