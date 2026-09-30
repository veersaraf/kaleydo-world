// Web Audio engine: buses, reverb, and a small library of synthesised voices.
// Everything you hear in Kaleydo World is generated here — there are no samples.

export type InstName =
  | 'pluck'
  | 'koto'
  | 'bell'
  | 'musicbox'
  | 'epiano'
  | 'square'
  | 'pulse'
  | 'tri'
  | 'saw'
  | 'pad'
  | 'sub'
  | 'marimba'
  | 'flute'
  | 'glass'
  | 'organ';

export type DrumName = 'kick' | 'snare' | 'hat' | 'ohat' | 'clap' | 'taiko' | 'shaker' | 'wood' | 'chipkick' | 'chipsnare' | 'chiphat' | 'rim' | 'tom' | 'thud';

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** a plucked string the music is going to need: the instrument, the pitch, the note's length */
export interface StringNeed {
  inst: InstName;
  midi: number;
  dur: number;
}

/** a string being rendered, possibly over several slices of time */
interface KsJob {
  key: string;
  b: AudioBuffer;
  d: Float32Array;
  n: number;
  line: Float32Array;
  period: number;
  idx: number;
  i: number;
  sBlend: number;
  decay: number;
}

export class AudioEngine {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  crowd: GainNode;
  voice: GainNode;
  reverb: ConvolverNode;
  reverbSend: GainNode;
  delay: DelayNode;
  delaySend: GainNode;
  noiseBuf: AudioBuffer;
  pinkBuf: AudioBuffer;
  private ksCache = new Map<string, AudioBuffer>();
  private wavePulse: PeriodicWave;
  private shaper: WaveShaperNode;
  unlocked = false;

