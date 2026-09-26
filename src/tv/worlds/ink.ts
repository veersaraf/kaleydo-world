// INKWELL — the court as a living sumi-e painting. Everything is rendered
// normally, then an ink pass turns it into brush outlines, washes of ink and
// rice paper. Only vermilion survives: the ball, the torii, the lanterns, the sun.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass, NormalPass } from '../render/post';
import { NOISE, COLOR } from '../render/glsl';
import type { MatchEvent } from '../tennis/match';

const PAPER = new THREE.Color('#f1e8d4');
const INK = new THREE.Color('#15120f');
const RED = new THREE.Color('#d8321f');

const INK_FRAG = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tNormal; uniform sampler2D tDepth;
uniform vec2 uRes; uniform float uNear; uniform float uFar; uniform float uTime; uniform float uFlash;
uniform vec3 uPaper; uniform vec3 uInk; uniform vec3 uRed;
varying vec2 vUv;
${NOISE}
${COLOR}
float linDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
void main() {
  vec2 px = 1.0 / uRes;
  float t = floor(uTime * 8.0) / 8.0; // strokes "boil" slightly, like a hand-drawn loop
  vec2 wob = (vec2(vnoise(vUv * 42.0 + t * 0.7), vnoise(vUv * 42.0 + 17.7 - t * 0.5)) - 0.5) * px * 3.2;
  vec2 uv = vUv + wob;

  float thick = 0.9 + 1.6 * vnoise(vUv * 7.0 + 4.0);
  vec2 o = px * thick * (uRes.y / 900.0);
  float d0 = linDepth(uv);
  float dl = linDepth(uv - vec2(o.x, 0.0)), dr = linDepth(uv + vec2(o.x, 0.0));
  float dd = linDepth(uv - vec2(0.0, o.y)), du = linDepth(uv + vec2(0.0, o.y));
  float dEdge = (abs(dl - dr) + abs(du - dd)) / max(d0, 0.5);
  vec3 nl = nrm(uv - vec2(o.x, 0.0)), nr = nrm(uv + vec2(o.x, 0.0)), nd = nrm(uv - vec2(0.0, o.y)), nu = nrm(uv + vec2(0.0, o.y));
  float nEdge = (1.0 - dot(nl, nr)) + (1.0 - dot(nu, nd));
  float edge = max(smoothstep(0.05, 0.14, dEdge), smoothstep(0.3, 0.75, nEdge));
  // dry-brush breaks along strokes
  edge *= smoothstep(0.12, 0.5, vnoise(vUv * vec2(110.0, 38.0)) + 0.33);
  edge *= mix(1.0, 0.25, smoothstep(35.0, 170.0, d0));

  vec3 sc = texture2D(tScene, uv).rgb;
  vec3 s = toSRGB(sc);
  float L = luma(s);
  float ink = 1.0 - smoothstep(0.1, 0.93, L);
  float n = fbm(vUv * vec2(5.0, 12.0) + 3.0);
  float wash = floor(ink * 3.0 + n * 0.85) / 3.0;
  wash = mix(wash, ink, 0.35);
  // pigment granulation: soft, and fading out in the darkest strokes (solid ink)
  float gran = fbm(vUv * uRes / 14.0) - 0.5;
  wash = clamp(wash + gran * 0.22 * (1.0 - smoothstep(0.55, 0.9, wash)), 0.0, 1.0);
  wash = mix(wash, 1.0, smoothstep(0.78, 0.95, ink));
  // bleeding: soften the wash edge with paper texture
  float fib = fbm(vUv * vec2(24.0, 72.0)) * 0.55 + hash21(floor(vUv * uRes / 2.0)) * 0.25;
  vec3 paper = uPaper * (0.93 + 0.1 * fib);

  vec3 hsv = rgb2hsv(s);
  float hueRed = 1.0 - smoothstep(0.035, 0.085, min(hsv.x, 1.0 - hsv.x));
  float red = smoothstep(0.35, 0.6, hsv.y) * hueRed * smoothstep(0.18, 0.35, hsv.z);

  vec3 col = mix(paper, uInk, clamp(wash * 0.9, 0.0, 1.0));
  vec3 redInk = uRed * (0.82 + 0.3 * fib) * (0.55 + 0.6 * hsv.z);
  col = mix(col, redInk, red);
  col = mix(col, uInk, clamp(edge, 0.0, 1.0) * 0.93);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q * vec2(uRes.x / uRes.y, 1.0), q) * 0.28;
  col = mix(col, uPaper * 1.1, uFlash);
  gl_FragColor = vec4(toSRGB(col), 1.0);
}`;

class InkWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(INK);
      if (role === 'eyeWhite') return flat(PAPER);
      if (role === 'strings') return stringsMat(new THREE.Color('#888'));
      if (role === 'cheek') return flat(new THREE.Color('#e46a5a'), { transparent: true, opacity: 0.6 });
      return new THREE.MeshLambertMaterial({ color: c });
    },
    outline: null,
    shadowColor: INK,
    shadowOpacity: 0.35,
  };

  private normals!: NormalPass;
  private ink!: Pass;
  private petalT = 0;
  private lanterns: THREE.Object3D[] = [];

  protected samples() {
    return 0;
  }

  protected build() {
    const s = this.scene;
    s.background = PAPER.clone();
    s.fog = new THREE.Fog(PAPER.clone(), 28, 200);
    s.add(new THREE.HemisphereLight('#ffffff', '#8a8378', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(-10, 20, 8);
    s.add(sun);

    // red sun
    const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(26, 48), new THREE.MeshBasicMaterial({ color: RED, fog: false }));
    sunDisc.position.set(-70, 62, -260);
    sunDisc.lookAt(0, 5, 20);
    s.add(sunDisc);

    this.buildMountains();

    // ground: raked gravel
    const raked = canvasTex(1024, 1024, (x) => {
      x.fillStyle = '#ddd5c4';
      x.fillRect(0, 0, 1024, 1024);
      x.strokeStyle = 'rgba(60,50,40,0.35)';
      x.lineWidth = 3;
      for (let y = 0; y < 1024; y += 18) {
        x.beginPath();
        for (let xx = 0; xx <= 1024; xx += 16) x.lineTo(xx, y + Math.sin(xx * 0.012 + y) * 1.5);
        x.stroke();
      }
    });
    raked.wrapS = raked.wrapT = THREE.RepeatWrapping;
    raked.repeat.set(26, 26);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(360, 48), new THREE.MeshLambertMaterial({ map: raked }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    s.add(ground);
    // zen circles raked around stones
    for (const [x, z, r] of [
      [-13, -6, 1.3],
      [14, 5, 1.1],
      [-15, 9, 0.9],
      [12, -12, 1.5],
    ]) {
      for (let k = 1; k <= 4; k++) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r + k * 0.55, r + k * 0.55 + 0.07, 48), new THREE.MeshBasicMaterial({ color: '#7a6f60' }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, 0.01, z);
        s.add(ring);
      }
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), new THREE.MeshLambertMaterial({ color: '#5b554c' }));
      stone.scale.y = 0.6;
      stone.position.set(x, r * 0.3, z);
      stone.rotation.set(Math.random(), Math.random(), Math.random());
      s.add(stone);
    }

    this.buildCourt({
      inner: new THREE.MeshLambertMaterial({ color: '#e7dfcd' }),
      outer: new THREE.MeshLambertMaterial({ color: '#d3cab8' }),
      line: new THREE.MeshBasicMaterial({ color: INK }),
      innerPad: { x: 1.4, z: 2.4 },
      outerSize: { x: 10, z: 17.5 },
      lineWidth: 0.09,
      wobble: 0.035,
    });
    this.buildNet({
      post: new THREE.MeshLambertMaterial({ color: '#2a2520' }),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#2a2520'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.8 }),
      band: new THREE.MeshLambertMaterial({ color: '#f6f0e2' }),
    });

    const ballMat = new THREE.MeshLambertMaterial({ color: RED, emissive: new THREE.Color('#5a0c04') });
    this.buildBall(ballMat, { color: INK.clone(), width: 0.11, opacity: 0.95, mode: 1, length: 26 }, INK.clone(), 0.45);
    this.buildParticles({ fog: false });

    this.buildShrine();
    this.buildBamboo();
    this.buildStands();

    this.normals = new NormalPass(1, 1);
    this.ink = new Pass(INK_FRAG, {
      tScene: { value: null },
      tNormal: { value: null },
      tDepth: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 1200 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
      uPaper: { value: PAPER.clone() },
      uInk: { value: INK.clone() },
      uRed: { value: RED.clone() },
    });
  }

  private buildMountains() {
    const s = this.scene;
    const layers = [
      { z: -70, h: 26, col: '#3a352e', seed: 1, w: 420 },
      { z: -110, h: 44, col: '#4a443b', seed: 2, w: 520 },
      { z: -165, h: 70, col: '#5a5347', seed: 3, w: 700 },
      { z: -240, h: 110, col: '#6a6255', seed: 4, w: 900 },
    ];
    for (const L of layers) {
      const seg = 160;
      const geo = new THREE.BufferGeometry();
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const u = i / seg;
        const x = (u - 0.5) * L.w;
        let y = 0;
        let a = 1,
          f = 1;
        for (let o = 0; o < 5; o++) {
          y += Math.abs(Math.sin(u * f * 9 + L.seed * 3.7 + o * 1.9)) * a;
          a *= 0.5;
          f *= 2.1;
        }
        const peak = Math.pow(y / 1.9, 2.2) * L.h;
        pos.push(x, -8, 0, x, peak, 0);
      }
      for (let i = 0; i < seg; i++) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: L.col, side: THREE.DoubleSide }));
      m.position.z = L.z;
      s.add(m);
    }
    // a pagoda on the first ridge
    const pag = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: '#2e2822' });
    for (let i = 0; i < 5; i++) {
      const w = 5.2 - i * 0.8;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.85, 1.1, 4, 1), wood);
      roof.rotation.y = Math.PI / 4;
      roof.position.y = 3 + i * 2.6;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 2, w * 0.7), new THREE.MeshLambertMaterial({ color: '#b9ae98' }));
      body.position.y = 2 + i * 2.6;
      pag.add(roof, body);
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 6), wood);
    spire.position.y = 16.5;
    pag.add(spire);
    pag.position.set(38, 6, -72);
    pag.scale.setScalar(1.4);
    s.add(pag);
  }

  private buildShrine() {
    const s = this.scene;
    const red = new THREE.MeshLambertMaterial({ color: RED, emissive: new THREE.Color('#300a06') });
    const black = new THREE.MeshLambertMaterial({ color: '#1f1b17' });
    const torii = (x: number, z: number, sc: number, ry = 0) => {
      const g = new THREE.Group();
      for (const sx of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 7, 12), red);
        p.position.set(sx * 3.2, 3.5, 0);
        g.add(p);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.6, 12), black);
        base.position.set(sx * 3.2, 0.3, 0);
        g.add(base);
      }
      const nuki = new THREE.Mesh(new THREE.BoxGeometry(8, 0.4, 0.35), red);
      nuki.position.y = 5.6;
      g.add(nuki);
      // kasagi: curved top beam
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-5.2, 7.9, 0), new THREE.Vector3(0, 6.9, 0), new THREE.Vector3(5.2, 7.9, 0));
      const kasa = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.34, 8), black);
      g.add(kasa);
      const kasa2 = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.26, 8), red);
      kasa2.position.y = -0.5;
      g.add(kasa2);
      const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.1, 0.2), black);
      plaque.position.y = 6.4;
      g.add(plaque);
      g.position.set(x, 0, z);
      g.rotation.y = ry;
      g.scale.setScalar(sc);
      s.add(g);
    };
    torii(0, -21, 1.35);
    torii(-26, -52, 1.1, 0.3);
    torii(30, -44, 0.9, -0.4);

    // stone lanterns at the court corners
    const stone = new THREE.MeshLambertMaterial({ color: '#8d8578' });
    for (const [x, z] of [
      [-8.6, -15.5],
      [8.6, -15.5],
      [-8.6, 14.5],
      [8.6, 14.5],
    ]) {
      const g = new THREE.Group();
      const parts: [THREE.BufferGeometry, number][] = [
        [new THREE.CylinderGeometry(0.55, 0.7, 0.4, 6), 0.2],
        [new THREE.CylinderGeometry(0.18, 0.22, 1.3, 8), 1.05],
        [new THREE.CylinderGeometry(0.5, 0.35, 0.3, 6), 1.8],
        [new THREE.BoxGeometry(0.6, 0.55, 0.6), 2.2],
        [new THREE.ConeGeometry(0.75, 0.55, 6), 2.75],
        [new THREE.SphereGeometry(0.14, 8, 6), 3.1],
      ];
      for (const [geo, y] of parts) {
        const m = new THREE.Mesh(geo, stone);
        m.position.y = y;
        g.add(m);
      }
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.62), new THREE.MeshBasicMaterial({ color: '#ffd9a0' }));
      glow.position.y = 2.2;
      g.add(glow);
      g.position.set(x, 0, z);
      s.add(g);
    }

    // red paper lanterns strung over the far end
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 26, 4), black);
    line.rotation.z = Math.PI / 2;
    line.position.set(0, 7.2, -18.5);
    s.add(line);
    for (let i = 0; i < 9; i++) {
      const x = -11 + i * 2.75;
      const l = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), red);
      body.scale.y = 1.25;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 10), black);
      cap.position.y = 0.58;
      const bot = cap.clone();
      bot.position.y = -0.58;
      l.add(body, cap, bot);
      l.position.set(x, 6.3 - Math.sin((i / 8) * Math.PI) * 0.8, -18.5);
      l.userData.phase = i * 0.7;
      s.add(l);
      this.lanterns.push(l);
    }
  }

  private buildBamboo() {
    const s = this.scene;
    const stalk = new THREE.MeshLambertMaterial({ color: '#4d5a44' });
    const leaf = new THREE.MeshLambertMaterial({ color: '#2b3326', side: THREE.DoubleSide });
    const leafGeo = new THREE.PlaneGeometry(0.22, 1.1);
    leafGeo.translate(0, 0.55, 0);
    const grove = (cx: number, cz: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const h = 9 + Math.random() * 9;
        const x = cx + (Math.random() - 0.5) * 7;
        const z = cz + (Math.random() - 0.5) * 7;
        const g = new THREE.Group();
        const segs = Math.floor(h / 1.4);
        for (let k = 0; k < segs; k++) {
          const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 1.32, 8), stalk);
          seg.position.y = k * 1.4 + 0.7;
          g.add(seg);
          const node = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.03, 4, 10), stalk);
          node.rotation.x = Math.PI / 2;
          node.position.y = k * 1.4 + 1.38;
          g.add(node);
          if (k > segs * 0.45 && Math.random() < 0.7) {
            for (let j = 0; j < 4; j++) {
              const lf = new THREE.Mesh(leafGeo, leaf);
              lf.position.y = k * 1.4 + 1.3;
              lf.rotation.set(-0.9 - Math.random() * 0.6, Math.random() * Math.PI * 2, 0.4);
              g.add(lf);
            }
          }
        }
        g.position.set(x, 0, z);
        g.rotation.z = (Math.random() - 0.5) * 0.08;
        s.add(g);
      }
    };
    grove(-17, -14, 16);
    grove(18, -16, 16);
    grove(-22, 4, 10);
    grove(22, 2, 10);
    grove(-9, -30, 12);
    grove(10, -32, 12);

    // twisted pine
    const pineMat = new THREE.MeshLambertMaterial({ color: '#2a241e' });
    const padMat = new THREE.MeshLambertMaterial({ color: '#39402f' });
    const pine = (x: number, z: number, sc: number, dir: number) => {
      const g = new THREE.Group();
      const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(dir * 1.5, 3, 0.3), new THREE.Vector3(dir * 0.5, 6, -0.5), new THREE.Vector3(dir * 3.5, 8.5, 0)];
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.4, 8), pineMat));
      for (const [px, py, pz, r] of [
        [dir * 3.8, 8.8, 0, 2.6],
        [dir * 1.2, 6.4, -0.6, 2],
        [dir * 5.6, 7.6, 0.4, 1.7],
        [dir * -0.6, 7.8, 0.3, 1.5],
      ]) {
        const pad = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), padMat);
        pad.scale.set(r, r * 0.34, r * 0.8);
        pad.position.set(px, py, pz);
        g.add(pad);
      }
      g.position.set(x, 0, z);
      g.scale.setScalar(sc);
      s.add(g);
    };
    pine(-13, -24, 1.3, 1);
    pine(15, -26, 1.1, -1);
  }

  private buildStands() {
    // wooden engawa platforms with seated ink figures
    const s = this.scene;
    const wood = new THREE.MeshLambertMaterial({ color: '#6b5a48' });
    const stands: Stand[] = [];
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(width, 0.45 + r * 0.45, 1), wood);
        step.position.set(0, (0.45 + r * 0.45) / 2, r * 1 + 0.5);
        g.add(step);
      }
      const roofPosts = new THREE.Group();
      g.add(roofPosts);
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      s.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.8, rows, rowRise: 0.45, rowDepth: 1, y0: 0.45 });
    };
    mk(-10.8, 0, -Math.PI / 2, 20, 4);
    mk(10.8, 0, Math.PI / 2, 20, 4);
    const robes = ['#2a2622', '#3b342d', '#1e1b18', '#4a4037', '#c7342a'].map((c) => new THREE.Color(c));
    const skins = ['#e9dcc6', '#d8c7ad', '#f2e6d2'].map((c) => new THREE.Color(c));
    this.addCrowd(
      new Crowd({
        stands,
        density: 0.85,
        bodyMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        headMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        shirts: robes,
        skins,
        fill: 0.8,
      }),
    );
  }

  protected onResize(W: number, H: number) {
    this.normals.setSize(W, H);
    this.ink.u.uRes.value.set(W, H);
  }

  protected animate(v: FrameView) {
    for (const l of this.lanterns) l.rotation.z = Math.sin(v.realT * 1.4 + l.userData.phase) * 0.08;
    // drifting petals
    this.petalT -= v.realDt;
    if (this.petalT <= 0) {
      this.petalT = 0.18;
      this.particles.burst({
        x: (Math.random() - 0.5) * 30,
        y: 9 + Math.random() * 6,
        z: -18 + Math.random() * 34,
        count: 1,
        speed: [0.3, 0.8],
        dir: [0.6, -0.3, 0.2],
        spread: 0.5,
        life: [7, 10],
        size: [0.12, 0.18],
        colors: [RED, new THREE.Color('#e27a6a')],
        shape: 'petal',
        gravity: 0.25,
        drag: 0.6,
        spin: 2,
        ground: true,
      });
    }
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: big ? 16 : 7, speed: [2, big ? 7 : 4], life: [0.3, 0.7], size: [0.06, big ? 0.22 : 0.14], shrink: 0.3, colors: [INK], shape: 'ink', gravity: 9, drag: 1.5 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      // ink splat that stays on the paper for a while
      P.burst({ x: e.pos.x, y: 0.03, z: e.pos.z, count: 1, speed: [0, 0], life: [2.6, 3.2], size: [0.5, 0.7], colors: [e.out ? RED : INK], shape: 'ink', alpha: 0.85, drag: 10 });
      P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 6, speed: [1, 3], dir: [0, 1, 0], spread: 0.95, life: [0.4, 0.8], size: [0.05, 0.1], colors: [INK], shape: 'ink', gravity: 12, ground: true });
    }
    if (e.type === 'point') {
      P.burst({ x: 0, y: 7, z: e.winner === 0 ? 6 : -6, count: 70, speed: [2, 6], dir: [0, 1, 0], spread: 0.9, life: [2.5, 4], size: [0.14, 0.22], colors: [RED, new THREE.Color('#e27a6a'), new THREE.Color('#f1e8d4')], shape: 'petal', gravity: 1.2, drag: 0.8, spin: 6, ground: true });
    }
  }

  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(PAPER, 1);
    r.clear();
    r.render(this.scene, cam);
    this.normals.render(r, this.scene, cam);
    const u = this.ink.u;
    u.tScene.value = this.sceneRT.texture;
    u.tNormal.value = this.normals.rt.texture;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uTime.value = this.time;
    u.uFlash.value = this.flash * 0.6;
    this.ink.render(r, target);
    r.setClearColor(0x000000, 1);
  }

  dispose() {
    super.dispose();
    this.normals.dispose();
    this.ink.dispose();
  }
}

export const INKWELL: WorldDef = {
  id: 'ink',
  name: 'Inkwell',
  tagline: 'A rally painted in a single breath',
  blurb: 'Brush, paper and silence. Only the ball keeps its colour.',
  ui: {
    accent: '#d8321f',
    accent2: '#d8321f',
    ink: '#15120f',
    paper: '#f1e8d4',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Kaushan Script', cursive",
    panel: 'linear-gradient(160deg, rgba(246,240,226,0.97), rgba(236,228,210,0.95))',
  },
  song: 'ink',
  surface: 0.97,
  make: (r) => new InkWorld(INKWELL, r),
};

