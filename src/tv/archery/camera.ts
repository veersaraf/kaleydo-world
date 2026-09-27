// Archery cameras: behind the archer, out past the draw shoulder, swinging round
// with the aim and zooming in as the string comes back (aimcam.ts), then behind
// the arrow as it flies, then a close-up of the target it hit. Between turns it
// settles back behind the next archer.

import * as THREE from 'three';
import { RANGE } from './range';
import type { ArcheryGame } from './game';
import type { RangeView } from './types';
import { aimCamera, newAimCam } from './aimcam';
import { clamp, damp, easeInOutCubic } from '../core/math';

export class ArcheryCamera {
  cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 1200);
  aspect = 16 / 9;
  private pos = new THREE.Vector3(0, 3, RANGE.lineZ + 6);
  private look = new THREE.Vector3(0, RANGE.eyeY, 0);
  private fov = 40;
  private tp = new THREE.Vector3();
  private tl = new THREE.Vector3();
  private shake = 0;
  /** the arrow being followed, and where it came to rest */
  private rest: THREE.Vector3 | null = null;
  private ac = newAimCam();
  /** depth of field: on the target as you draw (the archer softens in the corner), on the arrow in the close-up */
  focus: number | null = null;
  aperture = 1;
  /** the push-in while drawing, eased */
  private zoom = 0;

  kick(a: number) {
    this.shake = Math.min(1, this.shake + a);
  }

  /** the target the archer is shooting at */
  private target(g: ArcheryGame) {
    return g.mainTarget() ?? { x: 0, y: 1.4, z: 0, r: RANGE.faceR };
  }

  /** Behind the archer, down the aim, zoomed `zoom` 0..1 (aimcam.ts). */
  private aimView(g: ArcheryGame, zoom: number) {
    const c = aimCamera(g.archer, zoom, this.ac);
    this.tp.set(c.x, c.y, c.z);
    this.tl.set(c.lx, c.ly, c.lz);
    this.fov = c.fov;
  }

  /** `v` is this frame's view (the app reads it once: reading clears its effects). */
  update(g: ArcheryGame, v: RangeView, dt: number, t: number) {
    const tp = this.tp,
      tl = this.tl;
    let lambda = 4;
    const since = g.t - g.stateT0;
    switch (g.state) {
      case 'intro': {
        // from high over the targets, back along the range to behind the archer
        const u = easeInOutCubic(clamp(since / 2.6));
        this.zoom = 0;
        this.aimView(g, 0);
        const f = this.target(g);
        tp.set(tp.x * u + (1 - u) * 5, tp.y + (1 - u) * 6, tp.z * u + (1 - u) * (f.z + 6));
        this.fov += (1 - u) * 8;
        lambda = 1000;
        break;
      }
      case 'aim':
      case 'next': {
        this.rest = null;
        // Resort-style: the view pushes in as the string comes back, and eases out after
        const drawing = g.state === 'aim' && (g.archer.phase === 'draw' || g.archer.phase === 'hold');
        this.zoom = damp(this.zoom, drawing ? clamp(g.archer.draw) : 0, drawing ? 3.5 : 2, dt);
        this.aimView(g, this.zoom);
        lambda = g.state === 'aim' ? 6 : 2.5;
        break;
      }
      case 'flight':
      case 'result': {
        const arrow = g.shotArrow;
        void v;
        if (arrow && arrow.state === 'flying') {
          // just behind and above the arrow, looking where it's going
          tp.set(arrow.x - arrow.dx * 2.2 + 0.25, arrow.y - arrow.dy * 2.2 + 0.45, arrow.z - arrow.dz * 2.2);
          tl.set(arrow.x + arrow.dx * 6, arrow.y + arrow.dy * 6, arrow.z + arrow.dz * 6);
          this.fov = 44;
          lambda = 9;
        } else if (arrow) {
          // where it landed, from in front and a little to the side
          (this.rest ??= new THREE.Vector3()).set(arrow.x, arrow.y, arrow.z);
          tp.set(arrow.x + 0.9, arrow.y + 0.35, arrow.z + 3.2);
          tl.copy(this.rest);
          this.fov = 34;
          lambda = 5;
        }
        break;
      }
      case 'over':
        tp.set(4.5, 3.4, RANGE.lineZ + 4);
        tl.set(0, 1.4, RANGE.lineZ - 8);
        this.fov = 46;
        lambda = 1.2;
        break;
    }
    if (lambda >= 1000) {
      this.pos.copy(tp);
      this.look.copy(tl);
    } else {
      this.pos.x = damp(this.pos.x, tp.x, lambda, dt);
      this.pos.y = damp(this.pos.y, tp.y, lambda, dt);
      this.pos.z = damp(this.pos.z, tp.z, lambda, dt);
      this.look.x = damp(this.look.x, tl.x, lambda * 1.3, dt);
      this.look.y = damp(this.look.y, tl.y, lambda * 1.3, dt);
      this.look.z = damp(this.look.z, tl.z, lambda * 1.3, dt);
    }
    const main = g.mainTarget();
    if (g.state === 'result' && this.rest) {
      this.focus = this.pos.distanceTo(this.rest);
      this.aperture = 1.2;
    } else if (g.state === 'aim' && this.zoom > 0.05 && main) {
      this.focus = Math.hypot(main.x - this.pos.x, main.y - this.pos.y, main.z - this.pos.z);
      this.aperture = 0.9 * this.zoom;
    } else this.focus = null;
    this.shake = Math.max(0, this.shake - dt * 3);
    const sh = this.shake * this.shake * 0.05;
    const n = (k: number) => Math.sin(t * 51 + k * 13.1) * 0.6 + Math.sin(t * 79 + k * 3.7) * 0.4;
    this.cam.position.set(this.pos.x + n(1) * sh, this.pos.y + n(2) * sh, this.pos.z);
    this.cam.lookAt(this.look.x + n(3) * sh * 0.3, this.look.y + n(4) * sh * 0.3, this.look.z);
    const a = this.aspect;
    this.cam.fov = a >= 16 / 9 ? this.fov : THREE.MathUtils.radToDeg(2 * Math.atan((Math.tan(THREE.MathUtils.degToRad(this.fov) / 2) * (16 / 9)) / a));
    this.cam.aspect = a;
    this.cam.updateProjectionMatrix();
  }
}
