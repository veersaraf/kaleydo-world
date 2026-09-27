// World base: everything every art style shares — court, net, ball, trail,
// particles, characters — plus a default render pipeline. Each world
// subclasses this and swaps materials, scenery, lighting and post-processing.

import * as THREE from 'three';
import { COURT, netHeightAt } from '../tennis/court';
import type { MatchEvent, MatchState } from '../tennis/match';
import type { Pose } from '../chars/pose';
import type { Look } from '../chars/look';
import { Rig, blobShadowTexture } from '../chars/rig';
import type { MaterialKit } from './types';
import { Trail, type TrailStyle } from '../render/trail';
import { Particles } from '../render/particles';
import { Crowd } from './crowd';
import { batchStatic, type BatchStats } from '../render/batch';
import type { BowlView } from '../bowling/types';
import type { DuelView } from '../duel/types';
import type { RangeView } from '../archery/types';

export type Sport = 'tennis' | 'bowling' | 'duel' | 'archery';

/** What a world needs from the bowling venue (lanes, pins, ball) — see bowling/venue.ts. */
export interface BowlVenueLike {
  group: THREE.Group;
  update(v: BowlView, realDt: number): void;
  holdBall(p: THREE.Vector3 | null): void;
  setAim(aim: { x: number; angle: number } | null): void;
  dispose(): void;
}

/** What a world needs from the sword-duel arena (platform, water, effects) — see duel/venue.ts. */
export interface DuelVenueLike {
  group: THREE.Group;
  update(v: DuelView, realDt: number): void;
  dispose(): void;
}

/** What a world needs from the archery range (targets, arrows, wind flags) — see archery/venue.ts. */
export interface RangeVenueLike {
  group: THREE.Group;
  update(v: RangeView, realDt: number): void;
  dispose(): void;
}

/** trail colours per kind of shot (topspin red, slice blue, lob yellow…) */
const SHOT_TINT: Record<string, THREE.Color> = {
  topspin: new THREE.Color('#ff5a3c'),
  slice: new THREE.Color('#3aa8ff'),
  flat: new THREE.Color('#ffffff'),
  lob: new THREE.Color('#ffd23c'),
  drop: new THREE.Color('#dff4ff'),
  smash: new THREE.Color('#ffb400'),
  serve: new THREE.Color('#ffffff'),
  rocket: new THREE.Color('#ff7a1a'),
};

/** ?nobatch in the URL turns static batching off (for A/B checks) */
const NO_BATCH = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nobatch');
import { makeRT, finalPass, Pass, Bloom, BLACK } from '../render/post';
import type { V3 } from '../core/math';

export interface WorldUI {
  accent: string;
  accent2: string;
  ink: string;
  paper: string;
  font: string;
  display: string;
  /** css background for menus in this world */
  panel: string;
}

export interface WorldDef {
  id: string;
  name: string;
  tagline: string;
  blurb: string;
  ui: WorldUI;
  song: string;
  /** bounce speed factor for the surface (1 = hard court) */
  surface: number;
  /** gravity multiplier (low-gravity worlds) */
  gravity?: number;
  make(r: THREE.WebGLRenderer): World;
}

export interface FrameView {
  t: number;
  dt: number;
  realT: number;
  realDt: number;
  ball: V3;
  ballSpeed: number;
  ballVisible: boolean;
  /** index of the player holding the ball, or -1 */
  holder: number;
  poses: Pose[];
  excitement: number;
  state: MatchState;
  cam: THREE.PerspectiveCamera;
  /** 1 on each musical beat, decaying to 0 */
  beat: number;
  /** bowling: the ball and pins to draw */
  bowl?: BowlView;
  /** sword duel: the arena's state and effects */
  duel?: DuelView;
  /** archery: targets, arrows, wind */
  range?: RangeView;
}

export interface CourtStyle {
  inner: THREE.Material;
  outer: THREE.Material;
  line: THREE.Material;
  /** how far the inner colour extends past the doubles lines */
  innerPad: { x: number; z: number };
  outerSize: { x: number; z: number };
  lineWidth: number;
  /** hand-drawn wobble, metres */
  wobble?: number;
  receiveShadow?: boolean;
}

export interface NetStyle {
  post: THREE.Material;
  mesh: THREE.Material;
  band: THREE.Material;
}

