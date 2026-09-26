// World Tour: eight champions, eight worlds, one shattered Prism.

import type { Look } from './chars/look';
import { AI_LEVELS, type AIProfile } from './tennis/ai';

export interface Champion {
  world: string;
  name: string;
  title: string;
  quote: string;
  beatLine: string;
  look: Look;
  ai: AIProfile;
  handed: 1 | -1;
  games: number;
  kaleido?: boolean;
}

const L = (o: Partial<Look>): Look => ({
  skin: '#f6c9a4',
  shirt: '#3aa8ff',
  shorts: '#f7f6fb',
  shoes: '#ffffff',
  hair: 'cap',
  hairColor: '#2b1d16',
  hat: '#ff5a6e',
  eyes: 'oval',
  cheeks: true,
  brows: true,
  racket: '#ffc53d',
  height: 1,
  girth: 1,
  ...o,
});

const P = (base: keyof typeof AI_LEVELS, tweak: Partial<AIProfile>): AIProfile => ({ ...AI_LEVELS[base], ...tweak, id: base });

export const TOUR: Champion[] = [
  {
    world: 'plaza',
    name: 'Coach Pip',
    title: 'Keeper of the Plaza',
    quote: 'Swing when the ball reaches you. Early goes across, late goes straight. Show me!',
    beatLine: 'Ha! You’re a natural. The Plaza shard is yours.',
    look: L({ shirt: '#35d49a', hat: '#ffffff', hair: 'cap', skin: '#e9b48a', eyes: 'dot', racket: '#ff5a6e' }),
    ai: P('rookie', { power: 0.3, errors: 0.12 }),
    handed: 1,
    games: 1,
  },
  {
    world: 'paper',
    name: 'Origami Ori',
    title: 'Folder of Lobs',
    quote: 'Everything I hit floats like a paper crane. Watch the sky…',
    beatLine: 'Unfolded! Take the Paper shard.',
    look: L({ shirt: '#f28fb0', hat: '#ffffff', hair: 'bun', hairColor: '#1c1c24', skin: '#ffdcc2', eyes: 'sleepy', racket: '#2a9d8f' }),
    ai: P('rookie', { speed: 4.1, lob: 0.45, spin: 0.5, errors: 0.09 }),
    handed: 1,
    games: 1,
  },
  {
    world: 'pixel',
    name: 'Sir Pixelot',
    title: 'Knight of Eight Bits',
    quote: 'HALT! No rally passes these castle walls. PRESS START TO LOSE.',
    beatLine: 'GAME OVER… for me. The Bit shard is yours, brave one.',
    look: L({ shirt: '#83769c', hat: '#c2c3c7', hair: 'beanie', skin: '#ffccaa', eyes: 'tall', racket: '#ffec27' }),
    ai: P('club', { spin: 0.05, aggression: 0.35, errors: 0.06 }),
    handed: 1,
    games: 1,
  },
  {
    world: 'clay',
    name: 'Mudge',
    title: 'Sculptor of Topspin',
    quote: 'Every shot I hit is hand-shaped. Heavy. Kicking. Squishy.',
    beatLine: 'Squashed flat! Here, the Clay shard.',
    look: L({ shirt: '#d4683c', hat: '#3a8ce8', hair: 'afro', hairColor: '#4a2e1f', skin: '#b77a4e', eyes: 'wide', racket: '#58b04e', girth: 1.12 }),
    ai: P('club', { speed: 4.0, spin: 0.85, power: 0.6, errors: 0.055 }),
    handed: -1,
    games: 1,
  },
  {
    world: 'water',
    name: 'Madame Aqua',
    title: 'Painter of Angles',
    quote: 'Tennis is colour. I paint the lines — you merely chase them.',
    beatLine: 'Magnifique. The Aquarelle shard, for the artist.',
    look: L({ shirt: '#b28dff', hat: '#ff8fab', hair: 'bob', hairColor: '#e8c16a', skin: '#ffe2cc', eyes: 'oval', racket: '#8fd3ff' }),
    ai: P('pro', { aggression: 0.85, drop: 0.12, errors: 0.05 }),
    handed: 1,
    games: 2,
  },
  {
    world: 'ink',
    name: 'Master Sumi',
    title: 'Master of the Brush',
    quote: 'One breath. One stroke. One point. Do not blink.',
    beatLine: 'The brush bows to you. Carry the Ink shard well.',
    look: L({ shirt: '#1d1b2a', hat: '#d8321f', hair: 'band', hairColor: '#b8b8c8', skin: '#e9dcc6', eyes: 'sleepy', racket: '#d8321f', height: 0.96 }),
    ai: P('pro', { spin: -0.6, drop: 0.2, timing: 0.018, errors: 0.04 }),
    handed: 1,
    games: 2,
  },
  {
    world: 'neon',
    name: 'DJ Voltage',
    title: 'Queen of the Night Drive',
    quote: 'Turn it UP. My serves drop at 200 BPM.',
    beatLine: 'You broke my beat… respect. The Neon shard is yours.',
    look: L({ shirt: '#ff2fb4', hat: '#22e6ff', hair: 'mohawk', hairColor: '#22e6ff', skin: '#8d5a36', eyes: 'wide', racket: '#ffd23f' }),
    ai: P('ace', { power: 0.88, serve: 0.95, errors: 0.04 }),
    handed: 1,
    games: 2,
  },
  {
    world: 'cosmic',
    name: 'Nova',
    title: 'Drifter Between Stars',
    quote: 'Out here the ball hangs in the air. Most players forget to breathe.',
    beatLine: 'The stars align for you. Take the last shard.',
    look: L({ shirt: '#5ef2ff', hat: '#a86bff', hair: 'spiky', hairColor: '#f0f0ff', skin: '#a8c8ff', eyes: 'tall', racket: '#ff6bd6' }),
    ai: P('ace', { speed: 5.6, aggression: 0.85, errors: 0.03 }),
    handed: -1,
    games: 2,
  },
  {
    world: 'plaza',
    name: 'The Prism King',
    title: 'Heart of the Kaleidoscope',
    quote: 'Eight shards. Eight worlds. Now play them all at once.',
    beatLine: 'The Prism… is whole again. Well played, champion.',
    look: L({ shirt: '#ffffff', hat: '#ffc531', hair: 'crown', hairColor: '#ffffff', skin: '#f3d1b5', eyes: 'wide', racket: '#a07cff', height: 1.06 }),
    ai: P('ace', { speed: 5.8, react: 0.15, power: 0.85, aggression: 0.9, errors: 0.028 }),
    handed: 1,
    games: 2,
    kaleido: true,
  },
];

export function loadTour(): { beaten: number } {
  try {
    const v = JSON.parse(localStorage.getItem('kaleido.tour') || '{}');
    return { beaten: Math.max(0, Math.min(TOUR.length, Number(v.beaten) || 0)) };
  } catch {
    return { beaten: 0 };
  }
}

export function saveTour(t: { beaten: number }) {
  try {
    localStorage.setItem('kaleido.tour', JSON.stringify(t));
  } catch {}
}
