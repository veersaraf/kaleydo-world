// Sword duel referee checks: the block rule through the game (mirroring,
// diagonals, a person's 35° line and a CPU's 55°, thrusts, a person's pointed
// guard), queued swings, knockback and the fall, the stun window,
// recovery, energy, clashes, rounds (timeout, draws, the final round), the order
// of events, effects, and the CPU (seeded, telegraphs its cuts, valid poses).
//   npx tsx scripts/check/duel-game-test.ts

import { DuelGame, DUEL_TIMING } from '../../src/tv/duel/game';
import { ARENA, FALL_T, startZ } from '../../src/tv/duel/arena';
import { bladeAngle, blocks, type DuelEvent, type Duelist, type SlashInput, type SwordAim } from '../../src/tv/duel/types';
import { cockAim, guardAim, readyAim } from '../../src/tv/duel/aim';
import { DuelAnimator } from '../../src/tv/duel/anim';
import type { FighterState } from '../../src/tv/duel/types';

let fails = 0;
let checks = 0;
const ok = (cond: boolean, msg: string, got?: unknown) => {
  checks++;
  if (!cond) {
    fails++;
    console.log('✗', msg, got === undefined ? '' : ['got', got]);
  }
};
const near = (a: number, b: number, tol: number, msg: string) => ok(Math.abs(a - b) <= tol, `${msg} (want ${b.toFixed(3)} ±${tol})`, +a.toFixed(4));
const deg = (d: number) => (d * Math.PI) / 180;

const look = {} as Duelist['look'];
const person = (slot: number, handed: 1 | -1 = 1): Duelist => ({ name: `P${slot}`, color: '#fff', look, handed, slot, cpu: null });
const cpu = (skill: number): Duelist => ({ name: 'CPU', color: '#fff', look, handed: 1, slot: -1, cpu: skill });
const cut = (dir: number, power = 0.5): SlashInput => ({ kind: 'slash', dir, power });
const thrust = (power = 0.5): SlashInput => ({ kind: 'thrust', dir: 0, power });

/** frame time for the checks (DUEL_DT=0.05 runs them at 20 fps) */
const DT = Number(process.env.DUEL_DT ?? 1 / 60);

function run(g: DuelGame, secs: number, dt = DT) {
  const end = g.t + secs;
  while (g.t < end - 1e-9) g.step(Math.min(dt, end - g.t));
}

/** two people, squared up, "Fight!" just called */
function fight(opts: ConstructorParameters<typeof DuelGame>[1] = {}, handed: [1 | -1, 1 | -1] = [1, 1]) {
  const g = new DuelGame([person(0, handed[0]), person(1, handed[1])], opts);
  const ev: DuelEvent[] = [];
  g.onEvent = (e) => ev.push(e);
  g.skip();
  run(g, DUEL_TIMING.ready + 0.02);
  return { g, ev };
}

const unit = (v: number[]) => Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-6;
const validAim = (a: SwordAim) => a.blade.every(Number.isFinite) && a.edge.every(Number.isFinite) && unit(a.blade) && unit(a.edge) && Math.abs(a.blade[0] * a.edge[0] + a.blade[1] * a.edge[1] + a.blade[2] * a.edge[2]) < 1e-6;

// ---------------------------------------------------------------- the walk-on, Ready, Fight

{
  const g = new DuelGame([person(0), person(1)]);
  const ev: DuelEvent[] = [];
  g.onEvent = (e) => ev.push(e);
  ok(g.state === 'intro' && g.fighters[0].phase === 'idle', 'starts in the intro, fighters idle');
  ok(g.fighters[0].facing === 1 && g.fighters[1].facing === -1, 'fighter 0 faces −z, fighter 1 +z');
  ok(g.fighters[0].z > startZ(0) && g.fighters[1].z < startZ(1), 'they walk on from further back');
  ok(validAim(g.fighters[0].aim) && Math.abs(bladeAngle(g.fighters[0].aim) - Math.PI / 2) < 1e-6, 'a person with no phone holds the ready stance (a valid aim)');
  run(g, DUEL_TIMING.intro + 0.02);
  ok(g.state === 'ready', 'the intro ends by itself', g.state);
  near(g.fighters[0].z, startZ(0), 1e-9, 'fighter 0 on the mark');
  near(g.fighters[1].z, startZ(1), 1e-9, 'fighter 1 on the mark');
  ok(g.fighters[0].x === 0 && g.fighters[1].x === 0, 'x = 0');
  ok(ev[0]?.type === 'round' && ev[0].round === 1 && !ev[0].final, 'the first round is announced', ev[0]);
  g.slash(0, cut(0));
  run(g, 0.3);
  ok(!ev.some((e) => e.type === 'attack') && g.fighters[1].phase === 'ready', "swings during Ready don't count");
  g.guard(1, true);
  run(g, 0.05);
  ok(g.fighters[1].phase === 'guard', 'the guard can go up during Ready');
  run(g, DUEL_TIMING.ready);
  ok(g.state === 'fight' && ev.some((e) => e.type === 'fight'), '"Fight!" after Ready');
  near(g.timeLeft, 45 - (g.t - g.stateT0), 1e-6, 'the clock runs from Fight');
}
{
  const g = new DuelGame([person(0), person(1)]);
  g.skip();
  ok(g.state === 'ready' && g.fighters[0].z === startZ(0), 'skip() goes straight to Ready on the marks');
}

// ---------------------------------------------------------------- the block rule, through the game

