import * as THREE from 'three'

// Creates the WebGL renderer used for both interactive viewing and recording.
//
// A logarithmic depth buffer is used because the scene spans from metre-scale vehicles a few metres
// from the camera to a planet thousands of kilometres away; a standard depth buffer cannot resolve
// both. Custom ShaderMaterials must include the logdepthbuf_* shader chunks (see src/shaders/).
//
// `antialias` asks for a multisampled canvas (MSAA, normally 4 samples). Everything in the scene is
// drawn straight to the canvas, so it all gets it; a pass that draws scene geometry into a render
// target of its own (the clouds' distance prepass, for example) does not, unless the target has
// `samples` set. MSAA cannot be switched on or off without a new WebGL context, so it is chosen at
// startup (?msaa=off in the URL turns it off).
export function createRenderer(canvas, { alpha = false, enableVR = false, antialias = true } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias,
    alpha,
    logarithmicDepthBuffer: true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.autoClear = false
  if (enableVR) renderer.xr.enabled = true
  return renderer
}
