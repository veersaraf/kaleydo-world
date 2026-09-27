// Neon Drive's horizon: wireframe mountains, a city of lit windows, and an
// elevated highway with the traffic streaming along it and flying cars
// crossing the sky — all in a handful of draws.
//
//  • The mountains are one mesh: a dark fill with every triangle's edges drawn
//    in light (barycentric coordinates), magenta at the foot, cyan on the peaks,
//    flaring on the beat.
//  • The city is one mesh of boxes; its windows are worked out in the shader
//    from where each fragment is, so there are no textures and no per-tower
//    materials.
//  • Every light trail — cars on the highway, flying cars in the sky — is one
//    instanced quad moving along its own lane in the vertex shader.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NOISE } from '../../render/glsl';

type U = { uTime: THREE.IUniform; uBeat: THREE.IUniform };

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- mountains

export interface Massif {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  seed: number;
}

const MTN_VERT = /* glsl */ `
attribute vec3 aBary;
attribute float aH;
varying vec3 vBary;
varying float vH;
varying float vDist;
void main() {
  vBary = aBary;
  vH = aH;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vDist = length(w.xz);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const MTN_FRAG = /* glsl */ `
uniform float uTime, uBeat;
varying vec3 vBary;
varying float vH;
varying float vDist;
void main() {
  vec3 fw = fwidth(vBary);
  vec3 e = smoothstep(vec3(0.0), fw * 1.3, vBary);
  float wire = 1.0 - min(min(e.x, e.y), e.z);
  vec3 fill = mix(vec3(0.012, 0.0, 0.03), vec3(0.06, 0.0, 0.1), vH);
  vec3 wc = mix(vec3(1.0, 0.1, 0.9), vec3(0.25, 0.85, 1.6), smoothstep(0.35, 1.0, vH));
  // on every beat a band of light climbs from the foot to the peaks as the beat fades
  float band = exp(-pow((vH - (1.0 - uBeat) * 1.1) * 8.0, 2.0)) * smoothstep(0.02, 0.25, uBeat);
  float pulse = 1.1 + uBeat * 0.5 + band * 3.0;
  float fade = 0.35 + 0.65 * exp(-vDist * 0.003);
  gl_FragColor = vec4(fill * (1.0 + band * 2.0) + wc * wire * pulse * fade, 1.0);
}`;

/** Wireframe massifs (one mesh). Each is a heightfield patch rising from the floor. */
export function mountains(u: U, list: Massif[]) {
  const parts: THREE.BufferGeometry[] = [];
  for (const m of list) {
    const g0 = new THREE.PlaneGeometry(m.w, m.d, 28, 11);
    g0.rotateX(-Math.PI / 2);
    const pos = g0.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i),
        pz = pos.getZ(i);
      const edge = Math.min(1, (1 - Math.abs(px) / (m.w / 2)) * 3) * Math.min(1, (1 - Math.abs(pz) / (m.d / 2)) * 3);
      const n = Math.abs(Math.sin(px * 0.05 + m.seed) * Math.cos(pz * 0.07 + m.seed * 2)) + 0.5 * Math.abs(Math.sin(px * 0.13 + pz * 0.11 + m.seed));
      pos.setY(i, Math.max(0, edge) * n * m.h);
    }
    const g = g0.toNonIndexed();
    g0.dispose();
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    const n = g.attributes.position.count;
    const bary = new Float32Array(n * 3);
    const hh = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      bary[i * 3 + (i % 3)] = 1;
      hh[i] = g.attributes.position.getY(i) / (m.h * 1.5);
    }
    g.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
    g.setAttribute('aH', new THREE.BufferAttribute(hh, 1));
    g.translate(m.x, -0.5, m.z);
    parts.push(g);
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: MTN_VERT, fragmentShader: MTN_FRAG, fog: false }));
  mesh.frustumCulled = false;
  mesh.userData.noBatch = true;
  return mesh;
}

// ---------------------------------------------------------------- the city

const CITY_VERT = /* glsl */ `
attribute vec2 aTower; // seed, height
varying vec3 vP;
varying vec3 vN;
varying vec2 vT;
void main() {
  vP = position;
  vN = normal;
  vT = aTower;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CITY_FRAG = /* glsl */ `
uniform float uTime, uBeat;
varying vec3 vP;
varying vec3 vN;
varying vec2 vT;
${NOISE}
void main() {
  vec3 col = vec3(0.01, 0.004, 0.03);
  if (abs(vN.y) < 0.5) {
    // windows: a grid across each face, floors 3.5 m, bays 2.6 m; some lit
    float across = dot(vP, normalize(vec3(-vN.z, 0.0, vN.x)));
    vec2 c = vec2(across / 2.6, vP.y / 3.5);
    vec2 id = floor(c);
    vec2 f = fract(c);
    float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
    float h = hash21(id + vT.x * 13.7);
    float lit = step(0.72, h) * step(1.5, vP.y);
    // a few flicker
    lit *= 1.0 - step(0.985, h) * step(0.5, fract(uTime * 1.3 + h * 7.0));
    vec3 wc = h > 0.9 ? vec3(1.4, 0.3, 1.1) : h > 0.82 ? vec3(0.3, 1.1, 1.5) : vec3(1.3, 0.9, 0.45);
    col += wc * win * lit;
    // a neon band round the crown of the tallest
    float crown = smoothstep(0.25, 0.0, abs(vP.y - vT.y + 1.4)) * step(0.6, fract(vT.x * 3.1));
    col += mix(vec3(1.2, 0.1, 0.9), vec3(0.2, 1.0, 1.6), step(0.8, fract(vT.x * 7.7))) * crown * (1.5 + uBeat);
  }
  // aircraft warning lights on the roofs, blinking
  if (vN.y > 0.5) col += vec3(1.6, 0.1, 0.1) * step(0.5, fract(uTime * 0.8 + vT.x)) * smoothstep(1.2, 0.3, length(fract(vP.xz / 6.0) - 0.5) * 6.0);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface CityOpts {
  /** the arc the towers stand in (radians round the court, 0 = −z) and how far out */
  from: number;
  to: number;
  radius: [number, number];
  count: number;
  /** keep clear of this arc (e.g. the sun's gap) */
  gap?: [number, number];
  seed: number;
}

/** Towers of lit windows (one mesh; the scene's fog hazes the far ones). */
export function city(u: U, blocks: CityOpts[]) {
  const parts: THREE.BufferGeometry[] = [];
  let id = 0;
  for (const o of blocks) {
    const rnd = mulberry(o.seed);
    for (let i = 0; i < o.count; i++) {
      const a = o.from + (o.to - o.from) * rnd();
      if (o.gap && a > o.gap[0] && a < o.gap[1]) continue;
      const r = o.radius[0] + (o.radius[1] - o.radius[0]) * rnd();
      const w = 9 + rnd() * 14,
        dpt = 8 + rnd() * 10;
      const h = 16 + Math.pow(rnd(), 1.7) * 75;
      const b = new THREE.BoxGeometry(w, h, dpt);
      b.deleteAttribute('uv');
      b.translate(0, h / 2 - 1, 0);
      // facing the court
      b.rotateY(-a);
      b.translate(Math.sin(a) * r, 0, -Math.cos(a) * r);
      const n = b.attributes.position.count;
      const s = (id++ * 0.618) % 1;
      b.setAttribute('aTower', new THREE.Float32BufferAttribute(Array.from({ length: n * 2 }, (_, k) => (k % 2 ? h - 1 : s)), 2));
      parts.push(b);
    }
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  // world-space faces: the windows shader needs positions and normals as built
  const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: CITY_VERT, fragmentShader: CITY_FRAG, fog: false }));
  mesh.userData.noBatch = true;
  return mesh;
}

// ---------------------------------------------------------------- light trails

const TRAIL_VERT = /* glsl */ `
attribute vec4 aLane;  // y, z, speed (m/s, signed), length of the run
attribute vec4 aCar;   // phase, trail length, kind (0 tail light, 1 head light, 2 flying), size
uniform float uTime;
varying vec2 vQ;
varying float vKind;
varying float vBlink;
void main() {
  float run = aLane.w;
  float x = (fract(aCar.x + uTime * abs(aLane.z) / run) - 0.5) * run * sign(aLane.z);
  // the quad: along x behind the car (its trail), a little tall
  float len = aCar.y;
  vec3 p = vec3(x - position.x * len * sign(aLane.z), aLane.x + position.y * aCar.w, aLane.y);
  vQ = vec2(position.x, position.y * 2.0);
  vKind = aCar.z;
  vBlink = step(0.5, fract(uTime * 1.7 + aCar.x * 11.0));
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
}`;

const TRAIL_FRAG = /* glsl */ `
uniform float uBeat;
varying vec2 vQ;
varying float vKind;
varying float vBlink;
void main() {
  // vQ.x: 0 at the car → 1 at the end of its trail; vQ.y: −1..1 across
  float across = 1.0 - smoothstep(0.2, 1.0, abs(vQ.y));
  float tail = pow(1.0 - vQ.x, 2.5);
  float head = smoothstep(0.08, 0.0, vQ.x) * (1.0 - smoothstep(0.3, 0.9, abs(vQ.y)));
  vec3 c = vKind < 0.5 ? vec3(1.8, 0.12, 0.35) : vKind < 1.5 ? vec3(1.1, 1.3, 1.8) : vec3(0.3, 1.2, 1.9);
  vec3 col = c * (tail * across * 0.9 + head * 2.5) * (1.0 + uBeat * 0.4);
  // flying cars blink red at the tail end
  if (vKind > 1.5) col += vec3(2.0, 0.1, 0.2) * vBlink * smoothstep(0.1, 0.0, abs(vQ.x - 0.12)) * across;
  gl_FragColor = vec4(col, 1.0);
}`;

export interface TrafficOpts {
  /** the highway: its deck height, its centre line (z), how long a run is */
  deckY: number;
  z: number;
  run: number;
  /** cars per direction */
  cars: number;
  /** flying cars, crossing high up */
  flyers: number;
  seed: number;
}

/** Cars streaming both ways along the highway and flying cars overhead (one additive draw). */
export class Traffic {
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private n: number;

  constructor(u: U, o: TrafficOpts) {
    const rnd = mulberry(o.seed);
    const quad = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    const lane: number[] = [];
    const car: number[] = [];
    // two lanes each way: tail lights running away to the left, head lights coming
    for (let i = 0; i < o.cars * 2; i++) {
      const away = i < o.cars;
      const l = i % 2;
      // (above the deck's edge, so low cameras see them over it)
      // long trails, like a long exposure: the lanes read as streams of light
      lane.push(o.deckY + 1.0, o.z + (away ? -1.2 - l * 2.2 : 1.2 + l * 2.2), (away ? -1 : 1) * (38 + rnd() * 16 + l * 8), o.run);
      car.push(rnd(), 22 + rnd() * 26, away ? 0 : 1, 0.85);
    }
    for (let i = 0; i < o.flyers; i++) {
      const dir = rnd() < 0.5 ? -1 : 1;
      lane.push(35 + rnd() * 55, o.z - 30 - rnd() * 180, dir * (45 + rnd() * 50), o.run * 1.3);
      car.push(rnd(), 18 + rnd() * 26, 2, 0.9);
    }
    const n = lane.length / 4;
    geo.setAttribute('aLane', new THREE.InstancedBufferAttribute(new Float32Array(lane), 4));
    geo.setAttribute('aCar', new THREE.InstancedBufferAttribute(new Float32Array(car), 4));
    geo.instanceCount = n;
    this.geo = geo;
    this.n = n;
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({ uniforms: u, vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.userData.noBatch = true;
  }

  /** Lighter traffic at low detail (the flying cars go last: they are listed last). */
  setDetail(d: number) {
    this.geo.instanceCount = Math.round(this.n * (0.45 + 0.55 * d));
  }
}

/** The highway itself: a dark deck on pylons with glowing rails along both edges. */
export function highway(o: { deckY: number; z: number; length: number; rail: THREE.Material; dark: THREE.Material }) {
  const parts: THREE.BufferGeometry[] = [];
  const railParts: THREE.BufferGeometry[] = [];
  const L = o.length;
  parts.push(new THREE.BoxGeometry(L, 0.9, 11).translate(0, o.deckY, o.z));
  for (let x = -L / 2 + 12; x < L / 2; x += 30) parts.push(new THREE.BoxGeometry(2.2, o.deckY, 2.2).translate(x, o.deckY / 2 - 0.2, o.z));
  for (const s of [-1, 1]) {
    railParts.push(new THREE.BoxGeometry(L, 0.14, 0.14).translate(0, o.deckY + 0.95, o.z + s * 5.5));
    railParts.push(new THREE.BoxGeometry(L, 0.06, 0.06).translate(0, o.deckY - 0.45, o.z + s * 5.55));
  }
  for (const p of [...parts, ...railParts]) p.deleteAttribute('uv');
  const deck = new THREE.Mesh(mergeGeometries(parts)!, o.dark);
  const rails = new THREE.Mesh(mergeGeometries(railParts)!, o.rail);
  return [deck, rails];
}
