/* Shared Avalon phone layout for all ShorelySafe floodmappers. */
(() => {
  const media = matchMedia('(max-width:900px), (max-height:560px) and (pointer:coarse)');
  const panel = document.getElementById('leftPanel');
  const app = document.getElementById('app');
  const legend = document.getElementById('legendDock');
  const timeline = document.getElementById('timelineDock');
  const days = document.getElementById('timelineDayTabs');
  const interval = document.getElementById('timelineIntervalToggle');
  const intervalParent = interval?.parentNode;
  const intervalNext = interval?.nextSibling;
  if (!panel || !app || !legend || !timeline || !days) return;

  const panelParent = panel.parentNode;
  const panelNext = panel.nextSibling;
  let wasMobile = false;
  const before = document.createElement('button');
  const after = document.createElement('button');
  for (const [button, id, symbol, label] of [[before, 'timelinePreviousDay', '‹', 'Previous'], [after, 'timelineNextDay', '›', 'Next']]) {
    button.id = id;
    button.className = 'timeline-day-arrow';
    button.type = 'button';
    button.innerHTML = symbol === '‹' ? '<span aria-hidden="true">‹</span><span class="neighbor-day">Previous</span>' : '<span class="neighbor-day">Next</span><span aria-hidden="true">›</span>';
    button.setAttribute('aria-label', `${label} day`);
  }
  days.before(before);
  days.after(after);

  // The 3D mappers kept the legend visible but left its old click handler
  // empty. Give the compact Map key the same disclosure behavior as Avalon.
  legend.setAttribute('role', 'button');
  legend.setAttribute('tabindex', '0');
  legend.setAttribute('aria-label', 'Flood map legend');
  const toggleLegend = event => {
    if (!media.matches || event.target.closest('button')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const open = !document.body.classList.contains('mobile-legend-open');
    document.body.classList.toggle('mobile-legend-open', open);
    legend.setAttribute('aria-expanded', String(open));
  };
  legend.addEventListener('click', toggleLegend, true);
  legend.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') toggleLegend(event);
    if (event.key === 'Escape' && document.body.classList.contains('mobile-legend-open')) {
      document.body.classList.remove('mobile-legend-open');
      legend.setAttribute('aria-expanded', 'false');
      legend.focus({preventScroll:true});
    }
  }, true);
  document.addEventListener('click', event => {
    if (!media.matches || legend.contains(event.target)) return;
    document.body.classList.remove('mobile-legend-open');
    legend.setAttribute('aria-expanded', 'false');
  });

  function dayButtons() { return [...days.querySelectorAll('button')].filter(button => button.classList.contains('timeline-day')); }
  function activeDayIndex(buttons) { return Math.max(0, buttons.findIndex(button => button.classList.contains('active') || button.getAttribute('aria-current') === 'date')); }
  function syncDayButtons() {
    const buttons = dayButtons();
    const index = activeDayIndex(buttons);
    for (const [button, offset] of [[before, -1], [after, 1]]) {
      const neighbor = buttons[index + offset];
      button.disabled = !neighbor;
      const text = neighbor?.textContent?.trim() || (offset < 0 ? 'Start' : 'End');
      button.querySelector('.neighbor-day').textContent = text;
      button.setAttribute('aria-label', neighbor ? `${offset < 0 ? 'Previous' : 'Next'} day: ${text}` : `No ${offset < 0 ? 'earlier' : 'later'} day available`);
    }
  }
  for (const [button, offset] of [[before, -1], [after, 1]]) {
    button.addEventListener('click', () => {
      const buttons = dayButtons();
      buttons[activeDayIndex(buttons) + offset]?.click();
    });
  }

  function syncLayout() {
    const mobile = media.matches;
    const open = mobile && document.body.classList.contains('mobile-controls-open');
    if (mobile) {
      if (!wasMobile) {
        const properties = ['position','top','right','bottom','left','width','min-width','max-width','height','min-height','max-height','margin','padding','transform','translate','display','visibility','overflow','z-index','flex','font-size'];
        for (const id of ['timelineDock','timelineBubble','timelineDayTabs','playBtn','hourSlider','pjBlueSliderExactTrackLine','mapTitleBadge','mapTitleText','mobileControlsToggle','legendDock']) {
          const element = document.getElementById(id);
          if (element) properties.forEach(property => element.style.removeProperty(property));
        }
      }
      if (panel.parentNode !== document.body) document.body.appendChild(panel);
      // The mapper's existing mobile legend layout owns its placement.
      if (interval && intervalParent && timeline.contains(intervalParent)) {
        const sourceCard = panel.querySelector('.data-source-card');
        if (sourceCard && sourceCard.nextElementSibling !== interval) sourceCard.after(interval);
        else if (!sourceCard && interval.parentNode !== panel) panel.appendChild(interval);
      }
      panel.inert = !open;
      panel.setAttribute('aria-label', 'Map controls');
      if (open) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
      else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
      const map = document.getElementById('map3d') || document.getElementById('map');
      if (map) map.inert = open;
      timeline.inert = open;
      legend.setAttribute('aria-expanded', String(document.body.classList.contains('mobile-legend-open')));
    } else {
      if (panel.parentNode !== panelParent) panelParent.insertBefore(panel, panelNext?.parentNode === panelParent ? panelNext : null);
      // The mapper's desktop pane layout owns its placement.
      if (interval && intervalParent && interval.parentNode !== intervalParent) intervalParent.insertBefore(interval, intervalNext?.parentNode === intervalParent ? intervalNext : null);
      panel.inert = false;
      panel.removeAttribute('role'); panel.removeAttribute('aria-modal');
      const map = document.getElementById('map3d') || document.getElementById('map');
      if (map) map.inert = false;
      timeline.inert = false;
    }
    wasMobile = mobile;
    syncDayButtons();
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncLayout(); });
  }
  new MutationObserver(schedule).observe(document.body, {attributes:true, attributeFilter:['class']});
  new MutationObserver(schedule).observe(app, {childList:true});
  new MutationObserver(schedule).observe(panel, {childList:true});
  new MutationObserver(schedule).observe(days, {childList:true, subtree:true, attributes:true, attributeFilter:['class','aria-current']});
  media.addEventListener('change', schedule);
  window.addEventListener('load', schedule, {once:true});
  window.addEventListener('resize', schedule, {passive:true});
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !media.matches || !document.body.classList.contains('mobile-controls-open') || document.querySelector('#infoModal.open,#datumModal.open,#downloadModal.open,#topTidesModal.open')) return;
    const items = [...panel.querySelectorAll('button,input,select,a[href],[tabindex="0"]')].filter(element => !element.disabled && !element.closest('[hidden]') && element.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (!first) return;
    if (!panel.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  });
  syncLayout();
})();
