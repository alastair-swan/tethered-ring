import * as THREE from 'three'
import { ecefToGeodetic, geodeticToECEF } from '../physics/geodesy.js'
import { offsetLatLon } from '../scene/seaPlacement.js'
import { PixelLOD } from '../scene/PixelLOD.js'
import { StructureLines } from '../scene/structureLines.js'
import { catenaryPoints } from './catenary.js'

// The ocean terminal's mooring chains (OceanTerminal.js): each runs from a fairlead on the underwater
// terminal down to an anchor on the sea floor, SCOPE x the depth below the fairlead away, hanging as a
// catenary that meets the sea floor level at the anchor (catenaryPoints with a slack shape), as a chain
// does when its last stretch rests on the bottom.
//
// The chain is studless links of bar diameter LINK_D (each 6 d long, 3.35 d wide, every other one turned
// a quarter turn), drawn link by link where a link is at least LINK_PIXELS across, in chunks of
// CHUNK_LINKS (PixelLODs, built when first needed); and everywhere as a line at its real width that glows
// like the tethers (src/scene/structureLines.js), so it can be followed down from the surface.
//
// The anchors sit on the terrain, which streams in and refines, so the sea floor is re-sampled from
// time to time (refresh) and the chains rebuilt when it has moved.

const LINK_D = 0.16
const PITCH = 4 * LINK_D           // between the centres of neighbouring links
const CHUNK_LINKS = 96
const LINK_PIXELS = 1.5
const SCOPE = 1.2
const LINE_DIAMETER = 2 * LINK_D
const ANCHOR_SIZE = 8
const SEGMENTS = 512

const linkMaterial = new THREE.MeshStandardMaterial({ color: 0x3f3a35, roughness: 0.75, metalness: 0.5 })
const anchorMaterial = new THREE.MeshStandardMaterial({ color: 0x5b5752, roughness: 0.9 })
let lineMaterial = null

// One studless link: a stadium of bar diameter LINK_D, long along +Y, flat in the XY plane.
function linkGeometry() {
  const radius = (3.35 * LINK_D - LINK_D) / 2
  const straight = 6 * LINK_D - LINK_D - 2 * radius
  const points = []
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * 2 * Math.PI
    const y = Math.sin(a) * radius + Math.sign(Math.sin(a)) * straight / 2
    points.push(new THREE.Vector3(Math.cos(a) * radius, y, 0))
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, true), 24, LINK_D / 2, 5, true)
}
let sharedLink = null

const _up = new THREE.Vector3()
const _t = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()

export class AnchorChains {
  /**
   * parent: the Object3D the chains are drawn in; toLocal(planetPoint, target) converts planet coordinates
   * to its coordinates. legs: [{ top: Vector3 (planet coordinates), east, north (the direction to its
   * anchor) }]. sampleHeight(latDeg, lonDeg) -> { heightMeters } | null: the sea floor.
   */
  constructor({ parent, toLocal, legs, ellipsoid, sampleHeight }) {
    this.toLocal = toLocal
    this.legs = legs
    this.ellipsoid = ellipsoid
    this.sampleHeight = sampleHeight
    this.signature = null
    this.group = new THREE.Group()
    this.group.name = 'anchorChains'
    parent.add(this.group)
    sharedLink ??= linkGeometry()
    lineMaterial ??= StructureLines.createMaterial(0x8a8580, { referenceDiameter: LINE_DIAMETER, fog: true })
    this.refresh()
  }

  // The sea floor at a point (planet coordinates): { lat, lon, alt, floor } (floor null if not loaded).
  _floor(point) {
    const g = ecefToGeodetic(point.x, point.y, point.z, this.ellipsoid)
    return { ...g, floor: this.sampleHeight(g.lat, g.lon)?.heightMeters ?? null }
  }

