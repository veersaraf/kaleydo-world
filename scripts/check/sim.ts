// Headless CPU-vs-CPU simulation to sanity-check rules and physics.
// Every match has to finish, and the same seed has to play out identically (the event hash) when run twice;
// otherwise this exits 1.
//   npx tsx scripts/check/sim.ts
import { Match, type MatchEvent } from '../../src/tv/tennis/match';
import { AI_LEVELS } from '../../src/tv/tennis/ai';
import { EventHash, seedMathRandom } from './sim-hash';

const look: any = {};
const seedOff = +(process.env.SEED ?? 0);
function run(levelA: string, levelB: string, seed0: number, doubles = false, quiet = false) {
  const seed = seed0 + seedOff;
  seedMathRandom(seed);
  const players: any[] = [];
  for (const team of [0, 1] as const) {
    const n = doubles ? 2 : 1;
    for (let i = 0; i < n; i++) players.push({ team, name: `T${team}${i}`, look, handed: 1, ctrl: { kind: 'cpu', ai: AI_LEVELS[team === 0 ? levelA : levelB] } });
  }
  const m = new Match({ doubles, gamesToWin: 3, players, seed, introTime: 0.1 });
  const reasons: Record<string, number> = {};
  const rallies: number[] = [];
  let hits = 0, faults = 0, lets = 0, nets = 0, whiffs = 0, maxKph = 0, perfect = 0;
  const kinds: Record<string, number> = {};
  const hash = new EventHash();
  m.onEvent = (e: MatchEvent) => {
    hash.add(m.t, e);
    if (e.type === 'point') { reasons[e.reason] = (reasons[e.reason] || 0) + 1; rallies.push(e.rally); }
    if (e.type === 'hit') { hits++; maxKph = Math.max(maxKph, e.kph); kinds[e.kind] = (kinds[e.kind] || 0) + 1; if (e.perfect) perfect++; }
    if (e.type === 'fault') faults++;
    if (e.type === 'let') lets++;
    if (e.type === 'net') nets++;
    if (e.type === 'whiff') whiffs++;
    if (e.type === 'athletic') kinds['~' + e.move] = (kinds['~' + e.move] || 0) + 1;
    if (e.type === 'tired') kinds['~tired'] = (kinds['~tired'] || 0) + 1;
  };
  const dt = 1 / 120;
  let steps = 0;
  let minSt = 1;
  while (m.state !== 'over' && steps < 120 * 60 * 30) { m.step(dt); steps++; for (const p of m.players) minSt = Math.min(minSt, p.stamina); }
  kinds['~minStamina'] = +minSt.toFixed(2);
  const avg = rallies.reduce((a, b) => a + b, 0) / Math.max(1, rallies.length);
  if (!quiet) console.log(`${levelA} vs ${levelB}${doubles ? ' (doubles)' : ''}: games ${m.score.games.join('-')} in ${(m.t / 60).toFixed(1)} min, points ${rallies.length}, events ${hash}, avg rally ${avg.toFixed(1)}, max rally ${Math.max(...rallies)}`);
  if (!quiet) console.log(`   reasons`, reasons, `faults ${faults} lets ${lets} nets ${nets} whiffs ${whiffs} maxKph ${maxKph.toFixed(0)} hits ${hits}`, kinds);
  return { hash: String(hash), over: m.state === 'over' };
}
let fail = 0;
for (const [a, b, seed, doubles] of [['pro', 'pro', 1, false], ['ace', 'rookie', 2, false], ['club', 'club', 3, false], ['pro', 'pro', 4, true]] as const) {
  const r = run(a, b, seed, doubles);
  const again = run(a, b, seed, doubles, true);
  if (!r.over) { fail++; console.log(`✗ ${a} vs ${b}${doubles ? ' (doubles)' : ''}: the match did not finish`); }
  if (r.hash !== again.hash) { fail++; console.log(`✗ ${a} vs ${b}${doubles ? ' (doubles)' : ''}: not deterministic (${r.hash} then ${again.hash})`); }
}
console.log(fail ? `${fail} sim checks FAILED.` : 'All sim checks passed (4 matches finished, each identical when replayed).');
if (fail) process.exitCode = 1;
