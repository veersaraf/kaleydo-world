// Quick match, the waiting screen: "Looking for an opponent… 0:07" while the lobby has no one, then
// "Found <name>! Waiting for their phone…" once it has. The flow feeds it what the lobby says.

import { h, clear } from './dom';

export type QuickState =
  | { kind: 'search'; n: number }
  | { kind: 'found'; name: string }
  /** a rematch: the same opponent, waiting for their phone to be at the table again */
  | { kind: 'again'; name: string };

export class QuickPanel {
  el: HTMLElement;
  state: QuickState = { kind: 'search', n: 1 };
  private head: HTMLElement;
  private timer: HTMLElement;
  private sub: HTMLElement;
  private phones: HTMLElement;
  private t0 = performance.now();
  private sig = '';
  private tsig = '';

  /** phonesOf: this TV's seated phones (name, colour) */
  constructor(private phonesOf: () => { name: string; color: string }[]) {
    this.head = h('div', { class: 'qhead' });
    this.timer = h('div', { class: 'qtimer' });
    this.sub = h('div', { class: 'qsub' });
    this.phones = h('div', { class: 'qphones' });
    // (a radar: rings go out from the middle while it looks)
    this.el = h('div', { class: 'screen pausemenu quick' }, h('div', { class: 'sheet' }, h('div', { class: 'qradar' }, h('i'), h('i'), h('i'), h('b')), this.head, this.timer, this.sub, this.phones, h('div', { class: 'rhint' }, 'B cancel')));
    this.update();
  }

  set(state: QuickState) {
    if (state.kind !== this.state.kind) this.t0 = performance.now();
    this.state = state;
    this.update();
  }

  /** every frame: the clock, and the roster of phones if it changed */
  update() {
    const s = this.state;
    const sec = Math.floor((performance.now() - this.t0) / 1000);
    const tsig = `${s.kind}|${sec}`;
    if (tsig !== this.tsig) {
      this.tsig = tsig;
      this.timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      this.timer.style.display = s.kind === 'search' ? '' : 'none';
    }
    const ph = this.phonesOf();
    const sig = JSON.stringify([s, ph]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.className = `screen pausemenu quick ${s.kind}`;
    this.head.textContent = s.kind === 'search' ? 'Looking for an opponent…' : `Found ${s.name}!`;
    this.sub.textContent = s.kind === 'search' ? (s.n > 1 ? `${s.n} TVs waiting` : 'Waiting for someone to press Quick match') : s.kind === 'found' ? 'Waiting for their phone…' : 'Waiting for their phone to come back…';
    clear(this.phones);
    for (const p of ph) this.phones.append(h('div', { class: 'lp', style: `--c:${p.color}` }, h('i'), h('span', null, p.name)));
  }
}