  /** Re-samples the sea floor; rebuilds the chains if their anchors have moved. Returns true if rebuilt. */
  refresh() {
    const ends = []
    for (const leg of this.legs) {
      const below = this._floor(leg.top)
      if (below.floor === null) return false
      const depth = below.alt - below.floor
      if (depth < 1) continue
      const reach = SCOPE * depth
      const [lat, lon] = offsetLatLon(this.ellipsoid, below.lat, below.lon, leg.east * reach, leg.north * reach)
      const floor = this.sampleHeight(lat, lon)?.heightMeters ?? below.floor
      const p = geodeticToECEF(lat, lon, Math.min(floor, below.alt - 1), this.ellipsoid)
      ends.push({ top: leg.top, anchor: new THREE.Vector3(p.x, p.y, p.z) })
    }
    const signature = ends.map(({ anchor }) => anchor.toArray().map((x) => x.toFixed(0)).join(',')).join(';')
    if (signature === this.signature) return false
    this.signature = signature
    this.build(ends)
    return true
  }

  build(ends) {
    this.clear()
    const positions = []
    for (const { top, anchor } of ends) {
      const a = this.toLocal(top, new THREE.Vector3())
      const b = this.toLocal(anchor, new THREE.Vector3())
      _up.copy(top).normalize()
      this.toLocal(_p.copy(top).add(_up), _up).sub(a).normalize()
      const points = catenaryPoints(a, b, _up, 0.01, SEGMENTS)
      for (let i = 0; i < points.length - 1; i++) positions.push(...points[i].toArray(), ...points[i + 1].toArray())
      this._links(points, _up.clone())
      const block = new THREE.Mesh(new THREE.BoxGeometry(ANCHOR_SIZE, ANCHOR_SIZE / 2, ANCHOR_SIZE), anchorMaterial)
      block.position.copy(b).addScaledVector(_up, ANCHOR_SIZE / 4)
      block.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _up)
      block.name = 'anchor'
      this.group.add(block)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    StructureLines.constantAttributes(geometry, positions.length / 3, LINE_DIAMETER)
    geometry.computeBoundingSphere()
    const lines = new THREE.LineSegments(geometry, lineMaterial)
    lines.name = 'anchorChainLines'
    lines.renderOrder = 1
    this.group.add(lines)
  }

  // The links along a chain (points from its anchor up), in PixelLOD chunks.
  _links(points, up) {
    const lengths = [0]
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + points[i].distanceTo(points[i - 1]))
    const total = lengths[lengths.length - 1]
    const count = Math.floor(total / PITCH)
    // The point and direction at distance s along the chain.
    let segment = 0
    const at = (s, point, tangent) => {
      while (segment < points.length - 2 && lengths[segment + 1] < s) segment++
      const f = (s - lengths[segment]) / (lengths[segment + 1] - lengths[segment])
      point.lerpVectors(points[segment], points[segment + 1], f)
      tangent.subVectors(points[segment + 1], points[segment]).normalize()
    }
    for (let first = 0; first < count; first += CHUNK_LINKS) {
      const n = Math.min(CHUNK_LINKS, count - first)
      const matrices = []
      const centre = new THREE.Vector3()
      for (let k = 0; k < n; k++) {
        const i = first + k
        at((i + 0.5) * PITCH, _p, _t)
        // Every other link is turned a quarter turn about the chain.
        _a.crossVectors(_t, up).normalize()
        if (i % 2) _a.crossVectors(_t, _a).normalize()
        _b.crossVectors(_a, _t)
        matrices.push(new THREE.Matrix4().makeBasis(_a, _t, _b).setPosition(_p))
        centre.add(_p)
      }
      centre.divideScalar(n)
      const lod = new PixelLOD(3.35 * LINK_D, { extent: n * PITCH / 2 })
      lod.position.copy(centre)
      lod.addLevel(LINK_PIXELS, () => {
        const mesh = new THREE.InstancedMesh(sharedLink, linkMaterial, n)
        mesh.name = 'anchorChainLinks'
        matrices.forEach((m, k) => mesh.setMatrixAt(k, _m.copy(m).setPosition(_p.setFromMatrixPosition(m).sub(centre))))
        mesh.computeBoundingSphere()
        return mesh
      })
      this.group.add(lod)
    }
  }

  clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      child.traverse((o) => {
        if (o.isInstancedMesh) o.dispose()
        else if (o.geometry && o.geometry !== sharedLink) o.geometry.dispose()
      })
    }
  }

  dispose() {
    this.clear()
    this.group.removeFromParent()
  }
}
