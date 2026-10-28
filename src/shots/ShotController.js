import {
  createShot, parseShot, serializeShot, shotDuration, sampleParameterTrack, validateShot, SHOT_FILE_EXTENSION, DEFAULT_OUTPUT,
} from './ShotFormat.js'
import { sampleCameraPath } from './CameraPath.js'
import {
  VideoRecorder, resolveCodec, defaultBitrate, evenDimension, isRecordingSupported, CODEC_LABELS, CONTAINERS,
} from '../capture/VideoRecorder.js'
import { downloadText } from '../app/exports.js'

const PENDING_SHOT_KEY = 'tetheredRing.pendingShot'
const TERRAIN_WAIT_TIMEOUT_MS = 15000

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const slug = (name) => (name.trim().replace(/[^\w.-]+/g, '_') || 'shot')

// Creates, previews, records, exports and imports shots (see ShotFormat.js).
//
// Modes:
//   preview   - plays the shot in real time from its start (B key)
//   render    - renders the shot frame by frame at a fixed time step and encodes it to video
//   live take - you fly the camera while the simulation advances at a fixed step; every frame's
//               camera pose (and any parameter you change) is recorded into a new shot, and the
//               video is encoded at the same time if "Encode live take" is on
export class ShotController {
  constructor(app) {
    this.app = app
    this.shot = null
    this.mode = 'idle'
    this.cancelRequested = false
    this.settings = {
      name: 'Untitled shot',
      width: DEFAULT_OUTPUT.width,
      height: DEFAULT_OUTPUT.height,
      fps: DEFAULT_OUTPUT.fps,
      duration: DEFAULT_OUTPUT.duration,
      codec: DEFAULT_OUTPUT.codec,
      container: DEFAULT_OUTPUT.container,
      bitrateMbps: 0,
      waitForTerrain: DEFAULT_OUTPUT.waitForTerrain,
      saveToDisk: typeof window.showSaveFilePicker === 'function',
      interpolation: 'smooth',
      encodeLiveTake: true,
    }
  }

  // True while a fixed-step loop (render or live take) is driving frames instead of App.frame().
  get busy() { return this.mode === 'render' || this.mode === 'live' }
  // True while the camera follows the shot's path.
  get drivesCamera() { return this.mode === 'render' || this.mode === 'preview' }

  // ---- GUI -----------------------------------------------------------------------------------

  buildGui(gui) {
    const folder = gui.addFolder('Shots & Recording').close()
    this.folder = folder
    const s = this.settings
    folder.add(s, 'name').name('Shot name')
    const output = folder.addFolder('Output video')
    output.add(s, 'width', 16, 7680, 2).name('Width (px)')
    output.add(s, 'height', 16, 4320, 2).name('Height (px)')
    output.add(s, 'fps', [24, 25, 30, 48, 50, 60, 120]).name('Frame rate')
    output.add(s, 'duration', 0.1, 3600, 0.1).name('Duration (s)')
    output.add(s, 'codec', Object.fromEntries(Object.entries(CODEC_LABELS).map(([k, v]) => [v, k]))).name('Codec (preferred)')
    output.add(s, 'container', Object.fromEntries(Object.entries(CONTAINERS).map(([k, v]) => [v.label, k]))).name('Container')
    output.add(s, 'bitrateMbps', 0, 500, 1).name('Bitrate Mbps (0 = auto)')
    output.add(s, 'waitForTerrain').name('Wait for terrain tiles')
    if (typeof window.showSaveFilePicker === 'function') output.add(s, 'saveToDisk').name('Stream to file (large videos)')
    folder.add(s, 'interpolation', ['smooth', 'linear']).name('Camera interpolation').onChange((v) => { if (this.shot) this.shot.camera.interpolation = v })

    const actions = {
      newShot: () => this.newShot(),
      addKeyframe: () => this.addKeyframe(),
      removeLastKeyframe: () => this.removeLastKeyframe(),
      preview: () => this.preview(),
      render: () => this.renderShot(),
      liveTake: () => (this.mode === 'live' ? this.stop() : this.startLiveTake()),
      exportShot: () => this.exportShot(),
      importShot: () => this.chooseShotFile(),
    }
    folder.add(actions, 'newShot').name('New shot (starts now)')
    folder.add(actions, 'addKeyframe').name('Add camera keyframe (A)')
    folder.add(actions, 'removeLastKeyframe').name('Remove last keyframe (K)')
    folder.add(actions, 'preview').name('Preview shot (B)')
    folder.add(actions, 'render').name('Render shot to video')
    folder.add(s, 'encodeLiveTake').name('Encode live take')
    this.liveTakeButton = folder.add(actions, 'liveTake').name('Start live take')
    folder.add(actions, 'exportShot').name('Export shot file')
    folder.add(actions, 'importShot').name('Import shot file')

    this.statusElement = document.createElement('div')
    this.statusElement.className = 'gui-stats shot-status'
    folder.$children.appendChild(this.statusElement)
    this.updateStatus()
    if (!isRecordingSupported()) this.setStatus('This browser has no WebCodecs video encoder, so recording is unavailable. Shots can still be created, previewed and exported.')
  }