/** attacker slashes, defender holds a guard at `angle` (or not): what happens */
function exchange(att: 0 | 1, a: SlashInput, angle: number | null, handed: [1 | -1, 1 | -1] = [1, 1]) {
  const { g, ev } = fight({}, handed);
  const d = 1 - att;
  if (angle !== null) {
    g.aim(d, guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, angle, handed[d]));
    g.guard(d, true);
  }
  g.slash(att, a);
  run(g, 0.3);
  const e = ev.find((x) => x.type === 'hit' || x.type === 'block' || x.type === 'clash');
  return { g, what: e?.type ?? 'none', e };
}

const cases: [string, SlashInput, number | null, string][] = [
  ['cut to the right vs an upright guard', cut(0), Math.PI / 2, 'block'],
  ['cut to the right vs a flat guard', cut(0), 0, 'hit'],
  ['cut to the left vs an upright guard', cut(Math.PI), Math.PI / 2, 'block'],
  ['chop vs a flat guard', cut(-Math.PI / 2), 0, 'block'],
  ['chop vs an upright guard', cut(-Math.PI / 2), Math.PI / 2, 'hit'],
  ['rising cut vs a flat guard', cut(Math.PI / 2), 0, 'block'],
  // mirrored: down-and-right for the attacker runs down-and-LEFT across the defender's view (the / line)
  ['down-right diagonal vs a \\ guard', cut(-Math.PI / 4), (3 * Math.PI) / 4, 'block'],
  ['down-right diagonal vs a / guard (it lies along the cut once mirrored)', cut(-Math.PI / 4), Math.PI / 4, 'hit'],
  ['down-left diagonal vs a / guard', cut((-3 * Math.PI) / 4), Math.PI / 4, 'block'],
  ['down-left diagonal vs a \\ guard', cut((-3 * Math.PI) / 4), (3 * Math.PI) / 4, 'hit'],
  // a person's guard is judged kindly — the 35° line: a guard 40° off the cut's path stops it, 30° doesn't
  ['cut to the right vs a guard 40° across it', cut(0), deg(40), 'block'],
  ['cut to the right vs a guard 30° across it', cut(0), deg(30), 'hit'],
  ['down-right diagonal vs an upright guard (45° across)', cut(-Math.PI / 4), Math.PI / 2, 'block'],
  ['thrust vs a flat guard', thrust(), 0, 'block'],
  ['thrust vs an upright guard', thrust(), Math.PI / 2, 'block'],
  ['thrust, no guard', thrust(), null, 'hit'],
  ['cut, no guard', cut(0), null, 'hit'],
];
for (const [name, a, angle, want] of cases) {
  for (const att of [0, 1] as const) {
    const { what } = exchange(att, a, angle);
    ok(what === want, `${name} (fighter ${att} attacks)`, what);
  }
}
// the hand doesn't matter, only the blade's line
ok(exchange(0, cut(-Math.PI / 4), (3 * Math.PI) / 4, [1, -1]).what === 'block', "a left-hander's \\ guard stops the down-right diagonal too");
ok(exchange(0, cut(-Math.PI / 4), Math.PI / 4, [1, -1]).what === 'hit', "a left-hander's / guard doesn't");
{
  // a person's guard pointed straight at the opponent (a phone held like a remote) guards with
  // its broad side: screen up, it's a flat guard
  const pointed = (a: SlashInput, edge: [number, number, number] = [0, 1, -0.2]) => {
    const { g, ev } = fight();
    g.aim(1, { blade: [0.05, 0.2, 1], edge });
    g.guard(1, true);
    g.slash(0, a);
    run(g, 0.3);
    return ev.find((e) => e.type === 'hit' || e.type === 'block')?.type;
  };
  ok(pointed(thrust()) === 'block', 'a guard pointed at the opponent stops a thrust');
  ok(pointed(cut(-Math.PI / 2)) === 'block' && pointed(cut(0)) === 'hit', "…and, a person's, with the screen up (flat): a chop, not a side cut");
  ok(pointed(cut(0), [1, 0, -0.05]) === 'block' && pointed(cut(-Math.PI / 2), [1, 0, -0.05]) === 'hit', '…with the screen to the side (upright): a side cut, not a chop');
}
{
  // a CPU's guard needs the full 55°, and pointed it stops thrusts only
  const vsCpu = (angle: number | null, a: SlashInput, blade?: [number, number, number]) => {
    const g = new DuelGame([person(0), cpu(0.5)]);
    const ev: DuelEvent[] = [];
    g.onEvent = (e) => ev.push(e);
    g.skip();
    run(g, DUEL_TIMING.ready + 0.02);
    // (the CPU's own brain is switched off: the test holds its sword)
    const c = g as unknown as { cpus: ({ think: () => void; pose: () => void } | null)[] };
    for (const x of c.cpus) if (x) x.think = x.pose = () => {};
    if (blade) g.fighters[1].aim = { blade, edge: [0, 1, -0.2] };
    else g.fighters[1].aim = guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, angle!, 1);
    g.cpuGuard(1, true);
    run(g, 0.05);
    g.slash(0, a);
    run(g, 0.3);
    return ev.find((e) => e.type === 'hit' || e.type === 'block')?.type;
  };
  ok(vsCpu(deg(60), cut(0)) === 'block' && vsCpu(deg(50), cut(0)) === 'hit', "a CPU's guard: 60° across stops it, 50° doesn't");
  ok(vsCpu(null, cut(-Math.PI / 2), [0.05, 0.2, 1]) === 'hit' && vsCpu(null, thrust(), [0.05, 0.2, 1]) === 'block', "a CPU's guard pointed at you: thrusts only");
}
{
  // a swing that comes while bouncing off a clash goes as soon as that's over; one while reeling from a hit doesn't
  const { g, ev } = fight();
  g.slash(0, cut(0));
  g.slash(1, cut(0));
  run(g, 0.15);
  ok(g.fighters[0].phase === 'clash', 'a clash', g.fighters[0].phase);
  const n = ev.filter((e) => e.type === 'attack').length;
  g.slash(0, cut(-Math.PI / 2));
  run(g, DUEL_TIMING.clash + 0.02);
  ok(ev.filter((e) => e.type === 'attack').length === n + 1 && g.fighters[0].phase === 'slash', 'a swing during the clash goes when it ends');
}
{
  // the guard's aim is right but the button isn't held
  const { g, ev } = fight();
  g.aim(1, guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, Math.PI / 2));
  g.slash(0, cut(0));
  run(g, 0.3);
  ok(ev.some((e) => e.type === 'hit'), "a sword held across without the guard button doesn't block");
}
{
  // out of reach: a whiff
  const { g, ev } = fight();
  g.fighters[1].z = g.fighters[0].z - ARENA.reach - 0.2;
  g.slash(0, cut(0));
  run(g, 0.3);
  ok(!ev.some((e) => e.type === 'hit' || e.type === 'block' || e.type === 'clash'), 'out of reach: a whiff');
  ok(ev.some((e) => e.type === 'attack'), '…though the swing still happens');
}

