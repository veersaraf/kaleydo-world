// Camera direction: Wii-style chase view during play, cinematic cuts in
// attract mode, a fly-in for intros and a push-in on the point winner.

import * as THREE from 'three';
import type { Match } from './match';
import { COURT } from './court';
import { clamp, damp, lerp, smooth, easeInOutCubic } from '../core/math';

export type CamMode = 'play' | 'attract' | 'menu' | 'intro' | 'versus';

interface Shot {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
  drift: THREE.Vector3;
}

const ATTRACT_SHOTS: Shot[] = [
  { pos: new THREE.Vector3(0, 5.6, 21.5), look: new THREE.Vector3(0, 0.6, -4), fov: 38, drift: new THREE.Vector3(1.5, 0, -1.2) },
  { pos: new THREE.Vector3(-17, 3.2, 3), look: new THREE.Vector3(0, 1, 0), fov: 36, drift: new THREE.Vector3(0, 0.4, -3) },
  { pos: new THREE.Vector3(9, 14, 20), look: new THREE.Vector3(0, 0, -2), fov: 42, drift: new THREE.Vector3(-4, -1, 0) },
  { pos: new THREE.Vector3(0, 1.4, 8), look: new THREE.Vector3(0, 1.3, -12), fov: 44, drift: new THREE.Vector3(0, 0.6, 1.5) },
  { pos: new THREE.Vector3(14, 6, -20), look: new THREE.Vector3(0, 0.5, 2), fov: 40, drift: new THREE.Vector3(-3, 0, 1) },
  { pos: new THREE.Vector3(0, 34, 0.01), look: new THREE.Vector3(0, 0, 0), fov: 46, drift: new THREE.Vector3(0, -4, 0) },
  { pos: new THREE.Vector3(-7.5, 1.1, 1.5), look: new THREE.Vector3(2, 1.2, -10), fov: 50, drift: new THREE.Vector3(0.4, 0.2, 0) },
];

export class CameraRig {
  cam: THREE.PerspectiveCamera;
  mode: CamMode = 'attract';
  private pos = new THREE.Vector3(0, 5.6, 21.5);
  private look = new THREE.Vector3(0, 0.6, -4);
  private fov = 38;
  private shake = 0;
  private shakeSeed = Math.random() * 100;
  private shotIdx = 0;
  private shotT = 0;
  private introT = 0;
  private followX = 0;
  aspect = 16 / 9;
  /** 0..1 blend towards a point-winner close-up */
  private winnerBlend = 0;
  /** true while this rig draws one half of a split screen */
  split = false;

