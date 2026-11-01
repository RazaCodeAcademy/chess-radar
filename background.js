const BASE = "https://www.chess.com";
const PUB = "https://api.chess.com/pub";
const POLL_ALARM = "poll";
const PRESENCE_BATCH = 50;
const PRESENCE_TIMEOUT_MS = 8000;
const RESULT_WAIT_MS = 15 * 60 * 1000;
const TIME_CLASSES = ["bullet", "blitz", "rapid", "daily"];
const DRAW_RESULTS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

const DEFAULT_SETTINGS = {
  username: "",
  intervalSec: 60,
  notificationsEnabled: true,
  notifyOnline: false,
  notifyResults: true,
  tiltLimit: 3,
  timeclasses: { bullet: true, blitz: true, rapid: true, daily: true },
  watchedPlayers: [],
  hiddenPlayers: [],
  followNextGame: true,
  analyzeGame: true,
  hideOpponent: false,
  blunderAlerts: false,
  engineId: "stockfish-lite",
};

// ---------- storage helpers ----------

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    watchedPlayers: settings.watchedPlayers || settings.manualFriends || [],
    hiddenPlayers: settings.hiddenPlayers || [],
    timeclasses: { ...DEFAULT_SETTINGS.timeclasses, ...(settings.timeclasses || {}) },
  };
}

function normalizeTimeclass(tc) {
  return tc === "standard" ? "rapid" : tc || "";
}

function timeclassAllowed(settings, tc) {
  return !tc || settings.timeclasses[tc] !== false;
}

async function getState() {
  const data = await chrome.storage.local.get(["scrapedFriends", "apiFriends", "userCache", "statuses"]);
  return {
    scrapedFriends: data.scrapedFriends || [],
    apiFriends: data.apiFriends || [],
    userCache: data.userCache || {},
    statuses: data.statuses || {},
  };
}

const norm = (name) => String(name || "").trim().toLowerCase();

// ---------- chess.com endpoints ----------

