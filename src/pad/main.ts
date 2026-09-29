import './roomgate';
import { LiftDetector } from './lift';
import '@fontsource/fredoka/latin-400.css';
import '@fontsource/fredoka/latin-600.css';
import '@fontsource/fredoka/latin-700.css';
import './pad.css';

import { PadLink, type LinkStatus } from './link';
import { SwingDetector, type SwingEvent } from './swing';
import { BowlDetector, swipeThrow, MIN_SPEED, MAX_SPEED, type BowlThrow, type SwipePoint } from './bowl';
import { SwordDetector, swipeStrike, guardLine, type GuardLine, type SwordStrike } from './sword';
import { qrot, type Vec3 } from './orient';
import { MotionFront, rawMotion, swordSample, swingSample } from './pipeline';
import { Recorder, captureName } from './capture';
import { PadAudio } from './audio';
import { keepPortrait, toDevice } from './portrait';
import { haptic } from './haptic';
import type { Handed, LookPrefs, PadButton, PadFx, PadMode, PadMsg, ServerToPad } from '../shared/protocol';
import { HAIRS, HAIR_NAMES, EYES, SKIN_TONES, HAIR_TONES } from '../shared/protocol';
import { hashStr } from '../shared/hash';
import { playerLook } from '../tv/chars/look';
import { avatarSvg } from './avatar';
import { PLAYER_COLORS } from '../shared/protocol';

// ------------------------------------------------------------------ prefs

const store = {
  get(k: string, d = '') {
    try {
      return localStorage.getItem('kaleido.' + k) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem('kaleido.' + k, v);
    } catch {}
  },
};

function uuid() {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// One remote per tab: a reloaded tab keeps its id (and its player slot); a
// second tab on the same phone gets a fresh one.
function choosePid(): string {
  try {
    const mine = sessionStorage.getItem('kaleido.tabpid');
    if (mine) return mine;
  } catch {}
  let id = store.get('pid');
  const lock = Number(store.get('lock.' + id, '0'));
  if (!id || Date.now() - lock < 3500) {
    const fresh = uuid();
    if (!id) store.set('pid', fresh);
    id = fresh;
  }
  try {
    sessionStorage.setItem('kaleido.tabpid', id);
  } catch {}
  return id;
}
const pid = choosePid();
setInterval(() => store.set('lock.' + pid, String(Date.now())), 1000);
store.set('lock.' + pid, String(Date.now()));

function loadLook(): LookPrefs | null {
  try {
    const v = JSON.parse(store.get('look', 'null'));
    return v && typeof v.hair === 'string' && typeof v.skin === 'string' ? v : null;
  } catch {
    return null;
  }
}
const prefs = {
  name: store.get('name', ''),
  handed: (store.get('handed', 'R') as Handed) || 'R',
  sens: Number(store.get('sens', '1')) || 1,
  /** the character you made (null = the one the TV picks for this phone) */
  look: loadLook(),
};

// ------------------------------------------------------------------ dom

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids) el.append(kid);
  return el;
}

keepPortrait();
const app = document.getElementById('app')!;
const root = h('div', { class: 'pad', 'data-screen': 'join' });
app.append(root);

// icons: a small line icon (`stroke` drawn as a line, `fill` as a solid shape)
const SVG = 'http://www.w3.org/2000/svg';
function icon(stroke: string, fill: string, width = 2.6) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [d, filled] of [
    [stroke, false],
    [fill, true],
  ] as const) {
    if (!d) continue;
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', filled ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', filled ? '1.6' : String(width));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}
const ICON = {
  // (settings: three sliders)
  gear: () => icon('M4 7h9M18.5 7h1.5M4 12h3M11.5 12h8.5M4 17h11M19.5 17h.5', 'M16 4.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM9 9.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM17 14.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z', 2.3),
  tv: () => icon('M3.5 6.5h17v11h-17zM9 21h6M12 17.5V21', '', 2.2),
  swipe: () => icon('M4 12h16M15 7l5 5-5 5M9 7 4 12l5 5', '', 2.4),
};

// join screen
const nameInput = h('input', {
  class: 'name-input',
  maxlength: '12',
  placeholder: 'Your name',
  autocomplete: 'off',
  autocapitalize: 'words',
  spellcheck: 'false',
  'aria-label': 'Your name',
});
nameInput.value = prefs.name;
const handL = h('button', { class: 'seg-btn', 'data-h': 'L' }, 'Left hand');
const handR = h('button', { class: 'seg-btn', 'data-h': 'R' }, 'Right hand');
const joinBtn = h('button', { class: 'join-btn' }, h('span', {}, 'Join game'));
const joinNote = h('p', { class: 'join-note' }, 'Your phone will ask to use motion: tap ', h('b', {}, 'Allow'), '.');
// your character: tap to change it
const joinFace = h('button', { class: 'face-btn', 'aria-label': 'Change your character' }, h('i', { class: 'face' }), h('span', {}, 'Edit'));
// opened over https the phone doesn't trust yet (tapped through Safari's warning): how to stop the warnings
const certHelp = h(
  'details',
  { class: 'cert' },
  h('summary', {}, 'Seeing a security warning? Remove it for good'),
  h(
    'ol',
    {},
    h('li', {}, h('a', { href: '/kaleido.mobileconfig' }, 'Download the profile'), ', then tap ', h('b', {}, 'Allow'), '.'),
    h('li', {}, 'Settings → General → VPN & Device Management → KALEIDO Local CA → ', h('b', {}, 'Install'), '.'),
    h('li', {}, 'Settings → General → About → Certificate Trust Settings → turn on ', h('b', {}, 'KALEIDO Local CA'), '.'),
  ),
  h('p', {}, 'It only trusts the game on your own Mac, and makes the remote connect faster.'),
);
certHelp.hidden = location.protocol !== 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const joinScreen = h(
  'section',
  { class: 'join' },
  h('div', { class: 'logo', 'aria-label': 'KALEIDO' }, ...'KALEIDO'.split('').map((ch, i) => h('span', { style: `--i:${i}` }, ch))),
  h('div', { class: 'tagline' }, 'Your phone is the remote'),
  h('div', { class: 'card' }, joinFace, nameInput, h('div', { class: 'seg' }, handL, handR), joinBtn, joinNote),
  certHelp,
);

// remote screen: who you are, the link to the TV, settings
const badge = h('span', { class: 'badge' }, 'P?');
const nameLabel = h('span', { class: 'who' }, '');
const scoreLine = h('span', { class: 'score' }, '');
const netDot = h('i', { class: 'dot connecting' });
const netMs = h('b', {}, 'Connecting');
const netPill = h('span', { class: 'net connecting', role: 'status' }, netDot, netMs);
const gearBtn = h('button', { class: 'gear', 'aria-label': 'Settings' }, ICON.gear());
const header = h('header', {}, h('div', { class: 'me' }, h('i', { class: 'face mini' }), badge), h('div', { class: 'id' }, nameLabel, scoreLine), netPill, gearBtn);
// lost the TV mid-game: say so over the panel (inputs don't reach it meanwhile)
const netBar = h('div', { class: 'netbar', role: 'alert' }, h('i', { class: 'mini-spin' }), h('span', {}, 'Reconnecting to the TV…'));

function padBtn(b: PadButton, cls: string, label: string | Node) {
  const el = h('button', { class: `pb ${cls}`, 'data-b': b }, label);
  return el;
}

/** a game panel's pause button, up in the corner, away from the thumb (the TV's home = pause) */
function pauseBtn(cls = '') {
  // (the house turns into a pause sign up here: see .stop .house)
  const el = padBtn('home', `small home ${cls}`, h('i', { class: 'house' }));
  el.setAttribute('aria-label', 'Pause');
  return el;
}
/** a game panel's top row: pause · the title and what to do now · (a corner button) */
function panelTop(pause: HTMLElement, title: HTMLElement, hint: HTMLElement, right?: HTMLElement) {
  return h('div', { class: 'stop' }, h('div', { class: 'sbtn' }, pause, h('span', {}, 'PAUSE')), h('div', { class: 'shead' }, title, hint), right ?? h('div', { class: 'sbtn' }));
}

const dpad = h(
  'div',
  { class: 'dpad' },
  padBtn('up', 'd-up', h('i', { class: 'tri up' })),
  padBtn('left', 'd-left', h('i', { class: 'tri left' })),
  h('div', { class: 'd-mid' }),
  padBtn('right', 'd-right', h('i', { class: 'tri right' })),
  padBtn('down', 'd-down', h('i', { class: 'tri down' })),
);
const aBtn = padBtn('a', 'a-btn', 'A');
const bBtn = padBtn('b', 'b-btn', 'B');
const row = h(
  'div',
  { class: 'row3' },
  padBtn('minus', 'small', '−'),
  padBtn('home', 'small home', h('i', { class: 'house' })),
  padBtn('plus', 'small', '+'),
);
for (const [i, label] of ['Minus', 'Home', 'Plus'].entries()) row.children[i].setAttribute('aria-label', label);
// the TV's screen (main menu, paused, results…) and what the pad does there
const menuTitle = h('div', { class: 'ptitle' }, '');
const menuHint = h('div', { class: 'phint' }, '');
const menuPanel = h('div', { class: 'panel menu' }, h('div', { class: 'mhead' }, menuTitle, menuHint), dpad, aBtn, row, bBtn);

const gaugeRing = h('div', { class: 'ring' });
const gaugeLive = h('div', { class: 'live' });
const gaugeText = h('div', { class: 'gtext' }, h('b', {}, 'SWING'), h('span', {}, ''));
// a smash chance: the pad goes red and gold and shouts
const smashBadge = h('div', { class: 'smash-badge' }, h('b', {}, 'SMASH!'), h('span', {}, 'swing hard!'));
const shotLine = h('div', { class: 'shotline' }, '');
const tvLine = h('div', { class: 'tvline' }, '');
const playTitle = h('div', { class: 'ptitle' }, '');
const playHint = h('div', { class: 'phint' }, 'Swing like a racket');
const swipeZone = h('div', { class: 'swipe-zone' }, ICON.swipe(), h('b', {}, 'SWIPE TO SWING'), h('span', {}, 'no motion sensor: swipe across here'));
const playPanel = h(
  'div',
  { class: 'panel play' },
  panelTop(pauseBtn(), playTitle, playHint),
  h('div', { class: 'sstage' }, tvLine, h('div', { class: 'gauge' }, gaugeLive, gaugeRing, gaugeText, smashBadge), shotLine),
  swipeZone,
);

