import * as THREE from 'three'
import { XYChart } from './XYChart.js'

// Screen-space overlays drawn after the 3D scene with an orthographic camera in pixel units:
// the project logo (top-left) and the launch telemetry chart.
export class Overlays {
  constructor(width, height) {
    this.scene = new THREE.Scene()
    this.scene.name = 'sceneOrtho'
    this.camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 1, 10)
    this.camera.position.z = 10
    this.width = width
    this.height = height

    this.logoSprite = null
    this.logoVisible = false

    this.xyChart = new XYChart()
    const chart = this.xyChart
    chart.setWidth(1000)
    chart.setHeight(600)
    chart.setMinX(0)
    chart.setMinY(0)
    chart.setMaxX(300)
    chart.setMaxY(160)
    chart.setMajorX(100)
    chart.setMajorY(10)
    chart.setMinorX(10)
    chart.setMinorY(10)
    chart.setLegendPosition(1600 - 400, 0)
    chart.name = 'xyChart'
    this.scene.add(chart)
  }

  loadLogo(url) {
    new THREE.TextureLoader().load(url, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.minFilter = THREE.LinearMipmapLinearFilter
      texture.magFilter = THREE.LinearFilter
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }))
      sprite.scale.set(texture.image.width, texture.image.height, 1)
      this.logoSprite = sprite
      this.scene.add(sprite)
      this.layout()
    })
  }

  setLogoVisible(visible) {
    this.logoVisible = visible
    if (this.logoSprite) this.logoSprite.visible = visible
  }

  setChartVisible(visible) {
    this.xyChart.visible = visible
  }

  resize(width, height) {
    this.width = width
    this.height = height
    Object.assign(this.camera, { left: -width / 2, right: width / 2, top: height / 2, bottom: -height / 2 })
    this.camera.updateProjectionMatrix()
    this.layout()
  }

  layout() {
    const { width, height, xyChart } = this
    if (this.logoSprite) {
      const s = this.logoSprite.scale
      this.logoSprite.position.set(-width / 2 + s.x / 2, height / 2 - s.y / 2, 1)
      this.logoSprite.visible = this.logoVisible
    }
    xyChart.position.set(-width / 2 + 0.15 * xyChart.width / 2, height / 2 - 1.15 * xyChart.height, 1)
  }

  redrawChartFrame() {
    this.xyChart.drawAxes()
    this.xyChart.drawGridlines()
    this.xyChart.labelAxes('Time (s)', '')
  }

  render(renderer) {
    renderer.render(this.scene, this.camera)
  }
}
