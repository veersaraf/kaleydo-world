// Contracts between the duel pieces: phone ↔ game/AI ↔ rendering ↔ animation.
//
// A fighter's own frame: x = their right, y = up, z = towards the opponent.
// (The phone's player frame is x right, y towards the screen, z up: its y is
// the fighter's z and its z the fighter's y. The screen is where the opponent is.)

export type V3t = [number, number, number];

/** How the sword is held, in the fighter's own frame (unit vectors). */
export interface SwordAim {
  /** hilt → tip */
  blade: V3t;
  /** which way the cutting edge faces (perpendicular to the blade) */
  edge: V3t;
}

/** An attack — measured from the phone's swing, or made by a CPU or the keyboard. */
export interface SlashInput {
  kind: 'slash' | 'thrust';
  /**
   * slash: which way the sword's tip travels across the attacker's own view, radians:
   * 0 = to their right, π/2 = up, −π/2 = down (a chop), ±π = to their left;
   * −π/4 = down and to the right, and so on. Ignored for a thrust.
   */
  dir: number;
  /** 0..1: how hard (swing speed) */
  power: number;
}

export type FighterPhase =
  /** walking on, or waiting between rounds */
  | 'idle'
  /** sword up, free to attack or guard */
  | 'ready'
  /** holding the guard: the blade's angle decides what it stops */
  | 'guard'
  /** (CPU) cocking the sword before an attack — it shows where the attack will come from */
  | 'windup'
  /** the strike itself (`attack` is set) */
  | 'slash'
  | 'thrust'
  /** just attacked: can't guard for a moment */
  | 'recover'
  /** took a clean hit: knocked back (`push`) */
  | 'stagger'
  /** had an attack blocked: dazed and open */
  | 'stunned'
  /** blades met: both bounce back a little */
  | 'clash'
  /** over the edge (see arena.ts fallY) */
  | 'fall'
  | 'win'
  | 'lose';

/** Everything the animator needs to pose one fighter for one frame. */
export interface FighterState {
  /** where they stand, world metres (the platform runs along z, x is across it) */
  x: number;
  z: number;
  /** +1 = facing −z (fighter 0, seen from behind by the default camera), −1 = facing +z */
  facing: 1 | -1;
  handed: 1 | -1;
  phase: FighterPhase;
  /** seconds since the phase began */
  t: number;
  /** how the sword is held right now (live from the phone, or the CPU's hands) */
  aim: SwordAim;
  /** windup / slash / thrust: the attack being made */
  attack: SlashInput | null;
  /** stagger / fall / clash: how fast they're being pushed backwards, m/s */
  push: number;
  /** counts up when the game puts this fighter back in a pose they weren't in (a hit undone by a guard
   *  that turns out to have been up in time): the animator cuts to the new pose rather than easing out of the old one */
  snap?: number;
}

/** Effects for the arena to draw this frame (world positions). */
export type DuelFx =
  | { type: 'splash'; x: number; z: number }
  | { type: 'hit'; x: number; y: number; z: number; strength: number }
  | { type: 'block'; x: number; y: number; z: number; strength: number }
  | { type: 'clash'; x: number; y: number; z: number };

/** What the renderer (the arena) needs for one frame; fighters are drawn from their poses. */
export interface DuelView {
  /** the platform's half-length right now (the final round is shorter) */
  halfLength: number;
  /** effects starting this frame */
  fx: DuelFx[];
}

/** What the game reports (sounds, HUD, camera, the phones). Fighters are 0 (near) and 1 (far). */
export type DuelEvent =
  | { type: 'round'; round: number; final: boolean }
  /** "Fight!" — attacks count from now */
  | { type: 'fight' }
  | { type: 'attack'; who: number; attack: SlashInput }
  /** `who` took a clean hit from `by` */
  | { type: 'hit'; who: number; by: number; strength: number; x: number; y: number; z: number }
  /** `who` blocked `by`'s attack — `by` is stunned */
  | { type: 'block'; who: number; by: number; x: number; y: number; z: number; /** a hit that was shown a moment ago, turned into this block by a guard that had been up in time: it corrects that hit, it isn't a second blow */ rescued?: boolean }
  | { type: 'clash'; x: number; y: number; z: number }
  /** `who` is at the edge: one more hit and they're off */
  | { type: 'edge'; who: number }
  | { type: 'fall'; who: number }
  | { type: 'splash'; who: number; x: number; z: number }
  /** winner null = a draw (time ran out with nobody ahead) */
  | { type: 'round-end'; winner: number | null; score: [number, number]; timeout: boolean }
  | { type: 'over'; winner: number; score: [number, number] };

/** Someone taking part: a person on an input seat, or a CPU. */
export interface Duelist {
  name: string;
  color: string;
  look: import('../chars/look').Look;
  handed: 1 | -1;
  /** input seat, or −1 for a CPU */
  slot: number;
  /** CPU skill 0..1 (null = a person) */
  cpu: number | null;
}

/** Turn the phone's orientation (player frame: x right, y towards the screen, z up;
 *  s = the phone's top, n = its screen normal) into a sword aim. The phone is held
 *  like a hilt: its top points along the blade, the screen faces along the edge. */
export function aimFromPhone(s: V3t, n: V3t): SwordAim {
  return { blade: [s[0], s[2], s[1]], edge: [n[0], n[2], n[1]] };
}

/** The angle of the blade across the fighter's own view (radians, as SlashInput.dir: 0 = pointing right, π/2 = up). */
export function bladeAngle(a: SwordAim) {
  return Math.atan2(a.blade[1], a.blade[0]);
}

/**
 * Does a guard stop a slash? The blade must lie across the slash's path: at more
 * than `minDeg` to it, seen from the front. The attacker faces the other way, so
 * their right is the defender's left: the slash's direction is mirrored first.
 */
export function blocks(guard: SwordAim, slash: SlashInput, minDeg = 55) {
  if (slash.kind === 'thrust') return true;
  const g = bladeAngle(guard);
  const d = Math.PI - slash.dir; // into the defender's view
  // angle between the two lines (not directions): 0..π/2
  let a = Math.abs(((g - d) % Math.PI) + Math.PI) % Math.PI;
  if (a > Math.PI / 2) a = Math.PI - a;
  return a >= (minDeg * Math.PI) / 180;
}
