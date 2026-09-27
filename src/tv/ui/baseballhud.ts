// Baseball HUD: the derby board (each hitter's home runs and how their pitches
// went), whose turn it is, the pitch as it's thrown (kind and speed), the
// distance ticking up while a ball flies, how early or late each swing was
// (a little meter: EARLY ◀ ● ▶ LATE), and the calls (HOME RUN! FOUL. STRIKE).

import { h, clear, replay } from './dom';
import type { Hitter, Pitch, PitchKind, PitchOutcome } from '../baseball/types';

const KIND_NAME: Record<PitchKind, string> = { fastball: 'FASTBALL', curve: 'CURVEBALL', slider: 'SLIDER', changeup: 'CHANGEUP' };

/** The timing meter's reach either side of perfect, seconds. */
const METER_SPAN = 0.15;

export class BaseballHud {
  el: HTMLElement;
  private board: HTMLElement;
  private turn: HTMLElement;
  private pitchEl: HTMLElement;
  private dist: HTMLElement;
  private distNum: HTMLElement;
  private meter: HTMLElement;
  private meterDot: HTMLElement;
  private meterWord: HTMLElement;
  private call: HTMLElement;
  private hint: HTMLElement;
  private meterTimer = 0;
  private lastDist = -1;

  constructor(
    private hitters: Hitter[],
    private pitches: number,
  ) {
    this.board = h('div', { class: 'hrboard' });
    this.turn = h('div', { class: 'bturn hrturn' });
    this.pitchEl = h('div', { class: 'hrpitch' });
    this.distNum = h('b');
    this.dist = h('div', { class: 'hrdist' }, this.distNum, h('span', null, 'm'));
    this.meterDot = h('i', { class: 'dot' });
    this.meterWord = h('span', { class: 'word' });
    this.meter = h(
      'div',
      { class: 'hrmeter' },
      h('div', { class: 'track' }, h('em', null, 'EARLY'), h('i', { class: 'sweet' }), this.meterDot, h('em', null, 'LATE')),
      this.meterWord,
    );
    this.call = h('div', { class: 'callout hrcall' });
    this.hint = h('div', { class: 'hint hrhint' });
    this.el = h('div', { class: 'hud hrhud' }, this.board, this.dist, this.meter, this.pitchEl, this.turn, this.call, this.hint);
  }

  /** Redraw the board: per hitter, a pip per pitch (a home run, a hit, a foul, a strike, still to come) and their home runs. */
  update(log: { outcome: PitchOutcome; distance: number }[][], current: number, homeRuns: number[]) {
    clear(this.board);
    this.hitters.forEach((p, i) => {
      const mine = log[i] ?? [];
      const pips = h('div', { class: 'hrpips' });
      for (let k = 0; k < this.pitches; k++) {
        const o = mine[k];
        const cls = !o ? (i === current && k === mine.length ? 'next' : '') : o.outcome === 'homerun' ? 'hr' : o.outcome === 'hit' ? 'hit' : o.outcome === 'foul' ? 'foul' : 'k';
        pips.append(h('i', { class: cls, title: o && o.distance ? `${Math.round(o.distance)} m` : '' }));
      }
      const row = h('div', { class: `hrrow ${i === current ? 'on' : ''}`, style: `--c:${p.color}` }, h('div', { class: 'bname' }, h('i'), h('span', null, p.name)), pips, h('div', { class: 'hrtot' }, h('b', null, String(homeRuns[i] ?? 0)), h('span', null, 'HR')));
      this.board.append(row);
    });
  }

  showTurn(p: Hitter, pitches: number) {
    clear(this.turn);
    this.turn.style.visibility = '';
    this.turn.style.setProperty('--c', p.color);
    this.turn.append(h('b', null, p.name), h('span', null, `Up to bat · ${pitches} pitches`));
    replay(this.turn, 'show');
  }

  /** The count as the turn goes on. */
  setCount(p: Hitter, pitch: number, pitches: number) {
    clear(this.turn);
    this.turn.style.visibility = '';
    this.turn.style.setProperty('--c', p.color);
    this.turn.append(h('b', null, p.name), h('span', null, pitch <= pitches ? `Pitch ${pitch} of ${pitches}` : 'Last pitch done'));
  }

  hideTurn() {
    this.turn.classList.remove('show');
    this.turn.style.visibility = 'hidden';
  }

  /** The pitch as it leaves the hand: what it is and how fast. */
  showPitch(p: Pitch | null) {
    clear(this.pitchEl);
    if (!p) {
      this.pitchEl.classList.remove('on');
      return;
    }
    this.pitchEl.append(h('b', null, KIND_NAME[p.kind]), h('span', null, `${Math.round(p.kmh)} km/h`));
    this.pitchEl.classList.add('on');
    replay(this.pitchEl, 'pop');
  }

  /** The distance so far (real metres), or null to hide it; `hr` turns it gold. */
  setDistance(m: number | null, hr = false) {
    if (m === null) {
      if (this.lastDist >= 0) this.dist.classList.remove('on', 'hr');
      this.lastDist = -1;
      return;
    }
    const r = Math.round(m);
    if (r !== this.lastDist) {
      this.distNum.textContent = String(r);
      this.lastDist = r;
    }
    this.dist.classList.add('on');
    this.dist.classList.toggle('hr', hr);
  }

  /** How early (−) or late (+) a swing was, seconds; `contact` if it met the ball. */
  showTiming(e: number, contact: boolean) {
    const u = Math.max(-1, Math.min(1, e / METER_SPAN));
    this.meterDot.style.left = `${(50 + u * 50).toFixed(1)}%`;
    const ms = Math.round(Math.abs(e) * 1000);
    this.meterWord.textContent = ms <= 25 ? 'PERFECT TIMING' : ms > METER_SPAN * 1000 ? (e < 0 ? 'WAY TOO EARLY' : 'WAY TOO LATE') : `${ms} ms ${e < 0 ? 'early' : 'late'}`;
    this.meter.classList.toggle('perfect', ms <= 25);
    this.meter.classList.toggle('miss', !contact);
    this.meter.classList.add('on');
    replay(this.meterDot, 'pop');
    window.clearTimeout(this.meterTimer);
    this.meterTimer = window.setTimeout(() => this.meter.classList.remove('on'), 2400);
  }

  say(text: string, sub = '', cls = '') {
    clear(this.call);
    this.call.className = `callout hrcall ${cls}`;
    this.call.append(text);
    if (sub) this.call.append(h('span', { class: 'sub' }, sub));
    replay(this.call, 'show');
  }

  setHint(html: string) {
    if (html) this.hint.innerHTML = html;
    this.hint.classList.toggle('on', !!html);
  }

  dispose() {
    window.clearTimeout(this.meterTimer);
    this.el.remove();
  }
}
