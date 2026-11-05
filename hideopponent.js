// Blur the opponent's name, rating, flag, and avatar on Chess.com.
// Your own player row stays clear. Clocks are not blurred.
(() => {
  window.__cfnHideOpponentStop?.();
  document.getElementById("cfn-hide-opponent-style")?.remove();
  document.querySelectorAll(".cfn-hide-opponent").forEach((el) => el.classList.remove("cfn-hide-opponent"));

  const norm = (s) => String(s || "").trim().toLowerCase();
  let settings = { username: "", hideOpponent: false };
  let timer = 0;
  let watchId = 0;

  const style = document.createElement("style");
  style.id = "cfn-hide-opponent-style";
  document.documentElement.append(style);

  chrome.storage.local.get("settings").then(({ settings: s = {} }) => {
    settings = { ...settings, ...s };
    apply();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    settings = { ...settings, ...(changes.settings.newValue || {}) };
    apply();
  });

  function memberSlug(root) {
    const link = root.querySelector?.("a[href*='/member/']");
    const href = link?.getAttribute?.("href") || "";
    const fromHref = href.match(/\/member\/([^/?#"']+)/i)?.[1];
    if (fromHref) return norm(fromHref);
    const el = root.querySelector?.(".cc-user-username-component, [data-test-element='user-tagline-username']");
    return norm((el?.textContent || "").replace(/\s*\([^)]*\)\s*$/, ""));
  }

  function playerRows() {
    const rows = [
      ...document.querySelectorAll(
        "#board-layout-player-top, #board-layout-player-bottom, .player-game-over-component, .game-over-modal-component .player-component"
      ),
    ];
    if (rows.length) return rows;
    return [...document.querySelectorAll(".player-component")].filter((el) => memberSlug(el));
  }

  function hasClock(el) {
    return !!el?.querySelector?.(".clock-component, [class*='clock-component'], [class*='clock-time']");
  }

  // Largest box around the name that still does not include the clock.
  function identityRoot(row) {
    const seed =
      row.querySelector(".user-tagline-component") ||
      row.querySelector(".cc-user-username-component, [data-test-element='user-tagline-username']") ||
      row.querySelector("a[href*='/member/']");
    if (!seed) return null;
    let el = seed;
    while (el.parentElement && el.parentElement !== row && row.contains(el.parentElement)) {
      const parent = el.parentElement;
      if (hasClock(parent) && !hasClock(el)) break;
      el = parent;
    }
    if (hasClock(el)) return seed;
    return el;
  }

  function focusName() {
    const watched = norm(new URLSearchParams(location.search).get("cfn") || "");
    return watched || norm(settings.username);
  }

  function opponents() {
    const named = playerRows()
      .map((row) => ({ row, slug: memberSlug(row) }))
      .filter((item) => item.slug);
    const focus = focusName();
    if (!focus) return named;
    const mine = named.some((item) => item.slug === focus);
    if (!mine) return named;
    return named.filter((item) => item.slug !== focus);
  }

  function cssFor(slug) {
    const safe = slug.replace(/[^a-z0-9_-]/gi, "");
    if (!safe) return "";
    const href = `[href*="/member/${safe}" i]`;
    return `
      .cc-user-block-component:has(${href}):not(:has(.clock-component)),
      .user-tagline-component:has(${href}):not(:has(.clock-component)):not(.cc-user-block-component .user-tagline-component),
      a.cc-avatar-component${href}:not(.user-tagline-component a):not(.cc-user-block-component a),
      .cc-avatar-component:has(${href}):not(.user-tagline-component .cc-avatar-component):not(.cc-user-block-component .cc-avatar-component) {
        filter: blur(8px) !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        pointer-events: none !important;
      }
    `;
  }

  function apply() {
    document.querySelectorAll(".cfn-hide-opponent").forEach((el) => el.classList.remove("cfn-hide-opponent"));
    if (!settings.hideOpponent) {
      style.textContent = "";
      return;
    }
    const list = opponents();
    style.textContent = list.map((item) => cssFor(item.slug)).join("\n");
    for (const item of list) {
      const node = identityRoot(item.row);
      if (node) node.classList.add("cfn-hide-opponent");
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(apply, 40);
  }

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  watchId = setInterval(apply, 1000);
  window.addEventListener("popstate", schedule);
  apply();

  window.__cfnHideOpponentStop = () => {
    clearTimeout(timer);
    clearInterval(watchId);
    mo.disconnect();
    window.removeEventListener("popstate", schedule);
    style.remove();
    document.querySelectorAll(".cfn-hide-opponent").forEach((el) => el.classList.remove("cfn-hide-opponent"));
    delete window.__cfnHideOpponentStop;
  };
})();
