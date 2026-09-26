// A navigable list (d-pad / arrows / mouse) used by every menu screen.

import type { Btn } from '../core/input';

export interface NavItem {
  el: HTMLElement;
  onSelect?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  disabled?: boolean;
}

export class Nav {
  index = 0;
  onMove: () => void = () => {};
  onChange: (i: number) => void = () => {};

  constructor(
    public items: NavItem[],
    public horizontal = false,
  ) {
    items.forEach((it, i) => {
      it.el.addEventListener('pointermove', () => this.index !== i && this.focus(i));
      it.el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.focus(i);
        if (!it.disabled) it.onSelect?.();
      });
    });
    this.focus(Math.max(0, items.findIndex((i) => !i.disabled)));
  }

  focus(i: number) {
    if (i < 0 || i >= this.items.length) return;
    const changed = i !== this.index;
    this.index = i;
    this.items.forEach((it, j) => it.el.classList.toggle('focus', j === i));
    if (changed) {
      this.onMove();
      this.onChange(i);
    }
  }

  get current() {
    return this.items[this.index];
  }

  /** Returns true if the button was consumed. */
  input(b: Btn): boolean {
    const prev = this.horizontal ? 'left' : 'up';
    const next = this.horizontal ? 'right' : 'down';
    if (b === prev || b === next) {
      const d = b === prev ? -1 : 1;
      let i = this.index;
      for (let k = 0; k < this.items.length; k++) {
        i = (i + d + this.items.length) % this.items.length;
        if (!this.items[i].disabled) break;
      }
      this.focus(i);
      return true;
    }
    if (!this.horizontal && (b === 'left' || b === 'right')) {
      const it = this.current;
      const f = b === 'left' ? it.onLeft : it.onRight;
      if (f) {
        f();
        this.onMove();
        return true;
      }
      return false;
    }
    if (b === 'a') {
      if (!this.current.disabled) this.current.onSelect?.();
      return true;
    }
    return false;
  }
}
