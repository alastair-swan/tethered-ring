// Profiles the app headlessly: loads a preset, optionally moves the camera, and prints frame
// timings, draw calls, triangles and the heaviest objects in view.
//
//   npm run profile -- --preset toLowOrbitFromEarth [--camera "<js>"] [--frames 120] [--wait 40]
//
// Uses the GPU (like SMOKE_GPU=1). --camera is JavaScript run before measuring, with `app` in scope.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback }
const here = path.dirname(fileURLToPath(import.meta.url))
const profiler = fs.readFileSync(path.join(here, 'profile', 'profileScene.js'), 'utf8')
const cameraJs = arg('camera', '')
const evalJs = `(async () => { const app = window.tetheredRing.app; ${cameraJs};
  for (let i = 0; i < 400; i++) { await new Promise(r => requestAnimationFrame(r)); const s = app.planet.getDebugStats(); if (i > 60 && !s.queue && !s.inflight) break }
  ${profiler}; return JSON.stringify(await profileScene({ frames: ${Number(arg('frames', '120'))} })) })()`
const result = spawnSync(process.execPath, [path.join(here, 'smoke.mjs'), '--url-params', `preset=${arg('preset', 'default')}`, '--wait', arg('wait', '40'), '--out', arg('out', 'profile.png'), '--eval', evalJs],
  { encoding: 'utf8', env: { ...process.env, SMOKE_GPU: process.env.SMOKE_GPU ?? '1' }, maxBuffer: 1 << 26 })
const out = result.stdout + result.stderr
const m = out.match(/eval: "(.*)"\n/)
if (!m) { console.log(out); process.exit(1) }
console.log(JSON.stringify(JSON.parse(JSON.parse(`"${m[1]}"`)), null, 2))
