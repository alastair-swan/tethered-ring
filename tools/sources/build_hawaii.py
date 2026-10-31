"""Hawaii high-resolution imagery ("XHR", Esri World Imagery, fetched by
tools/download_xhr_hawaii_texture_tiles.py) as georeferenced Cloud-Optimized GeoTIFFs.

The XHR images are cells (i, j) of a 24 x 12 grid of 15-degree cells numbered from 180W, 90N.
  - 1x4 (Hawaii, earth_XHR_24x12_1x4_z10_16k.jpg) was made by fetch_xyz_mosaic: zoom-10 Web Mercator tiles
    stitched, cropped to the cell rounded to whole source pixels, and resampled by
    reproject_mercator_to_equirectangular, whose first and last output pixels sample the centres of the first
    and last source pixels (half a source pixel, 1.5 output pixels, inside the cell). Its true geometry is
    reconstructed here from the same arithmetic (xyz_geometry): it is affine to within 0.02 pixel. (Treating
    the image as pixel-is-point edge to edge over the cell put Hawaii 0.6-0.8 pixel south and 0.3-0.4 pixel
    east of where it is; measured against the Copernicus coastline the error was 0.5-1.2 pixels.)
  - 2x4 and 3x4 (8192 px, open ocean east of Hawaii, no land to check them against) are taken to be USGS
    export images (fetch_export_image, the bbox is the image extent): pixel-is-area over the cell.
The Copernicus GLO-30 tiles for Hawaii's terrain (DisplacementMaps/XHREarthDisplacement) are already
georeferenced Cloud-Optimized GeoTIFFs and are used as they are.

    .venv/bin/python -m tools.sources.build_hawaii
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from PIL import Image
from rasterio.transform import Affine, from_origin

from tools.download_xhr_hawaii_texture_tiles import lonlat_to_tile_xy, tile_bbox

ROOT = Path(__file__).resolve().parents[2]
XHR = ROOT / 'additional_earth_imagery' / 'TetheredRing' / 'textures' / '24x12' / 'XHR'
OUT = ROOT / 'additional_earth_imagery' / 'sources'
# cell -> (file, how it was made: zoom of the XYZ mosaic, or None for an export image)
CELLS = {(1, 4): ('earth_XHR_24x12_1x4_z10_16k.jpg', 10), (2, 4): ('earth_XHR_24x12_2x4.jpg', None),
         (3, 4): ('earth_XHR_24x12_3x4.jpg', None)}


def xyz_geometry(i: int, j: int, n: int, zoom: int) -> tuple[np.ndarray, np.ndarray]:
    """The longitudes of the columns and latitudes of the rows (pixel centres) of an n x n image made by
    fetch_xyz_mosaic for cell (i, j), following its arithmetic step by step."""
    lon_min, lat_min, lon_max, lat_max = tile_bbox(i, j)
    tiles = 2 ** zoom
    x0f, y0f = lonlat_to_tile_xy(lon_min, lat_max, zoom)
    x1f, y1f = lonlat_to_tile_xy(lon_max, lat_min, zoom)
    x0, y0 = math.floor(min(x0f, x1f)), math.floor(min(y0f, y1f))
    left, right = round((min(x0f, x1f) - x0) * 256), round((max(x0f, x1f) - x0) * 256)
    top, bottom = round((min(y0f, y1f) - y0) * 256), round((max(y0f, y1f) - y0) * 256)
    src_w, src_h = right - left, bottom - top
    k = np.arange(n)
    # Output column k samples cropped source column k (src_w - 1) / (n - 1), whose centre is half a pixel in.
    x = x0 + (left + 0.5 + k * (src_w - 1) / (n - 1)) / 256
    lon = x / tiles * 360.0 - 180.0
    # Output row k samples the source row that the Mercator y of its nominal latitude maps to, as if the
    # first and last source rows were on the cell's edges.
    nominal = np.linspace(lat_max, lat_min, n)
    y_nominal = np.array([lonlat_to_tile_xy(lon_min, la, zoom)[1] for la in nominal])
    y_src = np.clip((y_nominal - y_nominal[0]) / (y_nominal[-1] - y_nominal[0]) * (src_h - 1), 0, src_h - 1)
    y = y0 + (top + 0.5 + y_src) / 256
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * y / tiles))))
    return lon, lat


def transform_for(i: int, j: int, n: int, zoom: int | None) -> Affine:
    if zoom is None:
        lon_min, _, _, lat_max = tile_bbox(i, j)
        return from_origin(lon_min, lat_max, 15.0 / n, 15.0 / n)
    lon, lat = xyz_geometry(i, j, n, zoom)
    k = np.arange(n)
    (sx, cx), (sy, cy) = np.polyfit(k, lon, 1), np.polyfit(k, lat, 1)
    residual = max(np.abs(sx * k + cx - lon).max() / abs(sx), np.abs(sy * k + cy - lat).max() / abs(sy))
    if residual > 0.05:
        raise ValueError(f'cell {i}x{j}: not affine to within 0.05 pixel ({residual:.3f})')
    # Pixel-is-area: the origin is the outer corner of the first pixel.
    return Affine(sx, 0.0, cx - sx / 2, 0.0, sy, cy - sy / 2)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    Image.MAX_IMAGE_PIXELS = None
    for (i, j), (name, zoom) in CELLS.items():
        img = np.asarray(Image.open(XHR / name).convert('RGB'))
        n = img.shape[0]
        transform = transform_for(i, j, n, zoom)
        staging, out = OUT / f'hawaii_xhr_{i}x{j}.staging.tif', OUT / f'hawaii_xhr_{i}x{j}.tif'
        with rasterio.open(staging, 'w', driver='GTiff', width=n, height=n, count=3, dtype='uint8', crs='EPSG:4326',
                           photometric='RGB', transform=transform, tiled=True, blockxsize=512, blockysize=512,
                           compress='deflate') as dst:
            dst.write(np.moveaxis(img, -1, 0))
        rasterio.shutil.copy(staging, out, driver='COG', compress='JPEG', quality=95, blocksize=512,
                             overview_resampling='average')
        staging.unlink()
        print(f'wrote {out.name}: {n} px, {transform.a * 111320:.0f} m per pixel at the equator, origin '
              f'{transform.c:.6f}, {transform.f:.6f}')


if __name__ == '__main__':
    main()
