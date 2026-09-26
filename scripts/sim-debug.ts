import { Match, type MatchEvent } from '../src/tv/tennis/match';
import { AI_LEVELS } from '../src/tv/tennis/ai';
const players: any[] = [];
for (const team of [0, 1] as const) for (let i = 0; i < 2; i++) players.push({ team, name: `T${team}${i}`, look: {}, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS.pro } });
const m = new Match({ doubles: true, gamesToWin: 2, players, seed: 4, introTime: 0.1 });
let n = 0;
m.onEvent = (e: MatchEvent) => {
  if (e.type === 'whiff' && n++ < 12) {
    const p = e.p; const pl = p.plan;
    console.log(`whiff ${p.name} role=${p.role} pos=(${p.x.toFixed(1)},${p.z.toFixed(1)}) tau=${e.tau.toFixed(2)} plan=${pl ? `t+${(pl.t - m.t).toFixed(2)} stand=(${pl.sx.toFixed(1)},${pl.sz.toFixed(1)}) ball=(${pl.bx.toFixed(1)},${pl.by.toFixed(2)},${pl.bz.toFixed(1)}) reach=${pl.reachable} volley=${pl.volley} ${pl.stroke} d=${Math.hypot(p.x-pl.sx,p.z-pl.sz).toFixed(2)}` : 'none'} state=${m.state}`);
  }
};
for (let i = 0; i < 120 * 60 * 5 && m.state !== 'over'; i++) m.step(1 / 120);
