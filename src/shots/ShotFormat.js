// Shot files (*.shot.json) describe a repeatable piece of footage: which preset and parameter
// values to use, the simulated time it starts at (which fixes where every vehicle is), the camera
// path, any parameters that change during the shot, and the output video settings. Importing the
// same file on another computer reproduces the same frames.
//
// {
//   format: 'tethered-ring-shot', version: 1, name, createdAt,
//   preset: 'default',                      // preset id (see src/presets/presets.js)
//   parameters: { name: value, ... },       // full parameter snapshot at the start of the shot
//   simulation: { startTime, animationState },
//   camera: { interpolation: 'smooth' | 'linear', keyframes: [{ time, position, target, up, orbitUp, fov }] },
//   parameterTracks: { name: [{ time, value }] },   // optional, times relative to the shot start
//   output: { width, height, fps, duration, codec, container, bitrateMbps, waitForTerrain },
// }
//
// Positions are world coordinates in metres (planet centre at the origin), stored as JSON doubles.
export const SHOT_FORMAT = 'tethered-ring-shot'
export const SHOT_VERSION = 1
export const SHOT_FILE_EXTENSION = '.shot.json'

export const DEFAULT_OUTPUT = {
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 10,
  codec: 'av1',
  container: 'mp4',
  bitrateMbps: null, // null = derive a high default from resolution and frame rate
  waitForTerrain: true,
}

export function createShot({ name = 'Untitled shot', preset, parameters, startTime, animationState = null }) {
  return {
    format: SHOT_FORMAT,
    version: SHOT_VERSION,
    name,
    createdAt: new Date().toISOString(),
    preset,
    parameters: { ...parameters },
    simulation: { startTime, animationState },
    camera: { interpolation: 'smooth', keyframes: [] },
    parameterTracks: {},
    output: { ...DEFAULT_OUTPUT },
  }
}

export function shotDuration(shot) {
  const keyframes = shot.camera.keyframes
  const lastKey = keyframes.length ? keyframes[keyframes.length - 1].time : 0
  return Math.max(shot.output.duration ?? 0, lastKey)
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)

// Throws an Error describing the first problem found; returns the (normalised) shot otherwise.
export function validateShot(shot) {
  const fail = (msg) => { throw new Error(`Invalid shot file: ${msg}`) }
  if (!shot || typeof shot !== 'object') fail('not a JSON object')
  if (shot.format !== SHOT_FORMAT) fail(`"format" must be "${SHOT_FORMAT}"`)
  if (!Number.isInteger(shot.version) || shot.version > SHOT_VERSION) fail(`unsupported version ${shot.version} (this build reads up to ${SHOT_VERSION})`)
  if (typeof shot.preset !== 'string') fail('"preset" must be a string')
  if (!shot.parameters || typeof shot.parameters !== 'object') fail('"parameters" missing')
  if (!Number.isFinite(shot.simulation?.startTime)) fail('"simulation.startTime" must be a number')
  const keyframes = shot.camera?.keyframes
  if (!Array.isArray(keyframes)) fail('"camera.keyframes" must be an array')
  keyframes.forEach((k, i) => {
    if (!Number.isFinite(k.time)) fail(`keyframe ${i} has no time`)
    for (const field of ['position', 'target', 'up']) if (!isVec3(k[field])) fail(`keyframe ${i} "${field}" must be [x, y, z]`)
    if (i > 0 && k.time < keyframes[i - 1].time) fail(`keyframe ${i} is earlier than keyframe ${i - 1}`)
  })
  if (!['smooth', 'linear'].includes(shot.camera.interpolation ?? 'smooth')) fail('"camera.interpolation" must be "smooth" or "linear"')
  shot.camera.interpolation ??= 'smooth'
  shot.parameterTracks ??= {}
  for (const [name, track] of Object.entries(shot.parameterTracks)) {
    if (!Array.isArray(track) || track.some(s => !Number.isFinite(s.time))) fail(`parameter track "${name}" is malformed`)
  }
  shot.output = { ...DEFAULT_OUTPUT, ...(shot.output ?? {}) }
  const o = shot.output
  if (!(o.width >= 16 && o.height >= 16)) fail('"output.width/height" must be at least 16')
  if (!(o.fps > 0 && o.fps <= 240)) fail('"output.fps" must be between 0 and 240')
  return shot
}

export function serializeShot(shot) {
  return JSON.stringify(shot, null, 2)
}

export function parseShot(text) {
  let shot
  try {
    shot = JSON.parse(text)
  }
  catch (err) {
    throw new Error(`Invalid shot file: ${err.message}`)
  }
  return validateShot(shot)
}

// Value of a parameter track at time t: numbers are interpolated linearly, anything else steps.
export function sampleParameterTrack(track, t) {
  if (!track.length) return undefined
  if (t <= track[0].time) return track[0].value
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]
    const b = track[i]
    if (t < b.time) {
      if (typeof a.value === 'number' && typeof b.value === 'number' && b.time > a.time) {
        return a.value + (b.value - a.value) * (t - a.time) / (b.time - a.time)
      }
      return a.value
    }
  }
  return track[track.length - 1].value
}