// ---------------------------------------------------------------- knockback, the step after, the fall

{
  const { g, ev } = fight();
  const z1 = g.fighters[1].z;
  const z0 = g.fighters[0].z;
  g.slash(0, cut(-Math.PI / 2, 0.5));
  run(g, 0.12);
  const hit = ev.find((e) => e.type === 'hit');
  ok(hit?.type === 'hit' && hit.who === 1 && hit.by === 0, 'a clean hit: who and by', hit);
  near(hit?.type === 'hit' ? hit.strength : -1, 0.5, 1e-9, 'full arm: strength = power');
  ok(g.fighters[1].phase === 'stagger' && g.fighters[1].push > 0, 'the target staggers, pushed back');
  run(g, DUEL_TIMING.stagger);
  near(g.fighters[1].z - z1, -(0.4 + 0.8 * 0.5), 1e-6, 'a cut knocks back 0.4 + 0.8·strength m');
  ok(g.fighters[1].phase === 'ready', 'on their feet after the stagger', g.fighters[1].phase);
  run(g, 1);
  near(g.gap(), ARENA.gap, 1e-6, 'the attacker steps after them to keep the gap');
  near(z0 - g.fighters[0].z, 0.8, 1e-6, '…all the way (ground won is kept)');
}
{
  const { g } = fight();
  const z1 = g.fighters[1].z;
  g.slash(0, thrust(0.5));
  run(g, 0.6);
  near(z1 - g.fighters[1].z, 0.6 + 1.0 * 0.5, 1e-6, 'an unguarded thrust knocks back 0.6 + 1.0·strength m');
}
{
  // blocked thrust: the guard gives 0.3 m, the attacker is stunned 0.6 s
  const { g, ev } = fight();
  const z1 = g.fighters[1].z;
  g.guard(1, true);
  g.slash(0, thrust(0.9));
  run(g, 0.4);
  near(z1 - g.fighters[1].z, 0.3, 1e-6, 'a blocked thrust still shoves the guard back 0.3 m');
  const blockT = g.t - 0.3;
  ok(g.fighters[0].phase === 'stunned', 'the thrower is stunned');
  run(g, DUEL_TIMING.stunThrust - (g.t - blockT) + 0.05);
  ok(g.fighters[0].phase === 'ready', 'for 0.6 s after a thrust', g.fighters[0].phase);
  ok(ev.filter((e) => e.type === 'block').length === 1, 'one block');
}
{
  // hit after hit until they go off the end
  const { g, ev } = fight();
  let n = 0;
  for (let i = 0; i < 2000 && g.state === 'fight'; i++) {
    if (g.fighters[0].phase === 'ready' && g.fighters[1].phase !== 'stagger' && g.gap() <= ARENA.reach - 0.05 && g.energy[0] > 0.9) {
      g.slash(0, cut(0, 0.7));
      n++;
    }
    g.step(DT);
  }
  ok(g.state === 'fall', 'knocked back hit after hit, they go over the end', g.state);
  ok(n >= 3 && n <= 4, 'it takes 3–4 hits of 0.7 from the start (2.8 m to go)', n);
  const f1 = g.fighters[1];
  ok(f1.phase === 'fall' && f1.push >= 1.2 && f1.push <= 2, 'falling, carried over at 1.2–2 m/s', f1.push);
  ok(-f1.z >= g.halfLength - 0.1, 'from the fall line (0.1 m in from the end)', f1.z);
  ok(ev.filter((e) => e.type === 'edge').length === 1 && ev.find((e) => e.type === 'edge')!.type === 'edge', "one 'edge' warning");
  const edge = ev.findIndex((e) => e.type === 'edge');
  const lastHit = ev.map((e) => e.type).lastIndexOf('hit');
  ok(edge >= 0 && edge < lastHit, "'edge' before the last, decisive hit");
  const fallT = g.t;
  run(g, FALL_T - 0.05);
  ok(!ev.some((e) => e.type === 'splash'), 'no splash yet');
  run(g, 0.1);
  const sp = ev.find((e) => e.type === 'splash');
  ok(sp?.type === 'splash' && sp.who === 1 && sp.z < -g.halfLength, 'the splash, off the end', sp);
  near(g.t - fallT, FALL_T, 0.1, 'FALL_T after going over');
  const re = ev.find((e) => e.type === 'round-end');
  ok(re?.type === 'round-end' && re.winner === 0 && !re.timeout && re.score[0] === 1 && re.score[1] === 0, 'the round to the one left standing', re);
  ok(g.fighters[0].phase === 'win' && g.fighters[1].phase === 'fall', "winner 'win'; the one in the water stays in 'fall' (fallY takes them under)");
  const fx = g.view().fx;
  ok(fx.some((f) => f.type === 'splash'), 'a splash effect');
}

