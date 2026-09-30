import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.EXPORT_TEST_SOURCE || new URL('../index.html', import.meta.url), 'utf8');
function extract(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
}
function context(name, mocks) {
  const ctx = vm.createContext({setTimeout, clearTimeout, setInterval, clearInterval, ...mocks});
  vm.runInContext(extract(name), ctx);
  return ctx;
}
const noop = () => {};

// A failed or cancelled base capture must not affect the next export.
for (const failurePoint of ['waitForExportMapReady', 'captureExportCanvas']) {
  const nodes = Object.fromEntries(['exportTimestampLabel', 'exportLegendDock', 'exportLogoStrip'].map((id, i) => [id, {style:{visibility:i === 1 ? 'visible' : ''}}]));
  const original = Object.values(nodes).map(n => n.style.visibility);
  const ctx = context('captureFastGifBaseCanvas', {
    document:{getElementById:id => nodes[id]},
    ensureExportMap:() => ({invalidateSize:noop,hasLayer:()=>false}),
    applyExportStageAspect:noop,getDownloadAspectValue:()=> 'viewport',
    updateExportLegend:noop,updateExportBoundaryVisibility:noop,updateExportParcelsLayer:noop,
    updateExportRoadLayerAppearance:noop,fitExportMapToSelectedExtent:noop,exportFloodLayer:null,
    waitForExportMapReady:noop,waitForStableRender:noop,captureExportCanvas:()=>({}),
    captureExportMapForegroundCanvas:noop,captureExportRoadLabelsCanvas:noop,captureExportChromeCanvas:noop,
    updateExportTimestampLabel:noop,getExportOverlayRect:()=>({}),
  });
  const success = ctx[failurePoint];
  ctx[failurePoint] = () => {throw new Error('interrupted');};
  await assert.rejects(ctx.captureFastGifBaseCanvas({entry:{}}), /interrupted/);
  assert.deepEqual(Object.values(nodes).map(n => n.style.visibility), original, 'Export chrome must be restored after interruption');
  ctx[failurePoint] = success;
  await ctx.captureFastGifBaseCanvas({entry:{}});
  assert.deepEqual(Object.values(nodes).map(n => n.style.visibility), original);
}

// Exercise cached synchronous image loads, image errors, and failed preloads.
for (const outcome of ['cached', 'error', 'preload-error']) {
  const handlers = new Map();
  const layer = {
    once:(name, fn) => handlers.set(name, fn),
    off:(name) => handlers.delete(name),
    addTo:() => handlers.get(outcome === 'error' ? 'error' : 'load')?.(),
    getElement:() => ({complete:true,naturalWidth:outcome === 'error' ? 0 : 100}),
  };
  const ctx = context('setExportFloodLayer', {
    ensureExportMap:noop,getPhysicsDisplayRecord:()=>null,getPhysicsAssetForEntry:()=>null,
    getHydraulicOverlayRecord:async()=>({url:'flood.webp'}),ensureOverlayBounds:noop,
    preloadImage:async()=> outcome === 'preload-error' ? null : 'flood.webp',
    throwIfExportCancelled:noop,exportMap:{hasLayer:()=>false},exportFloodLayer:null,
    overlayOpacity:0.75,currentDataMode:'forecast',currentRawSeriesHours:[],
    createHydraulicImageOverlay:()=>layer,
  });
  if (outcome === 'cached') await ctx.setExportFloodLayer('depth', 5);
  else await assert.rejects(ctx.setExportFloodLayer('depth', 5), /flood image could not load/);
  assert.equal(handlers.size, 0, 'Remove image listeners on success and failure');
}

const frameImage = context('getExportFrameImage', {
  getOverlayStage: x => x, getStageValue: () => 5, getHydraulicPhaseForEntry: () => 'slack',
  getPhysicsDisplayRecord: () => null, getPhysicsAssetForEntry: () => null,
  throwIfExportCancelled: noop, currentOverlayMode: 'depth',
  getHydraulicOverlayRecord: async () => ({url:'flood.webp'}), getExportImageElement: async () => null,
});
await assert.rejects(frameImage.getExportFrameImage({entry:{}}), /flood image could not load/);
frameImage.getHydraulicOverlayRecord = async () => null;
await assert.rejects(frameImage.getExportFrameImage({entry:{}}), /flood image is unavailable/);

let ready = false, repainted = false;
let workerAttempts = 0;
const workerUrl = context('getGifWorkerUrl', {
  gifWorkerUrlPromise:null, GIF_WORKER_CDN_URL:'worker.js',
  getSameOriginWorkerUrl:async()=>{
    if (++workerAttempts === 1) throw new Error('offline');
    return 'blob:worker';
  },
});
await assert.rejects(workerUrl.getGifWorkerUrl(), /offline/);
assert.equal(await workerUrl.getGifWorkerUrl(), 'blob:worker', 'Retry a worker download after a network failure');
assert.equal(await workerUrl.getGifWorkerUrl(), 'blob:worker');
assert.equal(workerAttempts, 2);
const vector = context('waitForExportVectorLayerReady', {
  throwIfExportCancelled:noop,wait:async()=>{ready=true;},requestAnimationFrame:fn=>fn(),
});
const layer = {_createMaplibreLayer:noop,_maplibreGL:{_glMap:{loaded:()=>ready,areTilesLoaded:()=>ready,triggerRepaint:()=>{repainted=true;}}}};
await vector.waitForExportVectorLayerReady(layer);
assert.ok(repainted, 'Wait for vector tiles and repaint before capture');
await assert.rejects(vector.waitForExportVectorLayerReady(layer, 0), /map background is still loading/);

