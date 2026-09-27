// Sky dressing: soft cumulus clouds, rolling hills on the horizon and a hazy
// skyline beyond the town.
//
//  • Clouds are camera-facing cards (one instanced draw) cut from a painted
//    atlas: puffs with sunlit tops and cool grey bellies, so they read as
//    volumes. They orbit the park slowly, so they drift across every view and
//    never pop at a wrap-around; low ones sink into the horizon haze.
//  • Hills and skyline are plain unlit silhouettes with baked gradients that
//    the scene fog hazes: two cheap draws that close off the horizon.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

// ---------------------------------------------------------------- clouds

/** 4 cloud shapes in a 2×2 atlas (512×256 each): shaded bellies, then lit tops. */
function cloudAtlas(seed: number, shade: string, lit: string) {
  const rand = mulberry(seed);
  return canvasTex(1024, 512, (x) => {
    x.clearRect(0, 0, 1024, 512);
    for (let c = 0; c < 4; c++) {
      const ox = (c % 2) * 512,
        oy = Math.floor(c / 2) * 256;
      x.save();
      x.beginPath();
      x.rect(ox, oy, 512, 256);
      x.clip();
      // a dome of puffs along a flat base: big in the middle, small at the ends
      const puffs: [number, number, number][] = [];
      const n = 11 + Math.floor(rand() * 6);
      const flat = c === 3; // one long, flat one
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const hump = Math.sin(u * Math.PI);
        const r = (flat ? 30 : 32) + hump * (flat ? 30 : 52) * (0.7 + rand() * 0.5);
        const px = ox + 70 + u * 372 + (rand() - 0.5) * 24;
        const py = oy + 200 - r * (flat ? 0.45 : 0.62) - hump * (flat ? 6 : 20) * rand();
        puffs.push([px, py, r]);
      }
      // a few puffs on top for a cauliflower crown
      if (!flat)
        for (let i = 0; i < 4; i++) {
          const u = 0.3 + rand() * 0.4;
          puffs.push([ox + 70 + u * 372, oy + 100 + rand() * 24, 28 + rand() * 22]);
        }
      const puff = (px: number, py: number, r: number, col: string, a: number) => {
        const g = x.createRadialGradient(px, py, r * 0.15, px, py, r);
        g.addColorStop(0, `rgba(${col},${a})`);
        g.addColorStop(0.55, `rgba(${col},${a * 0.9})`);
        g.addColorStop(1, `rgba(${col},0)`);
        x.fillStyle = g;
        x.beginPath();
        x.arc(px, py, r, 0, Math.PI * 2);
        x.fill();
      };
      // the belly first (shade), then the same puffs lit, shifted up: grey stays underneath
      for (const [px, py, r] of puffs) puff(px, py + r * 0.12, r * 1.02, shade, 0.9);
      for (const [px, py, r] of puffs) puff(px, py - r * 0.1, r * 0.9, lit, 0.95);
      // a flat, soft base
      const base = x.createLinearGradient(0, oy + 170, 0, oy + 220);
      base.addColorStop(0, 'rgba(0,0,0,0)');
      base.addColorStop(1, 'rgba(0,0,0,1)');
      x.globalCompositeOperation = 'destination-out';
      x.fillStyle = base;
      x.fillRect(ox, oy + 170, 512, 86);
      x.globalCompositeOperation = 'source-over';
      x.restore();
    }
  });
}