// ---------------------------------------------------------------- stun, counters, recovery

{
  const { g, ev } = fight();
  g.aim(1, guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, Math.PI / 2));
  g.guard(1, true);
  g.slash(0, cut(0, 0.6));
  run(g, 0.11);
  const bi = ev.findIndex((e) => e.type === 'block');
  const b = ev[bi];
  ok(b?.type === 'block' && b.who === 1 && b.by === 0, 'blocked: who and by', b);
  ok(g.fighters[0].phase === 'stunned', 'the attacker is stunned');
  const t0 = g.t;
  run(g, 0.6);
  const n = ev.length;
  g.slash(0, cut(0));
  g.guard(0, true);
  run(g, 0.02);
  ok(ev.length === n && g.fighters[0].phase === 'stunned', "stunned: can't attack or guard");
  // the defender lets the guard go and counters inside the window
  const z0 = g.fighters[0].z;
  g.guard(1, false);
  g.slash(1, cut(-Math.PI / 2, 0.5));
  run(g, 0.12);
  const h = ev.find((e) => e.type === 'hit');
  ok(h?.type === 'hit' && h.who === 0 && h.by === 1 && g.t - t0 < DUEL_TIMING.stun, 'the counter lands inside the stun', h);
  run(g, DUEL_TIMING.stagger);
  near(g.fighters[0].z - z0, (0.4 + 0.8 * 0.5) * 1.1, 1e-6, 'a counter knocks back 10% further');
}
{
  const { g } = fight();
  g.guard(1, true);
  g.slash(0, cut(0));
  run(g, 0.11);
  ok(g.fighters[0].phase === 'stunned', 'stunned');
  run(g, DUEL_TIMING.stun - 0.05);
  ok(g.fighters[0].phase === 'stunned', 'still stunned just before 0.8 s');
  g.guard(0, true);
  run(g, 0.1);
  ok(g.fighters[0].phase === 'guard', 'after 0.8 s: free (the held guard comes up)', g.fighters[0].phase);
}
{
  // after a strike: 'recover', no guard yet; a swing during it goes as soon as it's over
  const { g, ev } = fight();
  g.fighters[1].z = g.fighters[0].z - 3.5; // whiffs, so nothing else happens
  g.slash(0, cut(0));
  run(g, DUEL_TIMING.strike + 0.02);
  ok(g.fighters[0].phase === 'recover', 'recovering after the strike', g.fighters[0].phase);
  g.guard(0, true);
  run(g, 0.05);
  ok(g.fighters[0].phase === 'recover', "can't guard while recovering");
  run(g, DUEL_TIMING.recover);
  ok(g.fighters[0].phase === 'guard', 'the guard comes up once recovered', g.fighters[0].phase);
  g.guard(0, false);
  run(g, 0.02);
  g.slash(0, cut(0));
  run(g, DUEL_TIMING.strike + 0.05);
  const n = ev.filter((e) => e.type === 'attack').length;
  g.slash(0, cut(Math.PI));
  run(g, 0.02);
  ok(ev.filter((e) => e.type === 'attack').length === n && g.fighters[0].phase === 'recover', 'a swing while recovering waits…');
  run(g, DUEL_TIMING.recover);
  ok(ev.filter((e) => e.type === 'attack').length === n + 1 && g.fighters[0].phase === 'slash', '…and goes as soon as it can');
  g.guard(0, true);
  const k = ev.filter((e) => e.type === 'attack').length;
  run(g, DUEL_TIMING.strike + DUEL_TIMING.recover + 0.05);
  g.slash(0, cut(0));
  run(g, 0.1);
  ok(ev.filter((e) => e.type === 'attack').length === k && g.fighters[0].phase === 'guard', 'no attacking while holding the guard');
}

// ---------------------------------------------------------------- energy

{
  const { g, ev } = fight();
  g.fighters[1].z = g.fighters[0].z - 3.5; // out of reach: just swinging
  const e: number[] = [];
  const whenReady = () => {
    while (g.fighters[0].phase !== 'ready') g.step(DT);
  };
  for (let i = 0; i < 4; i++) {
    whenReady();
    g.slash(0, cut(0, 1));
    e.push(g.energy[0]);
  }
  near(e[0], 0.7, 1e-9, 'a swing costs 0.3');
  ok(e[3] < 0.1, 'flailing drains the arm (4 swings back to back)', e);
  ok(ev.filter((x) => x.type === 'attack').length === 4, 'all four swung');
  whenReady();
  g.fighters[1].z = g.fighters[0].z - ARENA.gap;
  const before = g.energy[0];
  g.slash(0, cut(0, 1));
  run(g, 0.12);
  const h = ev.find((x) => x.type === 'hit');
  near(h?.type === 'hit' ? h.strength : -1, 0.35 + 0.65 * before, 1e-6, 'a tired arm hits feebly: strength = power × (0.35 + 0.65·energy)');
  run(g, 0.3);
  const a = g.energy[0];
  run(g, 1);
  near(g.energy[0] - a, 0.5, 0.02, 'it comes back at 0.5/s once resting');
  run(g, 3);
  ok(g.energy[0] === 1, 'up to full');
}

// ---------------------------------------------------------------- clashes