async function fetchUserPopup(username) {
  const res = await fetch(`${BASE}/callback/user/popup/${encodeURIComponent(username)}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`User "${username}" not found (${res.status})`);
  return res.json();
}

async function resolveUser(username, userCache) {
  const key = norm(username);
  if (userCache[key]?.uuid) return userCache[key];
  const info = await fetchUserPopup(username);
  const user = {
    username: info.username || username,
    uuid: info.uuid,
    userId: info.userId,
    avatar: info.avatarUrl || "",
  };
  userCache[key] = user;
  return user;
}

// Server-sent events stream: emits the current presence of every requested id, then updates.
// We read the initial snapshot and close the connection.
async function fetchPresence(uuids) {
  const result = {};
  if (!uuids.length) return result;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRESENCE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${BASE}/service/presence/watch/users?ids=${uuids.join(",")}`,
      { signal: controller.signal, headers: { Accept: "text/event-stream" } }
    );
    if (!res.ok || !res.body) throw new Error(`Presence request failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let got = 0;
    while (got < uuids.length) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .join("");
        if (!dataLine) continue;
        try {
          const p = JSON.parse(dataLine);
          if (p.id && !result[p.id]) {
            result[p.id] = p;
            got++;
          } else if (p.id) {
            result[p.id] = p;
          }
        } catch {
          // ignore malformed event
        }
      }
    }
    controller.abort();
  } catch (err) {
    if (err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  return result;
}

// ---------- friends list ----------

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

function scrapeMemberNames(html, me) {
  const names = new Set();
  const skip = new Set(["help", "membership", "settings", "login", "blogs", "stats", "games", "friends", "home"]);
  const re = /\/member\/([A-Za-z0-9_-]+)/gi;
  let m;
  while ((m = re.exec(html || ""))) {
    const name = m[1];
    if (!name || skip.has(norm(name)) || norm(name) === me) continue;
    names.add(name);
  }
  return [...names];
}

const FRIENDS_HTML_MAX_PAGES = 100;
const FRIENDS_RPC_MAX_PAGES = 50;
const FRIENDS_RPC_PAGE_SIZE = 100;

function extractNextPageToken(data) {
  if (!data || typeof data !== "object") return "";
  const token =
    data.pagination?.nextPageToken ||
    data.pagination?.next_page_token ||
    data.nextPageToken ||
    data.next_page_token ||
    data.pageToken ||
    data.page_token ||
    "";
  return String(token || "").trim();
}

async function fetchSearchPage(url, opts) {
  try {
    const res = await fetch(url, { credentials: "include", ...opts });
    if (!res.ok) return { users: [], nextToken: "" };
    const raw = await res.json();
    return {
      users: collectSearchHits(raw).map(toSearchUser).filter((u) => u.username),
      nextToken: extractNextPageToken(raw),
    };
  } catch {
    return { users: [], nextToken: "" };
  }
}

async function queryFriendsAllPages() {
  const url = `${BASE}/service/friends-search/chesscom.friends_search.v1.FriendsSearch/QueryFriends`;
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

    const { users, nextToken } = await fetchSearchPage(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        includePresenceStatus: false,
        include_presence_status: false,
        pagination,
        query: { query: {} },
      }),
    });

    const before = found.size;
    for (const u of users) {
      if (u.username) found.set(norm(u.username), u.username);
    }
    if (found.size === before) break;

    if (nextToken && nextToken !== pageToken) {
      pageToken = nextToken;
      useOffset = false;
      continue;
    }

    if (users.length < FRIENDS_RPC_PAGE_SIZE) break;

    useOffset = true;
    pageToken = "";
    offset += users.length;
  }

  return [...found.values()];
}

async function friendsFromTab(tabId, me) {
  if (tabId == null) return [];
  try {
    const res = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "cfnPageFriends", me }), 45000);
    return res?.users || [];
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["search-main.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["search-bridge.js"] });
      const res = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "cfnPageFriends", me }), 45000);
      return res?.users || [];
    } catch {
      return [];
    }
  }
}

async function friendsFromOpenTab(me) {
  const tabs = await chrome.tabs.query({ url: "https://www.chess.com/*" });
  const preferred =
    tabs.find((t) => t.id != null && !t.discarded && /\/friends/i.test(t.url || "")) ||
    tabs.find((t) => t.id != null && !t.discarded);
  if (!preferred?.id) return [];
  return friendsFromTab(preferred.id, me);
}

async function setFriendsStatus({ count, ok, hint, needsTab = false }) {
  await chrome.storage.local.set({
    friendsStatus: { count, ok, hint: hint || "", needsTab: !!needsTab, at: Date.now() },
  });
}

async function scrapeAllFriendsHtml(username, me) {
  const names = [];
  if (!username) return names;
  const seen = new Set();
  for (let page = 1; page <= FRIENDS_HTML_MAX_PAGES; page++) {
    try {
      const url = `${BASE}/member/${encodeURIComponent(username)}/friends${page > 1 ? `?page=${page}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) break;
      const before = seen.size;
      for (const name of scrapeMemberNames(await res.text(), me)) {
        const key = norm(name);
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
      }
      if (seen.size === before) break;
    } catch {
      break;
    }
  }
  return names;
}

async function collectChesscomFriends(username) {
  const me = norm(username);
  const found = new Set();
  const add = (name) => {
    const n = String(name || "").trim();
    if (n && norm(n) !== me) found.add(n);
  };

  const jsonUrls = [
    `${BASE}/callback/friends/all`,
    username ? `${BASE}/callback/friends/${encodeURIComponent(username)}` : null,
    username ? `${BASE}/callback/user/${encodeURIComponent(username)}/friends` : null,
  ].filter(Boolean);

  // Pull every source in parallel: page bridge, callback JSON, QueryFriends pages, HTML pages.
  const [pageHits, callbackChunks, rpcNames, htmlNames] = await Promise.all([
    friendsFromOpenTab(username).catch(() => []),
    Promise.all(jsonUrls.map((url) => fetchSearchJson(url, { headers: { Accept: "application/json" } }))),
    queryFriendsAllPages().catch(() => []),
    scrapeAllFriendsHtml(username, me).catch(() => []),
  ]);
  for (const u of pageHits) add(u.username || u);
  for (const u of callbackChunks.flat()) add(u.username);
  for (const name of rpcNames) add(name);
  for (const name of htmlNames) add(name);

  // A Chess.com tab can supply the friend list. Never open one from Refresh.
  let needsTab = false;
  if (!found.size) {
    const tabs = await chrome.tabs.query({ url: "https://www.chess.com/*" });
    const live = tabs.find((t) => t.id != null && !t.discarded);
    if (!live) {
      needsTab = true;
    } else {
      try {
        for (const u of await friendsFromTab(live.id, username)) add(u.username || u);
      } catch {
        // the open tab could not be read
      }
    }
  }

  if (!found.size) {
    try {
      const res = await fetch(`${BASE}/friends`, { credentials: "include" });
      if (res.ok) scrapeMemberNames(await res.text(), me).forEach(add);
    } catch {
      // not logged in or blocked
    }
  }

  return { names: [...found], needsTab: needsTab && !found.size };
}

const FRIENDS_TTL_MS = 10 * 60 * 1000;
async function refreshApiFriends(settings, force = false) {
  const { apiFriends = [], apiFriendsAt = 0 } = await chrome.storage.local.get(["apiFriends", "apiFriendsAt"]);
  if (!force && Date.now() - apiFriendsAt < FRIENDS_TTL_MS && apiFriends.length) return apiFriends;
  const collected = await collectChesscomFriends(settings.username);
  const names = collected.names || [];
  if (names.length) {
    await chrome.storage.local.set({ apiFriends: names, apiFriendsAt: Date.now() });
    await setFriendsStatus({ count: names.length, ok: true, hint: "", needsTab: false });
    return names;
  }
  const hint = collected.needsTab
    ? "Open Chess.com in a tab to refresh the friend list."
    : !settings.username
    ? "Set your Chess.com username in Settings, save, then press Refresh."
    : "Stay logged into Chess.com in this browser, then press Refresh. You can also add players with search.";
  await setFriendsStatus({ count: apiFriends.length, ok: false, hint, needsTab: !!collected.needsTab });
  return apiFriends;
}

async function getAllFriends(settings, state) {
  const me = norm(settings.username);
  const hidden = new Set((settings.hiddenPlayers || []).map(norm));
  const names = [
    ...new Set(
      [...(state.apiFriends || []), ...state.scrapedFriends, ...settings.watchedPlayers]
        .map((n) => String(n || "").trim())
        .filter((n) => n && norm(n) !== me && !hidden.has(norm(n)))
    ),
  ];

  const cache = state.userCache;
  let cacheDirty = false;
  const byName = new Map();
  await mapPool(names, 8, async (name) => {
    const key = norm(name);
    try {
      const had = !!cache[key]?.uuid;
      const user = await resolveUser(name, cache);
      if (!had) cacheDirty = true;
      byName.set(key, { ...user, watched: true });
    } catch {
      // invalid username, skip
    }
  });

  if (cacheDirty) await chrome.storage.local.set({ userCache: cache });
  return [...byName.values()].filter((f) => f.uuid);
}

// ---------- polling ----------

function withWatchUser(url, username) {
  if (!username) return url;
  try {
    const u = new URL(url);
    // Chess.com treats ?username= as its own play/challenge param and can send you to /play/online.
    u.searchParams.delete("username");
    u.searchParams.set("cfn", username);
    return u.toString();
  } catch {
    return url;
  }
}

function gameUrl(presence, username) {
  const game = presence?.activityContext?.games?.[0];
  if (!game) return null;
  const id = game.numericId || game.legacyId;
  if (!id) return null;
  const path = game.timeclass === "daily" ? `${BASE}/game/daily/${id}` : `${BASE}/game/live/${id}`;
  return withWatchUser(path, username);
}

function tabShowsGame(url, gameId) {
  if (!url || !gameId) return false;
  return new RegExp(`/(?:analysis/)?game/(?:live/|daily/)?${gameId}(?:\\b|/|\\?|$)`).test(url);
}

function usernameFromUrl(url) {
  try {
    const u = new URL(url);
    const fromQuery = u.searchParams.get("cfn") || u.searchParams.get("username");
    if (fromQuery) return norm(fromQuery);
    const follow = u.hash.match(/(?:^|[&#])follow=([^&]+)/i);
    return follow ? norm(decodeURIComponent(follow[1])) : "";
  } catch {
    return "";
  }
}

function gameIdFromUrl(url) {
  return url?.match(/\/(?:analysis\/)?game\/(?:live\/|daily\/)?(\d+)/)?.[1] || "";
}

function gamePlayers(game) {
  const headers = game?.pgnHeaders || {};
  return { white: norm(headers.White), black: norm(headers.Black) };
}

function opponentOf(game, username) {
  const { white, black } = gamePlayers(game);
  const me = norm(username);
  if (me === white) return black;
  if (me === black) return white;
  return "";
}

function winnerOf(game) {
  const { white, black } = gamePlayers(game);
  if (game?.colorOfWinner === "white") return white;
  if (game?.colorOfWinner === "black") return black;
  return "";
}

async function enrichFollowJobs(jobs, watchedNames) {
  const watched = new Set((watchedNames || []).map(norm));
  return Promise.all(
    jobs.map(async (job) => {
      const newId = gameIdFromUrl(job.newUrl);
      const [oldGame, newGame] = await Promise.all([
        job.oldGameId ? fetchLiveGame(job.oldGameId).catch(() => null) : null,
        newId ? fetchLiveGame(newId).catch(() => null) : null,
      ]);
      const oldOpp = oldGame ? opponentOf(oldGame, job.username) : "";
      const newOpp = newGame ? opponentOf(newGame, job.username) : "";
      const { white, black } = oldGame ? gamePlayers(oldGame) : { white: "", black: "" };
      return {
        ...job,
        rematch: !!(oldOpp && newOpp && oldOpp === newOpp),
        bothWatched: !!(white && black && watched.has(white) && watched.has(black)),
        winner: oldGame ? winnerOf(oldGame) : "",
      };
    })
  );
}

async function navigateWatchTab(tabId, url) {
  const gameId = gameIdFromUrl(url);
  const who = usernameFromUrl(url);
  // Hard reload after navigation can make Chess.com drop a private spectator stream and
  // dump the tab on /play/online. Prefer a clean URL update; only soft-reload if needed.
  await chrome.tabs.update(tabId, { url });
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve();
    };
    const timer = setTimeout(finish, 2500);
    const onUpd = (id, info, tab) => {
      if (id !== tabId || info.status !== "complete") return;
      const href = tab.url || "";
      if (gameId && tabShowsGame(href, gameId)) finish();
      else if (who && usernameFromUrl(href) === who) finish();
      else if (/\/play\/online/i.test(href) && who) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function rememberWatchTab(tabId, username, gameId) {
  if (tabId == null || !username) return;
  const { watchingTabs = {} } = await chrome.storage.session.get("watchingTabs");
  watchingTabs[tabId] = { username: norm(username), gameId: String(gameId || watchingTabs[tabId]?.gameId || "") };
  await chrome.storage.session.set({ watchingTabs });
}

async function forgetWatchTab(tabId) {
  const { watchingTabs = {} } = await chrome.storage.session.get("watchingTabs");
  if (!(tabId in watchingTabs)) return;
  delete watchingTabs[tabId];
  await chrome.storage.session.set({ watchingTabs });
}

async function discoverWatchTabs(tabs) {
  const { watchingTabs = {} } = await chrome.storage.session.get("watchingTabs");
  let dirty = false;
  for (const tab of tabs) {
    const username = usernameFromUrl(tab.url || tab.pendingUrl);
    if (!username) continue;
    watchingTabs[tab.id] = { username, gameId: gameIdFromUrl(tab.url || tab.pendingUrl) || watchingTabs[tab.id]?.gameId || "" };
    dirty = true;
  }
  if (dirty) await chrome.storage.session.set({ watchingTabs });
  return watchingTabs;
}

function tabFollowsSharedGame(job, url, meta) {
  if (!job.oldGameId) return false;
  if (tabShowsGame(url, job.oldGameId)) return true;
  return String(meta?.gameId || "") === String(job.oldGameId);
}

// If a finished game is still open, send that tab to the player's next game instead of leaving it behind.
async function followGamesInOpenTabs(jobs) {
  const list = jobs.filter((p) => p.newUrl && !p.rematch && (p.oldGameId || p.username));
  if (!list.length) return;
  const tabs = await chrome.tabs.query({ url: "https://www.chess.com/*" });
  const watchingTabs = await discoverWatchTabs(tabs);

  for (const job of list) {
    const who = norm(job.username);
    const newId = gameIdFromUrl(job.newUrl);
    const targets = new Set();

    const claimTab = (tabId, url) => {
      const meta = watchingTabs[tabId];
      if (job.bothWatched && tabFollowsSharedGame(job, url, meta)) {
        const followWho = job.winner || meta?.username || usernameFromUrl(url);
        return followWho === who;
      }
      return meta?.username === who || usernameFromUrl(url) === who || tabShowsGame(url, job.oldGameId);
    };

    for (const [id, meta] of Object.entries(watchingTabs)) {
      const tabId = Number(id);
      const tab = tabs.find((t) => t.id === tabId);
      const url = tab?.url || tab?.pendingUrl || "";
      if (newId && tabShowsGame(url, newId)) continue;
      if (claimTab(tabId, url)) targets.add(tabId);
    }
    for (const tab of tabs) {
      const url = tab.url || tab.pendingUrl || "";
      if (newId && tabShowsGame(url, newId)) continue;
      if (claimTab(tab.id, url)) targets.add(tab.id);
    }

    await Promise.all(
      [...targets].map(async (tabId) => {
        try {
          await navigateWatchTab(tabId, job.newUrl);
          watchingTabs[tabId] = { username: who, gameId: newId || job.oldGameId || "" };
        } catch {
          delete watchingTabs[tabId];
        }
      })
    );
  }
  await chrome.storage.session.set({ watchingTabs });
}

async function notify(friend, title, message, url, { force = false, enabled } = {}) {
  if (!force) {
    if (enabled === false) return;
    if (enabled == null && !(await getSettings()).notificationsEnabled) return;
  }
  const id = `cfn:${friend.username}:${Date.now()}`;
  await chrome.storage.session.set({ [id]: url || `${BASE}/member/${friend.username}` });
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 2,
  });
}

// ---------- game results ----------

async function fetchLiveGame(id) {
  const res = await fetch(`${BASE}/callback/live/game/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Game ${id} request failed (${res.status})`);
  return (await res.json()).game;
}

function describeResult(username, game, hideOpponent) {
  if (/abort/i.test(game.resultMessage || "") || game.gameEndReason === "aborted") return null;
  const headers = game.pgnHeaders || {};
  const isWhite = norm(headers.White) === norm(username);
  const opponent = isWhite ? headers.Black : headers.White;
  const change = isWhite ? game.ratingChangeWhite : game.ratingChangeBlack;
  const winner = game.colorOfWinner;
  const outcome = !winner ? "drew" : (winner === "white") === isWhite ? "won" : "lost";
  const delta = game.isRated && typeof change === "number" ? ` (${change > 0 ? "+" : ""}${change})` : "";
  const shown = hideOpponent ? "Opponent" : opponent || "Opponent";
  let message = game.resultMessage || "Game finished.";
  if (hideOpponent && opponent) message = message.split(opponent).join("Opponent");
  return {
    title: `${username} ${outcome} vs ${shown}${delta}`,
    message,
  };
}

async function processPendingResults(newPending, notifyOpts) {
  const prefs = await getSettings();
  const { pendingResults = [] } = await chrome.storage.local.get("pendingResults");
  const queue = [...pendingResults, ...newPending];
  if (!queue.length) return;
  const keep = (
    await Promise.all(
      queue.map(async (p) => {
        if (Date.now() - p.since > RESULT_WAIT_MS) return null;
        try {
          const game = await fetchLiveGame(p.gameId);
          if (!game?.isFinished) return p;
          const result = describeResult(p.username, game, prefs.hideOpponent);
          if (result) await notify(p, result.title, result.message, `${BASE}/game/live/${p.gameId}`, notifyOpts);
          return null;
        } catch {
          return p;
        }
      })
    )
  ).filter(Boolean);
  await chrome.storage.local.set({ pendingResults: keep });
}

// ---------- my stats & session ----------

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed (${res.status})`);
  return res.json();
}

function archiveUrl(username, date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${PUB}/player/${username}/games/${date.getUTCFullYear()}/${month}`;
}

const PERCENTILE_TTL_MS = 10 * 60 * 1000;

async function fetchOverviewStats(uuid, tc) {
  const res = await fetch(`${BASE}/service/stats/chesscom.stats.v1.StatsService/GetOverviewStats`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", "connect-protocol-version": "1" },
    body: JSON.stringify({
      playerId: uuid,
      statType: `STAT_TYPE_${tc.toUpperCase()}`,
      timeWindow: "TIME_WINDOW_90_DAYS",
    }),
  });
  if (!res.ok) throw new Error(`Overview stats failed (${res.status})`);
  return res.json();
}

async function getPercentiles(username) {
  const { percentileCache } = await chrome.storage.local.get("percentileCache");
  if (percentileCache?.username === username && Date.now() - percentileCache.at < PERCENTILE_TTL_MS) {
    return percentileCache.data;
  }
  const { userCache = {} } = await chrome.storage.local.get("userCache");
  const { uuid } = await resolveUser(username, userCache);
  await chrome.storage.local.set({ userCache });

  const data = {};
  await Promise.all(
    TIME_CLASSES.map(async (tc) => {
      try {
        const s = await fetchOverviewStats(uuid, tc);
        if (typeof s.globalPercentile === "number") {
          data[tc] = { percentile: s.globalPercentile, globalRank: s.globalRank ?? null };
        }
      } catch {
        // no stats for this game type
      }
    })
  );
  if (Object.keys(data).length) {
    await chrome.storage.local.set({ percentileCache: { username, at: Date.now(), data } });
  }
  return data;
}

const PLAYER_RATINGS_TTL_MS = 15 * 60 * 1000;

async function getPlayerRatings(usernames) {
  const { playerRatings: cache = {} } = await chrome.storage.local.get("playerRatings");
  const fresh = {};
  let dirty = false;
  await Promise.all(
    usernames.map(async (name) => {
      const key = norm(name);
      const cached = cache[key];
      if (cached && Date.now() - cached.at < PLAYER_RATINGS_TTL_MS) {
        fresh[key] = cached;
        return;
      }
      try {
        const stats = await getJson(`${PUB}/player/${key}/stats`);
        const ratings = {};
        for (const tc of TIME_CLASSES) {
          const rating = stats[`chess_${tc}`]?.last?.rating;
          if (rating) ratings[tc] = rating;
        }
        fresh[key] = { at: Date.now(), ratings };
        dirty = true;
      } catch {
        if (cached) fresh[key] = cached;
      }
    })
  );
  const next = { ...cache, ...fresh };
  if (dirty) await chrome.storage.local.set({ playerRatings: next });
  return next;
}

const MY_STATS_TTL_MS = 2 * 60 * 1000;

async function updateMyStatsIfNeeded(settings, force) {
  if (!settings.username) return;
  if (!force) {
    const { myStats } = await chrome.storage.local.get("myStats");
    if (myStats?.updatedAt && Date.now() - myStats.updatedAt < MY_STATS_TTL_MS) return;
  }
  return updateMyStats(settings);
}

async function updateMyStats(settings) {
  if (!settings.username) return;
  const me = norm(settings.username);
  const now = new Date();
  const months = [
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  ];
  const [stats, percentiles, ...archives] = await Promise.all([
    getJson(`${PUB}/player/${me}/stats`),
    getPercentiles(me).catch(() => ({})),
    ...months.map((d) => getJson(archiveUrl(me, d)).catch(() => ({ games: [] }))),
  ]);
  const ratings = {};
  for (const tc of TIME_CLASSES) {
    const s = stats[`chess_${tc}`];
    if (s?.last) {
      ratings[tc] = {
        rating: s.last.rating,
        best: s.best?.rating ?? null,
        percentile: percentiles[tc]?.percentile ?? null,
        globalRank: percentiles[tc]?.globalRank ?? null,
      };
    }
  }

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime() / 1000;

  const games = archives
    .flatMap((a) => a.games || [])
    .filter((g) => g.rules === "chess")
    .sort((a, b) => a.end_time - b.end_time);

  const session = { total: 0, win: 0, loss: 0, draw: 0, byClass: {} };
  const lastRatingBefore = {};
  const today = [];
  for (const g of games) {
    const side = norm(g.white.username) === me ? g.white : g.black;
    if (g.end_time < since) {
      lastRatingBefore[g.time_class] = side.rating;
      continue;
    }
    const outcome = side.result === "win" ? "win" : DRAW_RESULTS.has(side.result) ? "draw" : "loss";
    today.push({ outcome, url: g.url });
    session.total++;
    session[outcome]++;
    const c = (session.byClass[g.time_class] ||= {
      games: 0,
      win: 0,
      loss: 0,
      draw: 0,
      start: lastRatingBefore[g.time_class] ?? side.rating,
      end: side.rating,
    });
    c.games++;
    c[outcome]++;
    c.end = side.rating;
  }
  for (const c of Object.values(session.byClass)) c.change = c.end - c.start;

  let streak = null;
  if (today.length) {
    const last = today[today.length - 1].outcome;
    let i = today.length - 1;
    while (i >= 0 && today[i].outcome === last) i--;
    streak = { outcome: last, count: today.length - 1 - i, startUrl: today[i + 1].url };
  }

  const { tiltAlertedFor } = await chrome.storage.local.get("tiltAlertedFor");
  if (
    settings.tiltLimit > 0 &&
    streak?.outcome === "loss" &&
    streak.count >= settings.tiltLimit &&
    tiltAlertedFor !== streak.startUrl
  ) {
    await notify(
      { username: settings.username },
      `${streak.count} losses in a row`,
      "Maybe take a short break before the next game.",
      `${BASE}/member/${settings.username}`
    );
    await chrome.storage.local.set({ tiltAlertedFor: streak.startUrl });
  }

  await chrome.storage.local.set({
    myStats: { ratings, session, streak, updatedAt: Date.now() },
  });
}

let inFlight = null;

// Concurrent callers (alarm + Refresh button) share the same running check.
function checkFriends(opts = {}) {
  inFlight ||= runCheck(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck({ forceStats = false } = {}) {
  try {
    const settings = await getSettings();
    const apiFriends = await refreshApiFriends(settings, forceStats).catch(() => []);
    const state = await getState();
    state.apiFriends = apiFriends.length ? apiFriends : state.apiFriends;
    const prev = state.statuses;
    const notifyOpts = { enabled: settings.notificationsEnabled };
    const friends = await getAllFriends(settings, state);

    const watchedNames = friends.map((f) => f.username);
    const ratingsPromise = getPlayerRatings(watchedNames).catch(() => ({}));
    const statsPromise = updateMyStatsIfNeeded(settings, forceStats).catch((err) => {
      console.warn("Stats update failed", err);
    });

    const presence = {};
    await Promise.all(
      Array.from({ length: Math.ceil(friends.length / PRESENCE_BATCH) || 0 }, (_, i) => {
        const batch = friends.slice(i * PRESENCE_BATCH, i * PRESENCE_BATCH + PRESENCE_BATCH).map((f) => f.uuid);
        return fetchPresence(batch).then((part) => Object.assign(presence, part));
      })
    );

    const statuses = {};
    const newPending = [];
    const follows = [];
    let playingCount = 0;
    for (const f of friends) {
      const p = presence[f.uuid];
      if (!p) {
        if (prev[f.uuid]) statuses[f.uuid] = prev[f.uuid];
        continue;
      }
      const game = p.activityContext?.games?.[0];
      const gameId = game ? String(game.numericId || game.legacyId || game.id) : "";
      const before = prev[f.uuid];
      const now = {
        username: f.username,
        avatar: f.avatar,
        watched: f.watched,
        status: p.status || "offline",
        activity: p.activity || "",
        gameId,
        lastGameId: gameId || before?.lastGameId || before?.gameId || "",
        timeclass: normalizeTimeclass(game?.timeclass),
        url: gameUrl(p, f.username),
        privateGame: !!game?.private,
        ratings: before?.ratings || {},
      };
      statuses[f.uuid] = now;
      const isPlaying = now.activity === "playing";
      if (isPlaying) playingCount++;

      // Skip notifications on the very first check so we don't spam for already-running games.
      if (!before) continue;

      const wasPlaying = before.activity === "playing" && before.gameId;
      const startedNewGame = isPlaying && (!wasPlaying || before.gameId !== now.gameId);
      const finishedGame = wasPlaying && (!isPlaying || before.gameId !== now.gameId);

      if (
        finishedGame &&
        settings.notifyResults &&
        before.timeclass !== "daily" &&
        timeclassAllowed(settings, before.timeclass)
      ) {
        newPending.push({ username: f.username, gameId: before.gameId, since: Date.now() });
      }

      if (startedNewGame) {
        if (settings.followNextGame !== false && now.timeclass !== "daily") {
          follows.push({
            username: f.username,
            oldGameId: before.lastGameId || before.gameId,
            newUrl: now.url,
          });
        }
        if (timeclassAllowed(settings, now.timeclass)) {
          const tc = now.timeclass ? ` (${now.timeclass})` : "";
          await notify(f, `${f.username} is playing${tc}`, "Click to watch the game.", now.url, notifyOpts);
        }
      } else if (settings.notifyOnline && before.status === "offline" && now.status !== "offline") {
        await notify(f, `${f.username} is online`, "Your friend just came online on chess.com.", undefined, notifyOpts);
      }
    }

    const ratings = await ratingsPromise;
    for (const s of Object.values(statuses)) {
      if (s.watched) s.ratings = ratings[norm(s.username)]?.ratings || s.ratings || {};
    }

    await chrome.storage.local.set({ statuses, lastCheck: Date.now() });
    chrome.action.setBadgeBackgroundColor({ color: "#c084fc" });
    chrome.action.setBadgeText({ text: playingCount ? String(playingCount) : "" });

    const followJobs =
      settings.followNextGame !== false && follows.length
        ? await enrichFollowJobs(follows, friends.map((f) => f.username))
        : [];

    await Promise.all([
      followGamesInOpenTabs(followJobs),
      processPendingResults(newPending, notifyOpts),
      statsPromise,
    ]);
  } catch (err) {
    console.warn("Check failed", err);
  } finally {
    await restartPollTimer();
  }
}

// Every check, manual or automatic, restarts the countdown so the next auto check is one full interval later.
async function restartPollTimer() {
  const { intervalSec } = await getSettings();
  const minutes = Math.max(30, intervalSec) / 60;
  await chrome.alarms.create(POLL_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
  await chrome.storage.local.set({ nextCheck: Date.now() + minutes * 60000 });
}

async function scheduleAlarms() {
  const { intervalSec } = await getSettings();
  const minutes = Math.max(30, intervalSec) / 60;
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: minutes, delayInMinutes: 0.1 });
}

// Strongest first. Lichess Cloud is Stockfish at high depth. The local builds are
// the same Stockfish 19 lite binary with a longer or shorter search. Full Leela
// and the large Stockfish networks are too big to ship inside the extension.
const ENGINES = {
  "lichess-cloud": { id: "lichess-cloud", name: "Lichess Cloud", kind: "cloud" },
  "stockfish-deep": { id: "stockfish-deep", name: "Stockfish 19 deep", kind: "local", search: "go depth 20 movetime 2800" },
  "stockfish-lite": { id: "stockfish-lite", name: "Stockfish 19 lite", kind: "local", search: "go depth 16 movetime 1200" },
};

function selectedEngine(settings) {
  return ENGINES[settings?.engineId] || ENGINES["stockfish-lite"];
}

async function lichessCloudEval(fen) {
  const res = await fetch(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=1`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const pv = data?.pvs?.[0];
  if (!pv) return null;
  const bestmove = String(pv.moves || "").split(" ")[0] || null;
  return {
    ok: true,
    fen,
    depth: data.depth || 0,
    cp: pv.cp ?? null,
    mate: pv.mate ?? null,
    bestmove,
    pv: bestmove,
  };
}

// ---------- engine (offscreen document running Stockfish) ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run the Stockfish engine for the evaluation bar and game review.",
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function evaluate(fen, tabId) {
  const settings = await getSettings();
  const engine = selectedEngine(settings);
  if (engine.kind === "cloud") {
    try {
      const cloud = await lichessCloudEval(fen);
      if (cloud) return { ...cloud, engineId: engine.id, engineName: engine.name };
    } catch {
      // Fall through to the local engine when Lichess has no cached position.
    }
  }
  const local = engine.kind === "local" ? engine : ENGINES["stockfish-deep"];
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "evaluate",
    fen,
    tabId,
    search: local.search,
  });
  return {
    ...res,
    engineId: local.id,
    engineName: local.name,
    fallback: engine.kind === "cloud",
  };
}

