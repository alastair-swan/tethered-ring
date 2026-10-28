// Elevator and transit-vehicle motion profiles, habitat sizing and transit specs.
import * as THREE from 'three'
import * as tram from '../utils/tram.js'
import { airDensityAtAltitude } from '../physics/planets.js'
import { offset_r, offset_y } from '../ring/ringGeometry.js'

export class elevatorCableVariables {
  constructor() {}
  update() {
    this.massRingSideTerminus = 0
    this.massElevatorCar = 0
    this.massElevatorCable = 0
    this.massAeronauticStabilizer = 0
    this.numAeronauticStabilizers = 4
    this.AdditionalTensioningForce = 0
    this.totalStaticLoad = 0 
  }
}
  
export class elevatorCarVariables {
  constructor(planetSpec, dParamWithUnits, crv) {
    this.gravitationalConstant = planetSpec.gravitationalConstant
    this.massOfPlanet = planetSpec.massOfPlanet
    this.radiusOfPlanet = planetSpec.ellipsoid.a
    this.dParamWithUnits = dParamWithUnits
    this.crv = crv
    this.update()
  }
  update() {
    // Not verified yet!!!
    this.waitTime = 30 // seconds - a bit short for people to disembark/embark but will suffice for now
    this.energyRequirementPerKg = (this.gravitationalConstant * 1 * this.massOfPlanet) * (1/this.radiusOfPlanet - 1/(this.radiusOfPlanet+this.crv.currentMainRingAltitude))
    this.batterySpecificEnergy = 265 // Wh/kg
    this.driveSystemEfficiency = 0.8
    this.batteryMassPerKg = this.energyRequirementPerKg / (this.batterySpecificEnergy * 3600 * this.driveSystemEfficiency)
    // The car travels between its docked position at the ring terminus and at the ground terminus.
    // In the elevator's altitude coordinate these are currentMainRingAltitude and groundTerminusUpwardOffset.
    this.travelDistance = Math.max(0, this.crv.currentMainRingAltitude - this.dParamWithUnits['groundTerminusUpwardOffset'].value)
    this.maxAccelleration = this.dParamWithUnits['elevatorCarMaxAcceleration'].value
    this.maxSpeed = this.dParamWithUnits['elevatorCarMaxSpeed'].value
    const move = new TrapezoidalMove(this.travelDistance, this.maxSpeed, this.maxAccelleration)
    this.accellerationTime = move.accelerationTime
    this.accellerationDistance = move.accelerationDistance
    this.peakSpeed = move.peakSpeed
    this.steadySpeedDistance = move.cruiseDistance
    this.steadySpeedTime = move.cruiseTime
    this.totalTravelTime = move.duration
  }
}

// Point-to-point move with a trapezoidal (or, for short moves, triangular) speed profile.
// Position and speed are continuous; acceleration is piecewise constant (+a, 0, -a).
// A non-positive speed or acceleration limit means the move never happens (duration Infinity,
// distance stays 0), which avoids the Infinity/NaN positions the old profile produced.
export class TrapezoidalMove {
  constructor(distance, maxSpeed, maxAcceleration) {
    this.distance = Math.max(0, distance)
    this.feasible = (maxSpeed > 0) && (maxAcceleration > 0) && Number.isFinite(maxSpeed) && Number.isFinite(maxAcceleration)
    if (!this.feasible || this.distance === 0) {
      this.accelerationTime = 0
      this.accelerationDistance = 0
      this.peakSpeed = 0
      this.cruiseDistance = 0
      this.cruiseTime = 0
      this.acceleration = 0
      this.duration = (this.distance === 0) ? 0 : Infinity
      return
    }
    this.acceleration = maxAcceleration
    let ta = maxSpeed / maxAcceleration
    if (maxAcceleration * ta * ta > this.distance) {
      // Cannot reach maxSpeed: triangular profile
      ta = Math.sqrt(this.distance / maxAcceleration)
    }
    this.accelerationTime = ta
    this.peakSpeed = maxAcceleration * ta
    this.accelerationDistance = 0.5 * maxAcceleration * ta * ta
    this.cruiseDistance = Math.max(0, this.distance - 2 * this.accelerationDistance)
    this.cruiseTime = this.cruiseDistance / this.peakSpeed
    this.duration = 2 * ta + this.cruiseTime
  }

  // Distance covered t seconds after the start of the move (clamped to [0, distance]).
  distanceAt(t) {
    if (!this.feasible || t <= 0) return 0
    if (t >= this.duration) return this.distance
    const a = this.acceleration
    const ta = this.accelerationTime
    if (t < ta) return 0.5 * a * t * t
    if (t < ta + this.cruiseTime) return this.accelerationDistance + this.peakSpeed * (t - ta)
    const tr = this.duration - t
    return this.distance - 0.5 * a * tr * tr
  }

  speedAt(t) {
    if (!this.feasible || t <= 0 || t >= this.duration) return 0
    const ta = this.accelerationTime
    if (t < ta) return this.acceleration * t
    if (t < ta + this.cruiseTime) return this.peakSpeed
    return this.acceleration * (this.duration - t)
  }
}

function positiveModulo(x, m) {
  return x - Math.floor(x / m) * m
}

// Elevator car altitude as a pure function of the elevator animation time t (seconds).
// Cycle: dwell at the top (ring terminus), descend, dwell at the bottom (ground terminus), ascend.
// The returned "altitude" is currentMainRingAltitude at the top and groundTerminusUpwardOffset at
// the bottom, matching the coordinate used to place the cars and the follow-elevator camera.
export class elevatorPositionCalculator {
  constructor(dParamWithUnits, crv, ecv) {
    this.topAltitude = crv.currentMainRingAltitude
    this.bottomAltitude = dParamWithUnits['groundTerminusUpwardOffset'].value
    this.waitTime = (ecv && Number.isFinite(ecv.waitTime)) ? ecv.waitTime : 30
    this.move = new TrapezoidalMove(this.topAltitude - this.bottomAltitude, dParamWithUnits['elevatorCarMaxSpeed'].value, dParamWithUnits['elevatorCarMaxAcceleration'].value)
    this.travelTime = this.move.duration
    this.cycleTime = Number.isFinite(this.travelTime) ? 2 * (this.waitTime + this.travelTime) : Infinity
    // Kept for callers that add a phase shift; the transit system applies its own animation time instead.
    this.timeOffset = 0
  }

