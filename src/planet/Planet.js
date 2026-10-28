import * as THREE from 'three';
import { CubedSpherePlanetRenderer, PLANET_YAW } from './CubedSpherePlanetRenderer.js';
import atmosphereVertexShader from '../shaders/atmosphere.vert.glsl?raw';
import atmosphereFragmentShader from '../shaders/atmosphere.frag.glsl?raw';

// The atmosphere shell is a sphere of the equatorial radius scaled by this
// factor (and flattened like the planet). 1.1 / 1.05 reproduces the old look,
// which scaled by 1.1 and then divided by w = 1.05 in the vertex shader.
// Top of the atmosphere shell above sea level (m), and the length of air for the sky to reach 63% of
// its full opacity (see atmosphere.frag.glsl).
const ATMOSPHERE_HEIGHT = 60000;
const ATMOSPHERE_OPACITY_PATH = 40000;

// Flat surface colours used before tiles stream in, and for bodies that have
// no baked assets at all.
const BODY_SURFACE_COLORS = {
  earth: 0x8aa7c2,
  moon: 0x9a9a9a,
  mars: 0xb5603a,
  mercury: 0x8c8680,
  venus: 0xd9c08c,
  jupiter: 0xc9a27a,
  saturn: 0xdcc795,
  uranus: 0x9fd8e0,
  neptune: 0x4a6fd8,
  pluto: 0xcbb69c,
};

function bodyKey(planetSpec) {
  return String(planetSpec?.name ?? '').toLowerCase();
}

/**
 * Baked asset sets for a body (names of folders under assets/).
 * Earth -> ['earth'], Moon -> ['moon'], anything else -> [] (flat colour).
 */
export function defaultPlanetAssets(planetSpec) {
  switch (bodyKey(planetSpec)) {
    case 'earth': return ['earth'];
    case 'moon': return ['moon'];
    default: return [];
  }
}

function assetFromName(name) {
  const base = `${import.meta.env?.BASE_URL ?? '/'}assets/${name}`;
  return {
    name,
    manifestUrl: `${base}/manifest.json`,
    colorBasePath: `${base}/color`,
    heightBasePath: `${base}/height`,
  };
}

function parseNameList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((s) => String(s).trim()).filter((s) => s.length > 0))];
}

// `?planetAssets=earth,hawaii` overrides the asset stack (debugging aid).
function assetNamesFromUrl() {
  if (typeof window === 'undefined' || !window.location) return null;
  const params = new URLSearchParams(window.location.search);
  const value = params.get('planetAssets') ?? params.get('planet2Assets');
  return value ? parseNameList(value) : null;
}

