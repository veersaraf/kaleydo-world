// Bit Kingdom's moving parts, each one draw animated in its shader (in steps,
// like sprite frames, where it suits): water in the moat with waterfalls
// pouring from the castle walls, the towers' flags, the floating ?-blocks, and
// a village behind the players with a windmill turning.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type U = { uTime: THREE.IUniform };

const C = (hex: string) => new THREE.Color(hex);

/** paint every vertex of `g` one colour (drops uvs: nothing here is textured) */
const paint = (g: THREE.BufferGeometry, hex: string) => {
  const c = C(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
};

// ---------------------------------------------------------------- water

/** where the castle's waterfalls come down (x, either side of the gate) */
const FALL_X = 4.9;

const WATER_VERT = /* glsl */ `
varying vec3 vW;
varying float vFall;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = position;
  // flat water or a falling sheet
  vFall = step(abs(normal.y), 0.5);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep, uWater, uFoam;
varying vec3 vW;
varying float vFall;
void main() {
  float t = floor(uTime * 8.0) / 8.0;
  vec3 col;
  if (vFall > 0.5) {
    // the falls: streaks racing down, frothing white at the edges
    float s = fract(vW.y * 0.35 + t * 2.2 + floor(vW.x * 1.5) * 0.37);
    col = s < 0.28 ? uFoam : uWater;
  } else {
    // the moat: rows of glints drifting to and fro, deeper under the walls,
    // churning white where the falls come down
    float row = floor(vW.z / 0.9);
    float dir = mod(row, 2.0) * 2.0 - 1.0;
    float g = fract((vW.x + dir * t * 1.2 + row * 1.7) / 3.3);
    col = mix(uWater, uDeep, step(vW.z, -74.2));
    if (g < 0.12) col = uFoam;
    float churn = 0.0;
    for (int i = 0; i < 2; i++) {
      float fx = i == 0 ? -${FALL_X.toFixed(2)} : ${FALL_X.toFixed(2)};
      vec2 d = vec2(vW.x - fx, vW.z + 74.8);
      churn = max(churn, step(length(d * vec2(0.55, 1.0)), 1.6 + 0.35 * sin(t * 9.0 + d.x)));
    }
    col = mix(col, uFoam, churn);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** The moat before the castle and two waterfalls from its walls (one mesh, in world space). */
export function water(u: U) {
  const moat = new THREE.PlaneGeometry(60, 6).rotateX(-Math.PI / 2).translate(0, 0.02, -72);
  const parts: THREE.BufferGeometry[] = [moat];
  // (between the gate and the inner towers, which stand out in front of the wall)
  for (const x of [-FALL_X, FALL_X]) parts.push(new THREE.PlaneGeometry(2.4, 7.2).translate(x, 3.6, -76.2));
  for (const p of parts) p.deleteAttribute('uv');
  const m = new THREE.Mesh(mergeGeometries(parts)!, new THREE.ShaderMaterial({ uniforms: { uTime: u.uTime, uDeep: { value: C('#1d2b53') }, uWater: { value: C('#29adff') }, uFoam: { value: C('#fff1e8') } }, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, side: THREE.DoubleSide }));
  parts.forEach((p) => p.dispose());
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- flags

/** Flags flapping in sprite steps (instanced; x runs from the pole out to the free edge). */
export function flags(u: U, at: THREE.Matrix4[], color: string) {
  const geo = new THREE.PlaneGeometry(2.6, 1.6, 6, 2).translate(1.3, 0, 0);
  const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      // the ripple snaps between whole steps, the way a sprite flag would
      transformed.z += floor(sin(uTime * 6.0 + position.x * 2.0 + float(gl_InstanceID) * 1.3) * 2.0 + 0.5) * 0.12 * position.x;`,
    );
  };
  mat.customProgramCacheKey = () => 'pixel-flag';
  const m = new THREE.InstancedMesh(geo, mat, at.length);
  at.forEach((M, i) => m.setMatrixAt(i, M));
  m.computeBoundingSphere();
  m.boundingSphere!.radius += 2;
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- ?-blocks

