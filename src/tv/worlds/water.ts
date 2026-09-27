// AQUARELLE — a garden painted in watercolour. The scene is drawn at half size
// and goes through a Kuwahara filter (flat painterly strokes), then pigment
// pools at the edges, colours bleed, granulate into the paper and white paper
// shows through.
//
// The garden runs out into soft hills painted wet-on-wet: stripes of lavender
// and tulips, cypresses and cherry trees, weeping willows over a rippling pond,
// hot-air balloons drifting round, clouds painted in lilac and cream.
//
// The paint does what watercolour does. Washes vary as the pigment settles,
// and blooms — backruns, where wetter paint pushed the pigment out: paler
// inside, a dark tide line round them (the edge darkening draws the line) —
// sit on the objects themselves (world space for the garden, object space for
// what moves, direction for the sky), not on the screen. The paper is
// cold-pressed: its tooth catches the pigment and its relief catches the
// light. The paper never moves, so all of it is painted once per size and a
// frame pays one lookup for it (it used to be five noise stacks per pixel).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass, makeRT } from '../render/post';
import { NOISE, COLOR } from '../render/glsl';
import type { MatchEvent } from '../tennis/match';
import { Rng } from '../core/math';
import { Wind, motion, type SwayOpts } from './park-env/wind';
import { Foliage, clumpGeometry, bushBlobs, tintMask, type Place } from './park-env/foliage';
import { Clouds } from './park-env/sky';
import { Birds } from './park-env/props';
import { landGeometry, bumpsAt, scatterBumps, smooth, type Bump } from './park-env/land';

