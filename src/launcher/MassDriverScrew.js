import * as THREE from 'three'
import { ScrewGeometry } from './ScrewGeometry.js'
import * as tram from '../utils/tram.js'
import { VirtualObject, parameterSignature } from './VirtualObject.js'

export class massDriverScrewModel {

    constructor() {
    }

    // Each model along the mass driver curve is unique, since the pitch of the mass driver's drive thread changes along it's length
    // so instead of dynamically allocating models from a pool of identical unallocated models, we need to create a unique model for each portion of the mass driver curve.
    // We can't dynamically reallocate these models, since each model always has to be placed in the location that it was designed for.
    // However, we can still hide and models, and also not update them, when they are too far from the camera to be visible.
    createModel(dParamWithUnits, launcherMassDriverLength, massDriverScrewSegments, segmentIndex, massDriverScrewMaterials, highRes = false) {

        if (highRes) {
          console.log('High Res Mass Driver Screw')
        }
        const shaftOuterRadius = dParamWithUnits['launcherMassDriverScrewShaftOuterRadius'].value
        const shaftInnerRadius = dParamWithUnits['launcherMassDriverScrewShaftInnerRadius'].value
        const threadRadius = dParamWithUnits['launcherMassDriverScrewThreadRadius'].value
        const threadThickness = dParamWithUnits['launcherMassDriverScrewThreadThickness'].value
        const threadTaperRatio = dParamWithUnits['launcherMassDriverScrewThreadTaperRatio'].value
        const launcherMassDriverScrewRevolutionsPerSecond = dParamWithUnits['launcherMassDriverScrewRevolutionsPerSecond'].value
        const launcherMassDriverForwardAcceleration = dParamWithUnits['launcherMassDriverForwardAcceleration'].value
        const launcherMassDriver1InitialVelocity = dParamWithUnits['launcherMassDriver1InitialVelocity'].value
        const bracketThickness = dParamWithUnits['launcherMassDriverScrewBracketThickness'].value
        
        // ToDo: This doesn't scale well. Need to figure out how to make this work for any dimentions of the mass driver's screw.

        // Hack!!!
        const minLengthSegmentsPerMeter = ((!highRes) ? 16 : 512)
        //const minLengthSegmentsPerMeter = ((!highRes) ? 512 : 512)

        const segmentSpacing = launcherMassDriverLength / massDriverScrewSegments
        const baseDistanceAlongScrew = segmentIndex * segmentSpacing
        const threadStarts = tram.calculateThreadStarts(baseDistanceAlongScrew, dParamWithUnits['launcherMassDriverScrewThreadStarts'].value)
        const screwLength = segmentSpacing - bracketThickness
        const initialDistance = dParamWithUnits['adaptiveNutBodyLength'].value / 2

        // The point of breaking the screw into segments relates to the need to display the brackets.
        const modelRadialSegments = ((!highRes) ? 12 : 96) / Math.min(threadStarts, 4)

        const massDriverScrewGeometry = new ScrewGeometry(
            screwLength,
            shaftOuterRadius,
            shaftInnerRadius,
            threadRadius,
            threadThickness,
            threadTaperRatio,
            threadStarts,
            baseDistanceAlongScrew,
            launcherMassDriver1InitialVelocity,
            initialDistance,
            launcherMassDriverScrewRevolutionsPerSecond,
            launcherMassDriverForwardAcceleration,
            modelRadialSegments,
            minLengthSegmentsPerMeter)
        const massDriverScrewMesh = new THREE.Mesh(massDriverScrewGeometry, massDriverScrewMaterials[segmentIndex%2])
        massDriverScrewMesh.name = "massDriverScrew"

        return massDriverScrewMesh
    }

