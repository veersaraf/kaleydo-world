// The Stage owns the live world(s) and composites transitions between them.
// The signature effect is the "kaleidoscope shatter": the current world
// breaks into spinning prism shards that fall away to reveal the next one.

import * as THREE from 'three';
import { Pass, makeRT } from './post';
import { FX_TIERS, type DofState } from './effects';
import { NOISE, COLOR } from './glsl';
import type { World, WorldDef, FrameView } from '../worlds/base';
import type { Look } from '../chars/look';

const SHATTER = /* glsl */ `
uniform sampler2D tA; uniform sampler2D tB; uniform float uP; uniform vec2 uOrigin; uniform float uAspect; uniform float uCells; uniform float uIris; uniform vec2 uIrisC;
varying vec2 vUv;
${NOISE}
${COLOR}
vec2 seedOf(vec2 cell) { return cell + 0.15 + 0.7 * hash22(cell); }
// nearest seed (voronoi) in aspect-corrected grid space
vec3 voro(vec2 g) {
  vec2 c = floor(g);
  float best = 1e9, second = 1e9; vec2 bc = c;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cc = c + vec2(i, j);
    vec2 s = seedOf(cc);
    float d = length(g - s);
    if (d < best) { second = best; best = d; bc = cc; } else if (d < second) second = d;
  }
  return vec3(bc, second - best);
}
void main() {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 g = vUv * asp * uCells;
  vec3 v = voro(g);
  vec2 cell = v.xy;
  vec2 seed = seedOf(cell);
  vec2 seedUv = seed / (asp * uCells);
  float r1 = hash21(cell + 7.3), r2 = hash21(cell + 1.9);
  float dist = length((seedUv - uOrigin) * asp);
  float delay = dist * 0.75 + r1 * 0.22;
  float p = clamp((uP * 1.9 - delay) / 0.75, 0.0, 1.0);
  float e = p * p;
  vec3 col;
  if (p <= 0.0) {
    col = texture2D(tA, vUv).rgb;
  } else {
    // shard transform: shrink, spin, drift away from the origin and fall
    float sc = max(1e-3, 1.0 - e);
    float rot = e * (r2 - 0.5) * 5.0;
    vec2 away = normalize((seedUv - uOrigin) * asp + 1e-4);
    vec2 off = away * e * 0.35 + vec2(0.0, -e * e * 0.5);
    vec2 q = (vUv - seedUv) * asp - off;
    float c = cos(-rot), s = sin(-rot);
    q = vec2(c * q.x - s * q.y, s * q.x + c * q.y) / sc;
    vec2 src = seedUv + q / asp;
    vec3 v2 = voro(src * asp * uCells);
    if (all(equal(v2.xy, cell)) && src.x > 0.0 && src.x < 1.0 && src.y > 0.0 && src.y < 1.0) {
      col = texture2D(tA, src).rgb;
      // facet shading + prismatic edge glint
      float edge = smoothstep(0.08, 0.0, v2.z);
      vec3 prism = 0.5 + 0.5 * cos(6.2831 * (r1 + dist * 1.5 + vec3(0.0, 0.33, 0.67)));
      col = col * (0.85 + 0.3 * sin(rot * 2.0 + r1 * 6.0)) + edge * prism * 1.2 * (0.4 + e);
    } else {
      col = texture2D(tB, vUv).rgb;
    }
  }
  // crack lines across A just before it breaks
  float crack = smoothstep(0.035, 0.0, v.z) * smoothstep(0.0, 0.08, uP) * (1.0 - smoothstep(0.1, 0.35, uP)) * step(dist, uP * 3.0 + 0.1);
  col += crack * vec3(1.0, 0.98, 0.9) * 1.4;
  // soft flash at the origin
  col += vec3(1.0) * exp(-length((vUv - uOrigin) * asp) * 7.0) * sin(clamp(uP * 3.0, 0.0, 1.0) * 3.14159) * 0.9;
  // iris wipe
  float ir = length((vUv - uIrisC) * asp);
  col *= smoothstep(uIris, uIris - 0.004, ir);
  gl_FragColor = vec4(col, 1.0);
}`;

