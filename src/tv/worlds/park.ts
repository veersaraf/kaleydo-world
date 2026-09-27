// SPORTS PARK — the Switch Sports look: smooth, softly lit, no outlines. A coral
// hard court in a bright modern plaza, with a white-column pavilion, glass
// canopy and greenery behind the far baseline, gardens all round, the town
// beyond and hills on the horizon.
//
// The scenery lives: grass, trees, flowers and banners move in the wind, clouds
// drift, birds wheel over the town. All of it is animated in vertex shaders
// from a couple of uniforms (park-env/), so a frame costs no scenery JS beyond
// ticking a clock and trimming the grass per chunk.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { stringsMat, skyDome, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import type { MatchEvent } from '../tennis/match';
import { COURT } from '../tennis/court';
import { SKINS } from '../chars/look';
import { Rng } from '../core/math';
import { Wind, sway, swayDepth } from './park-env/wind';
import { Grass } from './park-env/grass';
import { Foliage, type Place, type TreeKind } from './park-env/foliage';
import { Clouds, hills, skyline } from './park-env/sky';
import { type Patch, patchSdf, patchGeometry, polygonGeometry, curbGeometry, pavingMaterial, lawnMaterial } from './park-env/ground';

const std = (color: THREE.ColorRepresentation, roughness = 0.8, o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...o });

// ---------------------------------------------------------------- layout
//
// World metres. The court and every venue that replaces it (bowling lanes, the
// duel pool) stay inside |x| < 12, |z| < 20; the side stands reach x = ±16, the
// pavilion stands at z = −21.5 and its canopy reaches z = −30. The tennis camera
// sits at z ≈ +22…27 looking down −z, so the entrance garden (+z) lies behind
// it: it frames the far views, the bowling reactions and the attract shots.

const LAWNS: Patch[] = [
  // behind the side stands
  { kind: 'rect', x: -24.5, z: 5, w: 11, d: 30, r: 3 },
  { kind: 'rect', x: 24.5, z: 5, w: 11, d: 30, r: 3 },
  // either side of the pavilion
  { kind: 'rect', x: -28, z: -22, w: 12, d: 13, r: 3 },
  { kind: 'rect', x: 28, z: -22, w: 12, d: 13, r: 3 },
  // behind the pavilion
  { kind: 'rect', x: 0, z: -38.5, w: 58, d: 12, r: 4 },
  // the entrance garden: four lawns round the fountain, long lawns either side
  { kind: 'rect', x: -11.5, z: 34, w: 12, d: 9, r: 2.5 },
  { kind: 'rect', x: 11.5, z: 34, w: 12, d: 9, r: 2.5 },
  { kind: 'rect', x: -11.5, z: 51, w: 12, d: 9, r: 2.5 },
  { kind: 'rect', x: 11.5, z: 51, w: 12, d: 9, r: 2.5 },
  { kind: 'rect', x: -28, z: 42.5, w: 12, d: 26, r: 3 },
  { kind: 'rect', x: 28, z: 42.5, w: 12, d: 26, r: 3 },
];

/** flower beds set into the lawns */
const BEDS: Patch[] = [
  { kind: 'disc', x: -11.5, z: 34, r: 2.3 },
  { kind: 'disc', x: 11.5, z: 34, r: 2.3 },
  { kind: 'disc', x: -11.5, z: 51, r: 2.3 },
  { kind: 'disc', x: 11.5, z: 51, r: 2.3 },
  { kind: 'rect', x: -28, z: -22, w: 5, d: 2.4, r: 1.1 },
  { kind: 'rect', x: 28, z: -22, w: 5, d: 2.4, r: 1.1 },
  { kind: 'rect', x: -24.5, z: 12, w: 2.4, d: 7, r: 1.1 },
  { kind: 'rect', x: 24.5, z: 12, w: 2.4, d: 7, r: 1.1 },
];

/** The paved plaza and the town's streets (world x, z, in order round): the rest is meadow. */
function plazaOutline(): [number, number][] {
  const X = 45,
    Z = 68,
    R = 10,
    zt = -10,
    town = 104;
  const pts: [number, number][] = [];
  const arc = (cx: number, cz: number, r: number, a0: number, a1: number, n: number) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  };
  // round the town through −z, then up the park's west side, across the entrance, down the east
  arc(0, zt, town, 0, -Math.PI, 64);
  pts.push([-X, zt]);
  arc(-X + R, Z - R, R, Math.PI, Math.PI / 2, 8);
  arc(X - R, Z - R, R, Math.PI / 2, 0, 8);
  pts.push([X, zt]);
  return pts;
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Grass density: full a metre inside a lawn's curb, none in the beds, never near the play area. */
function grassAt(x: number, z: number) {
  if (Math.abs(x) < 13 && Math.abs(z) < 21) return 0;
  for (const b of BEDS) if (patchSdf(b, x, z) < 0.35) return 0;
  let d = 0;
  for (const p of LAWNS) d = Math.max(d, smoothstep(0.3, 1.2, -patchSdf(p, x, z)));
  return d;
}

class ParkWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth' || role === 'eyeWhite') return new THREE.MeshBasicMaterial({ color: c });
      if (role === 'cheek') return new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.45 });
      if (role === 'strings') return stringsMat(c);
      if (role === 'gold') return std(c, 0.3, { metalness: 0.6 });
      const rough = role === 'skin' ? 0.62 : role === 'hair' ? 0.5 : role === 'racket' || role === 'grip' ? 0.35 : role === 'shoe' ? 0.55 : 0.78;
      return std(c, rough);
    },
    outline: null,
    castShadow: true,
    shadowColor: new THREE.Color('#2a2440'),
    shadowOpacity: 0.26,
  };

  /** one clock and one breeze for everything that moves in the wind */
  private wind = new Wind(0.85, -0.5, 1);
  /** scenery layout is seeded: the same park every time */
  private rng = new Rng(20260926);
  private foliage = new Foliage(this.wind);
  /** small plants gathered from every builder, made into one instanced draw each at the end */
  private plants = { bushes: [] as Place[], beds: [] as Place[], blooms: [] as Place[] };
  private grass: Grass | null = null;
  private clouds: Clouds | null = null;

  protected build() {
    const s = this.scene;
    s.fog = new THREE.Fog('#dcefff', 80, 360);
    s.add(
      skyDome(new THREE.Color('#3f94ee'), new THREE.Color('#e3f4ff'), {
        sunDir: new THREE.Vector3(-0.5, 0.6, -1),
        sunColor: new THREE.Color('#fff7e2'),
        sunSize: 0.01,
        ground: new THREE.Color('#c9c3bb'),
      }),
    );

    // light: a warm sun with soft shadows and a strong sky fill (Switch Sports' bright, gentle look)
    const sun = new THREE.DirectionalLight('#fff3df', 3.1);
    sun.position.set(-14, 30, -10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 3;
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -20;
    sc.right = 20;
    sc.top = 26;
    sc.bottom = -26;
    sc.near = 5;
    sc.far = 90;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    s.add(sun, sun.target);
    s.add(new THREE.HemisphereLight('#dcecff', '#c8b8a6', 1.35));

    this.buildGround();
    this.buildCourt({
      inner: std('#d6585c', 0.62, { map: this.courtTexture() }),
      outer: std('#3a3e4a', 0.85),
      line: std('#ffffff', 0.5),
      innerPad: { x: 0.9, z: 1.6 },
      outerSize: { x: 10.5, z: 18.5 },
      lineWidth: 0.075,
      receiveShadow: true,
    });
    this.buildNet({
      post: std('#2b2f3a', 0.45),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 }),
      band: std('#ffffff', 0.5),
    });
    this.buildSurroundText();

    // ball: a proper fuzzy tennis ball
    const ballMat = std('#ffffff', 0.9, { map: this.tennisBallTexture('#d9f23f', '#ffffff') });
    this.buildBall(ballMat, { color: new THREE.Color('#ffffff'), color2: new THREE.Color('#cfe8ff'), width: 0.075, opacity: 0.8 }, new THREE.Color('#1e1a30'), 0.55);
    this.buildParticles();

    this.buildPavilion();
    this.buildSides();
    this.buildTown();

    this.bloom = new Bloom(5);
    this.bloom.threshold = 1.0;
    this.bloom.knee = 0.5;
    const f = this.final.u;
    f.uTonemap.value = 1;
    f.uExposure.value = 1.0;
    f.uBloom.value = 0.16;
    f.uSat.value = 1.06;
    f.uContrast.value = 1.04;
    f.uGain.value.set(1.02, 1.0, 0.98);
    f.uVignette.value = 0.14;
    f.uGrain.value = 0.004;
  }

  /** Coral court with big, faint painted swirls (Spocco-style). */
  private courtTexture() {
    const t = canvasTex(1024, 2048, (x) => {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 1024, 2048);
      x.strokeStyle = 'rgba(255, 238, 232, 0.55)';
      x.lineCap = 'round';
      x.lineWidth = 46;
      for (const [cx, cy, r, a0, a1] of [
        [300, 700, 260, 0.2, 3.6],
        [720, 1350, 280, 3.4, 6.6],
        [520, 1020, 120, 0, 6.28],
      ] as [number, number, number, number, number][]) {
        x.beginPath();
        x.arc(cx, cy, r, a0, a1);
        x.stroke();
      }
      // a light speckle so it reads as a real surface
      for (let i = 0; i < 9000; i++) {
        x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '120,40,40'},${Math.random() * 0.06})`;
        x.fillRect(Math.random() * 1024, Math.random() * 2048, 2, 2);
      }
    });
    t.anisotropy = 8;
    return t;
  }

  /** "TENNIS" painted on the surround, like the Switch court. */
  private buildSurroundText() {
    const tex = canvasTex(1024, 256, (x) => {
      x.clearRect(0, 0, 1024, 256);
      x.font = '700 170px Fredoka, system-ui, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillStyle = 'rgba(255,255,255,0.32)';
      x.fillText('TENNIS', 512, 132);
    });
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: true });
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), mat);
      m.rotation.set(-Math.PI / 2, 0, sx * Math.PI / 2);
      m.position.set(sx * 8.4, 0.01, 0);
      m.renderOrder = 1;
      m.userData.noBatch = true;
      this.tennisOnly.push(m);
      this.scene.add(m);
    }
  }

  /** A bright paved plaza, lawns with stone curbs and flower beds, and grass on the lawns. */
  private buildGround() {
    const s = this.scene;
    // paving: large pale slabs in a running bond over the plaza and the town's
    // streets; a meadow all round it out to the hills
    const plaza = plazaOutline();
    const ground = new THREE.Mesh(polygonGeometry(plaza, [], -0.02), pavingMaterial({ tile: 6, base: '#ece7df', grout: '#d2cbc0', cols: 4, rows: 8 }));
    ground.receiveShadow = true;
    const rim = Array.from({ length: 96 }, (_, i) => [Math.cos((i / 96) * Math.PI * 2) * 320, Math.sin((i / 96) * Math.PI * 2) * 320] as [number, number]);
    const meadow = new THREE.Mesh(polygonGeometry(rim, [plaza], -0.02), lawnMaterial('#78ad62', { stripe: 0.025, tile: 18 }));
    meadow.receiveShadow = true;
    s.add(ground, meadow);

    const lawn = new THREE.Mesh(patchGeometry(LAWNS, 0.03), lawnMaterial('#58a04d'));
    lawn.receiveShadow = true;
    const soil = new THREE.Mesh(patchGeometry(BEDS, 0.06), std('#7a5a44', 1, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    soil.receiveShadow = true;
    const curb = new THREE.Mesh(curbGeometry([...LAWNS, ...BEDS], 0.22, 0.13), std('#f4f0e9', 0.7));
    curb.receiveShadow = true;
    curb.castShadow = true;
    s.add(lawn, soil, curb);

    // grass on the lawns: thick from a little inside the curb, never on the court or a venue
    this.grass = new Grass(this.wind, {
      density: grassAt,
      bounds: { x0: -36, x1: 36, z0: -46, z1: 58 },
      perM2: 9,
      colors: ['#62b058', '#5aa851', '#6cb65c', '#529c4b'].map((c) => new THREE.Color(c)),
      chunk: 18,
      height: [0.22, 0.4],
      fade: [30, 88],
      seed: 5,
    });
    s.add(this.grass.group);
  }

  /** White columns under a glass canopy with hanging greenery and sport banners. */
  private buildPavilion() {
    const s = this.scene;
    const r = this.rng;
    const white = std('#ebe7e1', 0.55);
    const steel = std('#c9ced8', 0.35, { metalness: 0.3 });
    const stone = std('#f6f3ee', 0.6);
    const soil = std('#6f5140', 1);
    const leaf = ['#4fa85a', '#5fb865', '#43994f', '#6cbf6a'].map((c) => new THREE.Color(c));
    const flower = ['#ff6f91', '#ffd166', '#ffffff', '#ff8a5b', '#b98cff'].map((c) => new THREE.Color(c));
    const { bushes, blooms } = this.plants;
    const trails: Place[] = [];
    const z = -21.5;
    const cols = 9;
    const span = 36;
    const colGeo = new THREE.CylinderGeometry(0.42, 0.48, 9.5, 20);
    for (let i = 0; i < cols; i++) {
      const x = -span / 2 + (i / (cols - 1)) * span;
      const c = new THREE.Mesh(colGeo, white);
      c.position.set(x, 4.75, z);
      c.castShadow = true;
      c.receiveShadow = true;
      s.add(c);
      // planters at the foot of the columns: a stone lip, soil, a heaped bush with
      // flowers in it and a few strands trailing over the rim
      const pz = z + 1.4;
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.75, 0.9, 20), white);
      pot.position.set(x, 0.45, pz);
      pot.castShadow = true;
      pot.receiveShadow = true;
      const lip = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.07, 8, 28).rotateX(Math.PI / 2), stone);
      lip.position.set(x, 0.9, pz);
      const top = new THREE.Mesh(new THREE.CircleGeometry(0.84, 20).rotateX(-Math.PI / 2), soil);
      top.position.set(x, 0.86, pz);
      s.add(pot, lip, top);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + r.range(0, 1);
        bushes.push({ x: x + Math.cos(a) * 0.32, z: pz + Math.sin(a) * 0.32, y: 0.84, s: r.range(0.95, 1.2), sy: r.range(0.95, 1.2), yaw: r.range(0, 6.3), color: r.pick(leaf) });
      }
      for (let k = 0; k < 14; k++) {
        const a = r.range(0, Math.PI * 2),
          d = r.range(0.1, 0.7);
        blooms.push({ x: x + Math.cos(a) * d, z: pz + Math.sin(a) * d, y: 0.84, s: r.range(0.9, 1.2), sy: 1.6 + (0.7 - d) * 1.4 + r.range(0, 0.3), color: r.pick(flower) });
      }
      for (let k = 0; k < 3; k++) {
        const a = r.range(0.2, Math.PI - 0.2);
        trails.push({ x: x + Math.cos(a) * 0.86, z: pz + Math.sin(a) * 0.86, y: 0.95, s: r.range(0.8, 1.1), yaw: r.range(0, 6.3), color: r.pick(leaf) });
      }
    }
    this.foliage.vines(trails, 0.8, 29);
    // beam and glass canopy
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 3, 0.7, 1.2), white);
    beam.position.set(0, 9.6, z);
    beam.castShadow = true;
    s.add(beam);
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(span + 3, 0.12, 9),
      new THREE.MeshStandardMaterial({ color: '#bfe6ff', roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    glass.position.set(0, 10.05, z - 3.6);
    s.add(glass);
    for (const x of [-span / 2 - 1, span / 2 + 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 9), steel);
      rail.position.set(x, 10.05, z - 3.6);
      s.add(rail);
    }
    // vines hanging from the beam in bunches round the columns (the banners stay
    // clear), swinging most at their tips
    const vines: Place[] = [];
    for (let i = 0; i < cols; i++) {
      const cx = -span / 2 + (i / (cols - 1)) * span;
      for (let k = 0; k < 3; k++) vines.push({ x: cx + (k - 1) * 0.55 + r.range(-0.15, 0.15), z: z + 0.58, y: 9.28, s: r.range(0.45, 1.05), yaw: r.range(0, 6.3), color: r.pick(leaf) });
    }
    this.foliage.vines(vines, 2.6, 13);
    // tall sport banners between the columns, hung from rods, rippling in the wind
    // (one instanced cloth: the eight designs share an atlas)
    const icons = ['🎾', '🏸', '🎳', '⚽', '🏐', '🏀', '⚔️', '⛳'];
    const colors = ['#ff6b6b', '#3aa8ff', '#ffc53d', '#35d49a', '#b07cff', '#ff8a3d', '#ff5aa0', '#4fd1c5'];
    const n = cols - 1;
    const atlas = canvasTex(256 * n, 512, (c) => {
      for (let i = 0; i < n; i++) {
        const ox = i * 256;
        const g = c.createLinearGradient(0, 0, 0, 512);
        const k = new THREE.Color(colors[i % colors.length]);
        g.addColorStop(0, `#${k.clone().offsetHSL(0, 0, 0.04).getHexString()}`);
        g.addColorStop(1, `#${k.clone().offsetHSL(0, 0, -0.05).getHexString()}`);
        c.fillStyle = g;
        c.fillRect(ox, 0, 256, 512);
        // a white hem and a thin inner line: reads as sewn fabric
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.fillRect(ox, 470, 256, 42);
        c.fillStyle = 'rgba(255,255,255,0.35)';
        c.fillRect(ox + 14, 14, 228, 4);
        c.fillRect(ox + 14, 450, 228, 4);
        c.fillStyle = 'rgba(255,255,255,0.2)';
        c.beginPath();
        c.arc(ox + 128, 220, 96, 0, Math.PI * 2);
        c.fill();
        c.font = '150px system-ui, "Apple Color Emoji", sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(icons[i % icons.length], ox + 128, 226);
      }
    });
    const clothOpts = { amp: 0.14, height: 1, flutter: 0.03 };
    const bannerMat = sway(new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.9, side: THREE.DoubleSide }), this.wind, 'cloth', clothOpts, {
      key: `atlas${n}`,
      patch: (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCell;').replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv.x = (vMapUv.x + aCell) / ${n.toFixed(1)};`);
      },
    });
    const bannerGeo = new THREE.PlaneGeometry(2.1, 4.2, 5, 12);
    bannerGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: n }, (_, i) => i)), 1));
    const banners = new THREE.InstancedMesh(bannerGeo, bannerMat, n);
    const rod = std('#d9dde6', 0.35, { metalness: 0.4 });
    const M = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const x = -span / 2 + ((i + 0.5) / n) * span;
      banners.setMatrixAt(i, M.makeTranslation(x, 6.4, z + 0.2));
      // the rod it hangs from, and two cables up to the beam
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8).rotateZ(Math.PI / 2), rod);
      bar.position.set(x, 8.55, z + 0.2);
      s.add(bar);
      for (const dx of [-0.95, 0.95]) {
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 4), rod);
        cable.position.set(x + dx, 8.9, z + 0.2);
        s.add(cable);
      }
    }
    banners.castShadow = true;
    banners.customDepthMaterial = swayDepth(this.wind, 'cloth', clothOpts);
    banners.computeBoundingSphere();
    s.add(banners);
    // a low glass wall between the court and the pavilion
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(24, 1.1, 0.08),
      new THREE.MeshStandardMaterial({ color: '#d7efff', roughness: 0.05, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    wall.position.set(0, 0.55, -15.2);
    s.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(24, 0.08, 0.14), steel);
    cap.position.set(0, 1.12, -15.2);
    s.add(cap);
  }

  /** Planters, benches, lamps and a sparse, friendly crowd along the sides. */
  private buildSides() {
    const s = this.scene;
    const r = this.rng;
    const concrete = std('#efe9e1', 0.8);
    const wood = std('#c48a58', 0.7);
    const stone = std('#f7f4ef', 0.6);
    const soil = std('#6f5140', 1);
    const leaf = ['#4fa85a', '#5fb865', '#43994f', '#6cbf6a'].map((c) => new THREE.Color(c));
    const flower = ['#ff6f91', '#ffd166', '#ffffff', '#ff8a5b', '#b98cff'].map((c) => new THREE.Color(c));
    const stands: Stand[] = [];
    for (const sx of [-1, 1]) {
      // long planter: a pale stone cap over the concrete, soil, a row of clipped
      // bushes with flowers tucked in (no grass this close to the play area)
      const px = sx * 11.6;
      const pl = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 26), concrete);
      pl.position.set(px, 0.35, 0);
      pl.castShadow = true;
      pl.receiveShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.07, 26.16), stone);
      cap.position.set(px, 0.735, 0);
      cap.receiveShadow = true;
      const top = new THREE.Mesh(new THREE.PlaneGeometry(1.26, 25.86).rotateX(-Math.PI / 2), soil);
      top.position.set(px, 0.745, 0);
      s.add(pl, cap, top);
      for (let i = 0; i < 28; i++) {
        const z = -12.45 + i * 0.922 + r.range(-0.12, 0.12);
        this.plants.bushes.push({ x: px + r.range(-0.12, 0.12), z, y: 0.72, s: r.range(0.95, 1.2), sy: r.range(0.9, 1.1), yaw: r.range(0, 6.3), color: r.pick(leaf) });
        for (let k = 0; k < 2; k++)
          if (r.chance(0.7)) this.plants.blooms.push({ x: px + r.range(-0.45, 0.45), z: z + r.range(-0.4, 0.4), y: 0.72, s: r.range(0.9, 1.2), sy: r.range(1.5, 2.1), color: r.pick(flower) });
      }
      // tiered seating behind the planter: a few rows of friendly spectators
      const g = new THREE.Group();
      for (let r = 0; r < 3; r++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(22, 0.5 + r * 0.5, 0.95), r % 2 ? wood : concrete);
        step.position.set(0, (0.5 + r * 0.5) / 2, r * 0.95 + 0.48);
        step.receiveShadow = true;
        step.castShadow = true;
        g.add(step);
      }
      g.position.set(sx * 13, 0, 0);
      g.rotation.y = sx < 0 ? -Math.PI / 2 : Math.PI / 2;
      s.add(g);
      stands.push({ x: sx * 13, z: 0, facing: sx < 0 ? -Math.PI / 2 : Math.PI / 2, width: 21, rows: 3, rowRise: 0.5, rowDepth: 0.95, y0: 0.5 });
      // light poles: slim, pale and modern, an arm reaching over the court to a
      // flat LED head (its lens faintly lit: it's daytime)
      for (const z of [-14, 0, 14]) this.lightPole(sx * 10.6, z, -sx);
    }
    // far end: a short stand behind the glass wall
    const g = new THREE.Group();
    for (let r = 0; r < 3; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(18, 0.5 + r * 0.5, 0.95), r % 2 ? wood : concrete);
      step.position.set(0, (0.5 + r * 0.5) / 2, r * 0.95 + 0.48);
      step.receiveShadow = true;
      g.add(step);
    }
    g.position.set(0, 0, -16);
    g.rotation.y = Math.PI;
    s.add(g);
    stands.push({ x: 0, z: -16, facing: Math.PI, width: 17, rows: 3, rowRise: 0.5, rowDepth: 0.95, y0: 0.5 });

    const shirts = ['#ff6b6b', '#3aa8ff', '#ffc53d', '#35d49a', '#b07cff', '#ff8a3d', '#ffffff', '#ff5aa0', '#2b2f3a'].map((c) => new THREE.Color(c));
    this.addCrowd(
      new Crowd({
        stands,
        density: 0.8,
        bodyMat: std('#ffffff', 0.8),
        headMat: std('#ffffff', 0.62),
        shirts,
        skins: SKINS.map((c) => new THREE.Color(c)),
        fill: 0.62,
      }),
    );
  }

  private poleMats: { pole: THREE.Material; dark: THREE.Material; lens: THREE.Material } | null = null;

  /** A slim light pole at (x, z) whose arm reaches towards `dir` (±1 along x). */
  private lightPole(x: number, z: number, dir: number, h = 7.2) {
    const m = (this.poleMats ??= {
      pole: std('#e3e7ee', 0.4, { metalness: 0.35 }),
      dark: std('#3a404d', 0.5, { metalness: 0.2 }),
      lens: new THREE.MeshStandardMaterial({ color: '#fff8ea', emissive: new THREE.Color('#fff4de'), emissiveIntensity: 0.55, roughness: 0.3 }),
    });
    const s = this.scene;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.35, 12), m.dark);
    base.position.set(x, 0.175, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.1, h, 10), m.pole);
    pole.position.set(x, h / 2, z);
    pole.castShadow = true;
    // the arm: a short rise, then out over the court
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.95, 8).rotateZ(Math.PI / 2), m.pole);
    arm.position.set(x + dir * 0.45, h - 0.05, z);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.1, 0.38), m.dark);
    head.position.set(x + dir * 0.95, h - 0.09, z);
    head.castShadow = true;
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.28).rotateX(Math.PI / 2), m.lens);
    lens.position.set(x + dir * 0.95, h - 0.145, z);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 6), m.pole);
    cap.position.set(x, h, z);
    s.add(base, pole, arm, head, lens, cap);
  }

  /** The town beyond: soft modern blocks, trees and a few clouds. */
  private buildTown() {
    const s = this.scene;
    const facade = ['#e7ded2', '#cfdcea', '#ecd6c4', '#d6e6d8'];
    const windowTex = canvasTex(256, 256, (x) => {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 256, 256);
      x.fillStyle = 'rgba(80,120,170,0.35)';
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) x.fillRect(12 + i * 62, 14 + j * 62, 40, 40);
    });
    windowTex.wrapS = windowTex.wrapT = THREE.RepeatWrapping;
    const rng = (a: number, b: number) => a + Math.random() * (b - a);
    for (let i = 0; i < 26; i++) {
      const w = rng(10, 22),
        hgt = rng(14, 42),
        d = rng(10, 20);
      const tex = windowTex.clone();
      tex.needsUpdate = true;
      tex.repeat.set(w / 5, hgt / 5);
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), std(facade[i % facade.length], 0.85, { map: tex }));
      const ang = -Math.PI * 0.95 + (i / 25) * Math.PI * 0.9;
      const r = rng(62, 95);
      b.position.set(Math.cos(ang) * r, hgt / 2, Math.sin(ang) * r - 10);
      b.rotation.y = -ang + Math.PI / 2;
      s.add(b);
    }
    this.buildGardens();
    this.buildHorizon();
  }

  /** Trees, bushes and flowers round the plaza (all instanced, all in the wind). */
  private buildGardens() {
    const r = this.rng;
    const leaf = ['#4fae5b', '#62bd68', '#43a052', '#7cc45c', '#56b27c'].map((c) => new THREE.Color(c));
    const blossom = [new THREE.Color('#f7b3c9'), new THREE.Color('#fbd3de')];
    const trees: Record<TreeKind, Place[]> = { round: [], tall: [], wide: [] };
    const tree = (kind: TreeKind, x: number, z: number, s = 1, color?: THREE.Color) =>
      trees[kind].push({ x, z, s: s * r.range(0.9, 1.1), sy: r.range(0.92, 1.1), yaw: r.range(0, Math.PI * 2), color: color ?? r.pick(leaf) });
    // behind the pavilion: seen between its columns from the court
    for (let i = 0; i < 9; i++) tree(i % 2 ? 'tall' : 'round', -26 + i * 6.5, -34.5 + r.range(-0.6, 0.6), i % 2 ? 1.05 : 1.15);
    for (let i = 0; i < 8; i++) tree(i % 3 === 1 ? 'wide' : 'round', -22.75 + i * 6.5, -42 + r.range(-0.8, 0.8), 1.2, i === 2 || i === 5 ? r.pick(blossom) : undefined);
    // either side of the pavilion
    for (const sx of [-1, 1]) {
      tree('round', sx * 23.5, -16.5, 1.05);
      tree('tall', sx * 33, -16, 1.1);
      tree('wide', sx * 24, -28, 1.1);
      tree('round', sx * 32.5, -28.5, 1.15, sx < 0 ? blossom[0] : undefined);
      // an avenue behind the side stands
      for (let i = 0; i < 5; i++) tree('round', sx * 20.6, -7 + i * 6.3, 0.95);
      for (const z of [-4, 7, 18]) tree('tall', sx * 29.5, z + r.range(-1, 1), 1.1);
      // the entrance garden
      tree('round', sx * 19, 30, 1.1);
      tree('round', sx * 19, 55, 1.1);
      tree('wide', sx * 36.5, 31, 1.25);
      tree('wide', sx * 36.5, 54, 1.25);
      tree('tall', sx * 22.5, 42.5, 1.15);
      tree('round', sx * 4.5, 62, 1.2, r.pick(blossom));
    }
    // further out, a loose ring of trees over the meadow line
    for (let i = 0; i < 26; i++) {
      const a = r.range(0.05, 0.95) * Math.PI;
      const d = r.range(62, 80);
      const x = Math.cos(a) * d,
        z = Math.sin(a) * d + 8;
      tree(r.pick(['round', 'round', 'wide', 'tall'] as TreeKind[]), x, z, r.range(1.1, 1.5));
    }
    this.foliage.trees('round', trees.round, 11);
    this.foliage.trees('tall', trees.tall, 23);
    this.foliage.trees('wide', trees.wide, 37);

    // flower beds: a ring of bushes with blossoms heaped in the middle
    const bush = ['#4fa85a', '#5fb865', '#43994f'].map((c) => new THREE.Color(c));
    const flower = ['#ff6f91', '#ffd166', '#ffffff', '#ff8a5b', '#b98cff', '#ff4d6d'].map((c) => new THREE.Color(c));
    const { beds: bushes, blooms } = this.plants;
    for (const b of BEDS) {
      const area = b.kind === 'disc' ? Math.PI * b.r * b.r : b.kind === 'rect' ? b.w * b.d : 0;
      const n = Math.round(area * 14);
      const bx0 = b.kind === 'rect' ? b.x - b.w / 2 : b.x - (b.kind === 'disc' ? b.r : 0);
      const bz0 = b.kind === 'rect' ? b.z - b.d / 2 : b.z - (b.kind === 'disc' ? b.r : 0);
      const bw = b.kind === 'rect' ? b.w : b.kind === 'disc' ? 2 * b.r : 0;
      const bd = b.kind === 'rect' ? b.d : b.kind === 'disc' ? 2 * b.r : 0;
      for (let i = 0; i < n * 3 && blooms.length < 4000; i++) {
        const x = bx0 + r.next() * bw,
          z = bz0 + r.next() * bd;
        const e = -patchSdf(b, x, z);
        if (e < 0.15) continue;
        // bushes round the edge, flowers heaped towards the middle
        if (e < 0.6 && r.chance(0.12)) bushes.push({ x, z, y: 0.06, s: r.range(0.55, 0.75), sy: r.range(0.7, 0.9), yaw: r.range(0, 6.3), color: r.pick(bush) });
        else if (r.chance(0.5)) blooms.push({ x, z, y: 0.06, s: r.range(0.9, 1.25), sy: 0.6 + Math.min(1, e) * 0.5 + r.range(0, 0.2), yaw: r.range(0, 6.3), color: r.pick(flower) });
      }
    }
    // every small plant in three draws: bushes that shade their planters, low bed
    // bushes (no shadow worth a pass), and all the blossoms
    this.foliage.bushes(this.plants.bushes, 17, { seg: 9 });
    this.foliage.bushes(this.plants.beds, 5, { shadow: false });
    this.foliage.flowers(this.plants.blooms);
    this.scene.add(this.foliage.group);
  }

  /** Clouds, hills and a hazy skyline closing off the horizon. */
  private buildHorizon() {
    const s = this.scene;
    s.add(
      hills([
        { radius: 205, height: [10, 26], foot: new THREE.Color('#7fb886'), crest: new THREE.Color('#579f70'), seed: 4, bumps: 16 },
        { radius: 290, height: [20, 38], foot: new THREE.Color('#a3c6dc'), crest: new THREE.Color('#779fc6'), seed: 9, bumps: 12 },
      ]),
    );
    s.add(skyline({ from: -Math.PI * 0.98, to: -Math.PI * 0.02, radius: [130, 190], count: 46, width: [10, 22], height: [22, 70], color: new THREE.Color('#9db3cd'), sunDir: new THREE.Vector3(-0.5, 0.6, -1), seed: 3 }));
    this.clouds = new Clouds({ count: 44, radius: [170, 310], height: [12, 118], size: [60, 130], speed: 1.4, haze: new THREE.Color('#e3f4ff'), seed: 8 });
    s.add(this.clouds.mesh);
  }

  protected animate(v: FrameView) {
    this.wind.tick(v.realT);
    this.clouds?.tick(v.realT);
    this.grass?.update(v.cam);
  }

  protected onDetail(d: number) {
    this.grass?.setDetail(d);
    this.clouds?.setDetail(d);
    this.foliage.setDetail(d);
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: big ? 18 : 8, speed: [2, big ? 6.5 : 4], life: [0.22, 0.5], size: [0.07, big ? 0.24 : 0.15], shrink: 0.2, colors: e.perfect ? [new THREE.Color('#fff27a'), new THREE.Color('#ffffff'), new THREE.Color('#ffb13d')] : [new THREE.Color('#ffffff')], shape: 'star', drag: 3 });
      if (e.perfect) P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: 1, speed: [0, 0], life: [0.32, 0.32], size: [0.28, 0.28], shrink: 6, colors: [new THREE.Color('#ffffff')], shape: 'ring', alpha: 0.75 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 5, speed: [0.5, 1.3], dir: [0, 1, 0], spread: 0.9, life: [0.3, 0.55], size: [0.1, 0.22], shrink: 1.8, colors: [new THREE.Color('#fff1ec')], shape: 'soft', alpha: 0.45, drag: 4 });
    }
    if (e.type === 'point') {
      P.burst({ x: 0, y: 8, z: e.winner === 0 ? 6 : -6, count: 80, speed: [3, 8], dir: [0, 1, 0], spread: 0.8, life: [2, 3.4], size: [0.13, 0.22], colors: ['#ff6b6b', '#ffc53d', '#3aa8ff', '#35d49a', '#ffffff', '#b07cff'].map((c) => new THREE.Color(c)), shape: 'confetti', gravity: 3, drag: 1.2, spin: 10, ground: true });
    }
  }
}

export const PARK: WorldDef = {
  id: 'park',
  name: 'Sports Park',
  tagline: 'The whole town comes to play',
  blurb: 'A bright plaza court, soft sunshine and a friendly crowd.',
  ui: {
    accent: '#ff6b6b',
    accent2: '#3aa8ff',
    ink: '#1d1c33',
    paper: '#ffffff',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Fredoka', system-ui, sans-serif",
    panel: 'linear-gradient(160deg, rgba(255,255,255,0.97), rgba(244,240,236,0.95))',
  },
  song: 'plaza',
  surface: 1,
  make: (r) => new ParkWorld(PARK, r),
};

export { COURT };
