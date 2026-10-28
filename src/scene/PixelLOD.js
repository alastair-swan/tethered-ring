import * as THREE from 'three'

const _cameraPosition = new THREE.Vector3()
const _objectPosition = new THREE.Vector3()

// Level of detail chosen by on-screen size (pixels) rather than by distance, so a narrow-FOV close-up
// gets full detail and the same object seen from far away does not. three.js calls update(camera)
// for every LOD in the scene while rendering, so no extra per-frame plumbing is needed.
//
//   const lod = new PixelLOD(objectSizeInMetres)
//   lod.addLevel(48, () => buildHighDetailMesh())   // shown when the object is >= 48 px
//   lod.addLevel(4, () => buildLowDetailMesh())
//   (below the smallest threshold nothing is drawn)
//
// Level contents are built lazily the first time they are needed. Expensive builds are rate
// limited per frame (PixelLOD.buildBudget, in milliseconds of build time per frame) so a camera move
// does not stall on dozens of high-detail rebuilds: until a level is built the next coarser built
// level is shown. A time budget (rather than a count) lets many cheap builds through when the camera
// races along a launcher, while a few slow ones still cannot stall a frame.
// Recording sets an unlimited budget so every frame is rendered at its intended detail.
export class PixelLOD extends THREE.LOD {
  // Drawing-buffer height in pixels; the App keeps this up to date.
  static viewportHeight = 1080
  // Multiplies every threshold (1 = as designed; >1 switches to coarser levels sooner). Set by the
  // graphics-quality setting; always 1 while recording.
  static lodBias = 1
  // Milliseconds per frame that expensive lazy level builds may take (Infinity while recording). A
  // build is started only while the frame's total is below the budget.
  static buildBudget = 6
  static _buildMsThisFrame = 0
  static _frame = -1

  // Call once per rendered frame (before rendering) to reset the build budget.
  static beginFrame(frameNumber) {
    PixelLOD._frame = frameNumber
    PixelLOD._buildMsThisFrame = 0
  }

  // size: characteristic size (m) whose projection is compared with the level thresholds.
  // extent: radius (m) of the region the LOD's contents span around its origin. Distance is measured
  // to the nearest point of that region, so a long chunk of objects is judged by its closest member.
  constructor(size, { extent = 0 } = {}) {
    super()
    this.type = 'PixelLOD'
    this.size = size
    this.extent = extent
    this.pixelLevels = [] // [{ minPixels, factory, object, cost }], sorted by minPixels descending
    this.currentPixelLevel = -1
    this.onScreenPixels = 0
  }

  // factory() returns an Object3D (or null for "draw nothing"). `cost` is 'expensive' for builds
  // that should count against the per-frame budget.
  addLevel(minPixels, factory, { cost = 'cheap' } = {}) {
    const level = { minPixels, factory: typeof factory === 'function' ? factory : () => factory, object: undefined, cost }
    if (typeof factory !== 'function') this._attach(level, factory)
    this.pixelLevels.push(level)
    this.pixelLevels.sort((a, b) => b.minPixels - a.minPixels)
    return this
  }

  _attach(level, object) {
    level.object = object ?? null
    if (level.object) {
      level.object.visible = false
      this.add(level.object)
    }
  }

  _build(level) {
    if (level.object !== undefined) return true
    if (level.cost !== 'expensive') {
      this._attach(level, level.factory())
      return true
    }
    if (PixelLOD._buildMsThisFrame >= PixelLOD.buildBudget) return false
    const start = performance.now()
    this._attach(level, level.factory())
    PixelLOD._buildMsThisFrame += performance.now() - start
    return true
  }

  // Projected size in pixels of `size` metres at this object's distance from the camera.
  pixelsFor(camera) {
    _cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    _objectPosition.setFromMatrixPosition(this.matrixWorld)
    const distance = Math.max(1e-3, _cameraPosition.distanceTo(_objectPosition) - this.extent)
    // projectionMatrix[5] = 1 / tan(fovY / 2); half the viewport spans that.
    const pixelsPerRadian = camera.projectionMatrix.elements[5] * PixelLOD.viewportHeight / 2
    return this.size / distance * pixelsPerRadian / PixelLOD.lodBias
  }

  update(camera) {
    if (!this.pixelLevels.length) return
    const pixels = this.pixelsFor(camera)
    this.onScreenPixels = pixels
    let wanted = this.pixelLevels.findIndex(level => pixels >= level.minPixels)
    if (wanted === -1) wanted = this.pixelLevels.length // smaller than every threshold: nothing
    // Use the wanted level if it can be built now, otherwise the nearest coarser built level, and
    // failing that the nearest finer built level (better too detailed than a hole).
    let shown = -1
    for (let i = wanted; i < this.pixelLevels.length; i++) {
      if (this._build(this.pixelLevels[i])) { shown = i; break }
    }
    if (shown === -1 && wanted < this.pixelLevels.length) {
      for (let i = wanted - 1; i >= 0; i--) if (this.pixelLevels[i].object !== undefined) { shown = i; break }
    }
    this.currentPixelLevel = shown
    this.pixelLevels.forEach((level, i) => { if (level.object) level.object.visible = (i === shown) })
  }

  // Drops built levels (e.g. when the parameters they were built from change).
  reset({ dispose = true } = {}) {
    for (const level of this.pixelLevels) {
      if (level.object?.instancedProxyPool) {
        level.object.instancedProxyPool.releaseProxy(level.object)
      }
      else if (level.object) {
        this.remove(level.object)
        if (dispose) level.object.traverse(o => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose() })
      }
      level.object = undefined
    }
  }

  // THREE.LOD only raycasts its distance-based levels; raycast whichever level is shown.
  raycast(raycaster, intersects) {
    const level = this.pixelLevels[this.currentPixelLevel]
    if (level?.object) level.object.raycast(raycaster, intersects)
  }

  getCurrentLevel() {
    return this.currentPixelLevel
  }
}
