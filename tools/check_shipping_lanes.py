"""Checks src/data/shippingLanes.json against the planet's elevation: every lane, and the tracks either
side of it that ships keep to (each direction LANE_OFFSET_KM to starboard), must stay in water at least
MIN_DEPTH deep (PORT_DEPTH within PORT_KM of a lane's ends, where ships use dredged channels that a 30"
grid does not show), and so must most of each anchorage (at least ANCHORAGE_DEPTH). A waypoint's optional
third value narrows the separation (km) for the segment starting there, through a narrow strait; such
segments are checked at that separation, to PORT_DEPTH.

Uses the 30" elevation grid exported by tools/earth_hires.py (from additional_earth_imagery/sources, see
docs/ASSETS.md; it is exported if it is not there yet). Lanes are sampled every STEP_KM along great
circles, as the app joins their waypoints. Prints each stretch that is too shallow, by lane and segment.

    .venv/bin/python -m tools.check_shipping_lanes
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

import tools.earth_hires as e

ROOT = Path(__file__).resolve().parents[1]
LANES = ROOT / 'src' / 'data' / 'shippingLanes.json'
MIN_DEPTH = 10.0
PORT_DEPTH = 5.0
PORT_KM = 40.0
ANCHORAGE_DEPTH = 8.0
LANE_OFFSET_KM = 1.5
STEP_KM = 1.0
EARTH_KM = 6371.0
FACTOR = 4   # 30"


def unit(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    return np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])


def latlon(v):
    v = v / np.linalg.norm(v)
    return math.degrees(math.asin(v[2])), math.degrees(math.atan2(v[1], v[0]))


def height(grid, lat, lon):
    h, w = grid.shape
    x = int((lon + 180.0) / 360.0 * w) % w
    y = min(h - 1, max(0, int((90.0 - lat) / 180.0 * h)))
    return float(grid[y, x])


def segment_points(a, b):
    """Points every STEP_KM along the great circle a -> b, with the unit vector to the right of travel."""
    pa, pb = unit(*a), unit(*b)
    angle = math.acos(max(-1.0, min(1.0, float(pa @ pb))))
    n = max(1, int(angle * EARTH_KM / STEP_KM))
    for i in range(n + 1):
        t = i / n
        p = (math.sin((1 - t) * angle) * pa + math.sin(t * angle) * pb) / math.sin(angle) if angle > 1e-9 else pa
        p = p / np.linalg.norm(p)
        forward = pb - pa if angle <= 1e-9 else (-math.cos((1 - t) * angle) * pa + math.cos(t * angle) * pb)
        right = np.cross(forward, p)
        yield p, right / np.linalg.norm(right)


def main() -> None:
    e.export_level(e.SOURCES, e.ELEVATION_COG, FACTOR)
    grid = e.level(e.ELEVATION_COG, FACTOR)
    data = json.loads(LANES.read_text(encoding='utf-8'))
    offset = LANE_OFFSET_KM / EARTH_KM
    problems = 0
    for lane in data['lanes']:
        wps = lane['waypoints']
        ends = [unit(*wps[0][:2]), unit(*wps[-1][:2])]
        for s in range(len(wps) - 1):
            bad = []
            narrow = len(wps[s]) > 2
            separation = wps[s][2] / EARTH_KM if narrow else offset
            for p, right in segment_points(wps[s][:2], wps[s + 1][:2]):
                near_port = min(math.acos(max(-1.0, min(1.0, float(p @ end)))) for end in ends) * EARTH_KM < PORT_KM
                depth = PORT_DEPTH if near_port or narrow else MIN_DEPTH
                for side in (-1, 0, 1):
                    q = p * math.cos(separation * side) + right * math.sin(separation * side)
                    lat, lon = latlon(q)
                    if height(grid, lat, lon) > -depth:
                        bad.append((lat, lon))
                        break
            if bad:
                problems += 1
                lat, lon = bad[0]
                print(f'{lane["name"]}: segment {s} {wps[s]} -> {wps[s + 1]}: {len(bad)} shallow points, '
                      f'first at [{lat:.3f}, {lon:.3f}], last at [{bad[-1][0]:.3f}, {bad[-1][1]:.3f}]')
    for a in data['anchorages']:
        lat0, lon0 = a['lat'], a['lon']
        r = a['radiusKm']
        samples = [(lat0 + dy / 111.0, lon0 + dx / (111.0 * math.cos(math.radians(lat0))))
                   for dx in np.linspace(-r, r, 9) for dy in np.linspace(-r, r, 9) if dx * dx + dy * dy <= r * r]
        wet = sum(height(grid, lat, lon) <= -ANCHORAGE_DEPTH for lat, lon in samples) / len(samples)
        if height(grid, lat0, lon0) > -ANCHORAGE_DEPTH or wet < 0.6:
            problems += 1
            print(f'anchorage {a["name"]}: centre {height(grid, lat0, lon0):.0f} m, {wet * 100:.0f}% of it deep enough')
    print(f'{problems} problems' if problems else 'all lanes and anchorages are in deep water')


if __name__ == '__main__':
    main()