/**
 * A planet surface (cubed-sphere quadtree LOD, streamed KTX2/height tiles) plus
 * an atmosphere shell.
 *
 * Usage:
 *   const planet = new Planet(planetSpec, { renderer, opacity: 1 });
 *   planetCoordSys.add(planet.surface, planet.atmosphere);
 *   // every frame, before rendering:
 *   planet.update(camera);
 *
 * Options (second constructor argument):
 *   renderer              THREE.WebGLRenderer. Needed for KTX2 support detection
 *                         and for the drawing-buffer height used by the LOD.
 *   assets                Ordered asset names under assets/ (first = base globe,
 *                         later = overlays), e.g. ['earth', 'hawaii'].
 *                         Default: defaultPlanetAssets(planetSpec). A URL
 *                         parameter ?planetAssets=a,b overrides it.
 *   doubleSided           Render tile back faces (default false).
 *   opacity               Surface opacity 0..1 (default 1).
 *   showAtmosphere        Initial atmosphere visibility (default true).
 *   tileSegments          Grid segments per tile edge (default 24).
 *   maxConcurrentTileLoads  Parallel tile downloads (default 8).
 *   maxCachedTiles        Resident tile budget (default 320).
 *   maxTileGpuBytes       Estimated texture+height byte budget (default 700 MiB).
 *   tileSseThreshold      Refine when one colour texel would cover more than this many pixels (default 1.5;
 *                         smaller = sharper, more tiles).
 *   tileTextureSize       Colour tile resolution assumed for LOD selection (default 256)
 *   maxAvailableTileLod   Deepest LOD to use before the manifest is loaded, and
 *                         the geometric refinement depth for bodies without
 *                         assets (default 6; manifests override it).
 *   requireKtx2           If true, a failed colour tile is tolerated (flat colour)
 *                         instead of being retried (default false).
 *   receiveSurfaceShadows Tile meshes receive shadows (default false).
 *   textureAnisotropy     Colour texture anisotropy (default 4).
 *   locationInterests     [{ name, lat, lon, radiusKm = 80, lodBoost = 1 }] areas
 *                         refined and loaded preferentially (default []).
 *   displacementScaleMultiplier  Terrain exaggeration (default 1).
 *   surfaceDetail         { enabled, nearMeters, farMeters, normalStrength,
 *                         albedoStrength, roughnessStrength } procedural regolith
 *                         detail for close-up views (default off).
 *   surfaceColor          Flat colour for unloaded tiles / bodies without assets
 *                         (default per body, e.g. reddish for Mars).
 *   water                 Draw a sea surface over terrain below sea level, coloured
 *                         by the imagery (default: planetSpec.hasOcean).
 *   fastCameraSpeed       Camera speed (m/s) above which refinement is capped
 *                         at maxLodWhileFast (default Infinity = never).
 *   maxLodWhileFast       See fastCameraSpeed (default Infinity).
 *   debugMode             'none' | 'tileBorders' | 'lod' | 'priority' |
 *                         'roughness' | 'landWater' | 'loading' (default 'none').
 *   startupChart          Log startup timing milestones and an ASCII load chart
 *                         to the console (default false).
 */
const _atmoQuaternion = new THREE.Quaternion();
const _atmoInverse = new THREE.Quaternion();
const _atmoCamera = new THREE.Vector3();
const _atmoCentre = new THREE.Vector3();
const _atmoPole = new THREE.Vector3();