  /** `side` = the team whose end this camera sits behind (1 = the far end, looking back) */
  constructor(public side: 0 | 1 = 0) {
    this.cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 1200);
  }

  kick(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  setMode(m: CamMode) {
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'intro') this.introT = 0;
    if (m === 'versus') this.shotT = 0;
    if (m === 'attract') {
      this.shotT = 0;
      this.shotIdx = (this.shotIdx + 1) % ATTRACT_SHOTS.length;
    }
  }

  /** hfov-preserving vertical fov for narrow screens */
  private fitFov(v: number) {
    // a split-screen half is tall and narrow by design: its shots are framed for ~0.9:1
    const ref = this.split ? 0.9 : 16 / 9;
    const minH = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(v) / 2) * ref);
    const a = this.aspect;
    if (a >= ref) return v;
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(minH / 2) / a));
  }

  private playTarget(m: Match | null, pos: THREE.Vector3, look: THREE.Vector3) {
    let px = 0;
    let bx = 0;
    // how far behind the usual spot the player stands: the camera backs up with them
    let deep = 0;
    const s = this.side === 1 ? -1 : 1;
    if (m) {
      const near = m.team(this.side);
      const hp = near.find((p) => p.human) ?? near[0];
      px = hp ? hp.x : 0;
      deep = hp ? clamp(Math.abs(hp.z) - (COURT.halfL + 1.6), 0, 5) : 0;
      const b = m.ballView(m.t, { x: 0, y: 0, z: 0 });
      bx = m.ball.holder ? m.ball.holder.x : b.x;
    }
    this.followX = px;
    if (this.split) {
      // half a screen is narrow: track the player closely, and sit low enough that
      // your own player stays whole at the bottom with the far player above the net
      pos.set(clamp(px * 0.8, -4.5, 4.5), 4.9, s * (COURT.halfL + 9.6));
      look.set(clamp(px * 0.45 + bx * 0.1, -3, 3), 0.8, s * -4);
      return 48;
    }
    // Switch Sports-style framing: higher and steeper, so your whole player stands in
    // the bottom of the frame (feet at ~88% height) and the far baseline sits a
    // third of the way down — more court to read, your own swing always in view
    pos.set(clamp(px * 0.38, -3, 3), 6.2, s * (COURT.halfL + 10.1 + deep));
    look.set(clamp(px * 0.18 + bx * 0.12, -2, 2), 0, s * (3.7 + deep));
    return 44;
  }

  /** the player to frame in 'versus' mode (tour intros) */
  versus: { x: number; z: number; team: number } | null = null;

  /** debug override: fixed camera */
  debug: { pos: [number, number, number]; look: [number, number, number]; fov: number } | null = null;

  update(m: Match | null, dt: number, t: number) {
    if (this.debug) {
      this.cam.position.set(...this.debug.pos);
      this.cam.lookAt(...this.debug.look);
      this.cam.fov = this.debug.fov;
      this.cam.aspect = this.aspect;
      this.cam.updateProjectionMatrix();
      return;
    }
    const tp = new THREE.Vector3();
    const tl = new THREE.Vector3();
    let fov = 38;
    let lambda = 3.2;

    if (this.mode === 'versus' && this.versus) {
      const p = this.versus;
      const f = p.team === 0 ? -1 : 1;
      tp.set(p.x + 1.15 * f, 1.5, p.z + f * 3.3);
      tl.set(p.x, 1.25, p.z);
      fov = 30;
      lambda = this.shotT++ === 0 ? 1000 : 5;
    } else if (this.mode === 'play' || this.mode === 'intro') {
      fov = this.playTarget(m, tp, tl);
      // point won: push in a little on the winner
      const dead = m && (m.state === 'dead' || m.state === 'over') && !m.resetKeepScore;
      this.winnerBlend = damp(this.winnerBlend, dead ? 1 : 0, dead ? 1.2 : 4, dt);
      if (m && this.winnerBlend > 0.001) {
        const w = m.team(m.pointWinner)[0];
        if (w) {
          const k = smooth(this.winnerBlend) * 0.35;
          tl.lerp(new THREE.Vector3(w.x, 1.1, w.z), k);
          fov = lerp(fov, 30, k);
        }
      }
      if (this.mode === 'intro') {
        this.introT += dt;
        const u = easeInOutCubic(clamp(this.introT / 3.0));
        const a = (1 - u) * 1.2;
        const s = this.side === 1 ? -1 : 1;
        const start = new THREE.Vector3(s * Math.sin(a) * 30, 22 - u * 10, s * (Math.cos(a) * 30 - 6));
        tp.lerp(start, 1 - u);
        tl.lerp(new THREE.Vector3(0, 0, s * -2), 1 - u);
        fov = lerp(48, fov, u);
        lambda = 40;
      }
    } else {
      // attract / menu: cinematic cuts with slow drift
      this.shotT += dt;
      const shotLen = this.mode === 'menu' ? 11 : 8.5;
      if (this.shotT > shotLen) {
        this.shotT = 0;
        this.shotIdx = (this.shotIdx + 1) % ATTRACT_SHOTS.length;
      }
      const s = ATTRACT_SHOTS[this.shotIdx];
      const u = this.shotT / shotLen;
      tp.copy(s.pos).addScaledVector(s.drift, u - 0.5);
      tl.copy(s.look);
      if (m && this.shotIdx === 6) {
        const b = m.ballView(m.t, { x: 0, y: 0, z: 0 });
        tl.lerp(new THREE.Vector3(b.x, b.y, b.z), 0.3);
      }
      fov = s.fov;
      lambda = this.shotT < 0.05 ? 1000 : 2;
    }

    this.pos.x = damp(this.pos.x, tp.x, lambda, dt);
    this.pos.y = damp(this.pos.y, tp.y, lambda, dt);
    this.pos.z = damp(this.pos.z, tp.z, lambda, dt);
    this.look.x = damp(this.look.x, tl.x, lambda * 1.3, dt);
    this.look.y = damp(this.look.y, tl.y, lambda * 1.3, dt);
    this.look.z = damp(this.look.z, tl.z, lambda * 1.3, dt);
    this.fov = damp(this.fov, fov, lambda, dt);
    if (lambda >= 1000) {
      this.pos.copy(tp);
      this.look.copy(tl);
      this.fov = fov;
    }

    // shake
    this.shake = Math.max(0, this.shake - dt * 2.8);
    const sh = this.shake * this.shake * 0.22;
    const n = (k: number) => Math.sin(t * 43 + k * 17.3 + this.shakeSeed) * 0.6 + Math.sin(t * 71 + k * 5.1) * 0.4;
    this.cam.position.set(this.pos.x + n(1) * sh, this.pos.y + n(2) * sh, this.pos.z);
    this.cam.lookAt(this.look.x + n(3) * sh * 0.4, this.look.y + n(4) * sh * 0.4, this.look.z);
    this.cam.fov = this.fitFov(this.fov);
    this.cam.aspect = this.aspect;
    this.cam.updateProjectionMatrix();
  }

  // ---- instant replay: a broadcast-style camera that tracks the ball from the side
  private rp = new THREE.Vector3();
  private rl = new THREE.Vector3();
  private rpInit = false;

  replayStart() {
    this.mode = 'menu';
    this.rpInit = false;
  }

  replayUpdate(ball: { x: number; y: number; z: number }, dt: number, side: number) {
    // courtside, inside the fence (clear of every world's stands)
    const tp = new THREE.Vector3(side * 8.1, 2.7 + ball.y * 0.2, ball.z * 0.6 + 2);
    const tl = new THREE.Vector3(ball.x * 0.5, 0.8 + ball.y * 0.5, ball.z * 0.9);
    if (!this.rpInit) {
      this.rp.copy(tp);
      this.rl.copy(tl);
      this.rpInit = true;
    }
    this.rp.x = damp(this.rp.x, tp.x, 2.5, dt);
    this.rp.y = damp(this.rp.y, tp.y, 2.5, dt);
    this.rp.z = damp(this.rp.z, tp.z, 2.5, dt);
    this.rl.x = damp(this.rl.x, tl.x, 5, dt);
    this.rl.y = damp(this.rl.y, tl.y, 5, dt);
    this.rl.z = damp(this.rl.z, tl.z, 5, dt);
    this.cam.position.copy(this.rp);
    this.cam.lookAt(this.rl);
    this.cam.fov = this.fitFov(40);
    this.cam.aspect = this.aspect;
    this.cam.updateProjectionMatrix();
  }

  /** Project a world point to normalised screen coords (0..1, y down). */
  project(p: { x: number; y: number; z: number }) {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.cam);
    return { x: (v.x + 1) / 2, y: (1 - v.y) / 2, behind: v.z > 1 };
  }

  get followPlayerX() {
    return this.followX;
  }
}
