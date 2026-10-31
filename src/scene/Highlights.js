import * as THREE from 'three'

// Highlights: chosen classes of structure (the ring, its tethers, the elevators, the mass drivers, their
// mooring cables, the launch vehicles) drawn over the finished frame in a colour of their own, whatever
// the lighting (night, shadow, the clouds' shade) and whatever is in front of them (terrain, sea, haze,
// clouds, other structures).
//
// Objects are tagged where they are built: Highlights.tag(object, 'ring'). A tag applies to the
// object's whole subtree, unless a descendant has a tag of its own (a mass driver's mooring cables are
// inside its tube segments). Pooled models carry the tag in userData, which clones copy.
//
// Each frame with any class on, render() walks the visible scene graph, puts the meshes and lines of
// the highlighted classes on a layer of their own, and draws just that layer (scene.overrideMaterial,
// camera.layers) into an offscreen target with its own depth buffer, so the highlighted objects hide
// only each other. Each pixel there holds its class's colour, shaded by how squarely the surface faces
// the camera (so shapes stay legible), and the log of its distance. A full-screen pass then lays that
// over the frame: surfaces as a translucent fill, their outlines, creases and depth steps at full
// opacity (a 1 px border inside and out, so even a one-pixel object shows as a 3 px blob), lines
// (tethers, cables, the tube's distant line) at full opacity.
//
// Whatever is drawn is highlighted: pooled models, instanced meshes and the current level of each
// level of detail. Objects too far away to have a model (or culled by their level of detail) are not.
// With every class off, render() does nothing but return.
const LAYER = 31

export const HIGHLIGHT_CLASSES = [
  { key: 'ring', param: 'highlightRing', color: 0x00e5ff },
  { key: 'tethers', param: 'highlightRingTethers', color: 0xffd400 },
  { key: 'elevators', param: 'highlightElevators', color: 0x40ff60 },
  { key: 'massDriver', param: 'highlightMassDrivers', color: 0xff8000 },
  { key: 'massDriverTethers', param: 'highlightMassDriverTethers', color: 0xff40ff },
  { key: 'launchVehicle', param: 'highlightLaunchVehicles', color: 0xff2040 },
]

const FILL_OPACITY = 0.35

const highlightMaterial = new THREE.ShaderMaterial({
  uniforms: {
    highlightColor: { value: new THREE.Color() },
    highlightIsLine: { value: 0 },
  },
  vertexShader: `
#include <common>
#include <batching_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec3 vViewPosition;
void main() {
  #include <batching_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  vViewPosition = mvPosition.xyz;
}
`,
  fragmentShader: `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 highlightColor;
uniform float highlightIsLine;
varying vec3 vViewPosition;
void main() {
  #include <logdepthbuf_fragment>
  if (highlightIsLine > 0.5) {
    gl_FragColor = vec4(highlightColor, -1.0);
    return;
  }
  // Shaded by how squarely the (flat) surface faces the camera. Alpha: log2 of the distance (>= 1).
  vec3 normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  float distance = length(vViewPosition);
  float facing = abs(dot(normal, vViewPosition / max(distance, 1e-6)));
  gl_FragColor = vec4(highlightColor * (0.45 + 0.55 * facing), 1.0 + log2(max(distance, 1.0)));
}
`,
  side: THREE.DoubleSide,
})

const compositeMaterial = new THREE.ShaderMaterial({
  uniforms: {
    highlights: { value: null },
    fillOpacity: { value: FILL_OPACITY },
  },
  vertexShader: `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`,
  fragmentShader: `
uniform sampler2D highlights;
uniform float fillOpacity;
vec4 at(ivec2 p) {
  ivec2 size = textureSize(highlights, 0);
  if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) return vec4(0.0);
  return texelFetch(highlights, p, 0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = at(p);
  if (c.a < 0.0) {                      // a line
    gl_FragColor = vec4(c.rgb, 1.0);
    return;
  }
  vec4 west = at(p + ivec2(-1, 0)), east = at(p + ivec2(1, 0)), south = at(p + ivec2(0, -1)), north = at(p + ivec2(0, 1));
  if (c.a == 0.0) {
    // Outside every surface: the outline of the nearest surface beside it, if any.
    vec4 best = vec4(0.0, 0.0, 0.0, 1e9);
    if (west.a > 0.0 && west.a < best.a) best = west;
    if (east.a > 0.0 && east.a < best.a) best = east;
    if (south.a > 0.0 && south.a < best.a) best = south;
    if (north.a > 0.0 && north.a < best.a) best = north;
    if (best.a == 1e9) discard;
    gl_FragColor = vec4(best.rgb, 1.0);
    return;
  }
  // A surface: an edge at its outline (a neighbour that is not surface), where the depth bends or
  // steps (second difference of log distance), and where the shading jumps (creases, other classes).
  bool edge = west.a <= 0.0 || east.a <= 0.0 || south.a <= 0.0 || north.a <= 0.0;
  edge = edge || abs(west.a + east.a - 2.0 * c.a) > 0.08 || abs(south.a + north.a - 2.0 * c.a) > 0.08;
  vec3 jump = max(max(abs(west.rgb - c.rgb), abs(east.rgb - c.rgb)), max(abs(south.rgb - c.rgb), abs(north.rgb - c.rgb)));
  edge = edge || max(jump.r, max(jump.g, jump.b)) > 0.12;
  gl_FragColor = edge ? vec4(c.rgb, 1.0) : vec4(c.rgb * fillOpacity, fillOpacity);
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
    this.colors = HIGHLIGHT_CLASSES.map(c => new THREE.Color().setHex(c.color, THREE.LinearSRGBColorSpace))
    this.target = null
    this.quadScene = null
    this.quadCamera = new THREE.Camera()
    highlightMaterial.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const u = highlightMaterial.uniforms
      u.highlightColor.value.copy(this.colors[this.classOf.get(object) ?? 0])
      u.highlightIsLine.value = object.isLine ? 1 : 0
      highlightMaterial.uniformsNeedUpdate = true
    }
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
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
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
