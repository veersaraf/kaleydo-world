import { Score } from '../src/tv/tennis/score';
let ok = true;
const eq = (a: unknown, b: unknown, msg: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { ok = false; console.log('✗', msg, 'got', a, 'want', b); } };
const s = new Score(2, 0, ['Veer', 'CPU']);
eq(s.call(), 'Love all', 'start');
s.pointTo(0); eq(s.call(), 'Fifteen–Love', '15-0');
s.pointTo(1); eq(s.call(), 'Fifteen all', '15-15');
s.pointTo(1); eq(s.call(), 'Fifteen–Thirty', '15-30 (server first)');
s.pointTo(0); s.pointTo(0); eq(s.call(), 'Forty–Thirty', '40-30');
s.pointTo(1); eq(s.call(), 'Deuce', 'deuce');
eq([s.pointText(0), s.pointText(1)], ['40', '40'], 'deuce texts');
s.pointTo(1); eq(s.call(), 'Advantage CPU', 'adv receiver');
eq([s.pointText(0), s.pointText(1)], ['40', 'AD'], 'adv texts');
s.pointTo(0); eq(s.call(), 'Deuce', 'back to deuce');
s.pointTo(0); eq(s.call(), 'Advantage Veer', 'adv server');
let o = s.pointTo(0); eq([o.gameWon, o.matchWon, o.call], [true, false, 'Game'], 'game');
eq(s.games, [1, 0], 'games 1-0');
eq(s.server, 1, 'server switches');
eq(s.deuceCourt, true, 'new game starts on deuce court');
for (let i = 0; i < 4; i++) o = s.pointTo(0);
eq([o.gameWon, o.matchWon], [true, true], 'match won');
eq(s.winner, 0, 'winner');
// deuce court alternates each point
const t = new Score(1, 0, ['A', 'B']);
const courts = [];
for (let i = 0; i < 4; i++) { courts.push(t.deuceCourt); t.pointTo(i % 2 as 0 | 1); }
eq(courts, [true, false, true, false], 'deuce/ad alternation');
// doubles server rotation
const d = new Score(5, 0, ['A', 'B']);
const servers: string[] = [];
for (let g = 0; g < 4; g++) { servers.push(`${d.server}:${d.serverIdx[d.server]}`); for (let p = 0; p < 4; p++) d.pointTo(0); }
eq(servers, ['0:0', '1:0', '0:1', '1:1'], 'doubles service rotation');
console.log(ok ? 'All scoring checks passed.' : 'Scoring checks FAILED.');
