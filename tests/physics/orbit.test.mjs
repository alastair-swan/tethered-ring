import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { orbitalElementsFromStateVector } from '../../src/launcher/OrbitMath.js'

const mu = 3.9860044188e14

// Build R, V in the three.js frame (+Y pole, +Z reference direction) from classical elements.
function stateFromElements(a, e, inc, raan, argp, nu) {
  const p = a * (1 - e * e)
  const r = p / (1 + e * Math.cos(nu))
  const rp = [r * Math.cos(nu), r * Math.sin(nu), 0]
  const vp = [-Math.sqrt(mu / p) * Math.sin(nu), Math.sqrt(mu / p) * (e + Math.cos(nu)), 0]
  const rot = (v) => {
    // Rz(raan) Rx(inc) Rz(argp) in a pole-up frame (X ref, Z pole)
    let [x, y, z] = v
    ;[x, y] = [x * Math.cos(argp) - y * Math.sin(argp), x * Math.sin(argp) + y * Math.cos(argp)]
    ;[y, z] = [y * Math.cos(inc) - z * Math.sin(inc), y * Math.sin(inc) + z * Math.cos(inc)]
    ;[x, y] = [x * Math.cos(raan) - y * Math.sin(raan), x * Math.sin(raan) + y * Math.cos(raan)]
    return new THREE.Vector3(y, z, x) // pole-up (X,Y,Z) -> three.js (z, x, y)
  }
  return { R: rot(rp), V: rot(vp) }
}

test('vis-viva: semi-major axis and speed are consistent', () => {
  const r = 6378137 + 400000
  const v = 7800
  const R = new THREE.Vector3(0, 0, r)
  const V = new THREE.Vector3(v, 0, 0)
  const coe = orbitalElementsFromStateVector(R, V, mu)
  const aVisViva = 1 / (2 / r - v * v / mu)
  assert.ok(Math.abs(coe.semimajorAxis - aVisViva) / aVisViva < 1e-12)
})

test('elements round trip, including RAAN in all four quadrants (pole is +Y)', () => {
  for (const raanDeg of [20, 110, 200, 290]) {
    const els = [7000e3, 0.1, 51.6 * Math.PI / 180, raanDeg * Math.PI / 180, 30 * Math.PI / 180, 75 * Math.PI / 180]
    const { R, V } = stateFromElements(...els)
    const coe = orbitalElementsFromStateVector(R, V, mu)
    assert.ok(Math.abs(coe.semimajorAxis - els[0]) < 1e-3)
    assert.ok(Math.abs(coe.eccentricity - els[1]) < 1e-9)
    assert.ok(Math.abs(coe.inclination - els[2]) < 1e-9)
    assert.ok(Math.abs(coe.rightAscensionOfTheAscendingNode - els[3]) < 1e-9, `raan ${raanDeg}: ${coe.rightAscensionOfTheAscendingNode * 180 / Math.PI}`)
    assert.ok(Math.abs(coe.argumentOfPerigee - els[4]) < 1e-9)
    assert.ok(Math.abs(coe.trueAnomaly - els[5]) < 1e-9)
  }
})

test('equatorial orbit (in the XZ plane of the scene) has zero inclination', () => {
  const R = new THREE.Vector3(0, 0, 7000e3)
  const V = new THREE.Vector3(7500, 0, 0)
  const coe = orbitalElementsFromStateVector(R, V, mu)
  assert.ok(coe.inclination < 1e-12 || Math.abs(coe.inclination - Math.PI) < 1e-12)
  assert.ok(Number.isFinite(coe.trueAnomaly))
})
