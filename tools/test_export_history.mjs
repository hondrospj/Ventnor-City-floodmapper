import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(process.env.EXPORT_TEST_SOURCE || new URL('../index.html', import.meta.url), 'utf8');
const extract = name => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};
// Quarter-hour measurements include a minor-flood crest, its release period,
// and a second rise. Daily display rows cannot supply this tide history.
const makeSeries = (date, stages) => stages.map((stage, i) => ({
  timeUtc: new Date(Date.parse(`${date}T00:00:00Z`) + i * 900000).toISOString(),
  observedDate: date, navd88StageFt: stage, timelineIntervalMinutes: 15
}));
const forecast = makeSeries('2026-10-03', [2, 2.5, 3, 3.5, 3.4, 3.2, 3, 2.7, 2.4, 2.2, 2.5, 3]);
const observed = makeSeries('2026-09-26', [2, 3, 4, 5, 4.8, 4.4, 4, 3.5, 3, 2, 2.5, 3]);
const ctx = vm.createContext({
  MINOR_FLOOD_FT: 3, MODERATE_FLOOD_FT: 4, MAJOR_FLOOD_FT: 6,
  getStageValue: e => e?.navd88StageFt ?? null,
  entryTimeMs: e => e ? Date.parse(e.timeUtc) : null,
  findClosestEntryIndex: (rows, e) => rows.findIndex(r => r.timeUtc === e.timeUtc),
  currentDataMode: 'forecast', selectedObservedDate: '2026-09-26',
  getActiveForecastHours: () => forecast,
  physicsForecastApplies: () => false,
  getObservedDayRecord: date => ({date}),
  getDownloadIntervalValue: () => 'hourly',
});
for (const name of ['normalizeHydraulicPhase', 'getHydraulicFrameMinutes', 'findHydraulicCrestIndex', 'getHydraulicElapsedMinutes', 'inferHydraulicPhaseForIndex', 'annotateHydraulicSeries', 'getHydraulicPhaseForEntry', 'getDrainageRetentionMilestones', 'getDownloadFrameItemFromEntry', 'findClosestExportEntryForSlot', 'buildHourlyRangeFrameItems']) {
  vm.runInContext(extract(name), ctx);
}
ctx.buildForecastCanonicalSeries = rows => ctx.annotateHydraulicSeries(rows);
ctx.buildObservedCanonicalSeries = () => ctx.annotateHydraulicSeries(observed);
const canonical = ctx.buildForecastCanonicalSeries(forecast);
ctx.currentRawSeriesHours = canonical;

for (const display of [canonical, [canonical[3]]]) {
  ctx.currentSeriesHours = display;
  const raw = {...forecast[4], exportSourceMode: 'forecast', exportInterval: 'hourly'};
  const item = ctx.getDownloadFrameItemFromEntry(raw, 0);
  assert.equal(ctx.getHydraulicPhaseForEntry(item.entry, item.index, item.series || display), 'draining-release-15', 'Export phase must not depend on the visible timeline interval');
  assert.equal(item.entry.hydraulicCrestTimeUtc, forecast[3].timeUtc, 'Preserve the crest before the exported range');
  assert.equal(ctx.getDrainageRetentionMilestones(item.entry, item.series).length, 1, 'Preserve water admitted at the crest');
  assert.equal(item.entry.exportInterval, 'hourly');
  const items = ctx.buildHourlyRangeFrameItems(forecast.map(entry => ({...entry, exportSourceMode:'forecast'})), {startMs:Date.parse(forecast[4].timeUtc),endMs:Date.parse(forecast[8].timeUtc)});
  assert.equal(items.length, 2);
  assert.equal(items[0].entry.hydraulicPhase, canonical[4].hydraulicPhase);
  assert.equal(items[1].entry.hydraulicPhase, canonical[8].hydraulicPhase);
  assert.equal(items[0].series, items[1].series, 'Frames share one immutable source snapshot');
}

// Archive exports must use the selected archive day, even while forecast is open.
const archived = ctx.getDownloadFrameItemFromEntry({...observed[4], exportSourceMode:'observed'}, 0);
assert.equal(archived.entry.hydraulicCrestStageFt, 5);
assert.equal(archived.series[0].timeUtc, observed[0].timeUtc);
assert.equal(archived.mode, 'observed');
const capturedStage = archived.series[3].navd88StageFt;
ctx.currentRawSeriesHours = [];
ctx.currentSeriesHours = [];
assert.equal(archived.series[3].navd88StageFt, capturedStage, 'Changing the displayed timeline cannot alter an export');
console.log('PASS export tide history: daily/hourly display independence, range crest retention, archive source and snapshot.');
