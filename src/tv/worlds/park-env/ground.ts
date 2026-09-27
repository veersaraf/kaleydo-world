// Ground dressing: paving with real slabs (colour, grooves and a rougher grout,
// all painted on small canvases), lawns and flower beds with stone curbs.
//
// A lawn is a patch — a rounded rectangle, a disc or a ring — described once and
// used three ways: its mesh, its curb, and a signed distance that tells the
// grass where to grow (and how far from the edge it is).
//
// Large repeating textures give themselves away as a grid from far off, so the
// paving and the lawns carry a second, much larger variation (a soft noise on
// world position, in the shader) that never repeats.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTex } from '../mats';
import { LAWN_GLSL } from './grass';

// ---------------------------------------------------------------- patches

export type Patch =
  | { kind: 'rect'; x: number; z: number; w: number; d: number; r: number }
  | { kind: 'disc'; x: number; z: number; r: number }
  | { kind: 'ring'; x: number; z: number; r0: number; r1: number };

/** Signed distance to the patch's edge in metres (negative inside). */
export function patchSdf(p: Patch, x: number, z: number) {
  if (p.kind === 'rect') {
    const qx = Math.abs(x - p.x) - (p.w / 2 - p.r);
    const qz = Math.abs(z - p.z) - (p.d / 2 - p.r);
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - p.r;
  }
  const d = Math.hypot(x - p.x, z - p.z);
  if (p.kind === 'disc') return d - p.r;
  return Math.max(d - p.r1, p.r0 - d);
}

/** The same patch shrunk by `by` metres. */
export function inset(p: Patch, by: number): Patch {
  if (p.kind === 'rect') return { ...p, w: p.w - 2 * by, d: p.d - 2 * by, r: Math.max(0.01, p.r - by) };
  if (p.kind === 'disc') return { ...p, r: p.r - by };
  return { ...p, r0: p.r0 + by, r1: p.r1 - by };
}

/** Outline(s) in shape space (x, -z): the ground plane is the shape plane turned face up. */
function outline(p: Patch, seg = 48): THREE.Vector2[][] {
  const circle = (cx: number, cz: number, r: number) => Array.from({ length: seg }, (_, i) => new THREE.Vector2(cx + Math.cos((i / seg) * Math.PI * 2) * r, -(cz + Math.sin((i / seg) * Math.PI * 2) * r)));
  if (p.kind === 'disc') return [circle(p.x, p.z, p.r)];
  if (p.kind === 'ring') return [circle(p.x, p.z, p.r1), circle(p.x, p.z, p.r0).reverse()];
  const pts: THREE.Vector2[] = [];
  const hw = p.w / 2 - p.r,
    hd = p.d / 2 - p.r;
  const corners: [number, number, number][] = [
    [hw, hd, 0],
    [-hw, hd, Math.PI / 2],
    [-hw, -hd, Math.PI],
    [hw, -hd, (3 * Math.PI) / 2],
  ];
  const cs = Math.max(2, Math.round(seg / 8));
  for (const [cx, cz, a0] of corners)
    for (let i = 0; i <= cs; i++) {
      const a = a0 + (i / cs) * (Math.PI / 2);
      pts.push(new THREE.Vector2(p.x + cx + Math.cos(a) * p.r, -(p.z + cz + Math.sin(a) * p.r)));
    }
  return [pts];
}

function shapeOf(p: Patch) {
  const [outer, hole] = outline(p);
  const s = new THREE.Shape(outer);
  if (hole) s.holes.push(new THREE.Path(hole));
  return s;
}

/** Flat patches at height y (one geometry, planar uvs in metres). */
export function patchGeometry(list: Patch[], y: number) {
  const parts = list.map((p) => {
    const g = new THREE.ShapeGeometry(shapeOf(p), 12);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    // uvs in metres, world-aligned (the shape's own uvs are (x, -z))
    const pos = g.attributes.position as THREE.BufferAttribute;
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
    return g;
  });
  const g = mergeGeometries(parts)!;
  parts.forEach((q) => q.dispose());
  return g;
}

