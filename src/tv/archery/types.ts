// Contracts between the archery pieces: phone ↔ game ↔ rendering ↔ animation.

import type { Look } from '../chars/look';

export type V3t = [number, number, number];

/** Something to shoot at. Faces look along +z (towards the archer). */
export interface TargetDef {
  id: number;
  kind: 'face' | 'balloon';
  /** centre, world metres */
  x: number;
  y: number;
  z: number;
  /** face radius (a balloon's radius for balloons) */
  r: number;
  /** a bonus target's points (balloons), or 0 for a ringed face */
  bonus: number;
  /** moving targets: sideways sway amplitude (m) and period (s); 0 = still */
  swayX: number;
  swayT: number;
}

/** One arrow for the renderer. */
export interface ArrowView {
  x: number;
  y: number;
  z: number;
  /** unit direction it's pointing */
  dx: number;
  dy: number;
  dz: number;
  /** 'flying', stuck in a target (it moves with it), or stuck in the ground / scenery */
  state: 'nocked' | 'flying' | 'stuck';
  /** the target it's stuck in (for moving targets), or −1 */
  target: number;
  /** the archer's colour (fletching) */
  color: string;
}

/** Everything the renderer needs for one frame. */
export interface RangeView {
  targets: (TargetDef & { visible: boolean; /** balloons pop */ popped: boolean })[];
  arrows: ArrowView[];
  /** wind, m/s: + = blowing to +x (the archer's right); shown with flags and a gauge */
  wind: number;
  /** effects starting this frame */
  fx: RangeFx[];
}

export type RangeFx =
  | { type: 'hit'; x: number; y: number; z: number; ring: number }
  | { type: 'pop'; x: number; y: number; z: number; color: string }
  | { type: 'thunk'; x: number; y: number; z: number };

/** What the archer is doing — the input to the archer animator. */
export interface ArcherState {
  x: number;
  z: number;
  handed: 1 | -1;
  phase: 'idle' | 'nock' | 'draw' | 'hold' | 'release' | 'watch' | 'cheer' | 'sad';
  /** seconds since the phase began */
  t: number;
  /** 0..1 how far the string is drawn */
  draw: number;
  /** where the arrow points: yaw (radians, + = to the archer's left … as a yaw about +y) and pitch (+ = up) */
  yaw: number;
  pitch: number;
}

/** Someone taking part: a person on an input seat, or a CPU. */
export interface Archer {
  name: string;
  color: string;
  look: Look;
  handed: 1 | -1;
  /** input seat, or −1 for a CPU */
  slot: number;
  /** CPU skill 0..1 (null = a person) */
  cpu: number | null;
}

/** What the game reports (sounds, HUD, camera, the phones). */
export type ArcheryEvent =
  /** a new end (round of arrows): its number, the targets are up, the wind */
  | { type: 'end'; end: number; ends: number; wind: number }
  /** whose turn it is, and which arrow of their end */
  | { type: 'turn'; who: number; arrow: number; arrows: number }
  | { type: 'draw'; who: number }
  | { type: 'shot'; who: number; speed: number }
  /** where an arrow landed: points scored (ring or bonus), the target (−1 = missed everything) */
  | { type: 'score'; who: number; points: number; ring: number; target: number; bullseye: boolean; x: number; y: number; z: number }
  | { type: 'over'; ranking: number[] };
