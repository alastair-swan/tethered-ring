import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { SledGrapplerPlacementInfo, SledGrapplerGeometry } from './SledGrapplerGeometry.js'
import * as tram from '../utils/tram.js'
import { quaternionFromFrame } from '../curves/SuperCurves.js'
import { MovingVirtualObject, curveFrameAtTime, parameterSignature } from './VirtualObject.js'
import { PixelLOD } from '../scene/PixelLOD.js'

const MODEL_FORWARD = new THREE.Vector3(0, 1, 0) // The direction that the model considers "forward"
const MODEL_UPWARD = new THREE.Vector3(0, 0, 1)  // The direction that the model considers "upward"

// Grappler hardware per grappler slot: for each of the two (top/bottom) grappler rows, each side
// (left/right) has three (inner/middle/outer) ball-joint pivots, posts, piston rods (struts) and
// piston cylinders. All of it is drawn as one BatchedMesh per nut; the pads are a second one.
const GRAPPLER_ROWS = [0.5, 0] // midwayRotation for the top and bottom rows
const SIDES = [-1, 1]          // leftRightSign
const INNER_MIDDLE_OUTER = [
  { sign1: -2, sign2: -2 },  // inner
  { sign1: 0.5, sign2: -1 }, // middle
  { sign1: 2, sign2: 2 },    // outer
]
const HARDWARE_PARTS = ['pivot', 'post', 'strut', 'cylinder']
// Pixel-size LOD thresholds, measured on the nut's width.
const PADS_MIN_PIXELS = 6       // pads are ~1 px across here
const HARDWARE_MIN_PIXELS = 60  // ball joints and pistons are a few cm: ~2 px across here

// Returns a copy of `geometry` mirrored in x, with the triangle winding reversed so that front faces
// stay front faces (batched instances cannot use negative scale for mirroring).
function mirrorGeometryX(geometry) {
  const mirrored = geometry.clone()
  mirrored.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1))
  if (mirrored.index) {
    const index = mirrored.index.array
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t
    }
    mirrored.index.needsUpdate = true
  }
  else {
    for (const attribute of Object.values(mirrored.attributes)) {
      const a = attribute.array, size = attribute.itemSize
      for (let v = 0; v < attribute.count; v += 3) {
        for (let k = 0; k < size; k++) {
          const t = a[(v + 1) * size + k]; a[(v + 1) * size + k] = a[(v + 2) * size + k]; a[(v + 2) * size + k] = t
        }
      }
      attribute.needsUpdate = true
    }
  }
  return mirrored
}

export class adaptiveNutModel {
  constructor(dParamWithUnits, myScene, unallocatedModelsList) {
    const p = (name) => dParamWithUnits[name].value
    const width = p('adaptiveNutWidth')
    const height = p('adaptiveNutHeight')
    const bodyLength = p('adaptiveNutBodyLength')
    const grapplerLength = p('adaptiveNutGrapplerLength')
    const forwardsOffset = p('adaptiveNutForwardsOffset')
    const numGrapplers = Math.max(0, Math.round(p('adaptiveNutNumGrapplers')))
    const ballJointClearance = p('adaptiveNutGrapplerBallJointClearance')
    const ballJointRadius = p('adaptiveNutGrapplerBallJointRadius')
    const cylinderRadius = p('adaptiveNutGrapplerCylinderRadius')
    const scaleFactor = new THREE.Vector3(p('launchSystemRightwardScaleFactor'), p('launchSystemForwardScaleFactor'), p('launchSystemUpwardScaleFactor'))

    // Shared by every pooled nut (y-axis is forward, z-axis is up).
    const bodyGeometry = new THREE.BoxGeometry(width, bodyLength, height, 1, 1, 1)
    bodyGeometry.translate(0, bodyLength/2 - forwardsOffset, 0)
    bodyGeometry.userData.shared = true
    const bodyMaterial = new THREE.MeshPhongMaterial({color: 0x7f6f7f})
    const hardwareMaterial = new THREE.MeshPhongMaterial({color: 0x7f3f00})
    // Pad colour comes from per-instance colours (engaged green / disengaged red).
    const padMaterial = new THREE.MeshPhongMaterial({color: 0xffffff})

    const postLength = .02 + ballJointClearance + ballJointRadius*5 // +2 cm so there is no gap between pad and post
    // ToDo: compute the strut length properly (the 1.25 factor makes it a little longer than the gap).
    const strutLength = (p('launcherMassDriverScrewSidewaysOffset') + p('launcherMassDriverScrewThreadRadius') * 1.25 - width / 2) / 2
    const hardwareGeometries = {
      pivot: new THREE.SphereGeometry(ballJointRadius, 16, 8),
      post: new THREE.CylinderGeometry(ballJointRadius/2, ballJointRadius/2, postLength, 16, 1).translate(0, postLength/2, 0),
      strut: new THREE.CylinderGeometry(cylinderRadius/2, cylinderRadius/2, strutLength, 16, 1).translate(0, strutLength/2, 0),
      cylinder: new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, strutLength, 16, 1).translate(0, strutLength/2, 0),
    }
    // BatchedMesh needs matching attributes on every geometry.
    for (const g of Object.values(hardwareGeometries)) g.deleteAttribute('uv')

