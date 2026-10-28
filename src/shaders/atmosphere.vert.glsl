// Atmosphere glow shell. The mesh is scaled explicitly (see Planet.js), so the
// position is used as-is (w = 1).
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vertexNormal;

void main() {
  vertexNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
