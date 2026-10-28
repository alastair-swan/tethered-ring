import { offset_r, offset_y } from '../ring/ringGeometry.js'
import { VirtualRingObject, placeModelOnRing } from './VirtualRingObject.js'

export class virtualRingTerminus extends VirtualRingObject {
  static isDynamic = false

  static update(dParamWithUnits, crv) {
    const outwardOffset = dParamWithUnits['transitTubeOutwardOffset'].value - dParamWithUnits['transitTubeTubeRadius'].value + dParamWithUnits['ringTerminusOutwardOffset'].value
    const upwardOffset = dParamWithUnits['transitTubeUpwardOffset'].value + dParamWithUnits['ringTerminusUpwardOffset'].value
    virtualRingTerminus.ringTerminusRelativePosition_r = offset_r(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
    virtualRingTerminus.ringTerminusRelativePosition_y = offset_y(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
    virtualRingTerminus.currentEquivalentLatitude = crv.currentEquivalentLatitude
    virtualRingTerminus.isVisible = dParamWithUnits['showRingTerminuses'].value
  }

  placeAndOrientModel(om, refFrame) {
    placeModelOnRing(om, refFrame.curve, this.trackPosition(refFrame),
      virtualRingTerminus.ringTerminusRelativePosition_r, virtualRingTerminus.ringTerminusRelativePosition_y, 0,
      virtualRingTerminus.currentEquivalentLatitude)
    om.rotateZ(-Math.PI/2)
    om.rotateY(-Math.PI/2)
    om.visible = virtualRingTerminus.isVisible
  }
}