    // Pad geometry for each grappler at the start of the screws (regenerated per speed while running).
    const templatePads = []
    {
      const info = makeGrapplerPlacementInfo(dParamWithUnits, 0, grapplerLength, numGrapplers, 0)
      const firstGrapplerDistance = (bodyLength-grapplerLength) / 2
      for (let i = 0; i < numGrapplers; i++) {
        const distance = firstGrapplerDistance + i * grapplerLength / numGrapplers
        info.generatePlacementInfo(distance, 1)
        templatePads.push(makeGrapplerGeometry(dParamWithUnits, 0, grapplerLength, numGrapplers, distance, info.offset))
      }
    }

    let loadedBody = null
    const buildModel = () => {
      const nut = new THREE.Group()
      nut.name = 'adaptiveNut'
      const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
      body.name = 'adaptiveNut_body'
      body.castShadow = true
      nut.add(body)
      if (loadedBody) nut.add(loadedBody.clone())

      // Pads: geometry i is grappler i, geometry numGrapplers + i its mirror image.
      const padVertices = templatePads.reduce((n, g) => n + g.attributes.position.count, 0) * 2
      const padIndices = templatePads.reduce((n, g) => n + (g.index ? g.index.count : 0), 0) * 2
      const pads = new THREE.BatchedMesh(numGrapplers * GRAPPLER_ROWS.length * SIDES.length, Math.max(1, padVertices), Math.max(1, padIndices), padMaterial)
      pads.name = 'adaptiveNut_grappler'
      pads.castShadow = true
      // The batch's own bounding sphere is computed once (with every instance at the origin) and never
      // refreshed, so whole-object culling would hide it; BatchedMesh still culls per instance.
      pads.frustumCulled = false
      pads.padGeometryIds = []
      for (let i = 0; i < numGrapplers; i++) pads.padGeometryIds[i] = pads.addGeometry(templatePads[i])
      for (let i = 0; i < numGrapplers; i++) pads.padGeometryIds[numGrapplers + i] = pads.addGeometry(mirrorGeometryX(templatePads[i]))
      pads.instanceIds = []
      for (let i = 0; i < numGrapplers; i++) {
        for (let row = 0; row < GRAPPLER_ROWS.length; row++) {
          for (let s = 0; s < SIDES.length; s++) {
            // The right-hand pads (side +1) are the mirrored ones.
            const geometryId = pads.padGeometryIds[(SIDES[s] > 0 ? numGrapplers : 0) + i]
            pads.instanceIds.push(pads.addInstance(geometryId))
          }
        }
      }

      const hardware = new THREE.BatchedMesh(numGrapplers * GRAPPLER_ROWS.length * SIDES.length * INNER_MIDDLE_OUTER.length * HARDWARE_PARTS.length,
        Object.values(hardwareGeometries).reduce((n, g) => n + g.attributes.position.count, 0),
        Object.values(hardwareGeometries).reduce((n, g) => n + g.index.count, 0), hardwareMaterial)
      hardware.name = 'adaptiveNut_hardware'
      hardware.castShadow = true
      hardware.frustumCulled = false
      const partIds = Object.fromEntries(HARDWARE_PARTS.map(part => [part, hardware.addGeometry(hardwareGeometries[part])]))
      hardware.instanceIds = []
      for (let k = 0; k < numGrapplers * GRAPPLER_ROWS.length * SIDES.length * INNER_MIDDLE_OUTER.length; k++) {
        for (const part of HARDWARE_PARTS) hardware.instanceIds.push(hardware.addInstance(partIds[part]))
      }

      // Pixel-size LODs measured on the nut's width; extent covers the nut's length.
      const padsLod = new PixelLOD(width, { extent: bodyLength })
      padsLod.name = 'adaptiveNut_padsLod'
      padsLod.addLevel(PADS_MIN_PIXELS, pads)
      const hardwareLod = new PixelLOD(width, { extent: bodyLength })
      hardwareLod.name = 'adaptiveNut_hardwareLod'
      hardwareLod.addLevel(HARDWARE_MIN_PIXELS, hardware)
      nut.add(padsLod, hardwareLod)
      nut.grappler = { pads, hardware, padsLod, hardwareLod, numGrapplers, key: null }

      nut.scale.copy(scaleFactor)
      nut.visible = false
      return nut
    }

