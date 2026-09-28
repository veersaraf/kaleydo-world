// In-match heads-up display: scorebug, callouts, hints, timing feedback.

import { h, replay } from './dom';
import type { Match, MatchEvent } from '../tennis/match';
import type { CameraRig } from '../tennis/camera';
import type { WorldDef } from '../worlds/base';

export interface TeamInfo {
  name: string;
  color: string;
}

export class Hud {
  el: HTMLElement;
  private bug: HTMLElement;
  private rows: { nm: HTMLElement; sv: HTMLElement; g: HTMLElement; p: HTMLElement }[] = [];
  private callout: HTMLElement;
  private banner: HTMLElement;
  private hint: HTMLElement;
  private rally: HTMLElement;
  private speed: HTMLElement;
  private floats: HTMLElement;
  private hintText = '';
  /** split screen: one camera per half (team 0 left, team 1 right) */
  private views: { rig: CameraRig; x: number; w: number; team: number }[] | null = null;
  private divider: HTMLElement;
  private tags: HTMLElement[];
  // name tags over the players and the "Server" badge (Switch Sports-style)
  private tagLayer: HTMLElement;
  private nameEls: HTMLElement[][] = [];
  private badgeEls: HTMLElement[] = [];
  private tagShow = 0;
  private badgeText = '';
  private calloutQueue: { text: string; sub?: string; cls?: string; at: number }[] = [];
  private calloutUntil = 0;
  private time = 0;
  // the smash: the world dims, a reticle closes on the ball, SMASH! pulses up top;
  // at contact, speed lines and the speed of it, big
  private smDim: HTMLElement;
  private smRet: HTMLElement;
  private smRetCue: HTMLElement;
  private smTitle: HTMLElement;
  private smHit: HTMLElement;
  private smHitWord: HTMLElement;
  private smHitKph: HTMLElement;
  private smLines: HTMLElement;
  private smOn = false;

  constructor(
    private teams: [TeamInfo, TeamInfo],
    private rig: CameraRig,
  ) {
    this.bug = h('div', { class: 'scorebug' });
    for (let i = 0; i < 2; i++) {
      const sv = h('i', { class: 'sv' });
      const nm = h('div', { class: 'nm', style: `--c:${teams[i].color}` }, h('i'), h('span', null, teams[i].name), sv);
      const g = h('div', { class: 'g' }, '0');
      const p = h('div', { class: 'p' }, '0');
      this.bug.append(nm, g, p);
      this.rows.push({ nm, sv, g, p });
    }
    this.callout = h('div', { class: 'callout' });
    this.banner = h('div', { class: 'banner' });
    this.hint = h('div', { class: 'hint' });
    this.rally = h('div', { class: 'rally' }, h('b', null, '0'), h('span', null, 'RALLY'));
    this.speed = h('div', { class: 'speed' });
    this.floats = h('div', { class: 'layer' });
    this.divider = h('div', { class: 'split-divider' });
    this.tags = [0, 1].map((i) => h('div', { class: `split-tag t${i}`, style: `--c:${teams[i].color}` }, teams[i].name));
    this.tagLayer = h('div', { class: 'layer ptags' });
    this.smDim = h('div', { class: 'sm-dim' });
    this.smRetCue = h('b', null, 'SWING!');
    this.smRet = h('div', { class: 'sm-ret' }, h('i', { class: 'r1' }), h('i', { class: 'r2' }), h('i', { class: 'tk' }), this.smRetCue);
    this.smTitle = h('div', { class: 'sm-title' }, h('b', null, 'SMASH!'), h('span', null, 'swing hard as the ring closes'));
    this.smLines = h('div', { class: 'sm-lines' });
    this.smHitWord = h('b', null, 'SMASH!');
    this.smHitKph = h('span', null, '');
    this.smHit = h('div', { class: 'sm-hit' }, this.smHitWord, this.smHitKph);
    this.el = h(
      'div',
      { class: 'hud' },
      this.smDim,
      this.smLines,
      this.divider,
      ...this.tags,
      this.tagLayer,
      this.bug,
      this.smRet,
      this.floats,
      this.callout,
      this.banner,
      this.hint,
      this.rally,
      this.speed,
      this.smTitle,
      this.smHit,
    );
  }

