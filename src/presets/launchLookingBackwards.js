import * as THREE from 'three'
import { actualSizeDollyShot } from './actualSizeDollyShot.js'
import { toMarsFromEarthLauncherArchitecture } from './toAFromBLauncherArchitecture.js'
import { planetSetup } from './planetSetup.js'

export function launchLookingBackwards(guidParamWithUnits, nonGUIParams) {

  // Uses Monna Kea launch location
  guidParamWithUnits['finalLocationRingCenterLatitude'].value = 74.34
  guidParamWithUnits['finalLocationRingCenterLongitude'].value = 203
  guidParamWithUnits['evacuatedTubeEntrancePositionAroundRing'].value =  0.681

  // Mauna Kea (19.820667, -155.468056)
  const launcherRampEndLatitude = 19.820667 // °N (Hawaii Big Island)
  const launcherRampEndLongitude = -155.468056 + .048056 // moving the end of the ramp a little bit east 
  const massDriverAltitude = -50 // m (below sea level: the tube is submerged and moored to the sea floor)
  const rampExitAltitude = 4500 // m  (Altitute of Mauna Kea summit (4207) plus ~300 meters which is an engineered truss structure that can be stowed underground when not in use)
  toMarsFromEarthLauncherArchitecture(guidParamWithUnits, launcherRampEndLatitude, launcherRampEndLongitude, massDriverAltitude, rampExitAltitude)

  guidParamWithUnits['launcherMassDriverScrewNumBrackets'].value = 300 // Limit the number of brackets since they temporarily alias
  
  guidParamWithUnits['numLaunchesPerMarsTransferSeason'].value = 14*4 // 14 days, four lauches per day
  guidParamWithUnits['numberOfMarsTransferSeasons'].value = 10

  // Grappler Parameters
  guidParamWithUnits['adaptiveNutNumGrapplers'].value = 64
  guidParamWithUnits['adaptiveNutGrapplerMagnetThickness'].value = 0.06  // m

  // Hawaii
  // The Big Island's high-resolution bake (see planetSetup.js).
  planetSetup(nonGUIParams, { assets: ['earth', 'hawaii'] })

  actualSizeDollyShot(guidParamWithUnits, nonGUIParams)
  guidParamWithUnits['showStars'].value = true
  guidParamWithUnits['launcherCoastTime'].value = 100*20
  guidParamWithUnits['launcherSlowDownPassageOfTime'].value = 10
  guidParamWithUnits['trackingMode'].value = 1
  guidParamWithUnits['logZoomRate'].value = -3

  // Hack to speed up the simulation
  // guidParamWithUnits['showMassDriverAccelerationScrews'].value = false
  // guidParamWithUnits['showMassDriverBrackets'].value = false

  // Camera infront of the launch vehicle inside the tube
  nonGUIParams['orbitControlsTarget'] = new THREE.Vector3(0, 0, 0)
  nonGUIParams['orbitControlsUpDirection'] = new THREE.Vector3(-0.26486255382392027, 0.3356270981801784, -0.9039924106700366)
  nonGUIParams['orbitControlsObjectPosition'] = new THREE.Vector3(-131.41884332499467, 7.06073940731585, 39.23605372570455)
  nonGUIParams['cameraUp'] = new THREE.Vector3(-0.26486255382392027, 0.3356270981801784, -0.9039924106700366)
  guidParamWithUnits['cameraFieldOfView'].value = 30
  guidParamWithUnits['massDriverCameraRange'].value = 1000

}