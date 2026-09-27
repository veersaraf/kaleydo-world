// The glass floor: an endless grid scrolling towards you on black glass that
// mirrors the sun, the mountains, the palms and every neon light.
//
// The reflection is a real one, and cheap: a second camera mirrored in the
// floor (y = 0) draws, at a fraction of the resolution, only what is marked
// REFLECT (sky, sun, skyline, lights — not the stands' bulk, not the floor);
// one small pass smears it down the screen the way wet asphalt streaks lights;
// the floor and the court look it up where their points project into that
// camera.
//
// It draws its own little scene of stand-ins that share the originals'
// geometry and materials: three.js walks and sorts the whole scene on every
// render(), and for the world's 400 objects that cost more than drawing the
// 25 that reflect. The effects tier sets its resolution, and the lowest tier
// drops it for a painted-on sun.

import * as THREE from 'three';
import { makeRT, Pass } from '../../render/post';
import { NOISE } from '../../render/glsl';

/** the camera layer of what the floor reflects */
export const REFLECT = 1;

/** a vertical streak blur (a little sideways too): lights on wet glass */
const STREAK = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  float w = 0.0;
  for (int i = -6; i <= 6; i++) {
    float k = exp(-float(i * i) / 20.0);
    c += texture2D(tSrc, vUv + vec2(0.0, float(i) * uTexel.y * 1.6)).rgb * k;
    w += k;
  }
  c += (texture2D(tSrc, vUv + vec2(uTexel.x * 1.5, 0.0)).rgb + texture2D(tSrc, vUv - vec2(uTexel.x * 1.5, 0.0)).rgb) * 0.6;
  gl_FragColor = vec4(c / (w + 1.2), 1.0);
}`;

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class Reflection {
  rt = makeRT(1, 1);
  private smeared = makeRT(1, 1);
  private streak = new Pass(STREAK, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  /** the camera in the glass */
  private vcam = new THREE.PerspectiveCamera();
  private fwd = new THREE.Vector3();
  /** the stand-ins: the scenery's under `root` (turned with it), the rest in world space */
  private scene = new THREE.Scene();
  private root = new THREE.Group();
  private env: THREE.Object3D | null = null;
  /** stand-in → original, for visibility (and, for things that move, their matrices) */
  private links: { p: THREE.Mesh; src: THREE.Mesh; moves: boolean }[] = [];
  /** shared by everything that reads it: the texture, world → its uv, strength */
  u = { tReflect: { value: null as THREE.Texture | null }, uReflMat: { value: new THREE.Matrix4() }, uRefl: { value: 1 } };
  scale = 0.3;
  on = true;
  private W = 1;
  private H = 1;

  constructor() {
    this.u.tReflect.value = this.smeared.texture;
    this.streak.u.tSrc.value = this.rt.texture;
    this.streak.mat.name = 'neon.streak';
    this.vcam.matrixAutoUpdate = false;
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);
  }

  /**
   * Make the stand-ins: every mesh marked REFLECT under `env` (the scenery,
   * already batched: its matrices are set once), and `movers` (in world space,
   * following their originals every frame).
   */
  collect(env: THREE.Object3D, movers: THREE.Object3D[], fog: THREE.Fog | null) {
    this.env = env;
    this.scene.fog = fog;
    env.updateMatrixWorld(true);
    const inv = env.matrixWorld.clone().invert();
    const stand = (o: THREE.Mesh) => {
      let p: THREE.Mesh;
      if ((o as THREE.InstancedMesh).isInstancedMesh) {
        const src = o as THREE.InstancedMesh;
        const ip = new THREE.InstancedMesh(src.geometry, src.material, src.count);
        ip.instanceMatrix = src.instanceMatrix;
        ip.instanceColor = src.instanceColor;
        ip.boundingSphere = src.boundingSphere;
        p = ip;
      } else p = new THREE.Mesh(o.geometry, o.material);
      p.frustumCulled = o.frustumCulled;
      p.renderOrder = o.renderOrder;
      p.matrixAutoUpdate = false;
      return p;
    };
    env.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.layers.isEnabled(REFLECT)) return;
      const p = stand(m);
      p.matrix.multiplyMatrices(inv, m.matrixWorld);
      this.root.add(p);
      this.links.push({ p, src: m, moves: false });
    });
    for (const mv of movers)
      mv.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const p = stand(m);
        this.scene.add(p);
        this.links.push({ p, src: m, moves: true });
      });
  }

  /** Follow the originals: shown only if they are, where they are. */
  private sync() {
    for (const { p, src, moves } of this.links) {
      let vis = true;
      for (let c: THREE.Object3D | null = src; c; c = c.parent) if (!c.visible) vis = false;
      p.visible = vis;
      if (!vis) continue;
      if (moves) {
        src.updateWorldMatrix(true, false);
        p.matrix.copy(src.matrixWorld);
      }
      if ((src as THREE.InstancedMesh).isInstancedMesh) (p as THREE.InstancedMesh).count = (src as THREE.InstancedMesh).count;
    }
    // the scenery turns round for the far player's half of a split screen
    if (this.env) this.root.matrix.makeRotationY(this.env.rotation.y);
  }

  setSize(W: number, H: number) {
    this.W = W;
    this.H = H;
    const w = Math.max(1, Math.round(W * this.scale)),
      h = Math.max(1, Math.round(H * this.scale));
    this.rt.setSize(w, h);
    this.smeared.setSize(w, h);
    this.streak.u.uTexel.value.set(1 / w, 1 / h);
  }

  /** The effects tier: 0 = no reflection, 1 = a coarse one, 2+ = the full one. */
  setTier(t: number) {
    this.on = t >= 1;
    this.u.uRefl.value = this.on ? 1 : 0;
    const s = t >= 2 ? 0.3 : 0.2;
    if (s !== this.scale) {
      this.scale = s;
      this.setSize(this.W, this.H);
    }
    if (!this.on) {
      this.rt.dispose();
      this.smeared.dispose();
    }
  }

  /** Draw what the floor mirrors into the reflection buffer. */
  render(r: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera) {
    if (!this.on) return;
    this.sync();
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const v = this.vcam;
    // the camera's position and view mirrored in y = 0, looking up through the glass
    v.position.set(e[12], -e[13], e[14]);
    this.fwd.set(-e[8], e[9], -e[10]);
    v.up.set(e[4], -e[5], e[6]);
    v.lookAt(this.fwd.add(v.position));
    v.updateMatrix();
    v.updateMatrixWorld();
    v.projectionMatrix.copy(cam.projectionMatrix);
    v.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    this.u.uReflMat.value.multiplyMatrices(BIAS, v.projectionMatrix).multiply(v.matrixWorldInverse);
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.scene, v);
    this.streak.render(r, this.smeared);
  }

  dispose() {
    this.rt.dispose();
    this.smeared.dispose();
    this.streak.dispose();
  }
}

/** GLSL (fragment): the streaked reflection for this point, rippled; vReflC comes from REFLECT_VERT. */
export const REFLECT_GLSL = /* glsl */ `
uniform sampler2D tReflect;
uniform float uRefl;
varying vec4 vReflC;
vec3 reflection(vec2 ripple) {
  return texture2D(tReflect, vReflC.xy / vReflC.w + ripple).rgb;
}`;

/** GLSL (vertex): where a world point `wp` lands in the reflection camera's picture. */
export const REFLECT_VERT = /* glsl */ `
uniform mat4 uReflMat;
varying vec4 vReflC;
void reflectCoord(vec4 wp) { vReflC = uReflMat * wp; }`;

const FLOOR_VERT = /* glsl */ `
${REFLECT_VERT}
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  reflectCoord(w);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FLOOR_FRAG = /* glsl */ `
uniform float uTime, uBeat;
varying vec3 vW;
${NOISE}
${REFLECT_GLSL}
float line(float x, float w) { float f = abs(fract(x - 0.5) - 0.5); float d = fwidth(x); return 1.0 - smoothstep(w - d, w + d, f); }
void main() {
  vec2 p = vW.xz / 4.0;
  p.y += uTime * 1.6;
  float g = max(line(p.x, 0.035), line(p.y, 0.035));
  float dist = length(vW.xz);
  // lines fade into the distance before they alias
  float far = exp(-dist * 0.006) * (1.0 - smoothstep(0.2, 0.5, fwidth(p.y)));
  vec3 lc = mix(vec3(1.0, 0.12, 0.75), vec3(0.45, 0.2, 1.0), smoothstep(40.0, 250.0, dist));
  vec3 col = vec3(0.012, 0.004, 0.03);
  vec3 V = normalize(cameraPosition - vW);
  // black glass: faint straight down, a mirror at a grazing angle
  float fres = 0.12 + 0.88 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
  if (uRefl > 0.0) {
    vec2 rip = vec2(sin(vW.z * 0.8 + uTime * 0.9) + sin(vW.x * 1.1 - uTime * 0.6), 0.0) * 0.0012;
    col += reflection(rip) * fres * 0.85;
  } else {
    // no reflection pass: paint the sun's streak where it would be
    vec2 s = vec2(vW.x / max(6.0, -vW.z * 0.28), vW.z);
    col += vec3(1.0, 0.25, 0.5) * exp(-s.x * s.x * 3.0) * smoothstep(-60.0, -300.0, vW.z) * fres * 1.2;
  }
  // the grid on top, brighter on the beat; the horizon burns
  col = col * (1.0 - g * 0.6) + lc * g * (1.6 + uBeat * 1.4) * far;
  col += vec3(0.6, 0.05, 0.4) * smoothstep(140.0, 420.0, dist) * 0.5;
  gl_FragColor = vec4(col, 1.0);
}`;

