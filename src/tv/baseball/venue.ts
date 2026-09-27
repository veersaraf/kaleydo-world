// The ballpark: a diorama Home Run Derby park where the tennis court was (see
// field.ts for the layout), built from the world's MaterialKit like the other
// venues so each art style draws it its own way — and, from the FieldView every
// frame, the ball (spinning, drawn bigger far away, streaking when it's fast,
// with a soft shadow under it), the tracer (a TV-style ribbon along the batted
// ball's path), a star over each of this turn's home runs, and the effects:
// contact bursts, the mitt's puff, landings, the wall, fireworks for a homer.
//
// The park, from home plate out:
//   - home plate's dirt circle (the "skin") with the batter's boxes, the
//     catcher's box and the plate in chalk; a low padded backstop behind the
//     catcher (z ≈ 14.8, 0.95 m: below the batting camera's view, and low enough
//     that a camera as low as 1.7 m and as far back as 16.8 m still sees the whole
//     plate over it) with HOME RUN DERBY on it; an on-deck circle either side
//     (FIELD.onDeckX/Z).
//   - a raised mound round the rubber (FIELD.moundH, moundY() in field.ts);
//     grass between it and the plate, so a pitch is seen against the lawn.
//   - an outfield lawn with a crosshatch mown into it along the foul lines, and
//     chalk foul lines from the batter's boxes to the foul poles.
//   - the fence along fenceAt(): a padded wall FIELD.fenceH high with a
//     warning track in front, the home-run line along its top, the distances
//     painted on it (100 at the poles, 111 in the alleys, 122 in centre, from
//     realFenceAt), HOME RUN DERBY twice, bunting fans; tall foul poles with
//     screens and pennants, and a row of flag poles behind it.
// Nothing stands between the batting camera (≈ (0, 1.7–2.2, 15.8–16.8)) and the
// plate: the backstop is below its view, the on-deck circles well to the sides.
//
// The view, as the game fills it in:
//   - the ball is hidden in 'hand' and 'mitt' (the gear draws it there) and
//     'gone'; 'pitch' is any thrown ball (the pitch, the catcher's toss back),
//     'play' the batted one (it may sit still at the bat through the hitstop).
//     It's drawn up to ~2.4× (pixel: 3.2×) its size far from `eye` — but only
//     once it's away from the pitcher's hand (no jump from the gear's ball at
//     the release), and never more than ~2.5° across (a foul straight back comes
//     right past the camera). It streaks when it's fast (a pitch, a hit, not the
//     toss), the streak restarting whenever its phase changes; in flight it has
//     a ring in the hitter's colour; its shadow never shrinks under a few pixels.
//   - the tracer starts when `tracer` is on and the ball is in play (from the
//     last 'contact' effect's point), grows with the ball, stops at its first
//     'land' or 'wall', fades a little while it waits, and goes when `tracer`
//     goes off (or at the next 'contact').
//   - `marks` are this turn's home runs: a star on a stick over each, in the
//     hitter's colour; one that appears pops in. An emptier list starts afresh.
//   - fx: 'contact' (sparks, a ring, dust; `sweet` flashes), 'catch' (a puff),
//     'land' (dirt or grass on the field; confetti for a home run; a small pop
//     for a foul into the stands), 'wall' (a thump of dust off the padding),
//     'homerun' (fireworks over the stands where it went out, the home-run line
//     and the foul poles flash).
//
// Roles picked from the kit (as in the other venues):
//   'shirt'  lawn, dirt, the wall's padding and back, the chalk
//   'racket' the ball, the home-run line and foul poles, the stars (glossy)
// The glowing worlds (neon, cosmic) draw floors, chalk, accents and the wall's
// art unlit, in HDR where bloom should catch them. Static parts are merged into
// one mesh per material; the stars are instanced; the pennants are one mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit, CharRole } from '../worlds/types';
import type { FieldVenueLike } from '../worlds/base';
import { Particles, type Shape } from '../render/particles';
import { outlineTree } from '../render/outline';
import { canvasTex } from '../worlds/mats';
import { Rng } from '../core/math';
import { Inst, Flags } from '../archery/parts';
import { FIELD, fenceAt, realFenceAt, fieldPoint, sprayOf, moundY } from './field';
import type { FieldView, FieldFx, FieldBall } from './types';
import { Ribbon, Fireworks, Halo, Spot, hullMaterial, type RibbonStyle, type FireworkStyle, type Shell, type ShellKind } from './venue-parts';

// ---------------------------------------------------------------- layout (world metres)

const A = FIELD.foulAngle;
const WALL_H = FIELD.fenceH;
const HOME_Z = FIELD.homeZ;
/** the warning track: this wide in front of the wall */
const TRACK = 1.45;
/** the lawn: out to just short of the side stands, and back past the batting camera */
const LAWN = { halfX: 10.35, back: 18.9 };
/** the dirt round home plate: its centre and radius (the backstop cuts off the back of it) */
const SKIN = { z: 11.85, r: 3.3 };
/** the backstop: a low padded arc behind the catcher (radius about a centre in front of it) */
const BACKSTOP = { z: 14.8, halfX: 4.3, R: 9, h: 0.95, t: 0.25 };
/** the batter's boxes (4 × 6 ft, 6 in off the plate), the catcher's box behind them */
const BOX = { x0: 0.368, x1: 1.588, z0: 10.87, z1: 12.7 };
const CBOX = { halfX: 0.546, z1: 13.95 };
/** chalk width */
const LINE_W = 0.08;
/** home plate: 17 in across, its sides 8.5 in, the back point at FIELD.homeZ */
const PLATE = { half: 0.216, side: 0.216 };
/** the rubber (24 × 6 in) */
const RUBBER = { w: 0.61, d: 0.152 };
/** on-deck circles */
const DECK_R = 0.76;
/** the foul poles and the flag poles behind the wall (degrees off straight away) */
const POLE = { h: 9.2, r: 0.09, screen: 0.42 };
const FLAG_POLE = { h: 4.7, r: 0.04, at: [-24, -12, 0, 12, 24] };
/** floor layers (y), lowest first */
const Y = { lawn: 0.006, dirt: 0.01, chalk: 0.014, deck: 0.016, plate: 0.024 };
/** the ball's radius on screen at most (radians): a ball that comes close to the eye stops growing */
const MAX_ANG = 0.022;
/** limits */
const MAX_MARKS = 24;
const TRACER_MAX = 480;
const STREAK_N = 12;

// ---------------------------------------------------------------- per-world look

type WallStyle = 'classic' | 'glow' | 'pixel' | 'paper' | 'ink' | 'clay' | 'wash';
type LawnStyle = 'grass' | 'toon' | 'paper' | 'ink' | 'glow' | 'pixel' | 'wash';

interface Pal {
  /** the lawn's two mown shades, and how it's drawn */
  lawn: [string, string];
  lawnStyle: LawnStyle;
  /** grid lines on a glowing lawn */
  grid?: string;
  dirt: string;
  track: string;
  chalk: string;
  plateEdge: string;
  /** the wall's padding, its back and seams */
  pad: string;
  padDark: string;
  /** the home-run line along the top, the foul poles */
  line: string;
  number: string;
  /** the flag poles */
  metal: string;
  flags: string[];
  /** bunting: pleats, pleats between, the rosette */
  fan: [string, string, string];
  /** the on-deck mats: the mat, its ring and star */
  deck: [string, string];
  wall: WallStyle;
  /** fonts for the numbers and the words */
  font: string;
  words: string;
  glow: boolean;
  /** square posts (pixel, paper) */
  square: boolean;
  /** the wall's thickness */
  thick: number;
}

const FREDOKA = "Fredoka, 'Arial Rounded MT Bold', system-ui, sans-serif";

const PAL: Record<string, Pal> = {
  park: {
    lawn: ['#7ac65a', '#69b64c'],
    lawnStyle: 'grass',
    dirt: '#d39a6c',
    track: '#b87a55',
    chalk: '#ffffff',
    plateEdge: '#2b2f3a',
    pad: '#2a64b8',
    padDark: '#1b447f',
    line: '#ffd23c',
    number: '#ffffff',
    metal: '#e3e7ee',
    flags: ['#ff6b6b', '#3aa8ff', '#ffc53d', '#35d49a', '#b07cff'],
    fan: ['#ea4a44', '#ffffff', '#2a64b8'],
    deck: ['#2a64b8', '#ffffff'],
    wall: 'classic',
    font: FREDOKA,
    words: FREDOKA,
    glow: false,
    square: false,
    thick: 0.3,
  },
  plaza: {
    lawn: ['#6bd06c', '#58c05c'],
    lawnStyle: 'toon',
    dirt: '#eda669',
    track: '#d68a55',
    chalk: '#ffffff',
    plateEdge: '#231f3a',
    pad: '#2f5fd0',
    padDark: '#22449a',
    line: '#ffd23c',
    number: '#ffffff',
    metal: '#ffffff',
    flags: ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a'],
    fan: ['#ff5a6e', '#ffffff', '#2f5fd0'],
    deck: ['#ff5a6e', '#ffffff'],
    wall: 'classic',
    font: FREDOKA,
    words: FREDOKA,
    glow: false,
    square: false,
    thick: 0.3,
  },
  ink: {
    lawn: ['#ece5d4', '#d9d0bc'],
    lawnStyle: 'ink',
    dirt: '#a89a82',
    track: '#8d8170',
    chalk: '#2a2520',
    plateEdge: '#2a2520',
    pad: '#2e2822',
    padDark: '#1c1814',
    line: '#d8321f',
    number: '#f1e8d4',
    metal: '#2a2520',
    flags: ['#f1e8d4', '#d8321f'],
    fan: ['#d8321f', '#f1e8d4', '#2e2822'],
    deck: ['#2e2822', '#f1e8d4'],
    wall: 'ink',
    font: "'Kaushan Script', cursive",
    words: "'Kaushan Script', cursive",
    glow: false,
    square: false,
    thick: 0.3,
  },
  neon: {
    lawn: ['#0b041d', '#110727'],
    lawnStyle: 'glow',
    grid: '#ff2fb4',
    dirt: '#2a1147',
    track: '#1c0b36',
    chalk: '#22e6ff',
    plateEdge: '#ff2fb4',
    pad: '#150a33',
    padDark: '#0c0620',
    line: '#ffd23f',
    number: '#22e6ff',
    metal: '#ff2fb4',
    flags: ['#ff2fb4', '#22e6ff', '#ffd23f'],
    fan: ['#ff2fb4', '#22e6ff', '#ffd23f'],
    deck: ['#ff2fb4', '#22e6ff'],
    wall: 'glow',
    font: "Orbitron, 'Fredoka', sans-serif",
    words: "Orbitron, 'Fredoka', sans-serif",
    glow: true,
    square: false,
    thick: 0.3,
  },
  pixel: {
    lawn: ['#00c83c', '#00a83a'],
    lawnStyle: 'pixel',
    dirt: '#ab5236',
    track: '#8a4430',
    chalk: '#fff1e8',
    plateEdge: '#1d2b53',
    pad: '#1d2b53',
    padDark: '#11183a',
    line: '#ffec27',
    number: '#fff1e8',
    metal: '#c2c3c7',
    flags: ['#ff004d', '#ffec27', '#29adff', '#00e436'],
    fan: ['#ff004d', '#fff1e8', '#29adff'],
    deck: ['#ff004d', '#fff1e8'],
    wall: 'pixel',
    font: "'Press Start 2P', monospace",
    words: "'Press Start 2P', monospace",
    glow: false,
    square: true,
    thick: 0.3,
  },
  paper: {
    lawn: ['#a9d994', '#98cb85'],
    lawnStyle: 'paper',
    dirt: '#dcb27a',
    track: '#c99a62',
    chalk: '#fffdf5',
    plateEdge: '#3d3540',
    pad: '#3d78a8',
    padDark: '#2c5a80',
    line: '#ffd66b',
    number: '#fffdf5',
    metal: '#fffdf5',
    flags: ['#e76f51', '#ffd66b', '#5aa9e6', '#7cc576'],
    fan: ['#e76f51', '#fffdf5', '#5aa9e6'],
    deck: ['#e76f51', '#fffdf5'],
    wall: 'paper',
    font: "Gaegu, 'Fredoka', cursive",
    words: "Gaegu, 'Fredoka', cursive",
    glow: false,
    square: true,
    thick: 0.06,
  },
  clay: {
    lawn: ['#86cc70', '#76bd62'],
    lawnStyle: 'grass',
    dirt: '#dba46a',
    track: '#c0834f',
    chalk: '#fbf3e6',
    plateEdge: '#3a2e2a',
    pad: '#3f8fd8',
    padDark: '#2d6aa6',
    line: '#ffd35c',
    number: '#fbf3e6',
    metal: '#fbf3e6',
    flags: ['#ffd35c', '#e84a3c', '#3f8fd8', '#80c76b'],
    fan: ['#e84a3c', '#fbf3e6', '#3f8fd8'],
    deck: ['#e84a3c', '#fbf3e6'],
    wall: 'clay',
    font: "Chewy, 'Fredoka', cursive",
    words: "Chewy, 'Fredoka', cursive",
    glow: false,
    square: false,
    thick: 0.36,
  },
  water: {
    lawn: ['#94d378', '#84c569'],
    lawnStyle: 'wash',
    dirt: '#e9bc92',
    track: '#d7a37b',
    chalk: '#ffffff',
    plateEdge: '#3a3d5c',
    pad: '#5b8fd6',
    padDark: '#4270b0',
    line: '#ffe066',
    number: '#ffffff',
    metal: '#ffffff',
    flags: ['#ff9fb2', '#9fc4ff', '#ffe066', '#a8e6b0'],
    fan: ['#ff8fab', '#ffffff', '#7fb2ff'],
    deck: ['#ff8fab', '#ffffff'],
    wall: 'wash',
    font: FREDOKA,
    words: FREDOKA,
    glow: false,
    square: false,
    thick: 0.3,
  },
  cosmic: {
    lawn: ['#211a50', '#29215f'],
    lawnStyle: 'glow',
    grid: '#a86bff',
    dirt: '#3b2f72',
    track: '#2c245c',
    chalk: '#5ef2ff',
    plateEdge: '#a86bff',
    pad: '#1a1440',
    padDark: '#110c2c',
    line: '#ffe38a',
    number: '#5ef2ff',
    metal: '#a86bff',
    flags: ['#5ef2ff', '#ff6bd6', '#a86bff'],
    fan: ['#ff6bd6', '#e9f7ff', '#5ef2ff'],
    deck: ['#a86bff', '#5ef2ff'],
    wall: 'glow',
    font: "Orbitron, 'Fredoka', sans-serif",
    words: "Orbitron, 'Fredoka', sans-serif",
    glow: true,
    square: false,
    thick: 0.3,
  },
};

/** the ball's fine dark edge per world: colour, pixels (of 1080 rows) — none where it glows or a post pass draws edges */
const BALL_EDGE: Record<string, [string, number]> = {
  park: ['#3a3450', 1.5],
  plaza: ['#231f3a', 2.2],
  paper: ['#3d3540', 2],
  clay: ['#4a3024', 1.5],
  water: ['#3a3d5c', 1.6],
};

// ---------------------------------------------------------------- effects per world

