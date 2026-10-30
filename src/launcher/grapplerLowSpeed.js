// The adaptive nut's grapplers at low speed, before they hand over to the lattice (grapplerLattice.js).
//
// At low speed the flights drift past the grapplers fast, and runs of neighbours on one flight are short,
// so the lattice cannot keep many gripping (and would have neighbours hop together). Instead the grips
// are chained, in layers: the first layer keeps one grappler engaged from as early as one can be, the
// grip that will last the longest; before it has to let go, the next has landed: of the grips that can
// take over then, the one lasting longest, landing as late as it can while the one before still holds.
// Each further layer is another such chain, of the grips the layers before leave free (a grappler is in
// one grip at a time, with a hop's time between). So the count engaged, once a layer is established,
// does not fall below it again: one, then two, three...
//
// The handover. The lattice takes over at the earliest time from which its fewest engaged, for the rest
// of the run, is at least what the layers have kept engaged over the last hop's time: so the guarantee
// never falls. The layers
// go on starting grips for two hops' time after it (so that those joining the lattice have landed before
// the chains stop handing over), and each grappler joins the lattice when its last grip from the layers
// ends.
//
// Everything is worked out on the plan's grid from the screw alone, once per plan.

// x wrapped into [-m/2, m/2).
const wrap = (x, m) => x - m * Math.floor(x / m + 0.5)

// plan: the GrapplerLatticePlan. Returns { handover (grid step), grips: per grappler, its grips from the
// layers in time order [{ flight (angle, turns), from, to } (grid steps)], joins: per grappler, the grid
// step from which it follows the lattice, guarantee: per grid step, the count engaged guaranteed from
// then on (the layers established by then; from the handover, what the lattice takes over), never
// falling }.
export function lowSpeedGrips(plan) {
  const K = plan.lastStep, hop = 2 * plan.half, N = plan.samplesAt(0).length
  // Opportunities: per grappler, the stretches [from, to] over which a flight is within its travel (and it
  // is over the thread). It can only land where the flights drift past slowly enough (landable), but once
  // gripping, holds on however fast they go.
  const opportunities = Array.from({ length: N }, () => [])
  const open = Array.from({ length: N }, () => new Map())
  const landable = Array.from({ length: N }, () => new Uint8Array(K + 1))
  for (let k = 0; k <= K + 1; k++) {
    const samples = k <= K ? plan.samplesAt(k * plan.grid) : null
    for (let i = 0; i < N; i++) {
      const here = new Set()
      const s = samples?.[i]
      if (s && Math.abs(s.rate * s.n) <= plan.fastestDrift) landable[i][k] = 1
      if (s && s.engageable) {
        const angle = (s.phase + 0.5) / s.n
        for (let m = 0; m < s.n; m++) if (Math.abs(wrap(angle - m / s.n, 1)) <= plan.holdLimit + 1e-9) here.add(Math.round(m / s.n * 1e6))
      }
      for (const [flight, from] of open[i]) if (!here.has(flight)) { opportunities[i].push({ flight: flight / 1e6, from, to: k - 1 }); open[i].delete(flight) }
      for (const flight of here) if (!open[i].has(flight)) open[i].set(flight, k)
    }
  }
  // The lattice's fewest engaged from each grid step to the end of the run (from each grappler's stretches
  // gripping by the lattice).
  const change = new Int32Array(K + 2)
  for (let i = 0; i < N; i++) for (const [from, to] of plan.latticeHolds(i)) { change[Math.max(0, from)]++; change[Math.min(K + 1, to + 1)]-- }
  const engagedByLattice = new Int16Array(K + 1)
  for (let k = 0, n = 0; k <= K; k++) { n += change[k]; engagedByLattice[k] = n }
  const fewestFrom = new Int16Array(K + 2).fill(N)
  for (let k = K; k >= 0; k--) fewestFrom[k] = Math.min(engagedByLattice[k], fewestFrom[k + 1])
  // The layers, built to an horizon that grows until the handover is found within it.
  for (let horizon = Math.min(K, Math.round(10 / plan.grid)); ; horizon = Math.min(K, horizon * 2)) {
    const result = layersTo(horizon, opportunities, landable, N, K, hop, fewestFrom)
    if (result || horizon >= K) return result ?? { handover: K + 1, grips: Array.from({ length: N }, () => []), joins: new Array(N).fill(K + 1), guarantee: new Int16Array(K + 1) }
  }
}

