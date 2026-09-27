// Baseball physics: the pitches, the swing's timing and what the bat does to the
// ball, the batted ball's real flight, and its flight through the diorama.
//
// Pitches fly under gravity plus a 'break' per kind — a constant acceleration (a
// fastball's backspin holds it up, a curve drops and moves to the glove side),
// and for the late movers a part that builds up on the way (a changeup comes out
// looking like a fastball, then fades and drops; a slider bites late) — solved
// so they cross the contact plane where the pitcher aimed at the moment the game
// says. Closed form, the same at any frame rate.
//
// A swing is judged on its timing alone: how early or late its fastest moment
// was against the ball reaching the contact plane (the phone's latency and the
// display's allowed for — see game.ts). Timing gives the contact's quality and
// where it goes (early pulls, late goes the other way, very early or late is
// foul, very late is fouled back); the swing's power and plane and the pitch's
// speed and height give the exit speed and launch angle.
//
// The batted ball is then flown for real — real metres, drag, backspin lift —
// which says how far it goes, and whether it's a home run: fair, and over the
// fence at the painted distance with height to spare (see field.ts). And then
// it's flown again through the diorama so it looks like that: it leaves the bat
// fast, rises, hangs and drops more steeply than it rose; one that doesn't make
// it comes down in front of the fence (or hits it) at the distance scaled down
// by the fence's own scale, and a home run clears the fence by metres and comes
// down in the stands behind — or, a monster, right out of the stadium. That
// flight is closed form too (quadratic drag on each axis separately), solved
// for the apex, where it lands and how fast it leaves the bat.

import { FIELD, fenceAt, realFenceAt, realScale } from './field';
import type { BattedBall, Pitch, PitchKind } from './types';
import { Rng, clamp, lerp, smooth } from '../core/math';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

// ------------------------------------------------------------------ timing

/** The TV shows a frame about this long after the game computes it (the render
 *  pipeline and the display): the ball a player times is that old. */
export const DISPLAY_LAG = 0.04;

/** Timing windows, seconds either side of perfect (|e|). */
export const WINDOW = {
  /** the bat meets the ball at all */
  contact: 0.13,
  /** fair: the spray runs from the pull line at −fair to the opposite-field line at +fair */
  fair: 0.075,
  /** the sweet spot: the perfect crack */
  sweet: 0.025,
  /** later than this, it's fouled straight back */
  foulBack: 0.105,
};

/** The oldest a swing message can be when it gets here (the input clamps its estimate to 0.16 s; a little slack). */
export const AGE_MAX = 0.2;

/** A swing can still meet the ball if it gets here up to this long after the pitch crosses the
 *  contact plane (its fastest moment as late as the window allows, shown DISPLAY_LAG late, and
 *  the message as old as it gets): until then a pitch in the mitt isn't a strike yet. */
export const SWING_OPEN = WINDOW.contact + DISPLAY_LAG + AGE_MAX;

/** Game time freezes for this long when the bat meets the ball (the hitstop). */
export const HITSTOP = { hit: 0.07, sweet: 0.11 };

// ------------------------------------------------------------------ pitches

/** Release → contact plane, world metres (14.45), and a real pitch's (the HUD's km/h is a real pitch's). */
export const PITCH_RUN = FIELD.contactZ - FIELD.releaseZ;
export const REAL_PITCH_RUN = 16.8;

/**
 * Each kind's speed range (world m/s, the average over its flight) and break, an
 * acceleration on top of gravity, m/s²: `side` towards the pitcher's glove side
 * (+) or throwing-arm side (−), `up` against gravity — constant, plus a late part
 * (`lateSide`, `lateUp`) that grows from nothing at the release to that at the plate.
 */
export const PITCH_KINDS: Record<PitchKind, { speed: [number, number]; side: number; up: number; lateSide: number; lateUp: number }> = {
  fastball: { speed: [22, 27], side: -1.2, up: 3.2, lateSide: 0, lateUp: 0 },
  slider: { speed: [20, 23], side: 2.4, up: -1.2, lateSide: 5, lateUp: -1 },
  curve: { speed: [17, 20], side: 2.6, up: -4.2, lateSide: 0, lateUp: 0 },
  changeup: { speed: [16, 18], side: -0.8, up: 2.4, lateSide: -4.5, lateUp: -9 },
};

/** Where the catcher's mitt takes the ball: this plane (z). */
export const MITT_Z = FIELD.catcherZ - 0.35;

/** A pitch's flight from the release: p(τ) = p0 + v τ + ½ a τ² + ⅙ j τ³ (τ = seconds since the release; j the late break building up). */
export interface PitchPath {
  x0: number;
  y0: number;
  z0: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  jx: number;
  jy: number;
  /** seconds from the release to the contact plane, and to the mitt */
  tc: number;
  arrive: number;
  /** where the mitt takes it */
  mittX: number;
  mittY: number;
}

