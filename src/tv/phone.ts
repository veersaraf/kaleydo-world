// The phone preview: what a phone sees when it opens the TV page (kaleydo.world) directly.
//
// A phone can't be the TV and the racket at once, so instead of the whole game (every world
// primed, the menus, a QR code it can't scan) it gets a taste: the intro, then straight into a
// short singles match in Sports Park, tapping to swing, and a card that sends it to a laptop.
// Decided once, here, before anything else is built; the flow and the app read PHONE.
//
//   a phone   = a coarse pointer and a small screen (the shorter side under 600 CSS px)
//   ?tv=1     = never (the full game, whatever the device)
//   ?phone=1  = always (testing on a desktop)
//
// Tablets, laptops and TVs are not phones by this rule. The local server's phone pages
// (/join, /c) are other pages and never load this.

function detect(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('tv') === '1') return false;
    if (q.get('phone') === '1') return true;
    return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  } catch {
    return false;
  }
}

export const PHONE = detect();

/** what the phone preview's share and copy buttons hand on */
export const SITE_URL = 'https://kaleydo.world';

if (PHONE) {
  document.documentElement.classList.add('phone');
  // no pinch or double-tap zoom on the game, and the page reaches under the notch (the HUD keeps clear with env(safe-area-inset-*))
  const vp = document.querySelector('meta[name="viewport"]');
  vp?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
}
