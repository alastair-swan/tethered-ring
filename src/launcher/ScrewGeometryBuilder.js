import * as THREE from 'three'
import { ScrewGeometry } from './ScrewGeometry.js'

// Screw segments stream past quickly when the camera follows a launch vehicle, and building their
// geometry on the main thread made frames stutter and screws show up late. buildScrewGeometry() hands
// the work to a small pool of Web Workers and returns a Promise of the geometry; with async false (or
// where workers are unavailable) it builds synchronously and returns the geometry itself.
const MAX_WORKERS = 4

let workers = null
let nextId = 1
const requests = new Map() // id -> { resolve, reject, worker }

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
    worker.queued = 0
    worker.onmessage = ({ data }) => {
      const request = requests.get(data.id)
      requests.delete(data.id)
      worker.queued--
      if (!request) return
      const geometry = new THREE.BufferGeometry()
      geometry.setIndex(new THREE.BufferAttribute(data.index, 1))
      for (const [name, { array, itemSize }] of Object.entries(data.attributes)) {
        geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
      }
      request.resolve(geometry)
    }
    worker.onerror = (event) => {
      // A worker that fails (e.g. module workers unsupported) is dropped; its requests are rejected so
      // callers retry, which builds synchronously once no workers remain.
      console.warn('Screw geometry worker failed; building on the main thread instead.', event.message ?? event)
      workers = workers.filter(w => w !== worker)
      worker.terminate()
      for (const [id, request] of requests) {
        if (request.worker === worker) {
          requests.delete(id)
          request.reject(new Error('screw geometry worker failed'))
        }
      }
    }
    workers.push(worker)
  }
  return workers
}

// args: the ScrewGeometry constructor arguments.
export function buildScrewGeometry(args, { async = true } = {}) {
  const pool = async ? workerPool() : []
  if (pool.length === 0) return new ScrewGeometry(...args)
  const worker = pool.reduce((a, b) => (a.queued <= b.queued ? a : b))
  const id = nextId++
  worker.queued++
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject, worker })
    worker.postMessage({ id, args })
  })
}
