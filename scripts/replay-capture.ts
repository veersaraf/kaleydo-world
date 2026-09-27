// Replay a motion capture (captures/*.jsonl — recorded by the remote's /rec page
// or controller.html?rec) through the remote's own detectors, offline: the same
// sensor front end (src/pad/pipeline.ts), the sword detector (sword.ts) and the
// tennis swing detector (swing.ts), fed exactly what the phone was fed. Prints,
// for every labelled step, what the player was asked to do, what the phone said
// live, and what the detectors say now — so thresholds can be tuned on real
// hands and checked against every capture.
//
//   npx tsx scripts/replay-capture.ts [file.jsonl | name]   (default: the newest capture)
//       --sens=1        the remote's swing sensitivity (0.75 big swings, 1.35 light)
//       --trace         every stroke the sword detector judged, and why
//       --csv=out.csv   a per-sample table (rates, tip speed, blade, guard) to plot
//       --all           list every strike, not just the summary per step
import fs from 'node:fs';
import path from 'node:path';
import { MotionFront, swordSample, swingSample, type RawMotion } from '../src/pad/pipeline';
import { SwordDetector, type SwordStrike, type SwordJudged, type SwordNearMiss } from '../src/pad/sword';
import { SwingDetector, type SwingEvent } from '../src/pad/swing';

const args = process.argv.slice(2);
const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = (k: string) => args.includes(`--${k}`);
const DIR = path.join(process.cwd(), 'captures');

function pickFile(): string {
  const a = args.find((x) => !x.startsWith('--'));
  if (a) {
    if (fs.existsSync(a)) return a;
    const c = path.join(DIR, a.endsWith('.jsonl') ? a : a + '.jsonl');
    if (fs.existsSync(c)) return c;
    throw new Error(`no capture ${a}`);
  }
  const all = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')) : [];
  if (!all.length) throw new Error('no captures yet (captures/*.jsonl) — record one at https://<mac>:3443/rec');
  all.sort((x, y) => fs.statSync(path.join(DIR, y)).mtimeMs - fs.statSync(path.join(DIR, x)).mtimeMs);
  return path.join(DIR, all[0]);
}

type Line = Record<string, unknown> & { k: string; t?: number };
const file = pickFile();
const lines: Line[] = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l) as Line];
    } catch {
      return [];
    }
  });
const meta = lines.find((l) => l.k === 'meta') ?? {};
const ua = String(meta.ua ?? '');
const ios = /iPhone|iPad|iPod|Macintosh/.test(ua);
const sens = Number(opt('sens') ?? 1);
const R2D = 180 / Math.PI;
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
const arrow = (d: number) => ARROWS[(Math.round(d / (Math.PI / 4)) + 8) % 8];
const deg = (d: number) => `${Math.round(d * R2D)}°`;

// ---- run the pipeline, as the remote does in the duel
const front = new MotionFront();
const sword = new SwordDetector();
sword.sensitivity = sens;
sword.upSign = ios ? -1 : 1;
const tennis = new SwingDetector();
tennis.sensitivity = sens;
tennis.upSign = ios ? -1 : 1;

interface Seg {
  label: string;
  step: number;
  expect: unknown;
  t0: number;
  t1: number;
  live: Line[];
  strikes: SwordStrike[];
  near: SwordNearMiss[];
  guarded: SwordStrike[];
  tennis: SwingEvent[];
  judged: SwordJudged[];
  peakW: number;
  outcome: string;
}
const segs: Seg[] = [];
let seg: Seg | null = null;
const loose: Seg = { label: '(outside any step)', step: -1, expect: 'any', t0: 0, t1: 0, live: [], strikes: [], near: [], guarded: [], tennis: [], judged: [], peakW: 0, outcome: '' };
const cur = () => seg ?? loose;
sword.onStrike = (s) => cur().strikes.push(s);
sword.onNear = (n) => cur().near.push(n);
sword.onGuarded = (s) => cur().guarded.push(s);
sword.onJudge = (j) => cur().judged.push(j);
tennis.onSwing = (e) => cur().tennis.push(e);

