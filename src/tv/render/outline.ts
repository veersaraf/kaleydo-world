// Inverted-hull outlines: a slightly inflated back-face copy of a mesh.
// Extrusion happens in view space so thickness is independent of mesh scale.

import * as THREE from 'three';

const cache = new Map<string, THREE.ShaderMaterial>();

export function outlineMaterial(color: THREE.Color, width: number, opts: { fog?: boolean; emissive?: number } = {}) {
  const key = `${color.getHexString()}|${width}|${opts.fog}|${opts.emissive ?? 1}`;
  let m = cache.get(key);
  if (m) return m;
  m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uColor: { value: color.clone().multiplyScalar(opts.emissive ?? 1) }, uWidth: { value: width } },
    ]),
    vertexShader: /* glsl */ `
      uniform float uWidth;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec3 transformed = position;
        #ifdef USE_INSTANCING
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);
          vec3 n = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        #else
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
          vec3 n = normalize(normalMatrix * normal);
        #endif
        float grow = uWidth * (1.0 + 0.035 * max(0.0, -mvPosition.z - 6.0));
        mvPosition.xyz += n * grow;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <fog_fragment>
      }`,
    side: THREE.BackSide,
    fog: opts.fog ?? true,
  });
  cache.set(key, m);
  return m;
}

/** Add an outline hull as a child of `mesh`. */
export function addOutline(mesh: THREE.Mesh, color: THREE.Color, width: number, opts: { fog?: boolean; emissive?: number } = {}) {
  const hull = new THREE.Mesh(mesh.geometry, outlineMaterial(color, width, opts));
  hull.name = 'outline';
  hull.renderOrder = mesh.renderOrder;
  hull.castShadow = false;
  hull.receiveShadow = false;
  mesh.add(hull);
  return hull;
}

/** Outline every mesh in a subtree (skipping ones flagged userData.noOutline). */
export function outlineTree(root: THREE.Object3D, color: THREE.Color, width: number, opts: { fog?: boolean; emissive?: number } = {}) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name !== 'outline' && !o.userData.noOutline) meshes.push(o as THREE.Mesh);
  });
  for (const m of meshes) addOutline(m, color, width * (m.userData.outlineScale ?? 1), opts);
}
