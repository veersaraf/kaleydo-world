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

  say(text: string, opts: { rate?: number; pitch?: number } = {}) {
    if (!this.voiceOn || !('speechSynthesis' in window) || !this.engine.unlocked) return;
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
