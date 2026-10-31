"""Surface wind climatology for the sea (src/physics/wind.js): for each calendar month, on a regular
GRID_DEG grid, the mean 10 m wind, its daily cycle and how much it varies about them.

Source: NCEP/NCAR Reanalysis 1, 6-hourly 10 m winds on the T62 Gaussian grid (~1.9 degrees),
uwnd.10m.gauss.<year>.nc and vwnd.10m.gauss.<year>.nc from NOAA PSL
(https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html), downloaded once into
additional_earth_imagery/wind/ncep/ (no login needed). Kalnay et al. (1996), The NCEP/NCAR 40-year
reanalysis project, Bull. Amer. Meteor. Soc., 77, 437-470.

For each month, over YEARS, at every source cell (u east, v north, m/s):
  - the mean u and v;
  - the daily cycle: the first harmonic in UTC hours, u(h) ~ mean + uCos cos(2 pi h / 24) + uSin
    sin(2 pi h / 24) (likewise v), from the four samples a day;
  - sigma: the RMS of what is left (the weather), per component, sqrt((var u + var v) / 2).
These are then averaged (cos(latitude) weighted; sigma as a variance) over GRID_DEG cells centred on
the grid's nodes, lat = -90 + GRID_DEG * row, lon = GRID_DEG * column.

Output: src/physics/windClimatology.data.js, a module exporting the grid's description and its values
as base64 int8 (times SCALE m/s), laid out [month][row][column][field] with FIELDS.

    .venv/bin/python -m tools.sources.build_wind
"""

from __future__ import annotations

import base64
import http.client
import json
import time
import urllib.request
from pathlib import Path

import netCDF4
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DOWNLOADS = ROOT / 'additional_earth_imagery' / 'wind' / 'ncep'
OUT = ROOT / 'src' / 'physics' / 'windClimatology.data.js'
BASE_URL = 'https://psl.noaa.gov/thredds/fileServer/Datasets/ncep.reanalysis/surface_gauss'
YEARS = range(2022, 2024)
GRID_DEG = 5
FIELDS = ['u', 'v', 'uCos', 'uSin', 'vCos', 'vSin', 'sigma']
SCALE = 0.125  # m/s per step (int8: +-15.9 m/s)


def fetch_file(url: str, path: Path) -> Path:
    """Downloads url to path once (resuming: the server drops long transfers now and then, sometimes
    without an error, so the partial file is resumed with HTTP Range until it has the whole length)."""
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.part')
    total = None
    for attempt in range(20):
        have = tmp.stat().st_size if tmp.exists() else 0
        if total is not None and have >= total:
            break
        request = urllib.request.Request(url, headers={'Range': f'bytes={have}-'} if have else {})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                if response.status == 206:
                    total = int(response.headers['Content-Range'].rsplit('/', 1)[1])
                else:
                    have = 0
                    total = int(response.headers['Content-Length'])
                with tmp.open('ab' if have else 'wb') as out:
                    while chunk := response.read(1 << 20):
                        out.write(chunk)
        except (OSError, http.client.HTTPException):
            time.sleep(2 ** min(attempt + 1, 4))
    if total is None or tmp.stat().st_size != total:
        raise RuntimeError(f'could not download {url}')
    tmp.replace(path)
    return path


def download(component: str, year: int) -> Path:
    name = f'{component}.10m.gauss.{year}.nc'
    return fetch_file(f'{BASE_URL}/{name}', DOWNLOADS / name)


def load(component: str):
    """All of YEARS for one component: values (time, lat, lon), months (1..12), UTC hours, lats, lons."""
    values, months, hours = [], [], []
    for year in YEARS:
        with netCDF4.Dataset(download(component, year)) as ds:
            values.append(np.asarray(ds.variables[component][:], dtype=np.float64))
            t = ds.variables['time']
            dates = netCDF4.num2date(t[:], t.units, only_use_cftime_datetimes=False)
            months += [d.month for d in dates]
            hours += [d.hour + d.minute / 60 for d in dates]
            lats = np.asarray(ds.variables['lat'][:], dtype=np.float64)
            lons = np.asarray(ds.variables['lon'][:], dtype=np.float64)
    return np.concatenate(values), np.array(months), np.array(hours), lats, lons


def month_stats(u, v, hours):
    """Per source cell: mean, daily harmonic and residual variance (stacked as FIELDS, sigma squared)."""
    w = 2 * np.pi * hours / 24
    c, s = np.cos(w)[:, None, None], np.sin(w)[:, None, None]
    out = []
    fits = []
    for x in (u, v):
        mean = x.mean(axis=0)
        # Least squares for mean + a cos + b sin (the four hours a day are evenly spaced, so this is
        # the plain Fourier coefficient, but robust to a missing sample).
        d = x - mean
        a = 2 * (d * c).mean(axis=0)
        b = 2 * (d * s).mean(axis=0)
        fits.append((mean, a, b, x - (mean + a * c + b * s)))
    (um, ua, ub, ur), (vm, va, vb, vr) = fits
    variance = ((ur ** 2).mean(axis=0) + (vr ** 2).mean(axis=0)) / 2
    out = [um, vm, ua, ub, va, vb, variance]
    return np.stack(out, axis=-1)


def regrid(stats, lats, lons):
    """Cos-latitude weighted averages over GRID_DEG cells around each node of the output grid."""
    rows, cols = 180 // GRID_DEG + 1, 360 // GRID_DEG
    out = np.zeros((rows, cols, stats.shape[-1]))
    weight_lat = np.cos(np.radians(lats))
    for r in range(rows):
        lat = -90 + GRID_DEG * r
        in_lat = np.abs(lats - lat) <= GRID_DEG / 2
        if not in_lat.any():
            in_lat = np.abs(lats - lat) == np.abs(lats - lat).min()
        for col in range(cols):
            lon = GRID_DEG * col
            dlon = (lons - lon + 180) % 360 - 180
            in_lon = np.abs(dlon) <= GRID_DEG / 2
            block = stats[in_lat][:, in_lon]
            w = np.broadcast_to(weight_lat[in_lat][:, None], block.shape[:2])
            out[r, col] = (block * w[..., None]).sum(axis=(0, 1)) / w.sum()
    out[..., -1] = np.sqrt(out[..., -1])  # sigma
    return out


def main():
    u, months, hours, lats, lons = load('uwnd')
    v, _, _, _, _ = load('vwnd')
    grids = []
    for month in range(1, 13):
        sel = months == month
        grids.append(regrid(month_stats(u[sel], v[sel], hours[sel]), lats, lons))
        print(f'month {month}: {sel.sum()} samples')
    grid = np.stack(grids)  # (12, rows, cols, fields)
    print('max |value| per field:', dict(zip(FIELDS, np.abs(grid).max(axis=(0, 1, 2)).round(2))))
    q = np.clip(np.round(grid / SCALE), -127, 127).astype(np.int8)
    meta = {
        'source': 'NCEP/NCAR Reanalysis 1, 6-hourly 10 m winds (NOAA PSL)',
        'years': [YEARS.start, YEARS.stop - 1],
        'gridDegrees': GRID_DEG,
        'rows': grid.shape[1],
        'cols': grid.shape[2],
        'fields': FIELDS,
        'scale': SCALE,
    }
    OUT.write_text(
        '// Generated by tools/sources/build_wind.py: the surface wind climatology (see src/physics/wind.js).\n'
        '// Do not edit.\n'
        f'export default {json.dumps(meta)[:-1]}, "data": "{base64.b64encode(q.tobytes()).decode()}"}}\n')
    print(f'wrote {OUT} ({OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
