import * as THREE from 'three'
import '../../scene/sunAndSkyLight.js' // registers <sun_and_sky_light> (and <atmosphere_common>)
import { SunAndSkyLight } from '../../scene/sunAndSkyLight.js'
import { cloudNoiseTextures } from './cloudNoise.js'
import { WeatherMap } from './weatherMap.js'

// Volumetric clouds over the whole planet, from the weather (weatherMap.js) and tiling noise
// (cloudNoise.js), drawn over the rendered scene in three passes at RESOLUTION of the screen:
//
// 1. Distance: the scene again, writing each pixel's distance from the camera, so the clouds stop at
//    whatever is in front of them (the ground, the sea, the ring, a vehicle in a cloud).
// 2. Clouds: each pixel's line of sight is marched through the cloud shell (sea level to SHELL_TOP over
//    the ellipsoid, stretched to a sphere as the sky does), up to the ground or the scene, in MARCH_STEPS
//    steps spaced more finely near the camera, with a fixed per-pixel jitter (no noise that changes
//    from frame to frame, so recordings are repeatable). At each step:
//    - The weather map gives the cover, the low cloud layer's base and top, the convective share, the
//      rain and the wind. Convective weather gives cumulus, rising into towers in heavy showers;
//      otherwise the layer is stratiform.
//    - The density is the shape noise, its gaps widened where the cover is low and its edges eroded by
//      the detail noise, through the layer's height profile. The noise is anchored to the planet
//      (sampled at planet coordinates relative to the camera plus the camera's position modulo the
//      tile, worked out in float64), and drifts with the wind by flow-mapping: two copies, each
//      displaced by the wind for up to DRIFT_PERIOD and restarted in turn, cross-faded, so the drift
//      never distorts it without bound.
//    - Light: the sun's (dimmed by the air and the planet's shadow: sunAndSkyLight.js) through the
//      cloud towards the sun (a short march), with a two-lobed phase function and approximate
//      multiple scattering; the sky's and the ground's from below and above; and the haze between
//      the camera and the cloud.
// 3. Composite: the clouds over the scene (premultiplied; their transmittance dims what is behind).

const RESOLUTION = 0.5
const SHELL_TOP = 13000 // m
const MARCH_STEPS = 64
const LIGHT_STEPS = 5
// The noise tiles (m): shape and detail.
const SHAPE_TILE = 24000
const DETAIL_TILE = 3000
// Large-scale structure (cloud streets and cells, clusters and gaps): the shape noise again on this tile
// (m), moving the cover through a probit transform, so it shows where the clouds themselves are too
// small to see (from orbit).
const MACRO_TILE = 400000
const DRIFT_PERIOD = 2400 // s
// Extinction (1/m) of a cloud at full density.
const EXTINCTION = 0.03

const fullscreenVertex = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const distanceMaterial = new THREE.ShaderMaterial({
  vertexShader: `
#include <common>
#include <logdepthbuf_pars_vertex>
varying float vCloudDistance;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  vCloudDistance = length(mvPosition.xyz);
}
`,
  fragmentShader: `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vCloudDistance;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vCloudDistance, 0.0, 0.0, 1.0);
}
`,
  side: THREE.DoubleSide,
})

