// INKWELL — the court as a living sumi-e painting. Everything is rendered
// normally, then an ink pass turns it into brush outlines, washes of ink and
// rice paper. Only vermilion survives: the ball, the torii, the lanterns, the
// bridge and the sun.
//
// The valley lives: ranges of ink-wash mountains dissolve into mist that drifts
// along their feet, bamboo bends in the wind, cranes circle over the mist, wash
// clouds sail round, and every bounce leaves a splat of ink that bleeds into the
// paper. The scenery moves in shaders from a couple of uniforms (ink-env/).
//
// The brush lines come from the depth buffer alone: 1/depth is linear across a
// flat face on screen, so its second difference is zero on faces and spikes at
// creases and silhouettes. (Normals would need the scene drawn a second time.)

import * as THREE from 'three';
import { FIRE_STYLE } from '../render/smashfx';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Pass } from '../render/post';
import { COLOR } from '../render/glsl';
import type { DofState } from '../render/effects';
import type { MatchEvent } from '../tennis/match';
import { Wind, sway } from './park-env/wind';
import { paperTexture } from './ink-env/paper';
import { Mountains, type Range, type Bank } from './ink-env/mountains';
import { sunAndEnso, InkClouds, Cranes } from './ink-env/sky';
import { Bamboo, Willows, grove, type Stalk } from './ink-env/bamboo';
import { InkSplats } from './ink-env/splats';

const PAPER = new THREE.Color('#f1e8d4');
const INK = new THREE.Color('#15120f');
const RED = new THREE.Color('#d8321f');

