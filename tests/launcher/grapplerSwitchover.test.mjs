import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduledGrapplerPose } from '../../src/launcher/grapplerSwitchover.js'
import { GrapplerSchedule } from '../../src/launcher/grapplerSchedule.js'

const switchoverTime = 0.6
const holdLimit = 0.125

// Grapplers whose thread phases (cycles, n flights) drift steadily: grappler i starts at phases[i] and
// drifts at rates[i] (cycles/s); the nut's lead moves every phase by perMetre cycles/m. engagedFrom: before
// this time none may grip.
function schedule({ phases, rates, n = 8, perMetre = 0, end = 20, engagedFrom = 0, maxLead = 0, maxLeadAcceleration = 0, gapCost }) {
  const phaseAt = (i, t, lead) => phases[i] + rates[i] * t + perMetre * lead
  const sampleAt = (t, lead) => phases.map((_, i) => ({
    phase: ((phaseAt(i, t, lead) % n) + n) % n, rate: rates[i] / n, n, engageable: t >= engagedFrom,
  }))
  const s = new GrapplerSchedule(sampleAt, end, { holdLimit, switchoverTime, maxLead, maxLeadAcceleration, gapCost })
  // Grappler i as the nut sees it at `time`: its phase, and its angle following the nearest flight
  // (with the middle of its travel at 0).
  s.grappler = (i, time) => {
    const u = ((phaseAt(i, time, s.leadAt(time)) % n) + n) % n
    return { threadStarts: n, phase: () => u, alpha: 2 * Math.PI * ((u - Math.floor(u)) - 0.5) / n }
  }
  return s
}

const dt = 1 / 60
const poses = (s, i, seconds) => {
  const out = []
  for (let t = 0; t < seconds; t += dt) out.push({ t, ...scheduledGrapplerPose(s, i, t, s.grappler(i, t), switchoverTime) })
  return out
}
// Free spells between grips (s).
const hops = (list) => {
  const out = []
  let from = null
  list.forEach((p, k) => {
    if (k > 0 && list[k - 1].attached && !p.attached) from = p.t
    if (from !== null && p.attached) { out.push(p.t - from); from = null }
  })
  return out
}

test('the pad moves smoothly at 60 fps, and never beyond its range of motion', () => {
  for (const rate of [0.3, 1, 1.3]) {
    const s = schedule({ phases: [0.3], rates: [rate], engagedFrom: 1 })
    const list = poses(s, 0, 12)
    assert.deepEqual(list[0], { t: 0, lift: 1, raise: 1, neutral: 1, alpha: 0, attached: false })
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1], b = list[k]
      for (const key of ['lift', 'raise', 'neutral']) assert.ok(Math.abs(b[key] - a[key]) < 0.2, `rate ${rate}, t ${b.t.toFixed(3)}: ${key} ${a[key]} -> ${b[key]}`)
      // (A hop may move the pad across its whole travel, 2 * holdLimit, in the switchover time.)
      assert.ok(Math.abs(b.alpha - a.alpha) < 0.15, `rate ${rate}, t ${b.t.toFixed(3)}: alpha ${a.alpha} -> ${b.alpha}`)
      assert.ok(Math.abs(b.alpha) <= 0.95 * 2 * Math.PI * holdLimit, `rate ${rate}, t ${b.t.toFixed(3)}: alpha ${b.alpha}`)
    }
    assert.ok(list.some(p => p.attached))
  }
})

test('the movements start in order (lift, raise, untwist) and return in reverse, without pausing', () => {
  const list = poses(schedule({ phases: [0.3], rates: [1] }), 0, 6)
  const start = list.findIndex((p, k) => k > 0 && !p.attached && list[k - 1].attached)
  assert.ok(start >= 0)
  const firstAbove = (key) => list.findIndex((p, k) => k >= start && p[key] > 0.01)
  assert.ok(firstAbove('lift') <= firstAbove('raise') && firstAbove('raise') < firstAbove('neutral'))
  const end = list.findIndex((p, k) => k > start && p.attached)
  const lastAbove = (key) => { for (let k = end; k > start; k--) if (list[k][key] > 0.01) return k; return -1 }
  assert.ok(lastAbove('neutral') < lastAbove('raise') && lastAbove('raise') <= lastAbove('lift'))
  for (let k = start + 1; k < end; k++) {
    assert.ok(['lift', 'raise', 'neutral', 'alpha'].some(key => Math.abs(list[k][key] - list[k - 1][key]) > 1e-4), `still at t ${list[k].t.toFixed(3)}`)
  }
})

test('a grappler keeps its flight across its whole range, and every hop takes the switchover time', () => {
  const rate = 0.5
  const s = schedule({ phases: [0.5], rates: [rate] })
  s.extendTo(20)
  // Full range: n * holdLimit = 1 cycle either side, less the margins.
  const grips = s.grips[0].filter(g => g.end !== Infinity).slice(1)
  for (const g of grips) assert.ok(g.end - g.start > 1.5 / rate, `grip ${g.start}..${g.end}`)
  for (const h of hops(poses(s, 0, 20))) assert.ok(h >= switchoverTime - 1e-6, `hop of ${h} s`)
})

