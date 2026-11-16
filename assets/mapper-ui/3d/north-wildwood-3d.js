(function () {
  "use strict";

  var TERRAIN_EXAGGERATION = 4;
  var MAP_MAX_ZOOM = 22;
  var DEFAULT_PITCH = 0;
  var DEFAULT_BEARING = 0;
  var THREE_D_PITCH = 60;
  var FLOOD_DEPTH_DETAIL_MIN_ZOOM = 15.25;
  var GRAPHICS_FALLBACK_NOTICE = "Map graphics were interrupted. The 2D map is active.";
  var WEB_MERCATOR_EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
  var MAPLIBRE_TILE_SIZE = 512;
  var MAPLIBRE_CSS_URL = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css";
  var MAPLIBRE_JS_URL = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js";
  var ESRI_STYLE_URL = "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/resources/styles/root.json";
  var ESRI_VECTOR_TILES = "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf";
  var TERRAIN_TILEJSON_URL = "https://tiles.mapterhorn.com/tilejson.json";

  var glMap = null;
  var glMapPromise = null;
  var failedEsriVectorSources = new WeakSet();
  var glMapInitialization = null;
  var glStyleReady = false;
  var glPopup = null;
  var buildingData = null;
  var buildingDataPromise = null;
  var mapLibreRuntimePromise = null;
  var mapStylePromise = null;
  var floodPlaneLayer = null;
  var pendingFlood3dRequest = null;
  var floodRemovalTimer = null;
  var syncingFromLeaflet = false;
  var syncingFrom3d = false;
  var syncingModeTransition = false;
  var buildingCursorHandlersWired = false;
  var buildingToggleGeneration = 0;
  var buildingVisibilityPreference = null;
  var fallbackBuildingPopup = null;
  var fallbackBuildingRenderToken = null;
  var navControlSyncFrame = null;
  var retryFloodRecovery3d = null;
  var syncPersistentNavControl = function () {};

  function schedulePersistentNavControlSync() {
    if (navControlSyncFrame !== null) return;
    navControlSyncFrame = requestAnimationFrame(function () {
      navControlSyncFrame = null;
      syncPersistentNavControl();
    });
  }

  function setStatus(text) {
    var status = document.getElementById("map3dStatus");
    if (status) status.textContent = text || "3D terrain ×4";
    updateDiagnostics();
  }

  function loadMapLibreRuntime() {
    if (mapLibreRuntimePromise) return mapLibreRuntimePromise;
    function dependency(id, tag, url) {
      return new Promise(function (resolve, reject) {
        var existing = document.getElementById(id);
        if (existing && existing.dataset.loaded === "true") { resolve(); return; }
        if (existing) existing.remove();
        var element = document.createElement(tag);
        element.id = id;
        if (tag === "link") { element.rel = "stylesheet"; element.href = url; }
        else { element.src = url; element.async = true; }
        var timer = window.setTimeout(function () { finish(new Error("The 3D dependency timed out.")); }, 20000);
        var settled = false;
        function finish(error) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          element.onload = null;
          element.onerror = null;
          if (error) { element.remove(); reject(error); }
          else { element.dataset.loaded = "true"; resolve(); }
        }
        element.onload = function () { finish(); };
        element.onerror = function () { finish(new Error("The 3D dependency could not be loaded.")); };
        document.head.appendChild(element);
      });
    }
    mapLibreRuntimePromise = Promise.allSettled([
      dependency("nwMapLibreCss", "link", MAPLIBRE_CSS_URL),
      window.maplibregl && typeof window.maplibregl.Map === "function"
        ? Promise.resolve() : dependency("nwMapLibreScript", "script", MAPLIBRE_JS_URL)
    ]).then(function (results) {
      var failure = results.find(function (result) { return result.status === "rejected"; });
      if (failure) throw failure.reason;
      if (!window.maplibregl || typeof window.maplibregl.Map !== "function") {
        var failed = document.getElementById("nwMapLibreScript");
        if (failed) failed.remove();
        throw new Error("This browser does not support the 3D map renderer.");
      }
      return window.maplibregl;
    }).catch(function (error) {
      mapLibreRuntimePromise = null;
      throw error;
    });
    return mapLibreRuntimePromise;
  }

  function updateDiagnostics() {
    var output = document.getElementById("map3dDiagnostics");
    if (!output) return;
    var cameraAltitudeMeters = glMap && glStyleReady ? cameraAltitudeAboveTerrainMeters() : null;
    var state = {
      ready: Boolean(glStyleReady && document.body.dataset.map3d === "ready"),
      exaggeration: TERRAIN_EXAGGERATION,
      maxZoom: MAP_MAX_ZOOM,
      pitch: glMap ? Number(glMap.getPitch().toFixed(2)) : null,
      bearing: glMap ? Number(glMap.getBearing().toFixed(2)) : null,
      zoom: glMap ? Number(glMap.getZoom().toFixed(3)) : null,
      cameraAltitudeMeters: cameraAltitudeMeters !== null
        ? Number(cameraAltitudeMeters.toFixed(1))
        : null,
      centerLng: glMap ? Number(glMap.getCenter().lng.toFixed(7)) : null,
      centerLat: glMap ? Number(glMap.getCenter().lat.toFixed(7)) : null,
      terrainSource: glMap && glStyleReady && glMap.getTerrain ? glMap.getTerrain() : null,
      buildingCount: buildingData && buildingData.features ? buildingData.features.length : 0,
      buildingsVisible: Boolean(glMap && glStyleReady && glMap.getLayer("nw-3d-buildings") &&
        glMap.getLayoutProperty("nw-3d-buildings", "visibility") !== "none"),
      nsiOccupiedFloorCount: Array.isArray(nsiStructureFeatures) ? nsiStructureFeatures.length : 0,
      nsiOccupiedFloorsVisible: Boolean(glMap && glStyleReady && glMap.getLayer("nw-nsi-points") &&
        glMap.getLayoutProperty("nw-nsi-points", "visibility") !== "none"),
      floodSurface: document.body.dataset.map3dFloodSurface || null,
      floodAltitudeMeters: Number(document.body.dataset.map3dFloodAltitudeMeters) || null,
      buildingMaximumHeightFt: Number(document.body.dataset.buildings3dMaxHeightFt) || null
    };
    output.textContent = JSON.stringify(state);
  }

  function normalizeBearing(value) {
    return ((Number(value) % 360) + 360) % 360;
  }

  function bearingFromViewpointVector(x, y) {
    var viewpointBearing = Math.atan2(Number(x) || 0, -(Number(y) || 0)) * 180 / Math.PI;
    return normalizeBearing(viewpointBearing + 180);
  }

  function layerVisible(toggleId, defaultValue) {
    var toggle = document.getElementById(toggleId);
    return toggle ? toggle.classList.contains("on") : Boolean(defaultValue);
  }

  function visibility(value) {
    return value ? "visible" : "none";
  }

  function absoluteStyleAsset(value) {
    if (!value) return value;
    try {
      return new URL(value, ESRI_STYLE_URL).href
        .replace(/%7B/gi, "{")
        .replace(/%7D/gi, "}");
    } catch (_) {
      return value;
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function fetch3dJson(url, message) {
    // Bound the body as well as the response, even if transport ignores abort.
    var controller = new AbortController();
    var cancel;
    var request = new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () { finish(new Error(message + " The request timed out.")); }, 20000);
      function finish(error, payload) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) { controller.abort(); reject(error); }
        else resolve(payload);
      }
      cancel = function () { finish(new Error(message + " The request was cancelled.")); };
      Promise.resolve().then(function () {
        return fetch(url, { cache: "force-cache", signal: controller.signal });
      }).then(function (response) {
        if (!response.ok) throw new Error(message);
        return response.json();
      }).then(function (payload) { finish(null, payload); }, function (error) { finish(error); });
    });
    request.cancel = function () { cancel(); };
    return request;
  }

  async function load3dStyle() {
    if (!mapStylePromise) {
      var load = fetch3dJson(ESRI_STYLE_URL, "The 3D basemap style could not be loaded.");
      var request = load
        .then(function (style) {
          style.sprite = absoluteStyleAsset(style.sprite);
          style.glyphs = absoluteStyleAsset(style.glyphs);
          style.sources = style.sources || {};
          style.sources.esri = {
            type: "vector",
            tiles: [ESRI_VECTOR_TILES],
            minzoom: 0,
            maxzoom: 22,
            attribution: "&copy; OpenStreetMap contributors, Esri"
          };
          const geometryStyle = typeof styleEsriBuildingBasemap === "function" ? styleEsriBuildingBasemap(style) : style;
          if (!window.ShorelyRoadLabels) throw new Error("The road-label renderer could not load.");
          return window.ShorelyRoadLabels.styleBasemap(geometryStyle); // shorely-road-labels-3d-v1
        })
        .catch(function (error) {
          if (mapStylePromise === request) mapStylePromise = null;
          throw error;
        });
      request.cancel = load.cancel;
      mapStylePromise = request;
    }
    return cloneJson(await mapStylePromise);
  }

  function coordinatesFromLeafletBounds(bounds) {
    if (!bounds || typeof bounds.getWest !== "function") return null;
    return [
      [bounds.getWest(), bounds.getNorth()],
      [bounds.getEast(), bounds.getNorth()],
      [bounds.getEast(), bounds.getSouth()],
      [bounds.getWest(), bounds.getSouth()]
    ];
  }

  function activeFloodCoordinates() {
    if (typeof getActiveFloodOverlayCoordinates === "function") {
      var configured = getActiveFloodOverlayCoordinates();
      if (Array.isArray(configured) && configured.length === 4) return configured;
    }
    return coordinatesFromLeafletBounds(floodLatLngBounds);
  }

  function configuredWorldFileCoordinates() {
    if (typeof getConfiguredWorldFileCoordinates === "function") {
      var configured = getConfiguredWorldFileCoordinates();
      if (Array.isArray(configured) && configured.length === 4) return configured;
    }
    return coordinatesFromLeafletBounds(floodLatLngBounds || getBoundaryDrivenOverlayBounds());
  }

  function addLayerBelowMask(layer, beforeId) {
    if (!glMap || glMap.getLayer(layer.id)) return;
    glMap.addLayer(layer, beforeId || (glMap.getLayer("nw-boundary-mask") ? "nw-boundary-mask" : undefined));
  }

  function removeLayerAndSource(layerId, sourceId) {
    if (!glMap || !glStyleReady) return;
    if (glMap.getLayer(layerId)) glMap.removeLayer(layerId);
    if (sourceId && glMap.getSource(sourceId)) glMap.removeSource(sourceId);
  }

  function suspendLeafletVisualLayers() {
    if (!map || !document.body.classList.contains("map-3d-ready")) return;
    [
      basemapGrayLayer,
      basemapColorLayer,
      satelliteLayer,
      roadsLayer,
      buildingsLayer,
      parcelsLayer,
      parcelsLayer?._parcelVector,
      nsiStructuresLayer,
      cityBoundaryMask,
      cityBoundaryOutline,
      cityBoundaryGuide
    ].forEach(function (layer) {
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  function restoreLeafletAfter3dFailure(mapInstance) {
    var center = mapInstance.getCenter();
    var zoom = mapInstance.getZoom();
    if (glPopup && persistentFloodPopup !== townAddressPopup) persistentFloodPopup?.remove();
    closeGlPopup();
    setAddressMarker(null);
    ++mapQueryGeneration;
    glMap = null;
    glMapPromise = null;
    glMapInitialization = null;
    glStyleReady = false;
    floodPlaneLayer = null;
    pendingFlood3dRequest = null;
    retryFloodRecovery3d = null;
    buildingCursorHandlersWired = false;
    document.body.classList.remove("map-3d-ready");
    document.body.dataset.map3d = "fallback";
    if (map) map.off("moveend zoomend", syncLeafletViewTo3d);
    try { mapInstance.remove(); } catch (_) {}

    if (map) {
      map.invalidateSize({ pan: false });
      map.setView([center.lat, center.lng], zoom, { animate: false, reset: true });
      [
        basemapGrayLayer,
        basemapColorLayer,
        roadsLayer,
        layerVisible("satelliteToggle", false) ? satelliteLayer : null,
        layerVisible("parcelsToggle", false) ? parcelsLayer : null,
        layerVisible("nsiStructuresToggle", false) ? nsiStructuresLayer : null,
        cityBoundaryMask,
        isTownBoundaryEnabled() ? cityBoundaryOutline : null,
        cityBoundaryGuide
      ].forEach(function (layer) {
        if (layer && !map.hasLayer(layer)) layer.addTo(map);
      });
      if (layerVisible("buildingsToggle", false)) {
        originalSetBuildingsEnabled(true, { preserveClickMode: true }).catch(function (error) {
          console.warn("The 2D building layer could not be restored.", error);
        });
      }
      updateParcelBoundaryResolution();
      updateRoadLayerAppearance();
      updateColorBasemapClip();
    }
    syncPersistentNavControl();
    toast(GRAPHICS_FALLBACK_NOTICE);
  }

  var imageLayerVersions = new WeakMap();
  function updateImageLayer(options) {
    if (!glMap || !glStyleReady || !options.url || !options.coordinates) return;
    var source = glMap.getSource(options.sourceId);
    var signature = JSON.stringify([options.url, options.coordinates]);
    if (source && typeof source.updateImage === "function") {
      if (imageLayerVersions.get(source) !== signature || options.reload === true) {
        source.updateImage({ url: options.url, coordinates: options.coordinates });
        imageLayerVersions.set(source, signature);
      }
    } else {
      glMap.addSource(options.sourceId, {
        type: "image",
        url: options.url,
        coordinates: options.coordinates
      });
      imageLayerVersions.set(glMap.getSource(options.sourceId), signature);
      addLayerBelowMask({
        id: options.layerId,
        type: "raster",
        source: options.sourceId,
        paint: {
          "raster-opacity": options.opacity,
          "raster-resampling": "linear",
          "raster-fade-duration": 0
        }
      }, options.beforeId);
    }
    if (glMap.getLayer(options.layerId)) {
      glMap.setPaintProperty(options.layerId, "raster-opacity", options.opacity);
      glMap.setLayoutProperty(options.layerId, "visibility", visibility(options.visible !== false));
    }
  }

  function compileFloodPlaneShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var message = gl.getShaderInfoLog(shader) || "Unknown shader error";
      gl.deleteShader(shader);
      throw new Error("The flat-water shader could not compile: " + message);
    }
    return shader;
  }

  function createFlatFloodPlane(options) {
    var initial = options || {};
    return {
      id: "nw-flood-overlay",
      type: "custom",
      // Floodwater is a true level surface in the same depth buffer as terrain.
      // A no-depth 2D custom pass made the PNG slide over the map while the
      // camera moved and could leave MapLibre's following layers with mutated
      // WebGL state. Sharing the 3D depth buffer keeps the world-file corners
      // locked to terrain and clips water cleanly at land and structures.
      renderingMode: "3d",
      map: null,
      gl: null,
      program: null,
      buffer: null,
      vertexArray: null,
      texture: null,
      matrixLocation: null,
      opacityLocation: null,
      imageLocation: null,
      positionLocation: -1,
      textureLocation: -1,
      mercatorOrigin: null,
      localProjectionMatrix: new Float32Array(16),
      textureReady: false,
      visible: Boolean(initial.visible),
      useDepthTest: initial.useDepthTest !== false,
      textureLoadPromise: Promise.resolve(false),
      imageToken: 0,
      committedUrl: "",
      cancelTextureLoad: null,
      retiredTextures: [],
      pendingFrame: { coordinates: initial.coordinates || null, altitudeMeters: Number(initial.altitudeMeters) || 0, isCurrent: initial.isCurrent || null },
      url: initial.url || "",
      coordinates: initial.coordinates || null,
      altitudeMeters: Number(initial.altitudeMeters) || 0,
      opacity: Number.isFinite(Number(initial.opacity)) ? Number(initial.opacity) : 0.75,

      onAdd: function (mapInstance, gl) {
        this.map = mapInstance;
        this.gl = gl;
        var priorVertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        var priorArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        var priorActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE0);
        var priorTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
        var vertexSource = '#version 300 es\n' +
          'precision highp float;\n' +
          'uniform mat4 u_matrix;\n' +
          'in vec3 a_position;\n' +
          'in vec2 a_texture;\n' +
          'out vec2 v_texture;\n' +
          'void main(){\n' +
          '  v_texture = a_texture;\n' +
          '  gl_Position = u_matrix * vec4(a_position, 1.0);\n' +
          '}';
        var fragmentSource = '#version 300 es\n' +
          'precision highp float;\n' +
          'uniform sampler2D u_image;\n' +
          'uniform float u_opacity;\n' +
          'in vec2 v_texture;\n' +
          'out vec4 fragColor;\n' +
          'void main(){ vec4 pixel = texture(u_image, v_texture); float alpha = pixel.a * u_opacity; if(alpha < 0.012) discard; fragColor = vec4(pixel.rgb * alpha, alpha); }';
        var vertexShader = compileFloodPlaneShader(gl, gl.VERTEX_SHADER, vertexSource);
        var fragmentShader = compileFloodPlaneShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
          throw new Error("The flat-water renderer could not link: " + (gl.getProgramInfoLog(this.program) || "Unknown program error"));
        }
        this.matrixLocation = gl.getUniformLocation(this.program, "u_matrix");
        this.opacityLocation = gl.getUniformLocation(this.program, "u_opacity");
        this.imageLocation = gl.getUniformLocation(this.program, "u_image");
        this.positionLocation = gl.getAttribLocation(this.program, "a_position");
        this.textureLocation = gl.getAttribLocation(this.program, "a_texture");
        this.buffer = gl.createBuffer();
        this.vertexArray = gl.createVertexArray();
        gl.bindVertexArray(this.vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(this.textureLocation);
        gl.vertexAttribPointer(this.textureLocation, 2, gl.FLOAT, false, 20, 12);
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.updateGeometry();
        this.loadTexture(this.url);
        // onAdd runs outside MapLibre's guarded custom render pass. Restore
        // every binding we touched so the next terrain frame starts from the
        // state MapLibre recorded in its own WebGL cache.
        gl.bindTexture(gl.TEXTURE_2D, priorTexture0);
        gl.activeTexture(priorActiveTexture);
        gl.bindBuffer(gl.ARRAY_BUFFER, priorArrayBuffer);
        gl.bindVertexArray(priorVertexArray);
      },

      updateGeometry: function () {
        if (!this.gl || !Array.isArray(this.coordinates) || this.coordinates.length !== 4) return;
        var points = this.coordinates.map(function (coordinate) {
          return maplibregl.MercatorCoordinate.fromLngLat(
            { lng: Number(coordinate[0]), lat: Number(coordinate[1]) },
            Number(this.altitudeMeters) || 0
          );
        }, this);
        // Store small camera-independent offsets around the quad's own center.
        // Multiplying two large high/low world coordinates in the vertex shader
        // still loses bits when the zoom matrix changes. A local origin keeps
        // every vertex near zero and removes the sub-pixel PNG "wiggle".
        this.mercatorOrigin = {
          x: points.reduce(function (sum, point) { return sum + point.x; }, 0) / points.length,
          y: points.reduce(function (sum, point) { return sum + point.y; }, 0) / points.length,
          z: points.reduce(function (sum, point) { return sum + (point.z || 0); }, 0) / points.length
        };
        var origin = this.mercatorOrigin;
        var vertex = function (point, u, v) {
          return [point.x - origin.x, point.y - origin.y, (point.z || 0) - origin.z, u, v];
        };
        var values = []
          .concat(vertex(points[0], 0, 0), vertex(points[1], 1, 0), vertex(points[2], 1, 1))
          .concat(vertex(points[0], 0, 0), vertex(points[2], 1, 1), vertex(points[3], 0, 1));
        var priorArrayBuffer = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(values), this.gl.STATIC_DRAW);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, priorArrayBuffer);
        document.body.dataset.map3dFloodPrecision = "camera-stable-local-origin";
      },

      loadTexture: function (url) {
        if (!this.gl || !url) return Promise.resolve(false);
        if (this.cancelTextureLoad) this.cancelTextureLoad();
        var self = this;
        var token = ++this.imageToken;
        var image = new Image();
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        document.body.dataset.map3dFloodTexture = self.textureReady ? "updating" : "loading";
        this.textureLoadPromise = new Promise(function (resolve) {
          var settled = false;
          var timer = null;
          function finish(ready) {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = image.onerror = null;
            if (self.cancelTextureLoad === cancel) self.cancelTextureLoad = null;
            resolve(ready);
          }
          function cancel() { finish(false); }
          function failed() {
            if (token === self.imageToken) document.body.dataset.map3dFloodTexture = self.textureReady ? "stale" : "unavailable";
            finish(false);
          }
          self.cancelTextureLoad = cancel;
          timer = window.setTimeout(failed, 20000);
          image.onload = async function () {
            var replacement = null;
            try {
              if (typeof image.decode === "function") await image.decode();
              if (settled || token !== self.imageToken || !self.gl || !self.texture || self.gl.isContextLost?.() ||
                  self.pendingFrame?.isCurrent && !self.pendingFrame.isCurrent()) return finish(false);
              var gl = self.gl;
              var priorActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
              var priorFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
              var priorPremultiplyAlpha = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
              gl.activeTexture(gl.TEXTURE0);
              var priorTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
              try {
                // MapLibre shares this context. Attribute only errors from
                // this upload to the candidate, rather than an earlier draw.
                if (gl.getError) for (var errorIndex = 0; errorIndex < 8 && gl.getError() !== gl.NO_ERROR; errorIndex += 1) {}
                // Upload into a candidate texture. A decode/GPU failure cannot
                // damage the last complete image that is still on screen.
                replacement = gl.createTexture();
                if (!replacement) throw new Error("The next flood texture could not be allocated.");
                gl.bindTexture(gl.TEXTURE_2D, replacement);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                gl.generateMipmap(gl.TEXTURE_2D);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                if (gl.isContextLost?.() || gl.getError && gl.getError() !== gl.NO_ERROR) {
                  throw new Error("The next flood texture could not be uploaded.");
                }
              } finally {
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, priorFlipY);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, priorPremultiplyAlpha);
                gl.bindTexture(gl.TEXTURE_2D, priorTexture0);
                gl.activeTexture(priorActiveTexture);
              }
              var frame = self.pendingFrame || {};
              var previous = self.texture;
              self.texture = replacement;
              replacement = null;
              self.coordinates = frame.coordinates || self.coordinates;
              self.altitudeMeters = Number(frame.altitudeMeters) || 0;
              self.updateGeometry();
              self.committedUrl = url;
              self.textureReady = true;
              if (previous) {
                // Deleting a texture that MapLibre still has bound would alter
                // its state after restoration. Retire that handle in our next
                // guarded draw, once the replacement has been bound instead.
                if (previous === priorTexture0) self.retiredTextures.push(previous);
                else gl.deleteTexture(previous);
              }
              document.body.dataset.map3dFloodTexture = "ready";
              document.body.dataset.map3dFloodPhysicalAltitudeMeters = self.altitudeMeters.toFixed(3);
              document.body.dataset.map3dFloodAltitudeMeters = self.altitudeMeters.toFixed(3);
              if (self.map) self.map.triggerRepaint();
              finish(true);
            } catch (_) {
              if (replacement && self.gl) self.gl.deleteTexture(replacement);
              failed();
            }
          };
          image.onerror = failed;
          image.src = url;
        });
        return this.textureLoadPromise;
      },

      update: function (next) {
        var priorUrl = this.url;
        this.url = next.url || "";
        this.pendingFrame = { coordinates: next.coordinates || null, altitudeMeters: Number(next.altitudeMeters) || 0, isCurrent: next.isCurrent || null };
        this.opacity = Math.max(0, Math.min(1, Number(next.opacity)));
        this.useDepthTest = next.useDepthTest !== false;
        if (this.textureReady && this.committedUrl === this.url) {
          if (this.cancelTextureLoad) { this.imageToken += 1; this.cancelTextureLoad(); }
          this.coordinates = this.pendingFrame.coordinates;
          this.altitudeMeters = this.pendingFrame.altitudeMeters;
          this.updateGeometry();
          this.textureLoadPromise = Promise.resolve(true);
          document.body.dataset.map3dFloodTexture = "ready";
          document.body.dataset.map3dFloodPhysicalAltitudeMeters = this.altitudeMeters.toFixed(3);
        } else if (this.url && (this.url !== priorUrl || !this.cancelTextureLoad)) {
          // Geometry and the new texture commit together after decoding. The
          // previous image stays at its own water height while a load is pending.
          this.loadTexture(this.url);
        }
        if (this.map) this.map.triggerRepaint();
      },

      setOpacity: function (value) {
        this.opacity = Math.max(0, Math.min(1, Number(value)));
        if (this.map) this.map.triggerRepaint();
      },

      setVisible: function (value) {
        this.visible = Boolean(value);
        if (this.map) this.map.triggerRepaint();
      },

      setDepthTest: function (value) {
        var nextValue = Boolean(value);
        if (this.useDepthTest === nextValue) return;
        this.useDepthTest = nextValue;
        if (this.map) this.map.triggerRepaint();
      },

      whenReady: function () {
        return this.textureLoadPromise || Promise.resolve(this.textureReady);
      },

      render: function (gl, args) {
        if (!this.visible || !this.textureReady || !this.program || !this.buffer || !this.texture) return;
        var matrix = args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix
          ? args.defaultProjectionData.mainMatrix
          : args && args.projectionMatrix
            ? args.projectionMatrix
            : args;
        if (!matrix) return;
        if (!this.mercatorOrigin) return;
        // Compose M * translate(origin) in JavaScript's double precision, then
        // upload one camera-relative Float32 matrix. This avoids the large
        // world-coordinate cancellation that made the flood texture shift
        // between adjacent zoom frames.
        var origin = this.mercatorOrigin;
        var localMatrix = this.localProjectionMatrix;
        for (var matrixIndex = 0; matrixIndex < 12; matrixIndex += 1) {
          localMatrix[matrixIndex] = matrix[matrixIndex];
        }
        localMatrix[12] = matrix[0] * origin.x + matrix[4] * origin.y + matrix[8] * origin.z + matrix[12];
        localMatrix[13] = matrix[1] * origin.x + matrix[5] * origin.y + matrix[9] * origin.z + matrix[13];
        localMatrix[14] = matrix[2] * origin.x + matrix[6] * origin.y + matrix[10] * origin.z + matrix[14];
        localMatrix[15] = matrix[3] * origin.x + matrix[7] * origin.y + matrix[11] * origin.z + matrix[15];
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.matrixLocation, false, localMatrix);
        gl.uniform1f(this.opacityLocation, this.opacity);
        gl.bindVertexArray(this.vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        while (this.retiredTextures.length) gl.deleteTexture(this.retiredTextures.pop());
        gl.uniform1i(this.imageLocation, 0);
        // MapLibre brackets custom render callbacks with context.setDirty().
        // Set every state this draw needs, then let that guard restore its
        // cached defaults. Per-frame getParameter() readbacks force a GPU/CPU
        // synchronization and were themselves a source of camera jank.
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (this.useDepthTest) {
          gl.enable(gl.DEPTH_TEST);
          // Strict depth comparison makes the shoreline deterministic. LEQUAL
          // let coplanar terrain/water samples alternate as the camera moved.
          gl.depthFunc(gl.LESS);
        } else {
          // At municipality overview zooms, MapLibre's exaggerated DEM skirts
          // are much wider than a street and write artificial tile-edge bands
          // into the depth buffer. The flood PNG already contains the modeled
          // wet/dry mask, so its overview pass must not be clipped by those
          // synthetic terrain walls.
          gl.disable(gl.DEPTH_TEST);
        }
        gl.disable(gl.CULL_FACE);
        // Terrain and the single opaque building pass already own the depth
        // buffer. Draw the level water surface afterward without writing new
        // depth: dry wall/roof fragments occlude it, while submerged wall
        // fragments receive one clean translucent water composite.
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
        document.body.dataset.map3dFloodGlIsolation = "maplibre-guarded-no-readback";
        document.body.dataset.map3dFloodDepthFunction = this.useDepthTest
          ? "less-no-coplanar-fight"
          : "overview-no-terrain-tile-depth";
      },

      onRemove: function (_, gl) {
        this.imageToken += 1;
        if (this.cancelTextureLoad) this.cancelTextureLoad();
        if (this.texture) gl.deleteTexture(this.texture);
        while (this.retiredTextures.length) gl.deleteTexture(this.retiredTextures.pop());
        if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
        if (this.buffer) gl.deleteBuffer(this.buffer);
        if (this.program) gl.deleteProgram(this.program);
        this.texture = null;
        this.vertexArray = null;
        this.buffer = null;
        this.program = null;
        this.gl = null;
        this.map = null;
      }
    };
  }

  function usesDetailedFloodDepth() {
    return Boolean(glMap && glMap.getPitch() > 10 && glMap.getZoom() >= FLOOD_DEPTH_DETAIL_MIN_ZOOM);
  }

  function cameraAltitudeAboveTerrainMeters() {
    if (!glMap) return null;
    if (typeof glMap.getFreeCameraOptions === "function") {
      var camera = glMap.getFreeCameraOptions();
      var position = camera && camera.position;
      if (position) {
        // Some MapLibre bundles return an IMercatorCoordinate-shaped plain
        // object rather than the class instance. Rehydrate it when needed.
        var altitudeCoordinate = typeof position.toAltitude === "function"
          ? position
          : window.maplibregl && typeof window.maplibregl.MercatorCoordinate === "function"
            ? new window.maplibregl.MercatorCoordinate(position.x, position.y, position.z)
            : null;
        if (altitudeCoordinate && typeof altitudeCoordinate.toAltitude === "function") {
          var absoluteAltitude = Number(altitudeCoordinate.toAltitude());
          if (Number.isFinite(absoluteAltitude)) {
            var terrainElevation = 0;
            if (typeof glMap.getCameraTargetElevation === "function") {
              var targetElevation = Number(glMap.getCameraTargetElevation());
              if (Number.isFinite(targetElevation)) terrainElevation = targetElevation;
            }
            return Math.max(0, absoluteAltitude - terrainElevation);
          }
        }
      }
    }

    // MapLibre GL JS does not expose FreeCameraOptions in every release. Its
    // public zoom, vertical-FOV, pitch, center latitude, and canvas height are
    // sufficient to compute the same eye height above the camera target.
    var canvas = glMap.getCanvas && glMap.getCanvas();
    var viewportHeight = Number(canvas && canvas.clientHeight);
    var fieldOfViewDegrees = typeof glMap.getVerticalFieldOfView === "function"
      ? Number(glMap.getVerticalFieldOfView())
      : 36.87;
    var zoom = Number(glMap.getZoom());
    var pitchRadians = Number(glMap.getPitch()) * Math.PI / 180;
    var center = glMap.getCenter();
    var latitudeRadians = Number(center.lat) * Math.PI / 180;
    if (
      !(viewportHeight > 0) ||
      !(fieldOfViewDegrees > 0 && fieldOfViewDegrees < 180) ||
      !Number.isFinite(zoom) ||
      !Number.isFinite(pitchRadians) ||
      !Number.isFinite(latitudeRadians)
    ) return null;
    var fieldOfViewRadians = fieldOfViewDegrees * Math.PI / 180;
    var cameraToCenterPixels = (viewportHeight / 2) / Math.tan(fieldOfViewRadians / 2);
    var metersPerPixel = WEB_MERCATOR_EARTH_CIRCUMFERENCE_METERS * Math.cos(latitudeRadians) /
      (MAPLIBRE_TILE_SIZE * Math.pow(2, zoom));
    return Math.max(0, cameraToCenterPixels * metersPerPixel * Math.cos(pitchRadians));
  }

  function syncFloodPresentationMode() {
    if (!glMap || !glStyleReady) return;
    var pitched = glMap.getPitch() > 10;
    var detailedDepth = usesDetailedFloodDepth();
    syncBuildingVisibilityForCamera();
    if (glMap.getLayer("nw-flood-drape")) {
      glMap.setLayoutProperty("nw-flood-drape", "visibility", visibility(!pitched));
    }
    if (floodPlaneLayer && typeof floodPlaneLayer.setVisible === "function") {
      floodPlaneLayer.setVisible(pitched);
      floodPlaneLayer.setDepthTest(detailedDepth);
    }
    placeFloodForScaleDepthPass();
    document.body.dataset.map3dFloodRenderer = pitched ? "depth-locked-water-plane" : "stable-image-layer";
    document.body.dataset.map3dFloodScalePass = detailedDepth ? "street-depth" : "overview-stable";
    document.body.dataset.map3dFloodCompositing = detailedDepth
      ? "shared-3d-depth-buffer"
      : "overview-prebuilding-no-terrain-depth";
  }

  function buildingsShouldRenderForCamera() {
    return Boolean(
      glMap &&
      layerVisible("buildingsToggle", false) &&
      glMap.getPitch() > 10
    );
  }

  function syncBuildingVisibilityForCamera() {
    if (!glMap || !glMap.getLayer("nw-3d-buildings")) return false;
    var shouldRender = buildingsShouldRenderForCamera();
    var buildingsEnabled = layerVisible("buildingsToggle", false);
    var showFootprints = buildingsEnabled && !shouldRender && glMap.getLayer("nw-2d-buildings");
    function setVisibility(layerId, visible) {
      if (!glMap.getLayer(layerId)) return;
      var targetVisibility = visibility(visible);
      if (glMap.getLayoutProperty(layerId, "visibility") !== targetVisibility) {
        glMap.setLayoutProperty(layerId, "visibility", targetVisibility);
      }
    }
    setVisibility("nw-3d-buildings", shouldRender);
    setVisibility("nw-2d-buildings", showFootprints);
    document.body.dataset.map3dBuildingVisibility = shouldRender
      ? "pitched-3d"
      : showFootprints ? "flat-2d" : "disabled";
    return shouldRender;
  }

  function placeFloodForScaleDepthPass() {
    if (!glMap || !glMap.getLayer("nw-flood-overlay")) return;
    // Only the verified municipal GeoJSON is ever extruded. Basemap buildings
    // outside Highlands remain flat map context when Buildings is on.
    var buildingLayerIds = ["nw-3d-buildings"];
    var styleLayers = glMap.getStyle().layers || [];
    var firstBuildingIndex = -1;
    var lastBuildingIndex = -1;
    styleLayers.forEach(function (layer, index) {
      if (buildingLayerIds.indexOf(layer.id) < 0) return;
      if (firstBuildingIndex < 0) firstBuildingIndex = index;
      lastBuildingIndex = Math.max(lastBuildingIndex, index);
    });
    if (lastBuildingIndex < 0) {
      document.body.dataset.map3dFloodBuildingOcclusion = "not-required";
      return;
    }
    if (!usesDetailedFloodDepth()) {
      var firstBuildingLayer = styleLayers[firstBuildingIndex];
      var floodIndex = styleLayers.findIndex(function (layer) { return layer.id === "nw-flood-overlay"; });
      if (firstBuildingLayer && floodIndex !== firstBuildingIndex - 1) {
        glMap.moveLayer("nw-flood-overlay", firstBuildingLayer.id);
      }
      document.body.dataset.map3dFloodBuildingOcclusion = "overview-buildings-after-water";
      return;
    }
    var nextLayer = styleLayers[lastBuildingIndex + 1];
    if (!nextLayer) {
      glMap.moveLayer("nw-flood-overlay");
    } else if (nextLayer.id !== "nw-flood-overlay") {
      glMap.moveLayer("nw-flood-overlay", nextLayer.id);
    }
    document.body.dataset.map3dFloodBuildingOcclusion = "single-extrusion-water-composite";
  }

  function syncBuildingWaterComposite3d(stageNavd88) {
    if (!glMap || !glStyleReady) return;
    if (!glMap.getLayer("nw-3d-buildings")) return;
    var stage = stageNavd88 === null || typeof stageNavd88 === "undefined" ? NaN : Number(stageNavd88);
    var selectedStage = Number.isFinite(stage) ? stage : null;
    // Keep one continuous opaque mesh per footprint. The former wet/dry pair
    // shared a coplanar boundary and made MapLibre dither cyan/gray fragments
    // across walls. The later water plane now supplies the submerged tint.
    glMap.setPaintProperty("nw-3d-buildings", "fill-extrusion-base", 0);
    document.body.dataset.map3dBuildingWaterline = "single-extrusion-depth-composite";
    document.body.dataset.map3dBuildingWaterStageNavd88Ft = selectedStage === null ? "none" : selectedStage.toFixed(3);
  }

  function syncFloodLayer3d() {
    if (!glMap || !glStyleReady) return;
    var request = pendingFlood3dRequest && pendingFlood3dRequest.isCurrent() ? pendingFlood3dRequest : null;
    var selectedLayer = request ? request.layer : currentFloodLayer;
    var url = selectedLayer && (selectedLayer._url || selectedLayer._image && selectedLayer._image.src);
    var coordinates = selectedLayer?._worldFileAffine && selectedLayer._worldFileCorners
      ? selectedLayer._worldFileCorners.map(function (corner) { return [corner.lng, corner.lat]; })
      : coordinatesFromLeafletBounds(selectedLayer?.getBounds?.()) || activeFloodCoordinates();
    if (!url || !coordinates) {
      syncBuildingWaterComposite3d(null);
      if (floodRemovalTimer) window.clearTimeout(floodRemovalTimer);
      // Selection metadata has already changed; a previous texture is stale.
      removeLayerAndSource("nw-flood-drape", "nw-flood-drape-source");
      removeLayerAndSource("nw-flood-overlay", "nw-flood-source");
      floodPlaneLayer = null;
      document.body.dataset.map3dFloodTexture = "empty";
      return;
    }
    if (floodRemovalTimer) {
      window.clearTimeout(floodRemovalTimer);
      floodRemovalTimer = null;
    }
    var stageNavd88 = request ? request.frame.stage : getSelectedStageNavd88();
    var pitched = glMap.getPitch() > 10;
    var physicalAltitudeMeters = Number.isFinite(stageNavd88)
      ? stageNavd88 * 0.3048 * TERRAIN_EXAGGERATION
      : 0;
    var options = {
      url: url,
      coordinates: coordinates,
      opacity: overlayOpacity,
      visible: pitched,
      useDepthTest: usesDetailedFloodDepth(),
      isCurrent: request ? request.isCurrent : null,
      altitudeMeters: physicalAltitudeMeters
    };
    // Top-down mode uses MapLibre's native image source, which remains in one
    // stable style layer while the camera pans or rotates. The preloaded flat
    // depth plane is reserved for pitched 3D, where water must meet terrain
    // and building walls instead of stretching over the DEM.
    updateImageLayer({
      sourceId: "nw-flood-drape-source",
      layerId: "nw-flood-drape",
      url: url,
      coordinates: coordinates,
      opacity: overlayOpacity,
      beforeId: glMap.getLayer("nw-2d-buildings") ? "nw-2d-buildings" : undefined,
      visible: !pitched
    });
    if (glMap.getSource("nw-flood-source")) removeLayerAndSource("nw-flood-overlay", "nw-flood-source");
    if (!glMap.getLayer("nw-flood-overlay")) {
      floodPlaneLayer = createFlatFloodPlane(options);
      addLayerBelowMask(floodPlaneLayer);
    } else if (floodPlaneLayer && typeof floodPlaneLayer.update === "function") {
      floodPlaneLayer.update(options);
    }
    placeFloodForScaleDepthPass();
    syncBuildingWaterComposite3d(stageNavd88);
    syncFloodPresentationMode();
    document.body.dataset.map3dFloodSurface = "flat-water-overlay";
    document.body.dataset.map3dFloodDepthMode = "independent";
    document.body.dataset.map3dFloodGeometry = currentFloodLayer && currentFloodLayer._worldFileAffine
      ? "world-file-quadrilateral"
      : "axis-aligned";
    document.body.dataset.map3dFloodAltitudeMeters = options.altitudeMeters.toFixed(3);
    document.body.dataset.map3dFloodPhysicalAltitudeMeters = physicalAltitudeMeters.toFixed(3);
  }

  async function prepareFloodFrame3d(layer, frame, token) {
    if (!glMap || !document.body.classList.contains("map-3d-ready")) return true;
    if (!glStyleReady || document.body.dataset.map3d !== "ready") return false;
    var requestedMap = glMap;
    var request = { layer: layer, frame: frame, token: token, isCurrent: function () {
      return pendingFlood3dRequest === request && glMap === requestedMap && glStyleReady &&
        token === lastRenderToken && pendingFloodLayer === layer && map?.hasLayer(layer);
    } };
    pendingFlood3dRequest = request;
    var accepted = false;
    try {
      syncFloodLayer3d();
      var url = layer._url || layer.getElement?.()?.src;
      var plane = floodPlaneLayer;
      var source = requestedMap.getSource("nw-flood-drape-source");
      // Both presentations already preload this URL. Certify both before the
      // metadata commits, including a 2D/3D change made while either is pending.
      var ready = await Promise.all([
        plane ? plane.whenReady() : false,
        waitForNativeFloodImage3d(requestedMap, source, request.isCurrent)
      ]);
      accepted = Boolean(ready.every(Boolean) && request.isCurrent() && plane === floodPlaneLayer &&
        plane.textureReady && plane.committedUrl === url);
      return accepted;
    } finally {
      if (pendingFlood3dRequest === request) {
        pendingFlood3dRequest = null;
        // Failed/obsolete candidates must not change the committed frame's
        // water height, texture or native image source.
        if (!accepted) syncFloodLayer3d();
      }
    }
  }

  function waitForNativeFloodImage3d(mapInstance, source, isCurrent) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = window.setTimeout(function () { finish(false); }, 20000);
      var poll = window.setInterval(check, 100);
      function finish(ready) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(poll);
        mapInstance.off("error", failed);
        mapInstance.off("sourcedata", check);
        if (!ready && source) imageLayerVersions.delete(source);
        resolve(ready);
      }
      function failed(event) {
        if (event && event.sourceId === "nw-flood-drape-source") finish(false);
      }
      function check() {
        if (!isCurrent() || !source || mapInstance.getSource("nw-flood-drape-source") !== source) { finish(false); return; }
        if (source.loaded() && source.image) finish(true);
      }
      mapInstance.on("error", failed);
      mapInstance.on("sourcedata", check);
      check();
    });
  }

  function discardObsoleteFloodFrame3d() {
    if (!pendingFlood3dRequest || pendingFlood3dRequest.isCurrent()) return;
    pendingFlood3dRequest = null;
    if (floodPlaneLayer?.cancelTextureLoad) floodPlaneLayer.cancelTextureLoad();
    syncFloodLayer3d();
  }

  function syncSatellite3d() {
    if (!glMap || !glStyleReady || !glMap.getLayer("nw-satellite")) return;
    glMap.setLayoutProperty("nw-satellite", "visibility", visibility(layerVisible("satelliteToggle", false)));
  }

  function syncRoadLabels3d() {
    if (!glMap || !glStyleReady) return;
    const roadVisibility = visibility(layerVisible("roadsToggle", true));
    for (const layer of glMap.getStyle().layers || []) {
      if (layer.type === "symbol" && /^road(?:\s|\/)/i.test(layer["source-layer"] || "")) {
        glMap.setLayoutProperty(layer.id, "visibility", roadVisibility);
        glMap.moveLayer(layer.id);
      }
    }
  }

  function retryFailedEsriRoadSource() {
    if (!glMap || !glStyleReady || !layerVisible("roadsToggle", true)) return;
    var source = glMap.getSource("esri");
    if (!source || !failedEsriVectorSources.has(source) ||
        typeof source.setTiles !== "function" || !source.tiles?.length) return;
    failedEsriVectorSources.delete(source);
    source.setTiles(source.tiles.slice());
  }

  function boundaryGeoJson() {
    if (municipalBoundaryFeature) return municipalBoundaryFeature;
    var rings = Array.isArray(municipalBoundaryRings) ? municipalBoundaryRings : [];
    if (!rings.length) return null;
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: rings.map(function (ring) {
          return ring.map(function (point) { return [Number(point[1]), Number(point[0])]; });
        })
      }
    };
  }

  function boundaryMaskGeoJson(feature) {
    var geometry = feature && feature.geometry;
    var polygons = geometry && geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry && geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    var holes = [];
    polygons.forEach(function (polygon) {
      if (Array.isArray(polygon && polygon[0])) holes.push(polygon[0].slice().reverse());
    });
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]].concat(holes)
      }
    };
  }

  function syncBoundary3d() {
    if (!glMap || !glStyleReady) return;
    var feature = boundaryGeoJson();
    if (!feature) return;
    var outlineSource = glMap.getSource("nw-boundary-source");
    var maskSource = glMap.getSource("nw-boundary-mask-source");
    if (outlineSource && typeof outlineSource.setData === "function") outlineSource.setData(feature);
    if (maskSource && typeof maskSource.setData === "function") maskSource.setData(boundaryMaskGeoJson(feature));
    if (glMap.getLayer("nw-boundary-outline")) {
      glMap.setLayoutProperty("nw-boundary-outline", "visibility", visibility(isTownBoundaryEnabled()));
    }
  }

  function syncParcels3d(reload) {
    if (!glMap || !glStyleReady) return;
    var enabled = layerVisible("parcelsToggle", false);
    if (enabled && parcelFeatures.length && !glMap.getSource("nw-parcel-vector-source")) {
      glMap.addSource("nw-parcel-vector-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: parcelFeatures }
      });
      addLayerBelowMask({
        id: "nw-parcel-vector",
        type: "line",
        source: "nw-parcel-vector-source",
        paint: {
          "line-color": "#ef4444",
          "line-opacity": 0.72,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.65, 17, 1.15, 22, 1.65]
        }
      });
    }
    if (glMap.getLayer("nw-parcel-vector")) {
      glMap.setLayoutProperty("nw-parcel-vector", "visibility", visibility(enabled));
      if (glMap.getLayer("nw-parcel-overlay")) glMap.setLayoutProperty("nw-parcel-overlay", "visibility", "none");
      return;
    }
    var coordinates = configuredWorldFileCoordinates();
    if (!enabled || !coordinates || !PARCEL_BOUNDARY_PNG_URL) {
      if (glMap.getLayer("nw-parcel-overlay")) glMap.setLayoutProperty("nw-parcel-overlay", "visibility", "none");
      return;
    }
    updateImageLayer({
      sourceId: "nw-parcel-source",
      layerId: "nw-parcel-overlay",
      url: PARCEL_BOUNDARY_PNG_URL,
      coordinates: coordinates,
      opacity: 0.78,
      reload: enabled && reload === true,
      visible: enabled
    });
  }

  function nsiImpactPaint(stage) {
    if (!Number.isFinite(stage)) {
      return {
        color: "#64748b",
        stroke: "#94a3b8",
        radius: 2.7,
        opacity: 0.42
      };
    }
    var floor = ["+",
      ["to-number", ["get", "localGroundNavd88Ft"], -9999],
      ["max", 0, ["to-number", ["get", "foundationHeightFt"], 0]]
    ];
    var difference = ["-", stage, floor];
    return {
      color: ["case", [">", difference, 0.1], "#fb7185", [">=", difference, -0.5], "#fbbf24", "#22d3ee"],
      stroke: ["case", [">", difference, 0.1], "#fff1f2", [">=", difference, -0.5], "#fff7d6", "#d9fdff"],
      radius: ["case", [">", difference, 0.1], 4.3, [">=", difference, -0.5], 3.6, 2.7],
      opacity: ["case", [">", difference, 0.1], 0.95, [">=", difference, -0.5], 0.88, 0.48]
    };
  }

  function syncNsi3d() {
    if (!glMap || !glStyleReady) return;
    var enabled = layerVisible("nsiStructuresToggle", false);
    if (!nsiStructureFeatures.length) {
      if (glMap.getLayer("nw-nsi-points")) glMap.setLayoutProperty("nw-nsi-points", "visibility", "none");
      return;
    }
    var source = glMap.getSource("nw-nsi-source");
    var data = { type: "FeatureCollection", features: nsiStructureFeatures };
    if (source && typeof source.setData === "function") source.setData(data);
    if (!source) {
      glMap.addSource("nw-nsi-source", { type: "geojson", data: data });
      addLayerBelowMask({
        id: "nw-nsi-points",
        type: "circle",
        source: "nw-nsi-source",
        paint: {}
      });
    }
    var paint = nsiImpactPaint(getSelectedStageNavd88());
    glMap.setPaintProperty("nw-nsi-points", "circle-color", paint.color);
    glMap.setPaintProperty("nw-nsi-points", "circle-stroke-color", paint.stroke);
    glMap.setPaintProperty("nw-nsi-points", "circle-radius", paint.radius);
    glMap.setPaintProperty("nw-nsi-points", "circle-opacity", paint.opacity);
    glMap.setPaintProperty("nw-nsi-points", "circle-stroke-width", 0.9);
    glMap.setLayoutProperty("nw-nsi-points", "visibility", visibility(enabled));
    updateDiagnostics();
  }

  function buildingFeatureCenter(feature) {
    var geometry = feature && feature.geometry;
    var coordinates = geometry && geometry.coordinates;
    if (!Array.isArray(coordinates)) return null;
    var minimumLng = Infinity;
    var minimumLat = Infinity;
    var maximumLng = -Infinity;
    var maximumLat = -Infinity;
    function visit(value) {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
        var lng = Number(value[0]);
        var lat = Number(value[1]);
        minimumLng = Math.min(minimumLng, lng);
        maximumLng = Math.max(maximumLng, lng);
        minimumLat = Math.min(minimumLat, lat);
        maximumLat = Math.max(maximumLat, lat);
        return;
      }
      value.forEach(visit);
    }
    visit(coordinates);
    return Number.isFinite(minimumLng) && Number.isFinite(minimumLat)
      ? [(minimumLng + maximumLng) / 2, (minimumLat + maximumLat) / 2]
      : null;
  }

  function buildingGeometryPolygons3d(geometry) {
    return geometry?.type === "Polygon" ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  }

  function buildingGeometrySegments3d(geometry) {
    return buildingGeometryPolygons3d(geometry).flatMap(function (polygon) {
      return polygon.flatMap(function (ring) {
        return ring.map(function (point, index) { return [point, ring[(index + 1) % ring.length]]; });
      });
    });
  }

  function buildingPointOnSegment3d(point, a, b) {
    var epsilon = 1e-10;
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var length = Math.hypot(dx, dy);
    return length > 0 && Math.abs(dx * (point[1] - a[1]) - dy * (point[0] - a[0])) <= epsilon * length &&
      point[0] >= Math.min(a[0], b[0]) - epsilon && point[0] <= Math.max(a[0], b[0]) + epsilon &&
      point[1] >= Math.min(a[1], b[1]) - epsilon && point[1] <= Math.max(a[1], b[1]) + epsilon;
  }

  function buildingGeometryContainsPoint3d(geometry, point, boundaryIncluded) {
    if (buildingGeometrySegments3d(geometry).some(function (segment) {
      return buildingPointOnSegment3d(point, segment[0], segment[1]);
    })) return Boolean(boundaryIncluded);
    return pointInsideMunicipalGeometry(point, geometry);
  }

  function buildingInteriorPoint3d(geometry) {
    var segments = buildingGeometrySegments3d(geometry);
    var selected = null, widest = 0;
    var heights = Array.from(new Set(segments.flatMap(function (segment) {
      return [segment[0][1], segment[1][1]];
    }))).sort(function (a, b) { return a - b; });
    // A bounding-box center can lie outside a concave footprint or in its
    // courtyard. Scan between vertices and choose an actual interior point.
    for (var index = 1; index < heights.length; index += 1) {
      var y = (heights[index - 1] + heights[index]) / 2;
      var xs = segments.filter(function (segment) {
        return (segment[0][1] > y) !== (segment[1][1] > y);
      }).map(function (segment) {
        var a = segment[0], b = segment[1];
        return a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      }).sort(function (a, b) { return a - b; });
      for (var cursor = 1; cursor < xs.length; cursor += 1) {
        var point = [(xs[cursor - 1] + xs[cursor]) / 2, y];
        var width = xs[cursor] - xs[cursor - 1];
        if (width > widest && buildingGeometryContainsPoint3d(geometry, point, false)) {
          selected = point;
          widest = width;
        }
      }
    }
    return selected;
  }

  function buildingSegmentParts3d(segment, boundaries) {
    var a = segment[0], b = segment[1], dx = b[0] - a[0], dy = b[1] - a[1];
    var values = [0, 1];
    boundaries.forEach(function (edge) {
      var c = edge[0], d = edge[1], ex = d[0] - c[0], ey = d[1] - c[1];
      var denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1e-20) {
        var lengthSquared = dx * dx + dy * dy;
        if (lengthSquared && Math.abs(dx * (c[1] - a[1]) - dy * (c[0] - a[0])) < 1e-20) {
          [c, d].forEach(function (point) {
            var position = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
            if (position > 0 && position < 1) values.push(position);
          });
        }
        return;
      }
      var t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denominator;
      var u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) values.push(t);
    });
    values.sort(function (one, two) { return one - two; });
    return values.concat(values.slice(1).map(function (value, index) {
      return (value + values[index]) / 2;
    })).map(function (value) { return [a[0] + dx * value, a[1] + dy * value]; });
  }

  function buildingFootprintFitsParcel3d(footprint, parcel) {
    var footprintSegments = buildingGeometrySegments3d(footprint);
    var parcelSegments = buildingGeometrySegments3d(parcel);
    if (!footprintSegments.length || !parcelSegments.length) return false;
    var bounds = function (segments) {
      var points = segments.map(function (segment) { return segment[0]; });
      return [Math.min(...points.map(function (point) { return point[0]; })),
        Math.min(...points.map(function (point) { return point[1]; })),
        Math.max(...points.map(function (point) { return point[0]; })),
        Math.max(...points.map(function (point) { return point[1]; }))];
    };
    var inner = bounds(footprintSegments), outer = bounds(parcelSegments), epsilon = 1e-10;
    if (inner[0] < outer[0] - epsilon || inner[1] < outer[1] - epsilon ||
        inner[2] > outer[2] + epsilon || inner[3] > outer[3] + epsilon) return false;
    var outerEdges = buildingGeometryPolygons3d(footprint).flatMap(function (polygon) {
      return polygon[0].map(function (point, index, ring) { return [point, ring[(index + 1) % ring.length]]; });
    });
    if (!outerEdges.every(function (segment) {
      return buildingSegmentParts3d(segment, parcelSegments).every(function (point) {
        return buildingGeometryContainsPoint3d(parcel, point, true);
      });
    })) return false;
    // A parcel hole wholly inside a building has no outer-edge intersection.
    // Reject it unless the same area is also a hole in the building footprint.
    return buildingGeometryPolygons3d(parcel).every(function (polygon) {
      return polygon.slice(1).every(function (ring) {
        return ring.every(function (point, index) {
          return buildingSegmentParts3d([point, ring[(index + 1) % ring.length]], footprintSegments)
            .every(function (sample) { return !buildingGeometryContainsPoint3d(footprint, sample, false); });
        });
      });
    });
  }

  async function resolveClickedBuildingParcel3d(renderedFeature) {
    var footprintId = String(renderedFeature?.properties?.footprintId || "");
    var fullFeatures = (buildingData?.features || []).filter(function (feature) {
      return footprintId && String(feature.properties?.footprintId || "") === footprintId;
    });
    // Rendered vector-tile geometry can be clipped at a tile edge. Its full
    // municipal source feature is the only geometry used for property lookup.
    if (fullFeatures.length !== 1) return { feature: renderedFeature, point: null, parcel: null };
    var feature = fullFeatures[0], point = buildingInteriorPoint3d(feature.geometry);
    var result = { feature: feature, point: point, parcel: null };
    if (!point) return result;
    await ensureParcelAssets();
    var identified = parcelFeatures.filter(function (parcel) {
      return String(parcel.properties?.nsi2026FootprintId || "") === footprintId;
    });
    // The explicit NSI footprint association survives small differences
    // between footprint and parcel surveys. Confirm an actual interior point
    // belongs to that parcel before accepting its unique identity.
    if (identified.length === 1 && buildingGeometryContainsPoint3d(identified[0].geometry, point, true)) {
      result.parcel = identified[0];
      return result;
    }
    var candidates = (identified.length ? identified : parcelFeatures).filter(function (parcel) {
      return buildingFootprintFitsParcel3d(feature.geometry, parcel.geometry);
    });
    // Shared parcels can contain several buildings; duplicated/overlapping
    // property records require a unique footprint identity or a safe fallback.
    if (candidates.length === 1) result.parcel = candidates[0];
    return result;
  }

  function finiteBuildingNumber(value) {
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && value.trim() === "")) return NaN;
    var number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function prepareVisualBuildingGround(sourceFeatures) {
    var cellSize = 0.001;
    var known = [];
    var centers = sourceFeatures.map(buildingFeatureCenter);
    sourceFeatures.forEach(function (feature, index) {
      var properties = feature && feature.properties ? feature.properties : {};
      var localGround = finiteBuildingNumber(properties.localGroundNavd88Ft);
      if (!Number.isFinite(localGround)) {
        var firstFloor = finiteBuildingNumber(properties.modeledFirstFloorNavd88Ft);
        var foundation = finiteBuildingNumber(properties.foundationHeightFt);
        if (Number.isFinite(firstFloor) && Number.isFinite(foundation)) {
          localGround = firstFloor - Math.max(0, foundation);
        }
      }
      if (Number.isFinite(localGround) && centers[index]) {
        known.push({ index: index, center: centers[index], ground: localGround });
      }
    });
    var sortedGround = known.map(function (entry) { return entry.ground; }).sort(function (a, b) { return a - b; });
    var medianGround = sortedGround.length
      ? sortedGround[Math.floor(sortedGround.length / 2)]
      : 5;
    var grid = Object.create(null);
    known.forEach(function (entry) {
      var key = Math.floor(entry.center[0] / cellSize) + ":" + Math.floor(entry.center[1] / cellSize);
      if (!grid[key]) grid[key] = [];
      grid[key].push(entry);
    });
    var derivedCount = 0;
    var medianCount = 0;
    var result = sourceFeatures.map(function (feature, index) {
      var properties = feature && feature.properties ? feature.properties : {};
      var ground = finiteBuildingNumber(properties.localGroundNavd88Ft);
      if (!Number.isFinite(ground)) {
        var storedFloor = finiteBuildingNumber(properties.modeledFirstFloorNavd88Ft);
        var storedFoundation = finiteBuildingNumber(properties.foundationHeightFt);
        if (Number.isFinite(storedFloor) && Number.isFinite(storedFoundation)) {
          ground = storedFloor - Math.max(0, storedFoundation);
        }
      }
      if (Number.isFinite(ground)) {
        return { value: ground, source: "2019 bare-earth LiDAR building reference" };
      }
      var center = centers[index];
      var nearest = null;
      if (center) {
        var cellX = Math.floor(center[0] / cellSize);
        var cellY = Math.floor(center[1] / cellSize);
        for (var radius = 0; radius <= 12 && !nearest; radius += 1) {
          var candidates = [];
          for (var x = cellX - radius; x <= cellX + radius; x += 1) {
            for (var y = cellY - radius; y <= cellY + radius; y += 1) {
              if (radius > 0 && x > cellX - radius && x < cellX + radius && y > cellY - radius && y < cellY + radius) continue;
              var entries = grid[x + ":" + y];
              if (entries) candidates = candidates.concat(entries);
            }
          }
          candidates.forEach(function (candidate) {
            var dx = candidate.center[0] - center[0];
            var dy = candidate.center[1] - center[1];
            var distance = dx * dx + dy * dy;
            if (!nearest || distance < nearest.distance) nearest = { distance: distance, ground: candidate.ground };
          });
        }
      }
      if (nearest) {
        derivedCount += 1;
        return { value: nearest.ground, source: "nearest 2019 bare-earth LiDAR building reference" };
      }
      medianCount += 1;
      return { value: medianGround, source: "municipal 2019 bare-earth LiDAR building median" };
    });
    return {
      values: result,
      measuredCount: known.length,
      derivedCount: derivedCount,
      medianCount: medianCount
    };
  }

  function pointInsideRing(point, ring) {
    var x = Number(point && point[0]);
    var y = Number(point && point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Array.isArray(ring)) return false;
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      var xi = Number(ring[i] && ring[i][0]);
      var yi = Number(ring[i] && ring[i][1]);
      var xj = Number(ring[j] && ring[j][0]);
      var yj = Number(ring[j] && ring[j][1]);
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi) / (yj - yi)) + xi) inside = !inside;
    }
    return inside;
  }

  function pointInsideMunicipalGeometry(point, geometry) {
    if (!geometry) return false;
    var polygons = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    return polygons.some(function (polygon) {
      if (!Array.isArray(polygon) || !polygon.length || !pointInsideRing(point, polygon[0])) return false;
      return !polygon.slice(1).some(function (hole) { return pointInsideRing(point, hole); });
    });
  }

  function buildingInsideMunicipality(feature, boundaryFeature) {
    var geometry = feature && feature.geometry;
    var boundaryGeometry = boundaryFeature && boundaryFeature.geometry;
    var coordinates = geometry && geometry.type === "Polygon"
      ? geometry.coordinates.reduce(function (points, ring) { return points.concat(ring); }, [])
      : geometry && geometry.type === "MultiPolygon"
        ? geometry.coordinates.reduce(function (points, polygon) {
            return points.concat(polygon.reduce(function (polygonPoints, ring) {
              return polygonPoints.concat(ring);
            }, []));
          }, [])
        : [];
    return coordinates.length > 0 && coordinates.every(function (point) {
      return pointInsideMunicipalGeometry(point, boundaryGeometry);
    });
  }

  async function loadBuildingData() {
    if (buildingData) return buildingData;
    if (!buildingDataPromise) {
      // This script loads before applyTownConfig. Resolve the asset paths when
      // loading starts, after the town settings are available, instead of
      // permanently capturing empty URLs during script initialization.
      var BUILDINGS_3D_URL = TOWN_CONFIG?.structures?.buildings3dPath ? new URL(TOWN_CONFIG.structures.buildings3dPath, APP_BASE).href : "";
      var MUNICIPAL_BOUNDARY_3D_URL = TOWN_CONFIG?.boundary?.boundaryUrl ? new URL(TOWN_CONFIG.boundary.boundaryUrl, APP_BASE).href : "";
      var loads = [
        BUILDINGS_3D_URL ? fetch3dJson(BUILDINGS_3D_URL, "The configured 3D building asset could not be loaded.")
          : Promise.resolve({ type: "FeatureCollection", features: [] }),
        MUNICIPAL_BOUNDARY_3D_URL ? fetch3dJson(MUNICIPAL_BOUNDARY_3D_URL, "The municipal boundary could not be loaded for 3D clipping.")
          : Promise.resolve({ type: "FeatureCollection", features: [] })
      ];
      var request = Promise.all(loads)
        .then(function (resources) {
          var payload = resources[0];
          var boundaryFeature = resources[1];
          if (payload && payload.metadata && !String(payload.metadata.schema || "").includes("3d-buildings")) {
            console.warn("The configured 3D building asset uses an unrecognized schema.");
          }
          var sourceFeatures = Array.isArray(payload && payload.features) ? payload.features : [];
          var municipalFeatures = sourceFeatures.filter(function (feature) {
            return buildingInsideMunicipality(feature, boundaryFeature);
          });
          var excludedOutsideMunicipality = sourceFeatures.length - municipalFeatures.length;
          var visualGround = prepareVisualBuildingGround(municipalFeatures);
          var excludedFallbacks = 0;
          var sanitizedFeatures = municipalFeatures.reduce(function (features, feature, sourceIndex) {
            var properties = feature && feature.properties ? feature.properties : {};
            if (String(properties.geometrySource || "") === "NSI modeled square") {
              excludedFallbacks += 1;
              return features;
            }
            var taggedHeight = String(properties.heightSource || "").indexOf("OpenStreetMap height") === 0
              ? Number(properties.calculatedHeightM)
              : NaN;
            var rawStories = Number(properties.stories);
            var stories = Number.isFinite(rawStories)
              ? Math.max(1, Math.min(6, Math.round(rawStories)))
              : 1;
            var modeledHeight = stories * 3.05 + 1.2;
            var renderHeightM = Number.isFinite(taggedHeight)
              ? Math.max(3.2, Math.min(30, taggedHeight))
              : Math.max(3.2, Math.min(19.5, modeledHeight));
            features.push(Object.assign({}, feature, {
              properties: Object.assign({}, properties, {
                renderStories: stories,
                renderHeightM: Number(renderHeightM.toFixed(2)),
                renderHeightFt: Number((renderHeightM * 3.280839895).toFixed(1)),
                renderHeightSource: Number.isFinite(taggedHeight)
                  ? "OpenStreetMap tagged height"
                  : String(properties.geometryMatch || "") === "point-in-footprint"
                    ? "NSI story count, screened for local outliers"
                    : "Screened one-story vector-footprint default",
                visualGroundNavd88Ft: Number(visualGround.values[sourceIndex].value.toFixed(2)),
                visualGroundSource: visualGround.values[sourceIndex].source,
                groundReferenceSource: properties.groundReferenceSource || "2019 bare-earth LiDAR terrain surface"
              })
            }));
            return features;
          }, []);
          buildingData = {
            type: "FeatureCollection",
            metadata: Object.assign({}, payload && payload.metadata, {
              renderedFeatureCount: sanitizedFeatures.length,
              excludedOutsideMunicipality: excludedOutsideMunicipality,
              excludedModeledSquares: excludedFallbacks,
              excludedLooseMatches: 0,
              visualGroundMeasuredCount: visualGround.measuredCount,
              visualGroundNearestDerivedCount: visualGround.derivedCount,
              visualGroundMedianFallbackCount: visualGround.medianCount,
              renderHeightModel: "OSM tagged height when available; otherwise 3.05 m per screened story plus 1.2 m roof. Crawlspace rise is not added to roof height. Stored heights remain real; the 3D renderer applies the same 4x vertical exaggeration as terrain and floodwater."
            }),
            features: sanitizedFeatures
          };
          document.body.dataset.buildings3dCount = String(sanitizedFeatures.length);
          document.body.dataset.buildings3dExcludedOutsideMunicipality = String(excludedOutsideMunicipality);
          document.body.dataset.buildings3dExcludedFallbacks = String(excludedFallbacks);
          document.body.dataset.buildings3dExcludedLooseMatches = "0";
          document.body.dataset.buildings3dGroundMeasured = String(visualGround.measuredCount);
          document.body.dataset.buildings3dGroundNearestDerived = String(visualGround.derivedCount);
          document.body.dataset.buildings3dGroundMedianFallback = String(visualGround.medianCount);
          document.body.dataset.buildings3dVerticalScale = String(TERRAIN_EXAGGERATION);
          document.body.dataset.buildings3dMaxHeightFt = String(sanitizedFeatures.reduce(function (maximum, feature) {
            return Math.max(maximum, Number(feature.properties && feature.properties.renderHeightFt) || 0);
          }, 0).toFixed(1));
          return buildingData;
        })
        .catch(function (error) {
          loads.forEach(function (load) { if (load.cancel) load.cancel(); });
          if (buildingDataPromise === request) buildingDataPromise = null;
          throw error;
        });
      request.cancel = function () { loads.forEach(function (load) { if (load.cancel) load.cancel(); }); };
      buildingDataPromise = request;
    }
    return buildingDataPromise;
  }

  async function syncBuildings3d(options) {
    if (!glMap || !glStyleReady) return;
    var requestedMap = glMap;
    if (!TOWN_CONFIG?.structures?.buildings3dPath) {
      await window.COUNTY_3D_BUILDINGS.sync(requestedMap, TERRAIN_EXAGGERATION);
      if (glMap !== requestedMap || !glStyleReady) return;
      syncBuildingVisibilityForCamera();
      placeFloodForScaleDepthPass();
      setStatus("3D buildings • schematic heights");
      return;
    }
    var syncOptions = options || {};
    var enabled = layerVisible("buildingsToggle", false);
    if (!enabled && !syncOptions.preload && !glMap.getSource("nw-buildings-source")) {
      setStatus("3D terrain ×4");
      return;
    }
    if (!glMap.getSource("nw-buildings-source")) {
      var payload = await loadBuildingData();
      if (glMap !== requestedMap || !glStyleReady) return;
      if (glMap.getSource("nw-buildings-source")) {
        syncBuildingVisibilityForCamera();
        return;
      }
      glMap.addSource("nw-buildings-source", {
        type: "geojson",
        data: payload,
        generateId: true,
        // Tile to street scale before overscaling. The old zoom-16 buckets
        // could cull whole runs of extrusions at an oblique tile boundary.
        // Zoom 18 keeps the complete municipal footprint source present without
        // asking the worker to rebuild geometry at the final 100 m zooms.
        maxzoom: 18,
        buffer: 256,
        tolerance: 0
      });
      document.body.dataset.buildings3dSourceMaxZoom = "18";
      document.body.dataset.buildings3dSourceBuffer = "256";
      addLayerBelowMask({
        id: "nw-3d-buildings",
        type: "fill-extrusion",
        source: "nw-buildings-source",
        // Keep complete municipal geometry available throughout the supported
        // camera range; a change of eye altitude must not flatten the town.
        minzoom: 11,
        paint: {
          "fill-extrusion-color": "#ddd7cb",
          // renderHeightM remains the calculated real-world building height.
          // Terrain elevation and the flat NAVD88 flood surface are both
          // displayed at 4x. Apply that same visual scale to wall height so a
          // real 5 ft water depth covers 5 ft of a real building, rather than
          // consuming 20 ft of visible wall.
          "fill-extrusion-height": ["*", ["to-number", ["get", "renderHeightM"], 3], TERRAIN_EXAGGERATION],
          "fill-extrusion-base": 0,
          // One continuous opaque extrusion per footprint gives the water
          // plane a deterministic depth surface. Splitting the same footprint
          // into wet and dry solids creates coplanar seams on wall faces.
          "fill-extrusion-opacity": 1,
          "fill-extrusion-opacity-transition": { duration: 0, delay: 0 },
          // The global soft light already provides enough face separation.
          // Disabling MapLibre's height gradient prevents the lower rows of
          // dense side walls from merging into overview-scale dark bands.
          "fill-extrusion-vertical-gradient": false
        }
      });
      addLayerBelowMask({
        id: "nw-2d-buildings",
        type: "fill",
        source: "nw-buildings-source",
        minzoom: 11,
        layout: { visibility: "none" },
        paint: { "fill-color": "#ddd7cb", "fill-outline-color": "#958e80" }
      });
      syncBuildingWaterComposite3d(getSelectedStageNavd88());
      if (!buildingCursorHandlersWired) {
        buildingCursorHandlersWired = true;
        ["nw-2d-buildings", "nw-3d-buildings"].forEach(function (layerId) {
          glMap.on("mouseenter", layerId, function () {
            if (layerVisible("buildingsToggle", false)) glMap.getCanvas().style.cursor = "pointer";
          });
          glMap.on("mouseleave", layerId, function () {
            glMap.getCanvas().style.cursor = "";
          });
        });
      }
      // At street scale, draw water after opaque buildings for submerged-wall
      // depth. At overview scale, draw it first so roofs remain clean while
      // terrain-tile skirts cannot cut bands through the flood surface.
      placeFloodForScaleDepthPass();
    }
    if (!glMap.getLayer("nw-3d-buildings")) return;
    syncBuildingVisibilityForCamera();
    placeFloodForScaleDepthPass();
    syncBuildingWaterComposite3d(getSelectedStageNavd88());
    setStatus(enabled
      ? "3D terrain ×4 • " + Number(buildingData.features.length).toLocaleString("en-US") + " buildings"
      : "3D terrain ×4");
  }

  function buildBuildingPopupHtml(properties) {
    var p = properties || {};
    var address = escapeTownAddressHtml(p.address || p.osmName || `${TOWN_CONFIG.site.name} building`);
    var crawlspaceDepth = finiteBuildingNumber(p.foundationHeightFt);
    var firstFloor = finiteBuildingNumber(p.modeledFirstFloorNavd88Ft);
    var stage = finiteBuildingNumber(getSelectedStageNavd88());
    var difference = Number.isFinite(stage) && Number.isFinite(firstFloor) ? stage - firstFloor : NaN;
    var status = !Number.isFinite(firstFloor)
      ? ""
      : !Number.isFinite(difference)
        ? "Choose a water level to compare."
        : Math.abs(difference) <= 0.1
          ? "Current water is at the estimated occupied floor."
          : difference > 0
            ? "Current water is " + formatWaterDepth(difference, 1) + " above the estimated occupied floor."
            : "Current water is " + formatWaterDepth(Math.abs(difference), 1) + " below the estimated occupied floor.";
    return '<div class="nsi-structure-popup building-info-card">' +
      '<span class="house-alert-kicker">Building</span>' +
      '<h3>' + address + '</h3>' +
      '<div class="building-info-facts">' +
        '<div><span>Crawlspace / garage depth</span><strong>' + (Number.isFinite(crawlspaceDepth) ? formatWaterDepth(crawlspaceDepth, 1) : '—') + '</strong></div>' +
        (status ? '<p>' + escapeTownAddressHtml(status) + '</p>' : '') +
      '</div>' +
      '</div>';
  }

  function closeGlPopup() {
    if (!glPopup) return;
    ++mapQueryGeneration;
    var popup = glPopup;
    glPopup = null;
    try { popup.remove(); } catch (_) {}
  }

  var lastGlPopupHtml = "";
  var addressMarker = null;
  function setAddressMarker(latlng, label) {
    if (addressMarker) addressMarker.remove();
    addressMarker = null;
    if (!latlng || !glMap) return;
    var element = document.createElement("div");
    element.className = "nw-address-marker";
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", label || "Selected address");
    element.title = label || "Selected address";
    element.style.cssText = "width:22px;height:22px;border:3px solid white;border-radius:50%;background:#2563eb;box-shadow:0 0 0 3px #123459,0 3px 12px #0008;";
    addressMarker = new maplibregl.Marker({ element: element }).setLngLat([Number(latlng.lng), Number(latlng.lat)]).addTo(glMap);
  }

  function showGlPopup(popup, maxWidth = popup?.options.maxWidth, handoff = false) {
    if (!popup || !glMap || !document.body.classList.contains("map-3d-ready")) return;
    closeGlPopup();
    var latlng = popup.getLatLng();
    var html = popup.getContent();
    var mirror = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      focusAfterOpen: !handoff,
      className: handoff ? "nw-address-popup-handoff" : "",
      maxWidth: Math.max(240, Number(maxWidth) || 360) + "px",
      offset: 18
    })
      .setLngLat([Number(latlng.lng), Number(latlng.lat)])
      .setHTML(html)
      .addTo(glMap);
    glPopup = mirror;
    lastGlPopupHtml = String(html || "");
    mirror.getElement()?.addEventListener("focusin", function (event) {
      revealGlPopupControl(event.target);
    });
    syncGlPopupLayout();
    mirror.on("close", function () {
      if (glPopup !== mirror) return;
      ++mapQueryGeneration;
      glPopup = null;
      if (persistentFloodPopup === popup) popup.remove();
    });
    popup.once("remove", function () {
      if (glPopup === mirror) closeGlPopup();
    });
  }

  function openFallbackBuildingPopup(latlng, properties) {
    var popup = openPersistentFloodPopup(latlng, buildBuildingPopupHtml(properties), 380);
    fallbackBuildingPopup = popup;
    fallbackBuildingRenderToken = lastRenderToken;
    popup.once("remove", function () {
      if (fallbackBuildingPopup === popup) fallbackBuildingPopup = null;
    });
    return popup;
  }

  function closeOutdatedFallbackBuildingPopup() {
    if (!fallbackBuildingPopup ||
        (fallbackBuildingRenderToken === lastRenderToken && floodFrameState === "ready")) return;
    var popup = fallbackBuildingPopup;
    fallbackBuildingPopup = null;
    if (map && map.hasLayer(popup)) map.removeLayer(popup);
  }

  function revealGlPopupControl(control) {
    var content = control.closest(".nw-mobile-popup .maplibregl-popup-content");
    if (!content || content.scrollHeight <= content.clientHeight) return;
    var top = content.getBoundingClientRect().top + content.clientTop;
    var bottom = top + content.clientHeight;
    var bounds = control.getBoundingClientRect();
    if (bounds.top < top) content.scrollTop += bounds.top - top - 4;
    else if (bounds.bottom > bottom) content.scrollTop += bounds.bottom - bottom + 4;
  }

  function syncGlPopupLayout() {
    if (!glPopup || !glMap) return;
    var element = glPopup.getElement();
    if (!element) return;
    var focusedControl = element.contains(document.activeElement) ? document.activeElement : null;
    var moved = false;
    var close = element.querySelector(".maplibregl-popup-close-button");
    if (close) close.setAttribute("aria-label", "Close popup");
    var compact = isCompactFloodmapperLayout();
    if (!compact && element.querySelector(".building-info-card, .nsi-structure-popup, .depth-query-popup")) {
      var controls = document.getElementById("nwDefaultNavControl")?.getBoundingClientRect();
      var panel = document.getElementById("leftPanel")?.getBoundingClientRect();
      // Reuse the centered popup when the map between the panels is too narrow
      // for the standard 380px card. The compass would cover the close button.
      compact = Boolean(controls?.width && controls.left - (panel?.right || 0) < 380);
    }
    if (!compact && close && element.classList.contains("nw-address-popup-handoff")) {
      // The Leaflet camera may already be panned for its popup. After the
      // renderer or pitch changes, use the centered card if that position
      // puts the mirrored close control behind the compass.
      var bounds = close.getBoundingClientRect();
      var hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      if (hit?.closest("#nwDefaultNavControl")) element.dataset.addressPopupCentered = "true";
      compact = element.dataset.addressPopupCentered === "true";
    }
    element.classList.toggle("nw-mobile-popup", compact);
    // MapLibre appends its close button after the card. Sticky positioning
    // only keeps it visible when it starts before the scrollable contents.
    if (compact) {
      var content = element.querySelector(".maplibregl-popup-content");
      if (content && close && content.firstElementChild !== close) {
        content.prepend(close);
        moved = true;
      }
    }
    // Map controls live outside MapLibre's stacking context. A compact popup
    // needs its own scrollable surface above them, independent of map anchors.
    var parent = compact ? document.body : glMap.getContainer();
    if (element.parentElement !== parent) {
      parent.appendChild(element);
      moved = true;
    }
    if (moved && focusedControl) {
      if (document.activeElement === document.body && !focusedControl.closest("[inert]")) {
        focusedControl.focus({ preventScroll: true });
      } else if (document.activeElement === focusedControl) revealGlPopupControl(focusedControl);
    }
  }

  function syncLeafletViewTo3d() {
    if (!glMap || !map || syncingFrom3d || syncingModeTransition) return;
    var center = map.getCenter();
    var zoom = map.getZoom();
    if (!center || !Number.isFinite(zoom)) return;
    var current = glMap.getCenter();
    var changed = Math.abs(current.lng - center.lng) > 0.000001 ||
      Math.abs(current.lat - center.lat) > 0.000001 ||
      Math.abs(glMap.getZoom() - zoom) > 0.001;
    if (!changed) {
      document.body.dataset.map3dLeafletSync = "skipped-bearing-only";
      return;
    }
    document.body.dataset.map3dLeafletSync = "center-or-zoom";
    syncingFromLeaflet = true;
    glMap.jumpTo({ center: [center.lng, center.lat], zoom: Math.min(MAP_MAX_ZOOM, zoom) });
    syncingFromLeaflet = false;
  }

  function sync3dViewToLeaflet() {
    if (!glMap || !map || syncingFromLeaflet || syncingModeTransition) return;
    var center = glMap.getCenter();
    var leafletCenter = map.getCenter();
    var targetZoom = Math.min(MAP_MAX_ZOOM, glMap.getZoom());
    // Bearing and pitch have no Leaflet equivalent. Guard against any
    // redundant move-end signal so a compass-only camera change can never
    // force the hidden 2D PNG and Leaflet overlays to rebuild beneath WebGL.
    var changed = !leafletCenter ||
      Math.abs(Number(leafletCenter.lng) - Number(center.lng)) > 0.000001 ||
      Math.abs(Number(leafletCenter.lat) - Number(center.lat)) > 0.000001 ||
      Math.abs(Number(map.getZoom()) - targetZoom) > 0.001;
    if (!changed) return;
    syncingFrom3d = true;
    map.setView([center.lat, center.lng], targetZoom, { animate: false });
    syncingFrom3d = false;
    updateDiagnostics();
  }

  function addCore3dLayers() {
    glMap.addSource("nw-terrain", {
      type: "raster-dem",
      url: TERRAIN_TILEJSON_URL,
      // Mapterhorn's North Wildwood coverage ends at z16. Its TileJSON omits the cap.
      maxzoom: 16,
      tileSize: 512
    });
    syncTerrainForView(glMap.getPitch() > 10);

    glMap.addSource("nw-satellite-source", {
      type: "raster",
      tiles: [ESRI_WORLD_IMAGERY_URL],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 19,
      attribution: "Tiles &copy; Esri"
    });
    glMap.addLayer({
      id: "nw-satellite",
      type: "raster",
      source: "nw-satellite-source",
      layout: { visibility: visibility(layerVisible("satelliteToggle", false)) },
      paint: { "raster-fade-duration": 0 }
    });

    var feature = boundaryGeoJson();
    if (feature) {
      glMap.addSource("nw-boundary-mask-source", { type: "geojson", data: boundaryMaskGeoJson(feature) });
      glMap.addLayer({
        id: "nw-boundary-mask",
        type: "fill",
        source: "nw-boundary-mask-source",
        paint: { "fill-color": "#d7d7d7", "fill-opacity": 0.62 }
      });
      glMap.addSource("nw-boundary-source", { type: "geojson", data: feature });
      glMap.addLayer({
        id: "nw-boundary-outline",
        type: "line",
        source: "nw-boundary-source",
        layout: { visibility: visibility(isTownBoundaryEnabled()) },
        paint: {
          "line-color": getComputedStyle(document.documentElement).getPropertyValue("--boundary-color").trim() || "#000000",
          // Keep the simulation extent readable without letting it become a
          // heavy band across the municipality at overview scales.
          "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.45, 13, 0.7, 15, 0.95, 17, 1.25, 19, 1.6],
          "line-opacity": 1
        }
      });
    }

    // NorthWildwoodBuildings3D.geojson contains the verified municipal
    // footprints. Do not extrude basemap context outside North Wildwood.
    document.body.dataset.buildings3dFallbackLayers = "0";
    document.body.dataset.buildings3dContextLayers = "0";
    document.body.dataset.buildings3dCoverage = "municipality-only";
    document.body.dataset.buildings3dClippedToMunicipality = "true";

    // Road symbols come from the shared scalable vector style.
  }

  function syncTerrainForView(pitched) {
    if (!glMap || !glStyleReady) return;
    var terrain = glMap.getTerrain ? glMap.getTerrain() : null;
    if (pitched) {
      if (!terrain || terrain.source !== "nw-terrain" || Number(terrain.exaggeration) !== TERRAIN_EXAGGERATION) {
        glMap.setTerrain({ source: "nw-terrain", exaggeration: TERRAIN_EXAGGERATION });
      }
      document.body.dataset.map3dTerrainState = "active";
    } else {
      if (terrain) glMap.setTerrain(null);
      document.body.dataset.map3dTerrainState = "parked-in-2d";
    }
  }

  function resize3dView() {
    if (glMap) glMap.resize();
    syncGlPopupLayout();
  }

  function wire3dInteractions() {
    glMap.on("moveend", sync3dViewToLeaflet);
    glMap.on("dragend", function () {
      // MapLibre's inertial glide keeps redrawing terrain after the pointer is
      // released. On this dense full-screen scene that starves Chrome's fixed
      // UI layers and presents as strips of missing text/buildings. Preserve
      // direct dragging but finish the camera on the release frame.
      glMap.stop();
      requestAnimationFrame(function () {
        if (glMap) glMap.stop();
      });
    });
    glMap.on("click", async function (event) {
      // Popup controls must not also select the building beneath them.
      if (event.originalEvent?.target?.closest?.(".maplibregl-popup")) return;
      if (mapClickMode === "building" && layerVisible("nsiStructuresToggle", false) && glMap.getLayer("nw-nsi-points")) {
        var structureHits = glMap.queryRenderedFeatures(event.point, { layers: ["nw-nsi-points"] });
        if (structureHits.length) {
          beginMapQuery();
          // The ground coordinate below a 3D marker can be closer to another structure.
          var footprintIds = new Set(structureHits.map(hit => hit.properties?.footprintId));
          var [structureFootprintId] = footprintIds;
          var structure = footprintIds.size === 1 && structureFootprintId
            ? nsiStructureFeatures.find(feature => feature.properties?.footprintId === structureFootprintId)
            : null;
          if (structure) {
            var [lon, lat] = structure.geometry.coordinates;
            openNsiStructurePopup(structure, L.latLng(lat, lon));
          } else {
            toast("Tap a single highlighted structure to see its estimate.");
          }
          return;
        }
      }
      var buildingsEnabled = layerVisible("buildingsToggle", false);
      var buildingLayerId = glMap.getPitch() > 10 ? "nw-3d-buildings" : "nw-2d-buildings";
      if (buildingsEnabled && mapClickMode === "building" && glMap.getLayer(buildingLayerId)) {
        var rendered = glMap.queryRenderedFeatures(event.point, { layers: [buildingLayerId] });
        if (rendered.length) {
          var queryGeneration = beginMapQuery();
          var queryMode = mapClickMode;
          var queryRenderToken = lastRenderToken;
          var isCurrentQuery = function () {
            return queryGeneration === mapQueryGeneration && queryMode === mapClickMode &&
              queryRenderToken === lastRenderToken && layerVisible("buildingsToggle", false);
          };
          var selectedBuilding = { feature: rendered[0], point: null, parcel: null };
          try {
            selectedBuilding = await resolveClickedBuildingParcel3d(rendered[0]);
            if (!isCurrentQuery()) return;
            var footprintId = selectedBuilding.feature.properties?.footprintId;
            // A shared parcel carries flood facts for only its associated NSI
            // structure. Keep the clicked building's own facts on other roofs.
            if (footprintId && String(selectedBuilding.parcel?.properties?.nsi2026FootprintId) === String(footprintId)) {
              openParcelFloodPrompt(selectedBuilding.parcel, L.latLng(selectedBuilding.point[1], selectedBuilding.point[0]));
              return;
            }
          } catch (_) {}
          if (!isCurrentQuery()) return;
          openFallbackBuildingPopup(
            selectedBuilding.point ? L.latLng(selectedBuilding.point[1], selectedBuilding.point[0])
              : L.latLng(event.lngLat.lat, event.lngLat.lng),
            selectedBuilding.feature.properties
          );
          return;
        }
      }
      handleDepthQueryClick({
        latlng: L.latLng(event.lngLat.lat, event.lngLat.lng),
        originalEvent: event.originalEvent || {}
      });
    });
    window.addEventListener("resize", resize3dView, { passive: true });
    if (map) map.on("moveend zoomend", syncLeafletViewTo3d);
  }

  function wire3dContextRecovery(mapInstance) {
    var generation = 0;
    var timer = null;
    var onStyleReady = null;
    var retryRestoration = null;
    retryFloodRecovery3d = null;
    function clearWait() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (onStyleReady) mapInstance.off("style.load", onStyleReady);
      onStyleReady = null;
    }
    function current(token) {
      return glMap === mapInstance && generation === token;
    }
    function failed(token, error) {
      if (!current(token)) return;
      clearWait();
      if (!glStyleReady && document.body.classList.contains("map-3d-ready")) {
        restoreLeafletAfter3dFailure(mapInstance);
        return;
      }
      document.body.dataset.map3d = "unavailable";
      setStatus("Flood display could not recover. Try the view button, or reload this page.");
      console.warn("The flood display could not recover after a graphics reset.", error);
    }
    mapInstance.on("webglcontextlost", function () {
      if (glMap !== mapInstance) return;
      var token = ++generation;
      clearWait();
      retryRestoration = null;
      retryFloodRecovery3d = null;
      glStyleReady = false;
      // GPU handles belong to the lost context. MapLibre drops custom layers
      // from the recovered style, so the old layer object must not be reused.
      if (floodPlaneLayer && floodPlaneLayer.cancelTextureLoad) floodPlaneLayer.cancelTextureLoad();
      floodPlaneLayer = null;
      document.body.dataset.map3d = "recovering";
      document.body.dataset.map3dFloodTexture = "unavailable";
      setStatus("Map graphics interrupted. Waiting for recovery…");
      timer = window.setTimeout(function () { failed(token, new Error("Graphics recovery timed out.")); }, 20000);
    });
    mapInstance.on("webglcontextrestored", function () {
      if (glMap !== mapInstance) return;
      var token = ++generation;
      clearWait();
      document.body.dataset.map3d = "recovering";
      setStatus("Restoring flood display…");
      timer = window.setTimeout(function () { failed(token, new Error("Flood restoration timed out.")); }, 20000);
      onStyleReady = function () {
        if (!current(token)) return;
        if (onStyleReady) mapInstance.off("style.load", onStyleReady);
        onStyleReady = null;
        try {
          glStyleReady = true;
          // Only an established restored style can retry its flood sources.
          // A lost context or a timed-out style must retain normal view actions.
          retryFloodRecovery3d = function () {
            if (glMap !== mapInstance || !glStyleReady || !retryRestoration) return Promise.resolve(false);
            clearWait();
            var retryToken = generation;
            document.body.dataset.map3d = "recovering";
            setStatus("Restoring flood display…");
            timer = window.setTimeout(function () { failed(retryToken, new Error("Flood restoration timed out.")); }, 20000);
            return retryRestoration();
          };
          syncBoundary3d();
          syncFloodLayer3d();
          syncSatellite3d();
          syncRoadLabels3d();
          syncParcels3d();
          syncNsi3d();
          async function waitForCurrentFlood() {
            while (current(token)) {
              var restoredLayer = floodPlaneLayer;
              var restoredUrl = restoredLayer && restoredLayer.url;
              var restoredSource = mapInstance.getSource("nw-flood-drape-source");
              var ready = await Promise.all([
                restoredLayer ? restoredLayer.whenReady() : true,
                restoredLayer ? waitForNativeFloodImage3d(mapInstance, restoredSource, function () {
                  return current(token) && restoredLayer === floodPlaneLayer && restoredUrl === restoredLayer.url;
                }) : true
              ]);
              if (!current(token)) return false;
              // Follow a selection made during recovery. A superseded image
              // resolving cannot certify the newer texture as healthy.
              if (restoredLayer !== floodPlaneLayer || restoredLayer && restoredUrl !== restoredLayer.url ||
                  restoredSource !== mapInstance.getSource("nw-flood-drape-source")) continue;
              if (restoredLayer && (!ready.every(Boolean) || !restoredLayer.textureReady || restoredLayer.committedUrl !== restoredUrl)) {
                throw new Error("The selected flood texture could not reload.");
              }
              return true;
            }
            return false;
          }
          var recovery = waitForCurrentFlood().then(function (ready) {
            if (!current(token) || !ready) return false;
            clearWait();
            document.body.dataset.map3d = "ready";
            setStatus();
            mapInstance.triggerRepaint();
            syncPersistentNavControl();
            return true;
          }).catch(function (error) { failed(token, error); return false; });
          Promise.resolve(syncBuildings3d()).catch(function (error) {
            console.warn("Buildings could not refresh after graphics recovery.", error);
          });
          return recovery;
        } catch (error) { failed(token, error); return Promise.resolve(false); }
      };
      retryRestoration = onStyleReady;
      // Restoration recreates the style asynchronously. Wait for its source
      // definitions before adding the custom flood layer again.
      mapInstance.on("style.load", onStyleReady);
      if (mapInstance.isStyleLoaded()) onStyleReady();
    });
  }

  async function ensure3dMap() {
    if (glMapPromise) return glMapPromise;
    if (glMap && glStyleReady) return glMap;
    var initialization = { map: null, cancelled: false, cancelRenderer: null };
    glMapInitialization = initialization;
    function current() { return glMapInitialization === initialization && !initialization.cancelled; }
    function requireCurrent() { if (!current()) throw new Error("The 3D initialization was superseded."); }
    var startup = (async function () {
      await loadMapLibreRuntime();
      requireCurrent();
      var container = document.getElementById("map3d");
      if (!container) throw new Error("The 3D map container is unavailable.");
      var style = await load3dStyle();
      requireCurrent();
      var leafletCenter = map && map.getCenter ? map.getCenter() : { lng: TOWN_CONFIG.map.center.lon, lat: TOWN_CONFIG.map.center.lat };
      var leafletZoom = map && map.getZoom ? map.getZoom() : 13;
      var mobileRenderer = window.matchMedia("(pointer: coarse), (max-width: 900px)").matches;
      glMap = new maplibregl.Map({
        container: container,
        style: style,
        center: [leafletCenter.lng, leafletCenter.lat],
        zoom: Math.min(MAP_MAX_ZOOM, leafletZoom),
        minZoom: 11,
        maxZoom: MAP_MAX_ZOOM,
        pitch: DEFAULT_PITCH,
        bearing: DEFAULT_BEARING,
        maxPitch: 85,
        scrollZoom: true,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        // Multisample antialiasing doubles the cost of the terrain/building
        // framebuffer on Retina displays and was the last source of visible
        // checkerboarding during sustained pans. Normal map filtering keeps
        // the scene clean without the multisampled offscreen surface.
        antialias: false,
        fadeDuration: 0,
        refreshExpiredTiles: false,
        maxTileCacheZoomLevels: mobileRenderer ? 3 : 8,
        // Cache views reached through navigation without moving the camera
        // automatically to load other compass directions.
        maxTileCacheSize: mobileRenderer ? 64 : 384,
        // Render at one physical pixel per CSS pixel. The former 0.75 scale was
        // visibly resampled during camera movement, making the flood PNG and
        // thin building runs appear to wiggle or disappear at street scale.
        pixelRatio: 1,
        // MapLibre's supported no-inertia path avoids an expensive terrain
        // glide after every pointer release and makes mode changes atomic.
        reduceMotion: true,
        powerPreference: mobileRenderer ? "low-power" : "high-performance",
        attributionControl: false,
        canvasContextAttributes: { antialias: false }
      });
      initialization.map = glMap;
      if (glMap.touchZoomRotate && typeof glMap.touchZoomRotate.disableRotation === "function") {
        glMap.touchZoomRotate.disableRotation();
      }
      ["pitch", "rotate", "zoom"].forEach(function (eventName) {
        glMap.on(eventName, schedulePersistentNavControlSync);
      });
      glMap.on("pitch", syncFloodPresentationMode);
      glMap.on("zoom", syncFloodPresentationMode);
      glMap.on("moveend", syncPersistentNavControl);
      syncPersistentNavControl();
      glMap.on("error", function (event) {
        var requestUrl = event?.error?.url;
        var esriTileError = typeof requestUrl === "string" &&
          requestUrl.startsWith(ESRI_VECTOR_TILES.split("{z}")[0]);
        if (glMap === initialization.map && glMap.style && (event?.sourceId === "esri" || esriTileError)) {
          var source = glMap.getSource("esri");
          if (source) failedEsriVectorSources.add(source);
        }
        console.warn("North Wildwood 3D renderer warning.", event && event.error ? event.error : event);
      });
      wire3dContextRecovery(glMap);
      await new Promise(function (resolve, reject) {
        var mapInstance = initialization.map;
        var timer = window.setTimeout(function () { finish(new Error("The 3D renderer timed out.")); }, 20000);
        var settled = false;
        function finish(error) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (mapInstance.off) mapInstance.off("load", loaded);
          initialization.cancelRenderer = null;
          if (error) reject(error);
          else { glStyleReady = true; resolve(); }
        }
        function loaded() {
          if (!current()) { finish(new Error("The 3D initialization was superseded.")); return; }
          finish();
        }
        initialization.cancelRenderer = function () { finish(new Error("The 3D renderer was cancelled.")); };
        mapInstance.once("load", loaded);
      });
      requireCurrent();
      addCore3dLayers();
      wire3dInteractions();
      syncBoundary3d();
      syncFloodLayer3d();
      syncSatellite3d();
      syncRoadLabels3d();
      syncParcels3d();
      syncNsi3d();
      await syncBuildings3d({ preload: true });
      requireCurrent();
      document.body.classList.add("map-3d-ready");
      if (townAddressMarker) setAddressMarker(townAddressMarker.getLatLng(), townAddressMarker.options.title);
      if (townAddressPopup && persistentFloodPopup === townAddressPopup) {
        showGlPopup(townAddressPopup, undefined, true);
      }
      document.body.dataset.map3d = "ready";
      if (document.getElementById("toastMessage")?.textContent === GRAPHICS_FALLBACK_NOTICE) toast("");
      document.body.dataset.terrainExaggeration = String(TERRAIN_EXAGGERATION);
      document.body.dataset.map3dMaxZoom = String(MAP_MAX_ZOOM);
      document.body.dataset.map3dPixelRatio = "1";
      document.body.dataset.map3dPitch = String(glMap.getPitch());
      updateDiagnostics();
      suspendLeafletVisualLayers();
      requestAnimationFrame(function () { if (current() && glMap === initialization.map) glMap.resize(); });
      return glMap;
    })();
    // One budget covers dependencies, style, renderer and initial buildings.
    // Superseded continuations cannot mutate a replacement map after timeout.
    glMapPromise = new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () { reject(new Error("The 3D map startup timed out.")); }, 20000);
      startup.then(function (value) { window.clearTimeout(timer); resolve(value); }, function (error) { window.clearTimeout(timer); reject(error); });
    }).catch(function (error) {
      if (!current()) return null;
      initialization.cancelled = true;
      if (initialization.cancelRenderer) initialization.cancelRenderer();
      if (mapStylePromise && mapStylePromise.cancel) mapStylePromise.cancel();
      if (buildingDataPromise && buildingDataPromise.cancel) buildingDataPromise.cancel();
      document.body.classList.remove("map-3d-ready");
      document.body.dataset.map3d = "fallback";
      glStyleReady = false;
      retryFloodRecovery3d = null;
      console.warn("The 3D map could not start; the 2D map remains available.", error);
      glMapPromise = null;
      if (glMap && glMap === initialization.map) {
        try { glMap.remove(); } catch (_) {}
        glMap = null;
        floodPlaneLayer = null;
        buildingCursorHandlersWired = false;
      }
      if (map) map.invalidateSize();
      return null;
    });
    return glMapPromise;
  }

  function waitFor3dMapIdle(mapInstance, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timeout = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        mapInstance.off("idle", onIdle);
        reject(new Error("The 3D terrain tiles did not finish loading in time."));
      }, Number(timeoutMs) || 45000);
      function onIdle() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        // Let the browser present the idle frame before the site loader fades.
        requestAnimationFrame(function () {
          requestAnimationFrame(resolve);
        });
      }
      mapInstance.once("idle", onIdle);
      mapInstance.triggerRepaint();
    });
  }

  async function preload3dAssets(options) {
    var preloadOptions = options || {};
    await Promise.all([
      loadMapLibreRuntime(),
      load3dStyle(),
      loadBuildingData()
    ]);
    document.body.dataset.map3dPreloaded = "true";
    if (preloadOptions.initialize) {
      document.body.dataset.map3dFullyPreloaded = "loading";
      var mapInstance = await ensure3dMap();
      if (!mapInstance) throw new Error("The complete 3D map could not be preloaded.");
      var floodReady = floodPlaneLayer && typeof floodPlaneLayer.whenReady === "function"
        ? floodPlaneLayer.whenReady()
        : Promise.resolve(true);
      await Promise.all([
        waitFor3dMapIdle(mapInstance, 45000),
        floodReady
      ]);
      // Preloading must never move the visible camera or restore an older
      // viewpoint over a compass gesture made while assets were loading.
      document.body.dataset.map3dCameraPreload = "current-view-only";
      document.body.dataset.map3dFullyPreloaded = "interactive";
    }
    return {
      buildings: buildingData && buildingData.features ? buildingData.features.length : 0,
      terrainExaggeration: TERRAIN_EXAGGERATION,
      initialized: Boolean(preloadOptions.initialize && glMap)
    };
  }

  function enableDefaultBuildings3d() {
    // Switching the camera into 3D should also show walls on a fresh map.
    // A newer explicit Buildings choice always wins, including an off click
    // made while the renderer or building data was still loading.
    if (buildingVisibilityPreference === false || layerVisible("buildingsToggle", false)) return;
    var toggle = document.getElementById("buildingsToggle");
    if (!toggle) return;
    toggle.classList.add("on");
    toggle.setAttribute("aria-checked", "true");
    updateExportBuildingsLayer();
    updateMapClickModeControl();
  }

  function install3dLauncher() {
    if (document.getElementById("nwDefaultNavControl")) return;
    var host = document.getElementById("mapWrap") || document.body;
    var control = document.createElement("div");
    control.id = "nwDefaultNavControl";
    control.className = "nw-simple-control";
    control.setAttribute("aria-label", "Map navigation");
    control.innerHTML = [
      '<div class="nw-direction-wheel" role="application" tabindex="0" aria-label="Viewpoint wheel. Choose north, east, south, west, or any direction between to rotate the map viewing direction.">',
      '  <span class="nw-wheel-cardinal nw-wheel-n" aria-hidden="true">N</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-e" aria-hidden="true">E</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-s" aria-hidden="true">S</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-w" aria-hidden="true">W</span>',
      '  <span class="nw-wheel-knob" aria-hidden="true"></span>',
      '</div>',
      '<button class="nw-simple-view" type="button" aria-label="2D view active. Switch to 3D view" aria-pressed="false" title="2D view active. Switch to 3D view"><span class="nw-simple-view-label">2D</span></button>',
      '<div class="nw-simple-zoom" role="group" aria-label="Zoom controls">',
      '  <button class="nw-simple-zoom-button nw-simple-zoom-in" type="button" aria-label="Zoom in" title="Zoom in"><span aria-hidden="true">+</span></button>',
      '  <button class="nw-simple-zoom-button nw-simple-zoom-out" type="button" aria-label="Zoom out" title="Zoom out"><span aria-hidden="true">−</span></button>',
      '</div>'
    ].join("");
    var launcher = control.querySelector(".nw-simple-view");
    var label = control.querySelector(".nw-simple-view-label");
    var wheel = control.querySelector(".nw-direction-wheel");
    var pendingBearing = null;
    var pendingPointerBearing = null;
    var queuedViewpointBearing = null;
    var queuedViewpointDuration = 0;
    var viewpointAnimationFrame = 0;
    var activePointer = null;
    var desired3dMode = false;
    var modeTransitionTimer = null;

    function stop(event) { event.stopPropagation(); }
    ["click", "dblclick", "mousedown", "touchstart", "pointerdown", "wheel", "contextmenu"].forEach(function (name) {
      control.addEventListener(name, stop);
    });

    function map3dReady() {
      return Boolean(glMap && document.body.classList.contains("map-3d-ready"));
    }

    function actual3dMode() {
      return Boolean(map3dReady() && glMap.getPitch() > 10);
    }

    function setModeBusy(busy) {
      launcher.setAttribute("aria-busy", busy ? "true" : "false");
      control.classList.toggle("is-mode-transitioning", Boolean(busy));
    }

    syncPersistentNavControl = function () {
      var busy = launcher.getAttribute("aria-busy") === "true";
      var showing3d = busy ? desired3dMode : actual3dMode();
      var accessibleLabel = busy
        ? "Switching to " + (showing3d ? "3D" : "2D") + " view"
        : showing3d
          ? "3D view active. Switch to 2D view"
          : "2D view active. Switch to 3D view";
      label.textContent = showing3d ? "3D" : "2D";
      launcher.setAttribute("aria-pressed", showing3d ? "true" : "false");
      launcher.setAttribute("aria-label", accessibleLabel);
      launcher.setAttribute("title", accessibleLabel);
      control.dataset.viewMode = showing3d ? "3d" : "2d";
      document.body.dataset.mapViewMode = showing3d ? "3d" : "2d";
      if (glMap) document.body.dataset.map3dPitch = String(glMap.getPitch());
    };

    function finishModeTransition() {
      if (modeTransitionTimer) window.clearTimeout(modeTransitionTimer);
      modeTransitionTimer = null;
      syncingModeTransition = false;
      setModeBusy(false);
      if (desired3dMode && glMap && Number.isFinite(pendingBearing)) {
        glMap.jumpTo({ bearing: pendingBearing });
      }
      sync3dViewToLeaflet();
      syncPersistentNavControl();
      syncGlPopupLayout();
      updateDiagnostics();
    }

    function transitionMode(target3d, requestedBearing) {
      if (!map3dReady()) return;
      desired3dMode = Boolean(target3d);
      if (Number.isFinite(requestedBearing)) pendingBearing = requestedBearing;
      syncingModeTransition = true;
      setModeBusy(true);
      syncPersistentNavControl();
      var camera = { pitch: desired3dMode ? THREE_D_PITCH : DEFAULT_PITCH };
      if (Number.isFinite(requestedBearing)) camera.bearing = requestedBearing;
      glMap.stop();
      // Terrain is useful only for a pitched camera. Parking it in 2D removes
      // the expensive DEM rebuild from compass rotation without changing the
      // default top-down view. The terrain source stays loaded for instant 3D.
      syncTerrainForView(desired3dMode);
      // Apply the user's requested view in one update instead of animating
      // through intermediate pitches and rebuilding terrain on every frame.
      glMap.jumpTo(camera);
      if (desired3dMode) enableDefaultBuildings3d();
      syncFloodPresentationMode();
      if (modeTransitionTimer) window.clearTimeout(modeTransitionTimer);
      modeTransitionTimer = window.setTimeout(finishModeTransition, 120);
      requestAnimationFrame(function () {
        requestAnimationFrame(finishModeTransition);
      });
    }

    function updateDefaultWheel(clientX, clientY) {
      var rect = wheel.getBoundingClientRect();
      var dx = clientX - (rect.left + rect.width / 2);
      var dy = clientY - (rect.top + rect.height / 2);
      var distance = Math.sqrt(dx * dx + dy * dy);
      var maxRadius = Math.max(18, rect.width * .30);
      if (distance <= maxRadius * .08) return null;
      var scale = distance > maxRadius ? maxRadius / distance : 1;
      wheel.style.setProperty("--nw-wheel-x", (dx * scale).toFixed(2) + "px");
      wheel.style.setProperty("--nw-wheel-y", (dy * scale).toFixed(2) + "px");
      pendingBearing = bearingFromViewpointVector(dx / distance, dy / distance);
      return pendingBearing;
    }

    function resetDefaultWheel() {
      if (activePointer !== null) {
        try {
          if (wheel.hasPointerCapture && wheel.hasPointerCapture(activePointer)) {
            wheel.releasePointerCapture(activePointer);
          }
        } catch (_) {}
      }
      activePointer = null;
      wheel.classList.remove("is-active");
      wheel.style.setProperty("--nw-wheel-x", "0px");
      wheel.style.setProperty("--nw-wheel-y", "0px");
    }

    function finishDefaultWheel(event, commit) {
      if (activePointer === null || event.pointerId !== activePointer) return;
      var selectedBearing = pendingPointerBearing;
      pendingPointerBearing = null;
      resetDefaultWheel();
      // Always commit the exact final bearing. Live previews are deliberately
      // throttled below so this remains one bounded final camera update rather
      // than a terrain rebuild for every raw pointer sample.
      if (commit && Number.isFinite(selectedBearing)) {
        applyViewpoint(selectedBearing, 0);
      }
    }

    async function activate3d(requestedBearing) {
      if (Number.isFinite(requestedBearing)) pendingBearing = requestedBearing;
      if (launcher.getAttribute("aria-busy") === "true") return;
      desired3dMode = true;
      setModeBusy(true);
      syncPersistentNavControl();
      var nextMap = await ensure3dMap();
      if (nextMap) {
        transitionMode(true, Number.isFinite(pendingBearing) ? pendingBearing : nextMap.getBearing());
        return;
      }
      desired3dMode = false;
      syncingModeTransition = false;
      setModeBusy(false);
      syncPersistentNavControl();
      resetDefaultWheel();
      toast("3D terrain could not load. The 2D map is still available.");
    }

    function flushQueuedViewpoint() {
      viewpointAnimationFrame = 0;
      var bearing = queuedViewpointBearing;
      var duration = queuedViewpointDuration;
      queuedViewpointBearing = null;
      queuedViewpointDuration = 0;
      if (!Number.isFinite(bearing) || !map3dReady()) return;
      if (launcher.getAttribute("aria-busy") === "true") return;
      if (duration) {
        glMap.stop();
        glMap.easeTo({ bearing: bearing, duration: duration });
      } else {
        glMap.jumpTo({ bearing: bearing });
      }
      document.body.dataset.map3dWheelFrame = String(
        Number(document.body.dataset.map3dWheelFrame || 0) + 1
      );
      syncPersistentNavControl();
      updateDiagnostics();
    }

    function queueViewpoint(bearing, duration) {
      queuedViewpointBearing = bearing;
      queuedViewpointDuration = Number(duration) || 0;
      if (!viewpointAnimationFrame) {
        viewpointAnimationFrame = requestAnimationFrame(flushQueuedViewpoint);
      }
    }

    async function applyViewpoint(bearing, duration) {
      if (!Number.isFinite(bearing)) return;
      pendingBearing = bearing;
      if (!map3dReady()) {
        var nextMap = await ensure3dMap();
        if (!nextMap) return;
      }
      if (launcher.getAttribute("aria-busy") === "true") return;
      // Pointer events can arrive much faster than the map can paint. Keep
      // only the latest bearing and update the camera once per display frame.
      queueViewpoint(bearing, duration);
    }

    launcher.addEventListener("click", function () {
      if (launcher.getAttribute("aria-busy") === "true") return;
      if (document.body.dataset.map3d === "unavailable" && typeof retryFloodRecovery3d === "function") {
        setModeBusy(true);
        Promise.resolve(retryFloodRecovery3d()).finally(function () {
          setModeBusy(false);
          syncPersistentNavControl();
        });
        return;
      }
      pendingBearing = null;
      if (!map3dReady()) activate3d(null);
      else transitionMode(!actual3dMode());
    });
    control.querySelector(".nw-simple-zoom-in").addEventListener("click", function () {
      if (launcher.getAttribute("aria-busy") === "true") return;
      if (map3dReady()) {
        glMap.stop();
        glMap.jumpTo({ zoom: Math.min(MAP_MAX_ZOOM, glMap.getZoom() + 1) });
      } else if (map && typeof map.zoomIn === "function") map.zoomIn();
    });
    control.querySelector(".nw-simple-zoom-out").addEventListener("click", function () {
      if (launcher.getAttribute("aria-busy") === "true") return;
      if (map3dReady()) {
        glMap.stop();
        glMap.jumpTo({ zoom: Math.max(11, glMap.getZoom() - 1) });
      } else if (map && typeof map.zoomOut === "function") map.zoomOut();
    });
    wheel.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      activePointer = event.pointerId;
      wheel.classList.add("is-active");
      try { wheel.setPointerCapture(activePointer); } catch (_) {}
      pendingPointerBearing = updateDefaultWheel(event.clientX, event.clientY);
      if (Number.isFinite(pendingPointerBearing)) queueViewpoint(pendingPointerBearing, 0);
    });
    wheel.addEventListener("pointermove", function (event) {
      if (event.pointerId !== activePointer) return;
      pendingPointerBearing = updateDefaultWheel(event.clientX, event.clientY);
      // Keep only the newest pointer sample. The map now follows the wheel at
      // most once per animation frame while release still commits the exact
      // final bearing.
      if (Number.isFinite(pendingPointerBearing)) queueViewpoint(pendingPointerBearing, 0);
    });
    wheel.addEventListener("pointerup", function (event) { finishDefaultWheel(event, true); });
    wheel.addEventListener("pointercancel", function (event) { finishDefaultWheel(event, false); });
    wheel.addEventListener("lostpointercapture", function (event) {
      if (activePointer !== null && event.pointerId === activePointer) {
        pendingPointerBearing = null;
        resetDefaultWheel();
      }
    });
    wheel.addEventListener("keydown", function (event) {
      var bearings = { ArrowUp: 180, ArrowRight: 270, ArrowDown: 0, ArrowLeft: 90 };
      if (!Object.prototype.hasOwnProperty.call(bearings, event.key)) return;
      event.preventDefault();
      applyViewpoint(bearings[event.key], 0);
    });
    host.appendChild(control);
    control.dataset.wheelCameraUpdates = "raf-latest-plus-final-commit";
    control.dataset.wheelPreview3dMs = "animation-frame";
    control.dataset.wheelPreview2dMs = "animation-frame";
    if (!document.body.dataset.map3d) document.body.dataset.map3d = "idle";
    syncPersistentNavControl();
  }

  install3dLauncher();

  var originalSetBuildingsEnabled = setBuildingsEnabled;
  setBuildingsEnabled = async function (enabled, options) {
    var generation = ++buildingToggleGeneration;
    var shouldEnable = Boolean(enabled);
    // A failed load resets the switch without inventing an explicit off
    // preference. A later 3D retry still honors the user's last real choice.
    if (!options || !options.rollback) buildingVisibilityPreference = shouldEnable;
    var toggle = document.getElementById("buildingsToggle");
    if (toggle) {
      toggle.classList.toggle("on", shouldEnable);
      toggle.setAttribute("aria-checked", String(shouldEnable));
    }
    if (!shouldEnable) ++mapQueryGeneration;
    try {
      if (glMap && document.body.classList.contains("map-3d-ready")) {
        if (buildingsLayer && map && map.hasLayer(buildingsLayer)) map.removeLayer(buildingsLayer);
        if (shouldEnable) setMapClickMode("building", { closePopup: false });
        else {
          if (fallbackBuildingPopup && map.hasLayer(fallbackBuildingPopup)) map.removeLayer(fallbackBuildingPopup);
          disableBuildingInfo();
        }
        updateExportBuildingsLayer();
        toast("");
        await syncBuildings3d();
        if (generation !== buildingToggleGeneration) return;
        suspendLeafletVisualLayers();
        return;
      }
      return await originalSetBuildingsEnabled.apply(this, arguments);
    } catch (error) {
      if (generation !== buildingToggleGeneration) return;
      throw error;
    }
  };

  var originalSetSatelliteEnabled = setSatelliteEnabled;
  setSatelliteEnabled = function () {
    var result = originalSetSatelliteEnabled.apply(this, arguments);
    syncSatellite3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalUpdateRoadLayerAppearance = updateRoadLayerAppearance;
  updateRoadLayerAppearance = function (options) {
    var result = originalUpdateRoadLayerAppearance.apply(this, arguments);
    syncRoadLabels3d();
    if (options?.retry3dRoads) retryFailedEsriRoadSource();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalApplyTownBoundaryVisibility = applyTownBoundaryVisibility;
  applyTownBoundaryVisibility = function () {
    var result = originalApplyTownBoundaryVisibility.apply(this, arguments);
    syncBoundary3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalUpdateMunicipalBoundaryLayer = updateMunicipalBoundaryLayer;
  updateMunicipalBoundaryLayer = function () {
    var result = originalUpdateMunicipalBoundaryLayer.apply(this, arguments);
    syncBoundary3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalSetParcelsEnabled = setParcelsEnabled;
  setParcelsEnabled = async function () {
    var result = await originalSetParcelsEnabled.apply(this, arguments);
    // A fresh successful enable also retries a failed native image source.
    // Its unchanged URL/geometry must not certify an earlier failed request.
    syncParcels3d(Boolean(arguments[0]));
    suspendLeafletVisualLayers();
    return result;
  };

  var originalSetNsiStructuresEnabled = setNsiStructuresEnabled;
  setNsiStructuresEnabled = async function () {
    var result = await originalSetNsiStructuresEnabled.apply(this, arguments);
    syncNsi3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalUpdateNsiStructureImpactLayer = updateNsiStructureImpactLayer;
  updateNsiStructureImpactLayer = function () {
    var result = originalUpdateNsiStructureImpactLayer.apply(this, arguments);
    syncNsi3d();
    return result;
  };

  var originalClearFloodLayer = clearFloodLayer;
  clearFloodLayer = function () {
    var result = originalClearFloodLayer.apply(this, arguments);
    closeOutdatedFallbackBuildingPopup();
    syncFloodLayer3d();
    return result;
  };

  var originalApplyOverlayOpacity = applyOverlayOpacity;
  applyOverlayOpacity = function () {
    var result = originalApplyOverlayOpacity.apply(this, arguments);
    if (floodPlaneLayer && typeof floodPlaneLayer.setOpacity === "function") floodPlaneLayer.setOpacity(overlayOpacity);
    if (glMap && glStyleReady && glMap.getLayer("nw-flood-drape")) {
      glMap.setPaintProperty("nw-flood-drape", "raster-opacity", overlayOpacity);
    }
    return result;
  };

  var originalSetFloodLayer = setFloodLayer;
  setFloodLayer = async function () {
    var result = await originalSetFloodLayer.apply(this, arguments);
    syncFloodLayer3d();
    return result;
  };

  var originalSetPhysicsFloodLayer = setPhysicsFloodLayer;
  setPhysicsFloodLayer = async function () {
    var result = await originalSetPhysicsFloodLayer.apply(this, arguments);
    syncFloodLayer3d();
    return result;
  };

  var originalSetMapClickMode = setMapClickMode;
  setMapClickMode = function (mode, options) {
    var result = originalSetMapClickMode.apply(this, arguments);
    if (!options || options.closePopup !== false) closeGlPopup();
    return result;
  };

  var originalOpenPersistentFloodPopup = openPersistentFloodPopup;
  openPersistentFloodPopup = function (latlng, html, maxWidth) {
    var popup = originalOpenPersistentFloodPopup.apply(this, arguments);
    showGlPopup(popup, maxWidth);
    return popup;
  };

  var originalUpdatePersistentDepthQueryPopup = updatePersistentDepthQueryPopup;
  updatePersistentDepthQueryPopup = function () {
    discardObsoleteFloodFrame3d();
    closeOutdatedFallbackBuildingPopup();
    var result = originalUpdatePersistentDepthQueryPopup.apply(this, arguments);
    if (result?.then) result.then(syncUpdatedGlPopup);
    else syncUpdatedGlPopup();
    return result;
  };

  function syncUpdatedGlPopup() {
    if (glPopup && persistentFloodPopup && typeof persistentFloodPopup.getContent === "function") {
      var html = String(persistentFloodPopup.getContent() || "");
      var popupElement = glPopup.getElement();
      var controlSelector = ".maplibregl-popup-close-button, .house-alert-cta, .property-help summary";
      if (html !== lastGlPopupHtml && !deferPropertyPopupUpdate(popupElement, syncUpdatedGlPopup)) {
        var content = glPopup.getElement().querySelector(".maplibregl-popup-content");
        var scrollTop = content ? content.scrollTop : 0;
        var focusedIndex = Array.from(popupElement.querySelectorAll(controlSelector)).indexOf(document.activeElement);
        var helpOpen = popupElement.querySelector(".property-help")?.open;
        // MapLibre also autofocuses on setHTML. A time update must leave
        // keyboard focus on the timeline unless it was already in this card.
        var focusAfterOpen = glPopup.options.focusAfterOpen;
        glPopup.options.focusAfterOpen = false;
        try {
          glPopup.setHTML(html);
        } finally {
          glPopup.options.focusAfterOpen = focusAfterOpen;
        }
        lastGlPopupHtml = html;
        syncGlPopupLayout();
        var updatedContent = glPopup.getElement().querySelector(".maplibregl-popup-content");
        if (updatedContent) updatedContent.scrollTop = scrollTop;
        var help = glPopup.getElement().querySelector(".property-help");
        if (help) help.open = Boolean(helpOpen);
        glPopup.getElement().querySelectorAll(controlSelector)[focusedIndex]?.focus({ preventScroll: true });
      }
      syncGlPopupLayout();
    }
  }

  window.NORTH_WILDWOOD_3D = {
    ensure: ensure3dMap,
    preload: preload3dAssets,
    getMap: function () { return glMap; },
    setAddressMarker: setAddressMarker,
    getBuildingData: function () { return buildingData; },
    syncFlood: syncFloodLayer3d,
    prepareFloodFrame: prepareFloodFrame3d,
    syncBuildings: syncBuildings3d,
    state: function () {
      return {
        ready: document.body.classList.contains("map-3d-ready"),
        exaggeration: TERRAIN_EXAGGERATION,
        maxZoom: MAP_MAX_ZOOM,
        pitch: glMap ? glMap.getPitch() : null,
        bearing: glMap ? glMap.getBearing() : null,
        zoom: glMap ? glMap.getZoom() : null,
        terrain: glMap ? glMap.getTerrain() : null,
        buildingCount: buildingData && buildingData.features ? buildingData.features.length : 0,
        buildingsVisible: glMap && glMap.getLayer("nw-3d-buildings")
          ? glMap.getLayoutProperty("nw-3d-buildings", "visibility") !== "none"
          : false
      };
    }
  };
})();
