// The KALEYDO WORLD hero globe: a chunky toy planet whose islands are distinct
// little biomes (meadow, blossom, autumn, snow, desert, mountains) in one
// cohesive style, with puffy clouds, a toy plane and a tennis-ball moon. It
// never runs in the game: scripts/render-globe.mjs renders it to stills.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- noise + rng

function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(x - xi), v = s(y - yi), w = s(z - zi);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v), L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm(p: THREE.Vector3, f: number, oct = 3) {
  let a = 0, amp = 0.5, fr = f;
  for (let i = 0; i < oct; i++) {
    a += amp * vnoise(p.x * fr + 11.3 * i, p.y * fr + 7.1 * i, p.z * fr + 3.7 * i);
    fr *= 2.03;
    amp *= 0.5;
  }
  return a;
}
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const col = (h: string) => new THREE.Color(h);

/** direction from latitude/longitude in degrees (lon 0 faces the camera, +lat is up) */
function dir(lat: number, lon: number) {
  const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
}

// ---------------------------------------------------------------- biomes

type Flora = 'round' | 'pine' | 'blossom' | 'autumn' | 'snowpine' | 'palm' | 'cactus' | 'peak' | 'flower' | 'boulder';

interface Biome {
  top: THREE.Color[];
  wall: THREE.Color;
  beach: THREE.Color;
  /** flora mix: [kind, weight] */
  flora: [Flora, number][];
  density: number;
}

const BIOMES: Record<string, Biome> = {
  meadow: { top: [col('#86cf3c'), col('#6cbd30')], wall: col('#3f9a2a'), beach: col('#f4cf86'), flora: [['round', 4], ['pine', 1], ['flower', 0.8]], density: 1.3 },
  autumn: { top: [col('#b9cf48'), col('#a3c23c')], wall: col('#6f9a2c'), beach: col('#f2c77e'), flora: [['autumn', 5], ['pine', 1]], density: 1.0 },
  snow: { top: [col('#f7fbff'), col('#e6f0ff')], wall: col('#b9cdee'), beach: col('#dfe9f7'), flora: [['snowpine', 1]], density: 0.45 },
  desert: { top: [col('#f6cd7c'), col('#eebd68')], wall: col('#e0994f'), beach: col('#fbe0a6'), flora: [['palm', 3], ['cactus', 2], ['boulder', 1]], density: 0.7 },
  forest: { top: [col('#7dc24a'), col('#69b23e')], wall: col('#44913a'), beach: col('#f0c57c'), flora: [['pine', 4], ['round', 1]], density: 1.3 },
};

type Sport = 'tennis' | 'baseball' | 'bowling' | 'archery' | 'duel' | 'lighthouse' | 'palm';

interface Island {
  d: THREE.Vector3;
  r: number;
  wob: number;
  biome: Biome;
  sport: Sport;
  /** angular radius of the flat clearing the landmark sits in (0 = none) */
  clear: number;
}

const HERO = dir(10, 0);
const ISLANDS: Island[] = [
  { d: HERO, r: 0.5, wob: 0.24, biome: BIOMES.meadow, sport: 'tennis', clear: 0.18 },
  { d: dir(30, 76), r: 0.5, wob: 0.26, biome: BIOMES.autumn, sport: 'baseball', clear: 0.0 },
  { d: dir(-24, 146), r: 0.5, wob: 0.26, biome: BIOMES.desert, sport: 'bowling', clear: 0.0 },
  { d: dir(28, -146), r: 0.5, wob: 0.26, biome: BIOMES.forest, sport: 'archery', clear: 0.17 },
  { d: dir(-26, -76), r: 0.5, wob: 0.26, biome: BIOMES.snow, sport: 'duel', clear: 0.0 },
  { d: dir(50, -34), r: 0.1, wob: 0.3, biome: BIOMES.meadow, sport: 'lighthouse', clear: 0 },
  { d: dir(-44, 32), r: 0.09, wob: 0.3, biome: BIOMES.desert, sport: 'palm', clear: 0 },
];

/** > 0 on land (grows inland, ~radians) and which island it belongs to */
function land(p: THREE.Vector3): { f: number; is: Island } {
  let best = -9, bi = ISLANDS[0];
  const w1 = fbm(p, 3.2), w2 = fbm(p, 7);
  for (const is of ISLANDS) {
    const ang = Math.acos(THREE.MathUtils.clamp(p.dot(is.d), -1, 1));
    const v = is.r * (1 + (w1 - 0.5) * is.wob * 1.6 + (w2 - 0.5) * 0.08) - ang;
    if (v > best) {
      best = v;
      bi = is;
    }
  }
  return { f: best, is: bi };
}

const H_SEA = 1;
const H_BEACH = 1.012;
const H_TOP = 1.064;
function landHeight(f: number) {
  if (f <= 0) return H_SEA - 0.012;
  const beach = THREE.MathUtils.smoothstep(f, 0, 0.022);
  const wall = THREE.MathUtils.smoothstep(f, 0.03, 0.08);
  const dome = THREE.MathUtils.smoothstep(f, 0.08, 0.5) * 0.03;
  return H_SEA - 0.012 + (H_BEACH - H_SEA + 0.012) * beach + (H_TOP - H_BEACH) * wall + dome;
}
const heightAt = (d: THREE.Vector3) => landHeight(land(d).f);

