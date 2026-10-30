import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GrapplerLatticePlan, latticeArrangement, latticeStep } from '../../src/launcher/grapplerLattice.js'

const switchoverTime = 0.6
const fastestDrift = 0.8 / switchoverTime
const wrap = (x, m) => x - m * Math.floor(x / m + 0.5)

// A nut whose grapplers' thread phases (cycles) are phase(i, t), with n(i, t) flights round the screw
// there: samples as the nut gives them, and each grappler's placement info for the pose.
function nut({ count, phase, n = () => 4, end = 40 }) {
  const rate = (i, t) => (phase(i, t + 1e-4) - phase(i, t)) / 1e-4   // cycles/s
  const sampleAt = (t) => Array.from({ length: count }, (_, i) => {
    const flights = n(i, t), u = ((phase(i, t) % flights) + flights) % flights
    return { phase: u, rate: rate(i, t) / flights, n: flights, engageable: true }
  })
  const g = (i, t) => {
    const flights = n(i, t), u = ((phase(i, t) % flights) + flights) % flights
    return { threadStarts: flights, phase: () => u, alpha: 2 * Math.PI * ((u - Math.floor(u)) - 0.5) / flights, rotationRate: rate(i, t) / flights }
  }
  return { sampleAt, g, end }
}
const planFor = (setup, holdLimit) => new GrapplerLatticePlan(setup.sampleAt, setup.end, { holdLimit, switchoverTime, fastestDrift })
// Runs (neighbours holding the same flight), and grapplers free, at grid step k.
function runsAndFree(plan, k) {
  const a = plan.arrangementAt(k)
  let runs = 0, free = 0
  a.forEach((g, i) => {
    if (g.flight === null) { free++; return }
    if (i === 0 || a[i - 1].flight === null || Math.abs(wrap(a[i - 1].flight - g.flight, 1)) > 1e-6) runs++
  })
  return { runs, free }
}

test('the lattice is the widest spacing of whole flights that fits in the travel', () => {
  assert.equal(latticeStep(0.125, 4), 0.25)   // travel spans one flight spacing exactly
  assert.equal(latticeStep(0.125, 8), 0.25)   // the same angle with more flights: two of them
  assert.equal(latticeStep(0.25, 4), 0.5)
  assert.equal(latticeStep(0.1, 4), 0)        // less than one spacing
})

test('at speed, the grapplers are in the fewest runs, with no more free than runs', () => {
  // 64 grapplers, 0.0385 cycles apart, drifting slowly (as at the fast end of the screw).
  const setup = nut({ count: 64, phase: (i, t) => 0.3 + 0.0385 * i + 0.01 * t })
  const plan = planFor(setup, 0.125)
  for (let k = 0; k < 600; k += 7) {
    const { runs, free } = runsAndFree(plan, k)
    // 2.46 cycles along the nut, a run spanning one: three runs, or four where the ends fall badly.
    assert.ok(runs <= 4, `${runs} runs at step ${k}`)
    assert.ok(free <= runs, `${free} free with ${runs} runs at step ${k}`)
  }
})

test('a grappler on its own is left free', () => {
  // The first grappler is a lattice step (a quarter turn) round from the rest: alone on its flight.
  const samples = [1.6, 0.6, 0.62, 0.64, 0.66].map(phase => ({ phase, rate: 0, n: 4, engageable: true }))
  const a = latticeArrangement(samples, { holdLimit: 0.125, fastestDrift, step: 0.25 })
  assert.equal(a[0].flight, null)
  assert.ok(a.slice(1).every(g => g.flight !== null && Math.abs(g.flight - a[1].flight) < 1e-9))
})

test('it is a function of time alone: the same answer in any order', () => {
  const setup = nut({ count: 24, phase: (i, t) => 0.2 + 0.07 * i + 0.3 * t })
  const times = Array.from({ length: 200 }, (_, k) => k * 0.05)
  const inOrder = planFor(setup, 0.125), shuffled = planFor(setup, 0.125)
  const forwards = times.map(t => Array.from({ length: 24 }, (_, i) => inOrder.pose(i, t, setup.g(i, t))))
  const order = [...times.keys()].sort((a, b) => ((a * 7919) % 200) - ((b * 7919) % 200))
  for (const k of order) {
    for (let i = 0; i < 24; i++) assert.deepEqual(shuffled.pose(i, times[k], setup.g(i, times[k])), forwards[k][i])
  }
})

test('the pad moves smoothly at 60 fps, never beyond its travel, and every hop takes the switchover time', () => {
  const holdLimit = 0.125
  const setup = nut({ count: 8, phase: (i, t) => 0.1 * i + 0.4 * t })
  const plan = planFor(setup, holdLimit)
  const dt = 1 / 60
  for (let i = 0; i < 8; i++) {
    let previous = null, freeFrom = null
    for (let t = 1; t < 30; t += dt) {
      const p = plan.pose(i, t, setup.g(i, t))
      assert.ok(Math.abs(p.alpha) <= 2 * Math.PI * holdLimit + 1e-9, `grappler ${i} at ${t.toFixed(3)}: alpha ${p.alpha}`)
      if (previous) {
        for (const key of ['lift', 'raise', 'neutral']) assert.ok(Math.abs(p[key] - previous[key]) < 0.2, `grappler ${i} at ${t.toFixed(3)}: ${key}`)
        assert.ok(Math.abs(p.alpha - previous.alpha) < 0.15, `grappler ${i} at ${t.toFixed(3)}: alpha ${previous.alpha} -> ${p.alpha}`)
        if (previous.attached && !p.attached) freeFrom = t
        if (!previous.attached && p.attached && freeFrom !== null) {
          assert.ok(t - freeFrom >= switchoverTime - 2 * dt, `grappler ${i}: a hop of ${(t - freeFrom).toFixed(3)} s`)
          freeFrom = null
        }
      }
      previous = p
    }
  }
})

test('a change of lattice sweeps along the nut, a few grapplers at a time', () => {
  // Travel spanning two flights: two lattices (even or odd flights). The phases along the nut move half
  // a flight over a few seconds, so that the better of the two changes.
  const count = 32
  const setup = nut({ count, phase: (i, t) => 0.04 * i + 0.5 * Math.min(1, Math.max(0, (t - 10) / 4)) })
  const plan = planFor(setup, 0.25)
  assert.equal(plan.latticeAt(0).step, 0.5)   // every second flight: two alignments
  let changes = 0
  for (let k = 1; k < 30 / (1 / 30); k++) {
    const a = plan.arrangementAt(k - 1), b = plan.arrangementAt(k)
    let moved = 0
    for (let i = 0; i < count; i++) if (a[i].flight !== b[i].flight) moved++
    changes += moved
    // (Never more than a few at one step.)
    assert.ok(moved <= 4, `${moved} grapplers changed flight at step ${k}`)
  }
  assert.ok(changes > 0)
})

test('grapplers share flights where the screw has more of them under part of the nut', () => {
  // The back half of the nut over a section with 8 flights, the front half over one with 4: the same
  // angles, numbered differently.
  const samples = Array.from({ length: 16 }, (_, i) => {
    const n = i < 8 ? 4 : 8, angle = 0.3 + 0.002 * i   // turns
    return { phase: angle * n - 0.5, rate: 0, n, engageable: true }
  })
  const a = latticeArrangement(samples, { holdLimit: 0.125, fastestDrift, step: 0.25 })
  assert.ok(a.every(g => g.flight !== null && Math.abs(g.flight - a[0].flight) < 1e-9), JSON.stringify(a.map(g => g.flight)))
})
