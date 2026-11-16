/* Mobile navigation only. Existing controls and flood calculations remain app-owned. */
(() => {
  const unifiedOwnsLayout = () => Boolean(document.body.dataset.unifiedUiReady);
  if (unifiedOwnsLayout()) return;
  const panel = document.getElementById('leftPanel');
  if (!panel) return;
  const mobile = floodmapperLayoutMedia;
  const groups = {
    forecast: '.data-source-card,#forecastScenarioCard,#returnIntervalCard,#timelineIntervalCard,#calendarCard',
    map: '.overlay-card,.datum-card,.opacity-card,.layers-card',
    tools: '#townAddressCard,#downloadCard,#mapperTutorialBtn'
  };
  for (const [group, selector] of Object.entries(groups)) {
    document.querySelectorAll(selector).forEach(card => card.dataset.nwwGroup = group);
  }
  const header = document.createElement('div');
  header.id = 'nwwMobileControlHeader';
  header.innerHTML = '<div class="nww-drawer-heading"><h2 id="nwwControlsTitle">Map controls</h2><p>North Wildwood</p></div><div class="nww-control-tabs" role="tablist" aria-label="Control sections"><button id="nwwForecastTab" type="button" role="tab" data-group="forecast">Flood data</button><button id="nwwMapTab" type="button" role="tab" data-group="map">Map layers</button><button id="nwwToolsTab" type="button" role="tab" data-group="tools">Tools</button></div>';
  panel.prepend(header);
  const tabs = [...header.querySelectorAll('[role=tab]')];
  function selectGroup(group, focus = false) {
    if (unifiedOwnsLayout()) return;
    panel.dataset.nwwSection = group;
    for (const tab of tabs) {
      const selected = tab.dataset.group === group;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus({preventScroll:true});
    }
    panel.scrollTop = 0;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectGroup(tab.dataset.group));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); selectGroup(tabs[next].dataset.group, true); }
    });
  });
  selectGroup('forecast');
  let wasOpen = false;
  const toggle = document.getElementById('mobileControlsToggle');
  function sync() {
    if (unifiedOwnsLayout()) return;
    const open = mobile.matches && document.body.classList.contains('mobile-controls-open');
    if (open && !wasOpen) {
      document.body.classList.remove('mobile-legend-open');
      panel.setAttribute('aria-labelledby', 'nwwControlsTitle');
      // The drawer controller clears inert in its scheduled layout pass.
      requestAnimationFrame(() => {
        if (unifiedOwnsLayout()) return;
        if (document.body.classList.contains('mobile-controls-open') && !panel.inert &&
            !document.body.classList.contains('tutorial-active') &&
            !document.querySelector('#infoModal.open,#datumModal.open,#downloadModal.open,#topTidesModal.open')) {
          tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.focus({preventScroll:true});
        }
      });
    } else if (!open && wasOpen) {
      panel.removeAttribute('aria-labelledby');
      if (mobile.matches && !document.querySelector('#mapperTutorial:not([hidden]),.download-modal.open,.datum-modal.open,#infoModal.open')) toggle?.focus({preventScroll:true});
    }
    wasOpen = open;
  }
  new MutationObserver(sync).observe(document.body, {attributes:true, attributeFilter:['class']});
  mobile.addEventListener('change', sync);
  // Select the right section before the existing tour measures its target.
  document.addEventListener('nww:reveal-control', event => {
    if (unifiedOwnsLayout()) return;
    if (!mobile.matches) return;
    const group = document.querySelector(event.detail)?.closest('[data-nww-group]')?.dataset.nwwGroup;
    if (group && group !== panel.dataset.nwwSection) selectGroup(group);
  });
  sync();
})();
