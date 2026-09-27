// What drifts round the asteroid: a belt of tumbling rocks lit by the star and
// rimmed in the nebula's pink, the crystals on the platform's edge breathing
// light, motes of dust rising in the low gravity, and a band of energy running
// round the rim of the platform. Each is one draw, animated in its shader.

import * as THREE from 'three';
import { NOISE } from '../../render/glsl';

type U = { uTime: THREE.IUniform };

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the belt

const ROCK_VERT = /* glsl */ `
attribute vec4 aOrbit; // radius, start angle, height, angular speed
attribute vec4 aSpin;  // axis (xyz), spin speed
attribute vec4 aSize;  // scale xyz, seed
uniform float uTime;
varying vec3 vP;
varying vec3 vCam;
varying float vSeed;
vec3 rot(vec3 v, vec3 k, float a) { return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1.0 - cos(a)); }
void main() {
  vec3 p = rot(position * aSize.xyz, aSpin.xyz, uTime * aSpin.w + aSize.w * 6.0);
  float a = aOrbit.y + uTime * aOrbit.w;
  vec3 c = vec3(cos(a) * aOrbit.x, aOrbit.z + sin(uTime * 0.3 + aSize.w * 9.0) * 1.2, sin(a) * aOrbit.x);
  vP = c + p;
  vSeed = aSize.w;
  vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 1.0);
}`;

const ROCK_FRAG = /* glsl */ `
uniform vec3 uLight;
uniform vec3 uRimDir;
varying vec3 vP;
varying vec3 vCam;
varying float vSeed;
${NOISE}
void main() {
  // faceted: the face's own normal
  vec3 n = normalize(cross(dFdx(vP), dFdy(vP)));
  vec3 V = normalize(vCam - vP);
  if (dot(n, V) < 0.0) n = -n;
  vec3 albedo = mix(vec3(0.16, 0.13, 0.24), vec3(0.28, 0.22, 0.34), hash11(vSeed * 91.0));
  // pitted: a little per-facet variation
  albedo *= 0.8 + 0.4 * hash31(floor(vP * 1.7));
  float dif = max(dot(n, uLight), 0.0);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 2.0);
  vec3 col = albedo * (vec3(0.07, 0.05, 0.15) + vec3(1.05, 1.0, 1.2) * dif);
  // rim light: the nebula's pink on the side away from the star, the star's white on the other
  col += vec3(1.7, 0.4, 1.3) * rim * (0.25 + 0.75 * max(dot(n, uRimDir), 0.0));
  col += vec3(1.0, 1.05, 1.5) * rim * dif * 0.9;
  // a few carry veins of glowing crystal
  float vein = step(0.8, hash11(vSeed * 13.0)) * smoothstep(0.1, 0.0, abs(vnoise3(vP * 1.3) - 0.5));
  col += vec3(0.3, 1.4, 1.7) * vein;
  gl_FragColor = vec4(col, 1.0);
}`;

export interface BeltOpts {
  count: number;
  /** orbit radius and height ranges */
  radius: [number, number];
  height: [number, number];
  /** sizes (the few biggest are the last ones, further out) */
  size: [number, number];
  light: THREE.Vector3;
  rimDir: THREE.Vector3;
  seed: number;
}

/** Tumbling rocks orbiting the asteroid slowly (one instanced draw). */
export class Belt {
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private n: number;

