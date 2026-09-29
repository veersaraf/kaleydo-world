// Archery checks: the flight (drop and wind drift at 15/22/30 m, drag, partial
// draws, the arrow pointing along its path, the same landing at any frame rate),
// aimFor, what an arrow meets (faces and their rings, the X, balloons that pop and
// let it fly on, the ground, the backstop, a shot lost over it), moving targets
// carrying their arrows, scoring and events, the draw (a weak draw put down,
// cancelDraw, DRAW held into a turn, the shake of a long hold), turns and ends,
// skip(), the view, the layouts, and the CPU (seeded, believable timing, allowing
// for drop and wind, averages by level).
//   npx tsx scripts/archery-game-test.ts        (ARCHERY_DT=0.05 runs them at 20 fps)

import { ArcheryGame, ARCHERY_TIMING, MIN_DRAW, type ArcheryOptions, type ArcheryShot } from '../src/tv/archery/game';
import { RANGE, ringOf } from '../src/tv/archery/range';
import type { Archer, ArcheryEvent, ArrowView, TargetDef } from '../src/tv/archery/types';
import { AIM_LIMIT, EYE, FLIGHT, aimDir, aimFor, flyTo, launch, newFlight, sightTo, targetX, type Aim } from '../src/tv/archery/physics';
import { BALLOON_BONUS, BALLOON_R, BIG_FACE_R, EXPERT_FACE_R, FACE_Y, WIND, balloonColor, layoutFor } from '../src/tv/archery/layouts';
import { Rng } from '../src/tv/core/math';

let fails = 0;
let checks = 0;
const ok = (cond: boolean, msg: string, got?: unknown) => {
  checks++;
  if (!cond) {
    fails++;
    console.log('✗', msg, got === undefined ? '' : ['got', got]);
  }
};
const near = (a: number, b: number, tol: number, msg: string) => ok(Math.abs(a - b) <= tol, `${msg} (want ${b.toFixed(4)} ±${tol})`, +a.toFixed(5));
const within = (a: number, lo: number, hi: number, msg: string) => ok(a >= lo && a <= hi, `${msg} (want ${lo}…${hi})`, +a.toFixed(4));

const look = {} as Archer['look'];
const person = (slot: number, color = '#e33', handed: 1 | -1 = 1): Archer => ({ name: `P${slot}`, color, look, handed, slot, cpu: null });
const cpu = (skill: number, color = '#39f'): Archer => ({ name: `CPU ${skill}`, color, look, handed: 1, slot: -1, cpu: skill });

/** frame time for the checks */
const DT = Number(process.env.ARCHERY_DT ?? 1 / 60);

function run(g: ArcheryGame, secs: number, dt = DT) {
  const end = g.t + secs;
  while (g.t < end - 1e-9) g.step(Math.min(dt, end - g.t));
}
function until(g: ArcheryGame, cond: () => boolean, max = 20, dt = DT) {
  const end = g.t + max;
  while (!cond() && g.t < end) g.step(dt);
  return cond();
}

const D15 = RANGE.lineZ - 15;
const D22 = RANGE.lineZ - 22;
const D30 = RANGE.lineZ - 30;

/** a range of our own, the same every end: a face (by default at 22 m, straight ahead) and whatever else */
function range(targets: Partial<TargetDef>[], wind = 0): ArcheryOptions['layout'] {
  return (_end, _rng, firstId) => ({
    targets: targets.map((t, i) => ({ id: firstId + i, kind: 'face' as const, x: 0, y: FACE_Y, z: D22, r: RANGE.faceR, bonus: 0, swayX: 0, swayT: 0, ...t })),
    main: 0,
    wind,
  });
}
const balloonAt = (x: number, y: number, z: number, swayX = 0, swayT = 0): Partial<TargetDef> => ({ kind: 'balloon', x, y, z, r: BALLOON_R, bonus: BALLOON_BONUS, swayX, swayT });

/** past the intro and the pause: the first arrow up and nocked */
function start(archers: Archer[] = [person(0)], opts: ArcheryOptions = {}, dt = DT) {
  const g = new ArcheryGame(archers, { seed: 1, ...opts });
  const ev: ArcheryEvent[] = [];
  g.onEvent = (e) => ev.push(e);
  g.skip();
  g.skip();
  run(g, ARCHERY_TIMING.nock + 0.02, dt);
  return { g, ev };
}

/** a person at `slot` shoots: aims, draws to `draw` (full: then holds `hold` s), and lets go
 *  on the aim (worked out at that moment if it's a function); back once the arrow's landed */
function shoot(g: ArcheryGame, slot: number, aim: Aim | (() => Aim), draw = 1, hold = 0.3, dt = DT): ArcheryShot {
  const get = () => (typeof aim === 'function' ? aim() : aim);
  let a = get();
  g.aim(slot, a.yaw, a.pitch);
  g.draw(slot, true);
  if (draw >= 1) {
    until(g, () => g.archer.phase === 'hold', 20, dt);
    run(g, hold, dt);
  } else until(g, () => g.archer.draw >= draw, 20, dt);
  a = get();
  g.aim(slot, a.yaw, a.pitch);
  g.draw(slot, false);
  until(g, () => g.state !== 'flight', 5, dt);
  return g.last!;
}

/** the full-draw aim that hits (dx, dy) from this target's centre in the game's wind — leading it if it moves (to be let go now) */
function aimAt(g: ArcheryGame, d: TargetDef, dx = 0, dy = 0, speed = RANGE.fullSpeed): Aim {
  let x = d.x;
  if (d.swayX) {
    const guess = aimFor(d.x, d.y, d.z, speed, g.wind);
    x = targetX(d, g.t + flyTo(guess.yaw, guess.pitch, speed, d.z, g.wind).t - g.endT0);
  }
  return aimFor(x + dx, d.y + dy, d.z, speed, g.wind);
}

const lastOf = <T extends ArcheryEvent['type']>(ev: ArcheryEvent[], type: T) => ev.filter((e) => e.type === type).pop() as Extract<ArcheryEvent, { type: T }> | undefined;

// ---------------------------------------------------------------- the flight

