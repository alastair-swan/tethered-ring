import * as THREE from 'three'
import * as tram from '../utils/tram.js'
import * as markers from '../ring/markers.js'
import { tetheredRingSystem } from '../ring/tetheredRingSystem.js'
import { TetherGeometry } from '../ring/tethers.js'
import { groundDepthBelowSphere } from '../ring/ringGeometry.js'
import { StructureLines } from '../scene/structureLines.js'
import { PixelLOD } from '../scene/PixelLOD.js'

const UNIVERSE = { gravitationalConstant: 6.67408e-11 }
// Distant tether forks are merged once their branches would be less than this far apart on screen.
const TETHER_MERGE_PIXELS = 0.1
// The ring keeps a constant height above sea level (see mainRingCurve), so each tether is lowered
// with it; where the ground at its anchors is deeper or shallower than below its top, it is designed
// for that difference, rounded up to this step (so it always reaches the ground) so that nearby
// tethers share geometry.
const TETHER_DEPTH_STEP = 50 // m

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
    // Tethers are drawn at their real diameters (see src/scene/structureLines.js).
    this.tetherMaterial = StructureLines.createMaterial(store.get('tetherColor'))

    this.createSystems()
    // Tethers first: computing them fills this.ctv, which the force arrows read.
    this.constructTethers()
    this.earthAxis = new markers.earthAxisObject(planetCoordSys, d, this.planetRadius)
    this.earthEquator = new markers.earthEquatorObject(planetCoordSys, d, this.planetRadius)
    this.mainRingCurveMarker = new markers.mainRingCurveObject(this.refCoordSys, d, this.mainRingCurve, this.referencePoint())
    this.gravityForceArrows = new markers.gravityForceArrowsObject(planetCoordSys, d, this.mainRingCurve, this.crv, this.ctv, this.planetRadius, this.ringToPlanetRotation)
    this.gyroscopicForceArrows = new markers.gyroscopicForceArrowsObject(planetCoordSys, d, this.mainRingCurve, this.crv, this.planetRadius, this.ringToPlanetRotation, this.movingRingSpeed())
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
        if (this.fastTetherRender && !genKMLFile) {
          // One tether geometry per anchor depth (see TETHER_DEPTH_STEP), instanced around the ring by
          // rotation about the ring axis and lowered with it. Each copy picks how many of its last forks
          // to merge from how far apart those branches are on screen.
          const n = d.numTethers.value
          const k = 2 * Math.PI * 2 / n
          const { topDepths, anchorDepths } = this.tetherDepths(geometry, crv, system.ringToPlanetQuaternion, n / 2, k)
          const byDepth = new Map()
          const levelsFor = (step) => {
            if (!byDepth.has(step)) {
              const g = step === 0 ? geometry : new TetherGeometry(this.planetSpec, crv, new tram.commonTetherVariables(), d, {}, true, false, '', false, this.planetCoordSys, refCoordSys, { anchorDepth: step * TETHER_DEPTH_STEP })
              if (step !== 0) this.tetherGeometries.push(g)
              const levels = [g, ...g.mergedForkGeometries]
              for (const level of levels) level.userData.shared = true
              byDepth.set(step, { levels, fanWidths: g.forkFanWidths })
            }
            return byDepth.get(step)
          }
          for (let i = 0; i < n / 2; i++) {
            const theta = i * k
            const { levels, fanWidths } = levelsFor(Math.ceil(anchorDepths[i] / TETHER_DEPTH_STEP))
            const tether = this.createTetherLOD(levels, fanWidths)
            tether.position.setFromSphericalCoords(this.planetRadius + crv.currentMainRingAltitude - topDepths[i], -(Math.PI / 2 - crv.currentEquivalentLatitude), theta)
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

  // Level v is the full geometry (v = 0) or a merged-fork variant (see TetherGeometry). It is used
  // while the next variant's merged fan (forkFanWidths[v+1]) would be wider than TETHER_MERGE_PIXELS.
  // PixelLOD with a 1 m size measures pixels per metre at the tether's ring end, where the forks are.
  createTetherLOD(levelGeometries, forkFanWidths) {
    const lod = new PixelLOD(1)
    lod.name = 'tether'
    levelGeometries.forEach((g, level) => {
      const nextFan = forkFanWidths[level + 1]
      lod.addLevel(nextFan ? TETHER_MERGE_PIXELS / nextFan : 0, () => {
        const line = new THREE.LineSegments(g, this.tetherMaterial)
        line.name = 'tether'
        line.renderOrder = 1 // after the planet, so the ring is visible through it
        return line
      })
    })
    return lod
  }

  // For each tether copy: topDepths, the depth of the ground below the equatorial-radius sphere under
  // its top (the copy is lowered by this, as the ring is), and anchorDepths, how much deeper still the
  // ground is at its anchors (the deeper of its two; negative where it is shallower). The anchors are
  // those of the sphere design (`geometry`, whose ground points are at r = a); those of a deeper
  // design are a little further out, but the ground changes slowly.
  tetherDepths(geometry, crv, ringToPlanetQuaternion, count, step) {
    const position = geometry.getAttribute('position')
    const reference = new THREE.Vector3().setFromSphericalCoords(this.planetRadius + crv.currentMainRingAltitude, -(Math.PI / 2 - crv.currentEquivalentLatitude), 0)
    const anchors = []
    const p = new THREE.Vector3()
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).add(reference)
      if (p.length() < this.planetRadius + 1) anchors.push(p.clone())
    }
    const yAxis = new THREE.Vector3(0, 1, 0)
    const ellipsoid = this.planetSpec.ellipsoid
    const topDepths = new Float64Array(count)
    const anchorDepths = new Float64Array(count).fill(-Infinity)
    for (let i = 0; i < count; i++) {
      topDepths[i] = groundDepthBelowSphere(p.copy(reference).applyAxisAngle(yAxis, i * step), ringToPlanetQuaternion, ellipsoid)
      for (const anchor of anchors) {
        const depth = groundDepthBelowSphere(p.copy(anchor).applyAxisAngle(yAxis, i * step), ringToPlanetQuaternion, ellipsoid)
        anchorDepths[i] = Math.max(anchorDepths[i], depth - topDepths[i])
      }
    }
    return { topDepths, anchorDepths }
  }

  disposeTethers() {
    for (const list of this.tethers) {
      for (const tether of list) tether.parent?.remove(tether)
    }
    // Clones share one geometry per ring; the material is shared by all rings and kept.
    for (const geometry of this.tetherGeometries ?? []) {
      geometry.dispose()
      for (const chunk of geometry.localChunks ?? []) chunk.geometry.dispose()
      for (const merged of geometry.mergedForkGeometries ?? []) merged.dispose()
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
    this.tetherMaterial.uniforms.color.value.set(this.store.get('tetherColor'))
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
