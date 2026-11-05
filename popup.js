const $ = (id) => document.getElementById(id);
const send = (type) => chrome.runtime.sendMessage({ type });

let settings = {};
const FRIENDS_PER_PAGE = 5;
let friendsPage = 0;
let lastFriendsSnapshot = [];

function applySettings(saved = {}) {
  settings = {
    username: "",
    intervalSec: 60,
    notificationsEnabled: true,
    notifyOnline: false,
    notifyResults: true,
    tiltLimit: 3,
    evalBar: true,
    bestMove: true,
    analyzeGame: true,
    hideOpponent: false,
    blunderAlerts: false,
    pictureInPicture: true,
    timeWarning: true,
    followNextGame: true,
    engineId: "stockfish-lite",
    analysisDepth: 12,
    ...saved,
    watchedPlayers: saved.watchedPlayers || saved.manualFriends || [],
    hiddenPlayers: saved.hiddenPlayers || [],
    timeclasses: { bullet: true, blitz: true, rapid: true, daily: true, ...(saved.timeclasses || {}) },
  };
}

function fillSettingsForm() {
  $("username").value = settings.username;
  $("interval").value = String(settings.intervalSec);
  $("tiltLimit").value = String(settings.tiltLimit);
  $("notifyOnline").checked = settings.notifyOnline;
  $("notifyResults").checked = settings.notifyResults;
  $("evalBar").checked = settings.evalBar;
  $("bestMove").checked = settings.bestMove;
  $("analyzeGame").checked = settings.analyzeGame;
  if ($("hideOpponent")) $("hideOpponent").checked = !!settings.hideOpponent;
  if ($("blunderAlerts")) $("blunderAlerts").checked = !!settings.blunderAlerts;
  if ($("pictureInPicture")) $("pictureInPicture").checked = settings.pictureInPicture !== false;
  if ($("timeWarning")) $("timeWarning").checked = settings.timeWarning !== false;
  $("followNextGame").checked = settings.followNextGame;
  if ($("engineId")) $("engineId").value = settings.engineId || "stockfish-lite";
  if ($("analysisDepth")) $("analysisDepth").value = String(settings.analysisDepth || 12);
  for (const box of $("timeclasses").querySelectorAll("input")) {
    box.checked = settings.timeclasses[box.value] !== false;
  }
}

let playSession = null;
let playSessionTimer = 0;

function psMode() {
  return document.querySelector('input[name="psMode"]:checked')?.value === "minutes" ? "minutes" : "games";
}

function syncPsGoalLabel() {
  const minutes = psMode() === "minutes";
  $("psGoalLabel").textContent = minutes ? "Minutes" : "Games";
  $("psGoal").max = minutes ? "180" : "100";
  $("psGoal").min = "1";
  if (!$("psGoal").value) $("psGoal").value = minutes ? "30" : "5";
}

