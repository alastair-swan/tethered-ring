import * as THREE from 'three'
import atmosphereCommon from '../shaders/atmosphereCommon.glsl?raw'
import './seaDarkening.js' // its fog code first: see below

// Aerial perspective: everything seen through the air (terrain, sea, the ring, vehicles) is dimmed by
// the air's transmittance along the line of sight and has the light the air scatters into it added,
// by the same model as the sky (atmosphereCommon.glsl), so distant mountains turn blue, the ground
// near the limb fades into the sky instead of meeting it at a hard edge, and from space the planet is
// seen through a thin blue veil.
//
// The line of sight from the camera to the fragment is clipped to the atmosphere shell and marched
// with a few samples. Like seaDarkening.js it is added to three.js's fog chunks, which every built-in
// material includes when the scene has fog (App keeps a zero-density fog on the scene while the haze
// is on), with plain-object uniforms shared by every material's copy of the library uniforms. It is
// applied after the sea's darkening (this module is imported after seaDarkening.js), since the water
// is behind the air; and in linear colour, converting from and back to the sRGB output that the fog
// chunk sees.
//
// Its uniforms are named ap* rather than atmo*, so they cannot clash with a ShaderMaterial that has
// its own atmo* uniforms and also includes the fog chunks (structureLine).
THREE.ShaderChunk.atmosphere_common = atmosphereCommon

const SAMPLES = 8
// The sky's brightness (ATMO_SUN_INTENSITY, with its exposure curve) is set for a sky seen on its own;
// over directly lit ground the same light swamps it. Through thin air (looking down from space, or at
// the hills a few kilometres off) the scattered light is scaled by HAZE_THIN; through air that nearly hides
// what is behind it (the horizon, the ground near the limb) it rises to the sky's own brightness, so
// the ground fades into the sky without a seam.
const HAZE_THIN = 0.05

const camera = { x: 0, y: 0, z: 0, w: 0 }   // xyz: stretched camera (planet centre at the origin, world axes); w: |C'|^2 - top^2
const pole = { x: 0, y: 1, z: 0, w: 0 }     // xyz: polar axis (world); w: a/b - 1
const params = { x: 0, y: 0, z: 1, w: 1 }   // y: active; z: a (m)
const sun = { x: 0, y: 1, z: 0 }            // direction to the sun (world)

const LIBRARIES = ['basic', 'lambert', 'phong', 'standard', 'physical', 'toon', 'matcap', 'points', 'sprite']
for (const name of LIBRARIES) {
  Object.assign(THREE.ShaderLib[name].uniforms, {
    apCamera: { value: camera },
    apPole: { value: pole },
    apParams: { value: params },
    apSun: { value: sun },
  })
}

THREE.ShaderChunk.fog_pars_vertex += `
#ifdef USE_FOG
  varying vec3 vApOffset;
#endif
`
// Camera-to-vertex offset in world axes (interpolates exactly across a triangle).
THREE.ShaderChunk.fog_vertex += `
#ifdef USE_FOG
  vApOffset = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif
`
THREE.ShaderChunk.fog_pars_fragment += `
#ifdef USE_FOG
  uniform vec4 apCamera;
  uniform vec4 apPole;
  uniform vec4 apParams;
  uniform vec3 apSun;
  varying vec3 vApOffset;
  #include <atmosphere_common>
#endif
`
THREE.ShaderChunk.fog_fragment += `
#ifdef USE_FOG
  if (apParams.y > 0.5) {
    float apDistance = length(vApOffset);
    vec3 apDir = vApOffset / max(apDistance, 1e-6);
    vec3 apDirStretched = apDir + apPole.w * dot(apDir, apPole.xyz) * apPole.xyz;
    float apT0, apT1;
    if (atmoRoots(dot(apDirStretched, apDirStretched), dot(apCamera.xyz, apDirStretched), apCamera.w, apT0, apT1)) {
      apT0 = max(apT0, 0.0);
      apT1 = min(apT1, apDistance);
      if (apT1 > apT0) {
        vec3 apLight, apTransmittance;
        atmoScatter(apCamera.xyz, apDirStretched, apDir, apT0, apT1, apSun, apParams.z, ${SAMPLES}, apLight, apTransmittance);
        float apOpaque = 1.0 - dot(apTransmittance, vec3(0.2126, 0.7152, 0.0722));
        apLight *= mix(${HAZE_THIN.toFixed(3)}, 1.0, apOpaque * apOpaque * apOpaque);
        vec3 apColor = sRGBTransferEOTF(vec4(gl_FragColor.rgb, 1.0)).rgb * apTransmittance + (1.0 - exp(-apLight));
        gl_FragColor.rgb = sRGBTransferOETF(vec4(apColor, 1.0)).rgb;
      }
    }
  }
#endif
`

export const AerialPerspective = {
  // active: the air hazes what is seen through it. atmosphereUniforms: the planet's (Planet.atmosphereUniforms,
  // already updated for this frame).
  update(active, atmosphereUniforms) {
    params.y = active ? 1 : 0
    if (!active) return
    const u = atmosphereUniforms
    Object.assign(camera, { x: u.atmoCamera.value.x, y: u.atmoCamera.value.y, z: u.atmoCamera.value.z, w: u.atmoCamera.value.w })
    Object.assign(pole, { x: u.atmoPole.value.x, y: u.atmoPole.value.y, z: u.atmoPole.value.z, w: u.atmoPole.value.w })
    params.z = u.atmoParams.value.z
    Object.assign(sun, { x: u.atmoSun.value.x, y: u.atmoSun.value.y, z: u.atmoSun.value.z })
  },
}
