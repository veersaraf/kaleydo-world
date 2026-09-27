// The CPUs: the pitcher (batting-practice strikes, tougher as `pitching` rises) and
// the CPU hitters.
//
// The pitcher always throws strikes. An easy one throws fastballs down the middle
// at a friendly pace; a hard one mixes in sliders, curves and changeups, throws
// them harder, and paints the edges of the zone — where a pitch is harder to
// barrel, and a high or low one gets lifted or beaten into the ground.
//
// A CPU hitter decides its swing when the pitch leaves the hand, like a batter
// reading it out of the hand: its timing (the error spread by its skill, and
// fooled a little by an off-speed pitch when it's sitting fastball), how hard it
// swings and its swing plane. The game starts its swing so the bat gets to the
// ball exactly then — early and late swings look early and late. Skill 0..1 (the
// menu: Rookie 0.3, Pro 0.6, Ace 0.9) is tuned with scripts/baseball-sim.ts to hit
// about 2, 4 and 6.5 home runs in 10 pitches against the middling pitcher.

import { FIELD } from './field';
import { PITCH_KINDS, PITCH_RUN } from './physics';
import type { PitchKind } from './types';
import { Rng, clamp, lerp } from '../core/math';

// ------------------------------------------------------------------ the pitcher

export interface PitchPlan {
  kind: PitchKind;
  /** world m/s */
  speed: number;
  /** where it's to cross the contact plane */
  px: number;
  py: number;
}

/** The pitcher's repertoire and aim by `pitching` (0 easy … 1 hard). */
export const PITCHER = {
  /** the share of fastballs: 1 − fastballDrop·pitching */
  fastballDrop: 0.65,
  /** the off-speed mix */
  mix: { slider: 0.4, curve: 0.3, changeup: 0.3 } as Record<Exclude<PitchKind, 'fastball'>, number>,
  /** where in each kind's speed range: from `pace[0]` (easy) to `pace[1]` (hard), ± paceSd */
  pace: [0.2, 0.85] as const,
  paceSd: 0.1,
  /** the zone's middle, and how far into it a pitch's centre may go (a strike, with a little room for the break past the contact plane) */
  middleY: 0.84,
  maxX: FIELD.zoneHalfW - 0.04,
  minY: FIELD.zoneBottom + 0.07,
  maxY: FIELD.zoneTop - 0.06,
  /** the edge it aims for: this far out, and the scatter (m) — easy … hard */
  edgeX: 0.19,
  edgeLo: 0.6,
  edgeHi: 1.06,
  scatter: [0.035, 0.05] as const,
};

/** The pitcher's next pitch: kind, speed and where it's aimed (always a strike). */
export function choosePitch(pitching: number, rng: Rng): PitchPlan {
  const P = PITCHER;
  const p = clamp(pitching);
  // (a fixed number of draws per pitch: the same seed, the same pitches, whoever's batting)
  const rKind = rng.next();
  const rMix = rng.next();
  const rPace = rng.gauss();
  const rEdge = rng.next();
  const rAlong = rng.next();
  const rSide = rng.next();
  const sx = rng.gauss();
  const sy = rng.gauss();
  let kind: PitchKind = 'fastball';
  if (rKind >= 1 - P.fastballDrop * p) {
    let acc = 0;
    const tot = P.mix.slider + P.mix.curve + P.mix.changeup;
    kind = 'changeup';
    for (const k of ['slider', 'curve', 'changeup'] as const) {
      acc += P.mix[k] / tot;
      if (rMix < acc) {
        kind = k;
        break;
      }
    }
  }
  const [lo, hi] = PITCH_KINDS[kind].speed;
  const speed = lerp(lo, hi, clamp(lerp(P.pace[0], P.pace[1], p) + P.paceSd * rPace));
  // an edge of the zone: a side, the top or the knees (a corner now and then)
  let ex: number;
  let ey: number;
  const side = rSide < 0.5 ? -1 : 1;
  if (rEdge < 0.45) {
    ex = side * P.edgeX;
    ey = lerp(P.edgeLo, P.edgeHi, rAlong);
  } else if (rEdge < 0.9) {
    ex = lerp(-P.edgeX, P.edgeX, rAlong);
    ey = rEdge < 0.62 ? P.edgeHi : P.edgeLo;
  } else {
    ex = side * P.edgeX;
    ey = rAlong < 0.5 ? P.edgeLo : P.edgeHi;
  }
  // an easy pitcher grooves it; a hard one paints
  const b = Math.pow(p, 0.8);
  const sc = lerp(P.scatter[0], P.scatter[1], p);
  const px = clamp(lerp(0, ex, b) + sc * sx, -P.maxX, P.maxX);
  const py = clamp(lerp(P.middleY, ey, b) + sc * sy, P.minY, P.maxY);
  return { kind, speed, px, py };
}

