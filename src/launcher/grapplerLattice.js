import { PROFILE, outAndBack, leaving, arriving, smootherstep } from './grapplerSwitchover.js'

// Which flight of the screw each of the adaptive nut's grapplers grips, and how it moves between them,
// as a pure function of the time since the nut's launch: no history, so the same time always gives the
// same answer (shots replay the same on any machine, and any moment can be shown without working up to it).
//
// Grapplers along the nut see the thread at different phases, drifting as the nut speeds up. A run of
// neighbours gripping one flight is held by the magnetic coupling all along it, and eddy currents are
// lost at each end of a run, so the grapplers should be in as few runs as they can, all gripping.
//
// The lattice. Every grappler can follow a flight across its travel, holdLimit turns either side of the
// middle (the screw's mount brackets bound it). The flights the grapplers hold are taken from a lattice
// of angles round the screw, `step` turns apart: the widest spacing of whole flights under the nut that
// fits in the travel (so a grappler always has a lattice flight within reach), the same for every
// grappler and, since the travel is a fixed angle, wherever the screw has more or fewer flights. Each
// grappler's lattice flight is the one nearest the middle of its travel, so neighbours share flights,
// in runs ending only where the drift of phase along the nut crosses half a step: as few runs as that
// spacing allows.
//
// Its motion. A grappler lets go only where its lattice flight changes (the flight drifts past half a
// step from the middle, or a change of lattice reaches it), half a hop's time before, and knows then
// where it is going: the flight it has next for long enough to land on and grip for at least a hop's
// time (shorter stretches are passed over), landing half a hop's time after the change. Where that is the
// flight it is on, and the flight stays within its travel in between, it keeps holding it instead. If no neighbour has that flight when it lands, it would be
// alone on it (two run ends for one grappler's grip): it parks instead, and lands on that flight when a
// neighbour does, if that leaves it time before it moves on. Once gripping it lets go only where its own
// lattice flight changes, whatever its neighbours do.
// Where the travel is less than the spacing between flights (step 0), each grappler holds the nearest
// flight while it is within its travel, and is free in between. It does not grip where it may not:
// before the thread, off the screws, or where the flights drift past faster than fastestDrift (it could
// not land on them).
//
// The alignment. Where the travel spans more than one flight spacing there is more than one lattice
// (`offset` from the flights at whole turns): every second flight, say, from the even ones or the odd
// ones. A change of lattice (of alignment, or of spacing where the nut moves onto more flights) would
// move many grapplers at once; instead it passes along the nut one grappler at a time, from its first
// grappler to its last: grappler i follows the lattice chosen i hops' time (plus a little) earlier, so it
// lets go only once its neighbour has landed on the new lattice's flight, and the old and new lattices
// meet at one break. (Either lattice keeps every grappler within reach of a flight, so being on the old
// one for a while costs at most a run.) Since that takes the whole nut a while, the lattice chosen is the
// one with the fewest runs and free grapplers over that time from now (or LOOKAHEAD s, if longer):
// worth changing to for as long as the change takes, and not flipping back and forth as two run close.
//
// Everything is evaluated on a grid of GRID s (the alignment on one of COARSE s) and remembered; that is
// only a cache: each value is a pure function of its time.
const GRID = 1 / 30
const COARSE = 0.1
const LOOKAHEAD = 2

// x wrapped into [-m/2, m/2).
const wrap = (x, m) => x - m * Math.floor(x / m + 0.5)

// A grappler's phase (cycles), from g: { threadStarts: n, phase(): its thread phase (cycles), alpha: its
// angle (radians, from the middle of its travel, fixed to the nut) if following the nearest flight }. The
// pad sits a little to one side of the flight (on its face), so the angle at which it follows a flight is
// not quite the thread phase's: this is the phase that gives that angle, with flight m at m + 0.5 and the
// middle of its travel at a whole number of cycles.
export function effectivePhase(g) {
  const n = g.threadStarts, u = g.phase(), spacing = 2 * Math.PI / n
  let side = g.alpha - spacing * ((u - Math.floor(u)) - 0.5)
  side -= spacing * Math.round(side / spacing)
  return u + side / spacing
}

