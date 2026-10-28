#include <common>
#include <logdepthbuf_pars_fragment>

uniform float tetherMinOpacity;
uniform float tetherMaxOpacity;
uniform vec3 color;
varying float apparentThickness;
varying float vStrands;

void main() {
  #include <logdepthbuf_fragment>
  float opacity = clamp(tetherMinOpacity + apparentThickness * (tetherMaxOpacity - tetherMinOpacity), 0.0, 1.0);
  // A merged line covers the pixels its strands would have overlapped: blend them all at once.
  opacity = 1.0 - pow(1.0 - opacity, vStrands);
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}
