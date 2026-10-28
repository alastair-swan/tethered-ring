import { GUI } from 'three/addons/libs/lil-gui.module.min.js'

const FOLDER_ORDER = ['Geography', 'Engineering', 'Launcher', 'Rocket', 'Grapplers', 'Materials', 'Economics', 'Rendering', 'Camera', 'TextOutput']
const FOLDER_TITLES = { Geography: 'Location' }

// Builds the lil-gui panel for a ParameterStore. When a control changes, the parameter's `onChange`
// handler name is looked up in `handlers` and called with the key.
export class ParameterGui {
  constructor(store, handlers, { title = 'Controls', width = 500 } = {}) {
    this.store = store
    this.handlers = handlers
    this.gui = new GUI({ title, width })
    this.gui.close()
    this.folders = {}
    for (const name of FOLDER_ORDER) this.folder(name)

    for (const [key, def] of Object.entries(store.definitions)) {
      const folder = this.folder(def.folder ?? 'Rendering')
      let controller
      if (def.options) {
        controller = folder.add(store.values, key, def.options)
      }
      else if (typeof def.value === 'string' && /^#[0-9a-f]{6}$/i.test(def.value)) {
        controller = folder.addColor(store.values, key)
      }
      else {
        controller = folder.add(store.values, key, def.min, def.max, def.step)
      }
      controller.onChange(() => this.dispatch(key))
    }
  }

  folder(name) {
    if (!this.folders[name]) this.folders[name] = this.gui.addFolder(FOLDER_TITLES[name] ?? name).close()
    return this.folders[name]
  }

  dispatch(key) {
    const name = this.store.definitions[key].onChange
    this.store.derive()
    if (!name) return
    const handler = this.handlers[name]
    if (handler) handler(key)
    else console.warn(`No handler "${name}" for parameter "${key}"`)
  }

  // Refreshes every control after values were changed programmatically.
  refresh() {
    for (const controller of this.gui.controllersRecursive()) controller.updateDisplay()
  }
}
