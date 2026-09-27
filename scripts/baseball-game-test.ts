// Baseball checks: the pitches (through the zone where aimed, when the game says,
// from the pitcher's hand into the catcher's mitt; the kinds' speeds and breaks;
// always strikes; easy down the middle, hard at the edges), a swing's timing and
// the phone's latency (the error measured right whenever the message arrives; a
// late message rewinds the ball out of the mitt; an early one is met at the plate;
// swings before the release, from the wrong seat, or twice, ignored; takes and
// misses are strikes, settled once no swing can still be on its way), what the
// bat does to the ball (a perfect swing homers, a way-early one is foul, a
// way-late one fouls back, a lazy one dies on the warning track), the hitstop,
// the batted ball's flight through the diorama (every home run clears the fence
// by metres, nothing else crosses it; hang, apex, speed off the bat, a steeper
// fall than rise; the distance read-out rises steadily to exactly the distance),
// the turns, the ranking and its ties, the pacing, skip(), the view and the stage
// directions, determinism (seeds; frame rates), and no NaNs across thousands of
// random swings.
//   npx tsx scripts/baseball-game-test.ts        (BASEBALL_DT=0.05 runs them at 20 fps)

import { BaseballGame, BASEBALL_TIMING, DISPLAY_LAG, WINDOW, SWING_OPEN, HITSTOP, AGE_MAX, WAITING_SPOTS, type BaseballOptions } from '../src/tv/baseball/game';
import { FIELD, DELIVERY, SWING, fenceAt, realFenceAt, sprayOf, isFair } from '../src/tv/baseball/field';
import type { BaseballEvent, BatSwing, Hitter, PitchKind } from '../src/tv/baseball/types';
import { FLY, MITT_Z, PITCH_KINDS, PITCH_RUN, REAL, batBall, pitchAt, planPitch, readout, realFlight, sample, timingQuality, type FlightSample, type WorldFlight } from '../src/tv/baseball/physics';
import { PITCHER, choosePitch, hitterProfile } from '../src/tv/baseball/ai';
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

const look = {} as Hitter['look'];
const person = (slot: number, handed: 1 | -1 = 1, color = '#e33'): Hitter => ({ name: `P${slot}`, color, look, handed, slot, cpu: null });
const cpu = (skill: number, handed: 1 | -1 = 1, color = '#39f'): Hitter => ({ name: `CPU ${skill}`, color, look, handed, slot: -1, cpu: skill });

/** frame time for the checks */
const DT = Number(process.env.BASEBALL_DT ?? 1 / 60);

function run(g: BaseballGame, secs: number, dt = DT) {
  const end = g.t + secs;
  while (g.t < end - 1e-9) {
    const before = g.t;
    g.step(Math.min(dt, end - g.t));
    // (a hitstop eats frames without moving the clock)
    if (g.t === before && g.hitstop <= 0) break;
  }
}
function until(g: BaseballGame, cond: () => boolean, max = 30, dt = DT) {
  let frames = 0;
  const cap = max / dt + 400;
  while (!cond() && frames++ < cap) g.step(dt);
  return cond();
}
const lastOf = <T extends BaseballEvent['type']>(ev: BaseballEvent[], type: T) => ev.filter((e) => e.type === type).pop() as Extract<BaseballEvent, { type: T }> | undefined;
const countOf = (ev: BaseballEvent[], type: BaseballEvent['type']) => ev.filter((e) => e.type === type).length;

/** a game past the intro, with events logged */
function start(hitters: Hitter[] = [person(0)], opts: BaseballOptions = {}) {
  const g = new BaseballGame(hitters, { seed: 1, ...opts });
  const ev: BaseballEvent[] = [];
  g.onEvent = (e) => ev.push(e);
  g.skip();
  return { g, ev };
}

/** until the next pitch is out of the hand */
function pitchOut(g: BaseballGame, dt = DT) {
  return until(g, () => g.state === 'pitch', 20, dt);
}

/**
 * A person at `slot` swings at the pitch in the air: its fastest moment when the ball was
 * `e` s from the plate as they saw it; the message gets here `age` s after that, in
 * between frames. Returns the game time it arrived.
 */
function swingAt(g: BaseballGame, slot: number, e: number, s: Partial<BatSwing> = {}, dt = DT) {
  const p = g.pitch!;
  const age = s.age ?? 0.08;
  const arrive = p.tc + e + DISPLAY_LAG + age;
  while (g.t + dt < arrive && g.state === 'pitch') g.step(dt);
  const since = Math.max(0, arrive - g.t);
  g.swing(slot, { power: s.power ?? 1, lift: s.lift ?? 0.45, age }, since);
  return arrive;
}

/** play out the pitch in the air until its result */
function toResult(g: BaseballGame, dt = DT) {
  return until(g, () => g.state === 'result' || g.state === 'over', 20, dt);
}

// ---------------------------------------------------------------- pitches

