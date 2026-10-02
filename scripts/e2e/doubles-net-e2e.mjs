// End-to-end: the NET player in doubles. "P1 (phone) & CPU vs CPU & CPU", the phone player up at the net (listed second on
// the team: the doubles roles rule is "first listed plays back"; and every point the human is put back at the net, whatever the
// serve/return order made of them), the CPUs serving to us. A simulated phone (as in e2e-swing.mjs) swings at the balls that
// come to the net player; its swing-start and swing reach the TV AGE ms old (the link holds them, as contact-latency.mjs does).
//
// For every opponent's ball the net player could reach (their own plan for it, computed as the planner would: reachable), the
// phone swings so that the ball is at the racket, alternating a full stroke and a short PUNCH (a volley: 600°/s, 150 ms). Checks:
//   (a) the ball is taken: the plan moves to the net player when the swing-start arrives, the drawn ball is held at THEIR racket
//       (Match.holdPlayer is the human), and the hit is credited to them (a `hit` event of theirs, not a 'noball' whiff)
//   (b) the partner does not also swing at it (nor keep the plan)
//   (c) a ball the net player cannot reach is left to the partner: a blind swing at one is a whiff and takes nothing; the
//       partner keeps the plan and plays it as before
//   (d) the drawn ball, as the swing lands, is within 0.4 m of the plan's ball point (median; a volley, AGE = 120 ms)
//   (e) no page errors
//   BASE=http://localhost:3420 AGE=120 SECS=40 node scripts/e2e/doubles-net-e2e.mjs [outDir]
import { launchChrome, outDir } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const AGE = +(process.env.AGE || 120);
const SECS = +(process.env.SECS || 90);
// seconds of the match as it is played (serve, return, rally) before the feeder takes over
const NAT = +(process.env.NAT || 20);
// the opponents' level ('feeder': the ball machine's comfortable feeds; 'club' etc.)
const LEVEL = process.env.LEVEL || 'club';
const out = outDir('doubles-net');
const browser = await launchChrome(['--use-angle=metal', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const logs = [];
const tv = await ctx.newPage();
tv.on('pageerror', (e) => logs.push('[tv] ' + e.message));
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, level: 'club', games: 3, doubles: true })));
await tv.goto(BASE + '/');
await tv.waitForTimeout(1500);
const pad = await ctx.newPage();
pad.on('pageerror', (e) => logs.push('[pad] ' + e.message));
await pad.setViewportSize({ width: 390, height: 844 });
await pad.goto(BASE + '/controller.html?auto');
await pad.evaluate(() => {
  const D = Math.PI / 180;
  window.__ori = { alpha: 0, beta: 35, gamma: 0 };
  const upOf = (b, g) => [-Math.cos(b * D) * Math.sin(g * D), Math.sin(b * D), Math.cos(b * D) * Math.cos(g * D)];
  const emit = (rot, acc) => {
    const o = window.__ori;
    const up = upOf(o.beta, o.gamma);
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: o.alpha, beta: o.beta, gamma: o.gamma }));
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      interval: 16,
      rotationRate: { alpha: rot[2] / D, beta: rot[0] / D, gamma: rot[1] / D },
      acceleration: { x: acc[0], y: acc[1], z: acc[2] },
      accelerationIncludingGravity: { x: acc[0] + up[0] * 9.81, y: acc[1] + up[1] * 9.81, z: acc[2] + up[2] * 9.81 },
    }));
  };
  setInterval(() => { if (!window.__busy) emit([0, 0, 0], [0, 0, 0]); }, 16);
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  // side 'fh'|'bh', peak at +620 ms (a punch: peakDeg 600, sigma 0.0625)
  window.__swing = (side, vUp = 0, aim = 0, peakDeg = 950, sigma = 0.0833, tpeak = 0.62, tEnd = 1.05) => new Promise((done) => {
    window.__busy = true;
    const yaw = side === 'fh' ? 1 : -1;
    const base = side === 'fh' ? -90 : 90;
    const W = peakDeg * D, sig = sigma, tp = tpeak, beta = 15;
    const up = upOf(beta, 0);
    const t0 = performance.now();
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      const w = W * Math.exp(-(((t - tp) / sig) ** 2));
      const psi = yaw * W * sig * (Math.sqrt(Math.PI) / 2) * erf((t - tp) / sig);
      window.__ori = { alpha: base - aim + psi / D, beta, gamma: 0 };
      const aUp = (vUp / 0.12) * Math.exp(-(((t - (tp - 0.06)) / 0.05) ** 2));
      emit(up.map((u) => u * yaw * w), up.map((u) => u * aUp));
      if (t < tEnd) setTimeout(step, 8);
      else { window.__ori = { alpha: 0, beta: 35, gamma: 0 }; window.__busy = false; done(); }
    };
    step();
  });
});
await pad.waitForTimeout(2500);
// ---- the match: P1 (phone) & CPU vs CPU & CPU, the phone player at the net
const setup = await tv.evaluate(async ([age, lvl]) => {
  const f = window.flow;
  const k = window.kaleido;
  f.settings.doubles = true;
  f.settings.level = 'club';
  const cfg = f.buildConfig();
  // (one phone in doubles would play both partners: make the first-listed partner a CPU, and the phone the second, who plays the net)
  const cpu = { ...cfg.players[2], team: 0, name: 'CPU', look: cfg.players[1].look };
  cfg.players = [cpu, cfg.players[0], cfg.players[2], cfg.players[3]];
  cfg.teamNames = [`${cfg.players[1].name} & CPU`, 'CPU & CPU'];
  // (the opponents can be the ball machine's easy feeds: more balls come the net player's way in 40 s than a club-level rally's few)
  if (lvl !== 'club') {
    const { AI_LEVELS } = await import('/src/tv/tennis/ai.ts');
    for (const q of cfg.players) if (q.team === 1) q.ctrl = { kind: 'cpu', ai: AI_LEVELS[lvl] };
  }
  cfg.firstServer = 1;
  cfg.introTime = 0.4;
  cfg.gamesToWin = 3;
  f.beginMatch(k.stage.current?.def.id ?? 'plaza', false, cfg);
  const m = k.match;
  const h = m.players.find((q) => q.human);
  const mate = m.players.find((q) => q.team === h.team && q !== h);
  // every point the phone player is put up at the net (the serve/return order would have them at the back half the time)
  const fixNet = () => {
    if (h.role === 'net') return;
    const [hx, hz, cx, cz] = [h.x, h.z, mate.x, mate.z];
    h.place(cx, cz); mate.place(hx, hz);
    h.role = 'net'; mate.role = 'back';
    m.server === mate && (h.holding = false);
  };
  const sp = m.setupPoint.bind(m);
  m.setupPoint = () => { sp(); fixNet(); };
  fixNet();
  // a session's swings have taught the match how old the phone's swings are (its hold follows the median)
  for (let i = 0; i < 8; i++) m.swingAges.push(age / 1000);
  const A = (window.__att = { all: [], cur: null, hits: [], target: age, frames: 0, next: '?', fid: 0, nFeed: 0 });
  const tmp = { x: 0, y: 0, z: 0 };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  // ---- the link: hold the phone's messages until they are `age` ms old
  const pm = k.input.padMsg.bind(k.input);
  k.input.padMsg = (pid, rt, msg) => {
    if ((msg.type === 'swing' || msg.type === 'swing-start') && A.target > 0) {
      const nat = k.input.ageOf(rt, msg.lat, msg.age, 0.25, msg.ts) * 1000;
      setTimeout(() => pm(pid, rt, msg), Math.max(0, A.target - nat));
      return;
    }
    pm(pid, rt, msg);
  };
  // ---- the feeder (phase 2): an opponent's ball, struck from their baseline at a chosen crossing point over the net, through the match's own flight
  // and replan code (as resolveHit ends), so that 40 s hold a dozen balls for the net player rather than a rally's few
  const { buildShot } = await import('/src/tv/tennis/shot.ts');
  const { COURT } = await import('/src/tv/tennis/court.ts');
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  window.__feed = () => {
    const opp = m.players.find((q) => q.team === 1 && q.role === 'back') ?? m.players.find((q) => q.team === 1);
    if (m.state !== 'play') {
      m.setupPoint();
      m.setState('play');
    }
    // (the net player is in their net spot, as after any point's first shots)
    h.place(Math.max(-3, Math.min(3, h.x)), h.team === 0 ? 3.4 : -3.4);
    mate.athletic = null;
    const side = h.team === 0 ? 1 : -1;
    const z0 = -side * (COURT.halfL + 0.4);
    const x0 = (rnd() - 0.5) * 5;
    const off = (rnd() - 0.5) * 2 * (rnd() < 0.75 ? 1.9 : 4.2);
    const xNet = Math.max(-3.9, Math.min(3.9, h.x + off));
    const tz = side * (6.8 + rnd() * 3.4);
    const fr = (0 - z0) / (tz - z0);
    const tx = Math.max(-4.0, Math.min(4.0, x0 + (xNet - x0) / fr));
    const seg = buildShot({ x: x0, y: 1.05, z: z0 }, { tx, tz, speed: 16 + rnd() * 8, spin: 0.25, clear: 0.55, maxApex: 4.2 }, m.t);
    const b = m.ball;
    b.holder = null;
    m.server.holding = false;
    b.serve = false;
    b.letPending = false;
    b.pop = false;
    b.smash = 0;
    b.live = true;
    b.visible = true;
    b.lastHitTeam = 1 - h.team;
    b.lastHitter = opp;
    b.bounces = [0, 0];
    b.netted = false;
    m.pendingHit = null;
    m.newFlight(seg);
    m.replan();
    m.rally = 1;
    A.fid++;
    // three of four fed balls are the partner's (as replan gives it when their plan costs less)
    if (A.nFeed++ % 4 !== 0 && h.plan) window.__forceMate();
    A.lastFeed = m.t;
    return { off: +off.toFixed(1), xNet: +xNet.toFixed(1), hx: +h.x.toFixed(1) };
  };
  setInterval(() => {
    if (window.__feedOn && !window.__busy && k.match === m && Math.hypot(h.vx, h.vz) < 0.3 && m.t >= h.lockUntil && m.t - (A.lastFeed ?? -9) > 1.9 && (m.state !== 'play' || !m.ball.live || m.t - (A.lastFeed ?? -9) > 3.4)) window.__feed();
  }, 60);
  // what `replan` does when the partner's plan costs less than the net player's: the ball is the partner's, the net player waits in formation
  window.__forceMate = () => {
    if (m.state !== 'play' || !m.ball.live || !h.plan) return false;
    const plan = mate.planFrom(m.path, m.t, mate.ctrl.ai.react, { mustBounce: m.ball.serve, doubles: true, smash: m.ball.pop });
    if (!plan) return false;
    m.stepAside(h, mate);
    mate.plan = plan;
    mate.reactUntil = m.t + mate.ctrl.ai.react;
    return true;
  };
  const snap = () => ({ hPlan: !!h.plan, mPlan: !!mate.plan, mSwing: !!(mate.swing && !mate.swing.provisional), held: m.holdPlayer() === h, hold: m.holdPlayer() === h ? 1 : 0, mAth: !!mate.athletic, smash: !!(h.plan && m.isSmashPlan(h.plan)) });
  A.dbg = [];
  const op = m.poach.bind(m);
  m.poach = (mine, side, tSwing, heard) => {
    const r = op(mine, side, tSwing, heard);
    const tMin = m.t + 0.01;
    const cand = heard ? null : h.planFrom(m.path, tMin - 0.08, m.t - tMin + 0.1, { mustBounce: m.ball.serve, doubles: true, prefer: side, smash: m.ball.pop, at: Math.max(tSwing + 0.1, tMin), spread: 0.12, stretch: 1.2 });
    A.dbg.push({ heard, ret: !!r, t: +m.t.toFixed(3), tSwing: +tSwing.toFixed(3), state: m.state, live: m.ball.live, netted: m.ball.netted, fj: { ...m.flightJudged }, hitTeam: m.ball.lastHitTeam, hSwing: h.swing ? (h.swing.provisional ? 'prov' : 'real') : null, nextOK: +(h.nextSwingOK - m.t).toFixed(2), mSwing: mate.swing ? 'y' : null, mAth: !!mate.athletic, mPlan: !!mate.plan, got: r ? { dt: +(h.plan.t - m.t).toFixed(3), at: +(Math.max(tSwing + 0.1, m.t + 0.01) - m.t).toFixed(3), y: +h.plan.by.toFixed(2), reach: h.plan.reachable } : null, cand: cand ? { dt: +(cand.t - m.t).toFixed(3), reach: cand.reachable, stroke: cand.stroke, cost: +cand.cost.toFixed(2) } : null, hx: +h.x.toFixed(1), hz: +h.z.toFixed(1) });
    return r;
  };
  const os = m.humanSwingStart.bind(m);
  m.humanSwingStart = (slot, side, tOnset) => {
    const before = snap();
    const flight = A.hits.length + A.fid;
    const r = os(slot, side, tOnset);
    const after = snap();
    // a new attempt (or the same one's second onset): the state the onset found and left
    if (!A.cur || A.cur.flight !== flight || A.cur.closed) {
      A.cur = { flight, tOnset: m.t, ageOnset: (m.t - tOnset) * 1000, before, after, planT: h.plan ? h.plan.t - m.t : null, planVolley: h.plan ? h.plan.volley : null, closed: false, kind: A.next, hitsBefore: A.hits.length };
      A.all.push(A.cur);
    }
    return r;
  };
  const osw = m.humanSwing.bind(m);
  m.humanSwing = (slot, inp, tEvent) => {
    if (!A.cur || A.cur.closed) {
      A.cur = { flight: A.hits.length + A.fid, tOnset: null, before: snap(), after: null, closed: false, kind: A.next, noOnset: true, hitsBefore: A.hits.length };
      A.all.push(A.cur);
    }
    const c = A.cur;
    const pre = snap();
    const plan = h.plan;
    const D = m.ballView(m.t, tmp);
    c.swingState = pre;
    c.ageSwing = (m.t - tEvent) * 1000;
    c.dPlan = plan ? dist(D, { x: plan.bx, y: plan.by, z: plan.bz }) : NaN;
    c.planVolley = plan ? plan.volley : c.planVolley;
    c.planStroke = plan ? plan.stroke : null;
    c.tSwingArrive = m.t;
    const bp = m.ballAt(m.t, { x: 0, y: 0, z: 0 });
    c.ballTrue = dist(bp, D);
    const r = osw(slot, inp, tEvent);
    const sw = h.swing;
    c.dContact = sw && sw.hit ? dist(D, { x: sw.cx, y: sw.cy, z: sw.cz }) : NaN;
    c.swung = true;
    return r;
  };
  const oe = k.onMatchEvent;
  k.onMatchEvent = (e) => {
    if (e.type === 'hit') A.hits.push({ t: m.t, who: e.p === h ? 'human' : e.p === mate ? 'mate' : 'opp', kind: e.kind, tau: e.tau, dtMs: e.dtMs, rally: e.rally, serve: e.serve, perfect: e.perfect });
    const c = A.cur;
    if (c && !c.closed) {
      if (e.type === 'hit' && e.p === h) { c.hit = { kind: e.kind, tau: e.tau, dtMs: e.dtMs, kph: e.kph }; c.closed = true; }
      else if (e.type === 'hit' && e.p === mate) c.mateHit = true;
      else if (e.type === 'whiff' && e.p === h) { c.whiff = e.why; c.closed = true; }
    }
    return oe(e);
  };
  const of = k.frame.bind(k);
  k.frame = (now) => {
    of(now);
    A.frames++;
    const c = A.cur;
    if (c && !c.closed) {
      if (mate.swing && !mate.swing.provisional) c.mateSwung = true;
      if (m.state !== 'play' || A.hits.length + A.fid !== c.flight) c.closed = true;
    }
  };
  return { world: k.stage.current?.def.id, human: h.name, slot: h.slot, roles: m.players.map((q) => `${q.name}:${q.team}:${q.ctrl.kind}:${q.role}`), doubles: m.doubles };
}, [AGE, LEVEL]);
console.log('match:', JSON.stringify(setup));
await tv.evaluate(() => (window.__dbgLook = !!1));
await tv.waitForTimeout(500);
// what the net player's own plan for the ball in flight would be (the planner's, for them), and who has it
const look = (lead) =>
  tv.evaluate((lead) => {
    const k = window.kaleido;
    const m = k.match;
    const h = m.players.find((q) => q.human);
    const mate = m.players.find((q) => q.team === h.team && q !== h);
    const base = { state: m.state, score: m.score.points.join('-'), role: h.role };
    if (m.state !== 'play' || !m.ball.live || m.ball.lastHitTeam === h.team || m.ball.netted || m.flightJudged.net || m.flightJudged.out) return base;
    const info = { ...base, flight: window.__att.hits.length + window.__att.fid, mate: !!mate.plan, human: !!h.plan, serve: m.ball.serve, pop: m.ball.pop, hx: +h.x.toFixed(1), hz: +h.z.toFixed(1) };
    if (m.ball.serve) return { ...info, skip: 'serve' };
    // the net player's own ball (replan gave it to them): their plan is the one to swing at
    if (h.plan) {
      const pl = h.plan;
      if (!pl.volley) return { ...info, skip: 'ground stroke' };
      return { ...info, own: true, wall: Date.now() + (pl.t - m.t) * 1000, dt: pl.t - m.t, T: pl.t, reachable: pl.reachable, stroke: pl.stroke, volley: pl.volley, by: pl.by, sz: pl.sz, sx: pl.sx, speed: pl.speed };
    }
    // a ball the net player can get to FROM WHERE THEY STAND: the earliest moment T at which a swing whose peak is at T (its onset arriving AGE ms after)
    // would find a plan it can reach, as the poach will (the same call); their run, from the formation spot, is all the time they have
    const age = window.__att.target / 1000;
    // (poachable at T, and a little sooner and later too: the swing's timing is not exact to the millisecond)
    const poachable = (T) => {
      const arr = T - lead + age;
      const tMin = arr + 0.01;
      const plan = h.planFrom(m.path, tMin - 0.08, arr - tMin + 0.1, { mustBounce: false, doubles: true, smash: m.ball.pop, at: Math.max(T - lead + 0.1, tMin), spread: 0.12, stretch: 1.2 });
      return plan && plan.reachable && plan.volley ? plan : null;
    };
    for (let T = m.t + 0.76; T < m.t + 1.7; T += 0.03) {
      const plan = poachable(T);
      if (plan && plan.stroke !== 'oh' && poachable(T - 0.04) && poachable(T + 0.04)) return { ...info, wall: Date.now() + (T - m.t) * 1000, dt: T - m.t, T, reachable: true, stroke: plan.stroke, volley: plan.volley, by: plan.by, sz: plan.sz, sx: plan.sx, speed: plan.speed, planDt: plan.t - m.t };
    }
    if (window.__dbgLook) {
      const side0 = h.team === 0 ? 1 : -1;
      let best = null;
      for (let i = 0; i < m.path.n; i++) {
        const p = m.path.s[i];
        if (p.z * side0 < 0.4 || p.bounces >= 1 || p.y < 0.22 || p.y > 1.95) continue;
        const d = Math.min(Math.hypot(p.x - h.fhSign * 0.8 - h.x, p.z - side0 * 0.42 - h.z), Math.hypot(p.x + h.fhSign * 0.72 - h.x, p.z - side0 * 0.38 - h.z));
        if (!best || d < best.d) best = { d: +d.toFixed(2), t: +(p.t - m.t).toFixed(2), x: +p.x.toFixed(1), y: +p.y.toFixed(2), z: +p.z.toFixed(1) };
      }
      info.minD = best;
    }
    // no such moment: a ball out of their reach. A blind swing is aimed where it passes the back of the court
    const side = h.team === 0 ? 1 : -1;
    for (let i = 0; i < m.path.n; i++) {
      const p = m.path.s[i];
      if (p.bounces >= 1 && p.z * side > 8.5 && p.t > m.t + 0.76) return { ...info, wall: Date.now() + (p.t - m.t) * 1000, dt: p.t - m.t, T: p.t, reachable: false, stroke: p.x > h.x ? (h.fhSign > 0 ? 'fh' : 'bh') : h.fhSign > 0 ? 'bh' : 'fh', volley: false, by: p.y, sz: p.z, sx: p.x, speed: 0 };
    }
    return { ...info, skip: 'no moment' };
  }, lead);