/** The release point for a pitcher of this hand (a right-hander's throwing arm is at −x: they face +z). */
export function releasePoint(handed: 1 | -1): V3 {
  return { x: -handed * FIELD.releaseSide, y: FIELD.releaseY, z: FIELD.releaseZ };
}

/** A real pitch's speed, km/h, for a diorama pitch of `speed` world m/s. */
export const pitchKmh = (speed: number) => speed * (REAL_PITCH_RUN / PITCH_RUN) * 3.6;

/**
 * Plan a pitch: a `kind` at `speed` (world m/s) from a `handed` pitcher's hand at
 * game time t0 that crosses the contact plane at (px, py).
 */
export function planPitch(kind: PitchKind, speed: number, px: number, py: number, handed: 1 | -1, t0: number): { pitch: Pitch; path: PitchPath } {
  const k = PITCH_KINDS[kind];
  const r = releasePoint(handed);
  const T = PITCH_RUN / speed;
  const ax = handed * k.side;
  const ay = -FIELD.gravity + k.up;
  // the late break reaches its full size at the plate
  const jx = (handed * k.lateSide) / T;
  const jy = k.lateUp / T;
  const path: PitchPath = {
    x0: r.x,
    y0: r.y,
    z0: r.z,
    vx: (px - r.x - 0.5 * ax * T * T - (jx * T * T * T) / 6) / T,
    vy: (py - r.y - 0.5 * ay * T * T - (jy * T * T * T) / 6) / T,
    vz: speed,
    ax,
    ay,
    jx,
    jy,
    tc: T,
    arrive: (MITT_Z - r.z) / speed,
    mittX: 0,
    mittY: 0,
  };
  const m = pitchAt(path, path.arrive, { x: 0, y: 0, z: 0 });
  path.mittX = m.x;
  path.mittY = m.y;
  // a strike: some of the ball over the plate's front edge, between the knees and the letters
  const f = pitchAt(path, (FIELD.plateFront - r.z) / speed, { x: 0, y: 0, z: 0 });
  const R = FIELD.ballR;
  const strike = Math.abs(f.x) <= FIELD.zoneHalfW + R && f.y >= FIELD.zoneBottom - R && f.y <= FIELD.zoneTop + R;
  const pitch: Pitch = { kind, speed, kmh: pitchKmh(speed), px, py, t0, tc: t0 + T, strike };
  return { pitch, path };
}

/** Where a pitch is τ seconds after it left the hand (it carries on past the plate the same way). */
export function pitchAt(p: PitchPath, tau: number, out: V3): V3 {
  const t2 = tau * tau;
  const t3 = t2 * tau;
  out.x = p.x0 + p.vx * tau + 0.5 * p.ax * t2 + (p.jx * t3) / 6;
  out.y = p.y0 + p.vy * tau + 0.5 * p.ay * t2 + (p.jy * t3) / 6;
  out.z = p.z0 + p.vz * tau;
  return out;
}

/** A pitch's speed τ seconds after it left the hand. */
export function pitchSpeed(p: PitchPath, tau: number) {
  const h = 0.5 * tau * tau;
  return Math.hypot(p.vx + p.ax * tau + p.jx * h, p.vy + p.ay * tau + p.jy * h, p.vz);
}

// ------------------------------------------------------------------ the swing meets the ball

/** How the bat's meeting with the ball turns into a batted ball (real units). */
export const CONTACT = {
  /** off the bat from a perfect, full-power swing at a middling pitch, real m/s */
  exitMax: 50.5,
  /** share of exitMax at power 0 (a swing that meets the ball well still sends it somewhere), and the curve up to 1 at full power */
  powerFloor: 0.6,
  powerCurve: 0.7,
  /** exit speed per real m/s of pitch speed above pitchRef (a fast pitch goes further) */
  pitchK: 0.2,
  pitchRef: 29,
  /** a pitch on the edge of the plate is harder to barrel: this share off the exit speed there */
  edgeLoss: 0.05,
  /** exit speed noise, real m/s (grows as the contact gets worse) */
  exitNoise: 0.8,
  /** launch angle, degrees: base, + per unit of the swing's lift, + per metre of pitch height above the zone's middle */
  launchBase: 21,
  launchLift: 16,
  launchHeight: 26,
  /** launch noise σ, degrees: dead centre, at the edge of the sweet spot, at the edge of fair, at the edge of
   *  contact (topped grounders, pop-ups) — a perfect swing is the swing it looked like */
  launchNoise: [1.5, 3.5, 7, 15] as const,
  /** spray: the timing's share of the way to the foul line at ±fair, and degrees per metre of the pitch's x (inside is pulled) */
  sprayTiming: 0.95,
  sprayLoc: 24,
  /** spray noise σ, degrees: on the sweet spot, at the edge of fair */
  sprayNoise: [3, 5] as const,
  /** past the fair window, degrees further foul per second of timing (early and late fouls into the stands) */
  foulSpread: 800,
  /** the noise is a normal distribution cut off at this many σ */
  noiseCut: 2.2,
};

