import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { SledGrapplerPlacementInfo, SledGrapplerGeometry } from './SledGrapplerGeometry.js'
import * as tram from '../utils/tram.js'
import { quaternionFromFrame } from '../curves/SuperCurves.js'
import { MovingVirtualObject, curveFrameAtTime, parameterSignature } from './VirtualObject.js'

const MODEL_FORWARD = new THREE.Vector3(0, 1, 0) // The direction that the model considers "forward"
const MODEL_UPWARD = new THREE.Vector3(0, 0, 1)  // The direction that the model considers "upward"

export class adaptiveNutModel {
  constructor(dParamWithUnits, myScene, unallocatedModelsList, perfOptimizedThreeJS, massDriverScrewTexture) {
    // Manually Create the Launch Vehicle
    const width = dParamWithUnits['adaptiveNutWidth'].value
    const height = dParamWithUnits['adaptiveNutHeight'].value
    const radialSegments = 32
    const bodyLength = dParamWithUnits['adaptiveNutBodyLength'].value
    const grapplerLength = dParamWithUnits['adaptiveNutGrapplerLength'].value
    const adaptiveNutForwardsOffset = dParamWithUnits['adaptiveNutForwardsOffset'].value
    const numGrapplers = dParamWithUnits['adaptiveNutNumGrapplers'].value
    const objName = 'adaptiveNut'
    const adaptiveNutNumModels = dParamWithUnits['adaptiveNutNumModels'].value
    const ballJointClearance = dParamWithUnits['adaptiveNutGrapplerBallJointClearance'].value
    const ballJointRadius = dParamWithUnits['adaptiveNutGrapplerBallJointRadius'].value
    const cylinderRadius = dParamWithUnits['adaptiveNutGrapplerCylinderRadius'].value

    // Proceedurally generate the Launch Sled's body (note: y-axis is in the direction the rocket is pointing, z-axis is up when the rocket is lying on it's side)
    const adaptiveNutBodyGeometry = new THREE.BoxGeometry(width, bodyLength, height, 1, 1, 1)
    adaptiveNutBodyGeometry.translate(0, bodyLength/2 - adaptiveNutForwardsOffset, 0)
    // const adaptiveNutBodyTexture = new THREE.TextureLoader().load('textures/adaptiveNutBodyTexture.jpg', function(texture) {adaptiveNutBodyMaterial.needsUpdate = true})
    // const adaptiveNutBodyMaterial = new THREE.MeshPhongMaterial( {map: adaptiveNutBodyTexture})
    const adaptiveNutBodyMaterial = new THREE.MeshPhongMaterial( {color: 0x7f6f7f})
    const adaptiveNutBodyMesh = new THREE.Mesh(adaptiveNutBodyGeometry, adaptiveNutBodyMaterial)
    adaptiveNutBodyMesh.name = 'body'
    const adaptiveNutMesh = new THREE.Group().add(adaptiveNutBodyMesh)
    addGrapplers(adaptiveNutMesh)
    adaptiveNutMesh.name = 'adaptiveNut'
    const scaleFactorVector = new THREE.Vector3(
      dParamWithUnits['launchSystemRightwardScaleFactor'].value,
      dParamWithUnits['launchSystemForwardScaleFactor'].value,
      dParamWithUnits['launchSystemUpwardScaleFactor'].value)

    decorateAndSave(adaptiveNutMesh, myScene, unallocatedModelsList, objName, scaleFactorVector, adaptiveNutNumModels, perfOptimizedThreeJS)

    // Load the Launch Sled's Mesh from a model, but then proceedurally generate the grapplers
    function prepareACallbackFunctionForFBXLoader (myScene) {
      // This is the additional work we want to do later, after the loader get's around to loading our model...
      return function(object) {
        object.children[0].scale.set(0.6, 1, 1.5)  // A bit hacky - Alastair's sled model is too wide and thin
        object.children[0].position.set(0, 0, 0) // reposition vertically after making the sled thicker
        object.scale.set(0.001, 0.001*1.62, 0.001)  // Correct for units - mm to m
        object.name = 'adaptiveNut_bodyFromModel'
        object.traverse(child => {
          if (child.isMesh) child.castShadow = true
        })
        object.children[0].material.color.setHex(0x2f1f50)
        myScene.traverse(child=> {
          if (child.name=='adaptiveNut_body') {
            const parent = child.parent
            // parent.remove(child)
            parent.add(object.clone())
          }
        })
        unallocatedModelsList.forEach(element => {
          element.traverse(child => {
            if (child.name==='adaptiveNut_body') {
              const parent = child.parent
              // parent.remove(child)
              parent.add(object.clone())
            }
          })
        })
      }
    }

    const loader = new OBJLoader();

    const addAdaptiveNuts = prepareACallbackFunctionForFBXLoader (myScene)
    
    loader.load('models/AdaptiveNut.obj',
      // called when resource is loaded
      addAdaptiveNuts,
      // called when loading is in progresses
      function ( xhr ) {
        console.log( ( xhr.loaded / xhr.total * 100 ) + '% loaded' )
      },
      // called when loading has errors
      function ( error ) {console.log( 'Error loading launch sled model')}
    )

    function addGrapplers(adaptiveNutMesh) {
      // Create the sled's grapplers
      const distanceToSledAft = 0
      const firstGrapplerDistance = (bodyLength-grapplerLength) / 2
      const grapplerSpacing = 1.0 / numGrapplers * grapplerLength
    
      const midwayPositionList = ['top', 'bottom']
      midwayPositionList.forEach(midwayPosition => {
        const midwayRotation = (midwayPosition==='top') ? 0.5 : 0
        for (let i = 0, grapplerDistance = firstGrapplerDistance; i<numGrapplers; i++, grapplerDistance += grapplerSpacing) {
          const grapplerGroup = new THREE.Group()
          grapplerGroup.name = 'grappler'
          grapplerGroup.userData = {index: i, midwayRotation: midwayRotation}  // Save the index of the grappler here
          adaptiveNutMesh.add(grapplerGroup)

          const adaptiveNutGrapplerMesh = createSledGrapplerMesh(dParamWithUnits, distanceToSledAft, grapplerLength, midwayRotation, grapplerDistance, massDriverScrewTexture)
          adaptiveNutGrapplerMesh.name = 'grappler'

          const adaptiveNutPivotGeometry = new THREE.SphereGeometry(ballJointRadius, 16, 8)
          const adaptiveNutPivotMaterial = new THREE.MeshPhongMaterial({color: 0x7f3f00})
          const adaptiveNutPivot = new THREE.Mesh(adaptiveNutPivotGeometry, adaptiveNutPivotMaterial)
          adaptiveNutPivot.name = 'pivot'

          // Hack - Adding 2 cm so that there's no gap between the pad and the post
          const postLength = .02 + ballJointClearance + ballJointRadius*5
          const adaptiveNutPostGeometry = new THREE.CylinderGeometry(ballJointRadius/2, ballJointRadius/2, postLength, 16, 1)
          adaptiveNutPostGeometry.translate(0, postLength/2, 0)
          const adaptiveNutPostMaterial = new THREE.MeshPhongMaterial({color: 0x7f3f00})
          const adaptiveNutPost = new THREE.Mesh(adaptiveNutPostGeometry, adaptiveNutPostMaterial)
          adaptiveNutPost.name = 'post'

          // Hack - need to calculate the length properly...
          // Hack - Added a 1.25 factor to make the strut a little longer
          const strutLength = (dParamWithUnits['launcherMassDriverScrewSidewaysOffset'].value + dParamWithUnits['launcherMassDriverScrewThreadRadius'].value * 1.25 - dParamWithUnits['adaptiveNutWidth'].value / 2) / 2
          const adaptiveNutStrutGeometry = new THREE.CylinderGeometry(cylinderRadius/2, cylinderRadius/2, strutLength, 16, 1)
          adaptiveNutStrutGeometry.translate(0, strutLength/2, 0)
          const adaptiveNutStrutMaterial = new THREE.MeshPhongMaterial({color: 0x7f3f00})
          const adaptiveNutStrut = new THREE.Mesh(adaptiveNutStrutGeometry, adaptiveNutStrutMaterial)
          adaptiveNutStrut.name = 'strut'
          
          const cylinderLength = strutLength
          const adaptiveNutCylinderGeometry = new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, cylinderLength, 16, 1)
          adaptiveNutCylinderGeometry.translate(0, cylinderLength/2, 0)
          const adaptiveNutCylinderMaterial = new THREE.MeshPhongMaterial({color: 0x7f3f00})
          const adaptiveNutCylinder = new THREE.Mesh(adaptiveNutCylinderGeometry, adaptiveNutCylinderMaterial)
          adaptiveNutCylinder.name = 'cylinder'
          
          const leftRightList = ['left', 'right']
          const innerOuterList = ['Inner', 'Middle', 'Outer']
          leftRightList.forEach(leftRight => {
            const leftRightSign = (leftRight==='left') ? -1 : 1
            const tempAdaptiveNutGrapplerMesh = adaptiveNutGrapplerMesh.clone()
            tempAdaptiveNutGrapplerMesh.userData = {leftRightSign: leftRightSign}
            tempAdaptiveNutGrapplerMesh.scale.set(-leftRightSign, 1, 1)
            grapplerGroup.add(tempAdaptiveNutGrapplerMesh)

            innerOuterList.forEach(innerOuter => {
              const innerMiddleOuterSign1 = (innerOuter==='Inner') ? -2 : (innerOuter==='Middle') ? 0.5 : 2
              const innerMiddleOuterSign2 = (innerOuter==='Inner') ? -2 : (innerOuter==='Middle') ? -1 : 2
              const tempPivot = adaptiveNutPivot.clone()
              tempPivot.userData = {leftRightSign: leftRightSign, innerMiddleOuterSign1: innerMiddleOuterSign1}  
              grapplerGroup.add(tempPivot)
              const tempPost = adaptiveNutPost.clone()
              tempPost.userData = {leftRightSign: leftRightSign}
              grapplerGroup.add(tempPost)
              const tempStrut = adaptiveNutStrut.clone()
              tempStrut.userData = {
                topBottomOffset: (midwayPosition==='top') ? -1: 1,
                leftRightSign: leftRightSign,
                innerMiddleOuterSign1: innerMiddleOuterSign1,
                innerMiddleOuterSign2: innerMiddleOuterSign2}
              grapplerGroup.add(tempStrut)
              const tempCylinder = adaptiveNutCylinder.clone()
              tempCylinder.userData = {
                topBottomOffset: (midwayPosition==='top') ? -1: 1,
                leftRightSign: leftRightSign,
                innerMiddleOuterSign1: innerMiddleOuterSign1,
                innerMiddleOuterSign2: innerMiddleOuterSign2}
              grapplerGroup.add(tempCylinder)
            })
          })
        }
      })
    }