const COPY = /* glsl */ `
uniform sampler2D tA; uniform float uIris; uniform vec2 uIrisC; uniform float uAspect;
varying vec2 vUv;
void main() {
  vec3 col = texture2D(tA, vUv).rgb;
  float ir = length((vUv - uIrisC) * vec2(uAspect, 1.0));
  col *= smoothstep(uIris, uIris - 0.004, ir);
  gl_FragColor = vec4(col, 1.0);
}`;

export class Stage {
  current: World | null = null;
  next: World | null = null;
  private cache = new Map<string, World>();
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private shatter: Pass;
  private copy: Pass;
  private tr = { t: 0, dur: 1.4, origin: new THREE.Vector2(0.5, 0.5) };
  /** 0 closed … >1.5 fully open */
  iris = 3;
  irisCenter = new THREE.Vector2(0.5, 0.5);
  w = 1;
  h = 1;
  pr = 1;
  /** 1 = full screen, 2 = side-by-side split screen */
  views = 1;
  /** MSAA samples for the worlds' scene buffers (the quality controller sets it) */
  msaa = 4;
  /** effects tier for the worlds (render/effects.ts FX_TIERS; the quality controller sets it) */
  fx = FX_TIERS.length - 1;
  /** depth of field for cutscenes and replays (worlds that offer it), or null */
  dof: DofState | null = null;
  looks: Look[] = [];
  private lookKey = '[]';
  /** the two teams' colours (ball halo) */
  private teamColors: [THREE.Color, THREE.Color] = [new THREE.Color('#3aa8ff'), new THREE.Color('#ff5a8c')];
  /** worlds whose shaders are compiled and data uploaded */
  private primed = new Set<string>();
  private primeRT = makeRT(16, 16, { type: THREE.UnsignedByteType });
  onSwap: (w: World) => void = () => {};

