import * as THREE from 'three'
import { ecefToGeodetic, geodeticToECEF } from '../physics/geodesy.js'
import { PixelLOD } from '../scene/PixelLOD.js'

// Mooring cables for one tube segment. Where the mass-driver tube runs under the sea it is buoyant
// and held down by cables to the sea floor, in inverted Vs so that they also resist sideways
// currents: at each mooring point two legs run from the bottom of the tube to anchors on either side,
// each offset sideways by (depth below the tube) x spread. Each leg hangs as a catenary between the
// tube and its anchor (see catenaryPoints).
//
// The anchors sit on the terrain, which streams in (and refines) after the tube segments are built,
// so every set re-samples its anchors from time to time (MooringCables.refreshSome, once per frame)
// and rebuilds when the sea floor it found has changed.
//
// The legs are always drawn as lines that fade with on-screen size like the ring's tethers (they
// share the tether material's opacity and distance-fade settings: see setLineMaterial), so they can
// be followed all the way down to the sea floor, where each ends at an anchor block. Close up they are
// also drawn as solid cable.
const SEGMENTS_PER_LEG = 32
const LINES_MIN_PIXELS = 1 / 2000
// The lines' "thickness" for the tether fade (the tethers use 0..1 relative to the thickest strand).
const LINE_THICKNESS = 0.5
const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0)
cylinderGeometry.userData.shared = true
const cableMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6, metalness: 0.4 })
const ANCHOR_SIZE = 20 // m: anchor blocks on the sea floor (oversized, like the tethers, so they show from the tube)
// Pale and slightly self-lit, so they still show from above the sea through the water's darkening.
const anchorGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
anchorGeometry.userData.shared = true
const anchorMaterial = new THREE.MeshStandardMaterial({ color: 0xd9d3c4, emissive: 0x3a3832, roughness: 0.9 })
let lineMaterial = new THREE.LineBasicMaterial({ color: 0x505050, transparent: true, opacity: 0.6 })
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _yAxis = new THREE.Vector3(0, 1, 0)
const _dir = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _s = new THREE.Vector3()

// Points along a catenary hanging from `top` to `bottom` (planet coordinates), in the vertical plane
// through both (`up` is the local vertical). shape: the catenary constant as a multiple of the
// distance between the ends (larger = straighter). A cable cannot hang below its anchor (that would
// be under the sea floor), so a shape that would put the lowest point between the ends is
// straightened until the lowest point is at the anchor.
export function catenaryPoints(top, bottom, up, shape, segments = SEGMENTS_PER_LEG) {
  const chord = new THREE.Vector3().subVectors(top, bottom)
  const rise = chord.dot(up)                                    // H
  const across = chord.clone().addScaledVector(up, -rise)       // horizontal part
  const span = across.length()                                  // L
  const points = []
  if (span < 1e-6 || !(shape > 0)) {
    for (let i = 0; i <= segments; i++) points.push(bottom.clone().lerp(top, i / segments))
    return points
  }
  across.divideScalar(span)
  // y = a cosh((x - x0) / a) through (0, 0) and (L, H): x0 = L/2 - a asinh(H / (2 a sinh(L / 2a))).
  const lowestPoint = (a) => span / 2 - a * Math.asinh(rise / (2 * a * Math.sinh(span / (2 * a))))
  let a = shape * chord.length()
  if (rise > 0 && lowestPoint(a) > 0) {
    // x0 decreases as a grows: bisect for x0 = 0.
    let lo = a, hi = a
    while (lowestPoint(hi) > 0) hi *= 2
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (lowestPoint(mid) > 0) lo = mid; else hi = mid }
    a = hi
  }
  const x0 = lowestPoint(a)
  const y = (x) => a * Math.cosh((x - x0) / a)
  const y0 = y(0)
  for (let i = 0; i <= segments; i++) {
    const x = span * i / segments
    points.push(bottom.clone().addScaledVector(across, x).addScaledVector(up, y(x) - y0))
  }
  points[segments].copy(top) // exact end (rounding)
  return points
}

export class MooringCables {
  static sets = new Set()
  static _queue = []

  // The material for the cable lines: pass the tethers' material so the cables fade the same way.
  // (A ShaderMaterial built from the tether shaders sharing its uniforms; the colour is our own.)
  static setLineMaterial(tetherMaterial) {
    lineMaterial = new THREE.ShaderMaterial({
      uniforms: { ...tetherMaterial.uniforms, color: { value: new THREE.Color(0x141414) } },
      vertexShader: tetherMaterial.vertexShader,
      fragmentShader: tetherMaterial.fragmentShader,
      transparent: true,
      blending: tetherMaterial.blending,
    })
  }

