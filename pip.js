// Interactive Picture-in-Picture for Chess.com games.
// Moves the real board (and clocks) into a Document PiP window so you can
// watch OR play moves while browsing other tabs.
(() => {
  window.__cfnPipStop?.();

  // Filled path — same SVG style as Chess.com game-icons glyphs.
  const PIP_PATH =
    "m19 7h-8v6h8zm4-4h-22v18h22zm-2 16h-18v-14h18zm0 0";

  let settings = { pictureInPicture: true };
  let pipWindow = null;
  let movedNode = null;
  let placeholder = null;
  let homeParent = null;
  let homeNext = null;

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
    // Live play and post-game review/share screens.
    if (/\/(?:game|analysis\/game|play\/|game\/live|game\/daily)/.test(location.pathname)) return true;
    return !!document.querySelector("wc-chess-board, chess-board, #board-layout-chessboard");
  }

  function findPlayable() {
    const main =
      document.getElementById("board-layout-main") ||
      document.querySelector("[id='board-layout-main'], .board-layout-main");
    if (main?.isConnected) return main;

    const board =
      document.querySelector("wc-chess-board, chess-board") ||
      document.getElementById("board-layout-chessboard");
    if (!board?.isConnected) return null;

    // Wrap board + player rails so clocks stay available while playing.
    const top = document.getElementById("board-layout-player-top");
    const bottom = document.getElementById("board-layout-player-bottom");
    if (top && bottom && board.parentElement) {
      const wrap = document.createElement("div");
      wrap.id = "cfn-pip-play-wrap";
      wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%;height:100%;";
      const parent = board.parentElement;
      const next = board.nextSibling;
      parent.insertBefore(wrap, board);
      if (top.parentElement === parent) wrap.append(top);
      wrap.append(board);
      if (bottom.parentElement === parent || bottom.parentElement === wrap.parentElement) wrap.append(bottom);
      else if (bottom.isConnected) wrap.append(bottom);
      if (!wrap.contains(board)) {
        wrap.remove();
        return board;
      }
      // Remember how to unwrap later.
      wrap.__cfnUnwrap = () => {
        while (wrap.firstChild) parent.insertBefore(wrap.firstChild, next);
        wrap.remove();
      };
      return wrap;
    }
    return board;
  }

  function boardSize() {
    const board =
      document.querySelector("wc-chess-board, chess-board") ||
      document.getElementById("board-layout-chessboard");
    const r = board?.getBoundingClientRect();
    if (r?.width) return Math.round(Math.min(r.width, r.height));
    return 360;
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

  function pipShellStyles() {
    return `
      :root { color-scheme: dark; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #262421;
      }
      body {
        display: flex;
        align-items: stretch;
        justify-content: center;
        padding: 8px;
        box-sizing: border-box;
      }
      #cfn-pip-host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
      }
      #cfn-pip-host > * {
        min-width: 0;
      }
      #cfn-pip-host wc-chess-board,
      #cfn-pip-host chess-board,
      #cfn-pip-host #board-layout-chessboard {
        width: 100% !important;
        height: auto !important;
        flex: 1 1 auto;
        aspect-ratio: 1;
        max-height: calc(100% - 96px);
      }
      #cfn-pip-hint {
        flex: none;
        margin: 0 0 6px;
        text-align: center;
        color: #a7a6a2;
        font: 600 11px/1.3 system-ui, sans-serif;
      }
    `;
  }

  function pipActive() {
    return !!(pipWindow && !pipWindow.closed);
  }

  function restoreBoard() {
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

    const playable = findPlayable();
    if (!playable) {
      alert("Could not find the chess board on this page.");
      return;
    }

    const size = Math.max(300, Math.min(520, boardSize()));
    pipWindow = await documentPictureInPicture.requestWindow({
      width: size + 24,
      height: size + 120,
      preferInitialWindowPlacement: true,
    });

    copyStyleSheets(pipWindow.document);
    const shell = pipWindow.document.createElement("style");
    shell.textContent = pipShellStyles();
    pipWindow.document.head.append(shell);

    const host = pipWindow.document.createElement("div");
    host.id = "cfn-pip-host";
    const hint = pipWindow.document.createElement("p");
    hint.id = "cfn-pip-hint";
    hint.textContent = "Play or watch here — drag pieces to move";
    host.append(hint);
    pipWindow.document.body.append(host);

    homeParent = playable.parentElement;
    homeNext = playable.nextSibling;
    placeholder = document.createElement("div");
    placeholder.id = "cfn-pip-placeholder";
    const rect = playable.getBoundingClientRect();
    placeholder.style.cssText = `width:${Math.max(rect.width, 1)}px;height:${Math.max(rect.height, 1)}px;min-height:200px;`;
    playable.replaceWith(placeholder);
    movedNode = playable;
    host.append(playable);

    pipWindow.addEventListener("pagehide", () => {
      restoreBoard();
      pipWindow = null;
      updateTool();
    });

    updateTool();
  }

  function closePip() {
    try {
      pipWindow?.close();
    } catch {
      // already closed
    }
    // pagehide restores the board; if it already fired, restore defensively
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
