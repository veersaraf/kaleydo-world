// Dev-only preview of the sword-duel arena and the duellists, in any world.
//
//   /duel-preview.html?world=park        park|plaza|ink|neon|pixel|paper|clay|water|cosmic
//     &cam=play|side|far|wide|low   &t=12.3 (freeze at that moment of the cycle)
//     &handed=-1 (left-handers)   &seed=7 (other characters)   &still=1 (wait for window.duel.seek)
//   keys: 1–5 cameras · space pause · ←/→ step · [ ] previous / next world · h hand · f final round
//
// It fakes what the game will drive: both fighters' FighterStates from a
// scripted timeline — guards at four angles, slashes in eight directions, a
// thrust, a clean hit, a blocked attack and the stun, a clash, a fall off the
// end with the splash, win / lose, and the final round's shorter platform —
// and the DuelView (the platform's length, the effects). The world, its rigs,
// the venue and the fighters' gear are driven exactly as the game will.

import '@fontsource/fredoka/latin-700.css';
import * as THREE from 'three';
import { WORLDS, worldDef } from '../worlds';
import type { FrameView } from '../worlds/base';
import { randomLook } from '../chars/look';
import { Rng } from '../core/math';
import { DuelVenue } from './venue';
import { DuelAnimator } from './anim';
import { DuelGear } from './sword';
import { ARENA, FALL_T, startZ } from './arena';
import type { DuelFx, DuelView, FighterPhase, FighterState, SlashInput, SwordAim } from './types';

const q = new URLSearchParams(location.search);
const worldId = q.get('world') ?? 'park';
const handed = (Number(q.get('handed')) === -1 ? -1 : 1) as 1 | -1;
const still = q.has('still') || q.has('t');
const COLORS = ['#3aa8ff', '#ff5a8c'];

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
w.setSport('duel', (kit) => new DuelVenue(kit, { particles: w.particles, world: def.id }));
const venue = w.duelVenue as DuelVenue;

const seed = Number(q.get('seed') ?? 11);
const looks = [randomLook(new Rng(seed), COLORS[0]), randomLook(new Rng(seed + 12), COLORS[1])];
w.setPlayers(looks);
const anims = looks.map((l) => new DuelAnimator(handed, l));
const gear = new DuelGear(w, COLORS);

const cam = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 1200);
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

// ---------------------------------------------------------------- the fake fight

const TOP = ARENA.top;
const FULL = ARENA.length / 2;
const SHORT = ARENA.finalLength / 2;
const Z0 = startZ(0);
const Z1 = startZ(1);

/** a blade at `ang` across the fighter's view (0 = pointing right, π/2 = up), leaning `fwd` towards the opponent; the edge faces back at the fighter, as a phone's screen would */
function aimAt(ang: number, fwd = 0.3): SwordAim {
  const c = Math.cos(fwd),
    s = Math.sin(fwd);
  const b: [number, number, number] = [Math.cos(ang) * c, Math.sin(ang) * c, s];
  // (0, 0, −1) with the blade taken out
  const k = -b[2];
  const e: [number, number, number] = [0 - b[0] * k, 0 - b[1] * k, -1 - b[2] * k];
  const l = Math.hypot(...e) || 1;
  return { blade: b, edge: [e[0] / l, e[1] / l, e[2] / l] };
}
const EN_GARDE = aimAt(Math.PI / 2 - 0.15, 0.62);
const EASY = aimAt(Math.PI / 2 - 0.5, 0.75);
const slash = (dir: number, power = 0.8): SlashInput => ({ kind: 'slash', dir, power });
const THRUST: SlashInput = { kind: 'thrust', dir: 0, power: 0.8 };

function put(st: FighterState, phase: FighterPhase, t: number, aim: SwordAim, attack: SlashInput | null = null, push = 0) {
  st.phase = phase;
  st.t = t;
  st.aim = aim;
  st.attack = attack;
  st.push = push;
}

/** An attack played out: windup (if any), the strike, then recovery. */
function attackSeq(st: FighterState, u: number, a: SlashInput, windup: number, strike = 0.25) {
  if (u < windup) return put(st, 'windup', u, EN_GARDE, a);
  if (u < windup + strike) return put(st, a.kind, u - windup, EN_GARDE, a);
  put(st, 'recover', u - windup - strike, EN_GARDE, null);
}

interface Seg {
  name: string;
  dur: number;
  half?: number;
  run(u: number, f: FighterState[]): void;
  fx?: [number, (f: FighterState[]) => DuelFx][];
}

const home = (f: FighterState[]) => {
  f[0].z = Z0;
  f[1].z = Z1;
  f[0].x = f[1].x = 0;
};

