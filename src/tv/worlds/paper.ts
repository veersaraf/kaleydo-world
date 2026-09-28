// PAPER ISLES — a pop-up book diorama. Layered paper hills, clouds on
// strings, a cardboard court, and players who are paper cut-outs with white
// sticker borders.
//
// The island stands in a paper sea. Behind the far stand, hills are cut from
// sheets of paper and stood up one behind another, further and further back,
// from spring green to the blue of snowy mountains. Each sheet throws a soft
// shadow onto the sheet behind it: every sheet's top edge is kept in a small
// profile texture, and the sheet behind darkens under it (no shadow map
// reaches that far), so the layers stand apart and shift against each other
// as the camera moves. Trees and cottages stand on their ridges, a pinwheel
// turns, rows of waves slide to and fro on the sea, boats bob, the lighthouse
// sweeps its beam, clouds swing on their strings.
//
// Everything static and paper is one vertex-coloured material (faces in the
// sheet's colour, cut edges cream), so the batcher draws the whole backdrop in
// one call; what moves does so in vertex shaders.

import * as THREE from 'three';
import { FIRE_STYLE } from '../render/smashfx';

const cs = (a: string[]) => a.map((c) => new THREE.Color(c));
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import type { MatchEvent } from '../tennis/match';
import { Rng } from '../core/math';
import { Wind, motion, swayDepth, type SwayOpts } from './park-env/wind';
import { Foliage, type Place } from './park-env/foliage';
import { Birds } from './park-env/props';
import { smooth } from './park-env/land';

let paperTex: THREE.Texture | null = null;
function paper() {
  if (paperTex) return paperTex;
  paperTex = canvasTex(512, 512, (x) => {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 512, 512);
    const img = x.getImageData(0, 0, 512, 512);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = 238 + Math.random() * 17;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
    }
    x.putImageData(img, 0, 0);
    x.strokeStyle = 'rgba(150,140,120,0.18)';
    for (let i = 0; i < 260; i++) {
      x.lineWidth = Math.random() * 1.2;
      x.beginPath();
      const px = Math.random() * 512,
        py = Math.random() * 512;
      x.moveTo(px, py);
      x.bezierCurveTo(px + Math.random() * 20 - 10, py + Math.random() * 20 - 10, px + Math.random() * 30 - 15, py + Math.random() * 30 - 15, px + Math.random() * 40 - 20, py + Math.random() * 40 - 20);
      x.stroke();
    }
  });
  paperTex.wrapS = paperTex.wrapT = THREE.RepeatWrapping;
  return paperTex;
}

/** the paper texture, one tile every 1/`repeat` uv units */
function paperMap(repeat: number) {
  const t = paper().clone();
  t.needsUpdate = true;
  t.repeat.set(repeat, repeat);
  return t;
}

const P = (color: THREE.ColorRepresentation, repeat = 1, side: THREE.Side = THREE.FrontSide) => new THREE.MeshLambertMaterial({ color, map: paperMap(repeat), side });

/** the colour of a cut edge: the paper's own cream */
const CREAM = new THREE.Color('#f4ecd8');
const col = (c: string) => new THREE.Color(c);

function cloudShape(r: number) {
  const s = new THREE.Shape();
  s.moveTo(-r * 2, 0);
  s.absarc(-r * 1.3, r * 0.3, r * 0.7, Math.PI, Math.PI * 0.35, true);
  s.absarc(-r * 0.2, r * 0.75, r * 0.95, Math.PI * 0.95, Math.PI * 0.1, true);
  s.absarc(r * 1.1, r * 0.35, r * 0.75, Math.PI * 0.7, 0, true);
  s.lineTo(r * 1.85, 0);
  s.lineTo(-r * 2, 0);
  return s;
}

// ---------------------------------------------------------------- cut paper geometry
//
// Every piece is non-indexed, with a colour per vertex (face or cut edge), uvs
// in metres for the paper's grain and `aDrop` (whose sheet shades it, see
// sheetMaterial), so any two merge.

/** A shape cut from paper `depth` thick, its front face at z = 0 facing +z: faces `face`, cut edges `edge`. */
function cutout(shape: THREE.Shape | THREE.Shape[], depth: number, face: THREE.Color, edge = CREAM, curveSegments = 12) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments }).translate(0, 0, -depth);
  return finish(g, face, edge);
}

