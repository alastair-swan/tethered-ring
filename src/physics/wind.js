import climatology from './windClimatology.data.js'

// The surface (10 m) wind anywhere on Earth at a date and time of day: plausible weather, not a
// forecast. It is a pure function of (place, day of year, UTC hours), so recorded shots get the same
// wind on every machine.
//
// - The climate: a monthly climatology from NCEP/NCAR reanalysis winds (2022-2023; baked by
//   tools/sources/build_wind.py into windClimatology.data.js) on a 5-degree grid: the mean wind, its
//   daily cycle (sea breezes, the trades' daily swing) and the RMS of the weather about them (sigma).
//   It is interpolated bilinearly between grid nodes and linearly between months (each month's values
//   are at mid-month), so it has no edges.
// - The weather: eddies a few hundred to a couple of thousand kilometres across, the curl of a
//   smooth random stream function on the sphere (so the wind swirls around highs and lows rather than
//   pouring out of points), scaled to the local sigma. The field is redrawn about every WEATHER_DAYS
//   and cross-faded between draws, repeating each year.

const { rows, cols, gridDegrees, fields, scale } = climatology
const FIELDS = fields.length
const DATA = Int8Array.from(atob(climatology.data), (c) => {
  const b = c.charCodeAt(0)
  return b > 127 ? b - 256 : b
})
const U = fields.indexOf('u'), V = fields.indexOf('v'), SIGMA = fields.indexOf('sigma')
const U_COS = fields.indexOf('uCos'), U_SIN = fields.indexOf('uSin'), V_COS = fields.indexOf('vCos'), V_SIN = fields.indexOf('vSin')

const DAYS_PER_YEAR = 365.25
const PLANET_RADIUS = 6371000 // m
// The eddies: stream-function octaves (feature size, m; relative amplitude).
const EDDIES = [[1500e3, 1], [600e3, 0.4]]
// About every WEATHER_DAYS: a whole number of draws per year, so the weather repeats without a jump.
const WEATHER_DAYS = 1.5
const WEATHER_PERIOD = Math.round(DAYS_PER_YEAR / WEATHER_DAYS) // draws per year
const GRADIENT_STEP = 20e3 / PLANET_RADIUS // radians

// The climate fields at a grid node (month 0..11, row 0..rows-1, column any integer).
function node(month, row, col, out, weight) {
  const o = ((month * rows + row) * cols + (((col % cols) + cols) % cols)) * FIELDS
  for (let f = 0; f < FIELDS; f++) out[f] += weight * DATA[o + f] * scale
}

const _climate = new Float64Array(FIELDS)
// The climate fields, interpolated in place and season.
function climate(lat, lon, dayOfYear, utcHours) {
  _climate.fill(0)
  const m = ((dayOfYear - 1 + utcHours / 24) / DAYS_PER_YEAR) * 12 - 0.5
  const m0 = Math.floor(m), fm = m - m0
  const r = Math.min(Math.max((lat + 90) / gridDegrees, 0), rows - 1.000001)
  const r0 = Math.floor(r), fr = r - r0
  const c = lon / gridDegrees
  const c0 = Math.floor(c), fc = c - c0
  for (const [month, wm] of [[(m0 % 12 + 12) % 12, 1 - fm], [((m0 + 1) % 12 + 12) % 12, fm]]) {
    node(month, r0, c0, _climate, wm * (1 - fr) * (1 - fc))
    node(month, r0, c0 + 1, _climate, wm * (1 - fr) * fc)
    node(month, r0 + 1, c0, _climate, wm * fr * (1 - fc))
    node(month, r0 + 1, c0 + 1, _climate, wm * fr * fc)
  }
  return _climate
}

// A 32-bit hash of integers, to [0, 1).
function hash(a, b, c, d) {
  let h = 2166136261
  for (const v of [a, b, c, d]) {
    h = Math.imul(h ^ (v | 0), 16777619)
    h ^= h >>> 15
  }
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10)

// Value noise in [-1, 1] at (x, y, z), from lattice `seed`.
function noise(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const fx = smooth(x - xi), fy = smooth(y - yi), fz = smooth(z - zi)
  let sum = 0
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2
    sum += (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz) * hash(xi + dx, yi + dy, zi + dz, seed)
  }
  return sum * 2 - 1
}

// The stream function at a point of the unit sphere for weather draw `draw`.
function streamFunction(x, y, z, draw) {
  let sum = 0
  EDDIES.forEach(([size, amplitude], i) => {
    const k = PLANET_RADIUS / size
    sum += amplitude * noise(x * k, y * k, z * k, draw * 7 + i)
  })
  return sum
}

// The eddies' wind (east, north), unscaled, at latitude/longitude (radians) for weather draw `draw`.
function eddies(phi, lambda, draw, out) {
  const at = (p, l) => streamFunction(Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l), draw)
  const h = GRADIENT_STEP
  const dNorth = (at(phi + h, lambda) - at(phi - h, lambda)) / (2 * h)
  const dEast = (at(phi, lambda + h / Math.max(Math.cos(phi), 1e-3)) - at(phi, lambda - h / Math.max(Math.cos(phi), 1e-3))) / (2 * h)
  out[0] = -dNorth
  out[1] = dEast
  return out
}

// The eddies' RMS per component, so that sigma scales them to the data (sampled once, deterministically).
let eddyRms = 0
function eddyScale() {
  if (eddyRms) return eddyRms
  const e = [0, 0]
  let sum = 0, n = 0
  for (let i = 0; i < 4000; i++) {
    const phi = Math.asin(2 * hash(i, 1, 2, 3) - 1), lambda = 2 * Math.PI * hash(i, 4, 5, 6)
    eddies(phi, lambda, i % 50, e)
    sum += e[0] * e[0] + e[1] * e[1]
    n += 2
  }
  eddyRms = Math.sqrt(sum / n)
  return eddyRms
}

const _a = [0, 0], _b = [0, 0]

/**
 * The surface wind at geodetic latitude/longitude (degrees), on day of year `dayOfYear` (1..366) at
 * `utcHours`. Returns { east, north } (m/s, the direction it blows towards), speed (m/s), knots, and
 * `from`, the direction it blows from (radians clockwise from north).
 */
export function windAt(lat, lon, dayOfYear, utcHours) {
  const c = climate(lat, lon, dayOfYear, utcHours)
  const w = 2 * Math.PI * utcHours / 24
  let east = c[U] + c[U_COS] * Math.cos(w) + c[U_SIN] * Math.sin(w)
  let north = c[V] + c[V_COS] * Math.cos(w) + c[V_SIN] * Math.sin(w)
  // The weather: two draws either side of the time, cross-faded with their variance kept.
  const t = (dayOfYear - 1 + utcHours / 24) / DAYS_PER_YEAR * WEATHER_PERIOD
  const t0 = Math.floor(t), f = smooth(t - t0)
  const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180
  eddies(phi, lambda, ((t0 % WEATHER_PERIOD) + WEATHER_PERIOD) % WEATHER_PERIOD, _a)
  eddies(phi, lambda, (((t0 + 1) % WEATHER_PERIOD) + WEATHER_PERIOD) % WEATHER_PERIOD, _b)
  const k = c[SIGMA] / (eddyScale() * Math.hypot(1 - f, f))
  east += k * ((1 - f) * _a[0] + f * _b[0])
  north += k * ((1 - f) * _a[1] + f * _b[1])
  const speed = Math.hypot(east, north)
  return { east, north, speed, knots: speed * 1.943844, from: Math.atan2(-east, -north) }
}
