// Dev-only preview of the ballpark (baseball/venue.ts) in any world.
//
//   /field-preview.html?world=park      park|plaza|ink|neon|pixel|paper|clay|water|cosmic
//     &cam=bat|wide|high|flight|stands|side|plate|mound|wall|pole|reverse
//     &t=12.3 (freeze at that moment of the cycle)   &still=1 (wait for window.field.seek)
//     &pr=1.5 (render scale; default the screen's)    &fx=2 (effects tier, 0–3; default 3)
//     &nochars=1 (no placeholder people)               &color=%23ff5a3c (the hitter's colour)
//   keys: 1–9, 0 cameras · space pause · ←/→ step · [ ] previous / next world
//
// It fakes what the game will drive: one hitter's turn against a CPU pitcher —
// a take into the catcher's mitt, a home run to left-centre, a fly ball that
// falls short of the fence, a foul into the left-field stands, one off the
// right-centre wall and a no-doubter out of the park to right — as the FieldView
// the game will send every frame: the ball and its phase (hand → pitch → play or
// mitt → gone), the tracer from contact until the next pitch leaves the hand, the
// hitter's colour, this turn's home runs, the camera and the effects. Placeholder
// people stand where the batter, the catcher, the pitcher (on the mound, raised
// by moundY) and a hitter on deck will be.

import '@fontsource/fredoka/latin-700.css';
import '@fontsource/kaushan-script/latin-400.css';
import '@fontsource/monoton/latin-400.css';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/gaegu/latin-700.css';
import '@fontsource/chewy/latin-400.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/orbitron/latin-700.css';
import * as THREE from 'three';
import { WORLDS, worldDef } from '../worlds';
import type { FrameView } from '../worlds/base';
import { randomLook } from '../chars/look';
import { newPose, type Pose } from '../chars/pose';
import { Rng } from '../core/math';
import { FieldVenue } from './venue';
import { FIELD, DELIVERY, fenceAt, fieldPoint, sprayOf, moundY } from './field';
import type { FieldBall, FieldFx, FieldView } from './types';

const q = new URLSearchParams(location.search);
const worldId = q.get('world') ?? 'park';
const still = q.has('still') || q.has('t');
const COLOR = q.get('color') ?? '#ff5a3c';
const PR = q.has('pr') ? Number(q.get('pr')) : Math.min(2, window.devicePixelRatio || 1);
const FXT = q.has('fx') ? Number(q.get('fx')) : 3;
const CHARS = !q.has('nochars');

// ---------------------------------------------------------------- renderer + world

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setClearColor(0x000000, 1);
renderer.setPixelRatio(1);

const def = worldDef(worldId);
const w = def.make(renderer);
w.init();
w.setSport('baseball', (kit) => new FieldVenue(kit, { particles: w.particles, world: def.id }));
const venue = w.fieldVenue as FieldVenue;

// placeholder people: the batter (a right-hander, at −x), the catcher, the pitcher, a hitter on deck
const seed = Number(q.get('seed') ?? 3);
const shirts = [COLOR, '#3a5bd9', '#2d4fb0', '#35d49a'];
const looks = shirts.map((c, i) => randomLook(new Rng(seed + i * 17), c));
if (CHARS) {
  w.setPlayers(looks);
  for (const r of w.rigs) r.racket.visible = false;
}
const poses: Pose[] = [];
{
  const P = (x: number, z: number, yaw: number, hop = 0) => {
    const p = newPose();
    p.x = x;
    p.z = z;
    p.yaw = yaw;
    p.hop = hop;
    return p;
  };
  // the batter faces the plate (+x), the catcher and the on-deck hitter face the field, the pitcher home
  const bat = P(-FIELD.boxX, 11.8, -Math.PI / 2);
  bat.headYaw = 1.1;
  bat.hands = [
    { x: 0.12, y: 1.25, z: 0.12 },
    { x: 0.05, y: 1.2, z: 0.1 },
  ];
  const catcher = P(0, FIELD.catcherZ, 0);
  catcher.body.y = -0.1;
  catcher.squash = 0.8;
  catcher.feet = [
    { x: -0.3, y: 0, z: 0.05 },
    { x: 0.3, y: 0, z: 0.05 },
  ];
  const pitcher = P(0, FIELD.moundZ + 0.1, Math.PI, moundY(0, FIELD.moundZ));
  const deck = P(-FIELD.onDeckX, FIELD.onDeckZ, -0.6);
  poses.push(bat, catcher, pitcher, deck);
}