const tossBtn = h('button', { class: 'toss' }, h('i', { class: 'toss-ball' }), h('b', {}, 'LIFT TO TOSS'), h('span', {}, 'raise the phone (or tap here), then swing'));
const serveTitle = h('div', { class: 'ptitle' }, 'Your serve!');
const serveHint = h('div', { class: 'phint' }, '');
const servePanel = h('div', { class: 'panel serve' }, panelTop(pauseBtn(), serveTitle, serveHint), tossBtn);

const skipBtn = h('button', { class: 'toss skip' }, h('b', {}, 'SKIP'), h('span', {}, 'replay'));
const skipPanel = h('div', { class: 'panel skip' }, panelTop(pauseBtn(), h('div', { class: 'ptitle' }, 'Replay'), h('div', { class: 'phint' }, 'Tap to skip it')), skipBtn);

const waitTitle = h('div', { class: 'wtitle' }, 'Connecting…');
const waitHint = h('div', { class: 'whint' }, '');
const waitPanel = h('div', { class: 'panel wait' }, h('div', { class: 'wicon' }, h('div', { class: 'spinner' }), h('i', { class: 'tvglyph' }, ICON.tv())), waitTitle, waitHint);

// bowling: the phone is the ball. Hold the big grip pad (the ball is in your
// hand), swing back and forward, let go at the bottom. Move (◀ ▶) and aim
// (↺ ↻) sit low in the corners, well away from where the thumb rests.
/** move/aim buttons repeat while held */
function bowlBtn(b: PadButton, label: string, glyph: SVGSVGElement) {
  return h('button', { class: 'pb small', 'data-b': b, 'data-rep': '', 'aria-label': label }, glyph);
}
const bowlTitle = h('div', { class: 'ptitle' }, '');
const bowlHint = h('div', { class: 'phint' }, '');
const bowlTv = h('div', { class: 'tvline' }, '');
const gripBig = h('b', {}, 'HOLD');
const gripSub = h('span', {}, 'swing & let go');
const gripBall = h(
  'div',
  { class: 'grip', role: 'button', 'aria-label': 'Hold to pick up the ball, swing, and let go to bowl' },
  h('i', { class: 'holes' }, h('i'), h('i'), h('i')),
  gripBig,
  gripSub,
);
const gripWrap = h('div', { class: 'grip-wrap' }, h('div', { class: 'grip-meter' }), gripBall);
const bowlShot = h('div', { class: 'shotline' }, '');
// pause: up in a corner, where a thumb sliding off the grip mid-throw can't reach
const bowlHome = pauseBtn('bhome');
bowlHome.dataset.lock = '';
const bowlPanel = h(
  'div',
  { class: 'panel bowl' },
  panelTop(bowlHome, bowlTitle, bowlHint),
  h('div', { class: 'sstage' }, bowlTv, gripWrap, bowlShot),
  h(
    'div',
    { class: 'bowl-row' },
    h(
      'div',
      { class: 'bgroup' },
      h('div', {}, bowlBtn('left', 'Step left', icon('', 'M15.5 5.5 7.5 12l8 6.5z')), bowlBtn('right', 'Step right', icon('', 'M8.5 5.5 16.5 12l-8 6.5z'))),
      h('span', {}, 'MOVE'),
    ),
    h(
      'div',
      { class: 'bgroup' },
      h(
        'div',
        {},
        bowlBtn('minus', 'Aim left', icon('M6.4 9.8A6.5 6.5 0 1 0 12 6.5', 'M9 6.5 13 3.2v6.6z')),
        bowlBtn('plus', 'Aim right', icon('M17.6 9.8A6.5 6.5 0 1 1 12 6.5', 'M15 6.5 11 3.2v6.6z')),
      ),
      h('span', {}, 'AIM'),
    ),
  ),
);

// sword duel: the phone is the sword. Swing to slash, push it at the screen
// to thrust, hold the big GUARD pad with your thumb to block — a guard stops
// a slash when the blade lies across it, so the pad shows how the blade lies
// right now. Pause and re-center sit up in the corners, out of the thumb's
// way. Without motion sensors: swipe to slash, tap to thrust, and a toggle
// sets the guard's angle.
/** a sword pointing up (turned to show how the blade lies across your view) */
function swordGlyph() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '-32 -32 64 64');
  svg.setAttribute('aria-hidden', 'true');
  for (const [d, fill] of [
    ['M0 -30 3.6 -23V8h-7.2v-31z', '#fff'],
    ['M0 -22V5', ''],
    ['M-12 8h24a2.5 2.5 0 0 1 0 5h-24a2.5 2.5 0 0 1 0-5z', 'rgba(29,28,43,.78)'],
    ['M-2.7 13h5.4v12h-5.4z', 'rgba(29,28,43,.62)'],
    ['M0 24.5a3.4 3.4 0 1 1 0 6.8a3.4 3.4 0 1 1 0-6.8z', 'rgba(29,28,43,.78)'],
  ]) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    if (fill) p.setAttribute('fill', fill);
    else {
      // the fuller down the middle of the blade
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'rgba(29,28,43,.16)');
      p.setAttribute('stroke-width', '1.6');
    }
    svg.append(p);
  }
  return svg;
}
const swordTitle = h('div', { class: 'ptitle' }, '');
const swordHint = h('div', { class: 'phint' }, '');
const swordTv = h('div', { class: 'tvline' }, '');
const bladeEl = h('i', { class: 'blade' }, swordGlyph());
const guardBig = h('b', {}, 'GUARD');
const guardSub = h('span', {}, '');
const guardPad = h('div', { class: 'guard', role: 'button', 'aria-label': 'Hold to guard' }, bladeEl, guardBig, guardSub);
const guardWrap = h('div', { class: 'guard-wrap' }, h('div', { class: 'guard-meter' }), guardPad);
const swordShot = h('div', { class: 'shotline' }, '');
const swordHome = padBtn('home', 'small home', h('i', { class: 'house' }));
swordHome.dataset.lock = '';
swordHome.setAttribute('aria-label', 'Pause');
// "point the phone at the TV and tap": which way the screen is
const swordRecenter = h(
  'button',
  { class: 'small', 'aria-label': 'Re-center: point the phone at the TV and tap' },
  icon('M12 3.5v3.2M12 17.3v3.2M3.5 12h3.2M17.3 12h3.2M12 6.6a5.4 5.4 0 1 0 0 10.8a5.4 5.4 0 1 0 0-10.8', 'M12 10.3a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0-3.4'),
);
// no motion sensor: the swipe pad and the guard's angle
const slashZone = h('div', { class: 'slash-zone' }, h('b', {}, 'SWIPE TO SLASH'), h('span', {}, 'tap to thrust'));
const guardVert = h('button', { class: 'gseg-btn', 'data-g': 'vertical' }, h('i', { class: 'gl v' }), 'Vertical');
const guardHorz = h('button', { class: 'gseg-btn', 'data-g': 'horizontal' }, h('i', { class: 'gl h' }), 'Horizontal');
const swordPanel = h(
  'div',
  { class: 'panel sword' },
  h(
    'div',
    { class: 'stop' },
    h('div', { class: 'sbtn' }, swordHome, h('span', {}, 'PAUSE')),
    h('div', { class: 'shead' }, swordTitle, swordHint),
    h('div', { class: 'sbtn recenter-wrap' }, swordRecenter, h('span', {}, 'RE-CENTER')),
  ),
  // the TV's verdict, the guard and your last blow stay together in the middle
  h('div', { class: 'sstage' }, swordTv, slashZone, guardWrap, swordShot),
  h('div', { class: 'gseg' }, guardVert, guardHorz),
);

// archery: point the phone at the target, hold DRAW to pull the string, let go
// to shoot. The TV aims from how the phone turns while you draw, so it never
// drifts; without motion sensors, drag on the pad to aim.
function bowGlyph() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  for (const [d, stroke, w] of [
    ['M20 6C40 14 40 50 20 58', '#fff', 5],
    ['M20 6L20 58', 'rgba(255,255,255,.75)', 1.6],
    ['M8 32H56', 'rgba(29,28,43,.8)', 3],
    ['M56 32l-7-5v10z', 'rgba(29,28,43,.8)', 1],
    ['M8 32l-4-4M8 32l-4 4', 'rgba(29,28,43,.8)', 2.4],
  ] as const) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', d.endsWith('z') ? stroke : 'none');
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', String(w));
    p.setAttribute('stroke-linecap', 'round');
    svg.append(p);
  }
  return svg;
}
const bowTitle = h('div', { class: 'ptitle' }, '');
const bowHint = h('div', { class: 'phint' }, '');
const bowTv = h('div', { class: 'tvline' }, '');
const drawBig = h('b', {}, 'DRAW');
const drawSub = h('span', {}, 'hold · aim · let go');
const drawPad = h('div', { class: 'guard draw', role: 'button', 'aria-label': 'Hold to draw the bow, point at the target, let go to shoot' }, h('i', { class: 'blade bowglyph' }, bowGlyph()), drawBig, drawSub);
const drawWrap = h('div', { class: 'guard-wrap' }, h('div', { class: 'guard-meter' }), drawPad);
const bowShot = h('div', { class: 'shotline' }, '');
const bowHome = pauseBtn();
bowHome.dataset.lock = '';
const bowPanel = h(
  'div',
  { class: 'panel bow' },
  panelTop(bowHome, bowTitle, bowHint),
  h('div', { class: 'sstage' }, bowTv, drawWrap, bowShot),
);

