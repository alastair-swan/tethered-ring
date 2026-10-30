"""The Earth's global tile set baked from the planet source data, into assets/earth_hires.

Reads the Cloud-Optimized GeoTIFFs built by tools/sources (docs/ASSETS.md, "Planet source data"):
  - colour: blue_marble_15s.tif (NASA Blue Marble, repaired), the only imagery used at every level, so
    the globe is one unbroken dataset from space; regional bakes take over only close up;
  - height: elevation_7.5s.tif (GMTED2010 land, GEBCO 2026 sea floor);
  - ocean_mask_7.5s.tif, for which tiles have land and each tile's landFraction.
It writes the same tile format as assets/earth (assets/README.md), with the same height range, so the
regional bakes still stack on top of it. The app uses it when asked to (src/planet/Planet.js,
EARTH_BASE_TILES, or ?earthTiles=earth_hires).

Differences from the bake of assets/earth (tools/adaptive_lod.py):
  - The sources are pixel-is-area grids from (-180, 90), sampled at their pixel centres, and wrap across
    the 180-degree meridian (the old bake mapped -180..180 onto the first..last pixel centres, half a pixel
    out at either end, and clamped at the meridian).
  - Each level samples a copy of the source averaged down to about its own sample spacing (the COGs'
    overviews), so coarse tiles are not aliased. All tiles of a level use the same copy, so neighbouring
    height tiles still agree exactly along their shared edges.
  - The tile plan: every tile through FLOOR_LOD (the renderer needs them); tiles with land down to
    --land-lod; rough terrain (the --percentile of tile relief over land) and the tiles within --dilate
    tiles of it down to --mountain-lod; and every regional bake's area down to --regional-lod, so a
    regional bake (which starts at LOD 4 or 5) has base tiles under it down to the level it is drawn at
    from close up (see the renderer's overlay cut-off). Closed into a quadtree: a tile that has children
    has all four.

The source levels it samples are exported once to memory-mapped .npy files in .cache/earth_hires (the
full-resolution colour is 11 GB; the plan's height levels a few GB). Tiles are written as they are made;
--resume keeps the colour tiles already written by an interrupted bake. The manifest is written last.

    python -m tools.earth_hires --estimate      # the tile plan and its size, no tiles
    python -m tools.earth_hires --jobs 8        # bake assets/earth_hires
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import shutil
import time
from pathlib import Path

import numpy as np
from PIL import Image

import tools.generate_planet2_lod0_assets as g

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'additional_earth_imagery' / 'sources'
COLOR_COG = 'blue_marble_15s.tif'
ELEVATION_COG = 'elevation_7.5s.tif'
OCEAN_COG = 'ocean_mask_7.5s.tif'
OUT_ROOT = 'assets/earth_hires'
CACHE = ROOT / '.cache' / 'earth_hires'

# The same decode range as assets/earth and the regional bakes (the renderer warns when an overlay's
# differs, and the terrain would not meet). GEBCO's deepest is about -10,900 m and Everest 8,849 m.
HEIGHT_MIN_M = -11000.0
HEIGHT_MAX_M = 9000.0

FLOOR_LOD = 3          # every tile through this level (BASE_FULL_COVERAGE_LOD in the renderer)
STATS_LOD_SAMPLES = 16  # samples per tile edge for the plan's land and relief statistics
STATS_FACTOR = 8        # the plan's statistics read the elevation and mask averaged to 60"

# The power-of-two averages the COGs hold as overviews (factor 1 is the full resolution).
FACTORS = (1, 2, 4, 8, 16, 32, 64, 128, 256)


def regional_bboxes() -> list[tuple[float, float, float, float]]:
    """(lon_min, lon_max, lat_min, lat_max) of every Earth regional bake's widest area."""
    import tools.adaptive_lod as a
    boxes = [a.hawaii.WIDE_BBOX, a.hawaii.CHAIN_BBOX, a.CHIMBORAZO_WIDE_BBOX]
    boxes += [region['bands'][0][0] for name, region in a.EARTH_REGIONS.items() if name != 'chimborazo']
    return boxes


# ---------------------------------------------------------------------------
# Source levels
# ---------------------------------------------------------------------------

def source_arcsec(cog: str) -> float:
    return 15.0 if cog == COLOR_COG else 7.5


def factor_for(lod: int, size: int, cog: str, edge: bool) -> int:
    """The coarsest averaged copy of `cog` whose pixels are no larger than a tile's sample spacing at
    `lod` (the mean over a cube face: 90 degrees across 2^lod tiles of `size` samples)."""
    spacing = 90.0 * 3600.0 / ((1 << lod) * (size - 1 if edge else size))
    best = 1
    for f in FACTORS:
        if f * source_arcsec(cog) <= spacing:
            best = f
    return best


