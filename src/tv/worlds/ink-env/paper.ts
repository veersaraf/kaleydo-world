// Rice paper, baked once: the ink pass reads it instead of evaluating noise per
// pixel (three fbm calls a pixel cost more than the whole scene). One tileable
// RGBA texture, laid on the screen like the sheet under the painting:
//   r  kozo fibres: long, curling strands a little lighter or darker than the sheet
//   g  granulation: fine clumps where pigment settles into the paper's tooth
//   b  broad, soft variation (period 1/2 tile): wash levels, stroke pressure
//   a  mid-scale variation (period 1/8 tile): bleeding, dry-brush breaks

import * as THREE from 'three';

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise, `cells` lattice cells across the tile (fbm with `oct` octaves), 0..1. */
function tileFbm(size: number, cells: number, oct: number, rnd: () => number) {
  const out = new Float32Array(size * size);
  let amp = 1,
    norm = 0;
  for (let o = 0; o < oct; o++, cells *= 2, amp *= 0.5) {
    const c = Math.min(cells, size);
    const lat = Float32Array.from({ length: c * c }, rnd);
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * c,
        y0 = Math.floor(fy),
        ty = fy - y0,
        sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % c) * c,
        r1 = ((y0 + 1) % c) * c;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * c,
          x0 = Math.floor(fx),
          tx = fx - x0,
          sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % c,
          c1 = (x0 + 1) % c;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    norm += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Fibres drawn on a canvas, wrapped at the edges so the tile repeats seamlessly. */
function fibres(size: number, rnd: () => number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d')!;
  x.fillStyle = 'rgb(128,128,128)';
  x.fillRect(0, 0, size, size);
  x.lineCap = 'round';
  const n = Math.round((size * size) / 700);
  for (let i = 0; i < n; i++) {
    const light = rnd() < 0.62;
    const len = 20 + rnd() * rnd() * 120;
    let px = rnd() * size,
      py = rnd() * size,
      a = rnd() * Math.PI * 2;
    const pts: [number, number][] = [[px, py]];
    for (let k = 0; k < 6; k++) {
      a += (rnd() - 0.5) * 0.9;
      px += (Math.cos(a) * len) / 6;
      py += (Math.sin(a) * len) / 6;
      pts.push([px, py]);
    }
    const v = light ? 150 + rnd() * 70 : 70 + rnd() * 40;
    x.strokeStyle = `rgba(${v},${v},${v},${0.35 + rnd() * 0.45})`;
    x.lineWidth = 0.6 + rnd() * rnd() * 1.8;
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        x.beginPath();
        x.moveTo(pts[0][0] + ox, pts[0][1] + oy);
        for (let k = 1; k < pts.length; k++) x.lineTo(pts[k][0] + ox, pts[k][1] + oy);
        x.stroke();
      }
  }
  const img = x.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = img[i * 4] / 255;
  return out;
}

export function paperTexture(size = 512, seed = 11) {
  const rnd = mulberry(seed);
  const fib = fibres(size, rnd);
  // grain: a fine noise, clumped by a coarser one
  const fine = tileFbm(size, size / 4, 2, rnd);
  const clump = tileFbm(size, size / 32, 2, rnd);
  const broad = tileFbm(size, 2, 5, rnd);
  const mid = tileFbm(size, 8, 4, rnd);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const g = Math.min(1, Math.max(0, (fine[i] - 0.5) * 1.6 + (clump[i] - 0.5) * 1.2 + 0.5));
    data[i * 4] = Math.round(fib[i] * 255);
    data[i * 4 + 1] = Math.round(g * 255);
    // stretch the fbm's narrow middle over the whole range
    data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, (broad[i] - 0.5) * 2.2 + 0.5)) * 255);
    data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, (mid[i] - 0.5) * 2.2 + 0.5)) * 255);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
