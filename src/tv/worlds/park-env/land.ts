// Rolling land round a stadium: one heightfield mesh on a polar grid, flat where
// the stadium stands and rising into hills and mountains further out. The same
// height function places whatever stands on it (houses, trees, a windmill), so
// nothing floats or sinks.
//
// The grid's rings get further apart with distance (a hill a kilometre off
// needs fewer vertices than one at the fence), and its colours are baked into
// vertex colours by the caller (greener near, bluer far, snow on the peaks…), so
// the whole backdrop is one draw in any world's own material.

import * as THREE from 'three';

/** A soft round hill: a raised cosine of radius r and height h, centred on (x, z). */
export interface Bump {
  x: number;
  z: number;
  r: number;
  h: number;
}

export const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The summed height of `bumps` at (x, z) (each one is a raised cosine: no crease at its foot). */
export function bumpsAt(bumps: Bump[], x: number, z: number) {
  let h = 0;
  for (const b of bumps) {
    const dx = x - b.x,
      dz = z - b.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= b.r * b.r) continue;
    h += b.h * (0.5 + 0.5 * Math.cos((Math.sqrt(d2) / b.r) * Math.PI));
  }
  return h;
}

/** Scatter `n` bumps over a ring of radii [r0, r1] and angles [a0, a1] (a = atan2(z, x)). */
export function scatterBumps(rand: () => number, n: number, o: { r: [number, number]; a?: [number, number]; size: [number, number]; h: [number, number] }): Bump[] {
  const out: Bump[] = [];
  const [a0, a1] = o.a ?? [-Math.PI, Math.PI];
  for (let i = 0; i < n; i++) {
    const a = a0 + (a1 - a0) * rand();
    const d = o.r[0] + (o.r[1] - o.r[0]) * rand();
    out.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: o.size[0] + (o.size[1] - o.size[0]) * rand(), h: o.h[0] + (o.h[1] - o.h[0]) * rand() });
  }
  return out;
}

export interface LandOpts {
  /** inner and outer radius of the grid (the inner edge sits under the stadium's own ground) */
  r0: number;
  r1: number;
  rings: number;
  segs: number;
  /** how the rings space out: 1 = even, higher = denser near the centre */
  bias?: number;
}

/**
 * The land as one indexed mesh: positions from `height`, smooth normals, and a
 * vertex colour per point from `color` (given x, z, the height and the normal's
 * y, i.e. how flat it is there).
 */
export function landGeometry(height: (x: number, z: number) => number, color: (x: number, z: number, h: number, up: number, out: THREE.Color) => void, o: LandOpts) {
  const nr = o.rings,
    ns = o.segs;
  const bias = o.bias ?? 1.6;
  const pos = new Float32Array((nr + 1) * ns * 3);
  const col = new Float32Array((nr + 1) * ns * 3);
  const idx: number[] = [];
  for (let i = 0; i <= nr; i++) {
    const r = o.r0 + (o.r1 - o.r0) * Math.pow(i / nr, bias);
    for (let j = 0; j < ns; j++) {
      const a = (j / ns) * Math.PI * 2;
      const x = Math.cos(a) * r,
        z = Math.sin(a) * r;
      pos.set([x, height(x, z), z], (i * ns + j) * 3);
    }
  }
  for (let i = 0; i < nr; i++)
    for (let j = 0; j < ns; j++) {
      const a = i * ns + j,
        b = i * ns + ((j + 1) % ns),
        c = a + ns,
        d = b + ns;
      // facing up
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const k = new THREE.Color();
  for (let v = 0; v < pos.length / 3; v++) {
    color(pos[v * 3], pos[v * 3 + 2], pos[v * 3 + 1], nrm.getY(v), k);
    col.set([k.r, k.g, k.b], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
