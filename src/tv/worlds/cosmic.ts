// STARFALL — a court on a drifting asteroid. Nebulae, a ringed planet,
// glowing crystals, a comet for a ball — and lower gravity, so rallies float.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat, toon } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import { NOISE } from '../render/glsl';
import type { MatchEvent } from '../tennis/match';

const CYAN = new THREE.Color('#5ef2ff');
const VIOLET = new THREE.Color('#a86bff');
const PINK = new THREE.Color('#ff6bd6');
const hdr = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);

class CosmicWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(new THREE.Color('#10081e'));
      if (role === 'eyeWhite') return flat(hdr(new THREE.Color('#ffffff'), 1.4));
      if (role === 'strings') return stringsMat(hdr(CYAN, 1.2));
      if (role === 'cheek') return flat(new THREE.Color('#ff8ad8'));
      return toon(c, { rim: 0.9, rimColor: hdr(CYAN, 1.2), rimPower: 2.5, gradient: [70, 160, 255] });
    },
    outline: { color: new THREE.Color('#0c0620'), width: 0.01 },
    shadowColor: new THREE.Color('#000000'),
    shadowOpacity: 0.5,
  };

  private skyMat!: THREE.ShaderMaterial;
  private rocks: THREE.Object3D[] = [];
  private planet!: THREE.Group;
  private crystals: THREE.Mesh[] = [];
  private platform!: THREE.Group;

  protected build() {
    const s = this.scene;
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec3 vDir;
        ${NOISE}
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = vec3(0.01, 0.005, 0.03);
          float n1 = fbm3(d * 2.2 + vec3(0.0, 0.0, uTime * 0.004));
          float n2 = fbm3(d * 4.5 + 7.0);
          float band = exp(-pow(dot(d, normalize(vec3(0.3, 1.0, 0.25))), 2.0) * 7.0);
          col += vec3(0.35, 0.08, 0.55) * smoothstep(0.45, 0.85, n1) * 0.9;
          col += vec3(0.05, 0.3, 0.55) * smoothstep(0.5, 0.9, n2) * 0.7;
          col += vec3(0.6, 0.3, 0.7) * band * smoothstep(0.3, 0.8, n2) * 0.5;
          vec3 g = floor(d * 420.0);
          float st = step(0.9965, hash31(g));
          float tw = 0.6 + 0.4 * sin(uTime * 3.0 + hash31(g + 5.0) * 60.0);
          col += st * tw * mix(vec3(0.8, 0.9, 1.0), vec3(1.0, 0.8, 0.9), hash31(g + 2.0)) * 1.8;
          col += step(0.9993, hash31(floor(d * 180.0))) * 3.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 48, 24), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    s.add(sky);

    const star = new THREE.DirectionalLight('#dbe8ff', 2.8);
    star.position.set(20, 14, 10);
    s.add(star);
    s.add(new THREE.HemisphereLight('#6f5cff', '#130a2a', 1.3));
    const rim = new THREE.DirectionalLight('#ff6bd6', 1.4);
    rim.position.set(-20, 6, -30);
    s.add(rim);

    this.buildPlanet();
    this.buildPlatform();

    this.buildCourt({
      inner: new THREE.MeshLambertMaterial({ color: '#1b1742', emissive: new THREE.Color('#07051a') }),
      outer: new THREE.MeshLambertMaterial({ color: '#29224f' }),
      line: flat(hdr(CYAN, 1.8)),
      innerPad: { x: 1.1, z: 2 },
      outerSize: { x: 10.8, z: 18.6 },
      lineWidth: 0.07,
    });
    this.buildNet({
      post: flat(hdr(VIOLET, 2)),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), color: hdr(CYAN, 1), transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }),
      band: flat(hdr(new THREE.Color('#e9f7ff'), 2.2)),
    });
    const ballMat = new THREE.MeshBasicMaterial({ color: hdr(new THREE.Color('#e8fbff'), 3.5) });
    this.buildBall(ballMat, { color: hdr(CYAN, 2), color2: hdr(VIOLET, 1.6), width: 0.12, opacity: 1, additive: true, length: 30 }, new THREE.Color('#000000'), 0.6);
    this.buildParticles({ additive: true, fog: false });

    this.buildStands();

    this.bloom = new Bloom(5);
    this.bloom.threshold = 1.0;
    const f = this.final.u;
    f.uBloom.value = 0.75;
    f.uTonemap.value = 1;
    f.uExposure.value = 1.1;
    f.uSat.value = 1.15;
    f.uAberration.value = 0.0025;
    f.uVignette.value = 0.4;
    f.uGrain.value = 0.02;
    this.flashColor.set('#d8f6ff');
  }

  private buildPlanet() {
    this.planet = new THREE.Group();
    const pm = new THREE.ShaderMaterial({
      uniforms: { uLight: { value: new THREE.Vector3(0.6, 0.3, 0.7).normalize() } },
      vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform vec3 uLight; varying vec3 vN; varying vec3 vP;
        ${NOISE}
        void main() {
          float lat = normalize(vP).y;
          float b = sin(lat * 18.0 + fbm(vP.xz * 0.08) * 3.0) * 0.5 + 0.5;
          vec3 c = mix(vec3(0.95, 0.55, 0.35), vec3(0.98, 0.85, 0.62), b);
          c = mix(c, vec3(0.7, 0.3, 0.45), smoothstep(0.6, 0.9, fbm(vP.xy * 0.05 + 3.0)) * 0.5);
          float l = max(dot(vN, normalize(uLight)), 0.0);
          gl_FragColor = vec4(c * (0.08 + l * 1.1), 1.0);
        }`,
      fog: false,
    });
    const planet = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 32), pm);
    this.planet.add(planet);
    const ringMat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          float r = vUv.x;
          float bands = 0.5 + 0.5 * sin(r * 90.0) * sin(r * 23.0);
          float a = smoothstep(0.0, 0.08, r) * smoothstep(1.0, 0.85, r) * (0.35 + 0.5 * bands);
          gl_FragColor = vec4(vec3(0.95, 0.82, 0.7) * 0.9, a * 0.75);
        }`,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    const ringGeo = new THREE.RingGeometry(80, 150, 96, 1);
    // map uv.x to radial position for the shader
    const uv = ringGeo.attributes.uv as THREE.BufferAttribute;
    const pos = ringGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (Math.hypot(pos.getX(i), pos.getY(i)) - 80) / 70);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2.3;
    this.planet.add(ring);
    this.planet.position.set(-150, 70, -380);
    this.planet.rotation.z = 0.35;
    this.scene.add(this.planet);
    const moon = new THREE.Mesh(new THREE.SphereGeometry(14, 32, 20), new THREE.MeshLambertMaterial({ color: '#b9b4d8', fog: false }));
    moon.position.set(170, 95, -320);
    this.scene.add(moon);
  }

  private buildPlatform() {
    this.platform = new THREE.Group();
    const rockM = new THREE.MeshLambertMaterial({ color: '#4a3f6e', flatShading: true });
    const rockD = new THREE.MeshLambertMaterial({ color: '#2d2548', flatShading: true });
    // top slab
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(24, 22, 2.2, 28, 1), rockM);
    slab.position.y = -1.12;
    slab.scale.z = 1.25;
    this.platform.add(slab);
    // jagged underside
    const under = new THREE.ConeGeometry(22, 28, 28, 6);
    const p = under.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < 13.9) {
        const k = 1 + (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.25;
        p.setXYZ(i, p.getX(i) * k, y + Math.sin(i * 7.1) * 1.2, p.getZ(i) * k);
      }
    }
    under.computeVertexNormals();
    const um = new THREE.Mesh(under, rockD);
    um.rotation.x = Math.PI;
    um.position.y = -16;
    um.scale.z = 1.25;
    this.platform.add(um);
    this.scene.add(this.platform);

    // glowing crystals on the rim
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const r = 17 + Math.random() * 5;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 1.25;
      if (z > 10 && Math.abs(x) < 10) continue;
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), flat(hdr(i % 3 ? CYAN : PINK, 1.6 + Math.random())));
      c.scale.set(0.5, 1.6 + Math.random() * 1.8, 0.5);
      c.position.set(x, 1 + Math.random(), z);
      c.rotation.set(Math.random() * 0.5, Math.random() * 3, Math.random() * 0.5);
      c.userData.phase = Math.random() * 6;
      this.scene.add(c);
      this.crystals.push(c);
    }
    // floating rocks
    for (let i = 0; i < 26; i++) {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const pp = g.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pp.count; k++) {
        const f = 0.75 + Math.random() * 0.5;
        pp.setXYZ(k, pp.getX(k) * f, pp.getY(k) * f, pp.getZ(k) * f);
      }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, i % 2 ? rockM : rockD);
      const sc = 1 + Math.random() * 5;
      m.scale.setScalar(sc);
      const a = Math.random() * Math.PI * 2;
      const r = 32 + Math.random() * 70;
      m.position.set(Math.cos(a) * r, -10 + Math.random() * 40, Math.sin(a) * r - 30);
      if (m.position.z > 0 && Math.abs(m.position.x) < 30) m.position.z -= 70;
      m.userData.phase = Math.random() * 6;
      m.userData.baseY = m.position.y;
      m.userData.spin = (Math.random() - 0.5) * 0.3;
      this.scene.add(m);
      this.rocks.push(m);
    }
  }

  private buildStands() {
    const stands: Stand[] = [];
    const m = new THREE.MeshLambertMaterial({ color: '#241c46' });
    const edge = flat(hdr(VIOLET, 2));
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.55 + r * 0.55;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), m);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        g.add(st);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(width, 0.04, 0.04), edge);
        strip.position.set(0, hgt, r * 0.9);
        g.add(strip);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    mk(-11, 0, -Math.PI / 2, 22, 5);
    mk(11, 0, Math.PI / 2, 22, 5);
    mk(0, -20, Math.PI, 16, 5);
    this.addCrowd(
      new Crowd({
        stands,
        density: 0.9,
        bodyMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        headMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        shirts: ['#3b2d7a', '#5a2d7a', '#2d4a7a', '#7a2d5e'].map((c) => new THREE.Color(c)),
        skins: ['#8dff9e', '#b28dff', '#8dd8ff', '#ff9ed8', '#ffe38d'].map((c) => new THREE.Color(c)),
        fill: 0.8,
      }),
    );
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    this.skyMat.uniforms.uTime.value = t;
    for (const r of this.rocks) {
      r.position.y = r.userData.baseY + Math.sin(t * 0.4 + r.userData.phase) * 1.2;
      r.rotation.y += r.userData.spin * v.realDt;
      r.rotation.x += r.userData.spin * 0.5 * v.realDt;
    }
    for (const c of this.crystals) {
      const k = 1.4 + Math.sin(t * 1.6 + c.userData.phase) * 0.6;
      ((c.material as THREE.MeshBasicMaterial).color as THREE.Color).copy(c.userData.base ?? (c.userData.base = (c.material as THREE.MeshBasicMaterial).color.clone())).multiplyScalar(k / 2);
    }
    this.planet.rotation.y = t * 0.01;
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: big ? 30 : 12, speed: [2, big ? 8 : 5], life: [0.4, 0.9], size: [0.05, 0.14], shrink: 0.2, colors: [hdr(CYAN, 3), hdr(VIOLET, 3), hdr(new THREE.Color('#ffffff'), 3)], shape: 'star', drag: 1.2 });
    }
    if (e.type === 'bounce' && e.impact > 1.5) P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 1, speed: [0, 0], life: [0.6, 0.6], size: [0.25, 0.25], shrink: 8, colors: [hdr(e.out ? PINK : CYAN, 2)], shape: 'ring' });
    if (e.type === 'point') P.burst({ x: 0, y: 6, z: e.winner === 0 ? 6 : -6, count: 110, speed: [3, 9], dir: [0, 1, 0], spread: 0.95, life: [2, 3.5], size: [0.06, 0.14], colors: [hdr(CYAN, 3), hdr(PINK, 3), hdr(VIOLET, 3), hdr(new THREE.Color('#ffe38d'), 3)], shape: 'star', gravity: 1, drag: 0.6, spin: 4 });
  }
}

export const STARFALL: WorldDef = {
  id: 'cosmic',
  name: 'Starfall',
  tagline: 'Low gravity, high drama',
  blurb: 'A court adrift among the stars. The ball floats — so time your swing.',
  ui: {
    accent: '#5ef2ff',
    accent2: '#ff6bd6',
    ink: '#140c30',
    paper: '#ffffff',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Orbitron', 'Fredoka', sans-serif",
    panel: 'linear-gradient(160deg, rgba(245,248,255,0.97), rgba(232,236,255,0.95))',
  },
  song: 'cosmic',
  surface: 1,
  gravity: 0.72,
  make: (r) => new CosmicWorld(STARFALL, r),
};
