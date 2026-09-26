// A small post-processing toolkit: fullscreen passes, render targets, bloom.

import * as THREE from 'three';
import { FULLSCREEN_VERT, COLOR, NOISE } from './glsl';

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
  depth?: boolean;
  samples?: number;
  filter?: THREE.MagnificationTextureFilter;
}

export function makeRT(w: number, h: number, o: RTOpts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: o.type ?? THREE.HalfFloatType,
    format: THREE.RGBAFormat,
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
varying vec2 vUv;
${COLOR}
${NOISE}
void main() {
  vec2 uv = vUv;
  vec3 col;
  if (uAberration > 0.0) {
    vec2 d = (uv - 0.5) * uAberration;
    col = vec3(texture2D(tScene, uv + d).r, texture2D(tScene, uv).g, texture2D(tScene, uv - d).b);
  } else col = texture2D(tScene, uv).rgb;
  col += texture2D(tBloom, uv).rgb * uBloom;
  col *= uExposure;
  if (uTonemap == 1) col = aces(col);
  col = saturate3(col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  col = col * uGain + uLift * (1.0 - col);
  float v = smoothstep(0.95, 0.25, length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 0.9));
  col *= mix(1.0 - uVignette, 1.0, v);
  col = mix(col, uFlashColor, uFlash);
  vec3 s = toSRGB(clamp(col, 0.0, 1.0));
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
  });
}

/** 1x1 black texture for unused samplers. */
export const BLACK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK.needsUpdate = true;