/** Share of the best exit speed for timing error |e|: 1 on the sweet spot, falling away either side. */
export function timingQuality(ae: number) {
  const W = WINDOW;
  if (ae <= W.sweet) return 1 - 0.02 * (ae / W.sweet) ** 2;
  if (ae <= W.fair) return lerp(0.98, 0.85, smooth((ae - W.sweet) / (W.fair - W.sweet)));
  return lerp(0.85, 0.45, clamp((ae - W.fair) / (W.contact - W.fair)));
}

/** Share of the best exit speed for a swing of this power (0..1). */
export const powerShare = (p: number) => CONTACT.powerFloor + (1 - CONTACT.powerFloor) * Math.pow(clamp(p), CONTACT.powerCurve);

const DEG = Math.PI / 180;
const ZONE_MID = (FIELD.zoneBottom + FIELD.zoneTop) / 2;

/** Everything about a batted ball: the contract's summary, plus how it flies in the diorama and flew for real. */
export interface Batted {
  ball: BattedBall;
  flight: WorldFlight;
  real: RealFlight;
}

/**
 * The bat meets the ball: a swing `e` s early (−) or late (+), of `power` (0..1)
 * and `lift` (−1..1), against `pitch`, by a batter of `handed` (1: stands at −x
 * and pulls to −x). Noise from `rng`. `e` must be within WINDOW.contact.
 */
