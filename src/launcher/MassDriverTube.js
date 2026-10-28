import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CatmullRomSuperCurve3 } from '../curves/SuperCurves.js'
import { VirtualObject } from './VirtualObject.js'

export class massDriverTubeModel {
  // Each model along the mass driver curve is unique, since the pitch of the mass driver's drive thread changes along it's length
  // so instead of dynamically allocating models from a pool of identical unallocated models, we need to create a unique model for each portion of the mass driver curve.
  // We can't dynamically reallocate these models, since each model always has to be placed in the location that it was designed for.
  // However, we can still hide and models, and also not update them, when they are too far from the camera to be visible.
  constructor(dParamWithUnits) {
    this.update(dParamWithUnits)
    // this.massDriverTubeMaterial1 = new THREE.MeshPhongMaterial( {side: THREE.DoubleSide, color: 0x7fffff, transparent: true, depthWrite: false, opacity: 0.25})
    // this.massDriverTubeMaterial2 = new THREE.MeshPhongMaterial( {side: THREE.DoubleSide, color: 0x7f5050, transparent: true, depthWrite: false, opacity: 0.25})
    //this.massDriverTubeMaterial = new THREE.MeshPhongMaterial( {wireframe: true})
    this.tubeTexture = new THREE.TextureLoader().load('textures/TubeTexture.png')
    //this.tubeTexture = new THREE.TextureLoader().load('textures/TubeTexture2.png')
    this.tubeTexture.repeat.set(4, 1)
    this.tubeTexture.wrapS = THREE.MirroredRepeatWrapping
    this.tubeTexture.wrapT = THREE.MirroredRepeatWrapping
    //this.massDriverTubeMaterial1 = new THREE.MeshPhongMaterial( {map: this.tubeTexture, side: THREE.FrontSide, transparent: true, opacity: 1, shininess: 0.5} )
    //this.massDriverTubeMaterial1 = new THREE.MeshPhongMaterial( {side: THREE.FrontSide, color: 0x7fffff, transparent: true, opacity: 1, shininess: 0.5} )
    
    this.massDriverTubeMaterial1 = new THREE.MeshPhongMaterial( { side: THREE.DoubleSide, transparent: true, opacity: 0.15, shininess: 0.5} )
    //this.massDriverTubeMaterial1 = new THREE.MeshPhongMaterial( { side: THREE.DoubleSide, shininess: 0.5} )

    this.massDriverTubeMaterial2 = new THREE.MeshPhongMaterial( { side: THREE.DoubleSide, transparent: true, opacity: 0.5, shininess: 0.5, color: 0x000000} )
    this.massDriverTubeMaterial3 = new THREE.MeshPhongMaterial( { side: THREE.FrontSide, shininess: 0.5} )
    this.massDriverTubeMaterial4 = new THREE.MeshPhongMaterial( { side: THREE.FrontSide, transparent: true, opacity: 0.5, shininess: 0.5} )
    this.massDriverTubeMaterial5 = new THREE.LineBasicMaterial( { color: 0x4897f8, transparent: true, opacity: 0.5 })
    // this.massDriverTubeMaterial1 = new THREE.MeshPhongMaterial( { map: this.tubeTexture, side: THREE.DoubleSide, transparent: true, opacity: 0.6, shininess: 0.5} )
    // this.massDriverTubeMaterial2 = new THREE.MeshPhongMaterial( { side: THREE.DoubleSide, color: 0x101015, transparent: true, opacity: 0.95, shininess: 0.5} )

    this.liftFanRoughSpacing = this.radius * 4 // This is the distance between lift fans along the elevated evacuated tube.
        
    this.liftFanHubGeometry = new THREE.SphereGeometry(this.radius * 0.1, 16, 16)
    this.liftFanHubGeometry.scale(1, 1, 3)
    this.liftFanDiskGeometry = new THREE.SphereGeometry(this.radius * 1.5, 4, 64)
    this.liftFanDiskGeometry.scale(1, 1, 0.05)
    // this.liftFanCowlingGeometry = new THREE.TorusGeometry(this.radius*1.6, this.radius/32, 16, 64)
    // this.liftFanCowlingGeometry.scale(1, 1, 4)
    // this.liftFanGeometry = mergeGeometries([this.liftFanHubGeometry, this.liftFanCowlingGeometry])

    this.liftFanPylonGeometry = new THREE.CylinderGeometry(this.radius/16, this.radius/8, this.radius*2, 16)
    this.liftFanPylonGeometry.rotateZ(Math.PI/2)
    // These geometries and materials are shared by every tube segment; releasing a segment must not dispose them.
    ;[this.liftFanHubGeometry, this.liftFanDiskGeometry, this.liftFanPylonGeometry].forEach(g => { g.userData.shared = true })
    ;[this.massDriverTubeMaterial1, this.massDriverTubeMaterial2, this.massDriverTubeMaterial3, this.massDriverTubeMaterial4, this.massDriverTubeMaterial5].forEach(m => { m.userData.shared = true })

    this.exagerateNonElevatedTubeFactor = dParamWithUnits['exagerateNonElevatedTubeFactor'].value

  }