const panels: Record<PadMode, HTMLElement> = {
  menu: menuPanel,
  play: playPanel,
  serve: servePanel,
  wait: waitPanel,
  watch: waitPanel,
  skip: skipPanel,
  bowl: bowlPanel,
  sword: swordPanel,
  bow: bowPanel,
  bat: playPanel,
};

const leds = h('div', { class: 'leds' }, h('i'), h('i'), h('i'), h('i'));
const footer = h('footer', {}, leds, h('div', { class: 'brand' }, 'KALEIDO'));
const flash = h('div', { class: 'flash' });
const toast = h('div', { class: 'toast' });
const shell = h('div', { class: 'shell' }, menuPanel, playPanel, servePanel, waitPanel, skipPanel, bowlPanel, swordPanel, bowPanel, netBar);
const remoteScreen = h(
  'section',
  { class: 'remote' },
  header,
  shell,
  footer,
  flash,
  toast,
);

// settings sheet
const sensBtns = ([
  ['Big swings', '0.75'],
  ['Normal', '1'],
  ['Light swings', '1.35'],
] as const).map(([label, v]) => h('button', { class: 'seg-btn', 'data-s': v }, label));
const setName = h('input', { class: 'name-input', maxlength: '12', autocomplete: 'off', 'aria-label': 'Your name', placeholder: 'Your name' });
const setL = h('button', { class: 'seg-btn', 'data-h': 'L' }, 'Left hand');
const setR = h('button', { class: 'seg-btn', 'data-h': 'R' }, 'Right hand');
const sheetClose = h('button', { class: 'join-btn small' }, h('span', {}, 'Done'));
const motionState = h('span', { class: 'chip' }, '');
const linkState = h('span', { class: 'chip' }, '');
// the character editor: a face that shows every change, and the pieces
const faceBig = h('i', { class: 'face big' });
const cycleRow = (label: string) => {
  const v = h('b', {});
  const prev = h('button', { class: 'cyc', 'aria-label': `Previous ${label}` }, '◀');
  const next = h('button', { class: 'cyc', 'aria-label': `Next ${label}` }, '▶');
  return { row: h('div', { class: 'look-row' }, h('span', { class: 'label' }, label), h('div', { class: 'cycle' }, prev, v, next)), v, prev, next };
};
const swatchRow = (label: string, colors: readonly string[], key: 'hairColor' | 'skin') => {
  const btns = colors.map((c) => h('button', { class: 'sw', style: `--c:${c}`, 'data-c': c, 'aria-label': `${label} ${c}` }));
  for (const b of btns) b.addEventListener('click', () => editLook({ [key]: b.dataset.c! }));
  return { row: h('div', { class: 'look-row' }, h('span', { class: 'label' }, label), h('div', { class: 'swatches' }, ...btns)), btns };
};
const hairRow = cycleRow('Hair');
const hairColRow = swatchRow('Hair colour', HAIR_TONES, 'hairColor');
const skinRow = swatchRow('Skin', SKIN_TONES, 'skin');
const eyesRow = cycleRow('Eyes');
const surprise = h('button', { class: 'seg-btn surprise' }, 'Surprise me');
const EYE_NAMES: Record<string, string> = { oval: 'Round', dot: 'Dots', tall: 'Tall', wide: 'Wide', sleepy: 'Sleepy' };
const lookCard = h('div', { class: 'look' }, faceBig, h('div', { class: 'look-rows' }, hairRow.row, hairColRow.row, skinRow.row, eyesRow.row, surprise));
const recenterBtn = h('button', { class: 'join-btn small recenter' }, h('span', {}, 'Recenter aim'));
const recenterNote = h('p', { class: 'join-note' }, 'Point the top of your phone at the screen, then tap.');
const sheet = h(
  'section',
  { class: 'sheet' },
  h(
    'div',
    { class: 'sheet-card' },
    h('i', { class: 'grabber' }),
    h('h2', {}, 'Remote settings'),
    h('div', { class: 'chips' }, motionState, linkState),
    h('div', { class: 'label' }, 'Name'),
    setName,
    h('div', { class: 'seg' }, setL, setR),
    h('div', { class: 'label' }, 'Your character'),
    lookCard,
    h('div', { class: 'label' }, 'Swing sensitivity'),
    h('div', { class: 'seg three' }, ...sensBtns),
    recenterBtn,
    recenterNote,
    sheetClose,
  ),
);

root.append(joinScreen, remoteScreen, sheet);

// ------------------------------------------------------------------ state

const audio = new PadAudio();
const detector = new SwingDetector();
detector.sensitivity = prefs.sens;
detector.handed = prefs.handed === 'L' ? -1 : 1;
// iOS reports accelerometer & gravity with the opposite sign to the W3C spec
detector.upSign = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? -1 : 1;
// the sensors: gyro axes found from the OS's own orientation, fused orientation (pipeline.ts)
const front = new MotionFront();
// (remembered from last time, so the first swings are read right; it's checked again as you play)
front.axes.load(store.get('gyroAxes'));
front.axes.onSure = (saved) => store.set('gyroAxes', saved);
const orient = front.orient;
const bowl = new BowlDetector();
bowl.sensitivity = prefs.sens;
const sword = new SwordDetector();
sword.sensitivity = prefs.sens;
sword.upSign = detector.upSign;
const link = new PadLink(pid, () => prefs.name || 'Player');
// ?rec (or ?rec=<name>): record the raw motion, the buttons and what the TV said while playing, to
// captures/<name>-<date>.jsonl on the server (capture.ts; replay with scripts/replay-capture.ts)
const recParam = new URLSearchParams(location.search).get('rec');
const rec = recParam !== null ? new Recorder(captureName(recParam || 'play'), { page: 'controller' }) : null;
if (rec) {
  // (a functional marker, not part of the design: recording is on)
  const badge = document.createElement('div');
  badge.textContent = '● REC';
  badge.setAttribute('style', 'position:fixed;top:max(6px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:99;font:700 11px system-ui;color:#ff6b7a;pointer-events:none');
  document.body.append(badge);
  addEventListener('pagehide', () => rec.stop());
}
let slot = -1;
let mode: PadMode = 'wait';
let motionOK = false;
let motionSeen = false;
let seq = 0;
let joined = false;
/** which game the TV's fx lines are about (they can arrive while on 'watch') */
let sport: 'tennis' | 'bowl' | 'duel' | 'archery' | 'baseball' = 'tennis';
/** bowling: the pointer holding the grip (the ball is in the hand), or null */
let gripId: number | null = null;
/** sword: the guard pad is held (by these pointers) */
let guarding = false;
const guardPtrs = new Set<number>();
/** sword without motion sensors: the guard's angle, from the toggle */
let touchGuard: 'vertical' | 'horizontal' = store.get('guard') === 'horizontal' ? 'horizontal' : 'vertical';
/** the locked buttons (bowling's move/aim, pause) ignore presses until then:
 *  a thumb sliding off the grip or the guard, a hand flailing after a blow */
let lockUntil = 0;

let myColor = '#8a7dff';
function setColor(c: string) {
  myColor = c;
  root.style.setProperty('--pc', c);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', c);
  drawFaces();
}

/** Your character as the TV will build it: the look you made, or this phone's default. */
function faceLook() {
  const d = playerLook(myColor, hashStr(pid));
  const L = prefs.look;
  return { skin: L?.skin ?? d.skin, hair: L?.hair ?? d.hair, hairColor: L?.hairColor ?? d.hairColor, eyes: L?.eyes ?? d.eyes, shirt: myColor };
}

function drawFaces() {
  const f = faceLook();
  for (const el of document.querySelectorAll('.face')) el.replaceChildren(avatarSvg(f));
  hairRow.v.textContent = HAIR_NAMES[f.hair] ?? f.hair;
  eyesRow.v.textContent = EYE_NAMES[f.eyes] ?? f.eyes;
  for (const b of hairColRow.btns) b.classList.toggle('on', b.dataset.c === f.hairColor);
  for (const b of skinRow.btns) b.classList.toggle('on', b.dataset.c === f.skin);
}

/** Change a piece of your character: saved on the phone and sent to the TV (it shows from the next game). */
function editLook(change: Partial<LookPrefs>) {
  const f = faceLook();
  prefs.look = { hair: f.hair, hairColor: f.hairColor, skin: f.skin, eyes: f.eyes, ...change };
  store.set('look', JSON.stringify(prefs.look));
  drawFaces();
  sendPrefs();
  audio.tick();
}

const cycle = (list: readonly string[], cur: string, d: number) => list[(Math.max(0, list.indexOf(cur)) + d + list.length) % list.length];
hairRow.prev.addEventListener('click', () => editLook({ hair: cycle(HAIRS, faceLook().hair, -1) }));
hairRow.next.addEventListener('click', () => editLook({ hair: cycle(HAIRS, faceLook().hair, 1) }));
eyesRow.prev.addEventListener('click', () => editLook({ eyes: cycle(EYES, faceLook().eyes, -1) }));
eyesRow.next.addEventListener('click', () => editLook({ eyes: cycle(EYES, faceLook().eyes, 1) }));
surprise.addEventListener('click', () => {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
  editLook({ hair: pick(HAIRS.filter((x) => x !== 'none')), hairColor: pick(HAIR_TONES), skin: pick(SKIN_TONES), eyes: pick(EYES) });
});
setColor('#8a7dff');

function syncHandButtons() {
  for (const b of [handL, handR, setL, setR]) b.classList.toggle('on', b.dataset.h === prefs.handed);
  for (const b of sensBtns) b.classList.toggle('on', Number(b.dataset.s) === prefs.sens);
}
syncHandButtons();

