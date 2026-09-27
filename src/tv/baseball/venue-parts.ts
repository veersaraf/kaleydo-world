// The ballpark's moving parts (see venue.ts, which owns them):
//
//  • Ribbon — a camera-facing strip through a list of points, never thinner
//    than a few pixels however far away it is. The tracer (the batted ball's
//    path, TV style) and the ball's streak are ribbons.
//  • Fireworks — shells fired from behind the fence: a rocket climbs, flashes
//    and bursts into sparks that streak, droop and twinkle out. Every spark is
//    one instance of one draw, flown on the GPU from its launch values, so a
//    whole show is written once when it's lit and costs no JS per frame.

import * as THREE from 'three';
import { NOISE } from '../render/glsl';

// ---------------------------------------------------------------- ribbons

export interface RibbonStyle {
  /** the core's colour (the edges take the ribbon's own colour) — HDR is fine */
  core: THREE.Color;
  /** 0 soft glow, 1 dry brush (ink), 2 pixel steps, 3 hard-edged (paper, cel) */
  mode: number;
  additive: boolean;
  opacity: number;
  /** the half-width is never under this many pixels of a 1080-row picture (nor over maxPx, when given) */
  minPx: number;
  maxPx?: number;
  /** also draw the parts hidden behind scenery, this faintly (0 = not at all) */
  xray: number;
  /** how much of the width is the core, 0..1 */
  coreW: number;
  /** the core: the ribbon's colour mixed this far towards `core` (1 = all core) */
  coreMix: number;
}

const RIBBON_VERT = /* glsl */ `
attribute vec3 aTan; attribute vec4 aS; attribute float aL;
uniform float uMinPx; uniform float uMaxPx;
varying vec4 vS; varying float vL;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 toCam = cameraPosition - wp.xyz;
  float dist = length(toCam);
  vec3 side = cross(aTan, toCam / max(dist, 1e-4));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  // never thinner than uMinPx pixels (of 1080 rows) either side: metres per pixel grow with distance
  float perPx = 2.0 * dist / (projectionMatrix[1][1] * 1080.0);
  float w = min(max(aS.z, uMinPx * perPx), uMaxPx * perPx);
  wp.xyz += side * aS.x * w;
  vS = aS; vL = aL;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RIBBON_FRAG = /* glsl */ `
