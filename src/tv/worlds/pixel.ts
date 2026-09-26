// BIT KINGDOM — an 8-bit castle court. The world is rendered at a low
// resolution, snapped to a 16-colour palette with ordered dithering and given
// crisp one-pixel outlines, then scaled up with hard square pixels.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass, makeRT } from '../render/post';
import { COLOR } from '../render/glsl';
import type { MatchEvent } from '../tennis/match';

// PICO-8 palette
const PAL = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'];

const PIXEL_FRAG = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tDepth; uniform vec2 uLow; uniform vec3 uPal[16]; uniform float uNear; uniform float uFar; uniform float uFlash;
varying vec2 vUv;
${COLOR}
float bayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return m[idx] / 16.0 - 0.47;
}
float lin(vec2 uv) { float d = texture2D(tDepth, uv).x; float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
void main() {
  vec2 cell = floor(vUv * uLow);
  vec2 uv = (cell + 0.5) / uLow;
  vec3 c = toSRGB(texture2D(tScene, uv).rgb);
  c = mix(c, vec3(1.0), uFlash);
  c += bayer(cell) * 0.085;
  float best = 1e9; vec3 outc = uPal[0];
  for (int i = 0; i < 16; i++) {
    vec3 d = c - uPal[i];
    float e = dot(d * vec3(0.3, 0.59, 0.11), d) + dot(d, d) * 0.25;
    if (e < best) { best = e; outc = uPal[i]; }
  }
  // one-pixel outlines where depth jumps
  vec2 px = 1.0 / uLow;
  float d0 = lin(uv);
  float dmax = max(max(lin(uv + vec2(px.x, 0.0)), lin(uv - vec2(px.x, 0.0))), max(lin(uv + vec2(0.0, px.y)), lin(uv - vec2(0.0, px.y))));
  if ((dmax - d0) / d0 > 0.08 && d0 < 90.0) outc = uPal[1] * 0.6;
  gl_FragColor = vec4(outc, 1.0);
}`;

function boxGeo(w: number, h: number, d: number) {
  return new THREE.BoxGeometry(w, h, d);
}

class PixelWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(new THREE.Color('#000000'));
      if (role === 'eyeWhite') return flat(new THREE.Color('#fff1e8'));
      if (role === 'strings') return stringsMat(new THREE.Color('#fff1e8'));
      if (role === 'cheek') return flat(new THREE.Color('#ff77a8'));
      return new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    },
    outline: null,
    castShadow: false,
    shadowColor: new THREE.Color('#1d2b53'),
    shadowOpacity: 0.6,
  };

  private low!: THREE.WebGLRenderTarget;
  private pix!: Pass;
  private blocks: THREE.Object3D[] = [];
  private clouds: THREE.Object3D[] = [];
  private flags: THREE.Mesh[] = [];

  protected samples() {
    return 0;
  }

  protected build() {
    const s = this.scene;
    s.background = new THREE.Color('#29adff');
    s.fog = new THREE.Fog('#83c8ff', 80, 320);
    s.add(new THREE.HemisphereLight('#ffffff', '#3d6b2a', 2.2));
    const sun = new THREE.DirectionalLight('#fff4d8', 1.8);
    sun.position.set(-12, 25, 10);
    s.add(sun);

    const M = (c: string) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    const grassTop = M('#00e436');
    const dirt = M('#ab5236');
    const stone = M('#c2c3c7');
    const darkStone = M('#5f574f');
    const water = M('#29adff');

    // blocky ground: a checker of grass blocks
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), M('#00b43a'));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    s.add(ground);
    const g2 = new THREE.InstancedMesh(boxGeo(2, 1, 2), grassTop, 900);
    let n = 0;
    const m = new THREE.Matrix4();
    for (let x = -60; x <= 60; x += 2)
      for (let z = -90; z <= 20; z += 2) {
        if (Math.abs(x) < 13 && z > -25) continue;
        if (Math.random() < 0.8 || n >= 900) continue;
        const h = Math.floor(Math.random() * 3);
        m.makeTranslation(x, -0.5 + h * 0.5, z);
        g2.setMatrixAt(n++, m);
      }
    g2.count = n;
    s.add(g2);

    this.buildCourt({
      inner: M('#00a83a'),
      outer: M('#008751'),
      line: flat('#fff1e8'),
      innerPad: { x: 1.2, z: 2 },
      outerSize: { x: 11, z: 19 },
      lineWidth: 0.14,
    });
    this.buildNet({
      post: M('#5f574f'),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#fff1e8'), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      band: flat('#fff1e8'),
    });

    const ballMat = new THREE.MeshLambertMaterial({ color: '#ffec27', flatShading: true });
    this.buildBall(ballMat, { color: new THREE.Color('#ffec27'), color2: new THREE.Color('#ffa300'), width: 0.14, opacity: 1, mode: 2, length: 16 }, new THREE.Color('#1d2b53'), 0.7);
    this.ball.geometry = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    this.buildParticles();

    // castle behind the far end
    const castle = new THREE.Group();
    const wall = new THREE.Mesh(boxGeo(40, 10, 4), stone);
    wall.position.set(0, 5, 0);
    castle.add(wall);
    for (let i = -9; i <= 9; i++) {
      if (i % 2) continue;
      const c = new THREE.Mesh(boxGeo(1.6, 1.6, 4), stone);
      c.position.set(i * 2.1, 10.8, 0);
      castle.add(c);
    }
    const gate = new THREE.Mesh(boxGeo(6, 7, 4.2), darkStone);
    gate.position.set(0, 3.5, 0.1);
    castle.add(gate);
    const tower = (x: number, h: number) => {
      const t = new THREE.Mesh(boxGeo(7, h, 7), stone);
      t.position.set(x, h / 2, 0);
      castle.add(t);
      for (const [dx, dz] of [
        [-2.6, -2.6],
        [2.6, -2.6],
        [-2.6, 2.6],
        [2.6, 2.6],
        [0, -2.6],
        [0, 2.6],
        [-2.6, 0],
        [2.6, 0],
      ]) {
        const c = new THREE.Mesh(boxGeo(1.6, 1.8, 1.6), stone);
        c.position.set(x + dx, h + 0.9, dz);
        castle.add(c);
      }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(5.2, 7, 4), M('#ff004d'));
      roof.position.set(x, h + 5, 0);
      roof.rotation.y = Math.PI / 4;
      castle.add(roof);
      const fg = new THREE.PlaneGeometry(2.6, 1.6, 6, 2);
      fg.translate(1.3, 0, 0);
      fg.userData.base = Float32Array.from(fg.attributes.position.array as Float32Array);
      const flag = new THREE.Mesh(fg, new THREE.MeshLambertMaterial({ color: '#ffec27', side: THREE.DoubleSide }));
      flag.position.set(x, h + 10, 0);
      castle.add(flag);
      this.flags.push(flag);
      const pole = new THREE.Mesh(boxGeo(0.25, 3, 0.25), darkStone);
      pole.position.set(x, h + 9, 0);
      castle.add(pole);
      for (let k = 0; k < 3; k++) {
        const win = new THREE.Mesh(boxGeo(1.2, 1.6, 0.2), flat('#1d2b53'));
        win.position.set(x, h * 0.3 + k * h * 0.22, 3.55);
        castle.add(win);
      }
    };
    tower(-23, 18);
    tower(23, 18);
    tower(-12, 14);
    tower(12, 14);
    const keep = new THREE.Mesh(boxGeo(12, 26, 10), stone);
    keep.position.set(0, 13, -8);
    castle.add(keep);
    const keepRoof = new THREE.Mesh(new THREE.ConeGeometry(9, 10, 4), M('#7e2553'));
    keepRoof.position.set(0, 31, -8);
    keepRoof.rotation.y = Math.PI / 4;
    castle.add(keepRoof);
    castle.position.set(0, 0, -78);
    castle.scale.setScalar(0.85);
    s.add(castle);
    // moat
    const moat = new THREE.Mesh(new THREE.PlaneGeometry(60, 6), water);
    moat.rotation.x = -Math.PI / 2;
    moat.position.set(0, 0.02, -72);
    s.add(moat);

    // voxel trees
    const trunk = M('#ab5236');
    const leafMats = [M('#00e436'), M('#008751')];
    const tree = (x: number, z: number, h: number) => {
      const g = new THREE.Group();
      const t = new THREE.Mesh(boxGeo(1, h, 1), trunk);
      t.position.y = h / 2;
      g.add(t);
      const lm = leafMats[Math.floor(Math.random() * 2)];
      const L1 = new THREE.Mesh(boxGeo(5, 2, 5), lm);
      L1.position.y = h + 0.5;
      const L2 = new THREE.Mesh(boxGeo(3.4, 2, 3.4), lm);
      L2.position.y = h + 2.5;
      const L3 = new THREE.Mesh(boxGeo(1.8, 1.4, 1.8), lm);
      L3.position.y = h + 4;
      g.add(L1, L2, L3);
      g.position.set(x, 0, z);
      s.add(g);
    };
    for (let i = 0; i < 40; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (22 + Math.random() * 50);
      const z = -80 + Math.random() * 95;
      tree(Math.round(x), Math.round(z), 3 + Math.floor(Math.random() * 4));
    }

    // floating crystal blocks
    const crystal = M('#ffa300');
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Mesh(boxGeo(1.6, 1.6, 1.6), crystal);
      const face = new THREE.Mesh(boxGeo(0.5, 0.9, 1.7), flat('#fff1e8'));
      b.add(face);
      b.position.set(-18 + i * 6, 12 + (i % 2) * 2, -26);
      b.userData.phase = i;
      s.add(b);
      this.blocks.push(b);
    }

    // blocky clouds
    const cloudMat = flat('#fff1e8');
    for (let i = 0; i < 16; i++) {
      const c = new THREE.Group();
      const w = 3 + Math.floor(Math.random() * 4);
      for (let k = 0; k < w; k++) {
        const b = new THREE.Mesh(boxGeo(4, 2 + (k % 2) * 2, 4), cloudMat);
        b.position.set(k * 4 - w * 2, (k % 2) * 1, 0);
        c.add(b);
      }
      c.position.set(-200 + Math.random() * 400, 40 + Math.random() * 40, -100 - Math.random() * 150);
      s.add(c);
      this.clouds.push(c);
    }

    // stone stands with a blocky crowd
    const stands: Stand[] = [];
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.6 + r * 0.6;
        const st = new THREE.Mesh(boxGeo(width, hgt, 1), r % 2 ? stone : darkStone);
        st.position.set(0, hgt / 2, r + 0.5);
        g.add(st);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      s.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.6, rowDepth: 1, y0: 0.6 });
    };
    mk(-10.5, 0, -Math.PI / 2, 22, 6);
    mk(10.5, 0, Math.PI / 2, 22, 6);
    mk(0, -19.5, Math.PI, 16, 5);
    this.addCrowd(
      new Crowd({
        stands,
        density: 1,
        bodyMat: new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }),
        headMat: new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }),
        shirts: ['#ff004d', '#29adff', '#ffec27', '#00e436', '#ff77a8', '#ffa300', '#83769c', '#fff1e8'].map((c) => new THREE.Color(c)),
        skins: ['#ffccaa', '#ab5236', '#ffccaa', '#fff1e8'].map((c) => new THREE.Color(c)),
        fill: 0.9,
      }),
    );

    this.low = makeRT(320, 180, { depth: true, filter: THREE.NearestFilter });
    this.pix = new Pass(PIXEL_FRAG, {
      tScene: { value: null },
      tDepth: { value: null },
      uLow: { value: new THREE.Vector2(320, 180) },
      uPal: { value: [] as THREE.Vector3[] },
      uNear: { value: 0.1 },
      uFar: { value: 1200 },
      uFlash: { value: 0 },
    });
    // palette in sRGB space (the shader compares sRGB values)
    this.pix.u.uPal.value = PAL.map((hex) => {
      const n = parseInt(hex.slice(1), 16);
      return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    });
  }

  protected onResize(W: number, H: number) {
    // ~270 pixel rows, whatever the window shape
    const rows = 270;
    const cols = Math.round((rows * W) / H);
    this.low.setSize(cols, rows);
    this.pix.u.uLow.value.set(cols, rows);
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    for (const b of this.blocks) {
      b.rotation.y = t * 0.8 + b.userData.phase;
      b.position.y = 12 + Math.sin(t * 2 + b.userData.phase) * 0.6 + (b.userData.phase % 2) * 2;
    }
    for (const c of this.clouds) {
      c.position.x += v.realDt * 2;
      if (c.position.x > 220) c.position.x = -220;
    }
    for (const f of this.flags) {
      const pos = f.geometry.attributes.position as THREE.BufferAttribute;
      const base = f.geometry.userData.base as Float32Array;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.round(Math.sin(t * 6 + base[i * 3] * 2) * 2) * 0.12 * base[i * 3]);
      pos.needsUpdate = true;
    }
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    const cols = (a: string[]) => a.map((c) => new THREE.Color(c));
    if (e.type === 'hit') {
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: e.perfect ? 18 : 8, speed: [2, 6], life: [0.3, 0.6], size: [0.12, 0.22], colors: cols(['#ffec27', '#fff1e8', '#ffa300']), shape: 'square', gravity: 8, spin: 0 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      P.burst({ x: e.pos.x, y: 0.1, z: e.pos.z, count: 6, speed: [1, 3], dir: [0, 1, 0], spread: 0.9, life: [0.3, 0.5], size: [0.12, 0.18], colors: cols(e.out ? ['#ff004d'] : ['#00e436', '#008751']), shape: 'square', gravity: 12, spin: 0 });
    }
    if (e.type === 'point') {
      P.burst({ x: 0, y: 7, z: e.winner === 0 ? 6 : -6, count: 90, speed: [3, 9], dir: [0, 1, 0], spread: 0.9, life: [1.6, 2.8], size: [0.2, 0.3], colors: cols(['#ff004d', '#ffec27', '#29adff', '#00e436', '#ff77a8', '#fff1e8']), shape: 'square', gravity: 6, spin: 0, ground: true });
    }
  }

  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    r.setRenderTarget(this.low);
    r.setClearColor('#29adff', 1);
    r.clear();
    r.render(this.scene, cam);
    const u = this.pix.u;
    u.tScene.value = this.low.texture;
    u.tDepth.value = this.low.depthTexture;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uFlash.value = this.flash * 0.7;
    this.pix.render(r, target);
    r.setClearColor(0x000000, 1);
  }

  dispose() {
    super.dispose();
    this.low.dispose();
    this.pix.dispose();
  }
}

export const PIXEL: WorldDef = {
  id: 'pixel',
  name: 'Bit Kingdom',
  tagline: 'Press start to serve',
  blurb: 'Sixteen colours, square pixels and a castle full of fans.',
  ui: {
    accent: '#ff004d',
    accent2: '#ffec27',
    ink: '#1d2b53',
    paper: '#fff1e8',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Press Start 2P', monospace",
    panel: 'linear-gradient(160deg, rgba(255,241,232,0.97), rgba(255,241,232,0.94))',
  },
  song: 'pixel',
  surface: 1,
  make: (r) => new PixelWorld(PIXEL, r),
};
