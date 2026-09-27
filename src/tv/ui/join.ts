// "Grab your phone" panel: QR code, URL and the four player seats.

import { h, clear } from './dom';
import type { Input } from '../core/input';
import type { TVLink } from '../core/link';
import { avatarSvg } from '../../pad/avatar';
import { playerLook } from '../chars/look';
import { hashStr } from '../../shared/hash';

type SeatOf = NonNullable<Input['seats'][number]>;

/** the face the player will have in the game (as App.humanSpec builds it) */
function seatFace(s: SeatOf) {
  const d = playerLook(s.color, hashStr(s.pid ?? `local${s.slot}`));
  const L = s.look;
  return { skin: L?.skin ?? d.skin, hair: L?.hair ?? d.hair, hairColor: L?.hairColor ?? d.hairColor, eyes: L?.eyes ?? d.eyes, shirt: s.color };
}

export class JoinPanel {
  el: HTMLElement;
  private qr: HTMLImageElement;
  private url: HTMLElement;
  private seats: HTMLElement;
  private shownUrl = '';

  constructor(
    private link: TVLink,
    private input: Input,
    compact = false,
  ) {
    this.qr = h('img', { alt: 'Scan to join' });
    this.url = h('div', { class: 'url' }, '');
    this.seats = h('div', { class: 'seats' });
    this.el = h(
      'div',
      { class: 'join panel' + (compact ? ' compact' : '') },
      h(
        'div',
        { class: 'top' },
        h('div', { class: 'qr' }, this.qr),
        h(
          'div',
          null,
          h('h3', null, 'Grab your phone'),
          h('p', null, 'Scan with your iPhone camera, on this Mac’s Wi-Fi. The first time, a one-minute setup.'),
          this.url,
        ),
      ),
      this.seats,
    );
    this.refresh();
  }

  private seatSig = '';

  refresh() {
    const u = this.link.joinUrl;
    if (u && u !== this.shownUrl) {
      this.shownUrl = u;
      this.qr.src = `/api/qr.svg?dark=1d1c33&t=${Date.now()}`;
      // (the QR code opens the http join page, which sends the phone on to the https remote)
      this.url.textContent = u.replace(/^https?:\/\//, '');
    } else if (!u) {
      this.url.textContent = this.link.online ? 'No Wi-Fi address found' : 'Connecting to the KALEIDO server…';
    }
    const sig = [0, 1, 2, 3].map((i) => {
      const s = this.input.seats[i];
      return s ? `${s.name}|${s.connected}|${s.local}|${s.color}|${JSON.stringify(s.look ?? null)}` : '-';
    }).join(',');
    if (sig === this.seatSig) return;
    this.seatSig = sig;
    clear(this.seats);
    for (let i = 0; i < 4; i++) {
      const s = this.input.seats[i];
      const on = !!s && (s.connected || s.local);
      // a phone's player shows their face (the character they made, or the one they'll get)
      const face = s && !s.local ? h('i', { class: 'sface' }, avatarSvg(seatFace(s))) : h('b', null, `P${i + 1}`);
      const el = h(
        'div',
        { class: `seat ${on ? 'on' : ''} ${s && !s.connected && !s.local ? 'off' : ''}`, style: `--c:${s?.color ?? '#999'}` },
        face,
        h('span', { class: 'nm' }, s ? (s.local ? 'Mouse & keys' : s.connected ? s.name : `${s.name} (away)`) : 'Open'),
      );
      this.seats.append(el);
    }
  }
}