  setStatus(text) {
    if (this.statusElement) this.statusElement.textContent = text
  }

  updateStatus(extra = '') {
    const shot = this.shot
    const summary = shot
      ? `"${shot.name}": ${shot.camera.keyframes.length} keyframe(s), ${shotDuration(shot).toFixed(2)} s, starts at sim time ${shot.simulation.startTime.toFixed(3)} s`
      : 'No shot yet. Press A to start one at the current moment.'
    this.setStatus(extra ? `${summary}\n${extra}` : summary)
  }

  refreshGui() {
    for (const c of this.folder?.controllersRecursive() ?? []) c.updateDisplay()
  }

  // ---- Building a shot ----------------------------------------------------------------------

  newShot() {
    const app = this.app
    this.shot = createShot({
      name: this.settings.name,
      preset: app.presetId,
      parameters: app.store.snapshot(),
      startTime: app.clock.time,
      animationState: app.getAnimationState(),
    })
    this.shot.camera.interpolation = this.settings.interpolation
    this.applySettingsToShot()
    this.updateStatus()
    return this.shot
  }

  applySettingsToShot() {
    const s = this.settings
    Object.assign(this.shot.output, {
      width: evenDimension(s.width), height: evenDimension(s.height), fps: Number(s.fps), duration: s.duration,
      codec: s.codec, container: s.container, bitrateMbps: s.bitrateMbps || null, waitForTerrain: s.waitForTerrain,
    })
    this.shot.name = s.name
  }

  addKeyframe() {
    if (!this.shot) this.newShot()
    const time = this.app.clock.time - this.shot.simulation.startTime
    if (time < 0) {
      this.updateStatus('Cannot add a keyframe before the shot start; start a new shot instead.')
      return
    }
    const keys = this.shot.camera.keyframes
    const key = { time, ...this.app.camera.getState() }
    const existing = keys.findIndex(k => Math.abs(k.time - time) < 1e-6)
    if (existing >= 0) keys[existing] = key
    else {
      keys.push(key)
      keys.sort((a, b) => a.time - b.time)
    }
    if (time > this.settings.duration) {
      this.settings.duration = Math.ceil(time * 10) / 10
      this.refreshGui()
    }
    this.applySettingsToShot()
    this.updateStatus(`Keyframe added at +${time.toFixed(2)} s.`)
  }

  removeLastKeyframe() {
    this.shot?.camera.keyframes.pop()
    this.updateStatus()
  }

  // ---- Applying a shot ----------------------------------------------------------------------

  // Restores the parameters and simulation state the shot starts from.
  restoreStart(shot) {
    const app = this.app
    const current = app.store.snapshot()
    const changed = Object.keys(shot.parameters).some(k => !Object.is(shot.parameters[k], current[k]))
    const unknown = app.store.restore(shot.parameters)
    if (unknown.length) console.warn('Shot contains parameters this version does not know:', unknown)
    if (changed) app.applyAllParameters()
    app.clock.setTime(shot.simulation.startTime)
    app.setAnimationState(shot.simulation.animationState)
    app.stopInteractiveAnimations()
  }

  // Applies camera and parameter tracks for shot-relative time t.
  applyAt(shot, t) {
    const pose = sampleCameraPath(shot.camera, t)
    if (pose) this.app.camera.setState(pose)
    let changed = false
    for (const [name, track] of Object.entries(shot.parameterTracks ?? {})) {
      const value = sampleParameterTrack(track, t)
      if (value !== undefined && !Object.is(this.app.store.get(name), value)) {
        this.app.store.set(name, value)
        changed = true
      }
    }
    if (changed) {
      this.app.store.derive()
      this.app.applyAllParameters()
    }
  }

  // ---- Preview (real time) ------------------------------------------------------------------

  async preview() {
    if (this.mode !== 'idle') return
    const shot = this.shot
    if (!shot?.camera.keyframes.length) {
      this.updateStatus('Add at least one keyframe (A) before previewing.')
      return
    }
    this.restoreStart(shot)
    this.mode = 'preview'
    this.cancelRequested = false
    const start = shot.simulation.startTime
    const duration = shotDuration(shot)
    this.updateStatus('Previewing...')
    // App.frame() keeps running; apply the path just before each step.
    while (!this.cancelRequested && this.app.clock.time - start <= duration) {
      this.applyAt(shot, this.app.clock.time - start)
      await nextFrame()
    }
    this.mode = 'idle'
    this.updateStatus('Preview finished.')
  }