def cache_path(cog: str, factor: int) -> Path:
    return CACHE / f'{Path(cog).stem}_x{factor}.npy'


def export_level(sources: Path, cog: str, factor: int) -> Path:
    """Write `cog` averaged by `factor` (its overview) as a memory-mappable .npy, once.

    Colour is uint8 (H, W, 3); elevation float32 metres; the ocean mask uint8 (the fraction of ocean in
    each pixel, 255 = all ocean)."""
    import rasterio
    out = cache_path(cog, factor)
    if out.exists():
        return out
    CACHE.mkdir(parents=True, exist_ok=True)
    path = sources / cog
    if not path.exists():
        raise SystemExit(f'Source not found: {path} (build it with tools/sources, see docs/ASSETS.md)')
    kwargs = {}
    with rasterio.open(path) as src:
        if factor != 1:
            overviews = src.overviews(1)
            if factor not in overviews:
                raise SystemExit(f'{cog} has no overview with factor {factor} (it has {overviews})')
            kwargs['overview_level'] = overviews.index(factor)
    with rasterio.open(path, **kwargs) as src:
        h, w, bands = src.height, src.width, src.count
        dtype = np.uint8 if src.dtypes[0] == 'uint8' else np.float32
        shape = (h, w, bands) if bands > 1 else (h, w)
        print(f'[earth_hires] exporting {cog} x{factor} ({w} x {h}) to {out.relative_to(ROOT)}', flush=True)
        tmp = out.with_name(f'{out.stem}.tmp{os.getpid()}.npy')
        arr = np.lib.format.open_memmap(tmp, mode='w+', dtype=dtype, shape=shape)
        rows = max(1, (1 << 28) // (w * bands * np.dtype(dtype).itemsize))
        for r0 in range(0, h, rows):
            r1 = min(h, r0 + rows)
            block = src.read(window=((r0, r1), (0, w)))
            arr[r0:r1] = np.moveaxis(block, 0, -1) if bands > 1 else block[0]
        arr.flush()
        del arr
    os.replace(tmp, out)
    return out


_LEVELS: dict[tuple[str, int], np.ndarray] = {}


def level(cog: str, factor: int) -> np.ndarray:
    key = (cog, factor)
    if key not in _LEVELS:
        _LEVELS[key] = np.load(cache_path(cog, factor), mmap_mode='r')
    return _LEVELS[key]


def lon_lat(dx, dy, dz):
    """Geodetic longitude and latitude in degrees of cube directions (the bake's convention, see
    generate_planet2_lod0_assets.direction_to_equirect_xy_grid)."""
    lon = np.degrees(np.arctan2(-dz, dx))
    lat = np.degrees(np.arctan2(dy, (1.0 - g.WGS84_E2) * np.sqrt(dx * dx + dz * dz)))
    return lon, lat


def sample(grid: np.ndarray, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Bilinear sample of a global pixel-is-area grid from (-180, 90) at the pixel centres, wrapping in
    longitude. Returns float64, with a trailing channel axis if the grid has one."""
    h, w = grid.shape[0], grid.shape[1]
    x = (lon + 180.0) / 360.0 * w - 0.5
    y = np.clip((90.0 - lat) / 180.0 * h - 0.5, 0.0, h - 1.0)
    x0f = np.floor(x)
    y0 = np.minimum(np.floor(y).astype(np.intp), h - 2)
    tx = x - x0f
    ty = y - y0
    x0 = np.mod(x0f.astype(np.intp), w)
    x1 = np.mod(x0 + 1, w)
    y1 = y0 + 1
    if grid.ndim == 3:
        tx = tx[..., None]
        ty = ty[..., None]
    c00 = grid[y0, x0].astype(np.float64)
    c10 = grid[y0, x1].astype(np.float64)
    c01 = grid[y1, x0].astype(np.float64)
    c11 = grid[y1, x1].astype(np.float64)
    top = c00 + (c10 - c00) * tx
    bottom = c01 + (c11 - c01) * tx
    return top + (bottom - top) * ty


# ---------------------------------------------------------------------------
# Tile plan
# ---------------------------------------------------------------------------

def _face_stats(face: str, deepest: int):
    """Per tile at level `deepest` of `face`, as [tile_y, tile_x] arrays: the number of land samples,
    the land fraction and the relief (standard deviation of the land samples' heights, m)."""
    n = 1 << deepest
    s = STATS_LOD_SAMPLES
    axis = -1.0 + 2.0 * (np.arange(n * s, dtype=np.float64) + 0.5) / (n * s)
    land_count = np.zeros((n, n), dtype=np.int32)
    relief = np.zeros((n, n), dtype=np.float32)
    # A band of tile rows at a time keeps the sample grids small at deep levels.
    band = max(1, (1 << 22) // (n * s * s))
    for r0 in range(0, n, band):
        r1 = min(n, r0 + band)
        u, v = np.meshgrid(axis, axis[r0 * s:r1 * s])
        lon, lat = lon_lat(*g.cube_to_direction_grid(face, u, v))
        meters = sample(level(ELEVATION_COG, STATS_FACTOR), lon, lat)
        land = sample(level(OCEAN_COG, STATS_FACTOR), lon, lat) < 127.5
        shape = (r1 - r0, s, n, s)
        land_b = land.reshape(shape)
        count = land_b.sum(axis=(1, 3))
        m = np.where(land_b, meters.reshape(shape), 0.0)
        mean = m.sum(axis=(1, 3)) / np.maximum(count, 1)
        var = (m * m).sum(axis=(1, 3)) / np.maximum(count, 1) - mean * mean
        land_count[r0:r1] = count
        relief[r0:r1] = np.sqrt(np.maximum(var, 0.0))
    return land_count, land_count / float(s * s), relief


def _tile_centres(n: int) -> np.ndarray:
    """Unit vectors of the centres of every tile of an n x n level, as (6, n, n, 3)."""
    axis = -1.0 + 2.0 * (np.arange(n) + 0.5) / n
    u, v = np.meshgrid(axis, axis)
    return np.stack([np.stack(g.cube_to_direction_grid(face, u, v), axis=-1) for face in g.FACES])


def plan_tiles(land_lod: int, mountain_lod: int, regional_lod: int, percentile: float,
               dilate: float) -> list[tuple[str, int, int, int]]:
    """The tiles to bake (see the module docstring), as (face, lod, x, y)."""
    from scipy.spatial import cKDTree
    import tools.bake_hawaii_bigisland_hires as hawaii

    deepest = max(FLOOR_LOD, land_lod, mountain_lod, regional_lod)
    n = 1 << deepest
    stats = [_face_stats(face, deepest) for face in g.FACES]
    land_count = np.stack([s[0] for s in stats])
    land_fraction = np.stack([s[1] for s in stats])
    relief = np.stack([s[2] for s in stats])

    # Leaf level wanted under each tile of the deepest level.
    target = np.full((6, n, n), FLOOR_LOD, dtype=np.int8)
    has_land = land_count > 0
    target[has_land] = land_lod

    # Rough terrain: relief over land above the percentile of mostly-land tiles at the mountain level.
    m = 1 << mountain_lod
    k = n // m
    mcount = land_count.reshape(6, m, k, m, k).sum(axis=(2, 4))
    mrelief = relief.reshape(6, m, k, m, k).max(axis=(2, 4))
    mfrac = land_fraction.reshape(6, m, k, m, k).mean(axis=(2, 4))
    threshold = float(np.percentile(mrelief[mfrac >= 0.5], percentile))
    rough = (mcount >= 3) & (mrelief >= threshold)
    centres = _tile_centres(m).reshape(-1, 3)
    tree = cKDTree(centres)
    radius = dilate * math.radians(90.0 / m)        # chord ~ angle at these sizes
    near = np.zeros(centres.shape[0], dtype=bool)
    for hits in tree.query_ball_point(centres[rough.ravel()], radius + 1e-9):
        near[hits] = True
    near = near.reshape(6, m, m) & (mcount > 0)     # not out into open ocean
    near_up = np.repeat(np.repeat(near, k, axis=1), k, axis=2)
    target = np.where(near_up, np.maximum(target, mountain_lod), target)
    print(f'[earth_hires] relief threshold (p{percentile:g} of land tiles at LOD {mountain_lod}) = '
          f'{threshold:.0f} m; rough tiles {int(rough.sum())}, with their surroundings {int(near.sum())}')

    # Regional bakes' areas.
    r = 1 << regional_lod
    rk = n // r
    face_index = {face: i for i, face in enumerate(g.FACES)}
    for bbox in regional_bboxes():
        for face, lod, x, y in hawaii.collect_island_tiles(bbox, regional_lod, regional_lod, 0.02):
            cells = target[face_index[face], y * rk:(y + 1) * rk, x * rk:(x + 1) * rk]
            np.maximum(cells, regional_lod, out=cells)

    # Quadtree closure: a tile at level l has children if anything under it wants deeper than l.
    tiles = []
    wanted = target
    subdivided = {}
    for lod in range(deepest - 1, -1, -1):
        size = wanted.shape[1] // 2
        wanted = wanted.reshape(6, size, 2, size, 2).max(axis=(2, 4))
        subdivided[lod] = wanted > lod
    for lod in range(deepest + 1):
        count = 1 << lod
        if lod <= FLOOR_LOD:
            present = np.ones((6, count, count), dtype=bool)
        else:
            parent = subdivided[lod - 1]
            present = np.repeat(np.repeat(parent, 2, axis=1), 2, axis=2)
        for f, y, x in zip(*np.nonzero(present)):
            tiles.append((g.FACES[f], lod, int(x), int(y)))
    return tiles


def describe(tiles, color_size: int, height_size: int) -> None:
    per_lod: dict[int, int] = {}
    for tile in tiles:
        per_lod[tile[1]] = per_lod.get(tile[1], 0) + 1
    # KTX2/UASTC: one byte per texel, plus a third for the mipmaps; heights: two bytes per sample.
    size = len(tiles) * (color_size * color_size * 4 / 3 + height_size * height_size * 2)
    counts = ', '.join(f'LOD {lod}: {n}' for lod, n in sorted(per_lod.items()))
    print(f'[earth_hires] {len(tiles)} tiles ({counts}), about {size / 1e9:.1f} GB')


# ---------------------------------------------------------------------------
# Baking
# ---------------------------------------------------------------------------

def bake_tile(task: tuple) -> tuple[str, dict, bool]:
    face, lod, x, y, color_size, height_size, out, ktx2, resume = task
    color_dir = out / 'color' / face / str(lod) / str(x)
    height_dir = out / 'height' / face / str(lod) / str(x)
    color_dir.mkdir(parents=True, exist_ok=True)
    height_dir.mkdir(parents=True, exist_ok=True)

    # Heights: edge-inclusive, so neighbouring tiles share their edge samples.
    u, v = g._tile_uv_grids(lod, x, y, height_size, align='edge')
    lon, lat = lon_lat(*g.cube_to_direction_grid(face, u, v))
    hf = factor_for(lod, height_size, ELEVATION_COG, edge=True)
    meters = sample(level(ELEVATION_COG, hf), lon, lat)
    ocean = sample(level(OCEAN_COG, hf), lon, lat) / 255.0
    codes = np.clip(np.round((meters - HEIGHT_MIN_M) / (HEIGHT_MAX_M - HEIGHT_MIN_M) * 65535.0),
                    0, 65535).astype('<u2')
    codes.tofile(height_dir / f'{y}.bin')

    color_path = color_dir / f'{y}.ktx2'
    encoded = color_path.exists() and resume
    if not encoded:
        u, v = g._tile_uv_grids(lod, x, y, color_size, align='center')
        lon, lat = lon_lat(*g.cube_to_direction_grid(face, u, v))
        rgb = sample(level(COLOR_COG, factor_for(lod, color_size, COLOR_COG, edge=False)), lon, lat)
        png = color_dir / f'{y}.png'
        Image.fromarray(np.clip(np.round(rgb), 0, 255).astype(np.uint8)).save(png)
        if ktx2 and g.try_encode_ktx2(png, color_path):
            png.unlink(missing_ok=True)
            encoded = True

    land = float(1.0 - ocean.mean())
    entry = {
        'roughness': float(np.std(codes.astype(np.float32) / 65535.0)),
        'landFraction': round(land, 4),
        'waterFraction': round(1.0 - land, 4),
        'width': int(height_size),
        'height': int(height_size),
    }
    return f'{face}/{lod}/{x}/{y}', entry, encoded


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--sources', type=Path, default=SOURCES, help='Folder of the source COGs.')
    parser.add_argument('--out', type=str, default=OUT_ROOT)
    parser.add_argument('--land-lod', type=int, default=6, help='Deepest level over land (default 6).')
    parser.add_argument('--mountain-lod', type=int, default=7,
                        help='Deepest level over rough terrain (default 7: Blue Marble at full resolution).')
    parser.add_argument('--regional-lod', type=int, default=6,
                        help="Deepest level over the regional bakes' areas (default 6).")
    parser.add_argument('--percentile', type=float, default=75.0,
                        help='Rough terrain: relief above this percentile of land tiles (default 75).')
    parser.add_argument('--dilate', type=float, default=2.0,
                        help='Also refine tiles within this many tiles of rough terrain (default 2).')
    parser.add_argument('--color-size', type=int, default=256)
    parser.add_argument('--height-size', type=int, default=64)
    parser.add_argument('--jobs', type=int, default=max(1, min(os.cpu_count() or 1, 8)))
    parser.add_argument('--estimate', action='store_true', help='Print the tile plan and its size, and stop.')
    parser.add_argument('--resume', action='store_true',
                        help='Keep colour tiles already in the output folder (an interrupted bake).')
    parser.add_argument('--no-ktx2', action='store_true', help='Leave PNG colour tiles (the app needs KTX2).')
    args = parser.parse_args()

    if args.land_lod < FLOOR_LOD or args.mountain_lod < FLOOR_LOD or args.regional_lod < FLOOR_LOD:
        raise SystemExit(f'The levels must be at least {FLOOR_LOD}')
    g.set_planet_eccentricity_squared(g.WGS84_E2)
    ktx2 = not args.no_ktx2
    if ktx2 and not args.estimate and not shutil.which('toktx') and not os.environ.get('KTX_TOOLS_BIN'):
        raise SystemExit('toktx (KTX-Software) is needed: https://github.com/KhronosGroup/KTX-Software/releases '
                         '(or pass --no-ktx2 for PNG tiles, which the app does not load)')

    export_level(args.sources, ELEVATION_COG, STATS_FACTOR)
    export_level(args.sources, OCEAN_COG, STATS_FACTOR)
    tiles = plan_tiles(args.land_lod, args.mountain_lod, args.regional_lod, args.percentile, args.dilate)
    describe(tiles, args.color_size, args.height_size)
    lods = sorted({t[1] for t in tiles})
    for lod in lods:
        hf = factor_for(lod, args.height_size, ELEVATION_COG, edge=True)
        cf = factor_for(lod, args.color_size, COLOR_COG, edge=False)
        print(f'  LOD {lod}: colour from Blue Marble x{cf} ({15 * cf:g}"), '
              f'height from elevation x{hf} ({7.5 * hf:g}")')
    if args.estimate:
        return

    for lod in lods:
        hf = factor_for(lod, args.height_size, ELEVATION_COG, edge=True)
        export_level(args.sources, ELEVATION_COG, hf)
        export_level(args.sources, OCEAN_COG, hf)
        export_level(args.sources, COLOR_COG, factor_for(lod, args.color_size, COLOR_COG, edge=False))

    out = ROOT / args.out
    manifest_path = out / 'manifest.json'
    manifest_path.unlink(missing_ok=True)       # the folder is not usable until the bake is complete
    if not args.resume:
        for d in (out / 'color', out / 'height'):
            shutil.rmtree(d, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)

    # Coarse levels first, so an interrupted bake has its slowest-to-redo work done.
    tasks = [(face, lod, x, y, args.color_size, args.height_size, out, ktx2, args.resume)
             for face, lod, x, y in sorted(tiles, key=lambda t: (t[1], t[0], t[2], t[3]))]
    entries: dict[str, dict] = {}
    unencoded = 0
    started = time.time()
    with concurrent.futures.ProcessPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for i, (tile_id, entry, encoded) in enumerate(pool.map(bake_tile, tasks, chunksize=16), 1):
            entries[tile_id] = entry
            unencoded += 0 if encoded else 1
            if i % 1000 == 0 or i == len(tasks):
                elapsed = time.time() - started
                print(f'  {i}/{len(tasks)} tiles, {elapsed / 60:.0f} min, '
                      f'about {elapsed / i * (len(tasks) - i) / 60:.0f} min to go', flush=True)

    manifest = {
        'maxAvailableLod': max(lods),
        'minHeight': HEIGHT_MIN_M,
        'maxHeight': HEIGHT_MAX_M,
        # Regional bakes are drawn from this level down (see the renderer's overlay cut-off), so from
        # further out the globe is all Blue Marble.
        'overlayMinLod': args.regional_lod + 1,
        'sources': {
            'color': 'NASA Earth Observatory, Blue Marble Next Generation (April 2004), repaired',
            'elevation': 'USGS GMTED2010 (land); GEBCO Compilation Group (2026) GEBCO 2026 Grid '
                         '(doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa) (sea floor, and land GMTED lacks)',
        },
        'tiles': entries,
    }
    manifest_path.write_text(json.dumps(manifest, indent=1), encoding='utf-8')
    if ktx2 and unencoded:
        print(f'[earth_hires] WARNING: {unencoded} colour tiles were not KTX2-encoded')
    print(f'[earth_hires] wrote {len(entries)} tiles and the manifest to {out.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
