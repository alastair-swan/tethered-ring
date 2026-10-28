import * as THREE from 'three'
import { offset_r, offset_y, makeOffsetCurve } from './ringGeometry.js'
import { RingInstancedLayer } from './RingInstancedLayer.js'

let movingRingTexture = null

// Side-wall V coordinate = distance along the ring / texturePeriod. Segments are built at track
// position 0 where the ring tangent is +z, so the vertex z coordinate is the along-ring distance.
function makeAlongRingUVGenerator(texturePeriod, crossSectionSize) {
  return {
    generateTopUV(geometry, vertices, a, b, c) {
      return [a, b, c].map(i => new THREE.Vector2(vertices[i*3] / crossSectionSize, vertices[i*3+1] / crossSectionSize))
    },
    generateSideWallUV(geometry, vertices, a, b, c, d) {
      return [a, b, c, d].map(i => new THREE.Vector2(
        (vertices[i*3] + vertices[i*3+1]) / crossSectionSize,
        vertices[i*3+2] / texturePeriod))
    },
  }
}

// The moving (magnetically levitated) rings.
//
// PHYSICS NOTE: the real rings move at specs.movingRingsSpeed (several km/s). At render frame rates
// that is hundreds of metres per frame, so moving the (identical, uniformly spaced) segment geometry
// would only produce a stroboscopic alias. Instead the geometry is static and the texture is
// scrolled by the exact physical distance (see movingRingTextureOffset). The scroll is physically
// correct at every sampled instant, but at these speeds it still aliases between frames; a real
// camera would see a motion-blurred ring.
export function createMovingRingLayer(dParamWithUnits, crv, mainRingCurve, cameraRange) {
  const numSegments = dParamWithUnits['showMovingRings'].value ? dParamWithUnits['numVirtualMovingRingSegments'].value : 0
  const lengthSegments = 4
  const outward = dParamWithUnits['mainRingOutwardOffset'].value
  const upward = dParamWithUnits['mainRingUpwardOffset'].value
  const ringCircumference = 2 * Math.PI * crv.mainRingRadius
  const segmentLength = ringCircumference / Math.max(1, numSegments)
  // MirroredRepeatWrapping has a period of 2 in uv space, so use an even number of texture periods
  // per segment to keep the pattern continuous across segment boundaries.
  const periodsPerSegment = Math.max(2, 2 * Math.round(segmentLength / 2))
  const texturePeriod = segmentLength / periodsPerSegment

  const mrdx = dParamWithUnits['movingRingThickness'].value / 2
  const mrdy = dParamWithUnits['movingRingHeight'].value / 2
  const shape = new THREE.Shape()
  shape.moveTo(mrdx, mrdy)
  shape.lineTo(mrdx, -mrdy)
  shape.lineTo(-mrdx, -mrdy)
  shape.lineTo(-mrdx, mrdy)
  shape.closed = true
  const geometry = new THREE.ExtrudeGeometry(shape, {
    steps: lengthSegments,
    depth: 1,
    extrudePath: makeOffsetCurve(outward, upward, crv, lengthSegments, mainRingCurve, 0, Math.max(1, numSegments)),
    UVGenerator: makeAlongRingUVGenerator(texturePeriod, 2 * Math.max(mrdx, mrdy)),
  })

  if (!movingRingTexture) {
    movingRingTexture = new THREE.TextureLoader().load('./textures/movingRingTexture.jpg')
    movingRingTexture.wrapS = THREE.RepeatWrapping
    movingRingTexture.wrapT = THREE.MirroredRepeatWrapping   // (was THREE.MirrorWrapping, which does not exist)
  }
  // One material per layer so the texture offset can be animated without touching other users.
  const material = new THREE.MeshPhongMaterial({transparent: false, side: THREE.DoubleSide, shininess: 10, map: movingRingTexture.clone()})
  material.map.needsUpdate = true

  const layer = new RingInstancedLayer({
    name: 'movingRing',
    geometry,
    material,
    numSegments,
    numRings: dParamWithUnits['numMainRings'].value,
    ringSpacing: dParamWithUnits['mainRingSpacing'].value,
    dr: offset_r(outward, upward, crv.currentEquivalentLatitude),
    dy: offset_y(outward, upward, crv.currentEquivalentLatitude),
    rotZ: Math.PI/2,   // ToDo - the actual angle is a function of the forces that were calculated in tethers.js
    cameraRange,
    ringCircumference,
  })
  layer.texturePeriod = texturePeriod
  layer.ownedMaterial = material
  return layer
}

// Texture V offset for rings that have moved `distance` metres in `direction` (+1 = increasing
// track position). Reduced modulo the MirroredRepeat period in float64 before it reaches the GPU.
export function movingRingTextureOffset(distance, texturePeriod, direction) {
  const v = -direction * distance / texturePeriod
  return v - 2 * Math.floor(v / 2)
}
