import * as THREE from 'three'
import { ecefToGeodetic, geodeticToECEF } from '../physics/geodesy.js'
import { PixelLOD } from '../scene/PixelLOD.js'

// Mooring cables for one tube segment. Where the mass-driver tube runs under the sea it is buoyant
// and held down by cables to the sea floor, in inverted Vs so that they also resist sideways
// currents: at each mooring point two legs run from the bottom of the tube to anchors on either side,
// each offset sideways by (depth below the tube) x spread.
//
// The anchors sit on the terrain, which streams in (and refines) after the tube segments are built,
// so every set re-samples its anchors from time to time (MooringCables.refreshSome, once per frame)
// and rebuilds when the sea floor it found has changed. Near the camera the legs are cylinders; once
// a cable is under about a pixel across they are drawn as 1 px lines, so the moorings stay visible
// from a distance like the tethers do, until the cable would be a twentieth of a pixel wide (a few
// km; beyond that they would only show through kilometres of water).
const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0)
cylinderGeometry.userData.shared = true
const cableMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6, metalness: 0.4 })
const lineMaterial = new THREE.LineBasicMaterial({ color: 0x505050, transparent: true, opacity: 0.6 })
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _yAxis = new THREE.Vector3(0, 1, 0)
const _dir = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _s = new THREE.Vector3()

export class MooringCables {
  static sets = new Set()
  static _queue = []

  // moorings: [{ apex: Vector3 (planet coordinates, bottom of the tube), side: Vector3 (unit, sideways) }]
  // toLocal(planetPoint, target): converts planet coordinates to the segment model's coordinates.
  // getSampler(): the terrain height sampler (latDeg, lonDeg) -> { heightMeters } | null, if any yet.
  constructor({ moorings, toLocal, ellipsoid, getSampler, cableRadius, spread, extent }) {
    this.moorings = moorings
    this.toLocal = toLocal
    this.ellipsoid = ellipsoid
    this.getSampler = getSampler
    this.cableRadius = cableRadius
    this.spread = spread
    this.signature = null

    this.root = new THREE.Group()
    this.root.name = 'mooringCables'
    this.near = new THREE.Group()
    this.far = new THREE.Group()
    this.lod = new PixelLOD(2 * cableRadius, { extent })
    this.lod.addLevel(1, this.near)
    this.lod.addLevel(0.05, this.far)
    this.root.add(this.lod)
    this.refresh()
    MooringCables.sets.add(this)
  }

  // Re-samples the sea floor and rebuilds the cables if it has changed. Returns true if rebuilt.
  refresh() {
    const sample = this.getSampler()
    if (!sample) return false
    const legs = []
    const heightAt = (point) => {
      const geo = ecefToGeodetic(point.x, point.y, point.z, this.ellipsoid)
      return { geo, height: sample(geo.lat, geo.lon)?.heightMeters ?? null }
    }
    for (const { apex, side } of this.moorings) {
      const below = heightAt(apex)
      if (below.height === null) continue                 // terrain not loaded yet
      const depth = below.geo.alt - below.height
      if (depth < 0.5) continue                            // the tube rests on (or in) the ground here
      for (const sign of [-1, 1]) {
        _p.copy(apex).addScaledVector(side, sign * depth * this.spread)
        const at = heightAt(_p)
        const height = at.height ?? below.height
        const anchor = geodeticToECEF(at.geo.lat, at.geo.lon, height, this.ellipsoid)
        legs.push([apex, new THREE.Vector3(anchor.x, anchor.y, anchor.z)])
      }
    }
    const signature = legs.map(([, anchor]) => `${anchor.x.toFixed(1)},${anchor.y.toFixed(1)},${anchor.z.toFixed(1)}`).join(';')
    if (signature === this.signature) return false
    this.signature = signature
    this.build(legs)
    return true
  }

  build(legs) {
    this.clear()
    if (legs.length === 0) return
    const cylinders = new THREE.InstancedMesh(cylinderGeometry, cableMaterial, legs.length)
    cylinders.name = 'mooringCable'
    const positions = []
    const from = new THREE.Vector3(), to = new THREE.Vector3()
    // The LOD is judged by the nearest part of the cables, which reach down and out to the anchors.
    let reach = 0
    legs.forEach(([apex, anchor], i) => {
      this.toLocal(apex, from)
      this.toLocal(anchor, to)
      reach = Math.max(reach, from.length(), to.length())
      _dir.subVectors(to, from)
      const length = _dir.length()
      _q.setFromUnitVectors(_yAxis, _dir.divideScalar(length))
      _s.set(this.cableRadius, length, this.cableRadius)
      cylinders.setMatrixAt(i, _m.compose(from, _q, _s))
      positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
    })
    cylinders.computeBoundingSphere()
    this.near.add(cylinders)
    this.lod.extent = reach
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const lines = new THREE.LineSegments(lineGeometry, lineMaterial)
    lines.name = 'mooringCableLines'
    this.far.add(lines)
  }

  clear() {
    for (const group of [this.near, this.far]) {
      for (const child of [...group.children]) {
        group.remove(child)
        if (child.isInstancedMesh) child.dispose()
        else child.geometry.dispose()
      }
    }
  }

  dispose() {
    this.clear()
    MooringCables.sets.delete(this)
  }

  // Re-checks the anchors of a few sets each frame (the terrain under them may have loaded or
  // refined). Sets whose tube segment has been released (removed from the scene and disposed, see
  // VirtualObject.releaseModel) are forgotten.
  static refreshSome(count = 3) {
    if (MooringCables._queue.length === 0) MooringCables._queue = [...MooringCables.sets]
    for (let n = 0; n < count && MooringCables._queue.length; n++) {
      const set = MooringCables._queue.pop()
      if (!MooringCables.sets.has(set)) continue
      if (isInScene(set.root)) set.refresh()
      else MooringCables.sets.delete(set)
    }
  }
}

function isInScene(object) {
  let o = object
  while (o.parent) o = o.parent
  return o.isScene === true
}
