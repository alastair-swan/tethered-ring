// Deterministic animation time for one "animate*" checkbox.
//
// The animation time is a pure function of timeSinceStart and this channel's small state:
//   running:  animationTime = timeSinceStart - timeOffset
//   paused:   animationTime = frozenTime
// Pausing freezes objects where they are; resuming continues from the same place (no teleport).
// The state is plain JSON so that recorded shots can restore it on another computer.
export class AnimationChannel {
  constructor(running = true) {
    this.running = !!running
    this.timeOffset = 0
    this.frozenTime = 0
  }

  timeAt(timeSinceStart) {
    return this.running ? timeSinceStart - this.timeOffset : this.frozenTime
  }

  // Switch between running and paused at the given timeSinceStart.
  setRunning(running, timeSinceStart) {
    running = !!running
    if (running === this.running) return
    if (running) {
      this.timeOffset = timeSinceStart - this.frozenTime
    }
    else {
      this.frozenTime = timeSinceStart - this.timeOffset
    }
    this.running = running
  }

  getState() {
    return { running: this.running, timeOffset: this.timeOffset, frozenTime: this.frozenTime }
  }

  setState(state) {
    if (!state) return
    this.running = !!state.running
    this.timeOffset = Number(state.timeOffset) || 0
    this.frozenTime = Number(state.frozenTime) || 0
  }
}