function playSessionProgressText(s) {
  if (!s) return "";
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

function playSessionRatio(s) {
  if (!s) return 0;
  if (s.mode === "minutes") {
    const elapsed = Math.max(0, Date.now() - (s.startedAt || 0));
    const total = Math.max(1, Number(s.goal || 1) * 60_000);
    return Math.min(1, elapsed / total);
  }
  return Math.min(1, Number(s.gamesDone || 0) / Math.max(1, Number(s.goal || 1)));
}

function renderPlaySession(s = playSession) {
  playSession = s || null;
  const active = !!playSession?.active;
  $("playSessionBadge").hidden = !active;
  $("playSessionSetup").hidden = active;
  $("playSessionActive").hidden = !active;
  clearInterval(playSessionTimer);

  const summary = $("playSessionSummary");
  if (!active) {
    summary.textContent = "Set a goal, then auto-queue until you hit it";
    return;
  }

  const paint = () => {
    if (!playSession?.active) return;
    const label = playSessionProgressText(playSession);
    $("psProgress").textContent = label;
    $("psFill").style.width = `${Math.round(playSessionRatio(playSession) * 100)}%`;
    const target = playSession.queueTarget === "rematch" ? "Rematch" : "New Game";
    $("psActiveHint").textContent = `Auto-queuing ${target} on Chess.com after each game.`;
    summary.textContent = label;
  };
  paint();
  playSessionTimer = setInterval(paint, 1000);
}

async function renderData() {
  const data = await chrome.storage.local.get([
    "statuses",
    "lastCheck",
    "myStats",
    "nextCheck",
    "apiFriends",
    "scrapedFriends",
    "friendsStatus",
    "playSession",
  ]);
  nextCheck = data.nextCheck || 0;
  renderBell();
  renderAccount();
  renderStats(data.myStats);
  renderPlaySession(data.playSession);
  renderPlayers(data.statuses || {}, data.apiFriends || [], data.scrapedFriends || [], data.friendsStatus || null);
  lastCheck = data.lastCheck || 0;
  renderStatus();
}

function setAuthError(msg) {
  const el = $("authError");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function showAuthMode(mode) {
  const login = mode === "login";
  $("loginForm").hidden = !login;
  $("registerForm").hidden = login;
  $("authTabLogin").classList.toggle("active", login);
  $("authTabRegister").classList.toggle("active", !login);
  $("authTabLogin").setAttribute("aria-selected", String(login));
  $("authTabRegister").setAttribute("aria-selected", String(!login));
  setAuthError("");
}

function setAuthedUi(user) {
  const signedIn = !!user;
  $("authPanel").hidden = signedIn;
  $("appShell").hidden = !signedIn;
  if ($("header-side") || $("settingsToggle")) {
    const side = document.querySelector(".header-side");
    if (side) side.hidden = !signedIn;
  }
  if ($("authAccountLabel")) {
    $("authAccountLabel").textContent = signedIn
      ? `Signed in as ${user.username} (${user.email})`
      : "Not signed in";
  }
}

async function load() {
  const { settings: saved } = await chrome.storage.local.get("settings");
  applySettings(saved);
  fillSettingsForm();
  syncPsGoalLabel();

  const user = (await window.ChessRadarAuth?.me?.()) || null;
  setAuthedUi(user);
  if (!user) {
    showAuthMode("login");
    return;
  }
  await renderData();
}

let lastCheck = 0;
let nextCheck = 0;
let refreshing = false;

function timeAgo(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

function renderStatus() {
  const dot = $("statusDot");
  if (refreshing) {
    dot.className = "status-dot busy";
    $("meta").textContent = "Refreshing…";
    $("metaSub").textContent = "Checking players and stats";
    return;
  }
  if (!lastCheck) {
    dot.className = "status-dot";
    $("meta").textContent = "Not checked yet";
    $("metaSub").textContent = "Press Refresh to check now";
    return;
  }
  const stale = Date.now() - lastCheck > Math.max(60, settings.intervalSec || 60) * 2000;
  dot.className = `status-dot ${stale ? "stale" : "fresh"}`;
  $("meta").textContent = `Updated ${timeAgo(lastCheck)}`;
  const left = Math.ceil((nextCheck - Date.now()) / 1000);
  const next = left > 0 ? `next in ${left >= 60 ? `${Math.ceil(left / 60)} min` : `${left}s`}` : "next check soon";
  $("metaSub").textContent = `${new Date(lastCheck).toLocaleTimeString()} · ${next}`;
}

setInterval(renderStatus, 1000);

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

let accountProfile = { username: "", avatar: "", loaded: false };

function showAccountAvatar(url) {
  const img = $("accountAvatar");
  const letter = $("accountLetter");
  if (url) {
    img.hidden = false;
    letter.hidden = true;
    if (img.src !== url) img.src = url;
    return;
  }
  img.hidden = true;
  img.removeAttribute("src");
  letter.hidden = false;
}

function renderAccount() {
  const name = (settings.username || "").trim();
  const chip = $("accountChip");
  const empty = $("accountEmpty");
  if (!name) {
    chip.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  chip.hidden = false;
  const key = name.toLowerCase();
  $("accountName").textContent = name;
  $("accountLetter").textContent = name.slice(0, 1).toUpperCase();
  chip.href = `https://www.chess.com/member/${encodeURIComponent(name)}`;
  chip.title = `${name} on Chess.com`;
  if (accountProfile.username !== key) {
    accountProfile = { username: key, avatar: "", loaded: false };
    showAccountAvatar("");
    loadAccountAvatar(name);
    return;
  }
  showAccountAvatar(accountProfile.avatar);
}

async function loadAccountAvatar(name) {
  const key = name.toLowerCase();
  let avatar = "";
  try {
    const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(name)}`);
    if (res.ok) {
      const info = await res.json();
      avatar = info.avatar || "";
      if (info.username && norm(settings.username) === key) $("accountName").textContent = info.username;
    }
  } catch {
    avatar = "";
  }
  if (norm(settings.username) !== key) return;
  accountProfile = { username: key, avatar, loaded: true };
  showAccountAvatar(avatar);
}

function renderStats(stats) {
  if (!stats || !settings.username) {
    $("statsSection").hidden = true;
    return;
  }
  $("statsSection").hidden = false;

  const box = $("ratings");
  box.replaceChildren();
  for (const tc of ["bullet", "blitz", "rapid", "daily"]) {
    const r = stats.ratings?.[tc];
    const today = stats.session?.byClass?.[tc];
    const card = document.createElement("div");
    card.className = "rating";
    card.title = r?.best ? `Best: ${r.best}` : "";

    const label = document.createElement("div");
    label.className = "tc";
    label.textContent = tc;
    const value = document.createElement("div");
    value.className = "value";
    value.textContent = r ? r.rating : "–";
    const delta = document.createElement("div");
    delta.className = "delta";
    if (today?.change) {
      delta.textContent = `${signed(today.change)} today`;
      delta.classList.add(today.change > 0 ? "up" : "down");
    }

    const pct = document.createElement("div");
    pct.className = "pct";
    if (r?.percentile != null) {
      pct.innerHTML = '<span class="pct-label">better than </span><span class="pct-value"></span>';
      pct.querySelector(".pct-value").textContent = `${r.percentile}%`;
      pct.classList.add(r.percentile >= 90 ? "pct-top" : r.percentile >= 50 ? "pct-mid" : "pct-low");
      const tips = [`Better than ${r.percentile}% of ${tc} players`];
      if (r.globalRank) tips.push(`Global rank #${r.globalRank.toLocaleString()}`);
      if (r.best) tips.push(`Best rating: ${r.best}`);
      card.title = tips.join("\n");
    } else {
      pct.innerHTML = '<span class="pct-label">better than </span><span class="pct-value">–</span>';
    }
    card.append(label, value, pct);
    if (today?.change) card.insertBefore(delta, pct);
    box.append(card);
  }

  const s = stats.session;
  const p = $("session");
  p.replaceChildren();
  if (!s?.total) {
    p.textContent = "No games played today.";
    return;
  }
  p.append(`Today: ${s.total} game${s.total === 1 ? "" : "s"} · ${s.win}W ${s.loss}L ${s.draw}D`);
  const streak = stats.streak;
  if (streak && streak.count >= 2) {
    const span = document.createElement("span");
    const word = { win: "wins", loss: "losses", draw: "draws" }[streak.outcome];
    span.textContent = ` · ${streak.count} ${word} in a row`;
    if (streak.outcome === "loss") span.className = "warn";
    p.append(span);
  }
}

const norm = (name) => String(name || "").trim().toLowerCase();
const rank = (s) => (s.activity === "playing" ? 0 : s.status !== "offline" ? 1 : 2);

const RATING_ORDER = ["bullet", "blitz", "rapid", "daily"];
const RATING_ICONS = { bullet: "•", blitz: "⚡", rapid: "◷", daily: "☀" };

function playerRatings(s) {
  const row = document.createElement("div");
  row.className = "player-ratings";
  RATING_ORDER.forEach((tc, i) => {
    const chip = document.createElement("span");
    chip.style.gridColumn = String(i + 1);
    chip.title = tc[0].toUpperCase() + tc.slice(1);
    const rating = s.ratings?.[tc];
    const iEl = document.createElement("i");
    iEl.textContent = RATING_ICONS[tc];
    if (!rating) {
      chip.className = `prating prating-empty prating-${tc}`;
      chip.append(iEl, "----");
      row.append(chip);
      return;
    }
    chip.className = `prating prating-${tc}`;
    if (s.activity === "playing" && s.timeclass === tc) chip.classList.add("current");
    chip.append(iEl, String(rating));
    row.append(chip);
  });
  return row;
}

function watchUrl(s) {
  if (!s.url) return s.url;
  try {
    const u = new URL(s.url);
    // Chess.com's ?username= is a play/challenge param and can bounce spectators to /play/online.
    u.searchParams.delete("username");
    if (s.username) u.searchParams.set("cfn", s.username);
    return u.toString();
  } catch {
    return s.url;
  }
}

function playerRow(s, { removable = false } = {}) {
  const li = document.createElement("li");
  const dot = document.createElement("span");
  dot.className = "dot " + (s.activity === "playing" ? "playing" : s.status !== "offline" ? "online" : "");
  li.append(dot);

  const avatar = document.createElement(s.avatar ? "img" : "span");
  avatar.className = "avatar";
  if (s.avatar) {
    avatar.src = s.avatar;
    avatar.alt = "";
  } else {
    avatar.classList.add("avatar-letter");
    avatar.textContent = (s.username || "?").slice(0, 1).toUpperCase();
  }
  li.append(avatar);

  const info = document.createElement("div");
  info.className = "player-info";
  const a = document.createElement("a");
  a.textContent = s.username;
  a.href = `https://www.chess.com/member/${s.username}`;
  a.target = "_blank";
  info.append(a);
  info.append(playerRatings(s));
  li.append(info);

  if (s.activity === "playing") {
    // The highlighted rating chip already shows the game type; only fall back to text without one.
    if (!info.querySelector(".prating.current")) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = s.timeclass || "playing";
      li.append(tag);
    }

    if (s.url) {
      const watch = document.createElement("button");
      watch.className = "watch";
      watch.textContent = "Watch";
      watch.title = s.privateGame
        ? "Chess.com may block this if the game is private and you are not friends"
        : "Watch live game";
      watch.onclick = async () => {
        const tab = await chrome.tabs.create({ url: watchUrl(s) });
        if (tab?.id) {
          await chrome.runtime.sendMessage({
            type: "watchingTab",
            tabId: tab.id,
            username: s.username,
            gameId: s.gameId,
          });
        }
      };
      li.append(watch);
    }
  }

  if (removable) {
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "Stop watching";
    remove.onclick = async () => {
      const key = norm(s.username);
      settings.watchedPlayers = settings.watchedPlayers.filter((n) => norm(n) !== key);
      if (!settings.hiddenPlayers.some((n) => norm(n) === key)) settings.hiddenPlayers.push(s.username);
      await saveSettings();
    };
    li.append(remove);
  }
  return li;
}

function emptyRow(title, detail = "") {
  const li = document.createElement("li");
  li.className = "empty-state";
  const heading = document.createElement("div");
  heading.className = "empty-title";
  heading.textContent = title;
  li.append(heading);
  if (detail) {
    const note = document.createElement("div");
    note.className = "empty-detail";
    note.textContent = detail;
    li.append(note);
  }
  return li;
}

function listedNames(apiFriends = [], scrapedFriends = []) {
  const hidden = new Set((settings.hiddenPlayers || []).map(norm));
  const me = norm(settings.username);
  return [
    ...new Set(
      [...(apiFriends || []), ...(scrapedFriends || []), ...settings.watchedPlayers]
        .map((n) => String(n || "").trim())
        .filter((n) => n && norm(n) !== me && !hidden.has(norm(n)))
    ),
  ];
}

function emptyFriendsMessage(friendsStatus) {
  if (!settings.username) {
    return {
      title: "No players yet",
      detail: "Open Settings, enter your Chess.com username, save, then press Refresh. You can also search and add anyone above.",
    };
  }
  if (friendsStatus?.hint) {
    return {
      title: "Friends will appear here after a refresh",
      detail: friendsStatus.hint,
    };
  }
  return {
    title: "Friends will appear here after a refresh",
    detail: "Stay logged into Chess.com in this browser, press Refresh, or search above to add a player.",
  };
}

function renderFriendsPager(total) {
  const pager = $("friendsPager");
  const prev = $("friendsPrev");
  const next = $("friendsNext");
  const label = $("friendsPageLabel");
  if (!pager || !prev || !next || !label) return;

  const pages = Math.max(1, Math.ceil(total / FRIENDS_PER_PAGE));
  if (friendsPage >= pages) friendsPage = pages - 1;
  if (friendsPage < 0) friendsPage = 0;

  const show = total > FRIENDS_PER_PAGE;
  pager.hidden = !show;
  if (!show) {
    friendsPage = 0;
    return;
  }

  label.textContent = `${friendsPage + 1} / ${pages}`;
  prev.disabled = friendsPage <= 0;
  next.disabled = friendsPage >= pages - 1;
}

function renderPlayers(statuses, apiFriends = [], scrapedFriends = [], friendsStatus = null) {
  const hint = $("refreshHint");
  if (hint) hint.hidden = !friendsStatus?.needsTab;
  const byName = new Map(Object.values(statuses).map((s) => [norm(s.username), s]));
  const sort = (a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username);

  const watched = listedNames(apiFriends, scrapedFriends)
    .map((name) => byName.get(norm(name)) || { username: name, status: "offline", pending: true })
    .sort(sort);
  lastFriendsSnapshot = watched;
  const watchList = $("watched");
  watchList.replaceChildren();
  const playingRows = watched.filter((s) => s.activity === "playing");
  const playing = playingRows.length;
  const noun = watched.length === 1 ? "friend" : "friends";
  $("watchCount").textContent = watched.length ? String(watched.length) : "";
  $("friendsSummary").textContent = !settings.username
    ? "Set your username in Settings first"
    : watched.length
      ? `${watched.length} ${noun} · ${playing} playing`
      : "No friends yet";
  const playingList = $("playingNow");
  const playingEmpty = $("playingEmpty");
  playingList.replaceChildren();
  if (!playing) {
    playingList.hidden = true;
    playingEmpty.hidden = false;
  } else {
    playingList.hidden = false;
    playingEmpty.hidden = true;
    const shown = playingRows.slice(0, 3);
    for (const s of shown) playingList.append(playerRow(s, { removable: false }));
    if (playingRows.length > shown.length) {
      const more = document.createElement("li");
      more.className = "more-playing";
      more.textContent = `See ${playingRows.length - shown.length} more playing`;
      more.onclick = () => showFriends(true);
      playingList.append(more);
    }
  }
  if (!watched.length) {
    const msg = emptyFriendsMessage(friendsStatus);
    watchList.append(emptyRow(msg.title, msg.detail));
    renderFriendsPager(0);
    return;
  }

  renderFriendsPager(watched.length);
  const start = friendsPage * FRIENDS_PER_PAGE;
  const pageRows = watched.slice(start, start + FRIENDS_PER_PAGE);
  for (const s of pageRows) watchList.append(playerRow(s, { removable: true }));
}

async function saveSettings() {
  delete settings.manualFriends;
  await chrome.storage.local.set({ settings });
  await send("settingsChanged");
  await renderData();
}

$("save").onclick = async () => {
  settings.username = $("username").value.trim();
  settings.intervalSec = Number($("interval").value);
  settings.notifyOnline = $("notifyOnline").checked;
  settings.notifyResults = $("notifyResults").checked;
  settings.evalBar = $("evalBar").checked;
  settings.bestMove = $("bestMove").checked;
  settings.analyzeGame = $("analyzeGame").checked;
  settings.hideOpponent = !!$("hideOpponent").checked;
  settings.blunderAlerts = !!$("blunderAlerts").checked;
  settings.pictureInPicture = !!$("pictureInPicture").checked;
  settings.timeWarning = !!$("timeWarning").checked;
  settings.followNextGame = $("followNextGame").checked;
  settings.engineId = $("engineId").value;
  settings.analysisDepth = Number($("analysisDepth").value) || 12;
  settings.tiltLimit = Number($("tiltLimit").value);
  for (const box of $("timeclasses").querySelectorAll("input")) {
    settings.timeclasses[box.value] = box.checked;
  }
  const btn = $("save");
  btn.disabled = true;
  btn.textContent = "Saving…";
  await saveSettings();
  btn.textContent = "Saved ✓";
  btn.classList.add("saved");
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Save settings";
    btn.classList.remove("saved");
    showSettings(false);
  }, 700);
};

