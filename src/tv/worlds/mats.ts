// Material helpers shared by several worlds.

import * as THREE from 'three';
import { stringTexture } from '../chars/rig';

const gradients = new Map<string, THREE.DataTexture>();

export function toonGradient(levels: number[]) {
  const key = levels.join(',');
  let t = gradients.get(key);
  if (t) return t;
  const data = new Uint8Array(levels.length * 4);
  levels.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  t = new THREE.DataTexture(data, levels.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  gradients.set(key, t);
  return t;
}

export interface ToonOpts {
  gradient?: number[];
  rim?: number;
  rimColor?: THREE.Color;
  rimPower?: number;
  emissive?: THREE.Color;
  map?: THREE.Texture;
  side?: THREE.Side;
  vertexColors?: boolean;
  /** subtle procedural surface noise (0..1) */
  grain?: number;
  fog?: boolean;
  transparent?: boolean;
  opacity?: number;
}

/** Cel-shaded material with an optional rim light. */
export function toon(color: THREE.ColorRepresentation, o: ToonOpts = {}) {
  const m = new THREE.MeshToonMaterial({
    color,
    gradientMap: toonGradient(o.gradient ?? [110, 190, 255]),
    map: o.map ?? null,
    side: o.side ?? THREE.FrontSide,
    vertexColors: !!o.vertexColors,
    emissive: o.emissive ?? new THREE.Color(0, 0, 0),
    fog: o.fog ?? true,
    transparent: !!o.transparent,
    opacity: o.opacity ?? 1,
  });
  const rim = o.rim ?? 0;
  const grain = o.grain ?? 0;
  if (rim > 0 || grain > 0) {
    const rimColor = o.rimColor ?? new THREE.Color(1, 1, 1);
    const pw = o.rimPower ?? 3;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uRimColor = { value: rimColor };
      sh.uniforms.uRim = { value: rim };
      sh.uniforms.uGrain = { value: grain };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec3 uRimColor; uniform float uRim; uniform float uGrain; varying vec3 vWPos;
          float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`,
        )
        .replace(
          '#include <opaque_fragment>',
          `{
            vec3 vd = normalize(vViewPosition);
            float fr = pow(1.0 - clamp(dot(normal, vd), 0.0, 1.0), ${pw.toFixed(1)});
            outgoingLight += uRimColor * smoothstep(0.45, 0.7, fr) * uRim;
            if (uGrain > 0.0) outgoingLight *= 1.0 - uGrain * gHash(floor(vWPos * 60.0));
          }
          #include <opaque_fragment>`,
        );
    };
    m.customProgramCacheKey = () => `toon-rim-${pw}-${grain > 0}`;
  }
  return m;
}

export function flat(color: THREE.ColorRepresentation, o: { fog?: boolean; side?: THREE.Side; transparent?: boolean; opacity?: number } = {}) {
  return new THREE.MeshBasicMaterial({ color, fog: o.fog ?? true, side: o.side ?? THREE.FrontSide, transparent: !!o.transparent, opacity: o.opacity ?? 1 });
}

export function stringsMat(color: THREE.Color, o: { fog?: boolean } = {}) {
  return new THREE.MeshBasicMaterial({
    color,
    alphaMap: stringTexture(),
    transparent: true,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: o.fog ?? true,
  });
}

/** Vertical gradient sky dome with a sun glow. */
export function skyDome(top: THREE.Color, horizon: THREE.Color, opts: { sunDir?: THREE.Vector3; sunColor?: THREE.Color; sunSize?: number; ground?: THREE.Color; radius?: number; stars?: number; bands?: number } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: top },
      uHorizon: { value: horizon },
      uGround: { value: opts.ground ?? horizon.clone().multiplyScalar(0.8) },
      uSunDir: { value: (opts.sunDir ?? new THREE.Vector3(0.3, 0.5, -1)).clone().normalize() },
      uSun: { value: opts.sunColor ?? new THREE.Color(1, 0.95, 0.8) },
      uSunSize: { value: opts.sunSize ?? 0.02 },
      uStars: { value: opts.stars ?? 0 },
      uBands: { value: opts.bands ?? 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHorizon, uGround, uSun; uniform vec3 uSunDir; uniform float uSunSize, uStars, uBands, uTime;
      varying vec3 vDir;
      float h(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 col = y > 0.0 ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.85, y), 0.8)) : mix(uHorizon, uGround, smoothstep(0.0, -0.2, y));
        if (uBands > 0.0) col = floor(col * uBands + 0.5) / uBands;
        float s = max(dot(d, uSunDir), 0.0);
        col += uSun * (smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.6, s) + pow(s, 64.0) * 0.35 + pow(s, 8.0) * 0.12);
        if (uStars > 0.0 && y > 0.0) {
          vec3 g = floor(d * 380.0);
          float st = step(0.9975, h(g)) * (0.6 + 0.4 * sin(uTime * 2.0 + h(g + 3.1) * 40.0));
          col += st * uStars * smoothstep(0.0, 0.3, y);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(opts.radius ?? 400, 32, 16), mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

/** Canvas helper. */
export function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
