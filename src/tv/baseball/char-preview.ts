// Dev-only preview of baseball's characters — the batter, the pitcher, the
// catcher and a hitter waiting a turn — with their gear, in any world.
//
//   /batter-preview.html?world=park       park|plaza|ink|neon|pixel|paper|clay|water|cosmic
//     &cam=play|side|front|back|top|close|hero|portrait|pitcher|mound|catcher|wait|flip|wide
//     &t=12.3 (freeze at that moment of the cycle)   &handed=-1 (a left-handed batter)
//     &phand=-1 (a left-handed pitcher)   &seed=7 (other people)   &hair=afro (the batter's hair)
//     &hair2=… (the waiting hitter's)   &khair=… (the catcher's: the App gives the fielders caps)
//     &still=1 (wait for window.bb.seek)
//   keys: 1–9, 0 cameras · space pause · ←/→ step · [ ] previous / next world · h batter's hand · p pitcher's
//
// The field's being built elsewhere: the world's court is hidden (setSport
// with no venue) and a stand-in — grass, dirt, the plate, the boxes, the mound —
// is drawn here, with a stand-in ball for the pitch and the batted ball (the
// venue draws those in the game). It fakes what the game will drive: five
// pitches — a home run with a bat flip, a swing and a miss into the mitt, a
// take way outside, a liner that falls short, and a one-handed bomb — with the
// states running set → windup → the pitch through (aimX, aimY, contactZ) → a
// swing (or not) → watch → cheer / sad, the catcher catching and throwing it
// back, the pitcher following through and turning to watch, and the waiting
// hitter cheering along. The animators and the gear are driven exactly as the
// game will.

import '@fontsource/fredoka/latin-700.css';
import * as THREE from 'three';
import { WORLDS, worldDef } from '../worlds';
import type { FrameView } from '../worlds/base';
import { randomLook, type Hair } from '../chars/look';
import { Rng } from '../core/math';
import { FIELD, DELIVERY, SWING } from './field';
import type { BatterState, PitcherState, CatcherState, FieldBall, PitchKind, LookAt } from './types';
import { BatterAnimator, PitcherAnimator, CatcherAnimator, THROW, TOSS, BAT } from './anim';
import { BaseballGear } from './gear';

const q = new URLSearchParams(location.search);
const worldId = q.get('world') ?? 'park';
const handed = (Number(q.get('handed')) === -1 ? -1 : 1) as 1 | -1;
const phand = (Number(q.get('phand')) === -1 ? -1 : 1) as 1 | -1;
const still = q.has('still') || q.has('t');
const seed = Number(q.get('seed') ?? 3);
/** the batter, the waiting hitter, then the fielders: the pitcher and the catcher (in the App's navy) */
const NAVY = '#2c4a8c';
const COLORS = ['#3aa8ff', '#ff5a8c', NAVY, NAVY];

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
w.setSport('baseball');

const looks = [0, 1, 2, 3].map((i) => {
  const l = randomLook(new Rng(seed * 31 + i * 7), COLORS[i]);
  // the fielders: the home side in navy, caps on (as the App dresses them)
  return i < 2 ? l : { ...l, shirt: NAVY, shorts: '#f3f1ea', shoes: '#1d1b2a', hair: 'cap' as Hair, hat: '#1f3366', racket: '#c8a27a' };
});
const hairQ = q.get('hair');
if (hairQ) looks[0].hair = hairQ as Hair;
const hairQ2 = q.get('hair2');
if (hairQ2) looks[1].hair = hairQ2 as Hair;
const hairQ3 = q.get('khair');
if (hairQ3) looks[3].hair = hairQ3 as Hair;
w.setPlayers(looks);
const batterA = new BatterAnimator(handed, looks[0]);
const waiterA = new BatterAnimator(handed, looks[1]);
const pitcherA = new PitcherAnimator(phand, looks[2]);
const catcherA = new CatcherAnimator(looks[3]);
const gear = new BaseballGear(w, COLORS);

const cam = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 1500);
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

// ---------------------------------------------------------------- the stand-in field

