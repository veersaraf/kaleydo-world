// Lighting and post effects a world can opt into (`World.effects`): light from
// the world's own sky, ambient occlusion, sun glare and light shafts, a colour
// grade, depth of field and soft contact shadows under the players' feet.
//
//  • Everything here is off unless a world asks for it, so the stylized worlds
//    keep their look until they choose otherwise.
//  • The heavy passes follow the effects tier (render/quality.ts): the quality
//    controller drops them before it drops the resolution.
//  • The screen passes work from one half-res linear depth buffer, made once a
//    frame and shared by AO, the shafts, the flare's occlusion test and DOF.
//  • Nothing allocates per frame, and every pass compiles while the world is
//    primed behind the loader (`prime`), whatever tier is on at the time.

import * as THREE from 'three';
import { Pass, makeRT } from './post';

// ---------------------------------------------------------------- the opt-in API

export interface IblDef {
  /** the world's sky dome (see mats.skyDome), baked once at init */
  sky: THREE.Mesh;
  /**
   * Diffuse sky light (a spherical-harmonics light probe): blue from above, the
   * ground's bounce from below, brighter towards the sun. Every lit material
   * evaluates the probe anyway, so it costs nothing per pixel.
   */
  diffuse?: number;
  /** colourfulness of that light: a deep blue zenith makes shadows purple; < 1 tempers it */
  saturation?: number;
  /**
   * Sky reflections on standard materials (a prefiltered environment map,
   * scene.environment): 0 = none. Keep it low on saturated, matte worlds —
   * grazing-angle sky sheen washes colour out.
   */
  specular?: number;
}

export interface AoDef {
  /** world-space reach of the occlusion, metres */
  radius?: number;
  /** darkening of fully occluded spots, 0..1 */
  strength?: number;
  /** how quickly occlusion builds up (SAO intensity) */
  intensity?: number;
  /** sunlit, bright pixels keep this much of their light (AO is ambient occlusion) */
  protectLit?: number;
}

export interface SunDef {
  /** direction towards the sun (as in the sky dome) */
  dir: THREE.Vector3;
  color: THREE.Color;
  /** light shaft strength (0 = none) */
  shafts?: number;
  /** lens glare strength (0 = none) */
  flare?: number;
}

export type Tonemap = 'none' | 'aces' | 'agx' | 'neutral';

export interface GradeDef {
  tonemap?: Tonemap;
  /** a display-space grade baked into a 3D LUT: sRGB in, sRGB out (0..1) */
  lut?: (rgb: [number, number, number]) => [number, number, number];
}

export interface ContactDef {
  /** darkness right under a planted foot, 0..1 */
  strength?: number;
  color?: THREE.Color;
}

export interface ShadowDef {
  /** the sun: its shadow map follows the effects tier (FX_TIERS[].shadowMap) */
  light: THREE.DirectionalLight;
  /**
   * The ground the game is played and watched on, in the scenery's own space:
   * the light's camera is fitted around it with its up along the court (so the
   * box isn't covered diagonally) and snapped to whole texels. The fit never
   * follows the view, so shadows can't shimmer as the camera moves. A sport can
   * have its own (`sports`), e.g. a tighter one around a duel arena.
   */
  area: THREE.Box3;
  sports?: Partial<Record<'tennis' | 'bowling' | 'duel', THREE.Box3>>;
  /** penumbra radius in metres, whatever the map size (PCF radius in texels follows) */
  softness?: number;
}

export interface WorldEffects {
  ibl?: IblDef;
  ao?: AoDef;
  sun?: SunDef;
  grade?: GradeDef;
  contact?: ContactDef;
  shadow?: ShadowDef;
  /** depth of field can be switched on (World.dof) — costs nothing until it is */
  dof?: boolean;
}

/** Depth of field for a shot: focus distance (m along the view axis) and blur strength. */
export interface DofState {
  focus: number;
  /** blur growth away from the focus plane (roughly an aperture); 1 = gentle */
  aperture?: number;
}

// ---------------------------------------------------------------- tiers

