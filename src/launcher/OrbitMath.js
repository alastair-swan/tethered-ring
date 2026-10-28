import * as THREE from 'three'
import { Vector2 } from 'three'
import { Vector3 } from 'three'

// The following functions were ported from 	// Equation 3.66c, http://www.nssc.ac.cn/wxzygx/weixin/201607/P020160718380095698873.pdf

export function define_stumpC () {
  return function (z) {
    let c

    if (z > 0) {
      c = (1 - Math.cos(Math.sqrt(z))) / z
    }
    else if (z < 0) {
      c = (Math.cosh(Math.sqrt(-z)) - 1) / (-z)
    }
    else {
      c = 1 / 2
    }
    return c
  }
}

export function define_stumpS() {
  return function (z) {

    let s

    if (z > 0) {
      const sqrtz = Math.sqrt(z)
      s = (sqrtz - Math.sin(sqrtz)) / Math.pow(sqrtz, 3)
    }
    else if (z < 0) {
      const sqrtmz = Math.sqrt(-z)
      s = (Math.sinh(sqrtmz) - sqrtmz) / Math.pow(sqrtmz, 3)
    }
    else {
      s = 1 / 6
    }
    return s
  }
}

export function define_f_and_g() {
  return function (x, t, ro, a) {
    const fg = new Vector2()

    const z = a * x**2
    //Equation 3.66a:
    const f = 1 - x**2 / ro * this.stumpC(z)
    //Equation 3.66b:
    const g = t - 1 / Math.sqrt(this.mu) * x*x*x * this.stumpS(z)
    return [f, g]
  }
}

export function define_fDot_and_gDot() {
  return function (x, r, ro, a) {
    const fdotgdot = new Vector2()

    const z = a * x**2
    // Equation 3.66c:
    const fdot = Math.sqrt(this.mu) / r / ro * (z*this.stumpS(z) - 1)*x
    // Equation 3.66d:
    const gdot = 1 - x**2 / r * this.stumpC(z)
    return [fdot, gdot]
  }
}

export function define_kepler_U() {
  return function (dt, ro, vro, a) {
    let C, S, F
    let dFdx

    // Set an error tolerance and a limit on the number of iterations
    const error = 1e-8
    const nMax = 1000
    // Starting value for x
    let x = Math.sqrt(this.mu)*Math.abs(a)*dt
    // Iterate on Equation 3.62 until convergence occurs within the error tolerance
    let n = 0
    let ratio = 1
    const sqrtMu = Math.sqrt(this.mu)
    const sqrtMuTimesDt = sqrtMu * dt
    const roTimesvroDivSqrtMu = ro * vro / sqrtMu
    const oneMinusATimesRo = 1 - a * ro

    while ((Math.abs(ratio) > error) && (n <= nMax)) {
      n = n + 1
      const xSqrd = x*x
      const aTimesXSqrd = a * xSqrd
      C = this.stumpC(aTimesXSqrd)
      S = this.stumpS(aTimesXSqrd)
      const xSqrdTimesC = xSqrd * C
      const xSqrdTimesS = xSqrd * S
      F = roTimesvroDivSqrtMu * xSqrdTimesC + oneMinusATimesRo * xSqrdTimesS * x + ro * x - sqrtMuTimesDt
      dFdx = roTimesvroDivSqrtMu * x * (1 - a * xSqrdTimesS) + oneMinusATimesRo * xSqrdTimesC + ro
      ratio = F / dFdx
      x = x - ratio
    }

    return x
  }
}

export function define_RV_from_R0V0Aandt() {
  return function (R0, V0, A, t) { // A = Acceleration vector

    const RV = {
      R: new Vector2(0, 0),
      V: new Vector2(0, 0)
    }

    // Compute magnitudes
    const r0 = R0.length()
    const v0 = V0.length()
    const vr0 = R0.dot(V0) / r0

    // Reciprocal of the semimajor axis (from the energy equation)
    const alpha = 2 / r0 - v0**2 / this.mu

    // Compute the universal anomaly
    const x = this.kepler_U(t, r0, vr0, alpha)

    // Compute the f and g functions
    let f, g
    [f, g] = this.f_and_g(x, t, r0, alpha)

    // Compute the final position vector (including acceleration contribution)
    RV.R = R0.clone().multiplyScalar(f)
             .add(V0.clone().multiplyScalar(g))
             .add(A.clone().multiplyScalar(0.5 * t**2)) // Acceleration term

    // Compute the magnitude of R
    const r = RV.R.length()

    // Compute the derivatives of f and g
    let fdot, gdot
    [fdot, gdot] = this.fDot_and_gDot(x, r, r0, alpha)

    // Compute the final velocity (including acceleration contribution)
    RV.V = R0.clone().multiplyScalar(fdot)
             .add(V0.clone().multiplyScalar(gdot))
             .add(A.clone().multiplyScalar(t)) // Acceleration term

    return RV
  }
}

