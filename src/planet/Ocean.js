import * as THREE from 'three'
import { ecefToGeodetic } from '../physics/geodesy.js'
import { fbmGlsl, noiseOffsets, SEA_SURFACE_FREQUENCIES, seaSurfaceLookGlsl } from './seaNoise.js'
import { SeaDarkening } from './seaDarkening.js'

// The sea, as seen from in it: the underside of the water surface, and an underwater look (fog in the
// water colour, no sky). From above, the surface is drawn by the planet's tiles in the colour of the
// ocean in the imagery (see CubedSpherePlanetRenderer._buildWaterGeometry).
//
// The underside is a disc of the sea-level ellipsoid around the point above the camera, out to the
// horizon, rebuilt in float64 relative to that point (a planet-sized sphere would sag by hundreds of
// metres between vertices, and absolute float32 coordinates would jitter). Rings get geometrically
// wider away from the camera, so the surface stays smooth at any depth. It is only drawn while the
// camera is under the surface.
//
// The camera is "under the surface" when it is below sea level and above the sea floor, and "in the
// water" when, in addition, it is not inside something that keeps the water out (the evacuated
// mass-driver tube: see isDry in update()). Under the surface there is no sky (the background is the
// water colour); only in the water does everything also fade into the water with distance.
const RINGS = 64
const SECTORS = 64
const UNDERSIDE_COLOR = new THREE.Color(0x6fb3c9)
const UNDERSIDE_OPACITY = 0.18 // looking straight up through it (more at grazing angles)
// Seen from above (through the water, near the horizon): deep water, matching the fog in the sea.
const UNDERSIDE_FROM_ABOVE = [0.012, 0.03, 0.05]
const SHALLOW_WATER_COLOR = new THREE.Color(0x1f6f8c)
const DEEP_WATER_COLOR = new THREE.Color(0x04131f)
// The water colour goes from slightly darker than SHALLOW just under the surface towards (but never
// as dark as) DEEP, gently: a fraction SURFACE_DARKENING + (MAX_DARKENING - SURFACE_DARKENING) *
// (1 - exp(-depth / DARKENING_DEPTH)) of the way.
const SURFACE_DARKENING = 0.1
const MAX_DARKENING = 0.7
const DARKENING_DEPTH = 600 // m

const _camera = new THREE.Vector3()
const _up = new THREE.Vector3()
const _east = new THREE.Vector3()
const _north = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _point = new THREE.Vector3()
const _origin = new THREE.Vector3()

