// The archery range: a shooting-line platform at the near end of where the
// tennis court was, a lawn down to the targets with a chalk line every 5 m, a
// netted backstop with hay bales across the back and nets down the sides, and
// — from the RangeView, every frame — the target faces on their stands (a
// tower for a raised one, a hanging frame for a swaying one), balloons on
// strings, the arrows (flying with a light trail, or stuck where they landed),
// wind flags, and the hit, pop and thunk effects. Built from the world's
// MaterialKit like the other venues, so each art style draws it its own way.
// The static parts are merged into one mesh per material; everything that
// comes and goes (faces, stands, balloons, arrows) is instanced, so the draw
// calls don't grow with the number of targets or arrows.
//
// Layout (world metres, see range.ts): the archer stands on the shooting line
// at z = RANGE.lineZ facing −z; targets stand inside RANGE's box. A face is a
// disc of radius r centred on (x, y, z) in the plane z = const, looking along
// +z; its boss (the straw behind it) and stand are behind that plane, so
// nothing an arrow could hit sits in front of it.
//
// The view, as the game fills it in:
//   - an arrow's (x, y, z) is its point, and it's drawn back along (dx, dy, dz);
//     a stuck arrow's point is already ARROW.sink deep in what it hit. 'nocked'
//     arrows aren't drawn (ArcheryGear puts the arrow on the bow) unless
//     opts.drawNocked. An arrow stuck in a target (target ≥ 0) moves with it,
//     whether or not the game moves its x.
//   - a target's x is live (its sway applied); a popped balloon is
//     visible: false, popped: true (its string drops to the ground).
//   - arrows that miss everything stop at the backstop (z = −19.5, up to 12 m)
//     or at the side nets (x = ±11): the range draws nets there, and hay bales
//     along the bottom of the back one.
//
// Roles picked from the kit (as in bowling/venue.ts and duel/venue.ts):
//   'shirt'  lawn, straw, stands, flags     'hair'   the platform's planks
//   'racket' accents: chalk lines, balloons, arrows (glossy; glowing in neon)
// Faces use their own material: unlit (full-strength colours, which every
// post pass then turns into its own look) or the kit's, lit, where the world's
// light falls on them from the front (paper, clay).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit, CharRole } from '../worlds/types';
import type { RangeVenueLike } from '../worlds/base';
import { Particles, type Shape } from '../render/particles';
import { outlineTree, outlineMaterial } from '../render/outline';
import { canvasTex } from '../worlds/mats';
import { NOISE } from '../render/glsl';
import { Rng } from '../core/math';
import { RANGE } from './range';
import { LINE } from './anim';
import { ARROW, arrowGeometry, gearStyle } from './bow';
import { balloonColor } from './balloons';
import type { RangeView, RangeFx, TargetDef, ArrowView } from './types';

/** the boss (the straw behind a face): its radius over the face's, and its depth */
const BOSS = { k: 1.13, depth: 0.26 };
/** where arrows that miss everything stop (the game's walls): the back, how high it goes, the sides */
const BACKSTOP = { z: -19.5, top: 12, sideX: 11 };
/** the nets sit this far in front of those walls, so a stopped arrow's point is in the net */
const NET_IN = ARROW.sink;
/** the lawn: out to the side nets, from behind the platform to under the backstop */
const LAWN = { halfX: BACKSTOP.sideX + 0.3, near: RANGE.lineZ + 3.2, far: BACKSTOP.z - 1.3 };
/** the chalked lane: its side lines, and a line across it every 5 m from the shooting line */
const CHALK_X = 8.0;
const LINES_EVERY = 5;
/** the wind flags down the sides: x, and the z of each pole */
const FLAG_X = 8.6;
const FLAG_Z = [7.5, -2.5, -12.5];
const POLE_H = 3.4;
/** limits (instances) */
const MAX_T = 24;
const MAX_ARROWS = 96;
const MAX_STRUTS = 480;
const MAX_DECKS = 32;
const MAX_ROPES = 96;
const MAX_TRAILS = 8;
const TRAIL_N = 24;
const MAX_FLAGS = FLAG_Z.length * 2 + MAX_T;

// ---------------------------------------------------------------- per-world look

interface FacePal {
  /** the five colour zones, centre out: 10–9, 8–7, 6–5, 4–3, 2–1 */
  zones: [string, string, string, string, string];
  /** the ring lines, and the lines on a dark zone */
  line: string;
  lineDark: string;
  /** which zones are dark (their lines are drawn in lineDark) */
  darkZones: number[];
  /** texture style: plain rings, glowing tubes, flat pixel bands, hand-made */
  style: 'classic' | 'glow' | 'pixel' | 'paper' | 'clay' | 'wash' | 'ink';
}

interface Pal {
  face: FacePal;
  /** lit by the kit (the world's light falls on the front of it), or unlit at this strength */
  faceLit: boolean;
  faceGlow: number;
  boss: string;
  bossStyle: 'straw' | 'dark' | 'block' | 'card';
  /** glowing rim round the face (neon, cosmic) */
  bossRim?: string;
  wood: string;
  deck: string;
  rope: string;
  lawn: [string, string];
  chalk: string;
  plank: string;
  trim: string;
  flags: string[];
  /** the backstop's net (colour, opacity) and the bales' twine */
  net: string;
  netA: number;
  twine: string;
  /** unlit HDR accents (lines, trims) */
  glow: boolean;
  /** square posts (pixel, paper) or round */
  square: boolean;
}

const PAL: Record<string, Pal> = {
  park: {
    face: { zones: ['#ffd83d', '#f04a3c', '#27a9e6', '#2c2a33', '#fbfaf6'], line: '#2c2a33', lineDark: '#e8e6e0', darkZones: [3], style: 'classic' },
    faceLit: false,
    faceGlow: 0.97,
    boss: '#e6c47a',
    bossStyle: 'straw',
    wood: '#c9935e',
    deck: '#e7b27a',
    rope: '#f4efe4',
    lawn: ['#8ccb62', '#7dbe57'],
    chalk: '#ffffff',
    plank: '#e7b27a',
    trim: '#ffffff',
    flags: ['#ffd23c'],
    net: '#ffffff',
    netA: 0.45,
    twine: '#7a5a38',
    glow: false,
    square: false,
  },
  plaza: {
    face: { zones: ['#ffd23c', '#ff4f64', '#3aa8ff', '#2b2f47', '#ffffff'], line: '#2b2f47', lineDark: '#ffffff', darkZones: [3], style: 'classic' },
    faceLit: false,
    faceGlow: 1,
    boss: '#f2c86e',
    bossStyle: 'straw',
    wood: '#e0894a',
    deck: '#f2bf7c',
    rope: '#ffffff',
    lawn: ['#8ed86a', '#7ccb5a'],
    chalk: '#ffffff',
    plank: '#f2bf7c',
    trim: '#ff5a6e',
    flags: ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a'],
    net: '#ffffff',
    netA: 0.55,
    twine: '#b0602e',
    glow: false,
    square: false,
  },
  ink: {
    // a kasumi-mato: rings of ink on paper round a vermilion heart (only red survives the ink)
    face: { zones: ['#d8321f', '#1a1613', '#f1e8d4', '#1a1613', '#f1e8d4'], line: '#1a1613', lineDark: '#f1e8d4', darkZones: [1, 3], style: 'ink' },
    faceLit: false,
    faceGlow: 1,
    boss: '#d9cbb0',
    bossStyle: 'straw',
    wood: '#2e2822',
    deck: '#6b5a48',
    rope: '#2a2520',
    lawn: ['#e9e1cf', '#ded5c2'],
    chalk: '#2a2520',
    plank: '#8a7a64',
    trim: '#2a2520',
    flags: ['#f1e8d4', '#d8321f'],
    net: '#2a2520',
    netA: 0.45,
    twine: '#2a2520',
    glow: false,
    square: false,
  },
  neon: {
    face: { zones: ['#ffd23f', '#ff2fb4', '#22e6ff', '#8b3bff', '#e8dcff'], line: '#ffffff', lineDark: '#ffffff', darkZones: [], style: 'glow' },
    faceLit: false,
    faceGlow: 1.45,
    boss: '#0c0618',
    bossStyle: 'dark',
    bossRim: '#22e6ff',
    wood: '#1a0f3a',
    deck: '#150a33',
    rope: '#ff2fb4',
    lawn: ['#0d0620', '#110828'],
    chalk: '#22e6ff',
    plank: '#1a0f3a',
    trim: '#ff2fb4',
    flags: ['#ff2fb4', '#22e6ff'],
    net: '#ff2fb4',
    netA: 0.7,
    twine: '#22e6ff',
    glow: true,
    square: false,
  },
  pixel: {
    face: { zones: ['#ffec27', '#ff004d', '#29adff', '#1d2b53', '#fff1e8'], line: '#1d2b53', lineDark: '#fff1e8', darkZones: [3], style: 'pixel' },
    faceLit: false,
    faceGlow: 1,
    boss: '#ffa300',
    bossStyle: 'block',
    wood: '#ab5236',
    deck: '#5f574f',
    rope: '#fff1e8',
    lawn: ['#00b43c', '#00a83a'],
    chalk: '#fff1e8',
    plank: '#ab5236',
    trim: '#ffa300',
    flags: ['#ffec27'],
    net: '#fff1e8',
    netA: 0.5,
    twine: '#5f574f',
    glow: false,
    square: true,
  },
  paper: {
    face: { zones: ['#ffd66b', '#e76f51', '#5aa9e6', '#3d3540', '#fffdf5'], line: '#3d3540', lineDark: '#fffdf5', darkZones: [3], style: 'paper' },
    faceLit: true,
    faceGlow: 1,
    boss: '#d9b27c',
    bossStyle: 'card',
    wood: '#c49a6c',
    deck: '#d9b27c',
    rope: '#fffdf5',
    lawn: ['#a3d48f', '#95c982'],
    chalk: '#fffdf5',
    plank: '#dcb67f',
    trim: '#fffdf5',
    flags: ['#e76f51', '#ffd66b', '#5aa9e6'],
    net: '#fffdf5',
    netA: 0.6,
    twine: '#8b5a3c',
    glow: false,
    square: true,
  },
  clay: {
    face: { zones: ['#ffd35c', '#e84a3c', '#3f8fd8', '#3a2e2a', '#fbf3e6'], line: '#3a2e2a', lineDark: '#fbf3e6', darkZones: [3], style: 'clay' },
    faceLit: true,
    faceGlow: 1,
    boss: '#e8c178',
    bossStyle: 'straw',
    wood: '#8a5a38',
    deck: '#d8a066',
    rope: '#fff8ea',
    lawn: ['#80c76b', '#73b961'],
    chalk: '#fbf3e6',
    plank: '#d8a066',
    trim: '#fbf3e6',
    flags: ['#ffd35c'],
    net: '#fff8ea',
    netA: 0.5,
    twine: '#6b4a32',
    glow: false,
    square: false,
  },
  water: {
    face: { zones: ['#ffd23a', '#ff5563', '#3f9be0', '#3a3d5c', '#ffffff'], line: '#3a3d5c', lineDark: '#ffffff', darkZones: [3], style: 'wash' },
    faceLit: false,
    faceGlow: 1,
    boss: '#f0d49a',
    bossStyle: 'straw',
    wood: '#a07a5a',
    deck: '#eccca2',
    rope: '#ffffff',
    lawn: ['#8fcf72', '#82c367'],
    chalk: '#ffffff',
    plank: '#eccca2',
    trim: '#ffffff',
    flags: ['#ff9fb2', '#9fc4ff', '#ffe066'],
    net: '#ffffff',
    netA: 0.45,
    twine: '#8a6448',
    glow: false,
    square: false,
  },
  cosmic: {
    face: { zones: ['#ffe38a', '#ff5a8c', '#5ef2ff', '#a86bff', '#e9f7ff'], line: '#ffffff', lineDark: '#ffffff', darkZones: [], style: 'glow' },
    faceLit: false,
    faceGlow: 1.4,
    boss: '#241c46',
    bossStyle: 'dark',
    bossRim: '#a86bff',
    wood: '#3a2f6e',
    deck: '#29224f',
    rope: '#5ef2ff',
    lawn: ['#231c55', '#2a2262'],
    chalk: '#5ef2ff',
    plank: '#29224f',
    trim: '#5ef2ff',
    flags: ['#5ef2ff', '#ff6bd6'],
    net: '#5ef2ff',
    netA: 0.5,
    twine: '#a86bff',
    glow: true,
    square: false,
  },
};

