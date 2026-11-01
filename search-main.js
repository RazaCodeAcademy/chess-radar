(() => {
  const unpack = (data, out = []) => {
    if (!data) return out;
    if (Array.isArray(data)) {
      for (const item of data) unpack(item, out);
      return out;
    }
    if (typeof data !== "object") return out;
    const row = data.userView || data.user_view || data.user || data;
    if (row && (row.username || row.userName)) out.push(data);
    const skip = new Set(["pagination", "meta", "error", "status", "pageInfo", "page_info"]);
    for (const [key, val] of Object.entries(data)) {
      if (skip.has(key) || val == null || typeof val !== "object") continue;
      unpack(val, out);
    }
    return out;
  };

  const nextPageToken = (data) => {
    if (!data || typeof data !== "object") return "";
    return String(
      data.pagination?.nextPageToken ||
        data.pagination?.next_page_token ||
        data.nextPageToken ||
        data.next_page_token ||
        data.pageToken ||
        data.page_token ||
        ""
    ).trim();
  };

  const toUser = (raw) => {
    const row = raw?.userView || raw?.user_view || raw?.user || raw || {};
    const first = row.firstName || row.first_name || "";
    const last = row.lastName || row.last_name || "";
    return {
      username: String(row.username || row.userName || "").trim(),
      avatar: row.avatar || row.avatarUrl || row.avatar_url || "",
      title: row.chessTitle || row.chess_title || row.title || "",
      name: row.name || [first, last].filter(Boolean).join(" "),
    };
  };

  const pageUsername = (fallback) => {
    const fromWin =
      window.chesscom?.user?.username ||
      window.chesscom?.username ||
      window.chesscom?.context?.user?.username;
    if (fromWin) return String(fromWin);
    const el = document.querySelector("[data-username], [data-user-username]");
    if (el) return el.getAttribute("data-username") || el.getAttribute("data-user-username") || "";
    const href = document.querySelector('a[href^="/member/"], a[href*="chess.com/member/"]')?.getAttribute("href") || "";
    const m = href.match(/\/member\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : fallback || "";
  };

  const pull = async (req) => {
    try {
      const res = await req;
      if (!res.ok) return [];
      return unpack(await res.json()).map(toUser).filter((u) => u.username);
    } catch {
      return [];
    }
  };

  const search = async (query, me) => {
    const q = String(query || "").trim();
    if (!q) return [];
    const enc = encodeURIComponent(q);
    const user = pageUsername(me);
    const body = {
      prefix: q.slice(0, 20),
      includeSuggestions: true,
      includeFriends: true,
      suggestionsLimit: 8,
      friendsLimit: 8,
      boostUsername: true,
      exactUsernameFirst: true,
    };
    const headers = {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      accept: "application/json",
    };
    const reqs = [
      fetch("/service/friends-search/chesscom.friends_search.v1.FriendsSearch/Autocomplete", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
      }),
      fetch("/service/friends-search/chesscom.friends_search.v1.FriendsSearch/Autocomplete", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          prefix: body.prefix,
          include_suggestions: true,
          include_friends: true,
          suggestions_limit: 8,
          friends_limit: 8,
          boost_username: true,
          exact_username_first: true,
        }),
      }),
      fetch(`/callback/user/search?query=${enc}&activeDays=4000`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
      fetch(`/callback/user/search/chess?query=${enc}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    ];
    if (user) {
      reqs.push(
        fetch(`/${encodeURIComponent(user)}/callback/user/search?query=${enc}&activeDays=4000`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        })
      );
    }
    const chunks = await Promise.all(reqs.map(pull));
    return chunks.flat();
  };

  const FRIENDS_RPC_MAX_PAGES = 50;
  const FRIENDS_RPC_PAGE_SIZE = 100;
  const FRIENDS_HTML_MAX_PAGES = 100;

  const queryFriendsAllPages = async () => {
    const headers = {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      accept: "application/json",
    };
    const found = new Map();
    let pageToken = "";
    let offset = 0;
    let useOffset = false;

    for (let i = 0; i < FRIENDS_RPC_MAX_PAGES; i++) {
      const pagination = {
        pageSize: FRIENDS_RPC_PAGE_SIZE,
        page_size: FRIENDS_RPC_PAGE_SIZE,
      };
      if (pageToken) {
        pagination.pageToken = pageToken;
        pagination.page_token = pageToken;
      } else if (useOffset && offset > 0) {
        pagination.skip = offset;
        pagination.offset = offset;
        pagination.page = Math.floor(offset / FRIENDS_RPC_PAGE_SIZE) + 1;
      }

      let users = [];
      let token = "";
      try {
        const res = await fetch("/service/friends-search/chesscom.friends_search.v1.FriendsSearch/QueryFriends", {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({
            includePresenceStatus: false,
            include_presence_status: false,
            pagination,
            query: { query: {} },
          }),
        });
        if (!res.ok) break;
        const raw = await res.json();
        users = unpack(raw).map(toUser).filter((u) => u.username);
        token = nextPageToken(raw);
      } catch {
        break;
      }

      const before = found.size;
      for (const u of users) found.set(String(u.username).toLowerCase(), u);
      if (found.size === before) break;

      if (token && token !== pageToken) {
        pageToken = token;
        useOffset = false;
        continue;
      }
      if (users.length < FRIENDS_RPC_PAGE_SIZE) break;

      useOffset = true;
      pageToken = "";
      offset += users.length;
    }

    return [...found.values()];
  };

  const scrapeFriendsHtml = async (user) => {
    const names = new Map();
    const me = String(user || "").toLowerCase();
    const maxPages = user ? FRIENDS_HTML_MAX_PAGES : 1;
    for (let page = 1; page <= maxPages; page++) {
      try {
        const path = user
          ? `/member/${encodeURIComponent(user)}/friends${page > 1 ? `?page=${page}` : ""}`
          : "/friends";
        const res = await fetch(path, { credentials: "include" });
        if (!res.ok) break;
        const html = await res.text();
        const before = names.size;
        const re = /\/member\/([A-Za-z0-9_-]+)/gi;
        let m;
        while ((m = re.exec(html))) {
          if (!m[1] || m[1].toLowerCase() === me) continue;
          const key = m[1].toLowerCase();
          if (!names.has(key)) names.set(key, { username: m[1], avatar: "", title: "", name: "" });
        }
        if (names.size === before) break;
        if (!user) break;
      } catch {
        break;
      }
    }
    return [...names.values()];
  };

  const listFriends = async (me) => {
    const user = pageUsername(me);
    const reqs = [
      fetch("/callback/friends/all", {
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    ];
    if (user) {
      reqs.push(
        fetch(`/callback/friends/${encodeURIComponent(user)}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        })
      );
    }
    const [callbackUsers, rpcUsers, htmlUsers] = await Promise.all([
      Promise.all(reqs.map(pull)).then((chunks) => chunks.flat()),
      queryFriendsAllPages().catch(() => []),
      scrapeFriendsHtml(user).catch(() => []),
    ]);

    const found = new Map();
    for (const u of [...callbackUsers, ...rpcUsers, ...htmlUsers]) {
      if (u?.username) found.set(String(u.username).toLowerCase(), u);
    }
    return [...found.values()];
  };

  const deepQueryAll = (selector, root = document) => {
    const out = [];
    const visit = (node) => {
      if (!node?.querySelectorAll) return;
      try {
        out.push(...node.querySelectorAll(selector));
      } catch {
        // invalid selector in this root
      }
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  };

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    return !!r && r.width + r.height > 0;
  };

  const tap = (el) => {
    if (!el) return false;
    el.scrollIntoView?.({ block: "center", inline: "nearest" });
    const target =
      el.querySelector?.(".node-highlight-content, .move-text-component, .move-text") || el;
    try {
      target.focus?.();
    } catch {
      // ignore
    }
    target.click?.();
    return true;
  };

  const jumpToPly = (ply, hint) => {
    const n = Math.max(0, Number(ply) || 0);
    if (n <= 0) {
      const starters = deepQueryAll(
        '#board-controls-first, [data-cy="first-move"], [aria-label*="First" i], [aria-label*="Start" i], [aria-label*="Beginning" i]'
      ).filter(visible);
      if (starters[0] && tap(starters[0])) return true;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", code: "Home", bubbles: true }));
      return true;
    }

    const byPly = deepQueryAll(`[data-ply="${n}"]`).filter(visible);
    const node =
      byPly.find((el) => el.classList?.contains("node") || el.classList?.contains("main-line-ply")) ||
      byPly[0];
    if (node && tap(node)) return true;

    const allPly = deepQueryAll("[data-ply]")
      .filter((el) => visible(el) && (el.classList?.contains("node") || el.hasAttribute("data-ply")))
      .sort((a, b) => Number(a.getAttribute("data-ply")) - Number(b.getAttribute("data-ply")));
    const match = allPly.find((el) => Number(el.getAttribute("data-ply")) === n) || allPly[n - 1];
    if (match && tap(match)) return true;

    if (hint?.san) {
      const needle = String(hint.san).replace(/[+#=!?]/g, "").toLowerCase();
      const moveNo = String(hint.moveNumber || "");
      const texts = deepQueryAll(
        ".node, .main-line-ply, .node-highlight-content, .move-text-component, [data-ply]"
      ).filter(visible);
      const hit = texts.find((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return text.includes(needle) && (!moveNo || text.includes(moveNo));
      });
      if (hit && tap(hit)) return true;
    }

    const contents = deepQueryAll(
      "vertical-move-list .node, .main-line-row .node, .main-line-ply, .node-highlight-content"
    ).filter(visible);
    if (contents[n - 1] && tap(contents[n - 1])) return true;
    return false;
  };

  window.__cfnPageHandler = async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data?.id) return;
    if (data.type === "cfn-search") {
      try {
        const users = await search(data.query, data.me);
        window.postMessage({ type: "cfn-search-result", id: data.id, users }, "*");
      } catch {
        window.postMessage({ type: "cfn-search-result", id: data.id, users: [] }, "*");
      }
      return;
    }
    if (data.type === "cfn-friends") {
      try {
        const users = await listFriends(data.me);
        window.postMessage({ type: "cfn-friends-result", id: data.id, users }, "*");
      } catch {
        window.postMessage({ type: "cfn-friends-result", id: data.id, users: [] }, "*");
      }
      return;
    }
    if (data.type === "cfn-jump") {
      let ok = false;
      try {
        const stepBack = async () => {
          await new Promise((r) => setTimeout(r, 100));
          const back = deepQueryAll(
            '#board-controls-backward, [data-cy="previous-move"], [aria-label*="Previous" i], [aria-label*="Back" i]'
          ).filter(visible)[0];
          if (back) tap(back);
          else window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true }));
        };
        // Prefer the blunder move itself (easy to find), then step back so the user can play the correction.
        if (data.blunderPly) {
          ok = jumpToPly(data.blunderPly, data.blunderHint || null);
          if (ok && data.ply >= 0 && data.ply !== data.blunderPly) await stepBack();
        }
        if (!ok) ok = jumpToPly(data.ply, data.hint || null);
      } catch {
        ok = false;
      }
      window.postMessage({ type: "cfn-jump-result", id: data.id, ok }, "*");
    }
  };

  if (!window.__cfnSearchReady) {
    window.__cfnSearchReady = true;
    window.addEventListener("message", (event) => window.__cfnPageHandler?.(event));
  }
})();