async function fetchGameForReview(gameId, kind) {
  const kinds = kind ? [kind] : ["live", "daily"];
  for (const k of kinds) {
    const res = await fetch(`${BASE}/callback/${k}/game/${gameId}`, { credentials: "include" });
    if (res.ok) return (await res.json()).game;
  }
  throw new Error("Couldn't load this game from chess.com.");
}

function namedPlayer(raw, fallback) {
  if (raw && typeof raw === "object") {
    return {
      name: raw.name || fallback,
      rating: raw.rating ?? null,
      accuracy: raw.accuracy ?? null,
      counts: raw.counts || null,
    };
  }
  return { name: raw || fallback, rating: null, accuracy: null, counts: null };
}

function preferName(candidates, fallback) {
  return candidates.find((name) => name && name !== fallback) || fallback;
}

function mergePlayer(parts, fallback) {
  const rows = parts.map((part) => namedPlayer(part, fallback));
  return {
    name: preferName(rows.map((row) => row.name), fallback),
    rating: rows.map((row) => row.rating).find((rating) => rating != null && rating !== "") ?? null,
    accuracy: rows.map((row) => row.accuracy).find((accuracy) => accuracy != null) ?? null,
    counts: rows.map((row) => row.counts).find(Boolean) || null,
  };
}

