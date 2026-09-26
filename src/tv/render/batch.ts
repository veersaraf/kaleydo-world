// Static batching: bake a world's static scenery into one mesh per material.
//
// Worlds are built from thousands of small primitives (bamboo stalks, bunting,
// trees, seats…). Drawn one by one that is thousands of draw calls, and three.js
// walks, culls and sorts every one of them on the CPU each frame — the main cause
// of dropped frames. Anything that never moves is merged instead.
//
// "Never moves" is measured, not declared: we snapshot every object, run the
// world's animation for a few made-up moments, and treat whatever changed
// (transform, vertices or visibility) as dynamic, together with its subtree.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BatchStats {
  before: number;
  merged: number;
  batches: number;
  dynamic: number;
  skipped: number;
}

interface Snap {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
  v: boolean;
  gv: number;
}

function flipWinding(g: THREE.BufferGeometry) {
  if (g.index) {
    const idx = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    g.index.needsUpdate = true;
    return;
  }
  for (const k in g.attributes) {
    const a = g.attributes[k] as THREE.BufferAttribute;
    const n = a.itemSize;
    const arr = a.array as Float32Array;
    for (let v = 0; v + 2 < a.count; v += 3) {
      for (let c = 0; c < n; c++) {
        const i1 = (v + 1) * n + c,
          i2 = (v + 2) * n + c;
        const t = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = t;
      }
    }
    a.needsUpdate = true;
  }
}

const attrVersion = (g: THREE.BufferGeometry) => {
  let v = 0;
  for (const k in g.attributes) v += (g.attributes[k] as THREE.BufferAttribute).version ?? 0;
  return v;
};

/**
 * Merge the static meshes under `root`. `probe` runs the world's animation a few
 * times; `restore` is handled here (transforms are put back afterwards).
 */
export function batchStatic(root: THREE.Object3D, probe: () => void): BatchStats {
  const all: THREE.Object3D[] = [];
  root.traverse((o) => all.push(o));
  const stats: BatchStats = { before: 0, merged: 0, batches: 0, dynamic: 0, skipped: 0 };

  // ---- 1. find what moves
  const snaps = new Map<THREE.Object3D, Snap>();
  for (const o of all) {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    snaps.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), v: o.visible, gv: g ? attrVersion(g) : 0 });
  }
  probe();
  const dynamic = new Set<THREE.Object3D>();
  for (const o of all) {
    const s = snaps.get(o)!;
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const moved = !o.position.equals(s.p) || !o.quaternion.equals(s.q) || !o.scale.equals(s.s) || o.visible !== s.v || (g ? attrVersion(g) !== s.gv : false);
    if (moved) o.traverse((c) => dynamic.add(c));
    // put it back exactly as built
    o.position.copy(s.p);
    o.quaternion.copy(s.q);
    o.scale.copy(s.s);
    o.visible = s.v;
  }
  stats.dynamic = dynamic.size;

  // ---- 2. choose what to merge
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, THREE.Mesh[]>();
  const visibleChain = (o: THREE.Object3D) => {
    for (let c: THREE.Object3D | null = o; c && c !== root; c = c.parent) if (!c.visible) return false;
    return true;
  };
  for (const o of all) {
    const m = o as THREE.Mesh;
    if (!m.isMesh) continue;
    stats.before++;
    const mat = m.material as THREE.Material;
    const geo = m.geometry as THREE.BufferGeometry;
    const special =
      dynamic.has(m) ||
      (m as THREE.InstancedMesh).isInstancedMesh ||
      (m as unknown as THREE.SkinnedMesh).isSkinnedMesh ||
      Array.isArray(m.material) ||
      !geo?.attributes.position ||
      Object.keys(geo.morphAttributes).length > 0 ||
      // blended transparency is drawn back-to-front per object: keep those separate
      // (additive glows don't care about order)
      (mat.transparent && mat.blending !== THREE.AdditiveBlending) ||
      m.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ||
      !visibleChain(m);
    if (special) {
      stats.skipped++;
      continue;
    }
    const sig = Object.keys(geo.attributes)
      .sort()
      .map((k) => {
        const a = geo.attributes[k] as THREE.BufferAttribute;
        return `${k}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}`;
      })
      .join(',');
    const flags = JSON.stringify({ n: m.userData.noNormals ?? 0, net: m.userData.net ?? 0 });
    const key = [mat.uuid, m.castShadow ? 1 : 0, m.receiveShadow ? 1 : 0, m.renderOrder, m.layers.mask, m.frustumCulled ? 1 : 0, geo.index ? 'i' : 'n', sig, flags].join('|');
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(m);
  }

  // ---- 3. merge
  const mergedSet = new Set<THREE.Object3D>();
  const tmp = new THREE.Matrix4();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const geos: THREE.BufferGeometry[] = [];
    for (const m of list) {
      const g = (m.geometry as THREE.BufferGeometry).clone();
      g.applyMatrix4(tmp.multiplyMatrices(toRoot, m.matrixWorld));
      // a mirrored transform flips the winding (three.js compensates per object at
      // draw time; baked in, we have to swap two corners of every triangle)
      if (m.matrixWorld.determinant() < 0) flipWinding(g);
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const first = list[0];
    const mesh = new THREE.Mesh(merged, first.material);
    mesh.name = 'batch';
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    mesh.layers.mask = first.layers.mask;
    mesh.frustumCulled = first.frustumCulled;
    if (first.userData.noNormals) mesh.userData.noNormals = true;
    if (first.userData.net) mesh.userData.net = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    for (const m of list) mergedSet.add(m);
    stats.merged += list.length;
    stats.batches++;
  }

  // ---- 4. retire the originals: drop the ones whose whole subtree was merged,
  // otherwise keep the node (its children still draw) but stop drawing it
  const fullyMerged = (o: THREE.Object3D): boolean => mergedSet.has(o) && o.children.every(fullyMerged);
  for (const m of mergedSet) {
    if (!m.parent) continue;
    if (fullyMerged(m)) m.parent.remove(m);
    else m.layers.disableAll();
  }
  // empty static groups left behind
  const prune = (o: THREE.Object3D) => {
    for (const c of [...o.children]) prune(c);
    if (o !== root && o.children.length === 0 && !(o as THREE.Mesh).isMesh && !dynamic.has(o) && o.type === 'Group' && o.parent) o.parent.remove(o);
  };
  prune(root);

  // ---- 5. static transforms never need recomposing
  root.traverse((o) => {
    if (o === root || dynamic.has(o)) return;
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
  root.updateMatrixWorld(true);
  return stats;
}
