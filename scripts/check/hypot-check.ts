// src/tv/tennis/hypot.ts must return exactly what Math.hypot does (the sims' hashes depend on it).
//   npx tsx scripts/check/hypot-check.ts
import { hyp2, hyp3 } from '../../src/tv/tennis/hypot';

let bad = 0;
const N = 5e6;
const scales = [1e-6, 1e-3, 1, 10, 1e3];
for (let i = 0; i < N; i++) {
  const sc = scales[i % scales.length];
  const a = (Math.random() - 0.5) * sc * 4;
  const b = (Math.random() - 0.5) * sc * 4;
  const c = (Math.random() - 0.5) * sc * 4;
  if (Math.hypot(a, b) !== hyp2(a, b)) bad++;
  if (Math.hypot(a, b, c) !== hyp3(a, b, c)) bad++;
}
const edge = [0, -0, 1, 3, -4, 1e-300, 1e300, Infinity, -Infinity, NaN];
for (const a of edge) for (const b of edge) {
  if (!Object.is(Math.hypot(a, b), hyp2(a, b))) { bad++; console.log('hyp2', a, b, Math.hypot(a, b), hyp2(a, b)); }
  for (const c of edge) if (!Object.is(Math.hypot(a, b, c), hyp3(a, b, c))) { bad++; console.log('hyp3', a, b, c, Math.hypot(a, b, c), hyp3(a, b, c)); }
}
console.log(bad ? `FAIL: ${bad} differ` : `ok: ${N} random triples and every edge case are bit for bit`);
process.exit(bad ? 1 : 0);