export class Ocean {
  // parent: the planet's coordinate system (planet-centred, Y = polar axis).
  // sampleTerrainHeight(latDeg, lonDeg) -> { heightMeters } | null
  constructor({ planetSpec, parent, scene, sampleTerrainHeight }) {
    this.ellipsoid = planetSpec.ellipsoid
    this.parent = parent
    this.scene = scene
    this.sampleTerrainHeight = sampleTerrainHeight
    this.visibility = 20000 // m: where things underwater have almost faded out (a cue, not realism)
    this.enabled = true
    this.cameraInWater = false
    this.cameraUnderSurface = false
    this.cameraDepth = 0

    const geometry = discGeometry()
    // Seen from below (back faces), lit by the daylight coming through it rather than shaded: mostly
    // clear, more opaque at grazing angles, with the same ripples as the surface seen from above.
    this.material = new THREE.MeshBasicMaterial({
      color: UNDERSIDE_COLOR, transparent: true, depthWrite: false, side: THREE.BackSide,
    })
    this.rippleOffsets = noiseOffsets(new THREE.Vector3(), SEA_SURFACE_FREQUENCIES)
    this.opaque = { value: 0 } // 1 while the camera is above the sea (see update)
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.seaRippleOffset = { value: this.rippleOffsets }
      shader.uniforms.seaUndersideOpaque = this.opaque
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
varying vec3 vSeaLocal;
varying vec3 vSeaView;
varying vec3 vSeaNormal;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
vSeaLocal = transformed;
vSeaView = -mvPosition.xyz;
vSeaNormal = normalize(normalMatrix * normal);`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float seaUndersideOpaque;
varying vec3 vSeaLocal;
varying vec3 vSeaView;
varying vec3 vSeaNormal;
${fbmGlsl('seaRipple', SEA_SURFACE_FREQUENCIES)}
${seaSurfaceLookGlsl(UNDERSIDE_OPACITY)}`)
        .replace('#include <alphatest_fragment>', `if (seaUndersideOpaque > 0.5) {
  diffuseColor = vec4(${UNDERSIDE_FROM_ABOVE.map(c => c.toFixed(3)).join(', ')}, 1.0);
}
else {
  float ripple = seaRippleFbm(vSeaLocal, length(vSeaView));
  float shine;
  vec4 shaded = seaSurfaceShade(diffuseColor.rgb, ripple, abs(dot(normalize(vSeaNormal), normalize(vSeaView))), shine);
  diffuseColor.rgb = shaded.rgb;
  diffuseColor.a = shaded.a;
}
#include <alphatest_fragment>`)
    }
    this.material.customProgramCacheKey = () => 'seaUnderside'
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.name = 'oceanSurface'
    this.mesh.frustumCulled = false // rebuilt around the camera every frame
    this.mesh.renderOrder = 2       // after the tube and other translucent parts it covers
    this.mesh.visible = false
    parent.add(this.mesh)

    this.fog = new THREE.FogExp2(SHALLOW_WATER_COLOR.clone(), 0)
  }

  setEnabled(enabled) {
    this.enabled = enabled
    if (!enabled) {
      this.setCameraInWater(false)
      this.mesh.visible = false
      SeaDarkening.update(false, _up, 0, 0)
      if (this.scene.fog === this.fog) this.scene.fog = null
    }
  }

  // camera: the rendering camera. isDry(localPoint): true where the camera is shielded from the water
  // (inside the evacuated tube); localPoint is in the parent's coordinates.
  update(camera, isDry = () => false) {
    if (!this.enabled) return
    this.parent.updateWorldMatrix(true, false)
    camera.getWorldPosition(_camera)
    this.parent.worldToLocal(_camera)

    const geo = ecefToGeodetic(_camera.x, _camera.y, _camera.z, this.ellipsoid)
    const seaFloor = (geo.alt < 0) ? this.sampleTerrainHeight(geo.lat, geo.lon)?.heightMeters ?? -Infinity : -Infinity
    this.cameraUnderSurface = geo.alt < 0 && geo.alt > seaFloor
    this.setCameraInWater(this.cameraUnderSurface && !isDry(_camera), -geo.alt)
    // From above the sea, things under it fade into the water by their optical path through it.
    const a = this.ellipsoid.a, b = this.ellipsoid.b ?? a * (1 - (this.ellipsoid.f || 0))
    const r = _camera.length()
    const seaLevelRadius = 1 / Math.sqrt(((_camera.x / r) ** 2 + (_camera.z / r) ** 2) / (a * a) + (_camera.y / r) ** 2 / (b * b))
    const above = !this.cameraUnderSurface
    _up.copy(_camera).transformDirection(this.parent.matrixWorld) // the camera's vertical, in world axes
    SeaDarkening.update(above, _up, r, seaLevelRadius)

    // The disc is the sea's underside: seen from under the surface, rippled and translucent; from
    // above, an opaque backstop for rays that dip under the surface and would come back out of it
    // beyond the horizon (the Earth curves away), so the sky never shows through the sea.
    this.mesh.visible = true
    this.opaque.value = above ? 1 : 0
    // As a backstop it is opaque and drawn in the opaque pass, so it is in place before anything
    // translucent in front of it (e.g. the cable lines) is blended over it; otherwise they would blend
    // with the sky behind it and glow against the dark water. As the underside seen from below it is
    // translucent and drawn after the translucent things it covers.
    this.material.transparent = !above
    this.material.depthWrite = above
    this.mesh.renderOrder = above ? 0 : 2
    // Rebuild only when the camera has moved by a noticeable fraction of its height above the sea
    // (the innermost ring is 5% of it), or has crossed the surface.
    const height = Math.abs(geo.alt)
    if (!this._builtAt || this._builtAbove !== above || this._builtAt.distanceTo(_camera) > Math.max(0.05, 0.01 * height)) {
      this.buildSurface(height, above)
      ;(this._builtAt ??= new THREE.Vector3()).copy(_camera)
      this._builtAbove = above
    }
  }

  setCameraInWater(inWater, depth = 0) {
    this.cameraInWater = inWater
    if (!inWater && depth <= 0) this.cameraUnderSurface = false
    this.cameraDepth = depth
    // The water colour darkens with depth (also used as the background under the surface).
    const darkening = SURFACE_DARKENING + (MAX_DARKENING - SURFACE_DARKENING) * (1 - Math.exp(-Math.max(0, depth) / DARKENING_DEPTH))
    this.fog.color.copy(SHALLOW_WATER_COLOR).lerp(DEEP_WATER_COLOR, darkening)
    // The fog stays on the scene while the sea is shown (so materials keep the fog code, which also
    // carries the from-above darkening: see seaDarkening.js); it only fades things in the water.
    // FogExp2 reaches ~95% at sqrt(3) / density.
    this.fog.density = inWater ? Math.sqrt(3) / Math.max(1, this.visibility) : 0
    if (this.enabled) this.scene.fog = this.fog
  }

  // Rebuilds the surface disc around the point below the camera (heightAboveSea: |camera altitude|).
  // From above it reaches past twice the horizon distance: a ray that skims under the surface comes
  // back out of it about as far beyond the horizon as it went in before it.
  buildSurface(heightAboveSea, above = false) {
    const horizon = this.horizonDistance(heightAboveSea)
    this.fillDisc(this.mesh, heightAboveSea, Math.max(3000, horizon * (above ? 2.2 : 1.05) + 1000), 0)
    noiseOffsets(this.mesh.position, SEA_SURFACE_FREQUENCIES, this.rippleOffsets) // ripples stay put as the disc moves
  }

  meanRadius() {
    const a = this.ellipsoid.a
    return (2 * a + (this.ellipsoid.b ?? a * (1 - (this.ellipsoid.f || 0)))) / 3
  }

  horizonDistance(heightAboveSea) {
    return Math.sqrt(heightAboveSea * (2 * this.meanRadius() + heightAboveSea))
  }

  // Fills a disc mesh: rings around the point below the camera, `depth` metres below sea level, out to
  // maxDistance (never more than a quarter of the way round), in float64 relative to its centre.
  fillDisc(mesh, heightAboveSea, maxDistance, depth) {
    const a = this.ellipsoid.a
    const b = this.ellipsoid.b ?? a * (1 - (this.ellipsoid.f || 0))
    const meanRadius = this.meanRadius()
    maxDistance = Math.min(meanRadius * Math.PI / 2, maxDistance)
    const firstRing = Math.max(0.5, heightAboveSea * 0.05)
    const growth = Math.pow(maxDistance / firstRing, 1 / (RINGS - 1))

    const surfacePoint = (direction, target) => {
      const t = 1 / Math.sqrt((direction.x ** 2 + direction.z ** 2) / (a * a) + (direction.y ** 2) / (b * b))
      return target.copy(direction).multiplyScalar(t - depth)
    }
    _up.copy(_camera).normalize()
    surfacePoint(_up, _origin)
    // Any tangent basis will do (the disc is symmetric); avoid the pole's degenerate cross product.
    _east.set(0, 1, 0).cross(_up)
    if (_east.lengthSq() < 1e-12) _east.set(1, 0, 0)
    _east.normalize()
    _north.crossVectors(_up, _east)

    const positions = mesh.geometry.attributes.position.array
    const normals = mesh.geometry.attributes.normal.array
    let k = 0
    for (let i = 0; i <= RINGS; i++) {
      const angle = (i === 0) ? 0 : firstRing * growth ** (i - 1) / meanRadius
      const cosA = Math.cos(angle), sinA = Math.sin(angle)
      for (let j = 0; j <= SECTORS; j++) {
        const azimuth = 2 * Math.PI * j / SECTORS
        _dir.copy(_up).multiplyScalar(cosA)
          .addScaledVector(_east, sinA * Math.cos(azimuth))
          .addScaledVector(_north, sinA * Math.sin(azimuth))
        surfacePoint(_dir, _point)
        // Subtract in float64 before storing as float32.
        positions[k] = _point.x - _origin.x
        positions[k + 1] = _point.y - _origin.y
        positions[k + 2] = _point.z - _origin.z
        // Ellipsoid normal
        _dir.set(_point.x / (a * a), _point.y / (b * b), _point.z / (a * a)).normalize()
        normals[k] = _dir.x; normals[k + 1] = _dir.y; normals[k + 2] = _dir.z
        k += 3
      }
    }
    mesh.position.copy(_origin)
    mesh.geometry.attributes.position.needsUpdate = true
    mesh.geometry.attributes.normal.needsUpdate = true
  }

  dispose() {
    this.setEnabled(false)
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

// A disc of RINGS x SECTORS quads around its centre (positions filled in by Ocean.fillDisc).
function discGeometry() {
  const vertexCount = (RINGS + 1) * (SECTORS + 1)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage))
  const index = []
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SECTORS; j++) {
      const a = i * (SECTORS + 1) + j, b = a + SECTORS + 1
      index.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  geometry.setIndex(index)
  return geometry
}
