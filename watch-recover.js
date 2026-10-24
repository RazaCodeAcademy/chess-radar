// If Chess.com boots a spectator off a live game onto /play/online, try once more
// with the session cookies, then explain when the game is private.
(() => {
  if (window.__cfnWatchRecover) return;
  window.__cfnWatchRecover = true;

  const playLobby = /\/play\/online\/?$/i.test(location.pathname) && !location.hash.includes("g=");

  async function meta() {
    try {
      return await chrome.runtime.sendMessage({ type: "watchTabMeta" });
    } catch {
      return null;
    }
  }

  function banner(text, href) {
    if (document.getElementById("cfn-watch-banner")) return;
    const el = document.createElement("div");
    el.id = "cfn-watch-banner";
    el.style.cssText =
      "position:fixed;z-index:2147483000;left:50%;bottom:24px;transform:translateX(-50%);" +
      "max-width:min(440px,calc(100vw - 24px));padding:12px 14px;border-radius:10px;" +
      "background:#262421;color:#e8e6e3;font:13px/1.4 system-ui,Segoe UI,sans-serif;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.45);border:1px solid #3c3a37;display:flex;gap:10px;align-items:center";
    const msg = document.createElement("div");
    msg.textContent = text;
    el.append(msg);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = "Profile";
      a.style.cssText = "flex:none;color:#fff;background:#81b64c;padding:6px 10px;border-radius:8px;text-decoration:none;font-weight:700";
      el.append(a);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.style.cssText = "flex:none;border:0;background:transparent;color:#a7a6a2;font-size:18px;cursor:pointer";
    x.onclick = () => el.remove();
    el.append(x);
    document.documentElement.append(el);
  }

  async function recover() {
    if (!playLobby || !chrome.runtime?.id) return;
    const info = await meta();
    if (!info?.gameId || !info?.username) return;
    if (sessionStorage.getItem(`cfn-watch-tried-${info.gameId}`)) {
      banner(
        `Chess.com blocked live spectating for ${info.username} (often a private game). Friends can still watch.`,
        `https://www.chess.com/member/${encodeURIComponent(info.username)}`
      );
      return;
    }
    sessionStorage.setItem(`cfn-watch-tried-${info.gameId}`, "1");

    try {
      const res = await fetch(`https://www.chess.com/callback/live/game/${info.gameId}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.game && !data.game.isFinished) {
          location.href = `https://www.chess.com/game/live/${info.gameId}?cfn=${encodeURIComponent(info.username)}`;
          return;
        }
      }
    } catch {
      // fall through to banner
    }

    banner(
      `Chess.com blocked live spectating for ${info.username} (often a private game). Friends can still watch.`,
      `https://www.chess.com/member/${encodeURIComponent(info.username)}`
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(recover, 800), { once: true });
  } else {
    setTimeout(recover, 800);
  }
})();