interface FxStyle {
  /** additive particles: colours are HDR */
  hot: boolean;
  spark: Shape;
  sparks: string[];
  dust: string[];
  dustShape: Shape;
  grass: string[];
  bit: Shape;
  confetti: Shape;
  party: string[];
  puff: string[];
  /** daytime fireworks leave smoke */
  smoke: string[] | null;
  fw: FireworkStyle;
  tracer: RibbonStyle;
  /** how much of the hitter's colour the tracer's edges take (over `tracerBase`, white unless given) */
  tracerTint: number;
  tracerBase?: string;
  tracerHdr: number;
  streak: RibbonStyle;
  streakColor: string;
  streakHdr: number;
  /** the ball glows (unlit, HDR) */
  ballGlow: number;
}

const rs = (core: string, k: number, mode: number, additive: boolean, opacity: number, minPx: number, xray: number, coreW: number, coreMix: number): RibbonStyle => ({
  core: new THREE.Color(core).multiplyScalar(k),
  mode,
  additive,
  opacity,
  minPx,
  xray,
  coreW,
  coreMix,
});

const PARTY = ['#ff6b6b', '#ffc53d', '#3aa8ff', '#35d49a', '#ffffff', '#b07cff'];

const FX: Record<string, FxStyle> = {
  park: {
    hot: false,
    spark: 'star',
    sparks: ['#ffffff', '#fff27a', '#ffb13d'],
    dust: ['#ead5bb', '#dcc0a0'],
    dustShape: 'soft',
    grass: ['#5fae45', '#7cc45a'],
    bit: 'confetti',
    confetti: 'confetti',
    party: PARTY,
    puff: ['#f4efe6'],
    smoke: ['#e9e4dc', '#d8d2c8'],
    fw: { additive: false, shape: 0, colors: ['#ff2e3c', '#ffc21a', '#1f8cff', '#b44dff', '#16c96a', '#ffffff'], rocket: '#fff2c0', hdr: 1.25, steps: 0, flash: 0.45, minPx: 3.4, size: 0.26 },
    tracer: rs('#ffffff', 1.3, 0, false, 0.95, 4.2, 0.3, 0.36, 0.6),
    tracerTint: 0.9,
    tracerHdr: 1.05,
    streak: rs('#ffffff', 1, 0, false, 0.7, 1.2, 0, 0.5, 1),
    streakColor: '#eef6ff',
    streakHdr: 1,
    ballGlow: 0,
  },
  plaza: {
    hot: false,
    spark: 'star',
    sparks: ['#ffffff', '#fff27a', '#ffb13d'],
    dust: ['#fbe3c4', '#f0cfa6'],
    dustShape: 'soft',
    grass: ['#58c05c', '#7fd67a'],
    bit: 'confetti',
    confetti: 'confetti',
    party: ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a', '#ffffff'],
    puff: ['#ffffff'],
    smoke: ['#f2f2f6', '#e2e2ea'],
    fw: { additive: false, shape: 0, colors: ['#ff2e55', '#ffc21a', '#1f8cff', '#16c96a', '#ffffff'], rocket: '#fff2c0', hdr: 1.2, steps: 0, flash: 0.45, minPx: 3.6, size: 0.27 },
    tracer: rs('#ffffff', 1.15, 3, false, 1, 4.4, 0.3, 0.32, 0.75),
    tracerTint: 1,
    tracerHdr: 1,
    streak: rs('#ffffff', 1, 3, false, 0.85, 1.3, 0, 0.5, 1),
    streakColor: '#dff2ff',
    streakHdr: 1,
    ballGlow: 0,
  },
  ink: {
    hot: false,
    spark: 'ink',
    sparks: ['#15120f', '#3b342d'],
    dust: ['#3b342d', '#6a6155'],
    dustShape: 'ink',
    grass: ['#15120f'],
    bit: 'ink',
    confetti: 'petal',
    party: ['#d8321f', '#15120f', '#d8321f', '#f1e8d4'],
    puff: ['#3b342d'],
    smoke: null,
    fw: { additive: false, shape: 2, colors: ['#d8321f', '#15120f', '#d8321f', '#3b342d'], rocket: '#15120f', hdr: 1, steps: 0, flash: 0, minPx: 4.5, size: 0.3 },
    tracer: rs('#d8321f', 1, 1, false, 0.95, 4.6, 0.25, 0.3, 1),
    tracerTint: 0,
    tracerBase: '#d8321f',
    tracerHdr: 1,
    streak: rs('#15120f', 1, 1, false, 0.75, 1.4, 0, 0.3, 1),
    streakColor: '#2a2520',
    streakHdr: 1,
    ballGlow: 0,
  },
  neon: {
    hot: true,
    spark: 'soft',
    sparks: ['#ffd23f', '#ff2fb4', '#22e6ff'],
    dust: ['#22e6ff', '#8b3bff'],
    dustShape: 'soft',
    grass: ['#ff2fb4', '#22e6ff'],
    bit: 'soft',
    confetti: 'star',
    party: ['#ff2fb4', '#22e6ff', '#ffd23f', '#8b3bff'],
    puff: ['#22e6ff'],
    smoke: null,
    fw: { additive: true, shape: 0, colors: ['#ff2fb4', '#22e6ff', '#ffd23f', '#8b3bff', '#ffffff'], rocket: '#ffd6f5', hdr: 2.2, steps: 0, flash: 0.4, minPx: 3, size: 0.17 },
    tracer: rs('#ffffff', 1.5, 0, true, 1, 3.8, 0.35, 0.3, 0.3),
    tracerTint: 1,
    tracerHdr: 1.7,
    streak: rs('#ffffff', 2.4, 0, true, 0.9, 1.4, 0, 0.5, 1),
    streakColor: '#ff2fb4',
    streakHdr: 2.2,
    ballGlow: 2.6,
  },
  pixel: {
    hot: false,
    spark: 'square',
    sparks: ['#ffec27', '#fff1e8', '#ffa300'],
    dust: ['#c2c3c7', '#fff1e8'],
    dustShape: 'square',
    grass: ['#00e436', '#008751'],
    bit: 'square',
    confetti: 'square',
    party: ['#ff004d', '#ffec27', '#29adff', '#00e436', '#ff77a8', '#fff1e8'],
    puff: ['#fff1e8'],
    smoke: null,
    fw: { additive: false, shape: 1, colors: ['#ff004d', '#ffec27', '#29adff', '#00e436', '#ff77a8', '#fff1e8'], rocket: '#ffec27', hdr: 1, steps: 12, flash: 0, minPx: 5, size: 0.26 },
    tracer: rs('#fff1e8', 1, 2, false, 1, 6.5, 0.4, 0.22, 0.5),
    tracerTint: 1,
    tracerHdr: 1,
    streak: rs('#fff1e8', 1, 2, false, 1, 3, 0, 0.5, 1),
    streakColor: '#fff1e8',
    streakHdr: 1,
    ballGlow: 0,
  },
  paper: {
    hot: false,
    spark: 'confetti',
    sparks: ['#ffe066', '#ffffff', '#ffd1dc'],
    dust: ['#f4ecd8', '#e8d8b8'],
    dustShape: 'soft',
    grass: ['#7cc576', '#a9d994'],
    bit: 'confetti',
    confetti: 'confetti',
    party: ['#e76f51', '#ffd66b', '#5aa9e6', '#7cc576', '#fffdf5'],
    puff: ['#fffdf5'],
    smoke: null,
    fw: { additive: false, shape: 3, colors: ['#e76f51', '#ffd66b', '#5aa9e6', '#7cc576', '#fffdf5', '#c490e4'], rocket: '#fffdf5', hdr: 1, steps: 0, flash: 0, minPx: 4.5, size: 0.28 },
    tracer: rs('#fffdf5', 1, 3, false, 1, 4.4, 0.3, 0.3, 1),
    tracerTint: 1,
    tracerHdr: 1,
    streak: rs('#fffdf5', 1, 3, false, 0.9, 1.3, 0, 0.5, 1),
    streakColor: '#fffdf5',
    streakHdr: 1,
    ballGlow: 0,
  },
  clay: {
    hot: false,
    spark: 'soft',
    sparks: ['#ffe98a', '#ffffff', '#ffb35a'],
    dust: ['#ecd3b0', '#dcb88c'],
    dustShape: 'soft',
    grass: ['#6cbf5f', '#86cc70'],
    bit: 'soft',
    confetti: 'soft',
    party: ['#ffd35c', '#e84a3c', '#3f8fd8', '#80c76b', '#fbf3e6'],
    puff: ['#fbf3e6'],
    smoke: ['#efe6d8'],
    fw: { additive: false, shape: 0, colors: ['#ff3b2e', '#ffc21a', '#2f7fe0', '#3fbf4f', '#ffffff'], rocket: '#fff2c0', hdr: 1.2, steps: 0, flash: 0.35, minPx: 3.6, size: 0.27 },
    tracer: rs('#ffffff', 1.1, 0, false, 0.95, 4.2, 0.28, 0.38, 0.55),
    tracerTint: 0.9,
    tracerHdr: 1,
    streak: rs('#ffffff', 1, 0, false, 0.7, 1.3, 0, 0.5, 1),
    streakColor: '#fff8ea',
    streakHdr: 1,
    ballGlow: 0,
  },
  water: {
    hot: false,
    spark: 'soft',
    sparks: ['#fff2b3', '#ffd6e7', '#ffffff'],
    dust: ['#f6e6d2', '#ead0b4'],
    dustShape: 'soft',
    grass: ['#8fcf72', '#b5e39c'],
    bit: 'petal',
    confetti: 'petal',
    party: ['#ff9fb2', '#9fc4ff', '#ffe066', '#a8e6b0', '#ffffff'],
    puff: ['#ffffff'],
    smoke: ['#f4f0ff'],
    fw: { additive: false, shape: 0, colors: ['#ff5c8a', '#4f8dff', '#ffc933', '#3fcf7a', '#ffffff'], rocket: '#fff6d8', hdr: 1.1, steps: 0, flash: 0.25, minPx: 4.5, size: 0.3 },
    tracer: rs('#ffffff', 1, 0, false, 0.92, 5, 0.3, 0.4, 0.5),
    tracerTint: 0.85,
    tracerHdr: 1,
    streak: rs('#ffffff', 1, 0, false, 0.65, 1.5, 0, 0.5, 1),
    streakColor: '#ffffff',
    streakHdr: 1,
    ballGlow: 0,
  },
  cosmic: {
    hot: true,
    spark: 'star',
    sparks: ['#5ef2ff', '#ffffff', '#ff6bd6'],
    dust: ['#a86bff', '#5ef2ff'],
    dustShape: 'soft',
    grass: ['#5ef2ff', '#a86bff'],
    bit: 'star',
    confetti: 'star',
    party: ['#5ef2ff', '#ff6bd6', '#a86bff', '#ffe38a', '#ffffff'],
    puff: ['#a86bff'],
    smoke: null,
    fw: { additive: true, shape: 0, colors: ['#5ef2ff', '#ff6bd6', '#a86bff', '#ffe38a', '#ffffff'], rocket: '#e9f7ff', hdr: 2.1, steps: 0, flash: 0.4, minPx: 3, size: 0.17 },
    tracer: rs('#ffffff', 1.5, 0, true, 1, 3.8, 0.35, 0.3, 0.3),
    tracerTint: 1,
    tracerHdr: 1.7,
    streak: rs('#e9f7ff', 2.2, 0, true, 0.85, 1.4, 0, 0.5, 1),
    streakColor: '#5ef2ff',
    streakHdr: 2,
    ballGlow: 2.2,
  },
};

// ---------------------------------------------------------------- the fence's line

interface FencePt {
  a: number;
  x: number;
  z: number;
  /** outward (away from home) unit normal */
  nx: number;
  nz: number;
  /** arc length from the left foul pole */
  s: number;
}

/** The wall's inner face along fenceAt(), from the left pole (a = −A) to the right, with arc lengths. */
function fenceLine(n: number): FencePt[] {
  const pts: FencePt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -A + (2 * A * i) / n;
    const p = fieldPoint(a, fenceAt(a));
    pts.push({ a, x: p.x, z: p.z, nx: 0, nz: 0, s: 0 });
  }
  for (let i = 0; i <= n; i++) {
    const p = pts[i],
      q = pts[Math.max(0, i - 1)],
      r = pts[Math.min(n, i + 1)];
    let tx = r.x - q.x,
      tz = r.z - q.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    // the tangent runs left to right (+x at centre): outward is (tz, −tx)
    p.nx = tz;
    p.nz = -tx;
    if (i > 0) p.s = pts[i - 1].s + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
  }
  return pts;
}

/** The arc length along the fence at spray angle `a` (the list from fenceLine). */
function arcAt(pts: FencePt[], a: number) {
  const n = pts.length - 1;
  const f = THREE.MathUtils.clamp(((a + A) / (2 * A)) * n, 0, n);
  const i = Math.min(n - 1, Math.floor(f));
  return THREE.MathUtils.lerp(pts[i].s, pts[i + 1].s, f - i);
}

/** z of the backstop's face at x */
function backstopZ(x: number) {
  const c = BACKSTOP.z - BACKSTOP.R;
  return c + Math.sqrt(Math.max(0, BACKSTOP.R * BACKSTOP.R - x * x));
}

// ---------------------------------------------------------------- textures

