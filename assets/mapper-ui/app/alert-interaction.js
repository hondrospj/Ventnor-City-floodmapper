
(function(){
  "use strict";

  function dismissBanner(){
    var banner = document.getElementById("topBanner");
    if (!banner) return;

    if (typeof window.clearTopBanner === "function") {
      window.clearTopBanner();
    } else {
      banner.classList.remove("alert");
    }

    if (banner.classList.contains("alert")) {
      banner.classList.remove("alert");
    }

    banner.setAttribute("aria-hidden", "true");
    banner.removeAttribute("role");
    banner.removeAttribute("tabindex");
  }

  function syncBannerAccessibility(){
    var banner = document.getElementById("topBanner");
    if (!banner) return;
    if (banner.classList.contains("alert")) {
      banner.removeAttribute("aria-hidden");
      banner.setAttribute("role", "button");
      banner.setAttribute("tabindex", "0");
      banner.setAttribute("aria-label", "Dismiss flood alert");
    } else {
      banner.setAttribute("aria-hidden", "true");
      banner.removeAttribute("role");
      banner.removeAttribute("tabindex");
    }
  }

  function wireBanner(){
    var banner = document.getElementById("topBanner");
    if (!banner || banner.dataset.pjDismissPillWired === "1") return;
    banner.dataset.pjDismissPillWired = "1";

    banner.addEventListener("click", function(e){
      if (!banner.classList.contains("alert")) return;
      if (e.target && e.target.closest && e.target.closest("#topBannerCloseBtn")) return;
      e.preventDefault();
      e.stopPropagation();

      var closeBtn = document.getElementById("topBannerCloseBtn");
      if (closeBtn) closeBtn.click();
      if (banner.classList.contains("alert")) dismissBanner();
    });

    banner.addEventListener("keydown", function(e){
      if (!banner.classList.contains("alert")) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      dismissBanner();
    });

    var closeBtn = document.getElementById("topBannerCloseBtn");
    if (closeBtn && closeBtn.dataset.pjDismissPillWired !== "1") {
      closeBtn.dataset.pjDismissPillWired = "1";
      closeBtn.addEventListener("click", function(){
        window.setTimeout(syncBannerAccessibility, 0);
      });
    }

    syncBannerAccessibility();

    try {
      var mo = new MutationObserver(syncBannerAccessibility);
      mo.observe(banner, { attributes:true, attributeFilter:["class"] });
    } catch(e) {}
  }

  function boot(){
    wireBanner();
    syncBannerAccessibility();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once:true });
  } else {
    boot();
  }
  window.addEventListener("load", boot, { once:true });
})();
