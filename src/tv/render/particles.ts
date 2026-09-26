// Billboard particles (sparks, dust, confetti, ink drops, pixels…).

import * as THREE from 'three';
import { NOISE } from './glsl';

export type Shape = 'soft' | 'star' | 'square' | 'ink' | 'confetti' | 'ring' | 'petal';
const SHAPES: Record<Shape, number> = { soft: 0, star: 1, square: 2, ink: 3, confetti: 4, ring: 5, petal: 6 };

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  size1: number;
  rot: number;
  vr: number;
  r: number;
  g: number;
  b: number;
  a: number;
  grav: number;
  drag: number;
  shape: number;
  ground: boolean;
}

export interface Burst {
  x: number;
  y: number;
  z: number;
  count: number;
  speed: [number, number];
  /** preferred direction (normalised) and spread 0..1 */
  dir?: [number, number, number];
  spread?: number;
  life: [number, number];
  size: [number, number];
  /** size multiplier at end of life */
  shrink?: number;
  colors: THREE.Color[];
  gravity?: number;
  drag?: number;
  shape?: Shape;
  spin?: number;
  alpha?: number;
  /** stick to the ground when landing */
  ground?: boolean;
}

export class Particles {
  mesh: THREE.Mesh;
  private list: P[] = [];
  private geo: THREE.InstancedBufferGeometry;
  private aPos: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aDat: THREE.InstancedBufferAttribute;
  mat: THREE.ShaderMaterial;

  constructor(
    public max = 600,
    opts: { additive?: boolean; fog?: boolean } = {},
  ) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aDat = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aDat.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aCol', this.aCol);
    this.geo.setAttribute('aDat', this.aDat);
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: /* glsl */ `
        attribute vec3 aPos; attribute vec4 aCol; attribute vec3 aDat;
        varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vSeed;
        #include <common>
        #include <fog_pars_vertex>
        void main() {
          vUv = uv; vCol = aCol; vShape = aDat.z; vSeed = fract(aPos.x * 13.1 + aPos.z * 7.7);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float c = cos(aDat.y), s = sin(aDat.y);
          vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aDat.x;
          vec3 wp = aPos + right * q.x + up * q.y;
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vSeed;
        #include <common>
        #include <fog_pars_fragment>
        ${NOISE}
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float a = 0.0;
          int sh = int(vShape + 0.5);
          if (sh == 0) a = smoothstep(1.0, 0.0, r);
          else if (sh == 1) { float st = abs(p.x * p.y); a = smoothstep(0.08, 0.0, st) * smoothstep(1.0, 0.2, r) + smoothstep(0.35, 0.0, r); }
          else if (sh == 2) a = 1.0;
          else if (sh == 3) { float n = vnoise(p * 3.0 + vSeed * 40.0); a = smoothstep(0.75, 0.6, r + (n - 0.5) * 0.5); }
          else if (sh == 4) a = step(abs(p.y), 0.45);
          else if (sh == 5) a = smoothstep(0.2, 0.0, abs(r - 0.75));
          else if (sh == 6) { vec2 q = p * vec2(1.0, 1.7); a = smoothstep(1.0, 0.8, length(q - vec2(0.0, 0.1)) + abs(p.x) * 0.3); }
          if (a < 0.01) discard;
          gl_FragColor = vec4(vCol.rgb, vCol.a * a);
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: opts.fog ?? true,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  burst(b: Burst) {
    const shape = SHAPES[b.shape ?? 'soft'];
    for (let i = 0; i < b.count; i++) {
      if (this.list.length >= this.max) this.list.shift();
      let dx = Math.random() * 2 - 1,
        dy = Math.random() * 2 - 1,
        dz = Math.random() * 2 - 1;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l;
      dy /= l;
      dz /= l;
      if (b.dir) {
        const sp = b.spread ?? 0.5;
        dx = b.dir[0] * (1 - sp) + dx * sp;
        dy = b.dir[1] * (1 - sp) + dy * sp;
        dz = b.dir[2] * (1 - sp) + dz * sp;
        const l2 = Math.hypot(dx, dy, dz) || 1;
        dx /= l2;
        dy /= l2;
        dz /= l2;
      }
      const sp = b.speed[0] + Math.random() * (b.speed[1] - b.speed[0]);
      const c = b.colors[Math.floor(Math.random() * b.colors.length)];
      const life = b.life[0] + Math.random() * (b.life[1] - b.life[0]);
      const size = b.size[0] + Math.random() * (b.size[1] - b.size[0]);
      this.list.push({
        x: b.x,
        y: b.y,
        z: b.z,
        vx: dx * sp,
        vy: dy * sp,
        vz: dz * sp,
        life,
        max: life,
        size,
        size1: size * (b.shrink ?? 0),
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() * 2 - 1) * (b.spin ?? 2),
        r: c.r,
        g: c.g,
        b: c.b,
        a: b.alpha ?? 1,
        grav: b.gravity ?? 0,
        drag: b.drag ?? 1.5,
        shape,
        ground: !!b.ground,
      });
    }
  }

  update(dt: number) {
    const L = this.list;
    let w = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy = p.vy * d - p.grav * dt;
      p.vz *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.ground && p.y < 0.02) {
        p.y = 0.02;
        p.vy = 0;
        p.vx *= 0.5;
        p.vz *= 0.5;
        p.vr *= 0.5;
      }
      p.rot += p.vr * dt;
      L[w++] = p;
    }
    L.length = w;
    const pos = this.aPos.array as Float32Array;
    const col = this.aCol.array as Float32Array;
    const dat = this.aDat.array as Float32Array;
    for (let i = 0; i < w; i++) {
      const p = L[i];
      const u = 1 - p.life / p.max;
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      const fade = Math.min(1, p.life / Math.min(0.25, p.max * 0.5));
      col[i * 4] = p.r;
      col[i * 4 + 1] = p.g;
      col[i * 4 + 2] = p.b;
      col[i * 4 + 3] = p.a * fade;
      dat[i * 3] = p.size + (p.size1 - p.size) * u;
      dat[i * 3 + 1] = p.rot;
      dat[i * 3 + 2] = p.shape;
    }
    this.geo.instanceCount = w;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aDat.needsUpdate = true;
  }

  clear() {
    this.list.length = 0;
    this.geo.instanceCount = 0;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
