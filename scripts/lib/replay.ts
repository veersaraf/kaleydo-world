// Replaying a motion capture (captures/*.jsonl, recorded by the remote's /rec
// page) through the remote's own pipeline, offline: the sensor front end
// (src/pad/pipeline.ts), the sword detector (sword.ts) and the tennis swing
// detector (swing.ts), fed exactly what the phone was fed. Shared by
// scripts/tools/replay-capture.ts (the report) and scripts/check/sword-capture-test.ts
// (the regression test).
import fs from 'node:fs';
import { MotionFront, swordSample, swingSample, type RawMotion } from '../../src/pad/pipeline';
import { SwordDetector, type SwordStrike, type SwordJudged, type SwordNearMiss } from '../../src/pad/sword';
import { SwingDetector, type SwingEvent } from '../../src/pad/swing';

export type Line = Record<string, unknown> & { k: string; t?: number };

export function loadCapture(file: string): Line[] {
  return fs
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
}

/** a big turn of the phone (a real swing, whatever the detector makes of it): its peak */
export interface Turn {
  t: number;
  /** rad/s, the phone's own rotation rate */
  w: number;
}

export interface Seg {
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
  /** the phone's big turns (peaks above TURN rad/s, TURN_GAP apart) */
  turns: Turn[];
  peakW: number;
  outcome: string;
}

/** a turn this fast (rad/s, ~515°/s) is a real swing: every labelled slash is (returns and wobbles aren't) */
export const TURN = 9;
const TURN_GAP = 250;

export interface ReplayOpts {
  sens?: number;
  /** centre "towards the TV" as the capture page did live before (at the first reading only) */
  liveHeading?: boolean;
  csv?: string[];
}

export interface Replay {
  meta: Record<string, unknown>;
  ios: boolean;
  segs: Seg[];
  /** what happened outside any step */
  loose: Seg;
  front: MotionFront;
  nM: number;
  nO: number;
  dts: number[];
  span: number;
  igSeen: number;
  igDown: number;
  /** ms from each sword strike's peak to the sample that fired it, and the same for each tennis swing */
  swordDelay: number[];
  tennisDelay: number[];
  /** every onset the tennis detector fired, and every swing it confirmed (peak time `t`), in order */
  tennisStarts: StartEv[];
  tennisSwings: SwingEvent[];
}

export interface StartEv {
  t: number;
  side?: 'fh' | 'bh';
  w: number;
  dw: number;
}

/** an onset with no confirmed swing peaking within this after it is a false start */
export const ONSET_WINDOW = 350;

export interface OnsetStats {
  /** onsets, and how many were followed by a confirmed swing / not */
  starts: number;
  falseStarts: number;
  /** more than one onset for the same swing */
  dupes: number;
  swings: number;
  missed: number;
  /** ms from each swing's (first) onset to its peak */
  leads: number[];
  /** the onset's side against the confirmed swing's side (fh/bh only): [agree, disagree, undecided at the onset] */
  side: [number, number, number];
}

/** Pair the onsets with the confirmed swings: the onset(s) up to ONSET_WINDOW before a swing's peak belong to it. */
export function onsetStats(starts: StartEv[], swings: SwingEvent[]): OnsetStats {
  const st: OnsetStats = { starts: starts.length, falseStarts: 0, dupes: 0, swings: swings.length, missed: 0, leads: [], side: [0, 0, 0] };
  const used = new Set<StartEv>();
  for (const e of swings) {
    const mine = starts.filter((o) => o.t <= e.t && e.t - o.t <= ONSET_WINDOW && !used.has(o));
    if (!mine.length) {
      st.missed++;
      continue;
    }
    mine.forEach((o) => used.add(o));
    st.dupes += mine.length - 1;
    st.leads.push(e.t - mine[0].t);
    if (e.side !== 'oh') {
      if (!mine[0].side) st.side[2]++;
      else if (mine[0].side === e.side) st.side[0]++;
      else st.side[1]++;
    }
  }
  st.falseStarts = starts.filter((o) => !used.has(o)).length;
  return st;
}

/** p50 / p90 / max of a list of delays, ms (NaN when empty) */
export function delayStats(a: number[]): { n: number; p50: number; p90: number; max: number } {
  if (!a.length) return { n: 0, p50: NaN, p90: NaN, max: NaN };
  const s = [...a].sort((x, y) => x - y);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * (s.length - 1) + 0.5))];
  return { n: s.length, p50: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}
export const fmtDelay = (a: number[]) => {
  const d = delayStats(a);
  return d.n ? `n=${d.n} p50 ${d.p50.toFixed(0)} ms, p90 ${d.p90.toFixed(0)} ms, max ${d.max.toFixed(0)} ms` : 'n=0';
};

const newSeg = (label: string, step: number, expect: unknown, t: number): Seg => ({
  label,
  step,
  expect,
  t0: t,
  t1: t,
  live: [],
  strikes: [],
  near: [],
  guarded: [],
  tennis: [],
  judged: [],
  turns: [],
  peakW: 0,
  outcome: 'unfinished',
});