uniform vec3 uColor; uniform vec3 uCore; uniform float uOpacity; uniform int uMode; uniform float uCoreW; uniform float uCoreMix;
varying vec4 vS; varying float vL;
#include <common>
#include <fog_pars_fragment>
${NOISE}
void main() {
  float e = 1.0 - abs(vS.x);
  float a = smoothstep(0.0, 0.55, e);
  vec3 core = mix(uColor, uCore, uCoreMix);
  vec3 col = mix(uColor, core, smoothstep(1.0 - uCoreW, 1.0 - uCoreW * 0.35, e));
  if (uMode == 1) {
    // a dry brush: streaks along the stroke, breaking up towards its tail
    float streak = vnoise(vec2(vS.x * 4.0 + 7.0, vL * 1.3));
    a *= smoothstep(0.18 + (1.0 - vS.y) * 0.3, 0.45 + (1.0 - vS.y) * 0.25, streak + e * 0.5);
    col = uColor;
  } else if (uMode == 2) {
    a = step(0.28, e);
    col = e > 1.0 - uCoreW ? core : uColor;
  } else if (uMode == 3) {
    a = smoothstep(0.02, 0.1, e);
    col = e > 1.0 - uCoreW ? core : uColor;
  }
  a *= vS.w;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a * uOpacity);
  #include <fog_fragment>
}`;

/**
 * A strip through up to `max` points, turned to face the camera. Fill it with
 * begin() / push() / end() whenever the points change; each point has its own
 * half-width (metres) and opacity, and `u` runs 0 → 1 from the first point to
 * the last (the fragment modes use it).
 */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  /** the same strip drawn faintly through whatever hides it (null when the style has no x-ray) */
  readonly xray: THREE.Mesh | null = null;
  readonly mat: THREE.ShaderMaterial;
  private xmat: THREE.ShaderMaterial | null = null;
  /** the style's opacities (fade scales them) */
  private base: number;
  private xbase: number;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private tan: Float32Array;
  private dat: Float32Array;
  private len: Float32Array;
  /** pushed points: x, y, z, half-width, alpha */
  private pts: Float32Array;
  private n = 0;

  constructor(
    readonly max: number,
    style: RibbonStyle,
    name: string,
  ) {
    const V = max * 2;
    this.pos = new Float32Array(V * 3);
    this.tan = new Float32Array(V * 3);
    this.dat = new Float32Array(V * 4);
    this.len = new Float32Array(V);
    this.pts = new Float32Array(max * 5);
    const idx: number[] = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const dyn = (arr: Float32Array, k: number) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', dyn(this.pos, 3));
    this.geo.setAttribute('aTan', dyn(this.tan, 3));
    this.geo.setAttribute('aS', dyn(this.dat, 4));
    this.geo.setAttribute('aL', dyn(this.len, 1));
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);
    const make = (opacity: number, depth: boolean) =>
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uColor: { value: new THREE.Color('#ffffff') },
            uCore: { value: style.core.clone() },
            uOpacity: { value: opacity },
            uMode: { value: style.mode },
            uMinPx: { value: style.minPx },
            uMaxPx: { value: style.maxPx ?? 14 },
            uCoreW: { value: style.coreW },
            uCoreMix: { value: style.coreMix },
          },
        ]),
        vertexShader: RIBBON_VERT,
        fragmentShader: RIBBON_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: depth,
        side: THREE.DoubleSide,
        blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        fog: true,
      });
    this.base = style.opacity;
    this.xbase = style.opacity * style.xray;
    this.mat = make(style.opacity, true);
    this.mesh = this.wrap(this.mat, name, 6);
    if (style.xray > 0) {
      // (shares uColor with the main pass: one colour to set)
      this.xmat = make(style.opacity * style.xray, false);
      this.xmat.uniforms.uColor = this.mat.uniforms.uColor;
      this.xray = this.wrap(this.xmat, name + '-xray', 5);
    }
  }

  private wrap(mat: THREE.Material, name: string, order: number) {
    const m = new THREE.Mesh(this.geo, mat);
    m.name = name;
    m.frustumCulled = false;
    m.renderOrder = order;
    m.visible = false;
    m.userData.noOutline = true;
    m.userData.noNormals = true;
    return m;
  }

  /** The edges' colour (the core keeps the style's). */
  color(c: THREE.Color) {
    this.mat.uniforms.uColor.value.copy(c);
  }

  /** Overall opacity, 0..1 of the style's. */
  set fade(k: number) {
    this.mat.uniforms.uOpacity.value = this.base * k;
    if (this.xmat) this.xmat.uniforms.uOpacity.value = this.xbase * k;
  }

  get count() {
    return this.n;
  }

  begin() {
    this.n = 0;
  }

  push(x: number, y: number, z: number, w: number, a: number) {
    if (this.n >= this.max) return;
    const p = this.pts,
      i = this.n * 5;
    p[i] = x;
    p[i + 1] = y;
    p[i + 2] = z;
    p[i + 3] = w;
    p[i + 4] = a;
    this.n++;
  }

  /** Lay the strip through the pushed points (hidden with fewer than two). */
  end() {
    const n = this.n;
    const on = n >= 2;
    this.mesh.visible = on;
    if (this.xray) this.xray.visible = on;
    if (!on) return;
    const P = this.pts;
    let arc = 0;
    let tx = 0,
      ty = 0,
      tz = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 5,
        b = Math.min(n - 1, i + 1) * 5;
      const dx = P[b] - P[a],
        dy = P[b + 1] - P[a + 1],
        dz = P[b + 2] - P[a + 2];
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // (two points on top of each other keep the last good tangent)
      if (dl > 1e-5) (tx = dx / dl), (ty = dy / dl), (tz = dz / dl);
      if (i > 0) {
        const j = (i - 1) * 5;
        arc += Math.hypot(P[i * 5] - P[j], P[i * 5 + 1] - P[j + 1], P[i * 5 + 2] - P[j + 2]);
      }
      const u = i / (n - 1);
      for (let s = 0; s < 2; s++) {
        const v = i * 2 + s;
        this.pos[v * 3] = P[i * 5];
        this.pos[v * 3 + 1] = P[i * 5 + 1];
        this.pos[v * 3 + 2] = P[i * 5 + 2];
        this.tan[v * 3] = tx;
        this.tan[v * 3 + 1] = ty;
        this.tan[v * 3 + 2] = tz;
        this.dat[v * 4] = s ? 1 : -1;
        this.dat[v * 4 + 1] = u;
        this.dat[v * 4 + 2] = P[i * 5 + 3];
        this.dat[v * 4 + 3] = P[i * 5 + 4];
        this.len[v] = arc;
      }
    }
    this.geo.setDrawRange(0, (n - 1) * 6);
    for (const k of ['position', 'aTan', 'aS', 'aL']) {
      const at = this.geo.attributes[k] as THREE.BufferAttribute;
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * 2 * at.itemSize);
      at.needsUpdate = true;
    }
  }

  hide() {
    this.n = 0;
    this.mesh.visible = false;
    if (this.xray) this.xray.visible = false;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.xmat?.dispose();
  }
}

// ---------------------------------------------------------------- fireworks

export interface FireworkStyle {
  additive: boolean;
  /** 0 comets of light (a round head, a tapering tail), 1 square pixels, 2 ink blots, 3 paper scraps */
  shape: number;
  /** the colours sparks burst in (the hitter's colour joins them), and the rockets' */
  colors: string[];
  rocket: string;
  /** colour multiplier for the sparks (HDR where bloom should catch them) */
  hdr: number;
  /** step time in 1/n s (pixel art); 0 = smooth */
  steps: number;
  /** flash at each burst (0 = none) */
  flash: number;
  /** sparks are never smaller than this many pixels of a 1080-row picture */
  minPx: number;
  /** spark size (m) */
  size: number;
}

const FW_VERT = /* glsl */ `
attribute vec3 aO; attribute vec3 aV; attribute vec4 aT; attribute vec4 aC; attribute vec4 aX;
uniform float uTime; uniform float uStep; uniform float uStreak; uniform float uMinPx;
varying vec2 vQ; varying vec3 vCol; varying float vA; varying float vSeed; varying float vKind; varying float vAspect; varying float vHot;
#include <common>
#include <fog_pars_vertex>
void main() {
  float t = uStep > 0.0 ? floor(uTime / uStep) * uStep : uTime;
  float age = t - aT.x;
  float life = aT.y;
  vKind = aT.w; vSeed = aT.z;
  if (age < 0.0 || age > life) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float k = aX.x;
  vec3 g = vec3(0.0, -9.81 * aX.y, 0.0);
  vec3 p; vec3 v;
  bool rocket = vKind > 0.5 && vKind < 1.5;
  bool flash = vKind > 1.5 && vKind < 2.5;
  if (rocket) {
    // climbing and slowing to where it bursts
    float s = age - 0.25 * age * age / life;
    p = aO + aV * s;
    v = aV * (1.0 - 0.5 * age / life);
  } else if (k > 1e-3) {
    float e = exp(-k * age);
    p = aO + aV * (1.0 - e) / k + g / k * (age - (1.0 - e) / k);
    v = aV * e + g / k * (1.0 - e);
  } else {
    p = aO + aV * age + 0.5 * g * age * age;
    v = aV + g * age;
  }
  float u = age / life;
  float size = aC.w;
  if (flash) size *= 0.55 + 0.9 * u;
  else if (!rocket) size *= 1.0 - 0.4 * u * u;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  // never smaller than uMinPx pixels of a 1080-row picture
  float perPx = 2.0 * max(-mv.z, 0.1) / (projectionMatrix[1][1] * 1080.0);
  size = max(size, uMinPx * perPx);
  vec3 vv = (viewMatrix * vec4(v, 0.0)).xyz;
  float L = length(vv.xy);
  vec2 dir = L > 1e-4 ? vv.xy / L : vec2(0.0, 1.0);
  // (dir.y, −dir.x): the quad keeps its winding (the other perpendicular mirrors it, and it's culled)
  vec2 nrm = vec2(dir.y, -dir.x);
  // a comet: its head at the spark, its tail streaming back along its motion; flashes are round
  float len = flash || uStreak <= 0.0 ? size : size + L * uStreak * (rocket ? 2.5 : 1.0);
  vec2 q = position.xy;
  if (flash || uStreak <= 0.0) mv.xy += q * size;
  else mv.xy += nrm * q.x * size + dir * (size * 0.5 - (0.5 - q.y) * len);
  vQ = vec2(q.x * 2.0, q.y + 0.5);
  vAspect = len / size;
  gl_Position = projectionMatrix * mv;
  // fade in fast, out towards the end; glitter flickers late in life
  float a = smoothstep(0.0, 0.03, age) * (1.0 - smoothstep(0.6, 1.0, u));
  if (flash) a = (1.0 - u) * (1.0 - u);
  if (aX.z > 0.5 && u > 0.4) {
    float h = fract(sin(dot(vec2(aT.z * 91.7, floor(uTime * 24.0)), vec2(12.9898, 78.233))) * 43758.5453);
    a *= step(0.45, h) * 1.25;
  }
  vA = a;
  vCol = aC.rgb;
  // white-hot as it bursts, the colour coming through as it cools
  vHot = rocket ? 1.0 : 1.0 - smoothstep(0.0, 0.25, u);
  vec4 mvPosition = mv;
  #include <fog_vertex>
}`;

const FW_FRAG = /* glsl */ `
uniform int uShape; uniform float uTime; uniform vec3 uHot;
varying vec2 vQ; varying vec3 vCol; varying float vA; varying float vSeed; varying float vKind; varying float vAspect; varying float vHot;
#include <common>
#include <fog_pars_fragment>
${NOISE}
void main() {
  float a;
  vec3 col = vCol;
  // along the quad in units of its width: 0 at the head's front, vAspect at the tail's end
  float s = (1.0 - vQ.y) * vAspect;
  float d = length(vec2(vQ.x * 0.5, s - 0.5));
  if (vKind > 1.5 && vKind < 2.5) {
    // a flash: a soft round glow
    a = pow(max(0.0, 1.0 - 2.0 * d), 2.0);
  } else if (uShape == 1) {
    a = s < 1.0 ? 1.0 : 0.0;
  } else if (uShape == 2) {
    // an ink drop, and a dry streak behind it
    float n = vnoise(vec2(vQ.x * 2.0, s * 1.5) + vSeed * 37.0);
    a = smoothstep(0.5, 0.36, d + (n - 0.5) * 0.28);
    float t = clamp((s - 0.5) / max(vAspect - 0.5, 1e-3), 0.0, 1.0);
    a = max(a, step(0.5, s) * smoothstep(0.34 * (1.0 - t), 0.2 * (1.0 - t), abs(vQ.x) * 0.5) * step(0.45, n + 0.25 * (1.0 - t)) * (1.0 - t));
  } else if (uShape == 3) {
    // a paper scrap tumbling (it narrows as it turns edge-on)
    float flip = abs(cos(uTime * 7.0 + vSeed * 40.0));
    a = step(abs(vQ.x), 0.3 + 0.7 * flip) * step(s, 1.0) * step(0.0, s);
  } else {
    // a comet: a round head, a tail tapering away behind it
    float head = 1.0 - smoothstep(0.3, 0.5, d);
    float t = clamp((s - 0.5) / max(vAspect - 0.5, 1e-3), 0.0, 1.0);
    float w = 0.36 * (1.0 - t);
    float tail = step(0.5, s) * (1.0 - smoothstep(w * 0.45, w, abs(vQ.x) * 0.5)) * pow(1.0 - t, 1.4) * 0.8;
    a = max(head, tail);
    // the head's heart runs white-hot early on
    col = mix(col, uHot, (1.0 - smoothstep(0.0, 0.3, d)) * vHot);
  }
  a *= vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;

/** one burst's pattern */
export type ShellKind = 'peony' | 'ring' | 'willow' | 'star';

export interface Shell {
  /** where the rocket leaves the ground, and where it bursts */
  from: THREE.Vector3;
  at: THREE.Vector3;
  /** seconds from now it's fired, and how long it climbs */
  delay: number;
  rise: number;
  kind: ShellKind;
  colors: THREE.Color[];
  /** burst radius, roughly (metres) */
  radius: number;
}

/** A pool of spark instances, one draw, flown on the GPU. Light shows with fire(). */
export class Fireworks {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aO: THREE.InstancedBufferAttribute;
  private aV: THREE.InstancedBufferAttribute;
  private aT: THREE.InstancedBufferAttribute;
  private aC: THREE.InstancedBufferAttribute;
  private aX: THREE.InstancedBufferAttribute;
  private next = 0;
  private time = 0;
  /** when the last spark written dies */
  private until = -1;
  private rocketCol: THREE.Color;
  private hdr: number;

  constructor(
    readonly max: number,
    readonly style: FireworkStyle,
  ) {
    this.rocketCol = new THREE.Color(style.rocket).multiplyScalar(Math.max(1, style.hdr));
    this.hdr = style.hdr;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    const inst = (k: number) => new THREE.InstancedBufferAttribute(new Float32Array(max * k), k).setUsage(THREE.DynamicDrawUsage);
    this.aO = inst(3);
    this.aV = inst(3);
    this.aT = inst(4);
    this.aC = inst(4);
    this.aX = inst(4);
    // unused slots never show: born in the far future
    for (let i = 0; i < max; i++) this.aT.setXYZW(i, 1e9, 0, 0, 0);
    g.setAttribute('aO', this.aO);
    g.setAttribute('aV', this.aV);
    g.setAttribute('aT', this.aT);
    g.setAttribute('aC', this.aC);
    g.setAttribute('aX', this.aX);
    g.instanceCount = max;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uStep: { value: style.steps > 0 ? 1 / style.steps : 0 },
          uStreak: { value: style.shape === 0 ? 0.09 : style.shape === 2 ? 0.05 : 0 },
          uMinPx: { value: style.minPx },
          uShape: { value: style.shape },
          uHot: { value: new THREE.Color(1, 0.97, 0.88).multiplyScalar(Math.max(1.3, style.hdr * 1.2)) },
        },
      ]),
      vertexShader: FW_VERT,
      fragmentShader: FW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'fireworks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
    this.mesh.userData.noOutline = true;
    this.mesh.userData.noNormals = true;
  }

  /** Light a show: each shell's rocket and its trail, the flash, the burst (and a heart of glitter). */
  fire(shells: Shell[], rng: () => number) {
    const lo = this.next;
    let wrapped = false;
    const put = (o: THREE.Vector3, vx: number, vy: number, vz: number, t0: number, life: number, kind: number, c: THREE.Color, size: number, drag: number, grav: number, twinkle: number) => {
      const i = this.next;
      this.aO.setXYZ(i, o.x, o.y, o.z);
      this.aV.setXYZ(i, vx, vy, vz);
      this.aT.setXYZW(i, t0, life, rng(), kind);
      this.aC.setXYZW(i, c.r, c.g, c.b, size);
      this.aX.setXYZW(i, drag, grav, twinkle, 0);
      this.until = Math.max(this.until, t0 + life);
      this.next = (i + 1) % this.max;
      if (this.next === 0) wrapped = true;
    };
    const tmp = new THREE.Vector3();
    const col = new THREE.Color();
    const S = this.style.size;
    const gold = new THREE.Color('#ffd98a');
    for (const s of shells) {
      const t0 = this.time + s.delay;
      const tb = t0 + s.rise;
      // the rocket: from the launch to the burst (it covers 3/4 of vt over its climb, see the shader)
      const k = 1 / (0.75 * s.rise);
      put(s.from, (s.at.x - s.from.x) * k, (s.at.y - s.from.y) * k, (s.at.z - s.from.z) * k, t0, s.rise, 1, this.rocketCol, S * 0.7, 0, 0, 0);
      // its sparkling trail
      for (let j = 0; j < 8; j++) {
        const tt = (j + 0.5) / 8;
        const f = tt - 0.25 * tt * tt;
        tmp.lerpVectors(s.from, s.at, f / 0.75);
        put(tmp, (rng() - 0.5) * 0.6, -0.4 - rng() * 0.6, (rng() - 0.5) * 0.6, t0 + tt * s.rise, 0.4 + rng() * 0.25, 0, this.rocketCol, S * 0.4, 1.5, 0.15, 1);
      }
      // the flash
      if (this.style.flash > 0) put(s.at, 0, 0, 0, tb, 0.3, 2, col.copy(s.colors[0]).lerp(WHITE, 0.55).multiplyScalar(this.hdr * this.style.flash), s.radius * 1.1, 0, 0, 0);
      // the burst
      const R = s.radius;
      const willow = s.kind === 'willow';
      const flat = s.kind === 'ring' || s.kind === 'star';
      const n = s.kind === 'ring' ? 84 : willow ? 110 : s.kind === 'star' ? 100 : 130;
      // a ring or a star is flat: its plane faces the field, tipped a little, randomly
      const tilt = (rng() - 0.5) * 0.7;
      const spin = rng() * Math.PI * 2;
      const drag = willow ? 2.1 : 1.6;
      for (let j = 0; j < n; j++) {
        let dx: number, dy: number, dz: number;
        if (flat) {
          const a = (j / n) * Math.PI * 2 + spin;
          // a star: five points (the radius swells towards each)
          const r = s.kind === 'star' ? 0.5 + 0.5 * Math.pow(Math.abs(Math.cos((a - spin) * 2.5)), 2.5) : 1;
          const cx = Math.cos(a) * r,
            cy = Math.sin(a) * r;
          dx = cx;
          dy = cy * Math.cos(tilt);
          dz = cy * Math.sin(tilt);
        } else {
          // an even sphere (a Fibonacci spiral)
          const y = 1 - (2 * (j + 0.5)) / n;
          const r = Math.sqrt(1 - y * y);
          const a = j * 2.39996 + spin;
          dx = Math.cos(a) * r;
          dy = y;
          dz = Math.sin(a) * r;
        }
        // the speed that carries a spark R metres before drag stops it
        const v = R * drag * (flat ? 0.96 + rng() * 0.08 : 0.85 + rng() * 0.3);
        const c = willow ? col.copy(gold).lerp(s.colors[j % 2 ? 0 : 3] ?? WHITE, 0.25) : col.copy(s.colors[j % s.colors.length]);
        c.multiplyScalar(this.hdr);
        const sz = S * (willow ? 0.75 : 1) * (0.85 + rng() * 0.3);
        put(s.at, dx * v, dy * v + (willow ? 1.4 : 0.5), dz * v, tb, willow ? 2.5 + rng() * 0.5 : 1.45 + rng() * 0.5, 0, c, sz, drag, willow ? 0.45 : 0.3, willow || rng() < 0.3 ? 1 : 0);
      }
      // a heart of glitter in the second colour (not in a willow)
      if (!willow) {
        const m = flat ? 18 : 34;
        const hc = s.colors[1] ?? WHITE;
        for (let j = 0; j < m; j++) {
          const y = 1 - (2 * (j + 0.5)) / m;
          const r = Math.sqrt(1 - y * y);
          const a = j * 2.39996 + spin;
          const v = R * 0.45 * drag * (0.8 + rng() * 0.4);
          put(s.at, Math.cos(a) * r * v, y * v + 0.3, Math.sin(a) * r * v, tb + 0.05, 1.1 + rng() * 0.4, 0, col.copy(hc).multiplyScalar(this.hdr), S * 0.7, drag, 0.25, 1);
        }
      }
    }
    // upload what was written (all of it if the pool wrapped round)
    const hi = this.next;
    for (const at of [this.aO, this.aV, this.aT, this.aC, this.aX]) {
      at.clearUpdateRanges();
      if (!wrapped && hi > lo) at.addUpdateRange(lo * at.itemSize, (hi - lo) * at.itemSize);
      at.needsUpdate = true;
    }
    this.mesh.visible = true;
  }

  update(dt: number) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    if (this.mesh.visible && this.time > this.until) this.mesh.visible = false;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const WHITE = new THREE.Color('#ffffff');

