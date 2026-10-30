"""Seasonal sea ice for the planet renderer: a monthly climatology of sea ice concentration for each pole,
written to assets/sea_ice (see src/planet/seaIce.js, which draws it on the sea surface and blends between
months by the simulated date).

Source: NSIDC Sea Ice Index, Version 4 (G02135), monthly sea ice concentration GeoTIFFs, 25 km polar
stereographic grids (EPSG:3411 north, EPSG:3412 south), downloaded from
https://noaadata.apps.nsidc.org/NOAA/G02135/ into additional_earth_imagery/sea_ice/G02135/ (once).
Values are concentration in tenths of a percent (0..1000); 2510 is the pole hole (north: no satellite
coverage), 2530 coast and 2540 land. The pole hole is filled like land, from the ice around it.

For each calendar month, the concentration is averaged over YEARS (the last ten complete years, so it is
how the ice is now, not in the 1980s). Land and coast cells take the concentration of the nearest sea
cell within FILL_CELLS, so that ice reaches the coastline (the renderer draws it only where the terrain
is below sea level). The result is resampled onto a polar azimuthal equidistant grid of SIZE x SIZE pixels
per pole, reaching CAP_DEG from the pole: pixel (row, column) has u = (column + 0.5) / SIZE and
v = (row + 0.5) / SIZE, and the point at geodetic latitude lat and longitude lon (degrees) is at
  r = (90 - |lat|) / CAP_DEG,  u = 0.5 + 0.5 r cos(lon),  v = 0.5 + 0.5 r sin(lon).
Outside the source grid and the cap it is 0.

Output (raw uint8, concentration * 255, months January..December, each SIZE rows of SIZE):
  assets/sea_ice/north.bin, assets/sea_ice/south.bin, assets/sea_ice/manifest.json

    .venv/bin/python -m tools.sources.build_sea_ice
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
DOWNLOADS = ROOT / 'additional_earth_imagery' / 'sea_ice' / 'G02135'
OUT = ROOT / 'assets' / 'sea_ice'
BASE_URL = 'https://noaadata.apps.nsidc.org/NOAA/G02135'
YEARS = range(2016, 2026)
MONTHS = ['01_Jan', '02_Feb', '03_Mar', '04_Apr', '05_May', '06_Jun',
          '07_Jul', '08_Aug', '09_Sep', '10_Oct', '11_Nov', '12_Dec']
SIZE = 512
CAP_DEG = 54.0       # down to 36 degrees from the equator (Bohai Sea ice is at 38-40N)
FILL_CELLS = 8       # 200 km
POLES = {'north': ('N', 'EPSG:3411', 1.0), 'south': ('S', 'EPSG:3412', -1.0)}


def download(pole: str, year: int, month: int) -> Path:
    letter = POLES[pole][0]
    name = f'{letter}_{year}{month + 1:02d}_concentration_v4.0.tif'
    path = DOWNLOADS / pole / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        url = f'{BASE_URL}/{pole}/monthly/geotiff/{MONTHS[month]}/{name}'
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=60) as response:
                    data = response.read()
                break
            except OSError:
                if attempt == 3:
                    raise
                time.sleep(2 ** (attempt + 1))
        tmp = path.with_suffix('.part')
        tmp.write_bytes(data)
        tmp.replace(path)
    return path


def monthly_mean(pole: str, month: int):
    """Mean concentration (0..1) over YEARS on the source grid, with land and coast filled from the
    nearest sea (NaN beyond FILL_CELLS), and the grid's transform."""
    total = count = transform = None
    for year in YEARS:
        with rasterio.open(download(pole, year, month)) as src:
            raw = src.read(1).astype(np.int32)
            transform = src.transform
        value = np.where(raw <= 1000, raw / 1000.0, np.nan)
        if total is None:
            total = np.zeros(value.shape)
            count = np.zeros(value.shape)
        ok = np.isfinite(value)
        total[ok] += value[ok]
        count[ok] += 1
    mean = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    missing = ~np.isfinite(mean)
    distance, (iy, ix) = ndimage.distance_transform_edt(missing, return_indices=True)
    filled = mean[iy, ix]
    filled[distance > FILL_CELLS] = 0.0
    return filled, transform


def resample(pole: str, field: np.ndarray, transform) -> np.ndarray:
    """The field on the polar azimuthal equidistant grid (see the module docstring)."""
    sign = POLES[pole][2]
    s = (np.arange(SIZE) + 0.5) / SIZE
    u, v = np.meshgrid(s, s)                        # u along columns, v along rows
    dx, dy = 2.0 * (u - 0.5), 2.0 * (v - 0.5)
    r = np.hypot(dx, dy)
    lat = sign * (90.0 - r * CAP_DEG)
    lon = np.degrees(np.arctan2(dy, dx))
    x, y = Transformer.from_crs('EPSG:4326', POLES[pole][1], always_xy=True).transform(lon, lat)
    # Source pixel coordinates (pixel-is-area: centres at +0.5), bilinear.
    col = (x - transform.c) / transform.a - 0.5
    row = (y - transform.f) / transform.e - 0.5
    h, w = field.shape
    inside = (r <= 1.0) & (col >= -0.5) & (col <= w - 0.5) & (row >= -0.5) & (row <= h - 0.5)
    c0 = np.clip(np.floor(col).astype(int), 0, w - 2)
    r0 = np.clip(np.floor(row).astype(int), 0, h - 2)
    tc = np.clip(col - c0, 0.0, 1.0)
    tr = np.clip(row - r0, 0.0, 1.0)
    top = field[r0, c0] * (1 - tc) + field[r0, c0 + 1] * tc
    bottom = field[r0 + 1, c0] * (1 - tc) + field[r0 + 1, c0 + 1] * tc
    out = top * (1 - tr) + bottom * tr
    return np.where(inside, out, 0.0)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=OUT)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    for pole in POLES:
        months = []
        for month in range(12):
            field, transform = monthly_mean(pole, month)
            grid = resample(pole, field, transform)
            months.append(np.clip(np.round(grid * 255.0), 0, 255).astype(np.uint8))
            area = (grid > 0.15).mean() * 100
            print(f'[sea_ice] {pole} {MONTHS[month][3:]}: over 15% concentration on {area:.1f}% of the grid', flush=True)
        np.stack(months).tofile(args.out / f'{pole}.bin')
    manifest = {
        'size': SIZE,
        'capDegrees': CAP_DEG,
        'months': 12,
        'years': [YEARS.start, YEARS.stop - 1],
        'encoding': 'uint8 concentration * 255; months January..December, each size rows of size',
        'source': 'NSIDC Sea Ice Index, Version 4 (G02135), monthly concentration '
                  '(National Snow and Ice Data Center), mean of each month over the years',
    }
    (args.out / 'manifest.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
    print(f'[sea_ice] wrote {args.out.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