/** How long a pitch of this plan takes to reach the contact plane, s. */
export const flightTime = (speed: number) => PITCH_RUN / speed;

/** The pitcher's average flight time at this `pitching` (what a hitter sitting on the usual pitch times). */
export function usualFlight(pitching: number) {
  const P = PITCHER;
  const p = clamp(pitching);
  const fb = 1 - P.fastballDrop * p;
  const pace = lerp(P.pace[0], P.pace[1], p);
  const at = (k: PitchKind) => flightTime(lerp(PITCH_KINDS[k].speed[0], PITCH_KINDS[k].speed[1], pace));
  const tot = P.mix.slider + P.mix.curve + P.mix.changeup;
  const off = (P.mix.slider * at('slider') + P.mix.curve * at('curve') + P.mix.changeup * at('changeup')) / tot;
  return fb * at('fastball') + (1 - fb) * off;
}

// ------------------------------------------------------------------ CPU hitters

export interface HitterProfile {
  /** timing error: σ and a bias (s; + late) */
  timingSd: number;
  timingBias: number;
  /** sitting on the usual pitch: this share of a pitch's surprise (its flight time against the usual) turns into timing error */
  fooled: number;
  /** swing power: mean, σ (0..1) */
  power: number;
  powerSd: number;
  /** swing plane: mean, σ (−1..1; + uppercut) */
  lift: number;
  liftSd: number;
}

/**
 * Each number at skill 0, then the menu's Rookie (0.3), Pro (0.6) and Ace (0.9),
 * then 1 — tuned with scripts/baseball-sim.ts: about 2, 4 and 6.5 home runs in 10
 * pitches against pitching 0.5.
 */
const SKILLS = [0, 0.3, 0.6, 0.9, 1];
export const HITTER_TABLE: Record<keyof HitterProfile, number[]> = {
  timingSd: [0.08, 0.062, 0.053, 0.043, 0.032],
  timingBias: [0.02, 0.013, 0.008, 0.004, 0.002],
  fooled: [0.3, 0.24, 0.18, 0.11, 0.07],
  power: [0.48, 0.6, 0.71, 0.79, 0.86],
  powerSd: [0.16, 0.14, 0.12, 0.09, 0.07],
  lift: [0.0, 0.12, 0.23, 0.32, 0.38],
  liftSd: [0.45, 0.38, 0.32, 0.26, 0.2],
};

function at(v: number[], s: number) {
  let n = 0;
  while (n < SKILLS.length - 2 && SKILLS[n + 1] < s) n++;
  return lerp(v[n], v[n + 1], clamp((s - SKILLS[n]) / (SKILLS[n + 1] - SKILLS[n])));
}

export function hitterProfile(skill: number): HitterProfile {
  const s = clamp(skill);
  const T = HITTER_TABLE;
  return {
    timingSd: at(T.timingSd, s),
    timingBias: at(T.timingBias, s),
    fooled: at(T.fooled, s),
    power: at(T.power, s),
    powerSd: at(T.powerSd, s),
    lift: at(T.lift, s),
    liftSd: at(T.liftSd, s),
  };
}

/** A CPU's swing at one pitch: its timing error (s), power and plane. */
export interface CpuSwing {
  e: number;
  power: number;
  lift: number;
}

export class CpuHitter {
  readonly p: HitterProfile;
  private rng: Rng;

  constructor(
    readonly skill: number,
    seed: number,
  ) {
    this.p = hitterProfile(skill);
    this.rng = new Rng(seed);
  }

  /** The pitch is out of the hand: `flight` s to the plate against the `usual` it's sitting on. */
  plan(flight: number, usual: number): CpuSwing {
    const p = this.p;
    const r = this.rng;
    // a slower pitch than it's sitting on gets it out in front (early); a quicker one, late
    const e = p.timingBias + p.timingSd * r.gauss() - p.fooled * (flight - usual);
    return {
      e,
      power: clamp(p.power + p.powerSd * r.gauss(), 0.05, 1),
      lift: clamp(p.lift + p.liftSd * r.gauss(), -1, 1),
    };
  }
}
