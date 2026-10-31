import climatology from './weatherClimatology.data.js'
import { DAYS_PER_YEAR, pressureAnomaly, probit } from './weatherNoise.js'
import { windAt } from './wind.js'

// The weather anywhere on Earth at a date and time of day: cloud cover and heights, rain and humidity.
// Plausible weather, not a forecast: a pure function of (place, day of year, UTC hours), like the wind
// (wind.js), and from the same lows and highs, so the clouds and rain sit in the storms that turn the
// wind.
//
// - The climate: a monthly climatology from NCEP/NCAR reanalysis fields (2022-2023; baked by
//   tools/sources/build_weather.py into weatherClimatology.data.js) on a 5-degree grid, interpolated
//   bilinearly between nodes and linearly between months, as the wind's is.
// - The weather: the pressure anomaly (weatherNoise.js; about normal with unit variance, negative under
//   lows) moves the cloud cover through a probit transform (coverFor), which keeps it between 0 and 1
//   with the climate's mean and about its spread, and the humidity by HUMIDITY_GAIN of its spread; it rains
//   where the anomaly is lower than the threshold that is passed rainFreq of the time, harder the lower
//   it is, so that it averages rainRate while it rains.
//
// The large-scale fields here are what the clouds are drawn from: the clouds' own shapes, far smaller
// than the 5-degree grid, come from the renderer's noise.

const { rows, cols, gridDegrees, fields, scales } = climatology
const FIELDS = fields.length
const DATA = Int8Array.from(atob(climatology.data), (c) => {
  const b = c.charCodeAt(0)
  return b > 127 ? b - 256 : b
})
const F = Object.fromEntries(fields.map((name, i) => [name, i]))
const HUMIDITY_GAIN = 1.2
// Squalls: under heavy showers the wind at the surface rises by up to SQUALL_GAIN, reaching it at
// SQUALL_RAIN (mm/h) of convective rain.
const SQUALL_GAIN = 0.6
const SQUALL_RAIN = 10

// The climate fields at a grid node (month 0..11, row 0..rows-1, column any integer).
function node(month, row, col, out, weight) {
  const o = ((month * rows + row) * cols + (((col % cols) + cols) % cols)) * FIELDS
  for (let f = 0; f < FIELDS; f++) out[f] += weight * DATA[o + f] * scales[f]
}

/** The climate fields (see build_weather.py's FIELDS), interpolated in place and season. */
export function weatherClimate(lat, lon, dayOfYear, utcHours, out = new Float64Array(FIELDS)) {
  out.fill(0)
  const m = ((dayOfYear - 1 + utcHours / 24) / DAYS_PER_YEAR) * 12 - 0.5
  const m0 = Math.floor(m), fm = m - m0
  const r = Math.min(Math.max((lat + 90) / gridDegrees, 0), rows - 1.000001)
  const r0 = Math.floor(r), fr = r - r0
  const c = lon / gridDegrees
  const c0 = Math.floor(c), fc = c - c0
  for (const [month, wm] of [[(m0 % 12 + 12) % 12, 1 - fm], [((m0 + 1) % 12 + 12) % 12, fm]]) {
    node(month, r0, c0, out, wm * (1 - fr) * (1 - fc))
    node(month, r0, c0 + 1, out, wm * (1 - fr) * fc)
    node(month, r0 + 1, c0, out, wm * fr * (1 - fc))
    node(month, r0 + 1, c0 + 1, out, wm * fr * fc)
  }
  return out
}

/**
 * The cloud cover for a weather strength z (minus the pressure anomaly, about standard normal), given the
 * climate's mean cover and its standard deviation: Phi(m + k z), whose average over z is exactly `mean`
 * when m = probit(mean) sqrt(1 + k^2), with k set so that its spread is about `sd` (so a variable climate
 * is mostly clear or overcast rather than always half covered).
 */
export function coverFor(z, mean, sd) {
  const p = Math.min(Math.max(mean, 0.005), 0.995)
  const base = probit(p)
  const k = Math.min(Math.max(1.3 * sd / Math.max(normalPdf(base), 0.05), 0.2), 3)
  return 1 - normalTail(base * Math.sqrt(1 + k * k) + k * z)
}

const normalPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
// The upper tail of the standard normal distribution (Abramowitz and Stegun 26.2.17).
function normalTail(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const tail = normalPdf(x) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? tail : 1 - tail
}

/**
 * The rain rate (mm/h) for a weather strength z (minus the pressure anomaly), given how often it rains
 * and the mean rate while it does: zero below the threshold passed `frequency` of the time, rising
 * linearly beyond it, scaled so that the rate averages `rate` while it rains.
 */
export function rainFor(z, frequency, rate) {
  if (frequency <= 1e-4 || rate <= 0) return 0
  const threshold = probit(1 - Math.min(frequency, 0.9999))
  if (z <= threshold) return 0
  const meanExcess = normalPdf(threshold) / normalTail(threshold) - threshold
  return rate * (z - threshold) / meanExcess
}

const _c = new Float64Array(FIELDS)

/**
 * The weather at geodetic latitude/longitude (degrees) on day of year `dayOfYear` (1..366) at
 * `utcHours`: cover (0..1) of cloud, the low cloud layer's base and top (m) and the high cloud's cover
 * (0..1) and base (m); rain (mm/h) and its convective share (0..1, showers rather than steady rain);
 * humidity (relative, near the surface, 0..1); and the pressure anomaly.
 */
export function weatherAt(lat, lon, dayOfYear, utcHours) {
  const c = weatherClimate(lat, lon, dayOfYear, utcHours, _c)
  const anomaly = pressureAnomaly(lat, lon, dayOfYear, utcHours)
  const z = -anomaly
  const w = 2 * Math.PI * utcHours / 24
  const clamp = (v) => Math.min(1, Math.max(0, v))
  const cover = coverFor(z, c[F.cover] + c[F.coverCos] * Math.cos(w) + c[F.coverSin] * Math.sin(w), c[F.coverSd])
  return {
    cover,
    lowBase: 1000 * c[F.lowBase],
    lowTop: 1000 * Math.max(c[F.lowTop], c[F.lowBase] + 0.3),
    highCover: clamp(c[F.highFreq] * (1 + 0.5 * z)),
    highBase: 1000 * c[F.highBase],
    rain: rainFor(z, c[F.rainFreq], c[F.rainRate]),
    convective: clamp(c[F.convective]),
    humidity: clamp(c[F.humidity] + HUMIDITY_GAIN * c[F.humiditySd] * z),
    anomaly,
  }
}

/**
 * The wind at the sea surface (wind.js's windAt), stronger in squalls under heavy showers. Same fields
 * as windAt.
 */
export function seaWindAt(lat, lon, dayOfYear, utcHours) {
  const wind = windAt(lat, lon, dayOfYear, utcHours)
  const { rain, convective } = weatherAt(lat, lon, dayOfYear, utcHours)
  const gust = 1 + SQUALL_GAIN * convective * Math.min(1, rain / SQUALL_RAIN)
  return { ...wind, east: wind.east * gust, north: wind.north * gust, speed: wind.speed * gust, knots: wind.knots * gust }
}
