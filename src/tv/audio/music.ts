// A tiny tracker: songs are written as scale degrees, and the sequencer
// schedules them ahead of time on the audio clock. Layers fade in and out
// with "intensity", so a rally literally builds the arrangement up.

import type { AudioEngine, InstName, DrumName } from './engine';

export interface Track {
  kind: 'drum' | 'bass' | 'chord' | 'arp' | 'melody' | 'drone';
  inst: InstName | DrumName;
  /** plays when intensity >= layer */
  layer: number;
  vol: number;
  oct?: number;
  /** 16 chars per bar. drums: x=hit o=soft. bass: r=root f=fifth o=octave t=third. chord: x=stab */
  pat?: string;
  /** melody, one string per bar: tokens "deg:len" with ' (octave up) or , (down); "-" = rest */
  mel?: string[];
  arp?: number[];
  every?: number;
  dur?: number;
  rev?: number;
  dly?: number;
  pan?: number;
}

export interface Song {
  id: string;
  bpm: number;
  root: number;
  scale: number[];
  chords: number[];
  swing?: number;
  tracks: Track[];
  hit: { inst: InstName; oct: number; vel: number; dly?: number };
}

interface MelNote {
  step: number;
  deg: number;
  oct: number;
  len: number;
}

export class Music {
  song: Song | null = null;
  intensity = 3;
  private target = 3;
  private step = 0;
  private nextT = 0;
  private timer = 0;
  private bus: GainNode;
  private mels = new Map<Track, MelNote[][]>();
  private hitCount = 0;
  volume = 1;

  constructor(private e: AudioEngine) {
    this.bus = e.ctx.createGain();
    this.bus.connect(e.music);
  }

  deg(d: number, oct = 0) {
    const s = this.song!;
    const n = s.scale.length;
    const i = d - 1;
    const o = Math.floor(i / n);
    const k = ((i % n) + n) % n;
    return s.root + 12 * (oct + o) + s.scale[k];
  }

