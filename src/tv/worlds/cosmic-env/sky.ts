// Starfall's sky: a nebula baked once into a cube map (rich domain-warped gas,
// dust lanes, a galactic band, a distant spiral — far more than could be worked
// out per pixel every frame), over which stars twinkle, the system's own star
// burns with its glare, nearer stars drift past with parallax as the camera
// moves, and now and then a shooting star falls.

import * as THREE from 'three';
import { NOISE } from '../../render/glsl';

type U = { uTime: THREE.IUniform };

const BAKE_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** the nebula, worked out once per texel of the cube */
const BAKE_FRAG = /* glsl */ `
varying vec3 vDir;
${NOISE}
float warp(vec3 p, out vec3 w) {
  w = vec3(fbm3(p + 1.7), fbm3(p + 9.2), fbm3(p + 4.4));
  return fbm3(p * 1.6 + w * 1.9);
}
void main() {
  vec3 d = normalize(vDir);
  // the galactic plane: a band of dense stars, gas and dust across the sky
  vec3 gN = normalize(vec3(0.35, 1.0, 0.45));
  float gb = dot(d, gN);
  float band = exp(-gb * gb * 10.0);
  vec3 w;
  float n = warp(d * 2.1, w);
  float n2 = fbm3(d * 4.7 + w * 2.3 + 13.0);
  float n3 = fbm3(d * 9.0 + w * 1.4 + 5.0);
  vec3 col = vec3(0.004, 0.003, 0.012);
  // violet and magenta gas, teal gas, glowing where it's thickest
  col += vec3(0.32, 0.06, 0.48) * smoothstep(0.4, 0.86, n) * (0.35 + band * 0.9);
  col += vec3(0.5, 0.08, 0.3) * smoothstep(0.62, 0.95, n) * 0.5;
  col += vec3(0.03, 0.22, 0.42) * smoothstep(0.48, 0.9, n2) * (0.3 + band * 0.7);
  // dark dust lanes threading the band
  float dust = smoothstep(0.5, 0.72, n3);
  col *= 1.0 - dust * band * 0.75;
  // unresolved stars: the band's milky glow, grainy
  col += vec3(0.46, 0.42, 0.58) * band * pow(fbm3(d * 22.0 + 3.0), 3.0) * 0.9;
  // hot star-forming cores
  col += vec3(1.0, 0.45, 0.75) * pow(smoothstep(0.72, 1.0, n), 3.0) * 0.9;
  // a small spiral galaxy far off, over the near end (the far views' sky)
  vec3 gc = normalize(vec3(0.3, 0.33, 0.89));
  vec3 gx = normalize(cross(gc, vec3(0.2, 1.0, 0.1))), gy = cross(gc, gx);
  vec2 g = vec2(dot(d, gx), dot(d, gy)) / 0.07;
  g = mat2(1.0, 0.0, 0.4, 0.55) * g;
  float gr = length(g);
  float arms = 0.5 + 0.5 * sin(atan(g.y, g.x) * 2.0 - log(gr + 1e-3) * 4.0);
  col += vec3(0.85, 0.75, 1.0) * (exp(-gr * 3.5) * 1.4 + arms * exp(-gr * 1.3) * 0.25) * step(0.0, dot(d, gc));
  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * Render the nebula into a cube map (sRGB 8-bit: gradients in the dark stay
 * smooth at a quarter of a float cube's memory), with mipmaps.
 */
export function bakeNebula(r: THREE.WebGLRenderer, size = 1024) {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.BackSide, depthWrite: false })));
  const cam = new THREE.CubeCamera(0.1, 100, rt);
  cam.update(r, scene);
  (scene.children[0] as THREE.Mesh).geometry.dispose();
  ((scene.children[0] as THREE.Mesh).material as THREE.Material).dispose();
  return rt;
}

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const DOME_FRAG = /* glsl */ `
uniform float uTime;
uniform samplerCube tNebula;
uniform vec3 uStar;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = textureCube(tNebula, d).rgb;
  // stars, two sizes, twinkling
  vec3 g = floor(d * 420.0);
  float h = hash31(g);
  float st = step(0.9966, h);
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + 3.0 * hash31(g + 5.0)) + hash31(g + 2.0) * 60.0);
  col += st * tw * mix(vec3(0.75, 0.85, 1.3), vec3(1.3, 0.85, 0.9), hash31(g + 7.0)) * 1.7;
  col += step(0.9993, hash31(floor(d * 170.0))) * vec3(2.6, 2.5, 2.8);
  // the system's star: a white-hot disc in a wide glare, with four soft spikes
  float c = max(dot(d, uStar), 0.0);
  float a = acos(min(c, 1.0));
  col += vec3(1.6, 1.5, 1.8) * smoothstep(0.0125, 0.009, a) * 3.0;
  col += vec3(0.9, 0.75, 1.3) * (exp(-a * 38.0) * 1.2 + exp(-a * 6.0) * 0.18);
  vec3 sx = normalize(cross(uStar, vec3(0.0, 1.0, 0.0))), sy = cross(uStar, sx);
  vec2 sp = vec2(dot(d, sx), dot(d, sy));
  col += vec3(0.8, 0.8, 1.2) * (exp(-abs(sp.x) * 300.0) + exp(-abs(sp.y) * 300.0)) * exp(-a * 9.0) * step(0.0, c) * 0.8;
  gl_FragColor = vec4(col, 1.0);
}`;

/** The sky dome: the baked nebula, twinkling stars and the star's glare (`star`: its direction). */
export function spaceDome(u: U, nebula: THREE.Texture, star: THREE.Vector3) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(900, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: { uTime: u.uTime, tNebula: { value: nebula }, uStar: { value: star.clone().normalize() } },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  m.renderOrder = -10;
  m.frustumCulled = false;
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- near stars

const NEAR_VERT = /* glsl */ `
attribute vec2 aStar; // size, phase
uniform float uTime;
uniform float uScale;
varying float vA;
varying float vHue;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.6 + 0.4 * sin(uTime * (1.2 + aStar.y * 2.0) + aStar.y * 40.0);
  gl_PointSize = max(1.0, aStar.x * uScale * 60.0 / -mv.z);
  vA = tw * min(1.0, aStar.x * uScale * 60.0 / -mv.z);
  vHue = fract(aStar.y * 7.3);
}`;

const NEAR_FRAG = /* glsl */ `
varying float vA;
varying float vHue;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;
  vec3 c = mix(vec3(0.7, 0.85, 1.4), vec3(1.4, 0.8, 1.1), vHue);
  gl_FragColor = vec4(c * (1.0 - r) * vA * 1.8, 1.0);
}`;

/**
 * Stars near enough to shift against the sky as the camera moves (a shell 90 to
 * 420 m out, clear of the court): one additive draw of points.
 */
export class NearStars {
  mesh: THREE.Points;
  u: { uTime: THREE.IUniform; uScale: { value: number } };
  private geo: THREE.BufferGeometry;
  private n: number;

  constructor(u: U, count: number, seed = 7) {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pos = new Float32Array(count * 3);
    const star = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const z = rnd() * 2 - 1,
        a = rnd() * Math.PI * 2,
        rr = Math.sqrt(1 - z * z);
      const d = 90 + Math.pow(rnd(), 0.6) * 330;
      pos.set([Math.cos(a) * rr * d, z * d * 0.8, Math.sin(a) * rr * d], i * 3);
      star.set([0.35 + Math.pow(rnd(), 3) * 1.4, rnd()], i * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aStar', new THREE.BufferAttribute(star, 2));
    this.geo = g;
    this.n = count;
    this.u = { uTime: u.uTime, uScale: { value: 1 } };
    this.mesh = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: NEAR_VERT, fragmentShader: NEAR_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -8;
    this.mesh.userData.noBatch = true;
  }

  /** point sizes are in pixels: scale them with the render's height */
  setHeight(h: number) {
    this.u.uScale.value = h / 1080;
  }

  setDetail(d: number) {
    this.geo.setDrawRange(0, Math.round(this.n * (0.4 + 0.6 * d)));
  }
}

// ---------------------------------------------------------------- shooting stars

const SHOOT_VERT = /* glsl */ `
attribute vec4 aShoot; // period, offset, speed (rad/s), length (rad)
uniform float uTime;
varying vec2 vQ;
varying float vLife;
${NOISE}
void main() {
  float cyc = uTime / aShoot.x + aShoot.y;
  float k = floor(cyc);
  float t = fract(cyc) * aShoot.x;
  // each cycle a new start and heading, somewhere up in the sky
  float h1 = hash11(k * 3.7 + aShoot.y * 91.0), h2 = hash11(k * 7.1 + aShoot.y * 13.0), h3 = hash11(k * 1.9 + aShoot.y * 37.0);
  vec3 start = normalize(vec3(cos(h1 * 6.2831), 0.25 + h2 * 0.8, sin(h1 * 6.2831)));
  vec3 side = normalize(cross(start, vec3(0.0, 1.0, 0.0)));
  vec3 dir = normalize(side * (h3 < 0.5 ? 1.0 : -1.0) - vec3(0.0, 0.5, 0.0));
  float life = 0.9;
  vLife = t < life ? sin(t / life * 3.14159) : 0.0;
  float head = t * aShoot.z;
  // the quad: along the trail behind the head (x), a little across (y)
  vec3 along = normalize(start + dir * head);
  vec3 tail = normalize(start + dir * (head - aShoot.w));
  vec3 p = mix(along, tail, position.x) * 800.0;
  vec3 across = normalize(cross(along - tail, along));
  p += across * position.y * 1.6;
  vQ = vec2(position.x, position.y * 2.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p + cameraPosition, 1.0);
}`;

const SHOOT_FRAG = /* glsl */ `
varying vec2 vQ;
varying float vLife;
void main() {
  if (vLife <= 0.0) discard;
  float a = pow(1.0 - vQ.x, 2.0) * (1.0 - smoothstep(0.1, 1.0, abs(vQ.y)));
  gl_FragColor = vec4(vec3(1.3, 1.2, 1.7) * a * vLife * 2.2, 1.0);
}`;

/** A few meteors taking turns streaking across the sky (one additive draw). */
export function shootingStars(u: U, count = 5) {
  const quad = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) a.set([6 + i * 2.3, i * 0.37, 0.35 + (i % 3) * 0.08, 0.08 + (i % 2) * 0.04], i * 4);
  g.setAttribute('aShoot', new THREE.InstancedBufferAttribute(a, 4));
  g.instanceCount = count;
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { uTime: u.uTime }, vertexShader: SHOOT_VERT, fragmentShader: SHOOT_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  m.frustumCulled = false;
  m.renderOrder = -7;
  m.userData.noBatch = true;
  return m;
}