function showSettings(open) {
  $("settingsPanel").hidden = !open;
  $("homePanel").hidden = open;
  if (open) {
    $("friendsPanel").hidden = true;
    $("playSessionPanel").hidden = true;
  }
  $("openFriends").setAttribute("aria-expanded", "false");
  $("openPlaySession").setAttribute("aria-expanded", "false");
  $("settingsToggle").classList.toggle("active", open);
  $("settingsToggle").setAttribute("aria-pressed", String(open));
  $("settingsToggle").title = open ? "Close settings" : "Settings";
}

function showFriends(open) {
  if (open) {
    $("settingsPanel").hidden = true;
    $("homePanel").hidden = false;
    $("playSessionPanel").hidden = true;
    $("openPlaySession").setAttribute("aria-expanded", "false");
    $("settingsToggle").classList.remove("active");
    $("settingsToggle").setAttribute("aria-pressed", "false");
    $("settingsToggle").title = "Settings";
  }
  $("friendsPanel").hidden = !open;
  $("openFriends").setAttribute("aria-expanded", String(open));
  if (open) $("addWatch").focus();
}

function showPlaySession(open) {
  if (open) {
    $("settingsPanel").hidden = true;
    $("homePanel").hidden = false;
    $("friendsPanel").hidden = true;
    $("openFriends").setAttribute("aria-expanded", "false");
    $("settingsToggle").classList.remove("active");
    $("settingsToggle").setAttribute("aria-pressed", "false");
    $("settingsToggle").title = "Settings";
  }
  $("playSessionPanel").hidden = !open;
  $("openPlaySession").setAttribute("aria-expanded", String(open));
  if (open && !playSession?.active) $("psGoal").focus();
}

