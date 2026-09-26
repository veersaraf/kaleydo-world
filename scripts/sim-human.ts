import { Match, type MatchEvent } from '../src/tv/tennis/match';
import { AI_LEVELS } from '../src/tv/tennis/ai';
import { Rng } from '../src/tv/core/math';

function run(level: string, timingSigma: number, seed: number) {
  const r = new Rng(seed);
  const players: any[] = [
    { team: 0, name: 'Human', look: {}, handed: 1, ctrl: { kind: 'human', slot: 0, ai: AI_LEVELS.auto } },
    { team: 1, name: 'CPU', look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[level] } },
  ];
  const m = new Match({ doubles: false, gamesToWin: 3, players, seed, introTime: 0.1 });
  const reasons: Record<string, number> = {};
  const won: Record<string, number> = { human: 0, cpu: 0 };
  const rallies: number[] = [];
  let humanPerfect = 0, humanHits = 0, whiffs = 0;
  m.onEvent = (e: MatchEvent) => {
    if (e.type === 'point') { const who = e.winner === 0 ? 'human' : 'cpu'; won[who]++; reasons[who + ':' + e.reason] = (reasons[who + ':' + e.reason] || 0) + 1; rallies.push(e.rally); }
    if (e.type === 'hit' && e.p.human) { humanHits++; if (e.perfect) humanPerfect++; }
    if (e.type === 'whiff' && e.p.human) whiffs++;
  };
  let planned: any = null, swingAt = 0;
  const hp = m.players[0];
  for (let i = 0; i < 120 * 60 * 30 && m.state !== 'over'; i++) {
    m.step(1 / 120);
    if (m.state === 'serve' && m.server === hp && m.t - m.stateT0 > 0.8) m.humanToss(0);
    if (m.state === 'toss' && m.server === hp && !hp.swing && m.t >= hp.tossT + 0.78 + r.gauss() * 0.1 - 0.02) m.humanSwing(0, { power: r.range(0.4, 1), spin: 0.2 }, m.t - 0.02);
    if (hp.plan && hp.plan !== planned) { planned = hp.plan; swingAt = hp.plan.t + r.gauss() * timingSigma; }
    if (planned && hp.plan === planned && m.t >= swingAt + 0.03) {
      m.humanSwing(0, { power: Math.min(1, Math.max(0, r.range(0.35, 1.05))), spin: r.gauss() * 0.4 + 0.15 }, swingAt);
      planned = null;
    }
  }
  const avg = rallies.reduce((a, b) => a + b, 0) / rallies.length;
  console.log(`human(σ=${timingSigma}s) vs ${level}: points H ${won.human} - C ${won.cpu}, games ${m.score.games.join('-')}, avg rally ${avg.toFixed(1)}, perfect ${humanPerfect}/${humanHits}, whiffs ${whiffs}`);
  console.log('   ', reasons);
}
run('rookie', 0.06, 1); run('club', 0.06, 5); run('club', 0.1, 6);
run('pro', 0.06, 2);
run('pro', 0.1, 3);
run('ace', 0.06, 4);
