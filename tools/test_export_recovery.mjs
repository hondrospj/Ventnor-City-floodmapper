import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.EXPORT_TEST_SOURCE || new URL('../index.html', import.meta.url), 'utf8');
const rasterReadinessSource = source;
function extract(name) {
  const testedSource = name === 'waitForExportRasterLayerReady' ? rasterReadinessSource : source;
  const match = testedSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
}
function context(name, mocks) {
  const ctx = vm.createContext({setTimeout, clearTimeout, setInterval, clearInterval, URL, ...mocks});
  if (name === 'waitForExportRasterLayerReady') vm.runInContext(extract('retryExportRasterLayerTiles'), ctx);
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
    ensureExportMunicipalBoundary:noop,
    prepareExportRoadNames:noop,
    ensureExportMap:() => ({invalidateSize:noop,hasLayer:()=>false}),
    applyExportStageAspect:noop,getDownloadAspectValue:()=> 'viewport',
    updateExportLegend:noop,updateExportBoundaryVisibility:noop,updateExportParcelsLayer:noop,
    updateExportRoadLayerAppearance:noop,fitExportMapToSelectedExtent:noop,exportFloodLayer:null,
    exportUsesScalableRoadLabels:()=>true,throwIfExportCancelled:noop,
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

// The export can cross the road-label zoom threshold when its area/aspect
// changes. Apply visibility to the fitted camera, in both directions, before
// freezing the GIF's reusable road-label canvas.
for (const scalable of [false, true]) for (const [beforeZoom, fittedZoom] of [[9, 12], [12, 9]]) {
  let zoom = beforeZoom, rasterOpacity = null, localEnabled = null;
  const nodes = Object.fromEntries(['exportTimestampLabel', 'exportLegendDock', 'exportLogoStrip']
    .map(id => [id, {style:{visibility:''}}]));
  nodes.roadsToggle = {classList:{contains:()=>true}};
  const map = {invalidateSize:noop,hasLayer:()=>false,getZoom:()=>zoom,
    getPane:()=>({classList:{toggle:noop}})};
  const ctx = context('captureFastGifBaseCanvas', {
    document:{body:{},getElementById:id=>nodes[id]},
    window:{NORTH_WILDWOOD_EXPORT_ROADS:{redraw:(target,options)=>{
      assert.equal(target,map);localEnabled=options.enabled;
    }}},
    getComputedStyle:()=>({fontFamily:'Inter, sans-serif'}),
    ensureExportMunicipalBoundary:noop,prepareExportRoadNames:noop,ensureExportMap:()=>map,
    exportMap:map,exportRoadsLayer:{setOpacity:value=>{rasterOpacity=value;},setExportUnit:noop},ROAD_LABEL_ZOOM:10,
    exportUsesScalableRoadLabels:()=>scalable,throwIfExportCancelled:noop,
    getExportAspectConfig:()=>({width:1080,height:1080}),
    getDownloadExtentValue:()=> 'town',
    applyExportStageAspect:noop,getDownloadAspectValue:()=> '1:1',
    updateExportLegend:noop,updateExportBoundaryVisibility:noop,updateExportParcelsLayer:noop,
    fitExportMapToSelectedExtent:target=>{assert.equal(target,map);zoom=fittedZoom;},
    exportFloodLayer:null,waitForExportMapReady:noop,waitForStableRender:noop,
    captureExportCanvas:()=>({}),captureExportMapForegroundCanvas:noop,
    captureExportRoadLabelsCanvas:noop,captureExportChromeCanvas:noop,
    updateExportTimestampLabel:noop,getExportOverlayRect:()=>({}),
  });
  vm.runInContext(extract('updateExportRoadLayerAppearance'),ctx);
  await ctx.captureFastGifBaseCanvas({entry:{}});
  assert.equal(rasterOpacity,fittedZoom>=10 ? 0.98 : 0,
    'GIF road visibility must use the selected export camera for both renderers');
  assert.equal(localEnabled,fittedZoom>=10,
    'Local street names follow the selected camera alongside vector route shields');
}

// A cold export has no use for a hidden road renderer. Mount it once when
// the fitted camera and current preference make road labels visible.
{
  let enabled = false, zoom = 12, mounts = 0, opacity = null, localEnabled = null;
  const pane = {style:{}, classList:{toggle:noop}};
  const map = {createPane:noop, getPane:()=>pane, getZoom:()=>zoom};
  const roadLayer = {
    addTo: target => {assert.equal(target, map); mounts++;},
    setOpacity: value => {opacity = value;},
    setExportUnit: noop,
  };
  const ctx = context('ensureExportMap', {
    exportMap:null, exportBasemapColorLayer:null, exportRoadsLayer:null, exportSatelliteLayer:null,
    L:{map:()=>map, tileLayer:()=>({})}, makeEsriBuildingBasemapLayer:()=>null,
    useExportFallbackBasemap:noop, ESRI_WORLD_IMAGERY_URL:'imagery', ROAD_LABELS_URL:'roads', ROAD_LABEL_ZOOM:10,
    createRoadLabelLayer:()=>roadLayer,
    updateExportSatelliteLayer:noop, updateExportBuildingsLayer:noop, hasValidExportBoundaryGeometry:()=>false,
    fitExportMapToSelectedExtent:noop, exportUsesScalableRoadLabels:()=>true,
    document:{body:{}, getElementById:()=>({classList:{contains:()=>enabled}})},
    window:{NORTH_WILDWOOD_EXPORT_ROADS:{redraw:(_, options)=>{localEnabled = options.enabled;}}},
    getComputedStyle:()=>({fontFamily:'Inter'}), getExportAspectConfig:()=>({width:1080,height:1080}),
    getDownloadExtentValue:()=> 'town',
  });
  assert.equal(ctx.ensureExportMap(), map);
  assert.equal(mounts, 0, 'A cold map must not mount a disabled road renderer');
  vm.runInContext(extract('mountExportRoadLayer'), ctx);
  vm.runInContext(extract('updateExportRoadLayerAppearance'), ctx);
  ctx.updateExportRoadLayerAppearance();
  enabled = true;
  zoom = 9;
  ctx.updateExportRoadLayerAppearance();
  assert.equal(mounts, 0, 'An extent below the road-label threshold needs no renderer');
  zoom = 12;
  ctx.updateExportRoadLayerAppearance();
  ctx.updateExportRoadLayerAppearance();
  assert.equal(mounts, 1);
  assert.equal(ctx.exportRoadsLayer, roadLayer);
  assert.equal(opacity, 0.98);
  assert.equal(localEnabled, true);
  enabled = false;
  ctx.updateExportRoadLayerAppearance();
  assert.equal(mounts, 1, 'Keep the existing renderer for subsequent frames and retries');
  assert.equal(opacity, 0);
  assert.equal(localEnabled, false);
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
    APP_BASE:new URL('https://example.test/mapper/'),floodOverlayGeometryMode:'axis-aligned',
    floodLatLngBounds:{getSouth:()=>39,getWest:()=>-75,getNorth:()=>40,getEast:()=>-74},
    getConfiguredWorldFileCornersLatLng:()=>null,
    createHydraulicImageOverlay:()=>layer,
  });
  if (outcome === 'cached') await ctx.setExportFloodLayer('depth', 5);
  else await assert.rejects(ctx.setExportFloodLayer('depth', 5), /flood image could not load/);
  assert.equal(handlers.size, 0, 'Remove image listeners on success and failure');
}

