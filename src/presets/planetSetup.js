// How a preset's planet streams (see src/planet/Planet.js and assets/README.md): which tile sets, how much
// it keeps loaded, and where it loads first.
//
// Every preset gets the global tile set for its body (assets/earth, assets/moon). Regional bakes add much
// sharper imagery and terrain over a small area, as overlays on top of it; scenes there list them, and get
// the larger streaming budgets they need (a regional bake keeps many more, smaller tiles loaded: with the
// default budget of 320, the island in view would keep being evicted and reloaded).
//
// Scenes elsewhere use the global tiles only (about 75 m per texel at their finest, sharper than the old
// planet renderer's high-resolution regions). Where a scene would benefit from a regional bake that does
// not exist yet, it says so in a comment by its planetSetup call.

const EOX_CLOUDLESS = 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)'

// The regional bakes: where their sharpest tiles are (to load first: the centres of their bakes' core
// areas, see tools/bake_hawaii_bigisland_hires.py and tools/adaptive_lod.py), and their imagery's
// attribution.
export const REGIONAL_ASSETS = {
  hawaii: { name: 'Big Island of Hawaii', lat: 19.6, lon: -155.43, radiusKm: 100, attribution: EOX_CLOUDLESS },
  chimborazo: { name: 'Chimborazo', lat: -1.47, lon: -79.0, radiusKm: 80, attribution: EOX_CLOUDLESS },
  moon_tranquillitatis: { name: 'Mare Tranquillitatis', lat: 0.7, lon: 23.5, radiusKm: 60, attribution: null },
  moon_korolev: { name: 'Korolev crater', lat: -3.1, lon: -158.25, radiusKm: 60, attribution: null },
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
  const attribution = [...new Set(regional.map(r => r.attribution).filter(Boolean))].join('; ')
  if (attribution) nonGUIParams['imageryAttribution'] = attribution
}
