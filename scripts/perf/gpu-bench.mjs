// GPU time per world at different render scales / MSAA / effect tiers (timer queries).
//   node scripts/perf/gpu-bench.mjs [worlds] [configs]
//   configs: JSON list of { pr, msaa, fx?, eval?, name? } — fx is an effects tier (see
//   render/quality.ts); eval is JS run with (k = the app, w = the world) before measuring
//   PASSES=1  also prints where the time goes (shadow map, scene, each post pass; the
//             per-draw timers inflate small passes on ANGLE/Metal, so compare, don't add up)
//   ROUNDS=n  measures the configs in turn n times (a shared machine's noise lands on all)
//   LOW=1     prints p10/p50/p90: contention only ever adds time, so p10 is the steadier figure
//   AB=<url>  also measures another build (e.g. the base commit on another port), taking
//             turns with this one, so both see the same load
import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3000';
const AB = process.env.AB || null;
const PASSES = !!process.env.PASSES;
const SECS = +(process.env.SECS || 2.5);
const ROUNDS = +(process.env.ROUNDS || 1);
const LOW = !!process.env.LOW;
const worlds = (process.argv[2] || 'plaza,ink,neon,pixel,paper,clay,water,cosmic').split(',');
const configs = JSON.parse(process.argv[3] || '[{"pr":1.5,"msaa":4},{"pr":1.25,"msaa":4},{"pr":1.0,"msaa":4},{"pr":1.5,"msaa":0}]');
const browser = await launchChrome(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 740 }, deviceScaleFactor: 2 });
// a worktree's node_modules may be a symlink the dev server won't serve fonts from
await ctx.route(/\/@fs\/.*\/@fontsource\/.*\/files\/.*\.woff2?$/, (route) => {
  const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/@fs/, ''));
  if (fs.existsSync(file)) route.fulfill({ path: file });
  else route.continue();
});
const errors = [];

async function open(base) {
  const tv = await ctx.newPage();
  tv.on('pageerror', (e) => errors.push(e.message));
  await tv.goto(base + '/');
  await tv.evaluate(() => localStorage.setItem('kaleido.settings', JSON.stringify({ seenTutorial: true })));
  await tv.goto(base + '/');
  await tv.waitForFunction(() => document.querySelector('.boot.done') || !document.querySelector('.boot'), null, { timeout: 30000 }).catch(() => {});
  await tv.waitForTimeout(1500);
  // freeze the adaptive quality (it would change the level under us) and install
  // a GPU timer around each frame — or, with PASSES, around each draw call
  await tv.evaluate((passes) => {
    const k = window.kaleido;
    k.quality.update = () => null;
    k.quality.beginFrame = () => {};
    k.quality.endFrame = () => {};
    const gl = k.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pending = [];
    window.__gpu = [];
    window.__pass = {};
    let frame = null;
    const flush = () => {
      while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
        const p = pending.shift();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
          if (p.label === null) window.__gpu.push(ms);
          else {
            const f = (window.__pass[p.frame] ??= {});
            f[p.label] = (f[p.label] || 0) + ms;
          }
        }
        gl.deleteQuery(p.q);
      }
    };
    let open = null;
    const begin = (label) => {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      open = { q, label, frame };
    };
    const end = () => {
      if (!open) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(open);
      open = null;
    };
    let n = 0;
    const orig = k.frame.bind(k);
    let run;
    if (!passes) {
      run = (now) => {
        begin(null);
        orig(now);
        end();
        flush();
      };
    } else {
      // per draw call: label scenes 'scene', passes by their material's name
      const r = k.renderer;
      const rr = r.render.bind(r);
      let label = null;
      r.render = (obj, cam) => {
        const l = obj.isScene ? 'scene' : obj.material?.name || 'pass';
        label = l;
        begin(l);
        rr(obj, cam);
        end();
        label = null;
      };
      const sm = r.shadowMap.render;
      r.shadowMap.render = function (...a) {
        const outer = label;
        end();
        begin('shadow');
        sm.apply(this, a);
        end();
        if (outer) begin(outer);
      };
      run = (now) => {
        frame = n++;
        orig(now);
        flush();
      };
    }
    // `__idle` parks this page while the other build is being measured
    k.frame = (now) => (window.__idle ? undefined : run(now));
  }, PASSES);
  return tv;
}

