// Exercise the shipped renderer with failed loads, decoding stalls and request races.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const extract=name=>html.match(new RegExp('^    (?:async )?function '+name+'\\([\\s\\S]+?\\n    }','m'))?.[0];
const native=html.includes('displayedFloodFrame = { entry, series, stage: rawStage');
const physics=Boolean(extract('setPhysicsFloodLayer'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture({initial=true,usePhysics=false}={}){
 const plans=new Map(),images=new Map(),decodes=new Map(),layers=new Set(),nodes=new Map(),labels=[0],classes=new Set();
 let stopped=0,failed=0,leases=0;
 const timer=(fn,ms)=>setTimeout(fn,ms>=20000?40:ms===250?5:ms);
 class FakeImage{
  constructor(){this.complete=false;this.naturalWidth=0;this.style={opacity:'0'};}
  set src(url){this._src=url;if(!url){this.complete=false;this.naturalWidth=0;return;}const p=plans.get(url)||{};const call=(images.get(url)||0)+1;images.set(url,call);if(p.hangLoad)return;timer(()=>{if(this._src!==url)return;if(p.fail||p.failLoads?.includes(call)){this.onerror?.();return;}this.complete=true;this.naturalWidth=128;this.onload?.();},p.ms??1);}
  get src(){return this._src;}
  async decode(){const p=plans.get(this._src)||{},call=(decodes.get(this._src)||0)+1;decodes.set(this._src,call);if(p.hangDecode)await new Promise(()=>{});await sleep(p.decodeMs??1);if(p.decodeFail||p.failDecodes?.includes(call))throw Error('injected decode failure');this.decoded=true;}
 }
 class Layer{
  constructor(url,options={}){this._url=url;this.events=new Map();this._image=new FakeImage();this._image.style.opacity=String(options.opacity??0);}
  once(type,fn){return this.on(type,fn,true);}
  on(type,fn,once=false){const list=this.events.get(type)||[];list.push({fn,once});this.events.set(type,list);return this;}
  off(type,fn){this.events.set(type,(this.events.get(type)||[]).filter(e=>e.fn!==fn));return this;}
  fire(type){for(const e of [...(this.events.get(type)||[])]){if(e.once)this.off(type,e.fn);e.fn();}return this;}
  addTo(){layers.add(this);this._image.onload=()=>this.fire('load');this._image.onerror=()=>this.fire('error');this._image.src=this._url;return this;}
  getElement(){return this._image;}
  setOpacity(n){this._image.style.opacity=String(n);return this;}
 }
 const map={hasLayer:l=>layers.has(l),removeLayer(l){layers.delete(l);l.fire('remove');},fitBounds(){},setZoom(){},getZoom:()=>12,getMaxZoom:()=>22};
 const old=new Layer('old',{opacity:.75});old._image.complete=true;old._image.naturalWidth=128;old._image.decoded=true;if(initial)layers.add(old);
 const series=[{stage:0},{stage:1},{stage:2},{stage:null}];
 const ctx=vm.createContext({console:{warn(){},error:console.error,log:console.log},Image:FakeImage,setTimeout:timer,clearTimeout,setInterval,clearInterval,requestAnimationFrame:cb=>timer(()=>cb(performance.now()),1),performance,
  window:{setTimeout:timer,clearTimeout,setInterval,clearInterval},document:{body:{dataset:{initialFloodFrame:'ready'},classList:{contains:n=>classes.has(n),toggle(n,on){if(on)classes.add(n);else classes.delete(n);}}},getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'0',textContent:'',style:{},setAttribute(){},classList:{contains:()=>false,toggle(){}}});return nodes.get(id);}},
  currentSeriesHours:series,currentRawSeriesHours:series,currentHourIndex:0,lastRenderToken:0,currentFloodLayer:initial?old:null,pendingFloodLayer:null,renderedFloodPixelCache:null,preloadPromiseCache:new Map(),exportCancelRequested:false,exportInProgress:false,
  displayedFloodFrame:initial?{entry:series[0],series,stage:0}:null,floodRenderBusy:false,map,mapHasFit:true,floodLatLngBounds:[[0,0],[1,1]],floodOverlayGeometryMode:'axis-aligned',overlayOpacity:.75,floodFrameState:'ready',currentDataMode:'forecast',currentOverlayMode:'depth',
  L:{imageOverlay:(url,bounds,options)=>new Layer(url,options),latLngBounds:(...b)=>b},createHydraulicImageOverlay:(url,options)=>new Layer(url,options),getStageValue:e=>e.stage,getOverlayStage:s=>s,getHydraulicPhaseForEntry:()=> 'rising',getPhysicsAssetForEntry:e=>usePhysics&&e.stage!=null?{url:'frame-'+e.stage}:null,getPhysicsDisplayRecord:a=>a,getActivePhysicsManifest:()=>({boundsWgs84:[[0,0],[1,1]]}),
  getOverlayRecord:async(mode,stage)=>({url:'frame-'+stage,filename:'frame-'+stage}),getHydraulicOverlayRecord:async(mode,stage)=>({url:'frame-'+stage,filename:'frame-'+stage}),
  disposeFloodLayer(layer){if(!layer)return;if(map.hasLayer(layer))map.removeLayer(layer);layer.getElement().src='';},retainRasterObjectUrl(){leases++;return ()=>leases--;},scheduleRasterObjectUrlCleanup(){},cancelTimelineSelection(){},toast(){},ensureMap(){},ensureOverlayBounds:async()=>{},markInitialFloodFrameReady(){},markInitialFloodFrameFailed(){failed++;},setFloodFrameStatus(){},updatePersistentDepthQueryPopup(){},getBoundaryDrivenOverlayBounds:()=>null,fitConfiguredInitialMapView(){},
  renderSelectionMeta(e){labels.push(e.stage);},renderTimelineMeta(){},updateNsiStructureImpactLayer(){},updateSliderProgress(){},hasDisplayedLongGaugeOutage:()=>false,GAUGE_OUTAGE_THRESHOLD_HOURS:72,renderLegend(){},buildNotes:()=>'',scheduleOverlayCatalogWarmup(){},preloadAroundHour(){},stopPlayback(){stopped++;},formatHourEntryTime:e=>String(e.stage),formatStageForDisplay:String});
 for(const name of ['normalizeStageValue','decodeFloodFrameImage','preloadImage','clearFloodLayer','waitForFloodOverlayLoad','renderFloodFrameWithRetry','reportFloodFrameFailure','waitForRecoveryFloodLayer','setFloodLayer','setPhysicsFloodLayer','renderHour'])if(extract(name))new vm.Script(extract(name)).runInContext(ctx);
 return {ctx,plans,images,decodes,layers,labels,old,nodes,stopped:()=>stopped,failed:()=>failed,leases:()=>leases};
}
const checks=[];
function retained(f){assert.equal(f.ctx.currentFloodLayer,f.old,'last good frame removed');assert(f.layers.has(f.old),'last good layer detached');assert.equal(f.labels.at(-1),0,'timestamp advanced without a frame');assert.equal(f.ctx.currentHourIndex,0,'selected hour advanced without a frame');assert.equal(f.ctx.pendingFloodLayer,null,'failed layer left pending');assert(f.stopped()>0,'playback continued after permanent failure');assert.equal(f.leases(),0,'object URL lease leaked');}
for(const usePhysics of physics?[false,true]:[false]){
 const label=usePhysics?'physics':'raster';
 let f=fixture({usePhysics});f.plans.set('frame-1',{ms:8,decodeMs:8});const normal=f.ctx.renderHour(1);await sleep(3);assert.equal(f.ctx.currentFloodLayer,f.old);assert.equal(f.labels.at(-1),0);assert.equal(f.ctx.currentHourIndex,0);await normal;assert.equal(f.ctx.currentFloodLayer._url,'frame-1');assert.equal(f.labels.at(-1),1);assert.equal(f.ctx.currentHourIndex,1);assert.equal(f.leases(),0);
 for(const plan of [{failLoads:[1]},{failDecodes:[native?1:2]},{failDecodes:[1]}]){f=fixture({usePhysics});f.plans.set('frame-1',plan);await f.ctx.renderHour(1);assert.equal(f.ctx.currentFloodLayer._url,'frame-1','transient failure did not recover');assert.equal(f.labels.at(-1),1);assert.equal(f.ctx.currentHourIndex,1);assert.equal(f.leases(),0);}
 for(const plan of [{fail:true},{decodeFail:true},{hangLoad:true},{hangDecode:true}]){f=fixture({usePhysics});f.plans.set('frame-1',plan);await f.ctx.renderHour(1);retained(f);}
 f=fixture({usePhysics});f.plans.set('frame-1',{failLoads:[1]});const stale=f.ctx.renderHour(1);await sleep(2);const latest=f.ctx.renderHour(2);await Promise.all([stale,latest]);assert.equal(f.ctx.currentFloodLayer._url,'frame-2','stale retry replaced latest frame');assert.equal(f.labels.at(-1),2);assert.equal(f.ctx.currentHourIndex,2);assert.equal(f.stopped(),0,'stale failure stopped current selection');
 f=fixture({initial:false,usePhysics});f.plans.set('frame-1',{fail:true});await f.ctx.renderHour(1);assert.equal(f.ctx.currentFloodLayer,null);assert.equal(f.ctx.pendingFloodLayer,null);assert.equal(f.ctx.document.body.dataset.floodFrame,'failed');assert(f.failed()>0,'initial load failure not reported');
 checks.push(label+': normal load, transient decode/network recovery, repeated failures, stalled load/decode, latest request wins, initial failure, lease cleanup');
}
let f=fixture();await f.ctx.renderHour(3);assert.equal(f.ctx.currentFloodLayer,null,'no-data selection retained misleading flood pixels');assert.equal(f.labels.at(-1),null);
f=fixture();f.plans.set('frame-1',{ms:15});const stale=f.ctx.renderHour(1);await sleep(2);await f.ctx.renderHour(3);await stale;assert.equal(f.ctx.currentFloodLayer,null);assert.equal(f.labels.at(-1),null,'stale frame replaced no-data selection');
f=fixture();f.ctx.getHydraulicOverlayRecord=async()=>{throw Error('injected source failure');};f.ctx.getOverlayRecord=f.ctx.getHydraulicOverlayRecord;await f.ctx.renderHour(1);retained(f);
checks.push('no-data clearing, stale completion after no-data, source failure retention');
console.log(JSON.stringify({passed:true,nativeFrameRetention:native,physics,checks}));
