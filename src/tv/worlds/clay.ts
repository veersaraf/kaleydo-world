// CLAYLAND — stop-motion plasticine. Characters move "on twos" (12 fps),
// every surface carries the animator's fingerprints and thumb smears, the
// court is real clay that keeps ball marks, and a tilt-shift blur makes it a
// miniature.
//
// The set round the stadium is modelled in plasticine too: lumpy hills patched
// with fields, a village of squashed cottages with smoke puffing from the
// chimneys, lollipop trees, a windmill, clouds on the move. All of it moves on
// the players' 12 fps: one stepped clock drives the wind, the sails, the smoke
// and the clouds. And the scenery "boils": each new frame nudges its surfaces
// along their normals, as if the animator had touched the set again between
// shots.

import * as THREE from 'three';
import { FIRE_STYLE } from '../render/smashfx';

const cs = (a: string[]) => a.map((c) => new THREE.Color(c));
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { stringsMat } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass, makeRT, BLACK } from '../render/post';
import type { MatchEvent } from '../tennis/match';
import { Rng } from '../core/math';
import { Wind, motion, sway, swayDepth, type SwayOpts } from './park-env/wind';
import { Foliage, crownBlobs, clumpGeometry, bushBlobs, tintMask, type Place, type Tone } from './park-env/foliage';
import { landGeometry, bumpsAt, scatterBumps, smooth, type Bump } from './park-env/land';

/** the stop-motion frame: bumps once per 1/12 s (the marks shimmer, the scenery boils) */
const boil = { value: 0 };

const CLAY_NOISE = /* glsl */ `
float ch(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ch(i), ch(i + vec3(1,0,0)), f.x), mix(ch(i + vec3(0,1,0)), ch(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(ch(i + vec3(0,0,1)), ch(i + vec3(1,0,1)), f.x), mix(ch(i + vec3(0,1,1)), ch(i + vec3(1,1,1)), f.x), f.y), f.z); }`;

/**
 * Where the animator's hands have been, on one face (p in metres): cells of
 * about 30 cm, some holding a fingertip's print — a shallow oval dent pressed
 * in at a slant, faint looping ridges across it — some a thumb smear: a long
 * dent dragged one way, fine striations along it, the clay pushed up round
 * its end. Fine detail fades before it would shimmer. Returns a height (and,
 * in `print`, how much is fingertip: those are a little glossier).
 */
const MARKS = /* glsl */ `
float marksAt(vec2 p, out float print) {
  print = 0.0;
  vec2 c = floor(p * 3.3);
  vec2 f = fract(p * 3.3) - 0.5;
  float h = ch(vec3(c, 3.0));
  if (h < 0.5) return 0.0;
  float a = ch(vec3(c, 5.0)) * 6.2831;
  vec2 d = mat2(cos(a), -sin(a), sin(a), cos(a)) * (f - (vec2(ch(vec3(c, 1.0)), ch(vec3(c, 2.0))) - 0.5) * 0.3) / 3.3;
  if (h < 0.76) {
    vec2 e = d * vec2(1.0, 1.45);
    float r = length(e);
    float press = smoothstep(0.07, 0.02, r) * (0.5 + 0.5 * clamp(d.x * 16.0 + 0.5, 0.0, 1.0));
    float w = r * 240.0 + cn(vec3(e * 55.0, h * 7.0)) * 2.5;
    float ridges = sin(w) * (1.0 - smoothstep(0.8, 2.4, fwidth(w)));
    print = press;
    return -press * 0.28 + ridges * press * 0.07;
  }
  vec2 s = d * vec2(1.0, 3.4);
  float r = length(s);
  float end = clamp(d.x * 12.0 + 0.5, 0.0, 1.0);
  float dent = smoothstep(0.1, 0.0, r) * (0.4 + 0.6 * end);
  float st = d.y * 900.0;
  float lines = sin(st) * (1.0 - smoothstep(0.8, 2.4, fwidth(st))) * dent * 0.05;
  float rim = smoothstep(0.08, 0.11, r) * smoothstep(0.15, 0.11, r) * smoothstep(0.0, 0.05, d.x);
  return rim * 0.22 - dent * 0.35 + lines;
}`;

interface ClayOpts {
  rough?: number;
  /** strength of the lumps and marks in the normals */
  bump?: number;
  /** fingerprints and smears, 0..1 (quiet on the court's playing surface) */
  marks?: number;
  emissive?: THREE.ColorRepresentation;
  /** metres the surface boils along its normal from one stop-motion frame to the next (scenery only) */
  wobble?: number;
  vertexColors?: boolean;
  /** far off (the hills, distant trees): only the broad lumps, the fine ones would be under a pixel */
  far?: boolean;
}

/**
 * Plasticine: a rough standard material, its normals bent by soft lumps (which
 * shift a little every stop-motion frame) and by fingerprints and thumb smears
 * that stay where they were pressed. Marks are measured in metres on the object
 * (its own space, scaled as it is in the world), so they keep a thumb's size on
 * a pebble or a hill, and ride along when the object moves.
 */
