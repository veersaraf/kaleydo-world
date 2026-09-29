// Regression test on a REAL capture: a player's labelled swings recorded on an iPhone
// (captures/veer-20260928-193627.jsonl, from the remote's /rec page; captures are
// gitignored, so this skips when the file isn't there).
//
// The capture asks for: still, then slashes right / left / down / up / down-left /
// down-right, thrusts, lazy swings, a guard, a combo and free play. Replayed through the
// remote's own pipeline (scripts/lib/replay.ts), it must show:
//   • every direction step: ≥ 80% of the slashes within 45° of the label, and ≥ 80% of the
//     player's big swings struck, with about one strike per swing (returns to the ready
//     pose aren't strikes),
//   • the thrust step: ≥ 80% of the thrusts recognised, hardly a slash among them,
//   • lazy swings: mostly striking,
//   • still and guard: no strikes at all.
//
//   npx tsx scripts/sword-capture-test.ts [capture.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { loadCapture, replay, score, arrow } from './lib/replay';

const file = process.argv[2] ?? path.join(process.cwd(), 'captures', 'veer-20260928-193627.jsonl');
if (!fs.existsSync(file)) {
  console.log(`skipped: no capture at ${path.relative(process.cwd(), file)} (captures are not in git; record one at https://<mac>:3443/rec)`);
  process.exit(0);
}

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail: string) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(46)} ${detail}`);
}

const R = replay(loadCapture(file));
const seg = (label: string) => {
  const s = R.segs.find((x) => x.label === label);
  if (!s) throw new Error(`the capture has no "${label}" step`);
  return s;
};
const pct = (a: number, b: number) => `${a}/${b}`;

console.log(`${path.basename(file)}: ${R.nM} motion samples, gyro axes ${R.front.axes.name}`);

console.log('\n— slash directions');
for (const s of R.segs) {
  if (typeof s.expect !== 'number') continue;
  const sc = score(s);
  check(`${s.label} (${arrow(s.expect)}): within 45° of the label`, sc.slashes > 0 && sc.right >= 0.8 * sc.slashes, `${pct(sc.right, sc.slashes)}  (${s.strikes.map((x) => (x.kind === 'thrust' ? 'T' : arrow(x.dir))).join(' ')})`);
  check(`${s.label}: the big swings strike, once each`, sc.struck >= 0.8 * sc.turns && sc.slashes <= 1.25 * sc.turns, `${pct(sc.struck, sc.turns)} swings struck, ${sc.slashes} slashes, ${sc.extra} not at a swing`);
}

console.log('\n— thrusts');
{
  const s = seg('thrust');
  const sc = score(s);
  // the player thrust about nine times (the step's push count, see scripts/replay-capture.ts)
  check('thrusts are recognised', sc.thrusts >= 7, `${sc.thrusts} thrusts`);
  check('…and are not slashes as well', sc.slashes <= 1, `${sc.slashes} slashes`);
}

console.log('\n— lazy swings, and none');
{
  const s = seg('lazy');
  const sc = score(s);
  check('lazy swings mostly strike', sc.struck >= 0.7 * sc.turns, `${pct(sc.struck, sc.turns)} swings struck`);
  const still = seg('still'),
    guard = seg('guard');
  check('holding still: no strikes', still.strikes.length === 0 && still.near.length === 0, `${still.strikes.length} strikes`);
  check('holding the guard: no strikes', guard.strikes.length === 0, `${guard.strikes.length} strikes, ${guard.guarded.length} reported as guarded`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Capture checks FAILED.');
  process.exit(1);
}
console.log('All capture checks passed.');