// ---------------------------------------------------------------- helpers

function std(color: THREE.ColorRepresentation, rough = 0.7, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });
}
function shade<T extends THREE.Object3D>(o: T, cast = true, receive = true): T {
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) {
      m.castShadow = cast;
      m.receiveShadow = receive;
    }
  });
  return o;
}
/** stand an object on the surface at direction d (its +Y along d) */
function place(o: THREE.Object3D, d: THREE.Vector3, h: number, yaw = 0) {
  const n = d.clone().normalize();
  o.position.copy(n).multiplyScalar(h);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  o.rotateY(yaw);
  return o;
}
/** a random direction inside the cap of angular radius r around d */
function inCap(d: THREE.Vector3, r: number) {
  const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * r;
  const t = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const b = new THREE.Vector3().crossVectors(d, t);
  return d.clone().multiplyScalar(Math.cos(rr)).addScaledVector(t, Math.sin(rr) * Math.cos(a)).addScaledVector(b, Math.sin(rr) * Math.sin(a)).normalize();
}

// ---------------------------------------------------------------- planet

const OCEAN = { deep: col('#1d63d6'), mid: col('#2b8df0'), shallow: col('#3fc8f8'), lagoon: col('#7ae6ff'), line: col('#9fe9ff') };

function buildOcean() {
  const g = new THREE.IcosahedronGeometry(1, 96);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const d = Math.max(0, -land(p).f);
    // lagoon → turquoise shelf → azure → deeper blue far out
    c.copy(OCEAN.lagoon)
      .lerp(OCEAN.shallow, THREE.MathUtils.smoothstep(d, 0.0, 0.03))
      .lerp(OCEAN.mid, THREE.MathUtils.smoothstep(d, 0.04, 0.11))
      .lerp(OCEAN.deep, THREE.MathUtils.smoothstep(d, 0.16, 0.42));
    // a soft light ring following each coast a little way out, and a fainter second one
    const wob = (fbm(p, 9, 2) - 0.5) * 0.02;
    const ring = (x: number, w: number) => Math.exp(-(((d + wob - x) / w) ** 2));
    c.lerp(OCEAN.line, ring(0.075, 0.007) * 0.55 + ring(0.13, 0.006) * 0.25);
    // big gentle patches so open water isn't flat
    c.multiplyScalar(0.94 + fbm(p, 2.2, 2) * 0.12);
    cols.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return shade(new THREE.Mesh(g, std('#ffffff', 0.12, { vertexColors: true, envMapIntensity: 1.3 })), false, true);
}

function buildLand() {
  const g = new THREE.IcosahedronGeometry(1, 190);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), c = new THREE.Color();
  const soil = col('#a86a3c');
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const { f, is } = land(p);
    const h = landHeight(f);
    pos.setXYZ(i, p.x * h, p.y * h, p.z * h);
    const B = is.biome;
    if (f < 0.028) c.copy(B.beach);
    else if (f < 0.085) {
      const t = THREE.MathUtils.smoothstep(f, 0.028, 0.085);
      c.copy(soil).lerp(B.wall, THREE.MathUtils.smoothstep(t, 0, 0.3)).lerp(B.top[0], THREE.MathUtils.smoothstep(t, 0.6, 0.95));
    } else {
      c.copy(B.top[0]).lerp(B.top[1], THREE.MathUtils.smoothstep(fbm(p, 9), 0.38, 0.68));
      if (is.clear) {
        const cl = p.angleTo(is.d) + (fbm(p, 14) - 0.5) * 0.05;
        c.lerp(B.beach, 1 - THREE.MathUtils.smoothstep(cl, is.clear * 0.85, is.clear * 1.05));
      }
    }
    cols.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return shade(new THREE.Mesh(g, std('#ffffff', 0.85, { vertexColors: true })));
}

// ---------------------------------------------------------------- flora (instanced by part)

/** one instanced part: a geometry, and per-instance matrices + colours */
class Parts {
  mats: THREE.Matrix4[] = [];
  cols: THREE.Color[] = [];
  constructor(public geo: THREE.BufferGeometry, public rough = 0.75, public flat = false) {}
  add(m: THREE.Matrix4, c: THREE.Color) {
    this.mats.push(m.clone());
    this.cols.push(c.clone());
  }
  mesh() {
    const im = new THREE.InstancedMesh(this.geo, std('#ffffff', this.rough, { flatShading: this.flat }), Math.max(1, this.mats.length));
    this.mats.forEach((m, i) => {
      im.setMatrixAt(i, m);
      im.setColorAt(i, this.cols[i]);
    });
    im.count = this.mats.length;
    return shade(im);
  }
}

