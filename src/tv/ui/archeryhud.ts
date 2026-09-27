// Archery HUD: the scorecard (each end's arrows and the running total), the wind,
// whose turn it is, the reticle (where the arrow points, with the draw filling
// round it), and the calls (BULLSEYE! POP!).

import { h, clear, replay } from './dom';
import type { Archer } from '../archery/types';

export class ArcheryHud {
  el: HTMLElement;
  private card: HTMLElement;
  private wind: HTMLElement;
  private windArrow: HTMLElement;
  private windText: HTMLElement;
  private turn: HTMLElement;
  private call: HTMLElement;
  private hint: HTMLElement;
  private reticle: HTMLElement;
  private shown = false;

  constructor(
    private archers: Archer[],
    private ends: number,
  ) {
    this.card = h('div', { class: 'acard' });
    this.windArrow = h('i');
    this.windText = h('span');
    this.wind = h('div', { class: 'awind' }, h('b', null, 'WIND'), this.windArrow, this.windText);
    this.turn = h('div', { class: 'bturn aturn' });
    this.call = h('div', { class: 'callout acall' });
    this.hint = h('div', { class: 'hint ahint' });
    this.reticle = h('div', { class: 'areticle' }, h('i', { class: 'ring' }), h('i', { class: 'x' }), h('i', { class: 'y' }));
    this.el = h('div', { class: 'hud ahud' }, this.card, this.wind, this.reticle, this.turn, this.call, this.hint);
  }

  /** Redraw the scorecard: per archer, each end's arrows and totals. */
  update(scores: number[][], arrowsPerEnd: number, current: number) {
    clear(this.card);
    this.archers.forEach((a, i) => {
      const s = scores[i] ?? [];
      const row = h('div', { class: `arow ${i === current ? 'on' : ''}`, style: `--c:${a.color}` }, h('div', { class: 'bname' }, h('i'), h('span', null, a.name)));
      for (let e = 0; e < this.ends; e++) {
        const arrows = s.slice(e * arrowsPerEnd, (e + 1) * arrowsPerEnd);
        const sum = arrows.reduce((x, y) => x + y, 0);
        row.append(h('div', { class: 'aend' }, h('div', { class: 'aarrows' }, ...arrows.map((p) => h('b', { class: p >= 10 ? 'ten' : p === 0 ? 'miss' : '' }, p === 0 ? '·' : String(p)))), h('div', { class: 'atot' }, arrows.length ? String(sum) : '')));
      }
      row.append(h('div', { class: 'btotal' }, String(s.reduce((x, y) => x + y, 0))));
      this.card.append(row);
    });
  }

  /** The wind, m/s (+ = blowing to the right). */
  setWind(w: number) {
    this.windArrow.style.transform = `scaleX(${w >= 0 ? 1 : -1})`;
    this.windArrow.style.opacity = Math.abs(w) < 0.3 ? '0.25' : '1';
    this.windText.textContent = Math.abs(w) < 0.3 ? 'calm' : `${Math.abs(w).toFixed(1)} m/s`;
    this.wind.classList.toggle('strong', Math.abs(w) >= 3);
  }

  showTurn(a: Archer, end: number, arrow: number, arrows: number) {
    clear(this.turn);
    this.turn.style.setProperty('--c', a.color);
    this.turn.append(h('b', null, a.name), h('span', null, `End ${end} · arrow ${arrow} of ${arrows}`));
    replay(this.turn, 'show');
  }

  /** The reticle at (x, y) CSS pixels with the string drawn 0..1, or hidden. */
  setReticle(x: number, y: number, draw: number, on: boolean) {
    if (on !== this.shown) {
      this.shown = on;
      this.reticle.classList.toggle('on', on);
    }
    if (!on) return;
    this.reticle.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    this.reticle.style.setProperty('--d', Math.max(0, Math.min(1, draw)).toFixed(3));
    this.reticle.classList.toggle('full', draw >= 0.999);
  }

  say(text: string, sub = '', cls = '') {
    clear(this.call);
    this.call.className = `callout acall ${cls}`;
    this.call.append(text);
    if (sub) this.call.append(h('span', { class: 'sub' }, sub));
    replay(this.call, 'show');
  }

  setHint(html: string) {
    if (html) this.hint.innerHTML = html;
    this.hint.classList.toggle('on', !!html);
  }
}
