// Interpolates a shot's camera keyframes at an arbitrary (video) time.
//
// 'smooth' is a cubic Hermite spline through the keyframes, with non-uniform Catmull-Rom tangents
// (the slope of the parabola through each key and its neighbours, weighted by the keyframe *times*),
// so the camera passes through every keyframe exactly when it was set and moves without speed jumps.
// A keyframe with `ease: true` has zero velocity there (the camera eases in and out of it).
// 'linear' is used for densely sampled paths recorded from a live take.
//
// Each segment (from keyframe i to i+1) moves the camera in one of two ways, chosen by keyframe i's
// `motion`:
//   'direct' - the camera position and its target each follow the spline. A fly-by stays a straight
//              line past the target.
//   'orbit'  - the target follows the spline; the camera is placed from the target by a direction and
//              a distance, with the *logarithm* of the distance on the spline. A zoom from 50 m to
//              30,000 km then takes equal time per factor of ten instead of leaving the subject at
//              thousands of km/s. While the distance changes, the target moves in proportion to the
//              distance (not to time), so a subject stays in frame while the camera pulls away from it.
//   'auto'   - (the default) 'orbit' where the camera's distance to its target changes by more than
//              ORBIT_RATIO over the segment, otherwise 'direct'.
//
// Keyframes may be relative to moving objects (see Anchors.js). The caller passes `resolve(key)`,
// which returns the key's world-space pose *at the current simulation time*; every keyframe the
// spline needs is resolved at that same moment. Where neighbouring keys share an anchor this is the
// same as interpolating in the anchor's frame, so a camera keyed to a vehicle rides along with it.
//
// All arithmetic is on plain JS numbers (float64), so world coordinates of ~6.4e6 m keep
// sub-millimetre precision.
export const ORBIT_RATIO = 3

const identity = (key) => key

function lerp3(a, b, u) {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function length3(v) {
  return Math.hypot(v[0], v[1], v[2])
}

function normalize3(v, fallback = v) {
  const l = length3(v)
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : fallback
}

// Tangent (per second) at the middle of three values with times ta, tb, tc. Missing neighbours
// (null) give the one-sided slope.
function tangent(va, vb, vc, ta, tb, tc, dims) {
  const out = new Array(dims)
  for (let k = 0; k < dims; k++) {
    const left = va !== null && tb > ta ? (vb[k] - va[k]) / (tb - ta) : null
    const right = vc !== null && tc > tb ? (vc[k] - vb[k]) / (tc - tb) : null
    if (left === null) out[k] = right ?? 0
    else if (right === null) out[k] = left
    else out[k] = (left * (tc - tb) + right * (tb - ta)) / (tc - ta)
  }
  return out
}

// One spline segment over four (possibly null at the ends) values of `dims` components.
// ease1/ease2: zero tangent at the segment's start/end.
function hermite(v0, v1, v2, v3, t0, t1, t2, t3, t, ease1, ease2, dims) {
  const L = t2 - t1
  if (!(L > 0)) return v1.slice()
  const m1 = ease1 ? new Array(dims).fill(0) : tangent(v0, v1, v2, t0, t1, t2, dims)
  const m2 = ease2 ? new Array(dims).fill(0) : tangent(v1, v2, v3, t1, t2, t3, dims)
  const s = (t - t1) / L
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  const out = new Array(dims)
  for (let k = 0; k < dims; k++) out[k] = h00 * v1[k] + h10 * L * m1[k] + h01 * v2[k] + h11 * L * m2[k]
  return out
}

// The motion a segment uses, given its two resolved end keys.
export function segmentMotion(key, a, b) {
  const motion = key.motion ?? 'auto'
  if (motion !== 'auto') return motion
  const da = length3(sub3(a.position, a.target))
  const db = length3(sub3(b.position, b.target))
  const lo = Math.min(da, db)
  return lo > 0 && Math.max(da, db) / lo > ORBIT_RATIO ? 'orbit' : 'direct'
}

function poseOf(key, resolved, time) {
  return {
    time,
    position: resolved.position.slice(),
    target: resolved.target.slice(),
    up: resolved.up.slice(),
    orbitUp: (resolved.orbitUp ?? resolved.up).slice(),
    fov: key.fov,
  }
}

// Index i of the segment [keys[i], keys[i+1]] containing t (keys sorted by time, t inside the range).
function segmentIndex(keys, t) {
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keys[mid].time <= t) lo = mid
    else hi = mid
  }
  return lo
}

export function sampleCameraPath(camera, t, resolve = identity) {
  const keys = camera.keyframes
  if (!keys.length) return null
  if (keys.length === 1 || t <= keys[0].time) return poseOf(keys[0], resolve(keys[0]), t)
  const last = keys[keys.length - 1]
  if (t >= last.time) return poseOf(last, resolve(last), t)

  const i = segmentIndex(keys, t)
  const k1 = keys[i]
  const k2 = keys[i + 1]
  const r1 = resolve(k1)
  if (t === k1.time) return poseOf(k1, r1, t)
  const r2 = resolve(k2)
  const span = k2.time - k1.time
  const u = span > 0 ? (t - k1.time) / span : 0
  const fov1 = k1.fov ?? k2.fov
  const fov2 = k2.fov ?? k1.fov
  const orbitUp = normalize3(lerp3(r1.orbitUp ?? r1.up, r2.orbitUp ?? r2.up, u), r1.orbitUp ?? r1.up)

  if (camera.interpolation === 'linear') {
    return {
      time: t,
      position: lerp3(r1.position, r2.position, u),
      target: lerp3(r1.target, r2.target, u),
      up: normalize3(lerp3(r1.up, r2.up, u), r1.up),
      orbitUp,
      fov: fov1 + (fov2 - fov1) * u,
    }
  }

  const k0 = keys[i - 1] ?? null
  const k3 = keys[i + 2] ?? null
  const r0 = k0 && resolve(k0)
  const r3 = k3 && resolve(k3)
  const t0 = k0?.time ?? 0
  const t3 = k3?.time ?? 0
  const e1 = !!k1.ease
  const e2 = !!k2.ease
  const spline = (pick, dims, at = t) => hermite(r0 && pick(r0, k0), pick(r1, k1), pick(r2, k2), r3 && pick(r3, k3), t0, k1.time, k2.time, t3, at, e1, e2, dims)

  const up = normalize3(spline(r => r.up, 3), r1.up)
  const fov = Math.min(170, Math.max(0.01, spline((r, k) => [k.fov ?? fov1], 1)[0]))

  if (segmentMotion(k1, r1, r2) === 'direct') {
    return { time: t, position: spline(r => r.position, 3), target: spline(r => r.target, 3), up, orbitUp, fov }
  }

  // Orbit: direction and log-distance from the target.
  const offset = (r) => sub3(r.position, r.target)
  const logDistance = (r) => [Math.log(Math.max(1e-6, length3(offset(r))))]
  const direction = (r) => normalize3(offset(r), [0, 0, 1])
  const distance = Math.exp(spline(logDistance, 1)[0])
  const dir = normalize3(spline(direction, 3), direction(r1))
  // Move the target in step with the distance, so a subject stays in frame during a zoom.
  const d1 = Math.exp(logDistance(r1)[0])
  const d2 = Math.exp(logDistance(r2)[0])
  let targetTime = t
  if (Math.abs(d2 - d1) > 1e-9 * Math.max(d1, d2)) {
    const w = Math.min(1, Math.max(0, (distance - d1) / (d2 - d1)))
    targetTime = k1.time + w * span
  }
  const target = spline(r => r.target, 3, targetTime)
  const position = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance]
  return { time: t, position, target, up, orbitUp, fov }
}
