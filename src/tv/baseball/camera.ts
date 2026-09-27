// Baseball cameras. Between pitches and while the ball comes in: behind the
// catcher, a touch to the side away from the batter, looking out at the pitcher
// (Wii Sports' batting view). The intro cranes in from high over centre field.
// After contact the view follows the ball from high behind home plate, like a
// broadcast's — the whole park and the ball's arc in frame, zooming as it goes
// out; a home run cuts to the stands to watch it come down among the crowd,
// then to the batter celebrating. A new hitter gets a portrait as they step in.

import * as THREE from 'three';
import { FIELD } from './field';
import type { BattedBall, BatterState, FieldBall, FieldView, Pitch } from './types';
import { clamp, damp, easeInOutCubic } from '../core/math';

/** What the camera reads from the game (BaseballGame has all of it). */
export interface CamGame {
  state: 'intro' | 'ready' | 'windup' | 'pitch' | 'flight' | 'result' | 'switch' | 'over';
  /** game time, and seconds in this state */
  t: number;
  since: number;
  hit: BattedBall | null;
  /** game time of the last contact */
  hitT: number;
  pitch: Pitch | null;
  batter: BatterState;
  /** how the batted ball's flight ends ('back': fouled straight back, over the catcher) */
  battedFlight?: { end: string } | null;
}

