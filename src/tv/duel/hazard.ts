// What the duel platform stands in, per world: water (Sports Park, Sunny
// Plaza), a pool of ink (Inkwell), a glowing grid abyss (Neon Drive), 8-bit
// water (Bit Kingdom), a sea of paper waves (Paper Isles), plasticine water
// (Clayland), a watercolour pond (Aquarelle) and a starry void (Starfall). It
// lies on the ground at HAZARD_Y where the court was, framed by a low border.
//
// The liquids are the world's own kit material ('shirt', white) with the water
// pattern patched into its colour (so each style lights, shades and shadows it
// its own way); the abyss and the void look *into* the ground, so they're
// custom shaders that trace the view ray below the surface.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit } from '../worlds/types';
import { NOISE } from '../render/glsl';
import { HAZARD_Y } from './arena';

/** the hazard's half-size (x across, z along the platform) and its border */
export const HZ = { x: 8.8, z: 13.5, rim: 0.34, rimH: 0.13 };
/** posts the water foams around (see Hazard.setPosts) */
export const MAX_POSTS = 16;

export type HazardKind = 'water' | 'toon' | 'ink' | 'abyss' | 'pixel' | 'paper' | 'clay' | 'wash' | 'void';

export function hazardKind(world: string | undefined): HazardKind {
  switch (world) {
    case 'plaza':
      return 'toon';
    case 'ink':
      return 'ink';
    case 'neon':
      return 'abyss';
    case 'pixel':
      return 'pixel';
    case 'paper':
      return 'paper';
    case 'clay':
      return 'clay';
    case 'water':
      return 'wash';
    case 'cosmic':
      return 'void';
    default:
      return 'water';
  }
}

interface Pal {
  deep: string;
  shallow: string;
  line: string;
  foam: string;
  /** how much of the foam glows through shade (emissive) */
  glow: number;
}

const PAL: Record<string, Pal> = {
  water: { deep: '#1c8fd0', shallow: '#56d3e6', line: '#d9fbff', foam: '#ffffff', glow: 0.35 },
  toon: { deep: '#2a78e0', shallow: '#48c3f2', line: '#ffffff', foam: '#ffffff', glow: 0.3 },
  ink: { deep: '#161310', shallow: '#26221d', line: '#b8ae9c', foam: '#f1e8d4', glow: 0.2 },
  pixel: { deep: '#1d2b53', shallow: '#29adff', line: '#fff1e8', foam: '#fff1e8', glow: 0.3 },
  paper: { deep: '#5fb2dc', shallow: '#8ccfec', line: '#4f9fcb', foam: '#ffffff', glow: 0.15 },
  clay: { deep: '#3f8fd8', shallow: '#6fbff0', line: '#b7e4ff', foam: '#fff8ea', glow: 0.15 },
  wash: { deep: '#7cbfe8', shallow: '#b2e0f4', line: '#eaf8ff', foam: '#ffffff', glow: 0.2 },
};

// ---------------------------------------------------------------- the liquid pattern

/**
 * GLSL patched into a kit material: hzColor() multiplies the surface colour
 * (keeping the kit's texture — paper stays paper) and returns how much foam
 * shows (added as emissive, so foam stays white in the deck's shadow).
 */
