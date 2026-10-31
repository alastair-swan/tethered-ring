// How an adaptive nut's grappler moves between flights of the screw (which flight it holds, and when, is
// grapplerLattice.js's). Between two grips it:
//
//   detaches (lifts off the flight's face) -> raises (radially, clear of the flights) -> untwists ->
//   moves round to the next flight -> twists to match it -> lowers -> attaches
//
// The movements flow into one another: each has its own smooth curve over the hop (PROFILE), starting
// before the previous one has finished, so the pad never stops between them. Where a grappler starts or
// stops gripping, it leaves from or returns to its parked pose (raised and untwisted at the middle of its
// travel) with the first or second half of the same movements.

// When each movement runs, as fractions of the hop (the return movements mirror these about 0.5), and
// when the pad's angle hands over from following the old flight to following the new one.
export const PROFILE = {
  lift: [0, 0.25],
  raise: [0.05, 0.35],
  untwist: [0.1, 0.45],
  slow: [0.03, 0.35],      // the pad stops following the old flight
  move: [0.2, 0.8],        // handover from the old flight to the new
}

const smoothstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x) }
export const smootherstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (6 * x - 15) + 10) }
// Position while a speed eases from 1 to 0 over unit time: the integral of 1 - smoothstep.
const easeOut = (x) => { x = Math.min(1, Math.max(0, x)); return x - x * x * x + x * x * x * x / 2 }
const ramp = ([from, to], p) => smoothstep((p - from) / (to - from))
// A movement out (rising over its window) and back (falling over the mirrored window).
export const outAndBack = (window, p) => Math.min(ramp(window, p), ramp(window, 1 - p))

// The pad's angle while it leaves a flight it was following (`follow(t)`: angle at time t), from time
// `start`: following, then slowing to a stop over `slow` s, then holding. `arriving` mirrors it
// (speeding up from a hold to follow, from time `end` on). It slows (or speeds up) sooner where it would
// otherwise go beyond `low` or `high`, and carries on at no more than `fastest` (rad/s; flights it may
// grip move no faster).
const stopping = (angle, speed, slow, low, high) => {
  const room = speed > 0 ? high - angle : angle - low
  return Math.max(1e-6, Math.min(slow, 2 * Math.max(0, room) / Math.max(1e-9, Math.abs(speed))))
}
export function leaving(follow, start, slow, low, high, fastest) {
  const angle = follow(start), speed = Math.max(-fastest, Math.min(fastest, (follow(start + 1e-3) - angle) / 1e-3))
  slow = stopping(angle, speed, slow, low, high)
  return (t) => t <= start ? follow(t) : angle + speed * slow * easeOut((t - start) / slow)
}
export function arriving(follow, end, slow, low, high, fastest) {
  const angle = follow(end), speed = Math.max(-fastest, Math.min(fastest, (follow(end + 1e-3) - angle) / 1e-3))
  slow = stopping(angle, -speed, slow, low, high)
  return (t) => t >= end ? follow(t) : angle - speed * slow * easeOut((end - t) / slow)
}
