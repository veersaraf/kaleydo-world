// Inkwell's sky: the vermilion sun inside a single brushed ensō, soft wash
// clouds drifting round the valley, and cranes flying over the mist.
//
//  • Sun and ensō are painted in their shaders on two quads, set between the
//    mountain ranges. They write no depth, so the ink pass doesn't outline them
//    (a red disc and one stroke), and draw after the ranges: the ones in front
//    hide them, the ones behind don't.
//  • Clouds are upright cards cut from a painted atlas (one instanced draw),
//    orbiting slowly so they drift across every view without wrapping.
//  • Cranes are one instanced draw: white bodies, black necks and wing tips,
//    wings beating slowly in the vertex shader.

import * as THREE from 'three';
import { canvasTex } from '../mats';

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** the sun: a disc of vermilion with a brushed, slightly uneven edge */
const SUN_FRAG = /* glsl */ `
uniform vec3 uRed;
uniform sampler2D tNoise;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float edge = 0.93 + 0.018 * sin(a * 3.0 + 1.3) + 0.012 * sin(a * 7.0 + 0.4) + (texture2D(tNoise, vec2(a * 0.16, 0.3)).a - 0.5) * 0.05;
  if (r > edge) discard;
  // pigment pools towards the rim
  float g = texture2D(tNoise, vUv * 1.3).g;
  gl_FragColor = vec4(uRed * (0.9 + 0.12 * smoothstep(edge - 0.2, edge, r) - 0.08 * g), 1.0);
}`;

/**
 * The ensō: one stroke round a circle. It lands heavy at the top left, runs
 * anticlockwise thinning as the brush dries, and trails off in dry-brush
 * streaks just short of where it began.
 */
const ENSO_FRAG = /* glsl */ `
uniform vec3 uInk;
uniform sampler2D tNoise;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  // 0 where the brush landed → 1 where it lifted (just short of a full turn)
  float t = fract((a - 2.3) / 6.2831853);
  t = 1.0 - t;
  float len = 0.93;
  if (t > len) discard;
  float s = t / len;
  float R = 0.78 + 0.04 * sin(s * 6.2831853 + 0.6) + 0.03 * s;
  float w = mix(0.12, 0.04, s * s) * (1.0 + 0.2 * sin(s * 17.0 + 1.0));
  // the landing: a heavier blot
  w += 0.06 * exp(-s * 30.0);
  float d = (r - R) / w;
  if (abs(d) > 1.0) discard;
  // bristle streaks along the stroke, opening up as the ink runs out
  float bristle = texture2D(tNoise, vec2(s * 5.0, d * 0.22 + 0.5)).a;
  float dry = smoothstep(0.35, 1.0, s);
  float keep = mix(1.0, smoothstep(0.35 + 0.35 * dry, 0.6 + 0.3 * dry, bristle), dry);
  // ragged edges
  keep *= smoothstep(1.0, 0.8, abs(d) + (texture2D(tNoise, vec2(s * 11.0, d)).r - 0.5) * 0.5);
  if (keep < 0.5) discard;
  gl_FragColor = vec4(uInk, 1.0);
}`;

export interface SunOpts {
  /** where the sun hangs (the quads face the court) */
  pos: THREE.Vector3;
  radius: number;
  red: THREE.Color;
  ink: THREE.Color;
  noise: THREE.Texture;
}