for (const b of [handL, handR, setL, setR]) {
  b.addEventListener('click', () => {
    prefs.handed = b.dataset.h as Handed;
    detector.handed = prefs.handed === 'L' ? -1 : 1;
    store.set('handed', prefs.handed);
    syncHandButtons();
    showGuardAngle();
    audio.tick();
    sendPrefs();
  });
}
for (const b of sensBtns) {
  b.addEventListener('click', () => {
    prefs.sens = Number(b.dataset.s);
    detector.sensitivity = prefs.sens;
    bowl.sensitivity = prefs.sens;
    sword.sensitivity = prefs.sens;
    store.set('sens', String(prefs.sens));
    syncHandButtons();
    audio.tick();
  });
}

function sendPrefs() {
  if (joined) link.send({ type: 'prefs', name: prefs.name || 'Player', handed: prefs.handed, ...(prefs.look ? { look: prefs.look } : {}) });
}

let toastTimer = 0;
function showToast(text: string, ms = 1400) {
  toast.textContent = text;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
}

/** a white flash in the player's colour; 'red' when you're hit, 'steel' when your guard holds, 'gold' for a smash */
function doFlash(strong = false, tint: '' | 'red' | 'steel' | 'gold' = '') {
  flash.classList.remove('go', 'strong', 'red', 'steel', 'gold');
  shell.classList.remove('rumble', 'big');
  void flash.offsetWidth;
  flash.classList.add('go');
  // the remote kicks in the hand (as a rumble would), harder for the big ones
  shell.classList.add('rumble');
  if (strong) {
    flash.classList.add('strong');
    shell.classList.add('big');
  }
  if (tint) flash.classList.add(tint);
  haptic(strong ? 1 : 0.5);
}

/** the bowling / bow panel is showing but not taking input (your ball is rolling, your arrow flying) */
let locked = false;

let modeSig = '';
/** long headings ("At bat · pitch 3 of 10") a size down, so they stay on one line */
function fitTitles() {
  for (const el of root.querySelectorAll<HTMLElement>('.panel .ptitle')) {
    const n = (el.textContent ?? '').length;
    el.classList.toggle('long', n > 14 && n <= 19);
    el.classList.toggle('xlong', n > 19);
  }
}
let smashTimer = 0;
/** the smash chance state on the tennis panel: on (red/gold, pulsing), 'hit' (the flare after), or off */
function smashState(on: boolean | 'hit') {
  window.clearTimeout(smashTimer);
  playPanel.classList.toggle('smash', on === true);
  playPanel.classList.toggle('smashed', on === 'hit');
  if (on === true) smashTimer = window.setTimeout(() => smashState(false), 4000);
  else if (on === 'hit') smashTimer = window.setTimeout(() => smashState(false), 1300);
}

function setMode(m: PadMode, title?: string, hint?: string, lock = false) {
  const prev = mode;
  if (m !== 'play') smashState(false);
  // a new mode, or new words on it: the heading pops (the panel slides in when it changes)
  const sig = `${m === 'watch' ? 'wait' : m === 'bat' ? 'play' : m}|${title ?? ''}|${hint ?? ''}`;
  if (sig !== modeSig && panels[m].classList.contains('on')) {
    for (const el of panels[m].querySelectorAll('.ptitle, .wtitle')) {
      el.classList.remove('pop');
      void (el as HTMLElement).offsetWidth;
      el.classList.add('pop');
    }
  }
  modeSig = sig;
  setTimeout(fitTitles);
  mode = m;
  if (m !== prev) rec?.event('mode', { mode: m });
  locked = lock && (m === 'bowl' || m === 'bow');
  bowlPanel.classList.toggle('locked', locked && m === 'bowl');
  bowPanel.classList.toggle('locked', locked && m === 'bow');
  if (m === 'bowl') sport = 'bowl';
  else if (m === 'sword') sport = 'duel';
  else if (m === 'bow') sport = 'archery';
  else if (m === 'bat') sport = 'baseball';
  else if (m === 'play' || m === 'serve') sport = 'tennis';
  if (prev === 'bowl' && m !== 'bowl') {
    // the game moved on with the ball still in the hand: drop it, don't throw
    gripCancel();
    // and whatever the tennis detector made of the bowling swings is forgotten
    detector.reset();
  }
  if (prev === 'bow' && m !== 'bow') {
    // the game moved on mid-draw (a pause): let go of the string (the TV doesn't shoot then)
    drawCancel();
    detector.reset();
  }
  if (prev === 'sword' && m !== 'sword') {
    // the duel moved on with the guard up: let go of it (the TV hears so)
    guardCancel();
    detector.reset();
  }
  for (const el of new Set(Object.values(panels))) if (el !== panels[m]) el.classList.remove('on');
  panels[m].classList.add('on');
  if (m === 'wait' || m === 'watch') {
    waitTitle.textContent = title || (m === 'watch' ? 'Watching' : 'You’re in!');
    waitHint.textContent = hint || 'Look at the big screen';
    // waiting on the link: a spinner; otherwise the TV is where it's at
    waitPanel.classList.toggle('busy', link.status !== 'online' || slot < 0);
  }
  if (m === 'menu') {
    menuTitle.textContent = title || 'KALEIDO';
    menuHint.textContent = hint || 'Use the pad · A to choose';
  }
  if (m === 'play') {
    playTitle.textContent = title || '';
    playHint.textContent = hint || 'Swing like a racket';
  }
  playPanel.classList.toggle('bat', m === 'bat');
  if (m === 'bat') {
    if (prev !== 'bat') {
      // a fresh turn at bat: the last swing's read-out (and a tennis one) is old news
      gaugeRing.style.setProperty('--p', '0.04');
      (gaugeText.children[0] as HTMLElement).textContent = 'SWING';
      (gaugeText.children[1] as HTMLElement).textContent = '';
      shotLine.textContent = '';
      tvLine.textContent = '';
    }
    playTitle.textContent = title || 'At bat!';
    playHint.textContent = hint || (motionOK ? 'Hold the phone like a bat · swing as the ball arrives' : 'Swipe across the pad to swing');
  }
  if (m === 'skip') {
    skipBtn.querySelector('b')!.textContent = title || 'SKIP';
    skipBtn.querySelector('span')!.textContent = hint || 'replay';
  }
  if (m === 'serve') {
    serveTitle.textContent = /second/i.test(title || '') ? 'Second serve!' : 'Your serve!';
    serveHint.textContent = motionOK ? 'Lift the phone to toss · then swing' : 'Tap to toss · then swipe';
    tossBtn.classList.remove('tossed');
    tossBtn.querySelector('b')!.textContent = title || (motionOK ? 'LIFT TO TOSS' : 'TAP TO TOSS');
    tossBtn.querySelector('span')!.textContent = hint || (motionOK ? 'raise the phone (or tap here), then swing' : 'then swing to serve');
  }
  if (m === 'bowl') {
    bowlTitle.textContent = title || 'Your turn!';
    bowlHint.textContent = hint || (motionOK ? 'Hold the ball, swing back, then forward' : 'Hold the ball, drag up and let go');
    // (locked: the throw's read-out stays on the ball until the next turn)
    if (gripId === null && !locked) gripIdle();
  }
  if (m === 'bow') {
    bowTitle.textContent = title || 'Your turn!';
    bowHint.textContent = hint || (motionOK ? 'Point at the target · hold DRAW · let go' : 'Hold DRAW · drag to aim · let go');
    if (drawId === null) drawIdle();
    if (locked) {
      drawBig.textContent = 'LOOSED';
      drawSub.textContent = 'watch the target';
    }
  }
  if (m === 'sword') {
    // a fresh duel: the motion so far was something else
    if (prev !== 'sword') sword.reset();
    // (a new round: the last one's blow is old news)
    if (prev !== 'sword' || (title || 'Duel!') !== swordTitle.textContent) swordShot.textContent = '';
    swordTitle.textContent = title || 'Duel!';
    swordHint.textContent = hint || (motionOK ? 'Swing to slash · hold GUARD to block' : 'Swipe to slash · hold GUARD to block');
    swordPanel.classList.toggle('touch', !motionOK);
    showGuardAngle();
  }
  swipeZone.classList.toggle('on', !motionOK && (m === 'play' || m === 'serve' || m === 'bat'));
  servePanel.classList.toggle('swipe', !motionOK);
}

function setStatus(s: LinkStatus) {
  netDot.className = 'dot ' + s;
  netPill.className = 'net ' + s;
  if (s !== 'online') netMs.textContent = s === 'connecting' ? 'Connecting' : 'Offline';
  else netMs.textContent = 'Connected';
  // lost the TV mid-game (a player slot, but no link): say so over the panel
  remoteScreen.classList.toggle('lost', s !== 'online' && slot >= 0);
  if (mode === 'wait' || mode === 'watch') waitPanel.classList.toggle('busy', s !== 'online' || slot < 0);
  if (s === 'offline' || s === 'connecting') {
    if (slot < 0) setMode('wait', s === 'connecting' ? 'Connecting…' : 'Disconnected', 'Make sure KALEIDO is running on your Mac');
  } else if (joined) {
    link.send({ type: 'hello', name: prefs.name || 'Player', handed: prefs.handed, ver: 1, motion: motionOK, ...(prefs.look ? { look: prefs.look } : {}) });
  }
}