const csv: string[] = [];
const wantCsv = opt('csv');
if (wantCsv) csv.push('t_ms,alpha,beta,gamma,wx,wy,wz,w,tip_speed,blade_x,blade_y,blade_z,guard,label');
let guarding = false;
let nM = 0,
  nO = 0;
const dts: number[] = [];
let lastMT = 0;
let t0 = 0;
let igSeen = 0;
let igDown = 0;

for (const l of lines) {
  const t = Number(l.t ?? 0);
  if (!t0 && t) t0 = t;
  if (l.k === 'o') {
    nO++;
    const o = l.o as (number | null)[];
    front.orientEvent({ t, alpha: o[0], beta: o[1], gamma: o[2] });
    if (front.orient.heading === null) front.orient.calibrate();
  } else if (l.k === 'm') {
    const r = l.r as (number | null)[] | null;
    if (!r) continue;
    nM++;
    if (lastMT) dts.push(t - lastMT);
    lastMT = t;
    const a = l.a as (number | null)[] | null,
      g = l.g as (number | null)[] | null;
    const raw: RawMotion = { t, ra: r[0], rb: r[1], rg: r[2], ax: a?.[0] ?? null, ay: a?.[1] ?? null, az: a?.[2] ?? null, gx: g?.[0] ?? null, gy: g?.[1] ?? null, gz: g?.[2] ?? null };
    const m = front.motionEvent(raw);
    if (!m) continue;
    // which way gravity reads: along the OS's "up" (W3C) or against it (iOS)
    if (m.hasIg && front.orient.have) {
      const up = front.orient.upDevice();
      const gu = (m.igx - m.ax) * up[0] + (m.igy - m.ay) * up[1] + (m.igz - m.az) * up[2];
      igSeen++;
      if (gu < 0) igDown++;
    }
    if (!guarding) front.orient.autoCenter(m.dt);
    sword.heading = front.orient.heading;
    sword.push(swordSample(m));
    tennis.push(swingSample(m, front.orient));
    const w = Math.hypot(m.rx, m.ry, m.rz);
    cur().peakW = Math.max(cur().peakW, w);
    if (wantCsv) {
      const b = front.orient.have ? front.orient.devToPlayer([0, 1, 0]) : [0, 0, 0];
      csv.push([t.toFixed(1), r[0], r[1], r[2], m.rx.toFixed(3), m.ry.toFixed(3), m.rz.toFixed(3), w.toFixed(3), sword.live.toFixed(3), ...b.map((v) => v.toFixed(3)), guarding ? 1 : 0, seg?.label ?? ''].join(','));
    }
  } else if (l.k === 'e') {
    const ev = String(l.ev);
    if (ev === 'guard') {
      guarding = !!l.down;
      sword.guard(guarding, t);
    } else if (ev === 'recenter') front.orient.calibrate();
    else if (ev === 'seg') {
      const phase = String(l.phase);
      if (phase === 'start') {
        seg = { label: String(l.label), step: Number(l.step), expect: l.expect, t0: t, t1: t, live: [], strikes: [], near: [], guarded: [], tennis: [], judged: [], peakW: 0, outcome: 'unfinished' };
        segs.push(seg);
      } else if (seg) {
        seg.t1 = t;
        seg.outcome = phase === 'end' ? 'done' : phase;
        seg = null;
      }
    } else if (ev === 'strike' || ev === 'near' || ev === 'guarded') cur().live.push(l);
  }
}

