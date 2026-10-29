// Renders N segments around the ring (optionally stacked for several main rings) as one
// THREE.InstancedMesh of one segment's geometry (built around ring position 0). Only the segments
// within `cameraRange` of the camera are written, every frame, so millions of "virtual" segments cost
// nothing. The ring is not a circle (see mainRingCurve), so each instance maps the template onto its
// own stretch of the curve: centred on it, its chord turned onto the real chord and stretched to its
// length, so that neighbouring segments meet end to end.
//
// Precision: the InstancedMesh is positioned (in float64, on the CPU) at a point on the ring next to
// the camera, and every instance matrix is stored relative to that origin. Instance translations near
// the camera are therefore small and do not suffer from float32 quantisation (the ring is ~6.4e6 m
// from the planet centre, where float32 resolution is ~0.5 m).
import * as THREE from 'three'

const _origin = new THREE.Vector3()
const _start = new THREE.Vector3()
const _end = new THREE.Vector3()
const _mid = new THREE.Vector3()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _basis = new THREE.Matrix4()
const _stretch = new THREE.Matrix4()
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

  // The point at ring position p (wrapped), offset as the segments are (makeOffsetCurve), into target.
  offsetPoint(curve, p, target) {
    const q = ((p % 1) + 1) % 1
    curve.getPoint(q, target)
    const angle = 2 * Math.PI * q
    target.x += this.dr * Math.cos(angle)
    target.y += this.dy
    target.z += this.dr * Math.sin(angle)
    return target
  }

  // The frame of the segment from `start` to `end` (chord along z, the ring axis as up) into `basis`;
  // returns the chord's length.
  static chordFrame(start, end, basis) {
    _z.subVectors(end, start)
    const length = _z.length()
    _z.divideScalar(length)
    _y.set(0, 1, 0).addScaledVector(_z, -_z.y).normalize()
    _x.crossVectors(_y, _z)
    basis.makeBasis(_x, _y, _z)
    return length
  }

  // Turns the template segment's cross-section by rotZ: each vertex about the segment's centre line (the
  // offset curve the geometry was built along, relative to its centre), at the point and tangent level
  // with the vertex along the segment. (Rotating the whole curved segment about the tangent at its
  // centre would swing its ends off the ring.)
  twist(curve, half) {
    const geometry = this.mesh.geometry
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const center = this.offsetPoint(curve, 0, new THREE.Vector3())
    const start = this.offsetPoint(curve, -half, new THREE.Vector3())
    const chord = this.offsetPoint(curve, half, new THREE.Vector3()).sub(start)
    const length = chord.length()
    chord.divideScalar(length)
    start.sub(center)
    const v = new THREE.Vector3(), axis = new THREE.Vector3(), point = new THREE.Vector3(), next = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i)
      const along = Math.min(1, Math.max(0, v.clone().sub(start).dot(chord) / length))
      const p = (along - 0.5) * 2 * half
      this.offsetPoint(curve, p, point).sub(center)
      this.offsetPoint(curve, p + 1e-3 * half, next).sub(center)
      axis.subVectors(next, point).normalize()
      rotation.setFromAxisAngle(axis, this.rotZ)
      v.sub(point).applyQuaternion(rotation).add(point)
      position.setXYZ(i, v.x, v.y, v.z)
      if (normal) {
        v.fromBufferAttribute(normal, i).applyQuaternion(rotation)
        normal.setXYZ(i, v.x, v.y, v.z)
      }
    }
    position.needsUpdate = true
    if (normal) normal.needsUpdate = true
    geometry.computeBoundingSphere()
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
    const half = 0.5 / n
    const mro = (this.numRings - 1) / 2
    // The template: the segment at ring position 0 (its geometry is relative to its centre), twisted
    // (rotZ), and the local rotation applied to it before it is placed.
    if (!this.template) {
      if (this.rotZ) this.twist(curve, half)
      _quat.identity()
      if (this.localRotation) _quat.copy(this.localRotation)
      const inverseBasis = new THREE.Matrix4()
      const length = RingInstancedLayer.chordFrame(this.offsetPoint(curve, -half, _start), this.offsetPoint(curve, half, _end), inverseBasis)
      inverseBasis.transpose()
      this.template = { length, inner: new THREE.Matrix4().makeRotationFromQuaternion(_quat).premultiply(inverseBasis) }
    }
    const [first, last] = this.visibleRange(nearestTrackPosition)
    let k = 0
    this.offsetPoint(curve, first / n - half, _end)
    for (let i = first; i <= last; i++) {
      const p = i / n
      _start.copy(_end)
      this.offsetPoint(curve, p + half, _end)
      this.offsetPoint(curve, p, _mid)
      const length = RingInstancedLayer.chordFrame(_start, _end, _basis)
      _stretch.makeScale(1, 1, length / this.template.length)
      _basis.multiply(_stretch).multiply(this.template.inner)
      for (let j = 0; j < this.numRings; j++) {
        _matrix.copy(_basis).setPosition(_mid.x - _origin.x, _mid.y + (j - mro) * this.ringSpacing - _origin.y, _mid.z - _origin.z)
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
