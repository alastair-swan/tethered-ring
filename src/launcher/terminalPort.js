import { hash, random } from '../scene/seaPlacement.js'
import { shipDesign, shipDimensions } from '../scene/ContainerShips.js'

// The cargo traffic at the launcher's ocean terminal (OceanTerminal.js), as pure functions of the
// simulated time, so that recorded shots show the same ships on every machine and any moment can be shown
// without working up to it.
//
// Everything is in the terminal model's coordinates (models/launcher_ocean_terminal.obj: metres, +Y up,
// sea level at y = 0), which turn with the pier: the pier runs along -Z from the terminal, downwind.
//
// Small container ships (feeders) call one after another, every INTERVAL, at the berths either side of
// the pier in turn (side +1 is +X). Each sails in from APPROACH downwind along a line SIDESTEP off its
// berth, heading into the wind, slows to a stop, and is moved sideways onto the berth (by tugs, not
// drawn). The volumes are small, more like a ship-to-ship transfer than a container port, so each berth
// has a pedestal crane on the pier's edge (a slewing tower with a luffing jib, its spreader's rotator
// keeping the container square to the pier) rather than a quay crane. It lifts 5 to 10 containers off
// the ship, one every CYCLE, each the top of a stack within its reach, and sets each down on a steel rack
// beside it on the pier. An automated guided vehicle (AGV) comes out of the terminal's door on that side
// for each, lifts it off the rack from below and carries it back in through the door. Once its last
// container is off, the ship is moved out sideways again, turns away from the pier and sails off
// downwind.
//
// Each AGV is back inside before the next container is set down, so the crane never sets a container
// down over an AGV.

export const PIER = { deck: 3.33, edge: 26.68 }        // the pier's deck height, and its half-width
export const DOOR = { x: 13.13, z: 80.85, width: 5, height: 5 } // the terminal's doors at the pier, one per side (their centres)
export const INSIDE_Z = 92                               // where the AGVs wait, inside the terminal
export const CONTAINER = { width: 2.44, height: 2.99, length: 12 }  // as on the ships (ContainerShips.js)
export const RACK_HEIGHT = 1.8                           // above the deck: the rails a container rests on
export const MAX_CONTAINERS = 10
export const CRANE = {
  x: 20.5, z: -15,       // the pedestal (|x|, between the lampposts and the pier's edge)
  tower: 18,             // the jib's foot, above the deck
  jib: 40,               // the jib's length
  reach: [7, 36.5],      // the radius its hook works over
  safe: 23,              // containers are carried with their bottom this high (above sea level), over the ships' bridges
  park: { radius: 18, angle: -Math.PI / 2 },  // where it waits between ships: jib along the pier, away from the terminal
}
export const RACK_Z = CRANE.z                            // the rack, beside the crane, on the line of the door
export const AGV = { speed: 5, accel: 1, lift: 8, length: 14, width: 2.2, deck: 1.4, raised: RACK_HEIGHT + 0.2 }

const FENDER = 1.5         // between the pier and a ship's side
const BOW_Z = 40           // a berthed ship's bow is no nearer the terminal than this
const SIDESTEP = 40        // the ships approach and leave this far off their berths
const APPROACH = 8000      // how far downwind they come from and go to
const CRUISE = 5           // m/s
const EASE = 600           // m to stop in, and to get under way in
const TURN = 250           // the radius of the turn away from the pier
const INTERVAL = 1200      // s between ships
const SIDESTEP_TIME = 180
const MOOR = 60            // from berthed to the first lift
const CYCLE = 120          // per container
const LEAVE = 90           // from the last container's lift to unberthing
const AGV_START = 100      // an AGV sets off this long after its container's cycle begins
const EARTH_RADIUS = 6371000
// The first ship is in its second crane cycle at time 0 (another approaches, another leaves).
const FIRST_ARRIVAL = -(travelTime(APPROACH) + SIDESTEP_TIME + MOOR + CYCLE + 30)

// Crane cycle (s from its start): move over the container, lower, lock, hoist, carry over the rack,
// lower, unlock, hoist; the rest of the cycle it waits.
const C = { over: 20, down: 32, lock: 36, up: 50, across: 80, set: 92, unlock: 96, clear: 108 }

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (6 * x - 15) + 10))
const lerp = (a, b, f) => a + (b - a) * f

