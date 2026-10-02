// Headless archery — the real rules, flights and CPU archers — to tune the CPUs
// and see how a person with a phone would fare: whole games at each CPU level,
// and a simulated person of a few skill levels. Reports points an arrow (overall
// and per end), 10s, Xs, misses, balloons popped, flight times, and what a
// step() costs.
//   npx tsx scripts/check/archery-sim.ts [games per archer = 200] [seed = 1]
//
// The simulated person holds a phone: the aim the TV gets wanders with their
// hand's tremor (a slow random drift), they hold over the target by what they
// believe the drop is and allow for part of the wind — misjudged a little each
// end — then correct arrow by arrow from where the last one went. They hold at
// full draw for a while (a dawdler long enough to shake) and now and then let go
// before full draw.

import { ArcheryGame } from '../../src/tv/archery/game';
import type { Archer, ArcheryEvent } from '../../src/tv/archery/types';
import { aimFor, sightTo, type Aim } from '../../src/tv/archery/physics';
import { RANGE } from '../../src/tv/archery/range';
import { Rng } from '../../src/tv/core/math';
import { pathToFileURL } from 'node:url';

const N = Number(process.argv[2] ?? 200);
const SEED = Number(process.argv[3] ?? 1);

export interface PersonSkill {
  name: string;
  /** the hand's tremor: σ of the aim's wander, radians per axis (it drifts, time constant ~0.35 s) */
  tremor: number;
  /** judging the drop at a new distance: σ as a share of the true hold-over */
  dropErr: number;
  /** how much of the wind's drift they allow for (mean) and σ of that, each end */
  windComp: number;
  windErr: number;
  /** after each arrow, they move their aim this share of the way to correct where it went */
  fix: number;
  /** held at full draw before letting go, s (mean, σ) */
  hold: number;
  holdSd: number;
  /** chance they let go before full draw (at 60–95%) */
  early: number;
}

export const PEOPLE: PersonSkill[] = [
  { name: 'novice', tremor: 0.006, dropErr: 0.3, windComp: 0.3, windErr: 0.3, fix: 0.45, hold: 0.8, holdSd: 0.4, early: 0.12 },
  { name: 'casual', tremor: 0.004, dropErr: 0.15, windComp: 0.6, windErr: 0.25, fix: 0.6, hold: 1.2, holdSd: 0.5, early: 0.05 },
  { name: 'good', tremor: 0.0025, dropErr: 0.08, windComp: 0.9, windErr: 0.15, fix: 0.7, hold: 1.5, holdSd: 0.6, early: 0.02 },
];
/** a good shot who holds and holds at full draw (the bow starts to shake after 2.5 s) */
export const DAWDLER: PersonSkill = { ...PEOPLE[2], name: 'dawdler', hold: 6.5, holdSd: 1.5 };

/** A person with a phone and the DRAW pad, as the TV sees them. */
export class SimPerson {
  private wy = 0;
  private wp = 0;
  /** where they mean to aim this arrow */
  private want: Aim = { yaw: 0, pitch: 0 };
  /** this end's misjudgement, and what they've corrected since */
  private dropK = 1;
  private windK = 0;
  private fixYaw = 0;
  private fixPitch = 0;
  private end = 0;
  private drawAt = -1;
  private letGoAt = -1;
  private letGoDraw = 1;
  private down = false;

  constructor(
    readonly s: PersonSkill,
    readonly slot: number,
    readonly me: number,
    readonly rng: Rng,
  ) {}

  /** where their arrows are going on the main face (from the 'score' of their last) */
  saw(g: ArcheryGame) {
    const sh = g.last;
    if (!sh || sh.who !== this.me) return;
    const face = g.mainTarget();
    const d = RANGE.lineZ - face.z;
    // off the face or not, they see about where it went relative to the centre
    const dx = sh.target === face.id ? sh.fx : sh.px - face.x;
    const dy = sh.target === face.id ? sh.fy : sh.where === 'ground' ? -2 : sh.py - face.y;
    this.fixYaw += (this.s.fix * dx) / d;
    this.fixPitch -= (this.s.fix * Math.max(-2, Math.min(2, dy))) / d;
  }

