// Camera-facing ribbon that follows the ball.

import * as THREE from 'three';
import { NOISE } from './glsl';

export interface TrailStyle {
  color: THREE.Color;
  color2?: THREE.Color;
  width: number;
  opacity: number;
  additive?: boolean;
  /** 0 smooth, 1 brush (dry-brush streaks), 2 pixel steps */
  mode?: number;
  length?: number;
  /** how far a shot's colour (topspin red, slice blue…) takes over the style's own, 0..1 */
  tint?: number;
}

export class Trail {
  mesh: THREE.Mesh;
  private n: number;
  private pts: THREE.Vector3[] = [];
  private filled = false;
  /** where the newest point sits in `pts` (a ring: the oldest is overwritten by the next one) */
  private head = 0;
  private pos: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private tmp = new THREE.Vector3();
  private side = new THREE.Vector3();
  private strength = 0;
  private lastPush = new THREE.Vector3(1e9, 0, 0);
  private base1: THREE.Color;
  private base2: THREE.Color;
  /** a blazing shot (a smash): the ribbon runs wider and at full strength (1 = normal) */
  boost = 1;

  constructor(public style: TrailStyle) {
    this.base1 = style.color.clone();
    this.base2 = (style.color2 ?? style.color).clone();
    this.n = style.length ?? 22;
    const n = this.n;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3);
    const at = new Float32Array(n * 2 * 2);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      at.set([t, -1, t, 1], i * 4);
    }
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aT', new THREE.BufferAttribute(at, 2));
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: this.base1.clone() },
        uColor2: { value: this.base2.clone() },
        uOpacity: { value: style.opacity },
        uStrength: { value: 0 },
        uMode: { value: style.mode ?? 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec2 aT; varying vec2 vT;
        void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform vec3 uColor2; uniform float uOpacity; uniform float uStrength; uniform int uMode; uniform float uTime;
        varying vec2 vT;
        ${NOISE}
        void main() {
          float t = vT.x;
          float edge = 1.0 - abs(vT.y);
          float a = pow(1.0 - t, 1.4) * smoothstep(0.0, 0.35, edge);
          vec3 col = mix(uColor, uColor2, t);
          if (uMode == 1) {
            float streak = vnoise(vec2(vT.y * 9.0, t * 3.0 + uTime * 0.2));
            a *= smoothstep(0.25 + t * 0.55, 0.6 + t * 0.3, streak + edge * 0.4);
          } else if (uMode == 2) {
            a = step(0.5, a) * step(fract(t * 8.0), 0.8);
          }
          gl_FragColor = vec4(col, a * uOpacity * uStrength);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // a flat ribbon has no back face to sort: one pass (two-pass rebuilds the program every frame)
      forceSinglePass: true,
      blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Take on a shot's colour (null = the style's own), keeping the style's brightness. */
  tint(c: THREE.Color | null) {
    const u = this.mat.uniforms;
    if (!c) {
      u.uColor.value.copy(this.base1);
      u.uColor2.value.copy(this.base2);
      return;
    }
    const k = this.style.tint ?? 0.8;
    const lum = (x: THREE.Color) => Math.max(1, x.r, x.g, x.b);
    u.uColor.value.copy(this.base1).lerp(c.clone().multiplyScalar(lum(this.base1)), k);
    u.uColor2.value.copy(this.base2).lerp(c.clone().multiplyScalar(lum(this.base2) * 0.85), k * 0.8);
  }

  reset(p: THREE.Vector3) {
    if (this.pts.length !== this.n) this.pts = Array.from({ length: this.n }, () => new THREE.Vector3());
    for (const q of this.pts) q.copy(p);
    this.head = 0;
    this.filled = true;
    this.lastPush.copy(p);
  }

  update(p: THREE.Vector3, speed: number, cam: THREE.Camera, dt: number, time: number) {
    if (!this.filled) this.reset(p);
    // teleports (new point, held ball) should not smear
    if (p.distanceTo(this.lastPush) > 4) this.reset(p);
    // the oldest point's vector becomes the newest (nothing allocated per frame)
    const n = this.n;
    this.head = (this.head + n - 1) % n;
    this.pts[this.head].copy(p);
    this.lastPush.copy(p);
    const want = Math.min(1, THREE.MathUtils.clamp((speed - 7) / 14, 0, 1) * this.boost);
    this.strength += (want - this.strength) * Math.min(1, dt * (want > this.strength ? 20 : 6));
    this.mat.uniforms.uStrength.value = this.strength;
    this.mat.uniforms.uTime.value = time;
    const camPos = (cam as THREE.PerspectiveCamera).position;
    const w0 = this.style.width;
    const pos = this.pos;
    const P = this.pts;
    const h = this.head;
    for (let i = 0; i < n; i++) {
      const a = P[(h + Math.max(0, i - 1)) % n];
      const b = P[(h + Math.min(n - 1, i + 1)) % n];
      const q = P[(h + i) % n];
      this.tmp.subVectors(a, b);
      if (this.tmp.lengthSq() < 1e-8) this.tmp.set(1, 0, 0);
      this.side.subVectors(camPos, q).cross(this.tmp).normalize();
      // wider far away so the trail stays readable at the far baseline
      const far = 1 + Math.max(0, q.distanceTo(camPos) - 9) * 0.035;
      const w = w0 * this.boost * (1 - i / (n - 1)) * (0.6 + 0.4 * this.strength) * far;
      const o = i * 6;
      pos[o] = q.x - this.side.x * w;
      pos[o + 1] = q.y - this.side.y * w;
      pos[o + 2] = q.z - this.side.z * w;
      pos[o + 3] = q.x + this.side.x * w;
      pos[o + 4] = q.y + this.side.y * w;
      pos[o + 5] = q.z + this.side.z * w;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