// The cloud march's fragment shader, for the shape noise's statistics (cloudNoise.js).
const marchFragment = (stats) => `
#include <common>
#include <sun_and_sky_light>
precision highp sampler3D;
uniform sampler2D distanceMap;
uniform sampler2D weatherA;
uniform sampler2D weatherB;
uniform sampler3D shapeNoise;
uniform sampler3D detailNoise;
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
uniform mat3 worldToPlanet;
uniform vec3 shapeOffset[2];    // the camera's planet position modulo the shape tile (m), for each drift copy
uniform vec3 detailOffset[2];
uniform vec3 macroOffset;        // the camera's planet position modulo the large-scale tile (m)
uniform vec3 drift;             // x, y: the two copies' drift times (s); z: the second copy's weight
uniform vec2 exposure;          // x: the sky's exposure (Planet.js); y: the sun's intensity
uniform float pixelAngle;       // radians per pixel of the cloud target
varying vec2 vUv;

const float SHELL_TOP = ${SHELL_TOP.toFixed(1)};
const float EXTINCTION = ${EXTINCTION.toFixed(4)};

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

// The shape value's quantiles (cloudNoise.js): the threshold that leaves a fraction cover above it.
const float SHAPE_QUANTILE[${stats.quantiles.length}] = float[](${stats.quantiles.map(q => q.toFixed(5)).join(', ')});
const float SHAPE_MEAN = ${stats.mean.toFixed(5)};
float normalCdf(float x) {
  float t = 1.0 / (1.0 + 0.2316419 * abs(x));
  float tail = exp(-0.5 * x * x) * 0.3989422804 * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0.0 ? 1.0 - tail : tail;
}
float probit(float p) {
  float q = p < 0.5 ? p : 1.0 - p;
  float t = sqrt(-2.0 * log(q));
  float x = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1.0 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return p < 0.5 ? -x : x;
}
float coverThreshold(float cover) {
  float x = clamp(1.0 - cover, 0.0, 1.0) * ${(stats.quantiles.length - 1).toFixed(1)};
  int i = int(min(floor(x), ${(stats.quantiles.length - 2).toFixed(1)}));
  return mix(SHAPE_QUANTILE[i], SHAPE_QUANTILE[i + 1], x - float(i));
}

// The planet frame position (m, relative to the camera) and its latitude/longitude (degrees) for a
// point at offset o (world axes) from the camera; p is that point in the stretched frame.
vec2 latLon(vec3 p) {
  vec3 q = worldToPlanet * p;
  float k = 1.0 + slPole.w;
  return vec2(degrees(atan(k * q.y, length(q.xz))), degrees(atan(q.x, q.z)));
}

vec2 mapUv(vec2 ll) { return vec2(ll.y / 360.0 + 0.5, (ll.x + 90.0) / 180.0); }

// Cloud density (0..1) at stretched point p (planet centre at the origin) and planet-frame offset from
// the camera local, altitude h (m); full adds the detail erosion.
float cloudDensity(vec3 p, vec3 local, float h, bool full, float footprint, out float layer) {
  layer = 0.0;
  vec2 uv = mapUv(latLon(p));
  vec4 a = texture2D(weatherA, uv);
  vec4 b = texture2D(weatherB, uv);
  // (The reanalysis's total cover counts thin high cloud too, and a threshold on 3D noise covers more
  // of a column than of a level: a little less for the layer.)
  float cover = a.r * 0.8;
  if (cover < 0.01) return 0.0;
  // (Its features, from about 12 km up, fade to their mean as they shrink below a pixel.)
  float macroDetail = 1.0 - smoothstep(2000.0, 8000.0, footprint);
  if (macroDetail > 0.0) {
    vec4 m = texture(shapeNoise, (local + macroOffset) / ${MACRO_TILE.toFixed(1)});
    float macro = remap(m.r, m.g * 0.625 + m.b * 0.25 + m.a * 0.125 - 1.0, 1.0, 0.0, 1.0) - SHAPE_MEAN;
    cover = normalCdf(probit(clamp(cover, 0.005, 0.995)) + 9.0 * macro * macroDetail);
  }
  float convective = a.b;
  float base = b.x * 1000.0;
  // Cumulus towers in showers: the top rises with the convective rain.
  float top = max(b.y * 1000.0, base + 300.0) + 9000.0 * convective * clamp(a.g / 3.0, 0.0, 1.0);
  float hf = (h - base) / (top - base);
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  layer = hf;
  // Height profiles: cumulus rounded at the top, stratus flat.
  float cumulus = smoothstep(0.0, 0.08, hf) * smoothstep(1.0, 0.45, hf);
  float stratus = smoothstep(0.0, 0.2, hf) * smoothstep(1.0, 0.75, hf);
  float profile = mix(stratus, cumulus, convective);
  // The wind (planet axes) drifts the noise.
  vec3 up = normalize(worldToPlanet * p);
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), up));
  vec3 north = cross(up, east);
  vec3 wind = (b.z * east + b.w * north) * 1.5;   // (stronger aloft than at the surface)
  // Too far for the noise's features (a few hundred metres up) to be seen: its expected value.
  float lod = smoothstep(150.0, 900.0, footprint);
  float shape = 0.0, detail = 0.0;
  if (lod < 1.0) {
    for (int i = 0; i < 2; i++) {
      float weight = i == 0 ? 1.0 - drift.z : drift.z;
      vec3 q = local - wind * (i == 0 ? drift.x : drift.y);
      vec4 s = texture(shapeNoise, (q + shapeOffset[i]) / ${SHAPE_TILE.toFixed(1)});
      float fbm = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
      shape += weight * remap(s.r, fbm - 1.0, 1.0, 0.0, 1.0);
      if (full) {
        vec4 dn = texture(detailNoise, (q + detailOffset[i]) / ${DETAIL_TILE.toFixed(1)});
        detail += weight * (dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125);
      }
    }
    // (Cross-fading two copies narrows the spread: restore it, so the cover stays the same.)
    shape = SHAPE_MEAN + (shape - SHAPE_MEAN) / length(vec2(1.0 - drift.z, drift.z));
  }
  float threshold = coverThreshold(cover);
  float d = clamp((shape - threshold) / (1.0 - threshold), 0.0, 1.0) * profile;
  if (full && d > 0.0) d = remap(d, 0.3 * mix(detail, 1.0 - detail, clamp(hf * 4.0, 0.0, 1.0)), 1.0, 0.0, 1.0);
  // Too far for the clouds to be told apart: a density giving the column the transmittance of a cover
  // of opaque clouds, 1 - 0.9 cover (spreading the clouds' own density out evenly would make any cover
  // of them opaque).
  float far = -log(1.0 - 0.9 * cover) / (EXTINCTION * (top - base) * 0.5) * profile;
  d = mix(clamp(d, 0.0, 1.0), far, lod);
  return d * mix(1.0, 1.6, convective);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float phaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Ray against a sphere of radius r about the origin from o along unit d: entry and exit (-1 if none).
vec2 sphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d), c = dot(o, o) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

void main() {
  vec4 view = inverseProjection * vec4(vUv * 2.0 - 1.0, -1.0, 1.0); // (the near plane: the far one is too far for float32)
  vec3 dirWorld = normalize((cameraWorld * vec4(normalize(view.xyz / view.w), 0.0)).xyz);
  // The stretched frame: positions with the polar axis scaled so the ellipsoid is a sphere of radius a.
  vec3 ds = dirWorld + slPole.w * dot(dirWorld, slPole.xyz) * slPole.xyz;
  float stretch = length(ds);
  vec3 d = ds / stretch;
  vec3 c = slCamera.xyz;
  float a = slParams.z;
  float sceneDistance = texture2D(distanceMap, vUv).r;
  vec2 outer = sphere(c, d, a + SHELL_TOP);
  vec2 ground = sphere(c, d, a);
  float t0 = max(outer.x, 0.0);
  float t1 = outer.y;
  if (ground.x > 0.0) t1 = min(t1, ground.x);
  t1 = min(t1, sceneDistance * stretch);
  if (outer.y <= 0.0 || t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // Steps spaced as the square of their index (finer near the start), with a fixed per-pixel jitter.
  float jitter = hash12(gl_FragCoord.xy);
  float transmittance = 1.0;
  vec3 light = vec3(0.0);
  float depthSum = 0.0, depthWeight = 0.0;
  float sunCos = dot(d, normalize(slSun + slPole.w * dot(slSun, slPole.xyz) * slPole.xyz));
  float phase = mix(phaseHG(sunCos, 0.65), phaseHG(sunCos, -0.2), 0.3);
  vec3 sunDirS = normalize(slSun + slPole.w * dot(slSun, slPole.xyz) * slPole.xyz);
  float sunIntensity = exposure.y;
  float prev = t0;
  for (int i = 0; i < ${MARCH_STEPS}; i++) {
    float f = (float(i) + jitter) / float(${MARCH_STEPS});
    float t = t0 + (t1 - t0) * f * f;
    float dt = t - prev;
    prev = t;
    vec3 p = c + d * t;
    float h = length(p) - a;
    if (h < 0.0 || h > SHELL_TOP) continue;
    vec3 local = worldToPlanet * (dirWorld * (t / stretch));
    float footprint = t / stretch * pixelAngle;
    float layer;
    float density = cloudDensity(p, local, h, true, footprint, layer);
    if (density <= 0.001) continue;
    float sigma = EXTINCTION * density;
    // Light towards the sun through the cloud.
    float od = 0.0;
    float step = 60.0;
    for (int j = 0; j < ${LIGHT_STEPS}; j++) {
      vec3 q = p + sunDirS * step * (float(j) + 0.5);
      vec3 ql = local + worldToPlanet * (slSun * step * (float(j) + 0.5));
      float unused;
      od += cloudDensity(q, ql, length(q) - a, false, footprint, unused) * step;
      step *= 2.0;
    }
    od *= EXTINCTION;
    vec3 sunlight = slSunTransmittance(p) * mix(vec3(1.0), SL_WHITE, slParams.y) * sunIntensity;
    // Multiple scattering, approximately: octaves of weaker extinction and flatter phase.
    float scatter = 0.0;
    float att = 1.0, ext = 1.0, ph = 1.0;
    for (int k = 0; k < 3; k++) {
      scatter += att * exp(-od * ext) * mix(1.0 / (4.0 * PI), phase, ph);
      att *= 0.5; ext *= 0.25; ph *= 0.5;
    }
    // The powder effect: the sunlit side of a cloud's surface is darker than its depths' glow.
    scatter *= 1.0 - 0.6 * exp(-od * 2.0);
    // Sky and ground light: from the sky above (brighter towards the top of the layer) and the ground.
    vec3 skyDown, groundUp, direct, upW;
    slLightAt(dirWorld * (t / stretch), direct, skyDown, groundUp, upW);
    vec3 ambient = (skyDown * 1.6 + groundUp * 0.6) * sunIntensity * RECIPROCAL_PI * 0.5;
    // Sunlight scattered many times inside the cloud, which lights even its shaded depths and base:
    // more higher up, nearer the sunlit top.
    vec3 diffuse = sunlight * 0.05 * mix(0.35, 1.0, layer);
    vec3 sourceLight = sunlight * scatter * 4.0 + ambient + diffuse;
    // Energy-conserving integration across the step.
    float stepT = exp(-sigma * dt);
    light += transmittance * sourceLight * (1.0 - stepT);
    depthSum += transmittance * (1.0 - stepT) * t;
    depthWeight += transmittance * (1.0 - stepT);
    transmittance *= stepT;
    if (transmittance < 0.01) break;
  }
  // Haze between the camera and the cloud (by its opacity-weighted distance): the air's full in-scatter
  // (the ground's haze is scaled down over directly lit ground, which would leave bright clouds only
  // reddened by the air, yellow, rather than also hazed blue).
  if (depthWeight > 0.0 && slParams.y > 0.5) {
    float tc = depthSum / depthWeight;
    float at0, at1;
    if (atmoRoots(dot(ds / stretch, ds / stretch), dot(c, d), dot(c, c) - (a + 100000.0) * (a + 100000.0), at0, at1)) {
      vec3 airLight, airTransmittance;
      atmoScatter(c, d, dirWorld, max(at0, 0.0), min(at1, tc), slSun, a, 8, airLight, airTransmittance);
      airLight *= exposure.x;
      light = light * airTransmittance + (1.0 - exp(-airLight)) * (1.0 - transmittance);
    }
  }
  gl_FragColor = vec4(light, transmittance);
}
`