// Classical orbital elements from a state vector (Curtis, "Orbital Mechanics for Engineering
// Students", Algorithm 4.1).
//
// R and V are THREE.Vector3 in the planet's (three.js) coordinate system, whose polar axis is +Y and
// whose x axis of the equatorial reference (the "vernal equinox" direction for RAAN) is +Z, matching
// the ECEF mapping used by src/physics/geodesy.js (ECEF x = three z, ECEF y = three x, ECEF z = three y).
// mu is the gravitational parameter (m^3/s^2). Angles are in radians.
export function orbitalElementsFromStateVector(R, V, mu) {
  // Re-express in a right-handed frame with the pole as the third axis.
  const r3 = [R.z, R.x, R.y]
  const v3 = [V.z, V.x, V.y]
  const dot = (p, q) => p[0]*q[0] + p[1]*q[1] + p[2]*q[2]
  const cross = (p, q) => [p[1]*q[2] - p[2]*q[1], p[2]*q[0] - p[0]*q[2], p[0]*q[1] - p[1]*q[0]]
  const len = (p) => Math.sqrt(dot(p, p))
  const acosClamped = (x) => Math.acos(Math.max(-1, Math.min(1, x)))

  const eps = 1.e-10
  const r = len(r3)
  const v = len(v3)
  const vr = dot(r3, v3) / r
  const H = cross(r3, v3)
  const h = len(H)

  // Equation 4.7: inclination
  const incl = acosClamped(H[2] / h)

  // Equation 4.8: node line N = K x H (K is the polar unit vector)
  const N = [-H[1], H[0], 0]
  const n = len(N)

  // Equation 4.9: right ascension of the ascending node, quadrant from the sign of N_y
  let RA = 0
  if (n > eps * h) {
    RA = acosClamped(N[0] / n)
    if (N[1] < 0) RA = 2*Math.PI - RA
  }

  // Equation 4.10: eccentricity vector
  const k1 = (v*v - mu/r) / mu
  const k2 = r * vr / mu
  const E = [k1*r3[0] - k2*v3[0], k1*r3[1] - k2*v3[1], k1*r3[2] - k2*v3[2]]
  const e = len(E)

  // Equation 4.12: argument of perigee (0 for circular or equatorial orbits)
  let w = 0
  if ((n > eps * h) && (e > eps)) {
    w = acosClamped(dot(N, E) / n / e)
    if (E[2] < 0) w = 2*Math.PI - w
  }

  // Equation 4.13a: true anomaly
  let TA
  if (e > eps) {
    TA = acosClamped(dot(E, r3) / e / r)
    if (vr < 0) TA = 2*Math.PI - TA
  }
  else if (n > eps * h) {
    // Circular, inclined: argument of latitude measured from the node line
    TA = acosClamped(dot(N, r3) / n / r)
    if (cross(N, r3)[2] < 0) TA = 2*Math.PI - TA
  }
  else {
    // Circular, equatorial: true longitude
    TA = Math.atan2(r3[1], r3[0]) * Math.sign(H[2] || 1)
    if (TA < 0) TA += 2*Math.PI
  }

  // Equation 2.61 (a < 0 for a hyperbola)
  const a = h*h / mu / (1 - e*e)

  return {
    'angularMomentumVector': h,
    'eccentricity': e,
    'rightAscensionOfTheAscendingNode': RA,
    'inclination': incl,
    'argumentOfPerigee': w,
    'trueAnomaly': TA,
    'semimajorAxis': a
  }
}

export function define_orbitalElementsFromStateVector() {
  return function (R, V) {
    return orbitalElementsFromStateVector(R, V, this.mu)
  }
}

// This function doesn't work, but some of the conversions in it might be useful later...
// export function define_calculateTimeToApogeeFromOrbitalElements() {
//   return function (orbitalElements, mu) {
//     // Calculate the mean anomaly from the true anomaly, eccentricity, and argument of perigee.
//     const e = orbitalElements.eccentricity
//     const π = Math.PI
//     const a = orbitalElements.semimajorAxis
//     const eccentricAnomaly = Math.atan2(
//       Math.sqrt(1 - e**2) * Math.sin(orbitalElements.trueAnomaly),
//       e + Math.cos(orbitalElements.trueAnomaly))
//     const meanAnomaly = eccentricAnomaly - e * Math.sin(eccentricAnomaly)

//     // Calculate the time to apogee.
//     // const timeToApogee = Math.PI * orbitalElements.semimajorAxis ** 1.5 / Math.sqrt(1 - e ** 2) * (
//     //     meanAnomaly - e * Math.sin(meanAnomaly));