const G = {
  ball: new THREE.IcosahedronGeometry(1, 3),
  trunk: new THREE.CylinderGeometry(0.2, 0.28, 1, 8).translate(0, 0.5, 0),
  cone: new THREE.ConeGeometry(1, 1, 12).translate(0, 0.5, 0),
  capsule: new THREE.CapsuleGeometry(0.22, 0.8, 6, 12).translate(0, 0.62, 0),
  leaf: new THREE.SphereGeometry(1, 12, 8).scale(1, 0.18, 0.36).translate(0.9, 0, 0),
  peak: (() => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(new THREE.Vector2(Math.max(0.001, (1 - t) ** 1.25 * (1 - 0.18 * Math.sin(t * Math.PI))), t));
    }
    return new THREE.LatheGeometry(pts, 7);
  })(),
  snowcap: (() => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = 0.5 + (i / 8) * 0.5;
      pts.push(new THREE.Vector2(Math.max(0.001, (1 - t) ** 1.25 * (1 - 0.18 * Math.sin(t * Math.PI)) * 1.06), t + 0.004));
    }
    return new THREE.LatheGeometry(pts, 7);
  })(),
};

const PAL = {
  round: [col('#4fae2c'), col('#3d9a26'), col('#69c235')],
  pine: [col('#2f8a2c'), col('#3a9a34')],
  blossom: [col('#ff9cc4'), col('#ffb6d3'), col('#f47fb0'), col('#ffc6dc')],
  autumn: [col('#ff8a2e'), col('#f45d34'), col('#ffbf36'), col('#e8452e')],
  snowpine: [col('#2f7d52'), col('#3a8a5a')],
  palm: [col('#4fb33a'), col('#62c043')],
  cactus: [col('#4aa84a'), col('#5bb556')],
  trunk: col('#8a5530'),
  palmTrunk: col('#c08a52'),
  snow: col('#ffffff'),
  peak: [col('#9d93c2'), col('#8f86b8'), col('#a8a0c9')],
  boulder: [col('#e0925a'), col('#d27e4c'), col('#eaa66a')],
  flower: [col('#ffffff'), col('#ffe14d'), col('#ff7aa8'), col('#ff9e3d')],
};

function makeFlora(spots: { d: THREE.Vector3; s: number; kind: Flora }[]) {
  const P = {
    ball: new Parts(G.ball),
    trunk: new Parts(G.trunk, 0.8),
    cone: new Parts(G.cone),
    capsule: new Parts(G.capsule),
    leaf: new Parts(G.leaf),
    peak: new Parts(G.peak, 0.85, true),
    cap: new Parts(G.snowcap, 0.6, true),
    rock: new Parts(new THREE.IcosahedronGeometry(1, 0), 0.85, true),
  };
  const o = new THREE.Object3D();
  const pick = (a: THREE.Color[]) => a[Math.floor(rnd() * a.length)].clone().multiplyScalar(0.93 + rnd() * 0.14);
  const M = (base: THREE.Matrix4, tx: number, ty: number, tz: number, sx: number, sy: number, sz: number, rx = 0, rz = 0) =>
    base.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(tx, ty, tz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)), new THREE.Vector3(sx, sy, sz)));
  for (const sp of spots) {
    place(o, sp.d, heightAt(sp.d) - 0.003, rnd() * 6.28);
    o.scale.setScalar(sp.s);
    o.updateMatrix();
    const b = o.matrix;
    switch (sp.kind) {
      case 'round':
      case 'blossom':
      case 'autumn': {
        const pal = sp.kind === 'round' ? PAL.round : sp.kind === 'blossom' ? PAL.blossom : PAL.autumn;
        P.trunk.add(M(b, 0, 0, 0, 1, 0.9, 1), PAL.trunk);
        const c = pick(pal);
        P.ball.add(M(b, 0, 1.25, 0, 0.95, 0.9, 0.95), c);
        if (rnd() < 0.5) P.ball.add(M(b, 0.35, 1.0, 0.2, 0.55, 0.5, 0.55), c.clone().multiplyScalar(1.06));
        break;
      }
      case 'pine':
      case 'snowpine': {
        const c = pick(sp.kind === 'pine' ? PAL.pine : PAL.snowpine);
        P.trunk.add(M(b, 0, 0, 0, 0.8, 0.45, 0.8), PAL.trunk);
        P.cone.add(M(b, 0, 0.3, 0, 0.66, 1.0, 0.66), c);
        P.cone.add(M(b, 0, 0.85, 0, 0.5, 0.85, 0.5), c);
        if (sp.kind === 'snowpine') {
          P.cone.add(M(b, 0, 1.28, 0, 0.27, 0.42, 0.27), PAL.snow);
          P.cone.add(M(b, 0, 0.72, 0, 0.42, 0.3, 0.42), PAL.snow);
        }
        break;
      }
      case 'palm': {
        const lean = (rnd() - 0.5) * 0.5;
        P.trunk.add(M(b, 0, 0, 0, 0.55, 1.7, 0.55, 0, lean), PAL.palmTrunk);
        const tip = new THREE.Vector3(0, 1.7, 0).applyEuler(new THREE.Euler(0, 0, lean));
        const c = pick(PAL.palm);
        for (let k = 0; k < 6; k++) {
          const lm = b.clone().multiply(
            new THREE.Matrix4().compose(tip, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (k / 6) * Math.PI * 2, -0.45, 'YXZ')), new THREE.Vector3(0.75, 0.75, 0.75)),
          );
          P.leaf.add(lm, c);
        }
        P.ball.add(M(b, tip.x, tip.y, 0, 0.14, 0.14, 0.14), col('#7a4a28'));
        break;
      }
      case 'cactus': {
        const c = pick(PAL.cactus);
        P.capsule.add(M(b, 0, 0, 0, 1, 1, 1), c);
        P.capsule.add(M(b, 0.28, 0.45, 0, 0.6, 0.5, 0.6, 0, 0), c);
        P.capsule.add(M(b, -0.26, 0.6, 0, 0.55, 0.42, 0.55, 0, 0), c);
        break;
      }
      case 'boulder': {
        P.rock.add(M(b, 0, 0.2, 0, 1.1, 0.75, 1.0, rnd(), rnd()), pick(PAL.boulder));
        break;
      }
      case 'flower': {
        P.ball.add(M(b, 0, 0.35, 0, 0.7, 0.7, 0.7), pick(PAL.flower));
        break;
      }
      case 'peak': {
        const c = pick(PAL.peak);
        const w = 1.0 + rnd() * 0.3, hh = 2.1 + rnd() * 0.8;
        P.peak.add(M(b, 0, -0.1, 0, w, hh, w), c);
        P.cap.add(M(b, 0, -0.1, 0, w, hh, w), PAL.snow);
        break;
      }
    }
  }
  const g = new THREE.Group();
  for (const p of Object.values(P)) if (p.mats.length) g.add(p.mesh());
  return g;
}

