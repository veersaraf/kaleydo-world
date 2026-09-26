// Original compositions for each world.

import type { Song } from './music';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const IN_SCALE = [0, 1, 5, 7, 8];
const MAJ_PENTA = [0, 2, 4, 7, 9];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];

export const SONGS: Record<string, Song> = {
  // Sunny Plaza — bouncy, bright, whistle-able.
  plaza: {
    id: 'plaza',
    bpm: 118,
    root: 65, // F4
    scale: MAJOR,
    chords: [1, 6, 4, 5, 1, 3, 4, 5],
    swing: 0.08,
    hit: { inst: 'bell', oct: 1, vel: 0.55 },
    tracks: [
      { kind: 'drone', inst: 'pad', layer: 0, vol: 0.5, oct: -1, rev: 0.4 },
      { kind: 'bass', inst: 'pluck', layer: 1, vol: 0.9, oct: -2, pat: 'r..f..r.r..f..o.', dur: 3 },
      { kind: 'chord', inst: 'epiano', layer: 1, vol: 0.32, oct: 0, pat: '....x.......x..o', dur: 3 },
      { kind: 'drum', inst: 'hat', layer: 1, vol: 0.55, pat: '..x...x...x...x.' },
      { kind: 'drum', inst: 'kick', layer: 2, vol: 0.7, pat: 'x...x...x...x...' },
      { kind: 'drum', inst: 'clap', layer: 2, vol: 0.5, pat: '....x.......x...' },
      { kind: 'drum', inst: 'shaker', layer: 3, vol: 0.4, pat: 'xoxoxoxoxoxoxoxo' },
      { kind: 'arp', inst: 'musicbox', layer: 2, vol: 0.18, oct: 1, every: 2, arp: [0, 2, 4, 7, 4, 2, 4, 2], rev: 0.35 },
      {
        kind: 'melody',
        inst: 'flute',
        layer: 3,
        vol: 0.7,
        oct: 0,
        rev: 0.3,
        mel: [
          '5:2 6:2 5:2 3:2 1:4 3:2 5:2',
          '6:4 5:2 4:2 3:4 2:4',
          "4:2 5:2 6:2 1':2 6:4 4:4",
          '5:6 -:2 2:2 3:2 4:2 5:2',
          "5:2 6:2 5:2 3:2 1':4 7:2 6:2",
          '5:4 3:2 5:2 7:4 6:4',
          "6:2 1':2 6:2 4:2 5:4 6:4",
          '5:8 -:4 5,:2 7,:2',
        ],
      },
    ],
  },

  // Inkwell — koto, shakuhachi breath and taiko in the In scale.
  ink: {
    id: 'ink',
    bpm: 80,
    root: 62, // D4
    scale: IN_SCALE,
    chords: [1, 1, 3, 1, 4, 3, 2, 1],
    hit: { inst: 'koto', oct: 1, vel: 0.8, dly: 0.05 },
    tracks: [
      { kind: 'drone', inst: 'pad', layer: 0, vol: 0.4, oct: -2, rev: 0.6 },
      { kind: 'arp', inst: 'koto', layer: 1, vol: 0.55, oct: 0, every: 2, arp: [0, 1, 2, 1, 3, 2, 1, 2], rev: 0.4 },
      { kind: 'drum', inst: 'taiko', layer: 1, vol: 0.8, pat: 'x.......o...x...' },
      { kind: 'drum', inst: 'wood', layer: 2, vol: 0.5, pat: '......x.......x.' },
      { kind: 'drum', inst: 'shaker', layer: 3, vol: 0.25, pat: '..o...o...o...o.' },
      { kind: 'bass', inst: 'koto', layer: 2, vol: 0.6, oct: -1, pat: 'r.......f.......', dur: 8 },
      {
        kind: 'melody',
        inst: 'flute',
        layer: 2,
        vol: 0.75,
        oct: 0,
        rev: 0.55,
        mel: ['3:6 2:2 1:8', '-:4 3:2 4:2 5:8', '6:4 5:4 4:4 3:4', '4:12 -:4', '3:4 4:2 5:2 6:6 5:2', '4:4 3:4 2:8', '1:6 2:2 3:4 2:4', '1:12 -:4'],
      },
    ],
  },

  // Neon Drive — arps, gated snare, sunset synths.
  neon: {
    id: 'neon',
    bpm: 104,
    root: 57, // A3
    scale: MINOR,
    chords: [1, 6, 3, 7, 1, 6, 3, 7],
    hit: { inst: 'pulse', oct: 2, vel: 0.9, dly: 0.35 },
    tracks: [
      { kind: 'drone', inst: 'pad', layer: 0, vol: 0.9, oct: 0, rev: 0.5 },
      { kind: 'bass', inst: 'saw', layer: 1, vol: 0.9, oct: -1, pat: 'rorororororororo', dur: 1 },
      { kind: 'drum', inst: 'kick', layer: 1, vol: 0.85, pat: 'x...x...x...x...' },
      { kind: 'drum', inst: 'snare', layer: 2, vol: 0.75, pat: '....x.......x...', rev: 0.6 },
      { kind: 'drum', inst: 'hat', layer: 2, vol: 0.4, pat: 'xoxoxoxoxoxoxoxo' },
      { kind: 'arp', inst: 'pulse', layer: 2, vol: 0.5, oct: 1, every: 1, arp: [0, 2, 4, 7], dur: 1, dly: 0.4, rev: 0.2 },
      {
        kind: 'melody',
        inst: 'saw',
        layer: 3,
        vol: 0.85,
        oct: 1,
        dly: 0.45,
        rev: 0.35,
        mel: ['5:4 4:2 3:2 1:4 3:4', '6:6 5:2 4:4 3:4', "3:4 5:4 1':6 7:2", '7:8 5:4 -:4', '5:4 4:2 3:2 1:4 3:4', "6:4 1':4 6:4 5:4", "3':6 2':2 1':4 7:4", '7:12 -:4'],
      },
    ],
  },

  // Bit Kingdom — chiptune.
  pixel: {
    id: 'pixel',
    bpm: 138,
    root: 60, // C4
    scale: MAJOR,
    chords: [1, 1, 4, 4, 6, 5, 4, 5],
    hit: { inst: 'square', oct: 1, vel: 1 },
    tracks: [
      { kind: 'bass', inst: 'tri', layer: 0, vol: 0.9, oct: -2, pat: 'r.r.f.r.r.r.f.o.', dur: 1 },
      { kind: 'drum', inst: 'chipkick', layer: 1, vol: 1, pat: 'x.....x...x.....' },
      { kind: 'drum', inst: 'chipsnare', layer: 1, vol: 0.9, pat: '....x.......x...' },
      { kind: 'drum', inst: 'chiphat', layer: 2, vol: 0.8, pat: 'x.x.x.x.x.x.x.x.' },
      { kind: 'arp', inst: 'pulse', layer: 2, vol: 0.55, oct: 0, every: 1, arp: [0, 2, 4, 2], dur: 1, rev: 0.05 },
      {
        kind: 'melody',
        inst: 'square',
        layer: 3,
        vol: 1,
        oct: 1,
        rev: 0.08,
        mel: [
          '1:2 3:2 5:2 1:2 3:2 5:2 6:2 5:2',
          "5:4 3:4 1:4 5,:4",
          '4:2 6:2 1:2 4:2 6:2 1:2 2:2 1:2',
          '6:6 5:2 4:4 -:4',
          '6:2 5:2 6:2 1:2 3:4 1:4',
          '5:2 4:2 3:2 2:2 5,:4 7,:4',
          '4:2 4:2 6:2 1:2 3:4 2:4',
          '2:6 3:2 2:4 -:4',
        ],
      },
    ],
  },

  // Paper Isles — music box waltz-feel lullaby.
  paper: {
    id: 'paper',
    bpm: 96,
    root: 67, // G4
    scale: MAJ_PENTA,
    chords: [1, 4, 5, 1, 1, 4, 2, 5],
    swing: 0.12,
    hit: { inst: 'musicbox', oct: 1, vel: 0.9 },
    tracks: [
      { kind: 'drone', inst: 'organ', layer: 0, vol: 0.35, oct: -1, rev: 0.4 },
      { kind: 'arp', inst: 'musicbox', layer: 1, vol: 0.55, oct: 0, every: 2, arp: [0, 2, 4, 5, 4, 2, 3, 1], rev: 0.35 },
      { kind: 'bass', inst: 'pluck', layer: 1, vol: 0.8, oct: -2, pat: 'r.......f.......', dur: 6 },
      { kind: 'drum', inst: 'rim', layer: 2, vol: 0.35, pat: '....x.......x...' },
      { kind: 'drum', inst: 'shaker', layer: 2, vol: 0.3, pat: '..x...x...x...x.' },
      {
        kind: 'melody',
        inst: 'glass',
        layer: 3,
        vol: 0.9,
        oct: 0,
        rev: 0.4,
        mel: ['3:4 4:2 3:2 2:4 1:4', '2:4 3:4 5:8', '4:4 3:4 2:4 3:4', '1:12 -:4', "5:4 1':4 5:4 4:4", '3:4 4:2 3:2 2:8', '2:4 3:4 4:4 2:4', '5,:12 -:4'],
      },
    ],
  },

  // Clayland — marimba bounce.
  clay: {
    id: 'clay',
    bpm: 112,
    root: 64, // E4
    scale: DORIAN,
    chords: [1, 4, 1, 4, 3, 4, 5, 5],
    swing: 0.18,
    hit: { inst: 'marimba', oct: 1, vel: 1 },
    tracks: [
      { kind: 'bass', inst: 'pluck', layer: 0, vol: 0.9, oct: -2, pat: 'r...f...r..r.f..', dur: 3 },
      { kind: 'arp', inst: 'marimba', layer: 1, vol: 0.55, oct: 0, every: 2, arp: [0, 2, 4, 2, 5, 4, 2, 4] },
      { kind: 'drum', inst: 'thud', layer: 1, vol: 0.8, pat: 'x.......x.......' },
      { kind: 'drum', inst: 'wood', layer: 2, vol: 0.4, pat: '....x..x....x...' },
      { kind: 'drum', inst: 'shaker', layer: 2, vol: 0.3, pat: 'x.xxx.xxx.xxx.xx' },
      { kind: 'melody', inst: 'marimba', layer: 3, vol: 0.9, oct: 1, mel: ['5:2 4:2 3:2 1:2 3:4 5:4', '4:4 6:4 4:4 -:4', '5:2 4:2 3:2 1:2 3:4 5:4', '6:4 4:4 1:4 -:4', '3:2 5:2 7:2 5:2 3:4 2:4', '4:2 6:2 1:2 6:2 4:8', '5:4 5:2 4:2 5:4 7:4', '5:12 -:4'] },
    ],
  },

  // Aquarelle — dreamy e-piano.
  water: {
    id: 'water',
    bpm: 76,
    root: 62, // D4
    scale: LYDIAN,
    chords: [1, 2, 7, 1, 1, 2, 6, 5],
    hit: { inst: 'epiano', oct: 1, vel: 0.9 },
    tracks: [
      { kind: 'drone', inst: 'pad', layer: 0, vol: 0.6, oct: -1, rev: 0.6 },
      { kind: 'chord', inst: 'epiano', layer: 1, vol: 0.35, oct: 0, pat: 'x.......o.......', dur: 7, rev: 0.4 },
      { kind: 'bass', inst: 'sub', layer: 1, vol: 0.5, oct: -2, pat: 'r...........f...', dur: 10 },
      { kind: 'arp', inst: 'glass', layer: 2, vol: 0.4, oct: 1, every: 3, arp: [0, 4, 2, 7, 4], rev: 0.5 },
      { kind: 'drum', inst: 'shaker', layer: 3, vol: 0.18, pat: '..o...o...o...o.' },
      { kind: 'melody', inst: 'epiano', layer: 3, vol: 0.9, oct: 1, rev: 0.5, mel: ['5:8 4:4 3:4', '2:12 -:4', "3:4 4:4 6:4 1':4", '7:12 -:4', '5:8 6:4 5:4', '4:12 -:4', '3:4 2:4 1:4 2:4', '3:12 -:4'] },
    ],
  },

  // Starfall — cosmic lydian shimmer.
  cosmic: {
    id: 'cosmic',
    bpm: 92,
    root: 60,
    scale: LYDIAN,
    chords: [1, 1, 2, 2, 6, 6, 5, 2],
    hit: { inst: 'glass', oct: 2, vel: 1, dly: 0.4 },
    tracks: [
      { kind: 'drone', inst: 'pad', layer: 0, vol: 0.8, oct: -1, rev: 0.7 },
      { kind: 'arp', inst: 'bell', layer: 1, vol: 0.3, oct: 1, every: 2, arp: [0, 4, 7, 11, 7, 4], dly: 0.4, rev: 0.5 },
      { kind: 'bass', inst: 'sub', layer: 1, vol: 0.55, oct: -2, pat: 'r.......r.......', dur: 7 },
      { kind: 'drum', inst: 'kick', layer: 2, vol: 0.5, pat: 'x.........x.....' },
      { kind: 'drum', inst: 'ohat', layer: 2, vol: 0.25, pat: '....x.......x...' },
      { kind: 'melody', inst: 'glass', layer: 3, vol: 0.8, oct: 1, dly: 0.35, rev: 0.5, mel: ["5:6 4:2 5:4 1':4", '7:12 -:4', '6:6 5:2 6:4 2:4', '3:12 -:4', "5:6 4:2 5:4 2':4", "1':12 -:4", '6:4 5:4 4:4 2:4', '5:12 -:4'] },
    ],
  },
};