$("openFriends").onclick = () => showFriends(true);
$("openPlaySession").onclick = () => showPlaySession(true);
$("learnTheory").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("theory.html") });
$("closeFriends").onclick = () => showFriends(false);
$("closePlaySession").onclick = () => showPlaySession(false);

for (const box of document.querySelectorAll('input[name="psMode"]')) {
  box.addEventListener("change", syncPsGoalLabel);
}

$("psStart").onclick = async () => {
  $("psError").hidden = true;
  $("psError").textContent = "";
  if (!settings.username) {
    $("psError").hidden = false;
    $("psError").textContent = "Add your Chess.com username in Settings first.";
    return;
  }
  const mode = psMode();
  const goal = Number($("psGoal").value);
  if (!Number.isFinite(goal) || goal < 1) {
    $("psError").hidden = false;
    $("psError").textContent = "Enter a goal of at least 1.";
    return;
  }
  const btn = $("psStart");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "playSessionStart",
      mode,
      goal,
      queueTarget: $("psQueue").value,
    });
    if (!res?.ok) throw new Error(res?.error || "Could not start session.");
    renderPlaySession(res.session);
  } catch (err) {
    $("psError").hidden = false;
    $("psError").textContent = err?.message || "Could not start session.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Start session";
  }
};

$("psStop").onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: "playSessionStop" });
  renderPlaySession(res?.session || null);
};
$("friendsPrev").onclick = () => {
  if (friendsPage <= 0) return;
  friendsPage -= 1;
  const watchList = $("watched");
  watchList.replaceChildren();
  renderFriendsPager(lastFriendsSnapshot.length);
  const start = friendsPage * FRIENDS_PER_PAGE;
  for (const s of lastFriendsSnapshot.slice(start, start + FRIENDS_PER_PAGE)) {
    watchList.append(playerRow(s, { removable: true }));
  }
};
$("friendsNext").onclick = () => {
  const pages = Math.max(1, Math.ceil(lastFriendsSnapshot.length / FRIENDS_PER_PAGE));
  if (friendsPage >= pages - 1) return;
  friendsPage += 1;
  const watchList = $("watched");
  watchList.replaceChildren();
  renderFriendsPager(lastFriendsSnapshot.length);
  const start = friendsPage * FRIENDS_PER_PAGE;
  for (const s of lastFriendsSnapshot.slice(start, start + FRIENDS_PER_PAGE)) {
    watchList.append(playerRow(s, { removable: true }));
  }
};
$("friendsPanel").onclick = (e) => {
  if (e.target === $("friendsPanel")) showFriends(false);
};
$("playSessionPanel").onclick = (e) => {
  if (e.target === $("playSessionPanel")) showPlaySession(false);
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("friendsPanel").hidden) showFriends(false);
  else if (!$("playSessionPanel").hidden) showPlaySession(false);
  else if (!$("settingsPanel").hidden) showSettings(false);
});

