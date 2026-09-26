// Bowling physics tuning runs: hundreds of slightly noisy throws per scenario
// → strike %, average pins, common leaves, splits, gutter %, plus sanity checks
// (nothing explodes, the ball never tunnels through a pin) and step() cost.
//
//   npx tsx scripts/bowl-sim.ts [throws per scenario = 300] [scenario filter]
//   npx tsx scripts/bowl-sim.ts 10 carry   → strike % by entry board × entry angle (for tuning the pins)
import { BowlPhysics } from '../src/tv/bowling/physics';
import { HEAD_Z, LANE, PIT_Z } from '../src/tv/bowling/lane';
import type { BallThrow, BowlPhysicsEvent } from '../src/tv/bowling/types';

const N = Number(process.argv[2] ?? 300);
const only = process.argv[3] ?? '';
const P = await BowlPhysics.load();

// seeded noise so runs are repeatable
let seed = 20260926;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

/** human variation (1σ): release board, aim (0.08°), speed, wrist — about ±1.3 boards (3.5 cm) at the pins, a decent bowler */
const NOISE = { x: 0.01, angle: 0.0014, speed: 0.15, spin: 0.025 };
const noisy = (t: BallThrow, k = 1): BallThrow => ({
  x: t.x + gauss() * NOISE.x * k,
  angle: t.angle + gauss() * NOISE.angle * k,
  speed: t.speed + gauss() * NOISE.speed * k,
  spin: Math.max(-1, Math.min(1, t.spin + gauss() * NOISE.spin * k)),
});

const FULL = new Array(10).fill(true);
const rackOf = (...pins: number[]) => FULL.map((_, i) => pins.includes(i + 1));

interface Roll {
  down: number;
  racked: number;
  leave: number[];
  gutter: boolean;
  /** where the ball is headed at the head-pin line (extrapolated from before it touches a pin), and its angle (° towards −x = into a right-hander's pocket) */
  entryX: number;
  entryDeg: number;
  hits: number;
  ballHits: number;
  pits: number;
  maxSpeed: number;
  settleT: number;
  stepMs: number[];
  bad: string[];
}