{
  const f = launch(newFlight(), 0.1, 0.05, RANGE.fullSpeed);
  const d = aimDir(0.1, 0.05);
  near(Math.hypot(f.vx, f.vy, f.vz), RANGE.fullSpeed, 1e-9, 'an arrow leaves at the launch speed');
  near(Math.hypot(f.x - EYE.x - d.x * FLIGHT.bow, f.y - EYE.y - d.y * FLIGHT.bow, f.z - EYE.z - d.z * FLIGHT.bow), 0, 1e-12, 'from the bow: along the aim from the eye');
  ok(aimDir(0.2, 0).x < 0 && aimDir(-0.2, 0).x > 0 && aimDir(0, 0).z === -1, 'yaw + turns left (towards −x), 0 is straight down the range (−z)');
  ok(aimDir(0, 0.2).y > 0, 'pitch + is up');
  near(Math.hypot(d.x, d.y, d.z), 1, 1e-12, 'aimDir is a unit vector');
  ok(EYE.x === 0 && EYE.z === RANGE.lineZ && EYE.y === RANGE.eyeY, 'the archer stands on the shooting line at x = 0; the aim is from the eye');
}
{
  // drop (aimed straight at a face centre) and a 4 m/s wind's drift
  const rows: [number, number, number, number, number][] = [
    [15, 0.4, 0.48, 0.07, 0.11],
    [22, 0.93, 1.05, 0.17, 0.24],
    [30, 1.8, 1.95, 0.3, 0.5],
  ];
  for (const [d, dLo, dHi, wLo, wHi] of rows) {
    const z = RANGE.lineZ - d;
    const s = sightTo(0, FACE_Y, z);
    const still = flyTo(s.yaw, s.pitch, RANGE.fullSpeed, z);
    within(FACE_Y - still.y, dLo, dHi, `full draw at ${d} m: drops this far below the sight line`);
    near(still.x, 0, 1e-9, `no wind at ${d} m: no drift`);
    const w4 = flyTo(s.yaw, s.pitch, RANGE.fullSpeed, z, 4);
    within(w4.x - still.x, wLo, wHi, `a 4 m/s wind drifts a ${d} m shot`);
    const w8 = flyTo(s.yaw, s.pitch, RANGE.fullSpeed, z, 8);
    near((w8.x - still.x) / (w4.x - still.x), 2, 0.01, `drift ∝ wind at ${d} m`);
    near(flyTo(s.yaw, s.pitch, RANGE.fullSpeed, z, -4).x, -(w4.x - still.x), 1e-6, `a wind the other way drifts it the other way (${d} m)`);
    near(w4.y, still.y, 1e-3, `the wind hardly changes the drop (${d} m)`);
  }
  const s30 = sightTo(0, FACE_Y, D30);
  const c30 = flyTo(s30.yaw, s30.pitch, RANGE.fullSpeed, D30);
  within(c30.speed / RANGE.fullSpeed, 0.93, 0.98, 'a little drag: 93–98% of the speed left at 30 m');
  within(c30.t, 0.6, 0.66, 'a full-draw arrow takes ~0.63 s to 30 m');
  // a weaker draw drops a lot more (∝ 1/speed², roughly)
  const s15 = sightTo(0, FACE_Y, D15);
  const full = FACE_Y - flyTo(s15.yaw, s15.pitch, RANGE.fullSpeed, D15).y;
  const three = FACE_Y - flyTo(s15.yaw, s15.pitch, RANGE.fullSpeed * 0.75, D15).y;
  near(three / full, 1 / 0.75 ** 2, 0.12, 'a 75% draw drops ~1.8× as far at 15 m');
}
{
  // aimFor hits the point: drop (and wind) allowed for
  let worst = 0;
  const pts: [number, number, number][] = [
    [0, FACE_Y, D15],
    [2.5, 3, D22],
    [-3.4, 4.3, RANGE.lineZ - 23],
    [0, FACE_Y, D30],
    [5, 0.6, 2],
    [-6, 6.5, RANGE.minZ],
  ];
  for (const [x, y, z] of pts) {
    for (const speed of RANGE.lineZ - z <= 22 ? [48, 36, 24] : [48, 36]) {
      for (const wind of [0, 3, -5]) {
        const a = aimFor(x, y, z, speed, wind);
        const c = flyTo(a.yaw, a.pitch, speed, z, wind);
        worst = Math.max(worst, c.ok ? Math.hypot(c.x - x, c.y - y) : 99);
      }
    }
  }
  ok(worst < 1e-3, 'aimFor: the arrow passes within 1 mm of the point (any speed, any wind)', worst);
  const a = aimFor(0, FACE_Y, D30);
  const s = sightTo(0, FACE_Y, D30);
  ok(a.pitch > s.pitch + 0.05 && Math.abs(a.yaw) < 1e-9, 'at 30 m it aims ~3.6° over the face, not to the side', [a.pitch - s.pitch, a.yaw]);
  const aw = aimFor(0, FACE_Y, D30, RANGE.fullSpeed, 4);
  ok(aw.yaw > 0.01, 'with the wind blowing to +x it aims into it (to the left, + yaw)', aw.yaw);
  const far = aimFor(0, FACE_Y, RANGE.minZ, 8);
  ok(Number.isFinite(far.yaw) && Number.isFinite(far.pitch) && far.pitch <= AIM_LIMIT.pitchMax, 'out of reach: still a sane aim (the steepest allowed)', far);
  const sl = sightTo(1, 2, -5);
  const dd = aimDir(sl.yaw, sl.pitch);
  const L = Math.hypot(1 - EYE.x, 2 - EYE.y, -5 - EYE.z);
  near(Math.hypot(EYE.x + dd.x * L - 1, EYE.y + dd.y * L - 2, EYE.z + dd.z * L + 5), 0, 1e-9, 'sightTo points the aim straight at the point');
}

// ---------------------------------------------------------------- in the game: the same landing at any frame rate, the arrow along its path

{
  const spots: ArcheryShot[] = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 144, 0.05]) {
    const { g } = start([person(0)], { layout: range([{}], 2.5) }, dt);
    spots.push(shoot(g, 0, aimAt(g, g.mainTarget(), 0.21, -0.13), 1, 0.3, dt));
  }
  const d = Math.max(...spots.map((s) => Math.hypot(s.px - spots[1].px, s.py - spots[1].py)));
  ok(d < 0.002, 'the same shot lands within 2 mm at 30, 60, 144 and 20 fps', d);
  ok(
    spots.every((s) => s.ring === spots[0].ring),
    'and scores the same',
    spots.map((s) => s.ring),
  );
  near(spots[1].fx, 0.21, 0.002, 'aimed 21 cm right of centre (the wind allowed for): lands there');
  near(spots[1].fy, -0.13, 0.002, '…and 13 cm low');
}
{
  const { g } = start([person(0)], { layout: range([{ z: D30 }], 3) });
  const aim = aimAt(g, g.mainTarget());
  g.aim(0, aim.yaw, aim.pitch);
  g.draw(0, true);
  until(g, () => g.archer.phase === 'hold');
  g.draw(0, false);
  const arrow = () => g.view().arrows.find((a) => a.state === 'flying')!;
  let worst = 0;
  let prev = { ...arrow() };
  const dys: number[] = [prev.dy];
  while (g.state === 'flight') {
    g.step(DT);
    const a = g.view().arrows.find((q) => q.state === 'flying');
    if (!a) break;
    const mx = a.x - prev.x;
    const my = a.y - prev.y;
    const mz = a.z - prev.z;
    const m = Math.hypot(mx, my, mz);
    worst = Math.max(worst, Math.acos(Math.min(1, (mx * a.dx + my * a.dy + mz * a.dz) / m)));
    near(Math.hypot(a.dx, a.dy, a.dz), 1, 1e-9, 'the flying arrow: a unit direction');
    dys.push(a.dy);
    prev = { ...a };
  }
  ok(worst < 0.006, 'a flying arrow points along its path', worst);
  ok(dys.length > 0.5 / DT && dys.every((y, i) => i === 0 || y < dys[i - 1]), 'and tips down as it flies (a 30 m shot starts climbing, ends falling)', dys.length);
  ok(dys[0] > 0 && dys[dys.length - 1] < 0, '…up to start with, down at the end', [dys[0], dys[dys.length - 1]]);
}

// ---------------------------------------------------------------- faces and rings

