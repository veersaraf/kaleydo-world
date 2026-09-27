// The archer's gear: the bow (held in the rig's racket slot, its string drawn
// back to the draw hand), the arrow (one model, shared by the bow and the
// range's instanced arrows), a quiver at the hip, and ArcheryGear, which does
// all of it for a world's archers every frame.
//
// Bow space is the racket's: the grip at the origin (where the hand is), the
// limbs along ±y (+y = the upper limb) and +z back towards the archer. The
// string runs tip to tip GRIP.brace behind the grip; the arrow rests GRIP.restY
// up the bow, over the hand, and leaves along −z. So Pose.racketDir is "up the
// bow" and Pose.racketFace points from the bow back to the archer — the reverse
// of where the arrow goes. The bow lives inside rig.racket, which the rig scales
// with the character: BOW is in the rig's root units. ARROW is in metres.
//
// Arrow space: the point at the origin, the shaft back along +z (the arrow
// points along −z), so an arrow instance is placed by its point and turned
// from −z to its direction.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit, CharRole } from '../worlds/types';
import type { Rig } from '../chars/rig';
import { CHAR_SCALE, TORSO } from '../chars/rig';
import type { Particles } from '../render/particles';
import { outlineMaterial } from '../render/outline';
import { GRIP, LINE, NOCK, onLine } from './anim';
import type { ArcherState } from './types';

/** Bow measurements (root units ≈ metres / 1.16): the hand grips it at 0. */
export const BOW = {
  /** the riser (the handle) runs this far up and down from the grip */
  riser: 0.17,
  /** the limb tips, up the bow (the string's ends, at brace) */
  tipY: 0.54,
  /** at full draw the tips come back (z) and in (y) this much */
  flexZ: 0.075,
  flexY: 0.035,
  /** the nock's distance behind the brace at full draw (for the limbs' flex) */
  draw: 0.55,
};

/** Arrow measurements, metres — a little chunkier than a real arrow, so it reads at 30 m. */
export const ARROW = {
  /** point to nock (the game's shaft) */
  length: 0.75,
  shaft: 0.011,
  /** the point: its length and radius */
  point: 0.07,
  pointR: 0.018,
  /** the fletching: its length along the shaft and how far the vanes stand out */
  fletch: 0.15,
  vane: 0.042,
  /** a stuck arrow's point is this deep in what it hit (the game puts it there) */
  sink: 0.08,
};

// ---------------------------------------------------------------- per-world colours

interface GearStyle {
  /** arrow shaft and point */
  shaft: string;
  point: string;
  /** bow: riser, grip wrap, string; the limbs are the archer's colour */
  riser: string;
  grip: string;
  string: string;
  /** the limbs: how far the archer's colour is lightened (0 = as is) */
  limbLight: number;
  quiver: string;
}

const STYLE: Record<string, GearStyle> = {
  park: { shaft: '#f3efe6', point: '#8f98ab', riser: '#6f4a33', grip: '#2e2b3c', string: '#fbf7ee', limbLight: 0.1, quiver: '#8a5a38' },
  plaza: { shaft: '#fff6e0', point: '#7a86a8', riser: '#7c4f2e', grip: '#2b2f47', string: '#ffffff', limbLight: 0.1, quiver: '#9a6038' },
  ink: { shaft: '#e9dfca', point: '#15120f', riser: '#2a2520', grip: '#15120f', string: '#15120f', limbLight: 0, quiver: '#3b342d' },
  neon: { shaft: '#e8e4ff', point: '#22e6ff', riser: '#1a0f33', grip: '#0c0618', string: '#ffffff', limbLight: 0.15, quiver: '#150a33' },
  pixel: { shaft: '#fff1e8', point: '#c2c3c7', riser: '#ab5236', grip: '#1d2b53', string: '#fff1e8', limbLight: 0, quiver: '#ab5236' },
  paper: { shaft: '#f7ecd6', point: '#8b8b9b', riser: '#8b5a3c', grip: '#3d3540', string: '#fffdf5', limbLight: 0.08, quiver: '#a8744a' },
  clay: { shaft: '#e9c48c', point: '#b9b9c4', riser: '#6b4a32', grip: '#3a2e2a', string: '#fff8ea', limbLight: 0.05, quiver: '#8a5a38' },
  water: { shaft: '#f3e8d6', point: '#8a90ab', riser: '#8a6448', grip: '#4a4e6a', string: '#ffffff', limbLight: 0.12, quiver: '#9a7050' },
  cosmic: { shaft: '#e9f7ff', point: '#5ef2ff', riser: '#241c46', grip: '#10081e', string: '#e9f7ff', limbLight: 0.12, quiver: '#241c46' },
};

export function gearStyle(world: string | undefined): GearStyle {
  return STYLE[world ?? 'park'] ?? STYLE.park;
}

// ---------------------------------------------------------------- geometry helpers

