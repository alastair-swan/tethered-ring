#include <common>
#include <logdepthbuf_pars_fragment>

varying vec3 vertexNormal;

void main() {
  #include <logdepthbuf_fragment>
  float intensity = pow(0.7 - dot(vertexNormal, vec3(0.0, 0.0, 1.0)), 4.0);
  gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * intensity;
  #include <colorspace_fragment>
}