async function gameDetails(gameId) {
  if (!gameId) return null;
  try {
    const game = await fetchGameForReview(gameId);
    const headers = game?.pgnHeaders || {};
    return {
      white: { name: headers.White || "", rating: headers.WhiteElo ?? null },
      black: { name: headers.Black || "", rating: headers.BlackElo ?? null },
      result: headers.Result || "",
      timeControl: headers.TimeControl || "",
      termination: headers.Termination || "",
    };
  } catch {
    return null;
  }
}

async function withPlayerDetails(session) {
  if (!session?.gameId) return session;
  const key = `reviewPlayers:${session.gameId}`;
  const stored = await chrome.storage.session.get(key);
  const saved = stored[key] || {};
  const details = await gameDetails(session.gameId);
  return {
    ...session,
    players: {
      white: mergePlayer([details?.white, session.players?.white, saved.white], "White"),
      black: mergePlayer([details?.black, session.players?.black, saved.black], "Black"),
    },
    game: {
      result: details?.result || session.game?.result || "",
      timeControl: details?.timeControl || session.game?.timeControl || "",
      termination: details?.termination || session.game?.termination || "",
    },
  };
}

async function analyzeGame(gameId, kind, tabId) {
  const game = await fetchGameForReview(gameId, kind);
  const headers = game.pgnHeaders || {};
  if (!game.isFinished) {
    return {
      ok: false,
      error: "Game review is only available after the game ends — including your own games.",
    };
  }
  if (!game.moveList) return { ok: false, error: "No moves to analyze yet." };
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "analyze",
    tabId,
    game: {
      gameId,
      moveList: game.moveList,
      finished: !!game.isFinished,
      players: {
        w: { name: headers.White || "White", rating: headers.WhiteElo || null },
        b: { name: headers.Black || "Black", rating: headers.BlackElo || null },
      },
    },
  });
  if (result?.ok) {
    await chrome.storage.session.set({
      [`reviewPlayers:${gameId}`]: {
        white: namedPlayer(result.white, "White"),
        black: namedPlayer(result.black, "Black"),
      },
    });
  }
  return result;
}

