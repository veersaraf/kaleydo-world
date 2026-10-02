// Headless sword duels — the real referee and CPU brains — to tune the CPUs: CPU vs
// CPU at each level, and a simulated person of a few skill levels against each.
// Reports win rates, round lengths, hits / blocks (= stuns) / clashes per round,
// falls vs timeouts, and what a step() costs.
//   npx tsx scripts/check/duel-sim.ts [matches per pairing = 200] [seed = 1]
//
// The simulated person holds a phone: they see a CPU's windup a reaction time
// late and guard across it (with an angle error, sometimes misreading it), counter
// a stunned CPU, and in quiet moments cock and swing at some rate — the cock shows
// on the TV (the phone's pose streams at 30 Hz) before the swing's message arrives,
// which is what the CPU reads.

import { DuelGame } from '../../src/tv/duel/game';
import { bladeAngle, type DuelEvent, type Duelist, type SlashInput } from '../../src/tv/duel/types';
import { ARENA } from '../../src/tv/duel/arena';
import { blendAim, cockAim, guardAim, newAim, readyAim, swingAim } from '../../src/tv/duel/aim';
import { Rng, clamp, deg } from '../../src/tv/core/math';
import { pathToFileURL } from 'node:url';

const N = Number(process.argv[2] ?? 200);
const SEED = Number(process.argv[3] ?? 1);

export interface PersonSkill {
  name: string;
  /** reaction time to what the CPU does (mean and spread), s */
  react: number;
  reactSd: number;
  /** guard angle error σ, degrees; chance of guarding the wrong line altogether */
  guardErr: number;
  misread: number;
  /** moving the phone to a new guard angle, s */
  guardMove: number;
  /** seeing a windup: chance they guard it; else chance they swing back into it (a trade), else they freeze */
  discipline: number;
  trade: number;
  /** in quiet moments: raising a guard (per s), dropping it again (per s), attacking (per s) */
  guardRate: number;
  dropRate: number;
  attackRate: number;
  /** chance an attack goes along the line the CPU's guard leaves open (else any cut) */
  aimSmart: number;
  /** chance they counter a stunned CPU */
  counter: number;
  /** cocking before a swing (the TV sees it) and the swing itself, s */
  cockT: number;
  swingT: number;
  power: number;
  thrust: number;
  /** the cuts they pick from when not aiming along the CPU's guard (default: all sorts, mostly down) */
  cuts?: number[];
}

export const PEOPLE: PersonSkill[] = [
  // a first-timer: swings a lot, in any direction, rarely guards (and late, and roughly), always winds up
  { name: 'beginner', react: 0.55, reactSd: 0.1, guardErr: 32, misread: 0.3, guardMove: 0.22, discipline: 0.2, trade: 0.5, guardRate: 0.15, dropRate: 1.2, attackRate: 1.3, aimSmart: 0, counter: 0.3, cockT: 0.3, swingT: 0.2, power: 0.6, thrust: 0.05 },
  { name: 'novice', react: 0.45, reactSd: 0.08, guardErr: 28, misread: 0.2, guardMove: 0.18, discipline: 0.5, trade: 0.4, guardRate: 0.4, dropRate: 0.8, attackRate: 1.1, aimSmart: 0.1, counter: 0.45, cockT: 0.32, swingT: 0.18, power: 0.7, thrust: 0.08 },
  { name: 'average', react: 0.35, reactSd: 0.06, guardErr: 18, misread: 0.1, guardMove: 0.14, discipline: 0.75, trade: 0.4, guardRate: 0.6, dropRate: 0.6, attackRate: 0.7, aimSmart: 0.35, counter: 0.7, cockT: 0.26, swingT: 0.16, power: 0.65, thrust: 0.1 },
  { name: 'expert', react: 0.27, reactSd: 0.04, guardErr: 11, misread: 0.04, guardMove: 0.11, discipline: 0.9, trade: 0.3, guardRate: 0.8, dropRate: 0.4, attackRate: 0.6, aimSmart: 0.65, counter: 0.9, cockT: 0.2, swingT: 0.13, power: 0.65, thrust: 0.12 },
];

