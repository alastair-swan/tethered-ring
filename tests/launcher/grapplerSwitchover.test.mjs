import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grapplerPose } from '../../src/launcher/grapplerSwitchover.js'

// A grappler whose thread phase drifts at a steady `rate` (cycles per second), sampled at time `time`.
// engagedFrom: before this time it cannot grip (parked).
function grappler(time, rate, { n = 8, limit = 0.04, phase0 = 0.3, engagedFrom = -Infinity } = {}) {
  const u = (t) => phase0 + rate * (time + t)
  const wrapped = ((u(0) % n) + n) % n
  const frac = wrapped - Math.floor(wrapped)
  return {
    engageable: time >= engagedFrom,
    engageableAt: (t) => time + t >= engagedFrom,
    threadStarts: n,
    rotationAwayLimit: limit,
    phase: () => wrapped,
    phaseAt: (t) => wrapped + rate * t,
    alpha: 2 * Math.PI * (frac - 0.5) / n,   // following the nearest flight
  }
}

const dt = 1 / 60
const sample = (rate, seconds, options, duration = 0.6) => {
  const out = []
  for (let t = 0; t < seconds; t += dt / 4) out.push({ t, ...grapplerPose(grappler(t, rate, options), duration) })
  return out
}

test('the pad moves smoothly at 60 fps: no channel jumps between frames', () => {
  for (const rate of [0.3, 1, 2]) {
    const poses = sample(rate, 2 / rate)
    for (let i = 4; i < poses.length; i += 4) {
      const a = poses[i - 4], b = poses[i]
      for (const key of ['lift', 'raise', 'neutral']) assert.ok(Math.abs(b[key] - a[key]) < 0.25, `rate ${rate}, t ${b.t.toFixed(3)}: ${key} ${a[key]} -> ${b[key]}`)
      // Following a flight, or moving one flight spacing (pi / 4) within the hop.
      assert.ok(Math.abs(b.alpha - a.alpha) < 0.1, `rate ${rate}, t ${b.t.toFixed(3)}: alpha ${a.alpha} -> ${b.alpha}`)
    }
  }
})

test('the movements start in order (lift, raise, untwist, move) and return in reverse, without pausing', () => {
  const poses = sample(1, 2)
  const firstAbove = (key, level, from = 0) => poses.findIndex((p, i) => i >= from && p[key] > level)
  // A whole hop: the first detachment after the pad has been attached.
  const start = poses.findIndex((p, i) => i > 0 && !p.attached && poses[i - 1].attached)
  assert.ok(start >= 0)
  const lift = firstAbove('lift', 0.01, start), raise = firstAbove('raise', 0.01, start), untwist = firstAbove('neutral', 0.01, start)
  assert.ok(lift <= raise && raise < untwist, `starts: lift ${lift}, raise ${raise}, untwist ${untwist}`)
  const end = poses.findIndex((p, i) => i > start && p.attached)
  // Twisting back finishes before lowering finishes, which finishes before the pad lands.
  const lastAbove = (key, level) => { for (let i = end; i > start; i--) if (poses[i][key] > level) return i; return -1 }
  assert.ok(lastAbove('neutral', 0.01) < lastAbove('raise', 0.01) && lastAbove('raise', 0.01) <= lastAbove('lift', 0.01))
  // Something is always moving.
  for (let i = start + 4; i < end; i += 4) {
    const a = poses[i - 4], b = poses[i]
    const moved = ['lift', 'raise', 'neutral', 'alpha'].some(key => Math.abs(b[key] - a[key]) > 1e-4)
    assert.ok(moved, `still at t ${b.t.toFixed(3)}`)
  }
})

test('a hop takes the switchover time, and stretches (without stopping) when there is more time', () => {
  // The length of the first whole hop.
  const detached = (rate, options) => {
    const poses = sample(rate, 3 / rate, options)
    const start = poses.findIndex((p, i) => i > 0 && !p.attached && poses[i - 1].attached)
    const end = poses.findIndex((p, i) => i > start && p.attached)
    return (end - start) * dt / 4
  }
  // With full range (n L = 0.5) the grappler is out of range only at the boundary: the hop is 0.6 s.
  assert.ok(Math.abs(detached(0.5, { limit: 0.0625 }) - 0.6) < 0.03)
  // With less range the free time is longer, and the hop fills it.
  assert.ok(detached(0.5, { limit: 0.03 }) > 0.6)
})

test('parking and unparking are smooth too', () => {
  const poses = sample(0.2, 3, { engagedFrom: 1 })
  assert.deepEqual(poses[0], { t: 0, lift: 1, raise: 1, neutral: 1, alpha: 0, attached: false })
  for (let i = 4; i < poses.length; i += 4) {
    const a = poses[i - 4], b = poses[i]
    for (const key of ['lift', 'raise', 'neutral']) assert.ok(Math.abs(b[key] - a[key]) < 0.25, `t ${b.t.toFixed(3)}: ${key}`)
    assert.ok(Math.abs(b.alpha - a.alpha) < 0.1, `t ${b.t.toFixed(3)}: alpha ${a.alpha} -> ${b.alpha}`)
  }
  // It lands on a flight as soon as it may grip (and is in range).
  const landed = poses.find(p => p.attached)
  assert.ok(landed && landed.t >= 1 && landed.t < 1.4, `landed at ${landed?.t}`)
})
