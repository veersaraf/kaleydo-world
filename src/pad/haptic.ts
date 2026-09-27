// A little tap you can feel. Android has navigator.vibrate; iOS Safari has no
// vibration API, but since iOS 18 flipping an <input type="checkbox" switch>
// plays the system's haptic tick, and clicking its label from a touch handler
// does that. Elsewhere this does nothing (the sound and the visuals carry it).

let label: HTMLLabelElement | null = null;
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** strength 0..1 (Android: how long it buzzes; iOS has the one tick) */
export function haptic(strength = 0.3) {
  try {
    if (!iOS) {
      navigator.vibrate?.(Math.round(8 + strength * 30));
      return;
    }
    if (!label) {
      label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      label.append(input);
      document.body.append(label);
    }
    label.click();
  } catch {}
}
