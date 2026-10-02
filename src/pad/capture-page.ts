// The motion recorder (capture.html, or /rec on the server): walks a player
// through a short labelled set of sword moves — "5 slashes to the right", "5
// chops", "hold GUARD and turn the sword"… — while every raw motion sample,
// button press and label goes to the server (captures/<file>.jsonl). The
// remote's sword detector runs live alongside, so the player sees what it made
// of each swing (and the recording keeps that too). Replay a capture offline
// with scripts/tools/replay-capture.ts.

import { Recorder, captureName } from './capture';
import { MotionFront, swordSample, rawMotion } from './pipeline';
import { SwordDetector, type SwordStrike } from './sword';

interface Step {
  id: string;
  title: string;
  text: string;
  /** what the detector should make of it: a direction (rad), 'thrust', 'none', or 'any' */
  expect: number | 'thrust' | 'none' | 'any';
}

const STEPS: Step[] = [
  { id: 'still', title: 'Hold still', text: 'Hold the sword ready — phone upright in your fist, screen towards you, grip at the bottom — and keep it still for 5 seconds.', expect: 'none' },
  { id: 'right', title: '5 slashes → right', text: 'Swing so the tip goes from your left to your right. Rest a second between swings.', expect: 0 },
  { id: 'left', title: '5 slashes ← left', text: 'Swing so the tip goes from your right to your left.', expect: Math.PI },
  { id: 'down', title: '5 chops ↓ down', text: 'Raise the sword and chop down, however you naturally would.', expect: -Math.PI / 2 },
  { id: 'up', title: '5 rising cuts ↑ up', text: 'From low, swing the tip up.', expect: Math.PI / 2 },
  { id: 'down-left', title: '5 diagonals ↙', text: 'From over your right shoulder down towards your left hip.', expect: (-3 * Math.PI) / 4 },
  { id: 'down-right', title: '5 diagonals ↘', text: 'From over your left shoulder down towards your right hip.', expect: -Math.PI / 4 },
  { id: 'thrust', title: '5 thrusts', text: 'Jab the phone straight at the TV and pull it back.', expect: 'thrust' },
  { id: 'lazy', title: '5 lazy swings', text: 'Any direction, as lazily as you might late in a long game.', expect: 'any' },
  { id: 'guard', title: 'Guard', text: 'Hold GUARD (below) with your thumb the whole time. Turn the sword upright, then flat across, then diagonal — a second each.', expect: 'none' },
  { id: 'combo', title: 'Back and forth ×3', text: 'Three times: slash right, then straight back left.', expect: 'any' },
  { id: 'free', title: 'Free play', text: 'Fight an imaginary opponent for 20 seconds: swing, guard, thrust — whatever feels natural.', expect: 'any' },
];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
const arrow = (dir: number) => ARROWS[(Math.round(dir / (Math.PI / 4)) + 8) % 8];
const describe = (s: SwordStrike) => (s.kind === 'thrust' ? 'THRUST' : `SLASH ${arrow(s.dir)}`) + ` ${Math.round(s.power * 100)}%`;

const app = document.getElementById('app')!;
const who = new URLSearchParams(location.search).get('name') || 'swings';

// ---- the page
const recEl = h('span', {}, '');
const top = h('div', { class: 'top' }, h('span', {}, 'Kaleydo World motion capture'), recEl);
const stepN = h('div', { class: 'step-n' }, '');
const title = h('h1', {}, 'Record your swings');
const text = h('p', {}, 'This records how your phone moves while you swing it, so the sword duel can be tuned to real hands. It takes about 5 minutes. Stand where you play, facing the TV.');
const card = h('div', { class: 'card' }, stepN, title, text);
const startBtn = h('button', {}, 'Start (allow motion)');
const doneBtn = h('button', {}, 'Done ✓');
const redoBtn = h('button', { class: 'ghost' }, 'Redo');
const recenterBtn = h('button', { class: 'ghost' }, 'Re-center');
const skipBtn = h('button', { class: 'ghost' }, 'Skip');
const row = h('div', { class: 'row' }, startBtn);
const live = h('div', { class: 'live' }, '');
const meter = h('i');
const meterEl = h('div', { class: 'meter' }, meter);
const log = h('div', { class: 'log' }, '');
const guardEl = h('div', { class: 'guard', role: 'button' }, 'GUARD');
const status = h('div', { class: 'status' }, '');
app.append(top, card, row, meterEl, live, log, guardEl, status);

// ---- state
let rec: Recorder | null = null;
const front = new MotionFront();
const sword = new SwordDetector();
sword.upSign = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? -1 : 1;
let step = -1;
let active = false;
let motionSeen = false;
let seen: string[] = [];

function setStatus() {
  if (!rec) return;
  const kb = rec.bytes / 1024;
  status.textContent = `${rec.failing ? 'upload failing — retrying · ' : ''}captures/${rec.file}.jsonl · ${kb < 1024 ? kb.toFixed(0) + ' KB' : (kb / 1024).toFixed(1) + ' MB'} · gyro axes: ${front.axes.sure ? front.axes.name : 'finding…'}`;
  status.classList.toggle('bad', rec.failing);
}

function show() {
  if (step >= STEPS.length) {
    stepN.textContent = 'All done';
    title.textContent = 'Thank you!';
    text.textContent = `Saved as captures/${rec?.file}.jsonl on the computer running Kaleydo World. You can close this page.`;
    row.replaceChildren();
    live.textContent = '';
    return;
  }
  const s = STEPS[step];
  stepN.textContent = `Step ${step + 1} of ${STEPS.length}${active ? ' · RECORDING' : ''}`;
  title.textContent = s.title;
  text.textContent = s.text;
  row.replaceChildren(...(active ? [redoBtn, doneBtn] : [recenterBtn, skipBtn, startBtn]));
  startBtn.textContent = 'Start ▶';
}

