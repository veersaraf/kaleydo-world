// Dev-only preview of the archery range and the archer, in any world.
//
//   /archery-preview.html?world=park        park|plaza|ink|neon|pixel|paper|clay|water|cosmic
//     &cam=play|aim|side|chase|target|front|wide   &t=12.3 (freeze at that moment of the cycle)
//     &handed=-1 (left-handers)   &seed=7 (another archer)   &still=1 (wait for window.range.seek)
//   keys: 1–7 cameras · space pause · ←/→ step · [ ] previous / next world · h hand
//
// It fakes what the game will drive: an end of seven shots at five faces (one
// on a tower, one swinging on a frame, the furthest at 32 m) and five
// balloons — a 10, a 7, a balloon popped, a swinging 9, a miss into the lawn,
// a 5 at the back, a high one into the backstop's net — with the archer's
// ArcherState going nock → draw → hold → release → watch → cheer / sad, the
// arrows flying on real ballistic paths from 0.7 m in front of the eye (as the
// game launches them), sticking 8 cm deep, and a wind that changes over the
// cycle. The world, its rig, the range and the gear are driven exactly as the
// game will.

import '@fontsource/fredoka/latin-700.css';
import * as THREE from 'three';
import { WORLDS, worldDef } from '../worlds';
import type { FrameView } from '../worlds/base';
import { randomLook } from '../chars/look';
import { Rng } from '../core/math';
import { RangeVenue } from './venue';
import { ArcherAnimator } from './anim';
import { ArcheryGear, ARROW } from './bow';
import { RANGE, ringOf } from './range';
import { BALLOON_R, balloonColor } from './balloons';
import type { ArcherState, ArrowView, RangeFx, RangeView, TargetDef } from './types';

const q = new URLSearchParams(location.search);
const worldId = q.get('world') ?? 'park';
const handed = (Number(q.get('handed')) === -1 ? -1 : 1) as 1 | -1;
const still = q.has('still') || q.has('t');
const COLOR = '#3aa8ff';

// ---------------------------------------------------------------- renderer + world

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setClearColor(0x000000, 1);
const pr = Math.min(2, window.devicePixelRatio || 1);
renderer.setPixelRatio(1);

const def = worldDef(worldId);
const w = def.make(renderer);
w.init();
w.setSport('archery', (kit) => new RangeVenue(kit, { particles: w.particles, world: def.id }));
const venue = w.rangeVenue as RangeVenue;

const seed = Number(q.get('seed') ?? 5);
const look = randomLook(new Rng(seed), COLOR);
w.setPlayers([look]);
const anim = new ArcherAnimator(handed, look);
const gear = new ArcheryGear(w, [COLOR]);