// Time to travel `distance` at CRUISE, slowing to a stop over the last EASE metres.
function travelTime(distance) {
  return (distance - EASE) / CRUISE + 2 * EASE / CRUISE
}
// Distance covered after `u` seconds of that.
function travelled(u, distance) {
  const cruise = (distance - EASE) / CRUISE
  if (u <= cruise) return CRUISE * u
  const w = Math.min(u - cruise, 2 * EASE / CRUISE) / (2 * EASE / CRUISE)
  return distance - EASE * (1 - w) * (1 - w)
}
// Distance covered after `u` seconds getting under way (speeding up over EASE metres, then at CRUISE).
function underWay(u) {
  const ease = 2 * EASE / CRUISE
  return u < ease ? EASE * (u / ease) * (u / ease) : EASE + CRUISE * (u - ease)
}
const DEPART_DISTANCE = Math.PI * TURN + APPROACH
const DEPART_TIME = 2 * EASE / CRUISE + (DEPART_DISTANCE - EASE) / CRUISE

// Moving AGV.speed with acceleration AGV.accel over `distance`: its time, and the distance after u s.
function driveTime(distance) {
  const ramp = AGV.speed / AGV.accel, rampDistance = AGV.speed * ramp / 2
  if (distance < 2 * rampDistance) return 2 * Math.sqrt(distance / AGV.accel)
  return 2 * ramp + (distance - 2 * rampDistance) / AGV.speed
}
function driven(u, distance) {
  const total = driveTime(distance)
  u = Math.max(0, Math.min(total, u))
  const half = total / 2
  const vMax = Math.min(AGV.speed, AGV.accel * half), ramp = vMax / AGV.accel
  if (u < ramp) return AGV.accel * u * u / 2
  if (u > total - ramp) return distance - AGV.accel * (total - u) * (total - u) / 2
  return AGV.accel * ramp * ramp / 2 + vMax * (u - ramp)
}

// The containers a ship unloads: `count` of those for which reachable(box), each the top of its stack when
// it is lifted (box indices into design.boxes / 4): the tops of the stacks in a random order, then the
// boxes under them, and so on.
function pickContainers(design, count, r, reachable) {
  const stacks = new Map()
  const boxes = design.boxes
  for (let i = 0; i < boxes.length / 4; i++) {
    if (!reachable(i)) continue
    const key = `${boxes[4 * i].toFixed(3)},${boxes[4 * i + 2].toFixed(3)}`
    if (!stacks.has(key)) stacks.set(key, [])
    stacks.get(key).push(i)
  }
  const order = [...stacks.values()].map((stack) => stack.sort((a, b) => boxes[4 * b + 1] - boxes[4 * a + 1]))
  for (let i = order.length - 1; i > 0; i--) {
    const k = Math.floor(r() * (i + 1))
    ;[order[i], order[k]] = [order[k], order[i]]
  }
  const picks = []
  for (let tier = 0; picks.length < count && order.some((stack) => stack.length > tier); tier++) {
    for (const stack of order) if (stack.length > tier && picks.length < count) picks.push(stack[tier])
  }
  return picks
}

const visits = new Map()

/**
 * Ship visit n at the terminal with seed `site` (memoised): { n, side, design, dims, berth: { x, z }
 * (the ship's origin when berthed), containers: [{ box (index into design.boxes / 4), color, pick: { x,
 * y, z } (its bottom centre on the ship), cycle (its crane cycle's start, s) }], arrive, berthed, leave,
 * away, end (s) }.
 */
export function shipVisit(n, site) {
  const key = `${site}:${n}`
  let visit = visits.get(key)
  if (visit) return visit
  const seed = hash(site, n, 21)
  const r = random(seed)
  const side = n & 1 ? -1 : 1
  const design = shipDesign(hash(seed, 1), [['feeder', 1]], [0.6, 0.95])
  const dims = shipDimensions(design)
  // Berthed with its cargo centred on the crane, but its bow short of the terminal.
  let cargo = 0
  for (let i = 2; i < design.boxes.length; i += 4) cargo += design.boxes[i]
  cargo = design.boxes.length ? 10 * cargo / (design.boxes.length / 4) : 0
  const berth = { x: side * (PIER.edge + FENDER + dims.halfBeam), z: Math.min(CRANE.z - cargo, BOW_Z - dims.bow) }
  const arrive = FIRST_ARRIVAL + n * INTERVAL
  const berthed = arrive + travelTime(APPROACH) + SIDESTEP_TIME
  const count = Math.min(MAX_CONTAINERS, 5 + Math.floor(6 * r()))
  const at = (box) => ({ x: berth.x + 10 * design.boxes[4 * box], z: berth.z + 10 * design.boxes[4 * box + 2] })
  const reachable = (box) => {
    const { x, z } = at(box), radius = Math.hypot(x - side * CRANE.x, z - CRANE.z)
    return radius >= CRANE.reach[0] && radius <= CRANE.reach[1]
  }
  const containers = pickContainers(design, count, r, reachable).map((box, j) => {
    const [, y, , color] = design.boxes.slice(4 * box, 4 * box + 4)
    return { box, color, pick: { ...at(box), y: 10 * y - CONTAINER.height / 2 }, cycle: berthed + MOOR + j * CYCLE }
  })
  const leave = containers[containers.length - 1].cycle + C.lock + LEAVE
  const away = leave + SIDESTEP_TIME
  visit = { n, side, design, dims, berth, containers, arrive, berthed, leave, away, end: away + DEPART_TIME }
  visits.set(key, visit)
  if (visits.size > 64) visits.delete(visits.keys().next().value)
  return visit
}