    function createSledGrapplerMesh(dParamWithUnits, distanceToSledAft, grapplerLength, midwayRotation, grapplerDistance, massDriverScrewTexture) {
      // Each model along the mass driver curve is unique, since the pitch of the mass driver's drive thread changes along it's length
      // so instead of dynamically allocating models from a pool of identical unallocated models, we need to create a unique model for each portion of the mass driver curve.
      // We can't dynamically reallocate these models, since each model always has to be placed in the location that it was designed for.
      // However, we can still hide and models, and also not update them, when they are too far from the camera to be visible.
      const shaftOuterRadius = dParamWithUnits['launcherMassDriverScrewShaftOuterRadius'].value
      const shaftInnerRadius = dParamWithUnits['launcherMassDriverScrewShaftInnerRadius'].value
      const threadRadius = dParamWithUnits['launcherMassDriverScrewThreadRadius'].value
      const threadThickness = dParamWithUnits['launcherMassDriverScrewThreadThickness'].value
      const threadStarts = dParamWithUnits['launcherMassDriverScrewThreadStarts'].value
      const launcherMassDriverScrewRevolutionsPerSecond = dParamWithUnits['launcherMassDriverScrewRevolutionsPerSecond'].value
      const launcherMassDriverForwardAcceleration = dParamWithUnits['launcherMassDriverForwardAcceleration'].value
      const launcherMassDriver1InitialVelocity = dParamWithUnits['launcherMassDriver1InitialVelocity'].value
      const initialDistance = dParamWithUnits['adaptiveNutBodyLength'].value / 2
      const numGrapplers = dParamWithUnits['adaptiveNutNumGrapplers'].value
      const magnetThickness = dParamWithUnits['adaptiveNutGrapplerMagnetThickness'].value
      const betweenGrapplerFactor = dParamWithUnits['adaptiveNutBetweenGrapplerFactor'].value
      const shaftToGrapplerPad = dParamWithUnits['adaptiveNutShaftToGrapplerPad'].value
      const additionalRotation = 0
      const adaptiveNutGrapplerMaxRangeOfMotion = dParamWithUnits['adaptiveNutGrapplerMaxRangeOfMotion'].value
      const adaptiveNutGrapplerTopDeadCenterRotation = dParamWithUnits['adaptiveNutGrapplerTopDeadCenterRotation'].value
    
      const info = new SledGrapplerPlacementInfo(
        shaftOuterRadius,
        threadRadius,
        threadThickness,
        threadStarts,
        launcherMassDriverScrewRevolutionsPerSecond,
        launcherMassDriverForwardAcceleration,
        launcherMassDriver1InitialVelocity,
        initialDistance,
        distanceToSledAft,
        grapplerLength,
        numGrapplers,
        magnetThickness,
        betweenGrapplerFactor,
        shaftToGrapplerPad,
        additionalRotation,
        adaptiveNutGrapplerMaxRangeOfMotion,
        adaptiveNutGrapplerTopDeadCenterRotation,
        virtualAdaptiveNut.minMaxArray
      )
      info.generatePlacementInfo(grapplerDistance, 1)
    
      const sledGrapplerGeometry = new SledGrapplerGeometry(
        shaftOuterRadius,
        threadRadius,
        threadThickness,
        threadStarts,
        launcherMassDriverScrewRevolutionsPerSecond,
        launcherMassDriverForwardAcceleration,
        launcherMassDriver1InitialVelocity,
        initialDistance,
        distanceToSledAft,
        grapplerLength,
        numGrapplers,
        magnetThickness,
        betweenGrapplerFactor,
        shaftToGrapplerPad,
        additionalRotation,
        grapplerDistance,
        info.offset
      )
    
      const sledGrapplerMaterial = new THREE.MeshPhongMaterial({wireframe: false, color: 0x3f7f3f})
      //const sledGrapplerMaterial = new THREE.MeshStandardMaterial({map: massDriverScrewTexture})
      return new THREE.Mesh(sledGrapplerGeometry, sledGrapplerMaterial)
    }

