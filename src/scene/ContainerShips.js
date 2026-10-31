import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { ecefToGeodetic, geodeticToECEF } from '../physics/geodesy.js'
import { seaIceConcentrationAt } from '../planet/seaIce.js'
import { hash, pickWeighted, random, vesselBasis, windAt } from './seaPlacement.js'
import shipping from '../data/shippingLanes.json' with { type: 'json' }

// Container ships near the camera: under way along the shipping lanes of src/data/shippingLanes.json,
// and at anchor off major ports waiting to offload.
//
// The model (models/container_ship.obj, 1:10, +Y up, bow along +Z, waterline at y = 0) is a 287 m ship
// with 1002 FEU on deck: 21 slots along the deck (20 bays of 40 ft containers and the superstructure's),
// 11 rows across, 5 tiers. Ships are built from it in three sizes (SIZES): the hull's parallel midbody
// is lengthened or shortened by whole slots (the stern and bow, and the bays there, which the hull
// narrows, are kept), its beam scaled to the number of rows and its depth to the size, and the
// superstructure placed in one of the midbody slots, tall enough to see over the stacks. The containers
// are one instanced box per ship; each stack's height is drawn from the ship's load, its bay's and its
// own (and a bay's wing stacks are often lower).
//
// Everything is a function of the lane data, the terrain and the simulated time, so recorded shots show
// the same ships on every machine:
//  - Each lane has shipsPer100km ships in each direction, spaced along it, sailing at their own speeds
//    and keeping LANE_OFFSET to starboard of the line (less through narrow straits); they leave the lane
//    at one end and come back in at the other (out of sight: hidden within PORT_HIDE of the ends).
//  - Ships at anchor lie within their anchorage, in at least ANCHOR_DEPTH of water (from fixed terrain
//    tiles: Planet.fixedHeightSampler) and apart from each other, heading into the wind.
// Ships are drawn within a radius of the camera's ground point that grows with its height, while it is
// below MAX_ALTITUDE, relative to an origin near the camera (planet coordinates are too large for
// float32).

const SHIP_SCALE = 10                 // model units to metres
const EARTH_RADIUS = 6371000          // the lanes are great circles on a sphere (as in tools/check_shipping_lanes.py)
const LANE_OFFSET = 1500
const PORT_HIDE = 2000
const ANCHOR_DEPTH = 10
const ANCHOR_SPACING = 600
const HEIGHT_LOD = 10
const MAX_ALTITUDE = 150000
const MAX_RADIUS = 250000
const KNOT = 0.514444
const BUILDS_PER_FRAME = 8           // new ships built per frame (the rest appear over the next frames)

// The model's deck: slot k (from the stern) is centred at z = FIRST_SLOT + k * SLOT. Slots 0-2 (where
// the hull narrows aft) have 6, 4 and 2 fewer rows than the rest; the bow's two slots 2 fewer rows and
// one fewer tier. MID_SLOTS slots between are the parallel midbody (slot 3 is the superstructure's).
const SLOT = 1.2242
const FIRST_SLOT = -11.58
const STERN_SLOTS = 3
const BOW_SLOTS = 2
const MID_SLOTS = 16
const ROW = 0.2632
const TIER = 0.314
const CONTAINER = [0.244, 0.299, 1.2]
const CONTAINER_BASE = 0.882          // the bottom of the lowest tier
const HALF_BEAM = 1.48
const BEAM_MARGIN = HALF_BEAM - 5 * ROW
const SUPERSTRUCTURE = { z: -7.905, base: 1.117, top: 2.867 }
const BRIDGE_CLEARANCE = 0.45         // the bridge's height above the highest tier

// Rows, slots (including the superstructure's), tiers, hull depth (relative to the model) and FEU on deck.
const SIZES = {
  small: { rows: [7, 8], slots: [9, 12], tiers: [3, 4], depth: 0.8, feu: [200, 400] },
  medium: { rows: [11, 11], slots: [21, 21], tiers: [5, 5], depth: 1, feu: [0, Infinity] },
  large: { rows: [19, 23], slots: [26, 30], tiers: [7, 9], depth: 1.25, feu: [2500, Infinity] },
}