/** The sun and its ensō (two quads, drawn first, behind everything). */
export function sunAndEnso(o: SunOpts) {
  const g = new THREE.Group();
  const sun = new THREE.Mesh(
    new THREE.PlaneGeometry(o.radius * 2, o.radius * 2),
    new THREE.ShaderMaterial({ uniforms: { uRed: { value: o.red }, tNoise: { value: o.noise } }, vertexShader: QUAD_VERT, fragmentShader: SUN_FRAG, depthWrite: false }),
  );
  const enso = new THREE.Mesh(
    new THREE.PlaneGeometry(o.radius * 3.2, o.radius * 3.2),
    new THREE.ShaderMaterial({ uniforms: { uInk: { value: o.ink }, tNoise: { value: o.noise } }, vertexShader: QUAD_VERT, fragmentShader: ENSO_FRAG, depthWrite: false }),
  );
  enso.position.z = -1;
  sun.renderOrder = 1;
  enso.renderOrder = 1;
  g.add(enso, sun);
  g.position.copy(o.pos);
  g.lookAt(0, o.pos.y * 0.5, 0);
  return g;
}

// ---------------------------------------------------------------- clouds

/** Four wash clouds (2×2 atlas): soft grey bodies, curled strokes along their bellies. */
function cloudAtlas(seed: number) {
  const rnd = mulberry(seed);
  return canvasTex(1024, 512, (x) => {
    x.clearRect(0, 0, 1024, 512);
    for (let c = 0; c < 4; c++) {
      const ox = (c % 2) * 512,
        oy = Math.floor(c / 2) * 256;
      x.save();
      x.beginPath();
      x.rect(ox, oy, 512, 256);
      x.clip();
      // the body: overlapping soft washes along a flat base
      const n = 9 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const hump = Math.sin(u * Math.PI);
        const r = 26 + hump * 46 * (0.6 + rnd() * 0.5);
        const px = ox + 60 + u * 392 + (rnd() - 0.5) * 30;
        const py = oy + 170 - r * 0.55 - hump * 18 * rnd();
        const g = x.createRadialGradient(px, py, r * 0.1, px, py, r);
        const v = 120 + Math.floor(rnd() * 40);
        g.addColorStop(0, `rgba(${v},${v - 4},${v - 10},0.55)`);
        g.addColorStop(0.7, `rgba(${v},${v - 4},${v - 10},0.35)`);
        g.addColorStop(1, `rgba(${v},${v - 4},${v - 10},0)`);
        x.fillStyle = g;
        x.beginPath();
        x.arc(px, py, r, 0, Math.PI * 2);
        x.fill();
      }
      // curls along the belly: auspicious-cloud spirals in darker ink
      x.strokeStyle = 'rgba(40,36,32,0.8)';
      x.lineCap = 'round';
      const curls = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < curls; k++) {
        const cx = ox + 110 + ((k + rnd() * 0.6) / curls) * 300,
          cy = oy + 160 + rnd() * 20;
        const rr = 14 + rnd() * 16;
        x.lineWidth = 3 + rnd() * 3;
        x.beginPath();
        for (let s = 0; s <= 40; s++) {
          const t = s / 40;
          const ang = t * Math.PI * 3.2;
          const rad = rr * (1 - t * 0.75);
          x.lineTo(cx + Math.cos(ang) * rad, cy - Math.sin(ang) * rad * 0.8);
        }
        x.stroke();
        // a tail sweeping off the curl
        x.beginPath();
        x.moveTo(cx + rr, cy);
        x.quadraticCurveTo(cx + rr * 2.2, cy + 12, cx + rr * 3.6 + rnd() * 30, cy + 4);
        x.stroke();
      }
      x.restore();
    }
  });
}

