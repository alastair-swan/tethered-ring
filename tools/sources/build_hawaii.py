"""Hawaii high-resolution imagery ("XHR", Esri World Imagery, fetched by
tools/download_xhr_hawaii_texture_tiles.py) as georeferenced Cloud-Optimized GeoTIFFs.

The XHR images are cells (i, j) of a 24 x 12 grid of 15-degree cells numbered from 180W, 90N, resampled from
Web Mercator to latitude/longitude with their first and last pixels on the cell's edges (pixel-is-point,
spacing 15 / (N - 1) degrees); here they are written pixel-is-area, with the origin half a pixel outside the
cell. The Copernicus GLO-30 tiles for Hawaii's terrain (DisplacementMaps/XHREarthDisplacement) are already
georeferenced Cloud-Optimized GeoTIFFs and are used as they are.

    .venv/bin/python -m tools.sources.build_hawaii
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from PIL import Image
from rasterio.transform import from_origin

ROOT = Path(__file__).resolve().parents[2]
XHR = ROOT / 'additional_earth_imagery' / 'TetheredRing' / 'textures' / '24x12' / 'XHR'
OUT = ROOT / 'additional_earth_imagery' / 'sources'
CELLS = {(1, 4): 'earth_XHR_24x12_1x4_z10_16k.jpg', (2, 4): 'earth_XHR_24x12_2x4.jpg', (3, 4): 'earth_XHR_24x12_3x4.jpg'}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    Image.MAX_IMAGE_PIXELS = None
    for (i, j), name in CELLS.items():
        img = np.asarray(Image.open(XHR / name).convert('RGB'))
        n = img.shape[0]
        lon_min, lat_max = -180.0 + 15.0 * i, 90.0 - 15.0 * j
        step = 15.0 / (n - 1)
        staging, out = OUT / f'hawaii_xhr_{i}x{j}.staging.tif', OUT / f'hawaii_xhr_{i}x{j}.tif'
        with rasterio.open(staging, 'w', driver='GTiff', width=n, height=n, count=3, dtype='uint8', crs='EPSG:4326',
                           photometric='RGB', transform=from_origin(lon_min - step / 2, lat_max + step / 2, step, step),
                           tiled=True, blockxsize=512, blockysize=512, compress='deflate') as dst:
            dst.write(np.moveaxis(img, -1, 0))
        rasterio.shutil.copy(staging, out, driver='COG', compress='JPEG', quality=95, blocksize=512,
                             overview_resampling='average')
        staging.unlink()
        print(f'wrote {out.name}: {n} px over 15 degrees ({step * 111320:.0f} m per pixel at the equator)')


if __name__ == '__main__':
    main()