export interface FxTier {
  /** AO taps (0 = off) */
  ao: number;
  /** AO buffer scale relative to the render (0.5 = half res) */
  aoScale: number;
  /** light shaft taps (0 = off) */
  shafts: number;
  /** shaft buffer scale relative to the render */
  shaftScale: number;
  /** sun shadow map size */
  shadowMap: number;
}

/** What each effects tier (LEVELS[i].fx) turns on. Cheap things (IBL, grade, glare,
 *  contact shadows) are on in every tier. */
export const FX_TIERS: FxTier[] = [
  { ao: 0, aoScale: 0.5, shafts: 0, shaftScale: 0.25, shadowMap: 1024 },
  { ao: 0, aoScale: 0.5, shafts: 16, shaftScale: 0.25, shadowMap: 2048 },
  { ao: 8, aoScale: 0.5, shafts: 24, shaftScale: 0.25, shadowMap: 2048 },
  { ao: 12, aoScale: 0.5, shafts: 32, shaftScale: 0.5, shadowMap: 2048 },
];

// ---------------------------------------------------------------- image-based light

/** A scene holding just the sky dome (sharing its geometry and shader). */
function skyScene(sky: THREE.Mesh) {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(sky.geometry, sky.material));
  return env;
}

/** The sky's reflections: a prefiltered environment map (PMREM), baked once. */
export function bakeSkyReflections(renderer: THREE.WebGLRenderer, sky: THREE.Mesh, size = 128) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(skyScene(sky), 0, 0.1, 1000, { size });
  pmrem.dispose();
  return rt;
}

/**
 * The sky's diffuse light as a light probe: the dome rendered into a tiny cube
 * and projected onto order-2 spherical harmonics (as LightProbeGenerator does,
 * but synchronously — it runs once, while the world is built).
 */
export function bakeSkyProbe(renderer: THREE.WebGLRenderer, sky: THREE.Mesh, saturation = 1, size = 16) {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
  const cam = new THREE.CubeCamera(0.1, 1000, rt);
  cam.update(renderer, skyScene(sky));
  const sh = new THREE.SphericalHarmonics3();
  const basis = new Array<number>(9).fill(0);
  const data = new Uint16Array(size * size * 4);
  const coord = new THREE.Vector3();
  const color = new THREE.Color();
  const px = 2 / size;
  let total = 0;
  for (let face = 0; face < 6; face++) {
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, data, face);
    for (let i = 0; i < data.length; i += 4) {
      color.setRGB(THREE.DataUtils.fromHalfFloat(data[i]), THREE.DataUtils.fromHalfFloat(data[i + 1]), THREE.DataUtils.fromHalfFloat(data[i + 2]), THREE.LinearSRGBColorSpace);
      const pi = i / 4;
      // (WebGL's cube faces, flipped as in LightProbeGenerator)
      const col = -(1 - ((pi % size) + 0.5) * px);
      const row = 1 - (Math.floor(pi / size) + 0.5) * px;
      if (face === 0) coord.set(1, row, col * -1);
      else if (face === 1) coord.set(-1, row, -col * -1);
      else if (face === 2) coord.set(col, 1, -row);
      else if (face === 3) coord.set(col, -1, row);
      else if (face === 4) coord.set(col, row, 1);
      else coord.set(-col, row, -1);
      const l2 = coord.lengthSq();
      const w = 4 / (Math.sqrt(l2) * l2);
      total += w;
      THREE.SphericalHarmonics3.getBasisAt(coord.normalize(), basis);
      for (let j = 0; j < 9; j++) {
        sh.coefficients[j].x += basis[j] * color.r * w;
        sh.coefficients[j].y += basis[j] * color.g * w;
        sh.coefficients[j].z += basis[j] * color.b * w;
      }
    }
  }
  const norm = (4 * Math.PI) / total;
  for (const c of sh.coefficients) {
    c.multiplyScalar(norm);
    // the projection is linear, so desaturating each coefficient desaturates the light
    const l = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
    c.set(l + (c.x - l) * saturation, l + (c.y - l) * saturation, l + (c.z - l) * saturation);
  }
  rt.dispose();
  return new THREE.LightProbe(sh);
}

// ---------------------------------------------------------------- sun shadows