test('a run of neighbours reaching the end of their travel together moves over a few at a time', () => {
  // Twelve grapplers on one flight, all drifting together: left to their deadlines they would all let go
  // at once.
  const count = 12
  const s = schedule({ phases: Array.from({ length: count }, (_, i) => 0.5 + 0.01 * i), rates: new Array(count).fill(0.5) })
  let fewest = Infinity
  for (let t = 1; t < 15; t += 1 / 30) {
    const gripping = s.grips.filter((grips, i) => { const g = grips[s.gripIndexAt(i, t)]; return g && t < g.end }).length
    fewest = Math.min(fewest, gripping)
  }
  assert.ok(fewest >= count - 5, `as few as ${fewest} gripping`)
  // And none was carried beyond its reach: every grip ended at or before the end of its travel.
  for (let i = 0; i < count; i++) {
    for (const g of s.grips[i].filter(g => g.end < 15)) assert.ok(s.phaseAt(i, g.end) - g.flight - 0.5 <= 8 * holdLimit, `grappler ${i} at ${g.end}`)
  }
})

test('where gaps cost more, grapplers drifting opposite ways use the same half of their travel', () => {
  // A nut whose phases fall 0.12 cycles per grappler along it, drifting one way at its front and the other
  // at its back (changing over a third of the way along, not in the middle).
  const count = 24
  const phases = Array.from({ length: count }, (_, i) => 3 - 0.12 * i)
  const rates = Array.from({ length: count }, (_, i) => 0.03 * (i - count / 3) / (count / 2))
  // Where the gripping grapplers drifting to lower phases are in their travel (cycles from the middle).
  const offsets = (s, t) => {
    const out = []
    for (let i = 0; i < count; i++) {
      const g = s.grips[i][s.gripIndexAt(i, t)]
      if (rates[i] < 0 && g && t < g.end) out.push(s.phaseAt(i, t) - g.flight - 0.5)
    }
    return out
  }
  const lowest = (s) => Math.min(...[60, 70, 80, 90].flatMap(t => offsets(s, t)))
  // By default they use the half of their travel behind the middle, as they drift (towards lower phases):
  // the other half from those drifting the other way.
  assert.ok(lowest(schedule({ phases, rates, end: 100 })) < -0.5)
  // Where gaps cost more, they hop early (as soon as the next flight is within reach) and use the half
  // towards higher phases, as those drifting the other way do.
  const arranged = schedule({ phases, rates, end: 100, gapCost: () => 10 })
  assert.ok(lowest(arranged) > -0.3, `as low as ${lowest(arranged)}`)
})

test('the lead stays within its limits, is back to none at the end, and does not cost grip time', () => {
  // Every grappler drifting the same way: the lead can follow them for a while.
  const options = { phases: [0.4, 0.5, 0.6, 0.5], rates: [0.25, 0.25, 0.25, 0.25], perMetre: 0.5, end: 30 }
  const without = schedule(options)
  const withLead = schedule({ ...options, maxLead: 2, maxLeadAcceleration: 0.2 })
  without.extendTo(30)
  withLead.extendTo(30)
  const gripping = (s) => s.grips.flat().reduce((sum, g) => sum + Math.min(g.end, 30) - g.start, 0)
  assert.ok(gripping(withLead) >= gripping(without), `${gripping(withLead)} s gripping with the lead, ${gripping(without)} without`)
  let previous = 0, previousRate = 0
  for (let t = 0; t <= 30; t += 0.01) {
    const lead = withLead.leadAt(t)
    // (It may overshoot by a hair as it settles.)
    assert.ok(Math.abs(lead) <= 2 + 1e-3, `lead ${lead} at ${t}`)
    const rate = (lead - previous) / 0.01
    if (t > 0.02) assert.ok(Math.abs(rate - previousRate) / 0.01 < 0.2 * 1.5, `acceleration at ${t}`)
    previous = lead
    previousRate = rate
  }
  assert.equal(withLead.leadAt(30), 0)
  assert.ok(Math.abs(withLead.leadAt(29.9)) < 0.01)
})

test('flights keep their angles when the screw adds flights', () => {
  const grip = { flight: 5, n: 4, renumbered: [{ time: 2, flight: 2, n: 2 }] }
  assert.equal(GrapplerSchedule.flightAt(grip, 1), 2)
  assert.equal(GrapplerSchedule.flightAt(grip, 3), 5)
  // Flight m of n is at phase m + 0.5: flight 2 of 2 is at 2.5 / 2 of a turn, as flight 5 of 4 (5.5 / 4)...
  assert.equal(GrapplerSchedule.flightAt(grip, 1, 4), 5)
  // ...and flight 5 of 4 is where flight 2 of 2 is.
  assert.equal(GrapplerSchedule.flightAt(grip, 3, 2), 2)
})
