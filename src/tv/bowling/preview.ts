// Dev-only preview of the bowling venue and the bowler, in any world.
//
//   /bowl-preview.html?world=park        park|plaza|ink|neon|pixel|paper|clay|water|cosmic
//     &cam=bowler|spec|ret|pins|side|front|wide|ball   &t=2.6 (freeze at that moment of the cycle)
//     &cycle=1 (odd cycles: a gutter ball and the sad face)   &handed=-1 (a left-hander)
//     &seed=11 (another character)   &court=1 (keep the tennis court and net)   &still=1 (wait for window.bowl.seek)
//   keys: 1–8 cameras · space pause · ←/→ step · [ ] previous / next world · a aim guide · h hand
//
// It fakes what the game will drive: a BowlerState timeline (a pendulum swing
// stands in for the phone) and a BowlView (the ball rolling down the lane, the
// pins scattering on strike cycles, a gutter ball on the others).
//
// The world's tennis court and net are hidden by wrapping World.buildCourt /
// buildNet before the world is built (so batching leaves them alone): the game
// will need a real switch for that.

import '@fontsource/fredoka/latin-700.css';
import * as THREE from 'three';
import { WORLDS, worldDef } from '../worlds';
import { World, type FrameView } from '../worlds/base';
import { Rig } from '../chars/rig';
import { randomLook } from '../chars/look';
import { Rng, clamp, lerp, smooth, easeOutCubic } from '../core/math';
import { BowlVenue } from './venue';
import { BowlAnimator } from './anim';
import { LANE, FOUL_Z, HEAD_Z, PIT_Z, pinSpots } from './lane';
import type { BowlView, BowlerState, BodyPose } from './types';

const q = new URLSearchParams(location.search);
const worldId = q.get('world') ?? 'park';
const handed = (Number(q.get('handed')) === -1 ? -1 : 1) as 1 | -1;
const keepCourt = q.has('court');
const still = q.has('still') || q.has('t');

// ---------------------------------------------------------------- hide the tennis court and net

type Builder = (this: World, s: unknown) => THREE.Group;
const proto = World.prototype as unknown as { buildCourt: Builder; buildNet: Builder };
if (!keepCourt) {
  for (const k of ['buildCourt', 'buildNet'] as const) {
    const orig = proto[k];
    proto[k] = function (this: World, s: unknown) {
      const g = orig.call(this, s);
      g.visible = false;
      return g;
    };
  }
}

// ---------------------------------------------------------------- renderer + world

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setClearColor(0x000000, 1);
const pr = Math.min(2, window.devicePixelRatio || 1);
renderer.setPixelRatio(1);

const def = worldDef(worldId);
const w = def.make(renderer);
w.init();
if (!keepCourt && w.netMesh) w.netMesh.visible = false;

const venue = new BowlVenue(w.kit);
w.scene.add(venue.group);

const look = randomLook(new Rng(Number(q.get('seed') ?? 11)));
const rig = new Rig(look, w.kit);
rig.racket.visible = false;
w.scene.add(rig.root, rig.shadow);
const anim = new BowlAnimator(handed, look);

const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 1200);
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

// ---------------------------------------------------------------- the fake game

const T = { ready: 1.3, approach: 1.6, release: 0.35, follow: 0.85, watch: 2.3, emote: 1.9 };
const CYCLE = T.ready + T.approach + T.release + T.follow + T.watch + T.emote;
const Z0 = FOUL_Z + 3.9; // stance
const Z1 = FOUL_Z + 0.85; // end of the steps
const Z2 = FOUL_Z + 0.42; // end of the slide
const ROOT_X = -0.1 * handed;
const SPIN = 0.65;
const SPEED = 8.2;

/** the phone's arm angle during the approach: push-away, drop, backswing, forward swing */
function fakeArm(u: number) {
  const keys: [number, number][] = [
    [0, 0.75],
    [0.3, 0.05],
    [0.68, -1.65],
    [1, 0.12],
  ];
  for (let i = 1; i < keys.length; i++) {
    const [u0, a0] = keys[i - 1];
    const [u1, a1] = keys[i];
    if (u <= u1) return lerp(a0, a1, (1 - Math.cos(Math.PI * clamp((u - u0) / (u1 - u0)))) / 2);
  }
  return keys[keys.length - 1][1];
}

