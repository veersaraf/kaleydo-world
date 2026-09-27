// Portrait only. People swing the phone around, and iOS Safari turns the page
// to landscape whenever it ends up on its side; it has no
// screen.orientation.lock(). So when the page goes landscape we turn the whole
// remote back the other way (CSS), and it stays fixed to the phone's own
// portrait axes: the grip stays under the thumb, the buttons where they were.
//
//   window.orientation  90 (the top of the phone to the left)  → rotate(-90deg)
//   window.orientation -90 (the top of the phone to the right) → rotate(90deg)
//
// While turned, the safe-area insets swap sides (the CSS maps them onto
// --sat/--sar/--sab/--sal, which the layout uses instead of env()), sizes come
// from the remote's own box (container units, not vw/vh), and touch
// coordinates are in the page's axes: toDevice() maps them back to the
// phone's (for the swipes and drags that measure a direction).
//
// Motion is unaffected: devicemotion / deviceorientation always report in the
// device's own frame, whichever way the page is shown.
//
// An installed home-screen web app locks to portrait natively (the manifest's
// "orientation": "portrait"); this is for Safari.

export type Rot = 0 | 90 | -90;

let rot: Rot = 0;
const listeners: ((r: Rot) => void)[] = [];
const off = new URLSearchParams(location.search).get('rotate') === '0';
const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;

/** The screen's rotation from its natural (portrait) orientation, degrees, or null if unknown. */
function screenAngle(): number | null {
  // iOS Safari: window.orientation is the long-standing, reliable one
  const wo = (window as unknown as { orientation?: unknown }).orientation;
  if (typeof wo === 'number') return wo;
  const a = screen.orientation?.angle;
  if (typeof a === 'number') return a > 180 ? a - 360 : a;
  return null;
}

function isPhone() {
  return !!coarse?.matches || navigator.maxTouchPoints > 0;
}

function update() {
  const W = window.innerWidth,
    H = window.innerHeight;
  let next: Rot = 0;
  if (!off && isPhone() && W > H) {
    const a = screenAngle();
    // an on-screen keyboard can make a portrait page wider than tall (Android):
    // only a turned screen, or a wide page nobody is typing on, counts
    const typing = document.activeElement instanceof HTMLInputElement;
    if (a === 90 || a === -90 || !typing) next = a === -90 ? 90 : -90;
  }
  const el = document.documentElement;
  if (next) {
    el.style.setProperty('--app-w', `${H}px`);
    el.style.setProperty('--app-h', `${W}px`);
  }
  if (next === rot) return;
  // no transitions while the whole layout swaps round
  el.classList.add('rotating');
  if (next) el.dataset.rot = String(next);
  else delete el.dataset.rot;
  rot = next;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('rotating')));
  for (const f of listeners) f(rot);
}

/** Watch the page's orientation and keep the remote upright. */
export function keepPortrait() {
  // (a real lock where there is one: Android, installed or full-screen; Safari says no)
  try {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    so?.lock?.('portrait')?.catch(() => {});
  } catch {}
  update();
  const later = () => {
    update();
    // iOS reports the new size a moment after it says it turned
    setTimeout(update, 120);
    setTimeout(update, 450);
  };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', later);
  screen.orientation?.addEventListener?.('change', later);
  window.visualViewport?.addEventListener('resize', update);
  document.addEventListener('focusout', () => setTimeout(update, 60));
}

export function rotation(): Rot {
  return rot;
}

export function onRotate(f: (r: Rot) => void) {
  listeners.push(f);
}

/** A touch's page coordinates → the remote's own (the phone's portrait axes). */
export function toDevice(x: number, y: number): { x: number; y: number } {
  if (rot === -90) return { x: window.innerHeight - y, y: x };
  if (rot === 90) return { x: y, y: window.innerWidth - x };
  return { x, y };
}