/** Non-indexed, no uvs, one vertex colour: ready to merge with the other parts. */
function paint(geo: THREE.BufferGeometry, c: THREE.Color) {
  const n = geo.index ? geo.toNonIndexed() : geo;
  if (n !== geo) geo.dispose();
  n.deleteAttribute('uv');
  const col = new Float32Array(n.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
  n.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return n;
}

/** A cylinder along +z from z0 to z1. */
function rod(r0: number, r1: number, z0: number, z1: number, seg: number) {
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, seg, 1);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

function merge(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
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

/**
 * The arrow's two parts (metres; the point at the origin, the shaft back along
 * +z): `body` — the point and the shaft — in vertex colours, and `fletch` —
 * three vanes, the crest band and the nock — in white, to be tinted with the
 * archer's colour (a material colour, or an InstancedMesh's instanceColor).
 */
export function arrowGeometry(shaftCol: THREE.ColorRepresentation, pointCol: THREE.ColorRepresentation, o: { seg?: number } = {}) {
  const A = ARROW;
  const seg = o.seg ?? 8;
  const pc = new THREE.Color(pointCol);
  const sc = new THREE.Color(shaftCol);
  // the point: a cone into a collar
  const tipL = A.point * 0.72;
  const cone = new THREE.ConeGeometry(A.pointR, tipL, seg, 1);
  cone.rotateX(-Math.PI / 2);
  cone.translate(0, 0, tipL / 2);
  const collar = rod(A.pointR * 0.95, A.shaft * 1.25, tipL, A.point, seg);
  const shaft = rod(A.shaft, A.shaft, A.point, A.length - 0.012, seg);
  const body = merge([paint(cone, pc), paint(collar, pc), paint(shaft, sc)]);

  // the fletching: three shield-shaped vanes, the cock vane up
  const white = new THREE.Color('#ffffff');
  const back = A.length - 0.03;
  const front = back - A.fletch;
  const shape = new THREE.Shape();
  const N = 10;
  shape.moveTo(0, 0);
  for (let i = 1; i <= N; i++) {
    const a = i / N;
    shape.lineTo(a * A.fletch, A.vane * (1 - (1 - a) * (1 - a)) * (a > 0.93 ? 1 - (a - 0.93) * 4 : 1));
  }
  shape.lineTo(A.fletch, 0);
  shape.lineTo(0, 0);
  const vane = new THREE.ExtrudeGeometry(shape, { depth: 0.0035, bevelEnabled: false, curveSegments: 2 });
  vane.translate(0, 0, -0.00175);
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  for (let k = 0; k < 3; k++) {
    const ph = Math.PI / 2 + (k * Math.PI * 2) / 3;
    const c = Math.cos(ph),
      s = Math.sin(ph);
    // shape x → along the shaft, shape y → out from it, extrusion → around it
    m.makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(c, s, 0), new THREE.Vector3(-s, c, 0));
    m.setPosition(c * A.shaft * 0.8, s * A.shaft * 0.8, front);
    parts.push(paint(vane.clone().applyMatrix4(m), white));
  }
  vane.dispose();
  // a crest band in front of the vanes, and the nock
  parts.push(paint(rod(A.shaft * 1.18, A.shaft * 1.18, front - 0.05, front - 0.022, seg), white));
  parts.push(paint(rod(A.shaft * 1.3, A.shaft * 1.1, A.length - 0.03, A.length, seg), white));
  const fletch = merge(parts);
  return { body, fletch };
}

/**
 * One limb as a swept, tapering section (non-indexed, flat-shaded): from the
 * riser to the tip, bending back to the string, then a short recurve curling
 * forward past the string's nock. `sy` = +1 the upper limb, −1 the lower.
 */
function limbGeometry(sy: number, limb: THREE.Color, tipC: THREE.Color) {
  const K = 12;
  const pos: number[] = [];
  const col: number[] = [];
  const st: { y: number; z: number; w: number; t: number; c: THREE.Color }[] = [];
  const z0 = 0.004;
  for (let k = 0; k <= K + 2; k++) {
    let s = k / K;
    let y: number, z: number;
    if (k <= K) {
      y = BOW.riser + (BOW.tipY - BOW.riser) * s;
      z = z0 + (GRIP.brace - z0) * Math.pow(s, 1.6);
    } else {
      // the recurve: past the string's nock, curling forward
      const r = (k - K) / 2;
      y = BOW.tipY + 0.035 * r;
      z = GRIP.brace - 0.03 * r * r;
      s = 1;
    }
    st.push({ y, z, w: THREE.MathUtils.lerp(0.05, 0.022, Math.min(1, s)), t: THREE.MathUtils.lerp(0.02, 0.012, Math.min(1, s)), c: k >= K - 1 ? tipC : limb });
  }
  const corners = (i: number) => {
    const a = st[Math.max(0, i - 1)],
      b = st[Math.min(st.length - 1, i + 1)];
    let ty = b.y - a.y,
      tz = b.z - a.z;
    const l = Math.hypot(ty, tz) || 1;
    ty /= l;
    tz /= l;
    // the limb's thickness is across its own curve (in the y-z plane)
    const ny = -tz,
      nz = ty;
    const p = st[i];
    const h = p.t / 2,
      w = p.w / 2;
    return [
      [-w, p.y + ny * h, p.z + nz * h],
      [w, p.y + ny * h, p.z + nz * h],
      [w, p.y - ny * h, p.z - nz * h],
      [-w, p.y - ny * h, p.z - nz * h],
    ].map(([x, y, z]) => [x, y * sy, z]);
  };
  const tri = (a: number[], b: number[], c: number[], cc: THREE.Color) => {
    // mirrored (the lower limb): swap two corners to keep the winding
    if (sy < 0) pos.push(...a, ...c, ...b);
    else pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) col.push(cc.r, cc.g, cc.b);
  };
  let prev = corners(0);
  // the end at the riser
  tri(prev[0], prev[2], prev[1], limb);
  tri(prev[0], prev[3], prev[2], limb);
  for (let i = 1; i < st.length; i++) {
    const cur = corners(i);
    const c = st[i].c;
    for (let e = 0; e < 4; e++) {
      const a0 = prev[e],
        a1 = prev[(e + 1) % 4],
        b0 = cur[e],
        b1 = cur[(e + 1) % 4];
      tri(a0, a1, b0, c);
      tri(a1, b1, b0, c);
    }
    prev = cur;
  }
  // the tip's end
  tri(prev[0], prev[1], prev[2], tipC);
  tri(prev[0], prev[2], prev[3], tipC);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // flat: one normal per face
  g.computeVertexNormals();
  return g;
}