/** an average player who found a trick: flick sideways cuts straight from the stance, never
 *  cocking (nothing for the CPU to read) — it shouldn't be a win button */
export const FLICKER: PersonSkill = { ...PEOPLE[2], name: 'flicker', cockT: 0.04, aimSmart: 0, thrust: 0, cuts: [0, Math.PI] };

const CUTS = [-Math.PI / 2, -Math.PI / 4, (-3 * Math.PI) / 4, 0, Math.PI, Math.PI / 4, (3 * Math.PI) / 4];

interface Noticed {
  at: number;
  kind: 'windup' | 'stun' | 'over';
  attack: SlashInput;
}

/** A person with a phone, as the TV sees them: guard button, swings, and the phone's pose. */
export class SimPerson {
  aim = newAim();
  private want = newAim();
  private mode: 'idle' | 'guard' | 'cock' | 'swing' | 'back' = 'idle';
  private modeT0 = 0;
  private modeDur = 0;
  private atk: SlashInput = { kind: 'slash', dir: 0, power: 0.6 };
  private guardDown = false;
  /** the guard button changed: sent on the next flush */
  pendingGuard = false;
  private guardAng = Math.PI / 2;
  /** believes an attack is on its way (a windup seen, not yet over) */
  private threat = false;
  private seen: Noticed[] = [];
  private lastPhase = '';
  private lastT = 0;
  private sendAt = 0;
  /** the CPU's blade angle a moment ago (what the person reads its guard from) */
  private hist: { t: number; ang: number }[] = [];

  constructor(
    readonly s: PersonSkill,
    readonly slot: number,
    readonly me: number,
    readonly rng: Rng,
  ) {}

  private react() {
    return Math.max(0.15, this.s.react + this.rng.gauss() * this.s.reactSd);
  }

  step(g: DuelGame, dt: number) {
    const t = g.t;
    const cpu = g.fighters[1 - this.me];
    const r = this.rng;
    // what the CPU starts, noticed a reaction time later
    const ph = cpu.phase;
    if (ph === 'windup' && (this.lastPhase !== 'windup' || cpu.t < this.lastT)) {
      const a = cpu.attack!;
      this.seen.push({ at: t + this.react(), kind: 'windup', attack: { kind: a.kind, dir: a.dir, power: a.power } });
    } else if (ph === 'stunned' && this.lastPhase !== 'stunned') {
      this.seen.push({ at: t + this.react(), kind: 'stun', attack: this.atk });
    } else if ((this.lastPhase === 'slash' || this.lastPhase === 'thrust' || this.lastPhase === 'windup') && ph !== 'slash' && ph !== 'thrust' && ph !== 'windup') {
      this.seen.push({ at: t + this.react(), kind: 'over', attack: this.atk });
    }
    this.lastPhase = ph;
    this.lastT = cpu.t;
    this.hist.push({ t, ang: bladeAngle(cpu.aim) });
    if (this.hist.length > 200) this.hist.splice(0, 100);

    while (this.seen.length && this.seen[0].at <= t) this.notice(g, this.seen.shift()!);

    if (g.state === 'fight') {
      const inReach = g.gap() <= ARENA.reach;
      const quiet = !this.threat && (this.mode === 'idle' || this.mode === 'guard');
      if (quiet && inReach && r.chance(this.s.attackRate * dt)) this.attack(g, false);
      else if (this.mode === 'idle' && !this.threat && r.chance(this.s.guardRate * dt)) this.raise(r.chance(0.5) ? Math.PI / 2 : 0);
      else if (this.mode === 'guard' && !this.threat && r.chance(this.s.dropRate * dt)) this.drop();
    }

    // the swing plays out: cock → swing → the phone sends it → back to the stance
    const u = this.modeDur > 0 ? (t - this.modeT0) / this.modeDur : 1;
    if (this.mode === 'cock' && u >= 1) this.setMode('swing', t, this.s.swingT);
    else if (this.mode === 'swing' && u >= 1) {
      g.slash(this.slot, { kind: this.atk.kind, dir: this.atk.dir + r.gauss() * deg(8), power: this.atk.power });
      this.setMode('back', t, 0.25);
    } else if (this.mode === 'back' && u >= 1) this.setMode('idle', t, 0);

    // where the phone is
    switch (this.mode) {
      case 'cock':
        cockAim(this.want, this.atk);
        blendAim(this.aim, this.want, 1 - Math.exp(-dt * 14));
        break;
      case 'swing':
        swingAim(this.aim, this.atk, clamp((t - this.modeT0) / this.modeDur), 0.8);
        break;
      case 'guard':
        guardAim(this.want, this.guardAng, 1);
        blendAim(this.aim, this.want, 1 - Math.exp((-dt * 3) / this.s.guardMove));
        break;
      default:
        readyAim(this.want);
        blendAim(this.aim, this.want, 1 - Math.exp(-dt * 8));
    }
    if (t >= this.sendAt) {
      g.aim(this.slot, this.aim);
      this.sendAt = t + 1 / 30;
    }
  }