const cam = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 1200);
function resize() {
  const W = window.innerWidth,
    H = window.innerHeight;
  renderer.setSize(Math.floor(W * pr), Math.floor(H * pr), false);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  w.resize(W, H, pr);
  cam.aspect = W / H;
  cam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the range

const R = RANGE.faceR;
const X0 = 0;
const EYE = new THREE.Vector3(X0, RANGE.eyeY, RANGE.lineZ);
const SWAY = { x: 0.4, amp: 1.6, T: 3.4 };

const TARGETS: TargetDef[] = [
  { id: 1, kind: 'face', x: 0, y: 1.3, z: -1, r: R, bonus: 0, swayX: 0, swayT: 0 },
  { id: 2, kind: 'face', x: -3.6, y: 1.3, z: -8, r: R, bonus: 0, swayX: 0, swayT: 0 },
  { id: 3, kind: 'face', x: 3.8, y: 4.4, z: -11, r: R, bonus: 0, swayX: 0, swayT: 0 },
  { id: 4, kind: 'face', x: SWAY.x, y: 2.2, z: -15.5, r: R, bonus: 0, swayX: SWAY.amp, swayT: SWAY.T },
  { id: 5, kind: 'face', x: -5.3, y: 1.25, z: -18, r: R, bonus: 0, swayX: 0, swayT: 0 },
  { id: 11, kind: 'balloon', x: -1.9, y: 3.2, z: 3, r: BALLOON_R, bonus: 5, swayX: 0, swayT: 0 },
  { id: 12, kind: 'balloon', x: 2.3, y: 2.5, z: -5, r: BALLOON_R, bonus: 5, swayX: 0, swayT: 0 },
  { id: 13, kind: 'balloon', x: -4.6, y: 5.3, z: -13, r: BALLOON_R, bonus: 5, swayX: 0, swayT: 0 },
  { id: 14, kind: 'balloon', x: 5.6, y: 6.0, z: -17, r: BALLOON_R, bonus: 5, swayX: 0, swayT: 0 },
  { id: 15, kind: 'balloon', x: 1.2, y: 4.6, z: -9, r: BALLOON_R, bonus: 5, swayX: 0, swayT: 0 },
];
const byId = (id: number) => TARGETS.find((t) => t.id === id)!;
/** the swinging face's live x (the game sends it with the sway applied) */
const swayX = (t: TargetDef, time: number) => t.x + (t.swayX && t.swayT ? t.swayX * Math.sin((2 * Math.PI * time) / t.swayT) : 0);

// ---------------------------------------------------------------- the shots

interface ShotDef {
  name: string;
  /** a face (hit `off` from its centre), a balloon, or a point (a miss) */
  target?: number;
  off?: [number, number];
  at?: [number, number, number];
  hold: number;
  react: 'cheer' | 'sad';
}

const SHOTS: ShotDef[] = [
  { name: 'bullseye', target: 1, off: [0.012, -0.018], hold: 0.9, react: 'cheer' },
  { name: 'tower', target: 3, off: [0.21, 0.16], hold: 0.7, react: 'cheer' },
  { name: 'balloon', target: 12, hold: 0.6, react: 'cheer' },
  { name: 'swinging', target: 4, off: [-0.05, 0.06], hold: 0.8, react: 'cheer' },
  { name: 'miss', at: [1.4, 0, -6.5], hold: 0.5, react: 'sad' },
  { name: 'far', target: 5, off: [0.27, -0.2], hold: 1.1, react: 'cheer' },
  { name: 'backstop', at: [2.2, 5.2, -19.5], hold: 0.6, react: 'sad' },
];

const PH = { idle: 1.0, nock: 0.85, draw: RANGE.drawT, release: 0.25, watchAfter: 0.5, react: 1.35 };
const G = RANGE.gravity;
const SPEED = RANGE.fullSpeed;

interface Shot extends ShotDef {
  t0: number;
  /** when each phase starts (cycle seconds) */
  draw: number;
  hold0: number;
  release: number;
  watch: number;
  react0: number;
  end: number;
  yaw: number;
  pitch: number;
  launch: THREE.Vector3;
  vel: THREE.Vector3;
  /** flight time to where it stops; to a balloon it pops on the way */
  T: number;
  Tpop: number;
  /** the target it sticks in (−1 = the ground or the backstop), and the ring */
  stuck: number;
  ring: number;
  hitT: number;
}

/** Where a shot flying from `launch` at `vel` is, t seconds after release (point and direction). */
function flight(s: { launch: THREE.Vector3; vel: THREE.Vector3 }, t: number, p: THREE.Vector3, d: THREE.Vector3) {
  p.copy(s.launch).addScaledVector(s.vel, t);
  p.y -= 0.5 * G * t * t;
  d.copy(s.vel);
  d.y -= G * t;
  d.normalize();
}

/** The launch direction (low arc) from L to P at the full speed. */
function aimAt(L: THREE.Vector3, P: THREE.Vector3, out: THREE.Vector3) {
  const dx = P.x - L.x,
    dz = P.z - L.z;
  const D = Math.hypot(dx, dz);
  const H = P.y - L.y;
  const v2 = SPEED * SPEED;
  const disc = v2 * v2 - G * (G * D * D + 2 * H * v2);
  const th = Math.atan((v2 - Math.sqrt(Math.max(0, disc))) / (G * D));
  out.set((dx / D) * Math.cos(th), Math.sin(th), (dz / D) * Math.cos(th));
  return D / (SPEED * Math.cos(th));
}

const shots: Shot[] = [];
let CYCLE = PH.idle;
{
  const p = new THREE.Vector3(),
    d = new THREE.Vector3(),
    u = new THREE.Vector3();
  for (const s of SHOTS) {
    const t0 = CYCLE;
    const draw = t0 + PH.nock;
    const hold0 = draw + PH.draw;
    const release = hold0 + s.hold;
    // aim: iterate (the launch point sits 0.7 m along the aim, a swinging face moves while it flies)
    const P = new THREE.Vector3();
    let T = 1;
    u.set(0, 0, -1);
    const L = new THREE.Vector3();
    for (let k = 0; k < 4; k++) {
      L.copy(EYE).addScaledVector(u, 0.7);
      if (s.target !== undefined) {
        const tg = byId(s.target);
        P.set(tg.kind === 'face' ? swayX(tg, release + T) : tg.x, tg.y, tg.z);
        if (s.off) (P.x += s.off[0]), (P.y += s.off[1]);
      } else P.set(...s.at!);
      T = aimAt(L, P, u);
    }
    const vel = u.clone().multiplyScalar(SPEED);
    const shot: Shot = { ...s, t0, draw, hold0, release, watch: release + PH.release, react0: 0, end: 0, yaw: Math.atan2(-u.x, -u.z), pitch: Math.asin(u.y), launch: L.clone(), vel, T, Tpop: -1, stuck: -1, ring: 0, hitT: 0 };
    const tg = s.target !== undefined ? byId(s.target) : null;
    if (tg?.kind === 'balloon') {
      // through the balloon and on until the ground or the backstop
      shot.Tpop = T;
      let t = T;
      for (; t < 4; t += 1 / 240) {
        flight(shot, t, p, d);
        if (p.y <= 0 || p.z <= -19.5) break;
      }
      shot.T = t;
    } else if (tg) {
      shot.stuck = tg.id;
      shot.ring = ringOf(Math.hypot(s.off?.[0] ?? 0, s.off?.[1] ?? 0), tg.r);
    }
    shot.hitT = shot.release + shot.T;
    shot.react0 = shot.hitT + PH.watchAfter;
    shot.end = shot.react0 + PH.react;
    shots.push(shot);
    CYCLE = shot.end;
  }
  CYCLE += 0.8;
}

function shotAt(tc: number) {
  for (const s of shots) if (tc < s.end) return s;
  return null;
}

/** seconds into the cycle for `name` (a shot) and one of its moments, plus an offset */
function at(name: string, moment: 'nock' | 'draw' | 'hold' | 'release' | 'flight' | 'hit' | 'react' = 'nock', off = 0) {
  const s = shots.find((x) => x.name === name);
  if (!s) return 0;
  const base = { nock: s.t0, draw: s.draw, hold: s.hold0, release: s.release, flight: s.release + s.T * 0.5, hit: s.hitT, react: s.react0 }[moment];
  return base + off;
}

// ---------------------------------------------------------------- the fake game's view

const archer: ArcherState = { x: X0, z: RANGE.lineZ, handed, phase: 'idle', t: 0, draw: 0, yaw: 0, pitch: 0 };
const targets = TARGETS.map((t) => ({ ...t, visible: true, popped: false }));
const arrows: ArrowView[] = [];
const view: RangeView = { targets, arrows, wind: 0, fx: [] };
const tmpP = new THREE.Vector3();
const tmpD = new THREE.Vector3();

function wind(tc: number) {
  return 2.9 * Math.sin(tc * 0.2 + 0.4) + 0.9 * Math.sin(tc * 0.61 + 1.1);
}

function fake(tc: number, dt: number) {
  const t0 = tc - dt;
  view.wind = wind(tc);
  view.fx.length = 0;
  // targets: the swinging one's live x; balloons popped earlier in this cycle
  for (const t of targets) {
    const base = byId(t.id);
    if (t.kind === 'face') t.x = swayX(base, tc);
    const popper = shots.find((s) => s.target === t.id && s.Tpop >= 0);
    t.popped = !!popper && tc >= popper.release + popper.Tpop;
    t.visible = !t.popped;
  }
  // the archer
  const s = shotAt(tc);
  const st = archer;
  if (!s || tc < s.t0) {
    // before the first shot, or after the last
    st.phase = 'idle';
    st.t = s ? tc : tc - shots[shots.length - 1].end;
    st.draw = 0;
    st.yaw = 0;
    st.pitch = 0.02;
  } else {
    st.yaw = s.yaw;
    st.pitch = s.pitch;
    const set = (phase: ArcherState['phase'], since: number, draw: number) => {
      st.phase = phase;
      st.t = tc - since;
      st.draw = draw;
    };
    if (tc < s.draw) set('nock', s.t0, 0);
    else if (tc < s.hold0) set('draw', s.draw, Math.min(1, (tc - s.draw) / PH.draw));
    else if (tc < s.release) set('hold', s.hold0, 1);
    else if (tc < s.watch) set('release', s.release, 0);
    else if (tc < s.react0) set('watch', s.watch, 0);
    else set(s.react, s.react0, 0);
  }
  // arrows: one per shot that has been nocked this cycle
  arrows.length = 0;
  for (const sh of shots) {
    if (tc < sh.t0 + 0.66) break;
    const a: ArrowView = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1, state: 'nocked', target: -1, color: COLOR };
    if (tc < sh.release) {
      // the game's nocked arrow: its point 1.15 m in front of the eye before the draw, 0.7 m at full draw
      const dr = tc < sh.draw ? 0 : Math.min(1, (tc - sh.draw) / PH.draw);
      tmpD.set(-Math.sin(sh.yaw) * Math.cos(sh.pitch), Math.sin(sh.pitch), -Math.cos(sh.yaw) * Math.cos(sh.pitch));
      tmpP.copy(EYE).addScaledVector(tmpD, 1.15 - 0.45 * dr);
    } else {
      const ft = Math.min(tc - sh.release, sh.T);
      flight(sh, ft, tmpP, tmpD);
      a.state = tc - sh.release < sh.T ? 'flying' : 'stuck';
      if (a.state === 'stuck') {
        // sunk 8 cm into what it hit
        tmpP.addScaledVector(tmpD, ARROW.sink);
        a.target = sh.stuck;
      }
    }
    a.x = tmpP.x;
    a.y = tmpP.y;
    a.z = tmpP.z;
    a.dx = tmpD.x;
    a.dy = tmpD.y;
    a.dz = tmpD.z;
    arrows.push(a);
  }
  // effects starting this frame
  for (const sh of shots) {
    const pop = sh.release + sh.Tpop;
    if (sh.Tpop >= 0 && pop > t0 && pop <= tc) {
      const b = byId(sh.target!);
      view.fx.push({ type: 'pop', x: b.x, y: b.y, z: b.z, color: balloonColor(b.id) });
    }
    if (sh.hitT > t0 && sh.hitT <= tc) {
      flight(sh, sh.T, tmpP, tmpD);
      const f: RangeFx = sh.stuck >= 0 ? { type: 'hit', x: tmpP.x, y: tmpP.y, z: tmpP.z, ring: sh.ring } : { type: 'thunk', x: tmpP.x, y: tmpP.y, z: tmpP.z };
      view.fx.push(f);
    }
  }
}