{
  let worst = 0;
  let strikes = 0;
  let n = 0;
  const kinds = new Set<PitchKind>();
  const r = new Rng(3);
  for (let i = 0; i < 3000; i++) {
    const pitching = r.next();
    const ph: 1 | -1 = i % 2 ? 1 : -1;
    const pl = choosePitch(pitching, r, ph);
    kinds.add(pl.kind);
    const [lo, hi] = PITCH_KINDS[pl.kind].speed;
    if (pl.speed < lo - 1e-9 || pl.speed > hi + 1e-9) ok(false, `${pl.kind} at ${pl.speed} m/s: out of its range`);
    {
      const { pitch, path } = planPitch(pl.kind, pl.speed, pl.px, pl.py, ph, 5);
      const c = pitchAt(path, pitch.tc - pitch.t0, { x: 0, y: 0, z: 0 });
      worst = Math.max(worst, Math.hypot(c.x - pl.px, c.y - pl.py, c.z - FIELD.contactZ));
      const m = pitchAt(path, path.arrive, { x: 0, y: 0, z: 0 });
      worst = Math.max(worst, Math.hypot(m.x - path.mittX, m.y - path.mittY, m.z - MITT_Z));
      if (pitch.strike) strikes++;
      n++;
    }
  }
  ok(worst < 1e-9, 'a pitch crosses the contact plane where it was aimed at tc, and meets the mitt at (mittX, mittY) on its plane', worst);
  ok(strikes === n, 'the pitcher throws strikes: every pitch crosses the zone (thousands, every pitching level)', `${strikes}/${n}`);
  ok(kinds.size === 4, 'all four kinds turn up', [...kinds]);
  const { pitch, path } = planPitch('fastball', 25, 0, 0.8, 1, 2);
  const r0 = pitchAt(path, 0, { x: 0, y: 0, z: 0 });
  near(r0.x, -FIELD.releaseSide, 1e-12, "a right-hander releases on his throwing-arm side (−x: he faces +z)");
  near(r0.y, FIELD.releaseY, 1e-12, 'head high');
  near(r0.z, FIELD.releaseZ, 1e-12, 'out in front of the rubber');
  near(planPitch('fastball', 25, 0, 0.8, -1, 2).path.x0, FIELD.releaseSide, 1e-12, 'a left-hander at +x');
  near(PITCH_RUN, 14.45, 1e-9, 'the release is 14.45 m from the contact plane');
  near(pitch.tc - pitch.t0, 14.45 / 25, 1e-12, 'a 25 m/s pitch takes 14.45/25 s to the plate');
  near(pitch.kmh, (25 * 16.8 * 3.6) / 14.45, 1e-9, "km/h on the HUD is a real pitch's (16.8 m / 14.45 m)");
  near(path.arrive, (MITT_Z - FIELD.releaseZ) / 25, 1e-12, 'it reaches the mitt plane (catcherZ − 0.35) this long after the release');
  near(MITT_Z, FIELD.catcherZ - 0.35, 1e-12, 'the mitt plane');
}
{
  // the breaks: against a straight line from the hand to the plate crossing, halfway there
  const dev = (kind: PitchKind, speed: number, handed: 1 | -1 = 1) => {
    const { path } = planPitch(kind, speed, 0, 0.8, handed, 0);
    const mid = pitchAt(path, path.tc / 2, { x: 0, y: 0, z: 0 });
    return { x: mid.x - (path.x0 + 0) / 2, y: mid.y - (path.y0 + 0.8) / 2 };
  };
  const fb = dev('fastball', 25);
  const sl = dev('slider', 21.5);
  const cu = dev('curve', 18.5);
  const ch = dev('changeup', 17);
  ok(sl.x < fb.x - 0.2 && cu.x < fb.x - 0.1, "a right-hander's slider and curve break to his glove side (+x): the path bows the other way on the way", [fb.x, sl.x, cu.x]);
  ok(ch.x > fb.x + 0.1, "…a changeup fades to his arm side", [fb.x, ch.x]);
  ok(cu.y > fb.y + 0.5 && ch.y > fb.y + 0.4, 'a curve (and a changeup) arcs up and drops much more than a fastball', [fb.y, cu.y, ch.y]);
  ok(cu.y > sl.y, '…the curve the most', [sl.y, cu.y]);
  ok(dev('slider', 21.5, -1).x > 0.2, "a left-hander's slider breaks the other way", dev('slider', 21.5, -1).x);
  // an easy pitcher: fastballs down the middle at a friendly pace; a hard one mixes it up at the edges, harder
  const r = new Rng(9);
  const stats = (pitching: number) => {
    let fbs = 0;
    let off = 0;
    let fbSpeed = 0;
    for (let i = 0; i < 2000; i++) {
      const p = choosePitch(pitching, r);
      if (p.kind === 'fastball') ((fbs += 1), (fbSpeed += p.speed));
      off += Math.max(Math.abs(p.px) / FIELD.zoneHalfW, Math.abs(p.py - PITCHER.middleY) / 0.3);
    }
    return { fb: fbs / 2000, off: off / 2000, fbSpeed: fbSpeed / Math.max(1, fbs) };
  };
  const easy = stats(0);
  const mid = stats(0.5);
  const hard = stats(1);
  ok(easy.fb === 1, 'an easy pitcher throws only fastballs', easy.fb);
  within(mid.fb, 0.6, 0.75, 'a middling one: mostly fastballs');
  within(hard.fb, 0.28, 0.42, 'a hard one: the full mix');
  ok(easy.off < 0.3 && hard.off > 0.65 && mid.off > easy.off && mid.off < hard.off, 'easy grooves it; hard paints the edges', [easy.off, mid.off, hard.off]);
  ok(easy.fbSpeed < 24 && hard.fbSpeed > 25.5, 'easy is friendlier: a slower fastball', [easy.fbSpeed, hard.fbSpeed]);
  const a = choosePitch(0.7, new Rng(4));
  const b = choosePitch(0.7, new Rng(4));
  ok(JSON.stringify(a) === JSON.stringify(b), 'the same rng, the same pitch');
}

// ---------------------------------------------------------------- the swing's timing and the phone's latency