{
  const { g, ev } = start([person(0, '#abcdef')], { layout: range([{}], 1.5) });
  const d = g.mainTarget();
  const sh = shoot(g, 0, aimAt(g, d));
  ok(sh.where === 'face' && sh.ring === 10 && sh.points === 10 && sh.bullseye && sh.x, 'dead centre: a 10, a bullseye, in the X', sh);
  ok(sh.target === d.id && sh.balloons.length === 0, '…in the main face');
  near(Math.hypot(sh.fx, sh.fy), 0, 0.001, '…where it was aimed (drop and wind allowed for)');
  const sc = lastOf(ev, 'score');
  ok(!!sc && sc.who === 0 && sc.points === 10 && sc.ring === 10 && sc.bullseye && sc.target === d.id, "the 'score' event says so", sc);
  near(sc?.z ?? 0, d.z, 1e-9, "'score' is where it went in: on the face");
  const v = g.view();
  const hit = v.fx.find((e) => e.type === 'hit');
  ok(hit?.type === 'hit' && hit.ring === 10, "a 'hit' effect with the ring", v.fx);
  ok(g.view().fx.length === 0, 'effects are handed out once');
  const a = v.arrows[0];
  ok(v.arrows.length === 1 && a.state === 'stuck' && a.target === d.id && a.color === '#abcdef', "the arrow's stuck in the face, in the archer's colour", a);
  near(d.z - a.z, FLIGHT.bury * -a.dz, 1e-9, 'its tip is a little way in');
  ok(a.dz < -0.99 && Math.abs(Math.hypot(a.dx, a.dy, a.dz) - 1) < 1e-9, '…pointing the way it flew');
  ok(g.state === 'result', 'then a look at it', g.state);
}
{
  const face = [{}];
  for (const [u, ang, want] of [
    [0.07, 0.3, 10],
    [0.35, 1.2, 7],
    [0.55, 2.5, 5],
    [0.72, -2.0, 3],
    [0.95, -0.7, 1],
  ] as const) {
    const { g } = start([person(0)], { layout: range(face, -2) });
    const d = g.mainTarget();
    const sh = shoot(g, 0, aimAt(g, d, u * d.r * Math.cos(ang), u * d.r * Math.sin(ang)));
    ok(sh.where === 'face' && sh.ring === want && sh.points === want && sh.ring === ringOf(Math.hypot(sh.fx, sh.fy), d.r), `${Math.round(u * 100)}% of the way out: ring ${want}`, sh.ring);
    ok(sh.bullseye === (want === 10) && sh.x === false, '…(a 10 outside the X is no X)');
  }
}
{
  // just off the edge: it flies on past
  const { g, ev } = start([person(0)], { layout: range([{}]) });
  const d = g.mainTarget();
  const sh = shoot(g, 0, aimAt(g, d, d.r + 0.03, 0));
  ok((sh.where === 'ground' || sh.where === 'backstop') && sh.ring === 0 && sh.points === 0 && sh.target === -1, '3 cm off the edge: a miss (it flies on, into the ground or the backstop behind)', sh);
  ok(sh.pz < d.z - 1, '…well behind the face', sh.pz);
  const sc = lastOf(ev, 'score');
  ok(sc?.points === 0 && sc.ring === 0 && sc.target === -1 && !sc.bullseye, "'score': 0, missed everything", sc);
  const fx = g.view().fx;
  ok(fx.some((e) => e.type === 'thunk') && !fx.some((e) => e.type === 'hit'), "a 'thunk' (no 'hit')", fx);
  ok(g.archer.phase === 'sad' || (g.archer.phase === 'release' && until(g, () => g.archer.phase === 'sad', 1)), 'the archer is sad about it', g.archer.phase);
}

// ---------------------------------------------------------------- balloons

{
  // one right on the line to the face: it pops, and the arrow flies on into the 10
  const ideal = aimFor(0, FACE_Y, D22);
  const p = flyTo(ideal.yaw, ideal.pitch, RANGE.fullSpeed, RANGE.lineZ - 16);
  const { g, ev } = start([person(0)], { layout: range([{}, balloonAt(p.x, p.y, RANGE.lineZ - 16)]) });
  const b = g.targets[1];
  const sh = shoot(g, 0, aimAt(g, g.mainTarget()));
  ok(sh.balloons.length === 1 && sh.balloons[0] === b.id, 'a balloon in the way pops', sh.balloons);
  ok(sh.where === 'face' && sh.ring === 10 && sh.points === 10 + BALLOON_BONUS, `…and the arrow flies on into the 10: ${10 + BALLOON_BONUS} points`, sh.points);
  const sc = lastOf(ev, 'score');
  ok(sc?.points === 15 && sc.ring === 10 && sc.target === g.mainTarget().id, "'score': the bonus on top of the ring, the target is the face", sc);
  const v = g.view();
  const pop = v.fx.find((e) => e.type === 'pop');
  ok(pop?.type === 'pop' && pop.color === balloonColor(b.id), "a 'pop' in the balloon's colour", pop);
  ok(
    v.fx.findIndex((e) => e.type === 'pop') < v.fx.findIndex((e) => e.type === 'hit'),
    'pop, then hit',
    v.fx.map((e) => e.type),
  );
  ok(v.targets[1].popped && !v.targets[1].visible && !v.targets[0].popped && v.targets[0].visible, 'the view: that balloon popped (hidden), the face not');
  ok(g.archer.phase === 'cheer' || until(g, () => g.archer.phase === 'cheer', 1), 'the archer cheers');
}
{
  // two in a row, then the face
  const ideal = aimFor(0, FACE_Y, D22);
  const p1 = flyTo(ideal.yaw, ideal.pitch, RANGE.fullSpeed, RANGE.lineZ - 12);
  const p2 = flyTo(ideal.yaw, ideal.pitch, RANGE.fullSpeed, RANGE.lineZ - 18);
  const { g } = start([person(0)], { layout: range([{}, balloonAt(p1.x, p1.y, RANGE.lineZ - 12), balloonAt(p2.x, p2.y + 0.1, RANGE.lineZ - 18)]) });
  const sh = shoot(g, 0, aimAt(g, g.mainTarget()));
  ok(sh.balloons.length === 2 && sh.points === 10 + 2 * BALLOON_BONUS, 'two balloons and the 10: 20 points', sh);
}
{
  // a balloon on its own: 5, and the arrow carries on to wherever
  const { g, ev } = start([person(0)], { layout: range([{}, balloonAt(3, 3.2, RANGE.lineZ - 14, 0.15, 5)]) });
  const b = g.targets[1];
  const sh = shoot(g, 0, () => aimAt(g, b));
  ok(sh.balloons.length === 1 && sh.ring === 0 && sh.points === BALLOON_BONUS && sh.target === b.id, 'a swaying balloon on its own (led): 5 points, target = the balloon', sh);
  ok(sh.where === 'ground' || sh.where === 'backstop', '…and the arrow flew on past it', sh.where);
  ok(lastOf(ev, 'score')?.target === b.id, "'score' target: the balloon (it didn't miss everything)");
}
{
  // popped stays popped for the rest of that archer's end; the next archer gets them back
  const ideal = aimFor(0, FACE_Y, D22);
  const p = flyTo(ideal.yaw, ideal.pitch, RANGE.fullSpeed, RANGE.lineZ - 16);
  const { g } = start([person(0), person(1)], { arrows: 2, layout: range([{}, balloonAt(p.x, p.y, RANGE.lineZ - 16)]) });
  const s1 = shoot(g, 0, aimAt(g, g.mainTarget()));
  g.skip();
  run(g, ARCHERY_TIMING.nock + 0.02);
  ok(g.current === 0 && g.arrowNo === 2 && g.view().targets[1].popped, 'the same archer, their next arrow: the balloon is still popped');
  const s2 = shoot(g, 0, aimAt(g, g.mainTarget()));
  ok(s1.points === 15 && s2.points === 10 && s2.balloons.length === 0, '…so the same shot again scores just the ring', [s1.points, s2.points]);
  g.skip();
  ok(g.state === 'next' && g.current === 1 && !g.view().targets[1].popped && g.view().targets[1].visible, 'the next archer: the balloons are blown up again');
  g.skip();
  run(g, ARCHERY_TIMING.nock + 0.02);
  const s3 = shoot(g, 1, aimAt(g, g.mainTarget()));
  ok(s3.points === 15, '…and they can pop it too', s3.points);
}