{
  const { g, ev } = fight();
  const z0 = g.fighters[0].z;
  const z1 = g.fighters[1].z;
  g.slash(0, cut(0));
  run(g, 0.05);
  g.slash(1, cut(-Math.PI / 2));
  run(g, 0.12);
  ok(ev.some((e) => e.type === 'clash') && !ev.some((e) => e.type === 'hit' || e.type === 'block'), 'strikes 0.05 s apart: a clash, nobody hurt');
  ok(g.fighters[0].phase === 'clash' && g.fighters[1].phase === 'clash', "both 'clash'");
  run(g, DUEL_TIMING.clash);
  ok(g.fighters[0].z > z0 && g.fighters[1].z < z1, 'both bounce back');
  run(g, 1);
  near(g.gap(), ARENA.gap, 1e-6, '…then step in again');
}
{
  const { g, ev } = fight();
  g.slash(0, cut(0));
  run(g, 0.15);
  g.slash(1, cut(-Math.PI / 2));
  run(g, 0.2);
  const h = ev.find((e) => e.type === 'hit');
  ok(!ev.some((e) => e.type === 'clash') && h?.type === 'hit' && h.who === 1, '0.15 s apart: the first one lands', h);
}
{
  // a person's strike landing on a windup: a clash if the windup's strike lands with it, else it's cut short
  const w = (lead: number) => {
    const { g, ev } = fight();
    g.cpuWindup(1, cut(-Math.PI / 2), 0.5);
    run(g, 0.5 - lead);
    g.slash(0, cut(0));
    run(g, 0.3);
    return ev.find((e) => e.type === 'clash' || e.type === 'hit' || e.type === 'block');
  };
  ok(w(0.05)?.type === 'clash', 'swinging into a windup just as it strikes: a clash', w(0.05));
  const h = w(0.3);
  ok(h?.type === 'hit' && h.who === 1, 'swinging into a windup early: it is cut short (hit)', h);
}

// ---------------------------------------------------------------- rounds, the clock, draws, the final

{
  // nobody moves: a draw on time, replayed; only twice a match, then the clock has to pick someone
  const { g, ev } = fight({ roundTime: 3, seed: 5 });
  run(g, 3.05);
  let re = ev.filter((e) => e.type === 'round-end');
  ok(re.length === 1 && re[0].type === 'round-end' && re[0].winner === null && re[0].timeout, 'time up, level: a draw', re[0]);
  ok(g.score[0] === 0 && g.score[1] === 0 && g.fighters[0].phase === 'idle', 'no point');
  run(g, DUEL_TIMING.roundEnd + 0.05);
  const r2 = ev.filter((e) => e.type === 'round');
  ok(r2.length === 2 && r2[1].type === 'round' && r2[1].round === 2 && !r2[1].final, 'and the round is replayed', r2);
  for (let i = 0; i < 3; i++) run(g, DUEL_TIMING.ready + 3 + DUEL_TIMING.roundEnd + 0.1);
  re = ev.filter((e) => e.type === 'round-end');
  const draws = re.filter((e) => e.type === 'round-end' && e.winner === null).length;
  ok(draws === 2, 'two draws at most', draws);
  ok(re.length >= 3 && re[2].type === 'round-end' && re[2].winner !== null, 'the third level timeout still goes to someone', re[2]);
}
{
  // ahead on time: one clean hit and then nothing
  const { g, ev } = fight({ roundTime: 4 });
  g.slash(1, cut(0, 0.5));
  run(g, 4.1);
  const re = ev.find((e) => e.type === 'round-end');
  ok(re?.type === 'round-end' && re.winner === 1 && re.timeout, "time up: whoever is further from their own end takes it", re);
  ok(g.fighters[1].phase === 'win' && g.fighters[0].phase === 'lose', "'win' and 'lose'");
}
{
  // a lead under 0.25 m is too close to call: a blocked cut gives 0.1 m, the attacker steps up 0.1 m
  const { g, ev } = fight({ roundTime: 4 });
  g.guard(1, true);
  g.slash(0, cut(0));
  run(g, 4.1);
  const re = ev.find((e) => e.type === 'round-end');
  near(g.edgeDist(0) - g.edgeDist(1), 0.2, 1e-6, 'a block: 0.2 m ahead');
  ok(re?.type === 'round-end' && re.winner === null, '…a draw', re);
}
{
  // a whole match: fighter 0 wins round 1, fighter 1 round 2, the final on the short platform, fighter 0 takes it
  const { g, ev } = fight({ seed: 1 });
  const push = (a: 0 | 1) => {
    const d = 1 - a;
    for (let i = 0; i < 4000 && (g.state === 'fight' || g.state === 'fall' || g.state === 'round-end' || g.state === 'ready'); i++) {
      if (g.state === 'round-end' && g.t - g.stateT0 > DUEL_TIMING.roundEnd - 0.05) {
        run(g, 0.1);
        return;
      }
      if (g.state === 'fight' && g.fighters[a].phase === 'ready' && g.fighters[d].phase !== 'stagger' && g.gap() <= ARENA.reach - 0.05 && g.energy[a] > 0.9) g.slash(a, cut(0, 0.8));
      g.step(DT);
    }
  };
  push(0);
  ok(g.score[0] === 1 && g.score[1] === 0 && g.halfLength === ARENA.length / 2, 'round 1 to fighter 0, same platform', [g.score, g.halfLength]);
  push(1);
  ok(g.score[0] === 1 && g.score[1] === 1, '1–1', g.score);
  ok(g.halfLength === ARENA.finalLength / 2 && g.view().halfLength === ARENA.finalLength / 2, 'the final at 1–1 is on the short platform', g.halfLength);
  const fr = ev.filter((e) => e.type === 'round').pop();
  ok(fr?.type === 'round' && fr.final && fr.round === 3, "the final round is announced as 'final'", fr);
  ok(g.fighters[0].z === startZ(0) && g.fighters[1].z === startZ(1), 'back on the marks', [g.fighters[0].z, g.fighters[1].z]);
  push(0);
  const over = ev.find((e) => e.type === 'over');
  ok(g.state === 'over' && over?.type === 'over' && over.winner === 0 && over.score[0] === 2 && over.score[1] === 1, 'over: 2–1', over);

  // the events, in order (walk-on skipped; each round's first swing and hit)
  const round = ['round', 'fight', 'attack', 'hit', 'edge', 'fall', 'splash', 'round-end'];
  const want = [...round, ...round, ...round, 'over'];
  const seq: string[] = [];
  let swung = false;
  let hit = false;
  for (const e of ev) {
    if (e.type === 'fight') swung = hit = false;
    if (e.type === 'attack' && swung) continue;
    if (e.type === 'hit' && hit) continue;
    if (e.type === 'attack') swung = true;
    if (e.type === 'hit') hit = true;
    seq.push(e.type);
  }
  ok(JSON.stringify(seq) === JSON.stringify(want), 'events in order', seq);
}
{
  const { g } = fight({ rounds: 1 });
  for (let i = 0; i < 4000 && g.state !== 'over'; i++) {
    if (g.state === 'fight' && g.fighters[0].phase === 'ready' && g.fighters[1].phase !== 'stagger' && g.gap() <= ARENA.reach - 0.05 && g.energy[0] > 0.9) g.slash(0, cut(0, 0.8));
    g.step(DT);
  }
  ok(g.state === 'over' && g.score[0] === 1 && g.toWin === 1, 'first to 1: one round and done');
}