function floraFor(is: Island, avoid: { d: THREE.Vector3; r: number }[], sizeMul = 1) {
  const out: { d: THREE.Vector3; s: number; kind: Flora }[] = [];
  const B = is.biome;
  const total = B.flora.reduce((a, [, w]) => a + w, 0);
  const n = Math.round(is.r * is.r * 330 * B.density);
  let tries = 0;
  while (out.length < n && tries++ < n * 80) {
    const d = inCap(is.d, is.r * 1.2);
    const L = land(d);
    if (L.is !== is || L.f < 0.075) continue;
    if (avoid.some((v) => d.angleTo(v.d) < v.r)) continue;
    const belt = L.f < 0.2;
    if (!belt && fbm(d, 4.5) < (is.d === HERO ? 0.5 : 0.58)) continue;
    if (belt && fbm(d, 6) < 0.33) continue;
    let r = rnd() * total, kind: Flora = B.flora[0][0];
    for (const [k, w] of B.flora) if ((r -= w) <= 0) {
      kind = k;
      break;
    }
    const base = kind === 'flower' ? 0.011 : kind === 'peak' ? 0.06 : kind === 'cactus' ? 0.05 : kind === 'palm' ? 0.05 : 0.045;
    const s = (base + rnd() * (kind === 'flower' ? 0.006 : 0.03)) * sizeMul;
    const clear = kind === 'peak' ? 1.1 : kind === 'flower' ? 0.5 : 0.8;
    if (out.some((o) => o.d.angleTo(d) < (o.s + s) * clear)) continue;
    out.push({ d, s, kind });
  }
  return out;
}

// ---------------------------------------------------------------- props

function house(roof: THREE.ColorRepresentation) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 0.9).translate(0, 0.4, 0), std('#fff3e6', 0.8)));
  const roofGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.12, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 2).rotateY(Math.PI / 2);
  roofGeo.scale(1, 0.75, 1.02).translate(0, 1.02, 0);
  g.add(new THREE.Mesh(roofGeo, std(roof, 0.6)));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.38, 0.05).translate(0, 0.19, 0.46), std('#8a4a3a', 0.7)));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.05).translate(0.3, 0.5, 0.46), std('#7fd0ff', 0.3)));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.34, 0.16).translate(-0.28, 1.2, 0), std('#c96a4a', 0.7)));
  return shade(g);
}

function lighthouse() {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const r0 = 0.34 - i * 0.03, r1 = 0.34 - (i + 1) * 0.03;
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 0.4, 16).translate(0, 0.2 + i * 0.4, 0), std(i % 2 ? '#ffffff' : '#ef4a5a', 0.6)));
  }
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.28, 12).translate(0, 2.14, 0), std('#fff6c0', 0.3, { emissive: '#ffe070', emissiveIntensity: 0.6 })));
  g.add(new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.32, 12).translate(0, 2.44, 0), std('#ef4a5a', 0.6)));
  return shade(g);
}

function igloo() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.6, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), std('#ffffff', 0.5)));
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.4, 14, 1, false, 0, Math.PI).rotateX(Math.PI / 2).translate(0, 0, 0.55), std('#eaf3ff', 0.5)));
  return shade(g);
}

function rock(c: THREE.ColorRepresentation = '#a79bc9') {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.85 + rnd() * 0.3), p.getY(i) * (0.6 + rnd() * 0.25), p.getZ(i) * (0.85 + rnd() * 0.3));
  geo.computeVertexNormals();
  return shade(new THREE.Mesh(geo, std(c, 0.8, { flatShading: true })));
}

function fence(n: number) {
  const g = new THREE.Group();
  const wood = std('#d9955a', 0.8);
  for (let i = 0; i < n; i++) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12).translate(i * 0.4, 0.25, 0), wood));
  g.add(new THREE.Mesh(new THREE.BoxGeometry((n - 1) * 0.4 + 0.12, 0.07, 0.06).translate(((n - 1) * 0.4) / 2, 0.36, 0), wood));
  g.add(new THREE.Mesh(new THREE.BoxGeometry((n - 1) * 0.4 + 0.12, 0.07, 0.06).translate(((n - 1) * 0.4) / 2, 0.18, 0), wood));
  return shade(g);
}

function courtTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 1024;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#4fb048';
  x.fillRect(0, 0, 512, 1024);
  x.fillStyle = '#2f7fe0';
  x.fillRect(64, 96, 384, 832);
  x.strokeStyle = '#ffffff';
  x.lineWidth = 14;
  x.strokeRect(64, 96, 384, 832);
  x.beginPath();
  x.moveTo(112, 96); x.lineTo(112, 928);
  x.moveTo(400, 96); x.lineTo(400, 928);
  x.moveTo(112, 300); x.lineTo(400, 300);
  x.moveTo(112, 724); x.lineTo(400, 724);
  x.moveTo(256, 300); x.lineTo(256, 724);
  x.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function court() {
  const g = new THREE.Group();
  const side = std('#3f9a3c', 0.8);
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 1.8).translate(0, 0.03, 0), [side, side, std('#ffffff', 0.55, { map: courtTexture() }), side, side, side]));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.1, 0.02).translate(0, 0.11, 0), std('#ffffff', 0.5)));
  for (const xx of [-0.45, 0.45]) g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8).translate(xx, 0.14, 0), std('#e8e8e8', 0.4)));
  return shade(g);
}

function cloud(n: number, size: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const mid = 1 - Math.abs(i - (n - 1) / 2) / n;
    const s = size * (0.55 + rnd() * 0.35) * (0.7 + mid * 0.6);
    const x = (i - (n - 1) / 2) * size * 0.72 + (rnd() - 0.5) * size * 0.25;
    const y = mid * size * 0.45 + (rnd() - 0.5) * size * 0.2;
    parts.push(new THREE.IcosahedronGeometry(s, 4).translate(x, y, (rnd() - 0.5) * size * 0.4));
  }
  return shade(new THREE.Mesh(mergeGeometries(parts), std('#ffffff', 0.9, { envMapIntensity: 0.6, emissive: '#ffd3e6', emissiveIntensity: 0.12 })), true, false);
}

function plane() {
  const g = new THREE.Group();
  const red = std('#ef4a5a', 0.5), white = std('#ffffff', 0.5);
  g.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.9, 6, 14).rotateX(Math.PI / 2), red));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.34).translate(0, 0, 0.12), white));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.2).translate(0, 0.02, -0.55), white));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.22).translate(0, 0.16, -0.55), red));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.04).translate(0, 0, 0.66), std('#555566', 0.5)));
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8).translate(0, 0, 0.64), white));
  return shade(g);
}

function tennisBall() {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#d8ff3a';
  x.fillRect(0, 0, 512, 256);
  x.strokeStyle = '#ffffff';
  x.lineWidth = 12;
  x.beginPath();
  for (let i = 0; i <= 512; i += 4) {
    const y = 128 + Math.sin((i / 512) * Math.PI * 4) * 70;
    if (i === 0) x.moveTo(i, y);
    else x.lineTo(i, y);
  }
  x.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return shade(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), std('#ffffff', 0.85, { map: t })));
}

function atmosphere() {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    // normal blending with a real alpha, so the glow composites cleanly over a transparent canvas
    uniforms: { c: { value: new THREE.Color('#8fe6ff') } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 c; varying vec3 vN; varying vec3 vV;
      void main(){ float d = abs(dot(vN, vV)); float f = pow(1. - d, 2.0) * smoothstep(0.0, 0.3, d); gl_FragColor = vec4(c, f * 0.45); }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1.045, 64, 48), mat);
}


// ---------------------------------------------------------------- sport landmarks

function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** a round pad whose top carries a texture (fields, arenas) */
function pad(r: number, h: number, top: THREE.Texture, side: THREE.ColorRepresentation) {
  const sideM = std(side, 0.8);
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.02, h, 64).translate(0, h / 2, 0), [sideM, std('#ffffff', 0.7, { map: top }), sideM]);
}

