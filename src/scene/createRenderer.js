import * as THREE from 'three'

// Creates the WebGL renderer used for both interactive viewing and recording.
//
// A logarithmic depth buffer is used because the scene spans from metre-scale vehicles a few metres
// from the camera to a planet thousands of kilometres away; a standard depth buffer cannot resolve
// both. Custom ShaderMaterials must include the logdepthbuf_* shader chunks (see src/shaders/).
export function createRenderer(canvas, { alpha = false, enableVR = false } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha,
    logarithmicDepthBuffer: true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.autoClear = false
  if (enableVR) renderer.xr.enabled = true
  return renderer
}
