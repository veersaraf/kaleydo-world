// Sword duel: rounds, the clock, attacks and guards, knockback, the edge and the
// fall. The rules are Chambara's: a guard stops a cut when its blade lies across
// the cut's path (types.ts blocks()) and leaves the attacker stunned, open to a
// counter; a clean hit knocks the target back and the attacker steps after them,
// so the fight drifts towards the loser's end until they go off it. Rendering and
// animation live in their own modules; this is the referee and the stage manager.

import { ARENA, FALL_T, startZ } from './arena';
import { blocks, type DuelEvent, type DuelFx, type DuelView, type Duelist, type FighterPhase, type FighterState, type SlashInput, type SwordAim } from './types';
import { aimSpread, copyAim, newAim } from './aim';
import { DuelCpu } from './ai';
import { Rng, clamp, lerp, smooth } from '../core/math';

export type DuelState = 'intro' | 'ready' | 'fight' | 'fall' | 'round-end' | 'over';

export interface DuelOptions {
  /** rounds needed to win the match (default 2: best of 3) */
  rounds?: number;
  /** seconds per round (default 45) */
  roundTime?: number;
  /** seeds the CPUs' decisions (and the coin for a dead-even timeout) */
  seed?: number;
}

// ---- timing, s
const INTRO_T = 2.5;
const READY_T = 1.2;
const ROUND_END_T = 1.8;
/** a strike lands this long after it starts (a person's real swing has already happened by then) */
const CONTACT_T = 0.1;
/** the strike, follow-through included */
const STRIKE_T = 0.2;
/** after the strike: the guard can't come up yet */
const RECOVER_T = 0.25;
/** had an attack blocked: dazed, can't guard or attack */
const STUN_T = 0.8;
const STUN_THRUST_T = 0.6;
/** took a clean hit */
const STAGGER_T = 0.35;
/** blades met */
const CLASH_T = 0.35;
/** two strikes landing this close together meet blade to blade */
const CLASH_WINDOW = 0.12;

// ---- distances, m
/** a clean cut knocks the target back KNOCK + KNOCK_K · strength; a thrust more */
const KNOCK = 0.4;
const KNOCK_K = 0.8;
const THRUST_KNOCK = 0.6;
const THRUST_KNOCK_K = 1.0;
/** a counter (a hit on a stunned fighter) knocks back this much further: blocking pays */
const COUNTER_BONUS = 1.1;
/** from this share of the round's time on, hits push harder — up to 1 + LATE_BOOST at the
 *  buzzer — so an even fight still usually ends in the water rather than on points */
const LATE_FROM = 0.55;
const LATE_BOOST = 0.5;
/** a blocked cut shoves the guard back a little, a blocked thrust more */
const BLOCK_SLIDE = 0.1;
const THRUST_SLIDE = 0.3;
const BLOCK_SLIDE_T = 0.18;
const CLASH_PUSH = 0.25;
/** a fighter goes over this far in from the platform's end (their weight is past it) */
const FALL_MARGIN = 0.1;
/** carried over the edge at this speed: at least enough that a slide that barely makes it still
 *  topples off, at most a stumble (not a flight) — the splash lands 0.9–1.5 m out */
const FALL_SPEED_MIN = 1.2;
const FALL_SPEED_MAX = 2.0;
/** how fast the fighter who won the ground steps after the other, m/s */
const WALK = 2.2;
/** 'edge' when this close to the fall line (about one hit); again only after getting this far away */
const EDGE_WARN = 1.0;
const EDGE_REARM = 1.8;
/** where fighters walk on from (the intro) */
const WALK_ON = ARENA.gap / 2 + 1.8;
/** a timeout this close is a draw (replayed)… */
const DRAW_MARGIN = 0.25;
/** …but only this many times a match, so it can't go on forever */
const MAX_DRAWS = 2;

// ---- the arm (anti-spam, as in Chambara): strength = power × (0.35 + 0.65 · energy)
const ENERGY_COST = 0.3;
const ENERGY_REGEN = 0.5;
/** it only comes back once you stop swinging for a moment: flailing drains it */
const REGEN_DELAY = 0.35;

/** How long the timed phases and states last, s (for the animator, HUD and camera). */
export const DUEL_TIMING = {
  intro: INTRO_T,
  ready: READY_T,
  roundEnd: ROUND_END_T,
  /** 'slash' / 'thrust' last `strike`; the blow lands `contact` in */
  strike: STRIKE_T,
  contact: CONTACT_T,
  recover: RECOVER_T,
  stun: STUN_T,
  stunThrust: STUN_THRUST_T,
  stagger: STAGGER_T,
  clash: CLASH_T,
  /** 'fall' → the splash */
  fall: FALL_T,
} as const;