function layersTo(horizon, opportunities, landable, N, K, hop, fewestFrom) {
  const busy = Array.from({ length: N }, () => [])
  const freeFor = (i, from, to) => busy[i].every(([a, b]) => to + hop < a || from - hop > b)
  // The grip that can start at grid step k lasting the longest: { i, flight, from, to } or null.
  const bestGrip = (k) => {
    let best = null
    for (let i = 0; i < N; i++) {
      if (!landable[i][k]) continue
      for (const o of opportunities[i]) {
        if (o.from > k || o.to <= k) continue
        // (One grip per opportunity: a second, before or after one it already has on the flight, would
        // have it let go of the flight only to take it again.)
        if (busy[i].some(([a, b, flight]) => Math.abs(flight - o.flight) < 1e-9 && o.from <= a && b <= o.to)) continue
        let to = o.to
        for (const [a] of busy[i]) if (a - hop > k && a - hop - 1 < to) to = a - hop - 1
        if (to <= k || !freeFor(i, k, to)) continue
        if (!best || to > best.to || (to === best.to && i < best.i)) best = { i, flight: o.flight, from: k, to }
      }
    }
    return best
  }
  const engaged = new Int16Array(K + 1)
  const chains = []
  for (let layer = 0; layer < N; layer++) {
    const chain = []
    for (let k = 0; k < horizon;) {
      let grip = bestGrip(k)
      if (!grip) { k++; continue }
      while (grip) {
        chain.push(grip)
        busy[grip.i].push([grip.from, grip.to, grip.flight])
        if (grip.to >= horizon) { k = horizon; break }
        // The next lands as late as it can while this one still holds.
        let next = null
        for (let start = grip.to - 1; start >= grip.from && !next; start--) next = bestGrip(start)
        if (!next || next.to <= grip.to) { k = grip.to + 1; break }
        grip = next
      }
    }
    if (!chain.length) break
    chains.push(chain)
    for (const g of chain) for (let k = g.from; k <= Math.min(K, g.to); k++) engaged[k]++
  }
  // The layers' guarantee at grid step k: the fewest they have had engaged over the last hop's time. The
  // handover: the earliest k where the lattice keeps at least that from then on.
  let handover = -1, handed = 0
  for (let k = hop; k < horizon; k++) {
    let guarantee = Infinity
    for (let j = k - hop; j <= k; j++) guarantee = Math.min(guarantee, engaged[j])
    if (guarantee > 0 && fewestFrom[k] >= guarantee) { handover = k; handed = guarantee; break }
  }
  if (handover < 0) return null
  const until = handover + 2 * hop
  const grips = Array.from({ length: N }, () => [])
  for (const chain of chains) for (const g of chain) if (g.from < until) grips[g.i].push(g)
  grips.forEach(list => list.sort((a, b) => a.from - b.from))
  const joins = grips.map(list => Math.max(handover, ...list.filter(g => g.to >= handover).map(g => g.to + 1)))
  // The guarantee: before the handover, the layers established (each from where its chain last starts
  // without a break, to the handover); from it, what the lattice takes over.
  const guarantee = new Int16Array(K + 1)
  for (const chain of chains) {
    let established = null
    for (let j = 0; j < chain.length; j++) {
      if (chain[j].from > handover) break
      if (j === 0 || chain[j].from > chain[j - 1].to) established = chain[j].from
    }
    const reaches = chain.some(g => g.from <= handover && g.to >= handover)
    if (reaches && established !== null) for (let k = established; k < handover; k++) guarantee[k]++
  }
  for (let k = handover; k <= K; k++) guarantee[k] = handed
  for (let k = 1; k <= K; k++) guarantee[k] = Math.max(guarantee[k], guarantee[k - 1])
  return { handover, grips, joins, guarantee }
}
