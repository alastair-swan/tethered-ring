import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPlanetSpec, airDensityAtAltitude } from '../../src/physics/planets.js'

const earth = getPlanetSpec('earth')
const close = (a, b, relTol) => Math.abs(a - b) <= relTol * Math.abs(b)

test('speed of sound matches the ISA at 0, 11 and 30 km', () => {
  // ISA / US76 tabulated values (m/s)
  assert.ok(close(earth.speedOfSoundAtAltitude(0), 340.29, 0.002))
  assert.ok(close(earth.speedOfSoundAtAltitude(11000), 295.07, 0.002))
  assert.ok(close(earth.speedOfSoundAtAltitude(30000), 301.71, 0.002))
})

test('US76 temperature, pressure and density', () => {
  assert.ok(close(earth.airTemperatureInKelvinAtAltitude(0), 288.15, 1e-6))
  assert.ok(close(earth.airPressureAtAltitude(0), 101325, 1e-6))
  assert.ok(close(earth.airDensityAtAltitude(0), 1.225, 0.001))
  assert.ok(close(earth.airPressureAtAltitude(30000), 1197.0, 0.01))
  assert.ok(close(earth.airDensityAtAltitude(30000), 1.841e-2, 0.01))
  assert.ok(close(airDensityAtAltitude(100000), 5.604e-7, 0.01))
  assert.ok(close(airDensityAtAltitude(120000), 2.222e-8, 0.01))
  assert.ok(earth.airPressureAtAltitude(90000) > 0, 'pressure no longer drops to 0 above 80 km')
})

test('density is consistent with p/(R T) below 86 km and monotonic', () => {
  let last = Infinity
  for (let h = 0; h <= 300000; h += 2500) {
    const rho = earth.airDensityAtAltitude(h)
    assert.ok(rho > 0 && rho < last, `h=${h}`)
    last = rho
    if (h < 86000) {
      const ideal = earth.airPressureAtAltitude(h) / (earth.specificGasConstantForAir * earth.airTemperatureInKelvinAtAltitude(h))
      assert.ok(close(rho, ideal, 1e-9))
    }
  }
})

test('Mars atmosphere evaluates without throwing and is physical', () => {
  const mars = getPlanetSpec('mars')
  assert.ok(close(mars.airPressureAtAltitude(0), 699, 1e-9))
  assert.ok(close(mars.airTemperatureInKelvinAtAltitude(0), 242.15, 1e-6))
  assert.ok(close(mars.airDensityAtAltitude(0), 0.01503, 0.01))
  assert.ok(Number.isFinite(mars.specificGasConstantForAir))
  assert.ok(mars.speedOfSoundAtAltitude(0) > 200 && mars.speedOfSoundAtAltitude(0) < 260)
})
