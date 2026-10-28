// Atmosphere shell (see Planet.js): passes the world position on for the per-pixel ray march.
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vWorldPosition;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPosition = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
