/* Larger, quieter road labels shared by the interactive map and exports. */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ShorelyRoadLabels = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const SOURCE = "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer";
  const VERSION = "20261030-large-roads-v1";
  const sleep = ms => new Promise(resolve => (root.setTimeout || setTimeout)(resolve, ms));
  const frame = () => new Promise(resolve => typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(resolve) : (root.setTimeout || setTimeout)(resolve, 16));
  const clone = object => JSON.parse(JSON.stringify(object));

  function unitValue(value) {
    if (value == null) return 1;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 8) throw new RangeError("Invalid road-label scale.");
    return value;
  }

  function roadRole(layer) {
    if (layer?.type !== "symbol") return null;
    const source = String(layer["source-layer"] || "");
    if (!/^road(?:\s|\/)/i.test(source) || !/\/label$/i.test(source)) return null;
    const id = String(layer.id || "").toLowerCase();
    if (/under construction|pedestrian|raceway|bridleway|cycleway|steps|living street/.test(id)) return null;
    const layout = layer.layout || {};
    if (!layout["text-field"]) return null;
    const shield = /\bshield$/.test(id) && !!layout["icon-image"];
    const roadType = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential"].find(name => id.includes(name));
    if (!roadType || (!shield && !/\bname$/.test(id))) return null;
    const rank = { residential: 0, tertiary: 10, secondary: 20, primary: 30, trunk: 40, motorway: 50 }[roadType];
    return { shield, major: ["motorway", "trunk", "primary", "secondary"].includes(roadType), rank: rank + (shield ? 100 : 0) };
  }

  function abbreviatedName(field) {
    if (Array.isArray(field) && field[0] === "let" && field[1] === "roadname" && field[3]?.[0] === "let" && field[3]?.[1] === "shortroad") return field;
    // MapLibre's portable string expressions avoid changing provider data and
    // work with both the 2D bundled renderer and the standalone 3D renderer.
    let original = field;
    if (typeof field === "string") {
      const match = field.match(/^\{([^{}]+)\}$/);
      if (!match) return field;
      original = ["to-string", ["coalesce", ["get", match[1]], ""]];
    }
    if (!Array.isArray(original)) return field;
    const name = ["var", "roadname"];
    const direction = ["case"];
    for (const [long, short] of [["North ", "N "], ["South ", "S "], ["East ", "E "], ["West ", "W "]]) {
      direction.push(["==", ["slice", ["downcase", name], 0, long.length], long.toLowerCase()], ["concat", short, ["slice", name, long.length]]);
    }
    direction.push(name);
    const abbreviated = ["case"], shortName = ["var", "shortroad"];
    for (const [long, short] of [[" Street", " St"], [" Avenue", " Ave"], [" Road", " Rd"], [" Boulevard", " Blvd"], [" Parkway", " Pkwy"], [" Drive", " Dr"], [" Lane", " Ln"], [" Court", " Ct"], [" Circle", " Cir"], [" Terrace", " Ter"], [" Place", " Pl"], [" Highway", " Hwy"]]) {
      const start = ["-", ["length", shortName], long.length];
      abbreviated.push(["all", [">", ["length", shortName], long.length], ["==", ["slice", ["downcase", shortName], start], long.toLowerCase()]], ["concat", ["slice", shortName, 0, start], short]);
    }
    abbreviated.push(shortName);
    return ["let", "roadname", original, ["let", "shortroad", direction, abbreviated]];
  }

  function increasingSize(base, unit, growth = 2) {
    return { stops: [[0, base * unit], [16, base * unit], [19, (base + growth) * unit], [24, (base + growth) * unit]] };
  }

  function styleRoadLabels(style, settings = {}) {
    if (!style || !Array.isArray(style.layers)) throw new Error("Road-label style is unavailable.");
    const unit = unitValue(settings.unit), exported = settings.exportMode === true;
    const next = clone(style);
    const labels = [];
    for (const layer of next.layers) {
      const role = roadRole(layer);
      if (!role || (settings.includeNames === false && !role.shield)) continue;
      const textSize = role.shield ? (exported ? 30 : 20) : role.major ? (exported ? 20 : 18) : (exported ? 20 : 16);
      const liveNameSize = role.major ? [[0, 18], [14, 18], [16, 19], [19, 20], [24, 20]] : [[0, 16], [14, 16], [16, 18], [19, 20], [24, 20]];
      layer.minzoom = role.shield ? 8 : role.major ? 10 : 12;
      delete layer.maxzoom;
      layer.layout = {
        ...layer.layout,
        visibility: "visible",
        "text-size": exported || role.shield ? increasingSize(textSize, unit) : { stops: liveNameSize.map(([z, size]) => [z, size * unit]) },
        "text-field": role.shield ? layer.layout["text-field"] : abbreviatedName(layer.layout["text-field"]),
        "text-padding": { stops: [[0, (exported ? 3 : 6) * unit], [15, (exported ? 3 : 6) * unit], [19, (exported ? 3 : 12) * unit], [24, (exported ? 3 : 12) * unit]] },
        "symbol-spacing": exported ? (role.shield ? 500 : 150) * unit : role.shield ? 760 * unit : { stops: [[0, 650 * unit], [14, 650 * unit], [19, 1000 * unit], [24, 1000 * unit]] },
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "text-optional": false,
        "text-max-angle": exported ? 60 : 24,
        ...(!role.shield && exported ? { "symbol-placement": "line", "text-rotation-alignment": "map", "text-pitch-alignment": "map" } : {}),
        "text-keep-upright": true
      };
      layer.paint = {
        ...layer.paint,
        "text-color": "#233544",
        "text-opacity": 1,
        "text-halo-color": "#ffffff",
        "text-halo-width": (role.shield ? 0 : 1.8) * unit,
        "text-halo-blur": 0.25 * unit
      };
      if (role.shield) {
        // Scale the provider's original shield sprites in proportion to its
        // original ten-pixel route numerals. Never fabricate route references.
        layer.layout["icon-size"] = increasingSize(exported ? 3.6 : 2.4, unit, 0.24);
        layer.layout["icon-allow-overlap"] = false;
        layer.layout["icon-ignore-placement"] = false;
        layer.layout["icon-optional"] = false;
        layer.layout["icon-padding"] = (exported ? 4 : 9) * unit;
        layer.paint["icon-opacity"] = 1;
      }
      labels.push({ layer, rank: role.rank });
    }
    if (!labels.length) throw new Error("The provider did not supply any road labels.");
    // MapLibre places symbols in reverse drawing order. Routes therefore get
    // collision priority over ordinary street names, including on first load.
    next.layers = labels.sort((a, b) => a.rank - b.rank).map(item => item.layer);
    next.metadata = { ...(next.metadata || {}), "shorelysafe:road-labels": VERSION, "shorelysafe:export-unit": unit };
    return next;
  }

  function styleBasemap(style, settings = {}) {
    const next = clone(style);
    const roads = styleRoadLabels(style, settings);
    next.layers = next.layers.filter(layer => layer.type !== "symbol").concat(roads.layers);
    next.metadata = { ...(next.metadata || {}), ...roads.metadata };
    return next;
  }

  function isLayer(layer) { return !!layer?._shorelyRoadLabels; }
  function glMap(layer) { return layer?._maplibreGL?._glMap || layer?._maplibreGL?.getMaplibreMap?.() || null; }
  function canvasElement(layer) { return glMap(layer)?.getCanvas?.() || glMap(layer)?._actualCanvas || null; }
  function vectorContainer(layer) { return layer?._maplibreGL?.getContainer?.() || layer?._maplibreGL?._container || canvasElement(layer)?.parentElement || null; }
  function signalError(signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Road-label capture was cancelled.");
  }
  function viewMatches(layer, gl) {
    const map = layer._map;
    if (!map || !gl) return false;
    const center = map.getCenter?.(), glCenter = gl.getCenter?.();
    if (center && glCenter) {
      // Leaflet rounds its projected center during resize. Compare actual
      // viewport pixels so harmless subpixel rounding is stable at every zoom.
      const lng = glCenter.lng + (((center.lng - glCenter.lng + 180) % 360 + 360) % 360) - 180;
      const a = gl.project?.({ lng, lat: center.lat }), b = gl.project?.(glCenter);
      if (!a || !b || !Number.isFinite(a.x + a.y + b.x + b.y) || Math.hypot(a.x - b.x, a.y - b.y) > 1) return false;
    }
    if (typeof gl.getZoom === "function" && typeof map.getZoom === "function" && Math.abs(gl.getZoom() - (map.getZoom() - 1)) > 0.02) return false;
    return true;
  }
  function loaded(layer) {
    const gl = glMap(layer);
    return !!(layer?._roadMounted && layer._roadStyled && !layer._roadError && gl && gl.loaded?.() && gl.areTilesLoaded?.() && viewMatches(layer, gl));
  }
  function syncOpacity(layer) {
    const container = vectorContainer(layer);
    if (container) {
      container.classList?.add("shorely-road-labels");
      container.style.pointerEvents = "none";
      container.style.opacity = layer._roadReady ? String(layer.options.opacity) : "0";
    }
  }
  function hookRenderer(layer) {
    const gl = glMap(layer);
    if (!gl || layer._roadHookedMap === gl) return;
    layer._roadHookedMap = gl;
    gl.on?.("error", event => {
      if (!layer._roadMounted) return;
      layer._roadError = event?.error || new Error("Road labels could not load.");
      layer._roadReady = false; syncOpacity(layer);
    });
  }

  function createLayer(options = {}) {
    const L = root.L;
    if (!L?.esri?.Vector?.vectorTileLayer) throw new Error("The road-label renderer is unavailable.");
    const settings = { exportMode: options.exportMode === true, unit: unitValue(options.unit), includeNames: options.includeNames !== false };
    let layer;
    const styled = original => {
      let result;
      try { result = styleRoadLabels(original, settings); }
      catch (error) {
        if (layer) layer._roadError = error;
        return { ...original, layers: [] };
      }
      // The vendor calls setStyle with this return value. Queue the flag after
      // that call, keeping its initial unfiltered address labels transparent.
      Promise.resolve().then(() => {
        if (!layer) return;
        layer._roadStyled = true; hookRenderer(layer); syncOpacity(layer);
        if (layer._roadMounted) layer.whenReady().catch(() => {});
      });
      return result;
    };
    const requestedOpacity = options.opacity == null ? 1 : Number(options.opacity);
    if (!Number.isFinite(requestedOpacity)) throw new TypeError("Invalid road-label opacity.");
    layer = L.esri.Vector.vectorTileLayer(SOURCE, {
      ...options, opacity: 0, preserveDrawingBuffer: true, style: styled,
      pane: options.pane || "roadsPane"
    });
    layer._shorelyRoadLabels = true;
    layer._roadSettings = settings;
    layer._roadStyled = false; layer._roadReady = false; layer._roadMounted = false; layer._roadError = null;
    layer._roadBootstrapFailed = false;
    layer.options.opacity = Math.max(0, Math.min(1, requestedOpacity));
    layer.setOpacity = function (opacity) {
      const value = Number(opacity);
      if (!Number.isFinite(value)) throw new TypeError("Invalid road-label opacity.");
      this.options.opacity = Math.max(0, Math.min(1, value)); syncOpacity(this); return this;
    };
    layer.getContainer = function () { return vectorContainer(this); };
    layer.getMaplibreMap = function () { return glMap(this); };
    layer.isLoading = function () { return this.options.opacity > 0 && !loaded(this); };
    layer.setExportUnit = layer.setUnit = function (value) {
      const unit = unitValue(value);
      if (unit === settings.unit) return this;
      settings.unit = unit; this.options.unit = unit;
      const gl = glMap(this);
      if (gl && this._roadStyled) {
        this._roadReady = false; syncOpacity(this);
        gl.setStyle(styleRoadLabels(gl.getStyle(), settings));
        this.whenReady().catch(() => {});
      }
      return this;
    };
    layer.whenReady = async function ({ timeoutMs = 25000, signal, retry = false } = {}) {
      signalError(signal);
      if (!this._roadMounted || !this._map) throw new Error("The road-label layer is not on the map.");
      if (retry && this._roadBootstrapFailed) {
        // Esri's load-error fires before its child renderer exists. Re-run
        // the adapter's metadata/style bootstrap while keeping this wrapper
        // and its map listeners attached.
        this._roadBootstrapFailed = false;
        this._roadError = null;
        try { this._createLayer(); }
        catch (error) { this._roadBootstrapFailed = true; this._roadError = error; }
      } else if (retry && this._roadError && this._roadStyled) {
        const gl = glMap(this);
        if (gl) {
          // An explicit new preview/export attempt retries failed transport on
          // the same renderer. Rebuild source caches: errored tiles can report
          // loaded=true, so clearing only the error would accept a blank view.
          const style = styleRoadLabels(gl.getStyle(), settings);
          this._roadError = null; this._roadReady = false; syncOpacity(this);
          try { gl.setStyle(style, { diff: false }); }
          catch (error) { this._roadError = error; }
        }
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        signalError(signal);
        if (!this._roadMounted || !this._map) throw new Error("The road-label map was closed.");
        if (this._roadError) throw new Error("Road labels could not load cleanly.", { cause: this._roadError });
        hookRenderer(this);
        if (loaded(this)) {
          glMap(this).triggerRepaint?.(); await frame(); await frame();
          signalError(signal);
          if (!loaded(this)) continue;
          this._roadReady = true; syncOpacity(this); return this;
        }
        await sleep(60);
      }
      throw new Error("Road labels are still loading. Please try the export again.");
    };
    layer.captureCanvas = async function ({ scale = 1, timeoutMs = 25000, signal } = {}) {
      unitValue(scale);
      await this.whenReady({ timeoutMs, signal });
      const source = canvasElement(this), map = this._map, size = map?.getSize?.();
      if (!source?.width || !source?.height || !size?.x || !size?.y) throw new Error("The road-label canvas is empty.");
      const rect = source.getBoundingClientRect(), viewport = map.getContainer().getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0 && viewport.width > 0 && viewport.height > 0)) throw new Error("The road-label view is not visible.");
      const result = root.document.createElement("canvas");
      result.width = Math.max(1, Math.round(size.x * scale)); result.height = Math.max(1, Math.round(size.y * scale));
      const context = result.getContext("2d");
      if (!context) throw new Error("The road-label capture canvas is unavailable.");
      context.globalAlpha = this.options.opacity;
      context.drawImage(source, (rect.left - viewport.left) * scale, (rect.top - viewport.top) * scale, rect.width * scale, rect.height * scale);
      context.globalAlpha = 1;
      // Reading a pixel verifies origin cleanliness. Transparent views can be
      // valid at sea, so there is no invented minimum label/pixel count.
      try { context.getImageData(0, 0, 1, 1); }
      catch (error) { result.width = result.height = 1; throw new Error("Road labels could not be exported cleanly.", { cause: error }); }
      return result;
    };
    layer.onAdd = function (map) {
      this._map = map; this._roadMounted = true; this._roadReady = false;
      this._roadOnReady = () => {
        if (!this._roadMounted || this._map !== map) return;
        this._asyncAdd(); hookRenderer(this); syncOpacity(this);
      };
      if (this._ready) this._roadOnReady(); else this.once("ready", this._roadOnReady);
      this.whenReady({ retry: true }).catch(() => {});
    };
    layer.onRemove = function (map) {
      this._roadMounted = false; this._roadReady = false;
      if (this._roadOnReady) this.off("ready", this._roadOnReady);
      if (this._maplibreGL && map.hasLayer(this._maplibreGL)) map.removeLayer(this._maplibreGL);
      syncOpacity(this);
    };
    layer.on("load-error", event => {
      layer._roadBootstrapFailed = true;
      layer._roadError = event?.value || new Error("Road labels could not load.");
      layer._roadReady = false;
      syncOpacity(layer);
    });
    return layer;
  }
  return Object.freeze({ VERSION, SOURCE, styleRoadLabels, styleBasemap, abbreviatedName, createLayer, isLayer,
    whenReady: (layer, options) => { if (!isLayer(layer)) return Promise.reject(new Error("Unknown road-label layer.")); return layer.whenReady(options); },
    captureCanvas: (layer, options) => { if (!isLayer(layer)) return Promise.reject(new Error("Unknown road-label layer.")); return layer.captureCanvas(options); } });
});
