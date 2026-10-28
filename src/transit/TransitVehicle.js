import * as THREE from 'three'
import { offset_r, offset_y } from '../ring/ringGeometry.js'
import { VirtualRingObject, posFrac, ringPoint } from './VirtualRingObject.js'

const _tmp = new THREE.Object3D()

export class virtualTransitVehicle extends VirtualRingObject {
  // The vehicle's position is this.p (fixed, within its lane's moving reference frame) plus the
  // frame's position. Lanes: 0/1 express (constant speed), 2/3 collector (stop at every transit stop).
  static isDynamic = true
  static transitVehicleRelativePosition_r = []
  static transitVehicleRelativePosition_y = []

  static update(dParamWithUnits, crv) {
    const dx = dParamWithUnits['transitTrackOuterOffset'].value
    const dy1 = dParamWithUnits['transitTrackUpperOffset1'].value
    const dy2 = dParamWithUnits['transitTrackUpperOffset2'].value
    const trackOffsetsList = [[-dx, dy1], [dx, dy1], [-dx, dy2], [dx, dy2]]

    for (let trackIndex = 0; trackIndex<trackOffsetsList.length; trackIndex++) {
      const outwardOffset = dParamWithUnits['transitTubeOutwardOffset'].value + trackOffsetsList[trackIndex][0]
      const upwardOffset = dParamWithUnits['transitTubeUpwardOffset'].value + dParamWithUnits['ringTerminusUpwardOffset'].value + trackOffsetsList[trackIndex][1] + dParamWithUnits['transitVehicleUpwardOffset'].value  // Last is half of the track height
      virtualTransitVehicle.transitVehicleRelativePosition_r[trackIndex] = offset_r(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
      virtualTransitVehicle.transitVehicleRelativePosition_y[trackIndex] = offset_y(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
    }
    virtualTransitVehicle.systemForwardOffset = dParamWithUnits['transitSystemForwardOffset'].value / (2 * Math.PI * crv.mainRingRadius)
    virtualTransitVehicle.forwardOffset = dParamWithUnits['transitVehicleForwardOffset'].value / (2 * Math.PI * crv.mainRingRadius)
    virtualTransitVehicle.currentEquivalentLatitude = crv.currentEquivalentLatitude
    virtualTransitVehicle.isVisible = dParamWithUnits['showTransitVehicles'].value
  }

  // Track position of the vehicle's model origin when its frame is at framePosition.
  modelTrackPosition(refFrame, framePosition) {
    return posFrac(this.p + framePosition + virtualTransitVehicle.systemForwardOffset + refFrame.direction * virtualTransitVehicle.forwardOffset)
  }

  placeAt(om, refFrame, framePosition) {
    const p = this.modelTrackPosition(refFrame, framePosition)
    const trackIndex = refFrame.trackIndex
    ringPoint(refFrame.curve, p,
      virtualTransitVehicle.transitVehicleRelativePosition_r[trackIndex],
      virtualTransitVehicle.transitVehicleRelativePosition_y[trackIndex], 0, om.position)
    om.rotation.set(0, -2 * Math.PI * p, virtualTransitVehicle.currentEquivalentLatitude)
    if (refFrame.direction===-1) {
      om.rotateX(Math.PI)
    }
  }

  placeAndOrientModel(om, refFrame) {
    this.placeAt(om, refFrame, refFrame.p)
    om.visible = virtualTransitVehicle.isVisible
  }

  // Ring-local position of the rendered model's origin `timeDeltaInSeconds` from now. Uses the
  // lane's exact motion profile, so acceleration and stops are accounted for.
  getFuturePosition(refFrame, timeDeltaInSeconds = 0) {
    this.placeAt(_tmp, refFrame, refFrame.futureP(timeDeltaInSeconds))
    return _tmp.position.clone()
  }

  // Same contract as virtualLaunchVehicle.getFutureFrame (ring-local vectors).
  getFutureFrame(refFrame, timeDeltaInSeconds = 0) {
    const framePosition = refFrame.futureP(timeDeltaInSeconds)
    const p = this.modelTrackPosition(refFrame, framePosition)
    this.placeAt(_tmp, refFrame, framePosition)
    const angle = 2 * Math.PI * p
    const lat = virtualTransitVehicle.currentEquivalentLatitude
    const forward = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(refFrame.direction)
    const upward = new THREE.Vector3(Math.cos(lat) * Math.cos(angle), Math.sin(lat), Math.cos(lat) * Math.sin(angle))
    const rightward = forward.clone().cross(upward).normalize()
    _tmp.updateMatrix()
    return {
      position: _tmp.position.clone(),
      forward,
      upward,
      rightward,
      orientation: _tmp.quaternion.clone(),
    }
  }
}