function baseball() {
  const g = new THREE.Group();
  const tex = canvasTex(1024, 1024, (x) => {
    // mown outfield
    for (let i = 0; i < 16; i++) {
      x.fillStyle = i % 2 ? '#5cb83a' : '#6cc444';
      x.fillRect(0, i * 64, 1024, 64);
    }
    // infield dirt: a diamond with a rounded back edge, home plate toward +z (bottom of the texture)
    const hx = 512, hy = 820;
    x.fillStyle = '#d99a5b';
    x.beginPath();
    x.moveTo(hx, hy + 40);
    x.lineTo(hx - 300, hy - 300);
    x.arc(hx, hy - 60, 420, Math.PI * 1.2, Math.PI * 1.8);
    x.lineTo(hx + 300, hy - 300);
    x.closePath();
    x.fill();
    // infield grass
    x.fillStyle = '#6cc444';
    x.beginPath();
    x.moveTo(hx, hy - 60);
    x.lineTo(hx - 190, hy - 250);
    x.lineTo(hx, hy - 440);
    x.lineTo(hx + 190, hy - 250);
    x.closePath();
    x.fill();
    // foul lines, bases, mound
    x.strokeStyle = '#ffffff';
    x.lineWidth = 10;
    x.beginPath();
    x.moveTo(hx, hy);
    x.lineTo(hx - 560, hy - 560);
    x.moveTo(hx, hy);
    x.lineTo(hx + 560, hy - 560);
    x.stroke();
    x.fillStyle = '#ffffff';
    for (const [bx, by] of [[hx + 220, hy - 250], [hx, hy - 470], [hx - 220, hy - 250]]) x.fillRect(bx - 18, by - 18, 36, 36);
    x.beginPath();
    x.moveTo(hx, hy - 16); x.lineTo(hx + 16, hy); x.lineTo(hx, hy + 16); x.lineTo(hx - 16, hy);
    x.fill();
    x.fillStyle = '#c98848';
    x.beginPath();
    x.arc(hx, hy - 250, 40, 0, Math.PI * 2);
    x.fill();
  });
  g.add(pad(1, 0.06, tex, '#4e9e36'));
  // two little stands behind home plate
  const seat = std('#3aa8ff', 0.6), frame = std('#ffffff', 0.7);
  for (const side of [-1, 1]) {
    const st = new THREE.Group();
    for (let k = 0; k < 3; k++) st.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08 + k * 0.08, 0.14).translate(0, (0.08 + k * 0.08) / 2, -k * 0.14), k % 2 ? seat : frame));
    st.position.set(side * 0.46, 0.06, 0.62);
    st.rotation.y = Math.PI + side * 0.75;
    g.add(st);
  }
  // yellow foul poles
  for (const side of [-1, 1]) g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8).translate(side * 0.62, 0.31, -0.26), std('#ffd23d', 0.5)));
  return shade(g);
}

function pinGeo() {
  const prof = [[0.16, 0], [0.24, 0.12], [0.28, 0.3], [0.2, 0.52], [0.11, 0.66], [0.13, 0.78], [0.15, 0.88], [0.1, 0.97], [0.001, 1]];
  return new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 20);
}

function bowling() {
  const g = new THREE.Group();
  const lane = canvasTex(256, 1024, (x) => {
    for (let i = 0; i < 8; i++) {
      x.fillStyle = i % 2 ? '#f0c388' : '#e8b677';
      x.fillRect(i * 32, 0, 32, 1024);
    }
    x.fillStyle = '#c0392b';
    for (let i = 0; i < 5; i++) {
      const ax = 48 + i * 40, ay = 700 - Math.abs(i - 2) * 30;
      x.beginPath();
      x.moveTo(ax, ay - 26); x.lineTo(ax + 10, ay); x.lineTo(ax - 10, ay);
      x.fill();
    }
  });
  const wood = std('#e8b677', 0.6);
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 2.1).translate(0, 0.035, 0), [wood, wood, std('#ffffff', 0.45, { map: lane }), wood, wood, wood]));
  for (const side of [-1, 1]) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 2.1).translate(side * 0.37, 0.05, 0), std('#6a6f8a', 0.5)));
  // pins in their triangle at the far end, the ball rolling up the lane
  const pinW = std('#ffffff', 0.35), pinR = std('#e8303f', 0.4);
  const pg = pinGeo();
  let k = 0;
  for (let row = 0; row < 4; row++)
    for (let i = 0; i <= row; i++) {
      const pin = new THREE.Group();
      pin.add(new THREE.Mesh(pg, pinW), new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.022, 8, 20).rotateX(Math.PI / 2).translate(0, 0.72, 0), pinR));
      pin.position.set((i - row / 2) * 0.13, 0.07, -0.72 - row * 0.12);
      pin.scale.setScalar(0.24);
      g.add(pin);
      k++;
    }
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16).translate(0.04, 0.16, 0.45), std('#7b4dff', 0.2)));
  // a giant pin standing beside the lane, the island's beacon
  const big = new THREE.Group();
  big.add(new THREE.Mesh(pg, pinW), new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.024, 10, 24).rotateX(Math.PI / 2).translate(0, 0.72, 0), pinR), new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.02, 10, 24).rotateX(Math.PI / 2).translate(0, 0.78, 0), pinR));
  big.scale.setScalar(1.25);
  big.position.set(0.72, 0, 0.1);
  g.add(big);
  return shade(g);
}

function target() {
  const face = canvasTex(256, 256, (x) => {
    const rings = ['#ffffff', '#1d1c33', '#2f7fe0', '#e8303f', '#ffd23d'];
    rings.forEach((c, i) => {
      x.fillStyle = c;
      x.beginPath();
      x.arc(128, 128, 128 - i * 24, 0, Math.PI * 2);
      x.fill();
    });
  });
  const g = new THREE.Group();
  const straw = std('#e8c46a', 0.9);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.1, 40).rotateX(Math.PI / 2).translate(0, 0.62, 0), [straw, std('#ffffff', 0.6, { map: face }), straw]);
  g.add(disc);
  const leg = std('#9a6a3a', 0.8);
  for (const side of [-1, 1]) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06).translate(0, 0.4, 0).rotateZ(side * 0.25).translate(side * 0.14, 0, -0.06), leg));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06).translate(0, 0.4, 0).rotateX(-0.35).translate(0, 0, -0.1), leg));
  return g;
}

