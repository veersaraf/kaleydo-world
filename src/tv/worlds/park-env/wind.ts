// Wind for scenery that moves in the vertex shader: one set of uniforms per
// world, ticked once a frame, shared by every material that bends in it. Grass,
// canopies, flowers and cloth all read the same gusts, so a gust front visibly
// rolls across the park instead of everything wobbling on its own.
//
// The sway is applied after instancing (in model space), so instanced meshes
// bend in one world direction whatever their own rotation; each instance takes
// its phase from where it stands, so nothing needs a per-instance attribute.

import * as THREE from 'three';

export class Wind {
  u = {
    uTime: { value: 0 },
    /** xy: the direction on the ground (x, z), z: strength */
    uWind: { value: new THREE.Vector3(0.8, 0.6, 1) },
  };

  constructor(dirX = 0.8, dirZ = 0.6, strength = 1) {
    const l = Math.hypot(dirX, dirZ) || 1;
    this.u.uWind.value.set(dirX / l, dirZ / l, strength);
  }

  tick(t: number) {
    this.u.uTime.value = t;
  }
}

export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uWind;
float windHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Horizontal push at ground point p: a lean with the wind, gust fronts rolling
// downwind across the park, and a side-to-side swing with its own phase.
vec2 windPush(vec2 p, float phase) {
  vec2 dir = uWind.xy;
  float along = dot(p, dir);
  float gust = 0.5 + 0.5 * sin(along * 0.11 - uTime * 0.9 + sin(dot(p, vec2(0.031, 0.047)) + uTime * 0.13) * 2.0);
  gust *= gust;
  float swing = sin(uTime * 1.25 + phase) * 0.65 + sin(uTime * 2.3 + phase * 2.7) * 0.35;
  return (dir * (0.25 + 0.75 * gust + 0.25 * swing) + vec2(-dir.y, dir.x) * swing * 0.3) * uWind.z;
}
`;

export type SwayKind = 'grass' | 'canopy' | 'cloth';

export interface SwayOpts {
  /** metres the top (cloth: the free edge) moves in a full gust */
  amp: number;
  /** height (model units) at which the full amplitude is reached (negative: it
   *  hangs, and the bend grows downwards); cloth: 1 = hung
   *  from its top edge (a banner), 0 = flying from a pole at its left edge */
  height: number;
  /** quick small motion on top (leaves shimmering, blades trembling); cloth: its lift, metres */
  flutter?: number;
}

/**
 * The displacement, spliced in where three.js applies the instance matrix. For
 * 'grass' and 'canopy' the bend grows with the square of the height above the
 * instance's origin; 'cloth' ripples along its normal, most at its free edge.
 */
function projectChunk(kind: SwayKind) {
  const bend =
    kind === 'cloth'
      ? /* glsl */ `
    // uv.x runs from the pole (or the left edge) out, uv.y from the bottom up;
    // uSway.y picks what holds it: 1 = hung from the top edge (a banner), 0 = a pole
    float free = mix(uv.x, 1.0 - uv.y, uSway.y);
    float ph = windHash(wp.xz) * 6.2831;
    float along = mix(uv.x, uv.x * 0.6 + (1.0 - uv.y) * 0.4, uSway.y);
    float wave = sin(along * 7.0 - uTime * 3.4 + ph) * 0.65 + sin(along * 12.0 - uTime * 5.3 + ph * 1.7) * 0.35;
    float gust = length(windPush(wp.xz, ph));
    mvPosition.xyz += normalize(nrm) * wave * free * uSway.x * (0.6 + 0.5 * gust);
    mvPosition.y += wave * free * uSway.z;`
      : /* glsl */ `
    float h = clamp((mvPosition.y - io.y) / uSway.y, 0.0, 1.5);
    float ph = windHash(wp.xz) * 6.2831;
    vec2 push = windPush(wp.xz, ph) * uSway.x * h * h;
    mvPosition.xz += push;
    // keep the length: whatever leans over dips a little (and a hanging thing, with
    // a negative height, swings up)
    mvPosition.y -= sign(uSway.y) * dot(push, push) * 0.5 / max(abs(uSway.y), 0.01);
    ${
      kind === 'grass'
        ? 'mvPosition.xz += vec2(sin(uTime * 5.3 + ph + position.x * 9.0), cos(uTime * 4.1 + ph * 1.3 + position.z * 9.0)) * uSway.z * h;'
        : 'mvPosition.xyz += nrm * sin(uTime * 2.7 + dot(position, vec3(3.1, 2.3, 2.7)) + ph) * uSway.z * min(h, 1.0);'
    }`;
  return /* glsl */ `
  vec4 mvPosition = vec4(transformed, 1.0);
  vec3 io = vec3(0.0);
  // (the raw attribute: the depth pass has no objectNormal, and both passes must bend alike)
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
    io = instanceMatrix[3].xyz;
    nrm = mat3(instanceMatrix) * normal;
  #endif
  {
    vec3 wp = (modelMatrix * vec4(io, 1.0)).xyz;
    ${bend}
  }
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
`;
}

/**
 * Make a material sway in the wind (chains any onBeforeCompile it already has).
 * `extra` adds more vertex code after the sway (e.g. a colour gradient).
 */
export function sway<M extends THREE.Material>(m: M, wind: Wind, kind: SwayKind, o: SwayOpts, extra?: { key: string; patch: (sh: THREE.WebGLProgramParametersWithUniforms) => void }): M {
  const prev = m.onBeforeCompile.bind(m);
  const u = { value: new THREE.Vector3(o.amp, o.height, o.flutter ?? 0) };
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uTime = wind.u.uTime;
    sh.uniforms.uWind = wind.u.uWind;
    sh.uniforms.uSway = u;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}\nuniform vec3 uSway;`)
      .replace('#include <project_vertex>', projectChunk(kind));
    extra?.patch(sh);
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|sway-${kind}${extra ? '-' + extra.key : ''}`;
  return m;
}

/** A shadow-casting material for something that sways: the same bend, so the shadow moves with it. */
export function swayDepth(wind: Wind, kind: SwayKind, o: SwayOpts) {
  return sway(new THREE.MeshDepthMaterial(), wind, kind, o);
}
