// Fades small objects in by their on-screen size instead of letting them pop into view at a level-of-
// detail threshold. An object smaller than a pixel covers only part of it, so its opacity is
// (pixels / fullPixels)^2 (its share of the pixel's area) until it reaches fullPixels across. Opaque
// materials use alpha hashing (dithered, no sorting needed); transparent ones multiply their alpha.
//
//   const material = withSubPixelFade(baseMaterial.clone(), { size: fanDiameter })
//   SubPixelFade.update(camera, viewportHeight)   // once per frame (App.render)
//
// Works for InstancedMesh (each instance fades by its own distance) and ordinary meshes (by the
// object's origin). Pair it with a level of detail whose last level stops drawing at minimumPixels(),
// where the object is all but invisible.
import { PixelLOD } from './PixelLOD.js'

export const SubPixelFade = {
  // Shared by every faded material.
  uniforms: { subPixelFadePixelsPerRadian: { value: 1300 } },

  update(camera, viewportHeight) {
    SubPixelFade.uniforms.subPixelFadePixelsPerRadian.value = camera.projectionMatrix.elements[5] * viewportHeight / 2 / PixelLOD.lodBias
  },

  // On-screen size (px) at which a faded object has the given opacity: below it, it can stop drawing.
  minimumPixels(fullPixels = 1.5, opacity = 0.04) {
    return fullPixels * Math.sqrt(opacity)
  },
}

export function withSubPixelFade(material, { size, fullPixels = 1.5 }) {
  if (!material.transparent) material.alphaHash = true
  material.onBeforeCompile = (shader) => {
    shader.uniforms.subPixelFadePixelsPerRadian = SubPixelFade.uniforms.subPixelFadePixelsPerRadian
    shader.uniforms.subPixelFadeSize = { value: size }
    shader.uniforms.subPixelFadeFullPixels = { value: fullPixels }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float subPixelFadePixelsPerRadian;
uniform float subPixelFadeSize;
uniform float subPixelFadeFullPixels;
varying float vSubPixelFade;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
#ifdef USE_INSTANCING
  vec4 subPixelFadeCentre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec4 subPixelFadeCentre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#endif
  float subPixelFadeRatio = subPixelFadeSize * subPixelFadePixelsPerRadian / max(length(subPixelFadeCentre.xyz), 1e-3) / subPixelFadeFullPixels;
  vSubPixelFade = clamp(subPixelFadeRatio * subPixelFadeRatio, 0.0, 1.0);`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vSubPixelFade;`)
      .replace('#include <alphatest_fragment>', `diffuseColor.a *= vSubPixelFade;
#include <alphatest_fragment>`)
  }
  material.customProgramCacheKey = () => `subPixelFade:${size}:${fullPixels}`
  return material
}