// A successfully decoded export frame belongs to one renderer and one complete
// source/geometry identity. Changing its aspect must keep that actual image;
// URL-only caching still creates the redundant image request that stalled on
// hosted Windows. Reuse must never conceal a changed, failed or pending frame.
function floodFrameHarness({affine=true,url='flood.webp'}={}) {
  const bounds=(south=39,west=-75,north=40,east=-74)=>({getSouth:()=>south,getWest:()=>west,getNorth:()=>north,getEast:()=>east});
  const state={url,bounds:bounds(),corners:affine?[{lat:40,lng:-75},{lat:40.1,lng:-74},{lat:39,lng:-73.9},{lat:38.9,lng:-75}]:null,
    pixels:{width:2186,height:2824},geometryMode:affine?'world-file':'axis-aligned',physics:false,cancelled:false,outcome:'cached',preload:true};
  const counts={created:0,preloads:0,adds:0,removes:0,opacity:0},layers=[],attached=new Set(),timers=new Map(),intervals=new Map();
  let timerId=0,ctx;
  const map={hasLayer:layer=>attached.has(layer),removeLayer:layer=>{counts.removes++;attached.delete(layer);layer._map=null;}};
  const make=(url,extent,options,kind)=>{
    counts.created++;
    const handlers=new Map(),image={complete:false,naturalWidth:0,naturalHeight:0};
    const layer={_url:url,options:{...options},bounds:extent,kind,_map:null,
      _worldFileAffine:kind==='hydraulic'&&!!state.corners,
      _worldFileCorners:kind==='hydraulic'&&state.corners?state.corners.map(point=>({...point})):undefined,
      _pixelWidth:state.pixels.width,_pixelHeight:state.pixels.height,
      once(name,handler){handlers.set(name,handler);return this;},off(name){handlers.delete(name);return this;},
      getElement:()=>image,getBounds(){return this.bounds;},
      setOpacity(value){counts.opacity++;this.options.opacity=value;return this;},
      addTo(target){
        assert.equal(target,ctx.exportMap);counts.adds++;attached.add(this);this._map=target;
        if(image.complete&&image.naturalWidth>0)return this;
        if(state.outcome==='pending')return this;
        if(state.outcome==='invalid-load'){handlers.get('load')?.();return this;}
        image.complete=true;image.naturalWidth=state.outcome==='error'?0:2186;image.naturalHeight=image.naturalWidth?2824:0;
        handlers.get(state.outcome==='error'?'error':'load')?.();return this;
      },handlers,image,
    };
    layers.push(layer);return layer;
  };
  ctx=context('setExportFloodLayer',{
    APP_BASE:new URL('https://example.test/mapper/'),
    ensureExportMap:noop,exportMap:map,exportFloodLayer:null,overlayOpacity:.75,
    currentDataMode:'forecast',currentRawSeriesHours:[],floodLatLngBounds:state.bounds,floodOverlayGeometryMode:state.geometryMode,
    getPhysicsAssetForEntry:()=>state.physics?{}:null,getPhysicsDisplayRecord:asset=>asset?{url:state.url}:null,
    getActivePhysicsManifest:()=>({boundsWgs84:[[state.bounds.getSouth(),state.bounds.getWest()],[state.bounds.getNorth(),state.bounds.getEast()]]}),
    getHydraulicOverlayRecord:async()=>({url:state.url}),
    ensureOverlayBounds:async()=>{ctx.floodLatLngBounds=state.bounds;ctx.floodOverlayGeometryMode=state.geometryMode;},
    getConfiguredWorldFileCornersLatLng:()=>state.corners?.map(point=>({...point}))||null,
    getWorldFileRasterSize:()=>({...state.pixels}),
    preloadImage:async()=>{counts.preloads++;return typeof state.preload==='function'?state.preload():state.preload?state.url:null;},
    throwIfExportCancelled:()=>{if(state.cancelled)throw Object.assign(Error('Export cancelled'),{name:'AbortError'});},
    createHydraulicImageOverlay:(url,options)=>make(url,ctx.floodLatLngBounds,options,'hydraulic'),
    L:{imageOverlay:(url,extent,options)=>make(url,extent,options,'physics'),latLngBounds:(sw,ne)=>bounds(sw[0],sw[1],ne[0],ne[1])},
    setTimeout:(callback,delay)=>{assert.equal(delay,20000);const id=++timerId;timers.set(id,callback);return id;},
    clearTimeout:id=>timers.delete(id),
    setInterval:(callback,delay)=>{assert.equal(delay,100);const id=++timerId;intervals.set(id,callback);return id;},
    clearInterval:id=>intervals.delete(id),
  });
  return{ctx,state,counts,layers,map,bounds,timers,intervals};
}

