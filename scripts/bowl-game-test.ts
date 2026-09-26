// Referee checks: split detection.
import { isSplit } from '../src/tv/bowling/game';
const s = (...up: number[]) => Array.from({ length: 10 }, (_, i) => up.includes(i + 1));
const cases: [boolean[], boolean, string][] = [
  [s(7, 10), true, '7-10'],
  [s(4, 6), true, '4-6'],
  [s(2, 7), true, '2-7 baby split (4 missing between)'],
  [s(2, 4), false, '2-4 touching'],
  [s(1, 7, 10), false, 'head pin up'],
  [s(10), false, 'single pin'],
  [s(4, 7, 9, 10), true, 'big four-ish'],
  [s(5, 8, 9), false, 'bucket-ish connected'],
  [s(3, 10), true, '3-10 baby split'],
];
let fail = 0;
for (const [st, want, name] of cases) {
  const got = isSplit(st);
  if (got !== want) {
    fail++;
    console.log('FAIL', name, 'got', got);
  }
}
console.log(fail ? `${fail} failures` : 'All referee checks passed.');