export class Planet {
  constructor(planetSpec, {
    renderer = null,
    assets,
    doubleSided = false,
    opacity = 1,
    showAtmosphere = true,
    ...rendererOptions
  } = {}) {
    this.planetSpec = planetSpec;

    const assetNames = assetNamesFromUrl() ?? parseNameList(assets ?? defaultPlanetAssets(planetSpec));
    this.assetNames = assetNames;

    this.surface = new THREE.Group();
    this.surface.name = 'planetSurface';
    this.surface.rotation.y = PLANET_YAW; // aligns the baked longitude frame with the app's

    this.lod = new CubedSpherePlanetRenderer({
      ...rendererOptions,
      surfaceColor: rendererOptions.surfaceColor ?? BODY_SURFACE_COLORS[bodyKey(planetSpec)] ?? 0x8aa7c2,
      group: this.surface,
      renderer,
      planetSpec,
      assets: assetNames.map(assetFromName),
      doubleSided,
      opacity,
      water: rendererOptions.water ?? planetSpec.hasOcean === true,
    });

    // The atmosphere: a shell ATMOSPHERE_HEIGHT above the sea-level ellipsoid, drawn from inside
    // (its far side), whose opacity is worked out per pixel from the line of sight through it (see
    // atmosphere.frag.glsl and updateAtmosphere). Finely tessellated so its edge stays smooth (the
    // chord sag of 256 x 128 segments is about 0.5 km).
    const a = planetSpec.ellipsoid.a;
    const b = a * (1 - (planetSpec.ellipsoid.f || 0));
    this.ellipsoid = { a, b };
    this.atmosphereUniforms = {
      atmoCamera: { value: new THREE.Vector4() },
      atmoPole: { value: new THREE.Vector4() },
      atmoParams: { value: new THREE.Vector4(0, ATMOSPHERE_OPACITY_PATH, 0, 0) },
      atmoSun: { value: new THREE.Vector3(0, 1, 0) },
    };
    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 256, 128),
      new THREE.ShaderMaterial({
        uniforms: this.atmosphereUniforms,
        vertexShader: atmosphereVertexShader,
        fragmentShader: atmosphereFragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.atmosphere.name = 'atmosphere';
    this.atmosphere.scale.set(a + ATMOSPHERE_HEIGHT, b + ATMOSPHERE_HEIGHT, a + ATMOSPHERE_HEIGHT);
    this.atmosphere.frustumCulled = false; // also the sky around the camera when it is inside the shell
    this.atmosphere.visible = showAtmosphere;
  }

  /**
   * Updates the atmosphere for this frame: camera (world) and the direction to the sun (world).
   * The large terms are computed here in float64 so the shader works with small numbers.
   */
  updateAtmosphere(camera, sunDirection) {
    const { a, b } = this.ellipsoid;
    const k = a / b;
    const top = a + ATMOSPHERE_HEIGHT;
    this.atmosphere.updateWorldMatrix(true, false);
    const q = this.atmosphere.getWorldQuaternion(_atmoQuaternion);
    // Camera relative to the planet centre, in the planet's own axes (y = polar), then stretched.
    camera.getWorldPosition(_atmoCamera);
    _atmoCamera.sub(this.atmosphere.getWorldPosition(_atmoCentre)).applyQuaternion(_atmoInverse.copy(q).invert());
    _atmoCamera.y *= k;
    const c2 = _atmoCamera.lengthSq();
    _atmoCamera.applyQuaternion(q);
    const u = this.atmosphereUniforms;
    u.atmoCamera.value.set(_atmoCamera.x, _atmoCamera.y, _atmoCamera.z, c2 - top * top);
    _atmoPole.set(0, 1, 0).applyQuaternion(q);
    u.atmoPole.value.set(_atmoPole.x, _atmoPole.y, _atmoPole.z, k - 1);
    u.atmoParams.value.x = c2 - a * a;
    u.atmoSun.value.copy(sunDirection).normalize();
  }

  /** Per-frame LOD selection and streaming. Call before rendering. */
  update(camera) {
    this.lod.update(camera);
  }

  /** Shows/hides the surface. While hidden, update() streams nothing. */
  setVisible(visible) {
    this.surface.visible = !!visible;
    this.lod.setEnabled(!!visible);
  }

  // Sea surface over terrain below sea level (planets with oceans).
  setWaterVisible(visible) {
    this.lod.setWaterVisible(visible)
  }

  // 1 while the camera is under the sea surface: the ground below sea level is drawn as sea floor.
  setSeafloorView(amount) {
    this.lod.setSeafloorView(amount)
  }

  setAtmosphereVisible(visible) {
    this.atmosphere.visible = !!visible;
  }

  setOpacity(value) {
    this.lod.setOpacity(value);
  }

  setDoubleSided(doubleSided) {
    this.lod.setDoubleSided(doubleSided);
  }

  setDisplacementScale(multiplier) {
    this.lod.setDisplacementScale(multiplier);
  }

  setDebugMode(mode) {
    this.lod.setDebugMode(mode);
  }

  /**
   * Terrain height at a geodetic lat/lon (degrees) from the resident tiles, or
   * null if nothing covering the point is loaded. See
   * CubedSpherePlanetRenderer.sampleTerrainHeight for the result fields.
   */
  sampleTerrainHeight(latDeg, lonDeg) {
    return this.lod.sampleTerrainHeight(latDeg, lonDeg);
  }

  /** Intersections with the visible surface tiles only, nearest first. */
  raycast(raycaster) {
    return this.lod.raycast(raycaster, []);
  }

  getDebugStats() {
    return this.lod.getDebugStats();
  }

  dispose() {
    this.lod.dispose();
    this.surface.removeFromParent();
    this.atmosphere.removeFromParent();
    this.atmosphere.geometry.dispose();
    this.atmosphere.material.dispose();
  }
}
