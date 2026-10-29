import * as THREE from 'three'

// Fog in the sea as seen from in it, with the evacuated tube kept dry. Under the surface things fade
// into the water by how far the line of sight travels through water, as FogExp2 does with distance:
// 1 - exp(-(density * path)^2). Inside the tube there is no water, so the part of the line of sight that
// is inside the tube is left out of the path: from inside the tube its walls and everything in it are
// clear and what is seen through them fades by the water beyond; from outside, looking through the tube
// adds no fog for the stretch inside it.
//
// The tube is taken as a cylinder along its axis's direction at the point nearest the camera (it bends
// by metres only over kilometres, beyond which the water hides it anyway), given relative to the camera so
// that it stays precise in float32. The path is worked out per fragment, from the camera-to-fragment
// offset interpolated from the vertices (exact, as the offset is linear across a triangle).
//
// Like seaDarkening.js, it is added to three.js's fog shader chunks (every built-in material includes them
// while the scene has fog: Ocean keeps scene.fog set while the sea is shown), with the uniforms added to the
// built-in shader libraries as shared plain-object values.
const tube = { x: 0, y: 0, z: 0, w: 0 }   // xyz: a point on the tube's axis relative to the camera (world axes); w: inside radius (0: no tube)
const axis = { x: 0, y: 0, z: 1 }         // the axis's direction (world axes)

const LIBRARIES = ['basic', 'lambert', 'phong', 'standard', 'physical', 'toon', 'matcap', 'points', 'sprite']
for (const name of LIBRARIES) {
  Object.assign(THREE.ShaderLib[name].uniforms, {
    waterTube: { value: tube },
    waterTubeAxis: { value: axis },
  })
}

THREE.ShaderChunk.fog_pars_vertex += `
#ifdef USE_FOG
  varying vec3 vWaterOffset;
#endif
`
THREE.ShaderChunk.fog_vertex += `
#ifdef USE_FOG
  vWaterOffset = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif
`
THREE.ShaderChunk.fog_pars_fragment += `
#ifdef USE_FOG
  uniform vec4 waterTube;
  uniform vec3 waterTubeAxis;
  varying vec3 vWaterOffset;
  // How far the line of sight from the camera to a fragment (offset from it) travels through water: all of
  // it, less the part inside the tube.
  float waterPath(vec3 offset) {
    float distance = length(offset);
    if (waterTube.w <= 0.0) return distance;
    vec3 dir = offset / max(distance, 1e-6);
    // Along the ray s * dir, the distance from the axis squared is a s^2 + 2 b s + c.
    float along = dot(dir, waterTubeAxis);
    float pointAlong = dot(waterTube.xyz, waterTubeAxis);
    float a = 1.0 - along * along;
    float b = pointAlong * along - dot(dir, waterTube.xyz);
    float c = dot(waterTube.xyz, waterTube.xyz) - pointAlong * pointAlong - waterTube.w * waterTube.w;
    float inside;
    if (a < 1e-9) inside = c < 0.0 ? distance : 0.0;
    else {
      float disc = b * b - a * c;
      if (disc <= 0.0) return distance;
      float root = sqrt(disc);
      inside = max(0.0, min(distance, (-b + root) / a) - max(0.0, (-b - root) / a));
    }
    return distance - inside;
  }
#endif
`
THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
  'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
  'float fogPath = waterPath(vWaterOffset);\n\t\tfloat fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogPath * fogPath );')

export const WaterFog = {
  // tubeNear: { point, tangent, radius } (planet coordinates) or null; cameraLocal: the camera in planet
  // coordinates; planetQuaternion: the planet frame's orientation in the world.
  update(tubeNear, cameraLocal, planetQuaternion) {
    if (!tubeNear) { tube.w = 0; return }
    // Relative to the camera in float64, then rotated into world axes.
    _v.subVectors(tubeNear.point, cameraLocal).applyQuaternion(planetQuaternion)
    tube.x = _v.x; tube.y = _v.y; tube.z = _v.z; tube.w = tubeNear.radius
    _v.copy(tubeNear.tangent).applyQuaternion(planetQuaternion).normalize()
    axis.x = _v.x; axis.y = _v.y; axis.z = _v.z
  },
}

const _v = new THREE.Vector3()