// ---------------------------------------------------------------- the ground, the backstop, a shot lost over everything

{
  const { g } = start([person(0)], { layout: range([{}]) });
  const sh = shoot(g, 0, { yaw: 0.1, pitch: -0.3 });
  const a = g.view().arrows[0];
  ok(sh.where === 'ground' && sh.points === 0 && a.state === 'stuck' && a.target === -1, 'aimed down: it sticks in the ground', sh);
  near(sh.py, 0, 1e-9, '…at ground level');
  ok(a.y < 0 && a.dy < 0, '…tip first, a little way in', a);
  ok(g.view().fx.length === 0, '(effects already read)');
}
{
  const { g, ev } = start([person(0)], { layout: range([{}]) });
  shoot(g, 0, aimFor(2, 9, FLIGHT.backZ));
  const sh = g.last!;
  const a = g.view().arrows[0];
  ok(sh.where === 'backstop' && sh.points === 0 && a.state === 'stuck' && a.target === -1, 'over the targets: it stops in the backstop', sh);
  near(sh.pz, FLIGHT.backZ, 1e-9, '…at the back of the box');
  near(sh.px, 2, 0.01, '…where it was headed');
  ok(a.z < FLIGHT.backZ, '…tip in');
  ok(lastOf(ev, 'score')?.target === -1, "'score': missed everything");
  const fx = g.view().fx;
  ok(fx.length === 0, 'effects handed out once (the thunk went with the last read)');
}
{
  const { g } = start([person(0)], { layout: range([{}]) });
  const sh = shoot(g, 0, { yaw: 1.1, pitch: 0.05 });
  ok(sh.where === 'backstop' && Math.abs(Math.abs(sh.px) - FLIGHT.sideX) < 1e-9 && sh.px < 0, 'way off to the left: it stops at the side of the range', sh);
}
{
  const { g, ev } = start([person(0)], { layout: range([{}]) });
  const sh = shoot(g, 0, { yaw: 0, pitch: AIM_LIMIT.pitchMax });
  ok(sh.where === 'lost' && sh.points === 0 && sh.target === -1, 'shot at the sky, over the backstop: lost', sh);
  within(sh.flightT, FLIGHT.maxT - 0.02, FLIGHT.maxT + 0.02, '…given up after 3 s');
  ok(g.view().arrows.length === 0 && g.shotArrow === null, '…and gone from the view', g.view().arrows);
  ok(lastOf(ev, 'score')?.points === 0 && g.state === 'result', "it still gets a 'score' (0) and a result");
}

// ---------------------------------------------------------------- moving targets

{
  const layout = range([{ x: 0, swayX: 2, swayT: 4 }]);
  const { g } = start([person(0)], { layout });
  const d = g.mainTarget();
  near(g.view().targets[0].x, targetX(d, g.t - g.endT0), 1e-12, 'the view has where a swaying face is now');
  ok(Math.abs(g.view().targets[0].x) > 0.2, '…and it has moved', g.view().targets[0].x);
  const sh = shoot(g, 0, () => aimAt(g, d));
  ok(sh.where === 'face' && sh.ring === 10, 'a swaying face, led (aimed where it will be): a 10', sh);
  const a = g.view().arrows[0];
  const off = a.x - targetX(d, g.t - g.endT0);
  const xs: number[] = [];
  let drift = 0;
  for (let i = 0; i < 120; i++) {
    g.step(DT);
    xs.push(a.x);
    drift = Math.max(drift, Math.abs(a.x - targetX(d, g.t - g.endT0) - off));
  }
  ok(drift < 1e-9, 'the stuck arrow goes with it', drift);
  ok(Math.max(...xs) - Math.min(...xs) > 1, '…a long way', Math.max(...xs) - Math.min(...xs));
  ok(a.target === d.id && a.state === 'stuck', '(stuck in it)');
}
{
  const { g } = start([person(0)], { layout: range([{ x: 0, swayX: 2, swayT: 4 }]) });
  const d = g.mainTarget();
  const sh = shoot(g, 0, () => aimFor(targetX(d, g.t - g.endT0), d.y, d.z));
  ok(sh.ring < 7, 'aimed where it is, not where it will be: well off (or missed)', sh.ring);
}

// ---------------------------------------------------------------- the draw

