// Life round the park: birds wheeling over the town, flags flying from poles and
// a fountain with running water. Everything moves in shaders from one time
// uniform; each prop is a draw or two, and nothing is touched per frame in JS.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sway, swayDepth, type Wind } from './wind';
import { canvasTex } from '../mats';

type U = { uTime: { value: number } };

// ---------------------------------------------------------------- birds

const BIRD_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aFlock; // centre x, y, z; circle radius
attribute vec4 aBird;  // phase, angular speed (rad/s, signed), place in the flock, flap phase
uniform float uTime;
void main() {
  float dir = sign(aBird.y);
  float a = aBird.x + uTime * aBird.y;
  float r = aFlock.w + aBird.z;
  vec3 c = aFlock.xyz + vec3(cos(a) * r, sin(a * 2.0 + aBird.w) * 1.4 + aBird.z * 0.8, sin(a) * r);
  vec3 fwd = vec3(-sin(a), 0.0, cos(a)) * dir;
  vec3 left = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  // banked into the turn
  vec3 up = normalize(vec3(0.0, 1.0, 0.0) + left * 0.35 * dir);
  // flap in bursts, glide with the wings a little raised in between
  float burst = smoothstep(0.1, 0.7, sin(uTime * 0.45 + aBird.w * 2.3));
  float flap = mix(0.16, sin(uTime * 10.0 + aBird.w * 6.0) * 0.8, burst);
  float span = abs(position.z);
  vec3 lp = vec3(position.x, position.y + span * sin(flap), position.z * cos(flap));
  vec3 wp = (modelMatrix * vec4(c + fwd * lp.x + up * lp.y + left * lp.z, 1.0)).xyz;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BIRD_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
  #include <fog_fragment>
}`;

export interface Flock {
  x: number;
  y: number;
  z: number;
  radius: number;
  count: number;
  /** rad/s round the circle (sign = direction) */
  speed: number;
}

/** A few flocks circling lazily (one draw). */
export class Birds {
  mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private n: number;

  constructor(u: U, flocks: Flock[], color: THREE.ColorRepresentation, seed = 3) {
    let s = seed;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    // a bird seen from below: a body and two swept wings (x forward, z along the wings)
    const pos = [0.32, 0, 0, -0.26, 0, 0.05, -0.26, 0, -0.05, 0.12, 0, 0, -0.1, 0, 0, -0.02, 0, 0.7, 0.12, 0, 0, -0.02, 0, -0.7, -0.1, 0, 0];
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.attributes.position);
    const n = flocks.reduce((a, f) => a + f.count, 0);
    const flock = new Float32Array(n * 4);
    const bird = new Float32Array(n * 4);
    let i = 0;
    for (const f of flocks)
      for (let k = 0; k < f.count; k++, i++) {
        flock.set([f.x, f.y, f.z, f.radius], i * 4);
        // a loose group: close together round the circle, a little spread in and out
        bird.set([(k / f.count) * 1.1 + rand() * 0.2, f.speed * (0.95 + rand() * 0.1), (rand() - 0.5) * 6, rand() * 6.28], i * 4);
      }
    geo.setAttribute('aFlock', new THREE.InstancedBufferAttribute(flock, 4));
    geo.setAttribute('aBird', new THREE.InstancedBufferAttribute(bird, 4));
    geo.instanceCount = n;
    this.geo = geo;
    this.n = n;
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(color) } }]),
        vertexShader: BIRD_VERT,
        fragmentShader: BIRD_FRAG,
        side: THREE.DoubleSide,
        fog: true,
      }),
    );
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uTime = u.uTime;
    this.mesh.frustumCulled = false;
    this.mesh.userData.noBatch = true;
  }

  setDetail(d: number) {
    this.geo.instanceCount = d < 0.3 ? 0 : this.n;
  }
}

// ---------------------------------------------------------------- flags

export interface Pole {
  x: number;
  z: number;
  /** pole height */
  h: number;
  /** flag size (1 = 1.8 × 1.15 m) */
  s?: number;
  /** which design */
  cell: number;
}

/** Flag designs: a bright field, a white chevron and a ringed disc. */
function flagAtlas(colors: string[]) {
  const W = 192,
    H = 128;
  return canvasTex(W * colors.length, H, (x) => {
    colors.forEach((c, i) => {
      const ox = i * W;
      x.fillStyle = c;
      x.fillRect(ox, 0, W, H);
      x.fillStyle = 'rgba(255,255,255,0.92)';
      x.beginPath();
      x.moveTo(ox, 0);
      x.lineTo(ox + 44, H / 2);
      x.lineTo(ox, H);
      x.lineTo(ox + 22, H);
      x.lineTo(ox + 66, H / 2);
      x.lineTo(ox + 22, 0);
      x.closePath();
      x.fill();
      x.strokeStyle = 'rgba(255,255,255,0.95)';
      x.lineWidth = 9;
      x.beginPath();
      x.arc(ox + 124, H / 2, 28, 0, Math.PI * 2);
      x.stroke();
      x.fillStyle = 'rgba(255,255,255,0.5)';
      x.beginPath();
      x.arc(ox + 124, H / 2, 13, 0, Math.PI * 2);
      x.fill();
    });
  });
}

/**
 * Flags flying downwind from their poles (one instanced cloth, one shadow draw);
 * the poles themselves are plain static meshes, returned for the scene. `cloth`
 * makes the flags' material in the world's own style (standard by default).
 */
export function flags(
  wind: Wind,
  poles: Pole[],
  colors: string[],
  o: { pole: THREE.Material; finial: THREE.Material; cloth?: (p: { map: THREE.Texture; side: THREE.Side }) => THREE.Material; shadow?: boolean },
) {
  const n = colors.length;
  const opts = { amp: 0.16, height: 0, flutter: 0.05 };
  const make = o.cloth ?? ((p) => new THREE.MeshStandardMaterial({ ...p, roughness: 0.85 }));
  const mat = sway(make({ map: flagAtlas(colors), side: THREE.DoubleSide }), wind, 'cloth', opts, {
    key: `flag${n}`,
    patch: (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCell;').replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv.x = (vMapUv.x + aCell) / ${n.toFixed(1)};`);
    },
  });
  // the hoist (uv.x = 0) at the pole
  const geo = new THREE.PlaneGeometry(1.8, 1.15, 10, 4).translate(0.9, 0, 0);
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(poles.map((p) => p.cell % n)), 1));
  const cloth = new THREE.InstancedMesh(geo, mat, poles.length);
  const w = wind.u.uWind.value;
  // streaming downwind: the flag's +x along the wind
  const yaw = Math.atan2(-w.y, w.x);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const M = new THREE.Matrix4();
  const out: THREE.Object3D[] = [cloth];
  poles.forEach((p, i) => {
    const s = p.s ?? 1;
    cloth.setMatrixAt(i, M.compose(new THREE.Vector3(p.x, p.h - 0.62 * s - 0.15, p.z), q, new THREE.Vector3(s, s, s)));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * (0.7 + 0.3 * s), 0.06 * (0.7 + 0.3 * s), p.h, 8), o.pole);
    pole.position.set(p.x, p.h / 2, p.z);
    pole.castShadow = true;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.075 * (0.7 + 0.3 * s), 10, 8), o.finial);
    ball.position.set(p.x, p.h + 0.05, p.z);
    out.push(pole, ball);
  });
  cloth.castShadow = o.shadow ?? true;
  cloth.customDepthMaterial = swayDepth(wind, 'cloth', opts);
  cloth.computeBoundingSphere();
  cloth.boundingSphere!.radius += 1;
  return out;
}