/** The floating ?-blocks, turning and bobbing (one instanced draw). */
export function questionBlocks(u: U, at: THREE.Vector3[]) {
  const body = paint(new THREE.BoxGeometry(1.6, 1.6, 1.6), '#ffa300');
  // the mark on both faces
  const face = paint(new THREE.BoxGeometry(0.5, 0.9, 1.7), '#fff1e8');
  const dot = paint(new THREE.BoxGeometry(0.5, 0.25, 1.7).translate(0, -0.6, 0), '#fff1e8');
  const geo = mergeGeometries([body, face, dot])!;
  [body, face, dot].forEach((g) => g.dispose());
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    const rot = `
      float ph = float(gl_InstanceID);
      float ang = uTime * 0.8 + ph;
      mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));`;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n{${rot}\nobjectNormal.xz = R * objectNormal.xz;}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n{${rot}\ntransformed.xz = R * transformed.xz;\ntransformed.y += sin(uTime * 2.0 + ph) * 0.6;}`);
  };
  mat.customProgramCacheKey = () => 'pixel-qblock';
  const m = new THREE.InstancedMesh(geo, mat, at.length);
  const M = new THREE.Matrix4();
  at.forEach((p, i) => m.setMatrixAt(i, M.makeTranslation(p.x, p.y, p.z)));
  m.computeBoundingSphere();
  m.boundingSphere!.radius += 2;
  m.userData.noBatch = true;
  return m;
}

// ---------------------------------------------------------------- the village

interface House {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  wall: string;
  roof: string;
  yaw: number;
}

/**
 * A village behind the players' end: cottages with steep roofs, lit windows and
 * doors facing the court, and a windmill. All of it one vertex-coloured mesh (a
 * batch per colour would each span the village, and none of them would ever be
 * culled), and the windmill's sails, which turn in their shader.
 */
export function village(u: U) {
  const out: THREE.Object3D[] = [];
  const houses: House[] = [
    { x: -30, z: 38, w: 6, d: 5, h: 4, wall: '#fff1e8', roof: '#ff004d', yaw: 0.2 },
    { x: -20, z: 46, w: 5, d: 5, h: 3.5, wall: '#ffccaa', roof: '#ab5236', yaw: -0.1 },
    { x: -38, z: 52, w: 7, d: 5, h: 4.5, wall: '#c2c3c7', roof: '#7e2553', yaw: 0.35 },
    { x: 22, z: 40, w: 6, d: 5, h: 4, wall: '#ffccaa', roof: '#29adff', yaw: -0.25 },
    { x: 31, z: 50, w: 5, d: 6, h: 5, wall: '#fff1e8', roof: '#ff004d', yaw: -0.4 },
    { x: 13, z: 56, w: 6, d: 5, h: 3.8, wall: '#c2c3c7', roof: '#ab5236', yaw: 0.1 },
    { x: -8, z: 62, w: 7, d: 6, h: 4.2, wall: '#fff1e8', roof: '#7e2553', yaw: -0.05 },
    { x: 42, z: 34, w: 5, d: 5, h: 3.6, wall: '#fff1e8', roof: '#ab5236', yaw: -0.6 },
  ];
  const parts: THREE.BufferGeometry[] = [];
  const M = new THREE.Matrix4();
  const place = (g: THREE.BufferGeometry, hex: string, x: number, y: number, z: number) => parts.push(paint(g, hex).translate(x, y, z));
  for (const h of houses) {
    const at = parts.length;
    place(new THREE.BoxGeometry(h.w, h.h, h.d), h.wall, 0, h.h / 2, 0);
    // a gabled roof: a triangular prism along the house, its ridge up, its eaves
    // overhanging the walls (a 3-sided cylinder, laid along x, turned apex-up)
    const rr = h.d * 0.72;
    place(new THREE.CylinderGeometry(rr, rr, h.w + 0.6, 3, 1).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2), h.roof, 0, h.h + rr * 0.5, 0);
    // the door and two windows on the side facing the court, and a chimney
    place(new THREE.BoxGeometry(1, 1.8, 0.2), '#ab5236', -h.w * 0.15, 0.9, -h.d / 2 - 0.05);
    for (const wx of [h.w * 0.25, -h.w * 0.38]) place(new THREE.BoxGeometry(0.9, 0.9, 0.2), wx > 0 ? '#ffec27' : '#1d2b53', wx, h.h * 0.62, -h.d / 2 - 0.05);
    place(new THREE.BoxGeometry(0.7, 1.8, 0.7), '#5f574f', h.w * 0.3, h.h + rr * 0.75, h.d * 0.22);
    M.makeRotationY(h.yaw).setPosition(h.x, 0, h.z);
    for (let i = at; i < parts.length; i++) parts[i].applyMatrix4(M);
  }
  // the windmill: a tapering tower, a cap, and sails that turn
  const mill = new THREE.Group();
  const millAt = parts.length;
  place(new THREE.CylinderGeometry(1.8, 2.8, 11, 8), '#c2c3c7', 0, 5.5, 0);
  place(new THREE.ConeGeometry(2.4, 2.6, 8), '#ab5236', 0, 12.3, 0);
  place(new THREE.BoxGeometry(1.2, 2.2, 0.3), '#ab5236', 0, 1.1, -2.6);
  M.makeRotationY(0.55).setPosition(-46, 0, 44);
  for (let i = millAt; i < parts.length; i++) parts[i].applyMatrix4(M);
  const blades: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const arm = paint(new THREE.BoxGeometry(0.35, 6.2, 0.2).translate(0, 3.3, 0), '#ab5236');
    const sail = paint(new THREE.BoxGeometry(1.5, 4.6, 0.1).translate(0.95, 3.8, 0), '#fff1e8');
    for (const g of [arm, sail]) blades.push(g.rotateZ(a));
  }
  const hub = paint(new THREE.BoxGeometry(0.8, 0.8, 0.6), '#5f574f');
  const sailsG = mergeGeometries([...blades, hub])!;
  const sailMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  sailMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        // turning a sixteenth of a turn at a time, four times a second: a sprite's frames
        float a = floor(uTime * 4.0) * 0.3927;
        transformed.xy = mat2(cos(a), sin(a), -sin(a), cos(a)) * transformed.xy;
      }`,
    );
  };
  sailMat.customProgramCacheKey = () => 'pixel-sails';
  const sails = new THREE.Mesh(sailsG, sailMat);
  sails.position.set(0, 10.6, -2.7);
  sails.userData.noBatch = true;
  mill.add(sails);
  mill.position.set(-46, 0, 44);
  mill.rotation.y = 0.55;
  out.push(mill);
  // a sandy path from the court's end to the village square
  place(new THREE.PlaneGeometry(2.6, 48).rotateX(-Math.PI / 2), '#ffccaa', 0, 0.012, 46);
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  const homes = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  homes.userData.noBatch = true;
  out.push(homes);
  return out;
}
