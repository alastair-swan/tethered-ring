import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchCadence, egressDistanceBehind, egressSpeed, MIN_SHIP_INTERVAL, EGRESS_DISTANCE } from '../../src/launcher/launchCadence.js'
import { terminalSchedule, shipVisit, visitsAt, containerTimes, DEFAULT_SCHEDULE, READY_LEAD, siteSeed } from '../../src/launcher/terminalPort.js'
import { MovingVirtualObject } from '../../src/launcher/VirtualObject.js'

const SITE = siteSeed(19.6234, -163.4055)
const cadenceOf = (spacing, slowDown = 1) => launchCadence({ spacing, slowDown, startDelay: 25, egressDuration: 120, endSpeed: 2, terminal: true })

test('a ship a launch when launches are far enough apart, else a ship every few launches, never more often than the berths allow', () => {
  const c = cadenceOf(1200)
  assert.equal(c.launchesPerShip, 1)
  assert.equal(c.shipInterval, 1200)
  assert.equal(c.launchTime(3), 25 + 3600)
  assert.equal(c.egressStart(3), 25 + 3600 - 120)
  assert.equal(cadenceOf(20).launchesPerShip, 45)
  assert.equal(cadenceOf(120).launchesPerShip, 8)
  assert.equal(cadenceOf(120).shipInterval, 960)
  // The launcher's clock slowed down: launches (and ships) further apart in simulated time.
  const slow = cadenceOf(600, 0.5)
  assert.equal(slow.launchInterval, 1200)
  assert.equal(slow.launchesPerShip, 1)
  assert.equal(slow.egressStart(0), 25 - 240)
  for (const spacing of [0.5, 20, 100, 450, 899, 900, 3000]) assert.ok(cadenceOf(spacing).shipInterval >= MIN_SHIP_INTERVAL - 1e-9)
  // No terminal: no egress. Stopped launches: the ships keep their own timetable.
  assert.equal(launchCadence({ spacing: 20 }).egress, null)
  assert.equal(terminalSchedule(launchCadence({ spacing: 20, slowDown: 0, terminal: true })), DEFAULT_SCHEDULE)
  assert.equal(terminalSchedule(null), DEFAULT_SCHEDULE)
})

test('the egress eases out of the bay from rest and reaches the start of the path at its speed', () => {
  for (const endSpeed of [0, 1, 2, 50]) {
    const egress = launchCadence({ spacing: 1200, egressDuration: 120, endSpeed, terminal: true }).egress
    assert.equal(egressDistanceBehind(-120, egress), EGRESS_DISTANCE)
    assert.ok(Math.abs(egressDistanceBehind(-1e-9, egress)) < 1e-6)
    assert.equal(egressDistanceBehind(0, egress), 0)
    assert.equal(egressDistanceBehind(-500, egress), EGRESS_DISTANCE)
    assert.equal(egressSpeed(-120, egress), 0)
    let previous = Infinity
    for (let dt = -120; dt <= 0; dt += 0.25) {
      const s = egressDistanceBehind(dt, egress)
      assert.ok(s <= previous + 1e-9, `moves back at ${dt} (end speed ${endSpeed})`)
      // Its speed is the rate it closes on the start.
      if (dt > -119 && dt < -1) {
        const numeric = (egressDistanceBehind(dt - 0.01, egress) - egressDistanceBehind(dt + 0.01, egress)) / 0.02
        assert.ok(Math.abs(numeric - egressSpeed(dt, egress)) < 1e-3)
      }
      previous = s
    }
    // Slow: never more than 3 m/s; it arrives at the path's speed where that is a slow one.
    const end = egressSpeed(-1e-9, egress)
    assert.ok(end <= 3 + 1e-6)
    if (endSpeed <= 3) assert.ok(Math.abs(end - endSpeed) < 1e-6, `arrives at ${end} m/s, not ${endSpeed}`)
  }
})

test('each ship is unloaded and its cargo loaded before its launch leaves the bay, and the berths stay clear', () => {
  for (const spacing of [20, 120, 900, 1200, 2000]) {
    const cadence = cadenceOf(spacing)
    const schedule = terminalSchedule(cadence)
    assert.equal(schedule.interval, cadence.shipInterval)
    const visits = Array.from({ length: 30 }, (_, k) => shipVisit(k - 10, SITE, schedule))
    for (const visit of visits) {
      const leaves = cadence.egressStart(cadence.shipLaunch(visit.n))
      assert.ok(Math.abs(visit.ready - leaves) < 1e-6, `ship ${visit.n} is ready at ${visit.ready}, launch leaves at ${leaves}`)
      const last = containerTimes(visit, visit.containers.length - 1)
      assert.ok(last.agvEnd + 300 <= leaves + 1e-6, `ship ${visit.n} (spacing ${spacing}): last container in at ${last.agvEnd}, launch leaves at ${leaves}`)
      // Nor long before: by the loading time, and for a ship with fewer than 10 containers the cycles it did not need.
      assert.ok(leaves - last.agvEnd <= 300 + (10 - visit.containers.length) * 120 + 1e-6)
      assert.ok(Math.abs(visit.ready - visit.arrive - READY_LEAD) < 1e-9)
      const next = visits.find((v) => v.n === visit.n + 2)
      if (next) assert.ok(visit.away < next.berthed - 180, `spacing ${spacing}: ship ${visit.n} leaves at ${visit.away}, ship ${next.n} comes alongside at ${next.berthed - 180}`)
    }
    for (let t = 0; t < 10000; t += 250) assert.ok(visitsAt(t, SITE, schedule).length >= 1, `no ship at ${t} (spacing ${spacing})`)
  }
})

test('a launch is in flight from when it starts leaving the terminal', () => {
  class Moving extends MovingVirtualObject {
    static activeObjects = new Map()
  }
  Moving.numObjects = 2
  Moving.tInc = 1200
  const saved = MovingVirtualObject.egress
  try {
    MovingVirtualObject.egress = null
    assert.deepEqual(Moving.activeLaunchIndices(1150, 500), [])
    MovingVirtualObject.egress = { duration: 120, distance: EGRESS_DISTANCE, endSpeed: 2 }
    assert.equal(Moving.egressDuration, 120)
    assert.deepEqual(Moving.activeLaunchIndices(1070, 500), [])
    assert.deepEqual(Moving.activeLaunchIndices(1090, 500), [1])
    assert.deepEqual(Moving.activeLaunchIndices(1300, 500), [1])
    assert.deepEqual(Moving.activeLaunchIndices(1100 + 1200, 2000), [1, 2])
  }
  finally {
    MovingVirtualObject.egress = saved
  }
})
