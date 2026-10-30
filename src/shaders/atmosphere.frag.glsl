// The sky: the light the air scatters towards the camera along each line of sight through it (between
// the top of the shell and the ground), by the model in atmosphereCommon.glsl. The output is the
// scattered light, and the background (stars, the sun's disc in the sky pass) is dimmed by the air's
// transmittance. Lines of sight that reach the ground are left to the ground's own haze
// (aerialPerspective.js).
//
// Geometry: solved against the ellipsoid by stretching space along the polar axis (atmoPole.w =
// a/b - 1), which turns it into a sphere of radius a; relative to the camera, with |C'|^2 - r^2 (small
// differences of huge numbers) computed in float64 on the CPU (Planet.updateAtmosphere), and with
// numerically stable roots. The output is premultiplied: colour + background * (1 - alpha).
#include <common>
#include <logdepthbuf_pars_fragment>
#include <atmosphere_common>

uniform vec4 atmoCamera;   // xyz: stretched camera position relative to the planet centre (world axes); w: |C'|^2 - top^2
uniform vec4 atmoPole;     // xyz: polar axis (world); w: a/b - 1
uniform vec4 atmoParams;   // x: |C'|^2 - a^2 (ground); y: exposure; z: a (m); w: top radius (m)
uniform vec3 atmoSun;      // direction to the sun (world)
varying vec3 vWorldPosition;

const float sunCosRadius = 0.999989;           // cos(0.27 degrees)
const int VIEW_SAMPLES = 16;

void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vWorldPosition - cameraPosition);
  vec3 ds = d + atmoPole.w * dot(d, atmoPole.xyz) * atmoPole.xyz;
  float A = dot(ds, ds);
  float B = dot(atmoCamera.xyz, ds);
  float t0, t1;
  if (!atmoRoots(A, B, atmoCamera.w, t0, t1)) discard;
  t0 = max(t0, 0.0);
  // Stop at the ground (sea level) if the ray reaches it.
  float groundDisc = B * B - A * atmoParams.x;
  bool hitsGround = atmoParams.x > 0.0 && B < 0.0 && groundDisc > 0.0;
  // The ground (drawn in front of the shell) hides lines of sight that reach it: skip them early (the
  // logarithmic depth written by this shader stops the GPU from rejecting them before it runs).
  if (hitsGround) discard;
  if (t1 <= t0) discard;
  float sunCos = dot(d, atmoSun);
  float sunDisc = smoothstep(sunCosRadius - 0.000004, sunCosRadius, sunCos);

  vec3 light, transmittance;
  atmoScatter(atmoCamera.xyz, ds, d, t0, t1, atmoSun, atmoParams.z, VIEW_SAMPLES, light, transmittance);
  light *= atmoParams.y;
  // The sun's disc seen through the air, reddened by it.
  light += sunDisc * ATMO_SUN_INTENSITY * 4.0 * transmittance;
  vec3 color = 1.0 - exp(-light);                         // exposure
  float opacity = 1.0 - dot(transmittance, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}
