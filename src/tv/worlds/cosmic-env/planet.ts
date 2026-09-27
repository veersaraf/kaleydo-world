// The ringed giant the asteroid drifts above, and its moons. It sits low, its
// glowing limb on the horizon of every gameplay camera, its ring tilted up
// towards us so the far side arcs across the sky while the near side sweeps
// past below. Lit from the side by the system's star: a wide crescent, bands
// that twist, the ring's shadow on the clouds and the planet's on the ring.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NOISE } from '../../render/glsl';

type U = { uTime: THREE.IUniform };

export interface PlanetOpts {
  center: THREE.Vector3;
  radius: number;
  /** the pole (the ring lies in the equator) */
  axis: THREE.Vector3;
  /** ring radii, in planet radii */
  ring: [number, number];
  /** direction towards the star */
  light: THREE.Vector3;
}

/** the ring's density across it (radius in planet radii): broad bands, a dark gap two-thirds out
 *  (no fine ringlets: at this distance they only alias) */
const RING_DENSITY = /* glsl */ `
float ringDensity(float r) {
  float t = (r - uRing.x) / (uRing.y - uRing.x);
  if (t < 0.0 || t > 1.0) return 0.0;
  float b = 0.55 + 0.25 * sin(t * 31.0) * sin(t * 13.0) + 0.12 * sin(t * 9.0 + 1.0);
  return b * smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.9, t) * (1.0 - 0.85 * exp(-pow((t - 0.66) * 30.0, 2.0)));
}`;

// (everything is worked out in the scenery's own frame, which turns round for the
// far player's half of a split screen: positions as built, the camera brought in)
const PLANET_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying vec3 vCam;
void main() {
  vW = position;
  vN = normal;
  vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PLANET_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uC, uAxis, uLight;
uniform float uR;
uniform vec2 uRing;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCam;
${NOISE}
${RING_DENSITY}
void main() {
  vec3 n = normalize(vN);
  vec3 p = normalize(vW - uC);
  // bands by latitude, twisted by slow turbulence
  float lat = dot(p, uAxis);
  vec3 e = normalize(cross(uAxis, vec3(0.0, 0.0, 1.0)));
  float lon = atan(dot(p, cross(uAxis, e)), dot(p, e));
  // the turbulence is sheared along the bands (long streaks, curling eddies at their edges)
  float turb = fbm(vec2(lon * 3.0 + uTime * 0.004, lat * 26.0)) - 0.5;
  float b = lat * 30.0 + turb * 3.2 + sin(lon * 2.0 + lat * 7.0) * 0.4;
  // many belts: deep violet and rose, amber, cream zones between, never quite repeating
  vec3 c = mix(vec3(0.2, 0.06, 0.34), vec3(0.62, 0.2, 0.42), 0.5 + 0.5 * sin(b));
  c = mix(c, vec3(0.86, 0.46, 0.24), smoothstep(0.35, 0.95, sin(b * 0.37 + 0.7)) * 0.75);
  c = mix(c, vec3(0.86, 0.76, 0.72), smoothstep(0.55, 1.0, sin(b * 1.63 + 2.0)) * 0.5);
  c *= 0.85 + 0.3 * fbm(vec2(lon * 9.0, lat * 60.0));
  // a great storm, with a pale collar
  vec2 sp = vec2(lon - 0.9, (lat - 0.62) * 4.2);
  float sd = length(sp);
  c = mix(c, vec3(0.95, 0.4, 0.42), exp(-sd * sd * 10.0) * 0.85);
  c = mix(c, vec3(0.9, 0.82, 0.8), exp(-pow((sd - 0.45) * 7.0, 2.0)) * 0.4);
  // lit from the side: day on one side of a soft terminator, a deep night on the other
  float ndl = dot(n, uLight);
  float lit = smoothstep(-0.08, 0.5, ndl);
  // the ring's shadow on the clouds: where the ray to the star crosses the ring
  float t = dot(uC - vW, uAxis) / dot(uLight, uAxis);
  float sh = t > 0.0 ? ringDensity(length(vW + uLight * t - uC) / uR) : 0.0;
  lit *= 1.0 - sh * 0.75;
  vec3 col = c * (0.02 + lit * 0.78);
  // a thin bright limb where the air is lit
  vec3 V = normalize(vCam - vW);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 6.0);
  col += vec3(0.4, 0.5, 1.3) * rim * (0.05 + 0.9 * smoothstep(-0.2, 0.4, ndl));
  gl_FragColor = vec4(col, 1.0);
}`;

/** the atmosphere: a shell just outside the clouds, glowing where the line of sight skims it */
const AIR_FRAG = /* glsl */ `
uniform vec3 uC, uLight;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCam;
void main() {
  vec3 n = normalize(vN);
  vec3 V = normalize(vCam - vW);
  float edge = 1.0 - max(dot(n, V), 0.0);
  float g = pow(edge, 4.0) * (1.0 - smoothstep(0.93, 1.0, edge));
  float lit = smoothstep(-0.35, 0.5, dot(normalize(vW - uC), uLight));
  gl_FragColor = vec4(vec3(0.35, 0.45, 1.5) * g * (0.05 + 0.8 * lit), 1.0);
}`;

const RING_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vCam;
void main() {
  vW = position;
  vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const RING_FRAG = /* glsl */ `