  step(g: ArcheryGame, dt: number) {
    const r = this.rng;
    // the hand's wander (an Ornstein–Uhlenbeck drift with σ = tremor)
    const k = Math.exp(-dt / 0.35);
    const q = this.s.tremor * Math.sqrt(1 - k * k);
    this.wy = this.wy * k + q * r.gauss();
    this.wp = this.wp * k + q * r.gauss();
    const ar = g.archers[g.current];
    if (g.state !== 'aim' || ar.slot !== this.slot) {
      if (this.down) g.draw(this.slot, (this.down = false));
      this.drawAt = -1;
      return;
    }
    const a = g.archer;
    if (this.drawAt < 0) this.plan(g);
    g.aim(this.slot, this.want.yaw + this.wy, this.want.pitch + this.wp);
    if (!this.down && g.t >= this.drawAt && a.phase === 'nock') g.draw(this.slot, (this.down = true));
    if (this.down && (a.phase === 'draw' || a.phase === 'hold')) {
      const early = this.letGoDraw < 1 && a.phase === 'draw' && a.draw >= this.letGoDraw;
      if (early || (a.phase === 'hold' && a.t >= this.letGoAt)) g.draw(this.slot, (this.down = false));
    }
  }

  /** a new arrow: what they'll aim at and when they'll let go */
  private plan(g: ArcheryGame) {
    const s = this.s;
    const r = this.rng;
    if (g.end !== this.end) {
      // a new distance and wind: judged afresh (and nothing corrected yet)
      this.end = g.end;
      this.dropK = 1 + s.dropErr * r.gauss();
      this.windK = s.windComp + s.windErr * r.gauss();
      this.fixYaw = this.fixPitch = 0;
    }
    const face = g.mainTarget();
    const sight = sightTo(face.x, face.y, face.z);
    const still = aimFor(face.x, face.y, face.z, RANGE.fullSpeed, 0);
    const windy = aimFor(face.x, face.y, face.z, RANGE.fullSpeed, g.wind);
    this.want.pitch = sight.pitch + (still.pitch - sight.pitch) * this.dropK + this.fixPitch;
    this.want.yaw = still.yaw + (windy.yaw - still.yaw) * this.windK + this.fixYaw;
    this.drawAt = g.nockAt + r.range(0.3, 1.2);
    this.letGoAt = Math.max(0.05, s.hold + s.holdSd * r.gauss());
    this.letGoDraw = r.chance(s.early) ? r.range(0.6, 0.95) : 1;
  }
}

interface Tally {
  arrows: number;
  points: number;
  perEnd: number[];
  perEndN: number[];
  tens: number;
  xs: number;
  misses: number;
  balloons: number;
  weak: number;
  games: number;
  totals: number[];
  flight: number[];
  steps: number;
  stepMs: number;
  flightSteps: number;
  flightMs: number;
  maxStepMs: number;
}

const tally = (): Tally => ({ arrows: 0, points: 0, perEnd: [0, 0, 0], perEndN: [0, 0, 0], tens: 0, xs: 0, misses: 0, balloons: 0, weak: 0, games: 0, totals: [], flight: [], steps: 0, stepMs: 0, flightSteps: 0, flightMs: 0, maxStepMs: 0 });

const look = {} as Archer['look'];

