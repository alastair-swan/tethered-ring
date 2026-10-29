import { Vector3 } from 'three'

// Distance from a point to a curve (any three.js-style curve with getPointAt and getLength), for
// questions like "is the camera inside the tube?" where the curve is hundreds of kilometres long and
// the answer depends on metres. A cached coarse sampling finds the nearest stretch; a golden-section
// search along that stretch finds the nearest point. Curves are assumed not to fold back on
// themselves within one sample spacing.
const NUM_SAMPLES = 1001
const _p = new Vector3()
const cache = new WeakMap() // curve -> { key, samples }

function samplesFor(curve) {
  const key = curve.getLength()
  let entry = cache.get(curve)
  if (!entry || entry.key !== key) {
    const samples = new Float64Array(NUM_SAMPLES * 3)
    for (let i = 0; i < NUM_SAMPLES; i++) {
      curve.getPointAt(i / (NUM_SAMPLES - 1), _p)
      samples[i * 3] = _p.x; samples[i * 3 + 1] = _p.y; samples[i * 3 + 2] = _p.z
    }
    entry = { key, samples }
    cache.set(curve, entry)
  }
  return entry
}

// Returns the distance, or Infinity when it is certainly more than maxDistance (skipping refinement).
export function distanceToCurve(curve, point, maxDistance = Infinity) {
  return nearestOnCurve(curve, point, maxDistance)?.distance ?? Infinity
}

// The nearest point of the curve: { distance, u (its arc-length fraction along the curve) }, or null when
// it is certainly more than maxDistance away.
export function nearestOnCurve(curve, point, maxDistance = Infinity) {
  const { key: length, samples } = samplesFor(curve)
  let best = -1, bestD2 = Infinity
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const dx = samples[i * 3] - point.x, dy = samples[i * 3 + 1] - point.y, dz = samples[i * 3 + 2] - point.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < bestD2) { bestD2 = d2; best = i }
  }
  // The true nearest point is within one sample spacing of the nearest sample.
  const spacing = length / (NUM_SAMPLES - 1)
  if (Math.sqrt(bestD2) - spacing > maxDistance) return null
  const distanceAt = (u) => curve.getPointAt(Math.min(1, Math.max(0, u)), _p).distanceTo(point)
  let lo = Math.max(0, best - 1) / (NUM_SAMPLES - 1)
  let hi = Math.min(NUM_SAMPLES - 1, best + 1) / (NUM_SAMPLES - 1)
  const ratio = (Math.sqrt(5) - 1) / 2
  let x1 = hi - ratio * (hi - lo), x2 = lo + ratio * (hi - lo)
  let f1 = distanceAt(x1), f2 = distanceAt(x2)
  // Down to ~1 mm on a 1000 km curve.
  for (let iteration = 0; iteration < 40 && (hi - lo) * length > 1e-3; iteration++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - ratio * (hi - lo); f1 = distanceAt(x1) }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + ratio * (hi - lo); f2 = distanceAt(x2) }
  }
  return f1 < f2 ? { distance: f1, u: x1 } : { distance: f2, u: x2 }
}
