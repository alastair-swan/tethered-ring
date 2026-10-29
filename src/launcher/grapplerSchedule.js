// Which flight of the screw each of the adaptive nut's grapplers grips, and when, over a launch; and how far
// the nut (with its sled and vehicle) runs ahead of its ideal position to help.
//
// Grapplers along the nut see the thread at different phases. If each let go of its flight half way
// to the next (the old rule), runs of neighbours with similar phases let go together, and every one
// hopped once per flight spacing of drift. Instead each grappler keeps its flight for as long as its
// range of motion allows (holdLimit either side of the middle of its travel, fixed to the nut: the
// grapplers must never reach the screw's brackets), less MARGIN cycles and the distance the pad carries
// on while it lets go and slows to a stop (OVERSHOOT of a hop's time at its drift rate), and only then
// moves to the nearest flight within reach (HYSTERESIS cycles inside the limit, so it does not move
// straight back). With a range of a flight spacing or more either side, it then hops only once it has
// drifted a whole flight spacing (half as often), and hops are only by grapplers that have reached the
// end of their travel. (So rather than the nearest flight it takes, or waits for, the one that keeps it
// gripping for the most of the time, counting gaps: see flightToTake.)
// - It lets go (and is parked) where it may not grip: before the thread, too far along the nut at low
//   speed, where the flights drift past faster than a hop takes, or off the screws.
// Grips shorter than MIN_GRIP are dropped (the grappler stays free rather than landing for a moment).
//
// - After letting go it is free for a whole hop (switchoverTime) before it may grip again, so that hops
//   always take the same time.
//
// What it aims for. The screw pulls the vehicle through the grapplers' magnetic coupling, so the more of
// them grip, the more it can pull; and each gap in the run of gripping grapplers (where they move to a new
// flight) loses energy to eddy currents, more the faster the pads slide over the flights. A gap costs
// gapCost(time) grapplers' worth of coupling (grows with the speed). To make fewer, separate gaps: a
// grappler near the end of its travel (beyond JOIN of it, less at higher gapCost) lets go along with a
// neighbour that is letting go, so that they hop together, in one gap.
//
// The lead. Running the nut a little ahead of (or behind) where the forward acceleration alone would put
// it moves every grappler's phase together, as rotating the whole nut would, but leaves the grapplers'
// travel where it is on the nut. Every STEP the schedule looks HORIZON s ahead and picks, among the leads
// it can reach by then, the one that gives the most grapplers gripping less gapCost for each gap (then
// the grips nearest the middle of their travel), and steers the lead towards it with at most
// maxLeadAcceleration (m/s^2) more or less than the forward acceleration, never more than maxLead (m),
// changing no grappler's phase by more than LEAD_DRIFT / gapCost cycles/s, and back to none, at rest, by the end of
// the screws.
//
// The schedule depends on where the flights are when the nut is launched (the screw's turn then), and is
// integrated from the launch in steps of STEP and kept; see grapplerSwitchover.js for the movements
// between grips.
const STEP = 1 / 30
const MARGIN = 0.05
const OVERSHOOT = 0.2
const HYSTERESIS = 0.1
const MIN_GRIP = 0.1
const HORIZON = 0.6
const CANDIDATES = 15
const SENSITIVITY_STEP = 1e-3   // (m)
const LEAD_DRIFT = 0.3
const JOIN = 0.8

// A phase (cycles) with n flights round the screw, as numbered with n2: the screw adds flights between its
// existing ones, and flight m (phase m + 0.5) of n becomes flight (m + 1) * n2 / n - 1 of n2.
const renumber = (phase, n, n2) => n === n2 ? phase : (phase + 0.5) * n2 / n - 0.5

// x wrapped into [-n/2, n/2).
const wrap = (x, n) => x - n * Math.floor(x / n + 0.5)

// A grappler's phase (cycles) as the schedule uses it, from g: { threadStarts: n, phase(): its thread
// phase (cycles), alpha: its angle (radians, from the middle of its travel, fixed to the nut) if following
// the nearest flight }. The pad sits a little to one side of the flight (on its face), so the angle at
// which it follows a flight is not quite the thread phase's: this is the phase that gives that angle,
// with the middle of its travel at a whole number of cycles.
export function effectivePhase(g) {
  const n = g.threadStarts, u = g.phase(), spacing = 2 * Math.PI / n
  let side = g.alpha - spacing * ((u - Math.floor(u)) - 0.5)
  side -= spacing * Math.round(side / spacing)
  return u + side / spacing
}