  // moorings: [{ apex: Vector3 (planet coordinates, bottom of the tube), side: Vector3 (unit, sideways) }]
  // toLocal(planetPoint, target): converts planet coordinates to the segment model's coordinates.
  // getSampler(): the terrain height sampler (latDeg, lonDeg) -> { heightMeters } | null, if any yet.
  // shape: catenary constant as a multiple of each leg's length (see catenaryPoints).
  constructor({ moorings, toLocal, ellipsoid, getSampler, cableRadius, spread, shape, extent }) {
    this.moorings = moorings
    this.toLocal = toLocal
    this.ellipsoid = ellipsoid
    this.getSampler = getSampler
    this.cableRadius = cableRadius
    this.spread = spread
    this.shape = shape
    this.signature = null

    this.root = new THREE.Group()
    this.root.name = 'mooringCables'
    this.near = new THREE.Group()
    this.lines = new THREE.Group()
    // Solid cable (with the lines) where it is at least a pixel across; the lines alone below that,
    // until the cable is 1/2000 of a pixel wide (hundreds of km, where the tether fade has all but
    // hidden them anyway).
    this.lod = new PixelLOD(2 * cableRadius, { extent })
    this.lod.addLevel(1, this.near)
    this.lod.addLevel(LINES_MIN_PIXELS, this.lines)
    this.root.add(this.lod)
    // Anchor blocks while they are at least half a pixel across.
    this.anchors = new THREE.Group()
    this.anchorLod = new PixelLOD(ANCHOR_SIZE, { extent })
    this.anchorLod.addLevel(0.5, this.anchors)
    this.root.add(this.anchorLod)
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
    const curves = legs.map(([apex, anchor]) => {
      const up = apex.clone().add(anchor).normalize() // local vertical (geocentric is close enough here)
      return catenaryPoints(apex, anchor, up, this.shape).map(p => this.toLocal(p, new THREE.Vector3()))
    })

    // Lines (always), with the tether fade
    const positions = []
    let reach = 0
    for (const points of curves) {
      for (let i = 0; i < points.length - 1; i++) {
        positions.push(points[i].x, points[i].y, points[i].z, points[i + 1].x, points[i + 1].y, points[i + 1].z)
      }
      for (const p of points) reach = Math.max(reach, p.length())
    }
    const count = positions.length / 3
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    lineGeometry.setAttribute('thickness', new THREE.Float32BufferAttribute(new Float32Array(count).fill(LINE_THICKNESS), 1))
    lineGeometry.setAttribute('strands', new THREE.Float32BufferAttribute(new Float32Array(count).fill(1), 1))
    lineGeometry.computeBoundingSphere()
    const lines = new THREE.LineSegments(lineGeometry, lineMaterial)
    lines.name = 'mooringCableLines'
    lines.renderOrder = 1 // like the tethers
    this.lines.add(lines)

    // Solid cable close up: one cylinder per line segment
    const cylinders = new THREE.InstancedMesh(cylinderGeometry, cableMaterial, curves.length * SEGMENTS_PER_LEG)
    cylinders.name = 'mooringCable'
    let n = 0
    for (const points of curves) {
      for (let i = 0; i < points.length - 1; i++) {
        _dir.subVectors(points[i + 1], points[i])
        const length = _dir.length()
        _q.setFromUnitVectors(_yAxis, _dir.divideScalar(length))
        _s.set(this.cableRadius, length, this.cableRadius)
        cylinders.setMatrixAt(n++, _m.compose(points[i], _q, _s))
      }
    }
    cylinders.count = n
    cylinders.computeBoundingSphere()
    this.near.add(cylinders)
    this.near.add(lines.clone()) // (shares the geometry)

    // Anchor blocks where the legs meet the sea floor, upright on the local vertical
    const anchors = new THREE.InstancedMesh(anchorGeometry, anchorMaterial, legs.length)
    anchors.name = 'mooringAnchor'
    legs.forEach(([, anchor], i) => {
      const base = this.toLocal(anchor, new THREE.Vector3())
      const top = this.toLocal(_p.copy(anchor).multiplyScalar(1 + ANCHOR_SIZE / anchor.length()), new THREE.Vector3())
      _q.setFromUnitVectors(_yAxis, _dir.subVectors(top, base).normalize())
      _s.setScalar(ANCHOR_SIZE)
      anchors.setMatrixAt(i, _m.compose(base, _q, _s))
    })
    anchors.computeBoundingSphere()
    this.anchors.add(anchors)
    // The LOD is judged by the nearest part of the cables, which reach down and out to the anchors.
    this.lod.extent = reach
    this.anchorLod.extent = reach
  }

  clear() {
    for (const group of [this.near, this.lines, this.anchors]) {
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
