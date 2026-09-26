// Builds a character from primitives using a world's material kit, and
// applies a Pose to it every frame.

import * as THREE from 'three';
import type { Look } from './look';
import type { Pose } from './pose';
import type { MaterialKit, CharRole } from '../worlds/types';
import { outlineTree } from '../render/outline';

export const CHAR_SCALE = 1.16;
/** Sportsmate-ish proportions: a taller torso, longer legs, a smaller head */
export const TORSO = 1.22;
export const HEAD = 0.88;
/** hip height (root units) — leg length */
export const HIP = 0.34;
export const RACKET_SWEET = 0.47;

// ---------------------------------------------------------------- shared geometry

function lathe(profile: [number, number][], seg = 28) {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
}

const G = {
  body: lathe([
    [0.0, 0.0],
    [0.13, 0.004],
    [0.215, 0.04],
    [0.235, 0.12],
    [0.228, 0.22],
    [0.245, 0.34],
    [0.268, 0.45],
    [0.262, 0.52],
    [0.21, 0.58],
    [0.1, 0.615],
    [0.0, 0.625],
  ]),
  shorts: lathe([
    [0.0, -0.005],
    [0.14, -0.001],
    [0.222, 0.035],
    [0.246, 0.1],
    [0.244, 0.17],
    [0.236, 0.2],
  ]),
  head: new THREE.SphereGeometry(0.3, 36, 26),
  sphere: new THREE.SphereGeometry(1, 20, 14),
  lowSphere: new THREE.SphereGeometry(1, 12, 8),
  hemi: new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
  deepHemi: new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.6),
  bob: new THREE.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.68),
  torusArc: new THREE.TorusGeometry(1, 0.26, 8, 18, Math.PI),
  ring: new THREE.TorusGeometry(1, 0.12, 8, 32),
  brim: new THREE.CylinderGeometry(1, 1, 1, 24, 1, false, Math.PI / 2, Math.PI),
  cone: new THREE.ConeGeometry(1, 1, 10),
  capsule: new THREE.CapsuleGeometry(1, 1, 6, 12),
  leg: new THREE.CapsuleGeometry(0.055, 1, 4, 10),
  arm: new THREE.CapsuleGeometry(0.048, 1, 4, 10),
  thigh: new THREE.CapsuleGeometry(0.085, 1, 4, 12),
  handle: new THREE.CylinderGeometry(0.019, 0.022, 0.24, 12),
  throat: new THREE.CylinderGeometry(0.011, 0.014, 0.16, 8),
  frame: new THREE.TorusGeometry(0.135, 0.014, 8, 40),
  strings: new THREE.CircleGeometry(0.133, 32),
  shadow: new THREE.CircleGeometry(0.44, 32),
};

let stringTex: THREE.Texture | null = null;
export function stringTexture() {
  if (stringTex) return stringTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, 128, 128);
  x.strokeStyle = '#fff';
  x.lineWidth = 2.2;
  for (let i = 4; i < 128; i += 10) {
    x.beginPath();
    x.moveTo(i, 0);
    x.lineTo(i, 128);
    x.stroke();
    x.beginPath();
    x.moveTo(0, i);
    x.lineTo(128, i);
    x.stroke();
  }
  stringTex = new THREE.CanvasTexture(c);
  stringTex.colorSpace = THREE.SRGBColorSpace;
  return stringTex;
}

let shadowTex: THREE.Texture | null = null;
export function blobShadowTexture() {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.75)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

// ---------------------------------------------------------------- rig

const tmpV = new THREE.Vector3();
const armS = new THREE.Vector3();
const armE = new THREE.Vector3();
const armH = new THREE.Vector3();
const armD = new THREE.Vector3();
const armP = new THREE.Vector3();
const segDir = new THREE.Vector3();
/** upper arm and forearm length (unscaled) */
const ARM_SEG = 0.25;

