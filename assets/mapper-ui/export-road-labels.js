(function () {
  "use strict";

  // Street geometry and spelling come from the town's published centerlines.
  // Layout happens in export-map pixels, shared by preview, PNG and GIF.
  const FONT = 'Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const mapLayers = new Map();
  let roads = null;
  let request = null;
  let localRoadAttribution = "";
  let CanvasLayer = null;

  function labelName(value) {
    const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!name || /^FR\s/i.test(name)) return "";
    return name.replace(/\b(East|West|North|South|Avenue|Boulevard|Drive|Court|Circle)\b/g,
      word => ({ East: "E", West: "W", North: "N", South: "S", Avenue: "Ave", Boulevard: "Blvd", Drive: "Dr", Court: "Ct", Circle: "Cir" })[word]);
  }

  function localRoadSource(collection) {
    const source = String(collection.metadata?.source || collection.source || "");
    if (/NJOGIS/i.test(source) || /Tran_road_centerline_NJ\//i.test(source)) return "NJOGIS";
    if (/^https:\/\/enterprise\.firstmap\.delaware\.gov\//i.test(source)) return "Delaware FirstMap";
    if (/OpenStreetMap/i.test(collection.metadata?.attribution || "")) return "OpenStreetMap contributors";
    return "Published town centerlines";
  }

  function buildPaths(collection) {
    if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
      throw new Error("The export road names data is invalid.");
    }
    const groups = new Map();
    for (const feature of collection.features) {
      const properties = feature?.properties;
      const storedName = [properties?.name, properties?.PRIMENAME, properties?.STREET_NAME].find(value => labelName(value));
      if (!storedName) continue;
      const name = storedName.trim().replace(/\s+/g, " ");
      const geometry = feature?.geometry;
      const lines = geometry?.type === "LineString" ? [geometry.coordinates] : geometry?.coordinates;
      if (!["LineString", "MultiLineString"].includes(geometry?.type) || !Array.isArray(lines)) continue;
      for (const coordinates of lines) {
        if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
        if (!coordinates.every(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
            && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85.051129)) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(coordinates.map(point => [point[0], point[1]]));
      }
    }
    const result = [];
    const key = point => `${point[0].toFixed(7)},${point[1].toFixed(7)}`;
    for (const [name, lines] of [...groups].sort((a, b) => a[0].localeCompare(b[0], "en"))) {
      const nodes = new Map();
      const edges = [];
      const seen = new Set();
      for (const points of lines) {
        const first = key(points[0]), last = key(points[points.length - 1]);
        if (first === last && points.length === 2) continue;
        const signature = points.map(key).join(";");
        const reverse = [...points].reverse().map(key).join(";");
        if (seen.has(signature) || seen.has(reverse)) continue;
        seen.add(signature);
        const edge = { points, first, last, used: false, index: edges.length };
        edges.push(edge);
        for (const endpoint of [first, last]) {
          if (!nodes.has(endpoint)) nodes.set(endpoint, []);
          nodes.get(endpoint).push(edge);
        }
      }
      function walk(edge, start) {
        const points = [];
        let node = start;
        while (edge && !edge.used) {
          edge.used = true;
          const ordered = edge.first === node ? edge.points : [...edge.points].reverse();
          points.push(...(points.length ? ordered.slice(1) : ordered));
          node = edge.first === node ? edge.last : edge.first;
          const neighbors = nodes.get(node);
          edge = neighbors.length === 2 ? neighbors.find(candidate => !candidate.used) : null;
        }
        if (points.length > 1) result.push({ name, text: labelName(name), coordinates: points });
      }
      // Stop at branches rather than bridging an arbitrary fork of a street.
      for (const [node, connected] of nodes) if (connected.length !== 2) {
        for (const edge of connected) if (!edge.used) walk(edge, node);
      }
      for (const edge of edges) if (!edge.used) walk(edge, edge.first);
    }
    return result;
  }

  function load() {
    if (roads) return Promise.resolve(roads);
    if (request) return request;
    const controller = new AbortController();
    let timer;
    const current = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { controller.abort(); reject(error); }
        else resolve(value);
      };
      timer = setTimeout(() => finish(new Error("The export road names took too long to load. Please try again.")), 15000);
      const base = typeof APP_BASE !== "undefined" ? APP_BASE : document.baseURI;
      const assets = typeof TOWN_CONFIG !== "undefined" ? TOWN_CONFIG?.assets : null;
      const centerlines = assets?.exportRoadCenterlinesPath || assets?.roadImpactsPath || "./assets/road-impacts-data.geojson";
      const url = new URL(centerlines, base);
      Promise.resolve().then(() => fetch(url.href, { cache: "force-cache", signal: controller.signal })).then(async response => {
        if (!response.ok) throw new Error("The export road names could not load. Please try again.");
        const collection = await response.json();
        const paths = buildPaths(collection);
        if (paths.length) localRoadAttribution = localRoadSource(collection);
        finish(null, paths);
      }).catch(error => finish(error));
    });
    request = current.catch(error => {
      console.warn("Local export road names could not load. Using the map road names.", error);
      return [];
    }).then(value => {
      roads = value;
      for (const layer of mapLayers.values()) layer._render();
      return value;
    }).finally(() => { request = null; });
    return request;
  }

  function clipSegment(a, b, width, height) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let lo = 0, hi = 1;
    const p = [-dx, dx, -dy, dy], q = [a.x, width - a.x, a.y, height - a.y];
    for (let index = 0; index < 4; index += 1) {
      if (Math.abs(p[index]) < 1e-12) { if (q[index] < 0) return null; }
      else {
        const t = q[index] / p[index];
        if (p[index] < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
        if (lo > hi) return null;
      }
    }
    return [{ x: a.x + lo * dx, y: a.y + lo * dy }, { x: a.x + hi * dx, y: a.y + hi * dy }];
  }

  function visibleRuns(points, width, height) {
    const runs = [];
    let run = [];
    for (let index = 1; index < points.length; index += 1) {
      const clipped = clipSegment(points[index - 1], points[index], width, height);
      if (!clipped) { if (run.length > 1) runs.push(run); run = []; continue; }
      const last = run[run.length - 1];
      if (last && Math.hypot(last.x - clipped[0].x, last.y - clipped[0].y) > 0.01) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
      if (!run.length) run.push(clipped[0]);
      if (Math.hypot(run[run.length - 1].x - clipped[1].x, run[run.length - 1].y - clipped[1].y) > 0.01) run.push(clipped[1]);
    }
    if (run.length > 1) runs.push(run);
    return runs;
  }

  function corners(x, y, width, height, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => ({
      x: x + sx * width / 2 * c - sy * height / 2 * s,
      y: y + sx * width / 2 * s + sy * height / 2 * c
    }));
  }

  function overlaps(one, two) {
    for (const shape of [one, two]) for (let index = 0; index < 2; index += 1) {
      const a = shape[index], b = shape[index + 1], axis = { x: -(b.y - a.y), y: b.x - a.x };
      const first = one.map(point => point.x * axis.x + point.y * axis.y);
      const second = two.map(point => point.x * axis.x + point.y * axis.y);
      if (Math.max(...first) <= Math.min(...second) || Math.max(...second) <= Math.min(...first)) return false;
    }
    return true;
  }

  function layout(paths, project, size, options, measure) {
    const unit = Number.isFinite(options?.unit) && options.unit > 0 ? options.unit : 1;
    const baseSize = Number(options?.fontSize) > 0 ? Number(options.fontSize) : 15;
    const fallbackSize = Number(options?.fallbackFontSize) > 0 ? Number(options.fallbackFontSize) : 13;
    const priorityMinimumSize = Math.min(baseSize, fallbackSize,
      ...(options?.priorityFallbackSizes || []).filter(size => Number.isFinite(size) && size > 0 && size < fallbackSize));
    const maxLabels = Number(options?.maxLabelsPerName) > 0 ? Number(options.maxLabelsPerName) : 2;
    const halo = 1.8 * unit, padding = 2.5 * unit;
    const priorities = { "New Jersey Avenue": 100, "West Spruce Avenue": 95, "Central Avenue": 90,
      "New York Avenue": 85, "Delaware Avenue": 80, "Atlantic Avenue": 75, "Ocean Avenue": 70,
      "Surf Avenue": 65, "Anglesea Drive": 60 };
    const priority = name => priorities[name] || 0;
    const prepared = [];
    for (const path of paths) {
      const projected = path.coordinates.map(project);
      if (!projected.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
      const width = measure(path.text, baseSize * unit);
      if (!Number.isFinite(width) || width <= 0) continue;
      const shortestWidth = priority(path.name)
        ? measure(path.text.replace(/ Ave$/, ""),baseSize * unit) * priorityMinimumSize / baseSize : width;
      for (const points of visibleRuns(projected, size.x, size.y)) {
        const cumulative = [0];
        for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
        const length = cumulative[cumulative.length - 1];
        if (length < shortestWidth + 12 * unit) continue;
        prepared.push({ path, points, cumulative, length, width });
      }
    }
    prepared.sort((a, b) => priority(b.path.name) - priority(a.path.name) || b.length - a.length || a.path.name.localeCompare(b.path.name, "en"));
    const accepted = [];
    for (const item of prepared) {
      const { path, points, cumulative, length } = item;
      function at(distance) {
        let index = 1;
        while (index < cumulative.length - 1 && cumulative[index] < distance) index += 1;
        const span = cumulative[index] - cumulative[index - 1];
        const fraction = span ? (distance - cumulative[index - 1]) / span : 0;
        return { x: points[index - 1].x + (points[index].x - points[index - 1].x) * fraction,
          y: points[index - 1].y + (points[index].y - points[index - 1].y) * fraction };
      }
      // Curved main streets often have a useful straight stretch between the
      // obvious midpoint/quarter points. Search it before omitting the name;
      // a modest smaller fallback retains major-road orientation at wide views.
      const fractions = [0.5,0.3,0.7,0.15,0.85,0.4,0.6,0.25,0.75,0.2,0.8,0.1,0.9,0.45,0.55,0.35,0.65,0.05,0.95];
      let placed = false;
      const variants = [{ text: path.text, fontSize: baseSize * unit }];
      if (priority(path.name)) {
        variants.push({ text: path.text, fontSize: fallbackSize * unit });
        // The directional street name remains intact. Dropping only a standard
        // Avenue suffix can fit a short straight stretch on the northern spit.
        if (/ Ave$/.test(path.text)) variants.push({ text: path.text.replace(/ Ave$/, ""), fontSize: fallbackSize * unit });
        for (const size of options?.priorityFallbackSizes || []) {
          if (Number.isFinite(size) && size > 0 && size < fallbackSize) {
            variants.push({ text: path.text.replace(/ Ave$/, ""), fontSize: size * unit });
          }
        }
      }
      function place(text, fontSize, width, centerDistance) {
        const half = width / 2 + 2 * unit;
        if (centerDistance < half || centerDistance + half > length) return false;
        const startDistance = centerDistance - half, endDistance = centerDistance + half;
        const a = at(startDistance), b = at(endDistance), center = at(centerDistance);
        const chord = Math.hypot(b.x - a.x, b.y - a.y);
        if (chord < half * 2 * 0.97) return false;
        const samples = [a,b];
        for (let index = 1; index < points.length - 1; index += 1) if (cumulative[index] > startDistance && cumulative[index] < endDistance) samples.push(points[index]);
        const departure = Math.max(...samples.map(point => Math.abs((b.x - a.x) * (a.y - point.y) - (a.x - point.x) * (b.y - a.y)) / chord));
        if (departure > 2.5 * unit) return false;
        let angle = Math.atan2(b.y - a.y, b.x - a.x);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
        const box = corners(center.x, center.y, width + (halo + padding) * 2, fontSize * 1.15 + (halo + padding) * 2, angle);
        if (box.some(point => point.x < 3 * unit || point.y < 3 * unit || point.x > size.x - 3 * unit || point.y > size.y - 3 * unit)) return false;
        if (accepted.some(label => overlaps(label.box, box))) return false;
        if ((options?.obstacles || []).some(obstacle => overlaps(obstacle, box))) return false;
        const sameName = accepted.filter(label => label.name === path.name);
        if (sameName.length >= maxLabels || sameName.some(label => Math.hypot(label.x - center.x, label.y - center.y) < 420 * unit)) return false;
        accepted.push({ name: path.name, text, x: center.x, y: center.y, angle, width, fontSize, halo, box });
        return true;
      }
      // Keep every placement already found by the usual fractions and font
      // variants. Only an otherwise missing major street needs this extra work.
      for (const { text, fontSize } of variants) {
        const width = measure(text, baseSize * unit) * fontSize / (baseSize * unit);
        for (const fraction of fractions) if (place(text, fontSize, width, length * fraction)) { placed = true; break; }
        if (placed) break;
      }
      if (!placed && priority(path.name)) {
        for (const { text, fontSize } of variants) {
          const width = measure(text, baseSize * unit) * fontSize / (baseSize * unit), half = width / 2 + 2 * unit;
          if (half * 2 > length) continue;
          // Fonts available on another operating system can widen a name until
          // its eligible straight window falls between the fractional samples.
          // Try window ends at actual road vertices, then a bounded pixel grid;
          // every candidate still passes the same geometry and collision rules.
          const centers = new Set(cumulative.flatMap(distance => [distance, distance - half, distance + half]));
          const step = Math.max(unit, (length - half * 2) / 4096);
          for (let distance = half; distance <= length - half; distance += step) centers.add(distance);
          const ordered = [...centers].filter(distance => distance >= half && distance <= length - half)
            .sort((one,two) => Math.abs(one - length / 2) - Math.abs(two - length / 2) || one - two);
          for (const distance of ordered) if (place(text, fontSize, width, distance)) { placed = true; break; }
          if (placed) break;
        }
      }
    }
    return accepted;
  }

  function attach(map, options = {}) {
    if (mapLayers.has(map)) { const existing = mapLayers.get(map); existing.options = { ...existing.options, ...options }; existing._render(); return existing; }
    const leaflet = window.L || (typeof L !== "undefined" ? L : null);
    if (!leaflet?.Layer) throw new Error("The export street-name renderer is unavailable.");
    if (!CanvasLayer) CanvasLayer = leaflet.Layer.extend({
      initialize(settings) { this.options = settings; this._labels = []; },
      onAdd(currentMap) {
        this._map = currentMap;
        this._canvas = document.createElement("canvas");
        this._canvas.className = "nww-export-road-labels leaflet-layer";
        this._canvas.setAttribute("aria-hidden", "true");
        Object.assign(this._canvas.style, { position: "absolute", pointerEvents: "none" });
        currentMap.getPane(this.options.pane || "roadsPane").appendChild(this._canvas);
        currentMap.on("moveend zoomend resize", this._render, this);
        this._render();
      },
      onRemove(currentMap) { currentMap.off("moveend zoomend resize", this._render, this); this._canvas?.remove(); this._canvas = null; this._map = null; mapLayers.delete(currentMap); },
      getLabels() { return this._labels.map(label => ({ ...label, box: label.box.map(point => ({ ...point })) })); },
      _render() {
        if (!this._map || !this._canvas) return;
        const size = this._map.getSize();
        this._canvas.width = Math.max(1, Math.ceil(size.x));
        this._canvas.height = Math.max(1, Math.ceil(size.y));
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
        const canvasOrigin = this._map.containerPointToLayerPoint([0, 0]);
        leaflet.DomUtil.setPosition(this._canvas, canvasOrigin);
        const context = this._canvas.getContext("2d");
        this._labels = [];
        this._canvas.dataset.labelCount = "0";
        this._canvas.style.display = this.options.enabled === false ? "none" : "";
        if (!context || !roads || this.options.enabled === false) return;
        const family = this.options.fontFamily || getComputedStyle(document.documentElement).getPropertyValue("--nww-ui-font-family").trim() || FONT;
        const unit = Number.isFinite(this.options.unit) && this.options.unit > 0 ? this.options.unit : 1;
        context.font = `600 ${15 * unit}px ${family}`;
        // Retain subpixel road geometry so rounded vertices do not create artificial bends.
        const pixelOrigin = this._map.getPixelOrigin().add(canvasOrigin);
        const project = ([lng, lat]) => this._map.project([lat, lng]).subtract(pixelOrigin);
        this._labels = layout(roads, project, size, { ...this.options, unit }, (text, size) => {
          context.font = `600 ${size}px ${family}`;
          return context.measureText(text).width;
        });
        for (const label of this._labels) {
          context.save();
          context.translate(label.x, label.y);
          context.rotate(label.angle);
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.font = `600 ${label.fontSize}px ${family}`;
          context.lineJoin = "round";
          context.lineWidth = label.halo * 2;
          context.strokeStyle = "#ffffff";
          context.strokeText(label.text, 0, 0);
          context.fillStyle = "#152235";
          context.fillText(label.text, 0, 0);
          context.restore();
        }
        this._canvas.dataset.labelCount = String(this._labels.length);
        this._canvas.dataset.fontFamily = family;
      }
    });
    const layer = new CanvasLayer({ pane: "roadsPane", enabled: true, ...options });
    mapLayers.set(map, layer);
    layer.addTo(map);
    return layer;
  }

  function redraw(map, options = {}) {
    const layer = attach(map, options);
    return layer.getLabels();
  }

  function maskReferenceTile(context, coords, layer, rings) {
    if (!layer?._map || !Array.isArray(rings) || !rings.length) return false;
    const validRings = rings.filter(ring => Array.isArray(ring) && ring.length >= 3 && ring.every(latlng => {
      const lat = Array.isArray(latlng) ? latlng[0] : latlng?.lat;
      const lng = Array.isArray(latlng) ? latlng[1] : latlng?.lng;
      return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85.051129 && Math.abs(lng) <= 180;
    }));
    if (!validRings.length) return false;
    const size = layer.getTileSize();
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.fillStyle = "#000000";
    context.beginPath();
    for (const ring of validRings) {
      ring.forEach((latlng, index) => {
        const point = layer._map.project(latlng, coords.z);
        const x = point.x - coords.x * size.x, y = point.y - coords.y * size.y;
        if (index) context.lineTo(x, y); else context.moveTo(x, y);
      });
      context.closePath();
    }
    context.fill("evenodd");
    context.restore();
    return true;
  }

  window.NORTH_WILDWOOD_EXPORT_ROADS = Object.freeze({ load, attach, redraw, maskReferenceTile,
    hasLocalNames: () => Boolean(roads?.length), getAttribution: () => localRoadAttribution,
    geometry: Object.freeze({ buildPaths, labelName, layout, overlaps, corners, visibleRuns }) });
})();
