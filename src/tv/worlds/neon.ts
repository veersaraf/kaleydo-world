// NEON DRIVE — a synthwave night: a striped sun sinking behind wireframe
// mountains, an endless glowing grid, and players outlined in light.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { stringsMat, skyDome, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import { outlineTree } from '../render/outline';
import { NOISE } from '../render/glsl';
import type { MatchEvent } from '../tennis/match';

const PINK = new THREE.Color('#ff2fb4');
const CYAN = new THREE.Color('#22e6ff');
const PURPLE = new THREE.Color('#8b3bff');
const YELLOW = new THREE.Color('#ffd23f');
const hdr = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);

class NeonWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'eyeWhite') return new THREE.MeshBasicMaterial({ color: hdr(new THREE.Color('#ffffff'), role === 'eye' ? 2.2 : 3) });
      if (role === 'mouth') return new THREE.MeshBasicMaterial({ color: hdr(PINK, 1.6) });
      if (role === 'strings') return stringsMat(hdr(CYAN, 1.5), { fog: false });
      if (role === 'cheek') return new THREE.MeshBasicMaterial({ color: hdr(PINK, 1.2), transparent: true, opacity: 0.8 });
      if (role === 'racket') return new THREE.MeshBasicMaterial({ color: hdr(c, 2.2) });
      const dark = c.clone().multiplyScalar(0.16);
      return new THREE.MeshLambertMaterial({ color: dark, emissive: c.clone().multiplyScalar(0.12) });
    },
    outline: { color: CYAN, width: 0.014, emissive: 2.6 },
    outlineColor: (look) => {
      const c = new THREE.Color(look.shirt);
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      return new THREE.Color().setHSL(hsl.h, 1, 0.6);
    },
    shadowColor: new THREE.Color('#000000'),
    shadowOpacity: 0.6,
  };

  private gridMat!: THREE.ShaderMaterial;
  private sunMat!: THREE.ShaderMaterial;
  private sky!: THREE.Mesh;
  private sticks!: THREE.InstancedMesh;
  private stickBase: THREE.Matrix4[] = [];
  private lineMat!: THREE.MeshBasicMaterial;

  protected build() {
    const s = this.scene;
    s.fog = new THREE.Fog('#12031f', 60, 420);
    this.sky = skyDome(new THREE.Color('#030010'), new THREE.Color('#5a0b5e'), { stars: 1.4, sunSize: 0.0001, sunColor: new THREE.Color(0, 0, 0), ground: new THREE.Color('#0a0214') });
    s.add(this.sky);
    s.add(new THREE.HemisphereLight('#6a3cff', '#1a0630', 1.2));
    const key = new THREE.DirectionalLight('#ff4fd8', 1.2);
    key.position.set(0, 10, -30);
    s.add(key);

    this.buildSun();
    this.buildGrid();
    this.buildMountains();
    this.buildCity();

    this.lineMat = new THREE.MeshBasicMaterial({ color: hdr(CYAN, 2.4) });
    this.buildCourt({
      inner: new THREE.MeshLambertMaterial({ color: '#150a33', emissive: new THREE.Color('#0a0420') }),
      outer: new THREE.MeshLambertMaterial({ color: '#08041a' }),
      line: this.lineMat,
      innerPad: { x: 1.0, z: 1.8 },
      outerSize: { x: 10.5, z: 18 },
      lineWidth: 0.07,
    });
    this.buildNet({
      post: new THREE.MeshBasicMaterial({ color: hdr(PINK, 2.5) }),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), color: hdr(PURPLE, 1.4), transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }),
      band: new THREE.MeshBasicMaterial({ color: hdr(new THREE.Color('#ffd6f5'), 3) }),
    });

    const ballMat = new THREE.MeshBasicMaterial({ color: hdr(new THREE.Color('#fff4c8'), 4.5) });
    this.buildBall(ballMat, { color: hdr(PINK, 2.2), color2: hdr(CYAN, 2), width: 0.13, opacity: 1, additive: true, length: 28 }, new THREE.Color('#000'), 0.7);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial({ color: hdr(PINK, 0.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ball.add(halo);
    this.buildParticles({ additive: true, fog: false });

    this.buildStands();
    this.buildPalms();

    this.bloom = new Bloom(6);
    this.bloom.threshold = 1.0;
    this.bloom.knee = 0.6;
    const f = this.final.u;
    f.uBloom.value = 0.8;
    f.uTonemap.value = 1;
    f.uExposure.value = 1.05;
    f.uSat.value = 1.15;
    f.uContrast.value = 1.05;
    f.uAberration.value = 0.0035;
    f.uVignette.value = 0.45;
    f.uGrain.value = 0.035;
    f.uScan.value = 0.06;
    this.flashColor.set('#ffb8ec');
  }

  private buildSun() {
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBeat: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uBeat; varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          if (r > 1.0) discard;
          vec3 top = vec3(1.0, 0.86, 0.25), bot = vec3(1.0, 0.1, 0.62);
          vec3 col = mix(bot, top, smoothstep(-0.9, 0.8, p.y));
          // horizontal slits that thicken toward the bottom and scroll down
          float y = p.y;
          if (y < 0.25) {
            float band = fract(y * 7.0 + uTime * 0.25);
            float w = mix(0.08, 0.55, smoothstep(0.25, -0.9, y));
            if (band < w) discard;
          }
          float glow = 1.5 + uBeat * 0.5;
          gl_FragColor = vec4(col * glow * (1.0 - r * 0.25), 1.0);
        }`,
      fog: false,
      depthWrite: false,
    });
    const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sunMat);
    sun.scale.setScalar(150);
    sun.position.set(0, 42, -330);
    sun.renderOrder = -5;
    this.scene.add(sun);
    // sun haze
    const haze = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec2 vUv; void main(){ float r = length(vUv*2.0-1.0); gl_FragColor = vec4(vec3(1.0,0.2,0.7) * 0.28 * pow(max(0.0,1.0-r),2.2), 1.0); }',
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    haze.scale.setScalar(420);
    haze.position.set(0, 42, -335);
    haze.renderOrder = -6;
    this.scene.add(haze);
  }

  private buildGrid() {
    this.gridMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBeat: { value: 0 } },
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uBeat; varying vec3 vW;
        ${NOISE}
        float line(float x, float w) { float f = abs(fract(x - 0.5) - 0.5); float d = fwidth(x); return 1.0 - smoothstep(w - d, w + d, f); }
        void main() {
          vec2 p = vW.xz / 4.0;
          p.y += uTime * 1.6;
          float g = max(line(p.x, 0.035), line(p.y, 0.035));
          float dist = length(vW.xz);
          float fade = exp(-dist * 0.006);
          vec3 base = vec3(0.02, 0.005, 0.05);
          vec3 lc = mix(vec3(1.0, 0.12, 0.75), vec3(0.45, 0.2, 1.0), smoothstep(40.0, 250.0, dist));
          vec3 col = base + lc * g * (1.6 + uBeat * 1.4) * fade;
          // horizon glow
          col += vec3(0.6, 0.05, 0.4) * smoothstep(120.0, 380.0, dist) * 0.6;
          gl_FragColor = vec4(col, 1.0);
        }`,
      fog: false,
    });
    const g = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400, 1, 1), this.gridMat);
    g.rotation.x = -Math.PI / 2;
    g.position.y = -0.04;
    this.scene.add(g);
  }

  private buildMountains() {
    const mk = (x: number, z: number, w: number, d: number, h: number, seed: number) => {
      const geo = new THREE.PlaneGeometry(w, d, 28, 10);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i),
          pz = pos.getZ(i);
        const edge = Math.min(1, (1 - Math.abs(px) / (w / 2)) * 3) * Math.min(1, (1 - Math.abs(pz) / (d / 2)) * 3);
        const n = Math.abs(Math.sin(px * 0.05 + seed) * Math.cos(pz * 0.07 + seed * 2)) + 0.5 * Math.abs(Math.sin(px * 0.13 + pz * 0.11 + seed));
        pos.setY(i, Math.max(0, edge) * n * h);
      }
      geo.computeVertexNormals();
      const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#07020f' }));
      const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: hdr(new THREE.Color('#b44bff'), 1.8), wireframe: true, fog: true }));
      wire.position.y = 0.05;
      const g = new THREE.Group();
      g.add(fill, wire);
      g.position.set(x, -0.5, z);
      this.scene.add(g);
    };
    mk(-150, -210, 220, 110, 55, 1);
    mk(160, -220, 240, 120, 62, 2);
    mk(-95, -80, 90, 60, 22, 3);
    mk(100, -90, 100, 60, 26, 4);
  }

  private buildCity() {
    const win = canvasTex(128, 256, (x) => {
      x.fillStyle = '#05020c';
      x.fillRect(0, 0, 128, 256);
      for (let yy = 4; yy < 256; yy += 10)
        for (let xx = 4; xx < 128; xx += 9) {
          if (Math.random() < 0.22) {
            x.fillStyle = Math.random() < 0.5 ? '#ff5fd0' : Math.random() < 0.5 ? '#46e8ff' : '#ffe07a';
            x.fillRect(xx, yy, 5, 6);
          }
        }
    });
    win.wrapS = win.wrapT = THREE.RepeatWrapping;
    for (let i = 0; i < 60; i++) {
      const w = 8 + Math.random() * 14;
      const hgt = 18 + Math.pow(Math.random(), 1.6) * 70;
      const t = win.clone();
      t.needsUpdate = true;
      t.repeat.set(w / 12, hgt / 24);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, 8), new THREE.MeshBasicMaterial({ map: t, color: hdr(new THREE.Color('#ffffff'), 0.75) }));
      const x = -260 + (i / 60) * 520 + (Math.random() - 0.5) * 8;
      // keep the sun clear: towers only flank it
      if (Math.abs(x) < 95) continue;
      m.position.set(x, hgt / 2 - 1, -250 - Math.random() * 40);
      this.scene.add(m);
    }
  }

  private buildStands() {
    const s = this.scene;
    const dark = new THREE.MeshLambertMaterial({ color: '#0d0620' });
    const stands: Stand[] = [];
    const edgeMats = [hdr(PINK, 2.2), hdr(CYAN, 2.2)].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number, ei: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.55 + r * 0.55;
        const step = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), dark);
        step.position.set(0, hgt / 2, r * 0.9 + 0.45);
        g.add(step);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, 0.05), edgeMats[(r + ei) % 2]);
        strip.position.set(0, hgt, r * 0.9 + 0.02);
        g.add(strip);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      s.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    mk(-10.5, 0, -Math.PI / 2, 22, 6, 0);
    mk(10.5, 0, Math.PI / 2, 22, 6, 1);
    mk(0, -19.5, Math.PI, 16, 7, 0);
    const heads = [PINK, CYAN, YELLOW, PURPLE, new THREE.Color('#4dff9e')].map((c) => hdr(c, 1.3));
    const crowd = new Crowd({
      stands,
      density: 1,
      bodyMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
      headMat: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      shirts: [new THREE.Color('#1a0d33'), new THREE.Color('#120826'), new THREE.Color('#200a2e')],
      skins: heads,
      fill: 0.85,
    });
    this.addCrowd(crowd);
    // light sticks held up by some of the crowd
    const n = Math.floor(crowd.bodies.count * 0.35);
    this.sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 5), new THREE.MeshBasicMaterial({ color: '#ffffff' }), n);
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const src = Math.floor(Math.random() * crowd.bodies.count);
      crowd.bodies.getMatrixAt(src, m);
      tmp.makeTranslation(0.25, 1.35, 0);
      const base = m.clone().multiply(tmp);
      this.stickBase.push(base);
      this.sticks.setMatrixAt(i, base);
      this.sticks.setColorAt(i, hdr([PINK, CYAN, YELLOW][i % 3], 3));
    }
    this.sticks.frustumCulled = false;
    s.add(this.sticks);
  }

  private buildPalms() {
    const trunkMat = new THREE.MeshBasicMaterial({ color: '#05020a' });
    const frondMat = new THREE.MeshBasicMaterial({ color: '#05020a', side: THREE.DoubleSide });
    const palm = (x: number, z: number, h: number, lean: number) => {
      const g = new THREE.Group();
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) pts.push(new THREE.Vector3(Math.sin((i / 8) * 1.2) * lean, (i / 8) * h, 0));
      const trunk = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.28, 6), trunkMat);
      g.add(trunk);
      const top = pts[pts.length - 1];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const curve = new THREE.QuadraticBezierCurve3(top.clone(), top.clone().add(new THREE.Vector3(Math.cos(a) * 2.5, 1.2, Math.sin(a) * 2.5)), top.clone().add(new THREE.Vector3(Math.cos(a) * 4.6, -1.6, Math.sin(a) * 4.6)));
        const fr = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.16, 4), frondMat);
        g.add(fr);
      }
      outlineTree(g, CYAN, 0.06, { emissive: 1.8 });
      g.position.set(x, 0, z);
      this.scene.add(g);
    };
    palm(-16, -18, 11, 1.4);
    palm(17, -20, 12, -1.6);
    palm(-22, -6, 10, 1);
    palm(23, -2, 9.5, -1);
    palm(-15, 12, 10.5, 1.2);
    palm(16, 13, 11, -1.1);
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    this.gridMat.uniforms.uTime.value = t;
    this.gridMat.uniforms.uBeat.value = v.beat;
    this.sunMat.uniforms.uTime.value = t;
    this.sunMat.uniforms.uBeat.value = v.beat;
    (this.sky.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    this.lineMat.color.copy(CYAN).multiplyScalar(2.2 + v.beat * 1.2);
    // light sticks wave
    const m = new THREE.Matrix4();
    const r = new THREE.Matrix4();
    const ex = 0.3 + v.excitement;
    for (let i = 0; i < this.stickBase.length; i++) {
      r.makeRotationZ(Math.sin(t * (3 + (i % 5) * 0.4) + i) * 0.7 * ex);
      m.copy(this.stickBase[i]).multiply(r);
      this.sticks.setMatrixAt(i, m);
    }
    this.sticks.instanceMatrix.needsUpdate = true;
    this.final.u.uBloom.value = 0.78 + v.beat * 0.2;
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: big ? 34 : 14, speed: [3, big ? 11 : 6], life: [0.2, 0.5], size: [0.05, big ? 0.16 : 0.1], shrink: 0.1, colors: [hdr(PINK, 3), hdr(CYAN, 3), hdr(YELLOW, 3)], shape: 'soft', drag: 2.5, gravity: 4 });
      if (big) P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: 1, speed: [0, 0], life: [0.4, 0.4], size: [0.4, 0.4], shrink: 9, colors: [hdr(CYAN, 2)], shape: 'ring' });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      P.burst({ x: e.pos.x, y: 0.03, z: e.pos.z, count: 1, speed: [0, 0], life: [0.5, 0.5], size: [0.2, 0.2], shrink: 8, colors: [hdr(e.out ? PINK : CYAN, 2.5)], shape: 'ring', alpha: 1 });
      P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 10, speed: [1.5, 4], dir: [0, 1, 0], spread: 0.95, life: [0.3, 0.6], size: [0.04, 0.08], colors: [hdr(CYAN, 3)], shape: 'soft', gravity: 10 });
    }
    if (e.type === 'point') {
      P.burst({ x: 0, y: 6, z: e.winner === 0 ? 6 : -6, count: 120, speed: [4, 12], dir: [0, 1, 0], spread: 0.9, life: [1.5, 2.8], size: [0.08, 0.16], colors: [hdr(PINK, 3), hdr(CYAN, 3), hdr(YELLOW, 3), hdr(PURPLE, 3)], shape: 'star', gravity: 5, drag: 1.4, spin: 8 });
    }
  }
}

export const NEON: WorldDef = {
  id: 'neon',
  name: 'Neon Drive',
  tagline: 'Rallies at the edge of the night',
  blurb: 'A synthwave sunset, an endless grid and players drawn in light.',
  ui: {
    accent: '#ff2fb4',
    accent2: '#22e6ff',
    ink: '#16072b',
    paper: '#fff',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Monoton', 'Orbitron', sans-serif",
    panel: 'linear-gradient(160deg, rgba(255,245,255,0.96), rgba(236,228,255,0.94))',
  },
  song: 'neon',
  surface: 1.03,
  make: (r) => new NeonWorld(NEON, r),
};
