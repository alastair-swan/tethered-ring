// Renders N identical, uniformly spaced segments around the ring (optionally stacked for several
// main rings) as one THREE.InstancedMesh. Only the segments within `cameraRange` of the camera are
// written, every frame, so millions of "virtual" segments cost nothing.
//
// Precision: the InstancedMesh is positioned (in float64, on the CPU) at a point on the ring next to
// the camera, and every instance matrix is stored relative to that origin. Instance translations near
// the camera are therefore small and do not suffer from float32 quantisation (the ring is ~6.4e6 m
// from the planet centre, where float32 resolution is ~0.5 m).
import * as THREE from 'three'

const _origin = new THREE.Vector3()
const _point = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _scale = new THREE.Vector3(1, 1, 1)
const _matrix = new THREE.Matrix4()

export class RingInstancedLayer {
  // options: {name, geometry, material, numSegments, numRings=1, ringSpacing=0, dr, dy, rotZ,
  //           cameraRange, maxCameraRange (capacity, for layers whose range is changed per frame with
  //           setCameraRange), localRotation (Quaternion applied after the ring orientation), renderOrder}
  constructor(options) {
    this.name = options.name
    this.numSegments = Math.max(0, Math.floor(options.numSegments))
    this.numRings = Math.max(1, Math.floor(options.numRings ?? 1))
    this.ringSpacing = options.ringSpacing ?? 0
    this.dr = options.dr
    this.dy = options.dy
    this.rotZ = options.rotZ ?? 0
    this.cameraRange = options.cameraRange
    this.localRotation = options.localRotation ?? null
    this.ringCircumference = options.ringCircumference
    this.mesh = null
    this.parent = null
    if (this.numSegments === 0) {
      options.geometry.dispose()
      return
    }
    const halfWidth = (options.maxCameraRange ?? this.cameraRange) / this.ringCircumference
    const perRing = (halfWidth >= 0.5) ? this.numSegments : Math.min(this.numSegments, Math.floor(2 * halfWidth * this.numSegments) + 2)
    this.capacity = perRing * this.numRings
    this.mesh = new THREE.InstancedMesh(options.geometry, options.material, this.capacity)
    this.mesh.name = this.name
    this.mesh.count = 0
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    if (options.renderOrder !== undefined) this.mesh.renderOrder = options.renderOrder
  }

  // Changes how far from the camera segments are drawn (limited by the capacity chosen at construction).
  setCameraRange(range) {
    this.cameraRange = range
  }

  setParent(parent) {
    if (!this.mesh || this.parent === parent) return
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh)
    if (parent) parent.add(this.mesh)
    this.parent = parent
  }

  // Index range [first, last] (may run past numSegments; take modulo) of segments within range.
  visibleRange(nearestTrackPosition) {
    const n = this.numSegments
    const halfWidth = this.cameraRange / this.ringCircumference
    if (halfWidth >= 0.5) return [0, n - 1]
    const first = Math.ceil((nearestTrackPosition - halfWidth) * n)
    const last = Math.min(first + Math.floor(this.capacity / this.numRings) - 1, Math.floor((nearestTrackPosition + halfWidth) * n))
    return [first, last]
  }

  // Writes the instances near the camera. Pure function of the arguments (no accumulated state).
  update(curve, nearestTrackPosition, distanceFromCameraToRing) {
    const mesh = this.mesh
    if (!mesh) return
    if (!(distanceFromCameraToRing <= this.cameraRange)) {
      mesh.count = 0
      mesh.visible = false
      return
    }
    mesh.visible = true
    curve.getPoint(nearestTrackPosition, _origin)
    mesh.position.copy(_origin)
    const n = this.numSegments
    const mro = (this.numRings - 1) / 2
    const [first, last] = this.visibleRange(nearestTrackPosition)
    let k = 0
    for (let i = first; i <= last; i++) {
      const index = ((i % n) + n) % n
      const p = index / n
      const angle = 2 * Math.PI * p
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      curve.getPoint(p, _point)
      _euler.set(0, -angle, this.rotZ)
      _quat.setFromEuler(_euler)
      if (this.localRotation) _quat.multiply(this.localRotation)
      for (let j = 0; j < this.numRings; j++) {
        _pos.set(
          _point.x + this.dr * c - _origin.x,
          _point.y + this.dy + (j - mro) * this.ringSpacing - _origin.y,
          _point.z + this.dr * s - _origin.z)
        _matrix.compose(_pos, _quat, _scale)
        mesh.setMatrixAt(k++, _matrix)
      }
    }
    mesh.count = k
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }

  dispose() {
    if (!this.mesh) return
    this.setParent(null)
    this.mesh.geometry.dispose()
    this.mesh.dispose()
    // Materials (and their textures) may be shared/cached by the layer factories, so they are not disposed here.
    this.mesh = null
  }
}