  // ---- Fixed-step rendering -----------------------------------------------------------------

  async waitForTerrain() {
    const planet = this.app.planet
    const start = performance.now()
    for (;;) {
      planet.update(this.app.camera3d)
      const stats = planet.getDebugStats()
      if (!(stats.queue > 0 || stats.inflight > 0)) return
      if (performance.now() - start > TERRAIN_WAIT_TIMEOUT_MS) return
      await sleep(30)
    }
  }

  // Runs frames at a fixed step until `shouldContinue(frameIndex)` returns false.
  async runFixedStep({ width, height, fps, waitForTerrain, perFrame, recorder, progressLabel }) {
    const app = this.app
    app.renderer.setAnimationLoop(null)
    app.setRenderSize(width, height, { pixelRatio: 1 })
    app.clock.setFixedStep(1 / fps)
    const progress = new ProgressOverlay(() => this.stop())
    try {
      for (let i = 0; ; i++) {
        if (this.cancelRequested) break
        const go = perFrame(i)
        if (go === false) break
        app.step(i === 0 ? 0 : 1 / fps)
        if (waitForTerrain) await this.waitForTerrain()
        app.render()
        if (recorder) await recorder.addFrame()
        progress.update(progressLabel(i))
        // Yield so the page (and the live-take camera controls) stay responsive.
        await nextFrame()
      }
    }
    finally {
      progress.remove()
      app.clock.setFixedStep(null)
      app.onResizeAfterRecording()
      app.renderer.setAnimationLoop(() => app.frame())
    }
  }

  async createRecorder(output, fileName) {
    const settings = { width: output.width, height: output.height, fps: output.fps }
    const recorder = new VideoRecorder({
      canvas: this.app.renderer.domElement,
      ...settings,
      codec: output.codec,
      container: output.container,
      bitrate: 0,
      fileName,
      saveToDisk: this.settings.saveToDisk,
    })
    if (!(await recorder.prepareTarget())) return null
    const codec = await resolveCodec(output.codec, settings)
    if (!codec) throw new Error('No video encoder is available in this browser for that resolution.')
    recorder.options.bitrate = output.bitrateMbps ? output.bitrateMbps * 1e6 : defaultBitrate(codec, output.width, output.height, output.fps)
    if (codec !== output.codec) console.info(`${CODEC_LABELS[output.codec]} encoding is not available here; using ${CODEC_LABELS[codec]}.`)
    await recorder.start(codec)
    return recorder
  }

  async renderShot() {
    if (this.mode !== 'idle') return
    if (!isRecordingSupported()) { this.updateStatus('Recording needs a browser with WebCodecs (Chrome, Edge, Safari 17+, Firefox 130+).'); return }
    const shot = this.shot
    if (!shot?.camera.keyframes.length) { this.updateStatus('Add at least one keyframe (A) before rendering.'); return }
    this.applySettingsToShot()
    const output = shot.output
    let recorder
    try {
      recorder = await this.createRecorder(output, slug(shot.name))
    }
    catch (err) {
      this.updateStatus(`Could not start recording: ${err.message}`)
      return
    }
    if (!recorder) return
    this.mode = 'render'
    this.cancelRequested = false
    this.restoreStart(shot)
    const frames = Math.max(1, Math.round(shotDuration(shot) * output.fps))
    const start = shot.simulation.startTime
    let failed = null
    try {
      await this.runFixedStep({
        ...output,
        recorder,
        perFrame: (i) => {
          if (i >= frames) return false
          this.app.clock.setTime(start + i / output.fps)
          this.applyAt(shot, i / output.fps)
          return true
        },
        progressLabel: (i) => `Rendering "${shot.name}": frame ${i + 1} / ${frames} (${CODEC_LABELS[recorder.options.codec]} ${output.width}x${output.height} @ ${output.fps} fps)`,
      })
    }
    catch (err) {
      failed = err
    }
    this.mode = 'idle'
    await this.finishRecorder(recorder, failed)
  }

  async finishRecorder(recorder, failed) {
    if (!recorder) return
    if (failed || this.cancelRequested) {
      await recorder.cancel()
      this.updateStatus(failed ? `Recording failed: ${failed.message}` : 'Recording cancelled.')
      if (failed) console.error(failed)
      return
    }
    const result = await recorder.finish()
    const size = result.bytes ? ` (${(result.bytes / 1e6).toFixed(1)} MB)` : ''
    this.updateStatus(`Saved ${result.fileName}${size}: ${recorder.frameCount} frames, ${CODEC_LABELS[recorder.options.codec]}.`)
  }