  constructor(
    public renderer: THREE.WebGLRenderer,
    private defs: WorldDef[],
  ) {
    this.rtA = makeRT(1, 1, { type: THREE.UnsignedByteType });
    this.rtB = makeRT(1, 1, { type: THREE.UnsignedByteType });
    this.shatter = new Pass(SHATTER, {
      tA: { value: null },
      tB: { value: null },
      uP: { value: 0 },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAspect: { value: 1 },
      uCells: { value: 7 },
      uIris: { value: 3 },
      uIrisC: { value: new THREE.Vector2(0.5, 0.5) },
    });
    this.copy = new Pass(COPY, { tA: { value: null }, uIris: { value: 3 }, uIrisC: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 } });
  }

  def(id: string) {
    return this.defs.find((d) => d.id === id) ?? this.defs[0];
  }

  get(id: string): World {
    let w = this.cache.get(id);
    if (!w) {
      w = this.def(id).make(this.renderer);
      w.init();
      w.resize(this.vw, this.h, this.pr);
      w.teamColors = [this.teamColors[0].clone(), this.teamColors[1].clone()];
      this.cache.set(id, w);
    }
    return w;
  }

  /** Get a world ready to draw this frame: right-sized buffers, current players. */
  private activate(w: World) {
    w.fitTargets(this.vw, this.h, this.pr, this.msaa, this.fx);
    w.setPlayers(this.looks, this.lookKey);
  }

  /** A world left the screen: give its buffers back. */
  private retire(w: World | null) {
    if (w && w !== this.current && w !== this.next && w !== this.warmWorld) w.releaseTargets();
  }

  /**
   * Build a world, compile its shaders and upload its data now (a hitch nobody
   * sees, e.g. behind the loading screen) instead of the first time it appears.
   */
  async prime(id: string, cam: THREE.PerspectiveCamera) {
    if (this.primed.has(id)) return;
    const w = this.get(id);
    const r = this.renderer as THREE.WebGLRenderer & { compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown> };
    w.setPlayers(this.looks, this.lookKey);
    if (r.compileAsync) await r.compileAsync(w.scene, cam).catch(() => {});
    if (this.primed.has(id)) return;
    this.primed.add(id);
    const onScreen = w === this.current || w === this.next;
    // one tiny render into a buffer and one into a single screen pixel: uploads
    // geometry/textures and compiles the post passes (every effect pass, whatever
    // the tier) for both kinds of target
    if (!onScreen) w.fitTargets(64, 40, 1, this.msaa, this.fx);
    w.priming = true;
    w.render(cam, this.primeRT);
    const vp = r.getViewport(new THREE.Vector4());
    const sc = r.getScissor(new THREE.Vector4());
    const st = r.getScissorTest();
    r.setViewport(0, 0, 1, 1);
    r.setScissor(0, 0, 1, 1);
    r.setScissorTest(true);
    w.render(cam, null);
    w.priming = false;
    if (!this.shatterPrimed) {
      this.shatterPrimed = true;
      this.shatter.u.tA.value = this.primeRT.texture;
      this.shatter.u.tB.value = this.primeRT.texture;
      this.shatter.render(r, null);
      this.copy.u.tA.value = this.primeRT.texture;
      this.copy.render(r, null);
    }
    r.setViewport(vp);
    r.setScissor(sc);
    r.setScissorTest(st);
    if (!onScreen) w.releaseTargets();
  }
  private shatterPrimed = false;

  isPrimed(id: string) {
    return this.primed.has(id);
  }

  /** Pre-build a world (e.g. the next in a rotation) so switching to it doesn't hitch. */
  /**
   * Get the world that's about to appear ready now: this match's characters and
   * full-size buffers (allocated by one render into them), so the switch itself —
   * often a shatter in the middle of a rally — has nothing left to set up.
   */
  warm(id: string, cam: THREE.PerspectiveCamera) {
    if (!this.primed.has(id)) {
      void this.prime(id, cam);
      return;
    }
    const w = this.get(id);
    if (w === this.current || w === this.next) return;
    if (this.warmWorld && this.warmWorld !== w) this.retire(this.warmWorld);
    this.warmWorld = w;
    this.warmCam = cam;
    w.setPlayers(this.looks, this.lookKey);
    this.refitWarm();
  }

  /** the world prepared to appear next (keeps its buffers while waiting) */
  private warmWorld: World | null = null;
  private warmCam: THREE.PerspectiveCamera | null = null;

  private refitWarm() {
    const w = this.warmWorld;
    if (!w || !this.warmCam || w === this.current || w === this.next) return;
    w.fitTargets(this.vw, this.h, this.pr, this.msaa, this.fx);
    w.render(this.warmCam, this.primeRT);
  }

  get transitioning() {
    return !!this.next;
  }

  setWorld(id: string, opts: { transition?: boolean; origin?: { x: number; y: number }; dur?: number } = {}) {
    const w = this.get(id);
    if (w === this.current && !this.next) return;
    if (w === this.warmWorld) this.warmWorld = null;
    this.activate(w);
    if (!this.current || !opts.transition) {
      const old = [this.current, this.next];
      this.current = w;
      this.next = null;
      old.forEach((o) => this.retire(o));
      this.onSwap(w);
      return;
    }
    if (this.next) {
      // finish the running transition instantly
      const old = this.current;
      this.current = this.next;
      this.next = null;
      this.retire(old);
      this.onSwap(this.current);
    }
    if (w === this.current) {
      this.next = null;
      return;
    }
    this.next = w;
    this.tr.t = 0;
    this.tr.dur = opts.dur ?? 1.35;
    this.tr.origin.set(opts.origin?.x ?? 0.5, 1 - (opts.origin?.y ?? 0.5));
  }

  setTeamColors(a: string, b: string) {
    this.teamColors = [new THREE.Color(a), new THREE.Color(b)];
    for (const w of this.cache.values()) w.teamColors = [this.teamColors[0].clone(), this.teamColors[1].clone()];
  }

  setPlayers(looks: Look[]) {
    this.looks = looks;
    this.lookKey = JSON.stringify(looks);
    // only the worlds on screen rebuild their rigs now; others do when they appear
    for (const w of [this.current, this.next]) w?.setPlayers(looks, this.lookKey);
  }

  /** width of one view, CSS pixels */
  get vw() {
    return this.views === 2 ? Math.floor(this.w / 2) : this.w;
  }

  resize(w: number, h: number, pr: number) {
    this.w = w;
    this.h = h;
    this.pr = pr;
    this.applySize();
  }

  setViews(n: 1 | 2) {
    if (n === this.views) return;
    this.views = n;
    this.applySize();
  }

  /** MSAA for the scene buffers (the quality controller's call). */
  setMsaa(n: number) {
    if (n === this.msaa) return;
    this.msaa = n;
    this.applySize();
  }

  /** Effects tier (the quality controller's call, or a test's). */
  setFx(n: number) {
    if (n === this.fx) return;
    this.fx = n;
    this.applySize();
  }

  private applySize() {
    const vw = this.vw,
      h = this.h,
      pr = this.pr;
    // worlds off screen are sized when they come back (except the one waiting in the wings)
    for (const w of [this.current, this.next]) w?.fitTargets(vw, h, pr, this.msaa, this.fx);
    this.refitWarm();
    this.rtA.setSize(Math.floor(vw * pr), Math.floor(h * pr));
    this.rtB.setSize(Math.floor(vw * pr), Math.floor(h * pr));
    this.shatter.u.uAspect.value = vw / h;
    this.copy.u.uAspect.value = vw / h;
  }

  update(v: FrameView) {
    this.current?.update(v);
    if (this.next) {
      this.next.update(v);
      this.tr.t += v.realDt;
      if (this.tr.t >= this.tr.dur) {
        const old = this.current;
        this.current = this.next;
        this.next = null;
        this.retire(old);
        this.onSwap(this.current);
      }
    }
  }

  /** Render one camera full screen, or one camera per view side by side. */
  render(cams: THREE.PerspectiveCamera | THREE.PerspectiveCamera[]) {
    if (!this.current) return;
    const list = Array.isArray(cams) ? cams : [cams];
    if (this.views === 1 || list.length < 2) {
      this.current.setView(0);
      this.next?.setView(0);
      this.renderView(list[0]);
      return;
    }
    const r = this.renderer;
    const W = Math.floor(this.w * this.pr),
      H = Math.floor(this.h * this.pr);
    const half = Math.floor(this.vw * this.pr);
    r.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      const x = i === 0 ? 0 : W - half;
      r.setViewport(x, 0, half, H);
      r.setScissor(x, 0, half, H);
      this.current.setView(i, list[i]);
      this.next?.setView(i, list[i]);
      this.renderView(list[i]);
    }
    this.current.setView(0);
    this.next?.setView(0);
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
  }

  private renderView(cam: THREE.PerspectiveCamera) {
    if (!this.current) return;
    const irisOpen = this.iris > 1.5;
    this.current.setDof(this.dof);
    this.next?.setDof(this.dof);
    if (this.next) {
      this.current.render(cam, this.rtA);
      this.next.render(cam, this.rtB);
      const u = this.shatter.u;
      u.tA.value = this.rtA.texture;
      u.tB.value = this.rtB.texture;
      u.uP.value = Math.min(1, this.tr.t / this.tr.dur);
      u.uOrigin.value.copy(this.tr.origin);
      u.uIris.value = this.iris;
      u.uIrisC.value.copy(this.irisCenter);
      this.shatter.render(this.renderer, null);
    } else if (!irisOpen) {
      this.current.render(cam, this.rtA);
      this.copy.u.tA.value = this.rtA.texture;
      this.copy.u.uIris.value = this.iris;
      this.copy.u.uIrisC.value.copy(this.irisCenter);
      this.copy.render(this.renderer, null);
    } else {
      this.current.render(cam, null);
    }
  }

  forEachWorld(f: (w: World) => void) {
    for (const w of this.cache.values()) f(w);
  }
}