export function batBall(e: number, power: number, lift: number, pitch: Pitch, handed: 1 | -1, rng: Rng): Batted {
  const C = CONTACT;
  const W = WINDOW;
  const ae = Math.min(Math.abs(e), W.contact);
  const q = timingQuality(ae);
  const sweet = ae <= W.sweet;
  // how far off the sweet spot, 0..1 (the noise grows with it)
  const off = clamp(ae / W.contact);
  const realPitch = pitch.speed * (REAL_PITCH_RUN / PITCH_RUN);
  const edge = 1 - C.edgeLoss * clamp(Math.abs(pitch.px) / FIELD.zoneHalfW) ** 2;
  const g = () => clamp(rng.gauss(), -C.noiseCut, C.noiseCut);
  let ev = C.exitMax * powerShare(power) * q * edge + C.pitchK * (realPitch - C.pitchRef) + C.exitNoise * (0.4 + off) * g();
  const ln = C.launchNoise;
  const launchSd =
    ae <= W.sweet ? lerp(ln[0], ln[1], ae / W.sweet) : ae <= W.fair ? lerp(ln[1], ln[2], (ae - W.sweet) / (W.fair - W.sweet)) : lerp(ln[2], ln[3], (ae - W.fair) / (W.contact - W.fair));
  let launchDeg = C.launchBase + C.launchLift * clamp(lift, -1, 1) + C.launchHeight * (pitch.py - ZONE_MID) + launchSd * g();
  let sprayDeg: number;
  if (e > W.foulBack) {
    // fouled straight back: up and over the catcher
    sprayDeg = 180 + 25 * g();
    launchDeg = 58 + 12 * g();
    ev *= 0.8;
  } else {
    // early pulls (a right-hander, at −x, pulls to −x), late goes the other way; past fair, into the stands
    const x = e / W.fair;
    const ax = Math.abs(x);
    const along = ax <= 1 ? C.sprayTiming * ax : C.sprayTiming + (C.foulSpread * (ae - W.fair)) / 32;
    const sn = C.sprayNoise;
    sprayDeg = handed * Math.sign(e) * 32 * along + C.sprayLoc * pitch.px + lerp(sn[0], sn[1], clamp(ax)) * g();
  }
  launchDeg = clamp(launchDeg, -35, 85);
  ev = clamp(ev, 8, 60);
  const spray = wrapAngle(sprayDeg * DEG);
  const launch = launchDeg * DEG;
  return fly(e, sweet, ev, launch, spray, pitch.px, pitch.py);
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ the real flight

/** A real baseball in real air. */
export const REAL = {
  gravity: 9.81,
  /** quadratic drag: ρ·Cd·A / 2m, 1/m (ρ 1.2, Cd 0.35, a 7.3 cm ball of 145 g) */
  drag: (1.2 * 0.35 * Math.PI * 0.0366 ** 2) / (2 * 0.145),
  /** lift: ρ·A / 2m, times the lift coefficient (from the spin: see realFlight) */
  lift: (1.2 * Math.PI * 0.0366 ** 2) / (2 * 0.145),
  radius: 0.0366,
  /** the outfield wall, m, and the height a ball needs at the wall to be gone ("with height to spare") */
  wallH: 2.5,
  clear: 2.9,
  /** integration step, s (the midpoint rule: a millimetre off a fine step's distance) */
  h: 1 / 100,
};

/** backspin, rad/s, for a ball launched at `deg` degrees (a fly ball ~2200 rpm; below level it's topspin) */
function spinOf(deg: number) {
  const rpm = deg >= 0 ? 1100 + 40 * deg : -(900 + 25 * -deg);
  return (rpm * 2 * Math.PI) / 60;
}

export interface RealFlight {
  /** where it comes down, metres from home plate (its first touch of the ground) */
  distance: number;
  /** seconds in the air, and the highest it got, m */
  hang: number;
  apex: number;
  /** its height as it reaches `fence` metres out (−1: it never got there) */
  fenceY: number;
}

/** Fly a real batted ball: `ev` m/s at `launch` radians from `y0` m up, along the ground from home plate. */
export function realFlight(ev: number, launch: number, y0: number, fence = Infinity): RealFlight {
  const g = REAL.gravity;
  const kd = REAL.drag;
  const kl0 = REAL.lift;
  // the lift coefficient from the spin parameter S = r·|w|/v (Sawicki, Hubbard & Stronge): 1.5·S below 0.1, 0.09 + 0.6·S above
  const w = spinOf(launch / DEG);
  const rw = REAL.radius * Math.abs(w);
  const sgn = w >= 0 ? 1 : -1;
  let x = 0;
  let y = y0;
  let vx = ev * Math.cos(launch);
  let vy = ev * Math.sin(launch);
  let t = 0;
  let apex = y0;
  let fenceY = -1;
  const h = REAL.h;
  // the midpoint rule, the drag and the lift written out (no allocation: this runs as the bat meets the ball)
  while (t < 20) {
    let sp = Math.hypot(vx, vy);
    let S = rw / Math.max(1, sp);
    let kl = sgn * kl0 * Math.min(0.32, S < 0.1 ? 1.5 * S : 0.09 + 0.6 * S);
    const mx = vx + 0.5 * h * (-kd * sp * vx - kl * sp * vy);
    const my = vy + 0.5 * h * (-g - kd * sp * vy + kl * sp * vx);
    sp = Math.hypot(mx, my);
    S = rw / Math.max(1, sp);
    kl = sgn * kl0 * Math.min(0.32, S < 0.1 ? 1.5 * S : 0.09 + 0.6 * S);
    const px = x;
    const py = y;
    x += mx * h;
    y += my * h;
    vx += h * (-kd * sp * mx - kl * sp * my);
    vy += h * (-g - kd * sp * my + kl * sp * mx);
    t += h;
    if (y > apex) apex = y;
    if (fenceY < 0 && px < fence && x >= fence) fenceY = py + ((y - py) * (fence - px)) / (x - px);
    if (y <= 0) {
      const u = py / (py - y);
      const d = px + (x - px) * u;
      // (a ball that comes down exactly at the fence meets it at the bottom)
      if (fenceY < 0 && d >= fence) fenceY = 0;
      return { distance: Math.max(0, d), hang: t - h + h * u, apex, fenceY };
    }
    if (vx <= 0 && x <= 0 && t > 1) break;
  }
  return { distance: Math.max(0, x), hang: t, apex, fenceY };
}

// ------------------------------------------------------------------ the flight through the diorama

/** How batted balls fly in the diorama (world metres, game seconds). */
export const FLY = {
  /** a touch less than real gravity: an 8–14 m apex hangs 2.5–3.5 s */
  gravity: 8.3,
  /** vertical quadratic drag, 1/m: it comes down a little slower than it went up */
  dragY: 0.012,
  /** world apex from the real one: the rise above the contact point, y0 + k·(real rise)^p */
  apexK: 0.76,
  apexP: 0.75,
  /** a home run's apex, world m */
  hrApex: [8.5, 14.5] as const,
  /** off the bat, world m/s: this share of the real exit speed (a home run leaves at least hrSpeed) */
  speedK: 0.6,
  hrSpeed: 25,
  /** a home run comes down this far beyond the fence (world m) … */
  beyond: [3, 10] as const,
  /** … at bleacher height (the further back the higher) */
  standsY: [2, 4] as const,
  /** a real distance that flies right out of the stadium, and how far out it comes down (world m from home) */
  monster: 145,
  outR: 42,
  /** a home run clears the fence by at least this much (world m) */
  clearance: 1.5,
  /** foul balls go into the side stands past this |x| (every world's stands start about here), and fouls back come down this far behind */
  standsX: 10.8,
  backR: [3, 6] as const,
  backApex: 7,
  /** a foul's apex at most (a foul pop-up needn't keep everyone waiting) */
  foulApex: 7.5,
  /** after coming down in the field: bounces (vertical and along-the-ground restitution), then a roll (1/s) */
  bounceY: 0.42,
  bounceH: 0.72,
  roll: 1.6,
  /** seconds a ball that came down in the stands (or out) stays before it's gone */
  goneAfter: 0.5,
};

/** Where a batted ball comes down and what's there. */
export type FlightEnd = 'field' | 'wall' | 'stands' | 'out' | 'back';

/** One bounce or roll after the first touch-down: from flight time t0, s(τ) along the path and y(τ). */
interface Hop {
  t0: number;
  s0: number;
  y0: number;
  /** along the path (− = back towards home), and up */
  vs: number;
  vy: number;
  /** a roll: along the ground with friction, vs·e^(−roll·τ) */
  roll: boolean;
  /** the hop's end, s after t0 */
  dur: number;
}

/**
 * A batted ball's flight through the diorama. Over the ground it follows the ray
 * from home plate at its spray angle — so it's fair or foul, and meets the fence,
 * the same all the way out — starting from the contact point (a little off that
 * ray: the difference fades out over the first couple of metres). Along the ray it
 * goes s(t) = S·ln(1 + q·t/T)/ln(1 + q) (quadratic drag, closed form) while its
 * height rises to H and falls (quadratic drag again) to yL at T; a grounder or a
 * low liner is a drag-free arc instead. Then it bounces and rolls, or is gone
 * into the stands.
 */
export interface WorldFlight {
  /** the contact point */
  x0: number;
  y0: number;
  z0: number;
  /** the ray: its spray angle; the contact point's distance along it from home plate and off it; the offset fades out over `blend` m */
  spray: number;
  r0: number;
  off: number;
  blend: number;
  /** ground distance along the ray from the contact point to the first touch-down, and the time it takes */
  S: number;
  T: number;
  /** horizontal drag shape (0: none) */
  q: number;
  /** vertical: with drag (up to H at ta, then down; terminal speed vt), or a drag-free arc (vy0 at the start) */
  arc: boolean;
  vy0: number;
  vt: number;
  phi0: number;
  ta: number;
  H: number;
  yL: number;
  end: FlightEnd;
  /** the first touch-down, world */
  landX: number;
  landY: number;
  landZ: number;
  /** a home run: when (flight time) and where it clears the fence, and how far along; else fenceT = −1 */
  fenceT: number;
  fenceS: number;
  fenceX: number;
  fenceY: number;
  fenceZ: number;
  /** the real distance at the fence (the number painted there), for the distance read-out */
  fenceReal: number;
  /** where it may roll to at most, along the ray (the fence, the stands) */
  stopS: number;
  /** flight time at which it's gone (the stands, out, back), or Infinity */
  goneT: number;
  hops: Hop[];
}

export interface FlightSample {
  x: number;
  y: number;
  z: number;
  /** world m/s */
  speed: number;
  /** ground distance along the ray from the contact point (for the distance read-out) */
  s: number;
}

/** The real → world mapping of a batted ball: build its flight. `px, py` = the contact point. */
function fly(e: number, sweet: boolean, ev: number, launch: number, spray: number, px: number, py: number): Batted {
  const W = FLY;
  const back = Math.abs(spray) > Math.PI / 2;
  const fair = !back && Math.abs(spray) <= FIELD.foulAngle;
  const fenceReal = realFenceAt(spray);
  const real = realFlight(ev, launch, py, fair ? fenceReal : Infinity);
  const reached = fair && real.fenceY >= 0;
  const homeRun = reached && real.fenceY >= REAL.clear;
  const wall = reached && !homeRun;
  const distance = wall ? fenceReal : real.distance;
  // the world apex: the real rise scaled down (a home run always gets its majestic arc; a foul needn't hang about)
  const rise = Math.max(0, real.apex - py);
  let H = py + W.apexK * Math.pow(rise, W.apexP);
  if (homeRun) H = clamp(H, W.hrApex[0], W.hrApex[1]);
  else if (back) H = Math.min(H, W.backApex);
  else if (!fair) H = Math.min(H, W.foulApex);
  let v = W.speedK * ev;
  if (homeRun) v = Math.max(W.hrSpeed, v);
  // where it comes down (distance from home plate along its ray) and what's there
  let end: FlightEnd = 'field';
  let R: number;
  let yL = FIELD.ballR;
  const fw = fenceAt(spray);
  if (homeRun) {
    if (real.distance >= W.monster) {
      end = 'out';
      R = Math.max(W.outR, fw + 16) + (real.distance - W.monster);
    } else {
      end = 'stands';
      const u = clamp((real.distance - fenceReal) / (W.monster - fenceReal));
      R = fw + lerp(W.beyond[0], W.beyond[1], u);
      yL = lerp(W.standsY[0], W.standsY[1], u) + FIELD.ballR;
    }
  } else if (wall) {
    end = 'wall';
    R = fw - FIELD.ballR;
    // meets the wall this high: as high up it as it was for real (a ball that just fails to clear it, near the top)
    yL = clamp((real.fenceY / REAL.clear) * (FIELD.fenceH - 0.25), FIELD.ballR + 0.15, FIELD.fenceH - 0.25);
  } else if (back) {
    end = 'back';
    R = lerp(W.backR[0], W.backR[1], clamp((real.distance - 15) / 45));
  } else {
    R = distance / realScale(clamp(spray, -FIELD.foulAngle, FIELD.foulAngle));
    if (fair) R = Math.min(R, fw - FIELD.ballR - 0.05);
    // a foul that carries into the side stands comes down in them
    const sx = Math.abs(Math.sin(spray));
    if (!fair && R * sx > W.standsX) {
      const deep = Math.min(3.2, 0.8 + 0.35 * (R * sx - W.standsX));
      R = (W.standsX + deep) / sx;
      yL = 0.6 + 0.6 * deep + FIELD.ballR;
      end = 'stands';
    }
  }
  const f = solveFlight(px, py, FIELD.contactZ, spray, R, H, yL, v);
  f.end = end;
  f.fenceReal = fenceReal;
  if (homeRun) clearFence(f, v);
  // after it comes down
  settle(f, fair);
  const ball: BattedBall = {
    timing: e,
    sweet,
    exitSpeed: ev,
    launch,
    spray,
    distance,
    hang: f.T,
    foul: !fair,
    homeRun,
    wall,
    landX: f.landX,
    landY: f.landY,
    landZ: f.landZ,
    apex: f.arc ? Math.max(f.y0, f.H) : f.H,
  };
  return { ball, flight: f, real };
}

/** vertical, with drag: the terminal speed and launch for an apex H from y0 (FLY.gravity, FLY.dragY) */
function vertical(H: number, y0: number) {
  const G = FLY.gravity;
  const k = FLY.dragY;
  const vt = Math.sqrt(G / k);
  const phi0 = Math.acos(Math.exp(-k * (H - y0)));
  return { vt, phi0, vy0: vt * Math.tan(phi0), ta: (vt / G) * phi0 };
}

/** the horizontal drag shape q for which a ball starting at vh0 covers S in T: q/ln(1+q) = vh0·T/S */
function dragShape(S: number, T: number, vh0: number) {
  const kappa = (vh0 * T) / Math.max(1e-6, S);
  if (!(kappa > 1.0005)) return 0;
  let lo = 0;
  let hi = 1;
  while (hi / Math.log1p(hi) < kappa && hi < 1e6) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const m = 0.5 * (lo + hi);
    if ((m > 0 ? m / Math.log1p(m) : 1) < kappa) lo = m;
    else hi = m;
  }
  return 0.5 * (lo + hi);
}