// Hull colours (sRGB) by line, with weights, and container colours: the same, and a few more.
const HULLS = [
  ['black', 0x1b1d20, 2],     // Hapag-Lloyd, MSC
  ['teal', 0x2a8a96, 1],      // Maersk
  ['white', 0xe9e9e4, 1],     // COSCO
  ['blue', 0x1d3d7c, 1],      // CMA CGM
  ['pink', 0xc0166e, 0.6],    // ONE
  ['green', 0x1e6a3b, 0.8],   // Evergreen
]
const CONTAINERS = {
  black: [0x2a2c2f, 0.5], teal: [0x3a9aa6, 1], white: [0xdedbd2, 0.8], blue: [0x23468e, 1], pink: [0xc8287c, 0.7],
  green: [0x2f7a3f, 0.9], yellow: [0xd9a91a, 0.6], red: [0x9e2a22, 0.8], orange: [0xd9621c, 0.7], grey: [0x8a8d8f, 0.6],
  brown: [0x6a3424, 0.6],
}
const OWN_LINE = 0.35        // the share of a ship's containers in its own line's colour
const SUPERSTRUCTURE_COLOR = 0xf2f2ee
const ANTIFOULING = 0x7a2b25

const range = (r, [lo, hi]) => lo + Math.floor(r * (hi - lo + 1))

// A ship's design and cargo, from its seed. `loaded` is the range its load factor is drawn from.
export function shipDesign(seed, sizeWeights, loaded) {
  const r = random(seed)
  const size = pickWeighted(sizeWeights, r())
  const spec = SIZES[size]
  let rows, slots, tiers, bridge, bays, feu
  for (let attempt = 0; ; attempt++) {
    rows = range(r(), spec.rows)
    slots = range(r(), spec.slots)
    tiers = range(r(), spec.tiers)
    // Most superstructures are at the after end of the midbody, the rest anywhere along it.
    bridge = STERN_SLOTS + (r() < 0.5 ? 0 : Math.floor(r() * (slots - STERN_SLOTS - BOW_SLOTS)))
    bays = deckPlan(rows, slots, tiers).filter((b) => b.slot !== bridge)
    feu = bays.reduce((n, b) => n + b.rows * b.tiers, 0)
    if ((feu >= spec.feu[0] && feu <= spec.feu[1]) || attempt > 20) break
  }
  const hull = pickWeighted(HULLS.map((h) => [h, h[2]]), r())
  const design = { size, rows, slots, tiers, depth: spec.depth, bridge, hull: hull[1], feu }

  // Cargo: the ship's load, each bay's around it, each stack's around its bay's; wing stacks are often
  // lower. Containers are in the ship's line's colour or any other.
  const load = loaded[0] + (loaded[1] - loaded[0]) * r()
  const containerColors = Object.values(CONTAINERS)
  const own = CONTAINERS[hull[0]][0]
  const boxes = []
  const base = CONTAINER_BASE * spec.depth + CONTAINER[1] / 2
  for (const bay of bays) {
    const fill = Math.min(1, Math.max(0, load + 0.5 * (r() - 0.5)))
    for (let row = 0; row < bay.rows; row++) {
      const wing = Math.min(row, bay.rows - 1 - row) < 2 && r() < 0.4 ? 1 : 0
      const height = Math.max(0, Math.min(bay.tiers, Math.round(bay.tiers * fill + 1.6 * (r() - 0.5)) - wing))
      const x = (row - (bay.rows - 1) / 2) * ROW
      for (let tier = 0; tier < height; tier++) {
        boxes.push(x, base + tier * TIER, bay.z, r() < OWN_LINE ? own : pickWeighted(containerColors, r()))
      }
    }
  }
  design.boxes = boxes
  return design
}

// The bays of a ship with `slots` slots (the superstructure's included): { slot, z, rows, tiers }.
function deckPlan(rows, slots, tiers) {
  const bays = []
  for (let k = 0; k < slots; k++) {
    const stern = k < STERN_SLOTS ? 2 * (STERN_SLOTS - k) : 0
    const bow = k >= slots - BOW_SLOTS
    bays.push({
      slot: k,
      z: FIRST_SLOT + k * SLOT,
      rows: Math.max(2, rows - stern - (bow ? 2 : 0)),
      tiers: tiers - (bow ? 1 : 0),
    })
  }
  return bays
}

