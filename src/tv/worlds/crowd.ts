// Instanced spectators that bob, cheer and jump with the match's energy.

import * as THREE from 'three';

export interface Stand {
  /** centre of the front row */
  x: number;
  z: number;
  /** direction the crowd faces (radians, 0 = facing -z) */
  facing: number;
  width: number;
  rows: number;
  rowRise: number;
  rowDepth: number;
  y0: number;
}

export interface CrowdOpts {
  stands: Stand[];
  density: number;
  bodyMat: THREE.Material;
  headMat: THREE.Material;
  shirts: THREE.Color[];
  skins: THREE.Color[];
  scale?: number;
  /** skip random seats */
  fill?: number;
  /** squash spectators into flat cut-outs (paper world) */
  flatten?: number;
}

const BOB = /* glsl */ `
  float fid = float(gl_InstanceID);
  float h1 = fract(sin(fid * 12.9898) * 43758.5453);
  float h2 = fract(sin(fid * 78.233 + 1.3) * 43758.5453);
  float bob = abs(sin(uTime * (2.6 + h1 * 2.8) + h2 * 6.2831)) * (0.03 + uExcite * 0.16);
  float jump = max(0.0, sin(uTime * (8.0 + h1 * 3.0) + h1 * 20.0)) * uCheer * 0.55 * step(0.25, h2);
  transformed.y += bob + jump;
  transformed.x += sin(uTime * 1.3 + h2 * 9.0) * 0.03 * uExcite;
`;

export function patchCrowdMaterial(m: THREE.Material, u: { uTime: THREE.IUniform; uExcite: THREE.IUniform; uCheer: THREE.IUniform }) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uExcite = u.uExcite;
    sh.uniforms.uCheer = u.uCheer;
    sh.vertexShader = 'uniform float uTime; uniform float uExcite; uniform float uCheer;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + BOB);
  };
  m.customProgramCacheKey = () => 'crowd-bob';
}

export class Crowd {
  group = new THREE.Group();
  u = { uTime: { value: 0 }, uExcite: { value: 0.2 }, uCheer: { value: 0 } };
  bodies: THREE.InstancedMesh;
  heads: THREE.InstancedMesh;
  private cheer = 0;

  constructor(o: CrowdOpts) {
    const seats: { p: THREE.Vector3; facing: number; s: number }[] = [];
    const spacing = 0.72 / o.density;
    for (const st of o.stands) {
      const n = Math.floor(st.width / spacing);
      const c = Math.cos(st.facing),
        sn = Math.sin(st.facing);
      for (let r = 0; r < st.rows; r++) {
        for (let i = 0; i < n; i++) {
          if (Math.random() > (o.fill ?? 0.9)) continue;
          const lx = (i - (n - 1) / 2) * spacing + (Math.random() - 0.5) * 0.12 + (r % 2) * spacing * 0.5;
          const lz = (r + 0.5) * st.rowDepth;
          // local (lx, lz) where +lz goes back (away from the court)
          const x = st.x + c * lx + sn * lz;
          const z = st.z - sn * lx + c * lz;
          seats.push({ p: new THREE.Vector3(x, st.y0 + r * st.rowRise, z), facing: st.facing, s: (o.scale ?? 1) * (0.9 + Math.random() * 0.2) });
        }
      }
    }
    const bodyG = new THREE.CapsuleGeometry(0.26, 0.3, 4, 10);
    bodyG.translate(0, 0.42, 0);
    const headG = new THREE.SphereGeometry(0.22, 14, 10);
    headG.translate(0, 0.98, 0);
    if (o.flatten) {
      bodyG.scale(1, 1, o.flatten);
      headG.scale(1, 1, o.flatten);
    }
    patchCrowdMaterial(o.bodyMat, this.u);
    patchCrowdMaterial(o.headMat, this.u);
    this.bodies = new THREE.InstancedMesh(bodyG, o.bodyMat, seats.length);
    this.heads = new THREE.InstancedMesh(headG, o.headMat, seats.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    seats.forEach((s, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.facing);
      m.compose(s.p, q, new THREE.Vector3(s.s, s.s, s.s));
      this.bodies.setMatrixAt(i, m);
      this.heads.setMatrixAt(i, m);
      this.bodies.setColorAt(i, col.copy(o.shirts[Math.floor(Math.random() * o.shirts.length)]));
      this.heads.setColorAt(i, col.copy(o.skins[Math.floor(Math.random() * o.skins.length)]));
    });
    this.bodies.frustumCulled = false;
    this.heads.frustumCulled = false;
    this.group.add(this.bodies, this.heads);
  }

  cheerNow(amount = 1) {
    this.cheer = Math.max(this.cheer, amount);
  }

  update(t: number, dt: number, excitement: number) {
    this.cheer = Math.max(0, this.cheer - dt * 0.45);
    this.u.uTime.value = t;
    this.u.uExcite.value += (excitement - this.u.uExcite.value) * Math.min(1, dt * 2);
    this.u.uCheer.value = Math.min(1, this.cheer);
  }
}
