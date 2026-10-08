/* Geographic area selection shared by current and legacy FloodMapper exports. */
(function () {
  "use strict";
  if (window.FLOODMAPPER_EXPORT_AREA) return;

  let selectedBounds = null;
  let jobBounds = null;
  let pendingBounds = null;
  let pickerMap = null;
  let rectangle = null;
  let drawing = false;
  let firstCorner = null;
  let gesture = null;
  let savedInteractions = [];
  let previousFocus = null;

  const copyBounds = bounds => bounds && L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
  const validBounds = bounds => bounds && bounds.isValid() &&
    [bounds.getSouth(), bounds.getNorth(), bounds.getWest(), bounds.getEast()].every(Number.isFinite) &&
    bounds.getNorth() > bounds.getSouth() && bounds.getEast() > bounds.getWest();
  const customMode = () => document.getElementById("downloadExtentSelect")?.value === "custom";
  const chosenBounds = () => jobBounds || selectedBounds;

  const originalExtent = getDownloadExtentValue;
  getDownloadExtentValue = function () {
    return customMode() && validBounds(chosenBounds()) ? "custom" : originalExtent();
  };

  const originalFit = fitExportMapToSelectedExtent;
  fitExportMapToSelectedExtent = function (mapInstance) {
    if (getDownloadExtentValue() !== "custom") return originalFit(mapInstance);
    if (!mapInstance) return;
    const bounds = copyBounds(chosenBounds());
    // Keep all of the chosen rectangle visible even when a different layout is selected.
    mapInstance.options.zoomSnap = 0;
    // Two pixels per edge also cover Leaflet's rounding of the map's pixel origin.
    const zoom = mapInstance.getBoundsZoom(bounds, false, L.point(4, 4));
    const nw = mapInstance.project(bounds.getNorthWest(), zoom);
    const se = mapInstance.project(bounds.getSouthEast(), zoom);
    mapInstance.setView(mapInstance.unproject(nw.add(se).divideBy(2), zoom), zoom, { animate: false });
  };

  const originalAspect = getExportAspectConfig;
  getExportAspectConfig = function (aspect = null) {
    if (getDownloadExtentValue() !== "custom" || (aspect || getDownloadAspectValue()) !== "viewport") {
      return originalAspect(aspect);
    }
    const bounds = chosenBounds();
    const nw = L.CRS.EPSG3857.latLngToPoint(bounds.getNorthWest(), 0);
    const se = L.CRS.EPSG3857.latLngToPoint(bounds.getSouthEast(), 0);
    const ratio = (se.x - nw.x) / (se.y - nw.y);
    const longEdge = getDownloadFormatValue() === "png" ? 2160 : 1440;
    const width = Math.max(2, Math.round(longEdge * Math.min(1, ratio)));
    const height = Math.max(2, Math.round(longEdge / Math.max(1, ratio)));
    return { value: "viewport", width, height, label: "Selected area", resolutionLabel: `${width} × ${height}` };
  };

  const originalBusy = setDownloadBusy;
  setDownloadBusy = function (busy, ...args) {
    if (busy && !exportInProgress) jobBounds = customMode() ? copyBounds(selectedBounds) : null;
    try { return originalBusy(busy, ...args); }
    finally {
      if (!busy) jobBounds = null;
      document.querySelectorAll("#downloadExtentControl button, #adjustExportViewBtn").forEach(button => {
        button.disabled = !!busy;
      });
    }
  };

  const originalSummary = updateDownloadSummary;
  updateDownloadSummary = function (...args) {
    const result = originalSummary(...args);
    const summary = document.getElementById("downloadSummary");
    if (customMode() && summary) summary.textContent = summary.textContent.replace(/Current View/gi, "Selected area");
    updateAreaStatus();
    return result;
  };

  const originalReset = resetExportPanelToDefaults;
  resetExportPanelToDefaults = function (...args) {
    if (exportInProgress) return;
    selectedBounds = null;
    jobBounds = null;
    return originalReset(...args);
  };

  function updateAreaStatus() {
    const button = document.getElementById("exportExtentCustomBtn");
    const active = getDownloadExtentValue() === "custom";
    if (button) {
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = active ? "Edit selected area" : "Choose area";
    }
    const status = document.getElementById("exportAreaStatus");
    if (status) status.textContent = active
      ? "Your selected area will be used for every frame. All layouts include the entire selection."
      : "Choose an area on the map, or export the current view.";
  }

  function refreshExportControls() {
    updateExportSegmentedUI();
    applyExportStageAspect(getDownloadAspectValue());
    updateDownloadSummary();
  }

  function activeBounds() {
    if (typeof getActiveMapBounds === "function") return getActiveMapBounds();
    return typeof map !== "undefined" && map ? map.getBounds() : null;
  }

  function setPending(bounds) {
    pendingBounds = validBounds(bounds) ? copyBounds(bounds) : null;
    if (rectangle) pickerMap.removeLayer(rectangle);
    rectangle = pendingBounds ? L.rectangle(pendingBounds, {
      color: "#2563eb", weight: 3, fillColor: "#60a5fa", fillOpacity: 0.18, interactive: false
    }).addTo(pickerMap) : null;
    document.getElementById("exportAreaApplyBtn").disabled = !pendingBounds;
  }

  function setDrawing(enabled) {
    drawing = !!enabled;
    firstCorner = null;
    gesture = null;
    const container = pickerMap.getContainer();
    container.classList.toggle("export-area-drawing", drawing);
    if (drawing) {
      savedInteractions = ["dragging", "touchZoom", "doubleClickZoom", "boxZoom", "scrollWheelZoom"]
        .map(name => pickerMap[name]).filter(handler => handler?.enabled());
      savedInteractions.forEach(handler => handler.disable());
    } else {
      savedInteractions.forEach(handler => handler.enable());
      savedInteractions = [];
    }
    const button = document.getElementById("exportAreaDrawBtn");
    button.classList.toggle("active", drawing);
    button.setAttribute("aria-pressed", String(drawing));
    document.getElementById("exportAreaHint").textContent = drawing
      ? "Drag a box, or tap two opposite corners of the area you want."
      : "Pan and zoom, then use the visible area. You can also draw a box.";
  }

  function pointerPosition(event) {
    const rect = pickerMap.getContainer().getBoundingClientRect();
    const point = L.point(Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      Math.max(0, Math.min(rect.height, event.clientY - rect.top)));
    return { point, latlng: pickerMap.containerPointToLatLng(point) };
  }

  function bindDrawing(container) {
    container.addEventListener("pointerdown", event => {
      if (!drawing || gesture || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0) ||
          event.target.closest(".leaflet-control")) return;
      event.preventDefault();
      event.stopPropagation();
      const position = pointerPosition(event);
      gesture = { id: event.pointerId, start: firstCorner || position.latlng,
        point: position.point, secondCorner: !!firstCorner, moved: false };
      container.setPointerCapture(event.pointerId);
    }, { capture: true });
    container.addEventListener("pointermove", event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      event.preventDefault();
      const position = pointerPosition(event);
      gesture.moved ||= gesture.point.distanceTo(position.point) >= 8;
      if (gesture.moved) setPending(L.latLngBounds(gesture.start, position.latlng));
    });
    container.addEventListener("pointerup", event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      event.preventDefault();
      const position = pointerPosition(event);
      const completed = gesture.moved || gesture.secondCorner;
      const start = gesture.start;
      gesture = null;
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      if (completed) {
        const bounds = L.latLngBounds(start, position.latlng);
        if (validBounds(bounds)) {
          setPending(bounds);
          setDrawing(false);
        }
      } else {
        firstCorner = start;
        document.getElementById("exportAreaHint").textContent = "Now tap the opposite corner.";
      }
    });
    container.addEventListener("pointercancel", () => { gesture = null; firstCorner = null; });
  }

  function openPicker() {
    if (exportInProgress) return;
    const seed = selectedBounds || activeBounds();
    if (!validBounds(seed)) {
      setDownloadStatus("The map is still loading. Try choosing an area in a moment.", true);
      return;
    }
    previousFocus = document.activeElement;
    setDownloadModalOpen(false);
    const modal = document.getElementById("exportAreaModal");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    try {
      if (!pickerMap) {
        pickerMap = L.map("exportAreaMap", { zoomControl: true, attributionControl: true,
          minZoom: 0, maxZoom: 22, zoomSnap: 0, zoomAnimation: false, fadeAnimation: false,
          preferCanvas: true });
        pickerMap.createPane("boundaryPane");
        pickerMap.getPane("boundaryPane").style.zIndex = 450;
        L.tileLayer(typeof FALLBACK_BASEMAP_URL !== "undefined" ? FALLBACK_BASEMAP_URL :
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles &copy; Esri", maxZoom: 22, maxNativeZoom: 19 }).addTo(pickerMap);
        if (typeof makeExportBoundaryVector === "function") {
          const boundary = makeExportBoundaryVector({ color: "#243447", weight: 2, fill: false, interactive: false });
          boundary?.addTo(pickerMap);
        }
        bindDrawing(pickerMap.getContainer());
      }
      pickerMap.invalidateSize(false);
      pickerMap.fitBounds(seed, { padding: [30, 30], animate: false });
      setDrawing(false);
      setPending(seed);
      document.getElementById("exportAreaDrawBtn").focus();
    } catch (error) {
      closePicker();
      setDownloadStatus("The area picker could not load. Please try again.", true);
      console.error("Export area picker:", error);
    }
  }

  function closePicker() {
    if (pickerMap) setDrawing(false);
    const modal = document.getElementById("exportAreaModal");
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    pendingBounds = null;
    setDownloadModalOpen(true);
    previousFocus?.focus({ preventScroll: true });
    requestAnimationFrame(() => previousFocus?.focus({ preventScroll: true }));
  }

  function applySelection() {
    if (!validBounds(pendingBounds) || exportInProgress) return;
    selectedBounds = copyBounds(pendingBounds);
    document.getElementById("downloadExtentSelect").value = "custom";
    setDownloadStatus("", false);
    closePicker();
    refreshExportControls();
  }

  function init() {
    const download = document.getElementById("downloadModal");
    if (!download || document.getElementById("exportAreaModal")) return;
    const style = document.createElement("style");
    style.id = "floodmapper-export-area-style";
    style.textContent = `
      #downloadExtentControl{--seg-cols:3;grid-template-columns:repeat(3,minmax(0,1fr))}
      #downloadExtentControl button{white-space:normal;line-height:1.25}
      #exportAreaStatus{display:block;font-size:12px;font-weight:500;line-height:1.45;color:var(--muted,#bac8df);text-transform:none;letter-spacing:normal}
      #exportAreaModal[hidden]{display:none!important}
      #exportAreaModal{position:fixed;inset:0;z-index:25000;background:rgba(3,9,20,.78);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
      #exportAreaModal *{box-sizing:border-box}
      .export-area-card{width:min(900px,100%);height:min(740px,calc(100dvh - 32px));display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:20px;border:1px solid #415779;background:#101d32;color:#eaf0ff;box-shadow:0 24px 80px #0008}
      .export-area-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .export-area-head h3{margin:0;font-size:20px}
      #exportAreaCloseBtn{font-size:24px;min-width:44px;padding:0;line-height:1}
      #exportAreaHint{margin:0;font-size:14px;line-height:1.4;color:#c6d5ea;min-height:40px}
      .export-area-tools,.export-area-actions{display:flex;gap:8px;flex-wrap:wrap}
      #exportAreaModal button{cursor:pointer;min-height:44px;padding:9px 14px;border:1px solid #587394;border-radius:10px;background:#1b304b;color:#f0f6ff;font-size:14px;font-weight:700}
      #exportAreaModal button.active,#exportAreaApplyBtn{background:#1d4ed8!important;border-color:#93c5fd!important}
      #exportAreaModal button:disabled{opacity:.45;cursor:default}
      #exportAreaModal button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
      #exportAreaMap{flex:1;min-height:150px;border-radius:12px;background:#d9e3ed;color:#1e293b;overflow:hidden;text-transform:none;letter-spacing:normal}
      #exportAreaMap.export-area-drawing{cursor:crosshair;touch-action:none}
      #exportAreaMap .leaflet-control-zoom a{color:#17243a;background:white}
      .export-area-actions{justify-content:flex-end}
      @media(max-width:600px){#exportAreaModal{padding:8px}.export-area-card{height:calc(100dvh - 16px);padding:12px;border-radius:14px;gap:10px}.export-area-head h3{font-size:18px}.export-area-tools button{flex:1}.export-area-actions button{flex:1}#downloadExtentControl button{font-size:11px;padding:7px 4px}}
    `;
    document.head.appendChild(style);
    let control = document.getElementById("downloadExtentControl");
    if (!control) {
      const field = document.createElement("section");
      field.className = "download-field export-framing-field";
      field.innerHTML = `Export area<div id="downloadExtentControl" class="export-segmented" role="group" aria-label="Export area"><button id="exportExtentCurrentBtn" class="active" type="button" data-extent="current" aria-pressed="true">Current View</button></div>`;
      const anchor = download.querySelector(".export-layout-field") ||
        document.getElementById("downloadAspectControl")?.closest(".download-field") ||
        document.getElementById("downloadFormatControl")?.closest(".download-field");
      if (anchor) anchor.insertAdjacentElement("afterend", field);
      else download.querySelector(".download-grid").prepend(field);
      control = field.querySelector("#downloadExtentControl");
      control.style.setProperty("--seg-cols", "2");
      control.style.gridTemplateColumns = "repeat(2,minmax(0,1fr))";
      control.querySelector("button").addEventListener("click", event => {
        event.preventDefault();
        document.getElementById("downloadExtentSelect").value = "current";
        refreshExportControls();
      });
    }
    const button = document.createElement("button");
    button.id = "exportExtentCustomBtn";
    button.type = "button";
    button.dataset.extent = "custom";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", "exportAreaModal");
    button.textContent = "Choose area";
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      openPicker();
    });
    control.appendChild(button);
    control.querySelectorAll("button[data-extent]").forEach(other => {
      if (other !== button) other.addEventListener("click", () => requestAnimationFrame(updateAreaStatus));
    });
    const status = document.createElement("span");
    status.id = "exportAreaStatus";
    status.setAttribute("aria-live", "polite");
    control.insertAdjacentElement("afterend", status);
    download.querySelectorAll(".export-screen-view-note").forEach(note => {
      note.textContent = "Choose an export area above, or use the current map view.";
    });
    const modal = document.createElement("div");
    modal.id = "exportAreaModal";
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `<section class="export-area-card" role="dialog" aria-modal="true" aria-labelledby="exportAreaTitle" aria-describedby="exportAreaHint"><header class="export-area-head"><h3 id="exportAreaTitle">Choose export area</h3><button id="exportAreaCloseBtn" type="button" aria-label="Cancel area selection">×</button></header><p id="exportAreaHint" aria-live="polite"></p><div class="export-area-tools"><button id="exportAreaDrawBtn" type="button" aria-pressed="false">Draw box</button><button id="exportAreaVisibleBtn" type="button">Use visible area</button></div><div id="exportAreaMap" aria-label="Map for selecting the export area"></div><footer class="export-area-actions"><button id="exportAreaCancelBtn" type="button">Cancel</button><button id="exportAreaApplyBtn" type="button">Use this area</button></footer></section>`;
    document.body.appendChild(modal);
    document.getElementById("exportAreaCloseBtn").addEventListener("click", closePicker);
    document.getElementById("exportAreaCancelBtn").addEventListener("click", closePicker);
    document.getElementById("exportAreaApplyBtn").addEventListener("click", applySelection);
    document.getElementById("exportAreaDrawBtn").addEventListener("click", () => setDrawing(!drawing));
    document.getElementById("exportAreaVisibleBtn").addEventListener("click", () => {
      setDrawing(false);
      setPending(pickerMap.getBounds());
    });
    document.addEventListener("keydown", event => {
      if (modal.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); closePicker();
      } else if (event.key === "Tab") {
        const controls = [...modal.querySelectorAll("button:not(:disabled),a[href],[tabindex='0']")]
          .filter(element => element.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    }, true);
    updateAreaStatus();
    window.FLOODMAPPER_EXPORT_AREA.ready = true;
  }

  window.FLOODMAPPER_EXPORT_AREA = {
    version: "20261008", ready: false,
    getBounds: () => copyBounds(selectedBounds),
    getJobBounds: () => copyBounds(jobBounds)
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