for(const affine of [false,true]) {
  const h=floodFrameHarness({affine});await h.ctx.setExportFloodLayer('depth',5);
  const layer=h.ctx.exportFloodLayer,image=layer.getElement();assert.equal(layer._nwwExportFloodReady,true);
  h.ctx.overlayOpacity=.42;
  await h.ctx.setExportFloodLayer('depth',5);
  assert.equal(h.ctx.exportFloodLayer,layer);assert.equal(layer.getElement(),image);
  assert.equal(layer.options.opacity,.42);assert.equal(h.counts.created,1);assert.equal(h.counts.preloads,1);assert.equal(h.counts.adds,1);
  h.map.removeLayer(layer);
  await h.ctx.setExportFloodLayer('depth',5);
  assert.equal(h.ctx.exportFloodLayer,layer);assert.equal(layer.getElement(),image);assert.equal(h.map.hasLayer(layer),true);
  assert.equal(h.counts.created,1);assert.equal(h.counts.preloads,1);assert.equal(h.counts.adds,2);
  h.state.url='https://example.test/mapper/flood.webp';
  await h.ctx.setExportFloodLayer('depth',5);
  assert.equal(h.ctx.exportFloodLayer,layer,'Relative and absolute spellings of the same resolved URL share the decoded image');
  assert.equal(h.counts.created,1);
  assert.equal(h.timers.size+h.intervals.size+layer.handlers.size,0);
}