const fitM = new THREE.Matrix4();
const fitX = new THREE.Vector3();
const fitY = new THREE.Vector3();
const fitZ = new THREE.Vector3();
const fitP = new THREE.Vector3();
const FIT_UP = new THREE.Vector3(0, 0, -1);

/**
 * Fit a directional light's shadow camera around `box` (both in the light's
 * parent space) at `size`² texels. The camera looks from the light to its
 * target with its up along −z, the court's long axis; `turned` flips that for
 * the far player's split-screen view, where the scenery is turned 180°.
 */
export function fitShadow(light: THREE.DirectionalLight, box: THREE.Box3, size: number, softness: number, turned = false) {
  const sh = light.shadow;
  const cam = sh.camera as THREE.OrthographicCamera;
  fitM.lookAt(light.position, light.target.position, FIT_UP);
  fitM.extractBasis(fitX, fitY, fitZ);
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity,
    d0 = Infinity,
    d1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    fitP.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(light.position);
    const x = fitP.dot(fitX),
      y = fitP.dot(fitY),
      d = -fitP.dot(fitZ);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    d0 = Math.min(d0, d);
    d1 = Math.max(d1, d);
  }
  // a square map (three's PCF disk is round in texels) spanning the longer side.
  // The camera sits at the light, so these are offsets from its axis: snap the
  // centre to whole texels.
  const texel = Math.max(x1 - x0, y1 - y0) / size;
  const cx = Math.round((x0 + x1) / 2 / texel) * texel,
    cy = Math.round((y0 + y1) / 2 / texel) * texel;
  const half = (size * texel) / 2;
  cam.left = cx - half;
  cam.right = cx + half;
  cam.bottom = cy - half;
  cam.top = cy + half;
  // casters above the box (a canopy, a tall tree) still land in it
  cam.near = Math.max(0.1, d0 - 25);
  cam.far = d1 + 2;
  cam.up.copy(FIT_UP);
  if (turned) cam.up.negate();
  cam.updateProjectionMatrix();
  if (sh.mapSize.x !== size) sh.mapSize.set(size, size);
  sh.radius = THREE.MathUtils.clamp(softness / texel, 1, 4);
}

// ---------------------------------------------------------------- colour grade

/** A 3D LUT from a display-space grade function (sRGB 0..1 in and out). */
export function makeLut(grade: (rgb: [number, number, number]) => [number, number, number], n = 32) {
  const data = new Uint8Array(n * n * n * 4);
  const c: [number, number, number] = [0, 0, 0];
  let i = 0;
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        c[0] = r / (n - 1);
        c[1] = g / (n - 1);
        c[2] = b / (n - 1);
        const o = grade(c);
        data[i++] = Math.round(THREE.MathUtils.clamp(o[0], 0, 1) * 255);
        data[i++] = Math.round(THREE.MathUtils.clamp(o[1], 0, 1) * 255);
        data[i++] = Math.round(THREE.MathUtils.clamp(o[2], 0, 1) * 255);
        data[i++] = 255;
      }
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export const TONEMAPS: Record<Tonemap, number> = { none: 0, aces: 1, agx: 2, neutral: 3 };

// ---------------------------------------------------------------- shaders

/** half-res linear depth (metres along the view axis): the nearest of each 2×2 */
const Z_DOWN = /* glsl */ `
uniform sampler2D tDepth; uniform vec2 uClip; uniform vec2 uScale;
varying vec2 vUv;
float viewZ(float d) { return (uClip.x * uClip.y) / ((uClip.y - uClip.x) * d - uClip.y); }
void main() {
  ivec2 size = textureSize(tDepth, 0) - 1;
  ivec2 p = ivec2(floor(gl_FragCoord.xy * uScale));
  float d = min(min(texelFetch(tDepth, min(p, size), 0).r, texelFetch(tDepth, min(p + ivec2(1, 0), size), 0).r),
                min(texelFetch(tDepth, min(p + ivec2(0, 1), size), 0).r, texelFetch(tDepth, min(p + ivec2(1, 1), size), 0).r));
  gl_FragColor = vec4(-viewZ(d), 0.0, 0.0, 1.0);
}`;

