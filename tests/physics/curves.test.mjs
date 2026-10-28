import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { SuperCurvePath, CircleSuperCurve3, LineSuperCurve3, CatmullRomSuperCurve3 } from '../../src/curves/SuperCurves.js'

test('LineSuperCurve3 basics and quaternion', () => {
  const up = new THREE.Vector3(0, 0, 1)
  const line = new LineSuperCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0), up)
  assert.equal(line.getLength(), 10)
  assert.deepEqual(line.getPoint(0.5).toArray(), [5, 0, 0])
  const q = line.getQuaternionAt(0.3)
  const fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  assert.ok(fwd.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-12)
  assert.deepEqual(line.getStartFinishZoneIndices(new THREE.Vector3(5, 1, 0), 2).map(v => +v.toFixed(6)), [0.326795, 0.673205])
  const frames = line.computeFrenetFrames(4)
  assert.equal(frames.normals.length, 5)
})

test('CircleSuperCurve3 does not mutate the axis, sorts numerically and maps points to d', () => {
  const axis = new THREE.Vector3(0, 0, 2)
  const circle = new CircleSuperCurve3(new THREE.Vector3(), axis, new THREE.Vector3(100, 0, 0), 100 * Math.PI) // half circle
  assert.equal(axis.z, 2)
  const d = circle.convertPointToDValue(circle.getPointAt(0.8)) // 144 degrees: beyond asin's range
  assert.ok(Math.abs(d - 0.8) < 1e-12)
  const res = circle.getStartFinishZoneIndices(circle.getPointAt(0.5), 30)
  assert.equal(res.length, 2)
  assert.ok(res[0] < 0.5 && res[1] > 0.5)
})

test('SuperCurvePath closePath, zone index clamping and fromJSON errors', () => {
  const path = new SuperCurvePath()
  const c = new CatmullRomSuperCurve3([new THREE.Vector3(0, 0, 100), new THREE.Vector3(50, 0, 100), new THREE.Vector3(100, 10, 100)])
  c.setDuration(10)
  c.addtTodConvertor(t => t * c.getLength() / 10)
  path.add(c)
  path.updateArcLengths()
  path.subdivide(20)
  assert.equal(path.getZoneIndex(1e6), 19)
  assert.equal(path.getZoneIndex(-5), 0)
  path.closePath()
  assert.equal(path.superCurves.length, 2)
  assert.throws(() => new SuperCurvePath().fromJSON({ arcLengthDivisions: 200, superCurves: [{ type: 'EllipseCurve' }] }), /unsupported/)
})