{
  // the coordinator's case: the peak as the ball reaches the plate (seen at tc: e = −DISPLAY_LAG), the message 0.15 s old at tc + 0.15
  const { g, ev } = start();
  pitchOut(g);
  const p = g.pitch!;
  until(g, () => g.t + DT >= p.tc + 0.15);
  const since = p.tc + 0.15 - g.t;
  const caughtFirst = countOf(ev, 'catch') === 1;
  g.swing(0, { power: 1, lift: 0.45, age: 0.15 }, since);
  const sw = lastOf(ev, 'swing');
  ok(!!sw && sw.contact, 'a swing peaking at tc, arriving at tc + 0.15 s (0.15 s old): contact', sw);
  near(sw?.timing ?? 9, -DISPLAY_LAG, 1e-9, '…measured e = −DISPLAY_LAG');
  ok(caughtFirst && g.state === 'flight' && !!lastOf(ev, 'contact'), '…after the catcher had it: rewound out of the mitt, a hit', [caughtFirst, g.state]);
  const v = g.view({ x: 0, y: 2, z: 16 });
  ok(v.ball.phase === 'play' && Math.hypot(v.ball.x - p.px, v.ball.y - p.py, v.ball.z - FIELD.contactZ) < 1e-9, '…the ball back at the contact point', v.ball);
}
{
  // a phone swing peaking at tc + DISPLAY_LAG — perfect — whatever its age: measured ~0 (the e2e wants ≤ 45 ms)
  for (const age of [0.04, 0.08, 0.12, 0.16]) {
    for (const betweenFrames of [false, true]) {
      const { g, ev } = start([person(0)], { seed: 11 });
      pitchOut(g);
      const p = g.pitch!;
      const arrive = p.tc + DISPLAY_LAG + age;
      // delivered on the next frame with no `since` (what an integrator without it does), or exactly
      while (g.t < arrive - 1e-12) g.step(DT);
      g.swing(0, { power: 0.9, lift: 0.4, age: age + (betweenFrames ? 0 : g.t - arrive) }, 0);
      const sw = lastOf(ev, 'swing');
      ok(!!sw && Math.abs(sw.timing) <= (betweenFrames ? DT + 1e-9 : 1e-9), `a perfect phone swing, ${age * 1000} ms old${betweenFrames ? ', handled a frame late' : ''}: |e| ≤ ${betweenFrames ? 'a frame' : '0'}`, sw?.timing);
      ok(!!sw && Math.abs(sw.timing) <= 0.045 && sw.contact, '…within the e2e harness’s 45 ms, and contact');
    }
  }
}
{
  // a slower TV (displayLag): a swing peaking as the ball is shown at the plate measures perfect; the strike waits longer for it
  const { g, ev } = start([person(0)], { seed: 11, displayLag: 0.1 });
  pitchOut(g);
  const p = g.pitch!;
  const arrive = p.tc + 0.1 + 0.08;
  while (g.t + DT < arrive) g.step(DT);
  g.swing(0, { power: 0.9, lift: 0.4, age: 0.08 }, arrive - g.t);
  near(lastOf(ev, 'swing')?.timing ?? 9, 0, 1e-9, 'displayLag 0.1: a swing at the ball as that TV shows it is perfect');
  near(g.swingOpen, WINDOW.contact + 0.1 + AGE_MAX, 1e-12, '…and a swing can still meet the ball that much later');
  const d = new BaseballGame([person(0)], { seed: 1 });
  ok(d.displayLag === DISPLAY_LAG && d.swingOpen === SWING_OPEN, 'the default: DISPLAY_LAG');
}
{
  // a late message outside the window: a swinging strike; the pitch was caught on time
  const { g, ev } = start();
  pitchOut(g);
  const p = g.pitch!;
  swingAt(g, 0, WINDOW.contact + 0.02, { age: 0.1 });
  const sw = lastOf(ev, 'swing');
  ok(!!sw && !sw.contact && sw.timing > WINDOW.contact, 'too late: no contact', sw);
  toResult(g);
  const res = lastOf(ev, 'result');
  ok(res?.outcome === 'strike', '…a swinging strike', res);
  ok(g.batter.phase === 'swing' || g.batter.phase === 'sad', 'the batter swings through and hangs his head', g.batter.phase);
  const catchT = ev.findIndex((e) => e.type === 'catch');
  ok(catchT >= 0 && catchT < ev.findIndex((e) => e.type === 'result'), "the 'catch' came first, on time");
  void p;
}
{
  // no swing: 'catch' as the mitt takes it (on time); the strike only once no swing can still be coming
  const { g, ev } = start();
  pitchOut(g);
  const p = g.pitch!;
  let catchAt = -1;
  let resultAt = -1;
  g.onEvent = (e) => {
    ev.push(e);
    if (e.type === 'catch') catchAt = g.t;
    if (e.type === 'result') resultAt = g.t;
  };
  toResult(g);
  near(catchAt, p.t0 + (MITT_Z - FIELD.releaseZ) / p.speed, 1e-9, "a take: 'catch' exactly when the ball reaches the mitt");
  ok(lastOf(ev, 'catch')?.strike === true, "…'catch' says strike");
  near(resultAt, p.tc + SWING_OPEN, 1e-9, '…the strike settled at tc + window + DISPLAY_LAG + the oldest a message can be');
  near(SWING_OPEN, WINDOW.contact + DISPLAY_LAG + AGE_MAX, 1e-12, 'SWING_OPEN');
  ok(lastOf(ev, 'result')?.outcome === 'strike' && g.log[0][0].outcome === 'strike' && g.log[0][0].distance === 0, 'takes are strikes', g.log[0]);
  ok(g.batter.phase === 'sad', 'the batter takes it badly', g.batter.phase);
  // …and a swing message that turns up just before that still counts
  const h = start();
  pitchOut(h.g);
  const q = h.g.pitch!;
  until(h.g, () => h.g.t + DT >= q.tc + SWING_OPEN - 0.01);
  h.g.swing(0, { power: 0.8, lift: 0.3, age: AGE_MAX }, q.tc + SWING_OPEN - 0.01 - h.g.t);
  const sw = lastOf(h.ev, 'swing');
  ok(!!sw && sw.contact && h.g.state === 'flight', 'a swing as late as can be (e = window, the oldest message): still contact', sw);
}
{
  // a swing message that gets here before the ball reaches the plate is met when it does
  const { g, ev } = start();
  pitchOut(g);
  const p = g.pitch!;
  let contactAt = -1;
  let swingT = -1;
  g.onEvent = (e) => {
    ev.push(e);
    if (e.type === 'contact') ((contactAt = g.t), (swingT = g.batter.t));
  };
  const e0 = -0.09;
  const arrived = swingAt(g, 0, e0, { age: 0.03 });
  ok(arrived < p.tc && g.state === 'pitch' && !lastOf(ev, 'contact'), 'an early message (here before the ball is at the plate): not met yet', [arrived - p.tc, g.state]);
  ok(lastOf(ev, 'swing')?.contact === true, "…but the 'swing' event says it will be");
  until(g, () => g.state === 'flight');
  near(contactAt, p.tc, 1e-9, '…met exactly as the ball crosses the contact plane');
  near(swingT, SWING.contact, 1e-9, '…with the batter at the contact frame');
  near(g.hit!.timing, e0, 1e-9, '…at the timing it was swung');
  ok(g.hit!.foul, 'that early: foul', g.hit);
}
{
  // swings before the release are ignored; so are other seats, a CPU's turn, a second swing
  const { g, ev } = start([person(0), person(1)]);
  until(g, () => g.state === 'windup');
  g.swing(0, { power: 1, lift: 0.4, age: 0.05 });
  ok(countOf(ev, 'swing') === 0, 'a swing during the windup: ignored');
  pitchOut(g);
  g.swing(0, { power: 1, lift: 0.4, age: 0.3 });
  ok(countOf(ev, 'swing') === 0, 'a message whose swing peaked before the ball was out of the hand: ignored');
  g.swing(1, { power: 1, lift: 0.4, age: 0.05 });
  ok(countOf(ev, 'swing') === 0, "someone else's swing: ignored");
  swingAt(g, 0, 0.2, { age: 0.08 });
  ok(countOf(ev, 'swing') === 1, 'a (very late) swing: one');
  g.swing(0, { power: 1, lift: 0.4, age: 0.05 });
  ok(countOf(ev, 'swing') === 1, 'a second swing at the same pitch: ignored');
  const c = start([cpu(0.6), person(0)]);
  pitchOut(c.g);
  c.g.swing(0, { power: 1, lift: 0.4, age: 0.05 });
  ok(c.ev.filter((e) => e.type === 'swing' && e.who !== 0).length === 0 && c.g.current === 0, "a person's swing on the CPU's turn: ignored");
  const g2 = new BaseballGame([person(2)], { seed: 3 });
  g2.swing(2, { power: 1, lift: 0.4, age: 0.05 });
  ok(g2.state === 'ready', 'a swing during the intro skips it', g2.state);
}
{
  // the hitstop: game time freezes (70 ms, 110 ms on the sweet spot), the batter at the contact frame, then it's away
  for (const sweet of [true, false]) {
    const { g, ev } = start([person(0)], { seed: 5 });
    pitchOut(g);
    swingAt(g, 0, sweet ? 0.005 : 0.045, { age: 0.1 });
    ok(lastOf(ev, 'contact')?.ball.sweet === sweet, sweet ? 'on the sweet spot' : 'off it');
    const t0 = g.t;
    near(g.hitstop, sweet ? HITSTOP.sweet : HITSTOP.hit, 1e-12, `the hitstop: ${sweet ? 110 : 70} ms`);
    ok(g.batter.phase === 'swing' && Math.abs(g.batter.t - SWING.contact) < 1e-12, 'the batter at the contact frame', g.batter);
    const frozen = sweet ? HITSTOP.sweet : HITSTOP.hit;
    let used = 0;
    while (used + DT < frozen - 1e-9) {
      g.step(DT);
      used += DT;
      ok(g.t === t0 && Math.abs(g.batter.t - SWING.contact) < 1e-9 && g.liveDistance() === 0, '…frozen (game time, the batter, the read-out)', [g.t - t0, g.batter.t, g.liveDistance()]);
    }
    const v = g.view({ x: 0, y: 2, z: 16 });
    ok(v.ball.phase === 'play' && v.ball.speed === 0 && Math.abs(v.ball.z - FIELD.contactZ) < 1e-9, '…the ball held at the contact point', v.ball);
    g.step(DT);
    near(g.t - t0, DT - (frozen - used), 1e-9, 'then the clock runs again with what was left of the frame');
    ok(g.hitstop === 0 && g.catcher.phase === 'watch', '…and the catcher stands up to watch it go', g.catcher.phase);
  }
}
{
  // a late message rewinds the pitcher and catcher to the moment the bat met the ball
  const { g } = start();
  pitchOut(g);
  const p = g.pitch!;
  swingAt(g, 0, 0, { age: 0.12 });
  // the moment it met it: tc (e = 0)
  near(g.catcher.t, p.tc - p.t0, 1e-9, "the catcher's reach, back to when the bat met it");
  ok(g.catcher.phase === 'catch', '…still reaching (not holding it)');
  const pt = g.pitcher.phase === 'windup' ? g.pitcher.t : g.pitcher.t + DELIVERY.end;
  near(pt, DELIVERY.release + (p.tc - p.t0), 1e-9, "the pitcher's delivery, back to that moment too");
}

