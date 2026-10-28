// Interpolates a shot's camera keyframes at an arbitrary time.
//
// 'smooth' uses a centripetal-style Catmull-Rom spline parameterised by the keyframe *times*
// (Barry-Goldman form), so the camera passes through every keyframe exactly when it was set and
// moves without speed jumps. 'linear' is used for densely sampled paths recorded from a live take.
// All arithmetic is on plain JS numbers (float64), so world coordinates of ~6.4e6 m keep
// sub-millimetre precision.

function lerp3(a, b, u) {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

// Catmull-Rom between p1 and p2 with knot times t0..t3 (non-uniform), evaluated at time t.
function catmullRom3(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const mix = (a, b, ta, tb) => (tb === ta ? a : lerp3(a, b, (t - ta) / (tb - ta)))
  const a1 = mix(p0, p1, t0, t1)
  const a2 = mix(p1, p2, t1, t2)
  const a3 = mix(p2, p3, t2, t3)
  const b1 = mix(a1, a2, t0, t2)
  const b2 = mix(a2, a3, t1, t3)
  return mix(b1, b2, t1, t2)
}

export function sampleCameraPath(camera, t) {
  const keys = camera.keyframes
  if (!keys.length) return null
  if (keys.length === 1 || t <= keys[0].time) return { ...keys[0] }
  const last = keys[keys.length - 1]
  if (t >= last.time) return { ...last }

  let i = 1
  while (keys[i].time <= t) i++
  const k1 = keys[i - 1]
  const k2 = keys[i]
  const span = k2.time - k1.time
  const u = span > 0 ? (t - k1.time) / span : 0
  const fov = (k1.fov ?? k2.fov) + ((k2.fov ?? k1.fov) - (k1.fov ?? k2.fov)) * u
  const up = normalize3(lerp3(k1.up, k2.up, u))
  const orbitUp = normalize3(lerp3(k1.orbitUp ?? k1.up, k2.orbitUp ?? k2.up, u))

  if (camera.interpolation === 'linear' || keys.length < 3) {
    return { time: t, position: lerp3(k1.position, k2.position, u), target: lerp3(k1.target, k2.target, u), up, orbitUp, fov }
  }
  // Mirror the end keyframes so the spline has neighbours at both ends.
  const k0 = keys[i - 2] ?? { ...k1, time: k1.time - span, position: lerp3(k2.position, k1.position, 2), target: lerp3(k2.target, k1.target, 2) }
  const k3 = keys[i + 1] ?? { ...k2, time: k2.time + span, position: lerp3(k1.position, k2.position, 2), target: lerp3(k1.target, k2.target, 2) }
  return {
    time: t,
    position: catmullRom3(k0.position, k1.position, k2.position, k3.position, k0.time, k1.time, k2.time, k3.time, t),
    target: catmullRom3(k0.target, k1.target, k2.target, k3.target, k0.time, k1.time, k2.time, k3.time, t),
    up,
    orbitUp,
    fov,
  }
}
