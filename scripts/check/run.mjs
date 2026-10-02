// Runs the headless checks (rules, physics, detectors, codecs) with tsx. No browser, no server.
//
//   npm test                          typecheck + all of these
//   node scripts/check/run.mjs        the fast, deterministic checks (what `npm test` runs)
//   npm run test:sims                 the slower balance simulations (CPU-vs-CPU, simulated humans) and traces
//   node scripts/check/run.mjs swing  only the checks whose name contains "swing"
//   node scripts/check/run.mjs --list
//
// A check passes when its process exits 0. Output is shown only for the ones that fail (-v: all).
// Checks run a few at a time (JOBS=n to change).

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (...n) => args.some((a) => n.includes(a));
const verbose = flag('-v', '--verbose');
const filters = args.filter((a) => !a.startsWith('-'));
const JOBS = Number(process.env.JOBS || Math.max(1, Math.min(4, os.cpus().length - 1)));

/** Fast and deterministic: each of these exits 1 on a failed check. */
const CHECKS = [
  ['score-test.ts', 'tennis scoring and doubles service rotation'],
  ['hypot-check.ts', 'the sims\' hypot is bit for bit Math.hypot'],
  ['net-codec-test.ts', 'the match stream\'s codec and playback'],
  ['mm-pair-test.ts', 'the matchmaking lobby\'s pairing rule'],
  ['lift-test.ts', 'the serve\'s lift-to-toss detector'],
  ['swing-test.ts', 'the phone\'s swing detector: power, side, spin, backswing; W3C and iOS sign conventions'],
  ['sword-pad-test.ts', 'the phone\'s sword detector: slashes, thrusts, guard, what must not attack'],
  ['sword-real-test.ts', 'the sword on simulated hands'],
  ['sword-capture-test.ts', 'the sword detector on a real recording (skipped when there is no capture)'],
  ['bowl-score-test.ts', 'ten-pin scoring'],
  ['bowl-pad-test.ts', 'the phone\'s bowling detector: speed, line, hook, arm angle'],
  ['bowl-game-test.ts', 'bowling referee (splits) and latency'],
  ['duel-game-test.ts', 'sword duel rules'],
  ['archery-game-test.ts', 'archery rules'],
  ['baseball-game-test.ts', 'baseball rules'],
  ['baseball-anim-test.ts', 'baseball animation: catcher, throw back, rewind'],
  ['sim.ts', 'tennis CPU-vs-CPU matches finish, and replay identically from the same seed'],
];

/** Slower: tuning reports and traces. A non-zero exit means one crashed; the numbers are for reading. */
const SIMS = [
  ['sim-smash.ts', 'smash simulation'],
  ['duel-sim.ts', 'duel CPU levels against simulated players'],
  ['archery-sim.ts', 'archery CPU levels'],
  ['baseball-sim.ts', 'baseball CPU levels'],
  ['bowl-sim.ts', 'bowling physics: strike % by line, splits, spares'],
  ['bowl-cpu-sim.ts', 'bowling games per CPU level'],
  ['bowl-hook-table.ts', 'bowling hook table'],
  ['baseball-pitch-trace.ts', 'baseball pitcher windup trace'],
  ['baseball-swing-trace.ts', 'baseball batter swing trace'],
  ['mirror-lag-check.ts', 'how far behind the phone the drawn racket / sword trails'],
  ['sim-human.ts', 'a simulated human against each tennis CPU level'],
  ['sim-rush.ts', 'Rush against the standard game'],
];

const list = flag('--sims') ? SIMS : CHECKS;
if (flag('--list')) {
  for (const [f, what] of [...CHECKS.map((c) => [...c, '']), ...SIMS.map((c) => [...c, '(sims)'])]) console.log(`${f.padEnd(26)} ${what}`);
  process.exit(0);
}
let todo = list;
if (filters.length) {
  todo = [...CHECKS, ...SIMS].filter(([f]) => filters.some((x) => f.includes(x)));
  if (!todo.length) {
    console.error(`no check matches ${filters.join(', ')} (see --list)`);
    process.exit(1);
  }
}

const tsx = path.join(ROOT, 'node_modules/.bin/tsx');
function run(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(tsx, [path.join('scripts/check', file)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', (b) => out.push(String(b)));
    child.stderr.on('data', (b) => out.push(String(b)));
    child.once('error', (e) => resolve({ file, ok: false, secs: 0, output: String(e) }));
    child.once('exit', (code, signal) => resolve({ file, ok: code === 0, code: code ?? signal, secs: (Date.now() - t0) / 1000, output: out.join('') }));
  });
}

const t0 = Date.now();
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(JOBS, todo.length) }, async () => {
    while (next < todo.length) {
      const [file] = todo[next++];
      const r = await run(file);
      results.push(r);
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${file.padEnd(26)} ${r.secs.toFixed(1).padStart(5)} s`);
      if (!r.ok || verbose) console.log(r.output.trimEnd().split('\n').map((l) => '    ' + l).join('\n') + (r.ok ? '' : `\n    exit: ${r.code}`) + '\n');
    }
  }),
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s${failed.length ? '; failed: ' + failed.map((f) => f.file).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