function onMessage(m: ServerToPad) {
  switch (m.type) {
    case 'welcome':
      slot = m.slot;
      setColor(m.color || PLAYER_COLORS[m.slot] || '#8a7dff');
      badge.textContent = 'P' + (m.slot + 1);
      nameLabel.textContent = m.name;
      [...leds.children].forEach((el, i) => el.classList.toggle('on', i === m.slot));
      remoteScreen.classList.remove('lost');
      waitPanel.classList.remove('busy');
      if (mode === 'wait') setMode('menu');
      break;
    case 'full':
      setMode('wait', 'Game is full', 'Four remotes are already connected');
      break;
    case 'mode':
      setMode(m.mode, m.title, m.hint, !!m.lock);
      break;
    case 'score':
      scoreLine.textContent = m.line;
      break;
    case 'fx': {
      if (sport === 'duel') {
        duelFx(m);
        break;
      }
      if (sport === 'baseball') {
        batFx(m);
        break;
      }
      const bowling = sport === 'bowl' || sport === 'archery';
      // bowling / archery: the TV's verdict on the throw or the shot, e.g. "STRIKE! · 7.6 m/s · hook"
      const line = [m.label, m.detail].filter(Boolean).join(' · ');
      if (bowling && line) {
        const tv = sport === 'bowl' ? bowlTv : bowTv;
        tv.textContent = line;
        tv.classList.remove('pop');
        void tv.offsetWidth;
        tv.classList.add('pop');
        // on 'watch' while the ball rolls (the arrow flies) the panel isn't showing: say it anyway
        if ((mode !== 'bowl' && mode !== 'bow') || m.fx === 'perfect') showToast(m.label || line, 1800);
      }
      if (m.fx !== 'smash-chance' && m.fx !== 'smash') smashState(false);
      switch (m.fx) {
        case 'smash-chance':
          (smashBadge.lastChild as HTMLElement).textContent = 'swing hard!';
          smashState(true);
          audio.smashRiser();
          doFlash(false, 'gold');
          break;
        case 'smash':
          (smashBadge.lastChild as HTMLElement).textContent = m.detail || '';
          smashState('hit');
          audio.smash(/PERFECT/.test(m.label ?? ''));
          doFlash(true, 'gold');
          showToast(m.label || 'SMASH!', 1800);
          tvLine.textContent = line;
          break;
        case 'hit':
          audio.hit(m.power ?? 0.6);
          doFlash();
          if (m.label && !bowling) tvLine.textContent = line;
          break;
        case 'perfect':
          audio.hit(m.power ?? 0.8, true);
          doFlash(true);
          if (!bowling) {
            showToast('PERFECT!');
            if (m.label) tvLine.textContent = line;
          }
          break;
        case 'whiff':
          if (!bowling) tvLine.textContent = m.label ? `MISS · ${m.label}` : 'MISS';
          break;
        case 'toss':
          audio.toss();
          break;
        case 'select':
          audio.select();
          break;
        case 'move':
          audio.tick();
          break;
        case 'back':
          audio.back();
          break;
        case 'point-won':
        case 'win':
          audio.jingle(true);
          break;
        case 'point-lost':
        case 'lose':
          audio.jingle(false);
          break;
      }
      break;
    }
    case 'bye':
      if (m.reason === 'replaced') setMode('wait', 'Opened elsewhere', 'This remote is active in another tab');
      break;
  }
}

/** The TV's verdict at bat — "HOME RUN! · 124 m", "FOUL · a touch early" — with the crack of the bat. */
function batFx(m: Extract<ServerToPad, { type: 'fx' }>) {
  const line = [m.label, m.detail].filter(Boolean).join(' · ');
  if (line) {
    tvLine.textContent = line;
    tvLine.classList.remove('pop');
    void tvLine.offsetWidth;
    tvLine.classList.add('pop');
    // between turns the bat panel isn't showing: say it anyway
    if (mode !== 'bat' && m.fx !== 'select' && m.fx !== 'move' && m.fx !== 'back') showToast(m.label || line, 1800);
  }
  switch (m.fx) {
    case 'hit':
      audio.crack(m.power ?? 0.6);
      doFlash();
      break;
    case 'perfect':
      audio.crack(m.power ?? 0.9, true);
      doFlash(true);
      if (mode === 'bat' && m.label) showToast(m.label, 1600);
      break;
    case 'select':
      audio.select();
      break;
    case 'move':
      audio.tick();
      break;
    case 'back':
      audio.back();
      break;
    case 'point-won':
    case 'win':
      audio.jingle(true);
      break;
    case 'point-lost':
    case 'lose':
      audio.jingle(false);
      break;
  }
}

/** words for the duel's verdicts when the TV sends none */
const DUEL_WORD: Partial<Record<PadFx, string>> = {
  block: 'BLOCKED!',
  ouch: 'OUCH!',
  hit: 'HIT!',
  'point-won': 'ROUND WON',
  'point-lost': 'ROUND LOST',
  win: 'YOU WIN!',
  lose: 'YOU LOSE',
};

/** The TV's verdict in a duel: the line, a sound, a flash. */
function duelFx(m: Extract<ServerToPad, { type: 'fx' }>) {
  rec?.event('fx', { fx: m.fx, label: m.label ?? '' });
  const word = m.label || DUEL_WORD[m.fx] || '';
  const line = [word, m.detail].filter(Boolean).join(' · ');
  if (line) {
    swordTv.textContent = line;
    swordTv.classList.remove('pop');
    void swordTv.offsetWidth;
    swordTv.classList.add('pop');
    // between rounds the sword panel isn't showing: say it anyway
    if (mode !== 'sword' && m.fx !== 'select' && m.fx !== 'move' && m.fx !== 'back') showToast(word || line, 1800);
  }
  switch (m.fx) {
    case 'block':
      audio.clank(m.power ?? 0.7);
      doFlash(false, 'steel');
      guardWrap.classList.remove('clank');
      void guardWrap.offsetWidth;
      guardWrap.classList.add('clank');
      break;
    case 'ouch':
      audio.thud(m.power ?? 0.7);
      doFlash(true, 'red');
      break;
    case 'hit':
    case 'perfect':
      audio.thwack(m.power ?? 0.7);
      doFlash(m.fx === 'perfect');
      break;
    case 'point-won':
    case 'win':
      audio.jingle(true);
      break;
    case 'point-lost':
    case 'lose':
      audio.jingle(false);
      break;
    case 'select':
      audio.select();
      break;
    case 'move':
      audio.tick();
      break;
    case 'back':
      audio.back();
      break;
  }
}

link.onMessage = onMessage;
link.onStatus = setStatus;
setInterval(() => {
  if (link.status === 'online') netMs.textContent = `${Math.round(link.lat * 2)} ms`;
}, 1000);

// ------------------------------------------------------------------ buttons

/** the phone is held to be looked at (screen facing up-ish), so its top points the way you face */
function lookingAtPhone() {
  return orient.have && orient.toEarth([0, 0, 1])[2] > 0.35;
}

/** the locked buttons (bowling's move/aim/home, the duel's pause) that are down: let go of them all */
const lockedBtnUps: (() => void)[] = [];
/** the thumb is on the grip or the guard, or just came off it */
const handBusy = () => gripId !== null || guarding || drawId !== null || performance.now() < lockUntil;

for (const el of root.querySelectorAll<HTMLButtonElement>('.pb')) {
  const b = el.dataset.b as PadButton;
  // bowling's move/aim buttons repeat while held, like a held key: more downs, one up
  const rep = el.dataset.rep !== undefined;
  // bowling's buttons (move, aim, home) wait while the ball is in the hand; the duel's pause while guarding
  const lock = rep || el.dataset.lock !== undefined;
  let repTimer = 0;
  const up = () => {
    clearTimeout(repTimer);
    clearInterval(repTimer);
    if (!el.classList.contains('down')) return;
    el.classList.remove('down');
    link.send({ type: 'btn', b, down: false });
  };
  if (lock) lockedBtnUps.push(up);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // not while the ball is in the hand (or the guard is held) or just after
    // letting go: that's a palm or a thumb sliding off the pad, not a press
    if (lock && handBusy()) return;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {}
    el.classList.add('down');
    audio.tick();
    // pressing A in a menu means you're looking at the phone, facing the screen:
    // a good moment to refresh which way "towards the screen" is (the same for
    // the bowling buttons, if the phone is held to be looked at)
    if (b === 'a' && mode === 'menu') orient.calibrate();
    if (rep && lookingAtPhone()) orient.calibrate();
    link.send({ type: 'btn', b, down: true });
    if (rep) {
      repTimer = window.setTimeout(() => {
        repTimer = window.setInterval(() => {
          link.send({ type: 'btn', b, down: true });
          audio.tick();
        }, 110);
      }, 380);
    }
  });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}

function doToss() {
  if (!joined || tossBtn.classList.contains('tossed')) return;
  link.send({ type: 'toss', lat: link.lat });
  audio.toss();
  tossBtn.classList.add('tossed');
  tossBtn.querySelector('b')!.textContent = 'SWING!';
  tossBtn.querySelector('span')!.textContent = motionOK ? 'hit it at the top' : 'swipe up here to serve';
}

tossBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  doToss();
});

// Lift to toss (Switch Sports-style; lift.ts): while it's your serve, raising the
// phone tosses the ball — on the way up, never as it comes back down.
const lift = new LiftDetector();
let noSwingUntil = 0;
function liftCheck(now: number, aUp: number, w: number, dt: number) {
  if (mode !== 'serve' || !joined || tossBtn.classList.contains('tossed')) {
    lift.reset();
    return;
  }
  if (lift.push(now, aUp, w, dt)) {
    noSwingUntil = now + 320;
    doToss();
  }
}

skipBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  audio.select();
  link.send({ type: 'btn', b: 'a', down: true });
  link.send({ type: 'btn', b: 'a', down: false });
});

joinFace.addEventListener('click', () => gearBtn.click());
gearBtn.addEventListener('click', () => {
  setName.value = prefs.name;
  motionState.textContent = motionOK ? 'Motion sensor on' : 'No motion sensor: swipe pads';
  motionState.className = 'chip ' + (motionOK ? 'good' : 'meh');
  linkState.textContent = link.status !== 'online' ? 'Not connected' : link.transport === 'ws' ? `Connected · ${Math.round(link.lat * 2)} ms` : `Connected (fallback) · ${Math.round(link.lat * 2)} ms`;
  linkState.className = 'chip ' + (link.status === 'online' ? 'good' : 'bad');
  motionState.title = motionOK ? `gyro axes: ${front.axes.sure ? front.axes.name : 'not yet checked'}` : '';
  sheet.classList.add('open');
  audio.tick();
});
sheetClose.addEventListener('click', () => {
  setName.blur();
  window.scrollTo(0, 0);
  prefs.name = setName.value.trim().slice(0, 12);
  store.set('name', prefs.name);
  sheet.classList.remove('open');
  sendPrefs();
  audio.select();
});