function standIn() {
  const g = new THREE.Group();
  g.name = 'stand-in field';
  const id = def.id;
  const dark = id === 'neon' || id === 'cosmic';
  const grass = id === 'ink' ? '#e8dfcb' : id === 'neon' ? '#150b2c' : id === 'cosmic' ? '#1c1440' : id === 'pixel' ? '#00a84a' : id === 'paper' ? '#a9d98a' : id === 'clay' ? '#7cc46a' : '#74bb5c';
  const dirt = id === 'ink' ? '#d8cdb4' : dark ? '#2a1c52' : id === 'pixel' ? '#ab5236' : '#c99a62';
  const chalk = id === 'ink' ? '#15120f' : dark ? '#22e6ff' : '#ffffff';
  const M = (c: string) => new THREE.MeshLambertMaterial({ color: c });
  const flat = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo, m);
    o.rotation.x = -Math.PI / 2;
    o.position.set(x, y, z);
    o.receiveShadow = true;
    g.add(o);
    return o;
  };
  flat(new THREE.PlaneGeometry(160, 160), M(grass), 0, 0.001, 0);
  flat(new THREE.CircleGeometry(4.4, 48), M(dirt), 0, 0.004, FIELD.homeZ - 0.4);
  flat(new THREE.CircleGeometry(2.7, 40), M(dirt), 0, 0.004, FIELD.moundZ);
  // home plate
  const s = new THREE.Shape();
  const hw = 0.216;
  s.moveTo(-hw, 0);
  s.lineTo(hw, 0);
  s.lineTo(hw, 0.216);
  s.lineTo(0, 0.43);
  s.lineTo(-hw, 0.216);
  s.lineTo(-hw, 0);
  const plate = flat(new THREE.ShapeGeometry(s), M(chalk), 0, 0.008, FIELD.plateFront);
  plate.rotation.z = Math.PI;
  plate.rotation.x = Math.PI / 2;
  plate.rotation.set(-Math.PI / 2, 0, Math.PI);
  // the batter's boxes
  for (const sx of [-1, 1]) {
    const bx = sx * FIELD.boxX;
    const bz = FIELD.homeZ - 0.25;
    const L = 1.8,
      W = 1.2,
      t = 0.05;
    for (const [x, z, ww, hh] of [
      [bx, bz - L / 2, W, t],
      [bx, bz + L / 2, W, t],
      [bx - W / 2, bz, t, L],
      [bx + W / 2, bz, t, L],
    ])
      flat(new THREE.PlaneGeometry(ww, hh), M(chalk), x, 0.007, z);
  }
  // the rubber
  const rub = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.15), M(chalk));
  rub.position.set(0, 0.01, FIELD.moundZ);
  g.add(rub);
  return g;
}
w.scene.add(standIn());