const cam = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 1200);
function resize() {
  const W = window.innerWidth,
    H = window.innerHeight;
  renderer.setSize(Math.floor(W * PR), Math.floor(H * PR), false);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  w.fitTargets(W, H, PR, 0, FXT);
  w.resize(W, H, PR);
  cam.aspect = W / H;
  cam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- the turn

interface HitDef {
  /** spray angle (degrees, + to the right), where it comes down (world metres from home, or at the wall), how high, its apex and hang */
  spray: number;
  dist: number | 'wall';
  y1: number;
  apex: number;
  hang: number;
  power: number;
  sweet: boolean;
  hr?: boolean;
}

interface PitchDef {
  name: string;
  /** where it crosses the contact plane, and its speed (world m/s) */
  px: number;
  py: number;
  speed: number;
  hit?: HitDef;
}

const PITCHES: PitchDef[] = [
  { name: 'take', px: 0.16, py: 0.74, speed: 34 },
  { name: 'homer', px: -0.04, py: 0.86, speed: 33, hit: { spray: -14, dist: 30, y1: 1.4, apex: 12.5, hang: 3.8, power: 0.95, sweet: true, hr: true } },
  { name: 'fly', px: 0.1, py: 0.95, speed: 32, hit: { spray: 7, dist: 20.5, y1: 0, apex: 11.5, hang: 3.5, power: 0.7, sweet: false } },
  { name: 'foul', px: -0.2, py: 0.8, speed: 33, hit: { spray: -41, dist: 24, y1: 2.2, apex: 8, hang: 2.7, power: 0.8, sweet: false } },
  { name: 'wall', px: 0.08, py: 0.9, speed: 33, hit: { spray: 21, dist: 'wall', y1: 1.35, apex: 7.2, hang: 2.4, power: 0.85, sweet: false } },
  { name: 'bomb', px: 0.02, py: 0.9, speed: 35, hit: { spray: 23, dist: 46, y1: 0, apex: 18.5, hang: 5.0, power: 1, sweet: true, hr: true } },
];

const REL = { x: -FIELD.releaseSide, y: FIELD.releaseY, z: FIELD.releaseZ };
const MITT_Z = FIELD.catcherZ - 0.35;
const G = FIELD.gravity;

interface Pitch extends PitchDef {
  t0: number;
  release: number;
  /** crossing the contact plane, into the mitt */
  tc: number;
  tm: number;
  T: number;
  /** the batted ball: landing point, vertical motion, drag */
  lx: number;
  lz: number;
  g: number;
  vy: number;
  k: number;
  /** when it crosses the fence (−1 = doesn't), comes down, and the play is over */
  tOut: number;
  tLand: number;
  end: number;
  out: THREE.Vector3;
  land: THREE.Vector3;
}

/** The pitch's position t seconds after release (it flies on past the plate into the mitt). */
function pitchAt(p: Pitch, t: number, o: THREE.Vector3) {
  const u = t / p.T;
  o.set(THREE.MathUtils.lerp(REL.x, p.px, u), THREE.MathUtils.lerp(REL.y, p.py, u) + 0.5 * G * 0.55 * p.T * p.T * u * (1 - u), THREE.MathUtils.lerp(REL.z, FIELD.contactZ, u));
  return o;
}

const contactPt = (p: Pitch, o: THREE.Vector3) => pitchAt(p, p.T, o);

/** The batted ball t seconds after contact (to its landing; then a bounce and a roll, or it stays in the stands). */
function battedAt(p: Pitch, t: number, o: THREE.Vector3) {
  const c = contactPt(p, tmpC);
  const h = p.hit!;
  const Tl = h.hang;
  if (t <= Tl) {
    const u = (1 - Math.exp(-p.k * t)) / (1 - Math.exp(-p.k * Tl));
    o.set(THREE.MathUtils.lerp(c.x, p.lx, u), c.y + p.vy * t - 0.5 * p.g * t * t, THREE.MathUtils.lerp(c.z, p.lz, u));
    return o;
  }
  const after = t - Tl;
  const dx = p.lx - c.x,
    dz = p.lz - c.z;
  const dl = Math.hypot(dx, dz) || 1;
  if (h.dist === 'wall') {
    // back off the wall and down to the track, one bounce, a short roll
    const back = Math.min(after, 1.4);
    const roll = 2.6 * (1 - Math.exp(-2.2 * back));
    const fall = Math.max(FIELD.ballR, h.y1 - 0.5 * G * after * after);
    const hop = after > 0.52 ? Math.max(0, 0.35 * Math.sin(Math.min(Math.PI, (after - 0.52) * 5))) : 0;
    o.set(p.lx - (dx / dl) * roll, after > 0.52 ? FIELD.ballR + hop : fall, p.lz - (dz / dl) * roll);
    return o;
  }
  if (!h.hr && h.y1 < 0.3) {
    // a hop and a roll on
    const hop = after < 0.5 ? Math.sin((after / 0.5) * Math.PI) * 0.45 : after < 0.75 ? Math.sin(((after - 0.5) / 0.25) * Math.PI) * 0.1 : 0;
    const roll = 3.2 * (1 - Math.exp(-1.8 * after));
    o.set(p.lx + (dx / dl) * roll, FIELD.ballR + hop, p.lz + (dz / dl) * roll);
    return o;
  }
  o.set(p.lx, h.y1 + FIELD.ballR, p.lz);
  return o;
}

const tmpC = new THREE.Vector3();
const pitches: Pitch[] = [];
let CYCLE = 0.8;
{
  const o = new THREE.Vector3();
  for (const d of PITCHES) {
    const t0 = CYCLE;
    const release = t0 + DELIVERY.release;
    const T = (FIELD.contactZ - REL.z) / d.speed;
    const vz = d.speed;
    const p: Pitch = { ...d, t0, release, tc: release + T, tm: release + T + (MITT_Z - FIELD.contactZ) / vz, T, lx: 0, lz: 0, g: 0, vy: 0, k: 0.45, tOut: -1, tLand: 0, end: 0, out: new THREE.Vector3(), land: new THREE.Vector3() };
    if (d.hit) {
      const h = d.hit;
      const a = (h.spray * Math.PI) / 180;
      const r = h.dist === 'wall' ? fenceAt(a) - FIELD.ballR : h.dist;
      const L = fieldPoint(a, r);
      p.lx = L.x;
      p.lz = L.z;
      const y0 = contactPt(p, o).y;
      const s = (Math.sqrt(2 * (h.apex - y0)) + Math.sqrt(2 * (h.apex - h.y1))) / h.hang;
      p.g = s * s;
      p.vy = Math.sqrt(2 * p.g * (h.apex - y0));
      p.tLand = p.tc + h.hang;
      p.land.set(L.x, h.y1, L.z);
      // where it crosses the fence
      if (h.hr)
        for (let t = 0; t < h.hang; t += 1 / 480) {
          battedAt(p, t, o);
          const sp = sprayOf(o.x, o.z);
          if (sp.r >= fenceAt(sp.a)) {
            p.tOut = p.tc + t;
            p.out.copy(o);
            break;
          }
        }
      p.end = p.tLand + (h.hr ? 2.6 : 2.0);
    } else p.end = p.tm + 1.2;
    pitches.push(p);
    CYCLE = p.end;
  }
  CYCLE += 0.6;
}

function pitchAtTime(tc: number) {
  for (const p of pitches) if (tc < p.end) return p;
  return null;
}

/** seconds into the cycle for pitch `name` and one of its moments, plus an offset */
function at(name: string, moment: 'windup' | 'release' | 'contact' | 'flight' | 'out' | 'land' | 'end' = 'windup', off = 0) {
  const p = pitches.find((x) => x.name === name);
  if (!p) return 0;
  const m = { windup: p.t0, release: p.release, contact: p.tc, flight: p.tc + (p.hit ? p.hit.hang * 0.5 : 0), out: p.tOut >= 0 ? p.tOut : p.tLand, land: p.hit ? p.tLand : p.tm, end: p.end }[moment];
  return m + off;
}

// ---------------------------------------------------------------- the fake game's view

const ball: FieldBall = { x: 0, y: -10, z: 0, phase: 'hand', speed: 0 };
const view: FieldView = { ball, tracer: false, color: COLOR, marks: [], eye: { x: 0, y: 1.9, z: 16.3 }, fx: [] };
const prevBall = new THREE.Vector3();
const tmpP = new THREE.Vector3();

function fake(tc: number, dt: number) {
  const t0 = tc - dt;
  view.fx.length = 0;
  view.marks.length = 0;
  const p = pitchAtTime(tc);
  // the ball
  if (!p || tc < p.release) {
    ball.phase = 'hand';
    ball.x = REL.x;
    ball.y = REL.y;
    ball.z = REL.z;
  } else if (!p.hit) {
    if (tc < p.tm) {
      ball.phase = 'pitch';
      pitchAt(p, tc - p.release, tmpP);
    } else {
      ball.phase = 'mitt';
      pitchAt(p, p.tm - p.release, tmpP);
    }
    ball.x = tmpP.x;
    ball.y = tmpP.y;
    ball.z = tmpP.z;
  } else if (tc < p.tc) {
    ball.phase = 'pitch';
    pitchAt(p, tc - p.release, tmpP);
    ball.x = tmpP.x;
    ball.y = tmpP.y;
    ball.z = tmpP.z;
  } else {
    battedAt(p, tc - p.tc, tmpP);
    ball.x = tmpP.x;
    ball.y = tmpP.y;
    ball.z = tmpP.z;
    // a home run's ball is gone once it's down in the stands (or out); a played one after its roll
    const gone = p.hit.hr ? tc > p.tLand + 0.35 : tc > p.tLand + 1.6;
    ball.phase = gone ? 'gone' : 'play';
  }
  ball.speed = dt > 0 ? prevBall.distanceTo(tmpP.set(ball.x, ball.y, ball.z)) / dt : 0;
  prevBall.set(ball.x, ball.y, ball.z);
  // the tracer: from contact until the next pitch leaves the hand
  let lastHit: Pitch | null = null;
  for (const x of pitches) if (x.hit && tc >= x.tc) lastHit = x;
  view.tracer = !!lastHit && (!p || p === lastHit || tc < p.release);
  // this turn's home runs, once down
  for (const x of pitches) if (x.hit?.hr && tc >= x.tLand) view.marks.push({ x: x.land.x, y: x.land.y, z: x.land.z });
  // effects starting this frame
  const crossed = (t: number) => t > t0 && t <= tc;
  for (const x of pitches) {
    if (!x.hit && crossed(x.tm)) {
      pitchAt(x, x.tm - x.release, tmpP);
      view.fx.push({ type: 'catch', x: tmpP.x, y: tmpP.y, z: tmpP.z });
    }
    if (!x.hit) continue;
    if (crossed(x.tc)) {
      contactPt(x, tmpP);
      view.fx.push({ type: 'contact', x: tmpP.x, y: tmpP.y, z: tmpP.z, power: x.hit.power, sweet: x.hit.sweet });
    }
    if (x.tOut >= 0 && crossed(x.tOut)) view.fx.push({ type: 'homerun', x: x.out.x, y: x.out.y, z: x.out.z });
    if (crossed(x.tLand)) {
      const f: FieldFx = x.hit.dist === 'wall' ? { type: 'wall', x: x.lx, y: x.hit.y1, z: x.lz } : { type: 'land', x: x.land.x, y: x.land.y, z: x.land.z, homeRun: !!x.hit.hr };
      view.fx.push(f);
    }
  }
}

// ---------------------------------------------------------------- cameras

type CamFn = (c: THREE.PerspectiveCamera) => void;
const BAT = { pos: new THREE.Vector3(0, 1.9, 16.3), look: new THREE.Vector3(0, 1.45, -4.5), fov: 34 };
const bat: CamFn = (c) => {
  c.position.copy(BAT.pos);
  c.lookAt(BAT.look);
  c.fov = BAT.fov;
};
const tv = new THREE.Vector3();
const CAMS: Record<string, CamFn> = {
  bat,
  wide: (c) => {
    c.position.set(-15.5, 15, 27.5);
    c.lookAt(0, 0, -2.5);
    c.fov = 46;
  },
  high: (c) => {
    c.position.set(0, 30, 31);
    c.lookAt(0, 0, -2);
    c.fov = 44;
  },
  flight: (c) => {
    // behind and above the batted ball as it flies (the last one, where it came down)
    let p: Pitch | null = null;
    for (const x of pitches) if (x.hit && clock >= x.tc) p = x;
    if (!p || (clock > p.end && pitchAtTime(clock) !== p)) return bat(c);
    const t = Math.min(clock, p.tLand) - p.tc;
    battedAt(p, t, tmpP);
    battedAt(p, Math.max(0, t - 0.1), tv);
    const dx = tmpP.x - tv.x,
      dz = tmpP.z - tv.z;
    const l = Math.hypot(dx, dz) || 1;
    const k = Math.min(1, t / 0.6);
    c.position.set(tmpP.x - (dx / l) * 8, Math.max(1.8, tmpP.y + 2.6 * k + 0.4), tmpP.z - (dz / l) * 8);
    // between the ball and where it's coming down, so the wall and the stands it's heading for are in view
    c.lookAt((tmpP.x + p.lx) / 2, Math.max(0.8, tmpP.y * 0.4), (tmpP.z + p.lz) / 2);
    c.fov = 52;
  },
  stands: (c) => {
    // this turn's home runs, from shallow centre field
    c.position.set(1.5, 3.2, 3.5);
    c.lookAt(-3, 3.2, -18);
    c.fov = 52;
  },
  side: (c) => {
    c.position.set(12.5, 3.2, 4);
    c.lookAt(0, 0.6, 4);
    c.fov = 50;
  },
  plate: (c) => {
    c.position.set(2.6, 2.6, 16.2);
    c.lookAt(0, 0, 11.6);
    c.fov = 44;
  },
  mound: (c) => {
    c.position.set(3.4, 1.7, -0.2);
    c.lookAt(0, 0.25, -4.3);
    c.fov = 44;
  },
  wall: (c) => {
    c.position.set(-2.5, 1.9, 1.5);
    c.lookAt(-8.5, 1.3, -9.5);
    c.fov = 46;
  },
  pole: (c) => {
    c.position.set(4, 1.8, 6);
    c.lookAt(10, 4.5, -4);
    c.fov = 48;
  },
  reverse: (c) => {
    c.position.set(0.8, 2.3, -8);
    c.lookAt(0, 1.0, 13);
    c.fov = 38;
  },
};
let camName = q.get('cam') ?? 'bat';
const CAM_KEYS = Object.keys(CAMS)
  .map((k, i) => `${(i + 1) % 10} ${k}`)
  .join(' · ');
function placeCam() {
  (CAMS[camName] ?? CAMS.bat)(cam);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  view.eye.x = cam.position.x;
  view.eye.y = cam.position.y;
  view.eye.z = cam.position.z;
  w.setView(0, cam);
}

// ---------------------------------------------------------------- loop

let clock = 0;
let total = 0;
let paused = still;
let benching = false;
const noBall = { x: 0, y: -20, z: 0 };

function step(dt: number) {
  clock += dt;
  total += dt;
  if (clock >= CYCLE) {
    clock -= CYCLE;
  }
  placeCam();
  fake(clock, dt);
  const fv: FrameView = { t: total, dt, realT: total, realDt: dt, ball: noBall, ballSpeed: 0, ballVisible: false, holder: -1, poses: CHARS ? poses : [], excitement: 0.4, state: 'play', cam, beat: 0, field: view };
  w.update(fv);
}

function render() {
  placeCam();
  w.render(cam, null);
  const p = pitchAtTime(clock);
  hud.textContent = `${def.name} (${def.id}) · cam ${camName} · ${p?.name ?? '—'} · ball ${ball.phase} ${ball.speed.toFixed(1)} m/s · tracer ${view.tracer ? 'on' : 'off'} · ${view.marks.length} HR · ${clock.toFixed(2)}/${CYCLE.toFixed(1)}${paused ? ' · paused' : ''}\n${CAM_KEYS} · space pause · ←/→ step · [ ] world`;
}

/** Jump to `t` seconds into the cycle (replaying from the start so every effect is where it would be) and draw it. */
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
  if (benching) return;
  if (!paused) step(dt);
  render();
}