// ------------------------------------------------------------------ swings

const SIDE_NAME = { fh: 'FOREHAND', bh: 'BACKHAND', oh: 'OVERHEAD' } as const;
let pathOk = false;

/** Horizontal direction the racket head was moving at the peak, degrees (player frame). */
function swingPath(sw: SwingEvent): number | null {
  if (!sw.q || orient.heading === null) return null;
  const e = (v: [number, number, number]) => orient.toPlayer(qrot(sw.q!, v));
  const w = e(sw.omega);
  const shaft = e([0, 1, 0]);
  // racket-head velocity ∝ ω × shaft
  const vx = w[1] * shaft[2] - w[2] * shaft[1];
  const vy = w[2] * shaft[0] - w[0] * shaft[2];
  if (Math.hypot(vx, vy) < 0.5) return null;
  return (Math.atan2(vx, vy) * 180) / Math.PI;
}

function emitSwing(sw: SwingEvent, touch = false) {
  // bowling: the arm swing is a throw, not a racket swing; the duel has its own
  if (mode === 'bowl' || mode === 'sword' || mode === 'bow') return;
  if (!touch && sw.t < noSwingUntil) return;
  const age = Math.max(0, performance.now() - sw.t);
  const path = touch ? null : swingPath(sw);
  pathOk = path !== null;
  link.send({
    type: 'swing',
    seq: ++seq,
    power: +sw.power.toFixed(3),
    spin: +sw.spin.toFixed(3),
    peak: +sw.peak.toFixed(2),
    age: Math.round(age),
    lat: Math.round(link.lat),
    touch,
    side: sw.side,
    attack: Math.round(sw.attack),
    path: path === null ? null : Math.round(path),
  });
  audio.swish(sw.power);
  showSwing(sw, path);
}

function showSwing(sw: SwingEvent, path: number | null) {
  const pct = Math.round(sw.power * 100);
  gaugeRing.style.setProperty('--p', String(Math.max(0.04, sw.power)));
  gaugeRing.classList.remove('pop');
  void gaugeRing.offsetWidth;
  gaugeRing.classList.add('pop');
  if (mode === 'bat') {
    // a bat: how hard, and the swing's plane (the TV judges the timing)
    const a = Math.round(sw.attack);
    (gaugeText.children[0] as HTMLElement).textContent = 'SWING';
    (gaugeText.children[1] as HTMLElement).textContent = a >= 10 ? `Uppercut ${a}°` : a <= -10 ? `Chop ${-a}°` : 'Level';
    shotLine.textContent = `${pct}% power`;
    tvLine.textContent = '';
    return;
  }
  const spin = sw.spin > 0.25 ? `Topspin ${Math.round(sw.attack)}°` : sw.spin < -0.25 ? `Slice ${Math.round(sw.attack)}°` : 'Flat';
  (gaugeText.children[0] as HTMLElement).textContent = SIDE_NAME[sw.side];
  (gaugeText.children[1] as HTMLElement).textContent = spin;
  const aim = path === null ? '' : Math.abs(path) < 8 ? ' · aim ↑' : path < 0 ? ` · aim ← ${Math.round(-path)}°` : ` · aim → ${Math.round(path)}°`;
  shotLine.textContent = `${pct}% power${aim}`;
  tvLine.textContent = '';
}

detector.onSwing = (s) => emitSwing(s);
detector.onPrep = (side) => {
  if (mode !== 'bowl' && mode !== 'sword' && mode !== 'bow') link.send({ type: 'prep', side, lat: Math.round(link.lat) });
};

// Live motion meter — reassures players that the sensor works.
let liveRaf = 0;
function liveLoop() {
  const v = Math.min(1, detector.live / 20);
  gaugeLive.style.transform = `scale(${0.72 + v * 0.45})`;
  gaugeLive.style.opacity = String(0.15 + v * 0.7);
  // bowling: the ring round the ball fills with the swing (and falls back slowly)
  if (mode === 'bowl' && gripId !== null && motionOK) setMeter(Math.max(Math.min(1, bowl.live / 14), gripMeter * 0.94));
  // the duel: how the blade lies, and the ring round the guard fills with the swing
  if (mode === 'sword') {
    showGuardAngle();
    // (a hand holding still wobbles at up to ~1 rad/s: that's not a swing); a blow's
    // power stays up a moment to be read, then drops
    const held = performance.now() < meterHoldUntil;
    if (motionOK) setSwordMeter(Math.max(Math.min(1, Math.max(0, sword.live - 1) / 17), held ? swordMeter : swordMeter * 0.9));
  }
  liveRaf = requestAnimationFrame(liveLoop);
}

function onOrient(e: DeviceOrientationEvent) {
  const now = performance.now();
  rec?.orient(e, now);
  front.orientEvent({ t: now, alpha: e.alpha, beta: e.beta, gamma: e.gamma });
  if (orient.heading === null && joined) orient.calibrate();
}

// Stream the racket's orientation so the in-game racket mirrors the phone —
// and while bowling with the ball in the hand, the arm's swing, so the bowler
// on screen mirrors that. In the duel it's the sword (without motion sensors,
// held the way the guard toggle says).
function sendOri() {
  if (link.status !== 'online') return;
  if (mode === 'sword' && !motionOK) {
    const p = touchPose();
    link.send({ type: 'ori', s: p.s, n: p.n });
    return;
  }
  if (mode === 'bow' && !motionOK) {
    // no motion sensor: the drag on the DRAW pad turns an imaginary phone pointed at the screen
    const a = -dragAim.dx * 0.0011,
      b = -dragAim.dy * 0.0011;
    const r2 = (x: number) => Math.round(x * 1000) / 1000;
    const s: [number, number, number] = [r2(-Math.sin(a) * Math.cos(b)), r2(Math.cos(a) * Math.cos(b)), r2(Math.sin(b))];
    const n: [number, number, number] = [r2(Math.sin(a) * Math.sin(b)), r2(-Math.cos(a) * Math.sin(b)), r2(Math.cos(b))];
    link.send({ type: 'ori', s, n });
    return;
  }
  if (!orient.have || orient.heading === null) return;
  const r2 = (v: [number, number, number]) => v.map((x) => Math.round(x * 100) / 100) as [number, number, number];
  const msg: Extract<PadMsg, { type: 'ori' }> = { type: 'ori', s: r2(orient.devToPlayer([0, 1, 0])), n: r2(orient.devToPlayer([0, 0, 1])) };
  if (mode === 'bowl' && gripId !== null && motionOK) msg.arm = Math.round(bowl.arm * 100) / 100;
  link.send(msg);
}
let oriTimer = 0;
let swordOriTimer = 0;
function startOriStream() {
  clearInterval(oriTimer);
  clearInterval(swordOriTimer);
  oriTimer = window.setInterval(
    () => {
      if (mode === 'play' || mode === 'serve' || mode === 'menu' || mode === 'bowl') sendOri();
    },
    link.transport === 'http' ? 100 : 50,
  );
  // the sword follows the phone 1:1 and the guard's angle decides blocks: a little quicker
  swordOriTimer = window.setInterval(
    () => {
      if (mode === 'sword' || mode === 'bow') sendOri();
    },
    link.transport === 'http' ? 100 : 33,
  );
}

function onMotion(e: DeviceMotionEvent) {
  const now = performance.now();
  rec?.motion(e, now);
  const m = front.motionEvent(rawMotion(e, now));
  if (!m) return;
  motionSeen = true;
  const { rx, ry, rz, q, dt, ax, ay, az } = m;
  {
    // vertical acceleration (the sign quirks of iOS cancel in this product)
    const gx0 = m.igx - ax,
      gy0 = m.igy - ay,
      gz0 = m.igz - az;
    const gl = Math.hypot(gx0, gy0, gz0);
    const aUp = gl > 1 ? (ax * gx0 + ay * gy0 + az * gz0) / gl : 0;
    liftCheck(now, aUp, Math.hypot(rx, ry, rz), dt);
  }
  bowl.heading = orient.heading;
  // (the acceleration only if the phone reports it: some Androids don't)
  bowl.push({
    t: now,
    rx,
    ry,
    rz,
    q,
    ...(m.hasAcc && m.hasIg ? { ax, ay, az, gx: m.igx - ax, gy: m.igy - ay, gz: m.igz - az } : {}),
  });
  // the duel: "towards the screen" keeps itself honest while the sword is held still facing it
  if (mode === 'sword') orient.autoCenter(dt);
  sword.heading = orient.heading;
  sword.push(swordSample(m));
  detector.push(swingSample(m, orient));
}

function requestMotion(): Promise<boolean> {
  const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
  if (!DME || !window.isSecureContext) return Promise.resolve(false);
  const start = () => {
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrient);
    return new Promise<boolean>((resolve) => setTimeout(() => resolve(motionSeen), 1200));
  };
  if (typeof DME.requestPermission === 'function') {
    // Must be invoked synchronously inside the tap handler.
    return DME.requestPermission()
      .then((res) => (res === 'granted' ? start() : false))
      .catch(() => false);
  }
  return start();
}

/** Where a touch is, in the phone's own portrait axes (the page may be turned: see portrait.ts). */
const at = (e: PointerEvent) => toDevice(e.clientX, e.clientY);

// Swipe fallback (desktop testing, or phones without a gyroscope).
function attachSwipe(el: HTMLElement) {
  let sx = 0,
    sy = 0,
    st = 0,
    active = false;
  el.addEventListener('pointerdown', (e) => {
    active = true;
    ({ x: sx, y: sy } = at(e));
    st = performance.now();
  });
  el.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    const dt = Math.max(16, performance.now() - st);
    const p = at(e);
    const dx = p.x - sx,
      dy = p.y - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 40) return;
    const speed = dist / dt; // px per ms
    const power = Math.max(0, Math.min(1, (speed - 0.4) / 2.6));
    const spin = Math.max(-1, Math.min(1, -dy / Math.max(60, dist)));
    // right→left swipe = forehand for a right-hander
    const side = Math.abs(dx) < dist * 0.4 ? 'oh' : (dx < 0) === (prefs.handed !== 'L') ? 'fh' : 'bh';
    emitSwing({ t: performance.now(), power, spin: Math.abs(spin) < 0.35 ? 0 : spin, peak: speed, duration: dt, side, yaw: 0, attack: Math.round(Math.asin(spin) * 57.3), omega: [0, 0, 0], q: null }, true);
  });
}
attachSwipe(swipeZone);
attachSwipe(tossBtn);

