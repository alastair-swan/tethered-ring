import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { AGV, CONTAINER, CRANE, DOOR, INSIDE_Z, MAX_CONTAINERS, PIER, RACK_HEIGHT, RACK_Z, agvAt, containerAt, craneAt, shipPose, visitsAt } from './terminalPort.js'
import { withPortLamps } from './portLamps.js'

// Draws the ocean terminal's cargo traffic (the timetable is terminalPort.js) in the terminal model's
// coordinates: the feeder ships (built by ContainerShips), a pedestal crane, a rack and an AGV for each
// berth, and the containers on their way from the ships into the terminal.
//
// The cranes and AGVs are simple models made here: a crane is a column on the pier's edge with a slewing
// deck (machinery house, cab and A-frame) and a lattice jib that luffs to reach its hook, the spreader
// hanging from the jib's tip on a rotator; an AGV is a low flat vehicle with a lift deck that drives under
// a container on its rack and raises it off.

const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)

const jibPaint = () => withPortLamps(new THREE.MeshStandardMaterial({ color: 0xe0661e, roughness: 0.6, metalness: 0.2 }))
const white = () => withPortLamps(new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.6 }))
const steel = () => withPortLamps(new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.7, metalness: 0.4 }))
const yellow = () => withPortLamps(new THREE.MeshStandardMaterial({ color: 0xf0b414, roughness: 0.55 }))
const rope = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.5 })

const JIB_FOOT = 1.0        // the jib's foot, out from the column's axis
const A_FRAME = { radius: -1.8, height: 7 }   // the top of the A-frame the jib is luffed from (from the jib's foot)

// A bar of square section `size` from `from` to `to`.
function strut(from, to, size) {
  const g = new THREE.BoxGeometry(size, from.distanceTo(to), size)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()))
  return g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2)
}

// A pedestal crane, its origin on the deck at the column's axis: { group, slew (turns about +Y; the jib
// points along its +X), jib (luffs about +Z at the jib's foot; along its +X), spreader, ropes (2: the
// luffing and the hoist rope) }.
function craneModel(materials) {
  const { tower, jib: length } = CRANE
  const group = new THREE.Group()
  group.add(new THREE.Mesh(mergeGeometries([
    new THREE.CylinderGeometry(2.4, 2.6, 0.8, 24).translate(0, 0.4, 0),
    new THREE.CylinderGeometry(1.4, 1.7, tower - 1.5, 24).translate(0, (tower - 1.5) / 2, 0),
  ]), materials.white))
  const slew = new THREE.Group()
  slew.position.y = tower - 1.5
  group.add(slew)
  // The slewing deck: turntable, machinery house and counterweight behind, cab beside the jib, A-frame.
  slew.add(new THREE.Mesh(mergeGeometries([
    new THREE.CylinderGeometry(2.3, 2.3, 0.8, 24).translate(0, 0.4, 0),
    box(5, 3.2, 4.2, -2.6, 2.4, 0),
    box(1.2, 2.4, 4.2, -5.6, 2.0, 0),
  ]), materials.white))
  slew.add(new THREE.Mesh(box(2.2, 2.4, 2, 1.0, 2.0, 2.4), materials.yellow))
  const top = new THREE.Vector3(JIB_FOOT + A_FRAME.radius, 1.5 + A_FRAME.height, 0)
  slew.add(new THREE.Mesh(mergeGeometries([-1.6, 1.6].flatMap((z) => [
    strut(new THREE.Vector3(-3.8, 4, z), top, 0.45),
    strut(new THREE.Vector3(0.2, 1, z), top, 0.45),
  ])), materials.jib))
  // The jib: a lattice of four chords, tapering to its tip, with braces between.
  const chords = [], braces = []
  const corner = (x, i) => {
    const taper = 1 - 0.6 * x / length
    return new THREE.Vector3(x, (i < 2 ? 0.7 : -0.7) * taper, (i % 2 ? 0.9 : -0.9) * taper)
  }
  for (let i = 0; i < 4; i++) chords.push(strut(corner(0, i), corner(length, i), 0.28))
  for (let x = 0; x < length - 2; x += 2.5) {
    const x1 = x + 2.5
    for (const [a, b] of [[0, 1], [2, 3], [0, 2], [1, 3]]) braces.push(strut(corner(x, a), corner(x1, b), 0.12))
  }
  const jib = new THREE.Group()
  jib.position.set(JIB_FOOT, 1.5, 0)
  jib.add(new THREE.Mesh(mergeGeometries([...chords, ...braces, box(1.4, 1.2, 1.4, length, 0, 0)]), materials.jib))
  slew.add(jib)
  const spreader = new THREE.Mesh(mergeGeometries([box(2.4, 0.6, CONTAINER.length + 0.2, 0, 0.3, 0), box(1.6, 1.2, 1.6, 0, 1.2, 0)]), materials.yellow)
  const ropes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 5).translate(0, 0.5, 0), rope, 2)
  ropes.frustumCulled = false
  group.add(spreader, ropes)
  return { group, slew, jib, spreader, ropes }
}