// ---------------------------------------------------------------- fountain

const WATER_VERT = /* glsl */ `
varying vec3 vW;
varying vec2 vL;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  // round the fountain's own centre (the scenery turns for a split screen's far half)
  vL = position.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/** A pool's surface: rings from the jets, a drifting shimmer, sky at grazing angles, foam where water lands. */
const POOL_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep, uShallow, uSky;
uniform float uR;     // the basin's radius
uniform vec2 uLand;   // radius the arcing jets land at, radius of the bowl above
varying vec3 vW;
varying vec2 vL;
void main() {
  vec2 p = vL;
  float d = length(p);
  float rim = smoothstep(uR, uR - 0.35, d);
  // two crossing wave trains for a shimmer, and rings running out from the middle
  vec2 q = p * 2.2;
  float sh = sin(q.x * 2.1 + uTime * 1.4 + sin(q.y * 1.7 - uTime * 0.9)) * sin(q.y * 2.4 - uTime * 1.2 + sin(q.x * 1.6 + uTime * 0.8));
  float ring = sin(d * 9.0 - uTime * 4.0) * 0.5 + 0.5;
  vec3 col = mix(uShallow, uDeep, smoothstep(uR, 0.0, d) * 0.7);
  col *= 0.92 + 0.12 * sh;
  // the sky in it at grazing angles, glinting on the ripples
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
  col = mix(col, uSky, clamp(fres * 0.75 + ring * 0.07, 0.0, 1.0));
  col += vec3(1.0) * pow(max(sh, 0.0), 6.0) * 0.35;
  // foam where the jets come down, and under the bowl's falling curtain
  float land = exp(-pow((d - uLand.x) * 4.0, 2.0)) + exp(-pow((d - uLand.y) * 5.0, 2.0));
  float foam = land * (0.55 + 0.45 * sin(atan(p.y, p.x) * 11.0 + uTime * 5.0 + d * 12.0));
  col = mix(col, vec3(1.0), clamp(foam, 0.0, 1.0) * 0.75 * rim);
  gl_FragColor = vec4(col, 1.0);
}`;

