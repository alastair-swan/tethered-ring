import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vector3 } from 'three'
import { catenaryPoints } from '../../src/launcher/MooringCables.js'

test('a mooring leg is a catenary from the tube to its anchor that sags below the straight line', () => {
  const up = new Vector3(0, 1, 0)
  const anchor = new Vector3(0, 0, 0)
  const tube = new Vector3(5000, 5000, 0) // 45 degree leg, 5 km down
  const points = catenaryPoints(tube, anchor, up, 2, 32)
  assert.ok(points[0].distanceTo(anchor) < 1e-6)
  assert.ok(points[points.length - 1].distanceTo(tube) < 1e-6)
  // Every interior point is below the chord, and the slope only increases (it hangs).
  let previousSlope = -Infinity
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (i < points.length - 1) assert.ok(p.y < p.x - 1, `point ${i} should sag below the chord`)
    const slope = (p.y - points[i - 1].y) / (p.x - points[i - 1].x)
    assert.ok(slope >= previousSlope - 1e-9)
    previousSlope = slope
  }
  // A straighter shape sags less.
  const sag = (shape) => Math.max(...catenaryPoints(tube, anchor, up, shape).map(p => p.x - p.y))
  assert.ok(sag(10) < sag(2))
})

test('a mooring leg never dips below its anchor, however slack the shape', () => {
  const up = new Vector3(0, 1, 0)
  for (const shape of [0.3, 0.5, 1, 2]) {
    for (const tube of [new Vector3(5000, 5000, 0), new Vector3(15000, 3000, 0)]) {
      const points = catenaryPoints(tube, new Vector3(0, 0, 0), up, shape, 64)
      for (const p of points) assert.ok(p.y >= -1e-6, `shape ${shape}: point below the anchor (${p.y})`)
      assert.ok(points[points.length - 1].distanceTo(tube) < 1e-6)
    }
  }
})
