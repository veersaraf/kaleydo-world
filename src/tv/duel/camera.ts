// Duel cameras: behind your fighter, a little off the sword shoulder, so you see
// your own blade and the opponent's windup and guard square on. The second
// camera is the same from the other end (split screen for two people). A fall
// cuts to the side to watch the drop; the end of a round looks at the winner.

import * as THREE from 'three';
import { ARENA, HAZARD_Y, fallY } from './arena';
import type { FighterState } from './types';
import type { DuelGame } from './game';
import { clamp, damp, easeInOutCubic } from '../core/math';

class View {
  cam = new THREE.PerspectiveCamera(48, 16 / 9, 0.05, 1200);
  pos = new THREE.Vector3(0, ARENA.top + 4, 9);
  look = new THREE.Vector3(0, ARENA.top + 1, 0);
  fov = 48;
  tp = new THREE.Vector3();
  tl = new THREE.Vector3();
  /** set = snap there this frame (a cut) */
  cut = true;
}

export class DuelCamera {
  views = [new View(), new View()];
  /** each view's width / height */
  aspect = 16 / 9;
  split = false;
  private shake = 0;
  /** who fell (for the fall shot) and which side to watch it from */
  private fallSide = 1;

  get cams() {
    return this.views.map((v) => v.cam);
  }

  kick(a: number) {
    this.shake = Math.min(1, this.shake + a);
  }

  /** Jump straight to the right place (a new round, a new game). */
  snap() {
    for (const v of this.views) v.cut = true;
  }

  /** Behind fighter i, off the sword shoulder, looking past them at the opponent. */
  private fightView(v: View, g: DuelGame, i: number, push = 0) {
    const me = g.fighters[i];
    const them = g.fighters[1 - i];
    const back = me.facing; // fighter 0 faces −z, so behind them is +z
    const right = me.facing; // …and their right is +x
    const d = 3.25 - push;
    v.tp.set(me.x - right * 0.72 * me.handed, ARENA.top + 1.85, me.z + back * d);
    v.tl.set(them.x * 0.8 + me.x * 0.2 + right * 0.12 * me.handed, ARENA.top + 1.05, them.z * 0.72 + me.z * 0.28);
    v.fov = 48;
  }

  update(g: DuelGame, dt: number, t: number) {
    const n = this.split ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const v = this.views[i];
      const since = g.t - g.stateT0;
      let lambda = 5;
      switch (g.state) {
        case 'intro': {
          // swing round from high over the water to behind your fighter
          const u = easeInOutCubic(clamp(since / 2.4));
          this.fightView(v, g, i);
          const a = (1 - u) * 1.3 * (i === 0 ? 1 : -1);
          const r = 7 * (1 - u);
          v.tp.set(v.tp.x * u + Math.sin(a) * r, v.tp.y + (1 - u) * 3.5, v.tp.z * u + Math.cos(a) * r * (i === 0 ? 1 : -1));
          v.tl.set(v.tl.x * u, v.tl.y - (1 - u) * 0.4, v.tl.z * u);
          v.fov = 48 + (1 - u) * 8;
          lambda = 1000;
          break;
        }
        case 'ready':
          // a slow push in while "Ready…"
          this.fightView(v, g, i, clamp(since / 1.2) * 0.25);
          lambda = 3;
          break;
        case 'fight':
          this.fightView(v, g, i, 0.25);
          lambda = 5;
          break;
        case 'fall': {
          // from the side, watching the drop and the splash
          const f = g.fighters.find((q) => q.phase === 'fall') ?? g.fighters[0];
          if (since < 0.02 || v.cut) this.fallSide = f.x >= 0 ? 1 : -1;
          const s = this.fallSide * (i === 0 ? 1 : -1);
          const zc = f.z * 0.55;
          v.tp.set(s * 6.2, ARENA.top + 1.4 - clamp(since / 1.2) * 0.9, zc + f.facing * 1.2);
          // follow them down, but not below the surface they land in
          v.tl.set(f.x * 0.5, Math.max(HAZARD_Y + 0.4, fallY(f.t) + 0.8), f.z);
          v.fov = 44;
          lambda = since < 0.05 ? 1000 : 4;
          break;
        }
        case 'round-end':
        case 'over': {
          // the winner (or both, for a draw), from in front
          const w = winner(g);
          const f = w ?? g.fighters[i];
          const k = clamp(since / 3);
          const side = f.facing * (i === 0 ? 1 : -1);
          v.tp.set(f.x + side * (1.3 + (g.state === 'over' ? Math.sin(t * 0.4) * 0.8 : 0)), ARENA.top + 1.45 - k * 0.1, f.z - f.facing * (3.4 - k * 0.6));
          v.tl.set(f.x, ARENA.top + 1.1, f.z);
          v.fov = 40;
          lambda = since < 0.05 ? 1000 : 2.5;
          break;
        }
      }
      if (v.cut || lambda >= 1000) {
        v.pos.copy(v.tp);
        v.look.copy(v.tl);
        v.cut = false;
      } else {
        v.pos.x = damp(v.pos.x, v.tp.x, lambda, dt);
        v.pos.y = damp(v.pos.y, v.tp.y, lambda, dt);
        v.pos.z = damp(v.pos.z, v.tp.z, lambda, dt);
        v.look.x = damp(v.look.x, v.tl.x, lambda * 1.3, dt);
        v.look.y = damp(v.look.y, v.tl.y, lambda * 1.3, dt);
        v.look.z = damp(v.look.z, v.tl.z, lambda * 1.3, dt);
      }
      this.aim(v, t);
    }
    this.shake = Math.max(0, this.shake - dt * 3);
  }

  private aim(v: View, t: number) {
    const sh = this.shake * this.shake * 0.07;
    const n = (k: number) => Math.sin(t * 51 + k * 13.1) * 0.6 + Math.sin(t * 79 + k * 3.7) * 0.4;
    v.cam.position.set(v.pos.x + n(1) * sh, v.pos.y + n(2) * sh, v.pos.z);
    v.cam.lookAt(v.look.x + n(3) * sh * 0.3, v.look.y + n(4) * sh * 0.3, v.look.z);
    // keep the horizontal field of view on narrow screens (and in split halves)
    const a = this.aspect;
    v.cam.fov = a >= 16 / 9 ? v.fov : THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(THREE.MathUtils.degToRad(v.fov) / 2) * (16 / 9)) / a));
    v.cam.aspect = a;
    v.cam.updateProjectionMatrix();
  }
}

/** The fighter celebrating (null while nobody is). */
function winner(g: DuelGame): FighterState | null {
  return g.fighters.find((f) => f.phase === 'win') ?? null;
}
