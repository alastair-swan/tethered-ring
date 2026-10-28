import * as THREE from 'three'
import { offset_r, offset_y } from '../ring/ringGeometry.js'
import { ringPoint, forEachInWindow } from './VirtualRingObject.js'
import { StructureLines } from '../scene/structureLines.js'
import { ecefToGeodetic } from '../physics/geodesy.js'

// Elevator cables only reach the ground where there is land within LAND_RADIUS of where they meet the
// surface. The terrain streams in after start-up, so each frame LAND_CHECKS_PER_FRAME cables re-check
// (round robin); a cable is hidden until its ground has loaded.
const LAND_RADIUS = 5000 // m
const LAND_CHECKS_PER_FRAME = 24
const LAND_UNKNOWN = 0, LAND_YES = 1, LAND_NO = 2
const _ground = new THREE.Vector3()

const GRAVITY = 9.81 // m/s^2

// Diameter (m) of an elevator cable: a constant-section carbon-fibre cable (the tethers' fibre, at
// their working stress) of the given length holding up a loaded car of carMass. The top carries the
// car and the cable's own weight: A sigma = M g + rho A L g, so A = M g / (sigma - rho L g).
export function elevatorCableDiameter(dParamWithUnits, length, carMass) {
  const workingStress = dParamWithUnits['tetherFiberTensileStrength'].value * 1e6 / dParamWithUnits['tetherEngineeringFactor'].value
  const selfWeightStress = dParamWithUnits['tetherFiberDensity'].value * length * GRAVITY
  if (!(workingStress > selfWeightStress)) {
    console.warn('Elevator cables cannot support their own weight at this length with this fibre.')
    return 1
  }
  return 2 * Math.sqrt(carMass * GRAVITY / (workingStress - selfWeightStress) / Math.PI)
}

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

    // The range follows the horizon (setCameraRange), which can include the whole ring.
    const maxCables = this.positions.length
    this.buffer = new Float32Array(maxCables * 6)
    const geometry = new THREE.BufferGeometry()
    this.attribute = new THREE.BufferAttribute(this.buffer, 3)
    this.attribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', this.attribute)
    geometry.setDrawRange(0, 0)
    // Drawn at their real (constant) diameter, glowing (see src/scene/structureLines.js).
    this.diameter = elevatorCableDiameter(dParamWithUnits, upperUp - lowerUp, dParamWithUnits['elevatorCarMass'].value)
    StructureLines.constantAttributes(geometry, maxCables * 2, this.diameter)
    this.material = StructureLines.createMaterial(0x4897f8)
    this.mesh = new THREE.LineSegments(geometry, this.material)
    this.mesh.name = 'elevatorCables'
    this.mesh.renderOrder = 1
    this.mesh.frustumCulled = false
    this.maxCables = maxCables
    this.land = new Uint8Array(this.positions.length) // LAND_* per cable
    this.nextLandCheck = 0
    this.terrain = null
  }

  // terrain: { sampleHeight(latDeg, lonDeg) -> { heightMeters } | null, planetFrame: Object3D,
  // ellipsoid } so cables can be kept to land (see LAND_RADIUS).
  setTerrain(terrain) {
    this.terrain = terrain
    this.land?.fill(LAND_UNKNOWN)
  }

  // Re-checks a few cables' ground: is there land (height >= 0) at the point where the cable meets the
  // surface, or on circles of half and the full LAND_RADIUS around it?
  checkLand(curve) {
    if (!this.terrain || !this.mesh?.parent) return
    const { sampleHeight, planetFrame, ellipsoid } = this.terrain
    this.mesh.parent.updateWorldMatrix(true, false)
    planetFrame.updateWorldMatrix(true, false)
    const n = this.positions.length
    for (let k = 0; k < Math.min(LAND_CHECKS_PER_FRAME, n); k++) {
      const i = this.nextLandCheck
      this.nextLandCheck = (i + 1) % n
      ringPoint(curve, this.positions[i], this.lower[0], this.lower[1], this.forward, _ground)
      planetFrame.worldToLocal(this.mesh.parent.localToWorld(_ground))
      const g = ecefToGeodetic(_ground.x, _ground.y, _ground.z, ellipsoid)
      const metresPerDegreeLat = 111320
      const metresPerDegreeLon = Math.max(1, 111320 * Math.cos(g.lat * Math.PI / 180))
      let known = false, land = false
      const sample = (dNorth, dEast) => {
        const h = sampleHeight(g.lat + dNorth / metresPerDegreeLat, g.lon + dEast / metresPerDegreeLon)
        if (!h) return
        known = true
        if (h.heightMeters >= 0) land = true
      }
      sample(0, 0)
      for (const radius of [LAND_RADIUS / 2, LAND_RADIUS]) {
        for (let a = 0; a < 8 && !land; a++) sample(radius * Math.cos(a * Math.PI / 4), radius * Math.sin(a * Math.PI / 4))
      }
      this.land[i] = land ? LAND_YES : (known ? LAND_NO : LAND_UNKNOWN)
    }
  }

  setCameraRange(range) {
    this.cameraRange = range
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
    this.checkLand(curve)
    forEachInWindow(this.positions, nearestTrackPosition, this.cameraRange / this.ringCircumference, (i) => {
      if (k >= this.maxCables) return
      if (this.terrain && this.land[i] !== LAND_YES) return
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
