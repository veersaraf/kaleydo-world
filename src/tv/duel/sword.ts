// The duel sword: a chunky, toy-like blade (Chambara's padded swords) built
// from the world's MaterialKit, held in the rig's racket slot; the swoosh its
// blade leaves through a slash; and DuelGear, which does both for a world's
// fighters every frame (plus the dizzy stars and the shadows on the deck).
//
// Sword space is the racket's: the grip at the origin (where the hand is), the
// blade along +y, the cutting edge facing +z — so Pose.racketDir is the blade
// and Pose.racketFace the edge. It lives inside rig.racket, which the rig
// scales with the character: SWORD is in the rig's root units.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit, CharRole } from '../worlds/types';
import type { Rig } from '../chars/rig';
import type { Particles } from '../render/particles';
import { outlineMaterial } from '../render/outline';
import { NOISE } from '../render/glsl';
import { ARENA, HAZARD_Y } from './arena';
import type { FighterState } from './types';

/** Sword measurements (root units ≈ metres / 1.16): the hand holds it at 0. */
export const SWORD = {
  pommel: -0.15,
  guard: 0.13,
  /** where the blade leaves the guard */
  blade: 0.145,
  tip: 1.06,
  width: 0.15,
  thick: 0.07,
};

// ---------------------------------------------------------------- geometry

/**
 * The blade: a chunky section (two flats with a fuller down the middle, four
 * bevels meeting at the edges) swept along +y and rounding off into the tip.
 * Flat-shaded, with vertex colours: a light blade (it has to stand out against
 * its own fighter's shirt when held across the body) with the fighter's colour
 * in the fuller. Thick enough to read even edge-on.
 */