const stats = { flights: 0, reachable: 0, swings: 0, blind: 0, noSwing: 0, own: 0, ownSwings: 0 };
let lastFlight = -1;
let n = 0;
const t0 = Date.now();
const log = [];
let fedOn = false;
while (Date.now() - t0 < SECS * 1000) {
  if (!fedOn && Date.now() - t0 > NAT * 1000) {
    fedOn = true;
    await tv.evaluate(() => (window.__feedOn = true));
    console.log(`--- ${NAT} s of the match as it is played; from here the opponents' balls are fed to the net player's zone`);
  }
  const nextKind = n % 2 ? 'punch' : 'full';
  let s = await look(nextKind === 'punch' ? 0.06 : 0.1);
  if (s.flight === undefined || s.flight === lastFlight) {
    await tv.waitForTimeout(12);
    continue;
  }
  // a flight is judged once, when it first shows (right after the opponent's hit)
  lastFlight = s.flight;
  stats.flights++;
  if (process.env.DBG) console.log(`flight ${stats.flights} ${((Date.now() - t0) / 1000).toFixed(1)}s role ${s.role} ${s.skip ?? `dt ${s.dt.toFixed(2)} reach ${s.reachable} ${s.stroke} volley ${s.volley} y ${s.by.toFixed(2)} sz ${s.sz.toFixed(1)} plan+${s.planDt?.toFixed(2)}`} mate ${s.mate} human ${s.human} at ${s.hx},${s.hz} ${s.minD ? JSON.stringify(s.minD) : ''}`);
  if (s.skip) { stats.noSwing++; continue; }
  // The net player's own balls (replan gave them the plan): every second one is given to the partner, as replan does when the partner's plan costs
  // less, and the ball is then a poach; the others are swung at as they are (the control: the same hold and judgement as in singles).
  // The net player's own balls (replan gave them the plan) are swung at as they are: the control, with the hold and judgement of singles.
  // The partner's are the poach trials (three in four fed balls are given to the partner, as replan does when their plan costs less).
  if (s.own) {
    stats.own++;
    if (!s.reachable) { stats.noSwing++; continue; }
    stats.ownSwings++;
  } else if (!s.mate) { stats.noSwing++; continue; }
  if (s.stroke === 'oh') { stats.noSwing++; continue; }
  if (s.reachable) stats.reachable++;
  if (s.dt < 0.68) { stats.noSwing++; continue; }
  // reachable: swing at it (a full stroke, then a punch, alternating). Not reachable: every second one, a blind swing at where the ball goes
  let kind;
  if (s.reachable) kind = n++ % 2 ? 'punch' : 'full';
  else if (stats.flights % 2) kind = 'blind';
  else { stats.noSwing++; continue; }
  if (s.dt > 1.5) { stats.noSwing++; continue; }
  await tv.evaluate(([kd]) => { window.__att.next = kd; window.__att.cur = null; window.__busy = true; }, [kind]);
  // (the pad's clock is the page's: the swing is started 620 ms before the wall time the ball is at the racket, then its peak is there)
  await pad.evaluate(
    ([wall, sd, kd]) =>
      new Promise((res) => {
        const go = () => {
          const d = wall - 620 - Date.now();
          if (d > 12) return void setTimeout(go, d - 8);
          while (Date.now() < wall - 620) {}
          (kd === 'punch' ? window.__swing(sd, 0, 0, 600, 0.0625, 0.62, 0.95) : window.__swing(sd, 0, 0)).then(res);
        };
        go();
      }),
    [s.wall, s.stroke, kind],
  );
  if (kind === 'blind') stats.blind++;
  else stats.swings++;
  log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${kind} ${s.stroke} ${s.volley ? 'volley' : 'ground'} dt ${s.dt.toFixed(2)} reach ${s.reachable} mate ${s.mate} human ${s.human} y ${s.by.toFixed(2)} sz ${s.sz.toFixed(1)} v ${s.speed.toFixed(0)}`);
  await tv.waitForTimeout(500);
  await tv.evaluate(() => (window.__busy = false));
}

const A = await tv.evaluate(() => ({ all: window.__att.all, hits: window.__att.hits, frames: window.__att.frames, dbg: window.__att.dbg }));
if (process.env.DBG) console.log('poach calls:\n  ' + A.dbg.map((d) => JSON.stringify(d)).join('\n  '));
console.log('swing log:\n  ' + log.join('\n  '));
await tv.screenshot({ path: out + '/doubles-net.png' });
// ---- the checks
const q = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
const f = (a, d = 2, u = '') => (a.filter(Number.isFinite).length ? `p50 ${q(a, 0.5).toFixed(d)}  p90 ${q(a, 0.9).toFixed(d)}  max ${q(a, 1).toFixed(d)}${u} (n=${a.filter(Number.isFinite).length})` : 'n=0');
if (process.env.DBG) console.log('attempts:\n  ' + A.all.map((r) => JSON.stringify(r)).join('\n  '));
const rows = A.all.filter((r) => r.swung);
const real = rows.filter((r) => r.kind === 'full' || r.kind === 'punch');
const blind = rows.filter((r) => r.kind === 'blind');
let bad = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) bad++; };
console.log(`\nplay: ${stats.flights} opponent balls looked at; ${stats.reachable} reachable for the net player; ${stats.swings} swings at reachable balls, ${stats.blind} blind swings at unreachable ones, ${stats.own} were the net player's own (${stats.ownSwings} swung at as the control), ${stats.noSwing} left alone`);
console.log(`hits over the run: ${A.hits.filter((x) => x.who === 'human').length} by the phone player (${A.hits.filter((x) => x.who === 'human' && x.kind === 'volley').length} volleys), ${A.hits.filter((x) => x.who === 'mate').length} by the CPU partner, ${A.hits.filter((x) => x.who === 'opp').length} by the opponents`);
for (const kd of ['full', 'punch']) {
  const R = real.filter((r) => r.kind === kd);
  if (!R.length) continue;
  console.log(`\n--- ${kd} strokes at reachable balls (${R.length}), swing age ${AGE} ms (onset ${f(R.map((r) => r.ageOnset), 0, ' ms')}; swing ${f(R.map((r) => r.ageSwing), 0, ' ms')})`);
  const taken = R.filter((r) => r.noOnset ? false : r.after && r.after.hPlan);
  console.log(`  plan had been the partner's when the onset arrived: ${R.filter((r) => r.before && !r.before.hPlan && r.before.mPlan).length}; the net player's already: ${R.filter((r) => r.before && r.before.hPlan).length}; nobody's: ${R.filter((r) => r.before && !r.before.hPlan && !r.before.mPlan).length}`);
  console.log(`  after the onset: the net player has the plan in ${taken.length}, the drawn ball is held at their racket in ${R.filter((r) => r.after && r.after.held).length}, the partner still has one in ${R.filter((r) => r.after && r.after.mPlan).length}`);
  console.log(`  hit credited to the net player: ${R.filter((r) => r.hit).length}; whiffs: ${R.filter((r) => r.whiff).length} ${JSON.stringify(R.filter((r) => r.whiff).map((r) => r.whiff))}; no result: ${R.filter((r) => !r.hit && !r.whiff).length}`);
  console.log(`  timing of the hits (ms, + late): ${f(R.filter((r) => r.hit).map((r) => r.hit.dtMs), 0)}; shots: ${JSON.stringify(R.filter((r) => r.hit).map((r) => r.hit.kind))}`);
  console.log(`  (d) drawn ball to the plan's ball point as the swing lands: ${f(R.map((r) => r.dPlan), 2, ' m')}; to the swing's contact point: ${f(R.map((r) => r.dContact), 2, ' m')}`);
  console.log(`  (d) volleys only: ${f(R.filter((r) => r.planVolley).map((r) => r.dPlan), 2, ' m')}`);
}
console.log('\nchecks:');
// (a partner already in a lunge or dive for the ball is not robbed of it: those don't count)
const started = real.filter((r) => r.before && !r.before.hPlan && r.before.mPlan && !r.before.mAth);
check(real.length >= 4, `enough swings at reachable balls (${real.length})`);
const stolen = real.filter((r) => r.before && !r.before.hPlan && r.after && r.after.hPlan);
check(started.length === 0 || stolen.length / started.length >= 0.6, `(a) the plan moves to the net player on the onset: ${stolen.length} of ${started.length} balls that were the partner's`);
check(real.filter((r) => r.after && r.after.hPlan && !r.after.held && !r.after.smash).length === 0, `(a) the drawn ball is held at their racket whenever they have the plan (${real.filter((r) => r.after && r.after.hPlan && !r.after.held && !r.after.smash).length} not held; ${real.filter((r) => r.after && r.after.smash).length} were smash chances, which have bullet time instead)`);
const hitRate = real.filter((r) => r.hit).length / Math.max(1, real.length);
check(hitRate >= 0.7 && real.filter((r) => r.whiff === 'noball').length <= 1, `(a) the hit is credited to the net player: ${(hitRate * 100).toFixed(0)}% of swings, ${real.filter((r) => r.whiff === 'noball').length} 'noball' whiffs`);
check(real.filter((r) => r.after && r.after.hPlan && (r.after.mPlan || r.after.mSwing || r.mateSwung || r.mateHit)).length === 0, `(b) the partner does not also go for it: ${real.filter((r) => r.after && r.after.hPlan && r.after.mPlan).length} kept the plan, ${real.filter((r) => r.mateSwung).length} swung, ${real.filter((r) => r.mateHit).length} hit`);
if (blind.length) {
  console.log(`--- blind swings at balls the net player cannot reach (${blind.length}): plan taken ${blind.filter((r) => r.after && r.after.hPlan).length}, results ${JSON.stringify(blind.map((r) => (r.whiff ?? (r.hit ? 'HIT' : '-'))))}, partner kept the plan ${blind.filter((r) => r.swingState && r.swingState.mPlan).length}`);
  check(blind.filter((r) => r.after && r.after.hPlan).length === 0 && blind.filter((r) => r.hit).length === 0, `(c) a ball they cannot reach is not taken: ${blind.filter((r) => r.after && r.after.hPlan).length} taken, ${blind.filter((r) => r.hit).length} hit`);
} else console.log('  (no blind swings were made)');
const dv = real.filter((r) => r.planVolley).map((r) => r.dPlan);
check(dv.length === 0 || q(dv, 0.5) <= 0.4, `(d) the drawn ball is within 0.4 m of the plan point as the swing lands (median ${q(dv, 0.5).toFixed(2)} m, ${dv.length} volleys)`);
check(logs.length === 0, `(e) no page errors ${logs.join(' | ')}`);
console.log(bad ? `\nSOME CHECKS FAILED (${bad})` : '\nnet-player checks passed');
await browser.close();
if (bad) process.exitCode = 1;