  update(dParamWithUnits) {
    this.massDriverTubeSegments = dParamWithUnits['numVirtualMassDriverTubes'].value
    this.radius = dParamWithUnits['launcherMassDriverTubeInnerRadius'].value
    this.showLiftFans = dParamWithUnits['showLiftFans'].value
  }
  
  createModel(curve, segmentIndex) {

    let modelLengthSegments    // This model, which is a segment of the whole mass driver, is itself divided into this many lengthwise segments
    const modelRadialSegments = 32
    const tubePoints = []

    // Now we need a reference point in the middle of this segment of the whole mass driver
    const modelsCurvePosition = (segmentIndex + 0.5) / this.massDriverTubeSegments
    const refPoint = curve.getPointAt(modelsCurvePosition)

    // Figure out the length of this segment - this might not work well when the elevated evacuated tube is coiled...
    let tubeSegmentLength = 0
    let p0, p1
    p0 = curve.getPointAt((segmentIndex + 0) / this.massDriverTubeSegments)
    for (let i = 1; i<=20; i++) {
      p1 = curve.getPointAt((segmentIndex + i/20) / this.massDriverTubeSegments)
      tubeSegmentLength += p0.distanceTo(p1)
      p0 = p1
    }

    // We need to orient the model so that it is aligned with the curve at this point
    // Hack - make the part of the tube that's off in the distance larger to make it more visible.
    const res = curve.findRelevantCurveAt(modelsCurvePosition)
    let exagerateTubeFactor = 1
    let aboveGround = true
    if ((res.relevantCurve.name!='elevatedEvacuatedTube') && (res.relevantCurve.name!='coiledElevatedEvacuatedTube')) {
      // Not elevated evacuated tube
      exagerateTubeFactor = this.exagerateNonElevatedTubeFactor
      modelLengthSegments = 4
      aboveGround = false
    }
    else {
      exagerateTubeFactor = 1
      modelLengthSegments = 64
      aboveGround = true
    }
    // End Hack
    //modelLengthSegments = 4

    const modelForward = new THREE.Vector3(0, 1, 0) // The direction that the model considers "forward"
    const modelUpward = new THREE.Vector3(0, 0, 1)  // The direction that the model considers "upward"
    const orientation = curve.getQuaternionAt(modelsCurvePosition, modelForward, modelUpward).invert()

    // We need to define a curve for this segment of the mass driver, and then use that curve to create a tube geometry for this model
    for (let i = 0; i<=modelLengthSegments; i++) {
      const modelsCurvePosition = (segmentIndex + i/modelLengthSegments) / this.massDriverTubeSegments
      tubePoints.push(curve.getPointAt(modelsCurvePosition).sub(refPoint).applyQuaternion(orientation))
    }

    const massDriverSegmentCurve = new CatmullRomSuperCurve3(tubePoints)
    let massDriverTubeGeometry, massDriverTubeMaterial
    // const lodEnabled = false
    // if (!lodEnabled) {
      massDriverTubeGeometry = new THREE.TubeGeometry(massDriverSegmentCurve, modelLengthSegments, this.radius * exagerateTubeFactor, modelRadialSegments, false)
      massDriverTubeMaterial = this.massDriverTubeMaterial1
    // }
    // else {
    //   // LOD enabled - doesn't work - unreolved bug
    //   const linePoints = []
    //   for (let i = 0; i<modelLengthSegments; i++) {
    //     linePoints.push(massDriverSegmentCurve.getPointAt(i/modelLengthSegments))
    //   }
    //   console.log(linePoints)
    //   massDriverTubeGeometry = new THREE.BufferGeometry().setFromPoints(linePoints)
    //   massDriverTubeMaterial = this.massDriverTubeMaterial5
    // }
    // massDriverTubeGeometry.computeBoundingSphere() // No benefit seen
    //const massDriverTubeMesh = new THREE.Mesh(massDriverTubeGeometry, (segmentIndex%10==0) ? this.massDriverTubeMaterial1 : this.massDriverTubeMaterial2)
    // Hack for Olympus Mons clip
    //aboveGround = (segmentIndex<=126 || segmentIndex>250)
    // Hack for Hawaii clip
    //aboveGround = (segmentIndex<=211 || segmentIndex>228)  // That is, not in a tunnel
    //const tubeMesh = new THREE.Mesh(massDriverTubeGeometry, (!aboveGround) ? this.massDriverTubeMaterial1 : this.massDriverTubeMaterial2)
    const tubeMesh = new THREE.Mesh(massDriverTubeGeometry, massDriverTubeMaterial)
    tubeMesh.name = "massDriverTubeSegment"
    const massDriverTubeMesh = new THREE.Group().add(tubeMesh)
    const liftFansPerSegment = Math.round(tubeSegmentLength / this.liftFanRoughSpacing)

    if (this.showLiftFans) {
      for (let i = 0; i<liftFansPerSegment; i++) {
        const modelsCurvePosition = (segmentIndex + (i+0.5)/liftFansPerSegment) / this.massDriverTubeSegments
        const res = curve.findRelevantCurveAt(modelsCurvePosition)
        if ((res.relevantCurve.name=='elevatedEvacuatedTube') || (res.relevantCurve.name=='coiledElevatedEvacuatedTube')) {
          const point = curve.getPointAt(modelsCurvePosition)
          const tangent = curve.getTangentAt(modelsCurvePosition)
          const normal = curve.getNormalAt(modelsCurvePosition)
          const binormal = curve.getBinormalAt(modelsCurvePosition)

          for (let lr = -1; lr<=1; lr+=2) {
            const hubPos = point.clone().add(binormal.clone().multiplyScalar(lr*this.radius*3)).add(normal.clone().multiplyScalar(this.radius*.2))
            const fanPos = hubPos.clone().add(normal.clone().multiplyScalar(this.radius*.2))
            const pylonPos = point.clone().add(binormal.clone().multiplyScalar(lr*this.radius*2)).add(normal.clone().multiplyScalar(this.radius*.1))
            const relHubPos = hubPos.clone().sub(refPoint).applyQuaternion(orientation)
            const relFanPos = fanPos.clone().sub(refPoint).applyQuaternion(orientation)
            const relPylonPos = pylonPos.clone().sub(refPoint).applyQuaternion(orientation)
            const fanDirection = fanPos.clone().normalize()
            const pylonOrientation = fanDirection.clone().applyAxisAngle(tangent, -lr*Math.PI/32).applyQuaternion(orientation)
            fanDirection.applyAxisAngle(tangent, Math.PI/32) // Rotate the fan direction to be perpendicular to the tube
            const fanOrientation = fanDirection.applyQuaternion(orientation)

            const liftFanHubMesh = new THREE.Mesh(this.liftFanHubGeometry, this.massDriverTubeMaterial3)
            liftFanHubMesh.position.copy(relHubPos)
            liftFanHubMesh.lookAt(relHubPos.clone().add(fanOrientation))
            liftFanHubMesh.name = "liftFanHub"
            massDriverTubeMesh.add(liftFanHubMesh)
            
            const liftFanDiskMesh = new THREE.Mesh(this.liftFanDiskGeometry, this.massDriverTubeMaterial4)
            liftFanDiskMesh.position.copy(relFanPos)
            liftFanDiskMesh.lookAt(relFanPos.clone().add(fanOrientation))
            liftFanDiskMesh.scale.set(1, 1, 0.05)
            liftFanDiskMesh.name = "liftFanDisk"
            massDriverTubeMesh.add(liftFanDiskMesh)
            
            // const liftFanCowlingMesh = new THREE.Mesh(this.liftFanCowlingGeometry, this.massDriverTubeMaterial3)
            // liftFanCowlingMesh.position.copy(relFanPos)
            // liftFanCowlingMesh.lookAt(relFanPos.clone().add(fanOrientation))
            // liftFanCowlingMesh.scale.set(1, 1, 4)
            // liftFanCowlingMesh.name = "liftFanCowling"
            // massDriverTubeMesh.add(liftFanCowlingMesh)

            const liftFanPylonMesh = new THREE.Mesh(this.liftFanPylonGeometry, this.massDriverTubeMaterial3)
            liftFanPylonMesh.position.copy(relPylonPos)
            liftFanPylonMesh.scale.set(-lr, .25, 1)
            liftFanPylonMesh.lookAt(relPylonPos.clone().add(pylonOrientation))
            liftFanPylonMesh.name = "liftFanPylon"
            massDriverTubeMesh.add(liftFanPylonMesh)
          }
        }
      }
    }

    massDriverTubeMesh.renderOrder = 999

    // Debug code
    // const blueMaterial = new THREE.MeshLambertMaterial({color: 0x4040df})
    // const massDriverTubeMesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), blueMaterial)
    // massDriverTubeMesh.position.copy(refPoint)

    return massDriverTubeMesh
  }