const CLOUD_VERT = /* glsl */ `
attribute vec4 aOrbit;  // radius, start angle, height, angular speed
attribute vec3 aCard;   // width, height, atlas cell
uniform float uTime;
varying vec2 vUv;
varying float vHaze;
void main() {
  float a = aOrbit.y + uTime * aOrbit.w;
  vec3 c = (modelMatrix * vec4(cos(a) * aOrbit.x, aOrbit.z, sin(a) * aOrbit.x, 1.0)).xyz;
  // face the camera, but stay upright
  vec3 to = cameraPosition - c;
  vec3 right = normalize(vec3(to.z, 0.0, -to.x));
  vec3 wp = c + right * position.x * aCard.x + vec3(0.0, position.y * aCard.y, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  float cell = aCard.z;
  vUv = (vec2(mod(cell, 2.0), floor(cell / 2.0)) + vec2(position.x + 0.5, 1.0 - position.y)) * 0.5;
  vUv.y = 1.0 - vUv.y;
  // near the horizon clouds sink into the haze
  vHaze = 1.0 - smoothstep(0.0, 0.16, normalize(c - cameraPosition).y);
}`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D tAtlas;
uniform vec3 uLit;
uniform vec3 uHaze;
uniform float uOpacity;
varying vec2 vUv;
varying float vHaze;
void main() {
  vec4 t = texture2D(tAtlas, vUv);
  vec3 col = mix(t.rgb * uLit, uHaze, vHaze * 0.55);
  gl_FragColor = vec4(col, t.a * uOpacity * (1.0 - vHaze * 0.25));
}`;

export interface CloudOpts {
  count: number;
  /** orbit radius range, metres */
  radius: [number, number];
  /** height range */
  height: [number, number];
  /** card width range (height is about 0.45 of it) */
  size: [number, number];
  /** m/s along the orbit */
  speed?: number;
  haze: THREE.Color;
  seed?: number;
  /** keep clear of this sector (angle range, radians): e.g. behind the main camera */
  avoid?: [number, number];
  /** the painted bellies' and tops' colours ('r,g,b' 0–255): a cool grey under white by default */
  shade?: string;
  lit?: string;
}

export class Clouds {
  mesh: THREE.Mesh;
  u = { uTime: { value: 0 }, tAtlas: { value: null as THREE.Texture | null }, uLit: { value: new THREE.Color(1.05, 1.05, 1.05) }, uHaze: { value: new THREE.Color() }, uOpacity: { value: 1 } };
  private geo: THREE.InstancedBufferGeometry;
  private n: number;

  constructor(o: CloudOpts) {
    const rand = mulberry(o.seed ?? 5);
    this.u.tAtlas.value = cloudAtlas(o.seed ?? 5, o.shade ?? '198,211,230', o.lit ?? '255,255,255');
    this.u.uHaze.value.copy(o.haze);
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    const orbit = new Float32Array(o.count * 4);
    const card = new Float32Array(o.count * 3);
    // far and low first: cards are blended in this order
    const list: number[][] = [];
    for (let i = 0; i < o.count; i++) {
      const r = o.radius[0] + (o.radius[1] - o.radius[0]) * rand();
      let a = rand() * Math.PI * 2;
      if (o.avoid && a > o.avoid[0] && a < o.avoid[1]) a = o.avoid[1] + rand() * (Math.PI * 2 - (o.avoid[1] - o.avoid[0]));
      const hgt = o.height[0] + (o.height[1] - o.height[0]) * Math.pow(rand(), 1.5);
      const w = o.size[0] + (o.size[1] - o.size[0]) * rand();
      const sp = ((o.speed ?? 1.2) * (0.7 + rand() * 0.6)) / r;
      list.push([r, a, hgt, sp, w, w * (0.42 + rand() * 0.12), Math.floor(rand() * 4)]);
    }
    list.sort((p, q) => q[0] - p[0]);
    list.forEach((c, i) => {
      orbit.set(c.slice(0, 4), i * 4);
      card.set(c.slice(4, 7), i * 3);
    });
    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
    geo.setAttribute('aCard', new THREE.InstancedBufferAttribute(card, 3));
    geo.instanceCount = o.count;
    this.geo = geo;
    this.n = o.count;
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.u,
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    // far behind everything, drawn first among the see-through things
    this.mesh.renderOrder = -5;
    this.mesh.frustumCulled = false;
    this.mesh.userData.noBatch = true;
  }

  tick(t: number) {
    this.u.uTime.value = t;
  }

  /** Fewer clouds at low detail (the far, low ones go first: they were added first, so keep the tail). */
  setDetail(d: number) {
    this.geo.instanceCount = Math.round(this.n * (0.4 + 0.6 * d));
  }
}

// ---------------------------------------------------------------- hills and skyline

export interface HillRing {
  radius: number;
  /** base height and how much the bumps add */
  height: [number, number];
  /** colour at the foot and at the crest (the fog hazes both) */
  foot: THREE.Color;
  crest: THREE.Color;
  seed?: number;
  /** how many bumps around */
  bumps?: number;
}

/** Rolling hill silhouettes all around (one mesh; `mat` should use vertex colours and fog). */
export function hills(mat: THREE.Material, rings: HillRing[]) {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const seg = 360;
  for (const ring of rings) {
    const rand = mulberry(ring.seed ?? 3);
    const nb = ring.bumps ?? 14;
    const bumps = Array.from({ length: nb }, () => [rand() * Math.PI * 2, 0.18 + rand() * 0.35, 0.4 + rand() * 0.6] as const);
    const v0 = pos.length / 3;
    const rows = 4;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      let h = 0;
      // soft round humps (a raised cosine each), overlapping
      for (const [c, w, amp] of bumps) {
        let d = Math.abs(a - c);
        d = Math.min(d, Math.PI * 2 - d);
        if (d < w) h += amp * (0.5 + 0.5 * Math.cos((d / w) * Math.PI));
      }
      h = ring.height[0] + Math.min(1.3, h) * ring.height[1];
      const x = Math.cos(a) * ring.radius,
        z = Math.sin(a) * ring.radius;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        // the foot sinks below the ground so no gap shows at the horizon
        pos.push(x, -6 + (h + 6) * t, z);
        const k = ring.foot.clone().lerp(ring.crest, Math.pow(t, 0.7));
        col.push(k.r, k.g, k.b);
      }
    }
    for (let i = 0; i < seg; i++)
      for (let r = 0; r < rows; r++) {
        const a = v0 + i * (rows + 1) + r,
          b = a + rows + 1;
        // facing the park (inwards)
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  return m;
}

export interface SkylineOpts {
  /** angular sector (radians, around the y axis from +x towards +z) */
  from: number;
  to: number;
  radius: [number, number];
  count: number;
  /** tower size ranges: width, height */
  width: [number, number];
  height: [number, number];
  /** base colour; sunlit faces a touch lighter */
  color: THREE.Color;
  sunDir: THREE.Vector3;
  seed?: number;
}

/** A distant skyline of plain towers (one mesh; `mat` should use vertex colours and fog). */
export function skyline(mat: THREE.Material, o: SkylineOpts) {
  const rand = mulberry(o.seed ?? 9);
  const parts: THREE.BufferGeometry[] = [];
  const k = new THREE.Color();
  const n = new THREE.Vector3();
  const sun = o.sunDir.clone().setY(0).normalize();
  for (let i = 0; i < o.count; i++) {
    const a = o.from + (o.to - o.from) * rand();
    const r = o.radius[0] + (o.radius[1] - o.radius[0]) * rand();
    const w = o.width[0] + (o.width[1] - o.width[0]) * rand();
    const h = o.height[0] + (o.height[1] - o.height[0]) * Math.pow(rand(), 1.6);
    const b = new THREE.BoxGeometry(w, h, w * (0.6 + rand() * 0.6));
    b.deleteAttribute('uv');
    b.translate(0, h / 2 - 2, 0).rotateY(-a + Math.PI / 2 + (rand() - 0.5) * 0.4).translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    const pos = b.attributes.position as THREE.BufferAttribute;
    const nrm = b.attributes.normal as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const tint = 0.94 + rand() * 0.12;
    for (let v = 0; v < pos.count; v++) {
      n.fromBufferAttribute(nrm, v);
      // sunlit faces lighter, roofs lightest, the rest in the haze's shade
      const lit = n.y > 0.5 ? 1.1 : 0.9 + Math.max(0, n.dot(sun)) * 0.18;
      k.copy(o.color).multiplyScalar(lit * tint);
      col.set([k.r, k.g, k.b], v * 3);
    }
    b.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // (unlit: the normals were only for baking the shading, and without them the
    // skyline merges with the hills)
    b.deleteAttribute('normal');
    parts.push(b);
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  return m;
}
