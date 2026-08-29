#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const topTides = JSON.parse(fs.readFileSync(path.join(root, "toptides.json"), "utf8"));
const observed15Min = JSON.parse(fs.readFileSync(path.join(root, "observed15min.json"), "utf8"));
const observedIndex = JSON.parse(fs.readFileSync(path.join(root, "observed_archive_index.json"), "utf8"));
const hydraulicRoot = path.join(root, "assets", "connected-v2");

assert.match(source, /<html lang="en">/);
assert.match(source, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
assert.match(source, /"pageTitle": "Ventnor City Flood Mapper"/);
assert.match(source, /"name": "Ventnor City"/);
assert.match(source, /id="opacitySlider"[^>]+aria-label="Flood overlay opacity"/);
assert.match(source, /id="hourSlider"[^>]+aria-label="Selected forecast or observed time"/);
assert.doesNotMatch(source, /(?:src|href)=["']http:\/\/(?!www\.w3\.org)/i);

const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
let compiledScripts = 0;
for (const match of source.matchAll(scriptPattern)) {
  const attributes = match[1];
  if (/\bsrc\s*=/.test(attributes)) continue;
  if (/\btype\s*=\s*["']application\/ld\+json["']/.test(attributes)) continue;
  new vm.Script(match[2], { filename: `index.html:inline-${compiledScripts + 1}` });
  compiledScripts += 1;
}
assert.ok(compiledScripts > 0, "Expected inline application scripts");

const crestRows = Array.isArray(topTides.toptides) ? topTides.toptides : [];
assert.ok(crestRows.length >= 10, "Expected at least 10 historic flood crests");
const crestDates = crestRows.map(row => row.date);
assert.equal(new Set(crestDates).size, crestDates.length, "Historic crest dates must be unique");
for (const row of crestRows) {
  assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Number(row.height_ft)), `Missing crest elevation for ${row.date}`);
}

assert.equal(observedIndex.days.length, observed15Min.days.length);
assert.ok(observedIndex.days.length > 6800, "Observed archive is unexpectedly short");
assert.equal(observedIndex.stationId, "01410560");
assert.equal(observedIndex.archiveStartDate, "2007-10-01");

for (const family of ["DepthPNGs", "StagePNGs"]) {
  const directory = path.join(hydraulicRoot, family, "Ventnor City");
  const files = fs.readdirSync(directory).filter(name => name.endsWith(".png")).sort();
  assert.equal(files.length, 201, `${family} must contain the complete 0.0–20.0 ft catalog`);
  assert.match(files[0], /p000\.png$/);
  assert.match(files.at(-1), /p200\.png$/);
}

const queryGrid = path.join(hydraulicRoot, "COGs", "Ventnor City", "VentnorCityHydraulicQuery5ft.png");
assert.ok(fs.statSync(queryGrid).size > 100_000, "Hydraulic query grid is missing or truncated");

console.log("Ventnor City floodmapper browser and data contract checks passed");
