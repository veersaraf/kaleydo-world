// CPU swordfighters. Every attack is telegraphed: a windup with the sword cocked
// where the cut will start (overhead for a chop, out to the left for a cut to the
// right…) — long for a weak CPU, short for a strong one — so a person can read it
// and guard across it. They read the opponent the same way, a reaction time late:
// they guard across the cut they expect from how the opponent holds their sword
// (and, when it gives nothing away, the lines they've been cutting along), cut
// along the line the opponent's guard leaves open, punish a stunned opponent, and
// mix in thrusts and feints. Skill 0..1 (the menu: Rookie 0.3, Pro 0.65, Ace 0.9)
// sets how quick, how accurate and how tricky.

import { ARENA } from './arena';
import { bladeAngle, type FighterPhase, type SlashInput, type SwordAim } from './types';
import { aimSpread, blendAim, cockAim, guardAimDir, guardDir, newAim, readyAim, reboundAim, setAim, swingAim } from './aim';
import type { DuelGame } from './game';
import { Rng, angleDiff, clamp, deg, lerp } from '../core/math';

export interface CpuProfile {
  /** the windup (the telegraph), s */
  windup: number;
  /** chance an attack comes quick: a windup QUICK times as long (hard to read in time) */
  quick: number;
  /** a feint's second windup, after re-cocking to another line, s */
  feintT: number;
  /** how late it sees the opponent's sword, s */
  react: number;
  /** its guard's angle error (σ, radians) */
  guardErr: number;
  /** how fast it turns its guard, rad/s */
  guardTurn: number;
  /** share of the time it keeps its guard up while waiting */
  guardUp: number;
  /** when the opponent's sword gives nothing away (held at it, not cocked): chance it guards
   *  the line they've been cutting along most, rather than just expecting a chop */
  adapt: number;
  /** chance an attack goes along the line the opponent's sword leaves open (else any cut) */
  read: number;
  /** how far off that line it aims (σ, radians) */
  aimErr: number;
  /** chance a cut is a feint (shown, then re-cocked to the line square to it) */
  feint: number;
  /** chance of a thrust */
  thrust: number;
  /** mean seconds between its own attacks */
  pace: number;
  /** swing power 0..1 */
  power: number;
  /** chance it punishes a stunned opponent */
  counter: number;
  /** waits for this much arm (energy) before attacking */
  patience: number;
}

/**
 * Each number at skill 0, then the menu's Rookie (0.3), Pro (0.65) and Ace (0.9),
 * then 1 — tuned with scripts/duel-sim.ts against a simulated person (an average
 * one should beat Rookie ~85% of matches, Pro ~50%, Ace ~20%).
 */
const SKILLS = [0, 0.3, 0.65, 0.9, 1];
export const CPU_TABLE: Record<Exclude<keyof CpuProfile, 'guardErr' | 'aimErr'> | 'guardErrDeg' | 'aimErrDeg', number[]> = {
  windup: [0.66, 0.56, 0.51, 0.49, 0.44],
  quick: [0, 0, 0.05, 0.08, 0.12],
  feintT: [0.3, 0.28, 0.22, 0.18, 0.16],
  react: [0.33, 0.27, 0.245, 0.23, 0.21],
  guardErrDeg: [26, 19, 18, 16, 13],
  guardTurn: [7.5, 8.8, 10, 11, 13],
  guardUp: [0.68, 0.8, 0.8, 0.82, 0.88],
  adapt: [0.2, 0.5, 0.9, 0.95, 0.97],
  read: [0.2, 0.4, 0.55, 0.68, 0.78],
  aimErrDeg: [28, 24, 16, 11, 9],
  feint: [0, 0, 0.2, 0.45, 0.5],
  thrust: [0.06, 0.08, 0.12, 0.15, 0.16],
  pace: [2.4, 2.2, 2, 1.85, 1.75],
  power: [0.52, 0.62, 0.66, 0.7, 0.74],
  counter: [0.45, 0.68, 0.68, 0.68, 0.76],
  patience: [0.25, 0.3, 0.45, 0.55, 0.6],
};
/** a quick attack's windup, as a share of the usual */
const QUICK = 0.65;

function at(v: number[], s: number) {
  let n = 0;
  while (n < SKILLS.length - 2 && SKILLS[n + 1] < s) n++;
  return lerp(v[n], v[n + 1], clamp((s - SKILLS[n]) / (SKILLS[n + 1] - SKILLS[n])));
}

