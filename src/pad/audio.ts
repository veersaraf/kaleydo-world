// The remote's little speaker — like the Wii Remote's, it plays the racket
// "pok" right in your hand. Everything is synthesised; no audio files.

export class PadAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  volume = 0.9;

  /** Must be called from inside a user gesture (tap). */
  unlock() {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      // iOS 17+: let game sounds play even when the ringer switch is on silent.
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch {}
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
    // A silent blip finishes unlocking on older iOS.
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start(0);
  }

  private get ok() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private noiseBurst(t: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, gain: number) {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  private tone(t: number, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number) {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Racket strikes the ball. */
  hit(power = 0.6, perfect = false) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const p = Math.max(0.15, Math.min(1, power));
    this.noiseBurst(t, 0.07 + p * 0.03, 'bandpass', 2600, 900, 2.2, 0.55 + p * 0.4);
    this.tone(t, 330 + p * 120, 0.09, 0.5 + p * 0.3, 'sine', 150);
    this.tone(t, 1250 + p * 300, 0.06, 0.12, 'triangle', 900); // string twang
    if (perfect) {
      this.tone(t + 0.02, 1568, 0.25, 0.12, 'sine');
      this.tone(t + 0.07, 2093, 0.3, 0.1, 'sine');
    }
  }

  /** Air swish when a swing is detected on the phone itself. */
  swish(power = 0.5) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const p = Math.max(0.1, Math.min(1, power));
    this.noiseBurst(t, 0.16 + p * 0.06, 'bandpass', 500, 2600 + p * 1400, 1.4, 0.18 + p * 0.25);
  }

  /** Duel: a sword stroke through the air — quicker and brighter than the racket's swish. */
  slash(power = 0.6) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const p = Math.max(0.1, Math.min(1, power));
    this.noiseBurst(t, 0.11 + p * 0.07, 'bandpass', 900, 3400 + p * 2200, 2.2, 0.2 + p * 0.3);
  }

  /** Duel: a thrust — a short rising "fft". */
  thrust(power = 0.6) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const p = Math.max(0.1, Math.min(1, power));
    this.noiseBurst(t, 0.1, 'bandpass', 1300, 4400, 3, 0.18 + p * 0.25);
    this.tone(t, 280, 0.07, 0.1, 'sine', 620);
  }

  /** Duel: the guard goes up — a short metallic "shing". */
  guard() {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    this.noiseBurst(t, 0.05, 'highpass', 7000, 4500, 0.7, 0.07);
    this.tone(t, 2637, 0.09, 0.05, 'triangle');
    this.tone(t + 0.015, 3951, 0.13, 0.035, 'sine');
  }

  /** Duel: your guard stopped a blow — blades meet, a bright clang. */
  clank(power = 0.7) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const p = Math.max(0.2, Math.min(1, power));
    this.noiseBurst(t, 0.06, 'highpass', 6000, 2500, 0.8, 0.3 + p * 0.3);
    // a struck bar rings at inharmonic partials, the high ones dying first
    for (const [f, g, d] of [
      [523, 0.16, 0.55],
      [1307, 0.13, 0.42],
      [2213, 0.1, 0.3],
      [3571, 0.07, 0.2],
    ])
      this.tone(t, f * (0.98 + Math.random() * 0.04), d * (0.7 + p * 0.3), g * (0.6 + p * 0.4), 'sine');
  }

  /** Duel: you took a hit — a dull thud. */
  thud(power = 0.7) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const p = Math.max(0.2, Math.min(1, power));
    this.noiseBurst(t, 0.14, 'lowpass', 900, 150, 0.9, 0.5 + p * 0.4);
    this.tone(t, 150, 0.22, 0.55 + p * 0.3, 'sine', 48);
    this.tone(t + 0.01, 95, 0.18, 0.3, 'triangle', 40);
  }

  /** Duel: your blow landed — a padded thwack and a little ding. */
  thwack(power = 0.7) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const p = Math.max(0.2, Math.min(1, power));
    this.noiseBurst(t, 0.09, 'bandpass', 2200, 600, 1.4, 0.5 + p * 0.35);
    this.tone(t, 260 + p * 60, 0.12, 0.4 + p * 0.2, 'triangle', 110);
    this.tone(t + 0.03, 1760, 0.2, 0.08, 'sine');
  }

  toss() {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    this.noiseBurst(t, 0.22, 'bandpass', 400, 1600, 2, 0.15);
    this.tone(t, 520, 0.12, 0.08, 'sine', 780);
  }

  tick() {
    if (!this.ok) return;
    this.tone(this.ctx!.currentTime + 0.001, 1320, 0.035, 0.12, 'triangle');
  }

  select() {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    this.tone(t, 988, 0.07, 0.14, 'triangle');
    this.tone(t + 0.06, 1319, 0.1, 0.14, 'triangle');
  }

  back() {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    this.tone(t, 784, 0.07, 0.12, 'triangle');
    this.tone(t + 0.06, 587, 0.1, 0.12, 'triangle');
  }

  jingle(up: boolean) {
    if (!this.ok) return;
    const t = this.ctx!.currentTime + 0.001;
    const notes = up ? [523, 659, 784, 1047] : [392, 349, 311, 262];
    notes.forEach((f, i) => this.tone(t + i * 0.09, f, 0.22, 0.12, 'triangle'));
  }
}