    genSpecs(dParamWithUnits, specs) {

      const shaftOuterRadius = dParamWithUnits['launcherMassDriverScrewShaftOuterRadius'].value
      const shaftInnerRadius = dParamWithUnits['launcherMassDriverScrewShaftInnerRadius'].value
      const threadRadius = dParamWithUnits['launcherMassDriverScrewThreadRadius'].value
      const threadThickness = dParamWithUnits['launcherMassDriverScrewThreadThickness'].value
      const threadTaperRatio = dParamWithUnits['launcherMassDriverScrewThreadTaperRatio'].value
      // ToDo: If the thread starts are variable, then we need a more complex calculation for the screw's volume.
      const threadStarts = dParamWithUnits['launcherMassDriverScrewThreadStarts'].value
      const screwRoughLength = dParamWithUnits['launcherMassDriverScrewRoughLength'].value

      const shaftInnerArea = Math.PI * shaftInnerRadius**2
      const shaftOuterArea = Math.PI * shaftOuterRadius**2
      const threadHeight = threadRadius - shaftOuterRadius
      
      const massDriverScrewCrosssectionalArea = shaftOuterArea - shaftInnerArea + threadHeight * threadThickness*(1+threadTaperRatio)/2 * threadStarts
      specs['massDriverScrewCrosssectionalArea'] = {value: massDriverScrewCrosssectionalArea, units: "m2"}

    }
}

export class virtualMassDriverScrew extends VirtualObject {
  constructor(d, index) {
    super()
    this.d = d
    this.index = index
    this.versionNumber = 0
    this.position = []
  }

  static unallocatedModels = []
  static className = 'virtualMassDriverScrews'
  static modelsAreRecyleable = true   // pooled, but the geometry is regenerated for each segment index
  static isDynamic = true             // the screws spin

  static signatureOf(dParamWithUnits) {
    return parameterSignature(dParamWithUnits,
      ['launcherMassDriverScrew', 'launcherMassDriverForwardAcceleration', 'launcherMassDriver1InitialVelocity', 'adaptiveNutBodyLength'],
      ['SidewaysOffset', 'UpwardsOffset', 'Material', 'Density', 'Cost', 'STL'])
  }

  static isTeardownRequired(dParamWithUnits, massDriverAccelerationScrewSegments) {
    const newNumVirtualMassDriverAccelerationScrews = dParamWithUnits['showMassDriverAccelerationScrews'].value ? massDriverAccelerationScrewSegments : 0
    return newNumVirtualMassDriverAccelerationScrews!==virtualMassDriverScrew.numObjects
  }

  static update(dParamWithUnits, launcherMassDriverLength, massDriverScrewSegments, accelerationScrewLength, massDriverScrewMaterials, versionNumber) {
    const v = virtualMassDriverScrew
    v.numObjects = dParamWithUnits['showMassDriverAccelerationScrews'].value ? massDriverScrewSegments : 0
    v.halfBracketThickness = (accelerationScrewLength > 0) ? dParamWithUnits['launcherMassDriverScrewBracketThickness'].value / 2 / accelerationScrewLength : 0
    v.launcherMassDriverLength = launcherMassDriverLength
    v.massDriverScrewSegments = Math.max(1, massDriverScrewSegments)
    v.massDriverScrewMaterials = massDriverScrewMaterials
    v.shaftOuterRadius = dParamWithUnits['launcherMassDriverScrewShaftOuterRadius'].value
    v.shaftInnerRadius = dParamWithUnits['launcherMassDriverScrewShaftInnerRadius'].value
    v.threadRadius = dParamWithUnits['launcherMassDriverScrewThreadRadius'].value
    v.threadThickness = dParamWithUnits['launcherMassDriverScrewThreadThickness'].value
    v.threadTaperRatio = dParamWithUnits['launcherMassDriverScrewThreadTaperRatio'].value
    v.threadStarts = dParamWithUnits['launcherMassDriverScrewThreadStarts'].value
    v.launcherMassDriverScrewRevolutionsPerSecond = dParamWithUnits['launcherMassDriverScrewRevolutionsPerSecond'].value
    v.launcherMassDriverForwardAcceleration = dParamWithUnits['launcherMassDriverForwardAcceleration'].value
    v.launcherMassDriver1InitialVelocity = dParamWithUnits['launcherMassDriver1InitialVelocity'].value
    v.bracketThickness = dParamWithUnits['launcherMassDriverScrewBracketThickness'].value
    v.numBrackets = dParamWithUnits['launcherMassDriverScrewNumBrackets'].value
    v.initialDistance = dParamWithUnits['adaptiveNutBodyLength'].value / 2
    v.isVisible = dParamWithUnits['showMassDriverAccelerationScrews'].value
    v.isDynamic = true
    v.hasChanged = true
    v.sidewaysOffset = dParamWithUnits['launcherMassDriverScrewSidewaysOffset'].value
    v.upwardsOffset = dParamWithUnits['launcherMassDriverScrewUpwardsOffset'].value
    v.slowDownPassageOfTime = dParamWithUnits['launcherSlowDownPassageOfTime'].value
    v.launcherStartDelayInSeconds = dParamWithUnits['launcherStartDelayInSeconds'].value
    v.versionNumber = versionNumber
  }

