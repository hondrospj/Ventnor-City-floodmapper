
/* The Cameras layer shows locations. Only clicking a camera loads its feed. */
(() => {
  "use strict";
  const configNode = document.getElementById("shorelysafeWebcamConfig");
  const toggle = document.getElementById("webcamsToggle");
  if (!configNode || !toggle) return;
  const config = JSON.parse(configNode.textContent);
  const cameras = config.cameras;
  if (!cameras.length) return;
  document.getElementById("webcamPanel")?.remove();
  const located = cameras.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="14" rx="4"/><circle cx="12" cy="10" r="4"/><path d="M12 17v4M7 21h10"/></svg>';
  const panel = document.createElement("section");
  panel.id = "webcamPanel";
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", "webcamTitle");
  panel.setAttribute("data-html2canvas-ignore", "true");
  panel.innerHTML = `<div class="webcam-heading"><h2 id="webcamTitle">Cameras</h2><button type="button" id="webcamClose" class="centered-close-control" aria-label="Close camera viewer">×</button></div>
    <select id="webcamChoice" aria-label="Choose camera"></select>
    <div id="webcamFrame" class="webcam-frame"></div>
    <p id="webcamStatus" role="status" aria-live="polite" hidden></p>
    <div class="webcam-source"><a id="webcamSourceLink" target="_blank" rel="noopener noreferrer">Camera source ↗</a><button type="button" id="webcamRetry" aria-label="Reload camera" title="Reload if the feed is blank">↻</button></div>`;
  document.body.append(panel);
  const choice = panel.querySelector("#webcamChoice");
  const frameHost = panel.querySelector("#webcamFrame");
  const closeButton = panel.querySelector("#webcamClose");
  const status = panel.querySelector("#webcamStatus");
  const sourceLink = panel.querySelector("#webcamSourceLink");
  const retryButton = panel.querySelector("#webcamRetry");
  let enabled = false, selected = null, frame = null, refreshTimer = null;
  let openingDeadline = null;
  let leafletMap = null, leafletLayer = null, glMap = null, glMarkers = [];
  let returnFocus = null;

  for (const camera of cameras) {
    const option = document.createElement("option");
    option.value = camera.id;
    option.textContent = `${camera.relation === "nearby" ? "Nearby · " : camera.relation === "regional" ? "Regional · " : ""}${camera.short || camera.name}`;
    choice.append(option);
  }
  choice.hidden = cameras.length < 2;

  function setStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function clearPlayer() {
    clearTimeout(refreshTimer);
    clearTimeout(openingDeadline);
    refreshTimer = null;
    openingDeadline = null;
    if (frame) { frame.onload = frame.onerror = null; frame.remove(); frame = null; }
    frameHost.replaceChildren();
  }

  function loadPlayer(camera) {
    clearPlayer();
    retryButton.hidden = Boolean(camera.external);
    frameHost.hidden = Boolean(camera.external);
    if (camera.external) {
      // The city's beach provider restricts its player to approved parent sites.
      panel.dataset.playerState = "external";
      setStatus("In-map playback unavailable.");
      return;
    }
    setStatus("Opening camera…");
    panel.dataset.playerState = "loading";
    const player = document.createElement(camera.kind === "image" ? "img" : "iframe");
    player.referrerPolicy = "strict-origin-when-cross-origin";
    const unavailable = () => {
      if (frame !== player) return;
      clearTimeout(openingDeadline);
      panel.dataset.playerState = "unavailable";
      frameHost.hidden = true;
      setStatus("Camera unavailable. Try again.");
    };
    player.onerror = unavailable;
    player.onload = () => {
      if (frame !== player) return;
      clearTimeout(openingDeadline);
      // An iframe load can be a provider error document as well as a player.
      panel.dataset.playerState = camera.kind === "image" ? "image-open" : "embed-loaded";
      frameHost.hidden = false;
      setStatus("");
    };
    frame = player;
    openingDeadline = setTimeout(() => {
      if (frame !== player) return;
      panel.dataset.playerState = "slow";
      setStatus("Still opening. Reload or open the source.");
    }, 12000);
    if (camera.kind === "image") {
      player.alt = `${camera.name} — camera image`;
      const refresh = () => {
        if (!enabled || frame !== player) return;
        if (!document.hidden) {
          const url = new URL(camera.url);
          url.searchParams.set("_camera_refresh", String(Date.now()));
          player.src = url.href;
        }
        refreshTimer = setTimeout(refresh, 60000);
      };
      refresh();
    } else {
      player.title = `${camera.name} — camera video`;
      player.allow = "autoplay; fullscreen; picture-in-picture";
      player.allowFullscreen = true;
      player.src = camera.url;
    }
    frameHost.append(player);
  }

  function mountPanel() {
    const currentMap = typeof map !== "undefined" ? map : null;
    const currentGl = window.NORTH_WILDWOOD_3D?.getMap?.();
    const useGl = Boolean(currentGl && document.body.classList.contains("map-3d-ready"));
    const container = document.getElementById("mapWrap") || (useGl ? currentGl.getContainer?.() : currentMap?.getContainer?.()) || document.getElementById("map");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    let top = innerWidth <= 900 ? 120 : 140;
    for (const id of ["topBanner", "topBar", "mapTitleBadge", "mobileControlsToggle"]) {
      const element = document.getElementById(id);
      if (!element || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.height && box.top < rect.top + rect.height / 2) top = Math.max(top, box.bottom - rect.top + 12);
    }
    const viewport = window.visualViewport;
    const viewportTop = Math.max(0, viewport?.offsetTop || 0);
    const viewportLeft = Math.max(0, viewport?.offsetLeft || 0);
    const viewportHeight = viewport?.height || innerHeight;
    const viewportWidth = viewport?.width || innerWidth;
    const dock = document.getElementById("timelineDock")?.getBoundingClientRect();
    const bottom = Math.min(rect.bottom, viewportTop + viewportHeight, dock?.height ? dock.top : Infinity);
    const available = bottom - rect.top - top - 12;
    // A short window cannot fit a player between the header and timeline.
    // Give the same viewer its own scrollable viewport above those controls.
    const overlay = available < 200 || rect.top + top < viewportTop;
    panel.dataset.viewportOverlay = String(overlay);
    // Moving a live iframe between parents can reload it and reset focus.
    const visibleLeft = overlay ? viewportLeft : Math.max(viewportLeft, rect.left);
    const visibleRight = overlay ? viewportLeft + viewportWidth : Math.min(viewportLeft + viewportWidth, rect.right);
    panel.style.left = `${(visibleLeft + visibleRight) / 2}px`;
    panel.style.maxWidth = `${Math.max(1, visibleRight - visibleLeft - 16)}px`;
    let panelTop = overlay ? viewportTop + 8 : rect.top + top;
    const viewportBottom = viewportTop + viewportHeight;
    const controls = document.getElementById("mobileControlsToggle");
    if (overlay && !panel.hidden && controls?.getClientRects().length) {
      const viewer = panel.getBoundingClientRect();
      const key = document.body.classList.contains("mobile-legend-open") ? null : document.getElementById("legendDock");
      for (const control of [controls, key]) {
        if (!control?.getClientRects().length || getComputedStyle(control).visibility === "hidden") continue;
        const box = control.getBoundingClientRect();
        const below = box.bottom + 8;
        if (box.top < viewportTop + 64 && box.left < viewer.right && box.right > viewer.left &&
            viewportBottom - below - 8 >= 200) panelTop = Math.max(panelTop, below);
      }
    }
    panel.style.top = `${panelTop}px`;
    const maxHeight = overlay ? Math.max(1, viewportBottom - panelTop - 8) : available;
    panel.style.maxHeight = `${maxHeight}px`;
    panel.style.setProperty("--webcam-panel-height", `${maxHeight}px`);
  }

  function syncCameraRow() {
    const row = toggle.closest(".layer-item");
    const parcels = document.getElementById("parcelsToggle")?.closest(".layer-item");
    if (!row) return;
    const list = row.parentElement;
    const listRect = list.getBoundingClientRect();
    const parcelRect = parcels?.getBoundingClientRect();
    const column = parcelRect && parcelRect.width > 0 && parcelRect.left >= listRect.left + listRect.width / 2 ? "2" : "1";
    row.style.setProperty("--webcam-column", column);
  }

  function showCamera(camera, trigger) {
    if (!enabled || !camera) return;
    const opening = panel.hidden;
    if (opening) returnFocus = trigger || toggle;
    selected = camera;
    sourceLink.href = camera.sourceUrl;
    sourceLink.title = camera.source;
    choice.value = camera.id;
    mountPanel();
    panel.hidden = false;
    dismissMobileControls();
    loadPlayer(camera);
    if (opening) requestAnimationFrame(() => {
      if (!panel.hidden && selected === camera) closeButton.focus({ preventScroll: true });
    });
  }

  function closeCamera(restoreFocus) {
    clearPlayer();
    panel.hidden = true;
    if (restoreFocus) {
      const target = [returnFocus, toggle, document.getElementById("mobileControlsToggle")].find(element => {
        if (!element?.isConnected || element.closest("[inert],[hidden]")) return false;
        const { x, y, width, height } = element.getBoundingClientRect();
        return width > 0 && height > 0 && element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      });
      target?.focus({ preventScroll: true });
    }
  }

  function syncMarkers() {
    syncCameraRow();
    const currentMap = typeof map !== "undefined" ? map : null;
    const currentGl = window.NORTH_WILDWOOD_3D?.getMap?.();
    const useGl = Boolean(currentGl && document.body.classList.contains("map-3d-ready"));
    if (leafletMap !== currentMap) { leafletLayer?.remove(); leafletLayer = null; leafletMap = currentMap; }
    if (enabled && currentMap && !useGl) {
      if (!leafletLayer) {
        if (!currentMap.getPane("webcamsPane")) { currentMap.createPane("webcamsPane"); currentMap.getPane("webcamsPane").style.zIndex = "760"; }
        leafletLayer = L.layerGroup(located.map(camera => {
          const marker = L.marker([camera.lat, camera.lng], { pane: "webcamsPane", title: camera.name, alt: camera.name, bubblingMouseEvents: false, keyboard: true,
            icon: L.divIcon({ className: "webcam-map-marker", html: icon, iconSize: [44, 44], iconAnchor: [22, 22] }) });
          marker.on("click", () => showCamera(camera, marker.getElement()));
          marker.on("add", () => {
            const element = marker.getElement();
            element.setAttribute("role", "button");
            element.setAttribute("aria-label", `Open ${camera.name}`);
            element.setAttribute("data-webcam-marker", camera.id);
            element.setAttribute("data-html2canvas-ignore", "true");
            // Handle activation once, including layouts with their own key bridges.
            element.onkeydown = event => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopImmediatePropagation(); showCamera(camera, element); }
            };
          });
          return marker;
        }));
      }
      if (!currentMap.hasLayer(leafletLayer)) leafletLayer.addTo(currentMap);
    } else if (leafletLayer && leafletMap?.hasLayer(leafletLayer)) leafletLayer.remove();
    if (glMap !== currentGl || !enabled || !useGl) { glMarkers.forEach(m => m.remove()); glMarkers = []; glMap = currentGl; }
    if (enabled && useGl && !glMarkers.length && window.maplibregl) {
      glMarkers = located.map(camera => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "webcam-map-marker";
        element.innerHTML = icon;
        element.dataset.webcamMarker = camera.id;
        element.setAttribute("data-html2canvas-ignore", "true");
        element.setAttribute("aria-label", `Open ${camera.name}`);
        element.title = camera.name;
        element.addEventListener("click", event => { event.stopPropagation(); showCamera(camera, element); });
        element.addEventListener("dblclick", event => event.stopPropagation());
        return new maplibregl.Marker({ element, anchor: "center", pitchAlignment: "viewport", rotationAlignment: "viewport", opacityWhenCovered: 1 }).setLngLat([camera.lng, camera.lat]).addTo(currentGl);
      });
    }
    if (enabled) mountPanel();
  }

  function dismissMobileControls() {
    if (!document.body.classList.contains("mobile-controls-open")) return;
    if (typeof setMobileControlsOpen === "function") setMobileControlsOpen(false);
    else document.getElementById("mobileControlsToggle")?.click();
    document.getElementById("mobileControlsToggle")?.focus({ preventScroll: true });
  }

  function revealLocations() {
    if (!enabled || !located.length) return;
    const useGl = glMap && document.body.classList.contains("map-3d-ready");
    const activeMap = useGl ? glMap : leafletMap;
    if (!activeMap) return;
    const rect = activeMap.getContainer().getBoundingClientRect();
    const padding = { top: 120, right: 25, bottom: 150, left: 25 };
    if (innerWidth > 900) {
      for (const id of ["leftPanel", "rightRail"]) {
        const element = document.getElementById(id);
        if (!element || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") continue;
        const box = element.getBoundingClientRect();
        if (box.left < rect.left + rect.width / 2) padding.left = Math.max(padding.left, box.right - rect.left + 25);
        else padding.right = Math.max(padding.right, rect.right - box.left + 25);
      }
    }
    const banner = document.getElementById("topBanner");
    if (banner?.getClientRects().length && getComputedStyle(banner).visibility !== "hidden") {
      const box = banner.getBoundingClientRect();
      if (box.height) padding.top = Math.max(padding.top, box.bottom - rect.top + 25);
    }
    const visible = camera => {
      const point = useGl ? glMap.project([camera.lng, camera.lat]) : leafletMap.latLngToContainerPoint([camera.lat, camera.lng]);
      return point.x >= padding.left + 18 && point.x <= rect.width - padding.right - 18 && point.y >= padding.top + 18 && point.y <= rect.height - padding.bottom - 18;
    };
    if (located.every(visible)) return;
    // Keep the town in view while bringing offscreen/covered cameras into clear map space.
    if (useGl) {
      const bounds = glMap.getBounds();
      located.forEach(c => bounds.extend([c.lng, c.lat]));
      glMap.fitBounds(bounds, { padding, maxZoom: glMap.getZoom(), duration: 0 });
    } else if (leafletMap) {
      const bounds = leafletMap.getBounds();
      located.forEach(c => bounds.extend([c.lat, c.lng]));
      leafletMap.fitBounds(bounds, { paddingTopLeft: [padding.left, padding.top], paddingBottomRight: [padding.right, padding.bottom], maxZoom: leafletMap.getZoom(), animate: false });
    }
  }

  function setEnabled(value, restoreFocus = false) {
    enabled = Boolean(value);
    toggle.classList.toggle("on", enabled);
    toggle.setAttribute("aria-checked", String(enabled));
    document.body.dataset.webcamsEnabled = String(enabled);
    if (!enabled) closeCamera(restoreFocus);
    syncMarkers();
    if (enabled) {
      dismissMobileControls();
      requestAnimationFrame(revealLocations);
    }
  }
  toggle.setAttribute("aria-label", "Show webcam locations");
  toggle.setAttribute("aria-controls", document.getElementById("mapWrap") ? "mapWrap" : "map");
  toggle.removeAttribute("aria-expanded");
  toggle.addEventListener("click", () => setEnabled(!enabled));
  toggle.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopImmediatePropagation(); setEnabled(!enabled); }
  }, true);
  closeButton.addEventListener("click", () => closeCamera(true));
  choice.addEventListener("change", () => showCamera(cameras.find(c => c.id === choice.value), choice));
  retryButton.addEventListener("click", () => { if (selected) loadPlayer(selected); });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || panel.hidden || event.defaultPrevented) return;
    // Read modal ownership before its Escape handler can close the dialog.
    const modalOpen = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')]
      .some(modal => !modal.closest('[hidden],[aria-hidden="true"]') && modal.getClientRects().length &&
        getComputedStyle(modal).visibility !== "hidden");
    if (modalOpen || document.body.classList.contains("mobile-legend-open")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeCamera(true);
  }, true);
  new MutationObserver(syncMarkers).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("load", syncMarkers);
  window.addEventListener("resize", () => { syncCameraRow(); if (!panel.hidden) mountPanel(); });
  window.visualViewport?.addEventListener("resize", () => { if (!panel.hidden) mountPanel(); });
  window.visualViewport?.addEventListener("scroll", () => { if (!panel.hidden) mountPanel(); });
  const layoutObserver = new ResizeObserver(() => { if (!panel.hidden) mountPanel(); });
  ["topBanner", "mapTitleBadge", "mobileControlsToggle", "legendDock", "timelineDock"].map(id => document.getElementById(id))
    .filter(Boolean).forEach(el => layoutObserver.observe(el));
  window.addEventListener("pagehide", () => setEnabled(false));
  window.addEventListener("pageshow", event => { if (event.persisted) setEnabled(false); });
  setEnabled(false);
})();
