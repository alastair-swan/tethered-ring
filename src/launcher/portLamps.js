import * as THREE from 'three'

// Floodlights on the ocean terminal's pier (OceanTerminal.js): spotlights computed in the shaders of the
// things on the pier only (the pier, the terminal, the cranes, AGVs, racks and containers), rather than
// three.js spotlights, which every lit material in the scene would pay for.
//
// The lamps are in view space (three.js's geometryPosition), updated every frame from float64 matrices
// (setLamps), because world positions at planet scale are only good to ~0.5 m in a shader. Each lamp
// lights a cone CONE_OUTER wide, falling off as 1 / distance^2; `lampColor` carries how much they are on.

export const CONE_INNER = 35 * Math.PI / 180
export const CONE_OUTER = 55 * Math.PI / 180

const uniforms = {
  portLampPosition: { value: [] },
  portLampDirection: { value: [] },
  portLampColor: { value: new THREE.Color(0, 0, 0) },
}

let count = 0

/** Sets the number of lamps (once, before any material using them is compiled). */
export function setLampCount(n) {
  count = n
  uniforms.portLampPosition.value = Array.from({ length: n }, () => new THREE.Vector3())
  uniforms.portLampDirection.value = Array.from({ length: n }, () => new THREE.Vector3())
}

const _m = new THREE.Matrix4()
const _n = new THREE.Matrix3()

/**
 * Moves the lamps into view space for `camera`. lamps: [{ position, direction }] in `frame`'s coordinates
 * (an Object3D with an up-to-date matrixWorld). color: the light (a Color times its intensity), black
 * when off.
 */
export function setLamps(lamps, frame, camera, color) {
  _m.multiplyMatrices(camera.matrixWorldInverse, frame.matrixWorld)
  _n.getNormalMatrix(_m)
  lamps.forEach((lamp, i) => {
    uniforms.portLampPosition.value[i]?.copy(lamp.position).applyMatrix4(_m)
    uniforms.portLampDirection.value[i]?.copy(lamp.direction).applyMatrix3(_n).normalize()
  })
  uniforms.portLampColor.value.copy(color)
}

/** Lights a MeshStandardMaterial with the lamps. */
export function withPortLamps(material) {
  if (count === 0) return material
  const previous = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 portLampPosition[${count}];
uniform vec3 portLampDirection[${count}];
uniform vec3 portLampColor;`)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
if (portLampColor.r + portLampColor.g + portLampColor.b > 0.0) {
  for (int i = 0; i < ${count}; i++) {
    vec3 toLamp = portLampPosition[i] - geometryPosition;
    float d2 = dot(toLamp, toLamp);
    IncidentLight lamp;
    lamp.direction = toLamp * inversesqrt(d2);
    float spot = smoothstep(${Math.cos(CONE_OUTER).toFixed(4)}, ${Math.cos(CONE_INNER).toFixed(4)}, dot(-lamp.direction, portLampDirection[i]));
    lamp.color = portLampColor * spot / max(d2, 1.0);
    lamp.visible = spot > 0.0;
    if (lamp.visible) RE_Direct(lamp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  }
}`)
  }
  const own = material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : null
  const key = `${own?.() ?? previous?.toString() ?? ''}portLamps${count}`
  material.customProgramCacheKey = () => key
  return material
}