const KUWAHARA = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  const int R = 3;
  for (int j = -R; j <= R; j++) for (int i = -R; i <= R; i++) {
    vec3 c = texture2D(tSrc, vUv + vec2(float(i), float(j)) * uTexel).rgb;
    vec3 c2 = c * c;
    if (i <= 0 && j <= 0) { m[0] += c; s[0] += c2; }
    if (i >= 0 && j <= 0) { m[1] += c; s[1] += c2; }
    if (i <= 0 && j >= 0) { m[2] += c; s[2] += c2; }
    if (i >= 0 && j >= 0) { m[3] += c; s[3] += c2; }
  }
  float n = float((R + 1) * (R + 1));
  float best = 1e9; vec3 outc = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 mu = m[k] / n;
    vec3 v = abs(s[k] / n - mu * mu);
    float sv = v.r + v.g + v.b;
    if (sv < best) { best = sv; outc = mu; }
  }
  gl_FragColor = vec4(outc, 1.0);
}`;

/**
 * The paper, painted once per size: r = its tooth (where pigment settles),
 * g = its relief lit from the upper left, b/a = the slow wander of the wet
 * edges (the bleed), all as the per-frame pass used to compute them.
 */
const PAPER = /* glsl */ `
varying vec2 vUv;
${NOISE}
float tooth(vec2 f) {
  // soft hollows, a fine grain, and fibres lying mostly one way
  float fib = vnoise(f * vec2(0.035, 0.5)) * 0.5 + vnoise(f * vec2(0.5, 0.04) + 7.0) * 0.3;
  return fbm(f / 38.0) * 0.55 + vnoise(f / 2.2) * 0.33 + fib * 0.12;
}
void main() {
  vec2 f = gl_FragCoord.xy;
  float h = tooth(f);
  float light = 0.5 + ((h - tooth(f + vec2(1.5, 0.0))) - (h - tooth(f + vec2(0.0, 1.5)))) * 2.2;
  gl_FragColor = vec4(h, clamp(light, 0.0, 1.0), fbm(vUv * 7.0 + 1.3), fbm(vUv * 7.0 + 9.1));
}`;

const WATER = /* glsl */ `
uniform sampler2D tPaint; uniform sampler2D tPaper; uniform vec2 uRes; uniform float uFlash; uniform vec3 uPaper;
varying vec2 vUv;
${COLOR}
vec3 paint(vec2 uv) { return toSRGB(texture2D(tPaint, uv).rgb); }
void main() {
  vec4 pp = texture2D(tPaper, vUv);
  vec2 uv = vUv + (pp.ba - 0.5) * 0.009;
  vec3 c = paint(uv);
  // richer pigment: a touch more saturation and contrast than the raw scene
  c = mix(vec3(luma(c)), c, 1.35);
  c = (c - 0.5) * 1.08 + 0.5;
  // pigment pools at edges (darkened outlines where colour changes): the blooms' tide lines too
  vec2 px = 2.5 / uRes;
  vec3 cx = paint(uv + vec2(px.x, 0.0)) - paint(uv - vec2(px.x, 0.0));
  vec3 cy = paint(uv + vec2(0.0, px.y)) - paint(uv - vec2(0.0, px.y));
  float g = length(cx) + length(cy);
  float edge = smoothstep(0.05, 0.3, g);
  c *= 1.0 - edge * 0.3;
  // soften and lighten like diluted pigment
  float l = luma(c);
  c = mix(c, vec3(l), 0.04);
  c = mix(c, uPaper, 0.03 + 0.25 * smoothstep(0.8, 1.0, l));
  // cold-press paper: pigment settles in the hollows (granulation) …
  float paperN = pp.r;
  c *= 1.0 - (1.0 - l) * (paperN - 0.5) * 0.5;
  // … the wash varies, and where the paint is thin the paper's relief catches the light
  c *= 0.93 + 0.12 * (pp.b + pp.a) * 0.5;
  c = mix(c, uPaper, (paperN - 0.5) * 0.18 + 0.02);
  c *= 1.0 + (pp.g - 0.5) * 0.16 * smoothstep(0.3, 0.95, l);
  vec2 q = vUv - 0.5;
  c = mix(c, uPaper, smoothstep(0.45, 0.85, length(q * vec2(uRes.x / uRes.y, 1.0))) * 0.35);
  c = mix(c, uPaper, uFlash);
  gl_FragColor = vec4(c, 1.0);
}`;

// ---------------------------------------------------------------- the paint on things

/**
 * The paint on a material (lambert or basic): its wash varies as the pigment
 * settles, and blooms open in it — paler, cauliflower-edged, a dark tide line
 * round them once the edge darkening sees them. `space`: 'world' for the still
 * garden (instanced or not), 'object' for what moves (puppets, balloons),
 * measured in metres on the object × `scale` so a bloom fits the thing it's on.
 */
function wash<M extends THREE.Material>(m: M, o: { space?: 'world' | 'object'; scale?: number; bloom?: number } = {}): M {
  const prev = m.onBeforeCompile.bind(m);
  const space = o.space ?? 'world';
  const u = { uWashK: { value: new THREE.Vector2(o.scale ?? 1, o.bloom ?? 1) } };
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWash;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${
        space === 'world'
          ? `#ifdef USE_INSTANCING
              vWash = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
            #else
              vWash = (modelMatrix * vec4(transformed, 1.0)).xyz;
            #endif`
          : `{
              vec3 sc = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
              vec3 op = transformed;
              #ifdef USE_INSTANCING
                sc *= vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
                op += instanceMatrix[3].xyz / max(sc, vec3(1e-3));
              #endif
              vWash = op * sc;
            }`
      }`,
    );
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWash;\nuniform vec2 uWashK;\n${WASH_NOISE}`).replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
      {
        vec3 p = vWash * uWashK.x;
        // the wash: pigment settling unevenly, a little warmer here, cooler there
        float w = wn(p * 0.23) * 0.65 + wn(p * 0.71 + 3.1) * 0.35;
        diffuseColor.rgb *= 0.86 + 0.26 * w;
        diffuseColor.rgb *= mix(vec3(0.97, 0.98, 1.04), vec3(1.04, 1.0, 0.95), w);
        // blooms, here and there: wetter paint ran back and pushed the pigment out
        float b = wn(p * 0.13 + 7.7) + (wn(p * 0.8) - 0.5) * 0.16;
        float bloom = smoothstep(0.72, 0.735, b) * uWashK.y;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.84 + 0.15, bloom);
      }`,
    );
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|wash-${space}`;
  return m;
}

