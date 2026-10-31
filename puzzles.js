import { CfnBoard } from "./lib/cfn-board.js";
import { Chess } from "./lib/chess.js";
import { hideCorrectMove, showCorrectMove } from "./celebrate.js";

const CLASS_LABEL = {
  blunder: "Blunder",
  mistake: "Mistake",
  inaccuracy: "Inaccuracy",
};

const REVIEW_CLASSES = [
  { id: "brilliant", label: "Brilliant", icon: "!!" },
  { id: "best", label: "Best", icon: "★" },
  { id: "excellent", label: "Excellent", icon: "!" },
  { id: "good", label: "Good", icon: "✓" },
  { id: "inaccuracy", label: "Inaccuracy", icon: "?!" },
  { id: "mistake", label: "Mistake", icon: "?" },
  { id: "blunder", label: "Blunder", icon: "??" },
];

const qs = new URLSearchParams(location.search);
const sessionId = qs.get("session") || "";

const els = {
  trainView: document.getElementById("trainView"),
  resultsView: document.getElementById("resultsView"),
  errorView: document.getElementById("errorView"),
  errorText: document.getElementById("errorText"),
  boardHost: document.getElementById("boardHost"),
  reviewPanel: document.getElementById("reviewPanel"),
  puzzleCount: document.getElementById("puzzleCount"),
  classBadge: document.getElementById("classBadge"),
  moveMeta: document.getElementById("moveMeta"),
  prompt: document.getElementById("prompt"),
  note: document.getElementById("note"),
  attempts: document.getElementById("attempts"),
  hintsUsed: document.getElementById("hintsUsed"),
  progressDots: document.getElementById("progressDots"),
  hintBtn: document.getElementById("hintBtn"),
  retryBtn: document.getElementById("retryBtn"),
  solutionBtn: document.getElementById("solutionBtn"),
  playPanel: document.getElementById("playPanel"),
  exitBtn: document.getElementById("exitBtn"),
  retryMissedBtn: document.getElementById("retryMissedBtn"),
  returnBtn: document.getElementById("returnBtn"),
  errorClose: document.getElementById("errorClose"),
  resultGrid: document.getElementById("resultGrid"),
};

let session = null;
let hideOpponent = false;
let board = null;
let index = 0;
let step = 0;
let attempts = 0;
let hints = 0;
let hintLevel = 0;
let solved = false;
let revealed = false;
let startedAt = Date.now();
let advanceTimer = 0;
let totals = { solved: 0, incorrect: 0, hints: 0 };
let perPuzzle = [];

function showError(message) {
  els.trainView.hidden = true;
  els.resultsView.hidden = true;
  els.errorView.hidden = false;
  els.errorText.textContent = message;
}

function currentPuzzle() {
  return session?.puzzles?.[index] || null;
}

function acceptedAtStep(puzzle, uci) {
  const played = String(uci || "").toLowerCase();
  const line = puzzle.line || puzzle.acceptedUcis || [puzzle.bestUci];
  const expected = String(line[step] || "").toLowerCase();
  if (expected && played === expected) return true;
  if (step === 0) {
    return (puzzle.acceptedUcis || [puzzle.bestUci]).map((u) => String(u).toLowerCase()).includes(played);
  }
  return false;
}

function lineLength(puzzle) {
  return (puzzle.line || [puzzle.bestUci]).length;
}