/** The lawn: a 2 × 2 crosshatch of mown shades (mapped along the foul lines), with each style's grain. */
function lawnTexture(pal: Pal) {
  const [a, b] = pal.lawn;
  const style = pal.lawnStyle;
  const pixel = style === 'pixel';
  const S = pixel ? 16 : 256;
  const h = S / 2;
  const rng = new Rng(7);
  const t = canvasTex(S, S, (x) => {
    x.fillStyle = a;
    x.fillRect(0, 0, S, S);
    x.fillStyle = b;
    x.fillRect(h, 0, h, h);
    x.fillRect(0, h, h, h);
    if (pixel || style === 'toon') return;
    if (style === 'glow') {
      // a faint grid along the cell edges (a synthwave field)
      x.strokeStyle = pal.grid!;
      x.globalAlpha = 0.34;
      x.lineWidth = 3;
      for (const k of [0, h, S]) {
        x.beginPath();
        x.moveTo(k, 0);
        x.lineTo(k, S);
        x.moveTo(0, k);
        x.lineTo(S, k);
        x.stroke();
      }
      x.globalAlpha = 1;
      for (let i = 0; i < 60; i++) {
        x.fillStyle = `rgba(255,255,255,${0.04 + rng.next() * 0.1})`;
        x.fillRect(rng.next() * S, rng.next() * S, 1.5, 1.5);
      }
      return;
    }
    if (style === 'ink') {
      // raked lines along one diagonal of the hatch
      x.strokeStyle = 'rgba(60,50,40,0.22)';
      x.lineWidth = 2;
      for (let i = 6; i < S; i += 16) {
        x.beginPath();
        x.moveTo(i, 0);
        x.lineTo(i + (rng.next() - 0.5) * 3, S);
        x.stroke();
      }
      return;
    }
    // blades and specks
    const n = style === 'paper' ? 2400 : 3200;
    for (let i = 0; i < n; i++) {
      const light = rng.next() < 0.5;
      x.fillStyle = light ? `rgba(255,255,255,${0.03 + rng.next() * 0.05})` : `rgba(0,40,0,${0.03 + rng.next() * 0.06})`;
      if (style === 'paper') x.fillRect(rng.next() * S, rng.next() * S, 1, 1);
      else x.fillRect(rng.next() * S, rng.next() * S, 1.2, 2.6);
    }
    if (style === 'paper' || style === 'wash') {
      // paper fibres / a watercolour bloom
      x.strokeStyle = style === 'paper' ? 'rgba(120,110,80,0.10)' : 'rgba(255,255,255,0.06)';
      for (let i = 0; i < 90; i++) {
        x.lineWidth = 0.6 + rng.next();
        const px = rng.next() * S,
          py = rng.next() * S;
        x.beginPath();
        x.moveTo(px, py);
        x.quadraticCurveTo(px + (rng.next() - 0.5) * 20, py + (rng.next() - 0.5) * 20, px + (rng.next() - 0.5) * 34, py + (rng.next() - 0.5) * 34);
        x.stroke();
      }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (pixel) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapNearestFilter;
  }
  return t;
}

/** Dirt, near-white so it modulates the vertex colours (infield, track): specks, pebbles, a soft mottle. */
function dirtTexture(pal: Pal) {
  const rng = new Rng(11);
  const pixel = pal.lawnStyle === 'pixel';
  const S = pixel ? 32 : 256;
  const t = canvasTex(S, S, (x) => {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, S, S);
    if (pixel) {
      for (let i = 0; i < 18; i++) {
        x.fillStyle = rng.next() < 0.5 ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,1)';
        x.fillRect(Math.floor(rng.next() * S), Math.floor(rng.next() * S), 1, 1);
      }
      return;
    }
    if (pal.lawnStyle === 'toon' || pal.glow) {
      for (let i = 0; i < 120; i++) {
        x.fillStyle = `rgba(${rng.next() < 0.5 ? '255,255,255' : '60,30,10'},${0.08 + rng.next() * 0.1})`;
        const r = 1 + rng.next() * 2;
        x.beginPath();
        x.arc(rng.next() * S, rng.next() * S, r, 0, Math.PI * 2);
        x.fill();
      }
      return;
    }
    // a soft mottle
    for (let i = 0; i < 40; i++) {
      const g = x.createRadialGradient(0, 0, 0, 0, 0, 30);
      const d = rng.next() < 0.5;
      g.addColorStop(0, d ? 'rgba(90,50,20,0.06)' : 'rgba(255,255,255,0.08)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.save();
      x.translate(rng.next() * S, rng.next() * S);
      x.fillStyle = g;
      x.fillRect(-30, -30, 60, 60);
      x.restore();
    }
    // specks and pebbles
    for (let i = 0; i < 2600; i++) {
      const dark = rng.next() < 0.55;
      x.fillStyle = dark ? `rgba(70,35,15,${0.06 + rng.next() * 0.12})` : `rgba(255,250,240,${0.1 + rng.next() * 0.25})`;
      const r = rng.next() < 0.03 ? 1.4 + rng.next() * 1.4 : 0.5 + rng.next() * 0.7;
      x.fillRect(rng.next() * S, rng.next() * S, r, r);
    }
    if (pal.lawnStyle === 'ink') {
      // brushed
      x.strokeStyle = 'rgba(40,30,20,0.12)';
      for (let i = 0; i < 40; i++) {
        x.lineWidth = 1 + rng.next() * 2;
        const px = rng.next() * S,
          py = rng.next() * S;
        x.beginPath();
        x.moveTo(px, py);
        x.lineTo(px + 20 + rng.next() * 30, py + (rng.next() - 0.5) * 6);
        x.stroke();
      }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (pixel) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapNearestFilter;
  }
  return t;
}

/** The baseball: white leather, the seam's curve in red double stitching (equirectangular). */
function ballTexture(world: string) {
  const W = 512,
    H = 256;
  const rng = new Rng(3);
  const glow = world === 'neon' || world === 'cosmic';
  const seam = world === 'neon' ? '#ff2fb4' : world === 'cosmic' ? '#ff6bd6' : world === 'pixel' ? '#ff004d' : '#d8322a';
  return canvasTex(W, H, (x) => {
    x.fillStyle = glow ? '#ffffff' : '#fbf8f0';
    x.fillRect(0, 0, W, H);
    if (!glow && world !== 'pixel') {
      for (let i = 0; i < 1600; i++) {
        x.fillStyle = `rgba(${rng.next() < 0.5 ? '255,255,255' : '150,130,110'},${rng.next() * 0.07})`;
        x.fillRect(rng.next() * W, rng.next() * H, 2, 2);
      }
    }
    // the seam: the same two-lobed curve as a tennis ball's
    const a = 0.75,
      b = 0.25,
      cc = 2 * Math.sqrt(a * b);
    const pts: [number, number, number, number][] = [];
    for (let i = 0; i <= 720; i++) {
      const t = (i / 720) * Math.PI * 2;
      const px = a * Math.cos(t) + b * Math.cos(3 * t);
      const py = a * Math.sin(t) - b * Math.sin(3 * t);
      const pz = cc * Math.sin(2 * t);
      const lon = Math.atan2(py, px);
      const lat = Math.asin(Math.max(-1, Math.min(1, pz)));
      pts.push([((lon / (Math.PI * 2) + 1) % 1) * W, (0.5 - lat / Math.PI) * H, t, 1 / Math.max(0.2, Math.cos(lat))]);
    }
    const stroke = (w: number, col: string, off: number) => {
      x.strokeStyle = col;
      x.lineWidth = w;
      x.lineCap = 'round';
      for (let i = 1; i < pts.length; i++) {
        const [u0, v0] = pts[i - 1],
          [u1, v1] = pts[i];
        if (Math.abs(u1 - u0) > 100) continue;
        const dx = u1 - u0,
          dy = v1 - v0;
        const l = Math.hypot(dx, dy) || 1;
        const ox = (-dy / l) * off,
          oy = (dx / l) * off;
        x.beginPath();
        x.moveTo(u0 + ox, v0 + oy);
        x.lineTo(u1 + ox, v1 + oy);
        x.stroke();
      }
    };
    if (world === 'pixel') {
      stroke(9, seam, 0);
      return;
    }
    // the seam's groove, then the red stitches either side of it
    stroke(4, glow ? '#ffd6ee' : 'rgba(120,100,80,0.45)', 0);
    for (const side of [-1, 1]) stroke(5, seam, side * 5.5);
    // V stitches across the seam
    x.strokeStyle = seam;
    x.lineWidth = 2.4;
    for (let i = 0; i < pts.length; i += 9) {
      const [u0, v0] = pts[i];
      const [u1, v1] = pts[Math.min(pts.length - 1, i + 2)];
      if (Math.abs(u1 - u0) > 100) continue;
      const dx = u1 - u0,
        dy = v1 - v0;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l,
        ny = dx / l;
      x.beginPath();
      x.moveTo(u0 - nx * 9 - (dx / l) * 3, v0 - ny * 9 - (dy / l) * 3);
      x.lineTo(u0, v0);
      x.lineTo(u0 + nx * 9 - (dx / l) * 3, v0 + ny * 9 - (dy / l) * 3);
      x.stroke();
    }
  });
}

// ---------------------------------------------------------------- the painted art (one atlas)
//
// The wall's face along its whole length, the backstop's face, and the two
// on-deck mats share one canvas: one material, merged into one mesh.

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WallItem {
  /** arc length along the wall (m) */
  s: number;
  kind: 'number' | 'words' | 'fan';
  label?: string;
  /** words: the room they have (m) before they go onto two lines */
  room?: number;
}

/** lettering heights (m) per wall style: the numbers, the words, the words on the backstop (big and bold where a post pass smears detail) */
const SIZES: Record<WallStyle, { number: number; words: number; back: number }> = {
  classic: { number: 0.92, words: 0.6, back: 0.38 },
  glow: { number: 0.92, words: 0.56, back: 0.36 },
  pixel: { number: 0.86, words: 0.5, back: 0.34 },
  paper: { number: 0.94, words: 0.62, back: 0.4 },
  ink: { number: 0.96, words: 0.62, back: 0.4 },
  clay: { number: 0.96, words: 0.62, back: 0.4 },
  wash: { number: 1.12, words: 0.84, back: 0.5 },
};

interface Atlas {
  canvas: HTMLCanvasElement;
  ppm: number;
  wall: Rect;
  back: Rect;
  deck: Rect;
}

function atlasLayout(wallLen: number, backLen: number, pixel: boolean): Atlas {
  const ppm = pixel ? 24 : 100;
  const pad = pixel ? 2 : 8;
  const wall = { x: 0, y: 0, w: Math.ceil(wallLen * ppm), h: Math.ceil(WALL_H * ppm) };
  const back = { x: 0, y: wall.h + pad, w: Math.ceil(backLen * ppm), h: Math.ceil(BACKSTOP.h * ppm) };
  const ds = Math.ceil(DECK_R * 2 * ppm);
  const deck = { x: back.w + pad, y: back.y, w: ds, h: ds };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(wall.w, deck.x + deck.w);
  canvas.height = Math.max(back.y + back.h, deck.y + deck.h);
  return { canvas, ppm, wall, back, deck };
}

const hex = (c: THREE.Color) => `#${c.getHexString()}`;
const shade = (css: string, k: number) => hex(new THREE.Color(css).multiplyScalar(k));
const mixCss = (a: string, b: string, t: number) => hex(new THREE.Color(a).lerp(new THREE.Color(b), t));

/** Paint the atlas in the world's style (again once the fonts have loaded). */
function paintAtlas(at: Atlas, pal: Pal, items: WallItem[]) {
  const x = at.canvas.getContext('2d')!;
  const style = pal.wall;
  const ppm = at.ppm;
  const pixel = style === 'pixel';
  const glow = style === 'glow';
  x.imageSmoothingEnabled = !pixel;
  x.clearRect(0, 0, at.canvas.width, at.canvas.height);
  const rng = new Rng(29);

  /** padding: panels, shading, grime at the foot, the home-run line along the top */
  const padding = (r: Rect, topLine: boolean, seamEvery: number) => {
    x.save();
    x.beginPath();
    x.rect(r.x, r.y, r.w, r.h);
    x.clip();
    const pad = glow ? shade(pal.pad, 0.55) : pal.pad;
    x.fillStyle = pad;
    x.fillRect(r.x, r.y, r.w, r.h);
    const band = topLine ? Math.round(0.11 * ppm) : 0;
    if (!pixel && !glow) {
      // light from above on the rounded padding, darker to the foot
      const g = x.createLinearGradient(0, r.y, 0, r.y + r.h);
      g.addColorStop(0, 'rgba(255,255,255,0.13)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.03)');
      g.addColorStop(0.8, 'rgba(0,0,0,0.06)');
      g.addColorStop(1, 'rgba(0,0,0,0.2)');
      x.fillStyle = g;
      x.fillRect(r.x, r.y, r.w, r.h);
    }
    // panel seams
    const seam = Math.max(1, Math.round((pixel ? 1 : 0.025) * ppm));
    for (let s = seamEvery; s < r.w / ppm; s += seamEvery) {
      const px = Math.round(r.x + s * ppm);
      if (glow) {
        x.fillStyle = hex(new THREE.Color(pal.line).multiplyScalar(0.18));
        x.fillRect(px, r.y + band, 2, r.h - band);
        continue;
      }
      x.fillStyle = shade(pal.pad, 0.62);
      x.fillRect(px - seam / 2, r.y + band, seam, r.h - band);
      if (!pixel) {
        x.fillStyle = 'rgba(255,255,255,0.12)';
        x.fillRect(px + seam / 2, r.y + band, Math.max(1, seam * 0.6), r.h - band);
      }
    }
    if (style === 'ink') {
      // dry-brush strokes along the wall
      for (let i = 0; i < (r.w * r.h) / 900; i++) {
        x.strokeStyle = `rgba(${rng.next() < 0.5 ? '0,0,0' : '90,80,70'},${0.05 + rng.next() * 0.1})`;
        x.lineWidth = 2 + rng.next() * 6;
        const px = r.x + rng.next() * r.w,
          py = r.y + rng.next() * r.h;
        x.beginPath();
        x.moveTo(px, py);
        x.lineTo(px + 40 + rng.next() * 120, py + (rng.next() - 0.5) * 6);
        x.stroke();
      }
    }
    if (!pixel && !glow && style !== 'ink') {
      // warning-track dust kicked up the foot of the wall
      const g = x.createLinearGradient(0, r.y + r.h, 0, r.y + r.h - 0.35 * ppm);
      g.addColorStop(0, hex(new THREE.Color(pal.track).multiplyScalar(0.85)));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.globalAlpha = 0.45;
      x.fillStyle = g;
      x.fillRect(r.x, r.y + r.h - 0.35 * ppm, r.w, 0.35 * ppm);
      x.globalAlpha = 1;
    }
    if (topLine) {
      // the home-run line
      if (glow) {
        tube(r.x, r.y + band * 0.5, r.x + r.w, r.y + band * 0.5, pal.line, band * 0.45);
        tube(r.x, r.y + r.h - 3, r.x + r.w, r.y + r.h - 3, pal.metal, 3);
      } else {
        x.fillStyle = pal.line;
        x.fillRect(r.x, r.y, r.w, band);
        if (!pixel) {
          x.fillStyle = 'rgba(0,0,0,0.25)';
          x.fillRect(r.x, r.y + band, r.w, Math.max(1, 0.012 * ppm));
          x.fillStyle = 'rgba(255,255,255,0.35)';
          x.fillRect(r.x, r.y, r.w, Math.max(1, 0.015 * ppm));
        }
      }
    }
    if (style === 'paper' || style === 'clay' || style === 'wash') grain(r, style === 'paper' ? 14 : 8);
    x.restore();
  };

  /** a glowing tube: a wide dim halo under a bright core */
  const tube = (x0: number, y0: number, x1: number, y1: number, col: string, w: number) => {
    x.lineCap = 'round';
    x.strokeStyle = hex(new THREE.Color(col).multiplyScalar(0.35));
    x.lineWidth = w * 2.6;
    x.beginPath();
    x.moveTo(x0, y0);
    x.lineTo(x1, y1);
    x.stroke();
    x.strokeStyle = col;
    x.lineWidth = w;
    x.stroke();
  };

  const grain = (r: Rect, amp: number) => {
    const img = x.getImageData(r.x, r.y, r.w, r.h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng.next() - 0.5) * amp;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
    x.putImageData(img, r.x, r.y);
  };

  /** text in the style: filled with a dark edge, a paper cut-out with a shadow, or a neon tube */
  // the watercolour's fattened glyphs need air between them
  const spacing = (px: number) => (style === 'wash' ? `${Math.round(px * 0.09)}px` : '0px');
  const text = (s: string, cx: number, base: number, px: number, font: string, col: string, align: CanvasTextAlign = 'center') => {
    x.font = `${pixel ? '' : '700 '}${Math.round(px)}px ${font}`;
    x.letterSpacing = spacing(px);
    x.textAlign = align;
    x.textBaseline = 'alphabetic';
    if (glow) {
      x.lineJoin = 'round';
      x.strokeStyle = hex(new THREE.Color(col).multiplyScalar(0.3));
      x.lineWidth = px * 0.16;
      x.strokeText(s, cx, base);
      x.strokeStyle = col;
      x.lineWidth = px * 0.055;
      x.strokeText(s, cx, base);
      return;
    }
    if (pixel) {
      x.fillStyle = pal.padDark;
      x.fillText(s, cx + Math.max(1, Math.round(px / 8)), base + Math.max(1, Math.round(px / 8)));
      x.fillStyle = col;
      x.fillText(s, cx, base);
      return;
    }
    if (style === 'paper' || style === 'clay') {
      // cut out and stuck on: a soft shadow under it
      x.fillStyle = 'rgba(0,0,0,0.28)';
      x.fillText(s, cx + px * 0.04, base + px * 0.05);
      x.fillStyle = col;
      x.fillText(s, cx, base);
      return;
    }
    if (style === 'wash') {
      // the watercolour pass eats anything thin (an outline, a narrow stroke): fat glyphs, two tones
      x.lineJoin = 'round';
      x.strokeStyle = col;
      x.lineWidth = px * 0.17;
      x.strokeText(s, cx, base);
      x.fillStyle = col;
      x.fillText(s, cx, base);
      return;
    }
    x.lineJoin = 'round';
    x.strokeStyle = style === 'ink' ? 'rgba(0,0,0,0.5)' : pal.padDark;
    x.lineWidth = px * 0.09;
    x.strokeText(s, cx, base);
    x.fillStyle = col;
    x.fillText(s, cx, base);
  };

  const star = (cx: number, cy: number, R: number, col: string) => {
    x.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? R * 0.45 : R;
      const px = cx + Math.cos(a) * r,
        py = cy + Math.sin(a) * r;
      if (i === 0) x.moveTo(px, py);
      else x.lineTo(px, py);
    }
    x.closePath();
    if (glow) {
      x.strokeStyle = col;
      x.lineWidth = Math.max(2, R * 0.16);
      x.lineJoin = 'round';
      x.stroke();
      return;
    }
    x.fillStyle = col;
    x.fill();
  };

  /** a bunting fan hanging from the top: pleats, a rosette, a scalloped hem */
  const fan = (cx: number, top: number, R: number) => {
    const [c0, c1, c2] = pal.fan;
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI,
        a1 = ((i + 1) / n) * Math.PI;
      x.beginPath();
      x.moveTo(cx, top);
      x.arc(cx, top, R, a0, a1);
      x.closePath();
      if (glow) {
        x.strokeStyle = i % 2 ? c1 : c0;
        x.lineWidth = 3;
        x.stroke();
        continue;
      }
      x.fillStyle = i % 2 ? c1 : c0;
      x.fill();
      if (!pixel) {
        // each pleat darker at its fold
        const g = x.createLinearGradient(cx + Math.cos(a0) * R, top + Math.sin(a0) * R, cx + Math.cos(a1) * R, top + Math.sin(a1) * R);
        g.addColorStop(0, 'rgba(0,0,0,0.16)');
        g.addColorStop(0.5, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(255,255,255,0.1)');
        x.fillStyle = g;
        x.fill();
      }
    }
    // the rosette at the top, with a star
    x.beginPath();
    x.arc(cx, top, R * 0.34, 0, Math.PI);
    x.closePath();
    if (glow) {
      x.strokeStyle = c2;
      x.lineWidth = 3;
      x.stroke();
    } else {
      x.fillStyle = c2;
      x.fill();
    }
    star(cx, top + R * 0.15, R * 0.12, glow ? c1 : '#ffffff');
  };

  const weight = pixel ? '' : '700 ';
  const measure = (s: string, px: number, font: string) => {
    x.font = `${weight}${Math.round(px)}px ${font}`;
    x.letterSpacing = spacing(px);
    return x.measureText(s).width;
  };
  /** words centred on (cx, cy), on one line or — when they're wider than maxW — two, with a star either side */
  const words = (s: string, cx: number, cy: number, px: number, maxW: number) => {
    let lines = [s];
    let size = px;
    // the stars either side take their share of the room
    const starR = (sz: number) => Math.min(sz * 0.36, 0.2 * ppm);
    if (measure(s, size, pal.words) + 5.4 * starR(size) > maxW) {
      const cut = s.lastIndexOf(' ');
      lines = [s.slice(0, cut), s.slice(cut + 1)];
      const widest = Math.max(...lines.map((l) => measure(l, px, pal.words)));
      // two lines: a little smaller (the same size where a post pass needs the weight), as wide as the room allows
      size = Math.min(px * (style === 'wash' ? 1 : 0.85), (px * (maxW - 5.4 * starR(px))) / widest);
    }
    const lh = size * 1.08;
    const tw = Math.max(...lines.map((l) => measure(l, size, pal.words)));
    lines.forEach((l, i) => text(l, cx, cy + (i - (lines.length - 1) / 2) * lh + size * 0.36, size, pal.words, pal.number));
    const sr = starR(size);
    for (const sx of [-1, 1]) star(cx + sx * (tw / 2 + sr * 1.7), cy, sr, pal.line);
  };

  // ---- the outfield wall
  const w = at.wall;
  padding(w, true, 1.6);
  const band = 0.11 * ppm;
  const S = SIZES[style];
  const mid = w.y + band + (WALL_H - 0.11) * ppm * 0.5;
  for (const it of items) {
    const cx = w.x + it.s * ppm;
    if (it.kind === 'number') {
      const px = S.number * ppm;
      const base = mid + px * 0.36;
      // the number, and a small "m" beside it
      const wNum = measure(it.label!, px, pal.font);
      const mPx = px * 0.36;
      const wM = measure('m', mPx, pal.font);
      const gap = px * 0.06;
      const left = cx - (wNum + gap + wM) / 2;
      text(it.label!, left, base, px, pal.font, pal.number, 'left');
      text('m', left + wNum + gap, base, mPx, pal.font, pal.number, 'left');
    } else if (it.kind === 'words') words(it.label!, cx, mid, S.words * ppm, (it.room ?? 4) * ppm);
    else fan(cx, w.y + band + 1, 0.8 * ppm);
  }

  // ---- the backstop: padding with HOME RUN DERBY across it
  const b = at.back;
  padding(b, false, 1.5);
  words('HOME RUN DERBY', b.x + b.w / 2, b.y + b.h * 0.5, S.back * ppm, b.w * 0.7);

  // ---- the on-deck mat: a ring and a star
  const d = at.deck;
  {
    const cx = d.x + d.w / 2,
      cy = d.y + d.h / 2,
      R = d.w / 2;
    x.save();
    x.beginPath();
    x.arc(cx, cy, R, 0, Math.PI * 2);
    x.fillStyle = glow ? shade(pal.deck[0], 0.25) : pal.deck[0];
    x.fill();
    x.lineWidth = Math.max(2, R * 0.1);
    x.strokeStyle = pal.deck[1];
    x.beginPath();
    x.arc(cx, cy, R * 0.8, 0, Math.PI * 2);
    x.stroke();
    star(cx, cy + R * 0.05, R * 0.45, pal.deck[1]);
    x.restore();
  }
}

// ---------------------------------------------------------------- geometry helpers

/** A flat polygon (world x, z) at height y, facing up; uvs = world x, −z over `per` metres. */
function flatPoly(pts: [number, number][], y: number, per = 1, holes: [number, number][][] = []) {
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ShapeGeometry(shape, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / per, -p.getZ(i) / per);
  return g;
}

function circlePts(cx: number, cz: number, r: number, n: number, a0 = 0, a1 = Math.PI * 2): [number, number][] {
  const out: [number, number][] = [];
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
  const m = full ? n : n + 1;
  for (let i = 0; i < m; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/** A chalk stripe from (x0, z0) to (x1, z1), w wide, at height y. */
function stripe(x0: number, z0: number, x1: number, z1: number, w: number, y: number) {
  const dx = x1 - x0,
    dz = z1 - z0;
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (w / 2),
    nz = (dx / l) * (w / 2);
  return flatPoly(
    [
      [x0 + nx, z0 + nz],
      [x1 + nx, z1 + nz],
      [x1 - nx, z1 - nz],
      [x0 - nx, z0 - nz],
    ],
    y,
  );
}

/** Give every vertex of `g` this colour (for the vertex-coloured merged materials). */
function paint(g: THREE.BufferGeometry, css: string | THREE.Color) {
  const c = typeof css === 'string' ? new THREE.Color(css) : css;
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Strip the attributes a merge doesn't want mixed (uv on uv-less materials etc.): keep these. */
function only(g: THREE.BufferGeometry, keep: string[]) {
  for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
  return g;
}

/** A vertical strip along points (x, z) from y0 to y1, facing (fx, fz) side of each point's normal. */
function band(pts: { x: number; z: number; nx: number; nz: number }[], y0: number, y1: number, off: number, facing: 1 | -1, uv?: (i: number, top: boolean) => [number, number]) {
  const pos: number[] = [],
    nrm: number[] = [],
    uvs: number[] = [],
    idx: number[] = [];
  pts.forEach((p, i) => {
    const x = p.x + p.nx * off,
      z = p.z + p.nz * off;
    pos.push(x, y0, z, x, y1, z);
    nrm.push(p.nx * facing, 0, p.nz * facing, p.nx * facing, 0, p.nz * facing);
    const [u0, v0] = uv ? uv(i, false) : [0, 0];
    const [u1, v1] = uv ? uv(i, true) : [0, 0];
    uvs.push(u0, v0, u1, v1);
    if (i > 0) {
      const a = (i - 1) * 2,
        b = i * 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  orient(g, facing, pts[0]);
  return g;
}

/** A horizontal strip along points between offsets o0 and o1 (along each point's normal) at height y, facing up. */
function ledge(pts: { x: number; z: number; nx: number; nz: number }[], o0: number, o1: number, y: number, y1 = y) {
  const pos: number[] = [],
    idx: number[] = [];
  pts.forEach((p, i) => {
    pos.push(p.x + p.nx * o0, y, p.z + p.nz * o0, p.x + p.nx * o1, y1, p.z + p.nz * o1);
    if (i > 0) {
      const a = (i - 1) * 2,
        b = i * 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make it face up
  const n = g.attributes.normal as THREE.BufferAttribute;
  if (n.getY(0) < 0) flipWinding(g);
  g.computeVertexNormals();
  return g;
}

function flipWinding(g: THREE.BufferGeometry) {
  const ix = g.index!;
  for (let i = 0; i < ix.count; i += 3) {
    const t = ix.getX(i + 1);
    ix.setX(i + 1, ix.getX(i + 2));
    ix.setX(i + 2, t);
  }
  ix.needsUpdate = true;
}

/** Make a strip's triangles wind so they face along its normals (the first triangle decides). */
function orient(g: THREE.BufferGeometry, facing: number, p: { nx: number; nz: number }) {
  const P = g.attributes.position as THREE.BufferAttribute;
  const ix = g.index!;
  const a = new THREE.Vector3().fromBufferAttribute(P, ix.getX(0));
  const b = new THREE.Vector3().fromBufferAttribute(P, ix.getX(1));
  const c = new THREE.Vector3().fromBufferAttribute(P, ix.getX(2));
  const n = b.sub(a).cross(c.sub(a));
  if (n.x * p.nx * facing + n.z * p.nz * facing < 0) flipWinding(g);
}

// ---------------------------------------------------------------- the venue

interface StaticSet {
  geos: THREE.BufferGeometry[];
  cast: boolean;
  receive: boolean;
  /** outline width scale; 0 = none */
  outline: number;
  /** draw order (the floors go first, top layer first, so what they cover is rejected by depth before it's shaded) */
  order: number;
}

interface MatOpts {
  map?: THREE.Texture;
  /** `map` is fine detail: skip it on flat-shaded low-res styles */
  detail?: boolean;
  /** floor-level: a constant depth bias so it wins over the ground under it */
  floor?: number;
  /** cap HDR colours (glow worlds) */
  maxGlow?: number;
  /** scale the kit's rim light */
  rim?: number;
  vc?: boolean;
  side?: THREE.Side;
}

export interface FieldVenueOpts {
  /** the world's particle system (World.particles) */
  particles: Particles;
  /** the world's id (World.def.id): picks the look */
  world: string;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
const UPV = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color('#ffffff');

export class FieldVenue implements FieldVenueLike {
  readonly group = new THREE.Group();
  private mats = new Map<string, THREE.Material>();
  private statics = new Map<THREE.Material, StaticSet>();
  private disposables: { dispose(): void }[] = [];
  private particles: Particles;
  private pal: Pal;
  private fx: FxStyle;
  private world: string;
  private time = 0;
  private rng = new Rng(1234);
  private fence = fenceLine(120);
  private wallLen: number;
  // the ball
  private ball: THREE.Mesh;
  private ballHull: THREE.Mesh | null = null;
  private halo: Halo;
  /** how strongly the halo shows (it fades in after contact) */
  private haloK = 0;
  private shadow: Spot;
  private streak: Ribbon;
  /** recent positions for the streak: x, y, z, time */
  private trail: Float32Array = new Float32Array(STREAK_N * 4);
  private trailN = 0;
  private lastPhase: FieldBall['phase'] = 'gone';
  private last = new THREE.Vector3();
  private spinAxis = new THREE.Vector3(1, 0, 0);
  /** far things drawn bigger: from this distance, by this much per metre, up to this */
  private grow = { from: 4, rate: 0.07, max: 2.4 };
  // the tracer
  private tracer: Ribbon;
  private tr = { state: 'off' as 'off' | 'live' | 'done', n: 0, age: 0, fade: 0, laid: false };
  private trPts = new Float32Array(TRACER_MAX * 3);
  private contact = { x: 0, y: 0, z: 0, t: -1 };
  private landAt: THREE.Vector3 | null = null;
  // marks
  private stars: Inst;
  private sticks: Inst;
  private markT: number[] = [];
  // the pennants, the home-run line's flash, fireworks
  private flags: Flags;
  private accent: THREE.Material;
  private accentBase = new THREE.Color();
  private lineFlash = 0;
  private fireworks: Fireworks;
  private colorCss = '';
  private color = new THREE.Color('#3aa8ff');
  private atlas: Atlas;
  private atlasTex: THREE.CanvasTexture;
  private items: WallItem[] = [];
  // effect colours, made once
  private cols: Record<string, THREE.Color[]> = {};

  constructor(
    private kit: MaterialKit,
    opts: FieldVenueOpts,
  ) {
    this.world = opts.world;
    this.pal = PAL[this.world] ?? PAL.park;
    this.fx = FX[this.world] ?? FX.park;
    this.particles = opts.particles;
    if (this.world === 'pixel') this.grow = { from: 4, rate: 0.1, max: 3.2 };
    this.group.name = 'baseball';
    this.wallLen = this.fence[this.fence.length - 1].s;

    // ---- the painted art, then the park
    this.items = this.wallItems();
    const backLen = 2 * BACKSTOP.R * Math.asin(BACKSTOP.halfX / BACKSTOP.R);
    this.atlas = atlasLayout(this.wallLen, backLen, this.world === 'pixel');
    paintAtlas(this.atlas, this.pal, this.items);
    this.atlasTex = this.own(new THREE.CanvasTexture(this.atlas.canvas));
    this.atlasTex.colorSpace = THREE.SRGBColorSpace;
    this.atlasTex.anisotropy = 8;
    if (this.world === 'pixel') {
      this.atlasTex.magFilter = THREE.NearestFilter;
      this.atlasTex.minFilter = THREE.NearestMipmapNearestFilter;
    }
    this.repaintWhenFontsLoad();

    this.accent = this.accentMaterial();
    this.buildLawn();
    this.buildDirt();
    this.buildChalk();
    this.buildWall();
    this.buildPoles();
    this.buildBackstop();
    this.buildDecks();
    this.bake();
    if (kit.outline) outlineTree(this.group, kit.outline.color, kit.outline.width, { emissive: kit.outline.emissive });
    const ol = kit.outline;
    const shadows = !!kit.castShadow;

    // ---- the ball
    const ballGeo = this.world === 'pixel' ? new THREE.BoxGeometry(FIELD.ballR * 2.1, FIELD.ballR * 2.1, FIELD.ballR * 2.1) : new THREE.SphereGeometry(FIELD.ballR, 24, 16);
    this.own(ballGeo);
    const ballTex = this.own(ballTexture(this.world));
    let ballMat: THREE.Material;
    if (this.fx.ballGlow > 0) {
      ballMat = new THREE.MeshBasicMaterial({ map: ballTex, color: new THREE.Color(1, 1, 1).multiplyScalar(this.fx.ballGlow) });
      this.disposables.push(ballMat);
    } else ballMat = this.mat('racket', '#ffffff', { map: ballTex, maxGlow: 1.05, rim: 0.6 });
    this.ball = new THREE.Mesh(ballGeo, ballMat);
    this.ball.name = 'baseball';
    this.ball.renderOrder = 3;
    this.ball.castShadow = false;
    this.ball.frustumCulled = false;
    // a fine dark edge, so a white ball reads against a white shirt or pale paving (the glowing
    // balls need none; ink's and pixel's post passes draw their own edges)
    const edge = BALL_EDGE[this.world];
    if (edge) {
      const hm = hullMaterial(new THREE.Color(edge[0]), edge[1]);
      this.disposables.push(hm);
      this.ballHull = new THREE.Mesh(ballGeo, hm);
      this.ballHull.name = 'outline';
      this.ball.add(this.ballHull);
    }
    this.group.add(this.ball);
    // and a ring in the hitter's colour round it in flight
    this.halo = new Halo(this.fx.hot);
    this.group.add(this.halo.mesh);
    // its shadow: a soft dark disc (a ring of light on the glowing worlds' dark floors, where a
    // shadow wouldn't show), never under a few pixels across however far off it is
    const glowSpot = this.pal.glow;
    this.shadow = new Spot(glowSpot ? new THREE.Color(this.pal.chalk).multiplyScalar(1.4) : kit.shadowColor, { ring: glowSpot, additive: glowSpot, minPx: this.world === 'pixel' ? 9 : 7 });
    this.group.add(this.shadow.mesh);
    this.streak = new Ribbon(STREAK_N + 1, this.fx.streak, 'ball-streak');
    this.streak.color(new THREE.Color(this.fx.streakColor).multiplyScalar(this.fx.streakHdr));
    this.group.add(this.streak.mesh);

    // ---- the tracer
    // (about constant on screen, TV-style: a few pixels far off, capped close up — the plate, a foul back past the eye)
    this.tracer = new Ribbon(TRACER_MAX + 2, { ...this.fx.tracer, maxPx: Math.max(9, this.fx.tracer.minPx * 1.6) }, 'tracer');
    this.group.add(this.tracer.mesh);
    if (this.tracer.xray) this.group.add(this.tracer.xray);

    // ---- this turn's home runs: a star on a stick
    const starMat = this.pal.glow ? this.glowMat('#ffffff', 2.2) : this.mat('racket', '#ffffff', { maxGlow: 1.2, rim: 0.8 });
    this.stars = new Inst(this.own(starGeometry(this.world === 'pixel')), starMat, MAX_MARKS, 'hr-stars').outline(ol, 1);
    this.stars.mesh.castShadow = shadows;
    this.stars.mesh.setColorAt(0, WHITE);
    const stickMat = this.pal.glow ? this.glowMat(this.pal.chalk, 1.6) : this.mat('shirt', this.pal.metal, { rim: 0.4 });
    const stickGeo = this.pal.square ? new THREE.BoxGeometry(1, 1, 1) : new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1);
    this.sticks = new Inst(this.own(stickGeo), stickMat, MAX_MARKS, 'hr-sticks');
    this.group.add(this.stars.mesh, this.sticks.mesh);

    // ---- pennants on the flag poles and the foul poles
    let fm: THREE.Material;
    if (this.pal.glow) {
      fm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 1.7, 1.7), vertexColors: true, side: THREE.DoubleSide });
      this.disposables.push(fm);
    } else fm = this.mat('shirt', '#ffffff', { vc: true, side: THREE.DoubleSide, rim: 0.3 });
    this.flags = new Flags(fm, this.pal.flags, this.world === 'pixel' || this.world === 'clay', FLAG_POLE.at.length + 2);
    this.flags.mesh.castShadow = shadows;
    this.flags.mesh.name = 'pennants';
    this.group.add(this.flags.mesh);

    // ---- fireworks
    this.fireworks = new Fireworks(2000, this.fx.fw);
    this.group.add(this.fireworks.mesh);

    // ---- effect colours
    const hot = this.fx.hot ? 2.4 : 1;
    const col = (list: string[], k = 1) => list.map((c) => new THREE.Color(c).multiplyScalar(hot * k));
    const F = this.fx;
    this.cols = {
      sparks: col(F.sparks),
      dust: col(F.dust),
      grass: col(F.grass),
      party: col(F.party),
      puff: col(F.puff),
      white: col(['#ffffff']),
      dirt: col([mixCss(this.pal.dirt, '#ffffff', 0.25), this.pal.dirt], 1),
      track: col([mixCss(this.pal.track, '#ffffff', 0.2), this.pal.track], 1),
      smoke: F.smoke ? col(F.smoke) : [],
      pad: col([mixCss(this.pal.pad, '#ffffff', 0.6), '#ffffff']),
    };

    this.update({ ball: { x: 0, y: -10, z: 0, phase: 'gone', speed: 0 }, tracer: false, color: '#3aa8ff', marks: [], eye: { x: 0, y: 1.9, z: 16.3 }, fx: [] }, 0);
  }

  // ---------------------------------------------------------------- per frame

  update(v: FieldView, realDt: number) {
    this.time += realDt;
    const dt = realDt;
    if (v.color !== this.colorCss) {
      this.colorCss = v.color;
      this.color.set(v.color);
      const F = this.fx;
      tmpC.set(F.tracerBase ?? '#ffffff').lerp(this.color, F.tracerTint).multiplyScalar(F.tracerHdr);
      this.tracer.color(tmpC);
      this.halo.color(this.world === 'ink' ? tmpC.set(this.pal.line) : tmpC.copy(this.color).multiplyScalar(this.fx.hot ? 2 : 1));
    }
    // effects first: a contact starts the tracer from the bat
    for (const f of v.fx) this.effect(f);
    this.placeBall(v.ball, v.eye, dt);
    this.updateTracer(v, dt);
    this.placeMarks(v);
    this.updateFlags(dt);
    this.fireworks.update(dt);
    this.flashLine(dt);
    this.runLater();
  }

  dispose() {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.stars.dispose();
    this.sticks.dispose();
    this.flags.dispose();
    this.streak.dispose();
    this.halo.dispose();
    this.shadow.dispose();
    this.tracer.dispose();
    this.fireworks.dispose();
  }

  // ---------------------------------------------------------------- the ball

  private placeBall(b: FieldBall, eye: { x: number; y: number; z: number }, dt: number) {
    const show = b.phase === 'pitch' || b.phase === 'play';
    this.ball.visible = show;
    if (!show) this.shadow.hide();
    const fresh = b.phase !== this.lastPhase;
    this.lastPhase = b.phase;
    if (!show) {
      this.streak.hide();
      this.trailN = 0;
      this.haloK = 0;
      this.halo.set(this.ball.position, 0, eye, 0);
      return;
    }
    const p = this.ball.position;
    p.set(b.x, b.y, b.z);
    // spin about the axis across its motion (backspin), at a rate the eye can follow
    tmpV.subVectors(p, this.last);
    const d = tmpV.length();
    if (!fresh && d > 1e-4 && d < 4) {
      this.spinAxis.crossVectors(tmpV, UPV);
      if (this.spinAxis.lengthSq() < 1e-8) this.spinAxis.set(1, 0, 0);
      this.spinAxis.normalize();
      this.ball.rotateOnWorldAxis(this.spinAxis, (b.phase === 'pitch' ? 26 : 38) * dt);
    }
    this.last.copy(p);
    // bigger far away, so it never shrinks to a speck; close to the eye (a foul straight back
    // passes right over the camera) no bigger on screen than MAX_ANG radians across its radius
    const de = Math.hypot(b.x - eye.x, b.y - eye.y, b.z - eye.z);
    const g = this.grow;
    // (it grows only once it's left the pitcher's hand, so it doesn't pop from the gear's ball to
    // a bigger one at the release — or back as the catcher's toss comes into the glove)
    const hand = THREE.MathUtils.smoothstep(Math.hypot(b.x, b.y - FIELD.releaseY, b.z - FIELD.releaseZ), 0.6, 4);
    const s = Math.min(1 + (THREE.MathUtils.clamp(1 + (de - g.from) * g.rate, 1, g.max) - 1) * hand, (MAX_ANG * de) / FIELD.ballR);
    this.ball.scale.setScalar(Math.max(1e-3, s));
    // the halo: a batted ball in the air, once it's a few metres off (close up it only gets in the way)
    const flying = b.phase === 'play' && b.speed > 3 && this.world !== 'pixel';
    this.haloK += ((flying ? 1 : 0) - this.haloK) * Math.min(1, dt * (flying ? 6 : 3));
    this.halo.set(p, FIELD.ballR * s, eye, this.haloK * THREE.MathUtils.smoothstep(de, 3.5, 7));
    // the shadow on the ground under it (on the mound's dome where it's over it)
    const gy = moundY(b.x, b.z) + 0.02;
    const h = Math.max(0, b.y - FIELD.ballR - gy);
    const sp = sprayOf(b.x, b.z);
    const beyond = sp.r - fenceAt(sp.a) - this.pal.thick;
    // out past the wall the ground is the world's (stands, gaps): let it go
    // (and over the side stands, behind the batting camera: the world's ground again)
    const out = THREE.MathUtils.clamp(1 - beyond / 1.2, 0, 1) * THREE.MathUtils.clamp(1 - (Math.abs(b.x) - LAWN.halfX) / 0.6, 0, 1) * THREE.MathUtils.clamp(1 - (b.z - LAWN.back) / 0.6, 0, 1);
    const ss = FIELD.ballR * 1.7 * Math.max(1, s) * (1 + h * 0.045);
    const base = this.pal.glow ? 0.9 : Math.min(0.85, this.kit.shadowOpacity * 2.8);
    this.shadow.set(b.x, gy, b.z, ss, Math.max(base * 0.7, base - h * 0.02) * out);
    // the streak: where it has been over the last few hundredths of a second
    if (fresh) this.trailN = 0;
    const T = this.trail;
    const n = Math.min(STREAK_N, this.trailN + 1);
    for (let i = n - 1; i > 0; i--) {
      T[i * 4] = T[(i - 1) * 4];
      T[i * 4 + 1] = T[(i - 1) * 4 + 1];
      T[i * 4 + 2] = T[(i - 1) * 4 + 2];
      T[i * 4 + 3] = T[(i - 1) * 4 + 3];
    }
    T[0] = b.x;
    T[1] = b.y;
    T[2] = b.z;
    T[3] = this.time;
    this.trailN = n;
    const k = THREE.MathUtils.smoothstep(b.speed, 14, 26);
    if (k < 0.02 || n < 2) {
      this.streak.hide();
      return;
    }
    const R = FIELD.ballR * s;
    const span = 0.055;
    const S = this.streak;
    S.begin();
    // oldest first; clipped to `span` seconds and 2 m
    let m = 0;
    let len = 0;
    for (let i = 1; i < n; i++) {
      if (this.time - T[i * 4 + 3] > span) break;
      len += Math.hypot(T[i * 4] - T[(i - 1) * 4], T[i * 4 + 1] - T[(i - 1) * 4 + 1], T[i * 4 + 2] - T[(i - 1) * 4 + 2]);
      if (len > 2) break;
      m = i;
    }
    if (m < 1) {
      S.hide();
      return;
    }
    for (let i = m; i >= 0; i--) {
      const u = 1 - i / m;
      S.push(T[i * 4], T[i * 4 + 1], T[i * 4 + 2], R * (0.25 + 0.65 * u), k * Math.pow(u, 1.3));
    }
    S.end();
  }

  // ---------------------------------------------------------------- the tracer

  private updateTracer(v: FieldView, dt: number) {
    const tr = this.tr;
    const b = v.ball;
    if (!v.tracer) {
      if (tr.state !== 'off') {
        // going: a quick fade, then clear
        tr.fade -= dt * 4;
        if (tr.fade <= 0) {
          tr.state = 'off';
          tr.n = 0;
          this.tracer.hide();
        } else this.tracer.fade = tr.fade;
      }
      return;
    }
    if (tr.state === 'off' && b.phase === 'play') {
      tr.state = 'live';
      tr.n = 0;
      tr.age = 0;
      tr.fade = 1;
      tr.laid = false;
      this.landAt = null;
      // from the bat, when it has just been hit
      if (this.contact.t >= 0 && this.time - this.contact.t < 0.4) this.addTracerPt(this.contact.x, this.contact.y, this.contact.z, true);
    }
    if (tr.state === 'off') return;
    if (tr.state === 'live') {
      if (this.landAt) {
        this.addTracerPt(this.landAt.x, this.landAt.y, this.landAt.z, true);
        tr.state = 'done';
      } else if (b.phase === 'play') this.addTracerPt(b.x, b.y, b.z, false);
      else if (b.phase === 'gone') tr.state = 'done';
    }
    if (tr.state === 'done') {
      tr.age += dt;
      tr.fade = Math.max(0.7, 1 - tr.age * 0.08);
    }
    // (a finished path is laid once: after that only its fade changes)
    if (tr.state === 'live' || !tr.laid) {
      this.layTracer(tr.state === 'live' && b.phase === 'play' ? b : null);
      tr.laid = tr.state === 'done';
    }
    this.tracer.fade = tr.fade;
  }

  /** Commit a point to the tracer's path when it's far enough from the last one (or `force`). */
  private addTracerPt(x: number, y: number, z: number, force: boolean) {
    const tr = this.tr;
    const P = this.trPts;
    if (tr.n > 0) {
      const i = (tr.n - 1) * 3;
      const d = Math.hypot(x - P[i], y - P[i + 1], z - P[i + 2]);
      if (d < (force ? 0.02 : 0.16)) return;
    }
    if (tr.n >= TRACER_MAX) {
      // full: keep every other point
      for (let i = 1; i < TRACER_MAX / 2; i++) {
        P[i * 3] = P[i * 6];
        P[i * 3 + 1] = P[i * 6 + 1];
        P[i * 3 + 2] = P[i * 6 + 2];
      }
      tr.n = TRACER_MAX / 2;
    }
    P[tr.n * 3] = x;
    P[tr.n * 3 + 1] = y;
    P[tr.n * 3 + 2] = z;
    tr.n++;
  }

  /** Lay the ribbon through the path (and on to the ball, when it's still flying). */
  private layTracer(head: FieldBall | null) {
    const tr = this.tr;
    const P = this.trPts;
    const R = this.tracer;
    const n = tr.n;
    R.begin();
    // the length, to fade the start in over the first metre
    const W = 0.065;
    let len = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) len += Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2], P[i * 3 + 2] - P[i * 3 - 1]);
      const u = n > 1 ? i / (n - 1) : 1;
      const a = Math.min(1, len / 1.2) * (0.55 + 0.45 * u);
      R.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], W * (0.8 + 0.5 * u), a);
    }
    if (head) R.push(head.x, head.y, head.z, W * 1.3, 1);
    R.end();
  }

  // ---------------------------------------------------------------- home-run stars

  private placeMarks(v: FieldView) {
    const marks = v.marks;
    if (marks.length < this.markT.length) this.markT.length = 0;
    const S = this.stars,
      K = this.sticks;
    S.begin();
    K.begin();
    const eye = v.eye;
    const g = this.grow;
    for (let i = 0; i < marks.length && i < MAX_MARKS; i++) {
      const m = marks[i];
      if (this.markT[i] === undefined) {
        this.markT[i] = this.time;
        this.sparkle(m.x, m.y + 1.3, m.z);
      }
      const age = this.time - this.markT[i];
      // pop in with an overshoot
      const pop = age >= 0.6 ? 1 : elastic(age / 0.6);
      const d = Math.hypot(m.x - eye.x, m.y - eye.y, m.z - eye.z);
      const s = THREE.MathUtils.clamp(1 + (d - g.from) * g.rate * 0.55, 1, 2.2) * pop;
      const hgt = 1.5 * Math.max(1, s * 0.75);
      const bob = Math.sin(this.time * 2.2 + i * 1.7) * 0.06;
      tmpQ.setFromAxisAngle(UPV, this.time * 1.8 + i * 0.9);
      tmpP.set(m.x, m.y + hgt + bob, m.z);
      const k = S.push(tmpM.compose(tmpP, tmpQ, tmpS.setScalar(0.4 * s)));
      if (k >= 0) S.mesh.setColorAt(k, this.color);
      // the stick, from where it came down up to the star
      if (pop > 0.05) {
        const top = hgt + bob - 0.3 * s;
        tmpQ.identity();
        K.push(tmpM.compose(tmpP.set(m.x, m.y + top / 2, m.z), tmpQ, tmpS.set(0.05 * Math.max(1, s * 0.8), Math.max(0.01, top), 0.05 * Math.max(1, s * 0.8))));
      }
    }
    S.end();
    K.end();
  }

  // ---------------------------------------------------------------- pennants, the line's flash

  private updateFlags(dt: number) {
    const F = this.flags;
    F.begin();
    const t = this.pal.thick;
    for (const deg of FLAG_POLE.at) {
      const a = (deg * Math.PI) / 180;
      const p = fieldPoint(a, fenceAt(a) + t + 0.3);
      F.add(p.x, FLAG_POLE.h - 0.05, p.z, 1.15, 0.6);
    }
    for (const sx of [-1, 1]) {
      const p = fieldPoint(sx * A, fenceAt(A) + 0.12);
      F.add(p.x, POLE.h - 0.05, p.z, 1.5, 0.78);
    }
    const wind = 3.1 + Math.sin(this.time * 0.37) * 0.9 + Math.sin(this.time * 1.3) * 0.4;
    F.update(this.time, dt, wind);
  }

  private flashLine(dt: number) {
    if (this.lineFlash <= 0) return;
    this.lineFlash = Math.max(0, this.lineFlash - dt * 0.9);
    const k = this.lineFlash;
    // a pulse or two as it fades
    const pulse = k * (0.65 + 0.35 * Math.cos((1 - k) * 18));
    const m = this.accent as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
    if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial) m.color.copy(this.accentBase).multiplyScalar(1 + pulse * 1.6);
    else if ('emissive' in m) (m as THREE.MeshStandardMaterial).emissive.copy(this.accentBase).multiplyScalar(pulse * 0.9);
  }

  // ---------------------------------------------------------------- effects

  private effect(f: FieldFx) {
    switch (f.type) {
      case 'contact':
        this.contact = { x: f.x, y: f.y, z: f.z, t: this.time };
        // a new hit: the old tracer goes at once
        if (this.tr.state !== 'off') {
          this.tr.state = 'off';
          this.tr.n = 0;
          this.tracer.hide();
        }
        this.landAt = null;
        this.hit(f.x, f.y, f.z, f.power, f.sweet);
        break;
      case 'catch':
        this.puff(f.x, f.y, f.z);
        break;
      case 'land':
        if (this.tr.state === 'live') this.landAt = new THREE.Vector3(f.x, f.y, f.z);
        this.land(f.x, f.y, f.z, f.homeRun);
        break;
      case 'wall':
        if (this.tr.state === 'live') this.landAt = new THREE.Vector3(f.x, f.y, f.z);
        this.thump(f.x, f.y, f.z);
        break;
      case 'homerun':
        this.celebrate(f.x, f.y, f.z);
        break;
    }
  }

  /** The bat meets the ball: sparks flying out, a ring, dust off the plate; the sweet spot flashes. */
  private hit(x: number, y: number, z: number, power: number, sweet: boolean) {
    const P = this.particles;
    const F = this.fx;
    const c = this.cols;
    const pw = THREE.MathUtils.clamp(power, 0, 1);
    P.burst({ x, y, z, count: Math.round(8 + pw * 14 + (sweet ? 12 : 0)), speed: [2.5, 6 + pw * 6], dir: [0, 0.3, -1], spread: 0.75, life: [0.18, 0.45 + (sweet ? 0.2 : 0)], size: [0.05, sweet ? 0.18 : 0.13], shrink: 0.2, colors: c.sparks, shape: F.spark, drag: 3, gravity: this.world === 'ink' ? 8 : 3, spin: 8 });
    P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.26, 0.26], size: [0.22, 0.22], shrink: sweet ? 7 : 4.5, colors: c.white, shape: 'ring', alpha: 0.9 });
    if (sweet) {
      P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.16, 0.16], size: [1.1, 1.1], shrink: 0.3, colors: c.sparks.slice(0, 2), shape: 'star', alpha: 1 });
      P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.42, 0.42], size: [0.4, 0.4], shrink: 9, colors: this.fx.hot ? [this.color.clone().multiplyScalar(2.4)] : [this.color], shape: 'ring', alpha: 0.85 });
      P.burst({ x, y, z, count: 14, speed: [1.5, 4], life: [0.5, 0.9], size: [0.06, 0.12], colors: c.sparks, shape: F.spark, drag: 2, gravity: 2.5, spin: 10 });
    }
    // dust off the ground under the swing
    P.burst({ x, y: 0.06, z: z + 0.25, count: 5, speed: [0.4, 1.3], dir: [0, 1, 0], spread: 0.9, life: [0.35, 0.7], size: [0.14, 0.28], shrink: 1.8, colors: c.dirt, shape: F.dustShape, alpha: F.hot ? 0.8 : 0.5, drag: 3.5, gravity: -0.2 });
  }

  /** Into the mitt: a little puff of dust off the leather. */
  private puff(x: number, y: number, z: number) {
    const P = this.particles;
    const F = this.fx;
    P.burst({ x, y, z, count: 8, speed: [0.5, 1.6], life: [0.25, 0.55], size: [0.08, 0.2], shrink: 1.6, colors: this.cols.puff, shape: F.dustShape, alpha: F.hot ? 0.9 : 0.6, drag: 4, gravity: -0.2 });
    P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.18, 0.18], size: [0.14, 0.14], shrink: 3, colors: this.cols.white, shape: 'ring', alpha: 0.6 });
  }

  /** It comes down: grass or dirt kicked up on the field; in the stands, confetti. */
  private land(x: number, y: number, z: number, homeRun: boolean) {
    const P = this.particles;
    const F = this.fx;
    const c = this.cols;
    const sp = sprayOf(x, z);
    if (homeRun) {
      P.burst({ x, y: y + 0.2, z, count: 46, speed: [2.5, 6], dir: [0, 1, 0], spread: 0.6, life: [1.1, 1.9], size: [0.09, 0.17], colors: c.party, shape: F.confetti, gravity: 4, drag: 1.4, spin: 10 });
      P.burst({ x, y: y + 0.2, z, count: 1, speed: [0, 0], life: [0.35, 0.35], size: [0.5, 0.5], shrink: 5, colors: c.white, shape: 'ring', alpha: 0.8 });
      return;
    }
    if (!onField(x, y, z)) {
      // a foul into the stands (or out beyond the park): the fans scramble — a little pop, no party
      P.burst({ x, y: y + 0.15, z, count: 12, speed: [1.5, 3.5], dir: [0, 1, 0], spread: 0.7, life: [0.7, 1.2], size: [0.07, 0.13], colors: c.party, shape: F.confetti, gravity: 5, drag: 1.6, spin: 10 });
      P.burst({ x, y: y + 0.1, z, count: 5, speed: [0.4, 1.2], dir: [0, 1, 0], spread: 0.9, life: [0.4, 0.8], size: [0.16, 0.3], shrink: 1.6, colors: c.dust, shape: F.dustShape, alpha: F.hot ? 0.7 : 0.45, drag: 3.5, gravity: -0.2 });
      return;
    }
    const onTrack = sp.r > fenceAt(sp.a) - TRACK - 0.05;
    const dirt = onTrack || Math.hypot(x, z - FIELD.moundCZ) < FIELD.moundR || Math.hypot(x, z - SKIN.z) < SKIN.r;
    const gy = Math.max(0.05, moundY(x, z) + 0.05);
    P.burst({ x, y: gy, z, count: 9, speed: [0.6, 2.2], dir: [0, 1, 0], spread: 0.85, life: [0.45, 0.95], size: [0.18, 0.36], shrink: 1.8, colors: dirt ? (onTrack ? c.track : c.dirt) : c.dust, shape: F.dustShape, alpha: F.hot ? 0.8 : 0.55, drag: 3.2, gravity: -0.3 });
    P.burst({ x, y: gy, z, count: dirt ? 6 : 10, speed: [1.5, 3.8], dir: [0, 1, 0.1], spread: 0.55, life: [0.35, 0.7], size: [0.05, 0.1], colors: dirt ? c.dirt : c.grass, shape: F.bit, gravity: 9, drag: 1, spin: 10 });
    P.burst({ x, y: gy, z, count: 1, speed: [0, 0], life: [0.3, 0.3], size: [0.3, 0.3], shrink: 4.5, colors: c.white, shape: 'ring', alpha: 0.55 });
  }

  /** Off the wall: a thump of dust from the padding. */
  private thump(x: number, y: number, z: number) {
    const P = this.particles;
    const F = this.fx;
    const sp = sprayOf(x, z);
    // just in front of the face, towards home
    const back = 0.12;
    const dx = -Math.sin(sp.a) * back,
      dz = Math.cos(sp.a) * back;
    P.burst({ x: x + dx, y, z: z + dz, count: 12, speed: [0.6, 2.2], dir: [dx * 8, 0.3, dz * 8], spread: 0.7, life: [0.4, 0.9], size: [0.14, 0.3], shrink: 1.6, colors: this.cols.dust, shape: F.dustShape, alpha: F.hot ? 0.8 : 0.55, drag: 3.5, gravity: 0.6 });
    P.burst({ x: x + dx, y, z: z + dz, count: 1, speed: [0, 0], life: [0.28, 0.28], size: [0.28, 0.28], shrink: 5, colors: this.cols.pad, shape: 'ring', alpha: 0.75 });
  }

  /** A home run: fireworks over the stands where it went out, the home-run line and poles lit up. */
  private celebrate(x: number, y: number, z: number) {
    this.lineFlash = 1;
    const sp = sprayOf(x, z);
    const a0 = THREE.MathUtils.clamp(sp.a, -A, A);
    const rng = () => this.rng.next();
    const pick = <T>(l: T[]) => l[Math.floor(rng() * l.length)];
    const base = this.fx.fw.colors.map((c) => new THREE.Color(c));
    const shells: Shell[] = [];
    // a two-second show over the stands where it went out, spreading from the spot: a big
    // salute in the hitter's colour first, then a ring, a willow, a star and a closing pair
    const show: { kind: ShellKind; da: number; t: number; y: number; r: number }[] = [
      { kind: 'peony', da: 0, t: 0, y: 6.6, r: 6 },
      { kind: 'ring', da: -0.13, t: 0.34, y: 8.2, r: 5 },
      { kind: 'willow', da: 0.12, t: 0.62, y: 9, r: 5.4 },
      { kind: 'star', da: -0.05, t: 0.95, y: 5.8, r: 4.6 },
      { kind: 'peony', da: 0.2, t: 1.25, y: 7.2, r: 5.2 },
      { kind: 'peony', da: -0.2, t: 1.3, y: 7.6, r: 5.2 },
    ];
    show.forEach((sh, i) => {
      const a = THREE.MathUtils.clamp(a0 + sh.da + (rng() - 0.5) * 0.06, -A - 0.12, A + 0.12);
      const from = fieldPoint(a, fenceAt(a) + 3 + rng() * 2);
      const at = fieldPoint(a + (rng() - 0.5) * 0.05, fenceAt(a) + 4 + rng() * 2.5);
      // the hitter's colour, the world's, and white (the first all the hitter's)
      const colors = i === 0 ? [this.color.clone(), this.color.clone().lerp(WHITE, 0.5), WHITE.clone()] : [this.color.clone(), pick(base), pick(base), WHITE.clone()];
      shells.push({
        from: new THREE.Vector3(from.x, 2.4, from.z),
        at: new THREE.Vector3(at.x, sh.y + rng() * 0.8, at.z),
        delay: sh.t + rng() * 0.06,
        rise: 0.5 + rng() * 0.15,
        kind: sh.kind,
        colors,
        radius: sh.r * (0.92 + rng() * 0.16),
      });
    });
    this.fireworks.fire(shells, rng);
    // smoke drifting from each burst in the daytime worlds
    const P = this.particles;
    const smoke = this.cols.smoke;
    if (smoke.length)
      for (const s of shells) {
        const at = s.at.clone();
        this.later.push({
          t: this.time + s.delay + s.rise + 0.2,
          f: () => P.burst({ x: at.x, y: at.y, z: at.z, count: 7, speed: [0.3, 1.4], life: [1.8, 2.8], size: [0.9, 1.7], shrink: 1.7, colors: smoke, shape: 'soft', alpha: 0.2, drag: 1.2, gravity: -0.25 }),
        });
      }
    // and confetti where it went out
    P.burst({ x, y: y + 1, z, count: 40, speed: [3, 7], dir: [0, 1, 0], spread: 0.55, life: [1.3, 2.2], size: [0.1, 0.18], colors: this.cols.party, shape: this.fx.confetti, gravity: 3.5, drag: 1.3, spin: 10 });
  }

  /** Effects waiting for their moment (a burst's smoke). */
  private later: { t: number; f: () => void }[] = [];
  private runLater() {
    if (!this.later.length) return;
    const now = this.time;
    for (let i = this.later.length - 1; i >= 0; i--)
      if (this.later[i].t <= now) {
        this.later[i].f();
        this.later.splice(i, 1);
      }
  }

  /** A new home-run star: a little sparkle. */
  private sparkle(x: number, y: number, z: number) {
    const hot = this.fx.hot ? 2.4 : 1;
    this.particles.burst({ x, y, z, count: 12, speed: [1, 2.8], life: [0.35, 0.7], size: [0.07, 0.14], shrink: 0.2, colors: [this.color.clone().multiplyScalar(hot), WHITE.clone().multiplyScalar(hot)], shape: this.fx.spark, drag: 2.5, gravity: 1, spin: 8 });
  }

  // ---------------------------------------------------------------- materials & baking

  private mat(role: CharRole, css: string, o: MatOpts = {}) {
    const key = [role, css, o.map?.uuid ?? '', o.floor ?? 0, o.maxGlow ?? 0, o.rim ?? 1, o.vc ? 1 : 0, o.side ?? 0].join('|');
    const m = this.mats.get(key);
    if (m) return m;
    const mat = this.kit.char(role, new THREE.Color(css));
    const mm = mat as THREE.MeshStandardMaterial;
    if (o.vc) mat.vertexColors = true;
    if (o.side !== undefined) mat.side = o.side;
    if (o.map && 'map' in mm && !(o.detail && mm.flatShading)) mm.map = o.map;
    if (o.floor) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 0;
      mat.polygonOffsetUnits = -2 * o.floor;
    }
    if (o.maxGlow && mm.color) {
      const top = Math.max(mm.color.r, mm.color.g, mm.color.b);
      if (top > o.maxGlow) mm.color.multiplyScalar(o.maxGlow / top);
    }
    // the rim light of worlds/mats.ts toon() lives in a `uRim` uniform set up in onBeforeCompile
    const rim = o.rim ?? 1;
    if (rim !== 1 && Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')) {
      const orig = mat.onBeforeCompile;
      mat.onBeforeCompile = (sh, r) => {
        orig.call(mat, sh, r);
        const u = sh.uniforms.uRim;
        if (u) u.value *= rim;
      };
    }
    this.mats.set(key, mat);
    return mat;
  }

  /** Unlit colour, HDR for the glowing worlds (bloom picks it up). */
  private glowMat(css: string, k: number, o: { map?: THREE.Texture; vc?: boolean; floor?: number } = {}) {
    const key = `glow|${css}|${k}|${o.map?.uuid ?? ''}|${o.vc ? 1 : 0}|${o.floor ?? 0}`;
    let m = this.mats.get(key);
    if (!m) {
      const b = new THREE.MeshBasicMaterial({ color: new THREE.Color(css).multiplyScalar(k), map: o.map ?? null, vertexColors: !!o.vc });
      if (o.floor) {
        b.polygonOffset = true;
        b.polygonOffsetFactor = 0;
        b.polygonOffsetUnits = -2 * o.floor;
      }
      this.mats.set(key, (m = b));
    }
    return m;
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /** Queue static geometry; everything with the same material becomes one mesh. */
  private add(mat: THREE.Material, geo: THREE.BufferGeometry, o: { cast?: boolean; receive?: boolean; outline?: number; order?: number } = {}) {
    let s = this.statics.get(mat);
    if (!s) this.statics.set(mat, (s = { geos: [], cast: !!o.cast, receive: !!o.receive, outline: o.outline ?? 0, order: o.order ?? 0 }));
    s.geos.push(geo);
  }

  private bake() {
    const shadows = !!this.kit.castShadow;
    for (const [mat, s] of this.statics) {
      const geo = mergeGeometries(s.geos, false);
      s.geos.forEach((g) => g.dispose());
      if (!geo) {
        console.warn('baseball venue: could not merge a set of', mat.type);
        continue;
      }
      this.own(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadows && s.cast;
      m.receiveShadow = shadows && s.receive;
      if (s.outline <= 0) m.userData.noOutline = true;
      else m.userData.outlineScale = s.outline;
      m.renderOrder = s.order;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
    }
    this.statics.clear();
  }

  // ---------------------------------------------------------------- the painted art

  /** The distances (real metres, from realFenceAt), the words and the bunting, placed along the wall. */
  private wallItems(): WallItem[] {
    const P = this.fence;
    const L = this.wallLen;
    const at = (deg: number) => arcAt(P, (deg * Math.PI) / 180);
    const num = (a: number) => String(Math.round(realFenceAt(a)));
    const alley = 16;
    const items: WallItem[] = [
      // by the poles (just fair of them), the alleys, straight away
      { s: 1.25, kind: 'number', label: num(-A) },
      { s: at(-alley), kind: 'number', label: num((-alley * Math.PI) / 180) },
      { s: at(0), kind: 'number', label: num(0) },
      { s: at(alley), kind: 'number', label: num((alley * Math.PI) / 180) },
      { s: L - 1.25, kind: 'number', label: num(A) },
      // the words between the alleys and centre (the room between the numbers, less theirs)
      { s: (at(-alley) + at(0)) / 2, kind: 'words', label: 'HOME RUN DERBY', room: at(0) - at(-alley) - 2.5 },
      { s: (at(alley) + at(0)) / 2, kind: 'words', label: 'HOME RUN DERBY', room: at(alley) - at(0) - 2.5 },
      // bunting between the poles' numbers and the alleys'
      { s: (1.25 + at(-alley)) / 2, kind: 'fan' },
      { s: (L - 1.25 + at(alley)) / 2, kind: 'fan' },
    ];
    return items;
  }

  /** The canvas text needs the web fonts: paint again once they're in. */
  private repaintWhenFontsLoad() {
    const fonts = document.fonts;
    if (!fonts) return;
    const faces = new Set([this.pal.font, this.pal.words].map((f) => `700 64px ${f}`));
    Promise.all([...faces].map((f) => fonts.load(f).catch(() => [])))
      .then(() => {
        paintAtlas(this.atlas, this.pal, this.items);
        this.atlasTex.needsUpdate = true;
      })
      .catch(() => {});
  }

  /** The material the atlas is drawn with (the wall's face, the backstop's, the on-deck mats). */
  private artMaterial() {
    if (this.pal.glow) return this.glowMat('#ffffff', 2.1, { map: this.atlasTex });
    // pixel: unlit, so the palette pass meets the painted colours exactly (lit, they dither into noise)
    if (this.world === 'pixel') return this.glowMat('#ffffff', 1, { map: this.atlasTex });
    return this.mat('shirt', '#ffffff', { map: this.atlasTex, rim: 0.25 });
  }

  /** The home-run line along the top of the wall and the foul poles: one material, so it flashes as one. */
  private accentMaterial() {
    const pal = this.pal;
    let m: THREE.Material;
    if (pal.glow) {
      m = new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.line).multiplyScalar(2.2) });
      this.disposables.push(m);
      this.accentBase.copy((m as THREE.MeshBasicMaterial).color);
    } else {
      // (its own, not a cached one: the flash changes it)
      m = this.kit.char('racket', new THREE.Color(pal.line));
      this.disposables.push(m);
      const mm = m as THREE.MeshStandardMaterial;
      if (mm.color) {
        const top = Math.max(mm.color.r, mm.color.g, mm.color.b);
        if (top > 1.2) mm.color.multiplyScalar(1.2 / top);
      }
      this.accentBase.set(pal.line);
      if ('emissive' in mm && mm.emissive) mm.emissive.setRGB(0, 0, 0);
    }
    return m;
  }

  // ---------------------------------------------------------------- the static park

  /** The lawn: fair ground to the wall and foul ground to the stands, a crosshatch mown along the foul lines. */
  private buildLawn() {
    const pal = this.pal;
    const tex = this.own(lawnTexture(pal));
    let lawn: THREE.Material;
    if (pal.glow) {
      lawn = new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -2 });
      this.disposables.push(lawn);
    } else lawn = this.mat('shirt', '#ffffff', { map: tex, floor: 1, rim: 0.15 });
    // the outline: behind home, up the right side to the pole, round the wall, down the left
    const X = LAWN.halfX;
    const pts: [number, number][] = [
      [-X, LAWN.back],
      [X, LAWN.back],
    ];
    const P = this.fence;
    const under = this.pal.thick * 0.5;
    pts.push([X, P[P.length - 1].z + P[P.length - 1].nz * under]);
    for (let i = P.length - 1; i >= 0; i--) pts.push([P[i].x + P[i].nx * under, P[i].z + P[i].nz * under]);
    pts.push([-X, P[0].z + P[0].nz * under]);
    const g = flatPoly(pts, Y.lawn);
    // the crosshatch: lines along each foul line, cells `cell` metres across
    const cell = 2.5;
    const ca = Math.cos(A),
      sa = Math.sin(A);
    const p = g.attributes.position as THREE.BufferAttribute;
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        z = p.getZ(i) - HOME_Z;
      uv.setXY(i, (x * ca - z * sa) / (2 * cell) + 0.25, (x * ca + z * sa) / (2 * cell) + 0.25);
    }
    this.add(lawn, g, { receive: true, order: -2 });
  }

  /** Dirt: home plate's circle, the mound, the warning track (vertex-coloured, one mesh). */
  private buildDirt() {
    const pal = this.pal;
    const tex = this.own(dirtTexture(pal));
    const dirt = pal.glow ? this.glowMat('#ffffff', 1, { map: tex, vc: true, floor: 2 }) : this.mat('shirt', '#ffffff', { map: tex, vc: true, floor: 2, rim: 0.15 });
    const per = pal.lawnStyle === 'pixel' ? 4 : 2.6;
    const keep = ['position', 'normal', 'uv', 'color'];
    // home plate's circle, cut off by the backstop, dug in where the batters and the catcher stand
    this.add(dirt, this.skinGeometry(per), { receive: true, order: -3 });
    // the mound
    const mg = this.moundGeometry(per);
    this.add(dirt, only(mg.attributes.color ? mg : paint(mg, pal.dirt), keep), { receive: true, cast: this.world === 'paper' || this.world === 'pixel' });
    // the warning track: in front of the wall, pole to pole
    const P = this.fence;
    const pos: number[] = [],
      uvs: number[] = [],
      idx: number[] = [];
    P.forEach((p, i) => {
      const x0 = p.x - p.nx * TRACK,
        z0 = p.z - p.nz * TRACK;
      pos.push(x0, Y.dirt, z0, p.x + p.nx * 0.02, Y.dirt, p.z + p.nz * 0.02);
      uvs.push(x0 / per, -z0 / per, p.x / per, -p.z / per);
      if (i > 0) {
        const a = (i - 1) * 2,
          b = i * 2;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    });
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    tg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    tg.setIndex(idx);
    tg.computeVertexNormals();
    if ((tg.attributes.normal as THREE.BufferAttribute).getY(0) < 0) flipWinding(tg);
    tg.computeVertexNormals();
    this.add(dirt, only(paint(tg, pal.track), keep), { receive: true });
    // the glowing worlds: the dirt's edges in light
    if (pal.glow) {
      const edge = this.glowMat(pal.chalk, 1.5, { floor: 3 });
      const ring = (cx: number, cz: number, r: number, w: number, y: number, clip?: (x: number) => number) => {
        const out: THREE.BufferGeometry[] = [];
        const n = 96;
        for (let i = 0; i < n; i++) {
          const a0 = (i / n) * Math.PI * 2,
            a1 = ((i + 1) / n) * Math.PI * 2;
          const x0 = cx + Math.cos(a0) * r,
            z0 = cz + Math.sin(a0) * r,
            x1 = cx + Math.cos(a1) * r,
            z1 = cz + Math.sin(a1) * r;
          if (clip && (z0 > clip(x0) || z1 > clip(x1))) continue;
          out.push(stripe(x0, z0, x1, z1, w, y));
        }
        return out;
      };
      for (const g of ring(0, SKIN.z, SKIN.r, 0.05, Y.chalk, (x) => backstopZ(x))) this.add(edge, only(g, ['position', 'normal']), { order: -4 });
      for (const g of ring(0, FIELD.moundCZ, FIELD.moundR, 0.05, Y.chalk)) this.add(edge, only(g, ['position', 'normal']));
      for (const g of ring(0, FIELD.moundCZ, FIELD.moundTop, 0.04, FIELD.moundH + Y.chalk)) this.add(edge, only(g, ['position', 'normal']));
      // the track's inner edge
      for (let i = 1; i < P.length; i++) {
        const p = P[i - 1],
          q = P[i];
        this.add(edge, only(stripe(p.x - p.nx * TRACK, p.z - p.nz * TRACK, q.x - q.nx * TRACK, q.z - q.nz * TRACK, 0.05, Y.chalk), ['position', 'normal']));
      }
    }
  }

  /**
   * Home plate's dirt: a polar grid, so it can be worn — darker where the
   * batters dig in, round the plate and where the catcher squats (flat in the
   * pixel and glowing worlds) — cut off at the backstop.
   */
  private skinGeometry(per: number) {
    const rings = 16,
      seg = 96;
    const base = new THREE.Color(this.pal.dirt);
    const dark = base.clone().multiplyScalar(0.8);
    const worn = !this.pal.glow && this.world !== 'pixel';
    const pos: number[] = [],
      uvs: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    const c = new THREE.Color();
    const blob = (x: number, z: number, cx: number, cz: number, rx: number, rz: number) => 1 - THREE.MathUtils.smoothstep(Math.hypot((x - cx) / rx, (z - cz) / rz), 0.35, 1);
    const vert = (x: number, z: number) => {
      z = Math.min(z, backstopZ(x) + 0.05);
      pos.push(x, Y.dirt, z);
      uvs.push(x / per, -z / per);
      let k = 0;
      if (worn) {
        for (const sx of [-1, 1]) k = Math.max(k, blob(x, z, sx * FIELD.boxX, 11.8, 0.62, 0.95));
        k = Math.max(k, 0.55 * blob(x, z, 0, 11.75, 0.75, 0.6), 0.75 * blob(x, z, 0, FIELD.catcherZ, 0.7, 0.55));
        // a little unevenness everywhere
        k += (Math.sin(x * 7.1 + z * 3.3) * Math.sin(z * 5.7 - x * 2.1)) * 0.08;
      }
      c.copy(base).lerp(dark, THREE.MathUtils.clamp(k, 0, 1));
      col.push(c.r, c.g, c.b);
    };
    vert(0, SKIN.z);
    for (let r = 1; r <= rings; r++) {
      const rad = (r / rings) * SKIN.r;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        vert(Math.cos(a) * rad, SKIN.z + Math.sin(a) * rad);
      }
    }
    for (let s = 0; s < seg; s++) idx.push(0, 1 + ((s + 1) % seg), 1 + s);
    for (let r = 1; r < rings; r++)
      for (let s = 0; s < seg; s++) {
        const a = 1 + (r - 1) * seg + s,
          b = 1 + (r - 1) * seg + ((s + 1) % seg);
        idx.push(a, b, a + seg, b, b + seg, a + seg);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    if ((g.attributes.normal as THREE.BufferAttribute).getY(0) < 0) {
      flipWinding(g);
      g.computeVertexNormals();
    }
    return g;
  }

  /** The mound: a dome of dirt as field.ts shapes it — stacked card in paper, stepped blocks in pixel. */
  private moundGeometry(per: number) {
    const cz = FIELD.moundCZ;
    if (this.world === 'paper' || this.world === 'pixel') {
      // layers: [radius, top]
      const steps: [number, number][] =
        this.world === 'paper'
          ? [
              [FIELD.moundR, FIELD.moundH * 0.34],
              [(FIELD.moundR + FIELD.moundTop) / 2, FIELD.moundH * 0.68],
              [FIELD.moundTop, FIELD.moundH],
            ]
          : [
              [FIELD.moundR * 0.82, FIELD.moundH * 0.5],
              [FIELD.moundTop + 0.05, FIELD.moundH],
            ];
      const parts: THREE.BufferGeometry[] = [];
      const seg = this.world === 'pixel' ? 8 : 48;
      for (const [r, top] of steps) {
        const c = new THREE.CylinderGeometry(r, r, top, seg, 1);
        if (this.world === 'pixel') c.rotateY(Math.PI / 8);
        c.translate(0, top / 2 + Y.dirt - 0.004, cz);
        const p = c.attributes.position as THREE.BufferAttribute;
        const uv = c.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / per, -p.getZ(i) / per + p.getY(i));
        parts.push(c);
      }
      const g = mergeGeometries(parts, false)!;
      parts.forEach((p) => p.dispose());
      return g;
    }
    // a polar grid, the dome's height from moundY(), worn in front of the rubber where the stride lands
    const rings = 14,
      seg = 72;
    const pos: number[] = [],
      uvs: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    const base = new THREE.Color(this.pal.dirt);
    const dark = base.clone().multiplyScalar(0.8);
    const worn = !this.pal.glow;
    const c = new THREE.Color();
    const blob = (x: number, z: number, bx: number, bz: number, rx: number, rz: number) => 1 - THREE.MathUtils.smoothstep(Math.hypot((x - bx) / rx, (z - bz) / rz), 0.3, 1);
    const tint = (x: number, z: number) => {
      const k = worn ? Math.max(0.85 * blob(x, z, 0, FIELD.moundZ + 1.15, 0.5, 0.62), 0.6 * blob(x, z, 0, FIELD.moundZ, 0.62, 0.34)) + Math.sin(x * 6.3 + z * 4.1) * Math.sin(z * 5.1 - x * 3.7) * 0.07 : 0;
      c.copy(base).lerp(dark, THREE.MathUtils.clamp(k, 0, 1));
      col.push(c.r, c.g, c.b);
    };
    pos.push(0, FIELD.moundH + Y.dirt, cz);
    uvs.push(0, -cz / per);
    tint(0, cz);
    for (let r = 1; r <= rings; r++) {
      // rings bunched on the slope, where the shape is
      const u = r / rings;
      const rad = u < 0.3 ? (u / 0.3) * FIELD.moundTop : FIELD.moundTop + ((u - 0.3) / 0.7) * (FIELD.moundR - FIELD.moundTop);
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const x = Math.cos(a) * rad,
          z = cz + Math.sin(a) * rad;
        pos.push(x, moundY(x, z) + Y.dirt, z);
        uvs.push(x / per, -z / per);
        tint(x, z);
      }
    }
    for (let s = 0; s < seg; s++) idx.push(0, 1 + ((s + 1) % seg), 1 + s);
    for (let r = 1; r < rings; r++)
      for (let s = 0; s < seg; s++) {
        const a = 1 + (r - 1) * seg + s,
          b = 1 + (r - 1) * seg + ((s + 1) % seg);
        const c = a + seg,
          d = b + seg;
        idx.push(a, b, c, b, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    if ((g.attributes.normal as THREE.BufferAttribute).getY(0) < 0) {
      flipWinding(g);
      g.computeVertexNormals();
    }
    return g;
  }

  /** Chalk: the foul lines, the batter's and catcher's boxes; home plate and the rubber (vertex-coloured). */
  private buildChalk() {
    const pal = this.pal;
    const chalk = pal.glow ? this.glowMat('#ffffff', 1.7, { vc: true, floor: 3 }) : this.mat('shirt', '#ffffff', { vc: true, floor: 3, rim: 0.2 });
    const keep = ['position', 'normal', 'color'];
    const lineCol = pal.chalk;
    const put = (g: THREE.BufferGeometry, css: string, cast = false) => this.add(chalk, only(paint(g, css), keep), { receive: true, cast, order: -4 });
    const w = LINE_W;
    const y = Y.chalk;
    // the foul lines: from the batter's box to the wall, then up it
    for (const sx of [-1, 1]) {
      const t0 = (HOME_Z - BOX.z0) / Math.cos(A);
      const t1 = fenceAt(A);
      put(stripe(sx * Math.sin(A) * t0, HOME_Z - Math.cos(A) * t0, sx * Math.sin(A) * t1, HOME_Z - Math.cos(A) * t1, w, y), lineCol);
    }
    // the batter's boxes
    for (const sx of [-1, 1]) {
      const x0 = sx * BOX.x0,
        x1 = sx * BOX.x1;
      put(stripe(x0, BOX.z0, x1, BOX.z0, w, y), lineCol);
      put(stripe(x0, BOX.z1, x1, BOX.z1, w, y), lineCol);
      put(stripe(x0, BOX.z0 - w / 2, x0, BOX.z1 + w / 2, w, y), lineCol);
      put(stripe(x1, BOX.z0 - w / 2, x1, BOX.z1 + w / 2, w, y), lineCol);
    }
    // the catcher's box
    for (const sx of [-1, 1]) put(stripe(sx * CBOX.halfX, BOX.z1, sx * CBOX.halfX, CBOX.z1 + w / 2, w, y), lineCol);
    put(stripe(-CBOX.halfX, CBOX.z1, CBOX.halfX, CBOX.z1, w, y), lineCol);
    // home plate: white rubber, its black bevel showing round it
    const front = HOME_Z - PLATE.half * 2;
    const penta = (k: number): [number, number][] => [
      [-PLATE.half - k, front - k],
      [PLATE.half + k, front - k],
      [PLATE.half + k, front + PLATE.side],
      [0, HOME_Z + k * 1.4],
      [-PLATE.half - k, front + PLATE.side],
    ];
    put(flatPoly(penta(0.018), Y.plate - 0.006), pal.plateEdge);
    put(flatPoly(penta(0), Y.plate), '#ffffff');
    // the rubber, on the mound's flat top
    const top = FIELD.moundH + Y.dirt;
    const rub = new THREE.BoxGeometry(RUBBER.w, 0.03, RUBBER.d);
    rub.translate(0, top + 0.008, FIELD.moundZ);
    put(rub, '#ffffff', true);
  }

  /**
   * The outfield wall along fenceAt(): the painted face, the home-run line on
   * top, its back and ends (the padding's colour), and the warning track's
   * chalk. Paper's is a sheet of card on folded braces; clay's has a round top.
   */
  private buildWall() {
    const pal = this.pal;
    const P = this.fence;
    const T = pal.thick;
    const art = this.artMaterial();
    const body = pal.glow ? this.mat('shirt', pal.padDark, { rim: 0.5 }) : this.mat('shirt', pal.padDark, { rim: 0.4 });
    const at = this.atlas;
    const cw = at.canvas.width,
      ch = at.canvas.height;
    const round = this.world === 'clay';
    const faceTop = round ? WALL_H - T / 2 : WALL_H;
    // the painted face (its texture is the whole wall, left pole to right)
    const u = (s: number) => (at.wall.x + (s / this.wallLen) * at.wall.w) / cw;
    const vTop = 1 - at.wall.y / ch,
      vBot = 1 - (at.wall.y + at.wall.h) / ch;
    const vAt = (y: number) => vBot + (vTop - vBot) * (y / WALL_H);
    this.add(art, band(P, 0, faceTop, 0, -1, (i, top) => [u(P[i].s), top ? vAt(faceTop) : vBot]), { cast: true, outline: 0 });
    // its back
    this.add(body, only(band(P, 0, faceTop, T, 1), ['position', 'normal']), { cast: true, receive: true, outline: 1 });
    // the top: the home-run line (flat, or a rounded clay cap)
    if (round) {
      const n = 8;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI,
          a1 = ((k + 1) / n) * Math.PI;
        const pos: number[] = [],
          idx: number[] = [];
        P.forEach((p, i) => {
          for (const a of [a0, a1]) {
            const o = T / 2 - Math.cos(a) * (T / 2);
            const yy = faceTop + Math.sin(a) * (T / 2);
            pos.push(p.x + p.nx * o, yy, p.z + p.nz * o);
          }
          if (i > 0) {
            const aa = (i - 1) * 2,
              b = i * 2;
            idx.push(aa, b, aa + 1, b, b + 1, aa + 1);
          }
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        if ((g.attributes.normal as THREE.BufferAttribute).getY(Math.floor(P.length / 2) * 2) < 0) flipWinding(g);
        g.computeVertexNormals();
        this.add(this.accent, g, { cast: true, outline: 1 });
      }
    } else this.add(this.accent, ledge(P, -0.005, T + 0.005, WALL_H), { cast: true, outline: 1 });
    // the ends, by the foul poles
    for (const i of [0, P.length - 1]) {
      const p = P[i];
      const e = new THREE.BufferGeometry();
      const x0 = p.x,
        z0 = p.z,
        x1 = p.x + p.nx * T,
        z1 = p.z + p.nz * T;
      e.setAttribute('position', new THREE.Float32BufferAttribute([x0, 0, z0, x1, 0, z1, x1, faceTop, z1, x0, faceTop, z0], 3));
      e.setIndex([0, 1, 2, 0, 2, 3]);
      e.computeVertexNormals();
      // face out of the wall (away from its middle)
      const out = i === 0 ? -1 : 1;
      const nrm = e.attributes.normal as THREE.BufferAttribute;
      const tx = -p.nz,
        tz = p.nx; // along the wall, left → right
      if ((nrm.getX(0) * tx + nrm.getZ(0) * tz) * out < 0) {
        flipWinding(e);
        e.computeVertexNormals();
      }
      this.add(body, only(e, ['position', 'normal']), { cast: true, outline: 1 });
    }
    // paper: folded card braces holding the sheet up
    if (this.world === 'paper') {
      const brace = body;
      for (let s = 1; s < this.wallLen - 0.5; s += 2.2) {
        const i = P.findIndex((p) => p.s >= s);
        const p = P[i];
        const g = new THREE.BufferGeometry();
        const d = 0.7;
        const bx = p.x + p.nx * T,
          bz = p.z + p.nz * T;
        g.setAttribute('position', new THREE.Float32BufferAttribute([bx, 0, bz, bx + p.nx * d, 0, bz + p.nz * d, bx, WALL_H * 0.72, bz], 3));
        g.setIndex([0, 1, 2, 0, 2, 1]);
        g.computeVertexNormals();
        this.add(brace, only(g, ['position', 'normal']), { cast: true, outline: 1 });
      }
    }
  }

  /** The foul poles (with their screens) and the flag poles behind the wall. */
  private buildPoles() {
    const pal = this.pal;
    const sq = pal.square;
    const metal = pal.glow ? this.glowMat(pal.metal, 1.4) : this.mat('shirt', pal.metal, { rim: 0.4 });
    // foul poles: at the wall's ends, on the foul lines; the screen on their fair side, facing home
    for (const sx of [-1, 1]) {
      const a = sx * A;
      const p = fieldPoint(a, fenceAt(a) + 0.12);
      const pole = sq ? new THREE.BoxGeometry(POLE.r * 2, POLE.h, POLE.r * 2) : new THREE.CylinderGeometry(POLE.r * 0.85, POLE.r, POLE.h, 12);
      pole.translate(p.x, POLE.h / 2, p.z);
      this.add(this.accent, only(pole, ['position', 'normal']), { cast: true, outline: 1 });
      const cap = sq ? new THREE.BoxGeometry(0.26, 0.26, 0.26) : new THREE.SphereGeometry(0.13, 12, 8);
      cap.translate(p.x, POLE.h + 0.06, p.z);
      this.add(this.accent, only(cap, ['position', 'normal']), { cast: true, outline: 1 });
      // the screen: fair of the pole (towards centre), square to the line from home
      const w = POLE.screen,
        y0 = WALL_H + 0.25,
        y1 = POLE.h - 0.45;
      const scr = new THREE.BoxGeometry(w, y1 - y0, 0.03);
      // across the line from home: its x axis along (cos a, sin a) turned to the fair side
      scr.translate(-sx * (w / 2 + POLE.r * 0.6), (y0 + y1) / 2, 0);
      scr.rotateY(-a);
      scr.translate(p.x, 0, p.z);
      this.add(this.accent, only(scr, ['position', 'normal']), { cast: true, outline: 1 });
    }
    // flag poles behind the wall
    const T = pal.thick;
    for (const deg of FLAG_POLE.at) {
      const a = (deg * Math.PI) / 180;
      const p = fieldPoint(a, fenceAt(a) + T + 0.3);
      const g = sq ? new THREE.BoxGeometry(FLAG_POLE.r * 2, FLAG_POLE.h, FLAG_POLE.r * 2) : new THREE.CylinderGeometry(FLAG_POLE.r * 0.8, FLAG_POLE.r, FLAG_POLE.h, 8);
      g.translate(p.x, FLAG_POLE.h / 2, p.z);
      this.add(metal, only(g, ['position', 'normal']), { cast: true, outline: 0.8 });
      const ball = sq ? new THREE.BoxGeometry(0.12, 0.12, 0.12) : new THREE.SphereGeometry(0.07, 10, 6);
      ball.translate(p.x, FLAG_POLE.h + 0.04, p.z);
      this.add(metal, only(ball, ['position', 'normal']), { outline: 0.8 });
    }
  }

  /** The low padded backstop behind the catcher, HOME RUN DERBY on its face. */
  private buildBackstop() {
    const pal = this.pal;
    const B = BACKSTOP;
    const art = this.artMaterial();
    const body = this.mat('shirt', pal.padDark, { rim: 0.4 });
    const top = this.mat('shirt', pal.pad, { rim: 0.4 });
    const n = 40;
    const th = Math.asin(B.halfX / B.R);
    const c = B.z - B.R;
    const pts: { x: number; z: number; nx: number; nz: number; s: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const t = -th + (2 * th * i) / n;
      const x = Math.sin(t) * B.R,
        z = c + Math.cos(t) * B.R;
      // outward = away from the field (+z-ish)
      pts.push({ x, z, nx: Math.sin(t), nz: Math.cos(t), s: (t + th) * B.R });
    }
    const len = 2 * th * B.R;
    const at = this.atlas;
    const cw = at.canvas.width,
      ch = at.canvas.height;
    // (seen from the field, looking at home, +x is on the left: the lettering runs from +x to −x)
    const u = (s: number) => (at.back.x + (1 - s / len) * at.back.w) / cw;
    const vTop = 1 - at.back.y / ch,
      vBot = 1 - (at.back.y + at.back.h) / ch;
    this.add(art, band(pts, 0, B.h, 0, -1, (i, t) => [u(pts[i].s), t ? vTop : vBot]), { cast: true, outline: 0 });
    this.add(body, only(band(pts, 0, B.h, B.t, 1), ['position', 'normal']), { cast: true, outline: 1 });
    this.add(top, ledge(pts, -0.01, B.t + 0.01, B.h), { cast: true, outline: 1 });
    for (const i of [0, n]) {
      const p = pts[i];
      const cap = pal.square ? new THREE.BoxGeometry(B.t + 0.04, B.h + 0.04, B.t + 0.04) : new THREE.CylinderGeometry(B.t / 2 + 0.02, B.t / 2 + 0.02, B.h + 0.04, 12);
      cap.translate(p.x + p.nx * (B.t / 2), (B.h + 0.04) / 2, p.z + p.nz * (B.t / 2));
      this.add(top, only(cap, ['position', 'normal']), { cast: true, outline: 1 });
    }
  }

  /** The on-deck circles either side of home (the atlas's mat). */
  private buildDecks() {
    const art = this.artMaterial();
    const at = this.atlas;
    const cw = at.canvas.width,
      ch = at.canvas.height;
    const d = at.deck;
    for (const sx of [-1, 1]) {
      const cx = sx * FIELD.onDeckX,
        cz = FIELD.onDeckZ;
      const g = flatPoly(circlePts(cx, cz, DECK_R, 40), Y.deck);
      const p = g.attributes.position as THREE.BufferAttribute;
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const lx = (p.getX(i) - cx) / (2 * DECK_R) + 0.5,
          lz = (p.getZ(i) - cz) / (2 * DECK_R) + 0.5;
        uv.setXY(i, (d.x + lx * d.w) / cw, 1 - (d.y + lz * d.h) / ch);
      }
      this.add(art, g, { receive: true, outline: 0 });
    }
  }
}

/** Is (x, y, z) on the park's own ground (fair inside the wall, or foul ground short of the stands)? */
function onField(x: number, y: number, z: number) {
  if (y > 0.4) return false;
  const sp = sprayOf(x, z);
  if (Math.abs(sp.a) <= A) return sp.r < fenceAt(sp.a) - 0.05;
  return Math.abs(x) < LAWN.halfX && z < LAWN.back && sp.r < FIELD.fencePole;
}

/** 0 → 1 with a springy overshoot. */
function elastic(t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.pow(2, -9 * t) * Math.cos(t * 3.2 * Math.PI);
}

/** A five-pointed star, extruded (a chunky low-poly one in the pixel world), facing ±z, about 1 across. */
function starGeometry(blocky: boolean) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 0.45 : 1;
    const x = Math.cos(a) * r,
      y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, blocky ? { depth: 0.4, bevelEnabled: false } : { depth: 0.24, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 2 });
  g.center();
  g.deleteAttribute('uv');
  return g;
}
