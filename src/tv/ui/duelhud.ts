// Sword duel HUD: a name plate per fighter (rounds won as pips, and how much
// strength is left in their arm), the round clock, big calls (FIGHT! BLOCKED!
// EDGE!) and the how-to hint.

import { h, clear, replay } from './dom';
import type { Duelist } from '../duel/types';

export class DuelHud {
  el: HTMLElement;
  private plates: { el: HTMLElement; pips: HTMLElement[]; energy: HTMLElement; tag: HTMLElement }[] = [];
  private clock: HTMLElement;
  private call: HTMLElement;
  private hint: HTMLElement;
  private shownSecs = -1;

  constructor(duelists: [Duelist, Duelist], toWin: number) {
    const plate = (d: Duelist, side: 'l' | 'r') => {
      const pips = Array.from({ length: toWin }, () => h('i'));
      const energy = h('b');
      const tag = h('em');
      const el = h('div', { class: `dplate ${side}`, style: `--c:${d.color}` }, h('div', { class: 'dname' }, h('span', null, d.name), tag), h('div', { class: 'dpips' }, ...pips), h('div', { class: 'denergy' }, energy));
      this.plates.push({ el, pips, energy, tag });
      return el;
    };
    this.clock = h('div', { class: 'dclock' });
    this.call = h('div', { class: 'callout dcall' });
    this.hint = h('div', { class: 'hint dhint' });
    this.el = h('div', { class: 'hud dhud' }, h('div', { class: 'dtop' }, plate(duelists[0], 'l'), this.clock, plate(duelists[1], 'r')), this.call, this.hint);
  }

  /** Rounds won so far. */
  setScore(score: [number, number]) {
    this.plates.forEach((p, i) => p.pips.forEach((pip, k) => pip.classList.toggle('on', k < score[i])));
  }

  /** Per frame: the clock and each fighter's arm strength (0..1). */
  update(timeLeft: number | null, energy: [number, number]) {
    const secs = timeLeft === null ? -1 : Math.max(0, Math.ceil(timeLeft));
    if (secs !== this.shownSecs) {
      this.shownSecs = secs;
      this.clock.textContent = secs < 0 ? '' : String(secs);
      this.clock.classList.toggle('low', secs >= 0 && secs <= 10);
    }
    this.plates.forEach((p, i) => {
      const e = Math.round(Math.max(0, Math.min(1, energy[i])) * 100);
      if (p.energy.dataset.e !== String(e)) {
        p.energy.dataset.e = String(e);
        p.energy.style.width = `${e}%`;
        p.energy.parentElement!.classList.toggle('low', e < 35);
      }
    });
  }

  /** A word under a fighter's name ("EDGE!", "STUNNED"), or '' to clear. */
  tag(i: number, text: string) {
    const t = this.plates[i].tag;
    if (t.textContent === text) return;
    t.textContent = text;
    if (text) replay(t, 'show');
  }

  say(text: string, sub = '', cls = '') {
    clear(this.call);
    this.call.className = `callout dcall ${cls}`;
    this.call.append(text);
    if (sub) this.call.append(h('span', { class: 'sub' }, sub));
    replay(this.call, 'show');
  }

  setHint(html: string) {
    if (html) this.hint.innerHTML = html;
    this.hint.classList.toggle('on', !!html);
  }
}
