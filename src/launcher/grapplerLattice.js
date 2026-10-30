import { PROFILE, outAndBack, leaving, arriving, smootherstep } from './grapplerSwitchover.js'
import { lowSpeedGrips } from './grapplerLowSpeed.js'

// Which flight of the screw each of the adaptive nut's grapplers grips, and how it moves between them,
// as a pure function of the time since the nut's launch: no history, so the same time always gives the
// same answer (shots replay the same on any machine, and any moment can be shown without working up to it).
// At low speed the grips are chained in layers instead (grapplerLowSpeed.js), until the lattice below can
// keep up the count engaged they guarantee; each grappler then joins the lattice when its last grip from
// them ends.
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
// one for a while costs at most a run.) The alignment is there to bring the runs down to the fewest the
// screw allows at the fast end, as early as it can: the alignment with the fewest runs and free
// grapplers over the last FINAL of each period of one lattice spacing is the final one, and the lattice
// takes it where the spacing changes (every grappler moves then anyway). Where the flights under the nut
// change but the spacing does not, it keeps the alignment it has, and changes it (once) to the final
// one so as to have reached the whole nut by the earliest time from which that is at least as good to
// the end (judged every DECISION s), but not while the last change of lattice is still passing along it.
//
// Everything is evaluated on a grid of GRID s (the alignment on one of COARSE s) and remembered; that is
// only a cache: each value is a pure function of its time.
const GRID = 1 / 30
const COARSE = 0.1
const FINAL = 0.1
const DECISION = 1

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
  // grappler for it to grip them (cycles/s). lowSpeed: false leaves out the low-speed grips (the lattice
  // from the launch).
  constructor(sampleAt, end, { holdLimit, switchoverTime, fastestDrift, lowSpeed = true }) {
    this.useLowSpeed = lowSpeed
    this.sampleAt = sampleAt
    this.end = end
    this.holdLimit = holdLimit
    this.switchoverTime = switchoverTime
    this.fastestDrift = fastestDrift
    this._samples = new Map()
    this._alignments = new Map()
    this._periodStarts = new Map()
    this._periodEnds = new Map()
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

  // The lattice spacing at time t, and the flights' spacing it is aligned to: from the fewest and most
  // flights under the nut's grapplers then (of those over the thread; any, before the thread).
  spacingAt(time) {
    const samples = this.samplesAt(time)
    const over = samples.filter(s => s.engageable), flights = (over.length ? over : samples).map(s => s.n)
    const step = latticeStep(this.holdLimit, Math.min(...flights))
    return { step, most: Math.max(...flights) }
  }

  // The period of time around coarse step q over which the lattice spacing (and the flights' spacing it
  // is aligned to) stays the same: { start, end } (coarse steps, end exclusive), step, most.
  periodAt(q) {
    const spacing = (q) => this.spacingAt(q * COARSE)
    const { step, most } = spacing(q), alike = (r) => { const s = spacing(r); return s.step === step && s.most === most }
    let start = this._periodStarts.get(q)
    if (start === undefined) {
      start = q
      while (start > 0 && alike(start - 1)) { start--; if (this._periodStarts.has(start)) { start = this._periodStarts.get(start); break } }
      this._periodStarts.set(q, start)
    }
    const last = Math.ceil(this.end / COARSE)
    let end = this._periodEnds.get(q)
    if (end === undefined) {
      end = q + 1
      while (end <= last && alike(end)) { if (this._periodEnds.has(end)) { end = this._periodEnds.get(end); break } end++ }
      this._periodEnds.set(q, end)
    }
    return { start, end, step, most }
  }

  // The alignments (offsets, turns) over a period of one lattice spacing, and when it changes from the
  // first to the final one (see the top of this file): { first, final, change (s) }. It starts with the
  // alignment the lattice had just before, where that had the same spacing and is one of these, and
  // otherwise (every grappler moves anyway) with the final one.
  alignment(period) {
    let plan = this._alignments.get(period.start)
    if (plan) return plan
    const { step, most } = period
    const count = step > 0 ? Math.max(1, Math.round(step * most)) : 1
    if (count === 1) plan = { first: 0, final: 0, change: Infinity }
    else {
      const offsets = Array.from({ length: count }, (_, j) => j / most)
      // The cost of each alignment every DECISION s over the period.
      const startTime = period.start * COARSE, endTime = Math.min(this.end, period.end * COARSE)
      const times = []
      for (let t = startTime; t < endTime; t += DECISION) times.push(t)
      const costs = offsets.map(offset => times.map(t => arrangementCost(this.arrange(this.samplesAt(t), step, offset))))
      const finalFrom = Math.max(0, Math.floor(times.length * (1 - FINAL)))
      const best = (from, to) => {
        let chosen = 0, lowest = Infinity
        costs.forEach((list, j) => { const sum = list.slice(from, to).reduce((a, b) => a + b, 0); if (sum < lowest) { lowest = sum; chosen = j } })
        return chosen
      }
      const final = best(finalFrom, times.length)
      // (Where the lattice spacing changes too, every grappler moves anyway: no need to carry it on.)
      const before = period.start > 0 ? this.latticeAt(period.start - 1) : null
      const carried = before && before.step === step ? offsets.findIndex(o => Math.abs(wrap(o - before.offset, step)) < 1e-9) : -1
      const first = carried >= 0 ? carried : final
      let change = Infinity
      if (first !== final) {
        let from = times.length
        while (from > 0 && costs[final][from - 1] <= costs[first][from - 1]) from--
        // Starting a pass's time before that, so that it has reached the whole nut by then; but not while
        // the last change of lattice is still passing along the nut.
        const pass = this.delay * this.samplesAt(startTime).length
        change = Math.max((from < times.length ? times[from] : times[times.length - 1]) - pass, startTime + pass)
      }
      plan = { first: offsets[first], final: offsets[final], change }
    }
    this._alignments.set(period.start, plan)
    return plan
  }

  // The lattice at coarse step q, { step, offset } (turns).
  latticeAt(q) {
    q = Math.max(0, q)
    let lattice = this._lattices.get(q)
    if (lattice) return lattice
    const period = this.periodAt(q), alignment = this.alignment(period)
    this._lattices.set(q, lattice = { step: period.step, offset: q * COARSE >= alignment.change ? alignment.final : alignment.first })
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

  get grid() {
    return GRID
  }

  // The low-speed grips, and when each grappler joins the lattice (see grapplerLowSpeed.js).
  get lowSpeed() {
    const N = this.samplesAt(0).length
    return (this._lowSpeed ??= this.useLowSpeed ? lowSpeedGrips(this)
      : { handover: 0, grips: Array.from({ length: N }, () => []), joins: new Array(N).fill(0) })
  }

  // Moves to join a neighbour: a grappler gripping a flight that neither neighbour grips (alone on it) moves,
  // as soon as it can, to the flight a neighbour grips (of two, the one it can then hold the longest),
  // where the flight is within its travel when it lands, and the hop leaves the count engaged no lower
  // than the guarantee (the layers established by then; from the handover, what the lattice took over:
  // see lowSpeedGrips). The neighbour it joins stays on its flight meanwhile (two lone neighbours pair
  // up, rather than swap). It holds that flight while it stays within its travel and the neighbour on
  // it, then goes back to its plan. All judged from the planned grips (plannedHolds), moves taken in time
  // order, each counted against the guarantee. Per grappler: [{ start, land, until, back, from, to,
  // backTo }] (grid steps; flights).
  get joinMoves() {
    if (this._joinMoves) return this._joinMoves
    const N = this.samplesAt(0).length, K = this.lastStep, hop = 2 * this.half
    const planned = Array.from({ length: N }, (_, i) => this.plannedHolds(i))
    const heldAt = (i, k) => {
      const list = planned[i]
      if (!list) return null
      let lo = 0, hi = list.length - 1
      while (lo <= hi) { const mid = (lo + hi) >> 1, h = list[mid]; if (k < h.from) hi = mid - 1; else if (k > h.to) lo = mid + 1; else return h.flight }
      return null
    }
    // The count engaged by the plan, and the fewest it keeps from each step on.
    const change = new Int32Array(K + 2)
    planned.forEach(list => list.forEach(h => { change[h.from]++; change[Math.min(K + 1, h.to + 1)]-- }))
    const counted = new Int16Array(K + 1)
    for (let k = 0, n = 0; k <= K; k++) { n += change[k]; counted[k] = n }
    // The guarantee: the count engaged it must not go below (see lowSpeedGrips; the lattice alone: the
    // fewest it keeps from each step on).
    const fewest = this.useLowSpeed ? this.lowSpeed.guarantee : (() => {
      const f = new Int16Array(K + 2).fill(N)
      for (let k = K; k >= 0; k--) f[k] = Math.min(counted[k], f[k + 1])
      return f
    })()
    // Lone stretches, in time order.
    const lone = []
    planned.forEach((list, i) => list.forEach(h => {
      let from = null
      for (let k = h.from; k <= h.to + 1; k++) {
        const alone = k <= h.to && !same(heldAt(i - 1, k), h.flight) && !same(heldAt(i + 1, k), h.flight)
        if (alone && from === null) from = k
        if (!alone && from !== null) { lone.push({ i, flight: h.flight, from, to: k - 1 }); from = null }
      }
    }))
    lone.sort((a, b) => a.from - b.from || a.i - b.i)
    const moves = Array.from({ length: N }, () => [])
    // While a grappler has a neighbour moving to its flight, it stays on it.
    const staying = Array.from({ length: N }, () => [])
    for (const stretch of lone) {
      const i = stretch.i
      if (moves[i].some(m => m.back >= stretch.from)) continue   // (already moved away)
      for (let start = stretch.from; start <= stretch.to; start++) {
        const land = start + hop
        if (land > K) break
        if (staying[i].some(([a, b]) => a <= start && start <= b)) continue
        // The moves it can make now: to either neighbour's flight; the one it can then hold the longest
        // first.
        const options = []
        for (const j of [i - 1, i + 1]) {
          const flight = heldAt(j, land)
          if (flight === null || same(flight, stretch.flight)) continue
          if (moves[j]?.some(m => m.start <= land && land <= m.back)) continue   // (it is moving itself)
          let until = land - 1
          while (until < K && same(heldAt(j, until + 1), flight) && this.reachable(i, flight, until + 1)) until++
          if (until < land + hop) continue   // (not for long enough to be worth it)
          options.push({ flight, until, j })
        }
        options.sort((a, b) => b.until - a.until)
        let moved = false
        for (const o of options) {
          const move = this.joinMove(i, stretch.flight, o.flight, start, o.until, heldAt, counted, fewest)
          if (!move) continue
          moves[i].push(move)
          staying[o.j].push([start, o.until])
          moved = true
          break
        }
        if (moved) break
      }
    }
    return (this._joinMoves = moves)
  }

  // A move for grappler i from flight `from` to `to`, starting at grid step `start` and holding it until
  // `until`, then back to its plan; or null if that would take the count engaged below the fewest the plan
  // keeps from then on. Taking it counts it (in `counted`).
  joinMove(i, from, to, start, until, heldAt, counted, fewest) {
    const K = this.lastStep, hop = 2 * this.half, land = start + hop
    // Back to its plan: to where the plan has it a hop later (its flight, parked, or, mid-hop, where that
    // hop lands, when it does).
    let backTo = null, back = until + 1 + hop
    if (until >= K) back = until
    else {
      const planned = this.plannedMotion(i, Math.min(K, until + 1 + hop))
      if (planned.hold !== undefined) backTo = planned.hold
      else if (planned.hop) { backTo = planned.hop[1]; back = Math.max(back, planned.end) }
      if (same(backTo, to)) back = until
    }
    // Engaged: off for the hops, on in between.
    const engagedAt = (k) => k < land ? 0 : k <= until ? 1 : same(backTo, to) ? 1 : 0
    for (let k = start; k <= Math.min(K, back); k++) {
      if (counted[k] + engagedAt(k) - (heldAt(i, k) !== null ? 1 : 0) < fewest[k]) return null
    }
    for (let k = start; k <= Math.min(K, back); k++) counted[k] += engagedAt(k) - (heldAt(i, k) !== null ? 1 : 0)
    return { start, land, until, back, from, to, backTo }
  }

  // What grappler i is doing at grid step k: { hold: flight } (gripping it), { park: true }, or { hop:
  // [from, to] (flights, or null for parked), start, end (grid steps) }: by the low-speed grips until it
  // joins the lattice, then by the lattice; with any moves to join a neighbour (joinMoves).
  motion(i, k) {
    for (const m of this.joinMoves[i]) {
      if (k < m.start || k > m.back) continue
      if (k < m.land) return this.hop(m.from, m.to, m.start, m.land)
      if (k <= m.until) return { hold: m.to }
      return this.hop(m.to, m.backTo, m.until + 1, m.back)
    }
    return this.plannedMotion(i, k)
  }

  // What grappler i is doing at grid step k by its plan: the low-speed grips until it joins the lattice,
  // then the lattice.
  plannedMotion(i, k) {
    const { grips, joins } = this.lowSpeed, join = joins[i], hop = 2 * this.half
    if (k < join) return this.lowSpeedMotion(grips[i], k)
    const m = this.latticeMotion(i, k)
    // Joining: from where its last grip from the layers leaves it.
    const last = grips[i].find(g => g.to === join - 1)
    const from = last ? last.flight : null
    // (A lattice hop starting from the join on is the lattice's own; one already under way, and holding or
    // parking within a hop of the join, start from the join instead, from where it is.)
    if (m.hop) return m.start >= join ? m : this.hop(from, m.hop[1], join, Math.max(m.end, join + hop))
    if (k >= join + hop) return m
    if (m.hold !== undefined) return same(m.hold, from) ? m : this.hop(from, m.hold, join, join + hop)
    return from === null ? m : this.hop(from, null, join, join + hop)
  }

  // Motion from a grappler's low-speed grips (in time order): on its flight in a grip; between two a hop's
  // time or less apart, a hop from one to the other; otherwise letting go to park, parked, and landing.
  lowSpeedMotion(grips, k) {
    const hop = 2 * this.half
    let previous = null, next = null
    for (const g of grips) {
      if (g.from <= k && k <= g.to) return { hold: g.flight }
      if (g.to < k) previous = g
      else if (g.from > k && !next) next = g
    }
    if (previous && next && next.from - previous.to - 1 <= 2 * hop) return this.hop(previous.flight, next.flight, previous.to + 1, next.from)
    if (previous && k <= previous.to + hop) return this.hop(previous.flight, null, previous.to + 1, previous.to + 1 + hop)
    if (next && k >= next.from - hop) return this.hop(null, next.flight, next.from - hop, next.from)
    return { park: true }
  }

  // The lattice's motion for grappler i at grid step k: { hold: flight } (gripping it), { park: true }, or { hop:
  // [from, to] (flights, or null for parked), start, end (grid steps) }. It lets go only where its
  // lattice flight changes (half a hop before), and knows then where it is going: the flight of its next
  // span (passing over short stretches), or parked if it would be alone there (see landing).
  latticeMotion(i, k) {
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

  // The stretches [from, to] (grid steps) over which grappler i grips by the lattice alone, over the whole
  // run: walking its spans once (as latticeMotion has it holding: from landing on its span's flight, until
  // half a hop before the change after it).
  latticeHolds(i) {
    const h = this.half, out = []
    const first = this.segment(i, 0)
    const start = this.lasting(first) ? first : this.nextLasting(i, first)
    for (let span = start ? this.span(i, start) : null, previous = null; span; previous = span, span = this.nextSpan(i, span)) {
      const landing = this.landing(i, span)
      if (span.value === null || landing === Infinity) continue
      const next = this.nextSpan(i, span)
      const from = Math.max(landing, previous ? span.start + h : 0), to = next ? span.end - h - 1 : this.lastStep
      if (to >= from) out.push([from, to, span.value])
    }
    return out
  }

  // The stretches { from, to, flight } (grid steps) over which grappler i grips, by the low-speed grips and
  // then the lattice (as plannedMotion has it).
  plannedHolds(i) {
    const { grips, joins } = this.lowSpeed, join = joins[i], hop = 2 * this.half
    const out = grips[i].filter(g => g.from < join).map(g => ({ from: g.from, to: Math.min(g.to, join - 1), flight: g.flight }))
    const last = grips[i].find(g => g.to === join - 1)
    for (const [a, b, flight] of this.latticeHolds(i)) {
      if (b < join) continue
      // (Joining: straight on if the lattice has it on the flight it is on, otherwise after a hop.)
      const from = Math.max(a, last && same(last.flight, flight) ? join : join + hop)
      if (b >= from) out.push({ from, to: b, flight })
    }
    return out
  }

  // The flight grappler i grips at grid step k by the lattice alone.
  latticeFlightAt(i, k) {
    return this.latticeMotion(i, k).hold ?? null
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