  // ---- Live take ----------------------------------------------------------------------------

  async startLiveTake() {
    if (this.mode !== 'idle') return
    this.settings.interpolation = 'linear'
    const shot = this.newShot()
    shot.camera.interpolation = 'linear'
    const output = shot.output
    let recorder = null
    if (this.settings.encodeLiveTake) {
      if (!isRecordingSupported()) { this.updateStatus('This browser cannot encode video; recording the camera path only.') }
      else {
        try {
          recorder = await this.createRecorder(output, slug(shot.name))
          if (!recorder) return
        }
        catch (err) {
          this.updateStatus(`Could not start recording: ${err.message}`)
          return
        }
      }
    }
    this.mode = 'live'
    this.cancelRequested = false
    this.liveTakeButton?.name('Stop live take')
    const baseline = this.app.store.snapshot()
    let frames = 0
    let failed = null
    try {
      await this.runFixedStep({
        ...output,
        waitForTerrain: false,
        recorder,
        perFrame: (i) => {
          if (this.stopRequested) return false
          const t = i / output.fps
          shot.camera.keyframes.push({ time: t, ...this.app.camera.getState() })
          const current = this.app.store.snapshot()
          for (const [k, v] of Object.entries(current)) {
            if (Object.is(v, baseline[k]) && !shot.parameterTracks[k]) continue
            const track = (shot.parameterTracks[k] ??= [{ time: 0, value: baseline[k] }])
            if (!Object.is(track[track.length - 1].value, v)) track.push({ time: t, value: v })
          }
          frames = i + 1
          return true
        },
        progressLabel: (i) => `Live take: ${(i / output.fps).toFixed(2)} s recorded. Fly the camera; press "Stop live take" to finish.`,
      })
    }
    catch (err) {
      failed = err
    }
    this.stopRequested = false
    this.mode = 'idle'
    this.liveTakeButton?.name('Start live take')
    output.duration = frames / output.fps
    this.settings.duration = output.duration
    this.refreshGui()
    if (recorder) await this.finishRecorder(recorder, failed)
    else this.updateStatus(`Live take captured: ${frames} frames. Export the shot to keep it.`)
  }

  stop() {
    if (this.mode === 'live') this.stopRequested = true
    else this.cancelRequested = true
  }

  // ---- Files ----------------------------------------------------------------------------------

  exportShot() {
    if (!this.shot) { this.updateStatus('Nothing to export yet.'); return }
    this.applySettingsToShot()
    downloadText(serializeShot(this.shot), slug(this.shot.name) + SHOT_FILE_EXTENSION, 'application/json')
  }

  chooseShotFile() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (file) await this.importShotText(await file.text())
    }
    input.click()
  }

  async importShotText(text) {
    let shot
    try {
      shot = parseShot(text)
    }
    catch (err) {
      this.updateStatus(err.message)
      return
    }
    if (shot.preset !== this.app.presetId) {
      // Presets configure construction-time options, so switching needs a reload.
      sessionStorage.setItem(PENDING_SHOT_KEY, text)
      this.app.switchPreset(shot.preset)
      return
    }
    this.loadShot(shot)
  }

  loadShot(shot) {
    this.shot = validateShot(shot)
    Object.assign(this.settings, {
      name: shot.name, width: shot.output.width, height: shot.output.height, fps: shot.output.fps, duration: shot.output.duration,
      codec: shot.output.codec, container: shot.output.container, bitrateMbps: shot.output.bitrateMbps ?? 0,
      waitForTerrain: shot.output.waitForTerrain, interpolation: shot.camera.interpolation,
    })
    this.refreshGui()
    this.restoreStart(shot)
    const first = sampleCameraPath(shot.camera, 0)
    if (first) this.app.camera.setState(first)
    this.updateStatus('Shot loaded. Preview (B) or render it.')
  }

  async resumePendingShot() {
    const text = sessionStorage.getItem(PENDING_SHOT_KEY)
    if (!text) return
    sessionStorage.removeItem(PENDING_SHOT_KEY)
    try {
      this.loadShot(parseShot(text))
    }
    catch (err) {
      this.updateStatus(err.message)
    }
  }
}

class ProgressOverlay {
  constructor(onCancel) {
    this.element = document.createElement('div')
    this.element.className = 'recording-overlay'
    this.label = document.createElement('span')
    const button = document.createElement('button')
    button.textContent = 'Stop'
    button.addEventListener('click', onCancel)
    this.element.append(this.label, button)
    document.body.appendChild(this.element)
  }

  update(text) {
    this.label.textContent = text
  }

  remove() {
    this.element.remove()
  }
}
