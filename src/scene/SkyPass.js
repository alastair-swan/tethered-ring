import * as THREE from 'three'
import { stars } from './stars.js'

const MOON_ORBIT_DISTANCE = 384467000 // m

// Renders far-away things (stars and the companion body: the Moon, or Earth when the simulation is
// on the Moon) in a separate pass with its own camera, before the main scene.
//
// The main camera's far plane is fitted to the planet and ring so depth precision stays usable;
// anything beyond it (stars at 256 planet radii, the Moon at 384,000 km) used to be clipped. The sky
// camera copies the main camera's orientation and position but has a far plane large enough for
// the solar neighbourhood.
export class SkyPass {
  constructor(dParamWithUnits, planetSpec, { isLunarSimulation, earthRadius }) {
    this.scene = new THREE.Scene()
    this.scene.name = 'skyScene'
    this.camera = new THREE.PerspectiveCamera(45, 1, 1e4, 1e12)
    this.camera.name = 'skyCamera'

    // Mirrors planetCoordSys so sky objects keep their planet-relative placement.
    this.planetFrame = new THREE.Group()
    this.planetFrame.name = 'skyPlanetFrame'
    this.planetFrame.matrixAutoUpdate = false
    this.scene.add(this.planetFrame)

    this.stars = new stars(dParamWithUnits, planetSpec)
    this.scene.add(this.stars)

    const companionRadius = isLunarSimulation ? earthRadius : 1737400
    const texture = new THREE.TextureLoader().load(isLunarSimulation ? './textures/earth_clouds_2048.jpg' : './textures/moon.jpg')
    texture.colorSpace = THREE.SRGBColorSpace
    this.companionBody = new THREE.Mesh(
      new THREE.SphereGeometry(companionRadius, 64, 32),
      new THREE.MeshLambertMaterial({ map: texture }),
    )
    this.companionBody.name = isLunarSimulation ? 'earth' : 'moon'
    this.companionBody.position.set(MOON_ORBIT_DISTANCE, 0, 0)
    this.companionBody.visible = dParamWithUnits.showMoon.value
    this.planetFrame.add(this.companionBody)

    this.sunLight = new THREE.DirectionalLight(0xffffff, 1)
    this.scene.add(this.sunLight)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15))
  }

  // Places the companion body along a direction from the planet centre (planet frame).
  setCompanionBodyDirection(direction, distance = MOON_ORBIT_DISTANCE) {
    this.companionBody.position.copy(direction).normalize().multiplyScalar(distance)
  }

  update(mainCamera, planetCoordSys, sunLight, dParamWithUnits, planetSpec) {
    mainCamera.updateMatrixWorld()
    mainCamera.matrixWorld.decompose(this.camera.position, this.camera.quaternion, this.camera.scale)
    this.camera.fov = mainCamera.fov
    this.camera.aspect = mainCamera.aspect
    this.camera.zoom = mainCamera.zoom
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
    planetCoordSys.updateMatrixWorld()
    this.planetFrame.matrix.copy(planetCoordSys.matrixWorld)
    this.planetFrame.matrixWorldNeedsUpdate = true
    this.sunLight.position.copy(sunLight.getWorldPosition(new THREE.Vector3()))
    this.stars.animate(dParamWithUnits, planetSpec, mainCamera)
  }

  render(renderer) {
    renderer.render(this.scene, this.camera)
  }
}
