// Evaluation bar for games you are watching on chess.com/game/*.
// Never shown in games where you are one of the players (fair play).
(() => {
  // The newest copy of this script wins; stop any copy injected earlier into this page.
  window.__cfnEvalbarStop?.();

  const TICK_MS = 400;
  const BAR_WIDTH = 20;
  const PIECE_RE = /\b([wb])([pnbrqk])\b/;
  const SQUARE_RE = /\bsquare-(\d)(\d)\b/;

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Remove elements left behind by a previous copy of this script (e.g. after the extension was reloaded).
  document.querySelectorAll("#cfn-evalbar, #cfn-bestmove, #cfn-bestmove-badge, #cfn-move-icon").forEach((el) => el.remove());

  let settings = { username: "", evalBar: true, bestMove: true };
  let lastFen = "";
  let lastBoard = null;
  let lastResult = null;
  let pendingTimer = null;
  let reviewMode = false;

  const bar = document.createElement("div");
  bar.id = "cfn-evalbar";
  bar.innerHTML = '<div class="cfn-fill"></div><span class="cfn-score"></span>';
  const fill = bar.querySelector(".cfn-fill");
  const score = bar.querySelector(".cfn-score");
  document.documentElement.append(bar);

  const arrowLayer = document.createElementNS(SVG_NS, "svg");
  arrowLayer.id = "cfn-bestmove";
  arrowLayer.setAttribute("viewBox", "0 0 8 8");
  arrowLayer.innerHTML = `
    <defs>
      <marker id="cfn-arrowhead" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" class="cfn-head"></path>
      </marker>
    </defs>
    <marker id="cfn-arrowhead-played" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" class="cfn-head-played"></path>
    </marker>
    <line class="cfn-arrow cfn-arrow-played" marker-end="url(#cfn-arrowhead-played)"></line>
    <line class="cfn-arrow" marker-end="url(#cfn-arrowhead)"></line>`;
  const arrowLine = arrowLayer.querySelector("line.cfn-arrow:not(.cfn-arrow-played)");
  const playedLine = arrowLayer.querySelector(".cfn-arrow-played");
  const playedHead = arrowLayer.querySelector(".cfn-head-played");
  document.documentElement.append(arrowLayer);

  const badge = document.createElement("div");
  badge.id = "cfn-bestmove-badge";
  document.documentElement.append(badge);

  const moveIcon = document.createElement("div");
  moveIcon.id = "cfn-move-icon";
  document.documentElement.append(moveIcon);

  chrome.storage.local.get("settings").then(({ settings: s = {} }) => {
    settings = { ...settings, ...s };
  });
  const params = new URLSearchParams(location.search);
  let watchUser = params.get("cfn") || params.get("username") || "";
  const watchGame = location.pathname.match(/\/(?:analysis\/)?game\/(?:live\/|daily\/)?(\d+)/)?.[1];
  if (watchUser) {
    chrome.runtime.sendMessage({ type: "watchingTab", username: watchUser, gameId: watchGame || "" }).catch(() => {});
  } else {
    chrome.runtime
      .sendMessage({ type: "watchTabMeta" })
      .then((res) => {
        if (res?.username) watchUser = res.username;
      })
      .catch(() => {});
  }
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) settings = { ...settings, ...changes.settings.newValue };
  });

  const norm = (s) => String(s || "").trim().toLowerCase();
  let lastFlipAt = 0;
  let lastFlipKey = "";

  function playerNameAt(side) {
    const root = document.querySelector(`#board-layout-player-${side}`);
    if (!root) return "";
    const el =
      root.querySelector(".cc-user-username-component, [data-test-element='user-tagline-username']") ||
      root.querySelector("a[href*='/member/']");
    if (!el) return "";
    const href = el.getAttribute?.("href") || "";
    const fromHref = href.match(/\/member\/([^/?#]+)/)?.[1];
    return norm(fromHref || el.textContent);
  }

  function flipBoard() {
    const rail =
      document.querySelector(".board-controls-component, .board-controls, [class*='board-controls']") ||
      document.getElementById("board-layout-chessboard");
    if (rail) {
      rail.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
      rail.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, view: window }));
    }
    const btn =
      document.getElementById("board-controls-flip") ||
      document.querySelector(
        '[id="board-controls-flip"], .board-controls-flip, [aria-label="Flip Board"], [aria-label="Flip board"], button[aria-label*="Flip" i]'
      );
    if (btn) {
      btn.click();
      return true;
    }
    // Chess.com also listens for the X shortcut on many game pages.
    const opts = { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent("keydown", opts));
    document.dispatchEvent(new KeyboardEvent("keydown", opts));
    return true;
  }

  // Keep the watched player at the bottom, same as when you play yourself.
  function ensureWatchedAtBottom() {
    const who = norm(watchUser);
    if (!who || !location.pathname.includes("/game/")) return;
    const bottom = playerNameAt("bottom");
    const top = playerNameAt("top");
    if (!bottom && !top) return;
    if (bottom === who) return;
    if (top !== who) return;
    const key = `${who}:${watchGame || location.pathname}`;
    const now = Date.now();
    if (key === lastFlipKey && now - lastFlipAt < 2500) return;
    lastFlipKey = key;
    lastFlipAt = now;
    flipBoard();
  }

  function readPieces() {
    const board = new Map();
    for (const el of document.querySelectorAll(".piece")) {
      const cls = el.className;
      if (typeof cls !== "string" || cls.includes("dragging")) continue;
      const p = cls.match(PIECE_RE);
      const sq = cls.match(SQUARE_RE);
      if (p && sq) board.set(sq[1] + sq[2], { color: p[1], type: p[2], el });
    }
    return board;
  }

  function sideToMove(board) {
    for (const el of document.querySelectorAll(".highlight")) {
      const sq = el.className.match?.(SQUARE_RE);
      const piece = sq && board.get(sq[1] + sq[2]);
      if (piece) return piece.color === "w" ? "b" : "w";
    }
    const node = document.querySelector(".node-highlight-content.selected")?.closest(".node");
    if (node?.classList.contains("white-move")) return "b";
    if (node?.classList.contains("black-move")) return "w";
    return "w";
  }

  function castling(board) {
    const is = (sq, color, type) => board.get(sq)?.color === color && board.get(sq)?.type === type;
    let c = "";
    if (is("51", "w", "k")) {
      if (is("81", "w", "r")) c += "K";
      if (is("11", "w", "r")) c += "Q";
    }
    if (is("58", "b", "k")) {
      if (is("88", "b", "r")) c += "k";
      if (is("18", "b", "r")) c += "q";
    }
    return c || "-";
  }

  function toFen(board) {
    const rows = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = "";
      let empty = 0;
      for (let file = 1; file <= 8; file++) {
        const p = board.get(`${file}${rank}`);
        if (!p) {
          empty++;
          continue;
        }
        if (empty) row += empty;
        empty = 0;
        row += p.color === "w" ? p.type.toUpperCase() : p.type;
      }
      rows.push(row + (empty || ""));
    }
    return `${rows.join("/")} ${sideToMove(board)} ${castling(board)} - 0 1`;
  }

  function isFlipped() {
    const first = document.querySelector("svg.coordinates text");
    return first?.textContent.trim() === "1";
  }

  function boardRect(board, flipped) {
    const [key, piece] = board.entries().next().value;
    const r = piece.el.getBoundingClientRect();
    const size = r.width;
    if (!size) return null;
    const file = Number(key[0]);
    const rank = Number(key[1]);
    const left = r.left - (flipped ? 8 - file : file - 1) * size;
    const top = r.top - (flipped ? rank - 1 : 8 - rank) * size;
    return { left, top, size: size * 8 };
  }

  function playerNames() {
    return [...document.querySelectorAll(
      "#board-layout-player-top .cc-user-username-component, #board-layout-player-bottom .cc-user-username-component, [data-test-element='user-tagline-username']"
    )].map((el) => norm(el.textContent));
  }

  let hidden = true;
  function hide() {
    if (hidden) return;
    hidden = true;
    bar.style.display = "none";
    hideBestMove();
  }

  function hideBestMove() {
    arrowLayer.style.display = "none";
    badge.style.display = "none";
    moveIcon.style.display = "none";
    if (playedLine) playedLine.style.display = "none";
  }

  function parseUci(uci) {
    const m = /^([a-h])([1-8])([a-h])([1-8])([qrbn])?$/.exec(uci || "");
    if (!m) return null;
    const file = (c) => c.charCodeAt(0) - 96;
    return {
      from: { file: file(m[1]), rank: Number(m[2]) },
      to: { file: file(m[3]), rank: Number(m[4]) },
      promo: m[5] || "",
      toName: m[3] + m[4],
    };
  }

  function toSan(uci, board) {
    const mv = parseUci(uci);
    if (!mv) return uci;
    const piece = board.get(`${mv.from.file}${mv.from.rank}`);
    if (!piece) return uci;
    const df = mv.to.file - mv.from.file;
    if (piece.type === "k" && Math.abs(df) === 2) return df > 0 ? "O-O" : "O-O-O";
    const target = board.get(`${mv.to.file}${mv.to.rank}`);
    const capture = !!target || (piece.type === "p" && df !== 0);
    const promo = mv.promo ? `=${mv.promo.toUpperCase()}` : "";
    if (piece.type === "p") {
      return (capture ? `${uci[0]}x` : "") + mv.toName + promo;
    }
    return piece.type.toUpperCase() + (capture ? "x" : "") + mv.toName + promo;
  }

  function squareCenter({ file, rank }, flipped) {
    return {
      x: (flipped ? 8 - file : file - 1) + 0.5,
      y: (flipped ? rank - 1 : 8 - rank) + 0.5,
    };
  }

  const CLASS_MARK = {
    brilliant: { icon: "!!", color: "#1baca6" },
    best: { icon: "★", color: "#81b64c" },
    excellent: { icon: "!", color: "#5c8bb0" },
    good: { icon: "✓", color: "#95b776" },
    inaccuracy: { icon: "?!", color: "#e6a700" },
    mistake: { icon: "?", color: "#e58f2a" },
    blunder: { icon: "??", color: "#ca3431" },
  };
  function placeArrow(line, mv, flipped) {
    if (!line || !mv) {
      if (line) line.style.display = "none";
      return;
    }
    const a = squareCenter(mv.from, flipped);
    const b = squareCenter(mv.to, flipped);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const shorten = Math.min(0.35, len / 2);
    line.style.display = "";
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x - ((b.x - a.x) / len) * shorten);
    line.setAttribute("y2", b.y - ((b.y - a.y) / len) * shorten);
  }

  function showArrowLayer(rect) {
    Object.assign(arrowLayer.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.size}px`,
      height: `${rect.size}px`,
    });
  }

  function reviewPly(key) {
    const data = window.__cfnReviewData;
    if (!data) return null;
    const matched = data.byAfter?.get(key);
    if (matched && CLASS_MARK[matched.cls]) return matched;
    const focus = data.focus;
    if (focus && Date.now() - (data.focusAt || 0) < 20000) return focus;
    return null;
  }

  function squareBox(sq, flipped, rect) {
    const size = rect.size / 8;
    const x = (flipped ? 8 - sq.file : sq.file - 1) * size;
    const y = (flipped ? sq.rank - 1 : 8 - sq.rank) * size;
    return { left: rect.left + x, top: rect.top + y, size };
  }

  function renderClassMark(rect, flipped, ply) {
    const played = parseUci(ply.uci);
    const mark = CLASS_MARK[ply.cls];
    if (!played || !mark) return false;
    if (playedLine) playedLine.style.display = "none";
    badge.style.display = "none";

    const box = squareBox(played.to, flipped, rect);
    const iconSize = Math.max(16, Math.round(box.size * 0.42));
    moveIcon.textContent = mark.icon;
    moveIcon.style.display = "flex";
    moveIcon.style.background = mark.color;
    moveIcon.style.width = `${iconSize}px`;
    moveIcon.style.height = `${iconSize}px`;
    moveIcon.style.fontSize = `${Math.max(9, Math.round(iconSize * 0.46))}px`;
    moveIcon.style.left = `${box.left + box.size - iconSize * 0.72}px`;
    moveIcon.style.top = `${box.top - iconSize * 0.28}px`;

    const best = parseUci(ply.bestUci);
    if (best && best.toName !== played.toName) {
      placeArrow(arrowLine, best, flipped);
      showArrowLayer(rect);
    } else {
      arrowLayer.style.display = "none";
    }
    return true;
  }

  function renderBestMove(rect, flipped) {
    if (playedLine) playedLine.style.display = "none";
    const uci = lastResult?.fen === lastFen ? lastResult.bestmove || lastResult.pv : null;
    const mv = parseUci(uci);
    if (!mv) return hideBestMove();

    const a = squareCenter(mv.from, flipped);
    const b = squareCenter(mv.to, flipped);
    // Stop the shaft short so the arrowhead tip lands in the target square's center.
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const shorten = Math.min(0.35, len / 2);
    const ex = b.x - ((b.x - a.x) / len) * shorten;
    const ey = b.y - ((b.y - a.y) / len) * shorten;
    arrowLine.setAttribute("x1", a.x);
    arrowLine.setAttribute("y1", a.y);
    arrowLine.setAttribute("x2", ex);
    arrowLine.setAttribute("y2", ey);

    Object.assign(arrowLayer.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.size}px`,
      height: `${rect.size}px`,
    });

    const anchor = badgeAnchor(lastFen.split(" ")[1], flipped);
    if (!anchor) {
      badge.style.display = "none";
      return;
    }
    badge.textContent = `Best: ${lastResult.bestSan || toSan(uci, lastBoard)}`;
    Object.assign(badge.style, {
      display: "block",
      left: `${anchor.right + 8}px`,
      top: `${anchor.top + anchor.height / 2}px`,
    });
  }

  // The label sits right after the captured pieces of the player whose turn it is.
  function badgeAnchor(sideToMove, flipped) {
    const whiteAtBottom = !flipped;
    const position = (sideToMove === "w") === whiteAtBottom ? "bottom" : "top";
    const tagline = document.querySelector(`#board-layout-player-${position} .player-tagline`);
    if (!tagline) return null;
    const captured = tagline.querySelector("wc-captured-pieces > div, wc-captured-pieces, .captured-pieces");
    const target = captured?.getBoundingClientRect().width ? captured : tagline.lastElementChild;
    const r = target?.getBoundingClientRect();
    if (!r?.height) return null;
    // Empty captured-pieces rows are full width; hug the actual pieces instead.
    const pieces = [...(captured?.querySelectorAll(".captured-pieces-cpiece") || [])]
      .map((el) => el.getBoundingClientRect())
      .filter((p) => p.width);
    const right = pieces.length ? Math.max(...pieces.map((p) => p.right)) : captured ? r.left : r.right;
    return { right, top: r.top, height: r.height };
  }

  function whiteShare(result) {
    if (!result) return 50;
    if (result.matedSide) return result.matedSide === "w" ? 0 : 100;
    if (result.mate != null) return result.mate > 0 ? 100 : 0;
    const cp = result.cp ?? 0;
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  function scoreText(result) {
    if (!result) return "…";
    if (result.matedSide) return result.matedSide === "w" ? "0-1" : "1-0";
    if (result.mate != null) return `M${Math.abs(result.mate)}`;
    const v = (result.cp ?? 0) / 100;
    return (v > 0 ? "+" : "") + v.toFixed(1);
  }

  function render(rect, flipped, notice) {
    hidden = false;
    if (!settings.evalBar) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "block";
    const left = rect.left - BAR_WIDTH - 6 >= 0 ? rect.left - BAR_WIDTH - 6 : rect.left + 2;
    bar.style.left = `${left}px`;
    bar.style.top = `${rect.top}px`;
    bar.style.height = `${rect.size}px`;
    bar.classList.toggle("cfn-flipped", flipped);

    if (notice) {
      bar.classList.add("cfn-notice");
      fill.style.height = "50%";
      score.textContent = "?";
      bar.title = notice;
      return;
    }
    bar.classList.remove("cfn-notice");

    const share = whiteShare(lastResult);
    fill.style.height = `${share}%`;
    score.textContent = scoreText(lastResult);
    score.classList.toggle("cfn-white-ahead", share >= 50);
    bar.title = lastResult?.depth ? `Stockfish depth ${lastResult.depth}` : "Evaluating…";
  }

  function requestEval(fen) {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: "evaluate", fen });
        if (res?.ok && res.fen === lastFen && !reviewMode) lastResult = res;
      } catch {
        // extension reloaded or engine unavailable
      }
    }, 150);
  }

  function tick({ layoutOnly = false } = {}) {
    if (!location.pathname.startsWith("/game/")) return hide();
    ensureWatchedAtBottom();
    const board = readPieces();
    if (board.size < 2) return hide();

    const flipped = isFlipped();
    const rect = boardRect(board, flipped);
    if (!rect) return hide();

    const fen = toFen(board);
    const fenKey = fen.split(" ").slice(0, 2).join(" ");
    const marked = reviewPly(fenKey);
    const reviewed = window.__cfnReviewData?.byKey.get(fenKey) || null;
    if (reviewed) {
      if (!reviewMode || fen !== lastFen) {
        clearTimeout(pendingTimer);
        lastFen = fen;
        lastBoard = board;
        lastResult = { ...reviewed, fen, depth: 12, review: true };
      }
      reviewMode = true;
      render(rect, flipped);
      if (window.__cfnPuzzleActive) return hideBestMove();
      if (!(marked && renderClassMark(rect, flipped, marked))) {
        moveIcon.style.display = "none";
        renderBestMove(rect, flipped);
      }
      return;
    }
    if (reviewMode) {
      reviewMode = false;
      lastFen = "";
      lastResult = null;
    }

    if (!settings.evalBar && !settings.bestMove) return hide();

    if (!settings.username) {
      hideBestMove();
      return render(rect, flipped, "Set your chess.com username in the extension popup to enable the evaluation bar.");
    }
    const players = playerNames();
    if (!players.length || players.includes(norm(settings.username))) return hide();

    if (!layoutOnly && fen !== lastFen) {
      lastFen = fen;
      lastBoard = board;
      requestEval(fen);
    }
    render(rect, flipped);
    if (window.__cfnPuzzleActive) return hideBestMove();
    if (marked && renderClassMark(rect, flipped, marked)) return;
    moveIcon.style.display = "none";
    if (settings.bestMove) renderBestMove(rect, flipped);
    else hideBestMove();
  }

  function stop() {
    clearInterval(timer);
    removeEventListener("scroll", onLayout);
    removeEventListener("resize", onLayout);
    bar.remove();
    arrowLayer.remove();
    badge.remove();
    moveIcon.remove();
  }
  window.__cfnEvalbarStop = stop;

  const timer = setInterval(() => {
    // After the extension is reloaded this copy loses access to chrome.* APIs; shut it down cleanly.
    if (!chrome.runtime?.id) return stop();
    tick();
  }, TICK_MS);
  let layoutRaf = 0;
  const onLayout = () => {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      tick({ layoutOnly: true });
    });
  };
  addEventListener("scroll", onLayout, { passive: true });
  addEventListener("resize", onLayout);
})();
