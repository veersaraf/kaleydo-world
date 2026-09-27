// The range's moving parts, rebuilt every frame from the view: instanced
// parts (with their outline hulls), the light trails behind flying arrows, and
// the wind flags. See venue.ts, which owns them.

import * as THREE from 'three';
import { outlineMaterial } from '../render/outline';
import { NOISE } from '../render/glsl';

/** arrow trails: how many at once, and the points each keeps */
const MAX_TRAILS = 8;
const TRAIL_N = 24;

// ---------------------------------------------------------------- instanced parts

/** An InstancedMesh (and its outline hull, sharing the instance matrices) that's refilled every frame. */
export class Inst {
  mesh: THREE.InstancedMesh;
  hull: THREE.InstancedMesh | null = null;
  n = 0;
  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    readonly max: number,
    name: string,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  outline(o: { color: THREE.Color; width: number; emissive?: number } | null, scale = 1) {
    if (!o || scale <= 0) return this;
    const h = new THREE.InstancedMesh(this.mesh.geometry, outlineMaterial(o.color, o.width * scale, { emissive: o.emissive }), this.max);
    h.instanceMatrix = this.mesh.instanceMatrix;
    h.name = 'outline';
    h.frustumCulled = false;
    h.count = 0;
    h.castShadow = false;
    this.hull = h;
    this.mesh.add(h);
    return this;
  }

  begin() {
    this.n = 0;
  }

  /** Add an instance with this matrix (ignored past the limit). Returns its index, or −1. */
  push(m: THREE.Matrix4) {
    if (this.n >= this.max) return -1;
    this.mesh.setMatrixAt(this.n, m);
    return this.n++;
  }

  end() {
    const n = this.n;
    this.mesh.count = n;
    if (this.hull) this.hull.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    // upload only the instances in use
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, n * 16);
    im.needsUpdate = true;
    const ic = this.mesh.instanceColor;
    if (ic) {
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, n * 3);
      ic.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.dispose();
    this.hull?.dispose();
  }
}

// ---------------------------------------------------------------- arrow trails

const TRAIL_VERT = /* glsl */ `
attribute vec3 aTan; attribute vec3 aC; attribute vec2 aS;
uniform float uWidth;
varying float vU; varying float vSide; varying vec3 vC;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 toCam = cameraPosition - wp.xyz;
  float dist = length(toCam);
  vec3 side = cross(aTan, toCam / max(dist, 1e-4));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  // thin at the tail, and a little wider far away so it still reads down the range
  float w = uWidth * (1.0 - 0.8 * aS.y) * (1.0 + 0.035 * max(0.0, dist - 8.0));
  wp.xyz += side * aS.x * w;
  vU = aS.y; vSide = aS.x; vC = aC;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const TRAIL_FRAG = /* glsl */ `
