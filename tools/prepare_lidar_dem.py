#!/usr/bin/env python3
"""Create a five-foot NAVD88 DEM from cubic one-foot USGS 3DEP tiles."""
from __future__ import annotations
import argparse, json, math, subprocess, tempfile, time, urllib.parse, urllib.request
from pathlib import Path

NODATA = -999999.0
ONE_FOOT_M = 0.3048
FIVE_FOOT_M = 1.524
TILE_PIXELS = 2000
FT_PER_M = 3.280839895013123

def run(args):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(" ".join(args) + "\n" + result.stderr)
    return result.stdout

def mercator(lon, lat):
    radius = 6378137.0
    x = radius * math.radians(lon)
    y = radius * math.log(math.tan(math.pi / 4 + math.radians(max(-85.05112878, min(85.05112878, lat))) / 2))
    return x, y

def snap_floor(value, step): return math.floor(value / step) * step
def snap_ceil(value, step): return math.ceil(value / step) * step

def download(url, output):
    last_error = None
    for attempt in range(1, 7):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "nj-floodmapper-lidar-v2/1.0"})
            with urllib.request.urlopen(request, timeout=240) as response:
                body = response.read()
            if len(body) < 1024 or body[:2] not in (b"II", b"MM"):
                raise RuntimeError(f"3DEP returned invalid TIFF ({len(body)} bytes): {body[:200]!r}")
            output.write_bytes(body)
            return
        except Exception as error:
            last_error = error
            if attempt < 6:
                time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"3DEP tile failed after six attempts: {last_error}")

def build(config_path, output):
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    bbox = cfg["boundsWgs84"]
    xmin, ymin = mercator(float(bbox["west"]), float(bbox["south"]))
    xmax, ymax = mercator(float(bbox["east"]), float(bbox["north"]))
    xmin, ymin = snap_floor(xmin, FIVE_FOOT_M), snap_floor(ymin, FIVE_FOOT_M)
    xmax, ymax = snap_ceil(xmax, FIVE_FOOT_M), snap_ceil(ymax, FIVE_FOOT_M)
    width = math.ceil((xmax - xmin) / ONE_FOOT_M)
    height = math.ceil((ymax - ymin) / ONE_FOOT_M)
    columns, rows = math.ceil(width / TILE_PIXELS), math.ceil(height / TILE_PIXELS)
    service = cfg["sourceServiceUrl"].rstrip("/")
    with tempfile.TemporaryDirectory(prefix="nj-floodmapper-lidar-") as tmp_raw:
        tmp = Path(tmp_raw)
        reduced = []
        for row in range(rows):
            tile_ymax = ymax - row * TILE_PIXELS * ONE_FOOT_M
            tile_height = min(TILE_PIXELS, height - row * TILE_PIXELS)
            tile_ymin = tile_ymax - tile_height * ONE_FOOT_M
            for column in range(columns):
                tile_xmin = xmin + column * TILE_PIXELS * ONE_FOOT_M
                tile_width = min(TILE_PIXELS, width - column * TILE_PIXELS)
                tile_xmax = tile_xmin + tile_width * ONE_FOOT_M
                query = urllib.parse.urlencode({
                    "f": "image", "bbox": f"{tile_xmin},{tile_ymin},{tile_xmax},{tile_ymax}",
                    "bboxSR": "3857", "imageSR": "3857", "size": f"{tile_width},{tile_height}",
                    "format": "tiff", "pixelType": "F32", "noData": str(NODATA),
                    "interpolation": "RSP_CubicConvolution",
                })
                raw = tmp / f"raw-{row}-{column}.tif"
                feet = tmp / f"feet-{row}-{column}.tif"
                five = tmp / f"five-{row}-{column}.tif"
                print(f"[{row * columns + column + 1}/{rows * columns}] one-foot tile {row},{column}", flush=True)
                download(f"{service}/exportImage?{query}", raw)
                run(["gdal_calc.py", "--quiet", "-A", str(raw), f"--calc=A*{FT_PER_M}", "--NoDataValue", str(NODATA), "--type", "Float32", "--co", "COMPRESS=DEFLATE", "--outfile", str(feet)])
                run(["gdalwarp", "-overwrite", "-r", "cubicspline", "-tr", str(FIVE_FOOT_M), str(FIVE_FOOT_M), "-tap", "-dstnodata", str(NODATA), "-ot", "Float32", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", str(feet), str(five)])
                raw.unlink(missing_ok=True); feet.unlink(missing_ok=True)
                reduced.append(five)
        vrt = tmp / "five-foot.vrt"
        run(["gdalbuildvrt", "-overwrite", str(vrt), *map(str, reduced)])
        projected = tmp / "boundary-3857.geojson"
        boundary = Path(cfg["boundaryPath"])
        run(["ogr2ogr", "-makevalid", "-t_srs", "EPSG:3857", "-f", "GeoJSON", str(projected), str(boundary)])
        run(["gdalwarp", "-overwrite", "-r", "cubicspline", "-cutline", str(projected), "-crop_to_cutline", "-tr", str(FIVE_FOOT_M), str(FIVE_FOOT_M), "-tap", "-dstnodata", str(NODATA), "-ot", "Float32", "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", str(vrt), str(output)])
    print(json.dumps({"output": str(output), "oneFootTiles": rows * columns, "sourcePixels": width * height, "webResolutionFeet": 5}))

parser = argparse.ArgumentParser()
parser.add_argument("--config", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
build(args.config, args.output)