    virtualAdaptiveNut.createPooledModel = buildModel
    const count = Math.max(1, p('adaptiveNutNumModels')) // at least one model: the pool's template
    for (let i = 0; i < count; i++) unallocatedModelsList.push(buildModel())

    // Higher-detail body from a model file, added to every nut (pooled or in the scene) once loaded.
    new OBJLoader().load('models/AdaptiveNut.obj', (object) => {
      object.children[0].scale.set(0.6, 1, 1.5)  // the source model is too wide and thin
      object.children[0].position.set(0, 0, 0)
      object.scale.set(0.001, 0.001*1.62, 0.001)  // mm -> m
      object.name = 'adaptiveNut_bodyFromModel'
      object.traverse(child => { if (child.isMesh) child.castShadow = true })
      object.children[0].material.color.setHex(0x2f1f50)
      loadedBody = object
      const nuts = new Set(unallocatedModelsList)
      myScene.traverse(child => { if (child.name === 'adaptiveNut' && child.grappler) nuts.add(child) })
      nuts.forEach(nut => nut.add(object.clone()))
    }, undefined, () => console.log('Error loading adaptive nut model'))
  }
}

function makeGrapplerPlacementInfo(dParamWithUnits, distanceToSledAft, grapplerLength, numGrapplers, additionalRotation) {
  const p = (name) => dParamWithUnits[name].value
  return new SledGrapplerPlacementInfo(
    p('launcherMassDriverScrewShaftOuterRadius'), p('launcherMassDriverScrewThreadRadius'), p('launcherMassDriverScrewThreadThickness'),
    p('launcherMassDriverScrewThreadStarts'), p('launcherMassDriverScrewRevolutionsPerSecond'), p('launcherMassDriverForwardAcceleration'),
    p('launcherMassDriver1InitialVelocity'), p('adaptiveNutBodyLength') / 2, distanceToSledAft, grapplerLength, numGrapplers,
    p('adaptiveNutGrapplerMagnetThickness'), p('adaptiveNutBetweenGrapplerFactor'), p('adaptiveNutShaftToGrapplerPad'), additionalRotation,
    p('adaptiveNutGrapplerMaxRangeOfMotion'), p('adaptiveNutGrapplerTopDeadCenterRotation'), virtualAdaptiveNut.minMaxArray)
}

