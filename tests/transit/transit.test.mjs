// Unit tests for the transit system's pure motion models. Run with: node --test tests/transit/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { TrapezoidalMove, elevatorPositionCalculator, vehicleReferenceFrameTrackPositionCalculator } from '../../src/transit/transitCalculators.js'
import { AnimationChannel } from '../../src/transit/AnimationChannel.js'
import { transitStopLayout, forEachInWindow, seededRandom } from '../../src/transit/VirtualRingObject.js'

const p = (value) => ({ value })
function params(overrides = {}) {
  return {
    groundTerminusUpwardOffset: p(150), elevatorCarMaxSpeed: p(200), elevatorCarMaxAcceleration: p(2),
    numVirtualRingTerminuses: p(1800), numVirtualHabitats: p(17100),
    transitTubeOutwardOffset: p(-15), transitTubeUpwardOffset: p(-100),
    transitVehicleCruisingSpeed: p(500), transitVehicleMaxAcceleration: p(10),
    transitVehicleMergeTime: p(1), transitVehicleStopDuration: p(30),
    ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, p(v)])),
  }
}
const crv = { currentMainRingAltitude: 32000, currentEquivalentLatitude: 0.5, mainRingRadius: 5.6e6 }
function circleCurve(radius, n = 256) {
  const pts = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; pts.push(new THREE.Vector3(radius * Math.cos(a), 3e6, radius * Math.sin(a))) }
  const c = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0)
  return c
}

function maxStep(fn, t0, t1, dt) {
  let prev = fn(t0), m = 0
  for (let t = t0 + dt; t <= t1; t += dt) { const v = fn(t); m = Math.max(m, Math.abs(v - prev)); prev = v }
  return m
}

test('trapezoidal move: continuous position and speed, reaches distance', () => {
  for (const [d, v, a] of [[1000, 50, 2], [10, 50, 2], [31850, 200, 2]]) {
    const m = new TrapezoidalMove(d, v, a)
    assert.ok(Math.abs(m.distanceAt(m.duration) - d) < 1e-6)
    assert.ok(m.peakSpeed <= v + 1e-9)
    const dt = 0.01
    assert.ok(maxStep(t => m.distanceAt(t), 0, m.duration, dt) <= m.peakSpeed * dt + 1e-6)
    assert.ok(maxStep(t => m.speedAt(t), 0, m.duration, dt) <= a * dt + 1e-6)
  }
  const stuck = new TrapezoidalMove(100, 0, 2)
  assert.equal(stuck.distanceAt(10), 0)
})

test('elevator: no jump at either terminus, continuous velocity, endpoints match terminuses', () => {
  const calc = new elevatorPositionCalculator(params(), crv, { waitTime: 30 })
  const dt = 0.05
  assert.equal(calc.calculateElevatorPosition(0), 32000)
  assert.equal(calc.calculateElevatorPosition(30 + calc.travelTime + 1), 150)
  assert.ok(maxStep(t => calc.calculateElevatorPosition(t), 0, 2 * calc.cycleTime, dt) <= 200 * dt + 1e-6)
  assert.ok(maxStep(t => calc.calculateElevatorSpeed(t), 0, 2 * calc.cycleTime, dt) <= 2 * dt + 1e-6)
  // Determinism / periodicity
  assert.ok(Math.abs(calc.calculateElevatorPosition(123.4) - calc.calculateElevatorPosition(123.4 + calc.cycleTime)) < 1e-6)
  // Zero limits do not produce NaN
  const z = new elevatorPositionCalculator(params({ elevatorCarMaxAcceleration: 0 }), crv, { waitTime: 30 })
  assert.ok(Number.isFinite(z.calculateElevatorPosition(1000)))
})

test('collector lane: vehicles are exactly on transit stops while dwelling, motion is continuous', () => {
  const curve = circleCurve(crv.mainRingRadius)
  const calc = new vehicleReferenceFrameTrackPositionCalculator(params(), curve, crv)
  for (const cycle of [0, 1, 7, 1e5]) {
    const x = calc.calcTrackPosition(cycle * calc.cycleTime + calc.stopDuration / 2) * calc.numStops
    assert.ok(Math.abs(x - Math.round(x)) < 1e-6, `cycle ${cycle}: ${x}`)
  }
  const dt = 0.05
  let prev = calc.calcTrackPosition(0), m = 0
  for (let t = dt; t < 3 * calc.cycleTime; t += dt) {
    const q = calc.calcTrackPosition(t); let d = q - prev; d -= Math.round(d); m = Math.max(m, Math.abs(d) * calc.transitTubeCircumference); prev = q
  }
  assert.ok(m <= 500 * dt + 1e-3, `max step ${m}`)
  assert.ok(calc.stopsPerCycle * calc.stopSpacing >= 500 * 500 / 10)
  const stopped = new vehicleReferenceFrameTrackPositionCalculator(params({ transitVehicleMaxAcceleration: 0 }), curve, crv)
  assert.equal(stopped.calcTrackPosition(100), 0)
})

test('animation channel: pausing freezes, resuming does not jump, state round-trips', () => {
  const ch = new AnimationChannel(true)
  assert.equal(ch.timeAt(10), 10)
  ch.setRunning(false, 10)
  assert.equal(ch.timeAt(50), 10)
  ch.setRunning(true, 50)
  assert.equal(ch.timeAt(50), 10)
  assert.equal(ch.timeAt(51), 11)
  const copy = new AnimationChannel(false)
  copy.setState(JSON.parse(JSON.stringify(ch.getState())))
  assert.equal(copy.timeAt(77), ch.timeAt(77))
})

test('layout helpers', () => {
  const layout = transitStopLayout(1800, 17100)
  assert.equal(layout.terminusPositions.length + layout.habitatPositions.length, 18900)
  assert.equal(layout.terminusPositions.length, 1800)
  const sorted = Float64Array.from([0.01, 0.2, 0.5, 0.98, 0.99])
  const hits = []
  forEachInWindow(sorted, 0.0, 0.03, i => hits.push(i))
  assert.deepEqual(hits.sort(), [0, 3, 4])
  const a = seededRandom(1), b = seededRandom(1)
  assert.equal(a(), b())
})