// Runs inside chess.com's page world so we can call their board.game API (DOM clicks are ignored).
function pageJumpToPly(ply, fen, hint) {
  const deepQueryAll = (selector, root = document) => {
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
  };

  const board = document.querySelector("wc-chess-board, chess-board");
  const game = board?.game;
  const targetPly = Math.max(0, Number(ply) || 0);

  const apiTry = () => {
    if (!game) return false;
    const callJump = (obj, name) => {
      const fn = obj?.[name];
      if (typeof fn !== "function") return false;
      const attempts = [
        () => fn.call(obj, targetPly),
        () => fn.call(obj, targetPly - 1),
        () => fn.call(obj, { ply: targetPly }),
        () => fn.call(obj, { moveIndex: targetPly }),
        () => fn.call(obj, fen),
      ];
      for (const attempt of attempts) {
        try {
          attempt();
          return true;
        } catch {
          // try next signature
        }
      }
      return false;
    };
    const objs = [game, game.controller, game.api, game.line, game.history, game.moveList, game.tree].filter(Boolean);
    const preferred = [
      "jumpToPly",
      "goToPly",
      "gotoPly",
      "setPly",
      "selectPly",
      "seekToPly",
      "moveToPly",
      "jumpToMove",
      "goToMove",
      "gotoMove",
      "selectMove",
      "selectNode",
      "setCurrentPly",
      "setMoveIndex",
      "loadFEN",
      "loadFen",
      "setFEN",
      "setFen",
      "setPosition",
      "setup",
      "load",
    ];
    for (const obj of objs) {
      for (const name of preferred) {
        if (callJump(obj, name)) return true;
      }
      let keys = [];
      try {
        keys = Object.getOwnPropertyNames(obj);
      } catch {
        keys = Object.keys(obj || {});
      }
      for (const name of keys) {
        if (!/ply|move|jump|goto|seek|select|line|index|node|fen|position/i.test(name)) continue;
        if (preferred.includes(name)) continue;
        if (callJump(obj, name)) return true;
      }
    }
    return false;
  };

  const tap = (el) => {
    if (!el) return false;
    el.scrollIntoView?.({ block: "center", inline: "nearest" });
    const target = el.querySelector?.(".node-highlight-content, .move-text-component") || el;
    target.click?.();
    return true;
  };

  const domTry = () => {
    if (targetPly <= 0) {
      const first = deepQueryAll(
        '#board-controls-first, [data-cy="first-move"], [aria-label*="First" i], [aria-label*="Start" i]'
      )[0];
      return tap(first);
    }
    const byPly = deepQueryAll(`[data-ply="${targetPly}"]`);
    if (byPly[0] && tap(byPly[0])) return true;
    const nodes = deepQueryAll("[data-ply].node, .node[data-ply], vertical-move-list .node, .main-line-row .node");
    const sorted = nodes
      .filter((el) => el.getAttribute("data-ply"))
      .sort((a, b) => Number(a.getAttribute("data-ply")) - Number(b.getAttribute("data-ply")));
    const hit = sorted.find((el) => Number(el.getAttribute("data-ply")) === targetPly) || sorted[targetPly - 1];
    if (hit && tap(hit)) return true;
    if (hint?.san) {
      const needle = String(hint.san).replace(/[+#=!?]/g, "").toLowerCase();
      const moveNo = String(hint.moveNumber || "");
      const texts = deepQueryAll(
        ".node, .node-highlight-content, .move-text-component, [data-ply], .main-line-ply"
      );
      const el = texts.find((node) => {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return text.includes(needle) && (!moveNo || text.includes(moveNo));
      });
      if (el && tap(el)) return true;
    }
    return false;
  };

  const api = apiTry();
  const dom = api ? false : domTry();
  return {
    ok: !!(api || dom),
    via: api ? "api" : dom ? "dom" : "none",
    ply: targetPly,
    nodes: deepQueryAll("[data-ply]").length,
    hasGame: !!game,
  };
}

async function jumpBoardInTab(tabId, ply, fen, hint) {
  if (tabId == null) return { ok: false, error: "No tab." };
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: pageJumpToPly,
    args: [ply, fen || "", hint || null],
  });
  return result || { ok: false };
}