const LIFETIME = travelTime(APPROACH) + 2 * SIDESTEP_TIME + MOOR + (MAX_CONTAINERS - 1) * CYCLE + C.lock + LEAVE + DEPART_TIME

/** The ship visits under way at time t (arrived and not yet gone). */
export function visitsAt(t, site) {
  const out = []
  const last = Math.floor((t - FIRST_ARRIVAL) / INTERVAL)
  for (let n = last; n >= Math.floor((t - FIRST_ARRIVAL - LIFETIME) / INTERVAL); n--) {
    const visit = shipVisit(n, site)
    if (t >= visit.arrive && t < visit.end) out.push(visit)
  }
  return out
}

/**
 * Where a visit's ship is at time t: { x, y, z (its origin), heading (radians about +Y; 0 is bow along
 * +Z) }, or null outside the visit. y follows the curve of the sea away from the terminal (whose shaft
 * axis is at shaftZ).
 */
export function shipPose(visit, t, shaftZ = 0) {
  if (t < visit.arrive || t >= visit.end) return null
  const { side, berth } = visit
  // The path is that of the middle of the hull (mid metres ahead of the ship's origin), so that the hull
  // swings evenly about it in the turn.
  const mid = (visit.dims.stern + visit.dims.bow) / 2
  const berthZ = berth.z + mid
  const off = berth.x + side * SIDESTEP
  let x, z, heading = 0
  const approach = travelTime(APPROACH)
  if (t < visit.arrive + approach) {
    x = off
    z = berthZ - APPROACH + travelled(t - visit.arrive, APPROACH)
  }
  else if (t < visit.berthed) {
    x = lerp(off, berth.x, smooth((t - visit.arrive - approach) / SIDESTEP_TIME))
    z = berthZ
  }
  else if (t < visit.leave) {
    x = berth.x
    z = berthZ
  }
  else if (t < visit.away) {
    x = lerp(berth.x, off, smooth((t - visit.leave) / SIDESTEP_TIME))
    z = berthZ
  }
  else {
    const s = underWay(t - visit.away)
    if (s < Math.PI * TURN) {
      const phi = s / TURN
      x = off + side * TURN * (1 - Math.cos(phi))
      z = berthZ + TURN * Math.sin(phi)
      heading = side * phi
    }
    else {
      x = off + side * 2 * TURN
      z = berthZ - (s - Math.PI * TURN)
      heading = side * Math.PI
    }
  }
  x -= mid * Math.sin(heading)
  z -= mid * Math.cos(heading)
  const dz = z - shaftZ
  return { x, y: -(x * x + dz * dz) / (2 * EARTH_RADIUS), z, heading }
}

// The visit being unloaded on `side` at time t (from just before its first cycle until its crane is
// parked again), or null.
function unloadingAt(side, t, site) {
  for (const visit of visitsAt(t, site)) {
    if (visit.side !== side) continue
    const last = visit.containers[visit.containers.length - 1].cycle
    if (t >= visit.containers[0].cycle && t < last + CYCLE + C.over) return visit
  }
  return null
}

const rackPoint = (side) => ({ x: side * DOOR.x, y: PIER.deck + RACK_HEIGHT, z: RACK_Z })
// A point over the pier as the crane on `side` sees it: { angle (about its pedestal, from +X towards +Z),
// radius }, and back.
const polar = (side, p) => ({ angle: Math.atan2(p.z - CRANE.z, p.x - side * CRANE.x), radius: Math.hypot(p.x - side * CRANE.x, p.z - CRANE.z) })
const parkPolar = (side) => ({ angle: side > 0 ? CRANE.park.angle : Math.PI - CRANE.park.angle, radius: CRANE.park.radius })
// Slewing and luffing from a to b (polar), f of the way, the shorter way round.
function swing(side, a, b, f) {
  let turn = b.angle - a.angle
  turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI))
  const angle = a.angle + turn * f, radius = lerp(a.radius, b.radius, f)
  return { x: side * CRANE.x + radius * Math.cos(angle), z: CRANE.z + radius * Math.sin(angle) }
}

/**
 * The pedestal crane on `side` at time t: { x, z (its hook, over the pier or the ship), y (the bottom of
 * its spreader), carrying: { visit, j } | null }.
 */
