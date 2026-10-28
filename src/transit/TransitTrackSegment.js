import * as THREE from 'three'
import { offset_r, offset_y, makeOffsetCurve } from '../ring/ringGeometry.js'
import { RingInstancedLayer } from '../ring/RingInstancedLayer.js'

let transitTrackMaterial = null

// One instanced layer per track (transitTracksNumUpwardTracks x transitTracksNumOutwardTracks).
export function createTransitTrackLayers(dParamWithUnits, crv, mainRingCurve, numTransitStops, cameraRange) {
  const layers = []
  const numSegments = dParamWithUnits['showTransitTracks'].value ? numTransitStops : 0
  if (numSegments === 0) return layers
  const ttnut = dParamWithUnits['transitTracksNumUpwardTracks'].value
  const ttnot = dParamWithUnits['transitTracksNumOutwardTracks'].value
  const dx = dParamWithUnits['transitTrackWidth'].value / 2
  const dy = dParamWithUnits['transitTrackHeight'].value / 2
  const trackShape = new THREE.Shape()
  trackShape.moveTo(dx, dy)
  trackShape.lineTo(dx, -dy)
  trackShape.lineTo(-dx, -dy)
  trackShape.lineTo(-dx, dy)
  trackShape.closed = true
  if (!transitTrackMaterial) transitTrackMaterial = new THREE.MeshPhongMaterial({color: 0x3f3f3f})
  const lat = crv.currentEquivalentLatitude

  for (let j = 0; j < ttnut; j++) {
    const ttuof = j - (ttnut - 1) / 2  // Transit Track Upward Offset Factor
    const upward = dParamWithUnits['transitTubeUpwardOffset'].value + dParamWithUnits['transitTrackUpwardOffset'].value + ttuof * dParamWithUnits['transitTrackUpwardSpacing'].value
    for (let i = 0; i < ttnot; i++) {
      const ttoof = i - (ttnot - 1) / 2  // Transit Track Outward Offset Factor
      const outward = dParamWithUnits['transitTubeOutwardOffset'].value + dParamWithUnits['transitTrackOutwardOffset'].value + ttoof * dParamWithUnits['transitTrackOutwardSpacing'].value
      const geometry = new THREE.ExtrudeGeometry(trackShape, {
        steps: 16,
        depth: 1,
        extrudePath: makeOffsetCurve(outward, upward, crv, 4, mainRingCurve, 0, numSegments),
      })
      layers.push(new RingInstancedLayer({
        name: 'transitTrack_' + j + '_' + i,
        geometry,
        material: transitTrackMaterial,
        numSegments,
        dr: offset_r(outward, upward, lat),
        dy: offset_y(outward, upward, lat),
        rotZ: lat,
        cameraRange,
        ringCircumference: 2 * Math.PI * crv.mainRingRadius,
      }))
    }
  }
  return layers
}