function bowlerState(tc: number, st: BowlerState) {
  st.handed = handed;
  st.yaw = 0;
  st.x = ROOT_X;
  st.spin = SPIN * handed;
  st.holding = false;
  st.step = 0;
  let t = tc;
  if (t < T.ready) {
    Object.assign(st, { phase: 'ready', t, arm: 0, z: Z0, holding: true });
    return st;
  }
  t -= T.ready;
  if (t < T.approach) {
    const u = t / T.approach;
    Object.assign(st, { phase: 'approach', t, step: u, arm: fakeArm(u), z: lerp(Z0, Z1, u), holding: true });
    return st;
  }
  t -= T.approach;
  if (t < T.release) {
    Object.assign(st, { phase: 'release', t, step: 1, arm: 0.12 + t * 2.6, z: lerp(Z1, Z2, easeOutCubic(t / T.release)), holding: t < 0.06 });
    return st;
  }
  t -= T.release;
  if (t < T.follow) {
    Object.assign(st, { phase: 'follow', t, step: 1, arm: Math.min(2.0, 1.03 + t * 3), z: Z2 });
    return st;
  }
  t -= T.follow;
  if (t < T.watch) {
    Object.assign(st, { phase: 'watch', t, step: 1, arm: 0, z: Z2 });
    return st;
  }
  t -= T.watch;
  Object.assign(st, { phase: strike ? 'cheer' : 'sad', t, step: 1, arm: 0, z: Z2 });
  return st;
}

/** release moment (the hand lets go early in the release phase) */
const T_REL = T.ready + T.approach + 0.06;

const pose0 = (): BodyPose & { visible: boolean } => ({ x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, visible: true });
const view: BowlView = { ball: { ...pose0(), visible: false, gutter: false }, pins: pinSpots(0).map(() => pose0()) };
const ballQ = new THREE.Quaternion();
const relPos = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
let strike = true;
let cycleN = 0;

/** pins knocked over by a strike: a canned scatter away from the pocket */
interface Scatter {
  delay: number;
  vx: number;
  vz: number;
  vy: number;
  spin: number;
}
const scatter: Scatter[] = pinSpots(0).map((s, i) => {
  const r = new Rng(100 + i);
  const pocketX = 0.07 * handed,
    pocketZ = HEAD_Z + 0.12;
  const dx = s.x - pocketX + (r.next() - 0.5) * 0.2,
    dz = s.z - pocketZ - 0.15;
  const l = Math.hypot(dx, dz) || 1;
  const sp = 2.2 + r.next() * 2.5;
  return { delay: Math.hypot(s.x - pocketX, s.z - pocketZ) / 5.5, vx: (dx / l) * sp, vz: (dz / l) * sp - 0.8, vy: 0.6 + r.next() * 2.4, spin: 0.8 + r.next() * 1.4 };
});

function ballPath(t: number) {
  const d = (t - T_REL) * SPEED; // distance rolled
  const D = relPos.z - HEAD_Z;
  const x0 = relPos.x;
  const pocket = 0.07 * handed;
  let x: number;
  if (strike) {
    // out towards the boards, then the hook back into the pocket
    const a = 0.004 * handed;
    const c = (x0 + a * D - pocket) / Math.pow(D - 9, 2);
    x = x0 + a * d - c * Math.pow(Math.max(0, d - 9), 2);
  } else {
    x = x0 + 0.032 * handed * d;
  }
  // settle from the hand to the lane
  const drop = clamp(d / 1.2);
  let y = lerp(relPos.y, LANE.ballR, smooth(drop));
  let gutter = false;
  if (!strike && Math.abs(x) > LANE.width / 2 - 0.02) {
    gutter = true;
    x = Math.sign(x) * (LANE.width / 2 + LANE.gutter / 2);
    y = LANE.ballR - 0.05;
  }
  let z = relPos.z - d;
  if (z < PIT_Z) y -= Math.pow(PIT_Z - z, 2) * 3; // into the pit
  return { x, y, z, gutter, d };
}