export function craneAt(side, t, site) {
  const safe = CRANE.safe + CONTAINER.height
  const park = parkPolar(side)
  const parked = swing(side, park, park, 0)
  const visit = unloadingAt(side, t, site)
  if (!visit) return { ...parked, y: safe, carrying: null }
  const { containers } = visit
  const rack = rackPoint(side)
  let j = containers.findLastIndex((c) => c.cycle <= t)
  const u = t - containers[j].cycle
  if (u >= CYCLE) {
    // After the last cycle: back to where it waits.
    return { ...swing(side, polar(side, rack), park, smooth((u - CYCLE) / C.over)), y: safe, carrying: null }
  }
  const from = j > 0 ? polar(side, rack) : park
  const pick = containers[j].pick
  const top = pick.y + CONTAINER.height
  const rackTop = rack.y + CONTAINER.height
  const carrying = u >= C.lock && u < C.unlock - 2 ? { visit, j } : null
  if (u < C.over) return { ...swing(side, from, polar(side, pick), smooth(u / C.over)), y: safe, carrying }
  if (u < C.up) {
    const y = u < C.down ? lerp(safe, top, smooth((u - C.over) / (C.down - C.over)))
      : u < C.lock ? top : lerp(top, safe, smooth((u - C.lock) / (C.up - C.lock)))
    return { x: pick.x, z: pick.z, y, carrying }
  }
  if (u < C.across) return { ...swing(side, polar(side, pick), polar(side, rack), smooth((u - C.up) / (C.across - C.up))), y: safe, carrying }
  const y = u < C.set ? lerp(safe, rackTop, smooth((u - C.across) / (C.set - C.across)))
    : u < C.unlock ? rackTop : lerp(rackTop, safe, smooth((u - C.unlock) / (C.clear - C.unlock)))
  return { x: rack.x, z: rack.z, y, carrying }
}

// Container j's AGV trip: { start, out (s driving out), lift, end } and the distance it drives each way.
function agvTrip(visit, j) {
  const distance = INSIDE_Z - RACK_Z
  const out = driveTime(distance)
  const start = visit.containers[j].cycle + AGV_START
  return { start, out, distance, end: start + 2 * out + AGV.lift }
}

/**
 * The AGV on `side` at time t: { z (its centre), deck (its lift deck's top, above the deck of the pier),
 * carrying: { visit, j } | null }, or null while it is inside the terminal.
 */
export function agvAt(side, t, site) {
  for (const visit of visitsAt(t, site)) {
    if (visit.side !== side) continue
    for (let j = 0; j < visit.containers.length; j++) {
      const trip = agvTrip(visit, j)
      if (t < trip.start || t >= trip.end) continue
      const u = t - trip.start
      if (u < trip.out) return { z: INSIDE_Z - driven(u, trip.distance), deck: AGV.deck, carrying: null }
      if (u < trip.out + AGV.lift) {
        const deck = lerp(AGV.deck, AGV.raised, smooth((u - trip.out) / AGV.lift))
        return { z: RACK_Z, deck, carrying: deck > RACK_HEIGHT ? { visit, j } : null }
      }
      return { z: RACK_Z + driven(u - trip.out - AGV.lift, trip.distance), deck: AGV.raised, carrying: { visit, j } }
    }
  }
  return null
}

/**
 * Container j of a visit at time t: { where: 'ship' | 'crane' | 'rack' | 'agv' | 'gone', x, y (its
 * bottom), z } (positions for crane, rack and agv; on the ship it is drawn with the ship).
 */
export function containerAt(visit, j, t, site) {
  const c = visit.containers[j]
  if (t < c.cycle + C.lock) return { where: 'ship' }
  if (t < c.cycle + C.unlock - 2) {
    const crane = craneAt(visit.side, t, site)
    return { where: 'crane', x: crane.x, y: crane.y - CONTAINER.height, z: crane.z }
  }
  const trip = agvTrip(visit, j)
  const rack = rackPoint(visit.side)
  if (t >= trip.end) return { where: 'gone' }
  if (t < trip.start + trip.out) return { where: 'rack', ...rack }
  const agv = agvAt(visit.side, t, site)
  if (!agv?.carrying) return { where: 'rack', ...rack }
  return { where: 'agv', x: rack.x, y: PIER.deck + agv.deck, z: agv.z }
}

/** The times of a visit's events, for checks: { pick, set, agvStart, agvLift, agvEnd } per container. */
export function containerTimes(visit, j) {
  const c = visit.containers[j], trip = agvTrip(visit, j)
  return { pick: c.cycle + C.lock, set: c.cycle + C.unlock, agvStart: trip.start, agvLift: trip.start + trip.out, agvEnd: trip.end }
}

/** The seed of the terminal at a breech at (lat, lon) (degrees). */
export function siteSeed(lat, lon) {
  return hash(Math.round(lat * 1e4), Math.round(lon * 1e4), 31)
}
