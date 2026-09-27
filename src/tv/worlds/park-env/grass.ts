// Instanced grass: tufts of a few curved blades scattered over the lawns, bending
// in the wind (wind.ts), thinning out with distance and tinted by the same soft
// patches as the lawn under them (LAWN_GLSL), so from afar the blades melt into
// the ground instead of ending at a line.
//
// Cost control:
//  • the field is cut into square chunks, one InstancedMesh each, so what's off
//    screen is culled whole;
//  • every tuft has its own cut-off distance (aCut), and chunks keep their tufts
//    sorted by it, so update() can simply stop drawing a chunk's tail: tufts
//    past their cut-off are never sent at all, and the shader shrinks the rest
//    smoothly to nothing as they reach theirs (widening the survivors a little
//    so the thinning doesn't show);
//  • setDetail() scales the density and the reach (0 = no blades at all).
// No shadows are cast (a lawn's own shadow is invisible, and costs a pass).

import * as THREE from 'three';
import { sway, type Wind } from './wind';

/** Soft lawn-sized patches: a little lighter and warmer here, deeper there (shared by lawn and blades). */
export const LAWN_GLSL = /* glsl */ `
float lawnHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float lawnNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lawnHash(i), lawnHash(i + vec2(1.0, 0.0)), u.x), mix(lawnHash(i + vec2(0.0, 1.0)), lawnHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 lawnTint(vec2 p) {
  float n = lawnNoise(p * 0.06) * 0.6 + lawnNoise(p * 0.21 + 7.3) * 0.4;
  return mix(vec3(0.84, 0.95, 0.9), vec3(1.12, 1.08, 0.84), smoothstep(0.2, 0.8, n));
}
`;

export interface GrassOpts {
  /** where grass grows, 0..1 (0 = none) */
  density: (x: number, z: number) => number;
  /** the area to scatter over */
  bounds: { x0: number; x1: number; z0: number; z1: number };
  /** tufts per square metre at full density */
  perM2: number;
  /** the ground's height at a point (raised planters) */
  groundY?: (x: number, z: number) => number;
  /** tuft height range, metres */
  height?: [number, number];
  /** tuft colours (one is picked per tuft, then jittered) */
  colors: THREE.Color[];
  /** where tufts start to thin out and where the last ones go, metres from the camera */
  fade?: [number, number];
  /** chunk size, metres */
  chunk?: number;
  seed?: number;
}

/** A tuft of curved blades, 1 m tall and about 0.25 m across (scaled per instance). */
function tuftGeometry(blades: number, rand: () => number) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + rand() * 0.8;
    const dx = Math.cos(a),
      dz = Math.sin(a);
    // across the blade
    const tx = -dz,
      tz = dx;
    const r0 = 0.02 + rand() * 0.05;
    const lean = 0.14 + rand() * 0.22;
    const h = 0.65 + rand() * 0.35;
    const w = 0.085 + rand() * 0.03;
    const bx = dx * r0,
      bz = dz * r0;
    const v0 = pos.length / 3;
    // base, middle (bent out a little), tip
    const pts: [number, number, number, number][] = [
      [-0.5, 0, 0, 1],
      [0.5, 0, 0, 1],
      [-0.5, 0.5, 0.3, 0.62],
      [0.5, 0.5, 0.3, 0.62],
      [0, 1, 1, 0],
    ];
    for (const [s, v, out, wid] of pts) {
      pos.push(bx + dx * lean * out * h + tx * s * w * wid, v * h, bz + dz * lean * out * h + tz * s * w * wid);
      // lit like the lawn: normals point up, tipped a touch towards the blade's lean
      const nx = dx * 0.25,
        nz = dz * 0.25;
      const l = Math.hypot(nx, 1, nz);
      nrm.push(nx / l, 1 / l, nz / l);
      // deep at the root, bright and warm at the tip
      const t = v;
      col.push(0.44 + 0.66 * t, 0.54 + 0.58 * t, 0.44 + 0.42 * t);
    }
    idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2, v0 + 2, v0 + 3, v0 + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A smooth 2D value noise for clumping (CPU side). */
function noise2(seed: number) {
  const h = (x: number, z: number) => {
    const s = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return (x: number, z: number) => {
    const ix = Math.floor(x),
      iz = Math.floor(z);
    const fx = x - ix,
      fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx),
      uz = fz * fz * (3 - 2 * fz);
    const a = h(ix, iz),
      b = h(ix + 1, iz),
      c = h(ix, iz + 1),
      d = h(ix + 1, iz + 1);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  };
}

interface Chunk {
  mesh: THREE.InstancedMesh;
  n: number;
  /** cut-off factors, sorted high → low (the draw order) */
  cuts: Float32Array;
  cx: number;
  cz: number;
  /** half-diagonal */
  r: number;
}

export class Grass {
  group = new THREE.Group();
  readonly mat: THREE.MeshStandardMaterial;
  private chunks: Chunk[] = [];
  private fade = { value: new THREE.Vector3(30, 80, 0.012) };
  private base: [number, number];
  private detail = 1;
  private cam = new THREE.Vector3();
  /** tufts in the whole field */
  readonly total: number;

