import * as THREE from 'three'
import '../planet/aerialPerspective.js' // registers <atmosphere_common>
import { ATMO_HEIGHT_R, SKY_MU_MIN, SKY_SAMPLES, daylightWhiteBalance, skyIrradianceTable } from './skyIrradiance.js'

// Sunlight and skylight on everything lit by three.js's lights (every built-in lit material), worked out
// per fragment from where it is relative to the planet:
//
// - The sun (the scene's directional light) is dimmed by the air between the fragment and the sun, by
//   the same model as the sky (atmosphereCommon.glsl): reddened near sunrise and sunset, and gone where
//   the planet is in the way, so the night side of the ring and launcher is in the planet's shadow.
// - The ambient light becomes a hemisphere: from above, the sky (skyIrradiance.js, for the sun's
//   elevation there), which thins out with height; from below, sunlight and skylight bounced off the
//   ground (GROUND_ALBEDO) and, high up, the light the air below scatters back up. Both scale with the
//   sun's intensity, and the planet's share of the view below shrinks with distance.
// - The scene's ambient light is added on top: a little light at night, so things stay visible.
//
// Both are white-balanced for daylight (sun plus sky under a noon sun is white). Bodies without air
// (air = false) get the planet's shadow and the light off the ground only.
//
// The model is the <sun_and_sky_light> chunk (slLightAt), which other shaders can include too, with
// SunAndSkyLight.uniforms (structure lines use it). Like aerialPerspective.js, the uniforms are plain
// objects shared by every material's copy of the library uniforms. The lighting is only active while App renders the main scene: the sky pass and
// other scenes, whose cameras are not the main camera, keep three.js's plain lighting.

// Fraction of the light reaching the ground that it reflects (sea ~0.06, land ~0.15-0.3).
const GROUND_ALBEDO = 0.15

const table = skyIrradianceTable()
const white = daylightWhiteBalance(table)
const vec3 = (c) => `vec3(${c.map(v => v.toExponential(5)).join(', ')})`

const camera = { x: 0, y: 0, z: 0, w: 0 }   // xyz: stretched camera (planet centre at the origin, world axes)
const pole = { x: 0, y: 1, z: 0, w: 0 }     // xyz: polar axis (world); w: a/b - 1
const sun = { x: 0, y: 1, z: 0 }            // direction to the sun (world)
const params = { x: 0, y: 1, z: 1, w: GROUND_ALBEDO } // x: active; y: air (0 or 1); z: a (m); w: ground albedo
const lineLight = { x: 0, y: 0, z: 0, w: 1 } // xyz: the ambient (night) light / pi; w: the sun's intensity / pi

const uniforms = {
  slCamera: { value: camera },
  slPole: { value: pole },
  slSun: { value: sun },
  slParams: { value: params },
  slLineLight: { value: lineLight },
}

const LIBRARIES = ['lambert', 'phong', 'standard', 'physical', 'toon']
for (const name of LIBRARIES) Object.assign(THREE.ShaderLib[name].uniforms, uniforms)

// Needs PI (<common>).
THREE.ShaderChunk.sun_and_sky_light = `
#ifndef SUN_AND_SKY_LIGHT
#define SUN_AND_SKY_LIGHT
uniform vec4 slCamera;
uniform vec4 slPole;
uniform vec3 slSun;
uniform vec4 slParams;
uniform vec4 slLineLight;
#include <atmosphere_common>
const vec3 SL_SKY[${SKY_SAMPLES}] = vec3[${SKY_SAMPLES}](${table.map(vec3).join(', ')});
const vec3 SL_WHITE = ${vec3(white)};

// Sky irradiance on a level surface at sea level, per unit of sunlight, for a sun at zenith cosine mu.
vec3 slSkyIrradiance(float mu) {
  float x = clamp((mu - ${SKY_MU_MIN.toFixed(3)}) / ${(1 - SKY_MU_MIN).toFixed(3)} * ${(SKY_SAMPLES - 1).toFixed(1)}, 0.0, ${(SKY_SAMPLES - 1).toFixed(1)});
  int i = int(min(floor(x), ${(SKY_SAMPLES - 2).toFixed(1)}));
  return mix(SL_SKY[i], SL_SKY[i + 1], x - float(i));
}

// The air's transmittance from p (stretched, planet-centred) to the sun; zero where the planet is in the way.
vec3 slSunTransmittance(vec3 p) {
  vec2 depth = atmoSunDepth(p, slSun, slParams.z);
  if (depth.x > 1e8) return vec3(0.0);
  return exp(-(ATMO_BETA_R * depth.x + ATMO_BETA_M * 1.1 * depth.y) * slParams.y);
}

// The light at a point (offset from the camera, world axes), per unit of sunlight: the sun's
// (direct), the sky's from above (skyDown) and the ground's from below (groundUp), on surfaces facing
// them; and the local up direction (world axes).
void slLightAt(vec3 offset, out vec3 direct, out vec3 skyDown, out vec3 groundUp, out vec3 up) {
  vec3 p = slCamera.xyz + offset + slPole.w * dot(offset, slPole.xyz) * slPole.xyz;
  float r = length(p);
  up = p / r;
  float mu = dot(up, slSun);
  vec3 white = mix(vec3(1.0), SL_WHITE, slParams.y);
  direct = slSunTransmittance(p) * white;
  vec3 sky = slSkyIrradiance(mu) * slParams.y * white;
  float above = exp(-max(r - slParams.z, 0.0) / ${ATMO_HEIGHT_R.toFixed(1)}); // share of the air above
  float planetBelow = min(1.0, slParams.z * slParams.z / (r * r));
  vec3 groundLight = slSunTransmittance(up * slParams.z) * white * max(mu, 0.0) + sky;
  skyDown = sky * above;
  groundUp = (slParams.w * groundLight + sky * (1.0 - above)) * planetBelow;
}
#endif
`
THREE.ShaderChunk.lights_pars_begin += `
#include <sun_and_sky_light>
`

