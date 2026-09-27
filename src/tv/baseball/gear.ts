// Baseball's gear, drawn on the characters every frame: a wooden bat in each
// hitter's hands (grip tape in their colour) and a batting helmet on every
// hitter's head; the pitcher's glove; the catcher's mitt, mask and chest
// protector; and the ball while it's with the pitcher or the catcher (the
// venue draws it in flight — the handover is at the release point and in the
// mitt's pocket, which the animators put exactly there).
//
// Gear built for the racket slot (the bat, the glove, the mitt) is in the
// rig's root units, in the slot's space: the hand at the origin, +y up the bat
// or the glove's fingers, the glove's pocket facing +z (see anim.ts). The
// helmet and the mask are in the head's own space (the face towards −z, the
// head's sphere radius 0.3). Everything is one vertex-coloured mesh per piece
// with the world's own character material — a few draws a character — plus the
// outline the world gives its characters (the bat always gets a thin one, as
// the bow does: a thin stick has to read against the sky).
//
// Stage order: the hitters, then the pitcher, then the catcher (one colour each).

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit, CharRole } from '../worlds/types';
import type { Rig } from '../chars/rig';
import { TORSO, HEAD } from '../chars/rig';
import type { Particles } from '../render/particles';
import { outlineMaterial } from '../render/outline';
import { SwordTrail, trailStyle, SWORD } from '../duel/sword';
import { FIELD } from './field';
import type { BatterState, PitcherState, CatcherState, FieldBall } from './types';
import { BAT, BALL_OUT, MITT, GLOVE, THROW, MASK, FLIP, oneHanded, topHandOff, flipsBat } from './anim';

// ---------------------------------------------------------------- per-world colours

interface GearStyle {
  /** the bat's wood, its end, the knob's ring */
  wood: string;
  woodEnd: string;
  /** glove and mitt leather, the pocket, the lacing's default */
  leather: string;
  pocket: string;
  /** the mask's cage */
  cage: string;
  /** the ball, its seams */
  ball: string;
  seam: string;
  /** the helmet's material role (glossy where the world has gloss) */
  shell: CharRole;
}

const STYLE: Record<string, GearStyle> = {
  park: { wood: '#e3b47c', woodEnd: '#a06c3e', leather: '#a4592b', pocket: '#6e391b', cage: '#2c2b36', ball: '#fbf8f0', seam: '#d8322a', shell: 'racket' },
  plaza: { wood: '#f0c68e', woodEnd: '#a8703e', leather: '#b0612e', pocket: '#763c1c', cage: '#23294a', ball: '#ffffff', seam: '#e0302a', shell: 'racket' },
  ink: { wood: '#efe4cc', woodEnd: '#3b342d', leather: '#5a5046', pocket: '#2a2520', cage: '#15120f', ball: '#f5efe0', seam: '#15120f', shell: 'racket' },
  neon: { wood: '#2a1c52', woodEnd: '#22e6ff', leather: '#241640', pocket: '#120a26', cage: '#22e6ff', ball: '#ffffff', seam: '#ff3ea5', shell: 'hat' },
  pixel: { wood: '#ffccaa', woodEnd: '#ab5236', leather: '#ab5236', pocket: '#5f574f', cage: '#1d2b53', ball: '#fff1e8', seam: '#ff004d', shell: 'racket' },
  paper: { wood: '#ecca98', woodEnd: '#8b5a3c', leather: '#a8744a', pocket: '#6b4a32', cage: '#3d3540', ball: '#fffdf7', seam: '#d8322a', shell: 'racket' },
  clay: { wood: '#e4ac6c', woodEnd: '#8a5a38', leather: '#9a5a30', pocket: '#6b3a22', cage: '#3a2e2a', ball: '#fff8ea', seam: '#c83a2a', shell: 'racket' },
  water: { wood: '#f2d09c', woodEnd: '#9a7050', leather: '#b07a52', pocket: '#7a5238', cage: '#4a4e6a', ball: '#ffffff', seam: '#e0504a', shell: 'racket' },
  cosmic: { wood: '#d6e2ff', woodEnd: '#5ef2ff', leather: '#2e2458', pocket: '#150c2a', cage: '#5ef2ff', ball: '#ffffff', seam: '#ff8ad8', shell: 'racket' },
};

function gearStyle(world: string | undefined) {
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

/** A capsule between two points. */
function capsule(r: number, a: THREE.Vector3, b: THREE.Vector3, seg = 10) {
  const d = new THREE.Vector3().subVectors(b, a);
  const l = d.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(1e-3, l), 4, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function blob(sx: number, sy: number, sz: number, x: number, y: number, z: number, w = 16, h = 12) {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/** A tube through points (closed or not). */
function tube(pts: THREE.Vector3[], r: number, closed = false, seg = 48, radial = 6) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, closed, 'centripetal'), seg, r, radial, closed);
}

const C = (c: THREE.ColorRepresentation) => new THREE.Color(c);

// ---------------------------------------------------------------- the bat

/** A wooden bat along +y (bat space, root units — see BAT): tape and knob in the hitter's colour. */
function batGeometry(st: GearStyle, team: THREE.Color) {
  const prof: [number, number][] = [
    [0, BAT.knob],
    [0.027, BAT.knob + 0.002],
    [0.032, BAT.knob + 0.008],
    [0.032, BAT.knob + 0.016],
    [0.021, BAT.knob + 0.026],
    [BAT.handleR, BAT.knob + 0.036],
    [BAT.handleR, 0.082],
    [BAT.handleR * 1.04, 0.088],
    [0.019, BAT.taper],
    [0.023, 0.19],
    [0.029, 0.25],
    [0.034, 0.3],
    [BAT.barrelR, BAT.barrel],
    [BAT.barrelR, 0.6],
    [BAT.barrelR * 0.985, 0.628],
    [BAT.barrelR * 0.985, 0.632],
    [0.035, 0.645],
    [0.028, 0.655],
    [0.014, BAT.tip],
    [0, BAT.tip],
  ];
  const g = new THREE.LatheGeometry(
    prof.map(([r, y]) => new THREE.Vector2(r, y)),
    18,
  );
  const n = g.toNonIndexed();
  g.dispose();
  n.deleteAttribute('uv');
  const tape = team.clone();
  const knob = team.clone().multiplyScalar(0.7);
  const wood = C(st.wood);
  const end = C(st.woodEnd);
  const p = n.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  // colour each triangle by its middle, so the bands have crisp edges
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const c = y < BAT.knob + 0.03 ? knob : y < 0.085 ? tape : y > 0.63 ? end : wood;
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
  }
  n.setAttribute('color', new THREE.BufferAttribute(col, 3));
  n.computeVertexNormals();
  return n;
}

// ---------------------------------------------------------------- the helmet

/** The helmet's fit on each hair (head space): its shell's radii and centre, and what the hair does under it. */
interface Fit {
  r: [number, number, number];
  c: [number, number, number];
}

