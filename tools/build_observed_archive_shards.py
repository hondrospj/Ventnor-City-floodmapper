#!/usr/bin/env python3
"""Build browser indexes and yearly shards for the configured primary gauge."""
from __future__ import annotations
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

SOURCE = "stone-harbor"
ARCHIVE = Path("observed15min.json")
INDEX = Path("observed_archive_index.json")
SHARD_ROOT = Path("observed_archive") / SOURCE
GAUGE_NAME = "Inside Thorofare at Atlantic City"
GAUGE_ID = "01410560"
START_DATE = "2007-10-01"

def write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")

source = json.loads(ARCHIVE.read_text(encoding="utf-8")) if ARCHIVE.exists() else {"days": []}
days = [day for day in source.get("days", []) if day.get("d")]
index = {
    "schema": "nj-floodmapper-observed-day-index-v2",
    "source": SOURCE,
    "gaugeName": source.get("gaugeName") or GAUGE_NAME,
    "stationId": source.get("site") or GAUGE_ID,
    "datum": "NAVD88",
    "timeZone": "America/New_York",
    "sourceResolutionMinutes": source.get("sourceResolutionMinutes") or source.get("intervalMinutes") or 15,
    "archiveStartDate": source.get("archiveStartDate") or (days[0]["d"] if days else START_DATE),
    "archiveEndDate": source.get("archiveEndDate") or (days[-1]["d"] if days else None),
    "lastProcessedISO": source.get("lastProcessedISO") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "shardPathTemplate": "./observed_archive/stone-harbor/{year}.json",
    "days": [{"d": day["d"], "p": day.get("p"), "c": day.get("c", "none")} for day in days],
}
write(INDEX, index)
grouped = defaultdict(list)
for day in days:
    grouped[str(day["d"])[:4]].append(day)
for year, rows in sorted(grouped.items()):
    write(SHARD_ROOT / f"{year}.json", {
        "schema": "nj-floodmapper-observed-year-v2", "source": SOURCE, "year": int(year),
        "stationId": index["stationId"], "stationName": index["gaugeName"], "datum": "NAVD88",
        "timeZone": "America/New_York", "intervalMinutes": 15, "days": rows,
    })
print(json.dumps({"days": len(days), "years": len(grouped), "index": str(INDEX)}))
