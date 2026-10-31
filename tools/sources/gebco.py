"""Reading the GEBCO 2026 Grid (15 arc-second elevation and its Type Identifier grid) by global row blocks.

GEBCO's GeoTIFF downloads (additional_earth_imagery/GEBCO_2026/gebco_2026_geotiff.zip, the "ice surface
elevation" version, and gebco_2026_tid_geotiff.zip) each hold eight 21600 x 21600 tiles of 90 x 90 degrees.
They are extracted once into GEBCO_2026/extracted/ (zipfile checks each member's CRC), because rows can not
be read at random from inside a zip.

The grid is 86400 x 43200, pixel-centre registered: value (row R, column C) is at latitude 90 - (R + 0.5)/240
and longitude -180 + (C + 0.5)/240, which is the same grid as pixel-is-area cells from (-180, 90) of 1/240
degree. So on the 7.5" grid of the land elevation (480 per degree), 7.5" pixel r lies at GEBCO row
r/2 - 0.25: upsample2 resamples bilinearly at those centres (weights 0.75 and 0.25).

TID codes (GEBCO_Grid_documentation.pdf, table 2): 0 land; 10-17 direct depth measurements; 40-48 indirect
(gravity-predicted, interpolated, contours, ...); 70-72 pre-generated grids, unknown sources, steering
points; 127 no data. Note that a non-zero TID does not mean open water: the under-ice bed of Antarctica, the
Caspian Sea, the Great Lakes, Dutch polders and parts of Death Valley all have non-zero codes.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[2]
GEBCO_DIR = ROOT / 'additional_earth_imagery' / 'GEBCO_2026'
ZIPS = {'elevation': GEBCO_DIR / 'gebco_2026_geotiff.zip', 'tid': GEBCO_DIR / 'gebco_2026_tid_geotiff.zip'}
PREFIX = {'elevation': 'gebco_2026', 'tid': 'gebco_2026_tid'}
PER_DEGREE = 240
WIDTH, HEIGHT, TILE = 360 * PER_DEGREE, 180 * PER_DEGREE, 90 * PER_DEGREE


def tile_name(kind: str, row: int, col: int) -> str:
    """The file name of tile (row 0..1 from the north, column 0..3 from 180W)."""
    n, s = (90.0, 0.0) if row == 0 else (0.0, -90.0)
    w = -180.0 + 90.0 * col
    return f'{PREFIX[kind]}_n{n:.1f}_s{s:.1f}_w{w:.1f}_e{w + 90.0:.1f}_geotiff.tif'


def extract(kind: str, tiles_dir: Path | None = None) -> Path:
    """The folder holding the extracted tiles of `kind`, extracting them from GEBCO's zip if needed."""
    out = tiles_dir or GEBCO_DIR / 'extracted'
    names = [tile_name(kind, r, c) for r in (0, 1) for c in range(4)]
    missing = [n for n in names if not (out / n).exists()]
    if missing:
        if not ZIPS[kind].exists():
            raise FileNotFoundError(f'{ZIPS[kind]} is not there (download it: see docs/ASSETS.md)')
        out.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(ZIPS[kind]) as z:
            for n in missing:
                print(f'extracting {n}', flush=True)
                partial = out / (n + '.part')
                with z.open(n) as src, open(partial, 'wb') as dst:   # z.open checks the CRC at the end
                    while chunk := src.read(1 << 24):
                        dst.write(chunk)
                partial.rename(out / n)
    return out


class Gebco:
    """Global row blocks of one GEBCO grid (`kind` 'elevation' or 'tid'), from its extracted tiles."""

    def __init__(self, kind: str, tiles_dir: Path | None = None):
        folder = extract(kind, tiles_dir)
        self.tiles = [[rasterio.open(folder / tile_name(kind, r, c)) for c in range(4)] for r in (0, 1)]
        for r in (0, 1):
            for c in range(4):
                t = self.tiles[r][c]
                if (t.width, t.height) != (TILE, TILE):
                    raise ValueError(f'{t.name}: expected {TILE} x {TILE}, got {t.width} x {t.height}')
                x0, y0 = t.transform.c, t.transform.f
                if abs(x0 - (-180.0 + 90.0 * c)) > 1e-6 or abs(y0 - (90.0 - 90.0 * r)) > 1e-6:
                    raise ValueError(f'{t.name}: unexpected origin {x0}, {y0}')
        self.dtype = self.tiles[0][0].dtypes[0]

    def rows(self, r0: int, r1: int) -> np.ndarray:
        """Global rows r0..r1 (clamped to the grid, so that a halo above the North Pole or below the South Pole
        repeats the polar row), all 86400 columns."""
        idx = np.clip(np.arange(r0, r1), 0, HEIGHT - 1)
        lo, hi = int(idx.min()), int(idx.max()) + 1
        out = np.empty((hi - lo, WIDTH), dtype=self.dtype)
        for tr in (0, 1):
            a, b = max(lo, tr * TILE), min(hi, (tr + 1) * TILE)
            if a >= b:
                continue
            for tc in range(4):
                out[a - lo:b - lo, tc * TILE:(tc + 1) * TILE] = self.tiles[tr][tc].read(
                    1, window=Window(0, a - tr * TILE, TILE, b - a))
        return out[idx - lo]

    def close(self) -> None:
        for row in self.tiles:
            for t in row:
                t.close()


def upsample2(a: np.ndarray) -> np.ndarray:
    """Bilinear resampling of a block of 15" rows, given with one halo row above and below, at the centres of
    the 7.5" pixels of its inner rows: (n + 2, W) -> (2n, 2W), wrapping around in longitude."""
    a = a.astype(np.float32)
    rows = np.empty((2 * (a.shape[0] - 2), a.shape[1]), dtype=np.float32)
    rows[0::2] = 0.25 * a[:-2] + 0.75 * a[1:-1]
    rows[1::2] = 0.75 * a[1:-1] + 0.25 * a[2:]
    out = np.empty((rows.shape[0], 2 * a.shape[1]), dtype=np.float32)
    out[:, 0::2] = 0.25 * np.roll(rows, 1, axis=1) + 0.75 * rows
    out[:, 1::2] = 0.75 * rows + 0.25 * np.roll(rows, -1, axis=1)
    return out


def elevation_7p5(gebco: Gebco, r0: int, r1: int) -> np.ndarray:
    """GEBCO elevation (metres, float32) at the centres of 7.5" rows r0..r1 (r0, r1 even), all 172800 columns."""
    return upsample2(gebco.rows(r0 // 2 - 1, r1 // 2 + 1))
