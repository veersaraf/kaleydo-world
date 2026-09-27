// Stylised trees, bushes, vines and flowers that breathe in the wind.
//
// Everything is instanced: one draw per kind (and one more in the shadow pass,
// with the same sway so shadows move with the leaves). Canopies are clumps of
// soft blobs shaded as one round volume: their normals lean out from the
// clump's centre, so light wraps the whole crown instead of every blob, and a
// two-tone gradient is baked into their vertex colours: cool and deep
// underneath, warm and bright on top. The instance colour sets each plant's hue.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sway, swayDepth, type SwayOpts, type Wind } from './wind';

/** Where one plant stands (y = the ground under it). */
export interface Place {
  x: number;
  z: number;
  y?: number;
  yaw?: number;
  s?: number;
  /** extra vertical stretch */
  sy?: number;
  color?: THREE.Color;
}

/** blob centre and radius, and an optional vertical stretch */
export type Blob = [x: number, y: number, z: number, r: number, sy?: number];

export interface Tone {
  /** multiplier underneath / in the heart of the clump (linear) */
  low: THREE.Color;
  /** multiplier on the sunny top */
  high: THREE.Color;
}

export const LEAF_TONE: Tone = { low: new THREE.Color(0.6, 0.72, 0.8), high: new THREE.Color(1.14, 1.1, 0.84) };

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A cheap smooth 3D wobble for lumpy surfaces (no noise tables needed). */
const wob = (x: number, y: number, z: number, s: number) => Math.sin(x * 2.3 + s) * Math.sin(y * 2.9 + s * 1.7) * Math.sin(z * 2.1 + s * 0.6);

/**
 * One canopy (or bush) from its blobs, shaded as a single volume, with a
 * lumpy surface and the two-tone gradient in its vertex colours.
 */
export function clumpGeometry(blobs: Blob[], o: { seg?: number; lean?: number; lumpy?: number; seed?: number; tone?: Tone } = {}) {
  const seg = o.seg ?? 12;
  const parts = blobs.map(([x, y, z, r, sy = 1]) => {
    const g = new THREE.SphereGeometry(r, seg, Math.max(5, Math.round(seg * 0.66)));
    g.deleteAttribute('uv');
    return g.scale(1, sy, 1).translate(x, y, z);
  });
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  const size = bb.getSize(new THREE.Vector3());
  const R = Math.max(size.x, size.y, size.z) / 2;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const tone = o.tone ?? LEAF_TONE;
  const lean = o.lean ?? 0.62;
  const lumpy = o.lumpy ?? 0.08;
  const seed = o.seed ?? 1;
  const p = new THREE.Vector3(),
    n = new THREE.Vector3(),
    d = new THREE.Vector3(),
    k = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    // small lumps on each blob so the silhouette isn't a set of perfect balls
    p.addScaledVector(n, wob(p.x * 1.7, p.y * 1.7, p.z * 1.7, seed) * lumpy * R);
    d.subVectors(p, c);
    const dist = d.length();
    d.divideScalar(dist || 1);
    n.lerp(d, lean).normalize();
    pos.setXYZ(i, p.x, p.y, p.z);
    nrm.setXYZ(i, n.x, n.y, n.z);
    const t = (p.y - bb.min.y) / Math.max(1e-3, size.y);
    const g2 = Math.min(1, Math.max(0, 0.42 * t + 0.58 * (n.y * 0.5 + 0.5)));
    k.copy(tone.low).lerp(tone.high, smooth(0.18, 0.92, g2));
    // the heart of the clump sits in its own shade
    k.multiplyScalar(0.86 + 0.14 * smooth(0.35, 0.9, dist / R));
    col[i * 3] = k.r;
    col[i * 3 + 1] = k.g;
    col[i * 3 + 2] = k.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// ---------------------------------------------------------------- shapes

/** Seeded blob layouts for the tree shapes. */
function rng(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TreeKind = 'round' | 'tall' | 'wide';

/** Crown blobs for each tree shape (trunk top ≈ 3.3 m, hidden inside). */
export function crownBlobs(kind: TreeKind, seed = 7): Blob[] {
  const r = rng(seed);
  const out: Blob[] = [];
  if (kind === 'round') {
    // a lollipop crown: a big heart, a ring of puffs and a cap
    out.push([0, 4.4, 0, 1.55]);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + r() * 0.5;
      out.push([Math.cos(a) * 1.15, 3.9 + r() * 1.0, Math.sin(a) * 1.15, 0.85 + r() * 0.3]);
    }
    out.push([0.2, 5.4, -0.1, 1.0], [-0.5, 5.1, 0.5, 0.8]);
  } else if (kind === 'tall') {
    // a slim flame of foliage (a poplar/cypress accent): a long core with tufts on it
    out.push([0, 4.9, 0, 1.25, 2.4]);
    for (let k = 0; k < 7; k++) {
      const y = 2.9 + k * 0.72;
      const rr = 0.95 - k * 0.09;
      const a = k * 2.4 + r();
      out.push([Math.cos(a) * rr * 0.62, y, Math.sin(a) * rr * 0.62, rr * 0.72, 1.25]);
    }
  } else {
    // wide and flat-topped: an umbrella of puffs
    out.push([0, 4.3, 0, 1.4]);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + r() * 0.4;
      const d = 1.7 + r() * 0.5;
      out.push([Math.cos(a) * d, 4.1 + r() * 0.5, Math.sin(a) * d, 0.95 + r() * 0.3]);
    }
    out.push([0.4, 5.0, 0.3, 1.1], [-0.6, 4.9, -0.4, 1.0]);
  }
  return out;
}

