// What starting a song costs the main thread: the play() call, every sequencer tick and every
// Karplus-Strong string built in the first seconds (a frame that lands on one is that much
// longer), and how many steps were scheduled after their time had passed (they play late,
// clamped to "now": a flam). STALL=ms blocks the page once, a second in, like a GC or a compile.
//   node scripts/perf/perf-music.mjs [songs] [seconds]
import { launchChrome } from '../lib/chrome.mjs';
const BASE = process.env.BASE || 'http://localhost:3000';
const songs = (process.argv[2] || 'ink,plaza,paper,clay').split(',');
const secs = +(process.argv[3] || 4);
const stall = +(process.env.STALL || 0);
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
const tv = await ctx.newPage();
await tv.goto(BASE + '/');
await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
await tv.goto(BASE + '/');
await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 });
await tv.waitForTimeout(800);
await tv.mouse.click(640, 370);
await tv.waitForTimeout(1500);
for (const song of songs) {
  const r = await tv.evaluate(
    ([song, secs, stall]) =>
      new Promise((done) => {
        const a = window.flow.audio;
        const m = a.music;
        const e = a.engine;
        m.stop(0);
        setTimeout(() => {
          e.ksCache.clear();
          const ticks = [];
          const builds = [];
          let late = 0, steps = 0, worst = 0;
          const tick = m.tick;
          m.tick = function () {
            const t0 = performance.now();
            tick.call(this);
            ticks.push(performance.now() - t0);
          };
          const sched = m.schedule;
          m.schedule = function (step, t, ...rest) {
            // (a call with an engine of its own is a dry run, not a scheduled step)
            if (!rest.length) {
              steps++;
              const lead = t - e.now;
              if (lead < 0) {
                late++;
                worst = Math.min(worst, lead);
              }
            }
            return sched.call(this, step, t, ...rest);
          };
          const orig = e.ks;
          e.ks = function (...args) {
            const before = e.ksCache.size;
            const t0 = performance.now();
            const b = orig.apply(this, args);
            const dt = performance.now() - t0;
            if (dt > 0.05) builds.push(dt);
            return b;
          };
          const t0 = performance.now();
          a.playSong(song);
          const play = performance.now() - t0;
          if (stall) setTimeout(() => { const s = performance.now(); while (performance.now() - s < stall); }, 1000);
          setTimeout(() => {
            m.tick = tick;
            m.schedule = sched;
            e.ks = orig;
            const tk = ticks.slice().sort((x, y) => x - y);
            done({
              song,
              playMs: +play.toFixed(2),
              ticks: ticks.length,
              tickMax: +tk[tk.length - 1].toFixed(1),
              tickSum: +ticks.reduce((x, y) => x + y, 0).toFixed(1),
              ksBuilds: builds.length,
              ksMs: +builds.reduce((x, y) => x + y, 0).toFixed(1),
              ksMax: +Math.max(0, ...builds).toFixed(1),
              steps,
              lateSteps: late,
              worstLateMs: +(worst * 1000).toFixed(0),
            });
          }, secs * 1000);
        }, 300);
      }),
    [song, secs, stall],
  );
  console.log(JSON.stringify(r));
}
await browser.close();
