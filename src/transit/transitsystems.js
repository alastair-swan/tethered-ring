// The tethered ring's transit system and ring hardware: transit vehicles, ring/ground terminuses,
// habitats, elevator cars and cables, the transit tube and tracks, solar arrays, and the stationary
// rings, moving rings and stator magnets.
//
// Two rendering strategies are used:
//  * Uniformly spaced identical segments (tube, tracks, solar arrays, stationary/moving rings,
//    stators, elevator cables) are drawn with instanced layers that write only the instances near
//    the camera each frame (see ../ring/RingInstancedLayer.js).
//  * Detailed models (vehicles, terminuses, habitats, elevator cars) are "virtual objects" stored
//    in the wedges of moving reference frames; models from a fixed-size ModelPool are attached to
//    them only while their wedge is near the camera. ObjectTracker discovers vehicles and elevator
//    cars through `refFrames[i].wedges[j]['virtualTransitVehicles' | 'virtualElevatorCars']`.
//
// Determinism: everything animate() does is a pure function of the parameters, timeSinceStart and
// the serializable animation state (getAnimationState/setAnimationState). Nothing depends on wall
// clock time, the number of frames rendered, or Math.random.
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { referenceFrame } from '../core/ReferenceFrame.js'
import { createSolarArrayLayer } from './SolarArray.js'
import { createTransitTubeLayer } from './TransitTubeSegment.js'
import { createTransitTrackLayers } from './TransitTrackSegment.js'
import { virtualTransitVehicle } from './TransitVehicle.js'
import { virtualRingTerminus } from './RingTerminus.js'
import { virtualGroundTerminus } from './GroundTerminus.js'
import { virtualElevatorCar } from './ElevatorCar.js'
import { virtualHabitat } from './Habitat.js'
import { ElevatorCableLayer } from './ElevatorCable.js'
import { createStationaryRingLayer } from '../ring/StationaryRingSegment.js'
import { createMovingRingLayer, movingRingTextureOffset } from '../ring/MovingRingSegment.js'
import { createStatorMagnetLayer } from '../ring/StatorMagnetSegment.js'
import { ModelPool } from './ModelPool.js'
import { AnimationChannel } from './AnimationChannel.js'
import { posFrac, seededRandom, transitStopLayout } from './VirtualRingObject.js'
import {
  elevatorPositionCalculator,
  vehicleReferenceFrameTrackPositionCalculator,
  generateHabitatMeshes,
} from './transitCalculators.js'

// Camera ranges (m) within which each kind of object is drawn.
const RANGE = {
  transitVehicles: 10000,
  facilities: 20000,      // terminuses, habitats, elevator cars, tracks, solar arrays, stationary rings
  movingRings: 1000,
  statorMagnets: 1000,
  longRange: 500000,      // transit tube and elevator cables
}

const LAYOUT_SEED = 0x7e7e5eed

const _cameraLocal = new THREE.Vector3()
const _pointOnRing = new THREE.Vector3()

function disposeObjectTree(object) {
  object.traverse(child => {
    if (child.geometry) child.geometry.dispose()
    if (child.material) {
      (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => m.dispose())
    }
  })
}

export class transitSystem {

