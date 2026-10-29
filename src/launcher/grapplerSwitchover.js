// The adaptive nut's grapplers hop from flight to flight of the screw. Each grappler rides a flight
// (following it round the screw) until the flight carries it out of its range of motion, then:
//
//   detach (lift off the flight's face) -> raise (radially, clear of the flights) -> untwist -> move
//   round to the next flight -> twist to match it -> lower -> attach
//
// The movements flow into one another: each has its own smooth curve over the hop (PROFILE), starting
// before the previous one has finished, so the pad never stops between them. A hop takes
// switchoverTime whatever the screw's or vehicle's speed. It is placed around the time during which the
// grappler is out of range of both flights: if that is shorter, the grappler detaches early (still in
// range) so the hop fits; if it is longer, the hop is stretched (up to MAX_STRETCH times) and only
// beyond that does the grappler wait, raised, midway.
//
// Grapplers that cannot grip (before the thread starts, or too far along the nut at low speed: see
// SledGrapplerPlacementInfo.engageableAt), or whose hops would come closer together than a hop takes
// (where the flights drift past fastest), are parked, raised and untwisted at their mid position; they
// leave and return to it with the first and second halves of the same movements.
//
// Everything is a pure function of the grappler's thread phase over time (phaseAt), so the animation is
// deterministic.

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
// Free stretches closer together than this (s) are joined: the grappler does not land between them.
const MIN_LANDING = 0.1
// How far from now the ends of a free interval are looked for (beyond this a wait is taken to go on).
const MAX_FREE_SECONDS = 120

const smoothstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x) }
const smootherstep = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (6 * x - 15) + 10) }
// Position while a speed eases from 1 to 0 over unit time: the integral of 1 - smoothstep.
const easeOut = (x) => { x = Math.min(1, Math.max(0, x)); return x - x * x * x + x * x * x * x / 2 }
const ramp = ([from, to], p) => smoothstep((p - from) / (to - from))
// A movement out (rising over its window) and back (falling over the mirrored window).
const outAndBack = (window, p) => Math.min(ramp(window, p), ramp(window, 1 - p))

