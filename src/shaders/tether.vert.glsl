// Tethers are drawn as thin lines whose opacity grows with apparent (on-screen) thickness, so the
// thousands of tether strands fade out with distance instead of turning into a solid sheet.
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float tetherDistanceFactor;
attribute float thickness;
varying float apparentThickness;

void main() {
  vec4 eyeCoord = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * eyeCoord;
  #include <logdepthbuf_vertex>
  // Eye space looks down -z, so the distance to the camera is -eyeCoord.z.
  float eyeDistance = -eyeCoord.z;
  apparentThickness = thickness / (eyeDistance * tetherDistanceFactor);
}