  constructor(scene, dParamWithUnits, specs, genSpecs, crv, ecv, radiusOfPlanet, mainRingCurve) {
    this.scene = scene
    this.ecv = ecv
    this.mainRingCurve = mainRingCurve
    this.crv = crv
    this.ringSouthernMostPosition = 3/4 // Hack
    this.invalidateWedgeHistory = true

    this.pools = {
      transitVehicle: new ModelPool('transitVehicle', dParamWithUnits['transitVehicleNumModels'].value),
      ringTerminus: new ModelPool('ringTerminus', dParamWithUnits['ringTerminusNumModels'].value),
      groundTerminus: new ModelPool('groundTerminus', dParamWithUnits['groundTerminusNumModels'].value),
      elevatorCar: new ModelPool('elevatorCar', dParamWithUnits['elevatorCarNumModels'].value),
      habitat: new ModelPool('habitat', dParamWithUnits['habitatNumModels'].value),
    }

    this.channels = {
      transitVehicles: new AnimationChannel(dParamWithUnits['animateTransitVehicles'].value),
      elevatorCars: new AnimationChannel(dParamWithUnits['animateElevatorCars'].value),
      movingRings: new AnimationChannel(dParamWithUnits['animateMovingRingSegments'].value),
    }

    // The elevator profile main.js's follow-elevator camera should use: maps timeSinceStart to the
    // altitude of the rendered cars (including the elevator animation channel's pause/offset).
    const self = this
    this.elevatorPositionCalculator = {
      calculateElevatorPosition(timeSinceStart) {
        return self.elevatorPosCalc.calculateElevatorPosition(self.channels.elevatorCars.timeAt(timeSinceStart))
      },
      calculateElevatorSpeed(timeSinceStart) {
        return self.channels.elevatorCars.running ? self.elevatorPosCalc.calculateElevatorSpeed(self.channels.elevatorCars.timeAt(timeSinceStart)) : 0
      },
      get cycleTime() { return self.elevatorPosCalc.cycleTime },
    }

    this.layers = []
    this.movingRingLayer = null
    this.cableLayer = null
    this.vehicleLayoutKey = null
    this.facilityLayoutKey = null
    this.lastTimeSinceStart = 0
    this.createReferenceFrames(dParamWithUnits['transitSystemNumZones'].value, mainRingCurve)
    this.loadModels(dParamWithUnits, specs, genSpecs)
    this.update(dParamWithUnits, scene, specs, genSpecs, crv, radiusOfPlanet, mainRingCurve)
  }

  createReferenceFrames(numZones, mainRingCurve) {
    this.numZones = numZones
    const rf = (range, direction, trackIndex, name, objects) => {
      const frame = new referenceFrame(mainRingCurve, numZones, range, 0, direction, trackIndex, name)
      objects.forEach(o => frame.addVirtualObject(o))
      frame.initialize()
      frame.flags = new Uint8Array(numZones)
      return frame
    }
    const vehicles = ['virtualTransitVehicles']
    this.refFrames = [
      // Express lanes: vehicles cruise at a steady speed
      rf(RANGE.transitVehicles, 1, 1, 'transitVehiclesExpressClockwise', vehicles),
      rf(RANGE.transitVehicles, -1, 3, 'transitVehiclesExpressCounterClockwise', vehicles),
      // Collector lanes: vehicles stop at every transit stop
      rf(RANGE.transitVehicles, 1, 0, 'transitVehiclesCollectorClockwise', vehicles),
      rf(RANGE.transitVehicles, -1, 2, 'transitVehiclesCollectorCounterClockwise', vehicles),
      // Static frame for facilities
      rf(RANGE.facilities, 1, 1, 'staticMediumRangeRefFrame', ['virtualRingTerminuses', 'virtualGroundTerminuses', 'virtualHabitats', 'virtualElevatorCars']),
    ]
    this.vehicleLayoutKey = null
    this.facilityLayoutKey = null
  }

