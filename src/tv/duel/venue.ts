// The sword-duel arena: a long, narrow pier raised over a hazard (water in
// most worlds — see hazard.ts), where the tennis court stands. Built from the
// world's MaterialKit like the bowling venue, so each art style draws it its
// own way, with its static parts merged into one mesh per material.
//
// Layout (world metres, see arena.ts): the platform runs along z, centred on
// the origin, ARENA.width across and ARENA.length long, its top ARENA.top up.
// Fighter 0 starts on the +z side. The hazard's surface is HAZARD_Y.
//
// The final round is fought on a shorter platform (ARENA.finalLength): its two
// end sections crack off and sink with a splash. So the platform exists twice:
// whole (one mesh per material — the usual case) and split into the middle and
// two ends, which only draw while the ends are going (or gone).
//
// Roles picked from the kit (as in bowling/venue.ts):
//   'hair'   the deck's planks        'racket' the edge trim and end markings
//   'shirt'  posts, beams, borders    (glowing worlds get unlit HDR accents)

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialKit, CharRole } from '../worlds/types';
import { Particles, type Shape } from '../render/particles';
import { outlineTree } from '../render/outline';
import { canvasTex } from '../worlds/mats';
import { Rng } from '../core/math';
import { ARENA, HAZARD_Y } from './arena';
import type { DuelView, DuelFx } from './types';
import { Hazard, HZ, hazardKind, MAX_POSTS } from './hazard';

const TOP = ARENA.top;
const HW = ARENA.width / 2;
const FULL = ARENA.length / 2;
const SHORT = ARENA.finalLength / 2;
/** the deck slab's thickness, and the edge lip's height above the deck */
const SLAB = 0.2;
const LIP = 0.035;
/** the end markings' depth from the edge */
const BAND = 0.36;
/** posts: across, and along (each side) — the ones past SHORT belong to the ends */
const POST_X = HW - 0.2;
const POST_Z = [0, 1.3, SHORT - 0.15, FULL - 0.25];

interface Pal {
  deck: string;
  trim: string;
  mark: string;
  mark2: string;
  post: string;
  rim: string;
}

const PAL: Record<string, Pal> = {
  park: { deck: '#e7b27a', trim: '#ffffff', mark: '#ff5a5f', mark2: '#ffffff', post: '#76839c', rim: '#ddd6cb' },
  plaza: { deck: '#f2bf7c', trim: '#ffffff', mark: '#ff4f64', mark2: '#ffffff', post: '#2b3a6b', rim: '#f4f1fb' },
  ink: { deck: '#e9dfca', trim: '#2a2520', mark: '#d8321f', mark2: '#f1e8d4', post: '#2a2520', rim: '#8d8578' },
  neon: { deck: '#5a2ea8', trim: '#22e6ff', mark: '#ff2fb4', mark2: '#ffd6f5', post: '#150a33', rim: '#ff2fb4' },
  pixel: { deck: '#ab5236', trim: '#fff1e8', mark: '#ff004d', mark2: '#fff1e8', post: '#5f574f', rim: '#c2c3c7' },
  paper: { deck: '#dcb67f', trim: '#fffdf5', mark: '#e76f51', mark2: '#fffdf5', post: '#8b5a3c', rim: '#caa06a' },
  clay: { deck: '#d8a066', trim: '#fbf3e6', mark: '#e84a3c', mark2: '#fbf3e6', post: '#6b4a32', rim: '#cbbba3' },
  water: { deck: '#eccca2', trim: '#ffffff', mark: '#ff8fab', mark2: '#ffffff', post: '#8a7a9a', rim: '#e6ded2' },
  cosmic: { deck: '#4a3f86', trim: '#5ef2ff', mark: '#ff6bd6', mark2: '#e9f7ff', post: '#241c46', rim: '#ff6bd6' },
};

// ---------------------------------------------------------------- effects per world

interface FxStyle {
  /** additive particles: colours are HDR */
  hot: boolean;
  drops: string[];
  dropShape: Shape;
  foam: string[];
  spark: string[];
  sparkShape: Shape;
  hit: string[];
  hitShape: Shape;
  ring: string;
  /** splash droplets' opacity */
  alpha: number;
}

