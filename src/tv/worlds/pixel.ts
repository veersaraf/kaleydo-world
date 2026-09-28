// BIT KINGDOM — an 8-bit castle court. The world is rendered at a low
// resolution (270 rows), snapped to a 16-colour palette with ordered
// dithering and given crisp one-pixel outlines, then scaled up with hard
// square pixels.
//
// Round it, a 16-bit game's parallax: a dithered sky with the sun behind the
// players, snow-capped mountains with waterfalls, green hills, a rainbow over
// the castle, clouds drifting in sprite steps, waterfalls pouring from the
// castle walls into its moat, flags and ?-blocks, birds, and a village with a
// windmill behind the players (pixel-env/). Everything moves in shaders.
//
// The palette pass runs once per low-resolution pixel (not once per screen
// pixel); a second pass scales the result up, optionally through a CRT
// (?crt in the URL): curved glass, scanlines and phosphor glow — all in the
// palette's own colours.

import * as THREE from 'three';
import { FIRE_STYLE } from '../render/smashfx';

const cs = (a: string[]) => a.map((c) => new THREE.Color(c));
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass, makeRT } from '../render/post';
import { COLOR } from '../render/glsl';
import type { MatchEvent } from '../tennis/match';
import { pixelSky, land, rainbow, PixelClouds } from './pixel-env/backdrop';
import { water, flags, questionBlocks, village } from './pixel-env/props';
import { Birds } from './park-env/props';

// PICO-8 palette
const PAL = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'];
/** each colour's darker neighbour in the palette (the CRT's scanlines) */
const DARK = [0, 0, 1, 1, 2, 0, 13, 6, 2, 4, 9, 3, 1, 5, 2, 4];

/** the sun, behind the players' end: the castle is lit from the front, the rainbow stands opposite */
const SUN = new THREE.Vector3(-0.35, 0.5, 0.8).normalize();

/** The CRT, off unless asked for (?crt): curvature and scanlines cost a little readability. */
const CRT = typeof location !== 'undefined' && new URLSearchParams(location.search).has('crt');