  loadModels(dParamWithUnits, specs, genSpecs) {
    const fbxloader = new FBXLoader()
    const prepare = (pool, objName, scaleFactor) => (object) => {
      if (objName == 'ringTerminus') {
        // Delete the tube and tracks from the model
        for (let i = 0; i<5; i++) {
          object.children[i].visible = false
        }
      }
      if (objName == 'habitat') {
        // Create the habitat, then using the transit terminus model as a starting point, delete everything except the connecting passageways, and add those the the habitat model.
        const tempHabitat = generateHabitatMeshes(dParamWithUnits, specs, genSpecs)
        for (let i = 5; i<=8; i++) tempHabitat.add(object.children[i].clone())
        for (let i = 13; i<=27; i++) tempHabitat.add(object.children[i].clone())
        tempHabitat.add(object.children[42].clone())
        object = tempHabitat
      }
      if (objName == 'groundTerminus') {
        object.children.forEach(child => {
          if (child.type == 'DirectionalLight') child.visible = false
        })
      }
      object.name = objName
      object.traverse(child => {
        if (child!==object) child.name = objName+'_'+child.name
      })
      object.scale.set(scaleFactor, scaleFactor, scaleFactor)
      object.updateMatrixWorld()
      pool.setTemplate(object)
      // The model engine may already be running: re-examine all visible wedges.
      this.invalidateWedgeHistory = true
    }
    const errorFunction = (error) => console.log('An error happened', error)
    const load = (show, file, pool, name, scale) => {
      if (dParamWithUnits[show].value) fbxloader.load(file, prepare(pool, name, scale), undefined, errorFunction)
    }
    load('showTransitVehicles', 'models/TransitCar.fbx', this.pools.transitVehicle, 'transitVehicle', 1)
    load('showRingTerminuses', 'models/RingTerminus.fbx', this.pools.ringTerminus, 'ringTerminus', 1.25)
    load('showGroundTerminuses', 'models/GroundTerminus.fbx', this.pools.groundTerminus, 'groundTerminus', 1.25)
    // The habitat borrows the RingTerminus model's passageways
    load('showHabitats', 'models/RingTerminus.fbx', this.pools.habitat, 'habitat', 1.25)
    load('showElevatorCars', 'models/Elevator.fbx', this.pools.elevatorCar, 'elevatorCar', 1.04)
  }

  // Called on every transit-related parameter change and after main.js rebuilds the ring (new
  // scene group, mainRingCurve and crv). Fully adopts the new curve, crv, parent and parameters.
  update(dParamWithUnits, scene, specs, genSpecs, crv, radiusOfPlanet, mainRingCurve /*, timeSinceStart */) {
    this.dParamWithUnits = dParamWithUnits
    this.specs = specs
    this.crv = crv
    this.radiusOfPlanet = radiusOfPlanet
    this.mainRingCurve = mainRingCurve

    // Return every model to its pool; the next animate() re-assigns and re-places them on the new ring.
    this.releaseAllModels()
    this.setParent(scene)

    const numZones = dParamWithUnits['transitSystemNumZones'].value
    if (numZones !== this.numZones) this.createReferenceFrames(numZones, mainRingCurve)
    this.refFrames.forEach(refFrame => refFrame.setCurve(mainRingCurve))
    this.invalidateWedgeHistory = true

    virtualTransitVehicle.update(dParamWithUnits, crv)
    virtualRingTerminus.update(dParamWithUnits, crv)
    virtualGroundTerminus.update(dParamWithUnits, crv)
    virtualElevatorCar.update(dParamWithUnits, crv)
    virtualHabitat.update(dParamWithUnits, crv)

    // Motion profiles
    if (this.ecv) {
      this.ecv.crv = crv
      this.ecv.dParamWithUnits = dParamWithUnits
      this.ecv.update()
    }
    this.elevatorPosCalc = new elevatorPositionCalculator(dParamWithUnits, crv, this.ecv)
    this.refFrameCalculator = new vehicleReferenceFrameTrackPositionCalculator(dParamWithUnits, mainRingCurve, crv)
    const tubeCircumference = this.refFrameCalculator.transitTubeCircumference
    const cruisingSpeed = dParamWithUnits['transitVehicleCruisingSpeed'].value
    const calc = this.refFrameCalculator
    const express = (t) => cruisingSpeed * t / tubeCircumference
    this.refFrames[0].positionFunction = (t) => posFrac(express(t))
    this.refFrames[1].positionFunction = (t) => posFrac(-express(t))
    this.refFrames[2].positionFunction = (t) => calc.calcTrackPosition(t)
    this.refFrames[3].positionFunction = (t) => posFrac(-calc.calcTrackPosition(t))
    this.refFrames[0].v = cruisingSpeed
    this.refFrames[1].v = cruisingSpeed

    const nt = dParamWithUnits['numVirtualRingTerminuses'].value
    const nh = dParamWithUnits['numVirtualHabitats'].value
    const layout = transitStopLayout(nt, nh)
    this.stopLayout = layout
    this.updateVehicleLayout(dParamWithUnits, layout.numStops)
    this.updateFacilityLayout(dParamWithUnits, layout)
    this.rebuildLayers(dParamWithUnits, crv, mainRingCurve, layout)

    // Moving ring speed: the physically computed value (tethers.js) when available.
    const physicalSpeed = specs && specs['movingRingsSpeed'] ? specs['movingRingsSpeed'].value : NaN
    this.movingRingsSpeed = (Number.isFinite(physicalSpeed) && physicalSpeed > 0) ? physicalSpeed : dParamWithUnits['movingRingsSpeedForRendering'].value
    this.movingRingsDirection = -1

    if (genSpecs) {
      // Populates the habitat entries in specs; the generated meshes are not needed.
      disposeObjectTree(generateHabitatMeshes(dParamWithUnits, specs, genSpecs))
    }
  }

