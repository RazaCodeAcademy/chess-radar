// Inject Analyze + PiP into Chess.com's game control bar (play + post-game).
// Uses Chess.com icon-button classes + one custom tooltip (no title/data-tooltip duplicates).
(() => {
  window.__cfnToolsStop?.();
  document.querySelectorAll("#cfn-tools, #cfn-tools-slot, .cfn-tool, #cfn-tool-tip").forEach((el) => el.remove());

  const NATIVE_BTN_CLASSES = [
    "cc-icon-button-component",
    "cc-icon-button-small",
    "cc-icon-button-ghost",
    "cc-bg-ghost",
  ];

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
    return !!(el && (el.classList?.contains("cfn-tool") || el.id === "cfn-tool-tip"));
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

  function findControlBar() {
    const share = findByLabel(/share/);
    const add = findByLabel(/add to|library|collection|bookmark/);
    const flip =
      document.getElementById("board-controls-flip") ||
      findByLabel(/flip board|flip/);
    const rematch = findByLabel(/rematch|new game|resign/);

    const container =
      deepQueryAll(".game-icons-container-component")[0] ||
      deepQueryAll("[class*='game-icons-container']")[0] ||
      deepQueryAll(".board-controls-component")[0] ||
      (share && flip ? commonAncestor(share, flip) : null) ||
      (share && rematch ? commonAncestor(share, rematch) : null) ||
      share?.closest?.("[class*='icons'], [class*='controls']") ||
      null;

    if (share?.parentElement) {
      const group = share.parentElement;
      const natives = [...group.children].filter((el) => el.tagName === "BUTTON" && !isOurs(el));
      const hasFlip = natives.some((b) => /flip/.test(btnLabel(b)));
      if (!hasFlip || natives.length <= 4) {
        return {
          group,
          sample: natives[0] || share,
          after: add && natives.includes(add) ? add : natives[natives.length - 1] || share,
        };
      }
    }

    if (container) {
      const groups = [...container.querySelectorAll(":scope > *")];
      for (const g of groups) {
        const direct = [...g.children].filter((el) => el.tagName === "BUTTON" && !isOurs(el));
        const list = direct.length
          ? direct
          : [...g.querySelectorAll("button")].filter((el) => !isOurs(el));
        if (list.some((b) => /share/.test(btnLabel(b)))) {
          const addBtn = list.find((b) => /add to|library|collection/.test(btnLabel(b)));
          return {
            group: direct.length ? g : list[0].parentElement,
            sample: list[0],
            after: addBtn || list[list.length - 1],
          };
        }
      }

      const all = [...container.querySelectorAll("button")].filter((el) => !isOurs(el));
      if (all.length) {
        const shareBtn = all.find((b) => /share/.test(btnLabel(b))) || all[0];
        const group = shareBtn.parentElement;
        const siblings = [...group.children].filter((el) => el.tagName === "BUTTON" && !isOurs(el));
        return {
          group,
          sample: siblings[0] || shareBtn,
          after:
            siblings.find((b) => /add to|library|collection/.test(btnLabel(b))) ||
            siblings[siblings.length - 1] ||
            shareBtn,
        };
      }
    }

    if (flip?.parentElement) {
      const group = flip.parentElement;
      const natives = [...group.children].filter((el) => el.tagName === "BUTTON" && !isOurs(el));
      return { group, sample: natives[0] || flip, after: natives[natives.length - 1] || flip };
    }
    return null;
  }

  function tipPlacement(btn) {
    const r = btn.getBoundingClientRect();
    const parent = btn.parentElement?.getBoundingClientRect();
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

  function applyNativeButtonClasses(btn, sample) {
    const base = [];
    if (sample?.classList) {
      for (const c of sample.classList) {
        if (!c || c === "cfn-tool" || /^(active|selected|hover|open|is-)/i.test(c)) continue;
        base.push(c);
      }
    }
    for (const c of NATIVE_BTN_CLASSES) {
      if (!base.includes(c)) base.push(c);
    }
    if (!base.includes("cfn-tool")) base.push("cfn-tool");
    btn.className = base.join(" ");
  }

  function glyphSpanClass(sample) {
    const span =
      sample?.querySelector?.('span[class*="cc-icon-glyph"], span[class*="cc-icon-size"]') ||
      document.querySelector('.game-icons-container-component span[class*="cc-icon-glyph"]');
    return span?.getAttribute("class") || "cc-icon-glyph_a660c4b cc-icon-size-20_a660c4b";
  }

  // Match Chess.com: <span class="cc-icon-glyph_* cc-icon-size-20_*"><svg data-glyph ...><path d="..."></path></svg></span>
  function buildIconHtml(tool, sample) {
    const spanClass = glyphSpanClass(sample);
    const glyph = tool.glyph || tool.id || "custom";
    let pathD = tool.path || "";
    if (!pathD && tool.icon) {
      const m = String(tool.icon).match(/<path[^>]*\sd="([^"]+)"/i);
      pathD = m?.[1] || "";
    }
    if (!pathD) pathD = "m12 2 0 20";
    return `<span aria-hidden="true" class="${spanClass}"><svg data-glyph="${glyph}" aria-hidden="true" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${pathD}"></path></svg></span>`;
  }

  function ensureMounted() {
    if (![...tools.values()].some((t) => t.visible)) {
      for (const btn of buttons.values()) btn.remove();
      return false;
    }

    const row = findControlBar();
    if (!row?.group || !row.after) {
      for (const btn of buttons.values()) btn.remove();
      return false;
    }

    for (const btn of buttons.values()) applyNativeButtonClasses(btn, row.sample || row.after);

    let anchor = row.after;
    const visibleBtns = ["pip", "analyze"].map((id) => buttons.get(id)).filter((b) => b && !b.hidden);
    for (const btn of visibleBtns) {
      if (btn.parentElement !== row.group || btn.previousElementSibling !== anchor) {
        anchor.after(btn);
      }
      anchor = btn;
    }
    return true;
  }

  function ensureButton(tool) {
    const sample = findControlBar()?.sample;
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
    applyNativeButtonClasses(btn, sample);
    const text = tool.title || tool.label || tool.id;
    // Same as Chess.com: aria-label only (no title / data-tooltip — those duplicate tips).
    btn.removeAttribute("title");
    btn.removeAttribute("data-tooltip");
    btn.removeAttribute("data-tip");
    btn.setAttribute("aria-label", text);
    btn.hidden = !tool.visible;

    const spanClass = glyphSpanClass(sample);
    const iconKey = `${spanClass}|${tool.glyph || tool.id}|${tool.path || tool.icon || ""}`;
    if (btn.dataset.iconKey !== iconKey) {
      btn.dataset.iconKey = iconKey;
      btn.innerHTML = buildIconHtml(tool, sample);
    }
    return btn;
  }

  function render() {
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
    for (const m of mutations) {
      for (const n of [...m.addedNodes, ...m.removedNodes]) {
        if (n.nodeType === 1 && isOurs(n)) continue;
        scheduleMount();
        return;
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", () => {
    if (tipBtn) showTip(tipBtn, tipBtn.getAttribute("aria-label") || "");
    else hideTip();
  });
  setInterval(scheduleMount, 1200);
  scheduleMount();

  window.__cfnTools = api;
  window.__cfnToolsStop = () => {
    clearTimeout(mountTimer);
    clearTimeout(tipTimer);
    clearTimeout(tipClosing);
    mo.disconnect();
    hideTip();
    tip.remove();
    for (const btn of buttons.values()) btn.remove();
    tools.clear();
    buttons.clear();
    delete window.__cfnTools;
    delete window.__cfnToolsStop;
  };
})();
