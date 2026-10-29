// A faint surface on the evacuated tube's transparent wall, so that it reads as a sheet of clear material
// rather than nothing, from inside and outside:
// - Like glass, it is clearer looking straight through it and more opaque at grazing angles (Fresnel).
// - Faint streaks along it (as from drawing or extrusion), varying slowly along its length, and soft
//   mottling.
// - A faint joint between panels every PANEL_LENGTH m.
// All of it changes only the wall's opacity (and a slight tint), by a few per cent. Detail smaller than a
// pixel fades to its average, so it does not shimmer. The pattern is in the tube's own coordinates
// (geometry attribute tubeCoord: metres along the segment, fraction of the way round), so it stays put on
// the wall.
const PANEL_LENGTH = 12   // m
const STREAKS = 160       // round the tube
const GRAZING_OPACITY = 0.45

// Adds tubeCoord to a TubeGeometry (uv: along, around) `length` m long.
export function addTubeCoordinates(geometry, length) {
  const uv = geometry.attributes.uv
  const coords = new Float32Array(uv.count * 2)
  for (let i = 0; i < uv.count; i++) {
    coords[i * 2] = uv.getX(i) * length
    coords[i * 2 + 1] = uv.getY(i)
  }
  geometry.setAttribute('tubeCoord', new geometry.attributes.uv.constructor(coords, 2))
  return geometry
}

// Gives a (Phong, transparent) material the wall's look.
export function withTubeWallLook(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 tubeCoord;
varying vec2 vTubeCoord;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vTubeCoord = tubeCoord;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vTubeCoord;
float tubeHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// Value noise, repeating every \`period\` cells in y (round the tube).
float tubeNoise(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, period), y1 = mod(i.y + 1.0, period);
  return mix(mix(tubeHash(vec2(i.x, y0)), tubeHash(vec2(i.x + 1.0, y0)), f.x),
             mix(tubeHash(vec2(i.x, y1)), tubeHash(vec2(i.x + 1.0, y1)), f.x), f.y);
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float along = vTubeCoord.x, around = vTubeCoord.y;
  // How much of each detail survives at this pixel's size (fading to its average when sub-pixel).
  float streakCells = fwidth(around) * ${STREAKS.toFixed(1)};
  float streakDetail = 1.0 - smoothstep(0.3, 1.0, streakCells);
  float streak = tubeNoise(vec2(along / 40.0, around * ${STREAKS.toFixed(1)}), ${STREAKS.toFixed(1)}) - 0.5;
  float mottle = tubeNoise(vec2(along / 6.0, around * 12.0), 12.0) + 0.5 * tubeNoise(vec2(along / 2.0, around * 36.0), 36.0) - 0.75;
  float toJoint = abs(along - ${PANEL_LENGTH.toFixed(1)} * floor(along / ${PANEL_LENGTH.toFixed(1)} + 0.5));
  float jointWidth = max(fwidth(along), 1e-4);
  float joint = (1.0 - smoothstep(0.02, 0.02 + jointWidth, toJoint)) * min(1.0, 0.05 / jointWidth);
  float alpha = diffuseColor.a * (1.0 + 0.35 * streak * streakDetail + 0.3 * mottle) + 0.1 * joint;
  // More opaque at grazing angles, as glass is.
  float facing = abs(dot(normal, normalize(vViewPosition)));
  alpha = mix(alpha, ${GRAZING_OPACITY.toFixed(2)}, pow(1.0 - facing, 4.0));
  diffuseColor.a = clamp(alpha, 0.0, 1.0);
  diffuseColor.rgb *= 1.0 + 0.06 * streak * streakDetail;
}`)
  }
  material.customProgramCacheKey = () => 'tubeWall'
  return material
}