function bladeGeometry(light: THREE.Color, edge: THREE.Color, fuller: THREE.Color) {
  const { blade: y0, tip: y1, width: w, thick: t } = SWORD;
  const tipLen = 0.2;
  const b = w * 0.24;
  const f = w * 0.16;
  // cross-section: x = the flat's normal, z = the edge's
  const ring: [number, number][] = [
    [0, w / 2],
    [t / 2, w / 2 - b],
    [t / 2, f],
    [t / 2, -f],
    [t / 2, -(w / 2 - b)],
    [0, -w / 2],
    [-t / 2, -(w / 2 - b)],
    [-t / 2, -f],
    [-t / 2, f],
    [-t / 2, w / 2 - b],
  ];
  const R = ring.length;
  const face = (i: number) => (i === 2 || i === 7 ? fuller : i === 1 || i === 3 || i === 6 || i === 8 ? light : edge);
  // stations along the blade: [y, width scale, thickness scale]
  const st: [number, number, number][] = [
    [y0, 1, 1],
    [y1 - tipLen, 1, 1],
  ];
  for (let k = 1; k <= 6; k++) {
    const u = k / 6;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    st.push([y1 - tipLen + u * tipLen * 0.97, 0.12 + 0.88 * s, 0.4 + 0.6 * s]);
  }
  const pos: number[] = [];
  const col: number[] = [];
  const P = (k: number, i: number): [number, number, number] => {
    const [y, sw, stk] = st[k];
    const [x, z] = ring[i % R];
    return [x * stk, y, z * sw];
  };
  const tri = (a: number[], b2: number[], c: number[], cc: THREE.Color) => {
    pos.push(...a, ...b2, ...c);
    for (let i = 0; i < 3; i++) col.push(cc.r, cc.g, cc.b);
  };
  for (let k = 0; k + 1 < st.length; k++)
    for (let i = 0; i < R; i++) {
      const c = face(i);
      const a0 = P(k, i),
        a1 = P(k, i + 1),
        b0 = P(k + 1, i),
        b1 = P(k + 1, i + 1);
      tri(a0, a1, b0, c);
      tri(a1, b1, b0, c);
    }
  // the point
  const last = st.length - 1;
  for (let i = 0; i < R; i++) tri(P(last, i), P(last, i + 1), [0, y1, 0], face(i));
  // the base (inside the guard, but it closes the silhouette seen from below)
  for (let i = 0; i < R; i++) tri(P(0, i), [0, y0, 0], P(0, i + 1), edge);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** An outline hull needs smooth normals: a faceted mesh's hull cracks open at every edge. */
function smoothHull(g: THREE.BufferGeometry) {
  const p = new THREE.BufferGeometry();
  p.setAttribute('position', g.attributes.position.clone());
  const m = mergeVertices(p, 1e-4);
  p.dispose();
  m.computeVertexNormals();
  return m;
}

export interface SwordOpts {
  /** world id (park, plaza, ink, neon…): a few styles tone the blade for their look */
  world?: string;
}

/** A sword in the world's style. Dispose it (sword.userData.dispose()) when you're done with it. */
export function makeSword(kit: MaterialKit, color: THREE.ColorRepresentation, o: SwordOpts = {}): THREE.Group {
  const g = new THREE.Group();
  g.name = 'sword';
  g.userData.sword = true;
  const team = new THREE.Color(color);
  const mats: THREE.Material[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const M = (role: CharRole, c: THREE.ColorRepresentation) => {
    const m = kit.char(role, new THREE.Color(c));
    mats.push(m);
    return m;
  };
  const white = new THREE.Color('#ffffff');
  // a light blade with the fighter's colour down the fuller; in the glowing world
  // a blade of light in their colour with a white-hot core (white all over would bloom into a blob)
  const glow = o.world === 'neon';
  const light = glow ? team.clone().lerp(white, 0.25) : team.clone().lerp(white, 0.82);
  const edge = glow ? team.clone().multiplyScalar(0.85) : new THREE.Color('#fffdf8');
  const fuller = glow ? team.clone().lerp(white, 0.7) : team.clone();

  // one mesh, one material (the kit's glossy 'racket'), vertex-coloured: blade,
  // gold cross-guard and pommel, dark grip — a single draw per pass
  const part = (geo: THREE.BufferGeometry, c: THREE.Color) => {
    const n = geo.index ? geo.toNonIndexed() : geo;
    if (n !== geo) geo.dispose();
    n.deleteAttribute('uv');
    const col = new Float32Array(n.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    n.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return n;
  };
  const gold = new THREE.Color('#ffc531');
  const guardG = new THREE.CapsuleGeometry(0.034, 0.24, 4, 10);
  guardG.rotateX(Math.PI / 2);
  guardG.scale(1.25, 1, 1);
  guardG.translate(0, SWORD.guard, 0);
  const pommelG = new THREE.SphereGeometry(0.046, 14, 10);
  pommelG.translate(0, SWORD.pommel, 0);
  const gripG = new THREE.CylinderGeometry(0.03, 0.033, SWORD.guard - SWORD.pommel - 0.02, 12);
  gripG.translate(0, (SWORD.guard + SWORD.pommel) / 2, 0);
  const pieces = [bladeGeometry(light, edge, fuller), part(guardG, gold), part(pommelG, gold), part(gripG, new THREE.Color('#2e2b3c'))];
  const geo = mergeGeometries(pieces)!;
  pieces.forEach((x) => x.dispose());
  geos.push(geo);
  const mat = M('racket', '#ffffff');
  mat.vertexColors = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sword-mesh';
  mesh.castShadow = !!kit.castShadow;
  mesh.receiveShadow = false;
  g.add(mesh);
  // an outline: the style's own, or — where nothing else draws edges (the ink and
  // pixel passes do) — a thin dark one, so a light blade still reads against a pale sky
  const oc = kit.outline ?? (o.world === 'ink' || o.world === 'pixel' ? null : { color: new THREE.Color('#1f1b30'), width: 0.011, emissive: 1 });
  if (oc) {
    const hb = smoothHull(geo);
    geos.push(hb);
    const h = new THREE.Mesh(hb, outlineMaterial(oc.color, oc.width, { emissive: oc.emissive }));
    h.name = 'outline';
    mesh.add(h);
  }
  g.userData.dispose = () => {
    geos.forEach((x) => x.dispose());
    mats.forEach((x) => x.dispose());
  };
  return g;
}

/**
 * Put the sword in the rig's hand: inside rig.racket (so Pose.racketDir /
 * racketFace aim it), with the racket's own meshes hidden (not the group).
 */
export function equipSword(rig: Rig, sword: THREE.Object3D) {
  const r = rig.racket;
  for (const c of r.children) {
    if (c.userData.sword || c === sword) continue;
    if (c.userData.duelWasVisible === undefined) c.userData.duelWasVisible = c.visible;
    c.visible = false;
  }
  if (r.userData.duelWasVisible === undefined) r.userData.duelWasVisible = r.visible;
  r.visible = true;
  if (sword.parent !== r) r.add(sword);
}

/** Take the sword out of the rig's hand and bring the racket back. (Doesn't dispose the sword.) */
export function unequipSword(rig: Rig) {
  const r = rig.racket;
  for (const c of [...r.children]) {
    if (c.userData.sword) {
      r.remove(c);
      continue;
    }
    if (c.userData.duelWasVisible !== undefined) {
      c.visible = c.userData.duelWasVisible;
      delete c.userData.duelWasVisible;
    }
  }
  if (r.userData.duelWasVisible !== undefined) {
    r.visible = r.userData.duelWasVisible;
    delete r.userData.duelWasVisible;
  }
}

// ---------------------------------------------------------------- trail

export interface SwordTrailStyle {
  /** the swoosh's colour at the hilt side and at the tip */
  color: THREE.ColorRepresentation;
  core: THREE.ColorRepresentation;
  opacity: number;
  /** 0 smooth, 1 dry brush, 2 pixel steps, 3 hard-edged cut */
  mode: number;
  additive?: boolean;
  /** seconds a stretch of trail lasts */
  life?: number;
}

/** The swoosh in each world's own look, tinted by the fighter's colour. */
export function trailStyle(world: string | undefined, color: THREE.ColorRepresentation): SwordTrailStyle {
  const c = new THREE.Color(color);
  const white = new THREE.Color('#ffffff');
  const light = c.clone().lerp(white, 0.55);
  switch (world) {
    case 'ink':
      // a stroke of ink (dark survives the ink pass as a brush stroke)
      return { color: '#2a2622', core: '#15120f', opacity: 0.9, mode: 1, life: 0.2 };
    case 'neon':
      return { color: c.clone().multiplyScalar(2.2), core: light.clone().multiplyScalar(2.6), opacity: 0.9, mode: 0, additive: true };
    case 'cosmic':
      return { color: c.clone().lerp(new THREE.Color('#5ef2ff'), 0.4).multiplyScalar(1.8), core: new THREE.Color('#e8fbff').multiplyScalar(2.4), opacity: 0.85, mode: 0, additive: true };
    case 'pixel':
      return { color: c, core: '#fff1e8', opacity: 1, mode: 2 };
    case 'paper':
      return { color: '#ffffff', core: '#ffffff', opacity: 0.95, mode: 3 };
    case 'plaza':
      return { color: light, core: '#ffffff', opacity: 0.9, mode: 3 };
    case 'water':
      return { color: c.clone().lerp(white, 0.25), core: light, opacity: 0.55, mode: 0, life: 0.22 };
    case 'clay':
      return { color: light, core: '#fff8ea', opacity: 0.75, mode: 0 };
    default:
      return { color: light, core: '#ffffff', opacity: 0.8, mode: 0 };
  }
}

const TRAIL_VERT = /* glsl */ `
attribute vec2 aT; varying vec2 vT;
void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const TRAIL_FRAG = /* glsl */ `
uniform vec3 uColor; uniform vec3 uCore; uniform float uOpacity; uniform int uMode; uniform float uSeed;
varying vec2 vT;
${NOISE}
void main() {
  float age = vT.x;
  // the sweep runs 0 (hilt side) … 1 (tip); the fin along the tip's path runs 3 … 5 (4 = the path)
  bool fin = vT.y > 2.0;
  float s = fin ? 1.0 - abs(vT.y - 4.0) : vT.y;
  // gone with age, and thin towards the hilt: the tip draws the arc
  float a = pow(1.0 - age, 1.2) * (fin ? smoothstep(0.0, 0.85, s) : smoothstep(0.0, 0.7, s) * 0.8);
  float core = smoothstep(0.6, 1.0, s) * (1.0 - age * 0.8);
  vec3 col = mix(uColor, uCore, core);
  if (uMode == 1) {
    float streak = vnoise(vec2(s * 16.0 + uSeed, age * 2.0));
    a *= smoothstep(0.15 + age * 0.55, 0.45 + age * 0.4, streak + s * 0.4);
  } else if (uMode == 2) {
    a = step(0.3, a) * (0.55 + 0.45 * step(0.62, a));
    col = mix(uColor, uCore, step(0.8, s));
  } else if (uMode == 3) {
    a = step(0.28, a);
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a * uOpacity);
}`;

/** trail samples kept (ring buffer), Catmull-Rom steps between two of them */
const N = 24;
const SUB = 4;
const COLS = (N - 1) * SUB + 1;
/** half-width of the fin along the tip's path (world metres) */
const FIN = 0.1;

interface Sample {
  tip: THREE.Vector3;
  base: THREE.Vector3;
  /** the fin's two rails: the tip ± the blade's flat normal */
  finA: THREE.Vector3;
  finB: THREE.Vector3;
  age: number;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

function catmull(o: THREE.Vector3, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number) {
  const t2 = t * t,
    t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return o.set(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

type Rail = 'tip' | 'base' | 'finA' | 'finB';

/**
 * The swoosh a slash leaves, laid down in world space while `on` (slashing) and
 * fading shortly after: a ribbon swept between a point near the hilt and the
 * tip, and a fin along the tip's path across it — so a flat, horizontal cut
 * seen from about its own height still shows. Add `mesh` to the world's scene;
 * call update() every frame after the rig has its pose (it reads the rig's
 * matrices itself — rendering updates them later).
 */
export class SwordTrail {
  mesh: THREE.Mesh;
  private samples: Sample[] = [];
  private count = 0;
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(COLS * 4 * 3);
  private at = new Float32Array(COLS * 4 * 2);
  private mat: THREE.ShaderMaterial;
  private life: number;
  private tip = new THREE.Vector3();
  private base = new THREE.Vector3();
  private flat = new THREE.Vector3();

  constructor(style: SwordTrailStyle) {
    this.life = style.life ?? 0.17;
    const V = () => new THREE.Vector3();
    for (let i = 0; i < N; i++) this.samples.push({ tip: V(), base: V(), finA: V(), finB: V(), age: 0 });
    // per column: base, tip (the sweep), then the fin's two rails; the two quads
    // of a column sit together so one draw range covers both strips
    const idx: number[] = [];
    for (let j = 0; j < COLS - 1; j++) {
      const a = j * 4,
        b = a + 4;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
      idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aT', new THREE.BufferAttribute(this.at, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(style.color) },
        uCore: { value: new THREE.Color(style.core) },
        uOpacity: { value: style.opacity },
        uMode: { value: style.mode },
        uSeed: { value: Math.random() * 50 },
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'sword-trail';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.userData.noNormals = true;
    this.mesh.userData.noOutline = true;
  }

  /** Where the blade is now (world space): its tip, a point near the hilt, and the flat's normal. */
  private read(rig: Rig, sword: THREE.Object3D) {
    rig.root.updateMatrixWorld(true);
    const m = sword.matrixWorld;
    this.tip.set(0, SWORD.tip - 0.02, 0).applyMatrix4(m);
    this.base.set(0, SWORD.blade + (SWORD.tip - SWORD.blade) * 0.3, 0).applyMatrix4(m);
    this.flat.setFromMatrixColumn(m, 0).normalize();
  }

  update(rig: Rig, sword: THREE.Object3D, on: boolean, dt: number) {
    const S = this.samples;
    // age, and drop what has faded (newest first, so that's the tail)
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      S[i].age += dt;
      if (S[i].age < this.life) n = i + 1;
    }
    this.count = n;
    if (on && sword.parent) {
      this.read(rig, sword);
      // skip frames where the blade didn't move (Clayland poses at 12 fps)
      const moved = this.count === 0 || S[0].tip.distanceToSquared(this.tip) > 1e-6;
      if (moved) {
        // newest first: shift the list down one
        const spare = S[Math.min(this.count, N - 1)];
        for (let i = Math.min(this.count, N - 1); i > 0; i--) S[i] = S[i - 1];
        S[0] = spare;
        spare.tip.copy(this.tip);
        spare.base.copy(this.base);
        spare.finA.copy(this.tip).addScaledVector(this.flat, FIN);
        spare.finB.copy(this.tip).addScaledVector(this.flat, -FIN);
        spare.age = 0;
        this.count = Math.min(N, this.count + 1);
      }
    }
    this.mesh.visible = this.count >= 2;
    if (this.mesh.visible) this.build();
  }

  /** Forget the trail (a teleport, a new round). */
  reset() {
    this.count = 0;
    this.mesh.visible = false;
  }

  private rail(o: THREE.Vector3, r: Rail, i: number, t: number) {
    const S = this.samples;
    const n = this.count;
    const at = (k: number) => S[Math.max(0, Math.min(n - 1, k))][r];
    return catmull(o, at(i - 1), at(i), at(i + 1), at(i + 2), t);
  }

  private put(v: number, p: THREE.Vector3, age: number, s: number) {
    const P = this.pos,
      A = this.at;
    P[v * 3] = p.x;
    P[v * 3 + 1] = p.y;
    P[v * 3 + 2] = p.z;
    A[v * 2] = age;
    A[v * 2 + 1] = s;
  }

  private build() {
    const S = this.samples;
    const n = this.count;
    let col = 0;
    for (let i = 0; i < n - 1; i++) {
      const steps = i === n - 2 ? SUB + 1 : SUB;
      for (let k = 0; k < steps; k++) {
        const t = k / SUB;
        const age = Math.min(1, (S[i].age + (S[i + 1].age - S[i].age) * t) / this.life);
        const v = col * 4;
        this.put(v, this.rail(tmpB, 'base', i, t), age, 0);
        this.put(v + 1, this.rail(tmpA, 'tip', i, t), age, 1);
        this.put(v + 2, this.rail(tmpB, 'finA', i, t), age, 3);
        this.put(v + 3, this.rail(tmpA, 'finB', i, t), age, 5);
        col++;
      }
    }
    this.geo.setDrawRange(0, Math.max(0, col - 1) * 12);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aT as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- the fighters' gear, per world

/** The parts of a World that DuelGear uses. */
export interface DuelWorldLike {
  scene: THREE.Scene;
  kit: MaterialKit;
  rigs: Rig[];
  particles?: Particles;
  def?: { id: string };
}

interface Kit {
  rig: Rig;
  sword: THREE.Group;
  trail: SwordTrail;
  stars: THREE.Mesh;
  starsOn: number;
  phase: string;
  /** the thrust's flash has fired */
  stabbed: boolean;
  dustT: number;
  shadowOpacity: number;
}

const tmpV = new THREE.Vector3();

/** Three little stars in one mesh, for circling a dazed fighter's head. */
function starsGeometry() {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 ? 0.045 : 0.1;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const one = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
  one.translate(0, 0, -0.015);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const g = one.clone();
    g.rotateY(-a + Math.PI / 2);
    g.translate(Math.cos(a) * 0.3, Math.sin(k * 2.1) * 0.04, Math.sin(a) * 0.3);
    parts.push(g);
  }
  one.dispose();
  const m = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return m;
}

/**
 * Everything a world's fighters carry in a duel: a sword in each hand, the
 * slash trails, stars over a stunned head, and blob shadows on the deck
 * (the rig drops them on the ground, under the platform). One per world;
 * call update() every frame after world.update(), dispose() when the duel ends.
 */
export class DuelGear {
  private kits: (Kit | null)[] = [];
  private starGeo = starsGeometry();
  private starMat: THREE.Material;
  private time = 0;
  /** glowing worlds (additive particles) want HDR colours */
  private hot: boolean;
  private glintCol: THREE.Color;
  private dustCol: THREE.Color;

  constructor(
    private w: DuelWorldLike,
    private colors: THREE.ColorRepresentation[],
  ) {
    this.starMat = w.kit.char('racket', new THREE.Color('#ffd23a'));
    const id = w.def?.id;
    this.hot = id === 'neon' || id === 'cosmic';
    this.glintCol = new THREE.Color(id === 'ink' ? '#d8321f' : '#fff6c0').multiplyScalar(this.hot ? 3 : 1);
    this.dustCol = id === 'neon' ? new THREE.Color('#22e6ff').multiplyScalar(2) : id === 'cosmic' ? new THREE.Color('#a86bff').multiplyScalar(2) : new THREE.Color(id === 'ink' ? '#3b342d' : '#f3ead8');
  }

  /** The sword in fighter i's hand (null until the first update). */
  sword(i: number) {
    return this.kits[i]?.sword ?? null;
  }

  private make(i: number, rig: Rig): Kit {
    const world = this.w.def?.id;
    const color = this.colors[i] ?? '#ffffff';
    const sword = makeSword(this.w.kit, color, { world });
    equipSword(rig, sword);
    const trail = new SwordTrail(trailStyle(world, color));
    this.w.scene.add(trail.mesh);
    const stars = new THREE.Mesh(this.starGeo, this.starMat);
    stars.visible = false;
    stars.frustumCulled = false;
    stars.castShadow = false;
    this.w.scene.add(stars);
    const sm = rig.shadow.material as THREE.MeshBasicMaterial;
    return { rig, sword, trail, stars, starsOn: 0, phase: '', stabbed: false, dustT: 0, shadowOpacity: sm.opacity };
  }

  private drop(k: Kit) {
    unequipSword(k.rig);
    k.sword.userData.dispose?.();
    k.trail.dispose();
    k.stars.removeFromParent();
    const sm = k.rig.shadow.material as THREE.MeshBasicMaterial;
    sm.opacity = k.shadowOpacity;
    k.rig.shadow.visible = true;
  }

  /** After world.update(): swords in hand (re-equipped if the rigs were rebuilt), trails, stars, shadows. */
  update(states: readonly FighterState[], dt: number, halfLength = ARENA.length / 2) {
    this.time += dt;
    const rigs = this.w.rigs;
    for (let i = 0; i < Math.max(rigs.length, this.kits.length); i++) {
      const rig = rigs[i];
      let k = this.kits[i] ?? null;
      if (k && k.rig !== rig) {
        this.drop(k);
        k = null;
      }
      if (!k && rig) k = this.make(i, rig);
      this.kits[i] = k;
      const s = states[i];
      if (!k || !s) continue;
      const entered = s.phase !== k.phase;
      k.phase = s.phase;
      const striking = (s.phase === 'slash' && s.t < 0.3) || (s.phase === 'thrust' && s.t < 0.22);
      k.trail.update(rig, k.sword, striking, dt);
      if (entered && s.phase === 'windup') this.glint(k);
      if (s.phase === 'thrust' && s.t >= 0.1 && !k.stabbed) {
        k.stabbed = true;
        this.stab(k);
      }
      if (s.phase !== 'thrust') k.stabbed = false;
      this.placeShadow(k, s, halfLength);
      this.dust(k, s, dt);
      this.dizzy(k, s, dt);
    }
  }

  /** a sparkle at the tip as a CPU cocks its sword: the tell to read */
  private glint(k: Kit) {
    const P = this.w.particles;
    if (!P) return;
    k.rig.root.updateMatrixWorld(true);
    tmpV.set(0, SWORD.tip * 0.85, 0).applyMatrix4(k.sword.matrixWorld);
    P.burst({ x: tmpV.x, y: tmpV.y, z: tmpV.z, count: 1, speed: [0, 0], life: [0.32, 0.32], size: [0.5, 0.5], shrink: 0.1, colors: [this.glintCol], shape: 'star', spin: 3, alpha: 1 });
  }

  /** a thrust comes straight at the camera, so the blade barely shows: flash its point at full stretch */
  private stab(k: Kit) {
    const P = this.w.particles;
    if (!P) return;
    k.rig.root.updateMatrixWorld(true);
    tmpV.set(0, SWORD.tip, 0).applyMatrix4(k.sword.matrixWorld);
    P.burst({ x: tmpV.x, y: tmpV.y, z: tmpV.z, count: 1, speed: [0, 0], life: [0.22, 0.22], size: [0.65, 0.65], shrink: 0.2, colors: [this.glintCol], shape: this.w.def?.id === 'pixel' ? 'square' : 'star', spin: 0, alpha: 1 });
    P.burst({ x: tmpV.x, y: tmpV.y, z: tmpV.z, count: 1, speed: [0, 0], life: [0.3, 0.3], size: [0.25, 0.25], shrink: 5, colors: [this.glintCol], shape: 'ring', alpha: 0.8 });
  }

  /** The rig drops its blob shadow on the ground: put it on the deck (or on the hazard while falling). */
  private placeShadow(k: Kit, s: FighterState, halfLength: number) {
    const sh = k.rig.shadow;
    const sm = sh.material as THREE.MeshBasicMaterial;
    const hop = k.rig.root.position.y;
    const onDeck = s.phase !== 'fall' && Math.abs(s.z) <= halfLength + 0.3 && Math.abs(s.x) <= ARENA.width / 2 + 0.2;
    const floor = onDeck ? ARENA.top : HAZARD_Y;
    const h = hop - floor;
    sh.visible = h > -0.05;
    sh.position.y = floor + 0.012;
    const k2 = 1 - Math.min(0.6, Math.max(0, h) * (onDeck ? 0.8 : 0.3));
    sh.scale.set(k.rig.scale * k2, k.rig.scale * k2, 1);
    sm.opacity = k.shadowOpacity * (onDeck ? 1 : Math.max(0, 1 - h * 0.35));
  }

  /** scuffs of dust as a hit fighter's feet slide back */
  private dust(k: Kit, s: FighterState, dt: number) {
    const P = this.w.particles;
    if (!P || s.phase !== 'stagger' || Math.abs(s.push) < 0.8) return;
    k.dustT -= dt;
    if (k.dustT > 0) return;
    k.dustT = 0.05;
    const hot = this.hot;
    for (const f of k.rig.feet) {
      f.getWorldPosition(tmpV);
      P.burst({ x: tmpV.x, y: ARENA.top + 0.05, z: tmpV.z, count: 1, speed: [0.3, 0.9], dir: [0, 1, 0], spread: 0.9, life: [0.3, 0.5], size: hot ? [0.06, 0.1] : [0.14, 0.24], shrink: hot ? 0.2 : 1.8, colors: [this.dustCol], shape: this.w.def?.id === 'pixel' ? 'square' : 'soft', alpha: hot ? 1 : 0.55, drag: 4, gravity: -0.3 });
    }
  }

  /** stars circling a stunned fighter's head */
  private dizzy(k: Kit, s: FighterState, dt: number) {
    const on = s.phase === 'stunned' ? 1 : 0;
    k.starsOn += (on - k.starsOn) * Math.min(1, dt * (on ? 10 : 6));
    const st = k.stars;
    st.visible = k.starsOn > 0.02;
    if (!st.visible) return;
    k.rig.head.getWorldPosition(tmpV);
    st.position.set(tmpV.x, tmpV.y + 0.42 * k.rig.scale, tmpV.z);
    st.rotation.set(Math.sin(this.time * 3) * 0.15, this.time * 5, 0);
    st.scale.setScalar(k.starsOn * k.rig.scale);
  }

  /** Clear the trails (a new round). */
  resetTrails() {
    for (const k of this.kits) k?.trail.reset();
  }

  dispose() {
    for (const k of this.kits) if (k) this.drop(k);
    this.kits = [];
    this.starGeo.dispose();
    this.starMat.dispose();
  }
}