function liquidGlsl(kind: HazardKind) {
  const body: Record<string, string> = {
    // Switch Sports-like: turquoise shallows, soft caustic cells, foam where the posts stand
    water: /* glsl */ `
      vec2 q = p * 0.5 + vec2(t * 0.06, t * 0.035);
      vec2 f = hzCells(q, t * 0.45);
      float cell = 1.0 - smoothstep(0.02, 0.12, f.y - f.x);
      col = mix(col, uHzLine, cell * 0.3);
      col *= 0.94 + 0.12 * vnoise(p * 0.35 + t * 0.1);`,
    // cel-shaded: crisp white caustic lines in two bands of blue
    toon: /* glsl */ `
      vec2 q = p * 0.36 + vec2(t * 0.05, t * 0.03);
      vec2 f = hzCells(q, t * 0.4);
      float cell = 1.0 - step(0.04, f.y - f.x);
      float band = step(0.5, vnoise(p * 0.22 + t * 0.05));
      col = mix(col, col * 0.88, band * (1.0 - shallow));
      col = mix(col, uHzLine, cell * 0.5);`,
    // a pool of ink: slow rings spreading from where drops fell, pale on black
    ink: /* glsl */ `
      float rings = 0.0;
      for (int i = 0; i < 4; i++) {
        float fi = float(i);
        vec2 c = vec2(sin(fi * 2.4 + 1.0) * 5.5, cos(fi * 1.7 + 0.3) * 9.5);
        float d = length(p - c);
        float ph = d * 2.2 - t * (0.9 + fi * 0.13) + fi * 3.0;
        rings += smoothstep(0.86, 0.97, sin(ph)) * smoothstep(8.0, 1.0, d) * (0.6 + 0.4 * sin(fi + t * 0.3));
      }
      float swirl = fbm(p * 0.18 + vec2(t * 0.02, -t * 0.015));
      col = mix(col, uHzLine, clamp(rings, 0.0, 1.0) * 0.8);
      col = mix(col, col * 1.5, smoothstep(0.55, 0.8, swirl) * 0.5);`,
    // 16 colours, fat pixels, stepped time: the classic 8-bit sea
    pixel: /* glsl */ `
      vec2 cq = floor(p / 0.5);
      float ts = floor(t * 4.0) / 4.0;
      float row = mod(cq.y, 4.0);
      float dash = step(0.8, fract(cq.x * 0.137 + cq.y * 0.31 + ts * (row < 2.0 ? 0.35 : -0.35)));
      col = uHzShallow;
      col = mix(col, uHzLine, dash * step(1.0, row) * step(row, 1.0));`,
    // printed paper: the sheet's blue with a pattern of darker wave lines
    paper: /* glsl */ `
      float wv = sin(p.y * 3.1 + sin(p.x * 0.9) * 1.3);
      col = mix(col, uHzLine, smoothstep(0.9, 0.97, wv) * 0.6);`,
    // plasticine: soft, lumpy highlights, moving on twos
    clay: /* glsl */ `
      float ts = floor(t * 12.0) / 12.0;
      float n = fbm(p * 0.35 + vec2(ts * 0.08, ts * 0.05));
      col = mix(col, uHzLine, smoothstep(0.55, 0.72, n) * 0.55);`,
    // a watercolour pond: soft light ripples, lily pads, a few pink flowers
    wash: /* glsl */ `
      float rings = 0.0;
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        vec2 c = vec2(sin(fi * 2.1 + 0.4) * 5.0, cos(fi * 1.9 + 1.1) * 9.0);
        float d = length(p - c);
        rings += smoothstep(0.8, 0.98, sin(d * 1.7 - t * (0.7 + fi * 0.1))) * smoothstep(7.0, 1.5, d);
      }
      col = mix(col, uHzLine, clamp(rings, 0.0, 1.0) * 0.55);
      vec2 cq = floor(p / 2.6);
      vec2 cc = (cq + 0.5 + (hash22(cq) - 0.5) * 0.5) * 2.6;
      float pr = 0.42 + hash21(cq + 7.0) * 0.28;
      vec2 dp = p - cc;
      float ang = atan(dp.y, dp.x) + hash21(cq) * 6.28;
      float notch = step(0.35, abs(mod(ang, 6.2832) - 3.1416));
      float keep = step(0.62, hash21(cq + 1.0)) * step(2.4, max(abs(cc.x) - 1.3, abs(cc.y) - uHzPlat.y));
      float pad = (1.0 - smoothstep(pr - 0.04, pr, length(dp))) * notch * keep;
      col = mix(col, vec3(0.43, 0.73, 0.42), pad);
      float bloom = (1.0 - smoothstep(0.1, 0.16, length(dp - vec2(0.12, 0.08)))) * keep * step(0.5, hash21(cq + 3.0));
      col = mix(col, vec3(1.0, 0.69, 0.82), bloom);`,
  };
  return /* glsl */ `
    uniform float uHzTime; uniform vec2 uHzHalf; uniform vec2 uHzPlat; uniform vec3 uHzPosts[${MAX_POSTS}];
    uniform vec3 uHzDeep; uniform vec3 uHzShallow; uniform vec3 uHzLine; uniform vec3 uHzFoamCol; uniform float uHzGlow;
    varying vec3 vHzW;
    ${NOISE}
    // cellular noise: distances to the nearest two points, which drift with time
    vec2 hzCells(vec2 q, float t) {
      vec2 i = floor(q), f = fract(q);
      float d1 = 8.0, d2 = 8.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = hash22(i + g);
        o = 0.5 + 0.45 * sin(t + 6.2831 * o);
        float d = length(g + o - f);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      return vec2(d1, d2);
    }
    vec3 hzColor(vec3 w, out float foam) {
      vec2 p = w.xz;
      float t = uHzTime;
      float edge = min(uHzHalf.x - abs(p.x), uHzHalf.y - abs(p.y));
      float shallow = 1.0 - smoothstep(0.0, 3.2, edge);
      vec3 col = mix(uHzDeep, uHzShallow, shallow * 0.8);
      ${body[kind] ?? body.water}
      // in the platform's shade
      vec2 pd = abs(p) - uHzPlat;
      float under = 1.0 - smoothstep(-0.3, 0.8, max(pd.x, pd.y));
      ${kind === 'pixel' ? 'col = mix(col, uHzDeep, step(0.5, under));' : 'col *= 1.0 - under * 0.28;'}
      // foam: rings where the posts stand, a lick along the border
      foam = 0.0;
      for (int i = 0; i < ${MAX_POSTS}; i++) {
        vec3 ps = uHzPosts[i];
        if (ps.z <= 0.0) continue;
        float d = length(p - ps.xy);
        float ring = smoothstep(0.42, 0.2, d) * (0.55 + 0.45 * sin(d * 24.0 - t * 3.0 + ps.x));
        foam = max(foam, ring * ps.z);
      }
      foam = max(foam, smoothstep(0.35, 0.0, edge) * (0.6 + 0.4 * sin(p.x * 2.0 + p.y * 2.0 + t * 1.5)));
      ${kind === 'pixel' ? 'foam = step(0.5, foam);' : kind === 'toon' || kind === 'paper' ? 'foam = step(0.45, foam);' : ''}
      col = mix(col, uHzFoamCol, foam);
      return col;
    }`;
}

