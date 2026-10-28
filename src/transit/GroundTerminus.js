import { offset_r, offset_y } from '../ring/ringGeometry.js'
import { VirtualRingObject, placeModelOnRing } from './VirtualRingObject.js'

export class virtualGroundTerminus extends VirtualRingObject {
  static isDynamic = false

  static update(dParamWithUnits, crv) {
    const outwardOffset = dParamWithUnits['transitTubeOutwardOffset'].value - dParamWithUnits['transitTubeTubeRadius'].value + dParamWithUnits['groundTerminusOutwardOffset'].value
    const upwardOffset = dParamWithUnits['transitTubeUpwardOffset'].value + dParamWithUnits['groundTerminusUpwardOffset'].value - crv.currentMainRingAltitude
    virtualGroundTerminus.groundTerminusRelativePosition_r = offset_r(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
    virtualGroundTerminus.groundTerminusRelativePosition_y = offset_y(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
    virtualGroundTerminus.currentEquivalentLatitude = crv.currentEquivalentLatitude
    virtualGroundTerminus.isVisible = dParamWithUnits['showGroundTerminuses'].value
  }

  placeAndOrientModel(om, refFrame) {
    placeModelOnRing(om, refFrame.curve, this.trackPosition(refFrame),
      virtualGroundTerminus.groundTerminusRelativePosition_r, virtualGroundTerminus.groundTerminusRelativePosition_y, 0,
      virtualGroundTerminus.currentEquivalentLatitude)
    om.rotateZ(-Math.PI/2)
    om.rotateY(-Math.PI/2)
    om.visible = virtualGroundTerminus.isVisible
  }
}