const INK_FRAG = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tDepth; uniform sampler2D tPaper;
uniform vec2 uRes; uniform float uNear; uniform float uFar; uniform float uTime; uniform float uFlash;
uniform vec3 uPaper; uniform vec3 uInk; uniform vec3 uRed;
// ink depth of field (replays): out of focus, the brush lines thin and the washes pale
uniform vec2 uDof;
varying vec2 vUv;
${COLOR}
// whole texels only: the second difference is exactly zero on a face only if
// both neighbours are the same distance away (a snapped fractional offset isn't,
// and on the ground at a grazing angle that alone would draw lines)
float invZ(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(tDepth, 0) - 1);
  return (uFar - texelFetch(tDepth, p, 0).x * (uFar - uNear)) / (uNear * uFar);
}
void main() {
  vec2 px = 1.0 / uRes;
  // the sheet: fixed to the screen like the paper under the painting, its fibres
  // the same size at any resolution
  vec2 pp = gl_FragCoord.xy * (1080.0 / uRes.y) / 512.0;
  vec4 P = texture2D(tPaper, pp);
  vec4 Q = texture2D(tPaper, pp * 0.21 + 0.37);
  // the lines boil slightly, 8 times a second, like a hand-drawn loop
  float t = floor(uTime * 8.0) / 8.0;
  vec2 wob = (texture2D(tPaper, vUv * vec2(2.2, 1.3) + t * vec2(0.137, 0.291)).ba - 0.5) * px * 3.4;
  vec2 uv = vUv + wob;

  // brush lines: pressure (the width) varies along each stroke
  float thick = 0.75 + 1.8 * Q.b;
  ivec2 ip = ivec2(uv * vec2(textureSize(tDepth, 0)));
  int k = int(clamp(thick * uRes.y / 900.0 + 0.5, 1.0, 4.0));
  float w0 = invZ(ip);
  float wl = invZ(ip - ivec2(k, 0)), wr = invZ(ip + ivec2(k, 0));
  float wd = invZ(ip - ivec2(0, k)), wu = invZ(ip + ivec2(0, k));
  float e2 = (abs(wl + wr - 2.0 * w0) + abs(wu + wd - 2.0 * w0)) / w0;
  float z0 = 1.0 / w0;
  float edge = smoothstep(0.0022, 0.009, e2);
  // dry-brush breaks (flying white) running along the stroke
  vec2 g = vec2(wr - wl, wu - wd);
  vec2 n = g / max(length(g), 1e-9);
  vec2 fc = gl_FragCoord.xy * (1080.0 / uRes.y);
  float br = texture2D(tPaper, vec2(dot(fc, vec2(-n.y, n.x)) * 0.0022, dot(fc, n) * 0.045)).a;
  edge *= smoothstep(0.12, 0.42, br + 0.2);
  vec3 sc = texture2D(tScene, uv).rgb;
  vec3 s = toSRGB(sc);
  float L = luma(s);
  float ink = 1.0 - smoothstep(0.1, 0.93, L);

  // the ink runs thin in the distance, and the far ranges are washes with no
  // outline at all; out there only things with some tone of their own are outlined
  // (not bare paper meeting paper, like a misty range's foot on the plain)
  edge *= mix(1.0, 0.3, smoothstep(35.0, 150.0, z0)) * (1.0 - smoothstep(150.0, 240.0, z0));
  edge *= mix(1.0, smoothstep(0.03, 0.25, ink), smoothstep(50.0, 110.0, z0));
  float blur = 0.0;
  if (uDof.y > 0.0) {
    blur = smoothstep(0.15, 0.6, uDof.y * abs(z0 - uDof.x) / z0);
    edge *= 1.0 - blur * 0.75;
    ink *= 1.0 - blur * 0.35;
  }
  // three washes, their borders wandering and bleeding a little along the fibres
  // (pale tones stay clear of the first border, so bare paper never mottles)
  float v = ink * 3.0 + (Q.b - 0.5) * 0.55 + (P.r - 0.5) * 0.14 + 0.3;
  float lvl = floor(v) / 3.0;
  // a wet edge: pigment gathers where a wash of real ink stopped
  float wet = (1.0 - smoothstep(0.0, 0.14, fract(v))) * step(2.0, v) * 0.12 * (1.0 - blur);
  float wash = clamp(mix(lvl, ink, 0.3) + wet, 0.0, 1.0);
  // granulation: pigment settles into the paper's tooth (solid ink covers it)
  wash = clamp(wash + (P.g - 0.5) * 0.18 * (1.0 - smoothstep(0.55, 0.9, wash)) * smoothstep(0.02, 0.1, wash), 0.0, 1.0);
  wash = mix(wash, 1.0, smoothstep(0.78, 0.95, ink));
  vec3 paper = uPaper * (0.93 + 0.1 * P.r + 0.05 * (Q.a - 0.5));

  vec3 hsv = rgb2hsv(s);
  float hueRed = 1.0 - smoothstep(0.035, 0.085, min(hsv.x, 1.0 - hsv.x));
  float red = smoothstep(0.35, 0.6, hsv.y) * hueRed * smoothstep(0.18, 0.35, hsv.z);

  vec3 col = mix(paper, uInk, clamp(wash * 0.9, 0.0, 1.0));
  // vermilion: cinnabar is granular and a little uneven
  vec3 redInk = uRed * (0.84 + 0.26 * P.r - 0.12 * P.g) * (0.55 + 0.6 * hsv.z);
  col = mix(col, redInk, red);
  col = mix(col, uInk, clamp(edge, 0.0, 1.0) * 0.93);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q * vec2(uRes.x / uRes.y, 1.0), q) * 0.3;
  col = mix(col, uPaper * 1.1, uFlash);
  gl_FragColor = vec4(toSRGB(col), 1.0);
}`;

/** The mountain ranges round the valley: dark hills close by, karst behind, pale giants on the horizon. */
const RANGES: Range[] = [
  // (the near hills and the karst part straight behind the far end: a valley for the sun to set in)
  { radius: 64, from: -1.3, to: -0.13, height: [5, 13], peaks: 4, tone: 0, sharp: 0.25, mist: 1.2, seed: 11 },
  { radius: 64, from: 0.13, to: 1.3, height: [5, 13], peaks: 4, tone: 0, sharp: 0.25, mist: 1.2, seed: 16 },
  { radius: 108, from: -2.1, to: -0.08, height: [9, 34], peaks: 5, tone: 0.25, sharp: 0.7, mist: 3.5, seed: 12 },
  { radius: 108, from: 0.08, to: 2.1, height: [9, 34], peaks: 5, tone: 0.25, sharp: 0.7, mist: 3.5, seed: 17 },
  { radius: 168, from: -Math.PI, to: Math.PI, height: [14, 58], peaks: 13, tone: 0.5, sharp: 0.45, mist: 7, seed: 13 },
  { radius: 245, from: -Math.PI, to: Math.PI, height: [22, 88], peaks: 13, tone: 0.75, sharp: 0.3, mist: 12, seed: 14 },
  { radius: 335, from: -Math.PI, to: Math.PI, height: [28, 118], peaks: 11, tone: 1, sharp: 0.15, mist: 18, seed: 15 },
];

/** Mist banks drifting between the ranges. */
const BANKS: Bank[] = [
  { radius: 58, from: -1.35, to: 1.35, y: [-1.5, 6], seed: 1 },
  { radius: 92, from: -2.05, to: 2.05, y: [0, 13], seed: 2 },
  { radius: 142, from: -2.75, to: 2.75, y: [3, 24], seed: 3 },
  { radius: 205, from: -Math.PI, to: Math.PI, y: [8, 36], seed: 4 },
];

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

  private ink!: Pass;
  private paper = paperTexture();
  private petalT = 0;
  private lanterns: THREE.Object3D[] = [];
  /** one breeze for the bamboo */
  private wind = new Wind(0.9, -0.35, 1.1);
  private mountains!: Mountains;
  private clouds!: InkClouds;
  private cranes!: Cranes;
  private bamboo!: Bamboo;
  private willows!: Willows;
  private splats!: InkSplats;
  /** the ball's last position and travel direction (for a splat's droplets) */
  private ballPrev = new THREE.Vector3();
  private ballDir = 0;
  private dof: DofState | null = null;

  protected samples() {
    return 0;
  }

  protected build() {
    // a smash in ink: a black-and-vermilion streak, a splash of ink where it lands
    this.smashStyle = { ...FIRE_STYLE, fire: [INK.clone(), INK.clone(), RED.clone()], fireShape: 'ink', sparks: [INK.clone(), RED.clone()], sparkShape: 'ink', ring: INK.clone(), hot: RED.clone(), scorch: INK.clone(), scorchAlpha: 0.78, dust: [INK.clone()], dustShape: 'ink', flash: new THREE.Color('#fffaf0') };
    const s = this.scene;
    s.background = PAPER.clone();
    s.fog = new THREE.Fog(PAPER.clone(), 28, 200);
    s.add(new THREE.HemisphereLight('#ffffff', '#8a8378', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(-10, 20, 8);
    s.add(sun);

    this.buildSky();

    // ground: raked gravel, pale enough that in the distance it melts into the paper
    const raked = canvasTex(1024, 1024, (x) => {
      x.fillStyle = '#e6decb';
      x.fillRect(0, 0, 1024, 1024);
      x.strokeStyle = 'rgba(60,50,40,0.3)';
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
    const ringMat = new THREE.MeshBasicMaterial({ color: '#7a6f60' });
    const stoneMat = new THREE.MeshLambertMaterial({ color: '#5b554c' });
    for (const [x, z, r] of [
      [-13, -6, 1.3],
      [14, 5, 1.1],
      [-15, 9, 0.9],
      [12, -12, 1.5],
    ]) {
      for (let k = 1; k <= 4; k++) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r + k * 0.55, r + k * 0.55 + 0.07, 48), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, 0.01, z);
        s.add(ring);
      }
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 1), stoneMat);
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
    this.buildPond();
    this.buildStands();
    this.buildBanners();

    this.splats = new InkSplats({ ink: INK, red: RED, paper: PAPER, noise: this.paper });
    this.ink = new Pass(INK_FRAG, {
      tScene: { value: null },
      tDepth: { value: null },
      tPaper: { value: this.paper },
      uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 1200 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
      uPaper: { value: PAPER.clone() },
      uInk: { value: INK.clone() },
      uRed: { value: RED.clone() },
      uDof: { value: new THREE.Vector2(10, 0) },
    });
    this.ink.mat.name = 'ink';
    // a soft wash under each planted foot (render/effects.ts): the players stand on the paper
    this.effects = { contact: { strength: 0.45, color: new THREE.Color('#5a544a') } };
  }

  init() {
    super.init();
    // splats land where the ball does, in world space: not in the scenery (which
    // turns round for the far player's half of a split screen)
    this.scene.add(this.splats.mesh);
  }

  /** Mountains and mist, the sun in its ensō, clouds and cranes. */
  private buildSky() {
    const s = this.scene;
    this.mountains = new Mountains(RANGES, BANKS, { paper: PAPER, ink: INK, noise: this.paper });
    s.add(this.mountains.ranges, this.mountains.mist);
    // low behind the far end, framed by the great torii from the players' end,
    // setting between the near hills with the mist rising round its foot
    s.add(sunAndEnso({ pos: new THREE.Vector3(0, 21, -140), radius: 10, red: RED, ink: INK, noise: this.paper }));
    // (low enough to drift in front of the far ranges)
    this.clouds = new InkClouds({ count: 12, radius: [180, 300], height: [24, 58], size: [60, 110], seed: 5 });
    s.add(this.clouds.mesh);
    this.cranes = new Cranes(
      this.mountains.u,
      [
        { x: 10, y: 24, z: -95, radius: 68, count: 7, speed: 0.075 },
        { x: -30, y: 30, z: 55, radius: 50, count: 5, speed: -0.1 },
      ],
      { white: new THREE.Color('#e9e1cf'), black: INK, red: RED },
    );
    s.add(this.cranes.mesh);
    // a pagoda on the valley floor between the near hills, rising out of the mist
    const pag = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: '#2e2822' });
    const wall = new THREE.MeshLambertMaterial({ color: '#b9ae98' });
    for (let i = 0; i < 5; i++) {
      const w = 5.2 - i * 0.8;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.85, 1.1, 4, 1), wood);
      roof.rotation.y = Math.PI / 4;
      roof.position.y = 3 + i * 2.6;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 2, w * 0.7), wall);
      body.position.y = 2 + i * 2.6;
      pag.add(roof, body);
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 6), wood);
    spire.position.y = 16.5;
    pag.add(spire);
    pag.position.set(Math.sin(0.62) * 86, 0, -Math.cos(0.62) * 86);
    pag.scale.setScalar(1.6);
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
    const glowMat = new THREE.MeshBasicMaterial({ color: '#ffd9a0' });
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
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.62), glowMat);
      glow.position.y = 2.2;
      g.add(glow);
      g.position.set(x, 0, z);
      s.add(g);
    }

    // red paper lanterns strung over the far end (clear of the reverse shot's camera beyond it)
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 20.5, 4), black);
    line.rotation.z = Math.PI / 2;
    line.position.set(0, 7.2, -18.5);
    s.add(line);
    for (let i = 0; i < 7; i++) {
      const x = -8.25 + i * 2.75;
      const l = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), red);
      body.scale.y = 1.25;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 10), black);
      cap.position.y = 0.58;
      const bot = cap.clone();
      bot.position.y = -0.58;
      l.add(body, cap, bot);
      l.position.set(x, 6.3 - Math.sin((i / 6) * Math.PI) * 0.8, -18.5);
      l.userData.phase = i * 0.7;
      s.add(l);
      this.lanterns.push(l);
    }
  }

  /** Groves of swaying bamboo round the valley, and two twisted pines. */
  private buildBamboo() {
    const s = this.scene;
    const stalks: Stalk[] = [];
    // flanking the far end, and along the sides behind the stands
    grove(stalks, -17.5, -14, 3.8, 5, 26, 1);
    grove(stalks, 18, -16, 3.8, 5, 26, 2);
    grove(stalks, -22, 4, 3.4, 6, 16, 3);
    grove(stalks, 22, 2, 3.4, 6, 16, 4);
    grove(stalks, -10, -31, 6, 3, 18, 5);
    grove(stalks, 11, -33, 6, 3, 18, 6);
    // a darker wood behind them: the backdrop of every far-end view
    grove(stalks, -30, -37, 11, 6, 34, 7, [0.9, 1.35]);
    grove(stalks, 31, -39, 11, 6, 34, 8, [0.9, 1.35]);
    grove(stalks, -30, -9, 5, 11, 22, 9, [0.85, 1.3]);
    grove(stalks, 30, -11, 5, 11, 22, 10, [0.85, 1.3]);
    this.bamboo = new Bamboo(this.wind, stalks, { culm: new THREE.Color('#78806a'), node: new THREE.Color('#2c2e28'), leaf: new THREE.Color('#1c1f18') });
    s.add(this.bamboo.mesh);

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

  /**
   * Behind the near end (what the far views, the reverse shots and the bowler's
   * reaction look back at): a pond with a vermilion arched bridge.
   */
  private buildPond() {
    const s = this.scene;
    // the water is left almost bare, as a painter would: a bank, a few ripples
    const pond = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshLambertMaterial({ color: '#ded6c3' }));
    pond.rotation.x = -Math.PI / 2;
    pond.scale.set(17, 8.5, 1);
    pond.position.set(0, 0.004, 40);
    s.add(pond);
    const bank = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.03, 64), new THREE.MeshBasicMaterial({ color: '#4a443a' }));
    bank.rotation.x = -Math.PI / 2;
    bank.scale.set(17, 8.5, 1);
    bank.position.set(0, 0.008, 40);
    s.add(bank);
    // horizontal strokes of calm water
    const strokeMat = new THREE.MeshBasicMaterial({ color: '#8a8272' });
    for (const [x, z, w] of [
      [-9, 36, 5],
      [8, 37.5, 4],
      [-3, 42.5, 6],
      [9, 45, 3.5],
      [-10, 44, 3],
    ]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.07).rotateX(-Math.PI / 2), strokeMat);
      m.position.set(x, 0.012, z);
      s.add(m);
    }
    // ripples: a few rings of ink on the still water
    const ringMat = new THREE.MeshBasicMaterial({ color: '#6f6656' });
    for (const [x, z, r] of [
      [-7, 38, 1.2],
      [6.5, 43, 0.9],
      [-2, 45.5, 0.7],
    ]) {
      for (let k = 0; k < 3; k++) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r + k * 0.7, r + k * 0.7 + 0.06, 40), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.scale.set(1.6, 1, 1);
        ring.position.set(x, 0.012, z);
        s.add(ring);
      }
    }
    // the taikobashi: a steep drum bridge across the pond's waist
    const red = new THREE.MeshLambertMaterial({ color: RED, emissive: new THREE.Color('#300a06') });
    const black = new THREE.MeshLambertMaterial({ color: '#1f1b17' });
    const span = 12,
      rise = 3.2,
      halfW = 1.3;
    const arc = (t: number) => new THREE.Vector3((t - 0.5) * span, Math.sin(t * Math.PI) * rise + 0.25, 0);
    // the deck: a strip along the arc
    const pos: number[] = [];
    const idx: number[] = [];
    const n = 32;
    for (let i = 0; i <= n; i++) {
      const p = arc(i / n);
      pos.push(p.x, p.y, -halfW, p.x, p.y, halfW, p.x, p.y - 0.35, -halfW, p.x, p.y - 0.35, halfW);
      if (i < n) {
        const a = i * 4;
        idx.push(a, a + 1, a + 4, a + 1, a + 5, a + 4); // top
        idx.push(a + 2, a + 6, a + 3, a + 3, a + 6, a + 7); // underside
        idx.push(a, a + 4, a + 2, a + 2, a + 4, a + 6); // sides
        idx.push(a + 1, a + 3, a + 5, a + 3, a + 7, a + 5);
      }
    }
    const deckGeo = new THREE.BufferGeometry();
    deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    deckGeo.setIndex(idx);
    deckGeo.computeVertexNormals();
    const bridge = new THREE.Group();
    bridge.add(new THREE.Mesh(deckGeo, black));
    // railings: posts with black caps, and a red rail along the top
    const post = new THREE.CylinderGeometry(0.09, 0.09, 1.1, 6);
    const cap = new THREE.SphereGeometry(0.13, 8, 6);
    for (const z of [-halfW, halfW]) {
      const rail: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const p = arc(0.04 + (i / 8) * 0.92);
        const m = new THREE.Mesh(post, red);
        m.position.set(p.x, p.y + 0.55, z);
        const c = new THREE.Mesh(cap, black);
        c.position.set(p.x, p.y + 1.15, z);
        bridge.add(m, c);
        rail.push(new THREE.Vector3(p.x, p.y + 0.95, z));
      }
      bridge.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rail), 40, 0.07, 6), red));
    }
    // two red piers under the arch
    for (const t of [0.3, 0.7]) {
      const p = arc(t);
      for (const z of [-halfW * 0.8, halfW * 0.8]) {
        const pier = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, p.y, 8), red);
        pier.position.set(p.x, p.y / 2, z);
        bridge.add(pier);
      }
    }
    bridge.position.set(0, 0, 40);
    bridge.rotation.y = 0.18;
    s.add(bridge);
    // weeping willows on the banks, their strands swinging in the breeze
    this.willows = new Willows(
      this.wind,
      [
        { x: -19, z: 36, s: 1.25, yaw: 0.4 },
        { x: 18.5, z: 42, s: 1.1, yaw: 2.1 },
        { x: -12, z: 51, s: 0.95, yaw: 4 },
        { x: 11, z: 29, s: 0.85, yaw: 5.2 },
      ],
      { bark: new THREE.Color('#2e2a24'), leaf: new THREE.Color('#4d5445') },
    );
    s.add(this.willows.mesh);
    // reeds at the water's edge: thin dark strokes
    const reed = new THREE.MeshLambertMaterial({ color: '#2c2e28' });
    const reedGeo = new THREE.ConeGeometry(0.04, 1.8, 3).translate(0, 0.9, 0);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const m = new THREE.Mesh(reedGeo, reed);
      m.position.set(Math.cos(a) * 17 * (0.92 + Math.random() * 0.1), 0, 40 + Math.sin(a) * 8.5 * (0.92 + Math.random() * 0.1));
      m.rotation.set((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4);
      m.scale.y = 0.6 + Math.random() * 0.8;
      s.add(m);
    }
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

  /**
   * Nobori behind the side stands: tall banners of brushed calligraphy, each
   * with its red seal, flying from their poles (one instanced cloth; the eight
   * designs share an atlas).
   */
  private buildBanners() {
    const s = this.scene;
    const words = ['一球', '風雲', '無心', '勝負', '墨龍', '花鳥', '明鏡', '一心'];
    const W = 128,
      H = 384;
    const atlas = canvasTex(W * words.length, H, (x) => {
      words.forEach((wd, i) => {
        const ox = i * W;
        x.fillStyle = '#f3ecdc';
        x.fillRect(ox, 0, W, H);
        // a black band at the head, a thin line down the hoist
        x.fillStyle = '#16130f';
        x.fillRect(ox, 0, W, 22);
        x.fillRect(ox, 0, 5, H);
        // the words, brushed: soft-edged ink, written top to bottom
        x.font = `700 100px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif`;
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.shadowColor = 'rgba(20,16,12,0.7)';
        x.shadowBlur = 3;
        [...wd].forEach((ch, k) => x.fillText(ch, ox + W / 2 + 2, 92 + k * 118));
        x.shadowBlur = 0;
        // flying white: the dry brush leaves streaks of paper in the strokes
        x.globalCompositeOperation = 'destination-out';
        for (let k = 0; k < 40; k++) {
          x.strokeStyle = `rgba(0,0,0,${0.25 + Math.random() * 0.4})`;
          x.lineWidth = 0.6 + Math.random() * 1.4;
          const y = 30 + Math.random() * 280;
          x.beginPath();
          x.moveTo(ox + 12, y);
          x.lineTo(ox + W - 10, y + (Math.random() - 0.3) * 30);
          x.stroke();
        }
        x.globalCompositeOperation = 'destination-over';
        x.fillStyle = '#f3ecdc';
        x.fillRect(ox, 0, W, H);
        x.globalCompositeOperation = 'source-over';
        // the seal
        x.fillStyle = '#c92a1a';
        x.fillRect(ox + W / 2 - 17, H - 62, 34, 34);
        x.fillStyle = '#f3ecdc';
        x.fillRect(ox + W / 2 - 11, H - 56, 9, 22);
        x.fillRect(ox + W / 2 + 2, H - 56, 9, 9);
      });
    });
    const n = words.length;
    // held by the pole down one side and a rod across the top: the free corner flies most
    const clothOpts = { amp: 0.2, height: 0.5, flutter: 0.04 };
    const mat = sway(new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide }), this.wind, 'cloth', clothOpts, {
      key: `nobori${n}`,
      patch: (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCell;').replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv.x = (vMapUv.x + aCell) / ${n.toFixed(1)};`);
      },
    });
    const geo = new THREE.PlaneGeometry(1.1, 3.3, 4, 12).translate(0.55 + 0.07, 0, 0);
    const spots: [number, number][] = [];
    for (const sx of [-1, 1]) for (const z of [-9.5, -3.2, 3.2, 9.5]) spots.push([sx * 15.6, z]);
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(spots.map((_, i) => i % n)), 1));
    const cloth = new THREE.InstancedMesh(geo, mat, spots.length);
    const pole = new THREE.MeshLambertMaterial({ color: '#2a2520' });
    const M = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    spots.forEach(([x, z], i) => {
      // the cloth faces the court (on the left it runs from its pole towards the far end, on the right away)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), x < 0 ? Math.PI / 2 : -Math.PI / 2);
      cloth.setMatrixAt(i, M.compose(new THREE.Vector3(x, 5.05, z), q, new THREE.Vector3(1, 1, 1)));
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 7, 6), pole);
      p.position.set(x, 3.5, z);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 4).rotateX(Math.PI / 2), pole);
      rod.position.set(x, 6.72, z + (x < 0 ? -0.62 : 0.62));
      s.add(p, rod);
    });
    cloth.computeBoundingSphere();
    cloth.boundingSphere!.radius += 1;
    cloth.userData.noBatch = true;
    s.add(cloth);
  }

  protected onResize(W: number, H: number) {
    this.ink.u.uRes.value.set(W, H);
  }

  protected onDetail(d: number) {
    this.bamboo.setDetail(d);
    this.clouds.setDetail(d);
    this.cranes.setDetail(d);
  }

  /** Depth of field, the ink way: out of focus the lines thin and the washes pale. */
  setDof(d: DofState | null) {
    this.dof = d;
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    this.wind.tick(t);
    this.mountains.tick(t);
    this.clouds.tick(t);
    this.splats.tick(t);
    for (const l of this.lanterns) l.rotation.z = Math.sin(t * 1.4 + l.userData.phase) * 0.08;
    // which way the ball is going (a splat's droplets fly on that way)
    const dx = v.ball.x - this.ballPrev.x,
      dz = v.ball.z - this.ballPrev.z;
    if (dx * dx + dz * dz > 1e-6) this.ballDir = Math.atan2(dz, dx);
    this.ballPrev.set(v.ball.x, v.ball.y, v.ball.z);
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
      // a splat of ink that bleeds into the paper, then dries and fades
      this.splats.add(e.pos.x, e.pos.z, 0.34 + Math.min(0.3, e.impact * 0.02), this.ballDir, e.out);
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
    const u = this.ink.u;
    u.tScene.value = this.sceneRT.texture;
    u.tDepth.value = this.sceneRT.depthTexture;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uTime.value = this.time;
    u.uFlash.value = this.flash * 0.6;
    u.uDof.value.set(this.dof?.focus ?? 10, this.dof ? (this.dof.aperture ?? 1) : 0);
    this.ink.render(r, target);
    r.setClearColor(0x000000, 1);
  }

  dispose() {
    super.dispose();
    this.ink.dispose();
    this.paper.dispose();
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