// ---------------------------------------------------------------- effects per world

interface FxStyle {
  /** additive particles: colours are HDR */
  hot: boolean;
  spark: Shape;
  confetti: Shape;
  dust: string[];
  dustShape: Shape;
  bits: string[];
  /** wind motes drifting across the range */
  mote: string[];
  moteShape: Shape;
}

const FX: Record<string, FxStyle> = {
  park: { hot: false, spark: 'star', confetti: 'confetti', dust: ['#efe6d2'], dustShape: 'soft', bits: ['#6fb24c', '#8ccb62'], mote: ['#ffffff'], moteShape: 'soft' },
  plaza: { hot: false, spark: 'star', confetti: 'confetti', dust: ['#fff6e2'], dustShape: 'soft', bits: ['#7ccb5a', '#5fb14a'], mote: ['#ffffff', '#ffe34d'], moteShape: 'soft' },
  ink: { hot: false, spark: 'ink', confetti: 'petal', dust: ['#3b342d'], dustShape: 'ink', bits: ['#15120f'], mote: ['#d8321f', '#e27a6a'], moteShape: 'petal' },
  neon: { hot: true, spark: 'soft', confetti: 'star', dust: ['#22e6ff'], dustShape: 'soft', bits: ['#ff2fb4'], mote: ['#22e6ff', '#ff2fb4'], moteShape: 'soft' },
  pixel: { hot: false, spark: 'square', confetti: 'square', dust: ['#c2c3c7', '#fff1e8'], dustShape: 'square', bits: ['#00e436', '#008751'], mote: ['#fff1e8'], moteShape: 'square' },
  paper: { hot: false, spark: 'confetti', confetti: 'confetti', dust: ['#f4ecd8'], dustShape: 'soft', bits: ['#7cc576', '#fffdf5'], mote: ['#ffffff', '#ffd9d9'], moteShape: 'confetti' },
  clay: { hot: false, spark: 'soft', confetti: 'soft', dust: ['#e9d9b8'], dustShape: 'soft', bits: ['#6cbf5f', '#8a5a38'], mote: ['#fff8ea'], moteShape: 'soft' },
  water: { hot: false, spark: 'soft', confetti: 'petal', dust: ['#f6efe0'], dustShape: 'soft', bits: ['#8fcf72', '#ffffff'], mote: ['#ffd6e7', '#ffffff'], moteShape: 'petal' },
  cosmic: { hot: true, spark: 'star', confetti: 'star', dust: ['#a86bff'], dustShape: 'soft', bits: ['#5ef2ff'], mote: ['#e9f7ff', '#a86bff'], moteShape: 'star' },
};

// ---------------------------------------------------------------- textures

/** a glowing face's zone fills, as a share of their colour (× faceGlow stays under the bloom threshold) */
const GLOW_FILL = 0.6;

/** The face: ten rings in five colour zones, with the ring lines and the inner 10 — drawn per style. */
function faceTexture(p: FacePal) {
  const S = 1024;
  const rng = new Rng(314);
  return canvasTex(S, S, (x) => {
    const c = S / 2;
    const R = S / 2 - 3;
    const glow = p.style === 'glow';
    const hand = p.style === 'clay' || p.style === 'ink';
    x.clearRect(0, 0, S, S);
    // a slightly irregular circle for the hand-made styles
    const circle = (r: number, seed: number) => {
      x.beginPath();
      const n = 128;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const w = hand ? 1 + Math.sin(a * 3 + seed) * 0.004 + Math.sin(a * 7 + seed * 2.3) * 0.003 : 1;
        const px = c + Math.cos(a) * r * w,
          py = c + Math.sin(a) * r * w;
        if (i === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
      }
      x.closePath();
    };
    // the zones, outside in (zone k holds rings 10−2k and 9−2k)
    for (let k = 4; k >= 0; k--) {
      const col = new THREE.Color(p.zones[k]);
      // glowing faces: the fills stay under the bloom's threshold (full colour, no halo), the tubes go over it
      if (glow) col.multiplyScalar(GLOW_FILL);
      x.fillStyle = `#${col.getHexString()}`;
      circle((R * (k + 1)) / 5, k * 1.7);
      x.fill();
    }
    if (p.style === 'pixel') return; // clean bands: at ~270 pixel rows the lines are only noise
    // the ring lines: every ring's edge, and a stronger one between zones
    for (let j = 10; j >= 1; j--) {
      const r = (R * j) / 10;
      const zoneOut = Math.min(4, Math.floor((j - 1) / 2));
      const between = j % 2 === 0;
      if (glow) {
        // a tube of light in the zone's own colour round each zone, a fainter one between its rings
        const zc = new THREE.Color(p.zones[zoneOut]);
        if (!between) zc.multiplyScalar(0.8);
        x.strokeStyle = `#${zc.getHexString()}`;
        x.lineWidth = j === 10 ? 9 : between ? 7 : 2.5;
        circle(r - x.lineWidth / 2, j);
        x.stroke();
        continue;
      }
      const onDark = p.darkZones.includes(zoneOut) && !between;
      x.strokeStyle = onDark ? p.lineDark : p.line;
      x.globalAlpha = between && j < 10 ? 0.75 : 0.95;
      x.lineWidth = j === 10 ? 7 : between ? 3.5 : 3;
      circle(r - x.lineWidth / 2, j * 0.9);
      x.stroke();
      x.globalAlpha = 1;
    }
    // the inner 10 (the X ring) and a little cross
    x.strokeStyle = glow ? '#ffffff' : p.line;
    x.lineWidth = glow ? 4 : 2.5;
    circle(R * 0.05, 3);
    x.stroke();
    x.beginPath();
    x.moveTo(c - 9, c);
    x.lineTo(c + 9, c);
    x.moveTo(c, c - 9);
    x.lineTo(c, c + 9);
    x.stroke();
    // the style's grain
    if (p.style === 'paper' || p.style === 'clay') {
      const img = x.getImageData(0, 0, S, S);
      const d = img.data;
      const amp = p.style === 'paper' ? 16 : 12;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const n = (rng.next() - 0.5) * amp;
        d[i] = Math.max(0, Math.min(255, d[i] + n));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
      }
      x.putImageData(img, 0, 0);
    }
  });
}

