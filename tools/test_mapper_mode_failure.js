'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
function extract(source,name){const start=[...source.matchAll(new RegExp('(?:async )?function '+name+'\\(','g'))].at(-1)?.index;assert(start!==undefined,name);for(let end=source.indexOf('}',start);end>=0;end=source.indexOf('}',end+1)){const f=source.slice(start,end+1);try{new vm.Script('('+f+')');return f;}catch{}}throw Error(name);}
function context(functions,options={}){
 const calls={clear:0,selection:0,timeline:0,loadedDay:0,toasts:[]},nodes={hourSlider:{value:'2'},stageSubText:{textContent:'old'}};
 const old=[{tag:'old',timeUtc:'2026-10-21T00:00:00Z',navd88StageFt:2}];
 const c={lastRenderToken:20,selectionGeneration:3,dataModeRequest:0,currentDataMode:options.initialMode||'forecast',currentViewType:options.initialView||'forecast',currentSeriesHours:old,currentRawSeriesHours:old,currentHourIndex:2,currentTopTideIndex:null,currentSelectedLabel:'old',currentSelectedSubLabel:'old',currentRangeLabel:'old',currentFloodLayer:options.noLayer?null:{id:'old'},observedArchiveReady:false,selectedObservedDate:options.noDates?null:'2026-10-20',
 document:{getElementById:id=>nodes[id],body:{dataset:{}}},stopPlayback(){},toast:x=>calls.toasts.push(x),cancelPendingFloodFrame:(invalidate=true)=>{if(invalidate)c.lastRenderToken++;return c.lastRenderToken;},updateDataModeButtons(){},renderTopTides(){},scheduleHistoricalTopTideWarmup(){},renderCalendar:async()=>{},getLatestObservedDate:()=>options.noDates?null:'2026-10-20',getBestObservedDate:()=>options.noDates?null:'2026-10-20',getForecastScenarioLabel:()=> 'Mean',renderHour:async()=>{},syncSliderBounds(){},clearFloodLayer(){calls.clear++;c.currentFloodLayer=null;},renderSelectionMeta(){calls.selection++;},renderTimelineMeta(){calls.timeline++;},reportFloodFrameFailure(){},setFloodFrameStatus(){},map:{hasLayer:layer=>!!layer&&layer===c.currentFloodLayer}};
 const ready=async()=>{
  if(options.fail){
   if(options.cancel||options.generationOnly||options.requestOnly){
    if(options.cancel)c.lastRenderToken++;
    if(options.cancel||options.generationOnly)c.selectionGeneration++;
    if(options.cancel||options.requestOnly)c.dataModeRequest++;
    c.currentSeriesHours=[{tag:'newer'}];c.currentRawSeriesHours=c.currentSeriesHours;
    c.currentDataMode=options.cancel?'forecast':'observed';
   }
   throw Error('observations offline');
  }
 };
 c.warmBackgroundData=ready;c.loadObserved=ready;
 c.loadForecast=async()=>{c.currentDataMode='forecast';c.currentViewType='forecast';c.currentSeriesHours=[{tag:'forecast'}];c.currentRawSeriesHours=c.currentSeriesHours;};
 c.loadReturnInterval=async()=>{c.currentDataMode='return-interval';c.currentViewType='return-interval';c.currentSeriesHours=[{tag:'modeled'}];c.currentRawSeriesHours=c.currentSeriesHours;};
 c.loadObservedDay=async()=>{calls.loadedDay++;c.currentDataMode='observed';c.currentViewType='observed-day';c.currentSeriesHours=[{tag:'observed'}];c.currentRawSeriesHours=c.currentSeriesHours;};
 vm.createContext(c);vm.runInContext(functions.modeHandler+'\nthis.runMode='+functions.modeHandler.match(/function (\w+)/)[1]+';',c);
 return {c,calls,nodes,old};
}
async function runModeFunctions(functions,originalFunctions){
 let checks=0;
 for(const mode of ['forecast','observed']){
  const options=mode==='forecast'?{initialMode:'observed',initialView:'observed-day'}:{};
  const after=context(functions,options);await after.c.runMode(mode);
  assert.equal(after.c.currentDataMode,mode);assert.equal(after.calls.clear,0);assert.equal(after.c.currentSeriesHours[0].tag,mode==='forecast'?'forecast':'observed');
  if(originalFunctions){const before=context(originalFunctions,options);await before.c.runMode(mode);for(const key of ['currentDataMode','currentViewType','currentHourIndex','currentSelectedLabel','currentSelectedSubLabel','currentRangeLabel'])assert.equal(after.c[key],before.c[key]);assert.deepStrictEqual(JSON.parse(JSON.stringify(after.c.currentSeriesHours)),JSON.parse(JSON.stringify(before.c.currentSeriesHours)));assert.equal(after.calls.loadedDay,before.calls.loadedDay);}
  checks++;
 }
 const avalon=functions.modeHandler.includes('modeFailurePrevious');
 const failed=context(functions,{fail:true});await failed.c.runMode('observed');
 if(avalon){assert.equal(failed.c.currentDataMode,'forecast');assert.equal(failed.c.currentSeriesHours,failed.old);assert.equal(failed.calls.clear,0);assert(failed.calls.toasts.some(x=>x.includes('forecast is still available')));}
 else{assert.equal(failed.c.currentDataMode,'observed');assert.equal(failed.c.currentSeriesHours.length,0);assert.equal(failed.calls.clear,1);assert.equal(failed.nodes.stageSubText.textContent,'Observed data could not load');}
 checks++;
 const stale=context(functions,{fail:true,cancel:true});await stale.c.runMode('observed');assert.equal(stale.c.currentSeriesHours[0].tag,'newer');assert.equal(stale.calls.clear,0);checks++;
 const noDates=context(functions,{noDates:true});await noDates.c.runMode('observed');assert.equal(noDates.c.currentSeriesHours.length,0);assert.equal(noDates.calls.clear,1);checks++;
 if(functions.modeHandler.includes('const generation = ++selectionGeneration;')){const generation=context(functions,{fail:true,generationOnly:true});await generation.c.runMode('observed');assert.equal(generation.c.currentSeriesHours[0].tag,'newer');assert.equal(generation.calls.clear,0);checks++;}
 if(avalon){
  const wrongSource=context(functions,{fail:true,initialMode:'observed',initialView:'top-tide'});await wrongSource.c.runMode('observed');assert.equal(wrongSource.c.currentDataMode,'observed');assert.equal(wrongSource.c.currentSeriesHours.length,0);assert.equal(wrongSource.calls.clear,1);checks++;
  const request=context(functions,{fail:true,requestOnly:true});await request.c.runMode('observed');assert.equal(request.c.currentSeriesHours[0].tag,'newer');assert.equal(request.calls.clear,0);checks++;
 }
 // The actual per-day source handler must reject absent days without reusing
 // the previous forecast. Modern handlers also own their archive-fetch token.
 function dayContext(options={}){
  const x=context(functions);x.c.getObservedDayRecord=()=>null;
  x.c.ensureObservedArchiveForDate=async()=>{
   if(options.cancel){x.c.lastRenderToken++;x.c.selectionGeneration++;x.c.currentSeriesHours=[{tag:'newer'}];x.c.currentRawSeriesHours=x.c.currentSeriesHours;}
   if(options.fail||options.cancel)throw Error('day archive offline');
  };
  vm.runInContext(functions.loadObservedDay,x.c);return x;
 }
 const absent=dayContext();await absent.c.loadObservedDay('2026-10-20');assert.equal(absent.c.currentDataMode,'observed');assert.equal(absent.c.currentSeriesHours.length,0);assert.equal(absent.calls.clear,1);checks++;
 if(functions.loadObservedDay.includes('await ensureObservedArchiveForDate(dateStr);')){
  const dayFailed=dayContext({fail:true});await dayFailed.c.loadObservedDay('2026-10-20');assert.equal(dayFailed.c.currentSeriesHours.length,0);assert.equal(dayFailed.calls.clear,1);checks++;
  const dayStale=dayContext({cancel:true});await dayStale.c.loadObservedDay('2026-10-20');assert.equal(dayStale.c.currentSeriesHours[0].tag,'newer');assert.equal(dayStale.calls.clear,0);checks++;
 }
 // A synchronous missing legacy day still supersedes a pending forecast.
 // Both that forecast's success and failure must leave Observed unavailable.
 for(const settlement of ['reject','resolve']){
  const later=context(functions);let resolveFetch,rejectFetch;
  const pendingFetch=new Promise((resolve,reject)=>{resolveFetch=resolve;rejectFetch=reject;});
  Object.assign(later.c,{FORECAST_URL:'forecast.json',forecastData:null,fetchJson:()=>pendingFetch,
   withFreshJsonUrl:x=>x,getObservedDayRecord:()=>null,ensureObservedArchiveForDate:async()=>{}});
  vm.runInContext(functions.loadForecast+'\n'+functions.loadObservedDay,later.c);
  const startingToken=later.c.lastRenderToken,pending=later.c.loadForecast();
  await later.c.loadObservedDay('2026-10-20');
  assert(later.c.lastRenderToken>startingToken,'missing day must supersede the old forecast request');
  assert.equal(later.calls.clear,1);assert.equal(later.nodes.stageSubText.textContent,'Observed data could not load');
  if(settlement==='reject')rejectFetch(Error('older forecast offline'));else resolveFetch({hours:[]});
  await pending;
  assert.equal(later.c.currentDataMode,'observed');assert.equal(later.c.currentViewType,'observed-day');
  assert.equal(later.c.currentSeriesHours.length,0);assert.equal(later.nodes.stageSubText.textContent,'Observed data could not load');assert.equal(later.calls.clear,1,'old forecast must not clear or relabel the missing day');checks++;
 }
 return {passed:true,mode_and_archive_cases:checks,avalon_safe_forecast_rollback:avalon,modern_archive_fetch:functions.loadObservedDay.includes('await ensureObservedArchiveForDate(dateStr);')};
}
module.exports={runModeFunctions,extract};
if(require.main===module){const file=process.argv[2]||'index.html',source=fs.readFileSync(file,'utf8'),handler=source.includes('async function switchDataModeNow(mode)')?'switchDataModeNow':'switchDataMode';runModeFunctions({modeHandler:extract(source,handler),loadObservedDay:extract(source,'loadObservedDay'),loadForecast:extract(source,'loadForecast')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});}
