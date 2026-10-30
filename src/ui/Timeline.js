// The shot timeline: a ruler in video seconds with the shot's extent, its keyframes and the playhead.
//
// Mouse:
//   click or drag on the ruler   move the playhead (pauses playback)
//   drag a keyframe              retime it (snaps to frames); a click selects it
//   wheel                        zoom around the pointer
//   shift+wheel / drag with the middle button    pan
// The faint line along the bottom is the time speed (simulated seconds per video second, log scale).
const HEIGHT = 74
const RULER = 18
const KEY_Y = 44
const KEY_SIZE = 6
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

  onPointerDown(e) {
    const [x, y] = this.local(e)
    this.canvas.setPointerCapture(e.pointerId)
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: 'pan', x, view: [...this.view] }
      return
    }
    const key = this.keyAt(x, y)
    if (key >= 0) {
      this.shots.selectKeyframe(key)
      this.drag = { kind: 'key', key, x, moved: false }
      return
    }
    this.shots.pause()
    this.drag = { kind: 'scrub' }
    this.shots.setPlayhead(this.t(x))
  }

  onPointerMove(e) {
    const [x, y] = this.local(e)
    if (!this.drag) {
      this.canvas.style.cursor = this.keyAt(x, y) >= 0 ? 'ew-resize' : 'pointer'
      return
    }
    if (this.drag.kind === 'scrub') this.shots.setPlayhead(this.t(x))
    else if (this.drag.kind === 'pan') {
      const dt = (x - this.drag.x) / this.width * (this.drag.view[1] - this.drag.view[0])
      this.view = [this.drag.view[0] - dt, this.drag.view[1] - dt]
    }
    else if (this.drag.kind === 'key' && (this.drag.moved || Math.abs(x - this.drag.x) > 3)) {
      this.drag.moved = true
      this.shots.moveKeyframe(this.shots.selected, this.t(x))
    }
  }

  onPointerUp(e) {
    const drag = this.drag
    this.drag = null
    if (drag?.kind === 'key' && !drag.moved) this.shots.goToKeyframe(drag.key)
    this.canvas.releasePointerCapture?.(e.pointerId)
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
    if (!this.view || this.fittedDuration !== shots.duration) {
      this.fit()
      this.fittedDuration = shots.duration
    }
    // Keep the playhead in view (unless it is being dragged).
    if (!this.drag) {
      const span = this.view[1] - this.view[0]
      if (shots.playhead > this.view[1] || shots.playhead < this.view[0]) {
        if (shots.playhead >= 0 && shots.playhead <= shots.duration) this.fit()
        else this.view = [shots.playhead - 0.1 * span, shots.playhead + 0.9 * span]
      }
    }
    const ratio = window.devicePixelRatio || 1
    const width = this.width
    const signature = [width, ratio, this.view, shots.playhead, shots.revision, shots.selected].join('|')
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
