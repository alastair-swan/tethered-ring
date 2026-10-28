import * as THREE from 'three'

const _cameraPosition = new THREE.Vector3()
const _proxyPosition = new THREE.Vector3()
const _relative = new THREE.Matrix4()
const _toOrigin = new THREE.Matrix4()
const _viewProjection = new THREE.Matrix4()
const _frustum = new THREE.Frustum()
const _sphere = new THREE.Sphere()

// Draws many copies of one object with a single InstancedMesh per detail level, while the code that
// places them keeps working with ordinary Object3D "proxies" (added to the scene, positioned, shown
// and hidden as usual). Once per frame, sync() copies every visible proxy's world transform into an
// instance slot of the level its on-screen size calls for.
//
// Precision: the instanced meshes sit at the camera position and each instance matrix is computed
// relative to it in float64 before being stored as float32, so instances near the camera do not
// jitter even though the proxies' world coordinates are ~6.4e6 m.
export class InstancedProxyPool {
  static pools = new Set()

  // levels: [{ geometry, material, minPixels }] (any order). size: object size in metres used for
  // the pixel-size test. parent: object the instanced meshes are added to (world-aligned).
  constructor({ name, levels, size, parent, capacity = 256, castShadow = false }) {
    this.name = name
    this.size = size
    this.parent = parent
    this.castShadow = castShadow
    this.levels = [...levels].sort((a, b) => b.minPixels - a.minPixels)
    this.proxies = []
    this.capacity = 0
    this.meshes = []
    this._allocate(capacity)
    InstancedProxyPool.pools.add(this)
  }

  _allocate(capacity) {
    for (const mesh of this.meshes) { mesh.parent?.remove(mesh); mesh.dispose() }
    this.capacity = capacity
    this.meshes = this.levels.map((level) => {
      const mesh = new THREE.InstancedMesh(level.geometry, level.material, capacity)
      mesh.name = this.name
      mesh.count = 0
      // The instances move every frame relative to this object, so its bounding sphere is never valid.
      mesh.frustumCulled = false
      mesh.castShadow = this.castShadow
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.parent.add(mesh)
      return mesh
    })
  }

  // A stand-in Object3D for one copy. Treat it like a normal model: add it to the scene, set its
  // position/quaternion/scale and visibility.
  createProxy() {
    const proxy = new THREE.Object3D()
    proxy.name = this.name
    proxy.instancedProxyPool = this
    this.proxies.push(proxy)
    return proxy
  }

  static syncAll(camera, viewportHeight) {
    for (const pool of InstancedProxyPool.pools) pool.sync(camera, viewportHeight)
  }

  sync(camera, viewportHeight) {
    camera.updateMatrixWorld()
    _cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    const pixelsPerRadian = camera.projectionMatrix.elements[5] * viewportHeight / 2
    // Copies outside the view are skipped (the instanced meshes themselves cannot be culled).
    _frustum.setFromProjectionMatrix(_viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    _sphere.radius = this.size
    if (this.proxies.length > this.capacity) this._allocate(Math.ceil(this.proxies.length * 1.5))
    for (const mesh of this.meshes) {
      mesh.position.copy(_cameraPosition)
      if (mesh.parent) {
        mesh.parent.updateWorldMatrix(true, false)
        // Keep the mesh at the camera in world space even if its parent is transformed.
        mesh.parent.worldToLocal(mesh.position)
      }
      mesh.updateMatrixWorld()
      mesh.count = 0
    }
    if (!this.meshes.length) return
    // World -> mesh-local (computed once per frame in float64).
    _toOrigin.copy(this.meshes[0].matrixWorld).invert()
    for (const proxy of this.proxies) {
      if (!proxy.parent || !isShown(proxy)) continue
      proxy.updateWorldMatrix(true, false)
      _proxyPosition.setFromMatrixPosition(proxy.matrixWorld)
      _sphere.center.copy(_proxyPosition)
      if (!_frustum.intersectsSphere(_sphere)) continue
      const pixels = this.size / Math.max(1e-3, _proxyPosition.distanceTo(_cameraPosition)) * pixelsPerRadian
      const level = this.levels.findIndex(l => pixels >= l.minPixels)
      if (level === -1) continue
      const mesh = this.meshes[level]
      _relative.multiplyMatrices(_toOrigin, proxy.matrixWorld)
      mesh.setMatrixAt(mesh.count++, _relative)
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    for (const mesh of this.meshes) { mesh.parent?.remove(mesh); mesh.dispose() }
    this.meshes = []
    this.proxies = []
    InstancedProxyPool.pools.delete(this)
  }
}

function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false
  return true
}
