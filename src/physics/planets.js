// Physical properties of planets and moons (shape, gravity, rotation, atmosphere).
import * as THREE from 'three'
import * as atmosphere from './atmosphere.js'

// Earth air density (kg/m^3) at geometric altitude a (m), from the U.S. Standard Atmosphere 1976.
// (This used to be a 4th-order polynomial fit that was 5.6x too low at 100 km and ~1e4x too low at
// 120 km, and was inconsistent with the separate pressure and temperature models.)
export function airDensityAtAltitude(a) {
  return atmosphere.earthDensity(a)
}

export function getPlanetSpec(planet) {
  switch (planet.toLowerCase()) {
    case 'earth':
      return {
        name: 'Earth',
        hasOcean: true,                           // draw a sea-level water surface (src/planet/Ocean.js)
        mass: 5.97E+24,                           // kg
        //radius: 6378100,                          // m
        // Use Earth's WGS84 ellipsoid parameters
        radiusAtLatitude: function(lat) {
          const WGS_ELLIPSOID = { a: 6378137.0, b: 6356752.314 }; // meter
          const f1 = Math.pow((Math.pow(WGS_ELLIPSOID.a, 2) * Math.cos(lat)), 2);
          const f2 = Math.pow((Math.pow(WGS_ELLIPSOID.b, 2) * Math.sin(lat)), 2);
          const f3 = Math.pow((WGS_ELLIPSOID.a * Math.cos(lat)), 2);
          const f4 = Math.pow((WGS_ELLIPSOID.b * Math.sin(lat)), 2);
          const radius =  Math.sqrt((f1 + f2) / (f3 + f4));
          return radius}, // * (6378137-5000)/6378137},  // Hacking this because currently the three.js Earth doesn't line up with google's Earth                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 86164.0905,          // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 3.9860044188e14, // m^3/kg/s^2
        ellipsoid: {
          a: 6378137.0, // Semi-major axis in meters
          f: 1 / 298.257223563, // Flattening
        },
        // U.S. Standard Atmosphere 1976 (see atmosphere.js). Inputs are geometric altitude in meters.
        airTemperatureInKelvinAtAltitude: function(a) {
          return atmosphere.earthTemperature(a)
        },
        airDensityAtAltitude: function(a) {
          return atmosphere.earthDensity(a)  // In kg/m^3
        },
        airPressureAtAltitude: function(a) {
          return atmosphere.earthPressure(a)  // In Pa
        },
        speedOfSoundAtAltitude: function(a) {
          return atmosphere.earthSpeedOfSound(a)  // In m/s
        },
        specificGasConstantForAir: atmosphere.EARTH_SPECIFIC_GAS_CONSTANT, // J/(kg·K)
        texturePath: "",
        textureColorFormat: "jpg",
        textureDisplacementFormat: "png",
        displacementScale: 6400,
        displacementBias: -900
      }
    case 'mars':
      return {
        name: 'Mars',
        mass: 6.42E+23,                           // kg
        radiusAtLatitude: function(lat) {return 3396200},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 88642.663,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),  // upDirection
        gravitationalParameter: 4.2828372E13,      // m^3/kg/s^2
        ellipsoid: {
          a: 3396200.0, // Semi-major axis in meters
          f: 1 / 169.89444722361179, // Flattening
        },
        // NASA GRC curve fit (see atmosphere.js). Inputs in meters.
        airTemperatureInKelvinAtAltitude: function(a) {
          return atmosphere.marsTemperature(a)
        },
        airDensityAtAltitude: function(a) {
          return atmosphere.marsDensity(a)  // In kg/m^3
        },
        airPressureAtAltitude: function(a) {
          return atmosphere.marsPressure(a)  // In Pa
        },
        speedOfSoundAtAltitude: function(a) {
          return atmosphere.marsSpeedOfSound(a)  // In m/s
        },
        specificGasConstantForAir: atmosphere.MARS_SPECIFIC_GAS_CONSTANT, // J/(kg·K)
        texturePath: "mars",
      }
    case 'moon':
      return {
        name: 'Moon',
        mass: 7.35E+22,                           // kg
        radiusAtLatitude: function(lat) {return 1737400},                          // m; matches ellipsoid and LOLA reference radius
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 2360591.5,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),  // upDirection
        gravitationalParameter: 4.90486959E12,     // m^3/kg/s^2
        ellipsoid: {
          a: 1737400.0, // Semi-major axis in meters
          f: 0, // Flattening
        },
        airDensityAtAltitude: function(a) {return 0},
        airPressureAtAltitude: function(a) {return 0},
        airTemperatureInKelvinAtAltitude: function(a) {return 250},
        texturePath: "moon/",
        textureColorFormat: "png",
        textureDisplacementFormat: "png",
        displacementScale: 1000,  // 2000??
        displacementBias: 0
      }
    case 'mercury':
      return {
        name: 'Mercury',
        mass: 3.30E+23,                           // kg
        radiusAtLatitude: function(lat) {return 2439700},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 5067030,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 2.203209E13,     // m^3/kg/s^2
        ellipsoid: { a: 2439700, f: 0 },
        airDensityAtAltitude: function(a) {return 0},
        airPressureAtAltitude: function(a) {return 0},
        airTemperatureInKelvinAtAltitude: function(a) {return 250},
      }
    case 'venus':
      return {
        name: 'Venus',
        mass: 4.87E+24,                           // kg
        radiusAtLatitude: function(lat) {return 6051800},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 2802360,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 3.248585926E14,     // m^3/kg/s^2
        ellipsoid: {
          a: 6051800.0, // Semi-major axis in meters
          f: 0, // Flattening
        },
      }
    case 'jupiter':
      return {
        name: 'Jupiter',
        mass: 1.90E+27,                           // kg
        radiusAtLatitude: function(lat) {return 71492000},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 35730,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 1.266865349E17,     // m^3/kg/s^2
        ellipsoid: { a: 71492000, f: 0.06487 },
      }
    case 'saturn':
      return {
        name: 'Saturn',
        mass: 5.68E+26,                           // kg
        radiusAtLatitude: function(lat) {return 60268000},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 38232,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 3.79311879E16,     // m^3/kg/s^2
        ellipsoid: { a: 60268000, f: 0.09796 },
      }
    case 'uranus':
      return {
        name: 'Uranus',
        mass: 8.68E+25,                           // kg
        radiusAtLatitude: function(lat) {return 25559000},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 30660,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 5.7939399E15,     // m^3/kg/s^2
        ellipsoid: { a: 25559000, f: 0.0229 },
      }
    case 'neptune':
      return {
        name: 'Neptune',
        mass: 1.02E+26,                           // kg
        radiusAtLatitude: function(lat) {return 24764000},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 60190,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 6.8365299E15,     // m^3/kg/s^2
        ellipsoid: { a: 24764000, f: 0.0171 },
      }
    case 'pluto':
      return {
        name: 'Pluto',
        mass: 1.31E+22,                           // kg
        radiusAtLatitude: function(lat) {return 1188300},                          // m
        WGS84FlattenningFactor: 298.257223563,    // Used to specify the exact shape of earth, which is approximately an oblate spheroid
        lengthOfSiderealDay: 55180,           // seconds
        upDirection: new THREE.Vector3(0, 1, 0),   // upDirection
        gravitationalParameter: 8.719E11,     // m^3/kg/s^2
        ellipsoid: { a: 1188300, f: 0 },
      }
    default:
      console.error('Planet not found')
  };

}

