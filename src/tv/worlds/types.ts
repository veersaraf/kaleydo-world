import type * as THREE from 'three';

export type CharRole =
  | 'skin'
  | 'shirt'
  | 'shorts'
  | 'shoe'
  | 'hair'
  | 'hat'
  | 'eye'
  | 'eyeWhite'
  | 'mouth'
  | 'cheek'
  | 'racket'
  | 'grip'
  | 'strings'
  | 'gold';

export interface MaterialKit {
  char(role: CharRole, color: THREE.Color): THREE.Material;
  /** inverted-hull outline for characters (null = none) */
  outline: { color: THREE.Color; width: number; emissive?: number } | null;
  /** per-character outline colour override (e.g. neon glow in the player's colour) */
  outlineColor?: (look: import('../chars/look').Look) => THREE.Color;
  /** flatten characters into paper cut-outs */
  flat?: boolean;
  castShadow?: boolean;
  shadowColor: THREE.Color;
  shadowOpacity: number;
}
