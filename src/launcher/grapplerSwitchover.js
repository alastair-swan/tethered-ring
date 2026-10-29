// The adaptive nut's grapplers hop from flight to flight of the screw. Each grappler rides a flight
// (following it round the screw) until the flight carries it out of its range of motion, then:
//
//   detach (lift off the flight's face) -> raise (radially, clear of the flights) -> turn to neutral
//   (pad untwisted) -> move to the next flight -> turn to match it -> lower -> attach
//
// Every step takes a fixed time (a share of the switchover duration), with smooth starts and stops,
// whatever the screw's or vehicle's speed. The steps are placed around the stretch of time during
// which the grappler is out of range of both flights: if that is longer than the sequence the
// grappler waits, raised and neutral, between turning and moving (and between moving and turning);
// if it is shorter, the grappler detaches early (still within range) so that the whole sequence fits.
// Only where the hops come closer together than the sequence itself is the sequence shortened.
//
// Everything is a pure function of the grappler's thread phase over time (see SledGrapplerGeometry's
// phaseAt), so the animation is deterministic.

// Shares of the switchover duration: detach, raise, turn and move; then turn, lower, attach mirror the
// first three. (2 * (detach + raise + turn) + move = 1.)
export const SWITCHOVER_SHARES = { detach: 0.1, raise: 0.15, turn: 0.1, move: 0.3 }

// How far from now the ends of a free interval are looked for (a grappler waits, raised, no longer
// than this for the next flight; beyond it the wait is taken to go on).
const MAX_FREE_SECONDS = 120

const smoothstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x) }
const smootherstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (6 * x - 15) + 10) }
// Position while a speed eases from 1 to 0 over unit time: the integral of 1 - smoothstep.
const easeOut = (x) => { x = Math.min(1, Math.max(0, x)); return x - x * x * x + x * x * x * x / 2 }

// The free interval: the stretch of time (relative to now) around the hop over flight boundary k
// during which the grappler's phase u is within `reach` (cycles) of k, so out of range of both
// flights. A point of it is looked for within `limit` seconds of now (scanning in `step`s); its ends
// are then found by searching outwards (in growing steps, up to MAX_FREE_SECONDS) and bisection.
// Returns [from, to], or null if u does not come within reach of k within `limit` of now.
function freeInterval(phaseAt, k, reach, limit, step) {
  const free = (t) => Math.abs(phaseAt(t) - k) <= reach
  const crosses = (a, b) => (phaseAt(a) - k) * (phaseAt(b) - k) <= 0
  // A point inside: now, or the first sample (or crossing of k) found scanning both ways.
  let inside = null
  if (free(0)) inside = 0
  for (let i = 1; inside === null && i * step <= limit; i++) {
    for (const t of [i * step, -i * step]) {
      if (free(t)) { inside = t; break }
      const previous = t > 0 ? t - step : t + step
      if (crosses(previous, t)) { inside = bisect((x) => phaseAt(x) - k, previous, t); break }
    }
  }
  if (inside === null) return null
  const edge = (direction) => {
    let a = inside, b = inside
    let s = step
    while (Math.abs(b) < MAX_FREE_SECONDS && (free(b) || b === inside)) { a = b; b += direction * s; s *= 1.5 }
    if (free(b)) return b
    return bisect((x) => Math.abs(phaseAt(x) - k) - reach, a, b)
  }
  return [edge(-1), edge(1)]
}

function bisect(f, a, b) {
  let fa = f(a)
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2
    const fm = f(m)
    if ((fm <= 0) === (fa <= 0)) { a = m; fa = fm } else b = m
  }
  return (a + b) / 2
}