  genSpecs(dParamWithUnits, specs) {
    const launcherMassDriverTubeInnerRadius = dParamWithUnits['launcherMassDriverTubeInnerRadius'].value
    const launcherMassDriverTubeWallThickness = dParamWithUnits['launcherMassDriverTubeWallThickness'].value
    const launcherMassDriverTubeLinerThickness = dParamWithUnits['launcherMassDriverTubeLinerThickness'].value
    // Let's assume that we want the tube to be buoyant. We'll use tension lines to moore it to the sea floor.
    // We need enough concrete to provide stuctural rigidity.

    const launcherMassDriverTubeMaterial0Density = dParamWithUnits['launcherMassDriverTubeMaterial0Density'].value
    const launcherMassDriverTubeMaterial0Cost = dParamWithUnits['launcherMassDriverTubeMaterial0Cost'].value
    const launcherMassDriverTubeMaterial1Density = dParamWithUnits['launcherMassDriverTubeMaterial1Density'].value
    const launcherMassDriverTubeMaterial1Cost = dParamWithUnits['launcherMassDriverTubeMaterial1Cost'].value

    const massDriverTubeWallCrosssectionalArea = Math.PI * ((launcherMassDriverTubeInnerRadius+launcherMassDriverTubeWallThickness)**2 - launcherMassDriverTubeInnerRadius**2)
    const massDriverTubeLinerCrosssectionalArea = Math.PI * ((launcherMassDriverTubeInnerRadius+launcherMassDriverTubeWallThickness+launcherMassDriverTubeLinerThickness)**2 - (launcherMassDriverTubeInnerRadius+launcherMassDriverTubeWallThickness)**2)
    specs['massDriverTubeWallCrosssectionalArea'] = {value: massDriverTubeWallCrosssectionalArea, units: "m2"}
    specs['massDriverTubeLinerCrosssectionalArea'] = {value: massDriverTubeLinerCrosssectionalArea, units: "m2"}
  }

}