  setParent(scene) {
    this.scene = scene
    Object.values(this.pools).forEach(pool => pool.setParent(scene))
    this.layers.forEach(layer => layer.setParent(scene))
    if (this.cableLayer) this.cableLayer.setParent(scene)
  }

  updateVehicleLayout(dParamWithUnits, numStops) {
    const show = dParamWithUnits['showTransitVehicles'].value
    const total = show ? dParamWithUnits['numVirtualTransitVehicles'].value : 0
    const randomize = !!dParamWithUnits['transitVehicleRandomizeStartPositions'].value
    const key = JSON.stringify([total, numStops, randomize])
    if (key === this.vehicleLayoutKey) return
    this.vehicleLayoutKey = key
    const lanes = this.refFrames.slice(0, 4)
    lanes.forEach(refFrame => refFrame.wedges.forEach(wedge => { wedge['virtualTransitVehicles'].length = 0 }))
    if (total <= 0) return
    const pool = this.pools.transitVehicle

    // Express lanes: evenly spaced, optionally jittered (deterministically).
    const n1 = Math.round(total / 40)
    lanes.slice(0, 2).forEach((refFrame, laneIndex) => {
      const rng = seededRandom(LAYOUT_SEED + laneIndex)
      const step = 1 / n1
      for (let i = 0; i < n1; i++) {
        const p = posFrac(i * step + (randomize ? 0.8 * step * rng() : 0))
        refFrame.wedges[refFrame.wedgeIndexFor(p)]['virtualTransitVehicles'].push(new virtualTransitVehicle(p, pool))
      }
    })

    // Collector lanes: vehicles sit on transit-stop positions so that they are at a stop whenever
    // the lane's frame is dwelling (see vehicleReferenceFrameTrackPositionCalculator).
    const n2 = Math.min(numStops, Math.round(total * 10 / 40))
    lanes.slice(2, 4).forEach((refFrame, laneIndex) => {
      let stops
      if (randomize) {
        const rng = seededRandom(LAYOUT_SEED + 2 + laneIndex)
        const all = new Int32Array(numStops).map((_, i) => i)
        for (let i = 0; i < n2; i++) {
          const j = i + Math.floor(rng() * (numStops - i))
          const tmp = all[i]; all[i] = all[j]; all[j] = tmp
        }
        stops = Array.from(all.subarray(0, n2)).sort((a, b) => a - b)
      }
      else {
        stops = Array.from({length: n2}, (_, i) => Math.floor(i * numStops / n2))
      }
      stops.forEach(stopIndex => {
        const p = stopIndex / numStops
        refFrame.wedges[refFrame.wedgeIndexFor(p)]['virtualTransitVehicles'].push(new virtualTransitVehicle(p, pool))
      })
    })
  }