// ---------------------------------------------------------------- what the bat does to the ball

{
  // a perfect swing homers: every pitching level, every kind, both hands, via the phone
  let n = 0;
  let hr = 0;
  const dist: number[] = [];
  for (let seed = 1; seed <= 60; seed++) {
    const pitching = (seed % 5) / 4;
    const { g, ev } = start([person(0, seed % 2 ? 1 : -1)], { seed, pitching });
    for (let k = 0; k < 3; k++) {
      pitchOut(g);
      swingAt(g, 0, 0, { power: 1, lift: 0.45, age: 0.04 + ((seed * 7 + k) % 9) * 0.01 });
      toResult(g);
      const r = lastOf(ev, 'result')!;
      n++;
      if (r.outcome === 'homerun') ((hr += 1), dist.push(r.distance));
      g.skip();
    }
  }
  ok(hr === n, 'a perfect, full-power swing with a good plane homers — every time', `${hr}/${n}`);
  within(Math.min(...dist), 118, 160, '…a long way');
  within(Math.max(...dist), 140, 160, '…the best of them ~150 m');
}
{
  // straight from the contact model: the spec's distances
  const pitch = planPitch('fastball', 24.5, 0, 0.84, 1, 0).pitch;
  const r = new Rng(21);
  const avg = (e: number, power: number, lift: number, n = 400) => {
    let d = 0;
    let hr = 0;
    for (let i = 0; i < n; i++) {
      const b = batBall(e, power, lift, pitch, 1, r).ball;
      d += b.distance;
      if (b.homeRun) hr++;
    }
    return { d: d / n, hr: hr / n };
  };
  const monster = avg(0, 1, 0.5);
  within(monster.d, 140, 156, 'a monster (sweet, full power, ideal launch): ~150 m');
  const good = avg(0.01, 0.8, 0.3);
  within(good.d, 118, 138, 'a good-power, well-timed swing with a normal plane: 105–135 m');
  ok(good.hr >= 0.85, '…a home run', good.hr);
  const lazy = avg(0, 0.15, 0.2);
  within(lazy.d, 70, 95, 'a lazy one: ~70–90 m');
  ok(lazy.hr === 0, '…not out');
  ok(timingQuality(0) === 1 && timingQuality(WINDOW.sweet) > timingQuality(WINDOW.fair) && timingQuality(WINDOW.fair) > timingQuality(WINDOW.contact), 'contact quality falls away from the sweet spot');
  // exit speed ~50 m/s real, perfect and full power
  const b = batBall(0, 1, 0.45, pitch, 1, new Rng(1)).ball;
  within(b.exitSpeed, 48, 53, 'a perfect max-power swing: ~50 m/s off the bat');
  // real flight sanity: 50 m/s at 28° ~ 147 m; drag's real
  within(realFlight(50, (28 * Math.PI) / 180, 0.9).distance, 140, 155, 'real physics: 50 m/s at 28° carries ~147 m');
  within(realFlight(40, (28 * Math.PI) / 180, 0.9).distance, 100, 118, '…40 m/s ~111 m');
}
{
  // timing → where it goes: early pulls (a right-hander pulls to −x), late goes the other way, very early/late foul, very late fouled back
  const pitch = planPitch('fastball', 24.5, 0, 0.84, 1, 0).pitch;
  const r = new Rng(8);
  const spray = (e: number, handed: 1 | -1) => {
    let s = 0;
    let foul = 0;
    let back = 0;
    for (let i = 0; i < 300; i++) {
      const b = batBall(e, 0.9, 0.4, pitch, handed, r).ball;
      s += b.spray;
      if (b.foul) foul++;
      if (Math.abs(b.spray) > Math.PI / 2) back++;
    }
    return { s: s / 300, foul: foul / 300, back: back / 300 };
  };
  ok(spray(-0.04, 1).s < -0.2 && spray(0.04, 1).s > 0.2, 'a right-hander: early pulls to −x, late goes to +x', [spray(-0.04, 1).s, spray(0.04, 1).s]);
  ok(spray(-0.04, -1).s > 0.2 && spray(0.04, -1).s < -0.2, 'a left-hander the other way');
  ok(Math.abs(spray(0, 1).s) < 0.06, 'perfect: straight away');
  ok(spray(-0.05, 1).foul < 0.15 && spray(0.05, 1).foul < 0.15, 'well inside the fair window: fair');
  ok(spray(-0.1, 1).foul === 1 && spray(-0.1, 1).back === 0, 'way early: foul (pulled into the stands)');
  ok(spray(0.1, 1).foul === 1 && spray(0.1, 1).back === 0 && spray(0.1, 1).s > 0.6, 'late: foul the other way');
  ok(spray(0.12, 1).back === 1, 'very late: fouled straight back');
}
{
  // a way-early swing through the game: foul
  const { g, ev } = start([person(0)], { seed: 4 });
  pitchOut(g);
  swingAt(g, 0, -0.1, { age: 0.08 });
  toResult(g);
  ok(lastOf(ev, 'result')?.outcome === 'foul', 'a way-early swing is foul', lastOf(ev, 'result'));
  ok(g.log[0][0].outcome === 'foul', '…and logged so');
}

// ---------------------------------------------------------------- the batted ball's flight through the diorama