{
  const { g, ev } = start([person(0)], { layout: range([{}]) });
  ok(g.archer.phase === 'nock' && g.archer.draw === 0, 'a turn starts with an arrow nocked');
  g.draw(0, true);
  ok(g.archer.phase === 'draw' && lastOf(ev, 'draw')?.who === 0, "DRAW down: pulling the string ('draw')");
  run(g, 0.45);
  near(g.archer.draw, 0.5, 0.06, `drawn in ${RANGE.drawT} s: half-way after 0.45 s`);
  const d = g.archer.draw;
  g.draw(0, false);
  ok(g.state === 'flight' && lastOf(ev, 'shot')?.who === 0, "let go at half draw: it shoots ('shot')");
  near(lastOf(ev, 'shot')!.speed, RANGE.fullSpeed * d, 1e-9, '…at half speed (speed = full × draw)');
  ok(g.view().arrows[0].state === 'flying', 'the arrow on the bow is now the one in the air');
}
{
  const { g, ev } = start([person(0)], { layout: range([{}]) });
  g.draw(0, true);
  run(g, 0.15);
  ok(g.archer.draw < MIN_DRAW && g.archer.draw > 0.1, 'a moment of drawing', g.archer.draw);
  g.draw(0, false);
  ok(!ev.some((e) => e.type === 'shot') && g.state === 'aim' && g.archer.phase === 'nock' && g.arrowNo === 1, 'let go under 25%: no shot — the string goes back down, same arrow');
  run(g, 0.3);
  ok(g.archer.draw === 0, '…relaxed', g.archer.draw);
  ok(g.view().arrows.length === 1 && g.view().arrows[0].state === 'nocked', '…the arrow still on the string');
  g.draw(0, true);
  ok(g.archer.phase === 'draw', 'it can be drawn again straight away');
  until(g, () => g.archer.draw >= 0.26);
  const d = g.archer.draw;
  g.draw(0, false);
  ok(ev.filter((e) => e.type === 'shot').length === 1, 'just over 25%: a (feeble) shot', ev.filter((e) => e.type === 'shot'));
  near(lastOf(ev, 'shot')!.speed, RANGE.fullSpeed * d, 1e-9, '…at the draw’s share of full speed');
}
{
  // cancelDraw: the game paused mid-draw; the phone lets go afterwards
  const { g, ev } = start([person(0), person(1)], { layout: range([{}]) });
  g.draw(0, true);
  until(g, () => g.archer.phase === 'hold');
  g.cancelDraw(1);
  ok(g.archer.phase === 'hold', "cancelDraw from someone else's seat does nothing");
  g.cancelDraw(0);
  ok(g.archer.phase === 'nock' && g.state === 'aim', 'cancelDraw: the string goes back down');
  g.draw(0, false);
  ok(!ev.some((e) => e.type === 'shot') && g.state === 'aim' && g.arrowNo === 1, "…and the phone letting go of DRAW then doesn't shoot");
  run(g, 0.5);
  ok(g.archer.draw === 0 && g.archer.phase === 'nock', '…relaxed, still aiming, the same arrow to shoot');
  const sh = shoot(g, 0, aimAt(g, g.mainTarget()));
  ok(sh.ring === 10 && ev.filter((e) => e.type === 'shot').length === 1, 'then it shoots normally');
}
{
  // DRAW pressed before the arrow's nocked
  const g = new ArcheryGame([person(0)], { seed: 3, layout: range([{}]) });
  g.skip();
  g.skip();
  g.draw(0, true);
  ok(g.archer.phase === 'nock', 'DRAW before the arrow is nocked: nothing yet');
  until(g, () => g.archer.phase === 'draw');
  near(g.t - g.stateT0, ARCHERY_TIMING.nock, DT + 1e-9, '…it draws as soon as the arrow is on');
}
{
  // DRAW held through someone else's turn: it draws once your arrow's nocked
  const { g, ev } = start([person(0), person(1)], { arrows: 1, layout: range([{}]) });
  g.draw(1, true);
  ok(g.archer.phase === 'nock', "someone else's DRAW doesn't draw this archer's bow");
  g.aim(1, 0.5, 0.5);
  ok(Math.abs(g.archer.yaw - g.home.yaw) < 1e-12, "…nor does their aim move it");
  shoot(g, 0, aimAt(g, g.mainTarget()));
  g.skip();
  ok(g.state === 'next' && g.current === 1, 'on to the next archer');
  g.skip();
  ok(g.archer.phase === 'nock', 'their turn: nocking');
  until(g, () => g.archer.phase === 'draw');
  ok(lastOf(ev, 'draw')?.who === 1, 'DRAW held since before: they draw as soon as the arrow is on');
}
{
  // DRAW during the intro skips it
  const g = new ArcheryGame([person(0)], { seed: 2 });
  const ev: ArcheryEvent[] = [];
  g.onEvent = (e) => ev.push(e);
  g.draw(0, true);
  ok(g.state === 'next' && ev[0]?.type === 'end', 'DRAW during the intro skips it');
  g.draw(0, false);
}
{
  // aim: clamped, garbage ignored, only for whoever's up (a person)
  const { g } = start([person(0)], { layout: range([{}]) });
  g.aim(0, 5, 5);
  ok(g.archer.yaw === AIM_LIMIT.yaw && g.archer.pitch === AIM_LIMIT.pitchMax, 'an aim beyond the limits is clamped', [g.archer.yaw, g.archer.pitch]);
  g.aim(0, NaN, 0.1);
  ok(g.archer.yaw === AIM_LIMIT.yaw, 'a garbage aim is ignored');
  g.aim(0, 0.02, 0.03);
  ok(g.archer.yaw === 0.02 && g.archer.pitch === 0.03, 'the archer points where the phone does');
}
{
  // the shake of a long full draw
  const { g } = start([person(0)], { layout: range([{}]) });
  const a = { yaw: 0.013, pitch: 0.021 };
  g.aim(0, a.yaw, a.pitch);
  g.draw(0, true);
  until(g, () => g.archer.phase === 'hold');
  let early = 0;
  let late = 0;
  while (g.archer.t < 8) {
    g.step(DT);
    const dev = Math.hypot(g.archer.yaw - a.yaw, g.archer.pitch - a.pitch);
    if (g.archer.t < ARCHERY_TIMING.holdSteady) early = Math.max(early, dev);
    else late = Math.max(late, dev);
  }
  ok(early === 0, `steady for the first ${ARCHERY_TIMING.holdSteady} s at full draw`, early);
  within(late, 0.003, ARCHERY_TIMING.shakeMax * Math.SQRT2 + 1e-9, 'held on and on: the bow shakes, a few mrad');
  const yaw = g.archer.yaw;
  const pitch = g.archer.pitch;
  g.draw(0, false);
  const v = g.view().arrows[0];
  const d = aimDir(yaw, pitch);
  near(Math.hypot(v.dx - d.x, v.dy - d.y, v.dz - d.z), 0, 1e-9, 'the shot goes where the shaking bow pointed as it let go');
}

// ---------------------------------------------------------------- the archer (for the animator)

{
  const g = new ArcheryGame([person(0, '#fff', -1)], { seed: 1, layout: range([{}]) });
  ok(g.archer.phase === 'idle' && g.archer.x === 0 && g.archer.z === RANGE.lineZ && g.archer.handed === -1, 'the intro: the (left-handed) archer idle on the line at x = 0');
  g.skip();
  ok(g.archer.phase === 'idle', "'next': idle");
  g.skip();
  const home = sightTo(0, FACE_Y, D22);
  ok(g.archer.phase === 'nock' && g.archer.t === 0 && g.archer.draw === 0, 'a turn: nock');
  near(g.archer.yaw - home.yaw + g.archer.pitch - home.pitch, 0, 1e-12, 'no aim from the phone yet: straight at the main face');
  ok(g.home.yaw === home.yaw && g.home.pitch === home.pitch, 'game.home is that aim');
  run(g, ARCHERY_TIMING.nock + 0.02);
  const phases: string[] = [];
  let last = '';
  const note = () => {
    if (g.archer.phase !== last) phases.push((last = g.archer.phase));
  };
  g.draw(0, true);
  note();
  const aim = aimAt(g, g.mainTarget());
  g.aim(0, aim.yaw, aim.pitch);
  until(g, () => (note(), g.archer.phase === 'hold'));
  near(g.archer.draw, 1, 1e-12, 'hold: at full draw');
  ok(g.archer.yaw === aim.yaw && g.archer.pitch === aim.pitch, 'yaw/pitch: the live aim');
  run(g, 0.2);
  g.draw(0, false);
  note();
  ok(g.archer.draw === 0, 'let go: the string snaps back');
  until(g, () => (note(), g.state === 'result' && g.archer.phase === 'cheer'), 5);
  run(g, 0.5);
  note();
  ok(phases.join(' ') === 'draw hold release watch cheer', 'nock → draw → hold → release → watch → cheer', phases.join(' '));
}

// ---------------------------------------------------------------- turns, ends, events, scores