/**
 * Ambient obscurance on the half-res depth, after SAO (McGuire et al. 2012): a
 * spiral of taps around each pixel, rotated by a 4×4 pattern the blur then
 * averages out exactly. Normals come from the depth itself. Only occluders a
 * clear angle above the surface count (as in HBAO), so the facets of low-poly
 * spheres and depth noise don't darken convex shapes.
 */
const AO_FRAG = /* glsl */ `
uniform sampler2D tZ; uniform vec2 uProj; uniform float uPxPerM; uniform float uRadius; uniform float uIntensity;
uniform int uTaps; uniform float uFar;
varying vec2 vUv;
vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uProj * z, -z); }
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  ivec2 size = textureSize(tZ, 0);
  vec2 texel = 1.0 / vec2(size);
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float zc = texelFetch(tZ, ip, 0).r;
  if (zc > uFar * 0.98) { gl_FragColor = vec4(1.0, zc, 0.0, 1.0); return; }
  vec2 uv = (vec2(ip) + 0.5) * texel;
  vec3 P = viewPos(uv, zc);
  // normal from the depth: per axis, the neighbour on the same surface
  float zl = texelFetch(tZ, clamp(ip - ivec2(1, 0), ivec2(0), size - 1), 0).r;
  float zr = texelFetch(tZ, clamp(ip + ivec2(1, 0), ivec2(0), size - 1), 0).r;
  float zd = texelFetch(tZ, clamp(ip - ivec2(0, 1), ivec2(0), size - 1), 0).r;
  float zu = texelFetch(tZ, clamp(ip + ivec2(0, 1), ivec2(0), size - 1), 0).r;
  vec3 dx = abs(zr - zc) < abs(zc - zl) ? viewPos(uv + vec2(texel.x, 0.0), zr) - P : P - viewPos(uv - vec2(texel.x, 0.0), zl);
  vec3 dy = abs(zu - zc) < abs(zc - zd) ? viewPos(uv + vec2(0.0, texel.y), zu) - P : P - viewPos(uv - vec2(0.0, texel.y), zd);
  vec3 N = normalize(cross(dx, dy));
  float rPx = min(uRadius * uPxPerM / zc, 40.0);
  if (rPx < 1.0) { gl_FragColor = vec4(1.0, zc, 0.0, 1.0); return; }
  float spin = BAYER[(ip.x & 3) * 4 + (ip.y & 3)] / 16.0 * 6.2831853;
  float r2 = uRadius * uRadius;
  float sum = 0.0;
  float n = float(uTaps);
  for (int i = 0; i < 16; i++) {
    if (i >= uTaps) break;
    float a = (float(i) + 0.5) / n;
    float ang = a * 6.2831853 * 3.0 + spin;
    vec2 off = vec2(cos(ang), sin(ang)) * (a * rPx);
    ivec2 q = clamp(ip + ivec2(floor(off + 0.5)), ivec2(0), size - 1);
    float zq = texelFetch(tZ, q, 0).r;
    vec3 v = viewPos((vec2(q) + 0.5) * texel, zq) - P;
    float vv = dot(v, v);
    float cosA = dot(v, N) * inversesqrt(vv + 1e-6);
    sum += max(0.0, cosA - 0.3) * max(0.0, 1.0 - vv / r2);
  }
  float ao = max(0.0, 1.0 - sum / n * uIntensity * 3.5);
  gl_FragColor = vec4(ao, zc, 0.0, 1.0);
}`;

/** 4×4 depth-aware blur: removes the rotation pattern, keeps edges */
const AO_BLUR = /* glsl */ `
uniform sampler2D tAO;
varying vec2 vUv;
void main() {
  ivec2 size = textureSize(tAO, 0) - 1;
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 c = texelFetch(tAO, ip, 0).rg;
  float sum = 0.0, wsum = 0.0;
  for (int y = -2; y < 2; y++)
    for (int x = -2; x < 2; x++) {
      vec2 s = texelFetch(tAO, clamp(ip + ivec2(x, y), ivec2(0), size), 0).rg;
      float w = max(0.0, 1.0 - abs(s.g - c.g) * 8.0 / c.g);
      sum += s.r * w;
      wsum += w;
    }
  gl_FragColor = vec4(wsum > 0.0 ? sum / wsum : c.r, c.g, 0.0, 1.0);
}`;

