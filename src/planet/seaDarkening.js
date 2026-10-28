import * as THREE from 'three'

// Subtle darkening of things under the sea when seen from above it: the further the view ray travels
// through the water (depth / cos(view angle), with a flat-sea approximation), the more the colour is
// mixed towards dark water, up to MAX_DARKENING. A visual cue rather than realism.
//
// It has to reach every lit material (tube, screws, rails, brackets, cables, sea floor), so it is
// added to three.js's fog shader chunks, which every built-in material includes when the scene has
// fog (Ocean keeps scene.fog set while the sea is shown; its density is 0 above the water). The extra
// uniforms are added to the built-in shader libraries with plain-object values: three.js copies
// those by reference when it clones a library's uniforms for a material, so one update per frame
// reaches every material. (Floats are packed into a vec4 for the same reason.) Custom ShaderMaterials
// (tethers, atmosphere) do not use fog and are unaffected.
const ATTENUATION_LENGTH = 300 // m of water for the darkening to reach 63% of its maximum
const MAX_DARKENING = 0.6
const DARK_WATER = [0.012, 0.03, 0.05]

const center = { x: 0, y: 0, z: 0 }          // planet centre (world)
const params = { x: 0, y: 0, z: ATTENUATION_LENGTH, w: MAX_DARKENING } // x: sea-level radius, y: active
const tint = { x: DARK_WATER[0], y: DARK_WATER[1], z: DARK_WATER[2] }

const LIBRARIES = ['basic', 'lambert', 'phong', 'standard', 'physical', 'toon', 'matcap', 'points', 'sprite']
for (const name of LIBRARIES) {
  Object.assign(THREE.ShaderLib[name].uniforms, {
    seaCenter: { value: center },
    seaParams: { value: params },
    seaTint: { value: tint },
  })
}

THREE.ShaderChunk.fog_pars_vertex += `
#ifdef USE_FOG
  varying vec3 vSeaWorld;
#endif
`
// World position from the view-space position (works for every material, including instanced,
// batched and sprite geometry): camera + inverse view rotation * view-space offset.
THREE.ShaderChunk.fog_vertex += `
#ifdef USE_FOG
  vSeaWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif
`
THREE.ShaderChunk.fog_pars_fragment += `
#ifdef USE_FOG
  varying vec3 vSeaWorld;
  uniform vec3 seaCenter;
  uniform vec4 seaParams;
  uniform vec3 seaTint;
#endif
`
THREE.ShaderChunk.fog_fragment += `
#ifdef USE_FOG
  if (seaParams.y > 0.5) {
    vec3 seaFromCenter = vSeaWorld - seaCenter;
    float seaDepth = seaParams.x - length(seaFromCenter);
    if (seaDepth > 0.0) {
      float seaFacing = abs(dot(normalize(cameraPosition - vSeaWorld), normalize(seaFromCenter)));
      float seaPath = seaDepth / max(seaFacing, 0.05);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, seaTint, (1.0 - exp(-seaPath / seaParams.z)) * seaParams.w);
    }
  }
#endif
`

export const SeaDarkening = {
  // active: the camera is above the sea. planetCenter: world position of the planet's centre;
  // seaLevelRadius: distance from it to sea level near the camera.
  update(active, planetCenter, seaLevelRadius) {
    params.y = active ? 1 : 0
    params.x = seaLevelRadius
    center.x = planetCenter.x; center.y = planetCenter.y; center.z = planetCenter.z
  },
}