  constructor() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);

    this.music = c.createGain();
    this.sfx = c.createGain();
    this.crowd = c.createGain();
    this.voice = c.createGain();
    this.music.gain.value = 0.55;
    this.sfx.gain.value = 0.9;
    this.crowd.gain.value = 0.5;
    for (const g of [this.music, this.sfx, this.crowd, this.voice]) g.connect(this.master);

    this.reverb = c.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 2.2);
    this.reverbSend = c.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.delay = c.createDelay(1.5);
    this.delay.delayTime.value = 0.3;
    const fb = c.createGain();
    fb.gain.value = 0.32;
    const dlp = c.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 3200;
    this.delay.connect(dlp).connect(fb).connect(this.delay);
    this.delaySend = c.createGain();
    this.delaySend.gain.value = 1;
    this.delaySend.connect(this.delay);
    dlp.connect(this.music);

    const len = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.pinkBuf = c.createBuffer(1, len, c.sampleRate);
    const pd = this.pinkBuf.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      pd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
    const real = new Float32Array(32);
    const imag = new Float32Array(32);
    for (let n = 1; n < 32; n++) imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25);
    this.wavePulse = c.createPeriodicWave(real, imag);
    this.shaper = c.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    this.shaper.curve = curve;
  }

  get now() {
    return this.ctx.currentTime;
  }

  unlock() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    this.unlocked = true;
  }

  get running() {
    return this.ctx.state === 'running';
  }

  private impulse(dur: number, decay: number) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 80 ? i / 80 : 1);
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------- building blocks

  env(g: GainNode, t: number, a: number, peak: number, d: number, s: number, r: number, dur: number) {
    const p = g.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.setTargetAtTime(peak * s, t + a, d / 3 + 1e-4);
    const end = t + Math.max(a, dur);
    p.setTargetAtTime(0.0001, end, r / 4 + 1e-4);
    return end + r;
  }

  out(node: AudioNode, bus: AudioNode, pan = 0, rev = 0, dly = 0) {
    let n: AudioNode = node;
    if (pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      n.connect(p);
      n = p;
    }
    n.connect(bus);
    if (rev > 0) {
      const s = this.ctx.createGain();
      s.gain.value = rev;
      n.connect(s).connect(this.reverbSend);
    }
    if (dly > 0) {
      const s = this.ctx.createGain();
      s.gain.value = dly;
      n.connect(s).connect(this.delaySend);
    }
  }

  noise(t: number, dur: number, opts: { type?: BiquadFilterType; f0: number; f1?: number; q?: number; gain: number; attack?: number; bus?: AudioNode; pan?: number; rev?: number; pink?: boolean; rate?: number }) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = opts.pink ? this.pinkBuf : this.noiseBuf;
    src.playbackRate.value = opts.rate ?? 1;
    const f = c.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.Q.value = opts.q ?? 1;
    f.frequency.setValueAtTime(opts.f0, t);
    if (opts.f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, opts.f1), t + dur);
    const g = c.createGain();
    const a = opts.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g);
    this.out(g, opts.bus ?? this.sfx, opts.pan ?? 0, opts.rev ?? 0);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
    return g;
  }

  tone(t: number, freq: number, dur: number, opts: { type?: OscillatorType; gain: number; to?: number; attack?: number; bus?: AudioNode; pan?: number; rev?: number; dly?: number; detune?: number }) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.detune) o.detune.value = opts.detune;
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this.out(g, opts.bus ?? this.sfx, opts.pan ?? 0, opts.rev ?? 0, opts.dly ?? 0);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /**
   * Karplus–Strong plucked string, rendered once per pitch and cached. A string is rendered
   * in steps of half a second and a longer one serves a shorter request (the note stops the
   * source at the length it asked for, `ksLen`), so a pitch played at several lengths is one
   * buffer, not one each.
   */
  private ks(midi: number, bright: number, len: number) {
    const key = `${midi}|${bright}`;
    // (one being rendered in slices is finished now if a note wants it)
    if (this.ksJob && this.ksJob.key === key && this.ksJob.n >= this.ksFrames(len)) {
      const job = this.ksJob;
      this.ksRun(job, Infinity);
      return job.b;
    }
    const job = this.ksBegin(midi, bright, len);
    if (!job) return this.ksCache.get(key)!;
    this.ksRun(job, Infinity);
    return job.b;
  }

  /** samples in a string of `len` seconds */
  private ksFrames(len: number) {
    return Math.floor(this.ctx.sampleRate * len);
  }

  /** Is a string that covers this note already rendered? */
  private ksHas(midi: number, bright: number, len: number) {
    const b = this.ksCache.get(`${midi}|${bright}`);
    return !!b && b.length >= this.ksFrames(len);
  }

  /** the start of a string's rendering, or null if the cache already has one long enough */
  private ksBegin(midi: number, bright: number, len: number): KsJob | null {
    if (this.ksHas(midi, bright, len)) return null;
    const key = `${midi}|${bright}`;
    const old = this.ksCache.get(key);
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * Math.max(Math.ceil(len * 2) / 2, old ? old.duration : 0));
    const b = this.ctx.createBuffer(1, n, sr);
    const period = Math.max(2, Math.round(sr / midiHz(midi)));
    const line = new Float32Array(period);
    for (let i = 0; i < period; i++) line[i] = Math.random() * 2 - 1;
    // s: 0.5 = classic averaging; lower keeps more high harmonics (brighter)
    return { key, b, d: b.getChannelData(0), n, line, period, idx: 0, i: 0, sBlend: 0.5 - bright * 0.28, decay: 0.9985 - Math.max(0, midi - 60) * 0.00002 };
  }

  /** Render a string until it is done or `until` (performance.now) passes. Returns whether it is done. */
  private ksRun(job: KsJob, until: number) {
    const { d, n, line, period, sBlend, decay } = job;
    let idx = job.idx;
    let i = job.i;
    while (i < n) {
      const stop = Math.min(n, i + 4096);
      for (; i < stop; i++) {
        const cur = line[idx];
        const nx = idx + 1 === period ? 0 : idx + 1;
        d[i] = cur;
        line[idx] = decay * ((1 - sBlend) * cur + sBlend * line[nx]);
        idx = nx;
      }
      if (performance.now() >= until) break;
    }
    job.idx = idx;
    job.i = i;
    if (i < n) return false;
    // soften the attack click
    for (let k = 0; k < Math.min(64, n); k++) d[k] *= k / 64;
    this.ksCache.set(job.key, job.b);
    if (this.ksJob === job) this.ksJob = null;
    return true;
  }
  private ksJob: KsJob | null = null;

  /** How long a plucked note of this duration rings (the string stops there). */
  ksLen(dur: number) {
    return Math.min(2.5, dur + 1.2);
  }

  private static ksBright(inst: InstName) {
    return inst === 'koto' ? 0.85 : 0.6;
  }

  /** Are all of these plucked strings rendered? */
  stringsReady(list: StringNeed[]) {
    return list.every((s) => (s.inst !== 'pluck' && s.inst !== 'koto') || this.ksHas(s.midi, AudioEngine.ksBright(s.inst), this.ksLen(s.dur)));
  }

  /**
   * Render these plucked strings ahead of the notes that need them, in idle time and in
   * slices of a few milliseconds (a string is a tight loop over up to 2.5 s of samples: done
   * at a note's first play, it lengthens that frame).
   */
  prepareStrings(list: StringNeed[]) {
    for (const s of list) if ((s.inst === 'pluck' || s.inst === 'koto') && !this.ksQueue.some((q) => q.inst === s.inst && q.midi === s.midi && q.dur >= s.dur)) this.ksQueue.push(s);
    if (!this.ksBusy && (this.ksQueue.length || this.ksJob)) this.nextStrings();
  }
  private ksQueue: StringNeed[] = [];
  private ksBusy = false;

  private nextStrings() {
    this.ksBusy = true;
    type Idle = { timeRemaining(): number; didTimeout?: boolean };
    const run = (idle?: Idle) => {
      // a slice of what the browser says it can spare (a few ms at most)
      const t0 = performance.now();
      const until = t0 + (idle && !idle.didTimeout ? Math.max(1, Math.min(4, idle.timeRemaining() - 1)) : 2);
      for (;;) {
        if (!this.ksJob) {
          const s = this.ksQueue.shift();
          if (!s) break;
          this.ksJob = this.ksBegin(s.midi, AudioEngine.ksBright(s.inst), this.ksLen(s.dur));
          if (!this.ksJob) continue;
        }
        if (!this.ksRun(this.ksJob, until)) break;
        if (performance.now() >= until) break;
      }
      if (this.ksQueue.length || this.ksJob) queue();
      else this.ksBusy = false;
    };
    const queue = () => {
      const ric = (window as unknown as { requestIdleCallback?: (cb: (d: Idle) => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric.call(window, run, { timeout: 300 });
      else setTimeout(() => run(), 20);
    };
    queue();
  }

  /** Play a pitched instrument note. */
  note(inst: InstName, t: number, midi: number, dur: number, vel: number, opts: { bus?: AudioNode; pan?: number; rev?: number; dly?: number } = {}) {
    const c = this.ctx;
    const bus = opts.bus ?? this.music;
    const f = midiHz(midi);
    const rev = opts.rev ?? 0.25;
    const pan = opts.pan ?? 0;
    const g = c.createGain();
    let end = t + dur + 1;
    const oscs: OscillatorNode[] = [];
    const mk = (type: OscillatorType | 'pulse', freq: number, detune = 0) => {
      const o = c.createOscillator();
      if (type === 'pulse') o.setPeriodicWave(this.wavePulse);
      else o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      oscs.push(o);
      return o;
    };
    switch (inst) {
      case 'pluck':
      case 'koto': {
        const src = c.createBufferSource();
        const ring = this.ksLen(dur);
        src.buffer = this.ks(midi, AudioEngine.ksBright(inst), ring);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = inst === 'koto' ? 5200 : 3200;
        src.connect(lp).connect(g);
        g.gain.value = vel * 0.9;
        src.start(t);
        // (a longer string is cut where the note's own would have ended)
        src.stop(t + this.ksFrames(ring) / this.ctx.sampleRate);
        this.out(g, bus, pan, rev, opts.dly ?? 0);
        return;
      }
      case 'bell':
      case 'musicbox':
      case 'glass': {
        const car = mk('sine', f);
        const mod = mk('sine', f * (inst === 'musicbox' ? 4 : inst === 'glass' ? 2.01 : 3.5));
        const mg = c.createGain();
        const idx = inst === 'glass' ? 0.6 : 2.2;
        mg.gain.setValueAtTime(f * idx, t);
        mg.gain.exponentialRampToValueAtTime(f * 0.05 + 1, t + (inst === 'musicbox' ? 0.4 : 1.2));
        mod.connect(mg).connect(car.frequency);
        car.connect(g);
        const decay = inst === 'musicbox' ? 1.1 : inst === 'glass' ? 2.2 : 1.8;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vel * 0.45, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        end = t + decay;
        break;
      }
      case 'epiano': {
        const car = mk('sine', f);
        const mod = mk('sine', f);
        const mg = c.createGain();
        mg.gain.setValueAtTime(f * 1.6, t);
        mg.gain.exponentialRampToValueAtTime(f * 0.1, t + 0.6);
        mod.connect(mg).connect(car.frequency);
        const car2 = mk('sine', f * 2.001);
        const g2 = c.createGain();
        g2.gain.value = 0.15;
        car2.connect(g2).connect(g);
        car.connect(g);
        end = this.env(g, t, 0.005, vel * 0.42, 0.9, 0.3, 0.5, dur);
        break;
      }
      case 'square':
      case 'pulse':
      case 'tri': {
        const o = mk(inst === 'tri' ? 'triangle' : inst === 'pulse' ? 'pulse' : 'square', f);
        o.connect(g);
        const pk = inst === 'tri' ? vel * 0.5 : vel * 0.16;
        end = this.env(g, t, 0.002, pk, 0.08, 0.7, 0.05, dur);
        break;
      }
      case 'saw': {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 6;
        lp.frequency.setValueAtTime(600 + vel * 3800, t);
        lp.frequency.exponentialRampToValueAtTime(380, t + Math.min(0.4, dur + 0.1));
        mk('sawtooth', f, -7).connect(lp);
        mk('sawtooth', f, 7).connect(lp);
        lp.connect(g);
        end = this.env(g, t, 0.003, vel * 0.16, 0.15, 0.6, 0.08, dur);
        break;
      }
      case 'pad': {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900 + vel * 1200;
        lp.Q.value = 0.7;
        for (const dt of [-11, 0, 9]) mk('sawtooth', f, dt).connect(lp);
        lp.connect(g);
        end = this.env(g, t, Math.min(0.6, dur * 0.4), vel * 0.07, 0.5, 0.8, 0.8, dur);
        break;
      }
      case 'sub': {
        const o = mk('sine', f);
        const o2 = mk('triangle', f * 2);
        const g2 = c.createGain();
        g2.gain.value = 0.18;
        o2.connect(g2).connect(g);
        o.connect(g);
        end = this.env(g, t, 0.004, vel * 0.6, 0.2, 0.7, 0.08, dur);
        break;
      }
      case 'marimba': {
        mk('sine', f).connect(g);
        const h = mk('sine', f * 4.01);
        const hg = c.createGain();
        hg.gain.setValueAtTime(0.35, t);
        hg.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        h.connect(hg).connect(g);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vel * 0.5, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
        end = t + 0.7;
        break;
      }
      case 'organ': {
        for (const [m, a] of [
          [1, 0.5],
          [2, 0.25],
          [3, 0.12],
          [4, 0.08],
        ] as const) {
          const o = mk('sine', f * m);
          const og = c.createGain();
          og.gain.value = a;
          o.connect(og).connect(g);
        }
        end = this.env(g, t, 0.02, vel * 0.3, 0.3, 0.8, 0.2, dur);
        break;
      }
      case 'flute': {
        const o = mk('sine', f);
        const vib = mk('sine', 5.2);
        const vg = c.createGain();
        vg.gain.setValueAtTime(0, t);
        vg.gain.linearRampToValueAtTime(f * 0.012, t + 0.4);
        vib.connect(vg).connect(o.frequency);
        o.connect(g);
        const br = c.createBufferSource();
        br.buffer = this.noiseBuf;
        const bf = c.createBiquadFilter();
        bf.type = 'bandpass';
        bf.frequency.value = f * 2;
        bf.Q.value = 2;
        const bg = c.createGain();
        bg.gain.value = 0.25;
        br.connect(bf).connect(bg).connect(g);
        br.start(t, Math.random());
        br.stop(t + dur + 0.6);
        end = this.env(g, t, 0.08, vel * 0.3, 0.3, 0.75, 0.25, dur);
        break;
      }
    }
    for (const o of oscs) {
      o.start(t);
      o.stop(end + 0.1);
    }
    this.out(g, bus, pan, rev, opts.dly ?? 0);
  }

  drum(d: DrumName, t: number, vel: number, opts: { bus?: AudioNode; pan?: number; rev?: number } = {}) {
    const bus = opts.bus ?? this.music;
    const pan = opts.pan ?? 0;
    const rev = opts.rev ?? 0.08;
    switch (d) {
      case 'kick':
        this.tone(t, 150, 0.32, { gain: vel * 0.9, to: 42, bus, pan });
        this.noise(t, 0.02, { type: 'highpass', f0: 1800, gain: vel * 0.15, bus });
        break;
      case 'thud':
        this.tone(t, 110, 0.22, { gain: vel * 0.7, to: 50, bus, pan });
        break;
      case 'snare':
        this.noise(t, 0.2, { type: 'bandpass', f0: 2200, q: 0.8, gain: vel * 0.45, bus, pan, rev: rev + 0.15 });
        this.tone(t, 200, 0.1, { gain: vel * 0.3, to: 150, bus, pan });
        break;
      case 'clap':
        for (let i = 0; i < 3; i++) this.noise(t + i * 0.011, 0.03, { type: 'bandpass', f0: 1500, q: 1.4, gain: vel * 0.35, bus, pan });
        this.noise(t + 0.03, 0.22, { type: 'bandpass', f0: 1400, q: 1.1, gain: vel * 0.25, bus, pan, rev: 0.3 });
        break;
      case 'hat':
        this.noise(t, 0.035, { type: 'highpass', f0: 7500, gain: vel * 0.18, bus, pan });
        break;
      case 'ohat':
        this.noise(t, 0.24, { type: 'highpass', f0: 7000, gain: vel * 0.14, bus, pan });
        break;
      case 'shaker':
        this.noise(t, 0.07, { type: 'bandpass', f0: 6500, q: 1.2, gain: vel * 0.14, bus, pan, attack: 0.02 });
        break;
      case 'wood':
        this.tone(t, 820, 0.06, { gain: vel * 0.35, to: 760, bus, pan, rev: 0.2 });
        this.noise(t, 0.02, { type: 'bandpass', f0: 2500, gain: vel * 0.2, bus, pan });
        break;
      case 'rim':
        this.tone(t, 1600, 0.03, { gain: vel * 0.25, bus, pan });
        this.noise(t, 0.025, { type: 'bandpass', f0: 3200, gain: vel * 0.2, bus, pan });
        break;
      case 'tom':
        this.tone(t, 180, 0.3, { gain: vel * 0.6, to: 110, bus, pan, rev: 0.2 });
        break;
      case 'taiko':
        this.tone(t, 92, 0.7, { gain: vel * 0.95, to: 58, bus, pan, rev: 0.4 });
        this.noise(t, 0.12, { type: 'lowpass', f0: 900, gain: vel * 0.35, bus, pan, rev: 0.3 });
        break;
      case 'chipkick':
        this.tone(t, 220, 0.12, { type: 'square', gain: vel * 0.18, to: 55, bus, pan });
        break;
      case 'chipsnare':
        this.noise(t, 0.1, { type: 'highpass', f0: 1200, gain: vel * 0.3, bus, pan, rate: 0.25 });
        break;
      case 'chiphat':
        this.noise(t, 0.03, { type: 'highpass', f0: 6000, gain: vel * 0.15, bus, pan, rate: 0.5 });
        break;
    }
  }

  midiHz = midiHz;
}
