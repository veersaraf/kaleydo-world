// The bowling venue: five lanes where the tennis court stands, with pins, a
// ball and an aim guide. Everything is built from the world's MaterialKit, so
// each art style draws it its own way (toon + outlines, PBR, ink, pixels…).
//
// Layout (world metres, see lane.ts): lanes run along −z, the player's lane is
// centred on x = 0 and neighbours sit at ±LANE.pitch. The lane surface is y = 0.
//
// Nothing is drawn below y = 0. Every world has its own ground a few cm under
// the court (paper's cardboard slab is exactly at 0), and it would cover a real
// channel. So the gutters are flat strips at lane level with curved normals
// (they shade like a channel) and the pit is a dark floor with a curtain behind
// it: a ball in the gutter sinks half out of sight, pins that fall in the pit
// vanish — which is what you see from the approach anyway.
//
// Roles picked from the kit (they mean different things per world):
//   'racket'   accents: pins, balls, markings, trims — glossy, and glowing in neon
//   'eyeWhite' the lit sign on the masking unit — unlit in most worlds
//   'hair'     the semi-gloss lane wood, 'shoe' gutters, 'grip' capping,
//   'shirt'    matte structure, 'gold' the ball-return rails,
//   'shorts'   the dark pit / holes (dark in every world; 'eye' glows in neon)
// A few per-surface adjustments on top (see MatOpts): big surfaces don't take a
// racket's full HDR glow, flat structures get less rim light, and the fine board
// grain is skipped on flat-shaded styles.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit, CharRole } from '../worlds/types';
import { outlineTree } from '../render/outline';
import { blobShadowTexture } from '../chars/rig';
import { canvasTex } from '../worlds/mats';
import { Rng } from '../core/math';
import { LANE, FOUL_Z, HEAD_Z, PIT_Z, pinSpots, PIN_PROFILE } from './lane';
import type { BowlView } from './types';

const P = LANE.pitch;
const HW = LANE.width / 2;
const GW = LANE.gutter;
/** lane centres, left to right; the player's lane is index 2 (x = 0) */
const LANES = [-2 * P, -P, 0, P, 2 * P];
/** the whole bank's half width (outer edges of the outer gutters) */
const BANK = 2.5 * P;
/** width of one board (39 boards across a lane) */
const BOARD = LANE.width / 39;
/** where the pin deck starts (a little in front of the head pin) */
const DECK_Z = HEAD_Z + 0.28;
/** where the kickbacks (the side walls around the pins) start */
const KICK_Z = HEAD_Z + 1.05;
/** the back of the pit */
const BACK_Z = PIT_Z - LANE.pitLength;
/** the masking unit over the pin decks */
const MASK = { y0: 0.98, y1: 2.12, front: HEAD_Z + 0.52 };
/** decals sit a hair above the lane */
const DECAL_Y = 0.0025;

const COL = {
  wood: '#e3b47c',
  deck: '#f0dcb8',
  gutter: '#50566e',
  cap: '#2d3050',
  kick: '#3a3e6c',
  trim: '#ffc53d',
  mask: '#2a2b48',
  pit: '#0c0c14',
  curtain: '#1d1e38',
  mark: '#27358a',
  pinRed: '#e4202f',
  ball: '#ff2d6f',
  hole: '#15111b',
  carpet: '#ffffff',
  retBody: '#2bb5ad',
  retHood: '#3a8dff',
  rail: '#d9dbe6',
};
/** the fascia's lane colours, left to right */
const LANE_COLORS = ['#ff5a6e', '#ffb13d', '#3aa8ff', '#35d49a', '#b07cff'];

// ---------------------------------------------------------------- geometry helpers

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** Planar UVs from world x/z: u across (in lane widths, so boards line up), v along (per 4 m). */
function uvBoards(g: THREE.BufferGeometry, x0: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - x0) / LANE.width, p.getZ(i) / 4);
  return g;
}

function flatDisc(x: number, z: number, r: number, seg = 14) {
  const g = new THREE.CircleGeometry(r, seg);
  g.rotateX(-Math.PI / 2);
  g.translate(x, DECAL_Y, z);
  return g;
}

/** A flat polygon (convex, points in order) facing up, as an indexed geometry with normals + uvs. */
function flatPoly(pts: [number, number][], y = DECAL_Y) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const [x, z] of pts) pos.push(x, y, z);
  // fan; flip so the face points up whatever order the points came in
  const [ax, az] = pts[0];
  const [bx, bz] = pts[1];
  const [cx, cz] = pts[2];
  const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    if (up) idx.push(0, i, i + 1);
    else idx.push(0, i + 1, i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pts.flatMap(() => [0, 1, 0]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap(([x, z]) => [x, z]), 2));
  g.setIndex(idx);
  return g;
}

/**
 * A gutter: a flat strip at lane level whose normals curve like a channel (so
 * it shades like one in every lighting model) and whose colour darkens a
 * little towards the bottom, like occlusion.
 */
