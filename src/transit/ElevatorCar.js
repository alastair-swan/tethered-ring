import * as THREE from 'three'
import { offset_r, offset_y } from '../ring/ringGeometry.js'
import { VirtualRingObject, ringPoint } from './VirtualRingObject.js'

const _tmp = new THREE.Object3D()

export class virtualElevatorCar extends VirtualRingObject {
  static isDynamic = true
  // Set by the transit system each frame: the motion profile and the elevator channel's time.
  static calculator = null
  static animationTime = 0
  static timeRate = 1

  static update(dParamWithUnits, crv) {
    virtualElevatorCar.elevatorCarOutwardOffset = dParamWithUnits['transitTubeOutwardOffset'].value - dParamWithUnits['transitTubeTubeRadius'].value + dParamWithUnits['elevatorCableOutwardOffset'].value
    virtualElevatorCar.elevatorCarUpwardOffset = dParamWithUnits['transitTubeUpwardOffset'].value + dParamWithUnits['ringTerminusUpwardOffset'].value + dParamWithUnits['elevatorCarUpwardOffset'].value
    virtualElevatorCar.elevatorCarForwardOffset = dParamWithUnits['elevatorCableForwardOffset'].value
    virtualElevatorCar.currentEquivalentLatitude = crv.currentEquivalentLatitude
    virtualElevatorCar.currentMainRingAltitude = crv.currentMainRingAltitude
    virtualElevatorCar.elevatorCarRotZ = crv.currentEquivalentLatitude - Math.PI/2
    virtualElevatorCar.isVisible = dParamWithUnits['showElevatorCars'].value
    virtualElevatorCar.animate(crv.currentMainRingAltitude)
  }

  // elevatorAltitude: the car's altitude coordinate, equal to the ring's altitude when docked at the top
  // and to groundTerminusUpwardOffset when docked at the bottom.
  static offsetsForAltitude(elevatorAltitude) {
    const up = virtualElevatorCar.elevatorCarUpwardOffset + elevatorAltitude - virtualElevatorCar.currentMainRingAltitude
    const lat = virtualElevatorCar.currentEquivalentLatitude
    return [offset_r(virtualElevatorCar.elevatorCarOutwardOffset, up, lat), offset_y(virtualElevatorCar.elevatorCarOutwardOffset, up, lat)]
  }

  static animate(elevatorAltitude) {
    [virtualElevatorCar.elevatorCarPosition_dr, virtualElevatorCar.elevatorCarPosition_dy] = virtualElevatorCar.offsetsForAltitude(elevatorAltitude)
  }

  placeWithOffsets(om, refFrame, dr, dy) {
    const p = this.trackPosition(refFrame)
    ringPoint(refFrame.curve, p, dr, dy, virtualElevatorCar.elevatorCarForwardOffset, om.position)
    om.rotation.set(0, -2 * Math.PI * p, virtualElevatorCar.elevatorCarRotZ)
  }

  placeAndOrientModel(om, refFrame) {
    this.placeWithOffsets(om, refFrame, virtualElevatorCar.elevatorCarPosition_dr, virtualElevatorCar.elevatorCarPosition_dy)
    om.visible = virtualElevatorCar.isVisible
  }

  // The car's frame (ring-local) at `elevatorAltitude` (see offsetsForAltitude): forward along the
  // ring, upward away from the ring's axis and tilted with the ring's latitude, like the transit vehicles.
  frameAt(refFrame, elevatorAltitude) {
    const [dr, dy] = virtualElevatorCar.offsetsForAltitude(elevatorAltitude)
    this.placeWithOffsets(_tmp, refFrame, dr, dy)
    const angle = 2 * Math.PI * this.trackPosition(refFrame)
    const lat = virtualElevatorCar.currentEquivalentLatitude
    const forward = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle))
    const upward = new THREE.Vector3(Math.cos(lat) * Math.cos(angle), Math.sin(lat), Math.cos(lat) * Math.sin(angle))
    const rightward = forward.clone().cross(upward).normalize()
    return { position: _tmp.position.clone(), forward, upward, rightward }
  }

  getFuturePosition(refFrame, timeDeltaInSeconds = 0) {
    let dr = virtualElevatorCar.elevatorCarPosition_dr
    let dy = virtualElevatorCar.elevatorCarPosition_dy
    if (virtualElevatorCar.calculator) {
      const t = virtualElevatorCar.animationTime + virtualElevatorCar.timeRate * timeDeltaInSeconds
      ;[dr, dy] = virtualElevatorCar.offsetsForAltitude(virtualElevatorCar.calculator.calculateElevatorPosition(t))
    }
    this.placeWithOffsets(_tmp, refFrame, dr, dy)
    return _tmp.position.clone()
  }
}
