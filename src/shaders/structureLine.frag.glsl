// Thin structural lines: a cable of the line's colour at structureBrightness covering vCoverage of its
// pixel, over what is behind it (premultiplied alpha; see structureLine.vert.glsl and
// src/scene/structureLines.js).
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>

uniform vec3 color;
uniform float structureBrightness;
varying float vCoverage;

void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(color * structureBrightness, 1.0);
  #include <colorspace_fragment>
  float coverage = vCoverage;
#ifdef USE_FOG
  // In the water (Ocean's fog) and seen from above it (sea fog, seaDarkening.js), the line fades into
  // what is behind it rather than turning into the fog colour.
  #ifdef FOG_EXP2
    float structureFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float structureFog = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  coverage *= (1.0 - structureFog) * (1.0 - vSeaFog);
#endif
  // Stochastic rounding: the many sub-pixel strands each change their pixel by far less than one 8-bit
  // step, which would round to nothing. The coverage is rounded to steps that change a dark pixel by
  // one 8-bit step, up with probability equal to the remainder, which keeps their sum.
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float quantum = 1.0 / (255.0 * max(max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b)), 1.0 / 255.0));
  coverage = min(1.0, floor(coverage / quantum + noise) * quantum);
  gl_FragColor = vec4(gl_FragColor.rgb * coverage, coverage);
}
