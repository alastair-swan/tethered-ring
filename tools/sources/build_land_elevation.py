"""Global land elevation (metres; 0 over the sea) on a 7.5 arc-second grid, as a Cloud-Optimized GeoTIFF.

Assembled from (see docs/ASSETS.md):
  - GMTED2010 7.5" tiles TILE_A1..TILE_C2.psb (float32 metres, 57600 x 38400 each, a 3 x 2 grid covering
    180W..180E, 90N..70S: A, B, C are 120 degrees of longitude each from 180W; 1, 2 are 90N..10N, 10N..70S).
    They hold data only from 84N to 56S (GMTED2010's coverage) and are exactly 0 over the sea.
  - the GEBCO 2026 Grid (15", ice surface version; tools/sources/gebco.py) where GMTED has nothing:
    Greenland, Antarctica and the islands south of 56S. Its ice surfaces come from BedMachine Greenland v6 and
    BedMachine Antarctica v3; compared with the 30" GREENLAND.psb and ANTARTIC.psb patches that came with the
    tiles, it has 1.8x (Greenland) to 3.6x (Antarctica) the detail, its summits are higher and closer to the
    surveyed heights (Mt Menzies 3146 m against 2128; Gunnbjorn Fjeld 3476 against 3327), and it has the
    islands the patches lack or flatten (South Sandwich, Peter I, the Balleny and South Orkney Islands).
Defects repaired (found by measuring the step between neighbouring rows and columns, and against GEBCO):
  - No data in the tiles: north of 84N they hold -1 and south of 56S constant fill values in 30-degree strips
    (-1, -2, -20, -28, -172, -192). Both are treated as no data (the Arctic Ocean is 0 m; south of 56S, GEBCO).
  - Land GMTED lacks, filled from GEBCO: Greenland (all of it), holes in its high-Arctic islands (the ice caps
    of Svalbard and Franz Josef Land, parts of the Canadian Arctic Archipelago), islands it misses, and the
    eastern tip of Taveuni, Fiji, which tile A cuts off at 180 degrees. They are found on GEBCO's 15" grid as
    connected regions of GEBCO land (TID 0, above 0 m) with no GMTED data in any of their 7.5" pixels, that
    are at least three cells wide somewhere (so not a sliver along a coastline where the two datasets'
    coastlines differ) and rise at least MISSING_MIN_HEIGHT (not a tidal flat). The 7.5" pixels that are 0 in
    GMTED are filled in those cells and in the GEBCO land cells around them, so that no 0 m trench is left
    between GMTED's land and the fill.
  - Void-fill artefacts: places where GMTED is below sea level but GEBCO (SRTM15+) has land above it, by up
    to hundreds of metres. They are a pit in the Sahara (29.47N 8.00E, down to -665 m among 300 m terrain)
    and whole areas of the fjords and ice fields of Patagonia (down to -424 m where GEBCO has 200-400 m of
    land), Tierra del Fuego and South Georgia. A connected region of pixels below -10 m where GEBCO is above
    0 m is replaced by GEBCO if GEBCO is more than 2 PIT_DEPTH higher somewhere in it, or more than PIT_DEPTH
    higher and the region goes below -PIT_DEPTH, with the pixels around it (two pixels) that are more than
    PIT_DEPTH / 3 below GEBCO: 238 regions, 7505 pixels. Real depressions are below sea level in GEBCO too
    (the Dead Sea, the Caspian, Qattara, Death Valley, the Dutch polders, and the Fushun and Palabora
    open-pit mines), so they are kept, and the steep shores of the Dead Sea and Lake Enriquillo, where GEBCO's
    coarser grid is above sea level, are not deep or far enough below it to count.
  - The 180-degree meridian: tiles A and C do not quite meet there (in Chukotka the step across it is 2.4x
    the steps beside it, and does not correlate with the slope: different data, not an offset), so the
    first and last WRAP_BLEND columns are blended towards their common edge height.
The grid is pixel-is-area: pixel (row r, column c) covers latitudes 90 - r/480 .. 90 - (r+1)/480 and
longitudes -180 + c/480 .. -180 + (c+1)/480. GEBCO is resampled bilinearly at the 7.5" pixel centres.

Oceans are exactly 0 m here: build_elevation.py adds the sea floor.

    .venv/bin/python -m tools.sources.build_land_elevation [--out PATH] [--gebco-tiles DIR] [--jobs N]
"""

