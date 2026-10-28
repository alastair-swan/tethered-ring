import { Vector3 } from 'three'

// Points along a catenary hanging from `top` to `bottom` (planet coordinates), in the vertical plane
// through both (`up` is the local vertical). shape: the catenary constant as a multiple of the
// distance between the ends (larger = straighter). A cable cannot hang below its anchor (that would
// be under the sea floor), so a shape that would put the lowest point between the ends is
// straightened until the lowest point is at the anchor.
export function catenaryPoints(top, bottom, up, shape, segments = 32) {
  const chord = new Vector3().subVectors(top, bottom)
  const rise = chord.dot(up)                                    // H
  const across = chord.clone().addScaledVector(up, -rise)       // horizontal part
  const span = across.length()                                  // L
  const points = []
  if (span < 1e-6 || !(shape > 0)) {
    for (let i = 0; i <= segments; i++) points.push(bottom.clone().lerp(top, i / segments))
    return points
  }
  across.divideScalar(span)
  // y = a cosh((x - x0) / a) through (0, 0) and (L, H): x0 = L/2 - a asinh(H / (2 a sinh(L / 2a))).
  const lowestPoint = (a) => span / 2 - a * Math.asinh(rise / (2 * a * Math.sinh(span / (2 * a))))
  let a = shape * chord.length()
  if (rise > 0 && lowestPoint(a) > 0) {
    // x0 decreases as a grows: bisect for x0 = 0.
    let lo = a, hi = a
    while (lowestPoint(hi) > 0) hi *= 2
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (lowestPoint(mid) > 0) lo = mid; else hi = mid }
    a = hi
  }
  const x0 = lowestPoint(a)
  const y = (x) => a * Math.cosh((x - x0) / a)
  const y0 = y(0)
  for (let i = 0; i <= segments; i++) {
    const x = span * i / segments
    points.push(bottom.clone().addScaledVector(across, x).addScaledVector(up, y(x) - y0))
  }
  points[segments].copy(top) // exact end (rounding)
  return points
}
