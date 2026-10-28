import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleCameraPath } from '../../src/shots/CameraPath.js'
import { createShot, parseShot, serializeShot, sampleParameterTrack, validateShot } from '../../src/shots/ShotFormat.js'

const R = 6.4e6
const key = (time, x) => ({ time, position: [R + x, 1, 2], target: [R, 0, 0], up: [1, 0, 0], fov: 45 })

test('smooth path passes exactly through every keyframe', () => {
  const camera = { interpolation: 'smooth', keyframes: [key(0, 0), key(1, 10), key(3, 50), key(4, 20)] }
  for (const k of camera.keyframes) {
    const s = sampleCameraPath(camera, k.time)
    assert.deepEqual(s.position, k.position)
  }
})

test('smooth path keeps sub-millimetre precision at planet scale', () => {
  const camera = { interpolation: 'smooth', keyframes: [key(0, 0), key(1, 0.001), key(2, 0.002)] }
  const s = sampleCameraPath(camera, 0.5)
  assert.ok(Math.abs(s.position[0] - (R + 0.0005)) < 1e-6, `got ${s.position[0] - R}`)
})

test('linear path and clamping outside the keyframe range', () => {
  const camera = { interpolation: 'linear', keyframes: [key(0, 0), key(2, 20)] }
  assert.equal(sampleCameraPath(camera, 1).position[0], R + 10)
  assert.equal(sampleCameraPath(camera, -5).position[0], R)
  assert.equal(sampleCameraPath(camera, 50).position[0], R + 20)
})

test('shot round-trips through JSON and validates', () => {
  const shot = createShot({ preset: 'default', parameters: { a: 1 }, startTime: 12.5 })
  shot.camera.keyframes.push(key(0, 0), key(1, 1))
  const copy = parseShot(serializeShot(shot))
  assert.deepEqual(copy.camera, shot.camera)
  assert.equal(copy.simulation.startTime, 12.5)
})

test('validation reports useful errors', () => {
  assert.throws(() => parseShot('{'), /Invalid shot file/)
  assert.throws(() => validateShot({ format: 'nope' }), /format/)
  const shot = createShot({ preset: 'default', parameters: {}, startTime: 0 })
  shot.camera.keyframes.push(key(1, 0), key(0, 0))
  assert.throws(() => validateShot(shot), /earlier/)
})

test('parameter tracks interpolate numbers and step other values', () => {
  const track = [{ time: 0, value: 0 }, { time: 2, value: 1 }]
  assert.equal(sampleParameterTrack(track, 1), 0.5)
  assert.equal(sampleParameterTrack([{ time: 0, value: false }, { time: 1, value: true }], 0.5), false)
  assert.equal(sampleParameterTrack([{ time: 0, value: false }, { time: 1, value: true }], 1), true)
})
