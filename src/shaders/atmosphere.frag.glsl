// Atmosphere: the sky's opacity is how much air the line of sight passes through, between the top of
// the shell and the ground (1 - exp(-path / atmoParams.y)), lit only on the day side. From space this
// is a thin limb glow at any zoom; from inside the shell the same calculation is a blue sky (paler
// towards the horizon, where the path is long) that hides the stars by day, so there is no switch-over
// as the camera descends.
//
// Solved against the ellipsoid by stretching space along the polar axis (atmoPole.w = a/b - 1), which
// turns it into a sphere; relative to the camera, with |C'|^2 - r^2 (small differences of huge numbers)
// computed in float64 on the CPU (see Planet.updateAtmosphere), and with numerically stable roots.
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec4 atmoCamera;   // xyz: stretched camera position relative to the planet centre (world axes); w: |C'|^2 - top^2
uniform vec4 atmoPole;     // xyz: polar axis (world); w: a/b - 1
uniform vec4 atmoParams;   // x: |C'|^2 - a^2 (ground); y: path length for 63% opacity (m)
uniform vec3 atmoSun;      // direction to the sun (world)
varying vec3 vWorldPosition;

const vec3 zenithColor = vec3(0.16, 0.36, 0.85);
const vec3 horizonColor = vec3(0.55, 0.72, 0.95);

void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vWorldPosition - cameraPosition);
  vec3 ds = d + atmoPole.w * dot(d, atmoPole.xyz) * atmoPole.xyz;
  float A = dot(ds, ds);
  float B = dot(atmoCamera.xyz, ds);
  float discTop = B * B - A * atmoCamera.w;
  if (discTop <= 0.0) discard;
  // Stable roots of A t^2 + 2 B t + c = 0: q = -(B + sign(B) sqrt(disc)), roots q / A and c / q.
  float q = -(B + (B >= 0.0 ? 1.0 : -1.0) * sqrt(discTop));
  float r1 = q / A;
  float r2 = atmoCamera.w / q;
  float t0 = max(min(r1, r2), 0.0);
  float t1 = max(r1, r2);
  // Stop at the ground (sea level) if the ray reaches it.
  float discGround = B * B - A * atmoParams.x;
  if (atmoParams.x > 0.0 && B < 0.0 && discGround > 0.0) t1 = min(t1, atmoParams.x / (-B + sqrt(discGround)));
  float path = t1 - t0;
  if (path <= 0.0) discard;
  // Day side: the sun's elevation at the middle of the path through the air.
  vec3 up = normalize(atmoCamera.xyz + 0.5 * (t0 + t1) * ds);
  float day = smoothstep(-0.25, 0.2, dot(up, atmoSun));
  float opacity = (1.0 - exp(-path / atmoParams.y)) * day;
  vec3 color = mix(zenithColor, horizonColor, smoothstep(2.0, 20.0, path / atmoParams.y));
  // The sun's disc and glow, seen through the air (the sky would otherwise cover the sky pass's sun).
  float sunCos = dot(d, atmoSun);
  float sunDisc = smoothstep(0.999986, 0.999990, sunCos);               // 0.27 degree radius
  float sunGlow = 0.25 * pow(max(sunCos, 0.0), 800.0) + 0.15 * pow(max(sunCos, 0.0), 30.0);
  color = mix(color, vec3(1.0, 0.97, 0.9), clamp(sunDisc + sunGlow * day, 0.0, 1.0));
  opacity = max(opacity, max(sunDisc, sunGlow * day));
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}