// ---------------------------------------------------------------- effects are handed out once

{
  const { g } = fight();
  g.view();
  g.slash(0, cut(0, 0.5));
  run(g, 0.12);
  const v = g.view();
  ok(v.fx.length === 1 && v.fx[0].type === 'hit' && v.halfLength === ARENA.length / 2, 'a hit effect', v.fx);
  ok(g.view().fx.length === 0, 'cleared once read');
}

// ---------------------------------------------------------------- the phone's pose

{
  const { g } = fight();
  g.aim(0, { blade: [NaN, 0, 0], edge: [0, 0, 0] });
  ok(validAim(g.fighters[0].aim), 'a garbage pose falls back to a valid one');
  g.aim(0, { blade: [0, 3, 0], edge: [1, 1, 0] });
  ok(validAim(g.fighters[0].aim) && g.fighters[0].aim.blade[1] === 1, 'poses are normalised, the edge squared to the blade');
}

// ---------------------------------------------------------------- the CPU

function cpuMatch(a: number, b: number, seed: number, check?: (g: DuelGame) => void) {
  const g = new DuelGame([cpu(a), cpu(b)], { seed });
  const log: string[] = [];
  g.onEvent = (e) => log.push(`${g.t.toFixed(3)} ${JSON.stringify(e)}`);
  let k = seed;
  while (g.state !== 'over' && g.t < 900) {
    // frame times wander, deterministically
    k = (k * 1103515245 + 12345) & 0x7fffffff;
    g.step((1 / 60) * (0.7 + (0.6 * k) / 0x7fffffff));
    check?.(g);
  }
  return { g, log };
}
{
  const a = cpuMatch(0.65, 0.9, 7);
  const b = cpuMatch(0.65, 0.9, 7);
  ok(a.g.state === 'over', 'a CPU match finishes');
  ok(a.log.join('\n') === b.log.join('\n'), 'CPU matches are deterministic for a seed');
  ok(cpuMatch(0.65, 0.9, 8).log.join('\n') !== a.log.join('\n'), '…and differ between seeds');
}
{
  // it telegraphs: a cocked sword shows where the cut starts; poses are always valid
  let bad = 0;
  let seen = 0;
  let off = 0;
  const tmp = readyAim({ blade: [0, 0, 1], edge: [0, 1, 0] });
  cpuMatch(0.3, 0.9, 11, (g) => {
    for (const f of g.fighters) {
      if (!validAim(f.aim)) bad++;
      if (f.phase === 'windup' && f.attack?.kind === 'slash' && f.t > 0.25) {
        seen++;
        cockAim(tmp, f.attack);
        const d = Math.abs(Math.atan2(Math.sin(bladeAngle(f.aim) - bladeAngle(tmp)), Math.cos(bladeAngle(f.aim) - bladeAngle(tmp))));
        if (d > deg(20)) off++;
      }
    }
  });
  ok(bad === 0, 'CPU and person poses are always valid', bad);
  ok(seen > 50 && off / seen < 0.05, 'a CPU winding up holds its sword cocked where the cut starts (bladeAngle ≈ dir + π)', [off, seen]);
}
{
  // the telegraph, cut by cut: a CPU made to wind up, looked at two-thirds of the way in
  const cocked = (a: SlashInput) => {
    const g = new DuelGame([person(0), cpu(0.3)], { seed: 2 });
    g.skip();
    run(g, DUEL_TIMING.ready + 0.02);
    ok(g.cpuWindup(1, a, 0.6), 'a CPU can be made to wind up');
    run(g, 0.4);
    ok(g.fighters[1].phase === 'windup' && g.fighters[1].attack?.dir === a.dir, 'still winding up that cut');
    return g.fighters[1].aim.blade;
  };
  const up = cocked(cut(-Math.PI / 2));
  ok(up[1] > 0.7 && up[2] < 0, 'winding up a chop: sword raised overhead (and back)', up);
  const left = cocked(cut(0));
  ok(left[0] < -0.7, 'winding up a cut to the right: sword held out to the left', left);
  const upLeft = cocked(cut(-Math.PI / 4));
  ok(upLeft[0] < -0.5 && upLeft[1] > 0.5, 'winding up a cut down to the right: sword up on the left', upLeft);
}

