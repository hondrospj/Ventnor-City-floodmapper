#!/usr/bin/env python3
"""Build a self-contained connected-water PNG catalog from a NAVD88 DEM.

The model matches the floodmapper's established four-neighbour connected-
bathtub contract.  Large low-elevation water components are treated as tidal
sources.  At each catalog stage, only cells connected to those sources are
rendered as water; other below-stage cells remain green.  A compact RGBA PNG
stores ground elevation and first-connection stage for browser depth queries.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal
from PIL import Image
from scipy import ndimage


gdal.UseExceptions()

FOUR_NEIGHBOUR_STRUCTURE = np.asarray(
    [[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8
)
DEPTH_BREAKS_FT = np.asarray(
    [0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00]
)
DEPTH_COLORS = [
    "#7DF9FF",
    "#5DE7FF",
    "#38D3FF",
    "#1BB7F5",
    "#168CEB",
    "#156BE0",
    "#1853C6",
    "#173EA8",
    "#132F84",
    "#0B1E5B",
    "#050E33",
]
DISCONNECTED_COLOR = "#63D471"
STAGE_COLORS = ["#F4A742", "#E74C3C", "#7D3C98"]
LOW_STAGE_VERTICAL_PENALTY_FT = 1.25
VERTICAL_PENALTY_EXPONENTIAL_DECAY_RATE = 1.5
MAX_LOCAL_DEPTH_PENALTY_FRACTION = 0.75


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--town-folder", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--minor", type=float, required=True)
    parser.add_argument("--moderate", type=float, required=True)
    parser.add_argument("--major", type=float, required=True)
    parser.add_argument("--stage-min", type=float, default=0.0)
    parser.add_argument("--stage-max", type=float, default=20.0)
    parser.add_argument("--stage-step", type=float, default=0.1)
    parser.add_argument("--source-stage", type=float, default=1.0)
    parser.add_argument("--source-min-cells", type=int, default=101)
    return parser.parse_args()


def rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def palette(colors: list[str], disconnected_index: int) -> tuple[list[int], bytes]:
    values = [0] * (256 * 3)
    alpha = bytearray(256)
    for index, color in enumerate(colors, start=1):
        values[index * 3 : index * 3 + 3] = list(rgb(color))
        alpha[index] = 224 if disconnected_index == 12 else 255
    values[disconnected_index * 3 : disconnected_index * 3 + 3] = list(
        rgb(DISCONNECTED_COLOR)
    )
    alpha[disconnected_index] = 205
    return values, bytes(alpha)


def stage_code(stage_ft: float) -> str:
    sign = "m" if stage_ft < 0 else "p"
    return f"{sign}{round(abs(stage_ft) * 10):03d}"


def vertical_penalty(stage_ft: float, minor: float, major: float) -> float:
    if stage_ft <= minor:
        return LOW_STAGE_VERTICAL_PENALTY_FT
    if stage_ft >= major:
        return 0.0
    progress = (stage_ft - minor) / (major - minor)
    decay = VERTICAL_PENALTY_EXPONENTIAL_DECAY_RATE
    residual = math.exp(-decay)
    normalized = (math.exp(-decay * progress) - residual) / (1.0 - residual)
    return LOW_STAGE_VERTICAL_PENALTY_FT * normalized


def save_paletted(
    codes: np.ndarray, image_palette: list[int], transparency: bytes, path: Path
) -> None:
    image = Image.fromarray(codes, mode="P")
    image.putpalette(image_palette)
    image.info["transparency"] = transparency
    image.save(path, format="PNG", optimize=False, compress_level=7)


def write_packed_query(
    dem: np.ndarray, valid: np.ndarray, connection: np.ndarray, destination: Path
) -> dict:
    elevation10 = np.zeros(dem.shape, dtype=np.int16)
    elevation10[valid] = np.rint(dem[valid] * 10.0).astype(np.int16)
    unsigned = np.zeros(dem.shape, dtype=np.uint16)
    unsigned[valid] = (elevation10[valid].astype(np.int32) + 32768).astype(
        np.uint16
    )
    packed = np.empty((*dem.shape, 4), dtype=np.uint8)
    packed[..., 0] = (unsigned >> 8).astype(np.uint8)
    packed[..., 1] = (unsigned & 0xFF).astype(np.uint8)
    packed[..., 2] = 255
    connection10 = np.rint(connection * 10.0)
    encodable = valid & np.isfinite(connection10) & (connection10 >= -50) & (
        connection10 <= 204
    )
    packed[..., 2][encodable] = (
        connection10[encodable].astype(np.int32) + 50
    ).astype(np.uint8)
    packed[..., 3] = 255
    Image.fromarray(packed, mode="RGBA").save(
        destination, format="PNG", optimize=False, compress_level=7
    )
    return {
        "schema": "floodmapper-packed-depth-query-v2",
        "width": int(dem.shape[1]),
        "height": int(dem.shape[0]),
        "channels": {
            "redGreen": "NAVD88 elevation in tenths, unsigned big-endian plus 32768; zero is nodata",
            "blue": "first four-neighbour connection stage in tenths plus 50; 255 is not connected through the catalog maximum",
            "alpha": "255",
        },
        "bytes": destination.stat().st_size,
    }


def build(args: argparse.Namespace) -> dict:
    dem_path = args.dem.expanduser().resolve()
    output = args.output.expanduser().resolve()
    depth_dir = output / "DepthPNGs" / args.town_folder
    stage_dir = output / "StagePNGs" / args.town_folder
    cog_dir = output / "COGs" / args.town_folder
    for directory in (depth_dir, stage_dir, cog_dir):
        directory.mkdir(parents=True, exist_ok=True)

    dataset = gdal.Open(str(dem_path), gdal.GA_ReadOnly)
    if dataset is None:
        raise RuntimeError(f"Could not open DEM: {dem_path}")
    band = dataset.GetRasterBand(1)
    nodata = band.GetNoDataValue()
    raw = band.ReadAsArray().astype(np.float32)
    valid = np.isfinite(raw)
    if nodata is not None:
        valid &= raw != np.float32(nodata)
    dem = np.where(valid, raw, np.nan).astype(np.float32)
    width, height = dataset.RasterXSize, dataset.RasterYSize
    geo_transform = tuple(dataset.GetGeoTransform())
    projection = dataset.GetProjection()
    dataset = None
    del raw

    wet_at_source = valid & (dem <= args.source_stage + 1e-6)
    labels, component_count = ndimage.label(
        wet_at_source, structure=FOUR_NEIGHBOUR_STRUCTURE
    )
    sizes = np.bincount(labels.ravel())
    source_ids = np.flatnonzero(sizes >= args.source_min_cells)
    source_ids = source_ids[source_ids != 0]
    lookup = np.zeros(component_count + 1, dtype=bool)
    lookup[source_ids] = True
    source = wet_at_source & lookup[labels]
    source_sizes = sizes[source_ids]
    del labels, sizes, lookup, wet_at_source

    depth_palette, depth_alpha = palette(DEPTH_COLORS, 12)
    stage_palette, stage_alpha = palette(STAGE_COLORS, 4)
    stage_values = np.round(
        np.arange(
            args.stage_min,
            args.stage_max + args.stage_step / 2.0,
            args.stage_step,
        ),
        1,
    )
    first_connection = np.full(dem.shape, np.nan, dtype=np.float32)
    statistics: list[dict] = []

    for index, stage_ft_raw in enumerate(stage_values):
        stage_ft = float(stage_ft_raw)
        candidate = valid & (dem <= stage_ft + 1e-6)
        stage_labels, stage_component_count = ndimage.label(
            candidate, structure=FOUR_NEIGHBOUR_STRUCTURE
        )
        connected_ids = np.unique(stage_labels[source & candidate])
        connected_ids = connected_ids[connected_ids != 0]
        connected_lookup = np.zeros(stage_component_count + 1, dtype=bool)
        connected_lookup[connected_ids] = True
        connected = candidate & connected_lookup[stage_labels]
        newly_connected = connected & ~np.isfinite(first_connection)
        first_connection[newly_connected] = stage_ft

        raw_depth = np.maximum(0.0, stage_ft - dem)
        flooded = connected & (raw_depth > 0.005)
        green = candidate & ~flooded
        maximum_penalty = vertical_penalty(stage_ft, args.minor, args.major)
        depth = raw_depth - np.minimum(
            maximum_penalty, raw_depth * MAX_LOCAL_DEPTH_PENALTY_FRACTION
        )

        depth_codes = np.zeros(dem.shape, dtype=np.uint8)
        depth_codes[green] = 12
        if np.any(flooded):
            depth_codes[flooded] = (
                np.digitize(depth[flooded], DEPTH_BREAKS_FT, right=False) + 1
            ).astype(np.uint8)

        stage_codes = np.zeros(dem.shape, dtype=np.uint8)
        stage_codes[green] = 4
        if np.any(flooded):
            activation = np.maximum(dem[flooded], first_connection[flooded])
            stage_codes[flooded] = np.where(
                activation < args.minor,
                1,
                np.where(activation < args.moderate, 2, 3),
            ).astype(np.uint8)

        code = stage_code(stage_ft)
        depth_path = depth_dir / f"{args.prefix}Depth{code}.png"
        stage_path = stage_dir / f"{args.prefix}Stage{code}.png"
        save_paletted(depth_codes, depth_palette, depth_alpha, depth_path)
        save_paletted(stage_codes, stage_palette, stage_alpha, stage_path)
        statistics.append(
            {
                "stageNavd88Ft": stage_ft,
                "connectedCells": int(np.count_nonzero(flooded)),
                "disconnectedBelowStageCells": int(np.count_nonzero(green)),
                "depthPngBytes": depth_path.stat().st_size,
                "stagePngBytes": stage_path.stat().st_size,
            }
        )
        if index % 10 == 0 or index == len(stage_values) - 1:
            print(
                f"[{index + 1:03d}/{len(stage_values)}] {stage_ft:4.1f} ft: "
                f"{statistics[-1]['connectedCells']:,} connected, "
                f"{statistics[-1]['disconnectedBelowStageCells']:,} green",
                flush=True,
            )
        del (
            candidate,
            stage_labels,
            connected_lookup,
            connected,
            newly_connected,
            raw_depth,
            flooded,
            green,
            depth,
            depth_codes,
            stage_codes,
        )

    query_path = cog_dir / f"{args.prefix}HydraulicQuery5ft.png"
    packed_query = write_packed_query(dem, valid, first_connection, query_path)
    valid_values = dem[valid]
    manifest = {
        "schema": "floodmapper-connected-catalog-v1",
        "generatedUtc": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "town": args.town_folder,
        "model": "four-neighbour connectivity-first depth-penalized bathtub",
        "sourceDem": str(dem_path),
        "sourceDemSize": {"width": width, "height": height},
        "sourceDemProjection": projection,
        "sourceDemGeoTransform": list(geo_transform),
        "sourceDemDatum": "NAVD88 feet",
        "sourceDemElevationFt": {
            "min": round(float(np.nanmin(valid_values)), 3),
            "max": round(float(np.nanmax(valid_values)), 3),
            "mean": round(float(np.nanmean(valid_values)), 3),
        },
        "sourceDefinition": {
            "maximumStageNavd88Ft": args.source_stage,
            "minimumFourNeighbourComponentCells": args.source_min_cells,
            "sourceComponentCount": int(len(source_ids)),
            "sourceCellCount": int(np.count_nonzero(source)),
            "largestSourceComponentCells": [
                int(value)
                for value in sorted(source_sizes.tolist(), reverse=True)[:20]
            ],
        },
        "catalog": {
            "minimumStageNavd88Ft": args.stage_min,
            "maximumStageNavd88Ft": args.stage_max,
            "stageStepFt": args.stage_step,
            "stageCount": len(stage_values),
            "filenameCode": "p### in tenths of a foot",
        },
        "thresholdsNavd88Ft": {
            "minor": args.minor,
            "moderate": args.moderate,
            "major": args.major,
        },
        "depthPenalty": {
            "atOrBelowMinorFt": LOW_STAGE_VERTICAL_PENALTY_FT,
            "atOrAboveMajorFt": 0,
            "exponentialDecayRate": VERTICAL_PENALTY_EXPONENTIAL_DECAY_RATE,
            "maximumLocalDepthFraction": MAX_LOCAL_DEPTH_PENALTY_FRACTION,
        },
        "packedQuery": packed_query,
        "stageStatistics": statistics,
    }
    manifest_path = output / f"{args.prefix}ConnectedCatalogManifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Packed query: {query_path} ({query_path.stat().st_size:,} bytes)")
    print(f"Manifest: {manifest_path}")
    return manifest


if __name__ == "__main__":
    build(parse_args())