// ---------------------------------------------------------------- the ball's shadow

/**
 * The ball's shadow on the ground: a soft dark disc (or, on the glowing
 * worlds' dark floors, a ring of light) that never gets smaller than `minPx`
 * pixels across a 1080-row picture, so it still marks where a high ball is
 * over the field from a long way off. `set()` places it each frame.
 */
export class Spot {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(color: THREE.Color, o: { ring: boolean; additive: boolean; minPx: number }) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: color.clone() }, uOpacity: { value: 0 }, uR: { value: 0.2 }, uMinPx: { value: o.minPx } }]),
      vertexShader: /* glsl */ `
        uniform float uR; uniform float uMinPx;
        varying vec2 vQ;
        #include <common>
        #include <fog_pars_vertex>
        void main() {
          vQ = position.xz * 2.0;
          vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float d = max(-(viewMatrix * vec4(c, 1.0)).z, 0.1);
          float perPx = 2.0 * d / (projectionMatrix[1][1] * 1080.0);
          float r = max(uR, uMinPx * 0.5 * perPx);
          vec4 mvPosition = viewMatrix * vec4(c + vec3(position.x, 0.0, position.z) * 2.0 * r, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uOpacity;
        varying vec2 vQ;
        #include <common>
        #include <fog_pars_fragment>
        void main() {
          float r = length(vQ);
          ${
            o.ring
              ? 'float a = smoothstep(0.12, 0.0, abs(r - 0.72)) + 0.25 * (1.0 - smoothstep(0.0, 0.7, r));'
              : 'float a = (1.0 - smoothstep(0.35, 1.0, r)) * (0.75 + 0.25 * (1.0 - smoothstep(0.0, 0.45, r)));'
          }
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a * uOpacity);
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -8,
      fog: true,
    });
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'ball-shadow';
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.userData.noOutline = true;
    this.mesh.userData.noNormals = true;
  }

  /** On the ground at (x, y, z), radius r (m), this dark (0 hides it). */
  set(x: number, y: number, z: number, r: number, opacity: number) {
    this.mesh.visible = opacity > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.set(x, y, z);
    this.mat.uniforms.uR.value = r;
    this.mat.uniforms.uOpacity.value = opacity;
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- the ball's edge and halo

/**
 * An inverted hull `px` pixels (of a 1080-row picture) wide whatever the
 * distance: a fine dark edge that keeps a white ball apart from a white shirt
 * or pale paving, without turning into a thick cartoon line up close.
 */
export function hullMaterial(color: THREE.Color, px: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uPx: { value: px } },
    vertexShader: /* glsl */ `
      uniform float uPx;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        float perPx = 2.0 * max(-mv.z, 0.05) / (projectionMatrix[1][1] * 1080.0);
        mv.xyz += n * uPx * perPx;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.BackSide,
  });
}