  updateFacilityLayout(dParamWithUnits, layout) {
    const showRingTerminuses = dParamWithUnits['showRingTerminuses'].value
    const showHabitats = dParamWithUnits['showHabitats'].value
    const showElevatorCars = dParamWithUnits['showElevatorCars'].value
    const showGroundTerminuses = dParamWithUnits['showGroundTerminuses'].value
    const key = JSON.stringify([layout.numStops, layout.terminusPositions.length, showRingTerminuses, showHabitats, showElevatorCars, showGroundTerminuses])
    if (key === this.facilityLayoutKey) return
    this.facilityLayoutKey = key
    const refFrame = this.refFrames[4]
    refFrame.wedges.forEach(wedge => Object.values(wedge).forEach(list => { list.length = 0 }))
    const add = (name, p, object) => refFrame.wedges[refFrame.wedgeIndexFor(p)][name].push(object)
    layout.terminusPositions.forEach(p => {
      if (showRingTerminuses) add('virtualRingTerminuses', p, new virtualRingTerminus(p, this.pools.ringTerminus))
      if (showGroundTerminuses) add('virtualGroundTerminuses', p, new virtualGroundTerminus(p, this.pools.groundTerminus))
      if (showElevatorCars) add('virtualElevatorCars', p, new virtualElevatorCar(p, this.pools.elevatorCar))
    })
    if (showHabitats) layout.habitatPositions.forEach(p => add('virtualHabitats', p, new virtualHabitat(p, this.pools.habitat)))
  }

  rebuildLayers(dParamWithUnits, crv, mainRingCurve, layout) {
    this.disposeLayers()
    this.movingRingLayer = createMovingRingLayer(dParamWithUnits, crv, mainRingCurve, RANGE.movingRings)
    this.layers = [
      createStationaryRingLayer(dParamWithUnits, crv, mainRingCurve, RANGE.facilities),
      this.movingRingLayer,
      createStatorMagnetLayer(dParamWithUnits, crv, mainRingCurve, RANGE.statorMagnets),
      createTransitTubeLayer(dParamWithUnits, crv, mainRingCurve, layout.numStops, RANGE.longRange),
      ...createTransitTrackLayers(dParamWithUnits, crv, mainRingCurve, layout.numStops, RANGE.facilities),
      createSolarArrayLayer(dParamWithUnits, crv, RANGE.facilities),
    ].filter(layer => layer.mesh)
    if (!this.movingRingLayer.mesh) this.movingRingLayer = null
    this.cableLayer = new ElevatorCableLayer(dParamWithUnits, crv, layout.terminusPositions, RANGE.longRange)
    this.layers.forEach(layer => layer.setParent(this.scene))
    this.cableLayer.setParent(this.scene)
  }

  disposeLayers() {
    this.layers.forEach(layer => {
      if (layer.ownedMaterial) {
        if (layer.ownedMaterial.map) layer.ownedMaterial.map.dispose()
        layer.ownedMaterial.dispose()
      }
      layer.dispose()
    })
    this.layers = []
    this.movingRingLayer = null
    if (this.cableLayer) this.cableLayer.dispose()
    this.cableLayer = null
  }

  releaseAllModels() {
    this.refFrames.forEach(refFrame => {
      refFrame.wedges.forEach(wedge => {
        for (const name in wedge) {
          const list = wedge[name]
          for (let i = 0; i < list.length; i++) {
            const object = list[i]
            if (object.model) {
              object.pool.release(object.model)
              object.model = null
            }
          }
        }
      })
      refFrame.prevStartWedgeIndex = -1
      refFrame.prevFinishWedgeIndex = -1
    })
  }

  // Hides everything and returns all models to their pools. main.js calls this before rebuilding
  // the ring; the following update() recreates the virtual objects and layers.
  destroy(/* dParamWithUnits */) {
    this.releaseAllModels()
    this.refFrames.forEach(refFrame => refFrame.wedges.forEach(wedge => Object.values(wedge).forEach(list => { list.length = 0 })))
    this.vehicleLayoutKey = null
    this.facilityLayoutKey = null
    this.disposeLayers()
  }

  // Serializable animation state: restore it (together with the parameters and timeSinceStart) to
  // reproduce a shot exactly.
  getAnimationState() {
    const channels = {}
    Object.entries(this.channels).forEach(([name, channel]) => { channels[name] = channel.getState() })
    return { version: 1, channels }
  }