for(const mutation of ['source','bounds','corners','pixels','geometry-mode','geometry-kind','class','physics-kind','overlay-mode',
  'native-source','native-bounds','native-corners','native-pixels','native-class','native-pane','native-map','native-affine','owner','pending-image','error-image','unverified-layer']) {
  const h=floodFrameHarness({affine:!['bounds','physics-kind'].includes(mutation)});
  await h.ctx.setExportFloodLayer('depth',5);const original=h.ctx.exportFloodLayer;
  let mode='depth';
  if(mutation==='source')h.state.url='next.webp';
  if(mutation==='bounds')h.state.bounds=h.bounds(38,-75,40,-74);
  if(mutation==='corners')h.state.corners[0].lat+=.01;
  if(mutation==='pixels')h.state.pixels.width+=1;
  if(mutation==='geometry-mode')h.state.geometryMode='axis-aligned';
  if(mutation==='geometry-kind')h.state.corners=null;
  if(mutation==='class')h.ctx.currentDataMode='return-interval';
  if(mutation==='physics-kind')h.state.physics=true;
  if(mutation==='overlay-mode')mode='dynamic';
  if(mutation==='native-source')original._url='external.webp';
  if(mutation==='native-bounds')original.bounds=h.bounds(38,-75,40,-74);
  if(mutation==='native-corners')original._worldFileCorners[0].lat+=.01;
  if(mutation==='native-pixels')original._pixelHeight+=1;
  if(mutation==='native-class')original.options.className='external-class';
  if(mutation==='native-pane')original.options.pane='differentPane';
  if(mutation==='native-map')original._map={};
  if(mutation==='native-affine')original._worldFileAffine=false;
  if(mutation==='owner')original._nwwExportFloodOwner={};
  if(mutation==='pending-image'){original.image.complete=false;original.image.naturalWidth=0;}
  if(mutation==='error-image')original.image.naturalWidth=0;
  if(mutation==='unverified-layer')original._nwwExportFloodReady=false;
  await h.ctx.setExportFloodLayer(mode,5);
  assert.notEqual(h.ctx.exportFloodLayer,original,`${mutation} must load its actual image instead of reusing stale frame state`);
  assert.equal(h.counts.created,2);assert.equal(h.counts.preloads,2);
}