// The lattice spacing (turns) for grapplers with `holdLimit` turns of travel either side of the middle,
// over a screw whose fewest flights anywhere are `fewestFlights` (the others are multiples of it): whole
// numbers of flight spacings at that, that fit in the travel; 0 if not even one does.
export function latticeStep(holdLimit, fewestFlights) {
  return Math.floor(2 * holdLimit * fewestFlights + 1e-9) / fewestFlights
}

// samples: per grappler, in order along the nut, { phase (cycles: flight m at m + 0.5, whole numbers at
// the middle of its travel), rate (its drift, turns/s), n (flights round the screw there), engageable }.
// step, offset: the lattice's spacing and alignment (turns), the same for all or per grappler (functions
// of its index).
// Returns per grappler { flight: the angle (turns, [0, 1)) of the flight it holds, or null; can: whether
// it may grip at all here; travel: its offset from that flight (turns from the middle of its travel; for
// a free grappler, from the flight it would hold) }.
export function latticeArrangement(samples, { holdLimit, fastestDrift, step, offset = 0, alone = true }) {
  const offsetOf = typeof offset === 'function' ? offset : () => offset
  const stepOf = typeof step === 'function' ? step : () => step
  const out = samples.map((s, i) => {
    const step = stepOf(i)
    const n = s.n
    // Its angle round the screw (turns): flight m of n is at (m + 1) / n.
    const angle = (s.phase + 0.5) / n
    const can = s.engageable && Math.abs(s.rate * n) <= fastestDrift
    const travel = step > 0 ? wrap(angle - offsetOf(i), step) : wrap(angle, 1 / n)
    const flight = (((angle - travel) % 1) + 1) % 1
    return { flight: can && Math.abs(travel) <= holdLimit + 1e-9 ? flight : null, can, travel }
  })
  if (alone) leaveAloneFree(out)
  return out
}

// Whether two flight angles (or nulls) are the same.
const same = (a, b) => a === b || (a !== null && b !== null && Math.abs(wrap(a - b, 1)) < 1e-6)

const sameFlight = (a, b) => b !== undefined && a.flight !== null && b.flight !== null && Math.abs(wrap(a.flight - b.flight, 1)) < 1e-6

// A grappler alone on its flight (neither neighbour holds it) is left free.
function leaveAloneFree(arrangement) {
  const alone = arrangement.map((g, i) => g.flight !== null && !sameFlight(g, arrangement[i - 1]) && !sameFlight(g, arrangement[i + 1]))
  arrangement.forEach((g, i) => { if (alone[i]) g.flight = null })
}

// The cost of an arrangement: its runs and the grapplers left free that could grip.
function arrangementCost(arrangement) {
  let cost = 0
  arrangement.forEach((g, i) => {
    if (g.flight === null) { if (g.can) cost++ }
    else if (i === 0 || arrangement[i - 1].flight === null || Math.abs(wrap(arrangement[i - 1].flight - g.flight, 1)) > 1e-6) cost++
  })
  return cost
}

export class GrapplerLatticePlan {
  // sampleAt(time since launch) -> per grappler samples (see latticeArrangement). end: when the nut
  // leaves the screws. holdLimit: each grappler's travel either side of the middle (turns).
  // switchoverTime: how long a hop takes (s). fastestDrift: the fastest the flights may drift past a
  // grappler for it to grip them (cycles/s).
  constructor(sampleAt, end, { holdLimit, switchoverTime, fastestDrift }) {
    this.sampleAt = sampleAt
    this.end = end
    this.holdLimit = holdLimit
    this.switchoverTime = switchoverTime
    this.fastestDrift = fastestDrift
    this._samples = new Map()
    this._costs = new Map()
    this._lattices = new Map()
    this._arrangements = new Map()
    this._starts = []
    this._ends = []
    this._landings = []
    this._spans = []
    // Half a hop's time, in grid steps.
    this.half = Math.max(1, Math.round(switchoverTime / 2 / GRID))
    // Between one grappler and the next taking up a change of lattice (s): a hop, and a little.
    this.delay = switchoverTime + 2 * GRID
  }