  private notice(g: DuelGame, n: Noticed) {
    const r = this.rng;
    const s = this.s;
    if (n.kind === 'windup') {
      this.threat = true;
      if (this.mode === 'swing') return; // committed
      if (this.mode === 'cock' && !r.chance(s.discipline)) return;
      const x = r.next();
      if (x < s.discipline) {
        // guard across the cut they read (any guard stops a thrust)
        let ang = this.guardAng;
        if (n.attack.kind === 'slash') {
          ang = Math.PI - n.attack.dir + Math.PI / 2 + r.gauss() * deg(s.guardErr);
          if (r.chance(s.misread)) ang += Math.PI / 2;
        }
        this.raise(ang);
      } else if (x < s.discipline + (1 - s.discipline) * s.trade && g.gap() <= ARENA.reach) this.attack(g, true);
    } else if (n.kind === 'stun') {
      if ((this.mode === 'idle' || this.mode === 'guard') && g.gap() <= ARENA.reach && r.chance(s.counter)) this.attack(g, true, true);
    } else {
      this.threat = false;
      if (this.mode === 'guard' && r.chance(0.5)) this.drop();
    }
  }

  private raise(ang: number) {
    this.guardAng = ang;
    if (this.mode !== 'guard') this.setMode('guard', 0, 0);
    if (!this.guardDown) this.guardDown = true;
    this.pendingGuard = true;
  }

  private drop() {
    this.setMode('idle', 0, 0);
    this.guardDown = false;
    this.pendingGuard = true;
  }

  flushGuard(g: DuelGame) {
    if (!this.pendingGuard) return;
    this.pendingGuard = false;
    g.guard(this.slot, this.guardDown);
  }

  private attack(g: DuelGame, quick: boolean, counter = false) {
    const r = this.rng;
    const s = this.s;
    const a = this.atk;
    a.power = clamp(s.power + r.gauss() * 0.15, 0.15, 1);
    if (r.chance(s.thrust)) {
      a.kind = 'thrust';
      a.dir = 0;
    } else {
      a.kind = 'slash';
      if (!counter && r.chance(s.aimSmart)) {
        // along the CPU's guard (as it looked a moment ago): the line it can't stop
        const tq = g.t - this.react();
        let ang = this.hist[0]?.ang ?? Math.PI / 2;
        for (const h of this.hist) if (h.t <= tq) ang = h.ang;
        let d = -ang;
        if (Math.sin(d) > 0.2) d += Math.PI;
        a.dir = Math.atan2(Math.sin(d), Math.cos(d));
      } else a.dir = r.pick(s.cuts ?? CUTS);
    }
    if (this.guardDown) {
      this.guardDown = false;
      this.pendingGuard = true;
    }
    this.setMode('cock', g.t, this.s.cockT * (quick ? 0.5 : 1) * r.range(0.85, 1.15));
  }

