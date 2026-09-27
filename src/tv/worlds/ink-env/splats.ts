// Ink splats where the ball lands: a drop of ink hits the paper, throws a few
// droplets forward, and bleeds outwards along the fibres for a second or two
// before it dries paler and fades. A small pool of decals on the ground (one
// draw); a new splat rewrites one slot, and all the spreading is in the shader.

import * as THREE from 'three';
import { NOISE } from '../../render/glsl';

const VERT = /* glsl */ `
attribute vec4 aSplat;   // x, z, birth time, size
attribute vec4 aSplat2;  // travel direction (radians), seed, red, (unused)
uniform float uTime;
varying vec2 vP;
varying vec4 vS;
void main() {
  float age = uTime - aSplat.z;
  // spent slots collapse to nothing
  float live = step(0.0, age) * step(age, 9.0);
  float c = cos(aSplat2.x), s = sin(aSplat2.x);
  // the quad is 4 splat radii across, stretched along the ball's travel
  vec2 q = position.xy * 4.0 * aSplat.w * live;
  q.x *= 1.35;
  vP = position.xy * 4.0 * vec2(1.35, 1.0);
  vec2 w = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vS = vec4(age, aSplat2.y, aSplat2.z, aSplat.w);
  // just over the court's lines (6 mm), under the ball's shadow (14 mm)
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(aSplat.x + w.x, 0.01, aSplat.y + w.y, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uRed;
uniform vec3 uPaper;
uniform sampler2D tNoise;
varying vec2 vP;
varying vec4 vS;
${NOISE}
void main() {
  float age = vS.x, seed = vS.y;
  // in splat radii; +x is the direction the ball was going
  vec2 p = vP;
  float r = length(p);
  float a = atan(p.y, p.x);
  // the blot bleeds out fast, then creeps along the fibres
  float spread = 1.0 - exp(-age * 5.0);
  float creep = 0.22 * smoothstep(0.0, 2.5, age);
  float lobes = 0.16 * sin(a * 5.0 + seed * 40.0) + 0.1 * sin(a * 9.0 + seed * 17.0) + 0.07 * sin(a * 13.0 + seed * 9.0);
  float fib = texture2D(tNoise, p * 0.18 + seed).r - 0.5;
  float rim = (0.62 + lobes) * spread + creep * (0.6 + fib * 2.6);
  float body = smoothstep(rim + 0.03, rim - 0.03, r);
  // droplets thrown forward, and a few stray ones all round
  float drops = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float h = hash11(seed * 91.0 + fi * 7.3);
    float ang = (i < 4 ? (h - 0.5) * 1.1 : h * 6.2831853);
    float dist = (1.05 + hash11(seed * 13.0 + fi) * 0.8) * smoothstep(0.0, 0.12, age);
    float rad = (0.05 + 0.1 * hash11(seed * 5.0 + fi * 3.1)) * (0.6 + 0.4 * spread);
    vec2 c = vec2(cos(ang), sin(ang)) * dist;
    // droplets land as short streaks along their flight
    vec2 d = p - c;
    vec2 dir = normalize(c);
    float along = dot(d, dir), across = dot(d, vec2(-dir.y, dir.x));
    drops = max(drops, smoothstep(rad, rad * 0.6, length(vec2(along * 0.6, across))));
  }
  float a0 = max(body, drops);
  if (a0 < 0.02) discard;
  // wet ink is black; as it dries it pales towards a grey wash, then fades away
  float dry = smoothstep(2.0, 7.5, age);
  vec3 ink = mix(uInk, uRed, vS.z);
  vec3 col = mix(ink, mix(ink, uPaper, 0.55), dry);
  // pigment gathers at the edge of the blot as it dries
  col = mix(col, ink, smoothstep(rim - 0.12, rim - 0.02, r) * body * dry * 0.8);
  float fade = 1.0 - smoothstep(6.5, 9.0, age);
  gl_FragColor = vec4(col, a0 * fade);
}`;

export class InkSplats {
  mesh: THREE.Mesh;
  private a: THREE.InstancedBufferAttribute;
  private b: THREE.InstancedBufferAttribute;
  private next = 0;
  u = { uTime: { value: 0 }, uInk: { value: new THREE.Color() }, uRed: { value: new THREE.Color() }, uPaper: { value: new THREE.Color() }, tNoise: { value: null as THREE.Texture | null } };

  constructor(
    o: { ink: THREE.Color; red: THREE.Color; paper: THREE.Color; noise: THREE.Texture },
    private max = 24,
  ) {
    this.u.uInk.value.copy(o.ink);
    this.u.uRed.value.copy(o.red);
    this.u.uPaper.value.copy(o.paper);
    this.u.tNoise.value = o.noise;
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    // born long ago: every slot starts spent
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4).fill(-1e4), 4);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.a.setUsage(THREE.DynamicDrawUsage);
    this.b.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aSplat', this.a);
    g.setAttribute('aSplat2', this.b);
    g.instanceCount = max;
    this.mesh = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.u,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        // (the quad's x/y go to the ground's x/z, which mirrors it: it faces down)
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.userData.noBatch = true;
  }

  /** A splat at (x, z), `size` metres (radius), the ball travelling along `dir` (radians in x/z). */
  add(x: number, z: number, size: number, dir: number, red: boolean) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.a.setXYZW(i, x, z, this.u.uTime.value, size);
    this.b.setXYZW(i, dir, Math.random(), red ? 1 : 0, 0);
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
  }

  /** Wipe the paper (a new point). */
  clear() {
    for (let i = 0; i < this.max; i++) this.a.setZ(i, -1e4);
    this.a.needsUpdate = true;
  }

  tick(t: number) {
    this.u.uTime.value = t;
  }
}