const compositeFragment = `
uniform sampler2D clouds;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  // A small tent filter over the half-resolution clouds (smooths the march's per-pixel jitter).
  vec4 c = 0.4 * texture2D(clouds, vUv)
    + 0.15 * (texture2D(clouds, vUv + vec2(texel.x, 0.0)) + texture2D(clouds, vUv - vec2(texel.x, 0.0))
            + texture2D(clouds, vUv + vec2(0.0, texel.y)) + texture2D(clouds, vUv - vec2(0.0, texel.y)));
  float opacity = 1.0 - c.a;
  // Premultiplied, linear: unpremultiply to encode for the (sRGB) canvas, then premultiply again.
  vec3 color = opacity > 1e-4 ? c.rgb / opacity : vec3(0.0);
  gl_FragColor = vec4(pow(max(color, vec3(0.0)), vec3(1.0 / 2.2)) * opacity, c.a);
}
`

const _offset = new THREE.Vector3()
const _cameraPlanet = new THREE.Vector3()
const _m4 = new THREE.Matrix4()
const _far = new THREE.Color(1e9, 0, 0)

export class Clouds {
  // planet: Planet (its atmosphere uniforms are updated each frame); planetCoordSys: the planet's frame.
  constructor(planet, planetCoordSys) {
    this.planet = planet
    this.planetCoordSys = planetCoordSys
    this.weatherMap = new WeatherMap()
    this.enabled = true
    const noise = cloudNoiseTextures()
    const targetOptions = { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    this.distanceTarget = new THREE.WebGLRenderTarget(1, 1, { ...targetOptions, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    this.cloudTarget = new THREE.WebGLRenderTarget(1, 1, { ...targetOptions, type: THREE.HalfFloatType, depthBuffer: false })
    this.uniforms = {
      ...SunAndSkyLight.uniforms,
      distanceMap: { value: this.distanceTarget.texture },
      weatherA: { value: this.weatherMap.textures[0] },
      weatherB: { value: this.weatherMap.textures[1] },
      shapeNoise: { value: noise.shape },
      detailNoise: { value: noise.detail },
      inverseProjection: { value: new THREE.Matrix4() },
      cameraWorld: { value: new THREE.Matrix4() },
      worldToPlanet: { value: new THREE.Matrix3() },
      shapeOffset: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      macroOffset: { value: new THREE.Vector3() },
      detailOffset: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      drift: { value: new THREE.Vector3() },
      exposure: { value: new THREE.Vector2(1, Math.PI) },
      pixelAngle: { value: 0.001 },
    }
    const quad = (material) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
      mesh.frustumCulled = false
      return new THREE.Scene().add(mesh)
    }
    this.marchScene = quad(new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: fullscreenVertex, fragmentShader: marchFragment(noise.shapeStats), depthTest: false, depthWrite: false }))
    this.compositeScene = quad(new THREE.ShaderMaterial({
      uniforms: { clouds: { value: this.cloudTarget.texture }, texel: { value: new THREE.Vector2() } },
      vertexShader: fullscreenVertex,
      fragmentShader: compositeFragment,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    }))
    this.quadCamera = new THREE.Camera()
  }