function roll(t: BallThrow, rack: boolean[] = FULL, dt = 1 / 60): Roll {
  P.rack(rack);
  const r: Roll = { down: 0, racked: rack.filter(Boolean).length, leave: [], gutter: false, entryX: NaN, entryDeg: NaN, hits: 0, ballHits: 0, pits: 0, maxSpeed: 0, settleT: 0, stepMs: [], bad: [] };
  P.onEvent = (e: BowlPhysicsEvent) => {
    if (e.type === 'gutter') r.gutter = true;
    else if (e.type === 'hit') {
      r.hits++;
      if (e.ballOnPin) r.ballHits++;
      r.maxSpeed = Math.max(r.maxSpeed, e.impact);
    } else if (e.type === 'pit') r.pits++;
  };
  P.throw(t);
  let px = P.view.ball.x;
  let pz = P.view.ball.z;
  let simT = 0;
  let tPins = NaN;
  while (P.phase !== 'settled' && simT < 40) {
    const t0 = performance.now();
    P.step(dt);
    r.stepMs.push(performance.now() - t0);
    simT += dt;
    const b = P.view.ball;
    // read the line where the ball can't have touched a pin yet, then extrapolate to the head pin
    const zr = HEAD_Z + 0.25;
    if (isNaN(r.entryX) && b.z <= zr && pz > zr) {
      const f = (pz - zr) / (pz - b.z);
      const tan = (b.x - px) / (b.z - pz);
      r.entryX = b.gutter ? b.x : px + (b.x - px) * f - tan * 0.25;
      r.entryDeg = (Math.atan(tan) * 180) / Math.PI;
    }
    if (P.phase === 'pins' && isNaN(tPins)) tPins = simT;
    px = b.x;
    pz = b.z;
    for (const p of [b, ...P.view.pins]) {
      if (![p.x, p.y, p.z, p.qx, p.qy, p.qz, p.qw].every(Number.isFinite)) r.bad.push('NaN pose');
    }
  }
  r.settleT = simT - tPins;
  if (P.phase !== 'settled') r.bad.push('never settled');
  const st = P.standing();
  for (let i = 0; i < 10; i++) {
    if (rack[i] && st[i]) r.leave.push(i + 1);
    const p = P.view.pins[i];
    if (!p.visible) continue;
    // everything must stay inside the lane box: deck, gutters, kickbacks, pit
    if (Math.abs(p.x) > LANE.width / 2 + LANE.gutter + 0.02 || p.y < -LANE.pitDepth - 0.05 || p.y > 1 || p.z > HEAD_Z + 4 || p.z < PIT_Z - LANE.pitLength - 0.05) {
      r.bad.push(`pin ${i + 1} escaped (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
    }
  }
  r.down = r.racked - r.leave.length;
  return r;
}

/** Where a throw crosses the head-pin line (x; a gutter ball reports its gutter) and at what angle — the lane model alone, no pins. */
function aimProbe(t: BallThrow): { x: number; deg: number } {
  const r = roll(t, new Array(10).fill(false), 1 / 240);
  return { x: r.entryX, deg: r.entryDeg };
}

/** Solve the release angle that brings the ball to `targetX` at the head pin (bisection; x is monotonic in angle). */
function aimAt(t: Omit<BallThrow, 'angle'>, targetX: number): BallThrow {
  let lo = -0.12;
  let hi = 0.12;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const x = aimProbe({ ...t, angle: mid }).x;
    if (x > targetX) hi = mid;
    else lo = mid;
  }
  return { ...t, angle: (lo + hi) / 2 };
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;
const leaveName = (l: number[]) => (l.length ? l.join('-') : 'X');
const ADJ: Record<number, number[]> = { 1: [2, 3], 2: [1, 3, 4, 5], 3: [1, 2, 5, 6], 4: [2, 5, 7, 8], 5: [2, 3, 4, 6, 8, 9], 6: [3, 5, 9, 10], 7: [4, 8], 8: [4, 5, 7, 9], 9: [5, 6, 8, 10], 10: [6, 9] };
/** a split: the head pin is down and the pins left standing aren't all next to each other */
function isSplit(l: number[]): boolean {
  if (l.length < 2 || l.includes(1)) return false;
  const seen = new Set([l[0]]);
  const todo = [l[0]];
  while (todo.length) {
    for (const q of ADJ[todo.pop()!]) {
      if (l.includes(q) && !seen.has(q)) {
        seen.add(q);
        todo.push(q);
      }
    }
  }
  return seen.size < l.length;
}
const allMs: number[] = [];
let totalBad = 0;

function scenario(name: string, base: BallThrow, rack: boolean[] = FULL, noise = 1, n = N) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  const clean = roll(base, rack);
  const leaves = new Map<string, number>();
  let clears = 0;
  let splits = 0;
  let pins = 0;
  let gutters = 0;
  let hits = 0;
  let maxHits = 0;
  let ballHits = 0;
  let settle = 0;
  let maxSettle = 0;
  let impact = 0;
  const entries: number[] = [];
  const bad: string[] = [];
  const racked = rack.filter(Boolean).length;
  for (let k = 0; k < n; k++) {
    const r = roll(noisy(base, noise), rack);
    if (r.down === racked) clears++;
    if (isSplit(r.leave)) splits++;
    pins += r.down;
    if (r.gutter) gutters++;
    hits += r.hits;
    maxHits = Math.max(maxHits, r.hits);
    ballHits += r.ballHits;
    settle += r.settleT;
    maxSettle = Math.max(maxSettle, r.settleT);
    impact = Math.max(impact, r.maxSpeed);
    if (!isNaN(r.entryX) && !r.gutter) entries.push(r.entryX);
    bad.push(...r.bad);
    allMs.push(...r.stepMs);
    const key = leaveName(r.leave);
    leaves.set(key, (leaves.get(key) ?? 0) + 1);
  }
  totalBad += bad.length;
  const top = [...leaves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([l, c]) => `${l} ${pct(c, n)}`).join(', ');
  const mean = entries.reduce((a, b) => a + b, 0) / Math.max(1, entries.length);
  const sd = Math.sqrt(entries.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, entries.length));
  const full = racked === 10;
  console.log(`\n■ ${name}`);
  console.log(`  throw x=${base.x.toFixed(3)} angle=${((base.angle * 180) / Math.PI).toFixed(2)}° speed=${base.speed} spin=${base.spin}` + ` → head-pin line x=${clean.entryX.toFixed(3)} at ${clean.entryDeg.toFixed(1)}°; noise-free: ${leaveName(clean.leave)}`);
  console.log(`  ${full ? 'strike' : 'spare'} ${pct(clears, n)} | avg pins ${(pins / n).toFixed(2)}/${racked}${full ? ` | splits ${pct(splits, n)}` : ''} | gutter ${pct(gutters, n)} | entry x ${mean.toFixed(3)} ± ${sd.toFixed(3)}`);
  console.log(`  leaves: ${top}`);
  console.log(`  hit events/throw ${(hits / n).toFixed(1)} (max ${maxHits}, ball-on-pin ${(ballHits / n).toFixed(1)}), max impact ${impact.toFixed(1)} m/s, settles ${(settle / n).toFixed(2)} s after the pins (max ${maxSettle.toFixed(2)})`);
  if (bad.length) console.log(`  !! ${bad.length} problems: ${[...new Set(bad)].slice(0, 5).join('; ')}`);
}

// --- the lane model on its own ---
if (!only || only === 'lane') {
  console.log('Lane model (spin hooks, straight release from the middle; hook = distance moved left at the head pin):');
  for (const [speed, spin] of [[7.5, 0], [7.5, 0.5], [7.5, 1], [7.5, -1], [5, 1], [9, 1]]) {
    const a = aimProbe({ x: 0.3 * Math.sign(spin || 0), speed, angle: 0, spin });
    console.log(`  ${speed} m/s spin ${spin}: hook ${(0.3 * Math.sign(spin || 0) - a.x).toFixed(2)} m, entry ${a.deg.toFixed(1)}°`);
  }
}

// --- scenarios ---
const hook = aimAt({ x: 0.15, speed: 7.5, spin: 1 }, 0.065);
const hookE = aimProbe(hook);
const hook7 = aimAt({ x: 0.15, speed: 7.5, spin: 0.7 }, 0.065);
const hook7E = aimProbe(hook7);
scenario(`(a) straight ball at the head pin`, { x: 0, speed: 8, angle: 0, spin: 0 });
scenario(`(a') straight ball at the head pin, tight aim (noise ×0.3)`, { x: 0, speed: 8, angle: 0, spin: 0 }, FULL, 0.3);
scenario(`(b) hook into the 1-3 pocket (entry ${hookE.deg.toFixed(1)}°)`, hook);
scenario(`(b') hook into the pocket, noise-free`, hook, FULL, 0, 1);
scenario(`(b") milder hook into the pocket (spin 0.7, entry ${hook7E.deg.toFixed(1)}°)`, hook7);
scenario(`(c) straight ball into the pocket`, aimAt({ x: 0.2, speed: 8, spin: 0 }, 0.065));
scenario(`(d) light pocket hit (hook to x=0.11)`, aimAt({ x: 0.15, speed: 7.5, spin: 1 }, 0.11));
scenario(`(d') high pocket hit (hook to x=0.02)`, aimAt({ x: 0.15, speed: 7.5, spin: 1 }, 0.02));
scenario(`(d") Brooklyn (hook to the 1-2 pocket, x=-0.065)`, aimAt({ x: 0.15, speed: 7.5, spin: 1 }, -0.065));
scenario(`(e) slow ball 4 m/s into the pocket`, aimAt({ x: 0.15, speed: 4, spin: 0 }, 0.065));
scenario(`(e') slow hook 5 m/s into the pocket`, aimAt({ x: 0.45, speed: 5, spin: 0.5 }, 0.065));
scenario(`(e") fast straight ball 10 m/s at the pocket`, aimAt({ x: 0.2, speed: 10, spin: 0 }, 0.065));
scenario(`(f) gutter ball`, { x: 0.4, speed: 7.5, angle: 0.01, spin: 0 });
scenario(`(g) spare: 10 pin (cross-lane, straight)`, aimAt({ x: -0.2, speed: 8, spin: 0 }, 0.457), rackOf(10));
scenario(`(g) spare: 7 pin (cross-lane, straight)`, aimAt({ x: 0.2, speed: 8, spin: 0 }, -0.457), rackOf(7));
scenario(`(g) spare: 3-6-10 (hook at the 3)`, aimAt({ x: 0.35, speed: 7.5, spin: 0.6 }, 0.2), rackOf(3, 6, 10));
scenario(`(g) spare: 7-10 split`, aimAt({ x: 0.2, speed: 8, spin: 0 }, 0.35), rackOf(7, 10));

// --- carry chart: strike % by where (board) and at what angle the ball meets the pins ---
if (only === 'carry') {
  // the ball is placed rolling just before the handover, reaching into the physics' private
  // lane-model state: the only way to pick an exact entry board and angle
  const inner = P as unknown as { b: { x: number; z: number; vx: number; vz: number; wx: number; wy: number; wz: number } };
  const BOARD = LANE.width / 39;
  const boards = [21.5, 20.5, 20, 19.5, 18.5, 17.5, 16.5, 15.5, 14.5];
  console.log(`Carry: strike % by entry board (17.5 = the 1-3 pocket, 20 = head-on, 22.5 = Brooklyn) × entry angle, ball rolling at ~6.7 m/s, ${N} throws per cell`);
  console.log('        ' + boards.map((b) => String(b).padStart(6)).join(''));
  for (const deg of [0, 2, 4, 6]) {
    const cells = boards.map((board) => {
      let strikes = 0;
      for (let i = 0; i < N; i++) {
        const a = ((deg + (rand() - 0.5) * 0.6) * Math.PI) / 180;
        const x = 0.065 + (17.5 - board) * BOARD + (rand() - 0.5) * 0.01;
        const sp = 6.7 + (rand() - 0.5) * 0.8;
        P.rack();
        P.throw({ x: 0, speed: 7, angle: 0, spin: 0 });
        const b = inner.b;
        b.z = HEAD_Z + 0.61;
        b.x = x + Math.tan(a) * 0.61;
        b.vx = -sp * Math.sin(a);
        b.vz = -sp * Math.cos(a);
        b.wx = b.vz / LANE.ballR;
        b.wz = -b.vx / LANE.ballR;
        b.wy = 0;
        for (let j = 0; j < 60 * 30 && P.phase !== 'settled'; j++) P.step(1 / 60);
        if (P.standing().every((up) => !up)) strikes++;
      }
      return pct(strikes, N).padStart(6);
    });
    console.log(`  ${deg}°    ` + cells.join(''));
  }
}

// --- tunnelling: a lone head pin at 10 and 14 m/s must always be hit, from dead centre to a thin edge ---
if (!only || only === 'tunnel') {
  let missed = 0;
  let tries = 0;
  for (const speed of [10, 14]) {
    for (let off = -0.15; off <= 0.1501; off += 0.01) {
      tries++;
      const r = roll({ x: off, speed, angle: 0, spin: 0 }, rackOf(1));
      const moved = r.ballHits > 0 || r.down > 0;
      if (!moved) {
        missed++;
        console.log(`  !! tunnel? ${speed} m/s offset ${off.toFixed(2)}: the pin was never touched`);
      }
    }
  }
  console.log(`\nTunnelling: ${tries - missed}/${tries} fast throws at a lone head pin (offsets ±15 cm) hit it`);
  totalBad += missed;
}

allMs.sort((a, b) => a - b);
if (allMs.length) {
  const q = (f: number) => allMs[Math.min(allMs.length - 1, Math.floor(f * allMs.length))].toFixed(3);
  console.log(`\nstep(1/60) cost: median ${q(0.5)} ms, p99 ${q(0.99)} ms, max ${q(1)} ms over ${allMs.length} frames`);
}
console.log(totalBad ? `\n${totalBad} PROBLEMS` : '\nNo problems (no NaNs, escapes, unsettled racks or tunnelling).');
P.dispose();