// ---- report
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
console.log(`${path.relative(process.cwd(), file)} — ${String(meta.started ?? '')}`);
console.log(`  ${ua.slice(0, 110)}`);
console.log(
  `  ${nM} motion samples (every ${med(dts).toFixed(1)} ms median, ${dts.filter((d) => d > 25).length} gaps > 25 ms), ${nO} orientation samples, ${((lastMT - t0) / 1000).toFixed(0)} s`,
);
console.log(`  gyro axes: ${front.axes.sure ? front.axes.name : 'not settled'}${front.axes.sure ? (front.axes.name === 'xyz' ? '  (alpha about x, beta y, gamma z)' : front.axes.name === 'zxy' ? '  (alpha about z, beta x, gamma y)' : '') : ''}`);
if (igSeen) console.log(`  gravity reads ${igDown > igSeen / 2 ? 'down (iOS signs)' : 'up (W3C signs)'} in ${Math.round((100 * Math.max(igDown, igSeen - igDown)) / igSeen)}% of samples`);
console.log(`  sensitivity ${sens}\n`);

const fmtStrike = (s: SwordStrike, base: number) =>
  s.kind === 'thrust' ? `THRUST ${Math.round(s.power * 100)}%` : `${arrow(s.dir)} ${deg(s.dir)} ${Math.round(s.power * 100)}% (${s.peak.toFixed(1)} rad/s)${base ? ` @${((s.t - base) / 1000).toFixed(1)}s` : ''}`;
const liveOf = (l: Line) => (l.ev === 'strike' ? (l.kind === 'thrust' ? 'T' : arrow(Number(l.dir))) : l.ev === 'near' ? '·' : 'g');

for (const s of [...segs, loose]) {
  if (s === loose && !s.strikes.length && !s.near.length) continue;
  const exp = s.expect;
  const slashes = s.strikes.filter((x) => x.kind === 'slash');
  let verdict = '';
  if (typeof exp === 'number') {
    const ok = slashes.filter((x) => Math.abs(Math.atan2(Math.sin(x.dir - exp), Math.cos(x.dir - exp))) < Math.PI / 4).length;
    verdict = `${slashes.length} slashes, ${ok} within 45° of ${arrow(exp)}; directions ${slashes.map((x) => arrow(x.dir)).join(' ') || '—'}`;
  } else if (exp === 'thrust') verdict = `${s.strikes.filter((x) => x.kind === 'thrust').length} thrusts, ${slashes.length} slashes`;
  else if (exp === 'none') verdict = `${s.strikes.length ? '✗ ' : ''}${s.strikes.length} strikes (want none)${s.guarded.length ? `, ${s.guarded.length} swings while guarding` : ''}`;
  else verdict = `${s.strikes.map((x) => (x.kind === 'thrust' ? 'T' : arrow(x.dir))).join(' ') || 'nothing'}`;
  const dur = ((s.t1 - s.t0) / 1000).toFixed(1);
  console.log(`■ ${s.step >= 0 ? `${s.step + 1}. ` : ''}${s.label}${s.step >= 0 ? ` (${dur} s, ${s.outcome})` : ''} — fastest turn ${Math.round(s.peakW * R2D)}°/s`);
  console.log(`    now:  ${verdict}${s.near.length ? `; ${s.near.length} "swing harder"` : ''}`);
  if (s.live.length) console.log(`    live: ${s.live.map(liveOf).join(' ')}`);
  if (flag('all')) for (const x of s.strikes) console.log(`      ${fmtStrike(x, s.t0)}`);
  if (flag('trace'))
    for (const j of s.judged)
      console.log(
        `      ${((j.t - s.t0) / 1000).toFixed(2)}s ${j.verdict.padEnd(9)} ${arrow(j.dir)} ${deg(j.dir).padStart(5)} peak ${j.peak.toFixed(1)} need ${j.need.toFixed(1)} (base ${j.base.toFixed(1)}) sweep ${j.sweep.toFixed(2)} across ${j.across.toFixed(2)} one-way ${j.coherent.toFixed(2)} wound ${j.wound.toFixed(2)}`,
      );
  if (s.tennis.length) console.log(`    (as tennis: ${s.tennis.map((e) => `${e.side} ${Math.round(e.power * 100)}%`).join(', ')})`);
}

if (wantCsv) {
  fs.writeFileSync(wantCsv, csv.join('\n') + '\n');
  console.log(`\nwrote ${csv.length - 1} samples to ${wantCsv}`);
}
