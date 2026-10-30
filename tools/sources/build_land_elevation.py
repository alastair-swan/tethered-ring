"""Global land elevation (metres) on a 7.5 arc-second grid, as a Cloud-Optimized GeoTIFF.

Assembled from the source files in additional_earth_imagery/ (see docs/ASSETS.md):
  - GMTED2010 7.5" tiles TILE_A1..TILE_C2.psb: float32 metres, 57600 x 38400 each, a 3 x 2 grid covering
    180W..180E, 90N..70S (A, B, C: 120 degrees of longitude each from 180W; 1, 2: 90N..10N, 10N..70S).
    They leave Greenland at 0 m and stop at 70S.
  - GREENLAND.psb and ANTARTIC.psb: 30" patches, a height channel and an alpha channel (Greenland: from
    90N 150W, 60 x 150 degrees; Antarctica: from 50S 180W to the pole, all longitudes). Where the alpha is
    set they replace the tiles (blended where it is partial).
The grid is pixel-is-area: pixel (row r, column c) covers latitudes 90 - r/480 .. 90 - (r+1)/480 and
longitudes -180 + c/480 .. -180 + (c+1)/480 (the 30" patches the same with 120 per degree), so the patches
are resampled at the 7.5" pixel centres.

Oceans are 0 m here (none of these has bathymetry): see build_elevation.py, which adds them.

    .venv/bin/python -m tools.sources.build_land_elevation [--out PATH]
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from scipy.ndimage import map_coordinates

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'additional_earth_imagery' / 'TetheredRing' / 'textures' / 'DisplacementMaps'
DEFAULT_OUT = ROOT / 'additional_earth_imagery' / 'sources' / 'land_elevation_gmted_7.5s.tif'

PER_DEGREE = 480                      # 7.5" pixels per degree
WIDTH, HEIGHT = 360 * PER_DEGREE, 180 * PER_DEGREE
TILE_W, TILE_H = 57600, 38400
TILES = {(c, r): (r * TILE_H, 'ABC'.index(c) * TILE_W) for c in 'ABC' for r in (0, 1)}   # -> (row, col) origin
BLOCK = 960                           # rows per block (2 degrees)
# The 30" patches: file, (top latitude, left longitude).
PATCHES = {'GREENLAND': (90.0, -150.0), 'ANTARTIC': (-50.0, -180.0)}


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


def patch_block(patch: np.ndarray, top: float, left: float, r0: int, r1: int) -> tuple[np.ndarray, np.ndarray] | None:
    """A 30" patch (height, alpha) bilinearly resampled at the 7.5" pixel centres of rows r0..r1, over the
    full width, or None if it does not reach these rows. Outside the patch the alpha is 0."""
    _, ph, pw = patch.shape
    lat = 90.0 - (np.arange(r0, r1) + 0.5) / PER_DEGREE
    prow = (top - lat) * 120.0 - 0.5                   # fractional patch rows of these pixel centres
    if prow.max() < -0.5 or prow.min() > ph - 0.5:
        return None
    lon = -180.0 + (np.arange(WIDTH) + 0.5) / PER_DEGREE
    pcol = ((lon - left) % 360.0) * 120.0 - 0.5
    inside_cols = (pcol >= -0.5) & (pcol <= pw - 0.5)
    lo, hi = max(0, int(np.floor(prow.min()))), min(ph, int(np.ceil(prow.max())) + 2)
    rows = np.asarray(patch[:, lo:hi], dtype=np.float32)
    rr, cc = np.meshgrid(np.clip(prow - lo, 0, hi - lo - 1), np.clip(pcol, 0, pw - 1), indexing='ij')
    height = map_coordinates(rows[0], [rr, cc], order=1, mode='nearest')
    alpha = map_coordinates(rows[1], [rr, cc], order=1, mode='nearest')
    inside = ((prow >= -0.5) & (prow <= ph - 0.5))[:, None] & inside_cols[None, :]
    return height, np.where(inside, np.clip(alpha, 0.0, 1.0), 0.0)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tiles = {k: psb_composite(SOURCES / f'TILE_{k[0]}{k[1] + 1}.psb')[0] for k in TILES}
    patches = {n: (psb_composite(SOURCES / f'{n}.psb'), origin) for n, origin in PATCHES.items()}

    staging = args.out.with_suffix('.staging.tif')
    profile = dict(driver='GTiff', width=WIDTH, height=HEIGHT, count=1, dtype='float32', crs='EPSG:4326',
                   transform=from_origin(-180.0, 90.0, 1.0 / PER_DEGREE, 1.0 / PER_DEGREE), tiled=True,
                   blockxsize=512, blockysize=512, compress='deflate', predictor=3, zlevel=6, bigtiff='YES')
    start = time.time()
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'), rasterio.open(staging, 'w', **profile) as dst:
        for r0 in range(0, HEIGHT, BLOCK):
            r1 = min(HEIGHT, r0 + BLOCK)
            out = np.zeros((r1 - r0, WIDTH), dtype=np.float32)
            for (c, r), (ty, tx) in TILES.items():
                a, b = max(r0, ty), min(r1, ty + TILE_H)
                if a < b:
                    out[a - r0:b - r0, tx:tx + TILE_W] = tiles[(c, r)][a - ty:b - ty]
            for name, (patch, (top, left)) in patches.items():
                resampled = patch_block(patch, top, left, r0, r1)
                if resampled is not None:
                    height, alpha = resampled
                    out = (alpha * height + (1.0 - alpha) * out).astype(np.float32)
            dst.write(out, 1, window=((r0, r1), (0, WIDTH)))
            if (r0 // BLOCK) % 10 == 0:
                print(f'rows {r1}/{HEIGHT} ({time.time() - start:.0f} s)', flush=True)

    print('writing the Cloud-Optimized GeoTIFF (with overviews)', flush=True)
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'):
        rasterio.shutil.copy(staging, args.out, driver='COG', compress='DEFLATE', predictor=3, level=6,
                             blocksize=512, overview_resampling='average', bigtiff='YES')
    staging.unlink()
    print(f'wrote {args.out} ({args.out.stat().st_size / 1e9:.1f} GB, {time.time() - start:.0f} s)')


if __name__ == '__main__':
    import rasterio.shutil  # noqa: E402  (registers rasterio.shutil.copy)
    main()