/**
 * A flight from the contact point (x0, y0, z0) along the ray at `spray` that comes
 * down R m from home plate at height yL: rising to H (if H is well above the start
 * and the end) and leaving the bat at about `v` world m/s.
 */
export function solveFlight(x0: number, y0: number, z0: number, spray: number, R: number, H: number, yL: number, v: number): WorldFlight {
  const sa = Math.sin(spray);
  const ca = Math.cos(spray);
  const hz = z0 - FIELD.homeZ;
  const r0 = x0 * sa - hz * ca;
  const off = x0 * ca + hz * sa;
  const S = Math.max(0.3, R - r0);
  const f: WorldFlight = {
    x0,
    y0,
    z0,
    spray,
    r0,
    off,
    blend: Math.min(2.5, 0.5 * S),
    S,
    T: 0,
    q: 0,
    arc: false,
    vy0: 0,
    vt: 0,
    phi0: 0,
    ta: 0,
    H,
    yL,
    end: 'field',
    landX: 0,
    landY: yL,
    landZ: 0,
    fenceT: -1,
    fenceS: 0,
    fenceX: 0,
    fenceY: 0,
    fenceZ: 0,
    fenceReal: 0,
    stopS: S,
    goneT: Infinity,
    hops: [],
  };
  shape(f, H, v);
  groundAt(f, S, tmpG);
  f.landX = tmpG.x;
  f.landZ = tmpG.z;
  return f;
}