/** The whole bow but the string: riser, grip, limb bolts, limbs (bow space, root units). */
function bowGeometry(limb: THREE.Color, riser: THREE.Color, grip: THREE.Color, tip: THREE.Color) {
  const gold = new THREE.Color('#ffc531');
  const parts: THREE.BufferGeometry[] = [];
  // the grip: a rounded chunk the hand wraps round, a little behind the riser's line
  const g = new THREE.CapsuleGeometry(0.03, 0.1, 4, 10);
  g.scale(0.95, 1, 1.25);
  g.translate(0, -0.005, 0.012);
  parts.push(paint(g, grip));
  // the riser above and below: slim blocks (the arrow rests beside the upper one)
  for (const sy of [1, -1]) {
    const len = BOW.riser - 0.05;
    const b = new THREE.BoxGeometry(0.034, len, 0.05, 1, 1, 1);
    b.translate(0, sy * (0.05 + len / 2), -0.006);
    parts.push(paint(b, riser));
    // the limb bolt
    const bolt = new THREE.CylinderGeometry(0.014, 0.014, 0.046, 10);
    bolt.rotateX(Math.PI / 2);
    bolt.translate(0, sy * (BOW.riser - 0.025), -0.006);
    parts.push(paint(bolt, gold));
  }
  const geo = merge(parts);
  const limbs = [limbGeometry(1, limb, tip), limbGeometry(-1, limb, tip)];
  const all = mergeGeometries([geo, ...limbs])!;
  geo.dispose();
  limbs.forEach((l) => l.dispose());
  return all;
}

/** How much a bow vertex moves as the limbs flex: 0 on the riser, growing to 1 at the tips (and the sign of y). */
function flexWeights(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const w = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const s = THREE.MathUtils.clamp((Math.abs(y) - BOW.riser) / (BOW.tipY - BOW.riser), 0, 1.1);
    w[i] = Math.sign(y) * s * s;
  }
  return w;
}

// ---------------------------------------------------------------- the bow

export interface BowOpts {
  /** world id (park, plaza, ink, neon…): tones the bow and arrow for the look */
  world?: string;
}

const STRING_R = 0.0055;
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const NEG_Z = new THREE.Vector3(0, 0, -1);

/**
 * A bow in the world's style, oriented for rig.racket (the grip at the origin,
 * see the top of the file). Its string bends back to a nock point (setDraw),
 * the limbs flexing as it does, and it can show an arrow on the string or in
 * the draw hand (setArrow). Dispose it when you're done with it.
 */