function makeGrapplerGeometry(dParamWithUnits, distanceToSledAft, grapplerLength, numGrapplers, grapplerDistance, offset) {
  const p = (name) => dParamWithUnits[name].value
  return new SledGrapplerGeometry(
    p('launcherMassDriverScrewShaftOuterRadius'), p('launcherMassDriverScrewThreadRadius'), p('launcherMassDriverScrewThreadThickness'),
    p('launcherMassDriverScrewThreadStarts'), p('launcherMassDriverScrewRevolutionsPerSecond'), p('launcherMassDriverForwardAcceleration'),
    p('launcherMassDriver1InitialVelocity'), p('adaptiveNutBodyLength') / 2, distanceToSledAft, grapplerLength, numGrapplers,
    p('adaptiveNutGrapplerMagnetThickness'), p('adaptiveNutBetweenGrapplerFactor'), p('adaptiveNutShaftToGrapplerPad'), 0, grapplerDistance, offset)
}

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

    const g = om.grappler
    for (const child of om.children) {
      if ((child.name==='adaptiveNut_body') || (child.name==='adaptiveNut_bodyFromModel')) {
        child.position.set(v.sidewaysOffset, v.forwardsOffset, v.upwardsOffset)
        child.quaternion.identity()
      }
    }
    // Skip the grappler work when the LODs (from last frame's on-screen size) would not draw it, with
    // a 2x margin so parts are already posed when they appear. While recording, always pose them.
    const recording = PixelLOD.buildBudget === Infinity
    const padsWanted = recording || g.padsLod.onScreenPixels >= PADS_MIN_PIXELS / 2
    const hardwareWanted = recording || g.hardwareLod.onScreenPixels >= HARDWARE_MIN_PIXELS / 2
    if (!padsWanted && !hardwareWanted) return
    const activeGrapplers = Math.min(numGrapplers, g.numGrapplers)

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
    // applied by the per-frame rotations below).
    const speed = Math.sqrt(Math.max(1, initialVelocity**2 + 2 * acceleration * Math.max(0, distanceToSledAft)))
    const regenKey = Math.floor(Math.log(speed) / GRAPPLER_REGEN_RELATIVE_SPEED_STEP) + ':' + threadStarts
    if (padsWanted && g.key !== regenKey) {
      const keySpeed = Math.exp(Math.floor(Math.log(speed) / GRAPPLER_REGEN_RELATIVE_SPEED_STEP) * GRAPPLER_REGEN_RELATIVE_SPEED_STEP)
      const keyDistance = (Math.abs(acceleration) > 1e-9) ? Math.max(0, (keySpeed**2 - initialVelocity**2) / (2 * acceleration)) : distanceToSledAft
      const geometryInfo = makeInfo(keyDistance, 0)
      for (let i = 0, grapplerDistance = firstGrapplerDistance; i<activeGrapplers; i++, grapplerDistance += grapplerSpacing) {
        geometryInfo.generatePlacementInfo(grapplerDistance, v.adaptiveNutGrapplerRangeFactor)
        const geometry = new SledGrapplerGeometry(
          shaftOuterRadius, threadRadius, threadThickness, threadStarts, screwRevolutionsPerSecond,
          acceleration, initialVelocity, initialDistance, keyDistance, grapplerLength, numGrapplers,
          v.magnetThickness, v.betweenGrapplerFactor, v.shaftToGrapplerPad, 0, grapplerDistance, geometryInfo.offset)
        const mirrored = mirrorGeometryX(geometry)
        // setGeometryAt copies the data into the batch's buffers.
        g.pads.setGeometryAt(g.pads.padGeometryIds[i], geometry)
        g.pads.setGeometryAt(g.pads.padGeometryIds[g.numGrapplers + i], mirrored)
        geometry.dispose()
        mirrored.dispose()
      }
      g.key = regenKey
    }

    // Engage the grapplers only if we're on the part of the curve path that has the twin-screws
    const onScrews = (relevantCurve.name=='massDriver1Curve') || (relevantCurve.name=='massDriver2Curve')

    // Model axes: x = rightward, y = forward, z = upward
    let padInstance = 0
    let hardwareInstance = 0
    for (let grapplerIndex = 0; grapplerIndex < g.numGrapplers; grapplerIndex++) {
      const active = grapplerIndex < activeGrapplers
      let offset, switchoverSignal, threadPitch
      let padLiftActuation, padRadialActuation, padTwistActuation, padThetaFactor, padLiftActuationThetaComponent, padLiftActuationYComponent
      if (active) {
        offset = grapplerOffset[grapplerIndex]
        switchoverSignal = onScrews ? grapplerSwitchoverSignal[grapplerIndex] : 1
        threadPitch = grapplerThreadPitch[grapplerIndex]
        // The switchover signal pushes the grappler back towards the top dead center position. Its range is
        // divided into three parts: padLiftPortion moves the pad away from the screw face, padTwistPortion
        // moves it radially outwards, and the remainder moves it circumferentially back to top dead center.
        padLiftActuation = Math.min(1, switchoverSignal/v.padLiftPortion) * v.padLiftActuation
        padRadialActuation = Math.max(0, Math.min(1, switchoverSignal/v.padLiftPortion)) * v.padRadialActuation
        padTwistActuation = Math.max(0, Math.min(1, (switchoverSignal-v.padLiftPortion)/v.padTwistPortion)) * Math.atan(threadPitch)
        const alreadyUsedPortion = v.padLiftPortion + v.padTwistPortion
        const remainingPortion = Math.max(1e-9, 1 - alreadyUsedPortion)
        padThetaFactor = 1 - Math.max(0, Math.min(1, (switchoverSignal-alreadyUsedPortion)/remainingPortion))
        const grapplerScrewAngle = Math.atan(threadPitch)
        padLiftActuationThetaComponent = padLiftActuation * Math.sin(grapplerScrewAngle)
        padLiftActuationYComponent = padLiftActuation * Math.cos(grapplerScrewAngle)
      }
      for (const midwayRotation of GRAPPLER_ROWS) {
        const topBottomOffset = (midwayRotation === 0.5) ? -1 : 1
        let rOffset, rOffsetPlus, yOffset, thetaOffset, sinThetaOffset, cosThetaOffset, midTheta
        if (active) {
          rOffset = offset.r + padRadialActuation
          midTheta = 2*Math.PI * midwayRotation
          thetaOffset = ((offset.θ + 3*Math.PI) % (2*Math.PI) - Math.PI) * padThetaFactor + padLiftActuationThetaComponent
          sinThetaOffset = Math.sin(thetaOffset + midTheta)
          cosThetaOffset = Math.cos(thetaOffset + midTheta)
          rOffsetPlus = rOffset + padCenterToEdge + ballJointClearance + ballJointRadius * 3
          yOffset = offset.y - padLiftActuationYComponent
        }
        // Point on the grappler at radius r from the screw axis, on the given side
        const padPoint = (target, leftRightSign, r) => target.set(
          leftRightSign*(grapplersSidewaysOffset + r * sinThetaOffset),
          yOffset,
          grapplerUpwardsOffset + r * cosThetaOffset)
        const anchorPoint = (target, leftRightSign, innerMiddleOuterSign2) => target.set(
          leftRightSign*adaptiveNutWidthDiv2,
          offset.y,
          upwardsOffsetToAnchors + topBottomOffset*intraAnchorUpwardsSeparation + topBottomOffset*innerMiddleOuterSign2*interAnchorUpwardsSeparation)

        for (const leftRightSign of SIDES) {
          // Pad
          const padId = g.pads.instanceIds[padInstance++]
          g.pads.setVisibleAt(padId, active)
          if (active && padsWanted) {
            _object.position.copy(padPoint(_p0, leftRightSign, rOffset))
            _object.quaternion.identity()
            _object.rotateY(leftRightSign*thetaOffset + midTheta)
            _object.rotateZ(-leftRightSign*padTwistActuation)
            _object.updateMatrix()
            g.pads.setMatrixAt(padId, _object.matrix)
            g.pads.setColorAt(padId, (switchoverSignal==0) ? _disengagedColor : _engagedColor)
          }
          // Ball joints, posts, piston rods and cylinders
          for (let io = 0; io < INNER_MIDDLE_OUTER.length; io++) {
            const { sign1, sign2 } = INNER_MIDDLE_OUTER[io]
            const ids = g.hardware.instanceIds
            const pivotId = ids[hardwareInstance++], postId = ids[hardwareInstance++], strutId = ids[hardwareInstance++], cylinderId = ids[hardwareInstance++]
            g.hardware.setVisibleAt(pivotId, active)
            g.hardware.setVisibleAt(postId, active && io === 0) // the post is the same for all three joints
            g.hardware.setVisibleAt(strutId, active)
            g.hardware.setVisibleAt(cylinderId, active)
            if (!active || !hardwareWanted) continue
            const jointRadius = rOffsetPlus + sign1*ballJointRadius
            g.hardware.setMatrixAt(pivotId, _matrix.makeTranslation(padPoint(_p0, leftRightSign, jointRadius)))
            if (io === 0) {
              padPoint(_p0, leftRightSign, rOffset + padCenterToEdge)
              padPoint(_p1, leftRightSign, rOffset + padCenterToEdge + ballJointClearance + ballJointRadius * 5)
              g.hardware.setMatrixAt(postId, pointAlongMatrix(_p0, _p1))
            }
            padPoint(_p0, leftRightSign, jointRadius)
            anchorPoint(_p1, leftRightSign, sign2)
            g.hardware.setMatrixAt(strutId, pointAlongMatrix(_p0, _p1))      // piston rod: joint -> anchor
            g.hardware.setMatrixAt(cylinderId, pointAlongMatrix(_p1, _p0))   // piston cylinder: anchor -> joint
          }
        }
      }
    }
  }
}

// Matrix that places a +y-pointing part at `from`, aimed at `to`.
function pointAlongMatrix(from, to) {
  _dir.copy(to).sub(from).normalize()
  _quaternion.setFromUnitVectors(_up, _dir)
  return _matrix.compose(from, _quaternion, _unitScale)
}

const _object = new THREE.Object3D()
const _matrix = new THREE.Matrix4()
const _quaternion = new THREE.Quaternion()
const _unitScale = new THREE.Vector3(1, 1, 1)
const _engagedColor = new THREE.Color(0x00ff00)
const _disengagedColor = new THREE.Color(0xff0000)

const _p0 = new THREE.Vector3()
const _p1 = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
