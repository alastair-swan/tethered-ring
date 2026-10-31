import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windAt } from '../../src/physics/wind.js'

const deg = (r) => ((r * 180 / Math.PI) % 360 + 360) % 360

// Wind statistics over a month of 6-hourly samples.
function monthStats(lat, lon, firstDay) {
  const samples = []
  for (let d = firstDay; d < firstDay + 30; d += 0.25) samples.push(windAt(lat, lon, Math.floor(d), (d % 1) * 24))
  const mean = (k) => samples.reduce((s, w) => s + w[k], 0) / samples.length
  return { east: mean('east'), north: mean('north'), speed: mean('speed'), samples }
}

test('the trade winds blow from the east, steadily', () => {
  const { east, samples } = monthStats(15, -150, 1) // North Pacific, January
  assert.ok(east < -4, `mean east ${east}`)
  const easterly = samples.filter(w => deg(w.from) > 0 && deg(w.from) < 150).length / samples.length
  assert.ok(easterly > 0.8, `easterly ${easterly}`)
})

test('the Southern Ocean westerlies are strong and changeable', () => {
  const { east, speed, samples } = monthStats(-50, 90, 182) // July
  assert.ok(east > 4, `mean east ${east}`)
  assert.ok(speed > 9, `mean speed ${speed}`)
  const speeds = samples.map(w => w.speed)
  assert.ok(Math.max(...speeds) - Math.min(...speeds) > 10)
})

test('the Arabian Sea monsoon reverses between January and July', () => {
  assert.ok(monthStats(12, 60, 1).north < -2)
  assert.ok(monthStats(12, 60, 182).north > 3)
})

test('the wind has no jumps in place or time (grid lines, the date line, between weather draws, the year end)', () => {
  const close = (a, b, tol, what) => assert.ok(Math.hypot(a.east - b.east, a.north - b.north) < tol, what)
  for (let lat = -60; lat <= 60; lat += 7.3) {
    // 1 km apart across a grid line and across the date line
    close(windAt(lat, 4.99, 100, 6), windAt(lat, 5.01, 100, 6), 0.5, `lon 5 at ${lat}`)
    close(windAt(lat, 179.995, 100, 6), windAt(lat, -179.995, 100, 6), 0.5, `date line at ${lat}`)
    close(windAt(lat - 0.005, 30, 100, 6), windAt(lat + 0.005, 30, 100, 6), 0.5, `lat ${lat}`)
    // a minute apart, through every hour of a few days
    for (let h = 0; h < 72; h += 0.75) {
      const d = 200 + Math.floor(h / 24)
      close(windAt(lat, 30, d, h % 24), windAt(lat, 30, d, h % 24 + 1 / 60), 0.5, `time ${h} at ${lat}`)
    }
    close(windAt(lat, 30, 365, 23.999), windAt(lat, 30, 1, 0), 1.5, `year end at ${lat}`)
  }
})

test('the same place and time always give the same wind', () => {
  assert.deepEqual(windAt(-33.9, 151.3, 45, 3.5), windAt(-33.9, 151.3, 45, 3.5))
})
