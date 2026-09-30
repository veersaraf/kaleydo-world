// The KALEYDO WORLD hero globe: a chunky toy planet (soft, rounded, a few packed
// islands, puffy clouds, a tennis-ball moon). It never runs in the game: the
// bake script renders it to stills and a spin (scripts/render-globe.mjs).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- noise

function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v),
    L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
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

// ---------------------------------------------------------------- layout

/** direction from latitude/longitude in degrees (lon 0 faces the camera, +lat is up) */
function dir(lat: number, lon: number) {
  const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo));
}

interface Island {
  d: THREE.Vector3;
  /** angular radius (radians) */
  r: number;
  /** coastline wobble */
  wob: number;
}

const CLEARING = dir(12, 2);

const ISLANDS: Island[] = [
  { d: dir(12, 0), r: 0.56, wob: 0.24 }, // hero: the tennis court
  { d: dir(-36, -34), r: 0.26, wob: 0.32 },
  { d: dir(-30, 38), r: 0.2, wob: 0.3 },
  { d: dir(62, -40), r: 0.3, wob: 0.3 },
  { d: dir(40, 78), r: 0.32, wob: 0.3 },
  { d: dir(-10, -80), r: 0.34, wob: 0.28 },
  { d: dir(-48, 42), r: 0.3, wob: 0.3 },
  { d: dir(-60, -30), r: 0.22, wob: 0.3 },
  { d: dir(5, 150), r: 0.4, wob: 0.3 },
  { d: dir(-20, -150), r: 0.38, wob: 0.3 },
  { d: dir(70, 120), r: 0.26, wob: 0.3 },
];

/** > 0 on land, the value grows inland (roughly in radians) */
function landField(p: THREE.Vector3) {
  let best = -1;
  for (const is of ISLANDS) {
    const ang = Math.acos(THREE.MathUtils.clamp(p.dot(is.d), -1, 1));
    const wob = (fbm(p, 3.2) - 0.5) * is.wob * 1.6 + (fbm(p, 7) - 0.5) * 0.08;
    best = Math.max(best, is.r * (1 + wob) - ang);
  }
  return best;
}

// ---------------------------------------------------------------- palette

const C = {
  deep: new THREE.Color('#1560d6'),
  mid: new THREE.Color('#1f8bf0'),
  shallow: new THREE.Color('#5fd4ff'),
  foam: new THREE.Color('#bff2ff'),
  sand: new THREE.Color('#f2c77e'),
  grass: new THREE.Color('#7cc93a'),
  grass2: new THREE.Color('#5fb52c'),
  wall: new THREE.Color('#3f9a2a'),
  soil: new THREE.Color('#b8743f'),
  tree: [new THREE.Color('#4fae2c'), new THREE.Color('#3d9a26'), new THREE.Color('#6cc436')],
  pine: new THREE.Color('#2f8a2c'),
  trunk: new THREE.Color('#8a5530'),
  roof: new THREE.Color('#ef5a6f'),
  wallW: new THREE.Color('#fff3e6'),
  rock: new THREE.Color('#a79bc9'),
};

// land heights (planet radius 1)
const H_SEA = 1;
const H_BEACH = 1.012;
const H_TOP = 1.062;

// ---------------------------------------------------------------- build

export interface Globe {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** the turning part (planet + props + clouds) */
  spinner: THREE.Group;
  moon: THREE.Object3D;
  setSpin(t: number): void;
}

function std(color: THREE.ColorRepresentation, rough = 0.7, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });
}

/** put an object on the surface at direction d, standing up along d, at height h */
function place(o: THREE.Object3D, d: THREE.Vector3, h: number, yaw = 0) {
  const n = d.clone().normalize();
  o.position.copy(n).multiplyScalar(h);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  o.rotateY(yaw);
  return o;
}

/** surface height of the land mesh at direction d */
function heightAt(d: THREE.Vector3) {
  const f = landField(d);
  return landHeight(f);
}
function landHeight(f: number) {
  if (f <= 0) return H_SEA - 0.01;
  // beach shelf, then a rounded wall up to the plateau
  const beach = THREE.MathUtils.smoothstep(f, 0, 0.025);
  const wall = THREE.MathUtils.smoothstep(f, 0.035, 0.085);
  // a gentle dome inland so islands read as rounded mounds, not flat slabs
  const dome = THREE.MathUtils.smoothstep(f, 0.08, 0.5) * 0.03;
  return H_SEA - 0.01 + (H_BEACH - H_SEA + 0.01) * beach + (H_TOP - H_BEACH) * wall + dome;
}