function clay(color: THREE.ColorRepresentation, o: ClayOpts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.72, metalness: 0, emissive: o.emissive ?? 0x000000, vertexColors: !!o.vertexColors });
  const bump = { value: o.bump ?? 1 };
  const marks = { value: o.marks ?? 1 };
  const wob = { value: o.wobble ?? 0 };
  const boils = (o.wobble ?? 0) > 0;
  // (no marks at all: the land, the eyes — skip their code, it's per pixel)
  const marked = (o.marks ?? 1) > 0 && !o.far;
  const fine = !o.far;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBoil = boil;
    sh.uniforms.uBump = bump;
    sh.uniforms.uMarks = marks;
    sh.uniforms.uWob = wob;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\nvarying vec3 vObj;\nvarying vec3 vObjN;\nuniform float uBoil;\nuniform float uWob;\n${CLAY_NOISE}`).replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      {
        vec3 sc = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
        vec3 op = position;
        #ifdef USE_INSTANCING
          sc *= vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          // (each instance its own marks)
          op += instanceMatrix[3].xyz / max(sc, vec3(1e-3));
        #endif
        vObj = op * sc;
        vObjN = objectNormal;
        ${boils ? 'transformed += objectNormal * (cn(vObj * 1.6 + vec3(uBoil * 3.17)) - 0.5) * uWob;' : ''}
      }`,
    );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${marked ? '#define CLAY_MARKS' : ''}\n${fine ? '#define CLAY_FINE' : ''}\nvarying vec3 vObj;\nvarying vec3 vObjN;\nuniform float uBoil;\nuniform float uBump;\nuniform float uMarks;\n${CLAY_NOISE}\n${marked ? MARKS : ''}\nfloat clayPrint = 0.0;\nfloat clayHeight = 0.0;`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          // broad lumps (they also mottle the colour: plasticine is never quite one
          // colour), fine lumps that shift a little each frame, then the marks
          float n0 = cn(vObj * 2.6);
          float hh = n0 * 0.45;
          #ifdef CLAY_FINE
            hh += cn(vObj * 9.0 + uBoil * 0.09) * 0.4;
          #endif
          diffuseColor.rgb *= 0.95 + 0.1 * n0;
          #ifdef CLAY_MARKS
            vec3 an = abs(vObjN);
            vec2 fp = an.x > an.y && an.x > an.z ? vObj.yz : an.y > an.z ? vObj.xz + 13.1 : vObj.xy + 7.7;
            hh += marksAt(fp, clayPrint) * uMarks;
            clayPrint *= uMarks;
            // tiny bits of other clay rolled in
            vec3 cell = floor(vObj * 24.0);
            vec3 o = vec3(ch(cell), ch(cell + 7.1), ch(cell + 3.3));
            float speck = step(0.94, ch(cell + 11.0)) * (1.0 - smoothstep(0.07, 0.11, length(fract(vObj * 24.0) - o)));
            diffuseColor.rgb *= 1.0 - speck * vec3(0.18, 0.24, 0.1);
          #endif
          clayHeight = hh * 0.02 * uBump;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= 1.0 - 0.18 * clayPrint;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        {
          float hh = clayHeight;
          vec3 sp = -vViewPosition;
          vec3 sx = dFdx(sp), sy = dFdy(sp);
          float dx = dFdx(hh), dy = dFdy(hh);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dx * r1 + dy * r2);
          normal = normalize(abs(det) * normal - grad);
        }`,
      );
  };
  m.customProgramCacheKey = () => `clay-${boils}-${marked}-${fine}`;
  return m;
}