/** one game, one archer (a CPU of this skill, or the simulated person) */
export function playGame(who: number | PersonSkill, seed: number, t: Tally) {
  const cpu = typeof who === 'number';
  const archers: Archer[] = [{ name: 'A', color: '#e33', look, handed: 1, slot: cpu ? -1 : 0, cpu: cpu ? who : null }];
  const g = new ArcheryGame(archers, { seed });
  const rng = new Rng(seed * 31 + 7);
  const person = cpu ? null : new SimPerson(who, 0, 0, rng);
  g.onEvent = (e: ArcheryEvent) => {
    if (e.type === 'score') {
      const sh = g.last!;
      t.arrows++;
      t.points += e.points;
      t.perEnd[sh.end - 1] += e.points;
      t.perEndN[sh.end - 1]++;
      if (sh.ring === 10) t.tens++;
      if (sh.x) t.xs++;
      if (sh.ring === 0) t.misses++;
      t.balloons += sh.balloons.length;
      if (sh.speed < RANGE.fullSpeed - 1e-6) t.weak++;
      t.flight.push(sh.flightT);
      person?.saw(g);
    }
  };
  g.skip();
  while (g.state !== 'over' && g.t < 900) {
    // a browser's frame times wander
    const dt = (1 / 60) * rng.range(0.7, 1.3);
    person?.step(g, dt);
    const flying = g.state === 'flight';
    const t0 = performance.now();
    g.step(dt);
    const ms = performance.now() - t0;
    t.steps++;
    t.stepMs += ms;
    t.maxStepMs = Math.max(t.maxStepMs, ms);
    if (flying) ((t.flightSteps++), (t.flightMs += ms));
    // skip the waits between arrows (the flights and the aiming run in full)
    if (g.state === 'result' || g.state === 'next') g.skip();
  }
  t.games++;
  t.totals.push(g.total(0));
}

function report(label: string, t: Tally) {
  const pct = (a: number) => `${((100 * a) / Math.max(1, t.arrows)).toFixed(0)}%`.padStart(4);
  const tot = [...t.totals].sort((a, b) => a - b);
  const q = (p: number) => String(tot[Math.min(tot.length - 1, Math.floor(p * tot.length))] ?? 0).padStart(3);
  const fl = [...t.flight].sort((a, b) => a - b);
  console.log(
    [
      label.padEnd(14),
      (t.points / Math.max(1, t.arrows)).toFixed(2).padStart(5),
      t.perEnd.map((p, i) => (p / Math.max(1, t.perEndN[i])).toFixed(2).padStart(5)).join(' '),
      `${q(0.1)} ${q(0.5)} ${q(0.9)}`,
      pct(t.tens),
      pct(t.xs),
      pct(t.misses),
      (t.balloons / Math.max(1, t.games)).toFixed(2).padStart(5),
      pct(t.weak),
      `${(fl[0] ?? 0).toFixed(2)}–${(fl[fl.length - 1] ?? 0).toFixed(2)}`,
      ((1000 * t.stepMs) / Math.max(1, t.steps)).toFixed(2).padStart(6),
      ((1000 * t.flightMs) / Math.max(1, t.flightSteps)).toFixed(2).padStart(6),
    ].join('  '),
  );
}

const LEVELS = [
  ['Rookie', 0.3],
  ['Pro', 0.65],
  ['Ace', 0.9],
] as const;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`${N} games per archer, each ${3} ends × 3 arrows (the standard game), frame times 1/60 s ±30%; the waits between arrows skipped.`);
  console.log('pts/arrow = overall, then ends 1 2 3; game total = 10th / 50th / 90th percentile (of 90, plus balloons); balloons per game; weak = let go before full draw.\n');
  console.log('archer          pts   end 1 end 2 end 3  game total   10s   Xs  miss  balloons weak  flight s    step µs  in flight');
  const all = tally();
  const add = (t: Tally) => ((all.steps += t.steps), (all.stepMs += t.stepMs), (all.maxStepMs = Math.max(all.maxStepMs, t.maxStepMs)));
  console.log('— CPU');
  for (const [name, skill] of LEVELS) {
    const t = tally();
    for (let n = 0; n < N; n++) playGame(skill, SEED * 100000 + n, t);
    report(`${name} ${skill}`, t);
    add(t);
  }
  for (const skill of [0, 1]) {
    const t = tally();
    for (let n = 0; n < N; n++) playGame(skill, SEED * 100000 + n, t);
    report(`skill ${skill}`, t);
    add(t);
  }
  console.log('— simulated person');
  for (const p of [...PEOPLE, DAWDLER]) {
    const t = tally();
    for (let n = 0; n < N; n++) playGame(p, SEED * 100000 + n, t);
    report(p.name, t);
    add(t);
  }
  console.log(`\nstep(): ${((1000 * all.stepMs) / all.steps).toFixed(2)} µs a frame on average over ${(all.steps / 1e6).toFixed(2)}M frames (CPU brains included), worst ${(1000 * all.maxStepMs).toFixed(0)} µs.`);
}