const DIRS: [string, number][] = [
  ['chop', -Math.PI / 2],
  ['down-right', -Math.PI / 4],
  ['right', 0],
  ['up-right', Math.PI / 4],
  ['up', Math.PI / 2],
  ['up-left', (3 * Math.PI) / 4],
  ['left', Math.PI],
  ['down-left', (-3 * Math.PI) / 4],
];
const GUARDS: [string, number, number][] = [
  ['upright', Math.PI / 2, Math.PI],
  ['level', Math.PI, Math.PI / 2],
  ['diag-left', (3 * Math.PI) / 4, Math.PI / 4],
  ['diag-right', Math.PI / 4, (3 * Math.PI) / 4],
];

const pushed = (t: number, v0: number, k = 4) => (v0 * (1 - Math.exp(-k * t))) / k;

const SEGS: Seg[] = [
  {
    // walking on from the ends to the marks
    name: 'walk-on',
    dur: 1.8,
    run: (u, f) => {
      const k = Math.min(1, u / 1.5);
      const e = k * k * (3 - 2 * k);
      f[0].x = f[1].x = 0;
      f[0].z = Z0 + (FULL - 0.6 - Z0) * (1 - e);
      f[1].z = Z1 - (FULL - 0.6 + Z1) * (1 - e);
      put(f[0], 'idle', u, EASY);
      put(f[1], 'idle', u, EASY);
    },
  },
  {
    name: 'idle',
    dur: 1.4,
    run: (u, f) => {
      home(f);
      put(f[0], 'idle', u, EASY);
      put(f[1], 'idle', u, EASY);
    },
  },
  {
    name: 'ready',
    dur: 1.0,
    run: (u, f) => {
      home(f);
      put(f[0], 'ready', u, EN_GARDE);
      put(f[1], 'ready', u, EN_GARDE);
    },
  },
  ...GUARDS.map(
    ([name, a1, a0]): Seg => ({
      name: `guard ${name}`,
      dur: 0.9,
      run: (u, f) => {
        home(f);
        put(f[0], 'guard', u, aimAt(a0));
        put(f[1], 'guard', u, aimAt(a1));
      },
    }),
  ),
  ...DIRS.map(
    ([name, dir]): Seg => ({
      name: `slash ${name}`,
      dur: 1.1,
      run: (u, f) => {
        home(f);
        put(f[0], 'ready', u, EN_GARDE);
        attackSeq(f[1], u, slash(dir), 0.45);
      },
    }),
  ),
  {
    name: 'thrust',
    dur: 1.15,
    run: (u, f) => {
      home(f);
      put(f[0], 'ready', u, EN_GARDE);
      attackSeq(f[1], u, THRUST, 0.4, 0.35);
    },
  },
  {
    // fighter 0 cuts, fighter 1 takes it clean and is knocked back
    name: 'hit',
    dur: 1.8,
    run: (u, f) => {
      home(f);
      if (u < 0.15) put(f[0], 'ready', u, EN_GARDE);
      else attackSeq(f[0], u - 0.15, slash(-Math.PI / 4, 0.9), 0, 0.25);
      if (u < 0.3) put(f[1], 'ready', u, EN_GARDE);
      else if (u < 1.3) put(f[1], 'stagger', u - 0.3, EN_GARDE, null, 3 * Math.exp(-4 * (u - 0.3)));
      else put(f[1], 'ready', u - 1.3, EN_GARDE);
      f[1].z = Z1 - pushed(Math.max(0, u - 0.3), 3);
    },
    fx: [[0.3, (f) => ({ type: 'hit', x: f[1].x, y: TOP + 1.05, z: f[1].z + 0.15, strength: 0.9 })]],
  },
  {
    // fighter 1 swings; fighter 0's upright guard stops it: fighter 1 is stunned
    name: 'block',
    dur: 2.3,
    run: (u, f) => {
      home(f);
      put(f[0], u < 1.0 ? 'guard' : 'ready', u, u < 1.0 ? aimAt(Math.PI / 2) : EN_GARDE);
      const a = slash(0, 0.85);
      if (u < 0.4) put(f[1], 'windup', u, EN_GARDE, a);
      else if (u < 0.52) put(f[1], 'slash', u - 0.4, EN_GARDE, a);
      else if (u < 2.0) put(f[1], 'stunned', u - 0.52, EN_GARDE);
      else put(f[1], 'ready', u - 2.0, EN_GARDE);
    },
    fx: [[0.52, () => ({ type: 'block', x: 0.15, y: TOP + 1.15, z: 0.2, strength: 0.85 })]],
  },
  {
    // both swing at once: the blades meet
    name: 'clash',
    dur: 1.6,
    run: (u, f) => {
      home(f);
      for (const i of [0, 1]) {
        const a = slash(i === 0 ? 0 : Math.PI, 0.9);
        if (u < 0.35) put(f[i], 'windup', u, EN_GARDE, a);
        else if (u < 0.45) put(f[i], 'slash', u - 0.35, EN_GARDE, a);
        else if (u < 1.1) put(f[i], 'clash', u - 0.45, EN_GARDE, null, 1.2 * Math.exp(-6 * (u - 0.45)));
        else put(f[i], 'ready', u - 1.1, EN_GARDE);
      }
      const back = pushed(Math.max(0, u - 0.45), 1.2, 6);
      f[0].z = Z0 + back;
      f[1].z = Z1 - back;
    },
    fx: [[0.45, () => ({ type: 'clash', x: 0, y: TOP + 1.2, z: 0 })]],
  },
  {
    // at the edge: a clean hit knocks fighter 1 off the far end
    name: 'fall',
    dur: 3.4,
    run: (u, f) => {
      f[0].x = f[1].x = 0;
      f[0].z = -1.3;
      if (u < 0.2) put(f[0], 'ready', u, EN_GARDE);
      else attackSeq(f[0], u - 0.2, slash(Math.PI, 1), 0, 0.25);
      const z0 = -3.3,
        edge = -FULL;
      const tEdge = 0.3 + (z0 - edge) / 2.8;
      if (u < 0.3) {
        put(f[1], 'ready', u, EN_GARDE);
        f[1].z = z0;
      } else if (u < tEdge) {
        put(f[1], 'stagger', u - 0.3, EN_GARDE, null, 2.8);
        f[1].z = z0 - (u - 0.3) * 2.8;
      } else {
        put(f[1], 'fall', u - tEdge, EN_GARDE, null, 1.4);
        f[1].z = edge - (u - tEdge) * 1.4;
      }
    },
    fx: [
      [0.3, (f) => ({ type: 'hit', x: 0, y: TOP + 1.05, z: f[1].z + 0.15, strength: 1.2 })],
      [0.3 + 0.7 / 2.8 + FALL_T, (f) => ({ type: 'splash', x: f[1].x, z: f[1].z })],
    ],
  },
  {
    name: 'win-lose',
    dur: 2.6,
    run: (u, f) => {
      home(f);
      put(f[0], 'win', u, EN_GARDE);
      put(f[1], 'lose', u, EN_GARDE);
    },
  },
  {
    // the final round: the ends crack off and sink
    name: 'final',
    dur: 3.4,
    half: SHORT,
    run: (u, f) => {
      home(f);
      put(f[0], 'ready', u, EN_GARDE);
      put(f[1], u < 1.8 ? 'ready' : 'guard', u, u < 1.8 ? EN_GARDE : aimAt(Math.PI * 0.85));
    },
  },
];