/**
 * Light shafts (GPU Gems 3, ch. 13): march from each pixel towards the sun over
 * the half-res depth, adding up open sky near the sun.
 */
const SHAFTS = /* glsl */ `
uniform sampler2D tZ; uniform vec2 uSun; uniform float uAspect; uniform float uFar; uniform int uTaps;
varying vec2 vUv;
void main() {
  vec2 d = (uSun - vUv) * 0.9;
  float n = float(uTaps);
  vec2 stepv = d / n;
  // a per-pixel start offset trades banding for fine noise the upsample softens
  vec2 p = vUv + stepv * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float sum = 0.0, decay = 1.0, wsum = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= uTaps) break;
    float sky = step(uFar * 0.98, texture2D(tZ, p).r);
    // only the sky close around the sun shines: a wide source is haze, not rays
    float glow = exp(-length((p - uSun) * vec2(uAspect, 1.0)) * 11.0);
    sum += sky * glow * decay;
    wsum += decay;
    decay *= 0.965;
    p += stepv;
  }
  gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

/**
 * Depth of field: a gather over a golden-angle disc at half res, each tap
 * weighed by whether its own blur reaches this pixel (so a sharp subject
 * doesn't smear onto the background).
 */
const DOF = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tZ; uniform float uFocus; uniform float uAperture; uniform float uMaxR;
varying vec2 vUv;
float coc(float z) { return clamp(uAperture * abs(z - uFocus) / max(z, 1e-3), 0.0, uMaxR); }
void main() {
  vec2 texel = 1.0 / vec2(textureSize(tZ, 0));
  float zc = texture2D(tZ, vUv).r;
  float cc = coc(zc);
  vec3 col = texture2D(tScene, vUv).rgb;
  float tot = 1.0;
  for (int i = 1; i < 28; i++) {
    float a = float(i) * 2.3999632;
    float r = sqrt(float(i) / 27.0) * uMaxR;
    vec2 tc = vUv + vec2(cos(a), sin(a)) * texel * r;
    float zs = texture2D(tZ, tc).r;
    float cs = coc(zs);
    if (zs > zc) cs = min(cs, cc * 2.0);
    float m = smoothstep(r - 1.0, r + 1.0, cs);
    col += mix(col / tot, texture2D(tScene, tc).rgb, m);
    tot += 1.0;
  }
  gl_FragColor = vec4(col / tot, cc);
}`;

// ---------------------------------------------------------------- the pipeline

const tmpV = new THREE.Vector3();
/** a focus to compile the DOF pass with while priming */
const DOF_PRIME: DofState = { focus: 10 };

/**
 * A world's extra screen passes. It runs after the scene is drawn into the
 * world's buffer (colour + depth) and hands its results to the final pass.
 */
