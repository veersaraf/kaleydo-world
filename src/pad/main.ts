import '@fontsource/fredoka/latin-400.css';
import '@fontsource/fredoka/latin-600.css';
import '@fontsource/fredoka/latin-700.css';
import './pad.css';

import { PadLink, type LinkStatus } from './link';
import { SwingDetector, type SwingEvent } from './swing';
import { BowlDetector, swipeThrow, MIN_SPEED, MAX_SPEED, type BowlThrow, type SwipePoint } from './bowl';
import { SwordDetector, swipeStrike, guardLine, type GuardLine, type SwordStrike } from './sword';
import { Orientation, qrot, type Vec3 } from './orient';
import { PadAudio } from './audio';
import type { Handed, PadButton, PadFx, PadMode, PadMsg, ServerToPad } from '../shared/protocol';
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

const prefs = {
  name: store.get('name', ''),
  handed: (store.get('handed', 'R') as Handed) || 'R',
  sens: Number(store.get('sens', '1')) || 1,
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

const app = document.getElementById('app')!;
const root = h('div', { class: 'pad', 'data-screen': 'join' });
app.append(root);

// join screen
const nameInput = h('input', {
  class: 'name-input',
  maxlength: '12',
  placeholder: 'Your name',
  autocomplete: 'off',
  autocapitalize: 'words',
  spellcheck: 'false',
});
nameInput.value = prefs.name;
const handL = h('button', { class: 'seg-btn', 'data-h': 'L' }, 'Left hand');
const handR = h('button', { class: 'seg-btn', 'data-h': 'R' }, 'Right hand');
const joinBtn = h('button', { class: 'join-btn' }, h('span', {}, 'Join game'));
const joinNote = h('p', { class: 'join-note' }, 'Hold your phone like a racket handle. Swing to hit.');
const joinScreen = h(
  'section',
  { class: 'join' },
  h('div', { class: 'logo', 'aria-label': 'KALEIDO' }, ...'KALEIDO'.split('').map((ch, i) => h('span', { style: `--i:${i}` }, ch))),
  h('div', { class: 'tagline' }, 'Your phone is the remote'),
  h('div', { class: 'card' }, nameInput, h('div', { class: 'seg' }, handL, handR), joinBtn, joinNote),
  h(
    'details',
    { class: 'cert' },
    h('summary', {}, 'Optional: remove the security warning'),
    h(
      'ol',
      {},
      h('li', {}, 'Tap ', h('a', { href: '/kaleido-ca.crt' }, 'Download certificate'), ' and choose Allow.'),
      h('li', {}, 'Settings → General → VPN & Device Management → KALEIDO → Install.'),
      h('li', {}, 'Settings → General → About → Certificate Trust Settings → turn on KALEIDO.'),
    ),
    h('p', {}, 'This only trusts games served from your own Mac, and makes the remote connect faster.'),
  ),
);

// remote screen
const badge = h('span', { class: 'badge' }, 'P?');
const nameLabel = h('span', { class: 'who' }, '');
const scoreLine = h('span', { class: 'score' }, '');
const netDot = h('i', { class: 'dot' });
const netMs = h('b', {}, '');
const gearBtn = h('button', { class: 'gear', 'aria-label': 'Settings' }, '⚙');
const header = h('header', {}, badge, nameLabel, scoreLine, h('span', { class: 'net' }, netDot, netMs), gearBtn);

function padBtn(b: PadButton, cls: string, label: string | Node) {
  const el = h('button', { class: `pb ${cls}`, 'data-b': b }, label);
  return el;
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
const menuPanel = h('div', { class: 'panel menu' }, dpad, aBtn, row, bBtn);

const gaugeRing = h('div', { class: 'ring' });
const gaugeLive = h('div', { class: 'live' });
const gaugeText = h('div', { class: 'gtext' }, h('b', {}, 'SWING'), h('span', {}, ''));
const shotLine = h('div', { class: 'shotline' }, '');
const tvLine = h('div', { class: 'tvline' }, '');
const playTitle = h('div', { class: 'ptitle' }, '');
const playHint = h('div', { class: 'phint' }, 'Swing like a racket');
const swipeZone = h('div', { class: 'swipe-zone' }, 'No motion sensor — swipe here to swing');
const playPanel = h(
  'div',
  { class: 'panel play' },
  playTitle,
  h('div', { class: 'gauge' }, gaugeLive, gaugeRing, gaugeText),
  shotLine,
  tvLine,
  playHint,
  swipeZone,
  h('div', { class: 'row3' }, h('span', {}), padBtn('home', 'small home', h('i', { class: 'house' })), h('span', {})),
);

const tossBtn = h('button', { class: 'toss' }, h('b', {}, 'LIFT TO TOSS'), h('span', {}, 'raise the phone (or tap here), then swing'));
const servePanel = h('div', { class: 'panel serve' }, tossBtn);

const skipBtn = h('button', { class: 'toss skip' }, h('b', {}, 'SKIP'), h('span', {}, 'replay'));
const skipPanel = h('div', { class: 'panel skip' }, skipBtn, h('div', { class: 'row3' }, h('span', {}), padBtn('home', 'small home', h('i', { class: 'house' })), h('span', {})));

const waitTitle = h('div', { class: 'wtitle' }, 'Connecting…');
const waitHint = h('div', { class: 'whint' }, '');
const waitPanel = h('div', { class: 'panel wait' }, h('div', { class: 'spinner' }), waitTitle, waitHint);

// bowling: the phone is the ball. Hold the big grip pad (the ball is in your
// hand), swing back and forward, let go at the bottom. Move (◀ ▶) and aim
// (↺ ↻) sit low in the corners, well away from where the thumb rests.
const SVG = 'http://www.w3.org/2000/svg';
/** a small line icon: `stroke` is drawn as a line, `fill` as a solid shape */
function icon(stroke: string, fill: string) {
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
    p.setAttribute('stroke-width', filled ? '1.6' : '2.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}
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
const bowlHome = padBtn('home', 'small home bhome', h('i', { class: 'house' }));
bowlHome.dataset.lock = '';
bowlHome.setAttribute('aria-label', 'Pause');
const bowlPanel = h(
  'div',
  { class: 'panel bowl' },
  bowlHome,
  h('div', { class: 'bhead' }, bowlTitle, bowlHint),
  bowlTv,
  gripWrap,
  bowlShot,
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
const bowHome = padBtn('home', 'small home', h('i', { class: 'house' }));
bowHome.dataset.lock = '';
bowHome.setAttribute('aria-label', 'Pause');
const bowPanel = h(
  'div',
  { class: 'panel bow' },
  h('div', { class: 'stop' }, h('div', { class: 'sbtn' }, bowHome, h('span', {}, 'PAUSE')), h('div', { class: 'shead' }, bowTitle, bowHint), h('div', { class: 'sbtn' })),
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
};

const leds = h('div', { class: 'leds' }, h('i'), h('i'), h('i'), h('i'));
const footer = h('footer', {}, leds, h('div', { class: 'brand' }, 'KALEIDO'));
const flash = h('div', { class: 'flash' });
const toast = h('div', { class: 'toast' });
const remoteScreen = h(
  'section',
  { class: 'remote' },
  header,
  h('div', { class: 'shell' }, menuPanel, playPanel, servePanel, waitPanel, skipPanel, bowlPanel, swordPanel, bowPanel),
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
const setName = h('input', { class: 'name-input', maxlength: '12', autocomplete: 'off' });
const setL = h('button', { class: 'seg-btn', 'data-h': 'L' }, 'Left hand');
const setR = h('button', { class: 'seg-btn', 'data-h': 'R' }, 'Right hand');
const sheetClose = h('button', { class: 'join-btn small' }, h('span', {}, 'Done'));
const motionState = h('p', { class: 'join-note' }, '');
const recenterBtn = h('button', { class: 'join-btn small recenter' }, h('span', {}, 'Recenter aim'));
const recenterNote = h('p', { class: 'join-note' }, 'Point the top of your phone at the screen, then tap.');
const sheet = h(
  'section',
  { class: 'sheet' },
  h(
    'div',
    { class: 'sheet-card' },
    h('h2', {}, 'Remote settings'),
    setName,
    h('div', { class: 'seg' }, setL, setR),
    h('div', { class: 'label' }, 'Swing sensitivity'),
    h('div', { class: 'seg three' }, ...sensBtns),
    recenterBtn,
    recenterNote,
    motionState,
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
const orient = new Orientation();
const bowl = new BowlDetector();
bowl.sensitivity = prefs.sens;
const sword = new SwordDetector();
sword.sensitivity = prefs.sens;
sword.upSign = detector.upSign;
const link = new PadLink(pid, () => prefs.name || 'Player');
let slot = -1;
let mode: PadMode = 'wait';
let motionOK = false;
let motionSeen = false;
let seq = 0;
let joined = false;
/** which game the TV's fx lines are about (they can arrive while on 'watch') */
let sport: 'tennis' | 'bowl' | 'duel' | 'archery' = 'tennis';
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

function setColor(c: string) {
  root.style.setProperty('--pc', c);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', c);
}
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
  if (joined) link.send({ type: 'prefs', name: prefs.name || 'Player', handed: prefs.handed });
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

/** a white flash in the player's colour; 'red' when you're hit, 'steel' when your guard holds */
function doFlash(strong = false, tint: '' | 'red' | 'steel' = '') {
  flash.classList.remove('go', 'strong', 'red', 'steel');
  void flash.offsetWidth;
  flash.classList.add('go');
  if (strong) flash.classList.add('strong');
  if (tint) flash.classList.add(tint);
}

function setMode(m: PadMode, title?: string, hint?: string) {
  const prev = mode;
  mode = m;
  if (m === 'bowl') sport = 'bowl';
  else if (m === 'sword') sport = 'duel';
  else if (m === 'bow') sport = 'archery';
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
  for (const el of new Set(Object.values(panels))) el.classList.remove('on');
  panels[m].classList.add('on');
  if (m === 'wait' || m === 'watch') {
    waitTitle.textContent = title || (m === 'watch' ? 'Watching' : 'You’re in!');
    waitHint.textContent = hint || 'Look at the big screen';
  }
  if (m === 'play') {
    playTitle.textContent = title || '';
    playHint.textContent = hint || 'Swing like a racket';
  }
  if (m === 'skip') {
    skipBtn.querySelector('b')!.textContent = title || 'SKIP';
    skipBtn.querySelector('span')!.textContent = hint || 'replay';
  }
  if (m === 'serve') {
    tossBtn.classList.remove('tossed');
    tossBtn.querySelector('b')!.textContent = title || (motionOK ? 'LIFT TO TOSS' : 'TAP TO TOSS');
    tossBtn.querySelector('span')!.textContent = hint || (motionOK ? 'raise the phone (or tap here), then swing' : 'then swing to serve');
  }
  if (m === 'bowl') {
    bowlTitle.textContent = title || 'Your turn!';
    bowlHint.textContent = hint || (motionOK ? 'Hold the ball, swing back, then forward' : 'Hold the ball, drag up and let go');
    if (gripId === null) gripIdle();
  }
  if (m === 'bow') {
    bowTitle.textContent = title || 'Your turn!';
    bowHint.textContent = hint || (motionOK ? 'Point at the target · hold DRAW · let go' : 'Hold DRAW · drag to aim · let go');
    if (drawId === null) drawIdle();
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
  swipeZone.classList.toggle('on', !motionOK && (m === 'play' || m === 'serve'));
  servePanel.classList.toggle('swipe', !motionOK);
}

function setStatus(s: LinkStatus) {
  netDot.className = 'dot ' + s;
  if (s !== 'online') netMs.textContent = s === 'connecting' ? '…' : 'offline';
  if (s === 'offline' || s === 'connecting') {
    if (slot < 0) setMode('wait', s === 'connecting' ? 'Connecting…' : 'Disconnected', 'Make sure KALEIDO is running on your Mac');
  } else if (joined) {
    link.send({ type: 'hello', name: prefs.name || 'Player', handed: prefs.handed, ver: 1, motion: motionOK });
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
      if (mode === 'wait') setMode('menu');
      break;
    case 'full':
      setMode('wait', 'Game is full', 'Four remotes are already connected');
      break;
    case 'mode':
      setMode(m.mode, m.title, m.hint);
      break;
    case 'score':
      scoreLine.textContent = m.line;
      break;
    case 'fx': {
      if (sport === 'duel') {
        duelFx(m);
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
      switch (m.fx) {
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
  if (link.status === 'online') netMs.textContent = `${Math.round(link.lat * 2)}ms`;
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

// Lift to toss (Switch Sports-style): while it's your serve, raising the phone
// sharply tosses the ball. It has to start from a still phone, so waving it
// around while you wait doesn't toss; the lift itself is never a swing.
let liftV = 0;
let lastStill = 0;
let lastLift = 0;
let noSwingUntil = 0;
function liftCheck(now: number, aUp: number, w: number, dt: number) {
  if (mode !== 'serve' || !joined || tossBtn.classList.contains('tossed')) {
    liftV = 0;
    return;
  }
  if (w < 1.5 && Math.abs(aUp) < 1.5) lastStill = now;
  liftV = Math.max(0, liftV * Math.exp(-dt / 0.25) + aUp * dt);
  if (liftV > 0.55 && now - lastStill < 700 && now - lastLift > 1200) {
    lastLift = now;
    liftV = 0;
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

gearBtn.addEventListener('click', () => {
  setName.value = prefs.name;
  motionState.textContent = motionOK
    ? 'Motion sensor: on'
    : 'Motion sensor unavailable — the swipe pad is used instead.';
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

const D2R = Math.PI / 180;
let lastMotionT = 0;
const prevRate = [0, 0, 0];

function onOrient(e: DeviceOrientationEvent) {
  orient.measure(e.alpha, e.beta, e.gamma, performance.now());
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
  const r = e.rotationRate;
  if (!r || (r.alpha == null && r.beta == null)) return;
  motionSeen = true;
  const a = e.acceleration;
  const g = e.accelerationIncludingGravity;
  const ax = a?.x ?? 0,
    ay = a?.y ?? 0,
    az = a?.z ?? 0;
  const now = performance.now();
  const rx = (r.beta ?? 0) * D2R,
    ry = (r.gamma ?? 0) * D2R,
    rz = (r.alpha ?? 0) * D2R;
  const dt = lastMotionT ? Math.min(0.05, (now - lastMotionT) / 1000) : 1 / 60;
  lastMotionT = now;
  // trapezoidal: the rate over the interval is the mean of its two ends (a one-sided
  // sum runs a whole sample ahead — ~15° at the peak of a hard swing)
  orient.integrate((rx + prevRate[0]) / 2, (ry + prevRate[1]) / 2, (rz + prevRate[2]) / 2, dt);
  {
    // vertical acceleration (the sign quirks of iOS cancel in this product)
    const gx0 = (g?.x ?? 0) - ax,
      gy0 = (g?.y ?? 0) - ay,
      gz0 = (g?.z ?? 0) - az;
    const gl = Math.hypot(gx0, gy0, gz0);
    const aUp = gl > 1 ? (ax * gx0 + ay * gy0 + az * gz0) / gl : 0;
    liftCheck(now, aUp, Math.hypot(rx, ry, rz), dt);
  }
  prevRate[0] = rx;
  prevRate[1] = ry;
  prevRate[2] = rz;
  const q: [number, number, number, number] | undefined = orient.have ? [orient.q[0], orient.q[1], orient.q[2], orient.q[3]] : undefined;
  bowl.heading = orient.heading;
  // (the acceleration only if the phone reports it: some Androids don't)
  bowl.push({
    t: now,
    rx,
    ry,
    rz,
    q,
    ...(a && a.x != null && g && g.x != null ? { ax, ay, az, gx: (g.x ?? 0) - ax, gy: (g.y ?? 0) - ay, gz: (g.z ?? 0) - az } : {}),
  });
  sword.heading = orient.heading;
  sword.push({
    t: now,
    rx,
    ry,
    rz,
    q,
    ...(a && a.x != null ? { ax, ay, az } : {}),
    ...(g && g.x != null ? { igx: g.x ?? 0, igy: g.y ?? 0, igz: g.z ?? 0 } : {}),
  });
  detector.push({
    t: now,
    up: orient.have ? orient.upDevice() : undefined,
    q,
    rx,
    ry,
    rz,
    ax,
    ay,
    az,
    gx: (g?.x ?? 0) - ax,
    gy: (g?.y ?? 0) - ay,
    gz: (g?.z ?? 0) - az,
  });
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

// Swipe fallback (desktop testing, or phones without a gyroscope).
function attachSwipe(el: HTMLElement) {
  let sx = 0,
    sy = 0,
    st = 0,
    active = false;
  el.addEventListener('pointerdown', (e) => {
    active = true;
    sx = e.clientX;
    sy = e.clientY;
    st = performance.now();
  });
  el.addEventListener('pointerup', (e) => {
    if (!active) return;
    active = false;
    const dt = Math.max(16, performance.now() - st);
    const dx = e.clientX - sx,
      dy = e.clientY - sy;
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
  if (mode !== 'bowl' || !joined || gripId !== null) return;
  gripId = e.pointerId;
  try {
    gripBall.setPointerCapture(e.pointerId);
  } catch {}
  for (const up of lockedBtnUps) up(); // the palm on ◀ ▶ as the thumb lands isn't a move
  const now = performance.now();
  bowl.heading = orient.heading;
  bowl.grip(now);
  gripPts = [{ t: now, x: e.clientX, y: e.clientY }];
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
  gripPts.push({ t: performance.now(), x: e.clientX, y: e.clientY });
  if (gripPts.length > 400) gripPts.splice(1, 200); // (keep the start: the stroke is measured from it)
  // no motion sensor: the meter follows the drag up
  if (!motionOK) setMeter(Math.max(0, Math.min(1, (gripPts[0].y - e.clientY) / 300)));
});

const gripUp = (e: PointerEvent) => {
  if (e.pointerId !== gripId) return;
  if (e.type === 'pointerup') gripPts.push({ t: performance.now(), x: e.clientX, y: e.clientY });
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
  sendOri(); // the angle it went up at
  link.send({ type: 'guard', down: true, lat: Math.round(link.lat) });
  guardPad.classList.add('held');
  audio.guard();
}

function guardUp() {
  guarding = false;
  const now = performance.now();
  sword.guard(false, now);
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
  if (mode !== 'sword' || !joined || guarding) return;
  sendOri(); // the pose it struck in
  link.send({ type: 'slash', kind: s.kind, dir: +s.dir.toFixed(3), power: +s.power.toFixed(2), lat: Math.round(link.lat), touch });
  // a hand flailing after a blow isn't pressing pause
  lockUntil = Math.max(lockUntil, performance.now() + 400);
  showStrike(s);
}
sword.onStrike = (s) => attack(s, false);

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
  swipePts = [{ t: stamp(e), x: e.clientX, y: e.clientY }];
  slashZone.classList.add('down');
});
slashZone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== swipeId) return;
  swipePts.push({ t: stamp(e), x: e.clientX, y: e.clientY });
  if (swipePts.length > 300) swipePts.splice(1, 150); // (keep the start: the stroke is measured from it)
});
const swipeEnd = (e: PointerEvent) => {
  if (e.pointerId !== swipeId) return;
  swipeId = null;
  slashZone.classList.remove('down');
  if (e.type !== 'pointerup') return; // cancelled: nothing
  swipePts.push({ t: stamp(e), x: e.clientX, y: e.clientY });
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
  if (mode !== 'bow' || !joined || drawId !== null) return;
  drawId = e.pointerId;
  try {
    drawPad.setPointerCapture(e.pointerId);
  } catch {}
  for (const up of lockedBtnUps) up(); // the palm on pause as the thumb lands isn't a press
  drawT0 = performance.now();
  dragAim.x0 = e.clientX;
  dragAim.y0 = e.clientY;
  dragAim.dx = dragAim.dy = 0;
  sendOri(); // where the aim starts from
  link.send({ type: 'draw', down: true, lat: Math.round(link.lat) });
  drawPad.classList.add('held');
  drawBig.textContent = 'AIM';
  drawSub.textContent = motionOK ? 'point at the target · let go' : 'drag to aim · let go';
  bowTv.textContent = '';
  audio.creak();
  cancelAnimationFrame(drawRaf);
  drawRaf = requestAnimationFrame(drawMeter);
});

drawPad.addEventListener('pointermove', (e) => {
  if (e.pointerId !== drawId) return;
  dragAim.dx = e.clientX - dragAim.x0;
  dragAim.dy = e.clientY - dragAim.y0;
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
      link.send({ type: 'hello', name: prefs.name || 'Player', handed: prefs.handed, ver: 1, motion: motionOK });
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
root.addEventListener('pointerdown', () => {
  if (joined && audio.ctx && audio.ctx.state !== 'running') audio.unlock();
});

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

if (new URLSearchParams(location.search).has('auto')) joinBtn.click();
