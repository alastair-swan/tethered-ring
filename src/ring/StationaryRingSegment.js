import * as THREE from 'three'
import { offset_r, offset_y, makeOffsetCurve } from './ringGeometry.js'
import { RingInstancedLayer } from './RingInstancedLayer.js'

let stationaryRingMaterial = null

// The stationary rings (the evacuated tubes that the moving rings run inside), one instance per
// segment per main ring.
export function createStationaryRingLayer(dParamWithUnits, crv, mainRingCurve, cameraRange) {
  const numSegments = dParamWithUnits['showStationaryRings'].value ? dParamWithUnits['numVirtualStationaryRingSegments'].value : 0
  const lengthSegments = 4
  const outward = dParamWithUnits['mainRingOutwardOffset'].value
  const upward = dParamWithUnits['mainRingUpwardOffset'].value
  const curve = makeOffsetCurve(outward, upward, crv, lengthSegments, mainRingCurve, 0, Math.max(1, numSegments))
  const geometry = new THREE.TubeGeometry(curve, lengthSegments, dParamWithUnits['stationaryRingTubeRadius'].value, 32, false)
  if (!stationaryRingMaterial) stationaryRingMaterial = new THREE.MeshPhongMaterial({transparent: true, side: THREE.DoubleSide, opacity: 0.4})
  return new RingInstancedLayer({
    name: 'stationaryRing',
    geometry,
    material: stationaryRingMaterial,
    numSegments,
    numRings: dParamWithUnits['numMainRings'].value,
    ringSpacing: dParamWithUnits['mainRingSpacing'].value,
    dr: offset_r(outward, upward, crv.currentEquivalentLatitude),
    dy: offset_y(outward, upward, crv.currentEquivalentLatitude),
    rotZ: crv.currentEquivalentLatitude - Math.PI/2,
    cameraRange,
    ringCircumference: 2 * Math.PI * crv.mainRingRadius,
  })
}
