import * as THREE from 'three'
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'

// WebXR controllers (enabled with ?enableVR=true). The right trigger flies forward, the right
// stick flies forward/back and yaws, the left stick pitches and rolls. Motion is applied to the
// camera group, which carries the headset camera and the controllers.
export function setupVRControllers(renderer, cameraGroup) {
  const factory = new XRControllerModelFactory()
  const controllers = [0, 1].map((index) => {
    const controller = renderer.xr.getController(index)
    controller.name = `controller${index + 1}`
    controller.addEventListener('connected', (event) => {
      controller.userData.inputSource = event.data
      controller.add(buildPointer(event.data))
    })
    controller.addEventListener('disconnected', () => {
      controller.userData.inputSource = null
      controller.clear()
    })
    cameraGroup.add(controller)
    const grip = renderer.xr.getControllerGrip(index)
    grip.name = `controllerGrip${index + 1}`
    grip.add(factory.createControllerModel(grip))
    cameraGroup.add(grip)
    return controller
  })

  const direction = new THREE.Vector3()
  const rotation = new THREE.Matrix4()
  return {
    update() {
      controllers.forEach((controller, controllerIndex) => {
        const gamepad = controller.userData.inputSource?.gamepad
        if (!gamepad) return
        rotation.extractRotation(controller.matrixWorld)
        if (controllerIndex === 1 && gamepad.buttons[0]?.pressed) {
          cameraGroup.position.add(direction.set(0, 0, -1000).applyMatrix4(rotation))
        }
        const [, , x = 0, y = 0] = gamepad.axes
        if (controllerIndex === 0) {
          if (x) cameraGroup.rotateZ(x / 100)
          if (y) cameraGroup.rotateX(y / 100)
        }
        else {
          if (x) cameraGroup.rotateY(x / 100)
          if (y) cameraGroup.position.add(direction.set(0, 0, 10 * y).applyMatrix4(rotation))
        }
      })
    },
  }
}

function buildPointer(inputSource) {
  if (inputSource.targetRayMode === 'gaze') {
    const geometry = new THREE.RingGeometry(0.02, 0.04, 32).translate(0, 0, -1)
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true }))
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0, 0, 0], 3))
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending }))
}