function fakeView(tc: number, dt: number) {
  const b = view.ball;
  if (tc < T_REL) {
    b.visible = false;
  } else {
    const p = ballPath(tc);
    const prev = ballPath(tc - dt);
    b.visible = p.y > -0.4;
    b.x = p.x;
    b.y = p.y;
    b.z = p.z;
    b.gutter = p.gutter;
    // roll without slipping about the axis across the travel
    tmpV.set(p.x - prev.x, 0, p.z - prev.z);
    const dist = tmpV.length();
    if (dist > 1e-5 && p.y > 0) {
      tmpV.set(tmpV.z, 0, -tmpV.x).normalize();
      tmpQ.setFromAxisAngle(tmpV, dist / LANE.ballR);
      ballQ.premultiply(tmpQ);
    }
    b.qx = ballQ.x;
    b.qy = ballQ.y;
    b.qz = ballQ.z;
    b.qw = ballQ.w;
  }
  const tHit = T_REL + (relPos.z - HEAD_Z) / SPEED;
  pinSpots(0).forEach((s, i) => {
    const pin = view.pins[i];
    const sc = scatter[i];
    const tau = strike ? tc - tHit - sc.delay : -1;
    pin.visible = true;
    if (tau <= 0) {
      Object.assign(pin, { x: s.x, y: 0, z: s.z, qx: 0, qy: 0, qz: 0, qw: 1 });
      return;
    }
    const slow = (1 - Math.exp(-2.2 * tau)) / 2.2;
    const x = s.x + sc.vx * slow;
    const z = s.z + sc.vz * slow;
    // a hop, whole turns in the air, and down on its side
    const air = (2 * sc.vy) / 9.8;
    let y = Math.max(0.06, sc.vy * tau - 4.9 * tau * tau);
    if (z < PIT_Z) y -= Math.pow((PIT_Z - z) * 2, 2);
    pin.visible = y > -0.4;
    tmpV.set(-sc.vz, 0, sc.vx).normalize();
    const turns = Math.max(1, Math.round(sc.spin));
    const ang = (Math.PI / 2) * easeOutCubic(clamp(tau / 0.3)) + Math.PI * 2 * turns * clamp(tau / air);
    tmpQ.setFromAxisAngle(tmpV, ang);
    Object.assign(pin, { x, y, z, qx: tmpQ.x, qy: tmpQ.y, qz: tmpQ.z, qw: tmpQ.w });
  });
}

// ---------------------------------------------------------------- cameras

type CamDef = { pos: [number, number, number]; look: [number, number, number]; fov: number } | ((c: THREE.PerspectiveCamera) => void);
const CAMS: Record<string, CamDef> = {
  // follows the bowler down the approach, a little over the bowling shoulder: the whole swing at
  // the bottom, the aim line and the pins beside and over the bowler (straight behind, they hide it)
  bowler: (c) => {
    const z = Math.min(st.z, FOUL_Z + 3.9);
    c.position.set(st.x + 0.32 * handed, 2.75, z + 4.4);
    c.lookAt(st.x * 0.3 + 0.12 * handed, 0.2, z - 13);
    c.fov = 42;
  },
  // the camera suggested in the brief (eye level, close): the head covers the pins
  spec: { pos: [0, 1.9, FOUL_Z + 6.5], look: [0, 0.35, HEAD_Z], fov: 38 },
  ret: { pos: [-2.2, 1.5, FOUL_Z + 7.6], look: [0.3, 0.5, FOUL_Z + 4.6], fov: 40 },
  pins: { pos: [0.62, 0.7, HEAD_Z + 2.7], look: [0.02, 0.2, HEAD_Z - 0.35], fov: 38 },
  side: { pos: [4.3 * handed, 1.25, FOUL_Z + 1.9], look: [0, 0.72, FOUL_Z + 1.35], fov: 36 },
  front: { pos: [0.7, 1.35, FOUL_Z - 3.2], look: [0, 0.8, FOUL_Z + 0.9], fov: 40 },
  wide: { pos: [7.2, 4.4, FOUL_Z + 8.5], look: [-0.4, 0.2, -1.5], fov: 42 },
  ball: (c) => {
    const b = view.ball.visible ? view.ball : { x: ROOT_X, z: Z0 - 1 };
    c.position.set(b.x + 0.9, 1.0, b.z + 3.1);
    c.lookAt(b.x, 0.25, b.z - 3);
    c.fov = 42;
  },
};
let camName = q.get('cam') ?? 'bowler';
const CAM_KEYS = Object.keys(CAMS)
  .map((k, i) => `${i + 1} ${k}`)
  .join(' · ');