    function decorateAndSave(object, myScene, unallocatedModelsList, objName, scaleFactorVector, n, perfOptimizedThreeJS) {
      object.scale.set(scaleFactorVector.x, scaleFactorVector.y, scaleFactorVector.z)
      object.visible = false
      object.name = objName
      object.traverse(child => {
        if (child.isMesh) child.castShadow = true
        // Template geometry is shared by every clone; per-model regenerated pad geometry is not.
        if (child.geometry) child.geometry.userData.shared = true
        if (child!==object) {
          child.name = objName+'_'+child.name
        }
      })
      object.updateMatrixWorld()
      for (let i=0; i<Math.max(1, n); i++) {  // at least one model: the pool's template
          const tempModel = object.clone()
          unallocatedModelsList.push(tempModel)
      }
    }

  }
  
}

// Shared grappler materials (they used to be re-created, and leaked, on every update()).
const grapplerEngagedMaterial = new THREE.MeshPhongMaterial({color: 0x00ff00})
const grapplerDisengagedMaterial = new THREE.MeshPhongMaterial({color: 0xff0000})
grapplerEngagedMaterial.userData.keep = true      // module-level: never disposed
grapplerDisengagedMaterial.userData.keep = true

// Grappler pad geometry is regenerated when the nut's speed has changed by this fraction since the
// geometry was built (the pads follow the thread pitch, which is proportional to speed).
const GRAPPLER_REGEN_RELATIVE_SPEED_STEP = 0.01

