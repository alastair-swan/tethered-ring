import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { ScrewGeometry } from '../../src/launcher/ScrewGeometry.js'
import { sharedScrewBucket } from '../../src/launcher/MassDriverScrew.js'

// A fast screw (as on the To Mars from Hawaii launcher) and its first thread level.
const thread = { initialVelocity: 50, initialDistance: 10, acceleration: 80, revolutionsPerSecond: 169, threadStartDistance: 0 }
const length = 5.1
const build = (distance) => new ScrewGeometry(length, 0.25, 0.2, 0.33, 0.05, 0.5, 8, distance,
  thread.initialVelocity, thread.initialDistance, thread.revolutionsPerSecond, thread.acceleration, 12, 1, 12, 512, 0)

// How far the shared geometry, rotated onto the segment, is from the segment's own (nearest vertices).
function mismatch(distance) {
  const share = sharedScrewBucket(distance, length, thread)
  assert.ok(share, `shared at ${distance} m`)
  const own = build(distance).getAttribute('position')
  const shared = build(share.bucketDistance).getAttribute('position')
  const rotate = new THREE.Matrix4().makeRotationY(share.rotation)
  const targets = []
  for (let i = 0; i < own.count; i++) targets.push(new THREE.Vector3().fromBufferAttribute(own, i))
  let sum = 0
  const v = new THREE.Vector3()
  for (let i = 0; i < shared.count; i++) {
    v.fromBufferAttribute(shared, i).applyMatrix4(rotate)
    let best = Infinity
    for (const t of targets) best = Math.min(best, v.distanceToSquared(t))
    sum += Math.sqrt(best)
  }
  return sum / shared.count
}

test('fast segments share a geometry, rotated onto each to within a couple of millimetres', () => {
  for (const distance of [100000, 400000, 700000]) {
    const error = mismatch(distance)
    assert.ok(error < 0.002, `${distance} m: mean ${error} m`)
  }
})

test('slow segments (more than a turn of thread) are not shared', () => {
  // At 100 m/s the lead is ~0.6 m: a 5 m segment holds ~8 turns.
  assert.equal(sharedScrewBucket(70, length, thread), null)
})
