// NEON DRIVE — a synthwave night: a striped sun sinking behind wireframe
// mountains, an elevated highway streaming with light, flying cars, a city of
// lit windows, and an endless grid on black glass that mirrors all of it.
// Players are outlined in light, and everything pulses to the beat.
//
// The glass is a real reflection, kept cheap (neon-env/floor.ts): the scene
// mirrored in the floor at a fraction of the resolution, only what glows
// (the REFLECT layer). The effects tier sets its resolution; the lowest tier
// drops it for a painted-on sun streak.

import * as THREE from 'three';
import { FIRE_STYLE } from '../render/smashfx';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { stringsMat } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import { outlineTree } from '../render/outline';
import type { MatchEvent } from '../tennis/match';
import { neonSky, neonSun } from './neon-env/sky';
import { Reflection, REFLECT, gridFloor, glassy } from './neon-env/floor';
import { mountains, city, highway, Traffic } from './neon-env/skyline';

const PINK = new THREE.Color('#ff2fb4');
const CYAN = new THREE.Color('#22e6ff');
const PURPLE = new THREE.Color('#8b3bff');
const YELLOW = new THREE.Color('#ffd23f');
const hdr = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);
/** show this object (and everything under it) in the floor's reflection */
const reflected = (o: THREE.Object3D) => o.traverse((c) => c.layers.enable(REFLECT));

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

  /** one clock and one beat for every shader */
  private u = { uTime: { value: 0 }, uBeat: { value: 0 } };
  private reflection = new Reflection();
  private traffic!: Traffic;
  private sticks!: THREE.InstancedMesh;
  private stickU = { uTime: this.u.uTime, uEx: { value: 0.3 } };
  private lineMat!: THREE.MeshBasicMaterial;
  private stripMats: THREE.MeshBasicMaterial[] = [];
  private railMat!: THREE.MeshBasicMaterial;

  protected build() {
    // a smash in neon: a pink-and-gold comet, a ring of light racing over the grid
    this.smashStyle = { ...FIRE_STYLE, fire: [hdr(PINK, 3), hdr(YELLOW, 3), hdr(new THREE.Color('#ff7a1a'), 3)], fireShape: 'soft', sparks: [hdr(CYAN, 3), hdr(PINK, 3), hdr(YELLOW, 3)], sparkShape: 'soft', ring: hdr(CYAN, 1.4), additive: true, hot: hdr(PINK, 2), scorch: new THREE.Color('#050010'), scorchAlpha: 0.7, dust: [hdr(PURPLE, 1.4)], dustShape: 'soft', flash: new THREE.Color('#ffb8ec') };
    const s = this.scene;
    s.fog = new THREE.Fog('#12031f', 60, 420);
    s.add(new THREE.HemisphereLight('#6a3cff', '#1a0630', 1.2));
    const key = new THREE.DirectionalLight('#ff4fd8', 1.2);
    key.position.set(0, 10, -30);
    s.add(key);

    this.buildHorizon();
    s.add(gridFloor(this.u, this.reflection));

    this.lineMat = new THREE.MeshBasicMaterial({ color: hdr(CYAN, 2.4) });
    // the court is glass too, but satin: a sheen of the lights, calm enough to read the ball on
    this.buildCourt({
      inner: glassy(new THREE.MeshLambertMaterial({ color: '#150a33', emissive: new THREE.Color('#0a0420') }), this.reflection, 0.22),
      outer: glassy(new THREE.MeshLambertMaterial({ color: '#08041a' }), this.reflection, 0.3),
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
    this.bloomIsLook = true;
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
    // depth of field for replays and cinematics: neon blurs into bokeh
    this.effects = { dof: true };
  }

  /** Sky, sun, mountains, the city, the highway and its traffic: everything on the horizon. */
  private buildHorizon() {
    const s = this.scene;
    const sky = neonSky(this.u);
    // sinking between the mountains behind the far end: from the players' end its
    // striped foot sits on the horizon, over the highway's lights
    const sun = neonSun(this.u, new THREE.Vector3(0, 26, -380), 80);
    const mtn = mountains(this.u, [
      { x: -150, z: -215, w: 230, d: 110, h: 58, seed: 1 },
      { x: 165, z: -225, w: 250, d: 120, h: 64, seed: 2 },
      { x: -96, z: -86, w: 92, d: 60, h: 23, seed: 3 },
      { x: 102, z: -94, w: 104, d: 60, h: 27, seed: 4 },
      // round the sides and behind the near end, for the side and reverse views
      { x: -270, z: 10, w: 130, d: 300, h: 50, seed: 8 },
      { x: 275, z: -5, w: 130, d: 300, h: 55, seed: 9 },
      { x: -140, z: 245, w: 250, d: 110, h: 52, seed: 5 },
      { x: 150, z: 250, w: 250, d: 110, h: 60, seed: 6 },
    ]);
    const towers = city(this.u, [
      // flanking the sun, clear of it
      { from: -0.8, to: 0.8, radius: [255, 300], count: 46, gap: [-0.24, 0.24], seed: 3 },
      // the downtown behind the near end
      { from: Math.PI - 0.85, to: Math.PI + 0.85, radius: [165, 215], count: 40, seed: 7 },
    ]);
    this.railMat = new THREE.MeshBasicMaterial({ color: hdr(CYAN, 2.2) });
    const road = highway({ deckY: 5, z: -120, length: 1000, rail: this.railMat, dark: new THREE.MeshBasicMaterial({ color: '#07020f' }) });
    this.traffic = new Traffic(this.u, { deckY: 5, z: -120, run: 900, cars: 36, flyers: 12, seed: 4 });
    sky.name = 'neon.sky';
    sun.name = 'neon.sun';
    mtn.name = 'neon.mountains';
    towers.name = 'neon.city';
    this.traffic.mesh.name = 'neon.traffic';
    for (const o of [sky, sun, mtn, towers, ...road, this.traffic.mesh]) {
      reflected(o);
      s.add(o);
    }
  }

  private buildStands() {
    const s = this.scene;
    const dark = new THREE.MeshLambertMaterial({ color: '#0d0620' });
    const stands: Stand[] = [];
    this.stripMats = [hdr(PINK, 2.2), hdr(CYAN, 2.2)].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number, ei: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.55 + r * 0.55;
        const step = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), dark);
        step.position.set(0, hgt / 2, r * 0.9 + 0.45);
        // (dark in the glass too: the stand hides what's behind it, and its crowd's lights hang over black)
        reflected(step);
        g.add(step);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, 0.05), this.stripMats[(r + ei) % 2]);
        strip.position.set(0, hgt, r * 0.9 + 0.02);
        reflected(strip);
        g.add(strip);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      s.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    // (four rows: the courtside attract shot looks over the back row's heads, not through the stand)
    mk(-10.5, 0, -Math.PI / 2, 22, 4, 0);
    mk(10.5, 0, Math.PI / 2, 22, 4, 1);
    // (low behind the far end: from the players' end the horizon shows over it)
    mk(0, -19.5, Math.PI, 16, 3, 0);
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
    // glowing heads show in the glass (not the dark bodies)
    crowd.heads.layers.enable(REFLECT);
    // light sticks held up by some of the crowd, waved in the vertex shader
    const n = Math.floor(crowd.bodies.count * 0.35);
    const stickMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    stickMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.stickU.uTime;
      sh.uniforms.uEx = this.stickU.uEx;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uEx;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float fid = float(gl_InstanceID);
          float a = sin(uTime * (3.0 + mod(fid, 5.0) * 0.4) + fid) * 0.7 * uEx;
          transformed.xy = mat2(cos(a), sin(a), -sin(a), cos(a)) * transformed.xy;
        }`,
      );
    };
    stickMat.customProgramCacheKey = () => 'neon-stick';
    this.sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 5), stickMat, n);
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4().makeTranslation(0.25, 1.35, 0);
    for (let i = 0; i < n; i++) {
      const src = Math.floor(Math.random() * crowd.bodies.count);
      crowd.bodies.getMatrixAt(src, m);
      this.sticks.setMatrixAt(i, m.multiply(tmp));
      this.sticks.setColorAt(i, hdr([PINK, CYAN, YELLOW][i % 3], 3));
    }
    this.sticks.frustumCulled = false;
    this.sticks.userData.noBatch = true;
    reflected(this.sticks);
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
      reflected(g);
      this.scene.add(g);
    };
    palm(-16, -18, 11, 1.4);
    palm(17, -20, 12, -1.6);
    palm(-22, -6, 10, 1);
    palm(23, -2, 9.5, -1);
    palm(-15, 12, 10.5, 1.2);
    palm(16, 13, 11, -1.1);
    // a row either side of the backdrop, black against the sunset
    palm(-30, -38, 13, 1.2);
    palm(33, -42, 14, -1.3);
    palm(-44, -55, 15, 1.5);
    palm(47, -58, 13.5, -1);
  }

  init() {
    super.init();
    // the reflection's stand-ins: the scenery once it's batched, and the ball, its
    // trail and the sparks following along in world space
    this.reflection.collect(this.env, [this.ball, this.trail.mesh, this.particles.mesh], this.scene.fog as THREE.Fog);
  }

  protected onResize(W: number, H: number) {
    this.reflection.setSize(W, H);
  }

  /** The effects tier also sets the reflection (its resolution, or none at the lowest). */
  setFxTier(t: number) {
    super.setFxTier(t);
    this.reflection.setTier(t);
  }

  protected onDetail(d: number) {
    this.traffic.setDetail(d);
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    const b = v.beat;
    this.u.uTime.value = t;
    this.u.uBeat.value = b;
    this.lineMat.color.copy(CYAN).multiplyScalar(2.2 + b * 1.2);
    this.stripMats[0].color.copy(PINK).multiplyScalar(2 + b * 1.6);
    this.stripMats[1].color.copy(CYAN).multiplyScalar(2 + b * 1.6);
    this.railMat.color.copy(CYAN).multiplyScalar(1.8 + b * 1.4);
    this.stickU.uEx.value = 0.3 + v.excitement;
    // the beat hits the lens: bloom swells and the colours split
    const f = this.final.u;
    f.uBloom.value = 0.78 + b * 0.24;
    f.uAberration.value = 0.003 + b * b * 0.005;
  }

  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    this.reflection.render(this.renderer, cam);
    super.render(cam, target);
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

  dispose() {
    super.dispose();
    this.reflection.dispose();
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
    panel: 'linear-gradient(160deg, rgba(255,245,255,0.97), rgba(236,228,255,0.94))',
  },
  song: 'neon',
  surface: 1.03,
  make: (r) => new NeonWorld(NEON, r),
};
