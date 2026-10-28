// Shared helpers for objects placed around the tethered ring.
//
// Ring-local coordinates: the ring lies (approximately) in the x-z plane of tetheredRingRefCoordSys,
// with y along the ring's axis. A position fraction p in [0, 1) maps to curve.getPoint(p) and to
// the angle 2*pi*p around the axis. Offsets from the main ring curve are given as a radial offset
// `dr` (in the x-z plane), an axial offset `dy`, and a forward offset along the ring tangent.
//
// Note: like the original code, this assumes the main ring curve is (close to) a circle, so that
// curve.getPoint(p) sits at angle 2*pi*p.
import * as THREE from 'three'

export function posFrac(x) {
  return x - Math.floor(x)
}

const _point = new THREE.Vector3()

// Writes the ring-local position of a point at fraction p with the given offsets into `target`.
export function ringPoint(curve, p, dr, dy, forward, target) {
  curve.getPoint(p, _point)
  const angle = 2 * Math.PI * p
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return target.set(
    _point.x + dr * c - forward * s,
    _point.y + dy,
    _point.z + dr * s + forward * c)
}

// Positions and orients a model on the ring (rotation order matches the original placement code).
export function placeModelOnRing(om, curve, p, dr, dy, forward, rotZ) {
  ringPoint(curve, p, dr, dy, forward, om.position)
  om.rotation.set(0, -2 * Math.PI * p, rotZ)
}

// Base class for "virtual" objects: lightweight records that get a real model from a ModelPool
// only while they are near the camera.
export class VirtualRingObject {
  constructor(positionInFrameOfReference, pool) {
    this.p = positionInFrameOfReference
    this.pool = pool
    this.model = null
  }

  // Static objects are placed once when they receive a model; dynamic ones are placed every frame.
  static isDynamic = false

  trackPosition(refFrame) {
    return posFrac(this.p + refFrame.p)
  }

  placeAndOrientModel(/* om, refFrame, wedgeToCameraDistance */) {
    throw new Error('placeAndOrientModel must be implemented by subclasses')
  }

  // Default look-ahead for static objects: where the model is now.
  getFuturePosition(refFrame /*, timeDeltaInSeconds */) {
    const tmp = new THREE.Object3D()
    this.placeAndOrientModel(tmp, refFrame)
    return tmp.position.clone()
  }
}

// Small deterministic PRNG (mulberry32), so "randomized" layouts are identical on every computer.
export function seededRandom(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Transit stops are evenly spaced around the ring. `nt` of them are ring terminuses (with elevators)
// and `nh` are habitats, interspersed as evenly as possible. Returns sorted position arrays.
export function transitStopLayout(nt, nh) {
  const numStops = Math.max(0, nt + nh)
  const terminusPositions = []
  const habitatPositions = []
  let prevFloor = -1
  for (let i = 0; i < numStops; i++) {
    const p = i / numStops
    const currFloor = Math.floor(i * nt / numStops)
    if (currFloor === prevFloor) habitatPositions.push(p)
    else terminusPositions.push(p)
    prevFloor = currFloor
  }
  return {
    numStops,
    terminusPositions: Float64Array.from(terminusPositions),
    habitatPositions: Float64Array.from(habitatPositions),
  }
}

// Index of the first element of the sorted array that is >= x.
export function lowerBound(sorted, x) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Calls fn(index) for each element of a sorted array of fractions that lies within `halfWidth`
// of `center`, taking wrap-around at 0/1 into account.
export function forEachInWindow(sorted, center, halfWidth, fn) {
  const n = sorted.length
  if (n === 0) return
  if (halfWidth >= 0.5) {
    for (let i = 0; i < n; i++) fn(i)
    return
  }
  const start = posFrac(center - halfWidth)
  const end = posFrac(center + halfWidth)
  if (start <= end) {
    for (let i = lowerBound(sorted, start); i < n && sorted[i] <= end; i++) fn(i)
  }
  else {
    for (let i = lowerBound(sorted, start); i < n; i++) fn(i)
    for (let i = 0; i < n && sorted[i] <= end; i++) fn(i)
  }
}