// ------------------------------------------------------------------ bowling

// Hold the grip pad = the ball is in your hand. With motion: swing back, then
// forward, and let go at the bottom — the detector measures the swing. Without:
// drag up the pad and let go (the swipe gives the speed, line and curve).
// Either way: 'grip' down on touch, 'grip' up then 'bowl' on letting go.

let gripPts: SwipePoint[] = [];
let gripMeter = 0;
let gripIdleTimer = 0;

function setMeter(v: number) {
  if (Math.abs(v - gripMeter) < 0.002 && v !== 0) return;
  gripMeter = v;
  gripWrap.style.setProperty('--p', v.toFixed(3));
}

function gripLabels(big: string, sub: string) {
  gripBig.textContent = big;
  gripSub.textContent = sub;
}

/** ready for the next ball */
function gripIdle() {
  clearTimeout(gripIdleTimer);
  gripBall.classList.remove('held', 'thrown');
  gripLabels('HOLD', motionOK ? 'swing & let go' : 'drag up & let go');
}

gripBall.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (mode !== 'bowl' || locked || !joined || gripId !== null) return;
  gripId = e.pointerId;
  try {
    gripBall.setPointerCapture(e.pointerId);
  } catch {}
  for (const up of lockedBtnUps) up(); // the palm on ◀ ▶ as the thumb lands isn't a move
  const now = performance.now();
  bowl.heading = orient.heading;
  bowl.grip(now);
  gripPts = [{ t: now, ...at(e) }];
  link.send({ type: 'grip', down: true, lat: Math.round(link.lat) });
  audio.tick();
  clearTimeout(gripIdleTimer);
  gripBall.classList.remove('thrown');
  gripBall.classList.add('held');
  gripLabels(motionOK ? 'SWING' : 'DRAG UP', 'let go to bowl');
  bowlTv.textContent = '';
  setMeter(0);
});

gripBall.addEventListener('pointermove', (e) => {
  if (e.pointerId !== gripId) return;
  const p = at(e);
  gripPts.push({ t: performance.now(), ...p });
  if (gripPts.length > 400) gripPts.splice(1, 200); // (keep the start: the stroke is measured from it)
  // no motion sensor: the meter follows the drag up
  if (!motionOK) setMeter(Math.max(0, Math.min(1, (gripPts[0].y - p.y) / 300)));
});

const gripUp = (e: PointerEvent) => {
  if (e.pointerId !== gripId) return;
  if (e.type === 'pointerup') gripPts.push({ t: performance.now(), ...at(e) });
  throwBall();
};
gripBall.addEventListener('pointerup', gripUp);
gripBall.addEventListener('pointercancel', gripUp);
gripBall.addEventListener('lostpointercapture', gripUp);
gripBall.addEventListener('contextmenu', (e) => e.preventDefault());

/** The grip was let go: the throw. */
function throwBall() {
  const touch = !motionOK;
  const lat = Math.round(link.lat);
  if (!touch) sendOri(); // the pose (and arm) it left the hand in
  gripId = null;
  lockUntil = performance.now() + 700;
  // tell the TV at once; the measurement takes a moment
  link.send({ type: 'grip', down: false, lat });
  const r = touch ? swipeThrow(gripPts) : bowl.release(performance.now());
  bowl.cancel();
  link.send({ type: 'bowl', speed: +r.speed.toFixed(2), angle: +r.angle.toFixed(3), spin: +r.spin.toFixed(2), lat, touch });
  showThrow(r);
}

/** The game left the bowling screen with the ball still in the hand: drop it, no throw. */
function gripCancel() {
  if (gripId === null) return;
  const id = gripId;
  gripId = null;
  bowl.cancel();
  try {
    gripBall.releasePointerCapture(id);
  } catch {}
  link.send({ type: 'grip', down: false, lat: Math.round(link.lat) });
  gripIdle();
  setMeter(0);
}

function showThrow(r: BowlThrow) {
  gripBall.classList.remove('held');
  gripBall.classList.add('thrown');
  gripLabels(r.speed.toFixed(1), 'm/s');
  const p = (r.speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED);
  setMeter(Math.max(0.02, p));
  gripWrap.classList.remove('pop');
  void gripWrap.offsetWidth;
  gripWrap.classList.add('pop');
  const deg = Math.round((Math.abs(r.angle) * 180) / Math.PI);
  const line = deg < 1 ? 'straight' : `${deg}° ${r.angle > 0 ? 'right' : 'left'}`;
  const hook = Math.abs(r.spin) < 0.15 ? 'no hook' : `${Math.abs(r.spin) > 0.6 ? 'big hook' : 'hook'} ${r.spin > 0 ? '←' : '→'}`;
  bowlShot.textContent = `${r.speed.toFixed(1)} m/s · ${line} · ${hook}`;
  audio.swish(p);
  clearTimeout(gripIdleTimer);
  gripIdleTimer = window.setTimeout(() => {
    if (gripId === null) gripIdle();
  }, 2600);
}

// ------------------------------------------------------------------ sword duel

// Hold the GUARD pad = guard: 'guard' down, the sword guards at whatever
// angle the phone is held (streamed as 'ori'), and swings only move it. Let
// go to attack, as in Chambara — a swing then is a 'slash', a push at the
// screen a 'thrust'. Without motion: swipe the pad above the guard to slash,
// tap it to thrust, and the toggle sets the guard's angle.

let swordMeter = 0;
let meterHoldUntil = 0;
let shownLine: GuardLine | '' = '';
let shownTurn = 0;
const LINE_NAME: Record<GuardLine, string> = {
  vertical: 'vertical',
  horizontal: 'horizontal',
  rising: 'diagonal ╱',
  falling: 'diagonal ╲',
  forward: 'pointed ahead',
};

/** without motion sensors: the sword held upright or across the body (a right hand's blade points left), screen to the face */
function touchPose(): { s: Vec3; n: Vec3 } {
  if (touchGuard === 'vertical') return { s: [0, 0.25, 0.97], n: [0, -0.97, 0.25] };
  const x = prefs.handed === 'L' ? 1 : -1;
  return { s: [0.97 * x, 0.25, 0], n: [0.25 * x, -0.97, 0] };
}

/** the guard pad's sword lies as the blade does across your view, and says how */
function showGuardAngle() {
  let s: Vec3;
  if (!motionOK) s = touchPose().s;
  else if (orient.have) s = orient.devToPlayer([0, 1, 0]);
  else return;
  const { angle, line } = guardLine(s);
  // clockwise from pointing up, the nearest way round from where it is (no spin through 180°)
  let turn = Math.round(90 - (angle * 180) / Math.PI);
  turn += 360 * Math.round((shownTurn - turn) / 360);
  if (turn !== shownTurn) {
    shownTurn = turn;
    bladeEl.style.transform = `rotate(${turn}deg)`;
  }
  if (line !== shownLine) {
    shownLine = line;
    guardSub.textContent = LINE_NAME[line];
    guardPad.dataset.line = line;
  }
}

function setSwordMeter(v: number) {
  if (v < 0.01) v = 0; // (fall right back to empty, not stop just short of it)
  if (Math.abs(v - swordMeter) < 0.002 && v !== 0) return;
  if (v === 0 && swordMeter === 0) return;
  swordMeter = v;
  guardWrap.style.setProperty('--p', v.toFixed(3));
}

guardPad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (mode !== 'sword' || !joined) return;
  try {
    guardPad.setPointerCapture(e.pointerId);
  } catch {}
  guardPtrs.add(e.pointerId);
  if (!guarding) guardDown();
});
// held while any finger is on it: a thumb shifting its grip doesn't drop the guard
const guardLift = (e: PointerEvent) => {
  if (!guardPtrs.delete(e.pointerId) || guardPtrs.size) return;
  guardUp();
};
guardPad.addEventListener('pointerup', guardLift);
guardPad.addEventListener('pointercancel', guardLift);
guardPad.addEventListener('lostpointercapture', guardLift);
guardPad.addEventListener('contextmenu', (e) => e.preventDefault());

function guardDown() {
  guarding = true;
  for (const up of lockedBtnUps) up(); // the palm on pause as the thumb lands isn't a press
  sword.guard(true, performance.now());
  rec?.event('guard', { down: true });
  sendOri(); // the angle it went up at
  link.send({ type: 'guard', down: true, lat: Math.round(link.lat) });
  guardPad.classList.add('held');
  audio.guard();
}

function guardUp() {
  guarding = false;
  const now = performance.now();
  sword.guard(false, now);
  rec?.event('guard', { down: false });
  sendOri();
  link.send({ type: 'guard', down: false, lat: Math.round(link.lat) });
  guardPad.classList.remove('held');
  lockUntil = Math.max(lockUntil, now + 300);
}

/** The duel moved on with the guard held: let go of it. */
function guardCancel() {
  if (!guarding) return;
  const ids = [...guardPtrs];
  guardPtrs.clear();
  guardUp();
  for (const id of ids)
    try {
      guardPad.releasePointerCapture(id);
    } catch {}
}

