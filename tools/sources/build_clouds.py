"""Real clouds for the Earth seen from space (src/planet/clouds/Clouds.js): for each of DATES, the cloud
opacity over the whole planet from that day's satellite imagery, written to assets/clouds.

Source: NASA GIBS, VIIRS (Suomi NPP) Corrected Reflectance true colour, daily global composites of the
daytime passes (https://nasa-gibs.github.io/gibs-api-docs/), as EPSG:4326 WMTS tiles at LEVEL (the whole
planet 10240 x 5120 pixels, about 3.9 km each), downloaded once into
additional_earth_imagery/clouds/viirs/. NASA imagery, free to use.

The clouds are separated from the ground by comparing the day with the clear ground: the darkest value of
each pixel over BACKGROUND_DAYS around it (clouds move, the ground does not, so this is the ground with the
season's snow, in the same colours). In linear light, a pixel is cloud of opacity a over that ground,
observed = a * CLOUD_WHITE + (1 - a) * ground, so a = (observed - ground) / (CLOUD_WHITE - ground), taken
from the blue channel (where clouds are brightest against land) and limited by the green one. Two
corrections:
  - Sun glint: where the satellite looked at the sun's reflection off the sea, the sea is bright, in
    stripes along its passes. VIIRS on NOAA-20 (half an orbit apart) and MODIS on Terra (three hours
    earlier) have their glint elsewhere: where the opacity is low (thin cloud or glint), it is limited by
    the lower of theirs (plus GLINT_TOLERANCE, for the clouds' movement and the instruments' colours).
  - Snow and ice: over bright ground clouds can hardly be told from it (and hardly show from space), so
    the opacity fades out as the clear ground brightens, between BRIGHT_GROUND.
Where the day has no data (polar night, the odd gap between passes), there is no cloud.

A day's composite has its passes taken around 13:30 local time, so either side of the date line was
imaged almost 24 hours apart, and the clouds do not meet there. The western hemisphere is taken from the
day before instead, which makes 180 degrees continuous in time and moves the jump to SEAM_LON, where the
two days are cross-faded over SEAM_WIDTH degrees (in the mid-Atlantic, away from most of the scenes).

Output: assets/clouds/<date>.jpg (greyscale, opacity * 255, equirectangular from 180 W, north at the top)
and assets/clouds/manifest.json ({ width, height, dates }).

    .venv/bin/python -m tools.sources.build_clouds
"""

from __future__ import annotations

import datetime
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from tools.sources.build_wind import fetch_file