export class virtualAdaptiveNut extends MovingVirtualObject {

  static unallocatedModels = []
  static activeObjects = new Map()
  static className = 'virtualAdaptiveNuts'
  static modelsAreRecyleable = true
  static isDynamic = true
  static minMaxArray = [0, 0]

  static signatureOf(dParamWithUnits) {
    return parameterSignature(dParamWithUnits,
      ['adaptiveNut', 'launcherMassDriverScrew', 'launchSystem', 'launcherMassDriverForwardAcceleration', 'launcherMassDriver1InitialVelocity'],
      ['Offset', 'CameraRange', 'RoughLength', 'NumBrackets', 'Bracket', 'Material', 'Density', 'Cost'])
  }

  static isTeardownRequired(dParamWithUnits) {
    const newNumObjects = dParamWithUnits['showAdaptiveNuts'].value ? dParamWithUnits['numVirtualAdaptiveNuts'].value : 0
    return newNumObjects!==virtualAdaptiveNut.numObjects
  }

  static update(dParamWithUnits, launcherMassDriverLength) {
    const v = virtualAdaptiveNut
    const p = (name) => dParamWithUnits[name].value
    v.numObjects = p('showAdaptiveNuts') ? p('numVirtualAdaptiveNuts') : 0
    v.tInc = p('launchVehicleSpacingInSeconds')
    v.launcherMassDriverLength = launcherMassDriverLength
    v.adaptiveNutBodyLength = p('adaptiveNutBodyLength')
    v.adaptiveNutGrapplerLength = p('adaptiveNutGrapplerLength')
    v.sidewaysOffset = p('adaptiveNutSidewaysOffset')
    v.upwardsOffset = p('adaptiveNutUpwardsOffset')
    v.forwardsOffset = p('adaptiveNutForwardsOffset')
    v.forwardScaleFactor = p('launchSystemForwardScaleFactor')
    v.upwardScaleFactor = p('launchSystemUpwardScaleFactor')
    v.rightwardScaleFactor = p('launchSystemRightwardScaleFactor')
    v.isVisible = p('showAdaptiveNuts')
    v.slowDownPassageOfTime = p('launcherSlowDownPassageOfTime')
    v.launcherStartDelayInSeconds = p('launcherStartDelayInSeconds')
    v.adaptiveNutNumGrapplers = Math.max(0, Math.round(p('adaptiveNutNumGrapplers')))
    v.magnetThickness = p('adaptiveNutGrapplerMagnetThickness')
    v.betweenGrapplerFactor = p('adaptiveNutBetweenGrapplerFactor')
    v.shaftToGrapplerPad = p('adaptiveNutShaftToGrapplerPad')
    v.ballJointClearance = p('adaptiveNutGrapplerBallJointClearance')
    v.ballJointRadius = p('adaptiveNutGrapplerBallJointRadius')
    v.launcherMassDriverForwardAcceleration = p('launcherMassDriverForwardAcceleration')
    v.launcherMassDriver1InitialVelocity = p('launcherMassDriver1InitialVelocity')
    v.initialDistance = p('adaptiveNutBodyLength') / 2
    v.adaptiveNutGrapplerRangeFactor = p('adaptiveNutGrapplerRangeFactor')

    // Because the nut inferfaces with the screw, we need to obtains some screw parameters as well...
    v.screwRevolutionsPerSecond = p('launcherMassDriverScrewRevolutionsPerSecond')
    v.launcherMassDriverScrewShaftOuterRadius = p('launcherMassDriverScrewShaftOuterRadius')
    v.launcherMassDriverScrewShaftInnerRadius = p('launcherMassDriverScrewShaftInnerRadius')
    v.intraAnchorUpwardsSeparation = p('adaptiveNutIntraAnchorUpwardsSeparation')
    v.interAnchorUpwardsSeparation = p('adaptiveNutInterAnchorUpwardsSeparation')
    v.launcherMassDriverScrewThreadRadius = p('launcherMassDriverScrewThreadRadius')
    v.launcherMassDriverScrewThreadThickness = p('launcherMassDriverScrewThreadThickness')
    v.launcherMassDriverScrewThreadStarts = p('launcherMassDriverScrewThreadStarts')
    v.launcherMassDriverScrewSidewaysOffset = p('launcherMassDriverScrewSidewaysOffset')
    v.launcherMassDriverScrewUpwardsOffset = p('launcherMassDriverScrewUpwardsOffset')
    v.padLiftActuation = p('adaptiveNutGrapplerPadLiftAwayDistance')
    v.padLiftPortion = Math.max(1e-9, p('adaptiveNutGrapplerPadLiftAwayPortion'))
    const r1 = v.launcherMassDriverScrewThreadRadius
    const r2 = v.launcherMassDriverScrewShaftOuterRadius
    v.padRadialActuation = (r1 - r2) * (1 + p('adaptiveNutGrapplerClearanceFactor'))
    v.padTwistPortion = Math.max(1e-9, p('adaptiveNutGrapplerPadTwistPortion'))
    v.adaptiveNutWidth = p('adaptiveNutWidth')
    v.adaptiveNutGrapplerMaxRangeOfMotion = p('adaptiveNutGrapplerMaxRangeOfMotion')
    v.adaptiveNutGrapplerTopDeadCenterRotation = p('adaptiveNutGrapplerTopDeadCenterRotation')
    v.minMaxArray = [0, 0]

    v.isDynamic = true
    v.hasChanged = true
  }