export abstract class World {
  scene = new THREE.Scene();
  rigs: Rig[] = [];
  ball!: THREE.Mesh;
  ballShadow!: THREE.Mesh;
  /** a ring in the hitting team's colour around the ball (Switch Sports-style), so it's easy to follow */
  ballHalo!: THREE.Mesh;
  /** team colours for the halo (the flow sets the players' colours) */
  teamColors: [THREE.Color, THREE.Color] = [new THREE.Color('#3aa8ff'), new THREE.Color('#ff5a8c')];
  /** how strongly this world shows the halo (quiet styles turn it down) */
  protected haloStrength = 1;
  private haloOn = 0;
  trail!: Trail;
  particles!: Particles;
  crowd: Crowd | null = null;
  /** All the scenery: everything except players, ball and effects. For the far
   *  player's half of a split screen it is turned 180°, so they see the backdrop
   *  the world was designed around behind their opponent — and nothing that was
   *  built as far-end background ends up right in front of their camera. */
  env = new THREE.Group();
  netMesh!: THREE.Mesh;
  courtGroup: THREE.Group | null = null;
  netGroup: THREE.Group | null = null;
  /** scenery that only belongs to tennis (an umpire's chair, "TENNIS" painted on
   *  the ground): hidden for other sports — mark it noBatch so it can be */
  protected tennisOnly: THREE.Object3D[] = [];
  /** which sport this world is set up for */
  sport: Sport = 'tennis';
  /** the bowling lanes, pins and ball / the duel arena — each built the first time
   *  its sport comes to this world, with the world's own materials */
  bowlVenue: BowlVenueLike | null = null;
  duelVenue: DuelVenueLike | null = null;
  rangeVenue: RangeVenueLike | null = null;
  netWob = 0;
  netWobX = 0;
  w = 1;
  h = 1;
  pixelRatio = 1;
  abstract kit: MaterialKit;
  protected sceneRT!: THREE.WebGLRenderTarget;
  protected final: Pass = finalPass();
  protected bloom: Bloom | null = null;
  protected time = 0;
  private ballSpinAxis = new THREE.Vector3(1, 0, 0);
  private tmp = new THREE.Vector3();
  private lastBall = new THREE.Vector3();
  flash = 0;
  flashColor = new THREE.Color(1, 1, 1);
  batchStats: BatchStats | null = null;
  shake = 0;

  constructor(
    public def: WorldDef,
    public renderer: THREE.WebGLRenderer,
  ) {}

  /** Called once after construction by the registry. */
  init() {
    this.build();
    const keep = new Set<THREE.Object3D>([this.ball, this.ballShadow, this.ballHalo]);
    for (const o of [...this.scene.children]) if (!keep.has(o)) this.env.add(o);
    this.scene.add(this.env);
    // the net cloth ripples where the ball hit it: keep that in world space
    if (this.netMesh) this.scene.attach(this.netMesh);
    this.scene.add(this.particles.mesh);
    this.scene.add(this.trail.mesh);
    // bake everything that never moves into a few big meshes (thousands of draw calls → dozens)
    const probeCam = new THREE.PerspectiveCamera();
    if (!NO_BATCH) this.batchStats = batchStatic(this.env, () => {
      for (const [t, bx] of [
        [1.37, -2],
        [4.21, 3],
        [9.73, 0.5],
      ])
        this.animate({ t, dt: 0.1, realT: t, realDt: 0.1, ball: { x: bx, y: 1.2, z: bx * 2 }, ballSpeed: 10, ballVisible: true, holder: -1, poses: [], excitement: 0.6, state: 'play', cam: probeCam, beat: 0.7 });
    });
    this.sceneRT = makeRT(1, 1, { depth: true, samples: this.samples() });
  }

  protected samples() {
    return 4;
  }

  /** Subclasses build scenery here (and must set up ball/trail/particles via helpers). */
  protected abstract build(): void;

  // ---------------------------------------------------------------- builders