/** fly it: all the samples of its path, every 1/240 s until it's gone or stopped */
function path(f: WorldFlight) {
  const pts: FlightSample[] = [];
  const end = Math.min(f.goneT, f.T + 4);
  for (let t = 0; t <= end + 1e-9; t += 1 / 240) pts.push({ ...sample(f, t, { x: 0, y: 0, z: 0, speed: 0, s: 0 }) });
  pts.push({ ...sample(f, f.T, { x: 0, y: 0, z: 0, speed: 0, s: 0 }) });
  return pts;
}
{
  const r = new Rng(77);
  let hrs = 0;
  let others = 0;
  let badClear = 0;
  let minClear = 99;
  let crossed = 0;
  let nan = 0;
  let wallBad = 0;
  let nonMono = 0;
  let readEnd = 0;
  let readFence = 0;
  let steep = 0;
  let slow = 0;
  const hang: number[] = [];
  const apex: number[] = [];
  const beyond: number[] = [];
  const standsY: number[] = [];
  let outs = 0;
  let outNear = 0;
  const kinds: PitchKind[] = ['fastball', 'slider', 'curve', 'changeup'];
  for (let i = 0; i < 6000; i++) {
    const kind = kinds[i % 4];
    const [lo, hi] = PITCH_KINDS[kind].speed;
    const pitch = planPitch(kind, r.range(lo, hi), r.range(-0.21, 0.21), r.range(0.57, 1.09), r.chance(0.5) ? 1 : -1, 0).pitch;
    const e = r.range(-WINDOW.contact, WINDOW.contact);
    const handed = r.chance(0.5) ? 1 : -1;
    const bt = batBall(e, r.next(), r.range(-1, 1), pitch, handed, r);
    const b = bt.ball;
    const f = bt.flight;
    const vals = [b.timing, b.exitSpeed, b.launch, b.spray, b.distance, b.hang, b.landX, b.landY, b.landZ, b.apex, f.T, f.S, f.q, f.H, f.vy0];
    if (vals.some((v) => !Number.isFinite(v))) nan++;
    const pts = path(f);
    if (pts.some((p) => !Number.isFinite(p.x + p.y + p.z + p.speed + p.s))) nan++;
    // the read-out: steady, the fence's number at the fence, exactly the distance where it comes down
    let prev = -1;
    for (let t = 0; t < f.T; t += 1 / 240) {
      const d = readout(f, b.distance, sample(f, t, { x: 0, y: 0, z: 0, speed: 0, s: 0 }).s);
      if (!Number.isFinite(d)) nan++;
      if (d < prev - 1e-9) nonMono++;
      prev = d;
    }
    if (Math.abs(readout(f, b.distance, f.S) - b.distance) > 1e-9) readEnd++;
    // does its path go over the fence (in fair territory)? how high is it there?
    let over = false;
    let hAt = -1;
    for (let k = 1; k < pts.length - 1; k++) {
      const a = sprayOf(pts[k - 1].x, pts[k - 1].z);
      const c = sprayOf(pts[k].x, pts[k].z);
      const inA = a.r < fenceAt(a.a);
      const inC = c.r < fenceAt(c.a);
      if (inA && !inC && isFair(c.a)) {
        over = true;
        hAt = pts[k].y;
        break;
      }
    }
    const land = sprayOf(b.landX, b.landZ);
    if (b.homeRun) {
      hrs++;
      if (!over) badClear++;
      else minClear = Math.min(minClear, hAt);
      hang.push(b.hang);
      apex.push(b.apex);
      if (f.end === 'out') {
        outs++;
        if (land.r < 40) outNear++;
      } else {
        beyond.push(land.r - fenceAt(land.a));
        standsY.push(b.landY);
      }
      if (Math.abs(readout(f, b.distance, f.fenceS) - realFenceAt(b.spray)) > 1e-6) readFence++;
      // leaves fast, comes down steeper than it went up
      const p0 = sample(f, 0, { x: 0, y: 0, z: 0, speed: 0, s: 0 });
      if (p0.speed < 25 - 1e-9) slow++;
      const up = Math.atan2(sample(f, 0.02, { x: 0, y: 0, z: 0, speed: 0, s: 0 }).y - p0.y, 0.02 * 1e-9 + (sample(f, 0.02, { x: 0, y: 0, z: 0, speed: 0, s: 0 }).s - p0.s));
      const a1 = sample(f, f.T - 0.02, { x: 0, y: 0, z: 0, speed: 0, s: 0 });
      const a2 = sample(f, f.T - 1e-6, { x: 0, y: 0, z: 0, speed: 0, s: 0 });
      const down = Math.atan2(a1.y - a2.y, a2.s - a1.s);
      if (!(down > up)) steep++;
    } else {
      others++;
      if (over) crossed++;
      if (b.wall && !(b.landY < FIELD.fenceH && Math.abs(land.r - (fenceAt(land.a) - FIELD.ballR)) < 0.05)) wallBad++;
    }
  }
  ok(nan === 0, 'no NaNs (or infinities) across 6000 random swings: the batted ball, its flight, its read-out', nan);
  ok(badClear === 0, 'every home run’s world path goes over the fence…', badClear);
  ok(minClear >= FIELD.fenceH + 1, `…well over it (the lowest ${minClear.toFixed(2)} m, the fence ${FIELD.fenceH} m)`, minClear);
  ok(crossed === 0, `…and no other ball’s path crosses it (${others} of them, bounces and rolls included)`, crossed);
  ok(wallBad === 0, 'a ball off the wall meets it below the top, at the fence');
  ok(nonMono === 0, 'the distance read-out only ever rises', nonMono);
  ok(readEnd === 0, '…and comes to rest on exactly the distance');
  ok(readFence === 0, "…reading the fence's painted number as it clears it");
  ok(slow === 0, 'a home run leaves the bat at ≥ 25 m/s (world)', slow);
  ok(steep === 0, '…and comes down more steeply than it went up', steep);
  const pc = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
  within(pc(hang, 0.05), 2.4, 2.7, 'home runs hang 2.5–3.5 s (5th percentile)');
  within(pc(hang, 0.95), 2.9, 3.6, '…(95th)');
  within(Math.min(...apex), 8, 9, 'a home run’s apex 8–14 m (lowest)');
  within(pc(apex, 0.95), 11, 14.6, '…(95th)');
  within(Math.min(...beyond), 2.9, 4, 'into the stands 3–10 m beyond the fence (nearest)');
  within(Math.max(...beyond), 8, 10.1, '…(furthest)');
  within(Math.min(...standsY), 1.9, 2.2, '…at bleacher height, 2–4 m (lowest)');
  within(Math.max(...standsY), 3, 4.1, '…(highest)');
  ok(outNear === 0, `a monster flies right out of the stadium (40 m+) (${outs} of ${hrs} home runs here)`, outNear);
  // monsters on purpose: dead centre, full power, the ideal plane, a hard pitcher's fastball up in the zone
  let out = 0;
  let far = 99;
  let most = 0;
  for (let i = 0; i < 200; i++) {
    const pitch = planPitch('fastball', 27, r.range(-0.05, 0.05), r.range(0.9, 1.0), 1, 0).pitch;
    const bt = batBall(r.range(-0.004, 0.004), 1, r.range(0.4, 0.55), pitch, 1, r);
    if (bt.flight.end === 'out') {
      out++;
      far = Math.min(far, sprayOf(bt.ball.landX, bt.ball.landZ).r);
      most = Math.max(most, bt.ball.distance);
    }
  }
  ok(out > 100, 'the best swing at a fast pitch is often a monster', out);
  ok(far >= 40, '…out of the stadium: comes down 40 m+ from home', far);
  within(most, 147, 156, '…~150 m (the longest)');
}
{
  // through the game: the ball follows the flight; liveDistance rises steadily to exactly the distance
  let checked = 0;
  let mono = true;
  let exact = true;
  let fenceNum = true;
  for (let seed = 1; seed <= 12; seed++) {
    const { g, ev } = start([cpu(0.9)], { seed });
    for (let k = 0; k < 10 && g.state !== 'over'; k++) {
      until(g, () => g.state === 'flight' || g.state === 'result' || g.state === 'over');
      if (g.state !== 'flight') {
        until(g, () => g.state !== 'result');
        continue;
      }
      let prev = 0;
      const h = g.hit!;
      const f = g.battedFlight!;
      while (g.state === 'flight') {
        g.step(DT);
        const d = g.liveDistance();
        if (d < prev - 1e-9) mono = false;
        if (h.homeRun && f.fenceT >= 0 && prev < realFenceAt(h.spray) - 1e-6 && d > realFenceAt(h.spray) + 1e-6 && g.t - g.hitT < f.fenceT - 0.1) fenceNum = false;
        prev = d;
      }
      if (Math.abs(prev - h.distance) > 1e-9) exact = false;
      if (lastOf(ev, 'land')?.ball !== h) exact = false;
      checked++;
      until(g, () => g.state !== 'result');
    }
  }
  ok(checked > 50 && mono, `liveDistance only ever rises through a flight (${checked} flights)`);
  ok(exact, "…and lands exactly on hit.distance ('land' fired with the ball)");
  ok(fenceNum, '…passing the fence’s number as the ball passes the fence');
}