/** the flight's shape for an apex H (if it rises well above the start and the end) and a launch speed of about v */
function shape(f: WorldFlight, H: number, v: number) {
  const G = FLY.gravity;
  const { S, y0, yL } = f;
  f.H = H;
  if (H > Math.max(y0, yL) + 0.4) {
    f.arc = false;
    const V = vertical(H, y0);
    f.vt = V.vt;
    f.phi0 = V.phi0;
    f.vy0 = V.vy0;
    f.ta = V.ta;
    f.T = V.ta + (V.vt / G) * Math.acosh(Math.exp(FLY.dragY * (H - yL)));
    const vh0 = Math.sqrt(Math.max(v * v - V.vy0 * V.vy0, (0.3 * v) ** 2));
    f.q = dragShape(S, f.T, vh0);
  } else {
    // a grounder or a low liner: a drag-free arc, as flat as reaches the spot at this speed
    f.arc = true;
    f.q = 0;
    const sp = Math.max(v, 4);
    const A = (G * S * S) / (2 * sp * sp);
    const disc = S * S - 4 * A * (A + yL - y0);
    let tan: number;
    let vh: number;
    if (disc >= 0 && A > 1e-9) {
      tan = (S - Math.sqrt(disc)) / (2 * A);
      vh = sp / Math.sqrt(1 + tan * tan);
    } else {
      // out of reach at this speed: a 20° arc that just gets there
      tan = Math.tan(20 * DEG);
      vh = Math.sqrt((G * S * S) / (2 * Math.max(0.05, S * tan + y0 - yL)));
    }
    f.T = S / vh;
    f.vy0 = vh * tan;
    f.H = f.vy0 > 0 ? y0 + (f.vy0 * f.vy0) / (2 * G) : y0;
    f.ta = f.vy0 > 0 ? f.vy0 / G : 0;
  }
}

