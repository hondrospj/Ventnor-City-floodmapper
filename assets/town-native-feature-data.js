/* Fill missing town feature datasets from public agencies and the native terrain. */
(() => {
 'use strict';
 if(window.SHORELYSAFE_NATIVE_FEATURE_DATA)return;
 const needNsi=typeof NSI_STRUCTURES_URL!=='undefined'&&!NSI_STRUCTURES_URL,needParcels=typeof PARCELS_URL!=='undefined'&&!PARCELS_URL;
 if(!needNsi&&!needParcels)return;
 const sourceFetch=fetchJson,cache=new Map();let clipFeature=null,clipPromise=null;
 const nsiUrl=new URL('assets/native-structure-data.json',APP_BASE).href,parcelUrl=new URL('assets/native-parcel-data.json',APP_BASE).href;
 function boundary(){return clipFeature||(typeof municipalBoundaryFeature!=='undefined'?municipalBoundaryFeature:null);}
 async function ensureBoundary(){if(boundary())return;if(!clipPromise)clipPromise=json(new URL(TOWN_CONFIG.boundary?.boundaryUrl||'',APP_BASE).href).then(data=>{if(!data.type)throw Error('The municipal clipping boundary could not load.');clipFeature=data;}).catch(error=>{clipPromise=null;throw error;});return clipPromise;}
 function within(lon,lat){const f=boundary();if(!f)return false;const features=f.type==='FeatureCollection'?f.features:[f.type==='Feature'?f:{type:'Feature',geometry:f}];return features.some(feature=>pointInParcelFeature(feature,lat,lon));}
 function bounds(){const b=getBoundaryDrivenOverlayBounds();return[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()];}
 async function json(url){const response=await fetch(url,{mode:'cors',credentials:'omit',cache:'force-cache'});if(!response.ok)throw Error('Public town feature data returned HTTP '+response.status);const data=await response.json();if(data.error)throw Error(data.error.message||'Public feature query failed.');return data;}
 function once(key,build){if(!cache.has(key))cache.set(key,build().catch(error=>{cache.delete(key);throw error;}));return cache.get(key);}
 async function structures(){return once('nsi',async()=>{
  await ensureBoundary();
  const payload=await json(new URL('assets/native-nsi-points.geojson',APP_BASE).href);
  const features=[],seen=new Set();let count=0;
  for(const feature of payload.features||[]){
   const [lon,lat]=feature.geometry?.coordinates||[],p=feature.properties||{},height=Number(p.found_ht),key=String(p.ftprntid||p.fd_id);
   if(!within(lon,lat)||p.found_ht==null||!Number.isFinite(height)||height<0||seen.has(key))continue;
   const sample=await sampleDepthModel(lat,lon),ground=sample?.elevation;
   if(!Number.isFinite(ground))continue;
   seen.add(key);features.push({type:'Feature',id:p.fd_id,geometry:feature.geometry,properties:{footprintId:key,localGroundNavd88Ft:ground,foundationHeightFt:height,modeledFirstFloorNavd88Ft:ground+height,foundationType:p.found_type,stories:p.num_story,method:'localTerrainPlusNSIFoundationHeight',source:'USACE NSI; native town terrain; screening estimate'}});
   if(++count%150===0)await new Promise(resolve=>requestAnimationFrame(resolve));
  }
  document.body.dataset.nativeStructureCount=String(features.length);
  return{type:'FeatureCollection',metadata:{schema:'nsi-2026-first-floor-v1',source:'USACE NSI API plus native town terrain',screeningOnly:true},features};
 });}
 async function parcels(){return once('parcels',async()=>{
  await ensureBoundary();
  const[w,s,e,n]=bounds(),town=String(TOWN_CONFIG.site?.municipalityName||TOWN_CONFIG.site?.name||'').replace(/\s+(?:Borough|Township|Village|City)$/i,'').toUpperCase().replace(/'/g,"''");
  const query=new URLSearchParams({f:'geojson',where:`MUN_NAME LIKE '${town}%'`,geometry:[w,s,e,n].join(','),geometryType:'esriGeometryEnvelope',spatialRel:'esriSpatialRelIntersects',inSR:'4326',outSR:'4326',outFields:'OBJECTID,PAMS_PIN,PCL_MUN,MUN_NAME,PCLBLOCK,PCLLOT,PROP_LOC',returnGeometry:'true',resultRecordCount:'2000',orderByFields:'OBJECTID',geometryPrecision:'7'}),features=[];let offset=0;
  while(true){query.set('resultOffset',String(offset));const page=await json('https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query?'+query);const batch=page.features||[];
   for(const feature of batch){const p=feature.properties||{},rings=feature.geometry?.type==='Polygon'?feature.geometry.coordinates:feature.geometry?.coordinates?.[0];if(!rings?.[0]?.length)continue;const ring=rings[0],lon=ring.reduce((v,c)=>v+c[0],0)/ring.length,lat=ring.reduce((v,c)=>v+c[1],0)/ring.length;if(!within(lon,lat)&&!ring.some(c=>within(c[0],c[1])))continue;feature.properties={parcelId:p.PAMS_PIN,address:p.PROP_LOC||'Parcel',block:p.PCLBLOCK,lot:p.PCLLOT,centroidLon:lon,centroidLat:lat,source:'NJOGIS public parcels; planning boundaries'};features.push(feature);}
   offset+=batch.length;if(batch.length<2000&&!page.exceededTransferLimit)break;if(!batch.length)throw Error('The parcel service returned an incomplete page.');
  }
  document.body.dataset.nativeParcelCount=String(features.length);return{type:'FeatureCollection',features};
 });}
 fetchJson=function(url){const absolute=new URL(url,APP_BASE).href;if(needNsi&&absolute===nsiUrl)return structures();if(needParcels&&absolute===parcelUrl)return parcels();return sourceFetch.apply(this,arguments);};
 if(needNsi){NSI_STRUCTURES_URL=nsiUrl;const original=setNsiStructuresEnabled;let generation=0;setNsiStructuresEnabled=async function(enabled){const request=++generation,result=await original.apply(this,arguments);if(!document.getElementById('nsiStructuresToggle')?.classList.contains('on')){if(nsiStructuresLayer&&map?.hasLayer(nsiStructuresLayer))map.removeLayer(nsiStructuresLayer);updateMapClickModeControl();return result;}if(enabled&&request===generation)toast('Structural impacts compare the selected gauge level with native terrain plus USACE modeled foundation height. Screening estimate.');return result;};}
 let gl=null,loaded=false;
 function syncParcel3d(){if(!needParcels)return;const map3d=window.NORTH_WILDWOOD_3D?.getMap?.();if(!map3d||!map3d.isStyleLoaded?.())return;if(gl!==map3d){gl=map3d;loaded=false;}if(!parcelFeatures.length)return;const id='fm-native-parcels',before=gl.getLayer('nw-boundary-mask')?'nw-boundary-mask':undefined;if(!gl.getSource(id)){gl.addSource(id,{type:'geojson',data:{type:'FeatureCollection',features:parcelFeatures}});gl.addLayer({id,type:'line',source:id,paint:{'line-color':'#f87171','line-width':1.2}},before);loaded=true;}const visibility=document.getElementById('parcelsToggle')?.classList.contains('on')?'visible':'none';if(gl.getLayoutProperty(id,'visibility')!==visibility)gl.setLayoutProperty(id,'visibility',visibility);}
 if(needParcels){PARCELS_URL=parcelUrl;ensureParcelAssets=async function(){if(parcelsLayer)return parcelsLayer;if(!parcelLoadPromise)parcelLoadPromise=parcels().then(payload=>{parcelFeatures=payload.features;parcelsLayer=L.geoJSON(payload,{pane:'parcelsPane',interactive:false,style:{color:'#f87171',weight:1.2,fill:false}});syncParcel3d();return parcelsLayer;}).catch(error=>{parcelLoadPromise=null;throw error;});return parcelLoadPromise;};const original=setParcelsEnabled;setParcelsEnabled=async function(){const result=await original.apply(this,arguments);if(!document.getElementById('parcelsToggle')?.classList.contains('on')&&parcelsLayer&&map?.hasLayer(parcelsLayer)){map.removeLayer(parcelsLayer);updateMapClickModeControl();}syncParcel3d();return result;};new MutationObserver(syncParcel3d).observe(document.body,{attributes:true,attributeFilter:['class']});}
 window.SHORELYSAFE_NATIVE_FEATURE_DATA={structures,parcels};
})();
