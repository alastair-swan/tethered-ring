// Geodetic <-> ECEF conversions and ellipsoid radius helpers.
import { latLonAlt, Vector3 } from '../utils/math.js'

export function xyz2lla(x,y,z) {
  // Function to convert ECEF (xyz) to lat-lon-altitude (llh)
  //convert cartesian coordinate into geographic coordinate
  //ellipsoid definition: WGS84
  //   a = 6,378,137m
  //   f = 1/298.257

  // Input
  //   x: coordinate X meters
  //   y: coordinate y meters
  //   z: coordinate z meters
  // Output
  //   lat: latitude degrees (-90 to +90)
  //   lon: longitude degrees (-180 to +180)
  //   h: height meters
  // '''

  // Note that z is toward the north pole in the ECEF coordinate system, and x is toward the equator below Greenwich
  // But in the three.js coordinate system 'y' is towards the north pole, 'z' is towards the equator below Greenwich, and 'x' is towards the equator east of Greenwich
  const ECEF_x = z
  const ECEF_y = x
  const ECEF_z = y
  const equitorialRadiusOfEarth = 6378137.0
  const flattening = 0 // 1.0 / 298.257223563
  // --- derived constants
  const b = equitorialRadiusOfEarth - flattening*equitorialRadiusOfEarth
  const e = Math.sqrt(Math.pow(equitorialRadiusOfEarth,2.0)-Math.pow(b,2.0))/equitorialRadiusOfEarth
  const clambda = Math.atan2(ECEF_y,ECEF_x)
  const p = Math.sqrt(Math.pow(ECEF_x,2.0)+Math.pow(ECEF_y,2))
  let h_old = 0.0
  // first guess with h=0 meters
  let theta = Math.atan2(ECEF_z,p*(1.0-Math.pow(e,2.0)))
  let cs = Math.cos(theta)
  let sn = Math.sin(theta)
  let N = Math.pow(equitorialRadiusOfEarth,2.0)/Math.sqrt(Math.pow(equitorialRadiusOfEarth*cs,2.0)+Math.pow(b*sn,2.0))
  let h = p*cs + ECEF_z*sn - equitorialRadiusOfEarth*Math.sqrt(1 - e*e*sn*sn)
  while (Math.abs(h-h_old) > 1.0e-6) {
      h_old = h
      theta = Math.atan2(ECEF_z,p*(1.0-Math.pow(e,2.0)*N/(N+h)))
      cs = Math.cos(theta)
      sn = Math.sin(theta)
      N = Math.pow(equitorialRadiusOfEarth,2.0)/Math.sqrt(Math.pow(equitorialRadiusOfEarth*cs,2.0)+Math.pow(b*sn,2.0))
      h = p*cs + ECEF_z*sn - equitorialRadiusOfEarth*Math.sqrt(1 - e*e*sn*sn)
  }
  const lla = new latLonAlt(theta * 180 / Math.PI, clambda * 180 / Math.PI, h)
  //llh = {'lon':clambda, 'lat':theta, 'height': h}
  return lla
}

export function lla2xyz(lat, lon, alt) {
  
  // Function to convert lat-lon-altitude (llh) to three.js model xyz
  // lat and lon inputs are in degrees, alt in meters

  const equitorialRadiusOfEarth = 6378137.0
  const flattening = 0// 1.0 / 298.257223563

  const cosLat = Math.cos(lat * Math.PI / 180)
  const sinLat = Math.sin(lat * Math.PI / 180)

  const cosLong = Math.cos(lon * Math.PI / 180)
  const sinLong = Math.sin(lon * Math.PI / 180)

  const c = 1 / Math.sqrt(cosLat * cosLat + (1 - flattening) * (1 - flattening) * sinLat * sinLat)
  const s = (1 - flattening) * (1 - flattening) * c

  const ECEF_x = (equitorialRadiusOfEarth*c + alt) * cosLat * cosLong
  const ECEF_y = (equitorialRadiusOfEarth*c + alt) * cosLat * sinLong
  const ECEF_z = (equitorialRadiusOfEarth*s + alt) * sinLat

  // The coordinate system used in the 3D model is different then the ECEF coordinate system 
  const z = ECEF_x
  const x = ECEF_y
  const y = ECEF_z

  return new Vector3(x, y, z)

}

