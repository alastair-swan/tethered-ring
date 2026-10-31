import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { shipVisit, visitsAt, shipPose, craneAt, agvAt, containerAt, containerTimes, rackZ, PIER, CONTAINER, siteSeed } from '../../src/launcher/terminalPort.js'
import { terminalModel } from '../../src/launcher/terminalModel.js'

const SITE = siteSeed(19.6234, -163.4055)
const VISITS = Array.from({ length: 40 }, (_, k) => shipVisit(k - 10, SITE))

test('a visit is the same from the same seed, and unloads 5 to 10 containers off the tops of its stacks', () => {
  for (const visit of VISITS) {
    assert.equal(shipVisit(visit.n, SITE), visit)
    const count = visit.containers.length
    assert.ok(count >= 5 && count <= 10, `ship ${visit.n}: ${count} containers`)
    const boxes = visit.design.boxes
    for (const { box } of visit.containers) {
      for (let i = 0; i < boxes.length / 4; i++) {
        const above = boxes[4 * i] === boxes[4 * box] && boxes[4 * i + 2] === boxes[4 * box + 2] && boxes[4 * i + 1] > boxes[4 * box + 1]
        assert.ok(!above, `ship ${visit.n}: box ${box} is under box ${i}`)
      }
    }
  }
})

test('ships alternate berths, and a berth is clear before the next ship comes alongside', () => {
  for (const visit of VISITS) {
    const next = VISITS.find((v) => v.n === visit.n + 2)
    if (!next) continue
    assert.equal(next.side, visit.side)
    assert.notEqual(VISITS.find((v) => v.n === visit.n + 1).side, visit.side)
    assert.ok(visit.away < next.berthed - 180, `ship ${visit.n} leaves at ${visit.away}, ship ${next.n} comes alongside at ${next.berthed - 180}`)
  }
})

test('ships keep clear of the pier and the terminal, and move smoothly', () => {
  // The pier and the terminal (seen from above), and points around a ship's hull at its waterline.
  const solid = [{ x: PIER.edge, z0: -161.5, z1: 84 }, { x: 56, z0: 78, z1: 184 }]
  const hull = (visit, pose) => {
    const { halfBeam, stern, bow } = visit.dims
    const along = { x: Math.sin(pose.heading), z: Math.cos(pose.heading) }
    const points = []
    for (let k = 0; k <= 40; k++) {
      const s = stern + (bow - stern) * k / 40
      for (const b of [-halfBeam, halfBeam]) points.push({ x: pose.x + s * along.x + b * along.z, z: pose.z + s * along.z - b * along.x })
    }
    return points
  }
  for (const visit of VISITS.slice(0, 8)) {
    let previous = null
    for (let t = visit.arrive; t < visit.end; t += 1) {
      const pose = shipPose(visit, t)
      if (previous) assert.ok(Math.hypot(pose.x - previous.x, pose.z - previous.z) < 6, `ship ${visit.n} jumps at ${t}`)
      for (const p of hull(visit, pose)) {
        for (const box of solid) {
          assert.ok(!(Math.abs(p.x) < box.x - 0.01 && p.z > box.z0 && p.z < box.z1), `ship ${visit.n} hits the pier or terminal at ${t}`)
        }
      }
      previous = pose
    }
  }
})

test('each container goes ship, crane, rack, AGV, then into the terminal', () => {
  const order = ['ship', 'crane', 'rack', 'agv', 'gone']
  for (const visit of VISITS.slice(5, 15)) {
    visit.containers.forEach((c, j) => {
      let stage = 0
      for (let t = c.cycle - 10; t < c.cycle + 400; t += 0.5) {
        const where = order.indexOf(containerAt(visit, j, t, SITE).where)
        assert.ok(where >= stage, `ship ${visit.n} container ${j} goes back from ${order[stage]} to ${order[where]} at ${t}`)
        stage = where
      }
      assert.equal(order[stage], 'gone')
    })
  }
})

test('the crane sets a container down where it then sits, and an AGV never meets a loaded rack', () => {
  for (const visit of VISITS.slice(5, 15)) {
    visit.containers.forEach((c, j) => {
      const times = containerTimes(visit, j)
      const crane = craneAt(visit.side, times.set - 1, SITE)
      assert.ok(Math.abs(crane.z - rackZ(j)) < 1e-9)
      assert.ok(Math.abs(crane.y - CONTAINER.height - (PIER.deck + 1.8)) < 1e-9)
      // Before its AGV sets off the previous container is inside, and the next is not yet set down.
      if (j > 0) assert.ok(containerTimes(visit, j - 1).agvEnd < times.agvStart, `ship ${visit.n}: AGVs ${j - 1} and ${j} overlap`)
      if (j + 1 < visit.containers.length) assert.ok(times.agvEnd < containerTimes(visit, j + 1).set - 12, `ship ${visit.n}: rack ${j + 1} loaded while AGV ${j} is out`)
      // While carrying, the AGV is at its rack or between it and the door.
      for (let t = times.agvLift; t < times.agvEnd; t += 1) {
        const agv = agvAt(visit.side, t, SITE)
        if (agv) assert.ok(agv.z >= rackZ(j) - 1e-9)
      }
    })
  }
})

test('the ship stays at its berth while the crane works on it', () => {
  for (const visit of VISITS.slice(5, 15)) {
    for (const c of visit.containers) {
      const pose = shipPose(visit, c.cycle + 36)
      assert.equal(pose.x, visit.berth.x)
      assert.equal(pose.z, visit.berth.z)
    }
  }
})

test('there is a ship at the terminal at the start, and a steady stream after', () => {
  for (let t = 0; t < 20000; t += 300) assert.ok(visitsAt(t, SITE).length >= 2, `${visitsAt(t, SITE).length} ships at ${t}`)
  assert.ok(visitsAt(0, SITE).some((v) => craneAt(v.side, 0, SITE).carrying || containerAt(v, 0, 0, SITE).where !== 'ship'))
})

test('the model has its markers, lamps, windows and doors', () => {
  const model = terminalModel(fs.readFileSync(new URL('../../models/launcher_ocean_terminal.obj', import.meta.url), 'utf8'))
  assert.ok(model.markers.launcher && model.markers.anchorRear && model.markers.anchorFront)
  assert.equal(model.lamps.length, 24)
  for (const lamp of model.lamps) assert.ok(lamp.direction.y < -0.5)
  assert.equal(model.geometries.terminalWindows.attributes.position.count, 60 * 6)
  assert.equal(model.geometries.terminalDoors.attributes.position.count, 2 * 6)
  assert.ok(model.shaft.top > model.shaft.bottom)
})