export class Bow extends THREE.Group {
  /** where the string's nock point is now (bow space) */
  readonly nock = new THREE.Vector3(0, GRIP.restY, GRIP.brace);
  /** how far the limbs are bent (0 = braced, 1 = full draw; a little past either way as the string snaps) */
  flex = 0;
  /** metres → bow units, for the arrow (1 / the rig's scale): ArcheryGear sets it */
  arrowScale = 1 / CHAR_SCALE;
  /** the arrow rests beside the riser: on the archer's left for a right-hander (−x), their right for a left-hander */
  restX = -0.021;
  /** the arrow (on the string or in the hand), for its world position */
  readonly arrow = new THREE.Group();
  private body: THREE.Mesh;
  private hull: THREE.Mesh | null = null;
  private rest: Float32Array;
  private hullRest: Float32Array | null = null;
  private weights: Float32Array;
  private hullWeights: Float32Array | null = null;
  private stringGeo = new THREE.BufferGeometry();
  private stringPos = new Float32Array(16 * 3);
  private stringNrm = new Float32Array(16 * 3);
  private shownFlex = -1;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  constructor(kit: MaterialKit, color: THREE.ColorRepresentation, o: BowOpts = {}) {
    super();
    this.name = 'bow';
    this.userData.bow = true;
    const st = gearStyle(o.world);
    const team = new THREE.Color(color);
    const white = new THREE.Color('#ffffff');
    const M = (role: CharRole, c: THREE.ColorRepresentation) => {
      const m = kit.char(role, new THREE.Color(c));
      this.mats.push(m);
      return m;
    };
    const limb = team.clone().lerp(white, st.limbLight);
    const geo = bowGeometry(limb, new THREE.Color(st.riser), new THREE.Color(st.grip), new THREE.Color('#fffdf6'));
    this.geos.push(geo);
    const mat = M('racket', '#ffffff');
    mat.vertexColors = true;
    this.body = new THREE.Mesh(geo, mat);
    this.body.name = 'bow-body';
    this.body.castShadow = !!kit.castShadow;
    this.add(this.body);
    this.rest = Float32Array.from(geo.attributes.position.array as Float32Array);
    this.weights = flexWeights(geo);
    // an outline: the style's own, or a thin dark one where nothing else draws edges
    const oc = outlineOf(kit, o.world);
    if (oc) {
      const hb = smoothHull(geo);
      this.geos.push(hb);
      this.hull = new THREE.Mesh(hb, outlineMaterial(oc.color, oc.width * 0.8, { emissive: oc.emissive }));
      this.hull.name = 'outline';
      this.body.add(this.hull);
      this.hullRest = Float32Array.from(hb.attributes.position.array as Float32Array);
      this.hullWeights = flexWeights(hb);
    }

    // the string: two thin square rods (tip → nock → tip), rebuilt as it moves
    const idx: number[] = [];
    for (let s = 0; s < 2; s++)
      for (let e = 0; e < 4; e++) {
        const a = s * 8 + e,
          b = s * 8 + ((e + 1) % 4);
        idx.push(a, a + 4, b, b, a + 4, b + 4);
      }
    this.stringGeo.setAttribute('position', new THREE.BufferAttribute(this.stringPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.stringGeo.setAttribute('normal', new THREE.BufferAttribute(this.stringNrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.stringGeo.setIndex(idx);
    this.geos.push(this.stringGeo);
    const sm = M('racket', st.string);
    const string = new THREE.Mesh(this.stringGeo, sm);
    string.name = 'bow-string';
    string.frustumCulled = false;
    string.castShadow = false;
    this.add(string);

    // the arrow, tinted with the archer's colour
    const ag = arrowGeometry(st.shaft, st.point, { seg: 7 });
    this.geos.push(ag.body, ag.fletch);
    const bm = M('racket', '#ffffff');
    bm.vertexColors = true;
    const fm = M('racket', team);
    const ab = new THREE.Mesh(ag.body, bm);
    const af = new THREE.Mesh(ag.fletch, fm);
    ab.castShadow = af.castShadow = !!kit.castShadow;
    this.arrow.add(ab, af);
    if (oc) {
      for (const m of [ab, af]) {
        const hb = smoothHull(m.geometry);
        this.geos.push(hb);
        const h = new THREE.Mesh(hb, outlineMaterial(oc.color, oc.width * 0.7, { emissive: oc.emissive }));
        h.name = 'outline';
        m.add(h);
      }
    }
    this.arrow.name = 'bow-arrow';
    this.arrow.visible = false;
    this.add(this.arrow);
    this.setDraw(0);
  }

  /**
   * Draw the string back: to `nock` (bow space — the draw hand) if given,
   * otherwise straight back by `draw` (0..1) of a full draw. The limbs flex
   * with how far the nock is behind the brace.
   */
  setDraw(draw: number, nock?: THREE.Vector3) {
    if (nock) {
      this.nock.copy(nock);
      this.nock.x = THREE.MathUtils.clamp(this.nock.x, -0.12, 0.12);
      this.nock.y = THREE.MathUtils.clamp(this.nock.y, -BOW.tipY * 0.6, BOW.tipY * 0.6);
    } else this.nock.set(0, GRIP.restY, GRIP.brace + BOW.draw * draw);
    this.flex = THREE.MathUtils.clamp((this.nock.z - GRIP.brace) / BOW.draw, -0.25, 1.15);
    this.bend();
    this.buildString();
  }

  /**
   * Show the arrow: nocked on the string (pointing through the arrow rest), in
   * the hand (its nock end at `at`, pointing along `dir`, both bow space), or
   * not at all.
   */
  setArrow(mode: 'off' | 'string' | 'hand', at?: THREE.Vector3, dir?: THREE.Vector3) {
    const a = this.arrow;
    a.visible = mode !== 'off';
    if (!a.visible) return;
    const k = this.arrowScale;
    const L = ARROW.length * k;
    if (mode === 'string' || !at || !dir) {
      tmpA.set(this.restX, GRIP.restY, 0).sub(this.nock);
      if (tmpA.lengthSq() < 1e-6) tmpA.set(0, 0, -1);
      tmpA.normalize();
      tmpB.copy(this.nock);
    } else {
      tmpA.copy(dir).normalize();
      tmpB.copy(at);
    }
    a.position.copy(tmpB).addScaledVector(tmpA, L);
    a.quaternion.setFromUnitVectors(NEG_Z, tmpA);
    a.scale.setScalar(k);
  }

  /** The arrow's point in world space (after the rig's matrices are up to date). */
  arrowTip(out: THREE.Vector3) {
    return out.setFromMatrixPosition(this.arrow.matrixWorld);
  }

  /** The limbs' flex: rest positions moved back and in, more towards the tips. */
  private bend() {
    const f = this.flex;
    if (Math.abs(f - this.shownFlex) < 1e-3) return;
    this.shownFlex = f;
    this.flexGeometry(this.body.geometry, this.rest, this.weights, f);
    if (this.hull && this.hullRest && this.hullWeights) this.flexGeometry(this.hull.geometry, this.hullRest, this.hullWeights, f);
  }

  private flexGeometry(g: THREE.BufferGeometry, rest: Float32Array, w: Float32Array, f: number) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    for (let i = 0; i < p.count; i++) {
      const k = w[i];
      const s = Math.abs(k);
      a[i * 3 + 1] = rest[i * 3 + 1] - Math.sign(k) * BOW.flexY * f * s;
      a[i * 3 + 2] = rest[i * 3 + 2] + BOW.flexZ * f * s;
    }
    p.needsUpdate = true;
  }

  /** The two halves of the string, from each tip to the nock. */
  private buildString() {
    const f = this.flex;
    const ty = BOW.tipY - BOW.flexY * f,
      tz = GRIP.brace + BOW.flexZ * f;
    const n = this.nock;
    this.rodAt(0, 0, ty, tz, n.x, n.y, n.z);
    this.rodAt(8, n.x, n.y, n.z, 0, -ty, tz);
    (this.stringGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.stringGeo.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
  }

  /** A square rod of the string's thickness from a to b, written at vertex v. */
  private rodAt(v: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    let dx = bx - ax,
      dy = by - ay,
      dz = bz - az;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    // two sides square to the rod: one across the bow (x), one in its plane
    let ux = 1,
      uy = 0,
      uz = 0;
    const k = ux * dx;
    ux -= dx * k;
    uy -= dy * k;
    uz -= dz * k;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const wx = dy * uz - dz * uy,
      wy = dz * ux - dx * uz,
      wz = dx * uy - dy * ux;
    const r = STRING_R;
    const P = this.stringPos,
      N = this.stringNrm;
    for (let e = 0; e < 4; e++) {
      // the corners (1, 1), (−1, 1), (−1, −1), (1, −1)
      const cu = e === 0 || e === 3 ? 1 : -1,
        cw = e < 2 ? 1 : -1;
      const nx = (ux * cu + wx * cw) * Math.SQRT1_2,
        ny = (uy * cu + wy * cw) * Math.SQRT1_2,
        nz = (uz * cu + wz * cw) * Math.SQRT1_2;
      const i = (v + e) * 3,
        j = (v + 4 + e) * 3;
      P[i] = ax + nx * r;
      P[i + 1] = ay + ny * r;
      P[i + 2] = az + nz * r;
      P[j] = bx + nx * r;
      P[j + 1] = by + ny * r;
      P[j + 2] = bz + nz * r;
      N[i] = N[j] = nx;
      N[i + 1] = N[j + 1] = ny;
      N[i + 2] = N[j + 2] = nz;
    }
  }

  dispose() {
    this.removeFromParent();
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
  }
}

/** The outline a gear item gets: the style's own, or a thin dark one where nothing else draws edges (ink and pixel have their own passes). */
function outlineOf(kit: MaterialKit, world: string | undefined) {
  return kit.outline ?? (world === 'ink' || world === 'pixel' ? null : { color: new THREE.Color('#1f1b30'), width: 0.011, emissive: 1 });
}

/** A bow in the world's style, for rig.racket (see Bow). */
export function makeBow(kit: MaterialKit, color: THREE.ColorRepresentation, o: BowOpts = {}) {
  return new Bow(kit, color, o);
}

/**
 * Put the bow in the rig's hand: inside rig.racket (so Pose.racketDir /
 * racketFace aim it), with the racket's own meshes hidden (not the group).
 */
export function equipBow(rig: Rig, bow: THREE.Object3D) {
  const r = rig.racket;
  for (const c of r.children) {
    if (c.userData.bow || c === bow) continue;
    if (c.userData.archeryWasVisible === undefined) c.userData.archeryWasVisible = c.visible;
    c.visible = false;
  }
  if (r.userData.archeryWasVisible === undefined) r.userData.archeryWasVisible = r.visible;
  r.visible = true;
  if (bow.parent !== r) r.add(bow);
}

/** Take the bow out of the rig's hand and bring the racket back. (Doesn't dispose the bow.) */
export function unequipBow(rig: Rig) {
  const r = rig.racket;
  for (const c of [...r.children]) {
    if (c.userData.bow) {
      r.remove(c);
      continue;
    }
    if (c.userData.archeryWasVisible !== undefined) {
      c.visible = c.userData.archeryWasVisible;
      delete c.userData.archeryWasVisible;
    }
  }
  if (r.userData.archeryWasVisible !== undefined) {
    r.visible = r.userData.archeryWasVisible;
    delete r.userData.archeryWasVisible;
  }
}

// ---------------------------------------------------------------- the quiver

/** A hip quiver with a few arrows in it, in the rig's root units: its mouth at the top, hanging along −y. */
function quiverGeometry(st: GearStyle, team: THREE.Color, scale: number) {
  const parts: THREE.BufferGeometry[] = [];
  const leather = new THREE.Color(st.quiver);
  const L = 0.54,
    R = 0.058;
  const tube = new THREE.CylinderGeometry(R, R * 0.8, L, 14, 1, false);
  tube.translate(0, -L / 2, 0);
  parts.push(paint(tube, leather));
  const rim = new THREE.TorusGeometry(R, 0.012, 6, 16);
  rim.rotateX(Math.PI / 2);
  parts.push(paint(rim, team));
  const band = new THREE.CylinderGeometry(R * 1.04, R * 1.02, 0.05, 14, 1, true);
  band.translate(0, -L * 0.55, 0);
  parts.push(paint(band, team));
  // arrows standing in it, fletching up (arrow space turned so +z → +y)
  const ag = arrowGeometry(st.shaft, st.point, { seg: 5 });
  const m = new THREE.Matrix4();
  const k = 1 / scale;
  const white = new THREE.Color('#ffffff');
  const tint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const col = g.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * c.r, col.getY(i) * c.g, col.getZ(i) * c.b);
    return g;
  };
  [
    [0.018, 0.02, 0.2],
    [-0.022, 0.012, 1.4],
    [0.004, -0.024, 2.6],
  ].forEach(([x, z, roll], i) => {
    // the nock ends stick out of the top
    const up = 0.15 + i * 0.03;
    m.makeRotationX(-Math.PI / 2).multiply(new THREE.Matrix4().makeRotationZ(roll));
    m.scale(new THREE.Vector3(k, k, k));
    m.setPosition(x, up - ARROW.length * k, z);
    parts.push(ag.body.clone().applyMatrix4(m));
    parts.push(tint(ag.fletch.clone().applyMatrix4(m), i === 1 ? white.clone().lerp(team, 0.5) : team));
  });
  ag.body.dispose();
  ag.fletch.dispose();
  return merge(parts);
}

// ---------------------------------------------------------------- the archers' gear, per world

/** The parts of a World that ArcheryGear uses. */
export interface ArcheryWorldLike {
  scene: THREE.Scene;
  kit: MaterialKit;
  rigs: Rig[];
  particles?: Particles;
  def?: { id: string };
}

interface Kit {
  rig: Rig;
  bow: Bow;
  quiver: THREE.Mesh;
  hull: THREE.Mesh | null;
  hs: 1 | -1;
  phase: string;
  /** the nock when the arrow went, and the seconds since (−1 = not shooting): the string's snap */
  snapZ: number;
  relT: number;
  /** how much of the lifted draw elbow is applied (0..1) */
  elbow: number;
  shadowOpacity: number;
}

// the rig's arm (see Rig.apply): upper arm and forearm length
const ARM_SEG = 0.25;
const UP = new THREE.Vector3(0, 1, 0);
const vS = new THREE.Vector3();
const vH = new THREE.Vector3();
const vD = new THREE.Vector3();
const vP = new THREE.Vector3();
const vE = new THREE.Vector3();
const vE2 = new THREE.Vector3();
const vF = new THREE.Vector3();
const vSeg = new THREE.Vector3();
const vHand = new THREE.Vector3();
const vDir = new THREE.Vector3();

/** Lay one of the rig's unit arm capsules between two points (as Rig.apply does). */
function segment(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  vSeg.subVectors(b, a);
  const len = vSeg.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.visible = len > 0.02;
  if (!m.visible) return;
  vSeg.divideScalar(len);
  m.quaternion.setFromUnitVectors(UP, vSeg);
  const k = Math.min(1, Math.sqrt(ARM_SEG / Math.max(ARM_SEG, len)));
  m.scale.set(k, Math.max(0.01, len - 0.05), k);
}

/** Two-bone elbow: from shoulder S to hand H, bending towards `pole`. */
function elbowAt(o: THREE.Vector3, S: THREE.Vector3, H: THREE.Vector3, pole: THREE.Vector3) {
  vD.subVectors(H, S);
  const d = Math.max(1e-4, vD.length());
  vD.divideScalar(d);
  if (d >= 2 * ARM_SEG * 0.999) return o.copy(S).addScaledVector(vD, d / 2);
  const a = d / 2;
  const h = Math.sqrt(Math.max(0, ARM_SEG * ARM_SEG - a * a));
  vP.copy(pole).addScaledVector(vD, -pole.dot(vD));
  if (vP.lengthSq() < 1e-6) vP.set(1, 0, 0);
  vP.normalize();
  return o.copy(S).addScaledVector(vD, a).addScaledVector(vP, h);
}

/**
 * Everything a world's archers carry: a bow in each bow hand with its string
 * bent to the draw hand, the arrow on the string (or in the hand while
 * nocking), a quiver at the hip, the draw arm's elbow lifted in line behind
 * the arrow (the rig's IK would drop it), and the blob shadow on the shooting
 * line's platform. One per world; call update() every frame after
 * world.update() (the rigs have their poses then), dispose() when archery ends.
 */
export class ArcheryGear {
  private kits: (Kit | null)[] = [];
  private world: string | undefined;

  constructor(
    private w: ArcheryWorldLike,
    private colors: THREE.ColorRepresentation[],
  ) {
    this.world = w.def?.id;
  }

  /** The bow in archer i's hand (null until the first update). */
  bow(i: number) {
    return this.kits[i]?.bow ?? null;
  }

  /**
   * Where archer i's arrow point is right now (world), if an arrow is on the
   * string: launch the flying arrow from here so it leaves the bow. False when
   * there's none.
   */
  arrowTip(i: number, out: THREE.Vector3) {
    const k = this.kits[i];
    if (!k || !k.bow.arrow.visible) return false;
    k.rig.root.updateMatrixWorld(true);
    k.bow.arrowTip(out);
    return true;
  }

  private make(i: number, rig: Rig, hs: 1 | -1): Kit {
    const color = this.colors[i] ?? '#ffffff';
    const kit = this.w.kit;
    const bow = makeBow(kit, color, { world: this.world });
    bow.arrowScale = 1 / rig.scale;
    equipBow(rig, bow);
    // the quiver hangs at the draw-side hip, tipped back
    const st = gearStyle(this.world);
    const qg = quiverGeometry(st, new THREE.Color(color), rig.scale);
    const qm = kit.char('racket', new THREE.Color('#ffffff'));
    qm.vertexColors = true;
    const quiver = new THREE.Mesh(qg, qm);
    quiver.name = 'quiver';
    quiver.castShadow = !!kit.castShadow;
    rig.body.add(quiver);
    const oc = outlineOf(kit, this.world);
    let hull: THREE.Mesh | null = null;
    if (oc) {
      hull = new THREE.Mesh(smoothHull(qg), outlineMaterial(oc.color, oc.width * 0.8, { emissive: oc.emissive }));
      hull.name = 'outline';
      quiver.add(hull);
    }
    const sm = rig.shadow.material as THREE.MeshBasicMaterial;
    const k: Kit = { rig, bow, quiver, hull, hs, phase: '', snapZ: GRIP.brace, relT: -1, elbow: 0, shadowOpacity: sm.opacity };
    this.fitHand(k);
    return k;
  }

  /** Sides by handedness: the quiver on the draw-side hip, the arrow on the bow's far side from the draw hand. */
  private fitHand(k: Kit) {
    const q = k.quiver;
    q.position.set(k.hs * 0.27, 0.36, 0.1);
    q.rotation.set(0.38, 0, -k.hs * 0.28);
    k.bow.restX = -k.hs * 0.021;
  }

  private drop(k: Kit) {
    unequipBow(k.rig);
    k.bow.dispose();
    k.quiver.removeFromParent();
    k.quiver.geometry.dispose();
    (k.quiver.material as THREE.Material).dispose();
    k.hull?.geometry.dispose();
    const sm = k.rig.shadow.material as THREE.MeshBasicMaterial;
    sm.opacity = k.shadowOpacity;
  }

  /** After world.update(): bows in hand (re-equipped if the rigs were rebuilt), strings, arrows, elbows, shadows. */
  update(states: readonly ArcherState[], dt: number) {
    const rigs = this.w.rigs;
    for (let i = 0; i < Math.max(rigs.length, this.kits.length); i++) {
      const rig = rigs[i];
      const s = states[i];
      let k = this.kits[i] ?? null;
      if (k && k.rig !== rig) {
        this.drop(k);
        k = null;
      }
      if (!k && rig) k = this.make(i, rig, s?.handed ?? 1);
      this.kits[i] = k;
      if (!k || !s) continue;
      if (s.handed !== k.hs) {
        k.hs = s.handed;
        this.fitHand(k);
      }
      const entered = s.phase !== k.phase;
      if (entered && s.phase === 'release') {
        k.snapZ = k.bow.nock.z;
        k.relT = 0;
      } else if (k.relT >= 0) k.relT += dt;
      if (s.phase !== 'release' && s.phase !== 'watch') k.relT = -1;
      k.phase = s.phase;
      k.rig.root.updateMatrixWorld(true);
      this.string(k, s);
      this.elbow(k, s, dt);
      this.shadow(k, s);
    }
  }

  /** The string to the draw hand while drawing, snapping home after the shot; the arrow on it (or in the hand). */
  private string(k: Kit, s: ArcherState) {
    const bow = k.bow;
    // the draw hand, in bow space
    const hand = vHand.copy(k.rig.hands[1].position).applyMatrix4(k.rig.root.matrixWorld);
    bow.worldToLocal(hand);
    switch (s.phase) {
      case 'draw':
      case 'hold': {
        // the fingers hold the string: it follows the hand (never forward of the brace)
        if (hand.z < GRIP.brace) hand.z = GRIP.brace;
        const far = hand.length() > GRIP.brace + BOW.draw * 1.5;
        if (far) bow.setDraw(0);
        else bow.setDraw(0, hand);
        bow.setArrow('string');
        break;
      }
      case 'nock': {
        bow.setDraw(0);
        if (s.t >= NOCK.seat) bow.setArrow('string');
        else if (s.t >= NOCK.take) {
          // out of the quiver point-down, swinging round towards the bow
          const u = THREE.MathUtils.smoothstep(s.t, NOCK.take, NOCK.seat);
          // world down → bow space (directions only)
          vDir.set(0, -1, 0);
          bow.getWorldQuaternion(tmpQ).invert();
          vDir.applyQuaternion(tmpQ);
          vF.set(bow.restX, GRIP.restY, 0).sub(hand).normalize();
          vDir.lerp(vF, u).normalize();
          bow.setArrow('hand', hand, vDir);
        } else bow.setArrow('off');
        break;
      }
      case 'release':
      case 'watch': {
        // the string flies home and rings for a moment (into 'watch', however short the game's
        // 'release' is); the limbs kick forward with it
        const t = k.relT;
        if (t < 0 || t > 0.6) {
          bow.setDraw(0);
          bow.setArrow('off');
          break;
        }
        const home = Math.max(0, 1 - t / 0.012);
        const amp = 0.045 * THREE.MathUtils.clamp((k.snapZ - GRIP.brace) / BOW.draw, 0.2, 1);
        const z = GRIP.brace + (k.snapZ - GRIP.brace) * home - amp * Math.exp(-t / 0.09) * Math.sin(t * Math.PI * 2 * 21);
        vF.set(0, GRIP.restY, z);
        bow.setDraw(0, vF);
        bow.setArrow('off');
        break;
      }
      default:
        bow.setDraw(0);
        bow.setArrow('off');
    }
  }

  /** Lift the draw arm's elbow in line behind the arrow while drawing and shooting (the rig's IK drops it down and forward). */
  private elbow(k: Kit, s: ArcherState, dt: number) {
    const want = s.phase === 'draw' || s.phase === 'hold' || s.phase === 'release' ? 1 : s.phase === 'watch' ? 1 - THREE.MathUtils.smoothstep(s.t, 0.45, 1.1) : 0;
    k.elbow += (want - k.elbow) * Math.min(1, dt * 12);
    if (k.elbow < 0.01) return;
    const rig = k.rig;
    const sx = k.hs; // hands[1] is on the dominant side
    vS.set(sx * 0.2 * (rig.look.girth || 1), 0.47 * TORSO, 0).applyMatrix4(rig.body.matrix);
    vH.copy(rig.hands[1].position);
    // the rig's own pole: out, down and back
    vF.set(sx * 0.35, -0.45, 0.25);
    elbowAt(vE, vS, vH, vF);
    // ours: straight back from the target along the arrow, a little up
    vF.set(0, 0, 1).applyQuaternion(rig.racket.quaternion);
    vF.y = Math.max(vF.y, 0) + 0.35;
    elbowAt(vE2, vS, vH, vF);
    vE.lerp(vE2, k.elbow);
    const arm = rig.arms[1];
    segment(arm[0], vS, vE);
    segment(arm[1], vE, vH);
  }

  /** The rig drops its blob shadow on the ground: lift it onto the platform. */
  private shadow(k: Kit, s: ArcherState) {
    const sh = k.rig.shadow;
    if (onLine(s.x, s.z)) sh.position.y = LINE.top + 0.012;
  }

  dispose() {
    for (const k of this.kits) if (k) this.drop(k);
    this.kits = [];
  }
}
