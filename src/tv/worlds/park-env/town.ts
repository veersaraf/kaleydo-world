// A modern town of glass and pale stone: towers, mid-rise blocks and setbacks
// with parapets and plant rooms on their roofs.
//
// Facades come in three styles (a blue curtain wall, punched windows, ribbon
// windows), each one small painted texture with a matching roughness map, so
// glass catches the light and walls don't. Walls get uvs in metres, so windows
// keep their size on any block, and a pastel tint in their vertex colours: every
// block of a style shares one material and the static batcher draws the whole
// town in four calls (three facades and the roofs).

import * as THREE from 'three';
import { canvasTex } from '../mats';

export type FacadeStyle = 'glass' | 'punched' | 'ribbon';

interface Tile {
  /** metres one texture tile covers */
  w: number;
  h: number;
  color: THREE.Texture;
  rough: THREE.Texture;
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

/** Paint one facade style: colour and roughness (glass smooth, frames and walls matte). */
function paint(style: FacadeStyle, seed: number): Tile {
  const S = 256;
  const rand = mulberry(seed);
  // [x, y, w, h] of every pane (canvas pixels), filled per style below
  const panes: [number, number, number, number][] = [];
  let frame = '#e8edf3';
  let w = 6,
    h = 8;
  if (style === 'glass') {
    // two 4 m floors, three 2 m panes each, a slim spandrel between floors
    for (let f = 0; f < 2; f++) for (let i = 0; i < 3; i++) panes.push([i * 85.3 + 3, f * 128 + 14, 79, 110]);
  } else if (style === 'punched') {
    frame = '#ffffff';
    h = 7;
    for (let f = 0; f < 2; f++) for (let i = 0; i < 2; i++) panes.push([i * 128 + 30, f * 128 + 30, 68, 74]);
  } else {
    frame = '#fafafa';
    w = 8;
    h = 7;
    // a continuous band of glass per floor, split by thin mullions
    for (let f = 0; f < 2; f++) for (let i = 0; i < 5; i++) panes.push([i * 51.2 + 1.5, f * 128 + 44, 48, 70]);
  }
  const glass = (x: CanvasRenderingContext2D, [px, py, pw, ph]: [number, number, number, number]) => {
    const g = x.createLinearGradient(0, py, 0, py + ph);
    const k = 0.92 + rand() * 0.16;
    const top = new THREE.Color('#c6def2').multiplyScalar(k);
    const bot = new THREE.Color(style === 'ribbon' ? '#6f95bd' : '#7aa2cc').multiplyScalar(k);
    g.addColorStop(0, `#${top.getHexString()}`);
    g.addColorStop(1, `#${bot.getHexString()}`);
    x.fillStyle = g;
    x.fillRect(px, py, pw, ph);
    // a soft diagonal reflection
    x.fillStyle = 'rgba(255,255,255,0.12)';
    x.beginPath();
    x.moveTo(px + pw * 0.15, py);
    x.lineTo(px + pw * 0.55, py);
    x.lineTo(px + pw * 0.15, py + ph * 0.7);
    x.lineTo(px, py + ph * 0.7);
    x.lineTo(px, py + ph * 0.25);
    x.closePath();
    x.fill();
  };
  const color = canvasTex(S, S, (x) => {
    x.fillStyle = frame;
    x.fillRect(0, 0, S, S);
    for (const p of panes) glass(x, p);
    if (style === 'punched')
      for (const [px, py, pw, ph] of panes) {
        // sills and reveals
        x.fillStyle = 'rgba(0,0,0,0.12)';
        x.fillRect(px - 4, py + ph, pw + 8, 5);
        x.fillStyle = 'rgba(0,0,0,0.06)';
        x.fillRect(px - 3, py - 3, pw + 6, 3);
      }
    else {
      // floor slabs
      x.fillStyle = 'rgba(0,0,0,0.07)';
      for (let f = 0; f < 2; f++) x.fillRect(0, f * 128 + (style === 'glass' ? 4 : 34), S, 4);
    }
  });
  const rough = canvasTex(
    S,
    S,
    (x) => {
      x.fillStyle = 'rgb(220,220,220)';
      x.fillRect(0, 0, S, S);
      x.fillStyle = 'rgb(70,70,70)';
      for (const [px, py, pw, ph] of panes) x.fillRect(px, py, pw, ph);
    },
    false,
  );
  for (const t of [color, rough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { w, h, color, rough };
}

export interface Block {
  x: number;
  z: number;
  /** footprint and height, metres */
  w: number;
  d: number;
  h: number;
  /** turn about y */
  yaw: number;
  style: FacadeStyle;
  tint: THREE.Color;
  /** a narrower tier on top: its height (0 = none) */
  tier?: number;
}

/** Four walls of a box with uvs in tile units (u along each wall, v up), and a tint. */
function walls(w: number, d: number, y0: number, y1: number, tile: Tile, tint: THREE.Color, uOffset: number) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const hw = w / 2,
    hd = d / 2;
  // corners going round: each wall runs from one to the next
  const c: [number, number][] = [
    [hw, hd],
    [hw, -hd],
    [-hw, -hd],
    [-hw, hd],
  ];
  let u0 = uOffset;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i];
    const [bx, bz] = c[(i + 1) % 4];
    const len = Math.hypot(bx - ax, bz - az);
    const nx = (bz - az) / len,
      nz = -(bx - ax) / len;
    const u1 = u0 + len / tile.w;
    const v0 = y0 / tile.h,
      v1 = y1 / tile.h;
    // two triangles, outward-facing
    const quad = [
      [ax, y0, az, u0, v0],
      [bx, y0, bz, u1, v0],
      [bx, y1, bz, u1, v1],
      [ax, y0, az, u0, v0],
      [bx, y1, bz, u1, v1],
      [ax, y1, az, u0, v1],
    ];
    for (const [x, y, z, u, v] of quad) {
      pos.push(x, y, z);
      nrm.push(-nx, 0, -nz);
      uv.push(u, v);
      col.push(tint.r, tint.g, tint.b);
    }
    u0 = u1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** A plain box for roofs and rooftop clutter (tinted, no uvs). */
function box(w: number, h: number, d: number, x: number, y: number, z: number, tint: THREE.Color) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.deleteAttribute('uv');
  g.translate(x, y, z);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([tint.r, tint.g, tint.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Aerial perspective for a backdrop: blend towards the sky's haze with distance,
 * well before the scene's fog, so the town steps back behind what's in front.
 */
function haze<M extends THREE.Material>(m: M, color: THREE.Color, near: number, far: number, amount: number) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHaze = { value: color };
    sh.uniforms.uHazeK = { value: new THREE.Vector3(near, far, amount) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHazeW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvHazeW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHazeW;\nuniform vec3 uHaze;\nuniform vec3 uHazeK;')
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, uHazeK.z * smoothstep(uHazeK.x, uHazeK.y, distance(vHazeW, cameraPosition)));\n#include <fog_fragment>');
  };
  m.customProgramCacheKey = () => 'town-haze';
  return m;
}

export interface TownOpts {
  seed?: number;
  /** the sky's colour at the horizon, and how far off the haze starts, is full, and how much */
  haze?: { color: THREE.Color; near: number; far: number; amount: number };
}

/**
 * The blocks as plain meshes (one per block and material: the world's static
 * batcher merges them into four draws). Returns the roofs that could hold a
 * garden: top centre and free size, for the caller to plant.
 */
export function town(blocks: Block[], o: TownOpts = {}) {
  const seed = o.seed ?? 1;
  const rand = mulberry(seed);
  const tiles: Record<FacadeStyle, Tile> = { glass: paint('glass', seed + 1), punched: paint('punched', seed + 2), ribbon: paint('ribbon', seed + 3) };
  const hz = o.haze;
  const hazy = <M extends THREE.Material>(m: M) => (hz ? haze(m, hz.color, hz.near, hz.far, hz.amount) : m);
  const mats = {} as Record<FacadeStyle, THREE.MeshStandardMaterial>;
  for (const k of Object.keys(tiles) as FacadeStyle[]) mats[k] = hazy(new THREE.MeshStandardMaterial({ map: tiles[k].color, roughnessMap: tiles[k].rough, roughness: 1, metalness: 0, vertexColors: true }));
  const roofMat = hazy(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, metalness: 0, vertexColors: true }));
  const out: THREE.Mesh[] = [];
  const gardens: { x: number; z: number; y: number; w: number; d: number; yaw: number }[] = [];
  const roofTint = new THREE.Color('#e2e5ea');
  const plant = new THREE.Color('#cfd4dc');
  for (const b of blocks) {
    const g = new THREE.Group();
    g.position.set(b.x, 0, b.z);
    g.rotation.y = b.yaw;
    const tile = tiles[b.style];
    const tint = b.tint;
    // a random start along the facade pattern, so neighbours don't line up
    const u0 = Math.floor(rand() * 4) * 0.5;
    // (no receiveShadow: a backdrop this far out is beyond any sun shadow map,
    // and the lookups would still cost every one of its pixels)
    const wall = new THREE.Mesh(walls(b.w, b.d, 0, b.h, tile, tint, u0), mats[b.style]);
    g.add(wall);
    const parts: THREE.BufferGeometry[] = [];
    // roof slab and parapet
    parts.push(box(b.w, 0.3, b.d, 0, b.h - 0.14, 0, roofTint));
    const pt = 0.35,
      ph = 0.9;
    parts.push(box(b.w + 0.1, ph, pt, 0, b.h + ph / 2, b.d / 2 - pt / 2, tint), box(b.w + 0.1, ph, pt, 0, b.h + ph / 2, -b.d / 2 + pt / 2, tint));
    parts.push(box(pt, ph, b.d - 2 * pt, b.w / 2 - pt / 2, b.h + ph / 2, 0, tint), box(pt, ph, b.d - 2 * pt, -b.w / 2 + pt / 2, b.h + ph / 2, 0, tint));
    let top = b.h;
    if (b.tier) {
      // a setback tier: narrower walls of the same facade, with its own parapet
      const tw = b.w * (0.55 + rand() * 0.2),
        td = b.d * (0.55 + rand() * 0.2);
      const ox = (rand() - 0.5) * (b.w - tw) * 0.8,
        oz = (rand() - 0.5) * (b.d - td) * 0.8;
      const tierWalls = new THREE.Mesh(walls(tw, td, b.h, b.h + b.tier, tile, tint, u0), mats[b.style]);
      tierWalls.position.set(ox, 0, oz);
      g.add(tierWalls);
      parts.push(box(tw, 0.3, td, ox, b.h + b.tier - 0.14, oz, roofTint));
      parts.push(box(tw + 0.1, ph, pt, ox, b.h + b.tier + ph / 2, oz + td / 2 - pt / 2, tint), box(tw + 0.1, ph, pt, ox, b.h + b.tier + ph / 2, oz - td / 2 + pt / 2, tint));
      top = b.h + b.tier;
    }
    // plant rooms on the highest roof, or a garden on a low, wide one
    if (!b.tier && b.h < 24 && b.w > 12 && b.d > 10) gardens.push({ x: b.x, z: b.z, y: b.h, w: b.w - 2, d: b.d - 2, yaw: b.yaw });
    else {
      const n = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < n; i++) {
        const w = 2.5 + rand() * 3,
          d = 2.5 + rand() * 3,
          h = 1.8 + rand() * 2.2;
        parts.push(box(w, h, d, (rand() - 0.5) * 4, top + h / 2, (rand() - 0.5) * 4, plant));
      }
    }
    const roof = new THREE.Mesh(joinBoxes(parts), roofMat);
    g.add(roof);
    g.updateMatrixWorld(true);
    for (const m of [...g.children] as THREE.Mesh[]) {
      m.geometry.applyMatrix4(m.matrixWorld);
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      m.updateMatrix();
      out.push(m);
    }
  }
  return { meshes: out, gardens };
}

function joinBoxes(parts: THREE.BufferGeometry[]) {
  // (all non-indexed-compatible: BoxGeometry is indexed; merge keeps that)
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const idx: number[] = [];
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    nrm.set(p.attributes.normal.array as Float32Array, o * 3);
    col.set(p.attributes.color.array as Float32Array, o * 3);
    for (const i of p.index!.array as Uint16Array) idx.push(i + o);
    o += p.attributes.position.count;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