  /**
   * Every frame of a match: names over everyone while a point is set up, and a
   * badge by the server's feet saying what to do (fades once the rally starts).
   */
  track(m: Match, dt: number, serveHint: string) {
    const setup = m.state === 'serve' || m.state === 'intro' || m.state === 'reset';
    this.tagShow += ((setup ? 1 : 0) - this.tagShow) * Math.min(1, dt * (setup ? 8 : 5));
    const views = this.views ?? [{ rig: this.rig, x: 0, w: 1, team: -1 }];
    for (let vi = 0; vi < views.length; vi++) {
      const v = views[vi];
      const els = (this.nameEls[vi] ??= []);
      m.players.forEach((p, i) => {
        let el = els[i];
        if (!el) {
          el = els[i] = h('div', { class: 'ptag', style: `--c:${this.teams[p.team].color}` }, p.name);
          this.tagLayer.append(el);
        }
        const pr = v.rig.project({ x: p.x, y: 2.2 * (p.look.height || 1), z: p.z });
        const on = this.tagShow > 0.02 && !pr.behind && pr.x > 0.02 && pr.x < 0.98 && pr.y > 0.02;
        el.style.display = on ? '' : 'none';
        if (on) {
          el.style.left = `${((v.x + pr.x * v.w) * 100).toFixed(2)}%`;
          el.style.top = `${(pr.y * 100).toFixed(2)}%`;
          el.style.opacity = this.tagShow.toFixed(2);
        }
      });
      let badge = this.badgeEls[vi];
      if (!badge) {
        badge = this.badgeEls[vi] = h('div', { class: 'sbadge' }, h('b', null, 'Server'), h('span'));
        this.tagLayer.append(badge);
      }
      const srv = m.server;
      const bp = srv ? v.rig.project({ x: srv.x + 0.55, y: 0.25, z: srv.z }) : null;
      const bon = !!srv && !!bp && m.state === 'serve' && !bp.behind && bp.x > 0.02 && bp.x < 0.98;
      badge.style.display = bon ? '' : 'none';
      if (bon && bp) {
        badge.style.left = `${((v.x + bp.x * v.w) * 100).toFixed(2)}%`;
        badge.style.top = `${(bp.y * 100).toFixed(2)}%`;
        badge.style.setProperty('--c', this.teams[srv.team].color);
        const hint = srv.human ? serveHint : '';
        if (hint !== this.badgeText) {
          this.badgeText = hint;
          for (const b of this.badgeEls) (b.lastChild as HTMLElement).textContent = hint;
        }
      }
    }
  }

  /** Switch between one full-screen view and two side-by-side ones. */
  setSplit(rig2: CameraRig | null) {
    this.views = rig2
      ? [
          { rig: this.rig, x: 0, w: 0.5, team: 0 },
          { rig: rig2, x: 0.5, w: 0.5, team: 1 },
        ]
      : null;
    this.el.classList.toggle('split', !!rig2);
  }

  showBanner(def: WorldDef, vs: string) {
    this.banner.innerHTML = '';
    this.banner.append(
      h('div', { class: 'wn', style: `font-family:${def.ui.display}` }, def.name),
      h('div', { class: 'wt' }, def.tagline),
      h('div', { class: 'vsline' }, vs),
    );
    replay(this.banner, 'show');
  }