$("followNextGame").onchange = async () => {
  settings.followNextGame = $("followNextGame").checked;
  await chrome.storage.local.set({ settings });
};
$("analyzeGame").onchange = async () => {
  settings.analyzeGame = $("analyzeGame").checked;
  await chrome.storage.local.set({ settings });
};
$("hideOpponent").onchange = async () => {
  settings.hideOpponent = $("hideOpponent").checked;
  await chrome.storage.local.set({ settings });
};
$("blunderAlerts").onchange = async () => {
  settings.blunderAlerts = $("blunderAlerts").checked;
  await chrome.storage.local.set({ settings });
};
$("pictureInPicture").onchange = async () => {
  settings.pictureInPicture = $("pictureInPicture").checked;
  await chrome.storage.local.set({ settings });
};
$("timeWarning").onchange = async () => {
  settings.timeWarning = $("timeWarning").checked;
  await chrome.storage.local.set({ settings });
};
$("evalBar").onchange = async () => {
  settings.evalBar = $("evalBar").checked;
  await chrome.storage.local.set({ settings });
};
$("bestMove").onchange = async () => {
  settings.bestMove = $("bestMove").checked;
  await chrome.storage.local.set({ settings });
};

$("settingsToggle").onclick = () => showSettings($("settingsPanel").hidden);
$("accountEmpty").onclick = () => showSettings(true);
$("accountAvatar").onerror = () => showAccountAvatar("");