export function cpuProfile(skill: number): CpuProfile {
  const s = clamp(skill);
  const T = CPU_TABLE;
  return {
    windup: at(T.windup, s),
    quick: at(T.quick, s),
    feintT: at(T.feintT, s),
    react: at(T.react, s),
    guardErr: deg(at(T.guardErrDeg, s)),
    guardTurn: at(T.guardTurn, s),
    guardUp: at(T.guardUp, s),
    adapt: at(T.adapt, s),
    read: at(T.read, s),
    aimErr: deg(at(T.aimErrDeg, s)),
    feint: at(T.feint, s),
    thrust: at(T.thrust, s),
    pace: at(T.pace, s),
    power: at(T.power, s),
    counter: at(T.counter, s),
    patience: at(T.patience, s),
  };
}

/** a sword reads as cocked once it has held within SETTLE_ANG for SETTLE s */
const SETTLE = 0.06;
const SETTLE_ANG = deg(20);

/** phases in which how the sword is held says where the next cut comes from */
const cocking = (p: FighterPhase) => p === 'ready' || p === 'windup' || p === 'slash' || p === 'recover';

/** phases as small numbers, for the ring of what the CPU has seen */
const PHASES: FighterPhase[] = ['idle', 'ready', 'guard', 'windup', 'slash', 'thrust', 'recover', 'stagger', 'stunned', 'clash', 'fall', 'win', 'lose'];
const RING = 256;

/** cuts it picks from when it isn't reading the opponent (mostly downward, like people) */
const CUTS = [-Math.PI / 2, -Math.PI / 4, (-3 * Math.PI) / 4, 0, Math.PI, Math.PI / 4, (3 * Math.PI) / 4, Math.PI / 2];
const CUT_W = [3, 2, 2, 1.5, 1.5, 0.7, 0.7, 0.4];
const CUT_SUM = CUT_W.reduce((a, b) => a + b, 0);

export class DuelCpu {
  readonly p: CpuProfile;
  private rng: Rng;
  /** what it has seen of the opponent, newest at `head`: time, phase, blade angle and spread across the view */
  private rt = new Float64Array(RING);
  private rph = new Uint8Array(RING);
  private rang = new Float64Array(RING);
  private rspr = new Float64Array(RING);
  private head = -1;
  private count = 0;
  /** the cut it expects next (the opponent's dir, in their view) */
  private expect = -Math.PI / 2;
  /** the opponent's cuts this match, fading: how often along each line across their view (0°, 45°, 90°, 135°) */
  private habit = new Float64Array(4);
  private oppStriking = false;
  /** going by that habit for now (re-decided every so often: a chance of `adapt`) */
  private trust = false;
  private err = 0;
  private errUntil = 0;
  /** the guard: which way the blade points now (a direction), and the line it's turning to */
  private gDir = Math.PI / 2;
  private gLine = 0;
  private lapse = false;
  private lapseUntil = 0;
  private nextAttack = -1;
  private feintAt = -1;
  private stunSeen = false;
  private stunGo = false;
  private plan: SlashInput = { kind: 'slash', dir: -Math.PI / 2, power: 0.5 };
  private tmp: SwordAim = newAim();

  constructor(
    readonly i: number,
    readonly skill: number,
    seed: number,
  ) {
    this.p = cpuProfile(skill);
    this.rng = new Rng(seed);
  }

  /** a new round */
  reset(g: DuelGame) {
    this.head = -1;
    this.count = 0;
    this.expect = -Math.PI / 2;
    this.lapse = false;
    this.lapseUntil = 0;
    this.nextAttack = -1;
    this.feintAt = -1;
    this.stunSeen = false;
    this.gDir = bladeAngle(g.fighters[this.i].aim);
  }

  /** remember how the opponent looks this frame (it acts on it a reaction time later) */
  observe(g: DuelGame) {
    const o = g.fighters[1 - this.i];
    const h = (this.head + 1) % RING;
    this.head = h;
    if (this.count < RING) this.count++;
    this.rt[h] = g.t;
    this.rph[h] = PHASES.indexOf(o.phase);
    this.rang[h] = bladeAngle(o.aim);
    this.rspr[h] = aimSpread(o.aim);
    // the line of each cut they make, seen as it lands
    const striking = o.phase === 'slash';
    if (striking && !this.oppStriking && o.attack) {
      const b = (((Math.round(o.attack.dir / (Math.PI / 4)) % 4) + 4) % 4) as number;
      for (let n = 0; n < 4; n++) this.habit[n] *= 0.75;
      this.habit[b] += 1;
    }
    this.oppStriking = striking;
  }

  /** the line they nearly always cut along lately (0..3, as `habit`), or −1 */
  private favourite() {
    const h = this.habit;
    let best = 0;
    let sum = 0;
    for (let n = 0; n < 4; n++) {
      sum += h[n];
      if (h[n] > h[best]) best = n;
    }
    return sum >= 2 && h[best] >= 0.7 * sum ? best : -1;
  }

