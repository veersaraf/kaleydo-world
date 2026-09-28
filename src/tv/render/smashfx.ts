// The smash's set pieces in the world: a shockwave ring where the racket meets
// the ball, a ring racing across the court where it lands, and a scorch mark
// (a hot core cooling to a dark crater with cracks) that fades. A handful of
// pooled meshes, each a single quad: nothing is allocated per smash.
//
// Every world draws these through its own pipeline (pixel quantises them, ink
// inks them, watercolour paints them) with colours from its SmashStyle.

import * as THREE from 'three';
import { NOISE } from './glsl';
import type { Shape } from './particles';

export interface SmashStyle {
  /** flames streaming off the ball in flight */
  fire: THREE.Color[];
  fireShape: Shape;
  /** the burst at contact and at the bounce */
  sparks: THREE.Color[];
  sparkShape: Shape;
  /** the shockwave rings */
  ring: THREE.Color;
  /** rings add light (glowing worlds) rather than paint over */
  additive: boolean;
  /** the crater: its hot core and the burnt mark it cools to */
  hot: THREE.Color;
  scorch: THREE.Color;
  scorchAlpha: number;
  /** dust thrown up by the impact */
  dust: THREE.Color[];
  dustShape: Shape;
  /** the flash colour at contact */
  flash: THREE.Color;
}

const c = (x: string, k = 1) => new THREE.Color(x).multiplyScalar(k);

export const FIRE_STYLE: SmashStyle = {
  fire: [c('#ffe27a'), c('#ffae2e'), c('#ff6a1f'), c('#fff6d6')],
  fireShape: 'soft',
  sparks: [c('#fff4b8'), c('#ffc23d'), c('#ff7a1a'), c('#ffffff')],
  sparkShape: 'star',
  ring: c('#fff0b8'),
  additive: false,
  hot: c('#ff8a2a'),
  scorch: c('#241408'),
  scorchAlpha: 0.62,
  dust: [c('#efe4d2')],
  dustShape: 'soft',
  flash: c('#fff1c9'),
};

