import * as THREE from 'three'

// Sun and ambient light. When a preset enables surface shadows, the directional light gets a small,
// dense shadow frustum that is re-centred on the camera target every frame (see updateShadowFocus);
// a planet-sized shadow map would be far too coarse for metre-scale vehicles.
export class Lighting {
  constructor(scene, planetCoordSys, nonGUIParams, planetRadius, renderer) {
    this.sunLight = new THREE.DirectionalLight(0xffffff, nonGUIParams.sunLightIntensity ?? 1)
    this.sunLight.name = 'sunlight'
    if (nonGUIParams.sunLightPosition) this.sunLight.position.copy(nonGUIParams.sunLightPosition)
    else this.sunLight.position.set(0, -6 * planetRadius / 8, -20 * planetRadius / 8)

    this.shadowTarget = null
    this.shadowDirection = new THREE.Vector3()
    this._focus = new THREE.Vector3()
    this.planetCoordSys = planetCoordSys

    if (nonGUIParams.enableSurfaceShadows === true) {
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = nonGUIParams.softSurfaceShadows === true ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap
      const sun = this.sunLight
      sun.castShadow = true
      const extent = nonGUIParams.surfaceShadowExtent ?? 10000
      const mapSize = nonGUIParams.surfaceShadowMapSize ?? 4096
      sun.shadow.mapSize.set(mapSize, mapSize)
      Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: nonGUIParams.surfaceShadowFar ?? 500000 })
      sun.shadow.bias = -0.000001
      sun.shadow.normalBias = 0.03
      if (nonGUIParams.sunLightTarget) {
        this.shadowTarget = new THREE.Object3D()
        this.shadowTarget.name = 'sunlightTarget'
        this.shadowTarget.position.copy(nonGUIParams.sunLightTarget)
        sun.target = this.shadowTarget
        this.shadowDirection.copy(sun.position).sub(this.shadowTarget.position).normalize()
      }
      sun.shadow.camera.updateProjectionMatrix()
      // Launch geometry and the planet live in planetCoordSys, so the localised light must too.
      planetCoordSys.add(sun)
      if (this.shadowTarget) planetCoordSys.add(this.shadowTarget)
    }
    else {
      scene.add(this.sunLight)
    }

    this.ambientLight = new THREE.AmbientLight(0xffffff, nonGUIParams.ambientLightIntensity ?? 2)
    this.ambientLight.name = 'ambientLight'
    scene.add(this.ambientLight)
  }

  // Points the shadow frustum at a fixed solar direction from a new focus point (planet frame).
  setShadowFocus(pointInPlanetFrame, direction = this.shadowDirection) {
    if (!this.shadowTarget) return
    this.shadowDirection.copy(direction).normalize()
    this.shadowTarget.position.copy(pointInPlanetFrame)
    this.sunLight.position.copy(pointInPlanetFrame).addScaledVector(this.shadowDirection, 300000)
    this.shadowTarget.updateMatrixWorld()
    this.sunLight.updateMatrixWorld()
  }

  // Called every frame with the camera target (world coordinates).
  followCameraTarget(worldTarget) {
    if (!this.shadowTarget) return
    this.planetCoordSys.updateWorldMatrix(true, false)
    this._focus.copy(worldTarget)
    this.planetCoordSys.worldToLocal(this._focus)
    this.setShadowFocus(this._focus)
  }
}