export function replay(lines: Line[], o: ReplayOpts = {}): Replay {
  const meta = (lines.find((l) => l.k === 'meta') ?? {}) as Record<string, unknown>;
  const ua = String(meta.ua ?? '');
  const ios = /iPhone|iPad|iPod|Macintosh/.test(ua);
  const sens = o.sens ?? 1;
  const front = new MotionFront();
  const sword = new SwordDetector();
  sword.sensitivity = sens;
  sword.upSign = ios ? -1 : 1;
  const tennis = new SwingDetector();
  tennis.sensitivity = sens;
  tennis.upSign = ios ? -1 : 1;

  const segs: Seg[] = [];
  let seg: Seg | null = null;
  const loose = newSeg('(outside any step)', -1, 'any', 0);
  loose.outcome = '';
  const cur = () => seg ?? loose;
  const swordDelay: number[] = [];
  const tennisDelay: number[] = [];
  const tennisStarts: StartEv[] = [];
  const tennisSwings: SwingEvent[] = [];
  // (the time of the sample being pushed: a detector's answer is late by that much after the peak)
  let clock = 0;
  sword.onStrike = (s) => {
    cur().strikes.push(s);
    swordDelay.push(clock - s.t);
  };
  sword.onNear = (n) => cur().near.push(n);
  sword.onGuarded = (s) => cur().guarded.push(s);
  sword.onJudge = (j) => cur().judged.push(j);
  tennis.onSwing = (e) => {
    cur().tennis.push(e);
    tennisDelay.push(clock - e.t);
    tennisSwings.push(e);
  };
  tennis.onStart = (e) => tennisStarts.push(e);

  // "Hold the sword ready, facing the TV, still" (the capture's first step): half-way through
  // it is which way the TV is — the capture page centres there (as the game does whenever A is
  // pressed in a menu). Before that, and in captures without it, the first reading.
  let centreAt = Infinity;
  if (!o.liveHeading) {
    const s0 = lines.find((l) => l.k === 'e' && l.ev === 'seg' && l.phase === 'start' && l.label === 'still');
    const s1 = s0 && lines.find((l) => l.k === 'e' && l.ev === 'seg' && l.phase !== 'start' && l.label === 'still' && Number(l.t) > Number(s0.t));
    if (s0 && s1) centreAt = Math.min(Number(s0.t) + 2500, (Number(s0.t) + Number(s1.t)) / 2);
  }

  let guarding = false;
  let nM = 0,
    nO = 0;
  const dts: number[] = [];
  let lastMT = 0;
  let t0 = 0;
  let igSeen = 0,
    igDown = 0;
  // the big turns: the current run above TURN
  let run: Turn | null = null;
  let runSeg: Seg | null = null;
  let lastTurnT = -1e9;

  for (const l of lines) {
    const t = Number(l.t ?? 0);
    if (!t0 && t) t0 = t;
    if (l.k === 'o') {
      nO++;
      const ov = l.o as (number | null)[];
      front.orientEvent({ t, alpha: ov[0], beta: ov[1], gamma: ov[2] });
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
      if (t >= centreAt) {
        centreAt = Infinity;
        front.orient.calibrate();
      }
      // which way gravity reads: along the OS's "up" (W3C) or against it (iOS)
      if (m.hasIg && front.orient.have) {
        const up = front.orient.upDevice();
        const gu = (m.igx - m.ax) * up[0] + (m.igy - m.ay) * up[1] + (m.igz - m.az) * up[2];
        igSeen++;
        if (gu < 0) igDown++;
      }
      if (!guarding) front.orient.autoCenter(m.dt);
      sword.heading = front.orient.heading;
      clock = t;
      sword.push(swordSample(m));
      tennis.push(swingSample(m, front.orient));
      const w = Math.hypot(m.rx, m.ry, m.rz);
      cur().peakW = Math.max(cur().peakW, w);
      if (w >= TURN) {
        if (!run) {
          run = { t, w };
          runSeg = cur();
        } else if (w > run.w) {
          run.t = t;
          run.w = w;
        }
      } else if (run && w < 0.6 * TURN) {
        if (run.t - lastTurnT >= TURN_GAP) runSeg!.turns.push(run);
        lastTurnT = run.t;
        run = null;
      }
      if (o.csv) {
        const b = front.orient.have ? front.orient.devToPlayer([0, 1, 0]) : [0, 0, 0];
        o.csv.push([t.toFixed(1), r[0], r[1], r[2], m.rx.toFixed(3), m.ry.toFixed(3), m.rz.toFixed(3), w.toFixed(3), sword.live.toFixed(3), ...b.map((v) => v.toFixed(3)), guarding ? 1 : 0, seg?.label ?? ''].join(','));
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
          seg = newSeg(String(l.label), Number(l.step), l.expect, t);
          segs.push(seg);
        } else if (seg) {
          seg.t1 = t;
          seg.outcome = phase === 'end' ? 'done' : phase;
          seg = null;
        }
      } else if (ev === 'strike' || ev === 'near' || ev === 'guarded') cur().live.push(l);
    }
  }
  return { meta, ios, segs, loose, front, nM, nO, dts, span: lastMT - t0, igSeen, igDown, swordDelay, tennisDelay, tennisStarts, tennisSwings };
}

export const R2D = 180 / Math.PI;
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
export const arrow = (d: number) => ARROWS[(Math.round(d / (Math.PI / 4)) + 8) % 8];
export const angleOff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** A labelled step, scored: its strikes against the phone's big turns. */
export interface Score {
  turns: number;
  slashes: number;
  thrusts: number;
  /** slashes within 45° of the label (a direction step) */
  right: number;
  /** big turns that struck (a strike within 250 ms of the turn's peak) */
  struck: number;
  /** strikes not at any big turn */
  extra: number;
}

export function score(s: Seg): Score {
  const slashes = s.strikes.filter((x) => x.kind === 'slash');
  const exp = s.expect;
  const right = typeof exp === 'number' ? slashes.filter((x) => angleOff(x.dir, exp) < Math.PI / 4).length : 0;
  const near = (x: SwordStrike, tn: Turn) => Math.abs(x.t - tn.t) < 250;
  const struck = s.turns.filter((tn) => s.strikes.some((x) => near(x, tn))).length;
  const extra = s.strikes.filter((x) => !s.turns.some((tn) => near(x, tn))).length;
  return { turns: s.turns.length, slashes: slashes.length, thrusts: s.strikes.length - slashes.length, right, struck, extra };
}
