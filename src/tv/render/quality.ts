// Dynamic quality: keeps the frame rate locked by trading render resolution and
// effects against the GPU time each frame actually takes.
//
//  • Each level is a render scale and an effects tier (render/effects.ts). At a
//    given scale the effects go first: from the top, a step down drops the tier
//    before the resolution. The bottom tiers are cheap for real: no AO or shafts, a
//    1024 shadow map, a short bloom (none where it isn't the look) and thinner scenery.
//  • Anti-aliasing is FXAA in the final pass, not MSAA: on WebGL/ANGLE-Metal an
//    MSAA buffer is stored and blitted every frame (three.js can't invalidate it
//    on Chrome), which cost more than rendering at a higher scale — pr 1.75 with
//    FXAA is sharper than pr 1.3 with MSAA 4, and cheaper (see scripts/perf/gpu-bench.mjs).
//  • GPU time comes from timer queries (EXT_disjoint_timer_query_webgl2); without
//    them we fall back to counting late frames.
//  • It steps down quickly and up reluctantly: only with clear headroom, only if
//    the next level's predicted cost still fits, and never straight back to a
//    level that just failed.
//  • Changes wait for a safe moment (between points, menus, replays) unless the
//    game is badly overloaded, because resizing the buffers costs a frame.
//  • The level that worked is remembered per world for next time.

import type * as THREE from 'three';

export interface QLevel {
  pr: number;
  msaa: number;
  /** effects tier (render/effects.ts FX_TIERS) */
  fx: number;
}

export const LEVELS: QLevel[] = [
  { pr: 0.75, msaa: 0, fx: 0 },
  { pr: 0.9, msaa: 0, fx: 1 },
  { pr: 1.0, msaa: 0, fx: 2 },
  { pr: 1.0, msaa: 0, fx: 3 },
  { pr: 1.15, msaa: 0, fx: 2 },
  { pr: 1.15, msaa: 0, fx: 3 },
  { pr: 1.3, msaa: 0, fx: 2 },
  { pr: 1.3, msaa: 0, fx: 3 },
  { pr: 1.5, msaa: 0, fx: 2 },
  { pr: 1.5, msaa: 0, fx: 3 },
  { pr: 1.75, msaa: 0, fx: 3 },
  { pr: 2.0, msaa: 0, fx: 3 },
];

/** where a Retina screen starts: pr 1.5 with every effect */
const START_RETINA = 9;
/** …and a 1× screen: native resolution with every effect */
const START_1X = 3;
/** the phone preview starts low (a phone has a small GPU budget and little memory): native CSS pixels, the middle effects tier */
export const START_PHONE = 2;

// (a new key: the levels' meaning changed with the effects tiers)
const STORE = 'kaleido.quality.v2';
/**
 * Relative GPU cost of an effects tier at one render scale (scripts/perf/perf-rungs.mjs, park, plaza,
 * neon and cosmic at pr 1: tier 0 ≈ 0.55–0.85 of tier 3, tier 1 ≈ 0.65–0.95). The low tiers also
 * drop the bloom (or shorten it), shrink the shadow map and thin the scenery (FX_TIERS), so
 * they are well under the top: the governor's step-up prediction has to see that.
 */
const FX_COST = [0.8, 1, 1.15, 1.25];
const cost = (l: QLevel) => l.pr * l.pr * (1 + l.msaa * 0.4) * FX_COST[l.fx];

export class Quality {
  level: number;
  readonly maxLevel: number;
  /** level waiting for a safe moment */
  pending: number | null = null;
  world = '';
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private queries: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private gpu: number[] = [];
  private gaps: number[] = [];
  private evalAt = 0;
  private stableSince = 0;
  private savedAt = 0;
  /** level → time it last proved too slow (per world) */
  private failed = new Map<string, number>();
  private saved: Record<string, number> = {};

