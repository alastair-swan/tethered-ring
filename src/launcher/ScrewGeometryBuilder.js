import * as THREE from 'three'
import { ScrewGeometry } from './ScrewGeometry.js'

// Screw segments stream past quickly when the camera follows a launch vehicle, and building their
// geometry on the main thread made frames stutter and screws show up late. buildScrewGeometry() hands
// the work to a small pool of Web Workers and returns a Promise of the geometry; with async false (or
// where workers are unavailable) it builds synchronously and returns the geometry itself.
//
// At high speed a pooled screw model represents a new segment every few frames, so requests are kept
// in a queue here rather than in the workers': each worker gets IN_FLIGHT at a time (so that it is
// not left idle while the main thread renders, before it can be given the next), the most urgent
// first (priority, worked out when a worker is free), and a request that is no longer wanted (its
// screw has gone past, or its model has moved on) is dropped before it is started.
const MAX_WORKERS = 6
const IN_FLIGHT = 2

let workers = null
let nextId = 1
const queue = []            // waiting requests: { id, args, priority(), wanted(), resolve, reject }
const running = new Map()   // id -> { resolve, reject, worker }

function workerPool() {
  if (workers !== null) return workers
  workers = []
  if (typeof Worker === 'undefined') return workers
  // Leave a core for the main thread.
  const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1))
  for (let i = 0; i < count; i++) {
    let worker
    try {
      worker = new Worker(new URL('./screwGeometry.worker.js', import.meta.url), { type: 'module' })
    }
    catch {
      break
    }
    worker.inFlight = 0
    worker.onmessage = ({ data }) => {
      const request = running.get(data.id)
      running.delete(data.id)
      worker.inFlight--
      dispatch()
      if (!request) return
      const geometry = new THREE.BufferGeometry()
      geometry.setIndex(new THREE.BufferAttribute(data.index, 1))
      for (const [name, { array, itemSize }] of Object.entries(data.attributes)) {
        geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
      }
      request.resolve(geometry)
    }
    worker.onerror = (event) => {
      // A worker that fails (e.g. module workers unsupported) is dropped; its request is rejected so
      // the caller retries, which builds synchronously once no workers remain.
      console.warn('Screw geometry worker failed; building on the main thread instead.', event.message ?? event)
      workers = workers.filter(w => w !== worker)
      worker.terminate()
      for (const [id, request] of running) {
        if (request.worker === worker) {
          running.delete(id)
          request.reject(new Error('screw geometry worker failed'))
        }
      }
      if (workers.length === 0) {
        for (const request of queue.splice(0)) request.reject(new Error('no screw geometry workers'))
      }
      else dispatch()
    }
    workers.push(worker)
  }
  return workers
}

// Starts the most urgent waiting requests (highest priority, then oldest) on idle workers, after
// dropping those no longer wanted.
function dispatch() {
  if (!workers.some(worker => worker.inFlight < IN_FLIGHT)) return
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!queue[i].wanted()) queue.splice(i, 1)[0].reject(new Error('cancelled'))
  }
  const priorities = new Map(queue.map(request => [request, request.priority()]))
  for (const worker of workers) {
    while (worker.inFlight < IN_FLIGHT && queue.length > 0) {
      let best = 0
      for (let i = 1; i < queue.length; i++) {
        const p = priorities.get(queue[i]), b = priorities.get(queue[best])
        if (p > b || (p === b && queue[i].id < queue[best].id)) best = i
      }
      const request = queue.splice(best, 1)[0]
      worker.inFlight++
      running.set(request.id, { resolve: request.resolve, reject: request.reject, worker })
      worker.postMessage({ id: request.id, args: request.args })
    }
  }
}

// For profiling: requests waiting, and running.
export function screwBuildQueueStats() {
  return { waiting: queue.length, running: running.size, workers: workers?.length ?? 0 }
}

// args: the ScrewGeometry constructor arguments. priority: a number, or a function giving one when a
// worker is free (larger is built sooner). wanted(): false once the build is no longer needed (it is
// then dropped if not started). The returned Promise has cancel(): if the build has not started it
// is dropped and the Promise rejects.
export function buildScrewGeometry(args, { async = true, priority = 0, wanted = () => true } = {}) {
  const pool = async ? workerPool() : []
  if (pool.length === 0) return new ScrewGeometry(...args)
  const id = nextId++
  let request
  const promise = new Promise((resolve, reject) => {
    request = { id, args, priority: typeof priority === 'function' ? priority : () => priority, wanted, resolve, reject }
    queue.push(request)
  })
  promise.cancel = () => {
    const index = queue.indexOf(request)
    if (index === -1) return
    queue.splice(index, 1)
    request.reject(new Error('cancelled'))
  }
  dispatch()
  return promise
}