  /** when their sword gives nothing away: a line they've been cutting along (the more often, the likelier), or a chop */
  private guess() {
    const h = this.habit;
    const sum = h[0] + h[1] + h[2] + h[3];
    if (sum < 0.5 || !this.trust) return -Math.PI / 2;
    let x = this.rng.next() * sum;
    for (let n = 0; n < 3; n++) {
      x -= h[n];
      if (x <= 0) return n * (Math.PI / 4);
    }
    return 3 * (Math.PI / 4);
  }

  /** the newest memory at or before tq */
  private seen(tq: number) {
    let k = this.head;
    for (let n = 1; n < this.count; n++) {
      if (this.rt[k] <= tq) return k;
      k = (k + RING - 1) % RING;
    }
    return k;
  }

  /** decide: attack, feint, counter, or guard across what's coming */
  think(g: DuelGame, _dt: number) {
    const p = this.p;
    const r = this.rng;
    const t = g.t;
    const i = this.i;
    const me = g.fighters[i];
    if (this.count === 0) return;
    const k = this.seen(t - p.react);
    const oph = PHASES[this.rph[k]];
    const oang = this.rang[k];

    // the cut it expects: from where the opponent's blade is cocked (it'll come
    // through the middle from there) — a cocked sword, held a moment, not one on its
    // way somewhere, nor a guard just let go (that says nothing about the next cut).
    // Nor does a sword held up at it (the ready stance): then it goes by the lines
    // they've been cutting along.
    const k2 = this.seen(t - p.react - SETTLE);
    const telling =
      this.rspr[k] > 0.7 &&
      this.rspr[k2] > 0.7 &&
      Math.abs(angleDiff(this.rang[k2], oang)) < SETTLE_ANG &&
      cocking(oph) &&
      cocking(PHASES[this.rph[k2]]);
    const resample = t >= this.errUntil;
    if (resample) {
      this.err = r.gauss() * p.guardErr;
      this.errUntil = t + r.range(0.4, 0.9);
      this.trust = r.chance(p.adapt);
    }
    // a one-trick opponent: it stops believing their sword and guards their favourite line
    const fav = this.favourite();
    if (fav >= 0 && this.trust) this.expect = fav * (Math.PI / 4);
    else if (telling) this.expect = oang + Math.PI;
    else if (resample) this.expect = this.guess();
    // guard square to that cut, mirrored into its own view
    this.gLine = Math.PI - this.expect + Math.PI / 2 + this.err;

    if (g.state !== 'fight') {
      // squared up with the guard high for "Ready…"
      g.cpuGuard(i, g.state === 'ready');
      return;
    }
    if (this.nextAttack < 0) this.nextAttack = t + p.pace * r.range(0.3, 1);

    if (me.phase === 'windup') return this.feint(g, k);
    if (me.phase !== 'ready' && me.phase !== 'guard') return;

    const reach = g.gap() <= ARENA.reach - 0.05;
    const e = g.energy[i];

    // a stunned opponent is wide open: punish it (if it notices, and wants to)
    if (oph === 'stunned') {
      if (!this.stunSeen) {
        this.stunSeen = true;
        this.stunGo = r.chance(p.counter);
      }
      if (this.stunGo && reach && e >= 0.2) {
        this.stunGo = false;
        return this.attack(g, k, true);
      }
    } else this.stunSeen = false;

    // its own attacks, paced, when it has the arm for them and the opponent isn't mid-attack
    if (t >= this.nextAttack && reach && e >= p.patience * (1 - 0.5 * this.urgency(g)) && (oph === 'ready' || oph === 'guard' || oph === 'recover')) {
      return this.attack(g, k, false);
    }

    // otherwise guard — though now and then (the weaker, the more) it lets it drop
    if (t >= this.lapseUntil) {
      this.lapse = !r.chance(p.guardUp);
      this.lapseUntil = t + r.range(0.5, 1.2);
    }
    g.cpuGuard(i, !this.lapse);
  }