  /** `start`: the level to begin at, if not the screen's default (the phone preview's) */
  constructor(renderer: THREE.WebGLRenderer, dpr: number, start?: number) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    // rendering beyond the screen's own pixels buys nothing
    let max = 0;
    LEVELS.forEach((l, i) => {
      if (l.pr <= Math.max(1, dpr) + 0.01) max = i;
    });
    this.maxLevel = max;
    // a Retina screen starts at 1.5× with every effect (sharp, and affordable on most Macs)
    this.level = Math.min(max, start ?? (dpr > 1.2 ? START_RETINA : START_1X));
    try {
      this.saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    } catch {
      this.saved = {};
    }
  }

  get current(): QLevel {
    return LEVELS[this.level];
  }

  get hasTimer() {
    return !!this.ext;
  }

  /** A new world is on screen: start from what worked there before. */
  setWorld(id: string, now: number) {
    if (id === this.world) return;
    this.world = id;
    this.gpu.length = 0;
    this.gaps.length = 0;
    this.stableSince = Math.max(this.stableSince, now);
    this.evalAt = Math.max(this.evalAt, now + 1500);
    const s = this.saved[id];
    if (s !== undefined && s !== this.level) this.pending = Math.min(this.maxLevel, Math.max(0, s));
  }

  beginFrame() {
    if (!this.ext || this.active) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  endFrame() {
    const gl = this.gl;
    if (this.active && this.ext) {
      gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.queries.push(this.active);
      this.active = null;
    }
    while (this.queries.length && gl.getQueryParameter(this.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.queries.shift()!;
      const disjoint = this.ext && gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) push(this.gpu, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6, 90);
      gl.deleteQuery(q);
    }
    // don't let a stalled pipeline pile queries up
    while (this.queries.length > 8) gl.deleteQuery(this.queries.shift()!);
  }

  /** Ignore everything until `until` (boot, deliberate hitches). */
  hold(until: number) {
    this.gpu.length = 0;
    this.gaps.length = 0;
    this.evalAt = until;
    this.stableSince = until;
  }

  /** Throw away the measurements (after a resize, a world change…). */
  reset(now: number) {
    this.gpu.length = 0;
    this.gaps.length = 0;
    this.evalAt = now + 1200;
  }

  /**
   * Once per rendered frame. `gap` = ms since the previous frame, `safe` = a
   * resize now wouldn't interrupt play. Returns a level to switch to right now.
   */
  update(now: number, gap: number, safe: boolean): number | null {
    if (gap > 0 && gap < 250) push(this.gaps, gap, 90);
    let severe = false;
    if (now >= this.evalAt && this.gaps.length >= 30) {
      this.evalAt = now + 1000;
      const interval = Math.max(6, pct(this.gaps, 0.5));
      const late = this.gaps.filter((g) => g > interval * 1.5).length / this.gaps.length;
      // GPU work overlaps the next frame's CPU work, so a frame only drops when the
      // GPU needs about the whole interval; readings are noisy on a busy machine,
      // so it takes actual late frames or a clearly saturated GPU to step down
      const g = this.gpu.length >= 20 ? pct(this.gpu, 0.75) : null;
      const key = (l: number) => `${this.world}|${l}`;
      if ((g !== null && g > interval * 0.95) || late > 0.06) {
        // too slow: down one step, two when it's bad
        const bad = (g !== null && g > interval * 1.3) || late > 0.2;
        severe = (g !== null && g > interval * 1.6) || late > 0.35;
        const target = Math.max(0, this.level - (bad ? 2 : 1));
        if (target !== this.level) {
          this.failed.set(key(this.level), now);
          this.pending = target;
        }
        this.stableSince = now;
      } else if (g !== null && this.level < this.maxLevel && this.pending === null && now - this.stableSince > 6000) {
        const up = this.level + 1;
        const failedAt = this.failed.get(key(up));
        const predicted = g * (cost(LEVELS[up]) / cost(LEVELS[this.level]));
        if (predicted < interval * 0.6 && (failedAt === undefined || now - failedAt > 60000)) this.pending = up;
      } else if (g === null && late === 0 && this.level < this.maxLevel && this.pending === null && now - this.stableSince > 20000) {
        // no GPU timer: creep up rarely, and a failure bans the level for this world
        const up = this.level + 1;
        if (!this.failed.has(key(up))) this.pending = up;
      }
      // remember a level that has held for a while
      if (this.pending === null && now - this.stableSince > 20000 && now - this.savedAt > 20000 && this.world) {
        this.savedAt = now;
        if (this.saved[this.world] !== this.level) {
          this.saved[this.world] = this.level;
          try {
            localStorage.setItem(STORE, JSON.stringify(this.saved));
          } catch {
            /* private mode */
          }
        }
      }
    }
    if (this.pending !== null && (safe || severe)) {
      const next = this.pending;
      this.pending = null;
      if (next === this.level) return null;
      this.level = next;
      this.stableSince = now;
      this.reset(now);
      return next;
    }
    return null;
  }
}

function push(a: number[], v: number, max: number) {
  a.push(v);
  if (a.length > max) a.shift();
}

function pct(a: number[], p: number) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