/** Lay a unit capsule (along +y) between two points. */
function segment(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  segDir.subVectors(b, a);
  const len = segDir.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.visible = len > 0.02;
  if (!m.visible) return;
  segDir.divideScalar(len);
  m.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, segDir);
  // stretched arms thin out a touch
  const k = Math.min(1, Math.sqrt(ARM_SEG / Math.max(ARM_SEG, len)));
  m.scale.set(k, Math.max(0.01, len - 0.05), k);
}
const tmpX = new THREE.Vector3();
const tmpY = new THREE.Vector3();
const tmpZ = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

export class Rig {
  root = new THREE.Group();
  body = new THREE.Group();
  head = new THREE.Group();
  hands: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  feet: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  legs: [THREE.Mesh, THREE.Mesh];
  /** shorts over the tops of the legs */
  thighs: [THREE.Mesh, THREE.Mesh];
  /** [upper, fore] for the racket arm and the off arm */
  arms: [THREE.Mesh, THREE.Mesh][];
  private girth = 1;
  racket = new THREE.Group();
  shadow: THREE.Mesh;
  eyesOpen = new THREE.Group();
  eyesHappy = new THREE.Group();
  eyesClosed = new THREE.Group();
  brows = new THREE.Group();
  mouths: Record<string, THREE.Object3D> = {};
  eyeMeshes: THREE.Object3D[] = [];
  scale: number;
  flat: boolean;
  materials: THREE.Material[] = [];

  constructor(
    public look: Look,
    public kit: MaterialKit,
  ) {
    this.scale = CHAR_SCALE * look.height;
    this.flat = !!kit.flat;
    const M = (role: CharRole, css: string) => {
      const m = kit.char(role, new THREE.Color(css));
      this.materials.push(m);
      return m;
    };
    const skin = M('skin', look.skin);
    const shirt = M('shirt', look.shirt);
    const shorts = M('shorts', look.shorts);
    const shoe = M('shoe', look.shoes);
    const hair = M('hair', look.hairColor);
    const hat = M('hat', look.hat);
    const eye = M('eye', '#1d1a2c');
    const eyeW = M('eyeWhite', '#ffffff');
    const mouthM = M('mouth', '#6a2233');
    const cheek = M('cheek', '#ff8fa3');
    const racketM = M('racket', look.racket);
    const grip = M('grip', '#2e2b3c');
    const strings = M('strings', '#f4f1e8');

    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, s?: [number, number, number], p?: [number, number, number]) => {
      const o = new THREE.Mesh(g, m);
      if (s) o.scale.set(...s);
      if (p) o.position.set(...p);
      o.castShadow = !!kit.castShadow;
      o.receiveShadow = false;
      parent.add(o);
      return o;
    };

    // body
    this.root.add(this.body);
    const g = this.look.girth;
    mesh(G.body, shirt, this.body, [g, TORSO, g]);
    mesh(G.shorts, shorts, this.body, [g * 1.03, TORSO, g * 1.03], [0, -0.012, 0]);
    // a little collar stripe for readability
    const collar = mesh(G.ring, hat, this.body, [0.1, 0.1, 0.1], [0, 0.585 * TORSO, 0]);
    collar.rotation.x = Math.PI / 2;
    collar.userData.noOutline = true;

    // head
    this.head.position.set(0, 0.62 * TORSO + 0.3 * HEAD * 0.8, 0);
    this.head.scale.setScalar(HEAD);
    this.body.add(this.head);
    mesh(G.head, skin, this.head, [1, 0.95, 0.97]);