const FIT_DEFAULT: Fit = { r: [0.356, 0.35, 0.37], c: [0, 0.02, 0.014] };
const FIT: Partial<Record<string, Fit>> = {
  afro: { r: [0.452, 0.405, 0.448], c: [0, 0.1, 0.06] },
};

/**
 * A batting helmet in head space: a shell over the crown, down over the back of
 * the head and — on `flap` (−1 = the head's left) — an ear flap down the side
 * the pitcher sees; a rolled rim, and a short bill over the brow.
 */
function helmetGeometry(fit: Fit, flap: number) {
  const [rx, ry, rz] = fit.r;
  const [cx, cy, cz] = fit.c;
  const NA = 40,
    NP = 12;
  // how far down the shell comes (radians from the top) all round: over the brow at the front,
  // down the back, and down over the ear on the flap side
  const flapA = flap < 0 ? -Math.PI / 2 : Math.PI / 2;
  const rim = (a: number) => {
    const back = (1 - Math.cos(a)) / 2;
    const d = Math.abs(angleTo(a, flapA));
    const f = d < 0.95 ? Math.cos(((d / 0.95) * Math.PI) / 2) ** 2 : 0;
    return THREE.MathUtils.degToRad(64 + 40 * back + 40 * f);
  };
  // a = 0 at the front (−z), going round towards +x
  const pt = (a: number, th: number, grow = 0) =>
    new THREE.Vector3(cx + (rx + grow) * Math.sin(th) * Math.sin(a), cy + (ry + grow) * Math.cos(th), cz - (rz + grow) * Math.sin(th) * Math.cos(a));
  const pos: number[] = [];
  const grid: THREE.Vector3[][] = [];
  for (let j = 0; j <= NP; j++) {
    const row: THREE.Vector3[] = [];
    for (let i = 0; i <= NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      row.push(pt(a, (j / NP) * rim(a)));
    }
    grid.push(row);
  }
  for (let j = 0; j < NP; j++)
    for (let i = 0; i < NA; i++) {
      const a = grid[j][i],
        b = grid[j][i + 1],
        c = grid[j + 1][i],
        d = grid[j + 1][i + 1];
      // counter-clockwise seen from outside
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      pos.push(b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
    }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // smooth normals (a sphere's: from the centre, stretched)
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const v = new THREE.Vector3((pos[i] - cx) / (rx * rx), (pos[i + 1] - cy) / (ry * ry), (pos[i + 2] - cz) / (rz * rz)).normalize();
    nrm.set([v.x, v.y, v.z], i);
  }
  shell.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const parts: THREE.BufferGeometry[] = [paint(shell, C('#ffffff'))];
  // the rolled rim along the shell's edge
  const edge: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    edge.push(pt(a, rim(a), -0.004));
  }
  parts.push(paint(tube(edge, 0.017, true, 96, 6), C('#b8b8b8')));
  // the bill: a crescent over the brow, tipped down a touch
  const front = pt(0, rim(0));
  const s = new THREE.Shape();
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI;
    const x = Math.cos(t) * 0.215,
      y = Math.sin(t) * 0.15;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  for (let i = N; i >= 0; i--) {
    const t = (i / N) * Math.PI;
    s.lineTo(Math.cos(t) * 0.19, Math.sin(t) * 0.035 - 0.005);
  }
  const bill = new THREE.ExtrudeGeometry(s, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 4 });
  // shape (x, y) → head (x, −z forward), the extrusion upwards: lie it flat, then tip its front down
  bill.rotateX(-Math.PI / 2);
  bill.rotateX(-0.3);
  bill.translate(0, front.y - 0.012, front.z + 0.05);
  parts.push(paint(bill, C('#e2e2e2')));
  return merge(parts);
}

/** Shortest turn from b to a. */
function angleTo(a: number, b: number) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---------------------------------------------------------------- the glove, the mitt

/**
 * A fielder's glove (slot space, root units: the hand at 0, fingers +y, the
 * pocket facing +z; the thumb on `thumb`'s side of x). It swallows the hand.
 */
function gloveGeometry(st: GearStyle, team: THREE.Color, thumb: number) {
  const leather = C(st.leather);
  const dark = C(st.pocket);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const parts: THREE.BufferGeometry[] = [];
  // the palm and back of the hand
  parts.push(paint(blob(0.095, 0.105, 0.075, 0, 0.02, -0.005), leather));
  // four fingers, fanning a little, with a curl towards the pocket at the tips
  for (let k = 0; k < 4; k++) {
    const x = (k - 1.5) * 0.043 * -thumb;
    const tipX = x * 1.25;
    const len = 0.2 - Math.abs(k - 1.2) * 0.018;
    parts.push(paint(capsule(0.027, V(x, 0.06, 0.0), V(tipX, 0.06 + len, 0.018)), leather));
  }
  // the thumb, and the web between it and the first finger
  parts.push(paint(capsule(0.029, V(thumb * 0.07, -0.01, 0.02), V(thumb * 0.115, 0.14, 0.035)), leather));
  parts.push(paint(blob(0.042, 0.065, 0.014, thumb * 0.085, 0.17, 0.03), dark));
  // the pocket
  parts.push(paint(blob(0.07, 0.085, 0.02, -thumb * 0.005, 0.085, 0.05), dark));
  // the cuff, bound in the team's colour
  const cuff = new THREE.CylinderGeometry(0.078, 0.07, 0.05, 16, 1, false);
  cuff.scale(1, 1, 0.82);
  cuff.translate(0, -0.075, -0.005);
  parts.push(paint(cuff, team));
  // lacing across the fingertips
  parts.push(paint(tube([V(-0.1, 0.2, 0.02), V(-0.03, 0.245, 0.025), V(0.04, 0.245, 0.025), V(0.1, 0.2, 0.02)].map((v) => v.setX(v.x * -thumb)), 0.009, false, 24, 5), team));
  return merge(parts);
}

/** The catcher's mitt: a big round pillow with a deep pocket (slot space; the thumb on `thumb`'s side). */
function mittGeometry(st: GearStyle, team: THREE.Color, thumb: number) {
  const leather = C(st.leather);
  const dark = C(st.pocket);
  const parts: THREE.BufferGeometry[] = [];
  const cy = MITT.pocket.y;
  // the pillow
  parts.push(paint(blob(0.15, 0.155, 0.075, 0, cy, 0.0, 20, 14), leather));
  // the rolled, laced rim, in the team's colour
  const rim = new THREE.TorusGeometry(0.14, 0.028, 8, 32);
  rim.scale(1, 1.03, 1);
  rim.translate(0, cy, 0.018);
  parts.push(paint(rim, team));
  // the pocket: a darker dish on the front
  parts.push(paint(blob(0.095, 0.095, 0.022, -thumb * 0.008, cy, 0.058, 18, 10), dark));
  // the thumb lobe
  parts.push(paint(blob(0.055, 0.085, 0.055, thumb * 0.13, cy - 0.06, 0.012), leather));
  // the strap across the back
  const strap = new THREE.BoxGeometry(0.17, 0.05, 0.03);
  strap.translate(0, cy - 0.04, -0.07);
  parts.push(paint(strap, team));
  return merge(parts);
}