// ---------------------------------------------------------------- cameras

type CamFn = (c: THREE.PerspectiveCamera) => void;
const lookAtV = new THREE.Vector3();
/**
 * The gameplay camera: behind the archer and out past the draw shoulder, at
 * about head height, looking down the aim 22 m out — it swings round the
 * archer with the aim's yaw, so the archer stays at the lower corner and the
 * target in the middle wherever they aim. `zoom` 0..1 narrows the view onto
 * the aim (as the string comes back) without moving the camera.
 */
function playCam(c: THREE.PerspectiveCamera, zoom: number) {
  const hs = handed;
  const a = archer;
  const aiming = a.phase !== 'idle' && a.phase !== 'cheer' && a.phase !== 'sad';
  const yaw = aiming ? a.yaw : 0;
  const pitch = aiming ? a.pitch : 0;
  const fx = -Math.sin(yaw),
    fz = -Math.cos(yaw);
  const rx = Math.cos(yaw),
    rz = -Math.sin(yaw);
  const side = hs * 1.5,
    back = 3.4;
  c.position.set(a.x + rx * side - fx * back, 1.62, a.z + rz * side - fz * back);
  const D = 22;
  lookAtV.set(a.x + fx * D * Math.cos(pitch), RANGE.eyeY - 0.1 + Math.sin(pitch) * D, a.z + fz * D * Math.cos(pitch));
  c.lookAt(lookAtV);
  c.fov = 40 - 18 * zoom;
}
const CAMS: Record<string, CamFn> = {
  play: (c) => playCam(c, 0),
  // the same while drawing: pushed in towards the aim (Wii Sports Resort zooms as you draw)
  aim: (c) => playCam(c, 1),
  side: (c) => {
    const a = archer;
    c.position.set(a.x + handed * 3.7, 1.3, a.z - 0.6);
    c.lookAt(a.x, 1.02, a.z - 0.35);
    c.fov = 38;
  },
  chase: (c) => {
    // behind the flying arrow (or the last one, where it landed)
    const s = shots.find((x) => clock >= x.release && clock < x.hitT + 0.8) ?? null;
    if (!s) return playCam(c, 0);
    const ft = Math.min(clock - s.release, s.T);
    flight(s, ft, tmpP, tmpD);
    const side = handed * 0.35;
    c.position.set(tmpP.x - tmpD.x * 2.8 + side, tmpP.y - tmpD.y * 2.8 + 0.42, tmpP.z - tmpD.z * 2.8);
    c.lookAt(tmpP.x + tmpD.x * 6, tmpP.y + tmpD.y * 6, tmpP.z + tmpD.z * 6);
    c.fov = 46;
  },
  target: (c) => {
    // what the current shot is aimed at, close up: a face, a balloon, or where a miss lands
    const s = shotAt(clock) ?? shots[0];
    if (s.at) {
      const [x, y, z] = s.at;
      c.position.set(x + 1.3, y + 0.9, z + 3.4);
      c.lookAt(x, y + 0.15, z);
    } else {
      const t = targets.find((x) => x.id === s.target) ?? targets[0];
      c.position.set(t.x + 1.1, t.y + 0.45, t.z + 3.3);
      c.lookAt(t.x, t.y - (t.kind === 'balloon' ? 0.8 : 0), t.z);
    }
    c.fov = 34;
  },
  flags: (c) => {
    // a wind flag down the left side, from across the range (the gameplay camera sees them broadside too)
    c.position.set(-7.6, 3.0, 2.4);
    c.lookAt(-8.4, 3.05, -2.5);
    c.fov = 36;
  },
  front: (c) => {
    const a = archer;
    c.position.set(a.x - handed * 1.2, 1.55, a.z - 5.2);
    c.lookAt(a.x, 1.05, a.z);
    c.fov = 38;
  },
  wide: (c) => {
    c.position.set(-12.5, 10.5, 21);
    c.lookAt(0, 0.5, -4);
    c.fov = 50;
  },
};
let camName = q.get('cam') ?? 'play';
const CAM_KEYS = Object.keys(CAMS)
  .map((k, i) => `${i + 1} ${k}`)
  .join(' · ');
