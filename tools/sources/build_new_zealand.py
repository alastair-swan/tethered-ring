"""New Zealand imagery and elevation mosaics, as Cloud-Optimized GeoTIFFs in their own projection (NZTM2000,
EPSG:2193), from the LINZ data in additional_earth_imagery/New Zealand (both CC BY 4.0, (c) LINZ):
  - imagery: New Zealand 10m Satellite Imagery (2022-2023), 450 JPEG 2000 tiles (RGB + alpha for coverage),
    written as RGB with an internal mask, JPEG-compressed (quality 95; the source is already lossy).
  - elevation: NZ 8m Digital Elevation Model (2012), 115 float GeoTIFF tiles (nodata -32767). LINZ's export
    came in two parts with clipped versions of some tiles: the unpacked tiles are used, and the clipped tiles
    in lds-nz-8m-digital-elevation-model-2012-GTiff.zip fill the cells they leave empty (where both have
    data, they agree exactly).
The tiles of each set share one grid, so they are copied into their windows of the mosaic unresampled.

    .venv/bin/python -m tools.sources.build_new_zealand [imagery|elevation ...]
"""

from __future__ import annotations

import argparse
import glob
import time
import zipfile
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from rasterio.transform import from_origin
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parents[2]
NZ = ROOT / 'additional_earth_imagery' / 'New Zealand'
DEM_DIR = NZ / 'Altitude Map' / 'lds-nz-8m-digital-elevation-model-2012-GTiff'
DEM_EXTRA_ZIP = NZ / 'Altitude Map' / 'lds-nz-8m-digital-elevation-model-2012-GTiff.zip'
OUT = ROOT / 'additional_earth_imagery' / 'sources'
DEM_NODATA = -32767.0


def mosaic_profile(files: list[str], **extra) -> tuple[dict, rasterio.Affine]:
    """A profile covering all of `files` (which share a grid)."""
    bounds = []
    for f in files:
        with rasterio.open(f) as s:
            bounds.append(s.bounds); res, crs = s.res, s.crs
    b = np.array(bounds)
    transform = from_origin(b[:, 0].min(), b[:, 3].max(), res[0], res[1])
    width = int(round((b[:, 2].max() - b[:, 0].min()) / res[0]))
    height = int(round((b[:, 3].max() - b[:, 1].min()) / res[1]))
    return dict(driver='GTiff', width=width, height=height, crs=crs, transform=transform, tiled=True,
                blockxsize=512, blockysize=512, bigtiff='YES', **extra), transform


def window_of(dst, src) -> rasterio.windows.Window:
    w = from_bounds(*src.bounds, transform=dst.transform)
    return rasterio.windows.Window(int(round(w.col_off)), int(round(w.row_off)), src.width, src.height)


def to_cog(staging: Path, out: Path, **options) -> None:
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'):
        rasterio.shutil.copy(staging, out, driver='COG', blocksize=512, overview_resampling='average',
                             bigtiff='YES', **options)
    staging.unlink()
    print(f'wrote {out} ({out.stat().st_size / 1e9:.1f} GB)', flush=True)


def build_imagery() -> None:
    files = sorted(glob.glob(str(NZ / '*.jp2')))
    profile, _ = mosaic_profile(files, count=3, dtype='uint8', photometric='RGB', compress='deflate', predictor=2)
    staging, start = OUT / 'nz_imagery_10m.staging.tif', time.time()
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS', GDAL_TIFF_INTERNAL_MASK='YES'), rasterio.open(staging, 'w', **profile) as dst:
        for n, f in enumerate(files, 1):
            with rasterio.open(f) as s:
                w = window_of(dst, s)
                dst.write(s.read((1, 2, 3)), window=w)
                dst.write_mask(s.read(4), window=w)
            if n % 50 == 0:
                print(f'imagery {n}/{len(files)} ({time.time() - start:.0f} s)', flush=True)
    to_cog(staging, OUT / 'nz_imagery_10m.tif', compress='JPEG', quality=95)


def build_elevation() -> None:
    files = sorted(glob.glob(str(DEM_DIR / '*.tif')))
    profile, _ = mosaic_profile(files, count=1, dtype='float32', nodata=DEM_NODATA, compress='deflate', predictor=3)
    staging, start = OUT / 'nz_elevation_8m.staging.tif', time.time()
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'), rasterio.open(staging, 'w+', **profile) as dst:
        for n, f in enumerate(files, 1):
            with rasterio.open(f) as s:
                dst.write(s.read(1), 1, window=window_of(dst, s))
            if n % 20 == 0:
                print(f'elevation {n}/{len(files)} ({time.time() - start:.0f} s)', flush=True)
        # The other part of LINZ's export: fill the cells the unpacked tiles leave empty.
        with zipfile.ZipFile(DEM_EXTRA_ZIP) as z:
            members = [m for m in z.namelist() if m.endswith('.tif')]
        filled = 0
        for m in members:
            with rasterio.open(f'/vsizip/{DEM_EXTRA_ZIP}/{m}') as s:
                w = window_of(dst, s)
                extra, have = s.read(1), dst.read(1, window=w)
                fill = (have == DEM_NODATA) & (extra != DEM_NODATA)
                if fill.any():
                    have[fill] = extra[fill]
                    dst.write(have, 1, window=w)
                    filled += int(fill.sum())
        print(f'filled {filled} cells from {DEM_EXTRA_ZIP.name}', flush=True)
    to_cog(staging, OUT / 'nz_elevation_8m.tif', compress='DEFLATE', predictor=3, level=6)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('parts', nargs='*', default=['imagery', 'elevation'], choices=['imagery', 'elevation'])
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for part in args.parts:
        {'imagery': build_imagery, 'elevation': build_elevation}[part]()


if __name__ == '__main__':
    main()