function setNote(text, tone = "") {
  els.note.textContent = text;
  els.note.className = `note${tone ? ` ${tone}` : ""}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function asPlayer(raw, fallback) {
  if (raw && typeof raw === "object") {
    return {
      name: raw.name || raw.username || fallback,
      rating: raw.rating ?? null,
      accuracy: raw.accuracy ?? null,
      counts: raw.counts || null,
    };
  }
  return { name: raw || fallback, rating: null, accuracy: null, counts: null };
}

function playerRecord(side) {
  const players = session.players || {};
  const full = side === "b" ? "black" : "white";
  return players[full] || players[side];
}

function accuracyClass(a) {
  if (a == null) return "";
  return a >= 90 ? "great" : a >= 75 ? "good" : a >= 60 ? "ok" : "bad";
}

function playerSummaryCard(side) {
  const player = asPlayer(playerRecord(side), side === "w" ? "White" : "Black");
  const you = session.own === side;
  const masked = hideOpponent && session.own && session.own !== side;
  if (masked) {
    player.name = "Opponent";
    player.rating = null;
  }
  const rating = player.rating != null ? esc(player.rating) : "—";
  return `
    <div class="rv-player ${side}">
      <div class="rv-who">
        <i class="pip ${side}"></i>
        <span class="rv-name" title="${esc(player.name)}">${esc(player.name)}${you ? `<em class="you">You</em>` : ""}</span>
      </div>
      <strong class="rv-acc">${rating}</strong>
      <span class="rv-acc-label">Rating</span>
    </div>`;
}

function renderAccuracies() {
  const white = asPlayer(playerRecord("w"), "White");
  const black = asPlayer(playerRecord("b"), "Black");
  const accuracy = (player) =>
    player.accuracy == null ? "—" : Number(player.accuracy).toFixed(1);
  return `
    <div class="rv-ratings">
      <div class="rv-rating">
        <strong class="${accuracyClass(white.accuracy)}">${accuracy(white)}</strong>
        <span>White accuracy</span>
      </div>
      <div class="rv-rating">
        <strong class="${accuracyClass(black.accuracy)}">${accuracy(black)}</strong>
        <span>Black accuracy</span>
      </div>
    </div>`;
}

function renderClassTable() {
  const white = asPlayer(playerRecord("w"), "White");
  const black = asPlayer(playerRecord("b"), "Black");
  const wCounts = white.counts || {};
  const bCounts = black.counts || {};
  const rows = REVIEW_CLASSES.map(
    (c) => `
      <tr class="cls-${c.id}">
        <td class="count">${esc(wCounts[c.id] || 0)}</td>
        <td class="label"><span class="icon">${c.icon}</span>${c.label}</td>
        <td class="count">${esc(bCounts[c.id] || 0)}</td>
      </tr>`
  ).join("");
  return `<table class="rv-table">${rows}</table>`;
}

function formatTimeControl(value) {
  const text = String(value || "");
  const match = text.match(/^(\d+)(?:\+(\d+))?$/);
  if (!match) return text;
  const minutes = Number(match[1]) / 60;
  const base = Number.isInteger(minutes) ? `${minutes} min` : `${minutes.toFixed(1)} min`;
  return match[2] ? `${base} + ${match[2]}` : base;
}

function renderReview() {
  if (!session || !els.reviewPanel) return;
  const gameId = session.gameId ? `Game ${session.gameId}` : "This game";
  const meta = [gameId, formatTimeControl(session.game?.timeControl), session.game?.result]
    .filter(Boolean)
    .join(" · ");
  const term = session.game?.termination ? `<p class="rv-term">${esc(session.game.termination)}</p>` : "";
  els.reviewPanel.innerHTML = `
    <div class="rv-players">
      ${playerSummaryCard("w")}
      ${playerSummaryCard("b")}
    </div>
    ${renderAccuracies()}
    ${renderClassTable()}
    <p class="rv-meta">${esc(meta)}</p>
    ${term}
  `;
}

function renderChrome() {
  const puzzle = currentPuzzle();
  if (!puzzle) return;
  const total = session.puzzles.length;
  els.puzzleCount.textContent = `Puzzle ${index + 1} of ${total}`;
  els.classBadge.textContent = CLASS_LABEL[puzzle.cls] || "Mistake";
  els.classBadge.className = `badge ${puzzle.cls || ""}`;
  els.moveMeta.textContent = `Move ${puzzle.moveNumber} — You missed a better move.`;
  els.prompt.textContent = step === 0 ? "Find the best move." : "Continue the line.";
  els.attempts.textContent = String(attempts);
  els.hintsUsed.textContent = String(hints);
  els.progressDots.innerHTML = session.puzzles
    .map((_, i) => {
      const done = perPuzzle[i]?.correct || (i < index);
      const current = i === index;
      return `<i class="${done ? "done" : ""}${current ? " current" : ""}"></i>`;
    })
    .join("");
  els.hintBtn.disabled = solved;
  els.solutionBtn.disabled = solved && !revealed;
  els.solutionBtn.textContent = revealed
    ? index + 1 >= session.puzzles.length
      ? "See results"
      : "Next puzzle"
    : "Show solution";
  renderReview();
}

function loadPuzzle() {
  clearTimeout(advanceTimer);
  hideCorrectMove();
  const puzzle = currentPuzzle();
  if (!puzzle) return showResults();
  els.playPanel.hidden = false;
  els.resultsView.hidden = true;
  step = 0;
  attempts = 0;
  hints = 0;
  hintLevel = 0;
  solved = false;
  revealed = false;
  els.solutionBtn.textContent = "Show solution";
  board.setOrientation(session.orientation || puzzle.color || "w");
  board.setInteractive(true);
  board.loadFen(puzzle.fen);
  setNote("Play the best move on the board.");
  renderChrome();
}

function opponentReply(puzzle) {
  const line = puzzle.line || [puzzle.bestUci];
  if (step >= line.length) return;
  // Single-engine-move puzzles: no fabricated opponent reply.
  if (line.length <= 1) return;
  const reply = line[step];
  if (!reply) return;
  const from = reply.slice(0, 2);
  const to = reply.slice(2, 4);
  const promotion = reply.slice(4, 5) || undefined;
  board.tryMove(from, to, promotion);
  step += 1;
}

async function saveProgress(entry) {
  try {
    await chrome.runtime.sendMessage({ type: "savePuzzleProgress", entry });
  } catch {
    // local training history is best-effort
  }
}

function finishPuzzle(correct) {
  solved = true;
  board.setInteractive(false);
  const puzzle = currentPuzzle();
  const record = {
    puzzleId: puzzle.id,
    correct,
    attempts,
    hints,
  };
  perPuzzle[index] = record;
  if (correct) totals.solved += 1;
  saveProgress({
    gameId: session.gameId,
    puzzleId: puzzle.id,
    fen: puzzle.fen,
    attempts,
    correct,
    hintsUsed: hints,
    completed: true,
    completedAt: Date.now(),
  });
  renderChrome();
  if (correct) {
    clearTimeout(advanceTimer);
    showCorrectMove({ move: puzzle.best || "" });
    advanceTimer = setTimeout(() => {
      hideCorrectMove();
      nextPuzzle();
    }, 2200);
  }
}

function onPlayerMove(move) {
  if (solved) return;
  const puzzle = currentPuzzle();
  attempts += 1;
  if (!acceptedAtStep(puzzle, move.uci)) {
    totals.incorrect += 1;
    board.setMarks({ bad: [move.from, move.to] });
    setNote("Not quite. Try again.", "bad");
    renderChrome();
    setTimeout(() => {
      if (solved) return;
      board.loadFen(puzzle.fen);
      board.setMarks({});
      setNote("Play the best move on the board.");
    }, 900);
    return;
  }

  board.setMarks({ good: [move.from, move.to] });
  step += 1;
  if (step >= lineLength(puzzle)) {
    setNote(puzzle.best ? `Correct! Best was ${puzzle.best}.` : "Correct!", "good");
    finishPuzzle(true);
    return;
  }

  setNote("Correct! Opponent replies…", "good");
  setTimeout(() => {
    opponentReply(puzzle);
    if (step >= lineLength(puzzle)) {
      setNote("Correct!", "good");
      finishPuzzle(true);
    } else {
      setNote("Find the next move.");
      board.setMarks({});
      board.setInteractive(true);
    }
    renderChrome();
  }, 450);
  renderChrome();
}

function applyHint() {
  if (solved) return;
  const puzzle = currentPuzzle();
  const line = puzzle.line || [puzzle.bestUci];
  const uci = String(line[step] || puzzle.bestUci || "");
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  hintLevel += 1;
  hints += 1;
  totals.hints += 1;
  if (hintLevel === 1) {
    board.setMarks({ hint: [from] });
    setNote("Hint: move the highlighted piece.");
  } else {
    board.setMarks({ hint: [from, to], arrow: { from, to } });
    setNote("Hint: destination highlighted.");
    hintLevel = 2;
  }
  renderChrome();
}

function showSolution() {
  if (solved) return;
  const puzzle = currentPuzzle();
  const line = puzzle.line || [puzzle.bestUci];
  const uci = String(line[step] || puzzle.bestUci || "");
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.slice(4, 5) || undefined;
  board.tryMove(from, to, promotion);
  board.setMarks({ good: [from, to], arrow: { from, to } });
  setNote(puzzle.best ? `Solution: ${puzzle.best}.` : `Solution: ${uci}.`);
  revealed = true;
  finishPuzzle(false);
}

function nextPuzzle() {
  index += 1;
  if (index >= session.puzzles.length) showResults();
  else loadPuzzle();
}

function showResults() {
  clearTimeout(advanceTimer);
  els.playPanel.hidden = true;
  els.resultsView.hidden = false;
  const total = session.puzzles.length;
  const wrongAttempts = totals.incorrect;
  const accuracy = wrongAttempts + totals.solved
    ? Math.round((totals.solved / (totals.solved + wrongAttempts)) * 1000) / 10
    : 0;
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const missed = session.puzzles.filter((_, i) => !perPuzzle[i]?.correct).length;
  els.retryMissedBtn.disabled = missed === 0;
  els.retryMissedBtn.textContent = missed ? `Retry missed puzzles (${missed})` : "No missed puzzles";
  els.resultGrid.innerHTML = `
    <div><strong>${total}</strong><span>Total puzzles</span></div>
    <div><strong>${totals.solved}</strong><span>Correct solutions</span></div>
    <div><strong>${wrongAttempts}</strong><span>Incorrect attempts</span></div>
    <div><strong>${totals.hints}</strong><span>Hints used</span></div>
    <div><strong>${accuracy}%</strong><span>Accuracy</span></div>
    <div><strong>${seconds}s</strong><span>Time spent</span></div>`;
}

function retryMissed() {
  const missed = session.puzzles.filter((p, i) => !perPuzzle[i]?.correct);
  if (!missed.length) {
    setNote("No missed puzzles.");
    return;
  }
  session = { ...session, puzzles: missed };
  index = 0;
  perPuzzle = [];
  totals = { solved: 0, incorrect: 0, hints: 0 };
  startedAt = Date.now();
  els.resultsView.hidden = true;
  els.playPanel.hidden = false;
  loadPuzzle();
}

async function returnToGame() {
  try {
    await chrome.runtime.sendMessage({
      type: "focusPuzzleSource",
      tabId: session?.sourceTabId ?? null,
      url: session?.sourceUrl || "",
    });
  } catch {
    // ignore
  }
}

async function boot() {
  if (!sessionId) return showError("Missing puzzle session. Open training from a finished game review.");
  const res = await chrome.runtime.sendMessage({ type: "getPuzzleSession", sessionId });
  if (!res?.ok || !res.session?.puzzles?.length) {
    return showError(res?.error === "expired"
      ? "This training session expired. Return to the game and click Retry Your Blunders again."
      : "Puzzle data was not found. Return to the game and click Retry Your Blunders again.");
  }
  session = res.session;
  const stored = await chrome.storage.local.get("settings");
  hideOpponent = !!stored.settings?.hideOpponent;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    hideOpponent = !!changes.settings.newValue?.hideOpponent;
    renderReview();
  });
  board = new CfnBoard(els.boardHost, {
    orientation: session.orientation || "w",
    onMove: onPlayerMove,
  });
  // Keep a chess.js copy available for validation helpers / future multi-PV.
  void Chess;
  loadPuzzle();
}

els.hintBtn.addEventListener("click", applyHint);
els.retryBtn.addEventListener("click", () => {
  if (!currentPuzzle()) return;
  clearTimeout(advanceTimer);
  hideCorrectMove();
  board.loadFen(currentPuzzle().fen);
  board.setMarks({});
  step = 0;
  solved = false;
  board.setInteractive(true);
  setNote("Play the best move on the board.");
  revealed = false;
  els.solutionBtn.textContent = "Show solution";
  renderChrome();
});
els.solutionBtn.addEventListener("click", () => {
  if (revealed) {
    nextPuzzle();
    return;
  }
  showSolution();
});
els.exitBtn.addEventListener("click", () => window.close());
els.retryMissedBtn.addEventListener("click", retryMissed);
els.returnBtn.addEventListener("click", returnToGame);
els.errorClose.addEventListener("click", () => window.close());

boot();