function placeCam() {
  (CAMS[camName] ?? CAMS.play)(cam);
  cam.updateProjectionMatrix();
  w.setView(0, cam);
}

// ---------------------------------------------------------------- loop

let clock = 0;
let total = 0;
let paused = still;
const noBall = { x: 0, y: -20, z: 0 };

function step(dt: number) {
  clock += dt;
  total += dt;
  if (clock >= CYCLE) clock -= CYCLE;
  fake(clock, dt);
  const pose = anim.update(total, dt, archer);
  const fv: FrameView = { t: total, dt, realT: total, realDt: dt, ball: noBall, ballSpeed: 0, ballVisible: false, holder: -1, poses: [pose], excitement: 0.35, state: 'play', cam, beat: 0, range: view };
  w.update(fv);
  gear.update([archer], dt);
}

function render() {
  placeCam();
  w.render(cam, null);
  const s = shotAt(clock);
  const wv = view.wind;
  const gauge = wv >= 0 ? `${'·'.repeat(Math.round(Math.abs(wv) * 2))}→` : `←${'·'.repeat(Math.round(Math.abs(wv) * 2))}`;
  hud.textContent = `${def.name} (${def.id}) · cam ${camName} · ${s?.name ?? 'idle'} · ${archer.phase} ${archer.t.toFixed(2)} draw ${archer.draw.toFixed(2)} · wind ${wv.toFixed(1)} m/s ${gauge} · ${clock.toFixed(2)}/${CYCLE.toFixed(1)}${paused ? ' · paused' : ''}\n${CAM_KEYS} · space pause · ←/→ step · [ ] world · h hand`;
}

