import * as THREE from 'three'

// Fractal value noise for the sea (sea floor and sea surface), anchored to the planet so it does not
// slide or jitter. Planet coordinates are ~6.4e6 m, far too large for float32 noise lookups, so each
// mesh passes its own (small) local positions plus per-octave lattice offsets computed in float64:
// (meshOrigin * frequency) mod NOISE_PERIOD. The lattice repeats every NOISE_PERIOD cells, so
// neighbouring meshes with different origins line up seamlessly.
//
// Value noise sits on an axis-aligned grid that shows through as blockiness, so each octave is
// sampled in a differently rotated frame (the same rotation is applied to the mesh origin when its
// offsets are computed, which keeps the noise seamless) and interpolated with a quintic curve.
export const NOISE_PERIOD = 1024

const octaveRotation = (i) => new THREE.Matrix3().setFromMatrix4(
  new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.61 + 1.37 * i, 1.13 + 0.71 * i, 0.29 + 2.11 * i)))

function positiveMod(v, m) {
  const r = v % m
  return r < 0 ? r + m : r
}

// Lattice offsets for a mesh whose local origin is at `origin` (planet coordinates). Writes into
// `targets` (Vector3s) if given, so a uniform array can be updated in place.
const _rotated = new THREE.Vector3()
export function noiseOffsets(origin, frequencies, targets = frequencies.map(() => new THREE.Vector3())) {
  frequencies.forEach((f, i) => {
    _rotated.copy(origin).applyMatrix3(octaveRotation(i))
    targets[i].set(
      positiveMod(_rotated.x * f, NOISE_PERIOD),
      positiveMod(_rotated.y * f, NOISE_PERIOD),
      positiveMod(_rotated.z * f, NOISE_PERIOD))
  })
  return targets
}

// GLSL declaring `uniform vec3 <prefix>Offset[n]` and `float <prefix>Fbm(vec3 local, float viewDistance)`,
// fractal noise in [-1, 1] whose octaves fade out as their wavelength shrinks below a few pixels
// (so it never shimmers). local: the mesh-local position; viewDistance: distance to the camera (m).
export function fbmGlsl(prefix, frequencies, { persistence = 0.6 } = {}) {
  const n = frequencies.length
  return `
uniform vec3 ${prefix}Offset[${n}];
const float ${prefix}Freq[${n}] = float[](${frequencies.map(f => f.toExponential(6)).join(', ')});
const mat3 ${prefix}Rotation[${n}] = mat3[](${frequencies.map((f, i) => `mat3(${octaveRotation(i).elements.map(e => e.toFixed(8)).join(', ')})`).join(', ')});

float ${prefix}Hash(vec3 p) {
  p = mod(p, ${NOISE_PERIOD.toFixed(1)});
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float ${prefix}Noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(mix(${prefix}Hash(i), ${prefix}Hash(i + vec3(1, 0, 0)), f.x),
                 mix(${prefix}Hash(i + vec3(0, 1, 0)), ${prefix}Hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(${prefix}Hash(i + vec3(0, 0, 1)), ${prefix}Hash(i + vec3(1, 0, 1)), f.x),
                 mix(${prefix}Hash(i + vec3(0, 1, 1)), ${prefix}Hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float ${prefix}Fbm(vec3 local, float viewDistance) {
  float sum = 0.0, weight = 0.0, amplitude = 1.0;
  for (int i = 0; i < ${n}; i++) {
    // ~1000 px per radian: an octave's wavelength in pixels at this distance.
    float wavelengthPixels = 1000.0 / (${prefix}Freq[i] * viewDistance);
    float visible = smoothstep(2.0, 6.0, wavelengthPixels);
    sum += amplitude * visible * (${prefix}Noise(${prefix}Rotation[i] * local * ${prefix}Freq[i] + ${prefix}Offset[i]) * 2.0 - 1.0);
    weight += amplitude;
    amplitude *= ${persistence.toFixed(2)};
  }
  return sum / weight;
}
`
}

// Sea surface ripples: metre-scale (real water rarely has larger features outside storms). From a
// distance the octaves fade out, so the surface averages to a faint, even sheen.
export const SEA_SURFACE_FREQUENCIES = [1 / 12, 1 / 4, 1 / 1.3, 1 / 0.4]

// GLSL for the sea surface's look from either side. seaSurfaceShade(color, ripple, facing, shine)
// returns the fragment's colour and opacity, given its base colour, its ripple noise in [-1, 1] and
// how directly it is viewed (|cos| of the angle between the view direction and the surface normal);
// `shine` (0..1) is how much reflected sky it shows, for lit materials to add as emitted light.
// Mostly clear when looked into, more opaque at grazing angles (Fresnel), and with pale highlights on
// the ripple crests (reflected sky), so the surface, and how far away it is, can always be made out
// against dark water.
export function seaSurfaceLookGlsl(baseOpacity, highlight = [0.62, 0.72, 0.78]) {
  return `
const vec3 seaSurfaceHighlight = vec3(${highlight.map(c => c.toFixed(3)).join(', ')});

vec4 seaSurfaceShade(vec3 color, float ripple, float facing, out float shine) {
  float fresnel = pow(1.0 - clamp(facing, 0.0, 1.0), 4.0);
  // Highlights only on the crests (the fractal noise rarely strays far from 0, so they are scaled
  // up); where the ripples are too small to see, ripple -> 0 and only a faint sheen remains.
  float crest = clamp(1.2 * ripple, 0.0, 1.0);
  shine = clamp(0.25 * crest * crest + 0.08 * fresnel, 0.0, 1.0);
  vec3 shaded = mix(color * (1.0 + 0.12 * ripple), seaSurfaceHighlight, shine);
  float opacity = mix(${baseOpacity.toFixed(3)}, 0.35, fresnel) + 0.2 * shine * (1.0 - fresnel);
  return vec4(shaded, clamp(opacity, 0.0, 1.0));
}
`
}