const START: number[] = [];
let CYCLE = 0;
for (const s of SEGS) {
  START.push(CYCLE);
  CYCLE += s.dur;
}

function segAt(tc: number) {
  let i = SEGS.length - 1;
  while (i > 0 && START[i] > tc) i--;
  return i;
}

/** seconds into the cycle for `name` (a segment) plus an offset */
function at(name: string, off = 0) {
  const i = SEGS.findIndex((s) => s.name === name);
  return i < 0 ? 0 : START[i] + off;
}

const fighters: FighterState[] = [0, 1].map((i) => ({
  x: 0,
  z: i === 0 ? Z0 : Z1,
  facing: (i === 0 ? 1 : -1) as 1 | -1,
  handed,
  phase: 'idle' as FighterPhase,
  t: 0,
  aim: EN_GARDE,
  attack: null,
  push: 0,
}));
const view: DuelView = { halfLength: FULL, fx: [] };
let forceShort = false;

function fake(tc: number, dt: number) {
  const i = segAt(tc);
  const s = SEGS[i];
  const u = tc - START[i];
  s.run(u, fighters);
  view.halfLength = forceShort || s.half ? SHORT : FULL;
  view.fx.length = 0;
  const t0 = tc - dt;
  for (let k = 0; k < SEGS.length; k++)
    for (const [ft, make] of SEGS[k].fx ?? []) {
      const tt = START[k] + ft;
      if (tt > t0 && tt <= tc) view.fx.push(make(fighters));
    }
}

// ---------------------------------------------------------------- cameras