// ---------------------------------------------------------------- the jersey

/**
 * The torso's lathe profile in Rig (G.body: radius, height; the rig scales it
 * by girth across and TORSO up). The torso is round, so a turn of the chest
 * only shows where something on it turns with it: the jersey's number on the
 * back and its placket down the front do (a swing's power is the turn).
 */
const TORSO_PROFILE: [number, number][] = [
  [0.0, 0.0],
  [0.13, 0.004],
  [0.215, 0.04],
  [0.235, 0.12],
  [0.228, 0.22],
  [0.245, 0.34],
  [0.268, 0.45],
  [0.262, 0.52],
  [0.21, 0.58],
  [0.1, 0.615],
  [0.0, 0.625],
];

/** the torso's radius at height y (body space), for this girth */
function torsoR(y: number, girth: number) {
  const yl = y / TORSO;
  const P = TORSO_PROFILE;
  for (let i = 1; i < P.length; i++)
    if (yl <= P[i][1]) {
      const [r0, y0] = P[i - 1],
        [r1, y1] = P[i];
      return THREE.MathUtils.lerp(r0, r1, (yl - y0) / Math.max(1e-6, y1 - y0)) * girth;
    }
  return 0;
}

/** a point on the shirt: `a` round from the back (+z, towards +x), height y, `lift` off the cloth */
function onShirt(o: THREE.Vector3, a: number, y: number, girth: number, lift: number) {
  const r = torsoR(y, girth) + lift;
  return o.set(Math.sin(a) * r, y, Math.cos(a) * r);
}

/** A patch of the shirt's surface: `a0`…`a1` round, `y0`…`y1` up (body space), lifted off the cloth; facing out. */
function shirtPatch(a0: number, a1: number, y0: number, y1: number, girth: number, lift: number, c: THREE.Color, na = 3, ny = 2) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const v = new THREE.Vector3();
  const grid: THREE.Vector3[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: THREE.Vector3[] = [];
    for (let i = 0; i <= na; i++) row.push(onShirt(v, a0 + ((a1 - a0) * i) / na, y0 + ((y1 - y0) * j) / ny, girth, lift).clone());
    grid.push(row);
  }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < na; i++) {
      const a = grid[j][i],
        b = grid[j][i + 1],
        cc = grid[j + 1][i],
        d = grid[j + 1][i + 1];
      // counter-clockwise from outside (a goes round towards +x, up the rows)
      for (const p of [a, b, cc, b, d, cc]) {
        pos.push(p.x, p.y, p.z);
        const l = Math.hypot(p.x, p.z) || 1;
        nrm.push(p.x / l, 0, p.z / l);
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return paint(g, c);
}

/** a block numeral's bars (seven-segment, chunky), in a w × 1 box: [x0, y0, x1, y1] */
function digitBars(d: string, w: number, s: number): [number, number, number, number][] {
  const h = 1;
  const seg: Record<string, [number, number, number, number]> = {
    a: [0, h - s, w, h],
    b: [w - s, h / 2 - s / 2, w, h],
    c: [w - s, 0, w, h / 2 + s / 2],
    d: [0, 0, w, s],
    e: [0, 0, s, h / 2 + s / 2],
    f: [0, h / 2 - s / 2, s, h],
    g: [0, h / 2 - s / 2, w, h / 2 + s / 2],
  };
  if (d === '1')
    return [
      [w / 2 - s / 2, 0, w / 2 + s / 2, h],
      [w / 2 - s * 1.3, h - s, w / 2, h],
    ];
  const on: Record<string, string> = { '0': 'abcdef', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd' };
  return [...(on[d] ?? '')].map((k) => seg[k]);
}

/**
 * The jersey: a number on the back (outlined, in a light shade over a dark
 * one) and a placket down the front, laid on the shirt (body space).
 */
function jerseyGeometry(team: THREE.Color, girth: number, num: string) {
  const parts: THREE.BufferGeometry[] = [];
  const white = C('#ffffff');
  const fill = team.clone().lerp(white, 0.85);
  const edge = team.clone().multiplyScalar(0.38);
  const H = 0.17 * TORSO,
    W = 0.58,
    S = 0.24,
    gap = 0.2;
  const y0 = 0.36 * TORSO;
  const r = torsoR(y0 + H / 2, girth);
  // box units → angle round the back: the digits sit side by side, centred on the spine
  const unit = H / r;
  const total = num.length * W + (num.length - 1) * gap;
  const o = 0.07;
  for (let k = 0; k < num.length; k++) {
    const x0 = -total / 2 + k * (W + gap);
    for (const [bx0, by0, bx1, by1] of digitBars(num[k], W, S)) {
      // the outline a little bigger and a hair lower on the cloth, the fill over it
      parts.push(shirtPatch((x0 + bx0 - o) * unit, (x0 + bx1 + o) * unit, y0 + (by0 - o) * H, y0 + (by1 + o) * H, girth, 0.006, edge));
      parts.push(shirtPatch((x0 + bx0) * unit, (x0 + bx1) * unit, y0 + by0 * H, y0 + by1 * H, girth, 0.009, fill));
    }
  }
  // the placket down the front, and three buttons
  parts.push(shirtPatch(Math.PI - 0.07, Math.PI + 0.07, 0.25 * TORSO, 0.57 * TORSO, girth, 0.006, fill, 2, 6));
  for (const y of [0.33, 0.42, 0.51]) parts.push(shirtPatch(Math.PI - 0.035, Math.PI + 0.035, (y - 0.018) * TORSO, (y + 0.018) * TORSO, girth, 0.01, edge, 1, 1));
  return merge(parts);
}

/** the hitters' numbers, in batting order */
const NUMBERS = ['7', '23', '12', '44', '9', '31'];

// ---------------------------------------------------------------- the mask, the chest protector

/** The catcher's mask (head space): a cage of bars over the face in a padded frame. */
function maskGeometry(st: GearStyle, team: THREE.Color) {
  const cage = C(st.cage);
  const R = 0.37;
  const at = (a: number, y: number, r = R) => new THREE.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r);
  const parts: THREE.BufferGeometry[] = [];
  const top = 0.17,
    bot = -0.3;
  const aw = (y: number) => THREE.MathUtils.degToRad(56 - 14 * THREE.MathUtils.smoothstep(-y, 0.05, 0.3));
  // horizontal bars
  for (const y of [0.1, -0.02, -0.14, -0.24]) {
    const pts: THREE.Vector3[] = [];
    const w = aw(y);
    for (let i = 0; i <= 8; i++) pts.push(at(-w + (2 * w * i) / 8, y, R + 0.01 * Math.cos((i / 8 - 0.5) * Math.PI)));
    parts.push(paint(tube(pts, 0.011, false, 24, 5), cage));
  }
  // vertical bars
  for (const a of [-0.26, 0, 0.26]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const y = top - 0.02 - ((top - bot - 0.03) * i) / 6;
      pts.push(at(a * (1 - 0.25 * THREE.MathUtils.smoothstep(-y, 0.05, 0.3)), y, R + 0.012));
    }
    parts.push(paint(tube(pts, 0.011, false, 18, 5), cage));
  }
  // the padded frame round the edge
  const frame: THREE.Vector3[] = [];
  const W = aw(top);
  for (let i = 0; i <= 10; i++) frame.push(at(-W + (2 * W * i) / 10, top, R - 0.01));
  for (let i = 1; i <= 6; i++) {
    const y = top - ((top - bot) * i) / 6;
    frame.push(at(aw(y) + 0.02, y, R - 0.012));
  }
  const Wb = aw(bot);
  for (let i = 1; i < 10; i++) frame.push(at(Wb - (2 * Wb * i) / 10, bot, R - 0.012));
  for (let i = 0; i < 6; i++) {
    const y = bot + ((top - bot) * i) / 6;
    frame.push(at(-aw(y) - 0.02, y, R - 0.012));
  }
  parts.push(paint(tube(frame, 0.03, true, 96, 7), team));
  // pads at the temples, where it meets the head
  for (const s of [-1, 1]) parts.push(paint(blob(0.04, 0.075, 0.06, s * 0.3, 0.02, -0.19), team));
  return merge(parts);
}