export class virtualMassDriverTube extends VirtualObject {
  constructor(d, index) {
    super()
    this.d = d
    this.index = index
  }

  static unallocatedModels = []
  static className = 'virtualMassDriverTubes'
  static modelsAreRecyleable = false  // each tube segment is built for its own stretch of the curve
  static isDynamic = false

  static isTeardownRequired(dParamWithUnits) {
    const newNumObjects = dParamWithUnits['showMassDriverTube'].value ? dParamWithUnits['numVirtualMassDriverTubes'].value : 0
    return newNumObjects!==virtualMassDriverTube.numObjects
  }

  static update(dParamWithUnits, versionNumber) {
    virtualMassDriverTube.numObjects = dParamWithUnits['showMassDriverTube'].value ? dParamWithUnits['numVirtualMassDriverTubes'].value : 0
    virtualMassDriverTube.isVisible = dParamWithUnits['showMassDriverTube'].value
    virtualMassDriverTube.isDynamic = false
    virtualMassDriverTube.hasChanged = true
    virtualMassDriverTube.versionNumber = versionNumber
  }

  static addNewVirtualObjects(refFrames) {
    virtualMassDriverTube.addEvenlySpacedObjects(refFrames)
  }

  placeAndOrientModel(om, refFrame) {
    if (virtualMassDriverTube.hasChanged) this.position = null  // the curve may have been reshaped
    this.placeAtD(om, refFrame)
  }
}
