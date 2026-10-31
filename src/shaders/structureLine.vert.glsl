// Thin structural lines (tethers, elevator and mooring cables), drawn at their real diameter: see
// src/scene/structureLines.js. Per vertex: how much of its pixel the line covers (vCoverage: the glow,
// times the haze transmittance of the air between the camera and the vertex), and the light on it
// (vLight: sun, sky and ground, see src/scene/sunAndSkyLight.js).
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
#include <sun_and_sky_light>

uniform float structureMaxCoverage;
uniform float structureGlowDistance;   // m
uniform float structurePixelScale;     // drawing-buffer pixels per output pixel across (supersampling)
uniform float referenceDiameter;       // m: the structure's thickest member
uniform float hazeActive;
uniform vec4 atmoCamera;   // xyz: stretched camera position relative to the planet centre (world axes)
uniform vec4 atmoPole;     // xyz: polar axis (world); w: a/b - 1
uniform vec4 atmoParams;   // z: a (m)
attribute float diameter;  // m
attribute float strands;   // full-detail strands this line stands for (merged distant forks)
varying float vCoverage;
varying vec3 vLight;

// Air (density-weighted metres, scale height H) from p out along `up`, a direction at or above p's
// horizon: H exp(-h/H) ch(r/H, c) with Schuler's Chapman approximation ch ~ k / ((k - 1) c + 1).
float hazeUpAir(vec3 p, vec3 up, float H) {
  float r = length(p);
  float c = max(dot(p, up) / r, 0.0);
  float k = sqrt(PI * r / H * 0.5);
  return H * exp(-(r - atmoParams.z) / H) * k / ((k - 1.0) * c + 1.0);
}

// Air along the straight segment from the camera (pc) to pv, for scale height H. The segment is split
// at its lowest point so that every piece is measured looking upwards (the closed form is only well
// behaved there).
float hazeSegmentAir(vec3 pc, vec3 pv, vec3 d, float len, float H) {
  float lowest = -dot(pc, d);
  if (lowest <= 0.0) return hazeUpAir(pc, d, H) - hazeUpAir(pv, d, H);           // rising all the way
  if (lowest >= len) return hazeUpAir(pv, -d, H) - hazeUpAir(pc, -d, H);         // falling all the way
  vec3 t = pc + d * lowest;
  return (hazeUpAir(t, -d, H) - hazeUpAir(pc, -d, H)) + (hazeUpAir(t, d, H) - hazeUpAir(pv, d, H));
}

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  float eyeDistance = max(length(mvPosition.xyz), 1e-3);
  // The glow: as the square root of the diameter (relative to the structure's thickest member), held
  // out to the glow distance and fading as 1 / distance beyond it. A merged strand covers what the strands it
  // stands for would (overlapping, they hide each other).
  float strand = structureMaxCoverage * sqrt(min(1.0, diameter / referenceDiameter)) * min(1.0, structureGlowDistance / eyeDistance);
  float coverage = 1.0 - pow(1.0 - strand, strands);
  if (hazeActive > 0.5) {
    vec3 offset = transpose(mat3(viewMatrix)) * mvPosition.xyz;            // camera -> vertex, world axes
    offset += atmoPole.w * dot(offset, atmoPole.xyz) * atmoPole.xyz;       // stretched (ellipsoid -> sphere)
    float len = length(offset);
    vec3 d = offset / max(len, 1e-3);
    vec3 pv = atmoCamera.xyz + offset;
    float airR = max(hazeSegmentAir(atmoCamera.xyz, pv, d, len, 8000.0), 0.0);
    float airM = max(hazeSegmentAir(atmoCamera.xyz, pv, d, len, 1200.0), 0.0);
    // Extinction at sea level (1/m) for Rayleigh (green) and Mie, as in atmosphere.frag.glsl.
    coverage *= exp(-(13.5e-6 * airR + 8.8e-6 * airM));
  }
  // A 1 px line on a supersampled canvas is a fraction of an output pixel wide: it covers that much
  // more of its own pixel, so the filtered result is the same.
  vCoverage = min(1.0, coverage * structurePixelScale);
  // A thin cable of any direction: the sun on its lit side, half of the sky and of the ground, and the
  // night light, relative to full sunlight; 1 without the sun and sky light (other scenes).
  vLight = vec3(1.0);
  if (slParams.x > 0.5) {
    vec3 direct, skyDown, groundUp, up;
    slLightAt(transpose(mat3(viewMatrix)) * mvPosition.xyz, direct, skyDown, groundUp, up);
    vLight = (direct + 0.5 * (skyDown + groundUp)) * slLineLight.w + slLineLight.xyz;
  }
}