// The pose of one grappler now. g: {
//   engageable: whether it may grip the screw here at all (otherwise it is parked: raised, neutral,
//     at its mid position),
//   threadStarts: n (flights round the screw),
//   phase(): its thread phase now, in cycles (a whole number at each point halfway between flights),
//   phaseAt(t): its thread phase t seconds from now,
//   rotationAwayLimit: how far from its mid position it may follow a flight (rotations),
//   alpha: its angle from its mid position now if it is following the flight it is nearest (radians),
// }, duration: the switchover duration (s). Returns {lift, raise, neutral, alpha, attached}: lift and
// raise from 0 (on the flight) to 1, neutral from 0 (twisted to the flight's pitch) to 1 (untwisted),
// alpha its angle from its mid position (radians), attached whether it grips a flight.
export function grapplerPose(g, duration, out = {}) {
  if (!g.engageable) return Object.assign(out, { lift: 1, raise: 1, neutral: 1, alpha: 0, attached: false })
  const n = g.threadStarts
  const phaseAt = (t) => g.phaseAt(t)
  const u0 = g.phase()
  const k = Math.round(u0)
  // Out of range of both flights within `reach` cycles of the boundary between them.
  const reach = Math.max(0, 0.5 - n * g.rotationAwayLimit)
  // The angle of the grappler following the flight below (-1) or above (+1) boundary k, at phase u.
  const alpha0 = g.alpha - 2 * Math.PI * ((u0 - k) + (u0 < k ? 0.5 : -0.5)) / n
  const alphaOn = (side, u) => alpha0 + 2 * Math.PI * ((u - k) + (side < 0 ? 0.5 : -0.5)) / n
  const attachedPose = () => Object.assign(out, { lift: 0, raise: 0, neutral: 0, alpha: g.alpha, attached: true })

  // Shorten the sequence where the hops come closer together than it.
  const rate = Math.abs(phaseAt(1e-3) - u0) / 1e-3
  const period = rate > 0 ? 1 / rate : Infinity
  const length = Math.min(duration, 0.8 * period)
  const interval = freeInterval(phaseAt, k, reach, Math.max(length, 0.1), length / 20)
  if (!interval) return attachedPose()
  const middle = (interval[0] + interval[1]) / 2
  const start = Math.min(interval[0], middle - length / 2)
  const end = Math.max(interval[1], middle + length / 2)
  if (!(start <= 0 && 0 <= end)) return attachedPose()

  const s = SWITCHOVER_SHARES
  const [detach, raise, turn, move] = [s.detach, s.raise, s.turn, s.move].map(share => share * length)
  const sideAt = (t) => Math.sign(phaseAt(t) - k) || 1
  const fromSide = sideAt(start), toSide = sideAt(end)
  // Leaving: following the old flight while detaching, then slowing to a stop while raised.
  const t1 = start + detach
  const leaveAlpha = alphaOn(fromSide, phaseAt(t1))
  const leaveSpeed = (alphaOn(fromSide, phaseAt(t1 + 1e-3)) - leaveAlpha) / 1e-3
  const holdFrom = leaveAlpha + leaveSpeed * raise / 2
  // Arriving: the mirror image, on the new flight.
  const t4 = end - detach
  const arriveAlpha = alphaOn(toSide, phaseAt(t4))
  const arriveSpeed = (alphaOn(toSide, phaseAt(t4 + 1e-3)) - arriveAlpha) / 1e-3
  const holdTo = arriveAlpha - arriveSpeed * raise / 2

  const t = 0 - start
  const T = end - start
  let lift = 1, up = 1, neutral = 1, alpha
  if (t < detach) {                                   // detach
    lift = smoothstep(t / detach); up = 0; neutral = 0
    alpha = alphaOn(fromSide, u0)
  } else if (t < detach + raise) {                    // raise, slowing to a stop
    const x = (t - detach) / raise
    up = smoothstep(x); neutral = 0
    alpha = leaveAlpha + leaveSpeed * raise * easeOut(x)
  } else if (t < detach + raise + turn) {             // turn to neutral
    neutral = smoothstep((t - detach - raise) / turn)
    alpha = holdFrom
  } else if (t <= T - detach - raise - turn) {        // wait, move to the next flight, wait
    const moveStart = (T - move) / 2
    alpha = holdFrom + (holdTo - holdFrom) * smootherstep((t - moveStart) / move)
  } else if (t < T - detach - raise) {                // turn to match the new flight
    neutral = 1 - smoothstep((t - (T - detach - raise - turn)) / turn)
    alpha = holdTo
  } else if (t < T - detach) {                        // lower, speeding up to follow the new flight
    const x = (t - (T - detach - raise)) / raise
    up = 1 - smoothstep(x); neutral = 0
    alpha = arriveAlpha - arriveSpeed * raise * easeOut(1 - x)
  } else {                                            // attach
    lift = 1 - smoothstep((t - (T - detach)) / detach); up = 0; neutral = 0
    alpha = alphaOn(toSide, u0)
  }
  return Object.assign(out, { lift, raise: up, neutral, alpha, attached: false })
}