export class GrapplerSchedule {
  // sampleAt(time since launch, lead (m)) -> per grappler { phase (cycles, see effectivePhase: whole
  // numbers at the middle of its travel, flight m at m + 0.5), rate (its drift, rotations/s), n (flights round the screw), engageable }, with
  // the nut `lead` m ahead of its ideal position. end: when the nut leaves the screws. holdLimit: how far a
  // grappler can follow a flight (rotations). switchoverTime: how long a hop takes (s). gapCost(time),
  // maxLead (m), maxLeadAcceleration (m/s^2): see above (0: no lead).
  constructor(sampleAt, end, { holdLimit, switchoverTime, gapCost = () => 1, maxLead = 0, maxLeadAcceleration = 0 }) {
    this.sampleAt = sampleAt
    this.end = end
    this.holdLimit = holdLimit
    this.switchoverTime = switchoverTime
    this.maxLead = maxLead
    this.maxLeadAcceleration = maxLeadAcceleration
    this.gapCost = gapCost
    this.steps = 0
    this.lead = []          // lead (m) at k * STEP
    this.leadRate = []      // its rate (m/s)
    this.phase = []         // per grappler: unwrapped phase (cycles) at k * STEP
    this.starts = []        // per grappler: n at k * STEP
    this.grips = []         // per grappler: [{ start, end, flight, renumbered }] (end Infinity while gripping;
                            // see flightAt)
    this.freeUntil = []     // per grappler: when it may next grip (s)
    this._lead = 0
    this._leadRate = 0
    this._sensitivity = null   // per grappler: how its phase changes with the lead (cycles/m)
    this.extend()
  }

  // Integrates up to `time` since launch.
  extendTo(time) {
    const k = Math.ceil(Math.min(Math.max(0, time), this.end) / STEP) + 1
    while (this.steps <= k) this.extend()
  }

  // Grappler i's unwrapped phase (cycles) at `time`, numbered for n flights (by default, as many as the
  // schedule has there).
  phaseAt(i, time, n) {
    const t = Math.min(Math.max(0, time), this.end)
    this.extendTo(t)
    const k = Math.min(Math.floor(t / STEP), this.steps - 2)
    const x = t / STEP - k
    const n0 = this.starts[i][k], n1 = this.starts[i][k + 1]
    n ??= x < 0.5 ? n0 : n1
    const a = renumber(this.phase[i][k], n0, n), b = renumber(this.phase[i][k + 1], n1, n)
    return a + (b - a) * x
  }

  // How far (m) the nut is ahead of its ideal position at `time` since launch (0 before the launch and
  // once off the screws).
  leadAt(time) {
    if (!(time > 0) || time >= this.end || this.maxLeadAcceleration <= 0) return 0
    this.extendTo(time)
    const k = Math.min(Math.floor(time / STEP), this.steps - 2)
    const x = time / STEP - k
    // Cubic Hermite between the steps, so that the nut's speed is continuous.
    const p0 = this.lead[k], p1 = this.lead[k + 1], m0 = this.leadRate[k] * STEP, m1 = this.leadRate[k + 1] * STEP
    const x2 = x * x, x3 = x2 * x
    return (2 * x3 - 3 * x2 + 1) * p0 + (x3 - 2 * x2 + x) * m0 + (-2 * x3 + 3 * x2) * p1 + (x3 - x2) * m1
  }

  // The number of the flight `grip` holds at `time` (it is renumbered where the screw adds flights).
  // n: number it for this many flights (by default, as many as it was numbered for then; a flight the
  // screw only has with more flights then has a fractional number, at its angle).
  static flightAt(grip, time, n) {
    let flight = grip.flight, numbered = grip.n
    for (const entry of grip.renumbered ?? []) if (time < entry.time) { flight = entry.flight; numbered = entry.n; break }
    return n === undefined || n === numbered ? flight : renumber(flight + 0.5, numbered, n) - 0.5
  }

  // Grappler i's grips around `time`: the last one starting at or before it (index), or -1.
  gripIndexAt(i, time) {
    this.extendTo(time + 4 * this.switchoverTime)
    const grips = this.grips[i]
    let lo = 0, hi = grips.length - 1, found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (grips[mid].start <= time) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    return found
  }

  // How far grappler i (with drift `drift`, cycles/s, n flights) can follow a flight from the middle of
  // its travel before it must let go (cycles).
  reach(n, drift) {
    return n * this.holdLimit - MARGIN - drift * OVERSHOOT * this.switchoverTime
  }

  // Grappler i's drift (cycles/s), with that of the lead; signed, the rate its phase changes.
  drift(i, s) {
    return Math.abs(this.signedDrift(i, s))
  }

