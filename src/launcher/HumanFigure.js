// HumanFigure.js
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { VirtualObject, markShared } from './VirtualObject.js'

// Loads a scale figure once and hands out lightweight clones. Clones requested before the FBX has
// finished loading are empty groups that are filled in when it arrives (they used to stay invisible
// until their wedge was recycled).
export class humanFigureModel extends THREE.Group {
  constructor({ url = '/models/Low_Poly_Human_V2.fbx', scale = 1.75 } = {}) {
    super()
    this.loadedFigure = null
    this.pendingModels = new Set()
    this.url = url
    this.figureHeight = scale
    this.loading = false
  }

  ensureLoading() {
    if (this.loading) return
    this.loading = true
    const url = this.url
    const scale = this.figureHeight
    const loader = new FBXLoader()
    loader.load(
      url,
      (fbx) => {
        const model = fbx
        // Normalize to ~1.75m height
        const box = new THREE.Box3().setFromObject(model)
        const height = box.max.y - box.min.y
        const factor = (height > 0) ? scale / height : 1
        model.scale.setScalar(factor)
        markShared(model)  // every clone shares the loaded geometry and materials
        this.loadedFigure = model
        this.add(model)
        this.pendingModels.forEach(group => group.add(model.clone()))
        this.pendingModels.clear()
      },
      undefined,
      (err) => {
        console.error('Error loading human figure:', err)
      }
    )
  }

  createModel(/* curve, index */) {
    this.ensureLoading()
    const group = new THREE.Group()
    if (this.loadedFigure) group.add(this.loadedFigure.clone())
    else this.pendingModels.add(group)
    return group
  }

  forget(model) {
    this.pendingModels.delete(model)
  }
}


export class virtualHumanFigure extends VirtualObject {
  constructor(d, index) {
    super()
    this.d = d
    this.index = index
  }

  static unallocatedModels = []
  static className = 'virtualHumanFigures'
  static modelsAreRecyleable = false
  static isDynamic = false

  static isTeardownRequired(dParamWithUnits) {
    const newNumObjects = dParamWithUnits['showMassDriverTube'].value ? dParamWithUnits['numVirtualHumanFigures'].value : 0
    return newNumObjects!==virtualHumanFigure.numObjects
  }

  static update(dParamWithUnits, versionNumber) {
    virtualHumanFigure.numObjects = dParamWithUnits['showMassDriverTube'].value ? dParamWithUnits['numVirtualHumanFigures'].value : 0
    virtualHumanFigure.isVisible = dParamWithUnits['showMassDriverTube'].value
    virtualHumanFigure.isDynamic = false
    virtualHumanFigure.hasChanged = true
    virtualHumanFigure.versionNumber = versionNumber
  }

  static releaseModel(model) {
    if (virtualHumanFigure.modelFactory?.forget) virtualHumanFigure.modelFactory.forget(model)
    super.releaseModel(model)
  }

  static addNewVirtualObjects(refFrames) {
    virtualHumanFigure.addEvenlySpacedObjects(refFrames)
  }

  placeAndOrientModel(om, refFrame) {
    this.placeAtD(om, refFrame)
  }
}
