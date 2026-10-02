// Renders every song offline (the engine on an OfflineAudioContext, its steps scheduled by
// hand, Math.random seeded — Karplus-Strong strings per pitch) and writes the samples to
// <outDir>/<song>.f32, so two builds can be compared with `--compare <dirA> <dirB>`.
//   node scripts/tools/audio-offline-check.mjs <outDir> [seconds] [songs]
//   node scripts/tools/audio-offline-check.mjs --compare <dirA> <dirB>
import { launchChrome } from '../lib/chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

if (process.argv[2] === '--compare') {
  const [a, b] = process.argv.slice(3);
  let bad = 0;
  for (const f of fs.readdirSync(a).filter((f) => f.endsWith('.f32'))) {
    const x = new Float32Array(fs.readFileSync(path.join(a, f)).buffer.slice(0));
    const y = new Float32Array(fs.readFileSync(path.join(b, f)).buffer.slice(0));
    let max = 0, e = 0, ex = 0, ey = 0;
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(x[i] - y[i]);
      if (d > max) max = d;
      e += d * d;
      ex += x[i] * x[i];
      ey += y[i] * y[i];
    }
    const snr = ex > 0 ? 10 * Math.log10(ex / Math.max(e, 1e-30)) : Infinity;
    console.log(`${f.padEnd(12)} samples ${x.length}/${y.length} max|diff| ${max.toExponential(2)} rms ${Math.sqrt(ex / x.length).toFixed(4)} vs ${Math.sqrt(ey / y.length).toFixed(4)} SNR ${snr.toFixed(1)} dB`);
    if (x.length !== y.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const BASE = process.env.BASE || 'http://localhost:3000';
const out = process.argv[2];
const secs = +(process.argv[3] || 8);
const songsArg = process.argv[4];
fs.mkdirSync(out, { recursive: true });
const browser = await launchChrome(['--autoplay-policy=no-user-gesture-required']);
const page = await (await browser.newContext()).newPage();
await page.goto(BASE + '/');
const ids = await page.evaluate(async ([secs, songsArg]) => {
  const { AudioEngine } = await import('/src/tv/audio/engine.ts');
  const { Music } = await import('/src/tv/audio/music.ts');
  const { SONGS } = await import('/src/tv/audio/songs.ts');
  const SR = 44100;
  const mul = (a) => () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const realRandom = Math.random;
  const ids = songsArg ? songsArg.split(',') : Object.keys(SONGS);
  window.__pcm = {};
  for (const id of ids) {
    Math.random = mul(1234);
    const RealAC = window.AudioContext;
    window.AudioContext = function () {
      return new OfflineAudioContext(2, SR * secs, SR);
    };
    const e = new AudioEngine();
    window.AudioContext = RealAC;
    // (each string is seeded by its pitch: the noise burst it starts from does not depend on
    // the order the strings were built in)
    const ks = e.ks;
    e.ks = function (midi, bright, dur) {
      const keep = Math.random;
      Math.random = mul(midi * 131 + Math.round(bright * 100));
      try {
        return ks.call(this, midi, bright, dur);
      } finally {
        Math.random = keep;
      }
    };
    const m = new Music(e);
    const song = SONGS[id];
    m.intensity = 3;
    // (the melody tables are built by play(); then step by hand instead of on the timer)
    m.play(song, 0.01);
    clearInterval(m.timer);
    m.timer = 0;
    const sd = 60 / song.bpm / 4;
    const steps = Math.floor((secs - 1.5) / sd);
    for (let s = 0; s < steps; s++) {
      const sw = song.swing && s % 2 === 1 ? song.swing * sd : 0;
      m.schedule(s, 0.08 + s * sd + sw);
    }
    // a few rally hits and jingles on top
    for (let i = 1; i <= 4; i++) {
      m.step = 40 * i;
      m.hitNote(i, 0.7, 0);
    }
    const buf = await e.ctx.startRendering();
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    const inter = new Float32Array(l.length * 2);
    for (let i = 0; i < l.length; i++) {
      inter[2 * i] = l[i];
      inter[2 * i + 1] = r[i];
    }
    let bin = '';
    const u8 = new Uint8Array(inter.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    window.__pcm[id] = btoa(bin);
    Math.random = realRandom;
  }
  return ids;
}, [secs, songsArg]);
for (const id of ids) {
  const b64 = await page.evaluate((id) => window.__pcm[id], id);
  fs.writeFileSync(path.join(out, id + '.f32'), Buffer.from(b64, 'base64'));
  console.log('wrote', id);
}
await browser.close();