  private setMode(m: SimPerson['mode'], t: number, dur: number) {
    this.mode = m;
    this.modeT0 = t;
    this.modeDur = dur;
  }
}

// ---------------------------------------------------------------- matches

interface RoundStat {
  len: number;
  end: 'fall' | 'timeout' | 'draw';
  final: boolean;
  hits: [number, number];
  blocks: [number, number];
  attacks: [number, number];
  whiffs: number;
  clashes: number;
}

/** what the one who got hit was doing just before */
const HOW = ['counter', 'windup', 'guard', 'open', 'stagger'] as const;
type How = (typeof HOW)[number];

interface Tally {
  matches: number;
  wins0: number;
  rounds: RoundStat[];
  steps: number;
  stepMs: number;
  how: Record<How, number>;
  strength: number;
}

const look = {} as Duelist['look'];
const duelist = (cpu: number | null, slot: number): Duelist => ({ name: cpu === null ? 'P' : 'CPU', color: '#fff', look, handed: 1, slot, cpu });

export function playMatch(a: PersonSkill | number, b: number, seed: number, t: Tally) {
  const rng = new Rng(seed * 7 + 3);
  const person = typeof a === 'number' ? null : new SimPerson(a, 0, 0, new Rng(seed * 13 + 5));
  const g = new DuelGame([duelist(person ? null : (a as number), 0), duelist(b, -1)], { seed });
  let cur: RoundStat | null = null;
  let fightT = 0;
  // phases as they were before this step (what a hit interrupted), and strikes not yet landed
  const before = ['ready', 'ready'];
  const out = [-1, -1];
  const land = (i: number) => (out[i] = -1);
  g.onEvent = (e: DuelEvent) => {
    switch (e.type) {
      case 'round':
        cur = { len: 0, end: 'fall', final: e.final, hits: [0, 0], blocks: [0, 0], attacks: [0, 0], whiffs: 0, clashes: 0 };
        out[0] = out[1] = -1;
        break;
      case 'fight':
        fightT = g.t;
        break;
      case 'attack':
        cur!.attacks[e.who]++;
        out[e.who] = g.t;
        break;
      case 'hit': {
        cur!.hits[e.by]++;
        land(e.by);
        land(e.who);
        const p = before[e.who];
        const how: How = p === 'stunned' ? 'counter' : p === 'windup' ? 'windup' : p === 'guard' ? 'guard' : p === 'stagger' ? 'stagger' : 'open';
        t.how[how]++;
        t.strength += e.strength;
        break;
      }
      case 'block':
        cur!.blocks[e.who]++;
        land(e.by);
        break;
      case 'clash':
        cur!.clashes++;
        land(0);
        land(1);
        break;
      case 'fall':
        cur!.len = g.t - fightT;
        break;
      case 'round-end':
        if (e.timeout) cur!.len = g.t - fightT;
        cur!.end = e.winner === null ? 'draw' : e.timeout ? 'timeout' : 'fall';
        t.rounds.push(cur!);
        break;
      case 'over':
        if (e.winner === 0) t.wins0++;
        break;
    }
  };
  g.skip();
  let steps = 0;
  let ms = 0;
  while (g.state !== 'over' && g.t < 600) {
    // a browser's frame times wander
    const dt = (1 / 60) * rng.range(0.7, 1.3);
    if (person) {
      person.step(g, dt);
      person.flushGuard(g);
    }
    before[0] = g.fighters[0].phase;
    before[1] = g.fighters[1].phase;
    const t0 = performance.now();
    g.step(dt);
    ms += performance.now() - t0;
    steps++;
    // a strike that's had time to land and didn't: a whiff
    for (let i = 0; i < 2; i++) {
      if (out[i] >= 0 && g.t - out[i] > 0.15) {
        out[i] = -1;
        if (cur && g.state === 'fight') (cur as RoundStat).whiffs++;
      }
    }
  }
  t.matches++;
  t.steps += steps;
  t.stepMs += ms;
}

