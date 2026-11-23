
    (function(){

      var root = document.documentElement;
      root.classList.remove("os-windows", "win-compact-ui");
      root.classList.add("os-mac", "platform-mac-template");
      root.style.removeProperty("--win-ui-zoom");
    })();

    // Shared by every layout controller. CSS uses the same condition.
    const floodmapperLayoutMedia = window.matchMedia("(max-width:900px), (max-height:560px), (max-height:560px) and (pointer:coarse), (max-width:1366px) and (any-pointer:coarse)");
    function isCompactFloodmapperLayout() {
      return floodmapperLayoutMedia.matches;
    }
  