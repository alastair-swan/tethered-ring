// Where a preset's planet loads first, and how much it keeps loaded (see src/planet/Planet.js and
// docs/ASSETS.md).
//
// Every scene streams its body's global tile set and every regional high-resolution bake on the machine
// (Planet's defaultPlanetAssets), using the regional tiles wherever the camera is close enough to need
// them; a bake that is missing is skipped. A scene near a regional bake says so here: its area is loaded
// first, with the larger streaming budgets that close views of a bake need (it keeps many more tiles
// loaded: with the default budget of 320 an island in view would keep being evicted and reloaded).

// The regional bakes: where their sharpest tiles are (the centres of their bakes' core areas, see
// tools/bake_hawaii_bigisland_hires.py and tools/adaptive_lod.py).
export const REGIONAL_ASSETS = {
  hawaii: { name: 'Big Island of Hawaii', lat: 19.6, lon: -155.43, radiusKm: 100 },
  chimborazo: { name: 'Chimborazo', lat: -1.47, lon: -79.0, radiusKm: 80 },
  new_zealand: { name: 'Central North Island, New Zealand', lat: -39.15, lon: 175.65, radiusKm: 80 },
  washington: { name: 'Cascades, Washington', lat: 47.8, lon: -121.5, radiusKm: 150 },
  kilimanjaro: { name: 'Mount Kilimanjaro', lat: -3.05, lon: 37.35, radiusKm: 30 },
  boca_chica: { name: 'Boca Chica', lat: 26.0, lon: -97.15, radiusKm: 30 },
  christmas_island: { name: 'Christmas Island', lat: -10.49, lon: 105.62, radiusKm: 25 },
  queensland: { name: 'North Queensland', lat: -17.0, lon: 141.1, radiusKm: 80 },
  moon_tranquillitatis: { name: 'Mare Tranquillitatis', lat: 0.7, lon: 23.5, radiusKm: 60 },
  moon_korolev: { name: 'Korolev crater', lat: -3.1, lon: -158.25, radiusKm: 60 },
}

// For a preset near regional bakes (near: their names): loads their areas first (or `interests`:
// [{ name, lat, lon, radiusKm, lodBoost }]), with the larger streaming budgets.
export function planetSetup(nonGUIParams, { near = [], interests } = {}) {
  const regional = near.map(name => REGIONAL_ASSETS[name]).filter(Boolean)
  if (regional.length === 0 && !interests) return
  nonGUIParams['tileSegments'] = 24
  nonGUIParams['maxConcurrentTileLoads'] = 16
  nonGUIParams['maxCachedTiles'] = 2200
  nonGUIParams['maxTileGpuBytes'] = 1536 * 1024 * 1024
  nonGUIParams['locationInterests'] = interests ??
    regional.map(({ name, lat, lon, radiusKm }) => ({ name, lat, lon, radiusKm, lodBoost: 1.5 }))
}
