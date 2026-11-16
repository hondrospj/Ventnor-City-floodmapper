(function () {
  "use strict";
  if (window.NORTH_WILDWOOD_EXPORT_PICKER) return;
  const ID = "nwwExportDateTimePicker";
  const ranks = { unknown: -1, none: 0, minor: 1, moderate: 2, major: 3 };
  const labels = { unknown: "Data gap", none: "Below minor", minor: "Minor", moderate: "Moderate", major: "Major" };
  let active = null;
  const stageMaps = new Map();

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function button(text, label, action) {
    const element = node("button", "", text);
    element.type = "button";
    if (label) element.setAttribute("aria-label", label);
    element.addEventListener("click", event => { event.preventDefault(); action(); });
    return element;
  }
  function key() {
    const wrap = node("div", "calendar-key nww-picker-key");
    wrap.setAttribute("aria-label", "Flood stage key");
    for (const [severity, threshold] of [["minor", MINOR_FLOOD_FT], ["moderate", MODERATE_FLOOD_FT], ["major", MAJOR_FLOOD_FT]]) {
      const item = node("span", `calendar-key-item ${severity}`);
      const swatch = node("span", "calendar-key-swatch");
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, node("span", "", labels[severity]));
      item.title = `${labels[severity]} starts at ${formatStageForDisplay(threshold)} ${getDatumLabel()}`;
      wrap.append(item);
    }
    return wrap;
  }
  function dayKey(date) { return getExportDayKeyFromDate(date); }
  function monthDate(year, month) { return new Date(Date.UTC(year, month - 1, 1, 12)); }
  function shiftDay(value, amount) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + amount, 12));
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }
  function severity(stage) { return Number.isFinite(stage) ? classifyFloodStage(stage) : "unknown"; }
  function daySeverity(value, forecast = getForecastExportEntriesLimited()) {
    let category = "unknown";
    const observed = getObservedExportDayIndex().get(value);
    if (observed) {
      const peak = normalizeStageValue(observed.peakNAVD88);
      if (Number.isFinite(peak)) category = severity(peak);
      const stored = String(observed.classification || "").toLowerCase();
      if (!Number.isFinite(peak) && ["minor", "moderate", "major"].includes(stored)) category = stored;
      for (const entry of observed.hours || []) {
        const next = severity(getStageValue(entry));
        if (ranks[next] > ranks[category]) category = next;
      }
    }
    for (const entry of forecast) if (dayKey(getEntryESTDate(entry)) === value) {
      const next = severity(getStageValue(entry));
      if (ranks[next] > ranks[category]) category = next;
    }
    return category;
  }
  function timeStages(value) {
    if (currentDataMode === "return-interval") {
      return new Map(getReturnIntervalExportEntries().map(entry => [
        entryTimeMs(entry), { stage: getStageValue(entry), source: entry.exportSourceMode }
      ]));
    }
    const startDate = parseStoredLocalNyToDate(`${value}T00:00`);
    const endDate = parseStoredLocalNyToDate(`${value}T23:59`);
    if (!startDate || !endDate) return new Map();
    const entries = getDownloadSourceEntries(true, startDate, endDate);
    const startMs = startDate.getTime(), endMs = endDate.getTime();
    const rows = getQuarterHourExportEntries(entries, { startMs, endMs });
    const stages = new Map(rows.map(entry => [entryTimeMs(entry), { stage: getStageValue(entry), source: entry.exportSourceMode }]));
    for (const entry of entries) {
      if (!entry.isDailyPeakOnly || entry.peakTimeKnown !== true) continue;
      const crestInstant = entryTimeMs(entry);
      if (Number.isFinite(crestInstant) && crestInstant >= startMs && crestInstant <= endMs && !stages.has(crestInstant)) {
        stages.set(crestInstant, { stage: getStageValue(entry), source: entry.exportSourceMode, crestInstant });
      }
    }
    return stages;
  }
  function optionInstant(value, isoDate) {
    const selection = getExportTimeSelection(value);
    if (!selection) return null;
    if (Number.isFinite(selection.instantMs)) return selection.instantMs;
    return getLocalNyDateCandidates(`${isoDate}T${selection.time}`)[0]?.getTime() ?? null;
  }
  function cachedTimeStages(value) {
    const observed = getObservedExportDayIndex();
    const forecastHours = getActiveForecastHours();
    const forecast = forecastHours.length ? forecastHours : null;
    const series = currentDataMode === "return-interval" ? currentRawSeriesHours : currentSeriesHours;
    const previous = stageMaps.get(value);
    if (previous && previous.mode === currentDataMode && previous.observed === observed && previous.forecast === forecast && previous.series === series) return previous.stages;
    const stages = timeStages(value);
    if (stageMaps.size >= 4) stageMaps.clear();
    stageMaps.set(value, {mode:currentDataMode,observed,forecast,series,stages});
    return stages;
  }
  function revealExportAnchor(anchor) {
    const card = anchor.closest(".download-modal-card");
    if (!card) return;
    anchor.scrollIntoView({ block: "nearest", inline: "nearest" });
    const cardBox = card.getBoundingClientRect();
    const head = card.querySelector(".download-modal-head");
    const actions = card.querySelector(".download-actions");
    // Sticky modal controls can cover an element inside the scroll viewport.
    const top = head && getComputedStyle(head).position === "sticky"
      ? Math.max(cardBox.top, head.getBoundingClientRect().bottom) : cardBox.top;
    const bottom = actions && getComputedStyle(actions).position === "sticky"
      ? Math.min(cardBox.bottom, actions.getBoundingClientRect().top) : cardBox.bottom;
    const box = anchor.getBoundingClientRect();
    if (box.top < top) card.scrollTop += box.top - top - 4;
    else if (box.bottom > bottom) card.scrollTop += box.bottom - bottom + 4;
  }
  function close(restoreFocus = false) {
    if (!active) return;
    const previous = active;
    active = null;
    previous.panel.remove();
    previous.anchor.setAttribute("aria-expanded", "false");
    if (previous.kind === "date") getExportDateEditorElements(previous.prefix).dateText?.setAttribute("aria-expanded", "false");
    document.getElementById(`download${previous.prefix === "end" ? "End" : "Start"}CalendarBtn`)?.setAttribute("aria-expanded", "false");
    const returnFocus = previous.returnFocus || previous.anchor;
    if (restoreFocus && returnFocus.isConnected) {
      returnFocus.focus({ preventScroll: true });
      if (document.activeElement === returnFocus) revealExportAnchor(returnFocus);
    }
  }
  function position() {
    if (!active) return;
    const { anchor, panel } = active;
    if (!isDownloadModalOpen() || anchor.closest("[hidden],[inert]") || exportInProgress) { close(); return; }
    const rect = anchor.getBoundingClientRect();
    const card = panel.parentElement.getBoundingClientRect();
    const width = Math.max(240, Math.min(360, innerWidth - 24, card.width - 24));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${innerHeight - 24}px`;
    const height = panel.getBoundingClientRect().height;
    const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
    const below = rect.bottom + 6;
    const top = below + height <= innerHeight - 12 ? below : Math.max(12, Math.min(rect.top - height - 6, innerHeight - height - 12));
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
    // Account for a containing transform on a modal card without moving it.
    const actual = panel.getBoundingClientRect();
    panel.style.left = `${left + left - actual.left}px`;
    panel.style.top = `${top + top - actual.top}px`;
  }
  function create(prefix, kind, anchor) {
    close();
    const card = document.querySelector("#downloadModal .download-modal-card");
    if (!card || !anchor || anchor.disabled || exportInProgress) return null;
    const panel = node("section", "nww-export-picker");
    panel.id = ID; panel.dataset.kind = kind; panel.dataset.prefix = prefix;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "nwwExportPickerTitle");
    const heading = node("header", "nww-picker-head");
    const title = node("strong", "", `${prefix === "end" ? "End" : "Start"} ${kind === "date" ? "date" : "time"}`);
    title.id = "nwwExportPickerTitle";
    heading.append(title, button("×", "Close date and time picker", () => close(true)));
    panel.append(heading); card.append(panel);
    anchor.setAttribute("aria-expanded", "true"); anchor.setAttribute("aria-controls", ID);
    if (kind === "date") {
      for (const trigger of [getExportDateEditorElements(prefix).dateText, document.getElementById(`download${prefix === "end" ? "End" : "Start"}CalendarBtn`)]) {
        trigger?.setAttribute("aria-expanded", "true"); trigger?.setAttribute("aria-controls", ID);
      }
    }
    active = { prefix, kind, anchor, panel };
    return active;
  }
  function renderCalendar(state, focusKey = "") {
    if (active !== state) return;
    const { prefix, panel } = state;
    const days = getExportAvailabilityDayMap(), bounds = getExportAvailabilityBounds();
    const previousFocus = panel.contains(document.activeElement) ? document.activeElement : null;
    const focusedDay = focusKey || previousFocus?.dataset.date || "";
    const focusedControl = previousFocus?.getAttribute("aria-label");
    panel.querySelectorAll(":scope > :not(.nww-picker-head)").forEach(element => element.remove());
    if (!bounds || !days.size) { panel.append(node("p", "nww-picker-message", "Loading available dates…")); position(); return; }
    const selected = getRangeInputDate(prefix === "end" ? "downloadEndInput" : "downloadStartInput");
    const parts = getNyParts(state.cursor || selected || bounds.firstDate);
    const first = getNyParts(bounds.firstDate), last = getNyParts(bounds.lastDate);
    const year = Number(parts.year), month = Number(parts.month);
    const nav = node("div", "nww-picker-navigation");
    const monthInput = node("select"); monthInput.setAttribute("aria-label", "Calendar month");
    for (let m = 1; m <= 12; m++) {
      const option = node("option", "", new Intl.DateTimeFormat("en-US", {month:"long",timeZone:"UTC"}).format(monthDate(year,m)));
      option.value = String(m); option.disabled = !getExportAvailabilityMonthMap().has(`${year}-${pad2(m)}`); monthInput.append(option);
    }
    monthInput.value = String(month);
    const yearInput = node("select"); yearInput.setAttribute("aria-label", "Calendar year");
    for (let y = Number(first.year); y <= Number(last.year); y++) { const option = node("option", "", String(y)); option.value = String(y); yearInput.append(option); }
    yearInput.value = String(year);
    const changeMonth = amount => { state.cursor = monthDate(year,month + amount); renderCalendar(state); };
    const previous = button("‹", "Previous month", () => changeMonth(-1));
    const next = button("›", "Next month", () => changeMonth(1));
    previous.disabled = `${year}-${pad2(month)}` <= getExportMonthKey(bounds.firstDate);
    next.disabled = `${year}-${pad2(month)}` >= getExportMonthKey(bounds.lastDate);
    for (const input of [monthInput,yearInput]) input.addEventListener("change", () => {
      const selectedYear = Number(yearInput.value), monthMap = getExportAvailabilityMonthMap();
      let selectedMonth = Number(monthInput.value);
      if (!monthMap.has(`${selectedYear}-${pad2(selectedMonth)}`)) selectedMonth = Array.from({length:12},(_,index)=>index+1).find(value=>monthMap.has(`${selectedYear}-${pad2(value)}`)) || 1;
      state.cursor = monthDate(selectedYear,selectedMonth); renderCalendar(state);
    });
    nav.append(previous,monthInput,yearInput,next); panel.append(nav);
    const weekdays = node("div", "calendar-head nww-picker-weekdays");
    for (const day of ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]) weekdays.append(node("span","",day));
    const grid = node("div", "calendar-grid nww-picker-days"); grid.setAttribute("aria-label", `${monthInput.selectedOptions[0]?.textContent} ${year} dates`);
    const firstWeekday = new Date(Date.UTC(year,month-1,1)).getUTCDay();
    for (let i=0;i<firstWeekday;i++) grid.append(node("span","calendar-day empty"));
    const forecast = currentDataMode === "return-interval" ? getReturnIntervalExportEntries() : getForecastExportEntriesLimited();
    const selectedKey = selected ? dayKey(selected) : "";
    for (let day=1;day<=new Date(Date.UTC(year,month,0)).getUTCDate();day++) {
      const value = `${year}-${pad2(month)}-${pad2(day)}`, meta = days.get(value);
      const category = meta ? daySeverity(value,forecast) : "unknown";
      if (!meta && (value < dayKey(bounds.firstDate) || value > dayKey(bounds.lastDate))) {
        grid.append(node("span", "calendar-day empty"));
        continue;
      }
      const choice = button(String(day), `${formatSelectedObservedDate(value)}, ${meta ? labels[category] : "No export data"}`, () => {
        const editor = getExportDateEditorElements(prefix);
        editor.datePicker.value = value;
        editor.datePicker.dispatchEvent(new Event("change", {bubbles:true}));
        close(true);
      });
      choice.className = `calendar-day day-${category}`;
      choice.dataset.date = value; choice.dataset.severity = category;
      choice.disabled = !meta; choice.tabIndex = -1;
      choice.classList.toggle("selected", value === selectedKey);
      choice.setAttribute("aria-pressed", String(value === selectedKey));
      grid.append(choice);
    }
    panel.append(weekdays,grid,key(),node("p","nww-picker-note","Day colors show the daily peak."));
    const target = grid.querySelector(`[data-date="${focusedDay || selectedKey}"]:not(:disabled)`) || grid.querySelector("button:not(:disabled)");
    if (target) target.tabIndex = 0;
    position();
    if (focusedDay && target) target.focus({preventScroll:true});
    else if (focusedControl) [...nav.children].find(element=>element.getAttribute("aria-label")===focusedControl)?.focus({preventScroll:true});
  }
  function openDate(prefix, focusCalendar = true, opener = null) {
    if (currentDataMode === "return-interval") return;
    const editor = getExportDateEditorElements(prefix);
    const anchor = focusCalendar ? document.getElementById(`download${prefix === "end" ? "End" : "Start"}CalendarBtn`) : editor.dateText;
    if (!anchor || editor.dateText.disabled) return;
    const state = create(prefix,"date",anchor); if (!state) return;
    state.returnFocus = opener || anchor;
    state.cursor = getRangeInputDate(editor.canonical.id) || new Date();
    renderCalendar(state, focusCalendar ? dayKey(state.cursor) : "");
    Promise.resolve(ensureExportArchiveAvailability()).then(() => {
      if (active === state) renderCalendar(state);
    }).catch(() => { if(active===state) state.panel.append(node("p","nww-picker-message","Additional dates could not load. Close and try again.")); });
  }
  function syncTimeButton(prefix) {
    const editor = getExportDateEditorElements(prefix), trigger = document.getElementById(`download${prefix === "end" ? "End" : "Start"}TimeButton`);
    if (!trigger || !editor.timeSelect) return;
    const date = getRangeInputDate(editor.canonical.id), value = parseExportDateText(editor.dateText.value)?.isoDate || (date ? dayKey(date) : "");
    const stages = value ? cachedTimeStages(value) : null;
    const instant = value ? optionInstant(editor.timeSelect.value, value) : null;
    const record = stages?.get(instant);
    const category = severity(record?.stage), timeLabel = editor.timeSelect.selectedOptions[0]?.textContent || "Choose time";
    const peak = !stages?.size && value ? dateOnlyPeak(value) : null;
    const selectedPeak = peak && peak.instant === instant;
    const level = record ? `${formatStageForDisplay(record.stage)} ${getDatumLabel()} · ${labels[category]}`
      : selectedPeak ? `${formatStageForDisplay(peak.stage)} ${getDatumLabel()}` : "";
    const selectedTimeLabel = selectedPeak ? "Daily peak" : timeLabel;
    const display = `${selectedTimeLabel}|${level}`;
    if (trigger.dataset.display !== display) {
      trigger.replaceChildren(node("span", "", `${selectedTimeLabel} ▾`));
      if (level) trigger.append(node("small", "", level));
      trigger.dataset.display = display;
    }
    if (trigger.dataset.severity !== category) {
      trigger.classList.remove(...Object.keys(ranks).map(value=>`day-${value}`)); trigger.classList.add(`day-${category}`); trigger.dataset.severity = category;
    }
    if (trigger.disabled !== editor.timeSelect.disabled) trigger.disabled = editor.timeSelect.disabled;
    trigger.setAttribute("aria-label", `Export ${prefix} time, ${selectedTimeLabel}${level ? `, ${level}` : ""}`);
  }
  function dateOnlyPeak(value) {
    if (currentDataMode === "return-interval") return null;
    const day = getObservedExportDayIndex().get(value);
    const stage = normalizeStageValue(day?.peakNAVD88);
    const instant = parseStoredLocalNyToDate(`${value}T00:00`)?.getTime();
    return Number.isFinite(stage) && Number.isFinite(instant) ? { stage, instant } : null;
  }

  function timeChoices(options, day, stages, peak = null) {
    const first = Math.min(...stages.keys()), last = Math.max(...stages.keys());
    const choices = Array.from(options).flatMap(option => {
      const instant = optionInstant(option.value, day);
      if (peak?.instant === instant) return [{ option, record: peak, dateOnly: true }];
      if (instant == null || instant < first || instant > last) return [];
      return [{ option, record: stages.get(instant), dateOnly: false }];
    });
    for (const [instant, record] of stages) {
      if (record.crestInstant !== instant || choices.some(choice => choice.record === record)) continue;
      const time = formatNyLocalIso(new Date(instant)).slice(11);
      const option = { value: `${time}|${instant}`, textContent: formatExportTimeLabel(time), selected: false };
      const position = choices.findIndex(choice => optionInstant(choice.option.value, day) > instant);
      choices.splice(position < 0 ? choices.length : position, 0, { option, record, dateOnly: false });
    }
    return choices;
  }

  function renderTimes(state, stages, loading = false) {
    if (active !== state) return;
    const editor = getExportDateEditorElements(state.prefix);
    const previousFocus = state.panel.contains(document.activeElement) ? document.activeElement?.dataset.value : null;
    state.panel.querySelectorAll(":scope > :not(.nww-picker-head)").forEach(element => element.remove());
    const list = node("div", "nww-picker-times"); list.setAttribute("role","listbox"); list.setAttribute("aria-label",`${state.prefix} time`);
    const peak = !loading && !stages.size ? dateOnlyPeak(state.day) : null;
    for (const { option, record, dateOnly } of timeChoices(editor.timeSelect.options, state.day, stages, peak)) {
      const knownCrest = Number.isFinite(record?.crestInstant);
      if (loading && knownCrest) continue;
      const category = severity(record?.stage);
      const choice = button("", "", () => {
        close();
        if (knownCrest) populateExportTimeSelect(editor.timeSelect, option.value, state.day, new Date(record.crestInstant));
        else editor.timeSelect.value = option.value;
        editor.timeSelect.dispatchEvent(new Event("change", {bubbles:true}));
        syncTimeButton(state.prefix); state.anchor.focus({preventScroll:true});
      });
      choice.className = `nww-time-option day-${category}`;
      choice.dataset.value = option.value; choice.dataset.severity = category;
      choice.setAttribute("role","option"); choice.setAttribute("aria-selected",String(option.selected));
      choice.disabled = option.disabled || !record;
      choice.tabIndex = option.selected && !choice.disabled ? 0 : -1;
      const level = record ? `${formatStageForDisplay(record.stage)} ${getDatumLabel()}${dateOnly ? "" : ` · ${labels[category]}`}` : labels.unknown;
      choice.append(node("span", "", dateOnly ? "Daily peak · time unknown" : option.textContent), node("small", "", level));
      list.append(choice);
    }
    if (list.children.length) state.panel.append(list, key());
    else {
      const status = node("p", "nww-picker-message", loading ? "Loading available times…" : "No export times for this date.");
      status.setAttribute("role", "status");
      state.panel.append(status);
    }
    position();
    const target = [...list.children].find(choice => !choice.disabled && choice.dataset.value === (previousFocus || editor.timeSelect.value)) || list.querySelector("button:not(:disabled)");
    if (target) {
      target.tabIndex = 0;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    } else if (!state.panel.contains(document.activeElement)) state.panel.querySelector(".nww-picker-head button")?.focus({ preventScroll: true });
  }
  function openTime(prefix) {
    const editor = getExportDateEditorElements(prefix), cap = prefix === "end" ? "End" : "Start";
    const state = create(prefix,"time",document.getElementById(`download${cap}TimeButton`)); if (!state) return;
    state.day = parseExportDateText(editor.dateText.value)?.isoDate || dayKey(getRangeInputDate(editor.canonical.id));
    const startDate = parseStoredLocalNyToDate(`${state.day}T00:00`), endDate = parseStoredLocalNyToDate(`${state.day}T23:59`);
    const loadsArchive = startDate && endDate && currentDataMode !== "return-interval"
      && exportRangeNeedsObservedArchive({ startDate, endDate });
    renderTimes(state, cachedTimeStages(state.day), loadsArchive);
    if (loadsArchive) {
      ensureObservedArchiveRange(startDate,endDate).then(() => { stageMaps.delete(state.day); syncTimeButton(prefix); if(active===state) renderTimes(state,cachedTimeStages(state.day)); })
        .catch(() => {
          if (active !== state) return;
          renderTimes(state, cachedTimeStages(state.day));
          state.panel.append(node("p", "nww-picker-message", "Additional times could not load. Close and try again."));
          position();
        });
    }
  }
  function init() {
    const modal = document.getElementById("downloadModal"); if (!modal) return;
    for (const prefix of ["start","end"]) {
      const cap = prefix === "end" ? "End" : "Start", editor = getExportDateEditorElements(prefix);
      const calendarButton = document.getElementById(`download${cap}CalendarBtn`);
      if (!editor.dateText || !editor.timeSelect || !calendarButton) continue;
      editor.datePicker.hidden = true; editor.datePicker.tabIndex = -1;
      editor.dateText.setAttribute("role","combobox");
      for (const anchor of [calendarButton,editor.dateText]) { anchor.setAttribute("aria-haspopup","dialog"); anchor.setAttribute("aria-expanded","false"); }
      calendarButton.addEventListener("click",event => {event.preventDefault();event.stopImmediatePropagation();openDate(prefix);},true);
      editor.dateText.addEventListener("click",() => openDate(prefix,false));
      editor.dateText.addEventListener("keydown",event => {
        if(event.key === "ArrowDown"){event.preventDefault();openDate(prefix,true,editor.dateText);}
        else if (/^\d$/.test(event.key) || ["Backspace","Delete"].includes(event.key)) close();
      });
      const wrap = node("div","nww-export-time-control"); editor.timeSelect.before(wrap); wrap.append(editor.timeSelect);
      editor.timeSelect.classList.add("nww-canonical-time-select"); editor.timeSelect.tabIndex = -1; editor.timeSelect.setAttribute("aria-hidden","true");
      const trigger = button("Choose time ▾",`Export ${prefix} time`,() => openTime(prefix));
      trigger.id = `download${cap}TimeButton`; trigger.className = "export-time-select nww-time-trigger";
      trigger.setAttribute("aria-haspopup","listbox"); trigger.setAttribute("aria-expanded","false"); wrap.append(trigger);
      editor.timeSelect.addEventListener("change",() => syncTimeButton(prefix)); syncTimeButton(prefix);
    }
    const originalPopulate = populateExportTimeSelect;
    populateExportTimeSelect = function(select,...args) { const value = originalPopulate(select,...args); syncTimeButton(select.id.includes("End")?"end":"start"); return value; };
    openExportDatePicker = prefix => openDate(prefix);
    document.addEventListener("pointerdown",event => {if(active&&!active.panel.contains(event.target)&&event.target!==active.anchor&&!event.target.closest(".export-date-control,.nww-export-time-control"))close();},true);
    document.addEventListener("keydown",event => {
      if(!active)return;
      if(event.key === "Escape"){event.preventDefault();event.stopImmediatePropagation();close(true);return;}
      if(!active.panel.contains(event.target))return;
      if(event.key === "Tab") {
        const controls=[...active.panel.querySelectorAll('button:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(element=>element.tabIndex>=0);
        if((event.shiftKey&&event.target===controls[0])||(!event.shiftKey&&event.target===controls.at(-1))) {
          const anchor=active.anchor,card=active.panel.parentElement;
          event.preventDefault();event.stopImmediatePropagation();close();
          const items=[...card.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),[tabindex="0"]')]
            .filter(element=>element.tabIndex>=0&&!element.closest('[hidden],[inert],[aria-hidden="true"]')&&element.getClientRects().length);
          const index=items.indexOf(anchor),next=items[(index+(event.shiftKey?-1:1)+items.length)%items.length];
          (next||anchor).focus({preventScroll:true});
        }
        return;
      }
      if(active.kind === "time" && ["ArrowDown","ArrowUp","Home","End"].includes(event.key)) {
        event.preventDefault(); const options=[...active.panel.querySelectorAll('[role="option"]:not(:disabled)')];
        let index=options.indexOf(document.activeElement); index=event.key==="Home"?0:event.key==="End"?options.length-1:(index+(event.key==="ArrowDown"?1:-1)+options.length)%options.length;
        options.forEach(option=>option.tabIndex=-1);if(options[index]){options[index].tabIndex=0;options[index].focus();}return;
      }
      if(active.kind === "date" && event.target.dataset.date && ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) {
        event.preventDefault(); const amount={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key],days=getExportAvailabilityDayMap();
        let target=shiftDay(event.target.dataset.date,amount),attempts=0;
        while(!days.has(target)&&attempts++<366)target=shiftDay(target,amount<0?-1:1);
        if(days.has(target)){active.cursor=monthDate(Number(target.slice(0,4)),Number(target.slice(5,7)));renderCalendar(active,target);}
      }
    },true);
    new MutationObserver(() => {if(active)position();for(const prefix of ["start","end"])syncTimeButton(prefix);})
      .observe(modal,{attributes:true,subtree:true,attributeFilter:["class","hidden","disabled"]});
    window.addEventListener("resize", () => {
      position();
      const focus = document.activeElement;
      if (active?.panel.contains(focus)) focus.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    window.addEventListener("scroll",position,true);
    window.NORTH_WILDWOOD_EXPORT_PICKER.ready = true;
  }
  window.NORTH_WILDWOOD_EXPORT_PICKER = {ready:false,openDate,openTime,close,data:{daySeverity,timeStages,optionInstant,timeChoices}};
  if(document.readyState === "loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();
