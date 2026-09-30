// Online play at internet delays: the online match stream, run through a lag proxy (scripts/lib/lag-proxy.mjs)
// that delays, jitters and now and then stalls every WebSocket frame in both directions, order kept.
//
// Per profile a host TV (its own room, in `wrangler dev`), a guest TV that joined by the room code, and the
// GUEST's phone (a fake one, opened from the guest's QR link, so it carries &via=<gid>) play a tennis match:
// the guest's phone is the only person, playing for team 1 against the CPU, so the guest also looks from the far end.
//
//   profile   guest TV + its phone go through            host TV goes through
//   a         40 ± 8 ms one way                          straight to the relay
//   b         90 ± 15 ms
//   c         150 ± 30 ms, 2 % of frames +150 ms
//   d         40 ± 8 ms                                  60 ± 10 ms (the host far from the Durable Object)
//
// What is measured (the table at the end, and a PASS / FAIL for each):
//   - the guest's stream stats (one-way p50 / p90 / max, buffer, render lag, dropped, late events, resyncs)
//   - the frame gaps of the guest page over the rally: p99 ≤ 18.7 ms (the network must not make it hitch)
//   - the guest's ball against the host's at the same host time: ≤ 2 cm; no ball teleports the host's own ball doesn't make
//   - every match event reached the guest, in order
//   - the guest phone's swings: the network time the host credits a swing (phone's lat estimate + the relay's transit) against the
//     true one (measured phone send → host receipt on the shared clock): unbiased, off by about the jitter; and
//     the swings the phone times on the host's toss / the ball's arrival, peak on schedule, are judged HITS (not whiffs)
//   - the swing echo: the guest hears its own phone's swing at once (relay → guest), long before the stream shows the hit
//   - the guest looks from its phone's end (team 1: the far end) and a Kaleido shift shatters from the same spot in the court
//
//   node scripts/online-lag-e2e.mjs                   (builds dist/ if there is none, starts `wrangler dev` on 8798 and kills it after)
//   PROFILES=a,c SECONDS=30 OUT=dir BASE=http://127.0.0.1:8798 node scripts/online-lag-e2e.mjs
//   BUILD=1   run `npx vite build` first
import { chromium } from 'playwright-core';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { start as startProxy } from './lib/lag-proxy.mjs';
import { phone } from './lib/fake-phone.mjs';

const WPORT = Number(process.env.WRANGLER_PORT || 8798);
const BASE = process.env.BASE || `http://127.0.0.1:${WPORT}`;
const GUEST_PORT = Number(process.env.GUEST_PORT || 8799);
const HOST_PORT = Number(process.env.HOST_PORT || 8800);
const SECONDS = Number(process.env.SECONDS || 30);
const OUT = process.env.OUT || '.';
// (two TVs and a phone render on one machine: small screens keep the frame gaps about the game, not the GPU)
const HOST_W = Number(process.env.HOST_W || 640);
const GUEST_W = Number(process.env.GUEST_W || 800);
const WANT = (process.env.PROFILES || 'a,b,c,d').split(',');
mkdirSync(OUT, { recursive: true });

const PROFILES = [
  { id: 'a', name: '40 ± 8 ms', guest: { delay: 40, jitter: 8 } },
  { id: 'b', name: '90 ± 15 ms', guest: { delay: 90, jitter: 15 } },
  { id: 'c', name: '150 ± 30 ms + 2% spikes', guest: { delay: 150, jitter: 30, spike: 0.02, spikeMs: 150 } },
  { id: 'd', name: 'guest 40 ± 8, host 60 ± 10', guest: { delay: 40, jitter: 8 }, host: { delay: 60, jitter: 10 } },
  // (a reference, not in the default run: the proxy adds nothing, so what is left is this machine's own frame noise)
  { id: 'z', name: 'no added delay (reference)', guest: { delay: 0, jitter: 0 } },
].filter((p) => WANT.includes(p.id));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const results = [];
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => {
  const m = mean(a);
  return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : NaN;
};
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');

// ---------------------------------------------------------------- wrangler dev
let wr = null;
const alive = async () => {
  try {
    const r = await fetch(BASE + '/api/info');
    return r.ok;
  } catch {
    return false;
  }
};
const cleanup = () => {
  if (wr) {
    try {
      process.kill(-wr.pid, 'SIGTERM');
    } catch {}
    wr = null;
  }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (cleanup(), process.exit(130)));
if (!(await alive())) {
  if (process.env.BUILD || !existsSync('dist/index.html')) {
    console.log('npx vite build …');
    execSync('npx vite build', { stdio: 'ignore' });
  }
  console.log(`npx wrangler dev --port ${WPORT} …`);
  wr = spawn('npx', ['wrangler', 'dev', '--port', String(WPORT)], { detached: true, stdio: 'ignore' });
  const t0 = Date.now();
  while (!(await alive())) {
    if (Date.now() - t0 > 90000) {
      cleanup();
      throw new Error('wrangler dev did not come up');
    }
    await sleep(500);
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });

// ---------------------------------------------------------------- one profile
async function runProfile(P) {
  const R = { id: P.id, name: P.name, checks: [], notes: [] };
  const check = (name, ok, detail = '') => {
    R.checks.push({ name, ok, detail });
    if (!ok) fail++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  };
  console.log(`\n=== profile ${P.id}: ${P.name}`);
  const errors = [];
  const watch = (page, name) => {
    page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) errors.push(`[${name} console] ${m.text()}`);
    });
  };
  const gp = await startProxy({ ...P.guest, up: BASE, port: GUEST_PORT });
  const hp = P.host ? await startProxy({ ...P.host, up: BASE, port: HOST_PORT }) : null;
  const hostBase = hp ? hp.url : BASE;
  const guestBase = gp.url;
  const hostCtx = await browser.newContext({ viewport: { width: HOST_W, height: (HOST_W * 9) / 16 } });
  const guestCtx = await browser.newContext({ viewport: { width: GUEST_W, height: (GUEST_W * 9) / 16 } });
  const padCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await padCtx.addInitScript(phone);
  // (the phone stamps each swing message as it leaves, on the clock all the pages share)
  await padCtx.addInitScript(() => {
    window.__sent = {};
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (typeof d === 'string' && d.includes('"type":"swing"')) {
        try {
          const m = JSON.parse(d);
          window.__sent[m.seq] = performance.timeOrigin + performance.now();
        } catch {}
      }
      return send.call(this, d);
    };
  });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  const pad = await padCtx.newPage();
  watch(host, 'host');
  watch(guest, 'guest');
  watch(pad, 'pad');
  try {
    for (const [page, base, name] of [
      [host, hostBase, 'host'],
      [guest, guestBase, 'guest'],
    ]) {
      await page.goto(base + '/');
      await page.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true, games: 2 })));
      await page.goto(base + '/');
      await page.waitForFunction(() => window.kaleido && window.flow && (document.querySelector('.boot.done') || !document.querySelector('.boot')), null, { timeout: 60000 });
    }
    await host.bringToFront();
    await host.waitForFunction(() => window.kaleido.link.online && window.kaleido.link.room, null, { timeout: 15000 });
    const room = await host.evaluate(() => window.kaleido.link.room);
    await guest.evaluate((r) => window.flow.joinRoom(r), room);
    await guest.waitForFunction(() => window.kaleido.link.role === 'guest' && window.kaleido.link.online, null, { timeout: 15000 });
    await host.waitForFunction(() => window.kaleido.link.guests.length > 0, null, { timeout: 15000 });

    // the guest's phone, opened from the guest's QR link (through the guest's proxy)
    const padUrl = await guest.evaluate(() => window.kaleido.link.joinUrl);
    check('the guest\'s QR link carries the guest\'s id (&via=)', /[?&]via=[a-z0-9]{6,}/.test(padUrl) && padUrl.startsWith(guestBase), padUrl);
    await pad.goto(padUrl + '&auto');
    const joined = await host.waitForFunction(() => window.kaleido.input.activeSeats.some((s) => !s.local), null, { timeout: 20000 }).then(() => true).catch(() => false);
    check('the guest\'s phone was seated on the host', joined);
    if (!joined) throw new Error('phone did not join');
    await sleep(1500);
    const roster = await guest.evaluate(() => {
      const gid = window.kaleido.link.guestId();
      const r = window.kaleido.link.roster;
      return { gid, pads: r ? r.pads.map((p) => ({ via: p.via, slot: p.slot })) : null };
    });
    check('the roster the host sends the guest says whose phone it is (via) and its seat (slot)', !!roster.pads?.some((p) => p.via === roster.gid && p.slot === 0), JSON.stringify(roster));

    // ---- recording, host side
    await host.evaluate(() => {
      const k = window.kaleido;
      const tmp = { x: 0, y: 0, z: 0 };
      window.__ev = [];
      window.__hostLog = [];
      window.__hostBig = [];
      window.__swingRx = [];
      window.__swingEv = [];
      window.__hits = [];
      let prev = null;
      const oe = k.onMatchEvent;
      k.onMatchEvent = (e) => {
        if (k.attract) return oe(e);
        window.__ev.push(e.type + (e.type === 'state' ? ':' + e.state : ''));
        if (e.type === 'hit' && e.p.human) window.__hits.push({ hit: 1, at: Date.now(), dtMs: e.dtMs, tau: e.tau, perfect: e.perfect, smash: e.kind === 'smash' });
        if (e.type === 'whiff' && e.p.human) window.__hits.push({ hit: 0, at: Date.now(), why: e.why, tau: e.tau, dtMs: e.dtMs, mt: k.match.t, plan: e.p.plan ? e.p.plan.t : null, smash: !!k.smashCue });
        oe(e);
      };
      window.__hgaps = [];
      window.__hmeasure = false;
      window.__hpose = { pos: 0, dir: 0, n: 0 };
      let hprev = null;
      let hlast = performance.now();
      const of = k.onFrame;
      k.onFrame = (dt) => {
        const hnow = performance.now();
        if (window.__hmeasure) window.__hgaps.push(hnow - hlast);
        hlast = hnow;
        const m = k.match;
        if (m && !k.attract && window.__hmeasure && k.livePoses) {
          const cur = k.livePoses.map((q) => [q.x, q.z, q.racketDir.x, q.racketDir.y, q.racketDir.z]);
          if (hprev && hprev.length === cur.length)
            cur.forEach((c, i) => {
              const d = Math.hypot(c[0] - hprev[i][0], c[1] - hprev[i][1]);
              if (d < 1.5) window.__hpose.pos = Math.max(window.__hpose.pos, d);
              const dot = Math.max(-1, Math.min(1, c[2] * hprev[i][2] + c[3] * hprev[i][3] + c[4] * hprev[i][4]));
              window.__hpose.dir = Math.max(window.__hpose.dir, Math.acos(dot));
            });
          hprev = cur;
        }
        if (m && !k.attract) {
          m.ballView(m.t, tmp);
          window.__hostLog.push({ t: m.t, x: tmp.x, y: tmp.y, z: tmp.z, h: m.ball.holder ? 1 : 0, s0: m.ball.seg.t0, s: `${m.state}|${m.score.points}|${m.score.games}|${m.score.server}|${m.server.id}|${m.rally}|${m.second ? 1 : 0}|${m.score.winner}` });
          const hold = !!m.ball.holder;
          if (prev && !hold && !prev.h && m.state !== 'intro') {
            const s = Math.hypot(tmp.x - prev.x, tmp.y - prev.y, tmp.z - prev.z);
            if (s > 1.4) window.__hostBig.push({ t: m.t, s });
          }
          prev = { x: tmp.x, y: tmp.y, z: tmp.z, h: hold };
        }
        of(dt);
      };
      const pm = k.input.padMsg.bind(k.input);
      k.input.padMsg = (pid, rt, m) => {
        if (m.type === 'swing') window.__swingRx.push({ seq: m.seq, at: Date.now(), rt, age: m.age, lat: m.lat, off: k.link.serverOffset });
        pm(pid, rt, m);
      };
      const os = k.input.onSwing;
      k.input.onSwing = (e) => {
        window.__swingEv.push({ at: Date.now(), age: e.age * 1000, power: e.power });
        os(e);
      };
    });
    // ---- recording, guest side
    await guest.evaluate(() => {
      const k = window.kaleido;
      const tmp = { x: 0, y: 0, z: 0 };
      window.__ev = [];
      window.__evAt = [];
      window.__echo = [];
      window.__gaps = [];
      window.__gapAt = [];
      window.__measure = false;
      window.__gBig = [];
      window.__gState = [];
      window.__gpose = { pos: 0, dir: 0, n: 0 };
      let gprev = null;
      const trail = [];
      let last = performance.now();
      let prev = null;
      const oe = k.onMatchEvent;
      k.onMatchEvent = (e) => {
        // (this TV's own showcase match, before the host's starts, is not the stream)
        if (!k.guest) return oe(e);
        window.__ev.push(e.type + (e.type === 'state' ? ':' + e.state : ''));
        window.__evAt.push([e.type, Date.now(), e.type === 'hit' && e.p.human ? 1 : 0]);
        oe(e);
      };
      const of = k.onFrame;
      k.onFrame = (dt) => {
        of(dt);
        const now = performance.now();
        if (window.__measure) (window.__gaps.push(now - last), window.__gapAt.push(Date.now()));
        last = now;
        const m = k.match;
        if (!k.guest || !m) return;
        if (window.__measure) {
          const cur = k.guest.poses.map((q) => [q.x, q.z, q.racketDir.x, q.racketDir.y, q.racketDir.z]);
          if (gprev && gprev.length === cur.length)
            cur.forEach((c, i) => {
              const d = Math.hypot(c[0] - gprev[i][0], c[1] - gprev[i][1]);
              if (d < 1.5) window.__gpose.pos = Math.max(window.__gpose.pos, d);
              const dot = Math.max(-1, Math.min(1, c[2] * gprev[i][2] + c[3] * gprev[i][3] + c[4] * gprev[i][4]));
              window.__gpose.dir = Math.max(window.__gpose.dir, Math.acos(dot));
            });
          gprev = cur;
        }
        m.ballView(m.t, tmp);
        const hold = !!m.ball.holder;
        if (prev && !hold && !prev.h && m.state !== 'intro') {
          const s = Math.hypot(tmp.x - prev.x, tmp.y - prev.y, tmp.z - prev.z);
          // (a step no ball could make in the sim time the frame covered — 130 m/s: a slow frame is a long step in a long time)
          if (s > 1.4 && s / Math.max(1e-3, k.guest.dt) > 130) window.__gBig.push({ t: m.t, s, at: Date.now(), dt: k.guest.dt, trail: trail.slice(), now: `${m.t.toFixed(3)} ${m.state} ${tmp.x.toFixed(2)},${tmp.y.toFixed(2)},${tmp.z.toFixed(2)} dt${k.guest.dt.toFixed(4)}` });
        }
        prev = { x: tmp.x, y: tmp.y, z: tmp.z, h: hold };
        trail.push(`${m.t.toFixed(3)} ${m.state} ${hold ? 'H' : '-'} ${tmp.x.toFixed(2)},${tmp.y.toFixed(2)},${tmp.z.toFixed(2)} dt${k.guest.dt.toFixed(4)}`);
        if (trail.length > 6) trail.shift();
      };
      const om = k.link.onMessage;
      k.link.onMessage = (m) => {
        if (m.type === 'pad-echo' && m.msg.type === 'swing') window.__echo.push({ seq: m.msg.seq, at: Date.now() });
        om(m);
      };
    });

    // ---- the match: the guest's phone is team 1's player, against the CPU
    const started = await host.evaluate(() => {
      const f = window.flow;
      const k = window.kaleido;
      f.mode = 'quick';
      const cfg = f.buildConfig();
      const seat = k.input.activeSeats.find((s) => !s.local);
      const cpu = cfg.players.find((p) => p.ctrl.kind === 'cpu');
      cfg.players = [{ ...cpu, team: 0 }, k.humanSpec(seat.slot, 1)];
      cfg.teamNames = ['CPU', seat.name];
      f.teams = [{ name: 'CPU', color: '#6c6a84' }, { name: seat.name, color: seat.color }];
      cfg.firstServer = 1;
      f.beginMatch('plaza', false, cfg);
      return { slot: seat.slot };
    });
    const guestUp = await guest.waitForFunction(() => window.kaleido.guest && window.kaleido.guest.ready, null, { timeout: 20000 }).then(() => true).catch(() => false);
    check('the guest built the match and is receiving snapshots', guestUp);
    if (!guestUp) throw new Error('no stream');

    // ---- own end
    const cam = await guest.evaluate(() => {
      const k = window.kaleido;
      return { side: k.rig.side, team: k.match.players.filter((p) => p.human).map((p) => p.team), z: null };
    });
    await sleep(6000);
    const camPos = await guest.evaluate(() => window.kaleido.rig.cam.position.z);
    check('the guest looks from its phone\'s end (team 1: the far end, camera behind z < 0)', cam.side === 1 && cam.team[0] === 1 && camPos < -10, `rig.side ${cam.side}, human team ${cam.team}, camera z ${camPos.toFixed(1)}`);

    // ---- the phone: toss, serve, meet every ball (peak of the swing on the ball's schedule)
    await host.exposeFunction('__swingAt', (at) => {
      pad.evaluate((a) => window.__phone.tennis({ at: a }), at).catch(() => {});
    });
    await host.exposeFunction('__tap', () => {
      pad
        .evaluate(() => document.querySelector('.toss').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true })))
        .catch(() => {});
    });
    await host.evaluate(() => {
      const k = window.kaleido;
      let busyUntil = 0;
      let stage = '';
      let lastPlan = null;
      window.__swings = 0;
      // (a smash chance runs the last second before contact in slow motion: sim seconds to contact -> real ms)
      const smooth = (t) => t * t * (3 - 2 * t);
      const realMs = (tl) => {
        if (!k.smashCue) return tl * 1000;
        let ms = 0;
        for (let t = tl; t > 0; t -= 0.01) ms += 10 / (0.36 + 0.64 * smooth(Math.max(0, Math.min(1, (t - 0.3) / 0.95))));
        return ms;
      };
      setInterval(() => {
        const m = k.match;
        if (!m || k.attract || k.guest) return;
        const now = Date.now();
        if (now < busyUntil) return;
        const me = m.players.find((p) => p.human);
        if (!me) return;
        if (m.state === 'serve' && m.server.human && m.t - m.stateT0 > 0.7) {
          if (stage !== 'toss') {
            stage = 'toss';
            window.__tap();
            busyUntil = now + 150;
          }
        } else if (m.state === 'toss' && m.server.human) {
          if (stage !== 'serve') {
            stage = 'serve';
            const at = now + (m.server.tossT + 0.78 - m.t) * 1000;
            if (at - now > 300) {
              window.__swingAt(at);
              window.__swings++;
              busyUntil = at + 720;
            }
          }
        } else if (m.state === 'play' && me.plan && me.plan !== lastPlan && !me.swing) {
          // (as late as the phone can manage: the swing needs ~300 ms to be played, and a smash chance's slow motion, which can begin after
          // the plan is made, would stretch a swing planned further ahead into an early one)
          const lead = realMs(me.plan.t - m.t);
          const at = now + lead;
          if (lead <= 480 && lead > 300) {
            lastPlan = me.plan;
            (window.__sched ??= []).push({ now, mt: m.t, plan: me.plan.t, at, smash: !!k.smashCue, state: m.state, rally: m.rally });
            window.__swingAt(at);
            window.__swings++;
            busyUntil = at + 720;
          }
        } else if (m.state !== 'toss') stage = m.state === 'serve' ? stage : '';
      }, 15);
    });

    // ---- run, comparing the guest's ball with the host's as we go
    let cursor = 0;
    const cmp = { n: 0, max: 0, sum: 0, skipped: 0 };
    const compare = async () => {
      const all = await host.evaluate((i) => window.__hostLog.slice(i).map((e) => ({ t: e.t, x: e.x, y: e.y, z: e.z, h: e.h, s0: e.s0 })), cursor);
      // (a person's swing heard between frames resolves on the spot: a flight begins at exactly the last frame's time, and the ball
      // at that instant is double-valued — drawn before the hit, at the racket after it. That frame isn't compared; the last waits for the next)
      const log = all.slice(0, -1);
      for (let i = 0; i < log.length; i++) if (all[i + 1].s0 === all[i].t && all[i].s0 !== all[i].t) log[i].a = 1;
      if (!log.length) return;
      const r = await guest.evaluate((log) => {
        const g = window.kaleido.guest;
        const out = { n: 0, max: 0, sum: 0, skipped: 0, consumed: 0 };
        if (!g) return out;
        const tmp = { x: 0, y: 0, z: 0 };
        for (const e of log) {
          if (e.t > g.tR - 0.1) break;
          out.consumed++;
          if (e.h || e.a) continue;
          if (g.ballAtSimTime(e.t, tmp)) {
            const d = Math.hypot(tmp.x - e.x, tmp.y - e.y, tmp.z - e.z);
            if (d > out.max && d > 0.02) {
              const ring = g.ring.filter((q) => q.serial > 0 && Math.abs(q.t - e.t) < 0.15).sort((a, b) => a.serial - b.serial);
              out.worst = { t: e.t, d, host: [e.x, e.y, e.z], guest: [tmp.x, tmp.y, tmp.z], ring: ring.map((q) => `#${q.serial} t${q.t.toFixed(4)} seg${q.seg.t0.toFixed(4)} v${q.seg.vx.toFixed(2)},${q.seg.vz.toFixed(2)} warp${q.warp.p}:${q.warp.t0.toFixed(4)}-${q.warp.tc.toFixed(4)} st${q.state} ev[${q.events.map((x) => x.type + '@' + x.t.toFixed(4)).join(',')}]`) };
            }
            out.max = Math.max(out.max, d);
            out.sum += d;
            out.n++;
          } else out.skipped++;
        }
        return out;
      }, log);
      cursor += r.consumed;
      cmp.n += r.n;
      cmp.sum += r.sum;
      if (r.worst && r.max > cmp.max) cmp.worst = r.worst;
      cmp.max = Math.max(cmp.max, r.max);
      cmp.skipped += r.skipped;
    };
    // (the rally proper: start the clocks once the first point is under way)
    await host.waitForFunction(() => window.kaleido.match?.state === 'play' || (window.__swings ?? 0) > 0, null, { timeout: 30000 }).catch(() => {});
    await guest.evaluate(() => {
      window.__gaps.length = 0;
      window.__gapAt.length = 0;
      window.__measure = true;
      window.kaleido.guest.resetDelay();
    });
    await host.evaluate(() => ((window.__hgaps.length = 0), (window.__hmeasure = true)));
    const buf = [];
    const t0 = Date.now();
    let shiftDone = false;
    while (Date.now() - t0 < SECONDS * 1000) {
      await sleep(500);
      await compare();
      buf.push(await guest.evaluate(() => window.kaleido.guest.stats.buffer));
    }
    await guest.evaluate(() => (window.__measure = false));
    await host.evaluate(() => (window.__hmeasure = false));
    // a Kaleido shift on the host, from a spot in the court: the guest shatters from that spot as it sees it
    if (P.id === 'a') {
      const at = { x: 3.2, y: 1, z: 5 };
      await host.evaluate((at) => {
        const f = window.flow;
        f.kaleidoOrder = ['plaza', 'neon'];
        f.kaleidoIdx = 0;
        f.shiftWorld(at);
      }, at);
      const seen = await guest
        .waitForFunction(() => window.kaleido.stage.next, null, { timeout: 8000, polling: 20 })
        .then(async () =>
          guest.evaluate((at) => {
            const k = window.kaleido;
            const p = k.rig.project(at);
            const o = k.stage.tr.origin;
            return { world: k.stage.next?.def.id, ox: o.x, oy: 1 - o.y, px: p.x, py: p.y };
          }, at),
        )
        .catch(() => null);
      const hostP = await host.evaluate((at) => {
        const p = window.kaleido.rig.project(at);
        return { x: p.x, y: p.y };
      }, at);
      shiftDone = true;
      // (the guest's camera is at the other end: the same spot is on the other side of its screen)
      check(
        'the Kaleido shift shatters from the same spot in the court, as the guest\'s own camera sees it',
        !!seen && Math.abs(seen.ox - seen.px) < 0.03 && Math.abs(seen.oy - seen.py) < 0.03 && Math.hypot(seen.ox - hostP.x, seen.oy - hostP.y) > 0.05,
        seen ? `guest origin (${seen.ox.toFixed(2)}, ${seen.oy.toFixed(2)}) = its projection (${seen.px.toFixed(2)}, ${seen.py.toFixed(2)}); the host's view had (${hostP.x.toFixed(2)}, ${hostP.y.toFixed(2)})` : 'no world change seen',
      );
    }
    await sleep(2500);
    await compare();
    // a quiet moment between points before the counts are compared
    for (let i = 0; i < 40; i++) {
      const s = await host.evaluate(() => window.kaleido.match?.state);
      if (s === 'over' || s === 'serve' || s === 'dead' || s === 'reset') break;
      await sleep(250);
    }
    await sleep(2000);
    await compare();

    // ---- results
    const H = await host.evaluate(() => ({ pose: window.__hpose, gaps: window.__hgaps, ev: window.__ev, hits: window.__hits, rx: window.__swingRx, sev: window.__swingEv, big: window.__hostBig, swings: window.__swings, world: window.kaleido.stage.current.def.id, sched: window.__sched }));
    await sleep(1200);
    const hostLate = await host.evaluate(() => window.__ev);
    const G = await guest.evaluate(() => {
      const k = window.kaleido;
      return { pose: window.__gpose, ev: window.__ev, evAt: window.__evAt, stats: k.guest.stats, gaps: window.__gaps, gapAt: window.__gapAt, big: window.__gBig, echo: window.__echo, world: k.stage.current.def.id };
    });
    const S = await pad.evaluate(() => window.__sent);
    await host.screenshot({ path: `${OUT}/lag-${P.id}-host.png` });
    await guest.screenshot({ path: `${OUT}/lag-${P.id}-guest.png` });

    const st = G.stats;
    R.stats = st;
    const hostHits = H.ev.filter((e) => e === 'hit').length;
    check('a rally happened (at least 6 hits)', hostHits >= 6, `${hostHits} hits, ${H.swings} phone swings`);

    // the delay the guest measured on the stream against the delay the proxies add
    const expect = P.guest.delay + (P.host?.delay ?? 0);
    const spikeSlack = P.guest.spike ? 0.35 * P.guest.spikeMs : 0;
    check('the guest measured the stream\'s one-way delay right (p50 within 12 ms of the proxies\' + ~2 ms)', Math.abs(st.oneWay.p50 - (expect + 2)) <= 12 + spikeSlack, `p50 ${f1(st.oneWay.p50)} ms, expected ~${expect + 2}`);
    const buffers = buf.slice(Math.floor(buf.length / 4));
    R.buffer = { p50: pct(buffers, 0.5), max: Math.max(...buffers), min: Math.min(...buffers) };

    // the frame gaps
    const gaps = G.gaps.slice(5);
    R.gap = { p50: pct(gaps, 0.5), p99: pct(gaps, 0.99), max: Math.max(...gaps), n: gaps.length, over: gaps.filter((g) => g > 18.7).length };
    if (process.env.GAPS) {
      const worst = G.gaps.map((g, i) => [g, G.gapAt[i]]).sort((a, b) => b[0] - a[0]).slice(0, 12);
      console.log('  worst gaps:', worst.map(([g, at]) => `${g.toFixed(1)} ms (nearest event ${G.evAt.map(([t, a]) => [t, a - at]).sort((x, y) => Math.abs(x[1]) - Math.abs(y[1]))[0]?.join('@')})`).join('; '));
    }
    // (the host page, which the network does not touch, sets what this machine's frame noise is)
    const hg = H.gaps.slice(5);
    R.gap.host = pct(hg, 0.99);
    check('the guest\'s frame gaps over the rally: p99 ≤ 18.7 ms (or the host page\'s own p99 + 0.5: no hitches from the network)', R.gap.p99 <= Math.max(18.7, R.gap.host + 0.5), `p50 ${f1(R.gap.p50)}, p99 ${f1(R.gap.p99)}, max ${f1(R.gap.max)} ms over ${R.gap.n} frames (${R.gap.over} over 18.7; the host page\'s own p99 ${f1(R.gap.host)})`);

    // events
    const gEv = G.ev.slice(0, H.ev.length);
    const inOrder = gEv.join() === H.ev.join() && hostLate.join().startsWith(G.ev.join());
    let where = '';
    if (!inOrder) {
      const n = Math.min(hostLate.length, G.ev.length);
      let i = 0;
      while (i < n && hostLate[i] === G.ev[i]) i++;
      where = ` — first difference at #${i}: host [${hostLate.slice(Math.max(0, i - 3), i + 4).join(' ')}] guest [${G.ev.slice(Math.max(0, i - 3), i + 4).join(' ')}]`;
    }
    check('every match event reached the guest, in order', inOrder, inOrder ? `${H.ev.length} events` : `host ${H.ev.length} (later ${hostLate.length}), guest ${G.ev.length}${where}`);

    // the ball
    R.ball = cmp;
    if (cmp.max >= 0.02 && cmp.worst) console.log('  worst ball error:', JSON.stringify(cmp.worst, null, 1));
    check('the guest\'s ball is within 2 cm of the host\'s at the same host time', cmp.n > 300 && cmp.max < 0.02, `max ${(cmp.max * 100).toFixed(3)} cm over ${cmp.n} frames`);
    // (the ball changes line at a hit: it goes from wherever the racket's pull left it onto the shot, and a frame that straddles that moment
    // sees the metre or so — on the host too, in the frames that happen to straddle it. The guest's ball is the host's at every simulation
    // time (above), so a step that isn't at a hit or a bounce is the only kind that could be the network's)
    const stray = G.big.filter((g) => !H.big.some((b) => Math.abs(b.t - g.t) < 0.1) && !G.evAt.some(([t, at]) => ['hit', 'toss', 'bounce', 'net', 'point', 'state', 'let', 'fault'].includes(t) && Math.abs(at - g.at) < 80));
    for (const g of stray) console.log('  stray step', g.s.toFixed(2), 'm; trail:', JSON.stringify(g.trail), '; then', g.now, '; events near:', G.evAt.filter(([, at]) => Math.abs(at - g.at) < 500).map(([t, at]) => `${t}@${at - g.at}`).join(' '), '; host big steps:', JSON.stringify(H.big));
    check('the ball never teleported on the guest except at a hit or a bounce (where the host\'s own ball changes line)', stray.length === 0, `${G.big.length} big steps on the guest, ${H.big.length} on the host${stray.length ? '; unexplained: ' + stray.map((s) => `${s.s.toFixed(2)} m at t ${s.t.toFixed(2)}`).join(', ') : ''}`);

    // the players: no pops (a stall's end must not throw a player or a racket 150 ms ahead in one frame)
    R.pose = { gp: G.pose.pos, hp: H.pose.pos, gd: G.pose.dir, hd: H.pose.dir };
    check('the guest\'s players never pop: the largest step of a player and of a racket in one frame is about the host\'s own', G.pose.pos <= H.pose.pos * 1.5 + 0.05 && G.pose.dir <= H.pose.dir * 1.5 + 0.15, `player ${G.pose.pos.toFixed(3)} m (host ${H.pose.pos.toFixed(3)}), racket ${G.pose.dir.toFixed(2)} rad (host ${H.pose.dir.toFixed(2)})`);

    // the swings
    const rows = [];
    for (const r of H.rx) {
      const idx = H.rx.indexOf(r);
      const ev = H.sev[idx];
      const sent = S[r.seq];
      if (!ev || !sent) continue;
      const netTrue = r.at - sent;
      const credited = ev.age - r.age;
      const echo = G.echo.find((e) => e.seq === r.seq);
      const hitShown = G.evAt.find(([t, at, mine]) => t === 'hit' && mine && at > sent - 50);
      rows.push({ netTrue, credited, err: credited - netTrue, clamped: ev.age >= 249, echo: echo ? echo.at - sent : NaN, shown: hitShown ? hitShown[1] - sent : NaN });
    }
    R.swings = rows;
    const ok = rows.filter((r) => !r.clamped);
    const errs = ok.map((r) => r.err);
    // (the proxy keeps frames in order, so a late one holds up the next: the delay it really adds is a little over the nominal)
    const expNet = P.guest.delay + (P.host?.delay ?? 0);
    const realNet = gp.stats().mean + (hp ? hp.stats().mean : 0);
    const sigma = Math.hypot(P.guest.jitter, P.host?.jitter ?? 0);
    R.net = { n: rows.length, true: mean(rows.map((r) => r.netTrue)), trueSd: sd(rows.map((r) => r.netTrue)), bias: mean(errs), absP90: pct(errs.map(Math.abs), 0.9), clamped: rows.length - ok.length };
    check(
      'the guest phone\'s swings reach the host after the proxies\' delay ± jitter (phone send → host receipt)',
      rows.length >= 4 && Math.abs(R.net.true - (realNet + 3)) <= 12 + spikeSlack * 0.5,
      `${rows.length} swings: ${f1(R.net.true)} ± ${f1(R.net.trueSd)} ms (the proxies added ${f1(realNet)} on average: ${expNet} ± ${f1(sigma)} nominal, frames kept in order)`,
    );
    check(
      'the host credits each swing the network time it really took (lat + transit vs the true one): unbiased, off by about the jitter',
      ok.length >= 4 && Math.abs(R.net.bias) <= 10 + spikeSlack * 0.3 && R.net.absP90 <= 3 * sigma + 8 + (P.guest.spike ? P.guest.spikeMs : 0),
      `bias ${f1(R.net.bias)} ms, 90th |error| ${f1(R.net.absP90)} ms, ${R.net.clamped} of ${rows.length} at the ${250} ms age cap`,
    );
    const hh = H.hits;
    const hitN = hh.filter((x) => x.hit).length;
    // (a whiff while a smash chance's slow motion runs is the test phone's timing, which can't follow the changing speed of time: not counted)
    const whN = hh.filter((x) => !x.hit && !x.smash).length;
    const whSmash = hh.filter((x) => !x.hit && x.smash).length;
    if (process.env.SWINGS) {
      console.log('  swings (true net, credited, error) and the judgments (hit/whiff, tau, dtMs):');
      console.log('   ', rows.map((r) => `${r.netTrue.toFixed(0)}/${r.credited.toFixed(0)}/${r.err.toFixed(0)}`).join('  '));
      console.log('  scheduled:', JSON.stringify(H.sched));
      console.log('  whiffs:', JSON.stringify(hh.filter((x) => !x.hit)));
      console.log('   ', hh.map((x) => (x.hit ? `hit(tau ${x.tau?.toFixed(2)}, ${x.dtMs}ms)` : `WHIFF ${x.why}(tau ${x.tau?.toFixed(2)}, ${x.dtMs}ms)`)).join('  '));
    }
    R.judged = { hits: hitN, whiffs: whN, dt: mean(hh.filter((x) => x.hit && x.dtMs !== undefined).map((x) => Math.abs(x.dtMs))), whyList: hh.filter((x) => !x.hit && !x.smash).map((x) => x.why) };
    // a whiff is the network's when its swing was caught behind a spike: the host was told it was on time (credit error < −60 ms)
    let unexplained = 0;
    if (hh.length === rows.length) hh.forEach((x, i) => { if (!x.hit && !x.smash && !(rows[i].err < -60 || rows[i].clamped)) unexplained++; });
    else unexplained = whN;
    R.judged.unexplained = unexplained;
    check('swings timed on the ball\'s arrival, latency accounted for, are judged hits (not whiffs, but for one a spike made late)', hitN >= 4 && unexplained === 0, `${hitN} hits, ${whN} whiffs${whN ? ' (' + R.judged.whyList.join(',') + ')' : ''}${whSmash ? `, ${whSmash} more in a smash chance's slow motion` : ''}, mean |timing error| ${f1(R.judged.dt)} ms`);
    const echoes = rows.map((r) => r.echo).filter(Number.isFinite);
    const shown = rows.map((r) => r.shown).filter(Number.isFinite);
    R.echo = { n: echoes.length, ms: mean(echoes), shown: mean(shown) };
    check('the guest hears its own phone\'s swing at once (relay echo), well before the stream shows the hit', echoes.length >= 4 && R.echo.ms <= P.guest.delay * 2 + 3 * P.guest.jitter + 20 + spikeSlack && (!shown.length || R.echo.ms < R.echo.shown), `echo ${f1(R.echo.ms)} ms after the swing was sent (n ${echoes.length}); the hit shown ${f1(R.echo.shown)} ms after it`);
    check('no page errors on either TV or the phone', errors.length === 0, errors.length ? '\n' + errors.join('\n') : '');
    void started;
    void shiftDone;
  } catch (e) {
    fail++;
    console.log(`  ✗ profile ${P.id} aborted: ${e.message}`);
    R.error = e.message;
  } finally {
    R.proxy = { guest: gp.stats(), host: hp?.stats() };
    await Promise.all([hostCtx.close(), guestCtx.close(), padCtx.close()]).catch(() => {});
    await gp.close();
    await hp?.close();
  }
  results.push(R);
}