{
  const g = new ArcheryGame([person(0), person(1, '#0f0')], { seed: 5, ends: 2, arrows: 2 });
  const ev: ArcheryEvent[] = [];
  const ends: { wind: number; ids: number[] }[] = [];
  g.onEvent = (e) => {
    ev.push(e);
    if (e.type === 'end') ends.push({ wind: g.wind, ids: g.targets.map((t) => t.id) });
  };
  ok(g.state === 'intro' && g.end === 1 && g.targets.length > 0, "the intro shows end 1's range");
  run(g, ARCHERY_TIMING.intro + 0.02);
  ok(g.state === 'next' && ev[0]?.type === 'end' && ev[0].end === 1 && ev[0].ends === 2, "the intro ends by itself: 'end' 1 of 2", ev[0]);
  run(g, ARCHERY_TIMING.end + 0.02);
  ok(g.state === 'aim' && lastOf(ev, 'turn')?.who === 0, 'then the first turn');
  let arrowsSeen = 0;
  while (g.state !== 'over' && g.t < 300) {
    if (g.state === 'aim' && g.archer.phase === 'nock' && g.t >= g.nockAt) {
      const who = g.current;
      if (who === 1 && g.arrowNo === 1 && g.end === 1) arrowsSeen = g.view().arrows.length;
      // person 1 aims a little off, to lose
      shoot(g, g.archers[who].slot, aimAt(g, g.mainTarget(), who === 1 ? 0.2 : 0, 0));
    } else g.step(DT);
  }
  ok(g.state === 'over', 'the game ends', g.state);
  const turns = ev.filter((e) => e.type === 'turn').map((e) => (e.type === 'turn' ? `${e.who}.${e.arrow}/${e.arrows}` : ''));
  ok(turns.join(' ') === '0.1/2 0.2/2 1.1/2 1.2/2 0.1/2 0.2/2 1.1/2 1.2/2', "each archer's arrows in a row, then the next archer; again next end", turns.join(' '));
  ok(
    ev.filter((e) => e.type === 'end').map((e) => (e.type === 'end' ? e.end : 0)).join() === '1,2',
    "'end' 1, then 2",
  );
  ok(ends.length === 2 && ends[0].ids.every((id) => !ends[1].ids.includes(id)), 'a new range each end (new target ids)', ends);
  ok(
    ev.filter((e) => e.type === 'end').every((e, i) => e.type === 'end' && e.wind === ends[i].wind),
    "'end' carries the end's wind",
  );
  within(Math.abs(ends[0].wind), WIND[0][0], WIND[0][1], 'end 1: a light wind');
  within(Math.abs(ends[1].wind), WIND[1][0], WIND[1][1], 'end 2: a stronger one');
  ok(arrowsSeen === 3, "arrows stay for the rest of the end: the second archer's first turn shows the first's 2 + their own on the bow", arrowsSeen);
  // the order of each arrow's events
  const order = ev.filter((e) => e.type !== 'end' && e.type !== 'over').map((e) => e.type);
  ok(order.join(' ') === Array(8).fill('turn draw shot score').join(' '), "every arrow: 'turn' → 'draw' → 'shot' → 'score'", order.join(' '));
  const pts = [0, 1].map((i) => ev.filter((e) => e.type === 'score' && e.who === i).map((e) => (e.type === 'score' ? e.points : 0)));
  ok(g.scores[0].join() === pts[0].join() && g.scores[1].join() === pts[1].join(), 'scores: each arrow’s points, per archer', g.scores);
  ok(g.scores[0].length === 4 && g.scores[1].length === 4, '…2 ends × 2 arrows each');
  ok(g.total(0) === pts[0].reduce((a, b) => a + b, 0) && g.endTotal(0, 1) + g.endTotal(0, 2) === g.total(0), 'total(), endTotal()');
  ok(g.total(0) >= 38 && g.total(1) < g.total(0), 'dead-centre shooting scores ~10s; 20 cm off, less', [g.total(0), g.total(1)]);
  const over = lastOf(ev, 'over');
  ok(over?.ranking.join() === '0,1', "'over' ranks them by total", over);
  ok(g.shots.length === 8 && g.shots.every((s, i) => s.end === (i < 4 ? 1 : 2)), 'shots: the full log');
  const nEv = ev.length;
  run(g, 5);
  ok(ev.length === nEv && g.state === 'over', 'nothing more happens once it’s over');
}
{
  // ties: most 10s, then most Xs
  const g = new ArcheryGame([person(0), person(1)], { seed: 9, ends: 1, arrows: 2, layout: range([{}]) });
  const ev: ArcheryEvent[] = [];
  g.onEvent = (e) => ev.push(e);
  g.skip();
  g.skip();
  run(g, ARCHERY_TIMING.nock + 0.02);
  const d = () => g.mainTarget();
  // 0: a 9 and a 9 (18); 1: a 10 and an 8 (18) → 1 wins on 10s
  shoot(g, 0, aimAt(g, d(), 0.1 * d().r, 0.1));
  g.skip();
  run(g, ARCHERY_TIMING.nock + 0.02);
  shoot(g, 0, aimAt(g, d(), -0.15 * d().r, 0));
  g.skip();
  g.skip();
  run(g, ARCHERY_TIMING.nock + 0.02);
  shoot(g, 1, aimAt(g, d(), 0.07 * d().r, 0));
  g.skip();
  run(g, ARCHERY_TIMING.nock + 0.02);
  shoot(g, 1, aimAt(g, d(), 0, 0.25 * d().r));
  g.skip();
  ok(g.scores[0].join() === '9,9' && g.scores[1].join() === '10,8', '(a tie at 18)', g.scores);
  ok(lastOf(ev, 'over')?.ranking.join() === '1,0', 'a tie goes to the one with more 10s', lastOf(ev, 'over'));
}
{
  // skip(): the intro, a pause, a result
  const g = new ArcheryGame([person(0)], { seed: 4, layout: range([{}]) });
  const ev: ArcheryEvent[] = [];
  g.onEvent = (e) => ev.push(e);
  g.skip();
  ok(g.state === 'next' && ev.map((e) => e.type).join() === 'end', 'skip() in the intro: the end is announced');
  g.skip();
  ok(g.state === 'aim' && lastOf(ev, 'turn')?.arrow === 1, 'skip() in the pause: the turn');
  g.skip();
  ok(g.state === 'aim', "skip() while aiming: nothing (it isn't a shot)");
  run(g, ARCHERY_TIMING.nock + 0.02);
  shoot(g, 0, aimAt(g, g.mainTarget()));
  ok(g.state === 'result', 'a result');
  g.skip();
  ok(g.state === 'aim' && g.arrowNo === 2 && lastOf(ev, 'turn')?.arrow === 2, 'skip() on a result: the next arrow');
  run(g, ARCHERY_TIMING.nock + 0.02);
  shoot(g, 0, aimAt(g, g.mainTarget()));
  until(g, () => g.state === 'aim', 5);
  ok(g.arrowNo === 3, '…or it moves on by itself', g.arrowNo);
}

// ---------------------------------------------------------------- the view

{
  const { g } = start([person(0, '#123456')], { layout: range([{}], 1.2) });
  const v = g.view();
  ok(v.wind === g.wind && v.wind === 1.2, 'the view has the wind');
  const n = v.arrows[0];
  ok(v.arrows.length === 1 && n.state === 'nocked' && n.color === '#123456' && n.target === -1, 'aiming: the arrow on the bow', n);
  const tipAt = (a: ArrowView, reach: number) => {
    const d = aimDir(g.archer.yaw, g.archer.pitch);
    return Math.hypot(a.x - EYE.x - d.x * reach, a.y - EYE.y - d.y * reach, a.z - EYE.z - d.z * reach);
  };
  near(tipAt(n, FLIGHT.bow + FLIGHT.slide), 0, 1e-9, 'undrawn: its tip sticks out past the bow');
  g.draw(0, true);
  until(g, () => g.archer.phase === 'hold');
  near(tipAt(g.view().arrows[0], FLIGHT.bow), 0, 1e-9, 'at full draw: its tip at the bow');
  g.aim(0, 0.1, 0.05);
  const d = aimDir(0.1, 0.05);
  const a = g.view().arrows[0];
  near(Math.hypot(a.dx - d.x, a.dy - d.y, a.dz - d.z), 0, 1e-12, 'it points along the aim (straight away, not a frame later)');
  ok(v.targets.length === 1 && v.targets[0].visible && !v.targets[0].popped && v.targets[0].id === g.targets[0].id, 'targets: visible, not popped');
}