/**
 * A ring round the batted ball in the hitter's colour (a thin white one hugging
 * it, the colour glowing out from there), turned to the camera: it finds the
 * ball against sky, stands or scenery. Place it with `set()` each frame.
 */
export class Halo {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(additive: boolean) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#ffffff') }, uOpacity: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float s = length(modelMatrix[0].xyz);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          gl_Position = projectionMatrix * viewMatrix * vec4(c + (right * position.x + up * position.y) * s, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
        void main() {
          float r = length(vUv * 2.0 - 1.0);
          float white = smoothstep(0.3, 0.36, r) * (1.0 - smoothstep(0.42, 0.5, r));
          float glow = smoothstep(0.36, 0.46, r) * (1.0 - smoothstep(0.55, 1.0, r));
          vec3 col = mix(uColor, vec3(1.0), white);
          float a = max(white * 0.9, glow * 0.85);
          if (a < 0.01) discard;
          gl_FragColor = vec4(col, a * uOpacity);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.name = 'ball-halo';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.mesh.userData.noOutline = true;
    this.mesh.userData.noNormals = true;
  }

  color(c: THREE.Color) {
    this.mat.uniforms.uColor.value.copy(c);
  }

  /** Round a ball at `p` of radius `r`, seen from `eye`, this strongly (0 hides it). */
  set(p: THREE.Vector3, r: number, eye: { x: number; y: number; z: number }, k: number) {
    this.mesh.visible = k > 0.01;
    if (!this.mesh.visible) return;
    // just behind the ball, so the ball draws in front of its own ring
    const dx = p.x - eye.x,
      dy = p.y - eye.y,
      dz = p.z - eye.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    this.mesh.position.set(p.x + (dx / d) * r, p.y + (dy / d) * r, p.z + (dz / d) * r);
    this.mesh.scale.setScalar(r * 5.2);
    this.mat.uniforms.uOpacity.value = k;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
