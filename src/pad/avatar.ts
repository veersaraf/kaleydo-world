// The player's character as a little face on the phone — the same pieces the TV
// builds in 3D (skin, hair style and colour, eyes, a cap or band in the shirt's
// shade), drawn flat so the editor can show every change instantly.

import type { Hair, Eyes } from '../tv/chars/look';

export interface FaceLook {
  skin: string;
  hair: Hair | string;
  hairColor: string;
  eyes: Eyes | string;
  /** the shirt: caps, bands and beanies are a darker shade of it */
  shirt: string;
}

const SVG = 'http://www.w3.org/2000/svg';

/** a colour a little darker (k < 0) or lighter (k > 0) */
function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  const r = f((n >> 16) & 255),
    g = f((n >> 8) & 255),
    b = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** hair (or headwear) drawn over the head: [path, fill] layers */
function hairLayers(hair: string, col: string, hat: string): [string, string][] {
  // the head is a circle at (60, 66) r 34; the crown of it is at y 32
  const top = 'M26 64C26 38 42 29 60 29C78 29 94 38 94 64C88 52 76 46 60 46C44 46 32 52 26 64Z';
  switch (hair) {
    case 'none':
      return [];
    case 'cap':
      return [
        ['M25 60C25 36 42 26 60 26C78 26 95 36 95 60C80 52 40 52 25 60Z', hat],
        ['M58 54C74 50 96 52 106 60C96 64 74 62 58 58Z', shade(hat, -0.18)],
      ];
    case 'spiky':
      return [['M25 64L27 44L34 50L36 32L45 42L50 25L57 38L63 23L69 38L76 26L80 42L88 33L88 50L95 45L95 64C88 52 76 46 60 46C44 46 32 52 25 64Z', col]];
    case 'bob':
      return [['M22 86C18 50 34 28 60 28C86 28 102 50 98 86L88 86C90 62 80 50 60 50C40 50 30 62 32 86Z', col]];
    case 'bun':
      return [
        ['M60 8a11 11 0 1 1 0 22a11 11 0 1 1 0-22Z', col],
        [top, col],
      ];
    case 'band':
      return [
        [top, col],
        ['M26 58C40 50 80 50 94 58L94 66C80 58 40 58 26 66Z', hat],
      ];
    case 'beanie':
      return [
        ['M60 12a6 6 0 1 1 0 12a6 6 0 1 1 0-12Z', shade(hat, 0.25)],
        ['M24 60C24 34 42 22 60 22C78 22 96 34 96 60Z', hat],
        ['M22 58C40 52 80 52 98 58L98 66C80 60 40 60 22 66Z', shade(hat, -0.15)],
      ];
    case 'mohawk':
      return [['M52 48L50 20L56 28L60 14L64 28L70 20L68 48Z', col]];
    case 'pony':
      return [
        ['M88 44C104 50 108 72 98 90C96 74 92 62 84 54Z', col],
        [top, col],
      ];
    case 'afro':
      return [['M60 12C88 12 104 30 102 56C100 62 96 64 94 64C88 52 76 46 60 46C44 46 32 52 26 64C24 64 20 62 18 56C16 30 32 12 60 12Z', col]];
    case 'bowl':
      return [['M25 66C23 38 40 27 60 27C80 27 97 38 95 66L95 60C80 57 40 57 25 60Z', col]];
    case 'crown':
      return [['M34 40L38 18L49 30L60 12L71 30L82 18L86 40Z', '#ffd23a']];
    default:
      return [[top, col]];
  }
}

function eyePaths(eyes: string): { d: string; stroke?: boolean }[] {
  const pair = (f: (x: number) => string) => [{ d: f(47) }, { d: f(73) }];
  const ell = (rx: number, ry: number) => (x: number) => `M${x - rx} 66a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
  switch (eyes) {
    case 'dot':
      return pair(ell(3.6, 3.6));
    case 'tall':
      return pair(ell(3.6, 7.5));
    case 'wide':
      return pair(ell(6.2, 4.6));
    case 'sleepy':
      return pair((x) => `M${x - 6} 66Q${x} 70 ${x + 6} 66`).map((p) => ({ ...p, stroke: true }));
    default:
      return pair(ell(4.4, 5.8));
  }
}

/** The face as an SVG element (a fresh one each call). */
export function avatarSvg(look: FaceLook) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('aria-hidden', 'true');
  const add = (d: string, fill: string, extra: Record<string, string> = {}) => {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill);
    for (const [k, v] of Object.entries(extra)) p.setAttribute(k, v);
    svg.append(p);
  };
  const hat = shade(look.shirt, -0.25);
  const hair = String(look.hair);
  // shoulders in the shirt colour
  add('M16 120C18 98 36 92 60 92C84 92 102 98 104 120Z', look.shirt);
  // an afro sits behind the head
  if (hair === 'afro') for (const [d, f] of hairLayers('afro', look.hairColor, hat)) add(d, f);
  // ears and head
  add('M22 70a7 7 0 1 1 0.1 0Z', shade(look.skin, -0.08));
  add('M98 70a7 7 0 1 1 0.1 0Z', shade(look.skin, -0.08));
  add('M26 66a34 34 0 1 0 68 0a34 34 0 1 0 -68 0Z', look.skin);
  // eyes, cheeks, smile
  for (const e of eyePaths(String(look.eyes))) add(e.d, e.stroke ? 'none' : '#2b2440', e.stroke ? { stroke: '#2b2440', 'stroke-width': '3', 'stroke-linecap': 'round' } : {});
  add('M34 78a6.5 4 0 1 0 13 0a6.5 4 0 1 0 -13 0Z', 'rgba(255,120,140,.35)');
  add('M73 78a6.5 4 0 1 0 13 0a6.5 4 0 1 0 -13 0Z', 'rgba(255,120,140,.35)');
  add('M51 82Q60 90 69 82', 'none', { stroke: '#2b2440', 'stroke-width': '3', 'stroke-linecap': 'round' });
  // hair / headwear on top
  if (hair !== 'afro') for (const [d, f] of hairLayers(hair, look.hairColor, hat)) add(d, f);
  else add('M26 64C32 52 44 46 60 46C76 46 88 52 94 64C88 44 76 38 60 38C44 38 32 44 26 64Z', look.hairColor);
  return svg;
}