  private attack(g: DuelGame, k: number, counter: boolean) {
    const p = this.p;
    const r = this.rng;
    const a = this.plan;
    a.power = clamp(p.power + r.gauss() * 0.1, 0.2, 1);
    // near their end a thrust finishes it: even blocked, it shoves them back
    let thrust = p.thrust + (g.edgeDist(1 - this.i) < 0.45 ? 0.3 : 0);
    if (counter) thrust = 0.5 * this.skill;
    if (r.chance(thrust)) {
      a.kind = 'thrust';
      a.dir = 0;
    } else {
      a.kind = 'slash';
      // along the line their sword leaves open (parallel to it — if it's held across
      // the view at all, not pointed at us), or just a cut
      const read = !counter && this.rspr[k] > 0.4 && r.chance(p.read);
      a.dir = read ? this.openCut(this.rang[k]) + r.gauss() * p.aimErr : this.anyCut();
    }
    let dur = p.windup * r.range(0.9, 1.12);
    if (counter) dur *= 0.6;
    else if (r.chance(p.quick)) dur *= QUICK;
    // a feint shows this cut long enough to draw a guard across it, then re-cocks
    this.feintAt = !counter && a.kind === 'slash' && r.chance(p.feint) ? g.t + dur * r.range(0.6, 0.8) : -1;
    if (g.cpuWindup(this.i, a, dur)) this.nextAttack = g.t + dur + p.pace * (1 - 0.55 * this.urgency(g)) * r.range(0.5, 1.5);
  }

  /** 0 = calm … 1 = the round's last seconds and it isn't ahead: it presses (a draw on time helps nobody) */
  private urgency(g: DuelGame) {
    const late = clamp(((g.roundTime - g.timeLeft) / g.roundTime - 0.45) / 0.55);
    return g.edgeDist(this.i) - g.edgeDist(1 - this.i) > 0.5 ? 0 : late;
  }

  /**
   * The feint's switch: the cut square to the one it showed — which a guard put
   * across the first lies along. It can't wait to see whether they bit (it would
   * only see that a reaction time later, after the strike), so it's a gamble: a
   * guard that didn't move still stops it.
   */
  private feint(g: DuelGame, _k: number) {
    if (this.feintAt < 0 || g.t < this.feintAt) return;
    this.feintAt = -1;
    const a = this.plan;
    let d = a.dir + (this.rng.chance(0.5) ? 1 : -1) * (Math.PI / 2);
    if (Math.sin(d) > 0.2) d += Math.PI; // cut downwards along that line
    a.dir = Math.atan2(Math.sin(d), Math.cos(d)) + this.rng.gauss() * this.p.aimErr * 0.5;
    g.cpuRetarget(this.i, a, this.p.feintT);
  }

  /** a cut along the opponent's blade (angle in their view), which their guard can't stop — downwards if it can */
  private openCut(ang: number) {
    // their view is mirrored: a cut along their blade line has dir −ang or π − ang in ours
    let d = -ang;
    const s = Math.sin(d);
    if (s > 0.2 || (s > -0.2 && this.rng.chance(0.5))) d += Math.PI;
    return Math.atan2(Math.sin(d), Math.cos(d));
  }

  private anyCut() {
    let x = this.rng.next() * CUT_SUM;
    for (let n = 0; n < CUTS.length; n++) {
      x -= CUT_W[n];
      if (x <= 0) return CUTS[n];
    }
    return CUTS[0];
  }

  /** the CPU's hands: where its sword is this frame */
  pose(g: DuelGame, dt: number) {
    const me = g.fighters[this.i];
    const tmp = this.tmp;
    let lam = 12;
    switch (me.phase) {
      case 'guard': {
        // the guard turns to its line at the CPU's speed (whichever way round is shorter)
        const want = guardDir(this.gLine, me.handed, this.gDir);
        const d = angleDiff(this.gDir, want);
        const step = this.p.guardTurn * dt;
        this.gDir += Math.abs(d) <= step ? d : Math.sign(d) * step;
        guardAimDir(tmp, this.gDir);
        lam = 30;
        break;
      }
      case 'windup':
        cockAim(tmp, me.attack!);
        lam = 16;
        break;
      case 'slash':
      case 'thrust':
        swingAim(me.aim, me.attack!, g.strikeU(this.i), g.contactU);
        this.gDir = bladeAngle(me.aim);
        return;
      case 'stunned':
        // bounced off their guard, back the way it came
        reboundAim(tmp, this.plan);
        lam = 20;
        break;
      case 'stagger':
        // knocked aside, drooping
        setAim(tmp, 0.3, -0.3, 0.9, 0, 1, 0.3);
        lam = 10;
        break;
      case 'clash':
        setAim(tmp, 0, 0.9, 0.44, 0, -0.44, 0.9);
        lam = 18;
        break;
      case 'win':
        setAim(tmp, 0, 1, 0.12, 0, 0, 1);
        lam = 6;
        break;
      case 'lose':
      case 'fall':
        setAim(tmp, 0, -0.8, 0.6, 0, 0.6, 0.8);
        lam = 4;
        break;
      default:
        readyAim(tmp);
    }
    blendAim(me.aim, tmp, 1 - Math.exp(-lam * dt));
    // raising the guard turns it from wherever the blade is
    if (me.phase !== 'guard') this.gDir = bladeAngle(me.aim);
  }
}