// ---------- events ----------

// Content scripts only load on page load, so push the current version into chess.com tabs that are already open.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://www.chess.com/*" });
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["evalbar.css", "toolbar.css", "pip.css", "timewarn.css", "review.css"],
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["search-main.js"], world: "MAIN" });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          "search-bridge.js",
          "watch-recover.js",
          "evalbar.js",
          "toolbar.js",
          "pip.js",
          "timewarn.js",
          "review.js",
        ],
      });
    } catch {
      // tab not scriptable (e.g. still loading or discarded)
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove(["friendsSource", "lastError", "percentileCache"]);
  await chrome.alarms.clear("refresh-friends");
  await scheduleAlarms();
  await injectIntoOpenTabs();
  ensureTitledIndex().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  ensureTitledIndex().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_ALARM) await checkFriends();
});

chrome.notifications.onClicked.addListener(async (id) => {
  const data = await chrome.storage.session.get(id);
  if (data[id]) {
    const tab = await chrome.tabs.create({ url: data[id] });
    const username = usernameFromUrl(data[id]);
    if (tab?.id && username) await rememberWatchTab(tab.id, username, gameIdFromUrl(data[id]));
  }
  chrome.notifications.clear(id);
  chrome.storage.session.remove(id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  forgetWatchTab(tabId);
  const { searchTabId } = await chrome.storage.session.get("searchTabId");
  if (searchTabId === tabId) await chrome.storage.session.remove("searchTabId");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  const username = usernameFromUrl(url);
  if (username) rememberWatchTab(tabId, username, gameIdFromUrl(url));
});

function collectSearchHits(data, out = []) {
  if (!data) return out;
  if (Array.isArray(data)) {
    for (const item of data) collectSearchHits(item, out);
    return out;
  }
  if (typeof data !== "object") return out;
  const row = data.userView || data.user_view || data.user || data;
  if (row && (row.username || row.userName)) out.push(data);
  const skip = new Set(["pagination", "meta", "error", "status", "pageInfo", "page_info"]);
  for (const [key, val] of Object.entries(data)) {
    if (skip.has(key) || val == null || typeof val !== "object") continue;
    collectSearchHits(val, out);
  }
  return out;
}

function toSearchUser(raw) {
  const row = raw?.userView || raw?.user_view || raw?.user || raw || {};
  const first = row.firstName || row.first_name || "";
  const last = row.lastName || row.last_name || "";
  return {
    username: String(row.username || row.userName || "").trim(),
    avatar: row.avatar || row.avatarUrl || row.avatar_url || "",
    title: row.chessTitle || row.chess_title || row.title || "",
    name: row.name || [first, last].filter(Boolean).join(" "),
  };
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function waitTabReady(tabId, timeout = 8000) {
  await new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve();
    };
    const onUpd = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    }).catch(done);
    setTimeout(done, timeout);
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

let searchTabTask = null;
async function ensureSearchTab() {
  const { searchTabId } = await chrome.storage.session.get("searchTabId");
  if (searchTabId) {
    try {
      const tab = await chrome.tabs.get(searchTabId);
      if (tab?.id && !tab.discarded) return tab.id;
    } catch {
      // tab was closed
    }
  }
  if (searchTabTask) return searchTabTask;
  searchTabTask = (async () => {
    const tab = await chrome.tabs.create({ url: `${BASE}/home`, active: false });
    await waitTabReady(tab.id);
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["search-main.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["search-bridge.js"] });
    } catch {
      // page will still load declared content scripts
    }
    await chrome.storage.session.set({ searchTabId: tab.id });
    return tab.id;
  })().finally(() => {
    searchTabTask = null;
  });
  return searchTabTask;
}

