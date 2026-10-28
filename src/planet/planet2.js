// =============================================================================
// TEMPORARY compatibility shim - delete once main.js uses Planet.js directly.
//
// Re-implements the old planet2 contract on top of the Planet class:
//   new planet2(dParamWithUnits, planetSpec, enableVR, nonGUIParams)
//     -> [planetMeshes, atmosphereMesh, null] with .updatePlanetLod,
//        .setPlanetDoubleSided, .sampleTerrainHeight, .setPlanetDebugMode,
//        .getPlanetDebugStats, .disposePlanetLod
// =============================================================================
import { Planet, defaultPlanetAssets } from './Planet.js';

export class planet2 {
  constructor(dParamWithUnits, planetSpec, enableVR, nonGUIParams = {}) {
    const renderer = nonGUIParams.renderer ||
      (typeof nonGUIParams.getRenderer === 'function' ? nonGUIParams.getRenderer() : null);
    // The old planet2 forced this; kept here (only) so the app looks the same
    // until main.js owns its pixel ratio.
    if (renderer) renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const planet = new Planet(planetSpec, {
      renderer,
      assets: nonGUIParams.planet2Assets ?? defaultPlanetAssets(planetSpec),
      doubleSided: dParamWithUnits?.earthTextureDoubleSided?.value === true,
      showAtmosphere: dParamWithUnits?.showEarthsAtmosphere?.value ?? true,
      tileSegments: nonGUIParams.tileSegments,
      maxConcurrentTileLoads: nonGUIParams.maxConcurrentTileLoads,
      maxCachedTiles: nonGUIParams.maxCachedTiles,
      maxTileGpuBytes: nonGUIParams.maxTileGpuBytes,
      tileSseThreshold: nonGUIParams.tileSseThreshold,
      maxAvailableTileLod: nonGUIParams.maxAvailableTileLod,
      requireKtx2: nonGUIParams.planet2RequireKtx2 === true,
      receiveSurfaceShadows: nonGUIParams.enableSurfaceShadows === true,
      textureAnisotropy: nonGUIParams.planet2TextureAnisotropy,
      startupChart: nonGUIParams.planet2StartupChart === true,
      locationInterests: nonGUIParams.locationInterests,
      displacementScaleMultiplier: nonGUIParams.planet2DisplacementScaleMultiplier,
      surfaceDetail: nonGUIParams.planet2SurfaceDetail,
      surfaceColor: nonGUIParams.planet2SurfaceColor,
      fastCameraSpeed: nonGUIParams.planet2FastCameraSpeed,
      maxLodWhileFast: nonGUIParams.planet2MaxLodWhileFast,
    });
    this.planet = planet;

    const result = [planet.surface, planet.atmosphere, null];
    result.planet = planet;
    result.updatePlanetLod = (camera) => planet.update(camera);
    result.setPlanetDebugMode = (mode) => planet.setDebugMode(mode);
    result.setPlanetDoubleSided = (doubleSided) => planet.setDoubleSided(doubleSided);
    result.getPlanetDebugStats = () => planet.getDebugStats();
    result.sampleTerrainHeight = (lat, lon) => planet.sampleTerrainHeight(lat, lon);
    result.disposePlanetLod = () => planet.dispose();

    if (typeof nonGUIParams.registerPlanetLodUpdater === 'function') {
      nonGUIParams.registerPlanetLodUpdater(result.updatePlanetLod);
    }

    return result;
  }
}