/** A chest protector (body space): a padded plate over the front of the torso, in the team's colour. */
function chestGeometry(team: THREE.Color, girth: number) {
  const r = 0.278 * girth;
  const g = new THREE.CylinderGeometry(r * 0.93, r, 0.4 * TORSO, 20, 5, true, Math.PI - 1.15, 2.3);
  g.translate(0, 0.37 * TORSO, 0);
  const n = paint(g, team);
  // darker pad seams
  const p = n.attributes.position as THREE.BufferAttribute;
  const col = n.attributes.color as THREE.BufferAttribute;
  const dark = team.clone().multiplyScalar(0.72);
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3 / TORSO;
    const band = Math.abs(((y - 0.17) / 0.08) % 1) < 0.16;
    if (band) for (let k = 0; k < 3; k++) col.setXYZ(i + k, dark.r, dark.g, dark.b);
  }
  // both sides (it's a thin plate)
  const back = n.clone();
  const idx = back.attributes.position.count;
  const bp = back.attributes.position as THREE.BufferAttribute;
  const bn = back.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < idx; i += 3) {
    // swap two corners, flip the normals, and pull it in a hair
    for (const a of [bp, bn]) {
      const x = a.getX(i + 1),
        y = a.getY(i + 1),
        z = a.getZ(i + 1);
      a.setXYZ(i + 1, a.getX(i + 2), a.getY(i + 2), a.getZ(i + 2));
      a.setXYZ(i + 2, x, y, z);
    }
    for (let k = 0; k < 3; k++) bn.setXYZ(i + k, -bn.getX(i + k), -bn.getY(i + k), -bn.getZ(i + k));
  }
  for (let i = 0; i < idx; i++) bp.setXYZ(i, bp.getX(i) * 0.985, bp.getY(i), bp.getZ(i) * 0.985);
  return merge([n, back]);
}

// ---------------------------------------------------------------- the ball

let seamTex: THREE.Texture | null = null;
function seamTexture(ball: string, seam: string) {
  const key = ball + seam;
  if (seamTex && seamTex.userData.key === key) return seamTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = ball;
  x.fillRect(0, 0, 256, 128);
  // the two seams: the tennis ball's curve, stitched
  x.strokeStyle = seam;
  x.lineWidth = 3;
  const a = 0.75,
    b = 0.25,
    cc = 2 * Math.sqrt(a * b);
  let prev: [number, number] | null = null;
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= 480; i++) {
    const t = (i / 480) * Math.PI * 2;
    const px = a * Math.cos(t) + b * Math.cos(3 * t);
    const py = a * Math.sin(t) - b * Math.sin(3 * t);
    const pz = cc * Math.sin(2 * t);
    const lon = Math.atan2(py, px);
    const lat = Math.asin(Math.max(-1, Math.min(1, pz)));
    const u = ((lon / (Math.PI * 2) + 1) % 1) * 256;
    const v = (0.5 - lat / Math.PI) * 128;
    pts.push([u, v, t]);
    if (prev && Math.abs(prev[0] - u) < 100) {
      x.beginPath();
      x.moveTo(prev[0], prev[1]);
      x.lineTo(u, v);
      x.stroke();
    }
    prev = [u, v];
  }
  // stitches: little ticks across the seam
  x.lineWidth = 1.6;
  for (let i = 2; i < pts.length - 2; i += 6) {
    const [u0, v0] = pts[i - 2],
      [u1, v1] = pts[i + 2];
    if (Math.abs(u1 - u0) > 50) continue;
    const [u, v] = pts[i];
    let nx = -(v1 - v0),
      ny = u1 - u0;
    const l = Math.hypot(nx, ny) || 1;
    nx = (nx / l) * 3.5;
    ny = (ny / l) * 3.5;
    x.beginPath();
    x.moveTo(u - nx, v - ny);
    x.lineTo(u + nx, v + ny);
    x.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.key = key;
  seamTex = tex;
  return tex;
}

/** How much bigger a ball this far (metres) from the camera is drawn, so it never shrinks to a speck (the tennis ball's rule). */
export function ballDrawScale(dist: number) {
  return THREE.MathUtils.clamp(1 + (dist - 9) * 0.045, 1, 2.1);
}

// ---------------------------------------------------------------- the gear

/** The parts of a World that BaseballGear uses. */
export interface BaseballWorldLike {
  scene: THREE.Scene;
  kit: MaterialKit;
  rigs: Rig[];
  particles?: Particles;
  def?: { id: string };
}

/** What the gear draws each frame: the characters' states in stage order, and the ball. */
export interface BaseballChars {
  hitters: readonly BatterState[];
  pitcher: PitcherState;
  catcher: CatcherState;
  ball: FieldBall;
  /** the camera's position (FieldView.eye): the ball in a hand is drawn as big as the venue draws a flying one */
  eye?: { x: number; y: number; z: number };
}

/** The bat flying free (a flip): world space. */
interface Flight {
  v: THREE.Vector3;
  w: THREE.Vector3;
  t: number;
  bounces: number;
  rest: number;
}

