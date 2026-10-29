import * as THREE from 'three'
import vertexShader from '../shaders/structureLine.vert.glsl?raw'
import fragmentShader from '../shaders/structureLine.frag.glsl?raw'
import { SeaDarkening } from '../planet/seaDarkening.js'

// Thin structural lines (tethers, elevator cables, mooring cables) drawn at their real diameters.
//
// Each line is a 1 px wide line, drawn as a cable of its colour at a faint brightness (BRIGHTNESS)
// covering part of its pixel, over what is behind it. So it lightens a dark background (the ground
// from above, space, the night sky) and darkens a bright one (the day sky), and where lines overlap
// they hide each other, as real cables do, instead of adding up.
//
// The one creative choice: real cables of a few centimetres would be invisible beyond a few hundred
// metres, so the coverage is a glow: MAX_COVERAGE for a structure's thickest member (its material's
// referenceDiameter), less for thinner ones, as the square root of the diameter (so where a tether
// forks into strands of the same total cross-section, the strands are each fainter, as real ones would
// be, but the finest strands near the ring still show), held out to structureGlowDistance and fading
// as 1 / distance beyond it, as a sub-pixel line does. The
// many sub-pixel strands of the tethers sum to a visible structure from space. The coverage also
// fades with the haze of the air between the camera and the line (the same density model as the sky).
//
// The uniforms are shared by every line material (one update per frame).
const BRIGHTNESS = 0.25 // linear, times the colour
const MAX_COVERAGE = 0.5

const uniforms = {
  structureBrightness: { value: BRIGHTNESS },
  structureMaxCoverage: { value: MAX_COVERAGE },
  structureGlowDistance: { value: 1e7 },
  hazeActive: { value: 0 },
  // Replaced by the planet's atmosphere uniforms (shared objects) in setHaze.
  atmoCamera: { value: new THREE.Vector4() },
  atmoPole: { value: new THREE.Vector4() },
  atmoParams: { value: new THREE.Vector4() },
}

export const StructureLines = {
  uniforms,

  // distance (m): how far away the lines keep their full coverage.
  setGlowDistance(distance) {
    uniforms.structureGlowDistance.value = distance
  },

  // Haze from the planet's atmosphere (Planet.atmosphereUniforms, updated every frame there).
  setHaze(atmosphereUniforms) {
    uniforms.atmoCamera = atmosphereUniforms.atmoCamera
    uniforms.atmoPole = atmosphereUniforms.atmoPole
    uniforms.atmoParams = atmosphereUniforms.atmoParams
  },

  // Once per frame: whether the air hazes the lines.
  update(hazeActive) {
    uniforms.hazeActive.value = hazeActive ? 1 : 0
  },

  // A material for lines whose geometry has `diameter` (m) and `strands` attributes.
  // referenceDiameter (m): the structure's thickest member, which gets the full coverage (see above;
  // setReferenceDiameter). fog: also fade in the sea (mooring cables).
  createMaterial(color, { referenceDiameter = 1, fog = false } = {}) {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        color: { value: new THREE.Color(color) },
        referenceDiameter: { value: referenceDiameter },
        ...(fog ? { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...SeaDarkening.uniforms() } : {}),
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      // Premultiplied: the line's colour times its coverage, over what is behind it.
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      fog,
    })
  },

  setReferenceDiameter(material, diameter) {
    material.uniforms.referenceDiameter.value = diameter
  },

  // Constant per-vertex attributes for `count` vertices of one diameter.
  constantAttributes(geometry, count, diameter) {
    geometry.setAttribute('diameter', new THREE.BufferAttribute(new Float32Array(count).fill(diameter), 1))
    geometry.setAttribute('strands', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1))
  },
}