uniform vec3 uC, uLight;
uniform float uR;
uniform vec2 uRing;
varying vec3 vW;
varying vec3 vCam;
${RING_DENSITY}
void main() {
  float r = length(vW - uC) / uR;
  float a = ringDensity(r);
  if (a < 0.01) discard;
  // in the planet's shadow? (the ray to the star hits the sphere)
  vec3 oc = vW - uC;
  float bq = dot(oc, uLight);
  float cq = dot(oc, oc) - uR * uR;
  float shadow = step(0.0, -bq) * step(0.0, bq * bq - cq);
  // ice glows when you look towards the star through it
  vec3 V = normalize(vCam - vW);
  float fwd = pow(max(0.0, dot(-V, uLight)), 6.0);
  vec3 col = mix(vec3(0.8, 0.62, 0.78), vec3(0.55, 0.62, 0.95), smoothstep(1.4, 2.2, r)) * (1.0 - shadow * 0.85) * (0.75 + fwd * 1.5);
  gl_FragColor = vec4(col, a * 0.55);
}`;

const MOON_FRAG = /* glsl */ `
uniform vec3 uLight;
varying vec3 vW;
varying vec3 vN;
varying vec3 vP;
varying vec3 vCam;
${NOISE}
void main() {
  vec3 n = normalize(vN);
  // craters: pits where a cellular noise dips, a lighter rim round each
  vec3 q = vP * 3.2;
  float cr = vnoise3(q) * 0.6 + vnoise3(q * 2.7) * 0.4;
  float pit = smoothstep(0.62, 0.72, cr) - smoothstep(0.72, 0.8, cr) * 0.6;
  vec3 c = vec3(0.62, 0.6, 0.72) * (0.85 + 0.3 * vnoise3(vP * 9.0)) * (1.0 - pit * 0.35);
  float lit = smoothstep(-0.05, 0.4, dot(n, uLight));
  vec3 V = normalize(vCam - vW);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 4.0);
  gl_FragColor = vec4(c * (0.03 + lit) + vec3(0.4, 0.35, 0.9) * rim * 0.25, 1.0);
}`;

const MOON_VERT = /* glsl */ `
attribute vec3 aLocal;
varying vec3 vW;
varying vec3 vN;
varying vec3 vP;
varying vec3 vCam;
void main() {
  vW = position;
  vN = normal;
  vP = aLocal;
  vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** The giant, its air, its ring, and moons (`moons`: centre and radius each). Four draws. */
export function planet(u: U, o: PlanetOpts, moons: [THREE.Vector3, number][]) {
  const g = new THREE.Group();
  const axis = o.axis.clone().normalize();
  const light = o.light.clone().normalize();
  const shared = { uC: { value: o.center }, uAxis: { value: axis }, uLight: { value: light }, uR: { value: o.radius }, uRing: { value: new THREE.Vector2(o.ring[0], o.ring[1]) } };
  const body = new THREE.Mesh(new THREE.SphereGeometry(o.radius, 96, 64).translate(o.center.x, o.center.y, o.center.z), new THREE.ShaderMaterial({ uniforms: { ...shared, uTime: u.uTime }, vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG, fog: false }));
  body.renderOrder = -6;
  const air = new THREE.Mesh(
    new THREE.SphereGeometry(o.radius * 1.045, 96, 64).translate(o.center.x, o.center.y, o.center.z),
    new THREE.ShaderMaterial({ uniforms: shared, vertexShader: PLANET_VERT, fragmentShader: AIR_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  air.renderOrder = -5;
  // the ring: a flat annulus in the equator
  const ringGeo = new THREE.RingGeometry(o.radius * o.ring[0], o.radius * o.ring[1], 256, 1);
  ringGeo.lookAt(axis);
  ringGeo.translate(o.center.x, o.center.y, o.center.z);
  const ring = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({ uniforms: shared, vertexShader: RING_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  ring.renderOrder = -5;
  // the moons, one mesh (aLocal: the point on its own sphere, for its craters)
  const parts = moons.map(([c, r], i) => {
    const s = new THREE.SphereGeometry(r, 48, 32);
    const p = s.attributes.position as THREE.BufferAttribute;
    const local = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) local.set([p.getX(k) / r + i * 7.3, p.getY(k) / r, p.getZ(k) / r], k * 3);
    s.setAttribute('aLocal', new THREE.BufferAttribute(local, 3));
    s.deleteAttribute('uv');
    return s.translate(c.x, c.y, c.z);
  });
  const moonMesh = new THREE.Mesh(mergeGeometries(parts)!, new THREE.ShaderMaterial({ uniforms: { uLight: { value: light } }, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG, fog: false }));
  parts.forEach((p) => p.dispose());
  moonMesh.renderOrder = -6;
  body.name = 'cosmic.planet';
  air.name = 'cosmic.air';
  ring.name = 'cosmic.ring';
  moonMesh.name = 'cosmic.moons';
  for (const m of [body, air, ring, moonMesh]) {
    m.frustumCulled = false;
    m.userData.noBatch = true;
  }
  g.add(body, air, ring, moonMesh);
  return g;
}