function buildOcean() {
  const g = new THREE.IcosahedronGeometry(1, 60);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const f = landField(p);
    // distance out to sea (f < 0): shallow band hugging every coast
    const t = THREE.MathUtils.smoothstep(-f, 0.0, 0.16);
    c.copy(C.shallow).lerp(C.mid, THREE.MathUtils.smoothstep(t, 0.15, 0.6)).lerp(C.deep, THREE.MathUtils.smoothstep(t, 0.55, 1));
    if (-f < 0.02) c.lerp(C.foam, 1 - -f / 0.02);
    // a little large-scale variation
    c.multiplyScalar(0.94 + fbm(p, 2.5) * 0.12);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, std('#ffffff', 0.18, { vertexColors: true, envMapIntensity: 1.1 }));
  m.receiveShadow = true;
  return m;
}

function buildLand() {
  const g = new THREE.IcosahedronGeometry(1, 180);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const f = landField(p);
    const h = landHeight(f);
    pos.setXYZ(i, p.x * h, p.y * h, p.z * h);
    // colour by band: sand shelf → green wall with a soil foot → grass plateau
    if (f < 0.03) c.copy(C.sand);
    else if (f < 0.09) {
      const t = THREE.MathUtils.smoothstep(f, 0.03, 0.09);
      c.copy(C.soil).lerp(C.wall, THREE.MathUtils.smoothstep(t, 0.0, 0.3)).lerp(C.grass, THREE.MathUtils.smoothstep(t, 0.6, 0.95));
    } else {
      c.copy(C.grass).lerp(C.grass2, THREE.MathUtils.smoothstep(fbm(p, 9), 0.4, 0.7));
      // the sandy clearing the court sits in
      const cl = p.angleTo(CLEARING) + (fbm(p, 14) - 0.5) * 0.05;
      c.lerp(C.sand, 1 - THREE.MathUtils.smoothstep(cl, 0.15, 0.185));
    }
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, std('#ffffff', 0.85, { vertexColors: true }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// --- props (shared geometries; trees are instanced)

const crownGeo = new THREE.IcosahedronGeometry(1, 3);
const trunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 1, 8).translate(0, 0.5, 0);
const pineGeo = mergeGeometries([
  new THREE.ConeGeometry(0.62, 1.0, 10).translate(0, 0.55, 0),
  new THREE.ConeGeometry(0.46, 0.8, 10).translate(0, 1.05, 0),
]);

function forest(parent: THREE.Group, spots: { d: THREE.Vector3; s: number; pine: boolean }[]) {
  const rounds = spots.filter((s) => !s.pine), pines = spots.filter((s) => s.pine);
  const crowns = new THREE.InstancedMesh(crownGeo, std('#ffffff', 0.75), rounds.length);
  const pineM = new THREE.InstancedMesh(pineGeo, std('#ffffff', 0.75), pines.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, std(C.trunk, 0.8), spots.length);
  const o = new THREE.Object3D();
  const col = new THREE.Color();
  let ti = 0;
  rounds.forEach((s, i) => {
    const h = heightAt(s.d);
    place(o, s.d, h, rnd() * 6);
    o.scale.setScalar(s.s);
    o.updateMatrix();
    trunks.setMatrixAt(ti++, o.matrix.clone().multiply(new THREE.Matrix4().makeScale(1, 0.9, 1)));
    o.translateY(s.s * 1.25);
    o.scale.set(s.s * 0.95, s.s * 0.9, s.s * 0.95);
    o.updateMatrix();
    crowns.setMatrixAt(i, o.matrix);
    crowns.setColorAt(i, col.copy(C.tree[Math.floor(rnd() * 3)]).multiplyScalar(0.92 + rnd() * 0.16));
  });
  pines.forEach((s, i) => {
    const h = heightAt(s.d);
    place(o, s.d, h, rnd() * 6);
    o.scale.setScalar(s.s);
    o.updateMatrix();
    trunks.setMatrixAt(ti++, o.matrix.clone().multiply(new THREE.Matrix4().makeScale(0.8, 0.5, 0.8)));
    o.translateY(s.s * 0.35);
    o.scale.set(s.s * 1.05, s.s * 1.35, s.s * 1.05);
    o.updateMatrix();
    pineM.setMatrixAt(i, o.matrix);
    pineM.setColorAt(i, col.copy(C.pine).multiplyScalar(0.9 + rnd() * 0.2));
  });
  for (const m of [crowns, pineM, trunks]) {
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
  }
}

/** scatter tree spots over an island's plateau, keeping clear of `avoid` cones */
function treesOn(is: Island, n: number, avoid: { d: THREE.Vector3; r: number }[], pineShare: number, size = 1) {
  const out: { d: THREE.Vector3; s: number; pine: boolean }[] = [];
  let tries = 0;
  while (out.length < n && tries++ < n * 60) {
    // random direction inside the island's cap
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * is.r * 1.2;
    const t = new THREE.Vector3().crossVectors(is.d, Math.abs(is.d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const b = new THREE.Vector3().crossVectors(is.d, t);
    const d = is.d.clone().multiplyScalar(Math.cos(rr)).addScaledVector(t, Math.sin(rr) * Math.cos(a)).addScaledVector(b, Math.sin(rr) * Math.sin(a)).normalize();
    const lf = landField(d);
    if (lf < 0.075) continue;
    if (avoid.some((v) => d.angleTo(v.d) < v.r)) continue;
    // groves: a belt of trees round the coast, and a few clumps inland
    const belt = lf < 0.2;
    if (!belt && fbm(d, 4.5) < 0.6) continue;
    if (belt && fbm(d, 6) < 0.34) continue;
    const s = (0.045 + rnd() * 0.035) * size;
    if (out.some((o) => o.d.angleTo(d) < (o.s + s) * 0.8)) continue;
    out.push({ d, s, pine: rnd() < pineShare });
  }
  return out;
}

function house(roof = C.roof) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 0.9).translate(0, 0.4, 0), std(C.wallW, 0.8));
  const roofGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.12, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 2).rotateY(Math.PI / 2);
  roofGeo.scale(1, 0.75, 1.02).translate(0, 1.02, 0);
  const r = new THREE.Mesh(roofGeo, std(roof, 0.6));
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.38, 0.05).translate(0, 0.19, 0.46), std('#8a4a3a', 0.7));
  const win = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.05).translate(0.3, 0.5, 0.46), std('#7fd0ff', 0.3));
  for (const m of [body, r, door, win]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

function lighthouse() {
  const g = new THREE.Group();
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const r0 = 0.34 - i * 0.03, r1 = 0.34 - (i + 1) * 0.03;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 0.4, 16).translate(0, 0.2 + i * 0.4, 0), std(i % 2 ? '#ffffff' : '#ef4a5a', 0.6));
    m.castShadow = true;
    g.add(m);
  }
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.28, 12).translate(0, 2.14, 0), std('#fff6c0', 0.3, { emissive: '#ffe070', emissiveIntensity: 0.6 }));
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.32, 12).translate(0, 2.44, 0), std('#ef4a5a', 0.6));
  g.add(lamp, cap);
  return g;
}