// An AGV, origin on the ground at its middle: { group, deck }.
function agvModel(materials) {
  const { length: l, width: w } = AGV
  const group = new THREE.Group()
  const wheels = []
  for (const z of [-l / 2 + 1.5, -l / 2 + 4, l / 2 - 4, l / 2 - 1.5]) for (const x of [-w / 2 + 0.25, w / 2 - 0.25]) wheels.push(new THREE.CylinderGeometry(0.45, 0.45, 0.4, 10).rotateZ(Math.PI / 2).translate(x, 0.45, z))
  group.add(new THREE.Mesh(mergeGeometries([box(w, 0.75, l, 0, 0.75, 0), box(w - 0.2, 0.5, 0.6, 0, 0.6, l / 2)]), materials.yellow))
  group.add(new THREE.Mesh(mergeGeometries(wheels), rope))
  const deck = new THREE.Mesh(box(w - 0.2, 0.15, CONTAINER.length - 0.5, 0, -0.075, 0), materials.steel)
  group.add(deck)
  return { group, deck }
}

// A rack: two rails a container rests on, on posts the AGV drives between.
function rackGeometry() {
  const parts = []
  const x = (AGV.width + 0.15) / 2
  for (const side of [-1, 1]) {
    parts.push(box(0.15, 0.2, CONTAINER.length, side * x, RACK_HEIGHT - 0.1, 0))
    for (const z of [-CONTAINER.length / 2 + 0.6, 0, CONTAINER.length / 2 - 0.6]) parts.push(box(0.15, RACK_HEIGHT - 0.2, 0.25, side * x, (RACK_HEIGHT - 0.2) / 2, z))
  }
  return mergeGeometries(parts)
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()
const _c = new THREE.Color()
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0)
const _up = new THREE.Vector3(0, 1, 0)

// Instance k of a unit rope (along +Y from its origin) from `from` to `to`.
function ropeBetween(ropes, k, from, to) {
  const d = to.clone().sub(from)
  const length = d.length()
  ropes.setMatrixAt(k, _m.compose(from, _q.setFromUnitVectors(_up, d.divideScalar(length)), _s.set(1, length, 1)))
}

