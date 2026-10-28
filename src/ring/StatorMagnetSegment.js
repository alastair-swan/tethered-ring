import * as THREE from 'three'
import { offset_r, offset_y, makeOffsetCurve } from './ringGeometry.js'
import { RingInstancedLayer } from './RingInstancedLayer.js'

let statorMagnetMaterial = null

// The stator magnets that levitate and drive the moving rings (static).
export function createStatorMagnetLayer(dParamWithUnits, crv, mainRingCurve, cameraRange) {
  const numSegments = dParamWithUnits['showStatorMagnets'].value ? dParamWithUnits['numVirtualStatorMagnetSegments'].value : 0
  const lengthSegments = 4
  const outward = dParamWithUnits['mainRingOutwardOffset'].value
  const upward = dParamWithUnits['mainRingUpwardOffset'].value

  const mrdx = dParamWithUnits['movingRingThickness'].value / 2
  const smdx = dParamWithUnits['statorMagnetThickness'].value / 2
  const smdy = dParamWithUnits['statorMagnetHeight'].value / 2
  const smag = dParamWithUnits['statorMagnetAirGap'].value / 2
  const r = 2*smdx
  const shape = new THREE.Shape()
  const xOffset = -smag - mrdx - smdx
  shape.moveTo(xOffset+smdx, smdy)
  shape.lineTo(xOffset+smdx, -smdy)
  shape.lineTo(xOffset-smdx, -smdy)
  shape.arc(0, r, r, -Math.PI/2, -Math.PI, true)
  shape.lineTo(xOffset-smdx-r, 0-r)
  shape.arc(r, 0, r, -Math.PI, -3*Math.PI/2, true)
  shape.arc(0, r, r, -Math.PI/2, -Math.PI, true)
  shape.lineTo(xOffset-smdx-r, smdy-r)
  shape.arc(r, 0, r, -Math.PI, -3*Math.PI/2, true)
  shape.lineTo(xOffset-smdx, smdy)
  shape.closed = true

  const geometry = new THREE.ExtrudeGeometry(shape, {
    steps: lengthSegments,
    depth: 1,
    extrudePath: makeOffsetCurve(outward, upward, crv, lengthSegments, mainRingCurve, 0, Math.max(1, numSegments)),
  })
  if (!statorMagnetMaterial) {
    const texture = new THREE.TextureLoader().load('./textures/steelTexture.jpg')
    texture.wrapS = THREE.RepeatWrapping
    texture.repeat.set(1, 50)
    statorMagnetMaterial = new THREE.MeshPhongMaterial({transparent: false, side: THREE.DoubleSide, map: texture})
  }
  return new RingInstancedLayer({
    name: 'statorMagnet',
    geometry,
    material: statorMagnetMaterial,
    numSegments,
    numRings: dParamWithUnits['numMainRings'].value,
    ringSpacing: dParamWithUnits['mainRingSpacing'].value,
    dr: offset_r(outward, upward, crv.currentEquivalentLatitude),
    dy: offset_y(outward, upward, crv.currentEquivalentLatitude),
    rotZ: Math.PI/2,   // ToDo - the actual angle is a function of the forces that were calculated in tethers.js
    cameraRange,
    ringCircumference: 2 * Math.PI * crv.mainRingRadius,
  })
}
