import * as THREE from 'three'
import * as tram from '../utils/tram.js'
import * as markers from '../ring/markers.js'
import { tetheredRingSystem } from '../ring/tetheredRingSystem.js'
import { TetherGeometry } from '../ring/tethers.js'
import tetherVertexShader from '../shaders/tether.vert.glsl?raw'
import tetherFragmentShader from '../shaders/tether.frag.glsl?raw'

const UNIVERSE = { gravitationalConstant: 6.67408e-11 }

// Owns the tethered ring structure itself: one tetheredRingSystem per ring (presets can request
// several), their tethers, and the diagnostic markers (planet axis, equator, ring curve, force
// arrows). rebuild() tears everything down and recreates it from the current derived parameters.
export class RingAssembly {
  constructor({ store, planetSpec, planetCoordSys, ringSpecs, specs }) {
    this.store = store
    this.planetSpec = planetSpec
    this.planetRadius = tram.radiusAtLatitude(0, planetSpec.ellipsoid)
    this.planetCoordSys = planetCoordSys
    this.ringSpecs = ringSpecs
    this.specs = specs
    // Tethers are drawn relative to a point near each tether so their vertices stay small (float32
    // precision); the exact path is only needed for KML export, which uses absolute coordinates.
    this.fastTetherRender = true
    this.systems = []
    this.tethers = []
    this.ctv = new tram.commonTetherVariables()
    this.forceArrowFlags = { tensile: false, gravity: false, inertial: false }

    const d = store.derived
    this.tetherMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tetherMinOpacity: { value: d.tetherMinOpacity.value },
        tetherMaxOpacity: { value: d.tetherMaxOpacity.value },
        tetherDistanceFactor: { value: 2 ** d.tetherDistanceFactor.value },
        color: { value: new THREE.Color(store.get('tetherColor')) },
      },
      vertexShader: tetherVertexShader,
      fragmentShader: tetherFragmentShader,
      transparent: true,
      blending: THREE.NormalBlending,
    })

    this.createSystems()
    this.earthAxis = new markers.earthAxisObject(planetCoordSys, d, this.planetRadius)
    this.earthEquator = new markers.earthEquatorObject(planetCoordSys, d, this.planetRadius)
    this.mainRingCurveMarker = new markers.mainRingCurveObject(this.refCoordSys, d, this.mainRingCurve, this.referencePoint())
    this.gravityForceArrows = new markers.gravityForceArrowsObject(planetCoordSys, d, this.mainRingCurve, this.crv, this.ctv, this.planetRadius, this.ringToPlanetRotation)
    this.gyroscopicForceArrows = new markers.gyroscopicForceArrowsObject(planetCoordSys, d, this.mainRingCurve, this.crv, this.planetRadius, this.ringToPlanetRotation, this.movingRingSpeed())
    this.constructTethers()
  }

  // The first ring drives the transit system, launcher and camera helpers.
  get primary() { return this.systems[0] }
  get refCoordSys() { return this.primary.getMesh() }
  get crv() { return this.primary.crv }
  get mainRingCurve() { return this.primary.mainRingCurve }
  get ringToPlanetRotation() { return this.primary.ringToPlanetQuaternion }

  referencePoint() {
    return new THREE.Vector3(0, this.planetRadius + this.crv.currentMainRingAltitude, 0)
  }

  createSystems({ genKMLFile = false, kmlFile = '' } = {}) {
    const d = this.store.derived
    this.ringSpecs.forEach((ringSpec, index) => {
      const system = new tetheredRingSystem(d, UNIVERSE, this.planetSpec, ringSpec, index, genKMLFile, kmlFile)
      this.systems.push(system)
      this.planetCoordSys.add(system.getMesh())
    })
    this.planetCoordSys.updateWorldMatrix(true)
    for (const system of this.systems) system.getMesh().updateMatrixWorld(true)
  }

  constructTethers({ genSpecs = false, genKMLFile = false, kmlFile = '' } = {}) {
    const d = this.store.derived
    this.tetherGeometries = []
    for (const system of this.systems) {
      const list = []
      if (d.showTethers.value || genSpecs) {
        const refCoordSys = system.getMesh()
        const crv = system.crv
        const geometry = new TetherGeometry(this.planetSpec, crv, this.ctv, d, this.specs, this.fastTetherRender && !genKMLFile, genKMLFile, kmlFile, genSpecs, this.planetCoordSys, refCoordSys)
        this.tetherGeometries.push(geometry)
        const template = new THREE.LineSegments(geometry, this.tetherMaterial)
        template.name = 'tether'
        template.renderOrder = 1 // after the planet, so the ring is visible through it
        if (this.fastTetherRender && !genKMLFile) {
          // One tether geometry, instanced around the ring by rotation about the ring axis.
          const n = d.numTethers.value
          const k = 2 * Math.PI * 2 / n
          for (let i = 0; i < n / 2; i++) {
            const theta = i * k
            const tether = template.clone()
            tether.position.setFromSphericalCoords(this.planetRadius + crv.currentMainRingAltitude, -(Math.PI / 2 - crv.currentEquivalentLatitude), theta)
            tether.rotation.y = theta
            list.push(tether)
            refCoordSys.add(tether)
          }
        }
        else {
          // Exact (per-tether) path: geometry comes in chunks, each relative to its own origin.
          for (const { origin, geometry: chunk } of geometry.localChunks ?? []) {
            const tether = new THREE.LineSegments(chunk, this.tetherMaterial)
            tether.name = 'tether'
            tether.renderOrder = 1
            tether.position.copy(origin)
            list.push(tether)
            refCoordSys.add(tether)
          }
        }
      }
      this.tethers.push(list)
    }
  }

  disposeTethers() {
    for (const list of this.tethers) {
      for (const tether of list) tether.parent?.remove(tether)
    }
    // Clones share one geometry per ring; the material is shared by all rings and kept.
    for (const geometry of this.tetherGeometries ?? []) {
      geometry.dispose()
      for (const chunk of geometry.localChunks ?? []) chunk.geometry.dispose()
    }
    this.tethers = []
    this.tetherGeometries = []
  }

  // Rebuilds rings and tethers from the current parameters. Returns KML text when requested.
  rebuild({ genSpecs = false, genKMLFile = false } = {}) {
    this.disposeTethers()
    for (const system of this.systems) system.destroy()
    this.systems = []
    this.store.derive()
    const kmlFile = ''
    this.createSystems({ genKMLFile, kmlFile })
    this.constructTethers({ genSpecs, genKMLFile, kmlFile })
    this.updateMarkers()
    if (genSpecs) tram.updateMovingRingSpecs(this.store.derived, this.crv, this.specs)
    tram.updateTransitSystemSpecs(this.store.derived, this.crv, this.specs)
    const ringKml = this.systems.map(system => system.kmlFile ?? '').join('')
    return ringKml + (this.tetherGeometries ?? []).map(g => g.kmlFile ?? '').join('')
  }

  updateMarkers() {
    const d = this.store.derived
    this.earthAxis.update(d, this.planetRadius)
    this.earthEquator.update(d, this.planetRadius)
    this.mainRingCurveMarker.update(this.refCoordSys, d, this.mainRingCurve, this.referencePoint())
    const f = this.forceArrowFlags
    this.gravityForceArrows.update(d, this.mainRingCurve, this.crv, this.ctv, this.planetRadius, this.ringToPlanetRotation, f.tensile, f.gravity, f.inertial)
    this.gyroscopicForceArrows.update(d, this.mainRingCurve, this.crv, this.planetRadius, this.ringToPlanetRotation, this.movingRingSpeed())
  }

  // Physical moving-ring speed from the specs, once the tether/ring maths has computed it.
  movingRingSpeed() {
    return this.specs.movingRingsSpeed?.value
  }

  showAllForceArrows() {
    this.forceArrowFlags = { tensile: true, gravity: true, inertial: true }
    this.updateMarkers()
  }

  // Moves ring `index` between its build and final locations (parameters with suffix '' or '2').
  adjustLatLon(index) {
    const d = this.store.derived
    const suffix = index === 0 ? '' : String(index + 1)
    const system = this.systems[index]
    if (!system) return
    system.adjustLatLon({
      buildLat: d[`buildLocationRingCenterLatitude${suffix}`].value,
      buildLon: d[`buildLocationRingCenterLongitude${suffix}`].value,
      finalLat: d[`finalLocationRingCenterLatitude${suffix}`].value,
      finalLon: d[`finalLocationRingCenterLongitude${suffix}`].value,
    }, d[`moveRingFactor${suffix}`].value)
  }

  setTetherUniforms() {
    const d = this.store.derived
    const u = this.tetherMaterial.uniforms
    u.tetherMinOpacity.value = d.tetherMinOpacity.value
    u.tetherMaxOpacity.value = d.tetherMaxOpacity.value
    u.tetherDistanceFactor.value = 2 ** d.tetherDistanceFactor.value
    u.color.value.set(this.store.get('tetherColor'))
  }

  // Short summary shown in the GUI "TextOutput" folder after a specs update.
  specsSummaryHtml() {
    const s = this.specs
    const fmt = (key) => s[key] ? `${s[key].value.toFixed(2)} ${s[key].units}` : 'n/a'
    return [
      "(Press 'S' to update)",
      `<i>Total Tethered Ring Cost</i>: ${fmt('sumOfAllCapitalCosts')}`,
      `<i>Total Tethered Ring Cost Per Kg Supported</i>: ${fmt('capitalCostPerKgSupported')}`,
      `<i>Total Stored Energy in TWh</i>: ${fmt('movingRingsTotalKineticEnergyTWh')}`,
      `<i>Moving Ring's Speed</i>: ${fmt('movingRingsSpeed')}`,
    ].join('<br/>')
  }
}
