// Turning intent (where, how hard, what spin) into a ball trajectory.

import { COURT, netHeightAt, fwdOf, serviceBox } from './court';
import { type Seg, solveLaunch, flightTimeFor, segTimeAtZ, segPos, segApexY } from './ball';
import { clamp, lerp, type V3, Rng } from '../core/math';

export type Stroke = 'fh' | 'bh' | 'oh' | 'serve';

export interface ShotSpec {
  tx: number;
  tz: number;
  /** desired initial horizontal speed, m/s */
  speed: number;
  spin: number;
  /** required clearance above the net tape, m */
  clear: number;
  /** a netted error: the ball is aimed into the net at this height instead */
  netted?: boolean;
  maxApex?: number;
  /** Rush: this flight's gravity is heavier by this factor (a faster ball still clears the net and drops in) */
  gMul?: number;
}

export function gravityFor(spin: number) {
  return COURT.gravity * clamp(1 + 0.42 * spin, 0.62, 1.45);
}

/** Solve a spec into a ball segment starting at `from` at time t0. */
export function buildShot(from: V3, spec: ShotSpec, t0: number): Seg {
  const g = gravityFor(spec.spin) * (spec.gMul ?? 1);
  const k = COURT.drag;
  if (spec.netted) {
    // Aim at a point on the net plane below the tape.
    const f = from.z / (from.z - spec.tz || 1);
    const nx = from.x + (spec.tx - from.x) * Math.min(1, Math.abs(f));
    const nd = Math.hypot(nx - from.x, from.z);
    const T = flightTimeFor(nd, Math.max(8, spec.speed), k);
    const v = solveLaunch(from, nx, 0, T, g, k, 0.25 + Math.random() * 0.45);
    return { t0, px: from.x, py: from.y, pz: from.z, vx: v.x, vy: v.y, vz: v.z, g, k, spin: spec.spin, g0: COURT.gravity };
  }
  const d = Math.hypot(spec.tx - from.x, spec.tz - from.z);
  let T = flightTimeFor(d, Math.max(4, spec.speed), k);
  let seg: Seg = mk(from, spec, T, g, k, t0);
  for (let i = 0; i < 40; i++) {
    seg = mk(from, spec, T, g, k, t0);
    const tn = segTimeAtZ(seg, 0);
    if (tn === null) break;
    const p = segPos(seg, tn, { x: 0, y: 0, z: 0 });
    const clearance = p.y - COURT.ballR - netHeightAt(p.x);
    if (clearance >= spec.clear) break;
    T *= 1.06;
  }
  if (spec.maxApex) {
    // Flatten absurd moonballs by trimming flight time.
    for (let i = 0; i < 10 && segApexY(seg) > spec.maxApex; i++) {
      T *= 0.94;
      seg = mk(from, spec, T, g, k, t0);
    }
  }
  return seg;
}

function mk(from: V3, spec: ShotSpec, T: number, g: number, k: number, t0: number): Seg {
  const v = solveLaunch(from, spec.tx, spec.tz, T, g, k);
  return { t0, px: from.x, py: from.y, pz: from.z, vx: v.x, vy: v.y, vz: v.z, g, k, spin: spec.spin, g0: COURT.gravity };
}

// ------------------------------------------------------------------ intent

export interface SwingInput {
  power: number; // 0..1
  spin: number; // -1..1
  /** timing: -1 very early … 0 perfect … +1 very late */
  tau: number;
  /** aim from the racket path, −1 (player's left) … +1 (right), when measured */
  aim?: number;
  /** hit with the stroke the player chose rather than the natural one */
  crossed?: boolean;
  /** ms early (−) or late (+) versus the ideal moment (human swings) */
  dtMs?: number;
  /** 0..1: hit at full stretch (a lunge ~0.5, a dive 1) — weaker, loftier, less accurate */
  stretch?: number;
  /** a smash chance: any decent swing puts it away (timing sets how well) */
  smash?: boolean;
  /** the opponents' mean x (a perfect smash finds the open court) */
  oppX?: number;
}

/** how fast a swing must be to smash a smash chance (slower: a push back) */
export const SMASH_MIN_POWER = 0.3;
/** |tau| under this, a smash is perfect (a rocket) */
export const SMASH_PERFECT = 0.18;