  samplesAt(time) {
    let samples = this._samples.get(time)
    if (!samples) this._samples.set(time, samples = this.sampleAt(Math.min(Math.max(0, time), this.end)))
    return samples
  }

  arrange(samples, step, offset, alone = true) {
    return latticeArrangement(samples, { holdLimit: this.holdLimit, fastestDrift: this.fastestDrift, step, offset, alone })
  }

  // The lattice chosen at coarse step q, { step, offset } (turns): its spacing from the fewest flights
  // under the nut's grapplers then, and of its alignments (multiples of the most flights' spacing), the one with the
  // fewest runs and free grapplers over the time a change takes to pass along the nut (or LOOKAHEAD s).
  latticeAt(q) {
    q = Math.max(0, q)
    let lattice = this._lattices.get(q)
    if (lattice) return lattice
    const samples = this.samplesAt(q * COARSE)
    // (Of the grapplers over the thread; any, before the thread.)
    const over = samples.filter(s => s.engageable), flights = (over.length ? over : samples).map(s => s.n)
    const fewest = Math.min(...flights), most = Math.max(...flights)
    const step = latticeStep(this.holdLimit, fewest)
    const count = step > 0 ? Math.max(1, Math.round(step * most)) : 1
    let best = Infinity, offset = 0
    for (let j = 0; j < count && count > 1; j++) {
      let sum = 0
      for (let r = q; r <= q + Math.round(Math.max(LOOKAHEAD, this.delay * samples.length) / COARSE); r++) {
        const key = step + ':' + j / most + ':' + r
        let cost = this._costs.get(key)
        if (cost === undefined) this._costs.set(key, cost = arrangementCost(this.arrange(this.samplesAt(r * COARSE), step, j / most)))
        sum += cost
      }
      if (sum < best) { best = sum; offset = j / most }
    }
    this._lattices.set(q, lattice = { step, offset })
    return lattice
  }

  // The lattice flight each grappler can hold at grid step k (see latticeArrangement; free where it may
  // not grip), with changes of lattice passing along the nut one grappler at a time. Its own motion
  // (motion) is worked out from the changes in this.
  arrangementAt(k) {
    let arrangement = this._arrangements.get(k)
    if (arrangement) return arrangement
    const time = k * GRID
    const lattice = (i) => this.latticeAt(Math.floor((time - this.delay * i) / COARSE + 1e-9))
    arrangement = this.arrange(this.samplesAt(time), (i) => lattice(i).step, (i) => lattice(i).offset, false)
    this._arrangements.set(k, arrangement)
    return arrangement
  }

  // Grappler i's lattice flight at grid step k (null: free; before the launch, free).
  raw(i, k) {
    return k < 0 ? null : this.arrangementAt(Math.min(k, this.lastStep))[i]?.flight ?? null
  }

  get lastStep() {
    return Math.ceil(this.end / GRID)
  }

  // The stretch of grid steps [start, end) around k over which grappler i's lattice flight is `value`.
  segment(i, k) {
    const starts = (this._starts[i] ??= new Map()), ends = (this._ends[i] ??= new Map())
    const value = this.raw(i, k)
    let start = starts.get(k)
    if (start === undefined) {
      start = k
      while (start > 0 && same(this.raw(i, start - 1), value)) {
        start--
        if (starts.has(start)) { start = starts.get(start); break }
      }
      starts.set(k, start)
    }
    let end = ends.get(k)
    if (end === undefined) {
      end = k + 1
      while (end <= this.lastStep && same(this.raw(i, end), value)) {
        if (ends.has(end)) { end = ends.get(end); break }
        end++
      }
      ends.set(k, end)
    }
    return { start, end, value }
  }

  // A stretch long enough to go to: a hop to land on it and as long again gripping it (or at either end
  // of the launch). Shorter ones are passed over: the grappler goes straight on to the next lasting one.
  lasting(segment) {
    return segment.end - segment.start >= 4 * this.half || segment.start === 0 || segment.end > this.lastStep
  }