// Physics frames remain axis aligned even where the hydraulic catalog has an
// affine grid, and two physics URLs/bounds must not alias one another.
{
  const h=floodFrameHarness();h.state.physics=true;
  await h.ctx.setExportFloodLayer('depth',5);const original=h.ctx.exportFloodLayer;
  assert.equal(original._worldFileAffine,false);await h.ctx.setExportFloodLayer('depth',5);assert.equal(h.ctx.exportFloodLayer,original);
  h.state.bounds=h.bounds(38,-75,40,-74);await h.ctx.setExportFloodLayer('depth',5);assert.notEqual(h.ctx.exportFloodLayer,original);
}
for(const url of ['blob:https://example.test/same-frame','data:image/png;base64,same-frame']) {
  const h=floodFrameHarness({url});await h.ctx.setExportFloodLayer('depth',5);const original=h.ctx.exportFloodLayer;
  await h.ctx.setExportFloodLayer('depth',5);assert.equal(h.ctx.exportFloodLayer,original);assert.equal(h.counts.created,1);
}

for(const failure of ['timeout','cancel','error','invalid-load']) {
  const h=floodFrameHarness();h.state.outcome=['timeout','cancel'].includes(failure)?'pending':failure;
  const pending=h.ctx.setExportFloodLayer('depth',5);
  const rejected=assert.rejects(pending,failure==='cancel'?/cancelled/:/flood image could not load/);
  await new Promise(resolve=>setImmediate(resolve));
  if(failure==='timeout'){assert.equal(h.timers.size,1);[...h.timers.values()][0]();}
  if(failure==='cancel'){h.state.cancelled=true;[...h.intervals.values()][0]();}
  await rejected;
  const failed=h.ctx.exportFloodLayer;assert.equal(failed._nwwExportFloodReady,false);
  assert.equal(h.timers.size+h.intervals.size+failed.handlers.size,0,'New-frame failures clean deadline/cancel timers and listeners');
  h.state.cancelled=false;h.state.outcome='cached';
  await h.ctx.setExportFloodLayer('depth',5);assert.notEqual(h.ctx.exportFloodLayer,failed);assert.equal(h.counts.created,2);
}
{
  const h=floodFrameHarness();await h.ctx.setExportFloodLayer('depth',5);const original=h.ctx.exportFloodLayer;
  h.state.cancelled=true;
  await assert.rejects(h.ctx.setExportFloodLayer('depth',5),/cancelled/);
  assert.equal(h.ctx.exportFloodLayer,original);assert.equal(h.counts.created,1);assert.equal(h.counts.preloads,1);
}
{
  const h=floodFrameHarness();await h.ctx.setExportFloodLayer('depth',5);const original=h.ctx.exportFloodLayer;
  h.state.url='unavailable-next-frame.webp';h.state.preload=false;
  await assert.rejects(h.ctx.setExportFloodLayer('depth',5),/flood image could not load/);
  assert.equal(h.ctx.exportFloodLayer,original);assert.equal(h.map.hasLayer(original),true);
  assert.equal(original._nwwExportFloodReady,true,'A failed new source must retain the prior complete export frame');
  h.state.url='flood.webp';h.state.preload=true;
  await h.ctx.setExportFloodLayer('depth',5);assert.equal(h.ctx.exportFloodLayer,original);
  assert.equal(h.counts.created,1);assert.equal(h.counts.preloads,2,'Returning to the retained ready frame bypasses another preload');
}
{
  const h=floodFrameHarness();let release;
  h.state.preload=()=>new Promise(resolve=>{release=resolve;});
  const pending=h.ctx.setExportFloodLayer('depth',5);await new Promise(resolve=>setImmediate(resolve));
  h.state.cancelled=true;release('flood.webp');await assert.rejects(pending,/cancelled/);
  assert.equal(h.counts.created,0,'Cancel during shared preload cannot install a fresh image');
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
  gifWorkerUrlPromise:null, gifWorkerLoadRequest:null, AbortController, GIF_WORKER_URL:'worker.js',
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

// A tile can finish during the final polling interval. Read its native state
// once at the deadline, with no additional wait, before reporting an error.
function rasterDeadlineFixture(onWait = noop) {
  let now = 0, cancelled = false, paints = 0;
  const waits = [];
  const image = {tagName:'IMG',complete:false,naturalWidth:0,naturalHeight:0};
  const container = {isConnected:true,querySelectorAll:()=>[image]};
  const map = {hasLayer:()=>true};
  const record = {el:image,current:true,loaded:0,active:false,coords:{x:9575,y:12522,z:15}};
  const layer = {_leaflet_id:7,_url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    _map:map,_tileZoom:15,_tiles:{tile:record},getContainer:()=>container,
    isLoading:()=>!image.complete};
  const ctx = context('waitForExportRasterLayerReady', {
    Date:{now:()=>now},exportMap:map,
    throwIfExportCancelled:()=>{if(cancelled)throw Object.assign(Error('cancelled'),{name:'AbortError'});},
    requestAnimationFrame:fn=>{paints++;fn();},
    wait:async delay=>{waits.push(delay);now+=delay;onWait(image,()=>{cancelled=true;});},
  });
  return {ctx,layer,image,record,container,waits,paints:()=>paints};
}
{
  const f=rasterDeadlineFixture(image=>{image.complete=true;image.naturalWidth=256;image.naturalHeight=256;});
  await f.ctx.waitForExportRasterLayerReady(f.layer,100);
  assert.deepEqual(f.waits,[100],'The last readiness check must add no grace period');
  assert.equal(f.paints(),2,'Use the same two-paint success path');
}
{
  const f=rasterDeadlineFixture();let failure;
  await assert.rejects(f.ctx.waitForExportRasterLayerReady(f.layer,100),error=>{
    failure=error;return error.message==='The map background is still loading. Please try the export again.';
  });
  const snapshot=failure.exportRasterReadiness;
  assert.equal(snapshot.schemaVersion,1);assert.equal(snapshot.reason,'deadline');assert.equal(snapshot.observedAt,100);
  assert.equal(snapshot.layer.url,f.layer._url);assert.equal(snapshot.layer.layerId,7);
  assert.equal(snapshot.layer.mapContains,true);assert.equal(snapshot.layer.ownsMap,true);
  assert.equal(snapshot.layer.containerAttached,true);assert.equal(snapshot.layer.isLoading,true);
  assert.equal(snapshot.layer.native.count,1);assert.equal(snapshot.layer.native.complete,0);
  assert.equal(snapshot.layer.native.pending,1);assert.equal(snapshot.layer.native.failed,0);
  assert.equal(snapshot.layer.tracked.count,1);assert.equal(snapshot.layer.tracked.current,1);
  assert.equal(snapshot.layer.tracked.tiles[0].coords.z,snapshot.layer.tileZoom);
  assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.layer.native.tiles)&&Object.isFrozen(snapshot.layer.tracked.tiles[0].coords));
  const serialized=JSON.stringify(snapshot);
  f.image.complete=true;f.image.naturalWidth=512;f.record.coords.z=16;f.container.isConnected=false;f.layer._url='changed';
  assert.equal(JSON.stringify(snapshot),serialized,'Later native/provider changes cannot rewrite the original deadline evidence');
  assert.deepEqual(f.waits,[100]);assert.equal(f.paints(),0);
}
{
  const f=rasterDeadlineFixture();f.image.complete=true;
  await assert.rejects(f.ctx.waitForExportRasterLayerReady(f.layer,100),/A map tile could not load/);
  assert.deepEqual(f.waits,[],'Known failed images must retain their existing immediate failure path');
}
{
  const f=rasterDeadlineFixture(image=>{image.complete=true;});
  await assert.rejects(f.ctx.waitForExportRasterLayerReady(f.layer,100),error=>error.exportRasterReadiness?.layer.native.failed===1);
  assert.equal(f.paints(),0,'A failed image arriving at the deadline must not count as ready');
}
{
  const f=rasterDeadlineFixture((image,cancel)=>cancel());
  await assert.rejects(f.ctx.waitForExportRasterLayerReady(f.layer,100),error=>error.name==='AbortError'&&!error.exportRasterReadiness);
  assert.equal(f.paints(),0,'Cancellation must win at the deadline too');
}
{
  const f=rasterDeadlineFixture();Object.defineProperty(f.layer,'_tiles',{get(){throw Error('diagnostic unavailable');}});
  await assert.rejects(f.ctx.waitForExportRasterLayerReady(f.layer,100),error=>
    error.message==='The map background is still loading. Please try the export again.'&&!error.exportRasterReadiness);
}

