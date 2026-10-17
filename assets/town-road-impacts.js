/* Road Impacts uses each mapper's own committed flood image and depth sampler. */
(() => {
 'use strict';
 if(window.SHORELYSAFE_ROAD_IMPACTS)return;
 const toggle=document.getElementById('roadImpactsToggle');if(!toggle)return;
 const EMPTY={type:'FeatureCollection',features:[]},MIN_DEPTH_FT=.5;
 let enabled=false,revision=0,version=0,roadsPromise=null,roads=null,data=EMPTY,leafletLayer=null,glInstance=null,glVersion=-1;
 const status=message=>{const e=document.getElementById('roadImpactsStatus');if(e)e.textContent=message;};
 function densify(coordinates){
  const output=[coordinates[0]];
  for(let i=1;i<coordinates.length;i++){
   const a=coordinates[i-1],b=coordinates[i],meters=Math.hypot((b[0]-a[0])*Math.cos((a[1]+b[1])*Math.PI/360),b[1]-a[1])*111320,steps=Math.max(1,Math.ceil(meters/5));
   for(let j=1;j<=steps;j++){const t=j/steps;output.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
  }
  return output;
 }
 async function loadRoads(){
  if(roads)return roads;
  if(!roadsPromise)roadsPromise=fetch(new URL('./assets/road-impacts-data.geojson',APP_BASE),{cache:'force-cache'}).then(response=>{if(!response.ok)throw Error('Road geometry could not load.');return response.json();}).then(payload=>{
   if(!payload.features?.length)throw Error('Road geometry is empty.');
   roads=payload.features.flatMap(feature=>{const geometry=feature.geometry;return(geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[]).filter(line=>line.length>1).map(line=>({properties:feature.properties,coordinates:densify(line)}));});return roads;
  }).catch(error=>{roadsPromise=null;throw error;});
  return roadsPromise;
 }
 function readRaster(image){
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  try{const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);return{values:context.getImageData(0,0,canvas.width,canvas.height).data,width:canvas.width,height:canvas.height};}
  finally{canvas.width=canvas.height=0;}
 }
 function rasterPixel(coordinate,bounds,width,height){return{x:Math.floor((coordinate[0]-bounds.getWest())/(bounds.getEast()-bounds.getWest())*width),y:Math.floor((bounds.getNorth()-coordinate[1])/(bounds.getNorth()-bounds.getSouth())*height)};}
 function visibleSampler(image,layer){
  const raster=readRaster(image),bounds=layer.getBounds?.()||floodLatLngBounds;
  return coordinate=>{
   const point=layer._worldFileAffine?latLngToWorldFilePixel(coordinate[1],coordinate[0],raster.width,raster.height):rasterPixel(coordinate,bounds,raster.width,raster.height);
   if(!point||point.x<0||point.y<0||point.x>=raster.width||point.y>=raster.height)return false;
   const uncertainty=typeof getUncertaintyRasterColor==='function'?getUncertaintyRasterColor():undefined;
   const offset=(point.y*raster.width+point.x)*4;
   return isWetRasterPixel(raster.values,offset,uncertainty)?raster.values.subarray(offset,offset+4):false;
  };
 }
 async function gridPixelReader(grid){
  if(grid.values)return(x,y)=>grid.values.subarray((y*grid.width+x)*4,(y*grid.width+x)*4+4);
  if(typeof grid.readRows!=='function')throw Error('This map has no readable depth grid.');
  const cache=new Map(),rows=grid.stripeRows||(typeof RASTER_STRIPE_ROWS==='number'?RASTER_STRIPE_ROWS:64);
  return async(x,y)=>{
   const start=Math.floor(y/rows)*rows;
   if(!cache.has(start)){cache.set(start,Promise.resolve(grid.readRows(start,Math.min(rows,grid.height-start))));if(cache.size>4)cache.delete(cache.keys().next().value);}
   const values=await cache.get(start),offset=((y-start)*grid.width+x)*4;return values.subarray(offset,offset+4);
  };
 }
 async function depthSampler(entry,stage,phase,layer){
  // Reuse the routed/physics model wherever the town renderer uses it.
  const asset=currentOverlayMode==='depth'&&typeof getPhysicsAssetForEntry==='function'?getPhysicsAssetForEntry(entry):null;
  if(asset){
   const bounds=getActivePhysicsManifest()?.boundsWgs84;if(!asset.query?.url||!Array.isArray(bounds)||bounds.length!==2)throw Error('Depth-query bounds are missing.');
   const [[south,west],[north,east]]=bounds;if(![south,west,north,east].every(Number.isFinite)||north<=south||east<=west)throw Error('Depth-query bounds are invalid.');
   const raster=readRaster(await preloadPhysicsQueryImage(asset.query));
   return coordinate=>{const x=Math.floor((coordinate[0]-west)/(east-west)*raster.width),y=Math.floor((north-coordinate[1])/(north-south)*raster.height);if(x<0||y<0||x>=raster.width||y>=raster.height)return false;const i=(y*raster.width+x)*4;return raster.values[i+2]===1&&(raster.values[i]*256+raster.values[i+1])/1000>MIN_DEPTH_FT*.3048;};
  }
  if(typeof getV2PointDepth==='function'&&typeof getHydraulicQueryGrid==='function'&&typeof getDevelopedQueryGrid==='function'){
   const[grid,developed]=await Promise.all([getHydraulicQueryGrid(),getDevelopedQueryGrid()]);if(grid.width!==developed.width||grid.height!==developed.height)throw Error('Depth grids do not align.');
   const[readGround,readDeveloped]=await Promise.all([gridPixelReader(grid),gridPixelReader(developed)]),bounds=layer.getBounds?.()||floodLatLngBounds;
   return async(coordinate,visiblePixel)=>{const{x,y}=rasterPixel(coordinate,bounds,grid.width,grid.height);if(x<0||y<0||x>=grid.width||y>=grid.height)return false;const[q,d]=await Promise.all([readGround(x,y),readDeveloped(x,y)]),encoded=q[0]*256+q[1];if(!encoded||q[2]===255)return false;const value=getV2PointDepth(stage,phase,currentOverlayMode,(encoded-32768)/10,isDevelopedRasterPixel(d,0),visiblePixel);return Number.isFinite(value?.value)&&value.value>MIN_DEPTH_FT+1e-9;};
  }
  if(typeof getDepthQueryGrid==='function'&&typeof sampleDepthModel==='function'){
   if(!await getDepthQueryGrid())throw Error('The native depth model could not load.');
   return async coordinate=>{const sample=await sampleDepthModel(coordinate[1],coordinate[0]),value=getDepthQueryDisplayDepth(sample,stage,{flooded:true},phase);return Number.isFinite(value)&&value>MIN_DEPTH_FT+1e-9;};
  }
  throw Error('The native depth sampler is unavailable.');
 }
 function syncLayers(){
  const gl=window.NORTH_WILDWOOD_3D?.getMap?.(),useGl=!!gl&&document.body.classList.contains('map-3d-ready'),showLeaflet=!!map&&enabled&&!useGl&&data.features.length>0;
  if(map&&leafletLayer&&!showLeaflet&&map.hasLayer(leafletLayer))map.removeLayer(leafletLayer);
  if(showLeaflet){
   if(!map.getPane('roadImpactsPane')){map.createPane('roadImpactsPane');map.getPane('roadImpactsPane').style.zIndex='705';map.getPane('roadImpactsPane').style.pointerEvents='none';}
   if(!leafletLayer)leafletLayer=L.geoJSON(data,{pane:'roadImpactsPane',interactive:false,renderer:L.canvas({pane:'roadImpactsPane',padding:.5}),style:{color:'#ef4444',weight:4,opacity:1,lineCap:'round',lineJoin:'round'}});
   if(!map.hasLayer(leafletLayer))leafletLayer.addTo(map);
  }
  if(!useGl||!gl.isStyleLoaded?.())return;
  if(glInstance!==gl){glInstance=gl;glVersion=-1;}
  if(!enabled&&!gl.getSource('nw-road-impacts-source'))return;
  if(!gl.getSource('nw-road-impacts-source')){
   gl.addSource('nw-road-impacts-source',{type:'geojson',data});const before=gl.getLayer('nw-boundary-mask')?'nw-boundary-mask':undefined;
   for(const[id,color,width]of[['nw-road-impacts-halo','#ffffff',6],['nw-road-impacts','#ef4444',4]])gl.addLayer({id,type:'line',source:'nw-road-impacts-source',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':color,'line-width':['interpolate',['linear'],['zoom'],11,width/3,16,width,20,width+3]}},before);
  }
  if(glVersion!==version){gl.getSource('nw-road-impacts-source').setData(data);glVersion=version;}
  for(const id of['nw-road-impacts','nw-road-impacts-halo'])if(gl.getLayoutProperty(id,'visibility')!==(enabled?'visible':'none'))gl.setLayoutProperty(id,'visibility',enabled?'visible':'none');
 }
 function publish(collection){data=collection;version++;if(leafletLayer){leafletLayer.clearLayers();leafletLayer.addData(data);}document.body.dataset.roadImpactsSections=String(data.features.length);syncLayers();}
 async function refresh(){
  if(!enabled)return;const request=++revision,token=lastRenderToken,layer=currentFloodLayer,image=layer?.getElement?.(),frame=layer?._floodmapperFrame||layer?._highlandsFrame,entry=frame?.entry||currentSeriesHours[currentHourIndex],stage=frame?.stage??getSelectedStageNavd88(),phase=frame?.phase||getHydraulicPhaseForEntry(entry,currentHourIndex,currentSeriesHours);
  if(!image?.complete||!image.naturalWidth){publish(EMPTY);document.body.dataset.roadImpactsState='unavailable';status('No flood image is available for this time.');return;}
  const current=()=>enabled&&request===revision&&token===lastRenderToken&&layer===currentFloodLayer;
  status('Updating road impacts…');document.body.dataset.roadImpactsState='loading';publish(EMPTY);
  try{
   const lines=await loadRoads();if(!current())return;const wet=visibleSampler(image,layer),deep=await depthSampler(entry,stage,phase,layer);if(!current())return;const features=[];
   for(let i=0;i<lines.length;i++){
    if(i%30===0){await new Promise(resolve=>requestAnimationFrame(resolve));if(!current())return;}
    const road=lines[i];let run=[];const finish=()=>{if(run.length>1)features.push({type:'Feature',properties:road.properties,geometry:{type:'LineString',coordinates:run}});run=[];};
    for(let j=1;j<road.coordinates.length;j++){const a=road.coordinates[j-1],b=road.coordinates[j],middle=[(a[0]+b[0])/2,(a[1]+b[1])/2],visiblePixel=wet(middle);if(visiblePixel&&await deep(middle,visiblePixel)){if(!run.length)run.push(a);run.push(b);}else finish();}finish();
   }
   if(!current())return;publish({type:'FeatureCollection',features});document.body.dataset.roadImpactsState='ready';status(features.length?'Modeled road water depth > 0.5 ft':'No road sections above 0.5 ft at this time.');
  }catch(error){if(!current())return;publish(EMPTY);document.body.dataset.roadImpactsState='failed';status('Road impacts could not load. Toggle off/on to retry.');console.warn('Road Impacts:',error);}
 }
 function setEnabled(value){enabled=!!value;revision++;toggle.classList.toggle('on',enabled);toggle.setAttribute('aria-checked',String(enabled));document.body.dataset.roadImpactsEnabled=String(enabled);const key=document.getElementById('roadImpactsKey');if(key)key.hidden=!enabled;if(!enabled){publish(EMPTY);document.body.dataset.roadImpactsState='disabled';}else return refresh();}
 toggle.addEventListener('click',()=>setEnabled(!enabled));toggle.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setEnabled(!enabled);}});
 const clear=clearFloodLayer;clearFloodLayer=function(){revision++;publish(EMPTY);return clear.apply(this,arguments);};
 const render=renderHour;renderHour=async function(){const result=await render.apply(this,arguments);if(enabled)await refresh();return result;};
 new MutationObserver(syncLayers).observe(document.body,{attributes:true,attributeFilter:['class']});
 setEnabled(false);window.SHORELYSAFE_ROAD_IMPACTS={setEnabled,refresh};
})();