interface HitterKit {
  rig: Rig;
  bat: THREE.Group;
  helmet: THREE.Mesh;
  jersey: THREE.Mesh;
  /** the swoosh the barrel leaves through the swing, and what it reads the bat through */
  trail: SwordTrail;
  blade: THREE.Object3D;
  hs: 1 | -1;
  phase: string;
  from: string;
  one: boolean;
  /** the bat's been flipped this cheer (and where it is now: flying, or lying where it came down) */
  flipped: boolean;
  flight: Flight | null;
  /** 0 → 1: the bat popping back into the hands */
  pop: number;
  /** hair meshes hidden under the helmet, hair moved to fit under it: put back on dispose */
  hidden: THREE.Object3D[];
  moved: { o: THREE.Object3D; p: THREE.Vector3; s: THREE.Vector3 }[];
}

interface PitcherKit {
  rig: Rig;
  glove: THREE.Group;
  hs: 1 | -1;
  hand: THREE.Object3D[];
}

interface CatcherKit {
  rig: Rig;
  mitt: THREE.Group;
  mask: THREE.Mesh;
  chest: THREE.Mesh;
  hand: THREE.Object3D[];
  maskOn: boolean;
  phase: string;
  from: string;
}

/** seconds a throw back sits in the pitcher's glove before it's in the throwing hand */
const GLOVED = 0.35;
const smooth01 = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

const UP = new THREE.Vector3(0, 1, 0);
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const mA = new THREE.Matrix4();

/**
 * Everything the characters carry in a Home Run Derby. One per world; call
 * update() every frame after world.update() (the rigs have their poses then),
 * dispose() when baseball ends. `colors`: one per character, stage order.
 */
