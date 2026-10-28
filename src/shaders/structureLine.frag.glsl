// Thin structural lines: self-illuminated, added to what is behind them (see structureLine.vert.glsl
// and src/scene/structureLines.js).
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>

uniform vec3 color;
varying float vLight;

void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(color * vLight, 1.0);
  #include <colorspace_fragment>
#ifdef USE_FOG
  // In the water (Ocean's fog) and seen from above it (sea fog, seaDarkening.js), the light fades
  // rather than turning into the fog colour: the lines are added to what is behind them.
  #ifdef FOG_EXP2
    float structureFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float structureFog = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb *= (1.0 - structureFog) * (1.0 - vSeaFog);
#endif
  // Stochastic rounding: the many sub-pixel strands each add far less than one 8-bit step, which
  // would round to nothing; rounding up with probability equal to the remainder keeps their sum.
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor.rgb = floor(gl_FragColor.rgb * 255.0 + noise) / 255.0;
}
