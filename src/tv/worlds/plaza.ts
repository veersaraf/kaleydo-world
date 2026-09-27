// SUNNY PLAZA — the hub world. Bright, cel-shaded, outlined: the classic
// sunny-afternoon sports look, with a giant prism turning on the hill.
//
// Round the stadium the land rolls away into cel-shaded hills with a patchwork
// of fields, a hillside town of pastel houses with a clock tower, a Ferris
// wheel and a windmill, and snowy mountains on the horizon. Every shape has
// its ink outline, and the outlines of things that move bend with them (the
// hull is the same vertex shader, pushed out: park-env/wind.ts hull()). Trees
// sway in one wind, flags and bunting flutter, clouds drift round, birds wheel
// over the town — all in vertex shaders and a handful of instanced draws.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { toon, flat, stringsMat, skyDome, canvasTex, type ToonOpts } from './mats';
import { addOutline, outlineTree } from '../render/outline';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import type { MatchEvent } from '../tennis/match';
import { COURT } from '../tennis/court';
import { SKINS } from '../chars/look';
import { blobShadowTexture } from '../chars/rig';
import { Rng } from '../core/math';
import { Wind, sway, hull, type SwayOpts } from './park-env/wind';
import { Foliage, crownBlobs, clumpGeometry, type Place, type Tone } from './park-env/foliage';
import { Birds, flags, type Pole } from './park-env/props';
import { landGeometry, bumpsAt, scatterBumps, smooth, type Bump } from './park-env/land';

const OUTLINE = new THREE.Color('#231f3a');
/** outline widths (metres near the camera; they grow a little with distance, see hull()) */
const INK = { plant: 0.045, house: 0.04, land: 0.05, cloud: 0.07 };

/** canopies shade as one volume in two or three cel bands: only a hint of the baked gradient */
const CEL_TONE: Tone = { low: new THREE.Color(0.84, 0.9, 0.96), high: new THREE.Color(1.06, 1.05, 0.94) };

// ---------------------------------------------------------------- the land
//
// Flat round the stadium (the ground disk covers r < 62), then rolling hills:
// big ones behind the far stand, where the town climbs the slope, lower meadows
// towards the entrance (+z), mountains on the horizon all round.

const TOWN_HILL: Bump = { x: 0, z: -160, r: 90, h: 21 };
const MILL_HILL: Bump = { x: -78, z: -104, r: 48, h: 18 };
const WHEEL_HILL: Bump = { x: 62, z: -114, r: 46, h: 12 };
const PRISM_HILL: Bump = { x: -48, z: -235, r: 70, h: 26 };

function landBumps() {
  const r = new Rng(4242);
  const rand = () => r.next();
  return [
    TOWN_HILL,
    MILL_HILL,
    WHEEL_HILL,
    PRISM_HILL,
    // rolling hills behind and along the sides…
    ...scatterBumps(rand, 22, { r: [100, 200], a: [-Math.PI * 1.05, 0.05], size: [32, 62], h: [7, 22] }),
    // …lower meadows towards the entrance
    ...scatterBumps(rand, 14, { r: [95, 190], a: [0.1, Math.PI - 0.1], size: [30, 55], h: [3, 9] }),
    // mountains on the horizon
    ...scatterBumps(rand, 24, { r: [300, 430], size: [70, 135], h: [30, 85] }),
  ];
}

// ---------------------------------------------------------------- materials

/** cel-shaded, white: the instances or vertex colours bring the colour */
const cel = (o: ToonOpts = {}) => toon('#ffffff', { gradient: [150, 215, 255], ...o });

/** the ink outline of something that sways (or, with no sway, of anything instanced) */
function ink(width: number, color = OUTLINE, move?: (m: THREE.MeshBasicMaterial) => THREE.MeshBasicMaterial) {
  const m = new THREE.MeshBasicMaterial({ color });
  return hull(move ? move(m) : m, width);
}

/**
 * Outline an instanced mesh: a child drawing the same instances (sharing their
 * matrices, following their count) with a hull material. `geo` can be a
 * smoothed copy of the mesh's geometry, so the hull doesn't split at hard corners.
 */
function outlineInstances(m: THREE.InstancedMesh, mat: THREE.Material, geo = m.geometry) {
  const h = new THREE.InstancedMesh(geo, mat, m.count);
  h.instanceMatrix = m.instanceMatrix;
  h.frustumCulled = m.frustumCulled;
  if (!m.boundingSphere) m.computeBoundingSphere();
  h.boundingSphere = m.boundingSphere;
  h.onBeforeRender = () => (h.count = m.count);
  h.userData.noOutline = true;
  m.add(h);
  return m;
}

/** A hull-friendly copy of a hard-edged geometry: shared corners with averaged normals. */
function smoothHull(g: THREE.BufferGeometry) {
  const p = new THREE.BufferGeometry();
  p.setAttribute('position', g.attributes.position.clone());
  if (g.index) p.setIndex(g.index.clone());
  const s = mergeVertices(p, 1e-4);
  s.computeVertexNormals();
  p.dispose();
  return s;
}

/**
 * The land's own cel shading: vertex colours (greener near, bluer far), a
 * patchwork of fields with hedges between them on the hills, and snow on the
 * mountain tops, all crisp-edged (and the hedges fade before they'd shimmer).
 */