$("addBtn").onclick = async () => {
  const pick = suggestItems[suggestIndex] || suggestItems[0];
  await addPlayer(pick?.username || $("addWatch").value.trim());
};

const suggestBox = $("addSuggest");
let suggestItems = [];
let suggestIndex = -1;
let suggestTimer = 0;
let suggestSeq = 0;

function hideSuggest() {
  suggestItems = [];
  suggestIndex = -1;
  suggestBox.hidden = true;
  suggestBox.replaceChildren();
}

function renderSuggest() {
  suggestBox.replaceChildren();
  if (!suggestItems.length) {
    suggestBox.hidden = true;
    return;
  }
  suggestItems.forEach((u, i) => {
    const li = document.createElement("li");
    const already = settings.watchedPlayers.some((n) => norm(n) === norm(u.username));
    li.className = `${i === suggestIndex ? "active" : ""}${already ? " already" : ""}`.trim();
    if (u.avatar) {
      const img = document.createElement("img");
      img.src = u.avatar;
      img.alt = "";
      li.append(img);
    } else {
      const ph = document.createElement("span");
      li.append(ph);
    }
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "s-name";
    name.textContent = u.username;
    info.append(name);
    if (u.name && norm(u.name) !== norm(u.username)) {
      const meta = document.createElement("div");
      meta.className = "s-meta";
      meta.textContent = already ? `${u.name} · already added` : u.name;
      info.append(meta);
    } else if (already) {
      const meta = document.createElement("div");
      meta.className = "s-meta";
      meta.textContent = "Already added";
      info.append(meta);
    }
    li.append(info);
    if (u.title) {
      const title = document.createElement("span");
      title.className = "s-title";
      title.textContent = u.title;
      li.append(title);
    }
    li.onmousedown = (e) => e.preventDefault();
    li.onclick = () => {
      if (already) {
        $("addError").textContent = `Already watching ${u.username}.`;
        return;
      }
      addPlayer(u.username);
    };
    suggestBox.append(li);
  });
  suggestBox.hidden = false;
}

