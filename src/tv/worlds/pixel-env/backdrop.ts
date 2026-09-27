// Bit Kingdom's backdrop, built like a 16-bit game's parallax layers: a
// dithered sky with the sun behind the players, snow-capped mountains far off
// with waterfalls down their faces, rolling green hills nearer, a rainbow
// framing the castle and puffy clouds drifting at every depth. The layers are
// real rings at different distances, so they slide past each other as the
// camera moves; the pixel pass (270 rows, 16 colours, ordered dither) turns
// them into pixel art. Every colour here is one of the palette's, or a blend
// the dither resolves into two of them.

import * as THREE from 'three';
import { NOISE } from '../../render/glsl';

type U = { uTime: THREE.IUniform };

const C = (hex: string) => new THREE.Color(hex);

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- sky

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uHorizon, uHaze, uMid, uTop, uSunDir, uCore, uDisc, uRim;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // pale at the horizon, the palette's sky blue, dithering towards navy overhead
  vec3 col = mix(uHorizon, uHaze, smoothstep(0.0, 0.04, h));
  col = mix(col, uMid, smoothstep(0.03, 0.2, h));
  col = mix(col, mix(uMid, uTop, 0.55), smoothstep(0.4, 0.95, h));
  // the sun: a pale core in a yellow disc, an orange rim, and eight short rays
  float a = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
  vec3 sx = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0))), sy = cross(sx, uSunDir);
  float ang = atan(dot(d, sy), dot(d, sx));
  float r = 0.055;
  if (a < r * 1.2) col = mix(uRim, uDisc, step(a, r));
  if (a < r * 0.6) col = uCore;
  float ray = step(r * 1.45, a) * step(a, r * 2.1) * step(0.93, cos(ang * 8.0));
  col = mix(col, uDisc, ray);
  gl_FragColor = vec4(col, 1.0);
}`;

/** The sky dome with the sun in it (`sun`: its direction). */
export function pixelSky(sun: THREE.Vector3) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(600, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: C('#fff1e8') },
        uHaze: { value: C('#c2c3c7') },
        uMid: { value: C('#29adff') },
        uTop: { value: C('#1d2b53') },
        uSunDir: { value: sun.clone().normalize() },
        uCore: { value: C('#fff1e8') },
        uDisc: { value: C('#ffec27') },
        uRim: { value: C('#ffa300') },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  m.renderOrder = -10;
  m.frustumCulled = false;
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- the rings of land

export interface Layer {
  radius: number;
  /** crest heights: saddles and peaks */
  height: [number, number];
  peaks: number;
  /** 0 = snowy mountains, 1 = green hills */
  kind: 0 | 1;
  seed: number;
  /** waterfalls: angles round the ring (0 = −z) */
  falls?: number[];
}

const LAND_VERT = /* glsl */ `
attribute vec4 aLand; // metres along, crest height, slope, kind
attribute float aAng;
varying vec4 vL;
varying float vY;
varying float vAng;
void main() {
  vL = aLand;
  vY = position.y;
  vAng = aAng;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LAND_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uRock, uRockLit, uRockDark, uSnow, uGreen, uGreenLit, uGreenDark, uWater, uFoam;
uniform float uFalls[6];
uniform float uR[2];
varying vec4 vL;
varying float vY;
varying float vAng;
${NOISE}
void main() {
  float u = vL.x, crest = vL.y, slope = vL.z;
  float below = crest - vY;
  vec3 col;
  // animation in steps, like sprite frames
  float t = floor(uTime * 8.0) / 8.0;
  if (vL.w < 0.5) {
    // mountains: the side facing the sun (+ slope) lit, the other in shade, darker low down
    col = slope > 0.0 ? uRockLit : uRock;
    col = mix(col, uRockDark, smoothstep(0.35, 0.05, vY / max(crest, 1.0)) * 0.8);
    // snow caps with a jagged lower edge
    float snowLine = crest * 0.62 + (vnoise(vec2(u * 0.25, 1.0)) - 0.5) * 9.0;
    if (vY > snowLine && below < 26.0) col = uSnow;
    // waterfalls from the snow down to the foot: stripes racing down
    for (int i = 0; i < 6; i++) {
      float dA = abs(vAng - uFalls[i]) * uR[0];
      if (uFalls[i] > -9.0 && dA < 2.2 && vY < snowLine) {
        float s = fract(vY * 0.18 + t * 1.6 + dA * 0.3);
        col = s < 0.35 ? uFoam : uWater;
        if (dA > 1.6) col = uFoam;
      }
    }
  } else {
    // hills: a light crest, bands of bushes, darker at the foot
    col = uGreen;
    if (below < 2.2 + (vnoise(vec2(u * 0.4, 3.0)) - 0.5) * 2.0) col = uGreenLit;
    float bush = step(0.72, vnoise(vec2(u * 0.35, vY * 0.3)));
    col = mix(col, uGreenDark, bush * step(3.0, below));
    col = mix(col, uGreenDark, smoothstep(0.3, 0.0, vY / max(crest, 1.0)) * 0.6);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** A crest profile along a ring (u = metres round it): rounded peaks over saddles. */
function crestOf(l: Layer, len: number) {
  const rnd = mulberry(l.seed);
  const [lo, hi] = l.height;
  const peaks = Array.from({ length: l.peaks }, (_, i) => ({ c: ((i + 0.5 + (rnd() - 0.5) * 0.7) / l.peaks) * len, h: lo + (hi - lo) * (0.35 + rnd() * 0.65), w: (len / l.peaks) * (0.4 + rnd() * 0.4) }));
  const sharp = l.kind === 0;
  return (u: number) => {
    let h = lo * 0.5;
    for (const p of peaks) {
      // wrap round the ring
      let d = Math.abs(u - p.c);
      d = Math.min(d, len - d) / p.w;
      if (d >= 1) continue;
      h = Math.max(h, p.h * (sharp ? 1 - Math.pow(d, 1.3) : Math.pow(1 - d * d, 1.5)));
    }
    return h;
  };
}

/** The rings of mountains and hills (one mesh; the waterfalls are painted on the mountains). */
export function land(u: U, layers: Layer[], sun: THREE.Vector3) {
  const pos: number[] = [];
  const attr: number[] = [];
  const ang: number[] = [];
  const idx: number[] = [];
  const falls: number[] = [-10, -10, -10, -10, -10, -10];
  let fi = 0;
  const radii = [0, 0];
  for (const l of layers) {
    const len = Math.PI * 2 * l.radius;
    const seg = Math.round(len / 3);
    const crest = crestOf(l, len);
    if (l.kind === 0) radii[0] = l.radius;
    else radii[1] = l.radius;
    for (const f of l.falls ?? []) if (fi < 6) falls[fi++] = f;
    const v0 = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const uu = (i / seg) * len;
      const a = (uu / len) * Math.PI * 2;
      const h = crest(uu);
      // a slope rising round the ring faces back along it: lit if that's towards the sun
      const slope = (crest(uu + 2) - crest(uu - 2)) * -(Math.cos(a) * sun.x + Math.sin(a) * sun.z);
      const x = Math.sin(a) * l.radius,
        z = -Math.cos(a) * l.radius;
      pos.push(x, -6, z, x, h, z);
      attr.push(uu, h, slope, l.kind, uu, h, slope, l.kind);
      ang.push(a, a);
    }
    for (let i = 0; i < seg; i++) {
      const a = v0 + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLand', new THREE.Float32BufferAttribute(attr, 4));
  g.setAttribute('aAng', new THREE.Float32BufferAttribute(ang, 1));
  g.setIndex(idx);
  const m = new THREE.Mesh(
    g,
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: u.uTime,
        uRock: { value: C('#83769c') },
        uRockLit: { value: C('#c2c3c7') },
        uRockDark: { value: C('#5f574f') },
        uSnow: { value: C('#fff1e8') },
        uGreen: { value: C('#008751') },
        uGreenLit: { value: C('#00e436') },
        uGreenDark: { value: C('#1d2b53') },
        uWater: { value: C('#29adff') },
        uFoam: { value: C('#fff1e8') },
        uFalls: { value: falls },
        uR: { value: radii },
      },
      vertexShader: LAND_VERT,
      fragmentShader: LAND_FRAG,
      side: THREE.DoubleSide,
    }),
  );
  m.frustumCulled = false;
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- the rainbow

const BOW_FRAG = /* glsl */ `
uniform vec3 uBands[6];
varying vec2 vUv;
void main() {
  // vUv.x: 0 inner edge → 1 outer; vUv.y: 0..1 along the arc
  int i = int(clamp(floor((1.0 - vUv.x) * 6.0), 0.0, 5.0));
  // its feet fade into the haze (the dither breaks them up)
  float a = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
  gl_FragColor = vec4(uBands[i], a * 0.92);
}`;

/** A rainbow arcing over the castle (a half ring facing the court). */
export function rainbow(center: THREE.Vector3, radius: number, width: number) {
  const g = new THREE.RingGeometry(radius - width, radius, 96, 1, 0, Math.PI);
  // uv: x across the band, y along the arc
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i);
    uv.setXY(i, (Math.hypot(x, y) - (radius - width)) / width, 1 - Math.atan2(y, x) / Math.PI);
  }
  const m = new THREE.Mesh(
    g,
    new THREE.ShaderMaterial({
      uniforms: { uBands: { value: ['#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c'].map(C) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: BOW_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  m.position.copy(center);
  m.renderOrder = -4;
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- clouds

const CLOUD_VERT = /* glsl */ `
attribute vec4 aOrbit; // radius, start angle, height, angular speed
attribute vec2 aCard;  // width, seed
uniform float uTime;
varying vec2 vP;
varying float vSeed;
void main() {
  // clouds move in whole steps, like sprites
  float t = floor(uTime * 8.0) / 8.0;
  float a = aOrbit.y + t * aOrbit.w;
  vec3 c = (modelMatrix * vec4(cos(a) * aOrbit.x, aOrbit.z, sin(a) * aOrbit.x, 1.0)).xyz;
  vec3 to = cameraPosition - c;
  vec3 right = normalize(vec3(to.z, 0.0, -to.x));
  vec3 wp = c + right * position.x * aCard.x + vec3(0.0, position.y * aCard.x * 0.5, 0.0);
  vP = vec2(position.x * 2.0, position.y);
  vSeed = aCard.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const CLOUD_FRAG = /* glsl */ `
uniform vec3 uWhite, uGrey, uShade;
varying vec2 vP;
varying float vSeed;
${NOISE}
void main() {
  // (p: −1..1 across, 0..1 up, the same scale both ways) a flat base with four
  // round puffs on it, the middle ones biggest
  vec2 p = vP;
  if (p.y < 0.1) discard;
  float inside = step(p.y, 0.3) * step(abs(p.x), 0.78);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float mid = 1.0 - abs(fi - 1.5) / 1.5;
    float R = mix(0.22, 0.4, mid) * (0.85 + 0.3 * hash11(vSeed * 3.0 + fi * 1.7));
    vec2 c = vec2((fi - 1.5) * 0.4 + (hash11(vSeed * 7.0 + fi) - 0.5) * 0.1, 0.3 + R * 0.15);
    inside = max(inside, step(length(p - c), R));
  }
  if (inside < 0.5) discard;
  // lit tops, a grey belly, a shaded underside
  vec3 col = uWhite;
  if (p.y < 0.22) col = uGrey;
  if (p.y < 0.14) col = uShade;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Clouds at every depth, drifting round the kingdom in sprite steps (one instanced draw). */
export class PixelClouds {
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private n: number;

  constructor(u: U, o: { count: number; radius: [number, number]; height: [number, number]; size: [number, number]; seed: number }) {
    const rnd = mulberry(o.seed);
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    const list: number[][] = [];
    for (let i = 0; i < o.count; i++) {
      const r = o.radius[0] + (o.radius[1] - o.radius[0]) * rnd();
      list.push([r, rnd() * Math.PI * 2, o.height[0] + (o.height[1] - o.height[0]) * rnd(), (1 + rnd()) / r, o.size[0] + (o.size[1] - o.size[0]) * rnd(), rnd() * 100]);
    }
    // far first
    list.sort((p, q) => q[0] - p[0]);
    g.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((c) => c.slice(0, 4))), 4));
    g.setAttribute('aCard', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((c) => c.slice(4, 6))), 2));
    g.instanceCount = o.count;
    this.geo = g;
    this.n = o.count;
    this.mesh = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        uniforms: { uTime: u.uTime, uWhite: { value: C('#fff1e8') }, uGrey: { value: C('#c2c3c7') }, uShade: { value: C('#83769c') } },
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -3;
    this.mesh.userData.noBatch = true;
  }

  setDetail(d: number) {
    this.geo.instanceCount = Math.round(this.n * (0.4 + 0.6 * d));
  }
}
