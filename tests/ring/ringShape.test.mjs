import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { commonRingVariables, placeAtHeightInRingPlane, ringPlaneOffset } from '../../src/ring/ringGeometry.js'
import { ecefToGeodetic } from '../../src/physics/geodesy.js'
import { balancedPointBxAvePercent } from '../../src/ring/tethers.js'

const WGS84 = { a: 6378137.0, f: 1 / 298.257223563 }
const earth = { ellipsoid: WGS84, gravitationalParameter: 3.9860044188e14 }

// A ring like the default one: 32 km up, equivalent latitude 35.5 degrees, centred at 30N 160W.
function ring() {
  const crv = new commonRingVariables(WGS84.a, 32000, 35.47 * Math.PI / 180, 1)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - 30 * Math.PI / 180, -160 * Math.PI / 180))
  return { crv, q }
}

test('the ring is planar, at a constant height above sea level, and nearly circular', () => {
  const { crv, q } = ring()
  const offset = ringPlaneOffset(crv, q, WGS84)
  const r = WGS84.a + crv.currentMainRingAltitude
  const radii = []
  let y0
  for (let k = 0; k < 90; k++) {
    const a = 2 * Math.PI * k / 90
    const p = placeAtHeightInRingPlane(new THREE.Vector3(r * Math.cos(crv.currentEquivalentLatitude) * Math.cos(a), r * Math.sin(crv.currentEquivalentLatitude), r * Math.cos(crv.currentEquivalentLatitude) * Math.sin(a)), 32000, q, WGS84, offset)
    y0 ??= p.y
    assert.ok(Math.abs(p.y - y0) < 1e-6, 'in one plane')
    const w = p.clone().applyQuaternion(q)
    assert.ok(Math.abs(ecefToGeodetic(w.x, w.y, w.z, WGS84).alt - 32000) < 0.01, 'at 32 km above sea level')
    radii.push(Math.hypot(p.x, p.z))
  }
  const eccentricity = Math.sqrt(1 - (Math.min(...radii) / Math.max(...radii)) ** 2)
  assert.ok(eccentricity < 0.12, `eccentricity ${eccentricity}`)
})

test('balancedPointBxAvePercent: the nominal pull gives the nominal design; more pull moves the anchors', () => {
  const { crv } = ring()
  const d = {
    ringFinalAltitude: { value: 32000 }, tetherFiberTensileStrength: { value: 7000 }, tetherEngineeringFactor: { value: 2 },
    tetherFiberDensity: { value: 1790 }, tetherPointBxDeltaPercent: { value: 40 }, tetherPointBxAvePercent: { value: 50 },
  }
  // The pull of the nominal design (the average of its two staggered types), from the same equations.
  const nominal = balancedPointBxAvePercent(earth, crv, d, 563, -1642)
  const inwards = balancedPointBxAvePercent(earth, crv, d, 563, -1660)
  const outwards = balancedPointBxAvePercent(earth, crv, d, 563, -1620)
  assert.ok(nominal > 45 && nominal < 55, `nominal ${nominal}`)
  assert.ok((inwards - nominal) * (outwards - nominal) < 0, 'monotonic in the pull')
})
