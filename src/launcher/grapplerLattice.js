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
// grappler and, since the travel is a fixed angle, wherever the screw has more or fewer flights. Each grappler holds the
// lattice flight nearest the middle of its travel. So
// - it keeps a flight across as much of its travel as the lattice allows, and when the flight drifts past
//   half a step from the middle it moves to the next lattice flight: a hop, centred on that moment (it
//   lets go half a hop's time before, and lands half a hop's time after);
// - neighbours hold the same flight, in runs, ending only where the drift of phase along the nut crosses
//   half a step: as few runs as that spacing allows;
// - a run of a single grappler is left free (it waits until a neighbour can join it: alone it would add
//   two run ends for one grappler's grip).
// Where the travel is less than the spacing between flights (step 0), each grappler holds the nearest
// flight while it is within its travel, and is free in between. It does not grip where it may not:
// before the thread, off the screws, or where the flights drift past faster than fastestDrift (it could
// not land on them).
//
// The alignment. Where the travel spans more than one flight spacing there is more than one lattice
// (`offset` from the flights at whole turns): every second flight, say, from the even ones or the odd
// ones. The one used is the one with the fewest runs and free grapplers over the LOOKAHEAD s from now
// (looking ahead, it does not flip back and forth as the two run close). A change of lattice (of
// alignment, or of spacing where the nut moves onto more flights) would move many grapplers at once;
// instead it sweeps along the nut from front to back over SWEEP s: grappler i of N follows the lattice
// chosen SWEEP * i / (N - 1) s earlier, so each hops once, where the old and new runs meet.
//
// Everything is evaluated on a grid of GRID s (the alignment on one of COARSE s) and remembered; that is
// only a cache: each value is a pure function of its time.
const GRID = 1 / 30
const COARSE = 0.1
const LOOKAHEAD = 2
const SWEEP = 1

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
export function latticeArrangement(samples, { holdLimit, fastestDrift, step, offset = 0 }) {
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
  // A run of one is left free.
  const same = (a, b) => b !== undefined && a.flight !== null && b.flight !== null && Math.abs(wrap(a.flight - b.flight, 1)) < 1e-6
  const alone = out.map((g, i) => g.flight !== null && !same(g, out[i - 1]) && !same(g, out[i + 1]))
  out.forEach((g, i) => { if (alone[i]) g.flight = null })
  return out
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
  }

  samplesAt(time) {
    let samples = this._samples.get(time)
    if (!samples) this._samples.set(time, samples = this.sampleAt(Math.min(Math.max(0, time), this.end)))
    return samples
  }

  arrange(samples, step, offset) {
    return latticeArrangement(samples, { holdLimit: this.holdLimit, fastestDrift: this.fastestDrift, step, offset })
  }

  // The lattice chosen at coarse step q, { step, offset } (turns): its spacing from the fewest flights
  // under the nut's grapplers then, and of its alignments (multiples of the most flights' spacing), the one with the
  // fewest runs and free grapplers over the LOOKAHEAD s from then.
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
      for (let r = q; r <= q + Math.round(LOOKAHEAD / COARSE); r++) {
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

  // The arrangement at grid step k (see latticeArrangement), with changes of lattice sweeping along the nut.
  arrangementAt(k) {
    let arrangement = this._arrangements.get(k)
    if (arrangement) return arrangement
    const time = k * GRID, samples = this.samplesAt(time), last = Math.max(1, samples.length - 1)
    const lattice = (i) => this.latticeAt(Math.floor((time - SWEEP * i / last) / COARSE + 1e-9))
    this._arrangements.set(k, arrangement = this.arrange(samples, (i) => lattice(i).step, (i) => lattice(i).offset))
    return arrangement
  }
  // The flight (angle, turns) grappler i holds at grid step k, or null.
  flightAt(i, k) {
    return this.arrangementAt(k)[i]?.flight ?? null
  }

  // The change of flight for grappler i nearest `time` within half a hop's time either side: { at (s),
  // from, to } (flight angles or null), or null if none.
  hopNear(i, time) {
    const half = this.switchoverTime / 2
    const k0 = Math.floor((time - half) / GRID), k1 = Math.ceil((time + half) / GRID)
    let best = null
    for (let k = k0 + 1; k <= k1; k++) {
      const from = this.flightAt(i, k - 1), to = this.flightAt(i, k)
      const same = from === to || (from !== null && to !== null && Math.abs(wrap(from - to, 1)) < 1e-6)
      if (same) continue
      const at = (k - 0.5) * GRID
      if (Math.abs(at - time) < half && (!best || Math.abs(at - time) < Math.abs(best.at - time))) best = { at, from, to }
    }
    return best
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
    const hop = this.hopNear(i, time)
    if (!hop) {
      const flight = this.flightAt(i, Math.round(time / GRID))
      if (flight === null) return Object.assign(out, { lift: 1, raise: 1, neutral: 1, alpha: 0, attached: false })
      return Object.assign(out, { lift: 0, raise: 0, neutral: 0, alpha: inRange(following(flight)(0)), attached: true })
    }
    // In a hop centred on hop.at: progress p from 0 (lets go) to 1 (lands); from or to parked (null).
    const S = this.switchoverTime, start = hop.at - S / 2 - time, end = hop.at + S / 2 - time
    const p = Math.min(1, Math.max(0, -start / S))
    const fastest = 2 * Math.PI * this.fastestDrift / n, slow = (PROFILE.slow[1] - PROFILE.slow[0]) * S
    const low = -0.9 * limit, high = 0.9 * limit
    const leave = hop.from === null ? () => 0 : leaving(following(hop.from), start + PROFILE.slow[0] * S, slow, low, high, fastest)
    const arrive = hop.to === null ? () => 0 : arriving(following(hop.to), end - PROFILE.slow[0] * S, slow, low, high, fastest)
    const [from, to] = hop.from === null ? [0.5, PROFILE.move[1]] : hop.to === null ? [PROFILE.move[0], 0.5] : PROFILE.move
    const w = smootherstep((p - from) / (to - from))
    return Object.assign(out, {
      lift: outAndBack(PROFILE.lift, p), raise: outAndBack(PROFILE.raise, p), neutral: outAndBack(PROFILE.untwist, p),
      alpha: inRange(leave(0) * (1 - w) + arrive(0) * w), attached: false,
    })
  }
}