  // Distance from the start of mass driver 1 to the back of the nut, `deltaT` after launch.
  static distanceAlongScrews(path, frame) {
    let massDriver1StartDistance = 0
    for (const superCurve of path.superCurves) {
      if (superCurve.name === 'massDriver1Curve') break
      massDriver1StartDistance += superCurve.getLength()
    }
    return frame.res.relevantCurveStartDistance + frame.distance - massDriver1StartDistance
  }

  frameAt(refFrame, deltaT) {
    const v = virtualAdaptiveNut
    const f = curveFrameAtTime(refFrame.curve, deltaT, false)
    const forward = f.forward
    const upward = f.upward
    const rightward = new THREE.Vector3().crossVectors(forward, upward)
    const orientation = quaternionFromFrame(forward, upward, MODEL_FORWARD, MODEL_UPWARD)
    const position = f.point.clone()
    // The body geometry spans y in [-forwardsOffset, bodyLength - forwardsOffset] and is then offset by
    // (sideways, forwards, upwards) inside the scaled model, so its centre is at y = bodyLength/2.
    const centre = position.clone()
      .addScaledVector(rightward, v.sidewaysOffset * v.rightwardScaleFactor)
      .addScaledVector(upward, v.upwardsOffset * v.upwardScaleFactor)
      .addScaledVector(forward, v.adaptiveNutBodyLength / 2 * v.forwardScaleFactor)
    return { f, position, centre, forward, upward, rightward, orientation }
  }