window.addEventListener('keydown', (e) => {
  const names = Object.keys(CAMS);
  const k = e.key === '0' ? 10 : Number(e.key);
  if (k >= 1 && k <= names.length) camName = names[k - 1];
  else if (e.key === ' ') paused = !paused;
  else if (e.key === 'ArrowRight') step(1 / 30);
  else if (e.key === 'ArrowLeft') seek(Math.max(0, clock - 1 / 30));
  else if (e.key === ']' || e.key === '[') {
    const i = WORLDS.findIndex((d) => d.id === def.id);
    q.set('world', WORLDS[(i + (e.key === ']' ? 1 : WORLDS.length - 1)) % WORLDS.length].id);
    q.set('cam', camName);
    location.search = q.toString();
  }
});

// ---------------------------------------------------------------- for scripts

/** Draw calls and triangles the park adds (with and without it). */
function stats() {
  let meshes = 0,
    tris = 0;
  venue.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    let parent: THREE.Object3D | null = m.parent;
    while (parent) {
      if (!parent.visible) return;
      parent = parent.parent;
    }
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
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  };
  venue.group.visible = false;
  const without = calls();
  venue.group.visible = true;
  const withV = calls();
  return { meshes, tris: Math.round(tris), calls: withV.calls - without.calls, total: withV.calls, sceneTris: withV.tris };
}

