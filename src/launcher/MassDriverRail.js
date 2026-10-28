import * as THREE from 'three'
import { CatmullRomSuperCurve3 } from '../curves/SuperCurves.js'
import { ShapeUtils } from 'three'
import { VirtualObject } from './VirtualObject.js'

export class massDriverRailModel {
  // Each model along the mass driver curve is unique, since the pitch of the mass driver's drive thread changes along it's length
  // so instead of dynamically allocating models from a pool of identical unallocated models, we need to create a unique model for each portion of the mass driver curve.
  // We can't dynamically reallocate these models, since each model always has to be placed in the location that it was designed for.
  // However, we can still hide and models, and also not update them, when they are too far from the camera to be visible.
  constructor(dParamWithUnits) {
    this.update(dParamWithUnits)
    // Create rail materials
    this.massDriverRailMaterials = []
    this.massDriverRailMaterials[0] = new THREE.MeshPhongMaterial( { color: 0x31313E } )
    this.massDriverRailMaterials[1] = new THREE.MeshPhongMaterial( { color: 0x79111E } )
    this.massDriverRailMaterials.forEach(m => { m.userData.shared = true })
  }

  update(dParamWithUnits) {
    this.shape = this.createShape(dParamWithUnits)
    this.massDriverRailSegments = dParamWithUnits['numVirtualMassDriverRails'].value
  }

  createModel(curve, segmentIndex) {

    const modelLengthSegments = 32    // This model, which is a segment of the whole mass driver, is itself divided into this many lengthwise segments
    const railPoints = []

    // Now we need a reference point in the middle of this segment of the whole mass driver
    const modelsCurvePosition = (segmentIndex + 0.5) / this.massDriverRailSegments
    const refPoint = curve.getPointAt(modelsCurvePosition)
    
    const modelForward = new THREE.Vector3(0, 1, 0) // The direction that the model considers "forward"
    const modelUpward = new THREE.Vector3(0, 0, 1)  // The direction that the model considers "upward"
    const orientation = curve.getQuaternionAt(modelsCurvePosition, modelForward, modelUpward).invert()

    // We need to define a curve for this segment of the mass driver, and then use that curve to create a rail geometry for this model
    for (let i = 0; i<=modelLengthSegments; i++) {
      const modelsCurvePosition = (segmentIndex + i/modelLengthSegments) / this.massDriverRailSegments
      railPoints.push(curve.getPointAt(modelsCurvePosition).sub(refPoint).applyQuaternion(orientation))
    }
    const massDriverSegmentCurve = new CatmullRomSuperCurve3(railPoints)
    const extrudeSettings = {
      steps: modelLengthSegments,
      depth: 1,
      extrudePath: massDriverSegmentCurve
    }
    const massDriverRailGeometry = new THREE.ExtrudeGeometry(this.shape, extrudeSettings)
    massDriverRailGeometry.name = "massDriverRailGeometry"
    // ToDo: We are creating multiple identical materials here.  We should create one material and reuse it.
    // Hack for Hawaii clip
    //const massDriverRailMaterial = this.massDriverRailMaterials[(index % 16 == 0) ? 1 : 0] // This makes every 16th rail segment a different color
    // The reference-frame curve is a path; look up the sub-curve (named launchRampCurve0/1) at this segment.
    const subCurve = curve.findRelevantCurveAt ? curve.findRelevantCurveAt(modelsCurvePosition).relevantCurve : curve
    const onRamp = subCurve.name.startsWith("launchRampCurve")
    const massDriverRailMaterial = this.massDriverRailMaterials[(onRamp) ? 1 : 0]
    const massDriverRailMesh = new THREE.Mesh(massDriverRailGeometry, massDriverRailMaterial)
    massDriverRailMesh.castShadow = true
    return massDriverRailMesh
  }

  createShape(dParamWithUnits) {
    const width = dParamWithUnits['launcherMassDriverRailWidth'].value
    const height = dParamWithUnits['launcherMassDriverRailHeight'].value
    const shape = new THREE.Shape()

    shape.moveTo( width/2 , height/2 )
    shape.lineTo( width/2 , -height/2 )
    shape.lineTo( -width/2 , -height/2 )
    shape.lineTo( -width/2 , height/2 )
    shape.lineTo( width/2 , height/2 )

    return shape

  }

  genSpecs(dParamWithUnits, specs) {

    const shape = this.createShape(dParamWithUnits)
    const contour = []

    contour.push(shape.curves[0].v1)
    shape.curves.forEach(curve => {
      contour.push(curve.v2)
    })

    const massDriverRailCrosssectionalArea = Math.abs(ShapeUtils.area(contour))
    console.log("massDriverRailCrosssectionalArea:", massDriverRailCrosssectionalArea)
    specs['massDriverRailCrosssectionalArea'] = {value: massDriverRailCrosssectionalArea, units: "m2"}

  }

}

export class virtualMassDriverRail extends VirtualObject {
  constructor(d, index) {
    super()
    this.d = d
    this.index = index
  }

  static unallocatedModels = []
  static className = 'virtualMassDriverRails'
  static modelsAreRecyleable = false  // each rail segment is built for its own stretch of the curve
  static isDynamic = false

  static isTeardownRequired(dParamWithUnits) {
    const newNumObjects = dParamWithUnits['showMassDriverRail'].value ? dParamWithUnits['numVirtualMassDriverRails'].value : 0
    return newNumObjects!==virtualMassDriverRail.numObjects
  }

  static update(dParamWithUnits, versionNumber) {
    virtualMassDriverRail.numObjects = dParamWithUnits['showMassDriverRail'].value ? dParamWithUnits['numVirtualMassDriverRails'].value : 0
    virtualMassDriverRail.isVisible = dParamWithUnits['showMassDriverRail'].value
    virtualMassDriverRail.upwardsOffset = dParamWithUnits['launchRailUpwardsOffset'].value
    virtualMassDriverRail.isDynamic = false
    virtualMassDriverRail.hasChanged = true
    virtualMassDriverRail.versionNumber = versionNumber
  }

  static addNewVirtualObjects(refFrames) {
    virtualMassDriverRail.addEvenlySpacedObjects(refFrames)
  }

  placeAndOrientModel(om, refFrame) {
    this.placeAtD(om, refFrame, virtualMassDriverRail.upwardsOffset)
  }
}
