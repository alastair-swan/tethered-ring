// Builds ScrewGeometry off the main thread (see ScrewGeometryBuilder.js). Receives the constructor's
// arguments and returns the geometry's arrays, transferred rather than copied.
import { ScrewGeometry } from './ScrewGeometry.js'

self.onmessage = ({ data: { id, args } }) => {
  const geometry = new ScrewGeometry(...args)
  const attributes = {}
  const transfer = []
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    attributes[name] = { array: attribute.array, itemSize: attribute.itemSize }
    transfer.push(attribute.array.buffer)
  }
  const index = geometry.index.array
  transfer.push(index.buffer)
  self.postMessage({ id, index, attributes }, transfer)
}