function lumpy(geo: THREE.BufferGeometry, amt: number, freq = 1.5, seed = 0) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const n = Math.sin(x * freq + seed) * Math.cos(y * freq * 1.3 + seed * 2) * Math.sin(z * freq * 0.9 + seed * 3);
    const l = Math.hypot(x, y, z) || 1;
    const k = 1 + n * amt;
    pos.setXYZ(i, (x / l) * l * k, (y / l) * l * k, (z / l) * l * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A piece for a merged, vertex-coloured model: lumpy, coloured, tinted by its instance or not. */
function piece(g: THREE.BufferGeometry, c: THREE.Color, tint = 0, lump = 0.04, seed = 0) {
  g.deleteAttribute('uv');
  lumpy(g, lump, 2.2, seed);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
  return g.index ? g.toNonIndexed() : g;
}

const TILT = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir; uniform vec2 uRes; uniform float uFocus; uniform float uSpread;
varying vec2 vUv;
void main() {
  // keep the whole court sharp: blur the sky/background above, and only the very bottom edge
  float r = (smoothstep(uFocus, uFocus + 0.28, vUv.y) + smoothstep(0.07, 0.0, vUv.y) * 0.6) * uSpread;
  // the sharp band (most of the court) needs no blur: skip the 13 taps
  if (r < 0.02) { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); return; }
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    acc += texture2D(tSrc, vUv + uDir * fi * r / uRes).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;

/** A plasticine sky: the backdrop's gradient, smoothed on with broad thumb strokes. */
const SKY_VERT = /* glsl */ `varying vec3 vDir; void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop, uHorizon;
varying vec3 vDir;
${CLAY_NOISE}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = mix(uHorizon, uTop, smoothstep(-0.02, 0.55, d.y));
  float a = atan(d.x, d.z);
  float strokes = sin(a * 7.0 + d.y * 11.0 + sin(a * 2.3) * 2.2) * 0.5 + 0.5;
  col *= 0.965 + 0.06 * strokes * cn(d * 5.0);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- the land

const VILLAGE_HILL: Bump = { x: 0, z: -150, r: 86, h: 21 };
const MILL_HILL: Bump = { x: -76, z: -98, r: 44, h: 15 };

function landBumps() {
  const r = new Rng(777);
  const rand = () => r.next();
  return [
    VILLAGE_HILL,
    MILL_HILL,
    ...scatterBumps(rand, 20, { r: [100, 190], a: [-Math.PI * 1.05, 0.05], size: [30, 58], h: [6, 18] }),
    ...scatterBumps(rand, 12, { r: [95, 185], a: [0.1, Math.PI - 0.1], size: [28, 50], h: [3, 8] }),
    ...scatterBumps(rand, 20, { r: [290, 410], size: [60, 120], h: [28, 62] }),
  ];
}

/** the scenery's clock: whole stop-motion frames */
const stepped = (t: number) => Math.floor(t * 12) / 12;

const TREE_SWAY: SwayOpts = { amp: 0.14, height: 6, flutter: 0.0 };

class ClayWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'strings') return stringsMat(new THREE.Color('#fff8ea'));
      if (role === 'eye') return clay('#1a1410', { rough: 0.25, bump: 0.2, marks: 0 });
      if (role === 'eyeWhite') return clay('#ffffff', { rough: 0.3, bump: 0.2, marks: 0 });
      if (role === 'cheek') return clay('#ff8f8f', { bump: 0.4, marks: 0 });
      return clay(c, { marks: 0.8 });
    },
    outline: null,
    castShadow: true,
    shadowColor: new THREE.Color('#3a2418'),
    shadowOpacity: 0.25,
  };

  private stepAcc = 0;
  private lastPoses: import('../chars/pose').Pose[] | null = null;
  private sunFace!: THREE.Group;
  private snail!: THREE.Group;
  private marks: THREE.Mesh[] = [];
  private markMat!: THREE.MeshBasicMaterial;
  private rtA!: THREE.WebGLRenderTarget;
  private rtB!: THREE.WebGLRenderTarget;
  private tilt!: Pass;
  /** the set's breeze, ticked on whole frames */
  private wind = new Wind(1, 0.35, 1);
  private rng = new Rng(20260929);
  private bumps = landBumps();
  private foliage!: Foliage;
  private sails!: THREE.Object3D;
  private clouds!: THREE.Group;
  private cloudMesh!: THREE.InstancedMesh;
  private smoke!: THREE.InstancedMesh;
  /** instanced scenery the detail level thins (with full counts) */
  private optional: [THREE.InstancedMesh, number][] = [];

  protected build() {
    // a smash on clay: it gouges the court and throws up a cloud of brick dust
    this.smashStyle = { ...FIRE_STYLE, ring: new THREE.Color('#fff4dc'), scorch: new THREE.Color('#5a2410'), scorchAlpha: 0.58, dust: cs(['#d4683c', '#e28a5a', '#c65a30']), dustShape: 'soft' };
    const s = this.scene;
    s.background = new THREE.Color('#9fd4f0');
    s.fog = new THREE.Fog('#bfe3f3', 80, 520);
    const key = new THREE.DirectionalLight('#ffe3c4', 3.2);
    key.position.set(-14, 22, 12);
    key.castShadow = true;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.04;
    s.add(key, key.target);
    s.add(new THREE.HemisphereLight('#cfe8ff', '#a2764f', 1.2));
    const rim = new THREE.DirectionalLight('#b8d8ff', 1.1);
    rim.position.set(10, 8, -20);
    s.add(rim);

    // the backdrop: a sky smoothed on in plasticine
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 16),
      new THREE.ShaderMaterial({ uniforms: { uTop: { value: new THREE.Color('#79bfe8') }, uHorizon: { value: new THREE.Color('#cdeaf6') } }, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.name = 'sky';
    s.add(sky);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(62, 64), clay('#7fc66b', { bump: 2 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    s.add(ground);

    this.buildCourt({
      inner: clay('#d4683c', { bump: 1.5, marks: 0.3 }),
      outer: clay('#c55f36', { bump: 1.5, marks: 0.3 }),
      line: clay('#fbf3e6', { bump: 0.5, marks: 0.2 }),
      innerPad: { x: 1.3, z: 2.2 },
      outerSize: { x: 10.8, z: 18.8 },
      lineWidth: 0.085,
      wobble: 0.02,
      receiveShadow: true,
    });
    this.buildNet({
      post: clay('#2f5b8f'),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#f6f0e6'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 }),
      band: clay('#ffffff'),
    });

    const ballMat = clay('#dff04a', { bump: 2, marks: 0.4 });
    this.buildBall(ballMat, { color: new THREE.Color('#fff6d8'), width: 0.06, opacity: 0.55, length: 16 }, new THREE.Color('#3a2418'), 0.45);
    this.buildParticles();
    this.markMat = new THREE.MeshBasicMaterial({ color: '#8a3a1c', transparent: true, opacity: 0.55, depthWrite: false });

    this.foliage = new Foliage(this.wind, {
      material: (p) => clay('#ffffff', { vertexColors: p.vertexColors, rough: p.roughness, bump: 2.2, wobble: 0.035 }),
      tree: TREE_SWAY,
      bush: { amp: 0.04, height: 1.1 },
      shadows: true,
    });
    this.buildLand();
    this.buildScenery();
    this.buildVillage();
    this.buildTrees();
    this.buildSky();
    this.buildStands();

    this.rtA = makeRT(1, 1);
    this.rtB = makeRT(1, 1);
    this.tilt = new Pass(TILT, { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uRes: { value: new THREE.Vector2(1, 1) }, uFocus: { value: 0.6 }, uSpread: { value: 3.4 } });
    const f = this.final.u;
    f.uSat.value = 1.12;
    f.uContrast.value = 1.06;
    f.uGain.value.set(1.04, 1.0, 0.94);
    f.uVignette.value = 0.32;
    f.uGrain.value = 0.02;
    f.uTonemap.value = 1;
    f.uExposure.value = 1.15;

    this.effects = {
      // where the puppets' feet press into the set
      contact: { strength: 0.5, color: new THREE.Color('#4a2e1e') },
      grade: { lut: filmGrade },
      // the court, the stands and the plasticine round them
      shadow: { light: key, area: new THREE.Box3(new THREE.Vector3(-26, 0, -30), new THREE.Vector3(26, 7, 22)), softness: 0.1 },
      dof: true,
    };
  }

  /** The ground's height at (x, z): flat round the stadium, lumpy hills beyond. */
  private landAt(x: number, z: number) {
    const r = Math.hypot(x, z);
    const rise = smooth(64, 104, r);
    // plasticine is never smooth: small lumps all over the hills
    const lumps = Math.sin(x * 0.21 + 1.1) * Math.sin(z * 0.19 - 0.4) * 0.9 + Math.sin(x * 0.53 + z * 0.37) * 0.35;
    return -0.08 + rise * (bumpsAt(this.bumps, x, z) + lumps);
  }

  /**
   * The hills: one lumpy heightfield in plasticine, patched with fields of
   * other colours rolled flat into it (the patches soft-edged, as smeared clay
   * is), white clay on the mountain tops.
   */
  private buildLand() {
    const lawn = new THREE.Color('#7fc66b');
    const greens = ['#6cbf5f', '#5fb357', '#86cc6e', '#79c766', '#58a852'].map((c) => new THREE.Color(c));
    const fields = ['#c9d86a', '#e0c070', '#a9855a', '#a7d77a', '#d9e6a0', '#e8a0b8'].map((c) => new THREE.Color(c));
    const snow = new THREE.Color('#fbf8f2');
    const k = new THREE.Color();
    const geo = landGeometry(
      (x, z) => this.landAt(x, z),
      (x, z, h, _up, out) => {
        const r = Math.hypot(x, z);
        // patches of other clay pressed into the hills: fields on a turned grid
        const u = x * 0.9 + z * 0.43,
          v = -x * 0.43 + z * 0.9;
        const hs = Math.abs(Math.sin(Math.floor(u / 15) * 127.1 + Math.floor(v / 10) * 311.7) * 43758.5453) % 1;
        out.copy(greens[Math.floor(hs * greens.length)]);
        if (hs > 0.58) out.copy(fields[Math.floor(((hs - 0.58) / 0.42) * fields.length) % fields.length]);
        // plain lawn by the stadium, fields on the hills
        out.lerp(lawn, 1 - smooth(78, 110, r));
        // far hills bluer, the peaks white
        out.lerp(k.set('#8fb8c8'), smooth(220, 420, r) * 0.55);
        out.lerp(snow, smooth(44, 54, h));
      },
      { r0: 60, r1: 460, rings: 50, segs: 180, bias: 1.8 },
    );
    // (no marks: from the stadium a thumbprint on the hills is smaller than a pixel)
    const land = new THREE.Mesh(geo, clay('#ffffff', { vertexColors: true, bump: 3, far: true }));
    land.receiveShadow = false;
    land.name = 'land';
    this.scene.add(land);
  }

  private buildScenery() {
    const s = this.scene;
    const r = this.rng;
    // clay sun with a face
    this.sunFace = new THREE.Group();
    const sun = new THREE.Mesh(lumpy(new THREE.SphereGeometry(9, 40, 30), 0.03, 2), clay('#ffcf3a', { emissive: '#7a4a00', bump: 3, wobble: 0.12 }));
    this.sunFace.add(sun);
    for (const x of [-3, 3]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), clay('#3a2418'));
      eye.scale.set(0.9, 1.3, 0.6);
      eye.position.set(x, 1.8, 8.4);
      this.sunFace.add(eye);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.55, 10, 24, Math.PI), clay('#3a2418'));
    smile.rotation.z = Math.PI;
    smile.position.set(0, -0.8, 8.2);
    this.sunFace.add(smile);
    for (const x of [-5.6, 5.6]) {
      const ch = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 10), clay('#ff8a6a'));
      ch.scale.z = 0.4;
      ch.position.set(x, -1.2, 7.6);
      this.sunFace.add(ch);
    }
    this.sunFace.position.set(-48, 62, -175);
    this.sunFace.lookAt(0, 10, 20);
    s.add(this.sunFace);
    // mushrooms and flowers round the stands
    const stem = clay('#fff2de', { wobble: 0.02 });
    const capColors = ['#e84a3c', '#f29c38', '#b26bdb'].map((c) => clay(c, { wobble: 0.025 }));
    const dot = clay('#ffffff');
    const mush = (x: number, z: number, sc: number) => {
      const g = new THREE.Group();
      const st = new THREE.Mesh(lumpy(new THREE.CylinderGeometry(0.5, 0.7, 2, 14), 0.05), stem);
      st.position.y = 1;
      const cap = new THREE.Mesh(lumpy(new THREE.SphereGeometry(1.6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), 0.06, 3), r.pick(capColors));
      cap.position.y = 1.8;
      g.add(st, cap);
      for (let k = 0; k < 6; k++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), dot);
        const a = r.range(0, Math.PI * 2);
        const e = r.range(0.3, 1.2);
        d.position.set(Math.cos(a) * e * 1.3, 1.8 + Math.sqrt(Math.max(0, 1 - e * e * 0.6)) * 1.4, Math.sin(a) * e * 1.3);
        d.scale.y = 0.5;
        g.add(d);
      }
      g.traverse((o) => (o.castShadow = true));
      g.position.set(x, 0, z);
      g.scale.setScalar(sc);
      s.add(g);
    };
    const flowerCols = ['#ff5a7a', '#ffd23a', '#7a8cff', '#ff9a3a', '#ffffff'].map((c) => clay(c));
    const flowerStem = clay('#3f9a4a');
    const flowerMid = clay('#ffd23a');
    const flower = (x: number, z: number) => {
      const g = new THREE.Group();
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1, 6), flowerStem);
      st.position.y = 0.5;
      g.add(st);
      const pm = r.pick(flowerCols);
      for (let k = 0; k < 5; k++) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), pm);
        const a = (k / 5) * Math.PI * 2;
        p.position.set(Math.cos(a) * 0.22, 1.05, Math.sin(a) * 0.22);
        p.scale.set(1, 0.5, 1);
        g.add(p);
      }
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), flowerMid);
      c.position.y = 1.1;
      g.add(c);
      g.position.set(x, 0, z);
      s.add(g);
    };
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      mush(side * r.range(18, 24), r.range(-30, 8), r.range(0.6, 1.2));
    }
    for (let i = 0; i < 60; i++) {
      const side = i % 2 ? 1 : -1;
      flower(side * r.range(17, 27), r.range(-34, 14));
    }
    // the snail
    this.snail = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.32, 12, 24), clay('#e8883a'));
    shell.position.y = 0.75;
    const shell2 = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), clay('#f2a654'));
    shell2.position.set(0, 0.75, 0.05);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.2, 6, 10), clay('#9fd88a'));
    body.rotation.z = Math.PI / 2;
    body.position.set(-0.2, 0.22, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), clay('#9fd88a'));
    head.position.set(-0.85, 0.42, 0);
    this.snail.add(shell, shell2, body, head);
    for (const z of [-0.1, 0.1]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), clay('#9fd88a'));
      st.position.set(-0.95, 0.72, z);
      st.rotation.z = 0.3;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), clay('#1a1410'));
      eye.position.set(-1.02, 0.95, z);
      this.snail.add(st, eye);
    }
    this.snail.traverse((o) => (o.castShadow = true));
    this.snail.scale.setScalar(1.3);
    s.add(this.snail);
    // (it crawls through where the ballpark's left-field fence stands)
    this.snail.userData.noBatch = true;
    this.notBaseball.push(this.snail);
    this.buildWindmill();
  }

  /** A windmill of rolled clay on its hill, its sails turning a notch each frame. */
  private buildWindmill() {
    const x = MILL_HILL.x,
      z = MILL_HILL.z;
    const g = new THREE.Group();
    g.position.set(x, this.landAt(x, z) - 0.5, z);
    g.rotation.y = Math.atan2(-x, -z);
    const tower = new THREE.Mesh(lumpy(new THREE.CylinderGeometry(2.4, 3.4, 11, 12, 4), 0.05, 1.2, 3).translate(0, 5.5, 0), clay('#f2e6cf', { bump: 2.5, wobble: 0.05 }));
    const cap = new THREE.Mesh(lumpy(new THREE.ConeGeometry(3.1, 3.6, 12, 2), 0.06, 1.4, 5).translate(0, 12.6, 0), clay('#c8553d', { bump: 2.5, wobble: 0.05 }));
    const door = new THREE.Mesh(lumpy(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0.05).scale(0.75, 1.5, 0.3).translate(0, 0, 3.25), clay('#6b4a32'));
    g.add(tower, cap, door);
    const parts: THREE.BufferGeometry[] = [lumpy(new THREE.SphereGeometry(0.6, 12, 8), 0.06)];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const arm = lumpy(new THREE.BoxGeometry(0.35, 8, 0.3, 1, 6, 1), 0.02, 3, k).translate(0, 4.2, 0);
      const sail = lumpy(new THREE.BoxGeometry(1.8, 6, 0.18, 3, 6, 1), 0.015, 3, k + 4).translate(1.05, 4.9, 0.04);
      parts.push(arm.rotateZ(a), sail.rotateZ(a));
    }
    for (const p of parts) p.deleteAttribute('uv');
    this.sails = new THREE.Mesh(mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!, clay('#fff6e6', { bump: 2, wobble: 0.04 }));
    this.sails.position.set(0, 11.4, 3.4);
    this.sails.castShadow = false;
    g.add(this.sails);
    g.traverse((o) => (o.castShadow = false));
    this.scene.add(g);
  }

  /**
   * A village of squashed clay cottages up the hill behind the far stand
   * (instanced: walls tinted per cottage, roofs and chimneys their own colour),
   * with smoke puffing from the chimneys — balls of grey clay that swell as they
   * rise, then shrink away (clay can't fade), a notch each frame.
   */
  private buildVillage() {
    const r = this.rng;
    const walls = ['#fff1dc', '#ffd8c8', '#dcecff', '#fff0a8', '#e2f5d8', '#f6d8ff'].map((c) => new THREE.Color(c));
    const W = new THREE.Color(1, 1, 1);
    const cottage = (roof: THREE.Color, thatch: boolean) => {
      const parts = [
        piece(new THREE.BoxGeometry(1, 0.8, 0.9, 3, 3, 3).translate(0, 0.4, 0), W, 1, 0.05, 1),
        thatch
          ? piece(new THREE.SphereGeometry(0.75, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.7, 0.95).translate(0, 0.78, 0), roof, 0, 0.06, 2)
          : piece(new THREE.CylinderGeometry(0.02, 0.72, 0.62, 4, 2).rotateY(Math.PI / 4).scale(1.05, 1, 0.95).translate(0, 1.1, 0), roof, 0, 0.05, 2),
        piece(new THREE.BoxGeometry(0.16, 0.5, 0.16, 1, 2, 1).translate(0.28, 1.25, -0.12), new THREE.Color('#b86a4a'), 0, 0.04, 3),
        piece(new THREE.BoxGeometry(0.22, 0.4, 0.06, 1, 2, 1).translate(-0.18, 0.2, 0.46), new THREE.Color('#6b4a32'), 0, 0.03, 4),
        piece(new THREE.BoxGeometry(0.2, 0.18, 0.06).translate(0.24, 0.5, 0.46), new THREE.Color('#9fd3f0'), 0, 0.02, 5),
      ];
      const g = mergeGeometries(parts)!;
      parts.forEach((p) => p.dispose());
      return g;
    };
    const kinds = [cottage(new THREE.Color('#c8553d'), false), cottage(new THREE.Color('#e0b25a'), true), cottage(new THREE.Color('#5a7ec8'), false)];
    const spots: { x: number; z: number; y: number; s: number; yaw: number; kind: number }[] = [];
    const clear = (x: number, z: number, d: number) => spots.every((p) => Math.hypot(p.x - x, p.z - z) > d);
    for (let row = 0; row < 5; row++) {
      const z = -100 - row * 8;
      const half = 26 + row * 5;
      for (let x = -half + (row % 2) * 4; x <= half; x += r.range(8, 11)) {
        const px = x + r.range(-1.5, 1.5),
          pz = z + r.range(-1.5, 1.5);
        const s = r.range(5, 6.8);
        if (!clear(px, pz, s)) continue;
        const y = Math.min(this.landAt(px - s / 2, pz), this.landAt(px + s / 2, pz), this.landAt(px, pz - s / 2), this.landAt(px, pz + s / 2)) - 0.3;
        spots.push({ x: px, z: pz, y, s, yaw: Math.atan2(-px, -pz) + r.range(-0.2, 0.2), kind: r.int(0, 2) });
      }
    }
    // and farms dotted over the hills round about (the far end's view, the wide shots)
    for (let i = 0; i < 14; i++) {
      const a = r.range(-Math.PI, Math.PI);
      const d = r.range(84, 150);
      const px = Math.cos(a) * d,
        pz = Math.sin(a) * d;
      if ((Math.abs(px) < 60 && pz < -90) || Math.hypot(px - MILL_HILL.x, pz - MILL_HILL.z) < 16) continue;
      const s = r.range(5, 6.5);
      if (!clear(px, pz, s + 4)) continue;
      const y = Math.min(this.landAt(px - s / 2, pz), this.landAt(px + s / 2, pz), this.landAt(px, pz - s / 2), this.landAt(px, pz + s / 2)) - 0.3;
      spots.push({ x: px, z: pz, y, s, yaw: Math.atan2(-px, -pz) + r.range(-0.3, 0.3), kind: r.int(0, 2) });
    }
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    const mat = tintMask(clay('#ffffff', { vertexColors: true, bump: 2.5, wobble: 0.06 }));
    const chimneys: THREE.Vector3[] = [];
    kinds.forEach((geo, k) => {
      const list = spots.filter((p) => p.kind === k);
      if (!list.length) return;
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(UP, p.yaw);
        m.setMatrixAt(i, M.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.s, p.s * r.range(0.9, 1.15), p.s)));
        m.setColorAt(i, r.pick(walls));
        // the chimney's top, turned with the cottage
        chimneys.push(new THREE.Vector3(0.28, 1.5, -0.12).multiplyScalar(p.s).applyAxisAngle(UP, p.yaw).add(new THREE.Vector3(p.x, p.y, p.z)));
      });
      m.computeBoundingSphere();
      m.receiveShadow = false;
      m.name = 'village';
      this.scene.add(m);
    });
    // smoke: four puffs per chimney (every other cottage's fire is lit)
    const lit = chimneys.filter((_, i) => i % 2 === 0);
    const puffs = 4;
    this.smoke = new THREE.InstancedMesh(
      lumpy(new THREE.SphereGeometry(0.55, 10, 8), 0.12, 3),
      motion(clay('#e9e4dc', { bump: 2, wobble: 0.05 }), 'clay-smoke', { uTime: this.wind.u.uTime }, 'uniform float uTime;\nattribute float aPuff;', /* glsl */ `
        // up from the chimney, swelling then shrinking away, drifting downwind
        float t = fract(uTime * 0.16 + aPuff);
        float grow = sin(t * 3.14159) * (0.7 + 0.5 * t);
        mvPosition.xyz = io + (mvPosition.xyz - io) * max(grow, 0.001) + vec3(t * t * 3.0, t * 5.0, t * 1.2);`),
      lit.length * puffs,
    );
    const phase = new Float32Array(lit.length * puffs);
    lit.forEach((c, i) => {
      for (let k = 0; k < puffs; k++) {
        this.smoke.setMatrixAt(i * puffs + k, M.makeTranslation(c.x, c.y, c.z));
        phase[i * puffs + k] = k / puffs + (i * 0.37) % 1;
      }
    });
    this.smoke.geometry.setAttribute('aPuff', new THREE.InstancedBufferAttribute(phase, 1));
    this.smoke.computeBoundingSphere();
    this.smoke.boundingSphere!.radius += 8;
    this.smoke.name = 'smoke';
    this.scene.add(this.smoke);
  }

  /** Lollipop trees in lumpy clay, rocking in the stepped wind: round the stadium and over the hills. */
  private buildTrees() {
    const r = this.rng;
    const f = this.foliage;
    const leaf = ['#58b04e', '#7bc65a', '#3f9a4a', '#8fcf5a', '#4fa86a'].map((c) => new THREE.Color(c));
    const autumn = ['#f2a03a', '#e86a3a'].map((c) => new THREE.Color(c));
    const tone: Tone = { low: new THREE.Color(0.8, 0.86, 0.9), high: new THREE.Color(1.08, 1.06, 0.95) };
    const crown = (kind: 'round' | 'wide', seed: number, seg: number) => f.treeGeometry(clumpGeometry(crownBlobs(kind, seed), { seed, seg, lumpy: 0.16, lean: 0.55, tone }));
    const geos = { round: [crown('round', 5, 8), crown('round', 5, 5)], wide: [crown('wide', 9, 8), crown('wide', 9, 5)] };
    const near = { round: [] as Place[], wide: [] as Place[] };
    const far = { round: [] as Place[], wide: [] as Place[] };
    const put = (set: typeof near, kind: 'round' | 'wide', x: number, z: number, s: number, y = 0) => set[kind].push({ x, z, y, s: s * r.range(0.9, 1.1), sy: r.range(0.9, 1.15), yaw: r.range(0, 6.3), color: r.chance(0.15) ? r.pick(autumn) : r.pick(leaf) });
    // round the stadium (the old set's places, a little denser)
    for (let i = 0; i < 30; i++) {
      const side = i % 2 ? 1 : -1;
      put(near, r.chance(0.7) ? 'round' : 'wide', side * r.range(24, 54), r.range(-72, 6), r.range(1, 1.6));
    }
    // behind the far stand, seen above it
    for (let i = 0; i < 9; i++) put(near, 'round', -36 + i * 9 + r.range(-2, 2), r.range(-34, -44), r.range(1.2, 1.5));
    // woods over the hills, never over the village or the mill
    for (let c = 0; c < 24; c++) {
      const a = r.range(-Math.PI, Math.PI);
      const d = r.range(70, 180);
      const cx = Math.cos(a) * d,
        cz = Math.sin(a) * d;
      if (Math.abs(cx) < 55 && cz < -88 && cz > -150) continue;
      if (Math.hypot(cx - MILL_HILL.x, cz - MILL_HILL.z) < 14) continue;
      const n = r.int(3, 6);
      for (let k = 0; k < n; k++) {
        const x = cx + r.range(-9, 9),
          z = cz + r.range(-9, 9);
        if (Math.hypot(x, z) < 66) continue;
        put(far, r.chance(0.6) ? 'round' : 'wide', x, z, r.range(1.2, 1.7), this.landAt(x, z) - 0.2);
      }
    }
    const depth = swayDepth(this.wind, 'canopy', TREE_SWAY);
    // over the hills a thumbprint is under a pixel: broad lumps only
    const farLeaf = sway(tintMask(clay('#ffffff', { vertexColors: true, bump: 2.2, far: true, wobble: 0.035 }), 'aLeaf'), this.wind, 'canopy', TREE_SWAY);
    for (const k of ['round', 'wide'] as const) {
      if (near[k].length) f.add(geos[k][0], f.leaf, near[k], { shadow: depth });
      if (far[k].length) this.optional.push([f.add(geos[k][1], farLeaf, far[k], { receive: false }), far[k].length]);
    }
    // hedges of lumpy bushes along the backs of the side stands
    const bushes: Place[] = [];
    for (const sx of [-1, 1]) for (let i = 0; i < 18; i++) bushes.push({ x: sx * 17.4, z: -22 + i * 2.5 + r.range(-0.3, 0.3), s: r.range(1.1, 1.5), sy: r.range(0.9, 1.2), yaw: r.range(0, 6.3), color: r.pick(leaf) });
    f.add(clumpGeometry(bushBlobs(3), { seed: 3, seg: 8, lumpy: 0.16, lean: 0.6, tone }), f.shrub, bushes, { shadow: null });
    this.scene.add(f.group);
  }

  /** Clay clouds (one instanced draw) drifting round the set a notch at a time. */
  private buildSky() {
    const r = this.rng;
    const parts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 6; k++) {
      const s = k === 2 ? 4.2 : r.range(2.6, 3.6);
      parts.push(lumpy(new THREE.SphereGeometry(s, 11, 8), 0.08, 3, k).translate((k - 2.5) * 3.4 + r.range(-0.6, 0.6), r.range(0, 1.5) + (k === 2 || k === 3 ? 1.6 : 0), r.range(-1, 1)));
    }
    for (const p of parts) p.deleteAttribute('uv');
    const cloud = mergeGeometries(parts)!.scale(1, 0.72, 0.8);
    const n = 16;
    this.cloudMesh = new THREE.InstancedMesh(cloud, clay('#ffffff', { bump: 3, wobble: 0.15 }), n);
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.range(-0.15, 0.15);
      const d = r.range(150, 260);
      const sc = r.range(1.1, 1.9);
      this.cloudMesh.setMatrixAt(i, M.compose(new THREE.Vector3(Math.cos(a) * d, r.range(40, 72), Math.sin(a) * d), q.setFromAxisAngle(UP, -a + Math.PI / 2), new THREE.Vector3(sc, sc, sc)));
    }
    this.cloudMesh.frustumCulled = false;
    this.cloudMesh.castShadow = false;
    this.clouds = new THREE.Group();
    this.clouds.add(this.cloudMesh);
    this.clouds.userData.noBatch = true;
    this.clouds.name = 'clouds';
    this.scene.add(this.clouds);
  }

  private buildStands() {
    const stands: Stand[] = [];
    const cols = ['#e2d6c3', '#d7c8b2'].map((c) => clay(c, { bump: 2 }));
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.55 + r * 0.55;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), cols[r % 2]);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        st.castShadow = true;
        st.receiveShadow = true;
        g.add(st);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    mk(-10.8, 0, -Math.PI / 2, 22, 6);
    mk(10.8, 0, Math.PI / 2, 22, 6);
    mk(0, -19.5, Math.PI, 16, 6);
    // the crowd are clay too: their bob (crowd.ts) replaces the material's patch, so
    // put the clay back under it
    const bodyMat = clay('#ffffff', { bump: 2, marks: 0.7 });
    const headMat = clay('#ffffff', { bump: 2, marks: 0.7 });
    const clayPatch = [bodyMat.onBeforeCompile, headMat.onBeforeCompile];
    const crowd = new Crowd({
      stands,
      density: 0.95,
      bodyMat,
      headMat,
      shirts: ['#e84a3c', '#3a8ce8', '#f2c438', '#58b04e', '#b26bdb', '#ff8a4a'].map((c) => new THREE.Color(c)),
      skins: ['#ffd9b8', '#e8b48a', '#b07a52', '#7a4e32', '#9fd88a', '#a8c8ff'].map((c) => new THREE.Color(c)),
      fill: 0.85,
    });
    [bodyMat, headMat].forEach((m, i) => {
      const bob = m.onBeforeCompile;
      m.onBeforeCompile = (sh, rr) => {
        clayPatch[i].call(m, sh, rr);
        bob.call(m, sh, rr);
      };
      m.customProgramCacheKey = () => 'clay-crowd';
    });
    crowd.bodies.castShadow = true;
    this.addCrowd(crowd);
  }

  // stop-motion: characters pose at 12 fps
  update(v: FrameView) {
    this.stepAcc += v.realDt;
    const tick = this.stepAcc >= 1 / 12 || !this.lastPoses;
    if (tick) {
      this.stepAcc %= 1 / 12;
      boil.value = (boil.value + 1) % 64;
      this.lastPoses = v.poses.map((p) => JSON.parse(JSON.stringify(p)));
    }
    super.update({ ...v, poses: this.lastPoses! });
  }

  protected animate(v: FrameView) {
    // everything on the set moves on whole frames, as the puppets do
    const t = stepped(v.realT);
    this.wind.tick(t);
    this.sunFace.rotation.z = Math.sin(t * 0.6) * 0.05;
    this.sails.rotation.z = -t * 0.8;
    this.clouds.rotation.y = t * 0.006;
    const u = (t * 0.02) % 1;
    this.snail.position.set(-9.6, 1.12, 16 - u * 32);
    this.snail.rotation.y = Math.PI / 2;
    // fade old ball marks
    for (const m of this.marks) (m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (m.userData.life -= v.realDt) / 20) * 0.5;
  }

  protected onDetail(d: number) {
    const k = Math.min(1, 0.35 + 0.65 * d);
    for (const [m, n] of this.optional) m.count = Math.round(n * k);
    this.cloudMesh.count = Math.round(16 * (0.4 + 0.6 * d));
    this.smoke.visible = d > 0.3;
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    const cols = (a: string[]) => a.map((c) => new THREE.Color(c));
    if (e.type === 'bounce' && e.impact > 1.5 && Math.abs(e.pos.x) < 12 && Math.abs(e.pos.z) < 20) {
      // a ball mark in the clay
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), this.markMat.clone());
      m.rotation.x = -Math.PI / 2;
      m.scale.set(1, 1.9, 1);
      m.position.set(e.pos.x, 0.012, e.pos.z);
      m.userData.life = 20;
      this.scene.add(m);
      this.marks.push(m);
      if (this.marks.length > 40) {
        const old = this.marks.shift()!;
        this.scene.remove(old);
        old.geometry.dispose();
      }
      P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 8, speed: [0.8, 2.4], dir: [0, 1, 0], spread: 0.9, life: [0.4, 0.8], size: [0.06, 0.12], colors: cols(['#d4683c', '#e28a5a']), shape: 'soft', gravity: 8, ground: true });
    }
    if (e.type === 'hit') {
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: e.perfect ? 14 : 6, speed: [1.5, 4], life: [0.3, 0.6], size: [0.1, 0.18], colors: cols(['#ffffff', '#ffe98a']), shape: 'soft', drag: 3 });
    }
    if (e.type === 'point') {
      P.burst({ x: 0, y: 7, z: e.winner === 0 ? 6 : -6, count: 80, speed: [3, 8], dir: [0, 1, 0], spread: 0.9, life: [2, 3.5], size: [0.15, 0.25], colors: cols(['#e84a3c', '#3a8ce8', '#f2c438', '#58b04e', '#b26bdb']), shape: 'confetti', gravity: 3, spin: 10, ground: true });
    }
  }

  protected onResize(W: number, H: number) {
    this.rtA.setSize(W, H);
    this.rtB.setSize(W, H);
    this.tilt.u.uRes.value.set(W, H);
  }

  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    // (the effects' passes read the scene's depth only when one of them runs)
    this.sceneRT.resolveDepthBuffer = !!this.post?.plan(cam);
    r.setRenderTarget(this.sceneRT);
    r.setClearColor('#9fd4f0', 1);
    r.clear();
    r.render(this.scene, cam);
    r.setClearColor(0x000000, 1);
    this.post?.render(r, this.sceneRT, cam);
    // tilt-shift: two directional blurs that grow away from the focus band
    const u = this.tilt.u;
    // (at bat the pitch comes in from high up the screen, and the ball flies up there: keep it sharp)
    u.uFocus.value = this.sport === 'baseball' ? 0.9 : 0.6;
    u.tSrc.value = this.sceneRT.texture;
    u.uDir.value.set(1, 0);
    this.tilt.render(r, this.rtA);
    u.tSrc.value = this.rtA.texture;
    u.uDir.value.set(0, 1);
    this.tilt.render(r, this.rtB);
    const f = this.final.u;
    f.tScene.value = this.rtB.texture;
    f.tBloom.value = BLACK;
    f.uBloom.value = 0;
    f.uTime.value = this.time;
    f.uFlash.value = this.flash;
    this.final.render(r, target);
  }

  dispose() {
    super.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.tilt.dispose();
  }
}

/**
 * Clayland's grade (a LUT): the warmth of a stop-motion set under tungsten
 * lamps — creamy highlights, shadows that lean brown rather than blue, and the
 * plasticine's colours kept rich but never neon.
 */
function filmGrade([r, g, b]: [number, number, number]): [number, number, number] {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const k = sat > 0.75 ? 0.94 : 1;
  let R = l + (r - l) * k,
    G = l + (g - l) * k,
    B = l + (b - l) * k;
  const lo = 1 - smooth(0.08, 0.5, l),
    hi = smooth(0.5, 0.95, l);
  R += 0.02 * lo + 0.015 * hi;
  G += 0.008 * lo + 0.008 * hi;
  B += -0.012 * lo - 0.02 * hi;
  return [R, G, B];
}

export const CLAY: WorldDef = {
  id: 'clay',
  name: 'Clayland',
  tagline: 'Every frame, sculpted by hand',
  blurb: 'Stop-motion plasticine, a real clay court and a very slow snail.',
  ui: {
    accent: '#d4683c',
    accent2: '#3a8ce8',
    ink: '#3a2418',
    paper: '#fff7ec',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Chewy', 'Fredoka', cursive",
    panel: 'linear-gradient(160deg, rgba(255,248,236,0.98), rgba(250,236,218,0.96))',
  },
  song: 'clay',
  surface: 0.93,
  make: (r) => new ClayWorld(CLAY, r),
};