/** A home run's flight must visibly clear the fence: raise the arc until it's FLY.clearance over it where it crosses. */
function clearFence(f: WorldFlight, v: number) {
  const s = fenceAt(f.spray) - f.r0;
  if (!(s > 0 && s < f.S)) return;
  for (let tries = 0; ; tries++) {
    const t = timeAtS(f, s);
    const p = sample(f, t, tmpS);
    f.fenceT = t;
    f.fenceS = s;
    f.fenceX = p.x;
    f.fenceY = p.y;
    f.fenceZ = p.z;
    if (p.y >= FIELD.fenceH + FLY.clearance || tries >= 8) return;
    shape(f, f.H + 1, v);
  }
}

/** flight time at which the ball is s along its ray (before it comes down) */
export function timeAtS(f: WorldFlight, s: number) {
  const u = clamp(s / f.S);
  return f.q > 0 ? (f.T * (Math.pow(1 + f.q, u) - 1)) / f.q : f.T * u;
}

/** the bounces and the roll after the first touch-down (or nothing: the stands, out, back) */
function settle(f: WorldFlight, fair: boolean) {
  const W = FLY;
  const G = W.gravity;
  const vs = velS(f, f.T);
  const vy = velY(f, f.T);
  if (f.end === 'stands' || f.end === 'out' || f.end === 'back') {
    f.goneT = f.T + (f.end === 'stands' ? W.goneAfter : 0.15);
    if (f.end === 'stands') {
      // a little hop off the seats
      const h: Hop = { t0: f.T, s0: f.S, y0: f.yL, vs: vs * 0.25, vy: -vy * 0.3, roll: false, dur: 0 };
      h.dur = (2 * h.vy) / G;
      f.hops.push(h);
      f.stopS = f.S + 1;
    }
    return;
  }
  // how far it may go: the fence (fair), the side stands or a long way (foul)
  const sx = Math.abs(Math.sin(f.spray));
  let stop = f.S + 40;
  if (fair) stop = fenceAt(f.spray) - FIELD.ballR - 0.05 - f.r0;
  else if (sx > 0.05) stop = (W.standsX - FIELD.ballR) / sx - f.r0;
  f.stopS = Math.max(f.S, stop);
  let t = f.T;
  let s = f.S;
  let y = f.yL;
  let hs = vs;
  let hy = -vy;
  if (f.end === 'wall') {
    // off the wall: back a little, and down it
    hs = -0.3 * vs;
    hy = vy * 0.6;
  } else {
    hy *= W.bounceY;
    hs *= W.bounceH;
  }
  for (let n = 0; n < 8; n++) {
    if (hy < 0.8 && y <= FIELD.ballR + 1e-6) break;
    // time to come back down to the ground from y with hy up
    const dur = (hy + Math.sqrt(hy * hy + 2 * G * Math.max(0, y - FIELD.ballR))) / G;
    f.hops.push({ t0: t, s0: s, y0: y, vs: hs, vy: hy, roll: false, dur });
    const vDown = hy - G * dur;
    t += dur;
    s += hs * dur;
    y = FIELD.ballR;
    hy = -vDown * W.bounceY;
    hs *= W.bounceH;
  }
  f.hops.push({ t0: t, s0: s, y0: FIELD.ballR, vs: hs, vy: 0, roll: true, dur: Infinity });
}

