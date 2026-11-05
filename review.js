// "Analyze game" panel on chess.com/game/* pages: accuracy, move classifications and key moments.
(() => {
  window.__cfnReviewStop?.();
  document.querySelectorAll("#cfn-review").forEach((el) => el.remove());

  const CLASSES = [
    { id: "brilliant", label: "Brilliant", icon: "!!" },
    { id: "best", label: "Best", icon: "★" },
    { id: "excellent", label: "Excellent", icon: "!" },
    { id: "good", label: "Good", icon: "✓" },
    { id: "inaccuracy", label: "Inaccuracy", icon: "?!" },
    { id: "mistake", label: "Mistake", icon: "?" },
    { id: "blunder", label: "Blunder", icon: "??" },
  ];
  const KEY_CLASSES = new Set(["brilliant", "inaccuracy", "mistake", "blunder"]);
  const byId = Object.fromEntries(CLASSES.map((c) => [c.id, c]));

  let settings = { analyzeGame: true };
  let gameKey = null;
  let state = { status: "idle" };
  let open = false;
  let cycleKey = "";
  let cycleIndex = -1;
  let puzzle = null;
  let insightTab = "takeaway";
  let linePly = 0;
  let stage = null;
  const finishedById = new Map();
  let finishedFetchAt = 0;

  const root = document.createElement("div");
  root.id = "cfn-review";
  // Filled bars — same SVG style as Chess.com game-icons glyphs.
  const ANALYZE_PATH = "m5 20h3v-11h-3zm5.5 0h3v-16h-3zm5.5 0h3v-8h-3zm0 0";

  root.innerHTML = `
    <section class="cfn-rv-panel" hidden>
      <header>
        <span class="cfn-rv-title">Game review</span>
        <button class="cfn-rv-close" type="button" title="Close">×</button>
      </header>
      <div class="cfn-rv-body"></div>
      <div class="cfn-rv-setup" hidden>
        <label>Engine
          <select data-review="engine">
            <option value="lichess-cloud">Lichess Cloud — strongest</option>
            <option value="stockfish-deep">Stockfish 19 deep</option>
            <option value="stockfish-lite">Stockfish 19 lite — fastest</option>
          </select>
        </label>
        <label>Depth
          <select data-review="depth">
            <option value="12">12 — fastest</option>
            <option value="14">14</option>
            <option value="16">16</option>
            <option value="18">18</option>
            <option value="20">20</option>
            <option value="22">22</option>
            <option value="24">24 — slowest</option>
          </select>
        </label>
        <button class="cfn-rv-primary" data-action="analyze" data-fresh="1" type="button">Analyze again</button>
      </div>
      <footer class="cfn-rv-nav" hidden>
        <button data-nav="start" type="button" title="Start">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.2v14H6V5zm3.2 7 9.3 6.2V5.8L9.2 12z"/></svg>
        </button>
        <button data-nav="prev" type="button" title="Previous move">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.2 4.8 7 12l8.2 7.2-1.6 1.6L3.8 12 13.6 3.2l1.6 1.6z"/></svg>
        </button>
        <button data-nav="play" type="button" title="Play moves">
          <svg class="cfn-icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6l11-6.8L8 5.2z"/></svg>
          <svg class="cfn-icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4.2v14H6V5zm7.8 0H18v14h-4.2V5z"/></svg>
        </button>
        <button data-nav="next" type="button" title="Next move">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.8 4.8 17 12l-8.2 7.2 1.6 1.6 9.8-8.8-9.8-8.8-1.6 1.6z"/></svg>
        </button>
        <button data-nav="end" type="button" title="End">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.8 14.8 12 5.5 18.2V5.8zM16 5h2.2v14H16V5z"/></svg>
        </button>
      </footer>
    </section>`;
  document.documentElement.append(root);
  const panel = root.querySelector(".cfn-rv-panel");
  const body = root.querySelector(".cfn-rv-body");
  const nav = root.querySelector(".cfn-rv-nav");
  const setup = root.querySelector(".cfn-rv-setup");
  const engineSelect = setup.querySelector("[data-review='engine']");
  const depthSelect = setup.querySelector("[data-review='depth']");
  const againBtn = setup.querySelector("[data-action='analyze']");
  const ANALYSIS_DEPTHS = [12, 14, 16, 18, 20, 22, 24];
  let cursor = 0;
  let playing = false;
  let playTimer = null;

  function openAnalyze() {
    const game = currentGame();
    if (!game || ownLiveGame()) return;
    if (!gameIsFinished(game)) return;
    open = true;
    if (state.status === "idle") runAnalysis();
    sync();
  }

  function boardPlayers() {
    return [...document.querySelectorAll(
      "#board-layout-player-top a[href*='/member/'], #board-layout-player-bottom a[href*='/member/'], #board-layout-player-top .cc-user-username-component, #board-layout-player-bottom .cc-user-username-component"
    )].map((el) => {
      const href = el.getAttribute?.("href") || "";
      const fromHref = href.match(/\/member\/([^/?#]+)/)?.[1];
      return norm(fromHref || el.textContent);
    }).filter(Boolean);
  }

  // The logged-in player's own live board has Resign. Spectating a friend does not.
  function ownLiveGame() {
    if (looksFinished()) return false;
    if (looksLivePlaying()) return true;
    const me = norm(settings.username);
    const game = currentGame();
    if (!me || !game || gameIsFinished(game)) return false;
    return boardPlayers().includes(me);
  }

  function registerAnalyzeTool() {
    const game = currentGame();
    const onBoard =
      !!game ||
      /\/(?:game|play\/|analysis\/game)/.test(location.pathname) ||
      !!document.querySelector("wc-chess-board, chess-board");
    const visible = !!(settings.analyzeGame && onBoard && !open && !ownLiveGame());
    window.__cfnTools?.upsert({
      id: "analyze",
      label: "Analyze Game",
      title: "Analyze Game",
      accent: "analyze",
      glyph: "chart-bars-analyze",
      path: ANALYZE_PATH,
      visible,
      active: open,
      onClick: openAnalyze,
    });
  }

  chrome.storage.local.get("settings").then(({ settings: s = {} }) => {
    settings = { ...settings, ...s };
    applyAnalysisSettings();
    sync();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      applyAnalysisSettings();
      sync();
    }
  });

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const norm = (name) => String(name || "").trim().toLowerCase();

  function currentGame() {
    const path = location.pathname;
    const m =
      path.match(/\/(?:analysis\/)?game\/(?:(live|daily)\/)?(\d+)/) ||
      path.match(/\/game\/review\/(?:(live|daily)\/)?(\d+)/) ||
      path.match(/\/play\/(?:online\/)?game\/(?:(live|daily)\/)?(\d+)/);
    if (m) return { kind: m[1] || null, id: m[2], key: m[2] };
    const q = new URLSearchParams(location.search);
    const id = q.get("gameId") || q.get("game") || "";
    if (/^\d+$/.test(id) && /\/(game|analysis|play|review)/.test(path)) {
      return { kind: q.get("type") || q.get("kind") || null, id, key: id };
    }
    return null;
  }

  function looksLivePlaying() {
    return !!document.querySelector(
      [
        "[aria-label='Resign']",
        "[aria-label='Abort']",
        ".resign-button-component",
        ".abort-button-component",
        "[data-cy='resign-button']",
        ".live-game-buttons-component",
      ].join(",")
    );
  }

  function looksFinished() {
    if (/\/analysis\//.test(location.pathname) || /\/game\/review\//.test(location.pathname)) return true;
    return !!document.querySelector(
      [
        ".player-game-over-component",
        ".game-over-modal-component",
        ".game-over-modal-content",
        ".game-over-modal-container",
        ".game-over-buttons-component",
        "[class*='player-game-over']",
        "[class*='game-over-modal']",
        "[class*='GameOver']",
        "[data-cy='game-over']",
        "[data-cy='game-over-modal']",
        "button[aria-label*='Game Review' i]",
      ].join(",")
    );
  }

  function requestFinished(game) {
    const now = Date.now();
    const cached = finishedById.get(game.id);
    if (cached === true || cached === "pending") return;
    if (cached === false && now - finishedFetchAt < 4000) return;
    finishedById.set(game.id, "pending");
    finishedFetchAt = now;
    chrome.runtime
      .sendMessage({ type: "gameStatus", gameId: game.id, kind: game.kind })
      .then((res) => {
        finishedById.set(game.id, res?.ok ? !!res.finished : "unknown");
        sync();
      })
      .catch(() => {
        finishedById.set(game.id, "unknown");
        sync();
      });
  }

  function gameIsFinished(game) {
    if (looksFinished()) return true;
    if (looksLivePlaying()) return false;
    if (!game) return false;
    const cached = finishedById.get(game.id);
    if (cached === true || cached === "unknown") return true;
    requestFinished(game);
    return false;
  }

  function sync() {
    if (!chrome.runtime?.id) return stop();
    const game = currentGame();
    registerAnalyzeTool();
    const canOpen = !!(settings.analyzeGame && game && gameIsFinished(game));
    if (!canOpen) {
      root.style.display = "none";
      if (open) {
        open = false;
        window.__cfnReviewData = null;
        registerAnalyzeTool();
      }
      return;
    }
    root.style.display = open ? "block" : "none";
    if (game.key !== gameKey) {
      gameKey = game.key;
      state = { status: "idle" };
      cursor = 0;
      insightTab = "takeaway";
      linePly = 0;
      stopStage();
      stopPlay();
      render();
    }
    panel.hidden = !open;
    nav.hidden = !open || state.status !== "done" || !!puzzle;
    fillAnalysisControls();
    publish();
  }

  function analysisDepth() {
    const depth = Number(depthSelect.value);
    return ANALYSIS_DEPTHS.includes(depth) ? depth : 12;
  }

  function applyAnalysisSettings() {
    const engine = ["lichess-cloud", "stockfish-deep", "stockfish-lite"].includes(settings.engineId)
      ? settings.engineId
      : "stockfish-lite";
    const depth = ANALYSIS_DEPTHS.includes(Number(settings.analysisDepth)) ? String(settings.analysisDepth) : "12";
    engineSelect.value = engine;
    depthSelect.value = depth;
  }

  function fillAnalysisControls() {
    const busy = state.status === "running";
    engineSelect.disabled = busy;
    depthSelect.disabled = busy;
    againBtn.disabled = busy;
    againBtn.textContent = busy ? "Analyzing…" : "Analyze again";
    setup.hidden = !open || !!puzzle;
  }

  function rememberAnalysisChoice() {
    settings = { ...settings, engineId: engineSelect.value, analysisDepth: analysisDepth() };
    chrome.storage.local.get("settings").then(({ settings: saved = {} }) => {
      chrome.storage.local.set({
        settings: { ...saved, engineId: settings.engineId, analysisDepth: settings.analysisDepth },
      });
    });
  }

  // While the review is open, evalbar.js draws the best move for whichever reviewed position is on the board.
  function publish() {
    const result = open && settings.analyzeGame && state.status === "done" ? state.result : null;
    if (!result?.positions) {
      window.__cfnReviewData = null;
      return;
    }
    const prevFocus = window.__cfnReviewData?.result === result ? window.__cfnReviewData.focus : null;
    if (window.__cfnReviewData?.result === result && window.__cfnReviewData.byAfter) return;
    window.__cfnReviewData = {
      result,
      byKey: new Map(result.positions.map((p) => [p.key, p])),
      byAfter: new Map((result.plies || []).filter((p) => p.afterKey).map((p) => [p.afterKey, p])),
      focus: prevFocus,
      focusAt: prevFocus ? Date.now() : 0,
    };
  }

  function focusPly(ply) {
    const result = state.status === "done" ? state.result : null;
    if (!result) return;
    publish();
    if (!window.__cfnReviewData) return;
    window.__cfnReviewData.focus = ply || null;
    window.__cfnReviewData.focusAt = ply ? Date.now() : 0;
    body.querySelectorAll(".cfn-rv-moments li").forEach((li) => {
      li.classList.toggle("active", !!ply && Number(li.dataset.ply) === ply.ply);
    });
    if (ply) {
      body.querySelector(`.cfn-rv-moments li[data-ply="${ply.ply}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  function plyCount() {
    return state.result?.plies?.length || 0;
  }

  function stopPlay() {
    playing = false;
    clearInterval(playTimer);
    playTimer = null;
    nav.classList.remove("is-playing");
  }

  function buttonsUnder(rootNode, out) {
    if (!rootNode?.querySelectorAll || rootNode.id === "cfn-review") return;
    for (const el of rootNode.querySelectorAll("button, [role='button']")) {
      if (!el.closest?.("#cfn-review")) out.push(el);
    }
    for (const el of rootNode.querySelectorAll("*")) {
      if (el.id === "cfn-review") continue;
      if (el.shadowRoot) buttonsUnder(el.shadowRoot, out);
    }
  }

  function clickBoardControl(needles) {
    const buttons = [];
    buttonsUnder(document, buttons);
    const hit = buttons.find((btn) => {
      const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.dataset.cy || ""}`.toLowerCase();
      return needles.some((needle) => label.includes(needle));
    });
    if (!hit) return false;
    hit.click();
    return true;
  }

  function goTo(index) {
    const n = plyCount();
    if (!n) return;
    cursor = Math.max(0, Math.min(n, index));
    if (cursor === 0) {
      focusPly(null);
      if (!clickBoardControl(["first move", "skip to start", "go to start", "beginning"])) {
        jumpToPly(1);
        clickBoardControl(["previous move", "previous"]);
      }
      return;
    }
    const ply = state.result.plies[cursor - 1];
    focusPly(ply);
    jumpToPly(ply.ply, ply);
    body.querySelectorAll(".cfn-rv-count").forEach((cell) => {
      cell.classList.toggle("active", cell.dataset.cls === ply.cls && cell.dataset.color === ply.color);
    });
  }

  function togglePlay() {
    if (playing) {
      stopPlay();
      return;
    }
    if (cursor >= plyCount()) cursor = 0;
    playing = true;
    nav.classList.add("is-playing");
    playTimer = setInterval(() => {
      if (cursor >= plyCount()) {
        stopPlay();
        return;
      }
      goTo(cursor + 1);
    }, 700);
  }

  async function runAnalysis(fresh = false) {
    const game = currentGame();
    if (!game || ownLiveGame() || state.status === "running") return;
    const key = game.key;
    const engineId = engineSelect.value;
    const depth = analysisDepth();
    rememberAnalysisChoice();
    state = { status: "running", done: 0, total: 0, depth };
    cursor = 0;
    stopPlay();
    render();
    fillAnalysisControls();
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: "analyzeGame",
        gameId: game.id,
        kind: game.kind,
        engineId,
        depth,
        fresh: !!fresh,
      });
    } catch {
      res = { ok: false, error: "The extension was reloaded. Refresh this page and try again." };
    }
    if (key !== gameKey) return;
    state = res?.ok ? { status: "done", result: res } : { status: "error", error: res?.error || "Analysis failed." };
    render();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "analysisProgress" || state.status !== "running") return;
    state.done = msg.done;
    state.total = msg.total;
    renderProgress();
  });

  function render() {
    clearStageTimer();
    if (state.status === "idle") {
      body.innerHTML = `
        <p class="cfn-rv-intro">The engine and depth below are used for every move. Higher depth finds more mistakes and takes longer.</p>
        <button class="cfn-rv-primary" data-action="analyze" type="button">Start review</button>`;
    } else if (state.status === "running") {
      body.innerHTML = `
        <p class="cfn-rv-intro">Analyzing every move at depth ${state.depth || analysisDepth()}…</p>
        <div class="cfn-rv-progress"><div></div></div>
        <p class="cfn-rv-progress-text"></p>`;
      renderProgress();
    } else if (state.status === "error") {
      body.innerHTML = `
        <p class="cfn-rv-error">${esc(state.error)}</p>
        <button class="cfn-rv-primary" data-action="analyze" type="button">Try again</button>`;
    } else if (puzzle) {
      body.innerHTML = renderPuzzle();
    } else {
      try {
        body.innerHTML = renderResult(state.result);
      } catch (err) {
        body.innerHTML = `
          <p class="cfn-rv-error">${esc(err?.message || "Could not show this review.")}</p>
          <button class="cfn-rv-primary" data-action="analyze" type="button">Try again</button>`;
      }
    }
    if (state.status === "done" && !puzzle && stage) {
      try {
        paintStage(false);
      } catch {
        // The written review stays on screen if the mini-board cannot be drawn.
      }
    }
    publish();
    fillAnalysisControls();
  }

  function renderProgress() {
    const fill = body.querySelector(".cfn-rv-progress div");
    const text = body.querySelector(".cfn-rv-progress-text");
    if (!fill) return;
    const pct = state.total ? (state.done / state.total) * 100 : 0;
    fill.style.width = `${pct}%`;
    text.textContent = state.total ? `Position ${state.done} of ${state.total}` : "Loading game…";
  }

  function accuracyClass(a) {
    return a >= 90 ? "cfn-acc-great" : a >= 75 ? "cfn-acc-good" : a >= 60 ? "cfn-acc-ok" : "cfn-acc-bad";
  }

  function playerSnapshot(p, fallback) {
    return {
      name: p?.name || fallback,
      rating: p?.rating || null,
      accuracy: p?.accuracy ?? null,
      counts: p?.counts || null,
    };
  }

  function playerCard(p, color) {
    const rating = p.rating ? `<span class="cfn-rv-rating">(${esc(p.rating)})</span>` : "";
    return `
      <div class="cfn-rv-player cfn-rv-${color}">
        <span class="cfn-rv-name"><i class="cfn-rv-dot"></i>${esc(p.name)} ${rating}</span>
        <span class="cfn-rv-acc ${accuracyClass(p.accuracy)}">${p.accuracy.toFixed(1)}</span>
        <span class="cfn-rv-acc-label">Accuracy</span>
      </div>`;
  }

  function movesOf(cls, color) {
    return (state.result?.plies || []).filter((p) => p.cls === cls && p.color === color);
  }

  function showMove(ply) {
    if (!ply) return;
    stopPlay();
    const index = (state.result?.plies || []).findIndex((p) => p.ply === ply.ply);
    goTo(index >= 0 ? index + 1 : ply.ply);
  }

  function cycleClass(cls, color) {
    const moves = movesOf(cls, color);
    if (!moves.length) return;
    const key = `${color}:${cls}`;
    cycleIndex = key === cycleKey ? (cycleIndex + 1) % moves.length : 0;
    cycleKey = key;
    showMove(moves[cycleIndex]);
  }

  function focusColor(result) {
    const watched = norm(new URLSearchParams(location.search).get("cfn") || "");
    const me = norm(settings.username);
    const want = watched || me;
    if (!want || !result) return "";
    if (norm(result.white?.name) === want) return "w";
    if (norm(result.black?.name) === want) return "b";
    return "";
  }

  function shownPlayer(player, side, result) {
    const focus = focusColor(result);
    const code = side === "white" ? "w" : "b";
    if (!settings.hideOpponent || !focus || code === focus) return player;
    return { ...player, name: "Opponent", rating: null };
  }

  function clearStageTimer() {
    if (!stage?.timer) return;
    clearTimeout(stage.timer);
    stage.timer = null;
    stage.playing = false;
  }

  function stopStage() {
    clearStageTimer();
    stage = null;
  }

  function shownEval(whiteCp, color) {
    if (whiteCp == null || Number.isNaN(Number(whiteCp))) return "—";
    const value = color === "w" ? Number(whiteCp) : -Number(whiteCp);
    if (Math.abs(value) >= 9000) return value > 0 ? "mate" : "mated";
    const pawns = value / 100;
    return `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
  }

  function markedSan(move) {
    const mark = move.cls === "blunder" || move.cls === "mistake" ? "?" : move.cls === "inaccuracy" ? "?!" : "";
    return `${move.san}${mark}`;
  }

  function kindLabel(cls) {
    if (cls === "blunder") return "Blunder";
    if (cls === "inaccuracy") return "Inaccuracy";
    if (cls === "mistake") return "Mistake";
    return "Mistake";
  }

  function moveLabel(move) {
    return `${move.moveNumber}${move.color === "w" ? "." : "…"} ${markedSan(move)}`;
  }

  function armStage(move) {
    const speed = stage?.speed || 1;
    clearStageTimer();
    const steps = Array.isArray(move?.line) ? move.line.filter((step) => step?.fen && step?.uci) : [];
    if (!move?.fen) {
      stage = null;
      return;
    }
    stage = {
      fens: [move.fen, ...steps.map((step) => step.fen)],
      steps,
      index: 0,
      playing: false,
      timer: null,
      busy: false,
      speed,
    };
  }

  const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  const pieceCache = new Map();
  // Chess.com's page policy blocks chrome-extension image URLs, which leaves a
  // broken icon in every square. Fetch the files from the extension and use a data URL.
  const piecesReady = Promise.all(
    ["w", "b"].flatMap((color) =>
      Object.values(PIECE_NAME).map(async (name) => {
        try {
          const res = await fetch(chrome.runtime.getURL(`pieces/${name}-${color}.svg`));
          if (!res.ok) return;
          const text = (await res.text()).replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "");
          pieceCache.set(`${name}-${color}`, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`);
        } catch {
          // That piece stays blank if the file cannot be read.
        }
      })
    )
  );

  function pieceSrc(color, type) {
    const name = PIECE_NAME[type];
    return name ? pieceCache.get(`${name}-${color}`) || "" : "";
  }

  function fenPieces(fen) {
    const map = new Map();
    String(fen || "")
      .split(" ")[0]
      .split("/")
      .forEach((row, rankIndex) => {
        let file = 0;
        for (const ch of row) {
          if (/\d/.test(ch)) file += Number(ch);
          else {
            map.set("abcdefgh"[file] + (8 - rankIndex), {
              color: ch === ch.toUpperCase() ? "w" : "b",
              type: ch.toLowerCase(),
            });
            file += 1;
          }
        }
      });
    return map;
  }

  function kingInCheck(fen) {
    const turn = String(fen || "").split(" ")[1];
    const want = turn === "b" ? "k" : "K";
    const rows = String(fen || "").split(" ")[0].split("/");
    for (let rankIndex = 0; rankIndex < rows.length; rankIndex += 1) {
      let file = 0;
      for (const ch of rows[rankIndex]) {
        if (/\d/.test(ch)) file += Number(ch);
        else {
          if (ch === want) return "abcdefgh"[file] + (8 - rankIndex);
          file += 1;
        }
      }
    }
    return "";
  }

  function drawBoard(el, fen, marks) {
    el.replaceChildren();
    const flipped = focusColor(state.result) === "b";
    const ranks = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    const pieces = fenPieces(fen);
    for (const rank of ranks) {
      for (const file of files) {
        const sq = "abcdefgh"[file] + rank;
        const cell = document.createElement("div");
        cell.className = "cfn-sq" + ((file + rank) % 2 === 1 ? " dark" : "");
        cell.dataset.sq = sq;
        if (marks?.last?.includes(sq)) cell.classList.add("last");
        if (marks?.check === sq) cell.classList.add("check");
        const piece = pieces.get(sq);
        if (piece) {
          const img = document.createElement("img");
          img.src = pieceSrc(piece.color, piece.type);
          img.alt = "";
          img.draggable = false;
          cell.append(img);
        }
        el.append(cell);
      }
    }
  }

  async function paintStage() {
    await piecesReady;
    const el = body.querySelector(".cfn-mini");
    if (!el || !stage) return;
    const fen = stage.fens[stage.index] || stage.fens[0];
    const step = stage.index > 0 ? stage.steps[stage.index - 1] : null;
    drawBoard(el, fen, {
      last: step ? [step.uci.slice(0, 2), step.uci.slice(2, 4)] : [],
      check: step?.check ? kingInCheck(fen) : "",
    });
    body.querySelectorAll(".cfn-line li").forEach((li, i) => {
      li.classList.toggle("is-on", i === stage.index - 1);
    });
    const play = body.querySelector("[data-insight='play']");
    if (play) {
      play.classList.toggle("is-on", !!stage.playing);
      play.textContent = stage.playing ? "Pause" : "Play";
    }
  }

  function castleRook(uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    if ((from !== "e1" && from !== "e8") || from[1] !== to[1]) return null;
    const delta = to.charCodeAt(0) - from.charCodeAt(0);
    if (Math.abs(delta) !== 2) return null;
    return delta > 0 ? [`h${from[1]}`, `f${from[1]}`] : [`a${from[1]}`, `d${from[1]}`];
  }

  async function animateStage() {
    await piecesReady;
    const el = body.querySelector(".cfn-mini");
    const step = stage?.steps[stage.index - 1];
    const fromFen = stage?.fens[stage.index - 1];
    if (!el || !step || !fromFen) return Promise.resolve();
    const from = step.uci.slice(0, 2);
    const to = step.uci.slice(2, 4);
    drawBoard(el, fromFen, { last: [from, to] });
    const img = el.querySelector(`[data-sq="${from}"] img`);
    const dest = el.querySelector(`[data-sq="${to}"]`);
    const origin = el.querySelector(`[data-sq="${from}"]`);
    const ms = Math.round(380 / (stage.speed || 1));
    if (!img || !dest || !origin) return Promise.resolve();
    const a = origin.getBoundingClientRect();
    const b = dest.getBoundingClientRect();
    const before = fenPieces(fromFen);
    const after = fenPieces(stage.fens[stage.index]);
    for (const [sq, piece] of before) {
      if (sq === from) continue;
      const next = after.get(sq);
      if (!next || next.type !== piece.type || next.color !== piece.color) {
        const gone = el.querySelector(`[data-sq="${sq}"] img`);
        if (gone && gone !== img) {
          gone.style.transition = `opacity ${ms}ms ease`;
          gone.style.opacity = "0";
        }
      }
    }
    img.style.zIndex = "3";
    img.style.transition = `transform ${ms}ms ease`;
    img.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
    const rook = castleRook(step.uci);
    if (rook) {
      const rookImg = el.querySelector(`[data-sq="${rook[0]}"] img`);
      const rookFrom = el.querySelector(`[data-sq="${rook[0]}"]`);
      const rookTo = el.querySelector(`[data-sq="${rook[1]}"]`);
      if (rookImg && rookFrom && rookTo) {
        const c = rookFrom.getBoundingClientRect();
        const d = rookTo.getBoundingClientRect();
        rookImg.style.zIndex = "2";
        rookImg.style.transition = `transform ${ms}ms ease`;
        rookImg.style.transform = `translate(${d.left - c.left}px, ${d.top - c.top}px)`;
      }
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function advanceStage(dir) {
    const current = stage;
    if (!current || current.busy) return;
    const next = current.index + dir;
    if (next < 0 || next > current.steps.length) return;
    current.index = next;
    if (dir > 0 && next > 0) {
      current.busy = true;
      await animateStage();
      current.busy = false;
      if (stage !== current) return;
    }
    paintStage();
  }

  function pauseStage() {
    if (!stage) return;
    stage.playing = false;
    clearStageTimer();
    const play = body.querySelector("[data-insight='play']");
    if (play) play.classList.remove("is-on");
  }

  function playStage() {
    if (!stage?.steps.length) return;
    if (stage.playing) {
      pauseStage();
      return;
    }
    if (stage.index >= stage.steps.length) stage.index = 0;
    const current = stage;
    current.playing = true;
    paintStage();
    const loop = async () => {
      if (stage !== current || !current.playing) return;
      if (current.index >= current.steps.length) {
        pauseStage();
        return;
      }
      await advanceStage(1);
      if (stage !== current || !current.playing) return;
      current.timer = setTimeout(loop, 80);
    };
    current.timer = setTimeout(loop, 40);
  }

  function stageHtml(move) {
    const steps = Array.isArray(move.line) ? move.line : [];
    const moves = steps.map((step) => `<li>${esc(step.san)}</li>`).join("");
    const note = steps.length
      ? "Best line uses the engine evaluation from before the mistake, which already assumes this continuation."
      : "The engine did not return a longer legal continuation for this position.";
    return `
      <div class="cfn-stage">
        <div class="cfn-evals">
          <span>Before <b>${esc(shownEval(move.evalBefore, move.color))}</b></span>
          <span>After ${esc(move.san)} <b>${esc(shownEval(move.evalAfter, move.color))}</b></span>
          <span>Best line <b>${esc(shownEval(move.evalBefore, move.color))}</b></span>
        </div>
        <div class="cfn-mini" aria-label="Recommended continuation"></div>
        <div class="cfn-transport">
          <button type="button" data-insight="prev" title="Previous move" ${steps.length ? "" : "disabled"}>‹</button>
          <button type="button" data-insight="play" title="Play or pause" ${steps.length ? "" : "disabled"}>${stage?.playing ? "Pause" : "Play"}</button>
          <button type="button" data-insight="replay" title="Replay" ${steps.length ? "" : "disabled"}>Replay</button>
          <button type="button" data-insight="next" title="Next move" ${steps.length ? "" : "disabled"}>›</button>
          <label class="cfn-speed">Speed
            <select data-insight="speed">
              <option value="0.7" ${stage?.speed === 0.7 ? "selected" : ""}>0.7×</option>
              <option value="1" ${!stage?.speed || stage.speed === 1 ? "selected" : ""}>1×</option>
              <option value="1.6" ${stage?.speed === 1.6 ? "selected" : ""}>1.6×</option>
            </select>
          </label>
        </div>
        ${moves ? `<ol class="cfn-line">${moves}</ol>` : ""}
        <p class="cfn-eval-note">${note}</p>
      </div>`;
  }

  function insightTabs(pack) {
    const tabs = [
      { id: "takeaway", label: "Quick Takeaway", desc: "Discover the one move that could have changed your game." },
      { id: "opening", label: "Opening Mistakes", desc: "Learn from your three biggest opening mistakes." },
      {
        id: "endgame",
        label: "Endgame Takeaway",
        desc: pack?.endgameEligible
          ? "See the critical mistake that decided your endgame."
          : "Available for queenless endgames.",
        disabled: !pack?.endgameEligible,
      },
      { id: "puzzles", label: "Puzzles", desc: "Practice tactical challenges from your game." },
    ];
    if (insightTab === "endgame" && !pack?.endgameEligible) insightTab = "takeaway";
    const current = tabs.find((tab) => tab.id === insightTab) || tabs[0];
    const buttons = tabs
      .map((tab) => {
        const on = tab.id === current.id ? " is-on" : "";
        const off = tab.disabled ? " is-off" : "";
        const lock = tab.disabled ? `<i class="cfn-lock" aria-hidden="true"></i>` : "";
        return `<button type="button" class="cfn-tab${on}${off}" data-tab="${tab.id}" ${tab.disabled ? 'aria-disabled="true" title="Available for queenless endgames."' : ""}>${lock}${tab.label}</button>`;
      })
      .join("");
    return `<div class="cfn-tabs" role="tablist">${buttons}</div><p class="cfn-tab-desc">${esc(current.desc)}</p>`;
  }

  function insightBody(result, pack, color) {
    const who = norm((color === "w" ? result.white : result.black)?.name) === norm(settings.username) ? "Your" : "This";
    if (insightTab === "puzzles") {
      armStage(null);
      const button = retryButton(result);
      return button || `<p class="cfn-quiet">No tactical puzzles from the mistakes in this game.</p>`;
    }
    if (insightTab === "opening") {
      if (!pack.opening.length) {
        armStage(null);
        return `<p class="cfn-quiet">Great opening! No major mistakes found.</p>`;
      }
      const active = pack.opening.find((move) => move.ply === linePly) || null;
      if (active) armStage(active);
      else armStage(null);
      return pack.opening
        .map((move, index) => {
          const open = move.ply === linePly;
          return `
            <article class="cfn-miss">
              <h5>${esc(kindLabel(move.cls))} #${index + 1} — ${esc(moveLabel(move))}</h5>
              <p>${esc(move.text)}</p>
              <p class="cfn-miss-meta">${esc(move.best || "Best move")} · ${esc(String(move.drop))}% winning-chance loss</p>
              <button type="button" data-insight="line" data-line-ply="${move.ply}">${open ? "Hide line" : "View Better Line"}</button>
              ${open ? stageHtml(move) : ""}
            </article>`;
        })
        .join("");
    }
    if (insightTab === "endgame") {
      if (!pack.endgame) {
        armStage(null);
        return `<p class="cfn-quiet">No significant endgame blunder. The queenless ending was handled cleanly.</p>`;
      }
      armStage(pack.endgame);
      return `
        <h5 class="cfn-take-title">${who} last endgame ${esc(kindLabel(pack.endgame.cls).toLowerCase())}: ${esc(moveLabel(pack.endgame))}</h5>
        <p>${esc(pack.endgame.text)}</p>
        <p class="cfn-miss-meta">Correct move: ${esc(pack.endgame.best || "—")} · ${esc(String(pack.endgame.drop))}% winning-chance loss</p>
        ${stageHtml(pack.endgame)}`;
    }
    if (!pack.takeaway) {
      armStage(null);
      return `<p class="cfn-quiet">No single move cost a meaningful amount of evaluation.</p>`;
    }
    armStage(pack.takeaway);
    return `
      <h5 class="cfn-take-title">${who} critical mistake: ${esc(moveLabel(pack.takeaway))}</h5>
      <p>${esc(pack.takeaway.text)}</p>
      ${stageHtml(pack.takeaway)}`;
  }

  function queenlessFen(fen) {
    const board = String(fen || "").split(" ")[0];
    return !board.includes("Q") && !board.includes("q");
  }

  function moverCp(whiteCp, color) {
    if (whiteCp == null || Number.isNaN(Number(whiteCp))) return null;
    const value = Number(whiteCp);
    return color === "w" ? value : -value;
  }

  function formatEval(whiteCp, color) {
    const value = moverCp(whiteCp, color);
    if (value == null) return "unclear";
    if (Math.abs(value) >= 9000) return value > 0 ? "mate" : "getting mated";
    const pawns = value / 100;
    return `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
  }

  function explainMistake({ san, best, evalBefore, evalAfter, color }) {
    const before = moverCp(evalBefore, color);
    const after = moverCp(evalAfter, color);
    const alternative = best ? `playing ${best}` : "the engine's best move";
    const beforeText = formatEval(evalBefore, color);
    const afterText = formatEval(evalAfter, color);
    if (before == null || after == null) return `${san} was worse than ${alternative}.`;
    if (after <= -150 && before > -80) {
      return `${alternative} would have avoided a lost position. ${san} left the evaluation at ${afterText}.`;
    }
    if (before >= 150 && after < 80) {
      return `${alternative} would have kept a clear advantage. ${san} dropped it from ${beforeText} to ${afterText}.`;
    }
    const lost = before - after;
    if (lost >= 80) return `${alternative} holds the evaluation near ${beforeText} instead of ${afterText} after ${san}.`;
    return `${alternative} was the stronger choice. ${san} made the position worse by about ${Math.max(0, lost / 100).toFixed(1)} pawns.`;
  }

  function packInsight(ply) {
    return {
      ply: ply.ply,
      moveNumber: ply.moveNumber,
      color: ply.color,
      san: ply.san,
      uci: ply.uci,
      best: ply.best,
      bestUci: ply.bestUci,
      drop: ply.drop,
      cls: ply.cls,
      fen: ply.fen,
      evalBefore: ply.evalBefore ?? null,
      evalAfter: ply.evalAfter ?? null,
      line: Array.isArray(ply.line) ? ply.line : [],
      text: explainMistake({
        san: ply.san,
        best: ply.best,
        evalBefore: ply.evalBefore,
        evalAfter: ply.evalAfter,
        color: ply.color,
      }),
    };
  }

  function lossPawns(ply) {
    const before = moverCp(ply.evalBefore, ply.color);
    const after = moverCp(ply.evalAfter, ply.color);
    if (before == null || after == null) return 0;
    return Math.max(0, (before - after) / 100);
  }

  function buildInsights(plies, color) {
    const mine = (plies || []).filter((ply) => {
      const alt = ply.best || ply.bestUci;
      return ply.color === color && alt && alt !== "(none)";
    });
    const worth = (ply) =>
      ply.cls === "blunder" ||
      ply.cls === "mistake" ||
      ply.cls === "inaccuracy" ||
      (ply.drop || 0) >= 5 ||
      lossPawns(ply) >= 0.8;
    const serious = (ply) =>
      ply.cls === "blunder" || ply.cls === "mistake" || (ply.drop || 0) >= 10 || lossPawns(ply) >= 1.5;
    const takeaway =
      mine.filter((ply) => (ply.drop || 0) >= 5 || lossPawns(ply) >= 0.8).sort((a, b) => b.drop - a.drop || a.ply - b.ply)[0] ||
      null;
    const opening = mine
      .filter((ply) => ply.moveNumber <= 12 && worth(ply))
      .sort((a, b) => lossPawns(b) - lossPawns(a) || b.drop - a.drop || a.ply - b.ply)
      .slice(0, 3)
      .map(packInsight);
    const queenless = mine.filter((ply) => queenlessFen(ply.fen));
    const fromEnd = [...queenless].reverse();
    const endgame = fromEnd.find(serious) || fromEnd.find(worth) || null;
    return {
      takeaway: takeaway ? packInsight(takeaway) : null,
      opening,
      endgameEligible: queenless.length > 0,
      endgame: endgame ? packInsight(endgame) : null,
    };
  }

  function renderInsights(result) {
    const color = focusColor(result) || "w";
    const pack = result.plies?.length ? buildInsights(result.plies, color) : result.insights?.[color];
    if (!pack) {
      armStage(null);
      return `<p class="cfn-quiet">Run this review again to load the takeaway, opening, and endgame lines.</p>`;
    }
    const named = focusColor(result);
    const note = named ? "" : `<p class="cfn-quiet">Showing White. Open the game from ChessRadar to follow a specific player.</p>`;
    return `${note}${insightTabs(pack)}<div class="cfn-tab-panel">${insightBody(result, pack, color)}</div>`;
  }

  function renderResult(r) {
    const countCell = (cls, color, n) =>
      `<td class="cfn-rv-count${n ? " can-step" : ""}" data-cls="${cls}" data-color="${color}" title="${n ? "Click to step through these moves" : ""}">${n}</td>`;
    const rows = CLASSES.map(
      (c) => `
        <tr class="cfn-cls-${c.id}">
          ${countCell(c.id, "w", r.white.counts[c.id] || 0)}
          <td><span class="cfn-rv-icon">${c.icon}</span>${c.label}</td>
          ${countCell(c.id, "b", r.black.counts[c.id] || 0)}
        </tr>`
    ).join("");

    return `
      <div class="cfn-rv-players">${playerCard(shownPlayer(r.white, "white", r), "white")}${playerCard(shownPlayer(r.black, "black", r), "black")}</div>
      ${renderGraph(r)}
      <table class="cfn-rv-table">${rows}</table>
      ${renderInsights(r)}`;
  }

  function retryButton(result) {
    const built = puzzlePool(result);
    if (!built.items.length && !built.stale) return "";
    const label = built.own || !settings.username ? "Retry your blunders" : "Retry the blunders";
    return `<button class="cfn-rv-primary cfn-rv-retry" data-action="puzzles" type="button">${label}</button>`;
  }

  function puzzlePool(result) {
    const me = String(settings.username || "").trim().toLowerCase();
    const own =
      me && String(result.white?.name || "").toLowerCase() === me
        ? "w"
        : me && String(result.black?.name || "").toLowerCase() === me
          ? "b"
          : null;
    const rank = { blunder: 0, mistake: 1, inaccuracy: 2 };
    const items = (result.plies || [])
      .filter((p) => p.fen && p.bestUci && rank[p.cls] != null && (!own || p.color === own))
      .sort((a, b) => rank[a.cls] - rank[b.cls] || b.drop - a.drop)
      .slice(0, 5);
    return { own, items, stale: !(result.plies || []).some((p) => p.fen) };
  }

  const PIECE_RE = /\b([wb])([pnbrqk])\b/;
  const SQUARE_RE = /\bsquare-(\d)(\d)\b/;

  function sqName(fileRank) {
    return "abcdefgh"[Number(fileRank[0]) - 1] + fileRank[1];
  }

  function sqCode(name) {
    return `${"abcdefgh".indexOf(name[0]) + 1}${name[1]}`;
  }

  function mapFromFen(fen) {
    const map = new Map();
    const placement = String(fen || "").split(" ")[0] || "";
    let i = 0;
    for (const row of placement.split("/")) {
      for (const ch of row) {
        if (/\d/.test(ch)) i += Number(ch);
        else {
          map.set(`${(i % 8) + 1}${8 - Math.floor(i / 8)}`, {
            color: ch === ch.toUpperCase() ? "w" : "b",
            type: ch.toLowerCase(),
          });
          i += 1;
        }
      }
    }
    return map;
  }

  function mapFromPage() {
    const map = new Map();
    for (const el of document.querySelectorAll(".piece")) {
      const cls = el.className;
      if (typeof cls !== "string" || cls.includes("dragging")) continue;
      const p = cls.match(PIECE_RE);
      const sq = cls.match(SQUARE_RE);
      if (p && sq) map.set(`${sq[1]}${sq[2]}`, { color: p[1], type: p[2], el });
    }
    return map;
  }

  function samePiece(a, b) {
    return !!a && !!b && a.color === b.color && a.type === b.type;
  }

  function mapsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const [sq, piece] of a) {
      if (!samePiece(piece, b.get(sq))) return false;
    }
    return true;
  }

  function detectUci(before, after) {
    const leavers = [];
    for (const [sq, piece] of before) {
      if (!samePiece(piece, after.get(sq))) leavers.push({ sq, piece });
    }
    if (!leavers.length) return null;
    const mover = leavers.find((l) => l.piece.type === "k" && leavers.length > 1) || leavers[0];
    for (const [sq, piece] of after) {
      if (sq === mover.sq) continue;
      const was = before.get(sq);
      if (piece.color !== mover.piece.color) continue;
      if (mover.piece.type === "p" && piece.type !== "p" && "qrbn".includes(piece.type)) {
        if (!was || was.type === "p") return sqName(mover.sq) + sqName(sq) + piece.type;
      }
      if (piece.type === mover.piece.type && !samePiece(was, piece)) {
        return sqName(mover.sq) + sqName(sq);
      }
    }
    return null;
  }

  function boardClickTarget() {
    return (
      document.querySelector("wc-chess-board") ||
      document.querySelector("chess-board") ||
      document.querySelector("#board-layout-chessboard") ||
      document.querySelector(".board") ||
      document.querySelector(".piece")?.parentElement
    );
  }

  function clickPageSquare(name) {
    const code = sqCode(name);
    const piece = document.querySelector(`.piece.square-${code}`);
    if (piece) {
      piece.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      piece.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      piece.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }
    const host = boardClickTarget();
    if (!host) return false;
    const rect = host.getBoundingClientRect();
    if (!rect.width) return false;
    const flipped = !!document.querySelector(".coords-flipped, .flipped") ||
      [...document.querySelectorAll("text, .coordinate-light, .coordinate-dark")].some((el) => el.textContent?.trim() === "1" && el.getBoundingClientRect().top < rect.top + rect.height / 2);
    const file = "abcdefgh".indexOf(name[0]);
    const rank = Number(name[1]) - 1;
    const x = flipped ? 7 - file : file;
    const y = flipped ? rank : 7 - rank;
    const cx = rect.left + ((x + 0.5) / 8) * rect.width;
    const cy = rect.top + ((y + 0.5) / 8) * rect.height;
    const target = document.elementFromPoint(cx, cy) || host;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })
      );
    }
    return true;
  }

  function playUciOnPage(uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    clickPageSquare(from);
    setTimeout(() => clickPageSquare(to), 80);
  }

  function clearPuzzleMarks() {
    document.querySelectorAll("#cfn-puzzle-marks, #cfn-puzzle-toast").forEach((el) => el.remove());
  }

  function puzzleBoardRect() {
    const page = mapFromPage();
    const sample = page.values().next().value?.el;
    if (!sample) return null;
    const r = sample.getBoundingClientRect();
    if (!r.width) return null;
    const cls = sample.className.match(SQUARE_RE);
    if (!cls) return null;
    const file = Number(cls[1]);
    const rank = Number(cls[2]);
    const first = document.querySelector("svg.coordinates text");
    const flipped = first?.textContent.trim() === "1";
    const size = r.width;
    return {
      left: r.left - (flipped ? 8 - file : file - 1) * size,
      top: r.top - (flipped ? rank - 1 : 8 - rank) * size,
      size: size * 8,
      square: size,
      flipped,
    };
  }

  function markPuzzleMove(uci, ok) {
    clearPuzzleMarks();
    const rect = puzzleBoardRect();
    if (!rect || !uci) return;
    const layer = document.createElement("div");
    layer.id = "cfn-puzzle-marks";
    Object.assign(layer.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.size}px`,
      height: `${rect.size}px`,
      zIndex: "2147483001",
      pointerEvents: "none",
    });
    for (const name of [uci.slice(0, 2), uci.slice(2, 4)]) {
      const file = "abcdefgh".indexOf(name[0]);
      const rank = Number(name[1]) - 1;
      const x = rect.flipped ? 7 - file : file;
      const y = rect.flipped ? rank : 7 - rank;
      const mark = document.createElement("div");
      mark.className = `cfn-pz-mark ${ok ? "good" : "bad"}`;
      Object.assign(mark.style, {
        left: `${(x / 8) * 100}%`,
        top: `${(y / 8) * 100}%`,
        width: `${100 / 8}%`,
        height: `${100 / 8}%`,
      });
      if (name === uci.slice(2, 4)) {
        const badge = document.createElement("span");
        badge.className = "cfn-pz-badge";
        badge.textContent = ok ? "✓" : "✗";
        mark.append(badge);
      }
      layer.append(mark);
    }
    document.documentElement.append(layer);

    const toast = document.createElement("div");
    toast.id = "cfn-puzzle-toast";
    toast.className = ok ? "good" : "bad";
    toast.textContent = ok ? "Best move!" : "Wrong move";
    Object.assign(toast.style, {
      left: `${rect.left + rect.size / 2}px`,
      top: `${rect.top + rect.size - 12}px`,
    });
    document.documentElement.append(toast);
  }

  function stopPuzzleWatch() {
    clearInterval(puzzle?.watchTimer);
    clearTimeout(puzzle?.resetTimer);
    if (puzzle) {
      puzzle.watchTimer = null;
      puzzle.resetTimer = null;
      puzzle.armed = false;
    }
  }

  function armPuzzleWatch() {
    stopPuzzleWatch();
    if (!puzzle || puzzle.phase !== "try") return;
    const item = puzzle.items[puzzle.index];
    if (!item) return;
    puzzle.startMap = mapFromFen(item.fen);
    puzzle.armed = mapsEqual(mapFromPage(), puzzle.startMap);
    puzzle.watchTimer = setInterval(() => {
      if (!puzzle || puzzle.phase !== "try") return stopPuzzleWatch();
      const page = mapFromPage();
      if (!puzzle.armed) {
        if (mapsEqual(page, puzzle.startMap)) puzzle.armed = true;
        return;
      }
      const uci = detectUci(puzzle.startMap, page);
      if (!uci) return;
      stopPuzzleWatch();
      gradePuzzle(uci);
    }, 200);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let seekToken = 0;

  function pressKey(key) {
    const opts = { key, code: key, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent("keydown", opts));
  }

  async function seekPuzzle(item) {
    const token = ++seekToken;
    window.__cfnPuzzleActive = true;
    puzzle.seeking = true;
    const target = mapFromFen(item.fen);
    const steps = Math.max(0, item.ply - 1);
    if (steps === 0) {
      clickBoardControl(["first move", "skip to start", "go to start", "beginning"]);
      pressKey("Home");
    } else {
      jumpToPly(steps);
    }
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      if (token !== seekToken || !puzzle) return;
      if (mapsEqual(mapFromPage(), target)) {
        puzzle.seeking = false;
        puzzle.message = "";
        armPuzzleWatch();
        render();
        return;
      }
    }
    clickBoardControl(["first move", "skip to start", "go to start", "beginning"]);
    pressKey("Home");
    await sleep(120);
    for (let i = 0; i < steps; i++) {
      if (token !== seekToken || !puzzle) return;
      if (mapsEqual(mapFromPage(), target)) break;
      if (!clickBoardControl(["next move", "move forward"])) pressKey("ArrowRight");
      await sleep(30);
    }
    await sleep(80);
    if (token !== seekToken || !puzzle) return;
    puzzle.seeking = false;
    const opened = mapsEqual(mapFromPage(), target);
    puzzle.message = opened ? "" : "Could not open this blunder. Click that move in the move list, then play the correction.";
    armPuzzleWatch();
    render();
  }

  function showPuzzleSpot(item) {
    if (!item || !puzzle) return;
    clearPuzzleMarks();
    if (window.__cfnReviewData) {
      window.__cfnReviewData.focus = null;
      window.__cfnReviewData.focusAt = 0;
    }
    window.__cfnPuzzleActive = true;
    puzzle.message = "Opening the blunder on the board…";
    seekPuzzle(item);
  }

  function advancePuzzle() {
    if (!puzzle) return;
    stopPuzzleWatch();
    clearPuzzleMarks();
    puzzle.index += 1;
    puzzle.message = "";
    puzzle.tried = "";
    if (puzzle.index >= puzzle.items.length) {
      puzzle.phase = "summary";
      window.__cfnPuzzleActive = false;
    } else {
      puzzle.phase = "try";
      showPuzzleSpot(puzzle.items[puzzle.index]);
    }
    render();
  }

  function startPuzzles() {
    stopPuzzleWatch();
    clearPuzzleMarks();
    window.__cfnPuzzleActive = false;
    seekToken += 1;
    const built = puzzlePool(state.result);
    if (!built.items.length) {
      puzzle = {
        own: built.own,
        items: [],
        stale: built.stale,
        index: 0,
        phase: "empty",
        solvedCount: 0,
        message: "",
      };
      render();
      return;
    }
    const puzzles = built.items.map((p, i) => ({
      id: `${state.result.gameId || gameKey || "game"}-${p.ply}-${i}`,
      ply: p.ply,
      fen: p.fen,
      san: p.san,
      best: p.best,
      bestUci: p.bestUci,
      acceptedUcis: [String(p.bestUci).toLowerCase()],
      line: [String(p.bestUci).toLowerCase()],
      cls: p.cls,
      color: p.color,
      moveNumber: p.moveNumber,
      drop: p.drop,
    }));
    puzzle = null;
    render();
    chrome.runtime
      .sendMessage({
        type: "openPuzzleSession",
        session: {
          gameId: state.result.gameId || gameKey || "",
          orientation: built.own || "w",
          own: built.own,
          players: {
            white: playerSnapshot(state.result.white, "White"),
            black: playerSnapshot(state.result.black, "Black"),
          },
          evals: Array.isArray(state.result.evals) ? state.result.evals : [],
          marks: (state.result.plies || [])
            .filter((p) => p.cls === "brilliant" || p.cls === "inaccuracy" || p.cls === "mistake" || p.cls === "blunder")
            .map((p) => ({
              ply: p.ply,
              cls: p.cls,
              san: p.san,
              moveNumber: p.moveNumber,
              color: p.color,
            })),
          puzzles,
        },
      })
      .catch(() => {});
  }

  function renderPuzzle() {
    if (puzzle.phase === "empty") {
      const why = puzzle.stale
        ? "Review this game again so the puzzles can use each position."
        : puzzle.own
          ? "No inaccuracies, mistakes, or blunders of yours in this game."
          : "No inaccuracies, mistakes, or blunders to retry.";
      return `
        <div class="cfn-pz-card">
          <div class="cfn-pz-empty">
            <span class="cfn-pz-empty-icon">★</span>
            <p>${why}</p>
          </div>
          <button class="cfn-rv-secondary" data-action="puzzle-back" type="button">Back to review</button>
        </div>`;
    }
    if (puzzle.phase === "summary") {
      const total = puzzle.items.length;
      const score = puzzle.solvedCount;
      return `
        <div class="cfn-pz-card cfn-pz-summary">
          <div class="cfn-pz-score-ring">${score}<span>/${total}</span></div>
          <h3>Puzzle complete</h3>
          <p class="cfn-pz-who">You found ${score} of ${total} best moves.</p>
          <div class="cfn-pz-actions">
            <button class="cfn-rv-primary" data-action="puzzles" type="button">Try again</button>
            <button class="cfn-rv-secondary" data-action="puzzle-back" type="button">Back to review</button>
          </div>
        </div>`;
    }
    const item = puzzle.items[puzzle.index];
    const meta = byId[item.cls] || { label: "Mistake", icon: "?" };
    const who = puzzle.own
      ? "Your move"
      : settings.hideOpponent
        ? "Opponent to move"
        : item.color === "w"
          ? `${esc(state.result.white.name)} to move`
          : `${esc(state.result.black.name)} to move`;
    const noteClass =
      puzzle.phase === "solved" ? " is-good" : puzzle.phase === "wrong" ? " is-wrong" : "";
    const note =
      puzzle.phase === "solved"
        ? `Best was ${esc(item.best || item.bestUci)}. In the game you played ${esc(item.san)}.`
        : puzzle.phase === "wrong"
          ? `Wrong move${puzzle.tried ? ` (${esc(puzzle.tried)})` : ""}. Try again.`
          : puzzle.message || "Play the best move on the Chess.com board.";
    const next =
      puzzle.phase === "solved"
        ? `<button class="cfn-rv-primary" data-action="puzzle-next" type="button">${puzzle.index + 1 < puzzle.items.length ? "Next puzzle" : "See score"}</button>`
        : `<button class="cfn-rv-secondary" data-action="puzzle-reveal" type="button">Show answer</button>`;
    const dots = puzzle.items
      .map((_, i) => {
        const done = i < puzzle.index || (i === puzzle.index && puzzle.phase === "solved");
        const current = i === puzzle.index;
        return `<i class="${done ? "done" : ""}${current ? " current" : ""}"></i>`;
      })
      .join("");
    return `
      <div class="cfn-pz-card cfn-cls-${item.cls}${noteClass}">
        <div class="cfn-pz-top">
          <div class="cfn-pz-progress">
            <span class="cfn-pz-kicker">Puzzle</span>
            <strong>${puzzle.index + 1}<span> / ${puzzle.items.length}</span></strong>
          </div>
          <div class="cfn-pz-grade">
            <span class="cfn-rv-icon">${meta.icon}</span>
            <span>${meta.label}</span>
          </div>
        </div>
        <div class="cfn-pz-dots">${dots}</div>
        <div class="cfn-pz-meta">
          <span class="cfn-pz-chip">${who}</span>
          <span class="cfn-pz-chip">Move ${item.moveNumber}</span>
        </div>
        <p class="cfn-pz-note${noteClass}">${note}</p>
        <div class="cfn-pz-actions">${next}<button class="cfn-rv-secondary" data-action="puzzle-back" type="button">Back to review</button></div>
      </div>`;
  }

  function gradePuzzle(uci) {
    const item = puzzle.items[puzzle.index];
    const ok = uci.toLowerCase() === String(item.bestUci).toLowerCase();
    markPuzzleMove(uci, ok);
    if (ok) {
      puzzle.phase = "solved";
      puzzle.solvedCount += 1;
      puzzle.message = "";
      puzzle.tried = "";
      clearTimeout(puzzle.resetTimer);
      puzzle.resetTimer = setTimeout(() => {
        if (!puzzle || puzzle.phase !== "solved") return;
        advancePuzzle();
      }, 800);
    } else {
      puzzle.phase = "wrong";
      puzzle.tried = `${uci.slice(0, 2)}→${uci.slice(2, 4)}`;
      puzzle.message = "";
      clearTimeout(puzzle.resetTimer);
      puzzle.resetTimer = setTimeout(() => {
        if (!puzzle || (puzzle.phase !== "wrong" && puzzle.phase !== "try")) return;
        puzzle.phase = "try";
        puzzle.tried = "";
        showPuzzleSpot(item);
        render();
      }, 1800);
    }
    render();
  }

  function puzzleLocked() {
    return !!puzzle && (puzzle.phase === "try" || puzzle.phase === "wrong");
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!puzzleLocked() || puzzle.seeking || e.target.closest("#cfn-review")) return;
      const node = e.target.closest(".main-line-ply, .node, .move-list, button[data-cy*='move' i]");
      if (!node || e.target.closest(".piece, wc-chess-board, chess-board, .board")) return;
      e.preventDefault();
      e.stopPropagation();
      const item = puzzle.items[puzzle.index];
      if (puzzle.phase === "wrong") return;
      showPuzzleSpot(item);
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (!puzzleLocked() || puzzle.seeking) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  async function revealPuzzle() {
    const item = puzzle.items[puzzle.index];
    if (!item || puzzle.phase === "solved") return;
    clearTimeout(puzzle.resetTimer);
    puzzle.phase = "try";
    puzzle.tried = "";
    await seekPuzzle(item);
    if (!puzzle || puzzle.items[puzzle.index] !== item || puzzle.phase === "solved") return;
    if (!mapsEqual(mapFromPage(), mapFromFen(item.fen))) return;
    markPuzzleMove(item.bestUci, true);
    puzzle.message = `Play ${item.best || item.bestUci} on the board.`;
    render();
  }

  function renderGraph(r) {
    const W = 280;
    const H = 64;
    const n = r.evals.length - 1 || 1;
    const share = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    const pts = r.evals.map((cp, i) => [(i / n) * W, H - (share(cp) / 100) * H]);
    const area = `M0,${H} ${pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} L${W},${H} Z`;
    const marks = r.plies
      .filter((p) => p.cls === "blunder" || p.cls === "mistake" || p.cls === "brilliant" || p.cls === "inaccuracy")
      .map((p) => {
        const [x, y] = pts[p.ply];
        return `<circle class="cfn-cls-${p.cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" data-ply="${p.ply}"><title>${p.moveNumber}${p.color === "w" ? "." : "…"} ${esc(p.san)} (${byId[p.cls].label})</title></circle>`;
      })
      .join("");
    return `
      <svg class="cfn-rv-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <path d="${area}" class="cfn-rv-graph-white"></path>
        <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="cfn-rv-graph-mid"></line>
        ${marks}
      </svg>`;
  }

  function collectMoveNodes(root, out, seen) {
    if (!root?.querySelectorAll) return;
    for (const el of root.querySelectorAll(".main-line-ply, .node")) {
      if (seen.has(el)) continue;
      if (el.closest?.(".variation, .subline, .nested-lines")) continue;
      seen.add(el);
      out.push(el);
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectMoveNodes(el.shadowRoot, out, seen);
    }
  }

  // Selecting a move in chess.com's move list moves the board to that position.
  function jumpToPly(ply) {
    const nodes = [];
    collectMoveNodes(document, nodes, new Set());
    const node = nodes[ply - 1];
    if (!node) return false;
    node.scrollIntoView({ block: "center" });
    const target = node.querySelector(".node-highlight-content") || node.querySelector("button") || node;
    target.click?.();
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  root.addEventListener("change", (e) => {
    if (e.target.matches("[data-insight='speed']") && stage) stage.speed = Number(e.target.value) || 1;
  });

  root.addEventListener("click", (e) => {
    if (e.target.closest(".cfn-rv-close")) {
      open = false;
      sync();
      return;
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      if (tab.getAttribute("aria-disabled") === "true") return;
      insightTab = tab.dataset.tab;
      if (insightTab !== "opening") linePly = 0;
      render();
      return;
    }
    const insight = e.target.closest("[data-insight]");
    if (insight) {
      const kind = insight.dataset.insight;
      if (kind === "line") {
        const ply = Number(insight.dataset.linePly);
        linePly = linePly === ply ? 0 : ply;
        render();
        return;
      }
      if (kind === "play") playStage();
      else if (kind === "pause") pauseStage();
      else if (kind === "replay") {
        pauseStage();
        if (stage) {
          stage.index = 0;
          paintStage();
          playStage();
        }
      } else if (kind === "prev") {
        pauseStage();
        void advanceStage(-1);
      } else if (kind === "next") {
        pauseStage();
        void advanceStage(1);
      }
      return;
    }
    if (e.target.closest("[data-action='analyze']")) {
      runAnalysis(!!e.target.closest("[data-fresh='1']"));
      return;
    }
    if (e.target.closest("[data-action='puzzles']")) {
      stopPlay();
      startPuzzles();
      return;
    }
    if (e.target.closest("[data-action='puzzle-back']")) {
      seekToken += 1;
      stopPuzzleWatch();
      clearPuzzleMarks();
      window.__cfnPuzzleActive = false;
      puzzle = null;
      render();
      return;
    }
    if (e.target.closest("[data-action='puzzle-reveal']")) {
      revealPuzzle();
      return;
    }
    if (e.target.closest("[data-action='puzzle-next']")) {
      advancePuzzle();
      return;
    }
    const count = e.target.closest(".cfn-rv-count.can-step");
    if (count) {
      cycleClass(count.dataset.cls, count.dataset.color);
      return;
    }
    const navBtn = e.target.closest("[data-nav]");
    if (navBtn) {
      if (navBtn.dataset.nav === "play") togglePlay();
      else {
        stopPlay();
        if (navBtn.dataset.nav === "start") goTo(0);
        else if (navBtn.dataset.nav === "prev") goTo(cursor - 1);
        else if (navBtn.dataset.nav === "next") goTo(cursor + 1);
        else if (navBtn.dataset.nav === "end") goTo(plyCount());
      }
      return;
    }
    const target = e.target.closest("[data-ply]");
    if (target) {
      const plyNo = Number(target.dataset.ply);
      const ply = state.result?.plies?.find((p) => p.ply === plyNo);
      if (ply) showMove(ply);
      else jumpToPly(plyNo);
    }
  });

  const timer = setInterval(sync, 1000);

  function stop() {
    clearInterval(timer);
    stopPlay();
    stopStage();
    stopPuzzleWatch();
    clearPuzzleMarks();
    window.__cfnPuzzleActive = false;
    window.__cfnTools?.remove("analyze");
    window.__cfnTools?.setPanelOpen(false);
    root.remove();
    window.__cfnReviewData = null;
  }
  window.__cfnReviewStop = stop;
})();