/** a guard whose blade hardly crosses the view (held pointing at the opponent: |blade x,y|
 *  under this) has no line to speak of — its bladeAngle is noise */
const POINTED = 0.35;
/** A person's guard is judged kindly: a phone held roughly across a cut stops it (the CPU's own
 *  guard, which it angles exactly, needs the full 55°). */
const PERSON_BLOCK_DEG = 35;

/**
 * Does this guard stop this attack? The block rule (types.ts blocks()). A CPU's guard pointed at
 * the opponent has no line, and stops thrusts only; a person's — a phone held like a remote,
 * pointed at the TV — guards with its broad side: the line across the phone's face (flat when the
 * screen faces up, so it stops chops).
 */
export function guardStops(guard: SwordAim, a: SlashInput, person = false) {
  if (a.kind === 'thrust') return true;
  const minDeg = person ? PERSON_BLOCK_DEG : 55;
  if (aimSpread(guard) >= POINTED) return blocks(guard, a, minDeg);
  if (!person) return false;
  // the phone's width: blade × edge (the screen's normal), as a guard's line
  const b = guard.blade,
    e = guard.edge;
  const w = { blade: [b[1] * e[2] - b[2] * e[1], b[2] * e[0] - b[0] * e[2], b[0] * e[1] - b[1] * e[0]] as [number, number, number], edge: e };
  return aimSpread(w) >= POINTED && blocks(w, a, minDeg);
}

/** Per fighter bookkeeping the animator doesn't need. */
interface Side {
  /** the guard button (a CPU's hands press it too) */
  guardHeld: boolean;
  /** the attack being made; FighterState.attack points here during windup / slash / thrust */
  attack: SlashInput;
  /** windup: when the strike starts */
  strikeAt: number;
  /** a strike on its way: when it lands (NaN = none) */
  contactAt: number;
  strength: number;
  /** a person's swing that came in during 'recover' goes as soon as that ends */
  queued: SlashInput;
  hasQueued: boolean;
  phaseEnd: number;
  /** knockback: sliding dist m straight back over dur s from z0 (decelerating) */
  sliding: boolean;
  slideT0: number;
  slideZ0: number;
  slideDist: number;
  slideDur: number;
  /** can this slide put them in the water (a clash can't) */
  slideFall: boolean;
  /** won the last exchange's ground: steps after the other to keep the gap */
  press: boolean;
  lastAttackT: number;
  edgeArmed: boolean;
  fallZ0: number;
  fallSpeed: number;
  /** clean hits landed this round (a dead-even timeout's tie-break) */
  hits: number;
  /** the last few phases and when each began (a strike judged `age` late asks what this fighter was doing then) */
  hist: { t: number; phase: FighterPhase }[];
}

/** How far back a person's message can reach: the phone's age is clamped to this, s. */
const MAX_AGE = 0.3;
/** the phase log keeps this long, s */
const HIST_KEEP = 0.6;

/** Everything a clean hit changes, kept for the defender's guard to undo if it turns out to have been up in time. */
interface HitUndo {
  /** the attacker, and when the blow landed */
  by: number;
  at: number;
  side: [Side, Side];
  f: { z: number; phase: FighterPhase; t: number; push: number }[];
}

const newSide = (): Side => ({
  guardHeld: false,
  attack: { kind: 'slash', dir: 0, power: 0 },
  strikeAt: 0,
  contactAt: NaN,
  strength: 0,
  queued: { kind: 'slash', dir: 0, power: 0 },
  hasQueued: false,
  phaseEnd: 0,
  sliding: false,
  slideT0: 0,
  slideZ0: 0,
  slideDist: 0,
  slideDur: 1,
  slideFall: true,
  press: false,
  lastAttackT: -9,
  edgeArmed: true,
  fallZ0: 0,
  fallSpeed: 0,
  hits: 0,
  hist: [],
});

/** copy b's fields into a (the nested attacks and the log copied by value, so a snapshot stays put) */
function copySide(a: Side, b: Side) {
  const { attack, queued, hist } = a;
  Object.assign(a, b);
  a.attack = Object.assign(attack, b.attack);
  a.queued = Object.assign(queued, b.queued);
  a.hist = hist;
  a.hist.length = 0;
  for (const h of b.hist) a.hist.push({ t: h.t, phase: h.phase });
  return a;
}

