#include <common>
#include <logdepthbuf_pars_fragment>

uniform float tetherMinOpacity;
uniform float tetherMaxOpacity;
uniform vec3 color;
varying float apparentThickness;

void main() {
  #include <logdepthbuf_fragment>
  float opacity = tetherMinOpacity + apparentThickness * (tetherMaxOpacity - tetherMinOpacity);
  gl_FragColor = vec4(color, opacity);
  #include <colorspace_fragment>
}
