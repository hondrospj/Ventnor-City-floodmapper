#!/usr/bin/env python3
"""Use issued PETSS products for operational forecast aliases; preserve local datum/thresholds."""
import copy,json,math,sys
from pathlib import Path

METHOD='NOAA-issued PETSS ensemble mean TWL; lower and upper controls retain the published TWL90p and TWL10p curves. No estimated percentiles, manual peak targets or local forecast shifts.'
DEFINITIONS={'mean':('Mean','Mean','mean','TWL'),'lowEnd':('Low End','90p / e90','e90','TWL90p'),'highEnd':('High End','10p / e10','e10','TWL10p')}
def select_mean(data):
    result=copy.deepcopy(data)
    if isinstance(result.get('zones'),dict):
        for zone in result['zones'].values():zone['forecast']=select_mean(zone['forecast'])
        result['operationalForecastProduct']='PETSS ensemble mean TWL'
        return result
    products=result.get('forecasts',{})
    if not products.get('mean',{}).get('hours'):raise ValueError('Missing issued PETSS mean product; retaining the existing forecast')
    offset=float(result['navd88OffsetFromMllwFt']);limits=result['layerStageRangeNAVD88'];source_datum=str(result['sourceDatum']).upper();scale=float(result.get('rawPetssScale',1))
    options={}
    for key,(label,percentile,product,column)in DEFINITIONS.items():
        original=products.get(key)
        if not original or not original.get('hours'):raise ValueError('Missing issued PETSS '+column)
        rows=[]
        for i,old in enumerate(original['hours']):
            row=copy.deepcopy(old);value=float(row['rawPetssValue'])*float(row.get('rawPetssScale',scale))
            if not math.isfinite(value)or abs(value)>=9999:raise ValueError('Invalid issued '+column)
            if source_datum=='MLLW':mllw=value;navd=value+offset
            elif source_datum=='NAVD88':navd=value;mllw=value-offset
            else:raise ValueError('Unknown PETSS source datum '+source_datum)
            for field in ['estimatedTwlMllwFt','isEstimatedPercentile','sourceMeanTwlMllwFt','sourceTwl90pMllwFt','sourceTwl10pMllwFt','forecastPeakAnchor','rawPetssTwlMllwFt','rawPetssNavd88StageFt']:
                row.pop(field,None)
            if row.get('sourceTimeUtc'):row['timeUtc']=row.pop('sourceTimeUtc')
            for field in ['predictionTimeShiftMinutes','predictionStageAdjustmentFt']:row.pop(field,None)
            lo,hi,step=(float(limits[k])for k in ['min','max','increment']);nv=round(navd,2);ml=round(mllw,2);matched=max(lo,min(hi,round(nv/step)*step))
            row.update(hourIndex=i,scenario=key,product=product,percentile=percentile,sourceColumn=column,sourceStageFt=nv,sourceDatum='NAVD88',navd88StageFt=nv,mllwStageFt=ml,twlMllwFt=ml,matchedStageKey=f'{matched:.1f}',wasClamped=nv<lo or nv>hi)
            rows.append(row)
        options[key]={'label':label,'percentile':percentile,'product':product}
        products[key]={**original,**options[key],'hours':rows}
    result['forecastOptions']=copy.deepcopy(options);result['scenarioOptions']=copy.deepcopy(options)
    result['scenarioForecasts']=copy.deepcopy(products);result['hours']=copy.deepcopy(products['mean']['hours']);result['scenarioMethod']=METHOD
    result['forecastStartUtc']=result['hours'][0]['timeUtc'];result['forecastEndUtc']=result['hours'][-1]['timeUtc'];result['operationalForecastProduct']='TWL';result['operationalForecastStatistic']='ensemble_mean'
    for key in ['manualPeakAnchors','predictionStageAdjustmentFt','predictionTimeShiftMinutes','predictionAdjustmentNote','scenarioVersion','scenarioAdjustmentFt','minimumOffsetFt','minimumTideTargetsMLLW','meanTideAnchorVersion','meanTideAnchors','meanTideAnchorMethod','tideAnchorSourceHours']:result.pop(key,None)
    if isinstance(result.get('products'),dict):
        for key,meta in result['products'].items():
            if key in options:
                meta.update(options[key]);hours=products[key]['hours'];meta.update(forecastMllwMin=min(h['mllwStageFt']for h in hours),forecastMllwMax=max(h['mllwStageFt']for h in hours),forecastNavd88Min=min(h['navd88StageFt']for h in hours),forecastNavd88Max=max(h['navd88StageFt']for h in hours))
    return result
if __name__=='__main__':
    path=Path(sys.argv[1]if len(sys.argv)>1 else'forecast.json');selected=select_mean(json.loads(path.read_text()));tmp=path.with_suffix('.json.tmp');tmp.write_text(json.dumps(selected,indent=2)+'\n');tmp.replace(path)