/** Colour an extruded or plain geometry (groups: 0 = faces, 1 = edges) and give it the shared attributes. */
function finish(g0: THREE.BufferGeometry, face: THREE.Color, edge = face) {
  const g = g0.index ? g0.toNonIndexed() : g0;
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
  for (const gr of groups) {
    const k = gr.materialIndex === 0 ? face : edge;
    for (let i = gr.start; i < Math.min(n, gr.start + gr.count); i++) c.set([k.r, k.g, k.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.clearGroups();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  return drop(g, -1, 0, 0);
}

/**
 * Tag a geometry with the sheet whose shadow falls on it (row -1 = none), that
 * shadow's offset and softness in metres, and whether flowers are printed on it.
 */
function drop(g: THREE.BufferGeometry, row: number, off: number, soft: number, print = 0) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) a.set([row, off, soft, print], i * 4);
  g.setAttribute('aDrop', new THREE.BufferAttribute(a, 4));
  return g;
}

/** A box (a cardboard block, a house body), non-indexed and coloured. */
const block = (w: number, h: number, d: number, c: THREE.Color) => finish(new THREE.BoxGeometry(w, h, d), c);

/** merge (and dispose) pieces placed with translate/rotate beforehand */
function join(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

// ---------------------------------------------------------------- the sheets

interface Sheet {
  z: number;
  /** its extent across */
  x0: number;
  x1: number;
  color: string;
  /** the top edge's height at x */
  top: (x: number) => number;
  /** snow above this height (mountains) */
  snow?: number;
}

/** profile texture: each sheet's top edge sampled across x */
const PROF = { x0: -260, x1: 260, n: 1024 };

/**
 * The backdrop sheets' material: paper, vertex-coloured, and darkened under
 * the sheet in front (aDrop.x its row in the profile texture): a soft band that
 * starts at that sheet's edge, shifted a little right, and fades upwards. The
 * nearest meadows have little flowers printed on them (aDrop.w), fading out
 * before they'd be smaller than a pixel.
 */
function sheetMaterial(profile: THREE.Texture, rows: number) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.16) });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tProfile = { value: profile };
    sh.uniforms.uProf = { value: new THREE.Vector3(PROF.x0, 1 / (PROF.x1 - PROF.x0), rows) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aDrop;\nvarying vec4 vDrop;\nvarying vec2 vSheet;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDrop = aDrop;\nvSheet = position.xy;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tProfile;\nuniform vec3 uProf;\nvarying vec4 vDrop;\nvarying vec2 vSheet;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        if (vDrop.x >= 0.0) {
          float edge = texture2D(tProfile, vec2((vSheet.x - vDrop.y - uProf.x) * uProf.y, (vDrop.x + 0.5) / uProf.z)).r;
          float s = 1.0 - smoothstep(-0.3, vDrop.z, vSheet.y - edge);
          diffuseColor.rgb *= 1.0 - 0.42 * s * s;
        }
        if (vDrop.w > 0.5) {
          vec2 q = vSheet * 1.25;
          vec2 c = floor(q);
          float h1 = fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
          float h2 = fract(sin(dot(c, vec2(39.3468, 11.135))) * 24634.6345);
          float d = length(fract(q) - 0.5 - (vec2(h1, h2) - 0.5) * 0.5);
          float fw = fwidth(q.x);
          float bloom = (1.0 - smoothstep(0.12 - fw, 0.12 + fw, d)) * step(0.6, h2) * (1.0 - smoothstep(0.12, 0.4, fw));
          vec3 petal = h1 < 0.4 ? vec3(1.0, 0.98, 0.9) : h1 < 0.7 ? vec3(1.0, 0.84, 0.3) : vec3(1.0, 0.62, 0.72);
          diffuseColor.rgb = mix(diffuseColor.rgb, petal, bloom);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'paper-sheet';
  return m;
}

/** A sheet's cut edge at x: its top, dropping away at either end (so no sheet ends in a cliff). */
const edgeAt = (sh: Sheet, x: number) => 0.4 + (sh.top(x) - 0.4) * smooth(0, 14, Math.min(x - sh.x0, sh.x1 - x));

/** A rainbow of six paper strips arching out of the mountains, each strip a little in front of the one outside it. */
function rainbow() {
  const bands = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa'].map(col);
  return bands.map((c, i) => {
    const r1 = 40 - i * 1.5,
      r0 = r1 - 1.5;
    const s = new THREE.Shape();
    s.absarc(0, 0, r1, 0, Math.PI, false);
    s.absarc(0, 0, r0, Math.PI, 0, true);
    return cutout(s, 0.15, c, CREAM, 48).translate(46, -4, -150 + i * 0.25);
  });
}

/** Raised cosine hills summed with a gentle wave: a sheet's top edge. */
function ridge(base: number, hills: [x: number, r: number, h: number][], wave = 0.6, phase = 0) {
  return (x: number) => {
    let h = base + Math.sin(x * 0.07 + phase) * wave + Math.sin(x * 0.19 + phase * 2.3) * wave * 0.4;
    for (const [c, r, a] of hills) {
      const d = Math.abs(x - c);
      if (d < r) h += a * (0.5 + 0.5 * Math.cos((d / r) * Math.PI));
    }
    return h;
  };
}

/** Pointed peaks (a mountain range): each peak a triangle with slightly bowed flanks. */
function peaks(base: number, list: [x: number, halfWidth: number, h: number][]) {
  return (x: number) => {
    let h = base;
    for (const [c, w, a] of list) {
      const d = Math.abs(x - c) / w;
      if (d < 1) h = Math.max(h, base + a * Math.pow(1 - d, 1.25));
    }
    return h;
  };
}

class PaperWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(new THREE.Color('#2b2530'));
      if (role === 'eyeWhite') return flat(new THREE.Color('#ffffff'));
      if (role === 'strings') return stringsMat(new THREE.Color('#f7f2e6'));
      if (role === 'cheek') return flat(new THREE.Color('#ff9aa8'));
      return P(c, 0.5);
    },
    outline: { color: new THREE.Color('#fffdf7'), width: 0.022 },
    flat: true,
    castShadow: true,
    shadowColor: new THREE.Color('#5a4630'),
    shadowOpacity: 0.18,
  };

  private sun!: THREE.Group;
  private plane!: THREE.Group;
  private pinwheel!: THREE.Object3D;
  private beam!: THREE.Object3D;
  /** a breeze mostly across the view: cut-outs lean left and right, not towards the camera */
  private wind = new Wind(1, 0.18, 1);
  private rng = new Rng(20260928);
  private foliage!: Foliage;
  private sheets: Sheet[] = [];
  private birds: Birds | null = null;
  private clouds!: THREE.InstancedMesh;
  private strings!: THREE.InstancedMesh;
  private boats!: THREE.InstancedMesh;
  /** instanced scenery the detail level thins (with full counts) */
  private optional: [THREE.InstancedMesh, number][] = [];

  protected build() {
    // a smash in paper: confetti flames, a crayon-scribble crater
    this.smashStyle = { ...FIRE_STYLE, fire: cs(['#ff7b3a', '#ffd166', '#ef476f', '#fffaf0']), fireShape: 'confetti', sparks: cs(['#ff7b3a', '#ffd166', '#ef476f', '#2a9d8f']), sparkShape: 'confetti', ring: new THREE.Color('#e76f51'), hot: new THREE.Color('#ff9f43'), scorch: new THREE.Color('#3b2f28'), scorchAlpha: 0.5, dust: cs(['#e8c58f', '#ffffff']), dustShape: 'confetti', flash: new THREE.Color('#fff3d6') };
    const s = this.scene;
    s.background = new THREE.Color('#bfe6f5');
    s.fog = new THREE.Fog('#d6eef5', 80, 330);
    const sun = new THREE.DirectionalLight('#fff6e4', 2.6);
    sun.position.set(-14, 26, 14);
    sun.castShadow = true;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.03;
    s.add(sun, sun.target);
    s.add(new THREE.HemisphereLight('#f5fbff', '#cbb58f', 1.6));

    this.buildSky();
    this.buildGround();

    // cardboard court slab (its top a hair under the court's surround, which it used to fight)
    const kraft = P('#d9b27c', 4);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(22, 0.3, 38), [kraft, kraft, kraft, kraft, kraft, kraft]);
    slab.position.y = -0.17;
    slab.receiveShadow = true;
    s.add(slab);
    this.buildCourt({
      inner: P('#7fcfc0', 3),
      outer: P('#f2dfb8', 3),
      line: flat('#fffdf5'),
      innerPad: { x: 1.1, z: 2 },
      outerSize: { x: 10.8, z: 18.8 },
      lineWidth: 0.09,
      wobble: 0.03,
      receiveShadow: true,
    });
    this.buildNet({
      post: P('#8b5a3c'),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#fffdf5'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 }),
      band: P('#ffffff'),
    });

    const ballMat = new THREE.MeshLambertMaterial({ color: '#ffe066', flatShading: true, map: paper() });
    this.buildBall(ballMat, { color: new THREE.Color('#ffffff'), color2: new THREE.Color('#ffe7a6'), width: 0.07, opacity: 0.85, length: 20 }, new THREE.Color('#5a4630'), 0.35);
    this.ball.geometry = new THREE.IcosahedronGeometry(0.085, 1);
    this.buildParticles();

    this.foliage = new Foliage(this.wind, {
      material: (p) => new THREE.MeshLambertMaterial({ vertexColors: p.vertexColors, map: paperMap(0.5) }),
      tree: TREE_SWAY,
    });
    this.buildSheets();
    this.buildSea();
    this.buildTrees();
    this.buildHanging();
    this.buildStands();
    this.buildPlane();

    this.bloom = new Bloom(4);
    this.bloom.threshold = 1.1;
    const f = this.final.u;
    f.uBloom.value = 0.18;
    f.uSat.value = 1.05;
    f.uContrast.value = 1.03;
    f.uGain.value.set(1.03, 1.0, 0.95);
    f.uVignette.value = 0.3;
    f.uGrain.value = 0.0;
    f.uPaper.value = 0.16;

    this.effects = {
      // cut-outs stand on the table: a soft dark footprint where each shoe meets the paper
      contact: { strength: 0.42, color: new THREE.Color('#6b5238') },
      // (no AO: 2–3 ms here for creases the sun's shadows and the sheets' own shading already draw)
      grade: { lut: paperGrade },
      // the court, the stands and the trees nearest them
      shadow: { light: sun, area: new THREE.Box3(new THREE.Vector3(-30, 0, -32), new THREE.Vector3(30, 8, 26)), softness: 0.12 },
      dof: true,
    };
  }

  /** A paper sky wrapped all round: deeper blue overhead, pale at the horizon. */
  private buildSky() {
    const g = new THREE.CylinderGeometry(300, 300, 260, 64, 6, true);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const c = new Float32Array(pos.count * 3);
    const lo = col('#dcf1f7'),
      hi = col('#8ccbeb'),
      k = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      k.copy(lo).lerp(hi, smooth(-40, 110, pos.getY(i)));
      c.set([k.r, k.g, k.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, map: paperMap(6), side: THREE.BackSide, fog: false }));
    sky.position.set(0, 80, 0);
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  /** The island: green paper on a cardboard slab, a sandy beach, and the sea round it. */
  private buildGround() {
    const s = this.scene;
    const outline = (grow: number) => {
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        // wider behind, where the hills stand
        const back = Math.sin(a) < 0;
        const rx = back ? 150 : 122,
          rz = back ? 94 : 98;
        const w = 1 + 0.05 * Math.sin(3 * a + 1) + 0.035 * Math.sin(7 * a + 2) + 0.018 * Math.sin(13 * a);
        // shape space (x, -z): the ground plane is the shape plane turned face up
        pts.push(new THREE.Vector2(Math.cos(a) * (rx * w + grow), -(-38 + Math.sin(a) * (rz * w + grow))));
      }
      return new THREE.Shape(pts);
    };
    const island = cutout(outline(0), 0.4, col('#9fd18b'), col('#c9a46a'), 4).rotateX(-Math.PI / 2).translate(0, -0.3, 0);
    const beach = finish(new THREE.ShapeGeometry(outline(6), 4), col('#f2dcaa')).rotateX(-Math.PI / 2).translate(0, -0.55, 0);
    const ground = new THREE.Mesh(join([island, beach]), new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.08) }));
    ground.receiveShadow = true;
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2).translate(0, -0.7, 0), P('#78c3e4', 60));
    s.add(ground, sea);
  }

  /**
   * The hills behind the far stand, sheet after sheet: green near, blue far,
   * snow on the last two. Each sheet's top edge goes into the profile texture
   * that shades the sheet behind; cottages and a pinwheel stand on the ridges.
   */
  private buildSheets() {
    const r = this.rng;
    const hills = (n: number, x0: number, x1: number, rr: [number, number], hh: [number, number]) => Array.from({ length: n }, () => [r.range(x0, x1), r.range(rr[0], rr[1]), r.range(hh[0], hh[1])] as [number, number, number]);
    const S = (z: number, half: number, color: string, top: (x: number) => number, snow?: number): Sheet => ({ z, x0: -half, x1: half, color, top, snow });
    this.sheets = [
      S(-30, 78, '#93d36b', ridge(3.4, hills(9, -70, 70, [7, 13], [1.2, 2.6]), 0.4, 0.3)),
      S(-40, 90, '#7cc65f', ridge(4.6, hills(8, -85, 85, [9, 16], [1.5, 3.6]), 0.5, 1.1)),
      S(-52, 106, '#62b35a', ridge(6.2, hills(8, -100, 100, [11, 20], [1.8, 4.2]), 0.6, 2.2)),
      S(-66, 124, '#54a35f', ridge(7.6, hills(8, -118, 118, [12, 24], [2.5, 5.4]), 0.7, 0.5)),
      S(-84, 146, '#4f9868', ridge(9.2, hills(8, -140, 140, [14, 28], [3, 7]), 0.8, 1.7)),
      S(-106, 150, '#6a9f86', ridge(11, hills(7, -165, 165, [18, 34], [3.5, 8]), 0.9, 2.9)),
      S(-132, 190, '#7f9fbd', peaks(12, Array.from({ length: 11 }, (_, i) => [-180 + i * 36 + r.range(-8, 8), r.range(20, 30), r.range(9, 15)] as [number, number, number])), 20.5),
      S(-162, 240, '#a3b9d4', peaks(15, Array.from({ length: 10 }, (_, i) => [-225 + i * 50 + r.range(-10, 10), r.range(26, 38), r.range(11, 18)] as [number, number, number])), 26),
    ];
    // the profile texture: every sheet's top edge across x (far below where a sheet ends)
    const rows = this.sheets.length;
    const data = new Uint16Array(PROF.n * rows);
    this.sheets.forEach((sh, row) => {
      for (let i = 0; i < PROF.n; i++) {
        const x = PROF.x0 + ((i + 0.5) / PROF.n) * (PROF.x1 - PROF.x0);
        data[row * PROF.n + i] = THREE.DataUtils.toHalfFloat(x < sh.x0 || x > sh.x1 ? -60 : edgeAt(sh, x));
      }
    });
    const tex = new THREE.DataTexture(data, PROF.n, rows, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    const parts: THREE.BufferGeometry[] = [];
    this.sheets.forEach((sh, i) => {
      // the outline: along the top edge, down the cut ends into the ground
      const n = Math.ceil((sh.x1 - sh.x0) / 1.5);
      const shape = new THREE.Shape();
      shape.moveTo(sh.x0, -1);
      for (let k = 0; k <= n; k++) {
        const x = sh.x0 + ((sh.x1 - sh.x0) * k) / n;
        shape.lineTo(x, edgeAt(sh, x));
      }
      shape.lineTo(sh.x1, -1);
      shape.lineTo(sh.x0, -1);
      const g = cutout(shape, 0.5, col(sh.color), CREAM, 1).translate(0, 0, sh.z);
      // shaded by the sheet in front: the further apart, the wider and softer
      const gap = i > 0 ? this.sheets[i - 1].z - sh.z : 0;
      parts.push(drop(g, i - 1, 0.25 + gap * 0.035, 0.9 + gap * 0.075, i < 2 ? 1 : 0));
      if (sh.snow !== undefined) parts.push(...this.snowCaps(sh, i));
    });
    parts.push(...this.cottages(), ...rainbow());
    const mesh = new THREE.Mesh(join(parts), sheetMaterial(tex, rows));
    this.scene.add(mesh);
    this.buildPinwheel();
  }

  /** White caps cut to each peak above the snow line, just in front of the mountain sheet. */
  private snowCaps(sh: Sheet, row: number) {
    const out: THREE.BufferGeometry[] = [];
    const line = sh.snow!;
    const step = 0.8;
    let x = sh.x0;
    while (x < sh.x1) {
      if (sh.top(x) <= line) {
        x += step;
        continue;
      }
      // one cap: along the peak's edge while it's above the line, back under it in a zigzag
      const top: [number, number][] = [];
      while (x < sh.x1 && sh.top(x) > line) {
        top.push([x, sh.top(x)]);
        x += step;
      }
      if (top.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(top[0][0], line);
      for (const [px, py] of top) shape.lineTo(px, py + 0.05);
      for (let k = top.length - 1; k >= 0; k--) {
        const [px, py] = top[k];
        const drip = (k % 3 === 1 ? 2.4 : 1.1) + (py - line) * 0.25;
        shape.lineTo(px, Math.max(line - 0.6, py - drip));
      }
      const g = cutout(shape, 0.12, col('#fbfdff'), CREAM, 1).translate(0, 0, sh.z + 0.06);
      out.push(drop(g, row - 1, 0.25, 1.4));
    }
    return out;
  }

  /** Paper cottages along the third and fifth ridges: walls, a roof, a door and windows. */
  private cottages() {
    const r = this.rng;
    const walls = ['#fff4e0', '#ffd9d9', '#e0f0ff', '#fff0b3', '#e8f7e0'].map(col);
    const roofs = ['#e76f51', '#6d8ed8', '#e9a23b', '#d95d7a'].map(col);
    const dark = col('#7a5236'),
      glass = col('#9fd3f0');
    const out: THREE.BufferGeometry[] = [];
    for (const [si, xs] of [
      [2, [-78, -62, -40, -22, 18, 34, 55, 74]],
      [4, [-104, -86, -58, 42, 70, 96, 118]],
    ] as [number, number[]][]) {
      const sh = this.sheets[si];
      for (const x0 of xs) {
        const x = x0 + r.range(-3, 3);
        const s = si === 2 ? r.range(1.1, 1.4) : r.range(1.3, 1.7);
        const w = 2.2 * s,
          h = 2 * s,
          d = 1.6 * s;
        const y = sh.top(x) - 0.5;
        const z = sh.z - d / 2 - 0.4;
        const body = block(w, h, d, r.pick(walls)).translate(x, y + h / 2, z);
        // a gable of folded card, overhanging a little
        const gable = new THREE.Shape();
        gable.moveTo(-w * 0.6, 0);
        gable.lineTo(w * 0.6, 0);
        gable.lineTo(0, h * 0.62);
        gable.lineTo(-w * 0.6, 0);
        const rc = r.pick(roofs);
        const roof = cutout(gable, d + 0.3, rc, rc, 1).translate(x, y + h, z + d / 2 + 0.15);
        const door = block(w * 0.24, h * 0.45, 0.04, dark).translate(x - w * 0.18, y + h * 0.225, z + d / 2 + 0.02);
        const win = block(w * 0.22, h * 0.22, 0.04, glass).translate(x + w * 0.2, y + h * 0.6, z + d / 2 + 0.02);
        out.push(body, roof, door, win);
      }
    }
    return out;
  }

  /** A paper pinwheel on the fourth ridge, turning in the wind. */
  private buildPinwheel() {
    const sh = this.sheets[3];
    const x = -34;
    const y = sh.top(x);
    const stick = new THREE.Mesh(block(0.22, 7, 0.22, col('#c89b62')), new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.5) }));
    stick.position.set(x, y + 2.5, sh.z - 0.5);
    this.scene.add(stick);
    const cols = ['#ff6b6b', '#ffd166', '#4ecdc4', '#6c8cff'].map(col);
    const blades: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      // a folded blade: a right triangle from the hub out, then turned into place
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.lineTo(3.2, 0);
      s.lineTo(3.2, 3.2);
      s.lineTo(0, 0);
      blades.push(cutout(s, 0.06, cols[k], CREAM, 1).rotateZ((k * Math.PI) / 2));
    }
    blades.push(block(0.5, 0.5, 0.3, col('#fffdf5')));
    this.pinwheel = new THREE.Mesh(join(blades), new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.5), side: THREE.DoubleSide }));
    this.pinwheel.position.set(x, y + 6.2, sh.z - 0.1);
    this.pinwheel.castShadow = false;
    this.scene.add(this.pinwheel);
  }

  /**
   * The sea: rows of paper waves sliding to and fro (one draw), boats bobbing
   * between them (one draw), islets with palms and a lighthouse sweeping its beam.
   */
  private buildSea() {
    const r = this.rng;
    const blues = ['#4f9fcb', '#5fb2dc', '#72bfe4', '#86cbea', '#9ad6ef'].map(col);
    // ---- the waves: long strips with a scalloped top; each row slides on its own phase
    const rows: THREE.BufferGeometry[] = [];
    const waveRow = (x0: number, x1: number, z: number, h: number, period: number, c: THREE.Color, ph: number, amp: number, turn = 0, at = new THREE.Vector3()) => {
      const s = new THREE.Shape();
      s.moveTo(x0, -1);
      const n = Math.ceil((x1 - x0) / (period / 6));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const u = (((x - x0) / period) % 1 + 1) % 1;
        s.lineTo(x, h + Math.pow(Math.sin(u * Math.PI), 0.6) * period * 0.22);
      }
      s.lineTo(x1, -1);
      s.lineTo(x0, -1);
      const g = cutout(s, 0.2, c, col('#ffffff'), 1).translate(0, -0.5, z).rotateY(turn).translate(at.x, at.y, at.z);
      // its phase, how far it slides, and which way its length runs
      const n2 = g.attributes.position.count;
      const a = new Float32Array(n2 * 4);
      for (let i = 0; i < n2; i++) a.set([ph, amp, Math.cos(turn), -Math.sin(turn)], i * 4);
      g.setAttribute('aWave', new THREE.BufferAttribute(a, 4));
      rows.push(g);
    };
    // in front of the island (the far camera's view) and round its sides
    for (let i = 0; i < 6; i++) {
      const z = 70 + i * 13 + i * i * 1.5;
      waveRow(-180, 180, z, 0.4 + i * 0.12, 5 + i * 0.8, blues[i % blues.length], r.range(0, 6.28), 1.2 + i * 0.25);
    }
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) waveRow(-60, 60, 0, 0.5 + i * 0.1, 6, blues[(i + 2) % blues.length], r.range(0, 6.28), 1.4, sx * (Math.PI / 2), new THREE.Vector3(sx * (168 + i * 15), 0, -20 + i * 8));
    const waveMat = motion(new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.16) }), 'paper-waves', { uTime: this.wind.u.uTime }, 'uniform float uTime;\nattribute vec4 aWave;', /* glsl */ `
      // to and fro along the row, each on its own phase, and a slow bob
      mvPosition.xz += aWave.zw * sin(uTime * 0.55 + aWave.x) * aWave.y;
      mvPosition.y += sin(uTime * 0.9 + aWave.x * 1.7) * 0.14;`);
    const waves = new THREE.Mesh(join(rows), waveMat);
    waves.userData.noBatch = true;
    this.scene.add(waves);
    // ---- boats between the rows: a hull, a mast, a sail
    const hull = new THREE.Shape();
    hull.moveTo(-1.6, 0.6);
    hull.lineTo(1.9, 0.6);
    hull.lineTo(1.2, -0.2);
    hull.lineTo(-1.2, -0.2);
    hull.lineTo(-1.6, 0.6);
    const sail = new THREE.Shape();
    sail.moveTo(0, 0.8);
    sail.lineTo(0, 3.6);
    sail.lineTo(1.7, 0.9);
    sail.lineTo(0, 0.8);
    const sail2 = new THREE.Shape();
    sail2.moveTo(-0.15, 1.0);
    sail2.lineTo(-0.15, 3.1);
    sail2.lineTo(-1.3, 1.1);
    sail2.lineTo(-0.15, 1.0);
    const boat = join([cutout(hull, 0.9, col('#e76f51'), CREAM, 1).translate(0, 0, 0.45), cutout(sail, 0.05, col('#fffdf5'), CREAM, 1), cutout(sail2, 0.05, col('#ffd166'), CREAM, 1), block(0.12, 3.2, 0.12, col('#8b5a3c')).translate(-0.05, 2.1, 0)]);
    const at = [
      [-52, 76],
      [30, 83],
      [-14, 99],
      [66, 108],
      [-80, 118],
      [12, 132],
    ];
    this.boats = new THREE.InstancedMesh(
      boat,
      motion(new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.5) }), 'paper-boat', { uTime: this.wind.u.uTime }, 'uniform float uTime;', /* glsl */ `
        // bob on the swell and rock about the keel
        float ph = fract(sin(dot(io.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
        float rock = sin(uTime * 1.2 + ph) * 0.09;
        vec3 d = mvPosition.xyz - io;
        mvPosition.xy = io.xy + vec2(d.x * cos(rock) - d.y * sin(rock), d.x * sin(rock) + d.y * cos(rock));
        mvPosition.y += sin(uTime * 0.9 + ph * 1.3) * 0.22 + 0.1;
        mvPosition.x += sin(uTime * 0.13 + ph) * 3.0;`),
      at.length,
    );
    const M = new THREE.Matrix4();
    at.forEach(([x, z], i) => this.boats.setMatrixAt(i, M.makeRotationY(r.range(-0.4, 0.4)).setPosition(x, -0.4, z)));
    this.boats.computeBoundingSphere();
    this.boats.boundingSphere!.radius += 5;
    this.scene.add(this.boats);
    // ---- islets: a sandy hump each, the lighthouse on the biggest
    const islets: THREE.BufferGeometry[] = [];
    for (const [x, z, w, h] of [
      [-46, 90, 16, 2.4],
      [44, 102, 22, 3.2],
      [-6, 126, 14, 2],
    ]) {
      const s = new THREE.Shape();
      s.moveTo(-w / 2, -1);
      for (let k = 0; k <= 16; k++) {
        const u = k / 16;
        s.lineTo(-w / 2 + u * w, -0.2 + h * Math.pow(Math.sin(u * Math.PI), 0.7));
      }
      s.lineTo(w / 2, -1);
      islets.push(cutout(s, 0.4, col('#f2dcaa'), CREAM, 1).translate(x, -0.5, z), cutout(s, 0.3, col('#9fd18b'), CREAM, 1).scale(0.7, 0.75, 1).translate(x, -0.3, z - 0.6));
    }
    // the lighthouse: a striped paper tube, its lamp room and cap
    const lx = 44,
      lz = 101.4,
      ly = 1.8;
    for (let k = 0; k < 5; k++) islets.push(finish(new THREE.CylinderGeometry(1.25 - k * 0.12, 1.36 - k * 0.12, 1.6, 16, 1, true), col(k % 2 ? '#fffdf5' : '#e2574c')).translate(lx, ly + 0.8 + k * 1.6, lz));
    islets.push(finish(new THREE.CylinderGeometry(0.85, 0.85, 1.1, 12), col('#ffe9a0')).translate(lx, ly + 8.55, lz), finish(new THREE.ConeGeometry(1.1, 1.3, 12), col('#e2574c')).translate(lx, ly + 9.75, lz));
    this.scene.add(new THREE.Mesh(join(islets), new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.25) })));
    // its beam: a pale paper wedge turning round the lamp
    const wedge = new THREE.Shape();
    wedge.moveTo(0, 0);
    wedge.lineTo(22, -1.6);
    wedge.lineTo(22, 1.6);
    wedge.lineTo(0, 0);
    const beam = new THREE.Mesh(new THREE.ShapeGeometry(wedge).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, fog: true }));
    beam.position.set(lx, ly + 8.55, lz);
    beam.renderOrder = 2;
    this.beam = beam;
    this.scene.add(beam);
  }

  /**
   * Paper cut-out trees on little stands (round, pointed, lollipop and palm),
   * rocking in the wind: along both sides of the stadium, on the ridges behind
   * and along the shore. One draw per shape, and one in the shadow pass.
   */
  private buildTrees() {
    const r = this.rng;
    const brown = col('#a0764a'),
      stand = col('#8b6038');
    const W = new THREE.Color(1, 1, 1);
    // a crown (tinted per tree: aLeaf 1 on its faces) on a trunk and a stand
    const tree = (crown: THREE.BufferGeometry, trunkH: number) => {
      const mask = (g: THREE.BufferGeometry, faces: boolean) => {
        const n = g.attributes.position.count;
        const c = g.attributes.color as THREE.BufferAttribute;
        const a = new Float32Array(n);
        // only the crown's white faces take the tree's colour; its cut edges stay cream
        for (let i = 0; i < n; i++) a[i] = faces && c.getX(i) > 0.99 && c.getY(i) > 0.99 ? 1 : 0;
        g.setAttribute('aLeaf', new THREE.BufferAttribute(a, 1));
        return g;
      };
      return join([mask(crown, true), mask(block(0.34, trunkH, 0.22, brown).translate(0, trunkH / 2, -0.12), false), mask(block(1.3, 0.2, 0.9, stand).translate(0, 0.1, -0.12), false)]);
    };
    const disc = new THREE.Shape();
    disc.absarc(0, 0, 1.7, 0, Math.PI * 2, false);
    const pointed = new THREE.Shape();
    pointed.moveTo(-1.9, 0);
    pointed.lineTo(-0.7, 1.4);
    pointed.lineTo(-1.35, 1.4);
    pointed.lineTo(0, 3.6);
    pointed.lineTo(1.35, 1.4);
    pointed.lineTo(0.7, 1.4);
    pointed.lineTo(1.9, 0);
    pointed.lineTo(-1.9, 0);
    const small = new THREE.Shape();
    small.absarc(0, 0, 1.1, 0, Math.PI * 2, false);
    // palm fronds: five leaves fanned from the top of a leaning trunk
    const fronds: THREE.Shape[] = [];
    for (let k = 0; k < 5; k++) {
      const a = Math.PI * (0.08 + (k / 4) * 0.84);
      const s = new THREE.Shape();
      const tx = Math.cos(a) * 2.6,
        ty = Math.sin(a) * 1.5 - 0.6;
      const nx = -Math.sin(a) * 0.45,
        ny = Math.cos(a) * 0.45;
      s.moveTo(0, 0);
      s.quadraticCurveTo(tx * 0.5 + nx, ty * 0.5 + 0.6 + ny, tx, ty);
      s.quadraticCurveTo(tx * 0.5 - nx, ty * 0.5 + 0.3 - ny, 0, 0);
      fronds.push(s);
    }
    const geos = {
      disc: tree(cutout(disc, 0.25, W, CREAM, 16).translate(0, 4.4, 0), 3.2),
      pointed: tree(cutout(pointed, 0.25, W, CREAM, 1).translate(0, 2.4, 0), 2.6),
      lolly: tree(cutout(small, 0.2, W, CREAM, 14).translate(0, 5.2, 0), 4.4),
      palm: tree(cutout(fronds, 0.12, W, CREAM, 6).translate(0.35, 5.4, 0), 5.4),
    };
    const greens = ['#5bb85d', '#89c95a', '#3f9e5a', '#6fc07a', '#4fae6e'].map(col);
    const autumn = ['#f2a65a', '#e76f8a', '#ffd166'].map(col);
    const sets = { disc: [] as Place[], pointed: [] as Place[], lolly: [] as Place[], palm: [] as Place[] };
    const far = { disc: [] as Place[], pointed: [] as Place[], lolly: [] as Place[], palm: [] as Place[] };
    // (standing on the island's paper, y = -0.3, and never through a sheet)
    const put = (into: typeof sets, kind: keyof typeof sets, x: number, z: number, s: number, y = -0.3) => {
      if (y === -0.3 && this.sheets.some((sh) => Math.abs(sh.z - z) < 2.2 && x > sh.x0 && x < sh.x1)) return;
      into[kind].push({ x, z, y, s: s * r.range(0.9, 1.1), sy: r.range(0.92, 1.1), yaw: r.range(-0.25, 0.25), color: kind === 'palm' ? r.pick(greens) : r.chance(0.2) ? r.pick(autumn) : r.pick(greens) });
    };
    // both sides of the stadium, in staggered rows
    for (const sx of [-1, 1])
      for (let row = 0; row < 4; row++)
        for (let i = 0; i < 9; i++) {
          const x = sx * (18.5 + row * 7 + r.range(-1.5, 1.5));
          const z = -54 + i * 11 + (row % 2) * 5 + r.range(-2, 2);
          if (z > 44) continue;
          put(sets, r.pick(['disc', 'disc', 'pointed', 'pointed', 'lolly'] as const), x, z, r.range(0.95, 1.3));
        }
    // on the ridges behind: small against the sky
    for (const [si, n, sc] of [
      [1, 10, 0.55],
      [3, 12, 0.7],
      [4, 12, 0.85],
      [5, 10, 1.0],
    ] as [number, number, number][]) {
      const sh = this.sheets[si];
      for (let i = 0; i < n; i++) {
        const x = r.range(sh.x0 + 12, sh.x1 - 12);
        if (Math.abs(x + 34) < 6 && si === 3) continue;
        put(far, r.pick(['disc', 'pointed', 'pointed'] as const), x, sh.z - 0.35, sc, sh.top(x) - 0.35);
      }
    }
    // palms along the shore in front, and on the islets
    for (let i = 0; i < 12; i++) {
      const a = r.range(0.2, Math.PI - 0.2);
      put(sets, 'palm', Math.cos(a) * 96, -28 + Math.sin(a) * 84, r.range(1, 1.25));
    }
    for (const [x, z] of [
      [-49, 89],
      [-43, 88.6],
      [38, 101],
      [-8, 125],
      [-3, 124.6],
    ])
      put(far, 'palm', x, z, 0.8, 0.8);
    const depth = swayDepth(this.wind, 'canopy', TREE_SWAY);
    for (const k of Object.keys(geos) as (keyof typeof geos)[]) {
      if (sets[k].length) this.foliage.add(geos[k], this.foliage.leaf, sets[k], { shadow: depth });
      if (far[k].length) this.optional.push([this.foliage.add(geos[k], this.foliage.leaf, far[k], { receive: false }), far[k].length]);
    }
    this.scene.add(this.foliage.group);
  }

  /**
   * Clouds and the sun hung on strings from above the page: the clouds swing
   * about their strings' tops (one instanced draw, and one for the strings),
   * the sun turns slowly.
   */
  private buildHanging() {
    const r = this.rng;
    const TOP = 92;
    const cloud = cutout(cloudShape(3), 0.5, new THREE.Color('#ffffff'), CREAM, 10);
    const swing = /* glsl */ `
      // a pendulum from the string's top, straight above the cloud
      vec3 pv = vec3(io.x, ${TOP.toFixed(1)}, io.z);
      float ph = fract(sin(dot(io.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
      float a = sin(uTime * 0.7 + ph) * 0.03 + sin(uTime * 1.7 + ph * 2.0) * 0.008;
      vec2 d = mvPosition.xy - pv.xy;
      mvPosition.xy = pv.xy + vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a));`;
    const u = { uTime: this.wind.u.uTime };
    const spots: [number, number, number, number][] = [];
    for (let i = 0; i < 10; i++) spots.push([-100 + i * 22 + r.range(-6, 6), r.range(26, 46), r.range(-62, -125), r.range(0.9, 1.5)]);
    // a few hung low among the hills, where the court's own camera sees them
    for (const [x, y, z] of [
      [-44, 14.5, -76],
      [12, 16, -96],
      [58, 13.5, -72],
    ])
      spots.push([x, y, z, r.range(0.7, 0.9)]);
    // a few over the sea in front, for the far end's view
    for (let i = 0; i < 4; i++) spots.push([-60 + i * 40 + r.range(-8, 8), r.range(28, 42), r.range(70, 110), r.range(0.9, 1.3)]);
    this.clouds = new THREE.InstancedMesh(cloud, motion(new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.4) }), 'paper-swing', u, 'uniform float uTime;', swing), spots.length);
    this.strings = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 1, 0.07).translate(0, 0.5, 0), motion(new THREE.MeshBasicMaterial({ color: '#8a7a66' }), 'paper-swing', u, 'uniform float uTime;', swing), spots.length);
    const M = new THREE.Matrix4();
    spots.forEach(([x, y, z, s], i) => {
      this.clouds.setMatrixAt(i, M.makeScale(s, s, 1).setPosition(x, y, z));
      // up from the cloud's top edge (0.75 of its radius, scaled) to the page above
      const y0 = y + 3 * 0.75 * s + 1.5 * s;
      this.strings.setMatrixAt(i, M.makeScale(1, TOP - y0, 1).setPosition(x, y0, z - 0.25));
    });
    for (const m of [this.clouds, this.strings]) {
      m.computeBoundingSphere();
      m.boundingSphere!.radius += 6;
      this.scene.add(m);
    }
    // the sun: disc, face and rays in one piece of card
    const yellow = col('#ffc93c'),
      pale = col('#ffe07a'),
      edge = col('#f2b035'),
      ink = col('#5a3a1a');
    const parts: THREE.BufferGeometry[] = [finish(new THREE.CylinderGeometry(7, 7, 0.6, 40).rotateX(Math.PI / 2), yellow), finish(new THREE.CylinderGeometry(5.2, 5.2, 0.62, 40).rotateX(Math.PI / 2).translate(0, 0, 0.05), pale)];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const shape = new THREE.Shape();
      shape.moveTo(-1.3, 0);
      shape.lineTo(1.3, 0);
      shape.lineTo(0, 4.2);
      shape.lineTo(-1.3, 0);
      parts.push(cutout(shape, 0.4, yellow, edge, 1).rotateZ(a - Math.PI / 2).translate(Math.cos(a) * 7.4, Math.sin(a) * 7.4, 0));
    }
    for (const x of [-1.8, 1.8]) parts.push(finish(new THREE.CircleGeometry(0.55, 16), ink).translate(x, 1, 0.4));
    parts.push(finish(new THREE.TorusGeometry(2, 0.22, 6, 20, Math.PI).rotateZ(Math.PI), ink).translate(0, -0.4, 0.4));
    this.sun = new THREE.Group();
    const face = new THREE.Mesh(join(parts), new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.4) }));
    face.castShadow = true;
    this.sun.add(face);
    this.sun.position.set(-55, 48, -120);
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 130 - 48 - 7, 4), new THREE.MeshBasicMaterial({ color: '#8a7a66' }));
    string.position.set(-55, (130 + 48 + 7) / 2, -120.3);
    this.scene.add(this.sun, string);
    this.buildKites();
    this.birds = new Birds(
      this.wind.u,
      [
        { x: 20, y: 30, z: -90, radius: 16, count: 7, speed: 0.14 },
        { x: -40, y: 24, z: 80, radius: 14, count: 5, speed: -0.17 },
      ],
      '#4a3a30',
    );
    this.scene.add(this.birds.mesh);
  }

  /**
   * Paper kites over the hills, flown from somewhere behind them: each tilts
   * and drifts on its string, its tail of bows waving more towards the end, and
   * the string's far end stays put (one draw: aKite holds each kite's anchor).
   */
  private buildKites() {
    const ink = col('#5a4a3a');
    const kite = (a: string, b: string, at: THREE.Vector3, phase: number) => {
      // a diamond in two colours, its cross sticks, a tail of little bows and the long string
      const half = (c: THREE.Color, sx: number) => {
        const s = new THREE.Shape();
        s.moveTo(0, 1.6);
        s.lineTo(sx * 1.1, 0.3);
        s.lineTo(0, -1.3);
        s.lineTo(0, 1.6);
        return cutout(s, 0.05, c, CREAM, 1);
      };
      const parts = [half(col(a), -1), half(col(b), 1), block(0.07, 2.9, 0.05, ink).translate(0, 0.15, 0.02), block(2.2, 0.07, 0.05, ink).translate(0, 0.3, 0.02)];
      for (let k = 0; k < 6; k++) {
        const y = -1.9 - k * 0.9;
        const bow = new THREE.Shape();
        bow.moveTo(-0.32, 0.18);
        bow.lineTo(0.32, -0.18);
        bow.lineTo(0.32, 0.18);
        bow.lineTo(-0.32, -0.18);
        bow.lineTo(-0.32, 0.18);
        parts.push(cutout(bow, 0.03, col(k % 2 ? a : b), CREAM, 1).translate(0, y, 0), block(0.03, 0.9, 0.03, ink).translate(0, y + 0.45, 0));
      }
      // the string: down and back, out of sight behind the hills
      const len = 40;
      parts.push(block(0.05, len, 0.05, ink).translate(0, -len / 2, 0).rotateX(-0.55).translate(0, -0.2, -0.3));
      const g = join(parts).translate(at.x, at.y, at.z);
      const n = g.attributes.position.count;
      const k4 = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) k4.set([at.x, at.y, at.z, phase], i * 4);
      g.setAttribute('aKite', new THREE.BufferAttribute(k4, 4));
      return g;
    };
    const mat = motion(new THREE.MeshLambertMaterial({ vertexColors: true, map: paperMap(0.5), side: THREE.DoubleSide }), 'paper-kite', { uTime: this.wind.u.uTime }, 'uniform float uTime;\nattribute vec4 aKite;', /* glsl */ `
      // round the kite's anchor: tilt about the bridle, the tail waving more towards
      // its end, the whole kite drifting and bobbing — less and less down the string
      vec3 d = mvPosition.xyz - aKite.xyz;
      float ph = aKite.w;
      float string = d.z < -0.25 ? clamp(1.0 + d.y / 30.0, 0.0, 1.0) : 1.0;
      float tail = d.z > -0.25 ? max(0.0, -d.y - 1.6) : 0.0;
      float tilt = sin(uTime * 0.8 + ph) * 0.14 * string;
      d.x += sin(uTime * 2.6 - tail * 1.1 + ph) * tail * 0.16;
      d.xy = vec2(d.x * cos(tilt) - d.y * sin(tilt), d.x * sin(tilt) + d.y * cos(tilt));
      d += vec3(sin(uTime * 0.37 + ph) * 2.0, sin(uTime * 0.61 + ph) * 1.0, 0.0) * string;
      mvPosition.xyz = aKite.xyz + d;`);
    const kites = new THREE.Mesh(
      join([kite('#ff6b6b', '#ffd166', new THREE.Vector3(-58, 30, -68), 0), kite('#4ecdc4', '#6c8cff', new THREE.Vector3(44, 36, -88), 2.1), kite('#b388eb', '#ffa94d', new THREE.Vector3(-8, 42, -118), 4.2)]),
      mat,
    );
    kites.userData.noBatch = true;
    this.scene.add(kites);
  }

  private buildStands() {
    const box = P('#caa06a', 3);
    const stands: Stand[] = [];
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.5 + r * 0.5;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), box);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        st.castShadow = true;
        st.receiveShadow = true;
        g.add(st);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.5, rowDepth: 0.9, y0: 0.5 });
    };
    mk(-11, 0, -Math.PI / 2, 22, 6);
    mk(11, 0, Math.PI / 2, 22, 6);
    mk(0, -19.5, Math.PI, 16, 6);
    const crowd = new Crowd({
      stands,
      density: 1,
      bodyMat: P('#ffffff', 0.3),
      headMat: P('#ffffff', 0.3),
      shirts: ['#e76f51', '#2a9d8f', '#e9c46a', '#f4a261', '#8ab6f9', '#f28fb0', '#b388eb'].map((c) => new THREE.Color(c)),
      skins: ['#ffe0c7', '#f1c9a5', '#c68e62', '#8d5a3b'].map((c) => new THREE.Color(c)),
      fill: 0.85,
      flatten: 0.18,
    });
    crowd.bodies.castShadow = true;
    crowd.heads.castShadow = true;
    this.addCrowd(crowd);
  }

  private buildPlane() {
    this.plane = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -1.4, -1.1, 0.1, 0.9, 0, -0.25, 0.9, 0, 0, -1.4, 0, -0.25, 0.9, 1.1, 0.1, 0.9], 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, P('#ffffff', 1, THREE.DoubleSide));
    m.castShadow = true;
    this.plane.add(m);
    this.plane.scale.setScalar(1.6);
    this.scene.add(this.plane);
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    this.wind.tick(t);
    this.sun.rotation.z = t * 0.08;
    this.sun.position.x = -55 + Math.sin(t * 0.5) * 0.4;
    const a = t * 0.18;
    this.plane.position.set(Math.cos(a) * 34, 16 + Math.sin(t * 0.9) * 2, -30 + Math.sin(a) * 22);
    this.plane.rotation.set(Math.sin(t * 0.9) * 0.15, -a + Math.PI, Math.sin(a) * 0.4);
    this.pinwheel.rotation.z = -t * 1.6;
    this.beam.rotation.y = t * 0.8;
  }

  protected onDetail(d: number) {
    const k = Math.min(1, 0.35 + 0.65 * d);
    for (const [m, n] of this.optional) m.count = Math.round(n * k);
    this.birds?.setDetail(d);
    this.boats.visible = d > 0.25;
  }

  protected fx(e: MatchEvent) {
    const Pp = this.particles;
    const cols = (a: string[]) => a.map((c) => new THREE.Color(c));
    if (e.type === 'hit') {
      Pp.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: e.perfect ? 16 : 7, speed: [2, 5], life: [0.4, 0.8], size: [0.1, 0.18], colors: cols(['#ffffff', '#ffe066', '#ffd1dc']), shape: 'confetti', gravity: 6, spin: 12, drag: 2.5 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      Pp.burst({ x: e.pos.x, y: 0.08, z: e.pos.z, count: 4, speed: [0.6, 1.6], dir: [0, 1, 0], spread: 0.9, life: [0.5, 0.9], size: [0.08, 0.14], colors: cols(['#e8c58f', '#ffffff']), shape: 'confetti', gravity: 5, spin: 10, ground: true });
    }
    if (e.type === 'point') {
      Pp.burst({ x: 0, y: 8, z: e.winner === 0 ? 6 : -6, count: 110, speed: [3, 8], dir: [0, 1, 0], spread: 0.9, life: [2.5, 4], size: [0.18, 0.3], colors: cols(['#e76f51', '#2a9d8f', '#e9c46a', '#f28fb0', '#8ab6f9', '#ffffff']), shape: 'confetti', gravity: 2.4, drag: 1.2, spin: 12, ground: true });
    }
  }
}