// ---------------------------------------------------------------- the layouts

{
  let bad: string[] = [];
  const winds: number[][] = [[], [], []];
  const clear: number[] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const rng = new Rng(seed);
    let id = 0;
    const seen = new Set<number>();
    for (let end = 1; end <= 6; end++) {
      const L = layoutFor(end, rng, id);
      id += L.targets.length;
      const m = L.targets[L.main];
      const dist = RANGE.lineZ - m.z;
      const want = end === 1 ? 15 : end === 2 ? 22 : end === 3 ? 30 : -1;
      if (m.kind !== 'face' || m.bonus !== 0 || m.swayX !== 0) bad.push(`${seed}/${end}: the main face`);
      if (want > 0 ? Math.abs(dist - want) > 1e-9 : dist < 27 - 1e-9 || dist > 32 + 1e-9) bad.push(`${seed}/${end}: main at ${dist} m`);
      if (end === 1 && m.r !== BIG_FACE_R) bad.push(`${seed}/1: not the big face`);
      if (end === 2 && !L.targets.some((t) => t.kind === 'face' && t.y > 3.5)) bad.push(`${seed}/2: no raised face`);
      if (end === 3 && (m.r !== EXPERT_FACE_R || !L.targets.some((t) => t.kind === 'face' && t.swayX !== 0 && t.swayT > 5))) bad.push(`${seed}/3: expert face / slow swayer`);
      if (L.targets.filter((t) => t.kind === 'balloon').length < 2) bad.push(`${seed}/${end}: balloons`);
      winds[Math.min(end, 3) - 1].push(L.wind);
      const [lo, hi] = WIND[Math.min(end, 3) - 1];
      if (Math.abs(L.wind) < lo - 1e-9 || Math.abs(L.wind) > hi + 1e-9) bad.push(`${seed}/${end}: wind ${L.wind}`);
      for (const t of L.targets) {
        if (seen.has(t.id)) bad.push(`${seed}/${end}: id ${t.id} again`);
        seen.add(t.id);
        if (Math.abs(t.x) + Math.abs(t.swayX) + t.r > RANGE.halfX + 1e-9 || t.y + t.r > RANGE.maxY || t.y - t.r < 0.3 || t.z < RANGE.minZ || t.z > RANGE.maxZ) bad.push(`${seed}/${end}: target ${t.id} out of the box`);
        if ((t.kind === 'balloon') !== (t.bonus === BALLOON_BONUS)) bad.push(`${seed}/${end}: bonus`);
      }
      // the ideal flight to the main face (in this end's wind) clears every balloon in front of it, wherever it sways
      const aim = aimFor(m.x, m.y, m.z, RANGE.fullSpeed, L.wind);
      let minGap = 9;
      for (const b of L.targets) {
        if (b.kind !== 'balloon' || b.z <= m.z) continue;
        const p = flyTo(aim.yaw, aim.pitch, RANGE.fullSpeed, b.z, L.wind);
        minGap = Math.min(minGap, Math.hypot(p.x - b.x, p.y - b.y) - Math.abs(b.swayX) - b.r);
      }
      clear.push(minGap);
    }
  }
  ok(bad.length === 0, 'layouts: the main face at 15 / 22 / 30 m (encores 27–32), a raised face in end 2, the expert face and a slow swayer in end 3, balloons, all inside the box, winds by end, unique ids', bad.slice(0, 8));
  ok(Math.min(...clear) > 0.05, 'a perfect shot at the main face never clips a balloon (the near one hangs just off the line)', Math.min(...clear));
  ok(Math.max(...clear.filter((c) => c < 9)) < 0.5, '…but one hangs close enough to tempt', Math.max(...clear.filter((c) => c < 9)));
  for (let e = 0; e < 3; e++) ok(winds[e].some((w) => w > 0) && winds[e].some((w) => w < 0), `end ${e + 1}: the wind blows either way`);
  const a = new ArcheryGame([person(0)], { seed: 42 });
  const b = new ArcheryGame([cpu(0.3), cpu(0.9), person(2)], { seed: 42 });
  ok(JSON.stringify(a.targets) === JSON.stringify(b.targets) && a.wind === b.wind, 'the same seed, the same range, whoever plays');
}

// ---------------------------------------------------------------- the CPU

function cpuGame(skills: number[], seed: number, opts: ArcheryOptions = {}, check?: (g: ArcheryGame, e?: ArcheryEvent) => void) {
  const g = new ArcheryGame(
    skills.map((s, i) => cpu(s, `#${i}${i}${i}`)),
    { seed, ...opts },
  );
  const log: string[] = [];
  g.onEvent = (e) => {
    log.push(`${g.t.toFixed(4)} ${JSON.stringify(e)}`);
    check?.(g, e);
  };
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
  const a = cpuGame([0.3, 0.9], 7);
  const b = cpuGame([0.3, 0.9], 7);
  ok(a.g.state === 'over', 'a CPU game finishes', a.g.state);
  ok(a.log.join('\n') === b.log.join('\n'), 'CPU games are deterministic for a seed');
  ok(cpuGame([0.3, 0.9], 8).log.join('\n') !== a.log.join('\n'), '…and differ between seeds');
}
{
  // believable: a look at the target, a draw, a steady hold; the aim high, and into the wind
  const gaps: number[] = [];
  const holds: number[] = [];
  let high = 0;
  let into = 0;
  let windy = 0;
  let shots = 0;
  let turnT = 0;
  let drawT = 0;
  let holdT = -1;
  cpuGame([0.9, 0.9], 11, {}, (g, e) => {
    if (!e) {
      if (g.archer.phase === 'hold' && holdT < 0) holdT = g.t;
      return;
    }
    if (e.type === 'turn') ((turnT = g.t), (holdT = -1));
    else if (e.type === 'draw') {
      drawT = g.t;
      gaps.push(drawT - turnT);
    } else if (e.type === 'shot') {
      holds.push(g.t - holdT);
      shots++;
      if (g.archer.pitch > g.home.pitch) high++;
      if (g.end === 3) {
        windy++;
        if ((g.archer.yaw - g.home.yaw) * g.wind > 0) into++;
      }
      ok(e.speed === RANGE.fullSpeed, 'a CPU draws fully', e.speed);
      ok(Math.abs(g.t - drawT - RANGE.drawT - holds[holds.length - 1]) < 0.05, '…draws for drawT, then holds', g.t - drawT);
    }
  });
  within(Math.min(...gaps), ARCHERY_TIMING.nock + 0.4, 9, 'a CPU looks at the target a moment before drawing');
  within(Math.max(...gaps), 0, 3, '…but not forever');
  within(Math.min(...holds), 0.4, 9, 'it holds at full draw a moment before letting go');
  within(Math.max(...holds), 0, 2.5, '…and doesn’t dawdle');
  ok(shots === 18 && high === shots, 'it aims above the face (allowing for the drop)', [high, shots]);
  ok(windy === 6 && into >= 5, 'in end 3’s wind, the Ace aims into it', [into, windy]);
}
{
  // averages by level (the sim runs thousands; a quick look here)
  const avg = (s: number) => {
    let p = 0;
    let n = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { g } = cpuGame([s, s, s], 1000 + seed);
      for (let i = 0; i < 3; i++) ((p += g.total(i)), (n += g.scores[i].length));
    }
    return p / n;
  };
  const r = avg(0.3);
  const p = avg(0.65);
  const a = avg(0.9);
  within(r, 5.9, 7.4, 'Rookie: 6–7 points an arrow');
  within(p, 7.4, 8.6, 'Pro: about 8');
  within(a, 8.95, 10, 'Ace: 9+');
}
{
  // a person and a CPU: each only moves on their own turn
  const { g, ev } = start([person(0), cpu(0.65)], { arrows: 1, layout: range([{}]) });
  shoot(g, 0, aimAt(g, g.mainTarget()));
  g.skip();
  g.skip();
  ok(g.current === 1 && g.state === 'aim', "the CPU's turn");
  g.draw(0, true);
  g.aim(0, 0.9, 0.9);
  ok(g.archer.phase === 'nock' && Math.abs(g.archer.yaw) < 0.2, "a person's DRAW and aim don't touch the CPU's bow");
  g.draw(0, false);
  until(g, () => g.state === 'result', 10);
  ok(lastOf(ev, 'score')?.who === 1, 'the CPU shoots its own arrow');
}


