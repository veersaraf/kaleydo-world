import { Match, type MatchEvent } from '../src/tv/tennis/match';
import { AI_LEVELS } from '../src/tv/tennis/ai';
const players: any[] = [];
for (const team of [0, 1] as const) players.push({ team, name: `T${team}`, look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS.pro } });
const m = new Match({ doubles: false, gamesToWin: 2, players, seed: 7, introTime: 0.1 });
const slacks: number[] = []; const dists: number[] = []; const flights: number[] = [];
let lastHit = 0;
m.onEvent = (e: MatchEvent) => {
  if (e.type === 'hit') {
    if (lastHit && !e.serve) flights.push(m.t - lastHit);
    lastHit = m.t;
    for (const p of m.players) if (p.plan) {
      const d = Math.hypot(p.plan.sx - p.x, p.plan.sz - p.z);
      const need = p.timeToCover(d); const avail = p.plan.t - m.t - p.ctrl.ai.react;
      slacks.push(avail - need); dists.push(d);
    }
  }
};
for (let i = 0; i < 120 * 60 * 3 && m.state !== 'over'; i++) m.step(1 / 120);
const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * f)];
console.log('slack s  p10', q(slacks, .1).toFixed(2), 'p50', q(slacks, .5).toFixed(2), 'p90', q(slacks, .9).toFixed(2));
console.log('run m    p10', q(dists, .1).toFixed(2), 'p50', q(dists, .5).toFixed(2), 'p90', q(dists, .9).toFixed(2));
console.log('between hits s p10', q(flights, .1).toFixed(2), 'p50', q(flights, .5).toFixed(2), 'p90', q(flights, .9).toFixed(2));