/** a 3D value noise, cheap enough for every pixel of the half-size scene */
const WASH_NOISE = /* glsl */ `
float wh(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float wn(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wh(i), wh(i + vec3(1,0,0)), f.x), mix(wh(i + vec3(0,1,0)), wh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(wh(i + vec3(0,0,1)), wh(i + vec3(1,0,1)), f.x), mix(wh(i + vec3(0,1,1)), wh(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

const L = (c: THREE.ColorRepresentation) => wash(new THREE.MeshLambertMaterial({ color: c }));

/**
 * The garden's hills: pastel greens going blue-violet with distance, and on
 * the hills fields of flowers in rows — lavender, tulips, poppies — painted as
 * soft stripes (each field turned its own way).
 */
function landMaterial() {
  const m = wash(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
      {
        float rr = length(vWash.xz);
        float band = smoothstep(84.0, 100.0, rr) * (1.0 - smoothstep(190.0, 230.0, rr));
        vec2 q = mat2(0.88, 0.47, -0.47, 0.88) * vWash.xz / vec2(38.0, 26.0);
        vec2 c = floor(q), f = fract(q);
        float k = wh(vec3(c, 5.0));
        float field = step(0.48, k) * smoothstep(0.0, 0.08, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y))) * band;
        // rows across the field, turned a little per field
        float a = (wh(vec3(c, 9.0)) - 0.5) * 1.2;
        float along = dot(f - 0.5, vec2(cos(a), sin(a))) * 26.0;
        float rows = smoothstep(0.25, 0.75, 0.5 + 0.5 * sin(along * 2.6));
        vec3 flower = k < 0.62 ? vec3(0.62, 0.5, 0.86) : k < 0.74 ? vec3(0.96, 0.55, 0.68) : k < 0.86 ? vec3(0.98, 0.86, 0.45) : vec3(0.92, 0.42, 0.38);
        diffuseColor.rgb = mix(diffuseColor.rgb, flower, rows * field * 0.85);
      }`,
    );
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|aquarelle-land`;
  return m;
}

/** A sky painted wet-on-wet: warm at the horizon, clearer blue above, soft clouds of pigment and a few blooms. */
const SKY_VERT = /* glsl */ `varying vec3 vDir; void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop, uHorizon, uWarm;
varying vec3 vDir;
${WASH_NOISE}
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.7, y));
  col = mix(col, uWarm, (1.0 - smoothstep(0.0, 0.25, y)) * 0.5);
  // pigment gathered in soft pools, and blooms opened in the wet sky
  vec3 p = d * 4.0;
  float w = wn(p) * 0.6 + wn(p * 2.3 + 1.7) * 0.4;
  col = mix(col, col * vec3(0.9, 0.93, 1.02), smoothstep(0.45, 0.8, w) * 0.6 * step(0.0, y));
  float b = wn(p * 1.1 + 4.2) + (wn(p * 5.0) - 0.5) * 0.18;
  col = mix(col, col * 0.86 + 0.16, smoothstep(0.7, 0.715, b) * step(0.05, y));
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- the land

const POND = { x: -19, z: -8 };

function landBumps() {
  const r = new Rng(9090);
  const rand = () => r.next();
  return [
    { x: 0, z: -150, r: 80, h: 16 } as Bump,
    ...scatterBumps(rand, 22, { r: [100, 200], a: [-Math.PI * 1.05, 0.05], size: [36, 64], h: [5, 16] }),
    ...scatterBumps(rand, 14, { r: [95, 190], a: [0.1, Math.PI - 0.1], size: [34, 56], h: [3, 9] }),
    ...scatterBumps(rand, 18, { r: [290, 420], size: [80, 140], h: [22, 55] }),
  ];
}

const TREE_SWAY: SwayOpts = { amp: 0.18, height: 6, flutter: 0.02 };

class WaterWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(new THREE.Color('#2b2440'));
      if (role === 'eyeWhite') return flat(new THREE.Color('#ffffff'));
      if (role === 'strings') return stringsMat(new THREE.Color('#ffffff'));
      if (role === 'cheek') return flat(new THREE.Color('#ff9fb2'));
      // a bloom now and then on a shirt: measured on the puppet, so it moves with it
      return wash(new THREE.MeshLambertMaterial({ color: c }), { space: 'object', scale: 2.2, bloom: 0.5 });
    },
    outline: null,
    shadowColor: new THREE.Color('#4a5a8a'),
    shadowOpacity: 0.3,
  };

  private half!: THREE.WebGLRenderTarget;
  private kuw!: THREE.WebGLRenderTarget;
  private paperRT!: THREE.WebGLRenderTarget;
  private kPass!: Pass;
  private wPass!: Pass;
  private pPass!: Pass;
  private wind = new Wind(0.9, -0.45, 1);
  private rng = new Rng(20260930);
  private bumps = landBumps();
  private foliage!: Foliage;
  private clouds: Clouds | null = null;
  private birds: Birds | null = null;
  private balloons!: THREE.InstancedMesh;
  private petals!: THREE.InstancedMesh;
  /** instanced scenery the detail level thins (with full counts) */
  private optional: [THREE.InstancedMesh, number][] = [];

  protected samples() {
    return 0;
  }

  protected build() {
    const s = this.scene;
    s.fog = new THREE.Fog('#f4f0ff', 130, 560);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: { uTop: { value: new THREE.Color('#9ec9ff') }, uHorizon: { value: new THREE.Color('#fff1f4') }, uWarm: { value: new THREE.Color('#ffe6cc') } },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    s.add(sky);
    s.add(new THREE.HemisphereLight('#fff6ff', '#b9d6a0', 2.1));
    const sun = new THREE.DirectionalLight('#fff0dc', 1.6);
    sun.position.set(10, 20, -8);
    s.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(62, 48), L('#8fcf72'));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    s.add(ground);

    // (quieter paint on the court: it's where the ball is read)
    const court = (c: string) => wash(new THREE.MeshLambertMaterial({ color: c }), { bloom: 0.45 });
    this.buildCourt({
      inner: court('#6fbf62'),
      outer: court('#a7dc8a'),
      line: flat('#ffffff'),
      innerPad: { x: 1, z: 1.8 },
      outerSize: { x: 10.5, z: 18.5 },
      lineWidth: 0.12,
      wobble: 0.015,
    });
    this.buildNet({
      post: L('#6a5a8a'),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      band: flat('#ffffff'),
    });
    this.buildBall(new THREE.MeshLambertMaterial({ color: '#ffe14a', emissive: new THREE.Color('#403000') }), { color: new THREE.Color('#9fc4ff'), color2: new THREE.Color('#ffc2dc'), width: 0.1, opacity: 0.55, mode: 1, length: 24 }, new THREE.Color('#4a5a8a'), 0.35);
    this.buildParticles();

    this.foliage = new Foliage(this.wind, {
      material: (p) => wash(new THREE.MeshLambertMaterial({ vertexColors: p.vertexColors })),
      tree: TREE_SWAY,
      // (no sun shadows in the painting: a shadow pass cost ~0.5 ms GPU and as much JS for short, faint shapes)
      shadows: false,
    });
    this.buildLand();
    this.buildGarden();
    this.buildTrees();
    this.buildSky();
    this.buildStands();

    this.effects = {
      // soft washes of shadow where the feet meet the lawn (the only shadows in the painting)
      contact: { strength: 0.45, color: new THREE.Color('#5a64a0') },
    };

    // the scene is drawn here: it needs a depth buffer (without one, whatever is drawn
    // last wins — the bowling lanes, built after the players, covered them)
    this.half = makeRT(1, 1, { depth: true });
    this.kuw = makeRT(1, 1);
    this.paperRT = makeRT(1, 1, { type: THREE.UnsignedByteType });
    this.kPass = new Pass(KUWAHARA, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) } });
    this.pPass = new Pass(PAPER);
    this.wPass = new Pass(WATER, { tPaint: { value: null }, tPaper: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uFlash: { value: 0 }, uPaper: { value: new THREE.Vector3(0.99, 0.97, 0.93) } });
  }

  /** The ground's height at (x, z): flat round the garden, soft hills beyond. */
  private landAt(x: number, z: number) {
    const r = Math.hypot(x, z);
    return -0.06 + smooth(64, 104, r) * bumpsAt(this.bumps, x, z);
  }

  private buildLand() {
    const near = new THREE.Color('#8fcf72'),
      hill = new THREE.Color('#a8d88a'),
      far = new THREE.Color('#b9c9e8'),
      farthest = new THREE.Color('#d6cdea');
    const geo = landGeometry(
      (x, z) => this.landAt(x, z),
      (x, z, h, _up, out) => {
        const r = Math.hypot(x, z);
        out.copy(near).lerp(hill, smooth(3, 16, h) * 0.7);
        // wet-on-wet: the far hills wash into blue and violet
        out.lerp(far, smooth(150, 300, r) * 0.75).lerp(farthest, smooth(300, 440, r) * 0.6);
      },
      { r0: 60, r1: 470, rings: 40, segs: 160, bias: 1.8 },
    );
    this.scene.add(new THREE.Mesh(geo, landMaterial()));
  }

  /** The pond with its ripples, lily pads and bridge; a gazebo; balloons drifting round. */
  private buildGarden() {
    const s = this.scene;
    const r = this.rng;
    // the pond: rings spreading from where the water's touched, in paler blue
    const pondMat = wash(new THREE.MeshLambertMaterial({ color: '#8cc8f0' }), { bloom: 0.6 });
    const prev = pondMat.onBeforeCompile.bind(pondMat);
    pondMat.onBeforeCompile = (sh, rr) => {
      prev(sh, rr);
      sh.uniforms.uTime = this.wind.u.uTime;
      // (rings measured on the pond itself: a split screen's far half turns the garden round)
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vPond;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPond = position.xy * vec2(1.4, 1.0);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vPond;').replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          float ring = 0.0;
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            vec2 c = vec2(sin(fi * 2.1) * 5.0, cos(fi * 1.7) * 2.5);
            float d = length(vPond - c);
            float ph = d * 2.4 - uTime * (1.1 + fi * 0.2) + fi * 2.0;
            ring += smoothstep(0.55, 0.95, sin(ph)) * smoothstep(7.0, 1.0, d);
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.97, 1.0), clamp(ring, 0.0, 1.0) * 0.45);
        }`,
      );
    };
    pondMat.customProgramCacheKey = () => 'aquarelle-pond';
    const pond = new THREE.Mesh(new THREE.CircleGeometry(7, 40), pondMat);
    pond.rotation.x = -Math.PI / 2;
    pond.scale.set(1.4, 1, 1);
    pond.position.set(POND.x, 0.02, POND.z);
    pond.userData.noBatch = true;
    s.add(pond);
    const padMat = L('#6dbb6a');
    const lotusMat = L('#ffb0d0');
    for (let i = 0; i < 12; i++) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(r.range(0.7, 1.1), 16, 0.3, Math.PI * 1.8), padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(POND.x + r.range(-8, 8), 0.04, POND.z + r.range(-4.5, 4.5));
      s.add(pad);
      if (i % 3 === 0) {
        const lotus = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), lotusMat);
        lotus.scale.y = 0.6;
        lotus.position.copy(pad.position).add(new THREE.Vector3(0, 0.2, 0));
        s.add(lotus);
      }
    }
    const bridge = new THREE.Mesh(new THREE.TorusGeometry(5, 0.5, 8, 24, Math.PI), L('#d97a6a'));
    bridge.position.set(POND.x, 0, POND.z);
    bridge.rotation.y = Math.PI / 2;
    bridge.scale.set(1, 0.55, 2.2);
    s.add(bridge);

    // a white gazebo at the garden's far end (+z), and a path of stepping stones to it
    const white = L('#fbf7ff');
    const g = new THREE.Group();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 3.2, 8), white);
      col.position.set(Math.cos(a) * 2.6, 1.6, Math.sin(a) * 2.6);
      g.add(col);
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.5, 0.4, 24), white);
    base.position.y = 0.2;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(3.2, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), L('#a9c4f0'));
    dome.position.y = 3.2;
    dome.scale.y = 0.75;
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), L('#f6c86a'));
    finial.position.y = 5.7;
    g.add(base, dome, finial);
    g.position.set(0, 0, 46);
    s.add(g);
    const stone = L('#e8e0d4');
    for (let i = 0; i < 9; i++) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.12, 10), stone);
      st.position.set(Math.sin(i * 0.9) * 0.8, 0.02, 24 + i * 2.2);
      s.add(st);
    }

    // hot-air balloons circling the garden (one draw): striped gores, a basket on ropes
    const env = new THREE.SphereGeometry(3, 12, 10).toNonIndexed().scale(1, 1.18, 1);
    const pos = env.attributes.position as THREE.BufferAttribute;
    const n = pos.count;
    const col = new Float32Array(n * 3).fill(1);
    const gore = new Float32Array(n);
    for (let t = 0; t < n; t += 3) {
      // which gore: by the triangle's middle
      const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3,
        cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
      const k = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 12) % 2;
      gore.fill(k, t, t + 3);
    }
    env.setAttribute('color', new THREE.BufferAttribute(col, 3));
    env.setAttribute('aTint', new THREE.BufferAttribute(gore, 1));
    env.deleteAttribute('uv');
    const brown = new THREE.Color('#9a6a44');
    const part = (geo: THREE.BufferGeometry) => {
      const q = geo.index ? geo.toNonIndexed() : geo;
      q.deleteAttribute('uv');
      const m = q.attributes.position.count;
      const c = new Float32Array(m * 3);
      for (let i = 0; i < m; i++) c.set([brown.r, brown.g, brown.b], i * 3);
      q.setAttribute('color', new THREE.BufferAttribute(c, 3));
      q.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(m), 1));
      return q;
    };
    const parts = [env, part(new THREE.BoxGeometry(1.1, 0.9, 1.1).translate(0, -4.6, 0))];
    for (const [dx, dz] of [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ])
      parts.push(part(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 4).translate(dx, -3.4, dz)));
    const balloon = mergeGeometries(parts)!;
    const spots = 8;
    this.balloons = new THREE.InstancedMesh(
      balloon,
      motion(tintMask(wash(new THREE.MeshLambertMaterial({ vertexColors: true }), { space: 'object', scale: 2 })), 'aquarelle-balloon', { uTime: this.wind.u.uTime }, 'uniform float uTime;', /* glsl */ `
        // round the garden on the breeze, rising and sinking a little, each at its own pace
        float r = length(io.xz);
        float ph = fract(sin(dot(io.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
        float a = atan(io.z, io.x) + uTime * (0.9 + 0.3 * sin(ph)) / max(r, 1.0);
        vec3 c = vec3(cos(a) * r, io.y + sin(uTime * 0.23 + ph) * 3.0, sin(a) * r);
        mvPosition.xyz = c + (mvPosition.xyz - io);`),
      spots,
    );
    const cols = ['#ff8fab', '#8fb8ff', '#ffc36b', '#b28dff', '#8fe3c0', '#ff9f7a', '#f6d86b', '#9fd4ff'].map((c) => new THREE.Color(c));
    const M = new THREE.Matrix4();
    for (let i = 0; i < spots; i++) {
      const a = (i / spots) * Math.PI * 2 + r.range(-0.2, 0.2);
      const d = r.range(90, 190);
      M.makeScale(1, 1, 1).setPosition(Math.cos(a) * d, r.range(26, 58), Math.sin(a) * d);
      this.balloons.setMatrixAt(i, M);
      this.balloons.setColorAt(i, cols[i % cols.length]);
    }
    this.balloons.frustumCulled = false;
    s.add(this.balloons);

    // flower beds along the sides (instanced)
    const fl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.18, 8, 6), wash(new THREE.MeshLambertMaterial({ color: '#ffffff' })), 700);
    const fcols = ['#ff8fab', '#ffd66b', '#b28dff', '#ff6f91', '#ffffff', '#8fd3ff', '#ffa94d'].map((c) => new THREE.Color(c));
    for (let i = 0; i < 700; i++) {
      const side = i % 2 ? 1 : -1;
      let x = side * r.range(11.2, 13.8),
        z = r.range(-17, 17);
      // (not in the pond)
      if (Math.hypot((x - POND.x) / 1.4, z - POND.z) < 7.3) z = POND.z + 7.6 + r.range(0, 9);
      M.makeTranslation(x, r.range(0.15, 0.4), z);
      fl.setMatrixAt(i, M);
      fl.setColorAt(i, r.pick(fcols));
    }
    s.add(fl);
  }

  /**
   * Trees in the breeze (instanced, one draw per kind): cherries in blossom
   * behind the far stand, weeping willows over the pond with their strands
   * swinging, cypresses and round trees over the hills.
   */
  private buildTrees() {
    const r = this.rng;
    const f = this.foliage;
    const blossom = ['#ffb3cf', '#ff9fc2', '#ffd1e3', '#f7a8d8'].map((c) => new THREE.Color(c));
    const greens = ['#9fd57a', '#8cc870', '#b5dd88', '#7fc47e'].map((c) => new THREE.Color(c));
    const cypress = ['#5f9e6e', '#6aa678', '#548f66'].map((c) => new THREE.Color(c));
    const round: Place[] = [],
      tall: Place[] = [],
      wide: Place[] = [];
    // cherry trees in blossom behind the far stand (where the old ones stood)
    for (let i = 0; i < 14; i++) round.push({ x: -46 + i * 7 + r.range(-1.5, 1.5), z: -30 - r.range(0, 8), s: r.range(1.2, 1.6), sy: r.range(0.9, 1.1), yaw: r.range(0, 6.3), color: r.pick(blossom) });
    // a second row, and cypresses between them
    for (let i = 0; i < 12; i++) tall.push({ x: -44 + i * 8 + r.range(-2, 2), z: -44 - r.range(0, 5), s: r.range(1.1, 1.4), sy: r.range(1, 1.25), yaw: r.range(0, 6.3), color: r.pick(cypress) });
    // either side of the stands
    for (const sx of [-1, 1])
      for (let i = 0; i < 6; i++) {
        const z = -24 + i * 9 + r.range(-2, 2);
        if (Math.hypot(sx * 24 - POND.x, z - POND.z) < 10) continue;
        (i % 2 ? tall : round).push({ x: sx * r.range(22, 30), z, s: r.range(1, 1.3), sy: r.range(0.95, 1.2), yaw: r.range(0, 6.3), color: i % 2 ? r.pick(cypress) : r.chance(0.35) ? r.pick(blossom) : r.pick(greens) });
      }
    // over the hills
    const far: Record<'round' | 'tall' | 'wide', Place[]> = { round: [], tall: [], wide: [] };
    for (let c = 0; c < 22; c++) {
      const a = r.range(-Math.PI, Math.PI);
      const d = r.range(70, 190);
      const cx = Math.cos(a) * d,
        cz = Math.sin(a) * d;
      const kind = r.pick(['round', 'tall', 'tall', 'wide'] as const);
      for (let k = r.int(2, 5); k > 0; k--) {
        const x = cx + r.range(-8, 8),
          z = cz + r.range(-8, 8);
        if (Math.hypot(x, z) < 66) continue;
        far[kind].push({ x, z, y: this.landAt(x, z) - 0.2, s: r.range(1.2, 1.6), sy: r.range(0.95, 1.2), yaw: r.range(0, 6.3), color: kind === 'tall' ? r.pick(cypress) : r.chance(0.25) ? r.pick(blossom) : r.pick(greens) });
      }
    }
    f.trees('round', round, 11);
    f.trees('tall', tall, 23);
    for (const k of ['round', 'tall', 'wide'] as const) {
      const m = far[k].length ? f.trees(k, far[k], k === 'round' ? 31 : k === 'tall' ? 37 : 41, { shadow: false }) : undefined;
      if (m) this.optional.push([m, far[k].length]);
    }
    // weeping willows: a wide crown each, strands hanging all round it, swinging most at their tips
    const willows: [number, number, number][] = [
      [-16, -22, 1.2],
      [17, -20, 1.1],
      [-24, 6, 1],
      [23, 8, 1.1],
      [-30, -12, 0.9],
    ];
    for (const [x, z, sc] of willows) wide.push({ x, z, s: sc, sy: 1, yaw: r.range(0, 6.3), color: new THREE.Color('#a9d77e') });
    f.trees('wide', wide, 17);
    const strands: Place[] = [];
    for (const [x, z, sc] of willows)
      for (let k = 0; k < 26; k++) {
        const a = (k / 26) * Math.PI * 2 + r.range(-0.1, 0.1);
        const d = r.range(1.4, 2.6) * sc;
        strands.push({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, y: 4.2 * sc, s: r.range(0.9, 1.2) * sc, yaw: r.range(0, 6.3), color: r.pick(greens) });
      }
    f.vines(strands, 3.6, 19);
    // clipped hedges behind the side stands
    const hedge: Place[] = [];
    for (const sx of [-1, 1]) for (let i = 0; i < 15; i++) hedge.push({ x: sx * 20, z: -18 + i * 2.6 + r.range(-0.3, 0.3), s: r.range(1.1, 1.4), sy: r.range(0.9, 1.1), yaw: r.range(0, 6.3), color: r.pick(greens) });
    f.add(clumpGeometry(bushBlobs(5), { seed: 5, seg: 7, lumpy: 0.1, lean: 0.7 }), f.shrub, hedge, { shadow: null });
    this.scene.add(f.group);
    this.buildPetals(round.slice(0, 14));
  }

  /**
   * Petals falling from the cherry trees behind the far stand: each drifts down
   * on the breeze, turning over as it goes, and starts again from its crown
   * (one instanced draw, all in the vertex shader).
   */
  private buildPetals(trees: Place[]) {
    const r = this.rng;
    const n = 170;
    const quad = new THREE.PlaneGeometry(0.34, 0.24);
    quad.deleteAttribute('uv');
    const petals = new THREE.InstancedMesh(
      quad,
      motion(new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, fog: true }), 'aquarelle-petal', { uTime: this.wind.u.uTime, uWind: this.wind.u.uWind }, 'uniform float uTime;\nuniform vec3 uWind;', /* glsl */ `
        float ph = fract(sin(dot(io.xz, vec2(12.9898, 78.233)) + io.y * 3.7) * 43758.5453);
        float t = fract(uTime * 0.065 + ph);
        // turning over as it falls: about an axis of its own
        vec3 ax = normalize(vec3(sin(ph * 17.0), 0.6, cos(ph * 11.0)));
        float a = uTime * (2.0 + ph * 2.0) + ph * 6.28;
        vec3 v = mvPosition.xyz - io;
        v = v * cos(a) + cross(ax, v) * sin(a) + ax * dot(ax, v) * (1.0 - cos(a));
        vec3 drift = vec3(uWind.x, 0.0, uWind.y) * t * 11.0 + vec3(sin(uTime * 1.3 + ph * 6.28), 0.0, cos(uTime * 1.1 + ph * 9.0)) * 0.9;
        // shrinking away as it lands (a petal doesn't pop)
        mvPosition.xyz = io + drift + vec3(0.0, -t * io.y, 0.0) + v * (1.0 - smoothstep(0.85, 1.0, t));`),
      n,
    );
    const pinks = ['#ffb3cf', '#ffd1e3', '#ff9fc2', '#fff0f5'].map((c) => new THREE.Color(c));
    const M = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const t = trees[i % trees.length];
      const s = t.s ?? 1;
      M.makeTranslation(t.x + r.range(-1.8, 1.8) * s, r.range(3.8, 5.6) * s, t.z + r.range(-1.8, 1.8) * s);
      petals.setMatrixAt(i, M);
      petals.setColorAt(i, r.pick(pinks));
    }
    petals.frustumCulled = false;
    this.petals = petals;
    this.scene.add(petals);
  }

  /** Clouds painted in lilac and cream (camera-facing cards, one draw), birds over the garden. */
  private buildSky() {
    this.clouds = new Clouds({ count: 30, radius: [170, 320], height: [30, 118], size: [70, 140], speed: 1.6, haze: new THREE.Color('#fff1f4'), seed: 13, shade: '218,206,238', lit: '255,251,246' });
    this.scene.add(this.clouds.mesh);
    this.birds = new Birds(
      this.wind.u,
      [
        { x: -10, y: 30, z: -90, radius: 18, count: 7, speed: 0.13 },
        { x: 50, y: 26, z: 40, radius: 14, count: 5, speed: -0.16 },
      ],
      '#4a4466',
    );
    this.scene.add(this.birds.mesh);
  }

  private buildStands() {
    const stands: Stand[] = [];
    const white = L('#f7f4ff');
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.5 + r * 0.5;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), white);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        g.add(st);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.5, rowDepth: 0.9, y0: 0.5 });
    };
    mk(-14.5, 0, -Math.PI / 2, 20, 5);
    mk(14.5, 0, Math.PI / 2, 20, 5);
    mk(0, -20, Math.PI, 16, 5);
    const crowd = new Crowd({
      stands,
      density: 0.9,
      bodyMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
      headMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
      shirts: ['#ff8fab', '#8fb8ff', '#ffd66b', '#b28dff', '#8fe3c0', '#ffb38a'].map((c) => new THREE.Color(c)),
      skins: ['#ffe2cc', '#f0c8a8', '#c99a78', '#8f6446'].map((c) => new THREE.Color(c)),
      fill: 0.8,
    });
    this.addCrowd(crowd);
  }

  protected onResize(W: number, H: number) {
    const hw = Math.max(1, Math.floor(W / 2)),
      hh = Math.max(1, Math.floor(H / 2));
    this.half.setSize(hw, hh);
    this.kuw.setSize(hw, hh);
    this.kPass.u.uTexel.value.set(1 / hw, 1 / hh);
    this.wPass.u.uRes.value.set(W, H);
    // the paper for this size, painted once
    if (this.paperRT.width !== W || this.paperRT.height !== H) {
      this.paperRT.setSize(W, H);
      this.paperDirty = true;
    }
  }
  private paperDirty = true;

  protected animate(v: FrameView) {
    this.wind.tick(v.realT);
    this.clouds?.tick(v.realT);
  }

  protected onDetail(d: number) {
    const k = Math.min(1, 0.35 + 0.65 * d);
    for (const [m, n] of this.optional) m.count = Math.round(n * k);
    this.clouds?.setDetail(d);
    this.birds?.setDetail(d);
    this.balloons.count = d < 0.3 ? 4 : 8;
    this.petals.count = Math.round(170 * Math.min(1, 0.3 + 0.7 * d));
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    const cols = (a: string[]) => a.map((c) => new THREE.Color(c));
    if (e.type === 'hit') P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: e.perfect ? 16 : 7, speed: [1.5, 4], life: [0.4, 0.9], size: [0.15, 0.3], shrink: 1.5, colors: cols(['#ffd6e7', '#d6e6ff', '#fff2b3']), shape: 'soft', drag: 3, alpha: 0.7 });
    if (e.type === 'bounce' && e.impact > 2) P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 1, speed: [0, 0], life: [1.2, 1.2], size: [0.3, 0.3], shrink: 4, colors: cols([e.out ? '#ff8fab' : '#9fc4ff']), shape: 'ring', alpha: 0.6 });
    if (e.type === 'point') P.burst({ x: 0, y: 7, z: e.winner === 0 ? 6 : -6, count: 90, speed: [2, 6], dir: [0, 1, 0], spread: 0.9, life: [2.5, 4], size: [0.15, 0.25], colors: cols(['#ff8fab', '#ffd66b', '#b28dff', '#8fd3ff']), shape: 'petal', gravity: 1.2, drag: 0.8, spin: 6, ground: true });
  }

  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    if (this.paperDirty) {
      // (outside any split-screen viewport: the paper fills its own buffer)
      const vp = r.getViewport(new THREE.Vector4());
      const sc = r.getScissorTest();
      r.setScissorTest(false);
      this.pPass.render(r, this.paperRT);
      r.setScissorTest(sc);
      r.setViewport(vp);
      this.paperDirty = false;
    }
    r.setRenderTarget(this.half);
    r.setClearColor('#fff8f4', 1);
    r.clear();
    r.render(this.scene, cam);
    r.setClearColor(0x000000, 1);
    this.kPass.u.tSrc.value = this.half.texture;
    this.kPass.render(r, this.kuw);
    const u = this.wPass.u;
    u.tPaint.value = this.kuw.texture;
    u.tPaper.value = this.paperRT.texture;
    u.uFlash.value = this.flash * 0.6;
    this.wPass.render(r, target);
  }

  dispose() {
    super.dispose();
    this.half.dispose();
    this.kuw.dispose();
    this.paperRT.dispose();
    this.kPass.dispose();
    this.pPass.dispose();
    this.wPass.dispose();
  }
}

export const AQUARELLE: WorldDef = {
  id: 'water',
  name: 'Aquarelle',
  tagline: 'Soft edges, bold shots',
  blurb: 'A garden in watercolour: balloons, willows and a lily pond.',
  ui: {
    accent: '#b28dff',
    accent2: '#ff8fab',
    ink: '#3a3552',
    paper: '#fdf8f1',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Caveat', cursive",
    panel: 'linear-gradient(160deg, rgba(253,250,245,0.97), rgba(245,238,252,0.95))',
  },
  song: 'water',
  surface: 1,
  make: (r) => new WaterWorld(AQUARELLE, r),
};
