import * as THREE from 'three'
import * as tram from '../utils/tram.js'
import { advanceDate } from '../physics/solar.js'

// The view status: a small readout in the bottom-right corner (the camera's latitude, longitude and
// altitude, its heading and pitch, the simulated time) with a Copy button that copies a link to exactly
// this view: the preset, the date (the start's day of year and UTC time of day, which set the sun, the
// weather and the clouds, and the simulated time since), the camera (position, target and up, in the planet's frame,
// so they do not depend on how the scene is placed) and its field of view, and every parameter that
// differs from the preset's own. Opening the link (?view=, see main.js) restores it: for reporting what is
// seen, and reproducing it while debugging; it opens paused at the view's moment. It is page HTML, never
// drawn into recordings.

const _v = new THREE.Vector3()
const _q = new THREE.Quaternion()

function round(v, digits) {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/** The view as plain data (see the header). `baseline`: the parameters as the preset left them. */
export function getViewState(app, baseline) {
  const c = app.camera.getState()
  app.planetCoordSys.updateWorldMatrix(true, false)
  const toPlanetPoint = (a) => app.planetCoordSys.worldToLocal(_v.fromArray(a)).toArray().map(x => round(x, 3))
  app.planetCoordSys.getWorldQuaternion(_q).invert()
  const toPlanetDirection = (a) => _v.fromArray(a).applyQuaternion(_q).toArray().map(x => round(x, 6))
  const current = app.store.snapshot()
  const parameters = {}
  for (const [k, v] of Object.entries(current)) {
    if (JSON.stringify(v) !== JSON.stringify(baseline[k])) parameters[k] = v
  }
  return {
    preset: app.presetId,
    time: round(app.clock.time, 4),
    // (Always, even where the preset's automatic choice made them: they set the sun and the weather.)
    sunDayOfYear: app.store.get('sunDayOfYear'),
    sunTimeOfDayUTC: app.store.get('sunTimeOfDayUTC'),
    camera: {
      position: toPlanetPoint(c.position),
      target: toPlanetPoint(c.target),
      up: toPlanetDirection(c.up),
      orbitUp: toPlanetDirection(c.orbitUp),
      fov: c.fov,
    },
    parameters,
  }
}

/** Restores a view from getViewState (the preset must already be the view's). */
export function applyViewState(app, view) {
  const parameters = { ...view.parameters }
  if (typeof view.sunDayOfYear === 'number') parameters.sunDayOfYear = view.sunDayOfYear
  if (typeof view.sunTimeOfDayUTC === 'number') parameters.sunTimeOfDayUTC = view.sunTimeOfDayUTC
  if (Object.keys(parameters).length) {
    app.store.restore(parameters)
    app.applyAllParameters()
  }
  // (Paused at the view's moment, through the shots' playhead, which drives the clock.)
  if (typeof view.time === 'number') {
    app.shots.pause()
    app.shots.jumpToSimTime(view.time)
  }
  const c = view.camera
  if (c) {
    app.planetCoordSys.updateWorldMatrix(true, false)
    const toWorldPoint = (a) => app.planetCoordSys.localToWorld(_v.fromArray(a)).toArray()
    app.planetCoordSys.getWorldQuaternion(_q)
    const toWorldDirection = (a) => _v.fromArray(a).applyQuaternion(_q).toArray()
    app.camera.setState({
      position: toWorldPoint(c.position),
      target: toWorldPoint(c.target),
      up: toWorldDirection(c.up),
      orbitUp: toWorldDirection(c.orbitUp ?? c.up),
      fov: c.fov,
    })
  }
}

/** The link that opens this view. */
export function viewUrl(view) {
  const url = new URL(window.location.href)
  url.search = ''
  url.searchParams.set('preset', view.preset)
  url.searchParams.set('view', JSON.stringify(view))
  return url.toString()
}

export class ViewStatus {
  constructor(app, baseline) {
    this.app = app
    this.baseline = baseline
    this.element = document.createElement('div')
    this.element.className = 'view-status'
    this.text = document.createElement('span')
    const copy = document.createElement('button')
    copy.textContent = 'Copy view'
    copy.title = 'Copy a link that reopens exactly this view (preset, time, camera, changed parameters)'
    copy.addEventListener('click', () => this.copy(copy))
    this.element.append(this.text, copy)
    document.body.appendChild(this.element)
    this.lastUpdate = -Infinity
  }

  setVisible(visible) {
    this.element.hidden = !visible
  }

  // A few times a second (it is text in the page, not the canvas).
  update(nowMs) {
    if (this.element.hidden || nowMs - this.lastUpdate < 250) return
    this.lastUpdate = nowMs
    const app = this.app, camera = app.camera3d
    const p = app.planetCoordSys.worldToLocal(camera.getWorldPosition(_v))
    const g = tram.ecefToGeodetic(p.x, p.y, p.z, app.planetSpec.ellipsoid)
    // Heading and pitch of the view direction, from the local east, north and up.
    const lat = THREE.MathUtils.degToRad(g.lat), lon = THREE.MathUtils.degToRad(g.lon)
    const up = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon))
    const east = new THREE.Vector3(Math.cos(lon), 0, -Math.sin(lon))
    const north = new THREE.Vector3().crossVectors(up, east)
    app.planetCoordSys.getWorldQuaternion(_q).invert()
    const d = camera.getWorldDirection(new THREE.Vector3()).applyQuaternion(_q)
    const heading = (THREE.MathUtils.radToDeg(Math.atan2(d.dot(east), d.dot(north))) + 360) % 360
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.dot(up), -1, 1)))
    const alt = Math.abs(g.alt) >= 10000 ? `${(g.alt / 1000).toFixed(1)} km` : `${g.alt.toFixed(1)} m`
    // The date now (the start's plus the simulated time), in UTC and the local solar time here.
    const date = advanceDate(Math.max(1, app.store.get('sunDayOfYear')), Math.max(0, app.store.get('sunTimeOfDayUTC')), app.clock.time)
    const clock = (h) => {
      const m = Math.floor((((h % 24) + 24) % 24) * 60)
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    }
    this.text.textContent = `${g.lat.toFixed(4)}°, ${g.lon.toFixed(4)}°  ${alt}  hdg ${heading.toFixed(1)}° pitch ${pitch.toFixed(1)}°  fov ${camera.fov.toFixed(1)}°`
      + `  ·  day ${date.dayOfYear} ${clock(date.utcHours)} UTC (${clock(date.utcHours + g.lon / 15)} local)  t ${app.clock.time.toFixed(1)} s`
  }

  async copy(button) {
    const url = viewUrl(getViewState(this.app, this.baseline))
    try {
      await navigator.clipboard.writeText(url)
      button.textContent = 'Copied'
    }
    catch {
      window.prompt('Copy this link:', url)
    }
    setTimeout(() => { button.textContent = 'Copy view' }, 1500)
  }
}
