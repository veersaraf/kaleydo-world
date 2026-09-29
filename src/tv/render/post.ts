// A small post-processing toolkit: fullscreen passes, render targets, bloom.

import * as THREE from 'three';
import { FULLSCREEN_VERT, COLOR, NOISE, TONEMAP, FXAA } from './glsl';

const tri = new THREE.BufferGeometry();
tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export class Pass {
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  constructor(frag: string, uniforms: Record<string, THREE.IUniform> = {}, defines: Record<string, string | number> = {}) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: frag,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(tri, this.mat);
    this.mesh.frustumCulled = false;
  }
  get u() {
    return this.mat.uniforms;
  }
  render(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
    r.setRenderTarget(target);
    r.render(this.mesh, orthoCam);
  }
  dispose() {
    this.mat.dispose();
  }
}

export interface RTOpts {
  type?: THREE.TextureDataType;
  /** RGBA by default; one- and two-channel buffers halve or quarter the bandwidth */
  format?: THREE.PixelFormat;
  depth?: boolean;
  samples?: number;
  filter?: THREE.MagnificationTextureFilter;
}

export function makeRT(w: number, h: number, o: RTOpts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: o.type ?? THREE.HalfFloatType,
    format: o.format ?? THREE.RGBAFormat,
    minFilter: o.filter ?? THREE.LinearFilter,
    magFilter: o.filter ?? THREE.LinearFilter,
    depthBuffer: !!o.depth,
    samples: o.samples ?? 0,
    generateMipmaps: false,
  });
  if (o.depth) {
    rt.depthTexture = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h));
    rt.depthTexture.type = THREE.UnsignedIntType;
  }
  return rt;
}

// ------------------------------------------------------------------ bloom

const DOWN = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee; uniform int uFirst;
varying vec2 vUv;
${COLOR}
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = (rq * rq) / (4.0 * uKnee + 1e-5);
  float w = max(rq, br - uThreshold) / max(br, 1e-5);
  return c * w;
}
void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tSrc, vUv + t * vec2(-2, 2)).rgb, b = texture2D(tSrc, vUv + t * vec2(0, 2)).rgb, c = texture2D(tSrc, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture2D(tSrc, vUv + t * vec2(-2, 0)).rgb, e = texture2D(tSrc, vUv).rgb, f = texture2D(tSrc, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture2D(tSrc, vUv + t * vec2(-2, -2)).rgb, h = texture2D(tSrc, vUv + t * vec2(0, -2)).rgb, i = texture2D(tSrc, vUv + t * vec2(2, -2)).rgb;
  vec3 j = texture2D(tSrc, vUv + t * vec2(-1, 1)).rgb, k = texture2D(tSrc, vUv + t * vec2(1, 1)).rgb;
  vec3 l = texture2D(tSrc, vUv + t * vec2(-1, -1)).rgb, m = texture2D(tSrc, vUv + t * vec2(1, -1)).rgb;
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uFirst == 1) col = prefilter(min(col, vec3(40.0)));
  gl_FragColor = vec4(col, 1.0);
}`;

const UP = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tPrev; uniform vec2 uTexel; uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + 2.0 * texture2D(tSrc, vUv + vec2(0, t.y)).rgb + texture2D(tSrc, vUv + t).rgb
    + 2.0 * texture2D(tSrc, vUv + vec2(-t.x, 0)).rgb + 4.0 * texture2D(tSrc, vUv).rgb + 2.0 * texture2D(tSrc, vUv + vec2(t.x, 0)).rgb
    + texture2D(tSrc, vUv - t).rgb + 2.0 * texture2D(tSrc, vUv + vec2(0, -t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb;
  gl_FragColor = vec4(s / 16.0 + texture2D(tPrev, vUv).rgb, 1.0);
}`;

