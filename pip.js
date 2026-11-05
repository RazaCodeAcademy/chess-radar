// Interactive Picture-in-Picture for Chess.com games.
// Moves the real board + clocks into a Document PiP window.
// Board stays at native size; CSS zoom fits the viewport (no scrollbars).
// Drag bridge forwards PiP move/up events to the main page document — Chess.com
// attaches drag listeners there, not on the PiP document.
(() => {
  window.__cfnPipStop?.();

  const PIP_PATH =
    "m19 7h-8v6h8zm4-4h-22v18h22zm-2 16h-18v-14h18zm0 0";

  let settings = { pictureInPicture: true };
  let pipWindow = null;
  let movedNode = null;
  let placeholder = null;
  let homeParent = null;
  let homeNext = null;
  let fitTimer = 0;
  let resizeObserver = null;
  let boardPx = 400;

  chrome.storage.local.get("settings").then(({ settings: s = {} }) => {
    settings = { ...settings, ...s };
    updateTool();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    settings = { ...settings, ...changes.settings.newValue };
    if (settings.pictureInPicture === false && pipActive()) closePip();
    updateTool();
  });

  function supported() {
    return "documentPictureInPicture" in window;
  }

  function onGamePage() {
    if (/\/(?:game|analysis\/game|play\/|game\/live|game\/daily)/.test(location.pathname)) return true;
    return !!document.querySelector("wc-chess-board, chess-board, #board-layout-chessboard");
  }

  function findBoardEl(root = document) {
    return (
      root.querySelector?.("wc-chess-board, chess-board") ||
      root.getElementById?.("board-layout-chessboard") ||
      null
    );
  }

  function measureBoardPx() {
    const board = findBoardEl();
    const r = board?.getBoundingClientRect();
    const px = r ? Math.round(Math.min(r.width, r.height)) : 0;
    return px > 40 ? px : 400;
  }

  function findPlayable() {
    const boardComp = document.querySelector("wc-chess-board, chess-board");
    const chessboard =
      document.getElementById("board-layout-chessboard") || boardComp || null;
    if (!chessboard?.isConnected) return null;

    const top = document.getElementById("board-layout-player-top");
    const bottom = document.getElementById("board-layout-player-bottom");
    const parent = chessboard.parentElement;
    if (!parent) return chessboard;

    const wrap = document.createElement("div");
    wrap.id = "cfn-pip-play-wrap";
    const slots = [];

    const take = (el) => {
      if (!el?.isConnected) return null;
      slots.push({ el, parent: el.parentElement, next: el.nextSibling });
      return el;
    };

    const topNode = take(top);
    const boardNode = take(chessboard);
    const bottomNode = take(bottom);

    parent.insertBefore(wrap, chessboard);
    if (topNode) wrap.append(topNode);
    if (boardNode) wrap.append(boardNode);
    if (bottomNode) wrap.append(bottomNode);

    if (!wrap.contains(chessboard)) {
      for (const slot of slots.reverse()) {
        try {
          if (slot.next?.isConnected) slot.parent.insertBefore(slot.el, slot.next);
          else slot.parent?.append?.(slot.el);
        } catch {
          // ignore
        }
      }
      wrap.remove();
      return chessboard;
    }

    wrap.__cfnUnwrap = () => {
      for (const slot of slots) {
        try {
          if (!slot.el.isConnected) continue;
          if (slot.next?.isConnected && slot.next.parentElement === slot.parent) {
            slot.parent.insertBefore(slot.el, slot.next);
          } else if (slot.parent?.isConnected) {
            slot.parent.append(slot.el);
          }
        } catch {
          // ignore
        }
      }
      wrap.remove();
    };
    return wrap;
  }

  function copyStyleSheets(targetDoc) {
    for (const sheet of document.styleSheets) {
      try {
        const css = [...sheet.cssRules].map((r) => r.cssText).join("\n");
        const style = targetDoc.createElement("style");
        style.textContent = css;
        targetDoc.head.append(style);
      } catch {
        if (sheet.href) {
          const link = targetDoc.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          targetDoc.head.append(link);
        }
      }
    }
  }

  function pipShellStyles(w) {
    const px = Math.max(240, Math.floor(w));
    return `
      :root { color-scheme: dark; }
      html, body {
        margin: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        background: #1b1a18 !important;
      }
      body {
        display: flex !important;
        justify-content: center !important;
        align-items: flex-start !important;
        padding: 0 !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
      }
      #cfn-pip-fit {
        overflow: hidden !important;
        flex: none !important;
      }
      #cfn-pip-host {
        display: flex !important;
        flex-direction: column !important;
        width: ${px}px !important;
        padding: 8px !important;
        box-sizing: border-box !important;
        gap: 6px !important;
        transform-origin: top left !important;
      }
      #cfn-pip-hint {
        margin: 0 !important;
        text-align: center !important;
        color: #a7a6a2 !important;
        font: 600 11px/1.3 system-ui, sans-serif !important;
      }
      #cfn-pip-play-wrap {
        display: flex !important;
        flex-direction: column !important;
        width: ${px}px !important;
        gap: 6px !important;
        margin: 0 !important;
        position: relative !important;
        overflow: visible !important;
      }
      #cfn-pip-host #board-layout-player-top,
      #cfn-pip-host #board-layout-player-bottom,
      #cfn-pip-play-wrap #board-layout-player-top,
      #cfn-pip-play-wrap #board-layout-player-bottom {
        position: relative !important;
        inset: auto !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        bottom: auto !important;
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        align-items: center !important;
        column-gap: 8px !important;
        width: ${px}px !important;
        min-height: 44px !important;
        height: auto !important;
        margin: 0 !important;
        padding: 0 2px !important;
        transform: none !important;
        overflow: hidden !important;
        z-index: 2 !important;
        box-sizing: border-box !important;
      }
      /* Left cluster: avatar + name + material */
      #cfn-pip-host #board-layout-player-top > :not(.clock-component):not([class*="clock-component"]),
      #cfn-pip-host #board-layout-player-bottom > :not(.clock-component):not([class*="clock-component"]),
      #cfn-pip-play-wrap #board-layout-player-top > :not(.clock-component):not([class*="clock-component"]),
      #cfn-pip-play-wrap #board-layout-player-bottom > :not(.clock-component):not([class*="clock-component"]) {
        grid-column: 1 !important;
        min-width: 0 !important;
        overflow: hidden !important;
      }
      /* Clock always sits on the far right */
      #cfn-pip-host .clock-component,
      #cfn-pip-play-wrap .clock-component,
      #cfn-pip-host [class*="clock-component"],
      #cfn-pip-play-wrap [class*="clock-component"] {
        grid-column: 2 !important;
        grid-row: 1 !important;
        justify-self: end !important;
        position: relative !important;
        z-index: 3 !important;
        margin: 0 !important;
        background: #312e2b !important;
        border-radius: 6px !important;
        padding: 4px 10px !important;
        min-width: 72px !important;
        text-align: center !important;
        flex: none !important;
      }
      #cfn-pip-host .clock-time-monospace,
      #cfn-pip-play-wrap .clock-time-monospace,
      #cfn-pip-host [class*="clock-time"],
      #cfn-pip-play-wrap [class*="clock-time"] {
        font-size: 18px !important;
        font-weight: 700 !important;
        line-height: 1.2 !important;
        color: #f0ece6 !important;
      }
      #cfn-pip-host .clock-component svg,
      #cfn-pip-play-wrap .clock-component svg,
      #cfn-pip-host .clock-component img,
      #cfn-pip-play-wrap .clock-component img {
        display: none !important;
      }
      #cfn-pip-host #board-layout-chessboard,
      #cfn-pip-play-wrap #board-layout-chessboard,
      #cfn-pip-host wc-chess-board,
      #cfn-pip-host chess-board,
      #cfn-pip-play-wrap wc-chess-board,
      #cfn-pip-play-wrap chess-board {
        position: relative !important;
        inset: auto !important;
        display: block !important;
        margin: 0 auto !important;
        transform: none !important;
        max-width: none !important;
        max-height: none !important;
        pointer-events: auto !important;
        touch-action: none !important;
      }
      #cfn-pip-host .piece,
      #cfn-pip-play-wrap .piece {
        pointer-events: auto !important;
      }
      #cfn-pip-host .board-layout-evaluation,
      #cfn-pip-host #board-layout-evaluation,
      #cfn-pip-host .evaluation-bar-component,
      #cfn-pip-host .board-controls-component,
      #cfn-pip-host .game-controls-component,
      #cfn-pip-host .resize-btn,
      #cfn-pip-host .board-layout-sidebar,
      #cfn-pip-host #board-layout-sidebar,
      #cfn-pip-host .eco-opening-name,
      #cfn-pip-host .ab-fader,
      #cfn-pip-host .alerts-component {
        display: none !important;
      }
    `;
  }

  function pinClocksRight(root) {
    for (const id of ["board-layout-player-top", "board-layout-player-bottom"]) {
      const bar = root.getElementById?.(id) || root.querySelector?.(`#${id}`);
      if (!bar) continue;
      const clock =
        bar.querySelector(".clock-component") ||
        bar.querySelector("[class*='clock-component']") ||
        bar.querySelector("[class*='clock']");
      if (clock && clock.parentElement === bar) {
        bar.append(clock); // last child => far right in our 2-col grid
      } else if (clock && clock.parentElement) {
        // Clock nested deeper — hoist a wrapper-friendly move to bar end.
        bar.append(clock);
      }
    }
  }

  function fitToViewport() {
    if (!pipActive()) return;
    const doc = pipWindow.document;
    const fit = doc.getElementById("cfn-pip-fit");
    const host = doc.getElementById("cfn-pip-host");
    if (!fit || !host) return;

    pinClocksRight(doc);

    // Fit with CSS zoom so the layout stays in-viewport (no scrollbars).
    // Piece moves still work because installDragBridge() forwards drag events
    // to the main page document where Chess.com listens.
    host.style.zoom = "1";
    fit.style.width = "auto";
    fit.style.height = "auto";

    const naturalW = Math.max(boardPx + 16, Math.ceil(host.scrollWidth || host.offsetWidth));
    const naturalH = Math.max(boardPx + 120, Math.ceil(host.scrollHeight || host.offsetHeight));
    const availW = Math.max(120, pipWindow.innerWidth || doc.documentElement.clientWidth);
    const availH = Math.max(120, pipWindow.innerHeight || doc.documentElement.clientHeight);
    const scale = Math.max(0.35, Math.min(availW / naturalW, availH / naturalH, 1));

    host.style.zoom = String(scale);
    fit.style.width = `${Math.floor(naturalW * scale)}px`;
    fit.style.height = `${Math.floor(naturalH * scale)}px`;
  }

  // Chess.com binds drag move/up on the MAIN page document. Forward PiP
  // pointer/mouse move+up into the page MAIN world with the same client coords.
  function installDragBridge() {
    if (!pipWindow) return;
    const types = [
      "pointermove",
      "pointerup",
      "pointercancel",
      "mousemove",
      "mouseup",
      "touchmove",
      "touchend",
      "touchcancel",
    ];

    const forward = (eventType, point, extra = {}) => {
      window.postMessage(
        {
          type: "cfn-pip-drag",
          eventType,
          clientX: point.clientX,
          clientY: point.clientY,
          screenX: point.screenX,
          screenY: point.screenY,
          button: extra.button ?? 0,
          buttons: extra.buttons ?? 0,
          ctrlKey: !!extra.ctrlKey,
          shiftKey: !!extra.shiftKey,
          altKey: !!extra.altKey,
          metaKey: !!extra.metaKey,
          pointerId: extra.pointerId || 1,
          pointerType: extra.pointerType || "mouse",
          isPrimary: extra.isPrimary !== false,
        },
        "*"
      );
    };

    for (const type of types) {
      pipWindow.document.addEventListener(
        type,
        (e) => {
          if (e.__cfnPipBridge) return;
          try {
            if (type.startsWith("touch")) {
              const t = e.changedTouches?.[0] || e.touches?.[0];
              if (!t) return;
              const mouseType = type === "touchmove" ? "mousemove" : "mouseup";
              forward(mouseType, t, { button: 0, buttons: mouseType === "mousemove" ? 1 : 0 });
              return;
            }
            forward(type, e, e);
          } catch {
            // ignore
          }
        },
        true
      );
    }

    pipWindow.document.addEventListener(
      "pointerdown",
      () => {
        try {
          pipWindow.focus();
        } catch {
          // ignore
        }
      },
      true
    );
  }

  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitToViewport();
      requestAnimationFrame(() => fitToViewport());
    }, 40);
  }

  function pipActive() {
    return !!(pipWindow && !pipWindow.closed);
  }

  function restoreBoard() {
    clearTimeout(fitTimer);
    try {
      resizeObserver?.disconnect();
    } catch {
      // ignore
    }
    resizeObserver = null;

    if (!movedNode) return;
    try {
      if (placeholder?.isConnected) {
        placeholder.replaceWith(movedNode);
      } else if (homeParent?.isConnected) {
        if (homeNext?.isConnected) homeParent.insertBefore(movedNode, homeNext);
        else homeParent.append(movedNode);
      } else {
        document.body.append(movedNode);
      }
      if (typeof movedNode.__cfnUnwrap === "function") {
        movedNode.__cfnUnwrap();
        delete movedNode.__cfnUnwrap;
      }
    } catch (err) {
      console.warn("PiP restore failed", err);
    }
    placeholder = null;
    homeParent = null;
    homeNext = null;
    movedNode = null;
  }

  function updateTool() {
    const visible = !!(settings.pictureInPicture !== false && supported() && onGamePage());
    const active = pipActive();
    window.__cfnTools?.upsert({
      id: "pip",
      label: "Picture in Picture",
      title: active ? "Close Picture in Picture" : "Picture in Picture",
      accent: "pip",
      glyph: "picture-in-picture",
      path: PIP_PATH,
      visible,
      active,
      onClick: () => {
        openPip().catch((err) => {
          console.warn("PiP failed", err);
          alert(err?.message || "Could not open Picture-in-Picture.");
        });
      },
    });
  }

  async function openPip() {
    if (!supported()) {
      alert("Picture-in-Picture needs Chrome or Edge on desktop.");
      return;
    }
    if (pipActive()) {
      closePip();
      return;
    }

    boardPx = measureBoardPx();
    const playable = findPlayable();
    if (!playable) {
      alert("Could not find the chess board on this page.");
      return;
    }

    const wantW = boardPx + 24;
    const wantH = boardPx + 150;
    pipWindow = await documentPictureInPicture.requestWindow({
      width: wantW,
      height: wantH,
      preferInitialWindowPlacement: true,
    });
    try {
      pipWindow.resizeTo(wantW, wantH);
    } catch {
      // some builds ignore resizeTo without a fresh gesture
    }

    copyStyleSheets(pipWindow.document);
    const shell = pipWindow.document.createElement("style");
    shell.textContent = pipShellStyles(boardPx);
    pipWindow.document.head.append(shell);

    const tw = pipWindow.document.createElement("style");
    tw.textContent = `
      #cfn-timewarn {
        display: none;
        position: fixed;
        z-index: 2147483000;
        pointer-events: none;
        border-radius: 8px;
        box-sizing: border-box;
        border: 4px solid transparent;
        opacity: 0;
      }
      #cfn-timewarn.is-on { display: block !important; opacity: 1; }
      #cfn-timewarn.is-up {
        border-color: rgba(129, 182, 76, 0.95);
        box-shadow: 0 0 0 1px rgba(129,182,76,.35), 0 0 16px 4px rgba(129,182,76,.55), 0 0 36px 8px rgba(129,182,76,.28);
      }
      #cfn-timewarn.is-down {
        border-color: rgba(250, 65, 45, 0.95);
        box-shadow: 0 0 0 1px rgba(250,65,45,.4), 0 0 16px 4px rgba(250,65,45,.55), 0 0 36px 8px rgba(250,65,45,.28);
      }
      #cfn-timewarn.is-even {
        border-color: rgba(247, 198, 49, 0.9);
        box-shadow: 0 0 0 1px rgba(247,198,49,.35), 0 0 14px 3px rgba(247,198,49,.45), 0 0 28px 6px rgba(247,198,49,.22);
      }
      #cfn-timewarn.is-urgent { animation: cfn-tw-pulse 1.1s ease-in-out infinite; }
      @keyframes cfn-tw-pulse {
        0%, 100% { filter: brightness(1); }
        50% { filter: brightness(1.25); }
      }
    `;
    pipWindow.document.head.append(tw);

    const fit = pipWindow.document.createElement("div");
    fit.id = "cfn-pip-fit";
    const host = pipWindow.document.createElement("div");
    host.id = "cfn-pip-host";
    const hint = pipWindow.document.createElement("p");
    hint.id = "cfn-pip-hint";
    hint.textContent = "Play or watch here — drag pieces to move";
    host.append(hint);
    fit.append(host);
    pipWindow.document.body.append(fit);

    homeParent = playable.parentElement;
    homeNext = playable.nextSibling;
    placeholder = document.createElement("div");
    placeholder.id = "cfn-pip-placeholder";
    const rect = playable.getBoundingClientRect();
    placeholder.style.cssText = `width:${Math.max(rect.width, 1)}px;height:${Math.max(rect.height, 1)}px;min-height:200px;`;
    playable.replaceWith(placeholder);
    movedNode = playable;
    host.append(playable);

    pinClocksRight(pipWindow.document);
    installDragBridge();
    scheduleFit();
    pipWindow.addEventListener("resize", scheduleFit);
    try {
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(pipWindow.document.body);
    } catch {
      // ignore
    }

    pipWindow.addEventListener("pagehide", () => {
      restoreBoard();
      pipWindow = null;
      updateTool();
    });

    try {
      pipWindow.focus();
      window.dispatchEvent(new Event("resize"));
    } catch {
      // ignore
    }

    updateTool();
  }

  function closePip() {
    try {
      pipWindow?.close();
    } catch {
      // already closed
    }
    if (movedNode) restoreBoard();
    pipWindow = null;
    updateTool();
  }

  setInterval(updateTool, 1500);
  updateTool();

  window.__cfnPipStop = () => {
    closePip();
    window.__cfnTools?.remove("pip");
    delete window.__cfnPipStop;
  };
})();
