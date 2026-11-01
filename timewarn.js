// Visual Time Warning: glowing board border when you're up or down on the clock.
(() => {
  window.__cfnTimeWarnStop?.();
  document.querySelectorAll("#cfn-timewarn").forEach((el) => el.remove());

  const PIECE_RE = /\b([wb])([pnbrqk])\b/;
  const SQUARE_RE = /\bsquare-(\d)(\d)\b/;
  const EVEN_MS = 1500; // treat within 1.5s as even
  const URGENT_MS = 10000;

  let settings = { username: "", timeWarning: true };
  let raf = 0;

  const ring = document.createElement("div");
  ring.id = "cfn-timewarn";
  ring.setAttribute("aria-hidden", "true");
  document.documentElement.append(ring);

  chrome.storage.local.get("settings").then(({ settings: s = {} }) => {
    settings = { ...settings, ...s };
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.settings) return;
    settings = { ...settings, ...changes.settings.newValue };
    if (settings.timeWarning === false) hide();
  });

  const norm = (s) => String(s || "").trim().toLowerCase();

  function onGamePage() {
    return /\/(?:game|play\/)/.test(location.pathname) || !!document.querySelector("wc-chess-board, chess-board");
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

  function clockText(side) {
    const root = document.querySelector(`#board-layout-player-${side}`);
    if (!root) return "";
    const el =
      root.querySelector(".clock-time-monospace, [class*='clock-time'], .clock-component, [class*='clock']") ||
      root.querySelector("[data-cy='clock'], [data-clock]");
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
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
    return ((h * 3600 + m * 60 + sec) * 1000) + ms;
  }

  function isFlipped() {
    const first = document.querySelector("svg.coordinates text");
    return first?.textContent.trim() === "1";
  }

  function boardRect() {
    const pieces = [];
    for (const el of document.querySelectorAll(".piece")) {
      const cls = el.className;
      if (typeof cls !== "string" || cls.includes("dragging")) continue;
      const p = cls.match(PIECE_RE);
      const sq = cls.match(SQUARE_RE);
      if (p && sq) pieces.push({ key: `${sq[1]}${sq[2]}`, el });
    }
    if (pieces.length) {
      const { key, el } = pieces[0];
      const r = el.getBoundingClientRect();
      if (r.width) {
        const flipped = isFlipped();
        const file = Number(key[0]);
        const rank = Number(key[1]);
        const size = r.width;
        return {
          left: r.left - (flipped ? 8 - file : file - 1) * size,
          top: r.top - (flipped ? rank - 1 : 8 - rank) * size,
          size: size * 8,
        };
      }
    }
    const host =
      document.querySelector("wc-chess-board, chess-board") ||
      document.getElementById("board-layout-chessboard");
    const r = host?.getBoundingClientRect();
    if (!r?.width) return null;
    const size = Math.min(r.width, r.height);
    return { left: r.left + (r.width - size) / 2, top: r.top + (r.height - size) / 2, size };
  }

  function mySide(me) {
    if (!me) return "";
    if (playerName("bottom") === me) return "bottom";
    if (playerName("top") === me) return "top";
    return "";
  }

  function hide() {
    ring.className = "";
    ring.style.display = "none";
  }

  function paint(rect, mode, urgent) {
    Object.assign(ring.style, {
      display: "block",
      left: `${rect.left - 4}px`,
      top: `${rect.top - 4}px`,
      width: `${rect.size + 8}px`,
      height: `${rect.size + 8}px`,
    });
    ring.className = `is-on is-${mode}${urgent ? " is-urgent" : ""}`;
  }

  function tick() {
    if (settings.timeWarning === false || !onGamePage()) {
      hide();
      return;
    }
    const me = norm(settings.username);
    if (!me) {
      hide();
      return;
    }
    const side = mySide(me);
    if (!side) {
      // Only in your own games.
      hide();
      return;
    }
    const opp = side === "bottom" ? "top" : "bottom";
    const mine = parseClockMs(clockText(side));
    const theirs = parseClockMs(clockText(opp));
    const rect = boardRect();
    if (mine == null || theirs == null || !rect) {
      hide();
      return;
    }

    const diff = mine - theirs;
    let mode = "even";
    if (diff > EVEN_MS) mode = "up";
    else if (diff < -EVEN_MS) mode = "down";
    const urgent = mine <= URGENT_MS || (mode === "down" && Math.abs(diff) >= 15000);
    paint(rect, mode, urgent);
  }

  function loop() {
    tick();
    raf = window.setTimeout(loop, 250);
  }

  loop();
  window.addEventListener("resize", tick);
  window.addEventListener("scroll", tick, true);

  window.__cfnTimeWarnStop = () => {
    clearTimeout(raf);
    hide();
    ring.remove();
    delete window.__cfnTimeWarnStop;
  };
})();
