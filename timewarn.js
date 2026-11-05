// Visual Time Warning: glowing board border when you're up or down on the clock.
// On a normal game the ring sits behind the board. In Focus / Theatre mode
// and inside Document PiP it is pinned to the viewport so it stays visible.
(() => {
  window.__cfnTimeWarnStop?.();
  for (const d of [document]) {
    d.querySelectorAll("#cfn-timewarn").forEach((el) => el.remove());
  }
  try {
    window.documentPictureInPicture?.window?.document
      ?.querySelectorAll?.("#cfn-timewarn")
      ?.forEach((el) => el.remove());
  } catch {
    // ignore
  }

  const EVEN_MS = 1500;
  const URGENT_MS = 10000;

  let settings = { username: "", timeWarning: true };
  let raf = 0;
  let ring = null;
  let ringDoc = null;
  let hostWePositioned = null;

  chrome.storage.local.get("settings").then(({ settings: s = {} }) => {
    settings = { ...settings, ...s };
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    settings = { ...settings, ...changes.settings.newValue };
    if (settings.timeWarning === false) hide();
  });

  const norm = (s) => String(s || "").trim().toLowerCase();

  function docs() {
    const out = [document];
    try {
      const w = window.documentPictureInPicture?.window;
      if (w && !w.closed && w.document) out.push(w.document);
    } catch {
      // ignore
    }
    return out;
  }

  function onGamePage() {
    return (
      /\/(?:game|play\/)/.test(location.pathname) ||
      docs().some((d) => d.querySelector("wc-chess-board, chess-board, #board-layout-chessboard, .board"))
    );
  }

  function findBoard(doc) {
    return (
      doc.querySelector("wc-chess-board.board, chess-board.board, wc-chess-board, chess-board") ||
      doc.querySelector("#board-layout-chessboard .board, #board-layout-chessboard") ||
      doc.querySelector(".board") ||
      null
    );
  }

  function activeBoard() {
    // Prefer the PiP board when PiP is open.
    const list = docs();
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      const b = findBoard(d);
      if (b?.isConnected) {
        const r = b.getBoundingClientRect();
        if (r.width > 40 && r.height > 40) return { board: b, doc: d };
      }
    }
    return null;
  }

  function playerRoot(doc, side) {
    return (
      doc.getElementById(`board-layout-player-${side}`) ||
      doc.querySelector(`#board-layout-player-${side}`) ||
      doc.querySelector(`[class*="player-${side}"]`) ||
      doc.querySelector(`#player-${side}`)
    );
  }

  function playerName(doc, side) {
    const root = playerRoot(doc, side);
    if (!root) return "";
    const el =
      root.querySelector(".cc-user-username-component, [data-test-element='user-tagline-username']") ||
      root.querySelector("a[href*='/member/']") ||
      root.querySelector("[class*='username']");
    const href = el?.getAttribute?.("href") || "";
    const fromHref = href.match(/\/member\/([^/?#]+)/)?.[1];
    return norm(fromHref || el?.textContent);
  }

  function clockText(doc, side) {
    const root = playerRoot(doc, side);
    const scopes = [root, doc].filter(Boolean);
    for (const scope of scopes) {
      const el =
        scope.querySelector?.(`#board-layout-player-${side} .clock-time-monospace`) ||
        (scope === root &&
          (root.querySelector(".clock-time-monospace") ||
            root.querySelector("[class*='clock-time']") ||
            root.querySelector(".clock-component") ||
            root.querySelector("[class*='clock']"))) ||
        null;
      const text = (el?.textContent || "").replace(/\s+/g, " ").trim();
      if (text && /\d:\d/.test(text)) return text;
    }
    // Focus mode sometimes keeps clocks near the board without the usual wrappers.
    const clocks = [...doc.querySelectorAll(".clock-time-monospace, [class*='clock-time']")];
    if (clocks.length >= 2) {
      const top = playerRoot(doc, "top");
      const bottom = playerRoot(doc, "bottom");
      const pick = side === "top" ? clocks[0] : clocks[clocks.length - 1];
      // Prefer clock that lives under the matching player root when possible.
      for (const c of clocks) {
        if (side === "top" && top?.contains(c)) return c.textContent.replace(/\s+/g, " ").trim();
        if (side === "bottom" && bottom?.contains(c)) return c.textContent.replace(/\s+/g, " ").trim();
      }
      return (pick.textContent || "").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  function parseClockMs(text) {
    const s = String(text || "").replace(/[^\d:.]/g, "");
    if (!s || !s.includes(":")) return null;
    const parts = s.split(":");
    let h = 0;
    let m = 0;
    let rest = "0";
    if (parts.length === 3) {
      h = Number(parts[0]) || 0;
      m = Number(parts[1]) || 0;
      rest = parts[2];
    } else if (parts.length === 2) {
      m = Number(parts[0]) || 0;
      rest = parts[1];
    } else {
      return null;
    }
    const [secStr, frac = "0"] = rest.split(".");
    const sec = Number(secStr) || 0;
    const ms = Math.round(Number(`0.${frac.slice(0, 3).padEnd(3, "0")}`) * 1000) || 0;
    return (h * 3600 + m * 60 + sec) * 1000 + ms;
  }

  function pageUsername() {
    try {
      const fromWin =
        window.chesscom?.user?.username ||
        window.chesscom?.username ||
        window.chesscom?.context?.user?.username;
      if (fromWin) return norm(fromWin);
    } catch {
      // isolated world may not see page globals
    }
    const el = document.querySelector("[data-username], [data-user-username], a.user-username-component");
    const attr = el?.getAttribute?.("data-username") || el?.getAttribute?.("data-user-username");
    if (attr) return norm(attr);
    return "";
  }

  function mySide(doc, me) {
    if (!me) return "";
    if (playerName(doc, "bottom") === me) return "bottom";
    if (playerName(doc, "top") === me) return "top";
    return "";
  }

  function boardRect(board) {
    // Prefer the visible piece layer / board face if present.
    const face =
      board.querySelector?.(".board, [class*='board-graph']") ||
      (board.classList?.contains("board") ? board : null) ||
      board;
    const r = face.getBoundingClientRect();
    if (!r?.width || !r?.height) return null;
    const size = Math.min(r.width, r.height);
    // If the element is already square-ish, use it directly.
    if (Math.abs(r.width - r.height) < 4) {
      return { left: r.left, top: r.top, size: r.width };
    }
    return {
      left: r.left + (r.width - size) / 2,
      top: r.top + (r.height - size) / 2,
      size,
    };
  }

  function releaseHost() {
    if (!hostWePositioned) return;
    hostWePositioned.style.position = "";
    hostWePositioned = null;
  }

  function ensureRing(doc) {
    if (!ring || ringDoc !== doc || !ring.isConnected) {
      releaseHost();
      ring?.remove?.();
      ring = doc.createElement("div");
      ring.id = "cfn-timewarn";
      ring.setAttribute("aria-hidden", "true");
      ringDoc = doc;
      (doc.body || doc.documentElement).append(ring);
    }
    return ring;
  }

  function hide() {
    if (!ring) return;
    ring.className = "";
    ring.style.display = "none";
  }

  function overlayMode(doc, board) {
    if (doc !== document || document.fullscreenElement) return true;
    const labeled = `${document.documentElement.className} ${document.body?.className || ""}`;
    if (/\b(?:focus-mode|theatre-mode|theater-mode)\b/i.test(labeled)) return true;
    if (board.closest("[class*='focus-mode'], [class*='theatre'], [class*='theater']")) return true;
    let el = board;
    while (el && el !== document.body) {
      if (getComputedStyle(el).position === "fixed") return true;
      el = el.parentElement;
    }
    return false;
  }

  // Sit in the board's parent, under the board itself, so clocks, popups,
  // and the rest of the page paint over the glow.
  function placeBehind(board, rect) {
    const host = board.parentElement;
    if (!host) return false;
    if (ring.parentElement !== host) host.prepend(ring);
    if (hostWePositioned && hostWePositioned !== host) releaseHost();
    if (!hostWePositioned && getComputedStyle(host).position === "static") {
      host.style.position = "relative";
      hostWePositioned = host;
    }
    const origin = host.getBoundingClientRect();
    Object.assign(ring.style, {
      display: "block",
      position: "absolute",
      left: `${Math.round(rect.left - origin.left) - 5}px`,
      top: `${Math.round(rect.top - origin.top) - 5}px`,
      width: `${Math.round(rect.size) + 10}px`,
      height: `${Math.round(rect.size) + 10}px`,
      zIndex: "-1",
      pointerEvents: "none",
    });
    return true;
  }

  function placeOverlay(el, rect) {
    releaseHost();
    const parent = (ringDoc && (ringDoc.body || ringDoc.documentElement)) || document.body;
    if (el.parentElement !== parent) parent.append(el);
    Object.assign(el.style, {
      display: "block",
      position: "fixed",
      left: `${Math.round(rect.left) - 5}px`,
      top: `${Math.round(rect.top) - 5}px`,
      width: `${Math.round(rect.size) + 10}px`,
      height: `${Math.round(rect.size) + 10}px`,
      zIndex: "2147483000",
      pointerEvents: "none",
    });
  }

  function paint(doc, board, rect, mode, urgent) {
    const el = ensureRing(doc);
    if (overlayMode(doc, board) || !placeBehind(board, rect)) placeOverlay(el, rect);
    el.className = `is-on is-${mode}${urgent ? " is-urgent" : ""}`;
  }

  function tick() {
    if (settings.timeWarning === false || !onGamePage()) {
      hide();
      return;
    }
    const me = norm(settings.username) || pageUsername();
    if (!me) {
      hide();
      return;
    }

    const found = activeBoard();
    if (!found) {
      hide();
      return;
    }
    const { board, doc } = found;
    const side = mySide(doc, me);
    if (!side) {
      hide();
      return;
    }

    const opp = side === "bottom" ? "top" : "bottom";
    const mine = parseClockMs(clockText(doc, side));
    const theirs = parseClockMs(clockText(doc, opp));
    const rect = boardRect(board);
    if (mine == null || theirs == null || !rect) {
      hide();
      return;
    }

    const diff = mine - theirs;
    let mode = "even";
    if (diff > EVEN_MS) mode = "up";
    else if (diff < -EVEN_MS) mode = "down";
    const urgent = mine <= URGENT_MS || (mode === "down" && Math.abs(diff) >= 15000);

    paint(doc, board, rect, mode, urgent);
  }

  function loop() {
    tick();
    raf = window.setTimeout(loop, 250);
  }

  loop();
  window.addEventListener("resize", tick);
  window.addEventListener("scroll", tick, true);
  document.addEventListener("fullscreenchange", tick);
  try {
    window.documentPictureInPicture?.addEventListener?.("enter", () => setTimeout(tick, 200));
  } catch {
    // ignore
  }

  // Focus / theatre mode toggles often change layout classes on the root.
  let moTimer = 0;
  let mo = null;
  try {
    mo = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(tick, 50);
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    mo.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  } catch {
    mo = null;
  }

  window.__cfnTimeWarnStop = () => {
    clearTimeout(raf);
    clearTimeout(moTimer);
    mo?.disconnect?.();
    hide();
    releaseHost();
    ring?.remove?.();
    ring = null;
    ringDoc = null;
    delete window.__cfnTimeWarnStop;
  };
})();
