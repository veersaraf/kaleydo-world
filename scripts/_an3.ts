// time series through strokes: axis dir, speed, blade, acc
import fs from 'node:fs';
import { MotionFront } from '../src/pad/pipeline';
import { qrot } from '../src/pad/orient';
const lines = fs.readFileSync('captures/veer-20260928-193627.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const want = process.argv[2];
const t0s = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
const front = new MotionFront();
let seg = 'pre',
  segT0 = 0;
const R2D = 180 / Math.PI;
const f = (v: number[], d = 2) => v.map((x) => x.toFixed(d).padStart(d + 4)).join(' ');
for (const l of lines) {
  if (l.k === 'e' && l.ev === 'seg') {
    seg = l.phase === 'start' ? l.label : '-';
    segT0 = l.t;
    if (l.phase === 'start') front.orient.calibrate();
    continue;
  }
  if (l.k === 'o') front.orientEvent({ t: l.t, alpha: l.o[0], beta: l.o[1], gamma: l.o[2] });
  if (l.k === 'm' && l.r) {
    const m = front.motionEvent({ t: l.t, ra: l.r[0], rb: l.r[1], rg: l.r[2] });
    if (!m || !m.q || seg !== want) continue;
    const st = (l.t - segT0) / 1000;
    const w = front.orient.toPlayer(qrot(m.q, [m.rx, m.ry, m.rz]));
    const b = front.orient.devToPlayer([0, 1, 0]);
    const a = l.a ? front.orient.toPlayer(qrot(m.q, [-l.a[0], -l.a[1], -l.a[2]])) : [0, 0, 0];
    const sp = Math.hypot(w[0], w[2]);
    if (t0s && !t0s.some((x) => st >= x - 0.35 && st <= x + 0.35)) continue;
    if (!t0s && Math.hypot(...w) < 1.5) continue;
    console.log(`${st.toFixed(3)} |w| ${Math.hypot(...w).toFixed(1).padStart(5)} sxz ${sp.toFixed(1).padStart(5)} axisdir ${(Math.atan2(w[0], -w[2]) * R2D).toFixed(0).padStart(5)}  wP ${f(w, 1)}  b ${f(b)}  acc ${f(a, 1)}`);
  }
}
