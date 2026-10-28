// The single source of simulated time. Everything that animates reads `time` from here instead of
// using wall-clock time, which makes the simulation reproducible: the same parameters and the same
// sim time always produce the same scene.
//
// In real-time mode, each tick advances by the measured frame time (clamped so that a backgrounded
// tab does not cause a huge jump). In fixed-step mode (used for recording and shot playback) each
// tick advances by exactly `fixedStep` seconds, regardless of how long rendering took.
const MAX_REALTIME_STEP = 0.1 // seconds

export class SimClock {
  constructor() {
    this.time = 0
    this.delta = 0
    this.paused = false
    this.timeScale = 1
    this.fixedStep = null
    this._lastWallTime = null
  }

  // Advances the clock and returns the step taken (seconds).
  tick(wallTimeMs = performance.now()) {
    const wallDelta = this._lastWallTime === null ? 0 : (wallTimeMs - this._lastWallTime) / 1000
    this._lastWallTime = wallTimeMs
    if (this.paused) {
      this.delta = 0
    }
    else if (this.fixedStep !== null) {
      this.delta = this.fixedStep
    }
    else {
      this.delta = Math.min(Math.max(wallDelta, 0), MAX_REALTIME_STEP) * this.timeScale
    }
    this.time += this.delta
    return this.delta
  }

  setTime(time) {
    this.time = time
    this.delta = 0
  }

  // Switch to fixed-step mode (e.g. 1/60 for a 60 fps recording); pass null to return to real time.
  setFixedStep(step) {
    this.fixedStep = step
    this._lastWallTime = null
  }
}