/** Jump to `t` seconds into the cycle (replaying from the start so every smoothing state is right) and draw it. */
function seek(t: number, camera?: string) {
  if (camera) camName = camera;
  clock = 0;
  total = 0;
  const dt = 1 / 60;
  do step(dt);
  while (clock + dt <= t + 1e-6);
  paused = true;
  render();
}

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) step(dt);
  render();
}

window.addEventListener('keydown', (e) => {
  const names = Object.keys(CAMS);
  if (e.key >= '1' && e.key <= String(names.length)) camName = names[Number(e.key) - 1];
  else if (e.key === ' ') paused = !paused;
  else if (e.key === 'ArrowRight') step(1 / 30);
  else if (e.key === 'ArrowLeft') seek(Math.max(0, clock - 1 / 30));
  else if (e.key === 'h') setParam('handed', handed === 1 ? '-1' : '1');
  else if (e.key === ']' || e.key === '[') {
    const i = WORLDS.findIndex((d) => d.id === def.id);
    setParam('world', WORLDS[(i + (e.key === ']' ? 1 : WORLDS.length - 1)) % WORLDS.length].id);
  }
});
function setParam(k: string, v: string) {
  q.set(k, v);
  q.set('cam', camName);
  location.search = q.toString();
}

// ---------------------------------------------------------------- for scripts