  // Returns [altitude, verticalSpeed] at time t.
  stateAt(t) {
    if (!Number.isFinite(this.cycleTime)) return [this.topAltitude, 0]
    const tc = positiveModulo(t + this.timeOffset, this.cycleTime)
    const w = this.waitTime
    const T = this.travelTime
    if (tc < w) return [this.topAltitude, 0]
    if (tc < w + T) return [this.topAltitude - this.move.distanceAt(tc - w), -this.move.speedAt(tc - w)]
    if (tc < 2 * w + T) return [this.bottomAltitude, 0]
    return [this.bottomAltitude + this.move.distanceAt(tc - 2 * w - T), this.move.speedAt(tc - 2 * w - T)]
  }

  calculateElevatorPosition(t) {
    return this.stateAt(t)[0]
  }

  calculateElevatorSpeed(t) {
    return this.stateAt(t)[1]
  }
}

// Length of a closed path offset from the main ring curve by (outwardOffset, upwardOffset).
export function offsetRingPathLength(mainRingCurve, crv, outwardOffset, upwardOffset, samples = 8192) {
  const dr = offset_r(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
  const dy = offset_y(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
  const P = new THREE.Vector3()
  const prevP = new THREE.Vector3()
  let l = 0
  for (let i = 0; i <= samples; i++) {
    const trackPosition = i / samples
    const angle = 2 * Math.PI * trackPosition   // (the old code used cos(trackPosition) with a 0..1 fraction)
    mainRingCurve.getPoint(trackPosition, P)
    P.x += dr * Math.cos(angle)
    P.y += dy
    P.z += dr * Math.sin(angle)
    if (i > 0) l += prevP.distanceTo(P)
    prevP.copy(P)
  }
  return l
}

// Position of the collector-lane reference frame as a function of the transit animation time.
// Every cycle the frame dwells for transitVehicleStopDuration, then moves exactly k transit-stop
// spacings using a trapezoidal profile (accelerate, cruise at transitVehicleCruisingSpeed, brake).
// k is the smallest whole number of stops that leaves room to reach cruising speed and to cruise
// for 2*transitVehicleMergeTime. Vehicles are placed on transit-stop positions, so every vehicle
// is at a stop whenever the frame is dwelling.
// Limitation (flagged): all collector-lane vehicles in a lane stop and start at the same moment.
export class vehicleReferenceFrameTrackPositionCalculator {
  constructor(dParamWithUnits, mainRingCurve, crv) {
    const nt = dParamWithUnits['numVirtualRingTerminuses'].value
    const nh = dParamWithUnits['numVirtualHabitats'].value
    this.numStops = Math.max(1, nt + nh)
    this.transitTubeCircumference = offsetRingPathLength(mainRingCurve, crv, dParamWithUnits['transitTubeOutwardOffset'].value, dParamWithUnits['transitTubeUpwardOffset'].value)
    this.stopSpacing = this.transitTubeCircumference / this.numStops
    const v = dParamWithUnits['transitVehicleCruisingSpeed'].value
    const a = dParamWithUnits['transitVehicleMaxAcceleration'].value
    const mergeTime = dParamWithUnits['transitVehicleMergeTime'].value
    this.stopDuration = Math.max(0, dParamWithUnits['transitVehicleStopDuration'].value)
    const minDistance = (a > 0) ? v * v / a + 2 * mergeTime * v : 0
    this.stopsPerCycle = Math.max(1, Math.ceil(minDistance / this.stopSpacing - 1e-9))
    this.cycleDistance = this.stopsPerCycle * this.stopSpacing
    this.move = new TrapezoidalMove(this.cycleDistance, v, a)
    this.moving = this.move.feasible
    this.cycleTime = this.stopDuration + this.move.duration
  }

  // Returns the frame position as a fraction of the ring.
  calcTrackPosition(t) {
    if (!this.moving || !(this.cycleTime > 0)) return 0
    const n = Math.floor(t / this.cycleTime)
    const tWithinCycle = t - n * this.cycleTime
    const d = this.move.distanceAt(tWithinCycle - this.stopDuration)
    // Whole stops travelled so far, reduced modulo numStops in integer arithmetic to keep precision.
    const wholeStops = positiveModulo(positiveModulo(n, this.numStops) * this.stopsPerCycle, this.numStops)
    return positiveModulo((wholeStops + d / this.stopSpacing) / this.numStops, 1)
  }

  // Returns the frame speed in m/s (non-negative).
  calcTrackSpeed(t) {
    if (!this.moving || !(this.cycleTime > 0)) return 0
    const tWithinCycle = positiveModulo(t, this.cycleTime)
    return this.move.speedAt(tWithinCycle - this.stopDuration)
  }
}

export function getTransitVehiclePosition(dParamWithUnits, crv, ecv, t) {
  return t*1100   // m/s
}

export function habitatDesign(dParamWithUnits, specs, genSpecs, habitatFloorspace, numFloors, floorToCeilingSpacing, floorThickness) {
  // Assums that within the habitat's "bubble", there is a "roof level" and "basement level" that are not included in the habitat floorspace.
  // Roof can be used for plants, and as a garden. Basement can be used for equipment and storage.
  // Floorspace is only included when it extends from floor to ceiling, so some floorspace near the bubble wall may not qualify.  
  let h = []

  // Create an array containing the heights of all the floors and ceilings (that is, the vertical coordinate for the top and bottom of each partion)
  for (let i = 0; i<=numFloors; i++) {
    const j = numFloors / 2 - Math.floor(i/2)
    const k = (numFloors+1) / 2 - Math.floor((i+1)/2)
    h[i] = j * floorToCeilingSpacing + k * floorThickness
    h[numFloors*2 + 1 - i] = -h[i]
  }

  // The following code should work for 1 to 4 floors inclusive...
  // habitatFloorspace = (2 * (habitatBubbleInnerRadius**2 - h[1]**2) + 2 * (habitatBubbleInnerRadius**2 - h[3]**2)) * Math.PI 
  // habitatFloorspace = (2 * habitatBubbleInnerRadius**2 + 2 * habitatBubbleInnerRadius**2 - 2 * h[1]**2 - 1 * h[3]**2) * Math.PI 
  // habitatFloorspace = (numFloors * habitatBubbleInnerRadius**2 - 2 * h[1]**2 - 2 * h[3]**2) * Math.PI 
  // habitatFloorspace / Math.PI = numFloors * habitatBubbleInnerRadius**2 - 2 * h[1]**2 - 2 * h[3]**2 
  // (habitatFloorspace / Math.PI + 2 * h[1]**2 + 2 * h[3]**2) = numFloors * habitatBubbleInnerRadius**2 
  // (habitatFloorspace / Math.PI + 2 * h[1]**2 + 2 * h[3]**2) / numFloors = habitatBubbleInnerRadius**2 
  const n1 = Math.floor(numFloors / 2)
  const n2 = numFloors - n1
  const habitatBubbleInnerRadius = Math.sqrt((habitatFloorspace / Math.PI + n1 * h[1]**2 + n2 * h[3]**2) / numFloors )

  if (genSpecs) {
    const habitatBubbleInteriorVolume = 4 / 3 * Math.PI * habitatBubbleInnerRadius**3
    const habitatBubbleMaterialTensileStrength = dParamWithUnits['habitatBubbleMaterialTensileStrength'].value * 1000000
    const habitatBubbleMaterialDensity = dParamWithUnits['habitatBubbleMaterialDensity'].value
    const habitatBubbleMaterialEngineeringFactor = dParamWithUnits['habitatBubbleMaterialEngineeringFactor'].value
    const habitatBubbleMaterialCost = dParamWithUnits['habitatBubbleMaterialCost'].value
    const altitude = dParamWithUnits['ringFinalAltitude'].value
    const airDensityAtAltitude = tram.airDensityAtAltitude(altitude)
    const idealGasConstant = dParamWithUnits['idealGasConstant'].value
    const temperatureAtAltitue = 272  // K
    const airPressureAtRingAltitude = idealGasConstant * airDensityAtAltitude * temperatureAtAltitue
    const habitatAirPressure = dParamWithUnits['habitatAirPressure'].value
    const habitatAirPressureDifference = habitatAirPressure - airPressureAtRingAltitude
    const habitatAirPressureStress = habitatAirPressureDifference * Math.PI * habitatBubbleInnerRadius**2
    // Math.PI * ((habitatBubbleInnerRadius+habitatBubbleThickness)**2 - habitatBubbleInnerRadius**2) * habitatBubbleMaterialTensileStrength / habitatBubbleMaterialEngineeringFactor = Math.PI * (habitatAirPressure * habitatBubbleInnerRadius**2 - airPressureAtRingAltitude * (habitatBubbleInnerRadius+habitatBubbleThickness)**2)
    // ((habitatBubbleInnerRadius+habitatBubbleThickness)**2 - habitatBubbleInnerRadius**2) * habitatBubbleMaterialTensileStrength / habitatBubbleMaterialEngineeringFactor = (habitatAirPressure * habitatBubbleInnerRadius**2 - airPressureAtRingAltitude * (habitatBubbleInnerRadius+habitatBubbleThickness)**2)
    // ((ir+t)**2 - ir**2) * TS / EF = Pinside * ir**2 - Poutside * (ir+t)**2
    // (ir**2 + 2*ir*t + t**2 - ir**2) * TS / EF = Pinside * ir**2 - Poutside * (ir**2 + 2*ir*t + t**2)
    // (2*ir*t + t**2) * TS / EF                 = Pinside * ir**2 - Poutside*ir**2 - 2*Poutside*ir*t - Poutside*t**2
    // 0 = (Pinside - Poutside) * ir**2 + (-2*ir*TS/EF - 2*Poutside*ir)*t + (-TS/EF - Poutside)*t**2
    // c = (Pinside - Poutside) * ir**2
    // b = -2*ir*TS/EF - 2*Poutside*ir
    // a = -TS/EF - Poutside
    const a = -habitatBubbleMaterialTensileStrength/habitatBubbleMaterialEngineeringFactor - airPressureAtRingAltitude
    const b = -2*habitatBubbleInnerRadius*habitatBubbleMaterialTensileStrength/habitatBubbleMaterialEngineeringFactor - 2*airPressureAtRingAltitude*habitatBubbleInnerRadius
    const c = (habitatAirPressure - airPressureAtRingAltitude) * habitatBubbleInnerRadius**2
    const result = tram.solveQuadratic(a, b, c)
    const habitatBubbleThickness = Math.max(result[0], result[1])
    const habitatBubbleWallVolume = Math.PI * 4 / 3 * ((habitatBubbleInnerRadius + habitatBubbleThickness)**3 - habitatBubbleInnerRadius**3)
    const habitatBubbleMass = habitatBubbleWallVolume * habitatBubbleMaterialDensity
    const habitatBubbleCost = habitatBubbleMass * habitatBubbleMaterialCost
    let capitalCostPerKgSupported
    if (capitalCostPerKgSupported in specs) {
      capitalCostPerKgSupported = specs['capitalCostPerKgSupported'].value
    }
    else {
      console.log("Error: Value not yet calculated. Assuming 100.")
      capitalCostPerKgSupported = 100
    }
    const habitatBubbleCostWithLiftCost = habitatBubbleCost + capitalCostPerKgSupported * habitatBubbleMass
    const habitatBubbleCostPerSquareMeter = habitatBubbleCostWithLiftCost / habitatFloorspace

    // Used for checking math...
    const habitatBubbleMaterialTensileStress = habitatAirPressureStress / (Math.PI * 2 * habitatBubbleInnerRadius * habitatBubbleThickness) 

    specs['habitatBubbleInnerRadius'] = {value: habitatBubbleInnerRadius, units: "m"}
    specs['habitatBubbleThickness'] = {value: habitatBubbleThickness, units: "m"}
    specs['habitatFloorspace'] = {value: habitatFloorspace, units: "m2"}
    specs['habitatBubbleInteriorVolume'] = {value: habitatBubbleInteriorVolume, units: "m3"}
    specs['habitatAirPressureDifference'] = {value: habitatAirPressureDifference, units: "m"}
    specs['habitatBubbleMaterialEngineeringFactor'] = {value: habitatBubbleMaterialEngineeringFactor, units: "m"}
    specs['habitatBubbleMaterialTensileStress'] = {value: habitatBubbleMaterialTensileStress, units: "m"}
    specs['airPressureAtRingAltitude'] = {value: airPressureAtRingAltitude, units: "m"}
    specs['habitatAirPressure'] = {value: habitatAirPressure, units: "m"}
    specs['habitatBubbleMass'] = {value: habitatBubbleMass, units: "m"}
    specs['habitatBubbleCost'] = {value: habitatBubbleCost, units: "m"}
    specs['habitatBubbleCostWithLiftCost'] = {value: habitatBubbleCostWithLiftCost, units: "m"}
    specs['habitatBubbleCostPerSquareMeter'] = {value: habitatBubbleCostPerSquareMeter, units: "m"}
  }

  const habitatDesignParameters = {
    'numFloors': numFloors,
    'floorToCeilingSpacing': floorToCeilingSpacing,
    'floorThickness': floorThickness,
    'habitatBubbleInnerRadius': habitatBubbleInnerRadius,
    'heightArray': h,
  }
  return habitatDesignParameters
}

export function generateHabitatMeshes(dParamWithUnits, specs, genSpecs) {
  const habitatFloorspace = 325  // m2
  const numFloors = 2
  const floorToCeilingSpacing = 3.15 // m
  const floorThickness = 0.2 // m
  const habitatDesignParameters = habitatDesign(dParamWithUnits, specs, genSpecs, habitatFloorspace, numFloors, floorToCeilingSpacing, floorThickness)
  //console.log(habitatDesignParameters)

  const habitatMeshes = new THREE.Group()
  // Add a sphere
  const habitatBubbleGeometry = new THREE.SphereGeometry(habitatDesignParameters['habitatBubbleInnerRadius'], 64, 32)
  const habitatBubbleMaterial = new THREE.MeshPhongMaterial({
    //roughness: 1,
    //metalness: 0,
    // blending: THREE.CustomBlending,
    // blendEquation: THREE.AddEquation, //default
    // blendSrc: THREE.SrcAlphaFactor, //default
    // blendDst: THREE.OneMinusSrcAlphaFactor, //default
    //blendSrcAlpha: 0.1,
    color: 0x302070,
    transparent: true,
    opacity: 0.5
  })
  const tempBubbleMesh = new THREE.Mesh(habitatBubbleGeometry, habitatBubbleMaterial)
  tempBubbleMesh.name = "habitatBubble"
  tempBubbleMesh.position.set(dParamWithUnits['habitatOutwardOffset'].value, dParamWithUnits['habitatUpwardOffset'].value, dParamWithUnits['habitatForwardOffset'].value)
  habitatMeshes.add(tempBubbleMesh)

  const stairwellGeometry = new THREE.CylinderGeometry(1, 1, 1.2 * habitatDesignParameters['habitatBubbleInnerRadius'], 32, 1, true, 0, Math.PI * 1.8)
  const stairwellMaterial = new THREE.MeshLambertMaterial({color: 0xc0c0c0, transparent: false})
  stairwellMaterial.side = THREE.DoubleSide
  const tempStairwellMesh = new THREE.Mesh(stairwellGeometry, stairwellMaterial)
  tempStairwellMesh.rotation.y = Math.PI * 1.1
  tempStairwellMesh.name = "stairwell"
  tempStairwellMesh.position.set(dParamWithUnits['habitatOutwardOffset'].value, dParamWithUnits['habitatUpwardOffset'].value, dParamWithUnits['habitatForwardOffset'].value)
  habitatMeshes.add(tempStairwellMesh)

  // Add tapered cylinders for each floor
  const floorMaterial = new THREE.MeshLambertMaterial({color: 0x878681, transparent: false})
  const ir = habitatDesignParameters['habitatBubbleInnerRadius']
  const h = habitatDesignParameters['heightArray']
  //console.log(h, ir, h.length)
  let floorSpace = 0
  for (let i = 0; i<h.length; i+=2) {
    const r0 = Math.sqrt(ir**2 - h[i+0]**2)
    const r1 = Math.sqrt(ir**2 - h[i+1]**2)
    //console.log(r0, r1)
    const floorGeometry = new THREE.CylinderGeometry(r0, r1, floorThickness, 32, 1)
    const tempFloorMesh = new THREE.Mesh(floorGeometry, floorMaterial)
    tempFloorMesh.position.set(dParamWithUnits['habitatOutwardOffset'].value, dParamWithUnits['habitatUpwardOffset'].value + (h[i+0] + h[i+1]) / 2, dParamWithUnits['habitatForwardOffset'].value)
    tempFloorMesh.name = 'floor' + (h.length/2 - i/2)
    tempFloorMesh.userData = {'upwardOffset': (h[i+0] + h[i+1]) / 2}
    habitatMeshes.add(tempFloorMesh)
    if (i>0) floorSpace += Math.PI * r0**2
  }
  //console.log(floorSpace)
  return habitatMeshes
}

export function updateTransitSystemSpecs(dParamWithUnits, crv, specs) {
  const metersPerKilometer = 1000
  const ringCircumference = crv.mainRingRadius * 2 * Math.PI
  const secondsPerYear = 3600 * 24 * 365
  const amortizationPeriod = 20
  //const secondsOfTimeOverAmortizationPeriod = secondsPerYear * amortizationPeriod
  const absoluteTemperatureInsideTransitTube = 273.3 + 100 // ˚K  (We're assuming here that the transit vehicles heat up the hydrogen in the tube to around 100˚C - ToDo: This is a wild-assed-guess)
  const absoluteTemperatureOutsideTransitTube = 273.3 - 40 // ˚K
  const molarMassOfAir = 0.02897 // kg/mol
  
  const capitalCostPerKgSupported = (specs.hasOwnProperty('capitalCostPerKgSupported')) ? specs['capitalCostPerKgSupported'].value: dParamWithUnits['defaultcapitalCostPerKgSupported'].value
  const operatingCostPerKgUniformStaticMassSupported = 0 // ToDo: Need to calculate this!!  = specs['operatingCostPerKgUniformStaticMassSupported'].value
  const operatingCostOfAeronaticThruster = 7.1e-7 //  USD/(N·s)
  const transitTubeTubeRadius = dParamWithUnits['transitTubeTubeRadius'].value
  const transitTubeTubeWallThickness = dParamWithUnits['transitTubeTubeWallThickness'].value
  const transitTubeTubeWallMaterialDensity = dParamWithUnits['transitTubeTubeWallMaterialDensity'].value // Todo - Random guess for something like mylar
  const transitTubeTubeSurfaceArea = 2 * Math.PI * transitTubeTubeRadius * ringCircumference
  const transitTubeTubeInteriorVolumePerMeter = Math.PI * (transitTubeTubeRadius - transitTubeTubeWallThickness)**2
  const transitTubeTubeInteriorVolume = transitTubeTubeInteriorVolumePerMeter * ringCircumference
  const transitTubeTubeWallVolumePerMeter = Math.PI * (transitTubeTubeRadius**2 - (transitTubeTubeRadius - transitTubeTubeWallThickness)**2)
  const transitTubeTubeWallVolume  = transitTubeTubeWallVolumePerMeter * ringCircumference
  const transitTubeTubeWallMassPerMeter = transitTubeTubeWallVolumePerMeter * transitTubeTubeWallMaterialDensity
  const transitTubeTubeWallMass = transitTubeTubeWallMassPerMeter * ringCircumference
  const transitTubeTubeWallMaterialCost = dParamWithUnits['transitTubeTubeWallMaterialCost'].value // USD/kg  // Vinal Resin 

  const transitTubeMassPerMeter = transitTubeTubeWallMassPerMeter + 0 // Add rails, stringers, etc. 
  const pressure = 3546 // Pa    ToDo - This needs to be a function of altitude
  const idealGasConstant = 8.31446261815324 // m3⋅Pa⋅K−1⋅mol−1
  const densityOfAir = pressure * molarMassOfAir / idealGasConstant / absoluteTemperatureOutsideTransitTube
  const overPressureFactor = 1.02

  let lightGasMolarMass
  let lightGasCostPerKg
  let lightGasMoleculeMass
  const lightGas = 'hydrogen'
  switch (lightGas) {
    case 'hydrogen':
      lightGasMolarMass = 0.002016 // kg/mol
      lightGasMoleculeMass = 3.32e-27 // kg
      lightGasCostPerKg = dParamWithUnits['liquidHydrogenCostPerKg'].value
      break
    case 'helium':
      lightGasMolarMass = 0.004 // kg/mol
      lightGasMoleculeMass = 6.6423e-27 // kg
      lightGasCostPerKg = dParamWithUnits['liquidHeliumCostPerKg'].value
      break
  }
  const lightGasDensity = pressure * overPressureFactor * lightGasMolarMass / idealGasConstant / absoluteTemperatureInsideTransitTube

  const buoyancyOfHydrogenInTubePerMeter = Math.PI * transitTubeTubeRadius**2 * (densityOfAir-lightGasDensity) // kg/m
  //console.log('buoyancyOfHydrogenInTubePerMeter', buoyancyOfHydrogenInTubePerMeter)
  specs['buoyancyOfHydrogenInTubePerMeter'] = {value: buoyancyOfHydrogenInTubePerMeter, units: 'kg/m'}

  const transitTerminusMassPerMeter = 30 // kg/m

  //console.log('transitTubeMassPerMeter', transitTubeMassPerMeter)
  let transitSystemUniformStaticMass = (transitTubeMassPerMeter - buoyancyOfHydrogenInTubePerMeter + transitTerminusMassPerMeter) * ringCircumference
  // Need to add the mass of the rails, brackets, and stringers...
  // Still need to add the masses of the elevators and terminuses...
  
  // Capital cost of supportting tubes
  // Operating cost of supportting tubes
  // Capital cost of supporting the aeronautic stabilizers
  // Operating cost of supporting the dynamic loads

  // Availible passenger kilometers and revenue passenger kilometers per year calculation
  const transitVehicleCruisingSpeed = dParamWithUnits['transitVehicleCruisingSpeed'].value
  const transitVehicleRadius = dParamWithUnits['transitVehicleRadius'].value
  const transitVehicleCrossSectionalArea = Math.PI * transitVehicleRadius**2
  const transitVehicleCoefficientOfDrag = dParamWithUnits['transitVehicleCoefficientOfDrag'].value
  const transitSystemEfficiencyAtCruisingSpeed = dParamWithUnits['transitSystemEfficiencyAtCruisingSpeed'].value

  const numExpressTracks = 2
  const minimumVehicleSpacing = 500 //m (just considering the express lanes)
  const maximumPassengersPerVehicle = 8
  const maxPassengersPerMeterOfRing = maximumPassengersPerVehicle * numExpressTracks / minimumVehicleSpacing
  const totalVehiclesInExpressLanes = ringCircumference * numExpressTracks / minimumVehicleSpacing
  // Need to account for the fact that the ring transit system doesn't take the most direct route
  const indirectRouteFactor = Math.sqrt(2) / (Math.PI/2) // Assumes that the average trip is one quarter of the way around the ring
  const availablePassengerKilometersPerYear = ringCircumference * indirectRouteFactor * maxPassengersPerMeterOfRing * transitVehicleCruisingSpeed * secondsPerYear / metersPerKilometer
  // ToDo: Add the number of passenger kilometers contributed by the collector lanes
  //console.log('availablePassengerKilometersPerYear', availablePassengerKilometersPerYear/1e9, 'B')
  specs['availablePassengerKilometersPerYear'] = {value: availablePassengerKilometersPerYear, units: 'km/year'}

  const numPassengersInTransitSystem = ringCircumference * maxPassengersPerMeterOfRing
  //console.log('numPassengersInTransitSystem', numPassengersInTransitSystem/1e6, 'M people')
  specs['numPassengersInTransitSystem'] = {value: numPassengersInTransitSystem, units: 'people'}
  // ToDo: Need to figure out if the elevators can keep up with this many passengers
  const totalAvailableMarket = 2e11 // revenue passenger km/year

  const revenuePassengerKilometersPerYear = Math.min(availablePassengerKilometersPerYear * 0.25, totalAvailableMarket)

  // ToDo: Check that this doesn't exeed the total availible market 

  const gamma = 7/5 // = 1.400 for diatomic gases (https://en.wikipedia.org/wiki/Speed_of_sound)
  const boltzmannConstant = 1.38e-23 // J/˚K
  const speedOfSoundInTube = Math.sqrt(gamma * boltzmannConstant * absoluteTemperatureInsideTransitTube / lightGasMoleculeMass)
  //console.log('speedOfSoundInTube', speedOfSoundInTube, 'm/s')
  specs['speedOfSoundInTube'] = {value: speedOfSoundInTube, units: 'm/s'}
  const speedOfSoundInTubeInKPH = speedOfSoundInTube * 3.6
  //console.log('speedOfSoundInTubeInKPH', speedOfSoundInTubeInKPH, 'm/s')
  specs['speedOfSoundInTubeInKPH'] = {value: speedOfSoundInTubeInKPH, units: 'm/s'}


  const lightGasLeakageRate = 0 // ToDo: Need to calculate this!!
  const ringTerminusCost = dParamWithUnits['ringTerminusCost'].value
  const elevatorCableCost = dParamWithUnits['elevatorCableCost'].value
  const elevatorCarCost = dParamWithUnits['elevatorCarCost'].value
  const groundTerminusCost = dParamWithUnits['groundTerminusCost'].value
  const numElevatorCables = dParamWithUnits['numElevatorCables'].value
  const costOfRingTerminuses = ringTerminusCost * numElevatorCables
  const costOfElevatorCables = elevatorCableCost * numElevatorCables
  const costOfElevatorCars = elevatorCarCost * numElevatorCables
  const costOfGroundTerminuses = groundTerminusCost * numElevatorCables

  //const averageVehicleSpacing = 500 //m (just considering the express lanes)
  //const averagePassengersPerVehicle = 16

  // transitTubeTubeSurfaceArea
  // transitTubeTubeInteriorVolume
  // transitTubeWallVolume

  let capitalCostOfTransitSystem = 0
  capitalCostOfTransitSystem += capitalCostPerKgSupported * transitSystemUniformStaticMass
  capitalCostOfTransitSystem += transitTubeTubeWallMass * transitTubeTubeWallMaterialCost
  capitalCostOfTransitSystem += transitTubeTubeInteriorVolume * lightGasDensity * lightGasCostPerKg
  capitalCostOfTransitSystem += costOfRingTerminuses
  capitalCostOfTransitSystem += costOfElevatorCables
  capitalCostOfTransitSystem += costOfElevatorCars
  capitalCostOfTransitSystem += costOfGroundTerminuses
  //console.log('capitalCostOfTransitSystem', capitalCostOfTransitSystem/1e9, 'B USD')
  specs['capitalCostOfTransitSystem'] = {value: capitalCostOfTransitSystem/1e9, units: 'B USD'}

  const capitalCostPerKmOfTransitSystem = capitalCostOfTransitSystem / ringCircumference * metersPerKilometer
  //console.log('capitalCostPerKmOfTransitSystem', capitalCostPerKmOfTransitSystem, 'USD/km')
  specs['capitalCostPerKmOfTransitSystem'] = {value: capitalCostPerKmOfTransitSystem, units: 'USD/km'}

  let operatingCostOfTransitSystem = 0
  operatingCostOfTransitSystem += operatingCostPerKgUniformStaticMassSupported * transitSystemUniformStaticMass   // cost of supporting the transit system
  operatingCostOfTransitSystem += transitTubeTubeSurfaceArea * lightGasLeakageRate * lightGasCostPerKg   // cost of replacing leaked gas
  //console.log('operatingCostOfTransitSystem', operatingCostOfTransitSystem/1e9, 'B USD / year')
  specs['operatingCostOfTransitSystem'] = {value: operatingCostOfTransitSystem/1e9, units: 'B USD / year'}

  const capitalCostPerAvailibleSeatKilometer = capitalCostOfTransitSystem / (availablePassengerKilometersPerYear * amortizationPeriod)
  //console.log('capitalCostPerAvailibleSeatKilometer', capitalCostPerAvailibleSeatKilometer)
  specs['capitalCostPerAvailibleSeatKilometer'] = {value: capitalCostPerAvailibleSeatKilometer, units: 'USD/km'}
  const capitalCostPerRevenuePassengerKilometer = transitSystemUniformStaticMass * capitalCostPerKgSupported / (revenuePassengerKilometersPerYear * amortizationPeriod)
  //console.log('capitalCostPerRevenuePassengerKilometer', capitalCostPerRevenuePassengerKilometer)
  specs['capitalCostPerRevenuePassengerKilometer'] = {value: capitalCostPerRevenuePassengerKilometer, units: 'USD/km'}

  // This is a very rough estimate of the power the vehicle uses just to overcome aerodynamic drag. It doesn't include accellerating, regenerative braking, levitation, and the operating cost of dynamic loading on the ring yet.
  const transitVehicleAerodynamicDragForce = 0.5 * transitVehicleCoefficientOfDrag * lightGasDensity * transitVehicleCruisingSpeed**2 * transitVehicleCrossSectionalArea
  const transitVehicleDrivePower = transitVehicleAerodynamicDragForce * transitVehicleCruisingSpeed / transitSystemEfficiencyAtCruisingSpeed

  // const operatingCostPerAvailibleSeatKilometer = 0 // TBD
  // const costPerAvailibleSeatKilometer = capitalCostPerAvailibleSeatKilometer + operatingCostPerAvailibleSeatKilometer
  // console.log('costPerAvailibleSeatKilometer', costPerAvailibleSeatKilometer)
  // specs['costPerAvailibleSeatKilometer'] = {value: costPerAvailibleSeatKilometer, units: 'USD/m'}

  // Cost per Available Seat Mile (CASK) calculation
  // FS stands for "Full-Service", LC stands for "Low-Cost", TR stands for "Tethered Ring"
  const CASK = []
  CASK['SeatsPerVehicle'] = []
  CASK['SeatsPerVehicle']['FS'] = {value: 156, units: 'seats/vehicle'}
  CASK['SeatsPerVehicle']['LC'] = {value: 180, units: 'seats/vehicle'}
  CASK['SeatsPerVehicle']['TR'] = {value: maximumPassengersPerVehicle, units: 'seats/vehicle'}
  CASK['TripLength'] = []
  CASK['TripLength']['FS'] = {value: 1280, units: 'seats/vehicle'}
  CASK['TripLength']['LC'] = {value: 1280, units: 'seats/vehicle'}
  CASK['TripLength']['TR'] = {value: 1280, units: 'seats/vehicle'}
  CASK['LoadFactor'] = []
  CASK['LoadFactor']['FS'] = {value: 0.65, units: 'seats/vehicle'}
  CASK['LoadFactor']['LC'] = {value: 0.85, units: 'seats/vehicle'}
  CASK['LoadFactor']['TR'] = {value: 0.5, units: 'seats/vehicle'}
  CASK['VehicleCost'] = []
  CASK['VehicleCost']['FS'] = {value: 340000, units: 'USD/month'}
  CASK['VehicleCost']['LC'] = {value: 195000, units: 'USD/month'}
  CASK['VehicleCost']['TR'] = {value: 50000, units: 'USD/month'}
  CASK['CorridorCapitalCost'] = []
  CASK['CorridorCapitalCost']['FS'] = {value: 0, units: 'USD/month'}
  CASK['CorridorCapitalCost']['LC'] = {value: 0, units: 'USD/month'}
  CASK['CorridorCapitalCost']['TR'] = {value: capitalCostOfTransitSystem, units: 'USD/month'}
  CASK['CorridorOperatingCost'] = []   // Includes costs for powering and maintain the coridor, but not the cost of powering or maintaining the vehicles
  CASK['CorridorOperatingCost']['FS'] = {value: 0, units: 'USD/month'}
  CASK['CorridorOperatingCost']['LC'] = {value: 0, units: 'USD/month'}
  CASK['CorridorOperatingCost']['TR'] = {value: operatingCostOfTransitSystem, units: 'USD/month'}
  CASK['OperatingTime'] = []
  CASK['OperatingTime']['FS'] = {value: 8, units: 'blockhours/day'}  // Need to figureout what the correct term is for the number of hours that the vehicle is actually carrying passengers (gate-to-gate time)
  CASK['OperatingTime']['LC'] = {value: 12, units: 'blockhours/day'}
  CASK['OperatingTime']['TR'] = {value: 23.5, units: 'blockhours/day'}  // formally esitmate or justify this
  CASK['KilometersPerBlockHour'] = []
  CASK['KilometersPerBlockHour']['FS'] = {value: 500, units: 'km/hour'}
  CASK['KilometersPerBlockHour']['LC'] = {value: 500, units: 'km/hour'}
  CASK['KilometersPerBlockHour']['TR'] = {value: 3500, units: 'km/hour'}
  CASK['Fuel'] = []
  CASK['Fuel']['FS'] = {value: 820, units: 'gallons/blockhour'}
  CASK['Fuel']['LC'] = {value: 800, units: 'gallons/blockhour'}
  CASK['Fuel']['TR'] = {value: 0, units: 'gallons/blockhour'}
  CASK['Electricity'] = []
  CASK['Electricity']['FS'] = {value: 0, units: 'J/blockhour'}
  CASK['Electricity']['LC'] = {value: 0, units: 'J/blockhour'}
  CASK['Electricity']['TR'] = {value: transitVehicleDrivePower * 3600, units: 'J/blockhour'}  // ToDo need to formally estimate this!!
  CASK['CarbonOffset'] = []
  CASK['CarbonOffset']['FS'] = {value: 82, units: 'J/blockhour'}  // ToDo: Need to estimate this based on the fuel used, etc.
  CASK['CarbonOffset']['LC'] = {value: 80, units: 'J/blockhour'}
  CASK['CarbonOffset']['TR'] = {value: 0, units: 'J/blockhour'} 
  CASK['Maintenance'] = []
  CASK['Maintenance']['FS'] = {value: 700, units: 'USD/blockhour'}
  CASK['Maintenance']['LC'] = {value: 600, units: 'USD/blockhour'}
  CASK['Maintenance']['TR'] = {value: 10, units: 'USD/blockhour'}  // ToDo need to formally estimate this!!
  CASK['CockpitCrewSalary'] = []
  CASK['CockpitCrewSalary']['FS'] = {value: 120000, units: 'USD/year'}
  CASK['CockpitCrewSalary']['LC'] = {value: 100000, units: 'USD/year'}
  CASK['CockpitCrewSalary']['TR'] = {value: 120000, units: 'USD/year'}  // N/A, No pilots
  CASK['CockpitCrewNumber'] = []
  CASK['CockpitCrewNumber']['FS'] = {value: 2, units: ''}
  CASK['CockpitCrewNumber']['LC'] = {value: 2, units: ''}
  CASK['CockpitCrewNumber']['TR'] = {value: 0, units: ''}
  CASK['CockpitCrewBenefitLoad'] = []
  CASK['CockpitCrewBenefitLoad']['FS'] = {value: 0.35, units: ''}
  CASK['CockpitCrewBenefitLoad']['LC'] = {value: 0.25, units: ''}
  CASK['CockpitCrewBenefitLoad']['TR'] = {value: 0.35, units: ''}
  CASK['CockpitCrewAnnualTraining'] = []
  CASK['CockpitCrewAnnualTraining']['FS'] = {value: 15000, units: 'USD/year'}
  CASK['CockpitCrewAnnualTraining']['LC'] = {value: 15000, units: 'USD/year'}
  CASK['CockpitCrewAnnualTraining']['TR'] = {value: 15000, units: 'USD/year'}
  CASK['CockpitCrewTimeSpentInFlight'] = []
  CASK['CockpitCrewTimeSpentInFlight']['FS'] = {value: 60, units: 'blockhours/month'}
  CASK['CockpitCrewTimeSpentInFlight']['LC'] = {value: 65, units: 'blockhours/month'}
  CASK['CockpitCrewTimeSpentInFlight']['TR'] = {value: 60, units: 'blockhours/month'} // N/A, No pilots
  CASK['CabinCrewSalary'] = []
  CASK['CabinCrewSalary']['FS'] = {value: 50000, units: 'USD/year'}
  CASK['CabinCrewSalary']['LC'] = {value: 40000, units: 'USD/year'}
  CASK['CabinCrewSalary']['TR'] = {value: 50000, units: 'USD/year'}
  CASK['CabinCrewBenefitLoad'] = []
  CASK['CabinCrewBenefitLoad']['FS'] = {value: 0.35, units: ''}
  CASK['CabinCrewBenefitLoad']['LC'] = {value: 0.25, units: ''}
  CASK['CabinCrewBenefitLoad']['TR'] = {value: 0.35, units: ''}
  CASK['CabinCrewNumber'] = []
  CASK['CabinCrewNumber']['FS'] = {value: 6, units: ''}
  CASK['CabinCrewNumber']['LC'] = {value: 4, units: ''}
  CASK['CabinCrewNumber']['TR'] = {value: 1, units: ''}
  CASK['CabinCrewTimeSpentInFlight'] = []
  CASK['CabinCrewTimeSpentInFlight']['FS'] = {value: 60, units: 'blockhours/month'}
  CASK['CabinCrewTimeSpentInFlight']['LC'] = {value: 65, units: 'blockhours/month'}
  CASK['CabinCrewTimeSpentInFlight']['TR'] = {value: 60, units: 'blockhours/month'} // Need to estimate how the crew will transfer from vehicle to vehicle
  CASK['CrewHotelAccomodations'] = []
  CASK['CrewHotelAccomodations']['FS'] = {value: 150, units: 'USD/crewmember/day'}
  CASK['CrewHotelAccomodations']['LC'] = {value: 0, units: 'USD/crewmember/day'}
  CASK['CrewHotelAccomodations']['TR'] = {value: 0, units: 'USD/crewmember/day'} // Need to estimate how the crew will transfer from vehicle to vehicle
  CASK['AirportNavTurnCosts'] = []
  CASK['AirportNavTurnCosts']['FS'] = {value: 2500, units: 'USD/turn'}
  CASK['AirportNavTurnCosts']['LC'] = {value: 2000, units: 'USD/turn'}
  CASK['AirportNavTurnCosts']['TR'] = {value: 0, units: 'USD/turn'} // Need to estimate how the crew will transfer from vehicle to vehicle
  CASK['AirportNavLegCosts'] = []
  CASK['AirportNavLegCosts']['FS'] = {value: 750, units: 'USD/leg'}
  CASK['AirportNavLegCosts']['LC'] = {value: 500, units: 'USD/leg'}
  CASK['AirportNavLegCosts']['TR'] = {value: 0, units: 'USD/leg'} // Need to estimate how the crew will transfer from vehicle to vehicle
  CASK['AirportNavHandlingCosts'] = []
  CASK['AirportNavHandlingCosts']['FS'] = {value: 5, units: 'USD/passenger'}
  CASK['AirportNavHandlingCosts']['LC'] = {value: 3.5, units: 'USD/passenger'}
  CASK['AirportNavHandlingCosts']['TR'] = {value: 0, units: 'USD/passenger'} // Need to estimate how the crew will transfer from vehicle to vehicle
  CASK['OnboardCosts'] = []
  CASK['OnboardCosts']['FS'] = {value: 5, units: 'USD/passenger'}
  CASK['OnboardCosts']['LC'] = {value: 1, units: 'USD/passenger'}
  CASK['OnboardCosts']['TR'] = {value: 0, units: 'USD/passenger'} // Need to estimate how the crew will transfer from vehicle to vehicle
  CASK['SalesAndDistribution'] = []
  CASK['SalesAndDistribution']['FS'] = {value: 15, units: 'USD/passenger'}
  CASK['SalesAndDistribution']['LC'] = {value: 5, units: 'USD/passenger'}
  CASK['SalesAndDistribution']['TR'] = {value: 0, units: 'USD/passenger'} // Need to estimate how the crew will transfer from vehicle to vehicle
  CASK['GeneralAndAdministrative'] = []
  CASK['GeneralAndAdministrative']['FS'] = {value: 10, units: 'USD/passenger'}
  CASK['GeneralAndAdministrative']['LC'] = {value: 5, units: 'USD/passenger'}
  CASK['GeneralAndAdministrative']['TR'] = {value: 0, units: 'USD/passenger'} // Need to estimate how the crew will transfer from vehicle to vehicle

  const monthsPerYear = 12
  const daysPerMonth = 30
  const jetFuelCostPerGallon = dParamWithUnits['jetFuelCostPerGallon'].value // USD/Gallon
  const wholesaleCostOfElectricity = dParamWithUnits['wholesaleCostOfElectricity'].value
  const corridorAmortizationPeriod = 20
  // ToDo: Can we more accurately account for time spent taxiing, waiting, borading and disembarling, accellerating and decellerating, circling, etc.?
  // ToDo: Could be a bit confusing to add CASK values to some parameters and not others. Might want to come up with a better system.
  Object.entries(CASK['VehicleCost']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['SeatsPerVehicle'][k].value / CASK['KilometersPerBlockHour'][k].value / CASK['OperatingTime'][k].value / daysPerMonth
  })
  Object.entries(CASK['CorridorCapitalCost']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['SeatsPerVehicle'][k].value / totalVehiclesInExpressLanes / CASK['KilometersPerBlockHour'][k].value / CASK['OperatingTime'][k].value / daysPerMonth / monthsPerYear / corridorAmortizationPeriod
  })
  Object.entries(CASK['CorridorOperatingCost']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['SeatsPerVehicle'][k].value / totalVehiclesInExpressLanes / CASK['KilometersPerBlockHour'][k].value / CASK['OperatingTime'][k].value / daysPerMonth / monthsPerYear
  })
  Object.entries(CASK['Fuel']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['SeatsPerVehicle'][k].value / CASK['KilometersPerBlockHour'][k].value * jetFuelCostPerGallon
  })
  Object.entries(CASK['Electricity']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['SeatsPerVehicle'][k].value / CASK['KilometersPerBlockHour'][k].value * wholesaleCostOfElectricity
  })
  Object.entries(CASK['Maintenance']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['SeatsPerVehicle'][k].value / CASK['KilometersPerBlockHour'][k].value
  })
  Object.entries(CASK['CockpitCrewSalary']).forEach(([k, v]) => {
    v['CASK'] = v.value * CASK['CockpitCrewNumber'][k].value / monthsPerYear / CASK['CockpitCrewTimeSpentInFlight'][k].value / CASK['KilometersPerBlockHour'][k].value / CASK['SeatsPerVehicle'][k].value
  })
  Object.entries(CASK['CockpitCrewBenefitLoad']).forEach(([k, v]) => {
    v['CASK'] = v.value * CASK['CockpitCrewSalary'][k].value * CASK['CockpitCrewNumber'][k].value / monthsPerYear / CASK['CockpitCrewTimeSpentInFlight'][k].value / CASK['KilometersPerBlockHour'][k].value / CASK['SeatsPerVehicle'][k].value
  })
  Object.entries(CASK['CabinCrewSalary']).forEach(([k, v]) => {
    v['CASK'] = v.value * CASK['CabinCrewNumber'][k].value / monthsPerYear / CASK['CabinCrewTimeSpentInFlight'][k].value / CASK['KilometersPerBlockHour'][k].value / CASK['SeatsPerVehicle'][k].value
  })
  Object.entries(CASK['CabinCrewBenefitLoad']).forEach(([k, v]) => {
    v['CASK'] = v.value * CASK['CabinCrewSalary'][k].value * CASK['CabinCrewNumber'][k].value / monthsPerYear / CASK['CabinCrewTimeSpentInFlight'][k].value / CASK['KilometersPerBlockHour'][k].value / CASK['SeatsPerVehicle'][k].value
  })
  Object.entries(CASK['CrewHotelAccomodations']).forEach(([k, v]) => {
    v['CASK'] = v.value * (CASK['CockpitCrewNumber'][k].value + CASK['CabinCrewNumber'][k].value) / CASK['OperatingTime'][k].value / CASK['KilometersPerBlockHour'][k].value / CASK['SeatsPerVehicle'][k].value
  })
  Object.entries(CASK['AirportNavTurnCosts']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['TripLength'][k].value / CASK['SeatsPerVehicle'][k].value // ToDo: Is this the right formula?
  })
  Object.entries(CASK['AirportNavLegCosts']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['TripLength'][k].value / CASK['SeatsPerVehicle'][k].value  // ToDo: Is this the right formula?
  })
  Object.entries(CASK['AirportNavHandlingCosts']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['TripLength'][k].value
  })
  Object.entries(CASK['OnboardCosts']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['TripLength'][k].value
  })
  Object.entries(CASK['SalesAndDistribution']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['TripLength'][k].value
  })
  Object.entries(CASK['GeneralAndAdministrative']).forEach(([k, v]) => {
    v['CASK'] = v.value / CASK['TripLength'][k].value
  })

  Object.entries(CASK).forEach(([k, v]) => {
    let string = k
    let printThis = false
    Object.entries(v).forEach(([k2, v2]) => {
      if (v2.hasOwnProperty('CASK')) {
        v2['CASK'] = v2.CASK.toFixed(6)
        string += ' ' + v2['CASK']
        printThis = true
      }
    })
    if (printThis) {
      //console.log(string)
    }
  })

}

