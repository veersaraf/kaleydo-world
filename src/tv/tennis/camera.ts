// Camera direction: Wii-style chase view during play, cinematic cuts in
// attract mode, a fly-in for intros and a push-in on the point winner.

import * as THREE from 'three';
import type { Match } from './match';
import { COURT } from './court';
import { clamp, damp, lerp, smooth, easeInOutCubic, type V3 } from '../core/math';

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
  private lastSmash: CameraRig['smash'] = null;
  /** true while this rig draws one half of a split screen */
  split = false;
  /**
   * A smash chance being staged (set by the app every frame, null when none):
   * the camera swings low behind the smasher and looks up at the ball against
   * the sky, then lets the ball rocket away from it.
   */
  smash: { team: number; x: number; z: number; fh: number; cx: number; cy: number; cz: number; after: number; lx?: number; lz?: number } | null = null;
  private smashW = 0;
  /** 0 → 1 once the smash is struck: the camera rises to watch it land */
  private afterW = 0;
  // scratch (update runs every frame: nothing in it makes a vector)
  private tp = new THREE.Vector3();
  private tl = new THREE.Vector3();
  private sp = new THREE.Vector3();
  private sl = new THREE.Vector3();
  private v1 = new THREE.Vector3();
  private ball: V3 = { x: 0, y: 0, z: 0 };
  private proj = new THREE.Vector3();
  /** what the projection matrix was last built for */
  private projFov = NaN;
  private projAspect = NaN;

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

  private playTarget(m: Match | null, pos: THREE.Vector3, look: THREE.Vector3, ball: V3 | undefined) {
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
      const b = ball ?? m.ballView(m.t, this.ball);
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

  /** `ball`: where the match draws the ball this frame, if the caller has it already */
  update(m: Match | null, dt: number, t: number, ball?: V3) {
    if (this.debug) {
      this.cam.position.set(...this.debug.pos);
      this.cam.lookAt(...this.debug.look);
      this.setLens(this.debug.fov, this.aspect);
      return;
    }
    const tp = this.tp.set(0, 0, 0);
    const tl = this.tl.set(0, 0, 0);
    let fov = 38;
    let lambda = 3.2;

    if (this.mode === 'versus' && this.versus) {
      const p = this.versus;
      const f = p.team === 0 ? -1 : 1;
      tp.set(p.x + 1.15 * f, 1.5, p.z + f * 3.3);
      tl.set(p.x, 1.4, p.z);
      fov = 30;
      lambda = this.shotT++ === 0 ? 1000 : 5;
    } else if (this.mode === 'play' || this.mode === 'intro') {
      fov = this.playTarget(m, tp, tl, ball);
      // point won: push in a little on the winner
      const dead = m && (m.state === 'dead' || m.state === 'over') && !m.resetKeepScore;
      this.winnerBlend = damp(this.winnerBlend, dead ? 1 : 0, dead ? 1.2 : 4, dt);
      if (m && this.winnerBlend > 0.001) {
        const w = m.team(m.pointWinner)[0];
        if (w) {
          const k = smooth(this.winnerBlend) * 0.35;
          tl.lerp(this.v1.set(w.x, 1.1, w.z), k);
          fov = lerp(fov, 30, k);
        }
      }
      // a smash chance on this side: low behind the player, looking up at the ball
      const sm = this.smash && this.smash.team === this.side && !this.split ? this.smash : null;
      this.smashW = damp(this.smashW, sm ? 1 : 0, sm ? 3.2 : 2.2, dt);
      if (sm) this.lastSmash = sm;
      const ls = this.lastSmash;
      if (m && ls && this.smashW > 0.002) {
        const s = this.side === 1 ? -1 : 1;
        const b = ball ?? m.ballView(m.t, this.ball);
        const k = smooth(this.smashW);
        this.afterW = damp(this.afterW, ls.after > 0 ? 1 : 0, ls.after > 0 ? 5 : 30, dt);
        const a = smooth(this.afterW);
        // the build-up: low behind the player, off the shoulder away from the racket,
        // looking up the path of the falling ball (the player in the bottom of the frame)
        const sp = this.sp.set(ls.x - ls.fh * 1.5, 1.45, ls.z + s * 4.6);
        const sl = this.sl.set(lerp(ls.cx, b.x, 0.42), lerp(ls.cy + 0.2, Math.min(b.y, 9), 0.42), lerp(ls.cz, b.z, 0.42));
        // struck: up over the shoulder to watch it land
        if (a > 0.001 && ls.lx !== undefined && ls.lz !== undefined) {
          sp.lerp(this.v1.set(ls.x - ls.fh * 2.4, 3.6, ls.z + s * 6.2), a);
          sl.lerp(this.v1.set(lerp(ls.lx, b.x, 0.3), 0.6, lerp(ls.lz, b.z, 0.3)), a);
        }
        tp.lerp(sp, k);
        tl.lerp(sl, k);
        fov = lerp(fov, lerp(58, 38, a), k);
        lambda = Math.max(lambda, lerp(4.5, 6, a));
      }
      if (this.mode === 'intro') {
        this.introT += dt;
        const u = easeInOutCubic(clamp(this.introT / 3.0));
        const a = (1 - u) * 1.2;
        const s = this.side === 1 ? -1 : 1;
        tp.lerp(this.v1.set(s * Math.sin(a) * 30, 22 - u * 10, s * (Math.cos(a) * 30 - 6)), 1 - u);
        tl.lerp(this.v1.set(0, 0, s * -2), 1 - u);
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
        const b = ball ?? m.ballView(m.t, this.ball);
        tl.lerp(this.v1.set(b.x, b.y, b.z), 0.3);
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
    this.cam.position.set(this.pos.x + this.jolt(t, 1) * sh, this.pos.y + this.jolt(t, 2) * sh, this.pos.z);
    this.cam.lookAt(this.look.x + this.jolt(t, 3) * sh * 0.4, this.look.y + this.jolt(t, 4) * sh * 0.4, this.look.z);
    this.setLens(this.fitFov(this.fov), this.aspect);
  }

  private jolt(t: number, k: number) {
    return Math.sin(t * 43 + k * 17.3 + this.shakeSeed) * 0.6 + Math.sin(t * 71 + k * 5.1) * 0.4;
  }

  /** the projection matrix is rebuilt only when the lens changed (a frame with the same fov and aspect keeps it) */
  private setLens(fov: number, aspect: number) {
    const cam = this.cam;
    cam.fov = fov;
    cam.aspect = aspect;
    if (fov !== this.projFov || aspect !== this.projAspect) {
      this.projFov = fov;
      this.projAspect = aspect;
      cam.updateProjectionMatrix();
    }
  }

  // ---- instant replay: a broadcast-style camera that tracks the ball from the side
  private rp = new THREE.Vector3();
  private rl = new THREE.Vector3();
  private rpInit = false;

  replayStart() {
    this.mode = 'menu';
    this.rpInit = false;
  }

  replayUpdate(ball: { x: number; y: number; z: number }, dt: number, side: number, focus?: { x: number; y: number; z: number; w: number; fwd: number }) {
    // courtside, inside the fence (clear of every world's stands)
    const tp = new THREE.Vector3(side * 8.1, 2.7 + ball.y * 0.2, ball.z * 0.6 + 2);
    const tl = new THREE.Vector3(ball.x * 0.5, 0.8 + ball.y * 0.5, ball.z * 0.9);
    if (focus && focus.w > 0) {
      // a smash: low and close beside the smasher, looking up at the contact
      const k = smooth(focus.w);
      tp.lerp(new THREE.Vector3(focus.x + side * 3.4, 0.7, focus.z - focus.fwd * 2.2), k);
      tl.lerp(new THREE.Vector3(lerp(focus.x, ball.x, 0.35), lerp(focus.y, ball.y, 0.35), lerp(focus.z, ball.z, 0.35)), k);
    }
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
    this.setLens(this.fitFov(focus && focus.w > 0 ? lerp(40, 50, smooth(focus.w)) : 40), this.aspect);
  }

  /** Project a world point to normalised screen coords (0..1, y down). */
  project(p: { x: number; y: number; z: number }) {
    const v = this.proj.set(p.x, p.y, p.z).project(this.cam);
    return { x: (v.x + 1) / 2, y: (1 - v.y) / 2, behind: v.z > 1 };
  }

  get followPlayerX() {
    return this.followX;
  }
}
