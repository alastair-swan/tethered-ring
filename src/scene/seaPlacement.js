import * as THREE from 'three'

// Shared by the things placed on the sea (Sailboats.js, ContainerShips.js): deterministic random numbers
// (so recorded shots show the same things on every machine), the wind, and how a vessel sits at a place.

// A 32-bit hash of integer seeds.
export function hash(...values) {
  let h = 2166136261
  for (const v of values) {
    h ^= v | 0
    h = Math.imul(h, 16777619)
    h ^= h >>> 13
  }
  return h >>> 0
}

// Random numbers in [0, 1) from a seed.
export function random(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One of [value, weight] pairs, for r in [0, 1).
export function pickWeighted(list, r) {
  const total = list.reduce((sum, [, w]) => sum + w, 0)
  let x = r * total
  for (const [value, w] of list) if ((x -= w) < 0) return value
  return list[list.length - 1][0]
}

// The wind: uniform over WIND_CELL_DEG cells; `from` is the direction it blows from (radians clockwise
// from north).
const WIND_CELL_DEG = 3
export function windAt(lat, lon) {
  const r = random(hash(Math.floor((lat + 90) / WIND_CELL_DEG), Math.floor((lon + 180) / WIND_CELL_DEG), 77))
  return { from: r() * 2 * Math.PI, knots: 6 + 12 * r() }
}

// The point `east` and `north` metres from (lat, lon) along the surface (small offsets).
export function offsetLatLon(ellipsoid, lat, lon, east, north) {
  const a = ellipsoid.a, f = ellipsoid.f || 0, e2 = 2 * f - f * f
  const phi = lat * Math.PI / 180, s = Math.sin(phi)
  const w = Math.sqrt(1 - e2 * s * s)
  const meridian = a * (1 - e2) / (w * w * w), normal = a / w
  return [lat + north / meridian * 180 / Math.PI, lon + east / (normal * Math.cos(phi)) * 180 / Math.PI]
}

const _up = new THREE.Vector3()
const _east = new THREE.Vector3()
const _north = new THREE.Vector3()
const _bow = new THREE.Vector3()
const _port = new THREE.Vector3()

// Rotation of a model (+Y up, bow along +Z) heading `heading` radians clockwise from north at (lat,
// lon), in three.js planet axes (x east of Greenwich, y the polar axis, z the Greenwich meridian).
export function vesselBasis(lat, lon, heading, out) {
  const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180
  const sp = Math.sin(phi), cp = Math.cos(phi), sl = Math.sin(lambda), cl = Math.cos(lambda)
  _up.set(cp * sl, sp, cp * cl)
  _east.set(cl, 0, -sl)
  _north.set(-sp * sl, cp, -sp * cl)
  _bow.copy(_north).multiplyScalar(Math.cos(heading)).addScaledVector(_east, Math.sin(heading))
  _port.crossVectors(_up, _bow)
  return out.makeBasis(_port, _up, _bow)
}
