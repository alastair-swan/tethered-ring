// Browser-side frame profiler, injected by scripts/profile.mjs (or pasted into the console).
// Returns per-subsystem CPU times, GPU time (when EXT_disjoint_timer_query_webgl2 is available),
// draw calls, triangles and the heaviest objects by triangle count.
async function profileScene({ frames = 120, warmup = 30 } = {}) {
  const app = window.tetheredRing.app
  const renderer = app.renderer
  const gl = renderer.getContext()
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  const timings = { launcher: [], transit: [], planet: [], camera: [], step: [], render: [], gpu: [] }
  const wrap = (obj, name, key) => {
    const fn = obj[name].bind(obj)
    obj[name] = (...args) => { const t = performance.now(); const r = fn(...args); timings[key].push(performance.now() - t); return r }
  }
  if (app.launchSystem) wrap(app.launchSystem, 'animate', 'launcher')
  wrap(app.transitSystem, 'animate', 'transit')
  wrap(app.planet, 'update', 'planet')
  wrap(app.camera, 'update', 'camera')
  wrap(app, 'step', 'step')
  const pendingQueries = []
  const originalRender = app.render.bind(app)
  let calls = 0, triangles = 0, counted = 0
  app.render = () => {
    let query = null
    if (timerExt && pendingQueries.length < 4) { query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query) }
    renderer.info.autoReset = false
    renderer.info.reset()
    const t = performance.now()
    originalRender()
    timings.render.push(performance.now() - t)
    calls += renderer.info.render.calls; triangles += renderer.info.render.triangles; counted++
    renderer.info.autoReset = true
    if (query) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); pendingQueries.push(query) }
    for (let i = pendingQueries.length - 1; i >= 0; i--) {
      const q = pendingQueries[i]
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
        timings.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6)
        gl.deleteQuery(q); pendingQueries.splice(i, 1)
      }
    }
  }
  const frame = () => new Promise(r => requestAnimationFrame(r))
  for (let i = 0; i < warmup; i++) await frame()
  for (const k of Object.keys(timings)) timings[k].length = 0
  calls = triangles = counted = 0
  const wall0 = performance.now()
  for (let i = 0; i < frames; i++) await frame()
  const wall = (performance.now() - wall0) / frames

  // Triangles by object (visible, inside the camera frustum), grouped by name.
  const camera = app.camera3d
  camera.updateMatrixWorld()
  const frustum = new (camera.constructor.prototype.constructor === undefined ? Object : Object)()
  const THREE = await window.tetheredRing.THREE
  const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
  const byName = {}
  const visible = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true }
  app.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints) || !o.geometry || !visible(o)) return
    if (o.frustumCulled && o.geometry.boundingSphere && !f.intersectsObject(o)) return
    const g = o.geometry
    const count = g.index ? g.index.count : g.attributes.position.count
    const tris = (o.isMesh ? count / 3 : count / 2) * (o.isInstancedMesh ? o.count : 1)
    let name = o.name || o.parent?.name || o.type
    for (let x = o; x && !o.name; x = x.parent) if (x.name) { name = x.name; break }
    const e = (byName[name] ??= { objects: 0, triangles: 0, vertices: 0 })
    e.objects++; e.triangles += tris; e.vertices += g.attributes.position.count
  })
  const top = Object.entries(byName).sort((a, b) => b[1].triangles - a[1].triangles).slice(0, 12)
    .map(([name, e]) => [name, e.objects, Math.round(e.triangles), e.vertices])
  const stat = (a) => a.length ? { mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2), max: +Math.max(...a).toFixed(2) } : null
  return {
    msPerFrameWall: +wall.toFixed(2),
    cpu: Object.fromEntries(['step', 'launcher', 'transit', 'planet', 'camera', 'render'].map(k => [k, stat(timings[k])])),
    gpu: stat(timings.gpu),
    drawCallsPerFrame: Math.round(calls / counted),
    trianglesPerFrame: Math.round(triangles / counted),
    topObjectsInView: top,
  }
}