// The hull and superstructure geometry for a design, from the model's: the midbody stretched to the
// design's slots, the beam to its rows, the depth to its size.
function reshape(geometry, design, { superstructure = false } = {}) {
  const g = geometry.clone()
  const mid = design.slots - STERN_SLOTS - BOW_SLOTS
  const zStart = FIRST_SLOT + (STERN_SLOTS - 0.5) * SLOT
  const zEnd = zStart + MID_SLOTS * SLOT
  const beam = ((design.rows - 1) / 2 * ROW + BEAM_MARGIN) / HALF_BEAM
  // The superstructure rises above the stacks; it is moved to its slot.
  const top = CONTAINER_BASE * design.depth + design.tiers * TIER + BRIDGE_CLEARANCE
  const base = SUPERSTRUCTURE.base * design.depth
  const rise = Math.max(1, (top - base) / (SUPERSTRUCTURE.top - SUPERSTRUCTURE.base))
  const shift = FIRST_SLOT + design.bridge * SLOT - SUPERSTRUCTURE.z
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * beam
    let y = p.getY(i), z = p.getZ(i)
    if (superstructure) {
      y = base + (y - SUPERSTRUCTURE.base) * rise
      z += shift
    }
    else {
      y *= design.depth
      z = z < zStart ? z : z < zEnd ? zStart + (z - zStart) * mid / MID_SLOTS : z + (mid - MID_SLOTS) * SLOT
    }
    p.setXYZ(i, x, y, z)
  }
  g.deleteAttribute('normal')
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