type Shot = 'intro' | 'bat' | 'portrait' | 'chase' | 'stands' | 'hero' | 'over' | 'replay';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export class BaseballCamera {
  cam = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 1500);
  aspect = 16 / 9;
  private pos = V(0, 2, FIELD.homeZ + 5);
  private look = V(0, 1.2, 0);
  private fov = 34;
  private tp = V();
  private tl = V();
  private shake = 0;
  private shot: Shot = 'intro';
  private shotT = 0;
  /** where the chase camera started (it rises and pushes out a little over the flight); a cut straight to it after the hero shot */
  private chaseFrom = V();
  private chaseCut = false;
  /** depth of field for the close moments (the hero shot, the ball dropping into the stands) */
  focus: number | null = null;
  aperture = 1;

  kick(a: number) {
    this.shake = Math.min(1, this.shake + a);
  }

  /** Cut on the next update (a new pitch after a flight, say) rather than glide there. */
  snap() {
    this.shotT = -1;
  }

  /** Behind the catcher, looking out at the pitcher; the batter on one side. */
  private batView(b: BatterState) {
    const s = b.handed;
    this.tp.set(0.3 * s, 2.02, FIELD.homeZ + 4.7);
    this.tl.set(0.06 * s, 1.18, 2.4);
    this.fov = 33;
  }

  /** The new hitter as they step in: from in front of them, out towards the mound. */
  private portrait(b: BatterState, u: number) {
    const s = b.handed;
    this.tp.set(b.x + (2.3 + u * 0.3) * s, 1.42 + u * 0.08, b.z - 1.55 - u * 0.25);
    this.tl.set(b.x + 0.12 * s, 1.18, b.z + 0.05);
    this.fov = 30;
  }

  /** `v` is this frame's view (the app reads it once: reading clears its effects). */
  update(g: CamGame, v: FieldView, dt: number, t: number) {
    const tp = this.tp,
      tl = this.tl;
    const b = g.batter;
    const hit = g.hit;
    const tau = g.t - g.hitT;
    const flying = hit && (g.state === 'flight' || (g.state === 'result' && tau < 12));
    // which shot
    let shot: Shot = 'bat';
    if (g.state === 'intro') shot = 'intro';
    else if (g.state === 'over') shot = 'over';
    else if (g.state === 'switch') shot = 'portrait';
    else if (flying && hit) {
      if (hit.homeRun && !hit.foul) {
        // a no-doubter: first the batter admiring it (the bat flip), then after the ball
        const down = hit.hang;
        const noDoubt = hit.sweet || hit.distance >= 132;
        shot = noDoubt && tau < 1.1 ? 'hero' : tau < down - 0.75 ? 'chase' : 'stands';
      } else if (g.battedFlight?.end === 'back') shot = 'bat';
      else shot = g.state === 'flight' ? 'chase' : 'bat';
    }
    // a strike / a foul: stay (or go back) behind the catcher for the next pitch
    const cut = shot !== this.shot && (shot === 'stands' || shot === 'hero' || shot === 'portrait' || (shot === 'chase' && this.shot === 'hero') || (shot === 'bat' && this.shot !== 'intro' && this.shot !== 'portrait'));
    if (shot !== this.shot || this.shotT < 0) {
      if (shot === 'chase') {
        this.chaseFrom.copy(this.pos);
        this.chaseCut = this.shot === 'hero';
      }
      this.shotT = 0;
    }
    const snap = cut || this.shotT === 0 && this.shot === shot;
    this.shot = shot;
    this.shotT += dt;
    let lambda = 5;
    this.focus = null;
    switch (shot) {
      case 'intro': {
        // a crane: from high over centre field, round and down to behind the catcher
        const u = easeInOutCubic(clamp(g.since / 2.6));
        this.batView(b);
        const end = tp.clone(),
          endL = tl.clone();
        const p0 = V(-7.5, 13.5, -23),
          p1 = V(6.5, 9.5, 3.5);
        const w0 = (1 - u) * (1 - u),
          w1 = 2 * u * (1 - u),
          w2 = u * u;
        tp.set(p0.x * w0 + p1.x * w1 + end.x * w2, p0.y * w0 + p1.y * w1 + end.y * w2, p0.z * w0 + p1.z * w1 + end.z * w2);
        tl.set(endL.x * u, 0.4 * (1 - u) + endL.y * u, FIELD.homeZ - 3 * (1 - u) + endL.z * u);
        this.fov = 44 - 11 * u;
        lambda = 1000;
        break;
      }
      case 'portrait': {
        this.portrait(b, clamp(g.since / 2));
        lambda = this.shotT < 0.05 ? 1000 : 3;
        break;
      }
      case 'bat':
        this.batView(b);
        lambda = 3.2;
        break;
      case 'chase': {
        // from high behind home plate, over the flight: it rises and leans out a
        // little after the ball, and zooms as the ball goes deep
        const ball = v.ball;
        const u = this.chaseCut ? 1 : clamp(this.shotT / 0.45);
        const high = V(0.35 * b.handed, 5.4, FIELD.homeZ + 8.5);
        if (hit) high.x += (hit.landX - high.x) * 0.12;
        tp.lerpVectors(this.chaseFrom, high, easeInOutCubic(u));
        tl.set(ball.x, Math.max(0.5, ball.y), ball.z);
        // lead towards where it's going to come down
        if (hit) tl.lerp(V(hit.landX, Math.max(1, hit.landY), hit.landZ), 0.18);
        const d = tp.distanceTo(tl);
        this.fov = clamp(1500 / (d + 18), 22, 46);
        lambda = u < 1 ? 12 : 6;
        break;
      }
      case 'stands': {
        // in the park in front of where it comes down, looking up at the crowd
        if (!hit) break;
        const dx = hit.landX,
          dz = hit.landZ - FIELD.homeZ;
        const r = Math.hypot(dx, dz) || 1;
        const ux = dx / r,
          uz = dz / r;
        const side = ux >= 0 ? 1 : -1;
        // up at head height over the fence, off to one side, a little way in front
        tp.set(hit.landX - ux * 8.5 - uz * 2.4 * side, 3.6 + Math.max(0, hit.landY) * 0.35, hit.landZ - uz * 8.5 + ux * 2.4 * side);
        tl.set(hit.landX - ux * 0.8, Math.max(1.4, hit.landY + 0.9), hit.landZ - uz * 0.8);
        // the ball as it drops in: keep it in frame
        const ball = v.ball;
        if (ball.phase === 'play') tl.lerp(V(ball.x, ball.y, ball.z), 0.3);
        this.fov = 42;
        // a slow push in as it comes down
        const push = Math.min(1, this.shotT / 2.2);
        tp.lerp(tl, 0.12 * push);
        lambda = this.shotT < 0.05 ? 1000 : 5;
        this.focus = tp.distanceTo(V(hit.landX, hit.landY, hit.landZ));
        this.aperture = 0.45;
        break;
      }
      case 'hero': {
        // the batter, from out in front, celebrating
        const s = b.handed;
        tp.set(b.x + 1.25 * s, 1.5, b.z - 3.3);
        tl.set(b.x + 0.1 * s, 1.28, b.z);
        this.fov = 32;
        lambda = this.shotT < 0.05 ? 1000 : 2;
        this.focus = tp.distanceTo(tl);
        this.aperture = 1.2;
        break;
      }
      case 'over': {
        const a = t * 0.12;
        tp.set(Math.sin(a) * 24, 10, 2 + Math.cos(a) * 24);
        tl.set(0, 0.8, 1);
        this.fov = 44;
        lambda = this.shotT < 0.05 ? 1.5 : 1.2;
        break;
      }
    }
    this.apply(lambda >= 1000 || snap ? 1000 : lambda, dt, t);
  }

  /**
   * The home-run replay: side-on at the plate, low, from out in front of the
   * batter, drifting round as the bat comes through (`u` 0..1 over the replay);
   * the view follows the ball away after the crack.
   */
  replay(b: BatterState, ball: FieldBall, contact: { x: number; y: number; z: number }, u: number, dt: number, t: number) {
    const s = b.handed;
    const first = this.shot !== 'replay';
    this.shot = 'replay';
    this.shotT = first ? 0 : this.shotT + dt;
    const e = easeInOutCubic(clamp(u));
    this.tp.set(contact.x + (2.5 - 0.9 * e) * s, 0.95 + 0.25 * e, contact.z - 1.0 - 1.5 * e);
    this.tl.set(contact.x - 0.35 * s, contact.y + 0.28, contact.z + 0.15);
    if (ball.phase === 'play') this.tl.lerp(V(ball.x, ball.y, ball.z), clamp((u - 0.55) * 1.6) * 0.8);
    this.fov = 30;
    this.focus = this.tp.distanceTo(V(contact.x, contact.y, contact.z));
    this.aperture = 1.3;
    this.apply(first ? 1000 : 6, dt, t);
  }

  private apply(lambda: number, dt: number, t: number) {
    const tp = this.tp,
      tl = this.tl;
    if (lambda >= 1000) {
      this.pos.copy(tp);
      this.look.copy(tl);
    } else {
      const lp = lambda,
        ll = lambda * 1.4;
      this.pos.set(damp(this.pos.x, tp.x, lp, dt), damp(this.pos.y, tp.y, lp, dt), damp(this.pos.z, tp.z, lp, dt));
      this.look.set(damp(this.look.x, tl.x, ll, dt), damp(this.look.y, tl.y, ll, dt), damp(this.look.z, tl.z, ll, dt));
    }
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const sh = this.shake * this.shake * 0.06;
    const n = (k: number) => Math.sin(t * 53 + k * 13.1) * 0.6 + Math.sin(t * 81 + k * 3.7) * 0.4;
    this.cam.position.set(this.pos.x + n(1) * sh, this.pos.y + n(2) * sh, this.pos.z);
    this.cam.lookAt(this.look.x + n(3) * sh * 0.4, this.look.y + n(4) * sh * 0.4, this.look.z);
    const a = this.aspect;
    this.cam.fov = a >= 16 / 9 ? this.fov : THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(THREE.MathUtils.degToRad(this.fov) / 2) * (16 / 9)) / a));
    this.cam.aspect = a;
    this.cam.updateProjectionMatrix();
  }
}
