// SUNNY PLAZA — the hub world. Bright, cel-shaded, outlined: the classic
// sunny-afternoon sports look, with a giant prism turning on the hill.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { toon, flat, stringsMat, skyDome, canvasTex } from './mats';
import { addOutline, outlineTree } from '../render/outline';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import type { MatchEvent } from '../tennis/match';
import { COURT } from '../tennis/court';
import { SKINS } from '../chars/look';

const OUTLINE = new THREE.Color('#231f3a');

class PlazaWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth' || role === 'eyeWhite') return flat(c);
      if (role === 'strings') return stringsMat(c);
      if (role === 'cheek') return flat(c, { transparent: true, opacity: 0.7 });
      if (role === 'gold') return toon(c, { rim: 0.6, rimColor: new THREE.Color('#fff6c0') });
      return toon(c, { rim: role === 'skin' || role === 'shirt' ? 0.22 : 0.12, rimColor: new THREE.Color('#fff8e8') });
    },
    outline: { color: OUTLINE, width: 0.011 },
    castShadow: true,
    shadowColor: new THREE.Color('#1c3a66'),
    shadowOpacity: 0.28,
  };

  private clouds: THREE.Group[] = [];
  private prism!: THREE.Group;
  private flags: THREE.Mesh[] = [];
  private scoreTex!: THREE.CanvasTexture;
  private scoreCtx!: CanvasRenderingContext2D;
  private bunting: THREE.Mesh[] = [];

  protected build() {
    const s = this.scene;
    s.fog = new THREE.Fog('#cfeeff', 70, 330);
    s.add(
      skyDome(new THREE.Color('#2f7cf6'), new THREE.Color('#c8f0ff'), {
        sunDir: new THREE.Vector3(-0.45, 0.55, -1),
        sunColor: new THREE.Color('#fff4d6'),
        sunSize: 0.012,
        ground: new THREE.Color('#9fd98a'),
      }),
    );

    // lights
    const sun = new THREE.DirectionalLight('#fff1d8', 2.5);
    sun.position.set(-16, 30, -12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -18;
    sc.right = 18;
    sc.top = 24;
    sc.bottom = -24;
    sc.near = 5;
    sc.far = 80;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    s.add(sun, sun.target);
    s.add(new THREE.HemisphereLight('#cfe7ff', '#7fbf6a', 1.7));

    // ground & court
    const grass = toon('#62c46a', { gradient: [170, 230, 255], grain: 0.06 });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(420, 64), grass);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    s.add(ground);
    this.buildCourt({
      inner: toon('#3a74dc', { gradient: [150, 215, 255], grain: 0.05 }),
      outer: toon('#35a766', { gradient: [150, 215, 255], grain: 0.05 }),
      line: toon('#ffffff', { gradient: [200, 240, 255] }),
      innerPad: { x: 0.9, z: 1.6 },
      outerSize: { x: 11, z: 19 },
      lineWidth: 0.075,
      receiveShadow: true,
    });
    this.buildNet({
      post: toon('#2b2d42', { rim: 0.3 }),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#ffffff'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 }),
      band: toon('#ffffff'),
    });

    // ball
    const ballMat = toon('#ffffff', { map: this.tennisBallTexture('#d6f23c', '#ffffff'), rim: 0.35, gradient: [170, 225, 255] });
    this.buildBall(ballMat, { color: new THREE.Color('#ffffff'), color2: new THREE.Color('#bfe6ff'), width: 0.075, opacity: 0.75 }, new THREE.Color('#10204a'), 0.5);
    addOutline(this.ball, OUTLINE, 0.012);
    this.buildParticles();

    this.buildStands();
    this.buildScenery();
    this.buildScoreboard();
    this.bloom = new Bloom(5);
    this.bloom.threshold = 0.95;
    this.bloom.knee = 0.4;
    const f = this.final.u;
    f.uBloom.value = 0.28;
    f.uSat.value = 1.12;
    f.uContrast.value = 1.04;
    f.uGain.value.set(1.02, 1.0, 0.97);
    f.uVignette.value = 0.22;
    f.uGrain.value = 0.012;
  }

  private buildStands() {
    const s = this.scene;
    const standMat = toon('#f4f1fb', { gradient: [150, 210, 255] });
    const trimMats = [toon('#ff5a6e'), toon('#ffc53d'), toon('#3aa8ff'), toon('#35d49a')];
    const stands: Stand[] = [];
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(width, 0.55 + r * 0.55, 0.9), standMat);
        step.position.set(0, (0.55 + r * 0.55) / 2, r * 0.9 + 0.45);
        step.receiveShadow = true;
        step.castShadow = true;
        g.add(step);
      }
      // front trim
      const trim = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, 0.12), trimMats[(stands.length * 2) % 4]);
      trim.position.set(0, 0.25, -0.06);
      g.add(trim);
      outlineTree(g, OUTLINE, 0.02);
      g.position.set(cx, 0, cz);
      g.rotation.y = facing; // local +z points away from the court
      s.add(g);
      stands.push({ x: cx, z: cz, facing: facing, width: width - 0.6, rows, rowRise: 0.55, rowDepth: 0.9, y0: 0.55 });
    };
    // sides (facing the court)
    mk(-10.5, 0, -Math.PI / 2, 22, 7);
    mk(10.5, 0, Math.PI / 2, 22, 7);
    // far end (facing +z)
    mk(0, -19.5, Math.PI, 18, 8);

    const shirts = ['#ff5a6e', '#3aa8ff', '#ffc53d', '#35d49a', '#b07cff', '#ff9a3d', '#ffffff', '#ff7ac8'].map((c) => new THREE.Color(c));
    const skins = SKINS.map((c) => new THREE.Color(c));
    this.addCrowd(
      new Crowd({
        stands,
        density: 1.05,
        bodyMat: toon('#ffffff', { gradient: [150, 215, 255] }),
        headMat: toon('#ffffff', { gradient: [150, 215, 255] }),
        shirts,
        skins,
        fill: 0.86,
      }),
    );
  }

  private buildScenery() {
    const s = this.scene;
    // rolling hills
    const hillCols = ['#52b86a', '#46a95f', '#6bc978', '#3d9a58'];
    const hills: [number, number, number, number][] = [
      [-120, -210, 90, 34],
      [40, -260, 130, 46],
      [190, -170, 85, 30],
      [-230, -110, 70, 26],
      [260, -60, 90, 28],
      [-60, -330, 150, 60],
      [150, -360, 120, 52],
    ];
    hills.forEach(([x, z, r, h], i) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), toon(hillCols[i % hillCols.length], { gradient: [170, 225, 255] }));
      m.scale.set(r, h, r * 0.8);
      m.position.set(x, -1, z);
      s.add(m);
    });

    // trees
    const trunk = toon('#8a5a3a');
    const leaves = ['#3fae5a', '#58c26a', '#2f9a52', '#7ad36e'].map((c) => toon(c, { rim: 0.25, rimColor: new THREE.Color('#fff7c8') }));
    const tree = (x: number, z: number, sc: number) => {
      const g = new THREE.Group();
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 2.6, 8), trunk);
      t.position.y = 1.3;
      t.castShadow = true;
      g.add(t);
      const lm = leaves[Math.floor(Math.random() * leaves.length)];
      const blobs = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < blobs; i++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), lm);
        const r = 1.1 + Math.random() * 0.7;
        b.scale.setScalar(r);
        b.position.set((Math.random() - 0.5) * 1.8, 3.2 + Math.random() * 1.3, (Math.random() - 0.5) * 1.8);
        b.castShadow = true;
        g.add(b);
      }
      outlineTree(g, OUTLINE, 0.05);
      g.scale.setScalar(sc);
      g.position.set(x, 0, z);
      s.add(g);
    };
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 1.2 - Math.PI * 1.1;
      const d = 34 + Math.random() * 70;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d - 8;
      if (z > 6) continue;
      tree(x, z, 1 + Math.random() * 0.8);
    }

    // clouds
    const cloudMat = toon('#ffffff', { gradient: [205, 240, 255], rim: 0.15, fog: false });
    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      const n = 5 + Math.floor(Math.random() * 5);
      for (let j = 0; j < n; j++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), cloudMat);
        b.scale.setScalar(4 + Math.random() * 5);
        b.position.set((j - n / 2) * 4.2 + Math.random() * 2, Math.random() * 3, Math.random() * 4);
        g.add(b);
      }
      g.position.set(-260 + Math.random() * 520, 45 + Math.random() * 45, -120 - Math.random() * 180);
      g.scale.y = 0.75;
      s.add(g);
      this.clouds.push(g);
    }

    // the Prism monument on the hill
    this.prism = new THREE.Group();
    const facets = ['#ff5a8a', '#ffb13d', '#ffe34d', '#4be3a2', '#52a7ff', '#a07cff'];
    const geo = new THREE.OctahedronGeometry(9, 0);
    const pos = geo.attributes.position;
    const nonIdx = geo.index ? geo.toNonIndexed() : geo;
    const colors: number[] = [];
    const tri = nonIdx.attributes.position.count / 3;
    for (let i = 0; i < tri; i++) {
      const c = new THREE.Color(facets[i % facets.length]);
      for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
    }
    nonIdx.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    void pos;
    const pm = new THREE.Mesh(nonIdx, toon('#ffffff', { vertexColors: true, rim: 0.5, emissive: new THREE.Color('#301a40'), gradient: [180, 230, 255] }));
    pm.scale.y = 1.6;
    addOutline(pm, OUTLINE, 0.12);
    this.prism.add(pm);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(5, 7, 4, 6), toon('#f2eefc'));
    base.position.y = -17;
    addOutline(base, OUTLINE, 0.1);
    this.prism.add(base);
    this.prism.position.set(40, 56, -250);
    s.add(this.prism);

    // windscreens with the logo
    const logo = canvasTex(1024, 128, (x) => {
      x.fillStyle = '#2d6ad0';
      x.fillRect(0, 0, 1024, 128);
      x.font = '700 82px Fredoka, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      const word = 'KALEIDO   ·   KALEIDO   ·   KALEIDO';
      x.fillStyle = '#ffffff';
      x.fillText(word, 512, 68);
    });
    logo.wrapS = THREE.RepeatWrapping;
    const wallMat = toon('#ffffff', { map: logo, gradient: [190, 235, 255] });
    const wall = (w: number, x: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, 0.14), wallMat);
      m.position.set(x, 0.55, z);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      addOutline(m, OUTLINE, 0.018);
      s.add(m);
    };
    wall(17, 0, -17.4, 0);
    wall(34, -9.2, 0, Math.PI / 2);
    wall(34, 9.2, 0, -Math.PI / 2);

    // flags on the far corners
    const flagCols = ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a'];
    const poleMat = toon('#ffffff');
    [-12, -6, 6, 12].forEach((x, i) => {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 11, 8), poleMat);
      pole.position.set(x, 5.5, -24.5);
      addOutline(pole, OUTLINE, 0.02);
      s.add(pole);
      const fg = new THREE.PlaneGeometry(2.8, 1.6, 12, 4);
      fg.translate(1.4, 0, 0);
      fg.userData.base = Float32Array.from(fg.attributes.position.array as Float32Array);
      const fl = new THREE.Mesh(fg, toon(flagCols[i], { side: THREE.DoubleSide }));
      fl.position.set(x, 10.1, -24.5);
      s.add(fl);
      this.flags.push(fl);
    });

    // bunting over the far stand
    const pennantCols = flagCols.concat(['#ffffff', '#b07cff']);
    for (let row = 0; row < 2; row++) {
      const n = 26;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const x = -9 + u * 18;
        const y = 9.3 - Math.sin(u * Math.PI) * 1.4 - row * 1.8;
        const tri = new THREE.BufferGeometry();
        tri.setAttribute('position', new THREE.Float32BufferAttribute([-0.3, 0, 0, 0.3, 0, 0, 0, -0.62, 0], 3));
        tri.computeVertexNormals();
        const m = new THREE.Mesh(tri, toon(pennantCols[(i + row) % pennantCols.length], { side: THREE.DoubleSide }));
        m.position.set(x, y, -22 + row * 1.2);
        m.userData.phase = Math.random() * 6;
        s.add(m);
        this.bunting.push(m);
      }
    }

    // planters with flowers at the court corners
    const pot = toon('#f7f2ff');
    const petals = ['#ff5a8a', '#ffe34d', '#ffffff', '#ff9a3d', '#b07cff'].map((c) => toon(c));
    const stem = toon('#3d9a58');
    for (const [x, z] of [
      [-8.4, -16.4],
      [8.4, -16.4],
      [-8.4, 15.8],
      [8.4, 15.8],
    ]) {
      const g = new THREE.Group();
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.55, 0.8, 12), pot);
      p.position.y = 0.4;
      g.add(p);
      for (let i = 0; i < 9; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), petals[i % petals.length]);
        const a = (i / 9) * Math.PI * 2;
        f.position.set(Math.cos(a) * 0.45, 0.95 + Math.random() * 0.2, Math.sin(a) * 0.45);
        g.add(f);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 4), stem);
        st.position.set(f.position.x, 0.8, f.position.z);
        g.add(st);
      }
      outlineTree(g, OUTLINE, 0.02);
      g.position.set(x, 0, z);
      s.add(g);
    }

    // umpire chair
    const chair = new THREE.Group();
    const wood = toon('#ffffff');
    for (const [dx, dz] of [
      [-0.4, -0.4],
      [0.4, -0.4],
      [-0.4, 0.4],
      [0.4, 0.4],
    ]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), wood);
      leg.position.set(dx, 1.1, dz);
      chair.add(leg);
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1, 0.15, 1), toon('#3aa8ff'));
    seat.position.y = 2.2;
    chair.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.12), toon('#3aa8ff'));
    back.position.set(0, 2.75, -0.45);
    chair.add(back);
    const umbrella = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.5, 8), toon('#ffc53d'));
    umbrella.position.y = 4.1;
    chair.add(umbrella);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), wood);
    stick.position.y = 3.4;
    chair.add(stick);
    outlineTree(chair, OUTLINE, 0.02);
    chair.position.set(-7.4, 0, 0.4);
    chair.rotation.y = Math.PI / 2;
    chair.traverse((o) => (o.castShadow = true));
    chair.userData.noBatch = true;
    this.tennisOnly.push(chair);
    s.add(chair);
  }

  private buildScoreboard() {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 360;
    this.scoreCtx = c.getContext('2d')!;
    this.scoreTex = new THREE.CanvasTexture(c);
    this.scoreTex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(10, 3.5), new THREE.MeshBasicMaterial({ map: this.scoreTex, fog: true }));
    board.position.set(0, 12.5, -26);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(10.6, 4.1, 0.4), toon('#2b2d42'));
    frame.position.set(0, 12.5, -26.25);
    addOutline(frame, OUTLINE, 0.04);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 10.5, 0.4), toon('#2b2d42'));
    legs.position.set(-3.5, 5.2, -26.3);
    const legs2 = legs.clone();
    legs2.position.x = 3.5;
    this.scene.add(board, frame, legs, legs2);
    this.setScoreboard(['KALEIDO', ''], ['', ''], ['', '']);
  }

  setScoreboard(names: [string, string], games: [string, string], points: [string, string]) {
    const x = this.scoreCtx;
    x.fillStyle = '#16172a';
    x.fillRect(0, 0, 1024, 360);
    x.fillStyle = '#23254a';
    x.fillRect(12, 12, 1000, 336);
    x.font = '700 64px Fredoka, sans-serif';
    x.textBaseline = 'middle';
    const rows = [0, 1];
    for (const i of rows) {
      const y = 108 + i * 145;
      x.fillStyle = i === 0 ? '#ff5a6e' : '#3aa8ff';
      x.fillRect(36, y - 52, 16, 104);
      x.fillStyle = '#ffffff';
      x.textAlign = 'left';
      x.fillText(names[i].slice(0, 16), 76, y);
      x.textAlign = 'center';
      x.fillStyle = '#ffe34d';
      x.fillText(games[i], 790, y);
      x.fillStyle = '#ffffff';
      x.fillText(points[i], 930, y);
    }
    this.scoreTex.needsUpdate = true;
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    for (const c of this.clouds) {
      c.position.x += v.realDt * 1.2;
      if (c.position.x > 300) c.position.x = -300;
    }
    this.prism.rotation.y = t * 0.25;
    this.prism.position.y = 56 + Math.sin(t * 0.8) * 1.5;
    for (const f of this.flags) {
      const pos = f.geometry.attributes.position as THREE.BufferAttribute;
      const base = f.geometry.userData.base as Float32Array;
      for (let i = 0; i < pos.count; i++) {
        const bx = base[i * 3];
        pos.setZ(i, Math.sin(t * 5 + bx * 2.2 + f.position.x) * 0.18 * bx);
      }
      pos.needsUpdate = true;
    }
    for (const b of this.bunting) b.rotation.x = Math.sin(t * 3 + b.userData.phase) * 0.25;
  }

  protected fx(e: MatchEvent) {
    const P = this.particles;
    if (e.type === 'hit') {
      const big = e.perfect || e.kind === 'smash' || e.power > 0.8;
      P.burst({
        x: e.pos.x,
        y: e.pos.y,
        z: e.pos.z,
        count: big ? 22 : 10,
        speed: [2, big ? 7 : 4],
        life: [0.25, 0.55],
        size: [0.08, big ? 0.3 : 0.18],
        shrink: 0.2,
        colors: e.perfect ? [new THREE.Color('#fff27a'), new THREE.Color('#ffffff'), new THREE.Color('#ffb13d')] : [new THREE.Color('#ffffff'), new THREE.Color('#dff4ff')],
        shape: 'star',
        drag: 3,
      });
      if (e.perfect) P.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: 1, speed: [0, 0], life: [0.35, 0.35], size: [0.3, 0.3], shrink: 6, colors: [new THREE.Color('#ffffff')], shape: 'ring', alpha: 0.8 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      P.burst({
        x: e.pos.x,
        y: 0.05,
        z: e.pos.z,
        count: 6,
        speed: [0.5, 1.4],
        dir: [0, 1, 0],
        spread: 0.9,
        life: [0.3, 0.6],
        size: [0.12, 0.25],
        shrink: 1.8,
        colors: [new THREE.Color('#e8f4ff')],
        shape: 'soft',
        alpha: 0.5,
        drag: 4,
      });
    }
    if (e.type === 'point') {
      const winners = this.rigs.length ? e.winner : 0;
      void winners;
      P.burst({
        x: 0,
        y: 8,
        z: e.winner === 0 ? 6 : -6,
        count: 90,
        speed: [3, 9],
        dir: [0, 1, 0],
        spread: 0.8,
        life: [2, 3.5],
        size: [0.14, 0.24],
        colors: ['#ff5a6e', '#ffc53d', '#3aa8ff', '#35d49a', '#ffffff', '#b07cff'].map((c) => new THREE.Color(c)),
        shape: 'confetti',
        gravity: 3,
        drag: 1.2,
        spin: 10,
        ground: true,
      });
    }
  }
}

export const PLAZA: WorldDef = {
  id: 'plaza',
  name: 'Sunny Plaza',
  tagline: 'Where every rally begins',
  blurb: 'Blue skies, bright colours and a roaring home crowd.',
  ui: {
    accent: '#3aa8ff',
    accent2: '#ffc53d',
    ink: '#1d1c33',
    paper: '#ffffff',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Fredoka', system-ui, sans-serif",
    panel: 'linear-gradient(160deg, rgba(255,255,255,0.96), rgba(233,243,255,0.94))',
  },
  song: 'plaza',
  surface: 1,
  make: (r) => new PlazaWorld(PLAZA, r),
};

export { COURT };