from __future__ import annotations

import argparse
import os
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from rasterio.transform import from_origin
from scipy import ndimage

from tools.sources import gebco as G

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'additional_earth_imagery' / 'TetheredRing' / 'textures' / 'DisplacementMaps'
DEFAULT_OUT = ROOT / 'additional_earth_imagery' / 'sources' / 'land_elevation_gmted_7.5s.tif'

PER_DEGREE = 480                      # 7.5" pixels per degree
WIDTH, HEIGHT = 360 * PER_DEGREE, 180 * PER_DEGREE
TILE_W, TILE_H = 57600, 38400
TILES = {(c, r): (r * TILE_H, 'ABC'.index(c) * TILE_W) for c in 'ABC' for r in (0, 1)}   # -> (row, col) origin
GMTED_ROWS = (6 * PER_DEGREE, 146 * PER_DEGREE)    # 84N .. 56S: where the tiles have data
BLOCK = 960                           # rows per block (2 degrees)
MISSING_MIN_HEIGHT = 5.0              # missing land must rise at least this high (not a tidal flat or a shoal)
PIT_DEPTH = 150.0                     # metres below GEBCO's land that make a void-fill artefact
WRAP_BLEND = 16                       # columns either side of 180 degrees blended to meet

_tiles = _gebco = _tid = _missing = None


def psb_composite(path: Path) -> np.ndarray:
    """The raw composite image of a PSB (it is stored last, after a 2-byte compression flag of 0, as
    big-endian planar channels), memory-mapped as (channels, height, width)."""
    with open(path, 'rb') as f:
        b = f.read(26)
    if b[:4] != b'8BPS':
        raise ValueError(f'{path}: not a PSD/PSB file')
    channels = int.from_bytes(b[12:14], 'big')
    height, width = int.from_bytes(b[14:18], 'big'), int.from_bytes(b[18:22], 'big')
    dtype = np.dtype({8: '>u1', 16: '>u2', 32: '>f4'}[int.from_bytes(b[22:24], 'big')])
    start = os.path.getsize(path) - channels * height * width * dtype.itemsize
    with open(path, 'rb') as f:
        f.seek(start - 2)
        if int.from_bytes(f.read(2), 'big') != 0:
            raise ValueError(f'{path}: composite image is compressed')
    return np.memmap(path, dtype=dtype, mode='r', offset=start, shape=(channels, height, width))


def init(tiles_dir: str | None, missing_path: str | None) -> None:
    global _tiles, _gebco, _tid, _missing
    _tiles = {k: psb_composite(SOURCES / f'TILE_{k[0]}{k[1] + 1}.psb')[0] for k in TILES}
    d = Path(tiles_dir) if tiles_dir else None
    _gebco, _tid = G.Gebco('elevation', d), G.Gebco('tid', d)
    _missing = np.load(missing_path, mmap_mode='r') if missing_path else None


def gmted(r0: int, r1: int) -> np.ndarray:
    """GMTED rows r0..r1, all columns, 0 where the tiles have no data."""
    out = np.zeros((r1 - r0, WIDTH), dtype=np.float32)
    a, b = max(r0, GMTED_ROWS[0]), min(r1, GMTED_ROWS[1])
    for (c, r), (ty, tx) in TILES.items():
        lo, hi = max(a, ty), min(b, ty + TILE_H)
        if lo < hi:
            out[lo - r0:hi - r0, tx:tx + TILE_W] = _tiles[(c, r)][lo - ty:hi - ty]
    return out