function rock() {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.85 + rnd() * 0.3), p.getY(i) * (0.6 + rnd() * 0.25), p.getZ(i) * (0.85 + rnd() * 0.3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, std(C.rock, 0.8, { flatShading: true }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
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
  // slightly curved pad so it sits on the sphere
  const pad = new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 1.8).translate(0, 0.03, 0), [
    std('#3f9a3c', 0.8), std('#3f9a3c', 0.8),
    std('#ffffff', 0.55, { map: courtTexture() }), std('#3f9a3c', 0.8),
    std('#3f9a3c', 0.8), std('#3f9a3c', 0.8),
  ]);
  pad.receiveShadow = true;
  pad.castShadow = true;
  const net = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.1, 0.02).translate(0, 0.11, 0), std('#ffffff', 0.5, { transparent: true, opacity: 0.9 }));
  net.castShadow = true;
  const posts = [-0.45, 0.45].map((xx) => new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8).translate(xx, 0.14, 0), std('#e8e8e8', 0.4)));
  g.add(pad, net, ...posts);
  return g;
}

function cloud(n: number, size: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const s = size * (0.55 + rnd() * 0.5) * (i === 0 ? 1.3 : 1);
    const x = (i - (n - 1) / 2) * size * 0.75 + (rnd() - 0.5) * size * 0.3;
    const y = (rnd() - 0.3) * size * 0.35 + (1 - Math.abs(i - (n - 1) / 2) / n) * size * 0.35;
    parts.push(new THREE.IcosahedronGeometry(s, 4).translate(x, y, (rnd() - 0.5) * size * 0.4));
  }
  const m = new THREE.Mesh(mergeGeometries(parts), std('#ffffff', 0.95, { envMapIntensity: 0.7 }));
  m.castShadow = true;
  return m;
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
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), std('#ffffff', 0.85, { map: t }));
  m.castShadow = true;
  return m;
}

