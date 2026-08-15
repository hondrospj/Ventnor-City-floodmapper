#!/usr/bin/env python3
"""Build/update Ventnor City's compact Inside Thorofare at Atlantic City-gauge water-level archive.

USGS 01411360 publishes NAVD88 tidal elevation at roughly six-minute spacing.
This script linearly interpolates those observations onto exact UTC quarter-hour
anchors, groups them by America/New_York civil day, and stores hundredths of a
foot in a compact payload. The first UTC epoch-second plus the array position
fully defines every timestamp, including 23- and 25-hour daylight-saving days.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


SITE_ID = "01410560"
PARAMETER_CD = "72279"
LOCAL_TIME_ZONE = "America/New_York"
LOCAL_ZONE = ZoneInfo(LOCAL_TIME_ZONE)
ARCHIVE_START_DATE = date(2007, 10, 1)
NAVD88_OFFSET_FROM_MLLW_FT = -2.39
QUARTER_SECONDS = 15 * 60
FETCH_CHUNK_DAYS = 90
MAX_INTERPOLATION_GAP_SECONDS = 12 * 60 * 60
MAX_ANCHOR_DISTANCE_SECONDS = 12 * 60 * 60
THRESHOLDS_NAVD88 = {"minorLow":3.21,"moderateLow":4.21,"majorLow":5.21}
THRESHOLDS_MLLW = {"minorLow":5.6,"moderateLow":6.6,"majorLow":7.6}


def fetch_json(url: str, attempts: int = 4) -> dict:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Ventnor-City-floodmapper-2.0/1.0"})
            with urllib.request.urlopen(request, timeout=180) as response:
                body = response.read()
            if not body:
                raise RuntimeError(f"Empty response for {url}")
            return json.loads(body.decode("utf-8"))
        except Exception as exc:  # network retries are intentional in scheduled jobs
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise RuntimeError(f"USGS request failed after {attempts} attempts: {last_error}")


def usgs_url(start_utc: datetime, end_utc: datetime) -> str:
    params = {
        "format": "json",
        "sites": SITE_ID,
        "parameterCd": PARAMETER_CD,
        "startDT": start_utc.isoformat().replace("+00:00", "Z"),
        "endDT": end_utc.isoformat().replace("+00:00", "Z"),
        "siteStatus": "all",
    }
    return "https://waterservices.usgs.gov/nwis/iv/?" + urllib.parse.urlencode(params)


def parse_usgs_values(payload: dict) -> list[tuple[int, float]]:
    values_by_second: dict[int, float] = {}
    for series in payload.get("value", {}).get("timeSeries", []):
        for bucket in series.get("values", []):
            for row in bucket.get("value", []):
                try:
                    level = float(row.get("value"))
                    stamp = datetime.fromisoformat(str(row.get("dateTime")).replace("Z", "+00:00")).astimezone(timezone.utc)
                except Exception:
                    continue
                if not math.isfinite(level) or abs(level) >= 100:
                    continue
                values_by_second[int(stamp.timestamp())] = level
    return sorted(values_by_second.items())


def day_utc_bounds(day: date) -> tuple[datetime, datetime]:
    start_local = datetime.combine(day, datetime_time.min, tzinfo=LOCAL_ZONE)
    end_local = datetime.combine(day + timedelta(days=1), datetime_time.min, tzinfo=LOCAL_ZONE)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def interpolate_at(anchor: int, source_seconds: list[int], source_values: list[float]) -> float | None:
    index = bisect.bisect_left(source_seconds, anchor)
    if index < len(source_seconds) and source_seconds[index] == anchor:
        return source_values[index]
    if index == 0 or index >= len(source_seconds):
        return None
    before_t, after_t = source_seconds[index - 1], source_seconds[index]
    if after_t - before_t > MAX_INTERPOLATION_GAP_SECONDS:
        return None
    if anchor - before_t > MAX_ANCHOR_DISTANCE_SECONDS or after_t - anchor > MAX_ANCHOR_DISTANCE_SECONDS:
        return None
    before_v, after_v = source_values[index - 1], source_values[index]
    ratio = (anchor - before_t) / (after_t - before_t)
    return before_v + (after_v - before_v) * ratio


def classify_peak(peak: float | None) -> str:
    if peak is None or not math.isfinite(peak):
        return "none"
    if peak >= THRESHOLDS_NAVD88["majorLow"]:
        return "major"
    if peak >= THRESHOLDS_NAVD88["moderateLow"]:
        return "moderate"
    if peak >= THRESHOLDS_NAVD88["minorLow"]:
        return "minor"
    return "none"


def hydraulic_phase_for_index(rows: list[dict], index: int) -> str:
    """Classify an hourly point with the same peak/trough logic as the mapper."""
    current = float(rows[index].get("navd88StageFt", math.nan))
    previous = (
        float(rows[index - 1].get("navd88StageFt", math.nan))
        if index > 0
        else math.nan
    )
    following = (
        float(rows[index + 1].get("navd88StageFt", math.nan))
        if index + 1 < len(rows)
        else math.nan
    )
    before = current - previous if math.isfinite(previous) else math.nan
    after = following - current if math.isfinite(following) else math.nan
    epsilon = 0.025
    if math.isfinite(before) and math.isfinite(after):
        if before > epsilon and after <= epsilon:
            return "slack"
        if before >= -epsilon and after < -epsilon:
            return "slack"
        if before < -epsilon and after >= -epsilon:
            return "slack"
        if before <= epsilon and after > epsilon:
            return "slack"
    delta = (
        after
        if math.isfinite(after)
        and (not math.isfinite(before) or abs(after) >= abs(before))
        else before
    )
    if math.isfinite(delta) and delta > epsilon:
        return "filling"
    if math.isfinite(delta) and delta < -epsilon:
        return "draining"
    return "slack"


def ensure_hourly_phases(day: dict) -> None:
    rows = day.get("hours")
    if not isinstance(rows, list):
        return
    for index, row in enumerate(rows):
        row["hydraulicPhase"] = hydraulic_phase_for_index(rows, index)


def build_compact_day(day: date, source: list[tuple[int, float]]) -> tuple[dict, dict | None]:
    start_utc, end_utc = day_utc_bounds(day)
    start_second = int(start_utc.timestamp())
    end_second = int(end_utc.timestamp())
    source_seconds = [row[0] for row in source]
    source_values = [row[1] for row in source]
    quarter_values: list[int | None] = []
    float_values: list[float] = []
    for anchor in range(start_second, end_second, QUARTER_SECONDS):
        value = interpolate_at(anchor, source_seconds, source_values)
        if value is None:
            quarter_values.append(None)
        else:
            hundredths = int(round(value * 100))
            quarter_values.append(hundredths)
            float_values.append(hundredths / 100)

    peak = max(float_values) if float_values else None
    compact = {
        "d": day.isoformat(),
        "u": start_second,
        "v": quarter_values,
        "p": int(round(peak * 100)) if peak is not None else None,
        "c": classify_peak(peak),
    }
    if not float_values:
        return compact, None

    raw_for_day = [
        (stamp, level)
        for stamp, level in source
        if start_second <= stamp < end_second
    ]
    hour_buckets: dict[tuple[int, int], tuple[int, float]] = {}
    for stamp, level in raw_for_day:
        local = datetime.fromtimestamp(stamp, timezone.utc).astimezone(LOCAL_ZONE)
        key = (local.hour, int(local.utcoffset().total_seconds()))
        previous = hour_buckets.get(key)
        if previous is None or level > previous[1]:
            hour_buckets[key] = (stamp, level)

    hours = []
    for (hour, _offset), (stamp, level) in sorted(hour_buckets.items(), key=lambda item: item[1][0]):
        utc_dt = datetime.fromtimestamp(stamp, timezone.utc).replace(minute=0, second=0, microsecond=0)
        local_dt = utc_dt.astimezone(LOCAL_ZONE)
        navd = round(level + 1e-9, 2)
        hours.append(
            {
                "hourIndex": hour,
                "timeUtc": utc_dt.isoformat().replace("+00:00", "Z"),
                "timeLocal": local_dt.strftime("%Y-%m-%dT%H:00"),
                "timeEST": local_dt.strftime("%Y-%m-%dT%H:00"),
                "displayTimeEST": local_dt.strftime("%Y-%m-%dT%H:00"),
                "navd88StageFt": navd,
                "mllwStageFt": round(navd - NAVD88_OFFSET_FROM_MLLW_FT, 2),
            }
        )
    hourly_peak = max((row["navd88StageFt"] for row in hours), default=peak)
    hourly_day = {
        "date": day.isoformat(),
        "classification": classify_peak(hourly_peak),
        "peakNAVD88": round(hourly_peak, 2),
        "peakMLLW": round(hourly_peak - NAVD88_OFFSET_FROM_MLLW_FT, 2),
        "hours": hours,
    }
    ensure_hourly_phases(hourly_day)
    return compact, hourly_day


def load_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def daterange(start: date, end: date):
    cursor = start
    while cursor <= end:
        yield cursor
        cursor += timedelta(days=1)


def update_hourly_archive(path: Path, new_days: dict[str, dict], end_date: date) -> None:
    existing = load_json(path) or {}
    day_map = {str(row.get("date")): row for row in existing.get("days", []) if row.get("date")}
    day_map.update(new_days)
    for day in day_map.values():
        ensure_hourly_phases(day)
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    existing.update(
        {
            "gaugeName": existing.get("gaugeName") or "Inside Thorofare at Atlantic City",
            "site": SITE_ID,
            "parameterCd": PARAMETER_CD,
            "datum": "NAVD88",
            "timeZone": LOCAL_TIME_ZONE,
            "method": "USGS six-minute observations aggregated to hourly maxima; companion observed15min.json uses exact quarter-hour anchors",
            "archiveStartDate": min(day_map) if day_map else ARCHIVE_START_DATE.isoformat(),
            "archiveEndDate": end_date.isoformat(),
            "lastProcessedISO": now,
            "lastIncrementalUpdateISO": now,
            "navd88OffsetFromMllwFt": NAVD88_OFFSET_FROM_MLLW_FT,
            "thresholdsNAVD88": THRESHOLDS_NAVD88,
            "thresholdsMLLW": THRESHOLDS_MLLW,
            "days": [day_map[key] for key in sorted(day_map)],
        }
    )
    path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")


def build(args: argparse.Namespace) -> dict:
    output = args.output.resolve()
    existing = load_json(output) or {}
    existing_days = {str(row.get("d")): row for row in existing.get("days", []) if row.get("d")}
    end_date = args.end_date or datetime.now(LOCAL_ZONE).date()
    if args.full or not existing_days:
        start_date = args.start_date or ARCHIVE_START_DATE
    else:
        last_date = date.fromisoformat(max(existing_days))
        start_date = max(args.start_date or ARCHIVE_START_DATE, last_date - timedelta(days=3))
    if start_date > end_date:
        raise ValueError(f"Start date {start_date} is after end date {end_date}")

    hourly_updates: dict[str, dict] = {}
    cursor = start_date
    while cursor <= end_date:
        chunk_end = min(cursor + timedelta(days=FETCH_CHUNK_DAYS - 1), end_date)
        fetch_start, _ = day_utc_bounds(cursor)
        _, fetch_end = day_utc_bounds(chunk_end)
        padded_start = fetch_start - timedelta(minutes=15)
        padded_end = fetch_end + timedelta(minutes=15)
        url = usgs_url(padded_start, padded_end)
        print(f"Fetching {cursor} through {chunk_end}")
        if args.cache_dir:
            cache_path = args.cache_dir / f"{SITE_ID}-{cursor}-{chunk_end}.json"
            source = parse_usgs_values(json.loads(cache_path.read_text(encoding="utf-8")))
        else:
            source = parse_usgs_values(fetch_json(url))
        print(f"  {len(source):,} USGS observations")
        for day in daterange(cursor, chunk_end):
            compact, hourly = build_compact_day(day, source)
            existing_days[day.isoformat()] = compact
            if hourly is not None:
                hourly_updates[day.isoformat()] = hourly
        cursor = chunk_end + timedelta(days=1)

    sorted_days = [existing_days[key] for key in sorted(existing_days) if key <= end_date.isoformat()]
    valid_quarters = sum(sum(value is not None for value in row.get("v", [])) for row in sorted_days)
    total_quarters = sum(len(row.get("v", [])) for row in sorted_days)
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    payload = {
        "schema": "nj-floodmapper-primary-observed-15min-v2",
        "gaugeName": "Inside Thorofare at Atlantic City",
        "site": SITE_ID,
        "parameterCd": PARAMETER_CD,
        "datum": "NAVD88",
        "timeZone": LOCAL_TIME_ZONE,
        "intervalMinutes": 15,
        "sourceResolutionMinutes": 6,
        "method": "linear interpolation of USGS IV observations to exact UTC 15-minute anchors across gaps up to 12 hours; longer outages remain unavailable",
        "encoding": {
            "d": "America/New_York civil date",
            "u": "UTC epoch second of first quarter-hour anchor",
            "v": "NAVD88 feet multiplied by 100; null means unavailable; subsequent entries are 900 seconds apart",
            "p": "daily maximum NAVD88 feet multiplied by 100",
            "c": "daily flood classification",
        },
        "archiveStartDate": sorted_days[0]["d"] if sorted_days else start_date.isoformat(),
        "archiveEndDate": sorted_days[-1]["d"] if sorted_days else end_date.isoformat(),
        "lastProcessedISO": now,
        "navd88OffsetFromMllwFt": NAVD88_OFFSET_FROM_MLLW_FT,
        "thresholdsNAVD88": THRESHOLDS_NAVD88,
        "thresholdsMLLW": THRESHOLDS_MLLW,
        "quality": {"validQuarterHours": valid_quarters, "totalQuarterHours": total_quarters},
        "days": sorted_days,
    }
    output.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    if args.update_hourly:
        update_hourly_archive(args.hourly_output.resolve(), hourly_updates, end_date)
    return payload


def parse_date(value: str) -> date:
    return date.fromisoformat(value)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("observed15min.json"))
    parser.add_argument("--hourly-output", type=Path, default=Path("observed.json"))
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--start-date", type=parse_date)
    parser.add_argument("--end-date", type=parse_date)
    parser.add_argument("--cache-dir", type=Path, help="Optional directory of pre-fetched USGS chunk responses")
    parser.add_argument("--update-hourly", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


if __name__ == "__main__":
    result = build(parse_args())
    print(
        json.dumps(
            {
                "archiveStartDate": result["archiveStartDate"],
                "archiveEndDate": result["archiveEndDate"],
                "dayCount": len(result["days"]),
                "quality": result["quality"],
            },
            indent=2,
        )
    )
