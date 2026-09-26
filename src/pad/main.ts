import '@fontsource/fredoka/latin-400.css';
import '@fontsource/fredoka/latin-600.css';
import '@fontsource/fredoka/latin-700.css';
import './pad.css';

import { PadLink, type LinkStatus } from './link';
import { SwingDetector, type SwingEvent } from './swing';
import { Orientation, qrot } from './orient';
import { PadAudio } from './audio';
import type { Handed, PadButton, PadMode, ServerToPad } from '../shared/protocol';
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

const tossBtn = h('button', { class: 'toss' }, h('b', {}, 'TAP TO TOSS'), h('span', {}, 'then swing to serve'));
const servePanel = h('div', { class: 'panel serve' }, tossBtn);

const skipBtn = h('button', { class: 'toss skip' }, h('b', {}, 'SKIP'), h('span', {}, 'replay'));
const skipPanel = h('div', { class: 'panel skip' }, skipBtn, h('div', { class: 'row3' }, h('span', {}), padBtn('home', 'small home', h('i', { class: 'house' })), h('span', {})));

const waitTitle = h('div', { class: 'wtitle' }, 'Connecting…');
const waitHint = h('div', { class: 'whint' }, '');
const waitPanel = h('div', { class: 'panel wait' }, h('div', { class: 'spinner' }), waitTitle, waitHint);

const panels: Record<PadMode, HTMLElement> = {
  menu: menuPanel,
  play: playPanel,
  serve: servePanel,
  wait: waitPanel,
  watch: waitPanel,
  skip: skipPanel,
};

const leds = h('div', { class: 'leds' }, h('i'), h('i'), h('i'), h('i'));
const footer = h('footer', {}, leds, h('div', { class: 'brand' }, 'KALEIDO'));
const flash = h('div', { class: 'flash' });
const toast = h('div', { class: 'toast' });
const remoteScreen = h(
  'section',
  { class: 'remote' },
  header,
  h('div', { class: 'shell' }, menuPanel, playPanel, servePanel, waitPanel, skipPanel),
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
const link = new PadLink(pid, () => prefs.name || 'Player');
let slot = -1;
let mode: PadMode = 'wait';
let motionOK = false;
let motionSeen = false;
let seq = 0;
let joined = false;

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
    audio.tick();
    sendPrefs();
  });
}
for (const b of sensBtns) {
  b.addEventListener('click', () => {
    prefs.sens = Number(b.dataset.s);
    detector.sensitivity = prefs.sens;
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

function doFlash(strong = false) {
  flash.classList.remove('go', 'strong');
  void flash.offsetWidth;
  flash.classList.add('go');
  if (strong) flash.classList.add('strong');
}

function setMode(m: PadMode, title?: string, hint?: string) {
  mode = m;
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
    tossBtn.querySelector('b')!.textContent = title || 'TAP TO TOSS';
    tossBtn.querySelector('span')!.textContent = hint || 'then swing to serve';
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
    case 'fx':
      switch (m.fx) {
        case 'hit':
          audio.hit(m.power ?? 0.6);
          doFlash();
          if (m.label) tvLine.textContent = [m.label, m.detail].filter(Boolean).join(' · ');
          break;
        case 'perfect':
          audio.hit(m.power ?? 0.8, true);
          doFlash(true);
          showToast('PERFECT!');
          if (m.label) tvLine.textContent = [m.label, m.detail].filter(Boolean).join(' · ');
          break;
        case 'whiff':
          tvLine.textContent = m.label ? `MISS · ${m.label}` : 'MISS';
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
    case 'bye':
      if (m.reason === 'replaced') setMode('wait', 'Opened elsewhere', 'This remote is active in another tab');
      break;
  }
}

link.onMessage = onMessage;
link.onStatus = setStatus;
setInterval(() => {
  if (link.status === 'online') netMs.textContent = `${Math.round(link.lat * 2)}ms`;
}, 1000);

// ------------------------------------------------------------------ buttons

for (const el of root.querySelectorAll<HTMLButtonElement>('.pb')) {
  const b = el.dataset.b as PadButton;
  const up = () => {
    if (!el.classList.contains('down')) return;
    el.classList.remove('down');
    link.send({ type: 'btn', b, down: false });
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {}
    el.classList.add('down');
    audio.tick();
    // pressing A in a menu means you're looking at the phone, facing the screen:
    // a good moment to refresh which way "towards the screen" is
    if (b === 'a' && mode === 'menu') orient.calibrate();
    link.send({ type: 'btn', b, down: true });
  });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}

tossBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!joined) return;
  link.send({ type: 'toss', lat: link.lat });
  audio.toss();
  tossBtn.classList.add('tossed');
  tossBtn.querySelector('b')!.textContent = 'SWING!';
  tossBtn.querySelector('span')!.textContent = motionOK ? 'hit it at the top' : 'swipe up here to serve';
});

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
detector.onPrep = (side) => link.send({ type: 'prep', side, lat: Math.round(link.lat) });

// Live motion meter — reassures players that the sensor works.
let liveRaf = 0;
function liveLoop() {
  const v = Math.min(1, detector.live / 20);
  gaugeLive.style.transform = `scale(${0.72 + v * 0.45})`;
  gaugeLive.style.opacity = String(0.15 + v * 0.7);
  liveRaf = requestAnimationFrame(liveLoop);
}

const D2R = Math.PI / 180;
let lastMotionT = 0;
const prevRate = [0, 0, 0];

function onOrient(e: DeviceOrientationEvent) {
  orient.measure(e.alpha, e.beta, e.gamma, performance.now());
  if (orient.heading === null && joined) orient.calibrate();
}

// Stream the racket's orientation so the in-game racket mirrors the phone.
let oriTimer = 0;
function startOriStream() {
  clearInterval(oriTimer);
  oriTimer = window.setInterval(
    () => {
      if (!orient.have || orient.heading === null || link.status !== 'online') return;
      if (mode !== 'play' && mode !== 'serve' && mode !== 'menu') return;
      const r2 = (v: [number, number, number]) => v.map((x) => Math.round(x * 100) / 100) as [number, number, number];
      link.send({ type: 'ori', s: r2(orient.devToPlayer([0, 1, 0])), n: r2(orient.devToPlayer([0, 0, 1])) });
    },
    link.transport === 'http' ? 100 : 50,
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
  prevRate[0] = rx;
  prevRate[1] = ry;
  prevRate[2] = rz;
  detector.push({
    t: now,
    up: orient.have ? orient.upDevice() : undefined,
    q: orient.have ? [orient.q[0], orient.q[1], orient.q[2], orient.q[3]] : undefined,
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
