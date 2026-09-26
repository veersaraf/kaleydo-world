// AQUARELLE — a garden painted in watercolour. The scene goes through a
// Kuwahara filter (flat painterly strokes), then pigment pools at the edges,
// colours bleed, granulate into the paper and white paper shows through.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat, skyDome, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass, makeRT } from '../render/post';
import { NOISE, COLOR } from '../render/glsl';
import type { MatchEvent } from '../tennis/match';

const KUWAHARA = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  const int R = 3;
  for (int j = -R; j <= R; j++) for (int i = -R; i <= R; i++) {
    vec3 c = texture2D(tSrc, vUv + vec2(float(i), float(j)) * uTexel).rgb;
    vec3 c2 = c * c;
    if (i <= 0 && j <= 0) { m[0] += c; s[0] += c2; }
    if (i >= 0 && j <= 0) { m[1] += c; s[1] += c2; }
    if (i <= 0 && j >= 0) { m[2] += c; s[2] += c2; }
    if (i >= 0 && j >= 0) { m[3] += c; s[3] += c2; }
  }
  float n = float((R + 1) * (R + 1));
  float best = 1e9; vec3 outc = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 mu = m[k] / n;
    vec3 v = abs(s[k] / n - mu * mu);
    float sv = v.r + v.g + v.b;
    if (sv < best) { best = sv; outc = mu; }
  }
  gl_FragColor = vec4(outc, 1.0);
}`;

const WATER = /* glsl */ `
uniform sampler2D tPaint; uniform vec2 uRes; uniform float uTime; uniform float uFlash; uniform vec3 uPaper;
varying vec2 vUv;
${NOISE}
${COLOR}
vec3 paint(vec2 uv) { return toSRGB(texture2D(tPaint, uv).rgb); }
void main() {
  vec2 bleed = (vec2(fbm(vUv * 7.0 + 1.3), fbm(vUv * 7.0 + 9.1)) - 0.5) * 0.009;
  vec2 uv = vUv + bleed;
  vec3 c = paint(uv);
  // richer pigment: a touch more saturation and contrast than the raw scene
  c = mix(vec3(luma(c)), c, 1.35);
  c = (c - 0.5) * 1.08 + 0.5;
  // pigment pools at edges (darkened outlines where colour changes)
  vec2 px = 2.5 / uRes;
  vec3 cx = paint(uv + vec2(px.x, 0.0)) - paint(uv - vec2(px.x, 0.0));
  vec3 cy = paint(uv + vec2(0.0, px.y)) - paint(uv - vec2(0.0, px.y));
  float g = length(cx) + length(cy);
  float edge = smoothstep(0.05, 0.3, g);
  c *= 1.0 - edge * 0.28;
  // soften and lighten like diluted pigment
  float l = luma(c);
  c = mix(c, vec3(l), 0.04);
  c = mix(c, uPaper, 0.03 + 0.25 * smoothstep(0.8, 1.0, l));
  // cold-press paper and granulation (pigment settles in the valleys)
  float paperN = fbm(gl_FragCoord.xy / 38.0) * 0.6 + vnoise(gl_FragCoord.xy / 2.2) * 0.4;
  c *= 1.0 - (1.0 - l) * (paperN - 0.5) * 0.45;
  // blotchy wash variation
  c *= 0.93 + 0.12 * fbm(vUv * 3.0 + 7.0);
  c = mix(c, uPaper, (paperN - 0.5) * 0.18 + 0.02);
  vec2 q = vUv - 0.5;
  c = mix(c, uPaper, smoothstep(0.45, 0.85, length(q * vec2(uRes.x / uRes.y, 1.0))) * 0.35);
  c = mix(c, uPaper, uFlash);
  gl_FragColor = vec4(c, 1.0);
}`;

class WaterWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(new THREE.Color('#2b2440'));
      if (role === 'eyeWhite') return flat(new THREE.Color('#ffffff'));
      if (role === 'strings') return stringsMat(new THREE.Color('#ffffff'));
      if (role === 'cheek') return flat(new THREE.Color('#ff9fb2'));
      return new THREE.MeshLambertMaterial({ color: c });
    },
    outline: null,
    shadowColor: new THREE.Color('#4a5a8a'),
    shadowOpacity: 0.3,
  };

  private half!: THREE.WebGLRenderTarget;
  private kuw!: THREE.WebGLRenderTarget;
  private kPass!: Pass;
  private wPass!: Pass;
  private balloons: THREE.Group[] = [];
  private willows: THREE.Group[] = [];

  protected samples() {
    return 0;
  }

  protected build() {
    const s = this.scene;
    s.fog = new THREE.Fog('#f4f0ff', 130, 480);
    s.add(skyDome(new THREE.Color('#9ec9ff'), new THREE.Color('#fff1f4'), { sunDir: new THREE.Vector3(0.5, 0.4, -1), sunColor: new THREE.Color('#fff4d0'), sunSize: 0.02, ground: new THREE.Color('#cfe9b8') }));
    s.add(new THREE.HemisphereLight('#fff6ff', '#b9d6a0', 2.1));
    const sun = new THREE.DirectionalLight('#fff0dc', 1.6);
    sun.position.set(10, 20, -8);
    s.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(300, 48), new THREE.MeshLambertMaterial({ color: '#8fcf72' }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    s.add(ground);

    this.buildCourt({
      inner: new THREE.MeshLambertMaterial({ color: '#6fbf62' }),
      outer: new THREE.MeshLambertMaterial({ color: '#a7dc8a' }),
      line: flat('#ffffff'),
      innerPad: { x: 1, z: 1.8 },
      outerSize: { x: 10.5, z: 18.5 },
      lineWidth: 0.12,
      wobble: 0.015,
    });
    this.buildNet({
      post: new THREE.MeshLambertMaterial({ color: '#6a5a8a' }),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      band: flat('#ffffff'),
    });
    this.buildBall(new THREE.MeshLambertMaterial({ color: '#ffe14a', emissive: new THREE.Color('#403000') }), { color: new THREE.Color('#9fc4ff'), color2: new THREE.Color('#ffc2dc'), width: 0.1, opacity: 0.55, mode: 1, length: 24 }, new THREE.Color('#4a5a8a'), 0.35);
    this.buildParticles();

    this.buildGarden();
    this.buildStands();

    this.half = makeRT(1, 1);
    this.kuw = makeRT(1, 1);
    this.kPass = new Pass(KUWAHARA, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) } });
    this.wPass = new Pass(WATER, { tPaint: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uFlash: { value: 0 }, uPaper: { value: new THREE.Vector3(0.99, 0.97, 0.93) } });
  }

  private buildGarden() {
    const s = this.scene;
    const L = (c: string) => new THREE.MeshLambertMaterial({ color: c });
    // hills
    for (const [x, z, r, h, c] of [
      [-90, -170, 70, 13, '#9fd48a'],
      [70, -200, 90, 17, '#8cc77c'],
      [0, -290, 160, 26, '#b3dca0'],
      [170, -130, 60, 10, '#a4d68e'],
      [-180, -120, 60, 10, '#aedb97'],
    ] as [number, number, number, number, string][]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), L(c));
      m.scale.set(r, h, r * 0.7);
      m.position.set(x, -1, z);
      s.add(m);
    }
    // painted clouds
    const cloud = L('#ffffff');
    for (let i = 0; i < 12; i++) {
      const g = new THREE.Group();
      for (let k = 0; k < 6; k++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), cloud);
        b.scale.setScalar(3 + Math.random() * 4);
        b.position.set(k * 4 - 10, Math.random() * 2, Math.random() * 3);
        g.add(b);
      }
      g.position.set(-200 + Math.random() * 400, 45 + Math.random() * 35, -130 - Math.random() * 90);
      g.scale.y = 0.6;
      s.add(g);
    }
    // hot air balloons
    const stripe = (a: string, b: string) =>
      canvasTex(256, 64, (x) => {
        for (let i = 0; i < 8; i++) {
          x.fillStyle = i % 2 ? a : b;
          x.fillRect(i * 32, 0, 32, 64);
        }
      });
    const bcols: [string, string][] = [
      ['#ff8fab', '#fff0f5'],
      ['#8fb8ff', '#fff6c8'],
      ['#ffc36b', '#b28dff'],
    ];
    bcols.forEach(([a, b], i) => {
      const g = new THREE.Group();
      const env = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 18), new THREE.MeshLambertMaterial({ map: stripe(a, b) }));
      env.scale.y = 1.2;
      const basket = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 1.1), L('#9a6a44'));
      basket.position.y = -4.6;
      g.add(env, basket);
      for (const [dx, dz] of [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ]) {
        const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.8, 4), L('#6a5040'));
        rope.position.set(dx, -3.4, dz);
        g.add(rope);
      }
      g.position.set(-40 + i * 45, 24 + i * 6, -70 - i * 25);
      g.userData.phase = i * 2;
      s.add(g);
      this.balloons.push(g);
    });
    // pond with lily pads and a bridge
    const pond = new THREE.Mesh(new THREE.CircleGeometry(7, 40), new THREE.MeshLambertMaterial({ color: '#8cc8f0' }));
    pond.rotation.x = -Math.PI / 2;
    pond.scale.set(1.4, 1, 1);
    pond.position.set(-19, 0.02, -8);
    s.add(pond);
    for (let i = 0; i < 12; i++) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.7 + Math.random() * 0.4, 16, 0.3, Math.PI * 1.8), L('#6dbb6a'));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(-19 + (Math.random() - 0.5) * 16, 0.04, -8 + (Math.random() - 0.5) * 9);
      s.add(pad);
      if (i % 3 === 0) {
        const lotus = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), L('#ffb0d0'));
        lotus.scale.y = 0.6;
        lotus.position.copy(pad.position).add(new THREE.Vector3(0, 0.2, 0));
        s.add(lotus);
      }
    }
    const bridge = new THREE.Mesh(new THREE.TorusGeometry(5, 0.5, 8, 24, Math.PI), L('#d97a6a'));
    bridge.position.set(-19, 0, -8);
    bridge.rotation.y = Math.PI / 2;
    bridge.scale.set(1, 0.55, 2.2);
    s.add(bridge);
    // willows
    const trunkM = L('#8a6a5a');
    const leafM = L('#9fd57a');
    for (const [x, z, sc] of [
      [-16, -22, 1.2],
      [17, -20, 1.1],
      [-24, 6, 1],
      [23, 8, 1.1],
      [-30, -12, 0.9],
    ] as [number, number, number][]) {
      const g = new THREE.Group();
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 7, 10), trunkM);
      t.position.y = 3.5;
      g.add(t);
      for (const [cx, cy, cr] of [
        [0, 7.6, 2.6],
        [-1.8, 7.1, 1.9],
        [1.9, 7.2, 2],
        [0.3, 8.6, 1.8],
      ]) {
        const crown = new THREE.Mesh(new THREE.SphereGeometry(cr, 16, 12), leafM);
        crown.position.set(cx, cy, 0);
        crown.scale.y = 0.75;
        g.add(crown);
      }
      const strands = new THREE.Group();
      for (let k = 0; k < 40; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = 1.5 + Math.random() * 1.8;
        const len = 3 + Math.random() * 3;
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.02, len, 4), leafM);
        st.position.set(Math.cos(a) * r, 7.2 - len / 2, Math.sin(a) * r);
        strands.add(st);
      }
      g.add(strands);
      g.userData.strands = strands;
      g.position.set(x, 0, z);
      g.scale.setScalar(sc);
      s.add(g);
      this.willows.push(g);
    }
    // cherry trees in blossom behind the far stand
    const blossom = ['#ffb3cf', '#ff9fc2', '#ffd1e3', '#f7a8d8'].map((c) => L(c));
    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      const x = -46 + i * 7 + (Math.random() - 0.5) * 3;
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 4, 8), trunkM);
      tr.position.y = 2;
      g.add(tr);
      for (let k = 0; k < 4; k++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(1.6 + Math.random(), 14, 10), blossom[(i + k) % blossom.length]);
        b.position.set((Math.random() - 0.5) * 2.4, 4.6 + Math.random() * 1.4, (Math.random() - 0.5) * 2);
        g.add(b);
      }
      g.position.set(x, 0, -30 - Math.random() * 8);
      g.scale.setScalar(1.2 + Math.random() * 0.5);
      s.add(g);
    }

    // flower beds
    const fl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshLambertMaterial({ color: '#ffffff' }), 700);
    const m = new THREE.Matrix4();
    const cols = ['#ff8fab', '#ffd66b', '#b28dff', '#ff6f91', '#ffffff', '#8fd3ff', '#ffa94d'].map((c) => new THREE.Color(c));
    for (let i = 0; i < 700; i++) {
      const side = i % 2 ? 1 : -1;
      const x = side * (11.2 + Math.random() * 2.6);
      const z = -17 + Math.random() * 34;
      m.makeTranslation(x, 0.15 + Math.random() * 0.25, z);
      fl.setMatrixAt(i, m);
      fl.setColorAt(i, cols[Math.floor(Math.random() * cols.length)]);
    }
    s.add(fl);
  }

  private buildStands() {
    const stands: Stand[] = [];
    const white = new THREE.MeshLambertMaterial({ color: '#f7f4ff' });
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.5 + r * 0.5;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), white);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        g.add(st);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.5, rowDepth: 0.9, y0: 0.5 });
    };
    mk(-14.5, 0, -Math.PI / 2, 20, 5);
    mk(14.5, 0, Math.PI / 2, 20, 5);
    mk(0, -20, Math.PI, 16, 5);
    this.addCrowd(
      new Crowd({
        stands,
        density: 0.9,
        bodyMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        headMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        shirts: ['#ff8fab', '#8fb8ff', '#ffd66b', '#b28dff', '#8fe3c0', '#ffb38a'].map((c) => new THREE.Color(c)),
        skins: ['#ffe2cc', '#f0c8a8', '#c99a78', '#8f6446'].map((c) => new THREE.Color(c)),
        fill: 0.8,
      }),
    );
  }

  protected onResize(W: number, H: number) {
    const hw = Math.max(1, Math.floor(W / 2)),
      hh = Math.max(1, Math.floor(H / 2));
    this.half.setSize(hw, hh);
    this.kuw.setSize(hw, hh);
    this.kPass.u.uTexel.value.set(1 / hw, 1 / hh);
    this.wPass.u.uRes.value.set(W, H);
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    for (const b of this.balloons) {
      b.position.y += Math.sin(t * 0.5 + b.userData.phase) * 0.01;
      b.position.x += v.realDt * 0.6;
      if (b.position.x > 120) b.position.x = -120;
    }
    for (const w of this.willows) (w.userData.strands as THREE.Group).rotation.y = Math.sin(t * 0.6 + w.position.x) * 0.06;
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    const cols = (a: string[]) => a.map((c) => new THREE.Color(c));
    if (e.type === 'hit') P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: e.perfect ? 16 : 7, speed: [1.5, 4], life: [0.4, 0.9], size: [0.15, 0.3], shrink: 1.5, colors: cols(['#ffd6e7', '#d6e6ff', '#fff2b3']), shape: 'soft', drag: 3, alpha: 0.7 });
    if (e.type === 'bounce' && e.impact > 2) P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 1, speed: [0, 0], life: [1.2, 1.2], size: [0.3, 0.3], shrink: 4, colors: cols([e.out ? '#ff8fab' : '#9fc4ff']), shape: 'ring', alpha: 0.6 });
    if (e.type === 'point') P.burst({ x: 0, y: 7, z: e.winner === 0 ? 6 : -6, count: 90, speed: [2, 6], dir: [0, 1, 0], spread: 0.9, life: [2.5, 4], size: [0.15, 0.25], colors: cols(['#ff8fab', '#ffd66b', '#b28dff', '#8fd3ff']), shape: 'petal', gravity: 1.2, drag: 0.8, spin: 6, ground: true });
  }

  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    r.setRenderTarget(this.half);
    r.setClearColor('#fff8f4', 1);
    r.clear();
    r.render(this.scene, cam);
    r.setClearColor(0x000000, 1);
    this.kPass.u.tSrc.value = this.half.texture;
    this.kPass.render(r, this.kuw);
    const u = this.wPass.u;
    u.tPaint.value = this.kuw.texture;
    u.uTime.value = this.time;
    u.uFlash.value = this.flash * 0.6;
    this.wPass.render(r, target);
  }

  dispose() {
    super.dispose();
    this.half.dispose();
    this.kuw.dispose();
    this.kPass.dispose();
    this.wPass.dispose();
  }
}

export const AQUARELLE: WorldDef = {
  id: 'water',
  name: 'Aquarelle',
  tagline: 'Soft edges, bold shots',
  blurb: 'A garden in watercolour: balloons, willows and a lily pond.',
  ui: {
    accent: '#b28dff',
    accent2: '#ff8fab',
    ink: '#3a3552',
    paper: '#fdf8f1',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Caveat', cursive",
    panel: 'linear-gradient(160deg, rgba(253,250,245,0.97), rgba(245,238,252,0.95))',
  },
  song: 'water',
  surface: 1,
  make: (r) => new WaterWorld(AQUARELLE, r),
};
