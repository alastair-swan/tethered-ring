import * as THREE from 'three'

const DEGREE = Math.PI / 180

// Small seeded PRNG so the star field is identical on every machine (shots are replayed elsewhere).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class stars extends THREE.Points {

  constructor(dParamWithUnits, planetSpec) {
    
    const roughPlanetRadius = planetSpec.ellipsoid.a
    const starVertices = []
    const starColors = []
    const random = mulberry32(20170101)
    const randFloat = (low, high) => low + random() * (high - low)
    for ( let i = 0; i < 10000;) {
      // Probably should eliminate all of the stars that are too close to the planet 
      // starVertices.push( THREE.MathUtils.randFloatSpread( 2000 * radiusOfPlanet/8 ) ) // x
      // starVertices.push( THREE.MathUtils.randFloatSpread( 2000 * radiusOfPlanet/8 ) ) // y
      // starVertices.push( THREE.MathUtils.randFloatSpread( 2000 * radiusOfPlanet/8 ) ) // z
      // Better code...
      // Create stars at random positions and then push them all 2,000,000 km away from the origin
      const XYZ = new THREE.Vector3(
        randFloat(-1, 1),
        randFloat(-1, 1),
        randFloat(-1, 1))
      if (XYZ.length()<=1) {
        // The random position needs to be not on the origin and also within a unit sphere
        XYZ.normalize().multiplyScalar(256 * roughPlanetRadius)
        starVertices.push(XYZ.x, XYZ.y, XYZ.z)
        const starBrightness = randFloat(0, 1)
        starColors.push(starBrightness, starBrightness, starBrightness)
        i++
      }
    }
    const starGeometry = new THREE.BufferGeometry()
    starGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( starVertices, 3 ) )
    starGeometry.setAttribute( 'color', new THREE.Float32BufferAttribute( starColors, 3 ) )
    // sizeAttenuation off: stars are points of light, one pixel wide at any distance.
    const starsMaterial = new THREE.PointsMaterial( { vertexColors: true, size: 1.5, sizeAttenuation: false, transparent: true } )

    super(starGeometry, starsMaterial)
    this.frustumCulled = false

    this.name = 'stars'

    this.roughPlanetRadius = roughPlanetRadius

  }

  // Seen through the air, the sky drowns the stars out by day: they come out through twilight as the
  // sun sinks from 3 to 12 degrees below the camera's horizon, and from high enough (above most of the
  // air, 15 to 40 km up) they show by day too. cameraUp: unit vector from the planet centre through
  // the camera; altitude: the camera's height above the surface (m); sunDirection: unit vector to the sun.
  animate(dParamWithUnits, cameraUp, altitude, sunDirection) {
    let shown = 1
    if (dParamWithUnits['showEarthsAtmosphere'].value) {
      const sunSine = cameraUp.dot(sunDirection)
      const night = THREE.MathUtils.smoothstep(-sunSine, Math.sin(3 * DEGREE), Math.sin(12 * DEGREE))
      const high = THREE.MathUtils.smoothstep(altitude, 15000, 40000)
      shown = Math.max(night, high)
    }
    this.material.opacity = shown
    this.visible = dParamWithUnits['showStars'].value && shown > 0
  }

}