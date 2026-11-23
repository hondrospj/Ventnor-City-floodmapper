const FLOODMAPPER_TOWN_DATA = JSON.parse(document.getElementById('floodmapperTownData').content.textContent);

(() => {
  window.floodmapperUiLogoUrl = (value, configuredPath = value) => {
    if (!/(?:\/Logos\/ShorelySafe\.jpg|\/assets\/shorelysafe)(?:[?#].*)?$/i.test(String(configuredPath || ""))) return value;
    const path = "assets/shorelysafe-logo-ui.webp";
    const published = window.SHORELYSAFE_BUNNY_ASSETS;
    if (published?.files?.[path]) return published.base + published.files[path];
    const fallback = FLOODMAPPER_TOWN_DATA.assets?.localBrandFallbackPath;
    return fallback ? new URL(fallback, window.location.href).href : value;
  };
  window.floodmapperAfterFirstFrame = task => {
    const deadline = performance.now() + 15000;
    const check = () => {
      const image = typeof currentFloodLayer === "undefined" ? null : currentFloodLayer?._image;
      if (image?.complete && image.naturalWidth || performance.now() >= deadline) {
        requestAnimationFrame(() => requestAnimationFrame(task));
      } else setTimeout(check, 50);
    };
    check();
  };
})();