// ---------------------------------------------------------------- turns, the log, the ranking, the pacing

{
  const hitters = [person(0), cpu(0.5), person(1, -1), cpu(0.8)];
  const { g, ev } = start(hitters, { pitches: 3, seed: 2 });
  const order: number[] = [];
  const left: number[][] = hitters.map(() => []);
  g.onEvent = (e) => {
    ev.push(e);
    if (e.type === 'turn') order.push(e.who);
    if (e.type === 'result') left[e.who].push(e.pitchesLeft);
  };
  let guard = 0;
  while (g.state !== 'over' && guard++ < 60000) {
    const h = g.hitters[g.current];
    if (h.cpu === null && g.state === 'pitch' && g.pitch && g.t + DT >= g.pitch.tc) swingAt(g, h.slot, 0.01, { power: 0.8, age: 0.07 });
    g.step(DT);
  }
  ok(g.state === 'over', 'a four-hitter derby gets to the end');
  ok(JSON.stringify(order) === JSON.stringify([1, 2, 3]) && lastOf(ev, 'turn')?.pitches === 3, 'the turns go in order (the first hitter’s came with the intro)', order);
  ok(ev.find((e) => e.type === 'turn')?.type === 'turn' && (ev.find((e) => e.type === 'turn') as { who: number }).who === 0, "hitter 0's turn first");
  ok(
    g.log.every((l) => l.length === 3),
    'each hitter gets their pitches',
    g.log.map((l) => l.length),
  );
  ok(
    left.every((l) => JSON.stringify(l) === '[2,1,0]'),
    "'result' counts the pitches left",
    left,
  );
  const over = lastOf(ev, 'over');
  ok(!!over && JSON.stringify(over.ranking) === JSON.stringify(g.ranking()), "'over' carries the ranking");
  ok(g.batter.phase === 'cheer' || g.batter.phase === 'idle', 'the last batter: cheering if they won', g.batter.phase);
}
{
  // ranking: home runs, then total home-run distance, then the longest, then batting order
  const g = new BaseballGame([person(0), person(1), person(2), person(3)], { seed: 1 });
  const L = g.log;
  L[0].push({ outcome: 'homerun', distance: 120 }, { outcome: 'homerun', distance: 130 });
  L[1].push({ outcome: 'homerun', distance: 125 }, { outcome: 'homerun', distance: 125 }, { outcome: 'hit', distance: 118 });
  L[2].push({ outcome: 'homerun', distance: 150 }, { outcome: 'foul', distance: 90 });
  L[3].push({ outcome: 'homerun', distance: 110 }, { outcome: 'homerun', distance: 140 });
  // 0 and 1 and 3 have 2 HRs, 250 m each: 0 has the longest? no — 3's 140 is longest, then 0's 130, then 1's 125
  ok(JSON.stringify(g.ranking()) === JSON.stringify([3, 0, 1, 2]), 'ties on home runs and total distance go to the longest, then batting order', g.ranking());
  ok(g.homeRuns(1) === 2 && g.total(1) === 250 && g.longest(1) === 125 && g.longestHit(1) === 125, 'the counts', [g.homeRuns(1), g.total(1), g.longest(1)]);
  ok(g.longest(2) === 150 && g.longestHit(2) === 150 && g.total(2) === 150, 'a foul doesn’t count');
  const h = new BaseballGame([person(0), person(1), person(2)], { seed: 1 });
  h.log[1].push({ outcome: 'homerun', distance: 121 });
  h.log[2].push({ outcome: 'homerun', distance: 121 });
  ok(JSON.stringify(h.ranking()) === JSON.stringify([1, 2, 0]), 'a dead heat: batting order', h.ranking());
  const k = new BaseballGame([person(0), person(1)], { seed: 1 });
  k.log[0].push({ outcome: 'homerun', distance: 101 }, { outcome: 'hit', distance: 119 });
  k.log[1].push({ outcome: 'homerun', distance: 131 });
  ok(JSON.stringify(k.ranking()) === JSON.stringify([1, 0]), 'equal home runs: more home-run distance wins (a long out doesn’t count)', k.ranking());
}
{
  // pacing: a take cycles in ~3.5 s, a home run in ~7–8 s (windup to windup); the intro ~2.5 s
  const g = new BaseballGame([person(0)], { seed: 6 });
  const ev: BaseballEvent[] = [];
  const wind: number[] = [];
  let turnAt = -1;
  g.onEvent = (e) => {
    ev.push(e);
    if (e.type === 'windup') wind.push(g.t);
    if (e.type === 'turn') turnAt = g.t;
  };
  until(g, () => turnAt >= 0);
  near(turnAt, BASEBALL_TIMING.intro, 1e-9, "the intro: 'turn' after 2.5 s");
  pitchOut(g);
  until(g, () => wind.length === 2);
  within(wind[1] - wind[0], 3.3, 3.85, 'a taken pitch: ~3.5 s windup to windup');
  pitchOut(g);
  swingAt(g, 0, 0, { power: 1, lift: 0.45, age: 0.06 });
  until(g, () => wind.length === 3, 20);
  ok(lastOf(ev, 'result')?.outcome === 'homerun', '(a home run)');
  within(wind[2] - wind[1], 7, 8.6, 'a home run: ~7.5–8 s windup to windup (game time; plus the hitstop)');
  // a CPU's miss
  const c = new BaseballGame([cpu(0)], { seed: 6 });
  const cw: number[] = [];
  let missAt = -1;
  c.onEvent = (e) => {
    if (e.type === 'windup') cw.push(c.t);
    if (e.type === 'result' && e.outcome === 'strike' && missAt < 0) missAt = cw.length;
  };
  c.skip();
  until(c, () => missAt > 0 && cw.length > missAt, 200);
  within(cw[missAt] - cw[missAt - 1], 3, 3.6, "a CPU's miss: quicker (it's settled as the mitt takes it)");
}
{
  // skip(): the intro, the switch, the celebration once it's down, a result
  const { g } = start([cpu(1), cpu(1)], { pitches: 1, seed: 3 });
  ok(g.state === 'ready', 'skip() in the intro: straight to the first pitch', g.state);
  until(g, () => g.state === 'flight' && g.hitstop === 0);
  const t0 = g.t;
  g.skip();
  ok(g.state === 'flight' && g.t === t0, "skip() mid-flight: nothing (it's still up)");
  until(g, () => g.liveDistance() === g.hit!.distance && g.hit!.distance > 0);
  g.step(DT);
  g.skip();
  ok(g.state === 'result', 'skip() once it’s down: to the result', g.state);
  g.skip();
  ok(g.state === 'switch' && g.current === 1, 'skip() on the result: on to the next hitter', [g.state, g.current]);
  g.skip();
  ok(g.state === 'ready', 'skip() as they step in: to the pitch', g.state);
}