const FX: Record<string, FxStyle> = {
  park: { hot: false, drops: ['#ffffff', '#bdeeff', '#4fc3f7'], dropShape: 'soft', foam: ['#ffffff'], spark: ['#fff27a', '#ffffff', '#ffb13d'], sparkShape: 'star', hit: ['#ffffff', '#fff27a'], hitShape: 'star', ring: '#ffffff', alpha: 0.9 },
  plaza: { hot: false, drops: ['#ffffff', '#bfe8ff', '#3aa8ff'], dropShape: 'soft', foam: ['#ffffff'], spark: ['#fff27a', '#ffffff', '#ffb13d'], sparkShape: 'star', hit: ['#ffffff', '#fff27a'], hitShape: 'star', ring: '#ffffff', alpha: 0.95 },
  ink: { hot: false, drops: ['#15120f', '#f1e8d4', '#15120f'], dropShape: 'ink', foam: ['#15120f'], spark: ['#15120f', '#3b342d'], sparkShape: 'ink', hit: ['#d8321f', '#15120f'], hitShape: 'ink', ring: '#e9e0cc', alpha: 1 },
  neon: { hot: true, drops: ['#ff2fb4', '#22e6ff', '#ffd6f5'], dropShape: 'soft', foam: ['#22e6ff'], spark: ['#ffd23f', '#ff2fb4', '#22e6ff'], sparkShape: 'soft', hit: ['#ff2fb4', '#22e6ff', '#ffd23f'], hitShape: 'star', ring: '#22e6ff', alpha: 1 },
  pixel: { hot: false, drops: ['#fff1e8', '#29adff', '#c2c3c7'], dropShape: 'square', foam: ['#fff1e8'], spark: ['#ffec27', '#ffa300', '#fff1e8'], sparkShape: 'square', hit: ['#ffec27', '#fff1e8', '#ff004d'], hitShape: 'square', ring: '#fff1e8', alpha: 1 },
  paper: { hot: false, drops: ['#ffffff', '#8ccfec', '#4f9fcb'], dropShape: 'confetti', foam: ['#ffffff'], spark: ['#ffe066', '#ffffff'], sparkShape: 'confetti', hit: ['#ffffff', '#ffe066', '#ffd1dc'], hitShape: 'confetti', ring: '#ffffff', alpha: 1 },
  clay: { hot: false, drops: ['#ffffff', '#b7e4ff', '#6fbff0'], dropShape: 'soft', foam: ['#fff8ea'], spark: ['#ffe98a', '#ffffff', '#ffb35a'], sparkShape: 'soft', hit: ['#ffffff', '#ffe98a'], hitShape: 'soft', ring: '#f2fbff', alpha: 1 },
  water: { hot: false, drops: ['#ffffff', '#c6e7f7', '#9fc4ff'], dropShape: 'soft', foam: ['#ffffff'], spark: ['#fff2b3', '#ffd6e7', '#ffffff'], sparkShape: 'soft', hit: ['#ffd6e7', '#d6e6ff', '#fff2b3'], hitShape: 'soft', ring: '#ffffff', alpha: 0.75 },
  cosmic: { hot: true, drops: ['#a86bff', '#5ef2ff', '#ffffff'], dropShape: 'star', foam: ['#a86bff'], spark: ['#5ef2ff', '#ffffff', '#ff6bd6'], sparkShape: 'star', hit: ['#5ef2ff', '#a86bff', '#ffffff'], hitShape: 'star', ring: '#a86bff', alpha: 1 },
};

// ---------------------------------------------------------------- geometry helpers

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** A flat rectangle facing up at height y, with planar uvs: u across (0…1 over the deck), v along (per 1.6 m). */
function flat(x0: number, x1: number, z0: number, z1: number, y: number) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + HW) / (2 * HW), p.getZ(i) / 1.6);
  return g;
}