{
  // it reads the sword: hold it cocked for a cut and the CPU's guard goes across that cut
  const held = (a: SlashInput) => {
    const g = new DuelGame([person(0), cpu(0.9)], { seed: 4 });
    g.skip();
    g.aim(0, cockAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, a));
    let looks = 0;
    let stops = 0;
    for (let i = 0; i < 60 * 12 && g.state !== 'over'; i++) {
      g.step(DT);
      if (g.state === 'fight' && g.fighters[1].phase === 'guard' && g.fighters[1].t > 0.4) {
        looks++;
        if (blocks(g.fighters[1].aim, a)) stops++;
      }
    }
    return [stops, looks];
  };
  for (const [name, a] of [['a chop', cut(-Math.PI / 2)], ['a cut to the right', cut(0)], ['a down-left diagonal', cut((-3 * Math.PI) / 4)]] as const) {
    const [stops, looks] = held(a);
    ok(looks > 60 && stops / looks > 0.8, `sword cocked for ${name}: the Ace guards across it`, [stops, looks]);
  }
}
{
  // it learns a habit: flick nothing but side cuts from the stance (nothing cocked to read)
  // and the Ace's guard soon stands upright against them
  const g = new DuelGame([person(0), cpu(0.9)], { seed: 3 });
  g.skip();
  let cuts = 0;
  let looks = 0;
  let stops = 0;
  let early = 0;
  let earlyStops = 0;
  for (let i = 0; i < 60 * 120 && g.state !== 'over'; i++) {
    const fighting = g.state === 'fight';
    // (the first cut waits a few seconds, to see how it guards knowing nothing)
    if (fighting && (cuts > 0 || g.t - g.stateT0 > 4) && g.fighters[0].phase === 'ready' && g.gap() <= ARENA.reach && i % 40 === 0) g.slash(0, cut(cuts++ % 2 ? 0 : Math.PI, 0.5));
    if (fighting && g.fighters[1].phase === 'guard' && g.fighters[1].t > 0.3) {
      const stop = blocks(g.fighters[1].aim, cut(0));
      if (cuts >= 5) (looks++, stop && stops++);
      else if (cuts === 0) (early++, stop && earlyStops++);
    }
    g.step(1 / 60);
  }
  ok(early > 20 && earlyStops / early < 0.3, 'knowing nothing, it guards against a chop (flat)', [earlyStops, early]);
  ok(looks > 200 && stops / looks > 0.75, 'after a few side cuts: it guards upright, against them', [stops, looks]);
}


// ---------------------------------------------------------------- latency: a message that's `age` s old

