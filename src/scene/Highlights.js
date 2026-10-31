import * as THREE from 'three'

// Highlights: chosen classes of structure (the ring, its tethers, the elevators, the mass drivers, their
// mooring cables, the launch vehicles) outlined over the finished frame by a 1 px white border, whatever
// the lighting (night, shadow, the clouds' shade) and whatever is in front of them (terrain, sea, haze,
// clouds, other structures).
//
// Objects are tagged where they are built: Highlights.tag(object, 'ring'). A tag applies to the
// object's whole subtree, unless a descendant has a tag of its own (a mass driver's mooring cables are
// inside its tube segments). Pooled models carry the tag in userData, which clones copy.
//
// Each frame with any class on, render() walks the visible scene graph, puts the meshes and lines of
// the highlighted classes on a layer of their own, and draws just that layer (scene.overrideMaterial,
// camera.layers) into an offscreen target as a mask of the pixels they cover. A full-screen pass then
// paints white each covered pixel that has an uncovered neighbour: a 1 px border just inside each
// silhouette, and the whole of anything only a pixel across (a distant object, a cable's line).
//
// Whatever is drawn is highlighted: pooled models, instanced meshes and the current level of each
// level of detail. Objects too far away to have a model (or culled by their level of detail) are not.
// With every class off, render() does nothing but return.
const LAYER = 31

export const HIGHLIGHT_CLASSES = [
  { key: 'ring', param: 'highlightRing' },
  { key: 'tethers', param: 'highlightRingTethers' },
  { key: 'elevators', param: 'highlightElevators' },
  { key: 'massDriver', param: 'highlightMassDrivers' },
  { key: 'massDriverTethers', param: 'highlightMassDriverTethers' },
  { key: 'launchVehicle', param: 'highlightLaunchVehicles' },
]

const highlightMaterial = new THREE.ShaderMaterial({
  vertexShader: `
#include <common>
#include <batching_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  #include <batching_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: `
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(1.0);
}
`,
  side: THREE.DoubleSide,
})

const compositeMaterial = new THREE.ShaderMaterial({
  uniforms: {
    highlights: { value: null },
  },
  vertexShader: `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`,
  fragmentShader: `
uniform sampler2D highlights;
float covered(ivec2 p) {
  ivec2 size = textureSize(highlights, 0);
  if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) return 0.0;
  return texelFetch(highlights, p, 0).a;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (covered(p) < 0.5) discard;
  float inside = covered(p + ivec2(-1, 0)) * covered(p + ivec2(1, 0)) * covered(p + ivec2(0, -1)) * covered(p + ivec2(0, 1));
  if (inside > 0.5) discard;
  gl_FragColor = vec4(1.0);
}
`,
  depthTest: false,
  depthWrite: false,
  transparent: true,
  // Premultiplied over the frame.
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
})

const _size = new THREE.Vector2()
const _clearColor = new THREE.Color()

export class Highlights {
  // Marks `object` (and its subtree) as belonging to a highlight class (a key of HIGHLIGHT_CLASSES).
  static tag(object, key) {
    if (object) object.userData.highlight = key
    return object
  }

  // A stand-in drawn only when its class is highlighted (never in the scene itself): a line along
  // `curve` (getPoint(t), t in [0, 1], in the frame of the object it is added to), for structures whose
  // models are only drawn near the camera (the ring from space, a mass driver from afar). Split into
  // chunks, each relative to its own origin, for float32 precision.
  static curveStandIn(curve, key, { closed = false, chunks = 64, pointsPerChunk = 32 } = {}) {
    const group = new THREE.Group()
    group.name = 'highlightStandIn'
    const material = new THREE.LineBasicMaterial()
    const point = new THREE.Vector3()
    for (let c = 0; c < chunks; c++) {
      const origin = curve.getPoint((c + 0.5) / chunks)
      const positions = []
      for (let i = 0; i <= pointsPerChunk; i++) {
        const t = (c + i / pointsPerChunk) / chunks
        point.copy(curve.getPoint(closed ? t % 1 : Math.min(t, 1))).sub(origin)
        positions.push(point.x, point.y, point.z)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      const line = new THREE.Line(geometry, material)
      line.position.copy(origin)
      line.layers.mask = 0 // only on the highlight layer, while highlighted
      group.add(line)
    }
    return Highlights.tag(group, key)
  }

  static disposeStandIn(group) {
    if (!group) return
    group.parent?.remove(group)
    group.children.forEach(line => line.geometry.dispose())
    group.children[0]?.material.dispose()
  }

  constructor() {
    this.enabled = new Map() // key -> class index, for the classes that are on
    this.objects = []         // what is on the highlight layer this frame
    this.classOf = new Map()  // object -> class index
    this.target = null
    this.quadScene = null
    this.quadCamera = new THREE.Camera()
  }

  // Turns the classes on and off from the parameters (highlightRing, ...).
  configure(params) {
    this.enabled.clear()
    HIGHLIGHT_CLASSES.forEach((c, index) => { if (params[c.param]?.value) this.enabled.set(c.key, index) })
    if (this.enabled.size === 0) this.release()
  }

  get active() {
    return this.enabled.size > 0
  }

  // Takes everything off the highlight layer and frees the offscreen target.
  release() {
    for (const object of this.objects) object.layers.disable(LAYER)
    this.objects.length = 0
    this.classOf.clear()
    this.target?.dispose()
    this.target = null
  }

  // Draws the highlighted objects over what has been rendered so far (to the current render target).
  render(renderer, scene, camera) {
    if (!this.active) return
    this.collect(scene)
    if (this.objects.length === 0) return

    renderer.getDrawingBufferSize(_size)
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(_size.x, _size.y, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      })
      compositeMaterial.uniforms.highlights.value = this.target.texture
    }
    else if (this.target.width !== _size.x || this.target.height !== _size.y) this.target.setSize(_size.x, _size.y)
    if (!this.quadScene) {
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMaterial)
      quad.frustumCulled = false
      this.quadScene = new THREE.Scene().add(quad)
    }

    const previousTarget = renderer.getRenderTarget()
    renderer.getClearColor(_clearColor)
    const previousAlpha = renderer.getClearAlpha()
    const previousMask = camera.layers.mask
    const override = scene.overrideMaterial, background = scene.background, fog = scene.fog
    scene.overrideMaterial = highlightMaterial
    scene.background = null
    scene.fog = null
    camera.layers.set(LAYER)
    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(scene, camera)
    camera.layers.mask = previousMask
    scene.overrideMaterial = override
    scene.background = background
    scene.fog = fog
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(_clearColor, previousAlpha)
    renderer.render(this.quadScene, this.quadCamera)
  }

  // Puts the visible meshes and lines of the classes that are on onto the highlight layer (and takes
  // last frame's off it).
  collect(scene) {
    for (const object of this.objects) object.layers.disable(LAYER)
    this.objects.length = 0
    this.classOf.clear()
    const visit = (object, key) => {
      if (!object.visible) return
      const own = object.userData.highlight
      if (own !== undefined) key = own
      if (key !== undefined && (object.isMesh || object.isLine)) {
        const index = this.enabled.get(key)
        if (index !== undefined) {
          object.layers.enable(LAYER)
          this.objects.push(object)
          this.classOf.set(object, index)
        }
      }
      const children = object.children
      for (let i = 0; i < children.length; i++) visit(children[i], key)
    }
    visit(scene, undefined)
  }
}
