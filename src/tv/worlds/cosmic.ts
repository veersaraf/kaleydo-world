// STARFALL — a court on an asteroid adrift above a ringed giant. Its glowing
// limb lies along the horizon, its ring arcs up across a nebula baked once into
// the sky, moons hang in the dark, a belt of rocks tumbles past lit by the
// system's star, meteors fall, dust rises in the low gravity and the rim of the
// platform runs with light. The ball is a comet — and gravity is lower, so
// rallies float.

import * as THREE from 'three';
import { FIRE_STYLE } from '../render/smashfx';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat, toon } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import type { MatchEvent } from '../tennis/match';
import { bakeNebula, spaceDome, NearStars, shootingStars } from './cosmic-env/sky';
import { planet } from './cosmic-env/planet';
import { Belt, crystals, dust, rimGlow } from './cosmic-env/rocks';

const CYAN = new THREE.Color('#5ef2ff');
const VIOLET = new THREE.Color('#a86bff');
const PINK = new THREE.Color('#ff6bd6');
const hdr = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);
/** the system's star, where the players' key light comes from (up, to the right, behind the main
 *  camera): the giant, its moons and the rocks are lit from it — day on the giant's right, a
 *  terminator and a glowing limb on its left */
const STAR = new THREE.Vector3(20, 14, 10).normalize();

class CosmicWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(new THREE.Color('#10081e'));
      if (role === 'eyeWhite') return flat(hdr(new THREE.Color('#ffffff'), 1.4));
      if (role === 'strings') return stringsMat(hdr(CYAN, 1.2));
      if (role === 'cheek') return flat(new THREE.Color('#ff8ad8'));
      return toon(c, { rim: 0.9, rimColor: hdr(CYAN, 1.2), rimPower: 2.5, gradient: [70, 160, 255] });
    },
    outline: { color: new THREE.Color('#0c0620'), width: 0.01 },
    shadowColor: new THREE.Color('#000000'),
    shadowOpacity: 0.5,
  };

  /** one clock and one beat for every shader */
  private u = { uTime: { value: 0 }, uBeat: { value: 0 } };
  /** baked once: kept out of the render-target scan, which would release it */
  #nebula!: THREE.WebGLCubeRenderTarget;
  private stars!: NearStars;
  private belt!: Belt;

  protected build() {
    // a smash in space: a violet comet, a starburst ring, a dark crater
    this.smashStyle = { ...FIRE_STYLE, fire: [hdr(VIOLET, 3), hdr(CYAN, 3), hdr(new THREE.Color('#ffffff'), 2.5)], fireShape: 'soft', sparks: [hdr(CYAN, 3), hdr(PINK, 3), hdr(new THREE.Color('#ffe38d'), 3)], sparkShape: 'star', ring: hdr(CYAN, 1.4), additive: true, hot: hdr(PINK, 2), scorch: new THREE.Color('#07031a'), scorchAlpha: 0.72, dust: [hdr(VIOLET, 1.2)], dustShape: 'soft', flash: new THREE.Color('#d8f6ff') };
    const s = this.scene;
    this.#nebula = bakeNebula(this.renderer);
    const sky = spaceDome(this.u, this.#nebula.texture, STAR);
    this.stars = new NearStars(this.u, 2600);
    const meteors = shootingStars(this.u);
    sky.name = 'cosmic.sky';
    this.stars.mesh.name = 'cosmic.stars';
    meteors.name = 'cosmic.meteors';
    s.add(sky, this.stars.mesh, meteors);

    const star = new THREE.DirectionalLight('#dbe8ff', 2.8);
    star.position.copy(STAR).multiplyScalar(25);
    s.add(star);
    s.add(new THREE.HemisphereLight('#6f5cff', '#130a2a', 1.3));
    const rim = new THREE.DirectionalLight('#ff6bd6', 1.4);
    rim.position.set(-20, 6, -30);
    s.add(rim);

    // the giant: rising beyond the far end (filling the top of the players' view,
    // a dome over the pins and the targets), its ring tipped up so the far side
    // arcs across the sky
    s.add(
      planet(
        this.u,
        { center: new THREE.Vector3(-50, -125, -560), radius: 190, axis: new THREE.Vector3(0.3, 0.92, 0.26), ring: [1.35, 2.3], light: STAR },
        [
          [new THREE.Vector3(-250, 150, -430), 28],
          [new THREE.Vector3(175, 88, -520), 11],
          // a big moon over the near end, for the far and reverse views
          [new THREE.Vector3(-150, 62, 420), 34],
        ],
      ),
    );
    this.belt = new Belt(this.u, { count: 170, radius: [42, 170], height: [-45, 50], size: [0.6, 7], light: STAR, rimDir: new THREE.Vector3(-0.6, 0.1, -0.8), seed: 5 });
    this.belt.mesh.name = 'cosmic.belt';
    s.add(this.belt.mesh);

    this.buildPlatform();

    this.buildCourt({
      inner: new THREE.MeshLambertMaterial({ color: '#1b1742', emissive: new THREE.Color('#07051a') }),
      outer: new THREE.MeshLambertMaterial({ color: '#29224f' }),
      line: flat(hdr(CYAN, 1.8)),
      innerPad: { x: 1.1, z: 2 },
      outerSize: { x: 10.8, z: 18.6 },
      lineWidth: 0.07,
    });
    this.buildNet({
      post: flat(hdr(VIOLET, 2)),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), color: hdr(CYAN, 1), transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }),
      band: flat(hdr(new THREE.Color('#e9f7ff'), 2.2)),
    });
    const ballMat = new THREE.MeshBasicMaterial({ color: hdr(new THREE.Color('#e8fbff'), 3.5) });
    this.buildBall(ballMat, { color: hdr(CYAN, 2), color2: hdr(VIOLET, 1.6), width: 0.12, opacity: 1, additive: true, length: 30 }, new THREE.Color('#000000'), 0.6);
    this.buildParticles({ additive: true, fog: false });

    this.buildStands();

    this.bloom = new Bloom(5);
    this.bloom.threshold = 1.0;
    const f = this.final.u;
    f.uBloom.value = 0.75;
    f.uTonemap.value = 1;
    f.uExposure.value = 1.1;
    f.uSat.value = 1.15;
    f.uAberration.value = 0.0025;
    f.uVignette.value = 0.4;
    f.uGrain.value = 0.02;
    this.flashColor.set('#d8f6ff');
    // depth of field for replays and cinematics (the stars go soft behind the players),
    // and a soft shadow under each planted foot
    this.effects = { dof: true, contact: { strength: 0.55, color: new THREE.Color('#0b0720') } };
  }

  private buildPlatform() {
    const s = this.scene;
    const rockM = new THREE.MeshLambertMaterial({ color: '#4a3f6e', flatShading: true });
    const rockD = new THREE.MeshLambertMaterial({ color: '#2d2548', flatShading: true });
    // top slab
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(24, 22, 2.2, 28, 1), rockM);
    slab.position.y = -1.12;
    slab.scale.z = 1.25;
    s.add(slab);
    // jagged underside
    const under = new THREE.ConeGeometry(22, 28, 28, 6);
    const p = under.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < 13.9) {
        const k = 1 + (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.25;
        p.setXYZ(i, p.getX(i) * k, y + Math.sin(i * 7.1) * 1.2, p.getZ(i) * k);
      }
    }
    under.computeVertexNormals();
    const um = new THREE.Mesh(under, rockD);
    um.rotation.x = Math.PI;
    um.position.y = -16;
    um.scale.z = 1.25;
    s.add(um);
    // the rim runs with light, and crystals grow along it
    const rim = rimGlow(this.u, 24, 30);
    rim.name = 'cosmic.rim';
    s.add(rim);
    const at: Parameters<typeof crystals>[1] = [];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const r = 17 + Math.random() * 5;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 1.25;
      if (z > 10 && Math.abs(x) < 10) continue;
      at.push({ x, y: 1 + Math.random(), z, sy: 1.6 + Math.random() * 1.8, rot: new THREE.Euler(Math.random() * 0.5, Math.random() * 3, Math.random() * 0.5), color: hdr(i % 3 ? CYAN : PINK, 0.8 + Math.random() * 0.5) });
    }
    const cr = crystals(this.u, at);
    const motes = dust(this.u, 260);
    cr.name = 'cosmic.crystals';
    motes.name = 'cosmic.dust';
    s.add(cr, motes);
  }

  private buildStands() {
    const stands: Stand[] = [];
    const m = new THREE.MeshLambertMaterial({ color: '#241c46' });
    const edge = flat(hdr(VIOLET, 2));
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.55 + r * 0.55;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), m);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        g.add(st);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(width, 0.04, 0.04), edge);
        strip.position.set(0, hgt, r * 0.9);
        g.add(strip);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    // (four rows: the courtside attract shot looks over the back row, and the far
    // stand leaves the giant's limb in view over the crowd)
    mk(-11, 0, -Math.PI / 2, 22, 4);
    mk(11, 0, Math.PI / 2, 22, 4);
    mk(0, -20, Math.PI, 16, 4);
    this.addCrowd(
      new Crowd({
        stands,
        density: 0.9,
        bodyMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        headMat: new THREE.MeshLambertMaterial({ color: '#ffffff' }),
        shirts: ['#3b2d7a', '#5a2d7a', '#2d4a7a', '#7a2d5e'].map((c) => new THREE.Color(c)),
        skins: ['#8dff9e', '#b28dff', '#8dd8ff', '#ff9ed8', '#ffe38d'].map((c) => new THREE.Color(c)),
        fill: 0.8,
      }),
    );
  }

  protected onResize(_W: number, H: number) {
    this.stars.setHeight(H);
  }

  protected onDetail(d: number) {
    this.belt.setDetail(d);
    this.stars.setDetail(d);
  }

  protected animate(v: FrameView) {
    this.u.uTime.value = v.realT;
    this.u.uBeat.value = v.beat;
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: big ? 30 : 12, speed: [2, big ? 8 : 5], life: [0.4, 0.9], size: [0.05, 0.14], shrink: 0.2, colors: [hdr(CYAN, 3), hdr(VIOLET, 3), hdr(new THREE.Color('#ffffff'), 3)], shape: 'star', drag: 1.2 });
    }
    if (e.type === 'bounce' && e.impact > 1.5) P.burst({ x: e.pos.x, y: 0.05, z: e.pos.z, count: 1, speed: [0, 0], life: [0.6, 0.6], size: [0.25, 0.25], shrink: 8, colors: [hdr(e.out ? PINK : CYAN, 2)], shape: 'ring' });
    if (e.type === 'point') P.burst({ x: 0, y: 6, z: e.winner === 0 ? 6 : -6, count: 110, speed: [3, 9], dir: [0, 1, 0], spread: 0.95, life: [2, 3.5], size: [0.06, 0.14], colors: [hdr(CYAN, 3), hdr(PINK, 3), hdr(VIOLET, 3), hdr(new THREE.Color('#ffe38d'), 3)], shape: 'star', gravity: 1, drag: 0.6, spin: 4 });
  }

  dispose() {
    super.dispose();
    this.#nebula.dispose();
  }
}

export const STARFALL: WorldDef = {
  id: 'cosmic',
  name: 'Starfall',
  tagline: 'Low gravity, high drama',
  blurb: 'A court adrift among the stars. The ball floats — so time your swing.',
  ui: {
    accent: '#5ef2ff',
    accent2: '#ff6bd6',
    ink: '#140c30',
    paper: '#ffffff',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Orbitron', 'Fredoka', sans-serif",
    panel: 'linear-gradient(160deg, rgba(245,248,255,0.97), rgba(232,236,255,0.95))',
  },
  song: 'cosmic',
  surface: 1,
  gravity: 0.72,
  make: (r) => new CosmicWorld(STARFALL, r),
};
