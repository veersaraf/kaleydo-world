// Checks for the ten-pin scorer. Run: npx tsx scripts/bowl-score-test.ts
import { BowlScore } from '../src/tv/bowling/score';

let pass = 0;
let fail = 0;
const eq = (got: unknown, want: unknown, msg: string) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.log('✗', msg, '\n    got ', JSON.stringify(got), '\n    want', JSON.stringify(want));
  }
};
const throws = (f: () => void, msg: string) => {
  try {
    f();
    fail++;
    console.log('✗', msg, '(did not throw)');
  } catch {
    pass++;
  }
};
const game = (rolls: number[]) => {
  const s = new BowlScore();
  for (const p of rolls) s.add(p);
  return s;
};
const rep = <T>(n: number, ...xs: T[]) => Array.from({ length: n }, () => xs).flat();
const marks = (s: BowlScore) => s.frames().map((f) => f.rolls.join(''));
const totals = (s: BowlScore) => s.frames().map((f) => f.total);

// Whole games
{
  const s = game(rep(12, 10));
  eq(s.total(), 300, 'perfect game = 300');
  eq(s.done, true, 'perfect game is done after 12 balls');
  eq(totals(s), [30, 60, 90, 120, 150, 180, 210, 240, 270, 300], 'perfect game totals');
  eq(marks(s), ['X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'X', 'XXX'], 'perfect game marks');
}
{
  const s = game([...rep(10, 9, 1), 9]);
  eq(s.total(), 190, 'all 9-spares + 9 = 190');
  eq(s.done, true, 'all 9-spares game done');
  eq(s.frames()[0].rolls, ['9', '/'], '9-spare marks');
  eq(s.frames()[9].rolls, ['9', '/', '9'], '10th-frame 9 / 9');
}
{
  const s = game([...rep(10, 5, 5), 5]);
  eq(s.total(), 150, 'all 5-spares + 5 = 150');
  eq(totals(s), [15, 30, 45, 60, 75, 90, 105, 120, 135, 150], 'all 5-spares totals');
}
{
  const s = game(rep(20, 0));
  eq(s.total(), 0, 'gutter game = 0');
  eq(s.done, true, 'gutter game done after 20 balls');
  eq(s.frames()[0].rolls, ['-', '-'], 'gutter marks');
  eq(totals(s)[9], 0, 'gutter game final total 0');
}
{
  const s = game(rep(10, 9, 0));
  eq(s.total(), 90, '9-0 x10 = 90');
  eq(marks(s), rep(10, '9-'), '9-0 marks');
  eq(totals(s), [9, 18, 27, 36, 45, 54, 63, 72, 81, 90], '9-0 totals');
  throws(() => s.add(0), 'adding a roll after the game is over throws');
}
{
  // a mixed game: X, 7/, 9-, X, X, X, 8 1, 0/, X, X 8 1
  const s = game([10, 7, 3, 9, 0, 10, 10, 10, 8, 1, 0, 10, 10, 10, 8, 1]);
  eq(marks(s), ['X', '7/', '9-', 'X', 'X', 'X', '81', '-/', 'X', 'X81'], 'mixed game marks');
  eq(totals(s), [20, 39, 48, 78, 106, 125, 134, 154, 182, 201], 'mixed game totals');
  eq(s.total(), 201, 'mixed game total');
}

// 10th-frame cases (after nine open 0-0 frames)
const nine = rep(18, 0);
{
  const s = game([...nine, 10, 10, 10]);
  eq(s.frames()[9], { rolls: ['X', 'X', 'X'], total: 30 }, '10th: X X X');
  eq(s.done, true, '10th: X X X done');
}
{
  const s = game([...nine, 10, 7, 3]);
  eq(s.frames()[9], { rolls: ['X', '7', '/'], total: 20 }, '10th: X 7 /');
}
{
  const s = game([...nine, 7, 3, 10]);
  eq(s.frames()[9], { rolls: ['7', '/', 'X'], total: 20 }, '10th: 7 / X');
}
{
  const s = game([...nine, 7, 2]);
  eq(s.frames()[9], { rolls: ['7', '2'], total: 9 }, '10th: 7 2 (open)');
  eq(s.done, true, '10th: 7 2 means no bonus ball');
  throws(() => s.add(1), 'no bonus ball after an open 10th');
}
{
  const s = game([...nine, 10, 10, 7]);
  eq(s.frames()[9].rolls, ['X', 'X', '7'], '10th: X X 7');
  const t = game([...nine, 10, 0, 10]);
  eq(t.frames()[9].rolls, ['X', '-', '/'], '10th: X - /');
  const u = game([...nine, 0, 10, 0]);
  eq(u.frames()[9].rolls, ['-', '/', '-'], '10th: - / -');
}

// Frame / ball / rack bookkeeping through the 10th
{
  const s = game(nine);
  const state = () => [s.frame, s.ball, s.standingBeforeRoll(), s.needsFreshRack(), s.done];
  eq(state(), [9, 0, 10, true, false], '10th ball 1: fresh rack');
  s.add(10);
  eq(state(), [9, 1, 10, true, false], '10th after strike: fresh rack for ball 2');
  s.add(6);
  eq(state(), [9, 2, 4, false, false], '10th X 6: 4 pins left for ball 3');
  throws(() => s.add(5), '10th X 6 then 5 is too many');
  s.add(4);
  eq(state(), [9, 2, 0, false, true], '10th X 6 / over');
}
{
  const s = game(nine);
  s.add(8);
  eq([s.ball, s.standingBeforeRoll(), s.needsFreshRack()], [1, 2, false], '10th: 8 then 2 standing');
  s.add(2);
  eq([s.ball, s.standingBeforeRoll(), s.needsFreshRack(), s.done], [2, 10, true, false], '10th spare: fresh rack for the bonus');
}
{
  const s = new BowlScore();
  eq([s.frame, s.ball, s.standingBeforeRoll(), s.needsFreshRack(), s.done], [0, 0, 10, true, false], 'new game');
  s.add(7);
  eq([s.frame, s.ball, s.standingBeforeRoll(), s.needsFreshRack()], [0, 1, 3, false], 'after a 7');
  throws(() => s.add(4), '7 then 4 is too many');
  throws(() => s.add(-1), 'negative pins throws');
  throws(() => s.add(1.5), 'fractional pins throws');
  s.add(3);
  eq([s.frame, s.ball, s.standingBeforeRoll(), s.needsFreshRack()], [1, 0, 10, true], 'spare ends the frame');
  s.add(10);
  eq([s.frame, s.ball, s.standingBeforeRoll(), s.needsFreshRack()], [2, 0, 10, true], 'strike ends the frame');
  s.add(0);
  eq([s.frame, s.ball, s.standingBeforeRoll(), s.needsFreshRack()], [2, 1, 10, false], 'gutter first ball: same rack');
}

// Partial games: totals stay null while a bonus is pending
{
  const s = game([10]);
  eq(totals(s).slice(0, 2), [null, null], 'X: pending');
  eq(s.total(), 10, 'X: running total 10');
  s.add(10);
  eq(totals(s).slice(0, 3), [null, null, null], 'X X: pending');
  eq(s.total(), 30, 'X X: running total 30');
  s.add(10);
  eq(totals(s).slice(0, 3), [30, null, null], 'X X X: first known');
  s.add(7);
  eq(totals(s).slice(0, 4), [30, 57, null, null], 'X X X 7');
  eq(s.frames()[3].rolls, ['7'], 'frame in progress shows its first ball');
  s.add(2);
  eq(totals(s).slice(0, 5), [30, 57, 76, 85, null], 'X X X 7 2');
  eq(s.total(), 85, 'X X X 7 2: running total');
}
{
  const s = game([6, 4]);
  eq(s.frames()[0], { rolls: ['6', '/'], total: null }, 'spare pending');
  eq(s.total(), 10, 'spare: running total 10');
  s.add(8);
  eq(s.frames()[0], { rolls: ['6', '/'], total: 18 }, 'spare resolved');
  eq(s.frames()[1], { rolls: ['8'], total: null }, 'second frame in progress');
  eq(s.total(), 26, 'running total after 6 / 8');
}
{
  const s = game([3, 4, 10, 5]);
  eq(totals(s).slice(0, 3), [7, null, null], 'open frame known, strike pending');
  eq(s.frames().length, 10, 'always 10 frames');
  eq(s.frames()[5], { rolls: [], total: null }, 'future frame empty');
}

console.log(fail === 0 ? `All ${pass} bowling score checks passed.` : `Bowling score checks FAILED: ${fail} failed, ${pass} passed.`);
if (fail) process.exit(1);