/**
 * A flat polygon at height y from world (x, z) points, with optional holes
 * (planar uvs in metres): e.g. the paved plaza, or the meadow round it.
 */
export function polygonGeometry(outer: [number, number][], holes: [number, number][][] = [], y = 0) {
  const s = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) s.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
  return g;
}

/** A stone curb around each patch: `w` wide, `h` tall, its outer face on the patch edge. */
export function curbGeometry(list: Patch[], w = 0.2, h = 0.12) {
  const parts: THREE.BufferGeometry[] = [];
  for (const p of list) {
    const edges: Patch[] = p.kind === 'ring' ? [{ kind: 'ring', x: p.x, z: p.z, r0: p.r1 - w, r1: p.r1 }, { kind: 'ring', x: p.x, z: p.z, r0: p.r0, r1: p.r0 + w }] : [{ ...p }];
    for (const e of edges) {
      const s = p.kind === 'ring' ? shapeOf(e) : (() => {
        const sh = shapeOf(e);
        sh.holes.push(new THREE.Path(outline(inset(e, w))[0].reverse()));
        return sh;
      })();
      const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 12 });
      g.rotateX(-Math.PI / 2);
      g.deleteAttribute('uv');
      parts.push(g);
    }
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((q) => q.dispose());
  return g;
}

// ---------------------------------------------------------------- materials

/** Soft world-space variation for big surfaces (one noise, no repeats). */
function macro(m: THREE.MeshStandardMaterial, key: string, glsl: string) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGround = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec2 vGround;\n${LAWN_GLSL}`).replace('#include <map_fragment>', `#include <map_fragment>\n${glsl}`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

export interface PavingOpts {
  /** metres covered by one texture tile */
  tile: number;
  /** slab colour range (css) */
  base: string;
  grout: string;
  /** slabs across and down the tile */
  cols: number;
  rows: number;
}

/**
 * Large-format paving: slabs in a running bond, each a slightly different
 * shade, fine grit, a little wear, grooved grout (normal map) that's rougher
 * than the slabs (roughness map).
 */