/** Straw, near-white so it modulates the boss colour: short fibres every which way. */
function strawTexture() {
  const rng = new Rng(77);
  const t = canvasTex(256, 256, (x) => {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const v = 150 + rng.next() * 90;
      x.strokeStyle = `rgba(${Math.round(v)}, ${Math.round(v * 0.86)}, ${Math.round(v * 0.55)}, ${0.25 + rng.next() * 0.35})`;
      x.lineWidth = 1 + rng.next() * 1.6;
      const px = rng.next() * 256,
        py = rng.next() * 256;
      x.beginPath();
      x.moveTo(px, py);
      x.lineTo(px + (rng.next() - 0.5) * 10, py + 8 + rng.next() * 18);
      x.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Deck planks (as the duel's pier): near-white seams and grain, 8 planks per texture. */
function plankTexture() {
  const rng = new Rng(20260928);
  const S = 512;
  const t = canvasTex(S, S, (x) => {
    const n = 8;
    const ph = S / n;
    for (let b = 0; b < n; b++) {
      const k = 0.88 + rng.next() * 0.12;
      x.fillStyle = `rgb(${Math.round(255 * k)}, ${Math.round(250 * k)}, ${Math.round(240 * k)})`;
      x.fillRect(0, b * ph, S, ph + 1);
      for (let s = 0; s < 5; s++) {
        x.strokeStyle = `rgba(110, 70, 30, ${0.05 + rng.next() * 0.07})`;
        x.lineWidth = 0.8 + rng.next() * 1.4;
        const gy = b * ph + 3 + rng.next() * (ph - 6);
        const off = rng.next() * 6;
        x.beginPath();
        for (let xx = 0; xx <= S; xx += 24) x.lineTo(xx, gy + Math.sin(xx * 0.02 + off) * 1.4);
        x.stroke();
      }
    }
    x.fillStyle = 'rgba(80, 50, 25, 0.55)';
    for (let b = 0; b <= n; b++) x.fillRect(0, b * ph - 1.5, S, 3);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Mowing stripes across the range (a depth cue down it): two bands per repeat. */
function lawnTexture(a: string, b: string, style: string) {
  const rng = new Rng(9);
  const t = canvasTex(64, 256, (x) => {
    x.fillStyle = a;
    x.fillRect(0, 0, 64, 128);
    x.fillStyle = b;
    x.fillRect(0, 128, 64, 128);
    if (style === 'ink') {
      // raked lines down the range
      x.strokeStyle = 'rgba(60,50,40,0.28)';
      x.lineWidth = 2;
      for (let i = 4; i < 64; i += 12) {
        x.beginPath();
        x.moveTo(i, 0);
        x.lineTo(i, 256);
        x.stroke();
      }
      return;
    }
    if (style === 'pixel' || style === 'glow') return;
    for (let i = 0; i < 500; i++) {
      x.fillStyle = `rgba(${rng.next() < 0.5 ? '255,255,255' : '0,40,0'}, ${0.03 + rng.next() * 0.05})`;
      x.fillRect(rng.next() * 64, rng.next() * 256, 1.5, 3);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = style === 'pixel' ? THREE.NearestFilter : THREE.LinearFilter;
  return t;
}

/** Distance boards: "10 m", "20 m", "30 m" side by side (u thirds). */
function signTexture(ink: string, paper: string, font: string) {
  const W = 768,
    H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d')!;
  const draw = () => {
    x.fillStyle = paper;
    x.fillRect(0, 0, W, H);
    ['10', '20', '30'].forEach((n, i) => {
      const cx = (i + 0.5) * (W / 3);
      x.strokeStyle = ink;
      x.lineWidth = 12;
      x.strokeRect(i * (W / 3) + 14, 14, W / 3 - 28, H - 28);
      x.fillStyle = ink;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.font = `700 132px ${font}`;
      x.fillText(n, cx - 20, H / 2 + 8);
      x.font = `700 64px ${font}`;
      x.fillText('m', cx + 76, H / 2 + 36);
    });
  };
  draw();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  // canvas text needs the web font: redraw once it has loaded
  document.fonts
    ?.load(`700 64px Fredoka`)
    .then(() => {
      draw();
      t.needsUpdate = true;
    })
    .catch(() => {});
  return t;
}

// ---------------------------------------------------------------- the backstop's net

const NET_VERT = /* glsl */ `
varying vec2 vP;
#include <common>
#include <fog_pars_vertex>
void main() {
  vP = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const NET_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity; uniform float uCell; uniform float uLine; uniform int uSquare;
varying vec2 vP;
#include <common>
#include <fog_pars_fragment>
void main() {
  // a diamond mesh (squares in the pixel world), drawn with anti-aliased lines;
  // too small to resolve, it fades to its average density instead of shimmering
  vec2 g = vP / uCell;
  if (uSquare == 0) g = vec2(g.x + g.y, g.x - g.y) * 0.70710678;
  vec2 f = abs(fract(g) - 0.5);
  vec2 w = max(fwidth(g), vec2(1e-4));
  float hw = 0.5 * uLine / uCell;
  // distance to the nearest strand and its half width, in pixels: a strand thinner
  // than a pixel is drawn one pixel wide and that much fainter
  vec2 dpx = (0.5 - f) / w;
  vec2 hpx = hw / w;
  vec2 cov = clamp(hpx + 0.5 - dpx, 0.0, 1.0) * min(vec2(1.0), 2.0 * hpx);
  float a = max(cov.x, cov.y);
  float far = smoothstep(0.18, 0.35, max(w.x, w.y));
  a = mix(a, min(1.0, 4.0 * hw), far);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a * uOpacity);
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------- geometry helpers

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** A flat rectangle facing up at height y, uvs in metres / `per` (u across x, v along z). */
function flat(x0: number, x1: number, z0: number, z1: number, y: number, per = 1) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / per, p.getZ(i) / per);
  return g;
}

/** A balloon (radius 1 round its middle, the knot below): a lathe. */
function balloonGeometry(seg: number) {
  const prof: [number, number][] = [
    [0, -1.3],
    [0.12, -1.27],
    [0.13, -1.2],
    [0.07, -1.13],
    [0.16, -1.08],
    [0.42, -0.9],
    [0.72, -0.58],
    [0.93, -0.2],
    [1.0, 0.15],
    [0.96, 0.5],
    [0.8, 0.8],
    [0.5, 1.0],
    [0.0, 1.07],
  ];
  const g = new THREE.LatheGeometry(
    prof.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
  g.deleteAttribute('uv');
  return g;
}

// ---------------------------------------------------------------- instanced parts

/** An InstancedMesh (and its outline hull, sharing the instance matrices) that's refilled every frame. */
class Inst {
  mesh: THREE.InstancedMesh;
  hull: THREE.InstancedMesh | null = null;
  n = 0;
  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    readonly max: number,
    name: string,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  outline(o: { color: THREE.Color; width: number; emissive?: number } | null, scale = 1) {
    if (!o || scale <= 0) return this;
    const h = new THREE.InstancedMesh(this.mesh.geometry, outlineMaterial(o.color, o.width * scale, { emissive: o.emissive }), this.max);
    h.instanceMatrix = this.mesh.instanceMatrix;
    h.name = 'outline';
    h.frustumCulled = false;
    h.count = 0;
    h.castShadow = false;
    this.hull = h;
    this.mesh.add(h);
    return this;
  }

  begin() {
    this.n = 0;
  }

  /** Add an instance with this matrix (ignored past the limit). Returns its index, or −1. */
  push(m: THREE.Matrix4) {
    if (this.n >= this.max) return -1;
    this.mesh.setMatrixAt(this.n, m);
    return this.n++;
  }

  end() {
    this.mesh.count = this.n;
    if (this.hull) this.hull.count = this.n;
    this.mesh.visible = this.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.dispose();
    this.hull?.dispose();
  }
}

// ---------------------------------------------------------------- arrow trails

const TRAIL_VERT = /* glsl */ `
attribute vec3 aTan; attribute vec3 aC; attribute vec2 aS;
uniform float uWidth;
varying float vU; varying float vSide; varying vec3 vC;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 toCam = cameraPosition - wp.xyz;
  float dist = length(toCam);
  vec3 side = cross(aTan, toCam / max(dist, 1e-4));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  // thin at the tail, and a little wider far away so it still reads down the range
  float w = uWidth * (1.0 - 0.8 * aS.y) * (1.0 + 0.035 * max(0.0, dist - 8.0));
  wp.xyz += side * aS.x * w;
  vU = aS.y; vSide = aS.x; vC = aC;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const TRAIL_FRAG = /* glsl */ `
uniform vec3 uCore; uniform float uOpacity; uniform int uMode;
varying float vU; varying float vSide; varying vec3 vC;
${NOISE}
void main() {
  float edge = 1.0 - abs(vSide);
  float a = pow(max(0.0, 1.0 - vU), 1.4) * smoothstep(0.0, 0.45, edge);
  vec3 col = mix(vC, uCore, smoothstep(0.45, 0.95, edge) * (1.0 - vU * 0.7));
  if (uMode == 1) {
    // a dry brush stroke
    float streak = vnoise(vec2(vSide * 5.0 + 3.0, vU * 9.0));
    a *= smoothstep(0.2 + vU * 0.5, 0.5 + vU * 0.4, streak + edge * 0.45);
  } else if (uMode == 2) {
    // pixel steps
    a = step(0.35, a) * step(fract(vU * 7.0), 0.75);
  } else if (uMode == 3) {
    a = step(0.3, a);
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a * uOpacity);
}`;

interface TrailStyle {
  core: string;
  /** how much of the archer's colour the trail takes, over `base` (white unless given) */
  tint: number;
  base?: string;
  hdr: number;
  opacity: number;
  /** 0 smooth, 1 dry brush, 2 pixel steps, 3 hard-edged */
  mode: number;
  additive: boolean;
  width: number;
}

function trailStyle(world: string): TrailStyle {
  switch (world) {
    case 'ink':
      // a stroke of ink (dark survives the ink pass as a brush stroke)
      return { core: '#15120f', tint: 0, base: '#2a2622', hdr: 1, opacity: 0.9, mode: 1, additive: false, width: 0.05 };
    case 'neon':
      return { core: '#ffffff', tint: 0.85, hdr: 2.4, opacity: 0.95, mode: 0, additive: true, width: 0.05 };
    case 'cosmic':
      return { core: '#e8fbff', tint: 0.7, hdr: 2.0, opacity: 0.9, mode: 0, additive: true, width: 0.05 };
    case 'pixel':
      return { core: '#fff1e8', tint: 1, hdr: 1, opacity: 1, mode: 2, additive: false, width: 0.06 };
    case 'paper':
    case 'plaza':
      return { core: '#ffffff', tint: 0.45, hdr: 1, opacity: 0.92, mode: 3, additive: false, width: 0.045 };
    case 'water':
      return { core: '#ffffff', tint: 0.5, hdr: 1, opacity: 0.6, mode: 0, additive: false, width: 0.05 };
    default:
      return { core: '#ffffff', tint: 0.45, hdr: 1, opacity: 0.85, mode: 0, additive: false, width: 0.042 };
  }
}

const WHITE = new THREE.Color('#ffffff');

/**
 * The light trails behind flying arrows: one ribbon per arrow (up to
 * MAX_TRAILS), all in one mesh, turned to face the camera in the vertex
 * shader. A trail keeps the last quarter second of an arrow's flight and
 * fades out once it has landed.
 */
class Trails {
  mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 3);
  private tan = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 3);
  private col = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 3);
  private sd = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 2);
  private mat: THREE.ShaderMaterial;
  /** per trail: its points (newest first) and their ages */
  private pts: Float32Array[] = [];
  private age: Float32Array[] = [];
  private count = new Int32Array(MAX_TRAILS);
  private owner = new Int32Array(MAX_TRAILS).fill(-1);
  private color: THREE.Color[] = [];
  private tint: number;
  private hdr: number;
  private base: THREE.Color;
  private attrs: THREE.BufferAttribute[] = [];
  private static LIFE = 0.26;

  constructor(style: TrailStyle) {
    this.tint = style.tint;
    this.hdr = style.hdr;
    this.base = new THREE.Color(style.base ?? '#ffffff');
    for (let i = 0; i < MAX_TRAILS; i++) {
      this.pts.push(new Float32Array(TRAIL_N * 3));
      this.age.push(new Float32Array(TRAIL_N));
      this.color.push(new THREE.Color());
    }
    const idx: number[] = [];
    for (let t = 0; t < MAX_TRAILS; t++)
      for (let j = 0; j < TRAIL_N - 1; j++) {
        const a = (t * TRAIL_N + j) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    const dyn = (arr: Float32Array, n: number) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', dyn(this.pos, 3));
    this.geo.setAttribute('aTan', dyn(this.tan, 3));
    this.geo.setAttribute('aC', dyn(this.col, 3));
    this.geo.setAttribute('aS', dyn(this.sd, 2));
    this.geo.setIndex(idx);
    for (const k of ['position', 'aTan', 'aC', 'aS']) this.attrs.push(this.geo.attributes[k] as THREE.BufferAttribute);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uWidth: { value: style.width },
        uCore: { value: new THREE.Color(style.core).multiplyScalar(style.hdr) },
        uOpacity: { value: style.opacity },
        uMode: { value: style.mode },
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'arrow-trails';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.userData.noOutline = true;
    this.mesh.userData.noNormals = true;
  }

  /** The trail following arrow slot `a` (a new one if it has none), or −1 when they're all busy. */
  slot(a: number, color: string) {
    for (let t = 0; t < MAX_TRAILS; t++) if (this.owner[t] === a) return t;
    for (let t = 0; t < MAX_TRAILS; t++)
      if (this.owner[t] < 0) {
        this.owner[t] = a;
        this.count[t] = 0;
        this.color[t].set(color).lerp(this.base, 1 - this.tint).multiplyScalar(this.hdr);
        return t;
      }
    return -1;
  }

  /** Forget arrow slot a's trail at once (it's a different arrow now). */
  cut(a: number) {
    for (let t = 0; t < MAX_TRAILS; t++)
      if (this.owner[t] === a) {
        this.owner[t] = -1;
        this.count[t] = 0;
      }
  }

  /** Stop feeding arrow slot a's trail (it landed): it fades out. */
  release(a: number) {
    for (let t = 0; t < MAX_TRAILS; t++) if (this.owner[t] === a) this.owner[t] = -2 - a;
  }

  /** Add the arrow's newest point (its tail) to trail t. */
  push(t: number, x: number, y: number, z: number) {
    const P = this.pts[t],
      A = this.age[t];
    const n = Math.min(TRAIL_N, this.count[t] + 1);
    for (let i = n - 1; i > 0; i--) {
      P[i * 3] = P[(i - 1) * 3];
      P[i * 3 + 1] = P[(i - 1) * 3 + 1];
      P[i * 3 + 2] = P[(i - 1) * 3 + 2];
      A[i] = A[i - 1];
    }
    P[0] = x;
    P[1] = y;
    P[2] = z;
    A[0] = 0;
    this.count[t] = n;
  }

  update(dt: number) {
    let any = false;
    const L = Trails.LIFE;
    for (let t = 0; t < MAX_TRAILS; t++) {
      const A = this.age[t];
      let n = 0;
      for (let i = 0; i < this.count[t]; i++) {
        A[i] += dt;
        if (A[i] < L) n = i + 1;
      }
      this.count[t] = n;
      // a landed arrow's trail is free again once it has faded
      if (n === 0 && this.owner[t] <= -2) this.owner[t] = -1;
      this.write(t);
      if (n >= 2) any = true;
    }
    this.mesh.visible = any;
    if (!any) return;
    for (let i = 0; i < this.attrs.length; i++) this.attrs[i].needsUpdate = true;
  }

  /** Lay trail t's vertices (collapsed into its last point when there's less than two). */
  private write(t: number) {
    const P = this.pts[t],
      A = this.age[t];
    const n = this.count[t];
    const c = this.color[t];
    for (let j = 0; j < TRAIL_N; j++) {
      const i = Math.min(j, Math.max(0, n - 1));
      const a = Math.max(0, i - 1),
        b = Math.min(Math.max(0, n - 1), i + 1);
      let tx = P[a * 3] - P[b * 3],
        ty = P[a * 3 + 1] - P[b * 3 + 1],
        tz = P[a * 3 + 2] - P[b * 3 + 2];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-5) (tx /= tl), (ty /= tl), (tz /= tl);
      else (tx = 0), (ty = 0), (tz = -1);
      // 0 at the arrow → 1 at the trail's end (by age, so it keeps its length at any frame rate)
      const u = n < 2 || j >= n ? 1 : Math.min(1, A[i] / Trails.LIFE);
      for (let s = 0; s < 2; s++) {
        const v = (t * TRAIL_N + j) * 2 + s;
        this.pos[v * 3] = P[i * 3];
        this.pos[v * 3 + 1] = P[i * 3 + 1];
        this.pos[v * 3 + 2] = P[i * 3 + 2];
        this.tan[v * 3] = tx;
        this.tan[v * 3 + 1] = ty;
        this.tan[v * 3 + 2] = tz;
        this.col[v * 3] = c.r;
        this.col[v * 3 + 1] = c.g;
        this.col[v * 3 + 2] = c.b;
        this.sd[v * 2] = s ? 1 : -1;
        this.sd[v * 2 + 1] = u;
      }
    }
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- wind flags

/**
 * Pennants on poles that stream with the wind: one mesh for all of them,
 * rebuilt on the CPU each frame (a few hundred vertices). They swing round
 * their poles when the wind turns, hang limp in a calm and fly flat and
 * flapping in a gale.
 */
class Flags {
  mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private static C = 8;
  private static R = 2;
  private per = (Flags.C + 1) * (Flags.R + 1);
  private anchor = new Float32Array(MAX_FLAGS * 3);
  private size = new Float32Array(MAX_FLAGS * 2);
  private n = 0;
  private dir = 0;
  private stepped: boolean;

  constructor(mat: THREE.Material, colors: string[], stepped: boolean) {
    this.stepped = stepped;
    const per = this.per;
    this.pos = new Float32Array(MAX_FLAGS * per * 3);
    const col = new Float32Array(MAX_FLAGS * per * 3);
    const idx: number[] = [];
    const C = Flags.C,
      R = Flags.R;
    for (let f = 0; f < MAX_FLAGS; f++) {
      const c = new THREE.Color(colors[f % colors.length]);
      for (let i = 0; i < per; i++) col.set([c.r, c.g, c.b], (f * per + i) * 3);
      for (let u = 0; u < C; u++)
        for (let v = 0; v < R; v++) {
          const a = f * per + u * (R + 1) + v;
          const b = a + R + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.pos.length), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.name = 'flags';
    this.mesh.frustumCulled = false;
    this.mesh.userData.noOutline = true;
  }

  begin() {
    this.n = 0;
  }

  /** A flag whose hoist's top is at (x, y, z): its length and height (metres). */
  add(x: number, y: number, z: number, len: number, h: number) {
    if (this.n >= MAX_FLAGS) return;
    const a = this.anchor,
      s = this.size,
      i = this.n;
    a[i * 3] = x;
    a[i * 3 + 1] = y;
    a[i * 3 + 2] = z;
    s[i * 2] = len;
    s[i * 2 + 1] = h;
    this.n++;
  }

  update(time: number, dt: number, wind: number) {
    const C = Flags.C,
      R = Flags.R;
    const k = Math.min(1, Math.abs(wind) / 4.5);
    // swing round the pole to the wind's way (the far side, away from the camera)
    const want = wind >= 0 ? 0 : Math.PI;
    let d = want - this.dir;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.dir += d * Math.min(1, dt * (0.8 + k * 2.5));
    const t = this.stepped ? Math.floor(time * 8) / 8 : time;
    const ex = Math.cos(this.dir),
      ez = -Math.abs(Math.sin(this.dir));
    // droop: from hanging down the pole in a calm to flying out flat
    const droop = THREE.MathUtils.lerp(1.2, 0.12, Math.pow(k, 0.7));
    const cd = Math.cos(droop),
      sd = Math.sin(droop);
    const flap = 0.05 + 0.14 * k;
    const speed = 5 + 9 * k;
    const P = this.pos;
    for (let f = 0; f < MAX_FLAGS; f++) {
      const base = f * this.per;
      if (f >= this.n) {
        for (let i = 0; i < this.per; i++) {
          P[(base + i) * 3] = 0;
          P[(base + i) * 3 + 1] = -50;
          P[(base + i) * 3 + 2] = 0;
        }
        continue;
      }
      const ax = this.anchor[f * 3],
        ay = this.anchor[f * 3 + 1],
        az = this.anchor[f * 3 + 2];
      const len = this.size[f * 2],
        h = this.size[f * 2 + 1];
      const ph = ax * 1.7 + az * 0.9;
      for (let u = 0; u <= C; u++) {
        const uu = u / C;
        const hh = h * (1 - 0.82 * uu); // a pennant, tapering to the fly
        for (let v = 0; v <= R; v++) {
          const vv = v / R;
          // in the flag's plane: out from the pole, and down
          const a = uu * len,
            b = -(vv - 0.5) * hh - h * 0.5;
          // droop: the plane turns down about the hoist's top
          const A = a * cd + b * sd,
            B = -a * sd + b * cd;
          // the flap: a wave running out along the flag, growing to the fly
          const w = Math.sin(t * speed - uu * 5.5 + ph) * flap * len * uu + Math.sin(t * speed * 1.7 + vv * 3 + ph) * 0.015 * uu;
          const i = (base + u * (R + 1) + v) * 3;
          P[i] = ax + ex * A + ez * w;
          P[i + 1] = ay + B;
          P[i + 2] = az + ez * A - ex * w;
        }
      }
    }
    this.normals();
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Each vertex's normal from its neighbours along and across the flag (computeVertexNormals allocates). */
  private normals() {
    const C = Flags.C,
      R = Flags.R;
    const P = this.pos;
    const N = (this.geo.attributes.normal as THREE.BufferAttribute).array as Float32Array;
    const W = R + 1;
    for (let f = 0; f < this.n; f++) {
      const base = f * this.per;
      for (let u = 0; u <= C; u++)
        for (let v = 0; v <= R; v++) {
          // the neighbours along (u) and across (v)
          const a = (base + Math.min(C, u + 1) * W + v) * 3,
            b = (base + Math.max(0, u - 1) * W + v) * 3,
            c = (base + u * W + Math.min(R, v + 1)) * 3,
            d = (base + u * W + Math.max(0, v - 1)) * 3;
          const ax = P[a] - P[b],
            ay = P[a + 1] - P[b + 1],
            az = P[a + 2] - P[b + 2];
          const bx = P[c] - P[d],
            by = P[c + 1] - P[d + 1],
            bz = P[c + 2] - P[d + 2];
          let nx = ay * bz - az * by,
            ny = az * bx - ax * bz,
            nz = ax * by - ay * bx;
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          const i = (base + u * W + v) * 3;
          N[i] = nx;
          N[i + 1] = ny;
          N[i + 2] = nz;
        }
    }
  }

  dispose() {
    this.geo.dispose();
  }
}

// ---------------------------------------------------------------- the range

interface StaticSet {
  geos: THREE.BufferGeometry[];
  cast: boolean;
  receive: boolean;
  /** outline width scale; 0 = none */
  outline: number;
}

interface MatOpts {
  map?: THREE.Texture;
  /** `map` is fine detail: skip it on flat-shaded low-res styles */
  detail?: boolean;
  /** floor-level: a constant depth bias so it wins over a world ground at the same height */
  floor?: number;
  /** cap HDR colours (glow worlds) */
  maxGlow?: number;
  /** scale the kit's rim light */
  rim?: number;
  vc?: boolean;
  side?: THREE.Side;
}

export interface RangeVenueOpts {
  /** the world's particle system (World.particles); without one the range brings its own */
  particles?: Particles;
  /** the world's id (World.def.id): picks the look */
  world?: string;
  /** draw 'nocked' arrows from the view too (normally ArcheryGear draws the arrow on the bow) */
  drawNocked?: boolean;
}

/** What the range remembers about a target between frames. */
interface TargetTrack {
  /** last frame it was in the view */
  seen: number;
  x: number;
  y: number;
  z: number;
  /** hit wobble: angle and its speed */
  wob: number;
  wobV: number;
  /** balloons: when it popped (venue time), and whether it has */
  popT: number;
  popped: boolean;
  color: THREE.Color;
}

/** What the range remembers about an arrow slot between frames. */
interface ArrowTrack {
  state: ArrowView['state'] | '';
  target: number;
  x: number;
  y: number;
  z: number;
  /** stuck in a target: its x relative to the target's x when it stuck */
  offX: number;
  roll: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpC = new THREE.Color();
const UPV = new THREE.Vector3(0, 1, 0);
const NEG_Z = new THREE.Vector3(0, 0, -1);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);

export class RangeVenue implements RangeVenueLike {
  readonly group = new THREE.Group();
  private mats = new Map<string, THREE.Material>();
  private statics = new Map<THREE.Material, StaticSet>();
  private disposables: { dispose(): void }[] = [];
  private particles: Particles;
  private ownParticles = false;
  private pal: Pal;
  private fx: FxStyle;
  private world: string;
  private time = 0;
  private frame = 0;
  private wind = 0;
  private drawNocked: boolean;
  private tracks = new Map<number, TargetTrack>();
  private arrowTracks: ArrowTrack[] = [];
  private camPos = new THREE.Vector3(0, 1.7, RANGE.lineZ + 3);
  private moteT = 0;
  // instanced parts
  private faces: Inst;
  private bosses: Inst;
  private rims: Inst | null = null;
  private struts: Inst;
  private decks: Inst;
  private ropes: Inst;
  private balloons: Inst;
  private arrowBody: Inst;
  private arrowFletch: Inst;
  private parts: Inst[];
  /** the parts the targets are drawn with (refilled every frame) */
  private targetParts: Inst[];
  /** archers' colours, parsed once */
  private colorCache = new Map<string, THREE.Color>();
  private trails: Trails;
  private flags: Flags;
  // effect colours, made once
  private zoneCols: THREE.Color[][];
  private tenCols: THREE.Color[];
  private dustCols: THREE.Color[];
  private bitCols: THREE.Color[];
  private moteCols: THREE.Color[];
  private whiteCols: THREE.Color[];
  private moteDir: [number, number, number] = [1, 0.04, 0];

  constructor(
    private kit: MaterialKit,
    opts: RangeVenueOpts = {},
  ) {
    this.world = opts.world ?? 'park';
    this.pal = PAL[this.world] ?? PAL.park;
    this.fx = FX[this.world] ?? FX.park;
    this.drawNocked = !!opts.drawNocked;
    this.group.name = 'archery';
    const pal = this.pal;
    const shadows = !!kit.castShadow;

    this.buildLawn();
    this.buildPlatform();
    this.buildPoles();
    this.buildSigns();
    this.buildBackstop();
    this.bake();
    if (kit.outline) {
      const o = kit.outline;
      outlineTree(this.group, o.color, o.width, { emissive: o.emissive });
    }
    const ol = kit.outline;

    // ---- targets: faces, bosses, stands (all instanced)
    this.faces = new Inst(this.own(new THREE.CircleGeometry(1, 72)), this.faceMaterial(), MAX_T, 'faces');
    this.faces.mesh.receiveShadow = pal.faceLit && shadows;
    // the boss: a drum behind the face (front at z = 0, back at z = −1), or a block in the pixel world
    let bossGeo: THREE.BufferGeometry;
    if (pal.bossStyle === 'block') bossGeo = new THREE.BoxGeometry(2, 2, 1).translate(0, 0, -0.5);
    else {
      bossGeo = new THREE.CylinderGeometry(1, 1, 1, 40, 1);
      bossGeo.rotateX(Math.PI / 2);
      bossGeo.translate(0, 0, -0.5);
    }
    this.own(bossGeo);
    const straw = pal.bossStyle === 'straw' ? this.own(strawTexture()) : undefined;
    this.bosses = new Inst(bossGeo, this.bossMaterial(straw), MAX_T, 'bosses').outline(ol, 1);
    this.bosses.mesh.castShadow = shadows;
    this.bosses.mesh.receiveShadow = shadows;
    if (pal.bossRim) {
      // a ring of light round the face (neon, cosmic)
      this.rims = new Inst(this.own(new THREE.TorusGeometry(1, 0.022, 8, 72)), this.glow(pal.bossRim, 2.2), MAX_T, 'face-rims');
    }
    const strutGeo = this.own(pal.square ? new THREE.BoxGeometry(1, 1, 1) : new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1));
    this.struts = new Inst(strutGeo, this.mat('shirt', pal.wood, { rim: 0.5 }), MAX_STRUTS, 'struts').outline(ol, 0.8);
    this.struts.mesh.castShadow = shadows;
    this.decks = new Inst(this.own(new THREE.BoxGeometry(1, 1, 1)), this.mat('shirt', pal.deck, { rim: 0.4 }), MAX_DECKS, 'decks').outline(ol, 1);
    this.decks.mesh.castShadow = shadows;
    this.decks.mesh.receiveShadow = shadows;
    const ropeMat = pal.glow ? this.glow(pal.rope, 1.6) : this.mat('shirt', pal.rope, { rim: 0.3 });
    this.ropes = new Inst(this.own(new THREE.CylinderGeometry(0.5, 0.5, 1, 5, 1)), ropeMat, MAX_ROPES, 'ropes');

    // ---- balloons (coloured per instance)
    const bm = this.mat('racket', '#ffffff', { maxGlow: pal.glow ? 1.3 : 1.15 });
    this.balloons = new Inst(this.own(balloonGeometry(24)), bm, MAX_T, 'balloons').outline(ol, 1);
    this.balloons.mesh.castShadow = shadows;
    this.balloons.mesh.setColorAt(0, WHITE);

    // ---- arrows: the body (shaft and point) and the fletching in the archer's colour
    const gs = gearStyle(this.world);
    const ag = arrowGeometry(gs.shaft, gs.point, { seg: 7 });
    this.own(ag.body);
    this.own(ag.fletch);
    const aol = outlineOr(kit, this.world);
    this.arrowBody = new Inst(ag.body, this.mat('racket', '#ffffff', { vc: true, maxGlow: 1.6 }), MAX_ARROWS, 'arrows').outline(aol, 0.7);
    this.arrowFletch = new Inst(ag.fletch, this.mat('racket', '#ffffff', { maxGlow: pal.glow ? 2.2 : 1.3 }), MAX_ARROWS, 'fletching').outline(aol, 0.7);
    this.arrowFletch.mesh.setColorAt(0, WHITE);
    this.arrowBody.mesh.castShadow = this.arrowFletch.mesh.castShadow = shadows;
    // the camera, to draw far arrows a little bigger (noted as the arrows draw)
    this.arrowBody.mesh.onBeforeRender = (_r, _s, cam) => {
      this.camPos.setFromMatrixPosition(cam.matrixWorld);
    };
    for (let i = 0; i < MAX_ARROWS; i++) this.arrowTracks.push({ state: '', target: -1, x: 0, y: 0, z: 0, offX: 0, roll: 0 });
    this.trails = new Trails(trailStyle(this.world));

    // ---- flags
    let fm: THREE.Material;
    if (pal.glow) {
      fm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 1.7, 1.7), vertexColors: true, side: THREE.DoubleSide });
      this.disposables.push(fm);
    } else fm = this.mat('shirt', '#ffffff', { vc: true, side: THREE.DoubleSide, rim: 0.3 });
    this.flags = new Flags(fm, pal.flags, this.world === 'pixel' || this.world === 'clay');
    this.flags.mesh.castShadow = shadows;

    this.targetParts = [this.faces, this.bosses, this.struts, this.decks, this.ropes, this.balloons];
    if (this.rims) this.targetParts.push(this.rims);
    this.parts = [...this.targetParts, this.arrowBody, this.arrowFletch];
    for (const p of this.parts) this.group.add(p.mesh);
    this.group.add(this.trails.mesh, this.flags.mesh);

    // ---- effects
    const hot = this.fx.hot;
    const col = (list: string[], k = 1) => list.map((c) => new THREE.Color(c).multiplyScalar(hot ? 2.4 * k : 1));
    this.zoneCols = pal.face.zones.map((z, i) => {
      // a dark zone's hit bursts in a lighter shade, so it shows against its own ring
      const c = new THREE.Color(z);
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      if (hsl.l < 0.3) c.setHSL(hsl.h, hsl.s, 0.62);
      return [c.multiplyScalar(hot ? 2.4 : 1), new THREE.Color(i === 0 ? '#fff6c0' : '#ffffff').multiplyScalar(hot ? 2.4 : 1)];
    });
    this.tenCols = [...this.zoneCols[0], ...this.zoneCols[1], ...this.zoneCols[2]];
    this.dustCols = col(this.fx.dust);
    this.bitCols = col(this.fx.bits);
    this.moteCols = col(this.fx.mote, 0.8);
    this.whiteCols = col(['#ffffff']);
    if (opts.particles) this.particles = opts.particles;
    else {
      // standalone: its own particles, drawn and stepped with the range
      const P = new Particles(500, { additive: hot, fog: false });
      this.particles = P;
      this.ownParticles = true;
      this.group.add(P.mesh);
    }
    this.update({ targets: [], arrows: [], wind: 0, fx: [] }, 0);
  }

  // ---------------------------------------------------------------- per frame

  update(v: RangeView, realDt: number) {
    this.time += realDt;
    this.frame++;
    const dt = realDt;
    // the flags answer the wind with a little lag
    this.wind += (v.wind - this.wind) * Math.min(1, dt * 2.5);
    this.flags.begin();
    for (let k = 0; k < FLAG_Z.length * 2; k++) this.flags.add((k < FLAG_Z.length ? -1 : 1) * FLAG_X, POLE_H - 0.06, FLAG_Z[k % FLAG_Z.length], 1.25, 0.66);
    this.placeTargets(v, dt);
    this.placeArrows(v.arrows, dt);
    for (const f of v.fx) this.effect(f);
    this.motes(dt);
    this.trails.update(dt);
    this.flags.update(this.time, dt, this.wind);
    if (this.ownParticles) this.particles.update(dt);
  }

  dispose() {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    for (const p of this.parts) p.dispose();
    this.trails.dispose();
    this.flags.dispose();
    if (this.ownParticles) this.particles.dispose();
  }

  // ---------------------------------------------------------------- targets

  private prune = (tr: TargetTrack, id: number) => {
    if (tr.seen === this.frame) return;
    this.tracks.delete(id);
    this.swing.delete(id);
  };

  private track(t: RangeView['targets'][number]) {
    let tr = this.tracks.get(t.id);
    if (!tr) {
      tr = { seen: 0, x: t.x, y: t.y, z: t.z, wob: 0, wobV: 0, popT: -1, popped: false, color: new THREE.Color(balloonColor(t.id)) };
      this.tracks.set(t.id, tr);
    }
    tr.x = t.x;
    tr.y = t.y;
    tr.z = t.z;
    tr.seen = this.frame;
    return tr;
  }

  private placeTargets(v: RangeView, dt: number) {
    const parts = this.targetParts;
    for (let i = 0; i < parts.length; i++) parts[i].begin();
    for (const t of v.targets) {
      const tr = this.track(t);
      // the hit wobble: a stiff spring
      tr.wobV += (-tr.wob * 420 - tr.wobV * 14) * dt;
      tr.wob += tr.wobV * dt;
      if (t.kind === 'face') {
        if (t.visible) this.placeFace(t, tr);
      } else if (t.visible || t.popped) this.placeBalloon(t, tr);
    }
    // forget targets that have gone
    this.tracks.forEach(this.prune);
    for (let i = 0; i < parts.length; i++) parts[i].end();
  }

  /** A face on its boss, on a stand (an easel, a tower when it's high, a hanging frame when it sways), with a wind flag on top. */
  private placeFace(t: TargetDef, tr: TargetTrack) {
    const x = t.x;
    const R = t.r * BOSS.k;
    const D = BOSS.depth;
    const zb = t.z - 0.012; // the boss's front, just behind the face
    const bottom = t.y - R;
    // the wobble: face and boss rock back about the foot of the boss
    const pv = tmpB.set(x, bottom, zb);
    tmpQ.setFromAxisAngle(X_AXIS, -tr.wob);
    tmpP.set(0, R, t.z - zb).applyQuaternion(tmpQ).add(pv);
    this.faces.push(tmpM.compose(tmpP, tmpQ, tmpS.set(t.r, t.r, 1)));
    const block = this.pal.bossStyle === 'block' ? 0.98 : 1;
    tmpP.set(0, R, 0).applyQuaternion(tmpQ).add(pv);
    this.bosses.push(tmpM.compose(tmpP, tmpQ, tmpS.set(R * block, R * block, D)));
    if (this.rims) {
      tmpP.set(0, R, t.z - zb + 0.004).applyQuaternion(tmpQ).add(pv);
      this.rims.push(tmpM.compose(tmpP, tmpQ, tmpS.set(t.r * 1.035, t.r * 1.035, 1)));
    }
    const zm = zb - D; // the boss's back
    const th = this.pal.square ? 0.075 : 0.07;
    if (t.swayX > 0) {
      // a gallows: posts beyond the sway, a beam across, ropes down to the boss (they swing with it)
      const mid = this.swayMid(t);
      const span = Math.abs(t.swayX) + R + 0.5;
      const top = t.y + R + 1.25;
      const zf = zm - 0.12;
      for (const sx of [-1, 1]) {
        const px = mid + sx * span;
        this.strut(px, 0, zf, px, top + 0.08, zf, th * 1.25);
        this.strut(px, 0, zf - 1.1, px, top - 0.35, zf, th);
      }
      this.strut(mid - span - 0.12, top, zf, mid + span + 0.12, top, zf, th * 1.2);
      for (const sx of [-1, 1]) this.rope(mid + sx * R * 0.55, top, zf, x + sx * R * 0.55, t.y + R * 0.9, zb - D * 0.5, 0.022);
      this.flag(mid - span, top + 0.08, zf);
      return;
    }
    if (bottom > 1.9) {
      this.tower(t, x, R, zb, zm, bottom, th);
      return;
    }
    // an easel: two legs either side of the boss, a third behind, and a cradle under it
    for (const sx of [-1, 1]) this.strut(x + sx * R * 0.98, 0, zb + 0.06, x + sx * R * 0.64, t.y + R * 0.72, zm + 0.02, th);
    const back = 0.55 + t.y * 0.45;
    this.strut(x, 0, zm - back, x, t.y + R * 0.7, zm - 0.02, th);
    if (bottom > 0.12) this.strut(x - R * 0.9, bottom - 0.03, zb - D * 0.5, x + R * 0.9, bottom - 0.03, zb - D * 0.5, th * 0.9);
    // the wind flag on a stick in the top of the boss
    this.strut(x + R * 0.55, t.y + R * 0.8, zb - D * 0.5, x + R * 0.55, t.y + R + 0.75, zb - D * 0.5, 0.025);
    this.flag(x + R * 0.55, t.y + R + 0.73, zb - D * 0.5);
  }

  /**
   * The middle of a swaying target's swing, for its frame to stand over: the
   * view's x is live, so it's where the target first showed up (a sway starts
   * from its rest position) until it has swung both ways, then the middle of
   * the extremes seen.
   */
  private swayMid(t: TargetDef) {
    let s = this.swing.get(t.id);
    if (!s) this.swing.set(t.id, (s = { first: t.x, lo: t.x, hi: t.x }));
    s.lo = Math.min(s.lo, t.x);
    s.hi = Math.max(s.hi, t.x);
    return s.hi - s.lo > Math.abs(t.swayX) * 1.6 ? (s.lo + s.hi) / 2 : s.first;
  }
  private swing = new Map<number, { first: number; lo: number; hi: number }>();

  /** A scaffold tower up to a raised face: four posts, cross braces every storey, a deck, a cradle and a ladder at the back. */
  private tower(t: TargetDef, x: number, R: number, zb: number, zm: number, bottom: number, th: number) {
    const deckY = bottom - 0.3;
    const W = Math.max(0.62, R + 0.12);
    // nothing in front of the face: the tower's front posts stand just behind its plane
    const zf = zb - 0.04,
      zr = zm - 0.55;
    const zc = (zf + zr) / 2;
    const top = deckY + 0.95;
    for (const [px, pz] of [
      [x - W, zf],
      [x + W, zf],
      [x - W, zr],
      [x + W, zr],
    ] as [number, number][])
      this.strut(px, 0, pz, px, pz === zf ? deckY : top, pz, th * 1.2);
    // storeys of cross braces: an X front and back, one diagonal each side
    const floors = Math.max(1, Math.round(deckY / 1.6));
    for (let f = 0; f < floors; f++) {
      const y0 = (deckY * f) / floors,
        y1 = (deckY * (f + 1)) / floors;
      for (const pz of [zf, zr]) {
        this.strut(x - W, y0, pz, x + W, y1, pz, th * 0.8);
        this.strut(x + W, y0, pz, x - W, y1, pz, th * 0.8);
      }
      for (const px of [x - W, x + W]) this.strut(px, y0, f % 2 ? zf : zr, px, y1, f % 2 ? zr : zf, th * 0.8);
      this.strut(x - W, y1, zf, x + W, y1, zf, th * 0.8);
    }
    // the deck, and a rail round its back and sides
    this.deck(x, deckY, zc, W * 2 + 0.3, 0.08, zf - zr + 0.3);
    this.strut(x - W, top, zr, x + W, top, zr, th * 0.8);
    for (const px of [x - W, x + W]) this.strut(px, top, zr, px, top, zc, th * 0.8);
    // the cradle holding the boss
    for (const sx of [-1, 1]) this.strut(x + sx * R * 0.7, deckY, zb - BOSS.depth * 0.5, x + sx * R * 0.55, t.y - R * 0.2, zb - BOSS.depth * 0.6, th);
    this.strut(x - R * 0.8, bottom - 0.03, zb - BOSS.depth * 0.5, x + R * 0.8, bottom - 0.03, zb - BOSS.depth * 0.5, th);
    this.strut(x, deckY, zm - 0.1, x, t.y + R * 0.6, zm - 0.02, th);
    // a ladder up the back
    const lz = zr - 0.08;
    for (const sx of [-1, 1]) this.strut(x + sx * 0.2, 0, lz, x + sx * 0.2, top, lz, th * 0.7);
    for (let y = 0.3; y < deckY; y += 0.34) this.strut(x - 0.2, y, lz, x + 0.2, y, lz, th * 0.5);
    // the wind flag
    this.strut(x - W, top, zr, x - W, top + 1.0, zr, 0.03);
    this.flag(x - W, top + 0.98, zr);
  }

  /** A balloon on its string, tied to a peg upwind of it (the string leans with the wind); popped, the string drops. */
  private placeBalloon(t: RangeView['targets'][number], tr: TargetTrack) {
    const x = t.x;
    const r = t.r;
    const bob = Math.sin(this.time * 1.6 + t.id * 1.9) * 0.03;
    const lean = THREE.MathUtils.clamp(this.wind * 0.045, -0.2, 0.2);
    const knotY = t.y + bob - r * 1.25;
    const ax = x - lean * Math.max(0.5, knotY),
      az = t.z;
    if (t.popped && !tr.popped) tr.popT = this.time;
    tr.popped = t.popped;
    this.strut(ax, 0, az, ax, 0.14, az, 0.05);
    if (!t.popped) {
      // tipped a little by the wind
      tmpQ.setFromAxisAngle(Z_AXIS, -lean * 0.6 + Math.sin(this.time * 1.1 + t.id) * 0.05);
      const i = this.balloons.push(tmpM.compose(tmpP.set(x, t.y + bob, t.z), tmpQ, tmpS.set(r, r, r)));
      if (i >= 0) this.balloons.mesh.setColorAt(i, tr.color);
      this.rope(x, knotY, t.z, ax, 0.12, az, 0.01);
      return;
    }
    // popped: the string falls to the ground over a second, then goes
    const age = this.time - tr.popT;
    if (tr.popT < 0 || age > 1.4) return;
    const topY = Math.max(0.16, knotY - 0.5 * 9.8 * age * age);
    const tx = THREE.MathUtils.lerp(x, ax, Math.min(1, age * 1.2));
    if (topY > 0.17) this.rope(tx, topY, t.z, ax, 0.12, az, 0.01);
  }

  /** A strut (post, leg, brace) from a to b, th thick. */
  private strut(ax: number, ay: number, az: number, bx: number, by: number, bz: number, th: number) {
    this.segment(this.struts, ax, ay, az, bx, by, bz, th);
  }

  private rope(ax: number, ay: number, az: number, bx: number, by: number, bz: number, th: number) {
    this.segment(this.ropes, ax, ay, az, bx, by, bz, th);
  }

  private segment(p: Inst, ax: number, ay: number, az: number, bx: number, by: number, bz: number, th: number) {
    tmpD.set(bx - ax, by - ay, bz - az);
    const len = tmpD.length();
    if (len < 1e-4) return;
    tmpD.divideScalar(len);
    tmpQ2.setFromUnitVectors(UPV, tmpD);
    tmpP.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    p.push(tmpM.compose(tmpP, tmpQ2, tmpS.set(th, len, th)));
  }

  private deck(x: number, y: number, z: number, w: number, h: number, d: number) {
    tmpQ2.identity();
    this.decks.push(tmpM.compose(tmpP.set(x, y - h / 2, z), tmpQ2, tmpS.set(w, h, d)));
  }

  private flag(x: number, y: number, z: number) {
    this.flags.add(x, y, z, 0.7, 0.38);
  }

  // ---------------------------------------------------------------- arrows

  private placeArrows(list: ArrowView[], dt: number) {
    const B = this.arrowBody,
      F = this.arrowFletch;
    B.begin();
    F.begin();
    const cam = this.camPos;
    for (let i = 0; i < list.length && i < MAX_ARROWS; i++) {
      const a = list[i];
      const tr = this.arrowTracks[i];
      const was = tr.state;
      // the same slot holding a different arrow? (a new shot, or the list was cleared)
      const jump = dist3(a.x - tr.x, a.y - tr.y, a.z - tr.z);
      const fresh = was === '' || (a.state === 'flying' && (was !== 'flying' || jump > 6)) || (a.state === 'stuck' && was === 'stuck' && jump > 0.05 && a.target < 0);
      if (fresh) {
        this.trails.cut(i);
        tr.roll = ((i * 2.399) % (Math.PI * 2)) + 0.3;
      }
      if (a.state === 'stuck' && (was !== 'stuck' || fresh || a.target !== tr.target)) {
        const tg = a.target >= 0 ? this.tracks.get(a.target) : undefined;
        tr.offX = tg ? a.x - tg.x : 0;
        this.trails.release(i);
      }
      tr.state = a.state;
      tr.target = a.target;
      tr.x = a.x;
      tr.y = a.y;
      tr.z = a.z;
      if (a.state === 'nocked' && !this.drawNocked) continue;
      tmpD.set(a.dx, a.dy, a.dz);
      if (tmpD.lengthSq() < 1e-8) tmpD.set(0, 0, -1);
      tmpD.normalize();
      let px = a.x;
      const py = a.y,
        pz = a.z;
      if (a.state === 'stuck' && a.target >= 0) {
        // it rides on the target it's in (whether or not the game moves it)
        const tg = this.tracks.get(a.target);
        if (tg) px = tg.x + tr.offX;
      }
      if (a.state === 'flying') {
        tr.roll += dt * 14;
        // feed the trail from the fletching
        const ts = this.trails.slot(i, a.color);
        const back = ARROW.length * 0.85;
        if (ts >= 0) this.trails.push(ts, px - tmpD.x * back, py - tmpD.y * back, pz - tmpD.z * back);
      }
      // far arrows are drawn up to ~1.4× so they still read down the range (as the tennis ball is)
      const d = dist3(px - cam.x, py - cam.y, pz - cam.z);
      const s = THREE.MathUtils.clamp(1 + (d - 12) * 0.02, 1, 1.4);
      tmpQ.setFromUnitVectors(NEG_Z, tmpD);
      tmpQ2.setFromAxisAngle(Z_AXIS, tr.roll);
      tmpQ.multiply(tmpQ2);
      tmpM.compose(tmpP.set(px, py, pz), tmpQ, tmpS.set(s, s, s));
      B.push(tmpM);
      const k = F.push(tmpM);
      if (k >= 0) F.mesh.setColorAt(k, this.color(a.color));
    }
    for (let i = list.length; i < MAX_ARROWS; i++) {
      if (this.arrowTracks[i].state === 'flying') this.trails.release(i);
      this.arrowTracks[i].state = '';
    }
    B.end();
    F.end();
  }

  /** A CSS colour, parsed once. */
  private color(css: string) {
    let c = this.colorCache.get(css);
    if (!c) this.colorCache.set(css, (c = new THREE.Color(css)));
    return c;
  }

  // ---------------------------------------------------------------- effects

  private effect(f: RangeFx) {
    if (f.type === 'hit') this.hit(f.x, f.y, f.z, f.ring);
    else if (f.type === 'pop') this.pop(f.x, f.y, f.z, f.color);
    else if (f.type === 'thunk') this.thunk(f.x, f.y, f.z);
  }

  /** An arrow in a face: a burst in the colour of the ring it hit (bigger, with a shower, for a 10), and the target rocks. */
  private hit(x: number, y: number, z: number, ring: number) {
    const P = this.particles;
    const F = this.fx;
    const zone = Math.max(0, Math.min(4, Math.floor((10 - Math.max(1, ring)) / 2)));
    const cols = this.zoneCols[zone];
    const ten = ring >= 10;
    const nine = ring === 9;
    // in front of the face (the point is in it)
    const zf = z + ARROW.sink + 0.06;
    P.burst({ x, y, z: zf, count: ten ? 30 : nine ? 18 : 10, speed: [1.6, ten ? 6.5 : 4], dir: [0, 0.25, 1], spread: 0.8, life: [0.3, ten ? 0.8 : 0.55], size: [0.06, ten ? 0.2 : 0.14], shrink: 0.2, colors: cols, shape: F.spark, drag: 3, gravity: this.world === 'ink' ? 9 : 4, spin: 8 });
    P.burst({ x, y, z: zf, count: 1, speed: [0, 0], life: [0.4, 0.4], size: [0.3, 0.3], shrink: ten ? 11 : 6, colors: cols, shape: 'ring', alpha: 0.95 });
    if (ten) {
      P.burst({ x, y, z: zf, count: 1, speed: [0, 0], life: [0.55, 0.55], size: [0.5, 0.5], shrink: 7, colors: this.whiteCols, shape: 'ring', alpha: 0.8 });
      P.burst({ x, y: y + 0.3, z: zf, count: 46, speed: [3, 7.5], dir: [0, 1, 0.35], spread: 0.55, life: [1.1, 1.9], size: [0.1, 0.18], colors: this.tenCols, shape: F.confetti, gravity: 4, drag: 1.4, spin: 10 });
    }
    // rock the face it hit
    let best: TargetTrack | null = null,
      bd = 1e9;
    for (const tr of this.tracks.values()) {
      const d = Math.hypot(tr.x - x, tr.y - y, tr.z - z);
      if (d < bd) (bd = d), (best = tr);
    }
    if (best && bd < 1.5) best.wobV += ten ? 0.9 : 0.6;
  }

  /** A balloon popped: shreds of rubber in its colour, sparkles in the archer's, a ring. */
  private pop(x: number, y: number, z: number, color: string) {
    const P = this.particles;
    const F = this.fx;
    const hot = F.hot ? 2.4 : 1;
    const bc = tmpC.set(color);
    const shred = [bc.clone().multiplyScalar(hot), bc.clone().lerp(WHITE, 0.45).multiplyScalar(hot)];
    const spark = [bc.clone().lerp(WHITE, 0.7).multiplyScalar(hot), WHITE.clone().multiplyScalar(hot)];
    P.burst({ x, y, z, count: 24, speed: [2, 5.5], life: [0.5, 1.0], size: [0.08, 0.17], shrink: 0.4, colors: shred, shape: this.world === 'pixel' ? 'square' : 'confetti', gravity: 6, drag: 2.2, spin: 12 });
    P.burst({ x, y, z, count: 12, speed: [1.5, 4], life: [0.3, 0.6], size: [0.07, 0.14], shrink: 0.2, colors: spark, shape: F.spark, drag: 3, gravity: 2, spin: 8 });
    P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.3, 0.3], size: [0.35, 0.35], shrink: 6, colors: spark, shape: 'ring', alpha: 0.9 });
  }

  /** An arrow into the ground (or the backstop, or the scenery): a puff of dust and a few flying bits. */
  private thunk(x: number, y: number, z: number) {
    const P = this.particles;
    const F = this.fx;
    const gy = Math.max(0.05, y);
    P.burst({ x, y: gy, z, count: 9, speed: [0.5, 1.8], dir: [0, 1, 0], spread: 0.9, life: [0.45, 0.9], size: [0.16, 0.34], shrink: 1.8, colors: this.dustCols, shape: F.dustShape, alpha: F.hot ? 1 : 0.6, drag: 3.5, gravity: -0.3 });
    P.burst({ x, y: gy, z, count: 7, speed: [1.5, 3.5], dir: [0, 1, 0.3], spread: 0.6, life: [0.35, 0.7], size: [0.05, 0.1], colors: this.bitCols, shape: this.world === 'pixel' ? 'square' : 'confetti', gravity: 9, drag: 1, spin: 10 });
  }

  /** Motes drifting across the range on the wind, so you can see it blow. */
  private motes(dt: number) {
    const w = this.wind;
    const k = Math.abs(w);
    if (k < 0.6) return;
    this.moteT -= dt * Math.min(1, k / 3);
    if (this.moteT > 0) return;
    this.moteT = 0.13;
    const sx = Math.sign(w);
    this.moteDir[0] = sx;
    this.particles.burst({
      x: -sx * (CHALK_X + 1.5) + (Math.random() - 0.5) * 3,
      y: 0.4 + Math.random() * 4.5,
      z: RANGE.minZ + Math.random() * (RANGE.lineZ - 2 - RANGE.minZ),
      count: 1,
      speed: [k * 1.1, k * 1.4],
      dir: this.moteDir,
      spread: 0.08,
      life: [3.2, 4.2],
      size: this.fx.moteShape === 'petal' ? [0.1, 0.15] : [0.05, 0.09],
      colors: this.moteCols,
      shape: this.fx.moteShape,
      gravity: 0.05,
      drag: 0,
      spin: 3,
      alpha: this.fx.hot ? 0.9 : 0.75,
    });
  }

  // ---------------------------------------------------------------- materials & baking

  /** The faces: unlit at the palette's strength, or the kit's (lit) material with the face texture. */
  private faceMaterial() {
    const pal = this.pal;
    const tex = this.own(faceTexture(pal.face));
    if (pal.faceLit) return this.mat('shirt', '#ffffff', { map: tex, rim: 0.15 });
    const k = pal.faceGlow;
    const m = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(k, k, k) });
    this.disposables.push(m);
    return m;
  }

  /** Straw (or foam, card, a dark drum) behind the face. */
  private bossMaterial(straw?: THREE.Texture) {
    return this.mat('shirt', this.pal.boss, { map: straw, detail: true, rim: 0.5 });
  }

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

  /** Unlit HDR colour, for the glowing worlds' accents (bloom picks them up). */
  private glow(css: string, k: number, map?: THREE.Texture) {
    const key = `glow|${css}|${k}|${map?.uuid ?? ''}`;
    let m = this.mats.get(key);
    if (!m) this.mats.set(key, (m = new THREE.MeshBasicMaterial({ color: new THREE.Color(css).multiplyScalar(k), map: map ?? null })));
    return m;
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /** Queue static geometry; everything with the same material becomes one mesh. */
  private add(mat: THREE.Material, geo: THREE.BufferGeometry, o: { cast?: boolean; receive?: boolean; outline?: number } = {}) {
    let s = this.statics.get(mat);
    if (!s) this.statics.set(mat, (s = { geos: [], cast: !!o.cast, receive: !!o.receive, outline: o.outline ?? 0 }));
    s.geos.push(geo);
  }

  private bake() {
    const shadows = !!this.kit.castShadow;
    for (const [mat, s] of this.statics) {
      const geo = mergeGeometries(s.geos, false);
      s.geos.forEach((g) => g.dispose());
      if (!geo) continue;
      this.own(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadows && s.cast;
      m.receiveShadow = shadows && s.receive;
      if (s.outline <= 0) m.userData.noOutline = true;
      else m.userData.outlineScale = s.outline;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
    }
    this.statics.clear();
  }

  // ---------------------------------------------------------------- the static range

  /** The lawn down the range: mowing stripes across it, the chalked lane with a line across every 5 m. */
  private buildLawn() {
    const pal = this.pal;
    const style = pal.face.style;
    const tex = this.own(lawnTexture(pal.lawn[0], pal.lawn[1], style));
    // the glowing worlds' kits add a flat glow to every surface: their dark floor is drawn unlit instead
    let lawn: THREE.Material;
    if (pal.glow) {
      lawn = new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -2 });
      this.disposables.push(lawn);
    } else lawn = this.mat('shirt', '#ffffff', { map: tex, floor: 1, rim: 0.15 });
    // stripes 2.5 m wide (one repeat per 5 m), lined up with the chalk lines
    const g = flat(-LAWN.halfX, LAWN.halfX, LAWN.far, LAWN.near, 0.004, 1);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 4, (p.getZ(i) - RANGE.lineZ) / (LINES_EVERY * 2) + 0.25);
    this.add(lawn, g, { receive: true });
    const chalk = this.accent();
    // a line across every 5 m, out past the furthest targets
    for (let d = LINES_EVERY; RANGE.lineZ - d >= RANGE.minZ - 0.5; d += LINES_EVERY) {
      const z = RANGE.lineZ - d;
      const w = d % 10 === 0 ? 0.08 : 0.05;
      this.add(chalk, flat(-CHALK_X, CHALK_X, z - w / 2, z + w / 2, 0.008), { receive: true });
    }
    // the lane's sides
    for (const sx of [-1, 1]) this.add(chalk, flat(sx * CHALK_X - 0.04, sx * CHALK_X + 0.04, RANGE.minZ - 0.5, LINE.front, 0.008), { receive: true });
  }

  /** The shooting line's platform: a low deck of planks with a trim, the line painted across it. */
  private buildPlatform() {
    const pal = this.pal;
    const L = LINE;
    const planks = this.own(plankTexture());
    const deck = this.mat('hair', pal.plank, { map: planks, detail: true, rim: 0.25 });
    const trim = pal.glow ? this.glow(pal.trim, 1.8) : this.mat('racket', pal.trim, { maxGlow: 1.3, rim: 0.4 });
    // planks across the range (v along z)
    this.add(deck, flat(-L.halfW, L.halfW, L.front, L.back, L.top, 1.6), { receive: true });
    const side = this.mat('shirt', pal.wood, { rim: 0.3 });
    this.add(side, box(-L.halfW, L.halfW, 0, L.top - 0.002, L.front, L.back), { cast: true, receive: true, outline: 1 });
    // a trim round the top edge
    const tw = 0.06;
    for (const [x0, x1, z0, z1] of [
      [-L.halfW - 0.02, L.halfW + 0.02, L.front - 0.02, L.front + tw],
      [-L.halfW - 0.02, L.halfW + 0.02, L.back - tw, L.back + 0.02],
      [-L.halfW - 0.02, -L.halfW + tw, L.front, L.back],
      [L.halfW - tw, L.halfW + 0.02, L.front, L.back],
    ] as [number, number, number, number][])
      this.add(trim, box(x0, x1, L.top - 0.03, L.top + 0.012, z0, z1), { cast: true, outline: 1 });
    // the shooting line
    const lineM = this.accent();
    this.add(lineM, flat(-L.halfW + 0.08, L.halfW - 0.08, RANGE.lineZ - 0.04, RANGE.lineZ + 0.04, L.top + 0.004), {});
  }

  /** Flag poles down both sides of the range. */
  private buildPoles() {
    const pal = this.pal;
    const pole = this.poleMaterial();
    const base = this.mat('shirt', pal.wood, { rim: 0.4 });
    const pg = pal.square ? new THREE.BoxGeometry(0.08, POLE_H, 0.08) : new THREE.CylinderGeometry(0.035, 0.045, POLE_H, 10);
    pg.translate(0, POLE_H / 2, 0);
    const ball = new THREE.SphereGeometry(0.07, 12, 8);
    ball.translate(0, POLE_H + 0.04, 0);
    const bg = pal.square ? new THREE.BoxGeometry(0.3, 0.12, 0.3) : new THREE.CylinderGeometry(0.16, 0.2, 0.12, 12);
    bg.translate(0, 0.06, 0);
    for (const sx of [-1, 1])
      for (const z of FLAG_Z) {
        const x = sx * FLAG_X;
        this.add(pole, pg.clone().translate(x, 0, z), { cast: true, outline: 0.8 });
        this.add(pole, ball.clone().translate(x, 0, z), { outline: 0.8 });
        this.add(base, bg.clone().translate(x, 0, z), { cast: true, outline: 1 });
      }
    pg.dispose();
    ball.dispose();
    bg.dispose();
  }

  private poleMaterial() {
    const pal = this.pal;
    return pal.glow ? this.glow(pal.trim, 1.3) : this.accent();
  }

  /** The chalk's colour, for the lines on the lawn and the platform and the poles (one material, so one draw). */
  private accent() {
    const pal = this.pal;
    return pal.glow ? this.glow(pal.chalk, 1.8) : this.mat('racket', pal.chalk, { floor: 3, maxGlow: 1.2, rim: 0.3 });
  }

  /** Boards on stakes beside the 10, 20 and 30 m lines. */
  private buildSigns() {
    const pal = this.pal;
    const ink = pal.glow ? '#ffffff' : pal.face.zones[3] === '#1a1613' ? '#1a1613' : pal.face.line;
    const paper = pal.glow ? '#1a0f3a' : this.world === 'ink' ? '#f1e8d4' : '#ffffff';
    const font = this.world === 'pixel' ? "'Press Start 2P', monospace" : "Fredoka, 'Arial Rounded MT Bold', system-ui, sans-serif";
    const tex = this.own(signTexture(ink, paper, font));
    const face = pal.glow ? this.glow('#ffffff', 1.25, tex) : this.mat('eyeWhite', '#ffffff', { map: tex });
    const stake = this.mat('shirt', pal.wood, { rim: 0.4 });
    const W = 0.62,
      H = 0.34;
    [10, 20, 30].forEach((d, i) => {
      const z = RANGE.lineZ - d;
      for (const sx of [-1, 1]) {
        const x = sx * (CHALK_X + 0.45);
        const g = new THREE.PlaneGeometry(W, H);
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / 3);
        // facing the shooting line, turned a little in towards the middle
        g.rotateY(-sx * 0.35);
        g.translate(x, 0.62, z + 0.03);
        this.add(face, g, {});
        const back = new THREE.BoxGeometry(W + 0.05, H + 0.05, 0.03);
        back.rotateY(-sx * 0.35);
        back.translate(x, 0.62, z);
        this.add(stake, back, { cast: true, outline: 1 });
        this.add(stake, box(x - 0.025, x + 0.025, 0, 0.5, z - 0.04, z - 0.01), { cast: true, outline: 1 });
      }
    });
  }

  /**
   * Where the misses end up: a tall net on poles across the back (z = −19.5,
   * up to 12 m) with a row of hay bales along its foot, and nets down both
   * sides (x = ±11). The nets are a see-through mesh (one draw); poles, ropes
   * and bales are baked with the rest.
   */
  private buildBackstop() {
    const pal = this.pal;
    const zN = BACKSTOP.z + NET_IN;
    const xN = BACKSTOP.sideX - NET_IN;
    const baleH = 0.52;
    const sideTop = 5;
    const zSide0 = LINE.front - 1.2;
    // ---- the net: back (u = x) and both sides (u = z), uvs in metres
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], ua: number[], ub: number[], uc: number[], ud: number[]) => {
      const n = pos.length / 3;
      pos.push(...a, ...b, ...c, ...d);
      uv.push(...ua, ...ub, ...uc, ...ud);
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    };
    const X = xN,
      T = BACKSTOP.top;
    quad([-X, baleH - 0.05, zN], [X, baleH - 0.05, zN], [X, T, zN], [-X, T, zN], [-X, baleH], [X, baleH], [X, T], [-X, T]);
    for (const sx of [-1, 1]) quad([sx * X, 0, zSide0], [sx * X, 0, zN], [sx * X, sideTop, zN], [sx * X, sideTop, zSide0], [zSide0, 0], [zN, 0], [zN, sideTop], [zSide0, sideTop]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.own(geo);
    const pixel = this.world === 'pixel';
    const netMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: new THREE.Color(pal.net).multiplyScalar(pal.glow ? 1.6 : 1) },
          uOpacity: { value: pal.netA },
          uCell: { value: pixel ? 1.1 : 0.22 },
          uLine: { value: pixel ? 0.07 : 0.018 },
          uSquare: { value: pixel ? 1 : 0 },
        },
      ]),
      vertexShader: NET_VERT,
      fragmentShader: NET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.disposables.push(netMat);
    const net = new THREE.Mesh(geo, netMat);
    net.name = 'backstop-net';
    net.renderOrder = 1;
    net.userData.noOutline = true;
    net.userData.noNormals = true;
    this.group.add(net);

    // ---- poles and the ropes along the net's edges
    const pole = this.poleMaterial();
    const rope = pal.glow ? this.glow(pal.net, 1.5) : this.mat('shirt', pal.rope, { rim: 0.3 });
    const post = (x: number, z: number, h: number) => {
      const g = pal.square ? new THREE.BoxGeometry(0.12, h, 0.12) : new THREE.CylinderGeometry(0.055, 0.07, h, 10);
      g.translate(x, h / 2, z);
      this.add(pole, g, { cast: true, outline: 0.8 });
    };
    const line = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      const l = Math.hypot(bx - ax, by - ay, bz - az);
      const g = pal.square ? new THREE.BoxGeometry(0.035, l, 0.035) : new THREE.CylinderGeometry(0.016, 0.016, l, 5);
      g.applyQuaternion(tmpQ.setFromUnitVectors(UPV, tmpD.set(bx - ax, by - ay, bz - az).normalize()));
      g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      this.add(rope, g, { outline: 0.6 });
    };
    const backPosts = 9;
    for (let i = 0; i < backPosts; i++) post(-X + (2 * X * i) / (backPosts - 1), zN - 0.08, T + 0.2);
    line(-X, T, zN, X, T, zN);
    line(-X, baleH, zN, X, baleH, zN);
    for (const sx of [-1, 1]) {
      const n = Math.max(2, Math.round((zSide0 - zN) / 4));
      for (let i = 0; i <= n; i++) post(sx * (X + 0.08), zN + ((zSide0 - zN) * i) / n, sideTop + 0.15);
      line(sx * X, sideTop, zN, sx * X, sideTop, zSide0);
    }

    // ---- hay bales along the foot of the back net: their faces just in front of it
    const straw = pal.bossStyle === 'straw' ? this.own(strawTexture()) : undefined;
    const baleMat = this.bossMaterial(straw);
    const twine = pal.glow ? this.glow(pal.twine, 1.4) : this.mat('shirt', pal.twine, { rim: 0.3 });
    const rng = new Rng(31);
    const BW = 1.1,
      BD = 0.56;
    const n = Math.round((2 * X) / BW);
    const bw = (2 * X) / n;
    for (let i = 0; i < n; i++) {
      const cx = -X + bw * (i + 0.5);
      const zf = BACKSTOP.z + 0.16 + (rng.next() - 0.5) * 0.04;
      const ry = (rng.next() - 0.5) * 0.05;
      const g = new THREE.BoxGeometry(bw - 0.03, baleH, BD);
      g.rotateY(ry);
      g.translate(cx, baleH / 2, zf - BD / 2);
      this.add(baleMat, g, { cast: true, receive: true, outline: 1 });
      for (const off of [-0.28, 0.28]) {
        const tg = new THREE.BoxGeometry(0.025, baleH + 0.012, BD + 0.012);
        tg.translate(off * bw, 0, 0);
        tg.rotateY(ry);
        tg.translate(cx, baleH / 2, zf - BD / 2);
        this.add(twine, tg, {});
      }
    }
  }
}

/** Length of (x, y, z) (Math.hypot boxes its arguments: this runs every frame for every arrow). */
function dist3(x: number, y: number, z: number) {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Arrows get the style's outline, or a thin dark one where nothing else draws edges (as the sword and the bow do). */
function outlineOr(kit: MaterialKit, world: string) {
  return kit.outline ?? (world === 'ink' || world === 'pixel' ? null : { color: new THREE.Color('#1f1b30'), width: 0.009, emissive: 1 });
}
