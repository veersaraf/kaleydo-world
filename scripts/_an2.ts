// per-stroke kinematics
import fs from 'node:fs';
import { MotionFront } from '../src/pad/pipeline';
import { qrot } from '../src/pad/orient';
const lines = fs.readFileSync('captures/veer-20260928-193627.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const only = process.argv[2];
const front = new MotionFront();
const HEAD = Math.atan2(-0.81, -0.42);
let seg = 'pre',
  segT0 = 0;
type S = { t: number; w: number[]; wd: number[]; b: number[]; scr: number[]; x: number[]; acc: number[]; seg: string; st: number };
const all: S[] = [];
const toP = (v: number[]) => {
  const fx = Math.sin(HEAD),
    fy = Math.cos(HEAD);
  return [v[0] * fy - v[1] * fx, v[0] * fx + v[1] * fy, v[2]];
};
for (const l of lines) {
  if (l.k === 'e' && l.ev === 'seg') {
    seg = l.phase === 'start' ? l.label : '-';
    segT0 = l.t;
    continue;
  }
  if (l.k === 'o') front.orientEvent({ t: l.t, alpha: l.o[0], beta: l.o[1], gamma: l.o[2] });
  if (l.k === 'm' && l.r) {
    const m = front.motionEvent({ t: l.t, ra: l.r[0], rb: l.r[1], rg: l.r[2] });
    if (!m || !m.q) continue;
    const q = m.q;
    const wd = [m.rx, m.ry, m.rz];
    // iOS acc: negate to W3C sense
    const a = l.a ? [-l.a[0], -l.a[1], -l.a[2]] : [0, 0, 0];
    all.push({ t: l.t, wd, w: toP(qrot(q, wd as any)), b: toP(qrot(q, [0, 1, 0])), scr: toP(qrot(q, [0, 0, 1])), x: toP(qrot(q, [1, 0, 0])), acc: toP(qrot(q, a as any)), seg, st: (l.t - segT0) / 1000 });
  }
}
const f = (v: number[], d = 2) => v.map((x) => x.toFixed(d).padStart(d + 4)).join(' ');
const R2D = 180 / Math.PI;
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
const arrow = (d: number) => ARROWS[(Math.round(d / (Math.PI / 4)) + 8) % 8];
// strokes: |w| above 4 rad/s, contiguous
let i = 0;
while (i < all.length) {
  const n = (s: S) => Math.hypot(...s.w);
  if (n(all[i]) < 4 || (only && all[i].seg !== only)) {
    i++;
    continue;
  }
  let j = i;
  while (j < all.length && n(all[j]) >= 2.5) j++;
  let pk = i;
  for (let k = i; k < j; k++) if (n(all[k]) > n(all[pk])) pk = k;
  const s0 = all[Math.max(0, i - 3)],
    s1 = all[Math.min(all.length - 1, j)],
    p = all[pk];
  const db = [s1.b[0] - s0.b[0], s1.b[1] - s0.b[1], s1.b[2] - s0.b[2]];
  // integrated rotation vector (player frame)
  const rot = [0, 0, 0];
  for (let k = i; k < j; k++) for (let c = 0; c < 3; c++) rot[c] += all[k].w[c] * 0.0167;
  // acc integral (velocity) over stroke
  const vel = [0, 0, 0];
  let amax = 0;
  for (let k = i; k < j; k++) {
    for (let c = 0; c < 3; c++) vel[c] += all[k].acc[c] * 0.0167;
    amax = Math.max(amax, Math.hypot(...all[k].acc));
  }
  const wu = p.w.map((x) => x / n(p));
  const wdu = p.wd.map((x) => x / Math.hypot(...p.wd));
  console.log(
    `${p.seg.padEnd(10)} ${p.st.toFixed(2).padStart(6)}s dur ${((s1.t - s0.t) | 0).toString().padStart(4)}ms pk ${(n(p) * R2D).toFixed(0).padStart(5)}°/s  ωdev ${f(wdu)}  ωP ${f(wu)}  rot ${f(rot)}  b0 ${f(s0.b)} b1 ${f(s1.b)}  Δb ${arrow(Math.atan2(db[2], db[0]))} ${f(db)}  scr0 ${f(s0.scr)} amax ${amax.toFixed(1)} vel ${f(vel)}`,
  );
  i = j + 1;
}
