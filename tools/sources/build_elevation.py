"""Global elevation (metres, land and sea floor) on the 7.5 arc-second grid, and an ocean mask, as
Cloud-Optimized GeoTIFFs:
  - elevation_7.5s.tif: float32, the land elevation (land_elevation_gmted_7.5s.tif, see
    build_land_elevation.py) with the sea floor of the GEBCO 2026 Grid where the cell is ocean.
  - ocean_mask_7.5s.tif: uint8, 255 where the cell is ocean, else 0 (the overviews average it, so they hold
    the fraction of ocean). The renderer draws the sea only over it.

Which cells are ocean: open water connected to the world ocean, so that basins below sea level that are
not (the Dead Sea, the Caspian, Death Valley, the Dutch polders) keep their land heights and are not
flooded with sea floor. On GEBCO's 15" grid a cell can be ocean if
  - its Type Identifier is not 0 (0 is land; the other codes say where a depth came from),
  - GEBCO's elevation there is at or below 0, and
  - the land elevation is between 0 and SEA_TOLERANCE in at least one of its four 7.5" pixels (GMTED has no
    bathymetry: it is 0 over the sea, or a little above it on some Arctic shelves, where exactly 0 would cut
    Foxe Basin and the East Siberian Sea off from the ocean; lakes, polders and depressions have their own
    surface heights, and polders and depressions are below 0),
and it is ocean if it is connected (8-connected, across the 180-degree meridian too) to the open ocean
(SEEDS). TID alone is not enough: GEBCO also codes the bed under the Antarctic ice, the Caspian, the Great
Lakes, polders and parts of Death Valley with non-zero TIDs. A 7.5" pixel is ocean if its 15" cell is and
its land elevation is at most SEA_TOLERANCE (GMTED is also negative over a little coastal water, in fjords),
so the coastline keeps GMTED's 7.5" detail.

Enclosed water bodies keep the land elevation, but GMTED is 0 (its no-data value) over parts of some of
them, such as a band through the middle of the Caspian Sea, whose surface is -27 m elsewhere. So an enclosed
water body (a connected group of candidate cells that is not ocean) that is a hole in a lake surface has its
0 m pixels set to that surface's height: the median of the land heights in and around it (outside the
0..SEA_TOLERANCE range), if at least half of them are within 1 m of it (a flat lake surface, not the shore of
a lagoon) and it is more than LAKE_MIN_LEVEL from 0.

Over the ocean the elevation is GEBCO's, bilinearly resampled at the 7.5" pixel centres (GEBCO is
pixel-centre registered on the same 15" lattice, so 7.5" pixel r lies at GEBCO row r/2 - 0.25), ramped in
from the shore over COAST_RAMP pixels so that the sea floor does not step down at the coastline, and never
above 0. GEBCO's grid does not quite meet across the 180-degree meridian (the step across it is 1.5-2.3x the
steps beside it at most latitudes), so where both sides are ocean the first and last WRAP_BLEND columns are
moved to meet with the slope beside them (the land elevation's own wrap is blended by build_land_elevation).

    .venv/bin/python -m tools.sources.build_elevation [--land PATH] [--gebco-tiles DIR] [--out-dir DIR]
"""

from __future__ import annotations

import argparse
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from rasterio.transform import from_origin
from rasterio.windows import Window
from scipy import ndimage

from tools.sources import gebco as G

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'additional_earth_imagery' / 'sources'
PER_DEGREE = 480
WIDTH, HEIGHT = 360 * PER_DEGREE, 180 * PER_DEGREE
BLOCK = 480            # 7.5" rows per block (1 degree)
COAST_RAMP = 4         # 7.5" pixels over which the sea floor ramps in from the shore
LAKE_MIN_LEVEL = 1.0   # an enclosed water body's 0 m pixels take its surface height if it is this far from 0
SEA_TOLERANCE = 2.0    # land heights from 0 to this (m) can be sea (GMTED is slightly above 0 on Arctic shelves)
WRAP_BLEND = 16        # 7.5" columns either side of 180 degrees over which GEBCO's two sides are blended to meet
# Points in the open ocean (latitude, longitude): all must end up in the same connected ocean.
SEEDS = {'Pacific': (0.0, -150.0), 'Atlantic': (30.0, -40.0), 'Indian': (-20.0, 80.0), 'Arctic': (88.0, 0.0),
         'Southern': (-60.0, 0.0)}

# Set in each worker by init().
_land = _gebco = _tid = _code15 = _lakes = None


