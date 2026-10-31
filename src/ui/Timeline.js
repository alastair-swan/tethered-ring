// The shot timeline: a ruler in video seconds with the shot's extent, its keyframes and the playhead.
//
// Mouse:
//   drag the playhead, or click/drag on the ruler   move the playhead (pauses playback)
//   drag anywhere else           pan the timeline; a click there moves the playhead
//   drag a keyframe              retime it (snaps to frames); a click goes to it
//   drag the green handles       move the shot's start or end (moving the start keeps every
//                                keyframe at its simulated moment)
//   wheel                        zoom around the pointer; shift+wheel pans
// The faint line along the bottom is the time speed (simulated seconds per video second, log scale).
const HEIGHT = 74
const RULER = 18
const KEY_Y = 44
const KEY_SIZE = 6
const GRIP_Y = 53 // handles are grabbed below the keyframes
const GRAB_PX = 6
const CLICK_PX = 3
const COLORS = {
  background: '#15171c',
  outside: '#0d0e12',
  shot: '#22262f',
  tick: '#596070',
  text: '#9aa3b5',
  key: '#e8e8e8',
  selected: '#ff7020',
  playhead: '#ff4050',
  speed: '#40c8ff',
  handle: '#4cd07a',
}

export class Timeline {
  constructor(shots) {
    this.shots = shots
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'ss-timeline'
    this.canvas.height = HEIGHT
    this.view = null // [start, end] in video seconds
    this.drag = null
    this.lastDraw = ''
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.canvas.addEventListener('pointercancel', () => { this.drag = null })
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  fit() {
    const d = Math.max(1, this.shots.duration)
    this.view = [-0.04 * d, 1.04 * d]
    this.lastDraw = ''
  }

  get width() { return this.canvas.clientWidth || 320 }
  x(t) { return (t - this.view[0]) / (this.view[1] - this.view[0]) * this.width }
  t(x) { return this.view[0] + x / this.width * (this.view[1] - this.view[0]) }

  keyAt(x, y) {
    if (Math.abs(y - KEY_Y) > KEY_SIZE + 4) return -1
    let best = -1
    let bestDistance = KEY_SIZE + 3
    this.shots.keyframes.forEach((k, i) => {
      const d = Math.abs(this.x(k.time) - x)
      if (d <= bestDistance) { best = i; bestDistance = d }
    })
    return best
  }

  local(e) {
    const rect = this.canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  // What a press at (x, y) grabs: a keyframe, a shot handle, the playhead or (otherwise) the timeline.
  hit(x, y) {
    if (y < RULER) return { kind: 'scrub' }
    const key = this.keyAt(x, y)
    if (key >= 0) return { kind: 'key', key }
    if (y >= GRIP_Y) {
      if (Math.abs(x - this.x(this.shots.duration)) <= GRAB_PX) return { kind: 'end' }
      if (Math.abs(x - this.x(0)) <= GRAB_PX) return { kind: 'start' }
    }
    if (Math.abs(x - this.x(this.shots.playhead)) <= GRAB_PX) return { kind: 'scrub' }
    return { kind: 'pan' }
  }

  onPointerDown(e) {
    const [x, y] = this.local(e)
    this.canvas.setPointerCapture(e.pointerId)
    const hit = e.button === 0 ? this.hit(x, y) : { kind: 'pan' }
    this.drag = { ...hit, x, view: [...this.view], moved: false, button: e.button }
    if (hit.kind === 'key') this.shots.selectKeyframe(hit.key)
    else if (hit.kind === 'scrub') {
      this.shots.pause()
      this.shots.setPlayhead(this.t(x))
    }
    else if (hit.kind === 'pan') this.canvas.style.cursor = 'grabbing'
  }

  onPointerMove(e) {
    const [x, y] = this.local(e)
    const drag = this.drag
    if (!drag) {
      const kind = this.hit(x, y).kind
      this.canvas.style.cursor = kind === 'pan' ? 'grab' : kind === 'scrub' ? 'col-resize' : 'ew-resize'
      return
    }
    if (!drag.moved && Math.abs(x - drag.x) <= CLICK_PX) return
    drag.moved = true
    const t = this.t(x)
    if (drag.kind === 'scrub') this.shots.setPlayhead(t)
    else if (drag.kind === 'pan') {
      const dt = (x - drag.x) / this.width * (drag.view[1] - drag.view[0])
      this.view = [drag.view[0] - dt, drag.view[1] - dt]
    }
    else if (drag.kind === 'key') this.shots.moveKeyframe(this.shots.selected, t)
    else if (drag.kind === 'end') this.shots.setDuration(t)
    else if (drag.kind === 'start') {
      drag.start = this.shots.clampShotStart(t)
      this.lastDraw = ''
    }
  }

  onPointerUp(e) {
    const drag = this.drag
    this.drag = null
    this.canvas.releasePointerCapture?.(e.pointerId)
    if (!drag) return
    const [x] = this.local(e)
    if (drag.kind === 'key' && !drag.moved) this.shots.goToKeyframe(drag.key)
    else if (drag.kind === 'start' && drag.moved && drag.start !== undefined) this.shots.moveShotStart(drag.start)
    else if (drag.kind === 'pan' && !drag.moved && drag.button === 0) {
      this.shots.pause()
      this.shots.setPlayhead(this.t(x))
    }
    this.canvas.style.cursor = drag.kind === 'pan' ? 'grab' : this.canvas.style.cursor
    this.lastDraw = ''
  }

  onWheel(e) {
    e.preventDefault()
    const [x] = this.local(e)
    const span = this.view[1] - this.view[0]
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dt = (e.shiftKey ? e.deltaY : e.deltaX) / this.width * span
      this.view = [this.view[0] + dt, this.view[1] + dt]
      return
    }
    const factor = Math.exp(e.deltaY * 0.0015)
    const t = this.t(x)
    const newSpan = Math.min(1e6, Math.max(0.05, span * factor))
    const left = t - (t - this.view[0]) * newSpan / span
    this.view = [left, left + newSpan]
  }

  // Redraws when anything shown has changed. Called every animation frame while visible.
  draw() {
    const shots = this.shots
    if (!this.view) this.fit()
    // Show the whole shot when its end grows out of view (not while a handle is being dragged).
    if (!this.drag && this.fittedDuration !== shots.duration) {
      if (shots.duration > this.view[1] && !(this.fittedDuration > this.view[1])) this.fit()
      this.fittedDuration = shots.duration
    }
    // Bring the playhead back into view when it moves out of it (playing or jumping), but not when
    // the timeline has been panned away from it.
    if (!this.drag && shots.playhead !== this.lastPlayhead) {
      const span = this.view[1] - this.view[0]
      const outside = shots.playhead > this.view[1] || shots.playhead < this.view[0]
      const wasInside = this.lastPlayhead === undefined || (this.lastPlayhead >= this.view[0] && this.lastPlayhead <= this.view[1])
      if (outside && (wasInside || !shots.playing)) {
        if (shots.playhead >= 0 && shots.playhead <= shots.duration) this.fit()
        else this.view = [shots.playhead - 0.1 * span, shots.playhead + 0.9 * span]
      }
      this.lastPlayhead = shots.playhead
    }
    const ratio = window.devicePixelRatio || 1
    const width = this.width
    const signature = [width, ratio, this.view, shots.playhead, shots.revision, shots.selected, this.drag?.start].join('|')
    if (signature === this.lastDraw) return
    this.lastDraw = signature
    const canvas = this.canvas
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(HEIGHT * ratio)
    const g = canvas.getContext('2d')
    g.setTransform(ratio, 0, 0, ratio, 0, 0)
    g.fillStyle = COLORS.outside
    g.fillRect(0, 0, width, HEIGHT)
    const x0 = this.x(0)
    const x1 = this.x(shots.duration)
    g.fillStyle = COLORS.shot
    g.fillRect(x0, 0, x1 - x0, HEIGHT)

    // Ruler: a tick spacing of 1, 2 or 5 x 10^n giving labels about 60 px apart.
    const span = this.view[1] - this.view[0]
    const raw = span / width * 60
    const magnitude = 10 ** Math.floor(Math.log10(raw))
    const step = [1, 2, 5, 10].map(m => m * magnitude).find(s => s >= raw)
    g.font = '10px system-ui, sans-serif'
    g.textBaseline = 'top'
    g.strokeStyle = COLORS.tick
    g.fillStyle = COLORS.text
    g.lineWidth = 1
    for (let t = Math.ceil(this.view[0] / step) * step; t <= this.view[1]; t += step) {
      const x = Math.round(this.x(t)) + 0.5
      g.beginPath()
      g.moveTo(x, RULER - 6)
      g.lineTo(x, RULER)
      g.stroke()
      g.fillText(`${Number(t.toFixed(6))}s`, x + 2, 2)
    }
    g.beginPath()
    g.moveTo(0, RULER + 0.5)
    g.lineTo(width, RULER + 0.5)
    g.stroke()

    // Time speed, log scale from 0.01x (bottom) to 10000x.
    const keys = shots.keyframes
    if (keys.length) {
      const y = (s) => HEIGHT - 3 - (Math.log10(Math.max(0.01, s)) + 2) / 6 * 18
      g.strokeStyle = COLORS.speed
      g.globalAlpha = 0.6
      g.beginPath()
      for (let px = 0; px <= width; px += 2) {
        const v = y(shots.speedAt(this.t(px)))
        if (px === 0) g.moveTo(px, v)
        else g.lineTo(px, v)
      }
      g.stroke()
      g.globalAlpha = 1
    }

    // Shot start and end handles (the start shows where it is being dragged to).
    const handle = (t, dragged) => {
      const x = Math.round(this.x(t)) + 0.5
      g.strokeStyle = COLORS.handle
      g.fillStyle = COLORS.handle
      g.globalAlpha = dragged ? 0.6 : 1
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(x, RULER)
      g.lineTo(x, HEIGHT)
      g.stroke()
      g.fillRect(x - 4, GRIP_Y + 2, 8, HEIGHT - GRIP_Y - 6)
      g.globalAlpha = 1
    }
    const startDrag = this.drag?.kind === 'start' && this.drag.start !== undefined ? this.drag.start : null
    handle(startDrag ?? 0, startDrag !== null)
    handle(shots.duration, false)

    // Keyframes
    keys.forEach((k, i) => {
      const x = this.x(k.time)
      if (x < -KEY_SIZE || x > width + KEY_SIZE) return
      g.fillStyle = i === shots.selected ? COLORS.selected : COLORS.key
      g.beginPath()
      g.moveTo(x, KEY_Y - KEY_SIZE)
      g.lineTo(x + KEY_SIZE, KEY_Y)
      g.lineTo(x, KEY_Y + KEY_SIZE)
      g.lineTo(x - KEY_SIZE, KEY_Y)
      g.closePath()
      g.fill()
      if (k.ease) {
        g.strokeStyle = COLORS.background
        g.beginPath()
        g.moveTo(x - 3, KEY_Y)
        g.lineTo(x + 3, KEY_Y)
        g.stroke()
      }
    })

    // Playhead
    const px = Math.round(this.x(shots.playhead)) + 0.5
    g.strokeStyle = COLORS.playhead
    g.fillStyle = COLORS.playhead
    g.lineWidth = 1.5
    g.beginPath()
    g.moveTo(px, 0)
    g.lineTo(px, HEIGHT)
    g.stroke()
    g.beginPath()
    g.moveTo(px - 5, 0)
    g.lineTo(px + 5, 0)
    g.lineTo(px, 7)
    g.closePath()
    g.fill()
  }
}