export interface HazardUniforms {
  uHzTime: { value: number };
  uHzHalf: { value: THREE.Vector2 };
  uHzPlat: { value: THREE.Vector2 };
  uHzPosts: { value: THREE.Vector3[] };
  uHzDeep: { value: THREE.Color };
  uHzShallow: { value: THREE.Color };
  uHzLine: { value: THREE.Color };
  uHzFoamCol: { value: THREE.Color };
  uHzGlow: { value: number };
}

/** Patch the liquid pattern into a kit material (chaining whatever the kit already patches in). */
function patchLiquid(mat: THREE.Material, u: HazardUniforms, kind: HazardKind) {
  const orig = mat.onBeforeCompile;
  const origKey = mat.customProgramCacheKey.bind(mat);
  const glsl = liquidGlsl(kind);
  mat.onBeforeCompile = (sh, r) => {
    orig.call(mat, sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHzW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHzW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + glsl)
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat hzFoam = 0.0;\ndiffuseColor.rgb *= hzColor(vHzW, hzFoam);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uHzFoamCol * hzFoam * uHzGlow;');
  };
  mat.customProgramCacheKey = () => origKey() + '|duel-hazard-' + kind;
}

// ---------------------------------------------------------------- looking into the ground

const DEEP_VERT = /* glsl */ `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

/** Neon Drive: a pit under the opening, its walls and floor ruled in glowing grid lines that stream down into the dark. */
const ABYSS_FRAG = /* glsl */ `
uniform float uTime; uniform vec2 uHalf; uniform float uDepth; uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uRim; uniform float uBeat;
varying vec3 vW;
float grid(vec2 p, float w) {
  vec2 f = abs(fract(p) - 0.5);
  vec2 d = max(fwidth(p), vec2(1e-3));
  vec2 l = smoothstep(0.5 - w - d, 0.5 - w + d * 0.5, f);
  return max(l.x, l.y);
}
void main() {
  vec3 rd = normalize(vW - cameraPosition);
  rd.y = min(rd.y, -1e-3);
  // (keep the sign when dodging a zero: a flipped one sends the hit behind the camera)
  float sx = rd.x >= 0.0 ? max(rd.x, 1e-5) : min(rd.x, -1e-5);
  float sz = rd.z >= 0.0 ? max(rd.z, 1e-5) : min(rd.z, -1e-5);
  float tx = ((sx > 0.0 ? uHalf.x : -uHalf.x) - vW.x) / sx;
  float tz = ((sz > 0.0 ? uHalf.y : -uHalf.y) - vW.z) / sz;
  float ty = (-uDepth - vW.y) / rd.y;
  float t = max(0.0, min(min(tx, tz), ty));
  vec3 h = vW + rd * t;
  float depth = clamp(-h.y, 0.0, uDepth);
  vec2 uv;
  if (t == ty) uv = h.xz / 1.2;
  else if (t == tx) uv = vec2(h.z / 1.2, (h.y - uTime * 0.9) / 1.2);
  else uv = vec2(h.x / 1.2, (h.y - uTime * 0.9) / 1.2);
  float g = grid(uv, 0.028);
  float fade = exp(-depth * 0.32);
  vec3 lc = mix(uTop, uBottom, smoothstep(0.0, uDepth * 0.8, depth));
  vec3 col = vec3(0.012, 0.004, 0.03) + lc * g * (1.05 + uBeat * 0.8) * fade;
  // a glow from far below
  col += uBottom * 0.08 * smoothstep(uDepth * 0.4, uDepth, depth);
  // the lit lip of the opening
  float edge = min(uHalf.x - abs(vW.x), uHalf.y - abs(vW.z));
  col += uRim * (exp(-edge * 5.0) * 1.6 + exp(-edge * 1.2) * 0.12);
  gl_FragColor = vec4(col, 1.0);
}`;

/** Starfall: a hole in the asteroid onto open space — star fields at several depths drift apart as the camera moves. */
const VOID_FRAG = /* glsl */ `
uniform float uTime; uniform vec2 uHalf; uniform vec3 uRim; uniform vec3 uRim2;
varying vec3 vW;
${NOISE}
void main() {
  vec3 rd = normalize(vW - cameraPosition);
  rd.y = min(rd.y, -1e-3);
  vec3 col = vec3(0.004, 0.002, 0.014);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float d = 2.0 * pow(2.4, fi);
    vec2 p = (vW + rd * ((-d - vW.y) / rd.y)).xz;
    float dens = 1.6 / (1.0 + fi * 0.5);
    vec2 q = p * dens + fi * 17.3;
    vec2 c = floor(q), f = fract(q) - 0.5;
    vec2 o = (hash22(c) - 0.5) * 0.7;
    float r = length(f - o);
    float on = step(0.72, hash21(c + 3.1));
    float tw = 0.65 + 0.35 * sin(uTime * (1.5 + hash21(c) * 3.0) + hash21(c + 9.0) * 40.0);
    float star = smoothstep(0.09 / (1.0 + fi * 0.3), 0.0, r) * on * tw;
    vec3 sc = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.75, 0.95), hash21(c + 5.0));
    col += sc * star * (2.2 - fi * 0.35);
    if (i == 3) {
      float n1 = fbm(p * 0.035 + vec2(uTime * 0.004, 0.0));
      float n2 = fbm(p * 0.07 + 11.0);
      col += vec3(0.32, 0.08, 0.5) * smoothstep(0.5, 0.85, n1) * 0.4;
      col += vec3(0.05, 0.28, 0.5) * smoothstep(0.58, 0.9, n2) * 0.3;
    }
  }
  // the broken rock's edge glows where it opens onto the void
  float edge = min(uHalf.x - abs(vW.x), uHalf.y - abs(vW.z));
  float wob = fbm(vW.xz * 0.9) * 0.25;
  col += mix(uRim, uRim2, smoothstep(0.0, 0.6, edge)) * (exp(-(edge + wob) * 6.0) * 1.7 + exp(-edge * 1.4) * 0.15);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- the hazard

