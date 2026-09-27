// Headless Home Run Derby — the real rules, pitches, swings and flights — to tune
// the CPU hitters and the pitcher, and to see how a person with a phone would
// fare: whole turns for each CPU level against each pitching level, and a
// simulated person (their swing's timing, power and plane, and the phone's
// latency, going through game.swing() like the real thing). Reports home runs a
// turn, how far they go, fair / foul / miss splits, the pacing, and what a
// step() costs.
//   npx tsx scripts/baseball-sim.ts [turns per cell = 400] [seed = 1]
//   (BASEBALL_SIM_PITCHING=0.5 runs just that pitching level)
//
// The simulated person: their timing error (how early or late the swing's fastest
// moment is against the ball reaching the plate, as they saw it) ~ N(+0.02, 0.05)
// s — reaction and latency jitter —, power ~ U(0.45, 1), plane (lift) ~ N(0.2,
// 0.4). The phone's message reaches the TV 40–120 ms after the swing's peak (its
// `age`), in between frames.

import { BaseballGame, DISPLAY_LAG, type BaseballOptions } from '../src/tv/baseball/game';
import type { BaseballEvent, Hitter } from '../src/tv/baseball/types';
import { FLY } from '../src/tv/baseball/physics';
import { Rng } from '../src/tv/core/math';
import { pathToFileURL } from 'node:url';

const N = Number(process.argv[2] ?? 400);
const SEED = Number(process.argv[3] ?? 1);

export interface PersonModel {
  name: string;
  /** timing error: mean and σ, s */
  eMean: number;
  eSd: number;
  /** swing power: uniform between */
  power: [number, number];
  /** swing plane: mean and σ */
  lift: number;
  liftSd: number;
  /** the message's age when it gets to the TV: uniform between, s */
  age: [number, number];
}

export const PERSON: PersonModel = { name: 'person', eMean: 0.02, eSd: 0.05, power: [0.45, 1], lift: 0.2, liftSd: 0.4, age: [0.04, 0.12] };
/** someone who's got the hang of it: tighter timing, a bit more lift */
export const GOOD: PersonModel = { name: 'good player', eMean: 0.01, eSd: 0.032, power: [0.6, 1], lift: 0.35, liftSd: 0.3, age: [0.04, 0.12] };
/** a first go: late and all over the place */
export const NEWBIE: PersonModel = { name: 'first-timer', eMean: 0.04, eSd: 0.07, power: [0.35, 0.95], lift: 0.1, liftSd: 0.5, age: [0.04, 0.12] };

/** A person with a phone, as the TV sees them: one swing per pitch, its message arriving between frames. */
export class SimPerson {
  private arrive = -1;
  private sw = { power: 0, lift: 0, age: 0 };
  private pitchT0 = -1;

  constructor(
    readonly m: PersonModel,
    readonly slot: number,
    readonly rng: Rng,
  ) {}

  /** before each step of dt: plan a swing at a new pitch; send it if it arrives during this frame */
  step(g: BaseballGame, dt: number) {
    const h = g.hitters[g.current];
    if (h.slot !== this.slot || h.cpu !== null) return;
    const p = g.pitch;
    if (g.state === 'pitch' && p && p.t0 !== this.pitchT0) {
      this.pitchT0 = p.t0;
      const r = this.rng;
      const e = this.m.eMean + this.m.eSd * r.gauss();
      this.sw.power = r.range(this.m.power[0], this.m.power[1]);
      this.sw.lift = this.m.lift + this.m.liftSd * r.gauss();
      this.sw.age = r.range(this.m.age[0], this.m.age[1]);
      // the swing peaks as they see the ball e s from the plate: shown DISPLAY_LAG late; the message is `age` old when it gets here
      this.arrive = p.tc + e + DISPLAY_LAG + this.sw.age;
    }
    if (this.arrive >= 0 && this.arrive <= g.t + dt) {
      const since = Math.max(0, this.arrive - g.t);
      this.arrive = -1;
      g.swing(this.slot, { power: this.sw.power, lift: this.sw.lift, age: this.sw.age }, since);
    }
  }
}

