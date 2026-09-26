// PAPER ISLES — a pop-up book diorama. Layered paper hills, clouds on
// strings, a cardboard court, and players who are paper cut-outs with white
// sticker borders.

import * as THREE from 'three';
import { World, type WorldDef, type FrameView } from './base';
import type { MaterialKit, CharRole } from './types';
import { flat, stringsMat, canvasTex } from './mats';
import { Crowd, type Stand } from './crowd';
import { Bloom } from '../render/post';
import type { MatchEvent } from '../tennis/match';

let paperTex: THREE.Texture | null = null;
function paper() {
  if (paperTex) return paperTex;
  paperTex = canvasTex(512, 512, (x) => {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 512, 512);
    const img = x.getImageData(0, 0, 512, 512);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = 238 + Math.random() * 17;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
    }
    x.putImageData(img, 0, 0);
    x.strokeStyle = 'rgba(150,140,120,0.18)';
    for (let i = 0; i < 260; i++) {
      x.lineWidth = Math.random() * 1.2;
      x.beginPath();
      const px = Math.random() * 512,
        py = Math.random() * 512;
      x.moveTo(px, py);
      x.bezierCurveTo(px + Math.random() * 20 - 10, py + Math.random() * 20 - 10, px + Math.random() * 30 - 15, py + Math.random() * 30 - 15, px + Math.random() * 40 - 20, py + Math.random() * 40 - 20);
      x.stroke();
    }
  });
  paperTex.wrapS = paperTex.wrapT = THREE.RepeatWrapping;
  return paperTex;
}

const P = (color: THREE.ColorRepresentation, repeat = 1, side: THREE.Side = THREE.FrontSide) => {
  const t = paper().clone();
  t.needsUpdate = true;
  t.repeat.set(repeat, repeat);
  return new THREE.MeshLambertMaterial({ color, map: t, side });
};

function wavyShape(w: number, h: number, bumps: number, amp: number, seed: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = -w / 2 + u * w;
    const y = h + Math.sin(u * Math.PI * bumps + seed) * amp + Math.sin(u * Math.PI * bumps * 2.3 + seed * 2) * amp * 0.35;
    s.lineTo(x, Math.max(0.5, y * Math.sin(u * Math.PI) ** 0.35));
  }
  s.lineTo(w / 2, 0);
  s.lineTo(-w / 2, 0);
  return s;
}

function cloudShape(r: number) {
  const s = new THREE.Shape();
  s.moveTo(-r * 2, 0);
  s.absarc(-r * 1.3, r * 0.3, r * 0.7, Math.PI, Math.PI * 0.35, true);
  s.absarc(-r * 0.2, r * 0.75, r * 0.95, Math.PI * 0.95, Math.PI * 0.1, true);
  s.absarc(r * 1.1, r * 0.35, r * 0.75, Math.PI * 0.7, 0, true);
  s.lineTo(r * 1.85, 0);
  s.lineTo(-r * 2, 0);
  return s;
}

class PaperWorld extends World {
  kit: MaterialKit = {
    char: (role: CharRole, c: THREE.Color) => {
      if (role === 'eye' || role === 'mouth') return flat(new THREE.Color('#2b2530'));
      if (role === 'eyeWhite') return flat(new THREE.Color('#ffffff'));
      if (role === 'strings') return stringsMat(new THREE.Color('#f7f2e6'));
      if (role === 'cheek') return flat(new THREE.Color('#ff9aa8'));
      return P(c, 0.5);
    },
    outline: { color: new THREE.Color('#fffdf7'), width: 0.022 },
    flat: true,
    castShadow: true,
    shadowColor: new THREE.Color('#5a4630'),
    shadowOpacity: 0.18,
  };

  private hung: THREE.Object3D[] = [];
  private sun!: THREE.Group;
  private plane!: THREE.Group;

  protected build() {
    const s = this.scene;
    s.background = new THREE.Color('#bfe6f5');
    s.fog = new THREE.Fog('#d6eef5', 90, 300);
    const sun = new THREE.DirectionalLight('#fff6e4', 2.6);
    sun.position.set(-14, 26, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -30;
    sc.right = 30;
    sc.top = 30;
    sc.bottom = -40;
    sc.far = 120;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    s.add(sun, sun.target);
    s.add(new THREE.HemisphereLight('#f5fbff', '#cbb58f', 1.6));

    // paper backdrop: a big curved sky sheet
    const sky = new THREE.Mesh(new THREE.CylinderGeometry(260, 260, 220, 48, 1, true, Math.PI * 0.6, Math.PI * 0.8), P('#a9dcf0', 6, THREE.BackSide));
    sky.position.set(0, 60, 40);
    s.add(sky);

    // table/ground: a big sheet of kraft paper
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), P('#9fd18b', 60));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.3;
    ground.receiveShadow = true;
    s.add(ground);

