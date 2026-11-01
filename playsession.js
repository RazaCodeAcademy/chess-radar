// Play Sessions: track a games/minutes goal and auto-queue New Game / Rematch until done.
(() => {
  window.__cfnPlaySessionStop?.();
  document.querySelectorAll("#cfn-playsession").forEach((el) => el.remove());

  const QUEUE_COOLDOWN_MS = 3500;
  const FINISH_DELAY_MS = 1200;
  const norm = (s) => String(s || "").trim().toLowerCase();

  let settings = { username: "" };
  let session = null;
  let tickTimer = 0;
  let observer = null;
  let pendingQueue = null;
  let lastQueuedGameId = "";
  let lastQueueAt = 0;
  let knownLiveGameId = "";

  const hud = document.createElement("div");
  hud.id = "cfn-playsession";
  hud.hidden = true;
  hud.innerHTML = `
    <div class="cfn-ps-card" role="status" aria-live="polite">
      <div class="cfn-ps-top">
        <span class="cfn-ps-title">Play Session</span>
        <button type="button" class="cfn-ps-stop" title="Stop session">Stop</button>
      </div>
      <div class="cfn-ps-progress"></div>
      <div class="cfn-ps-bar"><span class="cfn-ps-fill"></span></div>
      <div class="cfn-ps-hint"></div>
    </div>
  `;
  document.documentElement.append(hud);
  const els = {
    progress: hud.querySelector(".cfn-ps-progress"),
    fill: hud.querySelector(".cfn-ps-fill"),
    hint: hud.querySelector(".cfn-ps-hint"),
    stop: hud.querySelector(".cfn-ps-stop"),
  };

  els.stop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "playSessionStop" }).catch(() => {});
  });

  function loadState() {
    return chrome.storage.local.get(["settings", "playSession"]).then((data) => {
      settings = { ...settings, ...(data.settings || {}) };
      session = data.playSession?.active ? data.playSession : null;
      renderHud();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) settings = { ...settings, ...changes.settings.newValue };
    if (changes.playSession) {
      const next = changes.playSession.newValue;
      session = next?.active ? next : null;
      if (!session) {
        clearTimeout(pendingQueue);
        pendingQueue = null;
        lastQueuedGameId = "";
      }
      renderHud();
      tick();
    }
  });

  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node?.querySelectorAll) return;
      try {
        out.push(...node.querySelectorAll(selector));
      } catch {
        // ignore invalid selectors in odd trees
      }
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  function btnText(el) {
    return `${el?.getAttribute?.("aria-label") || ""} ${el?.textContent || ""}`.replace(/\s+/g, " ").trim();
  }

  function currentGameId() {
    const path = location.pathname;
    const m =
      path.match(/\/(?:analysis\/)?game\/(?:(live|daily)\/)?(\d+)/) ||
      path.match(/\/game\/review\/(?:(live|daily)\/)?(\d+)/) ||
      path.match(/\/play\/(?:online\/)?game\/(?:(live|daily)\/)?(\d+)/);
    if (m) return m[2];
    const q = new URLSearchParams(location.search);
    const id = q.get("gameId") || q.get("game") || "";
    return /^\d+$/.test(id) ? id : "";
  }

  function playerName(side) {
    const root = document.querySelector(`#board-layout-player-${side}`);
    if (!root) return "";
    const el =
      root.querySelector(".cc-user-username-component, [data-test-element='user-tagline-username']") ||
      root.querySelector("a[href*='/member/']");
    const href = el?.getAttribute?.("href") || "";
    const fromHref = href.match(/\/member\/([^/?#]+)/)?.[1];
    return norm(fromHref || el?.textContent);
  }

  function iAmPlaying() {
    const me = norm(settings.username);
    if (!me) return false;
    return playerName("bottom") === me || playerName("top") === me;
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
        ".game-over-modal-header-component",
        "[class*='player-game-over']",
        "[class*='game-over-modal']",
        "[data-cy='game-over']",
        "[data-cy='game-over-modal']",
        "button[aria-label*='Game Review' i]",
      ].join(",")
    );
  }

  function goalReached(s = session) {
    if (!s?.active) return true;
    if (s.mode === "minutes") {
      return Date.now() - (s.startedAt || 0) >= Number(s.goal || 0) * 60_000;
    }
    return Number(s.gamesDone || 0) >= Number(s.goal || 0);
  }

  function progressLabel(s = session) {
    if (!s?.active) return "";
    if (s.mode === "minutes") {
      const elapsed = Math.max(0, Date.now() - (s.startedAt || 0));
      const total = Math.max(1, Number(s.goal || 1) * 60_000);
      const left = Math.max(0, total - elapsed);
      const mins = Math.floor(left / 60_000);
      const secs = Math.floor((left % 60_000) / 1000);
      return `${mins}:${String(secs).padStart(2, "0")} left · ${s.gamesDone || 0} games`;
    }
    return `${s.gamesDone || 0} / ${s.goal} games`;
  }

  function progressRatio(s = session) {
    if (!s?.active) return 0;
    if (s.mode === "minutes") {
      const elapsed = Math.max(0, Date.now() - (s.startedAt || 0));
      const total = Math.max(1, Number(s.goal || 1) * 60_000);
      return Math.min(1, elapsed / total);
    }
    return Math.min(1, Number(s.gamesDone || 0) / Math.max(1, Number(s.goal || 1)));
  }

  function renderHud() {
    if (!session?.active) {
      hud.hidden = true;
      return;
    }
    hud.hidden = false;
    els.progress.textContent = progressLabel();
    els.fill.style.width = `${Math.round(progressRatio() * 100)}%`;
    const target = session.queueTarget === "rematch" ? "Rematch" : "New Game";
    els.hint.textContent = goalReached()
      ? "Goal reached — finishing this game"
      : `Auto-queue: ${target}`;
  }

  function findButton(match) {
    const buttons = deepQueryAll("button, a[role='button'], [role='button']");
    return buttons.find((el) => {
      if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return match(btnText(el), el);
    });
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch {
      return false;
    }
  }

  function declineRematchOffer() {
    const decline = findButton((t) => /^decline$/i.test(t.trim()) || /\bdecline\b/i.test(t));
    if (decline) clickEl(decline);
  }

  function clickQueueTarget() {
    const preferRematch = session?.queueTarget === "rematch";

    if (!preferRematch) declineRematchOffer();

    const rematch = findButton((t, el) => {
      const label = (el.getAttribute("aria-label") || "").trim();
      return /^rematch$/i.test(label) || /^rematch$/i.test(t.trim()) || /\brematch\b/i.test(t);
    });

    if (preferRematch && rematch) return clickEl(rematch);

    const scoped =
      document.querySelector(".game-over-buttons-component") ||
      document.querySelector(".game-over-modal-content") ||
      document.querySelector("[class*='game-over-buttons']");

    if (scoped) {
      const candidates = [...scoped.querySelectorAll("button, a[role='button']")].filter((el) => {
        const t = btnText(el);
        return !/rematch|review|share|close|decline|analysis/i.test(t);
      });
      const newBtn =
        candidates.find((el) => /new\s*game|^new$/i.test(btnText(el))) ||
        candidates.find((el) => /play again|play/i.test(btnText(el))) ||
        candidates[0];
      if (newBtn) return clickEl(newBtn);
    }

    const newGame = findButton((t) => /\bnew\s*game\b/i.test(t) || /^new$/i.test(t.trim()));
    if (newGame) return clickEl(newGame);

    if (!preferRematch && rematch) return false;

    // Sidebar / play panel: primary Play after opening New Game tab
    const playTab = findButton((t) => /^new\s*game$/i.test(t.trim()));
    if (playTab) clickEl(playTab);

    const play = findButton((t, el) => {
      const primary = /cc-button-primary|button-primary/i.test(el.className || "");
      return primary && /\bplay\b/i.test(t) && !/playbots|puzzles|lessons/i.test(t);
    });
    if (play) return clickEl(play);

    return false;
  }

  function scheduleQueue(gameId) {
    if (!session?.active || goalReached()) return;
    if (gameId && lastQueuedGameId === gameId) return;
    if (Date.now() - lastQueueAt < QUEUE_COOLDOWN_MS) return;

    clearTimeout(pendingQueue);
    pendingQueue = setTimeout(() => {
      pendingQueue = null;
      if (!session?.active || goalReached()) return;
      if (looksLivePlaying()) return;
      if (Date.now() - lastQueueAt < QUEUE_COOLDOWN_MS) return;
      if (clickQueueTarget()) {
        lastQueuedGameId = gameId || lastQueuedGameId;
        lastQueueAt = Date.now();
        els.hint.textContent = "Queued…";
      }
    }, FINISH_DELAY_MS);
  }

  async function recordFinishedGame(gameId) {
    if (!gameId || !session?.active) return;
    if ((session.countedIds || []).includes(gameId)) {
      if (!goalReached()) scheduleQueue(gameId);
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: "playSessionRecordGame", gameId });
      if (res?.session) session = res.session.active ? res.session : null;
      renderHud();
      if (session?.active && !goalReached()) scheduleQueue(gameId);
    } catch {
      // ignore
    }
  }

  async function checkMinutesGoal() {
    if (!session?.active || session.mode !== "minutes") return;
    if (!goalReached()) return;
    try {
      await chrome.runtime.sendMessage({ type: "playSessionComplete", reason: "time" });
    } catch {
      // ignore
    }
  }

  function tick() {
    if (!chrome.runtime?.id) return stop();
    renderHud();
    if (!session?.active) return;

    const gameId = currentGameId();
    if (looksLivePlaying() && iAmPlaying() && gameId) {
      knownLiveGameId = gameId;
      return;
    }

    if (looksFinished() && iAmPlaying()) {
      const id = gameId || knownLiveGameId;
      if (id) recordFinishedGame(id);
      else if (!goalReached()) scheduleQueue("");
    } else if (!looksLivePlaying() && session.active && !goalReached()) {
      // Already on play page between games — keep trying to queue.
      if (/\/play\//.test(location.pathname)) scheduleQueue(lastQueuedGameId || "lobby");
    }

    checkMinutesGoal();
  }

  function stop() {
    clearInterval(tickTimer);
    clearTimeout(pendingQueue);
    observer?.disconnect();
    observer = null;
    hud.remove();
    delete window.__cfnPlaySessionStop;
  }

  window.__cfnPlaySessionStop = stop;

  loadState().then(() => {
    tickTimer = setInterval(tick, 1000);
    observer = new MutationObserver(() => tick());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    tick();
  });
})();