/** CPU cost of the park's update (ms), averaged over n frames of the current moment. */
function perf(n = 600) {
  const dt = 1 / 60;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) venue.update(view, dt);
  return { venueMs: +((performance.now() - t0) / n).toFixed(4) };
}

/**
 * GPU time of a whole frame (timer queries) with the park on and off, taking
 * turns frame by frame so whatever else loads the GPU hits both alike: the
 * medians and the 10th percentiles (the least disturbed frames) of each.
 */
async function gpu(frames = 400, camera?: string) {
  if (camera) camName = camera;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  benching = true;
  // each frame's time, by frame; frames 2k and 2k+1 are a pair (one on, one off, in alternating order)
  const ms: (number | null)[] = new Array(frames).fill(null);
  const ons: boolean[] = [];
  const pending: { q: WebGLQuery; i: number }[] = [];
  const collect = () => {
    while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const p = pending.shift()!;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) ms[p.i] = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(p.q);
    }
  };
  for (let i = 0; i < frames; i++) {
    const on = (i & 1) === ((i >> 1) & 1);
    ons.push(on);
    venue.group.visible = on;
    const qq = gl.createQuery()!;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
    placeCam();
    w.render(cam, null);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pending.push({ q: qq, i });
    await new Promise((r) => requestAnimationFrame(r));
    collect();
  }
  for (let k = 0; k < 30 && pending.length; k++) {
    await new Promise((r) => requestAnimationFrame(r));
    collect();
  }
  venue.group.visible = true;
  benching = false;
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
  const pct = (a: number[], p: number) => +sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(3);
  const on: number[] = [],
    off: number[] = [],
    diff: number[] = [];
  for (let i = 0; i + 1 < frames; i += 2) {
    const a = ms[i],
      b = ms[i + 1];
    if (a === null || b === null) continue;
    (ons[i] ? on : off).push(a);
    (ons[i + 1] ? on : off).push(b);
    diff.push(ons[i] ? a - b : b - a);
  }
  // the middle half of the paired differences (contention hits both frames of a pair alike, mostly)
  const d = sorted(diff);
  const mid = d.slice(Math.floor(d.length * 0.25), Math.ceil(d.length * 0.75));
  const trimmed = mid.reduce((s, x) => s + x, 0) / Math.max(1, mid.length);
  return {
    on: { p10: pct(on, 0.1), p50: pct(on, 0.5) },
    off: { p10: pct(off, 0.1), p50: pct(off, 0.5) },
    pairs: diff.length,
    delta: { median: pct(diff, 0.5), trimmedMean: +trimmed.toFixed(3), p10: +(pct(on, 0.1) - pct(off, 0.1)).toFixed(3) },
  };
}

/** seek() and hand back the frame as a PNG data url (read in the same task as the draw) */
function capture(t: number, camera?: string) {
  seek(t, camera);
  return canvas.toDataURL('image/png');
}

/** Frame a custom camera and draw (for close-ups from scripts). */
function look(pos: [number, number, number], target: [number, number, number], fov = 45) {
  CAMS.custom = (c) => {
    c.position.set(...pos);
    c.lookAt(...target);
    c.fov = fov;
  };
  camName = 'custom';
  render();
  return canvas.toDataURL('image/png');
}

function timings() {
  return Object.fromEntries(pitches.map((p) => [p.name, { windup: p.t0, release: p.release, contact: p.tc, out: p.tOut, land: p.tLand, end: p.end }]));
}

(window as unknown as { field: unknown }).field = { ready: false, seek, capture, look, stats, perf, gpu, at, timings, cycle: CYCLE, venue, view, world: w };

if (q.has('t')) seek(Number(q.get('t')));
else seek(0);
paused = still;
(window as unknown as { field: { ready: boolean } }).field.ready = true;
requestAnimationFrame(frame);
