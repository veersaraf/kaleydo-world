import fs from 'node:fs';
import { quatFromEuler, qrot } from '../src/pad/orient';
const lines = fs.readFileSync('captures/veer-20260928-193627.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let seg = 'pre';
const segs: Record<string, any[]> = {};
let lastO: number[] | null = null;
for (const l of lines) {
  if (l.k === 'e' && l.ev === 'seg') {
    seg = l.phase === 'start' ? l.label : 'gap-after-' + l.label;
    continue;
  }
  if (l.k === 'o') {
    lastO = l.o;
    continue;
  }
  if (l.k === 'm' && l.r && lastO) (segs[seg] ??= []).push({ t: l.t, r: l.r, a: l.a, g: l.g, o: lastO });
}
const f = (v: number[]) => v.map((x) => x.toFixed(2).padStart(6)).join(' ');
for (const [k, arr] of Object.entries(segs)) {
  const q = arr.filter((s) => Math.hypot(...s.r) < 20);
  const med = (i: number, key: 'o' | 'g') => {
    const v = q.map((s) => s[key][i]).sort((a, b) => a - b);
    return v[v.length >> 1] ?? NaN;
  };
  const o = [0, 1, 2].map((i) => med(i, 'o')),
    g = [0, 1, 2].map((i) => med(i, 'g'));
  const Q = quatFromEuler(o[0], o[1], o[2]);
  console.log(k.padEnd(22), 'n', arr.length, 'quiet', q.length, ' o(a,b,g)', f(o), ' g', f(g), ' top(E)', f(qrot(Q, [0, 1, 0])), ' screen(E)', f(qrot(Q, [0, 0, 1])));
}
