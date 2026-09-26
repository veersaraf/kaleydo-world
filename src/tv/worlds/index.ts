import type { WorldDef } from './base';
import { PARK } from './park';
import { PLAZA } from './plaza';
import { INKWELL } from './ink';
import { NEON } from './neon';
import { PIXEL } from './pixel';
import { PAPER } from './paper';
import { CLAY } from './clay';
import { AQUARELLE } from './water';
import { STARFALL } from './cosmic';

export const WORLDS: WorldDef[] = [PARK, PLAZA, INKWELL, NEON, PIXEL, PAPER, CLAY, AQUARELLE, STARFALL];

export function worldDef(id: string) {
  return WORLDS.find((w) => w.id === id) ?? WORLDS[0];
}