uniform vec3 uCore; uniform float uOpacity; uniform int uMode;
varying float vU; varying float vSide; varying vec3 vC;
${NOISE}
void main() {
  float edge = 1.0 - abs(vSide);
  float a = pow(max(0.0, 1.0 - vU), 1.4) * smoothstep(0.0, 0.45, edge);
  vec3 col = mix(vC, uCore, smoothstep(0.45, 0.95, edge) * (1.0 - vU * 0.7));
  if (uMode == 1) {
    // a dry brush stroke
    float streak = vnoise(vec2(vSide * 5.0 + 3.0, vU * 9.0));
    a *= smoothstep(0.2 + vU * 0.5, 0.5 + vU * 0.4, streak + edge * 0.45);
  } else if (uMode == 2) {
    // pixel steps
    a = step(0.35, a) * step(fract(vU * 7.0), 0.75);
  } else if (uMode == 3) {
    a = step(0.3, a);
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a * uOpacity);
}`;

export interface TrailStyle {
  core: string;
  /** how much of the archer's colour the trail takes, over `base` (white unless given) */
  tint: number;
  base?: string;
  hdr: number;
  opacity: number;
  /** 0 smooth, 1 dry brush, 2 pixel steps, 3 hard-edged */
  mode: number;
  additive: boolean;
  width: number;
}

export function trailStyle(world: string): TrailStyle {
  switch (world) {
    case 'ink':
      // a stroke of ink (dark survives the ink pass as a brush stroke)
      return { core: '#15120f', tint: 0, base: '#2a2622', hdr: 1, opacity: 0.9, mode: 1, additive: false, width: 0.05 };
    case 'neon':
      return { core: '#ffffff', tint: 0.85, hdr: 2.4, opacity: 0.95, mode: 0, additive: true, width: 0.05 };
    case 'cosmic':
      return { core: '#e8fbff', tint: 0.7, hdr: 2.0, opacity: 0.9, mode: 0, additive: true, width: 0.05 };
    case 'pixel':
      return { core: '#fff1e8', tint: 1, hdr: 1, opacity: 1, mode: 2, additive: false, width: 0.06 };
    case 'paper':
    case 'plaza':
      return { core: '#ffffff', tint: 0.45, hdr: 1, opacity: 0.92, mode: 3, additive: false, width: 0.045 };
    case 'water':
      return { core: '#ffffff', tint: 0.5, hdr: 1, opacity: 0.6, mode: 0, additive: false, width: 0.05 };
    default:
      return { core: '#ffffff', tint: 0.45, hdr: 1, opacity: 0.85, mode: 0, additive: false, width: 0.042 };
  }
}

export const WHITE = new THREE.Color('#ffffff');

/**
 * The light trails behind flying arrows: one ribbon per arrow (up to
 * MAX_TRAILS), all in one mesh, turned to face the camera in the vertex
 * shader. A trail keeps the last quarter second of an arrow's flight and
 * fades out once it has landed.
 */
export class Trails {
  mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 3);
  private tan = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 3);
  private col = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 3);
  private sd = new Float32Array(MAX_TRAILS * TRAIL_N * 2 * 2);
  private mat: THREE.ShaderMaterial;
  /** per trail: its points (newest first) and their ages */
  private pts: Float32Array[] = [];
  private age: Float32Array[] = [];
  private count = new Int32Array(MAX_TRAILS);
  private owner = new Int32Array(MAX_TRAILS).fill(-1);
  private color: THREE.Color[] = [];
  private tint: number;
  private hdr: number;
  private base: THREE.Color;
  private attrs: THREE.BufferAttribute[] = [];
  private static LIFE = 0.26;

  constructor(style: TrailStyle) {
    this.tint = style.tint;
    this.hdr = style.hdr;
    this.base = new THREE.Color(style.base ?? '#ffffff');
    for (let i = 0; i < MAX_TRAILS; i++) {
      this.pts.push(new Float32Array(TRAIL_N * 3));
      this.age.push(new Float32Array(TRAIL_N));
      this.color.push(new THREE.Color());
    }
    const idx: number[] = [];
    for (let t = 0; t < MAX_TRAILS; t++)
      for (let j = 0; j < TRAIL_N - 1; j++) {
        const a = (t * TRAIL_N + j) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    const dyn = (arr: Float32Array, n: number) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', dyn(this.pos, 3));
    this.geo.setAttribute('aTan', dyn(this.tan, 3));
    this.geo.setAttribute('aC', dyn(this.col, 3));
    this.geo.setAttribute('aS', dyn(this.sd, 2));
    this.geo.setIndex(idx);
    for (const k of ['position', 'aTan', 'aC', 'aS']) this.attrs.push(this.geo.attributes[k] as THREE.BufferAttribute);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uWidth: { value: style.width },
        uCore: { value: new THREE.Color(style.core).multiplyScalar(style.hdr) },
        uOpacity: { value: style.opacity },
        uMode: { value: style.mode },
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'arrow-trails';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.userData.noOutline = true;
    this.mesh.userData.noNormals = true;
  }

  /** The trail following arrow slot `a` (a new one if it has none), or −1 when they're all busy. */
  slot(a: number, color: string) {
    for (let t = 0; t < MAX_TRAILS; t++) if (this.owner[t] === a) return t;
    for (let t = 0; t < MAX_TRAILS; t++)
      if (this.owner[t] < 0) {
        this.owner[t] = a;
        this.count[t] = 0;
        this.color[t].set(color).lerp(this.base, 1 - this.tint).multiplyScalar(this.hdr);
        return t;
      }
    return -1;
  }

  /** Forget arrow slot a's trail at once (it's a different arrow now). */
  cut(a: number) {
    for (let t = 0; t < MAX_TRAILS; t++)
      if (this.owner[t] === a) {
        this.owner[t] = -1;
        this.count[t] = 0;
      }
  }

  /** Stop feeding arrow slot a's trail (it landed): it fades out. */
  release(a: number) {
    for (let t = 0; t < MAX_TRAILS; t++) if (this.owner[t] === a) this.owner[t] = -2 - a;
  }

  /** Add the arrow's newest point (its tail) to trail t. */
  push(t: number, x: number, y: number, z: number) {
    const P = this.pts[t],
      A = this.age[t];
    const n = Math.min(TRAIL_N, this.count[t] + 1);
    for (let i = n - 1; i > 0; i--) {
      P[i * 3] = P[(i - 1) * 3];
      P[i * 3 + 1] = P[(i - 1) * 3 + 1];
      P[i * 3 + 2] = P[(i - 1) * 3 + 2];
      A[i] = A[i - 1];
    }
    P[0] = x;
    P[1] = y;
    P[2] = z;
    A[0] = 0;
    this.count[t] = n;
  }

  update(dt: number) {
    let any = false;
    const L = Trails.LIFE;
    for (let t = 0; t < MAX_TRAILS; t++) {
      const A = this.age[t];
      let n = 0;
      for (let i = 0; i < this.count[t]; i++) {
        A[i] += dt;
        if (A[i] < L) n = i + 1;
      }
      this.count[t] = n;
      // a landed arrow's trail is free again once it has faded
      if (n === 0 && this.owner[t] <= -2) this.owner[t] = -1;
      this.write(t);
      if (n >= 2) any = true;
    }
    this.mesh.visible = any;
    if (!any) return;
    for (let i = 0; i < this.attrs.length; i++) this.attrs[i].needsUpdate = true;
  }

  /** Lay trail t's vertices (collapsed into its last point when there's less than two). */
  private write(t: number) {
    const P = this.pts[t],
      A = this.age[t];
    const n = this.count[t];
    const c = this.color[t];
    for (let j = 0; j < TRAIL_N; j++) {
      const i = Math.min(j, Math.max(0, n - 1));
      const a = Math.max(0, i - 1),
        b = Math.min(Math.max(0, n - 1), i + 1);
      let tx = P[a * 3] - P[b * 3],
        ty = P[a * 3 + 1] - P[b * 3 + 1],
        tz = P[a * 3 + 2] - P[b * 3 + 2];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-5) (tx /= tl), (ty /= tl), (tz /= tl);
      else (tx = 0), (ty = 0), (tz = -1);
      // 0 at the arrow → 1 at the trail's end (by age, so it keeps its length at any frame rate)
      const u = n < 2 || j >= n ? 1 : Math.min(1, A[i] / Trails.LIFE);
      for (let s = 0; s < 2; s++) {
        const v = (t * TRAIL_N + j) * 2 + s;
        this.pos[v * 3] = P[i * 3];
        this.pos[v * 3 + 1] = P[i * 3 + 1];
        this.pos[v * 3 + 2] = P[i * 3 + 2];
        this.tan[v * 3] = tx;
        this.tan[v * 3 + 1] = ty;
        this.tan[v * 3 + 2] = tz;
        this.col[v * 3] = c.r;
        this.col[v * 3 + 1] = c.g;
        this.col[v * 3 + 2] = c.b;
        this.sd[v * 2] = s ? 1 : -1;
        this.sd[v * 2 + 1] = u;
      }
    }
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- wind flags

/**
 * Pennants on poles that stream with the wind: one mesh for all of them,
 * rebuilt on the CPU each frame (a few hundred vertices). They swing round
 * their poles when the wind turns, hang limp in a calm and fly flat and
 * flapping in a gale.
 */
export class Flags {
  mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private static C = 8;
  private static R = 2;
  private per = (Flags.C + 1) * (Flags.R + 1);
  private anchor: Float32Array;
  private size: Float32Array;
  private n = 0;
  private dir = 0;
  private stepped: boolean;

  constructor(
    mat: THREE.Material,
    colors: string[],
    stepped: boolean,
    readonly max: number,
  ) {
    this.stepped = stepped;
    this.anchor = new Float32Array(max * 3);
    this.size = new Float32Array(max * 2);
    const per = this.per;
    this.pos = new Float32Array(this.max * per * 3);
    const col = new Float32Array(this.max * per * 3);
    const idx: number[] = [];
    const C = Flags.C,
      R = Flags.R;
    for (let f = 0; f < this.max; f++) {
      const c = new THREE.Color(colors[f % colors.length]);
      for (let i = 0; i < per; i++) col.set([c.r, c.g, c.b], (f * per + i) * 3);
      for (let u = 0; u < C; u++)
        for (let v = 0; v < R; v++) {
          const a = f * per + u * (R + 1) + v;
          const b = a + R + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.pos.length), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.name = 'flags';
    this.mesh.frustumCulled = false;
    this.mesh.userData.noOutline = true;
  }

  begin() {
    this.n = 0;
  }

  /** A flag whose hoist's top is at (x, y, z): its length and height (metres). */
  add(x: number, y: number, z: number, len: number, h: number) {
    if (this.n >= this.max) return;
    const a = this.anchor,
      s = this.size,
      i = this.n;
    a[i * 3] = x;
    a[i * 3 + 1] = y;
    a[i * 3 + 2] = z;
    s[i * 2] = len;
    s[i * 2 + 1] = h;
    this.n++;
  }

  update(time: number, dt: number, wind: number) {
    const C = Flags.C,
      R = Flags.R;
    const k = Math.min(1, Math.abs(wind) / 4.5);
    // swing round the pole to the wind's way (the far side, away from the camera)
    const want = wind >= 0 ? 0 : Math.PI;
    let d = want - this.dir;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.dir += d * Math.min(1, dt * (0.8 + k * 2.5));
    const t = this.stepped ? Math.floor(time * 8) / 8 : time;
    const ex = Math.cos(this.dir),
      ez = -Math.abs(Math.sin(this.dir));
    // droop: from hanging down the pole in a calm to flying out flat
    const droop = THREE.MathUtils.lerp(1.2, 0.12, Math.pow(k, 0.7));
    const cd = Math.cos(droop),
      sd = Math.sin(droop);
    const flap = 0.05 + 0.14 * k;
    const speed = 5 + 9 * k;
    const P = this.pos;
    for (let f = 0; f < this.max; f++) {
      const base = f * this.per;
      if (f >= this.n) {
        for (let i = 0; i < this.per; i++) {
          P[(base + i) * 3] = 0;
          P[(base + i) * 3 + 1] = -50;
          P[(base + i) * 3 + 2] = 0;
        }
        continue;
      }
      const ax = this.anchor[f * 3],
        ay = this.anchor[f * 3 + 1],
        az = this.anchor[f * 3 + 2];
      const len = this.size[f * 2],
        h = this.size[f * 2 + 1];
      const ph = ax * 1.7 + az * 0.9;
      for (let u = 0; u <= C; u++) {
        const uu = u / C;
        const hh = h * (1 - 0.82 * uu); // a pennant, tapering to the fly
        for (let v = 0; v <= R; v++) {
          const vv = v / R;
          // in the flag's plane: out from the pole, and down
          const a = uu * len,
            b = -(vv - 0.5) * hh - h * 0.5;
          // droop: the plane turns down about the hoist's top
          const A = a * cd + b * sd,
            B = -a * sd + b * cd;
          // the flap: a wave running out along the flag, growing to the fly
          const w = Math.sin(t * speed - uu * 5.5 + ph) * flap * len * uu + Math.sin(t * speed * 1.7 + vv * 3 + ph) * 0.015 * uu;
          const i = (base + u * (R + 1) + v) * 3;
          P[i] = ax + ex * A + ez * w;
          P[i + 1] = ay + B;
          P[i + 2] = az + ez * A - ex * w;
        }
      }
    }
    this.normals();
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Each vertex's normal from its neighbours along and across the flag (computeVertexNormals allocates). */
  private normals() {
    const C = Flags.C,
      R = Flags.R;
    const P = this.pos;
    const N = (this.geo.attributes.normal as THREE.BufferAttribute).array as Float32Array;
    const W = R + 1;
    for (let f = 0; f < this.n; f++) {
      const base = f * this.per;
      for (let u = 0; u <= C; u++)
        for (let v = 0; v <= R; v++) {
          // the neighbours along (u) and across (v)
          const a = (base + Math.min(C, u + 1) * W + v) * 3,
            b = (base + Math.max(0, u - 1) * W + v) * 3,
            c = (base + u * W + Math.min(R, v + 1)) * 3,
            d = (base + u * W + Math.max(0, v - 1)) * 3;
          const ax = P[a] - P[b],
            ay = P[a + 1] - P[b + 1],
            az = P[a + 2] - P[b + 2];
          const bx = P[c] - P[d],
            by = P[c + 1] - P[d + 1],
            bz = P[c + 2] - P[d + 2];
          let nx = ay * bz - az * by,
            ny = az * bx - ax * bz,
            nz = ax * by - ay * bx;
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          const i = (base + u * W + v) * 3;
          N[i] = nx;
          N[i + 1] = ny;
          N[i + 2] = nz;
        }
    }
  }

  dispose() {
    this.geo.dispose();
  }
}
