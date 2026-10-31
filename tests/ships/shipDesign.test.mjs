import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shipDesign } from '../../src/scene/ContainerShips.js'

const only = (size) => [[size, 1]]

test('each ship size has its deck capacity (FEU)', () => {
  const ranges = { small: [200, 400], medium: [900, 1100], large: [2500, Infinity] }
  for (const [size, [lo, hi]] of Object.entries(ranges)) {
    for (let seed = 1; seed <= 200; seed++) {
      const d = shipDesign(seed, only(size), [0.35, 1])
      assert.ok(d.feu >= lo && d.feu <= hi, `${size} seed ${seed}: ${d.feu} FEU`)
      assert.ok(d.boxes.length / 4 <= d.feu, `${size} seed ${seed}: more containers than slots`)
    }
  }
})

test('the superstructure is in the midbody, and nothing is stacked in its bay', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const d = shipDesign(seed, [['small', 1], ['medium', 1], ['large', 1]], [1, 1])
    assert.ok(d.bridge >= 3 && d.bridge < d.slots - 2, `seed ${seed}: bridge in slot ${d.bridge} of ${d.slots}`)
    const bridgeZ = -11.58 + d.bridge * 1.2242
    for (let i = 2; i < d.boxes.length; i += 4) assert.ok(Math.abs(d.boxes[i] - bridgeZ) > 0.5)
  }
})

test('a ship is the same from the same seed', () => {
  assert.deepEqual(shipDesign(42, only('large'), [0.35, 1]), shipDesign(42, only('large'), [0.35, 1]))
})

test('fully loaded ships carry most of their capacity, light ones less', () => {
  let full = 0, light = 0, capacity = 0
  for (let seed = 1; seed <= 100; seed++) {
    full += shipDesign(seed, only('medium'), [1, 1]).boxes.length / 4
    light += shipDesign(seed, only('medium'), [0.35, 0.35]).boxes.length / 4
    capacity += shipDesign(seed, only('medium'), [1, 1]).feu
  }
  assert.ok(full / capacity > 0.75 && full / capacity <= 1, `full: ${(full / capacity).toFixed(2)}`)
  assert.ok(light / capacity > 0.2 && light / capacity < 0.5, `light: ${(light / capacity).toFixed(2)}`)
})