function archery() {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const t = target();
    t.position.set((i - 1) * 0.62, 0, -0.1 + Math.abs(i - 1) * 0.08);
    t.rotation.y = (1 - i) * 0.18;
    // lean back so the faces look up at the viewer (the island faces the camera)
    t.rotation.x = -0.95;
    t.position.y = 0.18;
    g.add(t);
  }
  // balloons tethered over the range
  const cols = ['#e8303f', '#ffd23d', '#3aa8ff', '#ff7aa8', '#7b4dff'];
  cols.forEach((c, i) => {
    const bx = (i - 2) * 0.32 + (rnd() - 0.5) * 0.1, by = 1.25 + (i % 2) * 0.22, bz = 0.25 + (rnd() - 0.5) * 0.2;
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14).scale(1, 1.18, 1).translate(bx, by, bz), std(c, 0.35)));
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, by - 0.1, 4).translate(bx, (by - 0.1) / 2, bz), std('#ffffff', 0.6)));
  });
  return shade(g);
}

function sword(blade = '#eef3ff') {
  const g = new THREE.Group();
  const bl = new THREE.CylinderGeometry(0.001, 0.11, 1.3, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.35).translate(0, 0.65, 0);
  g.add(new THREE.Mesh(bl, std(blade, 0.25, { metalness: 0.55 })));
  const gold = std('#ffc83d', 0.35, { metalness: 0.4 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.11).translate(0, 1.33, 0), gold));
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.28, 10).translate(0, 1.5, 0), std('#7a3f2a', 0.7)));
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10).translate(0, 1.66, 0), gold));
  // blade tip points down into the stone
  g.rotation.x = Math.PI;
  g.position.y = 1.62;
  return g;
}

function duel() {
  const g = new THREE.Group();
  const floor = canvasTex(512, 512, (x) => {
    x.fillStyle = '#c9c3e3';
    x.fillRect(0, 0, 512, 512);
    x.strokeStyle = '#e8303f';
    x.lineWidth = 22;
    x.beginPath();
    x.arc(256, 256, 190, 0, Math.PI * 2);
    x.stroke();
    x.strokeStyle = '#b3acd4';
    x.lineWidth = 6;
    for (let a = 0; a < 12; a++) {
      x.beginPath();
      x.moveTo(256, 256);
      x.lineTo(256 + Math.cos((a / 12) * Math.PI * 2) * 256, 256 + Math.sin((a / 12) * Math.PI * 2) * 256);
      x.stroke();
    }
  });
  g.add(pad(1.0, 0.1, canvasTex(8, 8, (x) => ((x.fillStyle = '#b3acd4'), x.fillRect(0, 0, 8, 8))), '#a39cc8'));
  const top = pad(0.86, 0.08, floor, '#b3acd4');
  top.position.y = 0.1;
  g.add(top);
  // pillars with flame-orange caps round the rim
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.42, 12).translate(Math.cos(a) * 0.93, 0.31, Math.sin(a) * 0.93), std('#d8d3ee', 0.7)));
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8).translate(Math.cos(a) * 0.93, 0.56, Math.sin(a) * 0.93), std('#ff9a3d', 0.4, { emissive: '#ff7a1a', emissiveIntensity: 0.5 })));
  }
  // two swords crossed, planted in the centre
  for (const side of [-1, 1]) {
    const sw = sword();
    const holder = new THREE.Group();
    holder.add(sw);
    holder.position.y = 0.18;
    // lean out into a big X that reads from above
    holder.rotation.z = side * 0.8;
    holder.rotation.y = 0.35;
    holder.scale.setScalar(0.85);
    g.add(holder);
  }
  return shade(g);
}

// ---------------------------------------------------------------- the globe

export interface Globe {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  spinner: THREE.Group;
  setSpin(t: number): void;
}