const CLOUD_VERT = /* glsl */ `
attribute vec4 aOrbit;  // radius, start angle, height, angular speed
attribute vec3 aCard;   // width, height, atlas cell
uniform float uTime;
varying vec2 vUv;
void main() {
  float a = aOrbit.y + uTime * aOrbit.w;
  vec3 c = (modelMatrix * vec4(cos(a) * aOrbit.x, aOrbit.z, sin(a) * aOrbit.x, 1.0)).xyz;
  vec3 to = cameraPosition - c;
  vec3 right = normalize(vec3(to.z, 0.0, -to.x));
  vec3 wp = c + right * position.x * aCard.x + vec3(0.0, position.y * aCard.y, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  float cell = aCard.z;
  vUv = (vec2(mod(cell, 2.0), floor(cell / 2.0)) + vec2(position.x + 0.5, 1.0 - position.y)) * 0.5;
  vUv.y = 1.0 - vUv.y;
}`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D tAtlas;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(tAtlas, vUv);
  if (t.a < 0.02) discard;
  gl_FragColor = t;
}`;

export class InkClouds {
  mesh: THREE.Mesh;
  u = { uTime: { value: 0 }, tAtlas: { value: null as THREE.Texture | null } };
  private geo: THREE.InstancedBufferGeometry;
  private n: number;

  constructor(o: { count: number; radius: [number, number]; height: [number, number]; size: [number, number]; seed: number }) {
    const rnd = mulberry(o.seed);
    this.u.tAtlas.value = cloudAtlas(o.seed);
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    const list: number[][] = [];
    for (let i = 0; i < o.count; i++) {
      const r = o.radius[0] + (o.radius[1] - o.radius[0]) * rnd();
      const w = o.size[0] + (o.size[1] - o.size[0]) * rnd();
      list.push([r, rnd() * Math.PI * 2, o.height[0] + (o.height[1] - o.height[0]) * rnd(), (0.6 + rnd() * 0.8) / r, w, w * 0.5, Math.floor(rnd() * 4)]);
    }
    // far first: cards blend in this order
    list.sort((p, q) => q[0] - p[0]);
    const orbit = new Float32Array(o.count * 4);
    const card = new Float32Array(o.count * 3);
    list.forEach((c, i) => {
      orbit.set(c.slice(0, 4), i * 4);
      card.set(c.slice(4, 7), i * 3);
    });
    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
    geo.setAttribute('aCard', new THREE.InstancedBufferAttribute(card, 3));
    geo.instanceCount = o.count;
    this.geo = geo;
    this.n = o.count;
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false }));
    this.mesh.renderOrder = -4;
    this.mesh.frustumCulled = false;
    this.mesh.userData.noBatch = true;
  }

  tick(t: number) {
    this.u.uTime.value = t;
  }

  setDetail(d: number) {
    this.geo.instanceCount = Math.round(this.n * (0.4 + 0.6 * d));
  }
}

// ---------------------------------------------------------------- cranes

const CRANE_VERT = /* glsl */ `
attribute vec3 color;
attribute vec4 aFlock; // centre x, y, z; circle radius
attribute vec4 aBird;  // phase, angular speed (rad/s, signed), place in the skein, flap phase
uniform float uTime;
varying vec3 vCol;
void main() {
  vCol = color;
  float dir = sign(aBird.y);
  float a = aBird.x + uTime * aBird.y;
  float r = aFlock.w + aBird.z * 2.5;
  vec3 c = aFlock.xyz + vec3(cos(a) * r, sin(a * 1.5 + aBird.w) * 2.0 + aBird.z * 1.2, sin(a) * r);
  vec3 fwd = vec3(-sin(a), 0.0, cos(a)) * dir;
  vec3 left = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = normalize(vec3(0.0, 1.0, 0.0) + left * 0.25 * dir);
  // slow, deep beats, then a glide with the wings held level
  float glide = smoothstep(0.2, 0.8, sin(uTime * 0.35 + aBird.w * 2.1));
  float flap = mix(sin(uTime * 3.2 + aBird.w * 6.0) * 0.75, 0.08, glide);
  float span = abs(position.z);
  // the wing bends at the wrist: the tips lag the beat
  float bend = flap * (1.0 + 0.5 * smoothstep(0.7, 1.9, span) * sin(uTime * 3.2 + aBird.w * 6.0 - 1.0));
  vec3 lp = vec3(position.x, position.y + span * sin(bend), position.z * cos(bend));
  vec3 wp = (modelMatrix * vec4(c + fwd * lp.x + up * lp.y + left * lp.z, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const CRANE_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(vCol, 1.0);
}`;

/** One crane, flying along +x, wings along ±z (about 3.4 m across: they are seen from far off). */
function craneGeometry(white: THREE.Color, black: THREE.Color, red: THREE.Color) {
  const pos: number[] = [];
  const col: number[] = [];
  const tri = (a: number[], b: number[], c: number[], k: THREE.Color) => {
    pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) col.push(k.r, k.g, k.b);
  };
  // body: a slim diamond
  const nose = [0.45, 0.05, 0],
    tail = [-0.55, 0, 0],
    top = [0, 0.12, 0],
    bot = [0, -0.1, 0],
    l = [0, 0, 0.16],
    r = [0, 0, -0.16];
  for (const s of [l, r]) {
    tri(nose, top, s, white);
    tri(nose, s, bot, white);
    tri(tail, s, top, white);
    tri(tail, bot, s, white);
  }
  // a black tail tuft
  tri([-0.5, 0.02, 0.08], [-0.85, -0.02, 0], [-0.5, 0.02, -0.08], black);
  // the neck stretched forward, black, and the head with its red crown
  tri([0.35, 0.06, 0.05], [1.2, 0.1, 0], [0.35, 0.06, -0.05], black);
  tri([0.35, 0.02, 0.0], [1.2, 0.1, 0.0], [0.4, 0.12, 0.0], black);
  tri([1.15, 0.13, 0.04], [1.35, 0.1, 0], [1.15, 0.13, -0.04], red);
  tri([1.3, 0.1, 0.02], [1.7, 0.06, 0], [1.3, 0.1, -0.02], black);
  // legs trailing behind
  tri([-0.3, -0.06, 0.03], [-1.35, -0.1, 0.02], [-0.3, -0.06, -0.03], black);
  // wings: white inner, black primaries at the tips
  for (const s of [1, -1]) {
    const w0 = [0.18, 0.02, 0.14 * s],
      w1 = [-0.28, 0.02, 0.14 * s],
      m0 = [0.12, 0.02, 1.0 * s],
      m1 = [-0.38, 0.02, 1.0 * s],
      tip0 = [0.02, 0.02, 1.75 * s],
      tip1 = [-0.3, 0.02, 1.7 * s];
    tri(w0, m0, w1, white);
    tri(w1, m0, m1, white);
    tri(m0, tip0, m1, black);
    tri(m1, tip0, tip1, black);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

export interface Skein {
  x: number;
  y: number;
  z: number;
  radius: number;
  count: number;
  /** rad/s round the circle (sign = direction) */
  speed: number;
}

export class Cranes {
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private n: number;

  constructor(u: { uTime: { value: number } }, skeins: Skein[], o: { white: THREE.Color; black: THREE.Color; red: THREE.Color }) {
    const base = craneGeometry(o.white, o.black, o.red);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('color', base.attributes.color);
    const n = skeins.reduce((a, f) => a + f.count, 0);
    const flock = new Float32Array(n * 4);
    const bird = new Float32Array(n * 4);
    let i = 0;
    for (const f of skeins)
      for (let k = 0; k < f.count; k++, i++) {
        flock.set([f.x, f.y, f.z, f.radius], i * 4);
        // a loose skein: strung out along the circle, stepped in and out like a V
        const side = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2);
        bird.set([-Math.abs(side) * 0.05, f.speed, side, k * 1.7], i * 4);
      }
    geo.setAttribute('aFlock', new THREE.InstancedBufferAttribute(flock, 4));
    geo.setAttribute('aBird', new THREE.InstancedBufferAttribute(bird, 4));
    geo.instanceCount = n;
    this.geo = geo;
    this.n = n;
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: { uTime: u.uTime }, vertexShader: CRANE_VERT, fragmentShader: CRANE_FRAG, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.userData.noBatch = true;
  }

  setDetail(d: number) {
    this.geo.instanceCount = d < 0.3 ? 0 : this.n;
  }
}