// The free interval: the stretch of time (relative to now) during which the grappler holds no flight:
// it may not grip (it is parked), or it is out of range of both flights (its phase u within `reach`
// cycles of a whole number, halfway between two flights). With reach 0 that is only the moment u passes
// a whole number. Free stretches less than MIN_LANDING s apart are joined (landing on a flight for
// only a moment would look jerky). The nearest such stretches before and after now (or the one
// containing now) are looked for within `limit` s (scanning in `step`s); their ends are then found by
// searching outwards (in growing steps) and bisection. Returns a list of {from, to, before, after}:
// before and after are how long the grappler holds a flight before and after the stretch (Infinity
// if longer than `horizon` s), measured from the stretch itself, so the same from any now.
function freeIntervals(phaseAt, engagedAt, reach, limit, step, horizon) {
  const free = (t) => !engagedAt(t) || Math.abs(phaseAt(t) - Math.round(phaseAt(t))) <= reach
  // The first free point (or moment of passing a whole number) scanning from now towards `direction`.
  const firstFree = (direction) => {
    if (free(0)) return 0
    for (let i = 1; i * step <= limit; i++) {
      const t = direction * i * step, previous = t - direction * step
      if (free(t)) return t
      if (Math.floor(phaseAt(previous)) !== Math.floor(phaseAt(t))) {
        const whole = Math.max(Math.floor(phaseAt(previous)), Math.floor(phaseAt(t)))
        return bisect((x) => phaseAt(x) - whole, previous, t)
      }
    }
    return null
  }
  // The first free point within `range` s beyond `from` (towards `direction`), or null.
  const freeWithin = (from, direction, range) => {
    for (let t = from + direction * step; Math.abs(t - from) <= range; t += direction * step) {
      if (free(t)) return t
      const previous = t - direction * step
      if (Math.floor(phaseAt(previous)) !== Math.floor(phaseAt(t))) return t
    }
    return null
  }
  const edge = (inside, direction) => {
    let start = inside
    for (;;) {
      let a = start, b = start, s = step
      while (Math.abs(b) < MAX_FREE_SECONDS && (free(b) || b === start)) { a = b; b += direction * s; s *= 1.5 }
      if (free(b)) return { end: b, held: Infinity }
      const end = bisect((x) => (free(x) ? -1 : 1), a, b)
      const next = freeWithin(end, direction, horizon)
      if (next === null) return { end, held: Infinity }
      if (Math.abs(next - end) >= MIN_LANDING) return { end, held: Math.abs(next - end) }
      start = next
    }
  }
  const intervals = []
  for (const direction of [-1, 1]) {
    const inside = firstFree(direction)
    if (inside === null) continue
    const from = edge(inside, -1), to = edge(inside, 1)
    if (!intervals.some(i => Math.abs(i.from - from.end) < 1e-6 && Math.abs(i.to - to.end) < 1e-6)) {
      intervals.push({ from: from.end, to: to.end, before: from.held, after: to.held })
    }
  }
  return intervals
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

// The pad's angle while it leaves a flight it was following (`follow(t)`: angle at time t), from time
// `start`: following, then slowing to a stop over `slow` s, then holding. `arriving` mirrors it
// (speeding up from a hold to follow, from time `end` on).
function leaving(follow, start, slow) {
  const angle = follow(start), speed = (follow(start + 1e-3) - angle) / 1e-3
  return (t) => t <= start ? follow(t) : angle + speed * slow * easeOut((t - start) / slow)
}
function arriving(follow, end, slow) {
  const angle = follow(end), speed = (follow(end + 1e-3) - angle) / 1e-3
  return (t) => t >= end ? follow(t) : angle - speed * slow * easeOut((end - t) / slow)
}

// The pose of one grappler now. g: {
//   engageable, engageableAt(t): whether it may grip the screw now / t s from now (otherwise parked),
//   threadStarts: n (flights round the screw),
//   phase(), phaseAt(t): its thread phase now / t s from now, in cycles (whole numbers halfway between
//     flights),
//   rotationAwayLimit: how far from its mid position it may follow a flight (rotations),
//   alpha: its angle from its mid position now if it is following the flight it is nearest (radians),
// }, switchoverTime: how long a hop takes (s). Returns {lift, raise, neutral, alpha, attached}: lift
// and raise from 0 (on the flight) to 1, neutral from 0 (twisted to the flight's pitch) to 1
// (untwisted), alpha its angle from its mid position (radians), attached whether it grips a flight.
export function grapplerPose(g, switchoverTime, out = {}) {
  const n = g.threadStarts
  const phaseAt = (t) => g.phaseAt(t)
  const u0 = g.phase()
  // The angle of the grappler following the flight below (side -1) or above (+1) boundary k at phase u.
  const k0 = Math.round(u0)
  const alpha0 = g.alpha - 2 * Math.PI * ((u0 - k0) + (u0 < k0 ? 0.5 : -0.5)) / n
  const alphaOn = (k, side, u) => alpha0 + 2 * Math.PI * ((u - k0) + (side < 0 ? 0.5 : -0.5) - (k - k0)) / n

  // Parked where it may not grip, or where the flights drift past so fast that hops would come closer
  // together than one takes (with a margin).
  const length = switchoverTime
  const hopsTooFrequent = (t) => Math.abs(phaseAt(t + 1e-3) - phaseAt(t)) / 1e-3 > 0.8 / length
  const engagedAt = (t) => (g.engageableAt ? g.engageableAt(t) : g.engageable) && !hopsTooFrequent(t)
  const handover = (from, to) => (q) => smootherstep((q - from) / (to - from))

  // The stretch of time around now during which it holds no flight.
  const reach = Math.max(0, 0.5 - n * g.rotationAwayLimit)
  for (const free of freeIntervals(phaseAt, engagedAt, reach, length / 2 + length / 40, length / 40, MAX_STRETCH * length)) {
    const interval = [free.from, free.to]
    // It leaves a flight at the start and arrives on one at the end, unless parked for longer than can
    // be seen (MAX_FREE_SECONDS) that way.
    const parkedBefore = -interval[0] >= MAX_FREE_SECONDS - 1, parkedAfter = interval[1] >= MAX_FREE_SECONDS - 1
    if (parkedBefore && parkedAfter) return Object.assign(out, { lift: 1, raise: 1, neutral: 1, alpha: 0, attached: false })
    const duration = interval[1] - interval[0]
    // Its span: at least `length` (detaching early and attaching late, each by up to half the time the
    // grappler holds a flight on that side, so neighbouring hops never overlap), stretched to fill the
    // free time up to MAX_STRETCH times (but not out of or into parking), beyond which the grappler
    // waits, raised, midway.
    const wanted = (parkedBefore || parkedAfter) ? length : Math.min(Math.max(duration, length), MAX_STRETCH * length)
    const extra = Math.max(0, wanted - duration) / 2
    const start = interval[0] - Math.min(extra, free.before / 2)
    const end = interval[1] + Math.min(extra, free.after / 2)
    const span = Math.min(end - start, wanted)
    if (start <= 0 && 0 <= end) {
      const p = -start < span / 2 ? -start / span : end < span / 2 ? 1 - end / span : 0.5
      const slow = (PROFILE.slow[1] - PROFILE.slow[0]) * span
      // The flights it leaves and arrives on: those it is nearest at the ends of the free time.
      const flightAt = (t) => { const u = phaseAt(t), k = Math.round(u); return [k, u < k ? -1 : 1] }
      const [kFrom, fromSide] = flightAt(interval[0]), [kTo, toSide] = flightAt(interval[1])
      const leave = parkedBefore ? () => 0 : leaving((t) => alphaOn(kFrom, fromSide, phaseAt(t)), start + PROFILE.slow[0] * span, slow)
      const arrive = parkedAfter ? () => 0 : arriving((t) => alphaOn(kTo, toSide, phaseAt(t)), end - PROFILE.slow[0] * span, slow)
      const w = parkedBefore ? handover(0.5, PROFILE.move[1])(p)
        : parkedAfter ? handover(PROFILE.move[0], 0.5)(p)
        : handover(PROFILE.move[0], PROFILE.move[1])(p)
      const lift = outAndBack(PROFILE.lift, p), raise = outAndBack(PROFILE.raise, p), neutral = outAndBack(PROFILE.untwist, p)
      return Object.assign(out, { lift, raise, neutral, alpha: leave(0) * (1 - w) + arrive(0) * w, attached: false })
    }
  }
  return Object.assign(out, { lift: 0, raise: 0, neutral: 0, alpha: g.alpha, attached: true })
}