export class BaseballGear {
  private hitters: (HitterKit | null)[] = [];
  private pitcher: PitcherKit | null = null;
  private catcher: CatcherKit | null = null;
  private world: string | undefined;
  private st: GearStyle;
  private ball: THREE.Mesh;
  private ballMat: THREE.Material;
  /** the ball's phase last frame, and how long since a throw came into the pitcher's glove (−1: not now) */
  private ballPhase: FieldBall['phase'] | '' = '';
  private gloved = -1;
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];

  constructor(
    private w: BaseballWorldLike,
    private colors: THREE.ColorRepresentation[],
  ) {
    this.world = w.def?.id;
    this.st = gearStyle(this.world);
    // the ball
    const g = new THREE.SphereGeometry(FIELD.ballR, 24, 16);
    this.geos.push(g);
    const m = w.kit.char('racket', C('#ffffff'));
    const tex = seamTexture(this.st.ball, this.st.seam);
    const mm = m as THREE.MeshStandardMaterial;
    if ('map' in mm && !(m as THREE.ShaderMaterial).isShaderMaterial) {
      mm.map = tex;
      mm.needsUpdate = true;
    } else (m as unknown as { color: THREE.Color }).color?.set(this.st.ball);
    this.ballMat = m;
    this.mats.push(m);
    this.ball = new THREE.Mesh(g, m);
    this.ball.name = 'baseball-held';
    this.ball.castShadow = false;
    this.ball.visible = false;
    this.ball.renderOrder = 3;
    w.scene.add(this.ball);
  }

  /** The bat hitter i swings (null until the first update). */
  bat(i: number) {
    return this.hitters[i]?.bat ?? null;
  }

  // ---------------------------------------------------------------- building

  private mat(role: CharRole, color: THREE.ColorRepresentation) {
    const m = this.w.kit.char(role, C(color));
    (m as THREE.MeshStandardMaterial).vertexColors = true;
    this.mats.push(m);
    return m;
  }

  /** The outline a worn thing gets: the world's character outline (in this character's colour where the world does that). */
  private wornHull(rig: Rig, mesh: THREE.Mesh, scale = 1) {
    const k = this.w.kit;
    if (!k.outline) return null;
    const hb = smoothHull(mesh.geometry);
    this.geos.push(hb);
    const h = new THREE.Mesh(hb, outlineMaterial(k.outlineColor?.(rig.look) ?? k.outline.color, k.outline.width * scale, { emissive: k.outline.emissive }));
    h.name = 'outline';
    h.castShadow = false;
    mesh.add(h);
    return h;
  }

  /** A held thing's outline: the style's own, or a thin dark one where nothing else draws edges (as the bow). */
  private heldHull(rig: Rig, mesh: THREE.Mesh, scale = 0.8) {
    const k = this.w.kit;
    const oc = k.outline ? { color: k.outlineColor?.(rig.look) ?? k.outline.color, width: k.outline.width, emissive: k.outline.emissive } : this.world === 'ink' || this.world === 'pixel' ? null : { color: C('#1f1b30'), width: 0.011, emissive: 1 };
    if (!oc) return null;
    const hb = smoothHull(mesh.geometry);
    this.geos.push(hb);
    const h = new THREE.Mesh(hb, outlineMaterial(oc.color, oc.width * scale, { emissive: oc.emissive }));
    h.name = 'outline';
    h.castShadow = false;
    mesh.add(h);
    return h;
  }

  private makeHitter(i: number, rig: Rig, s: BatterState | undefined): HitterKit {
    const team = C(this.colors[i] ?? '#ffffff');
    const hs = s?.handed ?? 1;
    // the bat, in the racket slot
    const bg = batGeometry(this.st, team);
    this.geos.push(bg);
    const batMesh = new THREE.Mesh(bg, this.mat('racket', '#ffffff'));
    batMesh.name = 'bat-mesh';
    batMesh.castShadow = !!this.w.kit.castShadow;
    this.heldHull(rig, batMesh, 0.75);
    const bat = new THREE.Group();
    bat.name = 'bat';
    bat.userData.bat = true;
    bat.add(batMesh);
    equip(rig, bat);
    // the helmet, on the head
    const helmet = this.makeHelmet(rig, team, hs);
    // the jersey's number and placket, on the shirt (in the shirt's own colour)
    const jg = jerseyGeometry(C(rig.look.shirt), rig.look.girth || 1, NUMBERS[i % NUMBERS.length]);
    this.geos.push(jg);
    const jersey = new THREE.Mesh(jg, this.mat(this.world === 'neon' ? 'racket' : 'shirt', '#ffffff'));
    jersey.name = 'jersey';
    jersey.castShadow = false;
    jersey.userData.noOutline = true;
    rig.body.add(jersey);
    // the swoosh: the duel's sword trail, reading the barrel through a stand-in "blade" whose
    // tip and base (SWORD space) land on the bat's end and where the barrel starts
    const blade = new THREE.Object3D();
    const a = (BAT.tip - 0.02 - BAT.barrel + 0.05) / (SWORD.tip - 0.02 - (SWORD.blade + (SWORD.tip - SWORD.blade) * 0.3));
    blade.scale.set(1, a, 1);
    blade.position.y = BAT.tip - 0.02 - a * (SWORD.tip - 0.02);
    batMesh.add(blade);
    const trail = new SwordTrail({ ...trailStyle(this.world, team), life: 0.15 });
    this.w.scene.add(trail.mesh);
    const k: HitterKit = { rig, bat, helmet, jersey, trail, blade, hs, phase: '', from: '', one: false, flipped: false, flight: null, pop: 1, hidden: [], moved: [] };
    this.fitHair(k);
    return k;
  }

  private makeHelmet(rig: Rig, team: THREE.Color, hs: 1 | -1) {
    const fit = FIT[rig.look.hair] ?? FIT_DEFAULT;
    const g = helmetGeometry(fit, -hs);
    this.geos.push(g);
    const m = this.w.kit.char(this.st.shell, team);
    (m as THREE.MeshStandardMaterial).vertexColors = true;
    this.mats.push(m);
    const helmet = new THREE.Mesh(g, m);
    helmet.name = 'helmet';
    helmet.castShadow = !!this.w.kit.castShadow;
    helmet.userData.baseball = true;
    this.wornHull(rig, helmet);
    rig.head.add(helmet);
    return helmet;
  }

  /**
   * Make the hair sit under the helmet: hats come off (the helmet replaces a
   * cap or a beanie), what would poke through the shell is hidden (spikes, a
   * mohawk, a crown), a bun and a ponytail drop to the back of the neck where
   * they show below the rim. Hair that hangs below the rim (a bob, a bowl, a
   * headband, an afro's sides) stays.
   */
  private fitHair(k: HitterKit) {
    const head = k.rig.head;
    // the head's children: the head sphere, the face, then the hair (Rig.buildHair's order)
    const hair = head.children.slice(2).filter((o) => !o.userData.baseball);
    const hide = (o: THREE.Object3D | undefined) => {
      if (!o || !o.visible) return;
      o.visible = false;
      k.hidden.push(o);
    };
    const move = (o: THREE.Object3D | undefined, x: number, y: number, z: number, s = 1) => {
      if (!o) return;
      k.moved.push({ o, p: o.position.clone(), s: o.scale.clone() });
      o.position.set(x, y, z);
      o.scale.multiplyScalar(s);
    };
    switch (k.rig.look.hair) {
      case 'cap':
      case 'beanie':
      case 'mohawk':
        hair.forEach(hide);
        break;
      case 'spiky':
      case 'crown':
        // the base stays, the spikes (or the crown) go
        hair.slice(1).forEach(hide);
        break;
      case 'bun':
        // a low bun at the nape
        move(hair[1], 0, -0.1, 0.3, 0.85);
        break;
      case 'pony':
        // the tail out from under the back of the helmet
        move(hair[1], 0, -0.1, 0.34);
        break;
    }
  }

  private dropHitter(k: HitterKit) {
    unequip(k.rig);
    k.bat.removeFromParent();
    k.helmet.removeFromParent();
    k.jersey.removeFromParent();
    k.trail.dispose();
    for (const o of k.hidden) o.visible = true;
    for (const m of k.moved) {
      m.o.position.copy(m.p);
      m.o.scale.copy(m.s);
    }
  }

  private makePitcher(i: number, rig: Rig, s: PitcherState): PitcherKit {
    const team = C(this.colors[i] ?? '#ffffff');
    const hs = s.handed;
    // the glove's in the racket slot, on the glove hand (a right-hander's left: the thumb on the slot's −x)
    const gg = gloveGeometry(this.st, team, -hs);
    this.geos.push(gg);
    const gm = new THREE.Mesh(gg, this.mat(this.world === 'neon' ? 'racket' : 'shoe', '#ffffff'));
    gm.name = 'glove-mesh';
    gm.castShadow = !!this.w.kit.castShadow;
    this.wornHull(rig, gm, 0.8);
    const glove = new THREE.Group();
    glove.name = 'glove';
    glove.userData.bat = true;
    glove.add(gm);
    equip(rig, glove);
    // the glove swallows the hand
    const hand = hideHand(rig, 0);
    return { rig, glove, hs, hand };
  }

  private dropPitcher(k: PitcherKit) {
    unequip(k.rig);
    k.glove.removeFromParent();
    for (const o of k.hand) o.visible = true;
  }

  private makeCatcher(i: number, rig: Rig): CatcherKit {
    const team = C(this.colors[i] ?? '#ffffff');
    const mg = mittGeometry(this.st, team, -1);
    this.geos.push(mg);
    const mm = new THREE.Mesh(mg, this.mat(this.world === 'neon' ? 'racket' : 'shoe', '#ffffff'));
    mm.name = 'mitt-mesh';
    mm.castShadow = !!this.w.kit.castShadow;
    this.wornHull(rig, mm, 0.8);
    const mitt = new THREE.Group();
    mitt.name = 'mitt';
    mitt.userData.bat = true;
    mitt.add(mm);
    equip(rig, mitt);
    const hand = hideHand(rig, 0);
    // the mask on the face
    const kg = maskGeometry(this.st, team);
    this.geos.push(kg);
    const mask = new THREE.Mesh(kg, this.mat(this.world === 'neon' ? 'racket' : 'grip', '#ffffff'));
    mask.name = 'mask';
    mask.castShadow = !!this.w.kit.castShadow;
    mask.userData.baseball = true;
    rig.head.add(mask);
    // the chest protector
    const cg = chestGeometry(team, rig.look.girth || 1);
    this.geos.push(cg);
    const chest = new THREE.Mesh(cg, this.mat(this.st.shell, '#ffffff'));
    chest.name = 'chest-protector';
    chest.castShadow = !!this.w.kit.castShadow;
    rig.body.add(chest);
    this.wornHull(rig, chest, 0.7);
    return { rig, mitt, mask, chest, hand, maskOn: true, phase: '', from: '' };
  }

  private dropCatcher(k: CatcherKit) {
    unequip(k.rig);
    k.mitt.removeFromParent();
    k.mask.removeFromParent();
    k.chest.removeFromParent();
    for (const o of k.hand) o.visible = true;
  }

  // ---------------------------------------------------------------- per frame

  /** After world.update(): the gear on the rigs (re-made if the rigs were rebuilt), the bats, the mask, the ball. */
  update(c: BaseballChars, dt: number) {
    const rigs = this.w.rigs;
    const n = c.hitters.length;
    for (let i = 0; i < Math.max(n, this.hitters.length); i++) {
      const rig = i < n ? rigs[i] : undefined;
      let k = this.hitters[i] ?? null;
      if (k && k.rig !== rig) {
        this.dropHitter(k);
        k = null;
      }
      if (!k && rig) k = this.makeHitter(i, rig, c.hitters[i]);
      this.hitters[i] = k;
      if (k) this.updateHitter(k, c.hitters[i], dt);
    }
    this.hitters.length = n;
    // the pitcher and the catcher follow the hitters
    const pr = rigs[n],
      cr = rigs[n + 1];
    if (this.pitcher && (this.pitcher.rig !== pr || this.pitcher.hs !== c.pitcher.handed)) {
      this.dropPitcher(this.pitcher);
      this.pitcher = null;
    }
    if (!this.pitcher && pr) this.pitcher = this.makePitcher(n, pr, c.pitcher);
    if (this.catcher && this.catcher.rig !== cr) {
      this.dropCatcher(this.catcher);
      this.catcher = null;
    }
    if (!this.catcher && cr) this.catcher = this.makeCatcher(n + 1, cr);
    if (this.catcher) this.updateCatcher(this.catcher, c.catcher);
    this.updateBall(c, dt);
  }

  private updateHitter(k: HitterKit, s: BatterState, dt: number) {
    if (s.phase !== k.phase) {
      k.from = k.phase;
      k.phase = s.phase;
      if (s.phase === 'swing') k.one = oneHanded(s.power, s.lift);
    }
    if (s.handed !== k.hs) {
      k.hs = s.handed;
      k.helmet.removeFromParent();
      k.helmet.geometry.dispose();
      k.helmet = this.makeHelmet(k.rig, C(this.colors[this.hitters.indexOf(k)] ?? '#ffffff'), k.hs);
    }
    const rig = k.rig;
    const bat = k.bat;
    // the flip: a cheer at the plate lets the bat go at FLIP.release
    const cheer = s.phase === 'cheer' && flipsBat(k.from);
    if (cheer && s.t >= FLIP.release && !k.flipped) this.release(k, s);
    if (k.flipped && !cheer) {
      // back in the hands (a pop), for whatever comes next
      k.flipped = false;
      k.flight = null;
      equip(rig, bat);
      bat.position.set(0, 0, 0);
      bat.quaternion.identity();
      k.pop = 0;
    }
    if (k.flipped) {
      this.fly(k, dt);
      k.trail.update(rig, k.blade, false, dt);
      return;
    }
    // in the hands: normally held by the top hand (the slot's origin); through a one-handed
    // finish, hung from the bottom hand
    const off = topHandOff(s.phase, s.t, k.one, k.from);
    if (off > 0) {
      const dir = vA.set(0, 1, 0).applyQuaternion(rig.racket.quaternion);
      // the grip the bat would be held at: the bottom hand, up the handle
      vB.copy(rig.hands[1].position).addScaledVector(dir, -BAT.bottom).sub(rig.hands[0].position);
      qA.copy(rig.racket.quaternion).invert();
      bat.position.copy(vB.applyQuaternion(qA));
    } else bat.position.set(0, 0, 0);
    bat.quaternion.identity();
    if (k.pop < 1) {
      k.pop = Math.min(1, k.pop + dt / 0.2);
      const u = k.pop;
      bat.scale.setScalar(Math.max(0.001, 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2)));
    } else bat.scale.setScalar(1);
    // the swoosh through the whip: from the bat laid back to the roll-over
    k.trail.update(rig, k.blade, s.phase === 'swing' && s.t > 0.06 && s.t < 0.3, dt);
  }

  /** Let go of the bat: it flies from where it is, up and away off the plate's side, spinning end over end. */
  private release(k: HitterKit, s: BatterState) {
    const rig = k.rig;
    const bat = k.bat;
    rig.root.updateMatrixWorld(true);
    this.w.scene.attach(bat);
    const h = s.handed;
    // batter's frame in the world: A (towards the pitcher) = −z, Pl (towards the plate) = +h x
    const v = new THREE.Vector3(-1.5 * h, 5.0, -0.9);
    const d = vA.set(0, 1, 0).applyQuaternion(bat.getWorldQuaternion(qA));
    const axis = new THREE.Vector3().crossVectors(d, v).normalize();
    if (axis.lengthSq() < 1e-6) axis.set(h, 0, 0);
    k.flight = { v, w: axis.multiplyScalar(14), t: 0, bounces: 0, rest: 0 };
    k.flipped = true;
  }

  /** The flipped bat: a spinning arc, a clatter of bounces, then lying on the dirt. */
  private fly(k: HitterKit, dt: number) {
    const f = k.flight;
    const bat = k.bat;
    if (!f) return;
    f.t += dt;
    if (f.rest >= 1) return;
    const sc = k.rig.scale;
    f.v.y -= FIELD.gravity * dt;
    bat.position.addScaledVector(f.v, dt);
    const wl = f.w.length();
    if (wl > 1e-4) {
      qA.setFromAxisAngle(vA.copy(f.w).divideScalar(wl), wl * dt);
      bat.quaternion.premultiply(qA);
    }
    // the ends: which is lowest?
    const r = BAT.barrelR * sc;
    const d = vA.set(0, 1, 0).applyQuaternion(bat.quaternion);
    const yk = bat.position.y + d.y * BAT.knob * sc,
      yt = bat.position.y + d.y * BAT.tip * sc;
    const low = Math.min(yk, yt);
    if (low < r) {
      bat.position.y += r - low;
      if (f.v.y < 0) {
        const hard = -f.v.y;
        f.v.y = hard > 1.2 ? hard * 0.32 : 0;
        f.v.x *= 0.55;
        f.v.z *= 0.55;
        f.w.multiplyScalar(0.45);
        f.bounces++;
        if (hard > 1.5 && this.w.particles) this.dust(bat.position, hard);
      }
      // slow enough: lie down flat
      if (f.v.y === 0 || f.bounces > 3) {
        f.rest = Math.min(1, f.rest + dt / 0.22);
        f.w.multiplyScalar(Math.exp(-10 * dt));
        f.v.multiplyScalar(Math.exp(-12 * dt));
        // turn towards lying along the ground (the bat's axis level)
        const flat = vB.set(d.x, 0, d.z);
        if (flat.lengthSq() < 1e-6) flat.set(1, 0, 0);
        flat.normalize();
        qB.setFromUnitVectors(d, flat);
        qA.identity().slerp(qB, Math.min(1, dt * 10));
        bat.quaternion.premultiply(qA);
        // the barrel rests on the ground (the knob's thinner: a slight tilt is right)
        const d2 = vC.set(0, 1, 0).applyQuaternion(bat.quaternion);
        const mid = (BAT.barrel + BAT.tip) / 2;
        bat.position.y += (BAT.barrelR * sc - (bat.position.y + d2.y * mid * sc)) * Math.min(1, dt * 12);
      }
    }
  }

  private dust(p: THREE.Vector3, hard: number) {
    const P = this.w.particles!;
    const hot = this.world === 'neon' || this.world === 'cosmic';
    const col = this.world === 'neon' ? C('#22e6ff').multiplyScalar(2) : this.world === 'cosmic' ? C('#a86bff').multiplyScalar(2) : C(this.world === 'ink' ? '#3b342d' : '#e8d8bc');
    P.burst({ x: p.x, y: 0.05, z: p.z, count: Math.round(3 + hard * 1.5), speed: [0.3, 1.1], dir: [0, 1, 0], spread: 0.95, life: [0.35, 0.6], size: hot ? [0.06, 0.1] : [0.12, 0.22], shrink: hot ? 0.2 : 1.7, colors: [col], shape: this.world === 'pixel' ? 'square' : 'soft', alpha: hot ? 1 : 0.6, drag: 4, gravity: -0.3 });
  }

  private updateCatcher(k: CatcherKit, s: CatcherState) {
    if (s.phase !== k.phase) {
      k.from = k.phase;
      k.phase = s.phase;
    }
    // the mask: off into the throwing hand while watching a ball in play, back on in the next crouch
    let on = k.maskOn;
    if (s.phase === 'watch') on = s.t < MASK.grab;
    else if (s.phase === 'crouch' && k.from === 'watch') on = s.t >= MASK.on;
    else on = true;
    if (on !== k.maskOn) {
      k.maskOn = on;
      if (on) {
        k.rig.head.add(k.mask);
        k.mask.position.set(0, 0, 0);
        k.mask.quaternion.identity();
        k.mask.scale.setScalar(1);
      } else {
        // held by its frame in the throwing hand, the cage facing out
        k.rig.hands[1].add(k.mask);
        k.mask.scale.setScalar(HEAD);
        k.mask.quaternion.setFromEuler(new THREE.Euler(0.3, -1.9, 0.2));
        k.mask.position.set(0.02, -0.12, 0.02);
      }
    }
  }

  /**
   * The ball while it's the characters': in the pitcher's throwing hand
   * ('hand'), in the mitt ('mitt') — and out of it into the catcher's throwing
   * hand for the throw back, until the game lets it fly (a 'pitch' ball again,
   * the venue's) — and, as the throw comes into the pitcher's glove (back to
   * 'hand'), in the glove's pocket a moment till the throwing hand has it.
   */
  private updateBall(c: BaseballChars, dt: number) {
    const b = c.ball;
    const ball = this.ball;
    const P = this.pitcher,
      K = this.catcher;
    const at = vC;
    const prev = this.ballPhase;
    this.ballPhase = b.phase;
    // a throw from the catcher just came into the glove (a pitch never goes back to 'hand' otherwise)
    if (b.phase === 'hand' && prev === 'pitch') this.gloved = 0;
    else if (b.phase !== 'hand') this.gloved = -1;
    let shown = !!P && !!K;
    if (!P || !K) {
      // nobody to hold it
    } else if (b.phase === 'hand') {
      this.throwingHand(P, at);
      if (this.gloved >= 0 && this.gloved < GLOVED) {
        // just caught: in the pocket, then into the throwing hand as it comes over
        this.gloved += dt;
        this.glovePocket(P, vB);
        at.lerpVectors(vB, at, smooth01(this.gloved / GLOVED));
      }
    } else if (b.phase === 'mitt') {
      const s = c.catcher;
      if (s.phase === 'throw' && s.t >= THROW.take) this.catcherHand(K, at);
      else this.pocket(K, at);
    } else shown = false;
    ball.visible = shown;
    if (!shown) return;
    ball.position.copy(at);
    ball.rotation.set(0, 0, 0);
    ball.scale.setScalar(c.eye ? ballDrawScale(Math.hypot(at.x - c.eye.x, at.y - c.eye.y, at.z - c.eye.z)) : 1);
  }

  /** The ball in a throwing hand (hands[1], on the `side` shoulder): out along the arm from the hand, as anim.ts puts it. */
  private inHand(rig: Rig, side: number, o: THREE.Vector3) {
    rig.root.updateMatrixWorld(true);
    // the shoulder, as Rig.apply places it
    rig.body.updateMatrix();
    vA.set(side * 0.2 * (rig.look.girth || 1), 0.47 * TORSO, 0).applyMatrix4(rig.body.matrix);
    const hand = rig.hands[1].position;
    vB.subVectors(hand, vA);
    const l = vB.length() || 1;
    o.copy(hand).addScaledVector(vB, BALL_OUT / l);
    return o.applyMatrix4(rig.root.matrixWorld);
  }

  /** The ball in the pitcher's throwing hand (on the release point at DELIVERY.release). */
  private throwingHand(k: PitcherKit, o: THREE.Vector3) {
    return this.inHand(k.rig, k.hs, o);
  }

  /** The ball in the catcher's throwing hand, his right (on TOSS at THROW.release). */
  private catcherHand(k: CatcherKit, o: THREE.Vector3) {
    return this.inHand(k.rig, 1, o);
  }

  /** The catcher's pocket (world). */
  private pocket(k: CatcherKit, o: THREE.Vector3) {
    k.rig.root.updateMatrixWorld(true);
    o.set(MITT.pocket.x, MITT.pocket.y, MITT.pocket.z);
    return o.applyMatrix4(k.mitt.matrixWorld);
  }

  /** The pitcher's glove pocket (world). */
  private glovePocket(k: PitcherKit, o: THREE.Vector3) {
    k.rig.root.updateMatrixWorld(true);
    o.set(GLOVE.pocket.x, GLOVE.pocket.y, GLOVE.pocket.z);
    return o.applyMatrix4(k.glove.matrixWorld);
  }

  dispose() {
    for (const k of this.hitters) if (k) this.dropHitter(k);
    if (this.pitcher) this.dropPitcher(this.pitcher);
    if (this.catcher) this.dropCatcher(this.catcher);
    this.hitters = [];
    this.pitcher = null;
    this.catcher = null;
    this.ball.removeFromParent();
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
    this.geos = [];
    this.mats = [];
  }
}