  setAnimationState(state) {
    if (!state || !state.channels) return
    Object.entries(state.channels).forEach(([name, channelState]) => {
      if (this.channels[name]) this.channels[name].setState(channelState)
    })
  }

  // Alternative discovery API for camera tracking.
  getTrackableObjects(type) {
    const name = (type === 'elevatorCar') ? 'virtualElevatorCars' : 'virtualTransitVehicles'
    const result = []
    this.refFrames.forEach(refFrame => refFrame.wedges.forEach(wedge => {
      if (!(name in wedge)) return
      wedge[name].forEach(object => result.push({
        object,
        refFrame,
        getPosition: (dt = 0) => object.getFuturePosition(refFrame, dt),
        getFrame: object.getFutureFrame ? (dt = 0) => object.getFutureFrame(refFrame, dt) : undefined,
      }))
    }))
    return result
  }

  animate(timeSinceStart, tetheredRingRefCoordSys, cameraPosition, mainRingCurve, dParamWithUnits) {
    const t = Number(Array.isArray(timeSinceStart) ? timeSinceStart[0] : timeSinceStart) || 0
    this.lastTimeSinceStart = t
    if (tetheredRingRefCoordSys && tetheredRingRefCoordSys !== this.scene) this.setParent(tetheredRingRefCoordSys)
    if (mainRingCurve && mainRingCurve !== this.mainRingCurve && !this.warnedStaleCurve) {
      console.warn('transitSystem.animate: mainRingCurve changed without update(); call update() after rebuilding the ring.')
      this.warnedStaleCurve = true
    }
    const curve = this.mainRingCurve
    const dParam = dParamWithUnits || this.dParamWithUnits

    // Animation channels (pausing freezes in place; resuming continues without a jump)
    this.channels.transitVehicles.setRunning(dParam['animateTransitVehicles'].value, t)
    this.channels.elevatorCars.setRunning(dParam['animateElevatorCars'].value, t)
    this.channels.movingRings.setRunning(dParam['animateMovingRingSegments'].value, t)
    const vehicleTime = this.channels.transitVehicles.timeAt(t)
    const elevatorTime = this.channels.elevatorCars.timeAt(t)
    const movingRingTime = this.channels.movingRings.timeAt(t)

    // Reference frame positions
    const vehicleRate = this.channels.transitVehicles.running ? 1 : 0
    for (let i = 0; i < 4; i++) {
      const refFrame = this.refFrames[i]
      refFrame.animationTime = vehicleTime
      refFrame.timeRate = vehicleRate
      refFrame.p = refFrame.positionFunction(vehicleTime)
    }
    const collectorSpeed = this.refFrameCalculator.calcTrackSpeed(vehicleTime)
    this.refFrames[2].v = collectorSpeed
    this.refFrames[3].v = collectorSpeed
    this.refFrames[4].p = 0

    // Elevators (all cars share one profile)
    const elevatorAltitude = this.elevatorPosCalc.calculateElevatorPosition(elevatorTime)
    virtualElevatorCar.animate(elevatorAltitude)
    virtualElevatorCar.calculator = this.elevatorPosCalc
    virtualElevatorCar.animationTime = elevatorTime
    virtualElevatorCar.timeRate = this.channels.elevatorCars.running ? 1 : 0

    // Moving rings: scroll the texture by the physical distance travelled
    if (this.movingRingLayer) {
      const map = this.movingRingLayer.mesh.material.map
      map.offset.y = movingRingTextureOffset(this.movingRingsSpeed * movingRingTime, this.movingRingLayer.texturePeriod, this.movingRingsDirection)
    }

    // Where is the camera relative to the ring? (assumes a near-circular ring, as before)
    _cameraLocal.copy(cameraPosition)
    this.scene.worldToLocal(_cameraLocal)
    const nearestTrackPosition = posFrac(Math.atan2(_cameraLocal.z, _cameraLocal.x) / (2*Math.PI))
    curve.getPoint(nearestTrackPosition, _pointOnRing)
    const distanceFromCameraToRing = _pointOnRing.distanceTo(_cameraLocal)
    this.nearestTrackPosition = nearestTrackPosition
    this.distanceFromCameraToRing = distanceFromCameraToRing

    this.layers.forEach(layer => layer.update(curve, nearestTrackPosition, distanceFromCameraToRing))
    if (this.cableLayer) this.cableLayer.update(curve, nearestTrackPosition, distanceFromCameraToRing)

    // Pooled models
    const ringCircumference = 2 * Math.PI * this.crv.mainRingRadius
    const invalidate = this.invalidateWedgeHistory
    this.invalidateWedgeHistory = false
    this.refFrames.forEach(refFrame => this.updateWedges(refFrame, nearestTrackPosition, distanceFromCameraToRing, ringCircumference, invalidate))
    Object.values(this.pools).forEach(pool => pool.reportShortage())
  }