function atmosphere() {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: { c: { value: new THREE.Color('#7fd8ff') } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 c; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1. - abs(dot(vN, vV)), 2.2); float edge = smoothstep(0.0, 0.35, abs(dot(vN, vV))); gl_FragColor = vec4(c * f * edge * 0.45, 1.); }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1.05, 64, 48), mat);
}

export function buildGlobe(): Globe {
  seed = 7;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
  camera.position.set(0, 0.75, 6.9);
  camera.lookAt(0, 0.04, 0);

  const spinner = new THREE.Group();
  const planet = new THREE.Group();
  planet.add(buildOcean(), buildLand());
  spinner.add(planet);

  // ---- the hero island: tennis court in a sandy clearing, trees, houses, rocks
  const hero = ISLANDS[0];
  const courtDir = CLEARING.clone();
  const ct = court();
  place(ct, courtDir, heightAt(courtDir) - 0.004, 0.35);
  ct.scale.setScalar(0.27);
  spinner.add(ct);
  const avoid = [{ d: courtDir, r: 0.2 }];

  const extras: { d: THREE.Vector3; r: number }[] = [];
  const at = (lat: number, lon: number) => dir(lat, lon);
  // two houses and rocks on the hero island
  for (const [lat, lon, yaw, roof] of [
    [30, -20, 0.8, C.roof],
    [4, 22, -0.4, new THREE.Color('#ff8a3d')],
  ] as [number, number, number, THREE.Color][]) {
    const d = at(lat, lon);
    const hs = house(roof);
    place(hs, d, heightAt(d), yaw);
    hs.scale.setScalar(0.1);
    spinner.add(hs);
    extras.push({ d, r: 0.09 });
  }
  for (const [lat, lon, s] of [[2, -18, 0.035], [4, -14, 0.022], [34, 18, 0.03]]) {
    const d = at(lat, lon);
    const rk = rock();
    place(rk, d, heightAt(d) - 0.005, rnd() * 6);
    rk.scale.setScalar(s);
    spinner.add(rk);
    extras.push({ d, r: s * 1.6 });
  }

  // a wooden dock and a little boat off the hero island's left shore
  {
    const d = at(4, -34);
    const dock = new THREE.Group();
    const plank = std('#c98a52', 0.8);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 1.6).translate(0, 0.25, -0.8), plank);
    deck.castShadow = deck.receiveShadow = true;
    dock.add(deck);
    for (const [px, pz] of [[-0.22, -0.3], [0.22, -0.3], [-0.22, -1.2], [0.22, -1.2]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8).translate(px, 0.1, pz), plank);
      post.castShadow = true;
      dock.add(post);
    }
    place(dock, d, 1.0, Math.PI / 2 + 0.5);
    dock.scale.setScalar(0.06);
    spinner.add(dock);
    const bd = at(-4, -44);
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(0.55, 0.5, 1.2), std('#ef5a6f', 0.6));
    hull.rotation.x = Math.PI;
    hull.position.y = 0.2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 24).scale(0.55, 1.2, 1).rotateX(Math.PI / 2).translate(0, 0.2, 0), std('#ffffff', 0.6));
    hull.castShadow = rim.castShadow = true;
    boat.add(hull, rim);
    place(boat, bd, 1.0, 0.9);
    boat.scale.setScalar(0.07);
    spinner.add(boat);
  }

  // lighthouse on the island to the upper left, houses on others
  {
    const d = at(60, -52);
    const lh = lighthouse();
    place(lh, d, heightAt(d), 0);
    lh.scale.setScalar(0.075);
    spinner.add(lh);
    extras.push({ d, r: 0.08 });
  }
  for (const [lat, lon, yaw] of [[44, 86, 0.3], [-10, -86, 1.2], [-50, 48, 2], [8, 152, 0.5], [-20, -150, 1.9]]) {
    const d = at(lat, lon);
    const hs = house(rnd() < 0.5 ? C.roof : new THREE.Color('#ff8a3d'));
    place(hs, d, heightAt(d), yaw);
    hs.scale.setScalar(0.095);
    spinner.add(hs);
    extras.push({ d, r: 0.09 });
  }

  // forests: dense on every island
  const spots: { d: THREE.Vector3; s: number; pine: boolean }[] = [];
  ISLANDS.forEach((is, i) => {
    const n = Math.round(is.r * is.r * (i === 0 ? 420 : 300));
    spots.push(...treesOn(is, i === 0 ? Math.round(n * 0.6) : n, [...avoid, ...extras], i === 0 ? 0.3 : 0.45, i === 0 ? 1.15 : 1));
  });
  forest(spinner, spots);

  // clouds hugging the planet
  const cloudSpots: [number, number, number, number, number][] = [
    // lat, lon, height, size, puffs
    [50, 38, 1.2, 0.1, 5],
    [10, -58, 1.22, 0.085, 4],
    [-28, 64, 1.2, 0.09, 5],
    [-58, -48, 1.2, 0.075, 4],
    [78, -70, 1.18, 0.09, 5],
    [22, 98, 1.2, 0.08, 4],
    [-12, -104, 1.2, 0.08, 4],
    [-78, 110, 1.18, 0.07, 4],
    [35, 170, 1.2, 0.1, 5],
    [-40, 8, 1.2, 0.08, 5],
    [46, -18, 1.24, 0.06, 4],
  ];
  for (const [lat, lon, h, s, n] of cloudSpots) {
    const cl = cloud(n, s);
    const d = dir(lat, lon);
    place(cl, d, h, rnd() * 6);
    // lay clouds along the surface
    spinner.add(cl);
  }

  // the moon: a tennis ball on a tilted orbit
  const moonPivot = new THREE.Group();
  moonPivot.rotation.z = 0.35;
  moonPivot.rotation.x = 0.25;
  const moon = tennisBall();
  moon.scale.setScalar(0.1);
  moon.position.set(1.42, 0, 0);
  moonPivot.add(moon);
  scene.add(moonPivot);

  // tilt the planet a touch toward the camera so the hero island sits on the upper curve
  spinner.rotation.x = 0.05;
  scene.add(spinner);
  scene.add(atmosphere());

  // ---- light
  const key = new THREE.DirectionalLight('#fff1dc', 3.8);
  key.position.set(-4.5, 3.6, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -1.6;
  sc.right = sc.top = 1.6;
  sc.near = 1;
  sc.far = 14;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 6;
  scene.add(key);
  // pink bounce from below (clouds and undersides turn rosy, like the reference)
  scene.add(new THREE.HemisphereLight('#d8eeff', '#ff8fbf', 0.7));
  const rim = new THREE.DirectionalLight('#9fe4ff', 1.4);
  rim.position.set(3, 1, -4);
  scene.add(rim);

  const api: Globe = {
    scene,
    camera,
    spinner,
    moon,
    setSpin(t: number) {
      spinner.rotation.y = t * Math.PI * 2;
      moonPivot.rotation.y = -0.9 + t * Math.PI * 2 * 2;
    },
  };
  api.setSpin(0);
  return api;
}

/** Render one frame to a data URL (used by the render/bake scripts). */
export function renderGlobe(size: number, opts: { spin?: number; bg?: boolean } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const g = buildGlobe();
  const pm = new THREE.PMREMGenerator(renderer);
  g.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  g.scene.environmentIntensity = 0.28;
  if (opts.bg) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 512;
    const x = cv.getContext('2d')!;
    const gr = x.createRadialGradient(256, 256, 0, 256, 256, 360);
    gr.addColorStop(0, '#2aa6e8');
    gr.addColorStop(1, '#0b3f86');
    x.fillStyle = gr;
    x.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    g.scene.background = t;
  }
  g.setSpin(opts.spin ?? 0);
  renderer.render(g.scene, g.camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  return url;
}