// ---------------------------------------------------------------- the view and the stage directions

{
  const { g, ev } = start([person(0, 1, '#123456'), cpu(0.7, -1, '#654321')], { seed: 8 });
  const v0 = g.view({ x: 0, y: 1.9, z: 16.3 });
  ok(v0.ball.phase === 'hand' && !v0.tracer && v0.color === '#123456' && v0.marks.length === 0, 'before the pitch: the ball in the hand, no tracer, the batter’s colour');
  near(v0.eye.z, 16.3, 1e-12, 'the eye is passed through');
  ok(g.batter.phase === 'stance' && g.pitcher.phase === 'set' && g.catcher.phase === 'crouch', 'ready: stance, set, crouch', [g.batter.phase, g.pitcher.phase, g.catcher.phase]);
  near(g.batter.x, -FIELD.boxX, 1e-12, 'a right-handed batter stands at −x');
  near(g.batter.z, FIELD.homeZ - 0.2, 1e-12, '…just in front of home plate');
  ok(g.catcher.targetY > 0 && g.catcher.arrive > 0.5, 'the catcher sets up where the pitch is going', g.catcher);
  const kind = g.pitcher.kind;
  let wt = -1;
  g.onEvent = (e) => {
    ev.push(e);
    if (e.type === 'windup') wt = g.t;
  };
  until(g, () => g.state === 'windup');
  ok(lastOf(ev, 'windup')?.kind === kind, "'windup' says what's coming");
  let releasedAt = -1;
  g.onEvent = (e) => {
    ev.push(e);
    if (e.type === 'pitch') releasedAt = g.pitcher.t;
  };
  pitchOut(g);
  near(releasedAt, DELIVERY.release, 1e-9, "'pitch' as the ball leaves the hand: DELIVERY.release into the windup");
  near(g.pitch!.t0 - wt, DELIVERY.release, 1e-9, '…pitch.t0');
  const v1 = g.view({ x: 0, y: 1.9, z: 16.3 });
  ok(v1.ball.phase === 'pitch' && g.batter.phase === 'load' && g.catcher.phase === 'catch', 'the pitch: the ball flying, the batter loading, the catcher reaching', [v1.ball.phase, g.batter.phase, g.catcher.phase]);
  near(g.catcher.targetX, planPitch(g.pitch!.kind, g.pitch!.speed, g.pitch!.px, g.pitch!.py, 1, 0).path.mittX, 1e-12, "the mitt's target is where the ball will be");
  near(g.catcher.arrive, (MITT_Z - FIELD.releaseZ) / g.pitch!.speed, 1e-12, '…and when');
  ok(!!g.batter.look && g.batter.look.z < FIELD.homeZ, 'the batter watches the pitch in', g.batter.look);
  // a perfect swing: contact, tracer, flight, marks
  swingAt(g, 0, 0, { power: 1, lift: 0.45, age: 0.07 });
  const v2 = g.view({ x: 0, y: 1.9, z: 16.3 });
  ok(v2.tracer && v2.fx.some((f) => f.type === 'contact' && f.sweet), 'contact: the tracer on, a sweet contact effect', v2.fx);
  until(g, () => g.hitstop === 0 && g.batter.phase !== 'swing');
  ok(g.batter.phase === 'cheer' || g.batter.phase === 'watch', 'the swing done: watching it (a no-doubter: the bat flip right away)', g.batter.phase);
  until(g, () => g.pitcher.phase === 'watch');
  ok(!!g.pitcher.look && !!g.catcher.look && g.catcher.phase === 'watch', 'the pitcher and catcher turn to watch it', [g.pitcher.phase, g.catcher.phase]);
  const fx: string[] = [];
  let cheering = false;
  while (g.state === 'flight') {
    g.step(DT);
    for (const f of g.view({ x: 0, y: 1.9, z: 16.3 }).fx) fx.push(f.type);
    if (g.hitterState(1).phase === 'cheer') cheering = true;
  }
  ok(fx.includes('homerun') && fx.includes('land'), "a home run: 'homerun' where it goes out, 'land' where it comes down", fx);
  ok(cheering, 'the hitter waiting their turn cheers it');
  ok(g.batter.phase === 'cheer', 'so does the batter', g.batter.phase);
  const v3 = g.view({ x: 0, y: 1.9, z: 16.3 });
  ok(v3.marks.length === 1 && Math.abs(v3.marks[0].x - g.hit!.landX) < 1e-9, "this turn's home runs, where they came down", v3.marks);
  ok(v3.ball.phase === 'gone' && v3.tracer, 'into the stands, then gone; the tracer stays', v3.ball.phase);
  until(g, () => g.state === 'pitch');
  ok(!g.view({ x: 0, y: 1.9, z: 16.3 }).tracer, '…until the next pitch leaves the hand');
  // the waiting hitter
  const w = g.hitterState(1);
  ok(w !== g.batter && Math.abs(Math.abs(w.x) - 5.6) < 2 && w.z >= 13.5 && w.z <= 15.5 && w.phase === 'idle', 'the others wait off to the side, x ≈ ±(5…7.5), z 13.5–15.5', w);
  ok(WAITING_SPOTS.every((s) => Math.abs(s.x) >= 5 && Math.abs(s.x) <= 7.5 && s.z >= 13.5 && s.z <= 15.5), '…every spot');
  ok(Math.abs(w.yaw) < Math.PI / 2, '…facing the field', w.yaw);
  ok(g.hitterState(0) === g.batter, 'the one in the box is `batter`');
  // a take: the ball into the mitt, then thrown back to the pitcher
  let seen = new Set<string>();
  until(g, () => {
    seen.add(g.view({ x: 0, y: 1.9, z: 16.3 }).ball.phase + ':' + g.catcher.phase);
    return g.state === 'windup';
  });
  ok(seen.has('mitt:catch') && seen.has('mitt:throw') && seen.has('pitch:throw') && seen.has('hand:crouch'), 'a take: into the mitt, the catcher throws it back, the pitcher has it before the next windup', [...seen]);
  seen = new Set();
}
{
  // the CPU's swing is shown in sync: the bat at the contact frame exactly as it meets the ball
  const g = new BaseballGame([cpu(0.8), cpu(0.3)], { seed: 12 });
  let n = 0;
  let bad = 0;
  let swingEv = 0;
  g.onEvent = (e) => {
    if (e.type === 'contact') {
      n++;
      if (Math.abs(g.batter.t - SWING.contact) > 1e-9 || g.batter.phase !== 'swing') bad++;
    }
    if (e.type === 'swing') {
      swingEv++;
      if (g.batter.phase !== 'swing' || g.batter.t > 1e-9) bad++;
    }
  };
  g.skip();
  until(g, () => g.state === 'over', 400);
  ok(n > 5 && bad === 0 && swingEv === 20, `a CPU's swing starts as its 'swing' event fires, and the bat's at the contact frame as it meets the ball (${n} contacts)`, [bad, swingEv]);
}