def init(land_path: str, tiles_dir: str | None, code15_path: str | None) -> None:
    global _land, _gebco, _tid, _code15, _lakes
    _land = rasterio.open(land_path)
    tiles = Path(tiles_dir) if tiles_dir else None
    _gebco, _tid = G.Gebco('elevation', tiles), G.Gebco('tid', tiles)
    if code15_path:
        _code15 = np.load(code15_path, mmap_mode='r')
        with np.load(Path(code15_path).with_suffix('.lakes.npz')) as z:
            _lakes = (z['index'], z['level'])


def land_rows(r0: int, r1: int) -> np.ndarray:
    """Land elevation rows r0..r1 (clamped at the poles)."""
    a, b = max(0, r0), min(HEIGHT, r1)
    out = _land.read(1, window=Window(0, a, WIDTH, b - a))
    return out[np.clip(np.arange(r0, r1), 0, HEIGHT - 1) - a]


def candidates(R0: int) -> tuple[int, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Pass 1: the ocean candidates of 15" rows R0..R0 + BLOCK/2; and, for the candidate cells with land
    pixels outside 0..SEA_TOLERANCE and for the other cells next to candidates (their shores), their flat
    (global 15") indices and the mean of those pixels."""
    R1 = min(G.HEIGHT, R0 + BLOCK // 2)
    land = land_rows(2 * R0, 2 * R1).reshape(R1 - R0, 2, G.WIDTH, 2)
    other = (land < 0) | (land > SEA_TOLERANCE)
    count = other.sum(axis=(1, 3))
    cand = (_tid.rows(R0, R1) != 0) & (_gebco.rows(R0, R1) <= 0) & (count < 4)
    mean = np.where(other, land, 0).sum(axis=(1, 3)) / np.maximum(count, 1)
    mixed = cand & (count > 0)
    shore = ndimage.binary_dilation(cand, structure=np.ones((3, 3), dtype=bool)) & ~cand & (count > 0)
    return (R0, cand, np.flatnonzero(mixed) + R0 * G.WIDTH, mean[mixed].astype(np.float32),
            np.flatnonzero(shore) + R0 * G.WIDTH, mean[shore].astype(np.float32))


def water_bodies(holder: list, index: np.ndarray, mean: np.ndarray, shore_index: np.ndarray,
                 shore_mean: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Pass 2: from the candidates (holder = [candidates], emptied to free them early), a uint8 map of 15" cells: 1 where
    they are connected to the open ocean, 2 in enclosed water bodies with a surface height (see the module
    docstring); and the flat indices and surface heights of the cells marked 2."""
    t = time.time()
    labels, n = ndimage.label(holder.pop(), structure=np.ones((3, 3), dtype=bool))
    print(f'{n} connected water bodies ({time.time() - t:.0f} s)', flush=True)
    # Join the bodies that meet across the 180-degree meridian (8-connected: rows r-1..r+1).
    parent = np.arange(n + 1)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    left, right = labels[:, 0], labels[:, -1]
    for d in (-1, 0, 1):
        l = left[max(0, d):len(left) + min(0, d)]
        r = right[max(0, -d):len(right) + min(0, -d)]
        for a, b in set(zip(l[(l > 0) & (r > 0)].tolist(), r[(l > 0) & (r > 0)].tolist())):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
    roots = np.array([find(a) for a in range(n + 1)])
    seeds = {}
    for name, (lat, lon) in SEEDS.items():
        R, C = int((90.0 - lat) * G.PER_DEGREE), int((lon + 180.0) * G.PER_DEGREE)
        seeds[name] = int(roots[labels[R, C]])
    if len(set(seeds.values())) != 1 or 0 in seeds.values():
        raise RuntimeError(f'the open-ocean seeds are not all in one connected ocean: {seeds}')
    ocean_root = next(iter(seeds.values()))
    keep = roots == ocean_root
    keep[0] = False
    # Report the largest water bodies that are not part of the ocean (they keep their land heights).
    counts = np.bincount(labels[::4, ::4].ravel(), minlength=n + 1)   # sampled, for the report only
    report = {}
    for lab in np.argsort(-counts)[:40]:
        if lab and not keep[lab] and counts[lab] > 0:
            ys, xs = np.nonzero(labels[::4, ::4] == lab)
            report[int(lab)] = (int(counts[lab]) * 16, 90 - (ys.mean() * 4 + 0.5) / G.PER_DEGREE,
                                -180 + (xs.mean() * 4 + 0.5) / G.PER_DEGREE)
            if len(report) >= 12:
                break
    # Enclosed water bodies: their surface height from the land heights in their cells and on their shores
    # (a shore cell belongs to the body of any of its eight neighbours).
    lab_in = labels.ravel()[index]
    R, C = np.divmod(shore_index, G.WIDTH)
    lab_shore = np.zeros(shore_index.size, dtype=labels.dtype)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr or dc:
                np.maximum(lab_shore, labels[np.clip(R + dr, 0, G.HEIGHT - 1), (C + dc) % G.WIDTH], out=lab_shore)
    lab = np.concatenate([lab_in, lab_shore])
    mean = np.concatenate([mean, shore_mean])
    sel = (lab > 0) & ~keep[lab]
    lab, mean = lab[sel], mean[sel]
    level = np.full(n + 1, np.nan, dtype=np.float32)
    if lab.size:
        order = np.argsort(lab, kind='stable')
        lab, mean = lab[order], mean[order]
        uniq, first = np.unique(lab, return_index=True)
        for u, a, b in zip(uniq, first, np.append(first[1:], lab.size)):
            m = np.median(mean[a:b])
            if b - a >= 20 and np.mean(np.abs(mean[a:b] - m) <= 1.0) >= 0.5:
                level[u] = m
    lake = np.isfinite(level) & (np.abs(level) > LAKE_MIN_LEVEL)
    for k in report:
        if lake[k]:
            report[k] = report[k] + (float(level[k]),)
    lut = np.where(keep, 1, np.where(lake, 2, 0)).astype(np.uint8)
    code = lut[labels]
    lake_index = np.flatnonzero(code == 2)
    lake_level = level[labels.ravel()[lake_index]]
    print(f'{int(lake.sum())} enclosed water bodies with a surface height ({lake_index.size} cells)', flush=True)
    return code, lake_index, lake_level, report


def final_block(r0: int) -> tuple[int, np.ndarray, np.ndarray]:
    """Pass 3: elevation and ocean mask of 7.5" rows r0..r0 + BLOCK."""
    r1 = min(HEIGHT, r0 + BLOCK)
    h = COAST_RAMP
    land = land_rows(r0 - h, r1 + h)
    rows15 = np.clip(np.arange(r0 - h, r1 + h) // 2, 0, G.HEIGHT - 1)
    lo15, hi15 = int(rows15.min()), int(rows15.max()) + 1
    code = np.asarray(_code15[lo15:hi15])
    ocean = np.repeat((code == 1)[rows15 - lo15], 2, axis=1) & (land <= SEA_TOLERANCE)
    # Enclosed water bodies' surface heights in these rows.
    index, level = _lakes
    a, b = np.searchsorted(index, [lo15 * G.WIDTH, hi15 * G.WIDTH])
    lake15 = np.full(code.shape, np.nan, dtype=np.float32)
    lake15.ravel()[index[a:b] - lo15 * G.WIDTH] = level[a:b]
    lake = np.repeat(lake15[rows15 - lo15], 2, axis=1)
    if ocean.all():
        ramp = np.ones(ocean.shape, dtype=np.float32)
    elif ocean.any():
        padded = np.concatenate([ocean[:, -h:], ocean, ocean[:, :h]], axis=1)   # wrap in longitude
        dist = ndimage.distance_transform_edt(padded)[:, h:-h]
        ramp = np.minimum(1.0, dist / COAST_RAMP).astype(np.float32)
    else:
        ramp = np.zeros(ocean.shape, dtype=np.float32)
    ocean, ramp, land, lake = ocean[h:-h], ramp[h:-h], land[h:-h], lake[h:-h]
    fill = (land >= 0) & (land <= SEA_TOLERANCE) & ~ocean & np.isfinite(lake)
    land = np.where(fill, lake, land)
    # GEBCO rows for 7.5" rows r0..r1 (r0 even): r0/2 - 1 .. r1/2 + 1.
    sea = G.upsample2(_gebco.rows(r0 // 2 - 1, (r1 + 1) // 2 + 1))[:r1 - r0]
    elevation = np.where(ocean, np.minimum(0.0, ramp * sea), land).astype(np.float32)
    # The 180-degree meridian, over the ocean.
    left, right = elevation[:, 0].copy(), elevation[:, -1].copy()
    slope = 0.5 * ((elevation[:, 1] - left) + (right - elevation[:, -2]))
    mid = 0.5 * (left + right)
    both = ocean[:, 0] & ocean[:, -1]
    for k in range(WRAP_BLEND):
        w = np.where(both, 0.5 * (1.0 + np.cos(np.pi * k / WRAP_BLEND)), 0.0).astype(np.float32)
        for col, target, own in ((k, mid + 0.5 * slope, left), (-1 - k, mid - 0.5 * slope, right)):
            o = ocean[:, col]
            elevation[o, col] = np.minimum(0.0, elevation[o, col] + w[o] * (target[o] - own[o]))
    return r0, elevation, (ocean * np.uint8(255)).astype(np.uint8)


def to_cog(staging: Path, out: Path, **options) -> None:
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'):
        rasterio.shutil.copy(staging, out, driver='COG', blocksize=512, overview_resampling='average',
                             bigtiff='YES', **options)
    staging.unlink()
    print(f'wrote {out} ({out.stat().st_size / 1e9:.1f} GB)', flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--land', type=Path, default=SOURCES / 'land_elevation_gmted_7.5s.tif')
    parser.add_argument('--gebco-tiles', type=Path, default=None,
                        help='folder of extracted GEBCO tiles (default: extract GEBCO_2026/*.zip into GEBCO_2026/extracted)')
    parser.add_argument('--out-dir', type=Path, default=SOURCES)
    parser.add_argument('--jobs', type=int, default=6)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for kind in ('elevation', 'tid'):
        G.extract(kind, args.gebco_tiles)
    start = time.time()
    tiles = str(args.gebco_tiles) if args.gebco_tiles else None

    code15_path = args.out_dir / 'water_15s.staging.npy'
    cand = np.zeros((G.HEIGHT, G.WIDTH), dtype=bool)
    parts: list[list] = [[], [], [], []]
    with Pool(args.jobs, init, (str(args.land), tiles, None)) as pool:
        for R0, block, *sparse in pool.imap_unordered(candidates, range(0, G.HEIGHT, BLOCK // 2)):
            cand[R0:R0 + block.shape[0]] = block
            for part, a in zip(parts, sparse):
                part.append(a)
    print(f'pass 1: ocean candidates ({time.time() - start:.0f} s)', flush=True)
    holder = [cand]
    del cand
    code15, lake_index, lake_level, others = water_bodies(holder, *[np.concatenate(p) for p in parts])
    np.save(code15_path, code15)
    np.savez(code15_path.with_suffix('.lakes.npz'), index=lake_index, level=lake_level)
    del code15
    print(f'pass 2: connected ocean ({time.time() - start:.0f} s). Largest water bodies left as land:', flush=True)
    for v in others.values():
        print(f'  ~{v[0]} cells around {v[1]:.2f}, {v[2]:.2f}' + (f', surface {v[3]:.1f} m' if len(v) > 3 else ''), flush=True)

    transform = from_origin(-180.0, 90.0, 1.0 / PER_DEGREE, 1.0 / PER_DEGREE)
    common = dict(driver='GTiff', width=WIDTH, height=HEIGHT, count=1, crs='EPSG:4326', transform=transform,
                  tiled=True, blockxsize=512, blockysize=512, compress='deflate', bigtiff='YES')
    elev_staging, mask_staging = args.out_dir / 'elevation_7.5s.staging.tif', args.out_dir / 'ocean_mask_7.5s.staging.tif'
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'), \
            rasterio.open(elev_staging, 'w', dtype='float32', predictor=3, **common) as de, \
            rasterio.open(mask_staging, 'w', dtype='uint8', predictor=2, **common) as dm, \
            Pool(args.jobs, init, (str(args.land), tiles, str(code15_path))) as pool:
        for n, (r0, elevation, mask) in enumerate(pool.imap(final_block, range(0, HEIGHT, BLOCK)), 1):
            window = Window(0, r0, WIDTH, elevation.shape[0])
            de.write(elevation, 1, window=window)
            dm.write(mask, 1, window=window)
            if n % 10 == 0:
                print(f'pass 3: rows {r0 + elevation.shape[0]}/{HEIGHT} ({time.time() - start:.0f} s)', flush=True)
    code15_path.unlink()
    code15_path.with_suffix('.lakes.npz').unlink()
    to_cog(elev_staging, args.out_dir / 'elevation_7.5s.tif', compress='DEFLATE', predictor=3, level=6)
    to_cog(mask_staging, args.out_dir / 'ocean_mask_7.5s.tif', compress='DEFLATE', predictor=2, level=6)
    print(f'done ({time.time() - start:.0f} s)')


if __name__ == '__main__':
    main()