  setScore(m: Match) {
    const s = m.score;
    for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
      const r = this.rows[i];
      const pt = s.pointText(i);
      if (r.p.textContent !== pt) {
        r.p.textContent = pt;
        replay(r.p, 'bump');
      }
      r.g.textContent = String(s.games[i]);
      r.sv.classList.toggle('on', s.server === i);
      if (i === 1) break;
    }
  }

  /** Queue a big centre callout. */
  say(text: string, sub?: string, cls = '', delay = 0) {
    this.calloutQueue.push({ text, sub, cls, at: this.time + delay });
  }

  setHint(html: string, color?: string) {
    if (html === this.hintText) return;
    this.hintText = html;
    if (html) {
      this.hint.innerHTML = html;
      if (color) this.hint.style.setProperty('--c', color);
    }
    this.hint.classList.toggle('on', !!html);
  }

  /** Pop some text over a point in the world. With a split screen, `team`
   *  picks whose view it belongs to (default: every view that can see it). */
  float(text: string, world: { x: number; y: number; z: number }, cls = '', team?: number) {
    const views = this.views ?? [{ rig: this.rig, x: 0, w: 1, team: -1 }];
    for (const v of views) {
      if (team !== undefined && v.team >= 0 && v.team !== team) continue;
      const p = v.rig.project(world);
      if (p.behind || p.x < 0.04 || p.x > 0.96) continue;
      const el = h('div', { class: `float ${cls}`, style: `left:${((v.x + p.x * v.w) * 100).toFixed(2)}%;top:${(p.y * 100).toFixed(2)}%` }, text);
      this.floats.append(el);
      setTimeout(() => el.remove(), 1200);
    }
  }

  /** the view (whole screen, or a split-screen half) a team's player watches */
  private viewOf(team: number) {
    const views = this.views ?? [{ rig: this.rig, x: 0, w: 1, team: -1 }];
    return views.find((v) => v.team === team) ?? views[0];
  }

  /**
   * Every frame: a human's smash chance being staged (null when there's none).
   * `tl` is the sim time to contact, `w` the build-up 0..1, `ball` where it is.
   */
  smashFrame(cue: { team: number; tl: number; w: number; ball: { x: number; y: number; z: number }; hint: string } | null) {
    const on = !!cue && cue.w > 0.03;
    if (on !== this.smOn) {
      this.smOn = on;
      this.el.classList.toggle('smashing', on);
      if (on) {
        replay(this.smTitle, 'show');
        (this.smTitle.lastChild as HTMLElement).textContent = cue!.hint;
      } else this.smTitle.classList.remove('show');
    }
    if (!cue || !on) {
      this.smDim.style.opacity = '0';
      this.smRet.style.display = 'none';
      return;
    }
    const v = this.viewOf(cue.team);
    this.smDim.style.left = `${v.x * 100}%`;
    this.smDim.style.width = `${v.w * 100}%`;
    this.smDim.style.opacity = (cue.w * 0.95).toFixed(3);
    const p = v.rig.project(cue.ball);
    if (p.behind || p.y < -0.2) {
      this.smRet.style.display = 'none';
      return;
    }
    this.smRet.style.display = 'block';
    // the ring closes on the ball as contact comes: swing as it meets it
    const close = Math.min(1, Math.max(0, cue.tl / 1.1));
    const scale = 0.7 + close * 2.4;
    const hot = cue.tl < 0.32;
    this.smRet.style.left = `${((v.x + Math.min(0.98, Math.max(0.02, p.x)) * v.w) * 100).toFixed(2)}%`;
    this.smRet.style.top = `${(Math.min(0.97, Math.max(0.03, p.y)) * 100).toFixed(2)}%`;
    this.smRet.style.setProperty('--s', scale.toFixed(3));
    this.smRet.style.setProperty('--spin', `${(this.time * 140) % 360}deg`);
    this.smRet.style.opacity = Math.min(1, cue.w * 1.4).toFixed(3);
    this.smRet.classList.toggle('hot', hot);
    this.smRetCue.style.opacity = hot && cue.tl > -0.1 ? '1' : '0';
  }

  /** The smash lands on the racket: speed lines, a flash of the word, the speed. */
  smashHit(kph: number, perfect: boolean, at: { x: number; y: number; z: number }, team: number, mine: boolean) {
    const v = this.viewOf(team);
    const p = v.rig.project(at);
    const x = v.x + (p.behind ? 0.5 : Math.min(0.9, Math.max(0.1, p.x))) * v.w;
    const y = p.behind ? 0.45 : Math.min(0.85, Math.max(0.15, p.y));
    this.smLines.style.setProperty('--y', `${(y * 100).toFixed(1)}%`);
    this.smLines.style.left = `${v.x * 100}%`;
    this.smLines.style.width = `${v.w * 100}%`;
    this.smLines.style.setProperty('--x', `${(((x - v.x) / v.w) * 100).toFixed(1)}%`);
    this.smLines.classList.toggle('lite', !mine);
    replay(this.smLines, 'show');
    this.smHitWord.textContent = !mine ? 'SMASH' : perfect ? 'PERFECT SMASH!' : 'SMASH!';
    this.smHitKph.textContent = `${Math.round(kph)} km/h`;
    this.smHit.style.left = `${((v.x + v.w * 0.5) * 100).toFixed(2)}%`;
    this.smHit.classList.toggle('lite', !mine);
    this.smHit.classList.toggle('perfect', perfect && mine);
    replay(this.smHit, 'show');
    this.el.classList.remove('smash-kick');
    void this.el.offsetWidth;
    if (mine) this.el.classList.add('smash-kick');
  }

  private labEl: HTMLElement | null = null;

  /** Swing Lab read-out: rows of [label, value, bar 0..1 | undefined]. */
  setLab(title: string, rows: [string, string, number?][] | null, note = '') {
    if (!rows) {
      this.labEl?.remove();
      this.labEl = null;
      return;
    }
    if (!this.labEl) {
      this.labEl = h('div', { class: 'lab panel' });
      this.el.append(this.labEl);
      this.bug.style.display = 'none';
    }
    this.labEl.innerHTML = '';
    this.labEl.append(h('div', { class: 'lab-title' }, title));
    for (const [k, v, bar] of rows) {
      const row = h('div', { class: 'lab-row' }, h('span', null, k), h('b', null, v));
      if (bar !== undefined) row.append(h('i', { class: 'lab-bar', style: `--v:${Math.max(0, Math.min(1, bar))}` }));
      this.labEl.append(row);
    }
    if (note) this.labEl.append(h('div', { class: 'lab-note' }, note));
    replay(this.labEl, 'pulse-in');
  }

  private replayEl: HTMLElement | null = null;

  setReplay(on: boolean) {
    if (on && !this.replayEl) {
      this.replayEl = h('div', { class: 'replay' }, h('div', { class: 'bar top' }), h('div', { class: 'bar bot' }), h('div', { class: 'badge' }, h('i'), 'REPLAY'), h('div', { class: 'skip' }, 'A · skip'));
      this.el.append(this.replayEl);
      this.bug.style.opacity = '0';
    } else if (!on && this.replayEl) {
      const r = this.replayEl;
      r.classList.add('out');
      setTimeout(() => r.remove(), 400);
      this.replayEl = null;
      this.bug.style.opacity = '';
    }
  }

  private quoteEl: HTMLElement | null = null;
  private typing = 0;

  /** Champion speech bubble with typewriter text; onChar fires per letter (for voice blips). */
  showQuote(name: string, title: string, quote: string, color: string, onChar: (ch: string) => void) {
    this.hideQuote();
    const text = h('div', { class: 'qtext' });
    this.quoteEl = h('div', { class: 'quote', style: `--c:${color}` }, h('div', { class: 'qname' }, h('b', null, name), h('span', null, title)), text);
    this.el.append(this.quoteEl);
    let i = 0;
    clearInterval(this.typing);
    this.typing = window.setInterval(() => {
      if (i >= quote.length) {
        clearInterval(this.typing);
        return;
      }
      const ch = quote[i++];
      text.textContent = quote.slice(0, i);
      if (/[a-z0-9]/i.test(ch)) onChar(ch);
    }, 34);
  }

  hideQuote() {
    clearInterval(this.typing);
    if (this.quoteEl) {
      const q = this.quoteEl;
      q.classList.add('out');
      setTimeout(() => q.remove(), 300);
      this.quoteEl = null;
    }
  }

  showSpeed(kph: number) {
    this.speed.textContent = `${Math.round(kph)} km/h`;
    replay(this.speed, 'show');
  }

  setRally(n: number) {
    const on = n >= 4;
    this.rally.classList.toggle('on', on);
    const b = this.rally.querySelector('b')!;
    if (b.textContent !== String(n)) {
      b.textContent = String(n);
      if (on) replay(this.rally, 'bump');
    }
  }

  update(dt: number) {
    this.time += dt;
    if (this.calloutQueue.length && this.time >= this.calloutUntil && this.calloutQueue[0].at <= this.time) {
      const c = this.calloutQueue.shift()!;
      this.callout.className = 'callout ' + (c.cls || '');
      this.callout.innerHTML = '';
      this.callout.append(c.text);
      if (c.sub) this.callout.append(h('span', { class: 'sub' }, c.sub));
      replay(this.callout, 'show');
      this.calloutUntil = this.time + (c.cls?.includes('quick') ? 0.9 : 1.5);
    }
  }

  clearCallouts() {
    this.calloutQueue.length = 0;
  }

  onEvent(_e: MatchEvent) {}
}
