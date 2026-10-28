import { MultiModeTrial } from '../launcher/MultiModeTrial.js'

// Y key: sweeps mass-driver exit speed and evacuated-tube exit altitude, searching the ramp angle of
// ascent that maximises payload mass fraction for each combination, and prints a table to the
// console. One combination is evaluated per frame so the page stays responsive.
export class LaunchTrialSweep {
  constructor(app) {
    this.app = app
    this.trial = new MultiModeTrial()
  }

  get active() { return this.trial.active }

  toggle() {
    if (this.trial.active) this.trial.active = false
    else this.trial.start()
  }

  step() {
    const mtm = this.trial
    if (!mtm.active) return
    const { store, launchSystem: launcher } = this.app
    const d = store.derived
    const p = store.definitions
    if (!launcher) { mtm.active = false; return }

    if (mtm.h === 0) {
      const tubeExitAltitude = mtm.evtea[mtm.j]
      const exitSpeed = mtm.k * 1000
      d.verboseLogging.value = 0
      d.launcherMassDriver1InitialVelocity.value = 2
      d.launcherMassDriver2InitialVelocity.value = 40
      d.launcherMassDriverExitVelocity.value = exitSpeed
      d.launcherRampDesignMode.value = 1
      if (exitSpeed === 100) {
        d.launcherRampExitAltitude.value = 100
        d.launcherEvacuatedTubeExitAltitude.value = 110
      }
      else {
        d.launcherRampExitAltitude.value = p.launcherRampExitAltitude.value
        d.launcherEvacuatedTubeExitAltitude.value = tubeExitAltitude
      }

      mtm.bestMassFraction = -1
      const cached = mtm.checkCache()
      const start = cached === null ? 1 : Math.max(1, cached - 3)
      const finish = cached === null ? 90 : Math.min(90, cached + 3)
      const margin = 200000 // m of apogee slack allowed when judging a candidate
      for (let angleOfAscent = start; angleOfAscent <= finish; angleOfAscent++) {
        const turningRadius = (d.launcherRampExitAltitude.value - d.launcherMassDriverAltitude.value) / (1 - Math.cos(angleOfAscent * Math.PI / 180))
        d.launcherRampTurningRadius.value = turningRadius
        this.app.recomputeLaunchTrajectory({ curvesOnly: true })
        const valid = launcher.initialApogeeDistance < launcher.planetRadius + d.launchVehicleDesiredOrbitalAltitude.value + margin
        if (mtm.bestMassFraction === -1 || (valid && launcher.massFraction > mtm.bestMassFraction)) {
          mtm.bestMassFraction = launcher.massFraction
          mtm.bestRampCentrifugalAcceleration = exitSpeed ** 2 / turningRadius
          mtm.bestLauncherRampTurningRadius = turningRadius
          mtm.bestAngleOfAscent = angleOfAscent
        }
      }
      d.launcherRampTurningRadius.value = mtm.bestLauncherRampTurningRadius
      this.app.recomputeLaunchTrajectory()

      const row = mtm.k - mtm.sk
      mtm.massFraction[row][mtm.j] = launcher.massFraction
      mtm.rocketTotalDeltaV[row][mtm.j] = launcher.rocketTotalDeltaV
      mtm.peakCentrifugalAcceleration[row][mtm.j] = mtm.bestRampCentrifugalAcceleration
      mtm.peakDecelleration[row][mtm.j] = launcher.peakDecelleration
      mtm.angleOfAscent[row][mtm.j] = { k: mtm.k, j: mtm.j, AoA: mtm.bestAngleOfAscent }
      console.log(`exit speed ${exitSpeed} m/s, tube exit ${tubeExitAltitude} m: best angle ${mtm.bestAngleOfAscent} deg, mass fraction ${launcher.massFraction}`)

      if (mtm.lastTrial()) {
        console.log('massDriverExitSpeed', ...mtm.evtea, ...mtm.evtea, ...mtm.evtea, ...mtm.evtea)
        for (let k = 0; k < mtm.nk - mtm.sk; k++) {
          console.log((mtm.sk + k) * 1000, ...mtm.massFraction[k], ...mtm.rocketTotalDeltaV[k], ...mtm.peakCentrifugalAcceleration[k], ...mtm.peakDecelleration[k])
        }
        console.log(JSON.stringify(mtm.angleOfAscent))
        // Put the edited derived values back to the GUI's values.
        store.derive()
        this.app.recomputeLaunchTrajectory()
      }
    }
    mtm.nextTrial()
  }
}