async function searchFromTab(tabId, query, me) {
  const res = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "cfnPageSearch", query, me }), 4500);
  return res?.users || [];
}

async function searchFromOpenTab(query, me) {
  const tabs = await chrome.tabs.query({ url: "https://www.chess.com/*" });
  const tab = tabs.find((t) => t.id != null && !t.discarded);
  if (!tab?.id) return [];
  try {
    const users = await searchFromTab(tab.id, query, me);
    if (users.length) return users;
  } catch {
    // bridge not injected yet
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["search-main.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["search-bridge.js"] });
    return await searchFromTab(tab.id, query, me);
  } catch {
    return [];
  }
}

async function fetchSearchJson(url, opts) {
  try {
    const res = await fetch(url, { credentials: "include", ...opts });
    if (!res.ok) return [];
    return collectSearchHits(await res.json()).map(toSearchUser).filter((u) => u.username);
  } catch {
    return [];
  }
}

async function searchFromServiceWorker(query, me) {
  const enc = encodeURIComponent(query);
  const urls = [
    `${BASE}/callback/user/search?query=${enc}&activeDays=4000`,
    `${BASE}/callback/user/search/chess?query=${enc}`,
    `${BASE}/callback/user/search/all?query=${enc}`,
  ];
  if (me) urls.unshift(`${BASE}/${encodeURIComponent(me)}/callback/user/search?query=${enc}&activeDays=4000`);
  const body = {
    prefix: query.slice(0, 20),
    includeSuggestions: true,
    includeFriends: true,
    suggestionsLimit: 8,
    friendsLimit: 8,
    boostUsername: true,
    exactUsernameFirst: true,
  };
  const chunks = await Promise.all([
    ...urls.map((url) => fetchSearchJson(url, { headers: { Accept: "application/json" } })),
    fetchSearchJson(`${BASE}/service/friends-search/chesscom.friends_search.v1.FriendsSearch/Autocomplete`, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1", accept: "application/json" },
      body: JSON.stringify(body),
    }),
  ]);
  return chunks.flat();
}

let titledLoad = null;
async function ensureTitledIndex() {
  const { titledIndex } = await chrome.storage.local.get("titledIndex");
  if (titledIndex?.players && Date.now() - titledIndex.at < 24 * 60 * 60 * 1000) {
    return titledIndex.players;
  }
  if (titledLoad) return titledLoad;
  titledLoad = (async () => {
    const titles = ["GM", "IM", "WGM", "FM", "WIM", "CM", "NM"];
    const lists = await Promise.all(
      titles.map(async (title) => {
        try {
          const data = await getJson(`${PUB}/titled/${title}`);
          return (data.players || []).map((username) => ({ username, title }));
        } catch {
          return [];
        }
      })
    );
    const players = lists.flat();
    await chrome.storage.local.set({ titledIndex: { at: Date.now(), players } });
    return players;
  })().finally(() => {
    titledLoad = null;
  });
  return titledLoad;
}

async function titledMatches(query) {
  const needle = norm(query);
  if (needle.length < 2) return [];
  const players = await ensureTitledIndex();
  return players.filter((p) => norm(p.username).includes(needle)).slice(0, 12);
}