  signedDrift(i, s) {
    return s.n * s.rate + (this._sensitivity?.[i] ?? 0) * this._leadRate
  }

  // The flight for grappler i (phase `relative`, cycles, may follow a flight to `reach`, and take one
  // within `take`) to take now, or null (none, or better to wait for one coming within reach). Of the
  // flights it can take now or soon, the one with the most time gripping (less gapCost(time) times a
  // tenth of a hop for the gap) for the time until it may next grip again.
  flightToTake(i, s, relative, reach, take, time) {
    const drift = this.signedDrift(i, s), speed = Math.max(1e-6, Math.abs(drift)), back = drift >= 0 ? 1 : -1
    const penalty = 0.1 * this.gapCost(time) * this.switchoverTime
    const nearest = Math.round(relative - 0.5)
    let best = null, bestScore = -Infinity, bestWait = 0
    for (let step = -2; step <= Math.ceil(reach) + 1; step++) {
      const flight = nearest + back * step
      // Its offset, moving the way of the drift (positive: towards the end of its travel).
      const ahead = back * (relative - flight - 0.5)
      if (ahead > take) continue
      const wait = Math.max(0, (-ahead - take) / speed)
      const hold = (reach - Math.max(ahead, -take)) / speed
      const score = (hold - penalty) / (hold + this.switchoverTime + wait)
      if (score > bestScore) { bestScore = score; best = flight; bestWait = wait }
    }
    return best !== null && bestWait === 0 && bestScore > 0 ? best : null
  }

  // The fastest a grappler's flights may drift for it to grip them (cycles/s).
  fastestDrift() {
    return 0.8 / this.switchoverTime
  }

  canGrip(i, s, time) {
    return s.engageable && time <= this.end && this.drift(i, s) <= this.fastestDrift()
  }

  extend() {
    const k = this.steps++
    const time = k * STEP
    const lead = this._lead
    const samples = this.sampleAt(Math.min(time, this.end), lead)
    if (k === 0) {
      for (let i = 0; i < samples.length; i++) { this.phase.push([]); this.starts.push([]); this.grips.push([]); this.freeUntil.push(0) }
    }
    this.lead.push(lead)
    this.leadRate.push(this._leadRate)
    // Unwrapped phases.
    const phases = samples.map((s, i) => {
      if (k === 0) return s.phase
      const previous = this.phase[i][k - 1], n = s.n, oldN = this.starts[i][k - 1]
      const scaled = renumber(previous, oldN, n)
      if (n !== oldN) this.rescaleGrip(i, oldN, n, time)
      return scaled + wrap(s.phase - scaled, n)
    })
    // Each grappler: keep its flight while in reach (or let go with a neighbour, near the end of its travel),
    // otherwise, once free for a hop, take the nearest within reach.
    const join = Math.max(0.5, JOIN - 0.05 * Math.max(0, this.gapCost(time) - 1))
    const state = samples.map((s, i) => {
      this.phase[i].push(phases[i])
      this.starts[i].push(s.n)
      const grips = this.grips[i]
      const current = grips.length && grips[grips.length - 1].end === Infinity ? grips[grips.length - 1] : null
      const reach = this.reach(s.n, this.drift(i, s))
      const offset = current ? Math.abs(phases[i] - current.flight - 0.5) : 0
      return { can: this.canGrip(i, s, time), reach, current, offset, letGo: false }
    })
    state.forEach((g) => { g.letGo = g.current && (!g.can || g.offset > g.reach) })
    // Neighbours of those letting go, near the ends of their travel, go with them (both ways along the nut).
    for (const order of [1, -1]) {
      for (let j = 0; j < state.length; j++) {
        const i = order > 0 ? j : state.length - 1 - j, g = state[i], neighbour = state[i - order]
        if (g.current && !g.letGo && neighbour?.letGo && neighbour.current && g.offset > join * g.reach) g.letGo = true
      }
    }
    samples.forEach((s, i) => {
      const g = state[i], grips = this.grips[i]
      if (g.letGo) { this.endGrip(i, time); this.freeUntil[i] = time + this.switchoverTime }
      if (g.can && !(grips.length && grips[grips.length - 1].end === Infinity) && time >= this.freeUntil[i] - 1e-9) {
        const relative = phases[i]                     // (cycles; flights at m + 0.5)
        const flight = this.flightToTake(i, s, relative, g.reach, g.reach - HYSTERESIS, time)
        if (flight !== null) grips.push({ start: time, end: Infinity, flight, n: s.n })
      }
    })
    this.steerLead(time, samples)
  }