/** copy an attack in, tidied: power 0..1, dir in (−π, π] */
function setAttack(out: SlashInput, a: SlashInput) {
  out.kind = a.kind === 'thrust' ? 'thrust' : 'slash';
  const d = Number.isFinite(a.dir) ? a.dir : -Math.PI / 2;
  out.dir = Math.atan2(Math.sin(d), Math.cos(d));
  out.power = clamp(Number.isFinite(a.power) ? a.power : 0.5);
  return out;
}

export class DuelGame {
  state: DuelState = 'intro';
  stateT0 = 0;
  t = 0;
  /** rounds started so far (a replayed draw counts): 1 during the first */
  round = 0;
  score: [number, number] = [0, 0];
  timeLeft: number;
  /** the platform's half-length this round (the final round's is shorter) */
  halfLength = ARENA.length / 2;
  /** each fighter's arm, 0..1 (the anti-spam meter): an attack costs 0.3, it comes back resting */
  energy: [number, number] = [1, 1];
  /** rounds needed to win */
  readonly toWin: number;
  readonly roundTime: number;
  fighters: [FighterState, FighterState];
  /** who took the round that just ended (null = a draw, or still going) */
  winner: number | null = null;
  onEvent: (e: DuelEvent) => void = () => {};
  /** the strike's contact as a fraction of it (for drawing the swing) */
  readonly contactU = CONTACT_T / STRIKE_T;
  private sides: [Side, Side] = [newSide(), newSide()];
  /** per fighter: the world before the last clean hit they took (a guard that turns out to have been up in time undoes it) */
  private undo: [HitUndo | null, HitUndo | null] = [null, null];
  private cpus: [DuelCpu | null, DuelCpu | null];
  private drawsLeft = MAX_DRAWS;
  /** who went over the edge this round (−1 = nobody) */
  private fallen = -1;
  private rng: Rng;
  /** effects since the last view(), and the array handed out last time (double-buffered: no garbage) */
  private fxA: DuelFx[] = [];
  private fxB: DuelFx[] = [];
  private out: DuelView = { halfLength: ARENA.length / 2, fx: this.fxB };

  constructor(
    readonly duelists: [Duelist, Duelist],
    opts: DuelOptions = {},
  ) {
    this.toWin = Math.max(1, Math.round(opts.rounds ?? 2));
    this.roundTime = opts.roundTime ?? 45;
    this.timeLeft = this.roundTime;
    const seed = opts.seed ?? (Math.random() * 2 ** 31) | 0;
    this.rng = new Rng(seed);
    const mk = (i: number): FighterState => ({
      x: 0,
      z: (i === 0 ? 1 : -1) * WALK_ON,
      facing: i === 0 ? 1 : -1,
      handed: duelists[i].handed,
      phase: 'idle',
      t: 0,
      aim: newAim(),
      attack: null,
      push: 0,
    });
    this.fighters = [mk(0), mk(1)];
    const cpu = (i: number) => (duelists[i].cpu !== null ? new DuelCpu(i, duelists[i].cpu!, seed + 7919 * (i + 1)) : null);
    this.cpus = [cpu(0), cpu(1)];
  }

  /** skip the walk-on */
  skip() {
    if (this.state === 'intro') this.startRound();
  }

  // ------------------------------------------------------------ input (people, by input seat)

  /**
   * The guard button went down / up. While it's down the sword guards at whatever angle it's held.
   * It happened `age` s ago (the phone's detector, the network): the guard counts from then, so
   * a blow that landed in that window — while the phone was already up — is turned into a block.
   */
  guard(slot: number, down: boolean, age = 0) {
    const i = this.seat(slot);
    if (i >= 0) this.setGuard(i, down, this.ageOf(age));
  }

  /**
   * A swing measured by the phone (or a key). It has already happened — `age` s ago — so
   * there's no windup: the strike started `age` ago (no earlier than the fighter was ready) and
   * lands CONTACT_T after that, which may be now: it's judged against what the other fighter was
   * doing then. Only counts during the fight, from the ready stance (not while guarding, dazed,
   * or reeling from a hit — the phone hears why); one that comes while recovering from the last,
   * or bouncing off a clash, goes as soon as that's over.
   */
  slash(slot: number, input: SlashInput, age = 0) {
    const i = this.seat(slot);
    if (i < 0 || this.state !== 'fight') return;
    const f = this.fighters[i];
    const s = this.sides[i];
    if (f.phase === 'ready') {
      setAttack(s.attack, input);
      this.strike(i, this.t - Math.min(this.ageOf(age), f.t));
      // (a blow that's already due lands now, not a frame from now)
      this.contacts();
    } else if (f.phase === 'recover' || f.phase === 'clash') {
      setAttack(s.queued, input);
      s.hasQueued = true;
    }
  }