// A retry reuses the attached layer/options and exact camera, including its
// position among same-pane peers. Removed optional layers cannot be revived.
{
  const calls=[],options={pane:'roadsPane',opacity:0.98,tileSize:512,zoomOffset:-1};
  const before={},after={};
  const pane={children:[],insertBefore(node,sibling){
    this.children=this.children.filter(child=>child!==node);
    const index=sibling?this.children.indexOf(sibling):this.children.length;
    this.children.splice(index,0,node);node.parentNode=this;
  }};
  let container={parentNode:pane,nextSibling:after};pane.children=[before,container,after];after.parentNode=pane;
  const layer={options,getContainer:()=>container};
  const camera={zoom:14.743299527888258,center:{lat:39.005,lng:-74.8}};
  let attached=true;
  const map={
    hasLayer:candidate=>candidate===layer&&attached,
    removeLayer(candidate){assert.equal(candidate,layer);calls.push('remove');attached=false;pane.children=pane.children.filter(child=>child!==container);container.parentNode=null;},
    addLayer(candidate){assert.equal(candidate,layer);calls.push('add');attached=true;layer.tileZoom=Math.round(camera.zoom);container={parentNode:pane};pane.children.push(container);},
  };
  const ctx=context('retryExportRasterLayerTiles',{exportMap:map});
  assert.equal(ctx.retryExportRasterLayerTiles(layer),true);
  assert.deepEqual(calls,['remove','add']);assert.deepEqual(pane.children,[before,container,after]);
  assert.equal(layer.options,options);assert.equal(layer.tileZoom,15);assert.equal(attached,true);
  assert.deepEqual(camera,{zoom:14.743299527888258,center:{lat:39.005,lng:-74.8}});
  attached=false;assert.equal(ctx.retryExportRasterLayerTiles(layer),false);
  assert.deepEqual(calls,['remove','add'],'An optional layer removed by a newer setting must stay removed');
}

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
  exportUsesScalableRoadLabels:()=>false,
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
const logoListeners = new Map();
const logo = {style:{display:''},classList:{contains:()=>true},decode:async()=>{},
  complete:true,naturalWidth:400,naturalHeight:100,currentSrc:'https://example.test/logo.jpg',
  addEventListener:(type,callback)=>logoListeners.set(type,callback),
  removeEventListener:(type,callback)=>{if(logoListeners.get(type)===callback)logoListeners.delete(type);},
  getAttribute:name=>name==='src'?logo.src:null,
};
let logoSrc='https://example.test/logo.jpg';
Object.defineProperty(logo,'src',{get:()=>logoSrc,set:value=>{
  logoSrc=value;logo.currentSrc=value;logo.complete=true;
  queueMicrotask(()=>logoListeners.get('load')?.());
}});
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
console.log('PASS export recovery: interrupted captures, fitted-camera road visibility, owned ready-frame/image reuse, affine/axis/source/physics/class identity, opacity and detached re-add, changed/pending/failed frame rejection, unchanged20s deadline and cancellation, missing images, vector/raster readiness, safe fallback, worker retry and inline logos.');
