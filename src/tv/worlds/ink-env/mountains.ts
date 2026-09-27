// Ink-wash mountains: ranges in arcs round the court, each painted the sumi-e
// way — a dark crest that fades down the flanks, axe-cut texture strokes on
// the shaded slopes, moss dots along the ridge — and dissolving at its foot into
// mist that rises and falls slowly along it. Nearer ranges are darker, farther
// ones paler (the ink pass turns the tones into washes and inks the crests).
//
// All the ranges are one mesh (one draw), and the drifting mist banks between
// them another; everything moves in the shaders from one time uniform.

import * as THREE from 'three';
import { NOISE } from '../../render/glsl';

export interface Range {
  /** distance from the court's centre */
  radius: number;
  /** arc covered (radians): 0 = straight behind the far end (−z), positive towards +x */
  from: number;
  to: number;
  /** crest heights: the lowest saddles and the tallest peaks */
  height: [number, number];
  /** main peaks along the arc */
  peaks: number;
  /** 0 = nearest (darkest) … 1 = farthest (palest) */
  tone: number;
  /** 0 = rolling hills … 1 = steep karst pillars */
  sharp?: number;
  /** where the mist swallows it (height of the mist line) */
  mist: number;
  seed: number;
}

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A crest profile along an arc (u = metres along it): peaks over rolling saddles, with fine roughness. */
function profile(r: Range, len: number) {
  const rnd = mulberry(r.seed);
  const sharp = r.sharp ?? 0;
  const [lo, hi] = r.height;
  const peaks = Array.from({ length: r.peaks }, (_, i) => {
    const c = ((i + 0.5 + (rnd() - 0.5) * 0.8) / r.peaks) * len;
    const tall = rnd() < sharp * 0.6;
    return { c, h: lo + (hi - lo) * (tall ? 0.75 + rnd() * 0.25 : 0.3 + rnd() * 0.7), w: (len / r.peaks) * (tall ? 0.22 + rnd() * 0.12 : 0.45 + rnd() * 0.5), tall };
  });
  const ph = [rnd() * 9, rnd() * 9, rnd() * 9];
  // a range that doesn't close the circle sinks into the ground at its ends
  const whole = r.to - r.from > Math.PI * 1.99;
  const taper = Math.min(len * 0.2, 40);
  return (u: number) => {
    let h = lo * (0.55 + 0.25 * Math.sin(u * 0.013 + ph[0]));
    for (const p of peaks) {
      const d = Math.abs(u - p.c) / p.w;
      if (d >= 1) continue;
      // a rounded dome, or a steep pillar with a flat-ish top
      const s = p.tall ? Math.pow(1 - Math.pow(d, 2.5), 1.6) : Math.pow(1 - d * d, 2);
      h = Math.max(h, p.h * s);
    }
    // roughness: ledges and shoulders
    h += (Math.sin(u * 0.11 + ph[1]) * 0.5 + Math.sin(u * 0.29 + ph[2]) * 0.3 + Math.sin(u * 0.73 + ph[0]) * 0.2) * (hi - lo) * 0.045;
    h = Math.max(h, 1);
    if (!whole) {
      const e = Math.min(u, len - u) / taper;
      if (e < 1) h = -2 + (h + 2) * e * e * (3 - 2 * e);
    }
    return h;
  };
}

const RIDGE_VERT = /* glsl */ `
attribute vec4 aInk;   // metres along the arc, crest height, tone, crest slope
varying vec4 vInk;
varying float vY;
void main() {
  vInk = aInk;
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RIDGE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform float uMist[5];
varying vec4 vInk;
varying float vY;
${NOISE}
void main() {
  float u = vInk.x, crest = vInk.y, tone = vInk.z, slope = vInk.w;
  float below = crest - vY;
  // the wash: darkest along the crest, fading down the flanks (longer on far ranges)
  float k = exp(-below / (5.0 + 12.0 * tone));
  // axe-cut strokes down the slopes, heaviest on the side away from the light
  float shade = clamp(0.6 - slope * 1.8, 0.0, 1.0);
  float cun = vnoise(vec2(u * 0.3 + vY * 0.05, vY * 0.035 - u * 0.01)) * 0.7 + vnoise(vec2(u * 0.9 - vY * 0.1, vY * 0.09)) * 0.3;
  cun = smoothstep(0.5, 0.7, cun) * shade * exp(-below / (18.0 + 24.0 * tone));
  k = max(k, cun * 0.9);
  // moss dots along the ridge (near ranges)
  vec2 cell = vec2(u / 2.6, below / 2.2);
  vec2 id = floor(cell);
  vec2 f = fract(cell) - 0.25 - 0.5 * hash22(id);
  float dot1 = step(dot(f, f), 0.035) * step(0.55, hash21(id + 3.1)) * step(below, 3.0) * step(tone, 0.45);
  k = max(k, dot1);
  // the mist swallows the foot of the range, its line rising and falling along it
  float line = uMist[int(tone * 4.0 + 0.5)];
  float band = 3.0 + 9.0 * tone;
  float m = line + (vnoise(vec2(u * 0.012 + uTime * 0.018, tone * 13.0)) - 0.5) * band * 1.6 + (vnoise(vec2(u * 0.05 - uTime * 0.05, 3.0)) - 0.5) * band * 0.5;
  k *= smoothstep(m - band, m + band * 0.8, vY);
  // aerial perspective: far ranges are paler
  k *= mix(1.0, 0.45, tone);
  gl_FragColor = vec4(mix(uPaper, uInk, clamp(k, 0.0, 1.0)), 1.0);
}`;