  updateWedges(refFrame, nearestTrackPosition, distanceFromCameraToRing, ringCircumference, invalidate) {
    const numZones = refFrame.numZones
    const flags = refFrame.flags
    if (distanceFromCameraToRing <= refFrame.cameraRange) {
      const halfWidth = refFrame.cameraRange / ringCircumference
      if (halfWidth >= 0.5) {
        refFrame.startWedgeIndex = 0
        refFrame.finishWedgeIndex = numZones - 1
      }
      else {
        refFrame.startWedgeIndex = refFrame.wedgeIndexFor(nearestTrackPosition - halfWidth - refFrame.p)
        refFrame.finishWedgeIndex = refFrame.wedgeIndexFor(nearestTrackPosition + halfWidth - refFrame.p)
      }
    }
    else {
      refFrame.startWedgeIndex = -1
      refFrame.finishWedgeIndex = -1
    }
    if (invalidate) {
      refFrame.prevStartWedgeIndex = -1
      refFrame.prevFinishWedgeIndex = -1
    }

    const forEachWedge = (start, finish, fn) => {
      if (start < 0) return
      for (let z = start; ; z = (z + 1) % numZones) {
        fn(z)
        if (z === finish) break
      }
    }
    forEachWedge(refFrame.startWedgeIndex, refFrame.finishWedgeIndex, z => { flags[z] |= 1 })
    forEachWedge(refFrame.prevStartWedgeIndex, refFrame.prevFinishWedgeIndex, z => { flags[z] |= 2 })

    // Release models in wedges that left the camera's range
    forEachWedge(refFrame.prevStartWedgeIndex, refFrame.prevFinishWedgeIndex, z => {
      if (flags[z] !== 2) return
      const wedge = refFrame.wedges[z]
      for (const name in wedge) {
        const list = wedge[name]
        for (let i = 0; i < list.length; i++) {
          const object = list[i]
          if (object.model) {
            object.pool.release(object.model)
            object.model = null
          }
        }
      }
    })

    // Assign models in wedges that entered; re-place dynamic objects in all visible wedges
    forEachWedge(refFrame.startWedgeIndex, refFrame.finishWedgeIndex, z => {
      const entered = (flags[z] & 2) === 0
      const wedge = refFrame.wedges[z]
      for (const name in wedge) {
        const list = wedge[name]
        if (list.length === 0) continue
        const isDynamic = list[0].constructor.isDynamic
        for (let i = 0; i < list.length; i++) {
          const object = list[i]
          if (!object.model && entered) {
            object.model = object.pool.acquire()
            if (object.model) {
              object.placeAndOrientModel(object.model, refFrame)
              continue
            }
          }
          if (object.model && isDynamic) object.placeAndOrientModel(object.model, refFrame)
        }
      }
    })

    forEachWedge(refFrame.startWedgeIndex, refFrame.finishWedgeIndex, z => { flags[z] = 0 })
    forEachWedge(refFrame.prevStartWedgeIndex, refFrame.prevFinishWedgeIndex, z => { flags[z] = 0 })
    refFrame.prevStartWedgeIndex = refFrame.startWedgeIndex
    refFrame.prevFinishWedgeIndex = refFrame.finishWedgeIndex
  }
}