  /**
   * Weather for the date (day of year, UTC hours) and drift for the simulated time t (s). Called each
   * frame before render.
   */
  update(renderer, dayOfYear, utcHours, t) {
    if (!this.enabled) return
    this.weatherMap.update(renderer, dayOfYear, utcHours)
    this.time = t
  }

  // Draws the clouds over what `renderer` has drawn of `scene` from `camera`.
  render(renderer, scene, camera, sunIntensity, skyExposure) {
    if (!this.enabled) return
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const w = Math.max(1, Math.round(size.x * RESOLUTION)), h = Math.max(1, Math.round(size.y * RESOLUTION))
    if (this.distanceTarget.width !== w || this.distanceTarget.height !== h) {
      this.distanceTarget.setSize(w, h)
      this.cloudTarget.setSize(w, h)
      this.compositeScene.children[0].material.uniforms.texel.value.set(1 / w, 1 / h)
    }
    const u = this.uniforms
    // Planet axes, and the camera's planet position (float64) for the noise offsets.
    this.planetCoordSys.updateWorldMatrix(true, false)
    u.worldToPlanet.value.setFromMatrix4(_m4.copy(this.planetCoordSys.matrixWorld).invert())
    camera.getWorldPosition(_cameraPlanet)
    this.planetCoordSys.worldToLocal(_cameraPlanet)
    const t = this.time ?? 0
    const phase = t / DRIFT_PERIOD
    const ages = [((phase % 1) + 1) % 1, (((phase + 0.5) % 1) + 1) % 1]
    u.drift.value.set(ages[0] * DRIFT_PERIOD, ages[1] * DRIFT_PERIOD, 1 - Math.abs(2 * ages[0] - 1))
    // Each copy restarts from a different place in the tile (so a restart does not repeat it).
    ages.forEach((age, i) => {
      const cycle = Math.floor(phase + (i ? 0.5 : 0))
      const shift = cycle * 7919.37 + i * 3571.1
      for (const [target, tile] of [[u.shapeOffset.value[i], SHAPE_TILE], [u.detailOffset.value[i], DETAIL_TILE]]) {
        _offset.set(_cameraPlanet.x + shift, _cameraPlanet.y + shift * 0.61, _cameraPlanet.z + shift * 1.37)
        target.set(((_offset.x % tile) + tile) % tile, ((_offset.y % tile) + tile) % tile, ((_offset.z % tile) + tile) % tile)
      }
    })
    const mt = MACRO_TILE
    u.macroOffset.value.set(((_cameraPlanet.x % mt) + mt) % mt, ((_cameraPlanet.y % mt) + mt) % mt, ((_cameraPlanet.z % mt) + mt) % mt)
    u.inverseProjection.value.copy(camera.projectionMatrixInverse)
    u.cameraWorld.value.copy(camera.matrixWorld)
    u.exposure.value.set(skyExposure, sunIntensity)
    u.pixelAngle.value = 2 / (camera.projectionMatrix.elements[5] * h)

    const previousTarget = renderer.getRenderTarget()
    const previousClear = renderer.getClearColor(new THREE.Color()), previousAlpha = renderer.getClearAlpha()
    const atmosphere = this.planet.atmosphere, atmosphereVisible = atmosphere.visible
    // 1. Distance.
    atmosphere.visible = false
    const override = scene.overrideMaterial, background = scene.background, fog = scene.fog
    scene.overrideMaterial = distanceMaterial
    scene.background = null
    scene.fog = null
    renderer.setRenderTarget(this.distanceTarget)
    renderer.setClearColor(_far, 1) // (a float target: nothing drawn is "far")
    renderer.clear()
    renderer.render(scene, camera)
    scene.overrideMaterial = override
    scene.background = background
    scene.fog = fog
    atmosphere.visible = atmosphereVisible
    // 2. Clouds.
    renderer.setRenderTarget(this.cloudTarget)
    renderer.render(this.marchScene, this.quadCamera)
    // 3. Composite.
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClear, previousAlpha)
    renderer.render(this.compositeScene, this.quadCamera)
  }

  dispose() {
    this.weatherMap.dispose()
    this.distanceTarget.dispose()
    this.cloudTarget.dispose()
  }
}