  // The lasting stretch before (or after) `segment`, or null.
  previousLasting(i, segment) {
    for (let s = segment; s.start > 0;) {
      s = this.segment(i, s.start - 1)
      if (this.lasting(s)) return s
    }
    return null
  }

  nextLasting(i, segment) {
    for (let s = segment; s.end <= this.lastStep;) {
      s = this.segment(i, s.end)
      if (this.lasting(s)) return s
    }
    return null
  }

  // Whether grappler i can hold the flight `value` at grid step k: it may grip, and the flight is within
  // its travel.
  reachable(i, value, k) {
    const s = this.samplesAt(Math.min(Math.max(0, k), this.lastStep) * GRID)[i]
    return s.engageable && Math.abs(s.rate * s.n) <= this.fastestDrift && Math.abs(wrap((s.phase + 0.5) / s.n - value, 1)) <= this.holdLimit + 1e-9
  }

  // The span over which grappler i holds the flight of its lasting stretch `segment` ({ start, end,
  // value }, grid steps): with the lasting stretches either side that have the same flight joined on,
  // where that flight stays within its travel in between (it keeps holding it, rather than going away and
  // coming back to it).
  span(i, segment) {
    const memo = (this._spans[i] ??= new Map())
    let span = memo.get(segment.start)
    if (span) return span
    const value = segment.value
    const holds = (from, to) => value !== null && Array.from({ length: to - from }, (_, j) => from + j).every(k => this.reachable(i, value, k))
    let first = segment, last = segment
    for (let before = this.previousLasting(i, first); before && same(before.value, value) && holds(before.end, first.start); before = this.previousLasting(i, first)) first = before
    for (let after = this.nextLasting(i, last); after && same(after.value, value) && holds(last.end, after.start); after = this.nextLasting(i, last)) last = after
    span = { start: first.start, end: last.end, value, first, last }
    memo.set(segment.start, span)
    return span
  }

  // The spans before and after `span`, or null.
  previousSpan(i, span) {
    const s = this.previousLasting(i, span.first)
    return s ? this.span(i, s) : null
  }

  nextSpan(i, span) {
    const s = this.nextLasting(i, span.last)
    return s ? this.span(i, s) : null
  }

  // Whether a neighbour of grappler i has the flight `value` at grid step k.
  joined(i, value, k) {
    return same(this.raw(i - 1, k), value) || same(this.raw(i + 1, k), value)
  }

  // When (grid step) grappler i is on the flight of its span: half a hop after the change to it, if a
  // neighbour is on it then; otherwise (alone, it parks) a hop after a neighbour joins it, if that leaves
  // it time before it lets go again; Infinity if it is never on it (or it is free).
  landing(i, span) {
    const memo = (this._landings[i] ??= new Map())
    let landing = memo.get(span.start)
    if (landing !== undefined) return landing
    landing = Infinity
    if (span.value !== null) {
      const direct = span.start + this.half
      if (span.start === 0 ? false : this.joined(i, span.value, direct)) landing = direct
      else {
        for (let k = direct; k + 2 * this.half <= span.end - this.half; k++) {
          if (this.joined(i, span.value, k)) { landing = k + 2 * this.half; break }
        }
      }
    }
    memo.set(span.start, landing)
    return landing
  }

  // What grappler i is doing at grid step k: { hold: flight } (gripping it), { park: true }, or { hop:
  // [from, to] (flights, or null for parked), start, end (grid steps) }. It lets go only where its
  // lattice flight changes (half a hop before), and knows then where it is going: the flight of its next
  // span (passing over short stretches), or parked if it would be alone there (see landing).
  motion(i, k) {
    const h = this.half, here = this.segment(i, k)
    // The span it is in or has just left (and if left, the one it goes to).
    const lastingHere = this.lasting(here) ? here : this.previousLasting(i, here)
    let current = lastingHere ? this.span(i, lastingHere) : null
    if (current && k >= current.end) {
      const next = this.nextSpan(i, current)
      return next ? this.hop(this.heldAtEnd(i, current), this.target(i, next), current.end - h, next.start + h) : { park: true }
    }
    if (!current) {
      const next = this.nextLasting(i, here)
      if (!next) return { park: true }
      current = this.span(i, next)
    }
    const previous = this.previousSpan(i, current)
    if (previous && k < current.start + h) return this.hop(this.heldAtEnd(i, previous), this.target(i, current), previous.end - h, current.start + h)
    const next = this.nextSpan(i, current)
    if (next && k >= current.end - h) return this.hop(this.heldAtEnd(i, current), this.target(i, next), current.end - h, next.start + h)
    // Within its span: on its flight, or parked and joining it when a neighbour does.
    const landing = this.landing(i, current)
    if (k >= landing) return current.value === null ? { park: true } : { hold: current.value }
    if (landing !== Infinity && k >= landing - 2 * h) return this.hop(null, current.value, landing - 2 * h, landing)
    return { park: true }
  }