  play(song: Song, fade = 1.2) {
    if (this.song?.id === song.id && this.timer) return;
    const e = this.e;
    const t = e.now;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    if (this.song && this.timer) {
      // quick crossfade: drop old, start new
      this.bus.gain.linearRampToValueAtTime(0.0001, t + 0.25);
      const old = this.bus;
      setTimeout(() => old.disconnect(), 600);
      this.bus = e.ctx.createGain();
      this.bus.connect(e.music);
    }
    this.bus.gain.setValueAtTime(0.0001, t + 0.01);
    this.bus.gain.linearRampToValueAtTime(this.volume, t + fade);
    this.song = song;
    this.mels.clear();
    for (const tr of song.tracks) if (tr.mel) this.mels.set(tr, tr.mel.map((b) => parseBar(b)));
    this.step = 0;
    this.nextT = e.now + 0.08;
    this.hitCount = 0;
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), 25);
  }

  stop(fade = 0.8) {
    const t = this.e.now;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(0.0001, t + fade);
    window.setTimeout(() => {
      clearInterval(this.timer);
      this.timer = 0;
      this.song = null;
    }, fade * 1000 + 50);
  }

  setIntensity(n: number) {
    this.target = n;
  }

  setVolume(v: number) {
    this.volume = v;
    const t = this.e.now;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setTargetAtTime(v, t, 0.1);
  }

  private stepDur() {
    return 60 / this.song!.bpm / 4;
  }

  private tick() {
    const s = this.song;
    if (!s || !this.e.running) return;
    const horizon = this.e.now + 0.2;
    if (this.nextT < this.e.now - 0.25) this.nextT = this.e.now + 0.02; // resync after a stall
    while (this.nextT < horizon) {
      // intensity moves one layer per bar boundary for musical transitions
      if (this.step % 16 === 0 && this.intensity !== this.target) this.intensity += Math.sign(this.target - this.intensity);
      const sw = s.swing && this.step % 2 === 1 ? s.swing * this.stepDur() : 0;
      this.schedule(this.step, this.nextT + sw);
      this.step++;
      this.nextT += this.stepDur();
    }
  }

  private schedule(step: number, t: number) {
    const s = this.song!;
    const e = this.e;
    const bars = s.chords.length;
    const bar = Math.floor(step / 16) % bars;
    const st = step % 16;
    const root = s.chords[bar];
    const sd = this.stepDur();
    for (const tr of s.tracks) {
      if (this.intensity < tr.layer) continue;
      const opts = { bus: this.bus, rev: tr.rev ?? 0.2, dly: tr.dly ?? 0, pan: tr.pan ?? 0 };
      const ch = tr.pat ? tr.pat[st] : '.';
      switch (tr.kind) {
        case 'drum':
          if (ch === 'x' || ch === 'o') e.drum(tr.inst as DrumName, t, tr.vol * (ch === 'o' ? 0.45 : 1), opts);
          break;
        case 'bass': {
          if (ch === '.' || ch === undefined) break;
          const off = ch === 'f' ? 4 : ch === 't' ? 2 : 0;
          const oct = (tr.oct ?? -1) + (ch === 'o' ? 1 : 0);
          e.note(tr.inst as InstName, t, this.deg(root + off, oct), (tr.dur ?? 2) * sd, tr.vol, opts);
          break;
        }
        case 'chord':
          if (ch === 'x' || ch === 'o')
            for (const off of [0, 2, 4]) e.note(tr.inst as InstName, t, this.deg(root + off, tr.oct ?? 0), (tr.dur ?? 2) * sd, tr.vol * (ch === 'o' ? 0.6 : 1), opts);
          break;
        case 'drone':
          if (st === 0) e.note(tr.inst as InstName, t, this.deg(root, tr.oct ?? -1), 16 * sd, tr.vol, opts);
          break;
        case 'arp': {
          const ev = tr.every ?? 2;
          if (st % ev !== 0) break;
          const seq = tr.arp ?? [0, 2, 4, 2];
          const k = Math.floor(st / ev) % seq.length;
          e.note(tr.inst as InstName, t, this.deg(root + seq[k], tr.oct ?? 0), (tr.dur ?? ev) * sd, tr.vol, opts);
          break;
        }
        case 'melody': {
          const m = this.mels.get(tr);
          if (!m) break;
          const notes = m[bar % m.length];
          for (const n of notes) if (n.step === st && n.deg > 0) e.note(tr.inst as InstName, t, this.deg(n.deg, (tr.oct ?? 0) + n.oct), n.len * sd * 0.95, tr.vol, opts);
          break;
        }
      }
    }
  }

  /** 1 at each quarter-note, decaying — for visuals that pulse with the music. */
  beat(): number {
    if (!this.song || !this.timer) return 0;
    const sd = this.stepDur();
    const origin = this.nextT - this.step * sd;
    const q = sd * 4;
    const ph = (((this.e.now - origin) % q) + q) % q;
    return Math.exp(-ph * 9);
  }

  /** A rally hit: plays the next note of an ascending phrase in the current chord. */
  hitNote(rally: number, power: number, pan = 0) {
    const s = this.song;
    if (!s || !this.e.running) return;
    const bar = Math.floor(this.step / 16) % s.chords.length;
    const root = s.chords[bar];
    const tones = [0, 2, 4, 7, 9, 11, 14];
    const i = Math.min(tones.length - 1, Math.floor(Math.max(0, rally - 1) / 1) % 7);
    this.hitCount++;
    const midi = this.deg(root + tones[i], s.hit.oct);
    this.e.note(s.hit.inst, this.e.now + 0.005, midi, 0.5, s.hit.vel * (0.6 + power * 0.5), { bus: this.e.sfx, rev: 0.35, dly: s.hit.dly ?? 0.15, pan });
  }

  /** Short jingle in the song's key. */
  jingle(kind: 'point' | 'lose' | 'game' | 'match' | 'start', inst?: InstName) {
    const s = this.song;
    if (!s) return;
    const e = this.e;
    const t = e.now + 0.02;
    const I = inst ?? s.hit.inst;
    const seqs: Record<string, [number, number][]> = {
      point: [
        [1, 0],
        [3, 0.08],
        [5, 0.16],
        [8, 0.26],
      ],
      lose: [
        [5, 0],
        [4, 0.12],
        [3, 0.24],
        [2, 0.4],
      ],
      game: [
        [1, 0],
        [3, 0.1],
        [5, 0.2],
        [8, 0.3],
        [5, 0.42],
        [8, 0.52],
        [10, 0.64],
      ],
      match: [
        [1, 0],
        [5, 0.12],
        [8, 0.24],
        [3, 0.4],
        [5, 0.5],
        [8, 0.6],
        [10, 0.72],
        [12, 0.84],
        [15, 1.0],
      ],
      start: [
        [5, 0],
        [8, 0.1],
      ],
    };
    for (const [d, dt] of seqs[kind]) e.note(I, t + dt, this.deg(d, s.hit.oct), 0.35, 0.7, { bus: e.sfx, rev: 0.4 });
  }
}

function parseBar(src: string): MelNote[] {
  const out: MelNote[] = [];
  let step = 0;
  for (const tok of src.trim().split(/\s+/)) {
    const [dRaw, lRaw] = tok.split(':');
    const len = Number(lRaw || 2);
    if (dRaw !== '-') {
      const oct = (dRaw.match(/'/g) || []).length - (dRaw.match(/,/g) || []).length;
      out.push({ step, deg: parseInt(dRaw, 10), oct, len });
    }
    step += len;
  }
  return out;
}
