// Where the sun is, from the day of the year and the UTC time of day. Uses the NOAA approximation for
// the sun's declination and the equation of time (good to a fraction of a degree), and ignores effects
// on timescales longer than a year (precession, nutation, the slow drift of the orbit).

const DEG = Math.PI / 180

// Subsolar point (geodetic-ish latitude/longitude, degrees, where the sun is overhead) for day of year
// 1..366 (fractional days allowed) and UTC hours 0..24.
export function subsolarPoint(dayOfYear, utcHours) {
  // Fractional year (radians), NOAA
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (utcHours - 12) / 24)
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  // Equation of time (minutes): apparent solar time minus mean solar time
  const equationOfTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
  // The sun is overhead where the apparent solar time is noon.
  const solarNoonOffsetMinutes = (utcHours * 60 + equationOfTime) - 720
  let lon = -solarNoonOffsetMinutes / 4
  lon = ((lon + 180) % 360 + 360) % 360 - 180
  return { lat: declination / DEG, lon }
}

// Sun elevation (degrees above the horizon) at a place, for day of year and UTC hours.
export function sunElevation(latDeg, lonDeg, dayOfYear, utcHours) {
  const s = subsolarPoint(dayOfYear, utcHours)
  const lat = latDeg * DEG, sLat = s.lat * DEG, dLon = (lonDeg - s.lon) * DEG
  const cosZenith = Math.sin(lat) * Math.sin(sLat) + Math.cos(lat) * Math.cos(sLat) * Math.cos(dLon)
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / DEG
}

// Advances (dayOfYear, utcHours) by `seconds`, wrapping through the year.
export function advanceDate(dayOfYear, utcHours, seconds) {
  let hours = utcHours + seconds / 3600
  let day = dayOfYear + Math.floor(hours / 24)
  hours -= 24 * Math.floor(hours / 24)
  day = ((day - 1) % 365 + 365) % 365 + 1
  return { dayOfYear: day, utcHours: hours }
}

// A small deterministic hash of a string to [0, 1) (for per-preset defaults that must be the same on
// every machine).
export function hashToUnit(text, salt = 0) {
  let h = 2166136261 ^ salt
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000003) / 1000003
}

// A default date for a scene: a "random" (but repeatable, from `seed`) day and a local time between
// mid-morning and mid-afternoon at the given place, chosen so the sun is at least minElevation degrees
// up (enough light to see clearly, not necessarily noon).
export function defaultDaytime(seed, latDeg, lonDeg, minElevation = 25) {
  let fallback = null
  for (let attempt = 0; attempt < 64; attempt++) {
    const dayOfYear = 1 + Math.floor(hashToUnit(seed, 2 * attempt) * 365)
    const localSolarHours = 9 + 6.5 * hashToUnit(seed, 2 * attempt + 1)
    const utcHours = ((localSolarHours - lonDeg / 15) % 24 + 24) % 24
    const elevation = sunElevation(latDeg, lonDeg, dayOfYear, utcHours)
    if (elevation >= minElevation) return { dayOfYear, utcHours }
    if (!fallback || elevation > fallback.elevation) fallback = { dayOfYear, utcHours, elevation }
  }
  // Polar places in their dark season can never reach minElevation: take the brightest try.
  return { dayOfYear: fallback.dayOfYear, utcHours: fallback.utcHours }
}
