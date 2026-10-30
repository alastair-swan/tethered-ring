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
// step from which it follows the lattice }.
export function lowSpeedGrips(plan) {
  const K = plan.lastStep, hop = 2 * plan.half, N = plan.samplesAt(0).length
  // Opportunities: per grappler, the stretches [from, to] over which a flight is within its travel and it
  // may grip.
  const opportunities = Array.from({ length: N }, () => [])
  const open = Array.from({ length: N }, () => new Map())
  for (let k = 0; k <= K + 1; k++) {
    const samples = k <= K ? plan.samplesAt(k * plan.grid) : null
    for (let i = 0; i < N; i++) {
      const here = new Set()
      const s = samples?.[i]
      if (s && s.engageable && Math.abs(s.rate * s.n) <= plan.fastestDrift) {
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
    const result = layersTo(horizon, opportunities, N, K, hop, fewestFrom)
    if (result || horizon >= K) return result ?? { handover: K + 1, grips: result?.grips ?? Array.from({ length: N }, () => []), joins: new Array(N).fill(K + 1) }
  }
}

function layersTo(horizon, opportunities, N, K, hop, fewestFrom) {
  const busy = Array.from({ length: N }, () => [])
  const freeFor = (i, from, to) => busy[i].every(([a, b]) => to + hop < a || from - hop > b)
  // The grip that can be under way at grid step k lasting the longest: { i, flight, from, to } or null.
  const bestGrip = (k) => {
    let best = null
    for (let i = 0; i < N; i++) {
      for (const o of opportunities[i]) {
        if (o.from > k || o.to <= k) continue
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
        busy[grip.i].push([grip.from, grip.to])
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
  let handover = -1
  for (let k = hop; k < horizon; k++) {
    let guarantee = Infinity
    for (let j = k - hop; j <= k; j++) guarantee = Math.min(guarantee, engaged[j])
    if (guarantee > 0 && fewestFrom[k] >= guarantee) { handover = k; break }
  }
  if (handover < 0) return null
  const until = handover + 2 * hop
  const grips = Array.from({ length: N }, () => [])
  for (const chain of chains) for (const g of chain) if (g.from < until) grips[g.i].push(g)
  grips.forEach(list => list.sort((a, b) => a.from - b.from))
  const joins = grips.map(list => Math.max(handover, ...list.filter(g => g.to >= handover).map(g => g.to + 1)))
  return { handover, grips, joins }
}