// ---------------------------------------------------------------- latency: a message that's `age` s old
{
  // the draw began `age` ago: it's that far along
  const { g } = start([person(0)], { layout: range([{}]) });
  g.draw(0, true, 0.3);
  near(g.archer.draw, 0.3 / RANGE.drawT, 1e-9, 'a draw begun 0.3 s ago is a third drawn');
  near(g.archer.t, 0.3, 1e-9, 'and 0.3 s into its phase');
  run(g, 0.3);
  near(g.archer.draw, 0.6 / RANGE.drawT, 1e-6, 'and carries on from there');
  const h = start([person(0)], { layout: range([{}]) });
  h.g.draw(0, true, 9);
  ok(h.g.archer.phase === 'draw', 'a message can only be so old (clamped)');
}
{
  // let go with age: the same arrow as one let go that much earlier
  const shot = (age: number) => {
    const { g } = start([person(0)], { layout: range([{}], 2) });
    const a = aimAt(g, g.mainTarget());
    g.aim(0, a.yaw, a.pitch);
    g.draw(0, true);
    until(g, () => g.archer.phase === 'hold');
    run(g, 0.3);
    if (age > 0) run(g, age);
    g.draw(0, false, age);
    const early = { z: g.shotArrow!.z, y: g.shotArrow!.y, x: g.shotArrow!.x, t: g.t };
    until(g, () => g.state !== 'flight', 5);
    return { g, s: g.last!, early };
  };
  const a = shot(0);
  const b = shot(0.12);
  near(b.s.px, a.s.px, 2e-3, 'the arrow let go with age 0.12 lands where the one let go on time does (x)');
  near(b.s.py, a.s.py, 2e-3, '… (y)');
  near(b.s.flightT, a.s.flightT, 0.02, '… after the same flight');
  ok(b.s.points === a.s.points, 'and scores the same');
  // just after the release it is already 0.12 s along
  const c = start([person(0)], { layout: range([{}], 2) });
  const ac = aimAt(c.g, c.g.mainTarget());
  c.g.aim(0, ac.yaw, ac.pitch);
  c.g.draw(0, true);
  until(c.g, () => c.g.archer.phase === 'hold');
  run(c.g, 0.3);
  c.g.draw(0, false);
  run(c.g, 0.12);
  near(b.early.z, c.g.shotArrow!.z, 2e-3, 'the aged arrow is where the on-time one is 0.12 s after its release');
  near(b.early.y, c.g.shotArrow!.y, 2e-3, '… (height)');
}
{
  // the aim is the aim of then: a jerk of the trigger finger in the last moments doesn't count
  const { g } = start([person(0)], { layout: range([{}]) });
  const A = aimAt(g, g.mainTarget());
  const B = { yaw: A.yaw + 0.05, pitch: A.pitch - 0.03 };
  g.aim(0, A.yaw, A.pitch);
  g.draw(0, true);
  until(g, () => g.archer.phase === 'hold');
  const frame = () => {
    g.step(DT);
  };
  for (let t = 0; t < 0.3; t += DT) (g.aim(0, A.yaw, A.pitch), frame());
  // the phone jerks as the button lifts: 0.1 s of B, then the message arrives
  for (let t = 0; t < 0.1; t += DT) (g.aim(0, B.yaw, B.pitch), frame());
  g.aim(0, B.yaw, B.pitch);
  g.draw(0, false, 0.15);
  near(g.archer.yaw, A.yaw, 1e-6, 'shot along the aim from 0.15 s ago (yaw)');
  near(g.archer.pitch, A.pitch, 1e-6, '… (pitch)');
  // with no age it is the current one
  const h = start([person(0)], { layout: range([{}]) });
  h.g.aim(0, A.yaw, A.pitch);
  h.g.draw(0, true);
  until(h.g, () => h.g.archer.phase === 'hold');
  h.g.aim(0, B.yaw, B.pitch);
  h.g.draw(0, false);
  near(h.g.archer.yaw, B.yaw, 1e-6, 'without an age it is the aim right now');
  // and halfway through the change it's between (the log is interpolated)
  const k = start([person(0)], { layout: range([{}]) });
  k.g.aim(0, A.yaw, A.pitch);
  k.g.draw(0, true);
  until(k.g, () => k.g.archer.phase === 'hold');
  k.g.aim(0, A.yaw, A.pitch);
  k.g.step(0.1);
  k.g.aim(0, B.yaw, B.pitch);
  k.g.step(0.1);
  k.g.aim(0, B.yaw, B.pitch);
  k.g.draw(0, false, 0.1);
  within(k.g.archer.yaw, A.yaw, B.yaw, 'between the frames either side of the instant');
}
{
  // the draw is judged as of the release: a tap that took 0.05 s on the phone is put down, whatever the frames say
  const { g } = start([person(0)], { layout: range([{}]) });
  g.draw(0, true, 0);
  run(g, 0.3);
  g.draw(0, false, 0.28);
  ok(g.archer.phase === 'nock' && g.state === 'aim', 'released 0.02 s into the draw: put down, not shot', [g.archer.phase, g.state]);
  const h = start([person(0)], { layout: range([{}]) });
  h.g.draw(0, true, 0);
  run(h.g, 0.3);
  h.g.draw(0, false, 0);
  ok(h.g.state === 'flight' || h.g.state === 'result', 'the same release with no age is a shot');
  // a weaker draw at the release than now: slower arrow
  const s1 = start([person(0)], { layout: range([{}]) });
  s1.g.draw(0, true, 0);
  run(s1.g, 0.6);
  s1.g.draw(0, false, 0.3);
  const s2 = start([person(0)], { layout: range([{}]) });
  s2.g.draw(0, true, 0);
  run(s2.g, 0.6);
  s2.g.draw(0, false, 0);
  const sp = (g: ArcheryGame) => (g as unknown as { shotSpeed: number }).shotSpeed;
  ok(sp(s1.g) < sp(s2.g) - 1, 'the arrow leaves at the draw it had 0.3 s ago', [sp(s1.g), sp(s2.g)]);
}

console.log(fails ? `${fails} of ${checks} archery checks FAILED.` : `All ${checks} archery checks passed.`);
if (fails) process.exit(1);
