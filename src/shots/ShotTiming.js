// Time warp: how simulated time advances with video time during a shot.
//
// Every camera keyframe has a `speed` (simulated seconds per second of video, default 1; 0 freezes
// the simulation). Between keyframes the speed changes geometrically (1x to 100x passes 10x halfway,
// which looks even to the eye); where either end is 0 it changes linearly. Before the first keyframe
// and after the last, the speed stays at that keyframe's value. Simulated time is the exact integral
// of the speed, so a shot can show a launch at 1x and then its whole flight at 50x without a jump.
//
// createTimeMap(keyframes) returns:
//   simOffsetAt(u)    simulated seconds since the shot's start at video time u (any u, also < 0)
//   videoTimeAt(s)    the earliest video time at which the offset reaches s
//   speedAt(u)
export const MAX_SPEED = 1e6

const speedOf = (key) => {
  const s = key.speed ?? 1
  return Number.isFinite(s) ? Math.min(MAX_SPEED, Math.max(0, s)) : 1
}

// Speed and its integral over a segment of length L from speed a to b, at fraction x of it.
function segmentSpeed(a, b, x) {
  if (a === b) return a
  if (a > 0 && b > 0) return a * (b / a) ** x
  return a + (b - a) * x
}

function segmentIntegral(a, b, L, x) {
  if (a === b) return a * L * x
  if (a > 0 && b > 0) {
    const lr = Math.log(b / a)
    return a * L * Math.expm1(lr * x) / lr
  }
  return L * (a * x + (b - a) * x * x / 2)
}

export function createTimeMap(keyframes) {
  const keys = keyframes ?? []
  const speeds = keys.map(speedOf)
  if (speeds.every(s => s === 1)) {
    return { simOffsetAt: (u) => u, videoTimeAt: (s) => s, speedAt: () => 1, isIdentity: true }
  }
  const n = keys.length
  const times = keys.map(k => k.time)
  // Offset at each keyframe.
  const offsets = new Array(n)
  offsets[0] = times[0] * speeds[0]
  for (let i = 1; i < n; i++) {
    offsets[i] = offsets[i - 1] + segmentIntegral(speeds[i - 1], speeds[i], times[i] - times[i - 1], 1)
  }

  const speedAt = (u) => {
    if (u <= times[0]) return speeds[0]
    if (u >= times[n - 1]) return speeds[n - 1]
    const i = upperIndex(times, u)
    const L = times[i + 1] - times[i]
    return L > 0 ? segmentSpeed(speeds[i], speeds[i + 1], (u - times[i]) / L) : speeds[i + 1]
  }

  const simOffsetAt = (u) => {
    if (u <= times[0]) return offsets[0] + (u - times[0]) * speeds[0]
    if (u >= times[n - 1]) return offsets[n - 1] + (u - times[n - 1]) * speeds[n - 1]
    const i = upperIndex(times, u)
    const L = times[i + 1] - times[i]
    return L > 0 ? offsets[i] + segmentIntegral(speeds[i], speeds[i + 1], L, (u - times[i]) / L) : offsets[i]
  }

  const videoTimeAt = (s) => {
    if (s <= offsets[0]) return speeds[0] > 0 ? times[0] + (s - offsets[0]) / speeds[0] : times[0]
    if (s >= offsets[n - 1]) return speeds[n - 1] > 0 ? times[n - 1] + (s - offsets[n - 1]) / speeds[n - 1] : times[n - 1]
    // First segment whose end offset reaches s, then bisect within it (the offset is monotonic).
    let i = 0
    while (offsets[i + 1] < s) i++
    const L = times[i + 1] - times[i]
    let lo = 0
    let hi = 1
    for (let iter = 0; iter < 64; iter++) {
      const mid = (lo + hi) / 2
      if (offsets[i] + segmentIntegral(speeds[i], speeds[i + 1], L, mid) < s) lo = mid
      else hi = mid
    }
    return times[i] + hi * L
  }

  return { simOffsetAt, videoTimeAt, speedAt, isIdentity: false }
}

// Index i with times[i] <= u < times[i + 1] (times sorted, u strictly inside the range).
function upperIndex(times, u) {
  let lo = 0
  let hi = times.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= u) lo = mid
    else hi = mid
  }
  return lo
}