/** trees rock on their stands; the top of a 6 m cut-out moves this far in a gust */
const TREE_SWAY: SwayOpts = { amp: 0.16, height: 5.5, flutter: 0.006 };

/**
 * Paper's grade (a LUT): the look of a lit paper model on a table — blacks
 * lift to a warm grey (card can't be black), mid-tones warm a touch, colours
 * stay gentle, whites stay cream-white.
 */
function paperGrade([r, g, b]: [number, number, number]): [number, number, number] {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const lift = 0.035 * (1 - l);
  const warm = 0.02 * Math.sin(Math.PI * Math.min(1, l * 1.1));
  return [r + lift + warm, g + lift * 0.9 + warm * 0.4, b + lift * 0.7 - warm * 0.5];
}

export const PAPER: WorldDef = {
  id: 'paper',
  name: 'Paper Isles',
  tagline: 'Cut, fold, serve',
  blurb: 'A pop-up book world of cardboard, crayon and paper cut-out players.',
  ui: {
    accent: '#e76f51',
    accent2: '#2a9d8f',
    ink: '#3b2f28',
    paper: '#fffaf0',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Gaegu', 'Fredoka', cursive",
    panel: 'linear-gradient(160deg, rgba(255,251,240,0.98), rgba(250,240,220,0.96))',
  },
  song: 'paper',
  surface: 0.96,
  make: (r) => new PaperWorld(PAPER, r),
};