// Geocentric radius (distance from the planet's centre to the ellipsoid surface) at a given
// geodetic latitude. `lat` is in DEGREES. `ellipsoid` is {a, f} (semi-major axis, flattening).
export function radiusAtLatitude(lat, ellipsoid) {
  const a = ellipsoid.a
  const b = a * (1 - (ellipsoid.f || 0)) // Semi-minor axis
  const radLat = (lat * Math.PI) / 180

  const cosLat = Math.cos(radLat)
  const sinLat = Math.sin(radLat)

  const numerator = (a * a * cosLat) ** 2 + (b * b * sinLat) ** 2
  const denominator = (a * cosLat) ** 2 + (b * sinLat) ** 2

  return Math.sqrt(numerator / denominator)
}

// The factor s that moves a point in three.js planet coordinates (y = polar axis) along the line
// through the planet's centre onto the ellipsoid surface: s (x, y, z) is on the surface.
export function ellipsoidSurfaceScale(x, y, z, ellipsoid) {
  const a = ellipsoid.a
  const b = a * (1 - (ellipsoid.f || 0))
  return 1 / Math.sqrt((x * x + z * z) / (a * a) + (y * y) / (b * b))
}

// Converts three.js planet coordinates (x east of Greenwich, y = north pole, z = Greenwich meridian)
// to geodetic latitude/longitude (degrees) and altitude above the ellipsoid (m).
export function ecefToGeodetic(x, y, z, ellipsoid) {

  const ECEF_x = z // Map Three.js's Z-axis to ECEF X-axis
  const ECEF_y = x // Map Three.js's X-axis to ECEF Y-axis
  const ECEF_z = y // Map Three.js's Y-axis to ECEF Z-axis (polar axis)

  const a = ellipsoid.a
  const f = ellipsoid.f || 0
  const e2 = 2 * f - f * f // Square of eccentricity

  const p = Math.sqrt(ECEF_x * ECEF_x + ECEF_y * ECEF_y)
  const lon = Math.atan2(ECEF_y, ECEF_x)

  // Initial estimate (Bowring-style seed) uses the polar component.
  let lat = Math.atan2(ECEF_z, p * (1 - e2))
  for (let i = 0; i < 10; i++) { // Iterative refinement (converges to < 1e-12 rad in a few steps)
    const sinLat = Math.sin(lat)
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat)
    const newLat = Math.atan2(ECEF_z + e2 * N * sinLat, p)
    if (Math.abs(newLat - lat) < 1e-14) { lat = newLat; break }
    lat = newLat
  }

  // h = p*cos(lat) + z*sin(lat) - a*sqrt(1 - e2*sin^2(lat)) is valid everywhere, including the poles
  // (the textbook p/cos(lat) - N is 0/0 there).
  const sinLat = Math.sin(lat)
  const alt = p * Math.cos(lat) + ECEF_z * sinLat - a * Math.sqrt(1 - e2 * sinLat * sinLat)

  return {
    lat: (lat * 180) / Math.PI, // Convert to degrees
    lon: (lon * 180) / Math.PI, // Convert to degrees
    alt,
  }
}

// Converts geodetic latitude/longitude (DEGREES) and altitude (m) to three.js planet coordinates.
export function geodeticToECEF(lat, lon, alt, ellipsoid) {

  const a = ellipsoid.a
  const f = ellipsoid.f || 0
  const e2 = 2 * f - f * f // Square of eccentricity

  const radLat = (lat * Math.PI) / 180
  const radLon = (lon * Math.PI) / 180

  const sinLat = Math.sin(radLat)
  const cosLat = Math.cos(radLat)
  const cosLon = Math.cos(radLon)
  const sinLon = Math.sin(radLon)

  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat)

  const ECEF_x = (N + alt) * cosLat * cosLon
  const ECEF_y = (N + alt) * cosLat * sinLon
  const ECEF_z = ((1 - e2) * N + alt) * sinLat

  const x = ECEF_y // Map ECEF Y-axis to Three.js X-axis
  const y = ECEF_z // Map ECEF Z-axis to Three.js Y-axis
  const z = ECEF_x // Map ECEF X-axis to Three.js Z-axis

  return { x, y, z }
}

// Geocentric latitude (angle from the equatorial plane, measured at the planet's centre) to
// geodetic latitude, both in DEGREES.
export function geocentricToGeodeticLatitude(latGeocentric, ellipsoid) {
  const f = ellipsoid.f || 0
  const oneMinusE2 = (1 - f) * (1 - f)
  return Math.atan(Math.tan(latGeocentric * Math.PI / 180) / oneMinusE2) * 180 / Math.PI
}