  private ageOf(age: number) {
    return Number.isFinite(age) ? clamp(age, 0, MAX_AGE) : 0;
  }

  /** the sword's pose, live from the phone (~20–50 Hz); until one comes it's held in the ready stance */
  aim(slot: number, aim: SwordAim) {
    const i = this.seat(slot);
    if (i >= 0) copyAim(this.fighters[i].aim, aim);
  }

  // ------------------------------------------------------------ the CPU's hands (see ai.ts)

  /** start cocking the sword for an attack; the strike goes `dur` s from now */
  cpuWindup(i: number, attack: SlashInput, dur: number) {
    const f = this.fighters[i];
    if (this.state !== 'fight' || (f.phase !== 'ready' && f.phase !== 'guard')) return false;
    const s = this.sides[i];
    setAttack(s.attack, attack);
    s.strikeAt = this.t + dur;
    this.setPhase(i, 'windup');
    return true;
  }

  /** mid-windup, switch to another attack (a feint): the sword re-cocks and strikes `dur` s from now */
  cpuRetarget(i: number, attack: SlashInput, dur: number) {
    const f = this.fighters[i];
    if (f.phase !== 'windup') return false;
    const s = this.sides[i];
    setAttack(s.attack, attack);
    s.strikeAt = this.t + dur;
    f.t = 0;
    return true;
  }

  cpuGuard(i: number, on: boolean) {
    this.setGuard(i, on);
  }

  // ------------------------------------------------------------ read-outs

  /** chest-to-chest distance between the fighters */
  gap() {
    return this.fighters[0].z - this.fighters[1].z;
  }

  /** how far fighter i is from going over their own end, m */
  edgeDist(i: number) {
    const f = this.fighters[i];
    return this.halfLength - FALL_MARGIN - f.facing * f.z;
  }

  /** how much harder hits push now (1 for most of a round, rising to 1.5 at the buzzer) */
  lateBoost() {
    const u = (this.roundTime - this.timeLeft) / this.roundTime;
    return 1 + LATE_BOOST * smooth(clamp((u - LATE_FROM) / (1 - LATE_FROM)));
  }

  /** how far through the strike (0..1) fighter i is */
  strikeU(i: number) {
    return clamp(this.fighters[i].t / STRIKE_T);
  }

  /** What the arena draws this frame. Effects are handed out once: the array is reused after the next call. */
  view(): DuelView {
    const v = this.out;
    v.halfLength = this.halfLength;
    v.fx = this.fxA;
    this.fxA = this.fxB;
    this.fxB = v.fx;
    this.fxA.length = 0;
    return v;
  }

  // ------------------------------------------------------------ simulation

  step(dt: number) {
    this.t += dt;
    const t = this.t;
    this.fighters[0].t += dt;
    this.fighters[1].t += dt;
    for (let i = 0; i < 2; i++) this.cpus[i]?.observe(this);

    switch (this.state) {
      case 'intro': {
        // walk on to the marks, then a moment squared up
        const u = smooth(clamp((t - this.stateT0) / (INTRO_T - 0.6)));
        for (let i = 0; i < 2; i++) this.fighters[i].z = lerp((i === 0 ? 1 : -1) * WALK_ON, startZ(i), u);
        if (t - this.stateT0 >= INTRO_T) this.startRound();
        break;
      }
      case 'ready':
        // "Ready…": guards can go up, attacks don't count
        this.phases();
        for (let i = 0; i < 2; i++) this.cpus[i]?.think(this, dt);
        if (t - this.stateT0 >= READY_T) {
          this.setState('fight');
          this.onEvent({ type: 'fight' });
        }
        break;
      case 'fight':
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        this.phases();
        for (let i = 0; i < 2; i++) this.cpus[i]?.think(this, dt);
        this.contacts();
        this.move(dt);
        for (let i = 0; i < 2; i++) {
          if (t - this.sides[i].lastAttackT >= REGEN_DELAY) this.energy[i] = Math.min(1, this.energy[i] + ENERGY_REGEN * dt);
        }
        if (this.state === 'fight') this.edges();
        if (this.state === 'fight' && this.timeLeft <= 0) this.timeout();
        break;
      case 'fall': {
        // the other fighter finishes what they were doing; the faller goes over
        this.phases();
        this.move(dt);
        const i = this.fallen;
        const f = this.fighters[i];
        if (f.t >= FALL_T) {
          const s = this.sides[i];
          f.z = s.fallZ0 + f.facing * s.fallSpeed * FALL_T;
          f.push = 0;
          this.fx({ type: 'splash', x: f.x, z: f.z });
          this.onEvent({ type: 'splash', who: i, x: f.x, z: f.z });
          this.roundEnd(1 - i, false);
        }
        break;
      }
      case 'round-end':
        if (t - this.stateT0 >= ROUND_END_T) {
          const w = this.score[0] >= this.toWin ? 0 : this.score[1] >= this.toWin ? 1 : -1;
          if (w < 0) this.startRound();
          else {
            this.setState('over');
            this.onEvent({ type: 'over', winner: w, score: [this.score[0], this.score[1]] });
          }
        }
        break;
      case 'over':
        break;
    }
    for (let i = 0; i < 2; i++) this.cpus[i]?.pose(this, dt);
  }

