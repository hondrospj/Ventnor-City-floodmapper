/* Shared FloodMapper presentation. Each town retains its own model and data handlers. */
(() => {
 'use strict';
 const VERSION='20261021.1',body=document.body,root=document.documentElement;
 const panel=document.getElementById('leftPanel'),rail=document.getElementById('rightRail'),timeline=document.getElementById('timelineDock'),app=document.getElementById('app');
 if(!panel||!rail||!timeline||body.dataset.unifiedUiReady===VERSION)return;
 body.dataset.unifiedUiReady=VERSION;body.dataset.floodmapperUnified=VERSION;body.dataset.countyViewport=VERSION;
 const sourceCard=panel.querySelector('.data-source-card');
 const mobile=matchMedia('(max-width:900px), (max-height:560px), (max-height:560px) and (pointer:coarse), (max-width:1366px) and (any-pointer:coarse)');
 const owned=new WeakMap(),bound=new WeakSet();
 const layerOrder=[['satelliteToggle','Satellite'],['buildingsToggle','Buildings'],['parcelsToggle','Parcels'],['nsiStructuresToggle','Structural Impacts'],['roadImpactsToggle','Road Impacts'],['roadsToggle','Road Names'],['webcamsToggle','Cameras']];
 const groups={forecast:'.data-source-card,#forecastScenarioCard,#returnIntervalCard,#timelineIntervalCard,#calendarCard,.mobile-top-tides-card',map:'.overlay-card,.datum-card,.opacity-card,.layers-card,.top-tides-card',tools:'#mapperTutorialBtn,#avalonTourBtn'};
 const safeProbe=document.createElement('div');safeProbe.id='unifiedSafeAreaProbe';safeProbe.setAttribute('aria-hidden','true');safeProbe.style.cssText='position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';body.append(safeProbe);
 let chosenSection=panel.dataset.nwwSection||'forecast';
 let frame=0,layoutPasses=0,drawerOpener=null,drawerFocusGeneration=0;
 const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
 function set(e,key,value){if(e&&e.style.getPropertyValue(key)!==value)e.style.setProperty(key,value,'important');else if(e&&e.style.getPropertyPriority(key)!=='important')e.style.setProperty(key,value,'important');}
 function saveStyle(e){if(e)owned.set(e,e.getAttribute('style'));}
 function text(e,value){if(e&&e.textContent!==value)e.textContent=value;}
 function attr(e,key,value){if(e&&e.getAttribute(key)!==value)e.setAttribute(key,value);}
 function flag(e,name,value){if(e&&e.classList.contains(name)!==!!value)e.classList.toggle(name,!!value);}
 function leaflet(){return typeof map!=='undefined'?map:null;}
 function standalone(){return window.COUNTY_STANDALONE_3D?.getMap?.()||null;}
 function selectSection(group,focus=false){
  if(!Object.hasOwn(groups,group))group='forecast';const changed=chosenSection!==group;chosenSection=group;
  for(const card of document.querySelectorAll('#townAddressCard,#downloadCard'))attr(card,'data-nww-group',group==='map'?'map':'tools');
  if(panel.dataset.nwwSection!==group)panel.dataset.nwwSection=group;
  for(const tab of panel.querySelectorAll('#nwwMobileControlHeader [role="tab"]')){const on=tab.dataset.group===group;attr(tab,'aria-selected',String(on));tab.tabIndex=on?0:-1;if(on&&focus)tab.focus({preventScroll:true});}
  if(changed)panel.scrollTop=0;
 }
 function ensureControlButtons(){
  for(const [id,label]of [['mobileControlsToggle','Controls'],['mobileControlsClose','×']]){const copies=[...document.querySelectorAll('[id="'+id+'"]')];let button=copies.shift();for(const duplicate of copies)duplicate.remove();if(!button){button=document.createElement('button');button.id=id;button.type='button';button.textContent=label;(id==='mobileControlsClose'?panel:body).append(button);}attr(button,'aria-label',id==='mobileControlsClose'?'Close controls':'Open map controls');if(id==='mobileControlsToggle'){attr(button,'aria-controls','leftPanel');attr(button,'aria-expanded',String(body.classList.contains('mobile-controls-open')));}}
 }
 function ensureHeader(){
  const headers=[...document.querySelectorAll('[id="nwwMobileControlHeader"]')];let header=headers.shift();
  for(const duplicate of headers)duplicate.remove();
  if(!header){header=document.createElement('div');header.id='nwwMobileControlHeader';header.innerHTML='<div class="nww-drawer-heading"><h2 id="nwwControlsTitle">Map controls</h2><p></p></div><div class="nww-control-tabs" role="tablist" aria-label="Control sections"><button type="button" role="tab" data-group="forecast">Flood data</button><button type="button" role="tab" data-group="map">Map layers</button><button type="button" role="tab" data-group="tools">Tools</button></div>';panel.prepend(header);}
  if(header.parentElement!==panel)panel.prepend(header);
  text(header.querySelector('p'),document.getElementById('mapTitleText')?.textContent||'');
  if(!bound.has(header)){
   const tabs=[...header.querySelectorAll('[role="tab"]')];
   tabs.forEach((tab,i)=>{tab.addEventListener('click',event=>{event.stopImmediatePropagation();selectSection(tab.dataset.group);schedule();},true);tab.addEventListener('keydown',event=>{const next=event.key==='ArrowRight'?(i+1)%tabs.length:event.key==='ArrowLeft'?(i+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;if(next!==null){event.preventDefault();event.stopImmediatePropagation();selectSection(tabs[next].dataset.group,true);schedule();}},true);});bound.add(header);
  }
  selectSection(chosenSection);
 }
 function ensureDays(){
  const days=document.getElementById('timelineDayTabs');if(!days)return;
  const buttons=[...days.querySelectorAll('.timeline-day')],active=Math.max(0,buttons.findIndex(e=>e.classList.contains('active')||e.getAttribute('aria-current')==='date'));
  for(const [id,delta,label]of [['timelinePreviousDay',-1,'Previous'],['timelineNextDay',1,'Next']]){
   const copies=[...document.querySelectorAll('[id="'+id+'"]')];let button=copies.shift();for(const duplicate of copies)duplicate.remove();
   if(!button){button=document.createElement('button');button.id=id;button.className='timeline-day-arrow';button.type='button';days.parentElement.insertBefore(button,delta<0?days:days.nextSibling);}
   const neighbor=buttons[active+delta];button.disabled=!neighbor;
   const labelText=neighbor?.textContent?.trim()||label;attr(button,'aria-label',neighbor?label+' day: '+labelText:'No '+(delta<0?'earlier':'later')+' day available');
   const span=button.querySelector('.neighbor-day');if(span)text(span,labelText);else text(button,labelText);
   if(!bound.has(button)){button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();const current=[...days.querySelectorAll('.timeline-day')],i=current.findIndex(e=>e.classList.contains('active')||e.getAttribute('aria-current')==='date');current[Math.max(0,i)+delta]?.click();},true);bound.add(button);}
  }
 }
 function ensureLayers(){
  const card=document.querySelector('.layers-card');if(!card)return;flag(card,'nww-layers-card',true);
  let list=card.querySelector('.layer-list');if(!list){list=document.createElement('div');list.className='layer-list';card.append(list);}
  const desired=[];
  for(const [id,label]of layerOrder){
   // Feature modules own capability, state, loading, errors and activation.
   // Presentation never fabricates switches or disables a native handler.
   const toggle=document.getElementById(id),row=toggle?.closest('.layer-item');if(!row)continue;
   text(row.querySelector('.layer-name'),label);attr(toggle,'aria-label','Show '+label.toLowerCase());
   const note=row.querySelector('.unified-layer-note');
   if(note){if(toggle.getAttribute('aria-describedby')===note.id)toggle.removeAttribute('aria-describedby');note.remove();toggle.removeAttribute('aria-disabled');row.removeAttribute('title');}
   flag(row,'ui-unavailable',false);flag(row,'ui-locked',false);desired.push(row);
  }
  for(let i=0;i<desired.length;i++)if(list.children[i]!==desired[i])list.insertBefore(desired[i],list.children[i]||null);
  const hint=document.getElementById('nativeRoadNamesHint');if(hint&&!hint.hidden)hint.hidden=true;
 }
 function ensureReturnPeriodSelect(){
  const card=document.getElementById('returnIntervalCard');if(!card)return;
  const buttons=[...card.querySelectorAll('button[data-return-years]')];if(!buttons.length)return;
  let select=document.getElementById('nwwCompactReturnPeriod');
  if(!select){
   select=document.createElement('select');select.id='nwwCompactReturnPeriod';select.className='nww-compact-return-period';
   select.setAttribute('aria-label','Modeled flood frequency');
   for(const button of buttons){const option=document.createElement('option');option.value=button.dataset.returnYears;option.textContent=(button.getAttribute('aria-label')||button.textContent).replace(/ modeled flood$/i,'');select.append(option);}
   select.addEventListener('change',()=>buttons.find(button=>button.dataset.returnYears===select.value)?.click());card.append(select);
  }
  for(const option of select.options){const button=buttons.find(button=>button.dataset.returnYears===option.value);option.disabled=!!button?.disabled;}
  const selected=buttons.find(button=>button.classList.contains('active')||button.getAttribute('aria-pressed')==='true');
  if(selected&&select.value!==selected.dataset.returnYears)select.value=selected.dataset.returnYears;
 }
 function setDrawer(open,returnFocus=true){
  const generation=++drawerFocusGeneration;
  if(!mobile.matches)open=false;
  if(open){drawerOpener=document.activeElement;body.classList.remove('mobile-legend-open');}
  flag(body,'mobile-controls-open',open);attr(document.getElementById('mobileControlsToggle'),'aria-expanded',String(open));
  syncDrawer();schedule();
  if(open)panel.querySelector('#nwwMobileControlHeader [aria-selected="true"]')?.focus({preventScroll:true});
  else if(returnFocus){
   const closingFocus=document.activeElement;
   requestAnimationFrame(()=>{
    if(generation!==drawerFocusGeneration||body.classList.contains('mobile-controls-open')||document.activeElement!==closingFocus)return;
    if([...document.querySelectorAll('[aria-modal="true"],dialog[open]')].some(e=>e!==panel&&visible(e)))return;
    (drawerOpener?.isConnected?drawerOpener:document.getElementById('mobileControlsToggle'))?.focus({preventScroll:true});
   });
  }
 }
 function syncDrawer(){
  const open=mobile.matches&&body.classList.contains('mobile-controls-open');
  const childModal=[...document.querySelectorAll('[aria-modal="true"],dialog[open]')].some(e=>e!==panel&&!panel.contains(e)&&visible(e));
  if(mobile.matches)set(panel,'display',open?'flex':'none');
  panel.inert=mobile.matches&&(!open||childModal);
  if(open){attr(panel,'role','dialog');if(childModal)panel.removeAttribute('aria-modal');else attr(panel,'aria-modal','true');attr(panel,'aria-label','Map controls');}
  else {panel.removeAttribute('role');panel.removeAttribute('aria-modal');attr(panel,'aria-label','Flood map controls');}
  for(const id of ['map','map3d','countyStandalone3d','timelineDock']){const e=document.getElementById(id);if(e)e.inert=open;}
  attr(document.getElementById('mobileControlsToggle'),'aria-expanded',String(open));
 }
 function normalize(){
  ensureControlButtons();ensureHeader();ensureDays();ensureLayers();ensureReturnPeriodSelect();
  const title=sourceCard?.querySelector('h2');text(title,'Flood Data');
  const downloadCard=document.getElementById('downloadCard');if(downloadCard?.getAttribute('role')==='button'){downloadCard.removeAttribute('role');downloadCard.removeAttribute('tabindex');downloadCard.removeAttribute('aria-label');}
  for(const [id,label]of [['forecastDataBtn','Forecast'],['observedDataBtn','Past'],['returnIntervalDataBtn','Modeled Floods'],['forecastLowBtn','Lower End'],['forecastMeanBtn','Mean'],['forecastHighBtn','Upper End'],['openDownloadModalBtn','Export Map']])text(document.getElementById(id),label);
  text(panel.querySelector('#forecastScenarioCard h2'),'Forecast range');
  for(const id of ['mapperTutorialBtn','avalonTourBtn'])text(document.getElementById(id),'Take the FloodMapper tour');
  const opacity=panel.querySelector('.opacity-card .control-row'),opacityText=document.getElementById('opacityText');if(opacity&&opacityText&&opacityText.parentElement!==opacity)opacity.append(opacityText);
  attr(document.getElementById('opacitySlider'),'aria-label','Flood overlay opacity');attr(document.getElementById('hourSlider'),'aria-label',body.classList.contains('observed-mode')?'Observed flood time':body.classList.contains('return-interval-mode')?'Modeled flood time':'Flood forecast time');
  Object.entries(groups).forEach(([group,selector])=>document.querySelectorAll(selector).forEach(e=>{if(e.dataset.nwwGroup!==group)e.dataset.nwwGroup=group;}));
  for(const item of timeline.querySelectorAll('.timeline-key-item'))for(const node of [...item.childNodes])if(node.nodeType===Node.TEXT_NODE&&node.textContent.trim()){const span=document.createElement('span');span.className='timeline-key-label';span.textContent=node.textContent.trim().replace(/^No flooding$/i,'No Flooding').replace(/^(Minor|Moderate|Major) flooding$/i,'$1');node.replaceWith(span);}
  const bubble=document.getElementById('timelineBubble');if(bubble&&bubble.style.getPropertyValue('translate')!=='none')set(bubble,'translate','none');
  const legend=document.getElementById('legendDock');if(legend){attr(legend,'aria-label','Flood map legend');if(mobile.matches){attr(legend,'role','button');legend.tabIndex=0;attr(legend,'aria-expanded',String(body.classList.contains('mobile-legend-open')));}else{legend.removeAttribute('role');legend.removeAttribute('tabindex');legend.removeAttribute('aria-expanded');}}
 }
 function reparent(previousFocus){
  const compact=mobile.matches,legend=document.getElementById('legendDock');let mount=document.getElementById('mobileRailMount');
  const restoreLegendFocus=legend?.contains(previousFocus)&&legend.parentElement!==(compact?body:panel);
  if(compact){
   if(panel.parentElement!==body)body.append(panel);if(!mount){mount=document.createElement('div');mount.id='mobileRailMount';panel.append(mount);}
   for(const card of [...rail.children])mount.append(card);if(legend&&legend.parentElement!==body)body.append(legend);
  }else{
   if(app&&panel.parentElement!==app)app.insertBefore(panel,app.firstChild);
   if(mount)for(const card of [...mount.children])rail.append(card);if(legend&&legend.parentElement!==panel)panel.append(legend);
  }
  flag(root,'county-compact',compact);syncDrawer();
  if(!restoreLegendFocus)return null;
  if(compact)return legend;
  return previousFocus===legend?document.getElementById('legendHelpBtn'):previousFocus;
 }
 function layout(){
  frame=0;
  const previousFocus=document.activeElement;
  normalize();
  const focusAfterMove=reparent(previousFocus);
  layoutPasses++;
  const compact=mobile.matches;
  const bubble=document.getElementById('timelineBubble');
  for(const key of ['left','right','max-width','transform'])bubble?.style.removeProperty(key);
  for(const pane of [panel,rail]){set(pane,'zoom','1');set(pane,'transform','none');set(pane,'min-width','0px');}
  if(compact){
   body.removeAttribute('data-sidebar-density');body.removeAttribute('data-sidebar-fit');
   const vv=window.visualViewport,viewport=vv&&Math.abs((vv.scale||1)-1)<.01?vv:{height:innerHeight,width:innerWidth,offsetTop:0,offsetLeft:0};
   const computed=getComputedStyle(safeProbe),safe={top:parseFloat(computed.paddingTop)||0,right:parseFloat(computed.paddingRight)||0,bottom:parseFloat(computed.paddingBottom)||0,left:parseFloat(computed.paddingLeft)||0};
   const top=Math.max(0,viewport.offsetTop||0)+safe.top+8,left=Math.max(0,viewport.offsetLeft||0)+safe.left+8,right=Math.max(0,innerWidth-(viewport.offsetLeft||0)-(viewport.width||innerWidth))+safe.right+8,bottom=Math.max(0,innerHeight-(viewport.offsetTop||0)-(viewport.height||innerHeight))+safe.bottom+8;
   for(const [key,value]of Object.entries({top,left,right,bottom,height:Math.max(1,(viewport.height||innerHeight)-16)})){const valueText=value.toFixed(2)+'px';if(body.style.getPropertyValue('--cm-'+key)!==valueText)body.style.setProperty('--cm-'+key,valueText);}
   for(const [key,value]of Object.entries({position:'fixed',left:left+'px',right:right+'px',top:top+'px',bottom:bottom+'px',width:'auto','max-width':'none',height:'auto','max-height':'none','min-height':'0px','overflow-y':'auto','overflow-x':'hidden'}))set(panel,key,value);
   const header=panel.querySelector('#nwwMobileControlHeader');
   if(body.classList.contains('mobile-controls-open')&&header){
    set(panel,'scroll-padding-top',`${Math.max(136,Math.ceil(header.getBoundingClientRect().height)+8)}px`);
   }else panel.style.removeProperty('scroll-padding-top');
   set(rail,'display','none');set(timeline,'bottom',bottom+'px');set(timeline,'left',left+'px');set(timeline,'right',right+'px');set(timeline,'height','180px');set(timeline,'min-height','180px');set(timeline,'max-height','180px');
   for(const e of [document.getElementById('nwDefaultNavControl'),document.getElementById('countyStandaloneView')])if(e)for(const key of ['left','right','top'])e.style.removeProperty(key);
   const title=document.getElementById('mapTitleBadge');for(const key of ['left','right','top','max-width','transform'])title?.style.removeProperty(key);
   const focused=document.activeElement;if(body.classList.contains('mobile-controls-open')&&focused?.matches('input,textarea,select')&&panel.contains(focused)){const r=focused.getBoundingClientRect(),p=panel.getBoundingClientRect();if(r.bottom>p.bottom-20||r.top<p.top+130)requestAnimationFrame(()=>focused.scrollIntoView({block:'nearest',inline:'nearest'}));}
  }else{
   for(const key of ['top','left','right','bottom','height'])body.style.removeProperty('--cm-'+key);
   set(timeline,'position','fixed');set(timeline,'left','16px');set(timeline,'right','16px');set(timeline,'bottom','16px');set(timeline,'height','112px');set(timeline,'min-height','112px');set(timeline,'max-height','112px');
   for(const [pane,width]of [[panel,300],[rail,280]])for(const [key,value]of Object.entries({position:'absolute',top:'16px',bottom:'auto',left:pane===panel?'16px':'auto',right:pane===rail?'16px':'auto',width:width+'px','max-width':width+'px',height:'auto','max-height':'none','min-height':'0px','overflow-y':'visible','overflow-x':'visible',display:'flex'}))set(pane,key,value);
   const bubbleRect=bubble?.getBoundingClientRect(),timelineRect=timeline.getBoundingClientRect();
   let available=Math.max(100,Math.min(timelineRect.top-28,bubbleRect?.height?bubbleRect.top-12:Infinity)-16);
   const fits=()=>[panel,rail].every(pane=>Math.ceil(pane.scrollHeight)<=available+1);
   let density='normal';attr(body,'data-sidebar-density',density);
   if(!fits()){density='compact';attr(body,'data-sidebar-density',density);}
   if(!fits()){
    const left=panel.getBoundingClientRect().right+12,right=rail.getBoundingClientRect().left-12;
    if(bubbleRect?.height&&right-left>=bubbleRect.width){
     set(bubble,'left',((left+right)/2-timelineRect.left)+'px');set(bubble,'right','auto');
     set(bubble,'max-width',(right-left)+'px');set(bubble,'transform','translateX(-50%)');
     available=Math.max(100,timelineRect.top-12-16);
    }
   }
   if(!fits()){density='tight';attr(body,'data-sidebar-density',density);set(rail,'display','grid');}
   const fitted=fits();
   // Enlarged browser fonts need the full-width rows when tightening cannot fit.
   if(!fitted&&density==='tight'){density='normal';attr(body,'data-sidebar-density',density);set(rail,'display','flex');}
   attr(body,'data-sidebar-fit',fitted?'fit':'bounded');
   for(const pane of [panel,rail]){set(pane,'max-height',fitted?'none':available+'px');set(pane,'overflow-y',fitted?'visible':'auto');set(pane,'overflow-x','hidden');if(fitted)pane.scrollTop=0;}
   // Reserve the sticky Flood Data card when the browser scrolls a focused control into view.
   if(!fitted&&sourceCard&&getComputedStyle(sourceCard).position==='sticky'){
    set(panel,'scroll-padding-top',`${Math.ceil(sourceCard.getBoundingClientRect().height)+6}px`);
   }else panel.style.removeProperty('scroll-padding-top');
   const focused=document.activeElement,select=document.getElementById('nwwCompactReturnPeriod');
   if(density==='tight'&&focused?.matches('#returnIntervalCard [data-return-years]'))select?.focus({preventScroll:true});
   else if(density!=='tight'&&focused===select)document.querySelector('#returnIntervalCard [data-return-years].active')?.focus({preventScroll:true});
   const navWidth=document.getElementById('nwDefaultNavControl')?.getBoundingClientRect().width||document.getElementById('countyStandaloneView')?.getBoundingClientRect().width||48;
   const title=document.getElementById('mapTitleBadge'),l=panel.getBoundingClientRect().right+20,r=rail.getBoundingClientRect().left-navWidth-28;if(title){set(title,'left',((l+r)/2)+'px');set(title,'right','auto');set(title,'top','16px');set(title,'max-width',Math.max(100,r-l)+'px');set(title,'transform','translateX(-50%)');}
   const nav=document.getElementById('nwDefaultNavControl'),standaloneButton=document.getElementById('countyStandaloneView');const navRight=innerWidth-rail.getBoundingClientRect().left+14;
   if(nav){set(nav,'right',navRight+'px');set(nav,'left','auto');set(nav,'top','16px');}
   if(standaloneButton)set(standaloneButton,'right',navRight+'px');body.style.setProperty('--county-nav-right',navRight+'px');
  }
  if(typeof positionMapClickModeControl==='function')positionMapClickModeControl();
  for(const e of [panel,rail,timeline,document.getElementById('mapTitleBadge'),bubble])saveStyle(e);
  body.dataset.unifiedLayoutPasses=String(layoutPasses);body.dataset.unifiedLayout=compact?'mobile':'desktop';
  if((document.activeElement===body||document.activeElement===previousFocus)&&visible(focusAfterMove)&&!focusAfterMove.closest('[inert]')){
   focusAfterMove.focus();
  }
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(layout);}
 document.addEventListener('click',event=>{
  if(event.target.closest('#mobileControlsToggle')){if(!mobile.matches)return;event.preventDefault();event.stopImmediatePropagation();setDrawer(!body.classList.contains('mobile-controls-open'));}
  else if(event.target.closest('#mobileControlsClose')){event.preventDefault();event.stopImmediatePropagation();setDrawer(false);}
  else if(mobile.matches&&event.target.closest('#legendDock')&&!event.target.closest('button')){event.preventDefault();event.stopImmediatePropagation();flag(body,'mobile-legend-open',!body.classList.contains('mobile-legend-open'));schedule();}
 },true);
 document.addEventListener('keydown',event=>{
  if(!mobile.matches)return;
  const otherModal=[...document.querySelectorAll('[aria-modal="true"],dialog[open]')].some(e=>e!==panel&&visible(e));if(otherModal)return;
  if(event.key==='Escape'&&body.classList.contains('mobile-legend-open')){event.preventDefault();event.stopImmediatePropagation();flag(body,'mobile-legend-open',false);document.getElementById('legendDock')?.focus();schedule();return;}
  if(body.classList.contains('mobile-controls-open')){
   if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setDrawer(false);}
   else if(event.key==='Tab'){const items=[...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex]')].filter(e=>visible(e)&&e.tabIndex>=0&&!e.closest('[inert]')),first=items[0],last=items.at(-1);if(first&&(!panel.contains(document.activeElement)||(event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last))){event.preventDefault();(event.shiftKey?last:first).focus();}}
  }else if(event.target.closest('#legendDock')&&!event.target.closest('button')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();event.stopImmediatePropagation();flag(body,'mobile-legend-open',!body.classList.contains('mobile-legend-open'));schedule();}
 },true);
 document.addEventListener('nww:reveal-control',event=>{if(mobile.matches&&typeof event.detail==='string'){const element=document.querySelector(event.detail);if(element)selectSection(element.closest('[data-nww-group]')?.dataset.nwwGroup||'forecast');syncDrawer();schedule();}});
 const observer=new MutationObserver(records=>{if(records.some(m=>m.type!=='attributes'||m.attributeName!=='style'||owned.get(m.target)!==m.target.getAttribute('style')))schedule();});
 for(const e of [panel,rail,timeline])observer.observe(e,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','hidden','aria-current','data-nww-section']});
 const geometryObserver=new MutationObserver(records=>{if(records.some(m=>owned.get(m.target)!==m.target.getAttribute('style')))schedule();});
 for(const e of [panel,rail,timeline,document.getElementById('mapTitleBadge'),document.getElementById('timelineBubble')])if(e)geometryObserver.observe(e,{attributes:true,attributeFilter:['style']});
 observer.observe(body,{attributes:true,attributeFilter:['class']});
 for(const modal of document.querySelectorAll('[role="dialog"],dialog,.download-modal,.datum-modal'))if(modal!==panel)observer.observe(modal,{attributes:true,attributeFilter:['class','hidden','open','aria-modal','style']});
 const resizeObserver=new ResizeObserver(schedule);for(const element of [timeline,panel,rail])resizeObserver.observe(element);if(sourceCard)resizeObserver.observe(sourceCard);mobile.addEventListener('change',schedule);addEventListener('resize',schedule,{passive:true});window.visualViewport?.addEventListener('resize',schedule,{passive:true});window.visualViewport?.addEventListener('scroll',schedule,{passive:true});
 document.fonts?.ready.then(schedule);document.fonts?.addEventListener?.('loadingdone',schedule);
 addEventListener('load',schedule,{once:true});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});
 layout();
})();