const pages = [{ name: 'this', tv: await open(BASE) }];
if (AB) pages.push({ name: 'base', tv: await open(AB) });
const idle = (active) => Promise.all(pages.map((p) => p.tv.evaluate((on) => (window.__idle = on), p !== active)));

const nameWorldPasses = (tv) =>
  tv.evaluate(() => {
    const k = window.kaleido;
    k.stage.forEachWorld((w) => {
      for (const key of Object.keys(w)) {
        const v = w[key];
        if (v && v.mat && v.mat.isShaderMaterial && !v.mat.name) v.mat.name = key;
        if (v && typeof v === 'object' && !v.isObject3D)
          for (const k2 of Object.keys(v)) {
            const p = v[k2];
            if (p && p.mat && p.mat.isShaderMaterial && !p.mat.name) p.mat.name = `${key}.${k2}`;
          }
      }
    });
  });
const tag = (c) => c.name ?? `pr${c.pr}/msaa${c.msaa}${c.fx !== undefined ? '/fx' + c.fx : ''}`;
console.log('world        ' + configs.map((c) => tag(c).padStart(18)).join(''));
const breakdown = [];
const med = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
};
for (const w of worlds) {
  for (const p of pages) {
    await p.tv.evaluate((w) => {
      window.kaleido.startAttract(w);
      // the title screen's showcase would move on to another world mid-measurement
      if (window.flow) window.flow.attractShiftAt = 1e12;
    }, w);
    await p.tv.waitForTimeout(1200);
    await nameWorldPasses(p.tv);
  }
  // the machine is shared: measure the configs (and builds) in turn, ROUNDS times,
  // so a busy moment lands on all of them rather than skewing one
  const got = pages.map(() => configs.map(() => ({ gpu: [], frames: [] })));
  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < configs.length; i++) {
      for (let pi = 0; pi < pages.length; pi++) {
        const { tv } = pages[pi];
        await idle(pages[pi]);
        await tv.evaluate((c) => {
          const k = window.kaleido;
          if (c.fx !== undefined) k.setEffects?.(c.fx);
          if (c.eval) new Function('k', 'w', c.eval)(k, k.stage.current);
          k.pr = c.pr;
          k.stage.msaa = c.msaa;
          k.resize();
        }, configs[i]);
        await tv.waitForTimeout(500);
        await tv.evaluate(() => {
          window.__gpu.length = 0;
          window.__pass = {};
        });
        await tv.waitForTimeout((SECS * 1000) / ROUNDS);
        const r = await tv.evaluate(() => ({ gpu: window.__gpu.slice(), frames: Object.values(window.__pass) }));
        got[pi][i].gpu.push(...r.gpu);
        got[pi][i].frames.push(...r.frames);
      }
    }
  }
  pages.forEach((p, pi) => {
    let line = (pages.length > 1 ? `${w}/${p.name}` : w).padEnd(13);
    configs.forEach((c, i) => {
      const g0 = got[pi][i];
      if (!PASSES) {
        const g = g0.gpu.slice().sort((a, b) => a - b);
        const q = (x) => g[Math.min(g.length - 1, Math.floor(x * g.length))] ?? NaN;
        line += (LOW ? `${q(0.1).toFixed(1)}/${q(0.5).toFixed(1)}/${q(0.9).toFixed(1)}` : `${q(0.5).toFixed(1)}/${q(0.9).toFixed(1)}ms`).padStart(18);
      } else {
        const frames = g0.frames;
        const labels = [...new Set(frames.flatMap((f) => Object.keys(f)))];
        const totals = frames.map((f) => Object.values(f).reduce((a, b) => a + b, 0));
        line += `${med(totals).toFixed(2)}ms`.padStart(18);
        breakdown.push(`${w}/${p.name} ${tag(c)}: total ${med(totals).toFixed(2)} | ` + labels.map((l) => `${l} ${med(frames.map((f) => f[l] || 0)).toFixed(2)}`).join(', '));
      }
    });
    console.log(line);
  });
}
if (PASSES) console.log('\n' + breakdown.join('\n'));
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
