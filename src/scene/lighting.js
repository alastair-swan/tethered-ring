import * as THREE from 'three'

// How far out the (directional) sun light is placed; only its direction matters.
const SUN_DISTANCE = 1e9
// Local shadows (enableLocalShadows): the shadow frustum's half-width and how far towards the sun its
// camera is placed (m).
const LOCAL_SHADOW_EXTENT = 40
const LOCAL_SHADOW_DISTANCE = 200

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
    this.renderer = renderer
    this.localShadows = false
    this.localFocus = new THREE.Vector3()
    this.sunDirection = this.sunLight.position.clone().normalize() // towards the sun (world axes)
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

  // Points the sun along `worldDirection` (towards the sun, world axes); `planetDirection` is the same
  // in the planet frame, for the shadow-casting set-up, which lives there.
  setSunDirection(worldDirection, planetDirection) {
    if (this.shadowTarget) {
      this.shadowDirection.copy(planetDirection).normalize()
      return
    }
    this.sunDirection.copy(worldDirection).normalize()
    this._placeSun()
  }

  _placeSun() {
    if (this.localShadows) {
      this.sunLight.position.copy(this.localFocus).addScaledVector(this.sunDirection, LOCAL_SHADOW_DISTANCE)
      this.sunLight.target.position.copy(this.localFocus)
    }
    else {
      this.sunLight.position.copy(this.sunDirection).multiplyScalar(SUN_DISTANCE)
      this.sunLight.target.position.set(0, 0, 0)
    }
    this.sunLight.updateMatrixWorld()
    this.sunLight.target.updateMatrixWorld()
  }

  /**
   * Shadows in a small area (LOCAL_SHADOW_EXTENT around a focus point, setLocalShadowFocus) for
   * metre-scale things that ask for them (sailboats): only objects that cast and receive shadows are
   * affected. Not with a preset's surface shadows (enableSurfaceShadows), which use the sun already.
   * Receivers far from the world origin must look the shadow up in their own local frame (see
   * Sailboats.js): the shadow map is drawn precisely, but three.js looks it up from float32 world
   * positions, which are only good to ~0.5 m at planet scale.
   */
  enableLocalShadows() {
    if (this.shadowTarget || this.sunLight.castShadow) return false
    const sun = this.sunLight
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, {
      left: -LOCAL_SHADOW_EXTENT, right: LOCAL_SHADOW_EXTENT, top: LOCAL_SHADOW_EXTENT, bottom: -LOCAL_SHADOW_EXTENT,
      near: 1, far: 2 * LOCAL_SHADOW_DISTANCE,
    })
    sun.shadow.camera.updateProjectionMatrix()
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = 0.02
    this.localShadows = true
    this._placeSun()
    return true
  }

  /** The centre of the local shadows (world axes). */
  setLocalShadowFocus(worldPoint) {
    if (!this.localShadows) return
    this.localFocus.copy(worldPoint)
    this._placeSun()
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