export class Bloom {
  levels: THREE.WebGLRenderTarget[] = [];
  ups: THREE.WebGLRenderTarget[] = [];
  down = new Pass(DOWN, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 1.0 },
    uKnee: { value: 0.5 },
    uFirst: { value: 1 },
  });
  up = new Pass(UP, { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } });
  threshold = 1;
  knee = 0.5;
  constructor(public count = 5) {}

  setSize(w: number, h: number) {
    if (this.levels.length && this.levels[0].width === Math.max(1, Math.floor(w / 2)) && this.levels[0].height === Math.max(1, Math.floor(h / 2))) return;
    this.levels.forEach((l) => l.dispose());
    this.ups.forEach((l) => l.dispose());
    this.levels = [];
    this.ups = [];
    let cw = Math.floor(w / 2),
      ch = Math.floor(h / 2);
    for (let i = 0; i < this.count; i++) {
      this.levels.push(makeRT(cw, ch));
      this.ups.push(makeRT(cw, ch));
      cw = Math.max(1, Math.floor(cw / 2));
      ch = Math.max(1, Math.floor(ch / 2));
    }
  }

  /** Returns the bloom texture (same aspect, half res). */
  render(r: THREE.WebGLRenderer, src: THREE.Texture): THREE.Texture {
    const d = this.down.u;
    d.uThreshold.value = this.threshold;
    d.uKnee.value = this.knee;
    let input: THREE.Texture = src;
    let iw = this.levels[0].width * 2,
      ih = this.levels[0].height * 2;
    for (let i = 0; i < this.levels.length; i++) {
      d.tSrc.value = input;
      d.uTexel.value.set(1 / iw, 1 / ih);
      d.uFirst.value = i === 0 ? 1 : 0;
      this.down.render(r, this.levels[i]);
      input = this.levels[i].texture;
      iw = this.levels[i].width;
      ih = this.levels[i].height;
    }
    // upsample chain: ups[i] = up(ups[i+1]) + levels[i]
    const u = this.up.u;
    let prev = this.levels[this.levels.length - 1].texture;
    for (let i = this.levels.length - 2; i >= 0; i--) {
      u.tSrc.value = prev;
      u.tPrev.value = this.levels[i].texture;
      u.uTexel.value.set(1 / this.levels[i + 1].width, 1 / this.levels[i + 1].height);
      this.up.render(r, this.ups[i]);
      prev = this.ups[i].texture;
    }
    return prev;
  }

  dispose() {
    this.levels.forEach((l) => l.dispose());
    this.ups.forEach((l) => l.dispose());
    this.down.dispose();
    this.up.dispose();
  }
}

// ------------------------------------------------------------------ normals prepass