function gutterGeometry(x0: number, x1: number, z0: number, z1: number) {
  const across = 8;
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, across, 1);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const n = g.attributes.normal as THREE.BufferAttribute;
  const col: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const s = ((p.getX(i) - x0) / (x1 - x0)) * 2 - 1; // −1 … 1 across
    const nx = -s * 0.9;
    const l = Math.hypot(nx, 1);
    n.setXYZ(i, nx / l, 1 / l, 0);
    const ao = 0.78 + 0.22 * Math.pow(Math.abs(s), 1.5);
    col.push(ao, ao, ao);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Pin: a smooth lathe of PIN_PROFILE (base at y = 0, like the collider), with two red neck stripes as vertex colours. */
function pinGeometry(seg: number, samples: number) {
  // keep the flat base exact, smooth the rest of the silhouette
  const curve = new THREE.CatmullRomCurve3(
    PIN_PROFILE.slice(1).map(([r, y]) => new THREE.Vector3(r, y, 0)),
    false,
    'centripetal',
  );
  const smooth = curve.getPoints(samples).map((v) => [Math.max(0, v.x), v.y] as [number, number]);
  const prof: [number, number][] = [[0, 0], ...smooth];
  const stripes: [number, number][] = [
    [0.231, 0.247],
    [0.262, 0.278],
  ];
  const red = (y: number) => stripes.some(([a, b]) => y > a && y < b);
  const rAt = (y: number) => {
    for (let i = 1; i < prof.length; i++) {
      const [r0, y0] = prof[i - 1];
      const [r1, y1] = prof[i];
      if (y >= y0 && y <= y1 && y1 > y0) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
    return 0;
  };
  const pts: THREE.Vector2[] = [];
  const isRed: boolean[] = [];
  const edges = stripes.flat();
  for (let i = 0; i < prof.length; i++) {
    const [r, y] = prof[i];
    if (i > 0) {
      const py = prof[i - 1][1];
      // a stripe edge between two profile points: two coincident rings, one of each colour, for a crisp edge
      for (const e of edges)
        if (e > py && e < y) {
          const re = rAt(e);
          pts.push(new THREE.Vector2(re, e), new THREE.Vector2(re, e));
          isRed.push(red(e - 1e-4), red(e + 1e-4));
        }
    }
    pts.push(new THREE.Vector2(r, y));
    isRed.push(red(y));
  }
  const g = new THREE.LatheGeometry(pts, seg);
  const white = new THREE.Color('#ffffff');
  const r = new THREE.Color(COL.pinRed);
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i <= seg; i++)
    for (let j = 0; j < pts.length; j++) {
      const c = isRed[j] ? r : white;
      col.set([c.r, c.g, c.b], (i * pts.length + j) * 3);
    }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Three finger holes (two fingers + thumb) as dark plugs flush with the ball, facing up and back at rest. */
function holesGeometry() {
  const R = LANE.ballR;
  const grip = new THREE.Vector3(0, 0.62, 0.78).normalize();
  const t1 = new THREE.Vector3(1, 0, 0);
  const t2 = new THREE.Vector3().crossVectors(grip, t1).normalize();
  const holes: [THREE.Vector3, number][] = [
    [grip.clone().addScaledVector(t1, -0.2).addScaledVector(t2, 0.17).normalize(), 0.0115],
    [grip.clone().addScaledVector(t1, 0.2).addScaledVector(t2, 0.17).normalize(), 0.0115],
    [grip.clone().addScaledVector(t2, -0.3).normalize(), 0.0135],
  ];
  const up = new THREE.Vector3(0, 1, 0);
  const geos = holes.map(([d, r]) => {
    const g = new THREE.CylinderGeometry(r, r * 0.9, 0.03, 16, 1);
    g.translate(0, R + 0.0007 - 0.015, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d));
    return g;
  });
  const g = mergeGeometries(geos)!;
  geos.forEach((x) => x.dispose());
  return g;
}

// ---------------------------------------------------------------- textures

/**
 * Lane boards: one lane's 39 boards across (u 0…1) and 4 m along (v 0…1),
 * near-white so it modulates the kit's wood colour — seams, grain, end joints.
 */