const LIGHTS_BEGIN = 'IncidentLight directLight;'
const DIRECTIONAL = 'getDirectionalLightInfo( directionalLight, directLight );'
const AMBIENT = 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );'
for (const marker of [LIGHTS_BEGIN, DIRECTIONAL, AMBIENT]) {
  if (THREE.ShaderChunk.lights_fragment_begin.split(marker).length !== 2) throw new Error(`sunAndSkyLight: no unique '${marker}' in lights_fragment_begin`)
}
THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin
  .replace(LIGHTS_BEGIN, `${LIGHTS_BEGIN}
vec3 slDirect = vec3(1.0);
vec3 slSkyDown = vec3(0.0);
vec3 slGroundUp = vec3(0.0);
vec3 slUpView = vec3(0.0, 1.0, 0.0);
if (slParams.x > 0.5) {
  vec3 slUp;
  slLightAt((vec4(geometryPosition, 0.0) * viewMatrix).xyz, slDirect, slSkyDown, slGroundUp, slUp);
  slUpView = normalize((viewMatrix * vec4(slUp, 0.0)).xyz);
  #if NUM_DIR_LIGHTS > 0
    slSkyDown *= directionalLights[0].color;
    slGroundUp *= directionalLights[0].color;
  #else
    slSkyDown = slGroundUp = vec3(0.0);
  #endif
}`)
  .replace(DIRECTIONAL, `${DIRECTIONAL}
directLight.color *= slDirect;`)
  .replace(AMBIENT, `${AMBIENT}
irradiance += mix(slGroundUp, slSkyDown, 0.5 + 0.5 * dot(geometryNormal, slUpView));`)

export const SunAndSkyLight = {
  uniforms,

  // active: light the scene about to be rendered this way (the main scene, seen by the camera the
  // planet's atmosphere uniforms were updated for). atmosphereUniforms: Planet.atmosphereUniforms.
  // air: the planet has an atmosphere that scatters light.
  // sunIntensity, nightLight (THREE.Color, times its intensity): the scene's sun and ambient light, for
  // shaders without three.js's lights (pi is full sunlight on a surface facing the sun).
  update(active, atmosphereUniforms, air, sunIntensity, nightLight) {
    params.x = active ? 1 : 0
    if (!active) return
    const u = atmosphereUniforms
    Object.assign(camera, { x: u.atmoCamera.value.x, y: u.atmoCamera.value.y, z: u.atmoCamera.value.z })
    Object.assign(pole, { x: u.atmoPole.value.x, y: u.atmoPole.value.y, z: u.atmoPole.value.z, w: u.atmoPole.value.w })
    Object.assign(sun, { x: u.atmoSun.value.x, y: u.atmoSun.value.y, z: u.atmoSun.value.z })
    params.y = air ? 1 : 0
    params.z = u.atmoParams.value.z
    Object.assign(lineLight, { x: nightLight.r / Math.PI, y: nightLight.g / Math.PI, z: nightLight.b / Math.PI, w: sunIntensity / Math.PI })
  },
}