const STREAM_VERT = /* glsl */ `
attribute float aAlong; // 0 at the source → 1 where it lands
varying vec2 vS;
void main() {
  vS = vec2(uv.x, aAlong);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Running water: bright streaks racing along the stream, thinning into spray at the end. */
const STREAM_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uWater;
varying vec2 vS;
void main() {
  float t = vS.y;
  float k = fract(t * 5.0 - uTime * 2.6 + sin(vS.x * 25.1) * 0.15);
  float streak = smoothstep(0.0, 0.25, k) * smoothstep(1.0, 0.55, k);
  float grain = 0.75 + 0.25 * sin(vS.x * 50.0 + t * 30.0 - uTime * 9.0);
  vec3 col = mix(uWater, vec3(1.0), 0.45 + 0.4 * streak);
  float a = (0.45 + 0.35 * streak) * grain * smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.85, 1.0, t) * 0.7);
  gl_FragColor = vec4(col, a);
}`;

const SPRAY_VERT = /* glsl */ `
attribute vec4 aSpray; // source (0 = the top jet, else an arc's landing), angle, speed, phase
uniform float uTime;
uniform vec3 uTop;      // the top jet's crown (local)
uniform vec2 uLandR;    // arcs' landing radius, water level
uniform float uArcs;
varying float vA;
varying vec2 vQ;
void main() {
  float life = 1.1;
  float t = fract(uTime / life + aSpray.w) * life;
  vec3 src;
  vec3 v;
  if (aSpray.x < 0.5) {
    // the crown of the top jet: droplets falling out and away
    src = uTop;
    v = vec3(cos(aSpray.y) * aSpray.z, 0.6 + aSpray.z * 0.4, sin(aSpray.y) * aSpray.z);
  } else {
    // splashes where an arc comes down
    float a = (aSpray.x - 1.0) / uArcs * 6.2831853;
    src = vec3(cos(a) * uLandR.x, uLandR.y, sin(a) * uLandR.x);
    v = vec3(cos(aSpray.y) * aSpray.z * 0.5, 1.2 + aSpray.z * 0.5, sin(aSpray.y) * aSpray.z * 0.5);
  }
  vec3 p = src + v * t + vec3(0.0, -4.9, 0.0) * t * t;
  p.y = max(p.y, uLandR.y);
  float size = mix(0.07, 0.03, t / life);
  vA = (1.0 - t / life) * step(uLandR.y + 0.001, p.y + 0.02);
  vQ = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += position.xy * size * 2.0;
  gl_Position = projectionMatrix * mv;
}`;

const SPRAY_FRAG = /* glsl */ `
varying float vA;
varying vec2 vQ;
void main() {
  float d = dot(vQ, vQ);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vec3(1.0), (1.0 - d) * vA * 0.8);
}`;

export interface FountainOpts {
  x: number;
  z: number;
  /** basin radius (inside the rim) */
  r: number;
  stone: THREE.Material;
  arcs?: number;
}

/**
 * A round fountain: a stone basin and a pedestal with a bowl, water falling from
 * the bowl in a curtain, a jet on top, arcs of water from the rim, and spray.
 * Four draws for the water (pools, streams, spray), the stone is static.
 */
