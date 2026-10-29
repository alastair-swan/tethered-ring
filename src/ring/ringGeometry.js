// Shared tethered-ring dimensions and offset helpers.
import * as THREE from 'three'
import { lerp } from '../utils/math.js'
import { ellipsoidSurfaceScale, ecefToGeodetic } from '../physics/geodesy.js'

const _planetPoint = new THREE.Vector3()

function heightAboveEllipsoid(x, y, z, ringToPlanetQuaternion, ellipsoid) {
  _planetPoint.set(x, y, z).applyQuaternion(ringToPlanetQuaternion)
  return ecefToGeodetic(_planetPoint.x, _planetPoint.y, _planetPoint.z, ellipsoid).alt
}

// The ring is designed as a circle at its height above the equatorial-radius sphere. This is the
// shift of its plane along its axis (ring frame y) that best brings that circle to that height above
// the ellipsoid (sea level), by least squares. Small rings then need nothing more; large ones are also
// moved in the plane (placeAtHeightInRingPlane).
export function ringPlaneOffset(crv, ringToPlanetQuaternion, ellipsoid, samples = 64) {
  const r = ellipsoid.a + crv.currentMainRingAltitude
  const rho = r * Math.cos(crv.currentEquivalentLatitude)
  let offset = 0
  for (let iteration = 0; iteration < 3; iteration++) {
    let num = 0, den = 0
    const y = r * Math.sin(crv.currentEquivalentLatitude) + offset
    for (let k = 0; k < samples; k++) {
      const a = 2 * Math.PI * k / samples
      const x = rho * Math.cos(a), z = rho * Math.sin(a)
      const h = heightAboveEllipsoid(x, y, z, ringToPlanetQuaternion, ellipsoid)
      const slope = heightAboveEllipsoid(x, y + 1, z, ringToPlanetQuaternion, ellipsoid) - h
      num += (crv.currentMainRingAltitude - h) * slope
      den += slope * slope
    }
    offset += num / den
  }
  return offset
}

// Moves `point` (ring frame) along the ring's axis by planeOffset (ringPlaneOffset), then towards or
// away from the axis, in the ring's plane, until it is `height` above the ellipsoid (sea level), where
// moving in the plane changes its height. A ring of such points lies in one plane at a constant
// height: the plane's section of the (flattened) planet, an ellipse of low eccentricity.
export function placeAtHeightInRingPlane(point, height, ringToPlanetQuaternion, ellipsoid, planeOffset = 0) {
  point.y += planeOffset
  const heightAt = (rho) => heightAboveEllipsoid(point.x * rho, point.y, point.z * rho, ringToPlanetQuaternion, ellipsoid)
  // rho scales the point's distance from the axis; Newton's method on the height.
  const across = Math.hypot(point.x, point.z)
  let rho = 1
  for (let i = 0; i < 6; i++) {
    const h = heightAt(rho)
    const slope = (heightAt(rho + 1 / across) - h) / (1 / across)   // per unit of rho
    if (!(Math.abs(slope) > 0.2 * across)) break   // moving in the plane hardly changes the height
    const step = (height - h) / slope
    rho += step
    if (Math.abs(step * across) < 1e-3) break
  }
  point.x *= rho
  point.z *= rho
  return point
}

// How far the ground (the ellipsoid, at sea level) is below the sphere of the equatorial radius on
// which the ring is designed, in the direction of `point` (ring frame; ringToPlanetQuaternion turns it
// into planet coordinates, whose origin is shared). The ring keeps a constant height above sea level:
// a point designed at r = a + h is lowered by this depth.
export function groundDepthBelowSphere(point, ringToPlanetQuaternion, ellipsoid) {
  _planetPoint.copy(point).applyQuaternion(ringToPlanetQuaternion)
  const scale = ellipsoidSurfaceScale(_planetPoint.x, _planetPoint.y, _planetPoint.z, ellipsoid)
  return ellipsoid.a - _planetPoint.length() * scale
}

export function offset_r(outwardOffset, upwardOffset, currentEquivalentLatitude) {
  return outwardOffset * Math.sin(currentEquivalentLatitude) + upwardOffset * Math.cos(currentEquivalentLatitude)
}

// Returns a "delta y" in the ring-centered cylindrical coordinate space relative to the middlemost main ring  
export function offset_y(outwardOffset, upwardOffset, currentEquivalentLatitude) {
  return outwardOffset * -Math.cos(currentEquivalentLatitude) + upwardOffset * Math.sin(currentEquivalentLatitude)
}

export class commonRingVariables {
  constructor(radiusOfPlanet, ringFinalAltitude, equivalentLatitude, ringAmountRaisedFactor) {
    this.radiusOfPlanet = radiusOfPlanet
    this.ringFinalAltitude = ringFinalAltitude
    this.equivalentLatitude = equivalentLatitude
    this.ringAmountRaisedFactor = ringAmountRaisedFactor
    this.update()
  }