export interface Tally {
  turns: number;
  pitches: number;
  hr: number;
  fair: number;
  foul: number;
  miss: number;
  wall: number;
  out: number;
  sweet: number;
  hrCounts: number[];
  hrDist: number[];
  hitDist: number[];
  hang: number[];
  apex: number[];
  /** seconds from one pitch's 'ready' to the next, by outcome */
  pace: Record<'strike' | 'foul' | 'hit' | 'homerun', number[]>;
  steps: number;
  stepMs: number;
  maxStepMs: number;
}

export const tally = (): Tally => ({ turns: 0, pitches: 0, hr: 0, fair: 0, foul: 0, miss: 0, wall: 0, out: 0, sweet: 0, hrCounts: [], hrDist: [], hitDist: [], hang: [], apex: [], pace: { strike: [], foul: [], hit: [], homerun: [] }, steps: 0, stepMs: 0, maxStepMs: 0 });

const look = {} as Hitter['look'];

/** one turn (10 pitches) for one hitter: a CPU of this skill, or a simulated person */
export function playTurn(who: number | PersonModel, seed: number, t: Tally, opts: BaseballOptions = {}) {
  const cpu = typeof who === 'number';
  const hitters: Hitter[] = [{ name: 'A', color: '#e33', look, handed: seed % 3 === 0 ? -1 : 1, slot: cpu ? -1 : 0, cpu: cpu ? who : null }];
  const g = new BaseballGame(hitters, { seed, ...opts });
  const rng = new Rng(seed * 31 + 7);
  const person = cpu ? null : new SimPerson(who, 0, rng);
  let readyT = -1;
  let hrs = 0;
  g.onEvent = (e: BaseballEvent) => {
    if (e.type === 'windup') {
      /* (the pitch cycle is timed from one windup to the next) */
    }
    if (e.type === 'contact') {
      if (e.ball.sweet) t.sweet++;
    }
    if (e.type === 'result') {
      t.pitches++;
      const b = g.hit;
      if (e.outcome === 'homerun') {
        hrs++;
        t.hr++;
        t.hrDist.push(e.distance);
        if (b) (t.hang.push(b.hang), t.apex.push(b.apex));
        if (g.battedFlight?.end === 'out') t.out++;
      }
      if (e.outcome === 'hit' || e.outcome === 'homerun') t.fair++;
      if (e.outcome === 'hit') t.hitDist.push(e.distance);
      if (e.outcome === 'hit' && b?.wall) t.wall++;
      if (e.outcome === 'foul') t.foul++;
      if (e.outcome === 'strike') t.miss++;
    }
  };
  let lastWindup = -1;
  let lastOutcome: keyof Tally['pace'] | null = null;
  const onEv = g.onEvent;
  g.onEvent = (e) => {
    onEv(e);
    if (e.type === 'windup') {
      if (lastWindup >= 0 && lastOutcome) t.pace[lastOutcome].push(g.t - lastWindup);
      lastWindup = g.t;
    }
    if (e.type === 'result') lastOutcome = e.outcome;
  };
  g.skip();
  void readyT;
  while (g.state !== 'over' && g.t < 600) {
    // a browser's frame times wander
    const dt = (1 / 60) * rng.range(0.7, 1.3);
    person?.step(g, dt);
    const t0 = performance.now();
    g.step(dt);
    const ms = performance.now() - t0;
    t.steps++;
    t.stepMs += ms;
    t.maxStepMs = Math.max(t.maxStepMs, ms);
  }
  t.turns++;
  t.hrCounts.push(hrs);
}