//     const timeToApogee1 = (π * a) / Math.sqrt(mu) * (1 - e**2)**(3/2) * (meanAnomaly - e * Math.sin(meanAnomaly))
//     const timeToApogee2 = (π * a) / Math.sqrt(mu) * (1 - e) * (1 + e) * Math.sqrt((1 - e) / (1 + e)) * (meanAnomaly - e * Math.sin(meanAnomaly))

//     console.log(orbitalElements.trueAnomaly, eccentricAnomaly, meanAnomaly, timeToApogee1, timeToApogee2)
//     return timeToApogee1;
//   }
// }

// export function define_getAltitudeDistanceAndVelocity() {
//   return function (currentTime) {
//     let ADAndV = {
//       Altitude: 0,
//       Distance: 0,
//       Velocity: 0
//     }

//     if (currentTime <= this.AccelerationTime) {
//       ADAndV.Altitude = this.LauncherAltitude
//       ADAndV.Distance = 0.5 * this.MaxGees * this.const_g * currentTime**2
//       ADAndV.Velocity = this.MaxGees * this.const_g * currentTime
//     }
//     else if (currentTime <= this.AccelerationTime + this.launchVehicleTimeWithinRamp) {
//       ADAndV.Altitude = Math.sqrt((this.planetRadius + this.LauncherAltitude + this.AllowableUpwardTurningRadius)**2 + this.AllowableUpwardTurningRadius**2 - 2 * (this.planetRadius + this.LauncherAltitude + this.AllowableUpwardTurningRadius)*this.AllowableUpwardTurningRadius*Math.cos(Math.max(0, currentTime - this.AccelerationTime)*this.EllipticalOrbitPerigeeVelocity / this.AllowableUpwardTurningRadius)) - this.planetRadius;
//       // ToDo: This is too rough and approximation
//       ADAndV.Distance = this.LauncherTrackLength + (currentTime - this.AccelerationTime) * this.EllipticalOrbitPerigeeVelocity
//       ADAndV.Velocity = this.EllipticalOrbitPerigeeVelocity
//     }
//     else if (currentTime <= this.TotalTimeInLaunchSystem) {
//       ADAndV.Altitude = Math.sqrt((this.planetRadius + this.Alt_Perigee - this.AllowableDownwardTurningRadius)**2 + this.AllowableDownwardTurningRadius**2 - 2 * (this.planetRadius + this.Alt_Perigee - this.AllowableDownwardTurningRadius)*this.AllowableDownwardTurningRadius*Math.cos(Math.PI + Math.min(0, currentTime - this.TotalTimeInLaunchSystem)*this.EllipticalOrbitPerigeeVelocity / this.AllowableDownwardTurningRadius)) - this.planetRadius
//       // ToDo: This is too rough and approximation
//       ADAndV.Distance = this.LauncherTrackLength + (currentTime - this.AccelerationTime) * this.EllipticalOrbitPerigeeVelocity
//       ADAndV.Velocity = this.EllipticalOrbitPerigeeVelocity
//     }
//     else {
//       const time = currentTime - this.TotalTimeInLaunchSystem
//       const R0 = new Vector2(0, (this.planetRadius + this.Alt_Perigee) / 1000)
//       const V0 = new Vector2(this.EllipticalOrbitPerigeeVelocity / 1000, 0)
//       // TBD - need to figure out the altitude while on the eliptical orbit's path

//       // Note: The distance units in the RV_from_R0V0Aandt function and its sub functions are km, not meters.
//       const RV = this.RV_from_R0V0Aandt(R0, V0, 0, time)

//       ADAndV.Altitude = RV.R.length() * 1000 - this.planetRadius
//       ADAndV.Distance = Math.atan2(RV.R.x, RV.R.y) * RV.R.length() * 1000 // ToDo: This assumes that angle at time zero is zero - possibly bad assumption/
//       ADAndV.Velocity = RV.V.length() * 1000
//     }
//     return ADAndV
//   }
// }

export function define_getAirDensity() {
  return function (Altitude) {
    let T, P
    if (Altitude < 11000.0) {
      T = 15.04 - 0.00649*Altitude
      P = 101.29 * Math.pow((T + 273.1) / 288.08, 5.256)
    }
    else if (Altitude < 25000.0) {
      T = -56.46
      P = 22.65*Math.exp(1.73 - 0.000157*Altitude)
    }
    else {
      T = -131.21 + 0.00299*Altitude
      P = 2.488*Math.pow((T + 273.1) / 216.6, -11.388)
    }
    const Density = P / (0.2869*(T + 273.1))

    return Density

    // Reference https://www.grc.nasa.gov/WWW/k-12/airplane/atmosmet.html
  }
}

