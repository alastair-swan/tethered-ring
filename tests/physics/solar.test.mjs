import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subsolarPoint, sunElevation, advanceDate, defaultDaytime } from '../../src/physics/solar.js'

const near = (a, b, tol) => Math.abs(a - b) <= tol

test('the sun is overhead at the tropics at the solstices and near the equator at the equinoxes', () => {
  assert.ok(near(subsolarPoint(172, 12).lat, 23.44, 0.3))   // ~21 June
  assert.ok(near(subsolarPoint(355, 12).lat, -23.44, 0.3))  // ~21 December
  assert.ok(near(subsolarPoint(80, 12).lat, 0, 0.6))        // ~21 March
  assert.ok(near(subsolarPoint(266, 12).lat, 0, 0.6))       // ~23 September
})

test('the subsolar longitude follows UTC (within the equation of time, < 17 minutes = 4.25 degrees)', () => {
  for (const day of [1, 50, 100, 200, 300]) {
    assert.ok(Math.abs(subsolarPoint(day, 12).lon) < 4.3)
    assert.ok(Math.abs(Math.abs(subsolarPoint(day, 0).lon) - 180) < 4.3)
    assert.ok(near(subsolarPoint(day, 18).lon, -90, 4.3))
  }
})

test('sun elevation: overhead at the subsolar point, below the horizon on the far side', () => {
  const s = subsolarPoint(172, 15)
  assert.ok(near(sunElevation(s.lat, s.lon, 172, 15), 90, 0.01))
  assert.ok(sunElevation(-s.lat, s.lon + 180, 172, 15) < -80)
})

test('advancing the date wraps hours and days', () => {
  assert.deepEqual(advanceDate(10, 23, 2 * 3600), { dayOfYear: 11, utcHours: 1 })
  assert.deepEqual(advanceDate(365, 23, 3600), { dayOfYear: 1, utcHours: 0 })
  assert.ok(near(advanceDate(100, 6, 90).utcHours, 6.025, 1e-9))
})

test('a scene default is repeatable, daytime, and well lit where that is possible', () => {
  const a = defaultDaytime('bigIslandLauncher', 19.8, -155.5)
  assert.deepEqual(a, defaultDaytime('bigIslandLauncher', 19.8, -155.5))
  assert.ok(sunElevation(19.8, -155.5, a.dayOfYear, a.utcHours) >= 25)
  const b = defaultDaytime('somethingElse', 19.8, -155.5)
  assert.notDeepEqual(a, b)
})
