'use strict';
// Run: node tests/test_mapper_data_guard.js [index.html]
const fs=require('fs'),vm=require('vm'),assert=require('assert');
function extract(source,name){const m=source.match(new RegExp('(async )?function '+name+'\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}'));assert(m,'Missing '+name);return m[0];}
function reader(functions,adjustment){const c={STAGE_ADJUSTMENT_FT:adjustment};vm.createContext(c);vm.runInContext(['normalizeStageValue','getRawStageValue','getStageValue'].map(n=>functions[n]).join('\n')+'\nthis.readStage=getStageValue; this.normalize=normalizeStageValue;',c);return c;}
const fixtures=[
 ['genuine zero',{navd88StageFt:0},0],['negative water',{navd88StageFt:-2.25},-2.25],['numeric string',{navd88StageFt:' 2.25 '},2.25],
 ['null',{navd88StageFt:null},null],['absent',{},null],['empty',{navd88StageFt:''},null],['spaces',{navd88StageFt:'  \t'},null],
 ['false',{navd88StageFt:false},null],['true',{navd88StageFt:true},null],['empty array',{navd88StageFt:[]},null],['one array',{navd88StageFt:[2.2]},null],['plain object',{navd88StageFt:{}},null],['value object',{navd88StageFt:{valueOf:()=>3}},null],
 ['NaN',{navd88StageFt:NaN},null],['positive infinity',{navd88StageFt:Infinity},null],['negative infinity',{navd88StageFt:-Infinity},null],
 ['malformed primary keeps real fallback',{navd88StageFt:' ',stageFt:-0.5},-0.5],['boolean primary keeps real fallback',{navd88StageFt:false,stageFt:2.1},2.1],
 ['missing canonical never reads MLLW',{navd88StageFt:null,mllwStageFt:4.33},null],['missing canonical never reads MHHW',{navd88StageFt:null,waterLevelMHHW:1.3},null],
 ['missing canonical never reads MSL',{navd88StageFt:null,MSLHeight:1.3},null],['canonical wins over MLLW',{navd88StageFt:2.2,mllwStageFt:4.33},2.2],
 ['supported generic numeric',{localWaterLevelHeight:'3.25'},3.25],['generic false metadata',{waterLevelEstimated:false},null],['generic true metadata',{waterLevelEstimated:true},null],['generic blank',{localWaterLevelHeight:' '},null]
];
function loader(functionText,hours,options={}){
 const calls={clear:0,selection:0,timeline:0,toasts:[]};const elements={hourSlider:{value:'old',max:'10'},stageSubText:{textContent:'old'}};
 const c={lastRenderToken:7,forecastData:null,selectionGeneration:0,physicsForecastManifests:{},console,currentRawSeriesHours:[{old:true}],currentSeriesHours:[{old:true}],currentHourIndex:9,currentViewType:'forecast',currentTopTideIndex:1,currentSelectedLabel:'Mean',currentSelectedSubLabel:'Mean',currentRangeLabel:'old',FORECAST_URL:'forecast.json',
 document:{getElementById:id=>elements[id]},fetchJson:async()=>{if(options.cancel)c.lastRenderToken++;if(options.cancelGeneration)c.selectionGeneration++;if(options.fail)throw Error('network offline');return {scenarioForecasts:{highEnd:{hours}}};},withFreshJsonUrl:x=>x,clearExportAvailabilityCache:()=>{},getActiveForecastHours:()=>c.forecastData.scenarioForecasts.highEnd.hours,
 updateForecastScenarioButtons:()=>{},normalizeConfiguredDataset:x=>x,loadPhysicsForecast:async()=>{},getPhysicsForecastDisplaySeries:()=>null,buildForecastCanonicalSeries:x=>x.slice(),buildForecastDisplaySeries:x=>x.slice(),getTimelineIntervalMinutes:()=>60,annotateHydraulicSeries:x=>x.slice(),getForecastScenarioLabel:()=> 'Upper end',getForecastScenarioPercentileLabel:()=> '90th percentile',formatHourEntryTime:x=>x.timeUtc,
 syncSliderBounds:()=>{elements.hourSlider.max=String(Math.max(0,c.currentSeriesHours.length-1));},findClosestEntryIndex:()=>1,getPeakHourIndex:x=>Math.max(0,x.length-1),sameEntryESTDay:()=>false,
 clearFloodLayer:()=>{calls.clear++;},renderSelectionMeta:(...args)=>{calls.selection++;assert.deepStrictEqual(args,[null,null,null]);},renderTimelineMeta:()=>{calls.timeline++;},toast:x=>calls.toasts.push(x)};
 vm.createContext(c);vm.runInContext(functionText+'\nthis.run=loadForecast;',c);
 return {c,calls,elements,run:()=>c.run()};
}
async function runFunctions(functions,adjustment=0){
 const c=reader(functions,adjustment);
 for(const [label,input,expected]of fixtures)assert.strictEqual(c.readStage(input),expected===null?null:expected+adjustment,label);
 for(const bad of [null,undefined,' ',false,true,[],{},NaN,Infinity])assert.strictEqual(c.normalize(bad),null,'normalizer rejects invalid primitives');
 const hours=[{timeUtc:'2026-10-21T12:00:00Z',navd88StageFt:0},{timeUtc:'2026-10-21T13:00:00Z',navd88StageFt:2.2},{timeUtc:'2026-10-21T14:00:00Z',navd88StageFt:3.4}];
 const normal=loader(functions.loadForecast,hours);await normal.run();assert.strictEqual(normal.calls.clear,0);assert.strictEqual(normal.calls.selection,0);assert.strictEqual(normal.c.currentSeriesHours.length,3);assert.strictEqual(normal.elements.hourSlider.value,'2');
 const empty=loader(functions.loadForecast,[]);assert.strictEqual(await empty.run(),false);assert.strictEqual(empty.calls.clear,1,'empty selection must clear previous scenario image');assert.strictEqual(empty.calls.selection,1);assert.strictEqual(empty.calls.timeline,1);assert.strictEqual(empty.elements.hourSlider.value,'0');assert.strictEqual(empty.elements.stageSubText.textContent,'No forecast available for this selection');
 const canceled=loader(functions.loadForecast,[],{cancel:true});assert.strictEqual(await canceled.run(),false);assert.strictEqual(canceled.calls.clear,0,'canceled fetch may not clear newer selection');
 const failed=loader(functions.loadForecast,hours,{fail:true});assert.strictEqual(await failed.run(),false);assert.strictEqual(failed.calls.clear,1,'current network failure clears previous source');assert.strictEqual(failed.c.forecastData,null);assert.strictEqual(failed.c.currentSeriesHours.length,0);assert.strictEqual(failed.elements.stageSubText.textContent,'Forecast could not load');assert.strictEqual(failed.calls.timeline,1);
 const failedCanceled=loader(functions.loadForecast,hours,{fail:true,cancel:true});assert.strictEqual(await failedCanceled.run(),false);assert.strictEqual(failedCanceled.calls.clear,0,'canceled network failure cannot clear newer source');assert.strictEqual(failedCanceled.c.currentSeriesHours.length,1);
 let loaderFixtures=5;
 if(functions.loadForecast.includes('const generation = options.generation ?? ++selectionGeneration;')){const superseded=loader(functions.loadForecast,hours,{fail:true,cancelGeneration:true});assert.strictEqual(await superseded.run(),false);assert.strictEqual(superseded.calls.clear,0,'old generation failure cannot clear newer source');assert.strictEqual(superseded.c.currentSeriesHours.length,1);loaderFixtures++;}
 return {primitive_fixtures:fixtures.length,normalizer_fixtures:9,forecast_scenario_fixtures:loaderFixtures};
}
module.exports={runFunctions,reader,loader,extract};
if(require.main===module){const path=process.argv[2]||'index.html';const source=fs.readFileSync(path,'utf8');const functions=Object.fromEntries(['normalizeStageValue','getRawStageValue','getStageValue','loadForecast'].map(n=>[n,extract(source,n)]));const adjustment=/return n \+ STAGE_ADJUSTMENT_FT/.test(functions.normalizeStageValue)?Number(source.match(/const STAGE_ADJUSTMENT_FT = ([^;]+);/)[1]):0;runFunctions(functions,adjustment).then(result=>console.log(JSON.stringify({passed:true,...result}))).catch(error=>{console.error(error);process.exitCode=1;});}