  protected buildCourt(s: CourtStyle) {
    const g = new THREE.Group();
    const hw = COURT.doublesHalfW;
    const hl = COURT.halfL;
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(s.outerSize.x * 2, s.outerSize.z * 2), s.outer);
    outer.rotation.x = -Math.PI / 2;
    outer.receiveShadow = !!s.receiveShadow;
    g.add(outer);
    const inner = new THREE.Mesh(new THREE.PlaneGeometry((hw + s.innerPad.x) * 2, (hl + s.innerPad.z) * 2), s.inner);
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.002;
    inner.receiveShadow = !!s.receiveShadow;
    g.add(inner);

    const lw = s.lineWidth;
    const sw = COURT.singlesHalfW;
    const sv = COURT.service;
    const lines: [number, number, number, number][] = [
      // x0, z0, x1, z1
      [-hw, -hl, hw, -hl],
      [-hw, hl, hw, hl],
      [-hw, -hl, -hw, hl],
      [hw, -hl, hw, hl],
      [-sw, -hl, -sw, hl],
      [sw, -hl, sw, hl],
      [-sw, -sv, sw, -sv],
      [-sw, sv, sw, sv],
      [0, -sv, 0, sv],
      [0, -hl, 0, -hl + 0.12],
      [0, hl - 0.12, 0, hl],
    ];
    const wob = s.wobble ?? 0;
    for (const [x0, z0, x1, z1] of lines) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const segs = wob > 0 ? Math.max(2, Math.round(len * 1.5)) : 1;
      const geo = new THREE.PlaneGeometry(1, 1, segs, 1);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const horiz = Math.abs(z1 - z0) < 1e-3;
      const w = horiz && Math.abs(z0) > hl - 0.01 ? lw * 1.6 : lw;
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) + 0.5; // along
        const v = pos.getY(i); // across (-0.5..0.5)
        const wx = wob ? Math.sin(u * len * 2.1 + x0 * 3 + z0) * wob + Math.sin(u * len * 5.3 + z1) * wob * 0.4 : 0;
        const ax = x0 + (x1 - x0) * u;
        const az = z0 + (z1 - z0) * u;
        const nx = (z1 - z0) / len,
          nz = -(x1 - x0) / len;
        const ww = w * (1 + (wob ? Math.sin(u * len * 3.7 + x1) * 0.25 : 0));
        pos.setXYZ(i, ax + nx * (v * ww + wx), 0, az + nz * (v * ww + wx));
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, s.line);
      m.position.y = 0.006;
      m.receiveShadow = !!s.receiveShadow;
      g.add(m);
    }
    // kept apart from the static batch so bowling can hide it
    g.userData.noBatch = true;
    this.courtGroup = g;
    this.scene.add(g);
    return g;
  }

  protected buildNet(s: NetStyle) {
    const g = new THREE.Group();
    const px = COURT.netPostX;
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, COURT.netPostH + 0.05, 14), s.post);
      post.position.set(sx * px, (COURT.netPostH + 0.05) / 2, 0);
      post.castShadow = true;
      g.add(post);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), s.post);
      cap.position.set(sx * px, COURT.netPostH + 0.05, 0);
      g.add(cap);
    }
    const segX = 64,
      segY = 6;
    const geo = new THREE.PlaneGeometry(px * 2, 1, segX, segY);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const v = pos.getY(i) + 0.5;
      pos.setXYZ(i, x, v * netHeightAt(x), 0);
    }
    geo.userData.base = Float32Array.from(pos.array as Float32Array);
    this.netMesh = new THREE.Mesh(geo, s.mesh);
    this.netMesh.renderOrder = 2;
    g.add(this.netMesh);
    // top band
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i++) {
      const x = -px + (i / 32) * px * 2;
      pts.push(new THREE.Vector3(x, netHeightAt(x) + 0.01, 0));
    }
    const band = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.03, 6), s.band);
    band.userData.net = true;
    g.add(band);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, COURT.netH, 0.01), s.band);
    strap.position.set(0, COURT.netH / 2, 0.005);
    g.add(strap);
    // kept apart from the static batch so bowling can hide it
    g.userData.noBatch = true;
    this.netGroup = g;
    this.scene.add(g);
    return g;
  }

  protected netTexture(color = '#ffffff', bg = 'rgba(0,0,0,0)') {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const x = c.getContext('2d')!;
    x.fillStyle = bg;
    x.fillRect(0, 0, 64, 64);
    x.strokeStyle = color;
    x.lineWidth = 3;
    x.beginPath();
    x.moveTo(0, 2);
    x.lineTo(64, 2);
    x.moveTo(2, 0);
    x.lineTo(2, 64);
    x.stroke();
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(COURT.netPostX * 2 * 12, COURT.netH * 12);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  protected buildBall(mat: THREE.Material, trail: TrailStyle, shadowColor = new THREE.Color(0, 0, 0), shadowOpacity = 0.55) {
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(COURT.ballR, 24, 16), mat);
    // one shadow, straight below (the blob): a second, sun-offset one confuses where it lands
    this.ball.castShadow = false;
    this.ball.renderOrder = 3;
    this.scene.add(this.ball);
    const sm = new THREE.MeshBasicMaterial({ map: blobShadowTexture(), color: shadowColor, transparent: true, opacity: shadowOpacity, depthWrite: false });
    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(COURT.ballR * 1.6, 20), sm);
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.renderOrder = 1;
    this.scene.add(this.ballShadow);
    this.ballHalo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color('#ffffff') }, uOpacity: { value: 0 } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
          void main() {
            float r = length(vUv * 2.0 - 1.0);
            // a thin white ring hugging the ball (reads on any coloured court), then
            // the hitting team's colour glowing around it (reads on pale worlds)
            float white = smoothstep(0.36, 0.42, r) * (1.0 - smoothstep(0.47, 0.53, r));
            float team = smoothstep(0.44, 0.52, r) * (1.0 - smoothstep(0.62, 0.95, r));
            vec3 col = mix(uColor, vec3(1.0), white);
            float a = max(white * 0.95, team * 0.9);
            gl_FragColor = vec4(col, a * uOpacity);
          }`,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.ballHalo.renderOrder = 4;
    this.ballHalo.frustumCulled = false;
    this.scene.add(this.ballHalo);
    this.trail = new Trail(trail);
  }

  protected tennisBallTexture(felt = '#d8f03a', seam = '#ffffff') {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = felt;
    x.fillRect(0, 0, 256, 128);
    // fuzz
    for (let i = 0; i < 1400; i++) {
      x.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
      x.fillRect(Math.random() * 256, Math.random() * 128, 2, 2);
    }
    // seam: the classic tennis-ball curve projected to equirect
    x.strokeStyle = seam;
    x.lineWidth = 6;
    x.lineCap = 'round';
    const a = 0.75,
      b = 0.25,
      cc = 2 * Math.sqrt(a * b);
    let prev: [number, number] | null = null;
    for (let i = 0; i <= 400; i++) {
      const t = (i / 400) * Math.PI * 2;
      const px = a * Math.cos(t) + b * Math.cos(3 * t);
      const py = a * Math.sin(t) - b * Math.sin(3 * t);
      const pz = cc * Math.sin(2 * t);
      const lon = Math.atan2(py, px);
      const lat = Math.asin(Math.max(-1, Math.min(1, pz)));
      const u = ((lon / (Math.PI * 2) + 1) % 1) * 256;
      const v = (0.5 - lat / Math.PI) * 128;
      if (prev && Math.abs(prev[0] - u) < 100) {
        x.beginPath();
        x.moveTo(prev[0], prev[1]);
        x.lineTo(u, v);
        x.stroke();
      }
      prev = [u, v];
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  protected buildParticles(opts: { additive?: boolean; fog?: boolean } = {}) {
    this.particles = new Particles(700, opts);
  }

  protected addCrowd(c: Crowd) {
    this.crowd = c;
    this.scene.add(c.group);
  }

  // ---------------------------------------------------------------- players

  /** identifies the looks the current rigs were built from */
  lookKey = '';

  setPlayers(looks: Look[], key = JSON.stringify(looks)) {
    if (key === this.lookKey) return;
    this.lookKey = key;
    for (const r of this.rigs) {
      this.scene.remove(r.root, r.shadow);
      r.dispose();
    }
    this.rigs = looks.map((l) => {
      const r = new Rig(l, this.kit);
      this.scene.add(r.root, r.shadow);
      return r;
    });
  }

  // ---------------------------------------------------------------- render targets
  //
  // Only the world on screen (plus the incoming one during a transition) needs
  // its full-screen buffers. At ~100 MB each they are released when a world goes
  // off screen and re-created when it comes back.

  private rtList: THREE.WebGLRenderTarget[] | null = null;

  /** Every render target this world owns (found by scanning its fields). */
  private targets(): THREE.WebGLRenderTarget[] {
    if (this.rtList) return this.rtList;
    const out = new Set<THREE.WebGLRenderTarget>();
    const scan = (v: unknown, depth: number) => {
      if (!v || typeof v !== 'object') return;
      if (v instanceof THREE.WebGLRenderTarget) return void out.add(v);
      if (depth > 2 || v instanceof THREE.Object3D || v instanceof THREE.Material || v instanceof THREE.Texture || v instanceof THREE.BufferGeometry || v === this.renderer) return;
      if (Array.isArray(v)) v.forEach((x) => scan(x, depth + 1));
      else for (const k of Object.keys(v)) scan((v as Record<string, unknown>)[k], depth + 1);
    };
    for (const k of Object.keys(this)) if (k !== 'rtList') scan((this as unknown as Record<string, unknown>)[k], 0);
    this.rtList = [...out];
    return this.rtList;
  }

  /** Make sure the buffers match the view (size, pixel ratio, MSAA). */
  fitTargets(w: number, h: number, pr: number, msaa: number) {
    const s = Math.min(msaa, this.samples());
    if (this.sceneRT.samples !== s) {
      this.sceneRT.samples = s;
      this.sceneRT.dispose();
    }
    if (this.w !== w || this.h !== h || this.pixelRatio !== pr) this.resize(w, h, pr);
  }

  /** Free the GPU memory of every buffer; they come back on the next render. */
  releaseTargets() {
    for (const rt of this.targets()) rt.dispose();
  }

  // ---------------------------------------------------------------- per-frame

  update(v: FrameView) {
    this.time = v.realT;
    for (let i = 0; i < this.rigs.length && i < v.poses.length; i++) this.rigs[i].apply(v.poses[i]);
    // ball
    const b = this.ball;
    if (v.holder >= 0 && this.rigs[v.holder]) {
      this.rigs[v.holder].root.updateMatrixWorld(true);
      this.rigs[v.holder].offHandWorld(this.tmp);
      b.position.copy(this.tmp);
      b.position.y += 0.02;
    } else {
      b.position.set(v.ball.x, v.ball.y, v.ball.z);
    }
    b.visible = v.ballVisible;
    // spin: roll around the axis perpendicular to travel
    this.tmp.subVectors(b.position, this.lastBall);
    const d = this.tmp.length();
    if (d > 1e-4 && d < 3) {
      this.ballSpinAxis.set(this.tmp.z, 0, -this.tmp.x).normalize();
      b.rotateOnWorldAxis(this.ballSpinAxis, (d / COURT.ballR) * 0.5);
    }
    this.lastBall.copy(b.position);
    const hgt = Math.max(0, b.position.y - COURT.ballR);
    this.ballShadow.position.set(b.position.x, 0.014, b.position.z);
    // a dark, tight shadow is how you judge where the ball will land: keep it
    // readable even when the ball is high
    const ss = 1 + hgt * 0.16;
    this.ballShadow.scale.set(ss, ss, 1);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.34, 0.8 - hgt * 0.07);
    this.ballShadow.visible = v.ballVisible;
    // halo: on while the ball is in play and moving, in the colour of whoever hit it
    const flying = v.holder < 0 && v.ballSpeed > 2 && (v.state === 'play' || v.state === 'toss');
    this.haloOn += ((flying ? 1 : 0) - this.haloOn) * Math.min(1, v.realDt * (flying ? 14 : 5));
    (this.ballHalo.material as THREE.ShaderMaterial).uniforms.uOpacity.value = this.haloOn * 0.85 * this.haloStrength * this.haloNear;
    this.ballHalo.visible = v.ballVisible && this.haloOn > 0.01;
    this.fitBall(v.cam);
    this.trail.update(b.position, v.holder >= 0 ? 0 : v.ballSpeed, v.cam, v.realDt, v.realT);
    this.trail.mesh.visible = v.ballVisible;
    // tired players drip sweat
    this.sweatT -= v.realDt;
    if (this.sweatT <= 0) {
      this.sweatT = 0.32;
      for (const pose of v.poses) {
        if (pose.tired < 0.3) continue;
        this.particles.burst({ x: pose.x + (Math.random() - 0.5) * 0.3, y: 1.95 + pose.hop, z: pose.z, count: 2 + (pose.tired > 0.7 ? 1 : 0), speed: [0.6, 1.5], dir: [0, 1, 0], spread: 0.8, life: [0.4, 0.65], size: [0.09, 0.14], colors: [this.sweatColor], shape: 'soft', alpha: 0.9, gravity: 7 });
      }
    }
    this.particles.update(v.realDt);
    this.crowd?.update(v.realT, v.realDt, v.excitement);
    if (this.sport === 'bowling' && v.bowl) this.bowlVenue?.update(v.bowl, v.realDt);
    else if (this.sport === 'duel' && v.duel) this.duelVenue?.update(v.duel, v.realDt);
    else if (this.sport === 'archery' && v.range) this.rangeVenue?.update(v.range, v.realDt);
    this.updateNet(v.realDt);
    this.flash = Math.max(0, this.flash - v.realDt * 3.5);
    this.animate(v);
  }

  /** Scenery animation hook. */
  protected animate(_v: FrameView) {}

  /**
   * Turn the court into another sport's set — bowling lanes, a duel arena — or
   * back. Each is built with this world's own materials the first time, so it
   * matches the art style.
   */
  setSport(sport: 'tennis'): void;
  setSport(sport: 'bowling', make?: (kit: MaterialKit) => BowlVenueLike): void;
  setSport(sport: 'duel', make?: (kit: MaterialKit) => DuelVenueLike): void;
  setSport(sport: 'archery', make?: (kit: MaterialKit) => RangeVenueLike): void;
  setSport(sport: Sport, make?: (kit: MaterialKit) => BowlVenueLike | DuelVenueLike | RangeVenueLike) {
    this.sport = sport;
    if (sport === 'bowling' && !this.bowlVenue && make) {
      this.bowlVenue = make(this.kit) as BowlVenueLike;
      this.scene.add(this.bowlVenue.group);
    } else if (sport === 'duel' && !this.duelVenue && make) {
      this.duelVenue = make(this.kit) as DuelVenueLike;
      this.scene.add(this.duelVenue.group);
    } else if (sport === 'archery' && !this.rangeVenue && make) {
      this.rangeVenue = make(this.kit) as RangeVenueLike;
      this.scene.add(this.rangeVenue.group);
    }
    if (this.bowlVenue) this.bowlVenue.group.visible = sport === 'bowling';
    if (this.duelVenue) this.duelVenue.group.visible = sport === 'duel';
    if (this.rangeVenue) this.rangeVenue.group.visible = sport === 'archery';
    const tennis = sport === 'tennis';
    if (this.courtGroup) this.courtGroup.visible = tennis;
    if (this.netGroup) this.netGroup.visible = tennis;
    if (this.netMesh) this.netMesh.visible = tennis;
    for (const o of this.tennisOnly) o.visible = tennis;
  }

  /** Which view is about to render: 0 = the normal one, 1 = the far player's split-screen half. */
  setView(i: number, cam?: THREE.PerspectiveCamera) {
    const r = i === 1 ? Math.PI : 0;
    if (this.env.rotation.y !== r) this.env.rotation.y = r;
    if (cam) this.fitBall(cam);
  }

  /**
   * Size the ball (and its halo) for this camera: far away it's drawn up to twice
   * its real size so it never shrinks to a speck — the physics don't change.
   */
  private fitBall(cam: THREE.Camera) {
    const b = this.ball;
    const d = b.position.distanceTo(cam.position);
    const s = THREE.MathUtils.clamp(1 + (d - 9) * 0.045, 1, 2.1);
    b.scale.setScalar(s);
    const h = this.ballHalo;
    // just behind the ball (so the ball always draws in front of its own ring), facing the camera
    h.position.copy(b.position).addScaledVector(this.tmp.subVectors(b.position, cam.position).normalize(), COURT.ballR * s);
    h.quaternion.copy(cam.quaternion);
    h.scale.setScalar(COURT.ballR * s * 5);
    // the halo is for reading a far-away ball; close up it just gets in the way
    this.haloNear = THREE.MathUtils.smoothstep(d, 4, 9);
  }
  private haloNear = 1;

  /** Colour the trail by the kind of shot (Mario Tennis-style: read the spin at a glance). */
  private tintTrail(e: Extract<MatchEvent, { type: 'hit' }>) {
    const key =
      e.kind === 'smash' ? 'smash' : e.serve ? (e.rocket ? 'rocket' : 'serve') : e.kind === 'lob' || e.kind === 'wobbly' ? 'lob' : e.kind === 'drop' ? 'drop' : e.shotSpin > 0.25 ? 'topspin' : e.shotSpin < -0.25 ? 'slice' : 'flat';
    this.trail.tint(SHOT_TINT[key]);
    // a rocket serve and a smash burn: the halo goes fiery instead of team-coloured
    (this.ballHalo.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(key === 'rocket' || key === 'smash' ? SHOT_TINT[key] : this.teamColors[e.p.team]);
    if (key === 'rocket') this.flash = Math.max(this.flash, 0.25);
  }

  private updateNet(dt: number) {
    if (this.netWob < 0.001) return;
    this.netWob *= Math.exp(-3.2 * dt);
    const geo = this.netMesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const base = geo.userData.base as Float32Array;
    const t = this.time;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3],
        y = base[i * 3 + 1];
      const fall = Math.exp(-Math.abs(x - this.netWobX) * 0.9);
      const h = y / COURT.netH;
      pos.setZ(i, Math.sin(t * 22 + x * 2) * this.netWob * fall * h * 0.35);
    }
    pos.needsUpdate = true;
  }

  /** colour of the dust a diving player kicks up */
  protected dustColor = new THREE.Color('#e6dccb');
  protected sweatColor = new THREE.Color('#bfe8ff');
  private sweatT = 0;

  onEvent(e: MatchEvent) {
    if (e.type === 'hit') this.tintTrail(e);
    if (e.type === 'land') {
      this.particles.burst({ x: e.pos.x, y: 0.08, z: e.pos.z, count: 14, speed: [0.6, 2.2], dir: [0, 1, 0], spread: 0.95, life: [0.4, 0.9], size: [0.18, 0.4], shrink: 1.8, colors: [this.dustColor], shape: 'soft', alpha: 0.55, drag: 3.5, gravity: -0.4 });
    }
    if (e.type === 'toss') {
      this.trail.tint(null);
      (this.ballHalo.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(this.teamColors[e.p.team]);
    }
    if (e.type === 'net') {
      this.netWob = e.cord ? 0.35 : 1;
      this.netWobX = e.pos.x;
    }
    if (e.type === 'point') this.crowd?.cheerNow(e.rally > 4 ? 1 : 0.7);
    if (e.type === 'hit' && (e.perfect || e.kind === 'smash')) this.flash = e.kind === 'smash' ? 0.35 : 0.2;
    this.fx(e);
  }

  /** Per-world particle effects. */
  protected fx(_e: MatchEvent) {}

  // ---------------------------------------------------------------- rendering

  resize(w: number, h: number, pr: number) {
    this.w = w;
    this.h = h;
    this.pixelRatio = pr;
    const W = Math.floor(w * pr),
      H = Math.floor(h * pr);
    this.sceneRT.setSize(W, H);
    this.bloom?.setSize(W, H);
    this.final.u.uRes.value.set(W, H);
    this.onResize(W, H);
  }

  protected onResize(_W: number, _H: number) {}

  /** Render the world into `target` (null = screen). */
  render(cam: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(this.scene, cam);
    const f = this.final.u;
    f.tScene.value = this.sceneRT.texture;
    f.tBloom.value = this.bloom ? this.bloom.render(r, this.sceneRT.texture) : BLACK;
    f.uTime.value = this.time;
    f.uFlash.value = this.flash;
    f.uFlashColor.value.copy(this.flashColor);
    this.final.render(r, target);
  }

  /** Warm up shaders so the first frame doesn't hitch. */
  compile(cam: THREE.Camera) {
    this.renderer.compile(this.scene, cam);
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.sceneRT.dispose();
    this.bloom?.dispose();
    this.final.dispose();
    this.trail.dispose();
    this.particles.dispose();
  }
}
