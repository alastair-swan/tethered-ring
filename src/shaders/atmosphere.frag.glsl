// Atmosphere: single scattering, ray-marched along the stretch of each line of sight that passes
// through the air (between the top of the shell and the ground). Rayleigh (blue sky, red sunsets) and
// Mie (haze, the glow around the sun) with exponentially falling density; at each sample the sunlight
// is attenuated along its own path to the sun, using the Chapman function for the air along it
// (Schuler's form, within ~2.5% except near grazing; zero where the ground is in the way). The output
// is the scattered light, and the background (stars, the sun's disc in the sky pass) is dimmed by the
// air's transmittance.
//
// Geometry: solved against the ellipsoid by stretching space along the polar axis (atmoPole.w =
// a/b - 1), which turns it into a sphere of radius a; relative to the camera, with |C'|^2 - r^2 (small
// differences of huge numbers) computed in float64 on the CPU (Planet.updateAtmosphere), and with
// numerically stable roots. The output is premultiplied: colour + background * (1 - alpha).
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec4 atmoCamera;   // xyz: stretched camera position relative to the planet centre (world axes); w: |C'|^2 - top^2
uniform vec4 atmoPole;     // xyz: polar axis (world); w: a/b - 1
uniform vec4 atmoParams;   // x: |C'|^2 - a^2 (ground); z: a (m); w: top radius (m)
uniform vec3 atmoSun;      // direction to the sun (world)
varying vec3 vWorldPosition;

const float sunCosRadius = 0.999989;           // cos(0.27 degrees)

// Stable roots of A t^2 + 2 B t + c = 0 (t0 <= t1); false if there are none.
bool atmoRoots(float A, float B, float c, out float t0, out float t1) {
  float disc = B * B - A * c;
  if (disc <= 0.0) return false;
  float q = -(B + (B >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
  float r1 = q / A;
  float r2 = c / q;
  t0 = min(r1, r2);
  t1 = max(r1, r2);
  return true;
}

// Scattering coefficients at sea level (1/m) and scale heights (m).
const vec3 betaR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float betaM = 8e-6;   // a clear day (21e-6 is hazy)
const float heightR = 8000.0;
const float heightM = 1200.0;
const float mieG = 0.76;
const float sunIntensity = 22.0;
const int VIEW_SAMPLES = 16;

// Air (density-weighted metres) from radius r (height h) out along a ray at zenith cosine c, for scale
// height H: H exp(-h/H) ch(r/H, c), with ch(X, c) ~ k / ((k - 1) c + 1), k = sqrt(pi X / 2); below the
// local horizon, reflected through the ray's lowest point.
float atmoChapman(float H, float r, float h, float c) {
  float k = sqrt(PI * r / H * 0.5);
  float up = H * exp(-h / H) * k / ((k - 1.0) * abs(c) + 1.0);
  if (c >= 0.0) return up;
  float rt = r * sqrt(1.0 - c * c);
  return 2.0 * H * exp(-(rt - atmoParams.z) / H) * sqrt(PI * rt / H * 0.5) - up;
}

// Rayleigh and Mie air between p and the sun; a huge value if the ground is in the way.
vec2 atmoSunDepth(vec3 p) {
  float r = length(p);
  float c = dot(p, atmoSun) / r;
  float b = c * r;
  if (b < 0.0 && b * b - (r * r - atmoParams.z * atmoParams.z) > 0.0) return vec2(1e9);
  float h = r - atmoParams.z;
  return vec2(atmoChapman(heightR, r, h, c), atmoChapman(heightM, r, h, c));
}

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

  // March the line of sight. Positions are in the stretched frame (|p| ~ a), so heights are |p| - a.
  float segment = (t1 - t0) / float(VIEW_SAMPLES);
  vec2 viewDepth = vec2(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < VIEW_SAMPLES; i++) {
    vec3 p = atmoCamera.xyz + ds * (t0 + (float(i) + 0.5) * segment);
    float h = length(p) - atmoParams.z;
    vec2 density = exp(-h / vec2(heightR, heightM)) * segment;
    viewDepth += density;
    vec2 sunDepth = atmoSunDepth(p);
    vec3 attenuation = exp(-(betaR * (viewDepth.x + sunDepth.x) + betaM * 1.1 * (viewDepth.y + sunDepth.y)));
    sumR += density.x * attenuation;
    sumM += density.y * attenuation;
  }
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + sunCos * sunCos);
  float g2 = mieG * mieG;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + sunCos * sunCos)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * mieG * sunCos, 1.5));
  vec3 light = sunIntensity * (sumR * betaR * phaseR + sumM * betaM * phaseM);
  vec3 transmittance = exp(-(betaR * viewDepth.x + betaM * 1.1 * viewDepth.y));
  // The sun's disc seen through the air, reddened by it.
  light += sunDisc * sunIntensity * 4.0 * transmittance;
  vec3 color = 1.0 - exp(-light);                         // exposure
  float opacity = 1.0 - dot(transmittance, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}
