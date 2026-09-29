import { loadCapture, replay, score, arrow } from './lib/replay';
const lines = loadCapture('captures/veer-20260928-193627.jsonl');
const variants = process.argv.slice(2);
for (const v of variants) {
  for (const kv of v.split(',')) {
    const [k, val] = kv.split('=');
    process.env[k] = val;
  }
  const R = replay(lines);
  const out: string[] = [];
  let tot = 0,
    ok = 0,
    turns = 0,
    sl = 0;
  for (const s of R.segs) {
    const sc = score(s);
    if (typeof s.expect === 'number') {
      tot += sc.slashes;
      ok += sc.right;
      turns += sc.turns;
      out.push(`${s.label} ${sc.right}/${sc.slashes}/${sc.turns}`);
    } else if (s.expect === 'thrust') out.push(`thrust T${sc.thrusts} S${sc.slashes}`);
    else if (s.expect === 'none') out.push(`${s.label} ${s.strikes.length}`);
    else out.push(`${s.label} ${s.strikes.length}(${sc.turns}) ${s.strikes.map((x) => (x.kind === 'thrust' ? 'T' : arrow(x.dir))).join('')}`);
    sl += 0;
  }
  console.log(`${v.padEnd(28)} dir ${ok}/${tot} (turns ${turns}) | ${out.join(' | ')}`);
  if (process.env.DIRS)
    for (const s of R.segs)
      if (typeof s.expect === 'number' || s.label === 'lazy' || s.label === 'free' || s.label === 'thrust')
        console.log('   ', s.label.padEnd(11), s.strikes.map((x) => (x.kind === 'thrust' ? 'T' : Math.round((x.dir * 180) / Math.PI))).join(' '));
}
