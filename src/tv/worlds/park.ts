// SPORTS PARK — the Switch Sports look: smooth, softly lit, no outlines. A coral
// hard court in a bright modern plaza, with a white-column pavilion, glass
// canopy and greenery behind the far baseline and the town beyond.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { stringsMat, skyDome, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import { sunRim } from '../render/effects';
import type { MatchEvent } from '../tennis/match';
import { COURT } from '../tennis/court';
import { SKINS } from '../chars/look';

const std = (color: THREE.ColorRepresentation, roughness = 0.8, o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...o });

/** the players' sunlit rim (render/effects.ts sunRim) */
const RIM = { color: new THREE.Color('#ffe9c8'), strength: 0.6, power: 3, sky: 0.1 };

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The park's display grade (baked into a LUT): vivid but not garish — muted
 * colours gain the most saturation, skin tones the least — with warm highlights,
 * slightly cool shadows and a gentle S-curve. Sunny Sunday-afternoon plaza.
 */
function sunnyGrade([r, g, b]: [number, number, number]): [number, number, number] {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  // skin: red > green > blue, moderately saturated
  const skin = r > g && g > b ? sstep(0.05, 0.2, r - b) * (1 - sstep(0.35, 0.6, sat)) * sstep(0.2, 0.4, l) : 0;
  const vib = 1 + 0.24 * (1 - sat) * (1 - 0.8 * skin);
  let R = l + (r - l) * vib,
    G = l + (g - l) * vib,
    B = l + (b - l) * vib;
  // split tone
  const hi = sstep(0.35, 0.95, l),
    lo = 1 - sstep(0.05, 0.45, l);
  R += 0.025 * hi - 0.012 * lo;
  G += 0.01 * hi - 0.004 * lo;
  B += -0.03 * hi + 0.02 * lo;
  // a gentle S-curve around mid grey
  const curve = (x: number) => {
    const t = Math.min(1, Math.max(0, x));
    const s = t * t * (3 - 2 * t);
    return t + (s - t) * 0.18;
  };
  return [curve(R), curve(G), curve(B)];
}

class ParkWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth' || role === 'eyeWhite') return new THREE.MeshBasicMaterial({ color: c });
      if (role === 'cheek') return new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.45 });
      if (role === 'strings') return stringsMat(c);
      if (role === 'gold') return sunRim(std(c, 0.3, { metalness: 0.6 }), RIM);
      const rough = role === 'skin' ? 0.62 : role === 'hair' ? 0.5 : role === 'racket' || role === 'grip' ? 0.35 : role === 'shoe' ? 0.55 : 0.78;
      // the main camera looks into the sun: a sunlit rim keeps the players round
      return sunRim(std(c, rough), RIM);
    },
    outline: null,
    castShadow: true,
    shadowColor: new THREE.Color('#2a2440'),
    shadowOpacity: 0.26,
  };

  private banners: THREE.Mesh[] = [];
  private clouds: THREE.Group[] = [];

  protected build() {
    const s = this.scene;
    s.fog = new THREE.Fog('#dcefff', 80, 360);
    const sunDir = new THREE.Vector3(-0.5, 0.6, -1);
    const sky = skyDome(new THREE.Color('#3f94ee'), new THREE.Color('#e3f4ff'), {
      sunDir,
      sunColor: new THREE.Color('#fff7e2'),
      sunSize: 0.01,
      ground: new THREE.Color('#c9c3bb'),
    });
    s.add(sky);
    this.light(sky, sunDir);

    this.buildGround();
    this.buildCourt({
      inner: std('#d6585c', 0.62, { map: this.courtTexture() }),
      outer: std('#3a3e4a', 0.85),
      line: std('#ffffff', 0.5),
      innerPad: { x: 0.9, z: 1.6 },
      outerSize: { x: 10.5, z: 18.5 },
      lineWidth: 0.075,
      receiveShadow: true,
    });
    this.buildNet({
      post: std('#2b2f3a', 0.45),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 }),
      band: std('#ffffff', 0.5),
    });
    this.buildSurroundText();

    // ball: a proper fuzzy tennis ball
    const ballMat = std('#ffffff', 0.9, { map: this.tennisBallTexture('#d9f23f', '#ffffff') });
    this.buildBall(ballMat, { color: new THREE.Color('#ffffff'), color2: new THREE.Color('#cfe8ff'), width: 0.075, opacity: 0.8 }, new THREE.Color('#1e1a30'), 0.55);
    this.buildParticles();

    this.buildPavilion();
    this.buildSides();
    this.buildTown();

    this.bloom = new Bloom(5);
    this.bloom.threshold = 1.0;
    this.bloom.knee = 0.5;
    const f = this.final.u;
    f.uTonemap.value = 1;
    f.uExposure.value = 1.0;
    f.uBloom.value = 0.16;
    f.uSat.value = 1.06;
    f.uContrast.value = 1.04;
    f.uGain.value.set(1.02, 1.0, 0.98);
    f.uVignette.value = 0.14;
    f.uGrain.value = 0.004;
  }

  /**
   * A warm sun with soft shadows, and the sky itself as the fill: image-based
   * light from the dome (blue from above, the plaza's bounce from below, faint
   * reflections), ambient occlusion, contact shadows, glare and shafts when
   * the sun is in view, and a sunny grade (render/effects.ts).
   */
  private light(sky: THREE.Mesh, sunDir: THREE.Vector3) {
    const s = this.scene;
    const sun = new THREE.DirectionalLight('#fff3df', 3.1);
    sun.position.set(-14, 30, -10);
    sun.castShadow = true;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    s.add(sun, sun.target);
    // a little warm, flat fill on top keeps shadows friendly rather than cold
    s.add(new THREE.HemisphereLight('#fff2e0', '#d8c4ae', 0.3));
    this.effects = {
      ibl: { sky, diffuse: 0.5, saturation: 0.4, specular: 0.12 },
      ao: { radius: 0.9, strength: 0.75, intensity: 1.2, protectLit: 0.45 },
      sun: { dir: sunDir, color: new THREE.Color('#fff0d8'), shafts: 0.5, flare: 0.8 },
      grade: { tonemap: 'aces', lut: sunnyGrade },
      contact: { strength: 0.6, color: new THREE.Color('#4a4458') },
      // the court, its run-off, the stands and the pavilion's columns (shadow map fitted to it)
      shadow: { light: sun, area: new THREE.Box3(new THREE.Vector3(-16, 0, -23), new THREE.Vector3(16, 10, 19)), softness: 0.07 },
      dof: true,
    };
  }

  /** Coral court with big, faint painted swirls (Spocco-style). */
  private courtTexture() {
    const t = canvasTex(1024, 2048, (x) => {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 1024, 2048);
      x.strokeStyle = 'rgba(255, 238, 232, 0.55)';
      x.lineCap = 'round';
      x.lineWidth = 46;
      for (const [cx, cy, r, a0, a1] of [
        [300, 700, 260, 0.2, 3.6],
        [720, 1350, 280, 3.4, 6.6],
        [520, 1020, 120, 0, 6.28],
      ] as [number, number, number, number, number][]) {
        x.beginPath();
        x.arc(cx, cy, r, a0, a1);
        x.stroke();
      }
      // a light speckle so it reads as a real surface
      for (let i = 0; i < 9000; i++) {
        x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '120,40,40'},${Math.random() * 0.06})`;
        x.fillRect(Math.random() * 1024, Math.random() * 2048, 2, 2);
      }
    });
    t.anisotropy = 8;
    return t;
  }

  /** "TENNIS" painted on the surround, like the Switch court. */
  private buildSurroundText() {
    const tex = canvasTex(1024, 256, (x) => {
      x.clearRect(0, 0, 1024, 256);
      x.font = '700 170px Fredoka, system-ui, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillStyle = 'rgba(255,255,255,0.32)';
      x.fillText('TENNIS', 512, 132);
    });
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: true });
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), mat);
      m.rotation.set(-Math.PI / 2, 0, sx * Math.PI / 2);
      m.position.set(sx * 8.4, 0.01, 0);
      m.renderOrder = 1;
      m.userData.noBatch = true;
      this.tennisOnly.push(m);
      this.scene.add(m);
    }
  }

  /** A bright tiled plaza floor around the court. */
  private buildGround() {
    const tex = canvasTex(512, 512, (x) => {
      x.fillStyle = '#e9e4dc';
      x.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
          const v = 228 + Math.floor(Math.random() * 14);
          x.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
          x.fillRect(i * 128 + 2, j * 128 + 2, 124, 124);
        }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(90, 90);
    tex.anisotropy = 8;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(320, 48), std('#ffffff', 0.9, { map: tex }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  /** White columns under a glass canopy with hanging greenery and sport banners. */
  private buildPavilion() {
    const s = this.scene;
    const white = std('#ebe7e1', 0.55);
    const steel = std('#c9ced8', 0.35, { metalness: 0.3 });
    const green = [std('#3f9e57', 0.85), std('#5cb86b', 0.85), std('#2f8a4c', 0.85)];
    const z = -21.5;
    const cols = 9;
    const span = 36;
    const colGeo = new THREE.CylinderGeometry(0.42, 0.48, 9.5, 20);
    for (let i = 0; i < cols; i++) {
      const x = -span / 2 + (i / (cols - 1)) * span;
      const c = new THREE.Mesh(colGeo, white);
      c.position.set(x, 4.75, z);
      c.castShadow = true;
      c.receiveShadow = true;
      s.add(c);
      // planters at the foot of the columns
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.75, 0.9, 20), white);
      pot.position.set(x, 0.45, z + 1.4);
      pot.castShadow = true;
      s.add(pot);
      for (let k = 0; k < 4; k++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.55 + Math.random() * 0.25, 14, 10), green[k % 3]);
        b.position.set(x + (Math.random() - 0.5) * 0.9, 1.15 + Math.random() * 0.4, z + 1.4 + (Math.random() - 0.5) * 0.9);
        b.castShadow = true;
        s.add(b);
      }
    }
    // beam and glass canopy
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 3, 0.7, 1.2), white);
    beam.position.set(0, 9.6, z);
    beam.castShadow = true;
    s.add(beam);
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(span + 3, 0.12, 9),
      new THREE.MeshStandardMaterial({ color: '#bfe6ff', roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    glass.position.set(0, 10.05, z - 3.6);
    s.add(glass);
    for (const x of [-span / 2 - 1, span / 2 + 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 9), steel);
      rail.position.set(x, 10.05, z - 3.6);
      s.add(rail);
    }
    // vines hanging from the beam
    for (let i = 0; i < 30; i++) {
      const x = -span / 2 + Math.random() * span;
      const len = 1 + Math.random() * 2.2;
      for (let k = 0; k < 5; k++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.28 - k * 0.03, 10, 8), green[(i + k) % 3]);
        b.position.set(x + (Math.random() - 0.5) * 0.3, 9.2 - (k / 4) * len, z + 0.55);
        s.add(b);
      }
    }
    // tall sport banners between columns (they sway)
    const icons = ['🎾', '🏸', '🎳', '⚽', '🏐', '🏀', '⚔️', '⛳'];
    const colors = ['#ff6b6b', '#3aa8ff', '#ffc53d', '#35d49a', '#b07cff', '#ff8a3d', '#ff5aa0', '#4fd1c5'];
    for (let i = 0; i < cols - 1; i++) {
      const x = -span / 2 + ((i + 0.5) / (cols - 1)) * span;
      const tex = canvasTex(256, 512, (c) => {
        c.fillStyle = colors[i % colors.length];
        c.fillRect(0, 0, 256, 512);
        c.fillStyle = 'rgba(255,255,255,0.18)';
        c.beginPath();
        c.arc(128, 220, 96, 0, Math.PI * 2);
        c.fill();
        c.font = '150px system-ui, "Apple Color Emoji", sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(icons[i % icons.length], 128, 226);
      });
      const b = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 4.2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide }));
      b.position.set(x, 6.4, z + 0.2);
      b.userData.phase = Math.random() * 6;
      b.castShadow = true;
      s.add(b);
      this.banners.push(b);
    }
    // a low glass wall between the court and the pavilion
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(24, 1.1, 0.08),
      new THREE.MeshStandardMaterial({ color: '#d7efff', roughness: 0.05, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    wall.position.set(0, 0.55, -15.2);
    s.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(24, 0.08, 0.14), steel);
    cap.position.set(0, 1.12, -15.2);
    s.add(cap);
  }

  /** Planters, benches, lamps and a sparse, friendly crowd along the sides. */
  private buildSides() {
    const s = this.scene;
    const concrete = std('#efe9e1', 0.8);
    const wood = std('#c48a58', 0.7);
    const green = [std('#46a860', 0.85), std('#6cc27a', 0.85), std('#37914f', 0.85)];
    const flowers = [std('#ff7a9a', 0.7), std('#ffd05a', 0.7), std('#ffffff', 0.7)];
    const stands: Stand[] = [];
    for (const sx of [-1, 1]) {
      // long planter
      const pl = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 26), concrete);
      pl.position.set(sx * 11.6, 0.35, 0);
      pl.castShadow = true;
      pl.receiveShadow = true;
      s.add(pl);
      for (let i = 0; i < 26; i++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.45 + Math.random() * 0.25, 12, 9), green[i % 3]);
        b.position.set(sx * 11.6 + (Math.random() - 0.5) * 0.7, 0.85 + Math.random() * 0.2, -12.5 + i + Math.random() * 0.5);
        b.castShadow = true;
        s.add(b);
        if (Math.random() < 0.45) {
          const f = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), flowers[i % 3]);
          f.position.set(b.position.x + (Math.random() - 0.5) * 0.5, b.position.y + 0.35, b.position.z);
          s.add(f);
        }
      }
      // tiered seating behind the planter: a few rows of friendly spectators
      const g = new THREE.Group();
      for (let r = 0; r < 3; r++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(22, 0.5 + r * 0.5, 0.95), r % 2 ? wood : concrete);
        step.position.set(0, (0.5 + r * 0.5) / 2, r * 0.95 + 0.48);
        step.receiveShadow = true;
        step.castShadow = true;
        g.add(step);
      }
      g.position.set(sx * 13, 0, 0);
      g.rotation.y = sx < 0 ? -Math.PI / 2 : Math.PI / 2;
      s.add(g);
      stands.push({ x: sx * 13, z: 0, facing: sx < 0 ? -Math.PI / 2 : Math.PI / 2, width: 21, rows: 3, rowRise: 0.5, rowDepth: 0.95, y0: 0.5 });
      // lamp posts
      for (const z of [-14, 0, 14]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 7, 10), std('#2b2f3a', 0.4));
        pole.position.set(sx * 10.6, 3.5, z);
        pole.castShadow = true;
        s.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.5), std('#2b2f3a', 0.4));
        head.position.set(sx * 10.3, 7, z);
        s.add(head);
      }
    }
    // far end: a short stand behind the glass wall
    const g = new THREE.Group();
    for (let r = 0; r < 3; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(18, 0.5 + r * 0.5, 0.95), r % 2 ? wood : concrete);
      step.position.set(0, (0.5 + r * 0.5) / 2, r * 0.95 + 0.48);
      step.receiveShadow = true;
      g.add(step);
    }
    g.position.set(0, 0, -16);
    g.rotation.y = Math.PI;
    s.add(g);
    stands.push({ x: 0, z: -16, facing: Math.PI, width: 17, rows: 3, rowRise: 0.5, rowDepth: 0.95, y0: 0.5 });

    const shirts = ['#ff6b6b', '#3aa8ff', '#ffc53d', '#35d49a', '#b07cff', '#ff8a3d', '#ffffff', '#ff5aa0', '#2b2f3a'].map((c) => new THREE.Color(c));
    this.addCrowd(
      new Crowd({
        stands,
        density: 0.8,
        bodyMat: std('#ffffff', 0.8),
        headMat: std('#ffffff', 0.62),
        shirts,
        skins: SKINS.map((c) => new THREE.Color(c)),
        fill: 0.62,
      }),
    );
  }

  /** The town beyond: soft modern blocks, trees and a few clouds. */
  private buildTown() {
    const s = this.scene;
    const facade = ['#e7ded2', '#cfdcea', '#ecd6c4', '#d6e6d8'];
    const windowTex = canvasTex(256, 256, (x) => {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 256, 256);
      x.fillStyle = 'rgba(80,120,170,0.35)';
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) x.fillRect(12 + i * 62, 14 + j * 62, 40, 40);
    });
    windowTex.wrapS = windowTex.wrapT = THREE.RepeatWrapping;
    const rng = (a: number, b: number) => a + Math.random() * (b - a);
    for (let i = 0; i < 26; i++) {
      const w = rng(10, 22),
        hgt = rng(14, 42),
        d = rng(10, 20);
      const tex = windowTex.clone();
      tex.needsUpdate = true;
      tex.repeat.set(w / 5, hgt / 5);
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), std(facade[i % facade.length], 0.85, { map: tex }));
      const ang = -Math.PI * 0.95 + (i / 25) * Math.PI * 0.9;
      const r = rng(62, 95);
      b.position.set(Math.cos(ang) * r, hgt / 2, Math.sin(ang) * r - 10);
      b.rotation.y = -ang + Math.PI / 2;
      s.add(b);
    }
    // round trees around the plaza
    const trunk = std('#8a6a4a', 0.8);
    const leaves = [std('#4aa860', 0.85), std('#62bd70', 0.85), std('#3a9454', 0.85)];
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = rng(26, 48);
      const x = Math.cos(ang) * r,
        z = Math.sin(ang) * r * 1.2;
      if (Math.abs(x) < 16 && z > 10) continue; // keep the view behind the near player open
      const g = new THREE.Group();
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 3, 10), trunk);
      t.position.y = 1.5;
      t.castShadow = true;
      g.add(t);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(rng(1.6, 2.4), 18, 14), leaves[i % 3]);
      crown.position.y = 4.1;
      crown.castShadow = true;
      g.add(crown);
      g.position.set(x, 0, z);
      s.add(g);
    }
    // clouds
    const cloudMat = std('#ffffff', 1, { emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.35 });
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(rng(4, 7), 14, 10), cloudMat);
        b.position.set(k * 5 - 10, rng(-1, 1.5), rng(-2, 2));
        b.scale.y = 0.55;
        g.add(b);
      }
      g.position.set(rng(-220, 220), rng(55, 90), rng(-260, -140));
      s.add(g);
      this.clouds.push(g);
    }
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    for (const b of this.banners) b.rotation.y = Math.sin(t * 0.9 + b.userData.phase) * 0.08;
    for (const c of this.clouds) {
      c.position.x += v.realDt * 1.1;
      if (c.position.x > 260) c.position.x = -260;
    }
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: big ? 18 : 8, speed: [2, big ? 6.5 : 4], life: [0.22, 0.5], size: [0.07, big ? 0.24 : 0.15], shrink: 0.2, colors: e.perfect ? [new THREE.Color('#fff27a'), new THREE.Color('#ffffff'), new THREE.Color('#ffb13d')] : [new THREE.Color('#ffffff')], shape: 'star', drag: 3 });
      if (e.perfect) P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: 1, speed: [0, 0], life: [0.32, 0.32], size: [0.28, 0.28], shrink: 6, colors: [new THREE.Color('#ffffff')], shape: 'ring', alpha: 0.75 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 5, speed: [0.5, 1.3], dir: [0, 1, 0], spread: 0.9, life: [0.3, 0.55], size: [0.1, 0.22], shrink: 1.8, colors: [new THREE.Color('#fff1ec')], shape: 'soft', alpha: 0.45, drag: 4 });
    }
    if (e.type === 'point') {
      P.burst({ x: 0, y: 8, z: e.winner === 0 ? 6 : -6, count: 80, speed: [3, 8], dir: [0, 1, 0], spread: 0.8, life: [2, 3.4], size: [0.13, 0.22], colors: ['#ff6b6b', '#ffc53d', '#3aa8ff', '#35d49a', '#ffffff', '#b07cff'].map((c) => new THREE.Color(c)), shape: 'confetti', gravity: 3, drag: 1.2, spin: 10, ground: true });
    }
  }
}

export const PARK: WorldDef = {
  id: 'park',
  name: 'Sports Park',
  tagline: 'The whole town comes to play',
  blurb: 'A bright plaza court, soft sunshine and a friendly crowd.',
  ui: {
    accent: '#ff6b6b',
    accent2: '#3aa8ff',
    ink: '#1d1c33',
    paper: '#ffffff',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Fredoka', system-ui, sans-serif",
    panel: 'linear-gradient(160deg, rgba(255,255,255,0.97), rgba(244,240,236,0.95))',
  },
  song: 'plaza',
  surface: 1,
  make: (r) => new ParkWorld(PARK, r),
};

export { COURT };
