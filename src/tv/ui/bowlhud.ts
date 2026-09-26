// Bowling HUD: the scorecard across the top, a pin diagram after the first ball,
// big calls (STRIKE! SPARE! SPLIT!), the ball speed and the how-to hint.

import { h, clear, replay } from './dom';
import type { Bowler } from '../bowling/game';

/** where pins sit in the little diagram (pin-number order), in 0..1 */
const PIN_XY: [number, number][] = [
  [0.5, 0.9],
  [0.35, 0.63],
  [0.65, 0.63],
  [0.2, 0.36],
  [0.5, 0.36],
  [0.8, 0.36],
  [0.05, 0.09],
  [0.35, 0.09],
  [0.65, 0.09],
  [0.95, 0.09],
];

export class BowlHud {
  el: HTMLElement;
  private card: HTMLElement;
  private pins: HTMLElement;
  private dots: HTMLElement[];
  private call: HTMLElement;
  private speed: HTMLElement;
  private hint: HTMLElement;
  private turn: HTMLElement;

  constructor(private bowlers: Bowler[]) {
    this.card = h('div', { class: 'bcard' });
    this.dots = PIN_XY.map(([x, y]) => h('i', { style: `left:${x * 100}%;top:${y * 100}%` }));
    this.pins = h('div', { class: 'bpins' }, h('div', { class: 'bpins-in' }, ...this.dots));
    this.call = h('div', { class: 'callout bcall' });
    this.speed = h('div', { class: 'speed bspeed' });
    this.hint = h('div', { class: 'hint bhint' });
    this.turn = h('div', { class: 'bturn' });
    this.el = h('div', { class: 'hud bhud' }, this.card, this.pins, this.turn, this.call, this.speed, this.hint);
    this.update(0);
  }

  /** Redraw the scorecard; `current` = whose turn it is. */
  update(current: number) {
    clear(this.card);
    for (let i = 0; i < this.bowlers.length; i++) {
      const b = this.bowlers[i];
      const frames = b.score.frames();
      const row = h('div', { class: `brow ${i === current && !b.score.done ? 'on' : ''}`, style: `--c:${b.color}` }, h('div', { class: 'bname' }, h('i'), h('span', null, b.name)));
      for (let f = 0; f < 10; f++) {
        const fr = frames[f];
        const n = f === 9 ? 3 : 2;
        const cur = i === current && !b.score.done && b.score.frame === f;
        const rolls = h('div', { class: 'brolls' });
        for (let r = 0; r < n; r++) rolls.append(h('b', { class: fr?.rolls[r] === 'X' ? 'x' : fr?.rolls[r] === '/' ? 's' : '' }, fr?.rolls[r] ?? ''));
        row.append(h('div', { class: `bframe ${cur ? 'cur' : ''} ${f === 9 ? 'tenth' : ''}` }, h('div', { class: 'bfn' }, String(f + 1)), rolls, h('div', { class: 'btot' }, fr?.total != null ? String(fr.total) : '')));
      }
      row.append(h('div', { class: 'btotal' }, String(b.score.total())));
      this.card.append(row);
    }
  }

  /** Whose turn: a banner under the scorecard. */
  showTurn(b: Bowler, frame: number, ball: number) {
    clear(this.turn);
    this.turn.style.visibility = '';
    this.turn.style.setProperty('--c', b.color);
    this.turn.append(h('b', null, b.name), h('span', null, frame === 9 ? `10th frame · ball ${ball + 1}` : `Frame ${frame + 1}${ball ? ' · 2nd ball' : ''}`));
    replay(this.turn, 'show');
  }

  hideTurn() {
    this.turn.classList.remove('show');
    this.turn.style.visibility = 'hidden';
  }

  /** The pin diagram (null hides it). */
  setPins(standing: boolean[] | null) {
    this.pins.classList.toggle('on', !!standing);
    if (standing) this.dots.forEach((d, i) => d.classList.toggle('up', standing[i]));
  }

  say(text: string, sub = '', cls = '') {
    clear(this.call);
    this.call.className = `callout bcall ${cls}`;
    this.call.append(text);
    if (sub) this.call.append(h('span', { class: 'sub' }, sub));
    replay(this.call, 'show');
  }

  showSpeed(kph: number) {
    this.speed.textContent = `${Math.round(kph)} km/h`;
    replay(this.speed, 'show');
  }

  setHint(html: string) {
    if (html) this.hint.innerHTML = html;
    this.hint.classList.toggle('on', !!html);
  }
}