  // Picks the lead to aim for and moves the lead on by a step towards it.
  steerLead(time, samples) {
    const A = this.maxLeadAcceleration
    if (!(A > 0) || this.maxLead <= 0) return
    const lead = this._lead, rate = this._leadRate
    // The most the lead may be now and still come back to none, at rest, by the end (with a margin).
    const envelope = (t) => Math.min(this.maxLead, 0.5 * A * Math.max(0, this.end - t - STEP) ** 2 / 4)
    let target = 0
    const later = time + HORIZON
    if (later < this.end) {
      // Each grappler's phase HORIZON s ahead, and how it changes with the lead (cycles/m).
      const coasting = lead + rate * HORIZON
      const ahead = this.sampleAt(later, coasting)
      const nudged = this.sampleAt(later, coasting + SENSITIVITY_STEP)
      const sensitivity = this._sensitivity = ahead.map((s, i) => s.n === nudged[i].n ? wrap(nudged[i].phase - s.phase, s.n) / SENSITIVITY_STEP : 0)
      const limit = envelope(later)
      const spread = A * HORIZON * HORIZON / 2
      const from = Math.max(-limit, coasting - spread), to = Math.min(limit, coasting + spread)
      let best = -Infinity
      for (let c = 0; c < CANDIDATES && from <= to; c++) {
        const candidate = from + (to - from) * (CANDIDATES > 1 ? c / (CANDIDATES - 1) : 0.5)
        const score = this.score(ahead, sensitivity, candidate - coasting, later, samples)
        // (Ties go to the lead nearer none.)
        if (score > best + 1e-9 || (Math.abs(score - best) <= 1e-9 && Math.abs(candidate) < Math.abs(target))) { best = score; target = candidate }
      }
    }
    target = Math.max(-envelope(time), Math.min(envelope(time), target))
    // Towards the target as fast as the acceleration allows while still able to stop there.
    const error = target - lead
    // (Moving the lead moves every grappler towards the end of its travel one way: less so where gaps cost more.)
    const fastest = LEAD_DRIFT / Math.max(1, this.gapCost(time)) / Math.max(1e-9, ...(this._sensitivity ?? [0]).map(Math.abs))
    const wantedRate = Math.sign(error) * Math.min(fastest, Math.sqrt(2 * 0.8 * A * Math.abs(error)))
    const acceleration = Math.max(-A, Math.min(A, (wantedRate - rate) / STEP))
    this._leadRate = rate + acceleration * STEP
    this._lead = lead + (rate + this._leadRate) / 2 * STEP
    if (time + STEP >= this.end) { this._lead = 0; this._leadRate = 0 }
  }

  // How good it would be for the grapplers to have phases `ahead` (cycles, at `time`) moved by
  // shift * sensitivity: how many grip (keep their flight, or may take one) less gapCost for each gap
  // between them, then how near the middle of their travel those keeping their flight are.
  score(ahead, sensitivity, shift, time, now) {
    let count = 0, gaps = 0, centring = 0, seen = false, open = false
    for (let i = 0; i < ahead.length; i++) {
      const s = ahead[i], n = s.n
      const phase = s.phase + sensitivity[i] * shift
      const reach = this.reach(n, this.drift(i, s))
      const grips = this.grips[i]
      const current = grips.length && grips[grips.length - 1].end === Infinity ? grips[grips.length - 1] : null
      let holds = false
      if (current && n === now[i].n && reach > 0) {
        const offset = wrap(phase - current.flight - 0.5, n)
        holds = Math.abs(offset) <= reach
        centring -= (offset / reach) ** 2
      }
      else if (this.canGrip(i, s, time) && time >= this.freeUntil[i]) holds = Math.abs(wrap(phase - 0.5, 1)) <= reach - HYSTERESIS
      if (holds) { count++; if (open) gaps++; seen = true; open = false } else if (seen) open = true
    }
    return count - this.gapCost(time) * gaps + 0.1 * centring / Math.max(1, ahead.length)
  }

  endGrip(i, time) {
    const grips = this.grips[i]
    const grip = grips[grips.length - 1]
    grip.end = time
    if (grip.end - grip.start < MIN_GRIP) grips.pop()
  }

  // The number of flights under grappler i changes from n to n2 at `time`: renumber the flight it grips.
  rescaleGrip(i, n, n2, time) {
    const grips = this.grips[i]
    const grip = grips[grips.length - 1]
    if (!grip || grip.end !== Infinity) return
    ;(grip.renumbered ??= []).push({ time, flight: grip.flight, n: grip.n })
    grip.flight = Math.round((grip.flight + 1) * n2 / n - 1)
    grip.n = n2
  }
}
