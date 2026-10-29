import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grapplerPose, SWITCHOVER_SHARES } from '../../src/launcher/grapplerSwitchover.js'

// A grappler whose thread phase drifts at a steady `rate` (cycles per second), sampled at time `time`.
function grappler(time, rate, { n = 8, limit = 0.04, phase0 = 0.3 } = {}) {
  const u = (t) => phase0 + rate * (time + t)
  const wrapped = ((u(0) % n) + n) % n
  const frac = wrapped - Math.floor(wrapped)
  return {
    engageable: true,
    threadStarts: n,
    rotationAwayLimit: limit,
    phase: () => wrapped,
    phaseAt: (t) => wrapped + rate * t,
    alpha: 2 * Math.PI * (frac - 0.5) / n,   // following the nearest flight
  }
}

// Samples the pose over `seconds` and returns the steps seen, in order, with how long each lasted.
function steps(rate, duration, seconds, dt = 1e-4) {
  const out = []
  const stepOf = (p) => p.attached ? 'attached'
    : p.raise === 0 ? 'lift'
    : p.raise < 1 ? 'raise'
    : p.neutral < 1 ? 'turn'
    : 'raised'
  let previous = null
  for (let t = 0; t < seconds; t += dt) {
    const p = grapplerPose(grappler(t, rate), duration)
    const s = stepOf(p)
    if (s !== previous) { out.push([s, 0]); previous = s }
    out[out.length - 1][1] += dt
  }
  return out
}

test('the hop runs detach, raise, turn, move, turn, lower, attach with fixed step times at any drift rate', () => {
  const duration = 0.1
  const sh = SWITCHOVER_SHARES
  for (const rate of [0.5, 2, 6]) {
    // From attached, through one hop, to attached again.
    const seen = steps(rate, duration, 1.2 / rate).filter(([, len]) => len > 2e-4)
    const names = seen.map(([s]) => s)
    const first = names.indexOf('lift')
    // ('raised' covers waiting, moving to the next flight, and waiting.)
    assert.deepEqual(names.slice(first, first + 8), ['lift', 'raise', 'turn', 'raised', 'turn', 'raise', 'lift', 'attached'], `rate ${rate}: ${names.join(' ')}`)
    const lengths = seen.slice(first, first + 7).map(([, len]) => len)
    for (const [i, share] of [[0, sh.detach], [1, sh.raise], [2, sh.turn], [4, sh.turn], [5, sh.raise], [6, sh.detach]]) {
      assert.ok(Math.abs(lengths[i] - share * duration) < 2e-3, `rate ${rate}, step ${i}: ${lengths[i]} s, want ${share * duration}`)
    }
  }
})

test('the grappler moves continuously, without jumps', () => {
  for (const rate of [0.5, 3]) {
    let previous = null
    const dt = 1e-4
    for (let t = 0; t < 1.5 / rate; t += dt) {
      const p = grapplerPose(grappler(t, rate), 0.1)
      if (previous) {
        // Following a flight, the angle moves at 2 pi rate / n; the hop moves 2 pi / n in 0.03 s.
        assert.ok(Math.abs(p.alpha - previous.alpha) < 2 * Math.PI / 8 * dt * (rate + 70), `t ${t}: alpha ${previous.alpha} -> ${p.alpha}`)
        // A smoothstep over the shortest step (detach: 0.01 s) changes at most 1.5 / 0.01 per second.
        for (const key of ['lift', 'raise', 'neutral']) assert.ok(Math.abs(p[key] - previous[key]) < dt * 160, `t ${t}: ${key}`)
      }
      previous = p
    }
  }
})

test('a grappler that cannot engage is parked: raised, untwisted, at its mid position', () => {
  const g = { ...grappler(0, 1), engageable: false }
  assert.deepEqual(grapplerPose(g, 0.1), { lift: 1, raise: 1, neutral: 1, alpha: 0, attached: false })
})
