// Neon Drive's sky: a synthwave dusk — indigo overhead, burning magenta and
// orange at the horizon, crossed low down by scan lines that crawl upwards —
// with twinkling stars, and the striped sun sinking behind the far mountains.
// Everything here is HDR (bloom picks out the brightest), and all of it pulses
// with the music's beat (uBeat).

import * as THREE from 'three';
import { NOISE } from '../../render/glsl';

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const DOME_FRAG = /* glsl */ `
uniform float uTime, uBeat;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  // dusk: a hot band on the horizon, magenta, violet, then indigo overhead
  vec3 col = mix(vec3(1.6, 0.42, 0.34), vec3(0.95, 0.1, 0.52), smoothstep(0.0, 0.045, h));
  col = mix(col, vec3(0.28, 0.03, 0.42), smoothstep(0.03, 0.2, h));
  col = mix(col, vec3(0.02, 0.005, 0.07), smoothstep(0.16, 0.62, h));
  // scan lines low in the sky, crowding towards the horizon and crawling up
  float s = log(h + 0.012) * 26.0 - uTime * 0.6;
  float line = smoothstep(0.35, 0.5, abs(fract(s) - 0.5));
  col *= 1.0 - line * 0.55 * (1.0 - smoothstep(0.08, 0.3, h));
  // the horizon glows brighter on the beat
  col += vec3(1.0, 0.25, 0.6) * exp(-h * 55.0) * (0.6 + 1.1 * uBeat);
  // stars: fine and twinkling up high
  vec3 g = floor(d * 330.0);
  float st = step(0.9972, hash31(g));
  float tw = 0.55 + 0.45 * sin(uTime * (2.0 + 3.0 * hash31(g + 7.0)) + hash31(g + 3.0) * 40.0);
  col += st * tw * smoothstep(0.1, 0.4, h) * mix(vec3(0.7, 0.85, 1.4), vec3(1.4, 0.8, 1.2), hash31(g + 1.0)) * 1.6;
  gl_FragColor = vec4(col, 1.0);
}`;

/** The dome (radius 500; drawn behind everything). */
export function neonSky(u: { uTime: THREE.IUniform; uBeat: THREE.IUniform }) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(500, 48, 24),
    new THREE.ShaderMaterial({ uniforms: u, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  m.renderOrder = -10;
  m.frustumCulled = false;
  return m;
}

const SUN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** the sun: yellow to magenta, sliced by bands that thicken towards its foot and scroll down */
const SUN_FRAG = /* glsl */ `
uniform float uTime, uBeat;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  vec3 col = mix(vec3(1.0, 0.05, 0.5), vec3(1.0, 0.66, 0.16), smoothstep(-0.85, 0.75, p.y));
  float y = p.y;
  if (y < 0.3) {
    float band = fract(y * 7.5 + uTime * 0.22);
    float w = mix(0.06, 0.62, smoothstep(0.3, -0.95, y));
    if (band < w) discard;
  }
  // brightest at the top (just into bloom, not blown out), a rim that flares on the beat
  float glow = 1.12 + uBeat * 0.45 + smoothstep(0.2, 1.0, p.y) * 0.4;
  col *= glow * (1.0 - r * 0.15) + smoothstep(0.9, 1.0, r) * uBeat * 1.2;
  gl_FragColor = vec4(col, 1.0);
}`;

const HAZE_FRAG = /* glsl */ `
uniform float uBeat;
varying vec2 vUv;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float g = pow(max(0.0, 1.0 - r), 2.4) * (0.3 + 0.12 * uBeat);
  gl_FragColor = vec4(vec3(1.0, 0.22, 0.62) * g, 1.0);
}`;

/** The sun and the haze round it (two quads facing the court), at `pos`, `radius` across. */
export function neonSun(u: { uTime: THREE.IUniform; uBeat: THREE.IUniform }, pos: THREE.Vector3, radius: number) {
  const g = new THREE.Group();
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), new THREE.ShaderMaterial({ uniforms: u, vertexShader: SUN_VERT, fragmentShader: SUN_FRAG, fog: false, depthWrite: false }));
  sun.renderOrder = -5;
  const haze = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 5.6, radius * 5.6),
    new THREE.ShaderMaterial({ uniforms: u, vertexShader: SUN_VERT, fragmentShader: HAZE_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  haze.position.z = -4;
  haze.renderOrder = -6;
  g.add(haze, sun);
  g.position.copy(pos);
  g.lookAt(0, pos.y, 0);
  return g;
}
