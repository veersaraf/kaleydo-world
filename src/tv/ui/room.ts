// Online rooms, the guest's side: typing a friend's room code, and the lobby
// this TV sits in once it has joined that room (its own phones scan the QR code
// on this screen and join the HOST directly; the host runs the match).

import { h, clear } from './dom';
import type { Btn } from '../core/input';
import { ROOM_CHARS, type TVLink } from '../core/link';
import type { ServerToTV } from '../../shared/protocol';

const LEN = 5;

/** The 5-character room code, entered with the keyboard (type, Backspace, Enter, Esc, paste) or the pad (◀ ▶ move, ▲ ▼ change the letter, A next / join, B back, − delete). */
export class CodeEntry {
  el: HTMLElement;
  /** the code was completed and confirmed */
  onSubmit: (code: string) => void = () => {};
  onBack: () => void = () => {};
  /** a sound cue (the flow plays it) */
  onSound: (kind: 'move' | 'select' | 'back' | 'error') => void = () => {};
  private chars: string[] = Array(LEN).fill('');
  private cur = 0;
  private cells: HTMLElement[] = [];
  private msg: HTMLElement;
  private go: HTMLElement;
  private attached = false;
  private keyFn = (e: KeyboardEvent) => this.key(e);
  private pasteFn = (e: ClipboardEvent) => this.paste(e);

  constructor() {
    const row = h('div', { class: 'rcells' });
    for (let i = 0; i < LEN; i++) {
      const c = h('div', { class: 'rcell' }, h('b'));
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cur = i;
        this.draw();
      });
      this.cells.push(c);
      row.append(c);
    }
    this.msg = h('div', { class: 'rmsg' });
    this.go = h('div', { class: 'row go' }, 'Join room');
    this.go.addEventListener('click', (e) => {
      e.stopPropagation();
      this.submit();
    });
    this.el = h(
      'div',
      { class: 'screen center joincode' },
      h(
        'div',
        { class: 'sheet panel' },
        h('h2', null, 'Join a room'),
        h('p', { class: 'lead' }, 'Type the 5-letter code on your friend’s screen. Your phones then scan the code on yours to play in their game.'),
        row,
        this.msg,
        this.go,
        h('div', { class: 'rhint' }, 'Type it · or ◀ ▶ move · ▲ ▼ letter · A next · B back'),
      ),
    );
    this.draw();
  }

  /** listen to the keyboard (the flow calls this when the screen is up, and detach when it goes) */
  attach() {
    if (this.attached) return;
    this.attached = true;
    // (capture: ahead of the game's own keys — W A S D are letters here)
    window.addEventListener('keydown', this.keyFn, true);
    window.addEventListener('paste', this.pasteFn, true);
  }

  detach() {
    this.attached = false;
    window.removeEventListener('keydown', this.keyFn, true);
    window.removeEventListener('paste', this.pasteFn, true);
  }

  get code() {
    return this.chars.join('');
  }

  get complete() {
    return this.chars.every(Boolean);
  }

  /** show why the last try didn't work */
  error(text: string) {
    this.msg.textContent = text;
    this.msg.classList.toggle('bad', !!text);
    this.onSound('error');
  }

  clear() {
    this.chars = Array(LEN).fill('');
    this.cur = 0;
    this.error('');
    this.draw();
  }

  private draw() {
    this.cells.forEach((c, i) => {
      c.firstElementChild!.textContent = this.chars[i];
      c.classList.toggle('cur', i === this.cur);
      c.classList.toggle('full', !!this.chars[i]);
    });
    this.go.classList.toggle('dim', !this.complete);
    if (this.msg.classList.contains('bad')) return;
    this.msg.textContent = this.complete ? 'Press Enter or A to join' : '';
  }

  private put(ch: string) {
    this.chars[this.cur] = ch;
    this.cur = Math.min(LEN - 1, this.cur + 1);
    this.msg.classList.remove('bad');
    this.draw();
  }

  private back() {
    if (this.chars[this.cur]) this.chars[this.cur] = '';
    else if (this.cur > 0) this.chars[--this.cur] = '';
    this.msg.classList.remove('bad');
    this.draw();
  }

  private submit() {
    if (!this.complete) {
      this.error('That’s ' + LEN + ' letters or numbers');
      return;
    }
    this.onSound('select');
    this.onSubmit(this.code);
  }

  private key(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let used = true;
    if (k.length === 1 && ROOM_CHARS.includes(k.toUpperCase())) this.put(k.toUpperCase());
    else if (k === 'Backspace') this.back();
    else if (k === 'Enter') this.submit();
    else if (k === 'Escape') this.onBack();
    else if (k === 'ArrowLeft') this.move(-1);
    else if (k === 'ArrowRight') this.move(1);
    else if (k === 'ArrowUp') this.cycle(-1);
    else if (k === 'ArrowDown') this.cycle(1);
    else used = false;
    if (used) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private paste(e: ClipboardEvent) {
    const t = (e.clipboardData?.getData('text') || '').toUpperCase();
    const cs = [...t].filter((c) => ROOM_CHARS.includes(c)).slice(0, LEN);
    if (!cs.length) return;
    e.preventDefault();
    this.chars = [...cs, ...Array(LEN).fill('')].slice(0, LEN);
    this.cur = Math.min(LEN - 1, cs.length);
    this.msg.classList.remove('bad');
    this.draw();
  }

  private move(d: number) {
    const n = Math.max(0, Math.min(LEN - 1, this.cur + d));
    if (n !== this.cur) this.onSound('move');
    this.cur = n;
    this.draw();
  }

  private cycle(d: number) {
    const i = ROOM_CHARS.indexOf(this.chars[this.cur]);
    const n = (i < 0 ? (d > 0 ? 0 : ROOM_CHARS.length - 1) : (i + d + ROOM_CHARS.length) % ROOM_CHARS.length) | 0;
    this.chars[this.cur] = ROOM_CHARS[n];
    this.msg.classList.remove('bad');
    this.onSound('move');
    this.draw();
  }

  /** the pad */
  input(b: Btn) {
    if (b === 'left') this.move(-1);
    else if (b === 'right') this.move(1);
    else if (b === 'up') this.cycle(-1);
    else if (b === 'down') this.cycle(1);
    else if (b === 'minus') this.back();
    else if (b === 'b') {
      this.onSound('back');
      this.onBack();
    } else if (b === 'a' || b === 'plus') {
      if (this.complete) this.submit();
      else {
        const next = this.chars.findIndex((c, i) => !c && i >= this.cur);
        this.cur = next >= 0 ? next : Math.max(0, this.chars.findIndex((c) => !c));
        this.onSound('select');
        this.draw();
      }
    }
  }
}

