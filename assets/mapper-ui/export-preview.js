/* Preview the same first frame and geographic framing used by PNG and GIF exports. */
(function () {
  "use strict";
  if (window.FLOODMAPPER_EXPORT_PREVIEW) return;

  let generation = 0;
  let timer = null;
  let pending = false;
  let activeJob = null;
  let exportRequested = false;
  let exportRequestGeneration = 0;
  let cancelPreviewWait = null;
  let settingsReviewed = false;
  const gesturePointers = new Set();
  const publicationWaiters = new Set();
  let gestureSettling = false;
  let gestureTimer = null;
  let activePreviewKey = null;
  let activePreviewGeneration = null;
  let displayedPreviewKey = null;
  const previewCache = new Map();
  const sourceIds = new WeakMap();
  const capturedViews = new WeakMap();
  let displayedView = null;
  let panGesture = null;
  let nextSourceId = 0;

  const node = id => document.getElementById(id);
  const available = () => isDownloadModalOpen() && !exportRequested && !exportInProgress;
  const fresh = token => token === generation && available();
  const release = canvas => { if (canvas) canvas.width = canvas.height = 1; };

  function sourceId(value) {
    if (!value || typeof value !== "object") return null;
    if (!sourceIds.has(value)) sourceIds.set(value, ++nextSourceId);
    return sourceIds.get(value);
  }

  function previewRequest(firstItem = null) {
    try {
      if (getDownloadScopeValue() === "current" && floodFrameState !== "ready") return null;
      if (!validateDownloadRangeForExport().ok) return null;
      const item = firstItem || getDownloadFrameItems()[0];
      if (!item) return null;
      const config = getExportAspectConfig();
      const extent = getDownloadExtentValue();
      const bounds = extent === "custom" ? window.FLOODMAPPER_EXPORT_AREA?.getBounds?.()
        : extent === "current" ? (typeof exportViewportBounds !== "undefined" && exportViewportBounds)
          || (typeof getActiveMapBounds === "function" ? getActiveMapBounds() : null) : null;
      const layers = ["roadsToggle", "satelliteToggle", "buildingsToggle", "parcelsToggle"].map(id => {
        const element = node(id);
        return [id, element?.classList.contains("on") || element?.getAttribute("aria-checked") === "true"];
      });
      const key = JSON.stringify({
        entry: item.entry, index: item.index,
        phase: typeof getHydraulicPhaseForEntry === "function"
          ? getHydraulicPhaseForEntry(item.entry, item.index, item.series) : null,
        source: typeof currentSeriesHours !== "undefined" ? sourceId(currentSeriesHours) : null,
        rawSource: typeof currentRawSeriesHours !== "undefined" ? sourceId(currentRawSeriesHours) : null,
        dataMode: currentDataMode,
        overlay: typeof currentOverlayMode !== "undefined" ? currentOverlayMode : null,
        datum: typeof currentDatum !== "undefined" ? currentDatum : null,
        opacity: typeof overlayOpacity !== "undefined" ? overlayOpacity : node("opacitySlider")?.value,
        dimensions: [config.width, config.height], extent,
        bounds: bounds ? [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()] : null,
        layers,
        font: typeof getComputedStyle === "function" ? getComputedStyle(document.body).fontFamily : null,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2)
      });
      return { key, item, config };
    } catch (_) {
      // Missing historical inputs still use the normal availability/error path.
      return null;
    }
  }

  function rememberPreview(key, canvas) {
    if (!key) return;
    const old = previewCache.get(key);
    if (old && old !== canvas) release(old);
    previewCache.delete(key);
    previewCache.set(key, canvas);
    while (previewCache.size > 3) {
      const oldest = previewCache.keys().next().value;
      release(previewCache.get(oldest));
      previewCache.delete(oldest);
    }
  }

  function previewScale(config) {
    const viewport = node("exportPreviewCanvas").getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const displayScale = Math.min(Math.max(1, viewport.width) * pixelRatio / config.width,
      Math.max(1, viewport.height) * pixelRatio / config.height);
    // Small vector zooms lose some street names and route shields. A 900px
    // short edge keeps those details in broad previews with Road Names on.
    const roadScale = node("roadsToggle")?.classList.contains("on") ? 900 / Math.min(config.width, config.height) : 0;
    return Math.min(1, Math.max(displayScale, roadScale));
  }

  function capturePreviewView(config, outputConfig) {
    if (typeof exportMap === "undefined" || !exportMap) return null;
    const bounds = exportMap.getBounds();
    if (!bounds?.isValid()) return null;
    const crs = L.CRS.EPSG3857;
    const nw = crs.latLngToPoint(bounds.getNorthWest(), 0);
    const se = crs.latLngToPoint(bounds.getSouthEast(), 0);
    const minZoom = exportMap.getMinZoom();
    const maxZoom = Math.max(minZoom, exportMap.getMaxZoom() - Math.log2(outputConfig.width / config.width));
    return { nw, se, zoom: exportMap.getZoom(), minZoom, maxZoom, config,
      mapHeight: getExportFooterLayout(config.width, config.height).map.height };
  }

  function movePreview(delta, offsetX = 0, offsetY = 0) {
    if (!available() || node("exportPreview")?.dataset.state !== "ready" || !displayedView) return;
    const { nw, se, zoom, minZoom, maxZoom } = displayedView;
    if ((delta > 0 && zoom >= maxZoom) || (delta < 0 && zoom <= minZoom)) return;
    let targetZoom = zoom;
    if (delta > 0) targetZoom = Math.min(maxZoom, zoom + delta);
    if (delta < 0) targetZoom = Math.max(minZoom, zoom + delta);
    const scale = 2 ** (zoom - targetZoom);
    const span = se.subtract(nw);
    const center = nw.add(se).divideBy(2).subtract(L.point(offsetX * span.x, offsetY * span.y));
    // Keep the selected rectangle inside the Web Mercator map.
    const half = span.multiplyBy(scale / 2);
    const size = L.CRS.EPSG3857.scale(0);
    if (half.x * 2 >= size || half.y * 2 >= size) return;
    center.x = Math.max(half.x, Math.min(size - half.x, center.x));
    center.y = Math.max(half.y, Math.min(size - half.y, center.y));
    const pointToLatLng = point => L.CRS.EPSG3857.pointToLatLng(point, 0);
    const bounds = L.latLngBounds(pointToLatLng(center.subtract(half)), pointToLatLng(center.add(half)));
    window.FLOODMAPPER_EXPORT_AREA?.setPreviewBounds(bounds);
  }

  function setPreviewControls(state) {
    const usable = state === "ready" && Boolean(displayedView);
    const mapControl = node("exportPreviewCanvas");
    if (mapControl) mapControl.tabIndex = usable ? 0 : -1;
    const zoomIn = node("exportPreviewZoomIn");
    const zoomOut = node("exportPreviewZoomOut");
    zoomIn?.setAttribute("aria-disabled", String(!usable || displayedView.zoom >= displayedView.maxZoom));
    zoomOut?.setAttribute("aria-disabled", String(!usable || displayedView.zoom <= displayedView.minZoom));
  }

  function bindPreviewMap() {
    const mount = node("exportPreviewCanvas");
    node("exportPreviewZoomIn").addEventListener("click", () => movePreview(1));
    node("exportPreviewZoomOut").addEventListener("click", () => movePreview(-1));
    mount.addEventListener("keydown", event => {
      const offset = { ArrowLeft: [.16, 0], ArrowRight: [-.16, 0], ArrowUp: [0, .16], ArrowDown: [0, -.16] }[event.key];
      if (!offset || !displayedView) return;
      event.preventDefault();
      movePreview(0, ...offset);
    });
    mount.addEventListener("pointerdown", event => {
      if (!available() || panGesture || !event.isPrimary || event.button !== 0 ||
          node("exportPreview")?.dataset.state !== "ready" || !displayedView) return;
      const canvas = mount.querySelector("canvas");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { config, mapHeight } = displayedView;
      const scale = Math.min(rect.width / config.width, rect.height / config.height);
      const width = config.width * scale;
      const height = mapHeight * scale;
      const left = rect.left + (rect.width - width) / 2;
      const top = rect.top + (rect.height - config.height * scale) / 2;
      if (!width || !height || event.clientX < left || event.clientX > left + width ||
          event.clientY < top || event.clientY > top + height) return;
      panGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, width, height };
      mount.setPointerCapture(event.pointerId);
    });
    mount.addEventListener("pointerup", event => {
      if (panGesture?.id !== event.pointerId) return;
      const { x, y, width, height } = panGesture;
      panGesture = null;
      const dx = event.clientX - x, dy = event.clientY - y;
      if (Math.hypot(dx, dy) >= 5) movePreview(0, dx / width, dy / height);
    });
    mount.addEventListener("lostpointercapture", () => { panGesture = null; });
  }

  function publishPreview(canvas, key, config) {
    clearCanvas();
    node("exportPreviewCanvas").appendChild(canvas);
    displayedPreviewKey = key;
    displayedView = capturedViews.get(canvas) || null;
    showState("ready", `${config.width} × ${config.height}`);
  }

  function restorePreview(request) {
    const canvas = request && previewCache.get(request.key);
    if (!canvas) return false;
    const scale = previewScale(request.config);
    if (canvas.width + 2 < request.config.width * scale
      || canvas.height + 2 < request.config.height * scale) return false;
    clearTimeout(timer);
    timer = null;
    pending = false;
    const token = ++generation;
    if (displayedPreviewKey === request.key && node("exportPreviewCanvas").children.length
      && (!gestureSettling || node("exportPreview").dataset.state === "ready")) {
      showState("ready", `${request.config.width} × ${request.config.height}`);
      return true;
    }
    const publish = () => {
      if (!fresh(token)) return;
      previewCache.delete(request.key);
      previewCache.set(request.key, canvas);
      publishPreview(canvas, request.key, request.config);
    };
    if (gestureSettling) waitForPreviewGesture().then(publish);
    else publish();
    return true;
  }

  function finishPreviewGesture() {
    clearTimeout(gestureTimer);
    gestureTimer = null;
    gesturePointers.clear();
    gestureSettling = false;
    for (const resolve of publicationWaiters) resolve();
    publicationWaiters.clear();
  }

  function waitForPreviewGesture() {
    if (!gestureSettling) return Promise.resolve();
    return new Promise(resolve => publicationWaiters.add(resolve));
  }

  // Publishing ready removes the preview caption from normal flow. Keep its
  // geometry stable from pointer-down through the resulting control click.
  document.addEventListener("pointerdown", event => {
    if (!available() || !node("downloadModal")?.contains(event.target)) return;
    clearTimeout(gestureTimer);
    gestureTimer = null;
    gesturePointers.add(event.pointerId);
    gestureSettling = true;
  }, true);
  document.addEventListener("pointerup", event => {
    if (!gesturePointers.delete(event.pointerId) || gesturePointers.size) return;
    // A cancelled/suppressed compatibility click must not retain the canvas.
    gestureTimer = setTimeout(finishPreviewGesture, 500);
  }, true);
  document.addEventListener("click", () => {
    if (!gestureSettling || gesturePointers.size) return;
    clearTimeout(gestureTimer);
    // Run after this event's handlers have committed their selected setting.
    gestureTimer = setTimeout(finishPreviewGesture, 0);
  }, true);
  document.addEventListener("pointercancel", event => {
    if (gesturePointers.delete(event.pointerId) && !gesturePointers.size) finishPreviewGesture();
  }, true);
  window.addEventListener?.("blur", finishPreviewGesture);
  window.addEventListener?.("pagehide", invalidate);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) invalidate();
    else if (available()) schedulePreview();
  });
  window.addEventListener?.("resize", schedulePreview);

  function renderReviewStep() {
    const modal = node("downloadModal");
    if (modal) modal.dataset.exportStep = settingsReviewed ? "review" : "area";
    const basic = node("exportBasicFields");
    const review = node("exportReviewFields");
    const back = node("exportReviewBackBtn");
    const reset = node("downloadResetBtn");
    if (basic) basic.hidden = settingsReviewed;
    if (review) review.hidden = !settingsReviewed;
    if (back) back.hidden = !settingsReviewed;
    if (reset) reset.hidden = !settingsReviewed;
    const title = node("downloadModalTitle");
    if (title) title.textContent = settingsReviewed ? `Export ${getDownloadFormatValue().toUpperCase()}` : "Export";
    if (!exportInProgress && !exportRequested) {
      const label = node("downloadBtnLabel");
      const action = settingsReviewed ? "Download" : "More options";
      if (label && label.textContent !== action) label.textContent = action;
    }
    const area = node("exportPreviewAreaLabel");
    if (area) area.textContent = getDownloadExtentValue() === "custom" ? "Selected area"
      : getDownloadExtentValue() === "town" ? "Whole town" : "Current view";
    const areaStatus = node("exportAreaStatus");
    if (areaStatus) areaStatus.hidden = true;
    const custom = node("exportExtentCustomBtn");
    if (custom) custom.textContent = getDownloadExtentValue() === "custom" ? "Edit area" : "Choose Area";
    const config = getExportAspectConfig();
    node("exportPreview")?.style.setProperty("--export-preview-aspect", `${config.width} / ${config.height}`);
  }

  function reviewSettings() {
    settingsReviewed = true;
    updateExportSegmentedUI();
    node("exportReviewFields")?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }

  function clearCanvas() {
    const mount = node("exportPreviewCanvas");
    if (!mount) return;
    Array.from(mount.children).forEach(canvas => {
      if (![...previewCache.values()].includes(canvas)) release(canvas);
    });
    mount.replaceChildren();
    displayedPreviewKey = null;
    displayedView = null;
  }

  function showState(state, message) {
    const preview = node("exportPreview");
    if (!preview) return;
    preview.dataset.state = state;
    preview.setAttribute("aria-busy", String(state === "loading"));
    node("exportPreviewStatus").textContent = message;
    node("exportPreviewRetryBtn").hidden = state !== "error";
    setPreviewControls(state);
  }

  function invalidate() {
    generation++;
    pending = false;
    panGesture = null;
    clearTimeout(timer);
    timer = null;
    finishPreviewGesture();
  }

  function schedulePreview() {
    if (!available()) return;
    const request = previewRequest();
    if (restorePreview(request)) return;
    if (request && activeJob && activePreviewKey === request.key && activePreviewGeneration === generation) return;
    generation++;
    pending = true;
    clearTimeout(timer);
    showState("loading", "Updating preview…");
    timer = setTimeout(() => {
      timer = null;
      startPreview();
    }, 0);
  }

  async function renderPreview(token) {
    if (getDownloadScopeValue() === "current" && floodFrameState !== "ready") {
      if (fresh(token)) showState("empty", "Wait for the map to finish loading.");
      return;
    }
    let validation = validateDownloadRangeForExport();
    if (!validation.ok) {
      if (fresh(token)) showState("empty", validation.message);
      return;
    }
    if (getDownloadScopeValue() !== "current" && exportRangeNeedsObservedArchive(validation.range)) {
      await ensureExportArchiveAvailability();
      if (!fresh(token)) return;
      validation = validateDownloadRangeForExport();
      if (!validation.ok) {
        if (fresh(token)) showState("empty", validation.message);
        return;
      }
      await ensureObservedArchiveRange(validation.range.startDate, validation.range.endDate);
      if (!fresh(token)) return;
    }
    const item = getDownloadFrameItems()[0];
    if (!item) {
      if (fresh(token)) showState("empty", "No frames are available for this time range.");
      return;
    }
    const request = previewRequest(item);
    activePreviewKey = request?.key || null;
    if (restorePreview(request)) return;
    const config = request?.config || getExportAspectConfig();
    const scale = previewScale(config);
    // Render at preview size. The completed export gets the original
    // dimensions and its own fit when the user clicks Download.
    const renderConfig = { ...config, width: Math.max(2, Math.round(config.width * scale)),
      height: Math.max(2, Math.round(config.height * scale)) };
    // The capture library and map load independently. Wait for both to settle
    // before releasing the offscreen renderer to a newer preview or download.
    const preparation = await Promise.allSettled([
      ensureExportLibraries("png", 1),
      prepareExportFrame(item, { isFirstFrame: true, renderConfig })
    ]);
    const failed = preparation.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    if (!fresh(token)) return;
    const view = capturePreviewView(renderConfig, config);
    const canvas = await captureExportCanvas({ preparedRoadLabels: true });
    if (view) capturedViews.set(canvas, view);
    if (!fresh(token)) { release(canvas); return; }
    await waitForPreviewGesture();
    if (!fresh(token)) { release(canvas); return; }
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Preview of the selected North Wildwood export area");
    publishPreview(canvas, request?.key || null, config);
    rememberPreview(request?.key, canvas);
  }

  function startPreview() {
    if (activeJob || !pending || !available()) return;
    pending = false;
    const token = generation;
    activePreviewGeneration = token;
    activePreviewKey = null;
    activeJob = renderPreview(token).catch(error => {
      if (!fresh(token)) return;
      clearCanvas();
      const knownError = error?.name === "RoadLabelRendererUnavailableError" ||
        error?.name === "ParcelBoundaryExportUnavailableError";
      const message = knownError ? error.message : "Preview couldn’t load. Try again, or download your map.";
      showState("error", message);
      console.warn("Export preview could not be rendered.", error);
    }).finally(() => {
      activeJob = null;
      activePreviewKey = null;
      activePreviewGeneration = null;
      if (pending && timer === null && available()) startPreview();
    });
  }

  const originalSummary = updateDownloadSummary;
  updateDownloadSummary = function (...args) {
    const result = originalSummary(...args);
    renderReviewStep();
    schedulePreview();
    return result;
  };

  const originalOpen = setDownloadModalOpen;
  setDownloadModalOpen = function (open, options) {
    if (!open && cancelPreviewWait) {
      // Closing is a real cancellation even when preview preparation has not
      // yet entered the exporter's progress/Cancel lifecycle.
      exportRequestGeneration++;
      exportRequested = false;
      const cancel = cancelPreviewWait;
      cancelPreviewWait = null;
      cancel();
      setPendingExportControls(false);
      const button = node("downloadBtn");
      if (button) button.disabled = false;
    }
    invalidate();
    if (!options?.preserveReview) settingsReviewed = false;
    const result = originalOpen(open, options);
    renderReviewStep();
    if (open) schedulePreview();
    else {
      clearCanvas();
      previewCache.forEach(release);
      previewCache.clear();
    }
    return result;
  };

  function setPendingExportControls(pendingExport) {
    const review = node("exportReviewFields");
    if (review) review.inert = pendingExport;
    for (const id of ["exportReviewBackBtn", "downloadResetBtn"]) {
      const button = node(id);
      if (button) button.disabled = pendingExport;
    }
  }

  const originalDownload = downloadCurrentSelection;
  downloadCurrentSelection = async function (...args) {
    if (exportRequested || exportInProgress) return;
    // The first action always reveals the important settings, never downloads.
    if (!settingsReviewed) {
      if (!commitAllExportDateTimeEditors(true)) {
        node("exportBasicFields")?.querySelector('[aria-invalid="true"]')?.focus();
        return;
      }
      reviewSettings();
      return;
    }
    // Both jobs use the same offscreen renderer. Never capture while downloading.
    const requestGeneration = ++exportRequestGeneration;
    exportRequested = true;
    invalidate();
    const button = node("downloadBtn");
    if (button) button.disabled = true;
    const label = node("downloadBtnLabel");
    if (label) label.textContent = "Preparing export…";
    const preview = activeJob;
    try {
      if (preview) {
        // The download uses the submitted settings after the shared renderer
        // is released. Keep those settings fixed while Close can still cancel.
        setPendingExportControls(true);
        const completed = await Promise.race([
          preview.then(() => true),
          new Promise(resolve => { cancelPreviewWait = () => resolve(false); })
        ]);
        if (!completed || requestGeneration !== exportRequestGeneration) return;
      }
      cancelPreviewWait = null;
      setPendingExportControls(false);
      return await originalDownload(...args);
    } finally {
      if (requestGeneration === exportRequestGeneration) {
        cancelPreviewWait = null;
        exportRequested = false;
        setPendingExportControls(false);
        if (!exportInProgress) {
          if (button) button.disabled = false;
          updateExportSegmentedUI();
        }
        if (isDownloadModalOpen()) schedulePreview();
      }
    }
  };

  const originalSegmentedUI = updateExportSegmentedUI;
  updateExportSegmentedUI = function (...args) {
    const result = originalSegmentedUI(...args);
    renderReviewStep();
    return result;
  };

  function init() {
    const modal = node("downloadModal");
    const grid = modal?.querySelector(".download-grid");
    if (!grid || node("exportPreview")) return;
    const style = document.createElement("style");
    style.id = "floodmapper-export-preview-style";
    style.textContent = `
      #downloadModal .export-preview-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
      #downloadModal #exportPreview{grid-row:1;margin:0;min-width:0;padding:12px;border:1px solid #40516b;border-radius:14px;background:#101c2d;color:#eaf0ff}
      #downloadModal .export-preview-image{position:relative;display:grid;place-items:center;height:auto;aspect-ratio:var(--export-preview-aspect,16 / 9);min-height:180px;max-height:min(560px,62dvh);border-radius:8px;overflow:hidden;background:#080f1a}
      #downloadModal #exportPreviewCanvas{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
      #downloadModal #exportPreviewCanvas canvas{display:block;width:100%!important;height:100%!important;min-width:0;object-fit:contain}
      #downloadModal #exportPreview:is([data-state="empty"],[data-state="error"]) canvas{visibility:hidden}
      #downloadModal #exportPreview[data-state="loading"] .export-preview-image::after{content:"";position:absolute;width:28px;height:28px;border:3px solid #40516b;border-top-color:#60a5fa;border-radius:50%;animation:export-preview-spin 1s linear infinite}
      #downloadModal .export-preview-caption{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;min-height:20px;font-size:12px;line-height:1.4;color:#bac8df}
      #downloadModal #exportPreview[data-state="ready"] .export-preview-caption{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      #downloadModal #exportPreviewRetryBtn{border:1px solid #60a5fa;border-radius:8px;background:transparent;color:#b8d8ff;padding:8px 12px;font:inherit;cursor:pointer;min-height:40px}
      #downloadModal #exportPreviewRetryBtn[hidden]{display:none!important}
      #downloadModal #exportPreviewRetryBtn:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
      #downloadModal .export-preview-layout>.download-grid{display:flex!important;flex-direction:column!important;gap:16px!important;min-width:0;align-self:stretch!important}
      #downloadModal .export-step-fields{display:flex;flex-direction:column;gap:14px;min-width:0}
      #downloadModal #exportReviewFields{width:100%;max-width:420px;align-self:center}
      #downloadModal #exportReviewFields>.download-field{width:100%;text-align:center}
      #downloadModal #exportReviewFields :is(.export-segmented,#downloadAspectControl){margin-inline:auto;width:100%}
      #downloadModal .export-preview-layout [hidden][hidden]{display:none!important}
      #downloadModal .export-step-fields>.download-field{display:flex!important;flex-direction:column!important;gap:8px!important;margin:0!important;min-width:0}
      #downloadModal #exportTimePicker{padding:0!important;background:none!important;border:0!important;box-shadow:none!important}
      #downloadModal #downloadRangeFields{display:flex!important;flex-direction:column!important;gap:14px!important}
      #downloadModal #exportDataRangeText,#downloadModal .export-extent-help,#downloadModal #downloadModalSub{display:none!important}
      #downloadModal .export-preview-area{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;font-size:13px;color:#bac8df;text-align:center}
      #downloadModal .export-preview-zoom{position:absolute;top:8px;left:8px;z-index:1;display:flex;flex-direction:column;gap:4px}
      #downloadModal .export-preview-zoom button{width:44px;min-width:44px;height:44px;min-height:44px;padding:0;border:1px solid #40516b;border-radius:10px;background:#101c2d;color:#eaf0ff;font:inherit;font-size:23px!important;font-weight:650;line-height:1;cursor:pointer}
      #downloadModal .export-preview-zoom button[aria-disabled="true"]{opacity:.65;cursor:default}
      #downloadModal #exportPreview[data-state="ready"] #exportPreviewCanvas{cursor:grab;touch-action:none}
      #downloadModal #exportPreview[data-state="ready"] #exportPreviewCanvas:active{cursor:grabbing}
      #downloadModal :is(.export-preview-zoom button,#exportPreviewCanvas):focus-visible{outline:3px solid #93c5fd;outline-offset:-3px}
      #downloadModal .download-actions{margin-top:auto!important;display:flex!important;flex-direction:column!important;align-items:stretch!important;width:100%!important;gap:10px!important;padding-top:8px!important}
      #downloadModal #exportReviewBackBtn{min-height:40px;border:0;border-radius:8px;padding:9px 12px;background:transparent;color:#c6d5ea;font:inherit;font-size:13px;cursor:pointer}
      #downloadModal #downloadBtn{width:100%!important;min-height:50px!important;color:white!important;background:#1d4ed8!important;border:1px solid #76adff!important}
      #downloadModal #downloadBtn:disabled{opacity:.65!important}
      /* Keep WebKit pointer activation on the button when its label updates. */
      #downloadModal #downloadBtn > span{pointer-events:none}
      #downloadModal .download-modal-head{margin-bottom:14px!important;align-items:start!important}
      #downloadModal #downloadAspectControl{grid-template-columns:repeat(2,minmax(0,1fr))!important}
      @keyframes export-preview-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){#downloadModal #exportPreview .export-preview-image::after{animation:none}}
      @media(min-width:760px){
        html body[data-county-mobile] #downloadModal .download-modal-card,html body #downloadModal .download-modal-card{width:min(1120px,calc(100vw - 32px))!important}
        #downloadModal .export-preview-layout{grid-template-columns:minmax(0,1.55fr) minmax(280px,1fr);gap:16px}
        #downloadModal #exportPreview{grid-column:1;grid-row:1;position:sticky;top:0}
        #downloadModal .export-preview-layout>.download-grid{grid-column:2;grid-row:1;min-height:min(540px,59dvh)}
        #downloadModal .export-preview-image{max-height:min(560px,58dvh)}
      }
      @media(min-width:760px) and (max-height:750px){
        #downloadModal .export-preview-layout>.download-grid,#downloadModal .export-step-fields{gap:8px!important}
        #downloadModal #exportReviewFields .export-segmented button{min-height:32px}
        #downloadModal .download-actions{gap:4px!important}
      }
    `;
    document.head.appendChild(style);
    const layout = document.createElement("div");
    layout.className = "export-preview-layout";
    grid.before(layout);
    const preview = document.createElement("figure");
    preview.id = "exportPreview";
    preview.dataset.state = "loading";
    preview.setAttribute("aria-label", "Export preview");
    preview.innerHTML = `<div class="export-preview-image"><div id="exportPreviewCanvas" role="group" aria-label="Pan the export area with the arrow keys" tabindex="-1"></div><div class="export-preview-zoom" role="group" aria-label="Export preview zoom"><button id="exportPreviewZoomIn" type="button" aria-label="Zoom in on the export area" aria-disabled="true">+</button><button id="exportPreviewZoomOut" type="button" aria-label="Zoom out of the export area" aria-disabled="true">−</button></div></div><figcaption class="export-preview-caption"><span id="exportPreviewStatus" role="status" aria-live="polite">Preparing preview…</span><button id="exportPreviewRetryBtn" type="button" hidden>Retry</button></figcaption><div class="export-preview-area"><span id="exportPreviewAreaLabel">Current view</span></div>`;
    layout.append(preview, grid);
    const basic = document.createElement("section");
    basic.id = "exportBasicFields";
    basic.className = "export-step-fields";
    basic.setAttribute("aria-label", "Export area and time");
    const review = document.createElement("section");
    review.id = "exportReviewFields";
    review.className = "export-step-fields";
    review.setAttribute("aria-label", "Required export settings");
    review.hidden = true;
    [".export-filetype-field", "#exportTimePicker"].forEach(selector => {
      const field = grid.querySelector(selector);
      if (field) basic.appendChild(field);
    });
    [".export-layout-field", ".export-interval-field", "#gifSpeedField", ".export-framing-field"].forEach(selector => {
      const field = grid.querySelector(selector);
      if (field) review.appendChild(field);
    });
    grid.prepend(basic, review);
    const actions = grid.querySelector(".download-actions");
    const back = document.createElement("button");
    back.id = "exportReviewBackBtn";
    back.type = "button";
    back.textContent = "Back";
    back.hidden = true;
    actions?.prepend(back);
    const returnToBasicStep = () => {
      settingsReviewed = false;
      updateExportSegmentedUI();
      node("exportFormatGifBtn")?.focus({ preventScroll: true });
    };
    back.addEventListener("click", returnToBasicStep);
    bindPreviewMap();
    node("downloadResetBtn")?.addEventListener("click", returnToBasicStep);
    const compactLabels = {
      exportFormatGifBtn: "GIF", exportFormatPngBtn: "PNG", exportExtentTownBtn: "Whole town",
      exportAspectLandscapeBtn: "16:9", exportAspectPortraitBtn: "9:16",
      exportAspectSquareBtn: "1:1", exportIntervalQuarterBtn: "15 min"
    };
    Object.entries(compactLabels).forEach(([id, text]) => {
      const element = node(id);
      if (!element) return;
      element.setAttribute("aria-label", id === "exportExtentTownBtn" ? "Whole town (North Wildwood)" : element.textContent.trim());
      element.textContent = text;
    });
    [[".export-filetype-field", ""], [".export-interval-field", "Interval"],
      ["#gifSpeedField", "Speed"], [".export-framing-field", "Area"]].forEach(([selector, text]) => {
      const field = grid.querySelector(selector);
      const label = Array.from(field?.childNodes || []).find(child => child.nodeType === 3 && child.textContent.trim());
      if (label) label.textContent = text;
    });
    const startLabel = node("downloadStartDateText")?.closest(".export-simple-datetime-field")?.querySelector("span");
    const endLabel = node("downloadEndDateText")?.closest(".export-simple-datetime-field")?.querySelector("span");
    if (startLabel) startLabel.textContent = "Start";
    if (endLabel) endLabel.textContent = "End";
    node("exportPreviewRetryBtn").addEventListener("click", schedulePreview);
    renderReviewStep();
    window.FLOODMAPPER_EXPORT_PREVIEW.ready = true;
    if (isDownloadModalOpen()) schedulePreview();
  }

  window.FLOODMAPPER_EXPORT_PREVIEW = { version: "20261023-3", ready: false };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