export function buildGlobe(): Globe {
  seed = 7;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
  camera.position.set(0, 0.7, 6.9);
  camera.lookAt(0, 0.03, 0);

  const spinner = new THREE.Group();
  spinner.add(buildOcean(), buildLand());
  const at = dir;
  const avoid: { d: THREE.Vector3; r: number }[] = [];
  const put = (o: THREE.Object3D, d: THREE.Vector3, s: number, yaw = 0, r = 0.08, sink = 0) => {
    place(o, d, heightAt(d) - sink, yaw);
    o.scale.setScalar(s);
    spinner.add(o);
    avoid.push({ d, r });
    return o;
  };

  // ---- one landmark per island, the flora framing it
  const [tennisI, baseballI, bowlingI, archeryI, duelI, lightI, palmI] = ISLANDS;
  // tennis: the court in its sandy clearing, two cottages, rocks, a dock and a boat
  put(court(), tennisI.d, 0.27, 0.35, tennisI.clear, 0.004);
  put(house('#ef5a6f'), at(30, -18), 0.1, 0.8, 0.09);
  put(house('#ff8a3d'), at(-4, 22), 0.1, -0.5, 0.09);
  for (const [la, lo, s] of [[-6, -16, 0.036], [-4, -12, 0.022], [30, 14, 0.028]]) put(rock(), at(la, lo), s, rnd() * 6, s * 1.6, 0.005);
  {
    const dock = new THREE.Group();
    const plank = std('#c98a52', 0.8);
    dock.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 1.8).translate(0, 0.25, -0.9), plank));
    for (const [px, pz] of [[-0.22, -0.4], [0.22, -0.4], [-0.22, -1.4], [0.22, -1.4]]) dock.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8).translate(px, 0.1, pz), plank));
    place(shade(dock), at(2, -27), 1.0, Math.PI / 2 + 0.6);
    dock.scale.setScalar(0.09);
    spinner.add(dock);
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(0.55, 0.55, 1.25), std('#ff6f61', 0.55, { side: THREE.DoubleSide }));
    hull.position.y = 0.34;
    boat.add(hull, new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 24).scale(0.55, 1.25, 1).rotateX(Math.PI / 2).translate(0, 0.34, 0), std('#ffffff', 0.6)));
    place(shade(boat), at(-8, -36), 0.998, 0.9);
    boat.scale.setScalar(0.11);
    spinner.add(boat);
  }
  // baseball: a ballpark among autumn trees
  put(baseball(), baseballI.d, 0.21, -1.1, 0.24, 0.004);
  // bowling: an open-air lane with a giant pin, palms around
  put(bowling(), bowlingI.d, 0.2, 2.6, 0.26, 0.004);
  // archery: a range of targets and balloons in a pine forest clearing
  put(archery(), archeryI.d, 0.2, 0, archeryI.clear, 0.004);
  // the duel: a stone arena with crossed swords on a snowy peak island
  put(duel(), duelI.d, 0.2, 0.9, 0.23, 0.004);
  // the islets
  put(lighthouse(), lightI.d, 0.08, 0, 0.05);

  const spots = ISLANDS.flatMap((is) => floraFor(is, avoid));
  spots.push({ d: palmI.d, s: 0.06, kind: 'palm' });
  spinner.add(makeFlora(spots));

  // ---- clouds hugging the planet (lat, lon, height, size, puffs)
  const clouds: [number, number, number, number, number][] = [
    [56, 24, 1.22, 0.11, 5], [8, -62, 1.24, 0.09, 4], [-30, 44, 1.22, 0.1, 5], [70, -100, 1.2, 0.1, 5],
    [0, 116, 1.2, 0.1, 5], [-60, -130, 1.2, 0.09, 4], [60, 150, 1.2, 0.1, 5], [-55, 100, 1.2, 0.08, 4],
  ];
  for (const [la, lo, h, s, n] of clouds) spinner.add(place(cloud(n, s), dir(la, lo), h, rnd() * 6));

  // ---- a toy plane circling low over the left limb
  const pl = plane();
  const plPivot = new THREE.Group();
  pl.position.set(0, 0, 1.3);
  pl.rotation.set(0, Math.PI / 2, 0.35);
  pl.scale.setScalar(0.17);
  plPivot.add(pl);
  plPivot.rotation.set(-0.42, -0.72, 0.45);
  scene.add(plPivot);

  // ---- the moon: a tennis ball on a tilted orbit
  const moonPivot = new THREE.Group();
  moonPivot.rotation.set(0.25, 0, 0.35);
  const moon = tennisBall();
  moon.scale.setScalar(0.1);
  moon.position.set(1.44, 0, 0);
  moonPivot.add(moon);
  scene.add(moonPivot);

  spinner.rotation.x = 0.05;
  scene.add(spinner, atmosphere());

  // ---- light
  const key = new THREE.DirectionalLight('#fff1dc', 3.8);
  key.position.set(-4.5, 3.6, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -1.7;
  sc.right = sc.top = 1.7;
  sc.near = 1;
  sc.far = 14;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 6;
  scene.add(key);
  scene.add(new THREE.HemisphereLight('#d8eeff', '#ff8fbf', 0.75));
  const rim = new THREE.DirectionalLight('#9fe4ff', 1.5);
  rim.position.set(3, 1, -4);
  scene.add(rim);

  const api: Globe = {
    scene,
    camera,
    spinner,
    setSpin(t: number) {
      spinner.rotation.y = t * Math.PI * 2;
      moonPivot.rotation.y = -0.9 + t * Math.PI * 4;
    },
  };
  api.setSpin(0);
  return api;
}

/** Render one frame to a PNG data URL (used by the render/bake scripts). */
export function renderGlobe(size: number, opts: { spin?: number; bg?: boolean } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  const g = dress(renderer, opts.bg);
  g.setSpin(opts.spin ?? 0);
  renderer.render(g.scene, g.camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  return url;
}

/** Build the globe and set the renderer up to light it (tone mapping, shadows, environment, optional backdrop). */
export function dress(renderer: THREE.WebGLRenderer, bg = false) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const g = buildGlobe();
  const pm = new THREE.PMREMGenerator(renderer);
  g.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  g.scene.environmentIntensity = 0.28;
  if (bg) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1024;
    const x = cv.getContext('2d')!;
    const gr = x.createRadialGradient(512, 512, 0, 512, 512, 740);
    gr.addColorStop(0, '#3cc0f2');
    gr.addColorStop(0.35, '#1f93dc');
    gr.addColorStop(1, '#0b3f86');
    x.fillStyle = gr;
    x.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 90; i++) {
      x.globalAlpha = 0.3 + rnd() * 0.6;
      x.fillStyle = '#ffffff';
      x.beginPath();
      x.arc(rnd() * 1024, rnd() * 1024, 0.8 + rnd() * 1.8, 0, Math.PI * 2);
      x.fill();
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    g.scene.background = t;
  }
  return g;
}
