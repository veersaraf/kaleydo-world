// CLAYLAND — stop-motion plasticine. Characters move "on twos" (12 fps),
// every surface has thumbprints that shimmer between frames, the court is
// real clay that keeps ball marks, and a tilt-shift blur makes it a miniature.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { stringsMat } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass, makeRT } from '../render/post';
import type { MatchEvent } from '../tennis/match';

const boil = { value: 0 };

/** Plasticine: rough standard material with thumbprint bump and "boil". */
function clay(color: THREE.ColorRepresentation, o: { rough?: number; bump?: number; emissive?: THREE.ColorRepresentation } = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.72, metalness: 0, emissive: o.emissive ?? 0x000000 });
  const bump = o.bump ?? 1;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBoil = boil;
    sh.uniforms.uBump = { value: bump };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vObj; uniform float uBoil; uniform float uBump;
        float ch(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float cn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(ch(i), ch(i + vec3(1,0,0)), f.x), mix(ch(i + vec3(0,1,0)), ch(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(ch(i + vec3(0,0,1)), ch(i + vec3(1,0,1)), f.x), mix(ch(i + vec3(0,1,1)), ch(i + vec3(1,1,1)), f.x), f.y), f.z); }
        float clayH(vec3 p) {
          vec3 q = p * 9.0 + uBoil * 0.37;
          float lumps = cn(q * 0.6) * 0.6 + cn(q * 1.7) * 0.3;
          vec2 c = floor(p.xy * 2.2 + uBoil * 0.11);
          vec2 fp = fract(p.xy * 2.2) - 0.5 + (vec2(ch(vec3(c, 1.0)), ch(vec3(c, 2.0))) - 0.5) * 0.4;
          float print = sin(length(fp) * 70.0 + cn(q) * 4.0) * 0.5 + 0.5;
          print *= smoothstep(0.45, 0.1, length(fp)) * step(0.55, ch(vec3(c, 3.0)));
          return lumps + print * 0.18;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          float hh = clayH(vObj) * 0.02 * uBump;
          vec3 sp = -vViewPosition;
          vec3 sx = dFdx(sp), sy = dFdy(sp);
          float dx = dFdx(hh), dy = dFdy(hh);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec3 grad = sign(det) * (dx * r1 + dy * r2);
          normal = normalize(abs(det) * normal - grad);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'clay';
  return m;
}

function lumpy(geo: THREE.BufferGeometry, amt: number, freq = 1.5, seed = 0) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const n = Math.sin(x * freq + seed) * Math.cos(y * freq * 1.3 + seed * 2) * Math.sin(z * freq * 0.9 + seed * 3);
    const l = Math.hypot(x, y, z) || 1;
    const k = 1 + n * amt;
    pos.setXYZ(i, (x / l) * l * k, (y / l) * l * k, (z / l) * l * k);
  }
  geo.computeVertexNormals();
  return geo;
}

const TILT = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir; uniform vec2 uRes; uniform float uFocus; uniform float uSpread;
varying vec2 vUv;
void main() {
  // keep the whole court sharp: blur the sky/background above, and only the very bottom edge
  float r = (smoothstep(uFocus, uFocus + 0.28, vUv.y) + smoothstep(0.07, 0.0, vUv.y) * 0.6) * uSpread;
  // the sharp band (most of the court) needs no blur: skip the 13 taps
  if (r < 0.02) { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); return; }
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    acc += texture2D(tSrc, vUv + uDir * fi * r / uRes).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;

class ClayWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'strings') return stringsMat(new THREE.Color('#fff8ea'));
      if (role === 'eye') return clay('#1a1410', { rough: 0.25, bump: 0.2 });
      if (role === 'eyeWhite') return clay('#ffffff', { rough: 0.3, bump: 0.2 });
      if (role === 'cheek') return clay('#ff8f8f', { bump: 0.4 });
      return clay(c);
    },
    outline: null,
    castShadow: true,
    shadowColor: new THREE.Color('#3a2418'),
    shadowOpacity: 0.25,
  };

  private stepAcc = 0;
  private lastPoses: import('../chars/pose').Pose[] | null = null;
  private sunFace!: THREE.Group;
  private snail!: THREE.Group;
  private marks: THREE.Mesh[] = [];
  private markMat!: THREE.MeshBasicMaterial;
  private rtA!: THREE.WebGLRenderTarget;
  private rtB!: THREE.WebGLRenderTarget;
  private tilt!: Pass;

  protected build() {
    const s = this.scene;
    s.background = new THREE.Color('#9fd4f0');
    s.fog = new THREE.Fog('#bfe3f3', 70, 260);
    const key = new THREE.DirectionalLight('#ffe3c4', 3.2);
    key.position.set(-14, 22, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera as THREE.OrthographicCamera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 26;
    sc.bottom = -34;
    sc.far = 100;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.04;
    key.shadow.radius = 4;
    s.add(key, key.target);
    s.add(new THREE.HemisphereLight('#cfe8ff', '#a2764f', 1.2));
    const rim = new THREE.DirectionalLight('#b8d8ff', 1.1);
    rim.position.set(10, 8, -20);
    s.add(rim);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(300, 64), clay('#7fc66b', { bump: 2 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    s.add(ground);

    this.buildCourt({
      inner: clay('#d4683c', { bump: 1.5 }),
      outer: clay('#c55f36', { bump: 1.5 }),
      line: clay('#fbf3e6', { bump: 0.5 }),
      innerPad: { x: 1.3, z: 2.2 },
      outerSize: { x: 10.8, z: 18.8 },
      lineWidth: 0.085,
      wobble: 0.02,
      receiveShadow: true,
    });
    this.buildNet({
      post: clay('#2f5b8f'),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#f6f0e6'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 }),
      band: clay('#ffffff'),
    });

    const ballMat = clay('#dff04a', { bump: 2 });
    this.buildBall(ballMat, { color: new THREE.Color('#fff6d8'), width: 0.06, opacity: 0.55, length: 16 }, new THREE.Color('#3a2418'), 0.45);
    this.buildParticles();
    this.markMat = new THREE.MeshBasicMaterial({ color: '#8a3a1c', transparent: true, opacity: 0.55, depthWrite: false });

    this.buildScenery();
    this.buildStands();

    this.rtA = makeRT(1, 1);
    this.rtB = makeRT(1, 1);
    this.tilt = new Pass(TILT, { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uRes: { value: new THREE.Vector2(1, 1) }, uFocus: { value: 0.6 }, uSpread: { value: 3.4 } });
    const f = this.final.u;
    f.uSat.value = 1.12;
    f.uContrast.value = 1.06;
    f.uGain.value.set(1.04, 1.0, 0.94);
    f.uVignette.value = 0.32;
    f.uGrain.value = 0.02;
    f.uTonemap.value = 1;
    f.uExposure.value = 1.15;
  }

  private buildScenery() {
    const s = this.scene;
    // hills
    const hills: [number, number, number, number, string][] = [
      [-70, -110, 55, 26, '#6cbf5f'],
      [30, -140, 80, 36, '#5aae55'],
      [120, -90, 50, 22, '#86cc6e'],
      [-150, -60, 50, 20, '#79c766'],
      [0, -190, 110, 50, '#4f9e4f'],
    ];
    for (const [x, z, r, h, c] of hills) {
      const g = lumpy(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), 0.05, 3, x);
      const m = new THREE.Mesh(g, clay(c, { bump: 4 }));
      m.scale.set(r, h, r * 0.7);
      m.position.set(x, -1, z);
      m.receiveShadow = true;
      s.add(m);
    }
    // clay sun with a face
    this.sunFace = new THREE.Group();
    const sun = new THREE.Mesh(lumpy(new THREE.SphereGeometry(9, 40, 30), 0.03, 2), clay('#ffcf3a', { emissive: '#7a4a00', bump: 3 }));
    this.sunFace.add(sun);
    for (const x of [-3, 3]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), clay('#3a2418'));
      eye.scale.set(0.9, 1.3, 0.6);
      eye.position.set(x, 1.8, 8.4);
      this.sunFace.add(eye);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.55, 10, 24, Math.PI), clay('#3a2418'));
    smile.rotation.z = Math.PI;
    smile.position.set(0, -0.8, 8.2);
    this.sunFace.add(smile);
    for (const x of [-5.6, 5.6]) {
      const ch = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 10), clay('#ff8a6a'));
      ch.scale.z = 0.4;
      ch.position.set(x, -1.2, 7.6);
      this.sunFace.add(ch);
    }
    this.sunFace.position.set(-48, 58, -160);
    this.sunFace.lookAt(0, 10, 20);
    s.add(this.sunFace);
    // clouds: clusters of white clay
    const cloudM = clay('#ffffff', { bump: 3 });
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const b = new THREE.Mesh(lumpy(new THREE.SphereGeometry(1, 20, 14), 0.08, 3, k), cloudM);
        b.scale.setScalar(3 + Math.random() * 3);
        b.position.set(k * 4 - 8, Math.random() * 2, Math.random() * 3);
        g.add(b);
      }
      g.position.set(-180 + Math.random() * 360, 40 + Math.random() * 30, -120 - Math.random() * 80);
      g.scale.y = 0.7;
      s.add(g);
    }
    // mushrooms, flowers, trees
    const stem = clay('#fff2de');
    const capColors = ['#e84a3c', '#f29c38', '#b26bdb'];
    const dot = clay('#ffffff');
    const mush = (x: number, z: number, sc: number) => {
      const g = new THREE.Group();
      const st = new THREE.Mesh(lumpy(new THREE.CylinderGeometry(0.5, 0.7, 2, 14), 0.05), stem);
      st.position.y = 1;
      const cap = new THREE.Mesh(lumpy(new THREE.SphereGeometry(1.6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), 0.06, 3), clay(capColors[Math.floor(Math.random() * 3)]));
      cap.position.y = 1.8;
      g.add(st, cap);
      for (let k = 0; k < 6; k++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), dot);
        const a = Math.random() * Math.PI * 2;
        const e = 0.3 + Math.random() * 0.9;
        d.position.set(Math.cos(a) * e * 1.3, 1.8 + Math.sqrt(Math.max(0, 1 - e * e * 0.6)) * 1.4, Math.sin(a) * e * 1.3);
        d.scale.y = 0.5;
        g.add(d);
      }
      g.traverse((o) => (o.castShadow = true));
      g.position.set(x, 0, z);
      g.scale.setScalar(sc);
      s.add(g);
    };
    const trunk = clay('#8a5a3a');
    const leaves = ['#58b04e', '#7bc65a', '#3f9a4a'].map((c) => clay(c, { bump: 3 }));
    const tree = (x: number, z: number, sc: number) => {
      const g = new THREE.Group();
      const t = new THREE.Mesh(lumpy(new THREE.CylinderGeometry(0.35, 0.55, 3, 10), 0.08), trunk);
      t.position.y = 1.5;
      g.add(t);
      const b = new THREE.Mesh(lumpy(new THREE.SphereGeometry(2.2, 24, 16), 0.1, 2.2, x), leaves[Math.floor(Math.random() * 3)]);
      b.position.y = 4.2;
      g.add(b);
      g.traverse((o) => (o.castShadow = true));
      g.position.set(x, 0, z);
      g.scale.setScalar(sc);
      s.add(g);
    };
    const flowerCols = ['#ff5a7a', '#ffd23a', '#7a8cff', '#ff9a3a', '#ffffff'].map((c) => clay(c));
    const flower = (x: number, z: number) => {
      const g = new THREE.Group();
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1, 6), clay('#3f9a4a'));
      st.position.y = 0.5;
      g.add(st);
      const pm = flowerCols[Math.floor(Math.random() * flowerCols.length)];
      for (let k = 0; k < 5; k++) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), pm);
        const a = (k / 5) * Math.PI * 2;
        p.position.set(Math.cos(a) * 0.22, 1.05, Math.sin(a) * 0.22);
        p.scale.set(1, 0.5, 1);
        g.add(p);
      }
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), clay('#ffd23a'));
      c.position.y = 1.1;
      g.add(c);
      g.position.set(x, 0, z);
      s.add(g);
    };
    for (let i = 0; i < 24; i++) {
      const side = i % 2 ? 1 : -1;
      tree(side * (22 + Math.random() * 30), -70 + Math.random() * 70, 1 + Math.random() * 0.6);
    }
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      mush(side * (13 + Math.random() * 8), -30 + Math.random() * 36, 0.6 + Math.random() * 0.6);
    }
    for (let i = 0; i < 60; i++) {
      const side = i % 2 ? 1 : -1;
      flower(side * (12.5 + Math.random() * 14), -34 + Math.random() * 48);
    }
    // the snail
    this.snail = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.32, 12, 24), clay('#e8883a'));
    shell.position.y = 0.75;
    const shell2 = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), clay('#f2a654'));
    shell2.position.set(0, 0.75, 0.05);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.2, 6, 10), clay('#9fd88a'));
    body.rotation.z = Math.PI / 2;
    body.position.set(-0.2, 0.22, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), clay('#9fd88a'));
    head.position.set(-0.85, 0.42, 0);
    this.snail.add(shell, shell2, body, head);
    for (const z of [-0.1, 0.1]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), clay('#9fd88a'));
      st.position.set(-0.95, 0.72, z);
      st.rotation.z = 0.3;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), clay('#1a1410'));
      eye.position.set(-1.02, 0.95, z);
      this.snail.add(st, eye);
    }
    this.snail.traverse((o) => (o.castShadow = true));
    this.snail.scale.setScalar(1.3);
    s.add(this.snail);
  }

  private buildStands() {
    const stands: Stand[] = [];
    const cols = ['#e2d6c3', '#d7c8b2'].map((c) => clay(c, { bump: 2 }));
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.55 + r * 0.55;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), cols[r % 2]);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        st.castShadow = true;
        st.receiveShadow = true;
        g.add(st);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    mk(-10.8, 0, -Math.PI / 2, 22, 6);
    mk(10.8, 0, Math.PI / 2, 22, 6);
    mk(0, -19.5, Math.PI, 16, 6);
    const crowd = new Crowd({
      stands,
      density: 0.95,
      bodyMat: clay('#ffffff', { bump: 2 }),
      headMat: clay('#ffffff', { bump: 2 }),
      shirts: ['#e84a3c', '#3a8ce8', '#f2c438', '#58b04e', '#b26bdb', '#ff8a4a'].map((c) => new THREE.Color(c)),
      skins: ['#ffd9b8', '#e8b48a', '#b07a52', '#7a4e32', '#9fd88a', '#a8c8ff'].map((c) => new THREE.Color(c)),
      fill: 0.85,
    });
    crowd.bodies.castShadow = true;
    this.addCrowd(crowd);
  }

  // stop-motion: characters pose at 12 fps
  update(v: FrameView) {
    this.stepAcc += v.realDt;
    const tick = this.stepAcc >= 1 / 12 || !this.lastPoses;
    if (tick) {
      this.stepAcc %= 1 / 12;
      boil.value = (boil.value + 1) % 64;
      this.lastPoses = v.poses.map((p) => JSON.parse(JSON.stringify(p)));
    }
    super.update({ ...v, poses: this.lastPoses! });
  }

  protected animate(v: FrameView) {
    const t = Math.floor(v.realT * 12) / 12;
    this.sunFace.rotation.z = Math.sin(t * 0.6) * 0.05;
    const u = (t * 0.02) % 1;
    this.snail.position.set(-9.6, 1.12, 16 - u * 32);
    this.snail.rotation.y = Math.PI / 2;
    // fade old ball marks
    for (const m of this.marks) (m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (m.userData.life -= v.realDt) / 20) * 0.5;
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    const cols = (a: string[]) => a.map((c) => new THREE.Color(c));
    if (e.type === 'bounce' && e.impact > 1.5 && Math.abs(e.pos.x) < 12 && Math.abs(e.pos.z) < 20) {
      // a ball mark in the clay
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), this.markMat.clone());
      m.rotation.x = -Math.PI / 2;
      m.scale.set(1, 1.9, 1);
      m.position.set(e.pos.x, 0.012, e.pos.z);
      m.userData.life = 20;
      this.scene.add(m);
      this.marks.push(m);
      if (this.marks.length > 40) {
        const old = this.marks.shift()!;
        this.scene.remove(old);
        old.geometry.dispose();
      }
      P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 8, speed: [0.8, 2.4], dir: [0, 1, 0], spread: 0.9, life: [0.4, 0.8], size: [0.06, 0.12], colors: cols(['#d4683c', '#e28a5a']), shape: 'soft', gravity: 8, ground: true });
    }
    if (e.type === 'hit') {
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: e.perfect ? 14 : 6, speed: [1.5, 4], life: [0.3, 0.6], size: [0.1, 0.18], colors: cols(['#ffffff', '#ffe98a']), shape: 'soft', drag: 3 });
    }
    if (e.type === 'point') {
      P.burst({ x: 0, y: 7, z: e.winner === 0 ? 6 : -6, count: 80, speed: [3, 8], dir: [0, 1, 0], spread: 0.9, life: [2, 3.5], size: [0.15, 0.25], colors: cols(['#e84a3c', '#3a8ce8', '#f2c438', '#58b04e', '#b26bdb']), shape: 'confetti', gravity: 3, spin: 10, ground: true });
    }
  }

  protected onResize(W: number, H: number) {
    this.rtA.setSize(W, H);
    this.rtB.setSize(W, H);
    this.tilt.u.uRes.value.set(W, H);
  }

  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor('#9fd4f0', 1);
    r.clear();
    r.render(this.scene, cam);
    r.setClearColor(0x000000, 1);
    // tilt-shift: two directional blurs that grow away from the focus band
    const u = this.tilt.u;
    u.tSrc.value = this.sceneRT.texture;
    u.uDir.value.set(1, 0);
    this.tilt.render(r, this.rtA);
    u.tSrc.value = this.rtA.texture;
    u.uDir.value.set(0, 1);
    this.tilt.render(r, this.rtB);
    const f = this.final.u;
    f.tScene.value = this.rtB.texture;
    f.tBloom.value = this.sceneRT.texture;
    f.uBloom.value = 0;
    f.uTime.value = this.time;
    f.uFlash.value = this.flash;
    this.final.render(r, target);
  }

  dispose() {
    super.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.tilt.dispose();
  }
}

export const CLAY: WorldDef = {
  id: 'clay',
  name: 'Clayland',
  tagline: 'Every frame, sculpted by hand',
  blurb: 'Stop-motion plasticine, a real clay court and a very slow snail.',
  ui: {
    accent: '#d4683c',
    accent2: '#3a8ce8',
    ink: '#3a2418',
    paper: '#fff7ec',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Chewy', 'Fredoka', cursive",
    panel: 'linear-gradient(160deg, rgba(255,248,236,0.98), rgba(250,236,218,0.96))',
  },
  song: 'clay',
  surface: 0.93,
  make: (r) => new ClayWorld(CLAY, r),
};