{
  // a strike delivered with age 0.12 lands as if it had been delivered 0.12 s earlier
  const trial = (age: number) => {
    const { g, ev } = fight();
    const hitAt: number[] = [];
    g.onEvent = (e) => {
      ev.push(e);
      if (e.type === 'hit') hitAt.push(g.t);
    };
    if (age === 0) {
      g.slash(0, cut(0, 0.6));
      run(g, 0.12);
    } else {
      run(g, age);
      g.slash(0, cut(0, 0.6), age);
    }
    run(g, 0.5);
    return { g, hitAt, ev };
  };
  const a = trial(0);
  const b = trial(0.12);
  ok(a.hitAt.length === 1 && b.hitAt.length === 1, 'both strikes land a clean hit', [a.hitAt, b.hitAt]);
  // (the age-0 one lands on the first frame after 0.1 s; the aged one the moment it arrives)
  ok(Math.abs(a.hitAt[0] - b.hitAt[0]) <= Math.max(DT, 1 / 60) + 1e-6, 'an aged strike lands within a frame of the one delivered earlier', [a.hitAt, b.hitAt]);
  near(b.g.fighters[1].z, a.g.fighters[1].z, 1e-6, 'the knockback is the same from the same moment');
  near(b.g.fighters[0].z, a.g.fighters[0].z, 1e-6, 'and so is the attacker following through');
  ok(a.g.fighters[0].phase === b.g.fighters[0].phase && Math.abs(a.g.fighters[0].t - b.g.fighters[0].t) < 1e-6, 'the attacker is as far into the recovery', [a.g.fighters[0].phase, b.g.fighters[0].phase]);
  // it starts that far into its strike
  const { g } = fight();
  g.slash(0, cut(0, 0.6), 0.06);
  near(g.fighters[0].t, 0.06, 1e-9, 'the strike starts 0.06 s in');
  ok(g.fighters[0].phase === 'slash', 'as a slash');
  // (an absurd age is clamped)
  const c = fight();
  c.g.slash(0, cut(0, 0.6), 99);
  ok(c.g.fighters[0].t <= 0.31, 'an absurd age is clamped', c.g.fighters[0].t);
}
{
  // a strike is judged against what the other fighter was doing when it landed
  const { g, ev } = fight();
  g.aim(1, guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, Math.PI / 2, 1));
  g.guard(1, true);
  run(g, 0.2);
  // the swing landed 0.1 s into its age; the guard was let go a moment after that, but before the message got here
  run(g, 0.14);
  g.guard(1, false);
  run(g, 0.01);
  g.slash(0, cut(0, 0.5), 0.15);
  run(g, 0.3);
  const first = ev.find((e) => e.type === 'hit' || e.type === 'block');
  ok(first?.type === 'block', 'the guard that was up when the blow landed stops it, though it has been let go since', first?.type);
}
{
  // a guard raised `age` ago covers a blow that landed since
  const guardTrial = (age: number, angle: number) => {
    const { g, ev } = fight();
    g.aim(0, guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, angle, 1));
    g.slash(1, cut(0, 0.6));
    run(g, 0.12); // the blow lands at 0.1: a clean hit — the guard message is still on its way
    const before = ev.filter((e) => e.type === 'hit').length;
    g.guard(0, true, age);
    run(g, 0.5);
    return { g, ev, before };
  };
  const rescued = guardTrial(0.15, Math.PI / 2);
  ok(rescued.before === 1, 'the blow first lands as a hit (the guard had not arrived)');
  ok(rescued.ev.some((e) => e.type === 'block' && e.who === 0 && e.by === 1), 'then the guard raised 0.15 s ago turns it into a block', rescued.ev.map((e) => e.type));
  ok(rescued.g.fighters[0].phase === 'guard', 'the defender stands guarding', rescued.g.fighters[0].phase);
  const blocksSeen = rescued.ev.filter((e) => e.type === 'block');
  ok(blocksSeen.length === 1 && blocksSeen[0].type === 'block' && blocksSeen[0].rescued === true, 'exactly one block event, flagged as rescued (it corrects the hit)', blocksSeen);
  ok(rescued.ev.filter((e) => e.type === 'hit').length === 1, 'and the one hit that was shown stays the only hit');
  ok(rescued.g.fighters[0].phase !== 'stagger' && rescued.g.fighters[0].push === 0, 'no lingering stagger or push');
  ok((rescued.g.fighters[0].snap ?? 0) === 1 && (rescued.g.fighters[1].snap ?? 0) === 0, "the rescued fighter's pose is flagged to cut, not ease");
  const ordinary = fight();
  ordinary.g.aim(0, guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, Math.PI / 2, 1));
  ordinary.g.guard(0, true);
  run(ordinary.g, 0.02);
  ordinary.g.slash(1, cut(0, 0.6));
  run(ordinary.g, 0.3);
  const ob = ordinary.ev.filter((e) => e.type === 'block');
  ok(ob.length === 1 && ob[0].type === 'block' && !ob[0].rescued && !ordinary.g.fighters[0].snap, 'a block in time is not flagged, and nothing snaps');
  ok(Math.abs(rescued.g.fighters[0].z - startZ(0)) < 0.2, 'and was not knocked back', rescued.g.fighters[0].z - startZ(0));
  const late = guardTrial(0.015, Math.PI / 2);
  ok(!late.ev.some((e) => e.type === 'block'), 'a guard that went up after the blow landed is too late', late.ev.map((e) => e.type));
  const across = guardTrial(0.15, 0);
  ok(!across.ev.some((e) => e.type === 'block'), "an early guard that doesn't lie across the cut doesn't stop it");
  const plain = guardTrial(0, Math.PI / 2);
  ok(!plain.ev.some((e) => e.type === 'block'), 'with no age the guard is just late (as before)');
  // the block is the same one as a guard raised in time
  const inTime = fight();
  inTime.g.aim(0, guardAim({ blade: [0, 0, 1], edge: [0, 1, 0] }, Math.PI / 2, 1));
  inTime.g.guard(0, true);
  run(inTime.g, 0.02);
  inTime.g.slash(1, cut(0, 0.6));
  run(inTime.g, 0.62);
  near(rescued.g.fighters[0].z, inTime.g.fighters[0].z, 1e-6, 'the rescued block gives the same ground as a guard raised in time');
  ok(rescued.g.fighters[1].phase === inTime.g.fighters[1].phase, 'and stuns the attacker the same', [rescued.g.fighters[1].phase, inTime.g.fighters[1].phase]);
}
{
  // a guard that's let go `age` ago stops guarding from then
  const { g } = fight();
  g.guard(0, true);
  run(g, 0.3);
  ok(g.fighters[0].phase === 'guard', 'guarding');
  g.guard(0, false, 0.1);
  ok(g.fighters[0].phase === 'ready' && Math.abs(g.fighters[0].t - 0.1) < 1e-9, 'let go 0.1 s ago: ready, 0.1 s in', [g.fighters[0].phase, g.fighters[0].t]);
}


{
  // a rescued fighter's pose cuts to the guard: it doesn't ease out of the reeling
  const pitchAfter = (snap: number) => {
    const a = new DuelAnimator(1, look);
    const st: FighterState = { x: 0, z: 1.5, facing: 1, handed: 1, phase: 'ready', t: 5, aim: readyAim({ blade: [0, 0, 1], edge: [0, -1, 0] }), attack: null, push: 0 };
    let t = 0;
    for (let i = 0; i < 30; i++, t += 1 / 60) a.update(t, 1 / 60, st);
    st.phase = 'stagger';
    for (let i = 0; i < 6; i++, t += 1 / 60) {
      st.t = i / 60;
      a.update(t, 1 / 60, st);
    }
    st.phase = 'guard';
    st.t = 0;
    st.snap = snap;
    return a.update(t, 1 / 60, st).bodyPitch;
  };
  const eased = pitchAfter(0);
  const snapped = pitchAfter(1);
  ok(eased > 0.2, 'sanity: without a snap the reeling lean is still on the body a frame later', eased);
  ok(snapped < 0.05, 'with a snap the body is already in the guard', snapped);
}

console.log(fails ? `${fails} of ${checks} duel checks FAILED.` : `All ${checks} duel checks passed.`);
if (fails) process.exit(1);
