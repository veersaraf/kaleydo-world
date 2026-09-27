// Bamboo and willows that bend in the wind: every culm in the valley is one
// instanced draw, every willow another, swaying in the vertex shader
// (park-env/wind.ts) — bamboo tops sweep and their leaves shiver, willow strands
// swing. Built the way a sumi-e painter draws them: pale culms broken at every
// node by a dark ring, thin twigs, and leaves as dark blade strokes fanned in
// threes and fours; willows as a dark trunk and curtains of hanging strokes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sway, WIND_GLSL, type Wind } from '../park-env/wind';

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
};

/** A leaf blade: pointed at both ends, widest a third of the way out (both faces). */
function blade(len: number, w: number) {
  const pos = [0, 0, 0, w / 2, 0, len * 0.32, 0, 0, len, -w / 2, 0, len * 0.32];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]);
  g.computeVertexNormals();
  // a blade is seen from both sides: light it as if it faced up
  const n = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

/** One culm about `h` metres tall, with its twigs and leaves (vertex colours). */
export function culmGeometry(seed: number, h = 14, o: { culm: THREE.Color; node: THREE.Color; leaf: THREE.Color }) {
  const rnd = mulberry(seed);
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  let y = 0;
  let k = 0;
  const radius = (yy: number) => 0.115 - (yy / h) * 0.055;
  while (y < h - 0.5) {
    const len = Math.min(h - y, 0.8 + (y / h) * 0.9 + rnd() * 0.15);
    const r0 = radius(y),
      r1 = radius(y + len);
    // the internode, and the node ring that closes it
    parts.push(paint(new THREE.CylinderGeometry(r1, r0, len - 0.05, 7, 1, true).translate(0, y + len / 2, 0), o.culm));
    parts.push(paint(new THREE.CylinderGeometry(r1 * 1.18, r1 * 1.18, 0.07, 7, 1, false).translate(0, y + len - 0.02, 0), o.node));
    y += len;
    k++;
    // twigs and leaves from the upper nodes, on alternate sides
    if (y > h * 0.42 && y < h - 0.3 && rnd() < 0.85) {
      const side = (k % 2 ? 1 : -1) * (0.8 + rnd() * 0.5);
      const yaw = side + rnd() * 0.6;
      const tl = 0.7 + rnd() * 0.9;
      const tilt = 0.75 + rnd() * 0.35;
      const twig = new THREE.CylinderGeometry(0.012, 0.02, tl, 4, 1, true).translate(0, tl / 2, 0);
      twig.applyMatrix4(new THREE.Matrix4().makeRotationZ(-tilt)).applyMatrix4(new THREE.Matrix4().makeRotationY(yaw)).translate(0, y, 0);
      parts.push(paint(twig, o.node));
      // the twig's tip, where the leaves fan out
      const tip = new THREE.Vector3(Math.sin(tilt) * tl, Math.cos(tilt) * tl, 0).applyAxisAngle(up, yaw).add(new THREE.Vector3(0, y, 0));
      const out = Math.atan2(-tip.z, tip.x);
      const clusters = 1 + (rnd() < 0.6 ? 1 : 0);
      for (let c = 0; c < clusters; c++) {
        const at = c === 0 ? tip : tip.clone().lerp(new THREE.Vector3(0, y, 0), 0.45);
        const n = 3 + (rnd() < 0.5 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const L = 0.5 + rnd() * 0.35;
          const b = blade(L, 0.075 + rnd() * 0.03);
          // hanging down and out, fanned about the twig's direction
          const fan = (i - (n - 1) / 2) * 0.55 + (rnd() - 0.5) * 0.25;
          const droop = 0.35 + rnd() * 0.55;
          b.applyMatrix4(new THREE.Matrix4().makeRotationX(droop))
            .applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2 + out + fan))
            .translate(at.x, at.y, at.z);
          parts.push(paint(b, o.leaf));
        }
      }
    }
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

export interface Stalk {
  x: number;
  z: number;
  /** height scale (1 = 14 m) */
  s: number;
  yaw: number;
  /** lean (radians) and its direction */
  lean: number;
  leanDir: number;
}

/** A grove: `n` culms scattered in an ellipse round (x, z). */
export function grove(out: Stalk[], x: number, z: number, rx: number, rz: number, n: number, seed: number, scale: [number, number] = [0.7, 1.2]) {
  const rnd = mulberry(seed);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2,
      d = Math.sqrt(rnd());
    out.push({ x: x + Math.cos(a) * d * rx, z: z + Math.sin(a) * d * rz, s: scale[0] + (scale[1] - scale[0]) * rnd(), yaw: rnd() * Math.PI * 2, lean: rnd() * 0.07, leanDir: rnd() * Math.PI * 2 });
  }
}

export class Bamboo {
  mesh: THREE.InstancedMesh;
  private n: number;

  constructor(wind: Wind, stalks: Stalk[], o: { culm: THREE.Color; node: THREE.Color; leaf: THREE.Color; seed?: number }) {
    // one culm shape: turned, stretched and leaning differently, no two look alike
    const geo = culmGeometry(o.seed ?? 3, 14, o);
    const mat = sway(new THREE.MeshLambertMaterial({ vertexColors: true }), wind, 'canopy', { amp: 0.42, height: 10, flutter: 0.025 });
    // shuffled, so the detail level can drop any tail of the list and thin every grove evenly
    const rnd = mulberry(o.seed ?? 3);
    stalks = stalks.slice();
    for (let i = stalks.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [stalks[i], stalks[j]] = [stalks[j], stalks[i]];
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, stalks.length);
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    stalks.forEach((t, i) => {
      e.set(Math.cos(t.leanDir) * t.lean, t.yaw, Math.sin(t.leanDir) * t.lean, 'YXZ');
      q.setFromEuler(e);
      p.set(t.x, 0, t.z);
      s.set(0.9 + t.s * 0.1, t.s, 0.9 + t.s * 0.1);
      this.mesh.setMatrixAt(i, M.compose(p, q, s));
    });
    this.mesh.computeBoundingSphere();
    this.mesh.boundingSphere!.radius += 2;
    this.mesh.userData.noBatch = true;
    this.n = stalks.length;
  }

