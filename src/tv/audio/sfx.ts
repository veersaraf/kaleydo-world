// Gameplay sound effects and the crowd.

import type { AudioEngine } from './engine';

export type Timbre = 'hard' | 'wood' | 'synth' | 'chip' | 'paper' | 'clay' | 'soft' | 'glass';

export class Sfx {
  timbre: Timbre = 'hard';
  private crowdBed: { src: AudioBufferSourceNode; g: GainNode; f: BiquadFilterNode } | null = null;
  private crowdLevel = 0.2;

  constructor(private e: AudioEngine) {}

  hit(power: number, perfect: boolean, pan: number, smash = false) {
    const e = this.e;
    const t = e.now + 0.002;
    const p = Math.max(0.1, Math.min(1, power));
    const bus = e.sfx;
    switch (this.timbre) {
      case 'chip':
        e.tone(t, 880 + p * 440, 0.08, { type: 'square', gain: 0.22, to: 440, bus, pan });
        e.tone(t, 220, 0.06, { type: 'square', gain: 0.14, to: 110, bus, pan });
        break;
      case 'synth':
        e.tone(t, 420 + p * 200, 0.14, { type: 'sawtooth', gain: 0.16, to: 90, bus, pan, rev: 0.3 });
        e.noise(t, 0.05, { type: 'highpass', f0: 3000, gain: 0.3 + p * 0.3, bus, pan });
        e.tone(t, 1800, 0.08, { type: 'sine', gain: 0.12, to: 2600, bus, pan, rev: 0.3 });
        break;
      case 'wood':
        e.tone(t, 620 + p * 180, 0.07, { gain: 0.55, to: 480, bus, pan, rev: 0.35 });
        e.noise(t, 0.04, { type: 'bandpass', f0: 2400, q: 3, gain: 0.35 + p * 0.3, bus, pan, rev: 0.2 });
        break;
      case 'paper':
        e.noise(t, 0.09, { type: 'bandpass', f0: 1400, f1: 700, q: 1.5, gain: 0.5 + p * 0.3, bus, pan });
        e.tone(t, 260, 0.08, { gain: 0.3, to: 160, bus, pan });
        break;
      case 'clay':
        e.tone(t, 180 + p * 60, 0.14, { gain: 0.6, to: 90, bus, pan });
        e.noise(t, 0.08, { type: 'lowpass', f0: 1600, f1: 300, gain: 0.35, bus, pan });
        break;
      case 'glass':
        e.tone(t, 1320 + p * 400, 0.35, { gain: 0.18, bus, pan, rev: 0.5 });
        e.noise(t, 0.05, { type: 'bandpass', f0: 3000, q: 2, gain: 0.3 + p * 0.3, bus, pan });
        e.tone(t, 330, 0.08, { gain: 0.3, to: 180, bus, pan });
        break;
      default:
        // classic racket "pok": felt thump + string ping
        e.noise(t, 0.06 + p * 0.03, { type: 'bandpass', f0: 2600, f1: 900, q: 2, gain: 0.5 + p * 0.45, bus, pan });
        e.tone(t, 300 + p * 130, 0.1, { gain: 0.55 + p * 0.3, to: 140, bus, pan });
        e.tone(t, 1250 + p * 280, 0.07, { type: 'triangle', gain: 0.1, to: 900, bus, pan });
    }
    if (smash) {
      e.noise(t, 0.3, { type: 'lowpass', f0: 2400, f1: 200, gain: 0.5, bus, pan, rev: 0.4 });
      e.tone(t, 120, 0.3, { gain: 0.6, to: 45, bus, pan });
    }
    if (perfect) {
      e.tone(t + 0.02, 1568, 0.5, { gain: 0.1, bus, pan, rev: 0.6 });
      e.tone(t + 0.06, 2349, 0.6, { gain: 0.08, bus, pan, rev: 0.6 });
      e.noise(t, 0.4, { type: 'highpass', f0: 6000, gain: 0.12, bus, pan, rev: 0.5 });
    }
  }

  swish(power: number, pan: number) {
    const p = Math.max(0.1, Math.min(1, power));
    this.e.noise(this.e.now + 0.002, 0.18 + p * 0.06, { type: 'bandpass', f0: 450, f1: 2200 + p * 1600, q: 1.2, gain: 0.12 + p * 0.18, bus: this.e.sfx, pan, attack: 0.03 });
  }

  /** a diving player hitting the court: a body thump and a skid */
  thud(pan: number) {
    const e = this.e;
    const t = e.now + 0.002;
    e.tone(t, 95, 0.16, { gain: 0.5, to: 55, bus: e.sfx, pan });
    e.noise(t + 0.01, 0.28, { type: 'bandpass', f0: 700, f1: 300, q: 0.9, gain: 0.22, bus: e.sfx, pan, attack: 0.02 });
  }