    // cardboard court slab
    const kraft = P('#d9b27c', 4);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(22, 0.3, 38), [kraft, kraft, kraft, kraft, kraft, kraft]);
    slab.position.y = -0.15;
    slab.receiveShadow = true;
    s.add(slab);
    this.buildCourt({
      inner: P('#7fcfc0', 3),
      outer: P('#f2dfb8', 3),
      line: flat('#fffdf5'),
      innerPad: { x: 1.1, z: 2 },
      outerSize: { x: 10.8, z: 18.8 },
      lineWidth: 0.09,
      wobble: 0.03,
      receiveShadow: true,
    });
    this.buildNet({
      post: P('#8b5a3c'),
      mesh: new THREE.MeshBasicMaterial({ map: this.netTexture('#fffdf5'), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 }),
      band: P('#ffffff'),
    });

    const ballMat = new THREE.MeshLambertMaterial({ color: '#ffe066', flatShading: true, map: paper() });
    this.buildBall(ballMat, { color: new THREE.Color('#ffffff'), color2: new THREE.Color('#ffe7a6'), width: 0.07, opacity: 0.85, length: 20 }, new THREE.Color('#5a4630'), 0.35);
    this.ball.geometry = new THREE.IcosahedronGeometry(0.085, 1);
    this.buildParticles();

    this.buildHills();
    this.buildHanging();
    this.buildTrees();
    this.buildStands();
    this.buildPlane();

    this.bloom = new Bloom(4);
    this.bloom.threshold = 1.1;
    const f = this.final.u;
    f.uBloom.value = 0.18;
    f.uSat.value = 1.05;
    f.uContrast.value = 1.03;
    f.uGain.value.set(1.03, 1.0, 0.95);
    f.uVignette.value = 0.3;
    f.uGrain.value = 0.0;
    f.uPaper.value = 0.16;
  }

  private buildHills() {
    const cols = ['#7cc576', '#5fb36a', '#9ad38a', '#4e9e62', '#b8e0a0'];
    const layers = [
      { z: -30, w: 120, h: 6, b: 5, a: 2, x: 0 },
      { z: -48, w: 160, h: 11, b: 4, a: 4, x: 20 },
      { z: -70, w: 220, h: 18, b: 3, a: 6, x: -30 },
      { z: -100, w: 300, h: 28, b: 3, a: 9, x: 10 },
      { z: -135, w: 380, h: 40, b: 2, a: 12, x: 0 },
    ];
    layers.forEach((L, i) => {
      const geo = new THREE.ExtrudeGeometry(wavyShape(L.w, L.h, L.b, L.a, i * 1.7), { depth: 0.6, bevelEnabled: false, curveSegments: 6 });
      const m = new THREE.Mesh(geo, [P(cols[i % cols.length], 8), P('#f4ecd8', 2)]);
      m.position.set(L.x, 0, L.z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
      // tiny paper houses on the nearer hills
      if (i === 1 || i === 2) {
        for (let k = 0; k < 5; k++) {
          const hx = L.x - L.w * 0.35 + k * L.w * 0.17 + Math.random() * 4;
          const house = new THREE.Group();
          const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2, 1.6), P(['#fff4e0', '#ffd9d9', '#e0f0ff', '#fff0b3'][k % 4]));
          body.position.y = 1;
          const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 1.7, 1.4, 3, 1), P(['#e76f51', '#6d8ed8', '#e9a23b'][k % 3]));
          roof.rotation.z = Math.PI / 2;
          roof.rotation.y = Math.PI / 2;
          roof.position.y = 2.6;
          roof.scale.set(1, 1.3, 1);
          const door = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.9), flat('#7a5236'));
          door.position.set(0, 0.45, 0.81);
          house.add(body, roof, door);
          house.position.set(hx, L.h * 0.55, L.z + 0.8);
          house.traverse((o) => (o.castShadow = true));
          this.scene.add(house);
        }
      }
    });
  }

  private buildHanging() {
    const s = this.scene;
    const string = new THREE.MeshBasicMaterial({ color: '#8a7a66' });
    const hang = (obj: THREE.Object3D, x: number, y: number, z: number, top = 90) => {
      const g = new THREE.Group();
      obj.position.set(0, 0, 0);
      g.add(obj);
      const len = top - y;
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 4), string);
      line.position.y = len / 2;
      g.add(line);
      g.position.set(x, y, z);
      g.userData.phase = Math.random() * 6;
      s.add(g);
      this.hung.push(g);
      return g;
    };
    const white = P('#ffffff', 2);
    const edge = P('#e8e2d4');
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Mesh(new THREE.ExtrudeGeometry(cloudShape(3 + Math.random() * 2.5), { depth: 0.5, bevelEnabled: false }), [white, edge]);
      c.castShadow = true;
      hang(c, -90 + i * 22 + Math.random() * 8, 26 + Math.random() * 18, -60 - Math.random() * 60);
    }
    // the sun: disc with triangular rays
    this.sun = new THREE.Group();
    const yellow = P('#ffc93c');
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.6, 40), yellow);
    disc.rotation.x = Math.PI / 2;
    this.sun.add(disc);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 0.62, 40), P('#ffe07a'));
    face.rotation.x = Math.PI / 2;
    face.position.z = 0.05;
    this.sun.add(face);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const shape = new THREE.Shape();
      shape.moveTo(-1.3, 0);
      shape.lineTo(1.3, 0);
      shape.lineTo(0, 4.2);
      shape.lineTo(-1.3, 0);
      const ray = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false }), [yellow, P('#f2b035')]);
      ray.position.set(Math.cos(a) * 7.4, Math.sin(a) * 7.4, -0.2);
      ray.rotation.z = a - Math.PI / 2;
      this.sun.add(ray);
    }
    const eyes = [-1.8, 1.8].map((x) => {
      const e = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), flat('#5a3a1a'));
      e.position.set(x, 1, 0.4);
      return e;
    });
    const smile = new THREE.Mesh(new THREE.TorusGeometry(2, 0.22, 6, 20, Math.PI), flat('#5a3a1a'));
    smile.rotation.z = Math.PI;
    smile.position.set(0, -0.4, 0.4);
    this.sun.add(...eyes, smile);
    hang(this.sun, -55, 48, -120, 130);
  }

  private buildTrees() {
    const stick = P('#a0764a');
    const greens = ['#5bb85d', '#89c95a', '#3f9e5a', '#f2a65a', '#e76f8a'].map((c) => P(c, 2));
    const edge = P('#f4ecd8');
    for (let i = 0; i < 38; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (15 + Math.random() * 40);
      const z = -60 + Math.random() * 70;
      const g = new THREE.Group();
      const h = 3 + Math.random() * 3;
      const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.35, h, 0.25), stick);
      trunk.position.y = h / 2;
      g.add(trunk);
      const r = 1.6 + Math.random() * 1.4;
      const shape = new THREE.Shape();
      if (Math.random() < 0.5) shape.absarc(0, 0, r, 0, Math.PI * 2, false);
      else {
        shape.moveTo(-r, -r * 0.4);
        shape.lineTo(r, -r * 0.4);
        shape.lineTo(0, r * 1.8);
        shape.lineTo(-r, -r * 0.4);
      }
      const crown = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false, curveSegments: 16 }), [greens[i % greens.length], edge]);
      crown.position.set(0, h + r * 0.6, -0.15);
      g.add(crown);
      const stand = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.2, 1), stick);
      stand.position.y = 0.1;
      g.add(stand);
      g.traverse((o) => (o.castShadow = true));
      g.position.set(x, 0, z);
      g.rotation.y = (Math.random() - 0.5) * 0.5;
      this.scene.add(g);
    }
  }

  private buildStands() {
    const box = P('#caa06a', 3);
    const stands: Stand[] = [];
    const mk = (cx: number, cz: number, facing: number, width: number, rows: number) => {
      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        const hgt = 0.5 + r * 0.5;
        const st = new THREE.Mesh(new THREE.BoxGeometry(width, hgt, 0.9), box);
        st.position.set(0, hgt / 2, r * 0.9 + 0.45);
        st.castShadow = true;
        st.receiveShadow = true;
        g.add(st);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = facing;
      this.scene.add(g);
      stands.push({ x: cx, z: cz, facing, width: width - 0.6, rows, rowRise: 0.5, rowDepth: 0.9, y0: 0.5 });
    };
    mk(-11, 0, -Math.PI / 2, 22, 6);
    mk(11, 0, Math.PI / 2, 22, 6);
    mk(0, -19.5, Math.PI, 16, 6);
    const crowd = new Crowd({
      stands,
      density: 1,
      bodyMat: P('#ffffff', 0.3),
      headMat: P('#ffffff', 0.3),
      shirts: ['#e76f51', '#2a9d8f', '#e9c46a', '#f4a261', '#8ab6f9', '#f28fb0', '#b388eb'].map((c) => new THREE.Color(c)),
      skins: ['#ffe0c7', '#f1c9a5', '#c68e62', '#8d5a3b'].map((c) => new THREE.Color(c)),
      fill: 0.85,
      flatten: 0.18,
    });
    crowd.bodies.castShadow = true;
    crowd.heads.castShadow = true;
    this.addCrowd(crowd);
  }

  private buildPlane() {
    this.plane = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -1.4, -1.1, 0.1, 0.9, 0, -0.25, 0.9, 0, 0, -1.4, 0, -0.25, 0.9, 1.1, 0.1, 0.9], 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, P('#ffffff', 1, THREE.DoubleSide));
    m.castShadow = true;
    this.plane.add(m);
    this.plane.scale.setScalar(1.6);
    this.scene.add(this.plane);
  }

  protected animate(v: FrameView) {
    const t = v.realT;
    for (const h of this.hung) h.rotation.z = Math.sin(t * 0.7 + h.userData.phase) * 0.03;
    this.sun.rotation.z = t * 0.08;
    const a = t * 0.18;
    this.plane.position.set(Math.cos(a) * 34, 16 + Math.sin(t * 0.9) * 2, -30 + Math.sin(a) * 22);
    this.plane.rotation.set(Math.sin(t * 0.9) * 0.15, -a + Math.PI, Math.sin(a) * 0.4);
  }

  protected fx(e: MatchEvent) {
    const Pp = this.particles;
    const cols = (a: string[]) => a.map((c) => new THREE.Color(c));
    if (e.type === 'hit') {
      Pp.burst({ x: e.pos.x, y: e.pos.y, z: e.pos.z, count: e.perfect ? 16 : 7, speed: [2, 5], life: [0.4, 0.8], size: [0.1, 0.18], colors: cols(['#ffffff', '#ffe066', '#ffd1dc']), shape: 'confetti', gravity: 6, spin: 12, drag: 2.5 });
    }
    if (e.type === 'bounce' && e.impact > 2) {
      Pp.burst({ x: e.pos.x, y: 0.08, z: e.pos.z, count: 4, speed: [0.6, 1.6], dir: [0, 1, 0], spread: 0.9, life: [0.5, 0.9], size: [0.08, 0.14], colors: cols(['#e8c58f', '#ffffff']), shape: 'confetti', gravity: 5, spin: 10, ground: true });
    }
    if (e.type === 'point') {
      Pp.burst({ x: 0, y: 8, z: e.winner === 0 ? 6 : -6, count: 110, speed: [3, 8], dir: [0, 1, 0], spread: 0.9, life: [2.5, 4], size: [0.18, 0.3], colors: cols(['#e76f51', '#2a9d8f', '#e9c46a', '#f28fb0', '#8ab6f9', '#ffffff']), shape: 'confetti', gravity: 2.4, drag: 1.2, spin: 12, ground: true });
    }
  }
}

export const PAPER: WorldDef = {
  id: 'paper',
  name: 'Paper Isles',
  tagline: 'Cut, fold, serve',
  blurb: 'A pop-up book world of cardboard, crayon and paper cut-out players.',
  ui: {
    accent: '#e76f51',
    accent2: '#2a9d8f',
    ink: '#3b2f28',
    paper: '#fffaf0',
    font: "'Fredoka', system-ui, sans-serif",
    display: "'Gaegu', 'Fredoka', cursive",
    panel: 'linear-gradient(160deg, rgba(255,251,240,0.98), rgba(250,240,220,0.96))',
  },
  song: 'paper',
  surface: 0.96,
  make: (r) => new PaperWorld(PAPER, r),
};