  static addNewVirtualObjects(refFrames) {
    const v = virtualMassDriverScrew
    v.addEvenlySpacedObjects(refFrames, (i) => (i < v.numBrackets) ? -v.halfBracketThickness : 0)
  }

  placeAndOrientModel(om, refFrame) {
    const v = virtualMassDriverScrew
    om.visible = v.isVisible
    if (!v.isVisible) return
    const d = this.d
    if ((this.versionNumber!=v.versionNumber) || (this.position.length==0)) {
      // Something about the design has been updated so this instance also needs to be updated
      const upward = refFrame.curve.getNormalAt(d)
      const rightward = refFrame.curve.getBinormalAt(d)
      const vs = rightward.clone().multiplyScalar(v.sidewaysOffset)
      const vu = upward.clone().multiplyScalar(v.upwardsOffset)
      const p0 = refFrame.curve.getPointAt(d).add(vu)
      const p1 = p0.clone()
      this.position[0] = p0.add(vs)
      this.position[1] = p1.sub(vs)
      this.orientation = refFrame.curve.getQuaternionAt(d)
      this.versionNumber = v.versionNumber
    }

    // Pooled models carry geometry for one segment index; regenerate it when the model is reused elsewhere.
    if (om._screwIndex !== this.index) {
      const segmentSpacing = v.launcherMassDriverLength / v.massDriverScrewSegments
      const baseDistanceAlongScrew = this.index * segmentSpacing
      const threadStarts = tram.calculateThreadStarts(baseDistanceAlongScrew, v.threadStarts)
      const screwLength = Math.max(0.01, (this.index < v.numBrackets) ? segmentSpacing - v.bracketThickness : segmentSpacing)
      const modelRadialSegments = Math.max(3, Math.round(12 / Math.min(Math.max(1, threadStarts), 4)))
      const minLengthSegmentsPerMeter = 16

      // Both children (left and right screw) share one geometry; dispose it once.
      const oldGeometry = om.children[0].geometry
      if (oldGeometry && !oldGeometry.userData?.shared) oldGeometry.dispose()
      const geometry = new ScrewGeometry(
        screwLength,
        v.shaftOuterRadius,
        v.shaftInnerRadius,
        v.threadRadius,
        v.threadThickness,
        v.threadTaperRatio,
        threadStarts,
        baseDistanceAlongScrew,
        v.launcherMassDriver1InitialVelocity,
        v.initialDistance,
        v.launcherMassDriverScrewRevolutionsPerSecond,
        v.launcherMassDriverForwardAcceleration,
        modelRadialSegments,
        minLengthSegmentsPerMeter)
      om.children.forEach(child => {
        child.geometry = geometry
        child.material = v.massDriverScrewMaterials[0]
      })
      om._screwIndex = this.index
    }

    // The screw angle is a function of the launcher's global (adjusted) clock; the adaptive nuts use the
    // same time origin so their grapplers stay in phase with the thread.
    // NOTE: at e.g. 169 rev/s the rotation is far above the frame rate, so the rendered spin is aliased
    // (it can appear stationary or to turn backwards). That is inherent to sampling at 30-60 fps.
    const time = v.adjustedTime(refFrame.timeSinceStart)
    const turns = (time * v.launcherMassDriverScrewRevolutionsPerSecond) % 1
    om.children.forEach(child => {
      const index = child.userData
      const lr = 1 - index*2
      child.position.copy(this.position[index])
      child.quaternion.copy(this.orientation)
      child.rotateY(-lr * turns * 2 * Math.PI)
    })
  }

  static adjustedTime(timeSinceStart) {
    return tram.adjustedTimeSinceStart(virtualMassDriverScrew.slowDownPassageOfTime, timeSinceStart, virtualMassDriverScrew.launcherStartDelayInSeconds)
  }
}