export function pavingMaterial(o: PavingOpts) {
  const S = 512;
  const sw = S / o.cols,
    sh = S / o.rows;
  const slabs: [number, number, number, number, number][] = [];
  const rand = Math.random;
  for (let j = 0; j < o.rows; j++)
    for (let i = -1; i < o.cols; i++) {
      const x = i * sw + (j % 2 ? sw / 2 : 0);
      slabs.push([x, j * sh, sw, sh, rand()]);
    }
  const gw = 2;
  const color = canvasTex(S, S, (x) => {
    x.fillStyle = o.grout;
    x.fillRect(0, 0, S, S);
    const base = new THREE.Color(o.base);
    for (const [sx, sy, w, h, r] of slabs) {
      const k = base.clone().offsetHSL((r - 0.5) * 0.012, (r - 0.5) * 0.04, (r - 0.5) * 0.045);
      x.fillStyle = `#${k.getHexString()}`;
      for (const dx of [0, S]) x.fillRect(sx + gw / 2 + dx, sy + gw / 2, w - gw, h - gw);
      for (const dx of [0, -S]) x.fillRect(sx + gw / 2 + dx, sy + gw / 2, w - gw, h - gw);
    }
    // grit
    for (let i = 0; i < 14000; i++) {
      const v = rand() < 0.5 ? 255 : 90;
      x.fillStyle = `rgba(${v},${v},${v},${rand() * 0.07})`;
      x.fillRect(rand() * S, rand() * S, 1.5, 1.5);
    }
    // a little wear: soft darker smudges (drawn wrapped so the tile stays seamless)
    for (let i = 0; i < 7; i++) {
      const cx = rand() * S,
        cy = rand() * S,
        r = 30 + rand() * 70;
      for (const [dx, dy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
        const g = x.createRadialGradient(cx + dx, cy + dy, 0, cx + dx, cy + dy, r);
        g.addColorStop(0, 'rgba(120,105,90,0.07)');
        g.addColorStop(1, 'rgba(120,105,90,0)');
        x.fillStyle = g;
        x.fillRect(cx + dx - r, cy + dy - r, r * 2, r * 2);
      }
    }
  });
  // height: slabs up, grout down, slightly rounded arrises
  const hc = document.createElement('canvas');
  hc.width = hc.height = S;
  const hx = hc.getContext('2d')!;
  hx.fillStyle = '#000';
  hx.fillRect(0, 0, S, S);
  hx.filter = 'blur(1.2px)';
  for (const [sx, sy, w, h, r] of slabs) {
    const v = 200 + Math.floor(r * 40);
    hx.fillStyle = `rgb(${v},${v},${v})`;
    for (const dx of [0, S, -S]) hx.fillRect(sx + gw + dx, sy + gw, w - gw * 2, h - gw * 2);
  }
  const hd = hx.getImageData(0, 0, S, S).data;
  const H = (i: number, j: number) => hd[(((j + S) % S) * S + ((i + S) % S)) * 4] / 255;
  const normal = canvasTex(
    S,
    S,
    (x) => {
      const img = x.createImageData(S, S);
      const d = img.data;
      const k = 2.2;
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          const nx = (H(i - 1, j) - H(i + 1, j)) * k,
            ny = (H(i, j + 1) - H(i, j - 1)) * k;
          const l = Math.hypot(nx, ny, 1);
          const o4 = (j * S + i) * 4;
          d[o4] = (nx / l) * 127.5 + 127.5;
          d[o4 + 1] = (ny / l) * 127.5 + 127.5;
          d[o4 + 2] = (1 / l) * 127.5 + 127.5;
          d[o4 + 3] = 255;
        }
      x.putImageData(img, 0, 0);
    },
    false,
  );
  const rough = canvasTex(
    S,
    S,
    (x) => {
      x.fillStyle = 'rgb(255,255,255)';
      x.fillRect(0, 0, S, S);
      for (const [sx, sy, w, h, r] of slabs) {
        const v = 190 + Math.floor(r * 50);
        x.fillStyle = `rgb(${v},${v},${v})`;
        for (const dx of [0, S, -S]) x.fillRect(sx + gw + dx, sy + gw, w - gw * 2, h - gw * 2);
      }
    },
    false,
  );
  for (const t of [color, normal, rough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / o.tile, 1 / o.tile);
    t.anisotropy = 8;
  }
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', map: color, normalMap: normal, normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: rough, roughness: 1, metalness: 0 });
  // big soft light/dark drifts across the plaza, so the tiling never lines up
  return macro(m, 'paving-macro', 'diffuseColor.rgb *= 0.95 + 0.09 * lawnNoise(vGround * 0.045) - 0.03 * lawnNoise(vGround * 0.17 + 3.1);');
}

/** Lawn: fine mottling and faint mowing stripes, tinted by the same patches as the grass on it. */
export function lawnMaterial(base: THREE.ColorRepresentation, o: { stripe?: number; tile?: number } = {}) {
  const S = 256;
  const tex = canvasTex(S, S, (x) => {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, S, S);
    // mowing stripes: two bands per tile
    x.fillStyle = `rgba(0,40,0,${o.stripe ?? 0.06})`;
    x.fillRect(0, 0, S / 2, S);
    for (let i = 0; i < 5000; i++) {
      const v = Math.random() < 0.5 ? 255 : 0;
      x.fillStyle = `rgba(${v},${v},${Math.random() < 0.5 ? v : 60},${Math.random() * 0.08})`;
      x.fillRect(Math.random() * S, Math.random() * S, 2, 3);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const t = o.tile ?? 6;
  tex.repeat.set(1 / t, 1 / t);
  const m = new THREE.MeshStandardMaterial({ color: base, map: tex, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  return macro(m, 'lawn-macro', 'diffuseColor.rgb *= lawnTint(vGround);');
}