// the stand-in ball (the venue draws it in the game)
const flyBall = new THREE.Mesh(new THREE.SphereGeometry(FIELD.ballR, 20, 14), new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#555555' }));
flyBall.visible = false;
w.scene.add(flyBall);

// ---------------------------------------------------------------- the pitches, paced as game.ts paces them

/** game.ts's BASEBALL_TIMING (what the characters feel of it), its hitstops, and its toss back */
const TM = { ready: 1.2, follow: 0.6, catchHold: 0.1, celebrate: 1.8, beat: 0.7, hrResult: 0.4, strikeResult: 0.3 };
const HITSTOP = { hit: 0.07, sweet: 0.11 };
/** a take's a strike once no swing can still be on its way (game.ts: SWING_OPEN after the ball crosses) */
const SWING_OPEN = 0.3;
const TOSS_FROM = new THREE.Vector3(TOSS.x, TOSS.y, FIELD.catcherZ + TOSS.z);
const TOSS_TO = new THREE.Vector3(0.3 * phand, 1.3, FIELD.moundZ + 0.45);

interface PlayDef {
  name: string;
  kind: PitchKind;
  /** where it crosses the contact plane: + away from the batter (m), height (m) */
  away: number;
  py: number;
  /** world m/s */
  speed: number;
  /**
   * hit: met on time · late: the swing's heard after the ball's in the mitt, and
   * the game rewinds everyone to the contact · miss: swung early · take
   */
  swing: 'hit' | 'late' | 'miss' | 'take';
  /** a miss is early (−), seconds */
  early?: number;
  power: number;
  lift: number;
  /** a batted ball: speed (world m/s), up (radians), spray (radians, + to the batter's pull side) */
  exit?: [number, number, number];
  /** a home run: 'flip' a no-doubter (sweet: cheer and the bat flip as soon as the swing's done), 'fence' cheer as it clears the fence */
  hr?: 'flip' | 'fence';
}

const PLAYS: PlayDef[] = [
  { name: 'homer', kind: 'fastball', away: -0.06, py: 0.86, speed: 29, swing: 'hit', power: 0.7, lift: 0.45, exit: [27, 0.58, 0.12], hr: 'flip' },
  { name: 'whiff', kind: 'curve', away: 0.2, py: 0.62, speed: 23, swing: 'miss', early: -0.1, power: 0.75, lift: 0.2 },
  { name: 'take', kind: 'slider', away: 0.22, py: 0.72, speed: 27, swing: 'take', power: 0, lift: 0 },
  { name: 'late', kind: 'fastball', away: 0.04, py: 0.8, speed: 30, swing: 'late', power: 0.85, lift: 0.3, exit: [28, 0.6, -0.05], hr: 'fence' },
  { name: 'liner', kind: 'changeup', away: 0.02, py: 1.06, speed: 21, swing: 'hit', power: 0.55, lift: -0.25, exit: [19, 0.2, -0.1] },
  { name: 'bomb', kind: 'fastball', away: -0.2, py: 0.62, speed: 31, swing: 'hit', power: 0.95, lift: 0.85, exit: [29, 0.66, 0.2], hr: 'fence' },
];

const G = FIELD.gravity;

/**
 * A pitch's moments. Game-clock moments (g…) run as game.ts's clock does; real
 * moments (the cycle's) differ after a contact by the hitstop, and — a late
 * swing — by the stretch replayed after the rewind.
 */
interface Play extends PlayDef {
  /** real: the play starts, and ends */
  t0: number;
  tend: number;
  /** game clock: the windup, the release, the crossing, into the mitt */
  tw: number;
  tr: number;
  tc: number;
  tca: number;
  /** real: the late swing's heard (everything rewinds to tc); the hitstop's length */
  tR: number;
  stop: number;
  /** game clock: the swing starts; a strike settles; the throw back starts; the ball clears the fence, lands */
  ts: number;
  settle: number;
  toss: number;
  fence: number;
  land: number;
  /** game clock: the batter's reaction, and what it is */
  react: number;
  reaction: 'cheer' | 'sad' | '';
  /** game clock: the play's over */
  gend: number;
  px: number;
  release: THREE.Vector3;
  v0: THREE.Vector3;
  catchP: THREE.Vector3;
  hitV: THREE.Vector3;
  cross: THREE.Vector3;
  tossV: THREE.Vector3;
}

const X0 = -handed * FIELD.boxX;
const Z0 = FIELD.homeZ - 0.2;
const WAIT = { x: handed * 3.3, z: FIELD.homeZ + 1.6 };

const plays: Play[] = [];
let CYCLE = 0.6;
for (const d of PLAYS) {
  const t0 = CYCLE;
  // (the game clock runs from t0 with the real one until a contact)
  const tw = t0 + TM.ready;
  const tr = tw + DELIVERY.release;
  const px = handed * d.away;
  const R = new THREE.Vector3(-phand * FIELD.releaseSide, FIELD.releaseY, FIELD.releaseZ);
  const Cp = new THREE.Vector3(px, d.py, FIELD.contactZ);
  const T1 = R.distanceTo(Cp) / d.speed;
  // a parabola through the release point and the crossing
  const v0 = Cp.clone().sub(R).divideScalar(T1);
  v0.y += 0.5 * G * T1;
  const tc = tr + T1;
  // where it reaches the catcher's mitt
  const zc = FIELD.catcherZ - 0.35;
  const Tc = (zc - R.z) / v0.z;
  const catchP = R.clone().addScaledVector(v0, Tc);
  catchP.y -= 0.5 * G * Tc * Tc;
  const tca = tr + Tc;
  const hit = d.swing === 'hit' || d.swing === 'late';
  const ts = d.swing === 'take' ? Infinity : tc - SWING.contact + (d.early ?? 0);
  const sweet = d.hr === 'flip';
  const stop = hit ? (sweet ? HITSTOP.sweet : HITSTOP.hit) : 0;
  // a late swing's heard once the ball's in the mitt: everything goes back to tc
  const tR = d.swing === 'late' ? tca + 0.07 : Infinity;
  // the batted ball
  const hitV = new THREE.Vector3();
  let land = Infinity,
    fence = Infinity;
  if (hit && d.exit) {
    const [v, up, spray] = d.exit;
    const a = -handed * spray; // pull side: a right-hander pulls to −x
    hitV.set(Math.sin(a) * Math.cos(up) * v, Math.sin(up) * v, -Math.cos(a) * Math.cos(up) * v);
    land = tc + (hitV.y + Math.sqrt(hitV.y * hitV.y + 2 * G * d.py)) / G;
    if (d.hr) fence = tc + 19 / Math.hypot(hitV.x, hitV.z);
  }
  // strikes: settled, then the catcher throws it back
  const settle = hit ? Infinity : d.swing === 'take' ? tc + SWING_OPEN : tca;
  const toss = settle + TM.catchHold;
  // the batter's reaction (game.ts's reaction() / verdict())
  let react = Infinity,
    reaction: Play['reaction'] = '';
  if (d.swing === 'miss') (react = ts + SWING.end), (reaction = 'sad');
  else if (d.swing === 'take') (react = settle), (reaction = 'sad');
  else if (d.hr === 'flip') (react = ts + SWING.end), (reaction = 'cheer');
  else if (d.hr === 'fence') (react = Math.max(ts + SWING.end, fence)), (reaction = 'cheer');
  else if (hit) (react = land), (reaction = 'sad');
  const gend = hit ? land + (d.hr ? TM.celebrate + TM.hrResult : TM.beat + 0.4) : toss + THROW.release + THROW.flight + 0.4;
  const tossV = new THREE.Vector3().subVectors(TOSS_TO, TOSS_FROM).divideScalar(THROW.flight);
  tossV.y += 0.5 * G * THROW.flight;
  // real time: the game clock plus the hitstop (and the replayed stretch after a rewind)
  const shift = d.swing === 'late' ? tR - tc + stop : stop;
  const tend = gend + shift;
  plays.push({ ...d, t0, tend, tw, tr, tc, tca, tR, stop, ts, settle, toss, fence, land, react, reaction, gend, px, release: R, v0, catchP, hitV, cross: Cp, tossV });
  CYCLE = tend;
}
CYCLE += 0.4;

function playAt(tc: number) {
  for (const p of plays) if (tc < p.tend) return p;
  return plays[plays.length - 1];
}

/**
 * The game clock at real time `r` in play p, and which story it's in: before a
 * late swing is heard the pitch is on its way to the mitt as if taken; from
 * then, it's the hit (the clock back at the contact, frozen for the hitstop).
 */
function clockAt(p: Play, r: number): { g: number; hitNow: boolean } {
  if (p.swing === 'late') {
    if (r < p.tR) return { g: r, hitNow: false };
    return { g: p.tc + Math.max(0, r - p.tR - p.stop), hitNow: true };
  }
  if (p.swing === 'hit') return { g: r < p.tc ? r : Math.max(p.tc, r - p.stop), hitNow: true };
  return { g: r, hitNow: false };
}

/** real seconds into the cycle for a play's moment (a game-clock one, mapped to the real clock), plus an offset */
function at(name: string, moment: 'set' | 'windup' | 'release' | 'load' | 'cross' | 'catch' | 'swing' | 'watch' | 'react' | 'throw' | 'land' | 'fence' | 'rewind' | 'contact' = 'set', off = 0) {
  const p = plays.find((x) => x.name === name);
  if (!p) return 0;
  const g: Record<string, number> = { windup: p.tw, release: p.tr, load: p.tr, cross: p.tc, catch: p.tca, swing: p.ts, watch: p.ts + SWING.end, react: p.react, throw: p.toss, land: p.land, fence: p.fence };
  if (moment === 'set') return p.t0 + off;
  if (moment === 'rewind') return (Number.isFinite(p.tR) ? p.tR : p.tc) + off;
  // the contact as shown: at tc on time, at the rewind for a late swing
  if (moment === 'contact') return (Number.isFinite(p.tR) ? p.tR : p.tc) + off;
  const m = g[moment];
  if (!Number.isFinite(m)) return p.t0 + off;
  // game → real: past the contact, add the hitstop (and a late swing's replay)
  const real = m <= p.tc || !(p.swing === 'hit' || p.swing === 'late') ? m : m + (p.swing === 'late' ? p.tR - p.tc + p.stop : p.stop);
  // (a late swing's catch is before the rewind, as it happened)
  if (p.swing === 'late' && moment === 'catch') return p.tca + off;
  return real + off;
}

// ---------------------------------------------------------------- the fake game's states

const batter: BatterState = { x: X0, z: Z0, handed, phase: 'stance', t: 0, lift: 0, power: 0, aimX: 0, aimY: 0.8, yaw: 0, look: null };
const waiter: BatterState = { x: WAIT.x, z: WAIT.z, handed, phase: 'idle', t: 0, lift: 0, power: 0, aimX: 0, aimY: 0.8, yaw: Math.atan2(WAIT.x - 0, WAIT.z - FIELD.homeZ + 0.8), look: null };
const pitcher: PitcherState = { x: 0, z: FIELD.moundZ, handed: phand, phase: 'set', t: 0, kind: null, look: null, toss: null };
const catcher: CatcherState = { x: 0, z: FIELD.catcherZ, phase: 'crouch', t: 0, targetX: 0, targetY: 0.8, arrive: 0.5, look: null };
const ball: FieldBall = { x: 0, y: 0, z: 0, phase: 'hand', speed: 0 };
const ballP = new THREE.Vector3();

function pitchPos(p: Play, g: number, o: THREE.Vector3) {
  const u = Math.min(g, p.tca) - p.tr;
  return o.copy(p.release).addScaledVector(p.v0, u).setY(p.release.y + p.v0.y * u - 0.5 * G * u * u);
}

function hitPos(p: Play, g: number, o: THREE.Vector3) {
  const u = Math.min(g, p.land) - p.tc;
  o.copy(p.cross).addScaledVector(p.hitV, u);
  o.y = p.cross.y + p.hitV.y * u - 0.5 * G * u * u;
  return o;
}

function tossPos(p: Play, g: number, o: THREE.Vector3) {
  const u = Math.max(0, Math.min(THROW.flight, g - p.toss - THROW.release));
  o.copy(TOSS_FROM).addScaledVector(p.tossV, u);
  o.y = TOSS_FROM.y + p.tossV.y * u - 0.5 * G * u * u;
  return o;
}

/** Everyone's state at real cycle time r (and the game clock it maps to). */
function fake(r: number) {
  const p = playAt(r);
  const { g, hitNow } = clockAt(p, r);
  const hit = hitNow;
  const launched = hit && g >= p.tc && r >= (p.swing === 'late' ? p.tR : p.tc) + p.stop;
  // the ball
  let look: LookAt = null;
  if (g < p.tr) {
    ball.phase = 'hand';
    ballP.set(-phand * FIELD.releaseSide, FIELD.releaseY, FIELD.releaseZ);
    look = { x: -phand * 0.3, y: 1.4, z: FIELD.moundZ + 0.6 };
  } else if (hit && g >= p.tc) {
    ball.phase = g < p.land + 1.2 ? 'play' : 'gone';
    hitPos(p, g, ballP);
    look = { x: ballP.x, y: ballP.y, z: ballP.z };
  } else if (!hit && g >= p.tca) {
    if (g < p.toss + THROW.release) {
      ball.phase = 'mitt';
      ballP.copy(p.catchP);
    } else if (g < p.toss + THROW.release + THROW.flight) {
      // the throw back: a thrown ball, like a pitch
      ball.phase = 'pitch';
      tossPos(p, g, ballP);
    } else {
      ball.phase = 'hand';
      ballP.set(-phand * FIELD.releaseSide, FIELD.releaseY, FIELD.releaseZ);
    }
    look = { x: ballP.x, y: ballP.y, z: ballP.z };
  } else {
    ball.phase = 'pitch';
    pitchPos(p, g, ballP);
    look = { x: ballP.x, y: ballP.y, z: ballP.z };
  }
  ball.x = ballP.x;
  ball.y = ballP.y;
  ball.z = ballP.z;
  ball.speed = ball.phase === 'pitch' ? p.speed : ball.phase === 'play' ? p.hitV.length() : 0;

  // the batter (game.ts: stance → load at the release → swing → the reaction)
  const b = batter;
  b.aimX = p.px;
  b.aimY = p.py;
  b.power = p.power;
  b.lift = p.lift;
  b.look = look;
  const B = (phase: BatterState['phase'], since: number) => ((b.phase = phase), (b.t = Math.max(0, g - since)));
  const swingAt = hit ? p.tc - SWING.contact : p.ts;
  if (g < p.tr) B('stance', p.t0);
  else if (g >= p.react) B(p.reaction || 'watch', p.react);
  else if (Number.isFinite(swingAt) && g >= swingAt && (hit || p.swing === 'miss')) B(g < swingAt + SWING.end ? 'swing' : 'watch', g < swingAt + SWING.end ? swingAt : swingAt + SWING.end);
  else B('load', p.tr);
  if (b.phase === 'watch' || b.phase === 'cheer') b.look = look;

  // the waiting hitter: watches the ball, cheers a home run as it clears the fence
  const wt = waiter;
  wt.look = ball.phase === 'play' || ball.phase === 'pitch' ? look : null;
  if (hit && p.hr && g >= p.fence) {
    wt.phase = 'cheer';
    wt.t = g - p.fence;
  } else {
    wt.phase = 'idle';
    wt.t = r;
  }

  // the pitcher (the delivery, the follow-through, then idle — or watching a ball in play)
  const P = pitcher;
  P.kind = p.kind;
  const endW = p.tw + DELIVERY.end;
  P.look = null;
  P.toss = null;
  if (g < p.tw) {
    P.phase = 'set';
    P.t = g - p.t0;
  } else if (g < endW) {
    P.phase = 'windup';
    P.t = g - p.tw;
  } else if (hit && launched) {
    P.phase = 'watch';
    P.t = g - Math.max(endW, p.tc);
    P.look = look;
  } else if (g < endW + TM.follow) {
    P.phase = 'follow';
    P.t = g - endW;
  } else {
    P.phase = 'idle';
    P.t = g - endW - TM.follow;
  }
  // the throw back coming: from when the catcher starts it till it's in the glove
  if (!hit && Number.isFinite(p.toss) && g >= p.toss) {
    const eta = p.toss + THROW.release + THROW.flight - g;
    if (eta > -0.5) P.toss = { x: TOSS_TO.x, y: TOSS_TO.y, z: TOSS_TO.z, eta };
  }

  // the catcher (the target set as the pitch is chosen; catch from the release; throw back; watch a ball in play)
  const K = catcher;
  K.targetX = p.catchP.x;
  K.targetY = p.catchP.y;
  K.arrive = p.tca - p.tr;
  K.look = null;
  if (g < p.tr) {
    K.phase = 'crouch';
    K.t = g - p.t0;
  } else if (launched) {
    K.phase = 'watch';
    K.t = g - p.tc;
    K.look = look;
  } else if (hit || g < p.toss) {
    K.phase = 'catch';
    K.t = g - p.tr;
  } else if (g < p.toss + THROW.end) {
    K.phase = 'throw';
    K.t = g - p.toss;
  } else {
    K.phase = 'crouch';
    K.t = g - p.toss - THROW.end;
  }
  return g;
}

// ---------------------------------------------------------------- cameras

type CamFn = (c: THREE.PerspectiveCamera) => void;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const h = handed;
const CAMS: Record<string, CamFn> = {
  // the game's batting view (camera.ts): behind the catcher, out at the pitcher
  play: (c) => {
    c.position.set(0.3 * h, 2.02, FIELD.homeZ + 4.7);
    c.lookAt(0.06 * h, 1.18, 2.4);
    c.fov = 33;
  },
  // any view: &cp=x,y,z (x mirrored for a left-handed batter) &cl=x,y,z (looking at) &fov=
  custom: (c) => {
    const v = (k: string, d: number[]) => (q.get(k)?.split(',').map(Number) ?? d).map((n, i) => (i === 0 ? n * h : n));
    const [px, py, pz] = v('cp', [0.3, 2.02, FIELD.homeZ + 4.7]);
    const [lx, ly, lz] = v('cl', [0.06, 1.18, 2.4]);
    c.position.set(px, py, pz);
    c.lookAt(lx, ly, lz);
    c.fov = Number(q.get('fov') ?? 33);
  },
  // the batter from across the plate, level with the hands
  side: (c) => {
    c.position.set(X0 + h * 3.6, 1.15, Z0 - 0.35);
    c.lookAt(X0 + h * 0.2, 0.92, Z0 - 0.3);
    c.fov = 40;
  },
  // from the mound's side, the swing coming at us
  front: (c) => {
    c.position.set(X0 + h * 1.1, 1.3, Z0 - 3.9);
    c.lookAt(X0 + h * 0.25, 0.95, Z0);
    c.fov = 38;
  },
  // over the batter's back shoulder
  back: (c) => {
    c.position.set(X0 - h * 2.8, 1.45, Z0 + 1.6);
    c.lookAt(X0 + h * 0.5, 0.9, Z0 - 0.5);
    c.fov = 40;
  },
  top: (c) => {
    c.position.set(X0 + h * 0.45, 5.2, Z0 - 0.45);
    c.up.set(0, 0, -1);
    c.lookAt(X0 + h * 0.45, 0.8, Z0 - 0.46);
    c.up.set(0, 1, 0);
    c.fov = 42;
  },
  // right on the contact point
  close: (c) => {
    const p = playAt(clock);
    c.position.set(X0 + h * 2.1, 1.05, Z0 - 2.0);
    c.lookAt(p.px - h * 0.35, p.py, FIELD.contactZ);
    c.fov = 36;
  },
  // camera.ts's hero shot: the batter celebrating, from out in front
  hero: (c) => {
    c.position.set(X0 + 1.25 * h, 1.5, Z0 - 3.3);
    c.lookAt(X0 + 0.1 * h, 1.28, Z0);
    c.fov = 32;
  },
  // camera.ts's portrait: stepping in
  portrait: (c) => {
    c.position.set(X0 + 2.45 * h, 1.46, Z0 - 1.68);
    c.lookAt(X0 + 0.12 * h, 1.18, Z0 + 0.05);
    c.fov = 30;
  },
  // the pitcher from the first-base side (the throwing arm's side for a right-hander)
  pitcher: (c) => {
    c.position.set(-phand * 3.9, 1.3, FIELD.moundZ + 0.75);
    c.lookAt(0, 1.0, FIELD.moundZ + 0.55);
    c.fov = 40;
  },
  // the pitcher from in front, a little to the side: roughly the batter's view, closer
  pitchfront: (c) => {
    c.position.set(phand * 1.4, 1.45, FIELD.moundZ + 5.2);
    c.lookAt(0, 1.05, FIELD.moundZ + 0.4);
    c.fov = 34;
  },
  // behind the pitcher: the television's view in
  mound: (c) => {
    c.position.set(0.5, 2.3, FIELD.moundZ - 5.5);
    c.lookAt(0, 1.0, FIELD.homeZ - 1);
    c.fov = 26;
  },
  // the catcher from in front, off to the side away from the batter
  catcher: (c) => {
    c.position.set(h * 2.1, 1.15, FIELD.catcherZ - 2.6);
    c.lookAt(0, 0.62, FIELD.catcherZ - 0.1);
    c.fov = 36;
  },
  // the catcher side-on (the squat's silhouette)
  catchside: (c) => {
    c.position.set(h * 3.2, 0.8, FIELD.catcherZ - 0.2);
    c.lookAt(0, 0.62, FIELD.catcherZ - 0.2);
    c.fov = 36;
  },
  wait: (c) => {
    c.position.set(WAIT.x - h * 1.6, 1.4, WAIT.z - 2.8);
    c.lookAt(WAIT.x, 1.0, WAIT.z);
    c.fov = 38;
  },
  // following the flipped bat
  flip: (c) => {
    c.position.set(X0 - h * 1.8, 1.9, Z0 - 4.4);
    c.lookAt(X0 - h * 0.6, 1.3, Z0 - 0.2);
    c.fov = 42;
  },
  wide: (c) => {
    c.position.set(-9, 7.5, FIELD.homeZ + 9);
    c.lookAt(0, 0.6, FIELD.homeZ - 7);
    c.fov = 50;
  },
};
let camName = q.get('cam') ?? 'play';
const CAM_KEYS = Object.keys(CAMS)
  .map((k, i) => `${(i + 1) % 10}${i >= 10 ? "'" : ''} ${k}`)
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
/** the game clock last frame: the animators run on its steps (frozen in a hitstop), the gear on real time */
let lastG = 0;

function step(dt: number) {
  clock += dt;
  total += dt;
  if (clock >= CYCLE) clock -= CYCLE;
  const g = fake(clock);
  // a hitstop: the game clock stands still; a rewind: it jumps back (the states snap)
  let gdt = g - lastG;
  lastG = g;
  if (!(gdt > 1e-4)) gdt = 1e-4;
  gdt = Math.min(gdt, 0.1);
  const poses = [batterA.update(total, gdt, batter), waiterA.update(total, gdt, waiter), pitcherA.update(total, gdt, pitcher), catcherA.update(total, gdt, catcher)];
  placeCam();
  const fv: FrameView = { t: total, dt, realT: total, realDt: dt, ball: noBall, ballSpeed: 0, ballVisible: false, holder: -1, poses, excitement: 0.4, state: 'play', cam, beat: 0 };
  w.update(fv);
  gear.update({ hitters: [batter, waiter], pitcher, catcher, ball }, dt);
  // the stand-in flying ball: drawn bigger far from the camera, as the venue does — but only once it's
  // clear of the pitcher's hand (1:1 there and at the plate, like the gear's ball in a hand or the mitt)
  flyBall.visible = ball.phase === 'pitch' || ball.phase === 'play';
  flyBall.position.set(ball.x, ball.y, ball.z);
  const away = THREE.MathUtils.smoothstep(Math.hypot(ball.x, ball.y - FIELD.releaseY, ball.z - FIELD.releaseZ), 0.6, 4);
  const grow = THREE.MathUtils.clamp(1 + (flyBall.position.distanceTo(cam.position) - 9) * 0.045, 1, 2.1);
  flyBall.scale.setScalar(1 + (grow - 1) * away);
}

function render() {
  placeCam();
  w.render(cam, null);
  const p = playAt(clock);
  hud.textContent = `${def.name} (${def.id}) · cam ${camName} · ${p.name} · batter ${batter.phase} ${batter.t.toFixed(2)} · pitcher ${pitcher.phase} ${pitcher.t.toFixed(2)} · catcher ${catcher.phase} ${catcher.t.toFixed(2)} · ball ${ball.phase} · ${clock.toFixed(2)}/${CYCLE.toFixed(1)}${paused ? ' · paused' : ''}\n${CAM_KEYS} · space pause · ←/→ step · [ ] world · h / p hands`;
}

/** Jump to `t` seconds into the cycle (replaying from the start so every smoothing state is right) and draw it. */
function seek(t: number, camera?: string) {
  if (camera) camName = camera;
  clock = 0;
  total = 0;
  lastG = 0;
  const dt = 1 / 60;
  // replay at 60 Hz, landing exactly on t
  while (clock + dt <= t + 1e-9) step(dt);
  if (t - clock > 1e-6) step(t - clock);
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
  const n = e.key === '0' ? 9 : Number(e.key) - 1;
  if (e.key >= '0' && e.key <= '9' && names[n + (e.shiftKey ? 10 : 0)]) camName = names[n + (e.shiftKey ? 10 : 0)];
  else if (e.key === ' ') paused = !paused;
  else if (e.key === 'ArrowRight') step(1 / 30);
  else if (e.key === 'ArrowLeft') seek(Math.max(0, clock - 1 / 30));
  else if (e.key === 'h') setParam('handed', handed === 1 ? '-1' : '1');
  else if (e.key === 'p') setParam('phand', phand === 1 ? '-1' : '1');
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

/** seek() and hand back the frame as a PNG data url (read in the same task as the draw: the buffer is still there) */
function capture(t: number, camera?: string) {
  seek(t, camera);
  return canvas.toDataURL('image/png');
}

/** draw the frame as it stands (after a script changed something) and hand it back as a PNG data url */
function shot() {
  render();
  return canvas.toDataURL('image/png');
}

/**
 * A strip of frames — n moments from t0 to t1 — seen from one camera, laid out
 * in a grid (cols wide, each frame scaled by `scale`) with its time under it.
 */
function strip(t0: number, t1: number, n: number, camera: string, cols = 6, scale = 0.34, crop?: [number, number, number, number]) {
  const [cx, cy, cw, ch] = crop ?? [0, 0, 1, 1];
  const fw = Math.round(canvas.width * cw * scale),
    fh = Math.round(canvas.height * ch * scale);
  const rows = Math.ceil(n / cols);
  const out = document.createElement('canvas');
  out.width = fw * cols;
  out.height = (fh + 16) * rows;
  const x = out.getContext('2d')!;
  x.fillStyle = '#111';
  x.fillRect(0, 0, out.width, out.height);
  x.font = '12px system-ui';
  x.fillStyle = '#fff';
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? t0 : t0 + ((t1 - t0) * i) / (n - 1);
    seek(t, camera);
    const c = i % cols,
      r = Math.floor(i / cols);
    x.drawImage(canvas, canvas.width * cx, canvas.height * cy, canvas.width * cw, canvas.height * ch, c * fw, r * (fh + 16), fw, fh);
    x.fillText(`${t.toFixed(3)}  ${batter.phase} ${batter.t.toFixed(3)} / ${pitcher.phase} ${pitcher.t.toFixed(2)} / ${catcher.phase} ${catcher.t.toFixed(2)}`, c * fw + 4, r * (fh + 16) + fh + 12);
  }
  return out.toDataURL('image/png');
}

/** Draw calls the gear adds (with and without it). */
function stats() {
  const calls = () => {
    renderer.info.autoReset = false;
    renderer.info.reset();
    w.render(cam, null);
    renderer.info.autoReset = true;
    return renderer.info.render.calls;
  };
  const withG = calls();
  const hidden: THREE.Object3D[] = [];
  w.scene.traverse((o) => {
    if (['bat', 'helmet', 'glove', 'mitt', 'mask', 'chest-protector', 'baseball-held'].includes(o.name) && o.visible) hidden.push(o);
  });
  for (const o of hidden) o.visible = false;
  const without = calls();
  for (const o of hidden) o.visible = true;
  return { total: withG, gearCalls: withG - without, pieces: hidden.length };
}

/** CPU cost (ms) of a frame's animation and gear, averaged over n frames of the current moment. */
function perf(n = 600) {
  const dt = 1 / 60;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    batterA.update(total + i * dt, dt, batter);
    waiterA.update(total + i * dt, dt, waiter);
    pitcherA.update(total + i * dt, dt, pitcher);
    catcherA.update(total + i * dt, dt, catcher);
  }
  const ta = (performance.now() - t0) / n;
  const t1 = performance.now();
  for (let i = 0; i < n; i++) gear.update({ hitters: [batter, waiter], pitcher, catcher, ball }, dt);
  const tg = (performance.now() - t1) / n;
  return { animMs: +ta.toFixed(4), gearMs: +tg.toFixed(4) };
}