/** A slash or a thrust — from the motion, or a swipe on the pad. Never with the guard held. */
function attack(s: SwordStrike, touch: boolean) {
  rec?.event('strike', { kind: s.kind, dir: +s.dir.toFixed(3), power: +s.power.toFixed(3), peak: +s.peak.toFixed(2), at: +s.t.toFixed(1), touch, sent: mode === 'sword' && joined && !guarding });
  if (mode !== 'sword' || !joined || guarding) return;
  sendOri(); // the pose it struck in
  link.send({ type: 'slash', kind: s.kind, dir: +s.dir.toFixed(3), power: +s.power.toFixed(2), lat: Math.round(link.lat), touch });
  // a hand flailing after a blow isn't pressing pause
  lockUntil = Math.max(lockUntil, performance.now() + 400);
  showStrike(s);
}
sword.onStrike = (s) => attack(s, false);
// a swing that was nearly one, or one made with the guard held: say so, or it feels like the phone missed it
let hintUntil = 0;
function swordHintLine(text: string) {
  const now = performance.now();
  if (mode !== 'sword' || !joined || now < hintUntil) return;
  hintUntil = now + 900;
  swordShot.textContent = text;
  swordTv.textContent = '';
}
sword.onNear = (n) => {
  rec?.event('near', { peak: +n.peak.toFixed(2), need: +n.need.toFixed(2), dir: +n.dir.toFixed(3), at: +n.t.toFixed(1) });
  swordHintLine(`${ARROWS[(Math.round(n.dir / (Math.PI / 4)) + 8) % 8]} Swing harder!`);
  audio.tick();
};
sword.onGuarded = (s) => {
  rec?.event('guarded', { kind: s.kind, dir: +s.dir.toFixed(3), peak: +s.peak.toFixed(2), at: +s.t.toFixed(1) });
  swordHintLine('Guarding — let go of GUARD to strike');
};

const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
function showStrike(s: SwordStrike) {
  const what = s.kind === 'thrust' ? 'THRUST' : `SLASH ${ARROWS[(Math.round(s.dir / (Math.PI / 4)) + 8) % 8]}`;
  swordShot.textContent = `${what} · ${Math.round(s.power * 100)}%`;
  swordTv.textContent = '';
  setSwordMeter(Math.max(0.04, s.power));
  meterHoldUntil = performance.now() + 600;
  guardWrap.classList.remove('pop');
  void guardWrap.offsetWidth;
  guardWrap.classList.add('pop');
  if (s.kind === 'thrust') audio.thrust(s.power);
  else audio.slash(s.power);
  haptic(0.3 + 0.5 * s.power); // (Android: every swing the phone saw, you feel)
}

swordRecenter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (handBusy()) return;
  if (orient.calibrate()) {
    audio.select();
    showToast('Re-centered on the TV');
    sendOri();
  } else {
    audio.back();
    showToast(orient.have ? 'Point the phone at the TV, not up' : 'No motion sensor');
  }
});

// no motion sensor: swipe to slash, tap to thrust (timed by the events
// themselves: a busy main thread hands them over in bunches)
let swipeId: number | null = null;
let swipePts: SwipePoint[] = [];
const stamp = (e: PointerEvent) => (e.timeStamp > 0 && Math.abs(e.timeStamp - performance.now()) < 1000 ? e.timeStamp : performance.now());
slashZone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (mode !== 'sword' || motionOK || !joined || swipeId !== null) return;
  swipeId = e.pointerId;
  try {
    slashZone.setPointerCapture(e.pointerId);
  } catch {}
  swipePts = [{ t: stamp(e), ...at(e) }];
  slashZone.classList.add('down');
});
slashZone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== swipeId) return;
  swipePts.push({ t: stamp(e), ...at(e) });
  if (swipePts.length > 300) swipePts.splice(1, 150); // (keep the start: the stroke is measured from it)
});
const swipeEnd = (e: PointerEvent) => {
  if (e.pointerId !== swipeId) return;
  swipeId = null;
  slashZone.classList.remove('down');
  if (e.type !== 'pointerup') return; // cancelled: nothing
  swipePts.push({ t: stamp(e), ...at(e) });
  const s = swipeStrike(swipePts);
  if (s) attack(s, true);
};
slashZone.addEventListener('pointerup', swipeEnd);
slashZone.addEventListener('pointercancel', swipeEnd);
slashZone.addEventListener('lostpointercapture', swipeEnd);

function syncGuardToggle() {
  for (const b of [guardVert, guardHorz]) b.classList.toggle('on', b.dataset.g === touchGuard);
}
syncGuardToggle();
for (const b of [guardVert, guardHorz]) {
  // (not locked while guarding: flipping the guard with the other hand is the point)
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    touchGuard = b.dataset.g === 'horizontal' ? 'horizontal' : 'vertical';
    store.set('guard', touchGuard);
    syncGuardToggle();
    showGuardAngle();
    audio.tick();
    if (mode === 'sword') sendOri();
  });
}

// ------------------------------------------------------------------ archery

/** the pointer holding DRAW (the string is pulled back), or null */
let drawId: number | null = null;
let drawT0 = 0;
let drawRaf = 0;
/** no motion sensor: how far the finger has dragged since the draw began (px) */
const dragAim = { x0: 0, y0: 0, dx: 0, dy: 0 };
/** as the TV's RANGE.drawT: the ring fills as the string comes back */
const DRAW_T = 900;

function drawIdle() {
  drawPad.classList.remove('held');
  drawBig.textContent = 'DRAW';
  drawSub.textContent = motionOK ? 'hold · aim · let go' : 'hold · drag · let go';
  drawWrap.style.setProperty('--p', '0');
}

function drawMeter() {
  if (drawId === null) return;
  drawWrap.style.setProperty('--p', Math.min(1, (performance.now() - drawT0) / DRAW_T).toFixed(3));
  drawRaf = requestAnimationFrame(drawMeter);
}

drawPad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (mode !== 'bow' || locked || !joined || drawId !== null) return;
  drawId = e.pointerId;
  try {
    drawPad.setPointerCapture(e.pointerId);
  } catch {}
  for (const up of lockedBtnUps) up(); // the palm on pause as the thumb lands isn't a press
  drawT0 = performance.now();
  ({ x: dragAim.x0, y: dragAim.y0 } = at(e));
  dragAim.dx = dragAim.dy = 0;
  sendOri(); // where the aim starts from
  link.send({ type: 'draw', down: true, lat: Math.round(link.lat) });
  drawPad.classList.add('held');
  drawBig.textContent = 'AIM';
  drawSub.textContent = motionOK ? 'point · let go' : 'drag · let go';
  bowTv.textContent = '';
  audio.creak();
  cancelAnimationFrame(drawRaf);
  drawRaf = requestAnimationFrame(drawMeter);
});

drawPad.addEventListener('pointermove', (e) => {
  if (e.pointerId !== drawId) return;
  const p = at(e);
  dragAim.dx = p.x - dragAim.x0;
  dragAim.dy = p.y - dragAim.y0;
});

const drawLift = (e: PointerEvent) => {
  if (e.pointerId !== drawId) return;
  drawId = null;
  cancelAnimationFrame(drawRaf);
  sendOri(); // the aim it left the bow on
  link.send({ type: 'draw', down: false, lat: Math.round(link.lat) });
  const held = performance.now() - drawT0;
  // a hand coming off the pad after a shot isn't pressing pause
  lockUntil = Math.max(lockUntil, performance.now() + 400);
  if (held > DRAW_T * 0.25) {
    audio.twang(Math.min(1, held / DRAW_T));
    bowShot.textContent = held >= DRAW_T ? 'LOOSED · full draw' : `LOOSED · ${Math.round((held / DRAW_T) * 100)}% draw`;
    drawWrap.classList.remove('pop');
    void drawWrap.offsetWidth;
    drawWrap.classList.add('pop');
  } else bowShot.textContent = 'hold DRAW longer to shoot';
  drawIdle();
};
drawPad.addEventListener('pointerup', drawLift);
drawPad.addEventListener('pointercancel', drawLift);
drawPad.addEventListener('lostpointercapture', drawLift);
drawPad.addEventListener('contextmenu', (e) => e.preventDefault());

/** The game moved on mid-draw: let go of the string. */
function drawCancel() {
  if (drawId === null) return;
  const id = drawId;
  drawId = null;
  cancelAnimationFrame(drawRaf);
  try {
    drawPad.releasePointerCapture(id);
  } catch {}
  link.send({ type: 'draw', down: false, lat: Math.round(link.lat) });
  drawIdle();
}

// ------------------------------------------------------------------ join

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && joined) void keepAwake();
});

joinBtn.addEventListener('click', () => {
  nameInput.blur();
  window.scrollTo(0, 0);
  prefs.name = nameInput.value.trim().slice(0, 12);
  store.set('name', prefs.name);
  audio.unlock();
  const motion = requestMotion();
  void keepAwake();
  joined = true;
  root.dataset.screen = 'remote';
  nameLabel.textContent = prefs.name || 'Player';
  setMode('wait', 'Connecting…', '');
  link.connect();
  motion.then((ok) => {
    motionOK = ok;
    if (!ok) showToast(window.isSecureContext ? 'No motion sensor: swipe to swing' : 'Motion needs https', 2200);
    setMode(mode);
    if (link.status === 'online') {
      link.send({ type: 'hello', name: prefs.name || 'Player', handed: prefs.handed, ver: 1, motion: motionOK, ...(prefs.look ? { look: prefs.look } : {}) });
    }
    cancelAnimationFrame(liveRaf);
    liveLoop();
    startOriStream();
  });
});

recenterBtn.addEventListener('click', () => {
  if (orient.calibrate()) {
    audio.select();
    showToast('Aim recentered');
  } else {
    audio.back();
    showToast(orient.have ? 'Point the phone at the screen, not up' : 'No motion sensor');
  }
});

// Also unlock audio on any later tap (iOS can suspend the context).
root.addEventListener('pointerdown', (e) => {
  if (joined && audio.ctx && audio.ctx.state !== 'running') audio.unlock();
  // a tap you can feel on everything you press (where the phone can)
  if (joined && (e.target as Element).closest?.('.pb, .grip, .guard, .toss, .gseg-btn, .sbtn button, .slash-zone')) haptic(0.3);
});

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

if (new URLSearchParams(location.search).has('auto')) joinBtn.click();
