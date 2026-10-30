import * as THREE from 'three'
import { PixelLOD } from '../scene/PixelLOD.js'

const CHUNK_POINTS = 128
const MIN_SAMPLES = 64
const MAX_SAMPLES = 3000
const SAMPLES_PER_SECOND = 20
const REBUILD_INTERVAL_MS = 150
const MARKER_PX = 9
const GIZMO_PX = 46

const _position = new THREE.Vector3()
const _target = new THREE.Vector3()
const _up = new THREE.Vector3()
const _matrix = new THREE.Matrix4()
const _viewer = new THREE.Vector3()

// Draws a shot in the scene for the free view: the path of the shot camera (each point where the
// camera is at that moment of the shot, so a path tied to a vehicle follows the vehicle's real
// trajectory), the path of what it looks at, a marker at each keyframe, and the shot camera itself at
// the playhead. Never shown in the shot camera's view or in recordings.
//
// Lines are split into chunks, each relative to its first point, so they keep their precision at
// planet scale (see "Floating-point precision" in docs/ARCHITECTURE.md). Markers keep a constant
// size on screen.
export class ShotPathOverlay {
  constructor(shots) {
    this.shots = shots
    this.group = new THREE.Group()
    this.group.name = 'shotPathOverlay'
    this.group.visible = false
    this.builtRevision = -1
    this.dirty = true
    this.lastBuild = 0

    const lineMaterial = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    this.pathMaterial = lineMaterial(0xffc040, 0.95)
    this.targetMaterial = lineMaterial(0x40c8ff, 0.55)
    this.sightMaterial = lineMaterial(0xffffff, 0.5)
    this.paths = new THREE.Group()
    this.markers = new THREE.Group()
    this.group.add(this.paths, this.markers)

    this.markerGeometry = new THREE.OctahedronGeometry(1, 0)
    this.markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, transparent: true, opacity: 0.9 })
    this.selectedMaterial = new THREE.MeshBasicMaterial({ color: 0xff7020, depthWrite: false, transparent: true, opacity: 0.95 })

    this.gizmo = this.createGizmo()
    this.sightLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), this.sightMaterial)
    this.sightLine.frustumCulled = false
    this.group.add(this.gizmo, this.sightLine)
  }

  // A camera: a pyramid from the eye to a frame 1 unit in front, with a triangle marking "up".
  createGizmo() {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3 * 2), 3))
    const gizmo = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xff7020, depthWrite: false, transparent: true }))
    gizmo.frustumCulled = false
    gizmo.matrixAutoUpdate = false
    return gizmo
  }

  setGizmoShape(fov, aspect) {
    if (this.gizmoShape === `${fov}/${aspect}`) return
    this.gizmoShape = `${fov}/${aspect}`
    const h = Math.tan(THREE.MathUtils.degToRad(fov) / 2)
    const w = h * aspect
    const c = [[-w, -h, -1], [w, -h, -1], [w, h, -1], [-w, h, -1]]
    const segments = []
    for (let i = 0; i < 4; i++) segments.push([0, 0, 0], c[i], c[i], c[(i + 1) % 4])
    segments.push([-w * 0.5, h * 1.1, -1], [0, h * 1.5, -1], [0, h * 1.5, -1], [w * 0.5, h * 1.1, -1])
    const attribute = this.gizmo.geometry.getAttribute('position')
    segments.forEach((p, i) => attribute.setXYZ(i, p[0], p[1], p[2]))
    attribute.needsUpdate = true
  }

  invalidate() {
    this.dirty = true
  }

  disposePaths() {
    for (const child of [...this.paths.children]) {
      child.geometry.dispose()
      this.paths.remove(child)
    }
  }

  // Lines through a list of world points, in chunks relative to their first points.
  addLine(points, material) {
    for (let start = 0; start < points.length - 1; start += CHUNK_POINTS - 1) {
      const chunk = points.slice(start, start + CHUNK_POINTS)
      const origin = chunk[0]
      const array = new Float32Array(chunk.length * 3)
      chunk.forEach((p, i) => {
        array[3 * i] = p[0] - origin[0]
        array[3 * i + 1] = p[1] - origin[1]
        array[3 * i + 2] = p[2] - origin[2]
      })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(array, 3))
      geometry.computeBoundingSphere()
      const line = new THREE.Line(geometry, material)
      line.position.set(origin[0], origin[1], origin[2])
      this.paths.add(line)
    }
  }

  rebuild() {
    const shots = this.shots
    this.disposePaths()
    const keys = shots.keyframes
    this.builtRevision = shots.revision
    this.dirty = false
    this.lastBuild = performance.now()
    // Keyframe markers
    for (const child of [...this.markers.children]) this.markers.remove(child)
    keys.forEach((key, i) => {
      const pose = shots.keyframePose(i)
      const marker = new THREE.Mesh(this.markerGeometry, i === shots.selected ? this.selectedMaterial : this.markerMaterial)
      marker.position.fromArray(pose.position)
      marker.userData.keyIndex = i
      this.markers.add(marker)
    })
    if (keys.length < 2) return
    // Paths over the whole shot
    const duration = shots.duration
    const samples = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.ceil(duration * SAMPLES_PER_SECOND)))
    const positions = []
    const targets = []
    for (let i = 0; i <= samples; i++) {
      const pose = shots.poseAt(duration * i / samples)
      if (!pose) continue
      positions.push(pose.position)
      targets.push(pose.target)
    }
    this.addLine(positions, this.pathMaterial)
    this.addLine(targets, this.targetMaterial)
  }

  // Called every displayed frame before rendering.
  update(camera) {
    const shots = this.shots
    const visible = shots.prefs.showPath && shots.mode === 'idle' && shots.viewMode === 'free' && shots.keyframes.length > 0
    this.group.visible = visible
    if (!visible) return
    const stale = this.dirty || this.builtRevision !== shots.revision
    if (stale && performance.now() - this.lastBuild > REBUILD_INTERVAL_MS) this.rebuild()

    camera.getWorldPosition(_viewer)
    const pixelsPerRadian = camera.projectionMatrix.elements[5] * PixelLOD.viewportHeight / 2
    const sizeAt = (p, px) => Math.max(1e-3, p.distanceTo(_viewer) * px / pixelsPerRadian)
    for (const marker of this.markers.children) {
      marker.scale.setScalar(sizeAt(marker.position, MARKER_PX))
      marker.material = marker.userData.keyIndex === shots.selected ? this.selectedMaterial : this.markerMaterial
    }

    // The shot camera at the playhead.
    const pose = shots.poseAt(shots.playhead)
    if (!pose) return
    _position.fromArray(pose.position)
    _target.fromArray(pose.target)
    _up.fromArray(pose.up)
    this.setGizmoShape(pose.fov ?? camera.fov, shots.shot.output.width / shots.shot.output.height)
    _matrix.lookAt(_position, _target, _up)
    const scale = sizeAt(_position, GIZMO_PX)
    this.gizmo.matrix.copy(_matrix).scale(new THREE.Vector3(scale, scale, scale)).setPosition(_position)
    this.gizmo.matrixWorldNeedsUpdate = true
    // Line of sight from the shot camera to its target (relative to the camera, for precision).
    const attribute = this.sightLine.geometry.getAttribute('position')
    attribute.setXYZ(0, 0, 0, 0)
    attribute.setXYZ(1, _target.x - _position.x, _target.y - _position.y, _target.z - _position.z)
    attribute.needsUpdate = true
    this.sightLine.position.copy(_position)
  }
}