export class NormalPass {
  rt: THREE.WebGLRenderTarget;
  mat = new THREE.MeshNormalMaterial();
  constructor(w: number, h: number) {
    this.rt = makeRT(w, h, { type: THREE.UnsignedByteType, depth: true });
  }
  setSize(w: number, h: number) {
    this.rt.setSize(w, h);
  }
  private hidden: THREE.Object3D[] = [];
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera) {
    const bg = scene.background;
    const ov = scene.overrideMaterial;
    const fog = scene.fog;
    // transparent things (trails, particles, nets, blob shadows) would render as solid slabs
    this.hidden.length = 0;
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (o.visible && ((m && !Array.isArray(m) && (m.transparent || m.alphaTest > 0)) || o.userData.noNormals)) {
        o.visible = false;
        this.hidden.push(o);
      }
    });
    scene.background = null;
    scene.overrideMaterial = this.mat;
    scene.fog = null;
    const cc = r.getClearColor(new THREE.Color());
    const ca = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x8080ff, 1);
    r.clear();
    r.render(scene, cam);
    r.setClearColor(cc, ca);
    scene.background = bg;
    scene.overrideMaterial = ov;
    scene.fog = fog;
    for (const o of this.hidden) o.visible = true;
  }
  dispose() {
    this.rt.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------ final grade

export const FINAL_FRAG = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uBloom; uniform float uExposure;
uniform float uSat; uniform float uContrast; uniform vec3 uLift; uniform vec3 uGain; uniform float uVignette;
uniform float uGrain; uniform float uTime; uniform vec2 uRes; uniform float uAberration; uniform int uTonemap;
uniform float uFlash; uniform vec3 uFlashColor; uniform float uScan; uniform float uPaper;
// opt-in effects (render/effects.ts) — each off (0) unless a world asks for it
uniform sampler2D tDepth; uniform sampler2D tZ; uniform vec2 uClip;
uniform sampler2D tAO; uniform float uAO; uniform vec2 uAORes; uniform float uAOProtect;
uniform sampler2D tShafts; uniform float uShafts; uniform vec3 uSun; uniform vec3 uSunColor; uniform float uFlare;
uniform sampler2D tDof; uniform float uDof; uniform vec2 uDofFocus;
uniform highp sampler3D tLut; uniform float uLut;
uniform float uFxaa;
varying vec2 vUv;
${COLOR}
${NOISE}
${TONEMAP}
${FXAA}
float linZ(float d) { return (uClip.x * uClip.y) / (uClip.y - (uClip.y - uClip.x) * d); }
// glare around the sun and soft ghosts along the line through the centre, when
// the sun itself is in open sky (the half-res depth, around its spot)
vec3 sunFlare(vec2 uv) {
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 sun = uSun.xy;
  float edge = smoothstep(0.0, 0.06, min(min(sun.x, 1.0 - sun.x), min(sun.y, 1.0 - sun.y)));
  if (edge <= 0.0) return vec3(0.0);
  float vis = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 o = (i == 0 ? vec2(0.0) : vec2(i == 1 ? 1.0 : i == 2 ? -1.0 : 0.0, i == 3 ? 1.0 : i == 4 ? -1.0 : 0.0)) * 0.012;
    vis += step(uClip.y * 0.98, texture2D(tZ, sun + o / asp).r);
  }
  vis *= 0.2 * edge * uSun.z;
  if (vis <= 0.0) return vec3(0.0);
  vec2 dv = (uv - sun) * asp;
  float d = length(dv);
  float ang = atan(dv.y, dv.x);
  float rays = pow(max(0.0, cos(ang * 6.0 + 0.4)), 40.0) * 0.6 + pow(max(0.0, cos(ang * 5.0 - 1.1)), 80.0) * 0.4;
  vec3 c = uSunColor * (exp(-d * 16.0) * 0.35 + rays * exp(-d * 7.0) * 0.3);
  vec2 axis = vec2(0.5) - sun;
  c += vec3(1.0, 0.75, 0.45) * smoothstep(0.075, 0.03, length((uv - (sun + axis * 0.7)) * asp)) * 0.05;
  c += vec3(0.5, 0.9, 1.0) * smoothstep(0.045, 0.02, length((uv - (sun + axis * 1.25)) * asp)) * 0.07;
  c += vec3(0.7, 1.0, 0.6) * smoothstep(0.12, 0.08, length((uv - (sun + axis * 1.6)) * asp)) * 0.035;
  c += vec3(1.0, 0.55, 0.8) * smoothstep(0.03, 0.012, length((uv - (sun + axis * 2.05)) * asp)) * 0.08;
  float halo = length((uv - sun - axis * 1.0) * asp);
  c += vec3(0.6, 0.8, 1.0) * smoothstep(0.03, 0.0, abs(halo - 0.33)) * 0.025;
  return c * vis;
}
void main() {
  vec2 uv = vUv;
  // anti-aliasing for scenes drawn without MSAA: where to sample the scene
  vec2 suv = uFxaa > 0.0 ? fxaaUv(tScene, uv, 1.0 / uRes) : uv;
  vec3 col;
  if (uAberration > 0.0) {
    vec2 d = (uv - 0.5) * uAberration;
    col = vec3(texture2D(tScene, suv + d).r, texture2D(tScene, suv).g, texture2D(tScene, suv - d).b);
  } else col = texture2D(tScene, suv).rgb;
  float z = uAO > 0.0 || uDof > 0.0 ? linZ(texture2D(tDepth, uv).r) : 0.0;
  if (uDof > 0.0) {
    vec4 b = texture2D(tDof, uv);
    col = mix(col, b.rgb, smoothstep(0.1, 0.45, uDofFocus.y * abs(z - uDofFocus.x) / max(z, 1e-3)));
  }
  if (uAO > 0.0) {
    // depth-aware upsample of the half-res AO: the four texels around, weighed
    // by how close their depth is to this pixel's
    vec2 p = uv * uAORes - 0.5;
    vec2 fr = fract(p);
    vec2 b0 = (floor(p) + 0.5) / uAORes;
    vec2 t = 1.0 / uAORes;
    vec2 s0 = texture2D(tAO, b0).rg, s1 = texture2D(tAO, b0 + vec2(t.x, 0.0)).rg;
    vec2 s2 = texture2D(tAO, b0 + vec2(0.0, t.y)).rg, s3 = texture2D(tAO, b0 + t).rg;
    vec4 w = vec4((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y) + 1e-3;
    w /= 0.02 + abs(vec4(s0.g, s1.g, s2.g, s3.g) - z) / z;
    float ao = dot(w, vec4(s0.r, s1.r, s2.r, s3.r)) / dot(w, vec4(1.0));
    // ambient occlusion: sunlit, bright surfaces keep more of their light
    float lit = smoothstep(0.3, 1.1, luma(col));
    col *= mix(1.0, ao, uAO * (1.0 - uAOProtect * lit));
  }
  // beams read against things in front of the sun; over open sky (which glows
  // around the sun already) they would only be haze
  if (uShafts > 0.0) col += texture2D(tShafts, uv).r * uSunColor * uShafts * (1.0 - 0.75 * step(uClip.y * 0.98, texture2D(tZ, uv).r));
  col += texture2D(tBloom, uv).rgb * uBloom;
  if (uFlare > 0.0) col += sunFlare(uv) * uFlare;
  col *= uExposure;
  if (uTonemap == 1) col = aces(col);
  else if (uTonemap == 2) col = agx(col);
  else if (uTonemap == 3) col = neutral(col);
  col = saturate3(col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  col = col * uGain + uLift * (1.0 - col);
  float v = smoothstep(0.95, 0.25, length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 0.9));
  col *= mix(1.0 - uVignette, 1.0, v);
  col = mix(col, uFlashColor, uFlash);
  vec3 s = toSRGB(clamp(col, 0.0, 1.0));
  if (uLut > 0.0) s = mix(s, texture(tLut, s * (31.0 / 32.0) + 0.5 / 32.0).rgb, uLut);
  if (uScan > 0.0) s *= 1.0 - uScan * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 * 0.66));
  if (uPaper > 0.0) {
    float f = fbm(gl_FragCoord.xy / 160.0) * 0.55 + vnoise(gl_FragCoord.xy / 2.5) * 0.3 + vnoise(gl_FragCoord.xy * vec2(0.04, 0.4)) * 0.15;
    s *= 1.0 - uPaper * (f - 0.45);
  }
  s += (hash21(uv * uRes + fract(uTime) * 91.7) - 0.5) * uGrain;
  gl_FragColor = vec4(s, 1.0);
}`;

export function finalPass() {
  return new Pass(FINAL_FRAG, {
    tScene: { value: null },
    tBloom: { value: null },
    uBloom: { value: 0 },
    uExposure: { value: 1 },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uVignette: { value: 0.25 },
    uGrain: { value: 0.02 },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uAberration: { value: 0 },
    uTonemap: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uScan: { value: 0 },
    uPaper: { value: 0 },
    tDepth: { value: null },
    tZ: { value: null },
    uClip: { value: new THREE.Vector2(0.1, 1000) },
    tAO: { value: null },
    uAO: { value: 0 },
    uAORes: { value: new THREE.Vector2(1, 1) },
    uAOProtect: { value: 0.5 },
    tShafts: { value: null },
    uShafts: { value: 0 },
    uSun: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uFlare: { value: 0 },
    tDof: { value: null },
    uDof: { value: 0 },
    uDofFocus: { value: new THREE.Vector2(10, 1) },
    tLut: { value: null },
    uLut: { value: 0 },
    uFxaa: { value: 0 },
  });
}

/** 1x1 black texture for unused samplers. */
export const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK.needsUpdate = true;
