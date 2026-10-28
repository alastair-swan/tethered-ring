// Atmosphere models used by the planet specs (src/physics/planets.js).
// Pure functions with no DOM or three.js dependencies so they can be unit tested in Node.

// ---------------------------------------------------------------------------------------------
// Earth: U.S. Standard Atmosphere 1976
// ---------------------------------------------------------------------------------------------

export const EARTH_SPECIFIC_GAS_CONSTANT = 287.0531 // J/(kg K) for dry air (R* / M0 of US76)
export const EARTH_RATIO_OF_SPECIFIC_HEATS = 1.4
const EARTH_G0 = 9.80665       // m/s^2
const EARTH_R0 = 6356766       // m, effective earth radius used by US76 for geopotential altitude

// Layers below 86 km geometric altitude, indexed by geopotential altitude (m').
const US76_BASE_H = [0, 11000, 20000, 32000, 47000, 51000, 71000, 84852]
const US76_LAPSE = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002]
const US76_BASE_T = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65]
const US76_BASE_P = [101325, 22632.06, 5474.889, 868.0187, 110.9063, 66.93887, 3.956420]

// Tabulated US76 values above 86 km (geometric altitude m, temperature K, pressure Pa, density kg/m^3).
// The thermosphere is not in hydrostatic equilibrium with a single molar mass, so the layered formula
// above does not apply; log-linear interpolation of the published table is used instead.
const US76_UPPER = [
  [86000, 186.87, 3.7338e-1, 6.958e-6],
  [90000, 186.87, 1.8359e-1, 3.416e-6],
  [100000, 195.08, 3.2011e-2, 5.604e-7],
  [110000, 240.00, 7.1042e-3, 9.708e-8],
  [120000, 360.00, 2.5382e-3, 2.222e-8],
  [130000, 469.27, 1.2505e-3, 8.152e-9],
  [150000, 634.39, 4.5422e-4, 2.076e-9],
  [200000, 854.56, 8.4736e-5, 2.541e-10],
  [250000, 941.33, 2.4767e-5, 6.073e-11],
  [300000, 976.01, 8.7704e-6, 1.916e-11],
  [400000, 995.83, 1.4518e-6, 2.803e-12],
  [500000, 999.24, 3.0236e-7, 5.215e-13],
  [600000, 999.85, 8.2130e-8, 1.137e-13],
  [700000, 999.97, 3.1908e-8, 3.070e-14],
  [800000, 999.99, 1.7036e-8, 1.136e-14],
  [1000000, 1000.0, 7.5138e-9, 3.561e-15],
]

function geometricToGeopotential(z) {
  return EARTH_R0 * z / (EARTH_R0 + z)
}

function us76Lower(z) {
  // Valid from -5 km to 86 km geometric altitude.
  const h = geometricToGeopotential(Math.max(-5000, z))
  let i = 0
  while (i < US76_LAPSE.length - 1 && h >= US76_BASE_H[i + 1]) i++
  const L = US76_LAPSE[i]
  const Tb = US76_BASE_T[i]
  const Pb = US76_BASE_P[i]
  const dh = h - US76_BASE_H[i]
  const T = Tb + L * dh
  const k = EARTH_G0 / EARTH_SPECIFIC_GAS_CONSTANT
  const P = (L === 0) ? Pb * Math.exp(-k * dh / Tb) : Pb * Math.pow(Tb / T, k / L)
  return { T, P, rho: P / (EARTH_SPECIFIC_GAS_CONSTANT * T) }
}

function us76Upper(z) {
  const tbl = US76_UPPER
  const last = tbl[tbl.length - 1]
  if (z >= last[0]) {
    // Extrapolate exponentially using the scale height of the last table interval.
    const prev = tbl[tbl.length - 2]
    const span = last[0] - prev[0]
    const Hp = span / Math.log(prev[2] / last[2])
    const Hr = span / Math.log(prev[3] / last[3])
    const dz = z - last[0]
    return { T: last[1], P: last[2] * Math.exp(-dz / Hp), rho: last[3] * Math.exp(-dz / Hr) }
  }
  let i = 0
  while (z > tbl[i + 1][0]) i++
  const a = tbl[i]
  const b = tbl[i + 1]
  const u = (z - a[0]) / (b[0] - a[0])
  return {
    T: a[1] + (b[1] - a[1]) * u,
    P: a[2] * Math.pow(b[2] / a[2], u),
    rho: a[3] * Math.pow(b[3] / a[3], u),
  }
}

// Returns {T (K), P (Pa), rho (kg/m^3)} at geometric altitude z (m).
export function earthAtmosphere(z) {
  return (z < US76_UPPER[0][0]) ? us76Lower(z) : us76Upper(z)
}

export function earthTemperature(z) { return earthAtmosphere(z).T }
export function earthPressure(z) { return earthAtmosphere(z).P }
export function earthDensity(z) { return earthAtmosphere(z).rho }

// Speed of sound from the local kinetic temperature: a = sqrt(gamma R T). Above ~86 km the
// continuum assumption breaks down and this value is only indicative.
export function earthSpeedOfSound(z) {
  return Math.sqrt(EARTH_RATIO_OF_SPECIFIC_HEATS * EARTH_SPECIFIC_GAS_CONSTANT * earthTemperature(z))
}

// ---------------------------------------------------------------------------------------------
// Mars: NASA Glenn Research Center curve fit (https://www.grc.nasa.gov/www/k-12/airplane/atmosmrm.html)
// T(C) = -31 - 0.000998 h (h <= 7000 m), -23.4 - 0.00222 h above; p(kPa) = 0.699 exp(-0.00009 h);
// rho = p / (0.1921 T(K)). The fit is intended for the lower atmosphere (roughly < 50 km); the
// temperature is clamped so that it stays physical at higher altitudes.
// ---------------------------------------------------------------------------------------------

export const MARS_SPECIFIC_GAS_CONSTANT = 192.1  // J/(kg K), value implied by the GRC fit (CO2 is ~188.9)
export const MARS_RATIO_OF_SPECIFIC_HEATS = 1.29 // CO2-dominated atmosphere
const MARS_MIN_TEMPERATURE = 130 // K, clamp for altitudes beyond the fit's validity

export function marsTemperature(h) {
  const tCelsius = (h <= 7000) ? -31 - 0.000998 * h : -23.4 - 0.00222 * h
  return Math.max(MARS_MIN_TEMPERATURE, tCelsius + 273.15)
}

export function marsPressure(h) {
  return 699 * Math.exp(-0.00009 * h) // Pa
}

export function marsDensity(h) {
  return marsPressure(h) / (MARS_SPECIFIC_GAS_CONSTANT * marsTemperature(h))
}

export function marsSpeedOfSound(h) {
  return Math.sqrt(MARS_RATIO_OF_SPECIFIC_HEATS * MARS_SPECIFIC_GAS_CONSTANT * marsTemperature(h))
}
