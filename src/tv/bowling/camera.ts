// Bowling camera: behind the bowler while aiming, chasing the ball down the lane,
// then a low view of the pin deck for the crash — Wii Sports-style.

import * as THREE from 'three';
import { FOUL_Z, HEAD_Z } from './lane';
import type { BowlingGame } from './game';
import { clamp, damp, easeInOutCubic } from '../core/math';

export class BowlCamera {
  cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 1200);
  aspect = 16 / 9;
  private pos = new THREE.Vector3(0, 6, FOUL_Z + 14);
  private look = new THREE.Vector3(0, 0.5, HEAD_Z);
  private fov = 50;
  private shake = 0;
  private tp = new THREE.Vector3();
  private tl = new THREE.Vector3();
  /** the ball's lane z when the chase switched to the pin view */
  private pinCut = false;

  kick(a: number) {
    this.shake = Math.min(1, this.shake + a);
  }

  /** A little over the bowling shoulder and high: the whole swing at the bottom of
   *  the frame, the aim line and the pins beside and over the bowler (straight
   *  behind, the head hides them). Sets tp/tl. */
  private aimView(b: BowlingGame['body']) {
    const z = Math.min(b.z, FOUL_Z + 3.9);
    this.tp.set(b.x + 0.32 * b.handed, 2.75, z + 4.4);
    this.tl.set(b.x * 0.3 + 0.12 * b.handed, 0.2, z - 13);
  }

  update(g: BowlingGame, dt: number, t: number) {
    const tp = this.tp,
      tl = this.tl;
    let fov = 50;
    let lambda = 3.5;
    const b = g.body;
    const ball = g.phys.view.ball;
    switch (g.state) {
      case 'intro': {
        // from the pins, pull back up the lane and settle over the bowler's shoulder
        // — exactly where aiming starts, so nothing jumps when the turn begins
        const u = easeInOutCubic(clamp((g.t - g.stateT0) / 2.6));
        this.aimView(b);
        const a = (1 - u) * 0.9;
        tp.set(tp.x * u + Math.sin(a) * 2.2, tp.y + (1 - u) * 0.6, tp.z + (HEAD_Z + 6 - tp.z) * (1 - u));
        tl.set(tl.x * u, tl.y + (1 - u) * 0.1, tl.z + (HEAD_Z - 0.4 - tl.z) * (1 - u));
        fov = 42 - (1 - u) * 6;
        lambda = 1000;
        break;
      }
      case 'ready':
      case 'approach':
      case 'sweep':
        this.aimView(b);
        fov = 42;
        lambda = g.state === 'approach' ? 2.6 : 4;
        this.pinCut = false;
        break;
      case 'lane':
      case 'pins':
      case 'result': {
        const near = ball.visible && ball.z < HEAD_Z + 6;
        if (near) this.pinCut = true;
        if (!this.pinCut && ball.visible) {
          // chase the ball
          tp.set(ball.x * 0.6, 1.25, ball.z + 3.6);
          tl.set(ball.x * 0.5, 0.18, ball.z - 5);
          fov = 46;
          lambda = 5;
        } else {
          // the pin deck, low and a little to the side; a slow push in on the result
          const k = g.state === 'result' ? clamp((g.t - g.stateT0) / 2) : 0;
          tp.set(0.55, 0.95 - k * 0.15, HEAD_Z + 3.4 - k * 0.9);
          tl.set(0, 0.22, HEAD_Z - 0.45);
          fov = 40;
          lambda = this.pinCut && g.state !== 'result' ? 7 : 2.5;
        }
        break;
      }
      case 'over':
        tp.set(-3.5, 3.2, FOUL_Z + 5.5);
        tl.set(0, 0.6, HEAD_Z + 4);
        fov = 52;
        lambda = 1.2;
        break;
    }
    if (lambda >= 1000) {
      this.pos.copy(tp);
      this.look.copy(tl);
      this.fov = fov;
    } else {
      this.pos.x = damp(this.pos.x, tp.x, lambda, dt);
      this.pos.y = damp(this.pos.y, tp.y, lambda, dt);
      this.pos.z = damp(this.pos.z, tp.z, lambda, dt);
      this.look.x = damp(this.look.x, tl.x, lambda * 1.3, dt);
      this.look.y = damp(this.look.y, tl.y, lambda * 1.3, dt);
      this.look.z = damp(this.look.z, tl.z, lambda * 1.3, dt);
      this.fov = damp(this.fov, fov, lambda, dt);
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sh = this.shake * this.shake * 0.08;
    const n = (k: number) => Math.sin(t * 47 + k * 13.1) * 0.6 + Math.sin(t * 73 + k * 3.7) * 0.4;
    this.cam.position.set(this.pos.x + n(1) * sh, this.pos.y + n(2) * sh, this.pos.z);
    this.cam.lookAt(this.look.x + n(3) * sh * 0.3, this.look.y + n(4) * sh * 0.3, this.look.z);
    // keep the horizontal field of view on narrow screens
    const a = this.aspect;
    this.cam.fov = a >= 16 / 9 ? this.fov : THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(THREE.MathUtils.degToRad(this.fov) / 2) * (16 / 9)) / a));
    this.cam.aspect = a;
    this.cam.updateProjectionMatrix();
  }
}