/** How exact the handovers are right now (world metres): the bat's sweet spot vs the aim at contact, etc. */
function probe() {
  const rig = w.rigs[0];
  rig.root.updateMatrixWorld(true);
  const bat = gear.bat(0);
  const sweet = bat ? new THREE.Vector3(0, BAT.sweet, 0).applyMatrix4(bat.getObjectByName('bat-mesh')!.matrixWorld) : null;
  const heldBall = w.scene.getObjectByName('baseball-held');
  return {
    batter: { ...batter },
    sweet: sweet && { x: +sweet.x.toFixed(4), y: +sweet.y.toFixed(4), z: +sweet.z.toFixed(4) },
    aim: { x: batter.aimX, y: batter.aimY, z: FIELD.contactZ },
    ball: { ...ball },
    held: heldBall && heldBall.visible ? { x: +heldBall.position.x.toFixed(4), y: +heldBall.position.y.toFixed(4), z: +heldBall.position.z.toFixed(4) } : null,
    fly: flyBall.visible ? { x: +flyBall.position.x.toFixed(4), y: +flyBall.position.y.toFixed(4), z: +flyBall.position.z.toFixed(4) } : null,
  };
}

/** each play's moments, real seconds into the cycle */
function timings() {
  const names = ['set', 'windup', 'release', 'cross', 'contact', 'catch', 'swing', 'watch', 'react', 'throw', 'fence', 'land', 'rewind'] as const;
  return Object.fromEntries(plays.map((p) => [p.name, { ...Object.fromEntries(names.map((m) => [m, +at(p.name, m).toFixed(3)])), end: +p.tend.toFixed(3) }]));
}

(window as unknown as { bb: unknown }).bb = { ready: false, seek, capture, shot, strip, stats, perf, probe, at, timings, cycle: CYCLE, gear, world: w, batter, pitcher, catcher, ball, anims: { batterA, waiterA, pitcherA, catcherA } };

if (q.has('t')) seek(Number(q.get('t')));
else seek(0);
paused = still;
(window as unknown as { bb: { ready: boolean } }).bb.ready = true;
requestAnimationFrame(frame);