    // face (on the -z side of the head)
    const face = new THREE.Group();
    this.head.add(face);
    face.add(this.eyesOpen, this.eyesHappy, this.eyesClosed, this.brows);
    const onFace = (o: THREE.Object3D, parent: THREE.Object3D, yawDeg: number, pitchDeg: number, r = 0.292) => {
      const yaw = (yawDeg * Math.PI) / 180;
      const pitch = (pitchDeg * Math.PI) / 180;
      o.position.set(Math.sin(yaw) * Math.cos(pitch) * r, Math.sin(pitch) * r * 0.95, -Math.cos(yaw) * Math.cos(pitch) * r * 0.97);
      // +z points out of the face
      o.lookAt(o.position.x * 2, o.position.y * 2, o.position.z * 2);
      parent.add(o);
      return o;
    };
    const detail = (g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, rz = 0) => {
      const o = new THREE.Mesh(g, m);
      o.scale.set(sx, sy, sz);
      o.rotation.z = rz;
      o.userData.noOutline = true;
      return o;
    };
    const eyeScale: Record<string, [number, number]> = {
      dot: [0.042, 0.058],
      oval: [0.05, 0.072],
      tall: [0.038, 0.088],
      sleepy: [0.054, 0.034],
      wide: [0.06, 0.066],
    };
    const [ew, eh] = eyeScale[look.eyes] ?? eyeScale.oval;
    for (const s of [-1, 1]) {
      const e = new THREE.Group();
      e.add(detail(G.sphere, eye, ew, eh, 0.03));
      const hl = detail(G.lowSphere, eyeW, ew * 0.34, ew * 0.34, 0.012);
      hl.position.set(-ew * 0.35, eh * 0.42, 0.024);
      e.add(hl);
      onFace(e, this.eyesOpen, s * 19, 4);
      this.eyeMeshes.push(e);

      const happy = new THREE.Group();
      happy.add(detail(G.torusArc, eye, ew * 0.9, ew * 0.9, ew * 0.9));
      onFace(happy, this.eyesHappy, s * 19, 3);

      const closed = new THREE.Group();
      closed.add(detail(G.capsule, eye, 0.008, ew * 0.9, 0.008, Math.PI / 2));
      onFace(closed, this.eyesClosed, s * 19, 2);

      if (look.brows) {
        const bg = new THREE.Group();
        const b = detail(G.capsule, hair, 0.012, 0.04, 0.012, Math.PI / 2);
        b.userData.side = s;
        bg.add(b);
        onFace(bg, this.brows, s * 19, 19);
      }
      if (look.cheeks) onFace(detail(G.lowSphere, cheek, 0.05, 0.03, 0.012), face, s * 36, -9, 0.286);
    }
    this.eyesHappy.visible = false;
    this.eyesClosed.visible = false;

    onFace(detail(G.lowSphere, skin, 0.032, 0.026, 0.024), face, 0, -5, 0.296);

    const mouth = (o: THREE.Object3D, pitch: number) => {
      const g2 = new THREE.Group();
      g2.add(o);
      onFace(g2, face, 0, pitch);
      g2.visible = false;
      return g2;
    };
    this.mouths = {
      smile: mouth(detail(G.torusArc, mouthM, 0.05, 0.04, 0.04, Math.PI), -16),
      grin: mouth(detail(G.hemi, mouthM, 0.06, 0.055, 0.02, Math.PI), -14),
      open: mouth(detail(G.sphere, mouthM, 0.05, 0.05, 0.02), -17),
      o: mouth(detail(G.sphere, mouthM, 0.028, 0.034, 0.02), -17),
      flat: mouth(detail(G.capsule, mouthM, 0.008, 0.035, 0.008, Math.PI / 2), -16),
      frown: mouth(detail(G.torusArc, mouthM, 0.042, 0.032, 0.035), -19),
    };
    this.mouths.smile.visible = true;

    this.buildHair(look, hair, hat, mesh);

    // hands (racket hand = index 0)
    for (let i = 0; i < 2; i++) {
      this.root.add(this.hands[i]);
      mesh(G.sphere, skin, this.hands[i], [0.078, 0.07, 0.082]);
      // thumb nub
      mesh(G.lowSphere, skin, this.hands[i], [0.03, 0.03, 0.034], [(i === 0 ? -1 : 1) * 0.055, 0.03, -0.02]).userData.noOutline = true;
    }

    // racket: grip at origin, shaft along +y, face normal +z
    this.root.add(this.racket);
    mesh(G.handle, grip, this.racket, undefined, [0, 0.07, 0]);
    mesh(G.throat, racketM, this.racket, undefined, [0, 0.26, 0]);
    const frame = mesh(G.frame, racketM, this.racket, [1, 1.27, 1.2], [0, RACKET_SWEET + 0.03, 0]);
    frame.userData.outlineScale = 0.6;
    const str = mesh(G.strings, strings, this.racket, [1, 1.27, 1], [0, RACKET_SWEET + 0.03, 0]);
    str.userData.noOutline = true;