// ---------------------------------------------------------------- determinism: seeds, frame rates

function cpuDerby(seed: number, dt: number, pitching = 0.5) {
  const g = new BaseballGame([cpu(0.3), cpu(0.6, -1), cpu(0.9)], { seed, pitching });
  const log: string[] = [];
  g.onEvent = (e) => {
    if (e.type === 'result' || e.type === 'contact' || e.type === 'pitch') log.push(JSON.stringify(e));
  };
  g.skip();
  let k = seed;
  while (g.state !== 'over' && g.t < 900) {
    k = (k * 1103515245 + 12345) & 0x7fffffff;
    g.step(dt * (0.7 + (0.6 * k) / 0x7fffffff));
  }
  return { g, log: log.join('\n') };
}
{
  const a = cpuDerby(7, 1 / 60);
  const b = cpuDerby(7, 1 / 60);
  ok(a.g.state === 'over', 'a CPU derby finishes');
  ok(a.log === b.log, 'deterministic for a seed');
  ok(cpuDerby(8, 1 / 60).log !== a.log, '…different for another');
  for (const dt of [1 / 30, 1 / 144, 0.05]) ok(cpuDerby(7, dt).log === a.log, `the same derby at ${Math.round(1 / dt)} fps (every event at its exact time)`);
  // the same seed, the same pitches, whoever's batting
  const pitches = (hitters: Hitter[]) => {
    const g = new BaseballGame(hitters, { seed: 42, pitches: 4 });
    const p: string[] = [];
    g.onEvent = (e) => {
      if (e.type === 'pitch') p.push(`${e.pitch.kind} ${e.pitch.speed.toFixed(6)} ${e.pitch.px.toFixed(6)} ${e.pitch.py.toFixed(6)}`);
    };
    g.skip();
    until(g, () => g.state === 'over', 400);
    return p.slice(0, 4).join('|');
  };
  ok(pitches([cpu(0.2)]) === pitches([cpu(0.95), person(0)]), 'the same seed, the same pitches, whoever bats');
}
{
  // no NaNs through whole games of random swings (people), every pitching level
  let bad = 0;
  const r = new Rng(99);
  for (let seed = 1; seed <= 40; seed++) {
    const { g } = start([person(0, seed % 2 ? 1 : -1), person(1)], { seed, pitching: r.next(), pitches: 5 });
    let guard = 0;
    while (g.state !== 'over' && guard++ < 20000) {
      const h = g.hitters[g.current];
      if (g.state === 'pitch' && r.chance(0.04)) g.swing(h.slot, { power: r.range(-0.2, 1.3), lift: r.range(-1.5, 1.5), age: r.range(-0.05, 0.3) }, r.range(0, 0.02));
      g.step(DT * r.range(0.5, 1.5));
      const v = g.view({ x: 0, y: 2, z: 16 });
      const nums = [g.t, v.ball.x, v.ball.y, v.ball.z, v.ball.speed, g.liveDistance(), g.batter.t, g.pitcher.t, g.catcher.t, g.catcher.targetX, g.catcher.targetY];
      if (nums.some((x) => !Number.isFinite(x))) bad++;
    }
    if (g.state !== 'over') bad++;
  }
  ok(bad === 0, 'whole derbies of random swings (junk inputs too): no NaNs, and they finish', bad);
  const g = new BaseballGame([person(0)], { seed: 1 });
  g.skip();
  pitchOut(g);
  g.swing(0, { power: NaN, lift: Infinity, age: NaN });
  ok(Number.isFinite(g.batter.power) && Number.isFinite(g.batter.lift), 'a swing message with junk in it: sane', g.batter);
}

// ---------------------------------------------------------------- the CPU hitters

{
  const p3 = hitterProfile(0.3);
  const p9 = hitterProfile(0.9);
  ok(p9.timingSd < p3.timingSd && p9.power > p3.power && p9.lift > p3.lift, 'skill tightens the timing, adds power and a better plane');
  const avg = (skill: number) => {
    let hr = 0;
    let n = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const g = new BaseballGame([cpu(skill), cpu(skill)], { seed: 500 + seed });
      g.skip();
      until(g, () => g.state === 'over', 600);
      hr += g.homeRuns(0) + g.homeRuns(1);
      n += 2;
    }
    return hr / n;
  };
  within(avg(0.3), 1.3, 2.7, 'Rookie: about 2 home runs in 10');
  within(avg(0.6), 3.2, 4.8, 'Pro: about 4');
  within(avg(0.9), 5.6, 7.4, 'Ace: about 6.5');
  void REAL;
  void FLY;
}

console.log(fails ? `${fails} of ${checks} baseball checks FAILED.` : `All ${checks} baseball checks passed.`);
if (fails) process.exit(1);
