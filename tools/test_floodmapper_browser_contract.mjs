#!/usr/bin/env node
// Static and executable checks for the browser's 0.1-ft depth contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "index.html"), "utf8");
const OBSERVED_15MIN = JSON.parse(fs.readFileSync(path.join(HERE, "..", "observed15min.json"), "utf8"));
const OBSERVED_INDEX = JSON.parse(fs.readFileSync(path.join(HERE, "..", "observed_archive_index.json"), "utf8"));
const LEWES_INDEX = JSON.parse(fs.readFileSync(path.join(HERE, "..", "lewes_archive_index.json"), "utf8"));
const TOP_TIDES = JSON.parse(fs.readFileSync(path.join(HERE, "..", "toptides.json"), "utf8"));
const BUNDLED_HYDRAULIC_ROOT = path.join(HERE, "..", "assets", "connected-v2");

function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing browser function ${name}`);
  const bodyStart = SOURCE.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < SOURCE.length; index += 1) {
    if (SOURCE[index] === "{") depth += 1;
    if (SOURCE[index] === "}") depth -= 1;
    if (depth === 0) return SOURCE.slice(start, index + 1);
  }
  throw new Error(`Unterminated browser function ${name}`);
}

const context = vm.createContext({
  Math,
  Number,
  MIN_STAGE: -4,
  MIN_DEPTH_STAGE: 0,
  MAX_STAGE: 20,
  STAGE_STEP: 0.1,
  MINOR_FLOOD_FT: 3.44,
  MODERATE_FLOOD_FT: 4.44,
  MAJOR_FLOOD_FT: 5.44,
  LOW_STAGE_VERTICAL_PENALTY_FT: 1.25,
  VERTICAL_PENALTY_EXPONENTIAL_DECAY_RATE: 1.5,
  MAX_LOCAL_DEPTH_PENALTY_FRACTION: 0.75,
});
for (const name of (
  [
    "roundToCatalogPrecision",
    "floorToCatalogStep",
    "getOverlayStage",
    "getVerticalBathtubPenalty",
    "getPenalizedConnectedDepth",
    "getDepthQueryDisplayDepth",
    "stageToCode",
  ]
)) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, context);
}

vm.runInContext(
  `${extractFunction("stripExportTimeZoneLabel")}; globalThis.stripExportTimeZoneLabel = stripExportTimeZoneLabel;`,
  context
);

assert.equal(context.stripExportTimeZoneLabel("Jul 29, 2026 · 9:00 PM GMT-4"), "Jul 29, 2026 · 9:00 PM");
assert.equal(context.stripExportTimeZoneLabel("Jul 29, 2026 · 9:00 PM EDT"), "Jul 29, 2026 · 9:00 PM");
assert.equal(context.stripExportTimeZoneLabel("Jul 29, 2026 · 9:00 PM ET"), "Jul 29, 2026 · 9:00 PM");

assert.equal(context.getOverlayStage(3.94), 3.9);
assert.equal(context.getOverlayStage(3.95), 3.9);
assert.equal(context.getOverlayStage(3.999), 3.9);
assert.equal(context.stageToCode(context.getOverlayStage(3.94)), "p039");
assert.equal(context.stageToCode(context.getOverlayStage(4.01)), "p040");
assert.equal(context.getVerticalBathtubPenalty(3.44), 1.25);
assert.equal(context.getVerticalBathtubPenalty(5.44), 0);

const changingDepthSample = { elevation: 2, connectionStage: 1 };
const lowWaterDepth = context.getDepthQueryDisplayDepth(changingDepthSample, 3.44);
const highWaterDepth = context.getDepthQueryDisplayDepth(changingDepthSample, 5.44);
assert.ok(
  highWaterDepth > lowWaterDepth,
  "An open depth popup must calculate a larger depth when the selected water level rises"
);
assert.equal(
  context.getDepthQueryDisplayDepth(changingDepthSample, 5.44, { flooded: false }),
  0,
  "The rendered overlay can still mark a modeled location as disconnected"
);

let previous = Infinity;
for (let stage = 3.44; stage <= 5.44 + 1e-9; stage += 0.1) {
  const penalty = context.getVerticalBathtubPenalty(stage);
  assert.ok(penalty <= previous + 1e-12, "Penalty must decrease monotonically");
  previous = penalty;
}

assert.match(SOURCE, /candidateElevation > -100 && candidateElevation < 100/);
assert.match(SOURCE, /elevation >= 1000/);
assert.doesNotMatch(SOURCE, /<dt>Ground<\/dt>/);
assert.doesNotMatch(SOURCE, /<dt>Maximum depth penalty<\/dt>/);
assert.match(SOURCE, /<div class="depth-query-value">/);
assert.match(extractFunction("getDepthQueryPopupHeading"), /currentDataMode === "forecast"[\s\S]+return "Forecast Water Depth"/);
assert.match(extractFunction("getDepthQueryPopupHeading"), /currentDataMode === "observed"[\s\S]+return "Water Depth"/);
assert.match(extractFunction("getDepthQueryPopupHeading"), /return "Modeled Water Depth"/);
assert.match(extractFunction("buildDepthQueryPopupHtml"), /getDepthQueryPopupHeading\(\)/);
assert.match(SOURCE, /let persistentDepthQueryContext = null/);
assert.match(SOURCE, /function updatePersistentDepthQueryPopup\(/);
assert.match(
  extractFunction("renderHour"),
  /updatePersistentDepthQueryPopup\(\{ useRenderedFlood: false \}\)/
);
assert.match(
  extractFunction("setFloodLayer"),
  /currentFloodLayer = nextLayer;[\s\S]+updatePersistentDepthQueryPopup\(\)/
);
assert.match(SOURCE, /id="satelliteToggle"/);
assert.match(SOURCE, /World_Imagery\/MapServer\/tile/);
assert.match(SOURCE, /payload\.valueType === "int16-le"/);
assert.match(SOURCE, /depthQueryPngPath/);
assert.match(SOURCE, /function loadDepthQueryPng\(/);
assert.match(SOURCE, /async function samplePackedDepthGrid\(/);
assert.match(SOURCE, /encodedElevation - 32768/);
assert.match(SOURCE, /connectionCode - 50/);
assert.match(SOURCE, /Number\(stageValue\) > 14/);
assert.match(SOURCE, /\/assets\/connected-v2\//);
assert.doesNotMatch(SOURCE, /floodmapperv1\.b-cdn\.net|connected-v1/);
assert.match(SOURCE, /"initialZoom": 14/);
assert.match(extractFunction("fitConfiguredInitialMapView"), /setView\(\[lat, lon\], zoom/);
assert.match(extractFunction("setFloodLayer"), /fitConfiguredInitialMapView\(map, \[16, 16\]\)/);
assert.match(SOURCE, /id="boundaryToggle"[^>]+role="switch"[^>]+aria-checked="true"/);
assert.match(SOURCE, />Simulation Extent</i);
assert.match(extractFunction("isTownBoundaryEnabled"), /boundaryToggle[\s\S]+classList\.contains\("on"\)/);
assert.match(SOURCE, /id="roadsToggle"[^>]+role="switch"[^>]+aria-checked="true"/);
assert.match(SOURCE, /el\.setAttribute\("aria-checked", String\(el\.classList\.contains\("on"\)\)\)/);
assert.doesNotMatch(
  SOURCE,
  /html body:not\(\.mobile-optimized\) #rightRail \.layers-card \.layer-list\{[^}]*grid-template-columns:repeat\(2/
);
assert.doesNotMatch(
  SOURCE,
  /html body:not\(\.mobile-optimized\) #rightRail > #downloadCard \.download-launch-meta\{[^}]*display:none/
);
assert.match(SOURCE, /:has\(#mapClickModeControl:not\(\[hidden\]\)\) #mapWrap > #legendDock\{[\s\S]+top:126px !important/);
assert.match(SOURCE, /depthQueryGridPromise = null/);
assert.match(
  SOURCE,
  /depthQueryImagePromise = GeoTIFF\.fromUrl[\s\S]+depthQueryImagePromise = null/
);
assert.match(
  SOURCE,
  /Packed depth query failed; retrying through the COG/
);
assert.match(SOURCE, /id="downloadIntervalControl"/);
assert.match(SOURCE, /data-export-interval="hourly"/);
assert.match(SOURCE, /data-export-interval="15min"/);
assert.match(SOURCE, /data-export-interval="daily"/);
assert.match(SOURCE, /function buildExportRangeFrameItems\(/);
assert.match(SOURCE, /function buildQuarterHourRangeFrameItems\(/);
assert.match(SOURCE, /function buildDailyMaximumRangeFrameItems\(/);
assert.match(SOURCE, /function getReturnIntervalExportEntries\(/);
assert.match(SOURCE, /exportSourceMode: "return-interval"/);
assert.match(SOURCE, /mode: "return-interval"/);
assert.match(SOURCE, /currentDataMode !== "return-interval" && getDownloadScopeValue\(\) !== "current"/);
assert.match(SOURCE, /Export the full \$\{modeledHours\}-hour modeled storm/);
assert.match(SOURCE, /getExportBaseName\(items\)/);
assert.match(SOURCE, /function getCurrentSelectionExportRange\(/);
assert.match(SOURCE, /const currentDate = getEntryESTDate\(getDownloadCurrentEntry\(\)\)/);
assert.match(SOURCE, /seedDownloadRangeToCurrentSelection\(force\)/);
assert.doesNotMatch(SOURCE, /seedDownloadRangeToCurrentForecast/);
assert.doesNotMatch(SOURCE, /\bstageColor\b/);
assert.match(SOURCE, /function getExportFrameDateTimeText\(/);
assert.match(SOURCE, /return `\$\{getExportFrameDateTimeText\(entry\)\}\\n\$\{getExportFrameWaterLevelText\(entry\)\}`/);
assert.doesNotMatch(extractFunction("getExportFrameTimestampText"), /15-Minute|Hourly|Daily maximum|Water level/);
assert.match(SOURCE, /const MODELED_EXPORT_DATE_PLACEHOLDER = "xx\/xx\/xxxx"/);
assert.match(extractFunction("syncExportDateTimeEditorFromCanonical"), /modeledDateLocked[\s\S]+MODELED_EXPORT_DATE_PLACEHOLDER/);
assert.match(SOURCE, /function commitExportDateTimeEditor\([\s\S]+currentDataMode === "return-interval"[\s\S]+canonicalMatch/);
assert.match(extractFunction("getReturnIntervalStormLabel"), /`\$\{value\.toLocaleString\("en-US"\)\}-Year Storm`/);
assert.doesNotMatch(extractFunction("getExportFrameTimestampText"), /if \(entry\?\.returnIntervalYears\)/);
assert.doesNotMatch(extractFunction("getExportFrameTimestampText"), /formatReturnStormOffset/);
assert.match(SOURCE, /data-export-legend-mode="depth"/);
assert.match(SOURCE, /class="export-depth-key-gradient"/);
assert.match(SOURCE, /<strong>Flood Depth<\/strong>/);
assert.match(SOURCE, /linear-gradient\(90deg,#63d471 0%,#63d471 18%,#18c8ff 18%/);
assert.match(SOURCE, /<strong>Green areas<\/strong> may flood/);
assert.match(SOURCE, /<span>May Flood<\/span><span>Shallow<\/span><span>Deep<\/span>/);
assert.doesNotMatch(SOURCE, /Green represents uncertainty/i);
assert.doesNotMatch(SOURCE, /Feet above ground/);
assert.doesNotMatch(SOURCE, /class="export-depth-key-disconnected"/);
assert.match(extractFunction("updateExportLegend"), /querySelectorAll\("\.legend-row-boundary"\)\.forEach\(row => row\.remove\(\)\)/);
assert.match(SOURCE, /--boundary-color:#000000/);
assert.match(SOURCE, /StoneHarborBoroughParcelBoundaries\.png\?v=20260802-red-parcels-v1/);
assert.match(SOURCE, /opacity: 0\.78/);
assert.match(SOURCE, /exportMap\.createPane\("parcelsPane"\)/);
assert.match(SOURCE, /async function updateExportParcelsLayer\(/);
assert.match(SOURCE, /async function prepareExportFrame\([\s\S]+await updateExportParcelsLayer\(\)/);
assert.match(SOURCE, /async function captureFastGifBaseCanvas\([\s\S]+await updateExportParcelsLayer\(\)/);
assert.match(SOURCE, /async function buildStableExportGifPalette\(/);
assert.match(extractFunction("buildStableExportGifPalette"), /globalPalette: true/);
assert.match(extractFunction("exportGif"), /globalPalette: stableGlobalPalette/);
assert.doesNotMatch(SOURCE, /globalPalette: false/);
assert.doesNotMatch(SOURCE, /seedGifLegendPalette/);
assert.match(SOURCE, /\.export-stage-legend\[data-export-legend-mode="depth"\]\{[\s\S]+background:#0b1220 !important/);
assert.match(SOURCE, /id="stone-harbor-borough-export-final-qa"/);
assert.match(SOURCE, /data-export-aspect="16:9"|font-size:60px !important/);
assert.match(SOURCE, /data-export-aspect="1:1"[\s\S]+font-size:52px !important/);
assert.match(SOURCE, /data-export-aspect="9:16"[\s\S]+font-size:50px !important/);

const modeledStormLabelContext = vm.createContext({ Number });
vm.runInContext(
  `${extractFunction("getReturnIntervalStormLabel")}; globalThis.getReturnIntervalStormLabel = getReturnIntervalStormLabel;`,
  modeledStormLabelContext
);
for (const years of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
  assert.equal(
    modeledStormLabelContext.getReturnIntervalStormLabel(years),
    `${years.toLocaleString("en-US")}-Year Storm`,
    `Modeled GIF title is wrong for the ${years}-year interval`
  );
}
assert.match(SOURCE, /function captureExportRoadLabelsCanvas\(/);
assert.doesNotMatch(SOURCE, /function normalizeExportRoadLabelCanvas\(/);
assert.match(
  extractFunction("captureExportRoadLabelsCanvas"),
  /return captureExportLayerCanvas\(\{/
);
assert.match(SOURCE, /ctx\.drawImage\(roadLabelsCanvas[\s\S]+ctx\.drawImage\(chromeCanvas[\s\S]+drawExportTimestampOnCanvas/);
assert.match(SOURCE, /getPane\("roadsPane"\)\.style\.zIndex = 710/);
assert.match(SOURCE, /\.export-stage \.leaflet-pane\.roads-dark img,[\s\S]+filter:none !important/);
assert.match(SOURCE, /\.export-stage-legend\[data-export-legend-mode="depth"\]\{[\s\S]+right:40px !important/);
assert.doesNotMatch(extractFunction("getExportFrameDateTimeText"), /timeZoneName|GMT|UTC|E\[SD\]T/);
assert.match(SOURCE, /id="buildingsToggle"/);
assert.match(SOURCE, /function styleEsriBuildingForeground\(/);
assert.match(SOURCE, /makeEsriBuildingForegroundLayer\("buildingsPane"\)/);
assert.doesNotMatch(SOURCE, /Buildings are above the water/);
assert.doesNotMatch(SOURCE, /recorded high-tide floods?/);
assert.match(SOURCE, /<span>floods<\/span>/);
assert.match(SOURCE, /getPane\("buildingsPane"\)\.style\.zIndex = 620/);
assert.match(SOURCE, /getPane\("popupPane"\)\.style\.zIndex = 800/);
assert.match(SOURCE, /autoClose: false/);
assert.match(SOURCE, /closeOnClick: false/);
assert.doesNotMatch(extractFunction("renderHour"), /closePopup/);
assert.match(SOURCE, /See Flood History And Projections/);
assert.match(SOURCE, /id="floodHistoryPane"/);
assert.match(SOURCE, /\.flood-history-backdrop\{[^}]*place-items:center/);
assert.match(SOURCE, /id="floodProjectionScenarioSelect"/);
assert.doesNotMatch(SOURCE, /<summary>Method<\/summary>/);
assert.doesNotMatch(SOURCE, /flood-history-method/);
assert.doesNotMatch(SOURCE, /parcel elevation/);
assert.doesNotMatch(SOURCE, /class="house-sub"/);
assert.doesNotMatch(SOURCE, /house-alert-depth-cta/);
assert.doesNotMatch(SOURCE, /class="flood-milestones"/);
assert.doesNotMatch(SOURCE, /class="flood-scenario-chips"/);
assert.doesNotMatch(SOURCE, /independent high-tide exceedances/);
assert.match(SOURCE, /stone-harbor-borough-flood-history-projections-v4/);
assert.match(SOURCE, /id="mapClickModeControl"/);
assert.match(SOURCE, /data-map-click-mode="building"/);
assert.match(SOURCE, /data-map-click-mode="depth"/);
assert.match(SOURCE, /id="mapClickBuildingBtn"[^>]+aria-label="Building info"/);
assert.match(SOURCE, /id="mapClickDepthBtn"[^>]+aria-label="Water depth"/);
assert.match(SOURCE, /mapClickMode === "building" && parcelInfoInteractionEnabled\(\)/);
assert.doesNotMatch(SOURCE, /Switch map taps to water depth/);
assert.doesNotMatch(SOURCE, /recorded high-tide floods/);
assert.match(SOURCE, /\.house-alert-cta\{[^}]*background:rgba\(125,249,255,\.09\)/);
assert.match(SOURCE, /id="stone-harbor-borough-mobile-qa-20260726"/);
assert.match(SOURCE, /setImportant\(toggle, "top", "calc\(64px \+ env\(safe-area-inset-top, 0px\)\)"\)/);
assert.match(SOURCE, /setImportant\(key, "right", "48px"\)/);
assert.match(SOURCE, /maxWidth: viewportPopupWidth/);
assert.match(SOURCE, /window\.innerWidth - 28/);
assert.match(SOURCE, /autoPanPaddingTopLeft: mobilePopup \? L\.point\(10, 126\)/);
assert.match(SOURCE, /document\.body\.classList\.add\("persistent-flood-popup-open"\)/);
assert.match(SOURCE, /document\.body\.classList\.remove\("persistent-flood-popup-open"\)/);
assert.match(SOURCE, /\.flood-history-close\{[\s\S]+width:44px !important/);
assert.match(SOURCE, /id="stone-harbor-borough-centered-close-controls"/);
assert.match(SOURCE, /transform:translate\(-50%,-50%\) rotate\(45deg\) !important/);
assert.match(SOURCE, /transform:translate\(-50%,-50%\) rotate\(-45deg\) !important/);
assert.match(SOURCE, /\.flood-year-control input\[type="range"\]\{[\s\S]+min-height:30px !important/);
assert.match(SOURCE, /grid-template-columns:120px minmax\(0, 1fr\) !important/);
assert.match(SOURCE, /persistent-flood-popup-open #timelineBubble/);
assert.match(SOURCE, /\{ allowNearest: false \}/);
assert.match(SOURCE, /No parcel contains that building tap/);
assert.match(SOURCE, /requestIdleCallback/);
assert.match(SOURCE, /loadForecast\(null, \{ selectCurrent: true, forceRefresh: true \}\)/);
assert.match(SOURCE, /observedArchiveIndexPath/);
assert.match(SOURCE, /lewesArchiveIndexPath/);
assert.match(SOURCE, /function ensureObservedArchiveYear\(/);
assert.match(SOURCE, /function ensureObservedArchiveRange\(/);
assert.match(SOURCE, /await ensureObservedArchiveForDate\(dateStr\)/);
assert.match(SOURCE, /Loading the selected tide-archive year/);
assert.doesNotMatch(extractFunction("warmBackgroundData"), /LEWES_HOURLY_URL/);
assert.doesNotMatch(extractFunction("warmBackgroundData"), /OBSERVED_15MIN_URL/);
assert.match(SOURCE, /data-return-years="10000"/);
assert.match(
  SOURCE,
  /const RETURN_INTERVAL_OPTIONS = \[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000\]/
);
assert.match(
  SOURCE,
  /\.leaflet-image-layer\.return-interval-depth-overlay,[\s\S]+filter:contrast\(\.68\) brightness\(1\.25\) saturate\(1\.25\)/
);
assert.match(
  extractFunction("setFloodLayer"),
  /className: currentDataMode === "return-interval" && mode === "depth"[\s\S]+return-interval-depth-overlay/
);
assert.match(
  extractFunction("setExportFloodLayer"),
  /className: currentDataMode === "return-interval" && mode === "depth"[\s\S]+return-interval-depth-overlay/
);
assert.match(SOURCE, /record\.targetNavd88Ft \?\? record\.weightedNavd88Ft \?\? record\.naccsNavd88Ft/);
assert.match(extractFunction("switchReturnInterval"), /await loadReturnInterval\(\)/);
assert.doesNotMatch(extractFunction("switchReturnInterval"), /previousEntry/);
assert.match(SOURCE, /<h2>Flood Data<\/h2>/);
assert.match(SOURCE, />Modeled Floods<\/button>/);
assert.match(SOURCE, /<h2>How Often\?<\/h2>/);
assert.match(SOURCE, /Every 10 Years/);
assert.match(SOURCE, /return-interval-mode #leftPanel > #timelineIntervalCard\{order:1 !important\}/);
assert.match(SOURCE, /#rightRail > #mapperTutorialBtn\{order:5 !important\}/);
assert.match(SOURCE, /#mapperTutorialBtn\.mapper-tutorial-launch\{[\s\S]+bottom:0 !important/);
assert.match(SOURCE, /body\.observed-mode #leftPanel \.data-source-options,[\s\S]+grid-template-columns:repeat\(3,minmax\(0,1fr\)\) !important/);
assert.match(SOURCE, /function loadObservedDay\([\s\S]+findClosestMeasuredEntryIndex\(currentSeriesHours, preferredEntry\)/);
assert.match(extractFunction("getLatestObservedDate"), /peakNAVD88 != null/);
assert.match(extractFunction("getLatestObservedDate"), /hasMeasuredHour/);
assert.match(extractFunction("renderTimelineDays"), /hasDisplayedLongGaugeOutage\(currentSeriesHours, group\.start, group\.end\)/);
assert.match(extractFunction("renderHour"), /hasDisplayedLongGaugeOutage\(currentSeriesHours\)/);
const helpCopyStart = SOURCE.indexOf("const HELP_COPY =");
const helpCopyEnd = SOURCE.indexOf("function setInfoModalOpen", helpCopyStart);
assert.ok(helpCopyStart >= 0 && helpCopyEnd > helpCopyStart);
assert.doesNotMatch(SOURCE.slice(helpCopyStart, helpCopyEnd), /—/);
assert.doesNotMatch(extractFunction("sliderHelpBody"), /—/);

const nearestObservedContext = vm.createContext({
  Number,
  entryTimeMs: entry => Date.parse(entry.timeUtc),
  getStageValue: entry => entry.navd88StageFt,
  findClosestEntryIndex: () => 0,
});
vm.runInContext(
  `${extractFunction("findClosestMeasuredEntryIndex")}; globalThis.findClosestMeasuredEntryIndex = findClosestMeasuredEntryIndex;`,
  nearestObservedContext
);
const fallbackSeries = Array.from({ length: 24 }, (_, index) => ({
  timeUtc: new Date(Date.UTC(2026, 6, 30, index)).toISOString(),
  navd88StageFt: index === 9 ? 2.13 : null,
  isMissingObservedHour: index !== 9,
}));
assert.equal(
  nearestObservedContext.findClosestMeasuredEntryIndex(
    fallbackSeries,
    { timeUtc: new Date(Date.UTC(2026, 6, 30, 12)).toISOString() }
  ),
  9,
  "Observed mode must choose the nearest real measurement instead of a closer missing slot"
);
assert.equal(
  nearestObservedContext.findClosestMeasuredEntryIndex(
    [
      { timeUtc: new Date(Date.UTC(2026, 6, 30, 9)).toISOString(), navd88StageFt: 2.1 },
      { timeUtc: new Date(Date.UTC(2026, 6, 30, 11)).toISOString(), navd88StageFt: 2.2 },
    ],
    { timeUtc: new Date(Date.UTC(2026, 6, 30, 10)).toISOString() }
  ),
  1,
  "An equal-distance observed fallback should prefer the newer measurement"
);

const gaugeOutageContext = vm.createContext({
  Number,
  getStageValue: entry => entry.navd88StageFt,
  getTimelineFrameHours: () => 1,
});
vm.runInContext(
  `${extractFunction("getLongestGaugeOutageHours")}; globalThis.getLongestGaugeOutageHours = getLongestGaugeOutageHours;`,
  gaugeOutageContext
);
const partialLatestDay = Array.from({ length: 24 }, (_, index) => ({
  navd88StageFt: index === 9 ? 2.13 : null,
  isMissingObservedHour: index !== 9,
}));
assert.equal(gaugeOutageContext.getLongestGaugeOutageHours(partialLatestDay), 14);
assert.equal(
  gaugeOutageContext.getLongestGaugeOutageHours(partialLatestDay, 0, null, { ignoreTrailingGap: true }),
  9,
  "Future or not-yet-published slots after the latest real reading must not mark the latest observed day inoperable"
);
const interruptedDay = partialLatestDay.map((entry, index) => (
  index === 23 ? { navd88StageFt: 2.2, isMissingObservedHour: false } : entry
));
assert.equal(
  gaugeOutageContext.getLongestGaugeOutageHours(interruptedDay, 0, null, { ignoreTrailingGap: true }),
  13,
  "A completed gap between two real readings must still be treated as a gauge outage"
);
assert.doesNotMatch(SOURCE, /id="returnIntervalMethodNote"/);
assert.doesNotMatch(SOURCE, /no USGS averaging/);
assert.doesNotMatch(SOURCE, /depth map capped at/);
assert.match(SOURCE, /function clearStableDesktopPaneSizes\(/);
assert.equal(OBSERVED_INDEX.source, "stone-harbor");
assert.equal(LEWES_INDEX.source, "lewes");
assert.equal(OBSERVED_INDEX.days.length, OBSERVED_15MIN.days.length);
assert.ok(LEWES_INDEX.days.length > 23000);

for (const family of ["DepthPNGs", "StagePNGs"]) {
  const directory = path.join(BUNDLED_HYDRAULIC_ROOT, family, "Stone Harbor Borough");
  const files = fs.readdirSync(directory).filter(name => name.endsWith(".png")).sort();
  assert.equal(files.length, 201, `${family} must contain the complete 0.0–20.0 ft catalog`);
  assert.match(files[0], /p000\.png$/);
  assert.match(files.at(-1), /p200\.png$/);
}
assert.ok(fs.statSync(path.join(
  BUNDLED_HYDRAULIC_ROOT,
  "COGs",
  "Stone Harbor Borough",
  "StoneHarborBoroughHydraulicQuery5ft.png"
)).size > 100_000);

const selectedRangeContext = vm.createContext({
  Date,
  Math,
  Number,
  EXPORT_RANGE_MAX_MS: 84 * 60 * 60 * 1000,
  currentDataMode: "forecast",
  currentSeriesHours: [],
  currentEntry: null,
  fallbackRange: null,
});
selectedRangeContext.getDownloadCurrentEntry = () => selectedRangeContext.currentEntry;
selectedRangeContext.getEntryESTDate = entry => entry?.date || null;
selectedRangeContext.getCurrentForecastExportRange = () => selectedRangeContext.fallbackRange;
vm.runInContext(
  `${extractFunction("getCurrentSelectionExportRange")}; globalThis.getCurrentSelectionExportRange = getCurrentSelectionExportRange;`,
  selectedRangeContext
);

const sandyPeak = new Date("2012-10-30T00:45:00.000Z");
selectedRangeContext.currentEntry = { date: sandyPeak };
selectedRangeContext.currentSeriesHours = [
  { date: new Date("2012-10-29T04:00:00.000Z") },
  { date: sandyPeak },
  { date: new Date("2012-10-30T03:45:00.000Z") },
];
let selectedRange = selectedRangeContext.getCurrentSelectionExportRange();
assert.equal(selectedRange.firstDate.getTime(), sandyPeak.getTime(), "Export must start at the selected Sandy frame");
assert.equal(
  selectedRange.lastDate.getTime(),
  new Date("2012-10-30T03:45:00.000Z").getTime(),
  "Export must retain the remaining frames in the selected series"
);

const laterForecastFrame = new Date("2026-07-27T18:00:00.000Z");
selectedRangeContext.currentEntry = { date: laterForecastFrame };
selectedRangeContext.currentSeriesHours = [
  { date: new Date("2026-07-27T12:00:00.000Z") },
  { date: laterForecastFrame },
  { date: new Date("2026-07-28T00:00:00.000Z") },
  { date: new Date("2026-08-01T18:00:00.000Z") },
];
selectedRange = selectedRangeContext.getCurrentSelectionExportRange();
assert.equal(
  selectedRange.firstDate.getTime(),
  laterForecastFrame.getTime(),
  "Export must start at the selected forecast frame, not the first forecast frame"
);
assert.equal(
  selectedRange.lastDate.getTime(),
  new Date("2026-07-28T00:00:00.000Z").getTime(),
  "Export end must remain within the 84-hour limit"
);

const modeledFrames = [
  { date: new Date("2026-06-15T13:45:00.000Z"), navd88StageFt: 2.1 },
  { date: new Date("2026-06-16T01:45:00.000Z"), navd88StageFt: 6.2 },
  { date: new Date("2026-06-16T13:45:00.000Z"), navd88StageFt: 2.0 },
];
selectedRangeContext.currentDataMode = "return-interval";
selectedRangeContext.currentEntry = modeledFrames[1];
selectedRangeContext.getReturnIntervalExportEntries = () => modeledFrames;
selectedRangeContext.entryTimeMs = entry => entry.date.getTime();
selectedRange = selectedRangeContext.getCurrentSelectionExportRange();
assert.equal(
  selectedRange.firstDate.getTime(),
  modeledFrames[0].date.getTime(),
  "Modeled export must default to the beginning of the synthetic storm"
);
assert.equal(
  selectedRange.lastDate.getTime(),
  modeledFrames.at(-1).date.getTime(),
  "Modeled export must default to the end of the synthetic storm"
);

const modeledExportContext = vm.createContext({
  Array,
  Number,
  currentDataMode: "return-interval",
  currentRawSeriesHours: modeledFrames,
  currentSeriesHours: modeledFrames,
  selectedObservedDate: "",
  entryTimeMs: entry => entry.date.getTime(),
});
for (const name of [
  "getReturnIntervalExportEntries",
  "getCurrentExportSourceMode",
  "getDownloadSourceEntries",
  "getDownloadFrameItemFromEntry",
]) {
  vm.runInContext(`${extractFunction(name)}; globalThis.${name} = ${name};`, modeledExportContext);
}
const modeledSources = modeledExportContext.getDownloadSourceEntries();
assert.equal(modeledSources.length, modeledFrames.length);
assert.deepEqual(
  Array.from(modeledSources, entry => entry.exportSourceMode),
  ["return-interval", "return-interval", "return-interval"],
  "Modeled export frames must not be relabeled as forecast frames"
);
const modeledFrameItem = modeledExportContext.getDownloadFrameItemFromEntry(modeledSources[1], 1);
assert.equal(modeledFrameItem.mode, "return-interval");
assert.equal(modeledFrameItem.series.length, modeledFrames.length);

const sandyDay = OBSERVED_15MIN.days.find(item => item.d === "2012-10-29");
assert.ok(sandyDay, "Missing Hurricane Sandy quarter-hour archive day");
assert.equal(sandyDay.v.length, 96);
assert.equal(sandyDay.v.filter(Number.isFinite).length, 0, "A raw USGS outage must remain unavailable");
const sandyCrest = TOP_TIDES.toptides.find(item => item.date === "2012-10-29");
assert.ok(sandyCrest, "Missing the official USGS Hurricane Sandy crest");
assert.equal(Math.round(Number(sandyCrest.height_ft) * 100), 673);
assert.equal(sandyCrest.time_est, "20:36");

const jonasDay = OBSERVED_15MIN.days.find(item => item.d === "2016-01-23");
assert.ok(jonasDay, "Missing Winter Storm Jonas quarter-hour archive");
assert.equal(jonasDay.v.filter(Number.isFinite).length, 96);
assert.equal(Math.max(...jonasDay.v), 622, "Raw Stone Harbor Jonas peak is wrong");
assert.equal(jonasDay.v.indexOf(622), 36, "Raw Stone Harbor Jonas peak time is wrong");

assert.match(extractFunction("buildHarmonicCrestOnlySeries"), /Math\.sin\(phase\)[\s\S]+Math\.sin\(crestPhase\)/);
assert.match(extractFunction("buildHarmonicCrestOnlySeries"), /Math\.cos\(phase\)[\s\S]+Math\.cos\(crestPhase\)/);
const harmonicContext = vm.createContext({ Math, Number, Array, DATUM_OFFSETS: { mllw: 2.66 }, MINOR_FLOOD_FT: 3.44, CREST_ONLY_TIDE_PERIOD_HOURS: 12.4206, CREST_ONLY_SURGE_HALF_WINDOW_HOURS: 12, getTimelineIntervalMinutes: () => 15, getStageValue: entry => Number(entry?.navd88StageFt), pad2: value => String(value).padStart(2, "0") });
vm.runInContext(`${extractFunction("buildHarmonicCrestOnlySeries")}; globalThis.buildHarmonicCrestOnlySeries = buildHarmonicCrestOnlySeries;`, harmonicContext);
const harmonicSeries = harmonicContext.buildHarmonicCrestOnlySeries({ observedDate: "1944-09-14", displayTimeEST: "1944-09-14T20:36", navd88StageFt: 8.6 });
assert.equal(harmonicSeries.length, 96);
assert.equal(Math.max(...harmonicSeries.map(entry => entry.navd88StageFt)), 8.6);
assert.equal(harmonicSeries[82].isFittedCrestFrame, true);
assert.ok(harmonicSeries[80].navd88StageFt < harmonicSeries[82].navd88StageFt);
assert.ok(harmonicSeries[84].navd88StageFt < harmonicSeries[82].navd88StageFt);

console.log("Stone Harbor Borough browser depth and export contract checks passed");
