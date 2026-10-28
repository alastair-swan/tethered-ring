import * as THREE from 'three'

// A full-screen background image (a still, or one frame of a Google Earth Studio video) drawn
// behind the 3D scene, for compositing the simulation over real imagery. While it is shown the
// planet is hidden so the imagery shows through.
export class backgroundScene {
  constructor(width, height, backgroundTexture) {
    this.hiddenObjects = []
    if (!backgroundTexture) return
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 1, 100)
    this.camera.position.z = 10
    this.scene.add(this.camera)
    this.backgroundMaterial = new THREE.MeshBasicMaterial({ map: backgroundTexture })
    this.sprite = new THREE.Sprite(this.backgroundMaterial)
    this.sprite.scale.set(backgroundTexture.source.data.naturalWidth, backgroundTexture.source.data.naturalHeight, 1)
    this.scene.add(this.sprite)
  }

  get preserveVisibility() { return this.hiddenObjects }

  // Hides the given root objects, remembering their previous visibility. Calling it again while
  // already hidden keeps the original state, so restorePlanet() always restores what was visible.
  hidePlanet(objectList) {
    for (const object of objectList) {
      if (!object || this.hiddenObjects.some(h => h.object === object)) continue
      this.hiddenObjects.push({ object, visible: object.visible })
      object.visible = false
    }
  }

  restorePlanet() {
    for (const { object, visible } of this.hiddenObjects) object.visible = visible
    this.hiddenObjects = []
  }

  remove() {
    this.backgroundMaterial?.dispose()
    this.scene = null
    this.camera = null
    this.sprite = null
  }
}