def missing_candidates(R0: int) -> tuple[int, np.ndarray, np.ndarray, np.ndarray]:
    """For 15" rows R0..: GEBCO land (TID 0, above 0 m), whether GMTED has no data in the cell, and whether
    GEBCO is at least MISSING_MIN_HEIGHT there."""
    R1 = min(G.HEIGHT, R0 + BLOCK // 2)
    height = _gebco.rows(R0, R1)
    land = (_tid.rows(R0, R1) == 0) & (height > 0)
    empty = (gmted(2 * R0, 2 * R1) == 0).reshape(R1 - R0, 2, G.WIDTH, 2).all(axis=(1, 3))
    return R0, land, empty, height >= MISSING_MIN_HEIGHT


def missing_land(tiles_dir: str | None, jobs: int, path: Path) -> None:
    """The 15" cells to fill from GEBCO, between 84N and 56S, saved to `path` as a uint8 array (15" rows,
    columns): 1 in the regions GMTED misses (see the module docstring), 2 in the GEBCO land cells around them."""
    R0s, R1s = GMTED_ROWS[0] // 2, GMTED_ROWS[1] // 2
    shape = (R1s - R0s, G.WIDTH)
    land, cand, high = np.zeros(shape, dtype=bool), np.zeros(shape, dtype=bool), np.zeros(shape, dtype=bool)
    with Pool(jobs, init, (tiles_dir, None)) as pool:
        for R0, l, e, h in pool.imap_unordered(missing_candidates, range(R0s, R1s, BLOCK // 2)):
            a, b = R0 - R0s, R0 - R0s + l.shape[0]
            land[a:b], cand[a:b], high[a:b] = l, l & e, l & e & h
    labels, n = ndimage.label(cand, structure=np.ones((3, 3), dtype=bool))
    wide = np.zeros(n + 1, dtype=np.int64)
    tall = np.zeros(n + 1, dtype=np.int64)
    total = np.zeros(n + 1, dtype=np.int64)
    for a in range(0, shape[0], 2400):     # in strips (bincount copies its input to int64), with a 1-row halo
        lo, hi = max(0, a - 1), min(shape[0], a + 2401)
        inner = ndimage.binary_erosion(cand[lo:hi], structure=np.ones((3, 3), dtype=bool))[a - lo:a - lo + 2400]
        lab = labels[a:a + 2400]
        total += np.bincount(lab.ravel(), minlength=n + 1)
        wide += np.bincount(lab[inner], minlength=n + 1)
        tall += np.bincount(lab[high[a:a + 2400]], minlength=n + 1)
    del high
    keep = (wide > 0) & (tall > 0)
    keep[0] = False
    print(f'missing land: {int(keep.sum())} of {n} regions without GMTED data ({int(total[keep].sum())} cells)', flush=True)
    for k in np.argsort(-np.where(keep, total, 0))[:12]:
        if keep[k]:
            ys, xs = np.nonzero(labels[::4, ::4] == k)
            where = f'around {90 - (R0s + ys.mean() * 4) / 240:.2f}, {-180 + xs.mean() * 4 / 240:.2f}' if len(ys) else ''
            print(f'  {int(total[k])} cells {where}', flush=True)
    out = np.zeros((G.HEIGHT, G.WIDTH), dtype=np.uint8)
    for a in range(0, shape[0], 2400):
        lo, hi = max(0, a - 1), min(shape[0], a + 2401)
        core = keep[labels[lo:hi]]
        rim = ndimage.binary_dilation(core, structure=np.ones((3, 3), dtype=bool)) & ~core & land[lo:hi]
        strip = (core.astype(np.uint8) + 2 * rim.astype(np.uint8))[a - lo:a - lo + min(2400, shape[0] - a)]
        out[R0s + a:R0s + a + strip.shape[0]] = strip
    np.save(path, out)


def block(r0: int) -> tuple[int, np.ndarray, dict]:
    r1 = min(HEIGHT, r0 + BLOCK)
    out = gmted(r0, r1)
    sea = G.upsample2(_gebco.rows(r0 // 2 - 1, r1 // 2 + 1))
    stats = {}
    # Where the tiles have no data: GEBCO above sea level.
    rows = np.arange(r0, r1)
    nodata = (rows < GMTED_ROWS[0]) | (rows >= GMTED_ROWS[1])
    out[nodata] = np.maximum(sea[nodata], 0.0)
    # Land that GMTED lacks.
    m = np.repeat(np.repeat(np.asarray(_missing[r0 // 2:r1 // 2]), 2, axis=0), 2, axis=1)
    fill = (out == 0) & (sea > 0) & (m > 0)
    fill[nodata] = False
    out[fill] = sea[fill]
    stats['filled'] = int(fill.sum())
    # Void-fill artefacts.
    bad = (out < -10.0) & (sea > 0)
    if bad.any():
        labels, n = ndimage.label(bad, structure=np.ones((3, 3), dtype=bool))
        ys, xs = np.nonzero(bad)
        lab = labels[ys, xs]
        depth = np.full(n + 1, -np.inf, dtype=np.float32)
        np.maximum.at(depth, lab, sea[ys, xs] - out[ys, xs])
        lowest = np.full(n + 1, np.inf, dtype=np.float32)
        np.minimum.at(lowest, lab, out[ys, xs])
        void_region = (depth > 2 * PIT_DEPTH) | ((depth > PIT_DEPTH) & (lowest < -PIT_DEPTH))
        sel = void_region[lab]
        if sel.any():
            void = np.zeros_like(bad)
            void[ys[sel], xs[sel]] = True
            void |= ndimage.binary_dilation(void, iterations=2) & (sea - out > PIT_DEPTH / 3)
            out[void] = sea[void]
            stats['voids'] = int(void.sum())
    # The 180-degree meridian: the two sides are moved to meet with the slope beside them (the mean of the
    # steps just inside each side), the correction fading out over WRAP_BLEND columns.
    left, right = out[:, 0].copy(), out[:, -1].copy()
    slope = 0.5 * ((out[:, 1] - left) + (right - out[:, -2]))
    mid = 0.5 * (left + right)
    both = (left != 0) & (right != 0)
    for k in range(WRAP_BLEND):
        w = np.where(both, 0.5 * (1.0 + np.cos(np.pi * k / WRAP_BLEND)), 0.0).astype(np.float32)
        out[:, k] += w * (mid + 0.5 * slope - left)
        out[:, -1 - k] += w * (mid - 0.5 * slope - right)
    return r0, out, stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--gebco-tiles', type=Path, default=None,
                        help='folder of extracted GEBCO tiles (default: extract GEBCO_2026/*.zip into GEBCO_2026/extracted)')
    parser.add_argument('--jobs', type=int, default=6)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for kind in ('elevation', 'tid'):
        G.extract(kind, args.gebco_tiles)
    tiles = str(args.gebco_tiles) if args.gebco_tiles else None
    start = time.time()
    missing_path = args.out.with_suffix('.missing.staging.npy')
    missing_land(tiles, args.jobs, missing_path)
    print(f'found the missing land ({time.time() - start:.0f} s)', flush=True)

    staging = args.out.with_suffix('.staging.tif')
    profile = dict(driver='GTiff', width=WIDTH, height=HEIGHT, count=1, dtype='float32', crs='EPSG:4326',
                   transform=from_origin(-180.0, 90.0, 1.0 / PER_DEGREE, 1.0 / PER_DEGREE), tiled=True,
                   blockxsize=512, blockysize=512, compress='deflate', predictor=3, zlevel=6, bigtiff='YES')
    totals: dict = {}
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'), rasterio.open(staging, 'w', **profile) as dst, \
            Pool(args.jobs, init, (tiles, str(missing_path))) as pool:
        for n, (r0, out, stats) in enumerate(pool.imap(block, range(0, HEIGHT, BLOCK)), 1):
            dst.write(out, 1, window=((r0, r0 + out.shape[0]), (0, WIDTH)))
            for k, v in stats.items():
                totals[k] = totals.get(k, 0) + v
            if n % 10 == 0:
                print(f'rows {r0 + out.shape[0]}/{HEIGHT} ({time.time() - start:.0f} s)', flush=True)
    missing_path.unlink()
    print(f'filled from GEBCO: {totals.get("filled", 0)} pixels of missing land, {totals.get("voids", 0)} pixels of void-fill artefacts', flush=True)
    print('writing the Cloud-Optimized GeoTIFF (with overviews)', flush=True)
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'):
        rasterio.shutil.copy(staging, args.out, driver='COG', compress='DEFLATE', predictor=3, level=6,
                             blocksize=512, overview_resampling='average', bigtiff='YES')
    staging.unlink()
    print(f'wrote {args.out} ({args.out.stat().st_size / 1e9:.1f} GB, {time.time() - start:.0f} s)')


if __name__ == '__main__':
    main()