/** Draw calls and triangles the range adds (with and without it), and the gear's share. */
function stats() {
  let meshes = 0,
    tris = 0;
  venue.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    meshes++;
    const g = m.geometry;
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tris += n * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  const calls = () => {
    renderer.info.autoReset = false;
    renderer.info.reset();
    w.render(cam, null);
    renderer.info.autoReset = true;
    return renderer.info.render.calls;
  };
  venue.group.visible = false;
  const without = calls();
  venue.group.visible = true;
  const withV = calls();
  // the bow, arrow and quiver against the racket they replace
  const rig = w.rigs[0];
  const bow = rig.racket.children.find((c) => c.userData.bow);
  const quiver = rig.body.children.find((c) => c.name === 'quiver');
  if (bow) bow.visible = false;
  if (quiver) quiver.visible = false;
  const noGear = calls();
  if (bow) bow.visible = true;
  if (quiver) quiver.visible = true;
  return { meshes, tris: Math.round(tris), calls: withV - without, gearCalls: withV - noGear, total: withV };
}

/** CPU cost of a frame's range update (ms), averaged over n frames of the current moment. */
function perf(n = 600) {
  const dt = 1 / 60;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) venue.update(view, dt);
  const tv = (performance.now() - t0) / n;
  const t1 = performance.now();
  for (let i = 0; i < n; i++) gear.update([archer], dt);
  const tg = (performance.now() - t1) / n;
  const t2 = performance.now();
  for (let i = 0; i < n; i++) anim.update(total + i * dt, dt, archer);
  const ta = (performance.now() - t2) / n;
  return { venueMs: +tv.toFixed(4), gearMs: +tg.toFixed(4), animMs: +ta.toFixed(4) };
}

/** seek() and hand back the frame as a PNG data url (read in the same task as the draw: the buffer is still there) */
function capture(t: number, camera?: string) {
  seek(t, camera);
  return canvas.toDataURL('image/png');
}

function timings() {
  return Object.fromEntries(shots.map((s) => [s.name, { nock: s.t0, draw: s.draw, hold: s.hold0, release: s.release, hit: s.hitT, react: s.react0, end: s.end }]));
}

(window as unknown as { range: unknown }).range = { ready: false, seek, capture, stats, perf, at, timings, cycle: CYCLE, venue, gear, anim, archer, view, world: w };

if (q.has('t')) seek(Number(q.get('t')));
else seek(0);
paused = still;
(window as unknown as { range: { ready: boolean } }).range.ready = true;
requestAnimationFrame(frame);