/** A tapered trunk with two short limbs reaching into the crown (vertex colours: darker at the foot). */
export function trunkGeometry(height = 3.6) {
  const parts = [new THREE.CylinderGeometry(0.12, 0.22, height, 7, 3, true).translate(0, height / 2, 0)];
  for (const s of [-1, 1]) {
    const limb = new THREE.CylinderGeometry(0.05, 0.09, 1.5, 5, 1, true);
    limb.translate(0, 0.75, 0).rotateZ(s * 0.6).rotateY(s * 0.4).translate(0, 2.3, 0);
    parts.push(limb);
  }
  for (const p of parts) p.deleteAttribute('uv');
  const g = mergeGeometries(parts)!;
  // darker at the foot
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = 0.82 + 0.28 * smooth(0, 2.4, pos.getY(i));
    col.set([v, v, v], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Bush blobs: a low rounded clump about 1 m across, sitting on the ground. */
export function bushBlobs(seed = 3, n = 5): Blob[] {
  const r = rng(seed);
  const out: Blob[] = [[0, 0.42, 0, 0.5]];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r();
    out.push([Math.cos(a) * 0.36, 0.3 + r() * 0.2, Math.sin(a) * 0.36, 0.3 + r() * 0.12]);
  }
  return out;
}

/** A trailing strand of leaves hanging `len` metres down from its origin. */
export function vineBlobs(seed = 13, len = 2.4): Blob[] {
  const r = rng(seed);
  const n = 7;
  const out: Blob[] = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    out.push([Math.sin(k * 1.9 + r()) * 0.1, -t * len + 0.05, Math.cos(k * 2.3 + r()) * 0.08, 0.27 - t * 0.1 + r() * 0.04]);
  }
  return out;
}

// ---------------------------------------------------------------- the set

const UP = new THREE.Vector3(0, 1, 0);

export interface FoliageOpts {
  /** tree crowns: metres the top moves in a gust, and the height that takes the full amount */
  tree?: SwayOpts;
  bush?: SwayOpts;
  flower?: SwayOpts;
  shadows?: boolean;
}

/**
 * The instanced plants of one world. Add them by kind; each call makes one
 * InstancedMesh (so keep calls per kind few), all sharing the world's wind.
 */
export class Foliage {
  group = new THREE.Group();
  readonly leaf: THREE.MeshStandardMaterial;
  readonly bark: THREE.MeshStandardMaterial;
  readonly shrub: THREE.MeshStandardMaterial;
  readonly bloom: THREE.MeshStandardMaterial;
  private depth: { tree: THREE.Material; bush: THREE.Material };
  /** meshes whose instance count the detail level trims (with their full counts) */
  private optional: [THREE.InstancedMesh, number][] = [];
  private shadows: boolean;