  constructor(u: U, o: BeltOpts) {
    const rnd = mulberry(o.seed);
    // a lumpy rock
    const base = new THREE.IcosahedronGeometry(1, 1);
    const p = base.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 0.78 + 0.32 * Math.abs(Math.sin(v.x * 3.1 + 1.2) * Math.sin(v.y * 2.7 + 0.4) * Math.sin(v.z * 3.3 + 2.1)) + (rnd() - 0.5) * 0.08;
      p.setXYZ(i, v.x * k, v.y * k, v.z * k);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.attributes.position);
    geo.index = base.index;
    const orbit = new Float32Array(o.count * 4);
    const spin = new Float32Array(o.count * 4);
    const size = new Float32Array(o.count * 4);
    const ax = new THREE.Vector3();
    for (let i = 0; i < o.count; i++) {
      const big = i > o.count * 0.9;
      const r = big ? o.radius[1] * (0.6 + rnd() * 0.4) : o.radius[0] + (o.radius[1] - o.radius[0]) * Math.pow(rnd(), 1.4);
      const s = big ? o.size[1] * (0.6 + rnd() * 0.4) : o.size[0] + (o.size[1] - o.size[0]) * 0.35 * Math.pow(rnd(), 2);
      orbit.set([r, rnd() * Math.PI * 2, o.height[0] + (o.height[1] - o.height[0]) * rnd(), (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd()) * (3 / r)], i * 4);
      ax.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      spin.set([ax.x, ax.y, ax.z, (rnd() - 0.5) * 0.6], i * 4);
      size.set([s * (0.8 + rnd() * 0.4), s * (0.7 + rnd() * 0.4), s * (0.8 + rnd() * 0.4), rnd()], i * 4);
    }
    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
    geo.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spin, 4));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 4));
    geo.instanceCount = o.count;
    this.geo = geo;
    this.n = o.count;
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { uTime: u.uTime, uLight: { value: o.light.clone().normalize() }, uRimDir: { value: o.rimDir.clone().normalize() } },
        vertexShader: ROCK_VERT,
        fragmentShader: ROCK_FRAG,
        fog: false,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.userData.noBatch = true;
  }

  /** Fewer small rocks at low detail (the big ones are last: keep the tail) */
  setDetail(d: number) {
    this.geo.instanceCount = Math.round(this.n * (0.4 + 0.6 * d));
  }
}

// ---------------------------------------------------------------- crystals

const CRYSTAL_VERT = /* glsl */ `
attribute vec4 aGlow; // colour (HDR), phase
uniform float uTime;
varying vec3 vC;
varying vec3 vN;
void main() {
  float k = 0.9 + 0.45 * sin(uTime * 1.6 + aGlow.w);
  vC = aGlow.rgb * k;
  vN = normalize(mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const CRYSTAL_FRAG = /* glsl */ `