export function fountain(u: U, o: FountainOpts) {
  const g = new THREE.Group();
  g.position.set(o.x, 0, o.z);
  const R = o.r;
  const arcs = o.arcs ?? 8;
  const waterY = 0.36;
  // the basin's lip and the pedestal: lathed stone
  const lip = new THREE.LatheGeometry(
    [
      [R - 0.05, 0],
      [R + 0.35, 0],
      [R + 0.42, 0.34],
      [R + 0.36, 0.5],
      [R + 0.12, 0.54],
      [R - 0.02, 0.46],
      [R - 0.05, 0.2],
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    64,
  );
  const ped = new THREE.LatheGeometry(
    [
      [0.001, 0],
      [0.62, 0],
      [0.55, 0.3],
      [0.34, 0.45],
      [0.3, 1.2],
      [0.45, 1.35],
      [1.25, 1.55],
      [1.34, 1.7],
      [1.22, 1.74],
      [0.4, 1.66],
      [0.2, 1.8],
      [0.18, 2.25],
      [0.52, 2.38],
      [0.56, 2.46],
      [0.48, 2.48],
      [0.001, 2.42],
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    40,
  );
  for (const geo of [lip, ped]) {
    const m = new THREE.Mesh(geo, o.stone);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  const uni = {
    uTime: u.uTime,
    uDeep: { value: new THREE.Color('#1580c4') },
    uShallow: { value: new THREE.Color('#4fcde6') },
    uSky: { value: new THREE.Color('#d8efff') },
    uR: { value: R },
    uLand: { value: new THREE.Vector2(R * 0.52, 1.36) },
    uWater: { value: new THREE.Color('#bfeeff') },
  };
  // the pool and the water in the bowl (one mesh)
  const pools = mergeGeometries([new THREE.CircleGeometry(R + 0.02, 48).rotateX(-Math.PI / 2).translate(0, waterY, 0), new THREE.CircleGeometry(1.22, 32).rotateX(-Math.PI / 2).translate(0, 1.64, 0)])!;
  const pool = new THREE.Mesh(pools, new THREE.ShaderMaterial({ uniforms: uni, vertexShader: WATER_VERT, fragmentShader: POOL_FRAG }));
  pool.receiveShadow = false;
  g.add(pool);
  // streams: the curtain off the bowl, the top jet, and the arcs from the rim
  const along = (geo: THREE.BufferGeometry, f: (i: number) => number) => {
    const n = geo.attributes.position.count;
    geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(Float32Array.from({ length: n }, (_, i) => f(i)), 1));
    return geo;
  };
  const curtain = new THREE.CylinderGeometry(1.33, 1.46, 1.3, 40, 4, true).translate(0, 1.66 - 0.65, 0);
  along(curtain, (i) => 1 - (curtain.attributes.uv as THREE.BufferAttribute).getY(i));
  // the top jet, rising from the finial and thinning into its crown of spray
  // (a cylinder's uv.y is 1 at its top: the water starts at the bottom)
  const up = new THREE.CylinderGeometry(0.05, 0.09, 1.1, 10, 4, true).translate(0, 2.45 + 0.55, 0);
  along(up, (i) => (up.attributes.uv as THREE.BufferAttribute).getY(i));
  const parts: THREE.BufferGeometry[] = [curtain, up];
  for (let k = 0; k < arcs; k++) {
    const a = (k / arcs) * Math.PI * 2;
    const c = Math.cos(a),
      s = Math.sin(a);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const rr = R - 0.05 - t * (R * 0.48);
      pts.push(new THREE.Vector3(c * rr, 0.5 + Math.sin(t * Math.PI) * 1.25 - t * 0.14, s * rr));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.045, 6, false);
    // a tube's uv.x runs along the path: that's how far the water has come; swap
    // so uv.x goes round it, like the cylinders'
    along(tube, (i) => (tube.attributes.uv as THREE.BufferAttribute).getX(i));
    const tuv = tube.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tuv.getY(i), tuv.getX(i));
    parts.push(tube);
  }
  for (const p of parts) for (const k of Object.keys(p.attributes)) if (k !== 'position' && k !== 'uv' && k !== 'aAlong') p.deleteAttribute(k);
  const streams = new THREE.Mesh(
    mergeGeometries(parts)!,
    new THREE.ShaderMaterial({ uniforms: uni, vertexShader: STREAM_VERT, fragmentShader: STREAM_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  streams.renderOrder = 2;
  g.add(streams);
  // spray: a crown of droplets off the top jet, and splashes where the arcs land
  const n = 90 + arcs * 14;
  const quad = new THREE.PlaneGeometry(1, 1);
  const sg = new THREE.InstancedBufferGeometry();
  sg.index = quad.index;
  sg.setAttribute('position', quad.attributes.position);
  const spray = new Float32Array(n * 4);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const src = i < 90 ? 0 : 1 + ((i - 90) % arcs);
    spray.set([src, rand() * Math.PI * 2, 0.3 + rand() * 0.9, rand()], i * 4);
  }
  sg.setAttribute('aSpray', new THREE.InstancedBufferAttribute(spray, 4));
  sg.instanceCount = n;
  const sprayMesh = new THREE.Mesh(
    sg,
    new THREE.ShaderMaterial({
      uniforms: { uTime: u.uTime, uTop: { value: new THREE.Vector3(0, 3.55, 0) }, uLandR: { value: new THREE.Vector2(R * 0.52, waterY) }, uArcs: { value: arcs } },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
    }),
  );
  sprayMesh.frustumCulled = false;
  sprayMesh.renderOrder = 3;
  g.add(sprayMesh);
  // (the animated parts keep their own draws)
  for (const m of [pool, streams, sprayMesh]) m.userData.noBatch = true;
  return g;
}