  placeAndOrientModel(om, refFrame) {
    const v = virtualAdaptiveNut
    om.visible = v.isVisible
    if (!v.isVisible) return
    const adjustedTimeSinceStart = v.adjustedTime(refFrame.timeSinceStart)
    const deltaT = Math.max(0, adjustedTimeSinceStart - this.timeLaunched)
    const frame = this.frameAt(refFrame, deltaT)
    const relevantCurve = frame.f.curve
    const distanceToSledAft = v.distanceAlongScrews(refFrame.curve, frame.f)

    om.position.copy(frame.position)
    om.quaternion.copy(frame.orientation)

    const acceleration = v.launcherMassDriverForwardAcceleration
    const initialVelocity = v.launcherMassDriver1InitialVelocity
    const initialDistance = v.initialDistance
    const adaptiveNutWidthDiv2 = v.adaptiveNutWidth / 2
    const screwRevolutionsPerSecond = v.screwRevolutionsPerSecond
    const threadRadius = v.launcherMassDriverScrewThreadRadius
    const threadStarts = tram.calculateThreadStarts(distanceToSledAft, v.launcherMassDriverScrewThreadStarts)
    const threadThickness = v.launcherMassDriverScrewThreadThickness
    const shaftOuterRadius = v.launcherMassDriverScrewShaftOuterRadius
    const upwardsOffsetToAnchors = v.launcherMassDriverScrewUpwardsOffset // Anchors' upward position will track the screws'
    const intraAnchorUpwardsSeparation = v.intraAnchorUpwardsSeparation
    const interAnchorUpwardsSeparation = v.interAnchorUpwardsSeparation
    const numGrapplers = v.adaptiveNutNumGrapplers
    const ballJointClearance = v.ballJointClearance
    const ballJointRadius = v.ballJointRadius
    const grapplersSidewaysOffset = v.launcherMassDriverScrewSidewaysOffset
    const grapplerUpwardsOffset = v.launcherMassDriverScrewUpwardsOffset
    const padCenterToEdge = (threadRadius - (shaftOuterRadius + v.shaftToGrapplerPad))/2

    // The screws turn with the launcher's global (adjusted) clock (see MassDriverScrew.js), so the
    // grapplers must use the same time origin. (They used the time since this nut was launched, which
    // only lined up with the thread when rps * spacing * threadStarts was a whole number.)
    const additionalRotation = (adjustedTimeSinceStart * screwRevolutionsPerSecond) % 1

    const bodyLength = v.adaptiveNutBodyLength
    const grapplerLength = v.adaptiveNutGrapplerLength
    const firstGrapplerDistance = (bodyLength-grapplerLength) / 2
    const grapplerSpacing = (numGrapplers > 0) ? grapplerLength / numGrapplers : 0

    const makeInfo = (distance, rotation) => new SledGrapplerPlacementInfo(
      shaftOuterRadius, threadRadius, threadThickness, threadStarts, screwRevolutionsPerSecond,
      acceleration, initialVelocity, initialDistance, distance, grapplerLength, numGrapplers,
      v.magnetThickness, v.betweenGrapplerFactor, v.shaftToGrapplerPad, rotation,
      v.adaptiveNutGrapplerMaxRangeOfMotion, v.adaptiveNutGrapplerTopDeadCenterRotation, v.minMaxArray)

    const info = makeInfo(distanceToSledAft, additionalRotation)
    const grapplerOffset = []
    const grapplerSwitchoverSignal = []
    const grapplerThreadPitch = []
    for (let i = 0, grapplerDistance = firstGrapplerDistance; i<numGrapplers; i++, grapplerDistance += grapplerSpacing) {
      info.generatePlacementInfo(grapplerDistance, v.adaptiveNutGrapplerRangeFactor)
      grapplerOffset[i] = info.offset
      grapplerSwitchoverSignal[i] = info.switchoverSignal
      grapplerThreadPitch[i] = info.threadPitch
    }

    // Regenerate the pad geometry deterministically: the key depends only on the nut's speed (a pure
    // function of time), and the geometry is built for the key's speed with zero phase (the phase is
    // applied by the per-frame rotations below). This replaces a wall-clock throttle that starved all
    // but one nut per frame and made renders depend on frame timing.
    const speed = Math.sqrt(Math.max(1, initialVelocity**2 + 2 * acceleration * Math.max(0, distanceToSledAft)))
    const regenKey = Math.floor(Math.log(speed) / GRAPPLER_REGEN_RELATIVE_SPEED_STEP) + ':' + threadStarts
    let grapplerGeometry = null
    if (om._grapplerKey !== regenKey) {
      const keySpeed = Math.exp(Math.floor(Math.log(speed) / GRAPPLER_REGEN_RELATIVE_SPEED_STEP) * GRAPPLER_REGEN_RELATIVE_SPEED_STEP)
      const keyDistance = (Math.abs(acceleration) > 1e-9) ? Math.max(0, (keySpeed**2 - initialVelocity**2) / (2 * acceleration)) : distanceToSledAft
      const geometryInfo = makeInfo(keyDistance, 0)
      grapplerGeometry = []
      for (let i = 0, grapplerDistance = firstGrapplerDistance; i<numGrapplers; i++, grapplerDistance += grapplerSpacing) {
        geometryInfo.generatePlacementInfo(grapplerDistance, v.adaptiveNutGrapplerRangeFactor)
        grapplerGeometry[i] = new SledGrapplerGeometry(
          shaftOuterRadius, threadRadius, threadThickness, threadStarts, screwRevolutionsPerSecond,
          acceleration, initialVelocity, initialDistance, keyDistance, grapplerLength, numGrapplers,
          v.magnetThickness, v.betweenGrapplerFactor, v.shaftToGrapplerPad, 0, grapplerDistance, geometryInfo.offset)
      }
      om._grapplerKey = regenKey
    }

    // Engage the grapplers only if we're on the part of the curve path that has the twin-screws
    const onScrews = (relevantCurve.name=='massDriver1Curve') || (relevantCurve.name=='massDriver2Curve')
    const replacedGeometries = new Set()

    // Model axes: x = rightward, y = forward, z = upward
    om.children.forEach(child => {
      if (child.name==='adaptiveNut_grappler') {
        const grapplerIndex = child.userData.index
        if (grapplerIndex >= numGrapplers) {
          child.visible = false
          return
        }
        const midwayRotation = child.userData.midwayRotation
        const offset = grapplerOffset[grapplerIndex]
        const switchoverSignal = onScrews ? grapplerSwitchoverSignal[grapplerIndex] : 1
        const threadPitch = grapplerThreadPitch[grapplerIndex]

        // The switchover signal pushes the grappler back towards the top dead center position. Its range is
        // divided into three parts: padLiftPortion moves the pad away from the screw face, padTwistPortion
        // moves it radially outwards, and the remainder moves it circumferentially back to top dead center.
        const padLiftActuation = Math.min(1, switchoverSignal/v.padLiftPortion) * v.padLiftActuation
        const padRadialActuation = Math.max(0, Math.min(1, switchoverSignal/v.padLiftPortion)) * v.padRadialActuation
        const padTwistActuation = Math.max(0, Math.min(1, (switchoverSignal-v.padLiftPortion)/v.padTwistPortion)) * Math.atan(threadPitch)
        const alreadyUsedPortion = v.padLiftPortion + v.padTwistPortion
        const remainingPortion = Math.max(1e-9, 1 - alreadyUsedPortion)
        const padThetaFactor = 1 - Math.max(0, Math.min(1, (switchoverSignal-alreadyUsedPortion)/remainingPortion))

        const grapplerScrewAngle = Math.atan(threadPitch)
        const padLiftActuationThetaComponent = padLiftActuation * Math.sin(grapplerScrewAngle)
        const padLiftActuationYComponent = padLiftActuation * Math.cos(grapplerScrewAngle)
        const rOffset = offset.r + padRadialActuation

        const rawTheta = offset.θ
        const midTheta = 2*Math.PI * midwayRotation
        const thetaOffset = ((rawTheta + 3*Math.PI) % (2*Math.PI) - Math.PI) * padThetaFactor + padLiftActuationThetaComponent
        const sinThetaOffset = Math.sin(thetaOffset + midTheta)
        const cosThetaOffset = Math.cos(thetaOffset + midTheta)
        const rOffsetPlus = rOffset + padCenterToEdge + ballJointClearance + ballJointRadius * 3
        const yOffset = offset.y - padLiftActuationYComponent

        // Point on the grappler at radius r from the screw axis, on the given side
        const padPoint = (target, leftRightSign, r) => target.set(
          leftRightSign*(grapplersSidewaysOffset + r * sinThetaOffset),
          yOffset,
          grapplerUpwardsOffset + r * cosThetaOffset)
        const anchorPoint = (target, leftRightSign, topBottomOffset, innerMiddleOuterSign2) => target.set(
          leftRightSign*adaptiveNutWidthDiv2,
          offset.y,
          upwardsOffsetToAnchors + topBottomOffset*intraAnchorUpwardsSeparation + topBottomOffset*innerMiddleOuterSign2*interAnchorUpwardsSeparation)
        const pointAlong = (component, from, to) => {
          component.position.copy(from)
          _dir.copy(to).sub(from).normalize()
          component.quaternion.setFromUnitVectors(_up, _dir)
        }

        child.visible = true
        child.children.forEach(grapplerComponent => {
          const ud = grapplerComponent.userData
          if (grapplerComponent.name==='adaptiveNut_grappler') {
            if (grapplerGeometry) {
              const old = grapplerComponent.geometry
              if (!old.userData?.shared && !replacedGeometries.has(old)) {
                replacedGeometries.add(old)
                old.dispose()
              }
              grapplerComponent.geometry = grapplerGeometry[grapplerIndex]
            }
            padPoint(grapplerComponent.position, ud.leftRightSign, rOffset)
            grapplerComponent.quaternion.identity()
            grapplerComponent.rotateY(ud.leftRightSign*thetaOffset + midTheta)
            grapplerComponent.rotateZ(-ud.leftRightSign*padTwistActuation)
            grapplerComponent.material = (switchoverSignal==0) ? grapplerDisengagedMaterial : grapplerEngagedMaterial
          }
          else if (grapplerComponent.name==='adaptiveNut_pivot') {
            padPoint(grapplerComponent.position, ud.leftRightSign, rOffsetPlus + ud.innerMiddleOuterSign1*ballJointRadius)
          }
          else if (grapplerComponent.name==='adaptiveNut_post') {
            // Post from the pad to the outer pivot
            padPoint(_p0, ud.leftRightSign, rOffset + padCenterToEdge)
            padPoint(_p1, ud.leftRightSign, rOffset + padCenterToEdge + ballJointClearance + ballJointRadius * 5)
            pointAlong(grapplerComponent, _p0, _p1)
          }
          else if (grapplerComponent.name==='adaptiveNut_strut') {  // Strut means the piston rod
            padPoint(_p0, ud.leftRightSign, rOffsetPlus + ud.innerMiddleOuterSign1*ballJointRadius)
            anchorPoint(_p1, ud.leftRightSign, ud.topBottomOffset, ud.innerMiddleOuterSign2)
            pointAlong(grapplerComponent, _p0, _p1)
          }
          else if (grapplerComponent.name==='adaptiveNut_cylinder') {  // The piston's cylinder
            anchorPoint(_p0, ud.leftRightSign, ud.topBottomOffset, ud.innerMiddleOuterSign2)
            padPoint(_p1, ud.leftRightSign, rOffsetPlus + ud.innerMiddleOuterSign1*ballJointRadius)
            pointAlong(grapplerComponent, _p0, _p1)
          }
        })
      }
      else {
        if ((child.name==='adaptiveNut_body') || (child.name==='adaptiveNut_bodyFromModel')) {
          child.position.set(v.sidewaysOffset, v.forwardsOffset, v.upwardsOffset)
          child.quaternion.identity()
        }
        child.visible = true
      }
    })
  }
}

const _p0 = new THREE.Vector3()
const _p1 = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
