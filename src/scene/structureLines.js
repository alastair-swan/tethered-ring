import * as THREE from 'three'
import vertexShader from '../shaders/structureLine.vert.glsl?raw'
import fragmentShader from '../shaders/structureLine.frag.glsl?raw'
import { SeaDarkening } from '../planet/seaDarkening.js'

// Thin structural lines (tethers, elevator cables, mooring cables) drawn at their real diameters.
//
// Each line is a 1 px wide line; a cable far thinner than a pixel covers only part of it, so its
// contrast is (diameter / pixel footprint) of a full pixel's. The one creative choice: a real
// centimetre-thick cable would be invisible beyond a few hundred metres, so the lines are given just
// enough contrast to be seen: no more than MAX_CONTRAST close up. Seen against the daylit sky from
// within the air, a line darkens what is behind it; otherwise (against the ground, space or the night
// sky) it adds light, so the thousands of sub-pixel strands of the tethers sum to a visible structure.
// structureGlowDistance is how far away a 1 cm line still has the full contrast at the reference
// view; beyond that a line fades with its shrinking coverage. The contrast also fades with the haze
// of the air between the camera and the line (the same density model as the sky).
//
// The uniforms are shared by every line material (one update per frame).
const REFERENCE_PIXELS_PER_RADIAN = 1080 / 2 / Math.tan(22.5 * Math.PI / 180)
// Linear (about 0.22 of the sRGB output range) up to CONTRAST_DISTANCE away, rising in proportion
// to distance beyond it, so the whole structure still shows from space at planet scale.
const MAX_CONTRAST = 0.04
const CONTRAST_DISTANCE = 200000 // m

const uniforms = {
  structurePixelsPerRadian: { value: REFERENCE_PIXELS_PER_RADIAN },
  structureGlow: { value: 1 },
  structureMaxContrast: { value: new THREE.Vector2(MAX_CONTRAST, CONTRAST_DISTANCE) },
  hazeActive: { value: 0 },
  // Replaced by the planet's atmosphere uniforms (shared objects) in setHaze.
  atmoCamera: { value: new THREE.Vector4() },
  atmoPole: { value: new THREE.Vector4() },
  atmoParams: { value: new THREE.Vector4() },
  atmoSun: { value: new THREE.Vector3(0, 1, 0) },
}

export const StructureLines = {
  uniforms,

  // distance (m): how far away a 1 cm line still has the full contrast at the reference view.
  setGlowDistance(distance) {
    uniforms.structureGlow.value = distance / (0.01 * REFERENCE_PIXELS_PER_RADIAN)
  },

  // Haze from the planet's atmosphere (Planet.atmosphereUniforms, updated every frame there).
  setHaze(atmosphereUniforms) {
    uniforms.atmoCamera = atmosphereUniforms.atmoCamera
    uniforms.atmoPole = atmosphereUniforms.atmoPole
    uniforms.atmoParams = atmosphereUniforms.atmoParams
    uniforms.atmoSun = atmosphereUniforms.atmoSun
  },

  // Once per frame: the camera's pixels per radian, and whether the air hazes the lines.
  update(camera, viewportHeight, hazeActive) {
    uniforms.structurePixelsPerRadian.value = camera.projectionMatrix.elements[5] * viewportHeight / 2
    uniforms.hazeActive.value = hazeActive ? 1 : 0
  },

  // A material for lines whose geometry has `diameter` (m) and `strands` attributes. fog: also fade
  // in the sea (mooring cables).
  createMaterial(color, { fog = false } = {}) {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        color: { value: new THREE.Color(color) },
        ...(fog ? { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...SeaDarkening.uniforms() } : {}),
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      // Premultiplied: rgb is the light added, alpha how much of what is behind is darkened.
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      fog,
    })
  },

  // Constant per-vertex attributes for `count` vertices of one diameter.
  constantAttributes(geometry, count, diameter) {
    geometry.setAttribute('diameter', new THREE.BufferAttribute(new Float32Array(count).fill(diameter), 1))
    geometry.setAttribute('strands', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1))
  },
}