varying vec3 vC;
varying vec3 vN;
void main() {
  // facets catch the light differently: a little shading keeps them solid
  gl_FragColor = vec4(vC * (0.75 + 0.35 * abs(vN.y) + 0.2 * abs(vN.x)), 1.0);
}`;

/** Crystals round the platform's rim, breathing light (one instanced draw). */
export function crystals(u: U, at: { x: number; y: number; z: number; sy: number; rot: THREE.Euler; color: THREE.Color }[]) {
  const geo = new THREE.OctahedronGeometry(1, 0);
  geo.deleteAttribute('uv');
  const glow = new Float32Array(at.length * 4);
  const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({ uniforms: { uTime: u.uTime }, vertexShader: CRYSTAL_VERT, fragmentShader: CRYSTAL_FRAG, fog: false }), at.length);
  const M = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  at.forEach((c, i) => {
    mesh.setMatrixAt(i, M.compose(new THREE.Vector3(c.x, c.y, c.z), q.setFromEuler(c.rot), new THREE.Vector3(0.5, c.sy, 0.5)));
    glow.set([c.color.r, c.color.g, c.color.b, i * 2.39], i * 4);
  });
  geo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 4));
  mesh.computeBoundingSphere();
  mesh.userData.noBatch = true;
  return mesh;
}

// ---------------------------------------------------------------- dust

const DUST_VERT = /* glsl */ `
attribute vec4 aMote; // x, z, phase, speed (m/s up)
uniform float uTime;
uniform float uH;
varying float vA;
varying vec2 vQ;
void main() {
  float y = fract(aMote.z + uTime * aMote.w / uH) * uH;
  // drifting as they rise, turning slowly about the court
  float sw = uTime * 0.05 + aMote.z * 6.0;
  vec3 c = vec3(aMote.x + sin(sw) * 0.8, y, aMote.y + cos(sw * 1.3) * 0.8);
  vA = smoothstep(0.0, 0.15, y / uH) * (1.0 - smoothstep(0.6, 1.0, y / uH)) * (0.5 + 0.5 * sin(uTime * 3.0 + aMote.z * 50.0));
  vQ = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * 0.09;
  gl_Position = projectionMatrix * mv;
}`;

const DUST_FRAG = /* glsl */ `
varying float vA;
varying vec2 vQ;
void main() {
  float r = dot(vQ, vQ);
  if (r > 1.0) discard;
  gl_FragColor = vec4(vec3(0.8, 0.85, 1.5) * (1.0 - r) * vA * 1.6, 1.0);
}`;

/** Motes rising slowly off the platform all round the court (not over it). */
export function dust(u: U, count: number, seed = 3) {
  const rnd = mulberry(seed);
  const quad = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // an annulus round the court, clear of the play area
    let x = 0,
      z = 0;
    do {
      const ang = rnd() * Math.PI * 2,
        r = 14 + rnd() * 16;
      x = Math.cos(ang) * r;
      z = Math.sin(ang) * r * 1.25;
    } while (Math.abs(x) < 13 && Math.abs(z) < 21);
    a.set([x, z, rnd(), 0.25 + rnd() * 0.45], i * 4);
  }
  g.setAttribute('aMote', new THREE.InstancedBufferAttribute(a, 4));
  g.instanceCount = count;
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { uTime: u.uTime, uH: { value: 12 } }, vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  m.frustumCulled = false;
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- the rim

const RIM_VERT = /* glsl */ `
attribute vec2 aRim; // angle round the rim, 0 at the band's foot → 1 at the top of the curtain
varying vec2 vR;
void main() {
  vR = aRim;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RIM_FRAG = /* glsl */ `
uniform float uTime, uBeat;
varying vec2 vR;
void main() {
  float a = vR.x, h = vR.y;
  // the band on the rock's edge (h < 0.25) and a faint curtain of light above it
  float band = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.17, 0.25, h));
  float curtain = smoothstep(0.25, 0.3, h) * pow(1.0 - (h - 0.25) / 0.75, 2.5) * 0.35;
  // pulses racing round it
  float pulse = pow(0.5 + 0.5 * sin(a * 14.0 - uTime * 2.4), 6.0) + pow(0.5 + 0.5 * sin(a * 5.0 + uTime * 1.3), 12.0) * 0.8;
  vec3 c = mix(vec3(0.55, 0.3, 1.6), vec3(0.3, 1.3, 1.8), pulse);
  gl_FragColor = vec4(c * (band * (1.0 + pulse * 1.5) + curtain * (0.6 + pulse)) * (1.0 + uBeat * 0.4), 1.0);
}`;

/** A band of energy round the platform's rim (an ellipse, `rx` by `rz`), with a faint curtain rising off it. */
export function rimGlow(u: { uTime: THREE.IUniform; uBeat: THREE.IUniform }, rx: number, rz: number) {
  const seg = 160;
  const pos: number[] = [];
  const rim: number[] = [];
  const idx: number[] = [];
  // rows: the band down the rock's edge, then the curtain up into the air
  const rows: [number, number, number][] = [
    [-0.55, 1.01, 0],
    [0.02, 1.0, 0.25],
    [2.4, 1.0, 1],
  ];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    for (const [y, k, h] of rows) {
      pos.push(Math.cos(a) * rx * k, y, Math.sin(a) * rz * k);
      rim.push(a, h);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let r = 0; r < rows.length - 1; r++) {
      const a = i * rows.length + r,
        b = a + rows.length;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aRim', new THREE.Float32BufferAttribute(rim, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: RIM_VERT, fragmentShader: RIM_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  m.userData.noBatch = true;
  return m;
}