ROOT = Path(__file__).resolve().parents[2]
DOWNLOADS = ROOT / 'additional_earth_imagery' / 'clouds' / 'viirs'
OUT = ROOT / 'assets' / 'clouds'
LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor'
GLINT_LAYERS = {'noaa20': 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', 'terra': 'MODIS_Terra_CorrectedReflectance_TrueColor'}
GLINT_TOLERANCE = 0.06
GLINT_MAX = 0.5        # opacities above this are left alone (glint is never that bright and white)
BRIGHT_GROUND = (0.3, 0.6)  # linear luminance of the clear ground
SEAM_LON = -25.0
SEAM_WIDTH = 15.0
URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{layer}/default/{date}/250m/{level}/{row}/{col}.jpg'
LEVEL = 4
TILE = 512
# The level's whole planet (EPSG:4326 tiles of 512 px covering 288 / 2^level degrees).
WIDTH = round(360 / (288 / 2 ** LEVEL) * TILE)
HEIGHT = WIDTH // 2
DATES = [f'2024-{m:02d}-15' for m in range(1, 13)]
BACKGROUND_DAYS = [-9, -6, -3, 3, 6, 9]
CLOUD_WHITE = 0.85  # linear reflectance of a thick cloud in the imagery


def srgb_to_linear(v):
    v = v / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def tile(layer: str, date: str, row: int, col: int) -> Path:
    name = f'{date}_{LEVEL}_{row}_{col}.jpg'
    folder = DOWNLOADS / date if layer == LAYER else DOWNLOADS.parent / next(k for k, v in GLINT_LAYERS.items() if v == layer) / date
    return fetch_file(URL.format(layer=layer, date=date, level=LEVEL, row=row, col=col), folder / name)


def day_image(date: str, layer: str = LAYER) -> np.ndarray:
    """The day's imagery (HEIGHT x WIDTH x 3, uint8), black where there is none."""
    cols, rows = -(-WIDTH // TILE), -(-HEIGHT // TILE)
    jobs = [(r, c) for r in range(rows) for c in range(cols)]
    with ThreadPoolExecutor(8) as pool:
        paths = list(pool.map(lambda rc: tile(layer, date, *rc), jobs))
    image = np.zeros((rows * TILE, cols * TILE, 3), np.uint8)
    for (r, c), path in zip(jobs, paths):
        with Image.open(io.BytesIO(path.read_bytes())) as im:
            image[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE] = np.asarray(im.convert('RGB'))
    return image[:HEIGHT, :WIDTH]


def build(date: str) -> np.ndarray:
    day = datetime.date.fromisoformat(date)
    ground = clear_ground(day)
    today = day_opacity(date, ground)
    yesterday = day_opacity((day - datetime.timedelta(days=1)).isoformat(), ground)
    # Longitude of each column, and the share of today's: 1 east of the seam to 180, 0 west of it from
    # -180, cross-faded across the seam.
    lon = (np.arange(WIDTH) + 0.5) / WIDTH * 360 - 180
    t = np.clip((lon - SEAM_LON) / SEAM_WIDTH + 0.5, 0, 1)
    share = (t * t * (3 - 2 * t))[None, :]
    return share * today + (1 - share) * yesterday


def clear_ground(day: datetime.date) -> np.ndarray:
    """The clear ground around a day: the darkest of each pixel over the days around it (int16 RGB)."""
    ground = None
    for offset in BACKGROUND_DAYS:
        other = day_image((day + datetime.timedelta(days=offset)).isoformat()).astype(np.int16)
        other[other.sum(axis=2) == 0] = 255  # (no data: never the darkest)
        ground = other if ground is None else np.minimum(ground, other)
    observed = day_image(day.isoformat())
    return np.minimum(ground, observed.astype(np.int16) + (observed.sum(axis=2, keepdims=True) == 0) * 255)


def day_opacity(date: str, ground: np.ndarray) -> np.ndarray:
    """A day's cloud opacity (0..1) over the clear ground."""
    observed = day_image(date)
    g = srgb_to_linear(ground.astype(np.float32))

    def opacity(image):
        o = srgb_to_linear(image.astype(np.float32))
        def channel(c):
            return np.clip((o[..., c] - g[..., c]) / np.maximum(CLOUD_WHITE - g[..., c], 0.05), 0, 1)
        a = np.minimum(channel(2), channel(1) * 1.15)
        a[image.sum(axis=2) == 0] = np.nan
        return a

    a = opacity(observed)
    others = np.fmin.reduce([opacity(day_image(date, layer)) for layer in GLINT_LAYERS.values()])
    glinty = (a < GLINT_MAX) & ~np.isnan(others)
    a[glinty] = np.minimum(a[glinty], others[glinty] + GLINT_TOLERANCE)
    a = np.nan_to_num(a, nan=0.0)
    luminance = g @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    t = np.clip((luminance - BRIGHT_GROUND[0]) / (BRIGHT_GROUND[1] - BRIGHT_GROUND[0]), 0, 1)
    return a * (1 - t * t * (3 - 2 * t))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for date in DATES:
        a = build(date)
        Image.fromarray(np.round(a * 255).astype(np.uint8), 'L').save(OUT / f'{date}.jpg', quality=90)
        print(f'{date}: mean opacity {a.mean():.3f}')
    (OUT / 'manifest.json').write_text(json.dumps({'width': WIDTH, 'height': HEIGHT, 'dates': DATES}, indent=1) + '\n')


if __name__ == '__main__':
    main()