type CamFn = (c: THREE.PerspectiveCamera) => void;
const chest = TOP + 1.0;
const CAMS: Record<string, CamFn> = {
  // the gameplay camera: behind fighter 0, over the sword shoulder, looking at fighter 1 —
  // higher and wider than the brief's (0.9, top + 1.7, z0 + 3.4), which puts fighter 0's
  // head right in front of fighter 1 (see 'brief')
  play: (c) => {
    const a = fighters[0],
      b = fighters[1];
    c.position.set(1.5 * handed, TOP + 2.2, a.z + 3.4);
    c.lookAt(b.x, chest, b.z);
    c.fov = 46;
  },
  side: (c) => {
    const mid = (fighters[0].z + fighters[1].z) / 2;
    c.position.set(7.2, TOP + 1.2, mid);
    c.lookAt(0, TOP + 0.8, mid);
    c.fov = 40;
  },
  // the split-screen view: behind fighter 1 looking at fighter 0
  far: (c) => {
    const a = fighters[0],
      b = fighters[1];
    c.position.set(-1.5 * handed, TOP + 2.2, b.z - 3.4);
    c.lookAt(a.x, chest, a.z);
    c.fov = 46;
  },
  // exactly the brief's camera
  brief: (c) => {
    const a = fighters[0],
      b = fighters[1];
    c.position.set(0.9 * handed, TOP + 1.7, a.z + 3.4);
    c.lookAt(b.x, chest, b.z);
    c.fov = 46;
  },
  wide: (c) => {
    c.position.set(9.5, 7.5, 11.5);
    c.lookAt(0, 0.8, -0.5);
    c.fov = 42;
  },
  low: (c) => {
    c.position.set(4.2, 0.9, -7.2);
    c.lookAt(0, 1.3, -3.2);
    c.fov = 44;
  },
};
let camName = q.get('cam') ?? 'play';
const CAM_KEYS = Object.keys(CAMS)
  .map((k, i) => `${i + 1} ${k}`)
  .join(' · ');
function placeCam() {
  (CAMS[camName] ?? CAMS.play)(cam);
  cam.updateProjectionMatrix();
  w.setView(camName === 'far' ? 1 : 0, cam);
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
  const poses = anims.map((a, i) => a.update(total, dt, fighters[i]));
  const fv: FrameView = { t: total, dt, realT: total, realDt: dt, ball: noBall, ballSpeed: 0, ballVisible: false, holder: -1, poses, excitement: 0.35, state: 'play', cam, beat: 0, duel: view };
  w.update(fv);
  gear.update(fighters, dt, view.halfLength);
}

function render() {
  placeCam();
  w.render(cam, null);
  const f = fighters;
  const s = SEGS[segAt(clock)];
  hud.textContent = `${def.name} (${def.id}) · cam ${camName} · ${s.name} · ${f[0].phase} ${f[0].t.toFixed(2)} | ${f[1].phase} ${f[1].t.toFixed(2)} · ${clock.toFixed(2)}/${CYCLE.toFixed(1)}${paused ? ' · paused' : ''}\n${CAM_KEYS} · space pause · ←/→ step · [ ] world · h hand · f final`;
}

/** Jump to `t` seconds into the cycle (replaying from the start so every smoothing state is right) and draw it. */
function seek(t: number, camera?: string) {
  if (camera) camName = camera;
  clock = 0;
  total = 0;
  const dt = 1 / 60;
  // the venue's own smoothing (the sinking ends) replays too
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
  else if (e.key === 'f') forceShort = !forceShort;
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

// for scripts: window.duel.seek(t, cam) freezes a moment; stats() counts what the arena adds
function stats() {
  let meshes = 0,
    outlines = 0,
    tris = 0;
  venue.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (m.name === 'outline') outlines++;
    else meshes++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
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
  // the swords against the rackets they replace
  const swords = w.rigs.map((r) => r.racket.children.find((c) => c.userData.sword)).filter(Boolean) as THREE.Object3D[];
  swords.forEach((s) => (s.visible = false));
  const noSwords = calls();
  swords.forEach((s) => (s.visible = true));
  return { meshes, outlines, tris: Math.round(tris), calls: withV - without, swordCalls: withV - noSwords, total: withV };
}

/** seek() and hand back the frame as a PNG data url (read in the same task as the draw: the buffer is still there) */
function capture(t: number, camera?: string) {
  seek(t, camera);
  return canvas.toDataURL('image/png');
}

function timings() {
  return Object.fromEntries(SEGS.map((s, i) => [s.name, [START[i], s.dur]]));
}

(window as unknown as { duel: unknown }).duel = { ready: false, seek, capture, stats, at, timings, venue, gear, anims, fighters, world: w };

if (q.has('t')) seek(Number(q.get('t')));
else seek(0);
paused = still;
(window as unknown as { duel: { ready: boolean } }).duel.ready = true;
requestAnimationFrame(frame);