let tilesReady = false;
const tile = {complete:false,naturalWidth:0};
const raster = context('waitForExportRasterLayerReady', {
  throwIfExportCancelled:noop, requestAnimationFrame:fn=>fn(),
  wait:async()=>{tilesReady=true;tile.complete=true;tile.naturalWidth=256;},
});
const rasterLayer = {isLoading:()=>!tilesReady,getContainer:()=>({querySelectorAll:()=>[tile]})};
await raster.waitForExportRasterLayerReady(rasterLayer);
tile.naturalWidth=0;
await assert.rejects(raster.waitForExportRasterLayerReady(rasterLayer), /map tile could not load/);

// The upstream vector layer throws when removed before style initialization.
let readyListener = true, fallbackCount = 0;
const pendingVector = {_createMaplibreLayer:noop,off:name=>{if(name==='ready')readyListener=false;},onRemove:()=>{throw Error('undefined inner layer');}};
const fallbackLayer = {};
const fallback = context('useExportFallbackBasemap', {
  exportBasemapColorLayer:pendingVector, FALLBACK_BASEMAP_URL:'tiles/{z}/{x}/{y}',
  exportMap:{hasLayer:()=>true,removeLayer:layer=>{assert.equal(readyListener,false);layer.onRemove();}},
  L:{tileLayer:()=>({addTo:()=>{fallbackCount++;return fallbackLayer;}})},
});
fallback.useExportFallbackBasemap(pendingVector);
assert.equal(fallback.exportBasemapColorLayer, fallbackLayer);
fallback.useExportFallbackBasemap(pendingVector);
assert.equal(fallbackCount,1,'Late errors from the abandoned vector layer must not replace the fallback');

const mapReady = context('waitForExportMapReady', {
  exportMap:{invalidateSize:noop},exportBasemapColorLayer:pendingVector,
  exportRoadsLayer:null,exportSatelliteLayer:null,exportBuildingsLayer:null,
  requestAnimationFrame:fn=>fn(), wait:async()=>{}, waitForTileLayerReady:async()=>{},
  waitForExportVectorLayerReady:async()=>{throw Error('stalled vector');},
  isExportCancelledError:e=>e.name==='AbortError',
});
mapReady.useExportFallbackBasemap = old=>{assert.equal(old,pendingVector);mapReady.exportBasemapColorLayer=fallbackLayer;};
let rasterChecked = false;
mapReady.waitForExportRasterLayerReady = async layer=>{assert.equal(layer,fallbackLayer);rasterChecked=true;};
await mapReady.waitForExportMapReady();
assert.ok(rasterChecked,'Wait for the fallback tiles before capturing');
mapReady.waitForExportVectorLayerReady=async()=>{throw Object.assign(Error('cancelled'),{name:'AbortError'});};
await assert.rejects(mapReady.waitForExportMapReady(), /cancelled/);

// Inline a CORS-loaded logo once so html2canvas cannot silently lose a slow CDN image.
let logoLoads = 0;
const logo = {src:'https://example.test/logo.jpg',style:{display:''},classList:{contains:()=>true},decode:async()=>{}};
const logoCanvas = {getContext:()=>({drawImage:noop}),toDataURL:()=> 'data:image/png;base64,logo'};
const chrome = context('waitForExportChromeReady', {
  document:{getElementById:id=>id==='exportPartnerLogo'?logo:null,createElement:()=>logoCanvas},
  getExportImageElement:async()=>{logoLoads++;return{naturalWidth:400,naturalHeight:100};},
  throwIfExportCancelled:noop,
});
await chrome.waitForExportChromeReady();
await chrome.waitForExportChromeReady();
assert.equal(logoLoads,1);assert.ok(logo.src.startsWith('data:'));
assert.equal(logoCanvas.width,1);assert.equal(logoCanvas.height,1);
logo.src='https://example.test/missing.jpg';chrome.getExportImageElement=async()=>null;
await assert.rejects(chrome.waitForExportChromeReady(), /logo could not load/);
const body = {}, stage = {};
const clone = context('isOutsideExportStage', {document:{body,getElementById:()=>stage}});
const element = (tagName, contains = false) => ({parentElement:body,tagName,contains:()=>contains});
assert.equal(clone.isOutsideExportStage(element('DIV')),true);
assert.equal(clone.isOutsideExportStage(element('DIV',true)),false,'Preserve any ancestor of the export stage');
assert.equal(clone.isOutsideExportStage(stage),false);
assert.equal(clone.isOutsideExportStage(element('STYLE')),false);
assert.equal(clone.isOutsideExportStage(element('LINK')),false);
assert.equal(clone.isOutsideExportStage({parentElement:{},tagName:'DIV'}),false);
console.log('PASS export recovery: interrupted captures, missing images, vector/raster readiness, safe fallback, cancellation, worker retry and inline logos.');