const tmpS: FlightSample = { x: 0, y: 0, z: 0, speed: 0, s: 0 };
const tmpG = { x: 0, z: 0 };

/** where on the ground the ball is at s along its ray (the contact point's offset fading out) */
function groundAt(f: WorldFlight, s: number, out: { x: number; z: number }) {
  const r = f.r0 + s;
  const u = f.blend > 0 ? 1 - Math.min(1, Math.max(0, s) / f.blend) : 0;
  const w = f.off * u * u;
  const sa = Math.sin(f.spray);
  const ca = Math.cos(f.spray);
  out.x = sa * r + ca * w;
  out.z = FIELD.homeZ - ca * r + sa * w;
  return out;
}

/** ground speed along the ray at flight time t (before the touch-down) */
function velS(f: WorldFlight, t: number) {
  if (f.q > 0) return (f.S * (f.q / f.T)) / ((1 + (f.q * t) / f.T) * Math.log1p(f.q));
  return f.S / f.T;
}

/** vertical speed at flight time t (before the touch-down) */
function velY(f: WorldFlight, t: number) {
  const G = FLY.gravity;
  if (f.arc) return f.vy0 - G * t;
  if (t <= f.ta) return f.vt * Math.tan(f.phi0 - (G * t) / f.vt);
  return -f.vt * Math.tanh((G * (t - f.ta)) / f.vt);
}

/** height at flight time t (before the touch-down) */
function heightAt(f: WorldFlight, t: number) {
  const G = FLY.gravity;
  if (f.arc) return f.y0 + f.vy0 * t - 0.5 * G * t * t;
  const k = FLY.dragY;
  if (t <= f.ta) return f.y0 + Math.log(Math.cos(f.phi0 - (G * t) / f.vt) / Math.cos(f.phi0)) / k;
  return f.H - Math.log(Math.cosh((G * (t - f.ta)) / f.vt)) / k;
}

/** ground distance along the ray at flight time t (before the touch-down) */
function alongAt(f: WorldFlight, t: number) {
  if (t >= f.T) return f.S;
  return f.q > 0 ? (f.S * Math.log1p((f.q * t) / f.T)) / Math.log1p(f.q) : (f.S * t) / f.T;
}

/** Where a batted ball is `t` s into its flight (0 = it leaves the bat), and how fast it's going. */
export function sample(f: WorldFlight, t: number, out: FlightSample): FlightSample {
  let s: number;
  let y: number;
  let vs: number;
  let vy: number;
  if (t <= 0) {
    s = 0;
    y = f.y0;
    vs = velS(f, 0);
    vy = velY(f, 0);
  } else if (t < f.T) {
    s = alongAt(f, t);
    y = heightAt(f, t);
    vs = velS(f, t);
    vy = velY(f, t);
  } else if (t === f.T || !f.hops.length) {
    s = f.S;
    y = f.yL;
    vs = 0;
    vy = 0;
  } else {
    let h = f.hops[0];
    for (let i = 1; i < f.hops.length && f.hops[i].t0 <= t; i++) h = f.hops[i];
    const tau = Math.min(t - h.t0, h.dur);
    if (h.roll) {
      const k = FLY.roll;
      s = h.s0 + (h.vs / k) * (1 - Math.exp(-k * tau));
      vs = h.vs * Math.exp(-k * tau);
      y = h.y0;
      vy = 0;
    } else {
      s = h.s0 + h.vs * tau;
      y = Math.max(FIELD.ballR, h.y0 + h.vy * tau - 0.5 * FLY.gravity * tau * tau);
      vs = h.vs;
      vy = h.vy - FLY.gravity * tau;
    }
    // (it stops at the fence, or the edge of the stands)
    if (s > f.stopS) ((s = f.stopS), (vs = 0));
  }
  groundAt(f, s, tmpG);
  out.x = tmpG.x;
  out.z = tmpG.z;
  out.y = y;
  out.s = s;
  out.speed = Math.hypot(vs, vy);
  return out;
}

/** The distance read-out (real metres) for a ball `s` along its ray: it reads the fence's number at the fence, and exactly `distance` where it comes down. */
export function readout(f: WorldFlight, distance: number, s: number) {
  const u = clamp(s / f.S);
  if (f.fenceT >= 0 && f.fenceS > 0 && f.fenceS < f.S) {
    const fs = f.fenceS;
    if (s <= fs) return (f.fenceReal * Math.max(0, s)) / fs;
    return f.fenceReal + ((distance - f.fenceReal) * (Math.min(s, f.S) - fs)) / (f.S - fs);
  }
  return distance * u;
}