function placeCam() {
  const c = CAMS[camName] ?? CAMS.bowler;
  if (typeof c === 'function') c(cam);
  else {
    cam.position.set(...c.pos);
    cam.lookAt(...c.look);
    cam.fov = c.fov;
  }
  cam.updateProjectionMatrix();
}

// ---------------------------------------------------------------- loop

const st: BowlerState = { x: 0, z: Z0, yaw: 0, handed, phase: 'ready', t: 0, arm: 0, step: 0, holding: true, spin: 0 };
const handW = new THREE.Vector3();
let clock = 0; // time in the current cycle
let total = 0;
let paused = still;
let aimOn = true;

function simulate(tc: number, dt: number) {
  bowlerState(tc, st);
  const pose = anim.update(total, dt, st);
  rig.apply(pose);
  rig.hands[0].rotation.z = anim.handRoll;
  // the ball in the hand: root-local → world
  const l = anim.ballHand();
  const k = anim.scale;
  const c = Math.cos(pose.yaw),
    s = Math.sin(pose.yaw);
  handW.set(pose.x + k * (l.x * c + l.z * s), pose.hop + k * l.y, pose.z + k * (-l.x * s + l.z * c));
  if (st.holding) {
    venue.holdBall(handW);
    relPos.copy(handW);
    ballQ.identity();
  } else venue.holdBall(null);
  fakeView(tc, dt);
  venue.setAim(aimOn && (st.phase === 'ready' || (st.phase === 'approach' && st.step < 0.3)) ? { x: ROOT_X + 0.34 * handed, angle: -0.012 * handed } : null);
  venue.update(view, dt);
}

function advance(dt: number) {
  clock += dt;
  total += dt;
  if (clock >= CYCLE) {
    clock -= CYCLE;
    cycleN++;
    strike = cycleN % 2 === 0;
  }
  simulate(clock, dt);
}

function render(dt: number) {
  placeCam();
  const fv: FrameView = { t: total, dt, realT: total, realDt: dt, ball: { x: 0, y: -20, z: 0 }, ballSpeed: 0, ballVisible: false, holder: -1, poses: [], excitement: 0.35, state: 'play', cam, beat: 0 };
  w.update(fv);
  w.render(cam, null);
  hud.textContent = `${def.name} (${def.id}) · cam ${camName} · ${st.phase} ${st.t.toFixed(2)}s · cycle ${clock.toFixed(2)}/${CYCLE.toFixed(1)}${paused ? ' · paused' : ''}\n${CAM_KEYS} · space pause · ←/→ step · [ ] world · a aim · h hand`;
}

/** Jump to `t` seconds into the cycle (replaying from the start so every smoothing state is right) and draw it. */
function seek(t: number, camera?: string, cycle = 0) {
  if (camera) camName = camera;
  cycleN = cycle;
  strike = cycle % 2 === 0;
  clock = 0;
  total = 0;
  const dt = 1 / 60;
  // start from the stance (so the first frame doesn't have to replant)
  simulate(0, dt);
  while (clock + dt <= t) advance(dt);
  paused = true;
  render(dt);
}

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) advance(dt);
  render(paused ? 0 : dt);
}

window.addEventListener('keydown', (e) => {
  const names = Object.keys(CAMS);
  if (e.key >= '1' && e.key <= String(names.length)) camName = names[Number(e.key) - 1];
  else if (e.key === ' ') paused = !paused;
  else if (e.key === 'ArrowRight') advance(1 / 30);
  else if (e.key === 'ArrowLeft') seek(Math.max(0, clock - 1 / 30), undefined, cycleN);
  else if (e.key === 'a') aimOn = !aimOn;
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

// for scripts: window.bowl.seek(t, cam) freezes a moment; stats() counts what the venue adds
function stats() {
  let meshes = 0,
    outlines = 0,
    tris = 0;
  venue.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.name === 'outline') outlines++;
    else meshes++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  // draw calls the venue adds (every pass: shadow map, scene, normals…)
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
  return { meshes, outlines, tris: Math.round(tris), calls: withV - without };
}
(window as unknown as { bowl: unknown }).bowl = { ready: false, seek, stats, venue, anim, rig, world: w };

if (q.has('t')) seek(Number(q.get('t')), undefined, Number(q.get('cycle') ?? 0));
else seek(0);
paused = still;
(window as unknown as { bowl: { ready: boolean } }).bowl.ready = true;
requestAnimationFrame(frame);