export interface ShotResult {
  spec: ShotSpec;
  perfect: boolean;
  kind: 'drive' | 'lob' | 'drop' | 'smash' | 'volley' | 'soft' | 'shank' | 'wobbly';
}

/**
 * Human shot: timing chooses direction (Wii-style), swing speed chooses pace
 * and depth, swing path chooses spin.
 */
export function humanShot(
  team: number,
  fhSignWorld: number,
  stroke: Stroke,
  contact: V3,
  volley: boolean,
  sw: SwingInput,
  rng: Rng,
  doubles: boolean,
): ShotResult {
  const fwd = fwdOf(team);
  const hw = (doubles ? COURT.doublesHalfW : COURT.singlesHalfW) - 0.45;
  const tau = clamp(sw.tau, -1.2, 1.2);
  const smashing = sw.smash ? sw.power >= SMASH_MIN_POWER : stroke === 'oh' && contact.y > 1.9;
  const perfect = Math.abs(tau) < (smashing ? SMASH_PERFECT : 0.16);
  let power = clamp(sw.power) * (sw.crossed ? 0.85 : 1);
  const spin = clamp(sw.spin, -1, 1);

  // Lateral: late forehand pushes to the racket side, early pulls across…
  const dirSign = stroke === 'bh' ? -1 : 1;
  const timingAim = dirSign * Math.sign(tau) * Math.pow(Math.min(1, Math.abs(tau)), 0.75) * fhSignWorld;
  // …and where the racket was travelling at contact steers it too.
  const right = team === 0 ? 1 : -1;
  const lateral = sw.aim === undefined ? timingAim : 0.6 * sw.aim * right + 0.4 * timingAim;
  let tx = clamp(lateral * (hw - 0.3), -hw, hw);
  // Contact far out wide naturally opens the angle a bit.
  tx += contact.x * 0.12;

  let kind: ShotResult['kind'] = 'drive';
  let depth: number; // distance from the net on the far side
  let speed: number;
  let clear = 0.3 + (1 - power) * 0.5;
  let s = spin;

  if (smashing) {
    // perfect: a rocket, steep, into the open court. Late: it sits up and slows;
    // early: it's pulled wide and a bit softer. Pace always comes from the swing.
    kind = 'smash';
    const late = Math.max(0, tau - SMASH_PERFECT);
    const early = Math.max(0, -tau - SMASH_PERFECT);
    power = Math.max(power, 0.35);
    speed = lerp(25, 40, power) * (perfect ? 1.2 : 1 - 0.28 * Math.min(1, late) - 0.2 * Math.min(1, early));
    // (met lower, a late one has to be hit flatter and longer to clear the net)
    depth = perfect ? lerp(6.2, 8.8, rng.next()) : lerp(5.5, 9.5, rng.next()) + 1.2 * Math.min(1, late);
    clear = perfect ? 0.04 : 0.06 + 0.15 * late;
    s = 0.15;
    if (perfect && sw.aim === undefined && sw.oppX !== undefined) tx = (Math.abs(sw.oppX) > 0.4 ? -Math.sign(sw.oppX) : Math.sign(tx) || 1) * (hw - 0.55);
  } else if (power < 0.28 && spin > 0.35) {
    kind = 'lob';
    speed = lerp(8.5, 11, power / 0.28);
    depth = lerp(9.4, 10.8, rng.next());
    clear = 3.2;
    s = 0.5;
  } else if (power < 0.3 && spin < -0.35) {
    kind = 'drop';
    speed = lerp(6.5, 8.5, power / 0.3);
    depth = lerp(1.6, 3.2, rng.next());
    clear = 0.16;
    s = -0.8;
  } else if (volley) {
    kind = 'volley';
    speed = lerp(12, 22, power) * (perfect ? 1.1 : 1);
    depth = lerp(5.5, 9.6, power);
    clear = 0.12;
    s = spin * 0.4 - 0.2;
  } else {
    if (power < 0.12) kind = 'soft';
    speed = lerp(15, 31, power) * (perfect ? 1.12 : 1);
    speed *= 1 - 0.14 * Math.max(0, spin) - 0.12 * Math.max(0, -spin);
    depth = lerp(6.6, 10.5, Math.pow(power, 0.85)) + 0.6 * Math.max(0, spin);
  }

  // At full stretch (a lunge, a dive) you can only get it back: slower, loftier,
  // less precise — a pop-up the other side can attack.
  const st = clamp(sw.stretch ?? 0);
  if (st > 0 && kind !== 'smash') {
    speed *= 1 - 0.32 * st;
    clear += 1.1 * st;
    depth = lerp(depth, 6.5, 0.35 * st);
    if (st > 0.55 && (kind === 'drive' || kind === 'volley' || kind === 'soft')) kind = 'wobbly';
  }

  // Timing errors scatter the ball; big mistimed swings can fly out.
  const err = Math.abs(tau);
  let sx = 0.18 + 1.1 * err * err;
  let sz = 0.3 + 1.0 * err * err + (power > 0.9 ? 0.5 * (power - 0.9) * 10 * err : 0);
  if (perfect) {
    sx = 0.05;
    sz = 0.1;
  }
  sx *= 1 + 1.2 * st;
  sz *= 1 + 0.6 * st;
  if (kind === 'smash') {
    sx *= perfect ? 1 : 0.8;
    sz *= perfect ? 1 : 0.7;
  } else if (err > 0.95 && rng.chance(0.35)) {
    kind = 'shank';
    power *= 0.4;
    speed = lerp(8, 14, rng.next());
    tx = rng.range(-hw - 2, hw + 2);
    depth = rng.range(2, 12.5);
    clear = rng.chance(0.5) ? 0.2 : -0.2;
  }
  tx += rng.gauss() * sx;
  depth = clamp(depth + rng.gauss() * sz, 0.8, 14);

  return {
    spec: { tx, tz: fwd * depth, speed, spin: s, clear, netted: clear < 0, maxApex: kind === 'lob' ? 9 : 6 },
    perfect,
    kind,
  };
}