  // Where grappler i is at the end of a span (and so where a hop from it starts).
  heldAtEnd(i, span) {
    return this.landing(i, span) <= span.end - this.half ? span.value : null
  }

  // Where a hop to a span goes: its flight, if the grappler lands on it straight away (else it parks).
  target(i, span) {
    return this.landing(i, span) === span.start + this.half ? span.value : null
  }

  hop(from, to, start, end) {
    if (from === null && to === null) return { park: true }
    return { hop: [from, to], start, end }
  }

  // The flight grappler i grips at grid step k (null: free, parked or hopping).
  flightAt(i, k) {
    return this.motion(i, k).hold ?? null
  }

  // The pose of grappler i at `time` since launch. g: its placement info now (see effectivePhase;
  // rotationRate: its drift, turns/s). Returns { lift, raise, neutral, alpha, attached }: lift and raise
  // from 0 (on the flight) to 1, neutral from 0 (twisted to the flight's pitch) to 1 (untwisted), alpha
  // its angle (radians, from the middle of its travel), attached whether it grips a flight.
  pose(i, time, g, out = {}) {
    const n = g.threadStarts
    const angle = (effectivePhase(g) + 0.5) / n, rate = g.rotationRate ?? 0
    const limit = 2 * Math.PI * this.holdLimit
    const inRange = (alpha) => Math.min(limit, Math.max(-limit, alpha))
    // Its angle from the middle of its travel when following the flight at `flight`, t s from now.
    const following = (flight) => (t) => 2 * Math.PI * wrap(angle + rate * t - flight, 1)
    // (Changes between grid steps k - 1 and k happen at (k - 1/2) GRID.)
    const motion = this.motion(i, Math.floor(time / GRID + 0.5))
    if (motion.park) return Object.assign(out, { lift: 1, raise: 1, neutral: 1, alpha: 0, attached: false })
    if (motion.hold !== undefined) return Object.assign(out, { lift: 0, raise: 0, neutral: 0, alpha: inRange(following(motion.hold)(0)), attached: true })
    // In a hop: progress p from 0 (lets go) to 1 (lands); from or to parked (null).
    const [fromFlight, toFlight] = motion.hop
    const span = (motion.end - motion.start) * GRID, start = (motion.start - 0.5) * GRID - time, end = start + span
    const p = Math.min(1, Math.max(0, -start / span))
    const fastest = 2 * Math.PI * this.fastestDrift / n, slow = (PROFILE.slow[1] - PROFILE.slow[0]) * span
    const low = -0.9 * limit, high = 0.9 * limit
    const leave = fromFlight === null ? () => 0 : leaving(following(fromFlight), start + PROFILE.slow[0] * span, slow, low, high, fastest)
    const arrive = toFlight === null ? () => 0 : arriving(following(toFlight), end - PROFILE.slow[0] * span, slow, low, high, fastest)
    const [from, to] = fromFlight === null ? [0.5, PROFILE.move[1]] : toFlight === null ? [PROFILE.move[0], 0.5] : PROFILE.move
    const w = smootherstep((p - from) / (to - from))
    return Object.assign(out, {
      lift: outAndBack(PROFILE.lift, p), raise: outAndBack(PROFILE.raise, p), neutral: outAndBack(PROFILE.untwist, p),
      alpha: inRange(leave(0) * (1 - w) + arrive(0) * w), attached: false,
    })
  }
}
