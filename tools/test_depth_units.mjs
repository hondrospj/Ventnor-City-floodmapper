import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let compiled = 0;
for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=|application\/ld\+json/.test(match[1])) continue;
  new vm.Script(match[2], { filename: `index.html:inline-${++compiled}` });
}
assert.ok(compiled > 0);

function extract(name, source = html) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing function ${name}`);
  // These functions have balanced braces, including their template expressions.
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

const context = vm.createContext({
  currentDataMode: 'forecast',
  getSelectedStageNavd88: () => 0.5,
  getNsiFirstOccupiedFloorNavd88: p => p.modeledFirstFloorNavd88Ft,
  escapeTownAddressHtml: value => value,
});
const load = (name, source = html) => vm.runInContext(extract(name, source), context);
load('formatWaterDepth');
for (const [value, expected] of [
  [0, '0 in'], [0.05, '0.6 in'], [0.1, '1.2 in'], [0.25, '3 in'],
  [0.5, '6 in'], [0.75, '9 in'], [0.99, '11.9 in'], [1, '1.00 ft'],
  [1.01, '1.01 ft'], [1.5, '1.50 ft'], [2, '2.00 ft'],
  [null, 'N/A'], [undefined, 'N/A'], [NaN, 'N/A'], [Infinity, 'N/A'],
]) assert.equal(context.formatWaterDepth(value), expected, `Depth ${value}`);
assert.equal(context.formatWaterDepth(1.5, 1), '1.5 ft');
assert.equal(context.formatWaterDepth(0.999999), '12 in');

const legend = html.match(/const DEPTH_LEGEND = (\[[\s\S]*?\]);/);
assert.ok(legend);
assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(legend[1], context))).slice(0, 5).map(row => row.label),
  ['< 1.2 in', '1.2–3 in', '3–6 in', '6–12 in', '1.00–1.50 ft']);

if (html.includes('function v11PopupHtml(')) {
  load('v11Heading');
  load('v11PopupHtml');
  for (const [depth, text] of [[0, '0 in'], [0.05, '0.6 in'], [0.5, '6 in'], [1, '1.00 ft'], [null, 'N/A']]) {
    assert.ok(context.v11PopupHtml(depth, 'ready').includes(`>${text}</div>`));
  }
  assert.ok(context.v11PopupHtml(0.5, 'loading').includes('>…</div>'));
  assert.ok(context.v11PopupHtml(0.5, 'approximate').includes('Depth estimated from the displayed map class.'));
} else {
  const isV2 = html.includes('function formatDepthQueryValue(');
  if (isV2) load('formatDepthQueryValue');
  load('getDepthQueryPopupHeading');
  load('buildDepthQueryPopupHtml');
  for (const [depth, text] of [[0, '0 in'], [0.5, '6 in'], [1, '1.00 ft'], [null, 'N/A']]) {
    assert.ok(context.buildDepthQueryPopupHtml(depth).includes(`>${text}</div>`));
  }
  if (isV2) {
    assert.equal(context.formatDepthQueryValue(0.1), '0–1.2 in');
    assert.equal(context.formatDepthQueryValue(0.10001), '1.2 in');
    load('formatNsiImpactStatus');
    for (const [stage, text] of [[0.5, '6 in above'], [-0.5, '6 in below'], [1, '1.0 ft above']]) {
      assert.ok(context.formatNsiImpactStatus({modeledFirstFloorNavd88Ft: 0}, stage).includes(text));
    }
    load('buildHouseAlertPopup');
    const building = context.buildHouseAlertPopup({properties: {modeledFirstFloorNavd88Ft: 0, foundationHeightFt: 0.5}});
    assert.ok(building.includes('6 in above'));
    assert.ok(building.includes('<strong>6 in</strong>'));

    // Execute the physics map-click path, including conversion from meters.
    let popup;
    Object.assign(context, {
      mapClickMode: 'depth', currentSeriesHours: [{}], currentHourIndex: 0,
      getPhysicsAssetForEntry: () => ({}),
      samplePhysicsDepth: async () => ({depthM: 0.1524, wet: true}),
      getActivePhysicsManifest: () => ({cycleId: 'test'}),
      openPersistentFloodPopup: (_latlng, html) => { popup = html; },
      toast: message => { throw new Error(message); }, console,
    });
    vm.runInContext('async ' + extract('handleDepthQueryClick'), context);
    await context.handleDepthQueryClick({latlng: {lat: 1, lng: 1}});
    assert.ok(popup.includes('>6 in</div>'));
    context.samplePhysicsDepth = async () => ({depthM: 0.3048, wet: true});
    await context.handleDepthQueryClick({latlng: {lat: 1, lng: 1}});
    assert.ok(popup.includes('>1.00 ft</div>'));
    context.samplePhysicsDepth = async () => ({depthM: 0.6096, wet: true});
    await context.handleDepthQueryClick({latlng: {lat: 1, lng: 1}});
    assert.ok(popup.includes('>2.00 ft</div>'));
  }
}

const assets = path.join(root, 'assets/3d');
if (fs.existsSync(assets)) {
  for (const name of fs.readdirSync(assets).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(assets, name), 'utf8');
    new vm.Script(source, {filename: name});
    if (!source.includes('function buildBuildingPopupHtml(')) continue;
    if (source.includes('function finiteBuildingNumber(')) load('finiteBuildingNumber', source);
    load('buildBuildingPopupHtml', source);
    const popup = context.buildBuildingPopupHtml({modeledFirstFloorNavd88Ft: 0, foundationHeightFt: 0.5});
    assert.ok(popup.includes('6 in above'), name);
    assert.ok(popup.includes('<strong>6 in</strong>'), name);
  }
}
console.log(`Depth units passed; ${compiled} inline scripts compiled.`);
