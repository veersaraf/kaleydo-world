// CPU brains: how they aim, how hard they hit, how often they miss.

import { COURT } from './court';
import type { ShotSpec, Stroke } from './shot';
import { clamp, lerp, Rng, type V3 } from '../core/math';

export interface AIProfile {
  id: string;
  /** run speed, m/s */
  speed: number;
  /** delay before chasing, s */
  react: number;
  /** swing timing sigma, s */
  timing: number;
  /** typical pace 0..1 */
  power: number;
  /** 0 = safe middle, 1 = paints the lines */
  aggression: number;
  /** unforced error rate per shot (base) */
  errors: number;
  /** preferred spin -1..1 */
  spin: number;
  lob: number;
  drop: number;
  serve: number;
  /** likes to come to the net after a strong shot */
  netRush: number;
}

export const AI_LEVELS: Record<string, AIProfile> = {
  rookie: { id: 'rookie', speed: 3.7, react: 0.4, timing: 0.05, power: 0.35, aggression: 0.25, errors: 0.1, spin: 0.2, lob: 0.12, drop: 0.02, serve: 0.3, netRush: 0.05 },
  club: { id: 'club', speed: 4.3, react: 0.3, timing: 0.035, power: 0.5, aggression: 0.45, errors: 0.07, spin: 0.3, lob: 0.1, drop: 0.05, serve: 0.5, netRush: 0.12 },
  pro: { id: 'pro', speed: 4.9, react: 0.24, timing: 0.025, power: 0.66, aggression: 0.65, errors: 0.045, spin: 0.35, lob: 0.1, drop: 0.08, serve: 0.72, netRush: 0.2 },
  ace: { id: 'ace', speed: 5.4, react: 0.18, timing: 0.018, power: 0.8, aggression: 0.8, errors: 0.03, spin: 0.4, lob: 0.1, drop: 0.1, serve: 0.86, netRush: 0.25 },
  // Swing Lab ball machine: steady, friendly feeds that alternate sides
  feeder: { id: 'feeder', speed: 7, react: 0.1, timing: 0.01, power: 0.32, aggression: 0, errors: 0, spin: 0.2, lob: 0, drop: 0, serve: 0.3, netRush: 0 },
  // movement brain for human-controlled players (and attract-mode demos)
  auto: { id: 'auto', speed: 5.8, react: 0.05, timing: 0.02, power: 0.6, aggression: 0.6, errors: 0.04, spin: 0.3, lob: 0.1, drop: 0.06, serve: 0.6, netRush: 0.1 },
};

export interface AIContext {
  team: 0 | 1;
  contact: V3;
  stroke: Stroke;
  volley: boolean;
  /** how stretched the player was (0 comfy … 1 lunging) */
  stretch: number;
  incomingSpeed: number;
  oppX: number;
  oppZ: number;
  doubles: boolean;
  /** 0..1 pressure (e.g. big point) */
  pressure: number;
  /** shots so far in this rally */
  rally: number;
}

export interface AIShot {
  spec: ShotSpec;
  power: number;
  kind: 'drive' | 'lob' | 'drop' | 'smash' | 'volley' | 'error';
}

let feedSide = 1;

