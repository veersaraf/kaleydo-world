// The game's audio facade: music, sfx, crowd and the umpire's voice.

import { AudioEngine } from './engine';
import { Music } from './music';
import { SONGS } from './songs';
import { Sfx, type Timbre } from './sfx';

export class GameAudio {
  engine: AudioEngine;
  music: Music;
  sfx: Sfx;
  voiceOn = true;
  muted = false;
  private voiceName: SpeechSynthesisVoice | null = null;

  constructor() {
    this.engine = new AudioEngine();
    this.music = new Music(this.engine);
    this.sfx = new Sfx(this.engine);
    if ('speechSynthesis' in window) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        const pref = ['Daniel', 'Google UK English Male', 'Arthur', 'Oliver', 'Serena', 'Kate', 'Google UK English Female'];
        this.voiceName = pref.map((n) => vs.find((v) => v.name.includes(n))).find(Boolean) ?? vs.find((v) => v.lang.startsWith('en-GB')) ?? vs.find((v) => v.lang.startsWith('en')) ?? null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }

  get ready() {
    return this.engine.running;
  }

  unlock() {
    this.engine.unlock();
    this.sfx.startCrowd();
  }

  playSong(id: string) {
    const s = SONGS[id] ?? SONGS.plaza;
    this.music.play(s);
  }

  setTimbre(t: Timbre) {
    this.sfx.timbre = t;
  }

  setVolumes(music: number, sfx: number) {
    this.music.setVolume(music);
    this.engine.sfx.gain.value = sfx;
    this.engine.crowd.gain.value = 0.5 * sfx;
  }

  /** the sound button: everything (music, effects, crowd, the umpire) off or back on */
  setMuted(m: boolean) {
    this.muted = m;
    const g = this.engine.master.gain;
    g.setTargetAtTime(m ? 0 : 0.9, this.engine.ctx.currentTime, 0.03);
    if (m && 'speechSynthesis' in window) speechSynthesis.cancel();
  }

  say(text: string, opts: { rate?: number; pitch?: number } = {}) {
    if (!this.voiceOn || this.muted || !('speechSynthesis' in window) || !this.engine.unlocked) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voiceName) u.voice = this.voiceName;
      u.rate = opts.rate ?? 1.02;
      u.pitch = opts.pitch ?? 0.95;
      u.volume = 0.9;
      speechSynthesis.speak(u);
    } catch {}
  }
}