/** At low resolution: the scene snapped to the palette (with its index in alpha), one-pixel outlines. */
const QUANT_FRAG = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tDepth; uniform vec3 uPal[16]; uniform float uNear; uniform float uFar; uniform float uFlash;
varying vec2 vUv;
${COLOR}
float bayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return m[idx] / 16.0 - 0.47;
}
float lin(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(tDepth, 0) - 1);
  float z = texelFetch(tDepth, p, 0).x * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec3 c = toSRGB(texelFetch(tScene, ip, 0).rgb);
  c = mix(c, vec3(1.0), uFlash);
  c += bayer(gl_FragCoord.xy - 0.5) * 0.085;
  float best = 1e9; int bi = 0;
  for (int i = 0; i < 16; i++) {
    vec3 d = c - uPal[i];
    float e = dot(d * vec3(0.3, 0.59, 0.11), d) + dot(d, d) * 0.25;
    if (e < best) { best = e; bi = i; }
  }
  // one-pixel outlines where depth jumps (navy, darkened: the palette's darkest blue-black)
  float d0 = lin(ip);
  float dmax = max(max(lin(ip + ivec2(1, 0)), lin(ip - ivec2(1, 0))), max(lin(ip + ivec2(0, 1)), lin(ip - ivec2(0, 1))));
  vec3 outc = uPal[bi];
  if ((dmax - d0) / d0 > 0.08 && d0 < 90.0) { outc = uPal[1] * 0.6; bi = 0; }
  gl_FragColor = vec4(outc, float(bi) / 15.0);
}`;

/** At screen resolution: hard square pixels, or a CRT's glass, scanlines and glow (in the palette). */
const SHOW_FRAG = /* glsl */ `
uniform sampler2D tLow; uniform vec3 uPal[16]; uniform int uDark[16]; uniform float uCrt; uniform vec2 uLow; uniform vec2 uRes;
varying vec2 vUv;
int idx(vec4 q) { return int(q.a * 15.0 + 0.5); }
// the curved glass: a gentle barrel (−1..1 across the view)
vec2 barrel(vec2 uv) { vec2 p = uv * 2.0 - 1.0; return p * (1.0 + dot(p, p) * vec2(0.022, 0.03)); }
// which low-res pixel a screen point shows
vec2 cellAt(vec2 uv) { return floor((barrel(uv) * 0.5 + 0.5) * uLow); }
void main() {
  if (uCrt < 0.5) { gl_FragColor = vec4(texture2D(tLow, vUv).rgb, 1.0); return; }
  vec2 p = barrel(vUv);
  // black beyond the tube's rounded corners
  vec2 corner = max(abs(p) - 0.94, 0.0);
  if (any(greaterThan(abs(p), vec2(1.0))) || length(corner) > 0.05) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 cell = cellAt(vUv);
  ivec2 ip = clamp(ivec2(cell), ivec2(0), ivec2(uLow) - 1);
  vec4 q = texelFetch(tLow, ip, 0);
  int i = idx(q);
  vec3 col = q.rgb;
  // where this screen pixel sits in its low-res pixel, from its neighbours' cells (exact
  // one-pixel lines along the curve: testing a fraction would alias into moiré rings)
  vec2 px = 1.0 / uRes;
  bool lastRow = cellAt(vUv - vec2(0.0, px.y)).y != cell.y;
  bool firstCol = cellAt(vUv - vec2(px.x, 0.0)).x != cell.x;
  bool lastCol = cellAt(vUv + vec2(px.x, 0.0)).x != cell.x;
  // phosphor glow: a brighter neighbour bleeds into this pixel's edge in its darker shade
  if (firstCol || lastCol) {
    vec4 qn = texelFetch(tLow, clamp(ip + ivec2(firstCol ? -1 : 1, 0), ivec2(0), ivec2(uLow) - 1), 0);
    if (dot(qn.rgb, vec3(0.3, 0.59, 0.11)) > dot(col, vec3(0.3, 0.59, 0.11)) + 0.35) col = uPal[uDark[idx(qn)]];
  }
  // scanlines: the bottom screen row of every pixel row, one shade down
  if (lastRow) col = uPal[uDark[i]];
  gl_FragColor = vec4(col, 1.0);
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

  /** the CRT look (see SHOW_FRAG) */
  crt = CRT;
  private u = { uTime: { value: 0 } };
  private low!: THREE.WebGLRenderTarget;
  private lowQ!: THREE.WebGLRenderTarget;
  private quant!: Pass;
  private show!: Pass;
  private clouds!: PixelClouds;
  private birds!: Birds;

  protected samples() {
    return 0;
  }

  protected build() {
    // a smash in 8-bit: a blocky fireball and a pixel crater
    this.smashStyle = { ...FIRE_STYLE, fire: cs(['#ffec27', '#ffa300', '#ff004d']), fireShape: 'square', sparks: cs(['#ffec27', '#fff1e8', '#ffa300']), sparkShape: 'square', ring: new THREE.Color('#fff1e8'), hot: new THREE.Color('#ffa300'), scorch: new THREE.Color('#1d2b53'), scorchAlpha: 0.72, dust: cs(['#c2c3c7', '#fff1e8']), dustShape: 'square', flash: new THREE.Color('#fff1e8') };
    const s = this.scene;
    // the fields fade into the green of the hills (the sky's blue would draw a false river at their foot)
    s.fog = new THREE.Fog('#2fb85a', 90, 260);
    s.add(new THREE.HemisphereLight('#ffffff', '#3d6b2a', 2.2));
    const sun = new THREE.DirectionalLight('#fff4d8', 1.8);
    sun.position.copy(SUN).multiplyScalar(30);
    s.add(sun);

    const M = (c: string) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    const grassTop = M('#00e436');
    const stone = M('#c2c3c7');
    const darkStone = M('#5f574f');

    this.buildBackdrop();

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
    const flagAt: THREE.Matrix4[] = [];
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
      flagAt.push(new THREE.Matrix4().makeTranslation(x, h + 10, 0));
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
    // the towers' flags, and a banner on the keep
    flagAt.push(new THREE.Matrix4().makeTranslation(0, 39, -8));
    castle.add(flags(this.u, flagAt, '#ffec27'));
    const keepPole = new THREE.Mesh(boxGeo(0.25, 4, 0.25), darkStone);
    keepPole.position.set(0, 37.5, -8);
    castle.add(keepPole);
    castle.position.set(0, 0, -78);
    castle.scale.setScalar(0.85);
    s.add(castle);
    // the moat, fed by waterfalls from the walls (the rest of the world's water is in the backdrop)
    s.add(water(this.u));

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
    // round the village behind the players
    for (const [x, z] of [
      [-52, 30],
      [-26, 70],
      [4, 76],
      [30, 66],
      [52, 44],
      [-14, 36],
      [38, 28],
    ])
      tree(x, z, 3 + Math.floor(Math.random() * 4));

    // floating ?-blocks
    s.add(questionBlocks(this.u, Array.from({ length: 7 }, (_, i) => new THREE.Vector3(-18 + i * 6, 12 + (i % 2) * 2, -26))));

    // the village
    s.add(...village(this.u));

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
    // (four rows at the sides: the courtside attract shot looks over the back row)
    mk(-10.5, 0, -Math.PI / 2, 22, 4);
    mk(10.5, 0, Math.PI / 2, 22, 4);
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
    this.lowQ = makeRT(320, 180, { type: THREE.UnsignedByteType, filter: THREE.NearestFilter });
    // palette in sRGB space (the shader compares sRGB values)
    const pal = PAL.map((hex) => {
      const n = parseInt(hex.slice(1), 16);
      return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    });
    this.quant = new Pass(QUANT_FRAG, {
      tScene: { value: null },
      tDepth: { value: null },
      uPal: { value: pal },
      uNear: { value: 0.1 },
      uFar: { value: 1200 },
      uFlash: { value: 0 },
    });
    this.show = new Pass(SHOW_FRAG, {
      tLow: { value: this.lowQ.texture },
      uPal: { value: pal },
      uDark: { value: DARK },
      uCrt: { value: 0 },
      uLow: { value: new THREE.Vector2(320, 180) },
      uRes: { value: new THREE.Vector2(1, 1) },
    });
    this.quant.mat.name = 'pixel.quant';
    this.show.mat.name = 'pixel.show';
  }

  /** Sky, mountains, hills, the rainbow, clouds and birds. */
  private buildBackdrop() {
    const s = this.scene;
    s.add(pixelSky(SUN));
    s.add(
      land(
        this.u,
        [
          // waterfalls on the mountains either side of the castle, and round the back
          { radius: 300, height: [34, 105], peaks: 17, kind: 0, seed: 3, falls: [-0.42, 0.37, 1.35, -1.5, 2.6] },
          { radius: 200, height: [10, 30], peaks: 22, kind: 1, seed: 8 },
        ],
        SUN,
      ),
    );
    // framing the castle from behind, its feet in the hills
    s.add(rainbow(new THREE.Vector3(0, -36, -250), 118, 16));
    this.clouds = new PixelClouds(this.u, { count: 24, radius: [130, 280], height: [32, 92], size: [34, 70], seed: 6 });
    s.add(this.clouds.mesh);
    this.birds = new Birds(
      this.u,
      [
        { x: 0, y: 34, z: -95, radius: 24, count: 6, speed: 0.22 },
        { x: -10, y: 26, z: 60, radius: 18, count: 5, speed: -0.25 },
      ],
      '#1d2b53',
    );
    s.add(this.birds.mesh);
  }

  protected onResize(W: number, H: number) {
    // ~270 pixel rows, whatever the window shape
    const rows = 270;
    const cols = Math.round((rows * W) / H);
    this.low.setSize(cols, rows);
    this.lowQ.setSize(cols, rows);
    this.show.u.uLow.value.set(cols, rows);
    this.show.u.uRes.value.set(W, H);
  }

  protected onDetail(d: number) {
    this.clouds.setDetail(d);
    this.birds.setDetail(d);
  }

  protected animate(v: FrameView) {
    this.u.uTime.value = v.realT;
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
    const q = this.quant.u;
    q.tScene.value = this.low.texture;
    q.tDepth.value = this.low.depthTexture;
    q.uNear.value = cam.near;
    q.uFar.value = cam.far;
    q.uFlash.value = this.flash * 0.7;
    this.quant.render(r, this.lowQ);
    this.show.u.uCrt.value = this.crt ? 1 : 0;
    this.show.render(r, target);
    r.setClearColor(0x000000, 1);
  }

  dispose() {
    super.dispose();
    this.low.dispose();
    this.lowQ.dispose();
    this.quant.dispose();
    this.show.dispose();
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
