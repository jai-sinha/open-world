#!/usr/bin/env python3
"""
Build a fully offline city-road dataset from:
  - per-city GeoJSON boundaries
  - region source .osm.pbf files
  - regions.txt listing regions to process

Outputs under --output-dir:
  - cities-manifest.json
  - discovery-index.json
  - build-metadata.json
  - outlines/<city_id>.json
  - city-road-cells/<shard>/<city_id>.bin
  - region-build-metadata/<region>.json

This pipeline is designed for the open-world project runtime model:
  - city discovery via coarse discovery buckets
  - city exploration via intersection of visited cells with precomputed city road cells

Key design choices:
  - canonical road cells use the same Web Mercator meter grid as the app
  - default cell size is 50m to match the runtime default
  - roads are extracted from source PBFs using osmium
  - road geometries are rasterized into canonical cells offline
  - city membership is assigned offline on road-cell centers by the Go region assigner
  - per-city road cells are stored as sorted packed x/y int32 pairs in a simple binary format

Binary format for city-road-cells/<shard>/<city_id>.bin:
  bytes 0-3   magic "CWRC"
  byte  4     version = 1
  byte  5     reserved = 0
  bytes 6-7   reserved = 0
  bytes 8-11  cell_size_meters uint32 LE
  bytes 12-15 count uint32 LE
  bytes 16..  repeated int32 LE x, int32 LE y pairs

This script keeps the shipped runtime artifacts GIS-free and delegates the road-cell
assignment hot path to a Go helper binary.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, DefaultDict, Dict, Iterable, List, Optional, Sequence, Tuple

EARTH_RADIUS = 6378137.0
ORIGIN_SHIFT = math.pi * EARTH_RADIUS

SUPPORTED_GEOMETRY_TYPES = {"Polygon", "MultiPolygon"}

DEFAULT_HIGHWAY_VALUES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "pedestrian",
    "track",
    "footway",
    "bridleway",
    "steps",
    "path",
    "cycleway",
    "service",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
}

STRIPE_WIDTH_CELLS = 1024


@dataclass
class RegionInfo:
    name: str


@dataclass
class CityRecord:
    city_id: str
    osm_id: str
    name: str
    display_name: str
    region: Optional[str]
    admin_level: Optional[str]
    boundary_type: Optional[str]
    geometry_type: str
    bbox: Dict[str, float]
    center: Dict[str, float]
    outline_path: str
    source_path: str
    shard: str
    road_cells_path: str
    total_road_cells: Optional[int] = None
    road_cell_bounds: Optional[Dict[str, int]] = None


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def now_utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def lat_lng_to_meters(lat: float, lng: float) -> Tuple[float, float]:
    x = (lng * ORIGIN_SHIFT) / 180.0
    y = math.log(math.tan(((90.0 + lat) * math.pi) / 360.0)) / (math.pi / 180.0)
    y = (y * ORIGIN_SHIFT) / 180.0
    return x, y


def lng_lat_to_meters(
    lng: float, lat: float, z: Optional[float] = None
) -> tuple[float, float] | tuple[float, float, float]:
    x, y = lat_lng_to_meters(lat, lng)
    if z is None:
        return x, y
    return x, y, z


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, value: Any, pretty: bool) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(value, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        else:
            json.dump(
                value, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            )


def iter_city_files(cities_dir: str) -> Iterable[str]:
    for root, _, files in os.walk(cities_dir):
        for name in sorted(files):
            if name.endswith(".geojson"):
                yield os.path.join(root, name)


def read_regions(path: str) -> Dict[str, RegionInfo]:
    regions_by_name: Dict[str, RegionInfo] = {}
    if not path or not os.path.isfile(path):
        return regions_by_name

    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            region_name = line
            if not region_name:
                continue
            regions_by_name[region_name] = RegionInfo(name=region_name)
    return regions_by_name


def normalize_city_id(path: str, feature: Dict[str, Any]) -> str:
    props = feature.get("properties") or {}
    osm_id = props.get("osm_id")
    if isinstance(osm_id, str) and osm_id.strip():
        return osm_id.strip()

    feat_id = feature.get("id")
    if isinstance(feat_id, str) and feat_id.strip():
        return feat_id.strip().replace("/", "_")
    if feat_id is not None:
        return str(feat_id)

    base = os.path.basename(path)
    if base.endswith(".geojson"):
        return base[:-8]
    return base


def normalize_name(feature: Dict[str, Any], city_id: str) -> str:
    props = feature.get("properties") or {}
    for key in ("name", "name:en", "official_name", "short_name"):
        value = props.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return city_id


def iter_polygon_rings(geometry: Dict[str, Any]) -> Iterable[List[List[float]]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        if isinstance(coords, list):
            for ring in coords:
                if isinstance(ring, list):
                    yield ring
    elif gtype == "MultiPolygon":
        if isinstance(coords, list):
            for poly in coords:
                if isinstance(poly, list):
                    for ring in poly:
                        if isinstance(ring, list):
                            yield ring


def iter_outer_rings(geometry: Dict[str, Any]) -> Iterable[List[List[float]]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        if isinstance(coords, list) and coords and isinstance(coords[0], list):
            yield coords[0]
    elif gtype == "MultiPolygon":
        if isinstance(coords, list):
            for poly in coords:
                if isinstance(poly, list) and poly and isinstance(poly[0], list):
                    yield poly[0]


def compute_bbox(geometry: Dict[str, Any]) -> Optional[Dict[str, float]]:
    min_lat = 90.0
    max_lat = -90.0
    min_lng = 180.0
    max_lng = -180.0
    found = False

    for ring in iter_polygon_rings(geometry):
        for point in ring:
            if not isinstance(point, Sequence) or len(point) < 2:
                continue
            lng = point[0]
            lat = point[1]
            if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
                continue
            found = True
            if lat < min_lat:
                min_lat = lat
            if lat > max_lat:
                max_lat = lat
            if lng < min_lng:
                min_lng = lng
            if lng > max_lng:
                max_lng = lng

    if not found:
        return None

    return {
        "minLat": float(min_lat),
        "maxLat": float(max_lat),
        "minLng": float(min_lng),
        "maxLng": float(max_lng),
    }


def compute_center(bbox: Dict[str, float]) -> Dict[str, float]:
    return {
        "lat": (bbox["minLat"] + bbox["maxLat"]) / 2.0,
        "lng": (bbox["minLng"] + bbox["maxLng"]) / 2.0,
    }


def clamp_lat(lat: float) -> float:
    return max(-90.0, min(90.0, lat))


def clamp_lng(lng: float) -> float:
    return max(-180.0, min(180.0, lng))


def bucket_floor(value: float, size: float) -> float:
    return math.floor(value / size) * size


def format_bucket_value(value: float) -> str:
    if abs(value) < 1e-12:
        value = 0.0
    text = f"{value:.6f}"
    text = text.rstrip("0").rstrip(".")
    return text if text else "0"


def compute_discovery_buckets(
    bbox: Dict[str, float], bucket_size_deg: float
) -> List[str]:
    min_lat = clamp_lat(bbox["minLat"])
    max_lat = clamp_lat(bbox["maxLat"])
    min_lng = clamp_lng(bbox["minLng"])
    max_lng = clamp_lng(bbox["maxLng"])

    start_lat = bucket_floor(min_lat, bucket_size_deg)
    end_lat = bucket_floor(max_lat, bucket_size_deg)
    start_lng = bucket_floor(min_lng, bucket_size_deg)
    end_lng = bucket_floor(max_lng, bucket_size_deg)

    buckets: List[str] = []
    lat = start_lat
    while lat <= end_lat + 1e-12:
        lng = start_lng
        while lng <= end_lng + 1e-12:
            buckets.append(f"{format_bucket_value(lat)},{format_bucket_value(lng)}")
            lng += bucket_size_deg
        lat += bucket_size_deg
    return buckets


def choose_shard(region: Optional[str], city_id: str) -> str:
    if region:
        return region
    prefix = city_id.split("_", 1)[0]
    return prefix or "unknown"


def build_outline_path(city_id: str) -> str:
    return f"outlines/{city_id}.json"


def build_road_cells_path(city_id: str, shard: str) -> str:
    return f"city-road-cells/{shard}/{city_id}.bin"


def validate_feature(path: str, feature: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    if not isinstance(feature, dict):
        return False, "top-level JSON is not an object"
    if feature.get("type") != "Feature":
        return False, "GeoJSON object is not a Feature"
    geometry = feature.get("geometry")
    if not isinstance(geometry, dict):
        return False, "feature.geometry is missing or invalid"
    gtype = geometry.get("type")
    if gtype not in SUPPORTED_GEOMETRY_TYPES:
        return False, f"unsupported geometry type: {gtype!r}"
    return True, None


def ring_area(ring: List[List[float]]) -> float:
    if len(ring) < 3:
        return 0.0
    area = 0.0
    prev = ring[-1]
    for cur in ring:
        if len(prev) < 2 or len(cur) < 2:
            prev = cur
            continue
        x1, y1 = prev[0], prev[1]
        x2, y2 = cur[0], cur[1]
        if not isinstance(x1, (int, float)) or not isinstance(y1, (int, float)):
            prev = cur
            continue
        if not isinstance(x2, (int, float)) or not isinstance(y2, (int, float)):
            prev = cur
            continue
        area += (x1 * y2) - (x2 * y1)
        prev = cur
    return area / 2.0


def choose_primary_outer_ring(geometry: Dict[str, Any]) -> List[List[float]]:
    best_ring: List[List[float]] = []
    best_abs_area = -1.0
    for ring in iter_outer_rings(geometry):
        area = abs(ring_area(ring))
        if area > best_abs_area:
            best_abs_area = area
            best_ring = ring
    return best_ring


def normalize_ring_points(ring: List[List[float]]) -> List[List[float]]:
    points: List[List[float]] = []
    for pt in ring:
        if not isinstance(pt, Sequence) or len(pt) < 2:
            continue
        lng = pt[0]
        lat = pt[1]
        if not isinstance(lng, (int, float)) or not isinstance(lat, (int, float)):
            continue
        points.append([float(lng), float(lat)])
    if len(points) >= 2 and points[0] == points[-1]:
        points = points[:-1]
    return points


def dp_simplify(points: List[List[float]], tolerance: float) -> List[List[float]]:
    if len(points) <= 2 or tolerance <= 0:
        return points[:]

    tol2 = tolerance * tolerance
    keep = [False] * len(points)
    keep[0] = True
    keep[-1] = True
    stack: List[Tuple[int, int]] = [(0, len(points) - 1)]

    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue

        x1, y1 = points[start]
        x2, y2 = points[end]
        dx = x2 - x1
        dy = y2 - y1
        seg_len2 = dx * dx + dy * dy

        max_d2 = -1.0
        max_idx = start

        for i in range(start + 1, end):
            px = points[i][0] - x1
            py = points[i][1] - y1
            if seg_len2 == 0:
                d2 = px * px + py * py
            else:
                t = (px * dx + py * dy) / seg_len2
                qx = px - t * dx
                qy = py - t * dy
                d2 = qx * qx + qy * qy
            if d2 > max_d2:
                max_d2 = d2
                max_idx = i

        if max_d2 > tol2:
            keep[max_idx] = True
            stack.append((start, max_idx))
            stack.append((max_idx, end))

    return [pt for i, pt in enumerate(points) if keep[i]]


def build_outline_payload(
    city_id: str, geometry: Dict[str, Any], tolerance_deg: float
) -> Dict[str, Any]:
    outlines: List[List[List[float]]] = []

    for ring in iter_outer_rings(geometry):
        points = normalize_ring_points(ring)
        if len(points) < 2:
            continue
        simplified = dp_simplify(points, tolerance_deg)
        if len(simplified) >= 2:
            outlines.append(simplified)

    if not outlines:
        primary = normalize_ring_points(choose_primary_outer_ring(geometry))
        if len(primary) >= 2:
            outlines.append(primary)

    return {
        "version": 1,
        "cityId": city_id,
        "toleranceDeg": tolerance_deg,
        "outlines": outlines,
    }


def build_city_record(
    path: str,
    feature: Dict[str, Any],
    cities_dir: str,
    regions_by_name: Dict[str, RegionInfo],
) -> Optional[CityRecord]:
    geometry = feature["geometry"]
    bbox = compute_bbox(geometry)
    if bbox is None:
        return None

    city_id = normalize_city_id(path, feature)
    props = feature.get("properties") or {}

    osm_id = props.get("osm_id")
    if not isinstance(osm_id, str) or not osm_id.strip():
        osm_id = city_id

    name = normalize_name(feature, city_id)
    display_name = name

    road_tiles = props.get("road_tiles")
    if road_tiles is not None and not isinstance(road_tiles, str):
        road_tiles = str(road_tiles)

    admin_level = props.get("admin_level")
    if admin_level is not None and not isinstance(admin_level, str):
        admin_level = str(admin_level)

    boundary_type = props.get("boundary")
    if boundary_type is not None and not isinstance(boundary_type, str):
        boundary_type = str(boundary_type)

    region = None
    explicit_region = props.get("region")
    if isinstance(explicit_region, str) and explicit_region.strip():
        explicit_region = explicit_region.strip()
        region = explicit_region
    elif road_tiles:
        road_tiles_base = os.path.basename(road_tiles)
        if road_tiles_base.endswith(".pmtiles"):
            road_tiles_base = road_tiles_base[:-8]
        if road_tiles_base in regions_by_name:
            region = road_tiles_base

    center = compute_center(bbox)
    shard = choose_shard(region, city_id)
    rel_source_path = os.path.relpath(path, cities_dir)

    return CityRecord(
        city_id=city_id,
        osm_id=osm_id,
        name=name,
        display_name=display_name,
        region=region,
        admin_level=admin_level,
        boundary_type=boundary_type,
        geometry_type=geometry["type"],
        bbox=bbox,
        center=center,
        outline_path=build_outline_path(city_id),
        source_path=rel_source_path,
        shard=shard,
        road_cells_path=build_road_cells_path(city_id, shard),
    )


def city_record_to_manifest_entry(city: CityRecord) -> Dict[str, Any]:
    return {
        "id": city.city_id,
        "osmId": city.osm_id,
        "name": city.name,
        "displayName": city.display_name,
        "region": city.region,
        "adminLevel": city.admin_level,
        "boundaryType": city.boundary_type,
        "geometryType": city.geometry_type,
        "bbox": city.bbox,
        "center": city.center,
        "outlinePath": city.outline_path,
        "sourcePath": city.source_path,
        "shard": city.shard,
        "totalRoadCells": city.total_road_cells,
        "roadCellsPath": city.road_cells_path,
        "roadCellEncoding": "xy-int32-pairs-v1",
        "roadCellBounds": city.road_cell_bounds,
    }


def build_manifest(
    cities: List[CityRecord],
    bucket_size_deg: float,
    outline_tolerance_deg: float,
    cell_size_meters: int,
    cities_dir: str,
    regions_by_name: Dict[str, RegionInfo],
) -> Dict[str, Any]:
    by_id = {city.city_id: city_record_to_manifest_entry(city) for city in cities}

    regions_summary: Dict[str, Dict[str, Any]] = {}
    for city in cities:
        region_name = city.region or "unknown"
        entry = regions_summary.setdefault(
            region_name,
            {
                "cityCount": 0,
            },
        )
        entry["cityCount"] += 1

    normalized_regions_summary: Dict[str, Dict[str, Any]] = {}
    for region_name, entry in sorted(regions_summary.items()):
        normalized_regions_summary[region_name] = {
            "cityCount": entry["cityCount"],
        }

    configured_regions = sorted(regions_by_name.keys())

    return {
        "version": 2,
        "generator": "build_city_dataset.py",
        "schema": {
            "cityRoadCells": "xy-int32-pairs-v1",
            "discoveryIndex": "bbox-bucket-candidates",
            "outlines": "simplified-outer-rings",
        },
        "config": {
            "bucketSizeDeg": bucket_size_deg,
            "outlineToleranceDeg": outline_tolerance_deg,
            "cellSizeMeters": cell_size_meters,
            "citiesDir": os.path.abspath(cities_dir),
        },
        "summary": {
            "cityCount": len(cities),
            "shardCount": len({city.shard for city in cities}),
            "regionCount": len({city.region for city in cities if city.region}),
            "withRoadCells": sum(
                1 for city in cities if city.total_road_cells is not None
            ),
        },
        "regions": {
            "configured": configured_regions,
            "usedByCities": normalized_regions_summary,
        },
        "cities": by_id,
    }


def build_discovery_index(
    cities: List[CityRecord], bucket_size_deg: float
) -> Dict[str, Any]:
    buckets: Dict[str, List[str]] = {}
    for city in cities:
        for bucket in compute_discovery_buckets(city.bbox, bucket_size_deg):
            buckets.setdefault(bucket, []).append(city.city_id)

    for bucket, city_ids in buckets.items():
        city_ids.sort()

    return {
        "version": 1,
        "generator": "build_city_dataset.py",
        "strategy": "bbox-bucket-candidates",
        "bucketSizeDeg": bucket_size_deg,
        "bucketCount": len(buckets),
        "buckets": buckets,
    }


def ensure_shard_dirs(output_dir: str, cities: List[CityRecord]) -> None:
    road_cells_root = os.path.join(output_dir, "city-road-cells")
    os.makedirs(road_cells_root, exist_ok=True)
    for shard in sorted({city.shard for city in cities}):
        os.makedirs(os.path.join(road_cells_root, shard), exist_ok=True)


def write_outline(
    output_dir: str,
    city: CityRecord,
    geometry: Dict[str, Any],
    tolerance_deg: float,
    pretty: bool,
) -> None:
    outlines_root = os.path.join(output_dir, "outlines")
    os.makedirs(outlines_root, exist_ok=True)
    payload = build_outline_payload(city.city_id, geometry, tolerance_deg)
    write_json(os.path.join(output_dir, city.outline_path), payload, pretty)


def build_region_assignment_request(
    region_name: str,
    cities: List[CityRecord],
    source_pbf: str,
    output_dir: str,
    cities_dir: str,
    cell_size: int,
    stripe_width: int,
) -> Dict[str, Any]:
    return {
        "regionName": region_name,
        "sourcePbf": source_pbf,
        "outputDir": output_dir,
        "cellSizeMeters": cell_size,
        "stripeWidthCells": stripe_width,
        "highwayValues": sorted(DEFAULT_HIGHWAY_VALUES),
        "cities": [
            {
                "cityId": city.city_id,
                "roadCellsPath": city.road_cells_path,
                "sourcePath": os.path.join(cities_dir, city.source_path),
                "bbox": city.bbox,
            }
            for city in cities
        ],
    }


def run_go_region_assignment(
    region_name: str,
    cities: List[CityRecord],
    source_pbf: str,
    output_dir: str,
    cities_dir: str,
    cell_size: int,
    stripe_width: int = STRIPE_WIDTH_CELLS,
) -> Dict[str, Any]:
    for city in cities:
        city.road_cell_bounds = bbox_to_cell_bounds(city.bbox, cell_size)
        city.total_road_cells = 0

    request = build_region_assignment_request(
        region_name=region_name,
        cities=cities,
        source_pbf=source_pbf,
        output_dir=output_dir,
        cities_dir=cities_dir,
        cell_size=cell_size,
        stripe_width=stripe_width,
    )

    assigner_bin = os.environ.get(
        "CITY_ROAD_CELLS_ASSIGNER_BIN", "/planetiler/city_road_cells_assigner"
    )

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix=f"assign-{region_name}-", delete=False
    ) as request_file:
        json.dump(request, request_file, ensure_ascii=False, separators=(",", ":"))
        request_path = request_file.name

    try:
        proc = subprocess.run(
            [assigner_bin, "--request", request_path],
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            check=False,
        )
    finally:
        try:
            os.remove(request_path)
        except FileNotFoundError:
            pass

    if proc.returncode != 0:
        raise RuntimeError(
            f"go region assignment failed for {region_name} with exit code {proc.returncode}"
        )

    try:
        region_meta = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"failed to parse go region assignment output for {region_name}: {exc}"
        ) from exc

    city_stats = region_meta.get("cities")
    if not isinstance(city_stats, dict):
        raise RuntimeError(
            f"go region assignment output missing city stats for {region_name}"
        )

    for city in cities:
        stats = city_stats.get(city.city_id)
        if not isinstance(stats, dict):
            raise RuntimeError(
                f"go region assignment output missing stats for city {city.city_id}"
            )
        assigned = stats.get("assignedRoadCells")
        if not isinstance(assigned, int):
            raise RuntimeError(
                f"go region assignment output has invalid assignedRoadCells for city {city.city_id}"
            )
        city.total_road_cells = assigned

    return region_meta


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build full offline city-road dataset from city GeoJSON boundaries and source PBFs."
    )
    parser.add_argument(
        "--cities-dir",
        required=True,
        help="Directory containing per-city GeoJSON files.",
    )
    parser.add_argument(
        "--regions-file",
        required=False,
        default="",
        help="Optional regions.txt file containing one region name per line.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory where dataset artifacts will be written.",
    )
    parser.add_argument(
        "--sources-dir",
        required=False,
        default="/sources",
        help="Directory containing <region>-latest.osm.pbf files. Default: /sources",
    )
    parser.add_argument(
        "--bucket-size-deg",
        type=float,
        default=0.25,
        help="Discovery index bucket size in degrees. Default: 0.25",
    )
    parser.add_argument(
        "--outline-tolerance-deg",
        type=float,
        default=0.0015,
        help="Douglas-Peucker tolerance in degrees for outline export. Default: 0.0015",
    )
    parser.add_argument(
        "--cell-size-meters",
        type=int,
        default=50,
        help="Canonical road cell size in meters. Default: 50",
    )
    parser.add_argument(
        "--manifest-name",
        default="cities-manifest.json",
        help="Output manifest filename. Default: cities-manifest.json",
    )
    parser.add_argument(
        "--discovery-index-name",
        default="discovery-index.json",
        help="Output discovery index filename. Default: discovery-index.json",
    )
    parser.add_argument(
        "--build-metadata-name",
        default="build-metadata.json",
        help="Output build metadata filename. Default: build-metadata.json",
    )
    parser.add_argument(
        "--roads-cache-dir",
        default="",
        help="Optional cache directory for extracted region road GeoJSONSeq. Defaults to <output-dir>/.cache/roads",
    )
    parser.add_argument(
        "--skip-road-cells",
        action="store_true",
        help="Only build manifest/discovery/outlines; skip offline road-cell assignment.",
    )
    parser.add_argument(
        "--force-reextract-roads",
        action="store_true",
        help="Force re-extraction of region road GeoJSONSeq even if cache exists.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON outputs for inspection.",
    )
    return parser.parse_args()


def region_pbf_path(sources_dir: str, region_name: str) -> str:
    return os.path.join(sources_dir, f"{region_name}-latest.osm.pbf")


def bbox_to_cell_bounds(bbox: Dict[str, float], cell_size: int) -> Dict[str, int]:
    min_x_m, min_y_m = lat_lng_to_meters(bbox["minLat"], bbox["minLng"])
    max_x_m, max_y_m = lat_lng_to_meters(bbox["maxLat"], bbox["maxLng"])

    min_x = math.floor(min(min_x_m, max_x_m) / cell_size)
    max_x = math.floor(max(min_x_m, max_x_m) / cell_size)
    min_y = math.floor(min(min_y_m, max_y_m) / cell_size)
    max_y = math.floor(max(min_y_m, max_y_m) / cell_size)

    return {
        "minX": int(min_x),
        "maxX": int(max_x),
        "minY": int(min_y),
        "maxY": int(max_y),
    }


def write_region_metadata(
    output_dir: str, region_name: str, payload: Dict[str, Any], pretty: bool
) -> None:
    path = os.path.join(output_dir, "region-build-metadata", f"{region_name}.json")
    write_json(path, payload, pretty)


def build_build_metadata(
    args: argparse.Namespace,
    cities: List[CityRecord],
    regions_processed: List[Dict[str, Any]],
    roads_cache_dir: str,
    started_at: float,
) -> Dict[str, Any]:
    elapsed = time.time() - started_at
    return {
        "version": 2,
        "generator": "build_city_dataset.py",
        "generatedAtUtc": now_utc_iso(),
        "inputs": {
            "citiesDir": os.path.abspath(args.cities_dir),
            "regionsFile": os.path.abspath(args.regions_file)
            if args.regions_file
            else "",
            "sourcesDir": os.path.abspath(args.sources_dir),
            "roadsCacheDir": os.path.abspath(roads_cache_dir),
            "cellSizeMeters": args.cell_size_meters,
            "bucketSizeDeg": args.bucket_size_deg,
            "outlineToleranceDeg": args.outline_tolerance_deg,
            "cityCount": len(cities),
        },
        "outputs": {
            "outputDir": os.path.abspath(args.output_dir),
            "manifestPath": os.path.join(args.output_dir, args.manifest_name),
            "discoveryIndexPath": os.path.join(
                args.output_dir, args.discovery_index_name
            ),
            "buildMetadataPath": os.path.join(
                args.output_dir, args.build_metadata_name
            ),
            "roadCellsDir": os.path.join(args.output_dir, "city-road-cells"),
            "outlinesDir": os.path.join(args.output_dir, "outlines"),
            "regionMetadataDir": os.path.join(args.output_dir, "region-build-metadata"),
        },
        "summary": {
            "citiesWithRoadCells": sum(
                1 for city in cities if city.total_road_cells is not None
            ),
            "totalAssignedRoadCells": sum(
                city.total_road_cells or 0 for city in cities
            ),
            "regionsProcessed": len(regions_processed),
            "skipRoadCells": bool(args.skip_road_cells),
        },
        "regions": regions_processed,
        "timing": {
            "elapsedSeconds": round(elapsed, 3),
            "elapsedHuman": f"{int(elapsed // 60)}m {int(elapsed % 60)}s",
        },
    }


def main() -> int:
    args = parse_args()

    if args.bucket_size_deg <= 0:
        eprint("error: --bucket-size-deg must be > 0")
        return 1
    if args.outline_tolerance_deg < 0:
        eprint("error: --outline-tolerance-deg must be >= 0")
        return 1
    if args.cell_size_meters <= 0:
        eprint("error: --cell-size-meters must be > 0")
        return 1
    if not os.path.isdir(args.cities_dir):
        eprint(f"error: cities directory does not exist: {args.cities_dir}")
        return 1
    if not os.path.isdir(args.output_dir):
        os.makedirs(args.output_dir, exist_ok=True)

    started_at = time.time()

    regions_by_name = read_regions(args.regions_file)
    cities: List[CityRecord] = []
    city_ids_seen: set[str] = set()
    errors = 0
    skipped = 0
    duplicate_ids = 0
    outlines_written = 0

    for path in iter_city_files(args.cities_dir):
        try:
            feature = load_json(path)
        except Exception as exc:
            eprint(f"warn: failed to read {path}: {exc}")
            errors += 1
            continue

        ok, reason = validate_feature(path, feature)
        if not ok:
            eprint(f"warn: skipping {path}: {reason}")
            skipped += 1
            continue

        city = build_city_record(
            path=path,
            feature=feature,
            cities_dir=args.cities_dir,
            regions_by_name=regions_by_name,
        )
        if city is None:
            eprint(f"warn: skipping {path}: could not compute bbox")
            skipped += 1
            continue

        if city.city_id in city_ids_seen:
            eprint(
                f"warn: duplicate city id {city.city_id!r} from {path}; keeping first occurrence"
            )
            duplicate_ids += 1
            skipped += 1
            continue

        write_outline(
            output_dir=args.output_dir,
            city=city,
            geometry=feature["geometry"],
            tolerance_deg=args.outline_tolerance_deg,
            pretty=args.pretty,
        )

        cities.append(city)
        city_ids_seen.add(city.city_id)
        outlines_written += 1

    cities.sort(key=lambda c: c.city_id)

    ensure_shard_dirs(args.output_dir, cities)

    roads_cache_dir = args.roads_cache_dir or os.path.join(
        args.output_dir, ".cache", "roads"
    )
    os.makedirs(roads_cache_dir, exist_ok=True)

    regions_processed: List[Dict[str, Any]] = []

    if not args.skip_road_cells:
        if not regions_by_name:
            eprint(
                "error: no regions configured; road-cell assignment requires a populated regions file"
            )
            return 1

        cities_without_region = [city.city_id for city in cities if not city.region]
        if cities_without_region:
            sample = ", ".join(cities_without_region[:10])
            eprint(
                "error: some city boundaries could not be matched to a region from regions.txt; "
                f"cannot build road cells for {len(cities_without_region)} cities. sample: {sample}"
            )
            return 1

        cities_by_region: DefaultDict[str, List[CityRecord]] = defaultdict(list)
        for city in cities:
            if city.region:
                cities_by_region[city.region].append(city)

        for region_name in sorted(cities_by_region.keys()):
            region = regions_by_name.get(region_name)
            if region is None:
                eprint(f"error: no region mapping found for {region_name}")
                return 1

            eprint(
                f"processing region {region_name} ({len(cities_by_region[region_name])} cities)"
            )
            source_pbf = region_pbf_path(args.sources_dir, region_name)
            if not os.path.isfile(source_pbf):
                eprint(
                    f"error: source PBF not found for region {region_name}: {source_pbf}"
                )
                return 1

            region_meta = run_go_region_assignment(
                region_name=region_name,
                cities=cities_by_region[region_name],
                source_pbf=source_pbf,
                output_dir=args.output_dir,
                cities_dir=args.cities_dir,
                cell_size=args.cell_size_meters,
            )
            region_meta["sourcePbf"] = source_pbf
            write_region_metadata(
                args.output_dir, region_name, region_meta, args.pretty
            )
            regions_processed.append(region_meta)

        if not regions_processed:
            eprint("error: road-cell generation processed zero regions")
            return 1

        missing_road_cell_outputs = []
        for city in cities:
            out_path = os.path.join(args.output_dir, city.road_cells_path)
            if city.total_road_cells is None or not os.path.isfile(out_path):
                missing_road_cell_outputs.append(city.city_id)

        if missing_road_cell_outputs:
            sample = ", ".join(missing_road_cell_outputs[:10])
            eprint(
                "error: road-cell generation did not produce blobs for "
                f"{len(missing_road_cell_outputs)} cities. sample: {sample}"
            )
            return 1

    manifest = build_manifest(
        cities=cities,
        bucket_size_deg=args.bucket_size_deg,
        outline_tolerance_deg=args.outline_tolerance_deg,
        cell_size_meters=args.cell_size_meters,
        cities_dir=args.cities_dir,
        regions_by_name=regions_by_name,
    )
    discovery_index = build_discovery_index(cities, args.bucket_size_deg)
    build_metadata = build_build_metadata(
        args=args,
        cities=cities,
        regions_processed=regions_processed,
        roads_cache_dir=roads_cache_dir,
        started_at=started_at,
    )

    manifest_path = os.path.join(args.output_dir, args.manifest_name)
    discovery_index_path = os.path.join(args.output_dir, args.discovery_index_name)
    build_metadata_path = os.path.join(args.output_dir, args.build_metadata_name)

    write_json(manifest_path, manifest, args.pretty)
    write_json(discovery_index_path, discovery_index, args.pretty)
    write_json(build_metadata_path, build_metadata, args.pretty)

    print(
        f"Built city dataset: {len(cities)} cities, "
        f"{discovery_index['bucketCount']} discovery buckets, "
        f"{outlines_written} outlines"
    )
    print(f"  manifest:        {manifest_path}")
    print(f"  discovery index: {discovery_index_path}")
    print(f"  build metadata:  {build_metadata_path}")
    print(f"  outlines dir:    {os.path.join(args.output_dir, 'outlines')}")
    print(f"  road cells dir:  {os.path.join(args.output_dir, 'city-road-cells')}")
    if skipped:
        print(f"  skipped:         {skipped}")
    if duplicate_ids:
        print(f"  duplicate ids:   {duplicate_ids}")
    if errors:
        print(f"  read errors:     {errors}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