/** The grid floor (1.4 km across). */
export function gridFloor(u: { uTime: THREE.IUniform; uBeat: THREE.IUniform }, refl: Reflection) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400, 1, 1).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ uniforms: { ...u, ...refl.u }, vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, fog: false }),
  );
  m.position.y = -0.04;
  m.userData.noBatch = true;
  return m;
}

/**
 * Make a lit material (the court's) glassy: the reflection added on top, as
 * strong as the glass's Fresnel says — and softened, so bright things (the sun)
 * sheen rather than glare where the game is played.
 */
export function glassy<M extends THREE.Material>(m: M, refl: Reflection, strength: number) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, refl.u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${REFLECT_VERT}`)
      .replace('#include <project_vertex>', '#include <project_vertex>\nreflectCoord(modelMatrix * vec4(transformed, 1.0));');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${REFLECT_GLSL}`)
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if (uRefl > 0.0) {
          float fres = 0.12 + 0.88 * pow(1.0 - clamp(dot(normal, geometryViewDir), 0.0, 1.0), 4.0);
          vec3 rc = reflection(vec2(0.0));
          gl_FragColor.rgb += rc / (1.0 + rc) * fres * ${strength.toFixed(2)};
        }`,
      );
  };
  m.customProgramCacheKey = () => `glassy-${strength}`;
  return m;
}
