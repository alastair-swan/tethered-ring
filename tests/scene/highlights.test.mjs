import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Highlights, HIGHLIGHT_CLASSES } from '../../src/scene/Highlights.js'

const params = (on) => Object.fromEntries(HIGHLIGHT_CLASSES.map(c => [c.param, { value: on.includes(c.key) }]))
const mesh = () => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())

test('collect: tags apply to subtrees, the nearest tag wins, hidden subtrees are skipped', () => {
  const scene = new THREE.Scene()
  const tube = Highlights.tag(new THREE.Group(), 'massDriver')
  const tubeMesh = mesh()
  const mooring = Highlights.tag(new THREE.Group(), 'massDriverTethers')
  const cable = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
  const hidden = new THREE.Group()
  hidden.visible = false
  const hiddenMesh = mesh()
  const untagged = mesh()
  tube.add(tubeMesh, mooring, hidden)
  mooring.add(cable)
  hidden.add(hiddenMesh)
  scene.add(tube, untagged)

  const h = new Highlights()
  h.configure(params(['massDriver']))
  h.collect(scene)
  assert.deepEqual(h.objects, [tubeMesh])
  assert.ok(tubeMesh.layers.isEnabled(31))

  h.configure(params(['massDriverTethers']))
  h.collect(scene)
  assert.deepEqual(h.objects, [cable])
  assert.ok(!tubeMesh.layers.isEnabled(31), 'last frame\'s objects leave the layer')
  assert.ok(tubeMesh.layers.isEnabled(0))

  h.configure(params([]))
  assert.equal(h.active, false)
  assert.ok(!cable.layers.isEnabled(31))
})

test('curve stand-ins are only on the highlight layer', () => {
  const curve = new THREE.LineCurve3(new THREE.Vector3(6.4e6, 0, 0), new THREE.Vector3(6.4e6, 1e5, 0))
  const standIn = Highlights.curveStandIn(curve, 'ring', { chunks: 4, pointsPerChunk: 2 })
  assert.equal(standIn.children.length, 4)
  for (const line of standIn.children) {
    assert.equal(line.layers.mask, 0)
    // Vertices are relative to each chunk's origin.
    const p = line.geometry.attributes.position.array
    assert.ok(Math.max(...p.map(Math.abs)) < 2e4)
  }
})