export class TerminalTraffic {
  /** parent: the group in the terminal model's coordinates (turning with the pier); containerShips: ContainerShips. */
  constructor(parent, containerShips, shaftZ) {
    this.containerShips = containerShips
    this.shaftZ = shaftZ
    this.site = 0
    this.group = new THREE.Group()
    this.group.name = 'terminalTraffic'
    parent.add(this.group)
    const materials = { jib: jibPaint(), white: white(), steel: steel(), yellow: yellow() }
    this.materials = materials
    this.cranes = [1, -1].map((side) => {
      const crane = craneModel(materials)
      crane.group.position.set(side * CRANE.x, PIER.deck, CRANE.z)
      this.group.add(crane.group)
      return { side, ...crane }
    })
    this.agvs = [1, -1].map((side) => {
      const agv = agvModel(materials)
      agv.group.position.set(side * DOOR.x, PIER.deck, INSIDE_Z)
      agv.group.visible = false
      this.group.add(agv.group)
      return { side, ...agv }
    })
    const racks = new THREE.InstancedMesh(rackGeometry(), materials.steel, 2)
    ;[1, -1].forEach((side, k) => racks.setMatrixAt(k, _m.makeTranslation(side * DOOR.x, PIER.deck, RACK_Z)))
    racks.computeBoundingSphere()
    racks.name = 'containerRacks'
    this.group.add(racks)
    // The containers off the ships (on cranes, racks and AGVs).
    this.containers = new THREE.InstancedMesh(new THREE.BoxGeometry(CONTAINER.width, CONTAINER.height, CONTAINER.length).translate(0, CONTAINER.height / 2, 0),
      withPortLamps(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 })), 4 * MAX_CONTAINERS)
    this.containers.setColorAt(0, _c.set(0xffffff))
    this.containers.frustumCulled = false
    this.containers.name = 'terminalContainers'
    this.group.add(this.containers)
    this.ships = new Map()  // visit n -> { object, boxes (the ship's containers), hidden (Set of box indices) }
  }

  setSite(site) {
    if (site === this.site) return
    this.site = site
    for (const ship of this.ships.values()) this._drop(ship)
    this.ships.clear()
  }

  _drop(ship) {
    ship.object.removeFromParent()
    ship.boxes?.dispose()
  }

  /** Places everything for simulated time t; `near`: whether the camera is close enough to see the detail. */
  update(t, near) {
    const site = this.site
    const visits = visitsAt(t, site)
    // Ships
    const seen = new Set()
    for (const visit of visits) {
      const pose = shipPose(visit, t, this.shaftZ)
      let ship = this.ships.get(visit.n)
      if (!ship) {
        if (!this.containerShips?.ready) continue
        const object = this.containerShips.buildShip(visit.design)
        object.name = 'terminalShip'
        const boxes = object.children.find((c) => c.isInstancedMesh) ?? null
        ship = { object, boxes, hidden: new Set() }
        this.ships.set(visit.n, ship)
        this.group.add(object)
      }
      seen.add(visit.n)
      ship.object.position.set(pose.x, pose.y, pose.z)
      ship.object.rotation.y = pose.heading
      // The containers already lifted off (or put back, when time runs backwards).
      if (ship.boxes) {
        let changed = false
        visit.containers.forEach((c, j) => {
          const off = containerAt(visit, j, t, site).where !== 'ship'
          if (off === ship.hidden.has(c.box)) return
          const d = visit.design.boxes
          ship.boxes.setMatrixAt(c.box, off ? HIDDEN : _m.makeTranslation(d[4 * c.box], d[4 * c.box + 1], d[4 * c.box + 2]))
          if (off) ship.hidden.add(c.box)
          else ship.hidden.delete(c.box)
          changed = true
        })
        if (changed) ship.boxes.instanceMatrix.needsUpdate = true
      }
    }
    for (const [n, ship] of this.ships) {
      if (seen.has(n)) continue
      this._drop(ship)
      this.ships.delete(n)
    }

    this.group.children.forEach((c) => { if (c.name !== 'terminalShip') c.visible = near })
    if (!near) return

    // Cranes: slewed towards the hook, the jib luffed to put its tip over it.
    for (const crane of this.cranes) {
      const state = craneAt(crane.side, t, site)
      const dx = state.x - crane.side * CRANE.x, dz = state.z - CRANE.z
      const radius = Math.hypot(dx, dz), angle = Math.atan2(dz, dx)
      crane.slew.rotation.y = -angle
      const luff = Math.acos(THREE.MathUtils.clamp((radius - JIB_FOOT) / CRANE.jib, -1, 1))
      crane.jib.rotation.z = luff
      const footY = crane.slew.position.y + 1.5
      const tipY = footY + CRANE.jib * Math.sin(luff)
      const spreaderY = state.y - PIER.deck
      crane.spreader.position.set(dx, spreaderY, dz)
      const along = (r, y) => new THREE.Vector3(r * Math.cos(angle), y, r * Math.sin(angle))
      const tip = along(radius, tipY)
      ropeBetween(crane.ropes, 0, along(JIB_FOOT + A_FRAME.radius, footY + A_FRAME.height), tip)
      ropeBetween(crane.ropes, 1, along(radius, spreaderY + 1.8), tip)
      crane.ropes.instanceMatrix.needsUpdate = true
    }
    // AGVs
    for (const agv of this.agvs) {
      const state = agvAt(agv.side, t, site)
      agv.group.visible = !!state
      if (!state) continue
      agv.group.position.z = state.z
      agv.deck.position.y = state.deck
    }
    // Containers off the ships
    let k = 0
    for (const visit of visits) {
      visit.containers.forEach((c, j) => {
        const state = containerAt(visit, j, t, site)
        if (state.where === 'ship' || state.where === 'gone' || k >= this.containers.count) return
        this.containers.setMatrixAt(k, _m.makeTranslation(state.x, state.y, state.z))
        this.containers.setColorAt(k++, _c.setHex(c.color))
      })
    }
    for (let i = k; i < this.containers.count; i++) this.containers.setMatrixAt(i, HIDDEN)
    this.containers.instanceMatrix.needsUpdate = true
    if (this.containers.instanceColor) this.containers.instanceColor.needsUpdate = true
  }

  dispose() {
    for (const ship of this.ships.values()) this._drop(ship)
    this.ships.clear()
    this.group.removeFromParent()
  }
}