function begin() {
  const s = STEPS[step];
  active = true;
  seen = [];
  log.textContent = '';
  live.textContent = '';
  rec?.event('seg', { phase: 'start', label: s.id, step, expect: s.expect });
  show();
}

function end(ok: boolean) {
  const s = STEPS[step];
  rec?.event('seg', { phase: ok ? 'end' : 'redo', label: s.id, step, detected: seen });
  active = false;
  if (ok) step++;
  show();
  void rec?.flush();
}

// ---- the live detector
sword.onStrike = (s) => {
  const d = describe(s);
  rec?.event('strike', { kind: s.kind, dir: +s.dir.toFixed(3), power: +s.power.toFixed(3), peak: +s.peak.toFixed(2), sweep: +s.sweep.toFixed(2), at: +s.t.toFixed(1) });
  live.className = 'live';
  live.textContent = d;
  if (active) {
    seen.push(s.kind === 'thrust' ? 'T' : arrow(s.dir));
    log.textContent = `detected: ${seen.join(' ')}`;
  }
  navigator.vibrate?.(30);
};
sword.onNear = (n) => {
  rec?.event('near', { peak: +n.peak.toFixed(2), need: +n.need.toFixed(2), dir: +n.dir.toFixed(3), at: +n.t.toFixed(1) });
  live.className = 'live near';
  live.textContent = `swing harder ${arrow(n.dir)}`;
};
sword.onGuarded = (s) => {
  rec?.event('guarded', { kind: s.kind, dir: +s.dir.toFixed(3), peak: +s.peak.toFixed(2), at: +s.t.toFixed(1) });
  live.className = 'live guarded';
  live.textContent = 'guarding (let go to strike)';
};

function onOrient(e: DeviceOrientationEvent) {
  const t = performance.now();
  rec?.orient(e, t);
  front.orientEvent({ t, alpha: e.alpha, beta: e.beta, gamma: e.gamma });
  if (front.orient.heading === null) front.orient.calibrate();
}

let lastMeter = 0;
function onMotion(e: DeviceMotionEvent) {
  const t = performance.now();
  rec?.motion(e, t);
  const m = front.motionEvent(rawMotion(e, t));
  if (!m) return;
  motionSeen = true;
  if (!guarding) front.orient.autoCenter(m.dt);
  sword.heading = front.orient.heading;
  sword.push(swordSample(m));
  if (t - lastMeter > 50) {
    lastMeter = t;
    meter.style.width = `${Math.min(100, (sword.live / 13) * 100).toFixed(0)}%`;
  }
}

startBtn.addEventListener('click', async () => {
  if (rec) return begin();
  // the first tap: ask for the sensors (iOS wants it inside the tap)
  const DME = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  try {
    if (typeof DME?.requestPermission === 'function' && (await DME.requestPermission()) !== 'granted') throw new Error('denied');
    if (typeof DOE?.requestPermission === 'function') await DOE.requestPermission().catch(() => 'denied');
  } catch {
    text.textContent = 'Motion access was refused. In Safari: aA → Website Settings → Motion & Orientation Access, then reload.';
    return;
  }
  if (!window.isSecureContext) {
    text.textContent = 'This page needs the https:// address (the one the QR code on the TV opens).';
    return;
  }
  rec = new Recorder(captureName(who), { page: 'capture', steps: STEPS.map((s) => s.id) });
  rec.onStatus = setStatus;
  recEl.textContent = '● REC';
  recEl.className = 'rec';
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOrient);
  setTimeout(() => {
    if (!motionSeen) text.textContent = 'No motion data is arriving. Is this a phone, on the https:// address?';
  }, 1500);
  step = 0;
  show();
});
doneBtn.addEventListener('click', () => end(true));
redoBtn.addEventListener('click', () => end(false));
skipBtn.addEventListener('click', () => {
  rec?.event('seg', { phase: 'skip', label: STEPS[step].id, step });
  step++;
  show();
});
recenterBtn.addEventListener('click', () => {
  const ok = front.orient.calibrate();
  rec?.event('recenter', { ok });
  live.className = 'live';
  live.textContent = ok ? 'centred on the TV' : 'hold the phone towards the TV';
});

// ---- GUARD: held while any finger is on it
let guarding = false;
const guardPtrs = new Set<number>();
guardEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try {
    guardEl.setPointerCapture(e.pointerId);
  } catch {}
  guardPtrs.add(e.pointerId);
  if (guarding) return;
  guarding = true;
  guardEl.classList.add('held');
  sword.guard(true, performance.now());
  rec?.event('guard', { down: true });
});
const guardLift = (e: PointerEvent) => {
  if (!guardPtrs.delete(e.pointerId) || guardPtrs.size || !guarding) return;
  guarding = false;
  guardEl.classList.remove('held');
  sword.guard(false, performance.now());
  rec?.event('guard', { down: false });
};
guardEl.addEventListener('pointerup', guardLift);
guardEl.addEventListener('pointercancel', guardLift);
guardEl.addEventListener('lostpointercapture', guardLift);
guardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// (the page going away: send what's left)
addEventListener('pagehide', () => {
  rec?.event('pagehide');
  rec?.stop();
});