async function searchPlayers(query) {
  const q = query.trim();
  const seq = ++suggestSeq;
  if (q.length < 1) {
    hideSuggest();
    return;
  }
  const listed = await chrome.storage.local.get(["apiFriends", "scrapedFriends"]);
  if (listedNames(listed.apiFriends, listed.scrapedFriends).some((n) => norm(n) === norm(q))) {
    hideSuggest();
    $("addError").textContent = `Already watching ${q}.`;
    return;
  }
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "searchUsers", query: q });
  } catch {
    res = { users: [] };
  }
  if (seq !== suggestSeq || $("addWatch").value.trim() !== q) return;
  suggestItems = res?.users || [];
  if (!suggestItems.length) {
    try {
      const pub = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(q)}`);
      if (pub.ok) {
        const info = await pub.json();
        if (info.username && !settings.watchedPlayers.some((n) => norm(n) === norm(info.username))) {
          suggestItems = [{ username: info.username, avatar: info.avatar || "", title: info.title || "", name: info.name || "" }];
        }
      }
    } catch {
      // public lookup failed
    }
  }
  suggestIndex = suggestItems.length ? 0 : -1;
  renderSuggest();
  if (!suggestItems.length && q.length >= 2) {
    $("addError").textContent = res?.already
      ? `Already watching ${res.already}.`
      : "No matching player found.";
  }
}

$("addWatch").addEventListener("input", () => {
  $("addError").textContent = "";
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => searchPlayers($("addWatch").value), 180);
});
$("addWatch").addEventListener("focus", () => {
  if ($("addWatch").value.trim()) searchPlayers($("addWatch").value);
});
$("addWatch").addEventListener("blur", () => setTimeout(hideSuggest, 120));
$("addWatch").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideSuggest();
    return;
  }
  if (!suggestItems.length) {
    if (e.key === "Enter") $("addBtn").click();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestIndex = (suggestIndex + 1) % suggestItems.length;
    renderSuggest();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
    renderSuggest();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const pick = suggestItems[suggestIndex] || suggestItems[0];
    addPlayer(pick.username);
  }
});

async function addPlayer(name) {
  name = String(name || "").trim();
  $("addError").textContent = "";
  if (!name) return;
  const data = await chrome.storage.local.get(["apiFriends", "scrapedFriends"]);
  if (listedNames(data.apiFriends, data.scrapedFriends).some((n) => norm(n) === norm(name))) {
    $("addError").textContent = `Already watching ${name}.`;
    return;
  }
  $("addBtn").textContent = "...";
  const res = await chrome.runtime.sendMessage({ type: "lookupUser", username: name });
  $("addBtn").textContent = "Add";
  if (!res?.ok) {
    $("addError").textContent = `Player "${name}" not found on chess.com.`;
    return;
  }
  const added = res.username || name;
  settings.hiddenPlayers = (settings.hiddenPlayers || []).filter((n) => norm(n) !== norm(added));
  settings.watchedPlayers.push(added);
  $("addWatch").value = "";
  hideSuggest();
  await saveSettings();
}

async function refresh({ manual = false } = {}) {
  if (refreshing) return;
  const btn = $("checkNow");
  const label = btn.querySelector("span");
  refreshing = true;
  btn.disabled = true;
  btn.classList.add("spinning");
  if (manual) label.textContent = "Refreshing";
  renderStatus();
  try {
    await send("checkNow");
  } finally {
    refreshing = false;
    btn.disabled = false;
    btn.classList.remove("spinning");
    await renderData();
    if (manual) {
      btn.classList.add("done");
      label.textContent = "Updated";
      setTimeout(() => {
        btn.classList.remove("done");
        label.textContent = "Refresh";
      }, 1500);
    }
  }
}

$("checkNow").onclick = () => refresh({ manual: true });

// The background alarm does the automatic checks; this is only a fallback in case it is late.
let autoTimer = null;
function scheduleAutoRefresh() {
  clearTimeout(autoTimer);
  const due = nextCheck || Date.now() + intervalMs();
  autoTimer = setTimeout(() => {
    if (Date.now() >= nextCheck) refresh();
  }, Math.max(0, due - Date.now()) + 5000);
}

function intervalMs() {
  return Math.max(30, settings.intervalSec || 60) * 1000;
}

// Re-render whenever the background worker stores new results (alarm checks, other popups, etc.).
let renderSoon = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    applySettings(changes.settings.newValue);
    if ($("settingsPanel").hidden) fillSettingsForm();
  }
  if (changes.nextCheck) {
    nextCheck = changes.nextCheck.newValue || 0;
    scheduleAutoRefresh();
    renderStatus();
  }
  if (changes.playSession) renderPlaySession(changes.playSession.newValue);
  if (
    changes.statuses ||
    changes.lastCheck ||
    changes.myStats ||
    changes.settings ||
    changes.apiFriends ||
    changes.scrapedFriends ||
    changes.friendsStatus
  ) {
    if (refreshing) return;
    clearTimeout(renderSoon);
    renderSoon = setTimeout(() => renderData(), 80);
  }
});

function renderBell() {
  const on = settings.notificationsEnabled !== false;
  const btn = $("notifToggle");
  btn.classList.toggle("off", !on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Notifications on — click to mute" : "Notifications off — click to enable";
}

$("notifToggle").onclick = async () => {
  const btn = $("notifToggle");
  settings.notificationsEnabled = settings.notificationsEnabled === false;
  renderBell();
  if (settings.notificationsEnabled) {
    btn.classList.remove("ring");
    void btn.offsetWidth;
    btn.classList.add("ring");
  }
  await chrome.runtime.sendMessage({ type: "setNotifications", enabled: settings.notificationsEnabled });
};

$("authTabLogin").onclick = () => showAuthMode("login");
$("authTabRegister").onclick = () => showAuthMode("register");

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  setAuthError("");
  const btn = $("loginBtn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const data = await window.ChessRadarAuth.login({
      emailOrUsername: $("loginIdentity").value.trim(),
      password: $("loginPassword").value,
    });
    setAuthedUi(data.user);
    await renderData();
    if (!settings.username) showSettings(true);
    scheduleAutoRefresh();
    refresh();
  } catch (err) {
    setAuthError(err.message || "Login failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "Log in";
  }
};

$("registerForm").onsubmit = async (e) => {
  e.preventDefault();
  setAuthError("");
  const btn = $("registerBtn");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const data = await window.ChessRadarAuth.register({
      email: $("registerEmail").value.trim(),
      username: $("registerUsername").value.trim(),
      password: $("registerPassword").value,
    });
    setAuthedUi(data.user);
    await renderData();
    showSettings(true);
    scheduleAutoRefresh();
  } catch (err) {
    setAuthError(err.message || "Registration failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create account";
  }
};

$("logoutBtn").onclick = async () => {
  await window.ChessRadarAuth.logout();
  setAuthedUi(null);
  showAuthMode("login");
  showSettings(false);
  showFriends(false);
  showPlaySession(false);
};

load().then(async () => {
  const { user } = (await window.ChessRadarAuth?.getSession?.()) || {};
  if (!user) return;
  if (!settings.username) showSettings(true);
  scheduleAutoRefresh();
  if (Date.now() - lastCheck > intervalMs()) refresh();
});
