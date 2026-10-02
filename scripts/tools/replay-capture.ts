// Replay a motion capture (captures/*.jsonl — recorded by the remote's /rec page
// or controller.html?rec) through the remote's own detectors, offline: the same
// sensor front end (src/pad/pipeline.ts), the sword detector (sword.ts) and the
// tennis swing detector (swing.ts), fed exactly what the phone was fed. Prints,
// for every labelled step, what the player was asked to do, what the phone said
// live, and what the detectors say now — so thresholds can be tuned on real
// hands and checked against every capture.
//
//   npx tsx scripts/tools/replay-capture.ts [file.jsonl | name]   (default: the newest capture)
//       --sens=1        the remote's swing sensitivity (0.75 big swings, 1.35 light)
//       --trace         every stroke the sword detector judged, and why
//       --csv=out.csv   a per-sample table (rates, tip speed, blade, guard) to plot
//       --all           list every strike, not just the summary per step
//       --live-heading  centre "towards the TV" as the capture page did live before (at its
//                       first reading); by default half-way through the "still" step
import fs from 'node:fs';
import path from 'node:path';
import type { SwordStrike } from '../../src/pad/sword';
import { loadCapture, replay, score, arrow, R2D, fmtDelay, onsetStats, delayStats, type Line } from '../lib/replay';

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

const file = pickFile();
const lines = loadCapture(file);
const sens = Number(opt('sens') ?? 1);
const deg = (d: number) => `${Math.round(d * R2D)}°`;
const wantCsv = opt('csv');
const csv: string[] = wantCsv ? ['t_ms,alpha,beta,gamma,wx,wy,wz,w,tip_speed,blade_x,blade_y,blade_z,guard,label'] : [];
const R = replay(lines, { sens, liveHeading: flag('live-heading'), csv: wantCsv ? csv : undefined });
const { meta, segs, loose, front, nM, nO, dts, igSeen, igDown } = R;
const ua = String(meta.ua ?? '');

// ---- report
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
console.log(`${path.relative(process.cwd(), file)} — ${String(meta.started ?? '')}`);
console.log(`  ${ua.slice(0, 110)}`);
console.log(
  `  ${nM} motion samples (every ${med(dts).toFixed(1)} ms median, ${dts.filter((d) => d > 25).length} gaps > 25 ms), ${nO} orientation samples, ${(R.span / 1000).toFixed(0)} s`,
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
  const sc = score(s);
  let verdict = '';
  if (typeof exp === 'number') {
    verdict = `${slashes.length} slashes for ${sc.turns} big swings, ${sc.right} within 45° of ${arrow(exp)}; directions ${slashes.map((x) => arrow(x.dir)).join(' ') || '—'}`;
  } else if (exp === 'thrust') verdict = `${sc.thrusts} thrusts, ${slashes.length} slashes`;
  else if (exp === 'none') verdict = `${s.strikes.length ? '✗ ' : ''}${s.strikes.length} strikes (want none)${s.guarded.length ? `, ${s.guarded.length} swings while guarding` : ''}`;
  else verdict = `${s.strikes.map((x) => (x.kind === 'thrust' ? 'T' : arrow(x.dir))).join(' ') || 'nothing'}`;
  const dur = ((s.t1 - s.t0) / 1000).toFixed(1);
  console.log(`■ ${s.step >= 0 ? `${s.step + 1}. ` : ''}${s.label}${s.step >= 0 ? ` (${dur} s, ${s.outcome})` : ''} — fastest turn ${Math.round(s.peakW * R2D)}°/s, ${sc.turns} turns over ${Math.round(9 * R2D)}°/s`);
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

console.log(`\ndetection delay after the true peak — sword strikes: ${fmtDelay(R.swordDelay)}; tennis swings: ${fmtDelay(R.tennisDelay)}`);

// the tennis detector's swing ONSET (onStart): how long before the confirmed swing's peak it fires
{
  const o = onsetStats(R.tennisStarts, R.tennisSwings);
  const ld = delayStats(o.leads);
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
  console.log(`\ntennis swing onset — ${o.starts} onsets for ${o.swings} swings: lead before the peak p50 ${ld.p50.toFixed(0)} ms, p90 ${ld.p90.toFixed(0)} ms (min ${Math.min(...o.leads).toFixed(0)}); false starts ${o.falseStarts} (${pct(o.falseStarts, o.starts)}), missed ${o.missed} (${pct(o.missed, o.swings)}), duplicate onsets ${o.dupes}`);
  console.log(`  side at the onset vs the confirmed swing: ${o.side[0]} right, ${o.side[1]} wrong, ${o.side[2]} undecided`);
  // (a capture of a sword session is full of little flicks the tennis detector counts as swings: the ones a game is played with are the strong ones)
  const strong = R.tennisSwings.filter((e) => e.peak >= 12);
  const os = onsetStats(R.tennisStarts, strong);
  const ls = delayStats(os.leads);
  console.log(`  strokes of 12 rad/s and up (${strong.length}, power ≥ 0.33): lead p50 ${ls.p50.toFixed(0)} ms, p90 ${ls.p90.toFixed(0)} ms, missed ${os.missed}; side ${os.side[0]} right, ${os.side[1]} wrong, ${os.side[2]} undecided`);
  // (a volley is a short punch, 7-12 rad/s: the weak end of the same list)
  const weak = R.tennisSwings.filter((e) => e.peak < 12);
  const ow = onsetStats(R.tennisStarts, weak);
  const lw = delayStats(ow.leads);
  console.log(`  punch-sized strokes (peak 7-12 rad/s, ${weak.length}): lead p50 ${lw.p50.toFixed(0)} ms, p90 ${lw.p90.toFixed(0)} ms, missed ${ow.missed} (${pct(ow.missed, weak.length)}); side ${ow.side[0]} right, ${ow.side[1]} wrong, ${ow.side[2]} undecided`);
  if (flag('onsets')) {
    for (const e of R.tennisSwings) {
      const s = R.tennisStarts.filter((x) => x.t <= e.t && e.t - x.t <= 350)[0];
      console.log(`    peak ${(e.t / 1000).toFixed(3)}s ${e.side} ${e.peak.toFixed(1)} rad/s  onset ${s ? `${(e.t - s.t).toFixed(0)} ms before, ${s.side ?? '?'}, ${s.w.toFixed(1)} rad/s` : 'none'}`);
    }
  }
}

if (wantCsv) {
  fs.writeFileSync(wantCsv, csv.join('\n') + '\n');
  console.log(`\nwrote ${csv.length - 1} samples to ${wantCsv}`);
}