function boardTexture() {
  const rng = new Rng(20260926);
  const S = 1024;
  const t = canvasTex(S, S, (x) => {
    const bw = S / 39;
    for (let b = 0; b < 39; b++) {
      const k = 0.9 + rng.next() * 0.1;
      const warm = rng.next() * 0.04;
      x.fillStyle = `rgb(${Math.round(255 * k)}, ${Math.round(255 * (k - warm * 0.5))}, ${Math.round(255 * (k - warm))})`;
      x.fillRect(b * bw, 0, bw + 1, S);
      // grain: faint wavy streaks along the board
      for (let s = 0; s < 6; s++) {
        x.strokeStyle = `rgba(110, 70, 30, ${0.04 + rng.next() * 0.06})`;
        x.lineWidth = 0.8 + rng.next() * 1.4;
        const gx = b * bw + 2 + rng.next() * (bw - 4);
        const ph = rng.next() * 6;
        x.beginPath();
        for (let y = 0; y <= S; y += 32) x.lineTo(gx + Math.sin(y * 0.011 + ph) * 1.6, y);
        x.stroke();
      }
      // an end joint somewhere along each board (staggered)
      const jy = rng.next() * S;
      x.fillStyle = 'rgba(80, 50, 25, 0.35)';
      x.fillRect(b * bw, jy, bw, 1.5);
    }
    // seams between the boards
    x.fillStyle = 'rgba(85, 55, 28, 0.42)';
    for (let b = 0; b <= 39; b++) x.fillRect(b * bw - 0.8, 0, 1.6, S);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Carpet behind the approach: dark with bright confetti shapes (a classic alley carpet). */
function carpetTexture() {
  const rng = new Rng(7);
  const t = canvasTex(512, 512, (x) => {
    x.fillStyle = '#26265e';
    x.fillRect(0, 0, 512, 512);
    const cols = ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a', '#b07cff', '#ffffff'];
    for (let i = 0; i < 70; i++) {
      x.fillStyle = cols[i % cols.length];
      x.globalAlpha = 0.9;
      const cx = rng.next() * 512,
        cy = rng.next() * 512,
        s = 8 + rng.next() * 16;
      x.save();
      x.translate(cx, cy);
      x.rotate(rng.next() * 6.3);
      const kind = i % 3;
      x.beginPath();
      if (kind === 0) x.arc(0, 0, s * 0.6, 0, Math.PI * 2);
      else if (kind === 1) (x.moveTo(0, -s), x.lineTo(s * 0.87, s * 0.5), x.lineTo(-s * 0.87, s * 0.5));
      else x.rect(-s * 0.9, -s * 0.18, s * 1.8, s * 0.36);
      x.fill();
      x.restore();
    }
    x.globalAlpha = 1;
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The masking unit's sign: "KALEYDO LANES" in rainbow letters over five coloured lane panels with big numbers. */
function fasciaTexture(width: number, height: number) {
  const W = 2048;
  const H = Math.round((W * height) / width / 8) * 8;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d')!;
  const px = (m: number) => ((m + width / 2) / width) * W;
  const draw = () => {
    const band = Math.round(H * 0.3);
    x.fillStyle = '#1b1a36';
    x.fillRect(0, 0, W, H);
    // lane panels with a kaleidoscope of triangles
    LANES.forEach((lx, i) => {
      const x0 = px(lx - P / 2),
        x1 = px(lx + P / 2);
      const base = new THREE.Color(LANE_COLORS[i]);
      x.fillStyle = `#${base.getHexString()}`;
      x.fillRect(x0, band, x1 - x0, H - band);
      const tri = (H - band) / 2;
      for (let k = 0; k * tri < x1 - x0 + tri; k++)
        for (let r = 0; r < 2; r++) {
          const shade = (k + r) % 2 ? 0.14 : -0.1;
          const cc = base.clone().offsetHSL(0.02 * ((k % 3) - 1), 0, shade);
          x.fillStyle = `#${cc.getHexString()}`;
          const ty = band + r * tri;
          const tx = x0 + k * tri;
          x.beginPath();
          if ((k + r) % 2) (x.moveTo(tx, ty), x.lineTo(tx + tri, ty), x.lineTo(tx + tri / 2, ty + tri));
          else (x.moveTo(tx - tri / 2, ty + tri), x.lineTo(tx + tri / 2, ty + tri), x.lineTo(tx, ty));
          x.fill();
        }
      // number badge
      const cx = (x0 + x1) / 2,
        cy = band + (H - band) / 2;
      const rr = (H - band) * 0.36;
      x.fillStyle = '#ffffff';
      x.beginPath();
      x.arc(cx, cy, rr, 0, Math.PI * 2);
      x.fill();
      x.lineWidth = rr * 0.12;
      x.strokeStyle = '#1b1a36';
      x.stroke();
      x.fillStyle = '#1b1a36';
      x.font = `700 ${Math.round(rr * 1.35)}px Fredoka, 'Arial Rounded MT Bold', system-ui, sans-serif`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(String(i + 1), cx, cy + rr * 0.08);
    });
    // panel separators
    x.fillStyle = '#1b1a36';
    for (let i = 0; i <= LANES.length; i++) x.fillRect(px(-BANK + i * P) - 5, band, 10, H - band);
    // title band: rainbow letters and little stars
    const title = 'KALEYDO LANES';
    x.font = `700 ${Math.round(band * 0.78)}px Fredoka, 'Arial Rounded MT Bold', system-ui, sans-serif`;
    x.textBaseline = 'middle';
    x.textAlign = 'left';
    const widths = [...title].map((ch) => x.measureText(ch).width + band * 0.04);
    let tx = W / 2 - widths.reduce((a, b) => a + b, 0) / 2;
    const rainbow = ['#ff5a6e', '#ff9a3d', '#ffc53d', '#35d49a', '#3aa8ff', '#b07cff'];
    [...title].forEach((ch, i) => {
      x.fillStyle = ch === ' ' ? '#000' : rainbow[i % rainbow.length];
      x.fillText(ch, tx, band * 0.54);
      tx += widths[i];
    });
    x.fillStyle = '#ffffff';
    for (let i = 0; i < 16; i++) {
      const sx = (i + 0.5) * (W / 16);
      if (Math.abs(sx - W / 2) < W * 0.2) continue;
      star(x, sx, band * 0.5, band * (i % 2 ? 0.16 : 0.11));
    }
  };
  draw();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  // canvas text needs the web font: redraw once it has loaded
  document.fonts
    ?.load(`700 64px Fredoka`)
    .then(() => {
      draw();
      t.needsUpdate = true;
    })
    .catch(() => {});
  return t;
}

function star(x: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  x.fill();
}

// ---------------------------------------------------------------- the venue

interface StaticSet {
  geos: THREE.BufferGeometry[];
  cast: boolean;
  receive: boolean;
  /** outline width scale; 0 = no outline */
  outline: number;
}

interface MatOpts {
  map?: THREE.Texture;
  /** `map` is fine detail (board grain): skip it on flat-shaded low-res styles, where it only dithers into noise */
  detail?: boolean;
  /** use the geometry's vertex colours */
  vc?: boolean;
  /**
   * floor-level surface: a constant depth bias (in depth units) so it wins over a
   * world ground at the same height (paper's slab is at y = 0). Constant only: a
   * slope-scaled bias explodes at grazing angles and eats the pins' bases.
   */
  floor?: number;
  /** cap HDR colours (glow worlds): a whole pin or sign at a racket's glow blooms into a white blob */
  maxGlow?: number;
  /** scale the kit's rim light: on a flat floor or wall at grazing angles it turns into a sheet of glare */
  rim?: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const yAxis = new THREE.Vector3(0, 1, 0);

export interface VenueOpts {
  /**
   * Height of a pin body's origin above the pin's base. 0 (default) = the base,
   * i.e. the frame PIN_PROFILE is written in, which the lathe and the collider
   * hull share. If the physics centres pin bodies on their centre of mass, pass
   * that height here.
   */
  pinOrigin?: number;
}

export class BowlVenue {
  readonly group = new THREE.Group();
  private mats = new Map<string, THREE.Material>();
  private statics = new Map<THREE.Material, StaticSet>();
  private disposables: { dispose(): void }[] = [];
  private pins: THREE.Mesh[] = [];
  private ball: THREE.Mesh;
  private shadows: THREE.InstancedMesh;
  private aim: AimGuide;
  private held: THREE.Vector3 | null = null;
  private time = 0;
  private pinOrigin: number;

  constructor(
    private kit: MaterialKit,
    opts: VenueOpts = {},
  ) {
    this.pinOrigin = opts.pinOrigin ?? 0;
    this.group.name = 'bowling';
    this.buildLanes();
    this.buildMarkings();
    this.buildPinArea();
    this.buildMasking();
    this.buildBallReturn(P / 2, FOUL_Z + 4.35, FOUL_Z + 5.95);
    this.buildBallReturn(-1.5 * P, FOUL_Z + 4.35, FOUL_Z + 5.95);
    this.buildRacks();
    this.bake();

    // the player's pins
    const pinGeo = this.own(pinGeometry(22, 34).translate(0, -this.pinOrigin, 0));
    const pinMat = this.mat('racket', '#ffffff', { vc: true, maxGlow: 1.1 });
    for (const s of pinSpots(0)) {
      const m = new THREE.Mesh(pinGeo, pinMat);
      m.position.set(s.x, this.pinOrigin, s.z);
      m.castShadow = !!this.kit.castShadow;
      m.name = 'pin';
      this.pins.push(m);
      this.group.add(m);
    }

    // the ball
    this.ball = this.makeBall(COL.ball);
    this.ball.castShadow = !!this.kit.castShadow;
    this.ball.visible = false;
    this.group.add(this.ball);

    if (this.kit.outline) {
      const o = this.kit.outline;
      outlineTree(this.group, o.color, o.width, { emissive: o.emissive });
    }

    // blob shadows under the pins and the ball (added after the outlines: flat decals get none)
    const sm = new THREE.MeshBasicMaterial({
      map: blobShadowTexture(),
      color: this.kit.shadowColor,
      transparent: true,
      opacity: Math.min(0.8, this.kit.shadowOpacity * (this.kit.castShadow ? 1.3 : 1.7)),
      depthWrite: false,
    });
    this.disposables.push(sm);
    const sg = this.own(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2));
    this.shadows = new THREE.InstancedMesh(sg, sm, 11);
    this.shadows.renderOrder = 1;
    this.shadows.frustumCulled = false;
    this.shadows.userData.noNormals = true;
    this.group.add(this.shadows);

    this.aim = new AimGuide();
    this.disposables.push(this.aim);
    this.group.add(this.aim.group);

    const standing = pinSpots(0).map((s) => ({ x: s.x, y: this.pinOrigin, z: s.z, qx: 0, qy: 0, qz: 0, qw: 1, visible: true }));
    this.update({ ball: { x: 0, y: -1, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, visible: false, gutter: false }, pins: standing }, 0);
  }

  // ---------------------------------------------------------------- per frame

  /** Draw the ball and the 10 active pins from the physics view (world coordinates). */
  update(v: BowlView, realDt: number) {
    this.time += realDt;
    for (let i = 0; i < this.pins.length; i++) {
      const p = v.pins[i];
      const m = this.pins[i];
      m.visible = !!p && p.visible;
      if (!p || !m.visible) continue;
      m.position.set(p.x, p.y, p.z);
      m.quaternion.set(p.qx, p.qy, p.qz, p.qw);
    }
    const b = this.ball;
    if (this.held) {
      b.visible = true;
      b.position.copy(this.held);
      // held with the finger holes up and back, the way the physics body starts (identity)
      b.quaternion.identity();
    } else {
      const s = v.ball;
      b.visible = s.visible;
      b.position.set(s.x, s.y, s.z);
      b.quaternion.set(s.qx, s.qy, s.qz, s.qw);
    }
    this.updateShadows();
    this.aim.update(this.time, realDt);
  }

  /** While the bowler holds the ball, draw it at this world position instead (null = use the view). */
  holdBall(p: THREE.Vector3 | null) {
    if (!p) this.held = null;
    else (this.held ??= new THREE.Vector3()).copy(p);
  }

  /** An aim guide on the approach/lane: from (x, FOUL_Z) at `angle` (radians from −z, + = +x), or hide with null. */
  setAim(aim: { x: number; angle: number } | null) {
    this.aim.set(aim);
  }

  dispose() {
    this.group.removeFromParent();
    // outline hulls share their mesh's geometry and use outline.ts's shared materials: nothing extra to free
    for (const d of this.disposables) d.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }

  private updateShadows() {
    const S = this.shadows;
    const r = 0.078;
    const o = this.pinOrigin;
    for (let i = 0; i < 10; i++) {
      const m = this.pins[i];
      // lying pins cast a long shadow along their axis; flying ones shrink; pins in the pit have none
      tmpV.copy(yAxis).applyQuaternion(m.quaternion);
      const bx = m.position.x - tmpV.x * o,
        by = m.position.y - tmpV.y * o,
        bz = m.position.z - tmpV.z * o; // the pin's base
      const lean = Math.hypot(tmpV.x, tmpV.z);
      const cy = by + tmpV.y * LANE.pinH * 0.45;
      const k = !m.visible || by < -0.04 ? 0 : THREE.MathUtils.clamp(1.3 - cy * 1.6, 0, 1);
      tmpS.set((r + lean * LANE.pinH * 0.46) * k, 1, r * k);
      tmpQ.setFromAxisAngle(yAxis, Math.atan2(-tmpV.z, tmpV.x));
      const len = LANE.pinH * 0.45 * lean;
      const hx = lean > 1e-4 ? tmpV.x / lean : 0;
      const hz = lean > 1e-4 ? tmpV.z / lean : 0;
      tmpM.compose(tmpV.set(bx + hx * len, 0.004, bz + hz * len), tmpQ, tmpS);
      S.setMatrixAt(i, tmpM);
    }
    const b = this.ball;
    const h = Math.max(0, b.position.y - LANE.ballR);
    const k = !b.visible || b.position.y < -0.02 ? 0 : THREE.MathUtils.clamp(1.2 - h * 0.9, 0.35, 1);
    const rb = 0.19 * k;
    tmpM.compose(tmpV.set(b.position.x, 0.0045, b.position.z), tmpQ.identity(), tmpS.set(rb, 1, rb));
    S.setMatrixAt(10, tmpM);
    S.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- materials & baking

  private mat(role: CharRole, css: string, o: MatOpts = {}) {
    const key = [role, css, o.map?.uuid ?? '', o.vc ? 1 : 0, o.floor ?? 0, o.maxGlow ?? 0, o.rim ?? 1].join('|');
    let m = this.mats.get(key);
    if (m) return m;
    const mat = this.kit.char(role, new THREE.Color(css));
    const mm = mat as THREE.MeshStandardMaterial;
    if (o.vc) mat.vertexColors = true;
    if (o.map && 'map' in mm && !(o.detail && mm.flatShading)) mm.map = o.map;
    if (o.floor) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 0;
      mat.polygonOffsetUnits = -2 * o.floor;
    }
    if (o.maxGlow && mm.color) {
      const top = Math.max(mm.color.r, mm.color.g, mm.color.b);
      if (top > o.maxGlow) mm.color.multiplyScalar(o.maxGlow / top);
    }
    // the rim light of worlds/mats.ts toon() lives in a `uRim` uniform set up in onBeforeCompile
    const rim = o.rim ?? 1;
    if (rim !== 1 && Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')) {
      const orig = mat.onBeforeCompile;
      mat.onBeforeCompile = (sh, r) => {
        orig.call(mat, sh, r);
        const u = sh.uniforms.uRim;
        if (u) u.value *= rim;
      };
    }
    this.mats.set(key, mat);
    return mat;
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /** Queue static geometry; everything with the same material becomes one mesh. */
  private add(mat: THREE.Material, geo: THREE.BufferGeometry, o: { cast?: boolean; receive?: boolean; outline?: number } = {}) {
    let s = this.statics.get(mat);
    if (!s) this.statics.set(mat, (s = { geos: [], cast: !!o.cast, receive: !!o.receive, outline: o.outline ?? 0 }));
    s.geos.push(geo);
  }

  private bake() {
    const shadows = !!this.kit.castShadow;
    for (const [mat, s] of this.statics) {
      const geo = mergeGeometries(s.geos, false);
      s.geos.forEach((g) => g.dispose());
      if (!geo) continue;
      this.own(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadows && s.cast;
      m.receiveShadow = shadows && s.receive;
      if (s.outline <= 0) m.userData.noOutline = true;
      else m.userData.outlineScale = s.outline;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
    }
    this.statics.clear();
  }

  // ---------------------------------------------------------------- lanes

  private buildLanes() {
    const boards = this.own(boardTexture());
    const wood = this.mat('hair', COL.wood, { map: boards, detail: true, floor: 1, rim: 0.2 });
    const deck = this.mat('hair', COL.deck, { map: boards, detail: true, floor: 1, rim: 0.2 });
    const gutter = this.mat('shoe', COL.gutter, { vc: true, floor: 1, rim: 0.3 });
    const cap = this.mat('grip', COL.cap, { rim: 0.5 });
    for (const c of LANES) {
      // playing surface: the foul line to the pin deck, and the deck itself
      this.add(wood, uvBoards(box(c - HW, c + HW, -0.03, 0, DECK_Z, FOUL_Z), c - HW), { receive: true });
      this.add(deck, uvBoards(box(c - HW, c + HW, -0.03, 0, PIT_Z, DECK_Z), c - HW), { receive: true });
      for (const sd of [-1, 1]) {
        const a = c + sd * HW,
          b = c + sd * (HW + GW);
        this.add(gutter, gutterGeometry(Math.min(a, b), Math.max(a, b), PIT_Z, FOUL_Z), { receive: true });
      }
    }
    // the approach: one maple floor across all five lanes
    this.add(wood, uvBoards(box(-BANK, BANK, -0.03, 0, FOUL_Z, FOUL_Z + LANE.approach), -HW), { receive: true });

    // capping between neighbouring gutters: low rounded rails from the foul line to the kickbacks
    const len = FOUL_Z - KICK_Z;
    for (let k = 0; k <= LANES.length; k++) {
      const x = -BANK + k * P;
      const outer = k === 0 || k === LANES.length;
      const r = outer ? 0.07 : 0.042;
      const g = new THREE.CylinderGeometry(r, r, len, 14, 1, false, Math.PI / 2, Math.PI);
      g.rotateX(Math.PI / 2);
      g.scale(1, outer ? 1.1 : 0.85, 1);
      g.translate(x, 0, (FOUL_Z + KICK_Z) / 2);
      this.add(cap, g, { cast: true, receive: true, outline: 1.2 });
    }
    // the outer edges of the approach
    for (const sx of [-1, 1]) this.add(cap, box(sx * BANK - 0.07, sx * BANK + 0.07, 0, 0.07, FOUL_Z, FOUL_Z + LANE.approach), { outline: 1.2 });

    // carpet behind the approach (where the ball returns and the seats would be)
    const carpet = this.mat('shorts', COL.carpet, { map: this.own(carpetTexture()), floor: 1, rim: 0.2 });
    const cg = box(-BANK - 0.4, BANK + 0.4, -0.03, 0, FOUL_Z + LANE.approach, FOUL_Z + LANE.approach + 3.2);
    const uv = cg.attributes.uv as THREE.BufferAttribute;
    const pos = cg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 1.6, pos.getZ(i) / 1.6);
    this.add(carpet, cg, { receive: true });
  }

  /** Foul line, approach dots, guide dots, the seven arrows and the pin spots — one inlaid-marking mesh. */
  private buildMarkings() {
    const mark = this.mat('racket', COL.mark, { floor: 3 });
    const boardX = (c: number, b: number) => c + HW - (b - 0.5) * BOARD; // board 1 is the right edge
    const add = (g: THREE.BufferGeometry) => this.add(mark, g, { receive: true });
    // foul line across the whole bank
    add(flatPoly([[-BANK, FOUL_Z + 0.025], [BANK, FOUL_Z + 0.025], [BANK, FOUL_Z - 0.025], [-BANK, FOUL_Z - 0.025]]));
    for (const c of LANES) {
      // approach dots: two rows (12 ft and 15 ft behind the line)
      for (const d of [3.66, 4.4])
        for (const b of [5, 10, 15, 20, 25, 30, 35]) add(flatDisc(boardX(c, b), FOUL_Z + d, b === 20 ? 0.036 : 0.028));
      // guide dots 7 ft down the lane
      for (const b of [3, 5, 8, 11, 14, 26, 29, 32, 35, 37]) add(flatDisc(boardX(c, b), FOUL_Z - 2.13, 0.016));
      // the arrows: a V of seven, the centre one furthest
      for (let k = -3; k <= 3; k++) {
        const x = boardX(c, 20 + k * 5);
        const tip = FOUL_Z - (4.95 - Math.abs(k) * 0.3);
        // bigger than regulation so they read from the approach
        const L = 0.34,
          w = 0.045;
        add(flatPoly([[x, tip], [x - w, tip + L], [x + w, tip + L]]));
      }
      // pin spots on the deck (hidden under standing pins)
      for (const s of pinSpots(c)) add(flatDisc(s.x, s.z, 0.021, 16));
    }
  }

  // ---------------------------------------------------------------- pins end

  private buildPinArea() {
    const kick = this.mat('shirt', COL.kick, { rim: 0.35 });
    const trim = this.mat('racket', COL.trim, { maxGlow: 1.8 });
    const pit = this.mat('shorts', COL.pit, { floor: 1, rim: 0.2 });
    const curtain = this.mat('shorts', COL.curtain, { rim: 0.3 });
    // kickbacks: the side walls around each pin deck (shared by neighbours)
    const kh = 0.74;
    for (let k = 0; k <= LANES.length; k++) {
      const x = -BANK + k * P;
      const outer = k === 0 || k === LANES.length;
      const t = outer ? 0.14 : 0.07;
      this.add(kick, box(x - t / 2, x + t / 2, 0, kh, BACK_Z, KICK_Z), { outline: 1.3 });
      this.add(trim, box(x - t / 2 - 0.006, x + t / 2 + 0.006, kh, kh + 0.035, BACK_Z, KICK_Z), { outline: 1 });
    }
    // the pit: a dark floor behind the decks and a pleated curtain at the back
    this.add(pit, box(-BANK, BANK, -0.03, 0, BACK_Z, PIT_Z), {});
    const cg = new THREE.PlaneGeometry(BANK * 2, MASK.y0 + 0.02, 120, 1);
    const cp = cg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < cp.count; i++) cp.setZ(i, Math.sin(cp.getX(i) * 26) * 0.025);
    cg.computeVertexNormals();
    cg.translate(0, (MASK.y0 + 0.02) / 2, BACK_Z + 0.03);
    this.add(curtain, cg, {});
  }

  /** The masking unit: a long box over the pin decks with the lit "KALEYDO LANES" sign on its front. */
  private buildMasking() {
    const body = this.mat('shirt', COL.mask, { rim: 0.35 });
    const trim = this.mat('racket', COL.trim, { maxGlow: 1.8 });
    const x0 = -BANK - 0.1,
      x1 = BANK + 0.1;
    this.add(body, box(x0, x1, MASK.y0, MASK.y1, BACK_Z, MASK.front), { outline: 1.6 });
    // the pinsetter housing behind the curtain, so the bank is solid from the side
    this.add(body, box(x0, x1, 0, MASK.y1, BACK_Z - 1.1, BACK_Z), { outline: 1.6 });
    for (const y of [MASK.y0, MASK.y1]) this.add(trim, box(x0 - 0.02, x1 + 0.02, y - 0.03, y + 0.03, MASK.front - 0.04, MASK.front + 0.04), { outline: 1 });
    // the pin lights along its underside (the only thing lighting a real pin deck)
    const glow = this.mat('eyeWhite', '#fff6dc', { maxGlow: 1.6 });
    const lg = new THREE.PlaneGeometry(x1 - x0 - 0.1, 0.12);
    lg.rotateX(Math.PI / 2);
    lg.translate(0, MASK.y0 - 0.032, MASK.front - 0.12);
    this.add(glow, lg, {});
    const h = MASK.y1 - MASK.y0 - 0.1;
    const sign = this.mat('eyeWhite', '#ffffff', { map: this.own(fasciaTexture(x1 - x0, h)), maxGlow: 1.3 });
    const g = new THREE.PlaneGeometry(x1 - x0, h);
    g.translate(0, (MASK.y0 + MASK.y1) / 2, MASK.front + 0.003);
    this.add(sign, g, {});
  }

  /** A ball return between two lanes at the back of the approach, with a few house balls on its rails. */
  private buildBallReturn(cx: number, z0: number, z1: number) {
    const body = this.mat('shirt', COL.retBody, { rim: 0.5 });
    const hood = this.mat('racket', COL.retHood, { maxGlow: 1.6 });
    const rail = this.mat('gold', COL.rail);
    const len = z1 - z0;
    const w = 0.21;
    const bh = 0.4;
    this.add(body, box(cx - w, cx + w, 0, bh, z0 + 0.25, z1), { cast: true, receive: true, outline: 1.2 });
    const top = new THREE.CylinderGeometry(w, w, len - 0.25, 18, 1, false, Math.PI / 2, Math.PI);
    top.rotateX(Math.PI / 2);
    top.scale(1, 0.55, 1);
    top.translate(cx, bh, (z0 + 0.25 + z1) / 2);
    this.add(body, top, { cast: true, receive: true, outline: 1.2 });
    // the hood the balls come out of, facing the lanes
    const hg = new THREE.SphereGeometry(0.3, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    hg.scale(0.95, 2.6, 1.05);
    hg.translate(cx, 0, z0 + 0.32);
    this.add(hood, hg, { cast: true, outline: 1.2 });
    // rails
    const ry = bh + w * 0.55 + 0.02;
    for (const sx of [-1, 1]) {
      const r = new THREE.CylinderGeometry(0.014, 0.014, len - 0.55, 8);
      r.rotateX(Math.PI / 2);
      r.translate(cx + sx * 0.075, ry, (z0 + 0.55 + z1) / 2);
      this.add(rail, r, { outline: 0.8 });
    }
    // house balls resting on the rails
    const colors = cx > 0 ? ['#3a7bff', '#ffc53d', '#35d49a'] : ['#b07cff', '#ff8a3d'];
    colors.forEach((c, i) => {
      const b = this.makeBall(c);
      b.position.set(cx, ry + LANE.ballR * 0.85, z0 + 0.75 + i * 0.26);
      b.rotation.set(0.4 + i, i * 2.1, 0.3);
      b.castShadow = !!this.kit.castShadow;
      b.matrixAutoUpdate = false;
      b.updateMatrix();
      this.group.add(b);
    });
  }

  /** Full racks of pins on the neighbouring lanes (static). */
  private buildRacks() {
    const g = pinGeometry(12, 20);
    const mat = this.mat('racket', '#ffffff', { vc: true, maxGlow: 1.1 });
    for (const c of LANES) {
      if (c === 0) continue;
      for (const s of pinSpots(c)) this.add(mat, g.clone().translate(s.x, 0, s.z), { cast: true, outline: 1 });
    }
    g.dispose();
  }

  private ballGeo: THREE.BufferGeometry | null = null;
  private holeGeo: THREE.BufferGeometry | null = null;

  private makeBall(css: string) {
    this.ballGeo ??= this.own(new THREE.SphereGeometry(LANE.ballR, 32, 22));
    this.holeGeo ??= this.own(holesGeometry());
    const b = new THREE.Mesh(this.ballGeo, this.mat('racket', css));
    b.name = 'ball';
    const h = new THREE.Mesh(this.holeGeo, this.mat('shorts', COL.hole));
    h.userData.noOutline = true;
    b.add(h);
    return b;
  }
}

// ---------------------------------------------------------------- aim guide

/**
 * The aim line: bright dots marching from the foul line towards the pins, with
 * an arrowhead — red (the colour every style keeps, ink included) on a white rim.
 */
class AimGuide {
  group = new THREE.Group();
  private dots: THREE.InstancedMesh;
  private rims: THREE.InstancedMesh;
  private head: THREE.Mesh;
  private aim: { x: number; angle: number } | null = null;
  private shown = 0;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  /** dots from the foul line nearly to the head pin: you can see which pin the line meets */
  private static N = 22;
  private static STEP = 0.75;

  constructor() {
    const mat = (c: THREE.ColorRepresentation, order: number) => {
      const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetUnits: -10 });
      this.mats.push(m);
      return { m, order };
    };
    const red = mat(new THREE.Color('#ff2a3d').multiplyScalar(1.25), 3);
    const white = mat('#ffffff', 2);
    const dot = new THREE.CircleGeometry(0.082, 20).rotateX(-Math.PI / 2);
    const rim = new THREE.CircleGeometry(0.112, 20).rotateX(-Math.PI / 2);
    this.geos.push(dot, rim);
    this.dots = new THREE.InstancedMesh(dot, red.m, AimGuide.N);
    this.rims = new THREE.InstancedMesh(rim, white.m, AimGuide.N);
    this.dots.renderOrder = red.order;
    this.rims.renderOrder = white.order;
    // arrowhead pointing along −z in its own frame
    const tri = (w: number, l: number, back: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -l, -w, 0, back, w, 0, back], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setIndex([0, 1, 2]);
      this.geos.push(g);
      return g;
    };
    this.head = new THREE.Mesh(tri(0.2, 0.4, 0.1), red.m);
    const headRim = new THREE.Mesh(tri(0.27, 0.5, 0.15), white.m);
    this.head.renderOrder = red.order;
    headRim.renderOrder = white.order;
    headRim.position.y = -0.0005;
    this.head.add(headRim);
    for (const o of [this.dots, this.rims, this.head, headRim]) {
      o.frustumCulled = false;
      o.userData.noOutline = true;
      o.userData.noNormals = true;
    }
    this.group.add(this.rims, this.dots, this.head);
    this.group.visible = false;
  }

  set(a: { x: number; angle: number } | null) {
    if (a) (this.aim ??= { x: 0, angle: 0 }), (this.aim.x = a.x), (this.aim.angle = a.angle);
    else this.aim = null;
  }

  update(time: number, dt: number) {
    // fade in/out by scaling (the materials are shared, so no per-guide opacity)
    const target = this.aim ? 1 : 0;
    this.shown += (target - this.shown) * Math.min(1, dt * 12);
    if (this.shown < 0.01 && !this.aim) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const a = this.aim ?? { x: 0, angle: 0 };
    const dx = Math.sin(a.angle),
      dz = -Math.cos(a.angle);
    const N = AimGuide.N,
      step = AimGuide.STEP;
    const start = 0.45;
    const span = N * step;
    const phase = (time * 1.1) % step;
    for (let i = 0; i < N; i++) {
      const d = start + i * step + phase;
      // grow in at the start; bigger further out, so perspective doesn't shrink them to specks
      const u = (d - start) / span;
      const s = this.shown * Math.min(1, (d - start) / 0.5) * (0.9 + 1.3 * u);
      // stretched along the lane: seen from behind at a low angle they still read as round
      tmpM.compose(tmpV.set(a.x + dx * d, 0.006, FOUL_Z + dz * d), tmpQ.identity(), tmpS.set(s, 1, s * (1 + 3 * u)));
      this.dots.setMatrixAt(i, tmpM);
      this.rims.setMatrixAt(i, tmpM);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    this.rims.instanceMatrix.needsUpdate = true;
    const hd = start + span + 0.45;
    this.head.position.set(a.x + dx * hd, 0.007, FOUL_Z + dz * hd);
    this.head.rotation.set(0, -a.angle, 0);
    this.head.scale.setScalar(this.shown * 1.8);
  }

  dispose() {
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
  }
}