/** Serve: timing sets quality (and aims wide vs T), swing speed sets pace. */
export function serveShot(
  team: number,
  deuce: boolean,
  sw: SwingInput,
  rng: Rng,
  faultBias = 0,
): { spec: ShotSpec; perfect: boolean; fault: boolean; rocket: boolean } {
  const box = serviceBox(team, deuce);
  const tau = clamp(sw.tau, -1.3, 1.3);
  const q = clamp(1 - Math.pow(Math.abs(tau), 1.4));
  // the top of the toss: ±50 ms or so (a phone's swing arrives with a little jitter)
  const perfect = Math.abs(tau) < 0.2;
  const power = clamp(sw.power);
  // struck right at the top of the toss with a real swing: a rocket serve
  const rocket = perfect && power > 0.55;
  const speed = (15 + 21 * (0.4 * q + 0.6 * power * (0.55 + 0.45 * q))) * (rocket ? 1.16 : perfect ? 1.06 : 1);

  const centreX = box.x0 === 0 ? 1 : -1; // sign of x inside the box
  // aim with the racket's path when measured (towards the sideline = wide);
  // otherwise early → wide, late → T, perfect → a mix
  const sideSign = centreX * (team === 0 ? 1 : -1); // + if the wide side is the server's right
  const wide =
    sw.aim !== undefined ? clamp(0.5 + sw.aim * sideSign * 0.8, 0, 1) : tau < -0.2 ? 1 : tau > 0.2 ? 0 : rng.next();
  const along = lerp(0.35, 3.6, wide);
  let tx = centreX * along;
  const zSign = team === 0 ? -1 : 1;
  let depth = COURT.service - lerp(0.35, 1.6, rng.next() * (0.4 + 0.6 * (1 - power)));
  let clear = 0.06;

  const faultP = rocket ? 0.04 : clamp(Math.max(0, (0.62 - q) * 1.15) + faultBias + (power > 0.92 ? 0.1 : 0), 0, 0.75);
  let fault = false;
  if (rng.chance(faultP)) {
    fault = true;
    const r = rng.next();
    if (r < 0.4) depth = COURT.service + rng.range(0.25, 1.4); // long
    else if (r < 0.7) tx = centreX * rng.range(4.25, 5.2); // wide
    else {
      clear = -0.25; // into the net
      depth = rng.range(0.8, 2.5);
    }
  }
  tx += rng.gauss() * (perfect ? 0.08 : 0.25);
  return {
    spec: { tx, tz: zSign * depth, speed, spin: 0.35, clear, netted: clear < 0, maxApex: 4.2 },
    perfect,
    fault,
    rocket,
  };
}
