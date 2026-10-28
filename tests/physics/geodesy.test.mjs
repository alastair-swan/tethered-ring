import { test } from 'node:test'
import assert from 'node:assert/strict'
import { radiusAtLatitude, ecefToGeodetic, geodeticToECEF, geocentricToGeodeticLatitude, ellipsoidSurfaceScale } from '../../src/physics/geodesy.js'

const WGS84 = { a: 6378137.0, f: 1 / 298.257223563 }
const b = WGS84.a * (1 - WGS84.f)

test('radiusAtLatitude returns a at the equator and b at the poles (degrees input)', () => {
  assert.ok(Math.abs(radiusAtLatitude(0, WGS84) - WGS84.a) < 1e-6)
  assert.ok(Math.abs(radiusAtLatitude(90, WGS84) - b) < 1e-6)
  assert.ok(Math.abs(radiusAtLatitude(-90, WGS84) - b) < 1e-6)
  // Geocentric radius at 45 deg geodetic latitude is ~6367.49 km (it used to always return a)
  assert.ok(Math.abs(radiusAtLatitude(45, WGS84) - 6367489.5) < 1)
})

test('radiusAtLatitude matches |geodeticToECEF(lat, lon, 0)|', () => {
  for (const lat of [-80, -33.3, 0, 12, 45, 67.5, 89]) {
    const p = geodeticToECEF(lat, 17, 0, WGS84)
    const r = Math.hypot(p.x, p.y, p.z)
    assert.ok(Math.abs(r - radiusAtLatitude(lat, WGS84)) < 1e-6, `lat ${lat}`)
  }
})

test('geodetic -> ECEF -> geodetic round trip, including the poles', () => {
  for (const [lat, lon, alt] of [[0, 0, 0], [45, 90, 1000], [-33.9, 151.2, 32000], [89.9999, -120, 500], [90, 0, 0], [-90, 0, 12345], [10, 179.5, -400]]) {
    const p = geodeticToECEF(lat, lon, alt, WGS84)
    const g = ecefToGeodetic(p.x, p.y, p.z, WGS84)
    assert.ok(Math.abs(g.lat - lat) < 1e-9, `lat ${lat}: ${g.lat}`)
    assert.ok(Math.abs(g.alt - alt) < 1e-6, `alt ${alt} at lat ${lat}: ${g.alt}`)
    if (Math.abs(lat) < 90) assert.ok(Math.abs(g.lon - lon) < 1e-9, `lon ${lon}: ${g.lon}`)
  }
})

test('three.js axis convention: +Y is the north pole, +Z is lat 0 lon 0', () => {
  const p = geodeticToECEF(90, 0, 0, WGS84)
  assert.ok(Math.abs(p.y - b) < 1e-6 && Math.abs(p.x) < 1e-6 && Math.abs(p.z) < 1e-6)
  const q = geodeticToECEF(0, 0, 0, WGS84)
  assert.ok(Math.abs(q.z - WGS84.a) < 1e-6)
})

test('geocentric to geodetic latitude', () => {
  assert.equal(geocentricToGeodeticLatitude(0, WGS84), 0)
  const p = geodeticToECEF(45, 0, 0, WGS84)
  const geocentric = Math.atan2(p.y, p.z) * 180 / Math.PI
  assert.ok(Math.abs(geocentricToGeodeticLatitude(geocentric, WGS84) - 45) < 1e-9)
})

test('ellipsoidSurfaceScale moves a point along its ray onto the ellipsoid', () => {
  for (const [x, y, z] of [[0, 0, 7e6], [0, 7e6, 0], [3e6, 4e6, 2e6], [-1e6, -5e6, 3e6]]) {
    const s = ellipsoidSurfaceScale(x, y, z, WGS84)
    const g = ecefToGeodetic(s * x, s * y, s * z, WGS84)
    assert.ok(Math.abs(g.alt) < 1e-6, `altitude ${g.alt}`)
  }
  // The ground is a - b below the equatorial-radius sphere at the poles, and on it at the equator.
  assert.ok(Math.abs(WGS84.a * (1 - ellipsoidSurfaceScale(0, WGS84.a, 0, WGS84)) - (WGS84.a - b)) < 1e-6)
  assert.ok(Math.abs(ellipsoidSurfaceScale(WGS84.a, 0, 0, WGS84) - 1) < 1e-15)
})
