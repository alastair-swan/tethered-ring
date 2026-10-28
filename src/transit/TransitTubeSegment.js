import * as THREE from 'three'
import { offset_r, offset_y, makeOffsetCurve } from '../ring/ringGeometry.js'
import { RingInstancedLayer } from '../ring/RingInstancedLayer.js'

// The evacuated transit tube: one instance per transit stop spacing (exactly one per position;
// the old code pushed numMainRings coincident copies of every segment).
// cameraRange is updated every frame to the horizon distance (see transitSystem.animate), so the
// capacity covers the whole ring.
export function createTransitTubeLayer(dParamWithUnits, crv, mainRingCurve, numTransitStops, cameraRange) {
  const numSegments = dParamWithUnits['showTransitTube'].value ? numTransitStops : 0
  const lengthSegments = 4
  const outward = dParamWithUnits['transitTubeOutwardOffset'].value
  const upward = dParamWithUnits['transitTubeUpwardOffset'].value
  const curve = makeOffsetCurve(outward, upward, crv, lengthSegments, mainRingCurve, 0, Math.max(1, numSegments))
  const geometry = new THREE.TubeGeometry(curve, lengthSegments, dParamWithUnits['transitTubeTubeRadius'].value, 32, false)
  const material = new THREE.MeshPhongMaterial({side: THREE.FrontSide, transparent: true, opacity: dParamWithUnits['transitTubeOpacity'].value})
  const layer = new RingInstancedLayer({
    name: 'transitTube',
    geometry,
    material,
    numSegments,
    dr: offset_r(outward, upward, crv.currentEquivalentLatitude),
    dy: offset_y(outward, upward, crv.currentEquivalentLatitude),
    rotZ: crv.currentEquivalentLatitude,
    cameraRange,
    maxCameraRange: Infinity,
    ringCircumference: 2 * Math.PI * crv.mainRingRadius,
  })
  layer.ownedMaterial = material
  return layer
}