const MIST_VERT = /* glsl */ `
attribute vec4 aMist;  // metres along the bank, 0..1 up it, seed, fade at the ends
varying vec4 vM;
void main() {
  vM = aMist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const MIST_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uPaper;
uniform sampler2D tNoise;
varying vec4 vM;
void main() {
  // two layers of the paper's broad noise, drifting past each other
  vec2 p = vec2(vM.x * 0.004 + vM.z, vM.y * 0.35);
  float n = texture2D(tNoise, p + vec2(uTime * 0.0035, 0.0)).b * 0.6 + texture2D(tNoise, p * 2.3 + vec2(-uTime * 0.006, 0.4)).a * 0.4;
  // thickest low in the bank, feathered top and bottom, torn into drifting wisps
  float body = smoothstep(0.0, 0.3, vM.y) * (1.0 - smoothstep(0.35, 1.0, vM.y));
  float a = smoothstep(0.42, 0.8, n * (0.55 + 0.6 * body) + body * 0.12) * body;
  gl_FragColor = vec4(uPaper, a * 0.88 * vM.w);
}`;

export interface Bank {
  radius: number;
  from: number;
  to: number;
  /** bottom and top of the bank */
  y: [number, number];
  seed: number;
}

export class Mountains {
  ranges: THREE.Mesh;
  mist: THREE.Mesh;
  u = { uTime: { value: 0 }, uPaper: { value: new THREE.Color() }, uInk: { value: new THREE.Color() }, uMist: { value: [0, 0, 0, 0, 0] }, tNoise: { value: null as THREE.Texture | null } };

  constructor(ranges: Range[], banks: Bank[], o: { paper: THREE.Color; ink: THREE.Color; noise: THREE.Texture }) {
    this.u.uPaper.value.copy(o.paper);
    this.u.uInk.value.copy(o.ink);
    this.u.tNoise.value = o.noise;
    // the mist line per tone step (0, 0.25 … 1), from the ranges that use it
    for (const r of ranges) this.u.uMist.value[Math.round(r.tone * 4)] = r.mist;
    const pos: number[] = [];
    const ink: number[] = [];
    const idx: number[] = [];
    for (const r of ranges) {
      const len = (r.to - r.from) * r.radius;
      const seg = Math.max(8, Math.round(len / 1.6));
      const crest = profile(r, len);
      const v0 = pos.length / 3;
      for (let i = 0; i <= seg; i++) {
        const u = (i / seg) * len;
        const a = r.from + (u / len) * (r.to - r.from);
        const h = crest(u);
        const slope = (crest(u + 1.5) - crest(u - 1.5)) / 3;
        const x = Math.sin(a) * r.radius,
          z = -Math.cos(a) * r.radius;
        // the foot sinks under the ground so no gap shows at the horizon
        pos.push(x, -12, z, x, h, z);
        ink.push(u, h, r.tone, slope, u, h, r.tone, slope);
      }
      for (let i = 0; i < seg; i++) {
        const a = v0 + i * 2;
        // facing the court (inwards)
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aInk', new THREE.Float32BufferAttribute(ink, 4));
    g.setIndex(idx);
    this.ranges = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: RIDGE_VERT, fragmentShader: RIDGE_FRAG, side: THREE.DoubleSide }));
    this.ranges.frustumCulled = false;
    this.ranges.userData.noBatch = true;

    // mist banks: tall arcs of drifting paper between the ranges
    const mp: number[] = [];
    const ma: number[] = [];
    const mi: number[] = [];
    for (const b of banks) {
      const len = (b.to - b.from) * b.radius;
      const seg = Math.max(8, Math.round(len / 6));
      const v0 = mp.length / 3;
      const rnd = mulberry(b.seed);
      const s = rnd() * 3;
      const whole = b.to - b.from > Math.PI * 1.99;
      for (let i = 0; i <= seg; i++) {
        const u = (i / seg) * len;
        const a = b.from + (u / len) * (b.to - b.from);
        const x = Math.sin(a) * b.radius,
          z = -Math.cos(a) * b.radius;
        // a bank that isn't a whole ring thins out towards its ends
        const f = whole ? 1 : Math.min(1, Math.min(u, len - u) / 40);
        mp.push(x, b.y[0], z, x, b.y[1], z);
        ma.push(u, 0, s, f, u, 1, s, f);
      }
      for (let i = 0; i < seg; i++) {
        const a = v0 + i * 2;
        mi.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mg.setAttribute('aMist', new THREE.Float32BufferAttribute(ma, 4));
    mg.setIndex(mi);
    this.mist = new THREE.Mesh(mg, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: MIST_VERT, fragmentShader: MIST_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.mist.frustumCulled = false;
    this.mist.renderOrder = -2;
    this.mist.userData.noBatch = true;
  }

  tick(t: number) {
    this.u.uTime.value = t;
  }
}
