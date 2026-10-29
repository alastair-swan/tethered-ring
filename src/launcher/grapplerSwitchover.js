import { GrapplerSchedule, effectivePhase } from './grapplerSchedule.js'

// The adaptive nut's grapplers hop from flight to flight of the screw. Which flight each grips, and
// when, comes from GrapplerSchedule (grapplerSchedule.js); between two grips the grappler:
//
//   detaches (lifts off the flight's face) -> raises (radially, clear of the flights) -> untwists ->
//   moves round to the next flight -> twists to match it -> lowers -> attaches
//
// The movements flow into one another: each has its own smooth curve over the hop (PROFILE), starting
// before the previous one has finished, so the pad never stops between them. A hop takes
// switchoverTime whatever the screw's or vehicle's speed. It is centred on the time between the grips:
// if that is shorter, the grappler detaches early and attaches late (by up to half of each grip, so
// neighbouring hops never overlap); if it is longer, the hop is stretched (up to MAX_STRETCH times) and
// beyond that the grappler parks (as below) between the two. Before its first grip and after its last it
// is parked, raised and untwisted at the middle of its travel, and it leaves and returns there with the
// first and second halves of the same movements.

// When each movement runs, as fractions of the hop (the return movements mirror these about 0.5), and
// when the pad's angle hands over from following the old flight to following the new one.
export const PROFILE = {
  lift: [0, 0.25],
  raise: [0.05, 0.35],
  untwist: [0.1, 0.45],
  slow: [0.03, 0.35],      // the pad stops following the old flight
  move: [0.2, 0.8],        // handover from the old flight to the new
}
const MAX_STRETCH = 3
const ROOM = 0.9

const smoothstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x) }
const smootherstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (6 * x - 15) + 10) }
// Position while a speed eases from 1 to 0 over unit time: the integral of 1 - smoothstep.
const easeOut = (x) => { x = Math.min(1, Math.max(0, x)); return x - x * x * x + x * x * x * x / 2 }
const ramp = ([from, to], p) => smoothstep((p - from) / (to - from))
// A movement out (rising over its window) and back (falling over the mirrored window).
const outAndBack = (window, p) => Math.min(ramp(window, p), ramp(window, 1 - p))

// The pad's angle while it leaves a flight it was following (`follow(t)`: angle at time t), from time
// `start`: following, then slowing to a stop over `slow` s, then holding. `arriving` mirrors it
// (speeding up from a hold to follow, from time `end` on). It slows (or speeds up) sooner where it would
// otherwise go beyond `low` or `high`, and carries on at no more than `fastest` (rad/s; flights the
// schedule lets it grip move no faster).
const stopping = (angle, speed, slow, low, high) => {
  const room = speed > 0 ? high - angle : angle - low
  return Math.max(1e-6, Math.min(slow, 2 * Math.max(0, room) / Math.max(1e-9, Math.abs(speed))))
}
function leaving(follow, start, slow, low, high, fastest) {
  const angle = follow(start), speed = Math.max(-fastest, Math.min(fastest, (follow(start + 1e-3) - angle) / 1e-3))
  slow = stopping(angle, speed, slow, low, high)
  return (t) => t <= start ? follow(t) : angle + speed * slow * easeOut((t - start) / slow)
}
function arriving(follow, end, slow, low, high, fastest) {
  const angle = follow(end), speed = Math.max(-fastest, Math.min(fastest, (follow(end + 1e-3) - angle) / 1e-3))
  slow = stopping(angle, -speed, slow, low, high)
  return (t) => t >= end ? follow(t) : angle - speed * slow * easeOut((end - t) / slow)
}

