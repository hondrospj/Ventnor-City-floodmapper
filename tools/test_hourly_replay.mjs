// Exercise the deployed replay functions, including real gaps and day boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL(process.env.REPLAY_SOURCE || '../index.html',import.meta.url),'utf8');
function extract(name){
 const start=html.search(new RegExp('^    (?:async )?function '+name+'\\(','m'));
 assert(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);
}
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
 if(/\bsrc\s*=|type\s*=\s*["'](?:application\/json|application\/ld\+json|importmap)["']/i.test(m[1]))continue;
 if(m[2].trim())new vm.Script(m[2]);
}
const canonical=html.includes('function buildObservedCanonicalSeries(');
const date='1962-03-07',nextDate='1962-03-08',start=Date.parse(date+'T00:00Z');
const sample=(minutes,stage)=>({timeUtc:new Date(start+minutes*60000).toISOString(),navd88StageFt:stage,isMissingObservedHour:stage===null,sourceResolutionMinutes:60,sourceStationId:'test-gauge'});
const day={date,isLewesSurrogate:canonical,entries:Array.from({length:24},(_,h)=>sample(h*60,h))};
const nextDay={date:nextDate,isLewesSurrogate:canonical,entries:[sample(1440,24)]};
const days=new Map([[date,day],[nextDate,nextDay]]);
const c=vm.createContext({Date,Math,Number,Map,Set,Promise,console,
 MIN_DEPTH_STAGE:-10,MAX_STAGE:20,floorToCatalogStep:v=>v,
 DATUM_OFFSETS:{MLLW:2.13},currentDatum:'MLLW',currentOverlayMode:'depth',
 getDepthTimelineColor:()=> 'valid-depth',getImpactTimelineColor:()=> 'valid-impact',
 entryTimeMs:e=>e?.timeUtc?Date.parse(e.timeUtc):null,
 getObservedSourceHoursForDay:d=>d?.entries||[],
 parseStoredLocalNyToDate:s=>new Date(s+'Z'),
 formatNyLocalIso:d=>d.toISOString().slice(0,16),
 addDaysToDateKey:(s,n)=>new Date(Date.parse(s+'T00:00Z')+n*86400000).toISOString().slice(0,10),
 getObservedDayRecord:s=>days.get(s),
 detectSeriesResolutionMinutes:()=>60,
 annotateHydraulicSeries:s=>s,
 getTimelineIntervalMinutes:()=>15,
 getEntryESTDate:e=>new Date(e.timeUtc),
 getNyParts:d=>({minute:d.getUTCMinutes()})
});
const builder=canonical?'buildObservedCanonicalSeries':'buildObservedQuarterHourDisplaySeries';
for(const name of ['normalizeStageValue','getOverlayStage','convertStageForDisplay','getRawStageValue','getStageValue','getTimelineHourColor','setTimelineSlotFields','makeMissingTimelineEntry','makeInterpolatedTimelineEntry','buildQuarterHourTimelineSeries',builder])vm.runInContext(extract(name),c);
const build=()=>c[builder](day,date);
let series=build();
assert.equal(series.length,96);
assert.equal(series.filter(e=>Number.isFinite(c.getStageValue(e))).length,96,'Hourly observations acquired artificial gaps');
for(let i=0;i<96;i++){
 assert.equal(series[i].navd88StageFt,i/4);
 assert.equal(series[i].isInterpolatedTimelineFrame===true,i%4!==0);
 assert.equal(series[i].isMissingObservedHour,false);
 assert.equal(series[i].isMissingTimelineFrame===true,false);
 assert.equal(series[i].sourceStationId,'test-gauge');
 assert.equal(series[i].observedDate,date);
 if(i%4===0)assert.equal(c.getStageValue(series[i]),day.entries[i/4].navd88StageFt,'Measured hourly reading changed');
}
// A genuine two-hour hole must not become a smooth invented observation.
const saved=day.entries[9];day.entries[9]=sample(540,null);
series=build();
for(let i=33;i<=39;i++){
 assert.equal(series[i].navd88StageFt,null);
 assert.equal(c.getStageValue(series[i]),null,'Missing observation became zero');
 assert.equal(series[i].isMissingTimelineFrame,true);
}
assert.equal(c.getStageValue(series[32]),8);assert.equal(c.getStageValue(series[40]),10);
day.entries[9]=saved;
// A missing midnight endpoint is not extrapolated. Empty stage aliases stay null.
days.delete(nextDate);series=build();
assert.equal(series.filter(e=>Number.isFinite(c.getStageValue(e))).length,93);
assert(series.slice(93).every(e=>c.getStageValue(e)===null));
for(const e of [{navd88StageFt:null,stageFt:null,value:null},{waterHeight:null},{waterHeight:''}])assert.equal(c.getStageValue(e),null);
assert.equal(c.getStageValue({navd88StageFt:0}),0,'A genuine zero is valid');
assert.equal(c.getStageValue({navd88StageFt:-1}),-1);
for(const value of [null,undefined,'',' ',false,[]]){
 assert.equal(c.normalizeStageValue(value),null);
 assert.equal(c.getOverlayStage(value),null,'Missing stage became a flood layer');
 assert.equal(c.convertStageForDisplay(value),null,'Missing stage became a displayed datum offset');
}
assert.equal(c.getOverlayStage(0),0);assert.equal(c.convertStageForDisplay(0),2.13);
if(!canonical)assert.notEqual(c.getTimelineHourColor({navd88StageFt:null}),c.getTimelineHourColor({navd88StageFt:0}),'Missing frame was colored as no flooding');
// Different archives and daily maxima cannot supply an hourly endpoint.
days.set(nextDate,{...nextDay,isLewesSurrogate:!canonical});
assert(build().slice(93).every(e=>c.getStageValue(e)===null));
days.set(nextDate,{...nextDay,entries:[{...sample(1440,50),observationInterval:'daily',isDailyPeakOnly:true}]});
assert(build().slice(93).every(e=>c.getStageValue(e)===null));
days.set(nextDate,nextDay);
// Synthetic frames must not inherit missing or official-crest flags.
const before={t:start,entry:{...sample(0,3),isMissingTimelineFrame:true,isFittedCrestFrame:true,isOfficialCrestFrame:true}};
const frame=c.makeInterpolatedTimelineEntry(before,{t:start+3600000,entry:sample(60,2)},start+900000,15);
for(const key of ['isMissingObservedHour','isMissingTimelineFrame','isFittedCrestFrame','isOfficialCrestFrame'])assert.equal(frame[key],false,key);
if(canonical){
 // Keep the stricter gap policy for measured quarter-hour archives.
 const primary={date,entries:[sample(0,0),sample(60,4)]};
 assert(c[builder](primary,date).slice(1,4).every(e=>c.getStageValue(e)===null));
 primary.entries=[sample(0,0),sample(30,2)];assert.equal(c.getStageValue(c[builder](primary,date)[1]),1);
 // December 31 loads the next year for both calendar replay and range export.
 const calls=[];
 Object.assign(c,{getObservedArchiveSourceForDate:()=> 'lewes',ensureObservedArchiveYear:async(...a)=>calls.push(a),getExportDayKeyFromDate:s=>s});
 vm.runInContext(extract('ensureObservedArchiveForDate'),c);
 vm.runInContext(extract('ensureObservedArchiveRange'),c);
 await c.ensureObservedArchiveForDate('1962-12-31');
 assert.deepEqual(calls,[['lewes','1962'],['lewes','1963']]);
 calls.length=0;await c.ensureObservedArchiveForDate(date);assert.deepEqual(calls,[['lewes','1962']]);
 calls.length=0;await c.ensureObservedArchiveRange('1962-12-30','1962-12-31');
 assert(calls.some(([source,year])=>source==='lewes'&&year==='1963'));
 c.getObservedArchiveSourceForDate=s=>s==='1963-01-01'?'stone-harbor':'lewes';
 calls.length=0;await c.ensureObservedArchiveForDate('1962-12-31');assert.deepEqual(calls,[['lewes','1962']]);
}
console.log('PASS replay: syntax, 96 frames, unchanged readings, real gaps, missing vs zero, midnight, archive boundary, interpolation flags'+(canonical?', primary cadence and year-boundary exports':''));