    // feet + legs
    for (let i = 0; i < 2; i++) {
      this.root.add(this.feet[i]);
      mesh(G.sphere, shoe, this.feet[i], [0.085, 0.06, 0.13], [0, 0.055, -0.03]);
    }
    this.legs = [mesh(G.leg, skin, this.root), mesh(G.leg, skin, this.root)];
    for (const l of this.legs) l.userData.outlineScale = 0.8;
    this.thighs = [mesh(G.thigh, shorts, this.root), mesh(G.thigh, shorts, this.root)];
    for (const l of this.thighs) l.userData.outlineScale = 0.8;
    // arms: sleeve to the elbow, skin to the hand (Switch Sports' Sportsmates have
    // proper arms; they make every swing read)
    this.girth = g;
    this.arms = [0, 1].map(() => {
      const upper = mesh(G.arm, shirt, this.root);
      const fore = mesh(G.arm, skin, this.root);
      upper.userData.outlineScale = 0.75;
      fore.userData.outlineScale = 0.75;
      return [upper, fore] as [THREE.Mesh, THREE.Mesh];
    });

    // blob shadow (on the ground, not scaled with squash)
    const sm = new THREE.MeshBasicMaterial({
      map: blobShadowTexture(),
      color: kit.shadowColor,
      transparent: true,
      opacity: kit.shadowOpacity,
      depthWrite: false,
    });
    this.materials.push(sm);
    this.shadow = new THREE.Mesh(G.shadow, sm);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.shadow.renderOrder = -1;
    this.shadow.userData.noOutline = true;