// The pose of grappler i of a nut `time` s after its launch. schedule: GrapplerSchedule. g: {
//   threadStarts: n (flights round the screw here),
//   phase(): its thread phase now, in cycles within [0, n) (flight m at m + 0.5),
//   alpha: its angle (radians, from the middle of its travel) if following the nearest flight,
// } (see effectivePhase), switchoverTime: how long a hop takes (s). Returns {lift, raise, neutral, alpha, attached}: lift and
// raise from 0 (on the flight) to 1, neutral from 0 (twisted to the flight's pitch) to 1 (untwisted),
// alpha its angle, attached whether it grips a flight.
export function scheduledGrapplerPose(schedule, i, time, g, switchoverTime, out = {}) {
  const n = g.threadStarts
  const u0 = effectivePhase(g)
  // Its phase t s from now, unwrapped to continue the schedule's numbering of the flights (flight m is at
  // m + 0.5): now, its own; at other times, the schedule's (which has the nut's lead), moved to match now.
  const scheduled = schedule.phaseAt(i, time, n)
  const now = u0 + n * Math.round((scheduled - u0) / n)
  const phaseAt = (t) => t === 0 ? now : schedule.phaseAt(i, time + t, n) + now - scheduled
  // Angles are from the middle of its travel, fixed to the nut (where it is parked).
  const alphaOn = (flight, u) => 2 * Math.PI * (u - flight - 0.5) / n
  const parkedAt = () => 0
  // Never beyond its range of motion (the schedule keeps it within, and hops stop short of it, by
  // ROOM of it; this is a guard).
  const limit = 2 * Math.PI * schedule.holdLimit
  const low = -ROOM * limit, high = ROOM * limit
  const inRange = (alpha) => Math.min(limit, Math.max(-limit, alpha))
  const length = switchoverTime
  const fastest = 2 * Math.PI * schedule.fastestDrift() / n
  const handover = (from, to) => (q) => smootherstep((q - from) / (to - from))

  const grips = schedule.grips[i]
  const index = schedule.gripIndexAt(i, time)
  // The hops next to now: into grip `index` (from the one before) and out of it (to the one after).
  for (const next of [index + 1, index]) {
    const before = grips[next - 1], after = grips[next]
    if (!before && !after) continue
    // Free from `from` to `to` (s, relative to now).
    const from = before ? before.end - time : -Infinity
    const to = after ? after.start - time : Infinity
    if (!(from <= to)) continue
    const free = to - from
    // Free for longer than a stretched hop: it parks, and leaves for its next grip from there (which it
    // does whether or not the schedule has the next grip yet).
    const long = free > MAX_STRETCH * length
    const parkedBefore = !before || (long && -from > to), parkedAfter = !after || (long && -from <= to)
    const wanted = (parkedBefore || parkedAfter) ? length : Math.min(Math.max(free, length), MAX_STRETCH * length)
    const extra = Math.max(0, wanted - free) / 2
    const start = parkedBefore ? to - length : from - Math.min(extra, (before.end - before.start) / 2)
    const end = parkedAfter ? from + length : to + Math.min(extra, (after.end === Infinity ? Infinity : after.end - after.start) / 2)
    if (!(start <= 0 && 0 <= end)) continue
    const span = Math.min(end - start, wanted)
    const p = parkedBefore ? Math.max(0.5, 1 - end / span) : parkedAfter ? Math.min(0.5, -start / span)
      : -start < span / 2 ? -start / span : end < span / 2 ? 1 - end / span : 0.5
    const slow = (PROFILE.slow[1] - PROFILE.slow[0]) * span
    const leave = parkedBefore ? parkedAt
      : leaving((t) => alphaOn(GrapplerSchedule.flightAt(before, before.end, n), phaseAt(t)), start + PROFILE.slow[0] * span, slow, low, high, fastest)
    const arrive = parkedAfter ? parkedAt
      : arriving((t) => alphaOn(GrapplerSchedule.flightAt(after, after.start, n), phaseAt(t)), end - PROFILE.slow[0] * span, slow, low, high, fastest)
    const w = parkedBefore ? handover(0.5, PROFILE.move[1])(p)
      : parkedAfter ? handover(PROFILE.move[0], 0.5)(p)
      : handover(PROFILE.move[0], PROFILE.move[1])(p)
    const lift = outAndBack(PROFILE.lift, p), raise = outAndBack(PROFILE.raise, p), neutral = outAndBack(PROFILE.untwist, p)
    return Object.assign(out, { lift, raise, neutral, alpha: inRange(leave(0) * (1 - w) + arrive(0) * w), attached: false })
  }
  const grip = grips[index]
  if (grip && time < grip.end) return Object.assign(out, { lift: 0, raise: 0, neutral: 0, alpha: inRange(alphaOn(GrapplerSchedule.flightAt(grip, time, n), phaseAt(0))), attached: true })
  return Object.assign(out, { lift: 1, raise: 1, neutral: 1, alpha: parkedAt(0), attached: false })
}