export function aiShot(p: AIProfile, c: AIContext, rng: Rng): AIShot {
  const fwd = c.team === 0 ? -1 : 1;
  if (p.id === 'feeder') {
    // ball machine: alternate forehand/backhand, comfortable depth and pace
    feedSide = -feedSide;
    const tx = clamp(c.oppX * 0.3 + feedSide * rng.range(1.2, 2.2), -3.3, 3.3);
    return { spec: { tx, tz: fwd * rng.range(7.5, 9.5), speed: rng.range(13, 17), spin: 0.2, clear: 0.5, maxApex: 5 }, power: 0.3, kind: 'drive' };
  }
  const hw = (c.doubles ? COURT.doublesHalfW : COURT.singlesHalfW) - 0.4;

  // aim away from the opponent; sometimes wrong-foot them
  let side = c.oppX > 0.6 ? -1 : c.oppX < -0.6 ? 1 : rng.chance(0.5) ? 1 : -1;
  if (rng.chance(0.18)) side = -side;
  const width = lerp(0.8, hw - 0.35, clamp(p.aggression * 0.7 + rng.next() * 0.45));
  let tx = side * width;
  let depth = lerp(7.2, 10.5, clamp(0.45 + p.aggression * 0.35 + rng.gauss() * 0.18));
  let power = clamp(p.power + rng.gauss() * 0.12 + (c.contact.y > 1.25 ? 0.12 : 0) - c.stretch * 0.25, 0.08, 1);
  let spin = clamp(p.spin + rng.gauss() * 0.25, -1, 1);
  let speed = lerp(16, 32, power) * (1 - 0.12 * Math.max(0, spin));
  let clear = 0.3 + (1 - power) * 0.45;
  let kind: AIShot['kind'] = 'drive';

  const oppAtNet = Math.abs(c.oppZ) < 6;
  const oppDeep = Math.abs(c.oppZ) > COURT.halfL + 1.2;
  const openCourt = Math.abs(c.oppX) > 1.3;
  // a sitter: slow, comfortable ball inside the court — go for the kill
  const sitter = c.stretch < 0.3 && (c.incomingSpeed < 15.5 || c.contact.y > 1.25) && Math.abs(c.contact.z) < COURT.halfL + 0.8;

  if (c.stroke === 'oh' && c.contact.y > 1.9) {
    kind = 'smash';
    power = clamp(0.75 + p.power * 0.25 + rng.gauss() * 0.08);
    speed = lerp(24, 35, power);
    depth = lerp(5, 9, rng.next());
    clear = 0.05;
    spin = 0.1;
  } else if (oppAtNet && rng.chance(p.lob * (c.doubles ? 0.8 : 2.8))) {
    kind = 'lob';
    speed = rng.range(8.5, 10.5);
    depth = rng.range(9.3, 10.8);
    clear = 3.2;
    spin = 0.5;
  } else if (oppDeep && !c.volley && rng.chance(p.drop)) {
    kind = 'drop';
    speed = rng.range(6.5, 8);
    depth = rng.range(1.6, 3);
    clear = 0.16;
    spin = -0.8;
  } else if (sitter && !c.volley && rng.chance(0.35 + p.aggression * 0.5)) {
    kind = 'drive';
    power = clamp(0.85 + p.power * 0.15 + rng.gauss() * 0.05);
    speed = lerp(24, 33, power);
    tx = (openCourt ? -Math.sign(c.oppX) : rng.chance(0.5) ? 1 : -1) * (hw - rng.range(0.1, 0.6));
    depth = rng.range(7.5, 10.4);
    clear = 0.22;
  } else if (!c.volley && openCourt && c.contact.y > 0.6 && rng.chance(p.aggression * 0.4)) {
    // sharp angle into the open court
    kind = 'drive';
    tx = -Math.sign(c.oppX) * (hw - rng.range(0, 0.35));
    depth = rng.range(4.8, 6.8);
    speed = lerp(15, 24, power);
    clear = 0.2;
  } else if (c.volley) {
    kind = 'volley';
    speed = lerp(13, 21, power);
    depth = lerp(6, 9.5, rng.next());
    clear = 0.12;
    spin = -0.3;
    tx = side * lerp(1.5, hw - 0.3, rng.next());
  }

  // errors: base rate, more when stretched or under pressure or facing pace
  const errP = clamp(
    p.errors *
      (1 + c.stretch * 2.5 + c.pressure * 0.5 + Math.max(0, c.incomingSpeed - 17) * 0.06) *
      (1 + c.rally * 0.08) *
      (kind === 'drive' && power > 0.84 ? 1.5 : 1),
    0,
    0.6,
  );
  let netted = false;
  if (rng.chance(errP)) {
    kind = 'error';
    const r = rng.next();
    if (r < 0.35) depth = COURT.halfL + rng.range(0.2, 2.2);
    else if (r < 0.65) tx = Math.sign(tx || 1) * (hw + 0.4 + rng.range(0.1, 1.6));
    else netted = true;
  }
  const scatter = 0.25 + (1 - p.aggression) * 0.1 + c.stretch * 0.4;
  tx += rng.gauss() * scatter;
  depth += rng.gauss() * scatter;
  if (kind !== 'error') {
    // stretched players can only float it back short
    depth -= c.stretch * 2.6;
    tx = clamp(tx, -hw - 0.1, hw + 0.1);
    depth = clamp(depth, 1.2, COURT.halfL - 0.25);
  }

  return {
    spec: { tx, tz: fwd * depth, speed, spin, clear, netted, maxApex: kind === 'lob' ? 9 : 6 },
    power,
    kind,
  };
}

/** Where a player drifts back to after hitting. */
export function recoveryPos(team: 0 | 1, lastTx: number, role: 'back' | 'net', doubles: boolean, partnerX = 0): { x: number; z: number } {
  const zSign = team === 0 ? 1 : -1;
  if (role === 'net') {
    const x = doubles ? clamp(lastTx * 0.35 + (partnerX > 0 ? -1.6 : 1.6), -3.5, 3.5) : lastTx * 0.3;
    return { x, z: zSign * 3.4 };
  }
  const x = clamp(lastTx * 0.22, -1.8, 1.8) + (doubles ? (partnerX > 0 ? -1.3 : 1.3) : 0);
  return { x, z: zSign * (COURT.halfL + 0.7) };
}
