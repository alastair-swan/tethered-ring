// How a preset's planet streams (see src/planet/Planet.js and assets/README.md): which tile sets, how much
// it keeps loaded, and where it loads first.
//
// Every preset gets the global tile set for its body (assets/earth, assets/moon). Regional bakes add much
// sharper imagery and terrain over a small area, as overlays on top of it; scenes there list them, and get
// the larger streaming budgets they need (a regional bake keeps many more, smaller tiles loaded: with the
// default budget of 320, the island in view would keep being evicted and reloaded).
//
// A regional bake is used where it is on the machine and skipped (falling back to the global tiles, and
// leaving out its imagery credit) where it is not: one not yet uploaded to Git LFS, or not pulled. So
// scenes list every bake for their area, made or not; they use it as soon as it is there.
//
// The Earth regions (other than hawaii) are baked with tools/adaptive_lod.py (EARTH_REGIONS, which also
// gives their extents); the global tiles alone are about 75 m per texel at their finest.

// The regional bakes: where their sharpest tiles are (to load first: the centres of their bakes' core
// areas, see tools/bake_hawaii_bigisland_hires.py and tools/adaptive_lod.py).
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

// Sets the planet's tile sets for a preset. assets: the tile sets, base first then regional overlays
// (default: the global set for the body). interests: [{ name, lat, lon, radiusKm, lodBoost }] to load
// first (default: the regional bakes' areas).
export function planetSetup(nonGUIParams, { assets, interests } = {}) {
  if (assets) nonGUIParams['planet2Assets'] = assets
  const regional = (assets ?? []).map(name => REGIONAL_ASSETS[name]).filter(Boolean)
  if (regional.length === 0) return
  nonGUIParams['tileSegments'] = 24
  nonGUIParams['maxConcurrentTileLoads'] = 16
  nonGUIParams['maxCachedTiles'] = 2200
  nonGUIParams['maxTileGpuBytes'] = 1536 * 1024 * 1024
  nonGUIParams['locationInterests'] = interests ??
    regional.map(({ name, lat, lon, radiusKm }) => ({ name, lat, lon, radiusKm, lodBoost: 1.5 }))
}
