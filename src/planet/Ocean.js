import * as THREE from 'three'
import { ecefToGeodetic } from '../physics/geodesy.js'

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
const SHALLOW_WATER_COLOR = new THREE.Color(0x1f6f8c)
const DEEP_WATER_COLOR = new THREE.Color(0x04131f)
const DARKENING_DEPTH = 300 // m: below this the underwater fog is at its darkest

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
    // Seen from below (back faces), lit by the daylight coming through it rather than shaded.
    this.material = new THREE.MeshBasicMaterial({
      color: UNDERSIDE_COLOR, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.BackSide,
    })
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
    this.mesh.visible = this.cameraUnderSurface
    if (!this.cameraUnderSurface) return
    // Rebuild only when the camera has moved by a noticeable fraction of its height above the sea
    // (the innermost ring is 5% of it); otherwise the existing disc is still centred closely enough.
    const height = Math.abs(geo.alt)
    if (!this._builtAt || this._builtAt.distanceTo(_camera) > Math.max(0.05, 0.01 * height)) {
      this.buildSurface(height)
      ;(this._builtAt ??= new THREE.Vector3()).copy(_camera)
    }
  }

  setCameraInWater(inWater, depth = 0) {
    this.cameraInWater = inWater
    if (!inWater && depth <= 0) this.cameraUnderSurface = false
    this.cameraDepth = depth
    // The water colour darkens with depth (also used as the background under the surface).
    this.fog.color.copy(SHALLOW_WATER_COLOR).lerp(DEEP_WATER_COLOR, Math.min(1, Math.max(0, depth) / DARKENING_DEPTH))
    if (inWater) {
      // FogExp2 reaches ~95% at sqrt(3) / density.
      this.fog.density = Math.sqrt(3) / Math.max(1, this.visibility)
      this.scene.fog = this.fog
    }
    else if (this.scene.fog === this.fog) {
      this.scene.fog = null
    }
  }

  // Rebuilds the surface disc around the point below the camera (heightAboveSea: |camera altitude|).
  buildSurface(heightAboveSea) {
    const a = this.ellipsoid.a
    const b = this.ellipsoid.b ?? a * (1 - (this.ellipsoid.f || 0))
    const meanRadius = (2 * a + b) / 3
    // Out to just past the horizon (at least a few km), and never more than a quarter of the way round.
    const horizon = Math.sqrt(heightAboveSea * (2 * meanRadius + heightAboveSea))
    const maxDistance = Math.min(meanRadius * Math.PI / 2, Math.max(3000, horizon * 1.05 + 1000))
    const firstRing = Math.max(0.5, heightAboveSea * 0.05)
    const growth = Math.pow(maxDistance / firstRing, 1 / (RINGS - 1))

    const surfacePoint = (direction, target) => {
      const t = 1 / Math.sqrt((direction.x ** 2 + direction.z ** 2) / (a * a) + (direction.y ** 2) / (b * b))
      return target.copy(direction).multiplyScalar(t)
    }
    _up.copy(_camera).normalize()
    surfacePoint(_up, _origin)
    // Any tangent basis will do (the disc is symmetric); avoid the pole's degenerate cross product.
    _east.set(0, 1, 0).cross(_up)
    if (_east.lengthSq() < 1e-12) _east.set(1, 0, 0)
    _east.normalize()
    _north.crossVectors(_up, _east)

    const positions = this.mesh.geometry.attributes.position.array
    const normals = this.mesh.geometry.attributes.normal.array
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
    this.mesh.position.copy(_origin)
    this.mesh.geometry.attributes.position.needsUpdate = true
    this.mesh.geometry.attributes.normal.needsUpdate = true
  }

  dispose() {
    this.setCameraInWater(false)
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
