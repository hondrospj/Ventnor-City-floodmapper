/* Focus containment for modal dialogs, including nested export warnings.
   The app owns opening/closing and Escape; this module owns keyboard isolation. */
(() => {
  "use strict";
  const selector = '[role="dialog"][aria-modal="true"]';
  const focusable = 'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
  const stack = [];
  const inertBefore = new Map();
  const restoreScopes = new WeakMap();
  let previousFocus = document.activeElement;
  let lastTrigger = null;
  let syncing = false;
  let pendingRestore = null;

  function visible(element) {
    return element.isConnected && !element.closest('[hidden],[aria-hidden="true"]') &&
      getComputedStyle(element).visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function restoreBackground() {
    for (const [element, value] of inertBefore) element.inert = value;
    inertBefore.clear();
  }

  function isolate(dialog) {
    for (let branch = dialog; branch && branch !== document.body; branch = branch.parentElement) {
      // A child can still carry inert from the previous modal's isolation
      // when its opening handler requests initial focus synchronously.
      if (branch.inert) {
        if (!inertBefore.has(branch)) inertBefore.set(branch, true);
        branch.inert = false;
      }
      for (const sibling of branch.parentElement?.children || []) {
        if (sibling === branch || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
        if (!inertBefore.has(sibling)) inertBefore.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
  }

  function controls(dialog) {
    return [...dialog.querySelectorAll(focusable)].filter(element => element.tabIndex >= 0 && visible(element) && !element.closest('[inert]'));
  }

  function focusFirst(dialog) {
    const target = controls(dialog)[0] || dialog;
    if (target === dialog && !dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  function rememberRestoreTarget(target) {
    const key = target.getAttribute("data-focus-restore-key");
    const scope = key && target.closest(".leaflet-popup,.maplibregl-popup");
    if (scope) restoreScopes.set(target, { key, scope });
    return target;
  }

  function currentRestoreTarget(target) {
    if (target.isConnected) return target;
    const saved = restoreScopes.get(target);
    if (!saved?.scope.isConnected) return target;
    // Animation refreshes popup contents while a property profile is open.
    // Return to the same property's current button in the original renderer.
    return [...saved.scope.querySelectorAll("[data-focus-restore-key]")]
      .find(element => element.getAttribute("data-focus-restore-key") === saved.key) || target;
  }

  function restoreFocus(targets) {
    const request = { targets, cancelled: false };
    pendingRestore = request;
    function attempt(framesLeft) {
      if (pendingRestore !== request) return;
      const dialog = stack.at(-1)?.dialog;
      const candidates = targets.map(currentRestoreTarget).flatMap(target => {
        // In compact layout, the Key can replace a hidden legend Help opener.
        const key = target.closest('#legendDock[tabindex="0"]');
        return key && key !== target ? [target, key] : [target];
      }).filter(target => (!dialog || dialog.contains(target)) && visible(target));
      const first = candidates[0];
      if ((request.cancelled || first?.closest('[inert]')) && framesLeft > 0) {
        // A drawer owner may restore its role and inert state in its next
        // layout pass. Keep its visible opener ahead of an outer fallback.
        // Cancelled moves retain only that fallback context for the same two
        // frames, so a restored parent can still return to its outer trigger.
        requestAnimationFrame(() => {
          if (pendingRestore !== request) return;
          sync();
          attempt(framesLeft - 1);
        });
        return;
      }
      if (request.cancelled) { pendingRestore = null; return; }
      const target = candidates.find(candidate => !candidate.closest('[inert]'));
      pendingRestore = null;
      target?.focus({ preventScroll: true });
    }
    attempt(2);
  }

  function sync(event) {
    if (syncing) return stack.at(-1)?.dialog;
    syncing = true;
    try {
      const dialogs = [...document.querySelectorAll(selector)].filter(visible);
      // The calendar acquires dialog semantics lazily when first opened.
      // Subscribe then as well, so closing it restores background interactivity.
      dialogs.forEach(watchDialog);
      const oldTop = stack.at(-1);
      let restoreTargets = [];
      while (stack.length && !dialogs.includes(stack.at(-1).dialog)) {
        restoreTargets = [...new Set([...restoreTargets, ...stack.pop().restore])];
      }
      // Remove closed lower dialogs without disturbing an open nested dialog.
      for (let index = stack.length - 1; index >= 0; index--) {
        if (!dialogs.includes(stack[index].dialog)) {
          const closed = stack[index];
          // A missing parent may be demoted while still visibly open, or may
          // really have closed. Preserve the child's specific opener and keep
          // the parent's trigger as a fallback to evaluate at final close.
          for (const child of stack.slice(index + 1)) {
            if (child.restore.some(target => closed.dialog.contains(target))) {
              child.restore = [...new Set([...child.restore, ...closed.restore])];
            }
          }
          stack.splice(index, 1);
        }
      }
      for (const dialog of dialogs) {
        if (stack.some(item => item.dialog === dialog)) continue;
        const pendingTargets = pendingRestore?.targets || [];
        // Reappearing parents inherit the outer fallback chain. An unrelated
        // new modal cancels the pending focus move while retaining fallbacks.
        if (pendingRestore && !pendingTargets.some(target => dialog.contains(target))) pendingRestore.cancelled = true;
        const parent = stack.at(-1)?.dialog;
        const opener = event?.detail?.opener;
        let candidate = previousFocus;
        if (opener && (!parent || parent.contains(opener)) && visible(opener)) candidate = opener;
        else if (!parent && lastTrigger && visible(lastTrigger)) candidate = lastTrigger;
        stack.push({ dialog, restore: [...new Set([
          ...(candidate && !dialog.contains(candidate) ? [rememberRestoreTarget(candidate)] : []), ...restoreTargets, ...pendingTargets
        ])] });
        lastTrigger = null;
      }
      const top = stack.at(-1);
      if (top !== oldTop) {
        restoreBackground();
        if (top) isolate(top.dialog);
        // Opening a child may demote its parent out of the aria-modal query.
        // Never restore that parent's trigger outside the newly active modal,
        // or replace focus that the user has already moved inside it.
        const focusedInside = top && top.dialog.contains(document.activeElement);
        if (!focusedInside && restoreTargets.length) restoreFocus(restoreTargets);
        if (top && !top.dialog.contains(document.activeElement)) focusFirst(top.dialog);
      }
      return top?.dialog;
    } finally {
      syncing = false;
    }
  }

  document.addEventListener("pointerdown", event => {
    if (pendingRestore) pendingRestore.cancelled = true;
    lastTrigger = event.target.closest('button,a[href],input,select,[tabindex]');
  }, true);
  document.addEventListener("focusin", event => {
    const dialog = sync();
    if (dialog && !dialog.contains(event.target)) focusFirst(dialog);
    previousFocus = document.activeElement;
  }, true);
  document.addEventListener("keydown", event => {
    if (pendingRestore) pendingRestore.cancelled = true;
    const dialog = sync();
    if (!dialog || event.key !== "Tab") return;
    const items = controls(dialog);
    const first = items[0], last = items.at(-1);
    if (!first) {
      event.preventDefault();
      focusFirst(dialog);
    } else if (!dialog.contains(document.activeElement) ||
      (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) ||
      (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }, true);
  const observer = new MutationObserver(sync);
  // App opening handlers can synchronize isolation before assigning initial
  // focus; MutationObserver remains the fallback for other modal changes.
  document.addEventListener("nww:modalchange", sync);
  // Observe the modal and its visibility-controlling ancestors, not map tiles
  // or frequently changing timeline content throughout the entire document.
  const targets = new Set();
  function watchDialog(dialog) {
    for (let element = dialog; element && element !== document.body; element = element.parentElement) {
      if (targets.has(element)) continue;
      targets.add(element);
      observer.observe(element, { attributes: true, attributeFilter: ["hidden", "class", "aria-hidden", "style", "role", "aria-modal"] });
    }
  }
  document.querySelectorAll(selector).forEach(watchDialog);
  sync();
})();