  /** the timed phases run out (each next one starts when the last was due to end, not
   *  at this frame: the timing doesn't stretch with the frame rate); guards follow the button */
  private phases() {
    const t = this.t;
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const s = this.sides[i];
      switch (f.phase) {
        case 'windup':
          if (t >= s.strikeAt) this.strike(i, s.strikeAt);
          break;
        case 'slash':
        case 'thrust':
          if (t >= s.phaseEnd) this.setPhase(i, 'recover', RECOVER_T, s.phaseEnd);
          break;
        case 'recover':
          if (t < s.phaseEnd) break;
          if (s.hasQueued && this.state === 'fight') {
            s.hasQueued = false;
            setAttack(s.attack, s.queued);
            this.strike(i, s.phaseEnd);
          } else this.free(i, s.phaseEnd);
          break;
        case 'clash':
          if (t < s.phaseEnd) break;
          if (s.hasQueued && this.state === 'fight') {
            s.hasQueued = false;
            setAttack(s.attack, s.queued);
            this.strike(i, s.phaseEnd);
          } else this.free(i, s.phaseEnd);
          break;
        case 'stagger':
        case 'stunned':
          if (t >= s.phaseEnd) this.free(i, s.phaseEnd);
          break;
        case 'ready':
          if (s.guardHeld) this.setPhase(i, 'guard');
          break;
        case 'guard':
          if (!s.guardHeld) this.setPhase(i, 'ready');
          break;
      }
    }
  }

  /** the strike starts (at time `at`, which may be a moment ago): the arm pays for it now */
  private strike(i: number, at: number) {
    const s = this.sides[i];
    const e = this.energy[i];
    s.strength = s.attack.power * (0.35 + 0.65 * e);
    this.energy[i] = Math.max(0, e - ENERGY_COST);
    s.lastAttackT = at;
    this.setPhase(i, s.attack.kind === 'thrust' ? 'thrust' : 'slash', STRIKE_T, at);
    s.contactAt = at + CONTACT_T;
    const a = s.attack;
    this.onEvent({ type: 'attack', who: i, attack: { kind: a.kind, dir: a.dir, power: a.power } });
  }

  /** strikes land, earliest first */
  private contacts() {
    for (;;) {
      const a = this.sides[0].contactAt;
      const b = this.sides[1].contactAt;
      // (NaN = none: every comparison with it is false)
      if (a <= this.t && !(b < a)) this.contact(0);
      else if (b <= this.t) this.contact(1);
      else break;
    }
  }

  private contact(i: number) {
    const j = 1 - i;
    const sa = this.sides[i];
    const sd = this.sides[j];
    const def = this.fighters[j];
    const at = sa.contactAt;
    sa.contactAt = NaN;
    // out of reach: a whiff
    if (this.gap() > ARENA.reach) return;
    // the other blade landing at the same moment: they meet
    const other = def.phase === 'windup' ? sd.strikeAt + CONTACT_T : sd.contactAt;
    if (Math.abs(other - at) <= CLASH_WINDOW) return this.clash(at);
    // (what the defender was doing when it landed, which may be a moment ago)
    const p = this.phaseAt(j, at);
    if (p === 'fall' || p === 'win' || p === 'lose' || p === 'idle') return;
    if (p === 'guard' && guardStops(def.aim, sa.attack, this.duelists[j].cpu === null)) this.block(i, at);
    else this.hit(i, at);
  }

  /** i's strike lands clean, at time `at` */
  private hit(i: number, at: number) {
    const j = 1 - i;
    const sa = this.sides[i];
    const sd = this.sides[j];
    const def = this.fighters[j];
    const a = sa.attack;
    if (this.duelists[j].cpu === null) this.keepUndo(i, at);
    let dist = a.kind === 'thrust' ? THRUST_KNOCK + THRUST_KNOCK_K * sa.strength : KNOCK + KNOCK_K * sa.strength;
    if (def.phase === 'stunned') dist *= COUNTER_BONUS;
    dist *= this.lateBoost();
    // whatever they were doing is cut short (a windup, a queued swing)
    sd.contactAt = NaN;
    sd.hasQueued = false;
    this.setPhase(j, 'stagger', STAGGER_T, at);
    this.slide(j, dist, STAGGER_T, true, at);
    sa.press = true;
    sd.press = false;
    sa.hits++;
    // a chop lands high (head, shoulder), a rising cut low, a thrust mid-chest
    const y = ARENA.top + (a.kind === 'thrust' ? 1.0 : 1.05 - 0.25 * Math.sin(a.dir));
    const z = def.z - def.facing * 0.2;
    this.fx({ type: 'hit', x: def.x, y, z, strength: sa.strength });
    this.onEvent({ type: 'hit', who: j, by: i, strength: sa.strength, x: def.x, y, z });
  }

  /** j's guard stops i's strike, at time `at` */
  private block(i: number, at: number) {
    const j = 1 - i;
    const sa = this.sides[i];
    const sd = this.sides[j];
    const def = this.fighters[j];
    const thrust = sa.attack.kind === 'thrust';
    sa.hasQueued = false;
    this.setPhase(i, 'stunned', thrust ? STUN_THRUST_T : STUN_T, at);
    // the guard gives a little ground (a thrust shoves it back more — at the edge, that's enough)
    this.slide(j, thrust ? THRUST_SLIDE : BLOCK_SLIDE, BLOCK_SLIDE_T, true, at);
    sa.press = true;
    sd.press = false;
    // where the blades meet: out in front of the defender
    const y = ARENA.top + 1.15;
    const z = def.z - def.facing * 0.55;
    this.fx({ type: 'block', x: def.x, y, z, strength: sa.strength });
    this.onEvent({ type: 'block', who: j, by: i, x: def.x, y, z });
  }

  /** both blades land together, at time `at` */
  private clash(at: number) {
    for (let k = 0; k < 2; k++) {
      const s = this.sides[k];
      s.contactAt = NaN;
      s.hasQueued = false;
      s.press = true;
      this.setPhase(k, 'clash', CLASH_T, at);
      this.slide(k, CLASH_PUSH, CLASH_T, false, at);
    }
    const y = ARENA.top + 1.2;
    const z = (this.fighters[0].z + this.fighters[1].z) / 2;
    this.fx({ type: 'clash', x: 0, y, z });
    this.onEvent({ type: 'clash', x: 0, y, z });
  }

  /** knock fighter j straight back `dist` m over `dur` s from time `at`, decelerating (what's left of a slide adds on) */
  private slide(j: number, dist: number, dur: number, canFall: boolean, at: number) {
    const s = this.sides[j];
    let rest = 0;
    if (s.sliding) {
      const u = clamp((this.t - s.slideT0) / s.slideDur);
      rest = s.slideDist * (1 - u) * (1 - u);
    }
    s.sliding = true;
    s.slideT0 = at;
    s.slideZ0 = this.fighters[j].z;
    s.slideDist = dist + rest;
    s.slideDur = dur;
    s.slideFall = canFall;
  }

  /** slides, the fall, and the winner of the ground stepping after the other */
  private move(dt: number) {
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const s = this.sides[i];
      if (f.phase === 'fall') {
        if (this.state === 'fall') f.z += f.facing * s.fallSpeed * dt;
        continue;
      }
      if (!s.sliding) continue;
      const u = clamp((this.t - s.slideT0) / s.slideDur);
      f.z = s.slideZ0 + f.facing * s.slideDist * (1 - (1 - u) * (1 - u));
      f.push = ((2 * s.slideDist) / s.slideDur) * (1 - u);
      if (u >= 1) {
        s.sliding = false;
        f.push = 0;
      }
      const over = f.facing * f.z - (this.halfLength - FALL_MARGIN);
      if (over > 0) {
        if (s.slideFall && this.state === 'fight') this.startFall(i);
        else f.z -= f.facing * over; // a clash never puts anyone in the water
      }
    }
    if (this.state !== 'fight') return;
    // keep the gap: whoever won the ground steps after the other (so the fight drifts
    // towards the loser's end; ground lost is only won back by pushing)
    const f0 = this.fighters[0];
    const f1 = this.fighters[1];
    const excess = f0.z - f1.z - ARENA.gap;
    if (excess <= 1e-4) return;
    const w0 = this.sides[0].press && this.canWalk(0);
    const w1 = this.sides[1].press && this.canWalk(1);
    if (!w0 && !w1) return;
    const d = Math.min(excess, WALK * dt);
    if (w0 && w1) {
      f0.z -= d / 2;
      f1.z += d / 2;
    } else if (w0) f0.z -= d;
    else f1.z += d;
  }

  private canWalk(i: number) {
    const p = this.fighters[i].phase;
    return !this.sides[i].sliding && (p === 'ready' || p === 'guard' || p === 'windup' || p === 'slash' || p === 'thrust' || p === 'recover');
  }

  private startFall(i: number) {
    const f = this.fighters[i];
    const s = this.sides[i];
    s.sliding = false;
    s.contactAt = NaN;
    s.hasQueued = false;
    s.fallSpeed = clamp(f.push, FALL_SPEED_MIN, FALL_SPEED_MAX);
    s.fallZ0 = f.z;
    this.setPhase(i, 'fall');
    f.push = s.fallSpeed;
    this.fallen = i;
    // the round's decided: nothing else lands
    const o = 1 - i;
    const so = this.sides[o];
    so.contactAt = NaN;
    so.hasQueued = false;
    if (this.fighters[o].phase === 'windup') this.free(o);
    this.setState('fall');
    this.onEvent({ type: 'fall', who: i });
  }

  /** a fighter within about one hit of their end: 'edge' (once, until they get well clear) */
  private edges() {
    for (let i = 0; i < 2; i++) {
      const s = this.sides[i];
      const d = this.edgeDist(i);
      if (s.edgeArmed && d < EDGE_WARN) {
        s.edgeArmed = false;
        this.onEvent({ type: 'edge', who: i });
      } else if (!s.edgeArmed && d > EDGE_REARM) s.edgeArmed = true;
    }
  }

  /** time's up: whoever is further from their own end takes it; too close to call is a draw (replayed) */
  private timeout() {
    const d0 = this.edgeDist(0);
    const d1 = this.edgeDist(1);
    if (Math.abs(d0 - d1) < DRAW_MARGIN && this.drawsLeft > 0) {
      this.drawsLeft--;
      this.roundEnd(null, true);
      return;
    }
    let w = d0 > d1 ? 0 : d1 > d0 ? 1 : -1;
    if (w < 0) {
      const h0 = this.sides[0].hits;
      const h1 = this.sides[1].hits;
      w = h0 > h1 ? 0 : h1 > h0 ? 1 : this.rng.chance(0.5) ? 0 : 1;
    }
    this.roundEnd(w, true);
  }

  private roundEnd(w: number | null, timeout: boolean) {
    if (w !== null) this.score[w]++;
    this.winner = w;
    for (let i = 0; i < 2; i++) {
      const s = this.sides[i];
      s.contactAt = NaN;
      s.hasQueued = false;
      s.sliding = false;
      s.press = false;
      const f = this.fighters[i];
      // a fighter in the water stays in 'fall' (fallY keeps them going under)
      if (f.phase === 'fall') continue;
      this.setPhase(i, w === null ? 'idle' : i === w ? 'win' : 'lose');
      f.push = 0;
    }
    this.setState('round-end');
    this.onEvent({ type: 'round-end', winner: w, score: [this.score[0], this.score[1]], timeout });
  }

  private startRound() {
    this.round++;
    // the decider (1–1 in a best of 3) is fought on the short platform
    const n = this.toWin - 1;
    const final = n > 0 && this.score[0] === n && this.score[1] === n;
    this.halfLength = (final ? ARENA.finalLength : ARENA.length) / 2;
    this.timeLeft = this.roundTime;
    this.winner = null;
    this.fallen = -1;
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const s = this.sides[i];
      f.x = 0;
      f.z = startZ(i);
      f.push = 0;
      s.contactAt = NaN;
      s.hasQueued = false;
      s.sliding = false;
      s.press = false;
      s.lastAttackT = -9;
      s.edgeArmed = true;
      s.hits = 0;
      this.energy[i] = 1;
      this.setPhase(i, s.guardHeld ? 'guard' : 'ready');
    }
    for (const c of this.cpus) c?.reset(this);
    this.setState('ready');
    this.onEvent({ type: 'round', round: this.round, final });
  }

  private seat(slot: number) {
    for (let i = 0; i < 2; i++) {
      const d = this.duelists[i];
      if (d.cpu === null && d.slot === slot) return i;
    }
    return -1;
  }

  private setGuard(i: number, down: boolean, age = 0) {
    const s = this.sides[i];
    const f = this.fighters[i];
    s.guardHeld = down;
    if (down && f.phase === 'ready') {
      // (no earlier than the fighter was on their feet: a guard held through a recovery starts when it ends)
      this.setPhase(i, 'guard', 0, this.t - Math.min(age, f.t));
    } else if (down && f.phase === 'stagger' && age > 0) this.rescue(i, this.t - age);
    else if (!down && f.phase === 'guard') this.setPhase(i, 'ready', 0, this.t - Math.min(age, f.t));
  }

  /** fighter j's guard went up at `at`, a moment ago: if a blow landed on them since — while it was
   *  already up on the phone — and the guard stops it, it was a block */
  private rescue(j: number, at: number) {
    const u = this.undo[j];
    this.undo[j] = null;
    // (only if the blow found them on their feet, with the guard free to go up)
    if (!u || this.state !== 'fight' || u.at < at - 1e-9 || u.f[j].phase !== 'ready') return;
    at = Math.max(at, u.at - u.f[j].t);
    const i = u.by;
    const sa = this.sides[i];
    const sd = this.sides[j];
    const def = this.fighters[j];
    if (!guardStops(def.aim, sa.attack, this.duelists[j].cpu === null)) return;
    // the world as it was just before the blow (both fighters' bookkeeping), then the block instead
    copySide(sa, u.side[0]);
    copySide(sd, u.side[1]);
    for (let k = 0; k < 2; k++) {
      const f = this.fighters[k];
      const v = u.f[k];
      f.z = v.z;
      f.phase = v.phase;
      f.t = v.t + (this.t - u.at);
      f.push = v.push;
      f.attack = v.phase === 'windup' || v.phase === 'slash' || v.phase === 'thrust' ? this.sides[k].attack : null;
    }
    sd.guardHeld = true;
    this.setPhase(j, 'guard', 0, at);
    this.block(i, u.at);
  }

  /** the phase fighter i was in at time `at` (now, or a moment ago) */
  private phaseAt(i: number, at: number): FighterPhase {
    const f = this.fighters[i];
    if (at >= this.t - 1e-9) return f.phase;
    const h = this.sides[i].hist;
    for (let k = h.length - 1; k >= 0; k--) if (h[k].t <= at + 1e-9) return h[k].phase;
    return h.length ? h[0].phase : f.phase;
  }

  /** remember the world before i's blow lands on the other fighter (a guard that was up in time will undo it) */
  private keepUndo(i: number, at: number) {
    const j = 1 - i;
    let u = this.undo[j];
    if (!u) {
      u = this.undo[j] = { by: i, at, side: [newSide(), newSide()], f: [{ z: 0, phase: 'idle', t: 0, push: 0 }, { z: 0, phase: 'idle', t: 0, push: 0 }] };
    }
    u.by = i;
    u.at = at;
    copySide(u.side[0], this.sides[i]);
    copySide(u.side[1], this.sides[j]);
    for (let k = 0; k < 2; k++) {
      const f = this.fighters[k];
      const v = u.f[k];
      v.z = f.z;
      v.phase = f.phase;
      // (f.t is as of now; rescue() adds on the time since the blow, so back it up to `at`)
      v.t = f.t - (this.t - at);
      v.push = f.push;
    }
  }

  /** back on their feet (as of `at`): guarding if the button's down */
  private free(i: number, at = this.t) {
    this.setPhase(i, this.sides[i].guardHeld ? 'guard' : 'ready', 0, at);
  }

  /** phase p from time `at` (now, or a moment ago when it was due then), lasting dur s if it's timed */
  private setPhase(i: number, p: FighterPhase, dur = 0, at = this.t) {
    const f = this.fighters[i];
    const s = this.sides[i];
    f.phase = p;
    f.t = this.t - at;
    s.phaseEnd = at + dur;
    const h = s.hist;
    h.push({ t: at, phase: p });
    while (h.length > 1 && h[1].t < this.t - HIST_KEEP) h.shift();
    f.attack = p === 'windup' || p === 'slash' || p === 'thrust' ? s.attack : null;
    if (!s.sliding && p !== 'fall') f.push = 0;
  }

  private setState(s: DuelState) {
    this.state = s;
    this.stateT0 = this.t;
  }

  private fx(e: DuelFx) {
    // (nobody reading them — a headless sim — mustn't grow this forever)
    if (this.fxA.length < 32) this.fxA.push(e);
  }
}
