import * as THREE from 'three'

// Fog in the sea as seen from above it: things are mixed towards dark water by how far the line of
// sight travels through the water (its optical path), 1 - exp(-path / ATTENUATION_LENGTH). Things
// just under the surface darken only slightly; the lower slopes of an island beyond the horizon, or
// anything seen along a ray that dips under the surface, fade into the water completely.
//
// The path is the part of the ray from the camera to the fragment that lies inside the sea-level
// sphere (radius R, the sea level below the camera). To stay precise in float32 at planet scale it is
// solved relative to the camera: along a ray with direction d at angle phi to the camera's vertical,
// s^2 + 2 s Rc cos(phi) + (Rc^2 - R^2) = 0, where Rc is the camera's distance from the centre and
// Rc^2 - R^2 = h (2R + h) is computed in float64 on the CPU.
//
// It has to reach every lit material (tube, screws, rails, brackets, cables, sea floor, terrain), so
// it is added to three.js's fog shader chunks, which every built-in material includes when the scene
// has fog (Ocean keeps scene.fog set while the sea is shown; its density is 0 above the water). The
// extra uniforms are added to the built-in shader libraries with plain-object values: three.js copies
// those by reference when it clones a library's uniforms for a material, so one update per frame
// reaches every material. (Floats are packed into a vec4 for the same reason.) Custom ShaderMaterials
// (tethers, atmosphere) do not use fog and are unaffected.
const ATTENUATION_LENGTH = 500 // m of water for things to fade 63% of the way into it
const DARK_WATER = [0.012, 0.03, 0.05]

const ray = { x: 0, y: 0, z: ATTENUATION_LENGTH, w: 0 } // x: Rc, y: Rc^2 - R^2, z: attenuation, w: active
const up = { x: 0, y: 1, z: 0 }                          // camera's vertical (world)
const tint = { x: DARK_WATER[0], y: DARK_WATER[1], z: DARK_WATER[2] }

const LIBRARIES = ['basic', 'lambert', 'phong', 'standard', 'physical', 'toon', 'matcap', 'points', 'sprite']
for (const name of LIBRARIES) {
  Object.assign(THREE.ShaderLib[name].uniforms, {
    seaRay: { value: ray },
    seaUp: { value: up },
    seaTint: { value: tint },
  })
}

THREE.ShaderChunk.fog_pars_vertex += `
#ifdef USE_FOG
  varying vec3 vSeaOffset;
#endif
`
// Camera-to-fragment offset in world orientation, from the view-space position (works for every
// material, including instanced, batched and sprite geometry).
THREE.ShaderChunk.fog_vertex += `
#ifdef USE_FOG
  vSeaOffset = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif
`
THREE.ShaderChunk.fog_pars_fragment += `
#ifdef USE_FOG
  varying vec3 vSeaOffset;
  uniform vec4 seaRay;
  uniform vec3 seaUp;
  uniform vec3 seaTint;
#endif
`
THREE.ShaderChunk.fog_fragment += `
#ifdef USE_FOG
  if (seaRay.w > 0.5) {
    float seaDistance = length(vSeaOffset);
    vec3 seaDir = vSeaOffset / max(seaDistance, 1e-6);
    float seaB = seaRay.x * dot(seaDir, seaUp);
    float seaDisc = seaB * seaB - seaRay.y;
    // Only rays heading down (-b > 0) can enter the sea ahead of the camera. The near root is taken
    // in its stable form, c / far, rather than as a difference of two ~6.4e6 numbers.
    if (seaDisc > 0.0 && seaB < 0.0) {
      float seaFar = -seaB + sqrt(seaDisc);
      float seaNear = seaRay.y / seaFar;
      float seaPath = min(seaDistance, seaFar) - max(0.0, seaNear);
      if (seaPath > 0.0) gl_FragColor.rgb = mix(gl_FragColor.rgb, seaTint, 1.0 - exp(-seaPath / seaRay.z));
    }
  }
#endif
`

export const SeaDarkening = {
  // The uniforms for a ShaderMaterial that includes the fog chunks (shared by reference).
  uniforms() {
    return { seaRay: { value: ray }, seaUp: { value: up }, seaTint: { value: tint } }
  },

  // active: the camera is above the sea. cameraUp: the camera's vertical (world, unit);
  // cameraRadius: its distance from the planet's centre; seaLevelRadius: sea level below it.
  update(active, cameraUp, cameraRadius, seaLevelRadius) {
    ray.w = active ? 1 : 0
    ray.x = cameraRadius
    const h = cameraRadius - seaLevelRadius
    ray.y = h * (2 * seaLevelRadius + h)
    up.x = cameraUp.x; up.y = cameraUp.y; up.z = cameraUp.z
  },
}
