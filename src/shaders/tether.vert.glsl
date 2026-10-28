// Tethers are drawn as thin lines whose opacity grows with apparent (on-screen) thickness, so the
// thousands of tether strands fade out with distance instead of turning into a solid sheet.
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float tetherDistanceFactor;
// Camera pixels per radian relative to the reference view (default FOV at 1080 px), so the fade
// tracks on-screen size: zooming in or rendering at 4K keeps distant tethers visible as they should be.
uniform float screenScale;
attribute float thickness;
// How many full-detail strands this line stands for (>1 where distant forks are merged).
attribute float strands;
varying float apparentThickness;
varying float vStrands;

void main() {
  vec4 eyeCoord = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * eyeCoord;
  #include <logdepthbuf_vertex>
  // Eye space looks down -z, so the distance to the camera is -eyeCoord.z.
  float eyeDistance = -eyeCoord.z;
  vStrands = strands;
  apparentThickness = thickness * screenScale / (eyeDistance * tetherDistanceFactor);
}
