import * as THREE from 'three'
import { offset_r, offset_y } from '../ring/ringGeometry.js'
import { RingInstancedLayer } from '../ring/RingInstancedLayer.js'

let solarArrayMaterial = null

export function createSolarArrayLayer(dParamWithUnits, crv, cameraRange) {
  const numSegments = dParamWithUnits['showSolarArrays'].value ? dParamWithUnits['numVirtualSolarArrays'].value : 0
  const outward = dParamWithUnits['solarArrayOutwardOffset'].value
  const upward = dParamWithUnits['solarArrayUpwardOffset'].value
  const geometry = new THREE.PlaneGeometry(dParamWithUnits['solarArrayWidth'].value, dParamWithUnits['solarArrayHeight'].value, 1, 1)
  if (!solarArrayMaterial) {
    const texture = new THREE.TextureLoader().load('./textures/SolarPanelTexture.jpg')
    solarArrayMaterial = new THREE.MeshPhongMaterial({side: THREE.DoubleSide, map: texture})
  }
  return new RingInstancedLayer({
    name: 'solarArray',
    geometry,
    material: solarArrayMaterial,
    numSegments,
    dr: offset_r(outward, upward, crv.currentEquivalentLatitude),
    dy: offset_y(outward, upward, crv.currentEquivalentLatitude),
    rotZ: crv.currentEquivalentLatitude - Math.PI/2,
    localRotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI/4),
    cameraRange,
    ringCircumference: 2 * Math.PI * crv.mainRingRadius,
  })
}