  bounce(impact: number, pan: number) {
    const e = this.e;
    const t = e.now + 0.002;
    const g = Math.min(1, impact / 8);
    if (g < 0.05) return;
    switch (this.timbre) {
      case 'chip':
        e.tone(t, 330, 0.05, { type: 'square', gain: 0.1 * g + 0.03, to: 200, bus: e.sfx, pan });
        break;
      case 'clay':
        e.tone(t, 120, 0.12, { gain: 0.4 * g, to: 70, bus: e.sfx, pan });
        break;
      case 'paper':
        e.noise(t, 0.05, { type: 'bandpass', f0: 900, gain: 0.3 * g, bus: e.sfx, pan });
        break;
      default:
        e.tone(t, 210, 0.07, { gain: 0.45 * g, to: 110, bus: e.sfx, pan });
        e.noise(t, 0.03, { type: 'bandpass', f0: 1500, q: 1.5, gain: 0.25 * g, bus: e.sfx, pan });
    }
  }

  net(cord: boolean, pan: number) {
    const e = this.e;
    const t = e.now + 0.002;
    if (cord) {
      e.tone(t, 900, 0.05, { gain: 0.2, bus: e.sfx, pan });
      e.noise(t, 0.1, { type: 'bandpass', f0: 1200, q: 3, gain: 0.25, bus: e.sfx, pan });
      return;
    }
    for (let i = 0; i < 6; i++) e.noise(t + i * 0.035, 0.07, { type: 'bandpass', f0: 500 + Math.random() * 300, q: 4, gain: 0.35 * (1 - i / 6), bus: e.sfx, pan });
    e.tone(t, 90, 0.2, { gain: 0.35, to: 60, bus: e.sfx, pan });
  }

  ui(kind: 'move' | 'select' | 'back' | 'error' | 'join' | 'shift') {
    const e = this.e;
    const t = e.now + 0.002;
    const bus = e.sfx;
    if (kind === 'move') e.tone(t, 1180, 0.05, { type: 'triangle', gain: 0.12, bus });
    else if (kind === 'select') {
      e.tone(t, 988, 0.08, { type: 'triangle', gain: 0.16, bus });
      e.tone(t + 0.07, 1480, 0.12, { type: 'triangle', gain: 0.16, bus, rev: 0.2 });
    } else if (kind === 'back') {
      e.tone(t, 880, 0.08, { type: 'triangle', gain: 0.14, bus });
      e.tone(t + 0.07, 587, 0.12, { type: 'triangle', gain: 0.14, bus });
    } else if (kind === 'error') e.tone(t, 220, 0.18, { type: 'square', gain: 0.08, bus });
    else if (kind === 'join') {
      [784, 988, 1175, 1568].forEach((f, i) => e.tone(t + i * 0.07, f, 0.2, { type: 'triangle', gain: 0.14, bus, rev: 0.3 }));
    } else if (kind === 'shift') {
      // glassy shatter
      for (let i = 0; i < 14; i++) e.tone(t + Math.random() * 0.35, 1800 + Math.random() * 4200, 0.25 + Math.random() * 0.4, { gain: 0.05, bus, rev: 0.6, pan: Math.random() * 2 - 1 });
      e.noise(t, 0.7, { type: 'highpass', f0: 3000, f1: 9000, gain: 0.2, bus, rev: 0.6 });
      e.tone(t, 110, 0.8, { gain: 0.3, to: 55, bus, rev: 0.5 });
    }
  }

  /** Chatty character voice: one pitched blip per letter. */
  blip(ch: string, base: number) {
    const e = this.e;
    const t = e.now + 0.002;
    const code = ch.toLowerCase().charCodeAt(0);
    const vowel = 'aeiou'.includes(ch.toLowerCase());
    const f = base * Math.pow(2, (((code * 7) % 9) - 4) / 14);
    e.tone(t, f, vowel ? 0.07 : 0.045, { type: 'triangle', gain: 0.07, to: f * (vowel ? 1.06 : 0.9), bus: e.voice });
    e.tone(t, f * 2.01, 0.035, { type: 'sine', gain: 0.025, bus: e.voice });
  }

  // ---------------------------------------------------------------- bowling

  private rollBed: { src: AudioBufferSourceNode; g: GainNode; f: BiquadFilterNode; p: StereoPannerNode } | null = null;