export interface HazardOpts {
  kit: MaterialKit;
  kind: HazardKind;
  /** make a kit material with the venue's own options (polygon offset, glow caps…) */
  mat: (role: 'shirt' | 'hair' | 'racket', css: string, o?: { floor?: number; rim?: number }) => THREE.Material;
  /** a glowing (unlit, HDR) material for the worlds that have one */
  glow: (css: string, k: number) => THREE.Material;
  /** the border colour */
  rimColor: string;
}

/** The hazard's surface, its border and (Paper Isles, Clayland) the waves that bob on it. */
export class Hazard {
  readonly group = new THREE.Group();
  readonly kind: HazardKind;
  private u: HazardUniforms | null = null;
  private deep: THREE.ShaderMaterial | null = null;
  private waves: THREE.Mesh[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(o: HazardOpts) {
    this.kind = o.kind;
    this.group.name = 'hazard';
    const k = o.kind;
    const geo = this.own(new THREE.PlaneGeometry(HZ.x * 2, HZ.z * 2, 1, 1).rotateX(-Math.PI / 2));
    geo.translate(0, HAZARD_Y, 0);
    let surface: THREE.Mesh;
    if (k === 'abyss' || k === 'void') {
      const m =
        k === 'abyss'
          ? new THREE.ShaderMaterial({
              uniforms: {
                uTime: { value: 0 },
                uHalf: { value: new THREE.Vector2(HZ.x, HZ.z) },
                uDepth: { value: 9 },
                uTop: { value: new THREE.Color('#ff2fb4').multiplyScalar(1.3) },
                uBottom: { value: new THREE.Color('#8b3bff').multiplyScalar(1.1) },
                uRim: { value: new THREE.Color('#22e6ff').multiplyScalar(1.6) },
                uBeat: { value: 0 },
              },
              vertexShader: DEEP_VERT,
              fragmentShader: ABYSS_FRAG,
            })
          : new THREE.ShaderMaterial({
              uniforms: {
                uTime: { value: 0 },
                uHalf: { value: new THREE.Vector2(HZ.x, HZ.z) },
                uRim: { value: new THREE.Color('#5ef2ff').multiplyScalar(1.8) },
                uRim2: { value: new THREE.Color('#a86bff').multiplyScalar(1.2) },
              },
              vertexShader: DEEP_VERT,
              fragmentShader: VOID_FRAG,
            });
      // on the ground, and winning over it (Paper's cardboard is at 0 too)
      m.polygonOffset = true;
      m.polygonOffsetFactor = 0;
      m.polygonOffsetUnits = -4;
      this.deep = m;
      this.disposables.push(m);
      surface = new THREE.Mesh(geo, m);
    } else {
      const pal = PAL[k] ?? PAL.water;
      this.u = {
        uHzTime: { value: 0 },
        uHzHalf: { value: new THREE.Vector2(HZ.x, HZ.z) },
        uHzPlat: { value: new THREE.Vector2(1.3, 4) },
        uHzPosts: { value: Array.from({ length: MAX_POSTS }, () => new THREE.Vector3()) },
        uHzDeep: { value: new THREE.Color(pal.deep) },
        uHzShallow: { value: new THREE.Color(pal.shallow) },
        uHzLine: { value: new THREE.Color(pal.line) },
        uHzFoamCol: { value: new THREE.Color(pal.foam) },
        uHzGlow: { value: pal.glow },
      };
      const m = o.mat('shirt', '#ffffff', { floor: 2, rim: 0.15 });
      const ms = m as THREE.MeshStandardMaterial;
      // a wet sheen where the style has one
      if ((ms as THREE.MeshStandardMaterial).isMeshStandardMaterial && k === 'water') ms.roughness = 0.22;
      patchLiquid(m, this.u, k);
      surface = new THREE.Mesh(geo, m);
      surface.receiveShadow = !!o.kit.castShadow;
    }
    surface.name = 'hazard-surface';
    // flat and underfoot: no outline hull, and nothing for the ink world's edge pass to trace
    surface.userData.noOutline = true;
    this.group.add(surface);
    this.buildRim(o);
    if (k === 'paper') this.buildPaperWaves(o);
    if (k === 'clay') this.buildClayWaves(o);
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /** a low border where the hazard meets the ground */
  private buildRim(o: HazardOpts) {
    const w = HZ.rim,
      h = HZ.rimH;
    const y0 = HAZARD_Y - 0.03;
    const parts = [
      [-HZ.x - w, HZ.x + w, HZ.z, HZ.z + w],
      [-HZ.x - w, HZ.x + w, -HZ.z - w, -HZ.z],
      [HZ.x, HZ.x + w, -HZ.z, HZ.z],
      [-HZ.x - w, -HZ.x, -HZ.z, HZ.z],
    ].map(([x0, x1, z0, z1]) => {
      const g = new THREE.BoxGeometry(x1 - x0, h, z1 - z0);
      g.translate((x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2);
      return g;
    });
    const geo = this.own(mergeGeometries(parts)!);
    parts.forEach((p) => p.dispose());
    const glowing = this.kind === 'abyss' || this.kind === 'void';
    const mat = glowing ? o.glow(o.rimColor, this.kind === 'abyss' ? 2.2 : 1.6) : o.mat('shirt', o.rimColor, { rim: 0.3 });
    const m = new THREE.Mesh(geo, mat);
    m.name = 'hazard-rim';
    m.receiveShadow = !!o.kit.castShadow;
    m.userData.outlineScale = 1.4;
    this.group.add(m);
  }

  /** Paper Isles: rows of cut-paper waves standing on the sheet, rocking in two alternating sets (a theatre wave machine). */
  private buildPaperWaves(o: HazardOpts) {
    const sets: THREE.BufferGeometry[][] = [[], []];
    const crest = 1.05;
    const make = (x0: number, x1: number, h: number, ph: number) => {
      const s = new THREE.Shape();
      s.moveTo(x0, 0);
      const n = Math.ceil((x1 - x0) / 0.12);
      for (let i = 0; i <= n; i++) {
        const x = x0 + ((x1 - x0) * i) / n;
        const v = Math.abs(Math.sin((Math.PI * (x + ph)) / crest));
        s.lineTo(x, h * (0.35 + 0.65 * Math.pow(v, 0.55)));
      }
      s.lineTo(x1, 0);
      s.lineTo(x0, 0);
      return new THREE.ExtrudeGeometry(s, { depth: 0.025, bevelEnabled: false, curveSegments: 4 });
    };
    let row = 0;
    for (let z = -HZ.z + 0.7; z < HZ.z - 0.4; z += 1.3, row++) {
      const h = 0.24 + (row % 3) * 0.04;
      const g = make(-HZ.x + 0.1, HZ.x - 0.1, h, row * 0.37);
      g.translate(0, HAZARD_Y - 0.06, z);
      sets[row % 2].push(g);
    }
    const cols = ['#4f9fcb', '#86c9ea'];
    sets.forEach((list, i) => {
      const geo = this.own(mergeGeometries(list)!);
      list.forEach((g) => g.dispose());
      const m = new THREE.Mesh(geo, o.mat('shirt', cols[i], { rim: 0.2 }));
      m.castShadow = !!o.kit.castShadow;
      m.receiveShadow = !!o.kit.castShadow;
      m.userData.noOutline = true;
      m.userData.phase = i * Math.PI;
      this.waves.push(m);
      this.group.add(m);
    });
  }

  /** Clayland: fat rolls of plasticine surf, lumpy by hand, heaving on twos. */
  private buildClayWaves(o: HazardOpts) {
    const sets: THREE.BufferGeometry[][] = [[], []];
    let row = 0;
    for (let z = -HZ.z + 0.9; z < HZ.z - 0.5; z += 1.7, row++) {
      const x0 = -HZ.x + 0.4 + (row % 2) * 0.5,
        x1 = HZ.x - 0.4 - ((row + 1) % 2) * 0.5;
      const g = new THREE.CapsuleGeometry(0.15, x1 - x0, 5, 10, Math.round((x1 - x0) * 3));
      g.rotateZ(Math.PI / 2);
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i),
          y = p.getY(i),
          zz = p.getZ(i);
        const lump = 1 + 0.18 * Math.sin(x * 3.1 + row) * Math.cos(x * 1.7 + row * 2);
        p.setXYZ(i, x, y * lump * 0.8 + 0.05 * Math.sin(x * 2.2 + row), zz * lump);
      }
      g.computeVertexNormals();
      g.translate((x0 + x1) / 2, HAZARD_Y + 0.02, z);
      sets[row % 2].push(g);
    }
    sets.forEach((list, i) => {
      const geo = this.own(mergeGeometries(list)!);
      list.forEach((g) => g.dispose());
      const m = new THREE.Mesh(geo, o.mat('shirt', i ? '#e6f6ff' : '#7cc4f2', { rim: 0.3 }));
      m.castShadow = !!o.kit.castShadow;
      m.receiveShadow = !!o.kit.castShadow;
      m.userData.phase = i * Math.PI;
      this.waves.push(m);
      this.group.add(m);
    });
  }

  /** Posts the liquid foams around: (x, z) in world space, weight 0 = gone. */
  setPost(i: number, x: number, z: number, w: number) {
    if (!this.u || i >= MAX_POSTS) return;
    this.u.uHzPosts.value[i].set(x, z, w);
  }

  update(time: number, halfLength: number, beat = 0) {
    if (this.u) {
      this.u.uHzTime.value = time;
      this.u.uHzPlat.value.set(1.3, halfLength);
    }
    if (this.deep) {
      this.deep.uniforms.uTime.value = time;
      if (this.deep.uniforms.uBeat) this.deep.uniforms.uBeat.value = beat;
    }
    // waves: paper rocks smoothly, clay heaves in 12 fps steps
    const ts = this.kind === 'clay' ? Math.floor(time * 12) / 12 : time;
    for (const w of this.waves) {
      const ph = w.userData.phase as number;
      w.position.y = Math.sin(ts * 1.5 + ph) * (this.kind === 'clay' ? 0.035 : 0.055);
      w.position.x = Math.sin(ts * 0.7 + ph) * 0.18;
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
