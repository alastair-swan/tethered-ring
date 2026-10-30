import * as THREE from 'three'

// Fog in the sea as seen from above it: things are mixed towards dark water by how far the line of
// sight travels through the water (its optical path), 1 - exp(-path / ATTENUATION_LENGTH). Things
// just under the surface darken only slightly; the lower slopes of an island beyond the horizon, or
// anything seen along a ray that dips under the surface, fade into the water completely.
//
// The path is the part of the ray from the camera to the fragment that lies inside the sea-level
// ellipsoid. Stretching space along the polar axis by a/b turns the ellipsoid into a sphere of radius
// a; along the stretched ray C' + s d' the sea is where |d'|^2 s^2 + 2 s (C'.d') + (|C'|^2 - a^2) < 0,
// with s still in metres along the real ray. To stay precise in float32 at planet scale it is solved
// relative to the camera, with |C'|^2 - a^2 (a small difference of huge numbers) computed in float64
// on the CPU, and the near root taken in its stable form. (A sphere through the sea level below the
// camera is not enough: the Earth is 21 km flatter at the poles, so from far out everything towards
// a pole would count as kilometres under the sea.)
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

const camera = { x: 0, y: 0, z: 0, w: 0 }   // xyz: stretched camera position C' (world axes); w: |C'|^2 - a^2
const pole = { x: 0, y: 1, z: 0, w: 0 }     // xyz: polar axis (world); w: a/b - 1
const params = { x: ATTENUATION_LENGTH, y: 0 } // x: attenuation, y: active
const tint = { x: DARK_WATER[0], y: DARK_WATER[1], z: DARK_WATER[2] }

const LIBRARIES = ['basic', 'lambert', 'phong', 'standard', 'physical', 'toon', 'matcap', 'points', 'sprite']
for (const name of LIBRARIES) {
  Object.assign(THREE.ShaderLib[name].uniforms, {
    seaCamera: { value: camera },
    seaPole: { value: pole },
    seaParams: { value: params },
    seaTint: { value: tint },
  })
}

// Computed per vertex and interpolated: vertices lie on the true surface, but on distant (coarse)
// tiles the middle of each big flat triangle sags hundreds of metres below it, and a per-pixel fog
// would count that sag as being under the sea, darkening the land in a grid of triangles.
THREE.ShaderChunk.fog_pars_vertex += `
#ifdef USE_FOG
  uniform vec4 seaCamera;
  uniform vec4 seaPole;
  uniform vec2 seaParams;
  varying float vSeaFog;
  varying float vSeaPath;
#endif
`
THREE.ShaderChunk.fog_vertex += `
#ifdef USE_FOG
  vSeaFog = 0.0;
  vSeaPath = 0.0;
  if (seaParams.y > 0.5) {
    // Camera-to-vertex offset in world axes, from the view-space position (works for every material,
    // including instanced, batched and sprite geometry).
    vec3 seaOffset = transpose(mat3(viewMatrix)) * mvPosition.xyz;
    float seaDistance = length(seaOffset);
    vec3 seaDir = seaOffset / max(seaDistance, 1e-6);
    vec3 seaDirStretched = seaDir + seaPole.w * dot(seaDir, seaPole.xyz) * seaPole.xyz;
    float seaA = dot(seaDirStretched, seaDirStretched);
    float seaB = dot(seaCamera.xyz, seaDirStretched);
    float seaDisc = seaB * seaB - seaA * seaCamera.w;
    // Only rays heading down (-b > 0) can enter the sea ahead of the camera. The near root is taken
    // in its stable form, c / q, rather than as a difference of two ~6.4e6 numbers.
    if (seaDisc > 0.0 && seaB < 0.0) {
      float seaQ = -seaB + sqrt(seaDisc);
      float seaPath = min(seaDistance, seaQ / seaA) - max(0.0, seaCamera.w / seaQ);
      if (seaPath > 0.0) {
        vSeaFog = 1.0 - exp(-seaPath / seaParams.x);
        vSeaPath = seaPath;
      }
    }
  }
#endif
`
THREE.ShaderChunk.fog_pars_fragment += `
#ifdef USE_FOG
  uniform vec3 seaTint;
  varying float vSeaFog;
  varying float vSeaPath;   // metres of the line of sight under the sea (aerialPerspective.js ends the haze there)
#endif
`
THREE.ShaderChunk.fog_fragment += `
#ifdef USE_FOG
  gl_FragColor.rgb = mix(gl_FragColor.rgb, seaTint, vSeaFog);
#endif
`

export const SeaDarkening = {
  // The uniforms for a ShaderMaterial that includes the fog chunks (shared by reference).
  uniforms() {
    return { seaCamera: { value: camera }, seaPole: { value: pole }, seaParams: { value: params }, seaTint: { value: tint } }
  },

  // active: the camera is above the sea. cameraLocal: camera position in the planet's frame (planet
  // centre at the origin, y = polar axis); ellipsoid: { a, b | f }; planetQuaternion: the planet
  // frame's orientation in the world.
  update(active, cameraLocal, ellipsoid, planetQuaternion) {
    params.y = active ? 1 : 0
    if (!active) return
    const a = ellipsoid.a
    const b = ellipsoid.b ?? a * (1 - (ellipsoid.f || 0))
    const k = a / b
    // Stretched camera (float64), then rotated into world axes.
    _v.set(cameraLocal.x, cameraLocal.y * k, cameraLocal.z)
    camera.w = _v.x * _v.x + _v.y * _v.y + _v.z * _v.z - a * a
    _v.applyQuaternion(planetQuaternion)
    camera.x = _v.x; camera.y = _v.y; camera.z = _v.z
    _v.set(0, 1, 0).applyQuaternion(planetQuaternion)
    pole.x = _v.x; pole.y = _v.y; pole.z = _v.z; pole.w = k - 1
  },
}

const _v = new THREE.Vector3()