export class PostFX {
  tier = FX_TIERS.length - 1;
  /** true while priming: run every pass once so all of them compile behind the loader */
  priming = false;
  /** focus for depth of field, or null */
  dof: DofState | null = null;
  private zRT = makeRT(1, 1, { format: THREE.RedFormat, filter: THREE.NearestFilter });
  private aoRT = makeRT(1, 1, { format: THREE.RGFormat, filter: THREE.NearestFilter });
  private aoBlurRT = makeRT(1, 1, { format: THREE.RGFormat, filter: THREE.NearestFilter });
  private shaftRT = makeRT(1, 1, { format: THREE.RedFormat });
  private dofRT = makeRT(1, 1);
  private zPass = new Pass(Z_DOWN, { tDepth: { value: null }, uClip: { value: new THREE.Vector2(0.1, 1000) }, uScale: { value: new THREE.Vector2(2, 2) } });
  private aoPass = new Pass(AO_FRAG, {
    tZ: { value: null },
    uProj: { value: new THREE.Vector2(1, 1) },
    uPxPerM: { value: 100 },
    uRadius: { value: 0.8 },
    uIntensity: { value: 1 },
    uTaps: { value: 12 },
    uFar: { value: 1000 },
  });
  private blurPass = new Pass(AO_BLUR, { tAO: { value: null } });
  private shaftPass = new Pass(SHAFTS, { tZ: { value: null }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 }, uFar: { value: 1000 }, uTaps: { value: 24 } });
  private dofPass = new Pass(DOF, { tScene: { value: null }, tZ: { value: null }, uFocus: { value: 10 }, uAperture: { value: 1 }, uMaxR: { value: 8 } });
  private W = 1;
  private H = 1;
  /** where the sun is on screen this frame (uv), and whether it's in front */
  private sunUv = new THREE.Vector2();

  constructor(
    public def: WorldEffects,
    private final: Pass,
  ) {
    this.aoPass.mat.name = 'fx.ao';
    this.blurPass.mat.name = 'fx.aoBlur';
    this.zPass.mat.name = 'fx.z';
    this.shaftPass.mat.name = 'fx.shafts';
    this.dofPass.mat.name = 'fx.dof';
    const f = final.u;
    const ao = def.ao;
    if (ao) {
      this.aoPass.u.uRadius.value = ao.radius ?? 0.8;
      this.aoPass.u.uIntensity.value = ao.intensity ?? 1;
      f.uAOProtect.value = ao.protectLit ?? 0.5;
    }
    if (def.sun) f.uSunColor.value.copy(def.sun.color);
  }

  get fxTier() {
    return FX_TIERS[this.tier];
  }

  // this frame's plan (see plan())
  private useAO = false;
  private useShafts = false;
  private useFlare = false;
  private useDof = false;

  /**
   * Before the scene is drawn: which passes this frame needs. Returns whether
   * the scene's depth must be resolved (an MSAA depth resolve costs about a
   * full-screen pass, so only when something reads it).
   */
  plan(cam: THREE.PerspectiveCamera) {
    const t = this.fxTier;
    const all = this.priming;
    const def = this.def;
    const f = this.final.u;
    // the sun: in view for the glare, or close enough for its rays to stream in
    let inView = false,
      near = false;
    if (def.sun) {
      tmpV.copy(def.sun.dir).normalize().multiplyScalar(1000).add(cam.position).project(cam);
      const front = tmpV.z < 1;
      const out = Math.max(Math.abs(tmpV.x), Math.abs(tmpV.y));
      inView = front && out < 1.05;
      near = front && out < 1.4;
      this.sunUv.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5);
      f.uSun.value.set(this.sunUv.x, this.sunUv.y, near ? THREE.MathUtils.clamp((1.4 - out) / 0.4, 0, 1) : 0);
    }
    this.useAO = !!def.ao && (t.ao > 0 || all);
    this.useShafts = !!def.sun?.shafts && ((t.shafts > 0 && near) || all);
    this.useFlare = !!def.sun?.flare && (inView || all);
    this.useDof = !!def.dof && (!!this.dof || all);
    // (priming runs every pass to compile it, but shows only what this frame would)
    f.uAO.value = this.useAO && t.ao > 0 ? (def.ao!.strength ?? 0.6) : 0;
    f.uShafts.value = this.useShafts && t.shafts > 0 && near ? def.sun!.shafts! * f.uSun.value.z : 0;
    f.uFlare.value = this.useFlare && inView ? def.sun!.flare! : 0;
    f.uDof.value = this.useDof && this.dof ? 1 : 0;
    return this.useAO || this.useShafts || this.useFlare || this.useDof;
  }

  setSize(W: number, H: number) {
    this.W = W;
    this.H = H;
    this.fit();
  }

  setTier(t: number) {
    const was = this.fxTier;
    this.tier = Math.max(0, Math.min(FX_TIERS.length - 1, t));
    const now = this.fxTier;
    // buffers a lower tier doesn't use go back; they return on first use
    if (!now.ao) {
      this.aoRT.dispose();
      this.aoBlurRT.dispose();
    }
    if (!now.shafts) this.shaftRT.dispose();
    if (was.aoScale !== now.aoScale || was.shaftScale !== now.shaftScale) this.fit();
  }

  private fit() {
    const t = this.fxTier;
    const hw = Math.max(1, Math.floor(this.W / 2)),
      hh = Math.max(1, Math.floor(this.H / 2));
    this.zRT.setSize(hw, hh);
    this.zPass.u.uScale.value.set(this.W / hw, this.H / hh);
    const aw = Math.max(1, Math.floor(this.W * t.aoScale)),
      ah = Math.max(1, Math.floor(this.H * t.aoScale));
    this.aoRT.setSize(aw, ah);
    this.aoBlurRT.setSize(aw, ah);
    this.shaftRT.setSize(Math.max(1, Math.floor(this.W * t.shaftScale)), Math.max(1, Math.floor(this.H * t.shaftScale)));
    this.dofRT.setSize(hw, hh);
    this.final.u.uAORes.value.set(aw, ah);
  }

  /**
   * After the scene is drawn into `src` (with its depth resolved if plan() asked):
   * run the planned passes and hand their results to the final pass.
   */
  render(r: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, cam: THREE.PerspectiveCamera) {
    const f = this.final.u;
    const t = this.fxTier;
    const def = this.def;
    if (!(this.useAO || this.useShafts || this.useFlare || this.useDof)) return;
    f.uClip.value.set(cam.near, cam.far);
    f.tDepth.value = src.depthTexture;
    // half-res linear depth, shared by everything below
    const z = this.zPass.u;
    z.tDepth.value = src.depthTexture;
    z.uClip.value.set(cam.near, cam.far);
    this.zPass.render(r, this.zRT);
    f.tZ.value = this.zRT.texture;
    if (this.useAO) {
      const a = this.aoPass.u;
      a.tZ.value = this.zRT.texture;
      a.uProj.value.set(1 / cam.projectionMatrix.elements[0], 1 / cam.projectionMatrix.elements[5]);
      // half-res pixels per metre at 1 m: the AO buffer's height over the view's height in metres at z = 1
      a.uPxPerM.value = (cam.projectionMatrix.elements[5] * this.aoRT.height) / 2;
      a.uTaps.value = Math.max(4, t.ao || 8);
      a.uFar.value = cam.far;
      this.aoPass.render(r, this.aoRT);
      this.blurPass.u.tAO.value = this.aoRT.texture;
      this.blurPass.render(r, this.aoBlurRT);
      f.tAO.value = this.aoBlurRT.texture;
    }
    if (this.useShafts) {
      const s = this.shaftPass.u;
      s.tZ.value = this.zRT.texture;
      s.uSun.value.copy(this.sunUv);
      s.uAspect.value = cam.aspect;
      s.uFar.value = cam.far;
      s.uTaps.value = Math.max(8, t.shafts || 16);
      this.shaftPass.render(r, this.shaftRT);
      f.tShafts.value = this.shaftRT.texture;
    }
    if (this.useDof) {
      const d = this.dofPass.u;
      const st = this.dof ?? DOF_PRIME;
      d.tScene.value = src.texture;
      d.tZ.value = this.zRT.texture;
      d.uFocus.value = st.focus;
      // blur radius in half-res pixels: scaled with the buffer so it looks the same at any resolution
      d.uMaxR.value = Math.max(2, this.dofRT.height / 90);
      d.uAperture.value = (st.aperture ?? 1) * d.uMaxR.value * 1.6;
      this.dofPass.render(r, this.dofRT);
      f.tDof.value = this.dofRT.texture;
      f.uDofFocus.value.set(st.focus, d.uAperture.value / d.uMaxR.value);
    }
  }

  dispose() {
    for (const rt of [this.zRT, this.aoRT, this.aoBlurRT, this.shaftRT, this.dofRT]) rt.dispose();
    for (const p of [this.zPass, this.aoPass, this.blurPass, this.shaftPass, this.dofPass]) p.dispose();
  }
}