export class ContainerShips {
  /**
   * planet: Planet (for the terrain at anchorages); parent: the planet's coordinate system (three.js
   * planet axes); ellipsoid: { a, f }.
   */
  constructor(planet, parent, ellipsoid, { url = 'models/container_ship.obj' } = {}) {
    this.planet = planet
    this.ellipsoid = ellipsoid
    this.group = new THREE.Group()
    this.group.name = 'containerShips'
    parent.add(this.group)
    this.visible = true
    this.model = null
    this.ships = new Map()          // id -> { design, object }
    this.geometries = new Map()
    this.hullMaterials = new Map()
    this.lanes = shipping.lanes.map((lane, i) => this._lane(lane, i))
    this.anchorages = shipping.anchorages.map((a) => ({ ...a, ships: null, building: false, count: a.ships }))
    this.lastOrigin = null
    new OBJLoader().loadAsync(url).then((object) => {
      const parts = {}
      object.traverse((o) => { if (o.isMesh) parts[o.name] = o.geometry })
      this.model = parts
      this.box = new THREE.BoxGeometry(...CONTAINER)
      this.containerMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 })
      this.superstructureMaterial = new THREE.MeshStandardMaterial({ color: SUPERSTRUCTURE_COLOR, roughness: 0.6 })
    }).catch((error) => console.warn('[ships] model failed to load', error))
  }

  setVisible(visible) {
    this.visible = !!visible
    this.group.visible = this.visible
  }

  // --- Lanes ----------------------------------------------------------------------------------

  _lane(lane, index) {
    const points = lane.waypoints.map(([lat, lon]) => unitVector(lat, lon))
    const separation = lane.waypoints.map((w) => (w.length > 2 ? w[2] * 1000 : LANE_OFFSET))
    const cumulative = [0]
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + points[i - 1].angleTo(points[i]) * EARTH_RADIUS)
    const length = cumulative[cumulative.length - 1]
    const density = lane.shipsPer100km
    // Busier lanes carry bigger ships.
    const sizes = density >= 3 ? [['small', 0.15], ['medium', 0.45], ['large', 0.4]]
      : density >= 1 ? [['small', 0.35], ['medium', 0.45], ['large', 0.2]]
        : [['small', 0.6], ['medium', 0.4]]
    const ships = []
    const count = Math.max(1, Math.round(length / 100000 * density))
    for (const direction of [1, -1]) {
      for (let k = 0; k < count; k++) {
        const r = random(hash(index, direction, k, 5))
        ships.push({
          id: `lane${index}:${direction}:${k}`, direction, seed: hash(index, direction, k, 6), sizes,
          phase: (k + 0.8 * r()) / count * length, speed: (14 + 7 * r()) * KNOT,
        })
      }
    }
    return { name: lane.name, points, separation, cumulative, length, ships }
  }

  // Where a lane ship is at time t: { lat, lon, heading } (or null near the lane's ends).
  _laneShipPose(lane, ship, t) {
    let s = (ship.phase + ship.direction * ship.speed * t) % lane.length
    if (s < 0) s += lane.length
    if (s < PORT_HIDE || s > lane.length - PORT_HIDE) return null
    const c = lane.cumulative
    let i = 0, j = c.length - 1
    while (j - i > 1) {
      const m = (i + j) >> 1
      if (c[m] <= s) i = m
      else j = m
    }
    const a = lane.points[i], b = lane.points[i + 1]
    const angle = a.angleTo(b)
    const f = angle > 0 ? (s - c[i]) / (c[i + 1] - c[i]) : 0
    // Position and direction of travel along the great circle a -> b.
    const sa = Math.sin((1 - f) * angle), sb = Math.sin(f * angle), sin = Math.sin(angle) || 1
    _p.copy(a).multiplyScalar(sa / sin).addScaledVector(b, sb / sin).normalize()
    _t.copy(a).multiplyScalar(-Math.cos((1 - f) * angle)).addScaledVector(b, Math.cos(f * angle)).normalize()
    if (ship.direction < 0) _t.negate()
    // Keep to starboard.
    _r.crossVectors(_t, _p).normalize()
    const offset = lane.separation[i] / EARTH_RADIUS
    _p.multiplyScalar(Math.cos(offset)).addScaledVector(_r, Math.sin(offset)).normalize()
    const lat = Math.asin(_p.z) * 180 / Math.PI, lon = Math.atan2(_p.y, _p.x) * 180 / Math.PI
    const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180
    const east = -Math.sin(lambda) * _t.x + Math.cos(lambda) * _t.y
    const north = -Math.sin(phi) * Math.cos(lambda) * _t.x - Math.sin(phi) * Math.sin(lambda) * _t.y + Math.cos(phi) * _t.z
    return { lat, lon, heading: Math.atan2(east, north) }
  }

  // --- Anchorages -----------------------------------------------------------------------------

  async _buildAnchorage(anchorage, index) {
    const r = random(hash(index, 9))
    const wind = windAt(anchorage.lat, anchorage.lon)
    const ships = []
    for (let k = 0; k < anchorage.count * 3 && ships.length < anchorage.count; k++) {
      const d = [r(), r(), r(), r()]
      const radius = anchorage.radiusKm * 1000 * Math.sqrt(d[0]), angle = 2 * Math.PI * d[1]
      const north = radius * Math.cos(angle), east = radius * Math.sin(angle)
      if (ships.some((s) => Math.hypot(s.east - east, s.north - north) < ANCHOR_SPACING)) continue
      const lat = anchorage.lat + north / 111320
      const lon = anchorage.lon + east / (111320 * Math.cos(anchorage.lat * Math.PI / 180))
      const h = await this._height(lat, lon)
      if (h === null || h > -ANCHOR_DEPTH) continue
      ships.push({
        id: `anchor${index}:${k}`, lat, lon, east, north, heading: wind.from + (d[2] - 0.5) * 0.6,
        seed: hash(index, k, 10), sizes: [['small', 0.3], ['medium', 0.4], ['large', 0.3]],
      })
    }
    anchorage.ships = ships
  }

  async _height(lat, lon) {
    const p = geodeticToECEF(lat, lon, 0, this.ellipsoid)
    const direction = new THREE.Vector3(p.z, p.y, -p.x).normalize()   // the planet renderer's tile frame
    const sampler = await this.planet.fixedHeightSampler(direction, HEIGHT_LOD)
    return sampler ? sampler(direction) : null
  }

  // --- Ships ----------------------------------------------------------------------------------

  _geometry(key, make) {
    let g = this.geometries.get(key)
    if (!g) {
      g = make()
      this.geometries.set(key, g)
    }
    return g
  }

  _hullMaterial(color) {
    let material = this.hullMaterials.get(color)
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.55 })
      // Antifouling red below the waterline (model y < 0).
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vShipModelY;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShipModelY = position.y;')
        const red = new THREE.Color(ANTIFOULING)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vShipModelY;')
          .replace('#include <color_fragment>', `#include <color_fragment>
if (vShipModelY < -0.02) diffuseColor.rgb = vec3(${red.r.toFixed(4)}, ${red.g.toFixed(4)}, ${red.b.toFixed(4)});`)
      }
      material.customProgramCacheKey = () => 'containerShipHull'
      this.hullMaterials.set(color, material)
    }
    return material
  }

  _buildShip(design) {
    const root = new THREE.Group()
    root.name = 'containerShip'
    root.scale.setScalar(SHIP_SCALE)
    const shape = `${design.rows}:${design.slots}:${design.depth}`
    const hull = this._geometry(`hull:${shape}`, () => reshape(this.model.Hull, design))
    const superstructure = this._geometry(`super:${shape}:${design.tiers}:${design.bridge}`,
      () => reshape(this.model.Superstructure, design, { superstructure: true }))
    root.add(new THREE.Mesh(hull, this._hullMaterial(design.hull)))
    root.add(new THREE.Mesh(superstructure, this.superstructureMaterial))
    const n = design.boxes.length / 4
    if (n > 0) {
      const containers = new THREE.InstancedMesh(this.box, this.containerMaterial, n)
      const m = new THREE.Matrix4(), color = new THREE.Color()
      for (let i = 0; i < n; i++) {
        const [x, y, z, c] = design.boxes.slice(4 * i, 4 * i + 4)
        containers.setMatrixAt(i, m.makeTranslation(x, y, z))
        containers.setColorAt(i, color.setHex(c))
      }
      containers.computeBoundingSphere()
      root.add(containers)
    }
    return root
  }

  _show(id, seed, sizes, loaded, lat, lon, heading, seen) {
    let ship = this.ships.get(id)
    if (!ship) {
      if (this.builds-- <= 0) return
      const design = shipDesign(seed, sizes, loaded)
      ship = { design, object: this._buildShip(design) }
      this.ships.set(id, ship)
      this.group.add(ship.object)
    }
    const p = geodeticToECEF(lat, lon, 0, this.ellipsoid)
    vesselBasis(lat, lon, heading, _m)
    ship.object.quaternion.setFromRotationMatrix(_m)
    ship.object.position.set(p.x, p.y, p.z).sub(this.group.position)
    ship.object.visible = true
    ship.pose = { lat, lon, heading }
    seen.add(id)
  }

  /** Places the ships for simulated time t (s) as seen from `camera`. */
  update(t, camera) {
    if (!this.model) return
    const parent = this.group.parent
    parent.updateWorldMatrix(true, false)
    const cam = parent.worldToLocal(camera.getWorldPosition(new THREE.Vector3()))
    const geo = ecefToGeodetic(cam.x, cam.y, cam.z, this.ellipsoid)
    const seen = new Set()
    this.builds = BUILDS_PER_FRAME
    if (this.visible && geo.alt < MAX_ALTITUDE) {
      // The instances are relative to an origin near the camera, moved now and then.
      if (!this.lastOrigin || Math.abs(this.lastOrigin.lat - geo.lat) + Math.abs(this.lastOrigin.lon - geo.lon) > 0.2) {
        const o = geodeticToECEF(geo.lat, geo.lon, 0, this.ellipsoid)
        this.group.position.set(o.x, o.y, o.z)
        this.lastOrigin = { lat: geo.lat, lon: geo.lon }
      }
      const radius = Math.min(MAX_RADIUS, 60000 + 1.5 * Math.max(0, geo.alt))
      const cosRadius = Math.cos(radius / EARTH_RADIUS)
      const here = unitVector(geo.lat, geo.lon)
      const near = (lat, lon) => unitVector(lat, lon, _q).dot(here) > cosRadius && seaIceConcentrationAt(lat, lon) < 0.15
      for (const lane of this.lanes) {
        for (const ship of lane.ships) {
          const pose = this._laneShipPose(lane, ship, t)
          if (pose && near(pose.lat, pose.lon)) this._show(ship.id, ship.seed, ship.sizes, [0.35, 1], pose.lat, pose.lon, pose.heading, seen)
        }
      }
      this.anchorages.forEach((anchorage, index) => {
        const within = unitVector(anchorage.lat, anchorage.lon, _q).dot(here) > Math.cos((radius + anchorage.radiusKm * 1000) / EARTH_RADIUS)
        if (!within) return
        if (!anchorage.ships && !anchorage.building) {
          anchorage.building = true
          this._buildAnchorage(anchorage, index).catch((error) => console.warn('[ships]', error))
        }
        for (const ship of anchorage.ships ?? []) {
          if (near(ship.lat, ship.lon)) this._show(ship.id, ship.seed, ship.sizes, [0.75, 1], ship.lat, ship.lon, ship.heading, seen)
        }
      })
    }
    for (const [id, ship] of this.ships) {
      if (seen.has(id)) continue
      ship.object.visible = false
    }
    // Ships long out of sight are dropped (their shared geometry is kept).
    if (this.ships.size > 2 * seen.size + 100) {
      for (const [id, ship] of this.ships) {
        if (seen.has(id)) continue
        ship.object.removeFromParent()
        for (const child of ship.object.children) if (child.isInstancedMesh) child.dispose()
        this.ships.delete(id)
      }
    }
  }
}

function unitVector(lat, lon, out = new THREE.Vector3()) {
  const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180
  return out.set(Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi))
}

const _p = new THREE.Vector3()
const _t = new THREE.Vector3()
const _r = new THREE.Vector3()
const _q = new THREE.Vector3()
const _m = new THREE.Matrix4()
