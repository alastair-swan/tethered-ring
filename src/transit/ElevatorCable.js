import * as THREE from 'three'
import { offset_r, offset_y } from '../ring/ringGeometry.js'
import { ringPoint, forEachInWindow } from './VirtualRingObject.js'

const _origin = new THREE.Vector3()
const _a = new THREE.Vector3()

// All elevator cables near the camera, drawn as one LineSegments object (one draw call).
// Vertex positions are relative to a point on the ring next to the camera (precision), and the
// buffer is preallocated, so nothing is allocated per frame.
export class ElevatorCableLayer {
  constructor(dParamWithUnits, crv, terminusPositions, cameraRange) {
    this.positions = dParamWithUnits['showElevatorCables'].value ? terminusPositions : new Float64Array(0)
    this.cameraRange = cameraRange
    this.ringCircumference = 2 * Math.PI * crv.mainRingRadius
    const outward = dParamWithUnits['transitTubeOutwardOffset'].value - dParamWithUnits['transitTubeTubeRadius'].value + dParamWithUnits['elevatorCableOutwardOffset'].value
    const carUp = dParamWithUnits['transitTubeUpwardOffset'].value + dParamWithUnits['ringTerminusUpwardOffset'].value + dParamWithUnits['elevatorCarUpwardOffset'].value
    // The cable runs from below the ground terminus up past the ring (additionalUpperElevatorCable).
    const lowerUp = carUp - crv.currentMainRingAltitude
    const upperUp = carUp + dParamWithUnits['additionalUpperElevatorCable'].value
    const lat = crv.currentEquivalentLatitude
    this.lower = [offset_r(outward, lowerUp, lat), offset_y(outward, lowerUp, lat)]
    this.upper = [offset_r(outward, upperUp, lat), offset_y(outward, upperUp, lat)]
    this.forward = dParamWithUnits['elevatorCableForwardOffset'].value
    this.parent = null
    this.mesh = null
    if (this.positions.length === 0) return

    const halfWidth = cameraRange / this.ringCircumference
    const maxCables = Math.min(this.positions.length, Math.ceil(2 * halfWidth * this.positions.length) + 2)
    this.buffer = new Float32Array(maxCables * 6)
    const geometry = new THREE.BufferGeometry()
    this.attribute = new THREE.BufferAttribute(this.buffer, 3)
    this.attribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', this.attribute)
    geometry.setDrawRange(0, 0)
    this.material = new THREE.LineBasicMaterial({color: 0x4897f8, transparent: true, opacity: dParamWithUnits['elevatorCableOpacity'].value})
    this.mesh = new THREE.LineSegments(geometry, this.material)
    this.mesh.name = 'elevatorCables'
    this.mesh.renderOrder = 1
    this.mesh.frustumCulled = false
    this.maxCables = maxCables
  }

  setParent(parent) {
    if (!this.mesh || this.parent === parent) return
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh)
    if (parent) parent.add(this.mesh)
    this.parent = parent
  }

  update(curve, nearestTrackPosition, distanceFromCameraToRing) {
    if (!this.mesh) return
    if (!(distanceFromCameraToRing <= this.cameraRange)) {
      this.mesh.visible = false
      return
    }
    this.mesh.visible = true
    curve.getPoint(nearestTrackPosition, _origin)
    this.mesh.position.copy(_origin)
    const buf = this.buffer
    let k = 0
    forEachInWindow(this.positions, nearestTrackPosition, this.cameraRange / this.ringCircumference, (i) => {
      if (k >= this.maxCables) return
      const p = this.positions[i]
      ringPoint(curve, p, this.lower[0], this.lower[1], this.forward, _a).sub(_origin)
      buf[k*6] = _a.x; buf[k*6+1] = _a.y; buf[k*6+2] = _a.z
      ringPoint(curve, p, this.upper[0], this.upper[1], this.forward, _a).sub(_origin)
      buf[k*6+3] = _a.x; buf[k*6+4] = _a.y; buf[k*6+5] = _a.z
      k++
    })
    this.mesh.geometry.setDrawRange(0, k * 2)
    this.attribute.needsUpdate = true
  }

  dispose() {
    if (!this.mesh) return
    this.setParent(null)
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh = null
  }
}