  update() {
    this.mainRingRadius = (this.radiusOfPlanet + this.ringFinalAltitude) * Math.cos(this.equivalentLatitude)
    this.constructionEquivalentLatitude = Math.acos(this.mainRingRadius / this.radiusOfPlanet)
    this.yf = (this.radiusOfPlanet + this.ringFinalAltitude) * Math.sin(this.equivalentLatitude)
    this.y0 = Math.sin(this.constructionEquivalentLatitude) * this.radiusOfPlanet
    this.yc = lerp(this.y0, this.yf, this.ringAmountRaisedFactor**2)
    this.currentEquivalentLatitude = Math.atan2(this.yc, this.mainRingRadius)
    this.currentMainRingAltitude = Math.sqrt(this.yc**2 + this.mainRingRadius**2) - this.radiusOfPlanet
  }
}

export class commonTetherVariables {
  constructor() {
    this.gravityForceAtRing = []
    this.tensileForceAtRing = []
    this.inertialForceAtRing = []
  }
}

export function makeOffsetCurve(outwardOffset, upwardOffset, crv, lengthSegments, mainRingCurve, segmentNumber, totalSegments) {
  // Create a curve to represent the path we want the tube to take
  console.assert(lengthSegments % 2 == 0, "lengthSegments must be even")
  const tubePoints = []
  const dr = offset_r(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
  const dy = offset_y(outwardOffset, upwardOffset, crv.currentEquivalentLatitude)
  for (let i = -lengthSegments/2; i<=lengthSegments/2; i++) {
    const modelsTrackPosition = (segmentNumber + i/lengthSegments)/totalSegments
    const pointOnRingCurve = mainRingCurve.getPoint(modelsTrackPosition)
    const angle = 2 * Math.PI * modelsTrackPosition
    tubePoints.push( new THREE.Vector3(pointOnRingCurve.x + dr * Math.cos(angle), pointOnRingCurve.y + dy, pointOnRingCurve.z + dr * Math.sin(angle)) )
  }
  const refPoint = tubePoints[lengthSegments/2].clone()
  tubePoints.forEach(point => {point.sub(refPoint)})
  return new THREE.CatmullRomCurve3(tubePoints)
}

export function updateMovingRingSpecs(dParamWithUnits, crv, specs) {

  // Eddy Current Power Losses in the Moving Rings
  if (!specs.hasOwnProperty('movingRingsSpeed')) {
    console.error('Error: movingRingSpeed not defined')
  }
  if (!specs.hasOwnProperty('ringMaglevCoreMassPerMeter')) {
    console.error('Error: ringMaglevCoreMassPerMeter not defined')
  }
  if (!specs.hasOwnProperty('magneticFieldStrengthInAirgap')) {
    console.error('Error: magneticFieldStrengthInAirgap not defined')
  }

  const movingRingSpeed = specs['movingRingsSpeed'].value // m/s
  const ringMaglevCoreMassPerMeter = specs['ringMaglevCoreMassPerMeter'].value // kg/m
  const magneticFieldStrengthInAirgap = specs['magneticFieldStrengthInAirgap'].value // T
  const movingRingNonuniformityLength = 0.3  // m - this means that the magnetic field is non-uniform over a length of 1 meter
  const movingRingAverageMagneticFieldVariation = 0.000005 // T  Assuming magnetic field homogeneity (MFH) is 10 ppm (+/-5 ppm from nominal) 
  const peakMagneticField = movingRingAverageMagneticFieldVariation * magneticFieldStrengthInAirgap
  const thicknessOfSheets = 0.001  // m  The thickness of the laminated sheets in the core 
  const frequencyOfField = movingRingSpeed / movingRingNonuniformityLength  // Hz (assumes that the linear Bearing is continuous and its length equals the launch vehicle's body length)
  const constantK = 1  // This is constant for a thin sheet. We will assume that the core is laminated to reduce eddy current losses
  const materialResistivity = 4.6e-7  // Ohm*m, for Grain-oriented electrical steel rom https://www.thoughtco.com/table-of-electrical-resistivity-conductivity-608499
  const materialDensity = 7650  // kg/m3
  // From: https://en.wikipedia.org/wiki/Eddy_current
  const movingRingEddyCurrentPowerLossesPerKg = (Math.PI * peakMagneticField * thicknessOfSheets * frequencyOfField)**2 / (6 * constantK * materialResistivity * materialDensity)
  specs['movingRingEddyCurrentPowerLossesPerKg'] = {value: movingRingEddyCurrentPowerLossesPerKg, units: 'W'}
  // We'll assume that there is a primary magnet that pulls inwards and two half-mass secondary magnets that can activate and pull outwards to keep the moving ring centered
  const movingRingEddyCurrentPowerLossesPerMeter = movingRingEddyCurrentPowerLossesPerKg * ringMaglevCoreMassPerMeter * (1 + 0.5 + 0.5)
  specs['movingRingEddyCurrentPowerLossesPerMeter'] = {value: movingRingEddyCurrentPowerLossesPerMeter, units: 'W/m'}
  const ringCircumference = crv.mainRingRadius * 2 * Math.PI
  const movingRingEddyCurrentPowerLossesTotal = movingRingEddyCurrentPowerLossesPerMeter * ringCircumference
  specs['movingRingEddyCurrentPowerLossesTotal'] = {value: movingRingEddyCurrentPowerLossesTotal, units: 'W'}
}


