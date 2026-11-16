/* Keep town flood calculations in their existing engines. This owns building display only. */
(() => {
  'use strict';
  const layerId='nw-3d-buildings',displaySource='county-building-footprints',buildingSources=new WeakMap();
  let boundaryPromise,standalonePromise,standaloneMap,standaloneActive=false,focusPromise;
  function config(){return typeof TOWN_CONFIG!=='undefined'?TOWN_CONFIG:typeof TOWN_CONSTANTS!=='undefined'?TOWN_CONSTANTS:{};}
  function leaflet(){return typeof map!=='undefined'?map:null;}
  function polygons(value){
    if(!value)return [];
    if(value.type==='FeatureCollection')return value.features.flatMap(polygons);
    if(value.type==='Feature')return polygons(value.geometry);
    if(value.type==='Polygon')return [value.coordinates];
    if(value.type==='MultiPolygon')return value.coordinates;
    return [];
  }
  async function boundary(){
    if(typeof municipalBoundaryFeature!=='undefined'&&municipalBoundaryFeature)return {type:'MultiPolygon',coordinates:polygons(municipalBoundaryFeature)};
    if(!boundaryPromise)boundaryPromise=(async()=>{
      const path=config().boundary?.boundaryUrl;
      if(!path)throw Error('This town has no building clipping boundary.');
      const response=await fetch(new URL(path,location.href));if(!response.ok)throw Error('The town boundary could not load.');
      const coordinates=polygons(await response.json());if(!coordinates.length)throw Error('The town boundary has no polygons.');
      return {type:'MultiPolygon',coordinates};
    })().catch(error=>{boundaryPromise=null;throw error;});
    return boundaryPromise;
  }
  const isOn=()=>document.getElementById('buildingsToggle')?.classList.contains('on');
  function note(supportsFlat = false){
    const toggle=document.getElementById('buildingsToggle');
    const text=supportsFlat
      ? 'Show buildings in the current map view.'
      : '3D building footprints. Existing town building models are retained where available; other heights are schematic.';
    if(toggle){toggle.setAttribute('aria-label',supportsFlat?'Show buildings':'Show 3D buildings');toggle.title=text;toggle.closest('.layer-item')?.setAttribute('title',text);}
  }
  async function syncNative(gl,scale=4){
    if(!gl)return;
    if(!gl.getLayer(layerId)){
      const town=await boundary();
      const bp=town.coordinates.flat(2);document.body.dataset.countyBuildingBoundary=JSON.stringify({polygons:town.coordinates.length,first:bp[0],min:[Math.min(...bp.map(p=>p[0])),Math.min(...bp.map(p=>p[1]))],max:[Math.max(...bp.map(p=>p[0])),Math.max(...bp.map(p=>p[1]))]});
      const footprint=(gl.getStyle().layers||[]).find(layer=>layer.type==='fill'&&/building/i.test(layer['source-layer']||''));
      if(!footprint)throw Error('The town basemap does not expose building footprints.');
      buildingSources.set(gl,{source:footprint.source,layer:footprint['source-layer']});
      gl.addSource(displaySource,{type:'geojson',data:{type:'FeatureCollection',features:[]},maxzoom:18,buffer:256,tolerance:0});
      gl.addLayer({id:layerId,type:'fill-extrusion',source:displaySource,minzoom:13,
        metadata:{heightModel:'Schematic 5 m massing; not surveyed heights, occupied-floor elevations or flood-depth data.'},
        layout:{visibility:'none'},paint:{'fill-extrusion-color':'#ddd7cb','fill-extrusion-height':5*scale,'fill-extrusion-base':0,'fill-extrusion-opacity':1,'fill-extrusion-vertical-gradient':true}},gl.getLayer('nw-boundary-mask')?'nw-boundary-mask':undefined);
      let priorGeometry='';
      const refresh=()=>{
        if(!gl.getLayer(layerId))return;
        const features=gl.queryRenderedFeatures({layers:[layerId]});
        document.body.dataset.countyRenderedBuildings=String(features.length);
        const source=buildingSources.get(gl);const all=gl.querySourceFeatures(source.source,{sourceLayer:source.layer});document.body.dataset.countySourceBuildings=String(all.length);
        // MapLibre's within expression does not clip polygon features. Keep
        // real provider footprints only when all of their vertices are in town.
        const selected=new Map();
        for(const feature of all){const parts=polygons(feature.geometry),points=parts.flat(2);if(!points.length||!points.every(p=>insideTown(p,town)))continue;const geometry=JSON.parse(JSON.stringify(feature.geometry)),key=JSON.stringify(geometry);selected.set(key,{type:'Feature',properties:{heightSource:'Schematic 5 m display height'},geometry});}
        const entries=[...selected.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
        const signature=entries.map(e=>e[0]).join('|');
        if(signature!==priorGeometry){priorGeometry=signature;gl.getSource(displaySource).setData({type:'FeatureCollection',features:entries.map(e=>e[1])});}
        document.body.dataset.countyClippedBuildingCount=String(entries.length);
      };
      gl.on('idle',refresh);
      gl.on('error',event=>{if(event.sourceId===displaySource)document.body.dataset.countyBuildingError=String(event.error?.message||event.error||'3D source error');});
    }
    gl.setLayoutProperty(layerId,'visibility',isOn()&&gl.getPitch()>10?'visible':'none');
    document.body.dataset.countyBuildingProvider='Esri/OpenStreetMap footprints; schematic 5 m heights';
  }
  function centerOf(feature){
    let ring=feature.geometry?.coordinates;
    while(Array.isArray(ring?.[0]?.[0]))ring=ring[0];
    if(!Array.isArray(ring)||!ring.length)return null;
    const points=ring.filter(p=>Number.isFinite(p?.[0])&&Number.isFinite(p?.[1]));
    if(!points.length)return null;
    return [points.reduce((n,p)=>n+p[0],0)/points.length,points.reduce((n,p)=>n+p[1],0)/points.length];
  }
  function insideRing(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
  function insideTown(point,town){return town.coordinates.some(p=>insideRing(point,p[0])&&!p.slice(1).some(h=>insideRing(point,h)));}
  async function focus(gl){
    if(!gl||!isOn())return;
    if(focusPromise)return focusPromise;
    focusPromise=(async()=>{
      const originalCenter=gl.getCenter();
      const localFeatures=window.NORTH_WILDWOOD_3D?.getBuildingData?.()?.features;
      if(localFeatures?.length){
        const centers=localFeatures.map(centerOf).filter(Boolean).sort((a,b)=>((a[0]-originalCenter.lng)**2+(a[1]-originalCenter.lat)**2)-((b[0]-originalCenter.lng)**2+(b[1]-originalCenter.lat)**2));
        gl.jumpTo({center:centers[0],pitch:60,zoom:17});return;
      }
      const town=await boundary();
      gl.jumpTo({pitch:60,zoom:15});
      if(gl.getLayer(layerId))gl.setLayoutProperty(layerId,'visibility','visible');
      const deadline=Date.now()+10000;
      let features=[];
      while(Date.now()<deadline&&isOn()){
        const src=buildingSources.get(gl);
        features=src?gl.querySourceFeatures(src.source,{sourceLayer:src.layer}).filter(f=>{const p=centerOf(f);return p&&insideTown(p,town);}):[];
        if(features.length)break;
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      const centers=features.map(centerOf).filter(Boolean).sort((a,b)=>((a[0]-originalCenter.lng)**2+(a[1]-originalCenter.lat)**2)-((b[0]-originalCenter.lng)**2+(b[1]-originalCenter.lat)**2));
      document.body.dataset.countyBuildingFocusCandidates=String(centers.length);
      if(isOn())gl.jumpTo({center:centers[0]||[originalCenter.lng,originalCenter.lat],zoom:17,pitch:60});
      document.body.dataset.countyBuildingFocus=centers.length?'visible-town-building':'current-view';
    })().finally(()=>{focusPromise=null;});
    return focusPromise;
  }
  function runtime(){
    if(window.maplibregl)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const css=document.createElement('link');css.rel='stylesheet';css.href='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css';document.head.append(css);
      const script=document.createElement('script');script.src='https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';script.onload=resolve;script.onerror=()=>reject(Error('The 3D renderer could not load.'));document.head.append(script);
    });
  }
  async function ensureStandalone(){
    if(standalonePromise)return standalonePromise;
    standalonePromise=(async()=>{
      await runtime();
      const host=document.createElement('div');host.id='countyStandalone3d';host.setAttribute('aria-label',`${config().mapTitle||'Town'} 3D building map`);document.getElementById('mapWrap').prepend(host);
      const center=leaflet().getCenter();
      const response=await fetch('https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/resources/styles/root.json');if(!response.ok)throw Error('The 3D basemap could not load.');
      const style=await response.json(),base=response.url;
      for(const key of ['sprite','glyphs'])if(style[key])style[key]=new URL(style[key],base).href.replace(/%7B/g,'{').replace(/%7D/g,'}');
      style.sources={esri:{type:'vector',tiles:['https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf'],maxzoom:22,attribution:'© Esri · © OpenStreetMap contributors'}};
      const mobile=matchMedia('(pointer:coarse), (max-width:900px)').matches;
      standaloneMap=new maplibregl.Map({container:host,style,center:[center.lng,center.lat],zoom:14,pitch:60,maxZoom:22,attributionControl:true,pixelRatio:mobile?1:Math.min(devicePixelRatio||1,2),antialias:!mobile,maxTileCacheSize:mobile?64:256,maxTileCacheZoomLevels:mobile?3:8,powerPreference:mobile?'low-power':'default',canvasContextAttributes:{antialias:!mobile}});
      document.body.dataset.countyStandalonePixelRatio=String(standaloneMap.getPixelRatio());
      standaloneMap.addControl(new maplibregl.NavigationControl({showCompass:true,visualizePitch:true}),'top-right');
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('The 3D basemap timed out.')),20000);standaloneMap.once('load',()=>{clearTimeout(timer);resolve();});});
      await syncNative(standaloneMap,1);
      const town=await boundary();standaloneMap.addSource('county-town-boundary',{type:'geojson',data:town});standaloneMap.addLayer({id:'county-town-boundary',type:'line',source:'county-town-boundary',paint:{'line-color':'#000000','line-width':3}});
      let frame;
      const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=null;syncStandaloneFlood();});};
      new MutationObserver(schedule).observe(document.getElementById('map'),{childList:true,subtree:true,attributes:true,attributeFilter:['src','style']});
      document.getElementById('hourSlider')?.addEventListener('input',schedule);
      let moving=false;
      standaloneMap.on('moveend',()=>{if(standaloneActive&&!moving){moving=true;try{const c=standaloneMap.getCenter();leaflet().setView([c.lat,c.lng],standaloneMap.getZoom(),{animate:false});}finally{moving=false;}}});
      leaflet().on('moveend',()=>{if(standaloneActive&&!moving){moving=true;try{const c=leaflet().getCenter();standaloneMap.jumpTo({center:[c.lng,c.lat],zoom:leaflet().getZoom()});}finally{moving=false;}}});
      const roads=document.getElementById('roadsToggle');
      const syncRoads=()=>{const enabled=!roads||roads.classList.contains('on');for(const layer of standaloneMap.getStyle().layers||[])if(layer.type==='symbol'&&/road|street|transport/i.test(layer.id+' '+(layer['source-layer']||'')))standaloneMap.setLayoutProperty(layer.id,'visibility',enabled?'visible':'none');};
      if(roads)new MutationObserver(syncRoads).observe(roads,{attributes:true,attributeFilter:['class']});syncRoads();
      return standaloneMap;
    })().catch(error=>{try{standaloneMap?.remove();}catch(_){}standaloneMap=null;standalonePromise=null;document.getElementById('countyStandalone3d')?.remove();throw error;});
    return standalonePromise;
  }
  function syncStandaloneFlood(){
    if(!standaloneMap||!standaloneActive)return;
    const layer=typeof currentFloodLayer!=='undefined'?currentFloodLayer:null;
    const bounds=layer?.getBounds?.(),url=layer?.getElement?.()?.src;
    if(!bounds||!url){if(standaloneMap.getLayer('county-original-flood'))standaloneMap.setLayoutProperty('county-original-flood','visibility','none');document.body.dataset.countyStandaloneFlood='none';return;}
    const coordinates=[[bounds.getWest(),bounds.getNorth()],[bounds.getEast(),bounds.getNorth()],[bounds.getEast(),bounds.getSouth()],[bounds.getWest(),bounds.getSouth()]];
    const source=standaloneMap.getSource('county-original-flood');
    if(source){if(document.body.dataset.countyStandaloneFlood!==url)source.updateImage({url,coordinates});standaloneMap.setLayoutProperty('county-original-flood','visibility','visible');standaloneMap.setPaintProperty('county-original-flood','raster-opacity',typeof overlayOpacity!=='undefined'?overlayOpacity:.75);}
    else {standaloneMap.addSource('county-original-flood',{type:'image',url,coordinates});standaloneMap.addLayer({id:'county-original-flood',type:'raster',source:'county-original-flood',paint:{'raster-opacity':typeof overlayOpacity!=='undefined'?overlayOpacity:.75,'raster-fade-duration':0}},layerId);}
    document.body.dataset.countyStandaloneFlood=url;
  }
  function showStandalone(value){
    standaloneActive=Boolean(value);document.body.classList.toggle('county-standalone-3d',standaloneActive);
    const button=document.getElementById('countyStandaloneView');if(button){button.textContent=standaloneActive?'3D':'2D';button.setAttribute('aria-label',standaloneActive?'Switch to 2D view':'Switch to 3D view');button.setAttribute('aria-pressed',String(standaloneActive));}
    if(standaloneActive){standaloneMap.resize();syncStandaloneFlood();}else leaflet()?.invalidateSize();
  }
  function installStandalone(){
    const card=document.querySelector('.layers-card');if(!card)return;
    const row=document.createElement('div');row.className='layer-item';row.innerHTML='<div id="buildingsToggle" class="toggle" role="switch" tabindex="0" aria-checked="false"></div><div class="layer-meta"><div class="layer-name">Buildings</div></div>';
    card.append(row);const toggle=row.querySelector('#buildingsToggle');
    const enable=async value=>{
      toggle.setAttribute('aria-busy','true');
      try{toggle.classList.toggle('on',value);toggle.setAttribute('aria-checked',String(value));
        if(value){await ensureStandalone();showStandalone(true);await syncNative(standaloneMap,1);await focus(standaloneMap);}else if(standaloneMap)standaloneMap.setLayoutProperty(layerId,'visibility','none');
      }catch(error){toggle.classList.remove('on');toggle.setAttribute('aria-checked','false');showStandalone(false);if(typeof toast==='function')toast(error.message);}
      finally{toggle.removeAttribute('aria-busy');}
    };
    toggle.addEventListener('click',()=>enable(!isOn()));toggle.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();enable(!isOn());}});
    const view=document.createElement('button');view.id='countyStandaloneView';view.type='button';view.textContent='2D';view.setAttribute('aria-label','Switch to 3D view');view.addEventListener('click',async()=>{if(standaloneActive)showStandalone(false);else {await ensureStandalone();showStandalone(true);}});document.getElementById('mapWrap').append(view);
    window.COUNTY_STANDALONE_3D={getMap:()=>standaloneMap};note();
  }
  window.COUNTY_3D_BUILDINGS={sync:syncNative,focus,boundary};
  if(!document.getElementById('buildingsToggle'))installStandalone();else note(Boolean(config().structures?.buildings3dPath));
})();