  constructor(
    private wind: Wind,
    o: FoliageOpts = {},
  ) {
    const tree = o.tree ?? { amp: 0.16, height: 6, flutter: 0.025 };
    const bush = o.bush ?? { amp: 0.05, height: 1.1, flutter: 0.015 };
    const flower = o.flower ?? { amp: 0.06, height: 0.5, flutter: 0.01 };
    this.shadows = o.shadows ?? true;
    this.leaf = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }), wind, 'canopy', tree);
    this.bark = sway(new THREE.MeshStandardMaterial({ color: '#a8835f', vertexColors: true, roughness: 0.9 }), wind, 'canopy', { ...tree, flutter: 0 });
    this.shrub = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), wind, 'canopy', bush);
    this.bloom = sway(new THREE.MeshStandardMaterial({ roughness: 0.6 }), wind, 'grass', flower);
    this.depth = { tree: swayDepth(wind, 'canopy', tree), bush: swayDepth(wind, 'canopy', bush) };
  }

  /** Instances of `geo` at `at`; the colour of each comes from `at[i].color` (white if unset). */
  add(geo: THREE.BufferGeometry, mat: THREE.Material, at: Place[], o: { shadow?: THREE.Material | null; optional?: boolean; receive?: boolean } = {}) {
    const m = new THREE.InstancedMesh(geo, mat, at.length);
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const M = new THREE.Matrix4();
    const white = new THREE.Color(1, 1, 1);
    at.forEach((a, i) => {
      q.setFromAxisAngle(UP, a.yaw ?? 0);
      const sc = a.s ?? 1;
      s.set(sc, sc * (a.sy ?? 1), sc);
      p.set(a.x, a.y ?? 0, a.z);
      m.setMatrixAt(i, M.compose(p, q, s));
      m.setColorAt(i, a.color ?? white);
    });
    if (o.shadow && this.shadows) {
      m.castShadow = true;
      m.customDepthMaterial = o.shadow;
    }
    m.receiveShadow = o.receive ?? true;
    m.computeBoundingSphere();
    // the sway reaches a little past the resting bounds
    m.boundingSphere!.radius += 1;
    if (o.optional) this.optional.push([m, at.length]);
    this.group.add(m);
    return m;
  }

  /** Trees of one shape: trunks and crowns (two draws, both casting swaying shadows). */
  trees(kind: TreeKind, at: Place[], seed = 11) {
    if (!at.length) return;
    // (the colour is the crown's: trunks keep the bark's own)
    this.add(trunkGeometry(), this.bark, at.map((a) => ({ ...a, color: undefined })), { shadow: this.depth.tree });
    this.add(clumpGeometry(crownBlobs(kind, seed), { seed, seg: 10, lumpy: 0.07 }), this.leaf, at, { shadow: this.depth.tree });
  }

  /** Round bushes (or a hedge-like row when placed close); small ones needn't cast shadows. */
  bushes(at: Place[], seed = 5, o: { shadow?: boolean; seg?: number } = {}) {
    if (!at.length) return;
    this.add(clumpGeometry(bushBlobs(seed), { seed, seg: o.seg ?? 8, lumpy: 0.1, lean: 0.7 }), this.shrub, at, { shadow: o.shadow === false ? null : this.depth.bush });
  }

  /** Vines hanging from a beam or trailing over a pot's rim (y = where they hang from). */
  vines(at: Place[], len = 2.4, seed = 13) {
    if (!at.length) return;
    // hung from the top: the bend grows downwards (a negative height), the tips swing most
    const opts = { amp: 0.12, height: -len, flutter: 0.02 };
    const mat = sway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), this.wind, 'canopy', opts);
    return this.add(clumpGeometry(vineBlobs(seed, len), { seed, seg: 7, lumpy: 0.12, lean: 0.35 }), mat, at, { shadow: swayDepth(this.wind, 'canopy', opts) });
  }

  /** Little blossoms on unseen stalks (y = the ground they grow from; sy stretches the stalk). */
  flowers(at: Place[], stalk = 0.42) {
    if (!at.length) return;
    // a flattened octahedron: at playing distance a blossom is a dot of colour
    // with a lit top; it floats where its stalk would hold it, so it sways like one
    const g = new THREE.OctahedronGeometry(0.1, 0).scale(1, 0.55, 1).translate(0, stalk, 0);
    g.deleteAttribute('uv');
    return this.add(g, this.bloom, at, { optional: true, receive: false });
  }

  /** Scale the optional extras (flowers…) with the world's detail level. */
  setDetail(d: number) {
    for (const [m, n] of this.optional) m.count = Math.round(n * Math.min(1, 0.35 + 0.65 * d));
  }
}