// ---------------------------------------------------------------- the racket slot, the hands

/** Put a piece of gear in the rig's racket slot, the racket's own meshes hidden (not the group). */
function equip(rig: Rig, o: THREE.Object3D) {
  const r = rig.racket;
  for (const c of r.children) {
    if (c.userData.bat || c === o) continue;
    if (c.userData.baseballWasVisible === undefined) c.userData.baseballWasVisible = c.visible;
    c.visible = false;
  }
  if (r.userData.baseballWasVisible === undefined) r.userData.baseballWasVisible = r.visible;
  r.visible = true;
  if (o.parent !== r) r.add(o);
}

/** Take the gear out of the racket slot and bring the racket back. */
function unequip(rig: Rig) {
  const r = rig.racket;
  for (const c of [...r.children]) {
    if (c.userData.bat) {
      r.remove(c);
      continue;
    }
    if (c.userData.baseballWasVisible !== undefined) {
      c.visible = c.userData.baseballWasVisible;
      delete c.userData.baseballWasVisible;
    }
  }
  if (r.userData.baseballWasVisible !== undefined) {
    r.visible = r.userData.baseballWasVisible;
    delete r.userData.baseballWasVisible;
  }
}

/** Hide a hand's own meshes (a glove goes on it); returns them, to show again. */
function hideHand(rig: Rig, i: number) {
  const out: THREE.Object3D[] = [];
  for (const c of rig.hands[i].children) {
    if (c.visible) {
      c.visible = false;
      out.push(c);
    }
  }
  return out;
}

// silence unused imports kept for the helpers' types
void mA;
void UP;