// ---------------------------------------------------------------- rim light

/**
 * A soft sunlit rim on a lit material (standard, toon, lambert…): Fresnel at the
 * silhouette, strongest on the side towards the first directional light and when
 * that light is behind the object — so backlit characters still read as round.
 * A few ALU ops per pixel; share one options object per look (it keys the program).
 */
export function sunRim<M extends THREE.Material>(m: M, o: { color: THREE.Color; strength: number; power?: number; sky?: number }) {
  const pw = (o.power ?? 3).toFixed(1);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = { value: o.color };
    sh.uniforms.uRim = { value: o.strength };
    sh.uniforms.uRimSky = { value: o.sky ?? 0.15 };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor; uniform float uRim; uniform float uRimSky;')
      .replace(
        '#include <opaque_fragment>',
        `{
          vec3 vd = normalize(vViewPosition);
          float fr = pow(1.0 - clamp(dot(normal, vd), 0.0, 1.0), ${pw});
          #if NUM_DIR_LIGHTS > 0
            vec3 L = directionalLights[0].direction;
            float back = clamp(-dot(vd, L), 0.0, 1.0);
            float side = clamp(dot(normal, L) * 0.6 + 0.4, 0.0, 1.0);
            outgoingLight += uRimColor * fr * side * (0.3 + 0.7 * back) * uRim;
          #endif
          outgoingLight += diffuseColor.rgb * fr * uRimSky;
        }
        #include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `sunrim-${pw}`;
  return m;
}

// ---------------------------------------------------------------- contact shadows

const CONTACT_VERT = /* glsl */ `
attribute float aStrength;
varying vec2 vUv;
varying float vS;
void main() {
  vUv = uv;
  vS = aStrength;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const CONTACT_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
varying float vS;
void main() {
  float d = length(vUv * 2.0 - 1.0);
  // dark right up to the shoe's edge (the shoe covers the core), soft beyond
  float a = vS * pow(1.0 - smoothstep(0.3, 1.0, d), 1.3);
  // multiplied onto whatever is below (see the blending below)
  gl_FragColor = vec4(mix(vec3(1.0), uColor, a), 1.0);
}`;

/** One soft dark ellipse under each foot, fading as the foot leaves the ground. */
export class ContactShadows {
  mesh: THREE.InstancedMesh;
  private base: number;
  private strength: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private e = new THREE.Euler();
  constructor(
    def: ContactDef,
    private max = 16,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.strength = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.strength.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aStrength', this.strength);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: (def.color ?? new THREE.Color('#3a3450')).clone() } },
      vertexShader: CONTACT_VERT,
      fragmentShader: CONTACT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mat.name = 'fx.contact';
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.count = 0;
    this.mesh.userData.noNormals = true;
    this.mesh.userData.noOutline = true;
    this.base = def.strength ?? 0.5;
  }

  /**
   * Place the shadows from the poses (feet are direct children of the rig root,
   * so their spot on the ground needs no matrices). `floors[i]` = the ground's
   * height under rig i (the blob shadow's), or null when it has none.
   */
  update(rigs: { scale: number; shadow: THREE.Object3D; root: THREE.Object3D }[], poses: { x: number; z: number; yaw: number; hop: number; feet: { x: number; y: number; z: number }[]; footPitch: number[] }[]) {
    let n = 0;
    for (let i = 0; i < rigs.length && i < poses.length; i++) {
      const rig = rigs[i];
      const p = poses[i];
      if (!rig.root.visible || !rig.shadow.visible) continue;
      const floor = rig.shadow.position.y - 0.012;
      const s = rig.scale;
      const c = Math.cos(p.yaw),
        sn = Math.sin(p.yaw);
      for (let k = 0; k < 2 && n < this.max; k++) {
        const f = p.feet[k];
        // the shoe sits a little behind the foot's origin
        const lx = f.x * s,
          lz = (f.z - 0.03) * s;
        const h = p.hop + f.y * s - floor;
        const a = this.base * (1 - THREE.MathUtils.smoothstep(h, 0.0, 0.28));
        if (a < 0.01) continue;
        this.p.set(p.x + c * lx + sn * lz, floor + 0.013, p.z - sn * lx + c * lz);
        this.e.set(0, p.yaw, 0);
        this.q.setFromEuler(this.e);
        const grow = 1 + h * 2.5;
        this.s.set(0.26 * s * grow, 1, 0.42 * s * grow);
        this.m.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(n, this.m);
        this.strength.setX(n, a);
        n++;
      }
    }
    this.mesh.count = n;
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.strength.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
