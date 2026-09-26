// Character appearance. Characters are round little athletes with floating
// hands — simple shapes that animate well and survive every art style.

import { Rng } from '../core/math';

export type Hair = 'none' | 'cap' | 'spiky' | 'bob' | 'bun' | 'band' | 'beanie' | 'mohawk' | 'pony' | 'afro' | 'bowl' | 'crown';
export type Eyes = 'dot' | 'oval' | 'tall' | 'sleepy' | 'wide';

export interface Look {
  skin: string;
  shirt: string;
  shorts: string;
  shoes: string;
  hair: Hair;
  hairColor: string;
  /** colour of caps / bands / beanies */
  hat: string;
  eyes: Eyes;
  cheeks: boolean;
  brows: boolean;
  racket: string;
  /** body proportions */
  height: number;
  girth: number;
}

export const SKINS = ['#ffdcc2', '#f6c9a4', '#e9b48a', '#d49a6a', '#b77a4e', '#8d5a36', '#6b4226', '#f3d1b5'];
export const HAIR_COLORS = ['#2b1d16', '#4a2e1f', '#7a4a26', '#c98a3c', '#e8c16a', '#1c1c24', '#b8b8c8', '#d65a3a', '#6d3fa0'];

export const TEAM_SHORTS = ['#2d2a44', '#f4f2fa'];

export function playerLook(color: string, seed: number): Look {
  const r = new Rng(seed * 7919 + 13);
  const hairs: Hair[] = ['cap', 'spiky', 'bob', 'bun', 'band', 'beanie', 'pony', 'bowl', 'mohawk'];
  return {
    skin: r.pick(SKINS),
    shirt: color,
    shorts: '#f7f6fb',
    shoes: '#ffffff',
    hair: r.pick(hairs),
    hairColor: r.pick(HAIR_COLORS),
    hat: shade(color, -0.25),
    eyes: r.pick(['dot', 'oval', 'tall'] as Eyes[]),
    cheeks: r.chance(0.7),
    brows: r.chance(0.6),
    racket: shade(color, 0.1),
    height: r.range(0.96, 1.05),
    girth: r.range(0.95, 1.06),
  };
}

export function randomLook(r: Rng, shirt?: string): Look {
  const hairs: Hair[] = ['none', 'cap', 'spiky', 'bob', 'bun', 'band', 'beanie', 'mohawk', 'pony', 'afro', 'bowl'];
  const shirtC = shirt ?? `hsl(${r.int(0, 359)}, ${r.int(55, 85)}%, ${r.int(48, 62)}%)`;
  return {
    skin: r.pick(SKINS),
    shirt: shirtC,
    shorts: r.pick(['#2d2a44', '#f4f2fa', '#3b5bdb', '#1f7a5a', '#8a2b4a']),
    shoes: r.pick(['#ffffff', '#1d1b2a', '#ff6b3d']),
    hair: r.pick(hairs),
    hairColor: r.pick(HAIR_COLORS),
    hat: `hsl(${r.int(0, 359)}, 70%, 55%)`,
    eyes: r.pick(['dot', 'oval', 'tall', 'sleepy', 'wide'] as Eyes[]),
    cheeks: r.chance(0.6),
    brows: r.chance(0.6),
    racket: `hsl(${r.int(0, 359)}, 70%, 55%)`,
    height: r.range(0.94, 1.06),
    girth: r.range(0.92, 1.1),
  };
}

/** Lighten (amt > 0) or darken (amt < 0) a CSS colour. */
export function shade(css: string, amt: number): string {
  const c = parseCss(css);
  const f = (v: number) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
  return `rgb(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;
}

let ctx: CanvasRenderingContext2D | null = null;
export function parseCss(css: string): [number, number, number] {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  const v = ctx.fillStyle as string;
  if (v.startsWith('#')) {
    const n = parseInt(v.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = v.match(/[\d.]+/g) || ['0', '0', '0'];
  return [+m[0], +m[1], +m[2]];
}