function landMaterial() {
  const m = cel({ vertexColors: true, gradient: [165, 225, 255] });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLand;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLand = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vLand;').replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
      {
        float r = length(vLand.xz);
        float fields = smoothstep(84.0, 108.0, r) * (1.0 - smoothstep(210.0, 280.0, r));
        // a brick pattern of fields on a turned grid
        vec2 q = mat2(0.93, 0.36, -0.36, 0.93) * vLand.xz / vec2(28.0, 18.0);
        q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
        vec2 c = floor(q), f = fract(q);
        float k = fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 tint = k < 0.28 ? vec3(1.1, 1.08, 0.82) : k < 0.5 ? vec3(0.84, 0.94, 0.84) : k < 0.62 ? vec3(1.32, 1.14, 0.52) : k < 0.7 ? vec3(1.18, 1.0, 0.86) : vec3(1.0);
        // hedges along the edges (metres to the nearest one), faded out before they alias
        float e = min(min(f.x, 1.0 - f.x) * 28.0, min(f.y, 1.0 - f.y) * 18.0);
        float fw = fwidth(e);
        float hedge = (1.0 - smoothstep(0.55 - fw, 0.55 + fw, e)) * (1.0 - smoothstep(0.35, 1.2, fw));
        diffuseColor.rgb *= mix(vec3(1.0), mix(tint, vec3(0.5, 0.7, 0.46), hedge), fields);
        // snow on the peaks, a crisp line
        float snow = step(80.0 + 7.0 * sin(vLand.x * 0.043 + vLand.z * 0.061), vLand.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.02, 1.04, 1.08), snow);
      }`,
    );
  };
  m.customProgramCacheKey = () => 'plaza-land';
  return m;
}

// ---------------------------------------------------------------- the grade

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Plaza's display grade (a LUT): cel colours stay flat and clean — muted ones
 * gain a little, the shade bands lean cool and violet (the cartoon way to
 * shade), sunlit ones lean warm, whites stay white.
 */
function celGrade([r, g, b]: [number, number, number]): [number, number, number] {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const vib = 1 + 0.12 * (1 - sat);
  let R = l + (r - l) * vib,
    G = l + (g - l) * vib,
    B = l + (b - l) * vib;
  const lo = 1 - sstep(0.12, 0.55, l),
    hi = sstep(0.55, 0.95, l) * (1 - sstep(0.93, 1, l));
  R += -0.012 * lo + 0.018 * hi;
  G += -0.01 * lo + 0.006 * hi;
  B += 0.03 * lo - 0.022 * hi;
  return [R, G, B];
}

class PlazaWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth' || role === 'eyeWhite') return flat(c);
      if (role === 'strings') return stringsMat(c);
      if (role === 'cheek') return flat(c, { transparent: true, opacity: 0.7 });
      if (role === 'gold') return toon(c, { rim: 0.6, rimColor: new THREE.Color('#fff6c0') });
      return toon(c, { rim: role === 'skin' || role === 'shirt' ? 0.22 : 0.12, rimColor: new THREE.Color('#fff8e8') });
    },
    outline: { color: OUTLINE, width: 0.011 },
    castShadow: true,
    shadowColor: new THREE.Color('#1c3a66'),
    shadowOpacity: 0.28,
  };

  private prism!: THREE.Group;
  private prismY = 56;
  private scoreTex!: THREE.CanvasTexture;
  private scoreCtx!: CanvasRenderingContext2D;
  /** one breeze for trees, flags and bunting */
  private wind = new Wind(1, 0.25, 1);
  private rng = new Rng(20260927);
  private bumps = landBumps();
  private foliage!: Foliage;
  private clouds!: THREE.Group;
  private cloudMesh!: THREE.InstancedMesh;
  private birds: Birds | null = null;
  private wheel!: THREE.Group;
  private cabins!: THREE.InstancedMesh;
  private sails!: THREE.Group;
  /** instanced scenery the detail level thins (with full counts) */
  private optional: [THREE.InstancedMesh, number][] = [];
  private cm = new THREE.Matrix4();

  protected build() {
    const s = this.scene;
    s.fog = new THREE.Fog('#cfeeff', 90, 640);
    const sunDir = new THREE.Vector3(-0.45, 0.55, -1);
    s.add(
      skyDome(new THREE.Color('#2f7cf6'), new THREE.Color('#c8f0ff'), {
        sunDir,
        sunColor: new THREE.Color('#fff4d6'),
        sunSize: 0.012,
        ground: new THREE.Color('#9fd98a'),
        radius: 900,
      }),
    );

    // lights
    const sun = new THREE.DirectionalLight('#fff1d8', 2.5);
    sun.position.set(-16, 30, -12);
    sun.castShadow = true;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    s.add(sun, sun.target);
    s.add(new THREE.HemisphereLight('#cfe7ff', '#7fbf6a', 1.7));

    // ground & court
    const grass = toon('#62c46a', { gradient: [170, 230, 255], grain: 0.06 });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(62, 64), grass);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    s.add(ground);
    this.buildCourt({
      inner: toon('#3a74dc', { gradient: [150, 215, 255], grain: 0.05 }),
      outer: toon('#35a766', { gradient: [150, 215, 255], grain: 0.05 }),
      line: toon('#ffffff', { gradient: [200, 240, 255] }),
      innerPad: { x: 0.9, z: 1.6 },
      outerSize: { x: 11, z: 19 },
      lineWidth: 0.075,
      receiveShadow: true,
    });
    this.buildNet({
      post: toon('#2b2d42', { rim: 0.3 }),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 }),
      band: toon('#ffffff'),
    });

    // ball
    const ballMat = toon('#ffffff', { map: this.tennisBallTexture('#d6f23c', '#ffffff'), rim: 0.35, gradient: [170, 225, 255] });
    this.buildBall(ballMat, { color: new THREE.Color('#ffffff'), color2: new THREE.Color('#bfe6ff'), width: 0.075, opacity: 0.75 }, new THREE.Color('#10204a'), 0.5);
    addOutline(this.ball, OUTLINE, 0.012);
    this.buildParticles();

    this.foliage = new Foliage(this.wind, {
      material: (p) => cel({ vertexColors: p.vertexColors, rim: 0.22, rimColor: new THREE.Color('#fff7c8') }),
      tone: CEL_TONE,
      bark: new THREE.Color('#8a5a3a'),
      tree: TREE_SWAY,
      bush: BUSH_SWAY,
      shadows: false,
    });
    this.buildStands();
    this.buildLand();
    this.buildTown();
    this.buildLandmarks();
    this.buildTrees();
    this.buildScenery();
    this.buildFestive();
    this.buildSky();
    this.buildScoreboard();
    this.bloom = new Bloom(5);
    this.bloom.threshold = 0.95;
    this.bloom.knee = 0.4;
    const f = this.final.u;
    f.uBloom.value = 0.28;
    f.uSat.value = 1.12;
    f.uContrast.value = 1.04;
    f.uGain.value.set(1.02, 1.0, 0.97);
    f.uVignette.value = 0.22;
    f.uGrain.value = 0.012;

    this.effects = {
      // soft dark ovals under the feet (the cel look keeps its blob shadow; this grounds the shoes)
      contact: { strength: 0.5, color: new THREE.Color('#2a3a70') },
      grade: { lut: celGrade },
      // the court, its run-off and the stands (the shadow map is fitted to it per effects tier)
      shadow: { light: sun, area: new THREE.Box3(new THREE.Vector3(-17.5, 0, -27), new THREE.Vector3(17.5, 11, 21)), softness: 0.05 },
      dof: true,
    };
  }

  /** The ground's height at (x, z) (the stadium stands on 0). */
  private landAt(x: number, z: number) {
    const r = Math.hypot(x, z);
    const rise = smooth(64, 104, r);
    return -0.06 + rise * (bumpsAt(this.bumps, x, z) + 0.8 * Math.sin(x * 0.045 + 1.3) * Math.sin(z * 0.052 - 0.7));
  }

  private buildStands() {
    const s = this.scene;
    const standMat = toon('#f4f1fb', { gradient: [150, 210, 255] });
    const trimMats = [toon('#ff5a6e'), toon('#ffc53d'), toon('#3aa8ff'), toon('#35d49a')];
    const stands: Stand[] = [];
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(width, 0.55 + r * 0.55, 0.9), standMat);
        step.position.set(0, (0.55 + r * 0.55) / 2, r * 0.9 + 0.45);
        step.receiveShadow = true;
        step.castShadow = true;
        g.add(step);
      }
      // front trim
      const trim = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, 0.12), trimMats[(stands.length * 2) % 4]);
      trim.position.set(0, 0.25, -0.06);
      g.add(trim);
      outlineTree(g, OUTLINE, 0.02);
      g.position.set(cx, 0, cz);
      g.rotation.y = facing; // local +z points away from the court
      s.add(g);
      stands.push({ x: cx, z: cz, facing: facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    // sides (facing the court)
    mk(-10.5, 0, -Math.PI / 2, 22, 7);
    mk(10.5, 0, Math.PI / 2, 22, 7);
    // far end (facing +z)
    mk(0, -19.5, Math.PI, 18, 8);

    const shirts = ['#ff5a6e', '#3aa8ff', '#ffc53d', '#35d49a', '#b07cff', '#ff9a3d', '#ffffff', '#ff7ac8'].map((c) => new THREE.Color(c));
    const skins = SKINS.map((c) => new THREE.Color(c));
    this.addCrowd(
      new Crowd({
        stands,
        density: 1.05,
        bodyMat: toon('#ffffff', { gradient: [150, 215, 255] }),
        headMat: toon('#ffffff', { gradient: [150, 215, 255] }),
        shirts,
        skins,
        fill: 0.86,
      }),
    );
  }

  /** The land all round: one heightfield, one outline, fields and snow in its shader. */
  private buildLand() {
    const near = new THREE.Color('#62c46a'),
      hillTop = new THREE.Color('#79d177'),
      far = new THREE.Color('#6fb7a4'),
      farthest = new THREE.Color('#9cc8dc');
    const geo = landGeometry(
      (x, z) => this.landAt(x, z),
      (x, z, h, up, out) => {
        const r = Math.hypot(x, z);
        out.copy(near).lerp(hillTop, smooth(4, 30, h) * 0.6);
        // aerial perspective before the fog: bluer and paler with distance
        out.lerp(far, smooth(150, 300, r) * 0.7).lerp(farthest, smooth(300, 460, r) * 0.6);
        // steep flanks of the mountains a shade darker
        out.multiplyScalar(0.92 + 0.08 * smooth(0.55, 0.9, up));
      },
      { r0: 60, r1: 470, rings: 46, segs: 200, bias: 1.8 },
    );
    const land = new THREE.Mesh(geo, landMaterial());
    const line = new THREE.Mesh(geo, ink(INK.land));
    land.userData.noOutline = line.userData.noOutline = true;
    this.scene.add(land, line);
  }

  /**
   * A hillside town of pastel houses facing the stadium (instanced: walls and
   * roofs are two draws, their outlines two more), terraced up the town hill.
   */
  private buildTown() {
    const r = this.rng;
    const walls = ['#fff4e2', '#ffe1d6', '#e1f0ff', '#fff2b8', '#e6ffe8', '#f3e4ff', '#ffffff', '#ffd9a8'].map((c) => new THREE.Color(c));
    const roofs = ['#ff5a4e', '#ff8a3d', '#3a8cff', '#2fbf9a', '#ff5a8c', '#8a6cff', '#e8443a'].map((c) => new THREE.Color(c));
    type House = { x: number; z: number; y: number; w: number; h: number; d: number; yaw: number };
    const houses: House[] = [];
    const ok = (x: number, z: number, rad: number) => houses.every((h) => Math.hypot(h.x - x, h.z - z) > rad + Math.max(h.w, h.d) * 0.6);
    const place = (x: number, z: number, w: number, h: number, d: number) => {
      // (the clock tower's square)
      if (!ok(x, z, Math.max(w, d) * 0.6) || Math.hypot(x + 7, z + 121) < 8) return;
      // on the slope: sunk to its lowest corner, so it never floats
      const y = Math.min(this.landAt(x - w / 2, z - d / 2), this.landAt(x + w / 2, z - d / 2), this.landAt(x - w / 2, z + d / 2), this.landAt(x + w / 2, z + d / 2)) - 0.3;
      houses.push({ x, z, y, w, h, d, yaw: Math.atan2(-x, -z) + r.range(-0.12, 0.12) });
    };
    // terraces up the town hill, the rows staggered
    for (let row = 0; row < 6; row++) {
      const z = -102 - row * 7;
      const half = 30 + row * 4;
      for (let x = -half + (row % 2) * 4; x <= half; x += r.range(7.5, 10)) place(x + r.range(-1.2, 1.2), z + r.range(-1.2, 1.2), r.range(5, 7.5), r.range(4.5, 7.5), r.range(5, 7));
    }
    // farms on the hills round about
    for (let i = 0; i < 26; i++) {
      const a = r.range(-Math.PI * 0.95, Math.PI * 0.95);
      const d = r.range(90, 175);
      const x = Math.cos(a) * d,
        z = Math.sin(a) * d;
      // (not over the town, nor on the landmarks' hilltops)
      if (Math.abs(x) < 56 && z < -90 && z > -150) continue;
      if (Math.hypot(x - MILL_HILL.x, z - MILL_HILL.z) < 14 || Math.hypot(x - WHEEL_HILL.x, z - WHEEL_HILL.z) < 22) continue;
      place(x, z, r.range(5, 7), r.range(4, 6), r.range(5, 8));
    }
    // walls: a box, windows all round and a door on the front (+z) face
    const facade = canvasTex(256, 128, (x) => {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 256, 128);
      const win = (px: number, py: number, w: number, h: number) => {
        x.fillStyle = '#3a4a7a';
        x.fillRect(px, py, w, h);
        x.fillStyle = '#9fd0ff';
        x.fillRect(px + 3, py + 3, w - 6, (h - 6) * 0.45);
        x.fillStyle = '#ffffff';
        x.fillRect(px + w / 2 - 1.5, py, 3, h);
      };
      for (const px of [20, 76]) for (const py of [18, 70]) win(px, py, 32, 36);
      win(148, 18, 30, 34);
      win(206, 18, 30, 34);
      x.fillStyle = '#7a4a32';
      x.fillRect(176, 64, 32, 64);
      x.fillStyle = '#ffd24a';
      x.fillRect(200, 96, 4, 4);
    });
    const body = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const uv = body.attributes.uv as THREE.BufferAttribute;
    // BoxGeometry's faces: +x, -x, +y, -y, +z, -z (4 vertices each); the front gets the door half
    for (let i = 0; i < uv.count; i++) uv.setX(i, (Math.floor(i / 4) === 4 ? 0.5 : 0) + uv.getX(i) * 0.5);
    // a gable roof, its ridge running back from the front: the classic house shape from the stadium
    const roof = gableGeometry();
    const n = houses.length;
    const wallsMesh = new THREE.InstancedMesh(body, cel({ map: facade }), n);
    const roofMesh = new THREE.InstancedMesh(roof, cel({ rim: 0.18, rimColor: new THREE.Color('#fff2d0') }), n);
    const q = new THREE.Quaternion();
    const M = new THREE.Matrix4();
    const UP = new THREE.Vector3(0, 1, 0);
    houses.forEach((h, i) => {
      q.setFromAxisAngle(UP, h.yaw);
      wallsMesh.setMatrixAt(i, M.compose(new THREE.Vector3(h.x, h.y, h.z), q, new THREE.Vector3(h.w, h.h, h.d)));
      roofMesh.setMatrixAt(i, M.compose(new THREE.Vector3(h.x, h.y + h.h, h.z), q, new THREE.Vector3(h.w, h.w * r.range(0.45, 0.62), h.d)));
      wallsMesh.setColorAt(i, r.pick(walls));
      roofMesh.setColorAt(i, r.pick(roofs));
    });
    const houseInk = ink(INK.house);
    for (const [m, g] of [
      [wallsMesh, body],
      [roofMesh, roof],
    ] as const) {
      m.computeBoundingSphere();
      m.receiveShadow = false;
      this.scene.add(outlineInstances(m, houseInk, smoothHull(g)));
    }
  }

  /** The clock tower in the town, a windmill and a Ferris wheel on the hills round it. */
  private buildLandmarks() {
    const s = this.scene;
    const white = cel({ gradient: [160, 220, 255] });
    const cream = toon('#fff3dc', { gradient: [160, 220, 255] });
    const red = toon('#ff5a4e', { rim: 0.2 });
    const blue = toon('#3a8cff', { rim: 0.2 });
    const dark = toon('#2b2d42');
    const outlined = (m: THREE.Mesh, w = 0.05) => (addOutline(m, OUTLINE, w), m);
    // ---- clock tower, halfway up the town
    {
      const x = -7,
        z = -121;
      const y = this.landAt(x, z) - 0.5;
      const g = new THREE.Group();
      g.position.set(x, y, z);
      g.rotation.y = Math.atan2(-x, -z);
      const shaft = outlined(new THREE.Mesh(new THREE.BoxGeometry(4.2, 15, 4.2).translate(0, 7.5, 0), cream));
      const belfry = outlined(new THREE.Mesh(new THREE.BoxGeometry(5, 3.4, 5).translate(0, 16.7, 0), white));
      const spire = outlined(new THREE.Mesh(new THREE.ConeGeometry(4, 6, 4).rotateY(Math.PI / 4).translate(0, 21.4, 0), blue));
      const face = new THREE.Mesh(new THREE.CircleGeometry(1.5, 32).translate(0, 16.7, 2.52), white);
      const rim = outlined(new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.14, 6, 32).translate(0, 16.7, 2.52), dark), 0.02);
      const hands = new THREE.Mesh(mergeGeometries([new THREE.BoxGeometry(0.16, 1.1, 0.05).translate(0, 0.5, 0), new THREE.BoxGeometry(0.16, 0.8, 0.05).translate(0, 0.35, 0).rotateZ(-2.1)])!.translate(0, 16.7, 2.58), dark);
      const flag = new THREE.Mesh(new THREE.ConeGeometry(0.1, 2.6, 5).translate(0, 25.6, 0), dark);
      g.add(shaft, belfry, spire, face, rim, hands, flag);
      s.add(g);
    }
    // ---- windmill on its hill, sails turning into the wind
    {
      const x = MILL_HILL.x,
        z = MILL_HILL.z;
      const y = this.landAt(x, z) - 0.4;
      const g = new THREE.Group();
      g.position.set(x, y, z);
      g.rotation.y = Math.atan2(-x, -z);
      const tower = outlined(new THREE.Mesh(new THREE.CylinderGeometry(2.3, 3.4, 12, 8).translate(0, 6, 0), cream));
      const cap = outlined(new THREE.Mesh(new THREE.ConeGeometry(3, 3.2, 8).translate(0, 13.6, 0), red));
      const door = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.2).translate(0, 1.1, 3.25), dark);
      door.rotation.x = -0.09;
      g.add(tower, cap, door);
      // four lattice sails round a hub, turning about the axis that points at the stadium
      this.sails = new THREE.Group();
      this.sails.position.set(0, 12.2, 3.2);
      const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.45, 0.45, 0.8, 10).rotateX(Math.PI / 2)];
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        const arm = new THREE.BoxGeometry(0.28, 8.5, 0.2).translate(0, 4.4, 0);
        const sail = new THREE.BoxGeometry(1.7, 6.4, 0.08).translate(0.95, 5.1, 0.05);
        parts.push(arm.rotateZ(a), sail.rotateZ(a));
      }
      const sails = new THREE.Mesh(mergeGeometries(parts.map((p) => (p.deleteAttribute('uv'), p)))!, white);
      addOutline(sails, OUTLINE, 0.04);
      this.sails.add(sails);
      g.add(this.sails);
      s.add(g);
    }
    // ---- a Ferris wheel on the other hill: the wheel turns, the cabins hang level
    {
      const x = WHEEL_HILL.x,
        z = WHEEL_HILL.z;
      const y = this.landAt(x, z) - 0.3;
      const g = new THREE.Group();
      g.position.set(x, y, z);
      g.rotation.y = Math.atan2(-x, -z);
      const R = 12.5,
        hub = R + 3;
      // the A-frame on either side
      const legs: THREE.BufferGeometry[] = [];
      for (const side of [-1, 1])
        for (const dx of [-1, 1]) {
          const len = Math.hypot(hub, 7);
          legs.push(new THREE.BoxGeometry(0.6, len, 0.6).translate(0, len / 2, 0).rotateZ(-dx * Math.atan2(7, hub)).translate(dx * 7, 0, side * 1.8));
        }
      legs.push(new THREE.CylinderGeometry(0.35, 0.35, 4.2, 8).rotateX(Math.PI / 2).translate(0, hub, 0));
      const frame = outlined(new THREE.Mesh(mergeGeometries(legs.map((p) => (p.deleteAttribute('uv'), p)))!, white), 0.04);
      g.add(frame);
      this.wheel = new THREE.Group();
      this.wheel.position.set(0, hub, 0);
      const wparts: THREE.BufferGeometry[] = [];
      for (const side of [-1, 1]) {
        wparts.push(new THREE.TorusGeometry(R, 0.28, 6, 72).translate(0, 0, side * 1.1));
        for (let k = 0; k < 12; k++) wparts.push(new THREE.BoxGeometry(0.16, R, 0.16).translate(0, R / 2, side * 1.1).rotateZ((k / 12) * Math.PI * 2));
      }
      for (const p of wparts) p.deleteAttribute('uv');
      const rim = new THREE.Mesh(mergeGeometries(wparts)!, toon('#ff5a8c', { rim: 0.25 }));
      addOutline(rim, OUTLINE, 0.035);
      this.wheel.add(rim);
      g.add(this.wheel);
      // cabins: one instanced draw (and its outline), placed each frame round the rim
      const cab = mergeGeometries([new THREE.BoxGeometry(1.8, 1.5, 1.6).translate(0, -1.3, 0), new THREE.ConeGeometry(1.35, 0.7, 4).rotateY(Math.PI / 4).translate(0, -0.2, 0)].map((p) => (p.deleteAttribute('uv'), p)))!;
      this.cabins = new THREE.InstancedMesh(cab, cel({ rim: 0.2 }), 12);
      const cols = ['#ffc53d', '#3aa8ff', '#35d49a', '#ff7a3d', '#b07cff', '#ff5a6e'].map((c) => new THREE.Color(c));
      for (let k = 0; k < 12; k++) this.cabins.setColorAt(k, cols[k % cols.length]);
      this.cabins.position.set(0, hub, 0);
      this.cabins.frustumCulled = false;
      this.placeCabins(0);
      g.add(outlineInstances(this.cabins, ink(0.035), smoothHull(cab)));
      s.add(g);
    }
  }

  /** Put the Ferris wheel's cabins round its rim at turn `a`, hanging level. */
  private placeCabins(a: number) {
    const R = 12.5;
    for (let k = 0; k < 12; k++) {
      const t = a + (k / 12) * Math.PI * 2;
      this.cabins.setMatrixAt(k, this.cm.makeTranslation(Math.cos(t) * R, Math.sin(t) * R, 0));
    }
    this.cabins.instanceMatrix.needsUpdate = true;
  }

  /**
   * Trees in the wind, outlined: rows behind the stands, a garden at the
   * entrance, woods over the hills. Round crowns, slim poplars and pines; each
   * kind one draw and one outline draw.
   */
  private buildTrees() {
    const r = this.rng;
    const leaf = ['#3fae5a', '#58c26a', '#2f9a52', '#7ad36e', '#48b85e'].map((c) => new THREE.Color(c));
    const pineGreen = ['#2b8f5a', '#34a05e', '#2a8454'].map((c) => new THREE.Color(c));
    const blossom = ['#ffb3cf', '#ffd0e0', '#ffc2a8'].map((c) => new THREE.Color(c));
    const kinds = { round: [] as Place[], tall: [] as Place[], pine: [] as Place[] };
    const shade: { x: number; z: number; s: number }[] = [];
    const tree = (kind: keyof typeof kinds, x: number, z: number, sc: number, color?: THREE.Color, y = 0) => {
      kinds[kind].push({ x, z, y, s: sc * r.range(0.9, 1.1), sy: r.range(0.92, 1.1), yaw: r.range(0, Math.PI * 2), color: color ?? (kind === 'pine' ? r.pick(pineGreen) : r.pick(leaf)) });
      if (y === 0) shade.push({ x, z, s: sc * (kind === 'round' ? 1.3 : 0.9) });
    };
    // behind the side stands: a row of round trees and poplars, pines behind them
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 9; i++) tree(i % 2 ? 'tall' : 'round', sx * (20.5 + r.range(-0.5, 0.5)), -22 + i * 5.6, i % 2 ? 1.05 : 1.15);
      for (let i = 0; i < 7; i++) tree('pine', sx * (27 + r.range(-1, 1)), -20 + i * 7 + r.range(-1, 1), r.range(1.1, 1.35));
    }
    // behind the far stand, seen above it
    for (let i = 0; i < 11; i++) tree(i % 3 === 1 ? 'pine' : 'round', -33 + i * 6.6 + r.range(-0.8, 0.8), -33 + r.range(-1.5, 1.5), r.range(1.15, 1.4), i === 3 || i === 8 ? r.pick(blossom) : undefined);
    for (let i = 0; i < 9; i++) tree(i % 2 ? 'tall' : 'pine', -30 + i * 7.5 + r.range(-1, 1), -41 + r.range(-1.5, 1.5), r.range(1.2, 1.45));
    // the entrance (+z): an avenue to the gate, blossom at its end
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 5; i++) tree('round', sx * 8.5, 27 + i * 8, 1.1, i === 4 ? r.pick(blossom) : undefined);
      for (let i = 0; i < 4; i++) tree('tall', sx * (18 + r.range(-1, 1)), 30 + i * 9, 1.1);
      tree('round', sx * 30, 34, 1.3);
      tree('pine', sx * 38, 46, 1.35);
    }
    // woods over the hills: clumps, never over the town or a landmark
    const farKinds = { round: [] as Place[], tall: [] as Place[], pine: [] as Place[] };
    for (let c = 0; c < 26; c++) {
      const a = r.range(-Math.PI, Math.PI);
      const d = r.range(68, 185);
      const cx = Math.cos(a) * d,
        cz = Math.sin(a) * d;
      if (Math.abs(cx) < 60 && cz < -88 && cz > -152) continue;
      if (Math.hypot(cx - MILL_HILL.x, cz - MILL_HILL.z) < 16 || Math.hypot(cx - WHEEL_HILL.x, cz - WHEEL_HILL.z) < 24) continue;
      const kind: keyof typeof kinds = r.pick(['round', 'round', 'pine', 'pine', 'tall']);
      const n = r.int(3, 7);
      for (let k = 0; k < n; k++) {
        const x = cx + r.range(-9, 9),
          z = cz + r.range(-9, 9);
        if (Math.hypot(x, z) < 66) continue;
        farKinds[kind].push({ x, z, y: this.landAt(x, z) - 0.2, s: r.range(1.2, 1.7), sy: r.range(0.9, 1.15), yaw: r.range(0, 6.3), color: kind === 'pine' ? r.pick(pineGreen) : r.pick(leaf) });
      }
    }
    const f = this.foliage;
    const treeInk = ink(INK.plant, OUTLINE, (m) => sway(m, this.wind, 'canopy', TREE_SWAY));
    // (far off, fewer facets: the crowns are a few pixels across)
    const crown = (kind: 'round' | 'tall', seed: number, seg: number) => f.treeGeometry(clumpGeometry(crownBlobs(kind, seed), { seed, seg, lumpy: 0.05, tone: CEL_TONE }));
    const geos = {
      round: [crown('round', 11, 8), crown('round', 11, 6)],
      tall: [crown('tall', 23, 8), crown('tall', 23, 6)],
      pine: [f.treeGeometry(pineCrown(10)), f.treeGeometry(pineCrown(7))],
    };
    for (const k of ['round', 'tall', 'pine'] as const) {
      for (const [set, far] of [
        [kinds[k], false],
        [farKinds[k], true],
      ] as const) {
        if (!set.length) continue;
        const m = outlineInstances(f.add(geos[k][far ? 1 : 0], f.leaf, set, { receive: false }), treeInk);
        if (far) this.optional.push([m, set.length]);
      }
    }
    // a soft cel shadow under each tree on the flat
    const blob = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: blobShadowTexture(), color: '#1c3a66', transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      shade.length,
    );
    const M = new THREE.Matrix4();
    shade.forEach((b, i) => blob.setMatrixAt(i, M.makeScale(b.s * 3.4, 1, b.s * 3.4).setPosition(b.x + 0.5, 0.01, b.z + 0.4)));
    blob.renderOrder = -1;
    blob.computeBoundingSphere();
    this.scene.add(f.group, blob);
  }

  private buildScenery() {
    const s = this.scene;
    const r = this.rng;
    // the Prism monument on its hill
    this.prism = new THREE.Group();
    const facets = ['#ff5a8a', '#ffb13d', '#ffe34d', '#4be3a2', '#52a7ff', '#a07cff'];
    const geo = new THREE.OctahedronGeometry(9, 0);
    const nonIdx = geo.index ? geo.toNonIndexed() : geo;
    const colors: number[] = [];
    const tri = nonIdx.attributes.position.count / 3;
    for (let i = 0; i < tri; i++) {
      const c = new THREE.Color(facets[i % facets.length]);
      for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
    }
    nonIdx.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const pm = new THREE.Mesh(nonIdx, toon('#ffffff', { vertexColors: true, rim: 0.5, emissive: new THREE.Color('#301a40'), gradient: [180, 230, 255] }));
    pm.scale.y = 1.6;
    addOutline(pm, OUTLINE, 0.12);
    this.prism.add(pm);
    // its plinth on the hilltop, the gem hovering high over it (seen over the town from the stadium)
    const top = this.landAt(PRISM_HILL.x, PRISM_HILL.z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(5, 7, 4, 6), toon('#f2eefc'));
    base.position.set(PRISM_HILL.x, top + 1, PRISM_HILL.z);
    addOutline(base, OUTLINE, 0.1);
    s.add(base);
    this.prismY = top + 24;
    this.prism.position.set(PRISM_HILL.x, this.prismY, PRISM_HILL.z);
    s.add(this.prism);

    // windscreens with the logo
    const logo = canvasTex(1024, 128, (x) => {
      x.fillStyle = '#2d6ad0';
      x.fillRect(0, 0, 1024, 128);
      x.font = '700 82px Fredoka, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      const word = 'KALEIDO   ·   KALEIDO   ·   KALEIDO';
      x.fillStyle = '#ffffff';
      x.fillText(word, 512, 68);
    });
    logo.wrapS = THREE.RepeatWrapping;
    const wallMat = toon('#ffffff', { map: logo, gradient: [190, 235, 255] });
    const wall = (w: number, x: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, 0.14), wallMat);
      m.position.set(x, 0.55, z);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      addOutline(m, OUTLINE, 0.018);
      s.add(m);
    };
    wall(17, 0, -17.4, 0);
    wall(34, -9.2, 0, Math.PI / 2);
    wall(34, 9.2, 0, -Math.PI / 2);

    // planters with flowers at the court corners
    const pot = toon('#f7f2ff');
    const petals = ['#ff5a8a', '#ffe34d', '#ffffff', '#ff9a3d', '#b07cff'].map((c) => toon(c));
    const stem = toon('#3d9a58');
    for (const [x, z] of [
      [-8.4, -16.4],
      [8.4, -16.4],
      [-8.4, 15.8],
      [8.4, 15.8],
    ]) {
      const g = new THREE.Group();
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.55, 0.8, 12), pot);
      p.position.y = 0.4;
      g.add(p);
      for (let i = 0; i < 9; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), petals[i % petals.length]);
        const a = (i / 9) * Math.PI * 2;
        f.position.set(Math.cos(a) * 0.45, 0.95 + r.range(0, 0.2), Math.sin(a) * 0.45);
        g.add(f);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 4), stem);
        st.position.set(f.position.x, 0.8, f.position.z);
        g.add(st);
      }
      outlineTree(g, OUTLINE, 0.02);
      g.position.set(x, 0, z);
      s.add(g);
    }

    // umpire chair
    const chair = new THREE.Group();
    const wood = toon('#ffffff');
    for (const [dx, dz] of [
      [-0.4, -0.4],
      [0.4, -0.4],
      [-0.4, 0.4],
      [0.4, 0.4],
    ]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), wood);
      leg.position.set(dx, 1.1, dz);
      chair.add(leg);
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1, 0.15, 1), toon('#3aa8ff'));
    seat.position.y = 2.2;
    chair.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.12), toon('#3aa8ff'));
    back.position.set(0, 2.75, -0.45);
    chair.add(back);
    const umbrella = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.5, 8), toon('#ffc53d'));
    umbrella.position.y = 4.1;
    chair.add(umbrella);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), wood);
    stick.position.y = 3.4;
    chair.add(stick);
    outlineTree(chair, OUTLINE, 0.02);
    chair.position.set(-7.4, 0, 0.4);
    chair.rotation.y = Math.PI / 2;
    chair.traverse((o) => (o.castShadow = true));
    chair.userData.noBatch = true;
    this.tennisOnly.push(chair);
    s.add(chair);

    // the entrance (+z): a gate with the name over the avenue, flower beds either side
    const gateMat = toon('#ffffff', { gradient: [160, 220, 255] });
    const gate = new THREE.Group();
    for (const sx of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 7, 1.4).translate(sx * 6, 3.5, 0), gateMat);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 10).translate(sx * 6, 7.6, 0), toon(sx < 0 ? '#ff5a6e' : '#3aa8ff', { rim: 0.3 }));
      gate.add(pillar, cap);
    }
    const sign = canvasTex(1024, 192, (x) => {
      x.fillStyle = '#ffc53d';
      x.fillRect(0, 0, 1024, 192);
      x.font = '700 128px Fredoka, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillStyle = '#2b2d42';
      x.fillText('KALEIDO', 512, 104);
    });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(14.4, 2.2, 0.7).translate(0, 6.2, 0), [gateMat, gateMat, gateMat, gateMat, toon('#ffffff', { map: sign }), toon('#ffffff', { map: sign })]);
    gate.add(beam);
    outlineTree(gate, OUTLINE, 0.04);
    gate.position.set(0, 0, 60);
    gate.rotation.y = Math.PI;
    s.add(gate);
    // bushes and flowers: along the stands' backs, round the gate and in beds by the avenue
    const bush = ['#3fae5a', '#58c26a', '#2f9a52'].map((c) => new THREE.Color(c));
    const flower = ['#ff5a8a', '#ffe34d', '#ffffff', '#ff9a3d', '#b07cff', '#ff4d6d', '#5ab8ff'].map((c) => new THREE.Color(c));
    const bushes: Place[] = [];
    const blooms: Place[] = [];
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 16; i++) bushes.push({ x: sx * 17.6, z: -20 + i * 2.6 + r.range(-0.3, 0.3), s: r.range(1.1, 1.4), sy: r.range(0.9, 1.1), yaw: r.range(0, 6.3), color: r.pick(bush) });
      // flower beds along the avenue
      for (let k = 0; k < 140; k++) blooms.push({ x: sx * r.range(10, 14.5), z: r.range(24, 58), s: r.range(1, 1.4), sy: r.range(0.7, 1.1), yaw: r.range(0, 6.3), color: r.pick(flower) });
      for (let k = 0; k < 8; k++) bushes.push({ x: sx * r.range(9.5, 15), z: r.pick([23.5, 58.5]) + r.range(-0.4, 0.4), s: r.range(0.9, 1.2), sy: r.range(0.9, 1.1), yaw: r.range(0, 6.3), color: r.pick(bush) });
    }
    // a wildflower meadow either side of the far stand
    for (let k = 0; k < 220; k++) {
      const sx = r.chance(0.5) ? -1 : 1;
      blooms.push({ x: sx * r.range(14, 44), z: r.range(-48, -24), s: r.range(0.9, 1.3), sy: r.range(0.6, 1), yaw: r.range(0, 6.3), color: r.pick(flower) });
    }
    const f = this.foliage;
    const b = f.bushes(bushes, 5, { shadow: false, seg: 8 });
    if (b) outlineInstances(b, ink(0.035, OUTLINE, (m) => sway(m, this.wind, 'canopy', BUSH_SWAY)));
    const fl = f.flowers(blooms, 0.36);
    if (fl) fl.userData.noOutline = true;
  }

  /** Flags round the stands and bunting between their poles, all fluttering in the wind (two draws). */
  private buildFestive() {
    const s = this.scene;
    const poleMat = toon('#ffffff');
    const poles: Pole[] = [];
    let cell = 0;
    // the far end's four, and a row along the back of each side stand
    for (const x of [-12, -6, 6, 12]) poles.push({ x, z: -24.5, h: 11, s: 1.25, cell: cell++ });
    for (const sx of [-1, 1]) for (const z of [-10, -3.3, 3.3, 10]) poles.push({ x: sx * 17.3, z, h: 8.4, s: 0.85, cell: cell++ });
    const colors = ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a', '#b07cff', '#ff9a3d'];
    const parts = flags(this.wind, poles, colors, { pole: poleMat, finial: toon('#ffc53d', { rim: 0.4 }), cloth: (p) => toon('#ffffff', { ...p, gradient: [170, 225, 255] }), shadow: false });
    for (const p of parts) if ((p as THREE.Mesh).isMesh && !(p as THREE.InstancedMesh).isInstancedMesh) addOutline(p as THREE.Mesh, OUTLINE, 0.02);
    s.add(...parts);
    // bunting: pennants along sagging strings between the poles
    const spans: [THREE.Vector3, THREE.Vector3, number][] = [];
    const far = [-12, -6, 6, 12];
    for (let i = 0; i < 3; i++) {
      spans.push([new THREE.Vector3(far[i], 9.7, -24.5), new THREE.Vector3(far[i + 1], 9.7, -24.5), 1.3]);
      spans.push([new THREE.Vector3(far[i], 8.1, -24.5), new THREE.Vector3(far[i + 1], 8.1, -24.5), 0.9]);
    }
    for (const sx of [-1, 1]) {
      const zs = [-10, -3.3, 3.3, 10];
      for (let i = 0; i < 3; i++) spans.push([new THREE.Vector3(sx * 17.3, 6.8, zs[i]), new THREE.Vector3(sx * 17.3, 6.8, zs[i + 1]), 0.8]);
    }
    const pennants: { p: THREE.Vector3; yaw: number; c: THREE.Color }[] = [];
    const strings: THREE.BufferGeometry[] = [];
    const pcol = colors.concat(['#ffffff']).map((c) => new THREE.Color(c));
    let pi = 0;
    for (const [a, b, sag] of spans) {
      const len = a.distanceTo(b);
      const at = (u: number) => new THREE.Vector3().lerpVectors(a, b, u).setY(a.y + (b.y - a.y) * u - Math.sin(u * Math.PI) * sag);
      const pts = Array.from({ length: 17 }, (_, i) => at(i / 16));
      strings.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.025, 4));
      const n = Math.floor(len / 0.72);
      const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
      for (let i = 1; i < n; i++) pennants.push({ p: at(i / n), yaw, c: pcol[pi++ % pcol.length] });
    }
    for (const g of strings) g.deleteAttribute('uv');
    s.add(new THREE.Mesh(mergeGeometries(strings)!, toon('#2b2d42')));
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-0.3, 0, 0, 0.3, 0, 0, 0, -0.72, 0], 3));
    tri.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0], 2));
    const flutter: SwayOpts = { amp: 0.09, height: 1, flutter: 0.03 };
    const bunting = new THREE.InstancedMesh(tri, sway(toon('#ffffff', { side: THREE.DoubleSide, gradient: [170, 225, 255] }), this.wind, 'cloth', flutter), pennants.length);
    const q = new THREE.Quaternion();
    const M = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    pennants.forEach((p, i) => {
      bunting.setMatrixAt(i, M.compose(p.p, q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), one));
      bunting.setColorAt(i, p.c);
    });
    bunting.computeBoundingSphere();
    bunting.boundingSphere!.radius += 1;
    s.add(bunting);
  }

  /** Cel-shaded clouds drifting round (one draw and its outline) and birds over the town. */
  private buildSky() {
    const r = this.rng;
    // a cumulus: puffs on a flat base, shaded as one volume in two bands
    const blobs: [number, number, number, number, number?][] = [
      [0, 3.2, 0, 4.6],
      [-4.6, 2.1, 0.6, 3.4],
      [4.8, 2.3, -0.4, 3.6],
      [-8.4, 1.3, 0.2, 2.4],
      [8.6, 1.4, 0.5, 2.5],
      [1.6, 5.6, 0.4, 3.2],
      [-2.4, 5.0, -0.6, 2.8],
    ];
    const cloud = clumpGeometry(blobs, { seg: 10, lumpy: 0.03, lean: 0.75, tone: { low: new THREE.Color(0.9, 0.93, 1), high: new THREE.Color(1, 1, 1) } });
    // flatten the undersides: clouds sit on a level base
    const pos = cloud.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, Math.max(pos.getY(i), 0.6 + (pos.getY(i) - 0.6) * 0.25));
    const n = 24;
    this.cloudMesh = new THREE.InstancedMesh(cloud, toon('#ffffff', { vertexColors: true, gradient: [196, 235, 255], rim: 0.12, fog: false }), n);
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.range(-0.1, 0.1);
      const d = r.range(190, 330);
      const sc = r.range(1.5, 3.2);
      this.cloudMesh.setMatrixAt(i, M.compose(new THREE.Vector3(Math.cos(a) * d, r.range(48, 105), Math.sin(a) * d), q.setFromAxisAngle(UP, -a + Math.PI / 2 + r.range(-0.3, 0.3)), new THREE.Vector3(sc, sc * r.range(0.8, 1.05), sc)));
    }
    this.cloudMesh.frustumCulled = false;
    const cloudInk = new THREE.MeshBasicMaterial({ color: '#8fb6e4', fog: false });
    this.clouds = new THREE.Group();
    this.clouds.add(outlineInstances(this.cloudMesh, hull(cloudInk, INK.cloud)));
    this.clouds.userData.noBatch = true;
    this.scene.add(this.clouds);
    this.birds = new Birds(
      this.wind.u,
      [
        { x: -10, y: 34, z: -110, radius: 22, count: 9, speed: 0.12 },
        { x: 70, y: 40, z: -60, radius: 16, count: 6, speed: -0.15 },
        { x: -60, y: 30, z: 40, radius: 18, count: 5, speed: 0.13 },
      ],
      '#2d2a48',
    );
    this.scene.add(this.birds.mesh);
  }

  private buildScoreboard() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 360;
    this.scoreCtx = c.getContext('2d')!;
    this.scoreTex = new THREE.CanvasTexture(c);
    this.scoreTex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(10, 3.5), new THREE.MeshBasicMaterial({ map: this.scoreTex, fog: true }));
    board.position.set(0, 12.5, -26);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(10.6, 4.1, 0.4), toon('#2b2d42'));
    frame.position.set(0, 12.5, -26.25);
    addOutline(frame, OUTLINE, 0.04);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 10.5, 0.4), toon('#2b2d42'));
    legs.position.set(-3.5, 5.2, -26.3);
    const legs2 = legs.clone();
    legs2.position.x = 3.5;
    this.scene.add(board, frame, legs, legs2);
    this.setScoreboard(['KALEIDO', ''], ['', ''], ['', '']);
  }

  setScoreboard(names: [string, string], games: [string, string], points: [string, string]) {
    const x = this.scoreCtx;
    x.fillStyle = '#16172a';
    x.fillRect(0, 0, 1024, 360);
    x.fillStyle = '#23254a';
    x.fillRect(12, 12, 1000, 336);
    x.font = '700 64px Fredoka, sans-serif';
    x.textBaseline = 'middle';
    const rows = [0, 1];
    for (const i of rows) {
      const y = 108 + i * 145;
      x.fillStyle = i === 0 ? '#ff5a6e' : '#3aa8ff';
      x.fillRect(36, y - 52, 16, 104);
      x.fillStyle = '#ffffff';
      x.textAlign = 'left';
      x.fillText(names[i].slice(0, 16), 76, y);
      x.textAlign = 'center';
      x.fillStyle = '#ffe34d';
      x.fillText(games[i], 790, y);
      x.fillStyle = '#ffffff';
      x.fillText(points[i], 930, y);
    }
    this.scoreTex.needsUpdate = true;
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    this.wind.tick(t);
    // the clouds drift round together, as the wind carries them
    this.clouds.rotation.y = t * 0.0045;
    this.prism.rotation.y = t * 0.25;
    this.prism.position.y = this.prismY + Math.sin(t * 0.8) * 1.5;
    this.sails.rotation.z = -t * 0.9;
    const a = t * 0.06;
    this.wheel.rotation.z = a;
    this.placeCabins(a);
  }

  protected onDetail(d: number) {
    const k = Math.min(1, 0.35 + 0.65 * d);
    for (const [m, n] of this.optional) m.count = Math.round(n * k);
    this.cloudMesh.count = Math.round(24 * (0.4 + 0.6 * d));
    this.foliage.setDetail(d);
    this.birds?.setDetail(d);
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({
        x: e.pos.x,
        y: e.pos.y,
        z: e.pos.z,
        count: big ? 22 : 10,
        speed: [2, big ? 7 : 4],
        life: [0.25, 0.55],
        size: [0.08, big ? 0.3 : 0.18],
        shrink: 0.2,
        colors: e.perfect ? [new THREE.Color('#fff27a'), new THREE.Color('#ffffff'), new THREE.Color('#ffb13d')] : [new THREE.Color('#ffffff'), new THREE.Color('#dff4ff')],
        shape: 'star',
        drag: 3,
      });
      if (e.perfect) P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: 1, speed: [0, 0], life: [0.35, 0.35], size: [0.3, 0.3], shrink: 6, colors: [new THREE.Color('#ffffff')], shape: 'ring', alpha: 0.8 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      P.burst({
        x: e.pos.x,
        y: 0.05,
        z: e.pos.z,
        count: 6,
        speed: [0.5, 1.4],
        dir: [0, 1, 0],
        spread: 0.9,
        life: [0.3, 0.6],
        size: [0.12, 0.25],
        shrink: 1.8,
        colors: [new THREE.Color('#e8f4ff')],
        shape: 'soft',
        alpha: 0.5,
        drag: 4,
      });
    }
    if (e.type === 'point') {
      P.burst({
        x: 0,
        y: 8,
        z: e.winner === 0 ? 6 : -6,
        count: 90,
        speed: [3, 9],
        dir: [0, 1, 0],
        spread: 0.8,
        life: [2, 3.5],
        size: [0.14, 0.24],
        colors: ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a', '#ffffff', '#b07cff'].map((c) => new THREE.Color(c)),
        shape: 'confetti',
        gravity: 3,
        drag: 1.2,
        spin: 10,
        ground: true,
      });
    }
  }
}

/** how trees and bushes move in the wind (their outlines must move alike) */
const TREE_SWAY: SwayOpts = { amp: 0.2, height: 6, flutter: 0.02 };
const BUSH_SWAY: SwayOpts = { amp: 0.06, height: 1.1, flutter: 0.012 };

/** A gable roof over a unit footprint (the instance scales it), ridge front to back, eaves overhanging. */
function gableGeometry() {
  const w = 0.58,
    d = 0.6;
  // prettier as flat facets: each face its own vertices
  const v = (x: number, y: number, z: number) => [x, y, z];
  const quads = [
    // left and right slopes
    [v(-w, 0, d), v(0, 1, d), v(0, 1, -d), v(-w, 0, -d)],
    [v(w, 0, -d), v(0, 1, -d), v(0, 1, d), v(w, 0, d)],
    // underside
    [v(-w, 0, -d), v(w, 0, -d), v(w, 0, d), v(-w, 0, d)],
  ];
  const pos: number[] = [];
  for (const [a, b, c, e] of quads) pos.push(...a, ...b, ...c, ...a, ...c, ...e);
  // the gable ends
  pos.push(...v(-w, 0, d), ...v(w, 0, d), ...v(0, 1, d), ...v(w, 0, -d), ...v(-w, 0, -d), ...v(0, 1, -d));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A pine's crown: three stacked cones, lighter towards the top (vertex colours, for the leaf material). */
function pineCrown(seg: number) {
  const tiers = [
    [2.1, 2.6, 3.3],
    [1.65, 2.3, 4.7],
    [1.15, 2.0, 5.9],
  ];
  const parts = tiers.map(([r, h, y]) => {
    const c = new THREE.ConeGeometry(r, h, seg, 1);
    c.deleteAttribute('uv');
    return c.translate(0, y, 0);
  });
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const k = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    k.copy(CEL_TONE.low).lerp(CEL_TONE.high, smooth(2, 7, pos.getY(i)));
    col.set([k.r, k.g, k.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export const PLAZA: WorldDef = {
  id: 'plaza',
  name: 'Sunny Plaza',
  tagline: 'Where every rally begins',
  blurb: 'Blue skies, bright colours and a roaring home crowd.',
  ui: {
    accent: '#3aa8ff',
    accent2: '#ffc53d',
    ink: '#1d1c33',
    paper: '#ffffff',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Fredoka', system-ui, sans-serif",
    panel: 'linear-gradient(160deg, rgba(255,255,255,0.96), rgba(233,243,255,0.94))',
  },
  song: 'plaza',
  surface: 1,
  make: (r) => new PlazaWorld(PLAZA, r),
};

export { COURT };
