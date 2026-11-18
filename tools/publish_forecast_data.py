#!/usr/bin/env python3
"""Publish only the approved forecast blob; preserve the current deployed UI tree."""
import base64
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

UTC = dt.timezone.utc
IDENTITY = ("stationId", "usgsGaugeId", "noaaGaugeId", "sourceDatum", "mapDatum", "navd88OffsetFromMllwFt")


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing forecast timestamp")
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Forecast timestamp needs an explicit timezone")
    return result.astimezone(UTC)


def zones(document):
    if not isinstance(document, dict):
        raise ValueError("Forecast must be an object")
    if "zones" not in document:
        return {"default": document}
    values = document["zones"]
    if not isinstance(values, dict) or not values:
        raise ValueError("Empty forecast zones")
    return {key: value["forecast"] for key, value in values.items()}


def validate_forecast(candidate, previous, now=None):
    now = now or dt.datetime.now(UTC)
    new, old = zones(candidate), zones(previous)
    if set(new) != set(old):
        raise ValueError("Forecast zones differ from the deployed mapper")
    summary = {}
    for key, forecast in new.items():
        baseline = old[key]
        for field in IDENTITY:
            if field in baseline and forecast.get(field) != baseline[field]:
                raise ValueError(f"{key}: forecast identity or datum changed: {field}")
        cycle = timestamp(forecast["petssCycleUtc"])
        issued = timestamp(forecast["issuedUtc"])
        end = timestamp(forecast["forecastEndUtc"])
        if cycle < now - dt.timedelta(hours=36) or cycle > now + dt.timedelta(hours=1):
            raise ValueError(f"{key}: NOAA cycle is not current")
        if issued > now + dt.timedelta(hours=1) or end <= now + dt.timedelta(hours=1):
            raise ValueError(f"{key}: forecast has no useful future coverage")
        if baseline.get("petssCycleUtc") and cycle < timestamp(baseline["petssCycleUtc"]):
            raise ValueError(f"{key}: candidate would roll back the deployed cycle")
        hours = forecast.get("hours")
        if not isinstance(hours, list) or len(hours) < 12:
            raise ValueError(f"{key}: incomplete hourly forecast")
        times = []
        for row in hours:
            times.append(timestamp(row["timeUtc"]))
            value = row.get("navd88StageFt")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{key}: invalid forecast water level")
        if any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError(f"{key}: forecast hours are not strictly ordered")
        if times[-1] != end or times[0] != timestamp(forecast["forecastStartUtc"]):
            raise ValueError(f"{key}: coverage metadata differs from hourly data")
        if any((b - a).total_seconds() > 3600 for a, b in zip(times, times[1:])):
            raise ValueError(f"{key}: hourly forecast contains a gap")
        summary[key] = {"cycle": cycle.isoformat(), "end": end.isoformat(), "hours": len(hours)}
    return summary


def api(repository, endpoint, method="GET", body=None):
    url = "https://api.github.com/repos/" + repository + "/" + endpoint
    request = urllib.request.Request(url, method=method,
        data=None if body is None else json.dumps(body).encode(), headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json", "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ShorelySafe-forecast-data-publisher"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
            time.sleep(2 ** attempt + 1)


def read_file(repository, path, ref):
    entry = api(repository, "contents/" + urllib.parse.quote(path, safe="/") + "?ref=" + urllib.parse.quote(ref, safe=""))
    if entry.get("type") != "file":
        raise ValueError("Approved forecast path is not an existing file")
    if entry.get("encoding") == "base64" and entry.get("content"):
        return base64.b64decode(entry["content"]), entry["sha"]
    blob = api(repository, "git/blobs/" + entry["sha"])
    if blob.get("encoding") != "base64":
        raise ValueError("Unsupported forecast blob encoding")
    return base64.b64decode(blob["content"]), entry["sha"]


def publish(repository, source_path="forecast.json", deployed_path="forecast.json", forecast_url=None):
    if not repository.startswith("hondrospj/"):
        raise ValueError("Unexpected repository owner")
    if (source_path, deployed_path) not in (("forecast.json", "forecast.json"),
                                           ("site/floodmapper/forecast.json", "floodmapper/forecast.json")):
        raise ValueError("Unapproved data publication path")
    settings = api(repository, "pages")
    branch = settings.get("source", {}).get("branch")
    if not settings.get("public") or settings.get("build_type") != "legacy" or branch not in ("main", "shorelysafe-static"):
        raise ValueError("Unexpected Pages publication configuration")
    source_commit = api(repository, "git/ref/heads/main")["object"]["sha"]
    raw, source_blob = read_file(repository, source_path, source_commit)
    candidate = json.loads(raw)
    commit = None
    for attempt in range(5):
        head = api(repository, "git/ref/heads/" + branch)["object"]["sha"]
        previous_raw, previous_blob = read_file(repository, deployed_path, head)
        coverage = validate_forecast(candidate, json.loads(previous_raw))
        if source_blob == previous_blob:
            commit = head
            break
        if branch == "main":
            raise ValueError("The source changed during main-branch validation; retry against its current forecast")
        parent = api(repository, "git/commits/" + head)
        tree = api(repository, "git/trees", "POST", {"base_tree": parent["tree"]["sha"], "tree": [
            {"path": deployed_path, "mode": "100644", "type": "blob", "sha": source_blob}]})
        proposed = api(repository, "git/commits", "POST", {
            "message": "Refresh published forecast data only", "tree": tree["sha"], "parents": [head]})
        comparison = api(repository, "compare/" + head + "..." + proposed["sha"])
        changed = comparison.get("files", [])
        if len(changed) != 1 or changed[0].get("filename") != deployed_path or changed[0].get("status") != "modified":
            raise ValueError("Data overlay changed a file outside the approved forecast path")
        try:
            api(repository, "git/refs/heads/" + branch, "PATCH", {"sha": proposed["sha"], "force": False})
            commit = proposed["sha"]
            break
        except urllib.error.HTTPError as error:
            if error.code not in (409, 422) or attempt == 4:
                raise
            time.sleep(2)
    if commit is None:
        raise RuntimeError("The published branch kept changing; no UI files were replaced")
    # GITHUB_TOKEN branch writes do not trigger Pages automatically.
    api(repository, "pages/builds", "POST", {})
    url = forecast_url or settings["html_url"].rstrip("/") + "/" + deployed_path
    if not url.startswith(settings["html_url"].rstrip("/") + "/"):
        raise ValueError("Forecast verification URL is outside this Pages site")
    digest = hashlib.sha256(raw).hexdigest()
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url + "?forecast=" + digest[:16], headers={"Cache-Control": "no-cache"})
            with urllib.request.urlopen(request, timeout=20) as response:
                live = response.read()
            if hashlib.sha256(live).hexdigest() == digest:
                break
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(5)
    else:
        raise RuntimeError("Pages did not serve the validated forecast within five minutes")
    result = {"repository": repository, "source_commit": source_commit, "published_commit": commit,
              "branch": branch, "changed_path_allowlist": [deployed_path], "forecast_sha256": digest,
              "coverage": coverage, "url": url, "verified": True}
    Path("forecast-publication-receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    publish(os.environ["GITHUB_REPOSITORY"], os.environ.get("FORECAST_SOURCE_PATH", "forecast.json"),
            os.environ.get("FORECAST_DEPLOYED_PATH", "forecast.json"))
