// Inject Analyze + PiP into Chess.com's game control bar (play + post-game).
// Uses Chess.com icon-button classes + one custom tooltip (no title/data-tooltip duplicates).
(() => {
  window.__cfnToolsStop?.();
  document.querySelectorAll("#cfn-tools, #cfn-tools-slot, .cfn-tool, #cfn-tool-tip").forEach((el) => el.remove());

  let writing = false;
  let watchId = 0;
  const generation = (window.__cfnToolsGen || 0) + 1;
  window.__cfnToolsGen = generation;

  const tip = document.createElement("div");
  tip.id = "cfn-tool-tip";
  tip.setAttribute("role", "tooltip");
  tip.innerHTML = `<span class="cfn-tip-text"></span><span class="cfn-tip-arrow" aria-hidden="true"></span>`;
  const tipText = tip.querySelector(".cfn-tip-text");
  document.documentElement.append(tip);

  const tools = new Map();
  const buttons = new Map();
  let mountTimer = 0;
  let tipTimer = 0;
  let tipClosing = null;
  let tipBtn = null;

  function isOurs(el) {
    return !!(
      el &&
      (el.classList?.contains("cfn-tool") ||
        el.classList?.contains("cfn-tools-slot") ||
        el.id === "cfn-tool-tip" ||
        el.id === "cfn-tools-slot")
    );
  }

  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node?.querySelectorAll) return;
      try {
        out.push(...node.querySelectorAll(selector));
      } catch {
        // ignore
      }
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  function btnLabel(el) {
    return `${el?.getAttribute?.("aria-label") || ""} ${el?.getAttribute?.("title") || ""} ${el?.id || ""}`.toLowerCase();
  }

  function findByLabel(re) {
    return (
      deepQueryAll("button").find((el) => re.test(btnLabel(el))) ||
      deepQueryAll("[id^='board-controls-']").find((el) => re.test(btnLabel(el) + el.id))
    );
  }

  function commonAncestor(a, b) {
    if (!a || !b) return null;
    const seen = new Set();
    for (let n = a; n; n = n.parentElement) seen.add(n);
    for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
    return null;
  }

  function tabLabel(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Analysis / New Game / Games / Players. Not the board icon row.
  function tabBar() {
    const buttons = deepQueryAll("button");
    const analysis = buttons.find((el) => tabLabel(el) === "analysis");
    const other = buttons.find((el) => /^(new game|games|players)$/.test(tabLabel(el)));
    if (!analysis || !other) return null;
    return commonAncestor(analysis, other);
  }

  function isTabChrome(el, tabs = tabBar()) {
    if (!el || !tabs) return false;
    return el === tabs || tabs.contains(el);
  }

  function holdsTabs(el) {
    if (!el?.querySelectorAll) return false;
    let analysis = false;
    let other = false;
    for (const button of el.querySelectorAll("button")) {
      const label = tabLabel(button);
      if (label === "analysis") analysis = true;
      if (label === "new game" || label === "games" || label === "players") other = true;
    }
    return analysis && other;
  }

  function rowVisible(el) {
    if (!el?.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 70 && r.height >= 28 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function findControlBar() {
    const tabs = tabBar();
    const share = deepQueryAll("button").find((el) => /share/.test(btnLabel(el)) && !isTabChrome(el, tabs));
    const flip =
      document.getElementById("board-controls-flip") ||
      deepQueryAll("button").find((el) => /flip board|^flip$/.test(btnLabel(el)) && !isTabChrome(el, tabs));
    const rematch = deepQueryAll("button").find(
      (el) => /rematch|resign/.test(btnLabel(el)) && !isTabChrome(el, tabs)
    );

    const accept = (group, sample) => {
      if (!group || isTabChrome(group, tabs) || holdsTabs(group) || !rowVisible(group)) return null;
      return { group, sample };
    };

    const iconRows = deepQueryAll(
      ".game-icons-container-component, [class*='game-icons-container'], .board-controls-component"
    );
    const nearShare = share?.closest?.(
      ".game-icons-container-component, [class*='game-icons-container'], .board-controls-component"
    );
    for (const row of [nearShare, ...iconRows]) {
      const hit = accept(row, share || flip);
      if (hit) return hit;
    }

    const container =
      (share && flip ? commonAncestor(share, flip) : null) ||
      (share && rematch ? commonAncestor(share, rematch) : null) ||
      share?.closest?.("[class*='icons'], [class*='controls']") ||
      null;

    if (container && !isTabChrome(container, tabs)) {
      const groups = [...container.querySelectorAll(":scope > *")];
      for (const g of groups) {
        const direct = [...g.children].filter((el) => el.tagName === "BUTTON" && !isOurs(el));
        const list = direct.length
          ? direct
          : [...g.querySelectorAll("button")].filter((el) => !isOurs(el));
        if (list.some((b) => /share/.test(btnLabel(b)))) {
          const hit = accept(direct.length ? g : list[0].parentElement, list[0]);
          if (hit) return hit;
        }
      }
      const hit = accept(share?.parentElement, share);
      if (hit) return hit;
    }

    return accept(flip?.parentElement, flip);
  }

  function tipPlacement(btn) {
    const r = btn.getBoundingClientRect();
    const parent = (btn.closest(".cfn-tools-slot")?.parentElement || btn.parentElement)?.getBoundingClientRect();
    const parentWide = !!(parent && parent.width > parent.height * 1.6);
    const nearBottom = r.top > window.innerHeight * 0.55;
    const nearLeftEdge = r.left < 120;
    if (!parentWide && nearLeftEdge && !nearBottom) return "right";
    return "above";
  }

  function syncTipTheme() {
    const root = getComputedStyle(document.documentElement);
    const bg = root.getPropertyValue("--cc-tooltip").trim();
    const fg = root.getPropertyValue("--cc-tooltip-foreground").trim();
    if (bg) tip.style.setProperty("--cfn-tip-bg", bg);
    if (fg) tip.style.setProperty("--cfn-tip-fg", fg);
  }

  function placeTip(btn, place) {
    const r = btn.getBoundingClientRect();
    const pad = 8;
    const gap = 10;
    tip.style.visibility = "hidden";
    tip.classList.add("is-on");
    const tw = Math.max(tip.offsetWidth, 1);
    const th = Math.max(tip.offsetHeight, 1);
    if (place === "right") {
      tip.style.left = `${Math.min(window.innerWidth - tw - pad, r.right + gap)}px`;
      tip.style.top = `${Math.max(pad, Math.min(window.innerHeight - th - pad, r.top + r.height / 2 - th / 2))}px`;
    } else {
      let left = r.left + r.width / 2 - tw / 2;
      left = Math.max(pad, Math.min(window.innerWidth - tw - pad, left));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(pad, r.top - th - gap)}px`;
    }
    tip.style.visibility = "";
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipBtn = null;
    if (!tip.classList.contains("is-on") || tip.classList.contains("is-exit")) return;
    tip.classList.remove("is-enter");
    tip.classList.add("is-exit");
    clearTimeout(tipClosing);
    tipClosing = setTimeout(() => {
      tip.classList.remove("is-on", "is-above", "is-right", "is-exit", "is-enter");
      if (tipText) tipText.textContent = "";
      tipClosing = null;
    }, 100);
  }

  function showTip(btn, text) {
    clearTimeout(tipTimer);
    clearTimeout(tipClosing);
    tipClosing = null;
    if (!text || !btn?.isConnected) return hideTip();

    tipBtn = btn;
    syncTipTheme();
    if (tipText) tipText.textContent = text;

    let place = tipPlacement(btn);
    tip.classList.remove("is-exit", "is-enter", "is-above", "is-right");
    tip.classList.add("is-on", place === "right" ? "is-right" : "is-above");
    placeTip(btn, place);

    if (place === "right" && tip.getBoundingClientRect().right > window.innerWidth - 8) {
      place = "above";
      tip.classList.remove("is-right");
      tip.classList.add("is-above");
      placeTip(btn, place);
    }

    void tip.offsetWidth;
    tip.classList.add("is-enter");
  }

  function bindTip(btn) {
    if (btn.dataset.cfnTipBound) return;
    btn.dataset.cfnTipBound = "1";
    btn.addEventListener("mouseenter", () => {
      tipTimer = setTimeout(() => showTip(btn, btn.getAttribute("aria-label") || ""), 250);
    });
    btn.addEventListener("mouseleave", hideTip);
    btn.addEventListener("focus", () => showTip(btn, btn.getAttribute("aria-label") || ""));
    btn.addEventListener("blur", hideTip);
    btn.addEventListener("click", hideTip);
  }

  function applyButtonFace(btn) {
    const next = "cfn-tool";
    if (btn.className !== next) btn.className = next;
  }

  function buildIconHtml(tool) {
    const glyph = tool.glyph || tool.id || "custom";
    let pathD = tool.path || "";
    if (!pathD && tool.icon) {
      const m = String(tool.icon).match(/<path[^>]*\sd="([^"]+)"/i);
      pathD = m?.[1] || "";
    }
    if (!pathD) pathD = "m12 2 0 20";
    return `<span aria-hidden="true" class="cfn-glyph"><svg data-glyph="${glyph}" aria-hidden="true" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#ffffff" d="${pathD}"></path></svg></span>`;
  }

  function orderedButtons() {
    const preferred = ["pip", "analyze"].map((id) => buttons.get(id)).filter((b) => b && !b.hidden);
    const rest = [...buttons.values()].filter((b) => !b.hidden && !preferred.includes(b));
    return [...preferred, ...rest];
  }

  function removeStrays() {
    const owned = new Set(buttons.values());
    for (const el of deepQueryAll("button.cfn-tool, .cfn-tool")) {
      if (el.tagName !== "BUTTON") continue;
      if (!owned.has(el)) el.remove();
    }
    const slots = deepQueryAll("#cfn-tools-slot, .cfn-tools-slot");
    const keep = slots.find((el) => el.id === "cfn-tools-slot") || slots[0] || null;
    for (const el of slots) {
      if (el !== keep) el.remove();
    }
    return keep;
  }

  function releaseShift() {
    for (const el of document.querySelectorAll("[data-cfn-shift]")) {
      el.style.marginTop = "";
      el.removeAttribute("data-cfn-shift");
    }
  }

  function clearPark(slot) {
    slot.classList.remove("is-parked", "is-mobile");
    slot.style.position = "";
    slot.style.top = "";
    slot.style.left = "";
    slot.style.right = "";
    slot.style.width = "";
    releaseShift();
  }

  function boardNode() {
    return (
      document.querySelector("wc-chess-board, chess-board") ||
      document.getElementById("board-layout-chessboard")
    );
  }

  function boxVisible(el) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 24 && r.height > 14 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function isMobileLayout(boardRect) {
    if (window.matchMedia("(max-width: 820px)").matches) return true;
    const tabs = tabBar()?.getBoundingClientRect();
    return !!(boardRect && tabs && tabs.top > boardRect.bottom - 12);
  }

  // The clock above the board. Fall back to any visible clock.
  function clockBeside(boardRect) {
    const clocks = deepQueryAll(".clock-component, [class*='clock-component']").filter(boxVisible);
    const above = clocks.filter((el) => el.getBoundingClientRect().bottom <= boardRect.top + 36);
    const pool = above.length ? above : clocks;
    pool.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return pool[0] || null;
  }

  function syncLabel(btn, text) {
    let label = btn.querySelector(".cfn-tool-label");
    if (!label) {
      label = document.createElement("span");
      label.className = "cfn-tool-label";
      btn.append(label);
    }
    if (label.textContent !== text) label.textContent = text;
  }

  // Desktop: icon buttons immediately left of the clock.
  // Mobile: labeled buttons in the strip under the name and clock.
  // The short row of Analysis / New Game / Games / Players, not the whole sidebar.
  function tabStrip() {
    const buttons = deepQueryAll("button, [role='tab'], a");
    const analysis = buttons.find((el) => tabLabel(el) === "analysis");
    const newer = buttons.find((el) => tabLabel(el) === "new game");
    if (!analysis || !newer) return null;
    let strip = analysis;
    while (strip.parentElement && !strip.contains(newer)) strip = strip.parentElement;
    while (strip.parentElement) {
      const parent = strip.parentElement;
      const stripBox = strip.getBoundingClientRect();
      const parentBox = parent.getBoundingClientRect();
      if (parentBox.height > stripBox.height + 48) break;
      strip = parent;
    }
    return strip;
  }

  function parkMobile(slot) {
    releaseShift();
    slot.style.position = "relative";
    slot.style.top = "auto";
    slot.style.left = "auto";
    slot.style.right = "auto";
    slot.style.width = "100%";
    slot.style.order = "-1";
    slot.style.flex = "0 0 auto";
    slot.style.gridColumn = "1 / -1";

    const strip = tabStrip();
    const sidebar = document.getElementById("board-layout-sidebar");
    const player = document.getElementById("board-layout-player-bottom");
    const sidebarIsBelowPlayer = sidebar && (!player || !sidebar.contains(player));
    const host = sidebarIsBelowPlayer ? sidebar : strip?.parentElement;
    if (!host) return;
    const before = sidebarIsBelowPlayer ? [...host.children].find((el) => el !== slot) || null : strip;
    if (slot.parentElement !== host || slot.nextElementSibling !== before) host.insertBefore(slot, before);

    if (!strip || strip === slot) return;
    const overlap = Math.ceil(slot.getBoundingClientRect().bottom - strip.getBoundingClientRect().top);
    if (overlap > 0) {
      strip.style.marginTop = `${overlap + 8}px`;
      strip.dataset.cfnShift = "1";
    }
  }

  function park(slot) {
    const board = boardNode();
    const r = board?.getBoundingClientRect();
    const mobile = isMobileLayout(r);
    slot.classList.add("is-parked");
    slot.classList.toggle("is-mobile", mobile);
    if (mobile) {
      parkMobile(slot);
      return;
    }

    releaseShift();
    if (slot.parentElement !== document.documentElement) document.documentElement.append(slot);
    slot.style.position = "";
    slot.style.right = "auto";
    slot.style.width = "";
    slot.style.order = "";
    slot.style.flex = "";
    slot.style.gridColumn = "";

    if (!r || r.width < 80) {
      slot.style.top = "72px";
      slot.style.left = "16px";
      return;
    }

    const clock = clockBeside(r);
    const width = Math.max(slot.offsetWidth, 70);
    if (clock) {
      const c = clock.getBoundingClientRect();
      slot.style.top = `${Math.round(c.top + Math.max(0, (c.height - 32) / 2))}px`;
      slot.style.left = `${Math.round(Math.max(8, c.left - width - 8))}px`;
      return;
    }
    slot.style.top = `${Math.round(Math.max(8, r.top - 40))}px`;
    slot.style.left = `${Math.round(r.left + r.width / 2 - width - 8)}px`;
  }

  function ensureMounted() {
    const ordered = orderedButtons();
    let slot = removeStrays();

    if (!ordered.length) {
      slot?.remove();
      return false;
    }

    if (!slot) {
      slot = document.createElement("span");
      slot.id = "cfn-tools-slot";
      slot.className = "cfn-tools-slot";
    }
    ordered.forEach((btn, index) => {
      if (slot.children[index] !== btn) slot.append(btn);
    });
    for (const btn of [...slot.children]) {
      if (!ordered.includes(btn)) btn.remove();
    }
    park(slot);
    return true;
  }

  function ensureButton(tool) {
    let btn = buttons.get(tool.id);
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.id = tool.id;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        tools.get(tool.id)?.onClick?.();
      });
      bindTip(btn);
      buttons.set(tool.id, btn);
    }
    applyButtonFace(btn);
    const text = tool.title || tool.label || tool.id;
    // Same as Chess.com: aria-label only (no title / data-tooltip — those duplicate tips).
    btn.removeAttribute("title");
    btn.removeAttribute("data-tooltip");
    btn.removeAttribute("data-tip");
    btn.setAttribute("aria-label", text);
    btn.hidden = !tool.visible;

    const iconKey = `${tool.glyph || tool.id}|${tool.path || tool.icon || ""}`;
    if (btn.dataset.iconKey !== iconKey) {
      btn.dataset.iconKey = iconKey;
      btn.innerHTML = buildIconHtml(tool);
    }
    syncLabel(btn, text);
    return btn;
  }

  function render() {
    if (writing || window.__cfnToolsGen !== generation) return;
    writing = true;
    try {
      renderNow();
    } finally {
      writing = false;
    }
  }

  function renderNow() {
    const visible = [...tools.values()].filter((t) => t.visible);
    const keep = new Set(visible.map((t) => t.id));
    for (const [id, btn] of buttons) {
      if (!keep.has(id)) {
        btn.remove();
        buttons.delete(id);
      }
    }
    for (const id of ["pip", "analyze"]) {
      const tool = tools.get(id);
      if (tool?.visible) ensureButton(tool);
    }
    for (const tool of visible) {
      if (tool.id === "pip" || tool.id === "analyze") continue;
      ensureButton(tool);
    }
    ensureMounted();
  }

  function scheduleMount() {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(render, 50);
  }

  const api = {
    upsert(tool) {
      if (!tool?.id) return;
      const prev = tools.get(tool.id) || {};
      tools.set(tool.id, {
        id: tool.id,
        label: tool.label ?? prev.label ?? tool.id,
        title: tool.title ?? prev.title ?? tool.label ?? tool.id,
        icon: tool.icon ?? prev.icon ?? "",
        path: tool.path ?? prev.path ?? "",
        glyph: tool.glyph ?? prev.glyph ?? tool.id,
        accent: tool.accent ?? prev.accent ?? "default",
        visible: tool.visible ?? prev.visible ?? false,
        active: tool.active ?? prev.active ?? false,
        onClick: tool.onClick ?? prev.onClick,
      });
      render();
    },
    setVisible(id, visible) {
      const tool = tools.get(id);
      if (!tool) return;
      tool.visible = !!visible;
      render();
    },
    setActive(id, active) {
      const tool = tools.get(id);
      if (!tool) return;
      tool.active = !!active;
      render();
    },
    setPanelOpen() {},
    remove(id) {
      tools.delete(id);
      buttons.get(id)?.remove();
      buttons.delete(id);
      render();
    },
  };

  const mo = new MutationObserver((mutations) => {
    if (writing || window.__cfnToolsGen !== generation) return;
    for (const m of mutations) {
      for (const n of [...m.addedNodes, ...m.removedNodes]) {
        if (n.nodeType !== 1) continue;
        if (isOurs(n)) {
          if (n.tagName === "BUTTON" && n.classList?.contains("cfn-tool") && buttons.get(n.dataset.id) !== n) n.remove();
          continue;
        }
        scheduleMount();
        return;
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", () => {
    hideTip();
    const slot = document.getElementById("cfn-tools-slot");
    if (slot?.classList.contains("is-parked")) park(slot);
  }, true);
  window.addEventListener("resize", () => {
    const slot = document.getElementById("cfn-tools-slot");
    if (slot?.classList.contains("is-parked")) park(slot);
    if (tipBtn) showTip(tipBtn, tipBtn.getAttribute("aria-label") || "");
    else hideTip();
  });
  watchId = setInterval(() => {
    if (window.__cfnToolsGen !== generation) return;
    const slot = deepQueryAll("#cfn-tools-slot")[0];
    const extras = deepQueryAll("button.cfn-tool").length > buttons.size;
    const misplaced = [...buttons.values()].some(
      (btn) => btn.isConnected && !btn.hidden && btn.parentElement !== slot
    );
    if (!slot?.isConnected || extras || misplaced) scheduleMount();
  }, 1500);
  scheduleMount();

  window.__cfnTools = api;
  window.__cfnToolsStop = () => {
    window.__cfnToolsGen = (window.__cfnToolsGen || generation) + 1;
    clearInterval(watchId);
    clearTimeout(mountTimer);
    clearTimeout(tipTimer);
    clearTimeout(tipClosing);
    mo.disconnect();
    hideTip();
    tip.remove();
    releaseShift();
    for (const el of deepQueryAll("#cfn-tools-slot, .cfn-tools-slot, button.cfn-tool, .cfn-tool")) el.remove();
    for (const btn of buttons.values()) btn.remove();
    tools.clear();
    buttons.clear();
    delete window.__cfnTools;
    delete window.__cfnToolsStop;
  };
})();