const handlers = {
  async scrapedFriends(msg) {
    const { scrapedFriends = [] } = await chrome.storage.local.get("scrapedFriends");
    const merged = [...new Set([...scrapedFriends, ...msg.usernames])];
    if (merged.length !== scrapedFriends.length) {
      await chrome.storage.local.set({ scrapedFriends: merged });
    }
    return { ok: true, count: merged.length };
  },
  async settingsChanged() {
    await scheduleAlarms();
    await checkFriends({ forceStats: true });
    return { ok: true };
  },
  async lookupUser(msg) {
    const { userCache = {} } = await chrome.storage.local.get("userCache");
    try {
      const user = await resolveUser(msg.username, userCache);
      await chrome.storage.local.set({ userCache });
      return { ok: true, username: user.username };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  async searchUsers(msg) {
    const q = String(msg.query || "").trim();
    if (q.length < 1) return { ok: true, users: [] };
    const settings = await getSettings();
    const me = settings.username || "";
    const { apiFriends = [], scrapedFriends = [] } = await chrome.storage.local.get(["apiFriends", "scrapedFriends"]);
    const hidden = new Set((settings.hiddenPlayers || []).map(norm));
    const added = new Set(settings.watchedPlayers.map(norm));
    if (me) added.add(norm(me));
    for (const name of [...apiFriends, ...scrapedFriends]) {
      if (!hidden.has(norm(name))) added.add(norm(name));
    }

    const seen = new Set();
    const users = [];
    const add = (raw) => {
      const u = toSearchUser(raw);
      const key = norm(u.username);
      if (!key || seen.has(key) || added.has(key)) return;
      seen.add(key);
      users.push(u);
    };

    const needle = norm(q);
    const rank = (u) => {
      const name = norm(u.username);
      const full = norm(u.name);
      if (name === needle) return 0;
      if (name.startsWith(needle)) return 1;
      if (full.startsWith(needle)) return 2;
      if (name.includes(needle)) return 3;
      if (full.includes(needle)) return 4;
      return 5;
    };

    const [pageHits, swHits, titled] = await Promise.all([
      q.length >= 2 ? searchFromOpenTab(q, me).catch(() => []) : [],
      q.length >= 2 ? searchFromServiceWorker(q, me).catch(() => []) : [],
      titledMatches(q).catch(() => []),
    ]);
    for (const u of [...pageHits, ...swHits, ...titled]) add(u);

    if (users.length < 5 && q.length >= 3) {
      const open = await chrome.tabs.query({ url: "https://www.chess.com/*" });
      const live = open.find((t) => t.id != null && !t.discarded);
      if (!live) {
        try {
          const tabId = await ensureSearchTab();
          if (tabId) {
            for (const u of await searchFromTab(tabId, q, me)) add(u);
          }
        } catch {
          // background tab could not be opened
        }
      }
    }

    if (!added.has(needle) && !users.some((u) => norm(u.username) === needle)) {
      try {
        const info = await getJson(`${PUB}/player/${encodeURIComponent(q)}`);
        add({
          username: info.username || q,
          avatar: info.avatar || "",
          name: info.name || "",
          title: info.title || "",
        });
      } catch {
        try {
          const { userCache = {} } = await chrome.storage.local.get("userCache");
          add(await resolveUser(q, userCache));
        } catch {
          // not an exact username
        }
      }
    }

    users.sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username));
    return {
      ok: true,
      users: users.slice(0, 5),
      already: added.has(needle) ? q : "",
    };
  },
  async checkNow() {
    await checkFriends({ forceStats: true });
    return { ok: true };
  },
  async setNotifications(msg) {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, notificationsEnabled: msg.enabled } });
    if (msg.enabled) {
      await notify(
        { username: "chessradar" },
        "Notifications are enabled",
        "You'll be alerted when watched players start or finish a game.",
        BASE,
        { force: true }
      );
    }
    return { ok: true };
  },
  async evaluate(msg, sender) {
    try {
      return await evaluate(msg.fen, sender.tab?.id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  async analyzeGame(msg, sender) {
    try {
      return await analyzeGame(msg.gameId, msg.kind, sender.tab?.id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  async gameStatus(msg) {
    try {
      const game = await fetchGameForReview(msg.gameId, msg.kind);
      return { ok: true, finished: !!game?.isFinished };
    } catch {
      return { ok: false, finished: false };
    }
  },
  async watchingTab(msg, sender) {
    await rememberWatchTab(msg.tabId ?? sender.tab?.id, msg.username, msg.gameId);
    return { ok: true };
  },
  async watchTabMeta(_msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return { ok: false };
    const { watchingTabs = {} } = await chrome.storage.session.get("watchingTabs");
    const meta = watchingTabs[tabId];
    if (!meta) return { ok: false };
    return { ok: true, username: meta.username, gameId: meta.gameId };
  },
  async analysisProgress(msg) {
    if (msg.tabId != null) {
      chrome.tabs.sendMessage(msg.tabId, { type: "analysisProgress", done: msg.done, total: msg.total }).catch(() => {});
    }
    return { ok: true };
  },
  async jumpBoardPly(msg, sender) {
    try {
      return await jumpBoardInTab(sender.tab?.id ?? msg.tabId, msg.ply, msg.fen, msg.hint);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  async openPuzzleSession(msg, sender) {
    const puzzles = Array.isArray(msg.session?.puzzles) ? msg.session.puzzles : [];
    if (!puzzles.length) return { ok: false, error: "No puzzles to open." };
    const id = crypto.randomUUID();
    const session = {
      ...msg.session,
      id,
      version: 1,
      sourceTabId: sender.tab?.id ?? msg.session?.sourceTabId ?? null,
      sourceUrl: sender.tab?.url || msg.session?.sourceUrl || "",
      createdAt: Date.now(),
      puzzles,
    };
    const detailed = await withPlayerDetails(session);
    await chrome.storage.session.set({ [`puzzleSession:${id}`]: detailed });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`puzzles.html?session=${encodeURIComponent(id)}`) });
    return { ok: true, id };
  },
  async getPuzzleSession(msg) {
    const id = String(msg.sessionId || "");
    if (!id) return { ok: false, error: "missing" };
    const key = `puzzleSession:${id}`;
    const data = await chrome.storage.session.get(key);
    const session = data[key];
    if (!session) return { ok: false, error: "missing" };
    const age = Date.now() - (session.createdAt || 0);
    if (age > 2 * 60 * 60 * 1000) {
      await chrome.storage.session.remove(key);
      return { ok: false, error: "expired" };
    }
    return { ok: true, session: await withPlayerDetails(session) };
  },
  async savePuzzleProgress(msg) {
    const entry = msg.entry || {};
    const { puzzleProgress = [] } = await chrome.storage.local.get("puzzleProgress");
    puzzleProgress.push({
      gameId: entry.gameId || "",
      puzzleId: entry.puzzleId || "",
      fen: entry.fen || "",
      attempts: Number(entry.attempts) || 0,
      correct: !!entry.correct,
      hintsUsed: Number(entry.hintsUsed) || 0,
      completed: !!entry.completed,
      completedAt: entry.completedAt || Date.now(),
    });
    await chrome.storage.local.set({ puzzleProgress: puzzleProgress.slice(-200) });
    return { ok: true };
  },
  async focusPuzzleSource(msg) {
    const tabId = msg.tabId;
    if (tabId != null) {
      try {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      } catch {
        // fall through to URL
      }
    }
    if (msg.url) {
      await chrome.tabs.create({ url: msg.url });
      return { ok: true };
    }
    return { ok: false };
  },
  async playSessionStart(msg) {
    const mode = msg.mode === "minutes" ? "minutes" : "games";
    const goal = Math.max(1, Math.min(mode === "minutes" ? 180 : 100, Number(msg.goal) || 1));
    const queueTarget = msg.queueTarget === "rematch" ? "rematch" : "new";
    const playSession = {
      active: true,
      mode,
      goal,
      queueTarget,
      gamesDone: 0,
      countedIds: [],
      startedAt: Date.now(),
      completedAt: null,
      completeReason: "",
    };
    await chrome.storage.local.set({ playSession });

    const open = await chrome.tabs.query({ url: "https://www.chess.com/*" });
    const playTab =
      open.find((t) => /\/play\//.test(t.url || "") && t.id != null) ||
      open.find((t) => t.id != null && !t.discarded);
    if (playTab?.id != null) {
      await chrome.tabs.update(playTab.id, { active: true });
      if (playTab.windowId != null) await chrome.windows.update(playTab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: `${BASE}/play/online` });
    }

    return { ok: true, session: playSession };
  },
  async playSessionStop() {
    const { playSession } = await chrome.storage.local.get("playSession");
    if (!playSession) return { ok: true, session: null };
    const stopped = {
      ...playSession,
      active: false,
      completedAt: playSession.completedAt || Date.now(),
      completeReason: playSession.completeReason || "stopped",
    };
    await chrome.storage.local.set({ playSession: stopped });
    return { ok: true, session: stopped };
  },
  async playSessionGet() {
    const { playSession = null } = await chrome.storage.local.get("playSession");
    return { ok: true, session: playSession };
  },
  async playSessionRecordGame(msg) {
    const gameId = String(msg.gameId || "");
    const { playSession } = await chrome.storage.local.get("playSession");
    if (!playSession?.active || !gameId) return { ok: true, session: playSession || null };

    const countedIds = Array.isArray(playSession.countedIds) ? [...playSession.countedIds] : [];
    if (countedIds.includes(gameId)) return { ok: true, session: playSession };

    countedIds.push(gameId);
    let next = {
      ...playSession,
      countedIds: countedIds.slice(-200),
      gamesDone: (Number(playSession.gamesDone) || 0) + 1,
    };

    const timeUp =
      next.mode === "minutes" && Date.now() - (next.startedAt || 0) >= Number(next.goal || 0) * 60_000;
    const gamesUp = next.mode === "games" && next.gamesDone >= Number(next.goal || 0);
    if (timeUp || gamesUp) {
      next = {
        ...next,
        active: false,
        completedAt: Date.now(),
        completeReason: timeUp ? "time" : "games",
      };
      await notify(
        { username: "chessradar" },
        "Play session complete",
        timeUp
          ? `Time's up — you played ${next.gamesDone} game${next.gamesDone === 1 ? "" : "s"}.`
          : `You hit your goal of ${next.goal} game${next.goal === 1 ? "" : "s"}.`,
        `${BASE}/play/online`,
        { force: true }
      );
    }

    await chrome.storage.local.set({ playSession: next });
    return { ok: true, session: next };
  },
  async playSessionComplete(msg) {
    const { playSession } = await chrome.storage.local.get("playSession");
    if (!playSession?.active) return { ok: true, session: playSession || null };
    const reason = msg.reason === "time" ? "time" : "games";
    const next = {
      ...playSession,
      active: false,
      completedAt: Date.now(),
      completeReason: reason,
    };
    await chrome.storage.local.set({ playSession: next });
    await notify(
      { username: "chessradar" },
      "Play session complete",
      reason === "time"
        ? `Time's up — you played ${next.gamesDone || 0} game${(next.gamesDone || 0) === 1 ? "" : "s"}.`
        : `You hit your goal of ${next.goal} game${next.goal === 1 ? "" : "s"}.`,
      `${BASE}/play/online`,
      { force: true }
    );
    return { ok: true, session: next };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: err?.message || "The request failed." });
  });
  return true;
});