export function tally(): Tally {
  return { matches: 0, wins0: 0, rounds: [], steps: 0, stepMs: 0, how: { counter: 0, windup: 0, guard: 0, open: 0, stagger: 0 }, strength: 0 };
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;

/** one line per pairing (see the header printed below for the columns) */
export function report(label: string, t: Tally) {
  const rs = t.rounds;
  const lens = rs
    .filter((r) => r.end !== 'draw')
    .map((r) => r.len)
    .sort((a, b) => a - b);
  const q = (p: number) => (lens[Math.min(lens.length - 1, Math.floor(p * lens.length))] ?? 0).toFixed(0).padStart(2);
  const avg = (f: (r: RoundStat) => number) => (rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length)).toFixed(1);
  const ends = (e: RoundStat['end']) => rs.filter((r) => r.end === e).length;
  const nh = HOW.reduce((a, h) => a + t.how[h], 0);
  console.log(
    [
      label.padEnd(15),
      pct(t.wins0, t.matches).padStart(4),
      (rs.length / t.matches).toFixed(2),
      `${q(0.1)} ${q(0.25)} ${q(0.5)} ${q(0.75)} ${q(0.9)}`,
      pct(lens.filter((l) => l >= 10 && l <= 30).length, lens.length).padStart(4),
      `${avg((r) => r.hits[0])}/${avg((r) => r.hits[1])}`.padEnd(8),
      `${avg((r) => r.blocks[0])}/${avg((r) => r.blocks[1])}`.padEnd(8),
      avg((r) => r.clashes),
      avg((r) => r.whiffs),
      `${avg((r) => r.attacks[0])}/${avg((r) => r.attacks[1])}`.padEnd(9),
      `${ends('fall')}/${ends('timeout')}/${ends('draw')}`.padEnd(11),
      (t.strength / Math.max(1, nh)).toFixed(2),
      HOW.map((h) => pct(t.how[h], nh).padStart(4)).join(''),
      ((1000 * t.stepMs) / t.steps).toFixed(2).padStart(5),
    ].join('  '),
  );
}

const LEVELS = [
  ['Rookie', 0.3],
  ['Pro', 0.65],
  ['Ace', 0.9],
] as const;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`${N} matches per pairing — best of 3, 45 s rounds, frame times 1/60 s ±30%.`);
  console.log(`"a/b" = fighter 0 (the person, or the first CPU) / fighter 1. Blocks are counted for the defender; each one stuns the attacker.`);
  console.log(`hits were on someone who was: counter = stunned, windup = winding up, guard = guarding at the wrong angle, open = not guarding, stagger = already reeling.`);
  console.log('');
  console.log('pairing          win0  rnds  round s p10 p25 p50 p75 p90  10–30  hits/rnd  blocks    clash whiff swings     fall/out/draw  str   counter windup guard open stagger   step µs');
  const all = tally();
  const add = (t: Tally) => ((all.steps += t.steps), (all.stepMs += t.stepMs));
  console.log('— CPU vs CPU');
  for (const [la, sa] of LEVELS) {
    for (const [lb, sb] of LEVELS) {
      if (sb < sa) continue;
      const t = tally();
      for (let n = 0; n < N; n++) playMatch(sa, sb, SEED * 100000 + n, t);
      report(`${la} v ${lb}`, t);
      add(t);
    }
  }
  console.log('— simulated person vs CPU');
  for (const p of [...PEOPLE, FLICKER]) {
    for (const [lb, sb] of LEVELS) {
      const t = tally();
      for (let n = 0; n < N; n++) playMatch(p, sb, SEED * 100000 + n, t);
      report(`${p.name} v ${lb}`, t);
      add(t);
    }
  }
  console.log(`\nstep(): ${((1000 * all.stepMs) / all.steps).toFixed(2)} µs a frame on average over ${(all.steps / 1e6).toFixed(1)}M frames (CPU brains included).`);
}
