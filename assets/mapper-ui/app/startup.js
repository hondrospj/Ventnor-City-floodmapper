
(() => {
  window.floodmapperUiLogoUrl = (value, configuredPath = value) => {
    if (!/(?:\/Logos\/ShorelySafe\.jpg|\/assets\/shorelysafe)(?:[?#].*)?$/i.test(String(configuredPath || ""))) return value;
    const path = "assets/shorelysafe-logo-ui.webp";
    const published = window.SHORELYSAFE_BUNNY_ASSETS;
    return published?.files?.[path] ? published.base + published.files[path] : value;
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