const RING_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uThick; uniform float uGlow; varying vec2 vUv;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float ring = smoothstep(1.0 - uThick, 1.0 - uThick * 0.35, r) * (1.0 - smoothstep(0.94, 1.0, r));
  float glow = (1.0 - smoothstep(0.2, 1.0, r)) * uGlow;
  float a = (ring + glow) * uAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}`;

const SCORCH_FRAG = /* glsl */ `
uniform vec3 uColor; uniform vec3 uHot; uniform float uAlpha; uniform float uHeat; uniform float uSeed; varying vec2 vUv;
${NOISE}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  // a ragged crater edge, burnt rays (cracks) out past it, a darker rim
  float edge = 0.42 + 0.2 * vnoise(vec2(a * 2.6 + uSeed, uSeed * 3.1)) + 0.08 * vnoise(vec2(a * 9.0, uSeed));
  float disc = smoothstep(edge + 0.04, edge - 0.18, r);
  float crack = pow(max(0.0, cos(a * 5.0 + uSeed + vnoise(vec2(r * 5.0, uSeed)) * 2.2)), 26.0);
  crack += pow(max(0.0, cos(a * 8.0 - uSeed * 2.0 + vnoise(vec2(r * 7.0, uSeed + 4.0)) * 2.5)), 40.0) * 0.8;
  crack *= smoothstep(0.98, edge, r) * step(edge - 0.1, r);
  float rim = smoothstep(0.1, 0.0, abs(r - edge * 0.92)) * 0.35;
  float mottled = 0.75 + 0.25 * vnoise(p * 7.0 + uSeed);
  float alpha = clamp(max(disc * mottled + rim, crack * 0.85), 0.0, 1.0) * uAlpha;
  // the core glows while it's hot, then cools to the burnt colour
  float core = smoothstep(edge * 0.95, 0.0, r);
  vec3 col = mix(uColor, uHot, clamp(uHeat * (core * 1.2 + crack * 0.8), 0.0, 1.0));
  alpha = max(alpha, uHeat * core * uAlpha);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col, alpha);
}`;

interface Piece {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  t: number;
  life: number;
  size: number;
  strength: number;
}

export class SmashFx {
  group = new THREE.Group();
  private shocks: Piece[] = [];
  private grounds: Piece[] = [];
  private scorches: Piece[] = [];
  private next = { shock: 0, ground: 0, scorch: 0 };

  constructor(public style: SmashStyle) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const ring = (flat: boolean) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: style.ring.clone() }, uAlpha: { value: 0 }, uThick: { value: 0.2 }, uGlow: { value: 0 } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: style.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        polygonOffset: flat,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = flat ? 2 : 7;
      if (flat) mesh.rotation.x = -Math.PI / 2;
      this.group.add(mesh);
      return { mesh, mat, t: 0, life: 0, size: 1, strength: 1 };
    };
    for (let i = 0; i < 2; i++) this.shocks.push(ring(false));
    for (let i = 0; i < 3; i++) this.grounds.push(ring(true));
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: style.scorch.clone() }, uHot: { value: style.hot.clone() }, uAlpha: { value: 0 }, uHeat: { value: 0 }, uSeed: { value: 0 } },
        vertexShader: RING_VERT,
        fragmentShader: SCORCH_FRAG,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.scorches.push({ mesh, mat, t: 0, life: 0, size: 1, strength: 1 });
    }
  }

  private take(list: Piece[], key: 'shock' | 'ground' | 'scorch') {
    const p = list[this.next[key] % list.length];
    this.next[key]++;
    return p;
  }

  /** The racket meets the ball: a shockwave in the air (strength 0..1). */
  shock(x: number, y: number, z: number, strength = 1) {
    for (let i = 0; i < (strength > 0.7 ? 2 : 1); i++) {
      const p = this.take(this.shocks, 'shock');
      p.mesh.position.set(x, y, z);
      p.t = -i * 0.07;
      p.life = 0.42 + i * 0.08;
      p.size = (2.6 + strength * 2.2) * (i ? 1.5 : 1);
      p.strength = strength * (i ? 0.6 : 1);
      p.mat.uniforms.uThick.value = i ? 0.1 : 0.22;
      p.mat.uniforms.uGlow.value = i ? 0 : 0.35;
      p.mesh.visible = true;
    }
  }

  /** The smash lands: a ring races out over the court, and a crater is left. */
  impact(x: number, z: number, strength = 1) {
    for (let i = 0; i < 2; i++) {
      const p = this.take(this.grounds, 'ground');
      p.mesh.position.set(x, 0.02 + i * 0.002, z);
      p.t = -i * 0.09;
      p.life = 0.55 + i * 0.15;
      p.size = (4.5 + strength * 3.5) * (i ? 1.5 : 1);
      p.strength = strength * (i ? 0.6 : 1);
      p.mat.uniforms.uThick.value = i ? 0.12 : 0.26;
      p.mat.uniforms.uGlow.value = i ? 0 : 0.4;
      p.mesh.visible = true;
    }
    const s = this.take(this.scorches, 'scorch');
    s.mesh.position.set(x, 0.016, z);
    s.mesh.rotation.z = Math.random() * Math.PI * 2;
    s.t = 0;
    s.life = 5.5;
    s.size = 2 + strength * 1.4;
    s.strength = strength;
    s.mat.uniforms.uSeed.value = Math.random() * 50;
    s.mesh.scale.setScalar(s.size);
    s.mesh.visible = true;
  }

  update(dt: number, cam: THREE.Camera) {
    for (const p of this.shocks) {
      if (!p.mesh.visible) continue;
      p.t += dt;
      const u = Math.max(0, p.t) / p.life;
      if (u >= 1) {
        p.mesh.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - u, 3);
      p.mesh.scale.setScalar(0.2 + p.size * e);
      p.mesh.quaternion.copy(cam.quaternion);
      p.mat.uniforms.uAlpha.value = p.t < 0 ? 0 : p.strength * (1 - u) * (1 - u) * 1.1;
    }
    for (const p of this.grounds) {
      if (!p.mesh.visible) continue;
      p.t += dt;
      const u = Math.max(0, p.t) / p.life;
      if (u >= 1) {
        p.mesh.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - u, 2.4);
      p.mesh.scale.setScalar(0.3 + p.size * e);
      p.mat.uniforms.uAlpha.value = p.t < 0 ? 0 : p.strength * (1 - u) * 1.05;
    }
    for (const p of this.scorches) {
      if (!p.mesh.visible) continue;
      p.t += dt;
      const u = p.t / p.life;
      if (u >= 1) {
        p.mesh.visible = false;
        continue;
      }
      // punches in, glows, cools, and fades out over the last seconds
      const grow = Math.min(1, p.t / 0.12);
      p.mesh.scale.setScalar(p.size * (0.6 + 0.4 * grow));
      p.mat.uniforms.uHeat.value = Math.max(0, 1 - p.t / 0.9);
      p.mat.uniforms.uAlpha.value = this.style.scorchAlpha * Math.min(1, u < 0.6 ? 1 : (1 - u) / 0.4) * (0.6 + 0.4 * p.strength);
    }
  }

  /** Clear everything (a new point, a replay starting). */
  clear() {
    for (const p of [...this.shocks, ...this.grounds, ...this.scorches]) p.mesh.visible = false;
  }

  dispose() {
    for (const p of [...this.shocks, ...this.grounds, ...this.scorches]) p.mat.dispose();
    (this.shocks[0].mesh.geometry as THREE.BufferGeometry).dispose();
  }
}