type LobbyState = 'joining' | 'in' | 'hostgone' | 'noroom';

/**
 * The guest lobby: which room this TV is in, who's there, and the QR code its own
 * phones scan (the flow puts the join panel on this screen). It stays until the host
 * starts a match; the match stream's code then takes the screen with `hide()`, and
 * calls `show()` when the match is over.
 */
export class GuestLobby {
  el: HTMLElement;
  /** B / leave: the flow takes this TV back to hosting its own room */
  onLeave: () => void = () => {};
  /** A after "No room with that code": type another */
  onRetry: () => void = () => {};
  /** the flow: put this lobby back on the screen / take it off (a match takes over) */
  onShow: () => void = () => {};
  onHide: () => void = () => {};
  state: LobbyState = 'joining';
  private dead: 'hostgone' | 'noroom' | null = null;
  private head: HTMLElement;
  private sub: HTMLElement;
  private roster: HTMLElement;
  private status: HTMLElement;
  private sig = '';

  constructor(
    private link: TVLink,
    readonly code: string,
  ) {
    this.head = h('div', { class: 'lhead' });
    this.sub = h('div', { class: 'lsub' });
    this.roster = h('div', { class: 'lroster' });
    this.status = h('div', { class: 'lstatus' });
    this.el = h('div', { class: 'screen lobby' }, h('div', { class: 'sheet panel' }, this.head, this.sub, this.roster, this.status, h('div', { class: 'rhint' }, 'B — leave the room')));
    this.render(true);
  }

  /** put the lobby on the screen (the match is over) */
  show() {
    this.onShow();
  }

  /** take the lobby off the screen (a match is starting) */
  hide() {
    this.onHide();
  }

  /** the relay's word about the room (the flow forwards every message this TV gets) */
  message(m: ServerToTV) {
    if (m.type === 'no-room') this.dead = 'noroom';
    else if (m.type === 'host-gone') this.dead = 'hostgone';
    this.render();
  }

  /** the pad / keyboard on the lobby's screen */
  input(b: Btn) {
    if (b === 'b') this.onLeave();
    else if (b === 'a') {
      if (this.state === 'noroom') this.onRetry();
      else if (this.state === 'hostgone') this.onLeave();
    }
  }

  /** every frame the lobby is up: follow the link's roster */
  update() {
    this.render();
  }

  private render(force = false) {
    const L = this.link;
    if (this.dead === 'hostgone' && L.roster) this.dead = null; // (it came back)
    this.state = this.dead ?? (L.roster ? 'in' : 'joining');
    const R = L.roster;
    const me = L.guestId();
    const sig = JSON.stringify([this.state, this.code, R, L.online]);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.el.className = `screen lobby ${this.state}`;
    clear(this.head);
    clear(this.sub);
    clear(this.roster);
    if (this.state === 'noroom') {
      this.head.append('No room with that code');
      this.sub.append(`Nobody is hosting ${this.code} right now. Check the letters with your friend.`);
      this.status.textContent = 'A — try another code';
      return;
    }
    this.head.append('You’re in room ', h('span', { class: 'rcode' }, this.code));
    if (this.state === 'hostgone') {
      this.sub.append('The host left the room.');
      this.status.textContent = 'A — back to your own room';
      return;
    }
    if (this.state === 'joining') {
      this.sub.append(L.online ? 'Joining…' : 'Connecting…');
      this.status.textContent = 'Waiting for the host…';
      return;
    }
    this.sub.append(R?.host ? `with ${R.host}` : 'with the host');
    const pads = R?.pads ?? [];
    const guests = R?.guests ?? [];
    this.roster.append(
      h('div', { class: 'lcol' }, h('h4', null, pads.length ? `Phones (${pads.length})` : 'Phones'), ...(pads.length ? pads.map((p) => h('div', { class: 'lp', style: `--c:${p.color ?? '#9aa'}` }, h('i'), h('span', null, p.name), p.slot !== undefined ? h('small', null, `P${p.slot + 1}`) : null)) : [h('div', { class: 'lnone' }, 'None yet — scan the code with your phone')])),
      h('div', { class: 'lcol' }, h('h4', null, `TVs (${guests.length + 1})`), h('div', { class: 'lp tv' }, h('i'), h('span', null, R?.host ? `${R.host}’s TV` : 'Host'), h('small', null, 'host')), ...guests.map((g) => h('div', { class: 'lp tv' }, h('i'), h('span', null, g.name), h('small', null, g.gid === me ? 'you' : '')))),
    );
    this.status.textContent = 'Waiting for the host to start…';
  }
}
