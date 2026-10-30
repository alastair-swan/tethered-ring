"""Global Blue Marble colour, 86400 x 43200 (15 arc-seconds), as a lossless Cloud-Optimized GeoTIFF, with
its seams repaired.

The source is additional_earth_imagery/EarthImages/Earth/bluemarble_86400x43200.png (NASA Blue Marble Next
Generation; the month assets/earth was baked from). Its defects, found by measuring the colour step between
neighbouring rows and columns:
  - Rows 0-4 (the pole) are corrupt, and the polar data above 88N is poor: within POLE_CAP rows of the
    pole each row is blended towards its own mean colour (fully at the pole, where all of a row is one
    point, fading out by 88N), after the corrupt rows are replaced by row POLE_ROWS.
  - Row 239 (89N) is a single bad row (it steps 9 levels from both neighbours, against 0.2-0.3 between
    the rows around it): replaced by the mean of its neighbours (BAD_ROWS).
  - Horizontal seams at rows 2400 (80N) and 36000 (60S), where data was pasted in (found as the
    whole-degree rows whose step stands out from the rows around them): the step across each is levelled
    (see level_seam) over SEAM_RAMP rows either side, keeping the detail.
  - The wrap at 180 degrees does not meet north of about 63N (NASA's own data has the same seam): the
    first and last WRAP_BLEND columns are blended towards their common edge colour.
The grid is pixel-is-area: pixel (row r, column c) covers latitudes 90 - r/240 .. 90 - (r+1)/240 and
longitudes -180 + c/240 .. -180 + (c+1)/240.

    .venv/bin/python -m tools.sources.build_blue_marble [--out PATH]
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from PIL import Image
from rasterio.transform import from_origin
from scipy.ndimage import uniform_filter1d

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'additional_earth_imagery' / 'EarthImages' / 'Earth' / 'bluemarble_86400x43200.png'
DEFAULT_OUT = ROOT / 'additional_earth_imagery' / 'sources' / 'blue_marble_15s.tif'

PER_DEGREE = 240
POLE_ROWS = 5            # rows 0..4 are corrupt
POLE_CAP = 480           # rows (2 degrees) around the North Pole blended towards their mean colour
SEAMS = (2400, 36000)    # rows whose step from the row above is a pasting seam
BAD_ROWS = (239,)        # single bad rows, replaced by the mean of their neighbours
SEAM_RAMP = 64           # rows either side over which a seam's step is spread
SEAM_SMOOTH = 33         # columns over which a seam's step is averaged (its systematic part)
WRAP_BLEND = 240         # columns either side of 180 degrees blended to meet


def level_seam(img: np.ndarray, row: int) -> None:
    """Removes the systematic step between rows row-1 and row (per column and channel, smoothed along the
    row so that genuine detail stays), half above and half below, fading out over SEAM_RAMP rows."""
    f = lambda r: img[r].astype(np.float32)
    # The step across the seam, less the step the rows either side of it have anyway (natural variation).
    natural = 0.5 * ((f(row - 1) - f(row - 2)) + (f(row + 1) - f(row)))
    step = uniform_filter1d(f(row) - f(row - 1) - natural, SEAM_SMOOTH, axis=0, mode='wrap')
    for k in range(SEAM_RAMP):
        w = 0.5 * (1.0 - k / SEAM_RAMP)
        for r, sign in ((row - 1 - k, 1.0), (row + k, -1.0)):
            img[r] = np.clip(img[r].astype(np.float32) + sign * w * step, 0, 255).astype(np.uint8)


def blend_wrap(img: np.ndarray) -> None:
    """Blends the first and last WRAP_BLEND columns towards their common edge colour."""
    left = img[:, 0].astype(np.float32)
    right = img[:, -1].astype(np.float32)
    edge = 0.5 * (left + right)
    for k in range(WRAP_BLEND):
        w = (1.0 - k / WRAP_BLEND) ** 2
        for c, own in ((k, left), (-1 - k, right)):
            img[:, c] = np.clip(img[:, c].astype(np.float32) + w * (edge - own), 0, 255).astype(np.uint8)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    start = time.time()
    Image.MAX_IMAGE_PIXELS = None
    img = np.array(Image.open(SOURCE).convert('RGB'))
    h, w, _ = img.shape
    print(f'read {SOURCE.name} {w}x{h} ({time.time() - start:.0f} s)', flush=True)

    img[:POLE_ROWS] = img[POLE_ROWS].mean(axis=0).astype(np.uint8)
    for row in BAD_ROWS:
        img[row] = ((img[row - 1].astype(np.uint16) + img[row + 1]) // 2).astype(np.uint8)
    for row in SEAMS:
        level_seam(img, row)
    for r in range(POLE_CAP):
        weight = (1.0 - r / POLE_CAP) ** 2
        own = img[r].astype(np.float32)
        img[r] = np.clip(own + weight * (own.mean(axis=0) - own), 0, 255).astype(np.uint8)
    blend_wrap(img)

    staging = args.out.with_suffix('.staging.tif')
    profile = dict(driver='GTiff', width=w, height=h, count=3, dtype='uint8', crs='EPSG:4326', photometric='RGB',
                   transform=from_origin(-180.0, 90.0, 1.0 / PER_DEGREE, 1.0 / PER_DEGREE), tiled=True,
                   blockxsize=512, blockysize=512, compress='deflate', predictor=2, bigtiff='YES')
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'), rasterio.open(staging, 'w', **profile) as dst:
        for r0 in range(0, h, 2048):
            dst.write(np.moveaxis(img[r0:r0 + 2048], -1, 0), window=((r0, min(h, r0 + 2048)), (0, w)))
    del img
    print(f'repaired and staged ({time.time() - start:.0f} s); writing the Cloud-Optimized GeoTIFF', flush=True)
    with rasterio.Env(GDAL_NUM_THREADS='ALL_CPUS'):
        rasterio.shutil.copy(staging, args.out, driver='COG', compress='DEFLATE', predictor=2, level=6,
                             blocksize=512, overview_resampling='average', bigtiff='YES')
    staging.unlink()
    print(f'wrote {args.out} ({args.out.stat().st_size / 1e9:.1f} GB, {time.time() - start:.0f} s)')


if __name__ == '__main__':
    main()