  constructor(wind: Wind, o: GrassOpts) {
    const rand = mulberry(o.seed ?? 71);
    const clump = noise2(o.seed ?? 71);
    this.base = o.fade ?? [30, 80];
    const [h0, h1] = o.height ?? [0.24, 0.42];
    const size = o.chunk ?? 12;
    const geo = tuftGeometry(4, rand);

    const fade = this.fade;
    this.mat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }), wind, 'grass', { amp: 0.16, height: 0.4, flutter: 0.012 }, {
      key: 'grass',
      patch: (sh) => {
        sh.uniforms.uFade = fade;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>\nattribute float aCut;\nuniform vec3 uFade;\n${LAWN_GLSL}`)
          .replace(
            '#include <color_vertex>',
            /* glsl */ `#include <color_vertex>
            vec3 gio = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
            vColor.rgb *= lawnTint(gio.xz);`,
          )
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `#include <begin_vertex>
            {
              // shrink away at this tuft's own cut-off; the survivors widen a little with distance
              float gd = distance(gio.xz, cameraPosition.xz);
              float cut = mix(uFade.x, uFade.y, aCut);
              float gs = 1.0 - smoothstep(cut * 0.8, cut, gd);
              transformed.y *= gs;
              transformed.xz *= gs * (1.0 + gd * uFade.z);
            }`,
          );
        // both faces are lit as the lawn (a blade seen from behind isn't a dark blade)
        sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, ''));
      },
    });

    // scatter on a jittered grid, clumped by a soft noise, into chunks
    const step = 1 / Math.sqrt(o.perM2);
    const cells = new Map<string, { x: number; y: number; z: number; cut: number }[]>();
    const { x0, x1, z0, z1 } = o.bounds;
    for (let z = z0; z < z1; z += step)
      for (let x = x0; x < x1; x += step) {
        const px = x + rand() * step,
          pz = z + rand() * step;
        const d = o.density(px, pz);
        if (d <= 0) continue;
        const c = 0.45 + 0.75 * clump(px * 0.45, pz * 0.45);
        if (rand() > d * c) continue;
        const key = `${Math.floor(px / size)},${Math.floor(pz / size)}`;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push({ x: px, y: o.groundY?.(px, pz) ?? 0, z: pz, cut: rand() });
      }
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const k = new THREE.Color();
    const UP = new THREE.Vector3(0, 1, 0);
    let total = 0;
    for (const [key, list] of cells) {
      // the tufts that reach furthest first: a chunk's far tail can then be skipped by count
      list.sort((a, b) => b.cut - a.cut);
      const n = list.length;
      const mesh = new THREE.InstancedMesh(geo, this.mat, n);
      const cuts = new Float32Array(n);
      list.forEach((t, i) => {
        q.setFromAxisAngle(UP, rand() * Math.PI * 2);
        const h = h0 + (h1 - h0) * rand();
        const w = 0.8 + rand() * 0.5;
        mesh.setMatrixAt(i, M.compose(p.set(t.x, t.y, t.z), q, s.set(w, h, w)));
        k.copy(o.colors[Math.floor(rand() * o.colors.length)]).multiplyScalar(0.92 + rand() * 0.16);
        mesh.setColorAt(i, k);
        cuts[i] = t.cut;
      });
      mesh.geometry = geo;
      // per-instance cut-off (a shared geometry can't hold it: an InstancedMesh attribute on a clone)
      const g = geo.clone();
      g.setAttribute('aCut', new THREE.InstancedBufferAttribute(cuts, 1));
      mesh.geometry = g;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.computeBoundingSphere();
      mesh.boundingSphere!.radius += 0.5;
      const [cx, cz] = key.split(',').map((v) => (+v + 0.5) * size);
      this.chunks.push({ mesh, n, cuts, cx, cz, r: size * 0.71 });
      this.group.add(mesh);
      total += n;
    }
    geo.dispose();
    this.total = total;
  }

  /** Once a frame (cheap: one distance per chunk): stop sending tufts past their cut-off. */
  update(cam: THREE.Camera) {
    this.cam.copy(cam.position);
    this.group.worldToLocal(this.cam);
    const [near, far] = [this.fade.value.x, this.fade.value.y];
    for (const c of this.chunks) {
      if (this.detail <= 0) {
        c.mesh.count = 0;
        continue;
      }
      // the chunk's nearest point to the camera decides which tufts could still show
      const d = Math.max(0, Math.hypot(c.cx - this.cam.x, c.cz - this.cam.z) - c.r);
      const need = (d - near) / Math.max(1e-3, far - near);
      // cuts are sorted high → low: draw those whose cut-off lies beyond d
      let lo = 0,
        hi = c.n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (c.cuts[mid] > need) lo = mid + 1;
        else hi = mid;
      }
      c.mesh.count = lo;
    }
  }

  /** 0 = no grass, 1 = full density and reach. */
  setDetail(d: number) {
    this.detail = d;
    const k = 0.45 + 0.55 * d;
    this.fade.value.set(this.base[0] * k, this.base[1] * k, 0.012 / k);
    this.group.visible = d > 0;
  }
}