    if (kit.outline) outlineTree(this.root, kit.outlineColor?.(look) ?? kit.outline.color, kit.outline.width, { emissive: kit.outline.emissive });
    this.root.scale.setScalar(this.scale);
  }

  private buildHair(
    look: Look,
    hair: THREE.Material,
    hat: THREE.Material,
    mesh: (g: THREE.BufferGeometry, m: THREE.Material, p: THREE.Object3D, s?: [number, number, number], pos?: [number, number, number]) => THREE.Mesh,
  ) {
    const h = this.head;
    switch (look.hair) {
      case 'cap': {
        const c = mesh(G.hemi, hat, h, [0.318, 0.3, 0.318], [0, 0.03, 0.005]);
        c.rotation.x = 0.12;
        const b = mesh(G.brim, hat, h, [0.2, 0.022, 0.26], [0, 0.07, -0.22]);
        b.rotation.x = 0.18;
        mesh(G.lowSphere, hat, h, [0.035, 0.02, 0.035], [0, 0.325, 0]);
        break;
      }
      case 'spiky': {
        mesh(G.hemi, hair, h, [0.31, 0.28, 0.31], [0, 0.03, 0.01]);
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          const cn = mesh(G.cone, hair, h, [0.07, 0.2, 0.07], [Math.sin(a) * 0.13, 0.3, Math.cos(a) * 0.13 + 0.03]);
          cn.rotation.set(Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55);
        }
        mesh(G.cone, hair, h, [0.08, 0.22, 0.08], [0, 0.37, 0.02]);
        break;
      }
      case 'bob': {
        const b = mesh(G.bob, hair, h, [0.33, 0.34, 0.33], [0, 0.02, 0.012]);
        b.rotation.x = -0.25;
        break;
      }
      case 'bun':
        mesh(G.hemi, hair, h, [0.315, 0.3, 0.315], [0, 0.02, 0.01]);
        mesh(G.sphere, hair, h, [0.11, 0.1, 0.11], [0, 0.3, 0.12]);
        break;
      case 'band': {
        mesh(G.hemi, hair, h, [0.31, 0.26, 0.31], [0, 0.05, 0.01]);
        const r = mesh(G.ring, hat, h, [0.3, 0.3, 0.5], [0, 0.1, 0]);
        r.rotation.x = Math.PI / 2 + 0.1;
        r.userData.outlineScale = 0.5;
        break;
      }
      case 'beanie': {
        // worn above the brows so the eyes stay visible
        mesh(G.deepHemi, hat, h, [0.325, 0.33, 0.325], [0, 0.085, 0.01]);
        const r = mesh(G.ring, hat, h, [0.315, 0.315, 0.9], [0, 0.14, 0.005]);
        r.rotation.x = Math.PI / 2;
        mesh(G.sphere, hair, h, [0.075, 0.07, 0.075], [0, 0.44, 0.02]);
        break;
      }
      case 'mohawk':
        for (let i = 0; i < 5; i++) mesh(G.sphere, hair, h, [0.05, 0.1, 0.07], [0, 0.26 + Math.sin((i / 4) * Math.PI) * 0.06, -0.16 + i * 0.09]);
        break;
      case 'pony':
        mesh(G.hemi, hair, h, [0.315, 0.3, 0.315], [0, 0.02, 0.01]);
        mesh(G.capsule, hair, h, [0.06, 0.12, 0.06], [0, 0.05, 0.33]).rotation.x = 0.4;
        break;
      case 'afro':
        mesh(G.sphere, hair, h, [0.42, 0.38, 0.4], [0, 0.12, 0.06]);
        break;
      case 'bowl': {
        const b = mesh(G.deepHemi, hair, h, [0.325, 0.3, 0.325], [0, 0.03, 0.01]);
        b.rotation.x = -0.12;
        break;
      }
      case 'crown': {
        mesh(G.hemi, hair, h, [0.3, 0.26, 0.3], [0, 0.03, 0.01]);
        const gold = this.kit.char('gold', new THREE.Color('#ffc531'));
        this.materials.push(gold);
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 20, 1, true), gold);
        band.position.set(0, 0.3, 0.02);
        h.add(band);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const sp = new THREE.Mesh(G.cone, gold);
          sp.scale.set(0.05, 0.12, 0.05);
          sp.position.set(Math.sin(a) * 0.19, 0.4, Math.cos(a) * 0.19 + 0.02);
          h.add(sp);
        }
        break;
      }
    }
  }

  /** The world-space position of the off hand (for a held ball). */
  offHandWorld(out: THREE.Vector3) {
    return this.hands[1].getWorldPosition(out);
  }

  apply(p: Pose) {
    const s = this.scale;
    this.root.position.set(p.x, p.hop, p.z);
    this.root.rotation.set(0, p.yaw, 0);
    const b = this.body;
    b.position.set(p.body.x, p.body.y, p.body.z);
    b.rotation.set(p.bodyPitch, p.bodyYaw, p.bodyRoll, 'YXZ');
    b.scale.set(1 / Math.sqrt(p.squash), p.squash, (1 / Math.sqrt(p.squash)) * (this.flat ? 0.16 : 1));
    this.head.rotation.set(p.headPitch, p.headYaw, p.headRoll, 'YXZ');

    // hands (index 0 = racket hand; mirror handedness in local x)
    for (let i = 0; i < 2; i++) this.hands[i].position.set(p.hands[i].x, p.hands[i].y, p.hands[i].z);

    // racket orientation from shaft direction + face normal
    tmpY.set(p.racketDir.x, p.racketDir.y, p.racketDir.z).normalize();
    tmpZ.set(p.racketFace.x, p.racketFace.y, p.racketFace.z);
    tmpZ.addScaledVector(tmpY, -tmpZ.dot(tmpY));
    if (tmpZ.lengthSq() < 1e-6) tmpZ.set(0, 0, 1).addScaledVector(tmpY, -tmpY.z);
    tmpZ.normalize();
    tmpX.crossVectors(tmpY, tmpZ).normalize();
    tmpM.makeBasis(tmpX, tmpY, tmpZ);
    this.racket.quaternion.setFromRotationMatrix(tmpM);
    this.racket.position.copy(this.hands[0].position);

    // feet and legs
    for (let i = 0; i < 2; i++) {
      const f = p.feet[i];
      this.feet[i].position.set(f.x, f.y, f.z);
      this.feet[i].rotation.set(p.footPitch[i], 0, 0);
      if (this.flat) this.feet[i].scale.z = 0.35;
      // leg from hip to foot
      const hipX = (i === 0 ? -1 : 1) * 0.11;
      tmpV.set(hipX + p.body.x, p.body.y + 0.08, p.body.z);
      const fx = f.x,
        fy = f.y + 0.07,
        fz = f.z - 0.02;
      const dx = fx - tmpV.x,
        dy = fy - tmpV.y,
        dz = fz - tmpV.z;
      const len = Math.max(0.02, Math.hypot(dx, dy, dz));
      const leg = this.legs[i];
      leg.position.set((tmpV.x + fx) / 2, (tmpV.y + fy) / 2, (tmpV.z + fz) / 2);
      leg.scale.set(1, Math.max(0.01, len - 0.06), 1);
      // the shorts cover the top third of the leg
      const th = this.thighs[i];
      const tl = Math.min(0.16, len * 0.4);
      th.position.set(tmpV.x + (dx / len) * tl * 0.5, tmpV.y + (dy / len) * tl * 0.5, tmpV.z + (dz / len) * tl * 0.5);
      th.scale.set(1, Math.max(0.01, tl - 0.05), 1);
      leg.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, tmpV.set(dx / len, dy / len, dz / len));
      th.quaternion.copy(leg.quaternion);
      leg.visible = len > 0.03;
      th.visible = leg.visible;
    }

    // arms: shoulder → elbow → hand, two-bone IK with the elbows dropping down
    // and out; past full reach they stretch a little, cartoon-style
    this.body.updateMatrix();
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? p.handed : -p.handed;
      armS.set(sx * 0.2 * this.girth, 0.47 * TORSO, 0).applyMatrix4(this.body.matrix);
      armH.copy(this.hands[i].position);
      armD.subVectors(armH, armS);
      const d = Math.max(1e-4, armD.length());
      armD.divideScalar(d);
      const L = ARM_SEG;
      if (d >= 2 * L * 0.999) {
        armE.copy(armS).addScaledVector(armD, d / 2);
      } else {
        const a = d / 2;
        const hgt = Math.sqrt(Math.max(0, L * L - a * a));
        // elbow pole: outwards, down and a little back
        armP.set(sx * 0.35, -0.45, 0.25);
        armP.addScaledVector(armD, -armP.dot(armD));
        if (armP.lengthSq() < 1e-6) armP.set(sx, 0, 0);
        armP.normalize();
        armE.copy(armS).addScaledVector(armD, a).addScaledVector(armP, hgt);
      }
      const [upper, fore] = this.arms[i];
      segment(upper, armS, armE);
      segment(fore, armE, armH);
    }

    // face
    const eyes = p.blink > 0.5 ? 'closed' : p.eyes;
    this.eyesOpen.visible = eyes === 'open' || eyes === 'focus' || eyes === 'wide' || eyes === 'sad';
    this.eyesHappy.visible = eyes === 'happy';
    this.eyesClosed.visible = eyes === 'closed';
    const squint = eyes === 'focus' ? 0.72 : eyes === 'wide' ? 1.15 : eyes === 'sad' ? 0.85 : 1;
    for (const e of this.eyeMeshes) e.scale.set(1, squint, 1);
    for (const [k, m] of Object.entries(this.mouths)) m.visible = k === p.mouth;
    for (const bw of this.brows.children) {
      const b = bw.children[0];
      b.rotation.z = Math.PI / 2 + (b.userData.side as number) * p.brow * 0.35;
    }

    // shadow sits on the ground under the body
    this.shadow.position.set(p.x, 0.012, p.z);
    const sh = 1 - Math.min(0.5, p.hop * 0.8);
    this.shadow.scale.set(s * sh, s * sh, 1);
  }

  dispose() {
    for (const m of this.materials) m.dispose();
  }
}
