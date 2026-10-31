// The launcher's cadence, and the feeder ships that keep up with it.
//
// Launch k starts accelerating at adjusted launcher time k * spacing (launchVehicleSpacingInSeconds), i.e.
// at simulated time startDelay + k * spacing / slowDown (launcherSlowDownPassageOfTime): the one place the
// cadence is set. Everything that keeps time with the launches works from launchCadence():
//
//  - The launch vehicles, sleds and adaptive nuts (VirtualObject.js) leave on it.
//  - At a launcher with an ocean terminal (its breech deep enough under the sea, OceanTerminal.js), each
//    launch's vehicle and nut are first drawn slowly out of the underwater terminal into the start of the
//    tube (the egress, egressDuration in launcher time), and the feeder ships call at the terminal's pier
//    on the same cadence (terminalPort.js). A ship brings the cargo of `launchesPerShip` launches: one
//    launch's, unless launches come faster than the berths can take ships (MIN_SHIP_INTERVAL), when it
//    brings the next few launches' cargo. Each ship's last container is in the terminal, taken down the
//    shaft and loaded, before the first of its launches begins its egress.
//  - Only every launchStride-th launch is drawn when there are too few virtual vehicles for all those in
//    flight (launcher.updateLaunchStride); at a terminal the stride is a whole number of ships, so the
//    launches drawn are the first of a ship's launches.
//
// Pure functions of the parameters, so that recorded shots reproduce elsewhere.

export const MIN_SHIP_INTERVAL = 900   // s: two berths, used in turn, each busy for up to about 1450 s a ship
export const EGRESS_DISTANCE = 120     // m: where a vehicle waits in the underwater terminal, behind the breech (its nut's back)
const MAX_EGRESS_RATE = 3              // the egress's final speed, at most this times its mean speed (keeps the profile monotonic)

/**
 * The launch cadence: { spacing (s of launcher time between launches), slowDown, startDelay,
 * launchInterval (simulated s between launches), launchesPerShip, shipInterval (simulated s), egress
 * (null, or { duration (launcher s), distance (m), endSpeed (m/s) }), launchTime(k), egressStart(k)
 * (simulated times launch k starts accelerating and leaves its bay), shipLaunch(n) (the first launch ship
 * n brings cargo for) }.
 * terminal: whether the launcher has an ocean terminal; endSpeed: the speed the launch path starts at.
 */
export function launchCadence({ spacing, slowDown = 1, startDelay = 0, egressDuration = 0, endSpeed = 0, terminal = false }) {
  const running = spacing > 0 && slowDown > 0 && Number.isFinite(spacing / slowDown)
  const launchInterval = running ? spacing / slowDown : Infinity
  const launchesPerShip = running ? Math.max(1, Math.ceil(MIN_SHIP_INTERVAL / launchInterval - 1e-9)) : 1
  const egress = terminal && egressDuration > 0 ? { duration: egressDuration, distance: EGRESS_DISTANCE, endSpeed: Math.max(0, endSpeed) } : null
  const egressLead = egress && running ? egress.duration / slowDown : 0
  const launchTime = (k) => startDelay + k * launchInterval
  return {
    spacing, slowDown, startDelay, launchInterval, launchesPerShip,
    shipInterval: launchesPerShip * launchInterval,
    running, terminal, egress,
    launchTime,
    egressStart: (k) => launchTime(k) - egressLead,
    shipLaunch: (n) => n * launchesPerShip,
  }
}

/**
 * How far behind the start of its path a launch is `deltaT` (launcher s, from -egress.duration to 0)
 * after it starts accelerating: from egress.distance at rest, easing out of the bay and gathering speed
 * to reach the start at egress.endSpeed (or as near it as a smooth, steady pull allows), so that it moves
 * on into the screws without a jolt. 0 from deltaT = 0 on.
 */
export function egressDistanceBehind(deltaT, egress) {
  if (!egress || deltaT >= 0) return 0
  const { duration, distance, endSpeed } = egress
  const x = Math.max(0, 1 + deltaT / duration)
  // A cubic from rest at x = 0 to the start at x = 1 with slope m (in units of distance / duration).
  const m = Math.min(MAX_EGRESS_RATE, endSpeed * duration / distance)
  return distance * (1 - ((m - 2) * x + (3 - m)) * x * x)
}

/** The speed (m/s) of the egress `deltaT` launcher s after the launch starts accelerating (negative deltaT). */
export function egressSpeed(deltaT, egress) {
  if (!egress || deltaT >= 0) return 0
  const { duration, distance, endSpeed } = egress
  const x = Math.max(0, 1 + deltaT / duration)
  const m = Math.min(MAX_EGRESS_RATE, endSpeed * duration / distance)
  return distance / duration * (3 * (m - 2) * x + 2 * (3 - m)) * x
}