const pct = (a: number, n: number) => `${((100 * a) / Math.max(1, n)).toFixed(0)}%`.padStart(4);
const q = (a: number[], p: number) => {
  if (!a.length) return '  —';
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0).padStart(3);
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export function report(label: string, t: Tally) {
  console.log(
    [
      label.padEnd(18),
      ((10 * t.hr) / Math.max(1, t.pitches)).toFixed(2).padStart(5),
      `${q(t.hrCounts, 0.1)} ${q(t.hrCounts, 0.5)} ${q(t.hrCounts, 0.9)}`,
      pct(t.fair, t.pitches),
      pct(t.foul, t.pitches),
      pct(t.miss, t.pitches),
      pct(t.wall, t.pitches),
      pct(t.sweet, t.pitches),
      `${q(t.hrDist, 0.1)} ${q(t.hrDist, 0.5)} ${q(t.hrDist, 0.9)} ${q(t.hrDist, 1)}`,
      `${pct(t.out, t.hr)}`,
      `${q(t.hitDist, 0.1)} ${q(t.hitDist, 0.5)} ${q(t.hitDist, 0.9)}`,
    ].join('  '),
  );
}

const LEVELS = [
  ['Rookie', 0.3],
  ['Pro', 0.6],
  ['Ace', 0.9],
] as const;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`${N} turns of 10 pitches per cell; frame times 1/60 s ±30%. A monster (≥ ${FLY.monster} m) flies out of the stadium.`);
  console.log('HR/10 = home runs a turn (mean), then the 10th/50th/90th percentile; fair/foul/miss (strikes)/wall/sweet as a share of pitches; HR m = 10/50/90th pct and the longest; out = monsters (share of HRs); hit m = fair non-HRs.\n');
  const head = 'hitter              HR/10  turn HRs   fair foul miss wall  swt  HR m (10/50/90/max)  out  hit m';
  const all = tally();
  const add = (t: Tally) => {
    all.steps += t.steps;
    all.stepMs += t.stepMs;
    all.maxStepMs = Math.max(all.maxStepMs, t.maxStepMs);
    for (const k of Object.keys(all.pace) as (keyof Tally['pace'])[]) all.pace[k].push(...t.pace[k]);
  };
  const only = process.env.BASEBALL_SIM_PITCHING;
  for (const pitching of only ? [Number(only)] : [0, 0.25, 0.5, 0.75, 1]) {
    console.log(`— pitching ${pitching}`);
    console.log(head);
    for (const [name, skill] of LEVELS) {
      const t = tally();
      for (let n = 0; n < N; n++) playTurn(skill, SEED * 100000 + n, t, { pitching });
      report(`${name} ${skill}`, t);
      add(t);
    }
    if (pitching === 0.5)
      for (const skill of [0, 1]) {
        const t = tally();
        for (let n = 0; n < N; n++) playTurn(skill, SEED * 100000 + n, t, { pitching });
        report(`CPU skill ${skill}`, t);
        add(t);
      }
    for (const p of [NEWBIE, PERSON, GOOD]) {
      const t = tally();
      for (let n = 0; n < N; n++) playTurn(p, SEED * 100000 + n, t, { pitching });
      report(p.name, t);
      add(t);
    }
    console.log('');
  }
  const P = all.pace;
  const n = P.strike.length + P.foul.length + P.hit.length + P.homerun.length;
  console.log(
    `pacing, windup to windup: strike ${mean(P.strike).toFixed(2)} s, foul ${mean(P.foul).toFixed(2)} s, hit ${mean(P.hit).toFixed(2)} s, home run ${mean(P.homerun).toFixed(2)} s (${q(P.homerun, 0.1)}…${q(P.homerun, 0.9)}); ` +
      `average ${((P.strike.reduce((a, b) => a + b, 0) + P.foul.reduce((a, b) => a + b, 0) + P.hit.reduce((a, b) => a + b, 0) + P.homerun.reduce((a, b) => a + b, 0)) / Math.max(1, n)).toFixed(2)} s a pitch`,
  );
  console.log(`step(): ${((1000 * all.stepMs) / all.steps).toFixed(2)} µs a frame on average over ${(all.steps / 1e6).toFixed(2)}M frames, worst ${(1000 * all.maxStepMs).toFixed(0)} µs.`);
}