for (const P of PROFILES) await runProfile(P);
await browser.close();
cleanup();

// ---------------------------------------------------------------- the table
const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + '─'.repeat(150));
console.log(`${pad('profile', 30)}${pad('one-way p50/p90/max', 22)}${pad('buffer med/max', 15)}${pad('render lag', 11)}${pad('drop/late/resync/holds', 24)}${pad('frame gap p99/max', 19)}${pad('ball err', 10)}${pad('swing net true', 17)}${pad('credit bias/p90', 17)}${pad('hit/whiff', 10)}echo/shown`);
for (const R of results) {
  if (!R.stats) {
    console.log(`${pad(R.id + ' ' + R.name, 30)}ABORTED ${R.error ?? ''}`);
    continue;
  }
  const s = R.stats;
  console.log(
    pad(`${R.id}  ${R.name}`, 30) +
      pad(`${f1(s.oneWay.p50)}/${f1(s.oneWay.p90)}/${f1(s.oneWay.max)}`, 22) +
      pad(`${f1(R.buffer.p50)}/${f1(R.buffer.max)}`, 15) +
      pad(`${f1(s.renderLag)} ms`, 11) +
      pad(`${s.dropped}/${s.lateEvents}/${s.resyncs}/${s.holds} (${s.heldMs.toFixed(0)} ms)`, 24) +
      pad(`${f1(R.gap.p99)}/${f1(R.gap.max)}`, 19) +
      pad(`${(R.ball.max * 100).toFixed(2)} cm`, 10) +
      pad(`${f1(R.net.true)}±${f1(R.net.trueSd)} (${R.net.n})`, 17) +
      pad(`${f1(R.net.bias)}/${f1(R.net.absP90)}`, 17) +
      pad(`${R.judged.hits}/${R.judged.whiffs}`, 10) +
      `${f1(R.echo.ms)}/${f1(R.echo.shown)} ms`,
  );
}
console.log('─'.repeat(160));
console.log('one-way, buffer, render lag, gaps and echo in ms; swing net true = phone send → host receipt (mean ± sd, n); credit = what the host credits vs the truth');
console.log(fail ? `\n${fail} checks FAILED` : '\nAll online-lag checks passed.');
process.exit(fail ? 1 : 0);