  /** Thin the groves at low detail. */
  setDetail(d: number) {
    this.mesh.count = Math.round(this.n * (0.45 + 0.55 * d));
  }
}

// ---------------------------------------------------------------- willows

/** 0 on the wood, 0 → 1 down each strand: how far the wind swings it */
const drop = (g: THREE.BufferGeometry, f: (i: number) => number) => {
  const n = g.attributes.position.count;
  g.setAttribute('aDrop', new THREE.Float32BufferAttribute(Float32Array.from({ length: n }, (_, i) => f(i)), 1));
  return g;
};

/**
 * A weeping willow: a short leaning trunk, limbs arching up and over from its
 * top, and from them strands falling almost straight down — a dome of hanging
 * curtains. Strands are flat ribbons facing every way; aDrop says how far down
 * its strand a vertex is.
 */
export function willowGeometry(seed: number, o: { bark: THREE.Color; leaf: THREE.Color }) {
  const rnd = mulberry(seed);
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.35, 1.3, 0.1), new THREE.Vector3(0.15, 2.6, -0.15), new THREE.Vector3(0.45, 3.4, 0)]);
  parts.push(drop(paint(new THREE.TubeGeometry(trunk, 10, 0.3, 7), o.bark), () => 0));
  // limbs arching up and out from the top of the trunk, drooping at their tips
  const top = trunk.getPoint(1);
  const limbs = 8;
  for (let l = 0; l < limbs; l++) {
    const a = (l / limbs) * Math.PI * 2 + rnd() * 0.5;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const reach = 2.6 + rnd() * 1.2;
    const end = top.clone().addScaledVector(dir, reach).add(new THREE.Vector3(0, 1.2 + rnd() * 0.6, 0));
    const mid = top.clone().addScaledVector(dir, reach * 0.35).add(new THREE.Vector3(0, 3 + rnd() * 0.8, 0));
    const limb = new THREE.QuadraticBezierCurve3(top, mid, end);
    parts.push(drop(paint(new THREE.TubeGeometry(limb, 6, 0.09, 5), o.bark), () => 0));
    for (let k = 0; k < 12; k++) {
      const t = 0.2 + (k / 11) * 0.8 + (rnd() - 0.5) * 0.04;
      const p = limb.getPoint(t);
      // a strand: a narrow ribbon falling to about a metre off the ground,
      // bowed out a touch
      const len = Math.max(1.2, p.y - 0.7 - rnd() * 1.1);
      const out = dir.clone().multiplyScalar(0.1 + rnd() * 0.25 + t * 0.2);
      const face = rnd() * Math.PI;
      const w = 0.16 + rnd() * 0.08;
      const n = 6;
      const pos: number[] = [];
      const ds: number[] = [];
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        const c = p.clone().addScaledVector(out, Math.sin(s * Math.PI * 0.6)).add(new THREE.Vector3(0, -s * len, 0));
        const dx = Math.cos(face) * w * (1 - s * 0.7) * 0.5,
          dz = Math.sin(face) * w * (1 - s * 0.7) * 0.5;
        pos.push(c.x - dx, c.y, c.z - dz, c.x + dx, c.y, c.z + dz);
        ds.push(s, s);
      }
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const b = i * 2;
        // both faces
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3, b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array((n + 1) * 2).fill([0, 1, 0]).flat(), 3));
      g.setAttribute('aDrop', new THREE.Float32BufferAttribute(ds, 1));
      g.setIndex(idx);
      parts.push(paint(g, o.leaf));
    }
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

/**
 * A willow's sway: the strands swing from where they hang, more the further
 * down (the wood stays put), in the same breeze as everything else.
 */
function willowMaterial(wind: Wind, amp: number) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = wind.u.uTime;
    sh.uniforms.uWind = wind.u.uWind;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${WIND_GLSL}\nattribute float aDrop;`).replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4(transformed, 1.0);
      vec3 io = vec3(0.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
        io = instanceMatrix[3].xyz;
      #endif
      {
        vec3 wp = (modelMatrix * vec4(io, 1.0)).xyz;
        // strands round the crown swing out of step (smoothly: a strand keeps together)
        float ph = windHash(wp.xz) * 6.2831 + dot(transformed.xz, vec2(1.7, 1.1));
        vec2 push = windPush(wp.xz, ph) * ${amp.toFixed(2)} * aDrop * aDrop;
        mvPosition.xz += push;
        // swinging out, a strand rises a little
        mvPosition.y += dot(push, push) * 0.25;
      }
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  m.customProgramCacheKey = () => `willow-${amp}`;
  return m;
}

export class Willows {
  mesh: THREE.InstancedMesh;

  constructor(wind: Wind, at: { x: number; z: number; s: number; yaw: number }[], o: { bark: THREE.Color; leaf: THREE.Color }) {
    this.mesh = new THREE.InstancedMesh(willowGeometry(7, o), willowMaterial(wind, 0.7), at.length);
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    at.forEach((w, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), w.yaw);
      this.mesh.setMatrixAt(i, M.compose(new THREE.Vector3(w.x, 0, w.z), q, new THREE.Vector3(w.s, w.s, w.s)));
    });
    this.mesh.computeBoundingSphere();
    this.mesh.boundingSphere!.radius += 2;
    this.mesh.userData.noBatch = true;
  }
}