  /** the low rumble of a ball rolling down the lane: level 0..1 follows its speed */
  roll(level: number, pan = 0) {
    const e = this.e;
    if (!this.rollBed && level > 0.01) {
      const src = e.ctx.createBufferSource();
      src.buffer = e.pinkBuf;
      src.loop = true;
      const f = e.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 240;
      f.Q.value = 0.9;
      const g = e.ctx.createGain();
      g.gain.value = 0;
      const p = e.ctx.createStereoPanner();
      src.connect(f).connect(g).connect(p).connect(e.sfx);
      src.start();
      this.rollBed = { src, g, f, p };
    }
    const r = this.rollBed;
    if (!r) return;
    const t = e.now;
    r.g.gain.setTargetAtTime(level * 0.9, t, 0.06);
    r.f.frequency.setTargetAtTime(160 + level * 220, t, 0.1);
    r.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.1);
    if (level <= 0.01) {
      const bed = r;
      this.rollBed = null;
      setTimeout(() => bed.src.stop(), 400);
    }
  }

  /** wooden pin clatter; the ball hitting a pin is a deeper thock */
  pinHit(impact: number, pan: number, ballOnPin: boolean) {
    const e = this.e;
    const t = e.now + Math.random() * 0.012;
    const g = Math.min(1, impact / 6);
    if (ballOnPin) {
      e.tone(t, 150, 0.12, { gain: 0.5 * g + 0.2, to: 90, bus: e.sfx, pan });
      e.noise(t, 0.08, { type: 'bandpass', f0: 1100, q: 1.2, gain: 0.45 * g + 0.15, bus: e.sfx, pan });
      return;
    }
    const f = 700 + Math.random() * 700;
    e.tone(t, f, 0.06, { type: 'triangle', gain: 0.18 * g + 0.05, to: f * 0.8, bus: e.sfx, pan });
    e.tone(t, f * 1.51, 0.04, { type: 'sine', gain: 0.08 * g, bus: e.sfx, pan });
    e.noise(t, 0.05, { type: 'bandpass', f0: 2200 + Math.random() * 1200, q: 2, gain: 0.22 * g + 0.04, bus: e.sfx, pan });
  }

  /** the ball dropping into a gutter */
  gutter(pan = 0) {
    const e = this.e;
    const t = e.now + 0.002;
    e.tone(t, 130, 0.22, { gain: 0.35, to: 85, bus: e.sfx, pan });
    e.noise(t, 0.3, { type: 'lowpass', f0: 500, gain: 0.25, bus: e.sfx, pan });
  }

  /** the pinsetter sweeping and re-racking */
  pinsetter() {
    const e = this.e;
    const t = e.now + 0.002;
    e.noise(t, 0.9, { type: 'bandpass', f0: 700, f1: 320, q: 3, gain: 0.08, bus: e.sfx, attack: 0.1 });
    e.tone(t + 0.75, 220, 0.08, { type: 'square', gain: 0.04, to: 160, bus: e.sfx });
  }

  // ---------------------------------------------------------------- crowd

  startCrowd() {
    if (this.crowdBed) return;
    const e = this.e;
    const src = e.ctx.createBufferSource();
    // reuse engine noise through a warm filter; slow LFO gives murmur movement
    src.buffer = e.pinkBuf;
    src.loop = true;
    const f = e.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 520;
    f.Q.value = 0.6;
    const g = e.ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(e.crowd);
    const lfo = e.ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lg = e.ctx.createGain();
    lg.gain.value = 140;
    lfo.connect(lg).connect(f.frequency);
    lfo.start();
    src.start();
    this.crowdBed = { src, g, f };
    this.setCrowd(this.crowdLevel);
  }

  setCrowd(level: number) {
    this.crowdLevel = level;
    if (!this.crowdBed) return;
    const t = this.e.now;
    this.crowdBed.g.gain.setTargetAtTime(0.25 + level * 0.9, t, 0.6);
  }

  applause(intensity: number, dur = 2.4) {
    const e = this.e;
    const t0 = e.now;
    const n = Math.floor(40 + intensity * 120);
    for (let i = 0; i < n; i++) {
      const t = t0 + Math.pow(Math.random(), 1.6) * dur;
      e.noise(t, 0.02 + Math.random() * 0.02, {
        type: 'bandpass',
        f0: 900 + Math.random() * 2400,
        q: 1.5,
        gain: (0.05 + Math.random() * 0.06) * (0.4 + intensity),
        bus: e.crowd,
        pan: Math.random() * 1.6 - 0.8,
      });
    }
    // swell of voices
    this.voices(intensity, dur * 0.8, 'ah');
  }

  cheer(intensity: number) {
    this.voices(intensity, 1.8, 'ey');
    this.applause(intensity, 2.8);
  }

  ooh() {
    this.voices(0.6, 1.2, 'oo');
  }

  aww() {
    this.voices(0.5, 1.1, 'aw');
  }

  /** Formant-filtered noise that sounds like many voices. */
  private voices(intensity: number, dur: number, vowel: 'ah' | 'oo' | 'ey' | 'aw') {
    const e = this.e;
    const t = e.now + 0.02;
    const F: Record<string, [number, number]> = { ah: [800, 1200], oo: [350, 800], ey: [500, 1900], aw: [600, 950] };
    const [f1, f2] = F[vowel];
    for (const [f, q, gmul] of [
      [f1, 5, 1],
      [f2, 7, 0.6],
    ] as const) {
      const src = e.ctx.createBufferSource();
      src.buffer = e.noiseBuf;
      const bp = e.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(f * (vowel === 'oo' ? 0.9 : 1), t);
      bp.frequency.linearRampToValueAtTime(f * (vowel === 'aw' ? 0.85 : 1.08), t + dur);
      const g = e.ctx.createGain();
      const peak = 0.5 * intensity * gmul;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + dur * (vowel === 'oo' ? 0.45 : 0.18));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp).connect(g);
      e.out(g, e.crowd, 0, 0.35);
      src.start(t, Math.random());
      src.stop(t + dur + 0.1);
    }
  }
}