/** Deck planks running across the pier: near-white so it modulates the kit's colour — seams, grain, nails. */
function plankTexture() {
  const rng = new Rng(20260927);
  const S = 512;
  const t = canvasTex(S, S, (x) => {
    const n = 8; // planks per texture (1.6 m)
    const ph = S / n;
    for (let b = 0; b < n; b++) {
      const k = 0.88 + rng.next() * 0.12;
      x.fillStyle = `rgb(${Math.round(255 * k)}, ${Math.round(250 * k)}, ${Math.round(240 * k)})`;
      x.fillRect(0, b * ph, S, ph + 1);
      for (let s = 0; s < 5; s++) {
        x.strokeStyle = `rgba(110, 70, 30, ${0.05 + rng.next() * 0.07})`;
        x.lineWidth = 0.8 + rng.next() * 1.4;
        const gy = b * ph + 3 + rng.next() * (ph - 6);
        const off = rng.next() * 6;
        x.beginPath();
        for (let xx = 0; xx <= S; xx += 24) x.lineTo(xx, gy + Math.sin(xx * 0.02 + off) * 1.4);
        x.stroke();
      }
      // nail heads where the planks cross the joists
      x.fillStyle = 'rgba(70, 50, 40, 0.5)';
      for (const u of [0.1, 0.5, 0.9]) for (const v of [0.3, 0.7]) x.fillRect(u * S - 2, b * ph + v * ph - 2, 4, 4);
    }
    x.fillStyle = 'rgba(80, 50, 25, 0.55)';
    for (let b = 0; b <= n; b++) x.fillRect(0, b * ph - 1.5, S, 3);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Neon Drive's deck: dark tiles ruled with glowing seams. */
function neonDeckTexture() {
  const t = canvasTex(256, 256, (x) => {
    x.fillStyle = '#0c0618';
    x.fillRect(0, 0, 256, 256);
    x.fillStyle = '#ffffff';
    for (let i = 0; i <= 4; i++) x.fillRect(0, i * 64 - 2, 256, 4);
    x.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i <= 4; i++) x.fillRect(i * 64 - 1, 0, 2, 256);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Hazard stripes for the ends: diagonal bands of the two marking colours. */
function stripeTexture(a: string, b: string) {
  const t = canvasTex(128, 128, (x) => {
    x.fillStyle = a;
    x.fillRect(0, 0, 128, 128);
    x.fillStyle = b;
    for (let i = -2; i < 4; i++) {
      x.beginPath();
      x.moveTo(i * 64, 0);
      x.lineTo(i * 64 + 32, 0);
      x.lineTo(i * 64 + 32 + 128, 128);
      x.lineTo(i * 64 + 128, 128);
      x.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------- splash rings

const RING_VERT = /* glsl */ `
attribute vec4 aRing; attribute vec2 aLife;
uniform float uTime;
varying vec2 vP; varying float vAge; varying float vR; varying float vW;
void main() {
  vAge = (uTime - aRing.z) / aLife.x;
  vR = aRing.w * (1.0 - pow(1.0 - clamp(vAge, 0.0, 1.0), 2.2));
  vW = aLife.y;
  vP = position.xz * aRing.w;
  vec3 w = vec3(aRing.x + vP.x, position.y, aRing.y + vP.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity; uniform int uHard;
varying vec2 vP; varying float vAge; varying float vR; varying float vW;
void main() {
  if (vAge < 0.0 || vAge > 1.0) discard;
  float d = abs(length(vP) - vR);
  float a = 1.0 - smoothstep(vW * 0.4, vW, d);
  a *= 1.0 - vAge;
  if (uHard == 1) a = step(0.35, a);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a * uOpacity);
}`;

/** Rings spreading on the hazard's surface (a splash, a sinking end): a few quads in one draw. */
class Ripples {
  mesh: THREE.Mesh;
  private ring: THREE.InstancedBufferAttribute | THREE.BufferAttribute;
  private life: THREE.BufferAttribute;
  private mat: THREE.ShaderMaterial;
  private next = 0;
  private until = 0;
  private static N = 10;

  constructor(color: THREE.Color, additive: boolean, hard: boolean) {
    const N = Ripples.N;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < N; i++) {
      pos.push(-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1);
      const a = i * 4;
      idx.push(a, a + 2, a + 1, a, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.ring = new THREE.BufferAttribute(new Float32Array(N * 4 * 4).fill(-1e6), 4).setUsage(THREE.DynamicDrawUsage);
    this.life = new THREE.BufferAttribute(new Float32Array(N * 4 * 2).fill(1), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aRing', this.ring);
    g.setAttribute('aLife', this.life);
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: color }, uOpacity: { value: 0.9 }, uHard: { value: hard ? 1 : 0 } },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetUnits: -8,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'ripples';
    this.mesh.position.y = HAZARD_Y + 0.02;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.userData.noOutline = true;
    this.mesh.userData.noNormals = true;
  }

  spawn(time: number, x: number, z: number, radius: number, life: number, width: number) {
    const i = this.next;
    this.next = (this.next + 1) % Ripples.N;
    for (let v = 0; v < 4; v++) {
      this.ring.setXYZW(i * 4 + v, x, z, time, radius);
      this.life.setXY(i * 4 + v, life, width);
    }
    this.ring.needsUpdate = true;
    this.life.needsUpdate = true;
    this.until = Math.max(this.until, time + life);
  }

  update(time: number) {
    this.mat.uniforms.uTime.value = time;
    this.mesh.visible = time < this.until;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- the venue

type Section = 'full' | 'mid' | 'a' | 'b';

interface StaticSet {
  geos: THREE.BufferGeometry[];
  cast: boolean;
  receive: boolean;
  /** outline width scale; 0 = none */
  outline: number;
}

interface MatOpts {
  map?: THREE.Texture;
  /** `map` is fine detail: skip it on flat-shaded low-res styles */
  detail?: boolean;
  /** floor-level: a constant depth bias so it wins over a world ground at the same height */
  floor?: number;
  /** cap HDR colours (glow worlds) */
  maxGlow?: number;
  /** scale the kit's rim light */
  rim?: number;
}

export interface DuelVenueOpts {
  /** the world's particle system (World.particles); without one the venue brings its own */
  particles?: Particles;
  /** the world's id (World.def.id): picks the hazard (water, ink, abyss…) and the effects' look */
  world?: string;
}

const tmpC = new THREE.Color();

export class DuelVenue {
  readonly group = new THREE.Group();
  private mats = new Map<string, THREE.Material>();
  private statics = new Map<Section, Map<THREE.Material, StaticSet>>();
  private sections = new Map<Section, THREE.Group>();
  private disposables: { dispose(): void }[] = [];
  private hazard: Hazard;
  private ripples: Ripples;
  private particles: Particles;
  private ownParticles = false;
  private fx: FxStyle;
  private pal: Pal;
  private world: string;
  private time = 0;
  /** how far the ends have gone: 0 = in place … 1 = sunk (a smoothed follower of the view) */
  private sink = 0;
  private sinkV = 0;
  /** the ends touched the surface (for the splash) */
  private wet = false;
  private hl = FULL;

  constructor(
    private kit: MaterialKit,
    opts: DuelVenueOpts = {},
  ) {
    this.world = opts.world ?? 'park';
    this.pal = PAL[this.world] ?? PAL.park;
    this.fx = FX[this.world] ?? FX.park;
    this.group.name = 'duel';
    for (const s of ['full', 'mid', 'a', 'b'] as Section[]) {
      this.statics.set(s, new Map());
      const g = new THREE.Group();
      g.name = `duel-${s}`;
      this.sections.set(s, g);
      this.group.add(g);
    }
    // the ends turn about the joints where they meet the middle
    this.sections.get('a')!.position.set(0, TOP, SHORT);
    this.sections.get('b')!.position.set(0, TOP, -SHORT);

    this.buildDeck();
    this.buildSupports();
    this.bake();

    const k = hazardKind(this.world);
    this.hazard = new Hazard({
      kit,
      kind: k,
      mat: (role, css, o = {}) => this.mat(role, css, { ...o, fresh: true }),
      glow: (css, g) => this.glow(css, g),
      rimColor: this.pal.rim,
    });
    this.group.add(this.hazard.group);

    if (kit.outline) {
      const o = kit.outline;
      outlineTree(this.group, o.color, o.width, { emissive: o.emissive });
    }

    const hot = this.fx.hot;
    this.ripples = new Ripples(new THREE.Color(this.fx.ring).multiplyScalar(hot ? 2.2 : 1), hot, this.world === 'pixel' || this.world === 'plaza' || this.world === 'paper');
    this.group.add(this.ripples.mesh);
    if (opts.particles) this.particles = opts.particles;
    else {
      // standalone: its own particles, drawn and stepped with the venue
      const P = new Particles(400, { additive: hot, fog: false });
      this.particles = P;
      this.ownParticles = true;
      this.group.add(P.mesh);
    }
    this.placePosts(0);
    this.update({ halfLength: FULL, fx: [] }, 0);
  }

  // ---------------------------------------------------------------- per frame

  update(v: DuelView, realDt: number) {
    this.time += realDt;
    this.shorten(v.halfLength, realDt);
    this.hazard.update(this.time, this.hl);
    for (const f of v.fx) this.effect(f);
    this.ripples.update(this.time);
    if (this.ownParticles) this.particles.update(realDt);
  }

  dispose() {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.hazard.dispose();
    this.ripples.dispose();
    if (this.ownParticles) this.particles.dispose();
  }

  // ---------------------------------------------------------------- the final round's shorter platform

  /**
   * The ends follow the view's half-length: at ARENA.length / 2 they're in
   * place, at ARENA.finalLength / 2 they're gone. However the game changes it
   * (a jump between rounds, a slow squeeze), they crack, tip outwards and sink
   * over a second or two; back at full length they rise again.
   */
  private shorten(halfLength: number, dt: number) {
    const want = THREE.MathUtils.clamp((FULL - halfLength) / (FULL - SHORT), 0, 1);
    // a critically damped follower, rate-limited so a jump plays out as an event
    const k = 3.2;
    this.sinkV += ((want - this.sink) * k * k - 2 * k * this.sinkV) * dt;
    this.sinkV = THREE.MathUtils.clamp(this.sinkV, -0.6, 0.6);
    this.sink = THREE.MathUtils.clamp(this.sink + this.sinkV * dt, 0, 1);
    if (Math.abs(want - this.sink) < 1e-3 && Math.abs(this.sinkV) < 1e-3) {
      this.sink = want;
      this.sinkV = 0;
    }
    const s = this.sink;
    const split = s > 1e-3;
    this.sections.get('full')!.visible = !split;
    this.sections.get('mid')!.visible = split;
    // tip outwards about the joint, then slide down under the surface
    const tip = THREE.MathUtils.smoothstep(s, 0, 0.35) * 0.32 + s * 0.25;
    const drop = s * s * 3.4 + THREE.MathUtils.smoothstep(s, 0, 0.12) * 0.05;
    const shake = s > 0 && s < 0.15 ? Math.sin(this.time * 70) * 0.012 * (1 - s / 0.15) : 0;
    for (const [name, sign] of [
      ['a', 1],
      ['b', -1],
    ] as const) {
      const g = this.sections.get(name)!;
      g.visible = split && s < 0.999;
      g.rotation.x = sign * tip;
      g.position.set(shake, TOP - drop, sign * (SHORT + s * 0.25));
    }
    // the half-length the hazard sees (the shade under the deck, the foam)
    this.hl = FULL - (FULL - SHORT) * THREE.MathUtils.smoothstep(s, 0.1, 0.6);
    this.placePosts(s);
    // a splash as the outer ends hit the surface
    const outerY = TOP - drop - Math.sin(tip) * (FULL - SHORT);
    if (!this.wet && split && outerY < HAZARD_Y + 0.1) {
      this.wet = true;
      for (const z of [FULL + 0.3, -FULL - 0.3]) this.splash(0, z, 0.8);
    }
    if (s < 0.05) this.wet = false;
  }

  /** the posts the liquid foams around: the ends' go as they sink */
  private placePosts(s: number) {
    let i = 0;
    const endW = THREE.MathUtils.clamp(1 - s * 3, 0, 1);
    for (const z of POST_Z)
      for (const sz of z === 0 ? [1] : [1, -1])
        for (const sx of [-1, 1]) {
          if (i >= MAX_POSTS) return;
          const w = z > SHORT ? endW : 1;
          this.hazard.setPost(i++, sx * POST_X, sz * z, w);
        }
  }

  // ---------------------------------------------------------------- effects

  private effect(f: DuelFx) {
    if (f.type === 'splash') this.splash(f.x, f.z, 1);
    else if (f.type === 'hit') this.hit(f.x, f.y, f.z, f.strength);
    else if (f.type === 'block') this.block(f.x, f.y, f.z, f.strength, 1);
    else if (f.type === 'clash') this.block(f.x, f.y, f.z, 1, 1.8);
  }

  private cols(list: string[], k = 1) {
    const hot = this.fx.hot;
    return list.map((c) => new THREE.Color(c).multiplyScalar(hot ? 2.6 * k : 1));
  }

  /** A body hits the hazard: a plume, spray, a crown of foam and rings spreading out. */
  private splash(x: number, z: number, size: number) {
    const P = this.particles;
    const F = this.fx;
    const y = HAZARD_Y + 0.05;
    const drops = this.cols(F.drops);
    const grav = this.world === 'cosmic' ? 2.5 : 9.8;
    // the plume: fast enough to clear the deck from the players' view straight away
    P.burst({ x, y, z, count: Math.round(70 * size), speed: [6 * size, 11 * size], dir: [0, 1, 0], spread: 0.26, life: [0.8, 1.4], size: [0.12, 0.28], shrink: 0.5, colors: drops, shape: F.dropShape, gravity: grav, drag: 0.7, alpha: F.alpha, spin: 6 });
    // the column: big blobs of foam going straight up
    if (!F.hot) P.burst({ x, y: y + 0.3, z, count: Math.round(8 * size), speed: [5 * size, 8 * size], dir: [0, 1, 0], spread: 0.12, life: [0.55, 0.8], size: [0.5, 0.8], shrink: 1.4, colors: this.cols(this.world === 'ink' ? ['#f1e8d4', '#15120f'] : F.foam), shape: this.world === 'pixel' ? 'square' : this.world === 'ink' ? 'ink' : 'soft', gravity: grav, drag: 1.2, alpha: 0.9 });
    // spray thrown sideways
    P.burst({ x, y, z, count: Math.round(40 * size), speed: [2.5, 5.5], dir: [0, 0.45, 0], spread: 0.92, life: [0.5, 0.9], size: [0.07, 0.16], shrink: 0.4, colors: drops, shape: F.dropShape, gravity: grav, drag: 1.2, alpha: F.alpha, spin: 6 });
    // the foam crown
    if (!F.hot)
      P.burst({ x, y: y + 0.2, z, count: Math.round(16 * size), speed: [0.6, 2.2], dir: [0, 1, 0], spread: 0.8, life: [0.6, 1.1], size: [0.45, 0.9], shrink: 1.9, colors: this.cols(F.foam), shape: this.world === 'pixel' ? 'square' : this.world === 'ink' ? 'ink' : 'soft', gravity: 1.5, drag: 2.2, alpha: this.world === 'ink' ? 0.9 : 0.8 });
    else P.burst({ x, y: y + 0.3, z, count: 1, speed: [0, 0], life: [0.45, 0.45], size: [1.2, 1.2], shrink: 5, colors: this.cols(F.foam, 1.2), shape: 'ring', alpha: 1 });
    for (let i = 0; i < 3; i++) this.ripples.spawn(this.time - i * 0.18, x, z, (2.2 + i * 1.1) * size, 1.3 + i * 0.35, 0.16 + 0.05 * i);
  }

  /** A clean hit: a burst at the point of impact and a ring flashing out. */
  private hit(x: number, y: number, z: number, strength: number) {
    const P = this.particles;
    const F = this.fx;
    const s = THREE.MathUtils.clamp(strength, 0.2, 1.5);
    P.burst({ x, y, z, count: Math.round(10 + 16 * s), speed: [2.5, 4 + 4 * s], life: [0.25, 0.55], size: [0.08, 0.16 + 0.12 * s], shrink: 0.2, colors: this.cols(F.hit), shape: F.hitShape, drag: 3, gravity: this.world === 'ink' ? 9 : 2, spin: 8 });
    P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.3, 0.3], size: [0.35, 0.35], shrink: 6 + 3 * s, colors: this.cols(this.world === 'ink' ? ['#d8321f'] : ['#ffffff']), shape: 'ring', alpha: 0.85 });
  }

  /** Blades meeting: sparks flying off hot, a star-shaped clang and a flash (a clash is the same, bigger). */
  private block(x: number, y: number, z: number, strength: number, big: number) {
    const P = this.particles;
    const F = this.fx;
    const ink = this.world === 'ink';
    const s = THREE.MathUtils.clamp(strength, 0.3, 1.5) * big;
    P.burst({ x, y, z, count: Math.round(18 * s), speed: [3, 7 + 3 * s], life: [0.2, 0.5], size: [0.07, 0.15], shrink: 0.1, colors: this.cols(F.spark, 1.2), shape: F.sparkShape, drag: 2, gravity: 9, spin: 10 });
    // the clang: one big star, and a quick flash behind it
    P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.2, 0.2], size: [0.75 * s, 0.75 * s], shrink: 0.35, colors: this.cols(ink ? ['#d8321f'] : ['#fff6c0'], 1.3), shape: this.world === 'pixel' ? 'square' : 'star', spin: 0, alpha: 1 });
    P.burst({ x, y, z, count: 1, speed: [0, 0], life: [0.12, 0.12], size: [0.45 * s, 0.45 * s], shrink: 1.8, colors: this.cols(ink ? ['#15120f'] : ['#ffffff'], 1.3), shape: this.world === 'pixel' ? 'square' : 'soft', alpha: 0.75 });
    if (big > 1) P.burst({ x, y, z, count: 2, speed: [0, 0.2], life: [0.4, 0.5], size: [0.4, 0.5], shrink: 8, colors: this.cols(ink ? ['#15120f'] : ['#fff6c0']), shape: 'ring', alpha: 0.9 });
  }

  // ---------------------------------------------------------------- materials & baking

  private mat(role: CharRole, css: string, o: MatOpts & { fresh?: boolean } = {}) {
    const key = [role, css, o.map?.uuid ?? '', o.floor ?? 0, o.maxGlow ?? 0, o.rim ?? 1].join('|');
    let m = o.fresh ? undefined : this.mats.get(key);
    if (m) return m;
    const mat = this.kit.char(role, new THREE.Color(css));
    const mm = mat as THREE.MeshStandardMaterial;
    if (o.map && 'map' in mm && !(o.detail && mm.flatShading)) mm.map = o.map;
    if (o.floor) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = 0;
      mat.polygonOffsetUnits = -2 * o.floor;
    }
    if (o.maxGlow && mm.color) {
      const top = Math.max(mm.color.r, mm.color.g, mm.color.b);
      if (top > o.maxGlow) mm.color.multiplyScalar(o.maxGlow / top);
    }
    const rim = o.rim ?? 1;
    if (rim !== 1 && Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')) {
      const orig = mat.onBeforeCompile;
      mat.onBeforeCompile = (sh, r) => {
        orig.call(mat, sh, r);
        const u = sh.uniforms.uRim;
        if (u) u.value *= rim;
      };
    }
    this.mats.set(o.fresh ? key + '|' + this.mats.size : key, mat);
    return mat;
  }

  /** Unlit HDR colour, for the glowing worlds' accents (bloom picks them up). */
  private glow(css: string, k: number) {
    const key = `glow|${css}|${k}`;
    let m = this.mats.get(key);
    if (!m) this.mats.set(key, (m = new THREE.MeshBasicMaterial({ color: tmpC.set(css).clone().multiplyScalar(k) })));
    return m;
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  /**
   * Queue static geometry in the given sections: everything with the same
   * material in a section becomes one mesh. Geometry is in world space; the
   * ends' is moved to their joints.
   */
  private add(sections: Section[], mat: THREE.Material, geo: THREE.BufferGeometry, o: { cast?: boolean; receive?: boolean; outline?: number } = {}) {
    sections.forEach((sec, i) => {
      const g = i === sections.length - 1 ? geo : geo.clone();
      if (sec === 'a') g.translate(0, -TOP, -SHORT);
      if (sec === 'b') g.translate(0, -TOP, SHORT);
      const m = this.statics.get(sec)!;
      let s = m.get(mat);
      if (!s) m.set(mat, (s = { geos: [], cast: !!o.cast, receive: !!o.receive, outline: o.outline ?? 0 }));
      s.geos.push(g);
    });
  }

  private bake() {
    const shadows = !!this.kit.castShadow;
    for (const [sec, map] of this.statics) {
      const parent = this.sections.get(sec)!;
      for (const [mat, s] of map) {
        const geo = mergeGeometries(s.geos, false);
        s.geos.forEach((g) => g.dispose());
        if (!geo) continue;
        this.own(geo);
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = shadows && s.cast;
        m.receiveShadow = shadows && s.receive;
        if (s.outline <= 0) m.userData.noOutline = true;
        else m.userData.outlineScale = s.outline;
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        parent.add(m);
      }
      map.clear();
    }
  }

  /** Which sections a stretch of the platform from z0 to z1 (z0 < z1) belongs to. */
  private secs(z0: number, z1: number): Section[] {
    if (z0 >= SHORT - 1e-6) return ['full', 'a'];
    if (z1 <= -SHORT + 1e-6) return ['full', 'b'];
    return ['full', 'mid'];
  }

  // ---------------------------------------------------------------- the pier

  private buildDeck() {
    const pal = this.pal;
    const neon = this.world === 'neon';
    const cosmic = this.world === 'cosmic';
    const glowing = neon || cosmic;
    const planks = this.own(neon ? neonDeckTexture() : plankTexture());
    // Neon's deck is a dark floor with faint seams (a bright grid would melt into the abyss's)
    const deck = this.mat('hair', pal.deck, { map: planks, detail: !neon, rim: 0.25 });
    const trim = glowing ? this.glow(pal.trim, neon ? 2.0 : 1.7) : this.mat('racket', pal.trim, { maxGlow: 1.4, rim: 0.5 });
    const stripes = this.own(stripeTexture(pal.mark, pal.mark2));
    const mark = glowing ? this.markGlow(stripes, neon ? 1.6 : 1.4) : this.mat('racket', '#ffffff', { map: stripes, maxGlow: 1.3, rim: 0.4 });
    const under = this.mat('shirt', pal.post, { rim: 0.3 });
    // the slab's faces: the trim's colour, or dark under a thin line of light where the trim glows
    const face = glowing ? under : trim;
    const lipY = glowing ? TOP - 0.025 : TOP - SLAB;

    // the deck in three stretches (the ends can break away at ±SHORT)
    const stretches: [number, number][] = [
      [-FULL, -SHORT],
      [-SHORT, SHORT],
      [SHORT, FULL],
    ];
    for (const [z0, z1] of stretches) {
      const sec = this.secs(z0, z1);
      this.add(sec, deck, flat(-HW + 0.06, HW - 0.06, z0, z1, TOP), { receive: true });
      // the slab's underside
      this.add(sec, under, box(-HW + 0.06, HW - 0.06, TOP - SLAB, TOP - SLAB + 0.02, z0, z1), {});
      // the edge: a bright lip along each side, its face covering the slab
      for (const sx of [-1, 1]) {
        this.add(sec, trim, box(sx * (HW - 0.05), sx * (HW + 0.03), lipY, TOP + LIP, z0, z1), { cast: true, receive: true, outline: 1 });
        if (glowing) this.add(sec, face, box(sx * (HW - 0.04), sx * (HW + 0.02), TOP - SLAB, lipY, z0, z1), { cast: true, outline: 1 });
      }
    }
    // the ends: a striped band on the deck, a trimmed face on the end
    const band = (zEdge: number, sign: number, secs: Section[]) => {
      const zi = zEdge - sign * BAND;
      const zb = zEdge - sign * 0.03;
      this.add(secs, mark, flat(-HW + 0.06, HW - 0.06, Math.min(zi, zb), Math.max(zi, zb), TOP + 0.004), { receive: true });
      const zo = zEdge + sign * 0.02,
        zn = zEdge - sign * 0.06;
      this.add(secs, trim, box(-HW - 0.03, HW + 0.03, lipY, TOP + LIP, Math.min(zo, zn), Math.max(zo, zn)), { cast: true, receive: true, outline: 1 });
      if (glowing) this.add(secs, face, box(-HW - 0.02, HW + 0.02, TOP - SLAB, lipY, Math.min(zo, zn) + 0.01, Math.max(zo, zn) - 0.01), { cast: true, outline: 1 });
    };
    band(FULL, 1, ['full', 'a']);
    band(-FULL, -1, ['full', 'b']);
    // the middle's own ends, for when the ends have gone
    band(SHORT, 1, ['mid']);
    band(-SHORT, -1, ['mid']);
  }

  private markGlow(map: THREE.Texture, k: number) {
    const key = `markglow|${map.uuid}|${k}`;
    let m = this.mats.get(key);
    if (!m) this.mats.set(key, (m = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(k, k, k) })));
    return m;
  }

  /** Posts down into the hazard, beams under the deck's edges and across at every post. */
  private buildSupports() {
    const post = this.mat('shirt', this.pal.post, { rim: 0.4 });
    const ol = this.world === 'neon' ? 0 : 1;
    const bottom = HAZARD_Y - 0.5;
    const beamY0 = TOP - SLAB - 0.14;
    const pg = new THREE.CylinderGeometry(0.12, 0.14, TOP - SLAB - bottom, 12);
    pg.translate(0, (TOP - SLAB + bottom) / 2, 0);
    for (const z of POST_Z)
      for (const sz of z === 0 ? [1] : [1, -1]) {
        const zz = sz * z;
        const sec = this.secs(zz - 0.01, zz + 0.01);
        for (const sx of [-1, 1]) this.add(sec, post, pg.clone().translate(sx * POST_X, 0, zz), { cast: true, outline: ol });
        // a cross beam under the deck at each pair
        this.add(sec, post, box(-POST_X - 0.1, POST_X + 0.1, beamY0, TOP - SLAB, zz - 0.07, zz + 0.07), { cast: true, outline: ol });
      }
    pg.dispose();
    // stringers along each side, in the same three stretches as the deck
    for (const [z0, z1] of [
      [-FULL + 0.1, -SHORT],
      [-SHORT, SHORT],
      [SHORT, FULL - 0.1],
    ] as [number, number][])
      for (const sx of [-1, 1]) this.add(this.secs(z0, z1), post, box(sx * POST_X - 0.08, sx * POST_X + 0.08, beamY0, TOP - SLAB, z0, z1), { cast: true, outline: ol });
  }
}
